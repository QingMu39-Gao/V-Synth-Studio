//! Wallpaper Engine 库扫描 —— 「这台机器上有哪些壁纸、现在用的是哪一张」。
//!
//! 只**读**用户自己 Steam 库里的文件：不下载、不打包、不改动。壁纸是用户自己买/
//! 订阅的内容，本程序只当它是本地素材。
//!
//! ⚠️ **不缓存扫描结果**：Steam 的库位置会变、订阅会增删，每次问一次磁盘最省心
//! （几十个小 JSON，几毫秒）。缓存只会多一层会过期的状态。
//!
//! ⚠️ **不读注册表**：默认安装位置 + `libraryfolders.vdf` 已经覆盖绝大多数机器，
//! 剩下的（自定义安装目录）由用户在设置里点一次目录（`config.weDir`）解决 ——
//! 比引一套注册表读取 + unsafe 便宜得多。

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

/// 工坊应用 id：Wallpaper Engine。
const WE_APP_ID: &str = "431960";

/// 一张壁纸目录里，这几个名字第一个存在的就是场景包（与 webwallgl 的回退顺序一致）。
const SCENE_PKG_CANDIDATES: &[&str] = &["scene.pkg", "scenes/scene.pkg", "gifscene.pkg"];

/// 一次最多扫多少条 —— 只是防呆（几十个条目是常态）。
const MAX_ITEMS: usize = 400;

/// Steam 库根目录候选：默认安装位置 + `libraryfolders.vdf` 里登记的其它盘。
fn steam_roots() -> Vec<PathBuf> {
    let mut out: Vec<PathBuf> = Vec::new();
    let push = |p: PathBuf, out: &mut Vec<PathBuf>| {
        if p.is_dir() && !out.contains(&p) {
            out.push(p);
        }
    };
    for base in ["ProgramFiles(x86)", "ProgramFiles", "ProgramW6432"] {
        if let Ok(v) = std::env::var(base) {
            push(PathBuf::from(v).join("Steam"), &mut out);
        }
    }
    // 多盘用户的库可能不在默认位置：默认库里的 libraryfolders.vdf 记着其它库
    for root in out.clone() {
        for extra in library_roots(&root) {
            push(extra, &mut out);
        }
    }
    out
}

/// 从 `steamapps/libraryfolders.vdf` 里抠出 `"path" "…"`。**不引 vdf 库** ——
/// 这个文件里我们只要这一个键，按行找引号就够（它永远是 `"path"\t\t"X:\\…"`）。
fn library_roots(steam: &Path) -> Vec<PathBuf> {
    let Ok(text) = std::fs::read_to_string(steam.join("steamapps").join("libraryfolders.vdf"))
    else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for line in text.lines() {
        let Some(rest) = line.trim().strip_prefix("\"path\"") else {
            continue;
        };
        let Some(start) = rest.find('"') else {
            continue;
        };
        let rest = &rest[start + 1..];
        let Some(end) = rest.find('"') else { continue };
        let p = PathBuf::from(rest[..end].replace("\\\\", "\\"));
        if p.is_dir() {
            out.push(p);
        }
    }
    out
}

/// WE 安装目录。`configured` 是用户在设置里指定的那个（空 = 没指定）。
pub fn we_dir(configured: &str) -> Option<PathBuf> {
    let manual = configured.trim();
    if !manual.is_empty() {
        let p = PathBuf::from(manual);
        if p.is_dir() {
            return Some(p);
        }
    }
    steam_roots()
        .into_iter()
        .map(|r| r.join("steamapps").join("common").join("wallpaper_engine"))
        .find(|p| p.is_dir())
}

/// WE 自己记的「现在用的是哪张壁纸」。
///
/// `config.json` 里是 `selectedwallpapers.<显示器>.file`，值是**壁纸文件的绝对路径**
/// （场景是 `…/<id>/scene.pkg`，视频是 `…/<id>/xxx.mp4`）—— 所以目录 = 它的父目录。
fn current_wallpaper_file(we: &Path) -> Option<PathBuf> {
    let text = std::fs::read_to_string(we.join("config.json")).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    /* ⚠️ 顶层按 **Windows 账户名** 分节（那一段的键就是用户名），所以只能扫过去找
    「哪一节里有 general」—— 写死用户名或者取第一个节都不行。
    ⚠️ 真正的位置是 `general.wallpaperconfig.selectedwallpapers`（少一层就永远读不到，
    而它**不报错**：症状只是「跟随当前壁纸」没反应）。老版本可能没有
    `wallpaperconfig` 那一层，所以两条路都试。 */
    let file = v
        .as_object()?
        .values()
        .filter_map(|section| section.get("general"))
        .find_map(|g| {
            g.get("wallpaperconfig")
                .and_then(|w| w.get("selectedwallpapers"))
                .or_else(|| g.get("selectedwallpapers"))
        })
        .and_then(|sel| {
            sel.as_object()?
                .values()
                .find_map(|m| m.get("file").and_then(Value::as_str))
        })?;
    let p = PathBuf::from(file);
    p.is_file().then_some(p)
}

/// 读一张壁纸的 `project.json`，把里面那几个相对路径补成绝对路径。
///
/// 返回 `None` = 这个目录不是一张壁纸（没有/读不出 `project.json`），跳过它。
fn read_item(dir: &Path, source: &str) -> Option<Value> {
    let id = dir.file_name()?.to_string_lossy().to_string();
    let proj: Value =
        serde_json::from_str(&std::fs::read_to_string(dir.join("project.json")).ok()?).ok()?;
    let abs = |p: PathBuf| crate::platform::clean_path(&p);
    let ty = proj
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_ascii_lowercase();
    let file = proj.get("file").and_then(Value::as_str).unwrap_or("");
    let media = Path::new(file)
        .is_relative()
        .then(|| dir.join(file))
        .filter(|p| p.is_file())
        .map(abs);
    let pkg = SCENE_PKG_CANDIDATES
        .iter()
        .map(|c| dir.join(c))
        .find(|p| p.is_file())
        .map(abs);
    let preview = proj
        .get("preview")
        .and_then(Value::as_str)
        .map(|p| dir.join(p))
        .filter(|p| p.is_file())
        .map(abs);
    Some(json!({
        "id": id,
        "title": proj.get("title").and_then(Value::as_str).unwrap_or("(无标题)"),
        "type": ty,
        "source": source,
        "dir": abs(dir.to_path_buf()),
        /* 场景包与媒体文件**分开给**：前端按 type 决定用哪个。
           ⚠️ `file` 可能是 `scene.json`（真身在 scene.pkg 里），也可能是 `x.mp4` ——
           所以两个字段都要留着，别在前端拿 `file` 反推。 */
        "pkg": pkg,
        "media": media,
        "preview": preview,
    }))
}

/// 扫一遍库里所有壁纸 + 当前正在用的那一张。
pub fn scan(configured_we_dir: &str) -> Value {
    let we = we_dir(configured_we_dir);
    let mut dirs: Vec<(PathBuf, &str)> = Vec::new();
    for root in steam_roots() {
        let content = root
            .join("steamapps")
            .join("workshop")
            .join("content")
            .join(WE_APP_ID);
        let Ok(rd) = std::fs::read_dir(&content) else {
            continue;
        };
        for e in rd.flatten() {
            if e.path().is_dir() {
                dirs.push((e.path(), "workshop"));
            }
        }
    }
    if let Some(we) = we.as_ref() {
        for (sub, source) in [
            ("myprojects", "myprojects"),
            ("defaultprojects", "defaultprojects"),
        ] {
            let Ok(rd) = std::fs::read_dir(we.join("projects").join(sub)) else {
                continue;
            };
            for e in rd.flatten() {
                if e.path().is_dir() {
                    dirs.push((e.path(), source));
                }
            }
        }
    }

    // 当前壁纸：WE 记的是**文件**路径，取父目录；扫到的条目里正好有它就带上标题
    let current_file = we.as_ref().and_then(|w| current_wallpaper_file(w));
    let current_dir = current_file
        .as_ref()
        .and_then(|f| f.parent().map(Path::to_path_buf));
    if let Some(d) = current_dir.as_ref()
        && !dirs.iter().any(|(p, _)| p == d)
    {
        /* 本地工程（`myprojects` 之外的地方）或者订阅刚被删：条目里没有它，
        但用户此刻正用着 —— 单独补一条，别让「跟随当前壁纸」无从下手。 */
        dirs.push((d.clone(), "local"));
    }

    let mut items: Vec<Value> = Vec::new();
    for (dir, source) in dirs.into_iter().take(MAX_ITEMS) {
        if let Some(it) = read_item(&dir, source) {
            items.push(it);
        }
    }
    let current = current_dir
        .as_ref()
        .and_then(|d| {
            items.iter().find(|i| {
                i.get("dir").and_then(Value::as_str) == Some(&crate::platform::clean_path(d))
            })
        })
        .cloned()
        .or_else(|| current_dir.as_ref().and_then(|d| read_item(d, "local")));

    json!({
        "found": we.is_some(),
        "weDir": we.as_ref().map(|p| crate::platform::clean_path(p)),
        "currentFile": current_file.as_ref().map(|p| crate::platform::clean_path(p)),
        "current": current,
        "items": items,
    })
}
