//! 壁纸（背景层）的命令。
//!
//! 只读用户自己的 Steam 库（见 `crate::wallpaper`）：扫描结果给设置页挑，场景包的
//! 字节单独走一条命令交给前端去喂 webwallgl。
//!
//! ⚠️ **场景包不走 JSON**：`Response` 回的是原始字节，`read_bytes` 那种
//! `{bytes: [1,2,3…]}` 在几十 MB 上会把 IPC 撑爆（数组过 JSON 膨胀好几倍）。

use std::path::PathBuf;

use serde_json::Value;

use super::Cmd;

/// 一张场景包最多多大。超过就明说 —— 硬读进内存只会让整个窗口卡死。
const MAX_PKG_BYTES: u64 = 192 * 1024 * 1024;

/// 扫一遍壁纸库：装了没、有哪些、现在用的是哪一张。
#[tauri::command]
pub async fn wallpaper_scan(st: super::St<'_>) -> Cmd {
    let configured = st
        .inner()
        .config_snapshot()
        .get("weDir")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    Ok(crate::wallpaper::scan(&configured))
}

/// 读一个场景包的字节（前端拿去喂 webwallgl 的 `bytesSource`）。
#[tauri::command]
pub async fn wallpaper_pkg(path: String) -> Result<tauri::ipc::Response, String> {
    let p = PathBuf::from(path.trim());
    if !p.is_file() {
        return Err(format!("场景包不存在：{}", p.display()));
    }
    let size = std::fs::metadata(&p)
        .map_err(|e| format!("读不了文件属性：{e}"))?
        .len();
    if size > MAX_PKG_BYTES {
        return Err(format!(
            "场景包 {:.0} MB，超过上限 {:.0} MB",
            size as f64 / 1048576.0,
            MAX_PKG_BYTES as f64 / 1048576.0
        ));
    }
    // 异步读：192 MB 从慢盘（移动硬盘 / 网络盘）同步读会把 Tokio 运行时整个按住几秒，
    // 期间所有 IPC 命令一起卡住
    let bytes = tokio::fs::read(&p).await.map_err(|e| format!("读场景包失败：{e}"))?;
    Ok(tauri::ipc::Response::new(bytes))
}
