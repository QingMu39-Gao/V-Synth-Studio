//! Bilibili video metadata, stream resolution and DASH download.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use serde_json::Value;

use crate::services::jobs::JobContext;

const USER_AGENT: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const LOGIN_COOKIE_KEYS: [&str; 5] = [
    "SESSDATA",
    "bili_jct",
    "DedeUserID",
    "DedeUserID__ckMd5",
    "sid",
];

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
        .is_some_and(|cookie| cookie.contains("SESSDATA="))
}

pub fn cookie_from_pairs<'a>(pairs: impl Iterator<Item = (&'a str, &'a str)>) -> Option<String> {
    let mut parts: Vec<String> = Vec::new();
    for (name, value) in pairs {
        if !LOGIN_COOKIE_KEYS.contains(&name) {
            continue;
        }
        let pair = format!("{name}={value}");
        if !parts.contains(&pair) {
            parts.push(pair);
        }
    }
    (!parts.is_empty()).then(|| parts.join("; "))
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
pub struct Page {
    pub cid: u64,
    pub page: u64,
    pub part: String,
    pub duration: u64,
}

#[derive(Debug, Clone)]
pub struct Quality {
    pub qn: u32,
    pub label: String,
}

#[derive(Debug, Clone)]
pub struct ParsedVideo {
    pub bvid: String,
    pub title: String,
    pub owner: String,
    pub duration: u64,
    pub pages: Vec<Page>,
    pub page_index: usize,
    pub qualities: Vec<Quality>,
}

#[derive(Debug, Clone)]
pub struct Streams {
    pub video_url: String,
    pub audio_url: Option<String>,
    pub durl_url: Option<String>,
}

struct Target {
    bvid: Option<String>,
    aid: Option<u64>,
    page: usize,
}

pub fn parse(input: &str) -> Result<ParsedVideo, String> {
    let target = parse_target(input)?;
    let url = match (&target.bvid, target.aid) {
        (Some(bvid), _) => format!("https://api.bilibili.com/x/web-interface/view?bvid={bvid}"),
        (None, Some(aid)) => {
            format!("https://api.bilibili.com/x/web-interface/view?aid={aid}")
        }
        _ => return Err("无法识别 BV 号或 av 号".to_string()),
    };
    let document = api_json(&url)?;
    let data = &document["data"];
    let bvid = data["bvid"].as_str().unwrap_or("").to_string();
    if bvid.is_empty() {
        return Err("接口没有返回 BV 号".to_string());
    }
    let pages = data["pages"]
        .as_array()
        .map(|pages| {
            pages
                .iter()
                .filter_map(|page| {
                    Some(Page {
                        cid: page["cid"].as_u64()?,
                        page: page["page"].as_u64().unwrap_or(1),
                        part: page["part"].as_str().unwrap_or("").to_string(),
                        duration: page["duration"].as_u64().unwrap_or(0),
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let pages = if pages.is_empty() {
        vec![Page {
            cid: data["cid"].as_u64().ok_or("接口没有返回 cid")?,
            page: 1,
            part: String::new(),
            duration: data["duration"].as_u64().unwrap_or(0),
        }]
    } else {
        pages
    };
    let page_index = target.page.saturating_sub(1).min(pages.len() - 1);
    let qualities = qualities_for(&bvid, pages[page_index].cid).unwrap_or_default();
    Ok(ParsedVideo {
        bvid,
        title: data["title"].as_str().unwrap_or("未命名视频").to_string(),
        owner: data["owner"]["name"].as_str().unwrap_or("").to_string(),
        duration: data["duration"].as_u64().unwrap_or(0),
        pages,
        page_index,
        qualities,
    })
}

pub fn qualities_for(bvid: &str, cid: u64) -> Result<Vec<Quality>, String> {
    let url = playurl_url(bvid, cid, 80);
    let document = api_json(&url)?;
    let data = &document["data"];
    let qualities = data["accept_quality"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let descriptions = data["accept_description"]
        .as_array()
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let mut result = qualities
        .iter()
        .enumerate()
        .filter_map(|(index, qn)| {
            let qn = qn.as_u64()? as u32;
            let label = descriptions
                .get(index)
                .and_then(|label| label.as_str())
                .unwrap_or("")
                .to_string();
            Some(Quality { qn, label })
        })
        .collect::<Vec<_>>();
    if result.is_empty() {
        result = vec![
            Quality {
                qn: 80,
                label: "1080P".to_string(),
            },
            Quality {
                qn: 64,
                label: "720P".to_string(),
            },
            Quality {
                qn: 32,
                label: "480P".to_string(),
            },
            Quality {
                qn: 16,
                label: "360P".to_string(),
            },
        ];
    }
    Ok(result)
}

pub fn resolve(bvid: &str, cid: u64, qn: u32) -> Result<Streams, String> {
    let document = api_json(&playurl_url(bvid, cid, qn))?;
    let data = &document["data"];
    if let Some(durl) = data["durl"]
        .as_array()
        .and_then(|items| items.first())
        .and_then(|item| item["url"].as_str())
    {
        return Ok(Streams {
            video_url: absolute_url(durl),
            audio_url: None,
            durl_url: Some(absolute_url(durl)),
        });
    }
    let videos = data["dash"]["video"]
        .as_array()
        .ok_or_else(|| "接口没有返回 DASH 视频流".to_string())?;
    let mut candidates = videos
        .iter()
        .filter_map(|video| {
            Some((
                video["id"].as_u64()? as u32,
                video["bandwidth"].as_u64().unwrap_or(0),
                stream_url(video)?,
            ))
        })
        .collect::<Vec<_>>();
    if candidates.is_empty() {
        return Err("接口没有返回可下载的视频流".to_string());
    }
    candidates.sort_by_key(|(id, bandwidth, _)| (*id, *bandwidth));
    let selected = candidates
        .iter()
        .filter(|(id, _, _)| *id <= qn)
        .max_by_key(|(id, bandwidth, _)| (*id, *bandwidth))
        .or_else(|| candidates.last())
        .expect("non-empty");
    let audio = data["dash"]["audio"].as_array().and_then(|audios| {
        audios
            .iter()
            .filter_map(|audio| {
                Some((audio["bandwidth"].as_u64().unwrap_or(0), stream_url(audio)?))
            })
            .max_by_key(|(bandwidth, _)| *bandwidth)
            .map(|(_, url)| url)
    });
    Ok(Streams {
        video_url: selected.2.clone(),
        audio_url: audio,
        durl_url: None,
    })
}

pub fn download(
    bvid: &str,
    cid: u64,
    qn: u32,
    output: &Path,
    ctx: &JobContext,
) -> Result<(), String> {
    download_with(
        bvid,
        cid,
        qn,
        output,
        |fraction, message| ctx.progress(fraction, message),
        |line| ctx.log(line),
        || ctx.is_canceled(),
    )
}

pub(crate) fn download_with<P, L, C>(
    bvid: &str,
    cid: u64,
    qn: u32,
    output: &Path,
    mut progress: P,
    mut log: L,
    canceled: C,
) -> Result<(), String>
where
    P: FnMut(Option<f32>, &str),
    L: FnMut(String),
    C: Fn() -> bool,
{
    let result = download_inner(bvid, cid, qn, output, &mut progress, &mut log, &canceled);
    if result.is_err() {
        let _ = std::fs::remove_file(output);
        let _ = std::fs::remove_file(temp_path(output, "video"));
        let _ = std::fs::remove_file(temp_path(output, "audio"));
        let _ = std::fs::remove_file(temp_path(output, "source"));
    }
    result
}

fn download_inner<P, L, C>(
    bvid: &str,
    cid: u64,
    qn: u32,
    output: &Path,
    progress: &mut P,
    log: &mut L,
    canceled: &C,
) -> Result<(), String>
where
    P: FnMut(Option<f32>, &str),
    L: FnMut(String),
    C: Fn() -> bool,
{
    if output.exists() {
        return Err(format!("输出文件已存在：{}", output.display()));
    }
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建输出目录失败（{}）：{error}", parent.display()))?;
    }
    progress(Some(0.02), "解析视频流");
    let streams = resolve(bvid, cid, qn)?;
    let video_temp = temp_path(output, "video");
    let audio_temp = temp_path(output, "audio");
    let source_temp = temp_path(output, "source");

    if streams.durl_url.is_some() {
        fetch_to(
            &streams.video_url,
            &source_temp,
            progress,
            canceled,
            0.05,
            0.85,
            "下载视频",
        )?;
        progress(Some(0.9), "封装 MP4");
        merge(&[source_temp.as_path()], output)?;
    } else {
        fetch_to(
            &streams.video_url,
            &video_temp,
            progress,
            canceled,
            0.05,
            0.6,
            "下载视频",
        )?;
        if let Some(audio_url) = &streams.audio_url {
            fetch_to(
                audio_url,
                &audio_temp,
                progress,
                canceled,
                0.65,
                0.25,
                "下载音频",
            )?;
        }
        progress(Some(0.92), "合并音视频");
        let inputs = if streams.audio_url.is_some() {
            vec![video_temp.as_path(), audio_temp.as_path()]
        } else {
            vec![video_temp.as_path()]
        };
        merge(&inputs, output)?;
    }
    let size = std::fs::metadata(output)
        .map(|meta| meta.len())
        .unwrap_or(0);
    if size == 0 {
        return Err("没有生成视频文件".to_string());
    }
    let _ = std::fs::remove_file(video_temp);
    let _ = std::fs::remove_file(audio_temp);
    let _ = std::fs::remove_file(source_temp);
    progress(Some(1.0), "下载完成");
    log(format!("输出：{}（{size} 字节）", output.display()));
    Ok(())
}

fn fetch_to<P, C>(
    url: &str,
    path: &Path,
    progress: &mut P,
    canceled: &C,
    base: f32,
    span: f32,
    label: &str,
) -> Result<u64, String>
where
    P: FnMut(Option<f32>, &str),
    C: Fn() -> bool,
{
    let agent = agent();
    let mut request = agent
        .get(url)
        .header("User-Agent", USER_AGENT)
        .header("Referer", "https://www.bilibili.com/");
    if let Some(cookie) = cookie() {
        request = request.header("Cookie", cookie);
    }
    let response = request
        .call()
        .map_err(|error| format!("{label}失败：{error}"))?;
    let total = response
        .body()
        .content_length()
        .filter(|length| *length > 0)
        .unwrap_or(0);
    let mut reader = response.into_body().into_reader();
    let mut file = std::fs::File::create(path)
        .map_err(|error| format!("创建临时文件失败（{}）：{error}", path.display()))?;
    let mut downloaded = 0u64;
    let mut reported = 0u64;
    let mut buffer = [0u8; 256 * 1024];
    loop {
        if canceled() {
            drop(file);
            let _ = std::fs::remove_file(path);
            return Err("已取消".to_string());
        }
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("{label}失败：{error}"))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|error| format!("写入视频失败：{error}"))?;
        downloaded += read as u64;
        if downloaded - reported >= 1024 * 1024 || total > 0 && downloaded >= total {
            reported = downloaded;
            let fraction = if total > 0 {
                base + span * (downloaded as f32 / total as f32)
            } else {
                base
            };
            progress(
                Some(fraction.clamp(0.0, 0.99)),
                &format!(
                    "{} {:.1} / {:.1} MB",
                    label,
                    downloaded as f64 / 1_000_000.0,
                    total as f64 / 1_000_000.0
                ),
            );
        }
    }
    file.flush()
        .map_err(|error| format!("写入视频失败：{error}"))?;
    Ok(downloaded)
}

fn merge(inputs: &[&Path], output: &Path) -> Result<(), String> {
    let ffmpeg = crate::services::audio::ffmpeg_path()?;
    let mut command = quiet_command(&ffmpeg);
    command.args(["-hide_banner", "-nostdin", "-y"]);
    for input in inputs {
        command.arg("-i").arg(input);
    }
    command
        .args(["-c", "copy", "-movflags", "+faststart"])
        .arg(output);
    let result = command
        .output()
        .map_err(|error| format!("启动 ffmpeg 合并失败：{error}"))?;
    if !result.status.success() {
        return Err(format!(
            "ffmpeg 合并失败：{}",
            String::from_utf8_lossy(&result.stderr).trim()
        ));
    }
    Ok(())
}

fn api_json(url: &str) -> Result<Value, String> {
    let mut request = agent()
        .get(url)
        .header("User-Agent", USER_AGENT)
        .header("Referer", "https://www.bilibili.com/");
    if let Some(cookie) = cookie() {
        request = request.header("Cookie", cookie);
    }
    let response = request
        .call()
        .map_err(|error| format!("B 站接口请求失败：{error}"))?;
    let text = response
        .into_body()
        .read_to_string()
        .map_err(|error| format!("读取 B 站接口失败：{error}"))?;
    let document: Value =
        serde_json::from_str(&text).map_err(|error| format!("解析 B 站接口失败：{error}"))?;
    let code = document["code"].as_i64().unwrap_or(0);
    if code != 0 {
        let message = document["message"].as_str().unwrap_or("未知错误");
        return Err(format!("B 站接口错误 {code}：{message}"));
    }
    Ok(document)
}

fn agent() -> ureq::Agent {
    ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(20)))
            .timeout_recv_body(Some(Duration::from_secs(30 * 60)))
            .build(),
    )
}

fn playurl_url(bvid: &str, cid: u64, qn: u32) -> String {
    format!(
        "https://api.bilibili.com/x/player/playurl?bvid={bvid}&cid={cid}&qn={qn}&fnval=4048&fourk=1"
    )
}

fn stream_url(value: &Value) -> Option<String> {
    value["baseUrl"]
        .as_str()
        .or_else(|| value["base_url"].as_str())
        .map(absolute_url)
}

fn absolute_url(url: &str) -> String {
    if url.starts_with("//") {
        format!("https:{url}")
    } else {
        url.to_string()
    }
}

fn temp_path(output: &Path, kind: &str) -> PathBuf {
    let stem = output
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_else(|| "video".to_string());
    output
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join(format!(".{stem}.{kind}"))
}

pub fn is_bilibili_input(input: &str) -> bool {
    let text = input.trim();
    let lower = text.to_ascii_lowercase();
    let direct =
        text.starts_with("BV") || lower.starts_with("av") || lower.contains("bilibili.com");
    direct && parse_target(text).is_ok()
}
fn parse_target(input: &str) -> Result<Target, String> {
    let text = input.trim();
    if text.is_empty() {
        return Err("请输入视频链接或 BV 号".to_string());
    }
    let page = text
        .split(['?', '&'])
        .find_map(|part| part.strip_prefix("p="))
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(1);
    let bvid = extract_bvid(text);
    let aid = extract_aid(text);
    if bvid.is_none() && aid.is_none() {
        return Err("无法识别 BV 号或 av 号（暂不支持短链）".to_string());
    }
    Ok(Target { bvid, aid, page })
}

fn extract_bvid(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    for index in 0..bytes.len().saturating_sub(1) {
        if &bytes[index..index + 2] == b"BV" {
            let candidate = text.get(index..index + 12)?;
            if candidate
                .chars()
                .all(|character| character.is_ascii_alphanumeric())
            {
                return Some(candidate.to_string());
            }
        }
    }
    None
}

fn extract_aid(text: &str) -> Option<u64> {
    let lower = text.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    for index in 0..bytes.len().saturating_sub(1) {
        if &bytes[index..index + 2] == b"av" {
            let digits = lower[index + 2..]
                .chars()
                .take_while(|character| character.is_ascii_digit())
                .collect::<String>();
            if !digits.is_empty() {
                return digits.parse().ok();
            }
        }
    }
    None
}

fn quiet_command(program: &Path) -> Command {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut command = Command::new(program);
        command.creation_flags(CREATE_NO_WINDOW);
        command
    }
    #[cfg(not(windows))]
    {
        Command::new(program)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_only_login_cookies_and_deduplicates() {
        let cookie = cookie_from_pairs(
            [
                ("buvid3", "device"),
                ("SESSDATA", "abc%2C123"),
                ("SESSDATA", "abc%2C123"),
                ("bili_jct", "token"),
            ]
            .into_iter(),
        )
        .unwrap();
        assert_eq!(cookie, "SESSDATA=abc%2C123; bili_jct=token");
        assert!(cookie_from_pairs([("buvid3", "x")].into_iter()).is_none());
    }

    #[test]
    fn recognizes_bvid_aid_and_page() {
        let target = parse_target("https://www.bilibili.com/video/BV1GJ411x7h7?p=2").unwrap();
        assert_eq!(target.bvid.as_deref(), Some("BV1GJ411x7h7"));
        assert_eq!(target.page, 2);
        assert_eq!(parse_target("av80433022").unwrap().aid, Some(80433022));
        assert!(parse_target("https://b23.tv/abc").is_err());
    }

    #[test]
    #[ignore = "requires network access to api.bilibili.com and the video CDN"]
    fn parses_a_public_video() {
        let video = parse("BV1GJ411x7h7").unwrap();
        assert!(video.title.contains("Never Gonna Give You Up"));
        assert!(!video.qualities.is_empty());
        assert_eq!(video.pages.len(), 1);
        assert!(video.pages[0].cid > 0);
    }

    #[test]
    #[ignore = "downloads a public video and writes to a temp directory"]
    fn downloads_a_public_video() {
        let video = parse("BV1GJ411x7h7").unwrap();
        let page = video.pages.first().expect("page");
        let quality = video
            .qualities
            .iter()
            .map(|quality| quality.qn)
            .min()
            .unwrap_or(16);
        let dir = std::env::temp_dir().join(format!("vss-bili-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let output = dir.join("test.mp4");
        download_with(
            &video.bvid,
            page.cid,
            quality,
            &output,
            |_, _| {},
            |line| println!("{line}"),
            || false,
        )
        .unwrap();
        assert!(std::fs::metadata(&output).unwrap().len() > 100_000);
        let info = crate::services::audio::probe(&output).unwrap();
        assert!(info.duration > 200.0);
        let _ = std::fs::remove_dir_all(dir);
    }
}
