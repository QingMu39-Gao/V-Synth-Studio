//! 状态聚合 + 任务表。
//!
//! `AppState` 与 `JobTable` 属于「后端」而不是某一层传输：它们在这里定义，
//! 命令层只取用。

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Instant;

use serde_json::{Value, json};

use super::Cmd;

/* ══════════════════════════════════ 任务表 ══════════════════════════════════ */

/// 任务表 —— 长任务（转换 / 下载 / 分离 / 扒谱）共用的一份进度记录。
///
/// `tx` 是给**实时订阅**用的广播通道：任何任务状态变化都往里发一份**完整快照**，
/// 订阅方是 [`crate::ipc::jobs::job_watch`]，它把快照转给前端的 `tauri::ipc::Channel`。
/// 用**一个全局广播**而不是「每个任务一个通道」：任务数少、订阅者更少，按 id 过滤的
/// 代价可以忽略，换来的是不用维护通道的创建与销毁。
///
/// ⚠️ 推的是**完整快照而不是增量**：订阅者偶尔卡顿丢一条也不影响正确性，
/// 所以容量 256 就够，不必追求不丢消息。
pub struct JobTable {
    pub items: BTreeMap<String, Value>,
    pub seq: u64,
    pub tx: tokio::sync::broadcast::Sender<Value>,
}

impl Default for JobTable {
    fn default() -> Self {
        let (tx, _) = tokio::sync::broadcast::channel(256);
        Self {
            items: BTreeMap::new(),
            seq: 0,
            tx,
        }
    }
}

impl JobTable {
    /// 广播一份任务快照
    pub fn publish(&self, job: &Value) {
        let _ = self.tx.send(job.clone());
    }
}

/* ══════════════════════════════════ 全局状态 ══════════════════════════════════ */

/// 全局共享状态。极简 —— 只有真的需要跨命令共享的东西才放进来。
///
/// 在 `lib.rs` 的 setup 里 `app.manage()` 进来，命令用 `tauri::State<Arc<AppState>>` 取。
pub struct AppState {
    /// 只读资源根目录（含 data/、tools/）
    pub root: PathBuf,
    /// 可写目录 —— 配置与下载产物写这里。
    /// 绿色版就是 `data/`；安装版在 `%APPDATA%` 下。
    pub writable: PathBuf,
    /// 是否安装版 —— 界面上给恢复提示时用得上
    pub installed: bool,
    /// 安装时选的界面语言（`zh-CN` / `en-US` / `ja-JP`），读不到是 `None`。
    ///
    /// ⚠️ 只在**启动时读一次**（见 `new`）：它来自注册表里安装器写下的那一条，
    /// 运行期不会变，而每次 `get_state` 都去开一次注册表纯属浪费。
    pub installer_lang: Option<&'static str>,
    /// 配置
    pub config: Mutex<Value>,
    /// **上一个**扩展包目录（`extDir` 被改之前的那个）。
    ///
    /// 只有升级清理用它：老落点里可能留着几 GB 的半个包，而那些文件不会再被任何人
    /// 认领（见 `crate::upgrade`）。`None` = 没换过。
    pub previous_ext_dir: Option<PathBuf>,
    /// 任务表
    pub jobs: Mutex<JobTable>,
    /// 离线音轨分离服务（Python 子进程）。见 `crate::svsep`。
    pub svsep: crate::svsep::Svsep,
    /// 外部工具探测的缓存：`(editors, tools, 算完的时刻)`。
    ///
    /// **为什么要缓存**：`detect_tools` 会真的 spawn `yt-dlp --version` /
    /// `python --version`，还要逐段扫 `PATH`，机器忙时一次 2~7 秒；首屏的
    /// `get_state` 要是每次现算，用户看到的就是「启动卡死/白屏很久」。
    /// 现在启动时在后台线程预热一次，之后的调用直接读缓存。
    pub probe_cache: Mutex<Option<(Vec<Value>, Value, Instant)>>,
}

/// 探测结果的缓存时长。工具是随程序打包的，装好之后基本不变；
/// 用户手动补回 `tools/` 目录后最多等一分钟，或者点界面上的「重新检测」
/// （`tools_detect` 走 `probe_cached(true)` 绕过缓存）。
const PROBE_TTL: std::time::Duration = std::time::Duration::from_secs(60);

/// 配置里选定的扩展包目录（空串 = 没选过，用可写目录）。
///
/// ⚠️ **老键 `svsepRuntimeDir` 优先**：它是上一版用户显式选过的音轨分离落点，
/// 而 `extDir` 是本版新加的键 —— 只认后者会把老用户那 7.4 GB 判成「没装」。
fn ext_dir_setting(config: &Value) -> String {
    config
        .get("extDir")
        .and_then(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .or_else(|| {
            config
                .get("svsepRuntimeDir")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
        })
        .unwrap_or("")
        .trim()
        .to_string()
}

impl AppState {
    pub fn new(paths: crate::AppPaths) -> Arc<Self> {
        // 可写目录可能还不存在（首次运行安装版），先建出来
        let _ = std::fs::create_dir_all(&paths.writable);
        let mut config = super::config_file::load_config(&paths.writable);
        /* 盘上那份网易云 Cookie 若是脏的（粘贴带进来的换行 / 制表符），就地洗干净 ——
        脏值当请求头发不出去，而界面上只显示「已设置」，用户查不到原因（见
        `config::normalize_netease_cookie`）。清洁的值不动盘。 */
        if super::config::normalize_netease_cookie(&mut config)
            && super::config_file::save_config(&paths.writable, &config).is_err()
        {
            crate::log_line("网易云 Cookie 清洗后落盘失败，本次仍按清洗后的值使用");
        }
        /* 老版本的单开键（`svsepRuntimeDir`）收敛到 `extDir` 上，之后只认后者 ——
        两个键同时活着会让「设置页显示 A、实际落 B」这种鬼状态出现。
        ⚠️ 改了就立刻落盘：不落的话下次启动又得按老键再推一遍，而那时用户可能已经在
        界面上选了新的目录，两边的值就再也对不上了。 */
        let mut migrated = config.clone();
        if crate::upgrade::migrate_config(&mut migrated)
            && super::config_file::save_config(&paths.writable, &migrated).is_ok()
        {
            config = migrated;
        }
        /* 扩展包根必须在**任何人拼产物路径之前**定下来 —— 音轨分离的运行时与模型、
        人声转 MIDI 的 GAME 模型全都从它推出来（见 `crate::artifact` 的模块头）。
        ⚠️ 老配置里那个单独的 `svsepRuntimeDir` 仍然压过 `extDir`：它是用户显式选过的
        音轨分离落点，而 `extDir` 是本版新加的键 —— 只认后者会把老用户那 7.4 GB
        判成「没装」，界面立刻摆出一个「再下一遍」的按钮。 */
        let configured = ext_dir_setting(&config);
        crate::artifact::init_ext_base(&configured);
        let ext = crate::artifact::ext_of(&paths.writable);
        /* 上一版留下的那个落点（只有一个，且与本版生效的不是同一个目录时才存在）：
        升级前用户可能只填过老键，也可能只填过 `extDir`，两边都要算候选 —— 老落点里
        那几 GB 的半个包不会再被任何人认领，正是 `upgrade::cleanup` 要清的。 */
        let previous_ext_dir = ["extDir", "svsepRuntimeDir"]
            .iter()
            .filter_map(|k| config.get(*k).and_then(Value::as_str))
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(PathBuf::from)
            .find(|p| *p != ext);
        /* 加速包（DirectML）按**推理方式**生效：改 `._pth` 里那一行、并复位六轨补丁。
        ⚠️ 必须在扩展包根定下来**之后** —— 那两个文件都在运行时目录里。 */
        crate::svsep::apply_infer_mode(&ext);
        let svsep = crate::svsep::Svsep::new(paths.writable.clone());
        /*
         * ⚠️ 预热**不在这里**做，由调用方（`lib.rs` 的 setup）起线程。本函数在 setup 里
         * 被同步调用，而 setup 跑在主线程上 —— 任何耗时动作都该由调用方显式决定要不要
         * 异步做。
         */
        Arc::new(Self {
            root: paths.root,
            writable: paths.writable,
            installed: paths.installed,
            /* 安装时选的语言：读一次就够（见字段注释）。产品名与打包配置里的
            `productName` 一致，也就是安装器写注册表时用的那个键名。 */
            installer_lang: crate::platform::installer_language("v-synth-studio"),
            config: Mutex::new(config),
            previous_ext_dir,
            jobs: Mutex::new(JobTable::default()),
            svsep,
            probe_cache: Mutex::new(None),
        })
    }

    /// 外部工具探测（带缓存）。
    ///
    /// `force = true` 绕过缓存现算一遍：界面上的「重新检测」必须能反映真实情况，
    /// 否则用户补回 `tools/` 目录后会被缓存骗一分钟。
    pub fn probe_cached(&self, force: bool) -> (Vec<Value>, Value) {
        if !force
            && let Ok(guard) = self.probe_cache.lock()
            && let Some((editors, tools, at)) = guard.as_ref()
            && at.elapsed() < PROBE_TTL
        {
            return (editors.clone(), tools.clone());
        }
        // 注意：**不持锁**跑探测 —— 它要几秒，持锁会把并发调用全串在身后。
        // 代价是冷启动时可能有两三个线程同时探一遍，可以接受（结果一样，最后写的赢）。
        let editors = crate::tools::detect_editors();
        let tools = crate::tools::detect_tools(&self.root);
        if let Ok(mut guard) = self.probe_cache.lock() {
            *guard = Some((editors.clone(), tools.clone(), Instant::now()));
        }
        (editors, tools)
    }

    pub fn config_snapshot(&self) -> Value {
        self.config
            .lock()
            .map(|c| c.clone())
            .unwrap_or_else(|_| json!({}))
    }

    /// 外部工具目录（`tools/`）。
    ///
    /// ⚠️ **不用于定位产物**：`audio` / `ytdlp` / `libresvip` 都收 `root` 并问
    /// `artifact` 表 —— 靠 `tools_dir.parent()` 反推 root 会在传错目录时静默失效。
    /// 这里留着只因为界面上要显示这个路径。
    pub fn tools_dir(&self) -> PathBuf {
        self.root.join("tools")
    }
}

/* ══════════════════════════════════ 命令 ══════════════════════════════════ */

/// 首屏聚合状态 —— 前端启动时**只要这一次调用**就能把界面点亮：版本、路径、工具、
/// 格式表、配置（Cookie 已打码）全在里面。`lib/ipc.ts` 的 `bootstrap()` 用它。
///
/// 这里没有 `pid` / `uptimeSec` 这类信息：它们是「跑在一个 HTTP 端口上」才需要的
/// （哪个进程、活了多久），而 IPC 下前端和 Rust 在同一个进程里、同一个生命周期，
/// 问这些没有意义。版本号与运行环境本来就在这一份里（`version` / `platform`）。
#[tauri::command]
pub async fn get_state(st: super::St<'_>) -> Cmd {
    let cfg = st.config_snapshot();
    // 工具探测走缓存（见 `AppState::probe_cached`）：它要 spawn 进程 + 扫 PATH，
    // 机器忙时一次 2~7 秒，而前端首屏就在等这个。启动时已经在后台线程预热过一次。
    let (editors, tools) = st.probe_cached(false);
    Ok(json!({
        // 前端侧边栏要显示版本号。值 = `Cargo.toml` 的 version（见 config_file.rs）
        "version": super::config_file::APP_VERSION,
        "author": super::config_file::AUTHOR_TAG,
        "formats": crate::libresvip::list_formats(&st.root),
        "editors": editors,
        "tools": tools,
        "transformOps": crate::data::transform_ops(),
        "audioFormats": crate::data::audio_formats(),
        "pinyin": crate::data::pinyin_summary(&st.root),
        // Cookie 打码后再给前端：这一份会进前端全局状态
        "config": super::config_file::mask_secrets(&cfg),
        /* 安装时选的界面语言。**与 `config.language` 分开**：这一个是「安装器想让我用
           哪个语言」，只在第一次启动时由前端应用一次；配置里那个是用户的最终选择，
           之后用户在「设置」里改过就以配置为准（见 `App.tsx`）。 */
        "installerLanguage": st.installer_lang,
        "paths": {
            "root": st.root.to_string_lossy(),
            "outputDir": cfg.get("outputDir").cloned().unwrap_or(json!("")),
            "downloadDir": cfg.get("downloadDir").cloned().unwrap_or(json!("")),
            "toolsDir": st.tools_dir().to_string_lossy(),
        },
        "platform": crate::platform::node_platform_name(),
        "platformDesc": super::config_file::platform_desc(),
        // 这个平台上哪些功能做不到 —— 界面据此置灰入口（判据只在 platform.rs 一份）
        "caps": crate::platform::caps(),
        // 安装版（Program Files）还是绿色版（解压即用）—— 界面给恢复提示时用得上
        "installed": st.installed,
    }))
}
