//! 音频工具（依赖外部 ffmpeg，不随程序分发）
//!
//! 对应 Node 的 `core/audio.mjs`：格式转换、从视频提取音频、变调、变速、裁剪、响度标准化。
//! ffmpeg 缺失时所有函数都会抛出带引导的中文错误。
//!
//! 子进程一律走 `quiet_command`（Windows 下不弹黑框），stderr 边读边解析 `time=`，
//! 顺便每 200ms 查一次取消标志 —— 前端「取消」按钮要能立刻掐掉 ffmpeg。

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde_json::{json, Map, Value};
use tokio::io::AsyncReadExt;

/// 取消检查（和 net::Cancel 是同一个东西，这里重新导出省得调用方两处引）
pub use crate::net::{Cancel, CANCELED};

pub type Progress = dyn Fn(f64, f64) + Send + Sync; // (percent, seconds)

/// 查找 ffmpeg（程序目录优先，其次 PATH）
pub fn find_ffmpeg(tools_dir: &Path) -> Option<PathBuf> {
    let exe = crate::tools::exe("ffmpeg");
    let candidates = [
        tools_dir.join("ffmpeg").join("bin").join(&exe),
        tools_dir.join(&exe),
    ];
    for p in candidates {
        if p.is_file() {
            return Some(p);
        }
    }
    crate::platform::find_binary("ffmpeg", &[])
}

/// ffprobe 路径（与 ffmpeg 同目录）
fn ffprobe_path(ffmpeg: &Path) -> Option<PathBuf> {
    let candidate = ffmpeg.parent()?.join(crate::tools::exe("ffprobe"));
    candidate.is_file().then_some(candidate)
}

fn ffmpeg_error() -> String {
    "未找到 ffmpeg。音频工具需要它：请在「设置 → 外部工具」一键获取，或自行安装后把 ffmpeg.exe 放入 tools 目录。"
        .to_string()
}

/* ══════════════════════════════════ 基础执行 ══════════════════════════════════ */

/// 起一个无窗口的 tokio 子进程
///
/// 这里用 tokio 的 Command 而不是 `quiet_command`：ffmpeg 要一边读 stderr 一边
/// 响应取消（kill），同步 Command 会把 tokio 的工作线程堵死。
/// tokio 的 Command 在 Windows 上自带 `creation_flags`，效果和 quiet_command 一样。
fn tokio_command(program: &Path) -> tokio::process::Command {
    let mut c = tokio::process::Command::new(program);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// 跑 ffprobe 并把 stdout 收回来
async fn run_capture(program: &Path, args: &[&str]) -> Option<(i32, String)> {
    let mut cmd = tokio_command(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let out = cmd.output().await.ok()?;
    Some((
        out.status.code().unwrap_or(0),
        String::from_utf8_lossy(&out.stdout).to_string(),
    ))
}

/// 运行 ffmpeg，解析进度。返回 Err 时是给人看的完整原因。
pub async fn run_ffmpeg(
    tools_dir: &Path,
    args: &[String],
    duration_sec: f64,
    cancel: &Cancel,
    on_progress: &Progress,
) -> Result<(), String> {
    let bin = find_ffmpeg(tools_dir).ok_or_else(ffmpeg_error)?;

    let mut cmd = tokio_command(&bin);
    cmd.arg("-hide_banner").arg("-y");
    for a in args {
        cmd.arg(a);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动 ffmpeg：{e}"))?;
    let mut stderr = child.stderr.take().ok_or("无法读取 ffmpeg 输出")?;

    let mut collected = String::new();
    let mut carry = String::new();
    let mut buf = vec![0u8; 8192];
    let mut canceled = false;

    loop {
        if cancel() {
            canceled = true;
            break;
        }
        match tokio::time::timeout(std::time::Duration::from_millis(200), stderr.read(&mut buf))
            .await
        {
            Ok(Ok(0)) => break, // EOF
            Ok(Ok(n)) => {
                let text = String::from_utf8_lossy(&buf[..n]).to_string();
                if duration_sec > 0.0 {
                    // ffmpeg 的进度用 \r 覆盖同一行，所以要按块解析，
                    // 并把上一块的尾巴接上，免得 time=xx:xx:0 被切成两半
                    let joined = format!("{carry}{text}");
                    if let Some(sec) = last_time_seconds(&joined) {
                        on_progress(((sec / duration_sec) * 100.0).min(99.0), sec);
                    }
                    carry = tail_chars(&joined, 32);
                }
                collected.push_str(&text);
                if collected.len() > 40000 {
                    collected = tail_chars(&collected, 20000);
                }
            }
            Ok(Err(_)) => break,
            Err(_) => {} // 超时，回去看取消标志
        }
    }

    if canceled {
        let _ = child.kill().await;
        return Err(CANCELED.to_string());
    }

    let status = child.wait().await.map_err(|e| e.to_string())?;
    let code = status.code().unwrap_or(-1);
    if code == 0 {
        return Ok(());
    }

    // 和 Node 版一样的收尾：取最后 3 行非空内容
    let lines: Vec<&str> = collected
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .filter(|l| !l.is_empty())
        .collect();
    let tail: Vec<&str> = lines.iter().rev().take(3).rev().copied().collect();
    let detail: String = tail.join(" | ").chars().take(500).collect();
    Err(format!("ffmpeg 执行失败（退出码 {code}）：{detail}"))
}

/// 取字符串最后 n 个字符
fn tail_chars(s: &str, n: usize) -> String {
    let count = s.chars().count();
    if count <= n {
        return s.to_string();
    }
    s.chars().skip(count - n).collect()
}

/// 找最后一个 `time=H:MM:SS.ss` 并换成秒（等价于 Node 那条正则）
fn last_time_seconds(text: &str) -> Option<f64> {
    let mut found = None;
    let mut rest = text;
    while let Some(idx) = rest.find("time=") {
        let after = &rest[idx + 5..];
        if let Some(sec) = parse_hms(after) {
            found = Some(sec);
        }
        rest = &rest[idx + 5..];
        if rest.is_empty() {
            break;
        }
    }
    found
}

/// `H:MM:SS.ss` → 秒
fn parse_hms(s: &str) -> Option<f64> {
    let mut parts = s.splitn(3, ':');
    let h: u64 = parts.next()?.parse().ok()?;
    let m: u64 = parts.next()?.parse().ok()?;
    let rest = parts.next()?;
    // 秒必须带小数（和 Node 的 `\d+\.\d+` 一致）
    let digits: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    if !digits.contains('.') {
        return None;
    }
    let sec: f64 = digits.parse().ok()?;
    Some(h as f64 * 3600.0 + m as f64 * 60.0 + sec)
}

/* ══════════════════════════════════ 媒体信息 ══════════════════════════════════ */

/// 读取媒体信息。形状和 Node 的 probeMedia 完全一致（缺 ffmpeg 时 available:false）。
pub async fn probe_media(tools_dir: &Path, input: &str) -> Value {
    let Some(ffmpeg) = find_ffmpeg(tools_dir) else {
        return json!({ "available": false });
    };
    let Some(ffprobe) = ffprobe_path(&ffmpeg) else {
        return json!({
            "available": true,
            "probed": false,
            "note": "缺少 ffprobe，无法读取详细媒体信息",
        });
    };

    let Some((code, stdout)) = run_capture(
        &ffprobe,
        &[
            "-v",
            "quiet",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            input,
        ],
    )
    .await
    else {
        return json!({ "available": true, "probed": false, "note": "读取媒体信息失败" });
    };
    if code != 0 {
        return json!({ "available": true, "probed": false, "note": "读取媒体信息失败" });
    }

    let Ok(info) = serde_json::from_str::<Value>(&stdout) else {
        return json!({ "available": true, "probed": false, "note": "解析媒体信息失败" });
    };

    let streams = info
        .get("streams")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    let audio = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(|v| v.as_str()) == Some("audio"));
    let video = streams
        .iter()
        .find(|s| s.get("codec_type").and_then(|v| v.as_str()) == Some("video"));
    let format = info.get("format").cloned().unwrap_or(json!({}));

    /*
     * ffprobe 的数值字段**是字符串**（"1.000000"、"44100"、"88278"），
     * Node 那边靠 `Number(...)` 转过来，这里也得转 —— 直接 as_f64 会全变成 0。
     */
    let num = |v: Option<&Value>| match v {
        Some(Value::Number(n)) => n.as_f64().unwrap_or(0.0),
        Some(Value::String(s)) => s.trim().parse::<f64>().unwrap_or(0.0),
        _ => 0.0,
    };

    let mut out = Map::new();
    out.insert("available".into(), json!(true));
    out.insert("probed".into(), json!(true));
    out.insert("durationSec".into(), json!(num(format.get("duration"))));
    out.insert("sizeBytes".into(), json!(num(format.get("size"))));
    out.insert("bitrate".into(), json!(num(format.get("bit_rate"))));
    out.insert(
        "formatName".into(),
        json!(format.get("format_name").and_then(|v| v.as_str()).unwrap_or("")),
    );
    out.insert(
        "audio".into(),
        match audio {
            Some(a) => json!({
                "codec": a.get("codec_name").and_then(|v| v.as_str()).unwrap_or(""),
                "sampleRate": num(a.get("sample_rate")),
                "channels": num(a.get("channels")),
                "bitrate": num(a.get("bit_rate")),
            }),
            None => Value::Null,
        },
    );
    out.insert(
        "video".into(),
        match video {
            Some(v) => json!({
                "codec": v.get("codec_name").and_then(|v| v.as_str()).unwrap_or(""),
                "width": num(v.get("width")),
                "height": num(v.get("height")),
                "fps": v.get("r_frame_rate").and_then(|x| x.as_str()).unwrap_or(""),
            }),
            None => Value::Null,
        },
    );
    Value::Object(out)
}

/* ══════════════════════════════════ 具体操作 ══════════════════════════════════ */

fn opt_str(args: &Map<String, Value>, key: &str) -> Option<String> {
    args.get(key).and_then(|v| v.as_str()).map(String::from)
}

fn opt_num(args: &Map<String, Value>, key: &str) -> Option<f64> {
    args.get(key).and_then(|v| v.as_f64())
}

/// 取输出路径，并顺手建好上级目录
fn prepare_out(args: &Map<String, Value>) -> Result<String, String> {
    let output = opt_str(args, "output").unwrap_or_default();
    if let Some(dir) = Path::new(&output).parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    Ok(output)
}

fn require_input(args: &Map<String, Value>) -> Result<String, String> {
    let input = opt_str(args, "input").unwrap_or_default();
    if !Path::new(&input).exists() {
        return Err(format!("找不到输入文件：{input}"));
    }
    Ok(input)
}

/// 转换音频格式（导出 WAV / MP3 / FLAC ...）
pub async fn convert_audio(
    tools_dir: &Path,
    args: &Map<String, Value>,
    cancel: &Cancel,
    on_progress: &Progress,
) -> Result<Value, String> {
    let input = require_input(args)?;
    let format = opt_str(args, "format").unwrap_or_else(|| "wav".to_string());
    let output = prepare_out(args)?;

    let formats = crate::data::audio_formats();
    let preset = formats
        .get(&format)
        .ok_or_else(|| format!("不支持的输出格式：{format}"))?;
    let preset_args: Vec<String> = preset
        .get("args")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    let info = probe_media(tools_dir, &input).await;
    let duration = info.get("durationSec").and_then(|v| v.as_f64()).unwrap_or(0.0);

    let mut ff: Vec<String> = vec!["-i".into(), input.clone(), "-vn".into()];
    ff.extend(preset_args);
    if let Some(sr) = opt_num(args, "sampleRate") {
        if sr != 0.0 {
            ff.push("-ar".into());
            ff.push(num_text(sr));
        }
    }
    if let Some(ch) = opt_num(args, "channels") {
        if ch != 0.0 {
            ff.push("-ac".into());
            ff.push(num_text(ch));
        }
    }
    ff.push(output.clone());

    run_ffmpeg(tools_dir, &ff, duration, cancel, on_progress).await?;

    Ok(json!({ "output": output, "format": format, "info": info }))
}

/// JS 的 String(数字)：整数不带小数点
fn num_text(n: f64) -> String {
    if n.fract() == 0.0 {
        format!("{}", n as i64)
    } else {
        format!("{n}")
    }
}

/// 从视频中提取音频（保存 MV 的音轨）
pub async fn extract_audio(
    tools_dir: &Path,
    args: &Map<String, Value>,
    cancel: &Cancel,
    on_progress: &Progress,
) -> Result<Value, String> {
    convert_audio(tools_dir, args, cancel, on_progress).await
}

/// 变调（保持时长）：asetrate + aresample + atempo
pub async fn shift_pitch(
    tools_dir: &Path,
    args: &Map<String, Value>,
    cancel: &Cancel,
    on_progress: &Progress,
) -> Result<Value, String> {
    let input = require_input(args)?;
    let semitones = opt_num(args, "semitones").unwrap_or(0.0);
    if semitones == 0.0 {
        return Err("变调量不能为 0".to_string());
    }
    let output = prepare_out(args)?;

    let info = probe_media(tools_dir, &input).await;
    let sr = info
        .get("audio")
        .and_then(|a| a.get("sampleRate"))
        .and_then(|v| v.as_f64())
        .filter(|v| *v != 0.0)
        .unwrap_or(44100.0);
    let ratio = 2f64.powf(semitones / 12.0);
    let filters = format!(
        "asetrate={},aresample={},atempo={:.6}",
        (sr * ratio).round() as i64,
        num_text(sr),
        1.0 / ratio
    );
    let duration = info.get("durationSec").and_then(|v| v.as_f64()).unwrap_or(0.0);

    run_ffmpeg(
        tools_dir,
        &[
            "-i".into(),
            input,
            "-vn".into(),
            "-filter:a".into(),
            filters,
            output.clone(),
        ],
        duration,
        cancel,
        on_progress,
    )
    .await?;

    Ok(json!({ "output": output, "semitones": semitones, "ratio": ratio }))
}

/// 变速（保持音高）
pub async fn change_tempo(
    tools_dir: &Path,
    args: &Map<String, Value>,
    cancel: &Cancel,
    on_progress: &Progress,
) -> Result<Value, String> {
    let input = require_input(args)?;
    let ratio = opt_num(args, "ratio").unwrap_or(1.0);
    if !(ratio > 0.0) {
        return Err("速度比例不合法".to_string());
    }
    let output = prepare_out(args)?;

    let info = probe_media(tools_dir, &input).await;
    let duration = info.get("durationSec").and_then(|v| v.as_f64()).unwrap_or(0.0);

    // atempo 单次只支持 0.5~2.0，超出需要串联
    let mut chain: Vec<String> = Vec::new();
    let mut remaining = ratio;
    while remaining > 2.0 {
        chain.push("atempo=2".into());
        remaining /= 2.0;
    }
    while remaining < 0.5 {
        chain.push("atempo=0.5".into());
        remaining /= 0.5;
    }
    chain.push(format!("atempo={remaining:.6}"));

    run_ffmpeg(
        tools_dir,
        &[
            "-i".into(),
            input,
            "-vn".into(),
            "-filter:a".into(),
            chain.join(","),
            output.clone(),
        ],
        duration,
        cancel,
        on_progress,
    )
    .await?;

    Ok(json!({ "output": output, "ratio": ratio }))
}

/// 裁剪片段
pub async fn trim_audio(
    tools_dir: &Path,
    args: &Map<String, Value>,
    cancel: &Cancel,
    on_progress: &Progress,
) -> Result<Value, String> {
    let input = require_input(args)?;
    let start_sec = opt_num(args, "startSec").unwrap_or(0.0);
    let end_sec = opt_num(args, "endSec");
    let output = prepare_out(args)?;

    let mut ff: Vec<String> = vec!["-i".into(), input];
    if start_sec != 0.0 {
        ff.push("-ss".into());
        ff.push(num_text(start_sec));
    }
    if let Some(end) = end_sec.filter(|v| *v != 0.0) {
        ff.push("-to".into());
        ff.push(num_text(end));
    }
    ff.push("-vn".into());
    ff.push("-c:a".into());
    ff.push("pcm_s16le".into());
    ff.push(output.clone());

    let duration = end_sec.unwrap_or(0.0) - start_sec;
    run_ffmpeg(tools_dir, &ff, duration, cancel, on_progress).await?;

    let mut out = Map::new();
    out.insert("output".into(), json!(output));
    out.insert("startSec".into(), json!(start_sec));
    if let Some(end) = end_sec {
        out.insert("endSec".into(), json!(end));
    }
    Ok(Value::Object(out))
}

/// 响度标准化（把伴奏/干声拉到统一响度，方便对轨）
pub async fn normalize_loudness(
    tools_dir: &Path,
    args: &Map<String, Value>,
    cancel: &Cancel,
    on_progress: &Progress,
) -> Result<Value, String> {
    let input = require_input(args)?;
    let target_lufs = opt_num(args, "targetLufs").unwrap_or(-14.0);
    let output = prepare_out(args)?;

    let info = probe_media(tools_dir, &input).await;
    let duration = info.get("durationSec").and_then(|v| v.as_f64()).unwrap_or(0.0);

    run_ffmpeg(
        tools_dir,
        &[
            "-i".into(),
            input,
            "-vn".into(),
            "-filter:a".into(),
            format!("loudnorm=I={}:TP=-1.5:LRA=11", num_text(target_lufs)),
            "-c:a".into(),
            "pcm_s16le".into(),
            output.clone(),
        ],
        duration,
        cancel,
        on_progress,
    )
    .await?;

    Ok(json!({ "output": output, "targetLufs": target_lufs }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ffmpeg_progress_like_the_node_regex() {
        assert_eq!(last_time_seconds("time=00:00:01.23"), Some(1.23));
        assert_eq!(last_time_seconds("frame=1 time=01:02:03.50 fps=0"), Some(3723.5));
        // 取最后一个（进度是不断覆盖的）
        assert_eq!(
            last_time_seconds("time=00:00:01.00 xtime=00:00:09.00 y"),
            Some(9.0)
        );
        // 没有小数就不算（Node 的正则要求 \d+\.\d+）
        assert_eq!(last_time_seconds("time=00:00:01"), None);
        assert_eq!(last_time_seconds("nothing here"), None);
    }

    #[test]
    fn num_text_matches_js_string_conversion() {
        assert_eq!(num_text(44100.0), "44100");
        assert_eq!(num_text(1.25), "1.25");
        assert_eq!(num_text(-14.0), "-14");
    }
}
