//! 构建前置检查。
//!
//! ⚠️ **必须排在 `tauri_build::build()` 之前** —— 后者会把 `bundle.resources`
//! 里的源目录拷进 `target/<profile>/`，拷完就没得救了。
//!
//! ## 为什么需要这个文件
//!
//! `bundle.resources` 的源目录**缺文件时构建不报错**。`tools/` 是个目录映射，
//! tauri-build 遍历目录、把**有的**拷走就完事 —— 缺的那几个（`ffmpeg` /
//! `yt-dlp` / `libresvip`，都是不入库的几百 MB 大件）静默消失。结果：包能装、
//! 能启动、大部分功能正常，只有调 ffmpeg 的那几个功能到用户手里才现形。
//!
//! `tools/` 里只有几个脚本、ffmpeg / yt-dlp / libresvip 一个都没有时，
//! `cargo build` 照样「成功」，`target/debug/tools/` 里也就只有那几个脚本。
//!
//! ## 什么时候检查
//!
//! 只在 **Windows / macOS 的 release 构建**上查（判据见 [`should_check`]）。
//!
//! ⛔ **别用 `TAURI_ENV_DEBUG` 当判据。** 文档说它「debug 时是 true，否则不设」，
//! 实际上在 `cargo build` 与 `cargo build --release` 下**从来没被设置过**
//! —— 它由 tauri-cli 设给 `before*Command` 钩子，不是设给 build script 的。
//! 拿它当条件会写出一条永不触发的假防线。
//!
//! 为什么不含 Linux：那边这几个产物**本来就该缺** —— `artifact` 表的
//! `path_names` 允许退回系统 PATH（`pacman -S ffmpeg` 就够了），在那边查是误报。
//!
//! 为什么限定 release：开发时没拉大件是常态（`cargo test` 得能跑），而且
//! 288 MB 每次构建全量拷贝本来就慢。要出货的那个组合才查。
//!
//! 绕过（比如只想编一个不带工具的 Windows release 二进制）：
//! 设 `VSS_SKIP_BUNDLE_CHECK=1`。本机验证这条防线真的会响：设 `VSS_CHECK_BUNDLE=1`。

use std::path::Path;

/// 打包时必须存在的东西（相对 `src-tauri/`），以及它是干嘛的。
///
/// 与 `tauri.conf.json` 的 `bundle.resources` 一一对应。那两个 json 是源码、
/// 已入库，正常永远在；真正会缺的就是 `tools/` 里的大件。
///
/// ⚠️ **故意不 import** —— 真源是 `tools/assets.mjs` 那张表，但 `build.rs` 是
/// 独立编译单元：`include!` 一张 Rust 表会连带一整串 `crate::` 依赖，而那张表
/// 还是 Python 写的（构建时不该依赖 Python）。所以这份**是重复的**。
///
/// ⚠️ 但「故意重复」和「可以漂」是两回事。漂了由 `tools/assets.mjs::checkTablesAgree()`
/// 抓（`tools/check-artifact-paths.mjs` 会调它）—— **别靠人记住两处同步**。
/// 加/删这里的一条，就同步改 `assets.mjs` 里那条，否则校验会红。
///
/// ## 这份检查只判「在不在」，不判「齐不齐」
///
/// 分工是有意的：**深度判据（数目录里有多少个文件）在 `fetch_tools.mjs`** ——
/// 它才是解包的那个，也只有它能在「刚解完」的时候说得清齐没齐。
/// 这里只做**最后一道**兜底：`fetch_tools.mjs` 没跑过时，至少别让
/// `cargo build` 静默产出一个缺功能的安装包。
///
/// ## 与「运行期去哪儿找」的关系
///
/// `artifact/mod.rs` 那张 Rust 表管**运行期去哪儿找**（含系统 PATH 兜底、
/// 用户可配置落点）—— 那是另一个关注点，别合并。
/// 一条产物只属于哪个目标平台。值就是 `CARGO_CFG_TARGET_OS` 的取值（`any` = 都算）。
///
/// ⚠️ 平台那一列不是装饰：随包的二进制是**平台专属**的（`ffmpeg.exe` vs `ffmpeg`、
/// `onnxruntime.dll` vs `libonnxruntime.dylib`），只列 Windows 那套会让别的平台在这里
/// 静默放行 —— 而放行的后果正是这个文件要拦的那种「装出来缺功能」。
const ANY: &str = "any";
const WIN: &str = "windows";
const MAC: &str = "macos";
const LINUX: &str = "linux";

const MUST_HAVE: &[(&str, &str, &str)] = &[
    (
        "../data/resources.json",
        "资源库清单（resolve_paths 的启动哨兵）",
        ANY,
    ),
    ("../data/pinyin.json", "拼音词典", ANY),
    // ffmpeg 没有 Linux 行：deb 不带它（Depends 装系统包），MUST_HAVE 只查随包物
    (
        "../tools/ffmpeg/bin/ffmpeg.exe",
        "ffmpeg（音频转换 / 合并 / 扒谱解码）",
        WIN,
    ),
    (
        "../tools/ffmpeg/bin/ffmpeg",
        "ffmpeg（同左，macOS 版）",
        MAC,
    ),
    ("../tools/yt-dlp.exe", "yt-dlp（MV 解析下载）", WIN),
    ("../tools/yt-dlp", "yt-dlp（同左，macOS 版）", MAC),
    ("../tools/yt-dlp", "yt-dlp（同左，Linux 版）", LINUX),
    (
        "../tools/libresvip/libresvip-cli/libresvip-cli.exe",
        "LibreSVIP（工程格式互转）",
        WIN,
    ),
    (
        "../tools/libresvip/libresvip-cli/libresvip-cli",
        "LibreSVIP（同左，macOS 版）",
        MAC,
    ),
    (
        "../tools/libresvip/libresvip-cli/libresvip-cli",
        "LibreSVIP（同左，Linux 版）",
        LINUX,
    ),
    /* ⚠️ 这条必须留着：exe 在、插件目录空 = 工程格式互转认不出任何格式，且不报错。
    只查 exe 是不够的，所以这里连插件目录一起数。 */
    (
        "../tools/libresvip/libresvip-cli/_internal/libresvip/plugins",
        "LibreSVIP 的格式插件（目录空 = 认不出任何格式）",
        ANY,
    ),
    /* 人声转 MIDI 的 ONNX Runtime。随包，运行期不再下载 —— 缺了「开始扒谱」起不来。 */
    (
        "../tools/onnxruntime/onnxruntime.dll",
        "ONNX Runtime（人声转 MIDI 的推理运行时）",
        WIN,
    ),
    (
        "../tools/onnxruntime/libonnxruntime.dylib",
        "ONNX Runtime（同左，macOS 版）",
        MAC,
    ),
    (
        "../tools/onnxruntime/libonnxruntime.so",
        "ONNX Runtime（同左，Linux 版）",
        LINUX,
    ),
    /* jizura 经 `frontendDist` 进包（Vite 把 `public/` 拷进 `dist/`），机制与
    `bundle.resources` 不同，但缺了的后果一样 —— PV 页静默少字体。这四条都不是
    源码、不入库，全由 tools/fetch_jizura_fonts.mjs 现场产出。 */
    (
        "../public/vendor/jizura/index.html",
        "JIZURA 页面（PV 的 iframe 指向它；从上游取并打补丁）",
        ANY,
    ),
    (
        "../public/vendor/jizura/LICENSE",
        "JIZURA 的 MIT 许可（从上游取）",
        ANY,
    ),
    (
        "../public/vendor/jizura/fonts.css",
        "JIZURA 字体清单（由 tools/fetch_jizura_fonts.mjs 生成）",
        ANY,
    ),
    (
        "../public/vendor/jizura/fonts",
        "JIZURA 字体（2000+ 个 woff2，由 tools/fetch_jizura_fonts.mjs 抓）",
        ANY,
    ),
];

fn main() {
    /* ⚠️ 必须声明这两个 —— 否则 cargo 会缓存 build script 的执行结果，
    改了环境变量也不会重跑，检查就形同虚设（加了 `VSS_CHECK_BUNDLE=1`
    也不会有任何反应）。`CARGO_CFG_TARGET_OS` 与 `PROFILE` 是 cargo 给的、
    随目标变化，不需要声明。 */
    println!("cargo:rerun-if-env-changed=VSS_CHECK_BUNDLE");
    println!("cargo:rerun-if-env-changed=VSS_SKIP_BUNDLE_CHECK");

    check_resources();
    tauri_build::build()
}

/// 该不该查。
///
/// ⚠️ 逻辑单拎出来是**为了能被人读懂**（一行的 `if` 混在 `check_resources` 里
/// 看不出有三个独立条件）。**不是**为了单测 —— `build.rs` 里的 `#[cfg(test)]`
/// 永远不会跑（cargo 只编译 build script，不测它），写了是假安心。
fn should_check(target_os: &str, profile: &str, forced: bool, skipped: bool) -> bool {
    if skipped {
        return false; // 跳过优先于强制，否则「绕过」没法用
    }
    forced || (matches!(target_os, WIN | MAC | LINUX) && profile == "release")
}

fn check_resources() {
    let target_os = std::env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let profile = std::env::var("PROFILE").unwrap_or_default();
    let forced = std::env::var_os("VSS_CHECK_BUNDLE").is_some();
    let skipped = std::env::var_os("VSS_SKIP_BUNDLE_CHECK").is_some();

    if !should_check(&target_os, &profile, forced, skipped) {
        return;
    }

    /* 只查**这个目标平台**的那些 —— 另一个平台的二进制在交叉编译/本机构建里本来就不该在，
    查它必然误报（`ffmpeg.exe` 在 mac 上永远不会存在）。 */
    let missing: Vec<String> = MUST_HAVE
        .iter()
        .filter(|(_, _, only)| *only == ANY || *only == target_os)
        .filter(|(rel, _, _)| !Path::new(rel).exists())
        .map(|(rel, what, _)| format!("  {rel}  ← {what}"))
        .collect();

    if missing.is_empty() {
        return;
    }

    panic!(
        "打包缺文件 —— 装出来的程序会缺功能，但构建**不会**报错，所以在这里拦。\n{}\n\n\
         这些大件不入库，缺的两块来源不同、由两个脚本各自负责：\n  \
         · tools/                      → node tools/fetch_tools.mjs\n  \
         · public/vendor/jizura/       → node tools/fetch_jizura_fonts.mjs\n\
         只想编个不带这些的 release：设 VSS_SKIP_BUNDLE_CHECK=1。\n\
         详见 如何编译打包.md 第二节。",
        missing.join("\n")
    );
}
