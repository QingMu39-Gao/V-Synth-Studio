//! Detection of external tools that may already exist outside the app.

use std::path::{Path, PathBuf};
use std::process::Command;

#[derive(Debug, Clone, Default)]
pub struct Tool {
    pub available: bool,
    pub path: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct ToolStatus {
    pub ffmpeg: Tool,
    pub ytdlp: Tool,
}

pub fn detect_with<F, C>(root: &Path, mut progress: F, canceled: C) -> Result<ToolStatus, String>
where
    F: FnMut(Option<f32>, &str),
    C: Fn() -> bool,
{
    progress(Some(0.1), "探测 ffmpeg");
    let ffmpeg = match find_binary(
        "ffmpeg",
        &[
            root.join("tools").join("ffmpeg").join("bin"),
            root.join("tools"),
        ],
    ) {
        Some(path) => probe(&path, &["-version"]),
        None => Tool::default(),
    };
    if canceled() {
        return Err("检测已取消".to_string());
    }

    progress(Some(0.6), "探测 yt-dlp");
    let ytdlp = match find_binary(
        "yt-dlp",
        &[root.join("tools"), root.join("tools").join("ytdlp")],
    ) {
        Some(path) => probe(&path, &["--version"]),
        None => Tool::default(),
    };
    if canceled() {
        return Err("检测已取消".to_string());
    }

    progress(Some(1.0), "检测完成");
    Ok(ToolStatus { ffmpeg, ytdlp })
}

fn probe(path: &Path, args: &[&str]) -> Tool {
    let Ok(output) = quiet_command(path).args(args).output() else {
        return Tool::default();
    };
    Tool {
        available: output.status.success(),
        path: Some(path.display().to_string()),
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
