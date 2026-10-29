//! Non-Bilibili video probing and download through the managed yt-dlp binary.

use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::services::jobs::JobContext;

#[derive(Debug, Clone, Deserialize)]
pub struct Info {
    pub title: String,
    #[serde(default)]
    pub uploader: Option<String>,
    #[serde(default)]
    pub duration: Option<f64>,
    #[serde(default)]
    pub webpage_url: Option<String>,
}

pub fn path() -> Result<PathBuf, String> {
    let root = crate::config::app_root();
    let candidates = [
        root.join("tools").join("ytdlp").join(exe_name()),
        root.join("tools").join(exe_name()),
        root.join("tools").join("yt-dlp").join(exe_name()),
    ];
    for candidate in candidates {
        if candidate.is_file() {
            return Ok(candidate);
        }
    }
    let paths = std::env::var_os("PATH")
        .ok_or_else(|| "未找到 yt-dlp：请先在视频页或设置中下载".to_string())?;
    std::env::split_paths(&paths)
        .map(|directory| directory.join(exe_name()))
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| "未找到 yt-dlp：请先在视频页或设置中下载".to_string())
}

pub fn probe(url: &str) -> Result<Info, String> {
    if !supported(url) {
        return Err("请输入 http(s) 视频链接".to_string());
    }
    let output = quiet_command(&path()?)
        .args([
            "-J",
            "--no-playlist",
            "--no-warnings",
            "--skip-download",
            url,
        ])
        .output()
        .map_err(|error| format!("启动 yt-dlp 失败：{error}"))?;
    if !output.status.success() {
        return Err(format!(
            "解析失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    parse_info(&output.stdout)
}

pub fn download(
    info: &Info,
    directory: &Path,
    base: &str,
    ctx: &JobContext,
) -> Result<PathBuf, String> {
    let url = info
        .webpage_url
        .as_deref()
        .ok_or_else(|| "yt-dlp 没有返回视频地址".to_string())?;
    std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let print_file = directory.join(format!(".yt-dlp-{}.path", std::process::id()));
    let _ = std::fs::remove_file(&print_file);
    let ffmpeg = crate::services::audio::ffmpeg_path()?;
    let ffmpeg_dir = ffmpeg
        .parent()
        .ok_or_else(|| "无法定位 ffmpeg 目录".to_string())?;
    let template = format!("{}.%(ext)s", directory.join(base).display());
    let mut child = quiet_command(&path()?)
        .args([
            "--newline",
            "--no-playlist",
            "--no-mtime",
            "--no-warnings",
            "-f",
            "bv*+ba/b",
            "--merge-output-format",
            "mp4",
            "--ffmpeg-location",
            ffmpeg_dir.to_string_lossy().as_ref(),
            "--print-to-file",
            "after_move:filepath",
            print_file.to_string_lossy().as_ref(),
            "-o",
            &template,
            url,
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("启动 yt-dlp 失败：{error}"))?;
    let stdout = child.stdout.take().expect("piped stdout");
    let (sender, receiver) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in std::io::BufReader::new(stdout)
            .lines()
            .map_while(Result::ok)
        {
            if sender.send(line).is_err() {
                return;
            }
        }
    });
    let stderr = child.stderr.take();
    let stderr_reader = std::thread::spawn(move || {
        let mut text = String::new();
        if let Some(mut pipe) = stderr {
            let _ = pipe.read_to_string(&mut text);
        }
        text
    });
    let started = Instant::now();
    let mut status = None;
    loop {
        if ctx.is_canceled() {
            terminate(&mut child);
            let _ = std::fs::remove_file(&print_file);
            return Err("已取消".to_string());
        }
        if started.elapsed() > Duration::from_secs(60 * 60 * 2) {
            terminate(&mut child);
            let _ = std::fs::remove_file(&print_file);
            return Err("下载超时".to_string());
        }
        match receiver.recv_timeout(Duration::from_millis(200)) {
            Ok(line) => {
                if let Some(fraction) = parse_progress(&line) {
                    ctx.progress(Some(0.02 + fraction * 0.9), line);
                } else {
                    ctx.log(line);
                }
            }
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if let Ok(Some(exit)) = child.try_wait() {
            status = Some(exit);
            break;
        }
    }
    let status = match status {
        Some(status) => status,
        None => child
            .wait()
            .map_err(|error| format!("等待 yt-dlp 失败：{error}"))?,
    };
    let stderr = stderr_reader.join().unwrap_or_default();
    if !status.success() {
        let _ = std::fs::remove_file(&print_file);
        return Err(format!("下载失败：{}", stderr.trim()));
    }
    let printed = std::fs::read_to_string(&print_file).ok();
    let _ = std::fs::remove_file(&print_file);
    let path = printed
        .as_deref()
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .filter(|path| path.is_file())
        .or_else(|| find_output(directory, base));
    let path = path.ok_or_else(|| "yt-dlp 完成但没有找到输出文件".to_string())?;
    ctx.progress(Some(1.0), "下载完成");
    Ok(path)
}

fn parse_info(bytes: &[u8]) -> Result<Info, String> {
    serde_json::from_slice(bytes).map_err(|error| format!("解析 yt-dlp 结果失败：{error}"))
}

fn parse_progress(line: &str) -> Option<f32> {
    let percent = line.split('%').next()?.split_whitespace().last()?;
    let value = percent.parse::<f32>().ok()?;
    (0.0..=100.0).contains(&value).then_some(value / 100.0)
}

fn find_output(directory: &Path, base: &str) -> Option<PathBuf> {
    let entries = std::fs::read_dir(directory).ok()?;
    let mut fallback = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = path.file_name()?.to_string_lossy();
        if !name.starts_with(base) {
            continue;
        }
        if path.extension().is_some_and(|ext| ext == "mp4") {
            return Some(path);
        }
        fallback = Some(path);
    }
    fallback
}

fn supported(url: &str) -> bool {
    url.starts_with("https://") || url.starts_with("http://")
}

fn exe_name() -> &'static str {
    if cfg!(windows) {
        "yt-dlp.exe"
    } else {
        "yt-dlp"
    }
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

fn terminate(child: &mut std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_yt_dlp_json_and_progress() {
        let info = parse_info(
            br#"{"id":"abc","title":"Song","uploader":"Artist","duration":12.5,"webpage_url":"https://example.com/v"}"#,
        )
        .unwrap();
        assert_eq!(info.title, "Song");
        assert_eq!(info.uploader.as_deref(), Some("Artist"));
        assert_eq!(parse_progress("[download]  42.5% of 10MiB"), Some(0.425));
        assert_eq!(parse_progress("[Merger] Merging"), None);
    }
}
