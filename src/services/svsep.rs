//! Local vocal/instrumental separation with an embedded Python runtime and UVR
//! MDX-NET ONNX model.

use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use crate::services::download;
use crate::services::jobs::JobContext;
use crate::services::python;

const MODEL_URL: &str = "https://gh-proxy.com/https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-MDX-NET-Inst_HQ_3.onnx";
const MODEL_SHA: &str = "317554b07fe1ea5279a77f2b1520a41ea4b93432560c4ffd08792c30fddf9adc";
const MODEL_SIZE: u64 = 66_759_214;
const MODEL_NAME: &str = "UVR-MDX-NET-Inst_HQ_3.onnx";

#[derive(Debug, Clone, Copy)]
pub struct Status {
    pub runtime_ready: bool,
    pub model_ready: bool,
}

#[derive(Debug, Clone)]
pub struct Stems {
    pub vocals: PathBuf,
    pub instrumental: PathBuf,
}

pub fn status() -> Status {
    let base = base_dir();
    Status {
        runtime_ready: python::ready(),
        model_ready: model_path(&base).is_file(),
    }
}

pub fn ensure_ready(ctx: &JobContext) -> Result<(), String> {
    let base = base_dir();
    fs::create_dir_all(base.join("cache")).map_err(|error| error.to_string())?;
    python::ensure(ctx, 0.0, 0.24)?;
    write_backend(&base)?;
    if !model_path(&base).is_file() {
        ensure_model(&base, ctx)?;
    }
    Ok(())
}

fn write_backend(base: &Path) -> Result<(), String> {
    let path = base.join("backend.py");
    let source = include_str!("svsep_backend.py");
    if fs::read_to_string(&path).ok().as_deref() == Some(source) {
        return Ok(());
    }
    fs::create_dir_all(base).map_err(|error| error.to_string())?;
    fs::write(&path, source).map_err(|error| format!("写入分离后端失败：{error}"))
}

pub fn separate(input: &Path, output_dir: &Path, ctx: &JobContext) -> Result<Stems, String> {
    if !input.is_file() {
        return Err(format!("输入文件不存在：{}", input.display()));
    }
    ensure_ready(ctx)?;
    let base = base_dir();
    let temp = base.join("tmp").join(format!(
        "{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_nanos())
            .unwrap_or(0)
    ));
    fs::create_dir_all(&temp).map_err(|error| error.to_string())?;
    let model = model_path(&base);
    let python = python::exe();
    let backend = base.join("backend.py");
    let wav = temp.join("input.wav");

    ctx.progress(Some(0.76), "准备音频");
    let convert = quiet_command(&crate::services::audio::ffmpeg_path()?)
        .args(["-hide_banner", "-nostdin", "-y", "-i"])
        .arg(input)
        .args(["-vn", "-ac", "2", "-ar", "44100", "-c:a", "pcm_s16le"])
        .arg(&wav)
        .output()
        .map_err(|error| format!("启动 ffmpeg 失败：{error}"))?;
    if !convert.status.success() {
        let _ = fs::remove_dir_all(&temp);
        return Err(format!(
            "音频转换失败：{}",
            String::from_utf8_lossy(&convert.stderr).trim()
        ));
    }

    ctx.progress(Some(0.8), "启动分离引擎");
    let mut child = quiet_command(&python)
        .env("PYTHONUTF8", "1")
        .arg(&backend)
        .args(["--input", wav.to_string_lossy().as_ref()])
        .args(["--model", model.to_string_lossy().as_ref()])
        .args(["--output-dir", temp.to_string_lossy().as_ref()])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("启动分离引擎失败：{error}"))?;
    let stdout = child.stdout.take().expect("piped stdout");
    let (sender, receiver) = mpsc::channel::<String>();
    std::thread::spawn(move || {
        use std::io::BufRead;
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
        if started.elapsed() > Duration::from_secs(60 * 60) {
            terminate(&mut child);
            let _ = fs::remove_dir_all(&temp);
            return Err("分离超时".to_string());
        }
        match receiver.recv_timeout(Duration::from_millis(200)) {
            Ok(line) => {
                if let Some(rest) = line.strip_prefix("PROGRESS ")
                    && let Some((fraction, message)) = rest.split_once(' ')
                    && let Ok(fraction) = fraction.parse::<f32>()
                {
                    ctx.progress(
                        Some(0.8 + fraction.clamp(0.0, 1.0) * 0.17),
                        format!("分离中 {message}"),
                    );
                } else if line.starts_with("chunks=") || line.starts_with("model_input=") {
                    ctx.log(line);
                } else if line == "DONE" {
                    ctx.progress(Some(0.98), "写入音轨");
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
            .map_err(|error| format!("等待分离引擎失败：{error}"))?,
    };
    let stderr = stderr_reader.join().unwrap_or_default();
    let vocals = temp.join("vocals.wav");
    let instrumental = temp.join("instrumental.wav");
    if !status.success() || !vocals.is_file() || !instrumental.is_file() {
        let _ = fs::remove_dir_all(&temp);
        return Err(format!("分离失败：{}", stderr.trim()));
    }
    fs::create_dir_all(output_dir)
        .map_err(|error| format!("创建输出目录失败（{}）：{error}", output_dir.display()))?;
    let stem = input
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_else(|| "audio".to_string());
    let vocals_out = unique_path(output_dir, &format!("{stem}_vocals.wav"));
    let instrumental_out = unique_path(output_dir, &format!("{stem}_instrumental.wav"));
    move_file(&vocals, &vocals_out)?;
    move_file(&instrumental, &instrumental_out)?;
    let _ = fs::remove_dir_all(&temp);
    ctx.progress(Some(1.0), "分离完成");
    Ok(Stems {
        vocals: vocals_out,
        instrumental: instrumental_out,
    })
}

pub fn ensure_model_only(ctx: &JobContext) -> Result<(), String> {
    let base = base_dir();
    fs::create_dir_all(base.join("cache")).map_err(|error| error.to_string())?;
    ensure_model(&base, ctx)
}

pub fn model_file() -> PathBuf {
    model_path(&base_dir())
}

/// Install the MDX model from a file the user already has.
pub fn import_model(source: &Path, ctx: &JobContext) -> Result<(), String> {
    if !source.is_file() {
        return Err(format!("文件不存在：{}", source.display()));
    }
    ctx.progress(Some(0.1), "校验本地模型");
    if !download::verify_sha256(source, MODEL_SHA)? {
        return Err(crate::i18n::t().err_import_hash.replace("{0}", MODEL_NAME));
    }
    let path = model_file();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    ctx.progress(Some(0.6), "复制本地模型");
    fs::copy(source, &path)
        .map(|_| ())
        .map_err(|error| format!("复制模型失败（{}）：{error}", path.display()))?;
    ctx.log(format!("已安装到 {}", path.display()));
    ctx.progress(Some(1.0), "模型已就绪");
    Ok(())
}

fn ensure_model(base: &Path, ctx: &JobContext) -> Result<(), String> {
    let path = model_path(base);
    if path.is_file() {
        return Ok(());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    download::fetch_all(
        &download::candidate_urls(MODEL_URL, &[]),
        &path,
        MODEL_SHA,
        MODEL_SIZE,
        0.25,
        0.5,
        ctx,
        "MDX-NET 模型",
    )
}

fn base_dir() -> PathBuf {
    crate::config::extensions_root().join("svsep")
}

fn model_path(base: &Path) -> PathBuf {
    base.join("models").join(MODEL_NAME)
}

fn unique_path(directory: &Path, name: &str) -> PathBuf {
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .map(|stem| stem.to_string_lossy().to_string())
        .unwrap_or_else(|| "audio".to_string());
    let extension = path
        .extension()
        .map(|extension| extension.to_string_lossy().to_string())
        .unwrap_or_else(|| "wav".to_string());
    let mut candidate = directory.join(name);
    let mut index = 1;
    while candidate.exists() {
        candidate = directory.join(format!("{stem}-{index}.{extension}"));
        index += 1;
    }
    candidate
}

fn move_file(from: &Path, to: &Path) -> Result<(), String> {
    fs::rename(from, to)
        .or_else(|_| {
            fs::copy(from, to)
                .map(|_| ())
                .and_then(|_| fs::remove_file(from))
        })
        .map_err(|error| format!("移动音轨失败（{}）：{error}", to.display()))
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
    use std::fs::File;
    use std::io::Write;

    use super::*;

    #[test]
    #[ignore = "requires the prepared runtime and MDX model"]
    fn separates_synthetic_audio() {
        let dir = std::env::temp_dir().join(format!("vss-svsep-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let input = dir.join("mix.wav");
        write_test_wav(&input, 2.0);
        let output = dir.join("out");
        let job_output = output.clone();
        let (jobs, _events) = crate::services::jobs::Jobs::new();
        let job = jobs.start("separate", move |ctx| {
            separate(&input, &job_output, &ctx).map(|_| ())
        });
        match job.result.recv_blocking().unwrap() {
            crate::services::jobs::JobOutcome::Done(()) => {}
            other => panic!("{other:?}"),
        }
        assert!(output.join("mix_vocals.wav").is_file());
        assert!(output.join("mix_instrumental.wav").is_file());
        let _ = fs::remove_dir_all(dir);
    }

    fn write_test_wav(path: &Path, seconds: f64) {
        let rate = 44100u32;
        let count = (rate as f64 * seconds) as u32;
        let mut data = Vec::with_capacity(count as usize * 4);
        for index in 0..count {
            let left = (index as f32 / rate as f32 * 440.0 * std::f32::consts::TAU).sin() * 0.2;
            let right = (index as f32 / rate as f32 * 660.0 * std::f32::consts::TAU).sin() * 0.2;
            data.extend_from_slice(&((left * 32767.0) as i16).to_le_bytes());
            data.extend_from_slice(&((right * 32767.0) as i16).to_le_bytes());
        }
        let mut file = File::create(path).unwrap();
        file.write_all(b"RIFF").unwrap();
        file.write_all(&(36 + data.len() as u32).to_le_bytes())
            .unwrap();
        file.write_all(b"WAVEfmt ").unwrap();
        file.write_all(&16u32.to_le_bytes()).unwrap();
        file.write_all(&1u16.to_le_bytes()).unwrap();
        file.write_all(&2u16.to_le_bytes()).unwrap();
        file.write_all(&rate.to_le_bytes()).unwrap();
        file.write_all(&(rate * 4).to_le_bytes()).unwrap();
        file.write_all(&4u16.to_le_bytes()).unwrap();
        file.write_all(&16u16.to_le_bytes()).unwrap();
        file.write_all(b"data").unwrap();
        file.write_all(&(data.len() as u32).to_le_bytes()).unwrap();
        file.write_all(&data).unwrap();
    }
}
