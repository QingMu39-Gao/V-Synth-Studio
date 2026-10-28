//! LibreSVIP CLI orchestration.
//!
//! The CLI prompts for conversion options on stdout and expects the value shown
//! in the trailing `(default)` for each prompt. Prompts are byte-matched so
//! Chinese Windows ANSI output does not have to be decoded first.

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::services::jobs::JobContext;

const MAX_ANSWERS: usize = 120;
const MAX_RUNTIME: Duration = Duration::from_secs(15 * 60);

pub fn cli_path(root: &Path) -> Result<PathBuf, String> {
    let path = root.join("tools").join("libresvip").join(if cfg!(windows) {
        "libresvip-cli.exe"
    } else {
        "libresvip-cli"
    });
    path.is_file()
        .then_some(path.clone())
        .ok_or_else(|| format!("找不到 LibreSVIP CLI：{}", path.display()))
}

pub(crate) fn convert_with<P, L, C>(
    input: &Path,
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
    if !input.is_file() {
        return Err(format!("输入文件不存在：{}", input.display()));
    }
    if output.exists() {
        return Err(format!("输出文件已存在：{}", output.display()));
    }
    if let Some(parent) = output.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| format!("创建输出目录失败（{}）：{error}", parent.display()))?;
    }
    if canceled() {
        return Err("已取消".to_string());
    }

    let root = crate::config::app_root();
    let cli = cli_path(&root)?;
    progress(Some(0.1), "启动 LibreSVIP");
    let mut command = Command::new(&cli);
    command
        .arg("proj")
        .arg("convert")
        .arg(input)
        .arg(output)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("PYTHONIOENCODING", "utf-8")
        .env("PYTHONUTF8", "1");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    log(format!("转换：{}", input.display()));
    let mut child = command
        .spawn()
        .map_err(|error| format!("启动 LibreSVIP 失败：{error}"))?;
    let mut stdin = child.stdin.take().expect("piped stdin");

    let (events, receiver) = mpsc::channel::<Event>();
    let mut open_streams: usize = 0;
    if let Some(stdout) = child.stdout.take() {
        open_streams += 1;
        spawn_reader(stdout, Event::Stdout, events.clone());
    }
    if let Some(stderr) = child.stderr.take() {
        open_streams += 1;
        spawn_reader(stderr, Event::Stderr, events.clone());
    }
    drop(events);

    progress(Some(0.2), "转换中");
    let started = Instant::now();
    let mut stdout_buffer = Vec::new();
    let mut stderr_tail = Vec::new();
    let mut answers = 0usize;
    let mut status = None;

    while open_streams > 0 {
        if canceled() {
            terminate(&mut child);
            let _ = std::fs::remove_file(output);
            return Err("已取消".to_string());
        }
        if started.elapsed() > MAX_RUNTIME {
            terminate(&mut child);
            let _ = std::fs::remove_file(output);
            return Err("LibreSVIP 转换超时".to_string());
        }
        match receiver.recv_timeout(Duration::from_millis(200)) {
            Ok(Event::Stdout(bytes)) => {
                stdout_buffer.extend_from_slice(&bytes);
                while let Some((answer, consumed)) = extract_prompt(&stdout_buffer) {
                    if answers >= MAX_ANSWERS {
                        terminate(&mut child);
                        return Err("LibreSVIP 选项过多，已中止".to_string());
                    }
                    answers += 1;
                    stdin
                        .write_all(answer.as_bytes())
                        .and_then(|_| stdin.write_all(b"\n"))
                        .and_then(|_| stdin.flush())
                        .map_err(|error| format!("写入 LibreSVIP 选项失败：{error}"))?;
                    stdout_buffer.drain(..consumed);
                }
            }
            Ok(Event::Stderr(bytes)) => {
                stderr_tail.extend_from_slice(&bytes);
                if stderr_tail.len() > 16 * 1024 {
                    let excess = stderr_tail.len() - 16 * 1024;
                    stderr_tail.drain(..excess);
                }
            }
            Ok(Event::Eof) => open_streams = open_streams.saturating_sub(1),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
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
            .map_err(|error| format!("等待 LibreSVIP 退出失败：{error}"))?,
    };
    if !status.success() {
        let _ = std::fs::remove_file(output);
        let message = String::from_utf8_lossy(&stderr_tail).trim().to_string();
        return Err(if message.is_empty() {
            format!("LibreSVIP 退出码 {status}")
        } else {
            format!("LibreSVIP 退出码 {status}：{message}")
        });
    }
    let size = std::fs::metadata(output)
        .map(|meta| meta.len())
        .unwrap_or(0);
    if size == 0 {
        let _ = std::fs::remove_file(output);
        return Err(format!("LibreSVIP 未生成输出文件：{}", output.display()));
    }
    progress(Some(1.0), "转换完成");
    log(format!("输出：{}（{size} 字节）", output.display()));
    Ok(())
}

#[derive(Debug, Clone, Default)]
pub struct ProjectInfo {
    pub tracks: usize,
    pub notes: usize,
    pub bpm: Option<f64>,
    pub track_names: Vec<String>,
}

pub fn inspect(input: &Path, ctx: &JobContext) -> Result<ProjectInfo, String> {
    inspect_with(
        input,
        |fraction, message| ctx.progress(fraction, message),
        |line| ctx.log(line),
        || ctx.is_canceled(),
    )
}

fn inspect_with<P, L, C>(
    input: &Path,
    mut progress: P,
    mut log: L,
    canceled: C,
) -> Result<ProjectInfo, String>
where
    P: FnMut(Option<f32>, &str),
    L: FnMut(String),
    C: Fn() -> bool,
{
    let dir = std::env::temp_dir().join(format!(
        "vss-inspect-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&dir)
        .map_err(|error| format!("创建预览目录失败（{}）：{error}", dir.display()))?;
    let output = dir.join("preview.ufdata");
    let result = convert_with(input, &output, &mut progress, &mut log, &canceled).and_then(|_| {
        let text =
            std::fs::read_to_string(&output).map_err(|error| format!("读取预览失败：{error}"))?;
        parse_ufdata(&text)
    });
    let _ = std::fs::remove_dir_all(&dir);
    result
}

fn parse_ufdata(text: &str) -> Result<ProjectInfo, String> {
    let document: serde_json::Value =
        serde_json::from_str(text).map_err(|error| format!("解析预览 JSON 失败：{error}"))?;
    let project = document
        .get("project")
        .ok_or_else(|| "预览缺少 project 字段".to_string())?;
    let tracks = project
        .get("tracks")
        .and_then(|tracks| tracks.as_array())
        .map(Vec::as_slice)
        .unwrap_or(&[]);
    let notes = tracks
        .iter()
        .map(|track| {
            track
                .get("notes")
                .and_then(|notes| notes.as_array())
                .map(Vec::len)
                .unwrap_or(0)
        })
        .sum();
    let bpm = project
        .get("tempos")
        .and_then(|tempos| tempos.as_array())
        .and_then(|tempos| tempos.first())
        .and_then(|tempo| tempo.get("bpm"))
        .and_then(|bpm| bpm.as_f64());
    let track_names = tracks
        .iter()
        .take(8)
        .filter_map(|track| track.get("name").and_then(|name| name.as_str()))
        .map(str::to_string)
        .collect();
    Ok(ProjectInfo {
        tracks: tracks.len(),
        notes,
        bpm,
        track_names,
    })
}

enum Event {
    Stdout(Vec<u8>),
    Stderr(Vec<u8>),
    Eof,
}

fn spawn_reader(
    mut stream: impl Read + Send + 'static,
    wrap: fn(Vec<u8>) -> Event,
    events: mpsc::Sender<Event>,
) {
    std::thread::spawn(move || {
        let mut buffer = [0u8; 8192];
        loop {
            match stream.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(read) => {
                    if events.send(wrap(buffer[..read].to_vec())).is_err() {
                        return;
                    }
                }
            }
        }
        let _ = events.send(Event::Eof);
    });
}

fn terminate(child: &mut Child) {
    let _ = child.kill();
    let _ = child.wait();
}

fn extract_prompt(buffer: &[u8]) -> Option<(String, usize)> {
    let colon = buffer.windows(2).position(|window| window == b"):")?;
    let open = buffer[..colon].iter().rposition(|byte| *byte == b'(')?;
    let default = std::str::from_utf8(&buffer[open + 1..colon]).ok()?.trim();
    if default.is_empty() {
        return None;
    }
    Some((default.to_string(), colon + 2))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_boolean_and_enum_defaults() {
        let (answer, consumed) = extract_prompt(b"1. Import volume [y/n] (y): ").unwrap();
        assert_eq!(answer, "y");
        assert!(consumed <= 33);
        let (answer, consumed) = extract_prompt(b"4. Encoding [UTF-8/GBK] (utf-8): ").unwrap();
        assert_eq!(answer, "utf-8");
        assert!(consumed <= 45);
        assert!(extract_prompt(b"4. Encoding [UTF-8/GBK] ").is_none());
    }

    #[test]
    fn parses_ufdata_summary() {
        let info = parse_ufdata(
            r#"{"formatVersion":1,"project":{"tracks":[{"name":"Track 1","notes":[{"key":60,"tickOn":0,"tickOff":480,"lyric":"la"}]},{"name":"Track 2","notes":[{"key":62,"tickOn":0,"tickOff":240}]}],"tempos":[{"tickPosition":0,"bpm":120.0}]}}"#,
        )
        .unwrap();
        assert_eq!(info.tracks, 2);
        assert_eq!(info.notes, 2);
        assert_eq!(info.bpm, Some(120.0));
        assert_eq!(info.track_names, vec!["Track 1", "Track 2"]);
    }

    #[test]
    #[ignore = "requires tools/libresvip and writes to a temp directory"]
    fn converts_a_minimal_midi_to_ufdata() {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let cli = cli_path(&root).unwrap();
        assert!(cli.is_file());
        let dir = std::env::temp_dir().join(format!("vss-libresvip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("test.mid");
        let output = dir.join("test.ufdata");
        std::fs::write(&input, minimal_midi()).unwrap();
        convert_with(
            &input,
            &output,
            |_, _| {},
            |line| println!("{line}"),
            || false,
        )
        .unwrap();
        assert!(output.is_file());
        let text = std::fs::read_to_string(&output).unwrap();
        println!("{text}");
        let info = inspect_with(&input, |_, _| {}, |_| {}, || false).unwrap();
        assert_eq!(info.tracks, 1);
        assert_eq!(info.notes, 1);
        assert_eq!(info.bpm, Some(120.0));
        let _ = std::fs::remove_dir_all(dir);
    }

    fn minimal_midi() -> Vec<u8> {
        vec![
            b'M', b'T', b'h', b'd', 0, 0, 0, 6, 0, 0, 0, 1, 0, 96, b'M', b'T', b'r', b'k', 0, 0, 0,
            22, 0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20, 0, 0xc0, 0, 0, 0x90, 0x3c, 0x64, 0x60, 0x80,
            0x3c, 0x40, 0, 0xff, 0x2f, 0,
        ]
    }
}
