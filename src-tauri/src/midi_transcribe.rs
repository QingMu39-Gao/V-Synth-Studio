//! 人声转 MIDI —— GAME（<https://github.com/openvpi/GAME>）的 Windows 原生移植。
//!
//! # 和音轨分离长得很不一样，是故意的
//!
//! | | 音轨分离（`svsep.rs`） | 人声转 MIDI（这里） |
//! |---|---|---|
//! | 引擎 | Python HTTP 服务 | **进程内**，没有子进程 |
//! | 端口 | 17879 起找一个空闲的 | **不占端口** |
//! | 依赖 | 7.8 GB 运行时 | **零依赖**（ONNX Runtime 随包分发）+ 364 MB 模型包 |
//!
//! 「起进程 → 轮询健康 → 转发 → 收尸」那一整套在那边是必需的（引擎是别人的
//! Python 程序），在这里全是白交的复杂度：推理就是一次函数调用。
//!
//! # 算子在哪
//!
//! **神经网络在 ONNX 图里，其余全在这儿**（见 `game::algo` 顶部的表）：
//! 波形切片、D3PM 采样环、边界解码、区间→时值、音符抽取、MIDI 写出。
//! 这就是「port」的实质 —— 不是把 Python 包进 exe，是把算法重写一遍。
//!
//! # 模型与许可
//!
//! 代码 MIT，**权重 CC BY-NC-SA 4.0（非商业）**。所以模型不进仓库、不随包
//! 分发，由用户在界面上点一下下载（我们自己的 release，见 `GAME_ZIP`）——
//! 和音轨分离「运行时进包、模型按需下」是同一条规矩。

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use serde_json::{Value, json};

use crate::game::{algo, engine};

/// ONNX 权重包在发布点上的资产名（opset 20，由上游 `deployment/exporter.py` 导出）。
///
/// ⚠️ 上游 release 的 `GAME-1.0-large.zip` 里是 **PyTorch 的 `model.pt`**，不是
/// ONNX —— 要用 ONNX 就得认准 `-onnx` 这几个包（v1.0.3 才发布的）。
///
/// # 为什么下的是我们自己的包，而不是上游 release
///
/// 内容一样（都是官方导出的那三个图，逐字节相同），但**放在我们那个 release 上**：
/// 一来与音轨分离的运行时 / 模型同一个发布点，二来 GitHub 的 release 资产在境内
/// 常连不上，而那条路由 `crate::ghmirror` 现场挑镜像（见那边）。
///
/// **两个包可以互换**：自建包沿用上游那个顶层目录名 `GAME-1.0.3-large-onnx/`，
/// 所以 `download_models` 里那个 `strip` 常量两边都命得中（见那里的注释）。
/// 自建包由 `tools/pack_assets.mjs --only game.models` 产出，白名单四个文件、
/// 每个都校验实测字节数（清单在 `tools/assets.mjs` 的 `game.models` 那条）。
const GAME_ZIP: &str = "GAME-1.0.3-large-onnx.zip";

/// 这个包里那个**认包的条目** —— 手放的包按它认（不看文件名，见 `manual_zip`）。
const GAME_ENTRY: &str = "GAME-1.0.3-large-onnx/encoder.onnx";

/// 整包大小，只用来显示与校验「下完没有」。实测值。
///
/// 上游那份是 361,619,205 B；自建包（`tools/pack_assets.mjs`，`Optimal` 档）
/// 是 **364,093,888 B** —— 大 2.4 MB 是因为 .NET 的 deflate 比上游用的压得松，
/// 属正常。这个常量会作为「下完没有」的判据传给 `fetch_to_file`，
/// **换包就一定要同步改**，否则下到一半就报完成（或永远等不到那几字节）。
pub const MODEL_ZIP_BYTES: u64 = 364_093_888;
/// 解包后那几个文件的总大小（实测值，界面用来解释「下 347 MB、占 376 MB」）。
///
/// 这个数对应**上游**那份包（81,312,536 + 160,373,028 + 152,478,761 + 198 =
/// 393,794,532 —— 两边逐字节相同，所以自建包解出来也是这个数）。
pub const MODEL_BYTES: u64 = 393_794_532;

/* ONNX Runtime 动态库**随包分发**（`tools/onnxruntime/`，由 `tools/fetch_tools.mjs`
按平台补齐、经 `bundle.resources` 进安装包），运行期不再下载 —— 落点与判据在
`artifact::ARTIFACTS` 的 `midi.ort` 那条，这里不重复。 */

/* ⚠️ 这里**没有** `MODEL_FILES` —— 三个图的名字只有一份，在
`artifact::ARTIFACTS` 里 `game.models` 那条的 `need`（判「装齐了没」也走表）。
再在这儿导出第二份，两边都没人用、各报一次 dead_code。 */

// ---------------------------------------------------------------------------
// 下载地址
// ---------------------------------------------------------------------------

/// 这一次真的要用的模型包地址。
///
/// 链接由发布点拼出来（`crate::svsep::release_url`），那个根目录开发机可以用
/// `VSS_MODULES_BASE` 顶成本地目录（见 `crate::svsep::release_base`）——
/// 「下到一半按删除」「进度条卡在 99%」这类事必须真下着才验得出来。
/// ⚠️ 发布版不认那个变量，永远走 GitHub。
fn model_url() -> String {
    crate::svsep::release_url(GAME_ZIP)
}

// ---------------------------------------------------------------------------
// 推理方式（自动 / GPU / CPU）
// ---------------------------------------------------------------------------

/// 推理方式。界面上的三选一，落到盘上就是这三个字符串。
///
/// `auto` 与 `cpu` **当前等价**（`engine::build_sessions` 只在 `gpu` 时挂 CUDA）——
/// 留着 `auto` 是为了将来接 DirectML / CoreML 时能把「让引擎自己挑」与「我就要 CPU」
/// 分开。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Device {
    #[default]
    Auto,
    Cpu,
    Gpu,
}

impl Device {
    pub fn parse(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "gpu" => Self::Gpu,
            "cpu" => Self::Cpu,
            _ => Self::Auto,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Cpu => "cpu",
            Self::Gpu => "gpu",
        }
    }
}

/// 设置文件：`<可写>/midi/midi_settings.json`。
///
/// ⛔ 与音轨分离的 `<可写>/svsep/data/inference_settings.json` 是**两个文件**：
/// 那个由 Python 的 `inference_settings.py` 管，键名与合法值都是它定的 ——
/// 我们写进去的东西它不认识，反过来也一样。别想着共用。
pub fn settings_file(writable: &Path) -> PathBuf {
    data_dir(writable).join("midi_settings.json")
}

/// 读盘上的推理方式。没有文件、文件坏了、值认不出，一律 `auto`。
pub fn read_device(writable: &Path) -> Device {
    std::fs::read_to_string(settings_file(writable))
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
        .and_then(|v| v.get("device").and_then(Value::as_str).map(Device::parse))
        .unwrap_or_default()
}

/// 写盘上的推理方式。
pub fn write_device(writable: &Path, dev: Device) -> Result<(), String> {
    let path = settings_file(writable);
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("建目录失败：{e}"))?;
    }
    let body = serde_json::to_string_pretty(&json!({ "device": dev.as_str() }))
        .map_err(|e| format!("序列化推理方式失败：{e}"))?;
    std::fs::write(&path, body).map_err(|e| format!("写推理方式失败：{e}"))
}

/// CUDA 那边探到的东西。
#[derive(Debug, Clone)]
pub struct CudaInfo {
    /// 现在到底能不能用 CUDA。
    pub available: bool,
    /// 给界面直接显示的中文。
    ///
    /// ⛔ 信息**全塞在这一句里**，别再单开一个「组件目录」字段：单开的字段没有读者，
    /// 而这段中文是原样显示给用户的，路径写在这儿才真的有人看。
    pub detail: String,
}

/// 当前推理方式 + CUDA 能不能用，给 `midi_status` 的 `device` 一节用。
pub struct DeviceStatus {
    pub device: Device,
    pub cuda_ok: bool,
    pub cuda_detail: String,
    /// 用户选了 GPU 但这台机器用不了时的补救话术（空串 = 没什么好说的）。
    pub note: String,
}

pub fn device_status(writable: &Path, dll: Option<&Path>) -> DeviceStatus {
    let device = read_device(writable);
    let info = cuda_info(dll);
    let note = if device == Device::Gpu && !info.available {
        format!("现在这一台用不了 GPU：{}。先按 CPU 跑。", info.detail)
    } else {
        String::new()
    };
    DeviceStatus {
        device,
        cuda_ok: info.available,
        cuda_detail: info.detail,
        note,
    }
}

/// 探测结果的缓存：**成功的一直留，失败的只留 [`FAILED_TTL`]**。
static CUDA_PROBE: std::sync::Mutex<Option<(std::time::Instant, CudaInfo)>> =
    std::sync::Mutex::new(None);

/// 失败结果能留多久。见 [`cuda_info`]。
const FAILED_TTL: std::time::Duration = std::time::Duration::from_secs(30);

/// 这台机器现在能不能用 CUDA 跑 ONNX Runtime。
///
/// ⚠️ **两档缓存，别改成一样**：`midi_status` 是前端每 2 秒轮询的接口，而探一次
/// CUDA 会话在**没有 N 卡**的机器上要一秒多（真会去初始化 CUDA）。每 2 秒来一遍
/// 就是白白烧掉一半核。
///
/// - **成功** ⇒ 永久缓存：那几百 MB 的 `cublasLt64_12.dll` 已经进了进程，不会退回去。
/// - **失败** ⇒ 只留 [`FAILED_TTL`]：用户可能正开着这个界面去装音轨分离或加速包，
///   装完不重启就该能解锁；30 秒够短，也够挡住轮询。
pub fn cuda_info(dll: Option<&Path>) -> CudaInfo {
    /* macOS 上不必去问 ONNX Runtime：CUDA 在那上面不存在（Apple 从 10.14 起就不再支持），
    问了只会得到「这份 ORT 里没有 CUDA provider（CPU 构建）」——那句话把用户引向
    「换一份 ONNX Runtime」，而换哪一份都没用。 */
    if cfg!(target_os = "macos") {
        return CudaInfo {
            available: false,
            detail: "macOS 上没有 CUDA，显卡推理用不了；CPU 推理正常".into(),
        };
    }
    if let Ok(cache) = CUDA_PROBE.lock()
        && let Some((at, info)) = cache.as_ref()
    {
        let fresh = info.available || at.elapsed() < FAILED_TTL;
        if fresh {
            return info.clone();
        }
    }
    let info = probe_cuda(dll);
    if let Ok(mut cache) = CUDA_PROBE.lock() {
        *cache = Some((std::time::Instant::now(), info.clone()));
    }
    info
}

/// 真去建一次 CUDA 会话，看看行不行。
fn probe_cuda(dll: Option<&Path>) -> CudaInfo {
    let dll = match dll {
        Some(p) => p,
        None => {
            return CudaInfo {
                available: false,
                detail: "还没找到 ONNX Runtime 动态库".into(),
            };
        }
    };
    /* ⛔ **ONNX Runtime 本体必须先加载，否则下面任何一句 ORT 调用都会 panic**：
    `ort` 的 `api()` 是惰性初始化，没人调过 `ort::init_from(...).commit()` 时它会去找
    **裸文件名** `onnxruntime.dll`，PATH 里当然没有；
    `transcribe` 里那句 `load_runtime(dll)` 来得太晚 —— `midi_status` 是首页一进就
    轮询的接口，它会先到这儿。worker 线程 panic 的表现是「这条命令永远不返回」，
    没有错误回复，别的命令却正常。加载一次够（`ort::init_from` 内部是 `OnceLock`）。 */
    static RUNTIME_LOADED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    if RUNTIME_LOADED.get().is_none() {
        if let Err(e) = engine::load_runtime(dll) {
            return CudaInfo {
                available: false,
                detail: e,
            };
        }
        let _ = RUNTIME_LOADED.set(());
    }

    /* ⚠️ **CUDA 那 12 个组件 dll 分在四个目录里**，不是一个：
         cudart64_12.dll   → nvidia/cuda_runtime/bin/
         cublas{,Lt}64_12.dll → nvidia/cublas/bin/
         cufft64_11.dll    → nvidia/cufft/bin/
         8 个 cudnn*_9.dll → nvidia/cudnn/bin/

    ⇒ 不能指望 `ort::ep::cuda::preload_dylibs`：它只吃**一个** CUDA 根目录与**一个**
    cuDNN 根目录，然后把每个名字 `root.join(name)` 去加载 —— 而这 4 个 dll 真机上
    根本不在同一个目录。
    ✅ 照 Python 侧的做法，把这四个目录加进进程 `PATH`：provider dll 内部用
    `LoadLibraryExW` 找依赖，不带 `LOAD_LIBRARY_SEARCH_*` 标志时**会搜 `PATH`**。 */
    static NVIDA_BIN_DIRS: std::sync::OnceLock<Vec<PathBuf>> = std::sync::OnceLock::new();
    let dirs = NVIDA_BIN_DIRS.get_or_init(|| {
        let mut out: Vec<PathBuf> = Vec::new();
        for name in [
            "cudart64_12.dll",
            "cublas64_12.dll",
            "cufft64_11.dll",
            "cudnn64_9.dll",
        ] {
            if let Some(d) = find_dylibs_dir(dll, &crate::tools::dll(name.trim_end_matches(".dll")))
                && !out.contains(&d)
            {
                out.push(d);
            }
        }
        out
    });

    /* 只在第一次探的时候动 PATH（接口是 2 秒轮询的）。
    ⚠️ 手拼 `;`，别用 `std::env::join_paths`：后者见到路径里含 `;` 会直接报
    `InvalidInput`，而这里几条路径全是进程外的东西，不值当为它写一条错误分支。 */
    static PATH_PATCHED: std::sync::OnceLock<()> = std::sync::OnceLock::new();
    if !dirs.is_empty() && PATH_PATCHED.get().is_none() {
        let mut patched = std::env::var("PATH").unwrap_or_default();
        for d in dirs {
            let d = d.to_string_lossy();
            if !patched.to_lowercase().contains(&d.to_lowercase()) {
                patched = format!("{d};{patched}");
            }
        }
        /* SAFETY: `set_var` 与其它线程并发读环境是 UB，这里的窗口只开一次
        （`PATH_PATCHED` 挡住重复），加的几条只给 provider dll 内部的
        `LoadLibraryExW` 用。 */
        unsafe { std::env::set_var("PATH", patched) };
        let _ = PATH_PATCHED.set(());
    }
    let found = dirs
        .iter()
        .map(|d| crate::platform::clean_path(d))
        .collect::<Vec<_>>();

    /* ⛔ **`is_available()` 不足以当判据** —— 它只回答「这份 ORT 构建里编进了 CUDA
    provider 没有」，与这台机器有没有 N 卡无关：在 A 卡机器上把四个目录加进 `PATH`
    之后它照样回 `Ok(true)`，GPU 那一格就锁不住了。

    ✅ 真判据只有一条：**真拿 CUDA 建一个会话**。
    `error_on_failure()` 在这里是必须的 —— 默认的 `fail_silently` 会把「CUDA 没装上」
    吞掉、悄悄给一个 CPU 会话。

    图用内存里拼的最小 ONNX（`mini_onnx`）：**GPU 那一格该不该亮，跟用户下没下模型
    是两回事**，状态接口在没模型时也要答得出来。 */
    use ort::ep::ExecutionProvider as _;
    match ort::ep::CUDA::default().is_available() {
        Ok(true) => {}
        Ok(false) => {
            return CudaInfo {
                available: false,
                detail: "这份 ONNX Runtime 里没有 CUDA provider（CPU 构建）".into(),
            };
        }
        Err(e) => {
            return CudaInfo {
                available: false,
                detail: format!("问 ONNX Runtime「有没有 CUDA」时出错：{e}"),
            };
        }
    }
    /* ⚠️ 这里**不能用 `?` 或 `and_then` 串**：`with_execution_providers` 失败时回的是
    `ort::Error<SessionBuilder>`（它能把 builder 还给你），与后面那句的
    `ort::Error<()>` 不是一个类型。手工两步、各自 `map_err` 成字符串。 */
    let probe = ort::session::Session::builder()
        .map_err(|e| e.to_string())
        .and_then(|b| {
            b.with_execution_providers([
                ort::ep::CUDA::default().build().error_on_failure(),
                ort::ep::CPU::default().build(),
            ])
            .map_err(|e| e.to_string())
            .and_then(|mut b| {
                b.commit_from_memory(&mini_onnx())
                    .map_err(|e| e.to_string())
            })
        });
    match probe {
        Ok(_) => CudaInfo {
            available: true,
            /* 这一条会**原样显示在界面上**（`device.cuda.detail`），所以把找到的目录
            带上：解锁之后万一建会话还是失败，用户手里得有能对得上的线索。 */
            detail: if found.is_empty() {
                "这台机器的 ONNX Runtime 能用 CUDA（组件走的是系统里那一套）".into()
            } else {
                format!(
                    "这台机器能用 CUDA 跑 ONNX Runtime，组件来自 {}",
                    found.join("、")
                )
            },
        },
        Err(e) => CudaInfo {
            available: false,
            detail: format!("这台机器上 CUDA 建不出会话（多半是没有 N 卡或驱动太老）：{e}"),
        },
    }
}

/// 一张**内存里拼的最小 ONNX 图**：`1×1 float` → `Identity` → `1×1 float`。
///
/// 只用来试「CUDA 能不能建出会话」（见 `probe_cuda`）—— 刻意不碰磁盘上那 376 MB
/// 的模型，也不做任何计算。
///
/// 手写线格式是因为**没有 `onnx` crate 可依赖**（为这一件事引一个依赖不划算），
/// 而这么小的图能手写：每个字段都是 `(field_number << 3) | wire_type`。
/// 展开的结构与逐字段断言在测试 `mini_onnx_is_a_well_formed_model` 里。
fn mini_onnx() -> Vec<u8> {
    /// protobuf 的 varint。
    fn vi(mut v: u64, out: &mut Vec<u8>) {
        loop {
            let b = (v & 0x7f) as u8;
            v >>= 7;
            if v == 0 {
                out.push(b);
                return;
            }
            out.push(b | 0x80);
        }
    }
    /// 一个 LEN 字段（tag + 长度 + 内容）。
    fn ld(field: u64, body: &[u8], out: &mut Vec<u8>) {
        vi((field << 3) | 2, out);
        vi(body.len() as u64, out);
        out.extend_from_slice(body);
    }
    /// 一个 varint 字段。
    fn vf(field: u64, v: u64, out: &mut Vec<u8>) {
        vi(field << 3, out);
        vi(v, out);
    }
    /// 一串 UTF-8 的 LEN 字段。
    fn ss(field: u64, s: &str, out: &mut Vec<u8>) {
        ld(field, s.as_bytes(), out);
    }
    /// `TypeProto` 的字节：`tensor_type(1){ elem_type=FLOAT(1), shape(2){ dim(1){ dim_value=1 } } }`。
    ///
    /// ⛔ 这个 `[1]` 形状是**必须的**，而且极易写错（两种写法都产出「能解析、但 ORT
    /// 拒收」的字节，症状一样）：少了 `shape` → ORT 报 `Tensor does not have type
    /// information.`；`dim_value` 丢了 → 变成动态维度，图在法律上仍然成立。 */
    fn tensor_type() -> Vec<u8> {
        let mut shape_dim = Vec::new();
        vf(1, 1, &mut shape_dim); // dim_value = 1
        let mut shape = Vec::new();
        ld(1, &shape_dim, &mut shape); // shape.dim[0] = {dim_value: 1}
        let mut tensor = Vec::new();
        vf(1, 1, &mut tensor); // elem_type = FLOAT
        ld(2, &shape, &mut tensor); // shape
        let mut out = Vec::new();
        ld(1, &tensor, &mut out); // TypeProto.tensor_type
        out
    }

    let mut node = Vec::new();
    ss(1, "x", &mut node); // input
    ss(2, "y", &mut node); // output
    ss(4, "Identity", &mut node); // op_type

    /* ⛔ `ValueInfoProto.type` 是**字段 2**（`ValueInfoProto{ name = 1, type = 2 }`）。
    写成一（`ld(1, …)`）会拼出「两个 `name`、没有 `type`」的 ValueInfoProto，而手写
    线格式的自检测试**照样全绿**（它拆出来的就是两个字段 1），只有真拿 ONNX Runtime
    建一次会话才现形。 */
    let mut input_vi = Vec::new();
    ss(1, "x", &mut input_vi);
    ld(2, &tensor_type(), &mut input_vi);
    let mut output_vi = Vec::new();
    ss(1, "y", &mut output_vi);
    ld(2, &tensor_type(), &mut output_vi);

    let mut graph = Vec::new();
    ss(2, "cuda-probe", &mut graph); // graph.name
    ld(1, &node, &mut graph); // node
    ld(11, &input_vi, &mut graph); // input
    ld(12, &output_vi, &mut graph); // output

    let mut model = Vec::new();
    vf(1, 7, &mut model); // ir_version = 7
    ld(7, &graph, &mut model); // graph
    let mut opset = Vec::new();
    vf(2, 13, &mut opset); // opset_import.version = 13
    ld(8, &opset, &mut model);
    model
}

/// 从 `dll` 往上逐层看，找那一层**下面的** `nvidia/`，再在它里面定位某个组件 dll，
/// 返回**装那个 dll 的目录**（`nvidia/<组件>/bin`，加进 `PATH` 用的就是它）。
///
/// **真实布局**（`pip install nvidia-*` 之后就是这样）：
/// ```text
/// <可写>/midi/onnxruntime.dll                         ← 自己放的 ORT：本体在 `midi/` 根上
/// <音轨分离运行时>/runtime/Lib/site-packages/         ← 往上一层
///     nvidia/cublas/bin/cublas64_12.dll               ← 组件在 `nvidia/<组件>/bin/`
///     nvidia/cufft/bin/cufft64_11.dll
///     nvidia/cuda_runtime/bin/cudart64_12.dll
///     nvidia/cudnn/bin/cudnn64_9.dll …
///     onnxruntime/capi/onnxruntime.dll                ← 借用的就是这一个
/// ```
/// ⛔ **是「哪一层的下面有 `nvidia/`」，不是「哪一层叫 `nvidia`」** —— 两个条件写成
/// 一样都不报错，只是永远找不到：从 ORT 本体往上走是 `capi → onnxruntime →
/// site-packages → …`，`site-packages` 自己叫 `site-packages`，而 `nvidia` 是它
/// **下面**的一层，于是条件恒假 ⇒ 四个目录一个都找不到 ⇒ GPU 永远解不了锁。
///
/// 返回**目录**而不是文件，是因为调用方要把它加进 `PATH`（四个组件分在四个 `bin/` 里）。
/// 找不到就回 `None`。
fn find_dylibs_dir(dll: &Path, probe_name: &str) -> Option<PathBuf> {
    let mut dir = dll.parent();
    while let Some(d) = dir {
        /* 只认 `site-packages/nvidia` 这一种形状。
        ⛔ 别放宽成「任何含 probe_name 的目录」：`<可写>/midi/` 里如果用户自己放了
        CUDA 版 ORT，它的依赖躺在系统目录、不在旁边，那样找出来的「路径」是假的，
        反而会把一个没有 dll 的目录塞进 PATH。 */
        if let Some(hit) = find_file(&d.join("nvidia"), probe_name, 3) {
            return hit.parent().map(Path::to_path_buf);
        }
        dir = d.parent();
    }
    None
}

/// 在 `dir` 底下（含 `dir` 自己）最多往下 `depth` 层找名为 `name` 的文件。
/// 找到第一个就回 —— Win32 的文件名不区分大小写，这里也按不区分处理。
fn find_file(dir: &Path, name: &str, depth: usize) -> Option<PathBuf> {
    let rd = std::fs::read_dir(dir).ok()?;
    let mut subdirs = Vec::new();
    for e in rd.flatten() {
        let p = e.path();
        if p.is_dir() {
            subdirs.push(p);
        } else if e.file_name().to_string_lossy().eq_ignore_ascii_case(name) {
            return Some(p);
        }
    }
    if depth == 0 {
        return None;
    }
    subdirs
        .into_iter()
        .find_map(|d| find_file(&d, name, depth - 1))
}

// ---------------------------------------------------------------------------
// 路径
// ---------------------------------------------------------------------------

/// 动态库与模型的散件目录：`<扩展包根>/midi/`（`midi_settings.json`、任务临时目录）。
///
/// 和音轨分离的 `<扩展包根>/svsep/` 同一个道理 —— 用户可以把整个扩展包目录指定到
/// 别的盘，所以这里一律经由 `artifact::ext_of` 拿那个根，别自己拼可写目录。
/// ⚠️ GAME **模型**不在这儿，它在 `<扩展包根>/game/models`（见 `artifact` 表里
/// `game.models` 那条）：一个目录放两样东西，删依赖时就分不出该删哪个。
pub fn data_dir(writable: &Path) -> PathBuf {
    crate::artifact::ext_of(writable).join("midi")
}

/// ONNX Runtime 动态库 —— 候选来自 `artifact` 表的 `midi.ort`，一个都不在就是 `None`。
///
/// ⚠️ **按能力挑，不是按候选顺序挑**：候选第一个是 `<可写>/midi`（用户自己放的那份，
/// 多半是 CPU 构建），而音轨分离运行时里那份是 GPU 构建 —— 按顺序挑会让 CPU 包
/// 永远遮蔽能跑 CUDA 的那份，GPU 那一格就再也点不亮。
/// 这不等于强制用 GPU：用不用由 `device` 说了算，这里只是别让手里能跑 CUDA 的
/// 被一份跑不了的顶掉。
///
/// ⚠️ **只多一件事**：debug 构建认 `VSS_MIDI_DLL` 强行指定（表不认识环境变量），
/// 与 `svsep.rs::release_base` 认 `VSS_MODULES_BASE` 同一套规矩 —— 发布版不认。
pub fn runtime_dll(root: &Path, writable: &Path) -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    if let Ok(p) = std::env::var("VSS_MIDI_DLL")
        && !p.trim().is_empty()
    {
        let p = PathBuf::from(p);
        return p.is_file().then_some(p);
    }
    let name = crate::tools::dll("onnxruntime");
    let existing: Vec<PathBuf> = crate::artifact::dirs_of(root, writable, "midi.ort")
        .into_iter()
        .map(|dir| dir.join(&name))
        .filter(|p| p.is_file())
        .collect();
    existing
        .iter()
        .find(|p| has_cuda_provider(p))
        .cloned()
        .or_else(|| existing.into_iter().next())
}

/// 这份 ORT 旁边有没有 CUDA provider（`onnxruntime_providers_cuda.dll`）。
///
/// 这是**静态分辨「官方 CPU 包」与「GPU 构建」**的唯一办法：两种包里的
/// `onnxruntime.dll` 同名，只有 GPU 构建多出这几个 provider dll。
fn has_cuda_provider(dll: &Path) -> bool {
    dll.parent()
        .map(|d| {
            d.join(crate::tools::dll("onnxruntime_providers_cuda"))
                .is_file()
        })
        .unwrap_or(false)
}

/* ⚠️ 落点/判据一律直接问表：`artifact::dir_of(root, writable, "game.models")`。
别在本模块再包一层 `models_dir` 之类的壳 —— `svsep::models_dir` 同名但是**另一个
东西**（`<可写>/svsep/models`），看调用点根本分不出指哪个。 */

/// `/api/midi/status` 的正文。前端靠它决定显示「下载模型」还是「开始扒谱」。
pub fn status(root: &Path, writable: &Path) -> Value {
    let dll = runtime_dll(root, writable);
    let missing = crate::artifact::missing_of(root, writable, "game.models");
    /* 引擎这一刻用的模型**在哪儿**：`"downloaded"` / `"bundled"` / `"local"`。
    ⚠️ 别想在这里区分「这是下下来的还是随手放进去的」—— **分不出来**。
    绿色版 `writable == <root>/data`，两层是**同一个绝对路径**，一个目录同时
    扮演「下载落点」和「随包层」，任何按路径或按目录状态的判据都会误报。
    所以只报「引擎在用哪个路径」，界面据此说人话：
      · `downloaded` —— 用的是 `<可写>/game/models`（下载物就落这儿）
      · `bundled`    —— 用的是 `<root>/data/game/models`，**且它不是**下载落点
        （只可能出现在安装版：可写目录在 `%APPDATA%`）。这时点「删除依赖」不会
        动它，状态还是「就绪」—— 界面**必须**写清，否则用户以为按钮坏了
      · `local`      —— 两层同一路径。没有第二层可回落，所以那边什么都不用说
    ⛔ 别在前端按 `dir` 的**尾巴**猜：三种情况的路径都以 `\game\models` 结尾。 */
    /* ⚠️ 两层候选与「当前用哪一层」都问表（`game.models` 的 `places`）——
    这里只需要那个「随包层」与「当前生效层」做比较。 */
    let ctx = crate::artifact::Ctx::new(root, writable);
    let a = crate::artifact::get("game.models").expect("表里必须有 game.models");
    let dirs = crate::artifact::candidates(&ctx, a);
    let bundled = dirs[1].clone();
    let active = crate::artifact::locate_or_default(&ctx, a);
    let models_origin = if active != bundled {
        "downloaded"
    } else if bundled == dirs[0] {
        "local"
    } else {
        "bundled"
    };
    /* 已经下了一半的模型包（`game-models.part`）。
    ⚠️ 这个数**只是给用户看的**（「上次没下完，还剩 200 MB 在盘上」），
    不参与任何判断 —— 这个包不支持续传，`.part` 只会在下次下载时被覆盖。 */
    let data = data_dir(writable);
    let leftover = |name: &str| {
        std::fs::metadata(data.join(name))
            .map(|m| m.len())
            .unwrap_or(0)
    };
    /* 推理方式与 CUDA 可用性。`device.mode` 是**盘上的设置**（用户选的那个），
    `cuda.ok` 是**这台机器现在能不能用** —— 两者可以互相矛盾（选了 GPU 但没有
    N 卡 / 没装运行时），界面必须照 `cuda.ok` 决定锁不锁那一格，别照 `mode`。 */
    let ds = device_status(writable, dll.as_deref());
    json!({
        "runtime": {
            "ready": dll.is_some(),
            "dll": dll.as_ref().map(|p| crate::platform::clean_path(p)),
            /* `borrowed` = 用的不是 `<可写>/midi` 里那份，而是从别处借的
            （随包 `tools/onnxruntime/` 或音轨分离运行时）。 */
            "borrowed": dll
                .as_ref()
                .map(|p| !p.starts_with(data_dir(writable)))
                .unwrap_or(false),
        },
        "models": {
            "ready": missing.is_empty(),
            "missing": missing,
            "dir": crate::platform::clean_path(&active),
            /* `"origin"` 不是 `"source"` —— `"source"` 这个名字已经被下面那行
               （上游仓库地址）占了。同一个对象里两个同义键，将来谁把它拍平谁踩坑。 */
            "origin": models_origin,
            // 下多少 / 解开多少。两个数差着 34 MB 的 zip 压缩量，界面要说清。
            "zipBytes": MODEL_ZIP_BYTES,
            "extractBytes": MODEL_BYTES,
            "partBytes": leftover("game-models.part"),
            /* 用户手放的包（123 云盘下完直接丢进目录的那种）—— 界面据此把按钮写成
               「解压」。空数组 = 没有。 */
            "manual": manual_files(writable),
        },
        "license": "模型权重 CC BY-NC-SA 4.0（非商业）",
        "source": "https://github.com/openvpi/GAME",
        /* 扩展包根：界面上那行「下得慢就自己去网盘下」要显示它，而且**用户改了落点它跟着变**
           （与音轨分离页显示的是同一个根，见 `lib/extDir.tsx`）。 */
        "extDir": crate::platform::clean_path(&crate::artifact::ext_of(writable)),
        "device": {
            "mode": ds.device.as_str(),
            "cuda": { "ok": ds.cuda_ok, "detail": ds.cuda_detail },
            "note": ds.note,
        },
    })
}

// ---------------------------------------------------------------------------
// 下载
// ---------------------------------------------------------------------------

/* ⚠️ **这里没有续传，`resume_from` 恒为 0，`.pause` 与 `.stop` 效果一样。**
 *
 * 音轨分离那份（`svsep::fetch_bundle`）有完整的续传：`.part` + `.part.url` 记号、
 * 服务端回 206 才追加、200 就归零 —— 因为它的包是 4.7 GB，断一次就白下几小时。
 * 这里两个包分别是 364 MB 与 74.5 MB，为此再养一套续传逻辑不划算，
 * 所以 `fetch_to_file` 一律从头下，状态里 `resumable` 也**恒为 false**（界面据此
 * 不画「继续下载」按钮）。
 *
 * ⛔ **别在界面上给它加「暂停 / 继续」**：`/api/midi/download/pause` 这条路由留着
 * 只是为了与音轨分离的接口形状一致（`DownloadCtl` 要求两个 flag），
 * 真语义是「停下、`.part` 留着、下次重新下」—— 写「继续」就是骗用户。
 */

/// 下载并解包 ONNX 权重（364 MB → 解出 376 MB 的三个图）。
///
/// `on_progress(已下字节, 可选总字节, 阶段)`，阶段 `"download"` / `"extract"`，
/// 与音轨分离那份状态形状一致，前端两个页面可以共用同一套进度条。
///
/// ⚠️ **盘上有用户手放的包就直接解它**（浏览器从 123 云盘下下来丢进目录的那种，
/// 见 [`manual_zip`]）—— 一个字节都不下。界面那时把按钮写成「解压」。
pub async fn download_models(
    writable: &Path,
    ctl: &crate::svsep::DownloadCtl,
    on_progress: impl Fn(u64, Option<u64>, crate::svsep::Stage) + Send + Sync + 'static,
) -> Result<Value, String> {
    let dir = data_dir(writable);
    std::fs::create_dir_all(&dir).map_err(|e| format!("建目录失败：{e}"))?;

    /* 落到**扩展包根下的 `game/models`**。
    ⚠️ 不要图省事写 `data_dir(writable)`（那是 `midi/`）：下载能成功、解包能成功，
    唯独 `artifact::dir_of(root, writable, "game.models")` 找不到它 —— 用户点「开始扒谱」时才报
    「模型还没装全」，而状态页明明显示已就绪。
    ⚠️ 也**不要**手写 `ext.join("game").join("models")`：那是把落点知识
    又抄了一遍。落点由 `artifact::download_dest` 给出（= 表里 `game.models`
    的第一个候选），下载与判据于是永远对得上。 */
    /* 这个函数只拿到 `writable`，而落点是 `game.models` 的**第一个候选**
    （`Base::Ext` 那一层）—— 它由 `writable` 与 `config.json` 的 `extDir` 一起决定，
    问 `Ctx::new` 就是那条唯一的判据。`root` 那一层这里不查。 */
    let ctx = crate::artifact::Ctx::new(writable, writable);
    let dest = crate::artifact::download_dest(
        &ctx,
        crate::artifact::get("game.models").expect("表里必须有 game.models"),
    );
    std::fs::create_dir_all(&dest).map_err(|e| format!("建目录失败：{e}"))?;
    /* 包里是 `GAME-1.0.3-large-onnx/<文件>`，所以剥掉这一层。
    ⚠️ 剥错不会报错，只会在用户点「开始扒谱」时才现形：「模型没下全」。
    前缀必须与包的中央目录里那个顶层目录**逐字相同**。 */
    let strip = "GAME-1.0.3-large-onnx/";

    let manual = manual_zip(&[&dest, &crate::artifact::ext_of(writable)]);
    let zip = match manual {
        Some(z) => z,
        None => {
            let tmp = dir.join("game-models.part");
            crate::svsep::fetch_to_file(
                &model_url(),
                &tmp,
                Some(MODEL_ZIP_BYTES),
                ctl,
                // ⚠️ `fetch_to_file` 的回调是**三参**的（`got, total, Stage`），阶段它自己带 ——
                // 别再手工把 `Stage::Download` 塞进去，那样后面解压那一段没有进度。
                &|got, total, stage| on_progress(got, total, stage),
            )
            .await?;
            tmp
        }
    };
    let report = crate::svsep::unpack(&zip, &dest, strip, &on_progress)?;
    // 解完才删：手放的那份也一样（已经装进 `dest` 了，压着它只是占 364 MB）
    let _ = std::fs::remove_file(&zip);
    let _ = std::fs::remove_file(crate::download::url_marker(&zip));

    // 校验「**解出来的这个目录**里齐不齐」（不是「这台机器上有没有」）
    let missing = crate::artifact::missing_in_dir(&dest, "game.models");
    if !missing.is_empty() {
        return Err(format!(
            "模型包解开了，但缺 {} —— 包的结构和预期不一样（是不是换了 release？）",
            missing.join("、")
        ));
    }
    Ok(json!({
        "ok": true,
        "dir": crate::platform::clean_path(&dest),
        "files": report.files,
        "bytes": report.bytes,
    }))
}

/// 用户**手放**的权重包（浏览器从网盘下下来丢进目录的那种）。
///
/// 认的是**内容**：zip 里得有 `GAME-1.0.3-large-onnx/encoder.onnx` —— 不能靠文件名，
/// 用户把网盘上三个包一起丢进同一个目录是最常见的用法，那时按名字挑会挑中别人的包。
/// `dirs` 按优先级排：包自己的落点在前，扩展包根在后。
fn manual_zip(dirs: &[&Path]) -> Option<PathBuf> {
    for d in dirs {
        let Ok(rd) = std::fs::read_dir(d) else {
            continue;
        };
        let mut zips: Vec<PathBuf> = rd
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.is_file() && p.extension().is_some_and(|x| x.eq_ignore_ascii_case("zip")))
            .collect();
        zips.sort();
        if let Some(z) = zips
            .into_iter()
            .find(|p| crate::svsep::zip_has_entry(p, GAME_ENTRY))
        {
            return Some(z);
        }
    }
    None
}

/// 盘上有没有手放的权重包（界面据此把「下载模型」写成「解压」）。返回文件名。
pub fn manual_files(writable: &Path) -> Vec<String> {
    let ctx = crate::artifact::Ctx::new(writable, writable);
    let dest = crate::artifact::download_dest(
        &ctx,
        crate::artifact::get("game.models").expect("表里必须有 game.models"),
    );
    manual_zip(&[&dest, &crate::artifact::ext_of(writable)])
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
        .into_iter()
        .collect()
}

/// 删掉本功能下下来的东西（模型 + 动态库）。用于「一键清理依赖」。
///
/// 返回 `(文件数, 字节数, 说明)`，说明是**给界面直接显示的中文**。
///
/// # ⚠️ 必须同时删 `<扩展包根>/game/models`
///
/// `data_dir(writable)`（= `<扩展包根>/midi/`）里**只有**任务临时目录与 `.part` 残留；
/// 模型落在 `<扩展包根>/game/models/`（见 `download_models`）。
/// 只清前者的话：用户点「删除依赖」，347 MB 的模型一个字节没少，
/// `status` 照样回 `models.ready = true`，**下载按钮再也不出现**。
///
/// # ⚠️ 删完还要回头看一眼盘上的真状态
///
/// `artifact::dirs_of(root, writable, "game.models")` 是两层：扩展包根下的
/// `game/models` 与随包只读的
/// `<root>/data/game/models`，谁先齐用谁。**绿色版这两层可能是同一个路径**
/// （`extDir` 没配置时扩展包根就是 `<root>/data`），所以把模型放进那一层之后，
/// 删掉 = 引擎回落到「随包自带」= 状态仍然「就绪」。这不是 bug（本就该能跑），
/// 但**对用户完全说不通**：点了删除、按钮没出来、也看不出为什么。
/// 所以这里把真实原因查出来，交给界面写清楚：
/// 是「随包自带的那份留着」，还是「下下来那份已删、按钮马上就出来」。
pub fn delete_deps(root: &Path, writable: &Path) -> (u64, u64, String) {
    fn rm_tree(p: &Path, files: &mut u64, bytes: &mut u64) {
        if !p.exists() {
            return;
        }
        let (f, b) = dir_size(p);
        if std::fs::remove_dir_all(p).is_ok() {
            *files += f;
            *bytes += b;
        }
    }

    let mut files = 0u64;
    let mut bytes = 0u64;

    // ① 下载物：`.part` 残留与任务临时目录
    let dir = data_dir(writable);
    if let Ok(rd) = std::fs::read_dir(&dir) {
        for ent in rd.flatten() {
            let p = ent.path();
            if p.is_dir() {
                rm_tree(&p, &mut files, &mut bytes);
            } else if let Ok(m) = p.metadata()
                && std::fs::remove_file(&p).is_ok()
            {
                files += 1;
                bytes += m.len();
            }
        }
    }

    // ② 下下来的模型。⚠️ 只删**扩展包根那一层**，随包只读的那层一律不碰
    //    （那是安装内容，删了就是把程序拆坏 —— 何况安装版下它根本不可写）
    let dirs = crate::artifact::dirs_of(root, writable, "game.models");
    let downloaded = dirs[0].clone();
    let bundled = dirs[1].clone();
    rm_tree(&downloaded, &mut files, &mut bytes);

    /* ⚠️ 这段判断必须**在删完之后**做（`models_dir` 是拿盘上真状态算的）。
    ⚠️ `bundled == downloaded` 那一条**必须先判**：两层同路径时（`status` 里报
    `origin = "local"`）删掉就是真删掉了、引擎没有第二层可回落，状态随即变成
    「缺 3 个」—— 那时还说「引擎会接着用随包那份」是**错话**。
    只有两层真是两个目录时才可能出现「删完仍就绪」这件事。 */
    let note = if bundled == downloaded {
        String::new()
    } else if crate::artifact::ready_of(root, writable, "game.models") {
        format!(
            "但随包自带的那份模型仍在 {}，所以状态还是「就绪」、不会出现下载按钮 —— \
             那份是安装内容，这个按钮不碰它。",
            crate::platform::clean_path(&bundled)
        )
    } else {
        "现在可以点「下载模型」重新下。".to_string()
    };

    (files, bytes, note)
}

fn dir_size(dir: &Path) -> (u64, u64) {
    let mut files = 0u64;
    let mut bytes = 0u64;
    let Ok(rd) = std::fs::read_dir(dir) else {
        return (files, bytes);
    };
    for ent in rd.flatten() {
        let p = ent.path();
        match p.metadata() {
            Ok(m) if m.is_dir() => {
                let (f, b) = dir_size(&p);
                files += f;
                bytes += b;
            }
            Ok(m) => {
                files += 1;
                bytes += m.len();
            }
            Err(_) => {}
        }
    }
    (files, bytes)
}

// ---------------------------------------------------------------------------
// 推理编排
// ---------------------------------------------------------------------------

/// 一次转录任务里可以被取消的那个旗标。
///
/// 粒度是**切片**：一个切片内部的 8 步去噪中途停不下来（每步都在 ORT 里跑，
/// 没有回头的机会），但一首歌通常就一两个切片。真要更细的粒度得把回调塞进
/// `engine::transcribe` 的每一步 —— 那会让那条已经逐位验证过的路径多一层
/// 间接，不值当。
pub struct Cancel(AtomicBool);

impl Cancel {
    pub fn new() -> Arc<Self> {
        Arc::new(Self(AtomicBool::new(false)))
    }
    pub fn stop(&self) {
        self.0.store(true, Ordering::Relaxed);
    }
    pub fn stopped(&self) -> bool {
        self.0.load(Ordering::Relaxed)
    }
}

impl Default for Cancel {
    fn default() -> Self {
        Self(AtomicBool::new(false))
    }
}

/// 一个输入文件转成 44.1 kHz 单声道 f32。
///
/// **解码交给 ffmpeg**（随包在 `tools/ffmpeg/`）：用户拖进来的可能是 mp3 / m4a /
/// flac / 视频，甚至是采样率不对的 wav。自己写解码器没有任何好处，而 ffmpeg
/// 本来就是这个程序的一部分（`audio.rs` 全在用）。
///
/// 输出写成 **32 位浮点 WAV**（`pcm_f32le`）：GAME 的输入是 f32 波形，
/// 走 16 位会在量化上白丢精度 —— 而 `game::fixture::read_wav_mono_f32` 正好
/// 就能读这一种，不用再引解码依赖。
pub async fn decode_to_wav(
    root: &Path,
    input: &Path,
    out: &Path,
    duration_sec: f64,
    cancel: &crate::net::Cancel,
    on_progress: &crate::audio::Progress,
) -> Result<(), String> {
    // ⚠️ `-map 0:a:0` 而不是让它自己挑流：拖进来的是视频时，不加这个会选中
    //    视频流然后抱怨「没有音频」（其实有）。取第一条音轨也正是用户想要的。
    let args: Vec<String> = vec![
        "-i".into(),
        input.to_string_lossy().to_string(),
        "-map".into(),
        "0:a:0".into(),
        "-vn".into(),
        "-ac".into(),
        "1".into(),
        "-ar".into(),
        algo::SAMPLE_RATE.to_string(),
        "-c:a".into(),
        "pcm_f32le".into(),
        "-f".into(),
        "wav".into(),
        out.to_string_lossy().to_string(),
    ];
    crate::audio::run_ffmpeg(root, &args, duration_sec, cancel, on_progress).await
}

/// 跑一次转录，返回音符表与耗时。
///
/// 推理方式**以盘上的设置为准**，不看调用方传进来的 `opts.device`：这个开关在界面上，
/// 而任务可能来自「再跑一次」或别处，照 body 走会让「设置里选了 GPU、这一首悄悄按
/// CPU 跑」。
///
/// ⚠️ **这个函数是阻塞的**（CPU 推理，几秒到几分钟）。调用方必须用
/// `tokio::task::spawn_blocking` 包起来，否则会把整个 tokio 运行时卡住 ——
/// 表现是界面所有接口一起失联，而进度条停在原地。
pub fn transcribe_blocking(
    writable: &Path,
    models: &Path,
    dll: &Path,
    wav: &Path,
    opts: &engine::Options,
    cancel: &Cancel,
    on_progress: impl Fn(&str, f64) + Send + Sync,
) -> Result<engine::Report, String> {
    let wave = crate::game::fixture::read_wav_mono_f32(wav)
        .map_err(|e| format!("读音频失败（{}）：{e}", wav.display()))?;
    if wave.is_empty() {
        return Err("这段音频是空的".into());
    }
    if cancel.stopped() {
        return Err(CANCELLED.into());
    }
    let mut opts = opts.clone();
    opts.device = read_device(writable);
    let report = engine::transcribe(models, dll, &wave, &opts, &|what, pct| {
        on_progress(what, pct)
    })?;
    if cancel.stopped() {
        return Err(CANCELLED.into());
    }
    Ok(report)
}

/// 取消时返回的错误文案。`ipc::midi` 认这个串把任务标成「已取消」而不是「失败」。
pub const CANCELLED: &str = "已取消";

// ---------------------------------------------------------------------------
// 结果落盘
// ---------------------------------------------------------------------------

/// 把 `Report` 写成三样东西：`.mid`、`.csv`、`.json`，返回文件名与路径。
///
/// 为什么三样都给：
///   * `.mid` 是终点（拖进 DAW / 编辑器直接用）；
///   * `.csv` 是给人的（哪一秒哪个音、偏高多少音分，表格里一眼看得出）；
///   * `.json` 是给程序的（保留浮点音高，别的工具要接着处理就用它）。
///
/// `base` 是不带扩展名的文件名主干（调用方已经从输入文件名取好并清过）。
pub fn write_outputs(
    out_dir: &Path,
    base: &str,
    report: &engine::Report,
) -> Result<Vec<PathBuf>, String> {
    std::fs::create_dir_all(out_dir).map_err(|e| format!("建输出目录失败：{e}"))?;
    let mut written = Vec::new();

    let mid = out_dir.join(format!("{base}.mid"));
    std::fs::write(&mid, engine::notes_to_midi(&report.notes))
        .map_err(|e| format!("写 MIDI 失败：{e}"))?;
    written.push(mid);

    let mut csv = String::from("index,onset,offset,duration,pitch,midi\n");
    for (i, (onset, offset, pitch, note)) in engine::note_rows(&report.notes).iter().enumerate() {
        csv.push_str(&format!(
            "{},{:.4},{:.4},{:.4},{:.4},{}\n",
            i + 1,
            onset,
            offset,
            offset - onset,
            pitch,
            note
        ));
    }
    let csv_path = out_dir.join(format!("{base}.csv"));
    std::fs::write(&csv_path, csv).map_err(|e| format!("写 CSV 失败：{e}"))?;
    written.push(csv_path);

    let json_path = out_dir.join(format!("{base}.json"));
    let body = json!({
        "source": "GAME (V-Synth-Studio 原生移植)",
        "samplerate": algo::SAMPLE_RATE,
        "timestep": algo::TIMESTEP,
        /* 实际用的是哪条推理路径。⚠️ 用户选了 GPU 也可能走到这儿是 "CPU"
           （CUDA 建会话失败会整条退回，原因写在任务日志里），所以**必须记下来** ——
           否则「我明明开了 GPU」和「怎么还是这么慢」之间没有任何可查的东西。 */
        "backend": report.backend,
        "nSamples": report.n_samples,
        "slices": report.slices.iter().map(|(o, n)| json!({"offset": o, "samples": n})).collect::<Vec<_>>(),
        "steps": report.per_step,
        "seconds": {
            "encoder": report.encoder_seconds,
            "segmenter": report.segmenter_seconds,
            "estimator": report.estimator_seconds,
        },
        "notes": engine::note_rows(&report.notes).iter().map(|(o, e, p, m)| json!({
            "onset": o, "offset": e, "pitch": p, "midi": m,
        })).collect::<Vec<_>>(),
    });
    std::fs::write(
        &json_path,
        serde_json::to_vec_pretty(&body).map_err(|e| e.to_string())?,
    )
    .map_err(|e| format!("写 JSON 失败：{e}"))?;
    written.push(json_path);

    Ok(written)
}

/// 从输入文件名取一个干净的输出主干。
///
/// 去掉路径、扩展名，再把文件名里不适合做文件名的字符换成 `_` —— 中文留着
/// （Windows 上完全合法，用户自己的歌名本来也多半是中文），只挡 `\ / : * ? " < > |`。
pub fn output_stem(input: &Path) -> String {
    let stem = input
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| "未命名".into());
    let cleaned: String = stem
        .chars()
        .map(|c| {
            if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|')
                || (c as u32) < 0x20
            {
                '_'
            } else {
                c
            }
        })
        .collect();
    let cleaned = cleaned.trim().trim_matches('.').to_string();
    if cleaned.is_empty() {
        "未命名".into()
    } else {
        cleaned.chars().take(80).collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_stem_strips_extensions_and_blocks_path_separators() {
        /* ⚠️ **目录部分必须用 `Path::join` 拼，不能写死 `r"D:\歌\…"`。**
        `\` 只在 Windows 上是分隔符；Linux 上整串是**一个文件名**，
        `file_stem` 于是给出 `D:\歌\干声`、再被 `\`→`_` 洗成 `D__歌_干声`。
        `join` 用的是**本机**分隔符，两个平台表达的是同一件事。 */
        assert_eq!(output_stem(&Path::new("歌").join("干声.wav")), "干声");
        assert_eq!(output_stem(Path::new("/tmp/a.mp3")), "a");
        /* 文件名里本来不该有的字符被换掉；中文与空格留着。
        ⚠️ 冒号这一条**不能写成 `x:y*z?.flac`**：单字母 + `:` 会被 Windows 当成
        *盘符前缀*剥掉，只剩 `y_z_`（那是测试自己的 bug，不是 `output_stem` 的）。
        这里把冒号挪到非盘符位（`ab:`）——冒号照样被换成 `_`，而 `ab:` 在任何平台
        都不是盘符。 */
        assert_eq!(output_stem(Path::new("ab:c*d?.flac")), "ab_c_d_");
        assert_eq!(output_stem(Path::new("人声 01.m4a")), "人声 01");
        // 全被过滤掉、或者压根没有名字，都退到占位名
        assert_eq!(output_stem(Path::new("...")), "未命名");
        /* ⚠️ 全是点的名字 `"..."` 被 `trim_matches('.')` 吃掉才走到占位名；
        但 `.wav` 这种**没有主干只有扩展名**的，`file_stem()` 给的就是 `"wav"`
        （Rust 视 `.wav` 为「无扩展名的点文件」，不是「扩展名为 wav」）——
        于是输出会是 `wav.mid`。难看但不炸，不值得为它加特判。 */
        assert_eq!(output_stem(&Path::new("歌").join(".wav")), "wav");
    }

    #[test]
    fn stem_is_capped_so_windows_never_complains() {
        let long = "啊".repeat(200);
        let got = output_stem(Path::new(&format!("{long}.wav")));
        assert_eq!(got.chars().count(), 80);
    }

    #[test]
    fn cancel_starts_clear_and_stays_set() {
        let c = Cancel::new();
        assert!(!c.stopped());
        c.stop();
        assert!(c.stopped());
    }

    /// `mini_onnx()` 的字节要是拼错了，`probe_cuda` 会给出**错误的结论** ——
    /// 一台真有 N 卡的机器会被报成「CUDA 建不出会话」，而用户只看到 GPU 那格锁着。
    /// 所以这里不依赖 onnxruntime，直接按 protobuf 线格式把它拆一遍。
    #[test]
    fn mini_onnx_is_a_well_formed_model() {
        /// 解析一个 varint，返回 `(值, 吃掉几个字节)`。
        fn take_varint(b: &[u8], i: usize) -> (u64, usize) {
            let (mut v, mut n) = (0u64, 0usize);
            loop {
                let byte = *b.get(i + n).expect("varint 越界");
                v |= ((byte & 0x7f) as u64) << (7 * n);
                n += 1;
                if byte & 0x80 == 0 {
                    return (v, n);
                }
            }
        }
        /// 把一个 message 的字段拆成 `(field_number, 内容)`，只处理 LEN 与 varint。
        fn fields(b: &[u8]) -> Vec<(u64, Vec<u8>)> {
            let mut out = Vec::new();
            let mut i = 0;
            while i < b.len() {
                let (tag, n) = take_varint(b, i);
                i += n;
                let (num, wire) = (tag >> 3, tag & 7);
                assert!(
                    wire == 0 || wire == 2,
                    "字段 {num} 的 wire type 是 {wire}（整块是 {}）",
                    b.iter()
                        .map(|x| format!("{x:02X}"))
                        .collect::<Vec<_>>()
                        .join(" ")
                );
                if wire == 0 {
                    let (v, n) = take_varint(b, i);
                    i += n;
                    out.push((num, v.to_le_bytes().to_vec()));
                } else {
                    let (len, n) = take_varint(b, i);
                    i += n;
                    let end = i + len as usize;
                    assert!(end <= b.len(), "字段 {num} 声称的长度越界");
                    out.push((num, b[i..end].to_vec()));
                    i = end;
                }
            }
            out
        }
        fn str_of(f: &[u8]) -> &str {
            std::str::from_utf8(f).expect("不是 UTF-8")
        }
        /// `ValueInfoProto` → 名字。⚠️ **必须按字段号找，不能按下标猜**：
        /// `type` 写成字段 1 时，`ValueInfoProto` 成了「两个 `name`、没有 `type`」，
        /// 而按 `fs[1]` 取值的老测试照样全绿。
        fn value_info(f: &[u8], who: &str) -> String {
            let fs = fields(f);
            let name_field = fs.iter().find(|(n, _)| *n == 1).expect("没有 name 字段");
            let type_field = fs.iter().find(|(n, _)| *n == 2).unwrap_or_else(|| {
                panic!(
                    "{who}: ValueInfoProto 没有 type 字段（只有 {:?}）",
                    fs.iter().map(|(n, _)| *n).collect::<Vec<_>>()
                )
            });
            let type_proto = fields(&type_field.1);
            assert_eq!(
                type_proto[0].0, 1,
                "{who}: TypeProto.tensor_type 必须是字段 1"
            );
            let tensor = fields(&type_proto[0].1);
            assert_eq!(tensor[0].0, 1, "{who}: elem_type 必须是字段 1");
            assert_eq!(
                tensor[0].1,
                [1, 0, 0, 0, 0, 0, 0, 0],
                "{who}: elem_type 必须是 FLOAT(1)"
            );
            assert_eq!(tensor[1].0, 2, "{who}: shape 必须是字段 2");
            let shape = fields(&tensor[1].1);
            assert_eq!(shape[0].0, 1, "{who}: shape.dim[0] 必须是字段 1");
            let dim = fields(&shape[0].1);
            assert_eq!(dim[0].0, 1, "{who}: dim_value 必须是字段 1");
            assert_eq!(
                dim[0].1,
                [1, 0, 0, 0, 0, 0, 0, 0],
                "{who}: dim_value 必须是 1（静态维度）"
            );
            str_of(&name_field.1).to_owned()
        }

        let m = fields(&mini_onnx());
        assert_eq!(m[0].0, 1, "第一个字段必须是 ir_version");
        assert_eq!(m[0].1, [7, 0, 0, 0, 0, 0, 0, 0], "ir_version 必须是 7");
        assert_eq!(m[1].0, 7, "第二个字段必须是 graph");
        assert_eq!(m[2].0, 8, "第三个字段必须是 opset_import");

        let graph = fields(&m[1].1);
        assert_eq!(str_of(&graph[0].1), "cuda-probe");
        let node = fields(&graph[1].1);
        assert_eq!(node[0].0, 1, "node.input");
        assert_eq!(str_of(&node[0].1), "x");
        assert_eq!(node[1].0, 2, "node.output");
        assert_eq!(str_of(&node[1].1), "y");
        assert_eq!(node[2].0, 4, "node.op_type");
        assert_eq!(str_of(&node[2].1), "Identity");
        assert_eq!(value_info(&graph[2].1, "input"), "x", "graph.input");
        assert_eq!(value_info(&graph[3].1, "output"), "y", "graph.output");

        let opset = fields(&m[2].1);
        assert_eq!(opset[0].1, [13, 0, 0, 0, 0, 0, 0, 0], "opset 必须是 13");
    }

    /// 推理方式的读写与容错。
    ///
    /// ⚠️ 这组断言的用处是**挡住「顺手改个名字」**：设置文件写的是
    /// `<可写>/midi/midi_settings.json`，而音轨分离那边是
    /// `<可写>/svsep/data/inference_settings.json`（Python 在管）。两边都叫「推理方式」
    /// 但**不是同一个文件、键名也不同**（我们 `device`、它 `mode`）。
    #[test]
    fn device_settings_round_trip_and_fall_back_to_auto() {
        let base = std::env::temp_dir().join("vss-midi-device-test");
        let _ = std::fs::remove_dir_all(&base);
        let writable = base.join("appdata");

        // 没有文件 ⇒ 自动
        assert_eq!(read_device(&writable), Device::Auto);

        for dev in [Device::Gpu, Device::Cpu, Device::Auto] {
            write_device(&writable, dev).unwrap();
            assert_eq!(read_device(&writable), dev, "写进去再读出来必须一致");
        }

        // 键名是 `device`，跟音轨分离那边的 `mode` 不一样
        let raw = std::fs::read_to_string(settings_file(&writable)).unwrap();
        assert!(raw.contains("\"device\""), "实际写出来的是：{raw}");
        assert!(
            !raw.contains("inference_settings"),
            "别把设置写进音轨分离那个文件，实际：{raw}"
        );

        // 认不出的值 / 坏文件 ⇒ 自动（界面永远拿得到一个合法值）
        std::fs::write(settings_file(&writable), r#"{"device":"tpu"}"#).unwrap();
        assert_eq!(read_device(&writable), Device::Auto, "认不出的值当自动");
        std::fs::write(settings_file(&writable), "{ 这不是 JSON").unwrap();
        assert_eq!(read_device(&writable), Device::Auto, "文件坏了也当自动");

        // 解析函数本身：大小写与空格都吃掉，其余一律自动
        assert_eq!(Device::parse(" GPU "), Device::Gpu);
        assert_eq!(Device::parse("Cpu"), Device::Cpu);
        assert_eq!(Device::parse("cuda"), Device::Auto);

        let _ = std::fs::remove_dir_all(&base);
    }

    /// 没有 CUDA 的那台机器上，`device_status` 该说什么**是用户唯一看得到的东西**：
    /// 页面把后端给的 `note` 原样显示，所以这段话术的触发条件必须钉住。
    ///
    /// ⚠️ `dll = None` 是**唯一能在这台机器上稳定复现的分支**：真给一个 dll 路径会
    /// 去初始化 CUDA、把几百 MB 的组件加载进测试进程。「能解锁」那一半靠 N 卡机器验。
    #[test]
    fn device_status_talks_to_the_user_when_cuda_is_missing() {
        let base = std::env::temp_dir().join("vss-midi-devstatus-test");
        let _ = std::fs::remove_dir_all(&base);
        let writable = base.join("appdata");

        // 没选 GPU ⇒ 不该有那句补救话术（页面此时也不该出现警示条）
        write_device(&writable, Device::Cpu).unwrap();
        let st = device_status(&writable, None);
        assert_eq!(st.device, Device::Cpu);
        assert!(!st.cuda_ok);
        assert!(
            st.note.is_empty(),
            "选了 CPU 还说「用不了 GPU」是错话：{}",
            st.note
        );
        assert!(
            st.cuda_detail.contains("ONNX Runtime"),
            "没有 dll 时必须说清是找不到运行库，实到：{}",
            st.cuda_detail
        );

        // 选了 GPU 但用不了 ⇒ 必须给话术，且带上后端探出来的原因
        write_device(&writable, Device::Gpu).unwrap();
        let st = device_status(&writable, None);
        assert_eq!(st.device, Device::Gpu);
        assert!(!st.cuda_ok);
        assert!(st.note.contains("用不了 GPU"), "实到：{}", st.note);
        assert!(
            st.note.contains(&st.cuda_detail),
            "话术里必须带上原因，实到：{}",
            st.note
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// `runtime_dll` 的挑法：**带 CUDA provider 的那份优先**，别让用户自己放的那份
    /// 官方 CPU 包（候选第一个，在 `<可写>/midi`）把音轨分离运行时里那份 GPU 构建
    /// 遮蔽掉 —— 遮蔽了，`probe_cuda` 永远回「没有 CUDA provider」，GPU 那格就再也
    /// 点不亮。
    #[test]
    fn a_cuda_capable_runtime_wins_over_a_downloaded_cpu_pack() {
        // debug 构建里 `runtime_dll` 认这个环境变量，先清掉免得干扰
        // SAFETY: 单测里没有别的线程在读这个变量。
        unsafe { std::env::remove_var("VSS_MIDI_DLL") };
        let base = std::env::temp_dir().join("vss-midi-pick-test");
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("root");
        let writable = base.join("writable");
        /* ⚠️ 扩展包根是**进程级**的，别的单测可能已经把它指到别处；这一条要的是
        「根 = 可写目录」这个默认形态，所以显式钉一次。 */
        crate::artifact::init_ext_base("");

        // ① 用户自己放的那份：官方 CPU 包，落在 `<可写>/midi/`（候选里的第一个）
        let cpu = data_dir(&writable).join(crate::tools::dll("onnxruntime"));
        std::fs::create_dir_all(cpu.parent().unwrap()).unwrap();
        std::fs::write(&cpu, b"x").unwrap();

        // ② 音轨分离运行时里那份：GPU 构建 —— 旁边躺着 CUDA provider
        let capi = crate::svsep::runtime_base(&writable)
            .join("runtime")
            .join("Lib")
            .join("site-packages")
            .join("onnxruntime")
            .join("capi");
        std::fs::create_dir_all(&capi).unwrap();
        let gpu = capi.join(crate::tools::dll("onnxruntime"));
        std::fs::write(&gpu, b"x").unwrap();
        let provider = capi.join(crate::tools::dll("onnxruntime_providers_cuda"));

        // 只有 CPU 包时，就用它（用户没装音轨分离，这就是他能有的最好的一份）
        assert_eq!(
            runtime_dll(&root, &writable).as_deref(),
            Some(cpu.as_path())
        );

        // 多一份 GPU 构建之后，必须改挑 GPU 那份 —— 遮蔽就发生在这一行
        std::fs::write(&provider, b"x").unwrap();
        assert_eq!(
            runtime_dll(&root, &writable).as_deref(),
            Some(gpu.as_path())
        );

        // 把 GPU 那份删掉，退回 CPU 包（别把「没有」当成「出错」）
        std::fs::remove_file(&gpu).unwrap();
        assert_eq!(
            runtime_dll(&root, &writable).as_deref(),
            Some(cpu.as_path())
        );

        let _ = std::fs::remove_dir_all(&base);
    }

    /// 「往上找 `nvidia` 目录」那个查找器 —— **找不到时必须回 `None`**。
    ///
    /// ⛔ 回 `None` 与回一个不存在的目录，后果完全不同：`probe_cuda` 拿到 `None` 会
    /// 继续去问 ONNX Runtime（机器上可能有系统级 CUDA），而拿到一个空目录会让
    /// 建会话直接报错、把整条 GPU 路判死。
    ///
    /// 另有一条更隐蔽的：**组件分在四个 `bin/` 里**（cudart / cublas / cufft / cudnn），
    /// 每个组件都得能各自定位到自己的目录 —— 夹具把这四层都搭出来，下面逐个数。
    #[test]
    fn find_dylibs_dir_needs_a_real_hit() {
        let base = std::env::temp_dir().join("vss-midi-dylib-test");
        let _ = std::fs::remove_dir_all(&base);
        /* 仿造真实布局。⚠️ **层级必须与真的一比一**：
          `…/Lib/site-packages/nvidia/cublas/bin/cublas64_12.dll`   ← 组件（在 nvidia 下面）
          `…/Lib/site-packages/onnxruntime/onnxruntime.dll`         ← ORT 本体（与 nvidia 同级）
        夹具多一层或少一层都会让人去改没坏的生产代码。 */
        let bin = base
            .join("Lib")
            .join("site-packages")
            .join("nvidia")
            .join("cublas")
            .join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let dll = bin.join("cublas64_12.dll");
        std::fs::write(&dll, b"x").unwrap();
        let cuda = base
            .join("Lib")
            .join("site-packages")
            .join("onnxruntime")
            .join("onnxruntime.dll");
        std::fs::create_dir_all(cuda.parent().unwrap()).unwrap();
        std::fs::write(&cuda, b"x").unwrap();

        // 从 ORT 本体那个 dll 往上找，应当摸到 cublas\bin，再返回它（要加进 PATH 的就是它）
        let hit = find_dylibs_dir(&cuda, "cublas64_12.dll").expect("应当能找到");
        assert_eq!(
            hit, bin,
            "返回的必须是**装 dll 的那个目录**，不是 nvidia 根"
        );

        /* ⭐ 四个组件四个目录，各进各的 `bin/`。只传 `nvidia/` 给组件加载一个都命中不了，
        所以这里逐个钉子：谁把 `find_dylibs_dir` 改成只认某一个组件目录，这几条立刻红。 */
        for comp in ["cuda_runtime", "cublas", "cufft", "cudnn"] {
            std::fs::create_dir_all(
                bin.parent()
                    .unwrap()
                    .parent()
                    .unwrap()
                    .join(comp)
                    .join("bin"),
            )
            .unwrap();
        }
        let nvidia = bin.parent().unwrap().parent().unwrap();
        std::fs::write(
            nvidia
                .join("cuda_runtime")
                .join("bin")
                .join("cudart64_12.dll"),
            b"x",
        )
        .unwrap();
        std::fs::write(
            nvidia.join("cufft").join("bin").join("cufft64_11.dll"),
            b"x",
        )
        .unwrap();
        std::fs::write(nvidia.join("cudnn").join("bin").join("cudnn64_9.dll"), b"x").unwrap();
        assert_eq!(
            find_dylibs_dir(&cuda, "cudart64_12.dll"),
            Some(nvidia.join("cuda_runtime").join("bin")),
            "cudart 在 cuda_runtime/bin，不能回 cublas 那个目录"
        );
        assert_eq!(
            find_dylibs_dir(&cuda, "cufft64_11.dll"),
            Some(nvidia.join("cufft").join("bin")),
            "cufft 在 cufft/bin"
        );
        assert_eq!(
            find_dylibs_dir(&cuda, "cudnn64_9.dll"),
            Some(nvidia.join("cudnn").join("bin")),
            "cudnn 在 cudnn/bin"
        );

        /* ⛔ 下面这条挡的是「把判据写成『哪一层叫 nvidia』」：从 ORT 本体往上走时候选是
        `onnxruntime → site-packages → …`，而 `nvidia` 是 `site-packages` **下面**的一层，
        那样写条件恒假、永远找不到。这里用一个 nvidia 树里不存在的名字，且它**只**在 ORT
        自己那一层有 —— 若有人把查找范围放宽到「整个 site-packages」，这条会红。 */
        std::fs::write(
            cuda.parent()
                .unwrap()
                .join("onnxruntime_providers_shared.dll"),
            b"x",
        )
        .unwrap();
        assert_eq!(
            find_dylibs_dir(&cuda, "onnxruntime_providers_shared.dll"),
            None,
            "组件查找只在 nvidia/ 里做，别把 ORT 自己那一层也算进去"
        );

        // 找一个不存在的 dll ⇒ None（别返回一个看似合理的空目录）
        assert!(
            find_dylibs_dir(&cuda, "cublasLt64_12.dll").is_none(),
            "夹具里没有这个组件 ⇒ 必须是 None"
        );

        // dll 在一个跟 nvidia 毫无关系的目录里 ⇒ None
        let lone = base.join("elsewhere").join("onnxruntime.dll");
        std::fs::create_dir_all(lone.parent().unwrap()).unwrap();
        std::fs::write(&lone, b"x").unwrap();
        assert!(find_dylibs_dir(&lone, "cublas64_12.dll").is_none());

        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn status_reports_every_candidate_missing() {
        let dir = std::env::temp_dir().join("vss-midi-status-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let v = status(&dir, &dir);
        assert_eq!(v["models"]["ready"], json!(false));
        assert_eq!(v["models"]["missing"].as_array().unwrap().len(), 3);
        assert_eq!(v["runtime"]["ready"], json!(false));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 摆一套假模型（内容无所谓，`missing_models` 只看文件在不在）。
    fn fake_models(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        for f in engine::MODEL_FILES {
            std::fs::write(dir.join(f), b"x").unwrap();
        }
    }

    /** 打一个只含 `GAME-1.0.3-large-onnx/<文件>` 的 zip（内容随便，形状对就行）。 */
    fn game_zip(path: &Path, entries: &[&str]) {
        use std::io::Write;
        let f = std::fs::File::create(path).unwrap();
        let mut w = zip::ZipWriter::new(f);
        let opts = zip::write::SimpleFileOptions::default();
        for e in entries {
            w.start_file(format!("GAME-1.0.3-large-onnx/{e}"), opts)
                .unwrap();
            w.write_all(b"not-really-onnx").unwrap();
        }
        w.finish().unwrap();
    }

    /// 用户**手放**的权重包（从 123 云盘下下来丢进目录的那种）：直接解，不下。
    ///
    /// 这里给的是「必定连不上」的地址 —— 真去下的话拿到的会是网络错，而我们要看到的是
    /// **解包之后**才会有的那句「缺 …」，它同时证明了两件事：走了手放那条路、而且解开了。
    #[tokio::test]
    async fn a_hand_placed_zip_is_unpacked_instead_of_downloaded() {
        let base = std::env::temp_dir().join("vss-midi-manual");
        let _ = std::fs::remove_dir_all(&base);
        let dest = base.join("game").join("models");
        std::fs::create_dir_all(&dest).unwrap();
        // 名字故意不标准：认死名字等于逼用户改名
        game_zip(
            &dest.join("GAME-1.0.3-large-onnx (1).zip"),
            &["config.json", "encoder.onnx"],
        );

        // 界面靠这个把按钮写成「解压」
        assert_eq!(
            manual_files(&base),
            vec!["GAME-1.0.3-large-onnx (1).zip".to_string()],
            "状态里该报出这套手放的包"
        );

        static PAUSE: AtomicBool = AtomicBool::new(false);
        static STOP: AtomicBool = AtomicBool::new(false);
        let ctl = crate::svsep::DownloadCtl::new(&PAUSE, &STOP, false);
        let err = download_models(&base, &ctl, |_, _, _| {})
            .await
            .expect_err("这个假包里没有那三个 onnx，解完必然报「缺」");
        assert!(
            err.contains("模型包解开了"),
            "该是解包之后的错（说明走的是手放那条路）：{err}"
        );
        assert!(
            !dest.join("GAME-1.0.3-large-onnx (1).zip").exists(),
            "解完该把手放的那个包删掉"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 拿**真的**权重包走一遍手放那条路：`strip` 对不对、落点对不对、校验过不过。
    ///
    ///     $env:VSS_REAL_GAME_ZIP='资料归档\GAME-1.0.3-large-onnx.zip'
    ///     cargo test --lib real_game_zip -- --nocapture
    #[tokio::test]
    async fn unpacks_the_real_game_zip_when_asked() {
        let Ok(zip) = std::env::var("VSS_REAL_GAME_ZIP") else {
            return;
        };
        let base = std::env::temp_dir().join("vss-midi-manual-real");
        let _ = std::fs::remove_dir_all(&base);
        let dest = base.join("game").join("models");
        std::fs::create_dir_all(&dest).unwrap();
        let name = Path::new(&zip).file_name().unwrap().to_owned();
        let placed = dest.join(&name);
        // 复制而不是搬：源包是仓库里的产物，测试不该动它
        std::fs::copy(&zip, &placed).expect("把真包拷进落点失败");

        static PAUSE: AtomicBool = AtomicBool::new(false);
        static STOP: AtomicBool = AtomicBool::new(false);
        let ctl = crate::svsep::DownloadCtl::new(&PAUSE, &STOP, false);
        let t = std::time::Instant::now();
        let out = download_models(&base, &ctl, |_, _, _| {})
            .await
            .expect("真包该能解开");
        println!(
            "手放的真包：{} 个文件 / {} 字节，耗时 {:?}",
            out["files"],
            out["bytes"],
            t.elapsed()
        );
        let v = status(&base, &base);
        assert_eq!(v["models"]["ready"], json!(true), "解完该是就绪：{v}");
        assert!(!placed.exists(), "解完该把手放的那个包删掉");
        let _ = std::fs::remove_dir_all(&base);
    }

    /// `models.origin` 三种取值，以及「绿色版两层同路径」这个坑。
    ///
    /// ⚠️ 这组断言是**给未来改的人看的**：`origin` 报的是「引擎在用哪个目录」，
    /// 不是「这份是谁放的」—— 绿色版下这两件事物理上不可分，任何想按目录状态
    /// 区分「下下来的 / 随包自带的」的改法都会在这里红。
    #[test]
    fn models_origin_distinguishes_portable_from_installed() {
        let base = std::env::temp_dir().join("vss-midi-origin-test");
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("root");
        let writable = base.join("appdata");

        // ① 绿色版：`writable == root/data` ⇒ 两层是同一个绝对路径
        let portable = root.join("data");
        fake_models(&portable.join("game").join("models"));
        let v = status(&root, &portable);
        assert_eq!(v["models"]["ready"], json!(true));
        assert_eq!(
            v["models"]["origin"],
            json!("local"),
            "绿色版两层同路径 ⇒ local（没有第二层可回落，界面不该说「随包自带」）"
        );

        // ② 安装版 + 只有可写那一层有 ⇒ downloaded
        fake_models(&writable.join("game").join("models"));
        let v = status(&root, &writable);
        assert_eq!(v["models"]["origin"], json!("downloaded"));

        // ③ 安装版 + 可写层空、随包层齐 ⇒ bundled（界面要据此写清删除按钮的行为）
        let _ = std::fs::remove_dir_all(writable.join("game"));
        fake_models(&root.join("data").join("game").join("models"));
        let v = status(&root, &writable);
        assert_eq!(v["models"]["ready"], json!(true));
        assert_eq!(v["models"]["origin"], json!("bundled"));

        let _ = std::fs::remove_dir_all(&base);
    }

    /// 点「删除依赖」必须**同时**清掉下下来的模型 —— 只清 `<可写>/midi/`
    /// （那儿只有 `.part` 残留）的话，模型一个字节没少、
    /// 下载按钮再也不出现。
    #[test]
    fn delete_deps_removes_downloaded_models_but_not_bundled() {
        let base = std::env::temp_dir().join("vss-midi-delete-test");
        let _ = std::fs::remove_dir_all(&base);
        let root = base.join("root");
        let writable = base.join("appdata");

        // 安装版：两层是两个目录，都能写
        let dl_dir = writable.join("game").join("models");
        let bundle_dir = root.join("data").join("game").join("models");
        fake_models(&dl_dir);
        fake_models(&bundle_dir);

        // 顺带放两个下载物，确认那一路也还在删
        let midi_dir = data_dir(&writable);
        std::fs::create_dir_all(&midi_dir).unwrap();
        std::fs::write(midi_dir.join("ort.part"), b"half").unwrap();

        let (files, bytes, note) = delete_deps(&root, &writable);
        assert_eq!(files, 4, "3 个模型 + 1 个 ort.part");
        assert_eq!(bytes, 3 + 4);
        assert!(!dl_dir.exists(), "可写那一层必须删掉");
        assert!(
            bundle_dir.join("encoder.onnx").is_file(),
            "随包那层一个字节都不能动"
        );
        assert!(
            note.contains("随包自带"),
            "删完仍就绪时必须说清是随包那份在顶着，实际：{note}"
        );

        /* 绿色版：两层同路径，删完就是真没了 ⇒ note 必须是空的。
        ⚠️ 不能说「引擎会接着用随包自带的那份模型」—— 一个目录被删光了，
        引擎没有第二层可回落。 */
        let portable = base.join("portable").join("data");
        fake_models(&portable.join("game").join("models"));
        let (files, _bytes, note) = delete_deps(&base.join("portable"), &portable);
        assert_eq!(files, 3);
        assert_eq!(note, "", "绿色版删完是真删掉了，不能说「还在用随包那份」");

        let _ = std::fs::remove_dir_all(&base);
    }
}
