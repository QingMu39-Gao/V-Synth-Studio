// 清沐的虚拟歌姬工作站 —— Tauri 桌面外壳 + 内嵌 Rust 后端
//
// 架构：
//   一个进程搞定所有事 —— 窗口、HTTP 服务、转换编排、任务系统全在这里。
//   不再有 node.exe 子进程（原来那套是 sidecar 模式，Node 负责业务逻辑）。
//
// 两种运行方式：
//   qingmu-workstation.exe                        开窗口（正常使用）
//   qingmu-workstation.exe --serve --port=8787    只跑服务，不开窗口（开发/对照测试用）
//
// 后端实现和原 Node 版**完全相同的 31 个路由**，所以前端（app/web/）一行都没改。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod audio;
mod bili;
mod data;
mod libresvip;
mod net;
mod platform;
mod server;
mod tools;

mod ytdlp;

use std::path::{Path, PathBuf};
use std::sync::Arc;

use tauri::{WebviewUrl, WebviewWindowBuilder};

const WINDOW_TITLE: &str = "清沐的虚拟歌姬工作站";
const STARTUP_TIMEOUT_SECS: u64 = 30;

fn main() {
    let args: Vec<String> = std::env::args().collect();

    // ── 纯服务模式（开发与对照测试用）──────────────────────────
    if args.iter().any(|a| a == "--serve") {
        let port = args
            .iter()
            .find_map(|a| a.strip_prefix("--port="))
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(8787);

        let root = match find_app_root() {
            Some(r) => r,
            None => {
                eprintln!("找不到程序根目录（应该包含 app/web/index.html）");
                std::process::exit(1);
            }
        };

        let rt = tokio::runtime::Runtime::new().expect("创建 tokio 运行时失败");
        rt.block_on(async move {
            if let Err(e) = serve(root, port).await {
                eprintln!("服务启动失败：{e}");
                std::process::exit(1);
            }
        });
        return;
    }

    // ── 正常模式：Tauri 窗口 + 内嵌服务 ────────────────────────
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();

            let app_root = match find_app_root() {
                Some(p) => p,
                None => {
                    show_error(&handle, "找不到程序根目录。请把程序放在完整目录里再运行。");
                    return Ok(());
                }
            };

            let port = free_port();

            /*
             * 服务跑在进程内的 tokio 任务里，**不是子进程**。
             * 这是这次重写的核心目的：窗口和服务同生共死，不存在孤儿进程。
             */
            let root_for_server = app_root.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = serve(root_for_server, port).await {
                    eprintln!("内嵌服务异常退出：{e}");
                }
            });

            // 等端口真的能连上再开窗口
            if !wait_for_port(port, STARTUP_TIMEOUT_SECS) {
                show_error(&handle, "内嵌服务 30 秒内没有启动成功。请检查 data/desktop-error.log。");
                return Ok(());
            }

            let url: tauri::Url = format!("http://127.0.0.1:{port}")
                .parse()
                .expect("本地地址一定能解析");

            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title(WINDOW_TITLE)
                .inner_size(1360.0, 880.0)
                .min_inner_size(960.0, 640.0)
                .center()
                .build()?;

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Tauri 应用构建失败")
        .run(|_app, _event| {
            // 服务在进程内，进程退出它就没了 —— 不需要收拾子进程
        });
}

/// 起 HTTP 服务（阻塞到进程结束）
async fn serve(root: PathBuf, port: u16) -> Result<(), String> {
    let state = server::AppState::new(root.clone());
    let app = server::router(state.clone());

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|e| format!("端口 {port} 绑定失败：{e}"))?;

    println!();
    println!("  翻调工作站已启动（Rust 后端，单进程）");
    println!("  ─────────────────────────────────");
    println!("  地址：http://127.0.0.1:{port}");
    println!("  根目录：{}", root.display());
    println!("  停止服务：Ctrl+C");
    println!();

    axum::serve(listener, app)
        .await
        .map_err(|e| format!("服务运行出错：{e}"))
}

/* ────────────────────────────────── 路径与端口 ────────────────────────────────── */

/// 从可执行文件位置往上找程序根目录。
/// 认 `app/web/index.html` 作为标记 —— 前端的入口，无论后端是 Node 还是 Rust 都在。
fn find_app_root() -> Option<PathBuf> {
    let mut bases: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            bases.push(dir.to_path_buf());
        }
    }
    if let Ok(cwd) = std::env::current_dir() {
        bases.push(cwd);
    }

    for base in bases {
        let mut dir: Option<&Path> = Some(base.as_path());
        let mut depth = 0;
        while let Some(d) = dir {
            if d.join("app").join("web").join("index.html").is_file() {
                return Some(d.to_path_buf());
            }
            if depth >= 5 {
                break;
            }
            dir = d.parent();
            depth += 1;
        }
    }
    None
}

/// 让系统分一个空闲端口
fn free_port() -> u16 {
    std::net::TcpListener::bind(("127.0.0.1", 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(8787)
}

/// 轮询端口直到真的能连上（不靠死等固定秒数）
fn wait_for_port(port: u16, timeout_secs: u64) -> bool {
    let addr = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(timeout_secs);
    while std::time::Instant::now() < deadline {
        if std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_millis(300)).is_ok() {
            return true;
        }
        std::thread::sleep(std::time::Duration::from_millis(120));
    }
    false
}

/* ────────────────────────────────── 失败提示 ────────────────────────────────── */

fn show_error(app: &tauri::AppHandle, message: &str) {
    // 写日志
    let root = find_app_root().unwrap_or_else(|| PathBuf::from("."));
    let dir = root.join("data");
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("desktop-error.log"))
    {
        use std::io::Write;
        let _ = writeln!(f, "{message}");
    }
    eprintln!("{message}");

    // 开一个窗口把原因显示出来（走内嵌的起始页，原因通过 hash 传过去）
    if let Ok(w) = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title(WINDOW_TITLE)
        .inner_size(720.0, 420.0)
        .center()
        .build()
    {
        let encoded = urlencode(message);
        let _ = w.eval(&format!("location.hash='{encoded}';location.reload();"));
    }
}

fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/// 让 `Arc<AppState>` 在 Tauri 的 State 管理里可用（暂时没用到，保留给需要共享状态的命令）
#[allow(dead_code)]
fn share_state(root: PathBuf) -> Arc<server::AppState> {
    server::AppState::new(root)
}
