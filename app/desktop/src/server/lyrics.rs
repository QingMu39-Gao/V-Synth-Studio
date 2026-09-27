//! 歌词路由
//!
//! 搜索 / 取歌词 / 解析链接 / 存文件 / 下封面 / 扫码登录。
//! 平台相关的实现全在 `crate::lyrics`，这里只做参数校验、配置读取与错误映射。
//!
//! 响应形状是新增的（原来的 31 个路由一个都没动），前端 `api.js` 直接按这里的形状写。

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::{Query, State};
use axum::Json;
use serde_json::{json, Value};

use super::{ok, ApiError, AppState};

/// 从请求体里取 id：网易云是数字，QQ 是 songmid 字符串，两种都收
fn id_of(body: &Value) -> Result<String, ApiError> {
    match body.get("id") {
        Some(Value::String(s)) if !s.trim().is_empty() => Ok(s.trim().to_string()),
        Some(Value::Number(n)) => Ok(n.to_string()),
        _ => Err(ApiError::bad_request("缺少歌曲 id")),
    }
}

fn source_of(body: &Value) -> Result<&'static str, ApiError> {
    let raw = body.get("source").and_then(|v| v.as_str()).unwrap_or("");
    crate::lyrics::normalize_source(raw).map_err(ApiError::bad_request)
}

/// 输出目录：请求里给了就用请求的，否则退回配置里的默认输出目录。
/// 前端默认填的是 `state.paths.outputDir`（系统下载目录），这里只是兜底。
fn out_dir_of(st: &Arc<AppState>, body: &Value) -> String {
    body.get("outDir")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or_else(|| {
            st.config_snapshot()
                .get("outputDir")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        })
}

/// 文件名：去掉用户可能已经带上的扩展名，再统一用 `bili::safe_title` 清掉非法字符
fn file_name(body: &Value, ext: &str, fallback: &str) -> String {
    let raw = body
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let stem = raw
        .trim_end_matches(".lrc")
        .trim_end_matches(".LRC")
        .trim_end_matches(".srt")
        .trim_end_matches(".SRT")
        .trim();
    let base = crate::bili::safe_title(if stem.is_empty() { fallback } else { stem });
    format!("{base}.{ext}")
}

/* ══════════════════════════════ POST /api/lyrics/search ══════════════════════════════ */

pub async fn search(
    State(st): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let source = source_of(&body)?;
    let keyword = body
        .get("keyword")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if keyword.is_empty() {
        return Err(ApiError::bad_request("请输入歌名或歌手"));
    }

    let cfg = st.config_snapshot();
    let songs = crate::lyrics::search(&cfg, source, &keyword)
        .await
        .map_err(ApiError::internal)?;

    Ok(Json(ok(json!({ "source": source, "keyword": keyword, "songs": songs }))))
}

/* ══════════════════════════════ POST /api/lyrics/get ══════════════════════════════ */

pub async fn get(
    State(st): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let source = source_of(&body)?;
    let id = id_of(&body)?;
    let cfg = st.config_snapshot();

    let data = crate::lyrics::fetch(&cfg, source, &id)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(ok(data)))
}

/* ══════════════════════════ POST /api/lyrics/parse-link ══════════════════════════ */

pub async fn parse_link(Json(body): Json<Value>) -> Result<Json<Value>, ApiError> {
    let url = body.get("url").and_then(|v| v.as_str()).unwrap_or("");
    let (source, id) = crate::lyrics::parse_link(url).map_err(ApiError::bad_request)?;
    Ok(Json(ok(json!({ "source": source, "id": id }))))
}

/* ══════════════════════════════ POST /api/lyrics/save ══════════════════════════════ */

pub async fn save(
    State(st): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    // 字段名统一叫 lyric；`lrc` 是早期约定，一并收下，免得调用方踩空
    let lyric = body
        .get("lyric")
        .or_else(|| body.get("lrc"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if lyric.trim().is_empty() {
        return Err(ApiError::bad_request("还没有歌词可保存"));
    }

    let format = body
        .get("format")
        .and_then(|v| v.as_str())
        .unwrap_or("lrc")
        .to_lowercase();
    let trans = body.get("trans").and_then(|v| v.as_str()).unwrap_or("");
    let bilingual = body
        .get("bilingual")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    // 结束时间要用到歌曲时长：前端把拉歌词时拿到的时长传回来，拿不到就是 0（+4 秒兜底）
    let duration = body
        .get("durationSec")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    // 来源只影响 QQ 的歌词头处理，认不出来就按网易云处理（更宽松）
    let source = crate::lyrics::normalize_source(
        body.get("source").and_then(|v| v.as_str()).unwrap_or(""),
    )
    .unwrap_or("netease");

    let (text, ext) = crate::lyrics::render(&format, lyric, trans, source, duration, bilingual)
        .map_err(ApiError::bad_request)?;

    let dir = out_dir_of(&st, &body);
    if dir.is_empty() {
        return Err(ApiError::bad_request(
            "没有输出目录。请选择目录，或先去「设置」页填一个默认输出目录",
        ));
    }
    let name = file_name(&body, ext, "lyrics");
    let path = PathBuf::from(&dir).join(&name);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(ApiError::from)?;
    }
    // 一律 UTF-8（无 BOM）：见 crate::lyrics::render 的说明
    std::fs::write(&path, text.as_bytes()).map_err(ApiError::from)?;

    Ok(Json(ok(json!({
        "path": path.to_string_lossy(),
        "name": name,
        "format": ext,
        "size": text.len(),
    }))))
}

/* ══════════════════════════════ POST /api/lyrics/cover ══════════════════════════════ */

pub async fn cover(
    State(st): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let url = body.get("url").and_then(|v| v.as_str()).unwrap_or("");
    if !url.starts_with("http") {
        return Err(ApiError::bad_request("封面地址无效（这首歌可能没有封面）"));
    }

    // 扩展名从地址里猜，猜不到按 jpg 存（两个来源的封面都是 jpg）
    let ext = ["jpg", "jpeg", "png", "webp"]
        .iter()
        .find(|e| {
            url.split('?')
                .next()
                .unwrap_or("")
                .to_lowercase()
                .ends_with(&format!(".{e}"))
        })
        .copied()
        .unwrap_or("jpg");

    let dir = out_dir_of(&st, &body);
    if dir.is_empty() {
        return Err(ApiError::bad_request("没有输出目录，请先选择目录"));
    }
    let name = file_name(&body, ext, "cover");
    let path = PathBuf::from(&dir).join(&name);

    let cfg = st.config_snapshot();
    let size = crate::lyrics::download_cover(&cfg, url, &path)
        .await
        .map_err(ApiError::internal)?;

    Ok(Json(ok(json!({
        "path": path.to_string_lossy(),
        "name": name,
        "size": size,
    }))))
}

/* ══════════════════════ 网易云扫码登录 ══════════════════════ */

pub async fn login_qr(State(st): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    let cfg = st.config_snapshot();
    let out = crate::lyrics::qr_create(&cfg)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(ok(out)))
}

#[derive(serde::Deserialize)]
pub struct PollQuery {
    pub key: Option<String>,
}

pub async fn login_poll(
    State(st): State<Arc<AppState>>,
    Query(q): Query<PollQuery>,
) -> Result<Json<Value>, ApiError> {
    let key = q
        .key
        .map(|k| k.trim().to_string())
        .filter(|k| !k.is_empty())
        .ok_or_else(|| ApiError::bad_request("缺少二维码 key"))?;

    let cfg = st.config_snapshot();
    let (status, cookie) = crate::lyrics::qr_poll(&cfg, &key)
        .await
        .map_err(ApiError::internal)?;

    let code = status.get("code").and_then(|v| v.as_i64()).unwrap_or(0);
    let message = status
        .get("message")
        .and_then(|v| v.as_str())
        .unwrap_or("状态未知")
        .to_string();

    // 803 = 登录成功，响应里带的是登录后的 Cookie 串，直接落进配置
    let mut logged_in = false;
    if code == 803 && !cookie.is_empty() {
        let mut next = st.config_snapshot();
        if let Some(map) = next.as_object_mut() {
            map.insert("neteaseCookie".into(), json!(cookie));
        }
        crate::server::simple::save_config(&st.writable, &next).map_err(ApiError::from)?;
        if let Ok(mut guard) = st.config.lock() {
            *guard = next;
        }
        logged_in = true;
    }

    Ok(Json(ok(json!({
        "code": code,
        "message": if code == 803 && !logged_in { "登录成功，但没拿到 Cookie" } else { message.as_str() },
        "loggedIn": logged_in,
    }))))
}
