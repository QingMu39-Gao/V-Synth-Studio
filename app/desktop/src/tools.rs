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

fn home() -> PathBuf {
    crate::platform::home_dir().unwrap_or_else(|| PathBuf::from("C:\\Users\\Administrator"))
}

fn local_appdata() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join("AppData\\Local"))
}

/// 完整候选表 —— 顺序即界面上的显示顺序，和 Node 版一致
fn candidates() -> Vec<Candidate> {
    let pf = PathBuf::from(std::env::var("ProgramFiles").unwrap_or_else(|_| "C:\\Program Files".into()));
    let pfx = PathBuf::from(
        std::env::var("ProgramFiles(x86)").unwrap_or_else(|_| "C:\\Program Files (x86)".into()),
    );
    let utau_voice = home().join("Desktop").join("UTAU VOICE");

    vec![
        Candidate {
            id: "vocaloid6",
            name: "VOCALOID6",
            vendor: "Yamaha",
            category: "editor",
            formats: &["vpr", "vsqx"],
            color: "#00b3e3",
            paths: vec![
                PathBuf::from("H:\\VOCALOID6\\Editor\\VOCALOID6.exe"),
                PathBuf::from("D:\\VOCALOID6\\Editor\\VOCALOID6.exe"),
                pf.join("VOCALOID6\\Editor\\VOCALOID6.exe"),
                pfx.join("VOCALOID6\\Editor\\VOCALOID6.exe"),
            ],
            scan_dirs: vec![
                PathBuf::from("H:\\VOCALOID6"),
                PathBuf::from("D:\\VOCALOID6"),
                pf.join("VOCALOID6"),
            ],
            exe_names: &["vocaloid6.exe"],
            scan_depth: 2,
        },
        Candidate {
            id: "vocaloid5",
            name: "VOCALOID5",
            vendor: "Yamaha",
            category: "editor",
            formats: &["vpr", "vsqx"],
            color: "#00b3e3",
            paths: vec![
                pf.join("VOCALOID5\\Editor\\VOCALOID5.exe"),
                PathBuf::from("D:\\VOCALOID5\\Editor\\VOCALOID5.exe"),
            ],
            scan_dirs: vec![pf.join("VOCALOID5"), PathBuf::from("D:\\VOCALOID5")],
            exe_names: &["vocaloid5.exe"],
            scan_depth: 2,
        },
        Candidate {
            id: "synthv2",
            name: "Synthesizer V Studio 2 Pro",
            vendor: "Dreamtonics",
            category: "editor",
            formats: &["svp"],
            color: "#f5a623",
            paths: vec![
                PathBuf::from("H:\\Synthesizer V Studio 2 Pro\\synthv-studio.exe"),
                PathBuf::from("D:\\Synthesizer V Studio 2 Pro\\synthv-studio.exe"),
                pf.join("Synthesizer V Studio 2 Pro\\synthv-studio.exe"),
            ],
            scan_dirs: vec![
                PathBuf::from("H:\\Synthesizer V Studio 2 Pro"),
                PathBuf::from("D:\\Synthesizer V Studio 2 Pro"),
                pf.join("Synthesizer V Studio 2 Pro"),
            ],
            exe_names: &["synthv-studio.exe"],
            scan_depth: 2,
        },
        Candidate {
            id: "synthv1",
            name: "Synthesizer V Studio",
            vendor: "Dreamtonics",
            category: "editor",
            formats: &["svp"],
            color: "#f5a623",
            paths: vec![
                pf.join("Synthesizer V Studio\\synthv-studio.exe"),
                PathBuf::from("D:\\Synthesizer V Studio\\synthv-studio.exe"),
            ],
            scan_dirs: vec![pf.join("Synthesizer V Studio")],
            exe_names: &["synthv-studio.exe"],
            scan_depth: 2,
        },
        Candidate {
            id: "cevio",
            name: "CeVIO AI / CS",
            vendor: "CeVIO",
            category: "editor",
            formats: &["ccs"],
            color: "#e6007e",
            paths: vec![
                PathBuf::from("H:\\cevio\\CeVIO AI.exe"),
                pf.join("CeVIO\\CeVIO AI.exe"),
                pfx.join("CeVIO\\CeVIO Creative Studio.exe"),
            ],
            scan_dirs: vec![PathBuf::from("H:\\cevio"), pf.join("CeVIO"), pfx.join("CeVIO")],
            exe_names: &["cevio ai.exe", "cevio creative studio.exe"],
            scan_depth: 2,
        },
        Candidate {
            id: "openutau",
            name: "OpenUtau",
            vendor: "OpenUtau",
            category: "editor",
            formats: &["ustx", "ust"],
            color: "#7c5cff",
            paths: vec![
                PathBuf::from("H:\\OpenUtau\\OpenUtau.exe"),
                pf.join("OpenUtau\\OpenUtau.exe"),
            ],
            scan_dirs: vec![
                PathBuf::from("H:\\OpenUtau"),
                pf.join("OpenUtau"),
                local_appdata().join("OpenUtau"),
            ],
            exe_names: &["openutau.exe"],
            scan_depth: 2,
        },
        Candidate {
            id: "utau",
            name: "UTAU",
            vendor: "飴屋／菖蒲",
            category: "editor",
            formats: &["ust"],
            color: "#4caf50",
            paths: vec![
                pfx.join("UTAU\\UTAU.exe"),
                PathBuf::from("C:\\UTAU\\UTAU.exe"),
                PathBuf::from("D:\\UTAU\\UTAU.exe"),
            ],
            scan_dirs: vec![pfx.join("UTAU"), PathBuf::from("C:\\UTAU"), PathBuf::from("D:\\UTAU")],
            exe_names: &["utau.exe"],
            scan_depth: 2,
        },
        Candidate {
            id: "acestudio",
            name: "ACE Studio",
            vendor: "ACE Studio",
            category: "editor",
            formats: &["acep"],
            color: "#ff5c8a",
            paths: vec![
                pf.join("ACE Studio\\ACE Studio.exe"),
                PathBuf::from("D:\\ACE Studio\\ACE Studio.exe"),
                PathBuf::from("H:\\ACE Studio\\ACE Studio.exe"),
            ],
            scan_dirs: vec![
                pf.join("ACE Studio"),
                PathBuf::from("D:\\ACE Studio"),
                PathBuf::from("H:\\ACE Studio"),
            ],
            exe_names: &["ace studio.exe", "acestudio.exe"],
            scan_depth: 2,
        },
        Candidate {
            id: "deepvocal",
            name: "DeepVocal",
            vendor: "DeepVocal",
            category: "editor",
            formats: &["dv"],
            color: "#00c2a8",
            paths: vec![
                pf.join("DeepVocal\\DeepVocal.exe"),
                PathBuf::from("D:\\DeepVocal\\DeepVocal.exe"),
            ],
            scan_dirs: vec![pf.join("DeepVocal"), PathBuf::from("D:\\DeepVocal")],
            exe_names: &["deepvocal.exe"],
            scan_depth: 2,
        },
        Candidate {
            id: "voicevox",
            name: "VOICEVOX",
            vendor: "Hiroshiba",
            category: "editor",
            formats: &[],
            color: "#39c5bb",
            paths: vec![
                pf.join("VOICEVOX\\VOICEVOX.exe"),
                PathBuf::from("D:\\VOICEVOX\\VOICEVOX.exe"),
                local_appdata().join("Programs\\VOICEVOX\\VOICEVOX.exe"),
            ],
            scan_dirs: vec![pf.join("VOICEVOX"), local_appdata().join("Programs\\VOICEVOX")],
            exe_names: &["voicevox.exe"],
            scan_depth: 2,
        },
        Candidate {
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
        },
        Candidate {
            id: "vlabeler",
            name: "vLabeler（原音设定标注）",
            vendor: "sdercolin",
            category: "tool",
            formats: &[],
            color: "#9c88ff",
            // Node 版除了环境变量拼的路径，还硬编码了这个绝对路径。
            // 保留它 —— 环境变量在某些启动方式下拿不到（比如被上层进程改写）
            paths: vec![
                PathBuf::from("C:\\Users\\Administrator\\Desktop\\UTAU VOICE\\vlabeler-1.7.0-beta2-win64\\vLabeler.exe"),
                utau_voice.join("vlabeler-1.7.0-beta2-win64\\vLabeler.exe"),
            ],
            scan_dirs: vec![utau_voice.clone()],
            exe_names: &["vlabeler.exe"],
            scan_depth: 3,
        },
        Candidate {
            id: "flstudio",
            name: "FL Studio",
            vendor: "Image-Line",
            category: "daw",
            formats: &["midi"],
            color: "#ff8a00",
            paths: vec![
                pf.join("Image-Line\\FL Studio 2024\\FL64.exe"),
                pf.join("Image-Line\\FL Studio 2025\\FL64.exe"),
            ],
            scan_dirs: vec![
                pf.join("Image-Line"),
                PathBuf::from("D:\\Program Files\\Image-Line"),
                PathBuf::from("H:\\Image-Line"),
            ],
            exe_names: &["fl64.exe", "fl.exe"],
            scan_depth: 3,
        },
        Candidate {
            id: "oremo",
            name: "oremo（声库录音工具）",
            vendor: "UTAU 生态",
            category: "voicebank",
            formats: &[],
            color: "#4caf50",
            paths: vec![],
            scan_dirs: vec![utau_voice.clone()],
            exe_names: &["oremo.exe"],
            scan_depth: 2,
        },
        Candidate {
            id: "recstar",
            name: "RecStar（声库录音工具）",
            vendor: "UTAU 生态",
            category: "voicebank",
            formats: &[],
            color: "#4caf50",
            paths: vec![],
            scan_dirs: vec![utau_voice.clone()],
            exe_names: &["recstar.exe"],
            scan_depth: 2,
        },
        Candidate {
            id: "textgrid2oto",
            name: "TextGrid2oto（自动原音设定）",
            vendor: "UTAU 生态",
            category: "voicebank",
            formats: &[],
            color: "#4caf50",
            paths: vec![],
            scan_dirs: vec![utau_voice],
            exe_names: &["textgrid2oto.exe"],
            scan_depth: 2,
        },
    ]
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
fn civil_from_days(z: i64) -> (i64, u32, u32) {
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

/// 自定义程序路径（设置页里加的）
pub fn custom_programs(config: &Value) -> Vec<PathBuf> {
    config
        .get("customPrograms")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.get("path").and_then(|p| p.as_str()))
                .map(PathBuf::from)
                .collect()
        })
        .unwrap_or_default()
}
