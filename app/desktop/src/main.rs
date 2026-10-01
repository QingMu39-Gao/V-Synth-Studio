// V-Synth-Studio  ·  QingMu39
// Tauri 桌面外壳 + 内嵌 HTTP 后端
//
// 架构：
//   一个进程搞定所有事 —— 窗口、HTTP 服务、转换编排、任务系统全在这里。
//   没有 node.exe 子进程，也没有任何 sidecar 子进程。
//
// 两种运行方式：
//   v-synth-studio.exe                        开窗口（正常使用）
//   v-synth-studio.exe --serve --port=17878    只跑服务，不开窗口（开发/对照测试用）
//
// ── 关于「为什么没有控制台窗口」──
// 这里**始终**用 windows 子系统，debug 版也不例外。
// 早先是 `cfg_attr(not(debug_assertions), ...)`，只有 release 版无窗口，
// 结果开发时天天挂着一个黑框。
//
// 代价是看不到 stdout —— 所以日志改成写文件（见 log_line）。
// 这反而更好用：日志能翻历史、能搜索，也不会因为关掉窗口就丢了。
// `--serve` 模式如果想把输出打到终端，重定向即可（Start-Process -RedirectStandardOutput）。

#![windows_subsystem = "windows"]

mod audio;
mod bili;
mod data;
mod libresvip;
mod lyrics;
mod net;
mod platform;
mod server;

/// 追加一行日志到 `<可写目录>/app.log`。
///
/// 为什么不用 stdout：程序是 windows 子系统（无控制台窗口），
/// 打出去的东西没人看得见。写文件反而更好用 —— 能翻历史、能搜索，
/// 也不会因为关掉窗口就丢了。
///
/// 刻意不引日志库：这里只有十来行输出，一个 `OpenOptions::append` 就够。
fn log_line(msg: &str) {
    use std::io::Write;

    // 启动早期路径还没解析出来，退回临时目录，保证日志不丢
    let dir = resolve_paths(None)
        .map(|p| p.writable)
        .unwrap_or_else(std::env::temp_dir);
    let _ = std::fs::create_dir_all(&dir);

    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // 简单的时间戳：不引时间库，用「自纪元起的秒」也够定位
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("app.log"))
    {
        let _ = writeln!(f, "[{ts}] {msg}");
    }
}

/// 把日志同时写到文件和 stdout（stdout 在无控制台时会被丢弃，无害）。
///
/// 用宏而不是函数：`println!` 的格式化参数直接转发，不用先拼字符串。
macro_rules! note {
    ($($arg:tt)*) => {{
        let s = format!($($arg)*);
        crate::log_line(&s);
        #[cfg(debug_assertions)]
        println!("{s}");
    }};
}

mod tools;

mod ytdlp;

use std::path::{Path, PathBuf};

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const WINDOW_TITLE: &str = "V-Synth-Studio";
const STARTUP_TIMEOUT_SECS: u64 = 30;

fn main() {
    let args: Vec<String> = std::env::args().collect();

    // ── 选界面：旧前端（默认）还是新 React 前端 ──────────────────
    //
    //   v-synth-studio.exe                 → 旧前端（app/web/index.html）
    //   v-synth-studio.exe --ui=next       → 新前端（app/web/next/，React + Vite）
    //
    // 前端是**每请求从磁盘读**的，所以切换界面不需要重新编译 —— 只要改这个 URL 前缀。
    // 这也是并行迁移能落地的前提：两套界面同时在，谁都没被破坏。
    //
    // 默认仍是旧前端：新前端还在逐页搬迁中（见 AGENTS.md 第十一节），
    // 等 8 页搬完、验收通过，把 default 改成 "next" 即可，一处改动完成切换。
    let ui_path = match args.iter().find_map(|a| a.strip_prefix("--ui=")) {
        Some("next") => "next",
        Some("old") => "",
        Some(other) => {
            note!("警告：--ui={other} 不认识（只认 next / old），按旧前端启动");
            ""
        }
        None => "",
    };
    let base_path = if ui_path.is_empty() {
        String::new()
    } else {
        format!("/{ui_path}")
    };
    // 把选中的界面记进日志 —— 用户说「还是旧的」时，先看这行确认参数有没有生效，
    // 不然只能靠猜（切界面不重新编译，所以这一步很容易被忽略）。
    note!("界面：{}（URL 前缀 '{}'）", if ui_path.is_empty() { "旧前端" } else { "新前端 next" }, if base_path.is_empty() { "/" } else { &base_path });

    // ── 纯服务模式（开发与对照测试用）──────────────────────────
    if args.iter().any(|a| a == "--serve") {
        let port = args
            .iter()
            .find_map(|a| a.strip_prefix("--port="))
            .and_then(|p| p.parse::<u16>().ok())
            .unwrap_or(8787);

        let paths = match resolve_paths(None) {
            Some(p) => p,
            None => {
                note!("错误：找不到程序文件（应该包含 app/web/index.html）");
                std::process::exit(1);
            }
        };

        let rt = tokio::runtime::Runtime::new().expect("创建 tokio 运行时失败");
        rt.block_on(async move {
            if let Err(e) = serve(paths, port).await {
                note!("错误：服务启动失败：{e}");
                std::process::exit(1);
            }
        });
        return;
    }

    // ── 正常模式：Tauri 窗口 + 内嵌服务 ────────────────────────
    // `move` 是必需的：setup 闭包要活到 'static，得把 base_path 的所有权交进去。
    tauri::Builder::default()
        .setup(move |app| {
            let handle = app.handle().clone();

            // 安装版的界面/工具在 Tauri 的 resource_dir 下；绿色版在 exe 旁边。
            // 两种都交给 resolve_paths 判断，不用在这里分叉。
            let paths = match resolve_paths(app.path().resource_dir().ok()) {
                Some(p) => p,
                None => {
                    show_error(
                        &handle,
                        "找不到程序文件（app/web/index.html）。\n\
                         绿色版：请把整个目录一起解压，不要只拷 exe。\n\
                         安装版：安装可能不完整，建议重新安装。",
                    );
                    return Ok(());
                }
            };

            let port = pick_port();

            /*
             * 服务跑在进程内的 tokio 任务里，**不是子进程**。
             * 这是这次重写的核心目的：窗口和服务同生共死，不存在孤儿进程。
             */
            let paths_for_server = paths.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(e) = serve(paths_for_server, port).await {
                    note!("错误：内嵌服务异常退出：{e}");
                }
            });

            // 等端口真的能连上再开窗口
            if !wait_for_port(port, STARTUP_TIMEOUT_SECS) {
                show_error(&handle, "内嵌服务 30 秒内没有启动成功。请检查 data/desktop-error.log。");
                return Ok(());
            }

            // 注意末尾的斜杠：/next 少了它，静态文件处理器会先 301 再补，
            // 直接带上省一次跳转。
            let url: tauri::Url = format!("http://127.0.0.1:{port}{base_path}/")
                .parse()
                .expect("本地地址一定能解析");

            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title(WINDOW_TITLE)
                .inner_size(1360.0, 880.0)
                .min_inner_size(960.0, 640.0)
                /*
                 * ⚠️ **必须关掉 Tauri 的拖放拦截**，否则网页里收不到 HTML5 的 drop 事件。
                 * Tauri 默认 `drag_drop_enabled = true`：文件拖进来会被它自己截走、改发成 Tauri 事件，
                 * 而我们是「网页 + 本地 HTTP 服务」的架构（页面拿不到 Tauri IPC），
                 * 结果就是「把工程拖进窗口」永远没反应。
                 * 关掉之后交给 WebView 原生处理，`dataTransfer.files` 才有值。
                 */
                .disable_drag_drop_handler()
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
async fn serve(paths: AppPaths, port: u16) -> Result<(), String> {
    let state = server::AppState::new(paths.clone());
    let app = server::router(state.clone());

    let listener = tokio::net::TcpListener::bind(("127.0.0.1", port))
        .await
        .map_err(|e| format!("端口 {port} 绑定失败：{e}"))?;

    note!("翻调工作站已启动 —— 地址 http://127.0.0.1:{port}");
    note!("  根目录：{}", crate::platform::clean_path(&paths.root));
    if paths.installed {
        note!("  配置目录：{}", crate::platform::clean_path(&paths.writable));
    }

    axum::serve(listener, app)
        .await
        .map_err(|e| format!("服务运行出错：{e}"))
}

/* ────────────────────────────────── 路径与端口 ────────────────────────────────── */

/// 从可执行文件位置往上找程序根目录。
/// 程序的路径布局。两种形态共用一套代码：
///
/// - **绿色版**（整个目录解压，双击 bat）：根目录就是解压出来的那一层，
///   数据写在 `<根>/app/data/`。
/// - **安装版**（MSI/NSIS 装到 Program Files）：界面和工具在 Tauri 的
///   resource_dir 下，而**那里是只读的** —— 配置必须写到用户目录，
///   否则保存设置会失败（Program Files 需要管理员权限才能写）。
#[derive(Clone)]
pub struct AppPaths {
    /// 只读资源根目录（含 `app/web/`、`app/data/`、`tools/`）
    pub root: PathBuf,
    /// 可写目录（`config.json` 写这里）
    pub writable: PathBuf,
    /// 是否安装版 —— 决定出错提示怎么写
    pub installed: bool,
}

impl AppPaths {
    /// 只读数据目录（`resources.json`、`pinyin.json`，随包分发不改）
    pub fn data(&self) -> PathBuf {
        self.root.join("app").join("data")
    }
}

/// 定位程序的路径布局。
///
/// 查找顺序（先命中先赢）：
///   1. Tauri 的 `resource_dir()` —— 安装版走这条
///   2. 从 exe 所在目录往上找 —— 绿色版走这条
///   3. 当前工作目录往上找 —— 开发时直接 `cargo run` 走这条
///
/// 判据是 `app/web/index.html` 存在（前端的入口，两种形态都在）。
fn resolve_paths(resource_dir: Option<PathBuf>) -> Option<AppPaths> {
    let has_web = |d: &Path| d.join("app").join("web").join("index.html").is_file();

    /*
     * 判据不能只看「resource_dir 里有没有 app/web」。
     *
     * 绿色版运行时，Tauri 的 resource_dir() 返回的**就是 exe 所在目录** ——
     * 那里当然有 app/web/index.html，于是会被误判成安装版，
     * 配置就被写到 %APPDATA% 去了，而绿色版应该写在程序旁边的 app/data/。
     *
     * 所以真正的判据是「程序目录能不能写」：
     *   - 能写（绿色版、解压在用户目录）→ 配置放旁边，整个目录可以拷着走
     *   - 不能写（装在 Program Files）→ 配置放 %APPDATA%
     */
    let mut root_from_resource: Option<PathBuf> = None;
    if let Some(rd) = resource_dir {
        if has_web(&rd) {
            root_from_resource = Some(rd);
        }
    }
    if let Some(rd) = root_from_resource {
        let local_data = rd.join("app").join("data");
        if is_writable(&local_data) {
            return Some(AppPaths {
                writable: local_data,
                root: rd,
                installed: false,
            });
        }
        return Some(AppPaths {
            writable: user_data_dir(),
            root: rd,
            installed: true,
        });
    }

    // ── 2/3. 绿色版 / 开发：从 exe 和 cwd 往上找 ──
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
            if has_web(d) {
                return Some(AppPaths {
                    root: d.to_path_buf(),
                    // 绿色版：配置就放在程序旁边，便于整个目录拷着走
                    writable: d.join("app").join("data"),
                    installed: false,
                });
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

/// 目录能不能写。
///
/// 判据是「真的建一个文件试试」而不是看只读属性 ——
/// Program Files 下 ACL 才是拦路虎，只读位看不出来。
fn is_writable(dir: &Path) -> bool {
    if std::fs::create_dir_all(dir).is_err() {
        return false;
    }
    let probe = dir.join(".write-probe");
    match std::fs::write(&probe, b"") {
        Ok(()) => {
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// 安装版的可写目录：`%APPDATA%\<identifier>\`
fn user_data_dir() -> PathBuf {
    let base = std::env::var_os("APPDATA")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from))
        .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
        .unwrap_or_else(std::env::temp_dir);
    base.join("com.qingmu.vocalworkstation")
}

/// 界面用的首选端口。
///
/// **端口必须稳定**：localStorage 按 origin（协议 + 主机 + 端口）隔离，
/// 端口一变就等于换了一套存储 —— JIZURA 的教程标记、界面设置、
/// **工程自动保存（jizura.project.\*）** 全都会丢。
///
/// 选 17878：在 Windows 的动态端口范围（49152 起）之外，不会被临时连接占用，
/// 也不撞常见服务端口。只绑 127.0.0.1，不暴露到局域网。
const PREFERRED_PORT: u16 = 17878;

/// 优先用固定端口，被占用了才退回随机 —— 但要在日志里说清楚，
/// 否则以后「设置和工程怎么又没了」没法排查。
fn pick_port() -> u16 {
    if port_is_free(PREFERRED_PORT) {
        return PREFERRED_PORT;
    }
    let fallback = free_port();
    note!(
        "端口 {PREFERRED_PORT} 已被别的程序占用，本次改用随机端口 {fallback}。\
         注意：界面设置、教程标记与 PV 工程自动保存都与端口绑定，这一次不会延续。"
    );
    fallback
}

/// 端口能不能绑（只探 127.0.0.1，和 serve 的绑定范围一致）
fn port_is_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
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
    let dir = resolve_paths(None)
        .map(|p| p.writable)
        .unwrap_or_else(|| PathBuf::from("."));
    let _ = std::fs::create_dir_all(&dir);
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("desktop-error.log"))
    {
        use std::io::Write;
        let _ = writeln!(f, "{message}");
    }
    note!("错误：{message}");

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
