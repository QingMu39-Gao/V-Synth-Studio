//! 配置文件的读写 —— **用户偏好的唯一真相**。默认值表、路径、落盘都在
//! 这里；这一份不认识 IPC，业务逻辑也不在别处再实现一遍。
//!
//! 两个形态共用一套代码，差别只在 `writable` 指向哪：
//!   * **绿色版**：`<根>/data/config.json`（整个目录可以拷着走）
//!   * **安装版**：`%APPDATA%\com.qingmu.vocalworkstation\config.json`
//!     （Program Files 只读，写那儿要管理员权限）
//! 判据是「能不能写」，见 `lib.rs::resolve_paths`。

use std::path::{Path, PathBuf};

use serde_json::{Value, json};

/// 对外显示的版本号 —— **`src-tauri/Cargo.toml` 的 `version` 是唯一真源**。
///
/// 显示值 = `Cargo.toml` 的版本 + `beta`。后缀只能加在**这里**：
/// Windows Installer 的 `ProductVersion` 只吃纯数字 `x.y.z`，所以 `Cargo.toml`
/// 必须是纯数字，而界面显示与安装包文件名要的是 `1.4.0beta`（文件名那半在
/// CI 里补，见 `tools/rename-bundles-beta.mjs`）。
///
/// ⚠️ **别把整个版本号写成字面量**：那样版本号散成多份、每份都要人记住同步，
/// 而漏掉任何一处的后果都不一样（界面显示的版本、Cargo.lock 与 Cargo.toml 的
/// 一致性、MSI 文件名与安装记录）。真源只有一处：`Cargo.toml`。另外两处也让它自己去取：
///   · `tauri.conf.json` **不写 `version`** —— 不写时 Tauri 用 `Cargo.toml` 的值
///   · `package.json` 的 `version` 与程序版本无关（Tauri 不读它），只跟 npm 惯例
pub const APP_VERSION: &str = concat!(env!("CARGO_PKG_VERSION"), "beta");

/// 作者标识。出现在「关于」里，也散落在源码注释中作为出处水印。
pub const AUTHOR_TAG: &str = "QingMu39";

/// 「关于」里那行运行环境，例如 `Windows (x86_64)`。
pub fn platform_desc() -> String {
    format!(
        "{} ({})",
        crate::platform::node_platform_name(),
        std::env::consts::ARCH
    )
}

pub fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 配置默认值。
///
/// ⚠️ **只有这里列出来的键会被 `load_config` 认**（它按默认值的键逐个取）。
/// 也就是说：**删掉一个键 = 老用户配置里的残留会在下次 `save_config` 整份回写时被清掉**
/// —— 这是有意的。反过来，加键一定要在这里加，
/// 不然前端存进去的值下次启动就没了。
pub fn default_config() -> Value {
    json!({
        "theme": "system",
        /* 界面语言（`lib/i18n.ts` 的 `setUiLanguage` 存这一项）。
           ⚠️ 它必须列在这里：没列出来的键 `load_config` 会当成不认识的过滤掉，
           表现就是「切成英文、重启又回中文」，而且不报错。 */
        "language": "zh-CN",
        "glassLevel": 2,
        "outputDir": "",
        "downloadDir": "",
        "bilibiliCookie": "",
        "neteaseCookie": "",
        "neteaseCookieExpire": 0,
        "proxy": "",
        /* ── 下面这几项后端不读，但**必须在这儿列出来** ──────────────────────
         *
         * 它们是前端页面自己的设置。为什么不列不行：`load_config` 只认**默认值里
         * 有的键**（见上面那条注释），所以没列出来的键就算 `set_config` 写进了盘，
         * 下次启动也会被过滤掉 —— 表现是「设置改了、重启就没了」，而且不报任何错。
         *
         * 也就是说：**前端每多存一项设置，这里就要多一个键。** */
        "audio": {},
        "video": {},
        "convert": {},
        // 歌词页 → 文字 PV 页的交接
        "pvPendingLyrics": "",
        "pvSentLyrics": "",
        // 人声转 MIDI 的输出目录
        "midiOutDir": "",
        /* 音轨分离运行时的落点（空 = 跟着扩展包目录走）。
           为什么要给用户选：那一坨 4.7 GB / 解压后 7.4 GB，装在 C 盘紧张的人身上是灾难；
           而安装版默认落在 Program Files 下**根本写不进去**。
           ⚠️ 这是**老的**单独落点，新装的一律用 `extDir`（见下）；它还在是因为老用户
           的配置里可能已经填了一个自定义路径，丢掉它等于把那 7.4 GB 判成「没装」。 */
        "svsepRuntimeDir": "",
        /* 扩展包目录（空 = 可写目录）。音轨分离的运行时 / 模型、人声转 MIDI 的 GAME 模型
           全部落在它下面，合计约 8 GB。用户换一块盘就改这一项 —— 这也是「下载时让用户
           选位置」那一问的落点：选完写在这里，之后再下别的包不再问。
           ⚠️ 空串与填了路径**行为不同**：空 = 可写目录（绿色版 `<root>/data`、
           安装版 `%APPDATA%`，也就是老行为），所以老用户的文件一个都不用搬。 */
        "extDir": "",
        /* 背景壁纸（背景层）：
             `""`            静态图（默认，就是 `public/img/bg/` 那两张）
             `"we:current"`  跟随 Wallpaper Engine 当前正在用的那张
             `"we:<id>"`     固定用库里某一张（id 是工坊 id 或项目目录名）
           `wallpaperPaused` 暂停动画（壁纸那层停帧，静态图照常）——性能不好时的一键开关。
           `weDir` 手动指定的 Wallpaper Engine 目录（自动找不到时才需要）。 */
        "wallpaper": "",
        "wallpaperPaused": false,
        "weDir": "",
        /* 显卡加速（DirectML）**没有开关**：它由推理方式推出来
           （`svsep::apply_infer_mode`），两者本来就是一件事。这里只留一个说明，
           别再加 `svsepDml` / `svsepDmlSix` 那种键 —— 多一个键就多一处要同步的判据。 */
    })
}

fn config_path(writable: &Path) -> PathBuf {
    writable.join("config.json")
}

/// 读配置。
///
/// 读不到 / 解析失败都回默认值（**不是错误**：装完第一次跑就没有这个文件）。
/// 但解析失败要记一行日志 —— 用户手改坏了 JSON 时，那句「已回落默认值」是唯一的线索。
pub fn load_config(writable: &Path) -> Value {
    let mut base = default_config();
    match std::fs::read_to_string(config_path(writable)) {
        Ok(text) => match serde_json::from_str::<Value>(&text) {
            Ok(saved) => {
                if let (Some(dst), Some(src)) = (base.as_object_mut(), saved.as_object()) {
                    for (k, v) in src {
                        /* 只认默认值里有的键（见 `default_config` 的注释） */
                        if dst.contains_key(k) {
                            dst.insert(k.clone(), v.clone());
                        }
                    }
                }
            }
            Err(e) => crate::log_line(&format!(
                "配置读取失败，已回落默认值：{} —— {e}。请检查这个文件是不是合法 JSON。",
                config_path(writable).display()
            )),
        },
        Err(_) => { /* 首次运行：没有配置文件是正常的 */ }
    }
    base
}

/// 落盘。父目录不存在会先建出来（首次运行安装版就是这样）。
///
/// 先写 `config.json.tmp` 再改名：`std::fs::write` 是「先截断再写」，中途断电或被杀会
/// 留下半个 JSON，而 `load_config` 对解析失败是**整份回落默认值** —— 设置和 Cookie 会
/// 静默全丢。改名会替换已存在的目标（Unix rename / Windows MoveFileExW），tmp 与目标
/// 同目录，不跨文件系统。
pub fn save_config(writable: &Path, cfg: &Value) -> std::io::Result<()> {
    let p = config_path(writable);
    if let Some(dir) = p.parent() {
        std::fs::create_dir_all(dir)?;
    }
    // 序列化失败不能落个空文件出去：那正好是「整份回落默认值」的那种损坏
    let text = serde_json::to_string_pretty(cfg)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let tmp = p.with_file_name("config.json.tmp");
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, &p)
}

/// Cookie 类配置回显时的占位串。前端认它：看到「已设置」就只当有值，不会把它提交回来。
pub const MASKED: &str = "已设置";

/// 把 Cookie 的值换成「已设置」再回给前端。
///
/// 为什么：`get_config` 与 `get_state` 的结果会进前端全局状态，也常被贴进截图或日志，
/// 而 Cookie 就是账号登录态 —— 回显真值等于把账号摊开。前端把占位串原样提交回来时
/// `ipc::config::set_config` 会跳过它，所以不会出现「真值被占位串覆盖」这种反向事故。
pub fn mask_secrets(cfg: &Value) -> Value {
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

#[cfg(test)]
mod tests {
    /// 版本号的唯一真源是 `Cargo.toml`，且它必须是纯数字 `x.y.z`。
    ///
    /// 前两条断言拦的是「版本号写成字面量」与「往 Cargo.toml 里塞 prerelease」——
    /// Windows Installer 的 `ProductVersion` 不吃后缀，塞了要到打包那一刻才炸。
    /// 第三条拦的是「忘了拼 beta」：界面显示的版本与安装包文件名会各说各话。
    ///
    /// ⚠️ 别改成「断言等于某个具体版本号」：那样每次发版都要改测试，
    /// 而**改测试比改代码更容易顺手做错**（把测试改成迁就代码）。
    #[test]
    fn displayed_version_is_the_manifest_version_plus_beta() {
        let manifest = env!("CARGO_PKG_VERSION");
        let parts: Vec<&str> = manifest.split('.').collect();
        assert_eq!(
            parts.len(),
            3,
            "Cargo.toml 的 version 必须是 x.y.z：{manifest}"
        );
        assert!(
            parts
                .iter()
                .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit())),
            "Cargo.toml 的 version 只能是纯数字（MSI 的 ProductVersion 不吃 prerelease）：{manifest}"
        );
        assert_eq!(
            super::APP_VERSION,
            format!("{manifest}beta"),
            "对外显示的版本号必须是 Cargo.toml 的版本加 beta"
        );
    }

    /// `tauri.conf.json` 里不该再有 `version`。
    ///
    /// 不写时 Tauri 自己用 `Cargo.toml` 的值；一旦写上就有了两个互相看不见的真源 ——
    /// 而打包不会报错，只会让**界面上显示的版本**与**安装记录的版本**不一致。
    #[test]
    fn tauri_config_has_no_version() {
        let conf = include_str!("../../tauri.conf.json");
        let v: serde_json::Value =
            serde_json::from_str(conf).expect("tauri.conf.json 不是合法 JSON");
        assert!(
            v.get("version").is_none(),
            "tauri.conf.json 里又出现 version 了 —— 删掉它，让 Tauri 用 Cargo.toml 的。\n\
             现在它是：{:?}",
            v.get("version")
        );
    }
}
