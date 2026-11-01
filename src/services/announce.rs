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
    pub url: String,
}

pub fn fetch() -> Result<Vec<Announcement>, String> {
    let url = std::env::var("VSS_ANNOUNCE_URL").unwrap_or_else(|_| URL.to_string());
    let response = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(6)))
            .timeout_recv_body(Some(Duration::from_secs(6)))
            .build(),
    )
    .get(&url)
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
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|since| since.as_secs() as i64)
        .unwrap_or_default();
    parse_at(text, now)
}

pub fn parse_at(text: &str, now: i64) -> Result<Vec<Announcement>, String> {
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
        // Only a readable expiry can retire a notice: a malformed one keeps it,
        // because silently swallowing a critical announcement is the worse
        // failure and no log line would show it happened.
        let expired = pick(item, &["expires", "expires_at", "expiresAt"])
            .and_then(|raw| expiry_epoch(&raw).map(|end| end <= now))
            .unwrap_or(false);
        if expired {
            continue;
        }
        out.push(Announcement {
            id,
            title,
            body,
            level: level.to_string(),
            date,
            url: safe_url(&pick(item, &["url", "link"]).unwrap_or_default()),
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

/// The link is handed to the shell, so only absolute web URLs survive.
fn safe_url(value: &str) -> String {
    if value.starts_with("https://") || value.starts_with("http://") {
        return value.to_string();
    }
    String::new()
}

fn expiry_epoch(value: &str) -> Option<i64> {
    let value = value.trim();
    let (stamp, offset) = if value.ends_with('Z') || value.ends_with('z') {
        (&value[..value.len() - 1], 0)
    } else {
        match offset_split(value) {
            Some(parts) => parts,
            None => (value, 0),
        }
    };
    let (date, time) = match stamp.split_once(['T', 't']) {
        Some(parts) => parts,
        None => (stamp, "00:00:00"),
    };
    let mut days = date.split('-');
    let year: i64 = days.next()?.parse().ok()?;
    let month: i64 = days.next()?.parse().ok()?;
    let day: i64 = days.next()?.parse().ok()?;
    if days.next().is_some() || !(1..=12).contains(&month) || !(1..=31).contains(&day) {
        return None;
    }
    let mut clock = time.split(':');
    let hour: i64 = clock.next().unwrap_or("0").parse().ok()?;
    let minute: i64 = clock.next().unwrap_or("0").parse().ok()?;
    let second: i64 = clock.next().unwrap_or("0").parse().ok()?;
    if clock.next().is_some() || hour > 23 || minute > 59 || second > 60 {
        return None;
    }
    days_from_civil(year, month, day)
        .checked_mul(86_400)?
        .checked_add(hour * 3_600 + minute * 60 + second)
        .map(|utc| utc - offset)
}

/// Splits a trailing `±HH:MM`. Anything earlier than the time part is a date
/// hyphen, not a zone sign.
fn offset_split(value: &str) -> Option<(&str, i64)> {
    let index = value.rfind(['+', '-'])?;
    if index < 10 {
        return None;
    }
    let (stamp, tail) = value.split_at(index);
    let sign = tail.chars().next()?;
    let (hours, minutes) = tail[1..].split_once(':')?;
    let hours: i64 = hours.parse().ok()?;
    let minutes: i64 = minutes.parse().ok()?;
    let offset = hours * 3_600 + minutes * 60;
    Some((stamp, if sign == '-' { -offset } else { offset }))
}

fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let shifted = if month <= 2 { year - 1 } else { year };
    let era = if shifted < 0 { shifted - 399 } else { shifted } / 400;
    let year_of_era = shifted - era * 400;
    let month_part = if month > 2 { month - 3 } else { month + 9 };
    let day_of_year = (153 * month_part + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
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

    #[test]
    fn an_expiry_retires_only_notices_past_their_deadline() {
        let now = expiry_epoch("2026-11-01T00:00:00Z").unwrap();
        let items = parse_at(
            r#"[{"id":"live","expires":"2026-12-31T00:00:00Z"},
                {"id":"gone","expires":"2026-10-01T00:00:00Z"},
                {"id":"plain"}]"#,
            now,
        )
        .unwrap();
        let ids: Vec<&str> = items.iter().map(|item| item.id.as_str()).collect();
        assert_eq!(ids, vec!["live", "plain"]);
    }

    #[test]
    fn an_unreadable_expiry_keeps_the_notice() {
        let now = expiry_epoch("2026-11-01T00:00:00Z").unwrap();
        // Fail-open on purpose: a mistyped date must not silently swallow a
        // critical notice, which is the only failure nobody would notice.
        for value in [
            "tomorrow",
            "2026-13-45T00:00:00Z",
            "2026-11-32",
            "2026-11-01T25:00:00Z",
        ] {
            let text = format!(r#"[{{"id":"a","expires":"{value}"}}]"#);
            assert_eq!(parse_at(&text, now).unwrap().len(), 1, "{value}");
        }
    }

    #[test]
    fn zone_offsets_move_the_deadline() {
        // 00:00+08:00 is 16:00 UTC the day before, so 17:00Z is already past it.
        let in_tokyo = expiry_epoch("2026-11-01T00:00:00+08:00").unwrap();
        let in_utc = expiry_epoch("2026-11-01T00:00:00Z").unwrap();
        assert_eq!(in_tokyo + 8 * 3_600, in_utc);
        assert_eq!(
            expiry_epoch("2026-11-01T00:00:00-05:00").unwrap(),
            in_utc + 5 * 3_600
        );
        assert_eq!(expiry_epoch("2026-11-01").unwrap(), in_utc);
    }

    #[test]
    fn only_web_links_are_kept() {
        let items = parse_at(
            r#"[{"id":"a","url":"https://status.example.com/a"},
                {"id":"b","url":"javascript:alert(1)"},
                {"id":"c","link":"file:///C:/windows/system32/calc.exe"}]"#,
            0,
        )
        .unwrap();
        assert_eq!(items[0].url, "https://status.example.com/a");
        assert_eq!(items[1].url, "");
        assert_eq!(items[2].url, "");
    }
}
