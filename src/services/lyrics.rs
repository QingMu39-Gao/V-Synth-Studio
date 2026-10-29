//! NetEase Cloud Music search, lyrics and cover download.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::Value;

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

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
    let response = agent()
        .get(url)
        .header("User-Agent", USER_AGENT)
        .header("Referer", "https://music.163.com/")
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
