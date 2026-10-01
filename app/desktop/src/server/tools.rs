//! 阶段 3：工具与声库路由
//!
//! `detect` 已经能用（走 crate::tools 的真实探测）。
//! 只保留真正被用到的：外部工具探测（功能开关）与启动 UVR。

use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde_json::{json, Value};

use super::{ok, ApiError, AppState};

pub async fn detect(State(st): State<Arc<AppState>>) -> Json<Value> {
    Json(ok(crate::tools::detect_all(&st.root)))
}

/// 一键获取工具。
///
/// **不做了** —— ffmpeg 和 yt-dlp 改为随程序一起打包。
/// 理由：本程序主要在国内用，让用户自己去 GitHub 下 ffmpeg 基本下不动
/// （几百兆 + 直连不稳），打包进去反而省事。tools/ 一共约 390 MB，
/// 对现在的带宽和硬盘都不算什么。
///
/// 这里返回明确的说明而不是 404：如果界面还显示「未检测到」，说明 tools/
/// 被删了或解压不完整，用户需要知道怎么办，而不是看到一个没反应的按钮。
pub async fn install(Json(body): Json<Value>) -> Result<Json<Value>, ApiError> {
    let which = body.get("which").and_then(|v| v.as_str()).unwrap_or("工具");
    Err(ApiError::bad_request(format!(
        "{which} 已随程序打包，不需要联网下载。\
         如果这里显示未检测到，说明 tools 目录缺失或不完整 —— \
         从压缩包里把 tools 整个目录重新解压到程序根目录即可。"
    )))
}

pub async fn launch(
    State(st): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    // 只收 { path }：调用方都已经有确切路径（设置页选的文件、音频页记下的 UVR 路径）。
    //
    // 历史上还有一条 `{ id }` 的回落分支，去 config.customPrograms 里查路径 ——
    // 那个「自定义程序列表」前端从来没有管理入口，2026-10-05 连配置键一起删了。
    // 所以这里不再接受 { id }：给了也只会报「缺少程序路径」，这是对的。
    let target = body
        .get("path")
        .and_then(|v| v.as_str())
        .filter(|p| !p.is_empty())
        .map(String::from)
        .ok_or_else(|| ApiError::bad_request("缺少程序路径"))?;

    if !std::path::Path::new(&target).is_file() {
        return Err(ApiError::bad_request(format!("程序不存在或已被移动：{target}")));
    }

    let mut cmd = super::quiet_command(&target);
    if let Some(f) = body.get("file").and_then(|v| v.as_str()) {
        cmd.arg(f);
    }
    // 工作目录设成程序自己所在目录 —— 不少编辑器要靠相对路径找自己的资源
    let workdir = std::path::Path::new(&target)
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| st.root.clone());
    cmd.current_dir(workdir)
        .spawn()
        .map_err(|e| ApiError::internal(format!("启动失败：{e}")))?;

    Ok(Json(ok(json!({ "launched": target }))))
}
