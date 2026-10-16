//! 外部产物表 —— 「本程序需要哪些**不属于源码**的东西、它们在哪、齐没齐」的**唯一**真相。
//!
//! ## 为什么有这个模块
//!
//! **产物的形状只在这里声明一次**，各模块改问 `artifact::` 要答案。
//! 同一条判据若在各处各写一遍（`audio::find_ffmpeg` 与 `tools::detect_tools` 各一份、
//! `midi_transcribe` 里三处、`game::engine` 里两处），加一个产物就要改 6 处、
//! 改一条判据要在 3 份实现里同步。
//!
//! ## 三种形态
//!
//! | 形态 | 例子 | 特征 |
//! |---|---|---|
//! | 随包可执行文件 / 动态库 | ffmpeg / yt-dlp / LibreSVIP / onnxruntime | 在 `tools/` 下；前两个允许退回系统 PATH |
//! | 下载物 + 随包物两层 | GAME 模型 | 可写目录优先，随包目录兜底 |
//! | 随包只读数据 | pinyin.json / resources.json | 只在 `<root>/data/` |
//! | CDN 下载物 | svsep 运行时 / svsep 模型 / GAME 模型 | 落**扩展包目录**，点按钮才下 |
//!
//! ## 扩展包目录（`Base::Ext`）
//!
//! 「点按钮下下来的那几个包」全部落在一个**可配置**的根下（`config.json` 的 `extDir`）：
//! 合计约 8 GB，装在 C 盘紧张的人身上是灾难，所以给用户一个「换个盘」的入口。
//! 没配置时它就是**可写目录** —— 也就是这一条改动之前的行为，老用户的文件一个都不用搬。
//! 相对路径按各产物自己那套走（`svsep/`、`game/models/`），因为它们各自还要再分子目录。
//!
//! ## 三个**真实例外**，别硬塞进「通用形状」
//!
//! 1. **系统 PATH 兜底**（`path_names`）—— ffmpeg / yt-dlp 可以完全没有
//!    随包副本，直接用系统装的那个。这是有意的：Linux 上 `pacman -S ffmpeg` 就够了，
//!    不该逼用户再放一份进 `tools/`。
//! 2. **`Base::Svsep`** —— 音轨分离的运行时落点**用户可配置**（`config.json` 的
//!    `svsepRuntimeDir`），装不装在 `Program Files` 下也不一样。它不是固定的
//!    `root`/`writable` 子路径，所以单列一个基准。
//! 3. **`resources.json` 是启动哨兵** —— `lib.rs::resolve_paths` 靠它判定「程序根目录
//!    在哪」，而那发生在表可用**之前**（鸡生蛋）。所以那里保留自己的一句 `is_file()`，
//!    不查表。表里这一条是给「报状态」用的。
//!
//! ## 判「齐」的两种语义，都要留着
//!
//! * `min_bytes == 0` → 存在即算齐（可执行文件、数据文件）。
//! * `min_bytes > 0` → 小于它算 `Partial`（**下了一半**），等于 0 字节算 `Missing`。
//!   三态是为了让界面能区分「还没下」和「下了一半」。
//!   ⚠️ 别把 `Partial` 合并进 `Missing`：那会让「下了一半」显示成「缺文件」，
//!   用户以为要重下整包。

use std::borrow::Cow;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{Value, json};

use crate::tools::{dll, exe};

/* ══════════════════════════════ 数据形状 ══════════════════════════════ */

/// 查询上下文。产物的位置全部由这几个目录推出来。
///
/// ⚠️ `svsep`（音轨分离运行时根）与 `ext`（扩展包根）都是**显式带进来的**，
/// 不在这里去查那个全局。读全局会让这一层变成不可单测的（测试要改全局，并行跑就互相踩），
/// 也会让「同一个 ctx 两次查询得不同结果」这种诡异现象变得可能。
#[derive(Clone)]
pub struct Ctx<'a> {
    /// 只读资源根（含 `tools/`、`data/`）
    pub root: &'a Path,
    /// 可写目录（绿色版 = `<root>/data`，安装版 = `%APPDATA%\<id>`）
    pub writable: &'a Path,
    /// 音轨分离的运行时根（见模块头「真实例外 2」）
    pub svsep: Cow<'a, Path>,
    /// 扩展包根（`extDir`；没配置时等于 `writable`，见模块头那一段）。
    /// 所有权在这边：调用方传进来的多半是一个**刚算出来的**路径。
    pub ext: PathBuf,
}

impl<'a> Ctx<'a> {
    /// 常规入口：svsep 基准与扩展包根都取这一次运行真正用的那一个。
    ///
    /// 只有用到 `Base::Svsep` / `Base::Ext` 的产物才依赖它们。
    pub fn new(root: &'a Path, writable: &'a Path) -> Self {
        Self {
            root,
            writable,
            svsep: Cow::Owned(crate::svsep::runtime_base(&ext_of(writable))),
            ext: ext_of(writable),
        }
    }

    /// 指定 svsep 基准与扩展包根。单测用，或调用方**已经知道**那两个目录时用。
    pub fn with_dirs(root: &'a Path, writable: &'a Path, svsep: &'a Path, ext: &Path) -> Self {
        Self {
            root,
            writable,
            svsep: Cow::Borrowed(svsep),
            ext: ext.to_path_buf(),
        }
    }

    /// 只关心 `Base::Root` 下的产物时用（`writable` / `svsep` / `ext` 都不会被查到）。
    pub fn root_only(root: &'a Path) -> Self {
        Self {
            root,
            writable: root,
            svsep: Cow::Owned(PathBuf::new()),
            ext: PathBuf::new(),
        }
    }
}

/// 候选目录的计算基准。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Base {
    /// `<root>`
    Root,
    /// `<可写目录>`
    Writable,
    /// 音轨分离的运行时根（见模块头「真实例外 2」）
    Svsep,
    /// 扩展包根（`extDir`；没配置时等于可写目录）
    Ext,
}

/// 一个候选目录：基准 + 相对路径。
#[derive(Clone, Copy)]
pub struct Place {
    pub base: Base,
    pub rel: &'static str,
}

/// 文件名要不要按平台补后缀。
///
/// ⚠️ 为什么不是「表里直接写死文件名」：写死 `libresvip-cli.exe` 会让 **Linux 上
/// 一个候选都命中不了**（工程转换整条功能死掉，且不报编译错）。
/// 写成 `Exe("libresvip-cli")` 之后，Windows 得到 `.exe`、Linux 得到裸名。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum NameKind {
    /// 原样（`.onnx` / `.json` / `app.py` 这类跨平台一致的文件名）
    Literal,
    /// 可执行文件：Windows 加 `.exe`，其余平台不加
    Exe,
    /// 动态库：Windows `.dll` / macOS `lib*.dylib` / Linux `lib*.so`
    Dll,
}

/// 一个必须存在的文件（相对所在 `Place`）。
#[derive(Clone, Copy)]
pub struct FileNeed {
    pub rel: &'static str,
    pub kind: NameKind,
    /// 见模块头「判齐的两种语义」
    pub min_bytes: u64,
    /// 界面上那一行的名字
    pub label: &'static str,
}

impl FileNeed {
    /// 这个文件在各平台上的**相对路径**。
    pub fn resolve_rel(&self) -> String {
        match self.kind {
            NameKind::Literal => self.rel.to_string(),
            // `exe` / `dll` 只对**文件名**动手，所以先把父目录摘出来
            kind => {
                let (parent, file) = match self.rel.rsplit_once('/') {
                    Some((p, f)) => (Some(p), f),
                    None => (None, self.rel),
                };
                let name = match kind {
                    NameKind::Exe => exe(file),
                    NameKind::Dll => dll(file),
                    NameKind::Literal => unreachable!(),
                };
                match parent {
                    Some(p) => format!("{p}/{name}"),
                    None => name,
                }
            }
        }
    }
}

/// 一个产物。
#[derive(Clone, Copy)]
pub struct Artifact {
    pub id: &'static str,
    /// 界面上的名字，用在「缺什么」的提示里
    pub label: &'static str,
    /// 候选位置，**按优先级**排列
    pub places: &'static [Place],
    /// 这几个文件都在（且都不小于 `min_bytes`）才算齐
    pub need: &'static [FileNeed],
    /// 随包副本不齐时，去系统 PATH 里按这些名字找。空 = 不做 PATH 兜底。
    pub path_names: &'static [&'static str],
}

/// 扩展包根：用户选过就听用户的，没选过就是可写目录。
///
/// ⚠️ 只收 `writable`：`extDir` 是一个**绝对路径**（多在半块盘上），
/// 相对谁都不对；而默认值就是可写目录本身，所以 `root` 在这里没有任何作用。
pub fn ext_of(writable: &Path) -> PathBuf {
    EXT_BASE
        .lock()
        .ok()
        .and_then(|g| g.clone())
        .unwrap_or_else(|| writable.to_path_buf())
}

/// 用户选定的扩展包根（`None` = 没选过，按可写目录）。进程级一份，启动时定。
static EXT_BASE: Mutex<Option<PathBuf>> = Mutex::new(None);

/// 定下这一次运行要用哪个扩展包根。**启动时调一次**，改设置时再调一次。
///
/// 空串 / 只有空格 = 回到可写目录（也就是这一条改动之前的行为）。
pub fn init_ext_base(configured: &str) {
    let p = configured.trim();
    if let Ok(mut g) = EXT_BASE.lock() {
        *g = (!p.is_empty()).then(|| PathBuf::from(p));
    }
}

/* ══════════════════════════════ 唯一的表 ══════════════════════════════ */

/// 全部外部产物。**加一个产物只改这里。**
static ARTIFACTS: &[Artifact] = &[
    /* ── 随包可执行文件（允许退回系统 PATH）── */
    Artifact {
        id: "ffmpeg",
        label: "ffmpeg",
        places: &[
            Place {
                base: Base::Root,
                rel: "tools/ffmpeg/bin",
            },
            // ffmpeg 也可能直接放在 tools/ 根上
            Place {
                base: Base::Root,
                rel: "tools",
            },
        ],
        need: &[FileNeed {
            rel: "ffmpeg",
            kind: NameKind::Exe,
            min_bytes: 0,
            label: "ffmpeg",
        }],
        path_names: &["ffmpeg"],
    },
    Artifact {
        id: "ytdlp",
        label: "yt-dlp",
        places: &[Place {
            base: Base::Root,
            rel: "tools",
        }],
        need: &[FileNeed {
            rel: "yt-dlp",
            kind: NameKind::Exe,
            min_bytes: 0,
            label: "yt-dlp",
        }],
        path_names: &["yt-dlp"],
    },
    Artifact {
        id: "libresvip",
        label: "LibreSVIP CLI",
        /* ⚠️ 文件名走 `NameKind::Exe`，**不能写死 `.exe`** —— 写死的话 Linux 上
        一个候选都命中不了。 */
        places: &[
            Place {
                base: Base::Root,
                rel: "tools/libresvip/libresvip-cli",
            },
            Place {
                base: Base::Root,
                rel: "tools/libresvip",
            },
            Place {
                base: Base::Root,
                rel: "tools/libresvip-cli",
            },
            Place {
                base: Base::Root,
                rel: "tools",
            },
        ],
        need: &[FileNeed {
            rel: "libresvip-cli",
            kind: NameKind::Exe,
            min_bytes: 0,
            label: "libresvip-cli",
        }],
        // 不做 PATH 兜底：它不在任何发行版的包仓库里，进了 PATH 也认不出布局
        path_names: &[],
    },
    /* ── 音轨分离：运行时（随包 + 用户可配置落点）── */
    Artifact {
        id: "svsep.runtime",
        label: "音轨分离运行时",
        /* 两个文件住在 `Base::Svsep` 下的**不同子目录**（`runtime/` 与 `backend/`），
        所以 `rel` 带上子路径，`Place` 只给到基准根。 */
        places: &[Place {
            base: Base::Svsep,
            rel: "",
        }],
        need: &[
            FileNeed {
                rel: "runtime/python",
                kind: NameKind::Exe,
                min_bytes: 0,
                label: "python",
            },
            FileNeed {
                rel: "backend/app.py",
                kind: NameKind::Literal,
                min_bytes: 0,
                label: "backend/app.py",
            },
        ],
        path_names: &[],
    },
    /* ── 音轨分离：模型（按需下载，落可写目录）── */
    Artifact {
        id: "svsep.models",
        label: "音轨分离模型",
        places: &[Place {
            base: Base::Writable,
            rel: "svsep/models",
        }],
        need: &[
            /* ⚠️ `min_bytes` 是**下限**，不是精确值：用来区分「下了一半」和「下完了」。
            换模型就一定要同步改，否则会显示成「下了一半」永远下不完。 */
            FileNeed {
                rel: "UVR-MDX-NET-Inst_HQ_3.onnx",
                kind: NameKind::Literal,
                min_bytes: 55 * 1024 * 1024,
                label: "二轨 · 人声 / 伴奏",
            },
            FileNeed {
                rel: "BS-Roformer-SW.ckpt",
                kind: NameKind::Literal,
                min_bytes: 600 * 1024 * 1024,
                label: "六轨 · BS-Roformer",
            },
            // 上游 `models/` 里除权重之外的索引文件，缺一个都跑不起来
            FileNeed {
                rel: "download_checks.json",
                kind: NameKind::Literal,
                min_bytes: 0,
                label: "download_checks.json",
            },
            FileNeed {
                rel: "mdx_model_data.json",
                kind: NameKind::Literal,
                min_bytes: 0,
                label: "mdx_model_data.json",
            },
            FileNeed {
                rel: "vr_model_data.json",
                kind: NameKind::Literal,
                min_bytes: 0,
                label: "vr_model_data.json",
            },
            FileNeed {
                rel: "BS-Roformer-SW.yaml",
                kind: NameKind::Literal,
                min_bytes: 0,
                label: "BS-Roformer-SW.yaml",
            },
        ],
        path_names: &[],
    },
    /* ── 人声转 MIDI：GAME 模型（两层：下载物 → 随包物）── */
    Artifact {
        id: "game.models",
        label: "扒谱模型（GAME）",
        /* ⚠️ 判层只能比**绝对路径**：绿色版 `writable == <root>/data`，
        两层是同一个路径，「下载物」与「随包物」在那台机器上分不开。
        ⚠️ 第一层是**扩展包根**而不是可写目录：用户把扩展包换到别的盘时，
        这一层要跟着走（`extDir` 没配置时两者本就是同一个路径）。 */
        places: &[
            Place {
                base: Base::Ext,
                rel: "game/models",
            },
            Place {
                base: Base::Root,
                rel: "data/game/models",
            },
        ],
        need: &[
            FileNeed {
                rel: "encoder.onnx",
                kind: NameKind::Literal,
                min_bytes: 0,
                label: "encoder.onnx",
            },
            FileNeed {
                rel: "segmenter.onnx",
                kind: NameKind::Literal,
                min_bytes: 0,
                label: "segmenter.onnx",
            },
            FileNeed {
                rel: "estimator.onnx",
                kind: NameKind::Literal,
                min_bytes: 0,
                label: "estimator.onnx",
            },
        ],
        path_names: &[],
    },
    /* ── 人声转 MIDI：ONNX Runtime 动态库（随包 + 运行期可借用）── */
    Artifact {
        id: "midi.ort",
        label: "ONNX Runtime",
        /* 只有 `tools/onnxruntime/` 是随包分发的（`tools/fetch_tools.mjs` 取到，
        随 `bundle.resources` 的 `../tools` 打进安装包 —— 与 ffmpeg 同一条路）；
        另三个候选都是**运行期**才可能存在的借用点：用户自己放进 `<可写>/midi` 的、
        音轨分离运行时里那份（GPU 构建）、以及 DirectML 加速包那份。
        ⚠️ 这个顺序**不是**挑选顺序：带 `onnxruntime_providers_cuda.dll` 的那一份赢
        （`midi_transcribe::runtime_dll`），否则一份 CPU 包会把它后面那份 GPU 构建遮蔽掉。
        文件名按平台走 `NameKind::Dll`（win `.dll` / mac `lib*.dylib` / linux `lib*.so`）。 */
        places: &[
            Place {
                base: Base::Writable,
                rel: "midi",
            },
            Place {
                base: Base::Root,
                rel: "tools/onnxruntime",
            },
            Place {
                base: Base::Svsep,
                rel: "runtime/Lib/site-packages/onnxruntime/capi",
            },
            Place {
                base: Base::Svsep,
                rel: "dml/onnxruntime/capi",
            },
        ],
        need: &[FileNeed {
            rel: "onnxruntime",
            kind: NameKind::Dll,
            min_bytes: 0,
            label: "onnxruntime",
        }],
        path_names: &[],
    },
    /* ── 随包只读数据（`Base::Root` 下，位置本来就固定）── */
    Artifact {
        id: "data.pinyin",
        label: "拼音表",
        places: &[Place {
            base: Base::Root,
            rel: "data",
        }],
        need: &[FileNeed {
            rel: "pinyin.json",
            kind: NameKind::Literal,
            min_bytes: 0,
            label: "pinyin.json",
        }],
        path_names: &[],
    },
    Artifact {
        id: "data.resources",
        label: "资源库数据",
        /* ⚠️ 见模块头「真实例外 4」：这个文件同时是 `resolve_paths` 判定程序根目录的
        哨兵，而那个判断发生在表可用之前，所以 `lib.rs` 那边保留自己的一句
        `is_file()`。这一条只用于报状态。 */
        places: &[Place {
            base: Base::Root,
            rel: "data",
        }],
        need: &[FileNeed {
            rel: "resources.json",
            kind: NameKind::Literal,
            min_bytes: 0,
            label: "resources.json",
        }],
        path_names: &[],
    },
];

/* ══════════════════════════════ 查询 ══════════════════════════════ */

/// 全部产物（供遍历 / 自检）
pub fn all() -> &'static [Artifact] {
    ARTIFACTS
}

/// 按 id 找一条
pub fn get(id: &str) -> Option<&'static Artifact> {
    ARTIFACTS.iter().find(|a| a.id == id)
}

/// 某个基准目录的实际路径。
fn base_dir(ctx: &Ctx<'_>, base: Base) -> PathBuf {
    match base {
        Base::Root => ctx.root.to_path_buf(),
        Base::Writable => ctx.writable.to_path_buf(),
        Base::Svsep => ctx.svsep.to_path_buf(),
        Base::Ext => ctx.ext.clone(),
    }
}

/// 一个候选目录的绝对路径。
pub fn place_dir(ctx: &Ctx<'_>, p: &Place) -> PathBuf {
    let base = base_dir(ctx, p.base);
    if p.rel.is_empty() {
        base
    } else {
        base.join(p.rel)
    }
}

/// 候选目录，按优先级排列。
pub fn candidates(ctx: &Ctx<'_>, a: &Artifact) -> Vec<PathBuf> {
    a.places.iter().map(|p| place_dir(ctx, p)).collect()
}

/// 单个文件的状态。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FileState {
    /// 在，而且不小于下限
    Ok,
    /// 在，但小于下限（**下了一半**）
    Partial,
    /// 不在
    Missing,
}

/// 状态词。**只在这一处定义** —— 前端认的就是这三个。
pub fn state_str(s: FileState) -> &'static str {
    match s {
        FileState::Ok => "ok",
        FileState::Partial => "partial",
        FileState::Missing => "missing",
    }
}

/// 量一个文件的状态与字节数。
pub fn file_state(dir: &Path, f: &FileNeed) -> (FileState, u64) {
    let path = dir.join(f.resolve_rel());
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let exists = path.is_file();
    let state = if f.min_bytes == 0 {
        // 存在即算齐
        if exists {
            FileState::Ok
        } else {
            FileState::Missing
        }
    } else if size >= f.min_bytes {
        FileState::Ok
    } else if size > 0 {
        FileState::Partial
    } else {
        /* ⚠️ 0 字节算 Missing 而不是 Partial：
        `.part` 下载中途留下的 0 字节占位不该让界面说「下了一半」。 */
        FileState::Missing
    };
    (state, size)
}

/// 逐个文件的状态。`Vec` 的顺序与 `a.need` 一致。
pub fn entries(dir: &Path, a: &Artifact) -> Vec<(&'static FileNeed, FileState, u64)> {
    a.need
        .iter()
        .map(|f| {
            let (st, n) = file_state(dir, f);
            (f, st, n)
        })
        .collect()
}

/// 这个目录里还缺（或没下全）哪些文件。
pub fn missing_in(dir: &Path, a: &Artifact) -> Vec<&'static str> {
    a.need
        .iter()
        .filter(|f| file_state(dir, f).0 != FileState::Ok)
        .map(|f| f.label)
        .collect()
}

/// 这个目录齐了吗。
pub fn ready_in(dir: &Path, a: &Artifact) -> bool {
    a.need.iter().all(|f| file_state(dir, f).0 == FileState::Ok)
}

/// 系统 PATH 里的那一个（`path_names` 非空时才有意义）。
///
/// 返回 `(可执行文件路径, 它所在的目录)` —— 把父目录当成一个候选，这样
/// `place_dir` / `entries` 那一套照样能用（`/usr/bin` + `ffmpeg` = `/usr/bin/ffmpeg`）。
fn path_candidate(a: &Artifact) -> Option<(PathBuf, PathBuf)> {
    for name in a.path_names {
        if let Some(p) = crate::platform::find_binary(name, &[]) {
            let dir = p.parent()?.to_path_buf();
            return Some((p, dir));
        }
    }
    None
}

/// 定位结果：在哪、来自哪一层。
pub struct Located {
    pub dir: PathBuf,
    /// 给界面看的来源说明（`"程序目录"` / `"系统 PATH"`）
    pub source: &'static str,
}

/// 找到**齐的那一份**。一个都没有就 `None`。
///
/// 随包的几层都不齐时，才去看系统 PATH（`path_names`）——
/// 顺序很重要：用户自己放进 `tools/` 的那份应该赢过系统里的。
pub fn locate(ctx: &Ctx<'_>, a: &Artifact) -> Option<Located> {
    let dirs = candidates(ctx, a);
    // 候选**按优先级**排列，第一个齐的赢
    let chosen = dirs.into_iter().find(|d| ready_in(d, a));
    if let Some(dir) = chosen {
        return Some(Located {
            dir,
            source: "程序目录",
        });
    }

    // 随包的都不齐 → 试系统 PATH
    if !a.path_names.is_empty()
        && let Some((_, dir)) = path_candidate(a)
    {
        // ⚠️ 这里**不**对 PATH 命中做 `ready_in` 校验：系统装的 ffmpeg 不在
        //    `tools/` 那套布局里，校验必然失败，于是「装了 ffmpeg 却报没装」。
        //    PATH 里找到就算数。
        return Some(Located {
            dir,
            source: "系统 PATH",
        });
    }
    None
}

/// 找到那一份所在的**目录**；一个都没有就回退到第一个候选（**下载落点**）。
///
/// 为什么需要这个「不齐也返回」的版本：下载之前要先知道往哪儿落、状态里要显示
/// 「还没装、装到哪个目录」。
pub fn locate_or_default(ctx: &Ctx<'_>, a: &Artifact) -> PathBuf {
    match locate(ctx, a) {
        Some(l) => l.dir,
        None => candidates(ctx, a)
            .into_iter()
            .next()
            .unwrap_or_else(|| ctx.writable.to_path_buf()),
    }
}

/// 新下载的东西应该落在哪 —— 永远是**第一个候选**（可写目录优先）。
///
/// ⚠️ 与 [`locate_or_default`] 的区别：那个会回落到「已经齐的那一层」，
/// 用它可以**定位**但绝不能用来**下载** —— 随包那一层在安装版里是只读的。
pub fn download_dest(ctx: &Ctx<'_>, a: &Artifact) -> PathBuf {
    candidates(ctx, a)
        .into_iter()
        .next()
        .unwrap_or_else(|| ctx.writable.to_path_buf())
}

/// 单个文件的绝对路径（单文件产物用，比如 onnxruntime 的 dll）。
pub fn entry_path(dir: &Path, f: &FileNeed) -> PathBuf {
    dir.join(f.resolve_rel())
}

/// 还缺哪些（按 [`locate_or_default`] 那一层判）。
pub fn missing(ctx: &Ctx<'_>, a: &Artifact) -> Vec<&'static str> {
    missing_in(&locate_or_default(ctx, a), a)
}

/// 齐了吗（按 [`locate_or_default`] 那一层判）。
pub fn ready(ctx: &Ctx<'_>, a: &Artifact) -> bool {
    ready_in(&locate_or_default(ctx, a), a)
}

/* ══════════════════════════ 便捷入口（按 id 直呼）══════════════════════════
 *
 * 上面那套 API 收 `&Artifact`，调用方得自己 `get(id).expect(…)` —— 一行变五行。
 * 下面这几个直接收 `&str`，让调用点写成一行：
 *
 *     let dir = artifact::dir_of(root, writable, "game.models");
 *
 * ⚠️ 每一个都**不做兜底**：id 写错就 panic。这是有意的 —— id 都是编译期字面量，
 * 拼错了是程序 bug，而静默回一个空路径会让「产物没装」与「代码写错」混成一种，
 * 排查时分不出来。表的单测已经把「id 唯一」钉住了。
 */

/// 取一条产物；id 不存在就 panic（id 都是字面量，拼错属于程序 bug）。
fn need(id: &str) -> &'static Artifact {
    get(id).unwrap_or_else(|| panic!("artifact 表里没有这个 id：{id}"))
}

/// 定位到的目录（不齐则回落到第一个候选）。齐没齐用 [`ready_of`]。
pub fn dir_of(root: &Path, writable: &Path, id: &str) -> PathBuf {
    locate_or_default(&Ctx::new(root, writable), need(id))
}

/// 齐了吗。
pub fn ready_of(root: &Path, writable: &Path, id: &str) -> bool {
    ready(&Ctx::new(root, writable), need(id))
}

/// 还缺哪些（界面上的名字）。
pub fn missing_of(root: &Path, writable: &Path, id: &str) -> Vec<&'static str> {
    missing(&Ctx::new(root, writable), need(id))
}

/// 定位到 `Base::Root` 下**第 `idx` 个必需文件**的完整路径；没找到就 `None`。
///
/// 单文件产物用它（界面上问的是「这个文件在哪」，不是「哪个目录齐了」），
/// 而且只查 `root` —— `tools/` 下的那几个（ffmpeg / yt-dlp / LibreSVIP）用它，
/// 省一次 svsep 全局查询。需要跨 `root` / `writable` / svsep 找的（onnxruntime、
/// 模型）走 [`dirs_of`]，因为「挑哪一份」另有判据（见 `midi_transcribe::runtime_dll`）。
pub fn path_in_root(root: &Path, id: &str, idx: usize) -> Option<PathBuf> {
    let a = need(id);
    locate(&Ctx::root_only(root), a).map(|l| entry_path(&l.dir, &a.need[idx]))
}

/// 全部候选目录，按优先级（第一个 = 下载落点）。
///
/// 「哪一层是随包只读的」这种判断（删除依赖时只删可写那层）用它。
pub fn dirs_of(root: &Path, writable: &Path, id: &str) -> Vec<PathBuf> {
    candidates(&Ctx::new(root, writable), need(id))
}

/// 在**指定的某个目录**里还缺哪些文件。
///
/// 与 [`missing_of`] 的区别：那个先按优先级挑一层再查；这个直接查你给的那个目录。
/// 解包刚结束时校验「解出来齐不齐」用它 —— 那是「这个目录里够不够」，
/// 不是「这台机器上有没有」。
pub fn missing_in_dir(dir: &Path, id: &str) -> Vec<&'static str> {
    missing_in(dir, need(id))
}

/// 指定的某个目录里齐了吗。
pub fn ready_in_dir(dir: &Path, id: &str) -> bool {
    ready_in(dir, need(id))
}

/// 状态汇报的形状：`{dir, ready, missing, items[]}`。
///
/// 各页面要的细节不同，所以这里给的是**原始材料**，调用方自己拼 JSON ——
/// 强行统一成一个形状只会让每个页面都多一层转译。
pub fn report(ctx: &Ctx<'_>, id: &str) -> Value {
    let Some(a) = get(id) else {
        return json!({ "error": format!("没有这个产物：{id}") });
    };
    let dir = locate_or_default(ctx, a);
    let located = locate(ctx, a);
    let items: Vec<Value> = entries(&dir, a)
        .into_iter()
        .map(|(f, st, n)| {
            json!({
                "name": f.label,
                "rel": f.resolve_rel(),
                "state": match st { FileState::Ok => "ok", FileState::Partial => "partial", FileState::Missing => "missing" },
                "size": n,
                "expectedSize": f.min_bytes,
            })
        })
        .collect();
    json!({
        "id": a.id,
        "label": a.label,
        "dir": dir.to_string_lossy(),
        "ready": located.is_some(),
        "source": located.as_ref().map(|l| l.source),
        "missing": missing_in(&dir, a),
        "items": items,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vss-artifact-{name}"));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// id 唯一 —— 表是手写的，重名会让 `get()` 静默取到前一条。
    #[test]
    fn ids_are_unique() {
        let mut seen = std::collections::BTreeSet::new();
        for a in all() {
            assert!(seen.insert(a.id), "产物 id 重复：{}", a.id);
        }
    }

    /// 每一条都得有位置和文件，否则它永远不会「齐」，界面上是个死条目。
    #[test]
    fn every_artifact_declares_places_and_files() {
        for a in all() {
            assert!(!a.places.is_empty(), "{} 没有候选位置", a.id);
            assert!(!a.need.is_empty(), "{} 没有声明需要哪些文件", a.id);
        }
    }

    /// `NameKind` 的解析：容器里（Linux）`Exe` 不加后缀、`Dll` 加 `lib`/`.so`。
    #[test]
    fn names_resolve_per_platform() {
        let e = FileNeed {
            rel: "ffmpeg",
            kind: NameKind::Exe,
            min_bytes: 0,
            label: "",
        };
        let d = FileNeed {
            rel: "onnxruntime",
            kind: NameKind::Dll,
            min_bytes: 0,
            label: "",
        };
        // 带子目录时只动文件名
        let nested = FileNeed {
            rel: "runtime/python",
            kind: NameKind::Exe,
            min_bytes: 0,
            label: "",
        };
        let lit = FileNeed {
            rel: "backend/app.py",
            kind: NameKind::Literal,
            min_bytes: 0,
            label: "",
        };

        if cfg!(windows) {
            assert_eq!(e.resolve_rel(), "ffmpeg.exe");
            assert_eq!(d.resolve_rel(), "onnxruntime.dll");
            assert_eq!(nested.resolve_rel(), "runtime/python.exe");
        } else {
            assert_eq!(e.resolve_rel(), "ffmpeg");
            assert_eq!(d.resolve_rel(), "libonnxruntime.so");
            // 父目录必须留着 —— 只换文件名，别把 path 也当文件名处理
            assert_eq!(nested.resolve_rel(), "runtime/python");
        }
        assert_eq!(lit.resolve_rel(), "backend/app.py");
    }

    /// 三态：`Partial` 必须与 `Missing` 分开（否则「下了一半」会说成「缺文件」）。
    #[test]
    fn file_state_separates_partial_from_missing() {
        let d = tmp("state");
        let need = FileNeed {
            rel: "m.onnx",
            kind: NameKind::Literal,
            min_bytes: 100,
            label: "m",
        };

        assert_eq!(
            file_state(&d, &need).0,
            FileState::Missing,
            "文件不在 → Missing"
        );

        std::fs::write(d.join("m.onnx"), b"").unwrap();
        assert_eq!(
            file_state(&d, &need).0,
            FileState::Missing,
            "0 字节算 Missing，不算 Partial"
        );

        std::fs::write(d.join("m.onnx"), b"half").unwrap();
        assert_eq!(
            file_state(&d, &need).0,
            FileState::Partial,
            "写了但不够 → Partial"
        );

        std::fs::write(d.join("m.onnx"), vec![0u8; 100]).unwrap();
        assert_eq!(file_state(&d, &need).0, FileState::Ok, "够了下限 → Ok");

        // min_bytes == 0 的：存在即算齐
        let loose = FileNeed {
            rel: "m.onnx",
            kind: NameKind::Literal,
            min_bytes: 0,
            label: "m",
        };
        std::fs::write(d.join("m.onnx"), b"").unwrap();
        assert_eq!(
            file_state(&d, &loose).0,
            FileState::Ok,
            "min_bytes=0 时空文件也算齐"
        );
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 随包那层齐就用随包的；都不齐才看 PATH；`download_dest` 永远是可写层。
    #[test]
    fn locate_prefers_bundled_then_writable_then_path() {
        let base = tmp("locate");
        let root = base.join("root");
        let writable = base.join("appdata");
        let ctx = Ctx::new(&root, &writable);
        let a = get("game.models").unwrap();

        // 都不在 → None，但落点是可写层（下载物落那儿）
        assert!(locate(&ctx, a).is_none());
        assert_eq!(download_dest(&ctx, a), writable.join("game").join("models"));

        // 可写层齐 → 用它
        let w = writable.join("game").join("models");
        std::fs::create_dir_all(&w).unwrap();
        for n in ["encoder.onnx", "segmenter.onnx", "estimator.onnx"] {
            std::fs::write(w.join(n), b"x").unwrap();
        }
        assert_eq!(locate(&ctx, a).unwrap().dir, w.clone());
        assert!(ready(&ctx, a));

        // 可写层只剩一个文件（用户点了「删除依赖」）→ 回落到随包那层
        let r = root.join("data").join("game").join("models");
        std::fs::create_dir_all(&r).unwrap();
        for n in ["encoder.onnx", "segmenter.onnx", "estimator.onnx"] {
            std::fs::write(r.join(n), b"x").unwrap();
        }
        std::fs::remove_file(w.join("segmenter.onnx")).unwrap();
        assert_eq!(
            locate(&ctx, a).unwrap().dir,
            r,
            "可写层不齐时要回落到随包层"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    /// 报状态：缺哪个、在哪个目录、`Partial` 也要算「不齐」。
    #[test]
    fn report_lists_missing_files() {
        let base = tmp("report");
        let root = base.join("root");
        let writable = base.join("appdata");
        let ctx = Ctx::new(&root, &writable);

        let v = report(&ctx, "data.pinyin");
        assert_eq!(v["ready"], json!(false));
        assert_eq!(v["missing"][0], json!("pinyin.json"));
        assert!(v["dir"].as_str().unwrap().ends_with("data"));

        // 放上去之后就该齐（min_bytes = 0）
        let d = root.join("data");
        std::fs::create_dir_all(&d).unwrap();
        std::fs::write(d.join("pinyin.json"), b"{}").unwrap();
        assert_eq!(report(&ctx, "data.pinyin")["ready"], json!(true));

        // 不存在的 id 要给一句人话，而不是 panic
        assert!(report(&ctx, "no.such")["error"].is_string());
        let _ = std::fs::remove_dir_all(&base);
    }
}
