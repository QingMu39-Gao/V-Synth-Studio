//! NetEase Cloud Music search, lyrics, cover and song download.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::Value;

use crate::services::jobs::JobContext;

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const LOGIN_COOKIE_KEYS: [&str; 3] = ["MUSIC_U", "__csrf", "NMTID"];

static COOKIE: OnceLock<Mutex<Option<String>>> = OnceLock::new();

pub fn set_cookie(cookie: Option<String>) {
    let store = COOKIE.get_or_init(|| Mutex::new(None));
    *store.lock().unwrap_or_else(|error| error.into_inner()) = cookie;
}

pub fn logged_in() -> bool {
    COOKIE
        .get()
        .and_then(|store| {
            store
                .lock()
                .unwrap_or_else(|error| error.into_inner())
                .clone()
        })
        .is_some_and(|cookie| cookie.contains("MUSIC_U="))
}

pub fn cookie_from_pairs<'a>(pairs: impl Iterator<Item = (&'a str, &'a str)>) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut logged_in = false;
    for (name, value) in pairs {
        if !LOGIN_COOKIE_KEYS.contains(&name) {
            continue;
        }
        logged_in |= name == "MUSIC_U";
        let pair = format!("{name}={value}");
        if !parts.contains(&pair) {
            parts.push(pair);
        }
    }
    (logged_in && !parts.is_empty()).then(|| parts.join("; "))
}

fn cookie() -> Option<String> {
    COOKIE.get().and_then(|store| {
        store
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .clone()
    })
}

#[derive(Debug, Clone)]
pub struct SearchResult {
    pub id: u64,
    pub name: String,
    pub artists: Vec<String>,
    pub album: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone)]
pub struct SongDetail {
    pub id: u64,
    pub name: String,
    pub artists: Vec<String>,
    pub album: String,
    pub cover_url: String,
    pub duration_ms: u64,
}

#[derive(Debug, Clone, Default)]
pub struct Lyrics {
    pub lrc: String,
    pub translation: String,
}

pub fn search(query: &str, limit: usize) -> Result<Vec<SearchResult>, String> {
    let query = query.trim();
    if query.is_empty() {
        return Err("请输入搜索关键词".to_string());
    }
    let url = format!(
        "https://music.163.com/api/search/get/web?csrf_token=&s={}&type=1&offset=0&limit={}",
        urlencoding::encode(query),
        limit.clamp(1, 50)
    );
    let document = api_json(&url)?;
    let songs = document["result"]["songs"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    Ok(songs
        .iter()
        .filter_map(|song| {
            Some(SearchResult {
                id: song["id"].as_u64()?,
                name: song["name"].as_str()?.to_string(),
                artists: names(&song["artists"]),
                album: song["album"]["name"].as_str().unwrap_or("").to_string(),
                duration_ms: song["duration"].as_u64().unwrap_or(0),
            })
        })
        .collect())
}

pub fn detail(id: u64) -> Result<SongDetail, String> {
    let url = format!("https://music.163.com/api/song/detail/?id={id}&ids=%5B{id}%5D");
    let document = api_json(&url)?;
    let song = document["songs"]
        .as_array()
        .and_then(|songs| songs.first())
        .ok_or_else(|| "没有找到歌曲".to_string())?;
    Ok(SongDetail {
        id,
        name: song["name"].as_str().unwrap_or("").to_string(),
        artists: names(&song["artists"]),
        album: song["album"]["name"].as_str().unwrap_or("").to_string(),
        cover_url: song["album"]["picUrl"].as_str().unwrap_or("").to_string(),
        duration_ms: song["duration"].as_u64().unwrap_or(0),
    })
}

pub fn lyrics(id: u64) -> Result<Lyrics, String> {
    let url = format!("https://music.163.com/api/song/lyric?id={id}&lv=-1&kv=-1&tv=-1");
    let document = api_json(&url)?;
    let lrc = document["lrc"]["lyric"].as_str().unwrap_or("").to_string();
    if lrc.trim().is_empty() {
        return Err("这首歌没有可用歌词".to_string());
    }
    Ok(Lyrics {
        lrc,
        translation: document["tlyric"]["lyric"]
            .as_str()
            .unwrap_or("")
            .to_string(),
    })
}

pub fn download_cover(url: &str, directory: &Path, name: &str) -> Result<PathBuf, String> {
    if url.is_empty() {
        return Err("没有封面地址".to_string());
    }
    std::fs::create_dir_all(directory)
        .map_err(|error| format!("创建封面目录失败（{}）：{error}", directory.display()))?;
    let stem = sanitize_filename(name);
    let mut path = directory.join(format!("{stem}_cover.jpg"));
    let mut index = 1;
    while path.exists() {
        path = directory.join(format!("{stem}_cover-{index}.jpg"));
        index += 1;
    }
    let response = agent()
        .get(url)
        .header("User-Agent", USER_AGENT)
        .header("Referer", "https://music.163.com/")
        .call()
        .map_err(|error| format!("下载封面失败：{error}"))?;
    let mut bytes = Vec::new();
    response
        .into_body()
        .into_reader()
        .read_to_end(&mut bytes)
        .map_err(|error| format!("读取封面失败：{error}"))?;
    if bytes.is_empty() {
        return Err("封面为空".to_string());
    }
    std::fs::write(&path, bytes)
        .map_err(|error| format!("保存封面失败（{}）：{error}", path.display()))?;
    Ok(path)
}

/// Requested ceiling only: the server may silently hand back a lower tier, and
/// `Downloaded::level` reports what was actually received.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Quality {
    #[default]
    Auto,
    Lossless,
    Exhigh,
    Higher,
    Standard,
}

impl Quality {
    fn level(self) -> &'static str {
        match self {
            Quality::Auto => "hires",
            Quality::Lossless => "lossless",
            Quality::Exhigh => "exhigh",
            Quality::Higher => "higher",
            Quality::Standard => "standard",
        }
    }

    /// `encodeType` is mandatory; without it the endpoint returns no URL for
    /// most free accounts. Only lossless-or-above may ask for `flac` — asking
    /// `mp3` for `lossless` never yields a FLAC stream.
    fn encode_type(self) -> &'static str {
        match self {
            Quality::Auto | Quality::Lossless => "flac",
            Quality::Exhigh | Quality::Higher | Quality::Standard => "mp3",
        }
    }

    fn rank(self) -> i64 {
        match self {
            Quality::Auto => 4,
            Quality::Lossless => 3,
            Quality::Exhigh => 2,
            Quality::Higher => 1,
            Quality::Standard => 0,
        }
    }

    fn chain(self) -> Vec<Quality> {
        const ORDER: [Quality; 5] = [
            Quality::Auto,
            Quality::Lossless,
            Quality::Exhigh,
            Quality::Higher,
            Quality::Standard,
        ];
        let start = match self {
            Quality::Auto => 0,
            Quality::Lossless => 1,
            Quality::Exhigh => 2,
            Quality::Higher => 3,
            Quality::Standard => 4,
        };
        ORDER[start..].to_vec()
    }
}

#[derive(Debug, Clone)]
pub struct Downloaded {
    pub path: PathBuf,
    pub level: String,
    pub kbps: u64,
    pub downgraded: bool,
}

/// Fetch the direct URL and write the song to `directory/<stem>.<actual format>`.
///
/// `expected_ms` guards against a 30-second trial clip; 0 disables the check.
pub fn download(
    id: u64,
    directory: &Path,
    stem: &str,
    quality: Quality,
    expected_ms: u64,
    ctx: &JobContext,
) -> Result<Downloaded, String> {
    std::fs::create_dir_all(directory)
        .map_err(|error| format!("创建下载目录失败（{}）：{error}", directory.display()))?;
    ctx.progress(Some(0.02), "获取下载地址");
    let id_text = id.to_string();
    let mut media = Value::Null;
    for candidate in quality.chain() {
        let document = api_json(&media_url(&id_text, candidate))?;
        let got = document["data"]
            .as_array()
            .and_then(|items| items.first())
            .cloned()
            .unwrap_or(Value::Null);
        let usable = got["url"].as_str().is_some_and(|url| !url.is_empty());
        media = got;
        if usable {
            break;
        }
    }
    let direct = media["url"].as_str().unwrap_or("").to_string();
    if direct.is_empty() {
        return Err(no_direct_link_reason(&media));
    }

    let actual_level = media["level"].as_str().unwrap_or("").to_string();
    let br = media["br"].as_u64().unwrap_or(0);
    let declared_size = media["size"].as_i64().unwrap_or(0);
    let downgraded = downgraded(quality, &actual_level);

    let part = unique_part_path(directory, stem);
    ctx.progress(Some(0.08), "下载歌曲");
    let size = match fetch_to(&direct, &part, ctx) {
        Ok(size) => size,
        Err(error) => {
            let _ = std::fs::remove_file(&part);
            return Err(error);
        }
    };
    if size == 0 {
        return Err(discard(
            &part,
            "下载到的音频是空的（直链可能已失效，重试一次通常就好）",
        ));
    }

    let head = read_head(&part, 16);
    let Some(format) = audio_format(&head) else {
        return Err(discard(
            &part,
            "拿到的不是音频数据（直链可能已过期，重试一次通常就好）",
        ));
    };
    if declared_size > 0 && (size as i64 - declared_size).abs() > declared_size / 20 {
        return Err(discard(
            &part,
            &format!(
                "下到的文件不完整（拿到 {size} 字节，服务端声明 {declared_size} 字节），重试一次通常就好"
            ),
        ));
    }
    if let Some(reason) = duration_mismatch(size, br, expected_ms / 1000) {
        return Err(discard(&part, &reason));
    }

    ctx.progress(Some(0.98), "保存歌曲");
    let path = part.with_extension(format);
    std::fs::rename(&part, &path).map_err(|error| {
        let _ = std::fs::remove_file(&part);
        format!("保存歌曲失败：{error}")
    })?;
    ctx.log(format!(
        "输出：{}（{size} 字节，{} / {} kbps）",
        path.display(),
        actual_level,
        br / 1000
    ));
    ctx.progress(Some(1.0), "下载完成");
    Ok(Downloaded {
        path,
        level: actual_level,
        kbps: br / 1000,
        downgraded,
    })
}

fn media_url(id: &str, quality: Quality) -> String {
    format!(
        "https://music.163.com/api/song/enhance/player/url/v1?ids=%5B{id}%5D&level={}&encodeType={}",
        quality.level(),
        quality.encode_type()
    )
}

fn unique_part_path(directory: &Path, stem: &str) -> PathBuf {
    let stem = sanitize_filename(stem);
    let mut index = 0;
    loop {
        let name = if index == 0 {
            stem.clone()
        } else {
            format!("{stem}-{index}")
        };
        let taken = ["mp3", "flac", "m4a", "ogg"]
            .iter()
            .any(|extension| directory.join(format!("{name}.{extension}")).exists());
        if !taken {
            return directory.join(format!("{name}.part"));
        }
        index += 1;
    }
}

/// Ranged download without the account cookie: the CDN URL carries its own token.
fn fetch_to(url: &str, part: &Path, ctx: &JobContext) -> Result<u64, String> {
    let response = media_agent()
        .get(url)
        .header("User-Agent", USER_AGENT)
        .header("Referer", "https://music.163.com/")
        .call()
        .map_err(|error| format!("下载歌曲失败：{error}"))?;
    let total = response
        .body()
        .content_length()
        .filter(|length| *length > 0)
        .unwrap_or(0);
    let mut reader = response.into_body().into_reader();
    let mut file = std::fs::File::create(part)
        .map_err(|error| format!("创建临时文件失败（{}）：{error}", part.display()))?;
    let mut downloaded = 0u64;
    let mut reported = 0u64;
    let mut buffer = [0u8; 256 * 1024];
    loop {
        if ctx.is_canceled() {
            drop(file);
            let _ = std::fs::remove_file(part);
            return Err("已取消".to_string());
        }
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("下载歌曲失败：{error}"))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|error| format!("写入歌曲失败：{error}"))?;
        downloaded += read as u64;
        if downloaded - reported >= 256 * 1024 || total > 0 && downloaded >= total {
            reported = downloaded;
            let fraction = if total > 0 {
                0.08 + 0.88 * (downloaded as f32 / total as f32)
            } else {
                0.5
            };
            ctx.progress(
                Some(fraction),
                format!(
                    "下载歌曲 {:.1} / {:.1} MB",
                    downloaded as f64 / 1_000_000.0,
                    total as f64 / 1_000_000.0
                ),
            );
        }
    }
    file.flush()
        .map_err(|error| format!("写入歌曲失败：{error}"))?;
    Ok(downloaded)
}

fn discard(part: &Path, why: &str) -> String {
    let _ = std::fs::remove_file(part);
    why.to_string()
}

fn read_head(path: &Path, length: usize) -> Vec<u8> {
    let Ok(mut file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let mut buffer = vec![0u8; length];
    match file.read(&mut buffer) {
        Ok(read) => {
            buffer.truncate(read);
            buffer
        }
        Err(_) => Vec::new(),
    }
}

fn audio_format(head: &[u8]) -> Option<&'static str> {
    if head.len() < 4 {
        return None;
    }
    if head.starts_with(b"ID3") || (head[0] == 0xFF && head[1] & 0xE0 == 0xE0) {
        return Some("mp3");
    }
    if head.starts_with(b"fLaC") {
        return Some("flac");
    }
    if head.starts_with(b"OggS") {
        return Some("ogg");
    }
    if head.len() >= 8 && &head[4..8] == b"ftyp" {
        return Some("m4a");
    }
    None
}

fn duration_mismatch(bytes: u64, br: u64, expected_sec: u64) -> Option<String> {
    if br == 0 || bytes == 0 || expected_sec == 0 {
        return None;
    }
    let got = bytes as f64 * 8.0 / br as f64;
    if got < expected_sec as f64 * 0.85 {
        return Some(format!(
            "只拿到约 {} 秒音频（这首歌约 {expected_sec} 秒）。未登录或非会员有时只能试听，登录后重试，或换搜索结果里的另一个版本试试。",
            got.round() as i64
        ));
    }
    None
}

fn downgraded(quality: Quality, actual: &str) -> bool {
    quality != Quality::Auto && level_rank(actual) < quality.rank()
}

fn level_rank(level: &str) -> i64 {
    match level.trim().to_ascii_lowercase().as_str() {
        "standard" => 0,
        "higher" => 1,
        "exhigh" => 2,
        "lossless" | "sky" | "jyeffect" => 3,
        "hires" | "jymaster" => 4,
        _ => 99,
    }
}

fn no_direct_link_reason(media: &Value) -> String {
    let reason = media["freeTrialPrivilege"]["cannotListenReason"]
        .as_i64()
        .unwrap_or(0);
    let consumable = media["freeTrialPrivilege"]["userConsumable"]
        .as_bool()
        .unwrap_or(true);
    let code = media["code"].as_i64().unwrap_or(0);
    match reason {
        1 => "这首歌拿不到下载地址：版权或付费受限。登录后重试；如果登录后还是拿不到，换搜索结果里的另一个版本试试。".to_string(),
        2 => "这首歌只有会员能听，没有可下载的直链。换搜索结果里的另一个版本试试。".to_string(),
        _ if !consumable || code == -110 => {
            "这个版本网易云不给免费账号下载（要会员）。搜索结果里同一首歌往往有好几个版本，换一个能下的试试。".to_string()
        }
        _ => "网易云没有返回这首歌的下载地址（可能已下架，或需要登录）。".to_string(),
    }
}

pub fn decode_text(bytes: Vec<u8>) -> (String, bool) {
    match String::from_utf8(bytes.clone()) {
        Ok(text) => (text, false),
        Err(_) => {
            let (decoded, _, _) = encoding_rs::GBK.decode(&bytes);
            (decoded.into_owned(), true)
        }
    }
}

pub fn lrc_to_srt(lrc: &str) -> String {
    let mut entries = Vec::new();
    for line in lrc.lines() {
        let mut rest = line.trim_start();
        let mut stamps = Vec::new();
        while let Some(stamp) = rest.strip_prefix('[') {
            let Some(end) = stamp.find(']') else {
                break;
            };
            let tag = &stamp[..end];
            rest = &stamp[end + 1..];
            if let Some(seconds) = parse_timestamp(tag) {
                stamps.push(seconds);
            }
        }
        let text = rest.trim();
        for seconds in stamps {
            entries.push((seconds, text.to_string()));
        }
    }
    entries.sort_by(|left, right| left.0.total_cmp(&right.0));
    let mut output = String::new();
    for (index, (start, text)) in entries.iter().enumerate() {
        if text.is_empty() {
            continue;
        }
        let end = entries
            .iter()
            .skip(index + 1)
            .map(|entry| entry.0)
            .find(|time| *time > *start)
            .unwrap_or(*start + 4.0)
            .max(*start + 0.5);
        output.push_str(&format!(
            "{}\n{} --> {}\n{}\n\n",
            output.matches("-->").count() + 1,
            srt_time(*start),
            srt_time(end),
            text
        ));
    }
    output
}

fn names(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item["name"].as_str().map(str::to_string))
                .collect()
        })
        .unwrap_or_default()
}

fn parse_timestamp(tag: &str) -> Option<f64> {
    let mut parts = tag.split(':');
    let minutes: f64 = parts.next()?.parse().ok()?;
    let seconds: f64 = parts.next()?.parse().ok()?;
    Some(minutes * 60.0 + seconds)
}

fn srt_time(seconds: f64) -> String {
    let total_ms = (seconds.max(0.0) * 1000.0).round() as u64;
    let ms = total_ms % 1000;
    let total_seconds = total_ms / 1000;
    let secs = total_seconds % 60;
    let minutes = (total_seconds / 60) % 60;
    let hours = total_seconds / 3600;
    format!("{hours:02}:{minutes:02}:{secs:02},{ms:03}")
}

fn api_json(url: &str) -> Result<Value, String> {
    let mut request = agent()
        .get(url)
        .header("User-Agent", USER_AGENT)
        .header("Referer", "https://music.163.com/");
    if let Some(cookie) = cookie() {
        request = request.header("Cookie", cookie);
    }
    let response = request
        .call()
        .map_err(|error| format!("网易云接口请求失败：{error}"))?;
    let text = response
        .into_body()
        .read_to_string()
        .map_err(|error| format!("读取网易云接口失败：{error}"))?;
    serde_json::from_str(&text).map_err(|error| format!("解析网易云接口失败：{error}"))
}

fn agent() -> ureq::Agent {
    ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(20)))
            .timeout_recv_body(Some(Duration::from_secs(60)))
            .build(),
    )
}

fn media_agent() -> ureq::Agent {
    ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(20)))
            .timeout_recv_body(Some(Duration::from_secs(30 * 60)))
            .build(),
    )
}

fn sanitize_filename(name: &str) -> String {
    let mut output = name
        .chars()
        .map(|character| {
            if character.is_control() || "<>:\"/\\|?*".contains(character) {
                '_'
            } else {
                character
            }
        })
        .collect::<String>();
    output = output.trim().trim_matches('.').trim().to_string();
    if output.chars().count() > 80 {
        output = output.chars().take(80).collect();
    }
    if output.is_empty() {
        "lyrics".to_string()
    } else {
        output
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decodes_utf8_then_falls_back_to_gbk() {
        assert_eq!(
            decode_text("歌词".as_bytes().to_vec()),
            ("歌词".to_string(), false)
        );
        let (gbk, _, _) = encoding_rs::GBK.encode("歌词");
        assert_eq!(decode_text(gbk.into_owned()), ("歌词".to_string(), true));
    }

    #[test]
    fn converts_lrc_to_srt() {
        let srt =
            lrc_to_srt("[ti:Test]\n[00:01.00]First line\n[00:03.50][00:10.00]Later\n[00:07.00]");
        assert!(srt.contains("00:00:01,000 --> 00:00:03,500"));
        assert!(srt.contains("First line"));
        assert!(srt.contains("00:00:03,500 --> 00:00:07,000"));
        assert!(!srt.contains("00:00:07,000 --> 00:00:08,000\n\n"));
    }

    #[test]
    fn keeps_only_login_cookie_pairs() {
        let cookie = cookie_from_pairs(
            [
                ("MUSIC_U", "abc"),
                ("NMTID", "n"),
                ("__csrf", "c"),
                ("foo", "bar"),
            ]
            .into_iter(),
        )
        .expect("login cookie");
        assert_eq!(cookie, "MUSIC_U=abc; NMTID=n; __csrf=c");
        assert!(cookie_from_pairs([("foo", "bar")].into_iter()).is_none());
        assert!(cookie_from_pairs([("NMTID", "n"), ("__csrf", "c")].into_iter()).is_none());
    }

    #[test]
    fn quality_requests_flac_only_for_lossless_and_above() {
        assert_eq!(Quality::Auto.encode_type(), "flac");
        assert_eq!(Quality::Lossless.encode_type(), "flac");
        assert_eq!(Quality::Exhigh.encode_type(), "mp3");
        assert_eq!(
            Quality::Lossless.chain(),
            vec![
                Quality::Lossless,
                Quality::Exhigh,
                Quality::Higher,
                Quality::Standard
            ]
        );
        assert_eq!(Quality::Standard.chain(), vec![Quality::Standard]);
        assert!(media_url("7", Quality::Auto).contains("encodeType=flac"));
        assert!(media_url("7", Quality::Higher).contains("level=higher"));
    }

    #[test]
    fn ranks_reported_levels_for_downgrade_detection() {
        assert!(level_rank("exhigh") < Quality::Lossless.rank());
        assert!(level_rank("hires") > Quality::Lossless.rank());
        assert!(level_rank("something-new") > Quality::Auto.rank());
        assert!(downgraded(Quality::Lossless, "exhigh"));
        assert!(!downgraded(Quality::Exhigh, "exhigh"));
        assert!(!downgraded(Quality::Auto, "exhigh"));
    }

    #[test]
    fn recognizes_audio_containers_by_header() {
        assert_eq!(audio_format(b"ID3\x04\x00"), Some("mp3"));
        assert_eq!(audio_format(&[0xFF, 0xFB, 0x90, 0x64]), Some("mp3"));
        assert_eq!(audio_format(b"fLaC\x00\x00"), Some("flac"));
        assert_eq!(audio_format(b"OggS\x00\x00"), Some("ogg"));
        assert_eq!(audio_format(b"\x00\x00\x00\x20ftypM4A "), Some("m4a"));
        assert_eq!(audio_format(b"<html>"), None);
    }

    #[test]
    fn rejects_a_trial_clip_by_duration() {
        assert!(duration_mismatch(1_200_000, 320_000, 200).is_some());
        assert!(duration_mismatch(8_000_000, 320_000, 200).is_none());
        assert!(duration_mismatch(0, 320_000, 200).is_none());
        assert!(duration_mismatch(8_000_000, 0, 200).is_none());
    }

    #[test]
    fn explains_missing_direct_link() {
        let restricted =
            serde_json::json!({"code": -110, "freeTrialPrivilege": {"userConsumable": false}});
        assert!(no_direct_link_reason(&restricted).contains("会员"));
    }

    #[test]
    #[ignore = "requires network access and downloads a public song"]
    fn downloads_a_public_song() {
        use crate::services::jobs::{JobOutcome, Jobs};

        let directory =
            std::env::temp_dir().join(format!("vss-lyrics-song-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&directory);
        let work = directory.clone();
        let (jobs, _events) = Jobs::new();
        let job = jobs.start("lyrics download", move |ctx| {
            download(
                478_507_889,
                &work,
                "canon-test",
                Quality::Auto,
                300_751,
                &ctx,
            )
        });
        let got = match job.result.recv_blocking().expect("job result") {
            JobOutcome::Done(got) => got,
            JobOutcome::Failed(error) => panic!("download failed: {error}"),
            JobOutcome::Canceled => panic!("download canceled"),
        };
        assert!(got.path.exists());
        assert!(audio_format(&read_head(&got.path, 4)).is_some());
        let _ = std::fs::remove_dir_all(&directory);
    }

    #[test]
    #[ignore = "requires network access to music.163.com"]
    fn searches_and_reads_lyrics() {
        let results = search("Never Gonna Give You Up", 5).unwrap();
        assert!(!results.is_empty());
        let song = detail(results[0].id).unwrap();
        assert!(!song.name.is_empty());
        let lyrics = lyrics(results[0].id).unwrap();
        assert!(lyrics.lrc.contains('['));
    }
}
