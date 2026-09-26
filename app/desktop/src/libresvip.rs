//! LibreSVIP 引擎封装
//!
//! 工程转换和「读取工程」两件事都交给它：
//!   - 转换：`libresvip-cli proj convert <in> <out>`
//!   - 读取：转成 `ufdata`（UtaFormatix Data，一种 JSON 中间格式）再解析
//!
//! 后者是关键 —— 有了它就不需要自己写 12 个格式的 reader（Node 版那 10796 行）。
//! 任何 LibreSVIP 支持的格式都能读成统一结构，我们只解析一种 JSON。

use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use serde_json::{json, Value};

/// CLI 需要往 stdin 喂一串「接受默认值」的空行，否则它会卡在交互提问上
/// （实测：不喂就 Aborted 退出，退出码 1）
const STDIN_BLANKS: usize = 60;

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

pub fn is_available(root: &Path) -> bool {
    cli_path(root).is_some()
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
pub fn convert(root: &Path, input: &Path, output: &Path) -> Result<ConvertResult, String> {
    let cli = cli_path(root).ok_or_else(|| "没有找到 LibreSVIP CLI（应该在 tools\\libresvip\\）".to_string())?;
    if !input.is_file() {
        return Err(format!("源文件不存在：{}", input.display()));
    }

    let mut child = Command::new(&cli)
        .args(["proj", "convert"])
        .arg(input)
        .arg(output)
        .current_dir(cli.parent().unwrap_or(Path::new(".")))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("启动 LibreSVIP 失败：{e}"))?;

    // 把导入选项的答案喂进去（空行 = 接受默认值）
    if let Some(mut stdin) = child.stdin.take() {
        let _ = stdin.write_all("\n".repeat(STDIN_BLANKS).as_bytes());
        // 不 drop 得太早：有些版本会在读到 EOF 前就退出
        drop(stdin);
    }

    let out = child
        .wait_with_output()
        .map_err(|e| format!("等待 LibreSVIP 结束失败：{e}"))?;

    let code = out.status.code().unwrap_or(-1);
    let bytes = std::fs::metadata(output).map(|m| m.len()).unwrap_or(0);

    Ok(ConvertResult {
        ok: code == 0 && output.is_file(),
        code,
        stdout: clean_output(&String::from_utf8_lossy(&out.stdout)),
        stderr: clean_output(&String::from_utf8_lossy(&out.stderr)),
        bytes,
    })
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

    let result = convert(root, input, &tmp)?;
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
