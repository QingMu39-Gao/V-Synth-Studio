//! 工程转换的命令。转换本身交给 LibreSVIP；这一层负责编排（批量、命名、输出目录）、
//! 任务进度与错误上报。读取/预检借 LibreSVIP 导出的 ufdata，不自己写格式 reader。
//!
//! ⚠️ **不收 base64 编码的文件内容**：对话框与拖放都给真路径（`pick_paths` /
//! `DragDropEvent::Drop`），而 LibreSVIP 要的本来就是路径。走 base64 要多出 +33% 体积、
//! 还要在 WebView 与 Rust 两边各存一份。**别把它加回来**。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{Value, json};

use super::Cmd;
use super::jobs::{finish_job, is_canceled, log_job, new_job, set_job};

/* ══════════════════════════════════ 收集工程文件 ══════════════════════════════════ */

/// 递归扫描目录，挑出所有已知格式的工程文件。`{ dirs: [...] }`
///
/// ⚠️ 收的是 **`dirs`（数组）**，不是 `dir`：传 `{dir}` 不报错，但会被整个忽略、
/// 永远回 `files: []`。
#[tauri::command]
pub async fn convert_collect(st: super::St<'_>, args: Value) -> Cmd {
    let dirs: Vec<String> = args
        .get("dirs")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();

    // 扩展名表来自 LibreSVIP 的插件元数据 —— 它支持什么就认什么
    let mut known: Vec<String> = Vec::new();
    if let Some(arr) = crate::libresvip::list_formats(&st.inner().root).as_array() {
        for f in arr {
            if let Some(exts) = f.get("exts").and_then(|v| v.as_array()) {
                for e in exts.iter().filter_map(|x| x.as_str()) {
                    known.push(e.to_lowercase());
                }
            }
        }
    }

    let mut files = Vec::new();
    for d in &dirs {
        collect_into(Path::new(d), &known, &mut files, 0);
    }
    files.sort();

    Ok(json!({
        "files": files,
        "count": files.len(),
        "extensions": known,
    }))
}

/// 深度上限 6 层、最多 5000 个 —— 防的是用户手滑选到盘符根目录（整盘扫一遍）。
fn collect_into(dir: &Path, known: &[String], out: &mut Vec<String>, depth: usize) {
    if depth > 6 || out.len() > 5000 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for e in entries.flatten() {
        let p = e.path();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            collect_into(&p, known, out, depth + 1);
        } else if ft.is_file()
            && let Some(ext) = p.extension().and_then(|x| x.to_str())
            && known.contains(&ext.to_lowercase())
        {
            out.push(p.to_string_lossy().to_string());
        }
    }
}

/* ══════════════════════════════════ 读取工程 ══════════════════════════════════ */

/// 读一个工程并给出概览（轨道数、音符数、音域、歌词…）。`{ inputPath }`
///
/// `inputPath` 与 `path` 两种写法都收下（调用方两种都用过）。
#[tauri::command]
pub async fn convert_inspect(st: super::St<'_>, args: Value) -> Cmd {
    let input = args
        .get("inputPath")
        .or_else(|| args.get("path"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if input.is_empty() {
        return Err("缺少 inputPath".into());
    }

    // 读取要跑 LibreSVIP，是阻塞操作，挪到阻塞线程池
    let root = st.inner().root.clone();
    let path = PathBuf::from(input);
    let result = tokio::task::spawn_blocking(move || {
        let project = crate::libresvip::read_project(&root, &path)?;
        Ok::<_, String>(crate::libresvip::summarize(&project))
    })
    .await
    .map_err(|e| format!("读取任务失败：{e}"))?
    .map_err(|e| e.to_string())?;

    Ok(json!({
        "stats": {
            "trackCount": result["trackCount"],
            "noteCount": result["noteCount"],
        },
        "tracks": result["tracks"],
        "tempos": result["tempos"],
        "timeSignatures": result["timeSignatures"],
        "lyrics": result["lyrics"],
    }))
}

/* ══════════════════════════════════ 转换前预检 ══════════════════════════════════ */

/// 转换前告诉用户「目标格式装不下哪些数据」。`{ inputs, toFormat }`
///
/// LibreSVIP 自己不做这件事（它只问导入选项，不报数据损失），
/// 所以这里读源工程 + 查目标格式能力表来生成提示。
#[tauri::command]
pub async fn convert_preview(st: super::St<'_>, args: Value) -> Cmd {
    let inputs: Vec<String> = args
        .get("inputs")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    let to_format = args.get("toFormat").and_then(|v| v.as_str()).unwrap_or("");
    if inputs.is_empty() {
        return Err("没有选择要转换的文件".into());
    }

    let root = st.inner().root.clone();
    let first = PathBuf::from(&inputs[0]);
    let to = to_format.to_string();

    let findings = tokio::task::spawn_blocking(move || {
        let mut findings: Vec<Value> = Vec::new();
        match crate::libresvip::read_project(&root, &first) {
            Ok(project) => {
                let s = crate::libresvip::summarize(&project);
                let notes = s["noteCount"].as_u64().unwrap_or(0);
                let pitch = s["pitchPoints"].as_u64().unwrap_or(0);
                findings.push(json!({
                    "level": "info",
                    "message": format!("源工程：{} 轨 / {} 音符{}",
                        s["trackCount"].as_u64().unwrap_or(0), notes,
                        if pitch > 0 { format!(" / 音高曲线 {pitch} 点") } else { String::new() }),
                }));

                if let Some(limits) = capability(&to) {
                    if !limits.pitch && pitch > 0 {
                        findings.push(json!({ "level": "warn",
                            "message": "目标格式不支持音高曲线，调好的滑音会丢失。".to_string() }));
                    }
                    if !limits.multi_track && s["trackCount"].as_u64().unwrap_or(0) > 1 {
                        findings.push(json!({ "level": "warn",
                            "message": format!("目标格式是单轨的，{} 条轨道会被合并成 1 条。",
                                s["trackCount"].as_u64().unwrap_or(1)) }));
                    }
                    if !limits.lyrics && notes > 0 {
                        findings.push(json!({ "level": "warn",
                            "message": "目标格式不承载歌词。".to_string() }));
                    }
                    if !limits.notes && notes > 0 {
                        findings.push(json!({ "level": "warn",
                            "message": format!("目标格式只保存歌词文本，{notes} 个音符与时值会全部丢弃。") }));
                    }
                } else if !to.is_empty() {
                    /* 表里没有的格式**不能装作没问题**：预检的职责就是说出丢什么，
                    漏判的后果是用户以为查过了。 */
                    findings.push(json!({ "level": "warn",
                        "message": format!("预检还不认识目标格式「{to}」，多轨、音高曲线与歌词能否保留无法判断，请转换后自行核对。") }));
                }
            }
            Err(e) => findings.push(json!({ "level": "err", "message": format!("读取失败：{e}") })),
        }
        findings
    })
    .await
    .map_err(|e| format!("预检任务失败：{e}"))?;

    Ok(json!({
        "findings": findings,
        "inputCount": inputs.len(),
    }))
}

/// 各目标格式的能力（决定预检提示什么）
struct Capability {
    pitch: bool,
    multi_track: bool,
    lyrics: bool,
    /// 目标格式只承载文本行时，音符与时值整份丢弃 —— 不只是一条音高曲线没了
    notes: bool,
}

/// 随包 LibreSVIP 的 40 个插件里，歌声工程类格式的能力是一样的：
/// 音高、多轨、歌词都带。表外的格式**必须**由 [`capability`] 返回 `None`，
/// 让预检去报「不认识」，而不是默默什么都不提示。
const VOCAL_PROJECT: &[&str] = &[
    // 既有条目
    "vsqx",
    "vpr",
    "vsq",
    "svp",
    "s5p",
    "ustx",
    "ccs",
    "acep",
    "dv",
    "dspx",
    "ufdata",
    // 随包另外 22 个插件（原先不在表里，预检对它们一句话都不说）
    "ace",
    "aisp",
    "ds",
    "json",
    "mtp",
    "nn",
    "ppsf",
    "ps_project",
    "svip",
    "svip3",
    "tlp",
    "tlpx",
    "tsmsln",
    "tssln",
    "vfp",
    "vog",
    "vshp",
    "vspx",
    "vvproj",
    "vxf",
    "xvsq",
    "y77",
];

fn capability(format: &str) -> Option<Capability> {
    let c = match format {
        // 乐谱类：有音高概念，但没有实际音高曲线；不带歌词（除非手动填）
        "musicxml" | "mid" => Capability {
            pitch: false,
            multi_track: true,
            lyrics: true,
            notes: true,
        },
        // UTAU 单轨
        "ust" => Capability {
            pitch: false,
            multi_track: false,
            lyrics: true,
            notes: true,
        },
        // 纯文本行：只有歌词和时间，音符与时值一个都留不下
        "lrc" | "ass" | "srt" => Capability {
            pitch: false,
            multi_track: false,
            lyrics: true,
            notes: false,
        },
        // svg 画的就是音符与音高，内容留得下（只是不能反向编辑）
        "svg" => Capability {
            pitch: false,
            multi_track: false,
            lyrics: true,
            notes: true,
        },
        id if VOCAL_PROJECT.contains(&id) => Capability {
            pitch: true,
            multi_track: true,
            lyrics: true,
            notes: true,
        },
        _ => return None,
    };
    Some(c)
}

/* ══════════════════════════════════ 执行转换 ══════════════════════════════════ */

/// 真转。`{ inputs, toFormat, outDir?, nameTemplate?, overwrite?, options? }` → `{ jobId }`
///
/// 立刻回 `jobId`，之后后台跑、进度走 `job_watch`。
///
/// `options` 是 LibreSVIP 的转换选项（它是「转换时逐题提问」，`libresvip::convert`
/// 按这里的键回答那些提问，键名见 `libresvip::RULES`）。
#[tauri::command]
pub async fn convert_run(st: super::St<'_>, args: Value) -> Cmd {
    let inputs: Vec<String> = args
        .get("inputs")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default();
    if inputs.is_empty() {
        return Err("没有选择要转换的文件".into());
    }

    let to_format = args.get("toFormat").and_then(|v| v.as_str()).unwrap_or("");
    if to_format.is_empty() {
        return Err("没有选择目标格式".into());
    }

    let cfg = st.config_snapshot();
    let out_dir = args
        .get("outDir")
        .and_then(|v| v.as_str())
        .map(String::from)
        .or_else(|| {
            cfg.get("outputDir")
                .and_then(|v| v.as_str())
                .map(String::from)
        })
        .unwrap_or_default();
    let name_template = args
        .get("nameTemplate")
        .and_then(|v| v.as_str())
        .unwrap_or("{name}")
        .to_string();
    let overwrite = args
        .get("overwrite")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let options = args.get("options").cloned().unwrap_or_else(|| json!({}));

    // 目标扩展名：取该格式的第一个扩展名
    let ext = crate::libresvip::list_formats(&st.inner().root)
        .as_array()
        .and_then(|a| {
            a.iter()
                .find(|f| f.get("id").and_then(|v| v.as_str()) == Some(to_format))
        })
        .and_then(|f| f.get("exts"))
        .and_then(|e| e.as_array())
        .and_then(|a| a.first())
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| format!("LibreSVIP 不支持目标格式「{to_format}」"))?;

    /*
     * ⚠️ **输出目录必须先建出来。** LibreSVIP 自己不会层层建目录，写文件时直接
     * `FileNotFoundError` 抛出来（PyInstaller 包成「Failed to execute script」），
     * 任务里只剩一句「退出码 1」—— 用户看到的就是「转换直接失败」。
     * 目录不存在时 100% 失败，先建出来就过。
     */
    if !out_dir.is_empty() {
        std::fs::create_dir_all(&out_dir).map_err(|e| format!("建输出目录失败：{e}"))?;
    }

    let st_arc: Arc<super::AppState> = st.inner().clone();
    let job_id = new_job(
        &st_arc,
        "convert",
        &format!("转换 {} 个工程 → .{}", inputs.len(), ext),
    );

    // 后台执行，立刻返回 jobId
    let st2 = Arc::clone(&st_arc);
    let job_id2 = job_id.clone();
    tokio::spawn(async move {
        let total = inputs.len();
        let mut ok_count = 0usize;
        let mut fail_count = 0usize;

        for (i, input) in inputs.iter().enumerate() {
            /* ⚠️ 取消只改了任务状态（`set_job` 对终态不覆盖），循环必须自己来问。
            不问的话界面上显示「已取消」、后台却把剩下几十个工程照常转完并写盘。 */
            if is_canceled(&st2, &job_id2) {
                log_job(
                    &st2,
                    &job_id2,
                    &format!("已取消，剩余 {} 个文件不再处理", total - i),
                );
                return;
            }
            let base = ((i as f64 / total as f64) * 100.0) as u32;
            let file_name = Path::new(input)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| input.clone());

            set_job(
                &st2,
                &job_id2,
                json!({ "percent": base, "message": format!("正在处理 {file_name}") }),
            );
            log_job(&st2, &job_id2, &format!("开始：{file_name}"));

            // 目标路径
            let stem = Path::new(input)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "output".into());
            let named = name_template.replace("{name}", &stem);
            let requested_path = PathBuf::from(&out_dir).join(format!("{named}.{ext}"));
            // Reserve the name before starting the conversion. A plain exists() check is
            // racy when two conversion jobs run at the same time.
            let reservation = if overwrite {
                None
            } else {
                match reserve_unique_path(requested_path.clone()) {
                    Ok(r) => Some(r),
                    Err(e) => {
                        fail_count += 1;
                        log_job(&st2, &job_id2, &format!("  ✗ {e}"));
                        continue;
                    }
                }
            };
            let out_path = reservation
                .as_ref()
                .map(|r| r.path().to_path_buf())
                .unwrap_or(requested_path);

            let root = st2.root.clone();
            let inp = PathBuf::from(input);
            let outp = out_path.clone();

            let opts = options.clone();
            let result = tokio::task::spawn_blocking(move || {
                crate::libresvip::convert(&root, &inp, &outp, &opts)
            })
            .await;

            match result {
                Ok(Ok(r)) if r.ok => {
                    ok_count += 1;
                    let name = out_path
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_default();
                    set_job(
                        &st2,
                        &job_id2,
                        json!({
                            "percent": (((i + 1) as f64 / total as f64) * 100.0) as u32,
                            "message": format!("完成 {file_name}"),
                        }),
                    );
                    log_job(
                        &st2,
                        &job_id2,
                        &format!("  写出：{name}（{:.1} KB）", r.bytes as f64 / 1024.0),
                    );
                }
                Ok(Ok(r)) => {
                    fail_count += 1;
                    let detail = if r.stderr.is_empty() {
                        r.stdout
                    } else {
                        r.stderr
                    };
                    let msg = format!(
                        "LibreSVIP 退出码 {}{}",
                        r.code,
                        if detail.is_empty() {
                            String::new()
                        } else {
                            format!("：{detail}")
                        }
                    );
                    log_job(&st2, &job_id2, &format!("  ✗ {msg}"));
                }
                Ok(Err(e)) => {
                    fail_count += 1;
                    log_job(&st2, &job_id2, &format!("  ✗ {e}"));
                }
                Err(e) => {
                    fail_count += 1;
                    log_job(&st2, &job_id2, &format!("  ✗ 任务调度失败：{e}"));
                }
            }
        }

        finish_job(
            &st2,
            &job_id2,
            &format!("完成：成功 {ok_count} / 失败 {fail_count}"),
        );
    });

    Ok(json!({ "jobId": job_id }))
}

/// Reserve an output name so concurrent conversion jobs cannot choose the same path.
static RESERVED_OUTPUTS: OnceLock<Mutex<HashSet<PathBuf>>> = OnceLock::new();

fn reserved_outputs() -> &'static Mutex<HashSet<PathBuf>> {
    RESERVED_OUTPUTS.get_or_init(|| Mutex::new(HashSet::new()))
}

struct OutputReservation(PathBuf);

impl OutputReservation {
    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for OutputReservation {
    fn drop(&mut self) {
        if let Ok(mut reserved) = reserved_outputs().lock() {
            reserved.remove(&self.0);
        }
    }
}

fn reserve_unique_path(p: PathBuf) -> Result<OutputReservation, String> {
    let mut reserved = reserved_outputs()
        .lock()
        .map_err(|_| "输出文件名预留锁已损坏".to_string())?;

    if !p.exists() && reserved.insert(p.clone()) {
        return Ok(OutputReservation(p));
    }

    let dir = p.parent().map(|d| d.to_path_buf()).unwrap_or_default();
    let stem = p
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();
    let ext = p
        .extension()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_default();

    for n in 2..1000 {
        let cand = dir.join(format!("{stem} ({n}).{ext}"));
        if !cand.exists() && reserved.insert(cand.clone()) {
            return Ok(OutputReservation(cand));
        }
    }

    Err(format!(
        "无法为「{}」分配不冲突的输出文件名（已尝试 999 个候选名）",
        p.display()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn concurrent_reservations_get_different_paths() {
        let base = std::env::temp_dir().join(format!(
            "vss-output-reservation-{}-{}.vsqx",
            std::process::id(),
            crate::ipc::config_file::now_millis()
        ));
        let first = reserve_unique_path(base.clone()).expect("first reservation");
        let second = reserve_unique_path(base.clone()).expect("second reservation");
        assert_ne!(first.path(), second.path());
        assert_eq!(first.path(), base);
        assert_eq!(
            second.path(),
            base.with_file_name(format!(
                "{} (2).vsqx",
                base.file_stem().unwrap().to_string_lossy()
            ))
        );
        drop(first);
        drop(second);
        let third = reserve_unique_path(base.clone()).expect("reservation after release");
        assert_eq!(third.path(), base);
        drop(third);
    }

    // 能力表的真源是随包插件目录。表漏一个 id，预检对那种目标格式就一句提示都没有
    // —— 用户以为查过了，多轨 / 音高 / 歌词照样静默丢。这里同时钉两件事：
    // 这一版随包的 40 个 id 都在表里；本地拉下 tools/ 之后，新插件也会被抓到。
    #[test]
    fn every_bundled_plugin_id_has_a_capability_entry() {
        const BUNDLED: [&str; 40] = [
            "ace",
            "acep",
            "aisp",
            "ass",
            "ccs",
            "ds",
            "dspx",
            "dv",
            "json",
            "lrc",
            "mid",
            "mtp",
            "musicxml",
            "nn",
            "ppsf",
            "ps_project",
            "s5p",
            "srt",
            "svg",
            "svip",
            "svip3",
            "svp",
            "tlp",
            "tlpx",
            "tsmsln",
            "tssln",
            "ufdata",
            "ust",
            "ustx",
            "vfp",
            "vog",
            "vpr",
            "vshp",
            "vspx",
            "vsq",
            "vsqx",
            "vvproj",
            "vxf",
            "xvsq",
            "y77",
        ];
        for id in BUNDLED {
            assert!(capability(id).is_some(), "能力表漏了「{id}」");
        }

        // `tools/` 是本地拉的构建产物、不入库，拿不到就只核上面那份清单
        let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../tools/libresvip/libresvip-cli/_internal/libresvip/plugins");
        let Ok(entries) = std::fs::read_dir(dir) else {
            return;
        };
        for e in entries.flatten() {
            if !e.path().is_dir() {
                continue;
            }
            let id = e.file_name().to_string_lossy().to_string();
            assert!(
                capability(&id).is_some(),
                "随包新插件「{id}」没有能力条目 —— 预检会静默跳过它"
            );
        }
    }
}
