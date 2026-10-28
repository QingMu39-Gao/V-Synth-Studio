//! Local vocal/instrumental separation with an embedded Python runtime and UVR
//! MDX-NET ONNX model.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use sha2::{Digest, Sha256};
use zip::ZipArchive;

use crate::services::jobs::JobContext;

const PYTHON_URL: &str =
    "https://mirrors.aliyun.com/python-release/windows/python-3.10.11-embed-amd64.zip";
const PYTHON_SHA: &str = "608619f8619075629c9c69f361352a0da6ed7e62f83a0e19c63e0ea32eb7629d";
const NUMPY_URL: &str = "https://mirrors.aliyun.com/pypi/packages/19/77/538f202862b9183f54108557bfda67e17603fc560c384559e769321c9d92/numpy-1.26.4-cp310-cp310-win_amd64.whl";
const NUMPY_SHA: &str = "b97fe8060236edf3662adfc2c633f56a08ae30560c56310562cb4f95500022d5";
const ORT_URL: &str = "https://mirrors.aliyun.com/pypi/packages/3c/d8/68b63dc86b502169d017a86fe8bc718f4b0055ef1f6895bfaddd04f2eead/onnxruntime-1.19.2-cp310-cp310-win_amd64.whl";
const ORT_SHA: &str = "17ed7382d2c58d4b7354fb2b301ff30b9bf308a1c7eac9546449cd122d21cae5";
const MODEL_URL: &str = "https://gh-proxy.com/https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/UVR-MDX-NET-Inst_HQ_3.onnx";
const MODEL_SHA: &str = "317554b07fe1ea5279a77f2b1520a41ea4b93432560c4ffd08792c30fddf9adc";
const MODEL_SIZE: u64 = 66_759_214;
const MODEL_NAME: &str = "UVR-MDX-NET-Inst_HQ_3.onnx";

const USER_AGENT: &str = "V-Synth-Studio";

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
        runtime_ready: runtime_ready(&base),
        model_ready: model_path(&base).is_file(),
    }
}

pub fn ensure_ready(ctx: &JobContext) -> Result<(), String> {
    let base = base_dir();
    fs::create_dir_all(base.join("cache")).map_err(|error| error.to_string())?;
    if !runtime_ready(&base) {
        ensure_runtime(&base, ctx)?;
    }
    if !model_path(&base).is_file() {
        ensure_model(&base, ctx)?;
    }
    Ok(())
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
    let python = base.join("runtime").join("python.exe");
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

fn ensure_runtime(base: &Path, ctx: &JobContext) -> Result<(), String> {
    let runtime = base.join("runtime");
    let site = runtime.join("Lib").join("site-packages");
    let cache = base.join("cache");
    fs::create_dir_all(&cache).map_err(|error| error.to_string())?;
    let _ = fs::remove_dir_all(&runtime);
    fs::create_dir_all(&site).map_err(|error| error.to_string())?;

    let python_zip = cache.join("python-3.10.11-embed-amd64.zip");
    fetch(
        PYTHON_URL,
        &python_zip,
        PYTHON_SHA,
        0,
        0.02,
        0.1,
        ctx,
        "Python 运行时",
    )?;
    ctx.progress(Some(0.12), "解压 Python 运行时");
    extract_zip(&python_zip, &runtime)?;

    let numpy = cache.join("numpy-1.26.4-cp310-cp310-win_amd64.whl");
    fetch(NUMPY_URL, &numpy, NUMPY_SHA, 0, 0.13, 0.06, ctx, "numpy")?;
    ctx.progress(Some(0.2), "安装 numpy");
    extract_zip(&numpy, &site)?;

    let ort = cache.join("onnxruntime-1.19.2-cp310-cp310-win_amd64.whl");
    fetch(ORT_URL, &ort, ORT_SHA, 0, 0.21, 0.06, ctx, "onnxruntime")?;
    ctx.progress(Some(0.28), "安装 onnxruntime");
    extract_zip(&ort, &site)?;

    fs::write(
        runtime.join("python310._pth"),
        "python310.zip\n.\nLib\\site-packages\nimport site\n",
    )
    .map_err(|error| format!("写入 Python 路径失败：{error}"))?;
    fs::write(base.join("backend.py"), include_str!("svsep_backend.py"))
        .map_err(|error| format!("写入分离后端失败：{error}"))?;
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
    fetch(
        MODEL_URL,
        &path,
        MODEL_SHA,
        MODEL_SIZE,
        0.25,
        0.5,
        ctx,
        "MDX-NET 模型",
    )
}

#[allow(clippy::too_many_arguments)]
fn fetch(
    url: &str,
    dest: &Path,
    sha256: &str,
    size_hint: u64,
    base: f32,
    span: f32,
    ctx: &JobContext,
    label: &str,
) -> Result<(), String> {
    if dest.is_file() && verify_sha256(dest, sha256)? {
        return Ok(());
    }
    let part = dest.with_extension("part");
    let _ = fs::remove_file(&part);
    ctx.log(format!("下载 {label}"));
    ctx.progress(Some(base), format!("下载 {label}"));
    let response = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(30)))
            .timeout_recv_body(Some(Duration::from_secs(60 * 60)))
            .build(),
    )
    .get(url)
    .header("User-Agent", USER_AGENT)
    .call()
    .map_err(|error| format!("下载 {label} 失败：{error}"))?;
    let total = response
        .body()
        .content_length()
        .filter(|length| *length > 0)
        .unwrap_or(size_hint);
    let mut reader = response.into_body().into_reader();
    let mut file = File::create(&part).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut downloaded = 0u64;
    let mut reported = 0u64;
    let mut buffer = [0u8; 256 * 1024];
    loop {
        if ctx.is_canceled() {
            drop(file);
            let _ = fs::remove_file(&part);
            return Err("已取消".to_string());
        }
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("下载 {label} 失败：{error}"))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|error| format!("写入 {label} 失败：{error}"))?;
        hasher.update(&buffer[..read]);
        downloaded += read as u64;
        if downloaded - reported >= 1024 * 1024 || downloaded == total {
            reported = downloaded;
            let fraction = if total > 0 {
                base + span * (downloaded as f32 / total as f32)
            } else {
                base
            };
            ctx.progress(
                Some(fraction.clamp(0.0, 0.99)),
                format!(
                    "下载 {label} {:.1} / {:.1} MB",
                    downloaded as f64 / 1_000_000.0,
                    total as f64 / 1_000_000.0
                ),
            );
        }
    }
    file.flush().map_err(|error| error.to_string())?;
    drop(file);
    let actual = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if !actual.eq_ignore_ascii_case(sha256) {
        let _ = fs::remove_file(&part);
        return Err(format!("{label} 校验失败"));
    }
    fs::rename(&part, dest).map_err(|error| format!("保存 {label} 失败：{error}"))?;
    Ok(())
}

fn extract_zip(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = File::open(archive).map_err(|error| error.to_string())?;
    let mut zip = ZipArchive::new(file).map_err(|error| format!("解析压缩包失败：{error}"))?;
    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|error| format!("读取压缩包失败：{error}"))?;
        let name = entry
            .name()
            .map_err(|error| format!("压缩包名称无效：{error}"))?
            .into_owned();
        let Some(relative) = safe_relative(&name) else {
            continue;
        };
        let target = dest.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|error| error.to_string())?;
            continue;
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(format!("压缩包包含符号链接：{name}"));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut output = File::create(&target)
            .map_err(|error| format!("创建文件失败（{}）：{error}", target.display()))?;
        std::io::copy(&mut entry, &mut output)
            .map_err(|error| format!("解压失败（{}）：{error}", target.display()))?;
    }
    Ok(())
}

fn verify_sha256(path: &Path, expected: &str) -> Result<bool, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 256 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
        .eq_ignore_ascii_case(expected))
}

fn runtime_ready(base: &Path) -> bool {
    base.join("runtime").join("python.exe").is_file()
        && base
            .join("runtime")
            .join("Lib")
            .join("site-packages")
            .join("numpy")
            .is_dir()
        && base
            .join("runtime")
            .join("Lib")
            .join("site-packages")
            .join("onnxruntime")
            .is_dir()
        && base.join("backend.py").is_file()
}

fn base_dir() -> PathBuf {
    crate::config::app_root().join("data").join("svsep")
}

fn model_path(base: &Path) -> PathBuf {
    base.join("models").join(MODEL_NAME)
}

fn safe_relative(name: &str) -> Option<PathBuf> {
    let mut clean = PathBuf::new();
    for component in Path::new(name).components() {
        match component {
            Component::Normal(part) => clean.push(part),
            Component::CurDir => {}
            _ => return None,
        }
    }
    (!clean.as_os_str().is_empty()).then_some(clean)
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
    use super::*;

    #[test]
    fn rejects_unsafe_archive_paths() {
        assert!(safe_relative("../evil").is_none());
        assert!(safe_relative("/abs").is_none());
        assert_eq!(
            safe_relative("numpy/__init__.py"),
            Some(PathBuf::from("numpy/__init__.py"))
        );
    }

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
