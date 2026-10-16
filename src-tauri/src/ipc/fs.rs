//! 文件系统相关的命令：选文件 / 目录 / 另存走 **`tauri-plugin-dialog`**；拖入由
//! **拖放事件直接给路径**（`DragDropEvent::Drop`，前端不调 `upload_dropped`）；
//! 读大文件给 `<video>` / `<audio>` 走 **asset 协议**（`convertFileSrc`，Range 内置）。
//!
//! ⚠️ **asset 协议要运行时放行目录**：它默认只服务 `tauri.conf.json` 里 scope 声明的
//! 目录，而我们的 scope 是**空的**（用户挑的目录在编译期不可能知道）。所以凡是
//! 「用户选了什么」的地方都要放行一次 `asset_protocol_scope().allow_directory()` /
//! `allow_file()`（永久白名单，进程内有效），见 `allow_picked()`。漏放行的症状是
//! `<video>` / `<audio>` 静默不播、控制台一条 `403`，而界面其余部分完全正常 ——
//! 很容易误判成「播放器坏了」。

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::json;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use super::Cmd;

/// 选文件 / 选目录 / 选保存位置。
///
/// 四条入口合一：`mode` 决定用哪个对话框（`open` 单选 / `open-multi` 多选 /
/// `folder` 选目录 / `save` 另存）。回的是 `{ paths: [...] }` —— **永远是数组**，
/// 单选就是长度 1，取消就是空数组（**取消不是错误**，所以回 `Ok` 而不是 `Err`）。
///
/// `exts` 不带点（`["mp3","wav"]`），空数组 = 不过滤。
///
/// 选中的东西会**同时放行给 asset 协议**（选目录是递归放行），这样前端拿到路径就能
/// 直接 `convertFileSrc` 播放 / 预览，不用再问后端要一次权限。
#[tauri::command]
pub async fn pick_paths(
    app: tauri::AppHandle,
    mode: Option<String>,
    title: Option<String>,
    dir: Option<String>,
    exts: Option<Vec<String>>,
    label: Option<String>,
) -> Cmd {
    let mode = mode.unwrap_or_else(|| "open".into());
    let mut dlg = app.dialog().file();
    if let Some(t) = title.filter(|s| !s.is_empty()) {
        dlg = dlg.set_title(t);
    }
    if let Some(d) = dir.filter(|s| !s.trim().is_empty()) {
        dlg = dlg.set_directory(d);
    }
    let exts = exts.unwrap_or_default();
    if !exts.is_empty() && mode != "folder" {
        let refs: Vec<&str> = exts.iter().map(String::as_str).collect();
        dlg = dlg.add_filter(label.unwrap_or_else(|| "允许的格式".into()), &refs);
    }

    // 回调式 API → oneshot，桥成 async。
    // ⚠️ 插件内部已经 `run_on_main_thread` + 另起线程 `block_on`
    // （`tauri-plugin-dialog-2.8.1/src/desktop.rs:142-151`），所以这里**不会死锁**，
    // 也不需要我们操心消息泵 —— 这正是引官方插件而不是自己调 Win32 的理由。
    let (tx, rx) = tokio::sync::oneshot::channel::<Vec<PathBuf>>();
    match mode.as_str() {
        "folder" => dlg.pick_folder(move |p| {
            let _ = tx.send(p.and_then(|f| f.into_path().ok()).into_iter().collect());
        }),
        "open-multi" => dlg.pick_files(move |list| {
            let _ = tx.send(
                list.unwrap_or_default()
                    .into_iter()
                    .filter_map(|f| f.into_path().ok())
                    .collect(),
            );
        }),
        "save" => dlg.save_file(move |p| {
            let _ = tx.send(p.and_then(|f| f.into_path().ok()).into_iter().collect());
        }),
        _ => dlg.pick_file(move |p| {
            let _ = tx.send(p.and_then(|f| f.into_path().ok()).into_iter().collect());
        }),
    }

    let picked = rx.await.unwrap_or_default();
    allow_picked(&app, &picked, mode == "folder");
    Ok(json!({
        "paths": picked
            .iter()
            .map(|p| crate::platform::clean_path(p))
            .collect::<Vec<_>>(),
    }))
}

/// 放行给 asset 协议。选目录时递归放行。
///
/// 失败**不报错**：放行不成功只影响「这个文件能不能播」，而用户此刻要的是「拿到路径」
/// —— 报错反而把正常流程打断了。真播不出来时前端那条 403 会露出来。
fn allow_picked(app: &tauri::AppHandle, paths: &[PathBuf], recursive: bool) {
    let scope = app.asset_protocol_scope();
    for p in paths {
        let r = if recursive || p.is_dir() {
            scope.allow_directory(p, true)
        } else {
            scope.allow_file(p)
        };
        if let Err(e) = r {
            crate::log_line(&format!("asset 协议放行失败（{}）：{e}", p.display()));
        }
    }
}

/// 另存为时**只**放行目标文件所在目录 —— 给文字 PV 导出用。
///
/// 前端在 `save` 模式下拿到的是「用户想去的位置」，可能还没有那个文件；
/// 这里放行的是它的父目录，这样导出完立刻能在页面里预览。
#[tauri::command]
pub async fn allow_path(app: tauri::AppHandle, path: String) -> Cmd {
    let p = PathBuf::from(&path);
    let target = if p.is_dir() {
        /* 直接传入的目录原样放行 —— 是用户在对话框里自己挑的，含盘根 */
        p.clone()
    } else {
        /* 文件只放行其所在的那一层：`parent()` 对 `/x.txt` 回 `/`、对空串回
        `Some("")`，派生放行等于整盘（或空 scope）递归放行，直接拒绝。 */
        match p
            .parent()
            .filter(|d| !d.as_os_str().is_empty() && d.parent().is_some())
        {
            Some(d) => d.to_path_buf(),
            None => return Err(format!("只能放行具体文件或其所在目录：{path}")),
        }
    };
    let _ = app.asset_protocol_scope().allow_directory(&target, true);
    Ok(json!({ "allowed": crate::platform::clean_path(&target) }))
}

/// 打开一个本地路径。`reveal = true` 时在文件管理器里**选中**它（而不是打开）。
///
/// ⚠️ 这里**只收本地路径**。传网址请用 `open_url` —— 把两种参数混在一个入口里
/// （`path` 优先、`url` 兜底）就会出现「传了 url 却被当成不存在的路径」这种必然报错。
/// IPC 下入口本来就便宜，拆开比在一个函数里猜更不容易用错。
#[tauri::command]
pub async fn open_path(path: String, reveal: Option<bool>) -> Cmd {
    if path.trim().is_empty() {
        return Err("缺少 path".into());
    }
    if !std::path::Path::new(&path).exists() {
        return Err(format!("路径不存在：{path}"));
    }
    if reveal.unwrap_or(false) {
        // 定位：在资源管理器里选中它
        crate::platform::reveal_in_explorer(&path, true).map_err(|e| e.to_string())?;
    } else {
        crate::platform::open_path(&path).map_err(|e| e.to_string())?;
    }
    Ok(json!({ "path": path }))
}

/// 在**系统默认浏览器**里打开一个网址。
///
/// 与 `open_path` 分开是**有意**的：这条不做存在性检查（网址不是文件），
/// 而混在一条命令里就得靠「看着像不像 URL」去猜。**别合成一条**：
/// 前端每次都知道自己手里是路径还是网址，让它自己选命令。
///
/// 为什么前端不直接 `<a href>`：点真链接会把整个 WebView 换成上游网站，
/// 而窗口里没有后退键，用户就回不来了。
#[tauri::command]
pub async fn open_url(url: String) -> Cmd {
    if url.trim().is_empty() {
        return Err("缺少 url".into());
    }
    crate::platform::open_url(&url).map_err(|e| e.to_string())?;
    Ok(json!({ "ok": true, "url": url }))
}

/// 把拖进来的文件落到临时目录，回一个**本机路径**。
///
/// ⚠️ **正常路径下前端不该调它**：`DragDropEvent::Drop` 的载荷里**直接就有真路径**
/// （`tauri/src/webview.rs:745`），那是把工程拖进窗口最省事的一条路。
/// 这条命令留着是给「只有 `File` 对象、没有路径」的场合兜底
/// （比如页面内 `<input type=file>` 或 HTML5 的 DataTransfer）。
///
/// 落盘位置按进程号分开、**不主动清理**：这些文件接下来还要被 ffmpeg 读到，
/// 什么时候能删只有用户知道（关掉程序后系统会回收临时目录）。
#[tauri::command]
pub async fn upload_dropped(name: String, bytes: Vec<u8>) -> Cmd {
    const LIMIT: u64 = 2 * 1024 * 1024 * 1024;
    if bytes.is_empty() {
        return Err("收到的文件是空的（文件夹拖不进来，请拖文件）".into());
    }
    if bytes.len() as u64 > LIMIT {
        return Err(format!(
            "单个文件不能超过 {} GiB",
            LIMIT / (1024 * 1024 * 1024)
        ));
    }
    let safe = sanitize_name(&name);
    let dir = std::env::temp_dir().join(format!("qingmu-drops-{}", std::process::id()));
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("建临时目录失败：{e}"))?;
    // 毫秒时间戳打头：同一批拖进来的重名文件（还有上一次留下的）不会互相盖掉
    let path = dir.join(format!("{}-{safe}", now_millis()));
    tokio::fs::write(&path, &bytes)
        .await
        .map_err(|e| format!("落盘失败：{e}"))?;
    Ok(json!({
        "path": crate::platform::clean_path(&path),
        "name": safe,
        "bytes": bytes.len(),
    }))
}

/// 读一个本地文件的字节（给「大文件走 IPC 而不是 asset 协议」的场合兜底）。
///
/// 回 `{ bytes: number[] }`。⚠️ **几十 MB 的文件别走这条** —— 数组过 JSON 会膨胀好几倍，
/// 该用 asset 协议（`convertFileSrc` + `<audio>`/`<video>`/`fetch` 都行，Range 是内置的）。
/// 这条适合几 MB 以内、或者需要在 JS 里直接拿到字节的场合。
#[tauri::command]
pub async fn read_bytes(path: String) -> Cmd {
    let p = PathBuf::from(&path);
    if !p.is_file() {
        return Err(format!("文件不存在：{path}"));
    }
    let bytes = tokio::fs::read(&p)
        .await
        .map_err(|e| format!("读文件失败：{e}"))?;
    Ok(json!({ "bytes": bytes, "size": bytes.len() }))
}

/// 新建目录。
#[tauri::command]
pub async fn mkdir(path: String) -> Cmd {
    if path.trim().is_empty() {
        return Err("缺少 path".into());
    }
    tokio::fs::create_dir_all(&path)
        .await
        .map_err(|e| format!("新建目录失败：{e}"))?;
    Ok(json!({ "path": crate::platform::clean_path(std::path::Path::new(&path)) }))
}

/// 删文件或目录（目录递归）。
///
/// `trash = true` 时走系统回收站，否则**永久删除**。默认进回收站 ——
/// 这个动作的入口在界面上是「清掉这个结果」，而用户手滑时只有回收站能救回来。
#[tauri::command]
pub async fn remove_path(path: String, trash: Option<bool>) -> Cmd {
    if path.trim().is_empty() {
        return Err("缺少 path".into());
    }
    let p = PathBuf::from(&path);
    if !p.exists() {
        return Err(format!("路径不存在：{path}"));
    }
    if trash.unwrap_or(true) {
        crate::platform::move_to_trash(&p).map_err(|e| e.to_string())?;
    } else if p.is_dir() {
        tokio::fs::remove_dir_all(&p)
            .await
            .map_err(|e| format!("删除失败：{e}"))?;
    } else {
        tokio::fs::remove_file(&p)
            .await
            .map_err(|e| format!("删除失败：{e}"))?;
    }
    Ok(json!({ "path": path }))
}

/* ────────────────────────────────── 小工具 ────────────────────────────────── */

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 把浏览器给的文件名洗成能安全落盘的单个文件名。
fn sanitize_name(raw: &str) -> String {
    let base = raw.rsplit(['\\', '/']).next().unwrap_or("").trim();
    let safe: String = base
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let safe = safe.trim().to_string();
    if safe.is_empty() || safe == "." || safe == ".." {
        "dropped".to_string()
    } else {
        safe
    }
}

/// 让 `Arc<AppState>` 这种「注进来的状态」也能被上面几条命令用到时的统一别名。
#[allow(dead_code)]
type _StateAlias<'a> = tauri::State<'a, Arc<super::AppState>>;
