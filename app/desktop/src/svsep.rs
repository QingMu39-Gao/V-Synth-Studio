//! 离线音轨分离 —— 内嵌的 Python 分离引擎
//!
//! 我们把「炽小阳音轨分离站离线版」的 Python 后端原样收进来，只换掉它的前端：
//! 界面由本工作站的 React 页面负责，Python 那边**只当 JSON API 用**
//! （它的 `templates/` 与 `static/` 在入库时就没搬过来，见 `tools/svsep-stage.ps1`）。
//!
//! ## 磁盘布局
//!
//! ```text
//! <root>/app/data/svsep/          运行时（随包分发，只读）
//!   ├─ runtime/python.exe         Python 3.10 embeddable
//!   ├─ backend/                   分离后端（app.py 等）
//!   └─ bin/ffmpeg.exe
//! <可写目录>/svsep/models/         模型（**不随包发**，用户按需下载）
//!   ├─ UVR-MDX-NET-Inst_HQ_3.onnx 约 64 MB
//!   └─ BS-Roformer-SW.ckpt        约 667 MB
//! <可写目录>/svsep/{uploads,outputs,logs,data}/   运行期数据
//! ```
//!
//! 绿色版里「可写目录」就是 `<root>/app/data`，所以开发机上模型落在
//! `app/data/svsep/models/`，与运行时并排 —— 看起来像一体，其实是两件事：
//! **运行时进安装包、模型不进**。安装版的模型在 `%APPDATA%` 下，因为
//! Program Files 是只读的。
//!
//! ## 我们对后端源码动过的唯一一处
//!
//! `backend/config.py` 的模型目录原本只有两条路：`<BUNDLE_DIR>/models`（只读，有就赢）
//! 和 `<DATA_ROOT>/models`。我们要的第三种组合（运行时只读、模型在可写的别处）
//! 它表达不了，所以在那里加了一段 `CHIXIAOYANG_MODELS_DIR` 优先分支 ——
//! 由这里的 `spawn()` 传进去。改动点带注释标了「V-Synth-Studio 加的」。
//!
//! ⚠️ 别用软链接/junction 去绕这件事：那条路要处理提权、要处理「目标不存在时
//! 建不出来」，而一个环境变量就够了。

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde_json::{json, Value};

/// 分离后端的默认端口。
///
/// 不用 0（随机）是因为要写进日志与界面上的「服务地址」，固定一个更好排查；
/// 它只在 127.0.0.1 上监听，且 17879 与工作站自己的 17878 错开。
const DEFAULT_PORT: u16 = 17879;

/// 端口占用时最多往后试几个
const PORT_TRIES: u16 = 20;

/// 两个模型文件的期望大小（下限）。
///
/// 上游 `config.py` 用「onnx ≥ 20 MB、名字含 roformer-sw 的 ckpt ≥ 400 MB」
/// 判断模型是不是下全了 —— 这里取的是**真实文件大小**，
/// 用来区分「下了一半」和「下完了」。留 5% 余量。
const UVR_MODEL_MIN: u64 = 55 * 1024 * 1024;
const UVR_MODEL_FULL: u64 = 60 * 1024 * 1024;
const ROFORMER_MODEL_MIN: u64 = 600 * 1024 * 1024;
const ROFORMER_MODEL_FULL: u64 = 640 * 1024 * 1024;

/// 两个模型的文件名（与上游 `config.DEFAULT_*_MODEL` 一致）
const UVR_MODEL: &str = "UVR-MDX-NET-Inst_HQ_3.onnx";
const ROFORMER_MODEL: &str = "BS-Roformer-SW.ckpt";

/// 上游 `models/` 里除权重之外的索引文件，缺一个都跑不起来
const MODEL_INDEX_FILES: &[&str] = &[
    "download_checks.json",
    "mdx_model_data.json",
    "vr_model_data.json",
    "BS-Roformer-SW.yaml",
];

/// 运行时目录的期望体积（未压缩）。
///
/// 只用于界面上「运行时 / 7.3 GB」这种展示与下载进度百分比 —— 判断装没装
/// 靠的是 `runtime_ready()`（`python.exe` 与 `backend/app.py` 两个文件在不在），
/// **不是**这个数。目录里的文件数（约 2.4 万）与单个文件名字都可能随上游
/// 换版本而变，只有「两个入口文件存在」是稳的。
pub const RUNTIME_BYTES: u64 = 7_855_000_000;

/// 运行时下载链接（123 云盘 CDN，用户自己上传的包）。
///
/// ⚠️ 末尾那个 `#` **不要删**：那是用户给的原始链接，去掉它可能 404。
/// ⚠️ 换链接之前先想清楚：盘上那个 `.part` 旁边的 `.part.url` 记着旧链接，
/// 换了之后旧的半个包会被当成「别的包的」丢掉、从头下（见 `stored_resume`）。
pub const RUNTIME_URL: &str = "https://1856610041.cdn.123clouddisk.com/1856610041/V-Synth-Studio/runtime.zip#";

/// 模型下载链接（同上，123 云盘 CDN）。
///
/// 界面上「下载模型」按钮在没有链接时会明确说「还没配置下载地址」，
/// 而不是转圈然后失败。
pub const MODEL_URL: &str = "https://1856610041.cdn.123clouddisk.com/1856610041/V-Synth-Studio/models.zip#";

/// **只给开发机用的临时覆盖**（`VSS_SVSEP_MODEL_URL` / `VSS_SVSEP_RUNTIME_URL`）。
///
/// 为什么留这个口子：这两个链接是编译期常量，而「暂停 → 续传」「下载中点删除」
/// 这类事**必须在真下载跑着的时候**才能验。要是每次都改常量再重编，测完还得
/// 记得改回来 —— 漏一次就会把开发机地址发出去。用环境变量就在进程外解决。
/// ⚠️ 发布版**不要设这两个变量**，设了就是拿本地文件当下载源。
#[cfg(debug_assertions)]
fn url_override(key: &str, default: &'static str) -> String {
    match std::env::var(key) {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => default.to_string(),
    }
}
#[cfg(not(debug_assertions))]
fn url_override(_key: &str, default: &'static str) -> String {
    default.to_string()
}

/// 这一次真的要用的模型下载地址（常量，或开发机用环境变量顶掉的那个）。
pub fn model_url() -> String {
    url_override("VSS_SVSEP_MODEL_URL", MODEL_URL)
}

/// 这一次真的要用的运行时下载地址。
pub fn runtime_url() -> String {
    url_override("VSS_SVSEP_RUNTIME_URL", RUNTIME_URL)
}

/* ══════════════════════════════════ 路径 ══════════════════════════════════ */

/// 运行时根目录：`<root>/app/data/svsep`
pub fn runtime_dir(root: &Path) -> PathBuf {
    root.join("app").join("data").join("svsep")
}

/// 模型目录：`<可写目录>/svsep/models`
pub fn models_dir(writable: &Path) -> PathBuf {
    writable.join("svsep").join("models")
}

/// 后端看到的 `BASE_DIR` —— 与 `runtime_dir()` 同一个地方。
///
/// `CHIXIAOYANG_DATA_DIR` 指的也是它，所以 uploads / outputs / logs 会落在
/// `<root>/app/data/svsep/` 下面。绿色版能写；安装版不能写，那时上面的
/// `models_dir()` 已经在 `%APPDATA%` 了，但**运行时的 uploads 也得跟着走** ——
/// 见 `data_dir()`。
pub fn data_dir(root: &Path, writable: &Path, installed: bool) -> PathBuf {
    if installed {
        writable.join("svsep")
    } else {
        runtime_dir(root)
    }
}

fn python_exe(root: &Path) -> PathBuf {
    runtime_dir(root).join("runtime").join("python.exe")
}

/// 运行时是否齐备（Python + 后端）
pub fn runtime_ready(root: &Path) -> bool {
    python_exe(root).is_file() && runtime_dir(root).join("backend").join("app.py").is_file()
}

/// 运行时状态（给 `/api/svsep/status` 用的那一段）。
///
/// 为什么不去统计目录里的实际字节数：2.4 万个文件、每次轮询都走一遍，
/// 在机械盘上要几秒 —— 而界面只需要「在不在」和一个够用的分母。
pub fn runtime_status(root: &Path) -> Value {
    let dir = runtime_dir(root);
    let py = python_exe(root);
    let backend = dir.join("backend").join("app.py");
    json!({
        "dir": dir.to_string_lossy(),
        "ready": runtime_ready(root),
        // ⚠️ 用 `runtime_url()` 不用常量：开发机用环境变量顶掉链接时，界面显示的
        //    也得是那个顶掉的地址，否则会出现「界面说没配、其实配了」这种鬼状态。
        "downloadUrl": runtime_url(),
        // 「大概多大」用于展示与进度百分比，不是判据
        "expectedBytes": RUNTIME_BYTES as f64,
        "python": py.is_file(),
        "backend": backend.is_file(),
        "pythonPath": py.to_string_lossy(),
        "backendPath": backend.to_string_lossy(),
    })
}

/* ══════════════════════════════════ 模型 ══════════════════════════════════ */

fn file_size(p: &Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

/// 一个模型的状态。`state` 三种：`ok` / `partial`（下了一半）/ `missing`
fn model_state(dir: &Path, name: &str, min: u64) -> (String, u64) {
    let n = file_size(&dir.join(name));
    let state = if n >= min {
        "ok"
    } else if n > 0 {
        "partial"
    } else {
        "missing"
    };
    (state.to_string(), n)
}

/// 两个模型都在不在 —— 界面上的「还没下模型」就靠这个
pub fn models_ok(writable: &Path) -> bool {
    let dir = models_dir(writable);
    model_state(&dir, UVR_MODEL, UVR_MODEL_MIN).0 == "ok"
        && model_state(&dir, ROFORMER_MODEL, ROFORMER_MODEL_MIN).0 == "ok"
}

/// 模型状态（给 `/api/svsep/status` 用的那一段）
pub fn models_status(writable: &Path) -> Value {
    let dir = models_dir(writable);
    let (uvr_state, uvr_size) = model_state(&dir, UVR_MODEL, UVR_MODEL_MIN);
    let (rof_state, rof_size) = model_state(&dir, ROFORMER_MODEL, ROFORMER_MODEL_MIN);
    let missing_index: Vec<&str> = MODEL_INDEX_FILES
        .iter()
        .filter(|f| !dir.join(f).is_file())
        .copied()
        .collect();
    #[allow(clippy::cast_possible_truncation)]
    let total = (uvr_size + rof_size) as f64;
    json!({
        "dir": dir.to_string_lossy(),
        // 两个都好、且索引文件齐全，才算真的就绪
        "ok": uvr_state == "ok" && rof_state == "ok" && missing_index.is_empty(),
        "downloadedBytes": total,
        "expectedBytes": (UVR_MODEL_FULL + ROFORMER_MODEL_FULL) as f64,
        "downloadUrl": model_url(),
        "items": [
            { "key": "uvr", "name": UVR_MODEL, "label": "二轨 · 人声 / 伴奏",
              "state": uvr_state, "size": uvr_size, "expectedSize": UVR_MODEL_FULL },
            { "key": "roformer", "name": ROFORMER_MODEL, "label": "六轨 · BS-Roformer",
              "state": rof_state, "size": rof_size, "expectedSize": ROFORMER_MODEL_FULL },
        ],
        "missingIndex": missing_index,
    })
}

/* ══════════════════════ 半个包（暂停留下的续传点）══════════════════════ */

/// 某个包没下完时 `.part` 落在哪。
///
/// 两个包的落点不一样（模型的 `dest` 是 `models/`，运行时的是 `svsep/` 本身），
/// 所以别自己拼 `dest.join(...)` —— 走 `Bundle`，落点只有一个定义处。
pub fn part_path(root: &Path, writable: &Path, kind: &str) -> Option<PathBuf> {
    let b = match kind {
        "models" => Bundle::models(writable, None),
        "runtime" => Bundle::runtime(root, None),
        _ => return None,
    };
    Some(b.dest.join(format!("{}.part", b.zip_name)))
}

/// `.part` 旁边那个小文件里记着「这半个包是谁的」。见 `stored_resume`。
fn url_marker(part: &Path) -> PathBuf {
    let mut s = part.as_os_str().to_os_string();
    s.push(".url");
    PathBuf::from(s)
}

/// 暂停时把这个包的链接记在 `.part` 旁边。
fn write_url_marker(part: &Path, url: &str) -> std::io::Result<()> {
    std::fs::write(url_marker(part), url)
}

/// 盘上那半个包**是不是这个链接**的。
///
/// 为什么要记：`.part` 只有字节，没有出处。用户换了下载服务器（或者我们在
/// 安装版里换了个地址）之后，拿旧的半个包去接新链接的 `Range`，拼出来的是
/// 「旧包的前半段 + 新包的后半段」—— 一个要到解压才炸的坏 zip，而且看着像
/// 我们的解析器有问题。链接对不上就当没有，从头下。
///
/// ⚠️ **记号缺失**（老版本留下的 `.part`、或者写记号那一下失败了）算「可以续」，
/// 不算「换了链接」：盘上有几个 GB 而记号只是个几十字节的附属品，为了它丢掉
/// 几个 GB 是坏交易。反过来，**记号在且写着别的链接**就必须当真 —— 那才是
/// 这个函数存在的理由。两种情况的区别是「`read_to_string` 失败」还是
/// 「读出来不等于 url」。
fn stored_resume(part: &Path, url: &str) -> bool {
    if !part.is_file() {
        return false;
    }
    match std::fs::read_to_string(url_marker(part)) {
        Ok(s) => s.trim() == url,
        // 没有记号文件（或读不出来）：按能续处理，第一次发 Range 之前会把记号补上
        Err(_) => true,
    }
}

/// 这个包有没有「可以接着下」的半个包，有就回它的字节数。
///
/// ⚠️ **看盘，不看内存里的记号**：工作站在下载中途被关掉、或者进程重启之后，
/// 那个 `(种类, 链接)` 的记忆就没了，而 4.7 GB 的半个包还在盘上 —— 只看内存
/// 会让界面以为「没下过」，用户一点就从零开始，白下几个 GB。
pub fn resume_point(root: &Path, writable: &Path, kind: &str, url: &str) -> Option<u64> {
    let part = part_path(root, writable, kind)?;
    if !stored_resume(&part, url) {
        return None;
    }
    let n = file_size(&part);
    (n > 0).then_some(n)
}

/// 收场之后收拾记号：暂停留着（下次还要用），下完/出错/停止都删掉。
pub fn clear_resume_marker(root: &Path, writable: &Path, kind: &str) {
    if let Some(part) = part_path(root, writable, kind) {
        let _ = std::fs::remove_file(url_marker(&part));
    }
}

/* ══════════════════════════════ 子进程管理 ══════════════════════════════ */

/// 分离服务。**由 `AppState` 持有**，进程活到工作站退出为止。
pub struct Svsep {
    root: PathBuf,
    writable: PathBuf,
    installed: bool,
    child: Mutex<Option<Child>>,
    port: Mutex<Option<u16>>,
    /// 最近一次健康探测的结果与时间 —— 界面每几秒轮询一次，
    /// 没必要每次都真去打 HTTP。
    health: Mutex<Option<(Instant, bool)>>,
    /// 最近一次启动失败的原因（给界面看）
    last_error: Mutex<Option<String>>,
}

impl Svsep {
    pub fn new(root: PathBuf, writable: PathBuf, installed: bool) -> Self {
        Self {
            root,
            writable,
            installed,
            child: Mutex::new(None),
            port: Mutex::new(None),
            health: Mutex::new(None),
            last_error: Mutex::new(None),
        }
    }

    pub fn writable(&self) -> &Path {
        &self.writable
    }

    pub fn runtime_ready(&self) -> bool {
        runtime_ready(&self.root)
    }

    pub fn dir(&self) -> PathBuf {
        runtime_dir(&self.root)
    }

    pub fn models(&self) -> PathBuf {
        models_dir(&self.writable)
    }

    pub fn models_ok(&self) -> bool {
        models_ok(&self.writable)
    }

    /// 数据目录（uploads / outputs / logs）
    pub fn data(&self) -> PathBuf {
        data_dir(&self.root, &self.writable, self.installed)
    }

    fn port(&self) -> Option<u16> {
        *self.port.lock().ok()?
    }

    pub fn base_url(&self) -> Option<String> {
        self.port().map(|p| format!("http://127.0.0.1:{p}"))
    }

    /// 端口（可能只是「上次起的那个」，不一定还在听）—— 只给界面显示用
    pub fn port_hint(&self) -> Option<u16> {
        self.port()
    }

    /// 最近一次启动失败的原因
    pub fn last_error(&self) -> Option<String> {
        self.last_error.lock().ok().and_then(|e| e.clone())
    }

    /// 起服务。已经在跑就什么都不做。
    ///
    /// 返回 `(端口, 是否新起)`。
    pub async fn start(&self) -> Result<(u16, bool), String> {
        if let Some(p) = self.port() {
            if self.probe().await {
                return Ok((p, false));
            }
            // 进程还在、但服务不应答：先收掉再重来，否则端口会一直被占着
            self.stop();
        }
        if !self.runtime_ready() {
            return Err(format!(
                "分离运行时不在：{}\n\
                 它随工作站一起分发。如果这里显示缺文件，说明安装包不完整 —— \
                 重新装一遍或把 svsep 目录重新解压出来即可。",
                self.dir().to_string_lossy()
            ));
        }
        if !self.models_ok() {
            return Err(
                "模型还没下载。先点上面的「下载模型」，下完再启动分离服务。".to_string(),
            );
        }

        let data = self.data();
        for sub in ["uploads", "outputs", "logs", "data"] {
            std::fs::create_dir_all(data.join(sub))
                .map_err(|e| format!("建目录失败（{}）：{e}", data.join(sub).to_string_lossy()))?;
        }
        // 模型目录也要建出来 —— 垫片要往里做联接
        let models = self.models();
        std::fs::create_dir_all(&models).map_err(|e| format!("建模型目录失败：{e}"))?;

        let exe = python_exe(&self.root);
        let script = self.dir().join("backend").join("app.py");

        // 端口：从默认值往后试，谁先空着用谁
        let mut last: Option<String> = None;
        for offset in 0..PORT_TRIES {
            let port = DEFAULT_PORT + offset;
            if port_occupied(port) {
                continue;
            }
            match self.spawn(&exe, &script, &data, &models, port) {
                Ok(()) => {
                    // 等它把 Flask 起起来。torch / onnxruntime 第一次 import 要几秒。
                    if self.wait_ready(90).await {
                        if let Ok(mut e) = self.last_error.lock() {
                            *e = None;
                        }
                        return Ok((port, true));
                    }
                    let why = self
                        .last_error
                        .lock()
                        .ok()
                        .and_then(|e| e.clone())
                        .unwrap_or_else(|| "服务起来了但一直没应答".to_string());
                    self.stop();
                    last = Some(why);
                }
                Err(e) => last = Some(e),
            }
        }
        Err(last.unwrap_or_else(|| "起不来：默认端口往后 20 个都被占着".to_string()))
    }

    fn spawn(
        &self,
        exe: &Path,
        script: &Path,
        data: &Path,
        models: &Path,
        port: u16,
    ) -> Result<(), String> {
        let log_dir = data.join("logs");
        std::fs::create_dir_all(&log_dir).ok();
        let log = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(log_dir.join("launch.log"))
            .ok();
        let log_err = log.as_ref().and_then(|f| f.try_clone().ok());

        let mut cmd = Command::new(exe);
        cmd.arg(script)
            .arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string())
            // 上游：CHIXIAOYANG_DATA_DIR 决定 uploads/outputs/logs/data/models，
            // CHIXIAOYANG_BUNDLE_DIR 是可以有 models 的只读根
            .env("CHIXIAOYANG_DATA_DIR", data)
            .env("CHIXIAOYANG_BUNDLE_DIR", data)
            .env("CHIXIAOYANG_MODELS_DIR", models)
            .env("PYTHONIOENCODING", "utf-8")
            .env("PYTHONUTF8", "1")
            .current_dir(&self.root)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());

        // 取消代理：后端自己也会清（config.py 里那段），但进程环境干净点更好排查
        for k in [
            "http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "all_proxy",
        ] {
            cmd.env_remove(k);
        }

        let mut child = cmd
            .spawn()
            .map_err(|e| format!("启动分离进程失败（{}）：{e}", exe.to_string_lossy()))?;

        // 挂进作业对象：工作站一死（包括被强杀）它就跟着死。
        // 见 `job` 模块 —— `Drop` 只覆盖正常退出这条路。
        if !job::join(&child) {
            // `note!` 是 main.rs 里的私有宏，模块里够不着，直接用底层那个函数
            crate::log_line("提示：没能把分离进程挂进作业对象，退出时只靠 Drop 收它");
        }

        // 把子进程的输出收进日志。
        //
        // ⚠️ 必须真读走：管道的缓冲区（约 64 KB）满了以后子进程会**阻塞在写日志上**，
        // 表现是任务卡在 0% 或者干脆不动 —— 这个坑很难从现象反推回原因。
        // 后端自己也往 <data>/logs/app.log 写一份，这里收的是「起不来时」才看得到的早期输出。
        if let Some(out) = child.stdout.take() {
            pump(out, log);
        }
        if let Some(err) = child.stderr.take() {
            pump(err, log_err);
        }

        if let Ok(mut c) = self.child.lock() {
            *c = Some(child);
        }
        if let Ok(mut p) = self.port.lock() {
            *p = Some(port);
        }
        if let Ok(mut h) = self.health.lock() {
            *h = None;
        }
        Ok(())
    }

    /// 停掉服务（幂等）。工作站退出时也调它。
    pub fn stop(&self) {
        if let Ok(mut p) = self.port.lock() {
            *p = None;
        }
        if let Ok(mut h) = self.health.lock() {
            *h = None;
        }
        let Ok(mut guard) = self.child.lock() else { return };
        let Some(mut child) = guard.take() else { return };
        kill_tree(&mut child);
    }

    /// 健康探测（带 2 秒缓存）
    pub async fn probe(&self) -> bool {
        if let Ok(h) = self.health.lock() {
            if let Some((at, ok)) = *h {
                if at.elapsed() < Duration::from_secs(2) {
                    return ok;
                }
            }
        }
        let Some(base) = self.base_url() else { return false };
        let ok = matches!(get_json(&format!("{base}/api/status")).await, Ok(v) if is_ready(&v));
        if let Ok(mut h) = self.health.lock() {
            *h = Some((Instant::now(), ok));
        }
        ok
    }

    /// 等到服务应答为止。返回是否等到了。
    async fn wait_ready(&self, secs: u64) -> bool {
        let deadline = Instant::now() + Duration::from_secs(secs);
        loop {
            // 进程可能已经死了（缺 dll、Python 路径不对……），别死等
            let alive = {
                let mut g = match self.child.lock() {
                    Ok(g) => g,
                    Err(_) => return false,
                };
                match g.as_mut() {
                    Some(c) => match c.try_wait() {
                        Ok(Some(status)) => {
                            let mut e = self.last_error.lock().ok();
                            if let Some(slot) = e.as_mut() {
                                **slot = Some(format!(
                                    "分离进程刚起来就退出了（退出码 {:?}）。\
                                     看一下 {} 里的日志。",
                                    status.code(),
                                    self.data().join("logs").join("launch.log").to_string_lossy()
                                ));
                            }
                            false
                        }
                        Ok(None) => true,
                        Err(_) => true,
                    },
                    None => false,
                }
            };
            if !alive {
                return false;
            }
            if self.probe().await {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(400)).await;
        }
    }

    /* ── 转发给后端 ───────────────────────────────────────────────── */

    /// 原样转发一个 GET，回解析好的 JSON
    pub async fn get(&self, path: &str) -> Result<Value, String> {
        let base = self
            .base_url()
            .ok_or_else(|| "分离服务还没启动".to_string())?;
        get_json(&format!("{base}{path}")).await
    }

    /// 转发一个 JSON POST
    pub async fn post_json(&self, path: &str, body: &Value) -> Result<Value, String> {
        let base = self
            .base_url()
            .ok_or_else(|| "分离服务还没启动".to_string())?;
        post_json(&format!("{base}{path}"), body).await
    }

    /// 提交一次分离：把上游要的 multipart 原样转发过去。
    ///
    /// **不做解包再重打包** —— 工作站前端已经是按上游的字段名（`file`）构造
    /// multipart 的，拆开再拼一遍只会在文件名转义、大 body 缓冲这些地方出错。
    pub async fn submit(&self, engine: &str, body: Vec<u8>, content_type: &str) -> Result<Value, String> {
        let base = self
            .base_url()
            .ok_or_else(|| "分离服务还没启动".to_string())?;
        let path = match engine {
            "uvr" => "/api/separate/uvr",
            _ => "/api/separate/roformer",
        };
        post_raw(&format!("{base}{path}"), content_type.to_string(), body).await
    }

    /// 流式转发输出文件（WAV 可能几十 MB，不整个读进内存）
    pub async fn download(
        &self,
        task_id: &str,
        index: u32,
        inline: bool,
    ) -> Result<reqwest::Response, String> {
        let base = self
            .base_url()
            .ok_or_else(|| "分离服务还没启动".to_string())?;
        let q = if inline { "?inline=1" } else { "" };
        let url = format!("{base}/api/download/{task_id}/out/{index}{q}");
        let res = crate::net::client()
            .get(&url)
            .timeout(Duration::from_secs(300))
            .send()
            .await
            .map_err(|e| format!("取输出文件失败：{e}"))?;
        if !res.status().is_success() {
            return Err(format!("取输出文件失败：HTTP {}", res.status().as_u16()));
        }
        Ok(res)
    }
}

impl Drop for Svsep {
    fn drop(&mut self) {
        // 工作站退出时把分离进程一起带走。
        // 它是 python.exe 而不是我们的子线程 —— 不主动收就变成孤儿进程，
        // 用户下次打开会看到两个「分离服务」在抢同一个端口。
        //
        // ⚠️ 但 Drop **收不住强杀**：任务管理器结束进程、或者运行时被跳过析构时，
        //    这个析构函数不会跑 —— 实测过，python.exe 会活下来继续占着 17879，
        //    还揣着几个 GB 内存。兜底是 `join_job()`，见那里。
        self.stop();
    }
}

/* ═════════════════════════ Windows 作业对象（收子进程的兜底）════════════════════════ */

/// 子进程必须随工作站一起死 —— 连「被强杀」也算。
///
/// `Drop` 只覆盖正常退出。任务管理器强杀时析构不跑，实测 python.exe 会变成孤儿：
/// 它继续监听 17879（下次启动时工作站会以为端口被占，另挑一个），并且占着几 GB
/// 内存不放。用户看到的是「明明关掉了，风扇还在转」。
///
/// 作业对象的解法：把子进程放进一个设了
/// `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 的作业里。**进程一死，它持有的句柄
/// 就被系统关掉**（句柄表是内核对象，正常退出、崩溃、强杀都一样会被回收），
/// 于是作业上挂着的所有进程一起被终止。这比任何用户态析构都可靠。
///
/// ⚠️ 这个句柄**故意不关**：它的生命周期就该等于本进程的。拿一个 `OnceLock`
///    存着（内核句柄，值本身是 `Send + Sync` 的），`Drop` 里关掉反而会把
///    作业提前收走。
#[cfg(windows)]
mod job {
    use std::sync::OnceLock;
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
        JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// 句柄是内核对象，跨线程传本身是安全的 —— 用个 newtype 让编译器同意。
    struct Handle(*mut core::ffi::c_void);
    unsafe impl Send for Handle {}
    unsafe impl Sync for Handle {}

    static JOB: OnceLock<Option<Handle>> = OnceLock::new();

    /// 拿到（必要时建一个）作业对象句柄。建不出来就回 `None`，
    /// 调用方照常跑 —— 这只是兜底，失败了不该让分离功能不可用。
    fn job_handle() -> Option<*mut core::ffi::c_void> {
        JOB.get_or_init(|| unsafe {
            let h = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if h.is_null() {
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = std::mem::zeroed();
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                h,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const core::ffi::c_void,
                std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            );
            if ok == 0 {
                // 设不上限制的作业对象毫无用处：这种子进程照样会变孤儿，
                // 不如不挂（挂了反而让人以为已经兜住了）。
                return None;
            }
            Some(Handle(h))
        })
        .as_ref()
        .map(|h| h.0)
    }

    /// 把刚 spawn 出来的子进程挂进作业。挂不上就放它自己跑（有 `Drop` 兜着）。
    pub fn join(child: &std::process::Child) -> bool {
        use std::os::windows::io::AsRawHandle;
        let Some(job) = job_handle() else { return false };
        let proc = child.as_raw_handle() as *mut core::ffi::c_void;
        unsafe { AssignProcessToJobObject(job, proc) != 0 }
    }
}

#[cfg(not(windows))]
mod job {
    /// 非 Windows 上靠进程组与 `Drop`（`kill_tree` 里有各自的实现）。
    pub fn join(_child: &std::process::Child) -> bool {
        false
    }
}

/// 把子进程的一路输出抽到日志文件里（在独立线程里读，不阻塞任何人）
fn pump<R: std::io::Read + Send + 'static>(mut r: R, mut log: Option<std::fs::File>) {
    std::thread::spawn(move || {
        use std::io::{BufRead, BufReader, Write};
        let reader = BufReader::new(&mut r);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            if let Some(f) = log.as_mut() {
                let _ = writeln!(f, "{line}");
                let _ = f.flush();
            }
        }
    });
}

/// 收掉整棵进程树。
///
/// 只管 python.exe 不够：它会再拉起 ffmpeg 之类的孙进程。Windows 上用 taskkill /T，
/// 其它平台按进程组发信号（`quiet_command` 里已经设了 `setsid` 之类，见那边注释）。
fn kill_tree(child: &mut Child) {
    #[cfg(windows)]
    {
        let pid = child.id();
        let _ = crate::server::quiet_command("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        // taskkill 已经带走了它；下面的 kill/wait 只是兜底（比如 taskkill 不存在）
    }
    let _ = child.kill();
    let _ = child.wait();
}

/// 端口是不是被占了
fn port_occupied(port: u16) -> bool {
    use std::net::{Ipv4Addr, SocketAddrV4, TcpListener};
    TcpListener::bind(SocketAddrV4::new(Ipv4Addr::LOCALHOST, port)).is_err()
}

/* ══════════════════════════════ HTTP 小工具 ══════════════════════════════ */

fn is_ready(v: &Value) -> bool {
    v.get("ok").and_then(Value::as_bool).unwrap_or(false)
        && v.get("ready").and_then(Value::as_bool).unwrap_or(false)
}

async fn get_json(url: &str) -> Result<Value, String> {
    let res = crate::net::client()
        .get(url)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("连不上分离服务：{e}"))?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("分离服务回 HTTP {}：{}", status.as_u16(), brief(&text)));
    }
    serde_json::from_str(&text).map_err(|e| format!("分离服务回的不是 JSON：{e}"))
}

async fn post_json(url: &str, body: &Value) -> Result<Value, String> {
    let res = crate::net::client()
        .post(url)
        .json(body)
        .timeout(Duration::from_secs(300))
        .send()
        .await
        .map_err(|e| format!("请求分离服务失败：{e}"))?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("分离服务回 HTTP {}：{}", status.as_u16(), brief(&text)));
    }
    serde_json::from_str(&text).map_err(|e| format!("分离服务回的不是 JSON：{e}"))
}

async fn post_raw(url: &str, content_type: String, body: Vec<u8>) -> Result<Value, String> {
    let res = crate::net::client()
        .post(url)
        .header("content-type", content_type)
        .body(body)
        .timeout(Duration::from_secs(600))
        .send()
        .await
        .map_err(|e| format!("上传到分离服务失败：{e}"))?;
    let status = res.status();
    let text = res.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("分离服务回 HTTP {}：{}", status.as_u16(), brief(&text)));
    }
    serde_json::from_str(&text).map_err(|e| format!("分离服务回的不是 JSON：{e}"))
}

/// 出错时给用户看一小段响应体就够了，别把整页 HTML 塞进 toast
fn brief(s: &str) -> String {
    let t = s.trim();
    if t.chars().count() <= 200 {
        return t.to_string();
    }
    let head: String = t.chars().take(200).collect();
    format!("{head}…")
}

/* ══════════════════════════════ 下载 ══════════════════════════════ */

/// 一次下载的三种收场。
#[derive(Debug)]
pub enum FetchOutcome {
    /// 下完、解好、临时文件已清
    Done(Value),
    /// 用户按了暂停：`.part` 留着，下次带 Range 接着下
    Paused { bytes: u64 },
    /// 用户按了停止：`.part` 已删，下次从头下
    Cancelled,
}

/// 下载/解压过程中的「暂停 / 停止」开关与「这次能不能续传」。
///
/// 用 `AtomicBool` 而不是 `CancellationToken`：这两个标志是**全局单例**的
/// （同一时刻只可能有一个大包在动，见 `server/svsep.rs` 的 `DL_*`），
/// 引一层 token 只是为了给它找个主人。`static` 的生命周期也不受 `tokio::spawn`
/// 的 `'static` 限制。
pub struct DownloadCtl {
    pause: &'static AtomicBool,
    cancel: &'static AtomicBool,
    /// 续传时要用的链接（`None` = 这次不许续传，`.part` 视为无效）
    pub resume_url: Option<String>,
}

impl DownloadCtl {
    pub fn new(
        pause: &'static AtomicBool,
        cancel: &'static AtomicBool,
        resume_url: Option<String>,
    ) -> Self {
        pause.store(false, Ordering::Relaxed);
        cancel.store(false, Ordering::Relaxed);
        Self {
            pause,
            cancel,
            resume_url: resume_url.map(|u| u.trim().to_string()),
        }
    }

    /// 该停一下了吗（暂停或停止都算）
    fn check(&self) -> bool {
        self.pause.load(Ordering::Relaxed) || self.cancel.load(Ordering::Relaxed)
    }

    pub fn cancelled(&self) -> bool {
        self.cancel.load(Ordering::Relaxed)
    }

    /// 收场是「暂停」还是「停止」。
    ///
    /// ⚠️ 现在**没有生产代码用它**：收场的三种情形是从返回值
    /// （`FetchOutcome` / 回包里的 `paused` / `cancelled` 标志）读的，
    /// 比回头问旗标可靠。留着是因为它和 `cancelled()` 是一对语义
    /// （两个都立着时按「停止」算），单测也拿它当判据。
    #[allow(dead_code)]
    pub fn paused(&self) -> bool {
        self.pause.load(Ordering::Relaxed) && !self.cancel.load(Ordering::Relaxed)
    }
}

/// 一个可下载的包：链接、落点、zip 里那一层壳的名字、出错时怎么称呼它。
struct Bundle<'a> {
    /// svsep.rs 里那个常量（`MODEL_URL` / `RUNTIME_URL`）
    const_name: &'static str,
    /// 界面上的名字，用在错误文案里
    label: &'static str,
    /// 编译期那条链接（现在都是空串，等用户上传后填）
    default_url: &'static str,
    /// 调用方临时覆盖的链接（设置页填的、或者测试传的）
    url: Option<&'a str>,
    /// 临时 zip 放哪、解到哪
    dest: PathBuf,
    /// 从条目名里剥掉的一层（见 `extract_zip`）
    strip: &'static str,
    /// 解压完删掉 zip 时，它叫什么
    zip_name: &'static str,
}

impl<'a> Bundle<'a> {
    fn models(writable: &Path, url: Option<&'a str>) -> Self {
        Self {
            const_name: "MODEL_URL",
            label: "模型",
            default_url: MODEL_URL,
            url,
            dest: models_dir(writable),
            strip: "models/",
            zip_name: "svsep-models.zip",
        }
    }

    fn runtime(root: &Path, url: Option<&'a str>) -> Self {
        Self {
            const_name: "RUNTIME_URL",
            label: "运行时",
            default_url: RUNTIME_URL,
            url,
            dest: runtime_dir(root),
            strip: "", // 留着 runtime/ 这一层：那边要的正是 runtime/python.exe
            zip_name: "svsep-runtime.zip",
        }
    }

    /// 实际用哪条链接：调用方给的优先，空串等于没给
    fn resolved_url(&self) -> &str {
        match self.url {
            Some(u) if !u.trim().is_empty() => u.trim(),
            _ => self.default_url.trim(),
        }
    }
}

/// 下载一个包、解压、清掉临时文件。`download_models` / `download_runtime` 都走这里。
///
/// 三种收场，见 `FetchOutcome`：下完解好 / 用户按了暂停（留着 `.part`，下次接着下）
/// / 用户按了停止（删掉 `.part`，下次从头下）。
///
/// ⚠️ **续传是按 `.part` 在不在判的**：文件在那儿就发 `Range: bytes=<已有>-`，
///    服务端回 206 就从那儿接着写。回到 200（不认 Range 的服务器，比如某些
///    简单的静态托管）就**从头写**：追加会得到一个前一段 + 整段拼起来的坏 zip，
///    而且要到解压时才炸 —— 那比重新下更糟。
/// ⚠️ 下载途中写的是 `<dest>/<zip_name>.part`，**不是 `.zip`** —— 万一用户
///    中途去点了「开始分离」，`runtime_ready()` 看到的是半个 zip，不会把它
///    当成装好了。
async fn fetch_bundle(
    b: &Bundle<'_>,
    ctl: &DownloadCtl,
    on_progress: &(impl Fn(u64, Option<u64>) + Send + Sync),
) -> Result<FetchOutcome, String> {
    let url = b.resolved_url();
    if url.is_empty() {
        return Err(format!(
            "还没配置{}下载地址。打包好的 {} 需要先传到服务器，\
             再把地址填进 svsep.rs 的 {}。",
            b.label, b.zip_name, b.const_name
        ));
    }
    if !url.starts_with("https://") && !url.starts_with("http://") {
        return Err(format!("{}下载地址必须是 http(s) 链接", b.label));
    }

    std::fs::create_dir_all(&b.dest).map_err(|e| format!("建目录失败：{e}"))?;
    let zip_path = b.dest.join(format!("{}.part", b.zip_name));

    // 已有多少字节（上次暂停留下的）。调用方说不能续传时当成 0，并且把旧的那个
    // 半个文件删掉 —— 留着它只会让下次误判。
    //
    // ⚠️ 光有 `resume_url` 还不够：那个链接必须和 `.part` 旁边记的**对得上**，
    //    否则这半个包是别的文件的，接上去会拼出一个坏 zip（见 `stored_resume`）。
    let mut already = match ctl.resume_url.as_deref() {
        Some(u) if stored_resume(&zip_path, u) => file_size(&zip_path),
        _ => 0,
    };
    if already == 0 {
        let _ = std::fs::remove_file(&zip_path);
        let _ = std::fs::remove_file(url_marker(&zip_path));
    } else {
        // 记一笔「这半个包是这个链接的」。写在发请求**之前**：万一进程在这儿
        // 被杀掉，下次也知道它属于谁。
        let _ = write_url_marker(&zip_path, url);
    }

    // 从头下 / 接着下的差异只在这三行：一个 Range 头、一个追加标志、一个起始计数
    let mut req = crate::net::client()
        .get(url)
        // 6 小时：这个包可能有好几 GB，超时是按「整个响应」算的，
        // 用 reqwest 默认的 30 秒会在第一块数据之后被掐断。
        .timeout(Duration::from_secs(6 * 3600));
    if already > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={already}-"));
    }

    let res = req
        .send()
        .await
        .map_err(|e| format!("下载{}失败：{e}", b.label))?;
    let status = res.status();
    if !status.is_success() {
        return Err(format!("下载{}失败：HTTP {}", b.label, status.as_u16()));
    }
    // 206 = 服务端认了 Range；200 = 不认，要从头写
    let resumed = status.as_u16() == 206 && already > 0;
    if !resumed {
        already = 0;
    }
    // 206 时 Content-Length 是「还剩多少」，总长要把已有的加上
    let total = res.content_length().map(|len| len + already);

    let mut file = if resumed {
        std::fs::OpenOptions::new()
            .append(true)
            .open(&zip_path)
            .map_err(|e| format!("打开临时文件失败：{e}"))?
    } else {
        std::fs::File::create(&zip_path).map_err(|e| format!("写临时文件失败：{e}"))?
    };
    let mut got: u64 = already;
    on_progress(got, total);
    let mut stream = res.bytes_stream();
    use futures_util::StreamExt;
    use std::io::Write;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载中断：{e}"))?;
        file.write_all(&chunk)
            .map_err(|e| format!("写文件失败（磁盘满了？）：{e}"))?;
        got += chunk.len() as u64;
        on_progress(got, total);
        // ⚠️ 这个判断要放在写盘之后、下一块之前：放到外面会让一次暂停多下几 MB
        if ctl.check() {
            let _ = file.flush();
            drop(file);
            return Ok(if ctl.cancelled() {
                // 停止 = 这次不算数，半个文件也删掉，下次从头下
                let _ = std::fs::remove_file(&zip_path);
                let _ = std::fs::remove_file(url_marker(&zip_path));
                on_progress(0, None);
                FetchOutcome::Cancelled
            } else {
                // 暂停 = 半个包留着，记号也留着（下次要拿它发 Range）
                FetchOutcome::Paused { bytes: got }
            });
        }
    }
    drop(file);

    // ⚠️ 解压放在 `?` 之前：解压失败要落在下面的收尾里把 zip 删掉，
    //    不能直接从这儿 return（那样会留下几 GB 的残包）
    let report = extract_zip(&zip_path, &b.dest, b.strip, |done, all| {
        on_progress(done, Some(all))
    });
    // 不论成败都把 zip 删掉 —— 它有几 GB，留着毫无用处
    // （`.part` 这个名字也保证了下次不会误当成 .zip 用）
    let _ = std::fs::remove_file(&zip_path);
    // 记号跟着走：包已经解完（或解失败），没有「半个包」可续了
    let _ = std::fs::remove_file(url_marker(&zip_path));
    let report = report?;

    Ok(FetchOutcome::Done(json!({
        "ok": true,
        "dir": b.dest.to_string_lossy(),
        "files": report.files,
        "bytes": report.bytes,
    })))
}

/// 下载模型 zip 并解压到 `<可写>/svsep/models/`。
///
/// 用户可以暂停 / 停止（`ctl`），暂停后 `.part` 留着、下次 `resume_url` 指同一条
/// 链接就接着下；停止会把 `.part` 删掉，下次从头下。
pub async fn download_models(
    writable: &Path,
    url: &str,
    ctl: &DownloadCtl,
    on_progress: impl Fn(u64, Option<u64>) + Send + Sync + 'static,
) -> Result<FetchOutcome, String> {
    let given = if url.trim().is_empty() { None } else { Some(url) };
    let b = Bundle::models(writable, given);
    // 三种收场统一成「一个带 paused / cancelled 标志的对象」，界面只看这两个
    // 标志决定进度条是消失还是留着。落盘状态（`models` / `runtime`）由
    // `server/svsep.rs` 拼 —— 它本来就在拼 `/api/svsep/status`。
    Ok(match fetch_bundle(&b, ctl, &on_progress).await? {
        FetchOutcome::Done(mut v) => {
            if let Some(o) = v.as_object_mut() {
                o.insert("paused".into(), Value::Bool(false));
                o.insert("cancelled".into(), Value::Bool(false));
            }
            FetchOutcome::Done(v)
        }
        FetchOutcome::Paused { bytes } => FetchOutcome::Done(json!({
            "ok": true, "paused": true, "cancelled": false, "bytes": bytes,
        })),
        FetchOutcome::Cancelled => FetchOutcome::Done(json!({
            "ok": true, "paused": false, "cancelled": true, "bytes": 0,
        })),
    })
}

/// 下载运行时 zip 并解压到 `<root>/app/data/svsep/`（`runtime/` 那一层留着）。
///
/// ⚠️ 这个包**几 GB**，只该下一次：文件多、解压慢。换工作站版本时运行时通常
/// 不变 —— 变的是 `backend/` 那几个 .py，而**那部分随程序打包**，不走这里。
pub async fn download_runtime(
    root: &Path,
    url: &str,
    ctl: &DownloadCtl,
    on_progress: impl Fn(u64, Option<u64>) + Send + Sync + 'static,
) -> Result<FetchOutcome, String> {
    let given = if url.trim().is_empty() { None } else { Some(url) };
    let b = Bundle::runtime(root, given);
    Ok(match fetch_bundle(&b, ctl, &on_progress).await? {
        FetchOutcome::Done(mut v) => {
            if let Some(o) = v.as_object_mut() {
                o.insert("paused".into(), Value::Bool(false));
                o.insert("cancelled".into(), Value::Bool(false));
            }
            FetchOutcome::Done(v)
        }
        FetchOutcome::Paused { bytes } => FetchOutcome::Done(json!({
            "ok": true, "paused": true, "cancelled": false, "bytes": bytes,
        })),
        FetchOutcome::Cancelled => FetchOutcome::Done(json!({
            "ok": true, "paused": false, "cancelled": true, "bytes": 0,
        })),
    })
}

/// 删掉一个目录里所有 `*.part`（没下完的半个 zip）与它旁边的 `*.part.url`，
/// 返回删掉的文件数与字节数。
///
/// 为什么单独来一遍：`.part` 的落点是 `Bundle::dest`，模型的在 `models/` 里
/// （会被上面的递归带走），**但运行时的在 `svsep/` 那一层**，不在
/// `runtime/` 里 —— 不专门扫一遍就会留下几 GB 的半个 zip，而界面显示「已删除」。
/// ⚠️ `.part.url` 只有几十字节，但**必须一起删**：留着它而 `.part` 没了，
/// 下次 `resume_point` 会看到「记号在、包不在」，白查一遍（虽然也不会出错）。
fn sweep_part_files(dir: &Path) -> (u64, u64) {
    let (mut files, mut bytes) = (0u64, 0u64);
    let Ok(rd) = std::fs::read_dir(dir) else {
        return (files, bytes);
    };
    for ent in rd.flatten() {
        let p = ent.path();
        let is_part = p
            .file_name()
            .and_then(|n| n.to_str())
            .map(|n| n.ends_with(".part") || n.ends_with(".part.url"))
            .unwrap_or(false);
        if !is_part || !p.is_file() {
            continue;
        }
        let size = ent.metadata().map(|m| m.len()).unwrap_or(0);
        if std::fs::remove_file(&p).is_ok() {
            files += 1;
            bytes += size;
        }
    }
    (files, bytes)
}

/// 一键删除所有「下下来的依赖」：模型、运行时、ffmpeg。
///
/// ⚠️ **运行时也在里面**，用户点之前必须知道：删完要重新下 4.7 GB 才能用分离。
/// ⚠️ **只删「下下来的」那几层，不是整个 `svsep/`**。这个区别是最容易写错的地方：
///    `runtime_dir()` 指的是整个 `<root>/app/data/svsep/`，而那一层下面还住着
///    `backend/`（分离后端的 .py，**随程序打包、不该删**）和运行期的
///    `data/ logs/ outputs/ uploads/`（用户的东西）。所以要拼三个具体目录：
///      · 模型   `<可写>/svsep/models`（下模型包时解到这儿）
///      · 运行时 `<root>/app/data/svsep/runtime`（下运行时包时解到这儿）
///      · ffmpeg `<root>/app/data/svsep/bin`（跟运行时同一个包里的，见
///        `backend/config.py::_ensure_ffmpeg_on_path` —— 删了等于没装）
/// ⚠️ 三个目录都是一个一个删文件（不是 `remove_dir_all`）：几万个文件里总有几个
///    被别的进程占着（杀软扫描、残留的 python），一个失败就整段放弃最糟 ——
///    那会留下一个「删了一半、界面还说有 7 GB」的目录。删不掉的记下来照实报。
/// ⚠️ 只删目录**里面**的东西，目录本身留着：`models/` 是 `MODEL_DIR`，
///    引擎启动时会检查它在不在。
/// `cancelled` 是「用户按了停止」的探针（删除几万个文件要几十秒）。
/// `on_progress` 收 `FnMut` —— 它的调用方基本都是就地改一个计数器，
/// 收 `Fn` 会逼着每个人套一层 `Cell`。
pub fn delete_dependencies(
    root: &Path,
    writable: &Path,
    cancelled: impl Fn() -> bool,
    mut on_progress: impl FnMut(u64, u64),
) -> Value {
    let svsep = runtime_dir(root);
    let targets = [
        ("模型", models_dir(writable)),
        ("运行时", svsep.join("runtime")),
        ("ffmpeg", svsep.join("bin")),
    ];
    let mut removed_bytes: u64 = 0;
    let mut removed_files: u64 = 0;
    let mut locked: Vec<String> = Vec::new();
    let mut stopped = false;

    // ⚠️ 没下完的半个 zip 先单独扫一遍，**而且只扫 `svsep/` 这一层**（不递归）：
    //    `.part` 的落点就是 `Bundle::dest` —— 模型包的 `dest` 是 `models/`（会跟着
    //    下面的 walk 一起走），运行时包的 `dest` 是 `svsep/` 本身，它**不在**那三个
    //    目标目录里面，不专门扫就会留下几 GB 的半个 zip，而界面显示「已删除」。
    //    ⚠️ 这一遍必须在 walk **之前**、且不能放进下面那个循环里：放进循环会把
    //    `models/` 里的 `.part` 数两遍（先扫掉一次，walk 时文件已经没了但计数早加过），
    //    于是报「已删 7 个」而实际只有 6 个文件 —— 第一版就是这么写的，试出来的。
    for d in [svsep.clone(), writable.join("svsep")] {
        let (f, b) = sweep_part_files(&d);
        removed_files += f;
        removed_bytes += b;
    }

    'outer: for (label, dir) in targets {
        let mut stack = vec![dir.clone()];
        while let Some(d) = stack.pop() {
            if cancelled() {
                stopped = true;
                break 'outer;
            }
            let rd = match std::fs::read_dir(&d) {
                Ok(rd) => rd,
                // 目录不在 = 没什么可删，不是错误
                Err(_) => continue,
            };
            for ent in rd.flatten() {
                if cancelled() {
                    stopped = true;
                    break 'outer;
                }
                let p = ent.path();
                let is_dir = ent.file_type().map(|t| t.is_dir()).unwrap_or(false);
                if is_dir {
                    stack.push(p);
                    continue;
                }
                let size = ent.metadata().map(|m| m.len()).unwrap_or(0);
                match std::fs::remove_file(&p) {
                    Ok(()) => {
                        removed_files += 1;
                        removed_bytes += size;
                        // 界面每 200 个文件刷一次就够（它 2 秒才轮询一次状态）
                        if removed_files % 200 == 0 {
                            on_progress(removed_files, removed_bytes);
                        }
                    }
                    Err(_) => {
                        if locked.len() < 8 {
                            locked.push(format!("{label}：{}", p.display()));
                        }
                    }
                }
            }
        }
    }
    on_progress(removed_files, removed_bytes);

    json!({
        "ok": true,
        "cancelled": stopped,
        "removedBytes": removed_bytes,
        "removedFiles": removed_files,
        // 界面只报「有 N 个文件删不掉」，不把 8 条路径全铺开
        "lockedCount": locked.len(),
        "locked": locked,
    })
}

#[derive(Debug)]
struct ExtractReport {
    files: u64,
    bytes: u64,
}

/// 解一个 zip 到 `dest`，返回解出来多少。
///
/// `strip` 是要从每个条目名前面剥掉的一层目录名（带斜杠），剥不掉就原样保留。
/// 两个包的布局不同，必须显式说清楚：
///   * `svsep-models.zip` 里是 `models/…`，解到 `<可写>/svsep/` 要剥掉 `models/`；
///   * `svsep-runtime.zip` 里是 `runtime/…`，解到 `<root>/app/data/svsep/` 要**留着**
///     （那边正好需要 `runtime/python.exe` 这一层）。
/// 解到哪一层写错不会报错，只会在用户点「开始分离」时才现形。
///
/// 只支持「存 + deflate」两种方式 —— 这也是 zip 的实际全部（bzip2/lzma 在
/// Windows 自带的压缩里根本不会产生）。用 flate2（依赖树里本来就有，见 Cargo.toml）。
fn extract_zip(
    zip_path: &Path,
    dest: &Path,
    strip: &str,
    // `FnMut` 而不是 `Fn`：单测要往 Vec 里记进度，`Fn` 连这个都做不到
    // （真实调用点只是往全局静态里写，两者都满足）。
    mut on_progress: impl FnMut(u64, u64),
) -> Result<ExtractReport, String> {
    let f = std::fs::File::open(zip_path).map_err(|e| format!("打开 zip 失败：{e}"))?;
    let mut zip = ZipReader::new(f)?;
    let entries = zip.entries()?;
    let mut report = ExtractReport { files: 0, bytes: 0 };
    let mut done_src: u64 = 0;
    // ⚠️ 先算出来，别写在循环里 —— runtime 有 2.4 万个条目，
    //    每轮重新 sum 一遍就是 6 亿次加法（实测能感到卡）。
    //    `.max(1)` 要跟下面 `done_src` 的口径**一模一样**：零字节条目
    //    （目录、空文件）按 1 计数，否则分子会超过分母、进度条冲到 100% 以上。
    let total_src: u64 = entries.iter().map(|x| x.compressed_size.max(1)).sum();

    for e in &entries {
        // 跳过的条目（目录、空名）也要推进进度，否则分母算了它们、
        // 分子没算，进度条就永远到不了头（extract_zip 的单测抓到过这个）。
        done_src += e.compressed_size.max(1);

        // 防目录穿越（zip slip）：剥掉外壳后逐段检查，`..` 一律拒
        let name = e.name.replace('\\', "/");
        let rel = name.trim_start_matches("./");
        let rel = if strip.is_empty() { rel } else { rel.strip_prefix(strip).unwrap_or(rel) };
        if !rel.is_empty() && !rel.ends_with('/') {
            if rel.split('/').any(|c| c == ".." || c == "") {
                return Err(format!("zip 里的路径不安全：{name}"));
            }
            let out = dest.join(rel);
            if let Some(parent) = out.parent() {
                std::fs::create_dir_all(parent).map_err(|e| format!("建目录失败：{e}"))?;
            }
            // ⚠️ 这里必须把条目名带上：`extract_one` 里的 io 错误（`failed to
            //    fill whole buffer` 之类）本身指不到是哪个文件，两万多条里
            //    靠猜是查不出来的（runtime.zip 就是这么卡了一轮）。
            zip.extract_one(e, &out).map_err(|er| {
                format!(
                    "解「{name}」失败（method={} csize={} off={}）：{er}",
                    e.method, e.compressed_size, e.data_offset
                )
            })?;
            report.files += 1;
            report.bytes += std::fs::metadata(&out).map(|m| m.len()).unwrap_or(0);
        }
        on_progress(done_src, total_src);
    }
    Ok(report)
}

/* ── 极简 zip 读取器 ──────────────────────────────────────────────────── */

struct ZipEntry {
    name: String,
    method: u16,
    compressed_size: u64,
    data_offset: u64,
}

/// 从中央目录条目的扩展区里读 Zip64 的那些**溢出项**。
///
/// Zip64 扩展块的布局是固定的：原始(8) + 压缩后(8) + 本地头偏移(8) + 盘号(4)，
/// 但**只写那些在普通字段里写不下（被写成 0xFFFFFFFF）的项**，所以只能顺着
/// 数、不能按固定偏移取 —— 哪些项在块里，完全由调用方传进来的两个哨兵决定。
///
/// ⚠️ 这里踩过一个很贵的坑：一开始只认「压缩后大小」溢出，结果 runtime.zip 里
/// 所有**本地头偏移超过 4 GiB** 的条目（`runtime/Lib/site-packages/torch/lib/
/// torch_cpu.lib` 等）数据偏移读到的是哨兵 `0xFFFFFFFF`，症状是
/// `failed to fill whole buffer` —— 而错误里没有条目名时，两万多条根本查不出来。
/// 所以现在两个哨兵一起处理，并且返回值一定落在真实的文件位置上。
fn zip64_resolve(extra: &[u8], big_size: bool, big_off: bool) -> Option<(u64, u64)> {
    let mut i = 0usize;
    while i + 4 <= extra.len() {
        let id = u16::from_le_bytes([extra[i], extra[i + 1]]);
        let size = u16::from_le_bytes([extra[i + 2], extra[i + 3]]) as usize;
        let body = extra.get(i + 4..i + 4 + size)?;
        if id == 0x0001 {
            let take = |at: usize| -> Option<u64> {
                let b = body.get(at..at + 8)?;
                Some(u64::from_le_bytes([
                    b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7],
                ]))
            };
            // 顺序固定：原始大小、压缩后大小、本地头偏移、盘号。只数溢出的项。
            let mut at = 0usize;
            let mut csize = 0u64;
            if big_size {
                if body.len() >= 16 {
                    // 原始大小也在块里，压缩后大小排在它后面
                    csize = take(8)?;
                    at = 16;
                } else {
                    csize = take(0)?;
                    at = 8;
                }
            }
            let mut lho = 0u64;
            if big_off {
                lho = take(at)?;
            }
            return Some((csize, lho));
        }
        i += 4 + size;
    }
    None
}

struct ZipReader<R: std::io::Read + std::io::Seek> {
    r: R,
    entries: Vec<ZipEntry>,
}

impl<R: std::io::Read + std::io::Seek> ZipReader<R> {
    fn new(r: R) -> Result<Self, String> {
        Ok(Self { r, entries: Vec::new() })
    }

    /// 从中央目录读条目表。
    ///
    /// 找中央目录：从文件末尾往前找 EOCD 签名（`PK\x05\x06`）。
    /// 注释最长 65535 字节，所以最多回看这么大的范围。
    fn entries(&mut self) -> Result<Vec<ZipEntry>, String> {
        use std::io::SeekFrom;
        let size = self.r.seek(SeekFrom::End(0)).map_err(|e| e.to_string())?;
        let tail_len = size.min(66_000) as usize;
        self.r
            .seek(SeekFrom::Start(size - tail_len as u64))
            .map_err(|e| e.to_string())?;
        let mut tail = vec![0u8; tail_len];
        self.r.read_exact(&mut tail).map_err(|e| e.to_string())?;

        // ⚠️ 是**第一个**候选，不是最后一个 —— 回看的窗口是**文件末尾** 66 KB，
        //    而大包的中央目录本身就有几 MB（runtime.zip: 2.4 MB），EOCD 因此
        //    落在窗口最前面，而窗口后半段那些压缩数据里完全可能碰巧出现
        //    `PK\x05\x06` 这四个字节。取最后一个就会挑中假签名、读出一张空表
        //    （实测就是这么栽的：4.6 GB 的包解出 0 个文件）。
        //    代价是文件注释里若正好含这四个字节会误判 —— 我们的包没有注释，
        //    而且真正的 EOCD 一定在注释**之前**，所以「第一个」反而更稳。
        let eocd = tail
            .windows(4)
            .position(|w| w == [0x50, 0x4b, 0x05, 0x06])
            .ok_or_else(|| "不是有效的 zip（找不到中央目录）".to_string())?;
        // ⚠️ EOCD 是固定 22 字节：签名(4) 本盘号(2) 目录起始盘(2) 本盘条目(2)
        //    总条目(2) 目录大小(4) 目录偏移(4) 注释长度(2)。
        //    `base` 取的是签名之后第一个字节（= 本盘号），所以相对 `base`：
        //    总条目 +6、目录大小 +8、目录偏移 +12。
        //    （我一度以为这里整体漏了 2 字节、改成 +8/+10/+14，结果四条 zip 单测
        //      全红 failed to fill whole buffer —— +14 读到的是 cdSize 的低半截。
        //      要动这段先看真包尾部的字节，别凭直觉。）
        let base = eocd + 4;
        if base + 16 > tail.len() {
            return Err("zip 中央目录被截断".to_string());
        }
        let mut count = u16::from_le_bytes([tail[base + 6], tail[base + 7]]) as usize;
        let cd_size = u32::from_le_bytes([
            tail[base + 8],
            tail[base + 9],
            tail[base + 10],
            tail[base + 11],
        ]) as u64;
        let mut cd_off = u32::from_le_bytes([
            tail[base + 12],
            tail[base + 13],
            tail[base + 14],
            tail[base + 15],
        ]) as u64;

        // ⚠️ Zip64：真包可能比 4 GiB 还大，那时 EOCD 里的 32 位 cdOffset 装不下，
        //    规范的做法是写 `0xFFFFFFFF` 占位、真值放进 Zip64 EOCD。
        //    不认这个占位就会拿 4294967295 当偏移去读 —— 那一段正好落在
        //    文件数据里，读出来的「中央目录」第一条就不是 `PK\x01\x02`，
        //    于是一张**空表**，一个文件都解不出来（实测：4.6 GB 的
        //    runtime.zip 解出 0 个文件，而且**不报错**）。
        //    models.zip 只有 463 MB，不是 Zip64，所以这条只有大包才踩得到。
        if cd_off == 0xFFFF_FFFF {
            let loc = tail
                .windows(4)
                .rposition(|w| w == [0x50, 0x4b, 0x06, 0x07])
                .ok_or_else(|| "zip 是 Zip64，但找不到 Zip64 定位器".to_string())?;
            // 定位器：签名(4) + 所在盘(4) + Zip64 EOCD 的偏移(8) + 盘总数(4)
            if loc + 20 > tail.len() {
                return Err("Zip64 定位器不完整".to_string());
            }
            let z64 = u64::from_le_bytes([
                tail[loc + 8],
                tail[loc + 9],
                tail[loc + 10],
                tail[loc + 11],
                tail[loc + 12],
                tail[loc + 13],
                tail[loc + 14],
                tail[loc + 15],
            ]);
            let mut rec = [0u8; 56];
            self.r
                .seek(SeekFrom::Start(z64))
                .map_err(|e| e.to_string())?;
            self.r.read_exact(&mut rec).map_err(|e| e.to_string())?;
            if rec[0..4] != [0x50, 0x4b, 0x06, 0x06] {
                return Err("zip 的 Zip64 EOCD 不对".to_string());
            }
            let u64_at = |i: usize| {
                u64::from_le_bytes([
                    rec[i],
                    rec[i + 1],
                    rec[i + 2],
                    rec[i + 3],
                    rec[i + 4],
                    rec[i + 5],
                    rec[i + 6],
                    rec[i + 7],
                ])
            };
            let rec = u64_at(32);
            if rec > 0 && rec < u32::MAX as u64 {
                count = rec as usize;
            }
            cd_off = u64_at(48);
        }

        self.r
            .seek(SeekFrom::Start(cd_off))
            .map_err(|e| e.to_string())?;
        let mut cd = vec![0u8; cd_size as usize];
        self.r.read_exact(&mut cd).map_err(|e| e.to_string())?;

        let mut out = Vec::with_capacity(count);
        let mut p = 0usize;
        while p + 46 <= cd.len() {
            if cd[p..p + 4] != [0x50, 0x4b, 0x01, 0x02] {
                break;
            }
            let method = u16::from_le_bytes([cd[p + 10], cd[p + 11]]);
            let csize = u32::from_le_bytes([cd[p + 20], cd[p + 21], cd[p + 22], cd[p + 23]]) as u64;
            let nlen = u16::from_le_bytes([cd[p + 28], cd[p + 29]]) as usize;
            let elen = u16::from_le_bytes([cd[p + 30], cd[p + 31]]) as usize;
            let clen = u16::from_le_bytes([cd[p + 32], cd[p + 33]]) as usize;
            let lho = u32::from_le_bytes([cd[p + 42], cd[p + 43], cd[p + 44], cd[p + 45]]) as u64;
            let name_at = p + 46;
            if name_at + nlen > cd.len() {
                break;
            }
            let name = String::from_utf8_lossy(&cd[name_at..name_at + nlen]).to_string();
            // 单个条目超过 4 GiB 时 csize 写 0xFFFFFFFF，数据位置超过 4 GiB 时
            // lho 也写 0xFFFFFFFF —— 两个哨兵都要去 Zip64 扩展块里换回真值。
            // 只认前一个是 runtime.zip 上栽过的坑（见 zip64_resolve 的注释）。
            let (csize, lho) = if csize == 0xFFFF_FFFF || lho == 0xFFFF_FFFF {
                let (c, o) = zip64_resolve(
                    &cd[name_at + nlen..name_at + nlen + elen],
                    csize == 0xFFFF_FFFF,
                    lho == 0xFFFF_FFFF,
                )
                .ok_or_else(|| format!("zip 条目「{name}」是 Zip64，但读不到真实大小/偏移"))?;
                (if csize == 0xFFFF_FFFF { c } else { csize }, if lho == 0xFFFF_FFFF { o } else { lho })
            } else {
                (csize, lho)
            };
            out.push(ZipEntry {
                name,
                method,
                compressed_size: csize,
                data_offset: lho,
            });
            p = name_at + nlen + elen + clen;
        }
        self.entries = out;
        Ok(std::mem::take(&mut self.entries))
    }

    fn extract_one(&mut self, e: &ZipEntry, out: &Path) -> Result<(), String> {
        use std::io::{SeekFrom, Write};
        // 本地文件头：签名(4) + 版本(2) + 标志(2) + 方式(2) + 时间(2) + 日期(2)
        //            + crc(4) + 压缩后(4) + 原始(4) + 名字长(2) + 扩展长(2) + 名字 + 扩展
        self.r
            .seek(SeekFrom::Start(e.data_offset))
            .map_err(|er| er.to_string())?;
        let mut head = [0u8; 30];
        self.r.read_exact(&mut head).map_err(|er| er.to_string())?;
        if head[0..4] != [0x50, 0x4b, 0x03, 0x04] {
            return Err(format!("zip 条目「{}」的本地头不对", e.name));
        }
        let nlen = u16::from_le_bytes([head[26], head[27]]) as u64;
        let elen = u16::from_le_bytes([head[28], head[29]]) as u64;
        self.r
            .seek(SeekFrom::Start(e.data_offset + 30 + nlen + elen))
            .map_err(|er| er.to_string())?;

        let mut comp = vec![0u8; e.compressed_size as usize];
        self.r.read_exact(&mut comp).map_err(|er| er.to_string())?;

        let mut f = std::fs::File::create(out).map_err(|er| format!("写文件失败：{er}"))?;
        match e.method {
            0 => {
                f.write_all(&comp).map_err(|er| er.to_string())?;
            }
            8 => {
                let mut d = flate2::read::DeflateDecoder::new(&comp[..]);
                std::io::copy(&mut d, &mut f).map_err(|er| format!("解压失败：{er}"))?;
            }
            m => return Err(format!("zip 里用了不支持的压缩方式 {m}（只支持存/deflate）")),
        }
        Ok(())
    }
}

/* ══════════════════════════════════ 单测 ══════════════════════════════════ */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_state_tells_apart_missing_partial_and_ok() {
        let dir = std::env::temp_dir().join("vss-svsep-test-models");
        let _ = std::fs::create_dir_all(&dir);
        let f = dir.join("UVR-MDX-NET-Inst_HQ_3.onnx");

        let _ = std::fs::remove_file(&f);
        assert_eq!(model_state(&dir, "UVR-MDX-NET-Inst_HQ_3.onnx", 100).0, "missing");

        std::fs::write(&f, vec![0u8; 50]).unwrap();
        assert_eq!(model_state(&dir, "UVR-MDX-NET-Inst_HQ_3.onnx", 100).0, "partial");

        std::fs::write(&f, vec![0u8; 150]).unwrap();
        assert_eq!(model_state(&dir, "UVR-MDX-NET-Inst_HQ_3.onnx", 100).0, "ok");
        assert_eq!(model_state(&dir, "UVR-MDX-NET-Inst_HQ_3.onnx", 100).1, 150);

        let _ = std::fs::remove_file(&f);
        let _ = std::fs::remove_dir(&dir);
    }

    #[test]
    fn brief_cuts_long_bodies() {
        assert_eq!(brief("  hi  "), "hi");
        let long = "x".repeat(500);
        let b = brief(&long);
        assert!(b.ends_with('…'));
        assert_eq!(b.chars().count(), 201);
    }

    #[test]
    fn ready_needs_both_ok_and_ready() {
        assert!(is_ready(&json!({"ok": true, "ready": true})));
        assert!(!is_ready(&json!({"ok": true})));
        assert!(!is_ready(&json!({"ok": false, "ready": true})));
        assert!(!is_ready(&json!({"ok": "ready"})));
    }

    /* ══ extract_zip ══════════════════════════════════════════════════════
       这是「手写 zip 读取器」唯一真正的证伪手段 —— 两个包的**真实**内容
       （485 MB / 4.7 GB）不进仓库，靠肉眼审代码又看不出偏移量算错，
       所以这里现场造一个两种压缩方式都有的小 zip，把整条路走一遍。 */

    fn crc32(data: &[u8]) -> u32 {
        let mut c: u32 = 0xFFFF_FFFF;
        for &b in data {
            c ^= b as u32;
            for _ in 0..8 {
                let lsb = c & 1;
                c >>= 1;
                if lsb != 0 {
                    c ^= 0xEDB8_8320;
                }
            }
        }
        !c
    }

    /// 造一个最小但合法的 zip。`deflate = true` 走压缩（方式 8），否则原样存（方式 0）。
    fn make_zip(items: &[(&str, &[u8], bool)]) -> Vec<u8> {
        use std::io::Write;
        let mut out: Vec<u8> = Vec::new();
        let mut central: Vec<u8> = Vec::new();

        for &(name, data, deflate) in items {
            let crc = crc32(data);
            let (method, body): (u16, Vec<u8>) = if deflate {
                let mut e =
                    flate2::write::DeflateEncoder::new(Vec::new(), flate2::Compression::default());
                e.write_all(data).unwrap();
                (8, e.finish().unwrap())
            } else {
                (0, data.to_vec())
            };
            let off = out.len() as u32;
            let n = name.as_bytes();

            out.extend_from_slice(&[0x50, 0x4b, 0x03, 0x04]); // 本地头签名
            out.extend_from_slice(&20u16.to_le_bytes()); // 解压需要 2.0
            out.extend_from_slice(&0u16.to_le_bytes()); // 标志
            out.extend_from_slice(&method.to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes()); // 时间
            out.extend_from_slice(&0u16.to_le_bytes()); // 日期
            out.extend_from_slice(&crc.to_le_bytes());
            out.extend_from_slice(&(body.len() as u32).to_le_bytes()); // 压缩后
            out.extend_from_slice(&(data.len() as u32).to_le_bytes()); // 原始
            out.extend_from_slice(&(n.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes()); // 扩展区长度
            out.extend_from_slice(n);
            out.extend_from_slice(&body);

            central.extend_from_slice(&[0x50, 0x4b, 0x01, 0x02]); // 中央目录签名
            central.extend_from_slice(&20u16.to_le_bytes()); // 生成版本
            central.extend_from_slice(&20u16.to_le_bytes()); // 解压版本
            central.extend_from_slice(&0u16.to_le_bytes()); // 标志
            central.extend_from_slice(&method.to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes()); // 时间
            central.extend_from_slice(&0u16.to_le_bytes()); // 日期
            central.extend_from_slice(&crc.to_le_bytes());
            central.extend_from_slice(&(body.len() as u32).to_le_bytes());
            central.extend_from_slice(&(data.len() as u32).to_le_bytes());
            central.extend_from_slice(&(n.len() as u16).to_le_bytes());
            central.extend_from_slice(&0u16.to_le_bytes()); // 扩展区
            central.extend_from_slice(&0u16.to_le_bytes()); // 注释
            central.extend_from_slice(&0u16.to_le_bytes()); // 起始磁盘
            central.extend_from_slice(&0u16.to_le_bytes()); // 内部属性
            central.extend_from_slice(&0u32.to_le_bytes()); // 外部属性
            central.extend_from_slice(&off.to_le_bytes()); // 本地头偏移
            central.extend_from_slice(n);
        }

        let cd_off = out.len() as u32;
        let cd_size = central.len() as u32;
        out.extend_from_slice(&central);
        out.extend_from_slice(&[0x50, 0x4b, 0x05, 0x06]); // EOCD
        out.extend_from_slice(&0u16.to_le_bytes()); // 本盘号
        out.extend_from_slice(&0u16.to_le_bytes()); // 中央目录起始盘
        out.extend_from_slice(&(items.len() as u16).to_le_bytes());
        out.extend_from_slice(&(items.len() as u16).to_le_bytes());
        out.extend_from_slice(&cd_size.to_le_bytes());
        out.extend_from_slice(&cd_off.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes()); // 注释长度
        out
    }

    #[test]
    fn extract_zip_handles_both_methods_and_strip() {
        let base = std::env::temp_dir().join("vss-svsep-zip-ok");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let zip_path = base.join("t.zip");
        let dest = base.join("out");

        let big = "BS-Roformer".repeat(500); // 1 KB 重复文本，deflate 会真的压
        let stored: Vec<u8> = (0u16..=511).map(|i| (i % 251) as u8).collect();
        let zip = make_zip(&[
            ("models/", b"", true), // 纯目录条目 —— 必须被跳过
            ("models/a.onnx", big.as_bytes(), true),
            ("models/b.ckpt", &stored, false),
            ("outside.txt", "strip 没命中".as_bytes(), true),
        ]);
        std::fs::write(&zip_path, &zip).unwrap();

        let mut ticks: Vec<(u64, u64)> = Vec::new();
        let rep = extract_zip(&zip_path, &dest, "models/", |d, t| ticks.push((d, t))).unwrap();

        assert_eq!(rep.files, 3, "目录条目不该算成一个文件");
        assert_eq!(
            std::fs::read_to_string(dest.join("a.onnx")).unwrap(),
            big,
            "deflate 条目解出来必须字节一致"
        );
        assert_eq!(
            std::fs::read(dest.join("b.ckpt")).unwrap(),
            stored,
            "存（方式 0）条目解出来必须字节一致"
        );
        // strip 只对以它开头的条目生效，没命中的原样保留
        assert!(dest.join("outside.txt").is_file());
        assert!(dest.join("models").join("a.onnx").exists() == false);
        assert_eq!(ticks.len(), 4, "每**条目**报一次进度（含被跳过的目录）");
        let (done, total) = *ticks.last().unwrap();
        assert_eq!(done, total, "最终进度必须刚好 100%");
        assert!(ticks.windows(2).all(|w| w[0].0 <= w[1].0), "进度只能往前走");

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn extract_zip_keeps_the_top_level_when_strip_is_empty() {
        // runtime 包就是这么用的：必须**留住** `runtime/` 那一层，
        // 因为后面找的是 `<root>/app/data/svsep/runtime/python.exe`。
        let base = std::env::temp_dir().join("vss-svsep-zip-nostrip");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let zip_path = base.join("t.zip");
        let dest = base.join("out");
        std::fs::write(
            &zip_path,
            make_zip(&[("runtime/python.exe", b"MZ fake", false)]),
        )
        .unwrap();

        extract_zip(&zip_path, &dest, "", |_, _| {}).unwrap();
        assert!(dest.join("runtime").join("python.exe").is_file());
        let _ = std::fs::remove_dir_all(&base);
    }

    /// `zip64_resolve` 管的是「普通字段写不下时去哪拿真值」。三种溢出组合都要对，
    /// 尤其是**只有偏移溢出**那种 —— runtime.zip 上就是栽在它（`csize` 正常、
    /// `lho` 是哨兵，结果拿 0xFFFFFFFF 当文件位置去读）。
    #[test]
    fn zip64_resolve_handles_every_overflow_combination() {
        let block = |vals: &[u64]| {
            let mut b: Vec<u8> = Vec::new();
            b.extend_from_slice(&0x0001u16.to_le_bytes());
            b.extend_from_slice(&((vals.len() * 8) as u16).to_le_bytes());
            for v in vals {
                b.extend_from_slice(&v.to_le_bytes());
            }
            b
        };

        // ① 只有偏移溢出：块里就一个数
        let e = block(&[4_300_000_000]);
        assert_eq!(zip64_resolve(&e, false, true), Some((0, 4_300_000_000)));
        // ② 只有压缩后大小溢出
        let e = block(&[9_000_000_000]);
        assert_eq!(zip64_resolve(&e, true, false), Some((9_000_000_000, 0)));
        // ③ 两个都溢出：原始、压缩后、偏移
        let e = block(&[11, 22, 4_400_000_000]);
        assert_eq!(zip64_resolve(&e, true, true), Some((22, 4_400_000_000)));
        // ④ 没有 Zip64 扩展块就老实回 None，别编一个数出来
        let e = [0xAAu8, 0xBB, 0x04, 0x00, 1, 2, 3, 4];
        assert_eq!(zip64_resolve(&e, true, true), None);
        // ⑤ 声称溢出了、块里却没那么多字节
        let e = block(&[7]);
        assert_eq!(zip64_resolve(&e, true, true), None);
    }

    /// Zip64：真包可能超过 4 GiB，那时 EOCD 的 cdOffset 是占位符 0xFFFFFFFF，
    /// 真值在 Zip64 EOCD 里。**这个必须测** —— runtime.zip 恰好就是这种
    /// （4.87 GB / 27,138 条），不认占位符就会静悄悄地解出 0 个文件。
    #[test]
    fn reads_zip64_when_the_pack_is_over_4gb() {
        let base = std::env::temp_dir().join("vss-svsep-zip64");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let zip_path = base.join("t.zip");

        // 先造一个普通 zip，然后把 EOCD 里的 cdOffset 改成占位符
        let mut z = make_zip(&[
            ("models/", b"", true),
            ("models/a.onnx", b"hello", false),
        ]);
        // EOCD 是固定 22 字节、以文件末尾收尾，字段相对**末尾**的位置是：
        //   签名 n-22..n-18 / 本盘号 n-18 / 目录起始盘 n-16 / 本盘条目 n-14
        //   总条目 n-12 / 目录大小 n-10..n-6 / 目录偏移 n-6..n-2 / 注释长度 n-2
        // 所以 cdOffset 在 n-6..n-2。
        // ⚠️ 这里我错过两次（先按 n-11、又按 n-10 读），两次都让 Zip64 EOCD 里
        //    落进一个垃圾偏移，症状都是「failed to fill whole buffer」。
        //    拿不准就用真包数一遍：models.zip 的 n-6..n-2 读出来必须是 484976181。
        let real_cd_off = {
            let n = z.len();
            let v = u32::from_le_bytes([z[n - 6], z[n - 5], z[n - 4], z[n - 3]]);
            z[n - 6..n - 2].copy_from_slice(&0xFFFF_FFFFu32.to_le_bytes());
            v as u64
        };

        // Zip64 EOCD：签名(4) 记录长(8) 版本(4) 盘号(4) 起始盘(4)
        //            + 本盘条目(8) 总条目(8) 目录大小(8) 目录偏移(8)
        let mut rec: Vec<u8> = Vec::new();
        rec.extend_from_slice(&[0x50, 0x4b, 0x06, 0x06]);
        rec.extend_from_slice(&44u64.to_le_bytes());
        rec.extend_from_slice(&45u16.to_le_bytes());
        rec.extend_from_slice(&45u16.to_le_bytes());
        rec.extend_from_slice(&0u32.to_le_bytes());
        rec.extend_from_slice(&0u32.to_le_bytes());
        rec.extend_from_slice(&2u64.to_le_bytes()); // 本盘条目
        rec.extend_from_slice(&2u64.to_le_bytes()); // 总条目
        rec.extend_from_slice(&57u64.to_le_bytes()); // 中央目录大小
        rec.extend_from_slice(&real_cd_off.to_le_bytes()); // 真正的偏移

        let z64_at = z.len() as u64;
        z.extend_from_slice(&rec);

        // 定位器：签名(4) 所在盘(4) Zip64 EOCD 的偏移(8) 盘总数(4)
        z.extend_from_slice(&[0x50, 0x4b, 0x06, 0x07]);
        z.extend_from_slice(&0u32.to_le_bytes());
        z.extend_from_slice(&z64_at.to_le_bytes());
        z.extend_from_slice(&1u32.to_le_bytes());
        std::fs::write(&zip_path, &z).unwrap();


        let dest = base.join("out");

        let rep = extract_zip(&zip_path, &dest, "models/", |_, _| {}).expect("Zip64 包必须解得出来");
        assert_eq!(rep.files, 1, "目录条目不算文件");
        assert_eq!(std::fs::read(dest.join("a.onnx")).unwrap(), b"hello");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// 把**两个**哨兵一起写进中央目录（csize 与 lho 都是 0xFFFFFFFF），真值只留在
    /// Zip64 扩展块里 —— 这就是 runtime.zip 里那些「数据位置超过 4 GiB」条目的真实形状。
    ///
    /// 为什么要单独来一遍：`zip64_resolve` 的值级测试只能证明「按顺序数」是对的，
    /// **证明不了磁盘上两个字段各自映射到哪个量**。真值顺序搞反的话，压缩后大小会拿到
    /// 一个巨大的偏移、偏移会拿到一个很小的长度，结果同样是 `failed to fill whole buffer`
    /// —— 和当初那个 bug 一模一样的症状。
    #[test]
    fn reads_zip64_when_both_size_and_offset_overflow() {
        let base = std::env::temp_dir().join("vss-svsep-zip64-both");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let zip_path = base.join("t.zip");

        let mut z = make_zip(&[("models/", b"", true), ("models/a.onnx", b"hello", false)]);
        // 先用**没改过**的原包落地一次，好让读取器自己报出真实长度（见下）
        std::fs::write(&zip_path, &z).unwrap();

        // 中央目录第一条（"models/"）的 46 字节头起点
        let cd_off = {
            let n = z.len();
            u32::from_le_bytes([z[n - 6], z[n - 5], z[n - 4], z[n - 3]]) as usize
        };
        let p = cd_off;
        assert_eq!(&z[p..p + 4], [0x50, 0x4b, 0x01, 0x02], "中央目录起点没找对");
        let nlen = u16::from_le_bytes([z[p + 28], z[p + 29]]) as usize;
        let elen = u16::from_le_bytes([z[p + 30], z[p + 31]]) as usize;
        let clen = u16::from_le_bytes([z[p + 32], z[p + 33]]) as usize;
        assert_eq!(elen, 0, "造出来的条目本来不该有扩展块");
        assert_eq!(&z[p + 46..p + 46 + nlen], b"models/", "第一条不是那个目录条目");

        // 先把真值读出来，再动手改（改完字段就变哨兵了）
        //
        // ⚠️ 中央目录 46 字节头的字段位置（数着签名写，别凭直觉）：
        //    0 签名 / 4 生成版本 / 6 解压版本 / 8 标志 / 10 方式 / 12 时间 / 14 日期
        //    16 crc / **20 压缩后** / **24 原始** / 28 名字长 / 30 扩展长 / 32 注释长
        //    34 起始盘 / 36 内部属性 / 38 外部属性 / **42 本地头偏移**
        // 我第一版把「压缩后大小」按 +20 读、原始按 +24 读，实际读到的是**名字长(7)**
        // 和 0 —— 于是 Zip64 块里被写进 (7, 0)，`zip64_resolve` 老实按「原始大小也在
        // 块里」取 body[8..16]，拿到的偏移是 0，症状恰好是它最该防的那个
        // 「本地头不对 / failed to fill whole buffer」。**代码没错，是测试的字节位置错了。**
        let real_csize =
            u32::from_le_bytes([z[p + 20], z[p + 21], z[p + 22], z[p + 23]]) as u64;
        let real_usize =
            u32::from_le_bytes([z[p + 24], z[p + 25], z[p + 26], z[p + 27]]) as u64;
        let real_lho = u32::from_le_bytes([z[p + 42], z[p + 43], z[p + 44], z[p + 45]]) as u64;
        assert_eq!(real_usize, 0, "造出来的目录条目原始大小应当是 0 字节");
        assert_eq!(real_lho, 0, "第一个条目就在文件开头，本地头偏移应当是 0");

        // 手工拼 Zip64 扩展块：原始(8) + 压缩后(8) + 本地头偏移(8)。
        // ⚠️ 三个都要写 —— `zip64_resolve` 是按「原始大小也在块里」推出压缩后大小
        //    排在 8..16 的（body.len() >= 16 那条分支）。
        let mut e: Vec<u8> = Vec::new();
        e.extend_from_slice(&0x0001u16.to_le_bytes());
        e.extend_from_slice(&24u16.to_le_bytes());
        e.extend_from_slice(&real_usize.to_le_bytes()); // 原始大小（目录条目，0 字节）
        e.extend_from_slice(&real_csize.to_le_bytes()); // 压缩后大小（deflate 后的空内容）
        e.extend_from_slice(&real_lho.to_le_bytes()); // 本地头偏移
        // ⚠️ 扩展长字段写的是**整块**长度（4 字节头 + 24 字节内容 = 28）。
        //    写成 24 会让读取器少切 4 字节，`zip64_resolve` 取 body 时越界 → 回 None，
        //    症状是「是 Zip64，但读不到真实大小/偏移」。这个字段必须等于 `e.len()`。
        assert_eq!(e.len(), 28, "Zip64 扩展块应当是 4 + 24 字节");

        // 头 46 字节 | 名字 | 扩展 | 注释 —— 按这个顺序重拼（zip 的字段顺序是固定的）
        let mut rec: Vec<u8> = Vec::new();
        rec.extend_from_slice(&z[p..p + 20]); // 到 crc 为止
        rec.extend_from_slice(&0xFFFF_FFFFu32.to_le_bytes()); // 压缩后大小 = 哨兵
        rec.extend_from_slice(&z[p + 24..p + 28]); // 原始大小
        rec.extend_from_slice(&z[p + 28..p + 30]); // 名字长
        rec.extend_from_slice(&(e.len() as u16).to_le_bytes()); // 扩展长 = 整块长度
        rec.extend_from_slice(&z[p + 32..p + 42]); // 注释长 / 盘号 / 属性
        rec.extend_from_slice(&0xFFFF_FFFFu32.to_le_bytes()); // 本地头偏移 = 哨兵
        rec.extend_from_slice(&z[p + 46..p + 46 + nlen]); // 名字
        rec.extend_from_slice(&e); // 扩展块
        rec.extend_from_slice(&z[p + 46 + nlen..p + 46 + nlen + clen]); // 注释
        // 目录结束位置 = 文件长 − EOCD(22) − 注释长，**一步到位量出来**。
        let dir_end = z.len() - 22 - u16::from_le_bytes([z[z.len() - 2], z[z.len() - 1]]) as usize;
        // 两个**中央目录记录**的真实长度：不靠手算，也不拿别的量来顶替 ——
        // 直接按目录记录自己的字段量（46 定长头 + 名字 + 扩展 + 注释）。
        //
        // ⚠️ 这里连踩三个「用长度反推偏移」的坑，都别再犯：
        //   ① 拿 `es[1].data_offset - es[0].data_offset` 当第一条**目录记录**长度 ——
        //      那量的是**本地段**（本地头 30 + 名字 7 + deflate 空体 2 = 39），
        //      而目录记录是 53（46 + 名字 7 + 扩展 0）。**两个完全不同的量**。
        //   ② `new_cd_size = rec.len() - clen` → 只剩第一条，少了后面那条。
        //   ③ 从 `z.len() - cd_off - 22` 倒算旧目录长度 —— `split_off` 之后
        //      `z.len()` 已经不是「目录结束」那个位置，倒算必然偏。
        // 正确做法：目录区 = `cd_off .. dir_end`，逐条按上面公式量，加起来必须
        // 正好等于 `dir_end - cd_off`（这一步同时验证了字段偏移没读错）。
        let cd_len = dir_end - cd_off;
        let (first_rec_len, second_rec_len) = {
            let mut at = cd_off;
            let mut lens = Vec::new();
            while at + 46 <= dir_end {
                assert_eq!(&z[at..at + 4], b"PK\x01\x02", "第 {} 条目录记录签名不对", lens.len());
                // 名字长 +28、扩展长 +30、注释长 +32（⚠️ 不是 +20/+24，那是两个大小）
                let nl = u16::from_le_bytes([z[at + 28], z[at + 29]]) as usize;
                let el = u16::from_le_bytes([z[at + 30], z[at + 31]]) as usize;
                let cl = u16::from_le_bytes([z[at + 32], z[at + 33]]) as usize;
                let len = 46 + nl + el + cl;
                lens.push(len);
                at += len;
            }
            assert_eq!(at, dir_end, "目录记录加起来没有正好铺满目录区");
            assert_eq!(lens.len(), 2, "原始包应当正好 2 条目录记录");
            (lens[0], lens[1])
        };
        assert_eq!(
            (first_rec_len, second_rec_len),
            (53, 59),
            "目录记录 = 46 定长头 + 名字（models/ 7、models/a.onnx 13）+ 扩展"
        );

        // ⚠️ **别在原位补**。改了的第一条记录比原来长（多出的正是 Zip64 扩展块），
        //    第二条记录的起点因此要后移；若只是把它和旧 EOCD 一起搬到新位置，
        //    新记录就会盖住旧 EOCD **自己**（EOCD 里还写着旧的 cdOffset）。
        //    实测症状：EOCD 读出来 `cd_off=112`，而目录其实从 87 开始 ——
        //    于是 `read_exact` 读到文件尾，报 `failed to fill whole buffer`。
        //    正确做法：整段目录**重新拼** —— 改过的第一条 + 原第二条 + 新写的 EOCD。
        let second_rec = z[cd_off + first_rec_len..dir_end].to_vec();
        let new_cd_size = (rec.len() + second_rec.len()) as u32;
        assert_eq!(
            new_cd_size as usize - cd_len,
            rec.len() - first_rec_len,
            "目录长出来的部分应当正好是第一条记录长出来的部分"
        );
        z.truncate(cd_off);
        let cd_off_new = z.len() as u32;
        assert_eq!(cd_off_new as usize, cd_off, "目录起点不应当移动");
        z.extend_from_slice(&rec);
        z.extend_from_slice(&second_rec);
        let eocd_at = z.len();
        z.extend_from_slice(&[0x50, 0x4b, 0x05, 0x06]); // 签名
        z.extend_from_slice(&0u16.to_le_bytes()); // 本盘号
        z.extend_from_slice(&0u16.to_le_bytes()); // 目录起始盘
        z.extend_from_slice(&2u16.to_le_bytes()); // 本盘条目数
        z.extend_from_slice(&2u16.to_le_bytes()); // 总条目数
        z.extend_from_slice(&new_cd_size.to_le_bytes()); // 目录大小
        z.extend_from_slice(&cd_off_new.to_le_bytes()); // 目录偏移
        z.extend_from_slice(&0u16.to_le_bytes()); // 注释长度
        assert_eq!(z.len(), eocd_at + 22, "EOCD 应当是固定 22 字节");
        std::fs::write(&zip_path, &z).unwrap();

        // 条目表必须解出真实的偏移，而不是哨兵
        let entries = {
            let f = std::fs::File::open(&zip_path).unwrap();
            let mut r = ZipReader::new(f).unwrap();
            r.entries().unwrap()
        };
        assert_eq!(entries.len(), 2, "改完中央目录后条目数变了");
        assert_eq!(entries[0].name, "models/");
        assert_eq!(entries[0].data_offset, real_lho, "本地头偏移没从 Zip64 块里换回来");
        assert_eq!(
            entries[0].compressed_size, real_csize,
            "压缩后大小没从 Zip64 块里换回来 —— 两个哨兵的值搞反了就是这种症状"
        );
        assert_eq!(entries[1].name, "models/a.onnx");
        assert_eq!(entries[1].compressed_size, 5);

        // 而且整包还得真解得出内容（跳过目录条目，所以只有 1 个文件）
        let dest = base.join("out");
        let rep = extract_zip(&zip_path, &dest, "models/", |_, _| {}).expect("两个哨兵都溢出时必须解得出来");
        assert_eq!(rep.files, 1, "目录条目不算文件");
        assert_eq!(std::fs::read(dest.join("a.onnx")).unwrap(), b"hello");

        let _ = std::fs::remove_dir_all(&base);
    }

    /// 拿**真的**包跑一遍 —— 单测里的 zip 是我自己造的，而用户手上那两个包是
    /// PowerShell 的 `ZipFile.CreateFromDirectory` 造的（可能用数据描述符、
    /// 可能有 Zip64、字段排布也可能不一样），两个包都不进仓库，
    /// 所以这条用环境变量守着，平时直接跳过。
    ///
    ///     $env:VSS_REAL_ZIP='H:\工作站\资料归档\models.zip'; cargo test --bins reads_the_real -- --nocapture
    #[test]
    fn reads_the_real_packaged_zip_when_asked() {
        let Ok(path) = std::env::var("VSS_REAL_ZIP") else {
            return;
        };
        let f = std::fs::File::open(&path).expect("打开真包失败");
        let mut z = ZipReader::new(f).unwrap();
        let entries = z.entries().unwrap();
        let big = entries
            .iter()
            .max_by_key(|e| e.compressed_size)
            .expect("一个条目都没读到");
        println!(
            "{path}：{} 条，最大条目 {:?} method={} csize={}",
            entries.len(),
            big.name,
            big.method,
            big.compressed_size
        );
        assert!(big.compressed_size > 100_000_000, "最大的条目也太小了");

        // 真解一个出来 —— 偏移量算错就会在这里炸
        let out = std::env::temp_dir().join("vss-realzip-one");
        let _ = std::fs::remove_file(&out);
        z.extract_one(big, &out).unwrap();
        let got = std::fs::metadata(&out).unwrap().len();
        println!("解出来 {got} 字节");
        assert!(got > 400_000_000, "解出来的文件太小了：{got}");
        let _ = std::fs::remove_file(&out);
    }

    /// 走一遍**真的下载链路**：HTTP 流式下载 → 解压 → 删临时文件 → 复查状态。
    ///
    /// 这条刻意不去解 runtime（几 GB、十几分钟），而是解最小的那个真包
    /// `models.zip`（462 MB）。下载那一层代码 `fetch_bundle` 两个包共用，
    /// 而**分层**已经分别被覆盖过：`extract_zip` 的 `strip=""` 与 Zip64 偏移
    /// 由 `extracts_the_whole_real_runtime_pack_when_asked` 管，这里只管
    /// 「字节真的从网上流下来、进度回调真的被调、`.part` 真的被删掉」。
    ///
    /// 落点必须写在 `VSS_REAL_DOWNLOAD_DEST`（会往里写 730 MB）—— 默认写
    /// `%TEMP%`。**绝不要把它指向真的可写目录**：那会把用户装好的模型重下一遍。
    ///
    ///     $env:VSS_REAL_MODELS_URL='http://127.0.0.1:18080/models.zip'
    ///     $env:VSS_REAL_DOWNLOAD_DEST='H:\工作站\tmp-svsep-dl'
    ///     cargo test --bins downloads_the_real_models_pack -- --nocapture
    #[tokio::test]
    async fn downloads_the_real_models_pack_when_asked() {
        let Ok(url) = std::env::var("VSS_REAL_MODELS_URL") else {
            return;
        };
        let dest = std::env::var("VSS_REAL_DOWNLOAD_DEST")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir().join("vss-svsep-download-real"));
        // 每次都从**空目录**开始：这条测试要看的就是「没有 → 有」这个转变，
        // 留着上次的产物就证明不了任何事。
        let _ = std::fs::remove_dir_all(&dest);

        // 进度回调：既要能调，也要真的在涨（下载一半就断会停在很小的数上）
        let seen = std::sync::Arc::new(std::sync::Mutex::new((0u64, 0usize)));
        let seen2 = seen.clone();
        let t = std::time::Instant::now();
        // 这次真跑不允许暂停/停止，只验「下完 → 解好 → 临时文件清掉」
        static NO_PAUSE: AtomicBool = AtomicBool::new(false);
        static NO_STOP: AtomicBool = AtomicBool::new(false);
        let ctl = DownloadCtl::new(&NO_PAUSE, &NO_STOP, None);
        let out = download_models(&dest, &url, &ctl, move |got, _total| {
            let mut s = seen2.lock().unwrap();
            s.0 = got;
            s.1 += 1;
        })
        .await
        .expect("下载真包失败");
        let (got, ticks) = *seen.lock().unwrap();
        println!(
            "下了 {got} 字节（{ticks} 次进度回调），耗时 {:?}；收场 {}",
            t.elapsed(),
            match out {
                FetchOutcome::Done(_) => "Done",
                FetchOutcome::Paused { .. } => "Paused",
                FetchOutcome::Cancelled => "Cancelled",
            }
        );
        assert!(got > 400_000_000, "下载字节数太少：{got}");
        assert!(ticks > 10, "进度回调只被调了 {ticks} 次");

        let models = models_dir(&dest);
        for name in [UVR_MODEL, ROFORMER_MODEL, "download_checks.json", "BS-Roformer-SW.yaml"] {
            assert!(
                models.join(name).is_file(),
                "解压后缺文件：{name}（落点 {}）",
                models.display()
            );
        }
        // 最大的那个模型不能是空壳
        let big = std::fs::metadata(models.join(ROFORMER_MODEL)).unwrap().len();
        assert!(big > 400_000_000, "{ROFORMER_MODEL} 只有 {big} 字节，没解全");

        // 临时 zip 与 `.part` 都该没了 —— 它有几 GB，留着毫无用处
        for leftover in ["svsep-models.zip", "svsep-models.zip.part"] {
            assert!(
                !models.join(leftover).exists(),
                "临时文件没删掉：{leftover}"
            );
        }
        // 状态复查要走通（界面就是靠它把按钮换成「已就绪」的）
        let st = models_status(&dest);
        println!("models_status = {st}");
        assert_eq!(st["ok"], serde_json::Value::Bool(true), "状态复查说模型没齐");

        let _ = std::fs::remove_dir_all(&dest);
    }

    /// 走一遍**真的暂停 → 续传**：下到一半立暂停旗标，看 `.part` 留着；再带着
    /// `resume_url` 下第二次，看它真的从断点接上（不是从头下）。
    ///
    /// 为什么非要真打一次 HTTP：`Range` 的语义是**服务端**的事 —— 我们发
    /// `bytes=N-`，服务端可以回 206，也可以不理会回 200 一整份。两种情况下代码
    /// 都得不出坏包，而这件事只有真的挂上一个会回 206 的服务器才验得出来。
    /// （本地那个 `python -m http.server` 就回 206；测试用的 18080 也是它。）
    ///
    ///     $env:VSS_REAL_MODELS_URL='http://127.0.0.1:18080/models.zip'
    ///     $env:VSS_REAL_RESUME_DEST='H:\工作站\tmp-svsep-resume'
    ///     cargo test --bins pause_and_resume -- --nocapture
    #[tokio::test]
    async fn pauses_and_resumes_the_real_models_pack_when_asked() {
        let Ok(url) = std::env::var("VSS_REAL_MODELS_URL") else {
            return;
        };
        let dest = std::env::var("VSS_REAL_RESUME_DEST")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir().join("vss-svsep-resume-real"));
        let _ = std::fs::remove_dir_all(&dest);
        let models = models_dir(&dest);
        std::fs::create_dir_all(&models).unwrap();
        let part = models.join("svsep-models.zip.part");

        /* ── 第一轮：下到 12 MB 就暂停 ───────────────────── */
        static PAUSE: AtomicBool = AtomicBool::new(false);
        static STOP: AtomicBool = AtomicBool::new(false);
        let ctl = DownloadCtl::new(&PAUSE, &STOP, None);
        let marks = std::sync::Arc::new(std::sync::Mutex::new(0u64));
        let marks2 = marks.clone();
        let out = download_models(&dest, &url, &ctl, move |got, _| {
            let mut m = marks2.lock().unwrap();
            *m = got;
            // ⚠️ 旗标是**另一条手臂**在真实场景里立的（HTTP 请求进来），这里就地立；
            //    立在回调里等价 —— `fetch_bundle` 每写完一块就查一次。
            if got > 12_000_000 {
                PAUSE.store(true, Ordering::Relaxed);
            }
        })
        .await
        .expect("第一轮下载失败");
        let paused_at = *marks.lock().unwrap();
        /* ⚠️ 别断言 `FetchOutcome::Paused` —— `download_models` / `download_runtime`
           会把三种收场**统一成 `Done(一个带标志的对象)`**（上面那段 match：
           `{"ok":true,"paused":true,"bytes":N}`），因为 HTTP 那一层只认一种形状。
           第一次就是在这儿写错了断言。 */
        let flag = |v: &FetchOutcome, k: &str| -> bool {
            match v {
                FetchOutcome::Done(j) => j[k] == Value::Bool(true),
                _ => false,
            }
        };
        assert!(
            flag(&out, "paused"),
            "下到 {paused_at} 字节时立了暂停，收场却不是「暂停」：{out:?}"
        );
        assert!(!flag(&out, "cancelled"), "只是暂停，不该算成停止");
        let half = std::fs::metadata(&part).map(|m| m.len()).unwrap_or(0);
        println!("暂停在 {paused_at} 字节处，盘上 .part = {half} 字节");
        assert!(half > 8_000_000, "暂停后 .part 太小：{half}");
        assert!(half < 484_000_000, "暂停后 .part 已经是一整包了：{half}");
        // 暂停**不能**留下解压产物 —— 半个包解不出东西来
        assert!(
            !models.join(ROFORMER_MODEL).exists(),
            "还没下完就解压出模型了"
        );

        /* ── 第二轮：带 resume_url 接着下 ────────────────── */
        let ctl2 = DownloadCtl::new(&PAUSE, &STOP, Some(url.clone()));
        assert!(ctl2.paused() == false && ctl2.cancelled() == false, "构造时该清旗标");
        let resumed_from = ctl2.resume_url.clone().unwrap();
        assert_eq!(resumed_from, url);
        let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::<(u64, u64)>::new()));
        let seen2 = seen.clone();
        let t = std::time::Instant::now();
        let out2 = download_models(&dest, &resumed_from, &ctl2, move |got, total| {
            seen2.lock().unwrap().push((got, total.unwrap_or(0)));
        })
        .await
        .expect("续传失败");
        let ticks = seen.lock().unwrap().len();
        let first = seen.lock().unwrap().first().copied().unwrap_or((0, 0));
        println!("续传耗时 {:?}，{ticks} 次进度回调，第一次是 {first:?}", t.elapsed());
        /* ★ 这条才是「真的续上了」的证据：`fetch_bundle` 在开始拉数据**之前**
           先回调一次 on_progress(got = already, total = 剩余 + already)。要是没带
           Range / 服务端没认，第一次回调会是 (0, 整包大小) —— 那就成了从头下。 */
        assert!(
            first.0 >= half,
            "续传第一次回调是 {first:?}，比盘上已有的 {half} 字节还少 —— 这是在从头下"
        );
        /* ⚠️ 总长是 `Content-Length: 484976642`（= 整个 `models.zip` 的字节数），
           不是 `models_status` 里那个 `expectedBytes`，也不是我先前记的
           `484975838`（那个数是我凭空写的，第一次跑就红在这条断言上）。 */
        assert_eq!(first.1, 484_976_642, "续传报的总长不对：{first:?}");
        assert!(flag(&out2, "paused") == false && flag(&out2, "cancelled") == false);
        assert!(matches!(out2, FetchOutcome::Done(_)), "续传没有下完：{out2:?}");

        // 下完就该跟没暂停过一样：模型齐、.part 与 .zip 都清掉
        for name in [UVR_MODEL, ROFORMER_MODEL, "download_checks.json", "BS-Roformer-SW.yaml"] {
            assert!(models.join(name).is_file(), "续传后缺文件：{name}");
        }
        assert!(!part.exists(), "下完了 .part 还在");
        assert!(!models.join("svsep-models.zip").exists(), "下完了 zip 还在");
        let st = models_status(&dest);
        assert_eq!(st["ok"], serde_json::Value::Bool(true), "续传后状态复查说没齐");

        let _ = std::fs::remove_dir_all(&dest);
    }

    /// 把**真的** runtime 包整个解一遍（4.9 GB / 两万多个条目）。
    /// 单测造的 zip 太小，证明不了大包；而 runtime 的解压目标是程序目录，
    /// 从界面上试会覆盖正在用的运行时，所以这里用环境变量把目标指到临时目录。
    ///
    ///     $env:VSS_REAL_RUNTIME_ZIP='H:\工作站\资料归档\runtime.zip'; cargo test --bins real_runtime -- --nocapture
    #[test]
    fn extracts_the_whole_real_runtime_pack_when_asked() {
        let Ok(zip) = std::env::var("VSS_REAL_RUNTIME_ZIP") else {
            return;
        };
        // ⚠️ 解压目标要能挑：整套 runtime 解出来 7.5 GB，`%TEMP%` 在系统盘上，
        //    实测第二次跑就把 C: 撑到 0 字节可用 —— 那是**环境**的失败，但报出来
        //    的样子很像解析器有问题（`解压失败：磁盘空间不足 (os error 112)`，
        //    而且是在七万秒之后才炸）。所以用 VSS_REAL_RUNTIME_DEST 指到别的盘。
        let dest = std::env::var("VSS_REAL_RUNTIME_DEST")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| std::env::temp_dir().join("vss-svsep-runtime-real"));
        let _ = std::fs::remove_dir_all(&dest);

        let t = std::time::Instant::now();
        // strip 是空串 —— runtime 包必须**留住** `runtime/` 这一层
        let rep = extract_zip(Path::new(&zip), &dest, "", |_, _| {}).unwrap();
        println!(
            "解出 {} 个文件 / {} 字节，耗时 {:?}",
            rep.files,
            rep.bytes,
            t.elapsed()
        );

        assert!(rep.files > 20_000, "文件数不对：{}", rep.files);
        // 「运行时装好了没」的判据就是这两个文件（svsep.rs::runtime_ready）——
        // 所以它们必须在**同一个包**里。2026-10-02 就是这里漏了 backend\：
        // 包只有 runtime\，用户下完 4.5 GB 仍然起不来。
        assert!(dest.join("runtime").join("python.exe").is_file(), "runtime/python.exe 没到位");
        assert!(dest.join("backend").join("app.py").is_file(), "backend/app.py 没到位");
        // 分离引擎自己要用 ffmpeg（backend\config.py 会把 <svsep>\bin 塞进 PATH）
        assert!(dest.join("bin").join("ffmpeg.exe").is_file(), "bin/ffmpeg.exe 没到位");
        // 大文件也要完整：torch 的包体在 runtime\Lib\site-packages 下
        assert!(
            dest.join("runtime").join("Lib").join("site-packages").is_dir(),
            "runtime/Lib/site-packages 没解出来"
        );
        // 抽查一个**偏移超过 4 GiB** 的条目（它的 lho 是 Zip64 哨兵）——
        // 这一条是踩过的坑：只认「大小溢出」不认「偏移溢出」时，就是它炸的。
        let torch = dest
            .join("runtime")
            .join("Lib")
            .join("site-packages")
            .join("torch")
            .join("lib")
            .join("torch_cpu.lib");
        assert!(torch.is_file(), "torch_cpu.lib 没到位（Zip64 偏移那条路）");
        assert!(
            std::fs::metadata(&torch).map(|m| m.len() > 1_000_000).unwrap_or(false),
            "torch_cpu.lib 解出来是空的或太小"
        );

        let _ = std::fs::remove_dir_all(&dest);
    }

    #[test]
    fn extract_zip_refuses_to_escape_the_destination() {
        let base = std::env::temp_dir().join("vss-svsep-zip-slip");
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let zip_path = base.join("t.zip");
        std::fs::write(
            &zip_path,
            make_zip(&[
                ("models/..\\..\\evil.txt", "pwned".as_bytes(), false), // zip slip：反斜杠也要认
                ("models/ok.txt", b"fine", false),
            ]),
        )
        .unwrap();

        let err = extract_zip(&zip_path, &base.join("out"), "models/", |_, _| {})
            .expect_err("带 .. 的条目必须直接报错");
        assert!(err.contains("不安全"), "错误文案要说得清：{err}");
        let _ = std::fs::remove_dir_all(&base);
    }

    // ── 下载的暂停 / 停止（2026-10-02 用户要求）──────────────────────

    #[test]
    fn download_ctl_stops_on_either_flag_and_tells_them_apart() {
        static P: AtomicBool = AtomicBool::new(false);
        static C: AtomicBool = AtomicBool::new(false);

        let ctl = DownloadCtl::new(&P, &C, Some("  https://a/b.zip  ".into()));
        // 构造时把两个旗标都清了 —— 上一轮下载留下的 true 不能让这一轮立刻收手
        assert!(!ctl.check());
        assert!(!ctl.paused());
        assert!(!ctl.cancelled());
        // 链接两边的空格要去掉，否则 Range 请求头里会带上一段空白
        assert_eq!(ctl.resume_url.as_deref(), Some("https://a/b.zip"));

        P.store(true, Ordering::Relaxed);
        assert!(ctl.check() && ctl.paused() && !ctl.cancelled());

        // 两个都立着时按「停止」算：停止更彻底（要删 .part），宁可多删不可少删
        C.store(true, Ordering::Relaxed);
        assert!(ctl.check() && !ctl.paused() && ctl.cancelled());

        // 空链接 = 不许续传（调用方没传链接），不能变成一个空串 Range
        let ctl2 = DownloadCtl::new(&P, &C, Some("".into()));
        assert_eq!(ctl2.resume_url.as_deref(), Some(""));
        assert_eq!(DownloadCtl::new(&P, &C, None).resume_url, None);
    }

    #[test]
    fn delete_dependencies_clears_both_dirs_and_the_half_downloaded_zip() {
        // 摆出真实布局：<writable> 与 <root> 是两个不同的地方，只有
        // `models/` 在 writable 下、`runtime/` 在 root 下 —— 删错一个都不会报错，
        // 只会在用户点「开始分离」时才现形。
        let base = std::env::temp_dir().join("vss-svsep-del-test");
        // ⚠️ 先清干净再摆：留着上一轮跑剩的文件时，个数断言会随上一次成不成而变
        //    （第一次踩到就是上一轮中断留下的两个索引 json 让我算出 7 而不是 6）。
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("root");
        let writable = base.join("writable");
        let svsep = root.join("app").join("data").join("svsep");
        let models = writable.join("svsep").join("models");
        std::fs::create_dir_all(models.join("sub")).unwrap();
        std::fs::create_dir_all(svsep.join("runtime").join("Lib")).unwrap();
        std::fs::create_dir_all(svsep.join("bin")).unwrap();
        // 随程序打包的分离后端 + 用户的输出目录：**删依赖时一个都不该动**
        std::fs::create_dir_all(svsep.join("outputs")).unwrap();

        std::fs::write(models.join("BS-Roformer-SW.ckpt"), vec![7u8; 4096]).unwrap();
        std::fs::write(models.join("sub").join("x.yaml"), b"y").unwrap();
        // 没下完的半个 zip：模型的落在 models/ 里，运行时的落在 svsep/ 那一层
        std::fs::write(models.join("svsep-models.zip.part"), vec![0u8; 2048]).unwrap();
        std::fs::write(svsep.join("svsep-runtime.zip.part"), vec![0u8; 8192]).unwrap();
        std::fs::write(svsep.join("runtime").join("python.exe"), vec![0u8; 1024]).unwrap();
        std::fs::write(svsep.join("runtime").join("Lib").join("a.dll"), vec![0u8; 512]).unwrap();
        std::fs::write(svsep.join("bin").join("ffmpeg.exe"), vec![0u8; 64]).unwrap();
        // 这一份**不该**被删：随程序打包的分离后端
        std::fs::write(svsep.join("app.py"), b"print(1)").unwrap();
        std::fs::write(svsep.join("config.py"), b"X = 1").unwrap();

        let mut last = (0u64, 0u64);
        let v = delete_dependencies(&root, &writable, || false, |f, b| last = (f, b));

        let files = v.get("removedFiles").and_then(|x| x.as_u64()).unwrap();
        let bytes = v.get("removedBytes").and_then(|x| x.as_u64()).unwrap();
        // 7 个文件 = 模型 2 + models 里的半个 zip 1 + runtime 2 + bin 1 + svsep 里的
        // 半个 zip 1。摆进 base 的文件一共就这 7 个，删完正好一个不剩 —— 所以这个
        // 数同时也是「有没有漏删」的判据；多一个就说明 walk 把同一个文件数了两遍。
        assert_eq!(
            files, 7,
            "模型 2 + models 里的 .part 1 + runtime 2 + bin 1 + svsep 里的 .part 1，实际：{v}"
        );
        assert_eq!(bytes, 4096 + 1 + 2048 + 1024 + 512 + 64 + 8192);
        assert_eq!(last, (7, bytes), "最后一次进度回调要是最终值");
        assert_eq!(v.get("lockedCount").and_then(|x| x.as_u64()), Some(0));

        // 目录本身留着（`models/` 是引擎的 MODEL_DIR，删了它会以为没装）
        assert!(models.is_dir(), "models 目录不该被删掉");
        assert!(svsep.join("runtime").is_dir());
        // ★ 随程序打包的那些**一个都不能少**：backend 的 .py、以及运行期目录
        assert!(svsep.join("app.py").is_file(), "backend 的 .py 不该被删");
        assert!(svsep.join("config.py").is_file());
        assert!(svsep.join("outputs").is_dir(), "用户的输出目录不该被删");
        assert!(!svsep.join("svsep-runtime.zip.part").exists(), "运行时那半个 zip 要清掉");

        // 再删一次：目录都空了，不能再报出个数来（否则按钮会一直说「已删 5 个」）
        let v2 = delete_dependencies(&root, &writable, || false, |_, _| {});
        assert_eq!(v2.get("removedFiles").and_then(|x| x.as_u64()), Some(0));

        // 用户按了停止：一个都不删
        std::fs::write(models.join("again.onnx"), b"z").unwrap();
        let v3 = delete_dependencies(&root, &writable, || true, |_, _| {});
        assert_eq!(v3.get("cancelled").and_then(|x| x.as_bool()), Some(true));
        assert_eq!(v3.get("removedFiles").and_then(|x| x.as_u64()), Some(0));
        assert!(models.join("again.onnx").is_file());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn resume_point_reads_the_disk_and_matches_the_url() {
        // 「重启之后还认不认那半个包」全靠这个函数 —— 它必须看盘上的字节，
        // 而不是任何内存里的记号（进程重启后记号就没了）。
        let base = std::env::temp_dir().join("vss-svsep-resume-test");
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("root");
        let writable = base.join("writable");
        std::fs::create_dir_all(writable.join("svsep").join("models")).unwrap();
        let url = "https://example.test/svsep-models.zip";

        // ① 什么都没有：不能续
        assert_eq!(resume_point(&root, &writable, "models", url), None);
        // 未知的种类（拼错 kind 不该 panic，也不该乱指一个目录）
        assert_eq!(part_path(&root, &writable, "nope"), None);

        // ② 只有半个包、没有记号：不认。`.part` 只有字节没有出处，拿它接一个
        //    别的链接的 Range 会拼出坏 zip（要到解压才炸）。
        let part = part_path(&root, &writable, "models").unwrap();
        assert_eq!(
            part,
            writable.join("svsep").join("models").join("svsep-models.zip.part"),
            "落点要跟着 Bundle 走，不能自己拼"
        );
        std::fs::write(&part, vec![0u8; 1234]).unwrap();
        assert_eq!(
            resume_point(&root, &writable, "models", url),
            Some(1234),
            "记号缺失（老版本留的半个包）算能续：为了几十字节的记号丢掉几个 GB 是坏交易"
        );
        // 补上记号之后还是同一个答案
        write_url_marker(&part, url).unwrap();
        assert_eq!(resume_point(&root, &writable, "models", url), Some(1234));

        // ③ 记号写着**别的**链接：不认 —— 这才是那个记号存在的理由
        write_url_marker(&part, "https://other.test/svsep-models.zip").unwrap();
        assert_eq!(resume_point(&root, &writable, "models", url), None);

        // ④ 记号是空文件（写到一半被杀）：也当「对不上」，宁可从零下
        std::fs::write(url_marker(&part), b"").unwrap();
        assert_eq!(resume_point(&root, &writable, "models", url), None);

        // ⑤ 收场后清记号：半个包不再算数
        write_url_marker(&part, url).unwrap();
        clear_resume_marker(&root, &writable, "models");
        assert!(!url_marker(&part).exists());
        assert_eq!(resume_point(&root, &writable, "models", url), Some(1234));

        // ⑥ 空文件不算数：续到 0 字节等于没续，还得白跑一次 Range 请求
        std::fs::write(&part, b"").unwrap();
        assert_eq!(resume_point(&root, &writable, "models", url), None);

        let _ = std::fs::remove_dir_all(&base);
    }
}
