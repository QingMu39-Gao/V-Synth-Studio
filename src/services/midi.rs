//! GAME vocal-to-MIDI transcription on the shared Python/ONNX runtime.

use std::fs;
use std::io::{BufRead, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde::Deserialize;

use crate::services::download;
use crate::services::jobs::JobContext;
use crate::services::python;

const MODEL_URL: &str = "https://gh-proxy.com/https://github.com/openvpi/GAME/releases/download/v1.0.3/GAME-1.0.3-large-onnx.zip";
const MODEL_SHA: &str = "8a5480539fe7d995800dc0efe149b83a1cd4f4e4a36aa2a1f7665f1765dcac08";
const MODEL_SIZE: u64 = 361_619_205;
const MODEL_FILES: [&str; 4] = [
    "encoder.onnx",
    "segmenter.onnx",
    "estimator.onnx",
    "config.json",
];
const SAMPLE_RATE: u32 = 44_100;
const TIMESTEP: f64 = 0.01;
const TICKS_PER_BEAT: u16 = 480;
const TICKS_PER_SECOND: f64 = TICKS_PER_BEAT as f64 * 2.0;
const TEMPO_US_PER_BEAT: u32 = 500_000;
const DEFAULT_STEPS: usize = 8;
const DEFAULT_THREADS: usize = 4;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Device {
    #[default]
    Auto,
    Cpu,
    Gpu,
}

impl Device {
    pub fn key(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Cpu => "cpu",
            Self::Gpu => "gpu",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Options {
    pub steps: usize,
    pub threads: usize,
    pub device: Device,
    pub language: i64,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            steps: DEFAULT_STEPS,
            threads: DEFAULT_THREADS,
            device: Device::Auto,
            language: 4,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Deserialize)]
pub struct Note {
    pub onset: f64,
    pub offset: f64,
    pub pitch: f32,
}

#[derive(Debug, Clone)]
pub struct Report {
    pub notes: Vec<Note>,
    pub backend: String,
    pub seconds: f64,
}

#[derive(Debug, Clone)]
pub struct Outputs {
    pub midi: PathBuf,
    pub csv: PathBuf,
    pub json: PathBuf,
    pub notes: usize,
    pub preview: Vec<Note>,
    pub backend: String,
    pub seconds: f64,
}

#[derive(Debug, Clone, Copy)]
pub struct ModelStatus {
    pub runtime_ready: bool,
    pub models_ready: bool,
}

#[derive(Deserialize)]
struct BackendReport {
    #[serde(default)]
    backend: String,
    #[serde(default)]
    notes: Vec<Note>,
    #[serde(default)]
    seconds: BackendSeconds,
}

#[derive(Default, Deserialize)]
struct BackendSeconds {
    #[serde(default)]
    encoder: f64,
    #[serde(default)]
    segmenter: f64,
    #[serde(default)]
    estimator: f64,
}

impl BackendSeconds {
    fn total(&self) -> f64 {
        self.encoder + self.segmenter + self.estimator
    }
}

pub fn status() -> ModelStatus {
    ModelStatus {
        runtime_ready: python::ready(),
        models_ready: models_ready(),
    }
}

pub fn ensure_ready(ctx: &JobContext) -> Result<(), String> {
    python::ensure(ctx, 0.0, 0.14)?;
    write_backend()?;
    if !models_ready() {
        ensure_models(ctx)?;
    }
    Ok(())
}

pub fn transcribe(
    input: &Path,
    output_dir: &Path,
    options: &Options,
    ctx: &JobContext,
) -> Result<Outputs, String> {
    if !input.is_file() {
        return Err(format!("输入文件不存在：{}", input.display()));
    }
    ensure_ready(ctx)?;
    let temp = temp_dir();
    fs::create_dir_all(&temp).map_err(|error| error.to_string())?;
    let wav = temp.join("input.wav");
    ctx.progress(Some(0.02), "转换音频");
    let convert = crate::services::audio::ffmpeg_path()?;
    let mut command = quiet_command(&convert);
    command
        .args(["-hide_banner", "-nostdin", "-y", "-i"])
        .arg(input)
        .args(["-map", "0:a:0", "-vn", "-ac", "1", "-ar"])
        .arg(SAMPLE_RATE.to_string())
        .args(["-c:a", "pcm_f32le", "-f", "wav"])
        .arg(&wav);
    let output = command
        .output()
        .map_err(|error| format!("启动 ffmpeg 失败：{error}"))?;
    if !output.status.success() {
        let _ = fs::remove_dir_all(&temp);
        return Err(format!(
            "音频转换失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let report_path = temp.join("notes.json");
    ctx.progress(Some(0.05), "载入扒谱引擎");
    let mut child = quiet_command(&python::exe())
        .env("PYTHONUTF8", "1")
        .arg(backend_path())
        .args(["--input", wav.to_string_lossy().as_ref()])
        .args(["--models", model_dir().to_string_lossy().as_ref()])
        .args(["--output", report_path.to_string_lossy().as_ref()])
        .arg("--steps")
        .arg(options.steps.to_string())
        .arg("--threads")
        .arg(options.threads.to_string())
        .arg("--language")
        .arg(options.language.to_string())
        .args(["--device", options.device.key()])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("启动扒谱引擎失败：{error}"))?;

    let stdout = child.stdout.take().expect("piped stdout");
    let (sender, receiver) = mpsc::channel::<String>();
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
            let _ = fs::remove_dir_all(&temp);
            return Err("已取消".to_string());
        }
        if started.elapsed() > Duration::from_secs(60 * 60 * 4) {
            terminate(&mut child);
            let _ = fs::remove_dir_all(&temp);
            return Err("扒谱超时".to_string());
        }
        match receiver.recv_timeout(Duration::from_millis(200)) {
            Ok(line) => {
                if let Some(rest) = line.strip_prefix("PROGRESS ")
                    && let Some((fraction, message)) = rest.split_once(' ')
                    && let Ok(fraction) = fraction.parse::<f32>()
                {
                    ctx.progress(
                        Some(0.05 + fraction.clamp(0.0, 1.0) * 0.92),
                        message.to_string(),
                    );
                } else if line.starts_with("backend=") || line.starts_with("chunks=") {
                    ctx.log(line);
                } else if line == "DONE" {
                    ctx.progress(Some(0.98), "写入结果");
                }
            }
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
            .map_err(|error| format!("等待扒谱引擎失败：{error}"))?,
    };
    let stderr = stderr_reader.join().unwrap_or_default();
    let body = fs::read_to_string(&report_path).ok();
    if !status.success() || body.is_none() {
        let _ = fs::remove_dir_all(&temp);
        return Err(format!("扒谱失败：{}", stderr.trim()));
    }
    let parsed: BackendReport = serde_json::from_str(body.as_deref().unwrap_or_default())
        .map_err(|error| format!("解析结果失败：{error}"))?;
    let notes = parsed
        .notes
        .into_iter()
        .filter(|note| {
            note.pitch.is_finite()
                && note.onset.is_finite()
                && note.offset.is_finite()
                && note.offset > note.onset
        })
        .collect::<Vec<_>>();
    let report = Report {
        notes,
        backend: if parsed.backend.is_empty() {
            "CPU".to_string()
        } else {
            parsed.backend
        },
        seconds: parsed.seconds.total(),
    };
    let stem = output_stem(input);
    let outputs = write_outputs(output_dir, &stem, &report)?;
    let _ = fs::remove_dir_all(&temp);
    ctx.progress(Some(1.0), "扒谱完成");
    Ok(outputs)
}

pub fn ensure_models_only(ctx: &JobContext) -> Result<(), String> {
    ensure_models(ctx)
}

fn ensure_models(ctx: &JobContext) -> Result<(), String> {
    let base = base_dir();
    let cache = base.join("cache");
    fs::create_dir_all(&cache).map_err(|error| error.to_string())?;
    let archive = cache.join("GAME-1.0.3-large-onnx.zip");
    download::fetch_all(
        &download::candidate_urls(MODEL_URL, &[]),
        &archive,
        MODEL_SHA,
        MODEL_SIZE,
        0.15,
        0.8,
        ctx,
        "GAME 模型",
    )?;
    install_models(&archive, ctx)
}

/// Install the GAME model set from a file the user already has.
pub fn import_models(source: &Path, ctx: &JobContext) -> Result<(), String> {
    if !source.is_file() {
        return Err(format!("文件不存在：{}", source.display()));
    }
    ctx.progress(Some(0.05), "校验本地模型");
    if !download::verify_sha256(source, MODEL_SHA)? {
        return Err("GAME 模型包的本地文件校验值与内置版本不符，拒绝使用".to_string());
    }
    ctx.log(format!("使用本地模型包：{}", source.display()));
    install_models(source, ctx)
}

fn install_models(archive: &Path, ctx: &JobContext) -> Result<(), String> {
    let base = base_dir();
    let models = model_dir();
    ctx.progress(Some(0.96), "解压 GAME 模型");
    let staging = base.join(format!("install-{}", std::process::id()));
    let _ = fs::remove_dir_all(&staging);
    fs::create_dir_all(&staging).map_err(|error| error.to_string())?;
    download::extract_zip(archive, &staging)?;
    let extracted = find_model_dir(&staging)?;
    if models.exists() {
        fs::remove_dir_all(&models).map_err(|error| error.to_string())?;
    }
    fs::rename(&extracted, &models).map_err(|error| format!("安装 GAME 模型失败：{error}"))?;
    let _ = fs::remove_dir_all(&staging);
    if !models_ready() {
        return Err("GAME 模型文件不完整".to_string());
    }
    ctx.progress(Some(0.99), "GAME 模型已就绪");
    Ok(())
}

fn find_model_dir(staging: &Path) -> Result<PathBuf, String> {
    let direct = staging.to_path_buf();
    if MODEL_FILES.iter().all(|name| direct.join(name).is_file()) {
        return Ok(direct);
    }
    let entries = fs::read_dir(staging).map_err(|error| error.to_string())?;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() && MODEL_FILES.iter().all(|name| path.join(name).is_file()) {
            return Ok(path);
        }
    }
    Err("压缩包里没有完整的 GAME 模型".to_string())
}

fn write_backend() -> Result<(), String> {
    let path = backend_path();
    let source = include_str!("midi_backend.py");
    if fs::read_to_string(&path).ok().as_deref() == Some(source) {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    fs::write(&path, source).map_err(|error| format!("写入扒谱后端失败：{error}"))
}

fn write_outputs(output_dir: &Path, stem: &str, report: &Report) -> Result<Outputs, String> {
    fs::create_dir_all(output_dir)
        .map_err(|error| format!("创建输出目录失败（{}）：{error}", output_dir.display()))?;
    let base = unique_base(output_dir, stem);
    let midi = output_dir.join(format!("{base}.mid"));
    let csv = output_dir.join(format!("{base}.csv"));
    let json = output_dir.join(format!("{base}.json"));

    let midi_notes = deoverlap_mono(report.notes.clone());
    fs::write(&midi, write_midi(&midi_notes)).map_err(|error| format!("写 MIDI 失败：{error}"))?;

    let mut table = String::from("index,onset,offset,duration,pitch,midi\n");
    for (index, note) in report.notes.iter().enumerate() {
        table.push_str(&format!(
            "{},{:.4},{:.4},{:.4},{:.4},{}\n",
            index + 1,
            note.onset,
            note.offset,
            note.offset - note.onset,
            note.pitch,
            note.pitch.round() as i32
        ));
    }
    fs::write(&csv, table).map_err(|error| format!("写 CSV 失败：{error}"))?;

    let body = serde_json::json!({
        "source": "GAME 1.0.3 ONNX",
        "samplerate": SAMPLE_RATE,
        "timestep": TIMESTEP,
        "backend": report.backend,
        "seconds": report.seconds,
        "notes": report.notes.iter().map(|note| serde_json::json!({
            "onset": note.onset,
            "offset": note.offset,
            "pitch": note.pitch,
            "midi": note.pitch.round() as i32,
        })).collect::<Vec<_>>(),
    });
    fs::write(
        &json,
        serde_json::to_vec_pretty(&body).map_err(|error| error.to_string())?,
    )
    .map_err(|error| format!("写 JSON 失败：{error}"))?;

    Ok(Outputs {
        midi,
        csv,
        json,
        notes: report.notes.len(),
        preview: report.notes.iter().take(200).copied().collect(),
        backend: report.backend.clone(),
        seconds: report.seconds,
    })
}

fn base_dir() -> PathBuf {
    crate::config::extensions_root().join("midi")
}

pub fn model_dir() -> PathBuf {
    base_dir().join("models")
}

fn backend_path() -> PathBuf {
    base_dir().join("midi_backend.py")
}

fn models_ready() -> bool {
    MODEL_FILES
        .iter()
        .all(|name| model_dir().join(name).is_file())
}

fn temp_dir() -> PathBuf {
    base_dir().join("tmp").join(format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0)
    ))
}

fn output_stem(input: &Path) -> String {
    let stem = input
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_else(|| "未命名".to_string());
    let cleaned: String = stem
        .chars()
        .map(|c| {
            if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
                || (c as u32) < 0x20
            {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').to_string();
    if cleaned.is_empty() {
        "未命名".to_string()
    } else {
        cleaned.chars().take(80).collect()
    }
}

fn unique_base(directory: &Path, stem: &str) -> String {
    let mut candidate = stem.to_string();
    let mut index = 1;
    while ["mid", "csv", "json"]
        .iter()
        .any(|extension| directory.join(format!("{candidate}.{extension}")).exists())
    {
        candidate = format!("{stem}-{index}");
        index += 1;
    }
    candidate
}

fn deoverlap_mono(mut notes: Vec<Note>) -> Vec<Note> {
    notes.sort_by(|a, b| {
        a.onset
            .partial_cmp(&b.onset)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(
                a.offset
                    .partial_cmp(&b.offset)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
            .then(
                a.pitch
                    .partial_cmp(&b.pitch)
                    .unwrap_or(std::cmp::Ordering::Equal),
            )
    });
    let mut out: Vec<Note> = Vec::with_capacity(notes.len());
    let mut last_time = 0f64;
    for mut note in notes {
        note.onset = note.onset.max(last_time);
        note.offset = note.offset.max(note.onset);
        if note.offset <= note.onset {
            continue;
        }
        last_time = note.offset;
        out.push(note);
    }
    out
}

fn write_vlq(out: &mut Vec<u8>, mut value: u32) {
    let mut buffer = [0u8; 5];
    let mut index = 4usize;
    buffer[index] = (value & 0x7f) as u8;
    value >>= 7;
    while value > 0 {
        index -= 1;
        buffer[index] = ((value & 0x7f) as u8) | 0x80;
        value >>= 7;
    }
    out.extend_from_slice(&buffer[index..]);
}

fn write_midi(notes: &[Note]) -> Vec<u8> {
    let mut track: Vec<u8> = Vec::new();
    write_vlq(&mut track, 0);
    track.extend_from_slice(&[0xff, 0x51, 0x03]);
    track.extend_from_slice(&TEMPO_US_PER_BEAT.to_be_bytes()[1..]);

    let mut last_tick: i64 = 0;
    for note in notes {
        let onset_tick = (note.onset * TICKS_PER_SECOND).round() as i64;
        let offset_tick = (note.offset * TICKS_PER_SECOND).round() as i64;
        if offset_tick <= onset_tick {
            continue;
        }
        let pitch = note.pitch.round().clamp(0.0, 127.0) as u8;
        write_vlq(&mut track, (onset_tick - last_tick).max(0) as u32);
        track.extend_from_slice(&[0x90, pitch, 0x40]);
        write_vlq(&mut track, (offset_tick - onset_tick).max(0) as u32);
        track.extend_from_slice(&[0x80, pitch, 0x00]);
        last_tick = offset_tick;
    }
    write_vlq(&mut track, 0);
    track.extend_from_slice(&[0xff, 0x2f, 0x00]);

    let mut out = Vec::with_capacity(22 + track.len());
    out.extend_from_slice(b"MThd");
    out.extend_from_slice(&6u32.to_be_bytes());
    out.extend_from_slice(&0u16.to_be_bytes());
    out.extend_from_slice(&1u16.to_be_bytes());
    out.extend_from_slice(&TICKS_PER_BEAT.to_be_bytes());
    out.extend_from_slice(b"MTrk");
    out.extend_from_slice(&(track.len() as u32).to_be_bytes());
    out.extend_from_slice(&track);
    out
}

fn terminate(child: &mut std::process::Child) {
    let _ = child.kill();
    let _ = child.wait();
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
    fn vlq_encoding_matches_smf() {
        let mut value = Vec::new();
        write_vlq(&mut value, 128);
        assert_eq!(value, vec![0x81, 0x00]);
        value.clear();
        write_vlq(&mut value, 960);
        assert_eq!(value, vec![0x87, 0x40]);
    }

    #[test]
    fn midi_header_and_ticks_are_wellformed() {
        let bytes = write_midi(&[Note {
            onset: 0.0,
            offset: 1.0,
            pitch: 69.0,
        }]);
        assert_eq!(&bytes[0..4], b"MThd");
        assert_eq!(&bytes[12..14], &480u16.to_be_bytes());
        assert_eq!(&bytes[14..18], b"MTrk");
        let body = &bytes[22..];
        assert_eq!(&body[0..3], &[0x00, 0xff, 0x51]);
        assert_eq!(&body[3..7], &[0x03, 0x07, 0xa1, 0x20]);
        assert_eq!(&body[7..10], &[0x00, 0x90, 69]);
        assert_eq!(&body[11..14], &[0x87, 0x40, 0x80]);
    }

    #[test]
    fn deoverlap_pushes_notes_to_monophonic() {
        let notes = deoverlap_mono(vec![
            Note {
                onset: 0.0,
                offset: 0.5,
                pitch: 60.0,
            },
            Note {
                onset: 0.2,
                offset: 0.8,
                pitch: 64.0,
            },
        ]);
        assert_eq!(notes.len(), 2);
        assert!((notes[1].onset - 0.5).abs() < 1e-9);
    }

    #[test]
    fn output_stem_blocks_path_characters() {
        assert_eq!(output_stem(Path::new("歌/干声.wav")), "干声");
        assert_eq!(output_stem(Path::new("ab:c*d?.flac")), "ab_c_d_");
        assert_eq!(output_stem(Path::new("...")), "未命名");
    }

    #[test]
    fn unique_base_avoids_every_output_extension() {
        let dir = std::env::temp_dir().join(format!("vss-midi-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("song.json"), b"{}").unwrap();
        assert_eq!(unique_base(&dir, "song"), "song-1");
        fs::write(dir.join("song.mid"), b"").unwrap();
        assert_eq!(unique_base(&dir, "song"), "song-1");
        fs::write(dir.join("song-1.mid"), b"").unwrap();
        assert_eq!(unique_base(&dir, "song-1"), "song-1-1");
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    fn finds_the_model_directory_inside_an_archive_root() {
        let dir = std::env::temp_dir().join(format!("vss-midi-model-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let nested = dir.join("GAME-1.0.3-large-onnx");
        fs::create_dir_all(&nested).unwrap();
        for name in MODEL_FILES {
            fs::write(nested.join(name), b"").unwrap();
        }
        assert_eq!(find_model_dir(&dir).unwrap(), nested);
        let _ = fs::remove_dir_all(dir);
    }

    #[test]
    #[ignore = "requires the GAME 1.0.3 models"]
    fn transcribes_a_synthetic_melody() {
        let dir = std::env::temp_dir().join(format!("vss-midi-transcribe-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let input = dir.join("melody.wav");
        write_melody(&input);
        let output = dir.join("out");
        let job_output = output.clone();
        let (jobs, _events) = crate::services::jobs::Jobs::new();
        let job = jobs.start("midi", move |ctx| {
            let options = Options {
                steps: 2,
                threads: 4,
                device: Device::Cpu,
                ..Options::default()
            };
            transcribe(&input, &job_output, &options, &ctx).map(|_| ())
        });
        match job.result.recv_blocking().unwrap() {
            crate::services::jobs::JobOutcome::Done(()) => {}
            other => panic!("{other:?}"),
        }
        let bytes = fs::read(output.join("melody.mid")).unwrap();
        assert_eq!(&bytes[0..4], b"MThd");
        assert!(output.join("melody.csv").is_file());
        let body = fs::read_to_string(output.join("melody.json")).unwrap();
        let json: serde_json::Value = serde_json::from_str(&body).unwrap();
        let notes = json["notes"].as_array().unwrap();
        assert!(notes.len() >= 4, "expected the four melody notes");
        let expected = [(57.0f32, 0.0f64), (60.0, 0.95), (64.0, 1.9), (69.0, 2.85)];
        for (pitch, onset) in expected {
            let found = notes
                .iter()
                .filter_map(|note| {
                    let p = note["pitch"].as_f64()? as f32;
                    let o = note["onset"].as_f64()?;
                    ((p - pitch).abs() < 1.0).then_some(o)
                })
                .min_by(|a, b| {
                    (a - onset)
                        .abs()
                        .partial_cmp(&(b - onset).abs())
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
            let got = found.unwrap_or_else(|| panic!("no note near {pitch}"));
            assert!(
                (got - onset).abs() < 0.15,
                "pitch {pitch} started at {got:.3}, expected {onset:.3}"
            );
        }
        let _ = fs::remove_dir_all(dir);
    }

    fn write_melody(path: &Path) {
        let rate = SAMPLE_RATE as f64;
        let notes = [(220.0f64, 0.8), (261.63, 0.8), (329.63, 0.8), (440.0, 0.8)];
        let mut samples: Vec<f32> = Vec::new();
        for (frequency, duration) in notes {
            let count = (rate * duration) as usize;
            for index in 0..count {
                let t = index as f64 / rate;
                let vibrato = 1.0 + 0.006 * (std::f64::consts::TAU * 5.0 * t).sin();
                let phase = std::f64::consts::TAU * frequency * vibrato * t;
                let wave = 0.5 * phase.sin()
                    + 0.25 * (2.0 * phase).sin()
                    + 0.12 * (3.0 * phase).sin()
                    + 0.06 * (4.0 * phase).sin();
                let envelope = (t / 0.03).min(1.0) * ((duration - t) / 0.08).min(1.0);
                samples.push((wave * envelope * 0.35) as f32);
            }
            samples.extend(std::iter::repeat_n(0.0, (rate * 0.15) as usize));
        }
        let mut data = Vec::with_capacity(samples.len() * 4);
        for sample in samples {
            data.extend_from_slice(&sample.to_le_bytes());
        }
        let mut file = std::fs::File::create(path).unwrap();
        use std::io::Write;
        file.write_all(b"RIFF").unwrap();
        file.write_all(&(36 + data.len() as u32).to_le_bytes())
            .unwrap();
        file.write_all(b"WAVEfmt ").unwrap();
        file.write_all(&16u32.to_le_bytes()).unwrap();
        file.write_all(&3u16.to_le_bytes()).unwrap();
        file.write_all(&1u16.to_le_bytes()).unwrap();
        file.write_all(&SAMPLE_RATE.to_le_bytes()).unwrap();
        file.write_all(&(SAMPLE_RATE * 4).to_le_bytes()).unwrap();
        file.write_all(&4u16.to_le_bytes()).unwrap();
        file.write_all(&32u16.to_le_bytes()).unwrap();
        file.write_all(b"data").unwrap();
        file.write_all(&(data.len() as u32).to_le_bytes()).unwrap();
        file.write_all(&data).unwrap();
    }
}
