//! HTTP 服务端
//!
//! 实现和原 Node 后端**完全相同的路由**（现 39 条），响应形状以
//! `tests/contract/fixtures/` 里的真实抓包为准。
//!
//! 前端是 `app/web-next/` 的 Vite 产物（伺服自 `app/web/`），已不是 Node 后端
//! 时代的 `app/web/js`（那套已于 2026-10-02 删除）。
//!
//! 模块划分：
//!   mod.rs      路由表 + 共享状态
//!   simple.rs   health / config / fs / jobs / resources（阶段 1）
//!   convert.rs  转换链路（阶段 2）
//!   tools.rs    工具与声库探测（阶段 3）
//!   media.rs    视频解析 / 下载 / 音频（阶段 4）
//!   lyrics.rs   歌词：搜索 / 取词 / 存 LRC·SRT / 封面 / 歌曲直链下载 / 短信验证码登录
//!   svsep.rs    音轨分离：在线 MVSEP 的入口 + 离线分离服务的转发

pub mod convert;
pub mod lyrics;
pub mod media;
pub mod simple;
pub mod svsep;
pub mod tools;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use axum::extract::DefaultBodyLimit;
use axum::routing::{get, post};
use axum::Router;
use serde_json::{json, Value};

pub use simple::{load_config, quiet_command, ApiError};

/// 全局共享状态。极简 —— 只有真的需要跨请求共享的东西才放进来。
pub struct AppState {
    /// 只读资源根目录（含 app/web/、app/data/、tools/）
    pub root: PathBuf,
    /// 可写目录 —— 配置写这里。
    /// 绿色版就是 `app/data/`；安装版在 `%APPDATA%` 下，
    /// 因为 Program Files 是只读的（写它需要管理员权限）。
    pub writable: PathBuf,
    /// 是否安装版 —— 界面上给恢复提示时用得上
    pub installed: bool,
    /// 配置
    pub config: Mutex<Value>,
    /// 进程启动时间，/api/health 用
    pub started: Instant,
    /// 任务表
    pub jobs: Mutex<crate::server::simple::JobTable>,
    /// 离线音轨分离服务（Python 子进程）。见 `crate::svsep`。
    pub svsep: crate::svsep::Svsep,
}

impl AppState {
    pub fn new(paths: crate::AppPaths) -> Arc<Self> {
        // 可写目录可能还不存在（首次运行安装版），先建出来
        let _ = std::fs::create_dir_all(&paths.writable);
        let config = load_config(&paths.writable);
        let svsep = crate::svsep::Svsep::new(
            paths.root.clone(),
            paths.writable.clone(),
            paths.installed,
        );
        Arc::new(Self {
            root: paths.root,
            writable: paths.writable,
            installed: paths.installed,
            config: Mutex::new(config),
            started: Instant::now(),
            jobs: Mutex::new(Default::default()),
            svsep,
        })
    }

    pub fn config_snapshot(&self) -> Value {
        self.config.lock().map(|c| c.clone()).unwrap_or_else(|_| json!({}))
    }

    /// 只读数据目录（app/data）—— 资源库、拼音词典。配置在 writable，见上。
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
        // 把本地媒体文件原样吐给前端 —— 浏览器只能吃 URL，不能读本地路径。
        // 音频页的试听和波形都靠它，支持 Range（播放器拖进度条要用）
        .route("/api/fs/raw", get(simple::fs_raw))
        // 写任意二进制（文字 PV 导出 MP4 用）：JIZURA 的保存被父页面拦下来，
        // 字节分块 POST 到这里落盘。body 上限要放宽，默认 2MB 连一块都不够。
        .route(
            "/api/pv/save",
            post(simple::pv_save).layer(DefaultBodyLimit::max(simple::PV_CHUNK_LIMIT)),
        )
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
        // 上传版要单独放宽 body 上限：axum 默认 2MB，base64 过的工程很容易超（见 simple::CONVERT_UPLOAD_LIMIT）
        .route(
            "/api/convert/preview-upload",
            post(convert::preview_upload).layer(DefaultBodyLimit::max(simple::CONVERT_UPLOAD_LIMIT)),
        )
        .route("/api/convert/run", post(convert::run))
        .route(
            "/api/convert/run-upload",
            post(convert::run_upload).layer(DefaultBodyLimit::max(simple::CONVERT_UPLOAD_LIMIT)),
        )
        // ── 工具与声库（阶段 3）───────────────────────────
        .route("/api/tools/detect", get(tools::detect))
        .route("/api/tools/install", post(tools::install))
        .route("/api/tools/launch", post(tools::launch))
        // ── 视频与音频（阶段 4）───────────────────────────
        .route("/api/video/parse", post(media::video_parse))
        .route("/api/video/download", post(media::video_download))
        .route("/api/audio/probe", post(media::audio_probe))
        .route("/api/audio/run", post(media::audio_run))
        // ── 歌词（新增的歌词路由，与上面那批非歌词路由分开）──
        .route("/api/lyrics/search", post(lyrics::search))
        .route("/api/lyrics/get", post(lyrics::get))
        .route("/api/lyrics/parse-link", post(lyrics::parse_link))
        // 本地 .lrc 文件导入：形状和 /api/lyrics/get 一致，前端两条路共用一套渲染
        .route("/api/lyrics/import", post(lyrics::import))
        .route("/api/lyrics/save", post(lyrics::save))
        .route("/api/lyrics/cover", post(lyrics::cover))
        // 歌曲直链下载：拿网易云的播放直链存成 mp3（见 server/lyrics.rs::song）
        .route("/api/lyrics/song", post(lyrics::song))
        .route("/api/lyrics/login/sms", post(lyrics::login_sms))
        .route("/api/lyrics/login/cellphone", post(lyrics::login_cellphone))
        .route("/api/lyrics/logout", post(lyrics::logout))
        // ── 音轨分离（在线 MVSEP 只是前端一个链接；离线是内嵌引擎）──
        .route("/api/svsep/status", get(svsep::status))
        .route("/api/svsep/start", post(svsep::start))
        .route("/api/svsep/stop", post(svsep::stop))
        .route("/api/svsep/models/download", post(svsep::models_download))
        .route(
            "/api/svsep/runtime/download",
            post(svsep::runtime_download),
        )
        // 大包下载的暂停 / 停止，以及「把这些依赖全删了」。三个都不占请求：
        // 只是给下载循环立个旗标，真正的收场在后台任务里。
        .route("/api/svsep/download/pause", post(svsep::download_pause))
        .route("/api/svsep/download/stop", post(svsep::download_stop))
        .route("/api/svsep/deps/delete", post(svsep::deps_delete))
        // 提交分离：音频以 multipart 原样转发给分离后端。默认 body 上限 2MB
        // 连一首 3 分钟的 wav（约 32MB）都装不下，放宽到 600MB。
        .route(
            "/api/svsep/separate",
            post(svsep::separate).layer(DefaultBodyLimit::max(svsep::SEPARATE_LIMIT)),
        )
        .route("/api/svsep/task/{id}", get(svsep::task))
        .route("/api/svsep/task/{id}/cancel", post(svsep::cancel))
        .route("/api/svsep/task/{id}/out/{index}", get(svsep::output))
        .route("/api/svsep/open-output", post(svsep::open_output))
        // 分离后端自己的状态 / 设备 / 队列，原样透出去
        .route("/api/svsep/backend/status", get(svsep::backend_status))
        .route("/api/svsep/backend/system-stats", get(svsep::system_stats))
        .route(
            "/api/svsep/backend/inference",
            get(svsep::inference_get).post(svsep::inference_set),
        )
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
