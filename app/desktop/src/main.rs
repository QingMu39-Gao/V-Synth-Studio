// 清沐的虚拟歌姬工作站 —— Tauri 桌面外壳
//
// 干的事和原来那份 C# + WebView2 的外壳一样，但换成跨平台方案：
//   Windows 用 WebView2，macOS 用 WKWebView，Linux 用 WebKitGTK，一份代码通吃。
//
// 流程：
//   1. 从自身位置往上找 app/server/index.mjs，确定程序根目录
//   2. 挑一个空闲端口
//   3. 把 Node 服务作为子进程拉起来（node app/server/index.mjs --port=N）
//   4. 轮询端口直到真的能连上（不靠死等固定秒数）
//   5. 用系统 WebView 打开 http://127.0.0.1:N
//   6. 窗口关掉时，把服务子进程连同它的子孙一起收拾干净
//
// 业务逻辑一行都没搬到 Rust 里 —— Node 服务照旧，Rust 只负责开窗口和管子进程。

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs;
use std::io::Write;
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const WINDOW_TITLE: &str = "清沐的虚拟歌姬工作站";
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);

/// 服务子进程，退出时要用它收摊
struct ServerProcess(Mutex<Option<Child>>);

fn main() {
    tauri::Builder::default()
        .setup(|app| {
            let handle = app.handle().clone();

            let app_root = match find_app_root() {
                Some(p) => p,
                None => {
                    show_error(
                        &handle,
                        "找不到 app/server/index.mjs。请把程序放在完整目录里再运行。",
                    );
                    return Ok(());
                }
            };

            let node = match find_node(&app_root) {
                Some(n) => n,
                None => {
                    show_error(
                        &handle,
                        "没有找到 Node.js。这个程序的界面需要 Node 才能跑起来后端服务，\
                         请安装 Node.js 20 以上版本后重试（nodejs.org）。",
                    );
                    return Ok(());
                }
            };

            let port = free_port();

            match start_server(&node, &app_root, port) {
                Ok(child) => {
                    app.manage(ServerProcess(Mutex::new(Some(child))));
                }
                Err(e) => {
                    show_error(&handle, &format!("启动本地服务失败：{e}"));
                    return Ok(());
                }
            }

            if !wait_for_port(port, STARTUP_TIMEOUT) {
                let log = read_tail(&app_root.join("data").join("server.log"), 1200);
                kill_server(&handle);
                show_error(
                    &handle,
                    &format!(
                        "本地服务 30 秒内没有启动成功。\n\n服务日志尾部：\n{}",
                        if log.is_empty() { "（日志为空）".into() } else { log }
                    ),
                );
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
        .run(|app_handle, event| {
            // 窗口全关了 / 应用要退出 —— 把服务子进程收掉
            if let tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit = event {
                kill_server(app_handle);
            }
        });
}

/* ────────────────────────────── 启动失败时的提示窗口 ────────────────────────────── */

/// 不弹系统对话框（那要额外加插件），直接开一个窗口显示内置的错误页，
/// 原因通过 URL hash 传进去，页面自己渲染。
fn show_error(app: &tauri::AppHandle, message: &str) {
    write_error_log(app, message);

    let encoded = urlencode(message);
    let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title(WINDOW_TITLE)
        .inner_size(720.0, 420.0)
        .center();

    match builder.build() {
        Ok(window) => {
            let _ = window.eval(&format!(
                "location.hash = '{}'; location.reload();",
                encoded
            ));
        }
        Err(e) => eprintln!("连提示窗口都没能创建：{e}"),
    }
}

fn write_error_log(app: &tauri::AppHandle, message: &str) {
    let root = find_app_root().unwrap_or_else(|| PathBuf::from("."));
    let dir = root.join("data");
    let _ = fs::create_dir_all(&dir);
    if let Ok(mut f) = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("desktop-error.log"))
    {
        let _ = writeln!(f, "[{}] {}", timestamp(), message);
    }
    eprintln!("{message}");
    let _ = app;
}

fn timestamp() -> String {
    // 不引入 chrono 这类依赖，用系统时间凑一个够用的时间戳
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default();
    let secs = now.as_secs();
    let days = secs / 86400;
    let rem = secs % 86400;
    format!(
        "第 {} 天 {:02}:{:02}:{:02} (UTC)",
        days,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// 极简的 URL 编码，只处理会破坏 hash 的字符
fn urlencode(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 2);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

/* ────────────────────────────────── 路径与进程 ────────────────────────────────── */

/// 从可执行文件所在目录往上找带 app/server/index.mjs 的目录
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
            if d.join("app").join("server").join("index.mjs").is_file() {
                return Some(d.to_path_buf());
            }
            if depth >= 4 {
                break;
            }
            dir = d.parent();
            depth += 1;
        }
    }
    None
}

/// 找 node：先看 PATH，再看常见安装位置，最后看程序自带的 tools/node
fn find_node(app_root: &Path) -> Option<String> {
    let exe_name = if cfg!(windows) { "node.exe" } else { "node" };

    if Command::new(exe_name)
        .arg("--version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false)
    {
        return Some(exe_name.to_string());
    }

    let mut guesses: Vec<PathBuf> = vec![app_root.join("tools").join("node").join(exe_name)];

    #[cfg(windows)]
    {
        for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
            if let Ok(base) = std::env::var(var) {
                guesses.push(PathBuf::from(base).join("nodejs").join(exe_name));
            }
        }
    }
    #[cfg(not(windows))]
    {
        guesses.push(PathBuf::from("/usr/local/bin/node"));
        guesses.push(PathBuf::from("/opt/homebrew/bin/node"));
        guesses.push(PathBuf::from("/usr/bin/node"));
    }

    guesses
        .into_iter()
        .find(|p| p.is_file())
        .map(|p| p.to_string_lossy().into_owned())
}

/// 让系统分一个空闲端口：绑 0 号端口拿到号码再放掉
fn free_port() -> u16 {
    TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, 0))
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(8787)
}

fn start_server(node: &str, app_root: &Path, port: u16) -> std::io::Result<Child> {
    // 服务的输出转存到 data/server.log，起不来时能从日志看出原因
    let log_dir = app_root.join("data");
    let _ = fs::create_dir_all(&log_dir);
    let log = fs::File::create(log_dir.join("server.log")).ok();
    let err_log = log.as_ref().and_then(|f| f.try_clone().ok());

    let mut cmd = Command::new(node);
    cmd.arg("app/server/index.mjs")
        .arg(format!("--port={port}"))
        .current_dir(app_root)
        .stdin(Stdio::null());

    match (log, err_log) {
        (Some(out), Some(err)) => {
            cmd.stdout(Stdio::from(out)).stderr(Stdio::from(err));
        }
        _ => {
            cmd.stdout(Stdio::null()).stderr(Stdio::null());
        }
    }

    cmd.spawn()
}

/// 等服务真的能连上，而不是干等一个固定秒数
fn wait_for_port(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    let addr = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    while Instant::now() < deadline {
        if TcpStream::connect_timeout(&addr.into(), Duration::from_millis(400)).is_ok() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

/// 收摊。node 可能又拉起了 ffmpeg 之类的孙子进程，所以要整棵树一起收。
fn kill_server(app: &tauri::AppHandle) {
    let Some(state) = app.try_state::<ServerProcess>() else {
        return;
    };
    let Ok(mut guard) = state.0.lock() else { return };
    let Some(mut child) = guard.take() else { return };

    #[cfg(windows)]
    {
        // Windows 上没有进程组的概念，用 taskkill 连子孙一起收
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    #[cfg(not(windows))]
    {
        // Unix 下 node 是独立进程组的组长，对负号 PID 发信号可以带走整组
        unsafe {
            libc::kill(-(child.id() as i32), libc::SIGTERM);
        }
    }

    let _ = child.wait();
}

/// 读日志尾部若干字节，用于把失败原因显示到界面上
fn read_tail(path: &Path, max_bytes: usize) -> String {
    let Ok(data) = fs::read(path) else {
        return String::new();
    };
    let start = data.len().saturating_sub(max_bytes);
    String::from_utf8_lossy(&data[start..]).trim().to_string()
}
