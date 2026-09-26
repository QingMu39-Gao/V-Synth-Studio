//! 阶段 1：基础路由
//!
//! health / state / config / fs/* / jobs/* / resources / 静态文件
//!
//! 每个处理器的响应形状都以 `tests/contract/fixtures/*.json` 里的真实抓包为准。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Map, Value};

use super::{ok, AppState};

/* ══════════════════════════════════ 健康检查 ══════════════════════════════════ */

pub async fn health(State(st): State<Arc<AppState>>) -> Json<Value> {
    Json(ok(json!({
        "name": "翻调工作站",
        "version": env!("CARGO_PKG_VERSION"),
        // Node 版这里是 node 版本号，界面「关于」里会显示。
        // 换成 Rust 后端后没有 Node 了，改成运行时标识，字段名保持不变（前端读的是这个键）
        "node": format!("Rust {} (无 Node 后端)", rustc_version()),
        "pid": std::process::id(),
        "startedAt": now_millis() - st.started.elapsed().as_millis() as u64,
        "uptimeSec": st.started.elapsed().as_secs(),
    })))
}

fn rustc_version() -> &'static str {
    // 编译期注入的 rustc 版本拿不到（那要 build script），给个够用的常量
    "1.98+"
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/* ══════════════════════════════════ 配置 ══════════════════════════════════ */

/// 配置默认值，和 Node 版的 DEFAULT_CONFIG 逐字段对齐
pub fn default_config(root: &Path) -> Value {
    let downloads = crate::platform::downloads_dir();
    json!({
        "bilibiliCookie": "",
        "proxy": "",
        "outputDir": downloads.clone(),
        "downloadDir": downloads,
        "defaultTargetFormat": "vsqx",
        "nameTemplate": "{name}_converted",
        "threads": 4,
        "lastSourceFormat": "auto",
        "customPrograms": [],
        "voiceDirs": [],
        "quality": 0,
        "audioQuality": 0,
        // 只是为了让 root 参与签名，避免未使用参数告警
        "_root": root.to_string_lossy(),
    })
}

fn config_path(root: &Path) -> PathBuf {
    root.join("app").join("data").join("config.json")
}

/// 读配置。文件不存在就用默认值（和 Node 版行为一致）。
pub fn load_config(root: &Path) -> Value {
    let mut base = default_config(root);
    if let Ok(text) = fs::read_to_string(config_path(root)) {
        if let Ok(saved) = serde_json::from_str::<Value>(&text) {
            if let (Some(base_map), Some(saved_map)) = (base.as_object_mut(), saved.as_object()) {
                for (k, v) in saved_map {
                    base_map.insert(k.clone(), v.clone());
                }
            }
        }
    }
    // _root 是内部用的，不外泄
    if let Some(m) = base.as_object_mut() {
        m.remove("_root");
    }
    // 迁移：旧默认输出目录（程序目录下的 output/）改成系统下载目录
    migrate_legacy_dirs(&mut base, root);
    base
}

fn migrate_legacy_dirs(cfg: &mut Value, root: &Path) {
    let legacy: Vec<String> = ["output", "downloads"]
        .iter()
        .map(|d| root.join(d).to_string_lossy().to_lowercase())
        .collect();
    let downloads = crate::platform::downloads_dir();
    if let Some(m) = cfg.as_object_mut() {
        for key in ["outputDir", "downloadDir"] {
            let cur = m.get(key).and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
            if !cur.is_empty() && legacy.contains(&cur) {
                m.insert(key.into(), json!(downloads));
            }
        }
    }
}

pub fn save_config(root: &Path, cfg: &Value) -> std::io::Result<()> {
    let p = config_path(root);
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(p, serde_json::to_string_pretty(cfg).unwrap_or_default())
}

pub async fn config_get(State(st): State<Arc<AppState>>) -> Json<Value> {
    Json(ok(json!({ "config": st.config_snapshot() })))
}

pub async fn config_post(
    State(st): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let mut cfg = st.config_snapshot();
    if let (Some(dst), Some(src)) = (cfg.as_object_mut(), body.as_object()) {
        for (k, v) in src {
            // 脱敏字段：前端把打码后的值原样传回来时不要覆盖真实值
            if k == "bilibiliCookie" && v.as_str() == Some("已设置") {
                continue;
            }
            dst.insert(k.clone(), v.clone());
        }
    }
    save_config(&st.root, &cfg).map_err(ApiError::from)?;
    if let Ok(mut guard) = st.config.lock() {
        *guard = cfg.clone();
    }
    // 声库目录改了要立刻生效并清缓存，否则用户加完目录还得等 5 分钟
    if body.get("voiceDirs").is_some() {
        let dirs: Vec<String> = cfg
            .get("voiceDirs")
            .and_then(|v| v.as_array())
            .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
            .unwrap_or_default();
        crate::voices::set_user_dirs(&dirs);
    }
    Ok(Json(ok(json!({ "config": cfg }))))
}

/* ══════════════════════════════════ 状态聚合 ══════════════════════════════════ */

pub async fn state(State(st): State<Arc<AppState>>) -> Json<Value> {
    let cfg = st.config_snapshot();
    Json(ok(json!({
        "formats": crate::libresvip::list_formats(&st.root),
        "editors": crate::tools::detect_editors(),
        "tools": crate::tools::detect_tools(&st.root),
        "voices": crate::voices::snapshot(&cfg),
        "transformOps": crate::data::transform_ops(),
        "audioFormats": crate::data::audio_formats(),
        "pinyin": crate::data::pinyin_summary(&st.root),
        "config": cfg,
        "paths": {
            "root": st.root.to_string_lossy(),
            "outputDir": cfg.get("outputDir").cloned().unwrap_or(json!("")),
            "downloadDir": cfg.get("downloadDir").cloned().unwrap_or(json!("")),
            "toolsDir": st.tools_dir().to_string_lossy(),
        },
        "platform": crate::platform::node_platform_name(),
    })))
}

/* ══════════════════════════════════ 文件系统 ══════════════════════════════════ */

pub async fn fs_roots() -> Json<Value> {
    Json(ok(json!({ "roots": crate::platform::fs_roots() })))
}

#[derive(serde::Deserialize)]
pub struct PathQuery {
    pub path: Option<String>,
}

pub async fn fs_list(
    State(st): State<Arc<AppState>>,
    Query(q): Query<PathQuery>,
) -> Result<Json<Value>, ApiError> {
    let requested = q.path.unwrap_or_else(|| {
        st.config_snapshot()
            .get("outputDir")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    });
    if requested.is_empty() {
        return Err(ApiError::bad_request("缺少 path 参数"));
    }

    let target = PathBuf::from(&requested);
    if !target.exists() {
        // 目标不存在时返回它最近的已存在父目录
        let mut cur = target.clone();
        while !cur.exists() {
            match cur.parent() {
                Some(p) if p != cur => cur = p.to_path_buf(),
                _ => break,
            }
        }
        return Ok(Json(ok(json!({
            "path": crate::platform::clean_path(&cur),
            "requested": requested,
            "exists": false,
            "dirs": list_dirs(&cur),
            "parent": parent_str(&cur),
        }))));
    }

    if !target.is_dir() {
        return Err(ApiError::bad_request("目标不是目录"));
    }

    let resolved = fs::canonicalize(&target).unwrap_or(target.clone());
    Ok(Json(ok(json!({
        "path": crate::platform::clean_path(&resolved),
        "exists": true,
        "dirs": list_dirs(&target),
        "parent": parent_str(&resolved),
    }))))
}

/// 只列目录（不列文件），过滤掉系统目录，按名称排序 —— 和 Node 版一致
fn list_dirs(dir: &Path) -> Vec<Value> {
    let Ok(entries) = fs::read_dir(dir) else {
        return vec![];
    };
    let mut out: Vec<(String, String)> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('$') || name == "System Volume Information" {
                return None;
            }
            let full = e.path().to_string_lossy().to_string();
            Some((name, full))
        })
        .collect();

    /*
     * 排序：Node 版用的是 localeCompare(…, 'zh-CN')，按拼音排中文。
     * Rust 标准库没有 locale 感知的排序，这里退回「ASCII 不区分大小写 + 原序」。
     * 差异只在中文目录名的相互顺序上，功能不受影响。
     * ponytail: 要拼音排序就查 pinyin.json，为一个目录列表不值得。
     */
    out.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));

    out.into_iter()
        .map(|(name, path)| json!({ "name": name, "path": path }))
        .collect()
}

/// 父目录字符串。
/// 注意根目录的情况：Node 的 `dirname('C:\\')` 返回 `'C:\\'` 本身，
/// 而 Rust 的 `Path::parent()` 对根返回 None —— 这里要退回路径自身，否则前端
/// 拿到的 parent 是空串，目录选择器往上走一层就走不动了。
fn parent_str(p: &Path) -> String {
    match p.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => crate::platform::clean_path(parent),
        _ => crate::platform::clean_path(p),
    }
}

pub async fn fs_mkdir(Json(body): Json<Value>) -> Result<Json<Value>, ApiError> {
    let target = body.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if target.is_empty() {
        return Err(ApiError::bad_request("缺少路径"));
    }
    fs::create_dir_all(target).map_err(ApiError::from)?;
    let abs = fs::canonicalize(target).unwrap_or_else(|_| PathBuf::from(target));
    Ok(Json(ok(json!({ "path": crate::platform::clean_path(&abs) }))))
}

pub async fn fs_delete(Json(body): Json<Value>) -> Result<Json<Value>, ApiError> {
    let target = body.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if target.is_empty() {
        return Err(ApiError::bad_request("缺少路径"));
    }
    let p = PathBuf::from(target);
    if !p.exists() {
        return Err(ApiError::bad_request(format!("路径不存在：{target}")));
    }
    let trash = body.get("trash").and_then(|v| v.as_bool()).unwrap_or(false);
    if p.is_dir() {
        if trash {
            crate::platform::move_to_trash(&p).map_err(ApiError::from)?;
        } else {
            fs::remove_dir_all(&p).map_err(ApiError::from)?;
        }
    } else if trash {
        crate::platform::move_to_trash(&p).map_err(ApiError::from)?;
    } else {
        fs::remove_file(&p).map_err(ApiError::from)?;
    }
    Ok(Json(ok(json!({ "path": target }))))
}

pub async fn fs_open(Json(body): Json<Value>) -> Result<Json<Value>, ApiError> {
    let target = body.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if target.is_empty() || !Path::new(target).exists() {
        return Err(ApiError::bad_request(format!("路径不存在：{target}")));
    }
    crate::platform::open_path(target).map_err(ApiError::from)?;
    Ok(Json(ok(json!({ "path": target }))))
}

pub async fn fs_reveal(Json(body): Json<Value>) -> Result<Json<Value>, ApiError> {
    let target = body.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if target.is_empty() || !Path::new(target).exists() {
        return Err(ApiError::bad_request(format!("路径不存在：{target}")));
    }
    let select = body.get("select").and_then(|v| v.as_bool()).unwrap_or(true);
    crate::platform::reveal_in_explorer(target, select).map_err(ApiError::from)?;
    Ok(Json(ok(json!({ "path": target }))))
}

/* ══════════════════════════════════ 任务 ══════════════════════════════════ */

/// 任务表
///
/// `tx` 是给 SSE 用的广播通道：任何任务状态变化都往里发一份完整快照，
/// `/api/jobs/{id}/stream` 订阅它、按 id 过滤、推给前端。
///
/// 用**一个全局广播**而不是「每个任务一个通道」：任务数少、订阅者更少，
/// 按 id 过滤的代价可以忽略，换来的是不用维护通道的创建与销毁。
pub struct JobTable {
    pub items: BTreeMap<String, Value>,
    pub seq: u64,
    pub tx: tokio::sync::broadcast::Sender<Value>,
}

impl Default for JobTable {
    fn default() -> Self {
        // 容量 256：进度更新很密（每次 set 都发一条），订阅者偶尔卡顿也不该丢消息。
        // 真丢了也只是少刷一次，因为推的是完整快照而不是增量。
        let (tx, _) = tokio::sync::broadcast::channel(256);
        Self { items: BTreeMap::new(), seq: 0, tx }
    }
}

impl JobTable {
    /// 广播一份任务快照
    pub fn publish(&self, job: &Value) {
        let _ = self.tx.send(job.clone());
    }
}

pub async fn jobs_list(State(st): State<Arc<AppState>>) -> Json<Value> {
    let guard = st.jobs.lock().unwrap();
    let list: Vec<Value> = guard
        .items
        .values()
        .map(|j| {
            json!({
                "id": j.get("id"),
                "type": j.get("type"),
                "title": j.get("title"),
                "status": j.get("status"),
                "percent": j.get("percent"),
                "message": j.get("message"),
                "createdAt": j.get("createdAt"),
            })
        })
        .collect();
    Json(ok(json!({ "jobs": list })))
}

pub async fn jobs_get(
    State(st): State<Arc<AppState>>,
    Query(q): Query<JobQuery>,
) -> Result<Json<Value>, ApiError> {
    let id = q.id.as_deref().unwrap_or("");
    let guard = st.jobs.lock().unwrap();
    let job = guard
        .items
        .get(id)
        .cloned()
        .ok_or_else(|| ApiError::bad_request("任务不存在"))?;
    Ok(Json(ok(json!({ "job": job }))))
}

#[derive(serde::Deserialize)]
pub struct JobQuery {
    #[serde(default)]
    pub id: Option<String>,
}

pub async fn jobs_cancel(
    State(st): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    /*
     * 真正把任务标成 canceled：长任务（下载 / 音频处理）在循环里读这个状态，
     * 读到就中断并掐掉子进程。没有额外的取消通道 —— 任务表本身就是通道。
     */
    let id = body.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let mut guard = st.jobs.lock().unwrap();
    let job = guard
        .items
        .get_mut(id)
        .ok_or_else(|| ApiError::internal("任务不存在"))?;
    let status = job.get("status").and_then(|v| v.as_str()).unwrap_or("");
    if !matches!(status, "done" | "error" | "canceled") {
        if let Some(m) = job.as_object_mut() {
            m.insert("status".into(), json!("canceled"));
            m.insert("message".into(), json!("已取消"));
        }
    }
    Ok(Json(ok(json!({ "job": job.clone() }))))
}

/// 任务进度推送（SSE）。
///
/// 前端用 `new EventSource('/api/jobs/{id}/stream')` 订阅 —— **注意 id 在路径里**，
/// 不是查询参数。早先这里注册成 `/api/jobs/stream` 导致前端 404、进度条不动。
///
/// 协议和 Node 版一致：
///   - 连上先推一份当前快照（前端不必再单独请求一次）
///   - 之后每次状态变化推一份完整快照（不是增量，丢一条也不会错位）
///   - 状态变成 done/error/canceled 后推完最后一条就结束
///   - 15 秒一次心跳注释行，防止中间层掐掉空闲连接
pub async fn jobs_stream(
    State(st): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<
    axum::response::Sse<
        impl futures_util::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>,
    >,
    ApiError,
> {
    use axum::response::sse::{Event, KeepAlive};
    use std::convert::Infallible;

    let (initial, rx) = {
        let guard = st.jobs.lock().unwrap();
        let job = guard
            .items
            .get(&id)
            .cloned()
            .ok_or_else(|| ApiError::not_found("任务不存在"))?;
        // 先订阅再放开锁 —— 顺序反过来的话，两次之间的更新会丢
        (job, guard.tx.subscribe())
    };

    let stream = futures_util::stream::unfold(
        (rx, Some(initial), false),
        move |(mut rx, pending, done)| {
            let id = id.clone();
            async move {
                if done {
                    return None;
                }
                // 第一条：订阅前的当前快照
                if let Some(v) = pending {
                    let terminal = is_terminal(&v);
                    let ev = Event::default().data(v.to_string());
                    return Some((Ok::<_, Infallible>(ev), (rx, None, terminal)));
                }
                // 之后：等其他任务的消息，按 id 过滤
                loop {
                    match rx.recv().await {
                        Ok(v) => {
                            if v.get("id").and_then(|x| x.as_str()) != Some(id.as_str()) {
                                continue;
                            }
                            let terminal = is_terminal(&v);
                            let ev = Event::default().data(v.to_string());
                            return Some((Ok::<_, Infallible>(ev), (rx, None, terminal)));
                        }
                        // 订阅者跟不上被丢了消息：不是错误，继续等下一批
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(_) => return None,
                    }
                }
            }
        },
    );

    Ok(axum::response::Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(15))))
}

/// 任务是否已到终态（到了就该结束 SSE 连接）
fn is_terminal(job: &Value) -> bool {
    matches!(
        job.get("status").and_then(|s| s.as_str()),
        Some("done") | Some("error") | Some("canceled")
    )
}

/* ══════════════════════════════════ 资源库 ══════════════════════════════════ */

pub async fn resources(State(st): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    let path = st.data_dir().join("resources.json");
    let text = fs::read_to_string(&path).map_err(ApiError::from)?;
    let data: Value = serde_json::from_str(&text)
        .map_err(|e| ApiError::bad_request(format!("resources.json 解析失败：{e}")))?;
    Ok(Json(ok(json!({
        "version": data.get("version").cloned().unwrap_or(json!(1)),
        "updatedAt": data.get("updatedAt").cloned().unwrap_or(json!("")),
        "notice": data.get("notice").cloned().unwrap_or(json!("")),
        "groups": data.get("groups").cloned().unwrap_or(json!([])),
        "verifySummary": data.get("verifySummary").cloned().unwrap_or(json!({})),
    }))))
}

pub async fn resources_check() -> Json<Value> {
    // 阶段 3 接上真实链接检查（需要 HTTP 客户端）
    Json(ok(json!({ "results": [], "pending": true })))
}

/* ══════════════════════════════════ 静态文件 ══════════════════════════════════ */

/// 前端静态文件。/api/* 之外的所有请求都走这里。
pub async fn static_files(State(st): State<Arc<AppState>>, req: axum::extract::Request) -> Response {
    let rel = req.uri().path().trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };
    let web = st.web_dir();
    let target = web.join(rel);

    // 目录穿越防护：规范化后必须仍在 web 目录内
    let ok_path = match fs::canonicalize(&target) {
        Ok(p) => p.starts_with(fs::canonicalize(&web).unwrap_or(web.clone())),
        Err(_) => false,
    };
    if !ok_path {
        return (StatusCode::NOT_FOUND, "Not Found").into_response();
    }

    let Ok(bytes) = fs::read(&target) else {
        return (StatusCode::NOT_FOUND, "Not Found").into_response();
    };
    let mime = mime_of(&target);
    (
        StatusCode::OK,
        [(header::CONTENT_TYPE, mime)],
        Body::from(bytes),
    )
        .into_response()
}

fn mime_of(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        _ => "application/octet-stream",
    }
}

/* ══════════════════════════════════ 错误处理 ══════════════════════════════════ */

/// 统一错误响应：形状和 Node 版一致（`{ok:false, error:"..."}`），
/// 前端 api.js 读的就是 error 字段
pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self { status: StatusCode::BAD_REQUEST, message: msg.into() }
    }
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self { status: StatusCode::NOT_FOUND, message: msg.into() }
    }
    pub fn internal(msg: impl Into<String>) -> Self {
        Self { status: StatusCode::INTERNAL_SERVER_ERROR, message: msg.into() }
    }
}

impl From<std::io::Error> for ApiError {
    fn from(e: std::io::Error) -> Self {
        Self::internal(e.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut m = Map::new();
        m.insert("ok".into(), Value::Bool(false));
        m.insert("error".into(), Value::String(self.message));
        // Node 版的 sendError 一定会带 code（没有就是 null），前端 api.js 也会读它
        m.insert("code".into(), Value::Null);
        (self.status, Json(Value::Object(m))).into_response()
    }
}

/* ══════════════════════════════════ 小工具 ══════════════════════════════════ */

/// Windows 上起一个不弹窗的子进程
pub fn quiet_command(program: &str) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}
