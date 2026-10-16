//! 音轨分离的命令。真正的活在 Python 那边的分离后端里（见 `crate::svsep`）：这一层让
//! 前端只认一个后端、一套错误形状，并把「服务没起来」说得比 Python 的英文堆栈清楚。
//! 用户不管服务的启停 —— 提交时自动起，任务结束、队列空了就自动关
//! （`auto_stop_when_idle`，那服务占着约 5 GB 内存）。
//!
//! 命令边界：`svsep_separate(path, engine)` 收**本机路径**；产物走 **asset 协议**
//! （`convertFileSrc(输出目录 + 文件名)`）；后端统计并进 `svsep_status`。
//!
//! ⚠️ **转发给上游时必须自己拼 multipart**：上游读 `request.files["file"]`，裸字节
//! 会被判成「未检测到上传文件」+400，见 `multipart_body`。

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use serde_json::{Value, json};

use super::Cmd;

/* ══════════════════════════════ 平台闸门 ══════════════════════════════ */

/// 本地分离引擎在这个平台上有没有可下的运行时。
///
/// 没有就**在下第一块字节之前**拒绝：运行时是 4.9 GB 的 Windows 专属包，让用户
/// 等它下完（甚至解完）再失败是最糟的收场。原因那句话与界面置灰用的是同一份
/// （`platform::local_engine_why`）。
fn require_local_engine() -> Result<(), String> {
    match crate::platform::local_engine_why() {
        None => Ok(()),
        Some(why) => Err(format!("{why}。想分离请用「在线分离：MVSEP」。")),
    }
}

/* ══════════════════════════════ 全局状态（下载 / 删除） ══════════════════════════════ */

/// 大包下载进度。前端每 2 秒轮询一次 `svsep_status` 就能看到它动。
///
/// 放全局静态是因为「同一时刻只可能有一个下载」—— 用户能同时点两次，
/// 但第二次会被 `DL_ACTIVE` 挡掉。运行时（几 GB）与模型（730 MB）共用这一份
/// 状态，`DL_KIND` 说明现在下的是哪一个，界面按它显示对应的按钮。
static DL_BYTES: AtomicU64 = AtomicU64::new(0);
static DL_TOTAL: AtomicU64 = AtomicU64::new(0);
static DL_ACTIVE: AtomicU64 = AtomicU64::new(0);
static DL_ERROR: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
static DL_KIND: std::sync::Mutex<Option<&'static str>> = std::sync::Mutex::new(None);
/// 用户按了「暂停」：下载循环下一块就收手，**`.part` 留着**（下次带 Range 接着下）
static DL_PAUSE: AtomicBool = AtomicBool::new(false);
/// 用户按了「停止」：收手并且**删掉 `.part`**（下次从头下）
static DL_STOP: AtomicBool = AtomicBool::new(false);
/// 现在跑到哪一段了：0 = 在下字节，1 = 下完了、正在解压（`crate::svsep::Stage`）。
///
/// 为什么要让界面知道：解压的分母（所有条目压缩后大小之和）跟 zip 的字节数几乎
/// 一样大，界面上不分段看着就像「下到 100% 又归零、在同一个『正在下载…』标签下
/// 重下一遍」。
static DL_STAGE: AtomicU64 = AtomicU64::new(0);

/// 跑完的任务留一份快照（最近 `KEEP_TASKS` 个，新的在前）。
///
/// **为什么需要**：任务一结束我们就自动把分离服务关了（`auto_stop_when_idle`），
/// 而界面是靠「再轮询一次拿到 `status=done`」才知道该显示那几轨的 —— 轮询间隔
/// 2 秒、关服务在 1.5 秒后，正好错开的话那道 `done` 就永远问不到了：服务已经没了，
/// 界面卡在 90% 还会每 2 秒弹一次「分离服务还没启动」。
/// 终态一到就抄一份在这儿，服务停了也照样答得上（文件本身走 asset 协议，读盘）。
static DONE_TASKS: std::sync::Mutex<Vec<(String, Value)>> = std::sync::Mutex::new(Vec::new());
/// 留着几条 —— 够用户回看最近几次，也不会把内存当缓存使。
const KEEP_TASKS: usize = 8;

/// 「一键删除依赖」在跑吗
static DEL_ACTIVE: AtomicBool = AtomicBool::new(false);
static DEL_BYTES: AtomicU64 = AtomicU64::new(0);
static DEL_FILES: AtomicU64 = AtomicU64::new(0);
/// 用户按了「取消删除」：删除循环下一批就收手，**已经删掉的不复原**。
///
/// 不能借 `DL_STOP`：那个只有下载在跑时才可能被置位，而删除命令在 `DL_ACTIVE == 0`
/// 时才放行 —— 共用一个 flag 就意味着删除过程中没有任何代码能把它翻成 true。
static DEL_STOP: AtomicBool = AtomicBool::new(false);

/* ══════════════════════════════ 进度与状态 ══════════════════════════════ */

/// 下载循环每收一块就调它。
fn note_progress(got: u64, total: Option<u64>, stage: crate::svsep::Stage) {
    DL_BYTES.store(got, Ordering::Relaxed);
    if let Some(t) = total {
        DL_TOTAL.store(t, Ordering::Relaxed);
    }
    DL_STAGE.store(
        if stage == crate::svsep::Stage::Extract {
            1
        } else {
            0
        },
        Ordering::Relaxed,
    );
}

/// 这一次能不能接着下：盘上那半个包**就是这个包的**才算数。
///
/// 判据是盘（`svsep::resume_point` 逐卷核对 `.part.url` 记号），不是内存里的记号
/// —— 进程重启之后内存里什么都没了，而几个 GB 的半个包还在盘上。
/// ⚠️ 记号写着**别的链接**（换了发布点）时这里回 `false`：接上去会拼出坏包，
/// 而要等到解压才炸。
fn resume_for(kind: &str, ext: &std::path::Path) -> bool {
    crate::svsep::resume_point(ext, kind).is_some()
}

/// 这一次运行要用的扩展包根。**命令层一律从这里取**，别自己拼可写目录。
fn ext_dir(st: &super::AppState) -> std::path::PathBuf {
    crate::artifact::ext_of(&st.writable)
}

fn download_state(ext: &std::path::Path) -> Value {
    let active = DL_ACTIVE.load(Ordering::Relaxed) == 1;
    let err = DL_ERROR.lock().ok().and_then(|e| e.clone());
    let kind = DL_KIND.lock().ok().and_then(|k| *k);
    /* 有 `.part` 就说明「下过一半、可以接着下」。界面靠它把按钮文案从
    「下载模型」改成「继续下载模型」。
    ⚠️ **判据是盘上的半个包，不是内存里的记号**：`DL_KIND` 是「此刻在下的包」，
    下载任务一收场就被清成 `None`，答不了「收场之后还能不能续传」；内存记号还会
    随进程一起没了，而盘上那几 GB 的半个包还在。 */
    let paused = ["runtime", "models"]
        .iter()
        .find_map(|k| crate::svsep::resume_point(ext, k).map(|n| (*k, n)));
    let (paused_kind, paused_bytes) = match paused {
        Some((k, n)) => (Some(k), n),
        None => (None, 0),
    };
    let del_active = DEL_ACTIVE.load(Ordering::Relaxed);
    json!({
        "active": active,
        // "runtime" / "models"；没有下载时是 null
        "kind": kind,
        // "download" / "extract"：界面据此把标签换成「正在解压…」，
        // 并在解压期间藏起暂停/停止（那两个按钮对解压无效）
        "stage": if DL_STAGE.load(Ordering::Relaxed) == 1 { "extract" } else { "download" },
        "done": DL_BYTES.load(Ordering::Relaxed) as f64,
        "total": DL_TOTAL.load(Ordering::Relaxed) as f64,
        "error": err,
        // 上次暂停留下的进度：`resumable` 为真时 `done` 就是已下字节数
        "resumable": paused_kind.is_some() && !active,
        // 暂停的是哪个包 + 已经下到哪（界面拿它决定哪一行按钮写「继续下载」）
        "pausedKind": paused_kind,
        "pausedBytes": paused_bytes as f64,
        "delete": {
            "active": del_active,
            "files": DEL_FILES.load(Ordering::Relaxed) as f64,
            "bytes": DEL_BYTES.load(Ordering::Relaxed) as f64,
        },
    })
}

/// 起一个下载任务，立刻返回。两个下载命令共用。
///
/// 下载要跑几分钟到几小时（运行时几 GB），**不能占着调用** —— 回一句
/// 「开始了」，进度由前端轮询 `svsep_status` 的 `download` 拿。
fn spawn_download<F>(kind: &'static str, job: F) -> Result<Value, String>
where
    F: Future<Output = Result<crate::svsep::FetchOutcome, String>> + Send + 'static,
{
    // Atomic CAS closes the check-then-set race: two simultaneous button clicks
    // must not both enter the download section.
    if DL_ACTIVE
        .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        let now = DL_KIND.lock().ok().and_then(|k| *k).unwrap_or("包");
        let now = match now {
            "runtime" => "运行时",
            "models" => "模型",
            "dml" => "显卡加速包",
            _ => "包",
        };
        return Err(format!("{now}正在下载中。想换一个就先暂停或停止它。"));
    }
    if DEL_ACTIVE.load(Ordering::Acquire) {
        DL_ACTIVE.store(0, Ordering::Release);
        return Err("正在删除依赖文件，等它删完再下（删到一半开始下会互相拆台）。".into());
    }
    if let Ok(mut e) = DL_ERROR.lock() {
        *e = None;
    }
    if let Ok(mut k) = DL_KIND.lock() {
        *k = Some(kind);
    }
    DL_PAUSE.store(false, Ordering::Relaxed);
    DL_STOP.store(false, Ordering::Relaxed);
    DL_STAGE.store(0, Ordering::Relaxed);
    DL_ACTIVE.store(1, Ordering::Relaxed);

    tokio::spawn(async move {
        let res = job.await;
        DL_ACTIVE.store(0, Ordering::Relaxed);
        if let Ok(mut k) = DL_KIND.lock() {
            *k = None;
        }
        if let Err(e) = res {
            /* 出错 = 那个 `.part` 不可信，别留着让下次去续。
            ⚠️ 这里只清内存里的记号是**不够**的（判据已经改成看盘了），
            真正删 `.part` 的是 `fetch_bundle`：它把「打不开 / 不是 206」
            这些情况都归到「从 0 开始」，那条分支会把 `.part` 和
            `.part.url` 一起删掉。 */
            if let Ok(mut slot) = DL_ERROR.lock() {
                *slot = Some(e);
            }
        }
    });

    Ok(json!({ "started": true }))
}

/* ══════════════════════════════ 状态 / 起停 ══════════════════════════════ */

/// 分离服务 / 运行时 / 模型 / 下载的整体状态（前端每 2 秒轮它）。
#[tauri::command]
pub async fn svsep_status(st: super::St<'_>) -> Cmd {
    let s = &st.inner().svsep;
    let ext = ext_dir(st.inner());
    let running = s.probe().await;
    Ok(json!({
        "runtimeReady": s.runtime_ready(),
        "dir": s.dir().to_string_lossy(),
        "modelsDir": s.models().to_string_lossy(),
        "dataDir": s.data().to_string_lossy(),
        "outputsDir": s.outputs().to_string_lossy(),
        // 扩展包根：界面上「这些 GB 都下到哪儿去了」要有个地方说
        "extDir": crate::platform::clean_path(&ext),
        "runtime": crate::svsep::runtime_status(&ext),
        "models": crate::svsep::models_status(&ext),
        "dml": {
            /* 显卡加速包（A 卡 / Intel 核显用的 DirectML）。
               `installed` = 包装没装；`active` = 那份 ORT 是不是真的排在
               `site-packages` 前面（见 `svsep::set_dml_active`）。
               `nvidia` 给界面用来解释「为什么自动模式没开」。 */
            "installed": crate::svsep::dml_installed(&ext),
            "active": crate::svsep::dml_active(&ext),
            "nvidia": crate::svsep::nvidia_present(),
            "dir": crate::platform::clean_path(&crate::svsep::dml_site_dir(&ext)),
            "zipBytes": crate::svsep::DML_BYTES,
            /* 盘上有没有手放的加速包（`.whl`）—— 有就把这一步的按钮写成「解压」 */
            "manual": crate::svsep::manual_dml_files(&ext),
        },
        "download": download_state(&ext),
        "running": running,
        "port": s.port_hint(),
        "baseUrl": s.base_url(),
        "lastError": s.last_error(),
    }))
}

/// 起分离服务。已经起着就原样回（`started: false`）。
#[tauri::command]
pub async fn svsep_start(st: super::St<'_>) -> Cmd {
    require_local_engine()?;
    let (port, started) = st.inner().svsep.start().await.map_err(|e| e.to_string())?;
    let status = st
        .inner()
        .svsep
        .get("/api/status")
        .await
        .unwrap_or(json!({}));
    Ok(json!({
        "running": true,
        "started": started,
        "port": port,
        "baseUrl": st.inner().svsep.base_url(),
        "backend": status,
    }))
}

/// 停分离服务。幂等 —— 重复调用无害。
#[tauri::command]
pub async fn svsep_stop(st: super::St<'_>) -> Cmd {
    st.inner().svsep.stop();
    Ok(json!({ "running": false }))
}

/* ══════════════════════════════ 下载 ══════════════════════════════ */

/// 下模型（压缩包 462 MB，解压后 730 MB）。
///
/// 上次是**暂停**在这里的（同一个包、同一条链接）就带着 `Range` 接着下；
/// 换了包、或者上次是出错/停止结束的，就从头下（`fetch_bundle` 会把无效的
/// `.part` 删掉）。
#[tauri::command]
pub async fn svsep_models_download(st: super::St<'_>) -> Cmd {
    let ext = ext_dir(st.inner());
    let resume = resume_for("models", &ext);
    spawn_download("models", async move {
        let ctl = crate::svsep::DownloadCtl::new(&DL_PAUSE, &DL_STOP, resume);
        // ⚠️ 链接传空串 = 用表里那一条（`MODEL_PARTS`）。要整批顶掉发布点就设
        //    `VSS_MODULES_BASE`，别在这儿写死一个地址。
        let out = crate::svsep::download_models(&ext, "", &ctl, note_progress).await;
        // 暂停了就留着记号（下次接着下要用）；下完 / 停止 / 出错都不用留。
        // ⚠️ 「下完」到底是哪一种要现查 —— `ctl.paused()` 只有暂停为真，但它
        //    分不出 Done 与 Cancelled，所以这里再问一次盘上的 `.part` 还在不在。
        if crate::svsep::resume_point(&ext, "models").is_none() {
            crate::svsep::clear_resume_marker(&ext, "models");
        }
        out
    })
}

/// 下运行时（几 GB，只该下一次）。
///
/// ⚠️ 它解到 [`crate::svsep::runtime_base`]，也就是**扩展包根下的 `svsep/`**：
///  · 默认（`extDir` 没配置）= 可写目录（绿色版 `<root>/data`、安装版 `%APPDATA%`）——
///    安装版绝不能往 `Program Files` 解 7.4 GB，那里只读；
///  · 用户在界面上选过就听用户的（C 盘紧张的人把这几 GB 放 D 盘）。
/// `python.exe` 与 `backend/` 必须待在一起，所以它俩跟着一起走。
#[tauri::command]
pub async fn svsep_runtime_download(st: super::St<'_>) -> Cmd {
    require_local_engine()?;
    let ext = ext_dir(st.inner());
    let resume = resume_for("runtime", &ext);
    let ext2 = ext.clone();
    spawn_download("runtime", async move {
        let ctl = crate::svsep::DownloadCtl::new(&DL_PAUSE, &DL_STOP, resume);
        let out = crate::svsep::download_runtime(&ext2, &ctl, note_progress).await;
        if crate::svsep::resume_point(&ext2, "runtime").is_none() {
            crate::svsep::clear_resume_marker(&ext2, "runtime");
        }
        out
    })
}

/* ══════════════════════════ 扩展包目录（用户可选） ══════════════════════════ */

/// 目录能不能真写进去。
///
/// 只 `create_dir_all` 不够：只读盘、受控文件夹都能把空目录建出来，
/// 写第一个文件时才 Access Denied —— 而那已经是解压到一半之后了。
fn writable_probe(dir: &std::path::Path) -> Result<(), String> {
    std::fs::create_dir_all(dir)
        .map_err(|e| format!("建目录失败（{}）：{e}", dir.to_string_lossy()))?;
    let probe = dir.join(".vss-write-probe");
    std::fs::write(&probe, b"ok")
        .map_err(|e| format!("这个目录写不进去（{}）：{e}", dir.to_string_lossy()))?;
    let _ = std::fs::remove_file(&probe);
    Ok(())
}

/// 扩展包目录的现状。
///
/// 界面拿它回答两个问题：「这些 GB 现在落在哪」与「默认会落在哪（以及那块盘还剩多少）」。
fn ext_dir_info(st: &super::AppState) -> Value {
    let active = ext_dir(st);
    let default = st.writable.clone();
    json!({
        "dir": crate::platform::clean_path(&active),
        // 用户没选过 = 正在用可写目录（界面的「默认位置」就是这个意思）
        "isDefault": active == default,
        "defaultDir": crate::platform::clean_path(&default),
        /* 安装版的可写目录在 `%APPDATA%`（C 盘），而扩展包合计约 8 GB ——
           界面据此提醒一句「C 盘紧张就把它们放到别的盘」。 */
        "installed": st.installed,
        "hasRuntime": crate::svsep::runtime_ready(&active),
        /* 换过目录之后老位置可能**还留着一整份 7 GB**（我们不搬文件，见 `ext_set_dir`）。
           给界面一个「原位置还有一份」的提示，删不删用户自己定。 */
        "legacyDir": st
            .config_snapshot()
            .get("extDir")
            .and_then(Value::as_str)
            .filter(|s| !s.trim().is_empty() && std::path::Path::new(s.trim()) != active)
            .map(|s| crate::platform::clean_path(std::path::Path::new(s.trim()))),
    })
}

/// 问：扩展包装在哪、默认会装到哪。
#[tauri::command]
pub async fn ext_dir_get(st_: super::St<'_>) -> Cmd {
    Ok(ext_dir_info(&st_))
}

/// 换一个扩展包目录。
///
/// **只改配置 + 立刻生效，不搬文件** —— 8 GB 搬到一半失败比不动更糟：用户会得到
/// 一个「两处各有一半」的状态，而界面还得去猜哪一份算数。原位置里那份原地留着，
/// `ext_dir_info().legacyDir` 会告诉界面它在哪。
///
/// `dir` 传空串 = 回到默认（可写目录）。
#[tauri::command]
pub async fn ext_dir_set(st_: super::St<'_>, dir: String) -> Cmd {
    if DL_ACTIVE.load(Ordering::Relaxed) == 1 {
        return Err("正在下载，先暂停或停止再换目录".into());
    }
    if DEL_ACTIVE.load(Ordering::Relaxed) {
        return Err("正在删除依赖，等它删完".into());
    }
    if st_.inner().svsep.probe().await {
        return Err("分离服务正跑着，先停掉再换目录".into());
    }
    let raw = dir.trim().to_string();
    if !raw.is_empty() {
        writable_probe(std::path::Path::new(&raw))?;
    }
    let mut cfg = st_.config_snapshot();
    let Some(map) = cfg.as_object_mut() else {
        return Err("配置文件坏了（不是一个 JSON 对象）".into());
    };
    map.insert("extDir".to_string(), json!(raw));
    /* ⚠️ `svsepRuntimeDir` 一并落到同一个值：它是老键，启动时**优先于** `extDir`
    （见 `AppState::new`），留着旧值会让「刚换的目录」下次启动又跳回去。 */
    map.insert("svsepRuntimeDir".to_string(), json!(raw));
    super::config_file::save_config(&st_.writable, &cfg)
        .map_err(|e| format!("保存配置失败：{e}"))?;
    if let Ok(mut g) = st_.config.lock() {
        *g = cfg;
    }
    crate::artifact::init_ext_base(&raw);
    let active = ext_dir(st_.inner());
    /* ⚠️ 扩展包目录一换，`svsep/` 下面就没有随包分发的 `backend/` 与 `bin/` 了
    （它们不随 zip 下载），所以这里立刻补一份过去。 */
    let staged = crate::svsep::stage_runtime_assets(&st_.root.join("data").join("svsep"), &active);
    crate::log_line(&format!(
        "扩展包目录改成：{}（补进 {staged} 个随包文件）",
        crate::platform::clean_path(&active)
    ));
    Ok(ext_dir_info(&st_))
}

/* ══════════════════════ 显卡加速（DirectML：A 卡 / 核显） ══════════════════════ */

/// 下显卡加速包（24 MB）并让它生效。
///
/// ⚠️ 它和「运行时 / 模型」**不是同一套下载机制**：那两个是几 GB、支持续传的
/// 大包（走 `DL_*` 那套状态机），这个是 24 MB 的一次性文件，走 `fetch_to_file`
/// 自己的五轮重试就够。所以它**不抢** `DL_ACTIVE`，界面也不该拿它当大包显示。
#[tauri::command]
pub async fn svsep_dml_download(st: super::St<'_>) -> Cmd {
    require_local_engine()?;
    start_dml_download(st.inner())
}

/// 下加速包（24 MB）的**唯一入口**。
///
/// 两个地方用它：用户在「安装扩展包」的链条里走到那一步，以及选了 GPU 推理时的
/// 自动补装（见 `svsep_set_inference`）。回包是「开始了」，不是「下完了」。
fn start_dml_download(st: &Arc<super::AppState>) -> Result<Value, String> {
    require_local_engine()?;
    // DML uses the same download slot, so reserve it atomically as well.
    if DL_ACTIVE
        .compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire)
        .is_err()
    {
        let now = DL_KIND.lock().ok().and_then(|k| *k).unwrap_or("包");
        return Err(format!("{now}正在下载中，等它下完再下加速包。"));
    }
    if DEL_ACTIVE.load(Ordering::Acquire) {
        DL_ACTIVE.store(0, Ordering::Release);
        return Err("正在删除依赖文件，等它删完再下".into());
    }
    let ext = ext_dir(st);
    if let Ok(mut k) = DL_KIND.lock() {
        *k = Some("dml");
    }
    if let Ok(mut e) = DL_ERROR.lock() {
        *e = None;
    }
    DL_PAUSE.store(false, Ordering::Relaxed);
    DL_STOP.store(false, Ordering::Relaxed);
    DL_STAGE.store(0, Ordering::Relaxed);
    DL_BYTES.store(0, Ordering::Relaxed);
    DL_TOTAL.store(0, Ordering::Relaxed);
    /* 它走的是 `download_dml` 而不是 `fetch_bundle`（24 MB、不支持续传），
    所以 `spawn_download` 那个「返回值必须是 FetchOutcome」的签名套不上，
    这里自己收尾 —— 但**进度仍然写同一组 `DL_*`**，界面不用学第二套。 */
    tokio::spawn(async move {
        let ctl = crate::svsep::DownloadCtl::new(&DL_PAUSE, &DL_STOP, false);
        let res = crate::svsep::download_dml(&ext, &ctl, note_progress).await;
        if res.is_ok() {
            crate::svsep::apply_infer_mode(&ext);
        }
        DL_ACTIVE.store(0, Ordering::Relaxed);
        if let Ok(mut k) = DL_KIND.lock() {
            *k = None;
        }
        if let Err(e) = res
            && let Ok(mut slot) = DL_ERROR.lock()
        {
            *slot = Some(e);
        }
    });
    Ok(json!({ "started": true }))
}

/// 暂停下载：`.part` 留着，下次点「继续下载」带 Range 接着下。
#[tauri::command]
pub async fn svsep_download_pause() -> Cmd {
    if DL_ACTIVE.load(Ordering::Relaxed) != 1 {
        return Err("现在没有在下载".into());
    }
    DL_PAUSE.store(true, Ordering::Relaxed);
    Ok(json!({ "pausing": true }))
}

/// 停止下载：`.part` 也删掉，下次从头下。
#[tauri::command]
pub async fn svsep_download_stop() -> Cmd {
    if DL_ACTIVE.load(Ordering::Relaxed) != 1 {
        return Err("现在没有在下载".into());
    }
    DL_STOP.store(true, Ordering::Relaxed);
    Ok(json!({ "stopping": true }))
}

/// 一键删掉下下来的模型与运行时（**下完的、没下完的都删**）。
///
/// ⚠️ 删运行时等于「下次要重新下 4.7 GB」，所以前端必须让用户确认过。
/// ⚠️ 不删 `backend/`：那几个 .py 随程序打包，不属于「依赖」，删了就得重装。
#[tauri::command]
pub async fn svsep_deps_delete(st: super::St<'_>) -> Cmd {
    if DL_ACTIVE.load(Ordering::Relaxed) == 1 {
        return Err("正在下载，先暂停或停止再删（边下边删只会留下一堆半截文件）。".into());
    }
    if DEL_ACTIVE.swap(true, Ordering::Relaxed) {
        return Err("正在删除中，等它删完".into());
    }
    if st.inner().svsep.probe().await {
        // 引擎正跑着就删运行时 = 删正在运行的 python.exe（必然一批文件删不掉）。
        // 先停服务；真停不掉也不硬来，删不掉的会照实报给用户。
        st.inner().svsep.stop();
    }

    let writable = st.inner().svsep.writable().to_path_buf();
    DEL_BYTES.store(0, Ordering::Relaxed);
    DEL_FILES.store(0, Ordering::Relaxed);
    DEL_STOP.store(false, Ordering::Relaxed);

    tokio::spawn(async move {
        // 几万个文件，纯阻塞 IO，丢给阻塞线程池；`DEL_STOP` 是「别删了」的开关
        // （取消删除走 `svsep_deps_delete_stop`，借下载那个 flag 是翻不动的）。
        let res = tokio::task::spawn_blocking(move || {
            crate::svsep::delete_dependencies(
                &writable,
                || DEL_STOP.load(Ordering::Relaxed),
                |files, bytes| {
                    DEL_FILES.store(files, Ordering::Relaxed);
                    DEL_BYTES.store(bytes, Ordering::Relaxed);
                },
            )
        })
        .await;
        DEL_ACTIVE.store(false, Ordering::Relaxed);
        DEL_STOP.store(false, Ordering::Relaxed);
        match res {
            Ok(v) => {
                if let Ok(mut slot) = DL_ERROR.lock() {
                    *slot = None;
                }
                // 删除结果也放这儿让前端弹一句（真正的落盘状态下次轮询 status 就有了）
                if let Some(msg) = v.get("removedFiles") {
                    crate::log_line(&format!(
                        "音轨分离：已删除依赖文件 {} 个 / {} 字节",
                        msg,
                        v.get("removedBytes").and_then(|b| b.as_u64()).unwrap_or(0)
                    ));
                }
            }
            Err(e) => {
                if let Ok(mut slot) = DL_ERROR.lock() {
                    *slot = Some(format!("删除依赖失败：{e}"));
                }
            }
        }
    });

    Ok(json!({ "started": true }))
}

/// 取消正在跑的「删除全部依赖」。已经删掉的文件不复原，只是不再往下删。
#[tauri::command]
pub async fn svsep_deps_delete_stop() -> Cmd {
    if !DEL_ACTIVE.load(Ordering::Relaxed) {
        return Err("现在没有在删除".into());
    }
    DEL_STOP.store(true, Ordering::Relaxed);
    Ok(json!({ "stopping": true }))
}

/* ══════════════════════════════ 分离任务 ══════════════════════════════ */

/// multipart 的 boundary 每次换一个（进程内自增就够 —— body 只在本进程里拼）。
static NEXT_BOUNDARY: AtomicU64 = AtomicU64::new(1);

/// 交给上游的**文件名**：ASCII 词干 + 原扩展名。
///
/// 为什么不用中文原名：multipart 头里的非 ASCII 要靠 RFC 2231 才规范，而上游
/// `secure_filename()` 本来就会把非 ASCII 剥成 `upload` —— 真正被它用到的只有
/// **扩展名**（`ALLOWED_EXTENSIONS` 白名单 + 引擎按后缀判格式）。原名另有地方记
/// （任务记录里的 `original_name`）。
///
/// 没有扩展名时兜一个 `wav`：上游对无后缀的文件一律 400，给个能过白名单的后缀
/// 至少让它走到「解码失败」那条正常错误上。
fn upload_filename(path: &std::path::Path) -> String {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_ascii_lowercase())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "wav".to_string());
    let stem: String = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let stem = stem.trim_matches('_');
    let stem = if stem.is_empty() { "audio" } else { stem };
    format!("{stem}.{ext}")
}

/// 拼一个只有 `file` 一个字段的 multipart 体（CRLF 一个都不能少）。
fn multipart_body(boundary: &str, filename: &str, content_type: &str, bytes: &[u8]) -> Vec<u8> {
    let head = format!(
        "--{boundary}\r\n\
         Content-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\n\
         Content-Type: {content_type}\r\n\r\n"
    );
    let mut body = Vec::with_capacity(bytes.len() + head.len() + boundary.len() + 16);
    body.extend_from_slice(head.as_bytes());
    body.extend_from_slice(bytes);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    body
}

/// 提交一次分离 —— **收本机路径，不收字节**。
///
/// Python 服务要的本来就是**一个文件**，所以读盘与转发都在 Rust 这一侧。
///
/// `engine`：`"uvr"`（二轨：人声 / 伴奏）或 `"roformer"`（六轨）。默认 roformer。
///
/// 内部：服务没起就先起（用户点「开始分离」时它通常还没起来）。
#[tauri::command]
pub async fn svsep_separate(st: super::St<'_>, path: String, engine: Option<String>) -> Cmd {
    require_local_engine()?;
    let engine = engine.unwrap_or_else(|| "roformer".into());
    let p = std::path::Path::new(&path);
    if !p.is_file() {
        return Err(format!("音频文件不存在：{path}"));
    }
    let bytes = tokio::fs::read(p)
        .await
        .map_err(|e| format!("读音频失败：{e}"))?;
    if bytes.is_empty() {
        return Err("音频文件是空的".into());
    }
    // Content-Type 仍然要算出来给上游：Python 那边的 multipart 解析按它判类型。
    // 按扩展名映射就够（上游只认 audio 那几种）。
    let ct = match p
        .extension()
        .and_then(|e| e.to_str())
        .map(|s| s.to_lowercase())
        .as_deref()
    {
        Some("wav") => "audio/wav",
        Some("mp3") => "audio/mpeg",
        Some("flac") => "audio/flac",
        Some("m4a") | Some("aac") => "audio/mp4",
        Some("ogg") | Some("opus") => "audio/ogg",
        Some("wma") => "audio/x-ms-wma",
        _ => "application/octet-stream",
    };

    /* ⚠️ **必须拼成 multipart/form-data，不能把裸字节 POST 过去。**
    上游 Flask 的 `_submit_separation()` 读的是 `request.files["file"]` ——
    裸字节（哪怕 content-type 写对了）在它眼里就是「没有文件」，直接
    `400 {"ok":false,"error":"未检测到上传文件"}`。`filename` 也必须带**对的
    扩展名**：上游要拿后缀去 `ALLOWED_EXTENSIONS` 白名单里对，对不上同样是 400。 */
    let boundary = format!(
        "----VSynthStudioBoundary{}",
        NEXT_BOUNDARY.fetch_add(1, Ordering::Relaxed)
    );
    let body = multipart_body(&boundary, &upload_filename(p), ct, &bytes);

    if !st.inner().svsep.probe().await {
        // 顺手把它起起来 —— 用户点「开始分离」时服务通常还没起
        st.inner().svsep.start().await.map_err(|e| e.to_string())?;
    }

    let mut out = st
        .inner()
        .svsep
        .submit(
            &engine,
            body,
            &format!("multipart/form-data; boundary={boundary}"),
        )
        .await
        .map_err(|e| e.to_string())?;
    // 任务对象捋平：前端拿 `res.task` 直接当任务记录用，而它读的是 `task.id` ——
    // 上游发的是 `task_id`、还包在 `task` 里。
    if let Some(o) = out.as_object_mut()
        && o.contains_key("task")
    {
        let t = flat_task(o.get("task").cloned().unwrap_or(Value::Null));
        o.insert("task".to_string(), t);
    }
    Ok(out)
}

/// 查一个分离任务。
#[tauri::command]
pub async fn svsep_task(st: super::St<'_>, id: String) -> Cmd {
    /* 服务已经自动关了（任务跑完就关，见 `auto_stop_when_idle`）：这时 `get()` 只会
    回「分离服务还没启动」，可界面要的恰恰是最后那道 `done` —— 先看快照。 */
    if !st.inner().svsep.probe().await
        && let Some(t) = recall_task(&id)
    {
        return Ok(t);
    }
    let v = st
        .inner()
        .svsep
        .get(&format!("/api/status/{id}"))
        .await
        .map_err(|e| e.to_string())?;
    let t = flat_task(v);
    /* 任务结束了就把服务关掉 —— 用户不用记着点「停止服务」，也不用白占 5 GB 内存。
    隔一会儿、并且确认队列空了才真关（见 `auto_stop_when_idle`）。 */
    if matches!(
        t.get("status").and_then(Value::as_str),
        Some("done") | Some("failed") | Some("cancelled")
    ) {
        remember_task(&id, &t);
        tokio::spawn(auto_stop_when_idle(st.inner().clone()));
    }
    Ok(t)
}

/// 取消一个分离任务。
#[tauri::command]
pub async fn svsep_cancel(st: super::St<'_>, id: String) -> Cmd {
    st.inner()
        .svsep
        .post_json(&format!("/api/cancel/{id}"), &json!({}))
        .await
        .map_err(|e| e.to_string())
}

/// 打开输出目录（或在资源管理器里定位某个产物）。
#[tauri::command]
pub async fn svsep_open_output(st: super::St<'_>, args: Option<Value>) -> Cmd {
    let body = args.unwrap_or_else(|| json!({}));
    st.inner()
        .svsep
        .post_json("/api/open-output", &body)
        .await
        .map_err(|e| e.to_string())
}

/// 分离服务的原始状态（`/api/status`）—— 页面上「设备 / 队列 / 输出目录」那一条用。
#[tauri::command]
pub async fn svsep_backend_status(st: super::St<'_>) -> Cmd {
    st.inner()
        .svsep
        .get("/api/status")
        .await
        .map_err(|e| e.to_string())
}

/* ══════════════════════════════ 推理方式 ══════════════════════════════ */

/// 推理方式：自动 / GPU / CPU。
///
/// 服务在跑就问它（它会顺手探一下硬件，给出 `badge` / `detail`）；**服务没跑
/// 就读盘**上的 `inference_settings.json` —— 任务一结束服务就自动关了
/// （`auto_stop_when_idle`），可这个设置项在界面上得一直看得见、改得动。
///
/// ⚠️ 回包里的 `mode` **一律换成用户选的那个**（不是交给引擎的那个）：自动档在有
/// N 卡时会以 `gpu` 交给引擎（见 `engine_mode`），照上游的回包写会把界面从「自动」
/// 翻成「GPU」—— 用户没动过设置，按钮自己跳了。
#[tauri::command]
pub async fn svsep_inference_get(st: super::St<'_>) -> Cmd {
    let user = crate::svsep::read_infer_mode(&st.inner().svsep.data());
    if st.inner().svsep.probe().await
        && let Ok(v) = st.inner().svsep.get("/api/inference-settings").await
    {
        return Ok(stamp_user_mode(v, &user));
    }
    Ok(infer_reply(&user, true))
}

/// 设置推理方式。`{ mode: "auto" | "cpu" | "gpu" }`
///
/// 三件事一起做，顺序不能换：写盘（服务没起来时下次启动读它）→ 落到运行时上
/// （加速包该开该关，见 `crate::svsep::apply_infer_mode`）→ 告诉正在跑的服务
/// （它把 mode 缓存在进程内存里，光改文件它不认）。
#[tauri::command]
pub async fn svsep_set_inference(st: super::St<'_>, mode: String) -> Cmd {
    /* 认不出的值在这里就回错，别悄悄当 `auto` —— 这条命令只有界面在调，收到怪值
    说明前端或调用方写错了，静默兜底会把这种错藏起来。 */
    let raw = mode.trim().to_ascii_lowercase();
    if !["auto", "cpu", "gpu"].contains(&raw.as_str()) {
        return Err(format!("无效模式：{mode}（只能是 auto / cpu / gpu）"));
    }
    let mode = crate::svsep::normalize_infer_mode(&raw);
    let ext = ext_dir(st.inner());
    crate::svsep::write_infer_mode(&ext, &mode)?;
    crate::svsep::apply_infer_mode(&ext);

    /* 选了 GPU 但加速包还没下（A 卡 / 核显）→ 顺手开始下：24 MB，界面上有现成的
    进度条（`dl.kind == "dml"`）。N 卡不需要它（那份 CUDA 在运行时里）。
    ⚠️ 失败不阻断：设置已经存下来了，下不动只是这次没生效。 */
    let mut dml_downloading = false;
    if mode == "gpu" && !crate::svsep::nvidia_present() && !crate::svsep::dml_installed(&ext) {
        dml_downloading = start_dml_download(st.inner()).is_ok();
    }

    if st.inner().svsep.probe().await
        && let Ok(v) = st
            .inner()
            .svsep
            .post_json(
                "/api/inference-settings",
                &json!({ "mode": engine_mode(&mode) }),
            )
            .await
    {
        return Ok(with_dml_flag(stamp_user_mode(v, &mode), dml_downloading));
    }
    Ok(with_dml_flag(infer_reply(&mode, true), dml_downloading))
}

/// 交给引擎的那个 mode。
///
/// ⚠️ **自动档 + 有 N 卡 = `gpu`**：上游 `resolve_plan()` 的自动分支要求
/// `onnx_cuda` 为真才走 CUDA，而「torch 认得 CUDA、onnxruntime 没暴露 CUDA provider」
/// 时它会一路落到最底下的 CPU（两个 `elif` 都带 `not torch_cuda`）—— 而 N 卡用户的
/// 「自动」意图显然是走 GPU。`gpu` 分支还会在真不可用时给出能照做的提示
/// （装 CUDA 运行库 / 装 DirectML），比静悄悄用 CPU 强。
///
/// A 卡不动：那边自动档本来就靠 `hw.mode == "dml"` 生效，而 DML 由
/// `apply_infer_mode` 挂上（装了包就挂）。
fn engine_mode(user: &str) -> &'static str {
    match user {
        "cpu" => "cpu",
        "gpu" => "gpu",
        _ => {
            if crate::svsep::nvidia_present() {
                "gpu"
            } else {
                "auto"
            }
        }
    }
}

/// 把上游回包里的 `mode` 换回用户选的那个（其余字段原样透传）。
fn stamp_user_mode(mut v: Value, user: &str) -> Value {
    if let Some(o) = v.as_object_mut() {
        o.insert("mode".into(), json!(user));
    }
    v
}

/// 标一下「加速包正在下」——界面据此把进度条挂到下载状态上。
fn with_dml_flag(mut v: Value, downloading: bool) -> Value {
    if downloading && let Some(o) = v.as_object_mut() {
        o.insert("dmlDownloading".into(), json!(true));
    }
    v
}

/* ══════════════════════════════ 小工具 ══════════════════════════════ */

/// 服务已经不在了（任务跑完自动关的）：把终态快照掏出来答。
///
/// 放在 `svsep_task` 的最前面 —— 没服务的时候 `get()` 只会回「分离服务还没启动」，
/// 而这时候界面要的恰恰是最后那道 `done` 与那几轨的名字。
fn recall_task(id: &str) -> Option<Value> {
    DONE_TASKS
        .lock()
        .ok()
        .and_then(|all| all.iter().find(|(k, _)| k == id).map(|(_, v)| v.clone()))
}

fn remember_task(id: &str, t: &Value) {
    let Ok(mut all) = DONE_TASKS.lock() else {
        return;
    };
    all.retain(|(k, _)| k != id);
    all.insert(0, (id.to_string(), t.clone()));
    all.truncate(KEEP_TASKS);
}

/// 把上游的任务对象捋平。
///
/// 上游 `GET /api/status/<id>` 回的是 `{"ok":true,"task":{…}}`，而且里面的任务
/// id 叫 `task_id`；前端按**扁平 + `id`** 读。原样透传的话前端第一轮轮询拿到的
/// 是外壳对象，`task.id` 变 undefined，任务轮询自己停掉 —— 界面永远停在提交那一刻。
fn flat_task(v: Value) -> Value {
    let mut t = if v.get("task").map(Value::is_object).unwrap_or(false) {
        v.get("task").cloned().unwrap_or(Value::Null)
    } else {
        v
    };
    if let Some(o) = t.as_object_mut()
        && let Some(id) = o.get("task_id").cloned()
    {
        o.entry("id").or_insert(id);
    }
    t
}

/// 后端还有活没干完吗（排队中或正在算）。
///
/// 判据是上游 `/api/status` 里的 `queues.{uvr,roformer}.{waiting,processing}`。
/// **读不懂就当成「有活」** —— 宁可不关服务，也不能把用户刚排上的任务连锅端。
fn queues_busy(status: &Value) -> bool {
    let Some(q) = status.get("queues").and_then(Value::as_object) else {
        return true;
    };
    q.values().any(|e| {
        ["waiting", "processing"]
            .iter()
            .any(|k| e.get(*k).and_then(Value::as_u64).unwrap_or(0) > 0)
    })
}

/// 任务结束了 → 队列也空了 → 把分离服务关掉。
///
/// 隔 1.5 秒再看一眼：用户可能正好在这时又提交了一个文件，那个任务还在排队
/// （`queues_busy` 会拦住）。`stop()` 是幂等的，重复调用无害。
async fn auto_stop_when_idle(st: Arc<super::AppState>) {
    tokio::time::sleep(std::time::Duration::from_millis(1500)).await;
    let Ok(v) = st.svsep.get("/api/status").await else {
        return;
    };
    if queues_busy(&v) {
        return;
    }
    crate::log_line("音轨分离：任务结束，自动关掉分离服务");
    st.svsep.stop();
}

// 推理方式的读写全在 `crate::svsep`（`read_infer_mode` / `write_infer_mode` /
// `apply_infer_mode`）—— 启动路径（`ipc/state.rs`）也要用同一份，放在这一层
// 它就得被 import 两次，判据也会分叉。

/// 服务没跑时给界面的回包 —— 键跟上游 `public_settings()` 对得上，`offline`
/// 让界面知道这不是现探的硬件。
fn infer_reply(mode: &str, offline: bool) -> Value {
    json!({
        "mode": mode,
        "effective_mode": mode,
        "badge": infer_badge(mode),
        "detail": if offline { "分离服务没在跑，这是盘上的设置；开始分离时按它来。" } else { "" },
        "offline": offline,
    })
}

fn infer_badge(mode: &str) -> &'static str {
    match mode {
        "cpu" => "CPU（下次分离生效）",
        "gpu" => "GPU（下次分离生效）",
        _ => "自动（下次分离生效）",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_task_envelope_is_flattened_and_task_id_becomes_id() {
        let t = flat_task(json!({
            "ok": true,
            "task": { "task_id": "abc", "status": "processing", "progress": 42 },
        }));
        assert_eq!(t.get("id").and_then(Value::as_str), Some("abc"));
        assert_eq!(t.get("progress").and_then(Value::as_u64), Some(42));
        assert!(t.get("task").is_none() || t.get("task").map(Value::is_object) != Some(true));

        // 上游哪天改成扁平的了也不能坏
        let flat = flat_task(json!({ "task_id": "x", "status": "done" }));
        assert_eq!(flat.get("id").and_then(Value::as_str), Some("x"));
        assert_eq!(flat.get("status").and_then(Value::as_str), Some("done"));
    }

    #[test]
    fn an_empty_queue_is_idle_but_an_unreadable_one_is_busy() {
        let idle = json!({ "queues": {
            "uvr": { "waiting": 0, "processing": 0 },
            "roformer": { "waiting": 0, "processing": 0 },
        }});
        assert!(!queues_busy(&idle));

        let queued = json!({ "queues": { "roformer": { "waiting": 1, "processing": 0 } }});
        assert!(queues_busy(&queued));
        let running = json!({ "queues": { "uvr": { "waiting": 0, "processing": 1 } }});
        assert!(queues_busy(&running));

        // 读不懂就当有活 —— 不能因为看不懂就把服务关了
        assert!(queues_busy(&json!({})));
        assert!(queues_busy(&json!({ "queues": "?" })));
    }

    #[test]
    fn inference_mode_falls_back_to_auto() {
        use crate::svsep::normalize_infer_mode;
        assert_eq!(normalize_infer_mode("GPU"), "gpu");
        assert_eq!(normalize_infer_mode(" cpu "), "cpu");
        assert_eq!(normalize_infer_mode("cuda"), "auto");
        assert_eq!(normalize_infer_mode(""), "auto");
        assert!(infer_badge("gpu").starts_with("GPU"));
    }

    #[test]
    fn a_finished_task_stays_answerable_after_the_service_is_gone() {
        // 服务停掉以后界面还得靠这道 `done` 才显示那几轨，所以终态要能再掏出来
        let done = json!({ "id": "t1", "status": "done", "outputs": [{ "filename": "a.wav" }] });
        remember_task("t1", &done);
        assert_eq!(
            recall_task("t1").and_then(|v| v.get("status").cloned()),
            Some(json!("done"))
        );
        assert!(recall_task("nope").is_none());

        // 同 id 再记一次只留一份（不然轮询几次就攒一摞）
        remember_task("t1", &done);
        assert_eq!(
            DONE_TASKS
                .lock()
                .unwrap()
                .iter()
                .filter(|(k, _)| k == "t1")
                .count(),
            1
        );

        // 只留最近 KEEP_TASKS 个，新的在前
        for i in 0..KEEP_TASKS + 3 {
            remember_task(&format!("old{i}"), &json!({ "status": "done" }));
        }
        let all = DONE_TASKS.lock().unwrap();
        assert!(all.len() <= KEEP_TASKS);
        assert!(all.iter().any(|(k, _)| k == "old10"));
        assert!(!all.iter().any(|(k, _)| k == "t1"));
    }

    /// 上游要 multipart（`request.files["file"]`），裸字节会回 400。
    #[test]
    fn the_body_is_multipart_with_a_file_field_and_a_usable_filename() {
        let body = multipart_body("BOUND", "song.wav", "audio/wav", b"RIFFdata");
        let text = String::from_utf8_lossy(&body).to_string();
        assert!(text.starts_with("--BOUND\r\n"));
        assert!(
            text.contains(
                "Content-Disposition: form-data; name=\"file\"; filename=\"song.wav\"\r\n"
            )
        );
        assert!(text.contains("Content-Type: audio/wav\r\n\r\n"));
        assert!(text.contains("RIFFdata"));
        assert!(text.ends_with("\r\n--BOUND--\r\n"));
        // 裸字节的判据：整段里必须既有边界也有音频本体
        assert!(body.len() > 8);
    }

    #[test]
    fn upload_filename_keeps_the_extension_and_stays_ascii() {
        use std::path::Path;
        /* 判据只写**上游真正会用到**的三件事：ASCII、后缀在 `ALLOWED_EXTENSIONS` 里、
        词干非空。具体的中文被换成什么字符不重要（上游 `secure_filename` 还会再洗一遍）。 */
        for (input, want_ext) in [
            (r"D:\歌\晴天 最终版.WAV", "wav"),
            ("/tmp/a-b_c.mp3", "mp3"),
            ("/tmp/无题", "wav"), // 没有扩展名 → 兜一个能过白名单的
            ("/tmp/.wav", "wav"),
            ("/tmp/整首歌.flac", "flac"),
        ] {
            let got = upload_filename(Path::new(input));
            assert!(got.is_ascii(), "{input} → {got} 里还有非 ASCII");
            assert_eq!(
                got.rsplit_once('.').map(|(_, e)| e),
                Some(want_ext),
                "{input} → {got}"
            );
            let stem = got.rsplit_once('.').map(|(s, _)| s).unwrap_or("");
            assert!(
                !stem.trim_matches('_').is_empty(),
                "{input} → {got} 词干是空的"
            );
        }
        // 全是中文字符时退回 audio，而不是一串下划线
        assert_eq!(upload_filename(Path::new("/tmp/无题.wav")), "audio.wav");
    }
}
