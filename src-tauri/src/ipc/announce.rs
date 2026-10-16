//! 「公告」的命令。
//!
//! ⚠️ 取不到是 `ok:false` 的**成功回包**（不是 `Err`）：公告服务器在重启、用户断网
//! 都是常态，而两种情况下界面要做的事一样 —— 什么都不做（启动不弹）、设置里那一栏
//! 照实说。见 `crate::announce`。

use super::Cmd;

/// 取一次公告（自建源，见 `crate::announce::ANNOUNCE_URLS`）。
#[tauri::command]
pub async fn announce_list() -> Cmd {
    Ok(crate::announce::fetch().await)
}
