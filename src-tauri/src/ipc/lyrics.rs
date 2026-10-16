//! 歌词相关命令（网易云专区）。`crate::lyrics` 里那套搜索 / 取词 / LRC-SRT / 封面 /
//! 歌曲直链 / 短信登录与这一层分开，这一层只做**参数解析、配置读写、错误文案**。
//!
//! ⚠️ **参数一律收 `Value`**，不拆成具名参数：调用方提交的就是一个对象，而且
//! `source_of` / `id_of` / `phone_of` 是**容错解析器**（同一字段收 `id` / 数字 /
//! 字符串三种写法），拆开就会把那份容错丢掉。
//!
//! ⚠️ **错误一律是给人看的一句话**（`Result<_, String>`）：IPC 没有状态码，而每条报错
//! 都是用户能自己处理的（「缺少歌曲 id」「这个版本网易云不给免费账号下载」）。
//! `source` 只剩 `netease` 一个值，但回包里**仍然带**它（前端在读这个字段）。
//!
//! 下载档位（`lyrics_song` 的 `quality`）与账号信息（`lyrics_account` / `lyrics_renew`）
//! 的做法参考了 FusionMusicPlayer（<https://github.com/Janson20/FusionMusicPlayer>，
//! GPL-3.0），出处说明与对应函数见 `crate::lyrics` 的模块头。

use std::path::PathBuf;
use std::sync::Arc;

use serde_json::{Value, json};

use super::Cmd;
use super::config_file;

/* ══════════════════════════════ 参数解析（容错） ══════════════════════════════ */

/// 从请求体里取歌曲 id（网易云是数字，也收字符串形式的数字）。
fn id_of(body: &Value) -> Result<String, String> {
    match body.get("id") {
        Some(Value::String(s)) if !s.trim().is_empty() => Ok(s.trim().to_string()),
        Some(Value::Number(n)) => Ok(n.to_string()),
        _ => Err("缺少歌曲 id".into()),
    }
}

/// 只有网易云一个来源。调用方可能还在传 `source`，一律当网易云处理 ——
/// 传别的值也不报「不支持的来源」：那个功能已经不存在了，报错只会让人困惑。
fn source_of(_body: &Value) -> &'static str {
    "netease"
}

/// 输出目录：请求里给了就用请求的，否则退回配置里的默认输出目录。
/// 前端默认填的是 `state.paths.outputDir`（系统下载目录），这里只是兜底。
fn out_dir_of(st: &Arc<super::AppState>, body: &Value) -> String {
    body.get("outDir")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(String::from)
        .unwrap_or_else(|| {
            st.config_snapshot()
                .get("outputDir")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        })
}

/// 文件名：去掉用户可能已经带上的扩展名，再统一用 `bili::safe_title` 清掉非法字符。
fn file_name(body: &Value, ext: &str, fallback: &str) -> String {
    let raw = body
        .get("name")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    // 表里歌词与音频两类都要有：用户在「文件名」里手打 `.flac` 的情况比想象中多，
    // 漏一个就会存成 `歌.flac.mp3`。比较时不分大小写，省掉 `.MP3` 那种重复项。
    const KNOWN_EXT: [&str; 9] = [
        "lrc", "srt", "ass", "txt", "mp3", "flac", "m4a", "aac", "wav",
    ];
    let stem = match raw.rsplit_once('.') {
        Some((head, tail)) if KNOWN_EXT.iter().any(|e| e.eq_ignore_ascii_case(tail)) => head,
        _ => raw,
    };
    let stem = stem.trim();
    let base = crate::bili::safe_title(if stem.is_empty() { fallback } else { stem });
    format!("{base}.{ext}")
}

/// 请求体里的手机号：去空格、去 `+86` / `86` 前缀、去常见分隔符。
///
/// 归一化是为了**只做一次格式校验**：`phone_ok` 是发短信前的闸门，
/// 让「138 0000 0000」「+8613800000000」这类写法也能顺利过闸，而不是被误判成格式错误。
fn phone_of(body: &Value) -> Result<String, String> {
    let raw = body
        .get("phone")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    let mut digits: String = raw
        .chars()
        .filter(|c| !matches!(c, ' ' | '-' | '+' | '(' | ')'))
        .collect();
    if let Some(rest) = digits.strip_prefix("86")
        && rest.len() >= 11
    {
        digits = rest.to_string();
    }
    if !crate::lyrics::phone_ok(&digits) {
        return Err("手机号格式错误：需要 11 位数字且以 1 开头（不用填 +86）".into());
    }
    Ok(digits)
}

/* ══════════════════════════════ 搜索 / 取词 ══════════════════════════════ */

/// 搜索歌曲（关键词 / 直链）。`{ keyword }` → `{ source, keyword, songs }`
#[tauri::command]
pub async fn lyrics_search(st: super::St<'_>, args: Value) -> Cmd {
    let source = source_of(&args);
    let keyword = args
        .get("keyword")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if keyword.is_empty() {
        return Err("请输入歌名或歌手".into());
    }

    let cfg = st.config_snapshot();
    let songs = crate::lyrics::search(&cfg, &keyword)
        .await
        .map_err(|e| e.to_string())?;

    Ok(json!({ "source": source, "keyword": keyword, "songs": songs }))
}

/// 取一首歌的歌词与译文。`{ id }` → `{ source, id, song, lyric, trans }`
#[tauri::command]
pub async fn lyrics_get(st: super::St<'_>, args: Value) -> Cmd {
    let id = id_of(&args)?;
    let cfg = st.config_snapshot();

    let data = crate::lyrics::fetch(&cfg, &id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(data)
}

/// 解析一个歌曲链接（`?id=` / `/song/<id>` / 纯数字），回 `{source, id}`。
///
/// ⚠️ 这条**没有 `st` 参数** —— 它只解析一个字符串，`generate_handler!` 按参数名注入，
/// 少一个参数就少一次注入。**别为了「十条命令长得一样」硬塞一个用不上的 `st`**：
/// 那会让读代码的人以为它要读配置。
#[tauri::command]
pub async fn lyrics_parse_link(args: Value) -> Cmd {
    let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("");
    let (source, id) = crate::lyrics::parse_link(url).map_err(|e| e.to_string())?;
    Ok(json!({ "source": source, "id": id }))
}

/* ══════════════════════════════ 存盘 / 导入 / 下载 ══════════════════════════════ */

/// 把歌词导出成文件（lrc / srt / ass / txt）。回 `{path, name, format, size}`。
#[tauri::command]
pub async fn lyrics_save(st: super::St<'_>, args: Value) -> Cmd {
    // 字段名是 lyric；`lrc` 也一并收下（两种写法都有人用）
    let lyric = args
        .get("lyric")
        .or_else(|| args.get("lrc"))
        .and_then(|v| v.as_str())
        .unwrap_or("");
    if lyric.trim().is_empty() {
        return Err("还没有歌词可保存".into());
    }

    let format = args
        .get("format")
        .and_then(|v| v.as_str())
        .unwrap_or("lrc")
        .to_lowercase();
    let trans = args.get("trans").and_then(|v| v.as_str()).unwrap_or("");
    let bilingual = args
        .get("bilingual")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    // 结束时间要用到歌曲时长：前端把拉歌词时拿到的时长传回来，拿不到就是 0（+4 秒兜底）
    let duration = args
        .get("durationSec")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    let (text, ext) = crate::lyrics::render(&format, lyric, trans, duration, bilingual)
        .map_err(|e| e.to_string())?;

    let dir = out_dir_of(&st, &args);
    if dir.is_empty() {
        return Err("没有输出目录。请选择目录，或先去「设置」页填一个默认输出目录".into());
    }
    let name = file_name(&args, ext, "lyrics");
    let path = PathBuf::from(&dir).join(&name);
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    // 一律 UTF-8（无 BOM）：见 crate::lyrics::render 的说明
    std::fs::write(&path, text.as_bytes()).map_err(|e| e.to_string())?;

    Ok(json!({
        "path": path.to_string_lossy(),
        "name": name,
        "format": ext,
        "size": text.len(),
    }))
}

/// 从本地 `.lrc` 文件导入歌词（用户手上已有的歌词，不用去搜）。
///
/// 返回的形状和 `lyrics_get` **一样**（另有 `encoding` 字段如实说明读到的是
/// UTF-8 还是 GBK），所以前端「搜到的歌」和「导入的文件」共用同一套预览 / 保存 /
/// 带去文字 PV 的逻辑，不用分叉。
///
/// ⚠️ 这条也**不需要状态** —— 见 `lyrics_parse_link` 的说明。
#[tauri::command]
pub async fn lyrics_import(args: Value) -> Cmd {
    let raw = args
        .get("path")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if raw.is_empty() {
        return Err("请先选一个 .lrc 文件".into());
    }

    let path = PathBuf::from(&raw);
    if !path.is_file() {
        return Err(format!("找不到这个文件：{raw}"));
    }

    // 文件读不了 / 编码读不对 / 里面没有时间轴：都是用户能自己处理的事，照实说
    crate::lyrics::import_file(&path).map_err(|e| e.to_string())
}

/// 下载歌曲封面到指定目录。回 `{path, name, size}`。
#[tauri::command]
pub async fn lyrics_cover(st: super::St<'_>, args: Value) -> Cmd {
    let url = args.get("url").and_then(|v| v.as_str()).unwrap_or("");
    if !url.starts_with("http") {
        return Err("封面地址无效（这首歌可能没有封面）".into());
    }

    // 扩展名从地址里猜，猜不到按 jpg 存（两个来源的封面都是 jpg）
    let ext = ["jpg", "jpeg", "png", "webp"]
        .iter()
        .find(|e| {
            url.split('?')
                .next()
                .unwrap_or("")
                .to_lowercase()
                .ends_with(&format!(".{e}"))
        })
        .copied()
        .unwrap_or("jpg");

    let dir = out_dir_of(&st, &args);
    if dir.is_empty() {
        return Err("没有输出目录，请先选择目录".into());
    }
    let name = file_name(&args, ext, "cover");
    let path = PathBuf::from(&dir).join(&name);

    let cfg = st.config_snapshot();
    let size = crate::lyrics::download_cover(&cfg, url, &path)
        .await
        .map_err(|e| e.to_string())?;

    Ok(json!({
        "path": path.to_string_lossy(),
        "name": name,
        "size": size,
    }))
}

/// 直链下载歌曲音频。`{ id, quality?, durationSec?, outDir?, name? }` →
/// `{ path, name, size, level, format, downgraded }`
///
/// `quality` 是档位上限（`auto` / `hires` / `lossless` / `exhigh` / `higher` / `standard`），
/// 认不出按 `auto`。**响应里的 `level` 是实际拿到的档位** —— 服务端会静默降级
/// （求无损只给 320 kbps），`downgraded` 说明是否发生了这件事，界面据此如实显示。
///
/// 存到哪和歌词/封面一个规矩：请求里的 `outDir` 优先，否则用配置里的默认输出目录。
/// 「直链」在 `crate::lyrics::download_song` 里拿：能拿到就下，
/// 拿不到就把网易云给的原因如实说出来（版权受限 / 只有会员能听），**不假装成功**。
#[tauri::command]
pub async fn lyrics_song(st: super::St<'_>, args: Value) -> Cmd {
    let id = id_of(&args)?;

    let dir = out_dir_of(&st, &args);
    if dir.is_empty() {
        return Err("没有输出目录，请先选择目录".into());
    }

    let quality =
        crate::lyrics::Quality::parse(args.get("quality").and_then(|v| v.as_str()).unwrap_or(""));
    // 曲目时长用来拦「只拿到 30 秒试听片段」；前端拿不到就是 0，此时不判
    let duration = args
        .get("durationSec")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);

    // 歌名兜底成歌曲 id：前端一般会传「歌名 - 歌手」，传空也不能存成无名文件。
    // 扩展名先按 mp3 去掉，真实格式等下载完按**文件头**补。
    let stem = file_name(&args, "mp3", &id);
    let path = PathBuf::from(&dir).join(&stem);

    let cfg = st.config_snapshot();
    let got = crate::lyrics::download_song(&cfg, &id, &path, quality, duration)
        .await
        // 拿不到直链 / 版权受限 / 只有试听：这是用户能理解并自己处理的事，原样显示
        .map_err(|e| e.to_string())?;

    // 扩展名跟着**实际格式**改（`format` 是按文件头认出来的，比接口的 type 可信）
    let (path, name) = if got.format == "mp3" {
        (path, stem)
    } else {
        let renamed = path.with_extension(&got.format);
        let name = renamed
            .file_name()
            .map(|x| x.to_string_lossy().to_string())
            .unwrap_or_else(|| format!("{stem}.{}", got.format));
        std::fs::rename(&path, &renamed).map_err(|e| format!("改名失败：{e}"))?;
        (renamed, name)
    };

    Ok(json!({
        "path": path.to_string_lossy(),
        "name": name,
        "size": got.bytes,
        "level": got.level,
        "format": got.format,
        "downgraded": got.downgraded,
    }))
}

/* ══════════════════════════════ 登录 / 退出 ══════════════════════════════ */

/// 退出登录：把网易云的 Cookie 清空。
///
/// 和 `save_netease_cookie` 对称 —— 同样走 `save_config` + 内存快照，
/// 区别只是写进去的是空串。清空后 `cookie_of` 读到的就是空，搜索/取歌词
/// 自动退回未登录状态，不需要别的地方配合。有效期一并清掉：
/// 留着它会让界面显示一个早已不存在的登录态的有效期。
#[tauri::command]
pub async fn lyrics_logout(st: super::St<'_>, args: Value) -> Cmd {
    let source = source_of(&args);

    let mut next = st.config_snapshot();
    if let Some(map) = next.as_object_mut() {
        map.insert("neteaseCookie".into(), json!(""));
        map.insert("neteaseCookieExpire".into(), json!(0));
    }
    config_file::save_config(&st.inner().writable, &next).map_err(|e| e.to_string())?;
    if let Ok(mut guard) = st.inner().config.lock() {
        *guard = next;
    }

    Ok(json!({ "loggedOut": true, "source": source }))
}

/// 把登录 / 续期拿到的 Cookie 与有效期写进配置并落盘。
///
/// 走的就是 `save_config` + 内存快照，和设置页保存 Cookie 是同一条路 ——
/// 所以「登录完之后能不能取到歌词」这件事只取决于 `crate::lyrics::cookie_of`
/// 读的 `neteaseCookie`，这里写的正是它。有效期单独存一个字段，
/// 供界面显示与自动续期判断（见 `crate::lyrics::should_renew`）。
fn save_netease_cookie(
    st: &Arc<super::AppState>,
    cookie: &str,
    expires_at: i64,
) -> Result<(), String> {
    let mut next = st.config_snapshot();
    if let Some(map) = next.as_object_mut() {
        map.insert("neteaseCookie".into(), json!(cookie));
        map.insert("neteaseCookieExpire".into(), json!(expires_at));
    }
    config_file::save_config(&st.writable, &next).map_err(|e| e.to_string())?;
    if let Ok(mut guard) = st.config.lock() {
        *guard = next;
    }
    Ok(())
}

/// 发短信验证码。`{ phone }` → `{ sent: true, phone }`
///
/// 先查一次性「号码存不存在」（只在明确回答「没有」时才拦），省一条真短信。
#[tauri::command]
pub async fn lyrics_login_sms(st: super::St<'_>, args: Value) -> Cmd {
    let phone = phone_of(&args)?;
    let cfg = st.config_snapshot();

    // 查不出来（None）不拦：那只是风控/网络的问题，直接发码让发码接口自己说话
    if let Ok(Some(false)) = crate::lyrics::phone_exists(&cfg, &phone).await {
        return Err(
            "这个手机号在网易云没有注册过，短信没发出去。请检查号码，或改用 Cookie 登录".into(),
        );
    }

    let res = crate::lyrics::sms_send(&cfg, &phone)
        .await
        .map_err(|e| e.to_string())?;

    // 网易云的成功形状是 `{"code":200,"data":true}`；码不是 200 就把它自己的话透出来
    let code = res.get("code").and_then(|v| v.as_i64()).unwrap_or(0);
    if code != 200 {
        return Err(sms_error(&res, code));
    }

    Ok(json!({ "sent": true, "phone": phone }))
}

/// 发码失败的说明：优先用网易云自己的话，认不出的码也把原始响应截一段带上。
fn sms_error(res: &Value, code: i64) -> String {
    let their = res
        .get("message")
        .or_else(|| res.get("msg"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if !their.is_empty() {
        return format!("发送验证码失败：{their}（code {code}）");
    }
    let raw: String = res.to_string().chars().take(200).collect();
    format!("发送验证码失败（网易云返回 code {code}，没有说明）：{raw}")
}

/// 手机号 + 验证码登录。`{ phone, captcha }` → `{ loggedIn, phone, nickname, vip, vipDetail, expiresAt }`
///
/// 成功时把 Cookie 与有效期写进 `config.neteaseCookie` / `config.neteaseCookieExpire` ——
/// 搜索、取歌词、下封面都读前者（见 `crate::lyrics::cookie_of`），所以保存完立刻就能用；
/// 后者供界面显示有效期与自动续期判断。
#[tauri::command]
pub async fn lyrics_login_cellphone(st: super::St<'_>, args: Value) -> Cmd {
    let phone = phone_of(&args)?;
    let captcha = args
        .get("captcha")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if captcha.is_empty() {
        return Err("请先填短信验证码".into());
    }

    let cfg = st.config_snapshot();
    let (cookie, expires_at) = crate::lyrics::cellphone_login(&cfg, &phone, &captcha)
        .await
        // 验证码错误 / 号码没注册 / 接口改了：都要原样让用户看到，别压成一句「登录失败」
        .map_err(|e| e.to_string())?;
    if !cookie.contains("MUSIC_U") {
        return Err(format!(
            "登录接口没有返回 MUSIC_U，拿到的 Cookie 用不了（{} 字符）",
            cookie.chars().count()
        ));
    }

    save_netease_cookie(&st, &cookie, expires_at)?;

    // 顺手问一次账号：昵称 + 会员标签，登录成功的提示就能写成「已登录为 xxx」；
    // 拿不到也不影响登录本身（凭据已经落盘了）
    let info = crate::lyrics::account_info(&st.config_snapshot()).await;

    Ok(json!({
        "loggedIn": true,
        "phone": phone,
        "nickname": info.nickname,
        "vip": info.vip,
        "vipDetail": info.vip_detail,
        "expiresAt": expires_at,
    }))
}

/// 查登录态与账号信息。`{}` →
/// `{ state, nickname, vip, vipDetail, expiresAt, renewBeforeDays }`
///
/// `state` 四态，**前端必须按它区分处理**：
///   * `ok`       —— 凭据有效
///   * `expired`  —— 服务端明确说凭据不行了：置为未登录并引导重新登录
///   * `offline`  —— 网络不通 / 风控：**绝不能因此清掉本地的登录态**
///   * `anonymous`—— 本地根本没配 Cookie
///
/// `expiresAt` 是服务端给的 MUSIC_U 过期时间（unix 秒，0 表示没记过）；
/// `shouldRenew` 由后端按 `renewBeforeDays` 算好（「现在几点」只在一处取，
/// 免得前后端各算一遍还对不上），前端据此决定要不要调 `lyrics_renew`。
#[tauri::command]
pub async fn lyrics_account(st: super::St<'_>, _args: Value) -> Cmd {
    let cfg = st.config_snapshot();
    let info = crate::lyrics::account_info(&cfg).await;
    let expires_at = cfg
        .get("neteaseCookieExpire")
        .and_then(|v| v.as_i64())
        .unwrap_or(0);

    Ok(json!({
        "state": info.state,
        "nickname": info.nickname,
        "vip": info.vip,
        "vipDetail": info.vip_detail,
        "expiresAt": expires_at,
        "renewBeforeDays": crate::lyrics::RENEW_BEFORE_DAYS,
        "shouldRenew": crate::lyrics::should_renew(
            expires_at,
            crate::lyrics::now_unix(),
            crate::lyrics::RENEW_BEFORE_DAYS,
        ),
    }))
}

/// 手动续期网易云登录凭据。`{}` → `{ renewed, nickname, vip, expiresAt }`
///
/// 续期是**换发**：服务端用 `Set-Cookie` 给一个新的 MUSIC_U，旧的也还有效 ——
/// 所以续期失败**不会导致掉登录**，前端按「这次没续上」处理即可，不必清登录态。
#[tauri::command]
pub async fn lyrics_renew(st: super::St<'_>, _args: Value) -> Cmd {
    let cfg = st.config_snapshot();
    let Some((cookie, expires_at)) = crate::lyrics::refresh_login(&cfg).await else {
        return Err("续期没有成功：可能是网络不通，也可能需要重新登录".into());
    };
    save_netease_cookie(&st, &cookie, expires_at)?;

    let info = crate::lyrics::account_info(&st.config_snapshot()).await;
    Ok(json!({
        "renewed": true,
        "nickname": info.nickname,
        "vip": info.vip,
        "expiresAt": expires_at,
    }))
}
