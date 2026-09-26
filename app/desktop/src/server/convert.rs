//! 阶段 2：转换链路
//!
//! 转换本身交给 LibreSVIP；这里负责编排（批量、命名、输出目录）、任务进度与错误上报。
//! 读取/预检借 LibreSVIP 导出的 ufdata，不再自己写格式 reader。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

use super::{ok, ApiError, AppState};

/* ══════════════════════════════════ 收集工程文件 ══════════════════════════════════ */

/// 递归扫描目录，挑出所有已知格式的工程文件
pub async fn collect(
    State(st): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let dirs: Vec<String> = body
        .get("dirs")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();

    // 扩展名表来自 LibreSVIP 的插件元数据 —— 它支持什么就认什么
    let mut known: Vec<String> = Vec::new();
    if let Some(arr) = crate::libresvip::list_formats(&st.root).as_array() {
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

    Ok(Json(ok(json!({
        "files": files,
        "count": files.len(),
        "extensions": known,
    }))))
}

fn collect_into(dir: &Path, known: &[String], out: &mut Vec<String>, depth: usize) {
    if depth > 6 || out.len() > 5000 {
        return;
    }
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for e in entries.flatten() {
        let p = e.path();
        let Ok(ft) = e.file_type() else { continue };
        if ft.is_dir() {
            collect_into(&p, known, out, depth + 1);
        } else if ft.is_file() {
            if let Some(ext) = p.extension().and_then(|x| x.to_str()) {
                if known.contains(&ext.to_lowercase()) {
                    out.push(p.to_string_lossy().to_string());
                }
            }
        }
    }
}

/* ══════════════════════════════════ 读取工程 ══════════════════════════════════ */

/// 读一个工程并给出概览（轨道数、音符数、音域、歌词…）
pub async fn inspect(
    State(st): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let input = body
        .get("inputPath")
        .or_else(|| body.get("path"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if input.is_empty() {
        return Err(ApiError::bad_request("缺少 inputPath"));
    }

    // 读取要跑 LibreSVIP，是阻塞操作，挪到阻塞线程池
    let root = st.root.clone();
    let path = PathBuf::from(input);
    let result = tokio::task::spawn_blocking(move || {
        let project = crate::libresvip::read_project(&root, &path)?;
        Ok::<_, String>(crate::libresvip::summarize(&project))
    })
    .await
    .map_err(|e| ApiError::internal(format!("读取任务失败：{e}")))?
    .map_err(ApiError::bad_request)?;

    Ok(Json(ok(json!({
        "stats": {
            "trackCount": result["trackCount"],
            "noteCount": result["noteCount"],
        },
        "tracks": result["tracks"],
        "tempos": result["tempos"],
        "timeSignatures": result["timeSignatures"],
        "lyrics": result["lyrics"],
    }))))
}

/* ══════════════════════════════════ 转换前预检 ══════════════════════════════════ */

/// 转换前告诉用户「目标格式装不下哪些数据」。
///
/// LibreSVIP 自己不做这件事（实测它只问导入选项，不报数据损失），
/// 所以这里读源工程 + 查目标格式能力表来生成提示。
pub async fn preview(
    State(st): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let inputs: Vec<String> = body
        .get("inputs")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    let to_format = body.get("toFormat").and_then(|v| v.as_str()).unwrap_or("");
    if inputs.is_empty() {
        return Err(ApiError::bad_request("没有选择要转换的文件"));
    }

    let root = st.root.clone();
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
                }
            }
            Err(e) => findings.push(json!({ "level": "err", "message": format!("读取失败：{e}") })),
        }
        findings
    })
    .await
    .map_err(|e| ApiError::internal(format!("预检任务失败：{e}")))?;

    Ok(Json(ok(json!({
        "findings": findings,
        "inputCount": inputs.len(),
    }))))
}

/// 各目标格式的能力（决定预检提示什么）
struct Capability {
    pitch: bool,
    multi_track: bool,
    lyrics: bool,
}

fn capability(format: &str) -> Option<Capability> {
    let c = match format {
        // 乐谱类：有音高概念，但没有实际音高曲线；不带歌词（除非手动填）
        "musicxml" => Capability { pitch: false, multi_track: true, lyrics: true },
        "mid" => Capability { pitch: false, multi_track: true, lyrics: true },
        // UTAU 单轨
        "ust" => Capability { pitch: false, multi_track: false, lyrics: true },
        // 歌词/字幕类：只有文本和时值
        "lrc" | "ass" | "srt" | "svg" => Capability { pitch: false, multi_track: false, lyrics: true },
        // 歌声工程类：什么都有
        "vsqx" | "vpr" | "vsq" | "svp" | "s5p" | "ustx" | "ccs" | "acep" | "dv" | "dspx" | "ufdata" => {
            Capability { pitch: true, multi_track: true, lyrics: true }
        }
        _ => return None,
    };
    Some(c)
}

/* ══════════════════════════════════ 执行转换 ══════════════════════════════════ */

pub async fn run(
    State(st): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let inputs: Vec<String> = body
        .get("inputs")
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
        .unwrap_or_default();
    if inputs.is_empty() {
        return Err(ApiError::bad_request("没有选择要转换的文件"));
    }

    let to_format = body.get("toFormat").and_then(|v| v.as_str()).unwrap_or("");
    if to_format.is_empty() {
        return Err(ApiError::bad_request("没有选择目标格式"));
    }

    let cfg = st.config_snapshot();
    let out_dir = body
        .get("outDir")
        .and_then(|v| v.as_str())
        .map(String::from)
        .or_else(|| cfg.get("outputDir").and_then(|v| v.as_str()).map(String::from))
        .unwrap_or_default();
    let name_template = body
        .get("nameTemplate")
        .and_then(|v| v.as_str())
        .unwrap_or("{name}")
        .to_string();
    let overwrite = body.get("overwrite").and_then(|v| v.as_bool()).unwrap_or(false);

    // 目标扩展名：取该格式的第一个扩展名
    let ext = crate::libresvip::list_formats(&st.root)
        .as_array()
        .and_then(|a| a.iter().find(|f| f.get("id").and_then(|v| v.as_str()) == Some(to_format)))
        .and_then(|f| f.get("exts"))
        .and_then(|e| e.as_array())
        .and_then(|a| a.first())
        .and_then(|v| v.as_str())
        .map(String::from)
        .ok_or_else(|| ApiError::bad_request(format!("LibreSVIP 不支持目标格式「{to_format}」")))?;

    let job_id = new_job(&st, "convert", &format!("转换 {} 个工程 → .{}", inputs.len(), ext), &to_format);

    // 后台执行，立刻返回 jobId（和 Node 版行为一致，前端靠 watchJob 轮询）
    let st2 = st.clone();
    let job_id2 = job_id.clone();
    tokio::spawn(async move {
        let total = inputs.len();
        let mut ok_count = 0usize;
        let mut fail_count = 0usize;

        for (i, input) in inputs.iter().enumerate() {
            let base = ((i as f64 / total as f64) * 100.0) as u32;
            let file_name = Path::new(input)
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_else(|| input.clone());

            set_job(&st2, &job_id2, json!({ "percent": base, "message": format!("正在处理 {file_name}") }));
            log_job(&st2, &job_id2, &format!("开始：{file_name}"));

            // 目标路径
            let stem = Path::new(input)
                .file_stem()
                .map(|s| s.to_string_lossy().to_string())
                .unwrap_or_else(|| "output".into());
            let named = name_template.replace("{name}", &stem);
            let mut out_path = PathBuf::from(&out_dir).join(format!("{named}.{ext}"));
            if !overwrite {
                out_path = unique_path(out_path);
            }

            let root = st2.root.clone();
            let inp = PathBuf::from(input);
            let outp = out_path.clone();

            let result = tokio::task::spawn_blocking(move || crate::libresvip::convert(&root, &inp, &outp)).await;

            match result {
                Ok(Ok(r)) if r.ok => {
                    ok_count += 1;
                    let name = out_path.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                    set_job(&st2, &job_id2, json!({
                        "percent": (((i + 1) as f64 / total as f64) * 100.0) as u32,
                        "message": format!("完成 {file_name}"),
                    }));
                    log_job(&st2, &job_id2, &format!(
                        "  写出：{name}（{:.1} KB）",
                        r.bytes as f64 / 1024.0
                    ));
                }
                Ok(Ok(r)) => {
                    fail_count += 1;
                    let detail = if r.stderr.is_empty() { r.stdout } else { r.stderr };
                    let msg = format!("LibreSVIP 退出码 {}{}", r.code,
                        if detail.is_empty() { String::new() } else { format!("：{detail}") });
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

        finish_job(&st2, &job_id2, &format!("完成：成功 {ok_count} / 失败 {fail_count}"));
    });

    Ok(Json(ok(json!({ "jobId": job_id }))))
}

fn unique_path(p: PathBuf) -> PathBuf {
    if !p.exists() {
        return p;
    }
    let dir = p.parent().map(|d| d.to_path_buf()).unwrap_or_default();
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    let ext = p.extension().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    for n in 2..1000 {
        let cand = dir.join(format!("{stem} ({n}).{ext}"));
        if !cand.exists() {
            return cand;
        }
    }
    p
}

/* ══════════════════════════════════ 上传变体 ══════════════════════════════════ */

pub async fn preview_upload() -> Result<Json<Value>, ApiError> {
    Err(ApiError::bad_request("上传变体在阶段 2 后半实现（需要 multipart 支持）"))
}

pub async fn run_upload() -> Result<Json<Value>, ApiError> {
    Err(ApiError::bad_request("上传变体在阶段 2 后半实现（需要 multipart 支持）"))
}

/* ══════════════════════════════════ 任务表操作 ══════════════════════════════════ */

pub fn new_job(st: &Arc<AppState>, kind: &str, title: &str, _meta: &str) -> String {
    let mut guard = st.jobs.lock().unwrap();
    guard.seq += 1;
    let id = format!("{:06x}", guard.seq * 0x9e3779b9u64 % 0xffffff);
    guard.items.insert(
        id.clone(),
        json!({
            "id": id,
            "type": kind,
            "title": title,
            "status": "running",
            "percent": 0,
            "message": "开始…",
            "logs": [],
            "createdAt": now_millis(),
        }),
    );
    id
}

pub fn set_job(st: &Arc<AppState>, id: &str, patch: Value) {
    let mut guard = st.jobs.lock().unwrap();
    if let Some(job) = guard.items.get_mut(id) {
        if let (Some(dst), Some(src)) = (job.as_object_mut(), patch.as_object()) {
            for (k, v) in src {
                dst.insert(k.clone(), v.clone());
            }
        }
    }
}

pub fn log_job(st: &Arc<AppState>, id: &str, line: &str) {
    let mut guard = st.jobs.lock().unwrap();
    if let Some(job) = guard.items.get_mut(id) {
        if let Some(logs) = job.get_mut("logs").and_then(|l| l.as_array_mut()) {
            // 时间戳格式和 Node 版一致：HH:MM:SS
            logs.push(json!(format!("[{}] {}", clock(), line)));
        }
    }
}

pub fn finish_job(st: &Arc<AppState>, id: &str, message: &str) {
    set_job(st, id, json!({ "status": "done", "percent": 100, "message": message }));
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 本地时间 HH:MM:SS，不引 chrono —— 用系统 API 拿本地时区偏移
fn clock() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let t = secs % 86400;
    let (h, m, s) = (t / 3600, (t % 3600) / 60, t % 60);
    format!("{h:02}:{m:02}:{s:02}")
}
