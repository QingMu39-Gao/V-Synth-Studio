//! 「公告」—— 从自建接口取一条公告，设置里单独一栏 + 启动时弹没读过的那条。
//!
//! ```json
//! { "id": "2026-10-20-01", "level": "info", "title": "维护通知",
//!   "body": "今晚 23:00–24:00 进行服务器维护。",
//!   "published_at": "2026-10-20T10:00:00Z", "expires_at": "2026-10-21T00:00:00Z" }
//! ```
//!
//! 服务端定下的语义（这里按它对接）：
//!
//! - **`id` 变了才算新公告** —— 「已读」按 id 记在配置里，同一条不会每次启动都弹；
//! - `level` 只影响样式：`info` / `warn` / `critical`；
//! - `body` 是**纯文本换行**，界面按纯文本显示（**不渲染 HTML / Markdown**，防注入）；
//! - `expires_at` 已过期的**忽略这条**；缺失时不过期（见 [`expired`]）。
//!
//! ⚠️ 只写域名、不写 IP：源站只允许 Cloudflare 回源，直连 IP 会被网络层丢弃（表现为超时）。
//! 换地址只改 [`ANNOUNCE_URLS`]；本地 mock 用环境变量 `VSS_ANNOUNCE_URL`。
//!
//! 宽容的地方（字段写错不至于整栏空着）：顶层也认数组与
//! `{announcements|items|list: [...]}`（以后想一次发多条不用改客户端），
//! `title` 认 `title|name|subject`，正文认 `body|content|text|desc`，
//! 日期认 `date|publishedAt|time|published_at`，链接认 `url|link`。
//! `id` 缺失时用标题兜底 —— 于是**改标题等于发了一条新的**（要改内容又不想再弹，
//! 就显式写 `id`）。
//!
//! ⚠️ 取不到时**静默**：启动那一下不弹任何东西（公告取不到不该打扰用户），
//! 设置里那一栏照实说「取不到」。

use std::time::Duration;

use serde_json::{Value, json};

/// 公告地址（**完整 URL**，按顺序试到第一个能用的）。
///
/// ⚠️ 换地址只改这里。临时试另一个（不想改代码）用环境变量 `VSS_ANNOUNCE_URL`，
/// 逗号分隔，例如 `VSS_ANNOUNCE_URL=http://127.0.0.1:8899/announcement.json`。
///
/// ⚠️ 只收 `https://`（`http://127.0.0.1` / `localhost` 例外，给自己调试用）。
const ANNOUNCE_URLS: &[&str] = &["https://admin1.qingmu39.top/api/announcement.json"];

/// 单次请求的等待上限。规格要求 5~10 秒，取 6。
const TIMEOUT: Duration = Duration::from_secs(6);

/// 自建接口的 UA：给一个明确的值（留空、或用库的默认 UA 都容易被 WAF 拦）。
pub(crate) fn self_host_ua() -> String {
    format!("V-Synth-Studio/{}", crate::ipc::config_file::APP_VERSION)
}

/// 一次最多认多少条：服务器把别的东西（整站 JSON、几百条日志）发下来时不至于把界面塞爆。
const MAX_ITEMS: usize = 50;

/// 正文上限，超了截断 —— 与检查更新的说明同一个理由（整篇过 IPC 没道理）。
const BODY_LIMIT: usize = 4000;

/// 读一个字符串字段，按候选键名依次找。
fn pick<'a>(v: &'a Value, keys: &[&str]) -> Option<&'a str> {
    keys.iter()
        .find_map(|k| v.get(*k).and_then(|x| x.as_str()))
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

fn clamp(s: &str) -> String {
    if s.chars().count() <= BODY_LIMIT {
        return s.to_string();
    }
    let head: String = s.chars().take(BODY_LIMIT).collect();
    format!("{head}…")
}

/// ISO 8601 → 纪元秒。认 `YYYY-MM-DD`、`YYYY-MM-DDTHH:MM[:SS]`，可选 `Z` 或 `±HH:MM`。
///
/// 认不出的回 `None`（调用方按「没有过期时间」处理，fail-open）。自己算而不是引时间库：
/// 这一仓的取舍是「为几个时间戳不引 chrono」（见 `lib.rs::log_line` 那处的说明）。
pub fn iso_epoch(s: &str) -> Option<i64> {
    let s = s.trim();
    if s.is_empty() {
        return None;
    }
    let (date, rest) = match s.find(['T', 't', ' ']) {
        Some(i) => (&s[..i], Some(s[i + 1..].trim())),
        None => (s, None),
    };
    let mut d = date.split('-');
    let y: i64 = d.next()?.parse().ok()?;
    let mo: i64 = d.next()?.parse().ok()?;
    let da: i64 = d.next()?.parse().ok()?;
    if d.next().is_some() || !(1..=12).contains(&mo) || !(1..=31).contains(&da) {
        return None;
    }
    let (mut hh, mut mm, mut ss) = (0i64, 0i64, 0i64);
    let mut offset = 0i64;
    if let Some(t) = rest {
        let (time, off) = split_offset(t);
        offset = off;
        let mut it = time.split(':');
        hh = it.next()?.parse().ok()?;
        if let Some(x) = it.next() {
            mm = x.parse().ok()?;
        }
        if let Some(x) = it.next() {
            // 秒可能带小数（`12.5`）：取整数部分
            ss = x.split('.').next()?.parse().ok()?;
        }
        if hh > 23 || mm > 59 || ss > 60 {
            return None;
        }
    }
    Some(days_from_civil(y, mo, da) * 86400 + hh * 3600 + mm * 60 + ss - offset)
}

/// 把「时:分:秒」那一段拆成（不含偏移的时间, 偏移秒数）。认 `Z` / `+08:00` / `-0500`。
fn split_offset(t: &str) -> (&str, i64) {
    let t = t.trim();
    if let Some(stripped) = t.strip_suffix(['Z', 'z']) {
        return (stripped, 0);
    }
    // 从右侧找 `+` / `-`（日期部分已经切掉了，这里只可能是时区）
    if let Some(i) = t.rfind(['+', '-']) {
        let (time, zone) = t.split_at(i);
        let sign = if zone.starts_with('-') { -1 } else { 1 };
        let digits: String = zone.chars().filter(|c| c.is_ascii_digit()).collect();
        let (h, m) = match digits.len() {
            4 => (digits[..2].parse::<i64>(), digits[2..].parse::<i64>()),
            2 => (digits[..2].parse::<i64>(), Ok(0)),
            _ => (Ok(0), Ok(0)),
        };
        if let (Ok(h), Ok(m)) = (h, m) {
            return (time, sign * (h * 3600 + m * 60));
        }
    }
    (t, 0)
}

/// 公历年月日 → 距 1970-01-01 的天数（Howard Hinnant 的 `days_from_civil`）。
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

/// 这条公告过期了吗。
///
/// ⚠️ **fail-open**：`expires_at` 缺失或解析不出来时**不算过期**（照常显示）。
/// 反过来（认不出就当过期）会让一个格式写错的字段把公告静默吞掉，而那种错没人会发现。
pub fn expired(raw: &Value, now: i64) -> bool {
    match pick(raw, &["expires_at", "expiresAt"]) {
        Some(s) => iso_epoch(s).is_some_and(|t| t <= now),
        None => false,
    }
}

/// 一条公告规整成界面要的形状；缺了必须有的东西、或已经过期就回 `None`
/// （**丢这一条，不丢整栏**）。
pub fn normalize(raw: &Value, now: i64) -> Option<Value> {
    if !raw.is_object() {
        return None;
    }
    if expired(raw, now) {
        return None;
    }
    let title = pick(raw, &["title", "name", "subject"]).unwrap_or("");
    let body = pick(raw, &["body", "content", "text", "desc"]).unwrap_or("");
    // 标题与正文都空：这条没有任何能显示的东西
    if title.is_empty() && body.is_empty() {
        return None;
    }
    /* ⚠️ `id` 缺失时用标题兜底：已读是按 id 记的，而「同一条公告」在服务器上就是同一个
    id。缺 id 的条目改了标题会被当成新的一条 —— 这是能接受的（也确实变了），
    但要在文档里写明。 */
    let id = pick(raw, &["id", "key"]).unwrap_or(title);
    if id.is_empty() {
        return None;
    }
    let date = pick(raw, &["date", "publishedAt", "time", "published_at"]).unwrap_or("");
    let level = match pick(raw, &["level", "severity"]).unwrap_or("info") {
        "warn" | "warning" => "warn",
        "critical" | "danger" => "critical",
        _ => "info",
    };
    Some(json!({
        "id": id,
        "title": title,
        "body": clamp(body),
        "date": date,
        "level": level,
        "url": pick(raw, &["url", "link"]).unwrap_or(""),
        "expiresAt": pick(raw, &["expires_at", "expiresAt"]).unwrap_or(""),
    }))
}

/// 一份公告 JSON → 规整 + 排序后的条目（`fetch` 与单测都走这条）。
///
/// 认三种顶层形状：**单条对象**（服务端现在的形状）、数组、`{announcements|items|list}`。
/// 排序：**日期新的在前**（ISO 8601 的字符串序就是时间序）；没有日期的排最后。
/// `now` 由调用方给（纪元秒），过期判断才可测。
pub fn items_from(v: &Value, now: i64) -> Result<Vec<Value>, String> {
    let list: Vec<Value> = if let Some(arr) = v.as_array() {
        arr.clone()
    } else if let Some(arr) = ["announcements", "items", "list"]
        .iter()
        .find_map(|k| v.get(*k).and_then(|x| x.as_array()).cloned())
    {
        arr
    } else if v.is_object() {
        // 单条：服务端现在的形状就是它
        vec![v.clone()]
    } else {
        return Err("顶层既不是对象，也不是数组 / announcements / items / list".to_string());
    };

    let mut items: Vec<Value> = list
        .iter()
        .filter_map(|x| normalize(x, now))
        .take(MAX_ITEMS)
        .collect();
    // 有日期的排前面（新的在前），没有日期的留在后面
    items.sort_by(|a, b| {
        let (da, db) = (
            a["date"].as_str().unwrap_or(""),
            b["date"].as_str().unwrap_or(""),
        );
        match (da.is_empty(), db.is_empty()) {
            (true, true) => std::cmp::Ordering::Equal,
            (true, false) => std::cmp::Ordering::Greater,
            (false, true) => std::cmp::Ordering::Less,
            (false, false) => db.cmp(da),
        }
    });
    Ok(items)
}

/// 生效的公告地址：环境变量 `VSS_ANNOUNCE_URL`（逗号分隔）优先于常量。
pub fn announce_urls() -> Vec<String> {
    urls_from(
        ANNOUNCE_URLS,
        std::env::var("VSS_ANNOUNCE_URL").ok().as_deref(),
    )
}

/// 纯函数版（环境变量是进程级的，直接读它写不出可复现的用例）。
fn urls_from(consts: &[&str], env: Option<&str>) -> Vec<String> {
    let raw: Vec<String> = match env.map(str::trim).filter(|s| !s.is_empty()) {
        Some(v) => v.split(',').map(|s| s.trim().to_string()).collect(),
        None => consts.iter().map(|s| s.to_string()).collect(),
    };
    let mut out: Vec<String> = Vec::new();
    for u in raw {
        if u.is_empty() || !crate::update::allowed_base(&u) || out.contains(&u) {
            continue;
        }
        out.push(u);
    }
    out
}

/// 取一次公告。回 `{ok, items, via}` 或 `{ok:false, error}`。
///
/// ⚠️ **不是 `Err`**：公告取不到是常态（服务器在重启、用户断网、Cloudflare 回人机验证），
/// 而调用方对这两种情况的处理是一样的 —— 什么都不做。真出错再冒泡只会逼着每个调用点
/// 写一遍 try。
///
/// ⚠️ 判据全在 [`crate::net::fetch_public_json`] 里：HTTP 2xx → `Content-Type` 含 json →
/// 才解析。拿到 HTML 一律当失败（**绝不能把一页 HTML 当公告解析出来**）。
pub async fn fetch() -> Value {
    let urls = announce_urls();
    if urls.is_empty() {
        return json!({ "ok": false, "error": "还没配公告地址（见 announce.rs 的 ANNOUNCE_URLS）" });
    }
    let ua = self_host_ua();
    let mut tried: Vec<String> = Vec::new();
    for url in urls {
        match crate::net::fetch_public_json(&url, &ua, TIMEOUT).await {
            Ok(v) => match items_from(&v, crate::net::now_epoch() as i64) {
                Ok(items) => {
                    crate::log_line(&format!("公告：{url} 取到 {} 条", items.len()));
                    return json!({ "ok": true, "items": items, "via": url });
                }
                Err(e) => {
                    crate::log_line(&format!("公告：{url} 的内容读不了（{e}）"));
                    tried.push(format!("{url}（{e}）"));
                }
            },
            Err(e) => {
                crate::log_line(&format!("公告：{url} 取不到（{e}）"));
                tried.push(format!("{url}（{e}）"));
            }
        }
    }
    json!({ "ok": false, "error": format!("取不到公告：{}", tried.join("；")) })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 所有用例都用这个「现在」：2026-10-20T12:00:00Z。
    const NOW: i64 = 1792497600;

    /// 文本 → JSON → 规整（生产里这两步在 `fetch` 内联，见 `items_from`）。
    fn parse_at(text: &str, now: i64) -> Result<Vec<Value>, String> {
        let v: Value = serde_json::from_str(text).map_err(|e| format!("不是合法 JSON：{e}"))?;
        items_from(&v, now)
    }

    /// 用固定的「现在」跑上面那条。
    fn parse(text: &str) -> Result<Vec<Value>, String> {
        parse_at(text, NOW)
    }

    #[test]
    fn reads_both_top_level_shapes() {
        let arr = parse(r#"[{"id":"a","title":"公告一"}]"#).unwrap();
        assert_eq!(arr.len(), 1);
        assert_eq!(arr[0]["title"], json!("公告一"));

        let obj = parse(r#"{"announcements":[{"id":"a","title":"公告一"}]}"#).unwrap();
        assert_eq!(obj.len(), 1);
        // `items` / `list` 也认（别逼服务器改成我们的形状）
        assert_eq!(
            parse(r#"{"items":[{"id":"a","title":"x"}]}"#)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            parse(r#"{"list":[{"id":"a","title":"x"}]}"#).unwrap().len(),
            1
        );

        /* ⚠️ 单条对象是**服务端的正式形状**，所以「一个认不出的对象」与「一条缺字段的公告」
        在语法上没法区分，只能都当「没有可用公告」：回空列表，不报错。
        真正该报错的是**根本不是 JSON**。 */
        assert!(parse(r#"{"foo":1}"#).unwrap().is_empty());
        assert!(parse("not json").is_err());
    }

    #[test]
    fn normalizes_aliases_and_drops_empty_entries() {
        let items = parse(
            r#"{"announcements":[
                {"key":"k1","subject":"标题","content":"正文","publishedAt":"2026-01-02","severity":"warning","link":"https://x"},
                {"id":"k2","name":"只有标题"},
                {"id":"k3"},
                "字符串条目"
            ]}"#,
        )
        .unwrap();
        assert_eq!(items.len(), 2, "两条没有内容的要被丢掉");
        assert_eq!(items[0]["id"], json!("k1"));
        assert_eq!(items[0]["body"], json!("正文"));
        assert_eq!(items[0]["date"], json!("2026-01-02"));
        assert_eq!(items[0]["level"], json!("warn"));
        assert_eq!(items[0]["url"], json!("https://x"));
        // 标题与正文都空 → 丢
        assert!(normalize(&json!({"id": "x"}), NOW).is_none());
        assert!(normalize(&json!("不是对象"), NOW).is_none());
    }

    /// 没有 `id` 就用标题兜底：改标题 = 发了一条新的（文档里写明了这件事）。
    #[test]
    fn missing_id_falls_back_to_the_title() {
        let one = normalize(&json!({"title": "维护通知"}), NOW).unwrap();
        assert_eq!(one["id"], json!("维护通知"));
    }

    /// 新的在前；没有日期的排最后（不能把一条没有日期的插到最新那条前面去）。
    #[test]
    fn newest_first_and_undated_last() {
        let items = parse(
            r#"{"announcements":[
                {"id":"old","title":"旧","date":"2026-01-01"},
                {"id":"none","title":"没日期"},
                {"id":"new","title":"新","date":"2026-10-01"},
                {"id":"mid","title":"中","date":"2026-05-01"}
            ]}"#,
        )
        .unwrap();
        let ids: Vec<&str> = items.iter().map(|i| i["id"].as_str().unwrap()).collect();
        assert_eq!(ids, vec!["new", "mid", "old", "none"]);
    }

    /// 一眼看过去的护栏：条数与正文都有上限，服务器写错时界面不会被塞爆。
    #[test]
    fn caps_the_count_and_the_body_length() {
        let many: Vec<String> = (0..80)
            .map(|i| format!(r#"{{"id":"i{i}","title":"t{i}"}}"#))
            .collect();
        let items = parse(&format!("[{}]", many.join(","))).unwrap();
        assert_eq!(items.len(), MAX_ITEMS);

        let long = "x".repeat(BODY_LIMIT + 100);
        let one = normalize(&json!({"id": "a", "title": "t", "body": long}), NOW).unwrap();
        assert_eq!(
            one["body"].as_str().unwrap().chars().count(),
            BODY_LIMIT + 1
        );
    }

    /// **服务端现在就是这么发的**：单条对象 + published_at / expires_at。
    #[test]
    fn reads_the_single_object_the_server_sends() {
        let items = parse_at(
            r#"{"id":"2026-10-20-01","level":"info","title":"维护通知",
                "body":"今晚 23:00–24:00 进行服务器维护,期间可能无法登录。",
                "published_at":"2026-10-20T10:00:00Z","expires_at":"2026-10-21T00:00:00Z"}"#,
            NOW,
        )
        .unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0]["id"], json!("2026-10-20-01"));
        assert_eq!(items[0]["date"], json!("2026-10-20T10:00:00Z"));
        assert_eq!(items[0]["level"], json!("info"));
        assert_eq!(items[0]["expiresAt"], json!("2026-10-21T00:00:00Z"));
    }

    /// 过期的忽略；没写 / 写坏了 `expires_at` 的照常显示（fail-open）。
    #[test]
    fn expired_announcements_are_dropped_but_broken_dates_are_kept() {
        let count = |body: &str| parse_at(body, NOW).unwrap().len();
        // 已经过期（NOW 之前）
        assert_eq!(
            count(r#"{"id":"a","title":"旧","expires_at":"2026-10-19T00:00:00Z"}"#),
            0
        );
        // 正好到点也算过期
        assert_eq!(
            count(r#"{"id":"a","title":"现在","expires_at":"2026-10-20T12:00:00Z"}"#),
            0
        );
        // 还没过期
        assert_eq!(
            count(r#"{"id":"a","title":"新的","expires_at":"2026-10-21T00:00:00Z"}"#),
            1
        );
        // 缺失 / 写坏：不算过期（反过来会把一条格式写错的公告静默吞掉，而那种错没人发现）
        assert_eq!(count(r#"{"id":"a","title":"没写"}"#), 1);
        assert_eq!(
            count(r#"{"id":"a","title":"写坏","expires_at":"下周三"}"#),
            1
        );
    }

    /// ISO 8601 → 纪元秒。带 `Z`、不带时区、带 `+08:00` 都要指向同一个时刻；
    /// 认不出的回 `None`（不猜）。
    #[test]
    fn iso_epoch_understands_the_shapes_we_may_get() {
        // 这两个值由 PowerShell 的 [datetimeoffset]::Parse(...).ToUnixTimeSeconds() 给出
        assert_eq!(iso_epoch("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(iso_epoch("2026-10-21T00:00:00Z"), Some(1792540800));
        assert_eq!(iso_epoch("2026-10-21T08:00:00+08:00"), Some(1792540800));
        assert_eq!(iso_epoch("2026-10-20T20:00:00-04:00"), Some(1792540800));
        // 只给日期 = 当天 00:00 UTC；秒可以省
        assert_eq!(iso_epoch("2026-10-21"), Some(1792540800));
        assert_eq!(iso_epoch("2026-10-20T23:00Z"), Some(1792537200));
        for bad in [
            "",
            "下周三",
            "2026-13-01T00:00:00Z",
            "2026-10-32T00:00:00Z",
            "2026-10-21T25:00:00Z",
        ] {
            assert_eq!(iso_epoch(bad), None, "{bad} 不该认出来");
        }
    }

    /// `critical` 要认出来（只影响样式，但认不出来就静默降级成 info 了）。
    #[test]
    fn critical_level_survives_normalisation() {
        let one = normalize(&json!({"id": "a", "title": "t", "level": "critical"}), NOW).unwrap();
        assert_eq!(one["level"], json!("critical"));
        let warn = normalize(&json!({"id": "a", "title": "t", "level": "warning"}), NOW).unwrap();
        assert_eq!(warn["level"], json!("warn"));
        let odd = normalize(&json!({"id": "a", "title": "t", "level": "别的东西"}), NOW).unwrap();
        assert_eq!(odd["level"], json!("info"));
    }

    /// 地址规矩与更新源一致：只收 https（本机 http 例外）、去重、保序。
    #[test]
    fn only_https_announce_urls_are_accepted() {
        assert_eq!(
            urls_from(&["https://a.example.com/announcements.json"], None),
            vec!["https://a.example.com/announcements.json".to_string()]
        );
        assert_eq!(
            urls_from(
                &[],
                Some(
                    "https://b.example.com/a.json, http://evil.example.com/a.json, https://b.example.com/a.json"
                )
            ),
            vec!["https://b.example.com/a.json".to_string()]
        );
        // 本机调试放行
        assert_eq!(
            urls_from(&[], Some("http://127.0.0.1:8899/announcements.json")).len(),
            1
        );
    }
}
