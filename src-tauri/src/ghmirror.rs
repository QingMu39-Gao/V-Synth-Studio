//! GitHub 下载加速 —— 开工前挑一面**这台机器上最快**的镜像。
//!
//! 为什么需要：release 资产会 302 到 `objects.githubusercontent.com`，那条线路在
//! 境内经常连不上（TLS 握手失败 / 443 超时），而扩展包合计 5.7 GB。
//!
//! # 候选名单是活的
//!
//! 名单取自 <https://git.hiwiki.org/data/mirror-speeds.json>（即
//! <https://git.hiwiki.org/zh-CN/mirrors> 那一页的数据源，站长每 12 小时测一次速）。
//! ⚠️ 它测的是**它的机器**到各镜像的延迟与速度，不是用户这台机器的 —— 所以这里
//! 只拿它当候选名单，真正的排名由开工前那次实测（[`probe_one`]）决定。
//!
//! 取不到那份 JSON（断网、被拦、格式变了）就用 [`FALLBACK`] 里那几面。
//!
//! # 链接形状
//!
//! 每面镜像给的是 `base` 与 `pathPrefix`，拼法是
//! `base + pathPrefix + "/" + <github.com 后面那一段>`（见 [`proxy_url`]）。
//! ⚠️ `pathPrefix` **不是常量**：有的镜像写 `github.com`（不带协议）、有的留空，
//! 把它们都当成 `https://github.com` 会拼出打不开的地址。
//!
//! # 与续传的关系
//!
//! [`pick`] 只决定「这一轮从哪儿取字节」，调用方的 `url` 始终是 github.com 上的
//! **规范链接**，`.part.url` 记号记的也是它 —— 所以换镜像不会让几个 GB 的续传点
//! 作废（`crate::download` 的调用点就是这么用的）。
//!
//! # 信任边界
//!
//! 走镜像等于把这些字节托给第三方。所以：实测阶段就要 `206`（认 Range 的面才
//! 要，续传全靠它）、下载完由调用方核对大小、解压时逐条 CRC。镜像给错文件会在
//! 那几道里露出来，而不是静悄悄装进去。
//!
//! # 关掉它
//!
//! 设 `VSS_GH_MIRROR=off`（`0` / `false` / `no` / `none` 同义）：所有链接原样走
//! github.com。排查「是不是镜像把文件换掉了」时用得上。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use reqwest::header::{HeaderValue, RANGE};
use serde_json::Value;

/// 候选名单的数据源（hiwiki 那页测速表）。
const SPEEDS_URL: &str = "https://git.hiwiki.org/data/mirror-speeds.json";
/// 名单缓存多久 —— 镜像上线下线是慢变量，没必要每次下载都去要一遍。
const LIST_TTL: Duration = Duration::from_secs(6 * 3600);
/// 实测结果的缓存。一次下载会连着取好几个文件（分卷 6 卷），只该测一次。
const PICK_TTL: Duration = Duration::from_secs(600);
/// 实测的**时间窗口**：这面镜像在这段时间里送到了多少字节，就是它的名次依据。
///
/// ⚠️ 为什么是「固定窗口内收到多少」而不是「收满 N 字节花了多久」：后者会把**慢**判成
/// **不通**。实测（2026-10，那条 ~0.2 MB/s 的线路上）1 MiB 在慢面上要 5 秒，一超时就
/// 整面作废 —— 八面全被判死后挑出来的会是**连不上的** github.com 直连，于是「手里有
/// 一堆可用镜像却一个都没用上」。按窗口收字节，慢面照样有名次（收到多少算多少）。
/// ⚠️ 它同时解决「按延迟挑」的老问题：原来的 128 KiB 取样主要量的是 RTT，而同一时刻
/// 各面的实测速率能差 30 倍（0.03–0.95 MB/s）。
const PROBE_WINDOW: Duration = Duration::from_secs(5);
/// 窗口内最多收这么多：够看清速率，又不至于为了挑镜子先下十几 MB。
/// 8 面各收满也只有 8 MB —— 对 364 MB 的包是 2%、对 4.9 GB 的分卷包是零头。
const PROBE_MAX_BYTES: u64 = 1024 * 1024;
/// 最多实测几面。名单里常年有几十面，全测既慢又费流量。
const PROBE_MAX: usize = 8;
/// 取名单那一次请求的超时。
const LIST_TIMEOUT: Duration = Duration::from_secs(8);

/// 一面镜像。
#[derive(Clone, Debug, PartialEq, Eq)]
struct Mirror {
    /// 形如 `https://gh-proxy.com/`（带尾斜杠）
    base: String,
    /// 形如 `https://github.com` / `github.com` / `""`
    path_prefix: String,
}

/// `mirror-speeds.json` 取不到时用这几面。
///
/// ⚠️ 抄自那份数据里长期 `status=ok` 且排在前面、形状又规范的几面。名单会烂，
/// 所以它只是**退路**：主路是开工时现取那份 JSON。
const FALLBACK: &[(&str, &str)] = &[
    ("https://gh-proxy.com/", "https://github.com"),
    ("https://ghproxy.imciel.com/", "https://github.com"),
    ("https://gh.monlor.com/", "https://github.com"),
    ("https://fastgit.cc/", "https://github.com"),
    ("https://cdn.gh-proxy.com/", "https://github.com"),
    ("https://ghfast.top/", "github.com"),
];

/* ── 候选名单（进程内缓存） ─────────────────────────────────────────── */

/// 缓存的实测结果：什么时候测的、测出来哪几面能用。
type MirrorCache = Option<(Instant, Vec<Mirror>)>;

static LIST: OnceLock<Mutex<MirrorCache>> = OnceLock::new();

/// 这次能试哪几面（按 hiwiki 测出来的速度从快到慢，只是**候选顺序**）。
async fn mirror_list() -> Vec<Mirror> {
    let slot = LIST.get_or_init(|| Mutex::new(None));
    if let Ok(g) = slot.lock()
        && let Some((at, list)) = g.as_ref()
        && at.elapsed() < LIST_TTL
    {
        return list.clone();
    }
    let fetched = fetch_list().await.unwrap_or_default();
    if fetched.is_empty() {
        return fallback();
    }
    if let Ok(mut g) = slot.lock() {
        *g = Some((Instant::now(), fetched.clone()));
    }
    fetched
}

fn fallback() -> Vec<Mirror> {
    FALLBACK
        .iter()
        .map(|(base, prefix)| Mirror {
            base: (*base).to_string(),
            path_prefix: (*prefix).to_string(),
        })
        .collect()
}

/// 去 hiwiki 要那份测速表。**任何一步不对都回 `None`**（调用方退回 [`FALLBACK`]）：
/// 这是一条加速用的旁路，不该因为它出错就让下载失败。
async fn fetch_list() -> Option<Vec<Mirror>> {
    let res = crate::net::client()
        .get(SPEEDS_URL)
        .timeout(LIST_TIMEOUT)
        .send()
        .await
        .ok()?;
    if !res.status().is_success() {
        return None;
    }
    let v: Value = res.json().await.ok()?;
    let rows = v.get("mirrors")?.as_array()?;

    let mut ranked: Vec<(f64, Mirror)> = Vec::new();
    for m in rows {
        // `404` / `error` 那几面是站长实测已经不通的，别拿去试
        if m.get("status").and_then(Value::as_str) != Some("ok") {
            continue;
        }
        let base = m.get("base").and_then(Value::as_str).unwrap_or("").trim();
        /* 只认 https 的绝对地址：名单是外部数据，拼进 URL 之前先卡一道，
        免得 `file://` 之类的形状被原样拿去取字节。 */
        if !base.starts_with("https://") {
            continue;
        }
        let path_prefix = m
            .get("pathPrefix")
            .and_then(Value::as_str)
            .unwrap_or("https://github.com");
        ranked.push((
            m.get("speed").and_then(Value::as_f64).unwrap_or(0.0),
            Mirror {
                base: base.to_string(),
                path_prefix: path_prefix.to_string(),
            },
        ));
    }
    ranked.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    Some(ranked.into_iter().map(|(_, m)| m).collect())
}

/* ── 实测与选择 ─────────────────────────────────────────────────────── */

/// 一条规范链接的可用地址，快的在前；最后一项恒是规范链接本身。
struct Ranked {
    urls: Vec<String>,
    idx: usize,
    at: Instant,
}

impl Ranked {
    /// 换下一面。**轮完一圈回到第一个**：失败未必是镜像的错（磁盘满、拔网线），
    /// 一路沿排名往下走只会越走越差。
    fn advance(&mut self) {
        self.idx = if self.idx + 1 < self.urls.len() {
            self.idx + 1
        } else {
            0
        };
    }

    fn current(&self) -> Option<&String> {
        self.urls.get(self.idx)
    }
}

static PICKS: OnceLock<Mutex<HashMap<String, Ranked>>> = OnceLock::new();

fn picks() -> &'static Mutex<HashMap<String, Ranked>> {
    PICKS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 这一条链接该从哪儿取字节。非 GitHub / 关掉了镜像 ⇒ 原样返回。
pub async fn pick(canonical: &str) -> String {
    if !mirrorable(canonical) || disabled() {
        return canonical.to_string();
    }
    if let Some(url) = cached(canonical) {
        return url;
    }

    let mirrors = mirror_list().await;
    let mut urls = probe_all(canonical, &mirrors).await;
    /* 官方那条**永远垫在最后**：镜像全不通（名单过期、公司网只放行 github.com）
    时它还有机会，而它失败时报出来的也是 github.com 的错，不是某个野镜像的。 */
    urls.push(canonical.to_string());
    /* 记一行日志：用户报「下不动」时，第一件要问清的就是「走的哪一面」——
    界面上没有这一格，而那一步已经过去了。只在**重新挑**的时候记（缓存命中不记），
    否则每下一卷都刷一行。 */
    if let Some(first) = urls.first().filter(|u| *u != canonical) {
        crate::log_line(&format!("镜像加速：{canonical} → {first}"));
    }
    if let Ok(mut g) = picks().lock() {
        g.insert(
            canonical.to_string(),
            Ranked {
                urls,
                idx: 0,
                at: Instant::now(),
            },
        );
    }
    cached(canonical).unwrap_or_else(|| canonical.to_string())
}

/// 刚用的那一面失败了：下一轮换一面。没有记录就什么都不做。
pub fn discard(canonical: &str) {
    if let Ok(mut g) = picks().lock()
        && let Some(r) = g.get_mut(canonical)
    {
        r.advance();
    }
}

fn cached(canonical: &str) -> Option<String> {
    let g = picks().lock().ok()?;
    let r = g.get(canonical)?;
    if r.at.elapsed() >= PICK_TTL {
        return None;
    }
    r.current().cloned()
}

/// 并发实测各面，能用的在前。
///
/// ⚠️ 名次是**三级**：先「认不认 `Range`」，再「同一个窗口里收到了多少字节」，最后才是耗时。
///   认 `Range` 的镜像才能让「断了几 GB 接着下」生效；不认的那几面每次续传都得从头写，
///   是次选 —— 但**仍排在 github.com 前面**：境内只放行某一面镜像的环境里，次选的镜像
///   也比连不上的直连强。
///   ⚠️ 第二级用**同一窗口内的字节数**而不是耗时：窗口内收到更多 = 更快，且慢面不会因为
///   超时被判死（见 `PROBE_WINDOW`）。
async fn probe_all(canonical: &str, mirrors: &[Mirror]) -> Vec<String> {
    let client = crate::net::client();
    let picked = shortlist(mirrors);
    let futs = picked.iter().map(|m| {
        let url = proxy_url(m, canonical);
        async move { probe_one(client, &url).await.map(|m| (m, url)) }
    });
    let mut ok: Vec<(Measured, String)> = futures_util::future::join_all(futs)
        .await
        .into_iter()
        .flatten()
        .collect();
    ok.sort_by(|a, b| {
        b.0.ranged
            .cmp(&a.0.ranged)
            .then(b.0.bytes.cmp(&a.0.bytes))
            .then(a.0.took.cmp(&b.0.took))
    });
    ok.into_iter().map(|(_, u)| u).collect()
}

/// 从名单里挑出这次要实测的那几面。
///
/// ⚠️ **不是「按站长测出来的速度取前 8」**。那个速度是**他的机器**到各镜像测的，和我们
/// 这边经常对不上：实测（2026-10）他那份排在第 10 名开外的 `gh.acmsz.top` 反而是这边最快
/// 的一面（1.7–2.1 MB/s），而按他的名次取前 8 根本轮不到它。
/// 所以：前 4 面按他的名次（他的测量多少有点信息量），其余 4 面**在整张名单上等距取**
/// —— 靠后但可能很快的镜像也得有机会。
fn shortlist(list: &[Mirror]) -> Vec<Mirror> {
    const HEAD: usize = 4;
    let mut picked: Vec<Mirror> = list.iter().take(PROBE_MAX.min(HEAD)).cloned().collect();
    let rest: Vec<&Mirror> = list.iter().skip(picked.len()).collect();
    let want = PROBE_MAX.saturating_sub(picked.len());
    if want == 0 || rest.is_empty() {
        return picked;
    }
    for i in 0..want {
        // 等距：want == 1 时取第一个，否则首尾都取到（名单末尾那面也测一次）
        let idx = if want == 1 {
            0
        } else {
            i * (rest.len() - 1) / (want - 1)
        };
        picked.push(rest[idx].clone());
    }
    picked
}

/// 一面的实测结果。
struct Measured {
    /// 服务端认 `Range`（回了 `206`）。
    ranged: bool,
    /// 窗口内收到了多少字节 —— 这就是它的速率名次。
    bytes: u64,
    /// 这一面从发请求到收工花了多久。
    took: Duration,
}

/// 这一面能不能用、以及能跑多快（能就顺带把它排进名次）。
///
/// ⚠️ 三种「看着能用、其实是废的」都要挡掉：
///   * **回 `200`**：不认 `Range`。还能下（只是续传要从头写），所以留着当次选；
///   * **回 HTML**：有些代理对取不到的路径回一个 200/206 的错误页，body 头写着
///     `Content-Type: text/html`。它过得了「非空 body」那一关，却要等到解压才炸；
///   * **一个字节都没到**：有的代理这时才去连上游（或者根本没有这个文件）。
async fn probe_one(client: &reqwest::Client, url: &str) -> Option<Measured> {
    use futures_util::StreamExt;
    let t = Instant::now();
    let res = client
        .get(url)
        .header(
            RANGE,
            HeaderValue::from_str(&format!("bytes=0-{}", PROBE_MAX_BYTES - 1))
                .unwrap_or(HeaderValue::from_static("bytes=0-2097151")),
        )
        // 只要响应头：body 的读取由下面那个窗口管，别让请求级超时把它提前掐掉
        .timeout(PROBE_WINDOW + Duration::from_secs(3))
        .send()
        .await
        .ok()?;
    let status = res.status().as_u16();
    let ranged = status == 206;
    if !ranged && status != 200 {
        return None;
    }
    let html = res
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.to_ascii_lowercase().contains("text/html"));
    if html {
        return None;
    }

    /* 读满一个**固定窗口**（或收够 PROBE_MAX_BYTES 就提前收工）：拿到多少字节就是多少。
    ⚠️ 别改成「读完整个 body」：不认 Range 的镜像会回一整个 966 MB，那样挑一面镜子
    就要几分钟、白烧几 GB 流量。 */
    let deadline = Instant::now() + PROBE_WINDOW;
    let mut bytes: u64 = 0;
    let mut stream = res.bytes_stream();
    while bytes < PROBE_MAX_BYTES {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        match tokio::time::timeout(left, stream.next()).await {
            Ok(Some(Ok(chunk))) => bytes += chunk.len() as u64,
            // 超时 / 流断了 / 到末尾：都按「收到了这么多」算
            _ => break,
        }
    }
    if bytes == 0 {
        return None;
    }
    Some(Measured {
        ranged,
        bytes,
        took: t.elapsed(),
    })
}

/// 这面镜像上，这条规范链接变成了什么。
fn proxy_url(m: &Mirror, canonical: &str) -> String {
    let path = canonical
        .trim_start_matches("https://")
        .trim_start_matches("http://");
    let path = path.strip_prefix("github.com/").unwrap_or(path);
    let base = m.base.trim_end_matches('/');
    let prefix = m.path_prefix.trim_end_matches('/');
    if prefix.is_empty() {
        format!("{base}/{path}")
    } else {
        format!("{base}/{prefix}/{path}")
    }
}

/// 这条链接值不值得走镜像。
///
/// 只看 `github.com`：`api.github.com`（更新检查）与其余域名（PyPI 等）都由
/// 各自的 CDN 直连，套一层代理只会更慢。
fn mirrorable(url: &str) -> bool {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"));
    matches!(rest, Some(r) if r.starts_with("github.com/"))
}

/// `VSS_GH_MIRROR=off` 时整层关掉。
fn disabled() -> bool {
    matches!(
        std::env::var("VSS_GH_MIRROR").map(|v| v.trim().to_ascii_lowercase()),
        Ok(v) if matches!(v.as_str(), "off" | "0" | "false" | "no" | "none")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 链接拼法必须跟着名单里的 `pathPrefix` 走 —— 照抄 `https://github.com`
    /// 那一份会拼出 `https://ghfast.top/https://github.com/...` 这种打不开的地址。
    #[test]
    fn the_url_shape_follows_path_prefix() {
        let m = |base: &str, prefix: &str| Mirror {
            base: base.to_string(),
            path_prefix: prefix.to_string(),
        };
        let gh = "https://github.com/Owner/Repo/releases/download/modules/models.zip";
        assert_eq!(
            proxy_url(&m("https://gh-proxy.com/", "https://github.com"), gh),
            "https://gh-proxy.com/https://github.com/Owner/Repo/releases/download/modules/models.zip"
        );
        assert_eq!(
            proxy_url(&m("https://ghfast.top/", "github.com"), gh),
            "https://ghfast.top/github.com/Owner/Repo/releases/download/modules/models.zip"
        );
        assert_eq!(
            proxy_url(&m("https://bare.example/", ""), gh),
            "https://bare.example/Owner/Repo/releases/download/modules/models.zip"
        );
        // 名单是外部数据：base 少个尾斜杠也得拼对
        assert_eq!(
            proxy_url(&m("https://x.example", "github.com"), gh),
            "https://x.example/github.com/Owner/Repo/releases/download/modules/models.zip"
        );
    }

    /// 只有 github.com 上的东西才走镜像：更新检查（`api.github.com`）与 PyPI
    /// 都是直连更快，套上代理反而要多一跳。
    #[test]
    fn only_github_com_is_mirrorable() {
        assert!(mirrorable(
            "https://github.com/a/b/releases/download/t/x.zip"
        ));
        assert!(!mirrorable("https://api.github.com/repos/a/b/releases"));
        assert!(!mirrorable("https://objects.githubusercontent.com/x"));
        assert!(
            !mirrorable("https://files.pythonhosted.org/packages/x.whl"),
            "PyPI 的 wheel 不该被套上 GitHub 代理"
        );
        assert!(!mirrorable("http://127.0.0.1:18080/models.zip"));
    }

    /// 一轮里失败两次就换过两面、第三面回到第一名 —— 轮完一圈不能停在最后一面。
    #[test]
    fn a_failed_mirror_moves_to_the_next_and_wraps_around() {
        let mut r = Ranked {
            urls: vec!["a".into(), "b".into(), "github".into()],
            idx: 0,
            at: Instant::now(),
        };
        assert_eq!(r.current().map(String::as_str), Some("a"));
        r.advance();
        assert_eq!(r.current().map(String::as_str), Some("b"));
        r.advance();
        assert_eq!(r.current().map(String::as_str), Some("github"));
        r.advance();
        assert_eq!(
            r.current().map(String::as_str),
            Some("a"),
            "轮完一圈该回到最快的那个：失败未必是镜像的错"
        );
    }

    /// 名单里那几面 `status != ok` 的、以及 base 不是 https 的，都不该进候选。
    #[test]
    fn the_list_keeps_only_ok_and_https_rows() {
        let raw: Value = serde_json::from_str(
            r#"{"mirrors":[
              {"key":"a","base":"https://a.example/","pathPrefix":"https://github.com","speed":9.0,"status":"ok"},
              {"key":"b","base":"https://b.example/","speed":99.0,"status":"error"},
              {"key":"c","base":"http://c.example/","speed":99.0,"status":"ok"},
              {"key":"d","base":"https://d.example/","pathPrefix":"github.com","speed":1.5,"status":"ok"}
            ]}"#,
        )
        .unwrap();
        let rows = raw.get("mirrors").unwrap().as_array().unwrap();
        let mut kept: Vec<(&str, f64)> = rows
            .iter()
            .filter(|m| m.get("status").and_then(Value::as_str) == Some("ok"))
            .filter_map(|m| {
                let base = m.get("base").and_then(Value::as_str)?;
                base.starts_with("https://").then(|| {
                    (
                        m.get("key").and_then(Value::as_str).unwrap_or(""),
                        m.get("speed").and_then(Value::as_f64).unwrap_or(0.0),
                    )
                })
            })
            .collect();
        kept.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap());
        assert_eq!(kept, vec![("a", 9.0), ("d", 1.5)]);
    }

    /* ── 实测那一层的三条判据（用本地服务器，不联网）─────────────── */

    /// 起一个只会按 `reply` 作答的服务器，返回它的 URL。
    fn fixed_server(reply: &'static str) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(mut s) = conn else { continue };
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf);
                let _ = s.write_all(reply.as_bytes());
            }
        });
        format!("http://127.0.0.1:{port}/x.zip")
    }

    /// 代理回一个 HTML 错误页时**不能**把它当成可用镜像：它过得了「有响应、body
    /// 非空」那两关（实测 `github.chenc.dev` / `ghp.keleyaa.com` 就是回
    /// `206` + `Content-Range: bytes 0-15/*` 的一页 HTML），却要等到解压才炸 ——
    /// 而那时几个 GB 已经下完了。
    #[tokio::test]
    async fn an_html_error_page_is_not_a_usable_mirror() {
        let html = fixed_server(
            "HTTP/1.1 206 Partial Content\r\nContent-Type: text/html; charset=utf-8\r\n\
             Content-Range: bytes 0-15/*\r\nContent-Length: 16\r\nConnection: close\r\n\r\n\
             <html>err</html>",
        );
        assert!(probe_one(crate::net::client(), &html).await.is_none());

        // 二进制、认 Range：首选
        let ranged = fixed_server(
            "HTTP/1.1 206 Partial Content\r\nContent-Type: application/octet-stream\r\n\
             Content-Length: 4\r\nConnection: close\r\n\r\nPK\x03\x04",
        );
        let m = probe_one(crate::net::client(), &ranged)
            .await
            .expect("这面该能用");
        assert!(m.ranged, "回了 206 就该记成「认 Range」");

        // 二进制、不认 Range（回 200 一整份）：还能下，但只能当次选
        let plain = fixed_server(
            "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\n\
             Content-Length: 4\r\nConnection: close\r\n\r\nPK\x03\x04",
        );
        let m = probe_one(crate::net::client(), &plain)
            .await
            .expect("这面还能下");
        assert!(!m.ranged, "回 200 是不认 Range，要排到认 Range 的后面");
    }

    /// 短名单：前 4 面按名单顺序，其余等距铺满整张名单 —— 靠后但可能很快的镜像
    /// （实测就有这种）不能被「站长的前 8 名」挡住。
    #[test]
    fn the_shortlist_spreads_across_the_whole_list() {
        let list: Vec<Mirror> = (0..12)
            .map(|i| Mirror {
                base: format!("https://m{i}.example/"),
                path_prefix: "https://github.com".to_string(),
            })
            .collect();
        let picked = shortlist(&list);
        assert_eq!(picked.len(), PROBE_MAX, "该测 {PROBE_MAX} 面");
        // 前 4 面按顺序
        for i in 0..4 {
            assert_eq!(picked[i].base, list[i].base);
        }
        // 其余等距，且**名单末尾那面也在内**（最容易被漏掉的那一头）
        assert_eq!(picked.last().unwrap().base, list.last().unwrap().base);
        let bases: Vec<&str> = picked.iter().map(|m| m.base.as_str()).collect();
        let unique: std::collections::HashSet<&&str> = bases.iter().collect();
        assert_eq!(unique.len(), bases.len(), "短名单里不该有重复：{bases:?}");
        // 名单比 PROBE_MAX 短时：全都测，不越界
        let few = shortlist(&list[..3]);
        assert_eq!(few.len(), 3);
    }

    /// 真去实测一遍并打印排名 —— 镜像名单会烂，这是「现在哪几面还能用」的现场证据。
    ///
    ///     cargo test --lib real_mirror_pick -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "要联网实测镜像，按需手动跑"]
    async fn real_mirror_pick_ranks_live_mirrors() {
        let url =
            "https://github.com/QingMu39-Gao/V-Synth-Studio/releases/download/modules/models.zip";
        let list = mirror_list().await;
        println!("名单 {} 面，短名单实测 {PROBE_MAX} 面：", list.len());
        for u in probe_all(url, &list).await {
            println!("  ✓ {u}");
        }
        let picked = pick(url).await;
        println!("挑中：{picked}");
        assert!(picked.contains("models.zip"));
    }

    /// 从这面镜像拉 `want` 字节，返回真拿到多少（失败/超时 0）。
    ///
    /// ⚠️ **收够 `want` 就断开**：不认 `Range` 的镜像会回一整个文件（966 MB），
    /// 由着它读完，量一次要几分钟、还白烧几 GB 流量。
    async fn sample_bytes(url: &str, want: u64) -> u64 {
        use futures_util::StreamExt;
        let req = crate::net::client()
            .get(url)
            .header(
                RANGE,
                HeaderValue::from_str(&format!("bytes=0-{}", want - 1))
                    .unwrap_or(HeaderValue::from_static("bytes=0-0")),
            )
            .timeout(Duration::from_secs(30));
        let res = match req.send().await {
            Ok(r) => r,
            Err(_) => return 0,
        };
        if !(200..300).contains(&res.status().as_u16()) {
            return 0;
        }
        let mut n = 0u64;
        let mut stream = res.bytes_stream();
        while let Some(chunk) = stream.next().await {
            match chunk {
                Ok(c) => {
                    n += c.len() as u64;
                    if n >= want {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
        n
    }

    /// **每一面都真拉一大段**，报持续速率 —— 名单里谁被限速、限到多少，只有这么量。
    ///
    /// 为什么不能只看 `pick` 那次实测：它取 128 KiB，那个量级量的是**延迟**（RTT + 首字节），
    /// 而几 GB 的包在意的是**持续**速率。两面延迟都是 100 ms 的镜像，一个能跑 20 MB/s、
    /// 另一个被限到 1 MB/s，128 KiB 那一下分不出来。
    ///
    ///     $env:VSS_MIRROR_BENCH_MB='8'      # 每面拉多少（默认 8 MiB）
    ///     $env:VSS_MIRROR_BENCH_URL='...'   # 拿哪个资产测（默认 runtime.z01）
    ///     cargo test --lib real_mirror_throughput -- --ignored --nocapture
    ///
    /// ⚠️ 一面接一面地测（不并发）：并发测出来的名次是「谁抢带宽厉害」，不是「谁能跑多快」。
    #[tokio::test]
    #[ignore = "要联网把每一面都拉一段，按需手动跑"]
    async fn real_mirror_throughput_ranks_live_mirrors() {
        let url = std::env::var("VSS_MIRROR_BENCH_URL").unwrap_or_else(|_| {
            "https://github.com/QingMu39-Gao/V-Synth-Studio/releases/download/modules/runtime.z01"
                .to_string()
        });
        let mb: u64 = std::env::var("VSS_MIRROR_BENCH_MB")
            .ok()
            .and_then(|v| v.parse().ok())
            .unwrap_or(8);
        let want = mb * 1024 * 1024;
        let list = mirror_list().await;
        println!("候选 {} 面，每面拉 {mb} MiB（一面接一面）：", list.len());

        let mut rows: Vec<(f64, String)> = Vec::new();
        for m in &list {
            let u = proxy_url(m, &url);
            let t = Instant::now();
            let n = sample_bytes(&u, want).await;
            let secs = t.elapsed().as_secs_f64();
            match n {
                n if n > 0 => rows.push((
                    n as f64 / 1048576.0 / secs,
                    format!("{:7.2} MB/s  {n:>9} B  {u}", n as f64 / 1048576.0 / secs),
                )),
                _ => rows.push((0.0, format!("  失败/超时            {u}"))),
            }
        }
        rows.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
        for (_, line) in &rows {
            println!("  {line}");
        }
    }
}
