//! HTTP 服务端
//!
//! 实现和原 Node 后端**完全相同的 31 个路由**，所以前端（app/web/，7048 行）一行都不用改。
//! 响应形状以 `tests/contract/fixtures/` 里的真实抓包为准。
//!
//! 模块划分：
//!   mod.rs      路由表 + 共享状态
//!   simple.rs   health / config / fs / jobs / resources（阶段 1）
//!   convert.rs  转换链路（阶段 2）
//!   tools.rs    工具与声库探测（阶段 3）
//!   media.rs    视频解析 / 下载 / 音频（阶段 4）

pub mod convert;
pub mod media;
pub mod simple;
pub mod tools;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Value};

pub use simple::{load_config, quiet_command, ApiError};

/// 全局共享状态。极简 —— 只有真的需要跨请求共享的东西才放进来。
pub struct AppState {
    /// 程序根目录（含 app/web/index.html 的那一层）
    pub root: PathBuf,
    /// 配置（读写 app/data/config.json）
    pub config: Mutex<Value>,
    /// 进程启动时间，/api/health 用
    pub started: Instant,
    /// 任务表（阶段 2 用）
    pub jobs: Mutex<crate::server::simple::JobTable>,
}

impl AppState {
    pub fn new(root: PathBuf) -> Arc<Self> {
        let config = load_config(&root);
        Arc::new(Self {
            root,
            config: Mutex::new(config),
            started: Instant::now(),
            jobs: Mutex::new(Default::default()),
        })
    }

    pub fn config_snapshot(&self) -> Value {
        self.config.lock().map(|c| c.clone()).unwrap_or_else(|_| json!({}))
    }

    /// 数据目录（app/data）—— 配置、资源库、拼音词典都放这里
    pub fn data_dir(&self) -> PathBuf {
        self.root.join("app").join("data")
    }

    /// 外部工具目录（tools/）
    pub fn tools_dir(&self) -> PathBuf {
        self.root.join("tools")
    }

    /// 前端静态文件目录
    pub fn web_dir(&self) -> PathBuf {
        self.root.join("app").join("web")
    }
}

/// 构造路由表。
///
/// 顺序刻意保持和 Node 版一致，便于逐个对照。
pub fn router(state: Arc<AppState>) -> Router {
    Router::new()
        // ── 基础 ──────────────────────────────────────────
        .route("/api/health", get(simple::health))
        .route("/api/state", get(simple::state))
        .route("/api/config", get(simple::config_get).post(simple::config_post))
        // ── 文件系统 ──────────────────────────────────────
        .route("/api/fs/roots", get(simple::fs_roots))
        .route("/api/fs/list", get(simple::fs_list))
        .route("/api/fs/mkdir", post(simple::fs_mkdir))
        .route("/api/fs/delete", post(simple::fs_delete))
        .route("/api/fs/open", post(simple::fs_open))
        .route("/api/fs/reveal", post(simple::fs_reveal))
        // ── 任务 ──────────────────────────────────────────
        .route("/api/jobs", get(simple::jobs_list))
        .route("/api/jobs/get", get(simple::jobs_get))
        .route("/api/jobs/cancel", post(simple::jobs_cancel))
        // 注意 id 在**路径**里，不是查询参数 —— 前端用 EventSource 订阅这个地址
        .route("/api/jobs/{id}/stream", get(simple::jobs_stream))
        // ── 资源库 ────────────────────────────────────────
        .route("/api/resources", get(simple::resources))
        .route("/api/resources/check", post(simple::resources_check))
        // ── 转换（阶段 2）─────────────────────────────────
        .route("/api/convert/collect", post(convert::collect))
        .route("/api/convert/inspect", post(convert::inspect))
        .route("/api/convert/preview", post(convert::preview))
        .route("/api/convert/preview-upload", post(convert::preview_upload))
        .route("/api/convert/run", post(convert::run))
        .route("/api/convert/run-upload", post(convert::run_upload))
        // ── 工具与声库（阶段 3）───────────────────────────
        .route("/api/tools/detect", get(tools::detect))
        .route("/api/tools/install", post(tools::install))
        .route("/api/tools/launch", post(tools::launch))
        // ── 视频与音频（阶段 4）───────────────────────────
        .route("/api/video/parse", post(media::video_parse))
        .route("/api/video/download", post(media::video_download))
        .route("/api/audio/probe", post(media::audio_probe))
        .route("/api/audio/run", post(media::audio_run))
        // ── 前端静态文件 ──────────────────────────────────
        .fallback(simple::static_files)
        .with_state(state)
}

/// 统一的成功响应：`ok` 一律放最前面，和 Node 版的输出顺序一致（便于逐字段对照）
pub fn ok(body: Value) -> Value {
    let mut out = serde_json::Map::new();
    out.insert("ok".into(), Value::Bool(true));
    if let Value::Object(m) = body {
        for (k, v) in m {
            if k != "ok" {
                out.insert(k, v);
            }
        }
    }
    Value::Object(out)
}
