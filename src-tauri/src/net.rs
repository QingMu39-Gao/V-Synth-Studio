//! HTTP 工具，以及下载引擎的**适配层**。
//!
//! ⚠️ **下载的实现不在这里** —— 只有一份，在 `crate::download`，
//! 音轨分离那几个几 GB 的包也走它。这个文件留着的理由有两个：
//!
//!   * `download_to_file`：把引擎的原始字节数换算成界面要的 `speed` /
//!     `percent`（引擎不该知道界面要显示什么），并负责 `.part` → 成品的 rename；
//!   * 其余是 B 站那套 HTTP 杂项（统一请求头、MD5、URL 编码）。

use std::path::{Path, PathBuf};
use std::sync::OnceLock;
use std::time::Duration;

use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::Value;

/// 默认 UA。B 站对空 UA 会直接拒绝，只能用这个串。
pub const DEFAULT_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/// 任务被取消时统一用这个错误文本，调用方据此把任务标成「已取消」
pub const CANCELED: &str = "__canceled__";

/* ⚠️ 分块的阈值（2 MB）与「什么时候才算值得分块」的判据只在
`crate::download` 里声明一次 —— `net.rs` 不是下载的实现，只是它的一个
适配层（把引擎的原始字节数换算成界面要的 `speed` / `percent`）。 */

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

/// 全局 HTTP 客户端。
///
/// 挂的是 `read_timeout`（「**多久没收到新数据**才判死」，每读到一段就重新计时），
/// 不是 `timeout`（「整个响应总共允许多久」）：后者对下载是错的判据 —— 下载耗时
/// 取决于文件大小和网速，卡紧了会掐断、设太松形同虚设。60 秒这个值来自歌单流
/// （`lyrics`，320 kbps、9.8 MB，要 96 秒读完），而中途停顿远不到 60 秒。
/// ⚠️ **它只能设在 client 上**（reqwest 0.13 没有请求级的 `read_timeout`），
/// 所以这里是全局的；对 B 站轮询二维码、本地分离服务探活无害。
pub fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(DEFAULT_UA)
            .redirect(reqwest::redirect::Policy::limited(10))
            .read_timeout(Duration::from_secs(60))
            .build()
            .expect("HTTP 客户端创建失败")
    })
}

/// 把 `[("User-Agent", "x")]` 变成 HeaderMap。非法头名/值直接忽略，
/// 不该因为一个头把整条链路弄挂。
pub fn headers(pairs: &[(&str, &str)]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (k, v) in pairs {
        if let (Ok(name), Ok(val)) = (
            HeaderName::from_bytes(k.as_bytes()),
            HeaderValue::from_str(v),
        ) {
            map.insert(name, val);
        }
    }
    map
}

/// 请求失败：带上 HTTP 状态码，`fetch_json` 靠它决定要不要重试
struct FetchError {
    message: String,
    status: u16,
}

/// 给 URL 加一个「绕缓存」的时间戳参数（已有查询串时用 `&`）。
///
/// 服务端本来就发 `Cache-Control: no-store`，这一步是防中间层（CDN / 企业代理 /
/// 本机缓存）留一份陈旧副本 —— 版本号与公告只要旧一版，表现就是「明明发了新公告却看不到」。
pub fn cache_busted(url: &str, secs: u64) -> String {
    let sep = if url.contains('?') { '&' } else { '?' };
    format!("{url}{sep}t={secs}")
}

/// 现在这一刻的纪元秒（取不到回 0）。
pub fn now_epoch() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 取一份**公开的只读 JSON**（自建更新 / 公告接口用）：**只请求一次、不重试**。
///
/// 判据按顺序三条，缺一条都当失败：HTTP 2xx → `Content-Type` 含 `json` → 能解析出 JSON。
///
/// ⚠️ 中间那条不是形式主义：Cloudflare 的人机验证回的是 **200 + 一页 HTML**，只看状态码
/// 就会把 HTML 当 JSON 解析，于是「取到了公告」变成一条乱码公告。宁可当失败（调用方静默）。
///
/// ⚠️ 这两条自建接口的 UA 由调用方给死（`V-Synth-Studio/<版本>`）：留空或用一个库的默认
/// UA 容易被 WAF 拦。共享客户端的浏览器 UA 只给别的请求用。
pub async fn fetch_public_json(url: &str, ua: &str, timeout: Duration) -> Result<Value, String> {
    let target = cache_busted(url, now_epoch());
    let res = client()
        .get(&target)
        .header(reqwest::header::USER_AGENT, ua)
        .header(reqwest::header::ACCEPT, "application/json")
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                format!("超时（{} 秒）", timeout.as_secs())
            } else {
                let mut msg = e.to_string();
                let mut cur = std::error::Error::source(&e);
                while let Some(s) = cur {
                    msg.push_str(" ← ");
                    msg.push_str(&s.to_string());
                    cur = s.source();
                }
                msg
            }
        })?;

    let status = res.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("HTTP {status}"));
    }
    let ctype = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let text = res.text().await.unwrap_or_default();
    if !ctype.contains("json") {
        let head: String = text.chars().take(120).collect();
        return Err(format!("回的不是 JSON（Content-Type: {ctype}）：{head}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("解析失败：{e}"))
}

async fn try_fetch_json(
    url: &str,
    hdrs: HeaderMap,
    timeout_secs: u64,
) -> Result<Value, FetchError> {
    let res = client()
        .get(url)
        .headers(hdrs)
        .timeout(Duration::from_secs(timeout_secs))
        .send()
        .await
        .map_err(|e| FetchError {
            message: if e.is_timeout() {
                format!("请求超时（{}ms）：{}", timeout_secs * 1000, url)
            } else {
                format!("网络请求失败：{e}")
            },
            status: 0,
        })?;

    let status = res.status().as_u16();
    let text = res.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(FetchError {
            message: format!("HTTP {status}：{url}"),
            status,
        });
    }
    serde_json::from_str(&text).map_err(|_| FetchError {
        message: format!("返回内容不是合法 JSON：{url}"),
        status,
    })
}

/// 请求 JSON，失败重试：4xx 不重试，429 除外
pub async fn fetch_json(
    url: &str,
    hdrs: HeaderMap,
    timeout_secs: u64,
    retries: u32,
) -> Result<Value, String> {
    let mut last = String::new();
    for attempt in 0..=retries {
        match try_fetch_json(url, hdrs.clone(), timeout_secs).await {
            Ok(v) => return Ok(v),
            Err(e) => {
                let fatal = e.status >= 400 && e.status < 500 && e.status != 429;
                last = e.message;
                if fatal {
                    break;
                }
                if attempt < retries {
                    sleep_ms(400 * (attempt as u64 + 1)).await;
                }
            }
        }
    }
    Err(last)
}

/// 请求原始字节（弹幕接口用，它返回的是裸 deflate）
pub async fn fetch_bytes(url: &str, hdrs: HeaderMap, timeout_secs: u64) -> Result<Vec<u8>, String> {
    let res = client()
        .get(url)
        .headers(hdrs)
        .timeout(Duration::from_secs(timeout_secs))
        .send()
        .await
        .map_err(|e| format!("网络请求失败：{e}"))?;
    let status = res.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("HTTP {status}"));
    }
    Ok(res.bytes().await.map_err(|e| e.to_string())?.to_vec())
}

/// 跟随重定向，返回最终地址（b23.tv 短链展开）。
/// 失败时返回原地址 —— 短链展开失败不该让整条链路挂掉。
pub async fn resolve_redirect(url: &str, hdrs: HeaderMap, timeout_secs: u64) -> String {
    match client()
        .get(url)
        .headers(hdrs)
        .timeout(Duration::from_secs(timeout_secs))
        .send()
        .await
    {
        Ok(res) => res.url().to_string(),
        Err(_) => url.to_string(),
    }
}

pub async fn sleep_ms(ms: u64) {
    tokio::time::sleep(Duration::from_millis(ms)).await;
}

/* ══════════════════════════════════ 下载 ══════════════════════════════════ */

/// 进度：速度与百分数。
///
/// ⚠️ 这是**给界面看**的形状，由下面这层适配算出来 —— 引擎（`download`）只报
/// 原始字节数，因为它不该知道界面要显示什么。
pub struct Progress {
    pub speed: f64,
    pub percent: f64,
}

/// 取消检查。调用方从任务表里读状态，返回 true 就中断。
pub type Cancel = dyn Fn() -> bool + Send + Sync;

/// 进度回调。内部按 200ms 节流（几 MB 的包会有上千次回调，全报会淹掉界面）。
pub type OnProgress = dyn Fn(&Progress) + Send + Sync;

/// 下载到文件，返回写出的字节数。
///
/// `threads > 1` 且服务端支持 Range 时按分块并发下；分块失败自动退回单流。
///
/// ⚠️ 真正的实现只有一份 —— `crate::download`（`svsep` 那几个几 GB 的包也走它）。
/// 这里保留这个签名只是为了不动 bili 那边 6 个调用点，顺带把引擎的原始字节数
/// 换算成界面要的 `speed` / `percent`。
pub async fn download_to_file(
    url: &str,
    dest: &Path,
    hdrs: &[(&str, &str)],
    threads: usize,
    cancel: &Cancel,
    on_progress: &OnProgress,
) -> Result<u64, String> {
    /* 节流 + 换算都在这层做（引擎每收到一块就调我们一次，几 MB 的包会有上千次）。
    200ms 一次。 */
    let started = std::time::Instant::now();
    let last_emit = std::sync::Mutex::new(started);
    let emit = |got: u64, total: Option<u64>| {
        let now = std::time::Instant::now();
        let Ok(mut last) = last_emit.lock() else {
            return;
        };
        if now.duration_since(*last) < Duration::from_millis(200) {
            return;
        }
        *last = now;
        let elapsed = started.elapsed().as_secs_f64().max(0.001);
        let percent = match total {
            Some(t) if t > 0 => (got as f64 / t as f64 * 100.0).min(100.0),
            _ => 0.0,
        };
        on_progress(&Progress {
            speed: got as f64 / elapsed,
            percent,
        });
    };

    let part = PathBuf::from(format!("{}.part", dest.to_string_lossy()));
    let ctl = crate::download::Control::cancel_only(cancel);
    let req = crate::download::Request {
        url,
        label: "", // bili 的媒体下载在界面上有别的说法，错误照旧不点名
        part: &part,
        headers: hdrs,
        // 线程数由用户在配置里给（1..=16）；`Shape` 自己推出「要 probe」这件事
        shape: crate::download::Shape::Parallel { threads },
        client: crate::download::default_client(),
        retry: crate::download::Retry::BILI,
        expect: None,
    };
    let note = |got: u64, total: Option<u64>, _stage: crate::download::Stage| emit(got, total);

    match crate::download::download(&req, &ctl, &note).await {
        Ok(crate::download::Outcome::Done { bytes }) => {
            tokio::fs::rename(&part, dest)
                .await
                .map_err(|e| e.to_string())?;
            // 收尾必须报一次 100%（节流可能把最后一次吞掉）
            let elapsed = started.elapsed().as_secs_f64().max(0.001);
            on_progress(&Progress {
                speed: bytes as f64 / elapsed,
                percent: 100.0,
            });
            Ok(bytes)
        }
        /* ⚠️ 取消要顺手把 `.part` 删掉：引擎只在「允许续传」时清理，而 bili 这条
        路是 `Parallel`（每次开头反会先删旧 part），留下的 `.part` 永远不会被
        续传消费，纯粹是留在用户下载目录里的几个 GB 垃圾。 */
        Ok(crate::download::Outcome::Cancelled) => {
            let _ = tokio::fs::remove_file(&part).await;
            Err(CANCELED.to_string())
        }
        // bili 没有「暂停」这个概念（`cancel_only` 让引擎永远不返回它），
        // 真收到了也按取消处理，免得留下一个没人认领的 `.part`
        Ok(crate::download::Outcome::Paused { .. }) => {
            let _ = tokio::fs::remove_file(&part).await;
            Err(CANCELED.to_string())
        }
        Err(e) => Err(e),
    }
}

/* ══════════════════════════ MD5（B 站 WBI 签名用） ══════════════════════════ */

pub fn md5_hex(data: &[u8]) -> String {
    const S: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5,
        9, 14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10,
        15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
    ];
    const K: [u32; 64] = [
        0xd76aa478, 0xe8c7b756, 0x242070db, 0xc1bdceee, 0xf57c0faf, 0x4787c62a, 0xa8304613,
        0xfd469501, 0x698098d8, 0x8b44f7af, 0xffff5bb1, 0x895cd7be, 0x6b901122, 0xfd987193,
        0xa679438e, 0x49b40821, 0xf61e2562, 0xc040b340, 0x265e5a51, 0xe9b6c7aa, 0xd62f105d,
        0x02441453, 0xd8a1e681, 0xe7d3fbc8, 0x21e1cde6, 0xc33707d6, 0xf4d50d87, 0x455a14ed,
        0xa9e3e905, 0xfcefa3f8, 0x676f02d9, 0x8d2a4c8a, 0xfffa3942, 0x8771f681, 0x6d9d6122,
        0xfde5380c, 0xa4beea44, 0x4bdecfa9, 0xf6bb4b60, 0xbebfbc70, 0x289b7ec6, 0xeaa127fa,
        0xd4ef3085, 0x04881d05, 0xd9d4d039, 0xe6db99e5, 0x1fa27cf8, 0xc4ac5665, 0xf4292244,
        0x432aff97, 0xab9423a7, 0xfc93a039, 0x655b59c3, 0x8f0ccc92, 0xffeff47d, 0x85845dd1,
        0x6fa87e4f, 0xfe2ce6e0, 0xa3014314, 0x4e0811a1, 0xf7537e82, 0xbd3af235, 0x2ad7d2bb,
        0xeb86d391,
    ];

    let mut msg = data.to_vec();
    let bit_len = (msg.len() as u64).wrapping_mul(8);
    msg.push(0x80);
    while msg.len() % 64 != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_le_bytes());

    let (mut a0, mut b0, mut c0, mut d0) =
        (0x67452301u32, 0xefcdab89u32, 0x98badcfeu32, 0x10325476u32);

    for chunk in msg.chunks(64) {
        let mut m = [0u32; 16];
        for (i, w) in m.iter_mut().enumerate() {
            *w = u32::from_le_bytes([
                chunk[i * 4],
                chunk[i * 4 + 1],
                chunk[i * 4 + 2],
                chunk[i * 4 + 3],
            ]);
        }
        let (mut a, mut b, mut c, mut d) = (a0, b0, c0, d0);
        for i in 0..64 {
            let (f, g) = match i / 16 {
                0 => ((b & c) | (!b & d), i),
                1 => ((d & b) | (!d & c), (5 * i + 1) % 16),
                2 => (b ^ c ^ d, (3 * i + 5) % 16),
                _ => (c ^ (b | !d), (7 * i) % 16),
            };
            let tmp = d;
            d = c;
            c = b;
            let x = a.wrapping_add(f).wrapping_add(K[i]).wrapping_add(m[g]);
            b = b.wrapping_add(x.rotate_left(S[i]));
            a = tmp;
        }
        a0 = a0.wrapping_add(a);
        b0 = b0.wrapping_add(b);
        c0 = c0.wrapping_add(c);
        d0 = d0.wrapping_add(d);
    }

    let mut out = String::with_capacity(32);
    for v in [a0, b0, c0, d0] {
        for byte in v.to_le_bytes() {
            out.push_str(&format!("{byte:02x}"));
        }
    }
    out
}

/// `encodeURIComponent` 的等价物 —— 未转义字符集必须一模一样，
/// 否则 WBI 签名里的 query 和 B 站算出来的对不上。
pub fn encode_component(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z'
            | b'a'..=b'z'
            | b'0'..=b'9'
            | b'-'
            | b'_'
            | b'.'
            | b'!'
            | b'~'
            | b'*'
            | b'\''
            | b'('
            | b')' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

    #[test]
    fn md5_matches_reference_vectors() {
        assert_eq!(md5_hex(b""), "d41d8cd98f00b204e9800998ecf8427e");
        assert_eq!(md5_hex(b"abc"), "900150983cd24fb0d6963f7d28e17f72");
        assert_eq!(
            md5_hex(b"The quick brown fox jumps over the lazy dog"),
            "9e107d9d372bb6826bd81d3542a419d6"
        );
        // 55 字节是补齐逻辑的边界（55 刚好塞得下长度字段）
        assert_eq!(
            md5_hex(b"1234567890123456789012345678901234567890123456789012345"),
            "c9ccf168914a1bcfc3229f1948e67da0"
        );
    }

    #[test]
    fn encode_component_matches_encodeuricomponent() {
        assert_eq!(encode_component("BV1GJ411x7h7"), "BV1GJ411x7h7");
        assert_eq!(encode_component("a b&c=d"), "a%20b%26c%3Dd");
        assert_eq!(encode_component("-_.!~*'()"), "-_.!~*'()");
        assert_eq!(encode_component("中"), "%E4%B8%AD");
    }

    /* ══════════════════════ 分块下载引擎的回归网 ══════════════════════

    `download_to_file` 是 bili 视频 / 音频下载唯一走的那条路，动它是动「几十 MB
    视频下载」。下面这个夹具是个只会说 HTTP/1.1 的最小服务器，认 `Range` 回 206 ——
    分块引擎的**全部前提**就是这个（`probe` 探到 `accept-ranges` 才分块）。 */

    /// 认 `Range` 的最小服务器。返回 `(url, 收到的请求头)`。
    ///
    /// 每条响应 `Connection: close`（免得复用连接干扰计数），并按请求里的
    /// `Range` 切出对应的片段回 206。不带 `Range` 就回 200 + 整份。
    fn range_server(payload: Vec<u8>) -> (String, std::sync::Arc<Mutex<Vec<String>>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let log = std::sync::Arc::new(Mutex::new(Vec::new()));
        let log2 = log.clone();
        std::thread::spawn(move || {
            let total = payload.len();
            for conn in listener.incoming() {
                let Ok(mut s) = conn else { continue };
                let mut buf = [0u8; 4096];
                let read = s.read(&mut buf).unwrap_or(0);
                if read == 0 {
                    continue;
                }
                let head = String::from_utf8_lossy(&buf[..read]).to_string();
                log2.lock().unwrap().push(head.clone());
                let (code, from, to) = match parse_range(&head) {
                    Some((a, b)) => ("206 Partial Content", a.min(total), b.min(total - 1)),
                    None => ("200 OK", 0, total.saturating_sub(1)),
                };
                let body = if total == 0 {
                    &[][..]
                } else {
                    &payload[from..=to]
                };
                let mut resp = format!(
                    "HTTP/1.1 {code}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\n\
                     Connection: close\r\n",
                    body.len()
                );
                if code.starts_with("206") {
                    resp.push_str(&format!("Content-Range: bytes {from}-{to}/{total}\r\n"));
                }
                resp.push_str("\r\n");
                let _ = s.write_all(resp.as_bytes());
                let _ = s.write_all(body);
                let _ = s.flush();
            }
        });
        (format!("http://127.0.0.1:{port}/f.bin"), log)
    }

    /// 从请求头里抠出 `Range: bytes=a-b`（`b` 可省，表示到结尾）。
    fn parse_range(head: &str) -> Option<(usize, usize)> {
        for line in head.lines() {
            let low = line.to_ascii_lowercase();
            if let Some(rest) = low.strip_prefix("range:") {
                let v = rest.trim().strip_prefix("bytes=")?;
                let (a, b) = v.split_once('-')?;
                let a: usize = a.trim().parse().ok()?;
                let b: usize = if b.trim().is_empty() {
                    usize::MAX
                } else {
                    b.trim().parse().ok()?
                };
                return Some((a, b));
            }
        }
        None
    }

    /// 造一段可校验的字节（每个位置一个值，接错位置立刻能看出来）。
    fn patterned(n: usize) -> Vec<u8> {
        (0..n).map(|i| (i % 251) as u8).collect()
    }

    /// 分块下载：完整拿回每一块，且**落在正确偏移上**。
    #[tokio::test]
    async fn chunked_download_writes_every_chunk_at_its_own_offset() {
        // 要真分块得超过 CHUNK_MIN_SIZE（2 MB）；5 MB / 4 线程 = 4 块
        let payload = patterned(5 * 1024 * 1024 + 12345);
        let (url, log) = range_server(payload.clone());
        let dir = std::env::temp_dir().join(format!("vss-net-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("chunked.bin");

        let never = || false;
        let cancel: &(dyn Fn() -> bool + Send + Sync) = &never;
        let got = download_to_file(&url, &dest, &[], 4, cancel, &|_| {})
            .await
            .expect("分块下载应该成功");

        assert_eq!(got, payload.len() as u64, "返回的字节数不对");
        let on_disk = std::fs::read(&dest).unwrap();
        assert_eq!(on_disk.len(), payload.len(), "落盘长度不对");
        assert_eq!(on_disk, payload, "内容不对 —— 说明某块写错了偏移");
        assert!(
            !PathBuf::from(format!("{}.part", dest.to_string_lossy())).exists(),
            "成功后 .part 应该被 rename 掉"
        );

        /* 证明确实分块了 —— 而且要**恰好 5 次**。

        ⚠️ 只断言 `ranges > 1` 是不够的：`download_range_once` 若用只读的
        `File::open` 打开 `.part` 再 `write_at`，每一块都会 EBADF、重试 5 次，
        最后被「分块失败退回单流」接住 —— 那种情况下 Range 请求数 = 1 probe +
        4 块 × 5 次重试 = 21，比正常的 5 还多，`> 1` 照样通过。

        数对了才有意义：4 块（5 MB / 4 线程）+ 1 次 `probe` 的 `bytes=0-0`。
        ⛔ 别把它放宽回 `> 1`。 */
        let ranges = log
            .lock()
            .unwrap()
            .iter()
            .filter(|h| parse_range(h).is_some())
            .count();
        assert_eq!(
            ranges, 5,
            "分块正常时应为 4 块 + 1 次 probe = 5，实际 {ranges} 次；\
             明显偏大说明有块在重试（多半是写盘被拒了）"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 单流：`threads=1` 时不该分块，但仍要完整。
    #[tokio::test]
    async fn single_thread_download_does_not_chunk_but_still_lands_whole() {
        let payload = patterned(3 * 1024 * 1024);
        let (url, log) = range_server(payload.clone());
        let dir = std::env::temp_dir().join(format!("vss-net-test1-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("single.bin");

        let never = || false;
        let cancel: &(dyn Fn() -> bool + Send + Sync) = &never;
        let got = download_to_file(&url, &dest, &[], 1, cancel, &|_| {})
            .await
            .unwrap();

        assert_eq!(got, payload.len() as u64);
        assert_eq!(std::fs::read(&dest).unwrap(), payload);
        // probe 先发一个 `bytes=0-0`；单流本身不带 Range
        let ranges = log
            .lock()
            .unwrap()
            .iter()
            .filter(|h| parse_range(h).is_some())
            .count();
        assert_eq!(
            ranges, 1,
            "只该有 probe 那一个 Range 请求，实际 {ranges} 个"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 服务端不支持 Range（回 200 且没有 Accept-Ranges）时必须退回单流，
    /// 而不是把分块的定位写当成能用的。
    #[tokio::test]
    async fn a_server_without_range_falls_back_to_a_single_stream() {
        use std::io::{Read, Write};
        let payload = patterned(4 * 1024 * 1024);
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let body = payload.clone();
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(mut s) = conn else { continue };
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf);
                // ⚠️ 故意**不**声明 Accept-Ranges，而且任何 Range 都回 200 + 整份
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                    body.len()
                );
                let _ = s.write_all(resp.as_bytes());
                let _ = s.write_all(&body);
                let _ = s.flush();
            }
        });
        let url = format!("http://127.0.0.1:{port}/f.bin");
        let dir = std::env::temp_dir().join(format!("vss-net-norange-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("norange.bin");

        let never = || false;
        let cancel: &(dyn Fn() -> bool + Send + Sync) = &never;
        let got = download_to_file(&url, &dest, &[], 4, cancel, &|_| {})
            .await
            .expect("不支持 Range 时该退回单流并成功");
        assert_eq!(got, payload.len() as u64);
        assert_eq!(std::fs::read(&dest).unwrap(), payload);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 取消：中途按下停止要真的停，且不留下一个被 rename 的「成品」。
    #[tokio::test]
    async fn cancel_stops_the_download_and_leaves_no_finished_file() {
        // ⚠️ `download_to_file` 的 `cancel` / `on_progress` 签名是 `&Cancel` /
        // `&OnProgress`，而 trait object 默认带 `'static` 界 —— 闭包必须活到
        // 程序结束。所以这里用 `static` 原子量，不能用局部变量（svsep 那几条
        // 下载测试也是同一个原因才用 `&'static AtomicBool`）。
        static FLAG: AtomicBool = AtomicBool::new(true); // 立刻就算「已取消」
        let payload = patterned(8 * 1024 * 1024);
        let (url, _log) = range_server(payload);
        let dir = std::env::temp_dir().join(format!("vss-net-cancel-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("cancel.bin");

        let is_cancelled = || FLAG.load(Ordering::Relaxed);
        let cancel: &(dyn Fn() -> bool + Send + Sync) = &is_cancelled;
        let res = download_to_file(&url, &dest, &[], 4, cancel, &|_| {}).await;
        assert!(res.is_err(), "取消后不该报成功");
        assert!(!dest.exists(), "取消后不该留下成品文件名");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 进度回调：`percent` 到 100、`speed` 为正。
    #[tokio::test]
    async fn progress_reaches_one_hundred_percent() {
        /// 最后一次报的百分数（放大 1000 倍 —— 原子类型没有 f64）
        static LAST: AtomicU64 = AtomicU64::new(0);
        /// 见过正的速度没有
        static SAW_SPEED: AtomicU64 = AtomicU64::new(0);
        let payload = patterned(3 * 1024 * 1024);
        let (url, _log) = range_server(payload.clone());
        let dir = std::env::temp_dir().join(format!("vss-net-prog-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("prog.bin");
        LAST.store(0, Ordering::Relaxed);
        SAW_SPEED.store(0, Ordering::Relaxed);

        let sink = |p: &Progress| {
            LAST.store((p.percent * 1000.0) as u64, Ordering::Relaxed);
            if p.speed > 0.0 {
                SAW_SPEED.store(1, Ordering::Relaxed);
            }
        };
        let never = || false;
        let cancel: &(dyn Fn() -> bool + Send + Sync) = &never;
        download_to_file(&url, &dest, &[], 4, cancel, &sink)
            .await
            .unwrap();

        assert_eq!(std::fs::read(&dest).unwrap(), payload);
        assert_eq!(
            LAST.load(Ordering::Relaxed),
            100_000,
            "结束时 percent 应该是 100"
        );
        assert_eq!(SAW_SPEED.load(Ordering::Relaxed), 1, "speed 应该报过正数");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
