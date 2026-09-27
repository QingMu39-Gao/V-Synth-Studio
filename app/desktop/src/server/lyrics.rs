//! 歌词路由
//!
//! 搜索 / 取歌词 / 解析链接 / 存文件 / 下封面 / 短信验证码登录与退出。
//! 平台相关的实现全在 `crate::lyrics`，这里只做参数校验、配置读取与错误映射。
//!
//! 响应形状是新增的（原来的 31 个路由一个都没动），前端 `api.js` 直接按这里的形状写。

use std::path::PathBuf;
use std::sync::Arc;

use axum::extract::State;
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

/* ══════════════════════════════ POST /api/lyrics/import ══════════════════════════════ */

/// 从本地 `.lrc` 文件导入歌词（用户手上已有的歌词，不用去搜）。
///
/// 返回的形状和 `/api/lyrics/get` **一样**（另有 `encoding` 字段如实说明读到的是
/// UTF-8 还是 GBK），所以前端「搜到的歌」和「导入的文件」共用同一套预览 / 保存 /
/// 带去文字 PV 的逻辑，不用分叉。
pub async fn import(Json(body): Json<Value>) -> Result<Json<Value>, ApiError> {
    let raw = body
        .get("path")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if raw.is_empty() {
        return Err(ApiError::bad_request("请先选一个 .lrc 文件"));
    }

    let path = PathBuf::from(&raw);
    if !path.is_file() {
        return Err(ApiError::bad_request(format!("找不到这个文件：{raw}")));
    }

    // 文件读不了 / 编码读不对 / 里面没有时间轴：都是用户能自己处理的事，按 400 回去
    let data = crate::lyrics::import_file(&path).map_err(ApiError::bad_request)?;
    Ok(Json(ok(data)))
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

/// 退出登录：把该来源的 Cookie 清空。
///
/// 和 `save_netease_cookie` 对称 —— 同样走 `save_config` + 内存快照，
/// 区别只是写进去的是空串。清空后 `cookie_of` 读到的就是空，搜索/取歌词
/// 自动退回未登录状态，不需要别的地方配合。
///
/// 顺带把 QQ 也支持了：两个来源的登录态都是「config 里一个 Cookie 字段」，
/// 没有别的状态要清（不像浏览器还要清 session、缓存之类）。
pub async fn logout(
    State(st): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let source = body.get("source").and_then(|v| v.as_str()).unwrap_or("netease");
    let key = if source == "qq" { "qqCookie" } else { "neteaseCookie" };

    let mut next = st.config_snapshot();
    if let Some(map) = next.as_object_mut() {
        map.insert(key.into(), json!(""));
    }
    crate::server::simple::save_config(&st.writable, &next).map_err(ApiError::from)?;
    if let Ok(mut guard) = st.config.lock() {
        *guard = next;
    }

    Ok(Json(ok(json!({ "loggedOut": true, "source": source }))))
}

/// 把登录拿到的 Cookie 写进配置并落盘。
///
/// 走的就是 `save_config` + 内存快照，和设置页保存 Cookie 是同一条路 ——
/// 所以「短信登录完之后能不能取到歌词」这件事只取决于 `crate::lyrics::cookie_of`
/// 读的 `neteaseCookie`，这里写的正是它。
fn save_netease_cookie(st: &Arc<AppState>, cookie: &str) -> Result<(), ApiError> {
    let mut next = st.config_snapshot();
    if let Some(map) = next.as_object_mut() {
        map.insert("neteaseCookie".into(), json!(cookie));
    }
    crate::server::simple::save_config(&st.writable, &next).map_err(ApiError::from)?;
    if let Ok(mut guard) = st.config.lock() {
        *guard = next;
    }
    Ok(())
}

/* ══════════════════════ 网易云登录：手机号 + 短信验证码 ══════════════════════ */

/// 请求体里的手机号：去空格、去 `+86` / `86` 前缀、去常见分隔符。
///
/// 归一化是为了**只做一次格式校验**：`phone_ok` 是发短信前的闸门，
/// 让「138 0000 0000」「+8613800000000」这类写法也能顺利过闸，而不是被误判成格式错误。
fn phone_of(body: &Value) -> Result<String, ApiError> {
    let raw = body
        .get("phone")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let mut digits: String = raw
        .chars()
        .filter(|c| !matches!(c, ' ' | '-' | '+' | '(' | ')'))
        .collect();
    if let Some(rest) = digits.strip_prefix("86") {
        if rest.len() >= 11 {
            digits = rest.to_string();
        }
    }
    if !crate::lyrics::phone_ok(&digits) {
        return Err(ApiError::bad_request(
            "手机号格式错误：需要 11 位数字且以 1 开头（不用填 +86）",
        ));
    }
    Ok(digits)
}

/// 发短信验证码。`{ phone }` → `{ sent: true, exists }`
///
/// 先查一次性「号码存不存在」（只在明确回答「没有」时才拦），省一条真短信。
pub async fn login_sms(
    State(st): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let phone = phone_of(&body)?;
    let cfg = st.config_snapshot();

    // 查不出来（None）不拦：那只是风控/网络的问题，直接发码让发码接口自己说话
    match crate::lyrics::phone_exists(&cfg, &phone).await {
        Ok(Some(false)) => {
            return Err(ApiError::bad_request(
                "这个手机号在网易云没有注册过，短信没发出去。请检查号码，或改用 Cookie 登录",
            ))
        }
        _ => {}
    }

    let res = crate::lyrics::sms_send(&cfg, &phone).await.map_err(ApiError::internal)?;

    // 网易云的成功形状是 `{"code":200,"data":true}`；码不是 200 就把它自己的话透出来
    let code = res.get("code").and_then(|v| v.as_i64()).unwrap_or(0);
    if code != 200 {
        return Err(ApiError::bad_request(sms_error(&res, code)));
    }

    Ok(Json(ok(json!({ "sent": true, "phone": phone }))))
}

/// 发码失败的说明：优先用网易云自己的话，认不出的码也把原始响应截一段带上。
fn sms_error(res: &Value, code: i64) -> String {
    let their = res
        .get("message")
        .or_else(|| res.get("msg"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if !their.is_empty() {
        return format!("发送验证码失败：{their}（code {code}）");
    }
    let raw: String = res.to_string().chars().take(200).collect();
    format!("发送验证码失败（网易云返回 code {code}，没有说明）：{raw}")
}

/// 手机号 + 验证码登录。`{ phone, captcha }` → `{ loggedIn: true }`
///
/// 成功时把 Cookie 写进 `config.neteaseCookie` —— 搜索、取歌词、下封面都读这个字段
/// （见 `crate::lyrics::cookie_of`），所以保存完立刻就能用。
pub async fn login_cellphone(
    State(st): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let phone = phone_of(&body)?;
    let captcha = body
        .get("captcha")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if captcha.is_empty() {
        return Err(ApiError::bad_request("请先填短信验证码"));
    }

    let cfg = st.config_snapshot();
    let cookie = crate::lyrics::cellphone_login(&cfg, &phone, &captcha)
        .await
        // 验证码错误 / 号码没注册 / 接口改了：都要原样让用户看到，别压成一句「登录失败」
        .map_err(ApiError::bad_request)?;
    if !cookie.contains("MUSIC_U") {
        return Err(ApiError::internal(format!(
            "登录接口没有返回 MUSIC_U，拿到的 Cookie 用不了（{} 字符）",
            cookie.chars().count()
        )));
    }

    save_netease_cookie(&st, &cookie)?;

    // 顺手拿昵称，登录成功的提示就能写成「已登录为 xxx」；拿不到也不影响登录本身
    let nickname = crate::lyrics::account_nickname(&st.config_snapshot())
        .await
        .unwrap_or_default();

    Ok(Json(ok(json!({ "loggedIn": true, "phone": phone, "nickname": nickname }))))
}
