//! 平台相关：Windows 特有的是 explorer、回收站；其余走标准库。
//!
//! 这一层是**唯一**放平台代码的地方 —— 移植 macOS 时只需要在这里加一个 cfg 分支，
//! 上层业务代码一行都不用改。
//!
//! ⚠️ 两样东西**不放这里**：
//!   * **系统文件/文件夹对话框** —— 走官方 `tauri-plugin-dialog`，见
//!     `ipc/fs.rs::pick_paths`。自己调 Win32（`GetOpenFileNameW` /
//!     `SHBrowseForFolderW`）还要处理 COM 初始化、owner 句柄、双 NUL 过滤器，
//!     全是不必要的成本。
//!   * **下载目录与文件系统根列表** —— 选目录一律走系统对话框
//!     （见 `components/DirPicker.tsx`），不需要给自画浏览器当数据源。

use std::path::{Path, PathBuf};
use std::process::Command;

/// 平台名（`win32` / `darwin` / `linux`）。
///
/// ⚠️ 必须是这三个词，前端读它判断「哪些功能在哪些平台可用」——
/// `std::env::consts::OS` 给的是 `windows`，对不上。
pub fn node_platform_name() -> &'static str {
    if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    }
}

/* ══════════════════════════════ 安装时选的语言 ══════════════════════════════ */

/// 安装界面的语言 → 程序界面的语言。
///
/// 安装器写的是 NSIS 那三种（`zh-CN` / `ja-JP` / 其余一律 `en-US`），程序认的是同一套
/// 标识，所以这里只做**归一化**：`zh` / `zh-Hans` / `ja` 这类简写也认，认不出的回
/// `None` —— **不猜**一个语言出来（猜错等于把用户的语言设置改掉）。
fn normalize_lang(raw: &str) -> Option<&'static str> {
    let v = raw.trim().to_ascii_lowercase();
    if v.starts_with("zh") {
        Some("zh-CN")
    } else if v.starts_with("ja") {
        Some("ja-JP")
    } else if v.starts_with("en") {
        Some("en-US")
    } else {
        None
    }
}

/// 安装时选的语言（`zh-CN` / `en-US` / `ja-JP`），读不到回 `None`。
///
/// 读的是安装器写下的注册表值：`HKCU\Software\qingmu\<产品名>` 的
/// `InstallerLanguage`（写它的是 `src-tauri/nsis-hooks.nsh`）。绿色版没有这一条，
/// 自然回 `None` —— 程序就用配置里那份。
///
/// ⚠️ 键路径分两段：`Software\qingmu` 来自打包配置里的 `publisher`，改发布者时
/// 这里与 `nsis-hooks.nsh` 要一起改（产品名从 `tauri.conf.json` 的 `productName` 来）。
pub fn installer_language(product: &str) -> Option<&'static str> {
    #[cfg(windows)]
    {
        let key = format!(r"Software\qingmu\{product}");
        crate::reg::read_hkcu_string(&key, "InstallerLanguage").and_then(|v| normalize_lang(&v))
    }
    #[cfg(not(windows))]
    {
        let _ = product;
        None
    }
}

/* ══════════════════════════════════ 路径规范化 ══════════════════════════════════ */

/// 把路径转成可以直接显示、写进 JSON 的字符串。
///
/// Windows 上 `fs::canonicalize` 返回的是 **verbatim 路径**，形如 `\\?\H:\foo`
/// （UNC 则是 `\\?\UNC\server\share`）。直接回给前端会很难看，而且前端拿它去
/// 拼新路径时前缀会跟着扩散。这里统一剥掉。
pub fn clean_path(p: &Path) -> String {
    let s = p.to_string_lossy().to_string();
    #[cfg(windows)]
    {
        if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
            return format!(r"\\{rest}");
        }
        if let Some(rest) = s.strip_prefix(r"\\?\") {
            return rest.to_string();
        }
    }
    s
}

/* ══════════════════════════════════ 打开 / 定位 / 删除 ══════════════════════════════════ */

/// 用系统默认程序打开（文件或目录）
pub fn open_path(target: &str) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        // explorer 对目录和文件都能处理；不要用 `cmd /c start`，那会弹黑框
        Command::new("explorer").arg(target).spawn()?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(target).spawn()?;
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open").arg(target).spawn()?;
        Ok(())
    }
}

/**
 * 用**系统默认浏览器**打开一个 URL。
 *
 * 为什么单独一个函数：`open_path` 走的是 `explorer <目标>`，喂 URL 时行为依赖
 * explorer 的 shell 委托，不可靠；这里用 Windows 官方的 URL 协议处理器。
 * 三端各自的写法与 `open_path` 平行。
 */
pub fn open_url(target: &str) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        // rundll32 url.dll,FileProtocolHandler 是 shell 打开 URL 的标准做法，
        // **不会弹黑框**（`cmd /c start` 会，见 open_path 的注释）。
        Command::new("rundll32.exe")
            .arg("url.dll,FileProtocolHandler")
            .arg(target)
            .spawn()?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open").arg(target).spawn()?;
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open").arg(target).spawn()?;
        Ok(())
    }
}

/// 在文件管理器里定位到该文件（选中它）
///
/// `select`（试着**选中**该文件而不是只打开它所在的目录）是 Windows / macOS 才有的能力：
/// explorer 认 `/select,`，Finder 认 `-R`。Linux 上 `xdg-open` **只能打开目录**，
/// 没有任何标准方式让文件管理器选中某个条目（不同桌面环境的 DBus 接口各不相同）。
/// 所以那一支显式丢掉 `select` 并注明原因 —— 别在这里假装能做到。
pub fn reveal_in_explorer(target: &str, select: bool) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        let mut c = Command::new("explorer");
        if select {
            // /select, 后面**不能有空格**，这是 explorer 的怪癖
            c.arg(format!("/select,{target}"));
        } else {
            c.arg(target);
        }
        c.spawn()?;
        Ok(())
    }
    #[cfg(target_os = "macos")]
    {
        let mut c = Command::new("open");
        if select {
            c.arg("-R");
        }
        c.arg(target).spawn()?;
        Ok(())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        let _ = select; // 见函数文档：xdg-open 没有「选中」这一说
        let dir = Path::new(target).parent().unwrap_or(Path::new("."));
        Command::new("xdg-open").arg(dir).spawn()?;
        Ok(())
    }
}

/// 移到回收站。做不到时返回错误，让调用方决定是否硬删。
pub fn move_to_trash(target: &Path) -> std::io::Result<()> {
    #[cfg(windows)]
    {
        // 用 Shell.Application 的 Verb「删除」把文件送进回收站。
        // 不引额外的 crate —— PowerShell 一行就够，而且行为可控。
        let script = format!(
            "$p = '{}'; $item = (New-Object -ComObject Shell.Application).Namespace(0).ParseName($p); \
             if ($item) {{ $item.InvokeVerb('delete') }} else {{ throw '找不到项目' }}",
            target.to_string_lossy().replace('\'', "''")
        );
        let out = crate::ipc::tools::quiet_command("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()?;
        if out.status.success() {
            Ok(())
        } else {
            Err(std::io::Error::other(
                String::from_utf8_lossy(&out.stderr).to_string(),
            ))
        }
    }
    #[cfg(not(windows))]
    {
        // macOS/Linux 没有统一的回收站 API，退回硬删（调用方会在界面上提示）
        if target.is_dir() {
            std::fs::remove_dir_all(target)
        } else {
            std::fs::remove_file(target)
        }
    }
}

/* ══════════════════════════════════ 可执行文件查找 ══════════════════════════════════ */

/// 在 PATH 和给定目录里找一个可执行文件
pub fn find_binary(name: &str, extra_dirs: &[PathBuf]) -> Option<PathBuf> {
    let file = if cfg!(windows) && !name.ends_with(".exe") {
        format!("{name}.exe")
    } else {
        name.to_string()
    };

    for dir in extra_dirs {
        let p = dir.join(&file);
        if p.is_file() {
            return Some(p);
        }
    }

    // PATH 里找
    if let Some(paths) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&paths) {
            let p = dir.join(&file);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

/* ══════════════════════════════════ 平台能力 ══════════════════════════════════ */

/// 离线分离引擎的运行时包是 Windows 专属：`python.exe`（embeddable 发行版）
/// 加 `onnxruntime-directml` 的 win_amd64 wheel，见 `svsep.rs` 的 `RUNTIME_PARTS`。
const SVSEP_LOCAL_WHY: &str = "离线分离的运行时包是 Windows 专属（python.exe + DirectML）";

/// 这个平台上「没有本地分离引擎」的原因；`None` = 有。
///
/// 界面置灰用它，命令层拒绝也用它 —— 同一句话只写一份，别在两边各编一句。
pub fn local_engine_why() -> Option<&'static str> {
    if cfg!(windows) {
        None
    } else {
        Some(SVSEP_LOCAL_WHY)
    }
}

/// 哪些功能在这个平台上**根本做不到**。
///
/// 形状是 `{"<功能>": {"ok": bool, "why": "不可用时给用户看的一句话"}}`：
/// 界面按 `ok` 置灰入口、按 `why` 说明原因，两件事都只在这里定义一份 ——
/// 前端不再自己判平台（那份判断会和这里漂开）。
///
/// ⚠️ 判据只写**平台事实**，不写探测结果。「装没装 / 探没探到」由各自的接口回答
/// （例如显卡能不能用问 `midi_status.device.cuda`）。
pub fn caps() -> serde_json::Value {
    let win = cfg!(windows);
    let mac = cfg!(target_os = "macos");
    let cap = |ok: bool, why: &str| {
        if ok {
            serde_json::json!({ "ok": true })
        } else {
            serde_json::json!({ "ok": false, "why": why })
        }
    };
    serde_json::json!({
        /* 背景壁纸读的是 Wallpaper Engine 的 Steam 库，而 WE 只有 Windows 版 ——
        别的平台上「扫不到」不是没装，是这东西在那个系统上不存在。 */
        "wallpaper": cap(win, "Wallpaper Engine 只有 Windows 版，Steam 库里读不到它"),
        "svsepLocal": cap(win, SVSEP_LOCAL_WHY),
        "svsepDirectml": cap(win, "DirectML 是 Windows 的显卡 API"),
        /* 显卡推理走 CUDA：Apple 从 macOS 10.14 起就不再支持，机器上不可能有。 */
        "midiGpu": cap(!mac, "显卡推理走 CUDA，而 macOS 上没有 CUDA"),
        /* 送回收站靠 Shell.Application 的「删除」动词；别的平台没有统一 API，
        `move_to_trash` 那边退回硬删。 */
        "trash": cap(win, "非 Windows 没有统一的回收站 API，删除即彻底删除"),
    })
}

/* ══════════════════════════════ 整机可用性 ══════════════════════════════ */

/// macOS + Intel 这一个组合**装得上、但随包的工具跑不起来**。
///
/// 构建机是 Apple Silicon，`fetch_tools.mjs` 按**构建机**架构取件，所以 dmg 里那份
/// ffmpeg 是 arm64 的；Intel 上 `Command::new` 直接 `Bad CPU type in executable`，
/// 而音频转换 / MV 合并 / 扒谱解码全都要它。
///
/// 返回一句给界面显示的话（其余平台是 `None`）。`caps()` 管的是**单个功能**的置灰，
/// 这里管的是整台机器 —— 受影响的功能太多，逐项置灰只会让界面到处是灰的。
pub fn unsupported_note() -> Option<String> {
    unsupported_note_for(std::env::consts::OS, std::env::consts::ARCH)
}

/// 判据单拎出来是为了能测：`std::env::consts` 读的是**运行**的机器，测不了别的平台。
fn unsupported_note_for(os: &str, arch: &str) -> Option<String> {
    (os == "macos" && arch == "x86_64").then(|| {
        "这个安装包里的随包工具是 Apple Silicon（arm64）版，Intel Mac 上用不了：\
         ffmpeg 起不来，音频转换、MV 合并、扒谱解码都会失败。\
         要在 Intel 上用得在本机自行编译（补齐脚本按构建机架构取件）。"
            .to_string()
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 能力表只在**做不到**的那些项上给原因 —— 给了 `ok: true` 又带 `why` 会让人以为有坑。
    #[test]
    fn caps_explain_only_the_unsupported() {
        let v = caps();
        let obj = v.as_object().expect("caps 是个对象");
        assert!(!obj.is_empty());
        for (name, c) in obj {
            let ok = c.get("ok").and_then(|b| b.as_bool());
            assert!(ok.is_some(), "{name} 缺 ok");
            if ok == Some(true) {
                assert!(c.get("why").is_none(), "{name} 可用就不该带原因");
            } else {
                assert!(
                    c.get("why")
                        .and_then(|w| w.as_str())
                        .is_some_and(|w| !w.is_empty()),
                    "{name} 不可用却没有原因 —— 界面只能显示一句空话"
                );
            }
        }
        // Windows 是唯一出货平台，这几项在它上面必须都是可用的
        if cfg!(windows) {
            for name in [
                "wallpaper",
                "svsepLocal",
                "svsepDirectml",
                "midiGpu",
                "trash",
            ] {
                assert_eq!(
                    obj[name].get("ok").and_then(|b| b.as_bool()),
                    Some(true),
                    "{name} 在 Windows 上应当可用"
                );
            }
        }
    }

    /// 只有 Intel Mac 要报「装得上但工具跑不了」。判据写反（或写成 `!= aarch64`）会把
    /// 正常出货的 Apple Silicon 也标红，而那是主力平台。
    #[test]
    fn only_intel_macos_carries_the_note() {
        assert!(unsupported_note_for("macos", "x86_64").is_some());
        assert!(unsupported_note_for("macos", "aarch64").is_none());
        assert!(unsupported_note_for("windows", "x86_64").is_none());
        assert!(unsupported_note_for("linux", "x86_64").is_none());
        assert!(unsupported_note_for("linux", "aarch64").is_none());
    }
}
