//! 阶段 3：工具与声库路由
//!
//! `detect` 已经能用（走 crate::tools 的真实探测）。
//! install / launch / voices/* 留待阶段 3 接上。

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
    let id = body.get("id").and_then(|v| v.as_str()).unwrap_or("");
    if id.is_empty() {
        return Err(ApiError::bad_request("缺少 id"));
    }

    // 找目标路径。顺序：内置编辑器表 → 设置页里用户自己添加的程序。
    // 自定义程序也要能启动，否则设置页里加进去的东西就是个死入口。
    let editors = crate::tools::detect_editors();
    let mut target = editors
        .iter()
        .find(|e| {
            e.get("id").and_then(|v| v.as_str()) == Some(id)
                && e.get("installed").and_then(|v| v.as_bool()) == Some(true)
        })
        .and_then(|e| e.get("path").and_then(|p| p.as_str()))
        .map(String::from);

    if target.is_none() {
        // 自定义程序：配置里存的是 [{ id, name, path }]
        let cfg = st.config_snapshot();
        target = cfg
            .get("customPrograms")
            .and_then(|v| v.as_array())
            .and_then(|arr| {
                arr.iter()
                    .find(|p| p.get("id").and_then(|v| v.as_str()) == Some(id))
                    .and_then(|p| p.get("path").and_then(|v| v.as_str()))
                    .map(String::from)
            });
    }

    let target = target.ok_or_else(|| ApiError::bad_request(format!("没有找到可启动的程序：{id}")))?;

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

pub async fn voices(State(st): State<Arc<AppState>>) -> Json<Value> {
    Json(ok(crate::voices::snapshot(&st.config_snapshot())))
}

pub async fn voices_match(Json(body): Json<Value>) -> Json<Value> {
    let singer = body.get("singer").and_then(|v| v.as_str()).unwrap_or("");
    Json(ok(crate::voices::match_singer(singer)))
}

pub async fn voices_probe(Json(body): Json<Value>) -> Result<Json<Value>, ApiError> {
    let dir = body.get("dir").and_then(|v| v.as_str()).unwrap_or("");
    if dir.is_empty() {
        return Err(ApiError::bad_request("缺少 dir 参数"));
    }
    if !std::path::Path::new(dir).is_dir() {
        return Err(ApiError::bad_request(format!("不是目录：{dir}")));
    }
    Ok(Json(ok(crate::voices::probe_dir(dir))))
}
