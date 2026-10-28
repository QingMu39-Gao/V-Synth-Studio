//! Audio operations backed by the bundled ffmpeg.

use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::services::jobs::JobContext;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AudioFormat {
    Wav,
    Mp3,
    Flac,
    M4a,
    Ogg,
}

impl AudioFormat {
    pub const ALL: [Self; 5] = [Self::Wav, Self::Mp3, Self::Flac, Self::M4a, Self::Ogg];

    pub fn id(self) -> &'static str {
        match self {
            Self::Wav => "wav",
            Self::Mp3 => "mp3",
            Self::Flac => "flac",
            Self::M4a => "m4a",
            Self::Ogg => "ogg",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Wav => "WAV",
            Self::Mp3 => "MP3",
            Self::Flac => "FLAC",
            Self::M4a => "M4A",
            Self::Ogg => "OGG",
        }
    }

    fn codec_args(self) -> &'static [&'static str] {
        match self {
            Self::Wav => &["-c:a", "pcm_s16le"],
            Self::Mp3 => &["-c:a", "libmp3lame", "-b:a", "192k"],
            Self::Flac => &["-c:a", "flac"],
            Self::M4a => &["-c:a", "aac", "-b:a", "192k"],
            Self::Ogg => &["-c:a", "libvorbis", "-q:a", "5"],
        }
    }
}

#[derive(Debug, Clone)]
pub enum AudioOperation {
    Convert,
    Extract,
    Pitch { semitones: f32 },
    Speed { ratio: f32 },
    Trim { start: f64, end: f64 },
    Loudness { target_lufs: f32 },
}

#[derive(Debug, Clone, Default)]
pub struct AudioInfo {
    pub duration: f64,
    pub sample_rate: u32,
    pub channels: u16,
    pub codec: String,
}

pub fn ffmpeg_path() -> Result<PathBuf, String> {
    let root = crate::config::app_root();
    let exe = if cfg!(windows) {
        "ffmpeg.exe"
    } else {
        "ffmpeg"
    };
    let candidates = [
        root.join("tools").join("ffmpeg").join("bin").join(exe),
        root.join("tools").join("ffmpeg").join(exe),
        root.join("tools").join(exe),
    ];
    for candidate in &candidates {
        if candidate.is_file() {
            return Ok(candidate.clone());
        }
    }
    let paths = std::env::var_os("PATH").ok_or_else(|| {
        "未找到 ffmpeg：tools/ 与 PATH 都没有，请先在设置中安装外部组件".to_string()
    })?;
    std::env::split_paths(&paths)
        .map(|directory| directory.join(exe))
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| "未找到 ffmpeg：请先在设置中安装外部组件".to_string())
}

pub fn probe(input: &Path) -> Result<AudioInfo, String> {
    if !input.is_file() {
        return Err(format!("音频文件不存在：{}", input.display()));
    }
    let ffmpeg = ffmpeg_path()?;
    let output = quiet_command(&ffmpeg)
        .arg("-hide_banner")
        .arg("-i")
        .arg(input)
        .output()
        .map_err(|error| format!("启动 ffmpeg 失败：{error}"))?;
    let text = String::from_utf8_lossy(&output.stderr);
    parse_probe(&text).ok_or_else(|| {
        let detail = text
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("无法读取媒体信息");
        format!("无法读取音频信息：{detail}")
    })
}

fn parse_probe(text: &str) -> Option<AudioInfo> {
    let duration = text
        .lines()
        .find_map(|line| line.trim().strip_prefix("Duration: "))
        .and_then(|value| value.split(',').next())
        .and_then(parse_timestamp)?;
    let stream = text
        .lines()
        .find(|line| line.contains("Stream #") && line.contains("Audio: "))?;
    let codec = stream
        .split("Audio: ")
        .nth(1)?
        .split([',', ' '])
        .next()?
        .to_string();
    let sample_rate = stream
        .split(", ")
        .find_map(|part| part.strip_suffix(" Hz"))
        .and_then(|value| value.trim().parse().ok())?;
    let channels = if stream.contains("mono") {
        1
    } else if stream.contains("stereo") {
        2
    } else if stream.contains("5.1") {
        6
    } else if stream.contains("7.1") {
        8
    } else {
        stream
            .split(", ")
            .find_map(|part| part.strip_suffix(" channels"))
            .and_then(|value| value.trim().parse().ok())
            .unwrap_or(2)
    };
    Some(AudioInfo {
        duration,
        sample_rate,
        channels,
        codec,
    })
}

fn parse_timestamp(value: &str) -> Option<f64> {
    let mut parts = value.trim().split(':');
    let hours: f64 = parts.next()?.parse().ok()?;
    let minutes: f64 = parts.next()?.parse().ok()?;
    let seconds: f64 = parts.next()?.parse().ok()?;
    Some(hours * 3600.0 + minutes * 60.0 + seconds)
}

pub fn waveform(input: &Path, buckets: usize, ctx: &JobContext) -> Result<Vec<f32>, String> {
    waveform_with(input, buckets, || ctx.is_canceled())
}

fn waveform_with(
    input: &Path,
    buckets: usize,
    canceled: impl Fn() -> bool,
) -> Result<Vec<f32>, String> {
    let ffmpeg = ffmpeg_path()?;
    let mut child = quiet_command(&ffmpeg)
        .args([
            "-v",
            "error",
            "-nostdin",
            "-i",
            input.to_string_lossy().as_ref(),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "4000",
            "-f",
            "s16le",
            "-",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("启动 ffmpeg 波形解码失败：{error}"))?;
    let mut stdout = child.stdout.take().expect("piped stdout");
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 64 * 1024];
    loop {
        if canceled() {
            let _ = child.kill();
            let _ = child.wait();
            return Err("已取消".to_string());
        }
        match stdout.read(&mut buffer) {
            Ok(0) => break,
            Ok(read) => bytes.extend_from_slice(&buffer[..read]),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(format!("读取波形失败：{error}"));
            }
        }
    }
    let status = child
        .wait()
        .map_err(|error| format!("等待 ffmpeg 失败：{error}"))?;
    if !status.success() {
        let mut stderr = String::new();
        if let Some(mut pipe) = child.stderr.take() {
            let _ = pipe.read_to_string(&mut stderr);
        }
        return Err(format!("ffmpeg 波形解码失败：{}", stderr.trim()));
    }
    Ok(peaks(&bytes, buckets.max(1)))
}

fn peaks(bytes: &[u8], buckets: usize) -> Vec<f32> {
    let samples = bytes
        .as_chunks::<2>()
        .0
        .iter()
        .map(|pair| i16::from_le_bytes(*pair) as f32 / 32768.0)
        .collect::<Vec<_>>();
    if samples.is_empty() {
        return vec![0.0; buckets];
    }
    let mut result = Vec::with_capacity(buckets);
    for bucket in 0..buckets {
        let start = bucket * samples.len() / buckets;
        let end = ((bucket + 1) * samples.len() / buckets).max(start + 1);
        let peak = samples[start..end.min(samples.len())]
            .iter()
            .fold(0.0f32, |peak, sample| peak.max(sample.abs()));
        result.push(peak.min(1.0));
    }
    result
}

pub fn run(
    input: &Path,
    output: &Path,
    operation: &AudioOperation,
    format: AudioFormat,
    ctx: &JobContext,
) -> Result<(), String> {
    run_with(
        input,
        output,
        operation,
        format,
        |fraction, message| ctx.progress(fraction, message),
        |line| ctx.log(line),
        || ctx.is_canceled(),
    )
}

fn run_with<P, L, C>(
    input: &Path,
    output: &Path,
    operation: &AudioOperation,
    format: AudioFormat,
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
    let info = probe(input)?;
    let ffmpeg = ffmpeg_path()?;
    let filter = match operation {
        AudioOperation::Convert | AudioOperation::Extract => None,
        AudioOperation::Pitch { semitones } => Some(pitch_filter(info.sample_rate, *semitones)),
        AudioOperation::Speed { ratio } => Some(atempo_chain(*ratio)),
        AudioOperation::Trim { start, end } => {
            if *end <= *start || *start < 0.0 {
                return Err("裁剪区间无效".to_string());
            }
            Some(format!(
                "atrim=start={start:.3}:end={end:.3},asetpts=PTS-STARTPTS"
            ))
        }
        AudioOperation::Loudness { target_lufs } => {
            Some(format!("loudnorm=I={target_lufs}:TP=-1.5:LRA=11"))
        }
    };

    let mut command = quiet_command(&ffmpeg);
    command
        .args(["-hide_banner", "-nostdin", "-n", "-i"])
        .arg(input)
        .args(["-vn", "-map", "0:a:0", "-progress", "pipe:1", "-nostats"]);
    if let Some(filter) = &filter {
        command.args(["-af", filter]);
    }
    command.args(format.codec_args()).arg(output);
    log(format!("处理：{}", input.display()));
    progress(Some(0.02), "开始处理");
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("启动 ffmpeg 失败：{error}"))?;
    let stdout = child.stdout.take().expect("piped stdout");
    let (sender, receiver) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
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
    let mut last_seconds = 0.0;
    let mut status = None;
    loop {
        if canceled() {
            terminate(&mut child);
            let _ = std::fs::remove_file(output);
            return Err("已取消".to_string());
        }
        if started.elapsed() > Duration::from_secs(60 * 60) {
            terminate(&mut child);
            let _ = std::fs::remove_file(output);
            return Err("音频处理超时".to_string());
        }
        match receiver.recv_timeout(Duration::from_millis(100)) {
            Ok(line) => {
                if let Some(seconds) = progress_seconds(&line) {
                    last_seconds = seconds;
                }
                if line.starts_with("progress=") {
                    let fraction = if info.duration > 0.0 {
                        (last_seconds / info.duration).clamp(0.0, 0.98) as f32
                    } else {
                        0.5
                    };
                    progress(Some(fraction), &format!("处理中 {:.1}s", last_seconds));
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
            .map_err(|error| format!("等待 ffmpeg 失败：{error}"))?,
    };
    let stderr = stderr_reader.join().unwrap_or_default();
    if !status.success() {
        let _ = std::fs::remove_file(output);
        return Err(format!("ffmpeg 失败（{status}）：{}", stderr.trim()));
    }
    let size = std::fs::metadata(output)
        .map(|meta| meta.len())
        .unwrap_or(0);
    if size == 0 {
        let _ = std::fs::remove_file(output);
        return Err("ffmpeg 没有生成输出文件".to_string());
    }
    progress(Some(1.0), "处理完成");
    log(format!("输出：{}（{size} 字节）", output.display()));
    Ok(())
}

fn progress_seconds(line: &str) -> Option<f64> {
    let (key, value) = line.split_once('=')?;
    match key {
        "out_time_us" | "out_time_ms" => value
            .parse::<i64>()
            .ok()
            .map(|value| value as f64 / 1_000_000.0),
        "out_time" => parse_timestamp(value),
        _ => None,
    }
}

fn pitch_filter(sample_rate: u32, semitones: f32) -> String {
    let factor = 2f32.powf(semitones / 12.0);
    let rate = (sample_rate as f32 * factor).round().max(1.0) as u32;
    format!(
        "asetrate={rate},aresample={sample_rate},{}",
        atempo_chain(1.0 / factor)
    )
}

fn atempo_chain(ratio: f32) -> String {
    let mut remaining = ratio.clamp(0.001, 1000.0);
    let mut parts = Vec::new();
    while remaining > 2.0 {
        parts.push(2.0);
        remaining /= 2.0;
    }
    while remaining < 0.5 {
        parts.push(0.5);
        remaining /= 0.5;
    }
    parts.push(remaining);
    parts
        .into_iter()
        .map(|part| format!("atempo={part:.6}"))
        .collect::<Vec<_>>()
        .join(",")
}

fn terminate(child: &mut Child) {
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
    use std::io::Write;

    #[test]
    fn parses_ffmpeg_probe_output() {
        let text = "Input #0, wav, from 'test.wav':\n  Duration: 00:00:02.50, start: 0.000000, bitrate: 705 kb/s\n  Stream #0:0: Audio: pcm_s16le ([1][0][0][0] / 0x0001), 44100 Hz, mono, s16, 705 kb/s\n";
        let info = parse_probe(text).unwrap();
        assert_eq!(info.duration, 2.5);
        assert_eq!(info.sample_rate, 44100);
        assert_eq!(info.channels, 1);
        assert_eq!(info.codec, "pcm_s16le");
    }

    #[test]
    fn builds_atempo_chains_within_supported_range() {
        assert_eq!(atempo_chain(1.5), "atempo=1.500000");
        assert_eq!(atempo_chain(4.0), "atempo=2.000000,atempo=2.000000");
        assert_eq!(atempo_chain(0.25), "atempo=0.500000,atempo=0.500000");
    }

    #[test]
    fn waveform_peaks_keep_the_loudest_sample() {
        let samples = [0i16, 1000, -2000, 500];
        let bytes = samples
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect::<Vec<_>>();
        let peaks = peaks(&bytes, 2);
        assert!((peaks[0] - 1000.0 / 32768.0).abs() < 1e-6);
        assert!((peaks[1] - 2000.0 / 32768.0).abs() < 1e-6);
    }

    #[test]
    #[ignore = "requires tools/ffmpeg and writes to a temp directory"]
    fn runs_audio_operations_with_bundled_ffmpeg() {
        let dir = std::env::temp_dir().join(format!("vss-audio-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let input = dir.join("input.wav");
        write_test_wav(&input, 1.0);

        let info = probe(&input).unwrap();
        assert!((info.duration - 1.0).abs() < 0.05);
        assert_eq!(info.sample_rate, 44100);
        assert_eq!(info.channels, 1);

        let waveform = waveform_with(&input, 100, || false).unwrap();
        assert_eq!(waveform.len(), 100);
        assert!(waveform.iter().any(|peak| *peak > 0.1));

        let run = |name: &str, operation: AudioOperation, format: AudioFormat| {
            let output = dir.join(name);
            run_with(
                &input,
                &output,
                &operation,
                format,
                |_, _| {},
                |_| {},
                || false,
            )
            .unwrap();
            assert!(output.is_file());
            assert!(std::fs::metadata(&output).unwrap().len() > 0);
            output
        };

        run("converted.mp3", AudioOperation::Convert, AudioFormat::Mp3);
        let trimmed = run(
            "trimmed.wav",
            AudioOperation::Trim {
                start: 0.2,
                end: 0.7,
            },
            AudioFormat::Wav,
        );
        let trimmed_info = probe(&trimmed).unwrap();
        assert!((trimmed_info.duration - 0.5).abs() < 0.1);
        run(
            "pitched.wav",
            AudioOperation::Pitch { semitones: 2.0 },
            AudioFormat::Wav,
        );
        let sped = run(
            "sped.wav",
            AudioOperation::Speed { ratio: 1.5 },
            AudioFormat::Wav,
        );
        let sped_info = probe(&sped).unwrap();
        assert!((sped_info.duration - 2.0 / 3.0).abs() < 0.1);
        run(
            "loud.wav",
            AudioOperation::Loudness { target_lufs: -16.0 },
            AudioFormat::Wav,
        );
        let _ = std::fs::remove_dir_all(dir);
    }

    fn write_test_wav(path: &Path, seconds: f64) {
        let rate = 44100u32;
        let count = (rate as f64 * seconds) as u32;
        let mut data = Vec::with_capacity(count as usize * 2);
        for index in 0..count {
            let value =
                (index as f32 / rate as f32 * 440.0 * std::f32::consts::TAU).sin() * 0.3 * 32767.0;
            data.extend_from_slice(&(value as i16).to_le_bytes());
        }
        let mut file = std::fs::File::create(path).unwrap();
        file.write_all(b"RIFF").unwrap();
        file.write_all(&(36 + data.len() as u32).to_le_bytes())
            .unwrap();
        file.write_all(b"WAVEfmt ").unwrap();
        file.write_all(&16u32.to_le_bytes()).unwrap();
        file.write_all(&1u16.to_le_bytes()).unwrap();
        file.write_all(&1u16.to_le_bytes()).unwrap();
        file.write_all(&rate.to_le_bytes()).unwrap();
        file.write_all(&(rate * 2).to_le_bytes()).unwrap();
        file.write_all(&2u16.to_le_bytes()).unwrap();
        file.write_all(&16u16.to_le_bytes()).unwrap();
        file.write_all(b"data").unwrap();
        file.write_all(&(data.len() as u32).to_le_bytes()).unwrap();
        file.write_all(&data).unwrap();
    }
}
