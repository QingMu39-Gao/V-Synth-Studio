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

pub async fn install() -> Result<Json<Value>, ApiError> {
    Err(ApiError::bad_request("一键获取在阶段 3 实现"))
}

pub async fn launch(
    State(st): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    // 这个已经能用了：按 id 找到编辑器路径然后启动
    let id = body.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let editors = crate::tools::detect_editors();
    let target = editors
        .iter()
        .find(|e| e.get("id").and_then(|v| v.as_str()) == Some(id) && e.get("installed").and_then(|v| v.as_bool()) == Some(true))
        .and_then(|e| e.get("path").and_then(|p| p.as_str()))
        .ok_or_else(|| ApiError::bad_request(format!("没有找到已安装的编辑器：{id}")))?;

    let path = body
        .get("file")
        .and_then(|v| v.as_str())
        .map(|f| vec![f.to_string()])
        .unwrap_or_default();

    let mut cmd = super::quiet_command(target);
    for a in &path {
        cmd.arg(a);
    }
    cmd.current_dir(&st.root)
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
