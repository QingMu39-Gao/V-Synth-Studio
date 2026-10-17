//! 「感谢名单」的命令。
//!
//! ⚠️ 取不到是 `ok:true` 的成功回包（不是 `Err`）：三种来源按优先级兜底
//! （远端 → 缓存 → 内置），界面永远有东西显示。见 `crate::sponsors`。

use std::sync::Arc;

use tauri::State;

use super::{AppState, Cmd};

/// 取一次感谢名单。
///
/// `via` 说明这份名单从哪儿来（`remote` / `cache` / `builtin`），
/// 「关于」页据此提示「可能不是最新」。
#[tauri::command]
pub async fn sponsor_list(st: State<'_, Arc<AppState>>) -> Cmd {
    let writable = st.inner().writable.clone();
    Ok(crate::sponsors::fetch(&writable).await)
}
