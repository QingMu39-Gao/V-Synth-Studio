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

/// Answers for LibreSVIP's interactive prompts. Field names follow the CLI's
/// own option names so a saved config stays readable next to the tool's output.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(default)]
pub struct Options {
    pub volume_envelope: bool,
    pub dynamics_envelope: bool,
    pub pitch_curve: bool,
    pub accompaniment: bool,
    pub gender_envelope: bool,
    pub breath_envelope: bool,
    pub follow_pitch_mode: bool,
    pub pitch_mode: String,
    pub breath_note: String,
    pub note_group: String,
    pub transpose: bool,
    pub scale: bool,
    pub lyrics_pron: bool,
    pub remove_short: bool,
    pub replace_lyrics: bool,
    pub semitones: i32,
    pub scale_factor: String,
    pub vsqx_version: String,
    pub pretty_xml: bool,
    pub language: String,
}

impl Default for Options {
    /// Defaults are the CLI's own, not a guess: the panel starts where an
    /// unattended run would end.
    fn default() -> Self {
        Self {
            volume_envelope: true,
            dynamics_envelope: true,
            pitch_curve: true,
            accompaniment: true,
            gender_envelope: true,
            breath_envelope: true,
            follow_pitch_mode: true,
            pitch_mode: "plain".to_string(),
            breath_note: "convert".to_string(),
            note_group: "split".to_string(),
            transpose: false,
            scale: false,
            lyrics_pron: false,
            remove_short: false,
            replace_lyrics: false,
            semitones: 0,
            scale_factor: "1/1".to_string(),
            vsqx_version: "4".to_string(),
            pretty_xml: true,
            language: "4".to_string(),
        }
    }
}

fn yes_no(value: bool) -> String {
    if value {
        "y".to_string()
    } else {
        "n".to_string()
    }
}

/// Keyword in the prompt text → the answer this option implies. The prompt set
/// changes with the input and output format, so anything unmatched keeps its
/// bracketed default.
type Rule = (&'static str, fn(&Options) -> String);

const RULES: &[Rule] = &[
    ("音量包络", |o| yes_no(o.volume_envelope)),
    ("力度包络", |o| yes_no(o.dynamics_envelope)),
    ("音高曲线", |o| yes_no(o.pitch_curve)),
    ("伴奏轨", |o| yes_no(o.accompaniment)),
    ("性别包络", |o| yes_no(o.gender_envelope)),
    ("气声包络", |o| yes_no(o.breath_envelope)),
    ("即时音高", |o| yes_no(o.follow_pitch_mode)),
    ("音高信息输入模式", |o| o.pitch_mode.clone()),
    ("换气音符", |o| o.breath_note.clone()),
    ("音符组", |o| o.note_group.clone()),
    ("音高变调", |o| yes_no(o.transpose)),
    ("工程缩放", |o| yes_no(o.scale)),
    ("歌词发音转换", |o| yes_no(o.lyrics_pron)),
    ("无声间隙", |o| yes_no(o.remove_short)),
    ("替换歌词", |o| yes_no(o.replace_lyrics)),
    ("音高变化量", |o| o.semitones.to_string()),
    ("缩放系数", |o| o.scale_factor.clone()),
    ("VSQX文件版本", |o| o.vsqx_version.clone()),
    ("美化XML", |o| yes_no(o.pretty_xml)),
    ("默认语言", |o| o.language.clone()),
];

/// VSQX export crashes on parameter curves, so the four envelope imports are
/// forced off; the caller reports what it dropped instead of failing silently.
type VsqxEnvelope = (&'static str, fn(&Options) -> bool, fn(&mut Options));

const VSQX_ENVELOPES: &[VsqxEnvelope] = &[
    (
        "导入音量包络",
        |o| o.volume_envelope,
        |o| o.volume_envelope = false,
    ),
    (
        "导入力度包络",
        |o| o.dynamics_envelope,
        |o| o.dynamics_envelope = false,
    ),
    (
        "导入性别包络",
        |o| o.gender_envelope,
        |o| o.gender_envelope = false,
    ),
    (
        "导入气声包络",
        |o| o.breath_envelope,
        |o| o.breath_envelope = false,
    ),
];

fn for_target(options: &Options, output: &Path) -> (Options, Vec<&'static str>) {
    let mut effective = options.clone();
    let mut dropped = Vec::new();
    if output.extension().and_then(|ext| ext.to_str()) == Some("vsqx") {
        for (name, enabled, disable) in VSQX_ENVELOPES {
            if enabled(options) {
                disable(&mut effective);
                dropped.push(*name);
            }
        }
    }
    (effective, dropped)
}

fn answer_for(question: &str, default: &str, options: &Options) -> String {
    RULES
        .iter()
        .find(|(keyword, _)| question.contains(keyword))
        .map(|(_, answer)| answer(options))
        .filter(|answer| !answer.is_empty())
        .unwrap_or_else(|| default.to_string())
}

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

/// Convert a batch, mapping each file's progress into the whole job and
/// stopping between files once cancellation is requested.
pub fn convert_batch(
    inputs: &[PathBuf],
    format: &crate::formats::Format,
    output_dir: Option<&Path>,
    options: &Options,
    ctx: &JobContext,
) -> Result<Vec<PathBuf>, String> {
    convert_batch_with(
        inputs,
        format,
        output_dir,
        options,
        |fraction, message| ctx.progress(fraction, message),
        |line| ctx.log(line),
        || ctx.is_canceled(),
    )
}

pub(crate) fn convert_batch_with<P, L, C>(
    inputs: &[PathBuf],
    format: &crate::formats::Format,
    output_dir: Option<&Path>,
    options: &Options,
    mut progress: P,
    mut log: L,
    canceled: C,
) -> Result<Vec<PathBuf>, String>
where
    P: FnMut(Option<f32>, &str),
    L: FnMut(String),
    C: Fn() -> bool,
{
    let total = inputs.len().max(1);
    let mut outputs = Vec::with_capacity(inputs.len());
    for (index, input) in inputs.iter().enumerate() {
        if canceled() {
            return Err("已取消".to_string());
        }
        let output = unique_output(input, format, output_dir);
        let base = index as f32 / total as f32;
        let span = 1.0 / total as f32;
        convert_with(
            input,
            &output,
            options,
            |fraction, message| progress(fraction.map(|value| base + value * span), message),
            &mut log,
            &canceled,
        )?;
        outputs.push(output);
    }
    Ok(outputs)
}

pub(crate) fn unique_output(
    input: &Path,
    format: &crate::formats::Format,
    output_dir: Option<&Path>,
) -> PathBuf {
    let directory = output_dir
        .map(Path::to_path_buf)
        .or_else(|| input.parent().map(Path::to_path_buf))
        .unwrap_or_else(|| PathBuf::from("."));
    let stem = input
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_else(|| "output".to_string());
    let mut candidate = directory.join(format!("{stem}.{}", format.id));
    let mut index = 1;
    while candidate.exists() {
        candidate = directory.join(format!("{stem}-{index}.{}", format.id));
        index += 1;
    }
    candidate
}

pub(crate) fn convert_with<P, L, C>(
    input: &Path,
    output: &Path,
    options: &Options,
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

    let (options, dropped) = for_target(options, output);
    if !dropped.is_empty() {
        log(format!(
            "⚠ VSQX 导出会在带参数曲线时崩溃，已自动关闭：{}",
            dropped.join("、")
        ));
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
                while let Some((question, default, consumed)) = extract_prompt(&stdout_buffer) {
                    if answers >= MAX_ANSWERS {
                        terminate(&mut child);
                        return Err("LibreSVIP 选项过多，已中止".to_string());
                    }
                    answers += 1;
                    let answer = answer_for(&question, &default, &options);
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
    let result = convert_with(
        input,
        &output,
        &Options::default(),
        &mut progress,
        &mut log,
        &canceled,
    )
    .and_then(|_| {
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

/// Split the leading `... (default): ` prompt out of the byte buffer and return
/// the question text with its bracketed default.
fn extract_prompt(buffer: &[u8]) -> Option<(String, String, usize)> {
    let colon = buffer.windows(2).position(|window| window == b"):")?;
    let open = buffer[..colon].iter().rposition(|byte| *byte == b'(')?;
    let default = std::str::from_utf8(&buffer[open + 1..colon]).ok()?.trim();
    if default.is_empty() {
        return None;
    }
    let question = String::from_utf8_lossy(&buffer[..colon + 2]).into_owned();
    Some((question, default.to_string(), colon + 2))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_boolean_and_enum_defaults() {
        let (question, default, consumed) =
            extract_prompt(b"1. Import volume [y/n] (y): ").unwrap();
        assert_eq!(default, "y");
        assert!(question.ends_with("(y):"));
        assert!(consumed <= 33);
        let (question, default, consumed) =
            extract_prompt(b"4. Encoding [UTF-8/GBK] (utf-8): ").unwrap();
        assert_eq!(default, "utf-8");
        assert!(question.contains("Encoding"));
        assert!(consumed <= 45);
        assert!(extract_prompt(b"4. Encoding [UTF-8/GBK] ").is_none());
    }

    #[test]
    fn matched_prompts_answer_from_options_and_rest_keep_defaults() {
        let options = Options {
            volume_envelope: false,
            pitch_mode: "full".to_string(),
            semitones: 3,
            scale_factor: "2/1".to_string(),
            language: "1".to_string(),
            ..Options::default()
        };
        let (question, default, _) =
            extract_prompt("1. 导入音量包络 [y/n] (y): ".as_bytes()).unwrap();
        assert_eq!(answer_for(&question, &default, &options), "n");
        let (question, default, _) =
            extract_prompt("7. 音高信息输入模式 [full/vibrato/plain] (plain): ".as_bytes())
                .unwrap();
        assert_eq!(answer_for(&question, &default, &options), "full");
        let (question, default, _) = extract_prompt("音高变化量 (0): ".as_bytes()).unwrap();
        assert_eq!(answer_for(&question, &default, &options), "3");
        let (question, default, _) = extract_prompt("缩放系数 [1/1/2] (1/1): ".as_bytes()).unwrap();
        assert_eq!(answer_for(&question, &default, &options), "2/1");
        let (question, default, _) = extract_prompt("默认语言 (4): ".as_bytes()).unwrap();
        assert_eq!(answer_for(&question, &default, &options), "1");
        // 歌词编码 is not an option here, so the bracketed default must survive
        let (question, default, _) =
            extract_prompt("4. 歌词编码 [utf-8/gbk] (utf-8): ".as_bytes()).unwrap();
        assert_eq!(answer_for(&question, &default, &options), "utf-8");
    }

    #[test]
    fn vsqx_targets_drop_only_the_envelopes_that_were_on() {
        let options = Options {
            volume_envelope: false,
            ..Options::default()
        };
        let (effective, dropped) = for_target(&options, Path::new("out.vsqx"));
        assert_eq!(
            dropped,
            vec!["导入力度包络", "导入性别包络", "导入气声包络"]
        );
        assert!(!effective.volume_envelope);
        assert!(!effective.dynamics_envelope);
        assert!(!effective.breath_envelope);

        let (effective, dropped) = for_target(&options, Path::new("out.svp"));
        assert!(dropped.is_empty());
        assert_eq!(effective, options);
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
            &Options::default(),
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

    #[test]
    #[ignore = "requires tools/libresvip and converts two files"]
    fn converts_every_file_in_the_batch() {
        let dir = batch_dir("all");
        let first = dir.join("first.mid");
        let second = dir.join("second.mid");
        std::fs::write(&first, minimal_midi()).unwrap();
        std::fs::write(&second, minimal_midi()).unwrap();

        let outputs = convert_batch_with(
            &[first, second],
            ufdata(),
            None,
            &Options::default(),
            |_, _| {},
            |_| {},
            || false,
        )
        .unwrap();

        assert_eq!(outputs.len(), 2);
        assert!(outputs.iter().all(|path| path.is_file()));
        assert_eq!(outputs[0].file_name().unwrap(), "first.ufdata");
        assert_eq!(outputs[1].file_name().unwrap(), "second.ufdata");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    #[ignore = "requires tools/libresvip and cancels mid-batch"]
    fn keeps_finished_files_when_the_batch_is_canceled() {
        use std::sync::Arc;
        use std::sync::atomic::{AtomicBool, Ordering};

        let dir = batch_dir("cancel");
        let first = dir.join("first.mid");
        let second = dir.join("second.mid");
        std::fs::write(&first, minimal_midi()).unwrap();
        std::fs::write(&second, minimal_midi()).unwrap();

        let cancel = Arc::new(AtomicBool::new(false));
        let watch = cancel.clone();
        let log = move |line: String| {
            if line.contains("second.mid") {
                watch.store(true, Ordering::Relaxed);
            }
        };
        let canceled = {
            let cancel = cancel.clone();
            move || cancel.load(Ordering::Relaxed)
        };

        let error = convert_batch_with(
            &[first, second],
            ufdata(),
            None,
            &Options::default(),
            |_, _| {},
            log,
            canceled,
        )
        .expect_err("the second conversion should be canceled");
        assert!(error.contains("已取消"), "{error}");
        assert!(dir.join("first.ufdata").is_file());
        assert!(!dir.join("second.ufdata").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    #[ignore = "requires tools/libresvip and answers with non-default options"]
    fn non_default_options_are_accepted_by_the_cli() {
        let dir = batch_dir("options");
        let input = dir.join("test.mid");
        let output = dir.join("test.ufdata");
        std::fs::write(&input, minimal_midi()).unwrap();
        let options = Options {
            volume_envelope: false,
            pitch_curve: false,
            pitch_mode: "full".to_string(),
            breath_note: "keep".to_string(),
            note_group: "merge".to_string(),
            transpose: true,
            scale: true,
            semitones: 2,
            scale_factor: "2/1".to_string(),
            language: "1".to_string(),
            ..Options::default()
        };
        convert_with(
            &input,
            &output,
            &options,
            |_, _| {},
            |line| println!("{line}"),
            || false,
        )
        .unwrap();
        assert!(output.is_file());
        let _ = std::fs::remove_dir_all(dir);
    }

    fn batch_dir(label: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("vss-libresvip-{label}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn ufdata() -> &'static crate::formats::Format {
        crate::formats::ALL
            .iter()
            .find(|format| format.id == "ufdata")
            .expect("ufdata format")
    }

    fn minimal_midi() -> Vec<u8> {
        vec![
            b'M', b'T', b'h', b'd', 0, 0, 0, 6, 0, 0, 0, 1, 0, 96, b'M', b'T', b'r', b'k', 0, 0, 0,
            22, 0, 0xff, 0x51, 3, 0x07, 0xa1, 0x20, 0, 0xc0, 0, 0, 0x90, 0x3c, 0x64, 0x60, 0x80,
            0x3c, 0x40, 0, 0xff, 0x2f, 0,
        ]
    }
}
