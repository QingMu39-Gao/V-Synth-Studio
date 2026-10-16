//! 「公告」—— 从自建源取一份 JSON 列表，设置里单独一栏 + 启动时弹没读过的那几条。
//!
//! ⚠️ **与「检查更新」不是一回事**：公告不是 GitHub 上的东西，没有可回落的上游，
//! 所以来源只有你自己的服务器（[`ANNOUNCE_URLS`]，留空 = 这个功能不启用，
//! 界面那一栏会说「还没配地址」）。它是**你自己的文件**，所以这里要的是**完整 URL**
//! （不是像更新源那样「前缀 + 整条 GitHub 地址」）。
//!
//! ```json
//! { "announcements": [
//!   { "id": "2026-10-16-maintenance", "title": "今晚维护", "body": "23:00 起约一小时。",
//!     "date": "2026-10-16T10:00:00Z", "level": "warn", "url": "https://…" }
//! ] }
//! ```
//!
//! 宽容的地方（写错一个字段不至于整栏空着）：顶层可以直接是数组，也可以是
//! `{announcements|items|list: [...]}`；`title` 认 `title|name|subject`，正文认
//! `body|content|text|desc`，日期认 `date|publishedAt|time`，链接认 `url|link`。
//! `id` 缺失时用标题兜底 —— 于是**改标题等于发了一条新的**（要改内容又不想再弹，
//! 就显式写 `id`）。
//!
//! ⚠️ 取不到时**静默**：启动那一下不弹任何东西（公告取不到不该打扰用户），
//! 设置里那一栏照实说「取不到」。

use std::time::Duration;

use serde_json::{Value, json};

/// 公告地址（**完整 URL**，按顺序试到第一个能用的）。留空 = 不启用这个功能。
///
/// ⚠️ 换地址只改这里。临时试另一个（不想改代码）用环境变量 `VSS_ANNOUNCE_URL`，
/// 逗号分隔，例如 `VSS_ANNOUNCE_URL=http://127.0.0.1:8899/announcements.json`。
///
/// ⚠️ 只收 `https://`（`http://127.0.0.1` / `localhost` 例外，给自己调试用）。
const ANNOUNCE_URLS: &[&str] = &[];

const TIMEOUT: Duration = Duration::from_secs(8);

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

/// 一条公告规整成界面要的形状；缺了必须有的东西就回 `None`（**丢这一条，不丢整栏**）。
pub fn normalize(raw: &Value) -> Option<Value> {
    if !raw.is_object() {
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
        _ => "info",
    };
    Some(json!({
        "id": id,
        "title": title,
        "body": clamp(body),
        "date": date,
        "level": level,
        "url": pick(raw, &["url", "link"]).unwrap_or(""),
    }))
}

/// 解析一份公告 JSON（顶层数组，或 `{announcements|items|list: [...]}`）。
///
/// 排序：**日期新的在前**（ISO 8601 的字符串序就是时间序）；没有日期的排最后，
/// 保持服务器给的相对顺序。
pub fn parse(text: &str) -> Result<Vec<Value>, String> {
    let v: Value = serde_json::from_str(text).map_err(|e| format!("不是合法 JSON：{e}"))?;
    let list = v
        .as_array()
        .cloned()
        .or_else(|| {
            ["announcements", "items", "list"]
                .iter()
                .find_map(|k| v.get(*k).and_then(|x| x.as_array()).cloned())
        })
        .ok_or_else(|| "顶层既不是数组，也没有 announcements / items / list 数组".to_string())?;

    let mut items: Vec<Value> = list.iter().filter_map(normalize).take(MAX_ITEMS).collect();
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
/// ⚠️ **不是 `Err`**：公告取不到是常态（服务器在重启、用户断网），而调用方对这两种
/// 情况的处理是一样的 —— 什么都不做。真出错再冒泡只会逼着每个调用点写一遍 try。
pub async fn fetch() -> Value {
    let urls = announce_urls();
    if urls.is_empty() {
        return json!({ "ok": false, "error": "还没配公告地址（见 announce.rs 的 ANNOUNCE_URLS）" });
    }
    let mut tried: Vec<String> = Vec::new();
    for url in urls {
        match crate::net::fetch_bytes(&url, crate::net::headers(&[]), TIMEOUT.as_secs()).await {
            Ok(raw) => match parse(&String::from_utf8_lossy(&raw)) {
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

        // 两种都不是：报错（而不是回空列表 —— 那会让「服务器发错东西」看起来像「没有公告」）
        assert!(parse(r#"{"foo":1}"#).is_err());
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
        assert!(normalize(&json!({"id": "x"})).is_none());
        assert!(normalize(&json!("不是对象")).is_none());
    }

    /// 没有 `id` 就用标题兜底：改标题 = 发了一条新的（文档里写明了这件事）。
    #[test]
    fn missing_id_falls_back_to_the_title() {
        let one = normalize(&json!({"title": "维护通知"})).unwrap();
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
        let one = normalize(&json!({"id": "a", "title": "t", "body": long})).unwrap();
        assert_eq!(
            one["body"].as_str().unwrap().chars().count(),
            BODY_LIMIT + 1
        );
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
