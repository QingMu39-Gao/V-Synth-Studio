//! 「感谢名单」：从自建源取一份赞助者 ID 列表。
//!
//! ⚠️ 取不到**不是错误**：断网、服务器重启都是常态，界面照旧要能打开「关于」。
//! 三种来源按优先级兜底：远端成功 → 本地缓存（上一次成功的快照）→ 内置名单。
//! 缓存排在远端之后、内置之前，是因为内置名单只有随包更新才会变，
//! 而缓存至少是这台机器上见过的最新一份。

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};

/// 远端地址。与 `ANNOUNCE_URLS` 同一条规矩：只收 https（见 `net::fetch_public_json`）。
const SPONSOR_URLS: &[&str] = &["https://admin1.qingmu39.top/api/sponsors.json"];

/// 取不到时的上限。名单在「关于」页里看，没必要为它让界面转很久。
const TIMEOUT: Duration = Duration::from_secs(6);

/// 名字上限。超出的忽略：这份名单是人工维护的，几十个算正常，
/// 上千个说明文件写错了（或者源被替换），此时不该把界面撑爆。
const MAX_NAMES: usize = 500;

/// 单条长度上限（字符，不是字节）。ID 里出现长句多半是说明文字混进了名单。
const NAME_LIMIT: usize = 60;

/// 随包兜底名单。只在「远端和缓存都没有」时用。
///
/// ⚠️ 顺序**不代表排名** —— 面板上那行「排名无先后顺序」就是为这条写的。
/// ID 一律**照抄对方自己写的样子**（大小写、空格、假名、emoji 都别动）。
const BUILTIN: &[&str] = &[
    "坎伊bbb",
    "Desire Control",
    "浅唱教主",
    "老钱",
    "三无",
    "入さん",
    "ゆりかごから墓場まで",
    "小偷人机在线逃跑",
    "WuJinGY",
    "venom",
    "LYT",
    "唠蟹公主",
    "火橘子",
    "筱箖",
    "nxy",
    "让我们一起陷入狂赌之渊吧",
    "星街彗星",
    "神野冬花",
    "落款未名",
    "酒韵星回",
    "凌宇",
    "界兔",
    "绝望病",
    "寿司公主",
    "茶绪P",
];

/// 缓存文件名（放在可写目录下，跟着绿色版走 / 安装版在 `%APPDATA%`）。
const CACHE_FILE: &str = "sponsors-cache.json";

pub fn sponsor_urls() -> Vec<String> {
    urls_from(
        SPONSOR_URLS,
        std::env::var("VSS_SPONSOR_URL").ok().as_deref(),
    )
}

/// 纯函数版（环境变量是进程级的，直接读它写不出可复现的用例）。
fn urls_from(consts: &[&str], env: Option<&str>) -> Vec<String> {
    let raw: Vec<String> = match env.map(str::trim).filter(|s| !s.is_empty()) {
        Some(v) => v.split(',').map(|s| s.trim().to_string()).collect(),
        None => consts.iter().map(|s| s.to_string()).collect(),
    };
    let mut out: Vec<String> = Vec::new();
    for u in raw {
        if u.is_empty() || !crate::update::allowed_base(&u) || out.contains(&u) {
            continue;
        }
        out.push(u);
    }
    out
}

/// 从远端回包里读出名单。
///
/// 接受两种形状：裸数组 `["a","b"]`，或带包装的 `{"sponsors": [...]}`
/// （也认 `names` / `list`）。生成器写的是前者；后者是为了将来改格式时
/// 老客户端不必跟着发版。
pub fn names_from(v: &Value) -> Result<Vec<String>, String> {
    let arr = v
        .as_array()
        .or_else(|| v.get("sponsors").and_then(Value::as_array))
        .or_else(|| v.get("names").and_then(Value::as_array))
        .or_else(|| v.get("list").and_then(Value::as_array))
        .ok_or_else(|| "既不是数组，也没有 sponsors/names/list 字段".to_string())?;

    let mut out: Vec<String> = Vec::new();
    for item in arr {
        // 每一项可以是一个字符串，也可以是 `{"name": "..."}`（将来要带备注时不必改形状）
        let raw = match item {
            Value::String(s) => s.as_str(),
            other => other
                .get("name")
                .and_then(Value::as_str)
                .or_else(|| other.get("id").and_then(Value::as_str))
                .unwrap_or(""),
        };
        let name = normalize_name(raw);
        if name.is_empty() || out.contains(&name) {
            continue;
        }
        out.push(name);
        if out.len() >= MAX_NAMES {
            break;
        }
    }
    Ok(out)
}

/// 去空白、砍换行、截长度。
///
/// 名字来自远端，会被原样塞进界面，所以这里只做「不让它破坏排版」的清理：
/// 不转义、不删字符（日文、emoji、空格都是对方自己写的样子）。
fn normalize_name(raw: &str) -> String {
    let flat: String = raw
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect();
    let trimmed = flat.split_whitespace().collect::<Vec<_>>().join(" ");
    if trimmed.chars().count() > NAME_LIMIT {
        return trimmed.chars().take(NAME_LIMIT).collect();
    }
    trimmed
}

fn cache_path(writable: &Path) -> PathBuf {
    writable.join(CACHE_FILE)
}

/// 读上一次成功的快照。读不到或读坏了都回 `None`（不是错误：缓存本来就可以没有）。
pub fn load_cached(writable: &Path) -> Option<Vec<String>> {
    let text = std::fs::read_to_string(cache_path(writable)).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    names_from(&v).ok().filter(|n| !n.is_empty())
}

/// 写缓存。失败不影响显示（下一次远端成功时会再写）。
pub fn save_cached(writable: &Path, names: &[String]) {
    let path = cache_path(writable);
    let body = json!({ "sponsors": names });
    match serde_json::to_vec(&body) {
        Ok(bytes) => {
            if let Err(e) = std::fs::write(&path, bytes) {
                crate::log_line(&format!(
                    "感谢名单：缓存写不进去（{}）：{e}",
                    path.display()
                ));
            }
        }
        Err(e) => crate::log_line(&format!("感谢名单：缓存序列化失败（{e}）")),
    }
}

fn builtin() -> Vec<String> {
    BUILTIN.iter().map(|s| s.to_string()).collect()
}

/// 取一次名单。回 `{ok, names, via}`。
///
/// ⚠️ **不是 `Err`**：见本模块开头。`via` 说明这份名单从哪儿来
/// （`remote` / `cache` / `builtin`），「关于」页据此决定要不要提示「可能不是最新」。
pub async fn fetch(writable: &Path) -> Value {
    let urls = sponsor_urls();
    let ua = crate::announce::self_host_ua();
    let mut tried: Vec<String> = Vec::new();

    for url in urls {
        match crate::net::fetch_public_json(&url, &ua, TIMEOUT).await {
            Ok(v) => match names_from(&v) {
                Ok(names) if !names.is_empty() => {
                    save_cached(writable, &names);
                    crate::log_line(&format!("感谢名单：{url} 取到 {} 个", names.len()));
                    return json!({ "ok": true, "names": names, "via": "remote" });
                }
                Ok(_) => {
                    // 空名单当失败处理：正常维护不会把所有赞助者一次删光，
                    // 更可能是文件被清空了还在同步。此时用缓存比显示空名单好。
                    crate::log_line(&format!("感谢名单：{url} 是空的，当取不到处理"));
                    tried.push(format!("{url}（空名单）"));
                }
                Err(e) => {
                    crate::log_line(&format!("感谢名单：{url} 读不了（{e}）"));
                    tried.push(format!("{url}（{e}）"));
                }
            },
            Err(e) => {
                crate::log_line(&format!("感谢名单：{url} 取不到（{e}）"));
                tried.push(format!("{url}（{e}）"));
            }
        }
    }

    if let Some(names) = load_cached(writable) {
        crate::log_line(&format!("感谢名单：用缓存（{} 个）", names.len()));
        return json!({
            "ok": true,
            "names": names,
            "via": "cache",
            "error": format!("取不到最新的：{}", tried.join("；")),
        });
    }

    json!({
        "ok": true,
        "names": builtin(),
        "via": "builtin",
        "error": format!("取不到，也没有缓存：{}", tried.join("；")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vss-sponsors-{}-{}", std::process::id(), tag));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// 裸数组：生成器写的形状。
    #[test]
    fn accepts_a_plain_array() {
        let v: Value = json!(["a", "b"]);
        assert_eq!(names_from(&v).unwrap(), vec!["a", "b"]);
    }

    /// 带包装的形状，这样将来改格式不必发新版客户端。
    #[test]
    fn accepts_wrapped_shapes() {
        for key in ["sponsors", "names", "list"] {
            let v = json!({ key: ["x"] });
            assert_eq!(names_from(&v).unwrap(), vec!["x"], "字段 {key} 没认出来");
        }
    }

    /// 每一项也可以是对象，取 name / id。
    #[test]
    fn accepts_objects_with_name_or_id() {
        let v = json!([{"name": "坤"}, {"id": "kun"}]);
        assert_eq!(names_from(&v).unwrap(), vec!["坤", "kun"]);
    }

    /// 空串、纯空白要丢掉，否则界面上会出现一个看不见的空 chip。
    #[test]
    fn drops_blank_entries() {
        let v = json!(["a", "", "   ", "\n\t", "b"]);
        assert_eq!(names_from(&v).unwrap(), vec!["a", "b"]);
    }

    /// 重复要去掉（同一个 id 写了两遍时不该出现两个 chip）。
    #[test]
    fn drops_duplicates() {
        let v = json!(["a", "a", "b"]);
        assert_eq!(names_from(&v).unwrap(), vec!["a", "b"]);
    }

    /// 名字里的换行会被压成空格：远端内容原样进界面会破坏排版。
    #[test]
    fn flattens_control_characters() {
        let v = json!(["a\nb", "c\td"]);
        assert_eq!(names_from(&v).unwrap(), vec!["a b", "c d"]);
    }

    /// 大小写、假名、emoji 一律不动 —— ID 要照抄对方自己写的样子。
    #[test]
    fn keeps_names_verbatim() {
        let v = json!(["WuJinGY", "ゆりかごから墓場まで", "星街彗星🎤"]);
        assert_eq!(
            names_from(&v).unwrap(),
            vec!["WuJinGY", "ゆりかごから墓場まで", "星街彗星🎤"]
        );
    }

    /// 超长条目要截断，不能把一整段说明文字塞进 chip。
    #[test]
    fn truncates_overlong_names() {
        let long = "あ".repeat(NAME_LIMIT + 20);
        let v = json!([long]);
        let got = names_from(&v).unwrap();
        assert_eq!(got[0].chars().count(), NAME_LIMIT);
    }

    /// 数量上限：源被替换成几千条时不该把界面撑爆。
    #[test]
    fn caps_the_number_of_names() {
        let many: Vec<String> = (0..MAX_NAMES + 50).map(|i| format!("n{i}")).collect();
        let v = json!(&many);
        assert_eq!(names_from(&v).unwrap().len(), MAX_NAMES);
    }

    /// 形状完全不对时要报错（调用方据此回落到缓存）。
    #[test]
    fn rejects_non_array_shapes() {
        assert!(names_from(&json!({"value": 1})).is_err());
        assert!(names_from(&json!("str")).is_err());
        assert!(names_from(&json!(1)).is_err());
    }

    /// 缓存往返：写进去再读出来要一样，且顺序保留。
    #[test]
    fn cache_round_trips() {
        let d = tmpdir("rt");
        let names = vec!["坤".to_string(), "kun".to_string()];
        save_cached(&d, &names);
        assert_eq!(load_cached(&d).unwrap(), names);
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 缓存不存在时是 `None`，不是 panic。
    #[test]
    fn missing_cache_is_none() {
        let d = tmpdir("none");
        assert!(load_cached(&d).is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 缓存被写坏了（用户手动改、半截写入）也当没有，不能让「关于」页打不开。
    #[test]
    fn corrupt_cache_is_none() {
        let d = tmpdir("bad");
        std::fs::write(cache_path(&d), b"{not json").unwrap();
        assert!(load_cached(&d).is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 缓存里是空数组等价于没有缓存 —— 否则一次坏写入会让名单永久变空。
    #[test]
    fn empty_cache_is_none() {
        let d = tmpdir("empty");
        save_cached(&d, &[]);
        assert!(load_cached(&d).is_none());
        let _ = std::fs::remove_dir_all(&d);
    }

    /// 内置名单不能是空的，否则三个兜底全落空时界面会空白。
    #[test]
    fn builtin_is_not_empty() {
        assert!(!builtin().is_empty());
    }

    /// URL 过滤：只留 https，去重，空串丢掉。
    #[test]
    fn urls_are_filtered_and_deduped() {
        let got = urls_from(
            &["https://a/x.json"],
            Some("https://a/x.json, http://plain/y, https://b/z, https://b/z"),
        );
        assert_eq!(got, vec!["https://a/x.json", "https://b/z"]);
    }
}
