//! B 站扫码登录的三条命令。
//!
//! ⚠️ **Cookie 绝不回传前端。** 登录态就是账号本身，而回包会进前端全局状态、
//! 也常被贴进截图或日志。所以：
//!   * `bili_qr_poll` 成功时只回 `{code, message, loggedIn}` ——
//!     `crate::bili::QrPoll::cookie` 在这里就被吃掉了；
//!   * 写盘进 `bilibiliCookie`（下载与预览那条路读的就是这个键）；
//!   * `get_config` / `get_state` 那边还有一层打码（`mask_secrets`）。
//!
//! 前端是 `components/ScanLogin.tsx`（`Dialog` + `qrcode.react`）。

use serde_json::{Value, json};

use super::Cmd;

/// 扫码第一步：申请二维码。回 `{url, qrcodeKey}`。
///
/// `url` 由前端画成二维码，`qrcodeKey` 是下一步轮询的令牌。
#[tauri::command]
pub async fn bili_qr_generate() -> Cmd {
    let (url, key) = crate::bili::qr_generate().await?;
    Ok(json!({ "url": url, "qrcodeKey": key }))
}

/// 扫码第二步：问一次「扫了没」。
///
/// ⚠️ **除成功之外的每一种状态都不是错误**（还没扫 86101 / 扫了待确认 86090 /
/// 已失效 86038）—— 前端要拿 `code` 和 `message` 去更新界面，所以回 `Ok` 而不是 `Err`。
/// 真出网络错（超时、DNS）才走 `Err`。
#[tauri::command]
pub async fn bili_qr_poll(st: super::St<'_>, qrcode_key: String) -> Cmd {
    if qrcode_key.trim().is_empty() {
        return Err("缺少 qrcodeKey".into());
    }
    let r = crate::bili::qr_poll(&qrcode_key).await?;

    /* 拿到 Cookie = 登录成功。写配置失败要**当成错误报出去**：不报的话界面会显示
    「登录成功」，而画质还是 480P —— 用户只会以为登录功能是坏的。 */
    let logged_in = match &r.cookie {
        Some(cookie) => {
            let mut cfg = st.config_snapshot();
            match cfg.as_object_mut() {
                Some(map) => {
                    map.insert("bilibiliCookie".into(), json!(cookie));
                }
                None => cfg = json!({ "bilibiliCookie": cookie }),
            }
            super::config_file::save_config(&st.writable, &cfg)
                .map_err(|e| format!("登录成功，但 Cookie 写不进配置文件：{e}"))?;
            if let Ok(mut guard) = st.config.lock() {
                *guard = cfg;
            }
            true
        }
        None => false,
    };

    Ok(json!({
        "code": r.code,
        "message": r.message,
        "loggedIn": logged_in,
    }))
}

/// 退出登录：把 `bilibiliCookie` 清空。
///
/// 只清本机配置里那一份 —— 不去调 B 站的退登接口（那会让**别的设备**上的登录态也失效，
/// 代价太大，而用户想要的只是「这台机器别再带着我的登录态」）。
#[tauri::command]
pub async fn bili_logout(st: super::St<'_>) -> Cmd {
    let mut cfg = st.config_snapshot();
    let had = cfg
        .get("bilibiliCookie")
        .and_then(|v: &Value| v.as_str())
        .is_some_and(|s| !s.is_empty());
    if let Some(map) = cfg.as_object_mut() {
        map.insert("bilibiliCookie".into(), json!(""));
    }
    super::config_file::save_config(&st.writable, &cfg)
        .map_err(|e| format!("清除 Cookie 失败：{e}"))?;
    if let Ok(mut guard) = st.config.lock() {
        *guard = cfg;
    }
    Ok(json!({ "loggedOut": had }))
}
