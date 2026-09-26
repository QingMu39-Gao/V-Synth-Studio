//! 本机编辑器与外部工具探测
//!
//! 路径表照搬 Node 版 tools.mjs 的 CANDIDATES（它那 56 处 Windows 路径都集中在这里）。
//! 移植 macOS 时只需要换这张表 —— 这正是把平台代码收在一处的意义。

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

/// 编辑器/工具候选定义
struct Candidate {
    id: &'static str,
    name: &'static str,
    vendor: &'static str,
    category: &'static str,
    formats: &'static [&'static str],
    color: &'static str,
    /// 直接命中：这些路径存在就算找到
    paths: Vec<PathBuf>,
    /// 兜底：在这些目录里按文件名找（深度受限）
    scan_dirs: Vec<PathBuf>,
    /// 扫描时匹配的可执行文件名（小写，精确匹配）
    exe_names: &'static [&'static str],
    scan_depth: usize,
}



/// 需要探测的外部程序。
///
/// **只留 UVR 一个**。原来的表里有 16 个编辑器（VOCALOID6/5、SynthV 1/2、CeVIO、
/// OpenUtau、UTAU、ACE Studio、DeepVocal、VOICEVOX、FL Studio、oremo、RecStar…），
/// 配 56 条硬编码路径和带深度限制的目录扫描 —— 但其中**只有 UVR 被真正用到**
/// （音频页的人声分离要跳过去）。
///
/// 其余的用途只是「在工作站里显示装了什么」和「从工作站启动别的编辑器」。
/// 用户桌面本来就有快捷方式，绕这一层没有意义，还带来一堆要跟着编辑器版本维护的路径。
fn candidates() -> Vec<Candidate> {
    let pf = PathBuf::from(
        std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into()),
    );

    vec![Candidate {
        id: "uvr",
        name: "Ultimate Vocal Remover (离线人声分离)",
        vendor: "社区",
        category: "tool",
        formats: &[],
        color: "#00d1b2",
        paths: vec![
            PathBuf::from("H:\\ChiXiaoYangUVR5\\UVR.exe"),
            PathBuf::from("H:\\ChiXiaoYangUVR5\\Start.exe"),
            pf.join("Ultimate Vocal Remover\\UVR.exe"),
        ],
        scan_dirs: vec![
            PathBuf::from("H:\\ChiXiaoYangUVR5"),
            pf.join("Ultimate Vocal Remover"),
        ],
        exe_names: &["uvr.exe", "start.exe", "ultimate vocal remover.exe"],
        scan_depth: 2,
    }]
}
/// 探测本机装了哪些编辑器
pub fn detect_editors() -> Vec<Value> {
    candidates()
        .into_iter()
        .map(|c| {
            let hit = detect_candidate(&c);
            json!({
                "id": c.id,
                "name": c.name,
                "vendor": c.vendor,
                "category": c.category,
                "formats": c.formats,
                "color": c.color,
                "installed": hit.is_some(),
                "path": hit.as_ref().map(|(p, _)| p.to_string_lossy().to_string()),
                "how": hit.as_ref().map(|(_, how)| *how),
            })
        })
        .collect()
}

/// 返回 (路径, 命中方式)
fn detect_candidate(c: &Candidate) -> Option<(PathBuf, &'static str)> {
    for p in &c.paths {
        if p.is_file() {
            return Some((p.clone(), "已知路径"));
        }
    }
    for dir in &c.scan_dirs {
        if let Some(p) = scan_for_exe(dir, c.exe_names, c.scan_depth) {
            return Some((p, "目录扫描"));
        }
    }
    None
}

/// 在目录里按文件名找可执行文件（深度受限，命中即返回）
fn scan_for_exe(dir: &Path, names: &[&str], max_depth: usize) -> Option<PathBuf> {
    fn walk(dir: &Path, names: &[&str], depth: usize, max: usize) -> Option<PathBuf> {
        if depth > max {
            return None;
        }
        let Ok(entries) = std::fs::read_dir(dir) else { return None };
        let mut subdirs = Vec::new();
        for e in entries.flatten() {
            let Ok(ft) = e.file_type() else { continue };
            if ft.is_dir() {
                subdirs.push(e.path());
            } else if ft.is_file() {
                let name = e.file_name().to_string_lossy().to_lowercase();
                if names.contains(&name.as_str()) {
                    return Some(e.path());
                }
            }
        }
        for d in subdirs {
            if let Some(p) = walk(&d, names, depth + 1, max) {
                return Some(p);
            }
        }
        None
    }
    walk(dir, names, 0, max_depth)
}

/* ══════════════════════════════════ 外部工具 ══════════════════════════════════ */

/// `detectAll()` 的等价物 —— /api/tools/detect 的完整形状
pub fn detect_all(root: &Path) -> Value {
    let editors = detect_editors();
    let installed = editors
        .iter()
        .filter(|e| e.get("installed").and_then(|v| v.as_bool()).unwrap_or(false))
        .count();
    json!({
        "checkedAt": iso_now(),
        "platform": crate::platform::node_platform_name(),
        // Node 版这里是 process.version；现在没有 Node 了，改成运行时标识
        "node": format!("Rust {}（内嵌后端）", env!("CARGO_PKG_VERSION")),
        "root": root.to_string_lossy(),
        "editors": editors,
        "tools": detect_tools(root),
        "installedCount": installed,
    })
}

fn iso_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = secs / 86400;
    let rem = secs % 86400;
    let (y, m, d) = civil_from_days(days as i64);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.000Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Howard Hinnant 的 civil_from_days（公历换算，不引 chrono）
pub fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = (z - era * 146097) as u64;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe as i64 + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// 外部工具探测（ffmpeg / yt-dlp / python）
pub fn detect_tools(root: &Path) -> Value {
    let tools_dir = root.join("tools");

    let ffmpeg = {
        let bundled = tools_dir.join("ffmpeg").join("bin").join(exe("ffmpeg"));
        if bundled.is_file() {
            json!({
                "available": true,
                "path": bundled.to_string_lossy(),
                "source": "程序目录",
                "version": ffmpeg_version(&bundled),
            })
        } else if let Some(p) = crate::platform::find_binary("ffmpeg", &[]) {
            json!({
                "available": true,
                "path": p.to_string_lossy(),
                "source": "系统 PATH",
                "version": ffmpeg_version(&p),
            })
        } else {
            json!({ "available": false, "path": null, "source": "", "version": null })
        }
    };

    let ytdlp = {
        let bundled = tools_dir.join(exe("yt-dlp"));
        if bundled.is_file() {
            json!({
                "available": true,
                "path": bundled.to_string_lossy(),
                "kind": "binary",
                "source": "程序目录",
                "version": trim_version(&bundled, &["--version"]),
            })
        } else if let Some(p) = crate::platform::find_binary("yt-dlp", &[]) {
            json!({
                "available": true,
                "path": p.to_string_lossy(),
                "kind": "binary",
                "source": "系统 PATH",
                "version": trim_version(&p, &["--version"]),
            })
        } else {
            json!({ "available": false, "path": null, "kind": "binary", "source": "", "version": null })
        }
    };

    let python = match crate::platform::find_binary("python", &[]) {
        Some(p) => json!({
            "available": true,
            "path": "python",
            "version": trim_version(&p, &["--version"]),
        }),
        None => json!({ "available": false, "path": null, "version": null }),
    };

    json!({ "ffmpeg": ffmpeg, "python": python, "ytdlp": ytdlp })
}

pub fn exe(base: &str) -> String {
    if cfg!(windows) {
        format!("{base}.exe")
    } else {
        base.to_string()
    }
}

fn run_capture(bin: &Path, args: &[&str]) -> Option<String> {
    let out = crate::server::quiet_command(&bin.to_string_lossy())
        .args(args)
        .output()
        .ok()?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    let stderr = String::from_utf8_lossy(&out.stderr).to_string();
    Some(if stdout.trim().is_empty() { stderr } else { stdout })
}

fn ffmpeg_version(bin: &Path) -> Option<String> {
    let text = run_capture(bin, &["-version"])?;
    text.lines()
        .next()
        .and_then(|l| l.split_whitespace().nth(2))
        .map(|s| s.to_string())
}

fn trim_version(bin: &Path, args: &[&str]) -> Option<String> {
    run_capture(bin, args).map(|s| s.trim().to_string())
}
