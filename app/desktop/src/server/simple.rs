//! 阶段 1：基础路由
//!
//! health / state / config / fs/* / jobs/* / resources / 静态文件
//!
//! 每个处理器的响应形状都以 `tests/contract/fixtures/*.json` 里的真实抓包为准。

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Map, Value};

use super::{ok, AppState};

/* ══════════════════════════════════ 健康检查 ══════════════════════════════════ */

/// 对外显示的版本号。
///
/// Cargo 的 `version` 必须是合法 semver（`1.1.0-beta`），但那个字符串给人看太啰嗦。
/// 界面上要的是 `1.1beta`，所以单独列一个常量 —— 改版本号时两处都要改。
pub const APP_VERSION: &str = "1.1beta";

/// 作者标识。出现在「关于」里，也散落在源码注释中作为出处水印。
pub const AUTHOR_TAG: &str = "QingMu39";

pub async fn health(State(st): State<Arc<AppState>>) -> Json<Value> {
    Json(ok(json!({
        "name": "V-Synth-Studio",
        "version": APP_VERSION,
        // 这个键历史上叫 node（前端读的就是它），现在装的是「运行环境」——
        // 显示在「关于」里，让人一眼看出跑在哪套系统上。
        // 刻意不写实现语言：用户不关心后端用什么写的，那是一行噪音。
        "node": platform_desc(),
        "author": AUTHOR_TAG,
        "pid": std::process::id(),
        "startedAt": now_millis() - st.started.elapsed().as_millis() as u64,
        "uptimeSec": st.started.elapsed().as_secs(),
    })))
}

/// 「关于」里那行运行环境，例如 `Windows (x86_64)`。
///
/// 公开：`/api/tools/detect` 也用它填同一个字段。
pub fn platform_desc() -> String {
    let os = if cfg!(target_os = "windows") {
        "Windows"
    } else if cfg!(target_os = "macos") {
        "macOS"
    } else {
        "Linux"
    };
    format!("{os} ({})", std::env::consts::ARCH)
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/* ══════════════════════════════════ 配置 ══════════════════════════════════ */

/// 配置默认值，和 Node 版的 DEFAULT_CONFIG 逐字段对齐。
///
/// ⚠️ **改这里就是改接口契约**：`tests/contract/fixtures/{config,state}.json` 是冻结的基准，
/// 增删键都要同步那份夹具，否则 `tests/contract/verify.mjs` 会红。
///
/// 2026-10-02 删掉了 4 个「只写不读」的键 —— 它们从 Node 版继承下来，从来没有读写方：
///   `lastSourceFormat` / `voiceDirs` / `perfMode` / `customPrograms`
/// 其中 `perfMode` 早就是前端 localStorage 的事，`customPrograms` 只被
/// `/api/tools/launch` 的 `{id}` 分支读过（那条分支也一并删了）。
pub fn default_config() -> Value {
    let downloads = crate::platform::downloads_dir();
    json!({
        "bilibiliCookie": "",
        // 歌词页用：网易云 / QQ 音乐的登录态（扫码登录成功后也会落到这里）
        "neteaseCookie": "",
        "qqCookie": "",
        "proxy": "",
        "outputDir": downloads.clone(),
        "downloadDir": downloads,
        // 转换页「目标格式」的初值（`Convert.tsx` 读）。**没有写入方** ——
        // 界面上改目标格式是当次的事，不回写配置；要改默认值只能改这一行。
        "defaultTargetFormat": "vsqx",
        "nameTemplate": "{name}_converted",
        "threads": 4,
        "quality": 0,
        "audioQuality": 0,
    })
}

/// 配置文件路径。
///
/// 参数是**可写目录**而不是程序根目录：安装版装在 Program Files 下，
/// 那里只读，配置得写到 %APPDATA%。
fn config_path(writable: &Path) -> PathBuf {
    writable.join("config.json")
}

/// 读配置。文件不存在就用默认值（和 Node 版行为一致）。
///
/// ⚠️ 文件存在但**解析失败**时会记一行日志再回落默认值（2026-10-02 补）。
/// 以前这一步是纯静默的：`config.json` 里多一个花括号，用户改了设置却「没生效」，
/// 翻遍界面也看不出原因 —— 实际是整份配置被默认值顶掉了。
pub fn load_config(writable: &Path) -> Value {
    let mut base = default_config();
    if let Ok(text) = fs::read_to_string(config_path(writable)) {
        match serde_json::from_str::<Value>(&text) {
            Ok(saved) => {
                if let (Some(base_map), Some(saved_map)) = (base.as_object_mut(), saved.as_object()) {
                    for (k, v) in saved_map {
                        // 只认默认值里有的键：配置文件可能留着历史键
                        // （`perfMode` / `voiceDirs` / `customPrograms` / 更早的 `_root`），
                        // 它们不该出现在 `/api/state` 的 config 里 —— 这正是契约夹具的形状。
                        // 下次 `save_config` 整份回写时，文件里的历史键自然被清掉。
                        if base_map.contains_key(k) {
                            base_map.insert(k.clone(), v.clone());
                        }
                    }
                }
            }
            Err(e) => crate::log_line(&format!(
                "配置读取失败，已回落默认值：{} —— {e}。请检查这个文件是不是合法 JSON。",
                config_path(writable).display()
            )),
        }
    }
    // 迁移：旧默认输出目录（程序目录下的 output/）改成系统下载目录
    migrate_legacy_dirs(&mut base, writable);
    base
}

fn migrate_legacy_dirs(cfg: &mut Value, root: &Path) {
    let legacy: Vec<String> = ["output", "downloads"]
        .iter()
        .map(|d| root.join(d).to_string_lossy().to_lowercase())
        .collect();
    let downloads = crate::platform::downloads_dir();
    if let Some(m) = cfg.as_object_mut() {
        for key in ["outputDir", "downloadDir"] {
            let cur = m.get(key).and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
            if !cur.is_empty() && legacy.contains(&cur) {
                m.insert(key.into(), json!(downloads));
            }
        }
    }
}

pub fn save_config(writable: &Path, cfg: &Value) -> std::io::Result<()> {
    let p = config_path(writable);
    if let Some(dir) = p.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(p, serde_json::to_string_pretty(cfg).unwrap_or_default())
}

pub async fn config_get(State(st): State<Arc<AppState>>) -> Json<Value> {
    Json(ok(json!({ "config": mask_secrets(&st.config_snapshot()) })))
}

/// Cookie 类配置回显时的占位串。前端认它：看到「已设置」就只当有值，不会把它提交回来。
pub const MASKED: &str = "已设置";

/// 把 Cookie 的值换成「已设置」再回给前端。
///
/// 为什么：`/api/config` 与 `/api/state` 的结果会进前端全局状态，也常被贴进截图或日志，
/// 而 Cookie 就是账号登录态 —— 回显真值等于把账号摊开。前端把占位串原样提交回来时
/// `config_post` 会跳过它，所以不会出现「真值被占位串覆盖」这种反向事故。
fn mask_secrets(cfg: &Value) -> Value {
    let mut out = cfg.clone();
    if let Some(map) = out.as_object_mut() {
        for (k, v) in map.iter_mut() {
            if k.ends_with("Cookie") && v.as_str().is_some_and(|s| !s.is_empty()) {
                *v = json!(MASKED);
            }
        }
    }
    out
}

pub async fn config_post(
    State(st): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let mut cfg = st.config_snapshot();
    if let (Some(dst), Some(src)) = (cfg.as_object_mut(), body.as_object()) {
        for (k, v) in src {
            // 脱敏字段：前端把打码后的占位串原样传回来时不要覆盖真实值
            if k.ends_with("Cookie") && v.as_str() == Some(MASKED) {
                continue;
            }
            dst.insert(k.clone(), v.clone());
        }
    }
    save_config(&st.writable, &cfg).map_err(ApiError::from)?;
    if let Ok(mut guard) = st.config.lock() {
        *guard = cfg.clone();
    }
    // 回显也要打码：不然刚保存完 Cookie，明文就从响应里漏回前端了
    Ok(Json(ok(json!({ "config": mask_secrets(&cfg) }))))
}

/* ══════════════════════════════════ 状态聚合 ══════════════════════════════════ */

pub async fn state(State(st): State<Arc<AppState>>) -> Json<Value> {
    let cfg = st.config_snapshot();
    Json(ok(json!({
        // 前端侧边栏要显示版本号。以前它只能自己写死（/api/state 没这个字段），
        // 结果改了 APP_VERSION 界面完全不跟。这里给出去，前端就不必猜。
        "version": APP_VERSION,
        "formats": crate::libresvip::list_formats(&st.root),
        "editors": crate::tools::detect_editors(),
        "tools": crate::tools::detect_tools(&st.root),
        "transformOps": crate::data::transform_ops(),
        "audioFormats": crate::data::audio_formats(),
        "pinyin": crate::data::pinyin_summary(&st.root),
        // Cookie 打码后再给前端（见 mask_secrets）：这一份会进前端全局状态
        "config": mask_secrets(&cfg),
        "paths": {
            "root": st.root.to_string_lossy(),
            "outputDir": cfg.get("outputDir").cloned().unwrap_or(json!("")),
            "downloadDir": cfg.get("downloadDir").cloned().unwrap_or(json!("")),
            "toolsDir": st.tools_dir().to_string_lossy(),
        },
        "platform": crate::platform::node_platform_name(),
        // 安装版（Program Files）还是绿色版（解压即用）—— 界面给恢复提示时用得上
        "installed": st.installed,
    })))
}

/* ══════════════════════════════════ 文件系统 ══════════════════════════════════ */

pub async fn fs_roots() -> Json<Value> {
    Json(ok(json!({ "roots": crate::platform::fs_roots() })))
}

#[derive(serde::Deserialize)]
pub struct PathQuery {
    pub path: Option<String>,
    /// 只看这些扩展名（逗号分隔、不带点、大小写不敏感）；不传 = 全部文件
    pub exts: Option<String>,
    /// `files=0` 不返回文件列表 —— 选目录的场景用不上
    pub files: Option<String>,
}

pub async fn fs_list(
    State(st): State<Arc<AppState>>,
    Query(q): Query<PathQuery>,
) -> Result<Json<Value>, ApiError> {
    let requested = q.path.unwrap_or_else(|| {
        st.config_snapshot()
            .get("outputDir")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string()
    });
    if requested.is_empty() {
        return Err(ApiError::bad_request("缺少 path 参数"));
    }

    let want_files = q.files.as_deref() != Some("0");
    let exts = parse_exts(q.exts.as_deref());

    let target = PathBuf::from(&requested);
    if !target.exists() {
        // 目标不存在时返回它最近的已存在父目录
        let mut cur = target.clone();
        while !cur.exists() {
            match cur.parent() {
                Some(p) if p != cur => cur = p.to_path_buf(),
                _ => break,
            }
        }
        return Ok(Json(ok(json!({
            "path": crate::platform::clean_path(&cur),
            "requested": requested,
            "exists": false,
            "dirs": list_dirs(&cur),
            "files": files_json(&cur, want_files, &exts),
            "parent": parent_str(&cur),
        }))));
    }

    if !target.is_dir() {
        return Err(ApiError::bad_request("目标不是目录"));
    }

    let resolved = fs::canonicalize(&target).unwrap_or(target.clone());
    Ok(Json(ok(json!({
        "path": crate::platform::clean_path(&resolved),
        "exists": true,
        "dirs": list_dirs(&target),
        "files": files_json(&target, want_files, &exts),
        "parent": parent_str(&resolved),
    }))))
}

/// `?exts=mp3,wav,.FLAC` → `["mp3","wav","flac"]`（空 = 不过滤）
fn parse_exts(raw: Option<&str>) -> Vec<String> {
    raw.unwrap_or("")
        .split(',')
        .map(|s| s.trim().trim_start_matches('.').to_lowercase())
        .filter(|s| !s.is_empty())
        .collect()
}

fn files_json(dir: &Path, want: bool, exts: &[String]) -> Value {
    if want {
        json!(list_files(dir, exts))
    } else {
        json!([])
    }
}

/// 只列目录（不列文件），过滤掉系统目录，按名称排序 —— 和 Node 版一致
fn list_dirs(dir: &Path) -> Vec<Value> {
    let Ok(entries) = fs::read_dir(dir) else {
        return vec![];
    };
    let mut out: Vec<(String, String)> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_dir()).unwrap_or(false))
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            if name.starts_with('$') || name == "System Volume Information" {
                return None;
            }
            let full = e.path().to_string_lossy().to_string();
            Some((name, full))
        })
        .collect();

    /*
     * 排序：Node 版用的是 localeCompare(…, 'zh-CN')，按拼音排中文。
     * Rust 标准库没有 locale 感知的排序，这里退回「ASCII 不区分大小写 + 原序」。
     * 差异只在中文目录名的相互顺序上，功能不受影响。
     * ponytail: 要拼音排序就查 pinyin.json，为一个目录列表不值得。
     */
    out.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));

    out.into_iter()
        .map(|(name, path)| json!({ "name": name, "path": path }))
        .collect()
}

/// 列文件（`exts` 非空时只留这些扩展名）。排序与目录一致：名称不区分大小写。
fn list_files(dir: &Path, exts: &[String]) -> Vec<Value> {
    let Ok(entries) = fs::read_dir(dir) else {
        return vec![];
    };
    let mut out: Vec<(String, String, u64, String)> = entries
        .flatten()
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter(|e| !is_hidden_or_system(e))
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let ext = Path::new(&name)
                .extension()
                .map(|x| x.to_string_lossy().to_lowercase())
                .unwrap_or_default();
            if !exts.is_empty() && !exts.iter().any(|x| x == &ext) {
                return None;
            }
            let size = e.metadata().map(|m| m.len()).unwrap_or(0);
            Some((name, e.path().to_string_lossy().to_string(), size, ext))
        })
        .collect();

    out.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));

    out.into_iter()
        .map(|(name, path, size, ext)| json!({ "name": name, "path": path, "size": size, "ext": ext }))
        .collect()
}

/// 隐藏 / 系统文件不列出来（Windows 上看属性，其他平台只看名字）
fn is_hidden_or_system(e: &fs::DirEntry) -> bool {
    let name = e.file_name().to_string_lossy().to_string();
    if name.starts_with('.')
        || name.starts_with('$')
        || name == "System Volume Information"
        || name.eq_ignore_ascii_case("desktop.ini")
        || name.eq_ignore_ascii_case("thumbs.db")
    {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_HIDDEN: u32 = 0x2;
        const FILE_ATTRIBUTE_SYSTEM: u32 = 0x4;
        if let Ok(md) = e.metadata() {
            if md.file_attributes() & (FILE_ATTRIBUTE_HIDDEN | FILE_ATTRIBUTE_SYSTEM) != 0 {
                return true;
            }
        }
    }
    false
}

/// 父目录字符串。
/// 注意根目录的情况：Node 的 `dirname('C:\\')` 返回 `'C:\\'` 本身，
/// 而 Rust 的 `Path::parent()` 对根返回 None —— 这里要退回路径自身，否则前端
/// 拿到的 parent 是空串，目录选择器往上走一层就走不动了。
fn parent_str(p: &Path) -> String {
    match p.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => crate::platform::clean_path(parent),
        _ => crate::platform::clean_path(p),
    }
}

pub async fn fs_mkdir(Json(body): Json<Value>) -> Result<Json<Value>, ApiError> {
    let target = body.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if target.is_empty() {
        return Err(ApiError::bad_request("缺少路径"));
    }
    fs::create_dir_all(target).map_err(ApiError::from)?;
    let abs = fs::canonicalize(target).unwrap_or_else(|_| PathBuf::from(target));
    Ok(Json(ok(json!({ "path": crate::platform::clean_path(&abs) }))))
}

pub async fn fs_delete(Json(body): Json<Value>) -> Result<Json<Value>, ApiError> {
    let target = body.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if target.is_empty() {
        return Err(ApiError::bad_request("缺少路径"));
    }
    let p = PathBuf::from(target);
    if !p.exists() {
        return Err(ApiError::bad_request(format!("路径不存在：{target}")));
    }
    let trash = body.get("trash").and_then(|v| v.as_bool()).unwrap_or(false);
    if p.is_dir() {
        if trash {
            crate::platform::move_to_trash(&p).map_err(ApiError::from)?;
        } else {
            fs::remove_dir_all(&p).map_err(ApiError::from)?;
        }
    } else if trash {
        crate::platform::move_to_trash(&p).map_err(ApiError::from)?;
    } else {
        fs::remove_file(&p).map_err(ApiError::from)?;
    }
    Ok(Json(ok(json!({ "path": target }))))
}

/**
 * 打开一个本地路径**或一个 URL**。
 *
 * ⚠️ 这里以前只读 `path` 且要求路径存在，于是前端传 `{url}` 的调用**必然 400**
 * （`body["path"]` 是空串 → 「路径不存在：」）—— 界面上「在浏览器打开」这类按钮
 * 一直是坏的。旧前端（`app/web/js/views/` 下那几套，2026-10-02 已删）也全在传 `{url}`；
 * 现在的新前端有三处：`pages/Resources.tsx`、`pages/Video.tsx`、`pages/Audio.tsx`。
 *
 * 现在两种都收：`path`（要求存在）与 `url`（交给系统默认程序，不做存在性检查）。
 */
pub async fn fs_open(Json(body): Json<Value>) -> Result<Json<Value>, ApiError> {
    let path = body.get("path").and_then(|v| v.as_str()).unwrap_or("");
    let url = body.get("url").and_then(|v| v.as_str()).unwrap_or("");
    let target = if !path.is_empty() { path } else { url };
    if target.is_empty() {
        return Err(ApiError::bad_request("缺少 path 或 url"));
    }
    if crate::platform::looks_like_url(target) {
        crate::platform::open_url(target).map_err(ApiError::from)?;
        return Ok(Json(ok(json!({ "url": target }))));
    }
    if !Path::new(target).exists() {
        return Err(ApiError::bad_request(format!("路径不存在：{target}")));
    }
    crate::platform::open_path(target).map_err(ApiError::from)?;
    Ok(Json(ok(json!({ "path": target }))))
}

pub async fn fs_reveal(Json(body): Json<Value>) -> Result<Json<Value>, ApiError> {
    let target = body.get("path").and_then(|v| v.as_str()).unwrap_or("");
    if target.is_empty() || !Path::new(target).exists() {
        return Err(ApiError::bad_request(format!("路径不存在：{target}")));
    }
    let select = body.get("select").and_then(|v| v.as_bool()).unwrap_or(true);
    crate::platform::reveal_in_explorer(target, select).map_err(ApiError::from)?;
    Ok(Json(ok(json!({ "path": target }))))
}

/* ══════════════════════════════════ 写文件（文字 PV 导出用）══════════════════════════════════ */

/*
 * `POST /api/pv/save?dir=<目录>&name=<文件名>&part=<第几块>`
 *
 * 存在的理由：JIZURA 导出 MP4 走的是浏览器下载（blob + `<a download>`），
 * 在 Tauri 的 WebView2 里只能落到系统下载目录，用户没得选。我们拦下那次保存，
 * 让用户选目录，再把字节交给后端写盘 —— 所以需要一条「写任意二进制」的接口。
 *
 * 为什么是**裸字节 + 分块**，而不是 JSON 里塞 base64：
 *   4K 的 MP4 有几百 MB，base64 要膨胀 33%，还得在内存里多存一份；
 *   浏览器为了编出 base64 字符串本身又要多占一份。分块之后峰值内存只有一块的大小
 *   （路由上挂了 16MB 的 body 上限，前端按 8MB 切），与成片大小无关。
 *
 * 路径安全：`dir` 必须已经存在且是目录（**不自动创建**，免得手滑把文件写到
 * 半截路径下），`name` 只取最后一段并过滤非法字符，同名文件不覆盖而是自动加 (1)(2)…
 */

/// 单块上限 16MB；前端按 8MB 切，留一倍余量。
pub const PV_CHUNK_LIMIT: usize = 16 * 1024 * 1024;

/// 工程文件上传的上限（`convert/run-upload` / `convert/preview-upload`）。
///
/// axum 的默认 body 上限是 **2MB**，而拖进来的工程是 base64 编码的（体积 ×1.34）——
/// 一个 2MB 的 .svp 就会被 413 挡掉。这里给到 96MB（≈ 单个 70MB 的工程），
/// 够装下实测最大的工程（2.3MB）几十倍。
/// ⚠️ 改这个值时要同时看前端：`Convert.tsx` 里拖入文件前会按同一量级提示太大。
pub const CONVERT_UPLOAD_LIMIT: usize = 96 * 1024 * 1024;

#[derive(serde::Deserialize)]
pub struct SaveQuery {
    pub dir: Option<String>,
    pub name: Option<String>,
    /// 第几块（从 0 开始）。0 是**新建**（同名自动改名），之后是追加。
    pub part: Option<u32>,
}

/// 文件名只保留最后一段，并清掉 Windows 不允许、或者能改变路径含义的字符。
///
/// 不这样做的话 `name=..\..\Windows\System32\x.dll` 就能写到任意位置。
fn safe_file_name(raw: &str) -> String {
    let last = raw
        .rsplit(['\\', '/'])
        .find(|s| !s.trim().is_empty())
        .unwrap_or("");
    let cleaned: String = last
        .chars()
        .map(|c| if c.is_control() || "<>:\"/\\|?*".contains(c) { '_' } else { c })
        .collect();
    let trimmed = cleaned.trim().trim_matches('.').trim();
    if trimmed.is_empty() { "未命名".to_string() } else { trimmed.to_string() }
}

/// 目标文件。`part > 0` 时沿用已存在的那个（追加），否则挑一个不重名的。
fn target_file(dir: &Path, name: &str, part: u32) -> PathBuf {
    let first = dir.join(name);
    if part > 0 {
        return first;
    }
    if !first.exists() {
        return first;
    }
    let p = Path::new(name);
    let stem = p.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_else(|| "未命名".into());
    let ext = p.extension().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    for n in 1..10000 {
        let cand = if ext.is_empty() {
            dir.join(format!("{stem} ({n})"))
        } else {
            dir.join(format!("{stem} ({n}).{ext}"))
        };
        if !cand.exists() {
            return cand;
        }
    }
    first
}

pub async fn pv_save(
    Query(q): Query<SaveQuery>,
    body: axum::body::Bytes,
) -> Result<Json<Value>, ApiError> {
    use std::io::Write;

    let dir = q.dir.unwrap_or_default();
    if dir.trim().is_empty() {
        return Err(ApiError::bad_request("缺少保存目录"));
    }
    let dir_path = PathBuf::from(dir.trim());
    if !dir_path.is_dir() {
        return Err(ApiError::bad_request(format!("目录不存在：{}", dir_path.display())));
    }

    let name = safe_file_name(&q.name.unwrap_or_default());
    let part = q.part.unwrap_or(0);
    let path = target_file(&dir_path, &name, part);

    // 0 号块新建（同名已经改成不重名的那个），之后的块追加
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .append(part > 0)
        .write(true)
        .truncate(part == 0)
        .open(&path)
        .map_err(ApiError::from)?;
    file.write_all(&body).map_err(ApiError::from)?;
    drop(file);

    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    Ok(Json(ok(json!({
        "path": crate::platform::clean_path(&path),
        "name": path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or(name),
        "size": size,
        "part": part,
    }))))
}

/* ══════════════════════════════════ 任务 ══════════════════════════════════ */

/// 任务表
///
/// `tx` 是给 SSE 用的广播通道：任何任务状态变化都往里发一份完整快照，
/// `/api/jobs/{id}/stream` 订阅它、按 id 过滤、推给前端。
///
/// 用**一个全局广播**而不是「每个任务一个通道」：任务数少、订阅者更少，
/// 按 id 过滤的代价可以忽略，换来的是不用维护通道的创建与销毁。
pub struct JobTable {
    pub items: BTreeMap<String, Value>,
    pub seq: u64,
    pub tx: tokio::sync::broadcast::Sender<Value>,
}

impl Default for JobTable {
    fn default() -> Self {
        // 容量 256：进度更新很密（每次 set 都发一条），订阅者偶尔卡顿也不该丢消息。
        // 真丢了也只是少刷一次，因为推的是完整快照而不是增量。
        let (tx, _) = tokio::sync::broadcast::channel(256);
        Self { items: BTreeMap::new(), seq: 0, tx }
    }
}

impl JobTable {
    /// 广播一份任务快照
    pub fn publish(&self, job: &Value) {
        let _ = self.tx.send(job.clone());
    }
}

pub async fn jobs_list(State(st): State<Arc<AppState>>) -> Json<Value> {
    let guard = st.jobs.lock().unwrap();
    let list: Vec<Value> = guard
        .items
        .values()
        .map(|j| {
            json!({
                "id": j.get("id"),
                "type": j.get("type"),
                "title": j.get("title"),
                "status": j.get("status"),
                "percent": j.get("percent"),
                "message": j.get("message"),
                "createdAt": j.get("createdAt"),
            })
        })
        .collect();
    Json(ok(json!({ "jobs": list })))
}

pub async fn jobs_get(
    State(st): State<Arc<AppState>>,
    Query(q): Query<JobQuery>,
) -> Result<Json<Value>, ApiError> {
    let id = q.id.as_deref().unwrap_or("");
    let guard = st.jobs.lock().unwrap();
    let job = guard
        .items
        .get(id)
        .cloned()
        .ok_or_else(|| ApiError::bad_request("任务不存在"))?;
    Ok(Json(ok(json!({ "job": job }))))
}

#[derive(serde::Deserialize)]
pub struct JobQuery {
    #[serde(default)]
    pub id: Option<String>,
}

pub async fn jobs_cancel(
    State(st): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    /*
     * 真正把任务标成 canceled：长任务（下载 / 音频处理）在循环里读这个状态，
     * 读到就中断并掐掉子进程。没有额外的取消通道 —— 任务表本身就是通道。
     */
    let id = body.get("id").and_then(|v| v.as_str()).unwrap_or("");
    let mut guard = st.jobs.lock().unwrap();
    let job = guard
        .items
        .get_mut(id)
        .ok_or_else(|| ApiError::internal("任务不存在"))?;
    let status = job.get("status").and_then(|v| v.as_str()).unwrap_or("");
    if !matches!(status, "done" | "error" | "canceled") {
        if let Some(m) = job.as_object_mut() {
            m.insert("status".into(), json!("canceled"));
            m.insert("message".into(), json!("已取消"));
        }
    }
    Ok(Json(ok(json!({ "job": job.clone() }))))
}

/// 任务进度推送（SSE）。
///
/// 前端用 `new EventSource('/api/jobs/{id}/stream')` 订阅 —— **注意 id 在路径里**，
/// 不是查询参数。早先这里注册成 `/api/jobs/stream` 导致前端 404、进度条不动。
///
/// 协议和 Node 版一致：
///   - 连上先推一份当前快照（前端不必再单独请求一次）
///   - 之后每次状态变化推一份完整快照（不是增量，丢一条也不会错位）
///   - 状态变成 done/error/canceled 后推完最后一条就结束
///   - 15 秒一次心跳注释行，防止中间层掐掉空闲连接
pub async fn jobs_stream(
    State(st): State<Arc<AppState>>,
    axum::extract::Path(id): axum::extract::Path<String>,
) -> Result<
    axum::response::Sse<
        impl futures_util::Stream<Item = Result<axum::response::sse::Event, std::convert::Infallible>>,
    >,
    ApiError,
> {
    use axum::response::sse::{Event, KeepAlive};
    use std::convert::Infallible;

    let (initial, rx) = {
        let guard = st.jobs.lock().unwrap();
        let job = guard
            .items
            .get(&id)
            .cloned()
            .ok_or_else(|| ApiError::not_found("任务不存在"))?;
        // 先订阅再放开锁 —— 顺序反过来的话，两次之间的更新会丢
        (job, guard.tx.subscribe())
    };

    let stream = futures_util::stream::unfold(
        (rx, Some(initial), false),
        move |(mut rx, pending, done)| {
            let id = id.clone();
            async move {
                if done {
                    return None;
                }
                // 第一条：订阅前的当前快照
                if let Some(v) = pending {
                    let terminal = is_terminal(&v);
                    let ev = Event::default().data(v.to_string());
                    return Some((Ok::<_, Infallible>(ev), (rx, None, terminal)));
                }
                // 之后：等其他任务的消息，按 id 过滤
                loop {
                    match rx.recv().await {
                        Ok(v) => {
                            if v.get("id").and_then(|x| x.as_str()) != Some(id.as_str()) {
                                continue;
                            }
                            let terminal = is_terminal(&v);
                            let ev = Event::default().data(v.to_string());
                            return Some((Ok::<_, Infallible>(ev), (rx, None, terminal)));
                        }
                        // 订阅者跟不上被丢了消息：不是错误，继续等下一批
                        Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                        Err(_) => return None,
                    }
                }
            }
        },
    );

    Ok(axum::response::Sse::new(stream)
        .keep_alive(KeepAlive::new().interval(std::time::Duration::from_secs(15))))
}

/// 任务是否已到终态（到了就该结束 SSE 连接）
fn is_terminal(job: &Value) -> bool {
    matches!(
        job.get("status").and_then(|s| s.as_str()),
        Some("done") | Some("error") | Some("canceled")
    )
}

/* ══════════════════════════════════ 资源库 ══════════════════════════════════ */

pub async fn resources(State(st): State<Arc<AppState>>) -> Result<Json<Value>, ApiError> {
    let path = st.data_dir().join("resources.json");
    let text = fs::read_to_string(&path).map_err(ApiError::from)?;
    let data: Value = serde_json::from_str(&text)
        .map_err(|e| ApiError::bad_request(format!("resources.json 解析失败：{e}")))?;
    Ok(Json(ok(json!({
        "version": data.get("version").cloned().unwrap_or(json!(1)),
        "updatedAt": data.get("updatedAt").cloned().unwrap_or(json!("")),
        "notice": data.get("notice").cloned().unwrap_or(json!("")),
        "groups": data.get("groups").cloned().unwrap_or(json!([])),
        "verifySummary": data.get("verifySummary").cloned().unwrap_or(json!({})),
    }))))
}

pub async fn resources_check() -> Json<Value> {
    // 阶段 3 接上真实链接检查（需要 HTTP 客户端）
    Json(ok(json!({ "results": [], "pending": true })))
}

/* ══════════════════════════════════ 本地媒体文件 ══════════════════════════════════ */

/// 把本机的一个媒体文件原样吐给前端。
///
/// 为什么需要它：浏览器里的 `<audio>` 和 `AudioContext.decodeAudioData` 都只能吃
/// URL，不能直接读本地路径 —— 没有这个路由，音频页就没法试听、也画不出波形。
///
/// **支持 Range 请求**：播放器要靠它才能拖动进度条跳到任意位置。
/// 不支持 Range 的话，只能从头听，拖一下就断。
pub async fn fs_raw(
    Query(q): Query<PathQuery>,
    headers: axum::http::HeaderMap,
) -> Response {
    let Some(target) = q.path.as_deref().filter(|p| !p.is_empty()) else {
        return (StatusCode::BAD_REQUEST, "缺少 path 参数").into_response();
    };

    /*
     * 跨源防护。
     *
     * 这是一个只监听 127.0.0.1 的本地服务，但这个路由会**读任意本地文件的内容** ——
     * 比同目录下那些「列目录」「用资源管理器打开」的路由危险得多：
     * 恶意网页只要知道端口，就能 fetch 到你的文件。
     *
     * 浏览器发起跨源请求时一定会带 Origin，而本应用自己的页面是同源（不带 Origin，
     * 或者带的就是自己）。所以「带了 Origin 且不是自己」一律拒绝。
     */
    if let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) {
        let host = headers.get(header::HOST).and_then(|v| v.to_str().ok()).unwrap_or("");
        if !host.is_empty() && !origin.ends_with(host) {
            return (StatusCode::FORBIDDEN, "拒绝跨源读取本地文件").into_response();
        }
    }

    let path = PathBuf::from(target);
    if !path.is_file() {
        return (StatusCode::NOT_FOUND, "文件不存在").into_response();
    }

    let Ok(meta) = fs::metadata(&path) else {
        return (StatusCode::INTERNAL_SERVER_ERROR, "读不到文件信息").into_response();
    };
    let total = meta.len();
    let mime = media_mime_of(&path);

    // ── Range 请求：只回请求的那一段 ──
    if let Some(range) = headers.get(header::RANGE).and_then(|v| v.to_str().ok()) {
        let Some((start, end)) = parse_range(range, total) else {
            return (
                StatusCode::RANGE_NOT_SATISFIABLE,
                [(header::CONTENT_RANGE, format!("bytes */{total}"))],
                "",
            )
                .into_response();
        };

        use std::io::{Read, Seek, SeekFrom};
        let Ok(mut f) = fs::File::open(&path) else {
            return (StatusCode::INTERNAL_SERVER_ERROR, "打开文件失败").into_response();
        };
        if f.seek(SeekFrom::Start(start)).is_err() {
            return (StatusCode::INTERNAL_SERVER_ERROR, "定位失败").into_response();
        }
        let len = (end - start + 1) as usize;
        let mut buf = vec![0u8; len];
        if f.read_exact(&mut buf).is_err() {
            return (StatusCode::INTERNAL_SERVER_ERROR, "读取失败").into_response();
        }

        return (
            StatusCode::PARTIAL_CONTENT,
            [
                (header::CONTENT_TYPE, mime.to_string()),
                (header::ACCEPT_RANGES, "bytes".to_string()),
                (header::CONTENT_RANGE, format!("bytes {start}-{end}/{total}")),
                (header::CONTENT_LENGTH, len.to_string()),
            ],
            Body::from(buf),
        )
            .into_response();
    }

    // ── 整文件 ──
    match fs::read(&path) {
        Ok(bytes) => (
            StatusCode::OK,
            [
                (header::CONTENT_TYPE, mime.to_string()),
                (header::ACCEPT_RANGES, "bytes".to_string()),
                (header::CONTENT_LENGTH, total.to_string()),
            ],
            Body::from(bytes),
        )
            .into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, e.to_string()).into_response(),
    }
}

/// 解析 `bytes=start-end`。end 可以省略（表示到文件末尾）。
/// 返回闭区间的 (start, end)。
fn parse_range(header: &str, total: u64) -> Option<(u64, u64)> {
    let spec = header.strip_prefix("bytes=")?;
    // 只处理单段请求；多段（逗号分隔）在实际使用里见不到，遇到了就当整文件
    let (a, b) = spec.split_once('-')?;
    if total == 0 {
        return None;
    }

    if a.is_empty() {
        // `bytes=-N`：最后 N 字节
        let n: u64 = b.trim().parse().ok()?;
        if n == 0 {
            return None;
        }
        return Some((total.saturating_sub(n), total - 1));
    }

    let start: u64 = a.trim().parse().ok()?;
    if start >= total {
        return None;
    }
    let end = if b.trim().is_empty() {
        total - 1
    } else {
        b.trim().parse::<u64>().ok()?.min(total - 1)
    };
    if end < start {
        return None;
    }
    Some((start, end))
}

/// 媒体文件类型。波形和试听都靠它 —— 浏览器只认对类型才肯解码。
fn media_mime_of(p: &Path) -> &'static str {
    match p.extension().and_then(|e| e.to_str()).map(|s| s.to_lowercase()).as_deref() {
        Some("wav") => "audio/wav",
        Some("mp3") => "audio/mpeg",
        Some("flac") => "audio/flac",
        Some("m4a") | Some("aac") => "audio/mp4",
        Some("ogg") | Some("opus") => "audio/ogg",
        Some("mp4") => "video/mp4",
        Some("webm") => "video/webm",
        Some("mkv") => "video/x-matroska",
        _ => "application/octet-stream",
    }
}

/* ══════════════════════════════════ 静态文件 ══════════════════════════════════ */

/// 前端静态文件。/api/* 之外的所有请求都走这里。
pub async fn static_files(State(st): State<Arc<AppState>>, req: axum::extract::Request) -> Response {
    let rel = req.uri().path().trim_start_matches('/');
    let rel = if rel.is_empty() { "index.html" } else { rel };
    let web = st.web_dir();
    let mut target = web.join(rel);

    // 目录要回退到它下面的 index.html。
    //
    // 界面只有一个入口（`/`，由 `rel.is_empty()` 那条兜住），但静态资源目录不止一个：
    // `/vendor/jizura/` 之类带尾斜杠的请求，rel 是 "vendor/jizura/"，直接 fs::read 一个
    // 目录会失败 —— 表现就是 404。这里补上目录回退，顺带对无尾斜杠的写法也成立。
    if target.is_dir() {
        target = target.join("index.html");
    }

    // 目录穿越防护：规范化后必须仍在 web 目录内
    let ok_path = match fs::canonicalize(&target) {
        Ok(p) => p.starts_with(fs::canonicalize(&web).unwrap_or(web.clone())),
        Err(_) => false,
    };
    if !ok_path {
        return (StatusCode::NOT_FOUND, "Not Found").into_response();
    }

    let Ok(bytes) = fs::read(&target) else {
        return (StatusCode::NOT_FOUND, "Not Found").into_response();
    };
    let mime = mime_of(&target);
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, mime),
            // **必须显式禁用缓存。**
            //
            // 这是踩过的坑：原来这里一个缓存头都不发，WebView2 就按启发式规则
            // 把 css/js 缓存起来 —— 于是「改了界面但用户看不到变化」，
            // 而且极难排查：我们测试用的是每次全新的无头浏览器，永远命中不了缓存，
            // 本地怎么验都是新的，只有用户的常驻 WebView2 拿着旧文件。
            //
            // 这个服务每请求都从磁盘 fs::read 一遍，禁缓存不增加任何成本。
            (header::CACHE_CONTROL, "no-store, must-revalidate"),
            (header::PRAGMA, "no-cache"),
            (header::EXPIRES, "0"),
        ],
        Body::from(bytes),
    )
        .into_response()
}

fn mime_of(p: &Path) -> &'static str {
    // 表里没有的扩展名会落到 `application/octet-stream`。这不会让请求失败，
    // 但浏览器要嗅探内容才肯用（图片尤其）：实测两张背景图 `/img/bg/*.jpg`
    // 就是这样回的 octet-stream。凡是 `app/web/` 里真实存在的类型都补齐，
    // 现在那里的扩展名只有 woff2 / css / html / jpg / png / js 六种。
    match p.extension().and_then(|e| e.to_str()).unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "gif" => "image/gif",
        "ico" => "image/x-icon",
        "woff2" => "font/woff2",
        "woff" => "font/woff",
        "ttf" => "font/ttf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "mp4" => "video/mp4",
        "txt" => "text/plain; charset=utf-8",
        "map" => "application/json; charset=utf-8",
        _ => "application/octet-stream",
    }
}

/* ══════════════════════════════════ 错误处理 ══════════════════════════════════ */

/// 统一错误响应：形状和 Node 版一致（`{ok:false, error:"..."}`），
/// 前端 api.js 读的就是 error 字段
pub struct ApiError {
    status: StatusCode,
    message: String,
}

impl ApiError {
    pub fn bad_request(msg: impl Into<String>) -> Self {
        Self { status: StatusCode::BAD_REQUEST, message: msg.into() }
    }
    pub fn not_found(msg: impl Into<String>) -> Self {
        Self { status: StatusCode::NOT_FOUND, message: msg.into() }
    }
    pub fn internal(msg: impl Into<String>) -> Self {
        Self { status: StatusCode::INTERNAL_SERVER_ERROR, message: msg.into() }
    }
}

impl From<std::io::Error> for ApiError {
    fn from(e: std::io::Error) -> Self {
        Self::internal(e.to_string())
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut m = Map::new();
        m.insert("ok".into(), Value::Bool(false));
        m.insert("error".into(), Value::String(self.message));
        // Node 版的 sendError 一定会带 code（没有就是 null），前端 api.js 也会读它
        m.insert("code".into(), Value::Null);
        (self.status, Json(Value::Object(m))).into_response()
    }
}

/* ══════════════════════════════════ 小工具 ══════════════════════════════════ */

/// Windows 上起一个不弹窗的子进程
pub fn quiet_command(program: &str) -> Command {
    let mut c = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        c.creation_flags(CREATE_NO_WINDOW);
    }
    c
}
