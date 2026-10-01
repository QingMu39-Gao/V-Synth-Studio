//! LibreSVIP 引擎封装
//! · QingMu39
//!
//! 工程转换和「读取工程」两件事都交给它：
//!   - 转换：`libresvip-cli proj convert <in> <out>`
//!   - 读取：转成 `ufdata`（UtaFormatix Data，一种 JSON 中间格式）再解析
//!
//! 后者是关键 —— 有了它就不需要自己写 12 个格式的 reader（Node 版那 10796 行）。
//! 任何 LibreSVIP 支持的格式都能读成统一结构，我们只解析一种 JSON。

use std::collections::BTreeMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// ⚠️ **别再往 stdin 喂空行了。** 以前这里是 `STDIN_BLANKS = 60` 个空行，
/// 以为「空行 = 接受默认值」—— 但 LibreSVIP 的 y/n 提问**不收空行**，
/// 它会一直回 `Please enter Y or N`，把空行一条条吃光，最后 EOF → `Aborted.` 退出码 1。
/// 用户看到的就是「转换直接失败」。正确做法见下面 `answer_for`：
/// **每一题照抄提示里括号中的默认值**（`[y/n] (y)` → `y`、`(1/1)` → `1/1`）。
const MAX_ANSWERS: usize = 80;
/// 整场转换的上限（实测 20 个提示、最大那个 2.3 MB 的 svp 也在 20 秒内）
const CONVERT_TIMEOUT_SECS: u64 = 600;
/// 提示是不带换行打出来的，所以判据是「安静了一小会儿 + 结尾是冒号」
const PROMPT_QUIET_MS: u64 = 160;

/* ══════════════════════════════════ GBK 编解码 ══════════════════════════════════ */

/// LibreSVIP 的中文提示是按**系统 ANSI 代码页（简体中文 = 936/GBK）**打出来的
/// （试过 `PYTHONIOENCODING=utf-8` / `PYTHONUTF8=1`，没用）。
/// 所以要按 GBK 解，才能按中文关键词认出「这一题问的是什么」。
///
/// 用 Win32 的 `MultiByteToWideChar` 走一圈，**不引第三方编码表**
/// （仓库已经依赖 `windows-sys`，`Win32_Globalization` 也在 feature 里）。
#[cfg(windows)]
fn gbk_to_utf8(bytes: &[u8]) -> String {
    use windows_sys::Win32::Globalization::MultiByteToWideChar;
    if bytes.is_empty() {
        return String::new();
    }
    unsafe {
        let n = MultiByteToWideChar(936, 0, bytes.as_ptr(), bytes.len() as i32, std::ptr::null_mut(), 0);
        if n <= 0 {
            return String::from_utf8_lossy(bytes).into_owned();
        }
        let mut wide = vec![0u16; n as usize];
        let got = MultiByteToWideChar(936, 0, bytes.as_ptr(), bytes.len() as i32, wide.as_mut_ptr(), n);
        if got <= 0 {
            return String::from_utf8_lossy(bytes).into_owned();
        }
        wide.truncate(got as usize);
        String::from_utf16_lossy(&wide)
    }
}

#[cfg(not(windows))]
fn gbk_to_utf8(bytes: &[u8]) -> String {
    String::from_utf8_lossy(bytes).into_owned()
}

/// 反过来：用户填的中文（比如「替换歌词」的原文/替换为）要按 GBK 写给它的 stdin
#[cfg(windows)]
fn utf8_to_gbk(s: &str) -> Vec<u8> {
    use windows_sys::Win32::Globalization::WideCharToMultiByte;
    let wide: Vec<u16> = s.encode_utf16().collect();
    if wide.is_empty() {
        return Vec::new();
    }
    unsafe {
        let n = WideCharToMultiByte(936, 0, wide.as_ptr(), wide.len() as i32, std::ptr::null_mut(), 0, std::ptr::null(), std::ptr::null_mut());
        if n <= 0 {
            return s.as_bytes().to_vec();
        }
        let mut out = vec![0u8; n as usize];
        let got = WideCharToMultiByte(936, 0, wide.as_ptr(), wide.len() as i32, out.as_mut_ptr(), n, std::ptr::null(), std::ptr::null_mut());
        if got <= 0 {
            return s.as_bytes().to_vec();
        }
        out.truncate(got as usize);
        out
    }
}

#[cfg(not(windows))]
fn utf8_to_gbk(s: &str) -> Vec<u8> {
    s.as_bytes().to_vec()
}

/* ══════════════════════════════════ 提问 → 选项 ══════════════════════════════════ */

/// 提示里的中文关键词 → 前端传上来的选项键。
///
/// ⚠️ 这张表是**实测出来的**（把 LibreSVIP 问过的每一题都记下来了，见
/// `docs/FEATURES.md` 的转换一节）。它的题库会随输入/输出格式变，
/// 认不出来的题一律照抄括号里的默认值 —— 所以表不全也不会转失败。
struct PromptRule {
    key: &'static str,
    kw: &'static str,
}

/// ⚠️ **这些键名现在是 LibreSVIP 的官方选项名**（不再是自造的）
/// 来源：`libresvip-cli.exe plugin detail svp/vsqx` 的输出（整理成表见 docs/FEATURES.md §3.1）
/// 版本：LibreSVIP 2.9.0
const RULES: &[PromptRule] = &[
    /* 导入（svp 插件 1.11.2 的官方选项名） */
    PromptRule { key: "导入音量包络", kw: "音量包络" },
    PromptRule { key: "导入力度包络", kw: "力度包络" },
    PromptRule { key: "导入音高曲线", kw: "音高曲线" },
    PromptRule { key: "导入伴奏轨", kw: "伴奏轨" },
    PromptRule { key: "导入性别包络", kw: "性别包络" },
    PromptRule { key: "导入气声包络", kw: "气声包络" },
    PromptRule { key: "遵循即时音高模式设置", kw: "即时音高" },
    PromptRule { key: "音高信息输入模式", kw: "音高信息输入模式" },
    PromptRule { key: "换气音符处理方式", kw: "换气音符" },
    PromptRule { key: "音符组导入方式", kw: "音符组" },
    /* 中间件（这些是旧前端那 13 个「转换处理」选项的真身） */
    PromptRule { key: "middleware.transpose", kw: "音高变调" },
    PromptRule { key: "middleware.scale", kw: "工程缩放" },
    PromptRule { key: "middleware.lyricsPron", kw: "歌词发音转换" },
    PromptRule { key: "middleware.removeShort", kw: "无声间隙" },
    PromptRule { key: "middleware.replaceLyrics", kw: "替换歌词" },
    /* 中间件的追问参数 */
    PromptRule { key: "transpose.semitones", kw: "音高变化量" },
    PromptRule { key: "scale.factor", kw: "缩放系数" },
    PromptRule { key: "removeShort.threshold", kw: "无声间隙长度" },
    PromptRule { key: "replaceLyrics.from", kw: "被替换" },
    PromptRule { key: "replaceLyrics.to", kw: "替换为" },
    /* 导出（vsqx 插件 1.0.0 的官方选项名） */
    PromptRule { key: "VSQX文件版本", kw: "VSQX文件版本" },
    PromptRule { key: "美化XML", kw: "美化XML" },
    PromptRule { key: "默认语言", kw: "默认语言" },
    PromptRule { key: "export.compid", kw: "CompID" },
    PromptRule { key: "export.singer", kw: "默认歌手" },
];

/// 提示里 `(x)` 的那一段 —— **它一定是合法答案**，认不出题目时就照抄它。
///
/// ⚠️ 不要在 `[...]` 的候选里挑第一个：`[1/1/2/1/…] (1/1)` 这种是按 `/` 切开的碎片
/// （候选里有 `1/2`、`3/5` 这类分数），挑第一个会给出非法值，CLI 会一直重问然后 Aborted。
fn default_from_prompt(prompt: &str) -> Option<String> {
    let open = prompt.rfind('(')?;
    let close = prompt.rfind(')')?;
    if close < open {
        return None;
    }
    Some(prompt[open + 1..close].trim().to_string())
}

/// 这一题该答什么：先看用户有没有对得上关键词的选项，否则照抄默认值
fn answer_for(prompt: &str, options: &Value) -> String {
    for rule in RULES {
        if prompt.contains(rule.kw) {
            if let Some(v) = options.get(rule.key) {
                let s = match v {
                    Value::Bool(true) => "y".to_string(),
                    Value::Bool(false) => "n".to_string(),
                    Value::String(s) => s.clone(),
                    other => other.to_string(),
                };
                if !s.is_empty() {
                    return s;
                }
            }
        }
    }
    
    default_from_prompt(prompt).unwrap_or_default()
}

/// 给了中间件的参数就自动把它打开（用户填了「音高变化量 = 3」却要自己再去开开关，太别扭）
/// 
/// ⚠️ **VSQX 自动降级**：LibreSVIP 2.9.0 导出 VSQX 时遇到参数曲线会崩溃
/// （`AttributeError: vsqx_name`）。当目标格式是 VSQX 时，自动关闭这四个包络。
/// 调用方必须检查返回值的 `_vsqx_degraded` 字段，并警告用户丢了什么。
fn normalize_options(options: &Value, to_format: &str) -> Value {
    let mut o = options.clone();
    if !o.is_object() {
        return json!({});
    }
    
    // 中间件参数自动开启对应开关
    let pairs = [
        ("middleware.transpose", "transpose.semitones"),
        ("middleware.scale", "scale.factor"),
    ];
    for (mid, param) in pairs {
        let touched = match o.get(param) {
            Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0).unwrap_or(false),
            Some(Value::String(s)) => !s.trim().is_empty() && s.trim() != "0",
            Some(Value::Bool(b)) => *b,
            _ => false,
        };
        if touched && o.get(mid).is_none() {
            o[mid] = json!(true);
        }
    }
    
    // VSQX 自动降级：关闭会导致崩溃的四个包络
    if to_format.eq_ignore_ascii_case("vsqx") {
        let envelopes = [
            "导入音量包络",
            "导入力度包络", 
            "导入性别包络",
            "导入气声包络",
        ];
        let mut disabled = Vec::new();
        for key in &envelopes {
            if o.get(*key).and_then(|v| v.as_bool()).unwrap_or(true) {
                o[*key] = json!(false);
                disabled.push(*key);
            }
        }
        if !disabled.is_empty() {
            o["_vsqx_degraded"] = json!(disabled);
        }
    }
    
    o
}

/// CLI 可能放的位置
pub fn cli_path(root: &Path) -> Option<PathBuf> {
    let candidates = [
        root.join("tools/libresvip/libresvip-cli/libresvip-cli.exe"),
        root.join("tools/libresvip/libresvip-cli.exe"),
        root.join("tools/libresvip-cli/libresvip-cli.exe"),
        root.join("tools/libresvip-cli.exe"),
    ];
    candidates.into_iter().find(|p| p.is_file())
}



/* ══════════════════════════════════ 格式清单 ══════════════════════════════════ */

/// 支持的全部格式。
///
/// 元数据来自 CLI 自带插件目录里的 `.yapsy-plugin` 文件（其实就是 INI），
/// 比解析 CLI 的表格输出可靠得多 —— 表格有编码和折行问题。
pub fn list_formats(root: &Path) -> Value {
    let Some(cli) = cli_path(root) else {
        return Value::Array(vec![]);
    };
    let base = cli.parent().unwrap_or(Path::new("."));

    // 插件目录可能在 _internal 下，也可能就在旁边
    let mut search_dirs = vec![base.join("_internal/libresvip/plugins"), base.join("libresvip/plugins")];
    if let Ok(entries) = std::fs::read_dir(base) {
        for e in entries.flatten() {
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                search_dirs.push(e.path().join("libresvip/plugins"));
            }
        }
    }

    let mut seen: BTreeMap<String, FormatInfo> = BTreeMap::new();

    for dir in search_dirs.iter().filter(|d| d.is_dir()) {
        let Ok(subs) = std::fs::read_dir(dir) else { continue };
        for sub in subs.flatten() {
            if !sub.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                continue;
            }
            let Ok(files) = std::fs::read_dir(sub.path()) else { continue };
            for f in files.flatten() {
                let name = f.file_name().to_string_lossy().to_string();
                if !name.ends_with(".yapsy-plugin") {
                    continue;
                }
                let Ok(text) = std::fs::read_to_string(f.path()) else { continue };
                let meta = parse_ini(&text);
                let suffix = meta
                    .get("suffix")
                    .cloned()
                    .unwrap_or_else(|| sub.file_name().to_string_lossy().to_string());

                // Suffix 可能是 "acep, acet" 这样的多扩展名
                let exts: Vec<String> = suffix
                    .split(|c: char| c == ',' || c == ';' || c.is_whitespace())
                    .map(|s| s.trim_start_matches('.').to_lowercase())
                    .filter(|s| !s.is_empty())
                    .collect();
                if exts.is_empty() {
                    continue;
                }
                let id = exts[0].clone();
                if seen.contains_key(&id) {
                    continue;
                }
                seen.insert(
                    id.clone(),
                    FormatInfo {
                        id: id.clone(),
                        name: meta.get("name").cloned().unwrap_or_else(|| id.clone()),
                        format: meta.get("format").cloned().unwrap_or_default(),
                        description: meta.get("description").cloned().unwrap_or_default(),
                        author: meta.get("author").cloned().unwrap_or_default(),
                        exts,
                    },
                );
            }
        }
    }

    Value::Array(
        seen.into_values()
            .map(|f| {
                json!({
                    "id": f.id,
                    "name": f.name,
                    "exts": f.exts,
                    "group": guess_group(&f.id),
                    "available": true,
                    "canRead": true,
                    "canWrite": true,
                    "note": if f.format.is_empty() { f.description } else { f.format },
                    "author": f.author,
                })
            })
            .collect(),
    )
}

struct FormatInfo {
    id: String,
    name: String,
    format: String,
    description: String,
    author: String,
    exts: Vec<String>,
}

/// 极简 INI 解析（.yapsy-plugin 就是 `key = value`，没有嵌套）
fn parse_ini(text: &str) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('[') || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some((k, v)) = line.split_once('=') {
            out.insert(k.trim().to_lowercase(), v.trim().to_string());
        }
    }
    out
}

/// 按 id 归组，纯粹为了界面上好找。顺序即优先级。
fn guess_group(id: &str) -> &'static str {
    let groups: &[(&[&str], &str)] = &[
        (&["vsqx", "vsq", "xvsq", "vpr", "vspx", "vog", "vvproj"], "VOCALOID"),
        (&["svp", "s5p"], "Synthesizer V"),
        (&["ust", "ustx"], "UTAU / OpenUtau"),
        (&["acep", "ace", "aisp"], "ACE / AI 歌声"),
        (
            &["ccs", "dv", "dspx", "ds", "nn", "mtp", "tlp", "tlpx", "tsmsln", "tssln", "vshp", "vfp", "y77", "ps_project", "ppsf"],
            "其它歌声编辑器",
        ),
        (&["mid", "musicxml"], "通用交换格式"),
        (&["ufdata", "json", "svip", "svip3"], "中间数据"),
        (&["ass", "lrc", "srt", "svg"], "歌词 / 字幕"),
    ];
    for (ids, name) in groups {
        if ids.contains(&id) {
            return name;
        }
    }
    "其它"
}

/* ══════════════════════════════════ 转换 ══════════════════════════════════ */

pub struct ConvertResult {
    pub ok: bool,
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    pub bytes: u64,
}

/// 转一个工程。格式按扩展名自动推断，不需要额外参数。
/// 转换一个工程。
///
/// `options` 是前端传上来的选项表（键见 `RULES`）；缺的项一律照抄 CLI 提示里的默认值。
///
/// 实现要点（每一条都对应一个踩过的坑）：
///  1. **静默起进程**：用 `crate::server::simple::quiet_command`（CREATE_NO_WINDOW）。
///     以前用 `Command::new`，每转一个文件就闪一个控制台窗口 —— 批量转换时满屏都是窗口。
///  2. **逐题应答**：stdout 单独开线程读、用 channel 递过来；主循环在「安静 160ms
///     且结尾是冒号」时认为它在等回答，写一条答案进去。
///  3. **超时与题量上限**：认不出的题库变化不至于把任务永久挂住。
pub fn convert(root: &Path, input: &Path, output: &Path, options: &Value) -> Result<ConvertResult, String> {
    let cli = cli_path(root).ok_or_else(|| "没有找到 LibreSVIP CLI（应该在 tools\\libresvip\\）".to_string())?;
    if !input.is_file() {
        return Err(format!("源文件不存在：{}", input.display()));
    }
    
    // 提取目标格式（用于 VSQX 自动降级）
    let to_format = output.extension()
        .and_then(|e| e.to_str())
        .unwrap_or("");
    
    let options = normalize_options(options, to_format);
    
    // 检查是否触发了 VSQX 降级，记录警告
    let vsqx_warning = if let Some(disabled) = options.get("_vsqx_degraded").and_then(|v| v.as_array()) {
        let names: Vec<String> = disabled.iter()
            .filter_map(|v| v.as_str())
            .map(|s| s.replace("导入", "").replace("包络", ""))
            .collect();
        if !names.is_empty() {
            Some(format!("⚠️ VSQX 兼容性：已自动关闭 {} 包络（LibreSVIP 2.9.0 导出这些曲线会崩溃）", names.join("、")))
        } else {
            None
        }
    } else {
        None
    };

    let mut child = crate::server::simple::quiet_command(&cli.to_string_lossy())
        .args(["proj", "convert"])
        .arg(input)
        .arg(output)
        .current_dir(cli.parent().unwrap_or(Path::new(".")))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 LibreSVIP 失败：{e}"))?;

    let mut stdin = child.stdin.take().ok_or_else(|| "拿不到 LibreSVIP 的 stdin".to_string())?;
    let mut stdout = child.stdout.take().ok_or_else(|| "拿不到 LibreSVIP 的 stdout".to_string())?;
    let stderr = child.stderr.take();

    // stderr 也单独读：两边都不读会把它堵死（管道写满就卡住）
    let err_handle = stderr.map(|mut e| {
        std::thread::spawn(move || {
            let mut buf = Vec::new();
            let _ = e.read_to_end(&mut buf);
            buf
        })
    });

    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 512];
        loop {
            match stdout.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
            }
        }
    });

    let started = Instant::now();
    let mut raw: Vec<u8> = Vec::new();     // 原始字节（GBK）
    let mut answered_upto = 0usize;        // 已经回答到 raw 的哪个位置
    let mut answers = 0usize;
    let mut timed_out = false;

    loop {
        if started.elapsed() > Duration::from_secs(CONVERT_TIMEOUT_SECS) || answers > MAX_ANSWERS {
            timed_out = true;
            let _ = child.kill();
            break;
        }
        match rx.recv_timeout(Duration::from_millis(PROMPT_QUIET_MS)) {
            Ok(chunk) => {
                raw.extend_from_slice(&chunk);
                // 收到就继续等下一块；等安静下来再判题
                while let Ok(more) = rx.try_recv() {
                    raw.extend_from_slice(&more);
                }
                if let Some(prompt) = pending_prompt(&raw, answered_upto) {
                    let answer = answer_for(&prompt, &options);
                    let mut line = utf8_to_gbk(&answer);
                    line.push(b'\n');
                    if stdin.write_all(&line).is_err() {
                        break;
                    }
                    let _ = stdin.flush();
                    answered_upto = raw.len();
                    answers += 1;
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                // 安静了：可能是在等回答，也可能已经跑完
                if let Some(prompt) = pending_prompt(&raw, answered_upto) {
                    let answer = answer_for(&prompt, &options);
                    let mut line = utf8_to_gbk(&answer);
                    line.push(b'\n');
                    if stdin.write_all(&line).is_err() {
                        break;
                    }
                    let _ = stdin.flush();
                    answered_upto = raw.len();
                    answers += 1;
                    continue;
                }
                match child.try_wait() {
                    Ok(Some(_)) => break,          // 已经退出
                    Ok(None) => continue,          // 还在跑（比如在写文件）
                    Err(_) => break,
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break, // stdout 关了 = 结束
        }
    }

    drop(stdin);
    let status = child.wait().map_err(|e| format!("等待 LibreSVIP 结束失败：{e}"))?;
    let err_bytes = err_handle.and_then(|h| h.join().ok()).unwrap_or_default();

    let code = status.code().unwrap_or(-1);
    let bytes = std::fs::metadata(output).map(|m| m.len()).unwrap_or(0);
    let mut stdout_text = clean_output(&gbk_to_utf8(&raw));
    if timed_out {
        stdout_text.push_str(&format!("（超时 {} 秒，已中止；已答 {} 题）", CONVERT_TIMEOUT_SECS, answers));
    }
    
    // 把 VSQX 降级警告加到 stdout 开头，让用户能看到
    if let Some(warning) = vsqx_warning {
        stdout_text = format!("{}\n\n{}", warning, stdout_text);
    }

    Ok(ConvertResult {
        ok: code == 0 && output.is_file(),
        code,
        stdout: stdout_text,
        stderr: clean_output(&gbk_to_utf8(&err_bytes)),
        bytes,
    })
}

/// 现在是不是在等我们回答？是就把这一题的提示文本返回。
///
/// 判据：从上次回答的位置往后，**去掉尾部空白后以冒号结尾**，且最后一行不长。
/// （LibreSVIP 的提示是 `print` 出来的，不带换行，所以「结尾冒号」就是它的提问形态。）
fn pending_prompt(raw: &[u8], answered_upto: usize) -> Option<String> {
    if answered_upto >= raw.len() {
        return None;
    }
    let text = gbk_to_utf8(&raw[answered_upto..]);
    let trimmed = text.trim_end();
    if !trimmed.ends_with(':') {
        return None;
    }
    let line = trimmed.rsplit('\n').next().unwrap_or(trimmed).trim();
    if line.is_empty() || line.chars().count() > 120 {
        return None;
    }
    Some(line.to_string())
}

/// 去掉 ANSI 控制字符，方便直接显示在界面日志里
fn clean_output(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            // 跳过 ESC [ ... 字母
            if chars.peek() == Some(&'[') {
                chars.next();
                for c2 in chars.by_ref() {
                    if c2.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
        } else {
            out.push(c);
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/* ══════════════════════════════════ 读取（借 ufdata） ══════════════════════════════════ */

/// 读一个工程，返回 ufdata 的 project 部分。
///
/// 做法是把源文件转成 .ufdata（临时文件）再解析 —— 这样任何 LibreSVIP 支持的格式
/// 都能读，而 we 只需要认识一种 JSON 结构。
pub fn read_project(root: &Path, input: &Path) -> Result<Value, String> {
    let tmp = std::env::temp_dir().join(format!(
        "qingmu-ufdata-{}-{}.ufdata",
        std::process::id(),
        now_nanos()
    ));

    /* 读取只关心能不能解析出来，选项一律用 LibreSVIP 的默认值 */
    let result = convert(root, input, &tmp, &json!({}))?;
    let parsed = if result.ok {
        std::fs::read_to_string(&tmp)
            .map_err(|e| format!("读取 ufdata 失败：{e}"))
            .and_then(|t| serde_json::from_str::<Value>(&t).map_err(|e| format!("ufdata 解析失败：{e}")))
    } else {
        // 把 LibreSVIP 的报错原样带出去 —— 它给的诊断信息（比如「音符重叠」）很有用
        let detail = if result.stderr.is_empty() { result.stdout.clone() } else { result.stderr.clone() };
        Err(format!("LibreSVIP 读取失败（退出码 {}）：{}", result.code, detail))
    };

    let _ = std::fs::remove_file(&tmp);
    let data = parsed?;

    data.get("project")
        .cloned()
        .ok_or_else(|| "ufdata 里没有 project 字段".to_string())
}

fn now_nanos() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0)
}

/// 从 ufdata 的 project 里统计出「工程概览」—— /api/convert/inspect 用
pub fn summarize(project: &Value) -> Value {
    let tracks = project.get("tracks").and_then(|t| t.as_array());
    let mut note_count = 0u64;
    let mut pitch_points = 0u64;
    let mut track_list = Vec::new();
    let mut lyrics = Vec::new();

    for t in tracks.into_iter().flatten() {
        let notes = t.get("notes").and_then(|n| n.as_array()).map(|a| a.len()).unwrap_or(0);
        note_count += notes as u64;
        pitch_points += t
            .get("pitch")
            .and_then(|p| p.get("ticks"))
            .and_then(|v| v.as_array())
            .map(|a| a.len())
            .unwrap_or(0) as u64;

        let mut min_key = i64::MAX;
        let mut max_key = i64::MIN;
        for n in t.get("notes").and_then(|n| n.as_array()).into_iter().flatten() {
            if let Some(k) = n.get("key").and_then(|v| v.as_i64()) {
                min_key = min_key.min(k);
                max_key = max_key.max(k);
            }
            if let Some(l) = n.get("lyric").and_then(|v| v.as_str()) {
                if !l.is_empty() && lyrics.len() < 400 {
                    lyrics.push(l.to_string());
                }
            }
        }

        track_list.push(json!({
            "name": t.get("name").and_then(|v| v.as_str()).unwrap_or(""),
            "noteCount": notes,
            "minKey": if min_key == i64::MAX { Value::Null } else { json!(min_key) },
            "maxKey": if max_key == i64::MIN { Value::Null } else { json!(max_key) },
        }));
    }

    let tempos = project.get("tempos").and_then(|t| t.as_array()).cloned().unwrap_or_default();
    let time_sigs = project.get("timeSignatures").and_then(|t| t.as_array()).cloned().unwrap_or_default();

    json!({
        "name": project.get("name").and_then(|v| v.as_str()).unwrap_or(""),
        "trackCount": track_list.len(),
        "noteCount": note_count,
        "pitchPoints": pitch_points,
        "tracks": track_list,
        "tempos": tempos,
        "timeSignatures": time_sigs,
        "lyrics": lyrics,
    })
}

/* ══════════════════════════════════ 单元测试 ══════════════════════════════════ */

#[cfg(test)]
mod prompt_tests {
    use super::*;
    use serde_json::json;

    /// 括号里的默认值才是**一定合法**的答案。
    /// ⚠️ 这里特意包含那个把候选切碎的分数题 —— 曾经因为「在方括号里挑第一个」而 Aborted。
    #[test]
    fn takes_default_from_parentheses() {
        assert_eq!(default_from_prompt("1. 导入音量包络 [y/n] (y):"), Some("y".into()));
        assert_eq!(
            default_from_prompt("1. 缩放系数 [1/1/2/1/1/2/5/3/3/2/6/5/4/5/3/5/3/4] (1/1):"),
            Some("1/1".into())
        );
        assert_eq!(default_from_prompt("4. 默认的CompID (BETDB8W6KWZPYEB9):"), Some("BETDB8W6KWZPYEB9".into()));
        assert_eq!(default_from_prompt("没有括号的题："), None);
    }

    /// 有选项就用选项（bool → y/n），否则照抄默认值
    #[test]
    fn option_wins_over_default() {
        let opts = json!({ "import.pitch": false, "export.vsqxVersion": "3" });
        assert_eq!(answer_for("3. 导入音高曲线 [y/n] (y):", &opts), "n");
        assert_eq!(answer_for("1. VSQX文件版本 [3/4] (4):", &opts), "3");
        // 没给过的题 → 默认值
        assert_eq!(answer_for("2. 美化XML [y/n] (y):", &opts), "y");
        // 空 options → 全默认
        assert_eq!(answer_for("3. 导入音高曲线 [y/n] (y):", &json!({})), "y");
    }

    /// 认题靠中文关键词，而提示是 GBK —— 这条测试同时证明 GBK 解码链路是通的
    #[test]
    fn matches_chinese_keywords_from_gbk_bytes() {
        // "1. 导入音量包络 [y/n] (y):" 的 GBK 字节
        let gbk = utf8_to_gbk("9. 换气音符处理方式 [ignore/keep/convert] (convert):");
        let prompt = gbk_to_utf8(&gbk);
        assert!(prompt.contains("换气音符"), "GBK 往返丢了字：{prompt}");
        let opts = json!({ "import.breathMode": "keep" });
        assert_eq!(answer_for(&prompt, &opts), "keep");
    }

    /// 给了中间件参数就自动开中间件（否则用户填了半音数还要自己去开开关）
    #[test]
    fn parameter_turns_middleware_on() {
        let o = normalize_options(&json!({ "transpose.semitones": 3 }), "svp");
        assert_eq!(o.get("middleware.transpose"), Some(&json!(true)));
        // 0 不算「填过」，不该误开
        let o2 = normalize_options(&json!({ "transpose.semitones": 0 }), "svp");
        assert!(o2.get("middleware.transpose").is_none());
        // 显式关掉时不要被参数打开
        let o3 = normalize_options(&json!({ "transpose.semitones": 3, "middleware.transpose": false }), "svp");
        assert_eq!(o3.get("middleware.transpose"), Some(&json!(false)));
    }

    /// VSQX 自动降级：关闭会导致崩溃的四个包络
    #[test]
    fn vsqx_auto_degrades_envelopes() {
        // 转到 VSQX 时，四个包络自动关闭
        let opts = json!({ "导入音量包络": true, "导入力度包络": true });
        let o = normalize_options(&opts, "vsqx");
        assert_eq!(o.get("导入音量包络"), Some(&json!(false)));
        assert_eq!(o.get("导入力度包络"), Some(&json!(false)));
        assert!(o.get("_vsqx_degraded").is_some());
        
        // 转到别的格式时不降级
        let o2 = normalize_options(&opts, "svp");
        assert_eq!(o2.get("导入音量包络"), Some(&json!(true)));
        assert!(o2.get("_vsqx_degraded").is_none());
    }

    /// 只在「安静下来且结尾是冒号」时才认为它在提问；已经答过的不重复答
    #[test]
    fn detects_pending_prompt() {
        let raw = utf8_to_gbk("导入选项： \n1. 导入音量包络 [y/n] (y): ");
        assert!(pending_prompt(&raw, 0).is_some());
        // 整段都答过了 → 不再认为在等回答
        assert!(pending_prompt(&raw, raw.len()).is_none());
        // 不是冒号结尾（比如正在打日志）→ 不是提问
        let log = utf8_to_gbk("正在写出文件…");
        assert!(pending_prompt(&log, 0).is_none());
    }
}