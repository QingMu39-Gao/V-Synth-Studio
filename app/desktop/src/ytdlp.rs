//! yt-dlp 桥接
//!
//! 对应 Node 的 `net/ytdlp.mjs`。用途：YouTube 以及 yt-dlp 支持的上千个站点
//! （含部分国内平台）的解析与下载。
//!
//! 本模块不内置 yt-dlp，也不改系统环境：只在程序目录 `tools/` 或 PATH 中查找。

use std::path::Path;
use std::process::Stdio;

use serde_json::{json, Map, Value};
use tokio::io::AsyncReadExt;

use crate::net::{Cancel, CANCELED};

#[derive(Clone)]
pub struct Found {
    /// "binary" 或 "python"
    pub kind: String,
    pub path: String,
}

/// 起一个无窗口的 tokio 子进程（tokio 的 Command 自带 creation_flags，
/// 和 `quiet_command` 的效果一样，区别是它的输出能异步读、进程能异步 kill）
fn tokio_command(program: &str) -> tokio::process::Command {
    let mut c = tokio::process::Command::new(program);
    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}

/// 查找可用的 yt-dlp（程序目录 → PATH → python -m yt_dlp）
pub async fn find_ytdlp(tools_dir: &Path) -> Option<Found> {
    let _ = std::fs::create_dir_all(tools_dir);

    let local = tools_dir.join(crate::tools::exe("yt-dlp"));
    if local.is_file() {
        return Some(Found {
            kind: "binary".into(),
            path: local.to_string_lossy().to_string(),
        });
    }

    if let Some(p) = crate::platform::find_binary("yt-dlp", &[]) {
        return Some(Found {
            kind: "binary".into(),
            path: p.to_string_lossy().to_string(),
        });
    }

    let python = if cfg!(windows) { "python" } else { "python3" };
    if let Some((0, _, _)) = run_capture(python, &["-m", "yt_dlp", "--version"], 30).await {
        return Some(Found {
            kind: "python".into(),
            path: python.to_string(),
        });
    }
    None
}

/// 运行并捕获输出（带超时，超时就掐掉子进程）
async fn run_capture(cmd: &str, args: &[&str], timeout_secs: u64) -> Option<(i32, String, String)> {
    let mut command = tokio_command(cmd);
    command
        .args(args)
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().ok()?;

    let mut stdout = child.stdout.take()?;
    let mut stderr = child.stderr.take()?;
    let out_task = tokio::spawn(async move {
        let mut s = String::new();
        let _ = stdout.read_to_string(&mut s).await;
        s
    });
    let err_task = tokio::spawn(async move {
        let mut s = String::new();
        let _ = stderr.read_to_string(&mut s).await;
        s
    });

    let status = match tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        child.wait(),
    )
    .await
    {
        Ok(Ok(s)) => s,
        _ => {
            let _ = child.kill().await;
            return None;
        }
    };

    Some((
        status.code().unwrap_or(0),
        out_task.await.unwrap_or_default(),
        err_task.await.unwrap_or_default(),
    ))
}

/// 公共参数（对应 Node 的 baseArgs）
fn base_args(found: &Found, proxy: Option<&str>, cookies_from_browser: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = if found.kind == "python" {
        vec!["-m".into(), "yt_dlp".into()]
    } else {
        vec![]
    };
    args.push("--no-warnings".into());
    args.push("--no-playlist".into());
    args.push("--newline".into());
    if let Some(p) = proxy.filter(|p| !p.is_empty()) {
        args.push("--proxy".into());
        args.push(p.to_string());
    }
    if let Some(c) = cookies_from_browser.filter(|c| !c.is_empty()) {
        args.push("--cookies-from-browser".into());
        args.push(c.to_string());
    }
    args
}

/// yt-dlp 的错误文本里挑一行有用的（对应 cleanYtDlpError）
fn clean_error(text: &str) -> String {
    let lines: Vec<&str> = text
        .split('\n')
        .map(|l| l.strip_suffix('\r').unwrap_or(l))
        .filter(|l| !l.trim().is_empty() && !l.starts_with("[debug]"))
        .collect();
    let err_line = lines
        .iter()
        .find(|l| l.to_uppercase().starts_with("ERROR"))
        .or_else(|| lines.last())
        .copied()
        .unwrap_or("未知错误");
    let stripped = match err_line.to_uppercase().find("ERROR:") {
        Some(0) => err_line[6..].trim_start(),
        _ => err_line,
    };
    format!("yt-dlp 失败：{}", stripped.chars().take(400).collect::<String>())
}

/* ══════════════════════════════════ 解析信息 ══════════════════════════════════ */

/*
 * yt-dlp 的 JSON 里很多字段是**显式 null**（不是缺失），而 JS 的 `??` 把 null 当空处理。
 * 照搬 `??` 的语义：null 和缺失一样，都走默认值。少这一层就会把 `0` 变成 `null`。
 */
fn num(v: Option<&Value>) -> Value {
    match v {
        None | Some(Value::Null) => json!(0),
        Some(v) => v.clone(),
    }
}

fn text(v: Option<&Value>) -> Value {
    match v {
        None | Some(Value::Null) => json!(""),
        Some(Value::String(s)) => json!(s),
        Some(v) => v.clone(),
    }
}

/// `a ?? b`：a 是 null/缺失时用 b
fn first_of<'a>(a: Option<&'a Value>, b: Option<&'a Value>) -> Option<&'a Value> {
    a.filter(|v| !v.is_null()).or_else(|| b.filter(|v| !v.is_null()))
}

fn normalize_info(info: &Value) -> Value {
    let mut formats: Vec<Value> = info
        .get("formats")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter(|f| {
                    f.get("url").map(|v| !v.is_null()).unwrap_or(false)
                        || f.get("format_id").map(|v| !v.is_null()).unwrap_or(false)
                })
                .map(|f| {
                    let s = |k: &str| f.get(k).and_then(|v| v.as_str()).map(String::from);
                    let vcodec = s("vcodec").unwrap_or_else(|| "none".into());
                    let acodec = s("acodec").unwrap_or_else(|| "none".into());
                    let width = f.get("width").and_then(|v| v.as_i64());
                    let height = f.get("height").and_then(|v| v.as_i64());
                    let resolution = match (width, height) {
                        (Some(w), Some(h)) => format!("{w}x{h}"),
                        _ => s("resolution").unwrap_or_else(|| "audio only".into()),
                    };
                    let filesize = num(first_of(
                        f.get("filesize"),
                        f.get("filesize_approx"),
                    ));

                    let mut m = Map::new();
                    if let Some(v) = f.get("format_id") {
                        m.insert("formatId".into(), v.clone());
                    }
                    if let Some(v) = f.get("ext") {
                        m.insert("ext".into(), v.clone());
                    }
                    m.insert(
                        "note".into(),
                        json!(s("format_note").unwrap_or_default()),
                    );
                    m.insert("resolution".into(), json!(resolution));
                    m.insert("height".into(), num(f.get("height")));
                    m.insert("fps".into(), num(f.get("fps")));
                    m.insert("vcodec".into(), json!(vcodec));
                    m.insert("acodec".into(), json!(acodec));
                    m.insert("filesize".into(), filesize);
                    m.insert("tbr".into(), num(f.get("tbr")));
                    m.insert("isVideo".into(), json!(vcodec != "none"));
                    m.insert("isAudio".into(), json!(acodec != "none"));
                    m.insert("hasAudio".into(), json!(acodec != "none"));
                    m.insert("hasVideo".into(), json!(vcodec != "none"));
                    Value::Object(m)
                })
                .collect()
        })
        .unwrap_or_default();

    // 按高度降序、同高度按码率降序
    formats.sort_by(|a, b| {
        let ha = a.get("height").and_then(|v| v.as_i64()).unwrap_or(0);
        let hb = b.get("height").and_then(|v| v.as_i64()).unwrap_or(0);
        hb.cmp(&ha).then_with(|| {
            let ta = a.get("tbr").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let tb = b.get("tbr").and_then(|v| v.as_f64()).unwrap_or(0.0);
            tb.partial_cmp(&ta).unwrap_or(std::cmp::Ordering::Equal)
        })
    });

    let desc = info.get("description").and_then(|v| v.as_str()).unwrap_or("");
    let subtitles: Vec<Value> = info
        .get("subtitles")
        .and_then(|v| v.as_object())
        .map(|o| o.keys().map(|k| json!(k)).collect())
        .unwrap_or_default();

    let mut m = Map::new();
    // id 是原样透传：缺失就不写这个键（Node 那边 undefined 会被丢掉）
    if let Some(v) = info.get("id") {
        m.insert("id".into(), v.clone());
    }
    m.insert("title".into(), text(info.get("title")));
    m.insert(
        "uploader".into(),
        text(first_of(info.get("uploader"), info.get("channel"))),
    );
    m.insert("durationSec".into(), num(info.get("duration")));
    m.insert("thumbnail".into(), text(info.get("thumbnail")));
    m.insert(
        "description".into(),
        json!(desc.chars().take(500).collect::<String>()),
    );
    m.insert("webpageUrl".into(), text(info.get("webpage_url")));
    m.insert(
        "extractor".into(),
        text(first_of(info.get("extractor_key"), info.get("extractor"))),
    );
    m.insert("uploadDate".into(), text(info.get("upload_date")));
    m.insert("viewCount".into(), num(info.get("view_count")));
    m.insert("formats".into(), Value::Array(formats));
    m.insert("subtitles".into(), Value::Array(subtitles));
    Value::Object(m)
}

pub async fn inspect(
    tools_dir: &Path,
    url: &str,
    proxy: Option<&str>,
    cookies_from_browser: Option<&str>,
) -> Result<Value, String> {
    let found = find_ytdlp(tools_dir).await.ok_or_else(|| {
        "未找到 yt-dlp。请在「设置 → 外部工具」中一键获取，或手动放置 yt-dlp.exe 到 tools 目录。"
            .to_string()
    })?;

    let mut args = base_args(&found, proxy, cookies_from_browser);
    args.push("-J".into());
    args.push("--no-progress".into());
    args.push(url.to_string());

    let refs: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
    let (code, stdout, stderr) = run_capture(&found.path, &refs, 120)
        .await
        .ok_or_else(|| "yt-dlp 执行超时（120 秒）".to_string())?;

    if code != 0 {
        let text = if stderr.trim().is_empty() { stdout } else { stderr };
        return Err(clean_error(&text));
    }
    let info: Value = serde_json::from_str(&stdout)
        .map_err(|_| "yt-dlp 返回内容无法解析，可能是该站点暂不受支持。".to_string())?;

    let mut m = Map::new();
    m.insert("engine".into(), json!("yt-dlp"));
    m.insert("enginePath".into(), json!(found.path));
    if let Value::Object(normalized) = normalize_info(&info) {
        for (k, v) in normalized {
            m.insert(k, v);
        }
    }
    Ok(Value::Object(m))
}

/* ══════════════════════════════════ 下载 ══════════════════════════════════ */

pub struct DlProgress {
    pub stage: String,
    /// -1 表示「只是一行信息」，不是百分比
    pub percent: f64,
    pub speed: String,
    pub eta: String,
    pub line: String,
}

pub type OnDlProgress = dyn Fn(&DlProgress) + Send + Sync;

pub struct DlOptions<'a> {
    pub out_dir: &'a str,
    pub mode: &'a str,
    pub format_id: Option<&'a str>,
    pub convert_to: Option<&'a str>,
    pub embed_subs: bool,
    pub proxy: Option<&'a str>,
    pub cookies_from_browser: Option<&'a str>,
}

/// 用 yt-dlp 下载，返回产出的文件列表
pub async fn download(
    tools_dir: &Path,
    url: &str,
    opts: &DlOptions<'_>,
    cancel: &Cancel,
    on_progress: &OnDlProgress,
) -> Result<Vec<String>, String> {
    let found = find_ytdlp(tools_dir)
        .await
        .ok_or_else(|| "未找到 yt-dlp。请在「设置 → 外部工具」中一键获取。".to_string())?;
    let _ = std::fs::create_dir_all(opts.out_dir);

    let mut args = base_args(&found, opts.proxy, opts.cookies_from_browser);
    args.push("--progress".into());
    args.push("--progress-template".into());
    args.push(
        "download:{\"p\":\"%(progress._percent_str)s\",\"speed\":\"%(progress._speed_str)s\",\"eta\":\"%(progress._eta_str)s\",\"dl\":\"%(progress.downloaded_bytes)s\",\"total\":\"%(progress.total_bytes_estimate)s\"}"
            .into(),
    );
    args.push("-o".into());
    args.push(
        Path::new(opts.out_dir)
            .join("%(title)s.%(ext)s")
            .to_string_lossy()
            .to_string(),
    );
    args.push("--print".into());
    args.push("after_move:{\"file\":\"%(filepath)s\"}".into());

    if opts.mode == "audio" {
        args.push("-f".into());
        args.push(opts.format_id.unwrap_or("bestaudio/best").to_string());
        if let Some(ct) = opts.convert_to.filter(|c| !c.is_empty()) {
            args.push("--extract-audio".into());
            args.push("--audio-format".into());
            args.push(ct.to_string());
        }
    } else {
        args.push("-f".into());
        args.push(opts.format_id.unwrap_or("bestvideo*+bestaudio/best").to_string());
        args.push("--merge-output-format".into());
        match opts.convert_to.filter(|c| !c.is_empty() && *c != "mkv") {
            Some(ct) => args.push(ct.to_string()),
            None => args.push("mkv".into()),
        }
    }
    if opts.embed_subs {
        args.push("--write-subs".into());
        args.push("--write-auto-subs".into());
        args.push("--embed-subs".into());
        args.push("--sub-langs".into());
        args.push("zh-Hans,zh-CN,zh,en".into());
    }
    args.push(url.to_string());

    let mut command = tokio_command(&found.path);
    command
        .args(&args)
        .env("PYTHONIOENCODING", "utf-8")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|e| format!("无法启动 yt-dlp：{e}"))?;

    let mut stdout = child.stdout.take().ok_or("无法读取 yt-dlp 输出")?;
    let mut stderr_pipe = child.stderr.take().ok_or("无法读取 yt-dlp 输出")?;
    let stderr_task = tokio::spawn(async move {
        let mut s = String::new();
        let _ = stderr_pipe.read_to_string(&mut s).await;
        s
    });

    let mut files: Vec<String> = Vec::new();
    let mut stdout_tail = String::new();
    let mut carry = String::new();
    let mut buf = vec![0u8; 8192];
    let mut canceled = false;

    loop {
        if cancel() {
            canceled = true;
            break;
        }
        match tokio::time::timeout(std::time::Duration::from_millis(200), stdout.read(&mut buf))
            .await
        {
            Ok(Ok(0)) => break,
            Ok(Ok(n)) => {
                let text = String::from_utf8_lossy(&buf[..n]).to_string();
                stdout_tail.push_str(&text);
                if stdout_tail.chars().count() > 8000 {
                    let count = stdout_tail.chars().count();
                    stdout_tail = stdout_tail.chars().skip(count - 8000).collect();
                }
                // yt-dlp 用 \r 刷新进度、用 \n 换行，两种都要当分隔符
                let joined = format!("{carry}{text}");
                let mut parts: Vec<&str> = joined.split(['\n', '\r']).collect();
                carry = parts.pop().unwrap_or("").to_string();
                for line in parts {
                    handle_line(line, on_progress, &mut files);
                }
            }
            Ok(Err(_)) => break,
            Err(_) => {}
        }
    }

    if canceled {
        let _ = child.kill().await;
        return Err(CANCELED.to_string());
    }

    let status = child.wait().await.map_err(|e| e.to_string())?;
    let stderr = stderr_task.await.unwrap_or_default();
    if status.code().unwrap_or(-1) == 0 {
        Ok(files)
    } else {
        let text = if stderr.trim().is_empty() { stdout_tail } else { stderr };
        Err(clean_error(&text))
    }
}

fn handle_line(line: &str, on_progress: &OnDlProgress, files: &mut Vec<String>) {
    let t = line.trim();
    if let Some(rest) = t.strip_prefix("download:{")
    {
        if let Ok(o) = serde_json::from_str::<Value>(&format!("{{{rest}")) {
            let p = o.get("p").and_then(|v| v.as_str()).unwrap_or("");
            let percent = p
                .replace('%', "")
                .trim()
                .parse::<f64>()
                .unwrap_or(0.0);
            on_progress(&DlProgress {
                stage: "download".into(),
                percent,
                speed: o
                    .get("speed")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string(),
                eta: o
                    .get("eta")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .trim()
                    .to_string(),
                line: t.to_string(),
            });
        }
        return;
    }
    if t.starts_with("{\"file\"") {
        if let Ok(o) = serde_json::from_str::<Value>(t) {
            if let Some(f) = o.get("file").and_then(|v| v.as_str()) {
                files.push(f.to_string());
            }
        }
        return;
    }
    if t.starts_with("[download]")
        || t.starts_with("[Merger]")
        || t.starts_with("[ExtractAudio]")
        || t.starts_with("[ffmpeg]")
    {
        on_progress(&DlProgress {
            stage: "info".into(),
            percent: -1.0,
            speed: String::new(),
            eta: String::new(),
            line: t.to_string(),
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_ytdlp_info_the_same_way_node_does() {
        /*
         * 输入取自真实的 `yt-dlp -J <直链 mp4>` 输出（只留了用得上的字段）。
         * 这份数据里 null 和「键不存在」是混着来的 —— 正是 JS 的 `??` 和 Rust 的
         * `as_f64()` 最容易分叉的地方：`??` 把 null 当空，`as_f64()` 对 null 直接给 None，
         * 一不留神就会把 Node 的 0/'' 变成 null。期望值是 Node 版实测输出。
         */
        let raw = json!({
            "id": "mov_bbb",
            "title": "mov_bbb",
            "extractor": "generic",
            "extractor_key": "Generic",
            "upload_date": "20260926",
            "webpage_url": "https://www.w3schools.com/html/mov_bbb.mp4",
            "subtitles": {},
            "formats": [{
                "format_id": "mp4",
                "url": "https://www.w3schools.com/html/mov_bbb.mp4",
                "ext": "mp4",
                "vcodec": null,
                "tbr": null,
                "resolution": null,
                "filesize_approx": null,
                "vbr": null
            }]
        });

        let expected = json!({
            "id": "mov_bbb",
            "title": "mov_bbb",
            "uploader": "",
            "durationSec": 0,
            "thumbnail": "",
            "description": "",
            "webpageUrl": "https://www.w3schools.com/html/mov_bbb.mp4",
            "extractor": "Generic",
            "uploadDate": "20260926",
            "viewCount": 0,
            "formats": [{
                "formatId": "mp4",
                "ext": "mp4",
                "note": "",
                "resolution": "audio only",
                "height": 0,
                "fps": 0,
                "vcodec": "none",
                "acodec": "none",
                "filesize": 0,
                "tbr": 0,
                "isVideo": false,
                "isAudio": false,
                "hasVideo": false,
                "hasAudio": false
            }],
            "subtitles": []
        });

        assert_eq!(normalize_info(&raw), expected);
    }

    #[test]
    fn picks_the_most_useful_line_out_of_ytdlp_output() {
        assert_eq!(
            clean_error("[debug] command line\nERROR: Unsupported URL: https://x\n"),
            "yt-dlp 失败：Unsupported URL: https://x"
        );
        assert_eq!(clean_error(""), "yt-dlp 失败：未知错误");
        assert_eq!(clean_error("some last line"), "yt-dlp 失败：some last line");
        assert_eq!(clean_error("[debug] only debug"), "yt-dlp 失败：未知错误");
    }

    #[test]
    fn parses_download_progress_lines() {
        let mut files = Vec::new();
        // 回调要能当 'static 的 trait object 用，所以状态得靠 Arc 共享
        let got = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
        let sink = got.clone();
        let cb = move |p: &DlProgress| {
            sink.lock().unwrap().push((p.stage.clone(), p.percent));
        };
        handle_line(
            "download:{\"p\":\" 12.3%\",\"speed\":\"1.2MiB/s\",\"eta\":\"00:12\"}",
            &cb,
            &mut files,
        );
        handle_line("{\"file\":\"C:\\\\x\\\\a.mkv\"}", &cb, &mut files);
        handle_line("[Merger] Merging formats into \"a.mkv\"", &cb, &mut files);
        assert_eq!(
            *got.lock().unwrap(),
            vec![("download".to_string(), 12.3), ("info".to_string(), -1.0)]
        );
        assert_eq!(files, vec!["C:\\x\\a.mkv".to_string()]);
    }
}
