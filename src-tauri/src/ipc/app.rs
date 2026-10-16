//! 进程级动作。
//!
//! 现在只有一条：退出程序。它存在的唯一理由是**强制更新** —— 那个框不给「稍后」，
//! 用户得有一条能干脆走开的路（而不是去任务管理器里结束进程）。

use serde_json::json;

use super::Cmd;

/// 退出程序。
///
/// ⚠️ 用 `AppHandle::exit` 而不是 `std::process::exit`：前者走 Tauri 的退出流程
/// （`RunEvent` → `lib.rs` 里那串收子进程的钩子，比如分离引擎的 `python.exe`），
/// 直接杀进程会把子进程留在后台跑。
#[tauri::command]
pub async fn app_quit(app: tauri::AppHandle) -> Cmd {
    app.exit(0);
    Ok(json!({ "ok": true }))
}
