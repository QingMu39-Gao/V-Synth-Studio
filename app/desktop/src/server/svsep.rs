//! 音轨分离 —— 在线（MVSEP）与离线（内嵌分离引擎）两条路
//!
//! 这一组路由**只是转发**：真正的活在 Python 那边的分离后端里
//! （见 `crate::svsep`）。转发的收益是前端只认一个后端、一套 CORS 与错误形状，
//! 而且「服务没起来」这类话说得比 Python 的英文堆栈清楚。
//!
//! 路由一览：
//!   GET  /api/svsep/status              运行时/模型/服务状态（前端轮询它）
//!   POST /api/svsep/start               起分离服务
//!   POST /api/svsep/stop                停分离服务
//!   POST /api/svsep/runtime/download    下运行时 zip（几 GB）并解压
//!   POST /api/svsep/models/download     下模型 zip 并解压
//!   POST /api/svsep/separate            提交一次分离（multipart 原样转发）
//!   GET  /api/svsep/task/{id}           查任务
//!   GET  /api/svsep/task/{id}/out/{i}   取输出文件（流式）
//!   POST /api/svsep/open-output         在资源管理器里打开输出目录

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::Response;
use axum::Json;
use serde_json::{json, Value};

use super::{ok, ApiError, AppState};

/// 提交分离时允许的最大 body（600 MB）。
///
/// 上游后端自己的上限是 100 MB（`config.MAX_CONTENT_LENGTH`），这里放宽只是为了
/// 不让**工作站**先把它拦下来 —— 真正的判据在 Python 那边，超了它会回
/// 一句人能看懂的「不支持的文件类型 / 太大」。两层限制写不一样是有意的：
/// axum 这层超了只会回一个干巴巴的 413。
pub const SEPARATE_LIMIT: usize = 600 * 1024 * 1024;

/// 大包下载进度。前端每 2 秒轮询一次 `/api/svsep/status` 就能看到它动。
///
/// 放全局静态是因为「同一时刻只可能有一个下载」—— 用户能同时点两次，
/// 但第二次会被 `DL_ACTIVE` 挡掉。运行时（几 GB）与模型（730 MB）共用这一份
/// 状态，`DL_KIND` 说明现在下的是哪一个，界面按它显示对应的按钮。
static DL_BYTES: AtomicU64 = AtomicU64::new(0);
static DL_TOTAL: AtomicU64 = AtomicU64::new(0);
static DL_ACTIVE: AtomicU64 = AtomicU64::new(0);
static DL_ERROR: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
static DL_KIND: std::sync::Mutex<Option<&'static str>> = std::sync::Mutex::new(None);

fn download_state() -> Value {
    let active = DL_ACTIVE.load(Ordering::Relaxed) == 1;
    let err = DL_ERROR.lock().ok().and_then(|e| e.clone());
    let kind = DL_KIND.lock().ok().and_then(|k| *k);
    json!({
        "active": active,
        // "runtime" / "models"；没有下载时是 null
        "kind": kind,
        "done": DL_BYTES.load(Ordering::Relaxed) as f64,
        "total": DL_TOTAL.load(Ordering::Relaxed) as f64,
        "error": err,
    })
}

/// 起一个下载任务，立刻返回。两个下载端点共用。
///
/// 下载要跑几分钟到几小时（运行时几 GB），**不能占着请求** —— 回一句
/// 「开始了」，进度由前端轮询 `/api/svsep/status` 的 `download` 拿。
fn spawn_download<F>(kind: &'static str, job: F) -> Result<Json<Value>, ApiError>
where
    F: std::future::Future<Output = Result<Value, String>> + Send + 'static,
{
    if DL_ACTIVE.load(Ordering::Relaxed) == 1 {
        let now = DL_KIND.lock().ok().and_then(|k| *k).unwrap_or("包");
        let now = if now == "runtime" { "运行时" } else { "模型" };
        return Err(ApiError::bad_request(format!(
            "{now}正在下载中，等这一次下完再点"
        )));
    }
    if let Ok(mut e) = DL_ERROR.lock() {
        *e = None;
    }
    if let Ok(mut k) = DL_KIND.lock() {
        *k = Some(kind);
    }
    DL_BYTES.store(0, Ordering::Relaxed);
    DL_TOTAL.store(0, Ordering::Relaxed);
    DL_ACTIVE.store(1, Ordering::Relaxed);

    tokio::spawn(async move {
        let res = job.await;
        DL_ACTIVE.store(0, Ordering::Relaxed);
        if let Ok(mut k) = DL_KIND.lock() {
            *k = None;
        }
        if let Err(e) = res {
            if let Ok(mut slot) = DL_ERROR.lock() {
                *slot = Some(e);
            }
        }
    });

    Ok(Json(ok(json!({ "started": true }))))
}

fn note_progress(got: u64, total: Option<u64>) {
    DL_BYTES.store(got, Ordering::Relaxed);
    if let Some(t) = total {
        DL_TOTAL.store(t, Ordering::Relaxed);
    }
}

pub async fn status(State(st): State<Arc<AppState>>) -> Json<Value> {
    let s = &st.svsep;
    let running = s.probe().await;
    Json(ok(json!({
        "runtimeReady": s.runtime_ready(),
        "dir": s.dir().to_string_lossy(),
        "modelsDir": s.models().to_string_lossy(),
        "dataDir": s.data().to_string_lossy(),
        "runtime": crate::svsep::runtime_status(&st.root),
        "models": crate::svsep::models_status(s.writable()),
        "download": download_state(),
        "running": running,
        "port": s.port_hint(),
        "baseUrl": s.base_url(),
        "lastError": s.last_error(),
    })))
}

pub async fn start(State(st): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    let (port, started) = st
        .svsep
        .start()
        .await
        .map_err(ApiError::bad_request)?;
    let status = st.svsep.get("/api/status").await.unwrap_or(json!({}));
    Ok(Json(ok(json!({
        "running": true,
        "started": started,
        "port": port,
        "baseUrl": st.svsep.base_url(),
        "backend": status,
    }))))
}

pub async fn stop(State(st): State<Arc<AppState>>) -> Json<Value> {
    st.svsep.stop();
    Json(ok(json!({ "running": false })))
}

/// 下模型（730 MB）。链接在 `crate::svsep::MODEL_URL`，用户上传后填。
pub async fn models_download(State(st): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    let writable = st.svsep.writable().to_path_buf();
    spawn_download("models", async move {
        crate::svsep::download_models(&writable, crate::svsep::MODEL_URL, note_progress).await
    })
}

/// 下运行时（几 GB，只该下一次）。
///
/// ⚠️ 它解到 `<root>/app/data/svsep/`（**程序目录**，不是 `%APPDATA%`）——
/// 因为 `python.exe` 与 `backend/` 必须待在一起，而上游后端就是按
/// 「runtime 与 backend 同级」找东西的。安装版下 `Program Files` 不可写，
/// 那时这个下载会以「建目录失败」失败，错误文案照实说。
pub async fn runtime_download(State(st): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    let root = st.root.clone();
    spawn_download("runtime", async move {
        crate::svsep::download_runtime(&root, crate::svsep::RUNTIME_URL, note_progress).await
    })
}

/// 提交一次分离。
///
/// body 是**原始 multipart 字节**，原样转给 Python（见 `svsep::Svsep::submit`）。
/// 只从查询串里读 `engine` —— 前端把文件名写进 `Content-Disposition`，
/// 我们不解析它，解析了也只会引入转义 bug。
pub async fn separate(
    State(st): State<Arc<AppState>>,
    Query(q): Query<std::collections::HashMap<String, String>>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> Result<Json<Value>, ApiError> {
    let engine = q.get("engine").map(String::as_str).unwrap_or("roformer");
    let ct = headers
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    if !ct.starts_with("multipart/form-data") {
        return Err(ApiError::bad_request(
            "提交分离要带 multipart 表单（字段名 file）。",
        ));
    }
    if body.is_empty() {
        return Err(ApiError::bad_request("没有收到音频文件"));
    }

    if !st.svsep.probe().await {
        // 顺手把它起起来 —— 用户点「开始分离」时服务通常还没起
        st.svsep.start().await.map_err(ApiError::bad_request)?;
    }

    let out = st
        .svsep
        .submit(engine, body.to_vec(), &ct)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(ok(out)))
}

pub async fn task(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let v = st
        .svsep
        .get(&format!("/api/status/{id}"))
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(ok(v)))
}

pub async fn cancel(
    State(st): State<Arc<AppState>>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let v = st
        .svsep
        .post_json(&format!("/api/cancel/{id}"), &json!({}))
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(ok(v)))
}

pub async fn open_output(
    State(st): State<Arc<AppState>>,
    body: Option<Json<Value>>,
) -> Result<Json<Value>, ApiError> {
    let body = body.map(|Json(v)| v).unwrap_or_else(|| json!({}));
    let v = st
        .svsep
        .post_json("/api/open-output", &body)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(ok(v)))
}

/// 取输出文件 —— 流式转发，不把 WAV 整个读进内存。
pub async fn output(
    State(st): State<Arc<AppState>>,
    Path((id, index)): Path<(String, u32)>,
    Query(q): Query<std::collections::HashMap<String, String>>,
) -> Result<Response, ApiError> {
    let inline = q.get("inline").map(|v| v == "1").unwrap_or(false);
    let res = st
        .svsep
        .download(&id, index, inline)
        .await
        .map_err(ApiError::bad_request)?;

    let ctype = res
        .headers()
        .get(header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("application/octet-stream")
        .to_string();
    let disp = res
        .headers()
        .get(header::CONTENT_DISPOSITION)
        .and_then(|v| v.to_str().ok())
        .map(str::to_string);

    let mut out = Response::builder().status(StatusCode::OK);
    out = out.header(header::CONTENT_TYPE, ctype);
    out = out.header(header::ACCEPT_RANGES, "bytes");
    if let Some(d) = disp {
        out = out.header(header::CONTENT_DISPOSITION, d);
    }
    if let Some(len) = res.content_length() {
        out = out.header(header::CONTENT_LENGTH, len.to_string());
    }
    let body = Body::from_stream(res.bytes_stream());
    out.body(body)
        .map_err(|e| ApiError::internal(format!("构造响应失败：{e}")))
}

/// 分离服务的原始状态（`/api/status`）—— 页面上「设备 / 队列 / 输出目录」那一条用
pub async fn backend_status(State(st): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    let v = st
        .svsep
        .get("/api/status")
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(ok(v)))
}

pub async fn system_stats(State(st): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    let v = st
        .svsep
        .get("/api/system-stats")
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(ok(v)))
}

pub async fn inference_get(State(st): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    let v = st
        .svsep
        .get("/api/inference-settings")
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(ok(v)))
}

pub async fn inference_set(
    State(st): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let v = st
        .svsep
        .post_json("/api/inference-settings", &body)
        .await
        .map_err(ApiError::bad_request)?;
    Ok(Json(ok(v)))
}
