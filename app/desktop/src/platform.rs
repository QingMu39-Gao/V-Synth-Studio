//! 平台相关：Windows 特有的是注册表、explorer、回收站；其余走标准库。
//!
//! 这一层是**唯一**放平台代码的地方 —— 移植 macOS 时只需要在这里加一个 cfg 分支，
//! 上层业务代码一行都不用改。（对照 docs/PLATFORM-PORT.md）

use std::path::{Path, PathBuf};
use std::process::Command;

use serde_json::{json, Value};

/* ══════════════════════════════════ 下载目录 ══════════════════════════════════ */

/// 系统的「下载」目录。
///
/// Windows 上 Explorer 会把用户改过的下载路径写进注册表，那是权威来源；
/// 读不到就退回 `%USERPROFILE%\Downloads`。macOS/Linux 直接 `$HOME/Downloads`。
///
/// **绝不返回空串。** 早先的写法是「目录不存在就跳过」——三条来源都不存在时返回 ""，
/// 结果程序没有输出目录，界面上是个空字段，用户完全不知道文件会存到哪。
/// 现在改成：拿到的路径就算还不存在也采用（下载目录本来就可能没建过），
/// 最后兜底到用户主目录，保证调用方永远有一个可用的绝对路径。
pub fn downloads_dir() -> String {
    // 1) 注册表（用户可能把下载目录改到别的盘）
    #[cfg(windows)]
    if let Some(p) = windows_downloads_from_registry() {
        if !p.trim().is_empty() {
            // 不存在就先建出来 —— 不建的话后面写文件会失败
            let _ = std::fs::create_dir_all(&p);
            return p;
        }
    }

    // 2) 用户主目录下的 Downloads
    if let Some(home) = home_dir() {
        let d = home.join("Downloads");
        if d.is_dir() {
            return d.to_string_lossy().to_string();
        }
        // 3) 主目录本身总存在，用它兜底（下载目录建不出来时的最后退路）
        return home.to_string_lossy().to_string();
    }

    // 4) 连主目录都拿不到（极少见）：用临时目录，至少不是空串
    std::env::temp_dir().to_string_lossy().to_string()
}

pub fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE").map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

#[cfg(windows)]
fn windows_downloads_from_registry() -> Option<String> {
    use windows_sys::Win32::System::Registry::{
        RegCloseKey, RegOpenKeyExW, RegQueryValueExW, HKEY_CURRENT_USER, KEY_READ, REG_EXPAND_SZ,
        REG_SZ,
    };

    const SUBKEY: &str = "Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders";
    // {374DE290-123F-4565-9164-39C4925E467B} 就是「下载」的 KNOWNFOLDERID
    const VALUE: &str = "{374DE290-123F-4565-9164-39C4925E467B}";

    let subkey = to_wide(SUBKEY);
    let value_name = to_wide(VALUE);

    unsafe {
        let mut hkey = std::mem::zeroed();
        if RegOpenKeyExW(HKEY_CURRENT_USER, subkey.as_ptr(), 0, KEY_READ, &mut hkey) != 0 {
            return None;
        }

        let mut buf = vec![0u16; 1024];
        let mut len = (buf.len() * 2) as u32;
        let mut ty = 0u32;
        let rc = RegQueryValueExW(
            hkey,
            value_name.as_ptr(),
            std::ptr::null_mut(),
            &mut ty,
            buf.as_mut_ptr() as *mut u8,
            &mut len,
        );
        RegCloseKey(hkey);

        if rc != 0 || (ty != REG_SZ && ty != REG_EXPAND_SZ) {
            return None;
        }

        let n = (len as usize / 2).saturating_sub(1);
        let raw = String::from_utf16_lossy(&buf[..n]);
        Some(expand_env(&raw))
    }
}

/// 展开 `%USERPROFILE%` 这类环境变量
pub fn expand_env(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let bytes: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == '%' {
            if let Some(end) = bytes[i + 1..].iter().position(|&c| c == '%') {
                let name: String = bytes[i + 1..i + 1 + end].iter().collect();
                if let Ok(v) = std::env::var(&name) {
                    out.push_str(&v);
                    i += end + 2;
                    continue;
                }
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    out
}

#[cfg(windows)]
fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// 平台名，用 Node 的命名习惯（`win32` / `darwin` / `linux`）。
///
/// 前端读这个字段来判断「哪些功能在哪些平台可用」，所以要跟 Node 版一致 ——
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

/* ══════════════════════════════════ 文件系统根 ══════════════════════════════════ */

/// 文件选择器的根节点列表，形状对齐 Node 版：
/// `[{name, path, type, parent?}]`
pub fn fs_roots() -> Vec<Value> {
    let mut roots = Vec::new();

    #[cfg(windows)]
    {
        for letter in b'C'..=b'Z' {
            let p = format!("{}:\\", letter as char);
            if Path::new(&p).exists() {
                roots.push(json!({
                    "name": format!("{}:", letter as char),
                    "path": p,
                    "type": "drive",
                }));
            }
        }
    }
    #[cfg(not(windows))]
    {
        roots.push(json!({ "name": "/", "path": "/", "type": "drive" }));
        if let Some(h) = home_dir() {
            roots.push(json!({ "name": "主目录", "path": h.to_string_lossy(), "type": "user" }));
        }
    }

    if let Some(home) = home_dir() {
        for (label, sub) in [
            ("桌面", "Desktop"),
            ("下载", "Downloads"),
            ("文档", "Documents"),
            ("音乐", "Music"),
            ("视频", "Videos"),
        ] {
            let p = home.join(sub);
            if p.exists() {
                let mut item = json!({
                    "name": label,
                    "path": p.to_string_lossy(),
                    "type": "user",
                });
                if label == "桌面" {
                    item["parent"] = json!(home.to_string_lossy());
                }
                roots.push(item);
            }
        }
        // 「用户目录」在 Node 版里排在桌面之后
        roots.push(json!({
            "name": "用户目录",
            "path": home.to_string_lossy(),
            "type": "user",
        }));
    }

    roots
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

/// 看着像 URL 吗（这几个前缀交给系统默认程序，**不做文件存在性检查**）
pub fn looks_like_url(s: &str) -> bool {
    let t = s.trim().to_ascii_lowercase();
    ["http://", "https://", "ftp://", "mailto:"].iter().any(|p| t.starts_with(p))
}
#[cfg(test)]
mod url_tests {
    use super::looks_like_url;

    /// 这个判定决定 `fs_open` 走「开浏览器」还是「开文件」，判错就会把
    /// 一个 URL 当成文件去 `explorer`（或者反过来），所以单独立一条测试。
    #[test]
    fn detects_urls_case_insensitively() {
        assert!(looks_like_url("https://example.com/a"));
        assert!(looks_like_url("HTTPS://EXAMPLE.COM"));
        assert!(looks_like_url("  http://127.0.0.1:17878/api/state  "));
        assert!(looks_like_url("mailto:someone@example.com"));
        assert!(!looks_like_url(""));
        assert!(!looks_like_url("C:\\Music\\a.wav"));
        assert!(!looks_like_url("https:/missing-slash"));
        assert!(!looks_like_url("file:///C:/tmp")); // file:// 有意不认，交给路径分支
    }
}
/// 在文件管理器里定位到该文件（选中它）
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
        let out = crate::server::quiet_command("powershell")
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
