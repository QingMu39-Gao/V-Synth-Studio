//! 随包外部工具与系统 python 的探测。
//!
//! 路径判据：`tools/ffmpeg/bin/ffmpeg`、`tools/yt-dlp`，找不到再走 PATH。
//! 这里不启动任何服务；探测只在后台线程跑一次，结果给总览页显示。

use std::path::{Path, PathBuf};
use std::process::{Command, Output};

#[derive(Debug, Clone, Default)]
pub struct Tool {
    pub available: bool,
    pub path: Option<String>,
    pub version: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ToolStatus {
    pub ffmpeg: Tool,
    pub ytdlp: Tool,
    pub python: Tool,
}

impl ToolStatus {
    pub fn ready_count(&self) -> usize {
        [&self.ffmpeg, &self.ytdlp, &self.python]
            .into_iter()
            .filter(|tool| tool.available)
            .count()
    }
}

pub fn detect_with<F, C>(root: &Path, mut progress: F, canceled: C) -> Result<ToolStatus, String>
where
    F: FnMut(Option<f32>, &str),
    C: Fn() -> bool,
{
    progress(Some(0.05), "查找 Python");
    if canceled() {
        return Err("检测已取消".to_string());
    }
    let python_path = find_binary("python", &[])
        .or_else(|| find_binary("python3", &[]))
        .or_else(|| find_binary("py", &[]));
    progress(Some(0.2), "探测 Python");
    let python = match &python_path {
        Some(path) => probe(path, &["--version"], VersionStyle::Plain),
        None => Tool::default(),
    };
    if canceled() {
        return Err("检测已取消".to_string());
    }

    progress(Some(0.4), "探测 ffmpeg");
    let ffmpeg = match find_binary(
        "ffmpeg",
        &[
            root.join("tools").join("ffmpeg").join("bin"),
            root.join("tools"),
        ],
    ) {
        Some(path) => probe(&path, &["-version"], VersionStyle::Ffmpeg),
        None => Tool::default(),
    };
    if canceled() {
        return Err("检测已取消".to_string());
    }

    progress(Some(0.7), "探测 yt-dlp");
    let ytdlp = match find_binary(
        "yt-dlp",
        &[root.join("tools"), root.join("tools").join("ytdlp")],
    ) {
        Some(path) => probe(&path, &["--version"], VersionStyle::Plain),
        None => python_path
            .as_deref()
            .and_then(probe_python_ytdlp)
            .unwrap_or_default(),
    };
    if canceled() {
        return Err("检测已取消".to_string());
    }

    progress(Some(1.0), "检测完成");
    Ok(ToolStatus {
        ffmpeg,
        ytdlp,
        python,
    })
}

fn probe_python_ytdlp(python: &Path) -> Option<Tool> {
    let output = quiet_command(python)
        .args(["-m", "yt_dlp", "--version"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let text = output_text(output);
    Some(Tool {
        available: true,
        path: Some(format!("{} -m yt_dlp", python.display())),
        version: Some(text.trim().to_string()).filter(|text| !text.is_empty()),
    })
}

fn probe(path: &Path, args: &[&str], style: VersionStyle) -> Tool {
    let Ok(output) = quiet_command(path).args(args).output() else {
        return Tool::default();
    };
    if !output.status.success() {
        return Tool::default();
    }
    let text = output_text(output);
    Tool {
        available: true,
        path: Some(path.display().to_string()),
        version: parse_version(&text, style),
    }
}

enum VersionStyle {
    Plain,
    Ffmpeg,
}

fn parse_version(text: &str, style: VersionStyle) -> Option<String> {
    let version = match style {
        VersionStyle::Plain => text.trim(),
        VersionStyle::Ffmpeg => text.lines().next()?.split_whitespace().nth(2)?,
    };
    (!version.is_empty()).then(|| version.to_string())
}

fn output_text(output: Output) -> String {
    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    if stdout.trim().is_empty() {
        String::from_utf8_lossy(&output.stderr).to_string()
    } else {
        stdout
    }
}

fn find_binary(name: &str, extra_dirs: &[PathBuf]) -> Option<PathBuf> {
    let file = exe_name(name);
    for dir in extra_dirs {
        let path = dir.join(&file);
        if path.is_file() {
            return Some(path);
        }
    }

    let paths = std::env::var_os("PATH")?;
    std::env::split_paths(&paths)
        .map(|dir| dir.join(&file))
        .find(|path| path.is_file())
}

fn exe_name(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ffmpeg_version_from_first_line() {
        let text = "ffmpeg version 8.1.1 Copyright (c) 2000-2026 the FFmpeg developers\n";
        assert_eq!(
            parse_version(text, VersionStyle::Ffmpeg).as_deref(),
            Some("8.1.1")
        );
    }

    #[test]
    fn trims_plain_version_output() {
        assert_eq!(
            parse_version("2026.08.19\r\n", VersionStyle::Plain).as_deref(),
            Some("2026.08.19")
        );
    }

    #[test]
    fn cancellation_is_checked_before_probing() {
        let error = detect_with(std::env::temp_dir().as_path(), |_, _| {}, || true).unwrap_err();
        assert_eq!(error, "检测已取消");
    }

    #[test]
    fn prefers_extra_directories_over_path() {
        let dir = std::env::temp_dir().join(format!(
            "vss-tools-test-{}-{}",
            std::process::id(),
            std::line!()
        ));
        std::fs::create_dir_all(&dir).unwrap();
        let binary = dir.join(exe_name("vss-probe-test"));
        std::fs::write(&binary, b"").unwrap();

        assert_eq!(
            find_binary("vss-probe-test", std::slice::from_ref(&dir)),
            Some(binary)
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
