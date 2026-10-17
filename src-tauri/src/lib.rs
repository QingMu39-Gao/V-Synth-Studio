// V-Synth-Studio  ·  QingMu39
// Tauri 桌面应用（纯 IPC，没有 HTTP 服务）
//
// 架构：
//   一个进程搞定所有事 —— 窗口、命令处理、转换编排、任务系统全在这里。
//   前端加载的是 Tauri 自己的资源协议（Windows 上是 `http://tauri.localhost`），
//   前后端交互**只走 `tauri::command`**（见 `src/ipc/`，命令登记在下面的
//   `generate_handler!`）。

mod announce;
mod artifact;
mod audio;
mod bili;
mod data;
mod download;
mod game;
mod ghmirror;
mod ipc;
mod libresvip;
mod lyrics;
mod midi_transcribe;
mod net;
mod platform;
mod reg;
mod sponsors;
mod svsep;
mod update;
mod upgrade;
mod wallpaper;

/// `app.log` 超过这个大小就滚成 `app.log.1`。
///
/// 只留一代是有意为之：这份日志是给用户贴进 issue 的，要的是「最近发生了什么」，
/// 不是归档 —— 于是磁盘占用上限是它的两倍。
const LOG_MAX_BYTES: u64 = 5 * 1024 * 1024;

/// 超限时把 `app.log` 滚成 `app.log.1`（上一代直接丢掉）。
///
/// ⚠️ Windows 的 `rename` **不覆盖**已存在的目标，所以必须先删掉旧的 `.1`：
/// 少了这一步，第二次滚动起就静默失败，日志又回到无限增长。
fn rotate_log(dir: &Path, limit: u64) {
    let log = dir.join("app.log");
    if std::fs::metadata(&log).map(|m| m.len()).unwrap_or(0) < limit {
        return;
    }
    let old = dir.join("app.log.1");
    let _ = std::fs::remove_file(&old);
    let _ = std::fs::rename(&log, &old);
}

/// 追加一行日志到 `<可写目录>/app.log`。
///
/// 不写 stdout：程序是 windows 子系统（无控制台窗口），打出去的东西没人看得见。
/// 也不引日志库：这里只有十来行输出，一个 `OpenOptions::append` 就够。
///
/// `pub(crate)`：别的模块里也有需要记一行的地方（见 `ipc/config.rs` 读配置那处）。
pub(crate) fn log_line(msg: &str) {
    use std::io::Write;

    // 启动早期路径还没解析出来，退回临时目录，保证日志不丢
    let dir = resolve_paths(None, None)
        .map(|p| p.writable)
        .unwrap_or_else(std::env::temp_dir);
    let _ = std::fs::create_dir_all(&dir);
    rotate_log(&dir, LOG_MAX_BYTES);

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
use std::sync::Arc;

use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

const WINDOW_TITLE: &str = "V-Synth-Studio";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    /*
     * 主窗口由 `tauri.conf.json` 的 `app.windows` 声明（标签 `main`，
     * 与 `capabilities/default.json` 里的 `"windows": ["main"]` 对应）。
     *
     * 界面只有一套，入口是 Tauri 的资源协议（见 `tauri.conf.json` 的 `frontendDist`）。
     *
     * ⚠️ **没有 `--serve` / `--port=` 这类开关**，也没有「只跑服务不开窗口」的模式：
     * 传了也只会照常开窗口。要跑自动化就用 Rust 侧的单测（`cargo test --lib`）。
     */
    note!("界面：React 前端（Tauri 资源协议 + IPC）");

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(move |app| {
            let handle = app.handle().clone();

            // 安装版的工具/数据在 Tauri 的 resource_dir 下；开发版在工程根目录。
            // 两种都交给 resolve_paths 判断，不用在这里分叉。
            // 可写目录同样问 Tauri（`app_data_dir` 按 identifier 推），不自己拼目录名。
            let paths = match resolve_paths(
                app.path().resource_dir().ok(),
                app.path().app_data_dir().ok(),
            ) {
                Some(p) => p,
                None => {
                    show_error(
                        &handle,
                        "找不到程序数据（data/resources.json）。\n\
                         这个文件是「程序根目录」的判定依据。\n\
                         安装可能不完整，建议重新安装。",
                    );
                    return Ok(());
                }
            };
            note!("  根目录：{}", platform::clean_path(&paths.root));
            if paths.installed {
                note!("  配置目录：{}", platform::clean_path(&paths.writable));
            }

            /*
             * 状态**必须** `manage` 进来（IPC command 靠 `State<Arc<AppState>>` 取它）。
             *
             * ⚠️ 下面那段 `RunEvent::Exit` 靠 `try_state::<Arc<AppState>>()` 收子进程 ——
             * 拿不到状态它就什么都不做（回 `None`，且不报错）。
             */
            let state = ipc::AppState::new(paths.clone());
            app.manage(Arc::clone(&state));

            // 后台预热一次外部工具探测：`detect_tools` 会真的 spawn
            // `yt-dlp --version` / `python --version` 并逐段扫 PATH，机器忙时 2~7 秒。
            // 不预热的话，前端首屏那次 `get_state` 就要干等这几秒（用户看到的是白屏）。
            std::thread::spawn(move || {
                let _ = state.probe_cached(false);
                /* 升级清理（见 `crate::upgrade`）：扫几个顶层目录、删自己的临时文件，
                毫秒级，但**不能放在 setup 里同步做** —— 那是主线程，而这几条路径
                可能在机械盘或网络盘上，慢起来就是「启动时窗口不出现」。 */
                let _ = upgrade::cleanup(
                    &state.writable,
                    &artifact::ext_of(&state.writable),
                    state.previous_ext_dir.as_deref(),
                );
            });

            /* 窗口在 `tauri.conf.json` 里是 `visible: false`，由前端 `main.tsx`
            在 `get_config` 落定后 `show()` 揭开。这里再兜一道：前端万一没能执行
            （JS 报错、`show` 权限被拒），窗口**不能**永远不可见 —— 那就是「进程活着
            但什么都没出现」。 */
            {
                let handle = handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(6));
                    if let Some(w) = handle.get_webview_window("main")
                        && !w.is_visible().unwrap_or(false)
                    {
                        note!("前端未在 6 秒内显示窗口，兜底显示");
                        let _ = w.show();
                    }
                });
            }

            /*
             * ⚠️ **不要关掉 Tauri 的拖放拦截**（`WebviewWindowBuilder::disable_drag_drop_handler`）。
             * 我们要的正是那个 Tauri 事件 —— `DragDropEvent::Drop` 的载荷里直接带
             * `paths`（真路径），比 HTML5 那条「拿到 File 对象再上传换一个路径」的路
             * 少一整圈。保持默认开启即可。
             *
             * 主窗口本身在 `tauri.conf.json` 的 `app.windows` 里声明，不在这里建。
             */
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            /* ── 状态与配置 ── */
            ipc::state::get_state,
            ipc::config::get_config,
            ipc::config::set_config,
            ipc::config::migrate_legacy_settings,
            /* ── 文件系统 ── */
            ipc::fs::pick_paths,
            ipc::fs::allow_path,
            ipc::fs::open_path,
            ipc::fs::open_url,
            ipc::fs::upload_dropped,
            ipc::fs::read_bytes,
            ipc::fs::mkdir,
            ipc::fs::remove_path,
            /* ── 文字 PV 分块落盘 ── */
            ipc::pv::pv_save_chunk,
            /* ── 任务与资源库 ── */
            ipc::jobs::list_jobs,
            ipc::jobs::get_job,
            ipc::jobs::cancel_job,
            ipc::jobs::job_watch,
            ipc::jobs::get_resources,
            ipc::jobs::check_resources,
            /* ── 外部工具 ── */
            ipc::tools::tools_detect,
            ipc::tools::tools_launch,
            ipc::tools::artifacts_status,
            /* ── 背景壁纸（只读用户自己的 Wallpaper Engine 库）── */
            ipc::wallpaper::wallpaper_scan,
            ipc::wallpaper::wallpaper_pkg,
            /* ── 工程转换 ── */
            ipc::convert::convert_collect,
            ipc::convert::convert_inspect,
            ipc::convert::convert_preview,
            ipc::convert::convert_run,
            /* ── 视频解析下载 / 音频 / 预览缓存 ── */
            ipc::media::video_parse,
            ipc::media::video_download,
            ipc::media::audio_probe,
            ipc::media::audio_run,
            ipc::media::preview_fetch,
            ipc::media::preview_clear,
            /* ── B 站扫码登录 ── */
            ipc::bili::bili_qr_generate,
            ipc::bili::bili_qr_poll,
            ipc::bili::bili_logout,
            /* ── 歌词（网易云专栏）── */
            ipc::lyrics::lyrics_search,
            ipc::lyrics::lyrics_get,
            ipc::lyrics::lyrics_parse_link,
            ipc::lyrics::lyrics_import,
            ipc::lyrics::lyrics_save,
            ipc::lyrics::lyrics_cover,
            ipc::lyrics::lyrics_song,
            ipc::lyrics::lyrics_logout,
            ipc::lyrics::lyrics_login_sms,
            ipc::lyrics::lyrics_login_cellphone,
            ipc::lyrics::lyrics_account,
            ipc::lyrics::lyrics_renew,
            /* ── 音轨分离 ── */
            ipc::svsep::svsep_status,
            ipc::svsep::svsep_start,
            ipc::svsep::svsep_stop,
            ipc::svsep::svsep_models_download,
            ipc::svsep::svsep_runtime_download,
            /* ── 扩展包目录（音轨分离与人声转 MIDI 共用同一个根）── */
            ipc::svsep::ext_dir_get,
            ipc::svsep::ext_dir_set,
            ipc::svsep::svsep_dml_download,
            ipc::svsep::svsep_download_pause,
            ipc::svsep::svsep_download_stop,
            ipc::svsep::svsep_deps_delete,
            ipc::svsep::svsep_deps_delete_stop,
            ipc::svsep::svsep_backend_status,
            ipc::svsep::svsep_inference_get,
            ipc::svsep::svsep_set_inference,
            ipc::svsep::svsep_separate,
            ipc::svsep::svsep_task,
            ipc::svsep::svsep_cancel,
            ipc::svsep::svsep_open_output,
            /* ── 人声转 MIDI ── */
            ipc::midi::midi_status,
            ipc::midi::midi_device_get,
            ipc::midi::midi_device_set,
            ipc::midi::midi_models_download,
            ipc::midi::midi_download_stop,
            ipc::midi::midi_deps_delete,
            ipc::midi::midi_transcribe,
            ipc::midi::midi_task,
            ipc::midi::midi_cancel,
            ipc::midi::midi_open_output,
            /* ── 检查更新 ── */
            ipc::update::update_check,
            ipc::update::update_download,
            /* ── 公告 ── */
            ipc::announce::announce_list,
            /* ── 感谢名单 ── */
            ipc::sponsors::sponsor_list,
            /* ── 进程级 ── */
            ipc::app::app_quit,
        ])
        .build(tauri::generate_context!())
        .expect("Tauri 应用构建失败")
        .run(|app, event| {
            /*
             * 真正收子进程（分离引擎的 python.exe）的是两套机制，缺一不可：
             *
             *   1. `impl Drop for Svsep` —— 正常退出时跑。`Svsep` 是 `AppState` 的字段，
             *      而下面的 `try_state` 拿得到它，所以正常退出这条路是可靠的。
             *   2. Windows 作业对象（`svsep.rs` 的 `job` 模块）—— 兜住任务管理器强杀：
             *      那种退出不会跑析构，只能靠「进程一死句柄被内核回收 → 作业里的进程
             *      一起死」。
             */
            if let tauri::RunEvent::Exit = event {
                note!("窗口关闭，正在收尾…");
                let _ = app.try_state::<Arc<ipc::AppState>>();
            }
        });
}

/* ────────────────────────────────── 路径 ────────────────────────────────── */

/// 程序的路径布局。两种形态共用一套代码：
///
/// - **绿色版**（整个目录解压，双击 bat）：根目录就是解压出来的那一层，
///   数据写在 `<根>/data/`。
/// - **安装版**（MSI/NSIS 装到 Program Files）：界面和工具在 Tauri 的
///   resource_dir 下，而**那里是只读的** —— 配置必须写到用户目录，
///   否则保存设置会失败（Program Files 需要管理员权限才能写）。
///
/// 只读数据目录（`resources.json`、`pinyin.json`，随包分发不改）是
/// `<root>/data/`，由 `AppState` 自己拼，所以这里不需要一个同名的访问器。
#[derive(Clone)]
pub struct AppPaths {
    /// 只读资源根目录（含 `data/`、`tools/`）
    pub root: PathBuf,
    /// 可写目录（`config.json` 写这里）
    pub writable: PathBuf,
    /// 是否安装版 —— 决定出错提示怎么写
    pub installed: bool,
}

/// 定位程序的路径布局。
///
/// 查找顺序（先命中先赢）：
///   1. Tauri 的 `resource_dir()` —— 安装版走这条
///   2. 从 exe 所在目录往上找 —— 绿色版走这条
///   3. 当前工作目录往上找 —— 开发时直接 `cargo run` 走这条
///
/// 判据是 `data/resources.json` 存在（随包分发的只读数据，两种形态都在）。
///
/// macOS 的 `.app` 一律按安装版处理 —— 理由见下面 `in_macos_bundle` 那段。
///
/// ⚠️ **不能用前端入口当哨兵**：前端是 `frontendDist` 的纯构建产物，被 Tauri
/// 嵌进二进制，磁盘上不再留一个可寻址的目录。而 `data/` 与 `tools/` 是
/// **运行时**要找的东西，必须留在磁盘上。
///
/// `app_data_dir` 是 Tauri 按 `identifier` 推出来的用户目录（安装版的可写落点）。
/// 交给调用方传进来，因为它在 `setup` 里才拿得到 `AppHandle`；拿不到时退回
/// [`fallback_data_dir`]（裸 `cargo run`、单元测试这类没有 `AppHandle` 的场合）。
fn resolve_paths(resource_dir: Option<PathBuf>, app_data_dir: Option<PathBuf>) -> Option<AppPaths> {
    let has_data = |d: &Path| d.join("data").join("resources.json").is_file();

    /*
     * 判据不能只看「resource_dir 里有没有 data」。
     *
     * 绿色版运行时，Tauri 的 resource_dir() 返回的**就是 exe 所在目录** ——
     * 那里当然有 data/resources.json，于是会被误判成安装版，
     * 配置就被写到 %APPDATA% 去了，而绿色版应该写在程序旁边的 data/。
     *
     * 所以判据是「程序目录能不能写」，**但要再排除用户级的安装目录**：
     *   - 程序在 `%LOCALAPPDATA%\<产品名>`（per-user 安装的落点）→ 安装版，配置走 %APPDATA%
     *   - 在别处且能写（解压在桌面/别的盘）→ 绿色版，配置放旁边，整个目录可以拷着走
     *   - 不能写（装在 Program Files）→ 安装版，配置走 %APPDATA%
     *
     * ⚠️ **`%LOCALAPPDATA%` 那一条不能省**：exe 安装包是 per-user 装到那里的，
     * 而「程序目录可写」对它恒成立 —— 少了这一条，装完之后程序会把自己当成绿色版，
     * 把配置写到 `<安装目录>\data\config.json`，于是「升级后设置全没了、扩展包默认
     * 目录也变了」。它在 Windows 语义上就是**安装版**：那是放程序的地方，不是放数据的。
     *
     * ⚠️ **macOS 上不看可写位**：`.app` 拖进「应用程序」后归当前用户所有、目录
     * 也能写，照可写位判就会把配置写进 `Contents/Resources/data/` —— 那会改到
     * 应用包自己的内容（签名随之失效，升级一覆盖就没了）。bundle 里的东西一律
     * 当只读，可写目录走 `app_data_dir`（`~/Library/Application Support/<id>`）。
     */
    let in_macos_bundle = resource_dir
        .as_deref()
        .is_some_and(|rd| rd.to_string_lossy().contains(".app/Contents/"));
    let mut root_from_resource: Option<PathBuf> = None;
    if let Some(rd) = resource_dir
        && has_data(&rd)
    {
        root_from_resource = Some(rd);
    }
    if let Some(rd) = root_from_resource {
        let local_data = rd.join("data");
        let portable =
            is_writable(&local_data) && !in_macos_bundle && !in_user_install_dir(&rd, None);
        if portable {
            return Some(AppPaths {
                writable: local_data,
                root: rd,
                installed: false,
            });
        }
        let writable = app_data_dir.unwrap_or_else(fallback_data_dir);
        /* 记一行：程序目录可写但被判成安装版时，这一行是唯一能看出「为什么配置
        没写在程序旁边」的地方（用户级安装落点，见 `in_user_install_dir`）。 */
        log_line(&format!(
            "路径：程序目录 {} 可写，但它是安装落点 ⇒ 按安装版处理，配置写到 {}",
            rd.display(),
            writable.display()
        ));
        return Some(AppPaths {
            writable,
            root: rd,
            installed: true,
        });
    }

    // ── 2/3. 绿色版 / 开发：从 exe 和 cwd 往上找 ──
    let mut bases: Vec<PathBuf> = Vec::new();
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        bases.push(dir.to_path_buf());
    }
    if let Ok(cwd) = std::env::current_dir() {
        bases.push(cwd);
    }

    for base in bases {
        let mut dir: Option<&Path> = Some(base.as_path());
        let mut depth = 0;
        while let Some(d) = dir {
            if has_data(d) {
                return Some(AppPaths {
                    root: d.to_path_buf(),
                    // 绿色版：配置就放在程序旁边，便于整个目录拷着走
                    writable: d.join("data"),
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

/// 这个程序目录是不是**用户级的安装落点**（`%LOCALAPPDATA%\<产品名>`）。
///
/// 只用来把「exe 安装包装出来的程序」和「用户自己解压的绿色版」分开：两者的
/// 程序目录都可写，差别只在这个位置是**安装器**选的、还是用户选的。
/// 绿色版解压在桌面、D 盘、下载目录都行，那里不是 `%LOCALAPPDATA%`。
///
/// `cwd` 是给单测注入的当前工作目录（`LOCALAPPDATA` 被抹掉时用它推），传 `None`
/// 就自己去问系统。
fn in_user_install_dir(dir: &Path, cwd: Option<&Path>) -> bool {
    let local = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(|| cwd.filter(|c| c.is_absolute()).map(Path::to_path_buf));
    let Some(local) = local else {
        return false;
    };
    let dir = std::fs::canonicalize(dir).unwrap_or_else(|_| dir.to_path_buf());
    let local = std::fs::canonicalize(&local).unwrap_or(local);
    // 只认直属子目录：`%LOCALAPPDATA%\v-synth-studio` 是安装落点，
    // 而 `%LOCALAPPDATA%\Temp\某处解压的绿色版` 不是
    dir.parent() == Some(local.as_path()) && dir.file_name().is_some()
}

/// Tauri 尚未给出 `app_data_dir` 时的兜底可写目录。
///
/// 正常路径走 `app.path().app_data_dir()`（由 `identifier` 推出，见 `resolve_paths`）。
/// 这个只在拿不到 `AppHandle` 的场合用（裸 `cargo run`、单元测试）。
/// ⚠️ 目录名与 `tauri.conf.json` 的 `identifier` 无关是有意为之 —— 它是最后一道
/// 兜底，不该假装知道 bundle 标识。
fn fallback_data_dir() -> PathBuf {
    /* macOS 上 `APPDATA` / `XDG_CONFIG_HOME` 都不存在，别落到 `~/.config` ——
    那就与 Tauri 的 `app_data_dir()`（`~/Library/Application Support/<id>`）
    分成两处了，同一个程序的数据会散在两个目录里。 */
    let base = if cfg!(target_os = "macos") {
        std::env::var_os("HOME").map(|h| PathBuf::from(h).join("Library/Application Support"))
    } else {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("XDG_CONFIG_HOME").map(PathBuf::from))
            .or_else(|| std::env::var_os("HOME").map(|h| PathBuf::from(h).join(".config")))
    }
    .unwrap_or_else(std::env::temp_dir);
    base.join("com.qingmu.vocalworkstation")
}

/* ────────────────────────────────── 失败提示 ────────────────────────────────── */

/// 出错日志的完整路径，给用户看的。
///
/// 日志写在**可写目录**下（绿色版 `<根>\app\data\`，安装版即 `app_data_dir`
/// = `%APPDATA%\<identifier>\`），不是固定的 `data\` ——
/// 文案里写死 `data\desktop-error.log` 对安装版是错的。
fn error_log_hint() -> String {
    resolve_paths(None, None)
        .map(|p| p.writable.join("desktop-error.log"))
        .map(|p| platform::clean_path(&p))
        .unwrap_or_else(|| "程序数据目录下的 desktop-error.log".to_string())
}

fn show_error(app: &tauri::AppHandle, message: &str) {
    // 日志路径由这里统一附在提示后面（绿色版与安装版不同，页面那边别写死）。
    let message = format!("{message}\n详细信息见：{}", error_log_hint());
    let message = message.as_str();
    // 写日志
    let dir = resolve_paths(None, None)
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

    // 开一个窗口把原因显示出来（原因通过 hash 传过去）。
    // ⚠️ 标签**不能**是 `main` —— 主窗口由 `tauri.conf.json` 声明、早就建好了，
    //    再建一个同名窗口只会失败。
    // ⚠️ 窗口加载的是**主界面**（`frontendDist` 的 index.html），而主界面不认识这个 hash
    //    （它只路由 `#/<页名>`）—— 所以用户实际看到的是界面本身，真正的原因在上面
    //    写进日志的那一行里。要给出「失败时一页说明」的体验，得先在 `frontendDist`
    //    里放一个能渲染 hash 的静态页。
    // `build()` 失败时不 panic —— 那时候真正的原因已经写进日志了。
    if let Ok(w) = WebviewWindowBuilder::new(app, "error", WebviewUrl::App("index.html".into()))
        .title(WINDOW_TITLE)
        .inner_size(720.0, 420.0)
        .center()
        .build()
    {
        let encoded = urlencode(message);
        let _ = w.eval(format!("location.hash='{encoded}';location.reload();"));
    }
}

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

#[cfg(test)]
mod tests {
    use super::*;

    /* 日志滚动。`app.log` 是无限追加的，写满用户盘时 `writeln!` 只是失败 ——
    界面上一句提示都没有，所以上限只能靠这里保证。 */
    fn log_dir(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vss-log-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).expect("建临时目录");
        d
    }

    #[test]
    fn rotation_moves_an_oversized_log_aside() {
        let d = log_dir("rotate");
        std::fs::write(d.join("app.log"), vec![b'x'; 16]).unwrap();

        rotate_log(&d, 8);

        assert!(!d.join("app.log").exists(), "超限那份该被滚走");
        assert_eq!(std::fs::read(d.join("app.log.1")).unwrap().len(), 16);
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn rotation_leaves_a_small_log_in_place() {
        let d = log_dir("small");
        std::fs::write(d.join("app.log"), b"hi").unwrap();

        rotate_log(&d, 8);

        assert_eq!(std::fs::read(d.join("app.log")).unwrap(), b"hi");
        assert!(!d.join("app.log.1").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// Windows 的 `rename` 不覆盖已存在的目标 —— 不先删旧的 `.1` 时，这一条会失败
    /// （`app.log` 原地不动、继续涨），而 Unix 上照样是绿的。
    #[test]
    fn rotation_replaces_the_previous_file() {
        let d = log_dir("replace");
        std::fs::write(d.join("app.log.1"), b"old-old-old-old").unwrap();
        std::fs::write(d.join("app.log"), b"new-new-new-new").unwrap();

        rotate_log(&d, 8);

        assert_eq!(
            std::fs::read(d.join("app.log.1")).unwrap(),
            b"new-new-new-new"
        );
        assert!(!d.join("app.log").exists());
        let _ = std::fs::remove_dir_all(&d);
    }

    #[test]
    fn rotation_without_a_log_does_nothing() {
        let d = log_dir("missing");

        rotate_log(&d, 8);

        assert!(!d.join("app.log.1").exists());
        let _ = std::fs::remove_dir_all(&d);
    }
}
