//! 配置 —— **用户偏好的唯一持久化载体**。
//!
//! 只有一份真相：`config.json`（绿色版 `<根>/data/`，安装版
//! `%APPDATA%\com.qingmu.vocalworkstation\`）。前端启动时一次 `get_config` 拉全量，
//! 改动走 `set_config` 做局部更新。**端口、origin、WebView2 的存储目录都不影响它。**
//!
//! ⚠️ Cookie 类的值**回显时打码**（`config_file::mask_secrets`）：
//! 这份数据会进前端全局状态、也常被贴进截图或日志，而它就是账号登录态。
//! 前端把打码后的占位串原样提交回来时，`set_config` 会跳过它 —— 不会出现
//! 「真值被占位串覆盖」这种反向事故。

use serde_json::{Value, json};

use super::Cmd;

/// 读全量配置。Cookie 已打码。
#[tauri::command]
pub async fn get_config(st: super::St<'_>) -> Cmd {
    let cfg = st.config_snapshot();
    Ok(json!({ "config": super::config_file::mask_secrets(&cfg) }))
}

/// 盘上那份网易云 Cookie 若是脏的（带空白 / 换行），就地洗干净并落盘一次。
///
/// 返回**是否改过**。清洁的值（含空串）不动盘：这条会跟着每次 `AppState::new` 跑。
pub(crate) fn normalize_netease_cookie(cfg: &mut Value) -> bool {
    let Some(raw) = cfg.get("neteaseCookie").and_then(|v| v.as_str()) else {
        return false;
    };
    let Ok(clean) = crate::lyrics::clean_cookie(raw) else {
        // 洗不出来的脏值**不清空**：那可能是用户手写的、我们看不懂的东西，
        // 静默丢掉比留着更糟（`set_config` 会在用户下次保存时明确报错）
        return false;
    };
    if clean == raw {
        return false;
    }
    if let Some(map) = cfg.as_object_mut() {
        map.insert("neteaseCookie".into(), json!(clean));
    }
    true
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    /// 老版本会把用户粘贴的原文（可能每个字符一行）原样写进 `config.json`，
    /// 那时它当 `Cookie` 头发不出去，而界面上只显示「已设置」。启动时那次读盘要把它
    /// 就地洗干净，且**只有真的脏了才写盘** —— 否则每次启动都多一次无谓的磁盘写。
    #[test]
    fn a_dirty_stored_cookie_is_folded_once_at_load() {
        // 开发者工具里「每行一对键值」的粘贴：行尾带分号，换行要折成空格
        let mut cfg = json!({ "neteaseCookie": "MUSIC_U=abc;\n__csrf=def;\n", "theme": "dark" });
        assert!(normalize_netease_cookie(&mut cfg), "脏值该被洗掉");
        assert_eq!(cfg["neteaseCookie"], json!("MUSIC_U=abc; __csrf=def"));
        assert!(
            !normalize_netease_cookie(&mut cfg),
            "洗过之后再读一次不该再改"
        );

        /* 没有分号、只有换行的那份**只能折成空格**：`MUSIC_U=abc\n__csrf=def` 无从判断
        是「两对键值」还是「一个值里带空白」，猜错会把真值切坏。这条断言是给以后
        想「顺手按换行再拆一次」的人看的：不许拆。 */
        let mut no_semicolon = json!({ "neteaseCookie": "MUSIC_U=abc\n__csrf=def" });
        assert!(normalize_netease_cookie(&mut no_semicolon));
        assert_eq!(
            no_semicolon["neteaseCookie"],
            json!("MUSIC_U=abc __csrf=def")
        );

        // 干净的值（含空串）与「没有这个键」都不动
        let mut clean = json!({ "neteaseCookie": "MUSIC_U=abc" });
        assert!(!normalize_netease_cookie(&mut clean));
        let mut empty = json!({ "neteaseCookie": "" });
        assert!(!normalize_netease_cookie(&mut empty));
        let mut missing = json!({ "theme": "dark" });
        assert!(!normalize_netease_cookie(&mut missing));
        // 认不出形状的脏值原样留着：宁可让它继续脏，也不要静默清掉用户的凭据
        let mut garbage = json!({ "neteaseCookie": "=没有键名" });
        assert!(!normalize_netease_cookie(&mut garbage));
        assert_eq!(garbage["neteaseCookie"], json!("=没有键名"));
    }
}

/// 局部更新配置（只传要改的键）。
///
/// 回的是**更新后的完整配置**（同样打码）—— 前端拿它直接替换本地那份，
/// 不用再补一次 `get_config`。
#[tauri::command]
pub async fn set_config(st: super::St<'_>, patch: Value) -> Cmd {
    set_config_inner(&st, patch)
}

/// 把这些设置并进 `config.json`。`old` 的形状：`{ "qingmu.theme": "dark", … }`
/// （原样搬 localStorage 的键值对，**映射到配置键的规则写在 `LEGACY_KEYS` 里**
/// —— 那是一张数据表，不是逻辑）。
///
/// **为什么需要它**：`localStorage` **按 origin 隔离**，而 WebView2 的用户数据目录
/// 是同一个 —— 旧 origin 下那些键**还在磁盘上**，但要由前端在**旧 origin 下**读一次
/// 交上来。合并规则是「**已有的不动**」，所以调用幂等，不会把用户新改的设置顶掉。
#[tauri::command]
pub async fn migrate_legacy_settings(st: super::St<'_>, old: Value) -> Cmd {
    let Some(src) = old.as_object() else {
        return Err("old 应该是一个对象".into());
    };
    if src.is_empty() {
        return Ok(json!({ "migrated": 0 }));
    }

    let mut cfg = st.config_snapshot();
    let mut migrated = 0u32;

    for (ls_key, cfg_key) in LEGACY_KEYS {
        let Some(raw) = src.get(*ls_key).and_then(|v| v.as_str()) else {
            continue;
        };
        let val = legacy_value(raw);
        let (Some(map), Some(v)) = (cfg.as_object_mut(), Some(val)) else {
            continue;
        };
        /* **已有的不动** —— 用户可能已经在新界面里改过设置了，
        不能被一份陈旧的 localStorage 覆盖回去。 */
        if map.get(*cfg_key).is_some() {
            continue;
        }
        map.insert((*cfg_key).to_string(), v);
        migrated += 1;
    }

    if migrated > 0 {
        super::config_file::save_config(&st.writable, &cfg)
            .map_err(|e| format!("迁移结果写不进配置文件：{e}"))?;
        if let Ok(mut guard) = st.config.lock() {
            *guard = cfg;
        }
        crate::log_line(&format!("已从旧前端的 localStorage 迁来 {migrated} 项设置"));
    }
    Ok(json!({ "migrated": migrated }))
}

/// localStorage 键 → 配置键。
///
/// ⚠️ **左侧必须是用户数据里真实存在的键名**（`fandiao.*` / `qingmu.*`），
/// 改掉只会让这张表对不上；右侧配置键用短名（`theme` / `audio` / …）。
const LEGACY_KEYS: &[(&str, &str)] = &[
    ("qingmu.theme", "theme"),
    ("fandiao.audio.settings", "audio"),
    ("fandiao.video.settings", "video"),
    ("fandiao.convert.options", "convert"),
    /* 页面把这条写成 `fandiao.convert.settings`（两种写法并存）。两条都收下：
    哪条在就搬哪条，两条都在时后一条赢。 */
    ("fandiao.convert.settings", "convert"),
    ("qingmu.pv.lyrics", "pvPendingLyrics"),
    ("qingmu.pv.sent", "pvSentLyrics"),
    ("qingmu.midi.outDir", "midiOutDir"),
];

/// localStorage 里存的是字符串，但有的本来就是 JSON（`{"options":{…}}`）。
///
/// 能解析成 JSON 就按 JSON 存（这样 `config.audio` 是个真对象、前端不用再 parse 一次），
/// 否则当普通字符串。**解析失败不是错误**。
fn legacy_value(raw: &str) -> Value {
    match serde_json::from_str::<Value>(raw) {
        Ok(v @ (Value::Object(_) | Value::Array(_))) => v,
        _ => Value::String(raw.to_string()),
    }
}

/* ══════════════════════════════════ 落盘的实现 ══════════════════════════════════ */

/// 局部更新配置并落盘，回**更新后**的完整配置（已打码）。
///
/// ⚠️ 脱敏字段（以 `Cookie` 结尾的键）收到占位串 `已设置` 时**跳过不写**：
/// 前端拿到的是打码后的值，原样提交回来是正常行为，不能把真值覆盖掉。
fn set_config_inner(st: &super::AppState, patch: Value) -> Result<Value, String> {
    // Serialize read-modify-write operations through the in-memory config lock.
    // Without this, two concurrent set_config calls can both read the same old
    // snapshot, save different patches, and let the later disk write silently
    // erase the earlier change.
    let mut guard = st.config.lock().map_err(|_| "配置锁坏了".to_string())?;
    let mut cfg = guard.clone();
    if let (Some(dst), Some(src)) = (cfg.as_object_mut(), patch.as_object()) {
        for (k, v) in src {
            if k.ends_with("Cookie") && v.as_str() == Some(super::config_file::MASKED) {
                continue;
            }
            /* 网易云的 Cookie 一律先清洗再落盘：粘贴带进来的换行 / 制表符会让 `Cookie`
            请求头发不出去，而界面上只显示「已设置」——脏值存进去就再也看不出问题。
            清洗不出来（不是键值对）时**报错而不是存**，见 `lyrics::clean_cookie`。 */
            if k == "neteaseCookie" {
                let raw = v.as_str().unwrap_or("");
                dst.insert(k.clone(), json!(crate::lyrics::clean_cookie(raw)?));
                continue;
            }
            dst.insert(k.clone(), v.clone());
        }
    }

    super::config_file::save_config(&st.writable, &cfg)
        .map_err(|e| format!("保存配置失败：{e}"))?;
    *guard = cfg.clone();

    // 回显也要打码：不然刚保存完 Cookie，明文就从响应里漏回前端了
    Ok(json!({ "config": super::config_file::mask_secrets(&cfg) }))
}
