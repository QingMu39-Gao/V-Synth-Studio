//! HTTP 工具与下载器
//!
//! 对应 Node 的 `net/http.mjs`（超时、重试、统一请求头）与 `net/download.mjs`
//! （多线程分块下载 + 进度回调）。
//!
//! 这里还放了 B 站 WBI 签名要用的 MD5 —— 标准库没有，而为一个哈希函数引一个 crate
//! 不划算（校验向量见文件末尾的测试）。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};
use serde_json::Value;

/// 默认 UA。B 站对空 UA 会直接拒绝，Node 版用的就是这个串。
pub const DEFAULT_UA: &str =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

/// 任务被取消时统一用这个错误文本，调用方据此把任务标成「已取消」
pub const CANCELED: &str = "__canceled__";

/// 小于 2MB 不值得分块（和 Node 版一致）
const CHUNK_MIN_SIZE: u64 = 2 * 1024 * 1024;

static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();

pub fn client() -> &'static reqwest::Client {
    CLIENT.get_or_init(|| {
        reqwest::Client::builder()
            .user_agent(DEFAULT_UA)
            .redirect(reqwest::redirect::Policy::limited(10))
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

async fn try_fetch_json(url: &str, hdrs: HeaderMap, timeout_secs: u64) -> Result<Value, FetchError> {
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

/// 请求 JSON，失败按 Node 版同样的策略重试（4xx 不重试，429 除外）
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
/// 失败时返回原地址 —— 和 Node 版一样，短链展开失败不该让整条链路挂掉。
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

pub struct Progress {
    pub speed: f64,
    pub percent: f64,
}

/// 取消检查。调用方从任务表里读状态，返回 true 就中断。
pub type Cancel = dyn Fn() -> bool + Send + Sync;

/// 进度回调。内部按 200ms 节流，和 Node 版一致。
pub type OnProgress = dyn Fn(&Progress) + Send + Sync;

struct Tracker<'a> {
    received: AtomicU64,
    total: u64,
    started: Instant,
    last_emit: Mutex<Instant>,
    on_progress: &'a OnProgress,
}

impl Tracker<'_> {
    fn add(&self, n: u64) {
        let received = self.received.fetch_add(n, Ordering::Relaxed) + n;
        let now = Instant::now();
        let Ok(mut last) = self.last_emit.lock() else {
            return;
        };
        if now.duration_since(*last) < Duration::from_millis(200) {
            return;
        }
        *last = now;
        self.emit(received, false);
    }

    fn emit(&self, received: u64, done: bool) {
        let elapsed = self.started.elapsed().as_secs_f64().max(0.001);
        let speed = received as f64 / elapsed;
        let percent = if self.total > 0 {
            (received as f64 / self.total as f64 * 100.0).min(100.0)
        } else if done {
            100.0
        } else {
            0.0
        };
        (self.on_progress)(&Progress {
            speed,
            percent: if done { 100.0 } else { percent },
        });
    }

    fn reset(&self) {
        self.received.store(0, Ordering::Relaxed);
    }
}

/// 探测远端文件大小与是否支持分段
async fn probe(url: &str, hdrs: &HeaderMap) -> Result<(u64, bool), String> {
    let mut h = hdrs.clone();
    h.insert(reqwest::header::RANGE, HeaderValue::from_static("bytes=0-0"));
    let res = client()
        .get(url)
        .headers(h)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                format!("请求超时（15000ms）：{url}")
            } else {
                format!("网络请求失败：{e}")
            }
        })?;

    let status = res.status().as_u16();
    let range = res
        .headers()
        .get("content-range")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let len = res
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let accept = res
        .headers()
        .get("accept-ranges")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .contains("bytes");
    // 读完并丢弃，避免连接悬挂
    let _ = res.bytes().await;

    let size = match range.split_once('/') {
        Some((_, t)) => t.parse::<u64>().unwrap_or(0),
        None => len,
    };
    Ok((size, status == 206 || accept))
}

/// 定位写入。每个分块任务各持一个文件句柄，所以不能用共享的 seek 位置。
#[cfg(windows)]
fn write_at(f: &std::fs::File, buf: &[u8], offset: u64) -> std::io::Result<()> {
    use std::os::windows::fs::FileExt;
    f.seek_write(buf, offset).map(|_| ())
}

#[cfg(unix)]
fn write_at(f: &std::fs::File, buf: &[u8], offset: u64) -> std::io::Result<()> {
    use std::os::unix::fs::FileExt;
    f.write_at(buf, offset).map(|_| ())
}

/// 下载到文件，返回写出的字节数。
///
/// `threads > 1` 且服务端支持 Range 时按分块并发下；分块失败自动退回单流。
pub async fn download_to_file(
    url: &str,
    dest: &Path,
    hdrs: &[(&str, &str)],
    threads: usize,
    cancel: &Cancel,
    on_progress: &OnProgress,
) -> Result<u64, String> {
    if let Some(dir) = dest.parent() {
        tokio::fs::create_dir_all(dir)
            .await
            .map_err(|e| e.to_string())?;
    }
    let header_map = headers(hdrs);
    let (total, accept_ranges) = probe(url, &header_map).await?;
    let part = PathBuf::from(format!("{}.part", dest.to_string_lossy()));

    let tracker = Tracker {
        received: AtomicU64::new(0),
        total,
        started: Instant::now(),
        last_emit: Mutex::new(Instant::now()),
        on_progress,
    };

    if accept_ranges && total > CHUNK_MIN_SIZE && threads > 1 {
        match download_chunked(url, &part, total, &header_map, threads, cancel, &tracker).await {
            Ok(()) => {}
            Err(e) if e == CANCELED => return Err(e),
            Err(_) => {
                // 分块失败退回单流（和 Node 版一样，从头开始）
                tracker.reset();
                download_stream(url, &part, &header_map, 0, cancel, &tracker).await?;
            }
        }
    } else {
        download_stream(url, &part, &header_map, 0, cancel, &tracker).await?;
    }

    tokio::fs::rename(&part, dest)
        .await
        .map_err(|e| e.to_string())?;
    let received = tracker.received.load(Ordering::Relaxed);
    tracker.emit(received, true);
    Ok(received)
}

async fn download_chunked(
    url: &str,
    part: &Path,
    total: u64,
    hdrs: &HeaderMap,
    threads: usize,
    cancel: &Cancel,
    tracker: &Tracker<'_>,
) -> Result<(), String> {
    let chunk_size = total.div_ceil(threads as u64).max(1);

    // 先把文件撑到最终大小，各分块写各自的偏移
    {
        let f = std::fs::File::create(part).map_err(|e| e.to_string())?;
        f.set_len(total).map_err(|e| e.to_string())?;
    }

    let ranges: Vec<(u64, u64)> = (0..total)
        .step_by(chunk_size as usize)
        .map(|start| (start, (start + chunk_size - 1).min(total - 1)))
        .collect();

    // join_all 而不是 spawn：这些 future 互不依赖，并发跑在同一条任务上就够了，
    // 也就不需要把回调塞进 'static。
    let futs = ranges
        .into_iter()
        .map(|(start, end)| download_range(url, part, start, end, hdrs, cancel, tracker));
    for r in futures_util::future::join_all(futs).await {
        r?;
    }
    Ok(())
}

async fn download_range(
    url: &str,
    part: &Path,
    start: u64,
    end: u64,
    hdrs: &HeaderMap,
    cancel: &Cancel,
    tracker: &Tracker<'_>,
) -> Result<(), String> {
    let mut last = String::new();
    for attempt in 0..=4u32 {
        if cancel() {
            return Err(CANCELED.to_string());
        }
        match download_range_once(url, part, start, end, hdrs, cancel, tracker).await {
            Ok(()) => return Ok(()),
            Err(e) if e == CANCELED => return Err(e),
            Err(e) => {
                last = e;
                if attempt < 4 {
                    sleep_ms(500 * (attempt as u64 + 1)).await;
                }
            }
        }
    }
    Err(last)
}

async fn download_range_once(
    url: &str,
    part: &Path,
    start: u64,
    end: u64,
    hdrs: &HeaderMap,
    cancel: &Cancel,
    tracker: &Tracker<'_>,
) -> Result<(), String> {
    let mut h = hdrs.clone();
    h.insert(
        reqwest::header::RANGE,
        HeaderValue::from_str(&format!("bytes={start}-{end}")).map_err(|e| e.to_string())?,
    );
    let res = client()
        .get(url)
        .headers(h)
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("分块下载失败 HTTP {status}"));
    }

    // 本地磁盘写入很短，直接同步写；为它套 spawn_blocking 不值得
    let file = std::fs::File::open(part).map_err(|e| e.to_string())?;
    let mut pos = start;
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if cancel() {
            return Err(CANCELED.to_string());
        }
        let chunk = chunk.map_err(|e| e.to_string())?;
        write_at(&file, &chunk, pos).map_err(|e| e.to_string())?;
        pos += chunk.len() as u64;
        tracker.add(chunk.len() as u64);
    }
    Ok(())
}

async fn download_stream(
    url: &str,
    part: &Path,
    hdrs: &HeaderMap,
    start_offset: u64,
    cancel: &Cancel,
    tracker: &Tracker<'_>,
) -> Result<(), String> {
    let mut last = String::new();
    for attempt in 0..=3u32 {
        if cancel() {
            return Err(CANCELED.to_string());
        }
        match download_stream_once(url, part, hdrs, start_offset, cancel, tracker).await {
            Ok(()) => return Ok(()),
            Err(e) if e == CANCELED => return Err(e),
            Err(e) => {
                last = e;
                if attempt < 3 {
                    sleep_ms(800 * (attempt as u64 + 1)).await;
                }
            }
        }
    }
    Err(last)
}

async fn download_stream_once(
    url: &str,
    part: &Path,
    hdrs: &HeaderMap,
    start_offset: u64,
    cancel: &Cancel,
    tracker: &Tracker<'_>,
) -> Result<(), String> {
    let mut h = hdrs.clone();
    if start_offset > 0 {
        h.insert(
            reqwest::header::RANGE,
            HeaderValue::from_str(&format!("bytes={start_offset}-")).map_err(|e| e.to_string())?,
        );
    }
    let res = client()
        .get(url)
        .headers(h)
        .timeout(Duration::from_secs(60))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = res.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("下载失败 HTTP {status}"));
    }

    use std::io::{Seek, SeekFrom, Write};
    let mut file = if start_offset > 0 {
        std::fs::OpenOptions::new()
            .write(true)
            .open(part)
            .map_err(|e| e.to_string())?
    } else {
        std::fs::File::create(part).map_err(|e| e.to_string())?
    };
    if start_offset > 0 {
        file.seek(SeekFrom::Start(start_offset))
            .map_err(|e| e.to_string())?;
    }

    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        if cancel() {
            return Err(CANCELED.to_string());
        }
        let chunk = chunk.map_err(|e| e.to_string())?;
        file.write_all(&chunk).map_err(|e| e.to_string())?;
        tracker.add(chunk.len() as u64);
    }
    Ok(())
}

/* ══════════════════════════ MD5（B 站 WBI 签名用） ══════════════════════════ */

pub fn md5_hex(data: &[u8]) -> String {
    const S: [u32; 64] = [
        7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9,
        14, 20, 5, 9, 14, 20, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 6, 10, 15,
        21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
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
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*'
            | b'\'' | b'(' | b')' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
