//! 阶段 4：视频解析 / 下载 / 音频处理
//!
//! 现在全是占位实现，返回明确的「未实现」而不是假装成功 ——
//! 这样前端会弹出错误提示，不会被静默吞掉。
//! 阶段 4 接上 B 站原生解析 + yt-dlp + ffmpeg。

use axum::Json;
use serde_json::Value;

use super::ApiError;

const NOT_YET: &str = "这个功能在阶段 4 实现（视频解析 / 下载 / 音频处理）";

pub async fn video_parse() -> Result<Json<Value>, ApiError> {
    Err(ApiError::bad_request(NOT_YET))
}

pub async fn video_download() -> Result<Json<Value>, ApiError> {
    Err(ApiError::bad_request(NOT_YET))
}

pub async fn audio_probe() -> Result<Json<Value>, ApiError> {
    Err(ApiError::bad_request(NOT_YET))
}

pub async fn audio_run() -> Result<Json<Value>, ApiError> {
    Err(ApiError::bad_request(NOT_YET))
}
