//! Product announcements from a release asset.

use std::collections::HashSet;
use std::io::Read;
use std::time::Duration;

use serde_json::Value;

const URL: &str =
    "https://github.com/QingMu39-Gao/V-Synth-Studio/releases/latest/download/announcement.json";
const MAX_ITEMS: usize = 50;
const MAX_BYTES: u64 = 1024 * 1024;
const BODY_LIMIT: usize = 4000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Announcement {
    pub id: String,
    pub title: String,
    pub body: String,
    pub level: String,
    pub date: String,
}

pub fn fetch() -> Result<Vec<Announcement>, String> {
    let response = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(6)))
            .timeout_recv_body(Some(Duration::from_secs(6)))
            .build(),
    )
    .get(URL)
    .header(
        "User-Agent",
        concat!("V-Synth-Studio/", env!("CARGO_PKG_VERSION")),
    )
    .call()
    .map_err(|error| format!("读取公告失败：{error}"))?;
    let mut text = String::new();
    response
        .into_body()
        .into_reader()
        .take(MAX_BYTES)
        .read_to_string(&mut text)
        .map_err(|error| format!("读取公告失败：{error}"))?;
    parse(&text)
}

pub fn parse(text: &str) -> Result<Vec<Announcement>, String> {
    let value: Value =
        serde_json::from_str(text).map_err(|error| format!("解析公告失败：{error}"))?;
    let items = if let Some(items) = value.as_array() {
        items
    } else {
        ["announcements", "items", "list"]
            .iter()
            .find_map(|key| value.get(*key).and_then(Value::as_array))
            .ok_or_else(|| "公告格式无效".to_string())?
    };
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for item in items {
        let title = pick(item, &["title", "name", "subject"]).unwrap_or_default();
        let id = pick(item, &["id"]).unwrap_or_else(|| title.clone());
        if id.is_empty() || !seen.insert(id.clone()) {
            continue;
        }
        let body = clamp(&pick(item, &["body", "content", "text", "desc"]).unwrap_or_default());
        let date = pick(item, &["date", "published_at", "publishedAt", "time"]).unwrap_or_default();
        let level = match pick(item, &["level"]).as_deref() {
            Some("warn") => "warn",
            Some("critical") => "critical",
            _ => "info",
        };
        out.push(Announcement {
            id,
            title,
            body,
            level: level.to_string(),
            date,
        });
        if out.len() >= MAX_ITEMS {
            break;
        }
    }
    Ok(out)
}

fn pick(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    })
}

fn clamp(body: &str) -> String {
    if body.chars().count() <= BODY_LIMIT {
        return body.to_string();
    }
    let head: String = body.chars().take(BODY_LIMIT).collect();
    format!("{head}…")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_arrays_and_object_lists() {
        let items = parse(
            r#"[{"id":"a","title":"Hello","body":"Body","level":"warn","date":"2026-10-17T11:47:49Z"}]"#,
        )
        .unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "a");
        assert_eq!(items[0].level, "warn");
        let items = parse(r#"{"items":[{"name":"Title","content":"Text"}]}"#).unwrap();
        assert_eq!(items[0].id, "Title");
        assert_eq!(items[0].body, "Text");
    }

    #[test]
    fn drops_duplicates_and_caps_ids() {
        let items =
            parse(r#"[{"id":"a","title":"One"},{"id":"a","title":"Again"},{"title":"Two"}]"#)
                .unwrap();
        assert_eq!(items.len(), 2);
        assert!(parse("not json").is_err());
        assert!(parse("{}").is_err());
    }
}
