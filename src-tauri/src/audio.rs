//! 音频工具（依赖外部的 ffmpeg —— 它**随包分发**在 `tools/ffmpeg/`，不联网下载）。
//! 格式转换、从视频提取音频、变调、变速、裁剪、响度标准化。
//! ffmpeg 缺失时所有函数都会抛出带引导的中文错误。
//!
//! 子进程一律走 `quiet_command`（Windows 下不弹黑框），stderr 边读边解析 `time=`，
//! 顺便每 200ms 查一次取消标志 —— 前端「取消」按钮要能立刻掐掉 ffmpeg。

use std::path::{Path, PathBuf};
use std::process::Stdio;

use serde_json::{Map, Value, json};
use tokio::io::AsyncReadExt;

/// 取消检查（和 net::Cancel 是同一个东西，这里重新导出省得调用方两处引）
pub use crate::net::{CANCELED, Cancel};

pub type Progress = dyn Fn(f64, f64) + Send + Sync; // (percent, seconds)

/// 查找 ffmpeg。
///
/// 收的是**程序根** `root`（不是 `tools/`）—— 候选位置（`tools/ffmpeg/bin` 与
/// `tools/`）与「找不到就退回系统 PATH」都只在 `artifact::ARTIFACTS` 的 `ffmpeg`
/// 那条里声明一次。
///
/// ⚠️ 找 ffmpeg **只能按完整 root 拼**，别靠父目录反推（`root.parent()` 那种
/// 猜法）：传进来任何不以 `tools` 结尾的目录都会**静默失效** —— 找不到 ffmpeg、
/// 也不报错，用户只看到「未找到 ffmpeg」。
pub fn find_ffmpeg(root: &Path) -> Option<PathBuf> {
    crate::artifact::path_in_root(root, "ffmpeg", 0)
}

fn ffmpeg_error() -> String {
    "未找到 ffmpeg：tools 目录缺失，请重新解压程序包。".to_string()
}

/* ══════════════════ 从 ffmpeg 的 stderr 里读媒体信息 ══════════════════════

   **只用 `ffmpeg -i`**（不带输出文件）读媒体信息，不引 `ffprobe.exe`：

     * Windows 的 gyan 静态包里 ffmpeg.exe 与 ffprobe.exe **各自内嵌一份**
       FFmpeg（各几十 MB）。Linux 上它们是共享库的薄壳（428KB / 202KB），
       所以「省一个 exe」在 Windows 上才是真省体积。

   ⚠️ 三个必须记住的坑：

   ① **不能拿退出码当判据**。`ffmpeg -i <文件>` 只探测时**恒定返回 1**
      （末尾那句 "At least one output file must be specified"），文件好好的
      也是 1。判据只能是「stderr 里有没有 `Input #0`」。

   ② **不能改用 `-f null -` 换退出码**。那会**真的解码一遍**：同一个 5 分钟
      720p 文件，纯 `-i` 探测 0.038s，`-f null -` 要 1.081s（ffprobe 是
      0.035s）—— 开销随文件时长线性增长，两小时的视频要几分钟。

   ③ **`Input #0` / `Stream #` 的行格式随版本变**，所以下面只认最稳的几段：
      容器名取第一个逗号之前、`Duration:` 行按固定位置切、`Stream` 行的
      「音频/视频 + 分辨率 + Hz + 声道」用「先定位关键字再取邻近词」而不是
      整行正则 —— 因为中间那段编码器说明可以带逗号和括号（例如
      `h264 (High 4:4:4 Predictive) (avc1 / 0x31637661), yuv444p(progressive)`）。
*/

/// 容器名：取 `Input #0, <这些>, from ...` 里那一段。
///
/// ⚠️ 这一串是**别名列表**（mp4 上是 `mov,mp4,m4a,3gp,3g2,mj2`），可多可单。
/// 取值办法是「第一个逗号之前」，所以单名（`Input #0, mp3, from`）也不会切错。
fn container_of(stderr: &str) -> String {
    for line in stderr.lines() {
        let Some(rest) = line.strip_prefix("Input #") else {
            continue;
        };
        // `0, mov,mp4,..., from 'x'` → 去掉序号，再切到 `, from`
        let Some((_, tail)) = rest.split_once(", ") else {
            continue;
        };
        let name = tail.split(", from").next().unwrap_or(tail);
        return name.trim().to_string();
    }
    String::new()
}

/// `Duration: 00:00:03.00, start: ...` → 秒。
///
/// ⚠️ `Duration: N/A` 真实存在（管道、没有索引的流），那时返回 0 —— 调用方
/// 原本就拿 0 当「不知道时长」，行为不变。
fn duration_of(stderr: &str) -> f64 {
    for line in stderr.lines() {
        let Some(rest) = line.trim_start().strip_prefix("Duration: ") else {
            continue;
        };
        let stamp = rest.split(',').next().unwrap_or(rest).trim();
        return parse_time_seconds(stamp).unwrap_or(0.0);
    }
    0.0
}

/// 从 `这地方` 里取「前导数字 × 单位倍率」。
///
/// ffmpeg 的码率一律是 `<数字> <单位>bit/s 的缩写/秒`：`130 kb/s`、`1.5 mb/s`、
/// `128 kb/s`。取**前导**数字而不是「整段解析成数字」，因为紧跟着还有单位。
///
/// 认不出单位时按 1 算（ffmpeg 不写单位就意味着 bps），数字取不到给 0。
fn bps_from(text: &str) -> f64 {
    let digits: String = text
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let Ok(v) = digits.parse::<f64>() else {
        return 0.0;
    };
    let lower = text.to_ascii_lowercase();
    let mult = if lower.contains("gb/s") {
        1_000_000_000.0
    } else if lower.contains("mb/s") {
        1_000_000.0
    } else if lower.contains("kb/s") {
        1_000.0
    } else {
        1.0
    };
    v * mult
}

/// `bitrate: 130 kb/s` → 132096（bps）。取不到给 0。
///
/// 注意这是**整容器**的总码率，对应 ffprobe 的 `format.bit_rate`；单条流的
/// 码率另在 `Stream` 行里（见 `stream_bitrate_bps`）。
fn total_bitrate_bps(stderr: &str) -> f64 {
    for line in stderr.lines() {
        let t = line.trim_start();
        if !t.starts_with("Duration: ") {
            continue;
        }
        let Some(idx) = t.find("bitrate: ") else {
            continue;
        };
        return bps_from(&t[idx + "bitrate: ".len()..]);
    }
    0.0
}

/// 一行 `Stream #...` 是不是音频/视频流，以及它的描述段。
///
/// `Stream #0:0[0x1](und): Video: h264 ..., 320x240 ..., 25 fps` → `("video", "h264 ..., 320x240 ...")`
fn stream_line(line: &str) -> Option<(&'static str, &str)> {
    let t = line.trim_start();
    if !t.starts_with("Stream #") {
        return None;
    }
    for (kind, key) in [("audio", "Audio: "), ("video", "Video: ")] {
        if let Some(idx) = t.find(key) {
            return Some((kind, &t[idx + key.len()..]));
        }
    }
    None
}

/// 音频流的 `44100 Hz`。
fn sample_rate_of(desc: &str) -> f64 {
    // 形如 `44100 Hz, stereo, fltp`。Hz 前的数字就是采样率。
    let Some(idx) = desc.find(" Hz") else {
        return 0.0;
    };
    let before = &desc[..idx];
    let digits: String = before
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit())
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    digits.parse().unwrap_or(0.0)
}

/// 声道数。
///
/// ⚠️ **ffmpeg 给的是词、ffprobe 给的是数字**（`stereo` vs `2`）—— 前端
/// `channelsText()` 按数字判（`1`→单声道、`2`→立体声、其它→`N 声道`），
/// 所以要映射回数字。认不出的词给 0（前端 `probe.audio?.channels ?` 为假，
/// 那一栏不显示），**不要**猜成 1 —— 猜错会显示成「单声道」。
fn channels_of(desc: &str) -> f64 {
    let lower = desc.to_ascii_lowercase();
    // 「44100 Hz, stereo」：听诊点固定在 Hz 之后那一段
    let Some(idx) = lower.find(" hz, ") else {
        return 0.0;
    };
    let after = &lower[idx + " hz, ".len()..];
    let word: String = after
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '.' || *c == '(')
        .collect();
    let word = word.trim_end_matches('(').trim();
    match word {
        "mono" => 1.0,
        "stereo" => 2.0,
        "2.1" => 3.0,
        "quad" | "4.0" => 4.0,
        "5.0" => 5.0,
        "5.1" => 6.0,
        "7.1" => 8.0,
        _ => word.parse().unwrap_or(0.0),
    }
}

/// 音频/视频流的码率（`128 kb/s`）。
fn stream_bitrate_bps(desc: &str) -> f64 {
    /* 一条流的描述里 `kb/s` 只出现一次（`... 44100 Hz, stereo, fltp, 128 kb/s`），
    但它前面还有采样率、声道这些东西，所以要**从右往左**找那个「数字 + 单位」
    片段 —— 从左往右找会把 `44100 Hz` 里的东西当成码率。

    取 `rfind` 之后往前抓数字：`... 128 kb/s` → 抓 `128`。 */
    let lower = desc.to_ascii_lowercase();
    for unit in [" kb/s", " mb/s", " gb/s"] {
        if let Some(idx) = lower.rfind(unit) {
            let before = &desc[..idx];
            let digits: String = before
                .chars()
                .rev()
                .take_while(|c| c.is_ascii_digit() || *c == '.')
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
            let Ok(v) = digits.parse::<f64>() else {
                return 0.0;
            };
            let mult = match unit.trim() {
                "gb/s" => 1_000_000_000.0,
                "mb/s" => 1_000_000.0,
                _ => 1_000.0,
            };
            return v * mult;
        }
    }
    0.0
}

/// 视频分辨率 `320x240` → `(320, 240)`。
///
/// ⚠️ 只能找「孤立的 `数字x数字`」，因为同一条流描述里还有
/// `[SAR 1:1 DAR 4:3]` 这类含数字的东西 —— 用 `x` 作分隔符天然排除了它们。
fn resolution_of(desc: &str) -> (f64, f64) {
    // ⚠️ 分辨率那一「段」常常还带着别的尾巴：`320x240 [SAR 1:1 DAR 4:3]`。
    //    所以不能要求 `x` 两边「全是数字」，只能取**前导**数字（`x` 左边的
    //    全部数字、右边的连续前导数字）—— 左边必须是纯数字（`avc1` 里的
    //    `x` 那种要被排除，它的左边是 `0x31637661` 之类的十六进制）。
    let digits_then = |s: &str| -> Option<String> {
        let d: String = s.trim().chars().take_while(char::is_ascii_digit).collect();
        (!d.is_empty()).then_some(d)
    };
    for token in desc.split(',') {
        let t = token.trim();
        let Some((a, b)) = t.split_once('x') else {
            continue;
        };
        let Some(w) = digits_then(a) else { continue };
        let Some(h) = digits_then(b) else { continue };
        // 尺寸不会太大，避免把 `0x31637661` 那类当成分辨率
        let (wv, hv) = (
            w.parse::<f64>().unwrap_or(0.0),
            h.parse::<f64>().unwrap_or(0.0),
        );
        if (16.0..=20000.0).contains(&wv) && (16.0..=20000.0).contains(&hv) {
            return (wv, hv);
        }
    }
    (0.0, 0.0)
}

/// 视频帧率。
///
/// ⚠️ 输出 `"25"`（ffmpeg 的 `25 fps`），不是 `"25/1"`。**没人读这个字段**：
/// 前端 `AudioProbe` 的 `video` 类型里根本没有 `fps`，`Audio.tsx` 也不显示它。
/// 这里保留原样输出，是为了让「字段还在」这件事本身可核对 —— 而不是伪造一个
/// `"25/1"`。
fn fps_of(desc: &str) -> String {
    let lower = desc.to_ascii_lowercase();
    let Some(idx) = lower.find(" fps") else {
        return String::new();
    };
    let before = &desc[..idx];
    before
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_digit() || *c == '.' || *c == '/')
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect()
}

/// 编解码器名：`h264 (High 4:4:4 Predictive) (avc1 / ...)` → `h264`。
///
/// 取到第一个空格或括号为止 —— ffprobe 的 `codec_name` 也是这个短名。
fn codec_of(desc: &str) -> String {
    desc.trim()
        .split([' ', '('])
        .next()
        .unwrap_or("")
        .to_string()
}

/* ══════════════════════════════════ 基础执行 ══════════════════════════════════ */

/// 起一个无窗口的 tokio 子进程
///
/// 这里用 tokio 的 Command 而不是 `quiet_command`：ffmpeg 要一边读 stderr 一边
/// 响应取消（kill），同步 Command 会把 tokio 的工作线程堵死。
/// tokio 的 Command 在 Windows 上自带 `creation_flags`，效果和 quiet_command 一样。
/// ⚠️ 函数体按 cfg **整个**分叉：`mut` 只在 Windows 那条路上需要，
/// 写成一个函数会在非 Windows 上留下 `unused_mut` 警告（见 `ipc::tools::quiet_command`）。
fn tokio_command(program: &Path) -> tokio::process::Command {
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut c = tokio::process::Command::new(program);
        c.creation_flags(CREATE_NO_WINDOW);
        c
    }
    #[cfg(not(windows))]
    {
        tokio::process::Command::new(program)
    }
}

/// 跑一个子进程，把 **stdout 与 stderr 都收回来**。
///
/// `ffmpeg -i` 把媒体信息**全打在 stderr**，所以两个流都收，由调用方决定看哪个。
///
/// ⚠️ 别改成只收一个：ffmpeg 的 `Input #0` 那段在 stderr，只收 stdout 会得到
/// 一个空字符串，然后被判成「读取媒体信息失败」（且没有任何报错线索）。
async fn run_capture(program: &Path, args: &[&str]) -> Option<(i32, String)> {
    let mut cmd = tokio_command(program);
    cmd.args(args)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let out = cmd.output().await.ok()?;
    let mut text = String::from_utf8_lossy(&out.stdout).to_string();
    if !out.stderr.is_empty() {
        // 换行分隔，免得 stdout 的最后一行和 stderr 的第一行粘成一行
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(&String::from_utf8_lossy(&out.stderr));
    }
    Some((out.status.code().unwrap_or(0), text))
}

/// 运行 ffmpeg，解析进度。返回 Err 时是给人看的完整原因。
pub async fn run_ffmpeg(
    root: &Path,
    args: &[String],
    duration_sec: f64,
    cancel: &Cancel,
    on_progress: &Progress,
) -> Result<(), String> {
    let bin = find_ffmpeg(root).ok_or_else(ffmpeg_error)?;

    let mut cmd = tokio_command(&bin);
    cmd.arg("-hide_banner").arg("-y");
    for a in args {
        cmd.arg(a);
    }
    cmd.stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("无法启动 ffmpeg：{e}"))?;
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

/// `H:MM:SS.ss` → 秒，**不要求小数点**。
///
/// 和 `parse_hms` 分开是有意的：那个连着 `last_time_seconds`，必须按 Node 的
/// `\d+\.\d+` 来（`time=00:00:01.23`），少一位就不该认。而 `Duration:` 行
/// 的写法由 ffmpeg 决定，不同版本可能不给小数（`00:00:03`），照严格的那份
/// 解析会静默得 0 —— 时长变 0 会让进度条整条失效，且不报错。
fn parse_time_seconds(stamp: &str) -> Option<f64> {
    let mut parts = stamp.splitn(3, ':');
    let h: u64 = parts.next()?.trim().parse().ok()?;
    let m: u64 = parts.next()?.trim().parse().ok()?;
    let rest = parts.next()?.trim();
    let digits: String = rest
        .chars()
        .take_while(|c| c.is_ascii_digit() || *c == '.')
        .collect();
    let sec: f64 = digits.parse().ok()?;
    Some(h as f64 * 3600.0 + m as f64 * 60.0 + sec)
}

/* ══════════════════════════════════ 媒体信息 ══════════════════════════════════ */

/// 读取媒体信息。字段形状**逐字段固定**：前端 `Audio.tsx` 的 `ProbeInfo` 与
/// `Midi.tsx` 都按这个形状读，改字段就是改前端契约。
///
/// 缺 ffmpeg 时给 `available:false`（程序其余部分照常工作）；读不出来给
/// `probed:false` + `note`。这两种状态前端各自有对应的提示分支。
pub async fn probe_media(root: &Path, input: &str) -> Value {
    let Some(ffmpeg) = find_ffmpeg(root) else {
        return json!({ "available": false });
    };

    // ⚠️ 只用 `-i`、**不给输出文件**，也不加 `-f null -`。原因见上面那段
    //    「三个必须记住的坑」②：`-f null -` 会真的解码一遍，代价随时长线性增长。
    let Some((_code, stderr)) =
        run_capture(&ffmpeg, &["-hide_banner", "-nostdin", "-i", input]).await
    else {
        return json!({ "available": true, "probed": false, "note": "读取媒体信息失败" });
    };

    /*
     * ⚠️ **判据是「stderr 里有没有 `Input #0`」，不是上面那个退出码。**
     * `ffmpeg -i <文件>` 只探测时恒定返回 1（末尾那句 "At least one output
     * file must be specified"），文件完好也是 1 —— 拿退出码判会把每个正常
     * 文件都判成「读取失败」。
     */
    if !stderr.contains("Input #") {
        return json!({ "available": true, "probed": false, "note": "读取媒体信息失败" });
    }

    let mut audio_desc: Option<&str> = None;
    let mut video_desc: Option<&str> = None;
    for line in stderr.lines() {
        match stream_line(line) {
            Some(("audio", d)) if audio_desc.is_none() => audio_desc = Some(d),
            Some(("video", d)) if video_desc.is_none() => video_desc = Some(d),
            _ => {}
        }
    }

    let mut out = Map::new();
    out.insert("available".into(), json!(true));
    out.insert("probed".into(), json!(true));
    out.insert("durationSec".into(), json!(duration_of(&stderr)));
    // ffprobe 的 `format.size` 对某些容器是**估算值**；直接问文件系统更准，
    // 而且这正是前端要显示的那个数（「文件大小」）。
    out.insert(
        "sizeBytes".into(),
        json!(std::fs::metadata(input).map(|m| m.len()).unwrap_or(0)),
    );
    out.insert("bitrate".into(), json!(total_bitrate_bps(&stderr)));
    out.insert("formatName".into(), json!(container_of(&stderr)));
    out.insert(
        "audio".into(),
        match audio_desc {
            Some(d) => json!({
                "codec": codec_of(d),
                "sampleRate": sample_rate_of(d),
                "channels": channels_of(d),
                "bitrate": stream_bitrate_bps(d),
            }),
            None => Value::Null,
        },
    );
    out.insert(
        "video".into(),
        match video_desc {
            Some(d) => {
                let (w, h) = resolution_of(d);
                json!({
                    "codec": codec_of(d),
                    "width": w,
                    "height": h,
                    "fps": fps_of(d),
                })
            }
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
    root: &Path,
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

    let info = probe_media(root, &input).await;
    let duration = info
        .get("durationSec")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);

    let mut ff: Vec<String> = vec!["-i".into(), input.clone(), "-vn".into()];
    ff.extend(preset_args);
    if let Some(sr) = opt_num(args, "sampleRate")
        && sr != 0.0
    {
        ff.push("-ar".into());
        ff.push(num_text(sr));
    }
    if let Some(ch) = opt_num(args, "channels")
        && ch != 0.0
    {
        ff.push("-ac".into());
        ff.push(num_text(ch));
    }
    ff.push(output.clone());

    run_ffmpeg(root, &ff, duration, cancel, on_progress).await?;

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
    root: &Path,
    args: &Map<String, Value>,
    cancel: &Cancel,
    on_progress: &Progress,
) -> Result<Value, String> {
    convert_audio(root, args, cancel, on_progress).await
}

/// 变调（保持时长）：asetrate + aresample + atempo
pub async fn shift_pitch(
    root: &Path,
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

    let info = probe_media(root, &input).await;
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
    let duration = info
        .get("durationSec")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);

    run_ffmpeg(
        root,
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
    root: &Path,
    args: &Map<String, Value>,
    cancel: &Cancel,
    on_progress: &Progress,
) -> Result<Value, String> {
    let input = require_input(args)?;
    let ratio = opt_num(args, "ratio").unwrap_or(1.0);
    // 非正数与 NaN 都不合法 —— 写成 `ratio > 0.0` 的反面就是这一条
    if ratio <= 0.0 || ratio.is_nan() {
        return Err("速度比例不合法".to_string());
    }
    let output = prepare_out(args)?;

    let info = probe_media(root, &input).await;
    let duration = info
        .get("durationSec")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);

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
        root,
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
    root: &Path,
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
    run_ffmpeg(root, &ff, duration, cancel, on_progress).await?;

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
    root: &Path,
    args: &Map<String, Value>,
    cancel: &Cancel,
    on_progress: &Progress,
) -> Result<Value, String> {
    let input = require_input(args)?;
    let target_lufs = opt_num(args, "targetLufs").unwrap_or(-14.0);
    let output = prepare_out(args)?;

    let info = probe_media(root, &input).await;
    let duration = info
        .get("durationSec")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);

    run_ffmpeg(
        root,
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
        assert_eq!(
            last_time_seconds("frame=1 time=01:02:03.50 fps=0"),
            Some(3723.5)
        );
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

    /* ── 从 ffmpeg stderr 读媒体信息 ──────────────────────────────────
    下面三段是**真实的** `ffmpeg -i` 输出（本机 n9.0.2 实测），原样粘进来。
    ⚠️ 改这些夹具时要重新跑一遍真的 ffmpeg 再粘，别照记忆手写 —— 这些
    函数的全部难点就是「真实的行长什么样」。 */

    const MP3_STDERR: &str = "\
Input #0, mp3, from 'a.mp3':
  Metadata:
    encoder         : Lavf63.1.102
  Duration: 00:00:03.00, start: 0.025057, bitrate: 130 kb/s
  Stream #0:0: Audio: mp3 (mp3float), 44100 Hz, stereo, fltp, 128 kb/s, start 0.025057
    Metadata:
      encoder         : Lavc63.1.
At least one output file must be specified
";

    const MP4_STDERR: &str = "\
Input #0, mov,mp4,m4a,3gp,3g2,mj2, from 'a.mp4':
  Metadata:
    major_brand     : isom
    minor_version   : 512
    compatible_brands: isomiso2avc1mp41
    encoder         : Lavf63.1.102
  Duration: 00:00:02.00, start: 0.000000, bitrate: 130 kb/s
  Stream #0:0[0x1](und): Video: h264 (High 4:4:4 Predictive) (avc1 / 0x31637661), yuv444p(progressive), 320x240 [SAR 1:1 DAR 4:3], 47 kb/s, 25 fps, 25 tbr, 12800 tbn (default)
    Metadata:
      handler_name    : VideoHandler
      encoder         : Lavc63.1.102 libx264
  Stream #0:1[0x2](und): Audio: aac (LC) (mp4a / 0x6134706D), 44100 Hz, mono, fltp, 69 kb/s (default)
    Metadata:
      handler_name    : SoundHandler
At least one output file must be specified
";

    const WAV_STDERR: &str = "\
[aist#0:0/pcm_s16le @ 0x55f2d20daf80] Guessed Channel Layout: mono
Input #0, wav, from 'w.wav':
  Metadata:
    encoder         : Lavf63.1.102
  Duration: 00:00:02.00, bitrate: 705 kb/s
  Stream #0:0: Audio: pcm_s16le ([1][0][0][0] / 0x0001), 44100 Hz, mono, s16, 705 kb/s
At least one output file must be specified
";

    #[test]
    fn reads_duration_bitrate_and_container_from_ffmpeg_stderr() {
        assert_eq!(duration_of(MP3_STDERR), 3.0);
        assert_eq!(duration_of(MP4_STDERR), 2.0);
        assert_eq!(duration_of(WAV_STDERR), 2.0);

        assert_eq!(container_of(MP3_STDERR), "mp3");
        assert_eq!(container_of(WAV_STDERR), "wav");
        // ⚠️ mp4 的容器名是一串别名，和 ffprobe 的 format_name 一致
        assert_eq!(container_of(MP4_STDERR), "mov,mp4,m4a,3gp,3g2,mj2");

        assert_eq!(total_bitrate_bps(MP3_STDERR), 130_000.0);
        assert_eq!(total_bitrate_bps(WAV_STDERR), 705_000.0);
    }

    #[test]
    fn reads_audio_and_video_streams_from_ffmpeg_stderr() {
        // mp3：只有音频流
        let a = MP3_STDERR.lines().find_map(|l| match stream_line(l) {
            Some(("audio", d)) => Some(d),
            _ => None,
        });
        let d = a.expect("mp3 该有音频流");
        assert_eq!(codec_of(d), "mp3");
        assert_eq!(sample_rate_of(d), 44100.0);
        assert_eq!(channels_of(d), 2.0);
        assert_eq!(stream_bitrate_bps(d), 128_000.0);

        // mp4：两条流都要认出来，且**视频在前音频在后**（真实输出就是这个顺序）
        let kinds: Vec<&str> = MP4_STDERR
            .lines()
            .filter_map(stream_line)
            .map(|(k, _)| k)
            .collect();
        assert_eq!(kinds, vec!["video", "audio"]);

        let v = MP4_STDERR
            .lines()
            .find_map(|l| match stream_line(l) {
                Some(("video", d)) => Some(d),
                _ => None,
            })
            .expect("mp4 该有视频流");
        assert_eq!(codec_of(v), "h264");
        assert_eq!(resolution_of(v), (320.0, 240.0));
        assert_eq!(fps_of(v), "25");
        assert_eq!(stream_bitrate_bps(v), 47_000.0);
    }

    #[test]
    fn channels_become_numbers_because_the_frontend_switches_on_them() {
        // 前端 `channelsText()`：1→单声道、2→立体声、其它→「N 声道」。
        // ffmpeg 给的是词，必须映射回数字。
        let d = |s: &str| format!("pcm, 48000 Hz, {s}, fltp, 1 kb/s");
        assert_eq!(channels_of(&d("mono")), 1.0);
        assert_eq!(channels_of(&d("stereo")), 2.0);
        assert_eq!(channels_of(&d("5.1")), 6.0);
        assert_eq!(channels_of(&d("quad")), 4.0);
        // ⚠️ 认不出就给 0（前端那一栏不显示），**绝不能猜 1** —— 猜错会显示「单声道」
        assert_eq!(channels_of(&d("something-weird")), 0.0);
    }

    #[test]
    fn a_missing_or_odd_duration_never_panics() {
        // `Duration: N/A` 真实存在（管道、没索引的流）—— 给 0，调用方原本
        // 就拿 0 当「不知道时长」
        assert_eq!(
            duration_of("  Duration: N/A, start: 0.025057, bitrate: 128 kb/s"),
            0.0
        );
        // 整段里都没有 Duration 行
        assert_eq!(duration_of("Input #0, mp3, from 'x':\n"), 0.0);
        // 没有小数点也必须认（不同版本可能给 `00:00:03`）
        assert_eq!(duration_of("  Duration: 00:00:03, bitrate: 1 kb/s"), 3.0);
        // 超过一小时
        assert_eq!(
            duration_of("  Duration: 01:02:03.50, start: 0.0, bitrate: 1 kb/s"),
            3723.5
        );
        // 空串、乱码都不炸
        assert_eq!(duration_of(""), 0.0);
        assert_eq!(container_of(""), "");
        assert_eq!(total_bitrate_bps(""), 0.0);
    }

    /// 跑**真的** `probe_media`（不是单个解析器）—— 上面那几条测的是「从一段
    /// 文本里取字段」，这条测的是「整条路通不通」：起进程、收 stderr、认判据、
    /// 组装 JSON。少了它，`run_capture` 收错流（比如只收 stdout）这种错就没人拦。
    ///
    /// 环境变量守着（同 `reads_a_real_file_when_ffmpeg_is_around`）：
    ///
    ///     VSS_FFMPEG=/usr/bin/ffmpeg cargo test --lib probe_media_on_a_real_file -- --nocapture
    #[tokio::test]
    async fn probe_media_on_a_real_file() {
        let Ok(bin) = std::env::var("VSS_FFMPEG") else {
            return;
        };
        let dir = std::env::temp_dir().join("vss-probe-e2e");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mp4 = dir.join("t.mp4");
        // 造一个带音视频的 mp4。视频用内建的 `mpeg4` 而不是 `libx264`：
        // 随包那份 ffmpeg 是 LGPL 档（不带 x264），用 libx264 这条测试在真实产物上跑不了。
        let ok = tokio_command(Path::new(&bin))
            .args([
                "-hide_banner",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc=duration=1:size=320x240:rate=25",
                "-f",
                "lavfi",
                "-i",
                "sine=duration=1",
                "-c:v",
                "mpeg4",
                "-c:a",
                "aac",
                "-shortest",
            ])
            .arg(&mp4)
            .output()
            .await
            .unwrap();
        assert!(ok.status.success());
        /* `probe_media` 收的是**程序根**，然后问产物表要 `tools/ffmpeg/bin/ffmpeg`。
        所以这里照那个形状摆一份 —— 比靠 PATH 兜底更确定（CI 上 PATH 里有没有
        ffmpeg 不由我们决定，而这条测试要测的是我们自己的组装逻辑）。 */
        let tools = dir.join("tools").join("ffmpeg").join("bin");
        std::fs::create_dir_all(&tools).unwrap();
        std::fs::copy(&bin, tools.join("ffmpeg")).unwrap();
        let got = probe_media(&dir, &mp4.to_string_lossy()).await;
        println!(
            "probe_media → {}",
            serde_json::to_string_pretty(&got).unwrap()
        );
        assert_eq!(got["probed"], json!(true));
        assert_eq!(got["audio"]["codec"], "aac");
        assert_eq!(got["audio"]["channels"], 1.0);
        assert_eq!(got["video"]["width"], 320.0);
        assert_eq!(got["video"]["height"], 240.0);
        assert!(got["durationSec"].as_f64().unwrap() > 0.9);
        assert!(got["sizeBytes"].as_f64().unwrap() > 1000.0);

        /* 读不出来的文件要给 `probed:false` + 一句 note（前端 `Audio.tsx` 与
        `Midi.tsx` 都有对应分支）。⚠️ 这里同时钉住「**不是**靠退出码判」：
        正常文件 ffmpeg 也返回 1，所以退出码在这条路上一无用处。 */
        let bad = dir.join("bad.bin");
        std::fs::write(&bad, b"not a media file at all").unwrap();
        let failed = probe_media(&dir, &bad.to_string_lossy()).await;
        println!("非法文件 → {failed}");
        assert_eq!(failed["available"], json!(true));
        assert_eq!(failed["probed"], json!(false));
        assert!(failed["note"].is_string(), "该给一句说明");

        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 拿**真的** ffmpeg 跑一遍 —— 上面那些是按真实输出抄的夹具，而这条是让
    /// 真的 ffmpeg 再产一次，确认格式没变（换 ffmpeg 版本时它会先报警）。
    ///
    /// 用环境变量守着（CI 上不一定有 ffmpeg）：
    ///
    ///     VSS_FFMPEG=/usr/bin/ffmpeg cargo test --lib reads_a_real_file -- --nocapture
    #[tokio::test]
    async fn reads_a_real_file_when_ffmpeg_is_around() {
        let Ok(bin) = std::env::var("VSS_FFMPEG") else {
            return;
        };
        let bin = Path::new(&bin);
        if !bin.is_file() {
            return;
        }
        let dir = std::env::temp_dir().join("vss-audio-probe");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mp3 = dir.join("t.mp3");

        // 造一个真的 mp3（1 秒正弦波，44100Hz 双声道）
        let made = tokio_command(bin)
            .args([
                "-hide_banner",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=1",
                "-ar",
                "44100",
                "-ac",
                "2",
            ])
            .arg(&mp3)
            .output()
            .await
            .expect("跑不了 ffmpeg");
        assert!(made.status.success(), "造测试音频失败");

        let input = "-i";
        let Some((_code, text)) = run_capture(
            bin,
            &["-hide_banner", "-nostdin", input, &mp3.to_string_lossy()],
        )
        .await
        else {
            panic!("收不到 ffmpeg 输出");
        };
        println!("{text}");
        // 判据本身（Input #）与几个关键字段
        assert!(
            text.contains("Input #"),
            "判据「stderr 里有 Input #」失效了"
        );
        let secs = duration_of(&text);
        assert!((secs - 1.0).abs() < 0.1, "时长不对：{secs}");
        assert_eq!(container_of(&text), "mp3");
        assert_eq!(sample_rate_of(&text), 44100.0);
        assert_eq!(channels_of(&text), 2.0);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
