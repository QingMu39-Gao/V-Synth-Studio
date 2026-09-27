//! 歌词：网易云 / QQ 音乐的搜索、歌词抓取、短信验证码登录，以及 LRC ↔ SRT 转换。
//!
//! 分工：平台相关的请求与解析都在这里（和 `bili.rs` 一个位置），路由在
//! `server/lyrics.rs`，业务逻辑不碰 axum。
//!
//! ── 出处说明 ──────────────────────────────────────────────
//! 以下三块**移植自 163MusicLyrics**（<https://github.com/jitwxs/163MusicLyrics>，
//! Apache-2.0，Copyright (c) jitwxs），已在对应函数上注明：
//!   - LRC 时间戳解析（`[mm:ss]` / `[mm:ss.SS]` / `[mm:ss:SS]` 等多种写法）
//!     —— Core/Models/MusicLyricsVO.cs 的 `LyricTimestamp`
//!   - LRC → SRT 的结束时间规则（同一时间戳的多行收在同一个结束时间上）
//!     —— Core/Utils/SrtUtils.cs 的 `LrcToSrt`
//!   - 译文按时间戳对齐 / 译文缺失与精度误差的处理思路、QQ 歌词里的
//!     `[offset:0]` `[kana:` 分隔标记、纯音乐与空行的判定
//!     —— Core/Utils/LyricUtils.cs、Core/Models/MusicLyricsVO.cs
//!
//! 接口选择没有照搬它：它走 `weapi` 加密链路（AES + RSA，见
//! NetEaseMusicNativeApi.cs 的 120 行加密代码），而实测明文接口
//! `/api/cloudsearch/pc`、`/api/song/lyric`、`/api/song/detail` 直接可用，
//! 于是这里按实测端点重写，省掉整套加密。QQ 歌词同理用实测可用的
//! `fcg_query_lyric_new.fcg`，而不是它那套要解密 + 解压的 `lyric_download.fcg`。
//! 登录它没有（它是手工填 Cookie），短信验证码登录这条完全按实测接口自己写。

use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};

use crate::net::DEFAULT_UA;

/// QQ 音乐的搜索接口认这个 UA：桌面 UA 会被判成网页端要求签名，
/// 返回空列表或 `{"code":500001}`（实测两种桌面写法都不通）。
const QQ_UA: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) \
                     AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148";

const REFER_NETEASE: &str = "https://music.163.com/";
const REFER_QQ: &str = "https://y.qq.com/portal/player.html";
const REFER_QQ_ROOT: &str = "https://y.qq.com/";

/// 纯音乐的占位歌词，两个来源文案不同（移植自 163MusicLyrics 的 `IsPureMusic`）
const PURE_MUSIC: &str = "这首歌是纯音乐，没有歌词可导出";

/* ══════════════════════════════════ 出站请求 ══════════════════════════════════ */

/// 建一个走配置代理的客户端。
///
/// 不用全局的 `net::client()`：那个没挂代理（它服务 B 站，用户给了 Cookie 就直连）。
/// 歌词这一页的操作都是用户手点出来的，一次几下，不值得为它维护客户端缓存。
/// ponytail: 每次新建客户端会多一次 TLS 握手；真嫌慢再按代理串缓存一个实例。
fn client(cfg: &Value) -> Result<reqwest::Client, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::limited(10));

    let proxy = str_at(cfg, "proxy");
    if !proxy.is_empty() {
        // 用户常填 `127.0.0.1:7890`（不带协议）。直接喂给 Url 会把 `127.0.0.1` 当成
        // scheme，reqwest 报「unknown proxy scheme」，所以先补协议。
        let url = if proxy.contains("://") {
            proxy.clone()
        } else {
            format!("http://{proxy}")
        };
        builder = builder.proxy(
            reqwest::Proxy::all(&url).map_err(|e| format!("代理地址无效（{proxy}）：{e}"))?,
        );
    }
    builder.build().map_err(|e| format!("HTTP 客户端创建失败：{e}"))
}

fn str_at(cfg: &Value, key: &str) -> String {
    cfg.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn cookie_of(cfg: &Value, source: &str) -> String {
    if source == "qq" {
        return str_at(cfg, "qqCookie");
    }
    let raw = str_at(cfg, "neteaseCookie");
    // 界面上教的取法是「双击 MUSIC_U 的 Value 列复制」，拿到的就只有值、没有 `名字=`。
    // 原样当 Cookie 头发出去等于一个无名 cookie，登录态不生效 —— 这里补上名字。
    // 有 `=` 的（只粘 MUSIC_U 段、或整行 Cookie）一律原样用。
    if !raw.is_empty() && !raw.contains('=') {
        return format!("MUSIC_U={raw}");
    }
    raw
}

/// GET 文本。UA 与 Referer 必带 —— 这两个接口不带就会被判成脚本直接拒。
async fn get_text(
    client: &reqwest::Client,
    url: &str,
    ua: &str,
    referer: &str,
    cookie: &str,
) -> Result<String, String> {
    let mut req = client
        .get(url)
        .header("User-Agent", ua)
        .header("Referer", referer);
    if !cookie.is_empty() {
        req = req.header("Cookie", cookie);
    }
    let res = req.send().await.map_err(|e| {
        if e.is_timeout() {
            format!("请求超时（20 秒）：{url}")
        } else {
            format!("网络请求失败：{e}")
        }
    })?;
    let status = res.status().as_u16();
    let text = res.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(format!("HTTP {status}：{url}"));
    }
    Ok(text)
}

async fn get_json(
    client: &reqwest::Client,
    url: &str,
    ua: &str,
    referer: &str,
    cookie: &str,
) -> Result<Value, String> {
    let text = get_text(client, url, ua, referer, cookie).await?;
    serde_json::from_str(&text)
        .map_err(|_| format!("返回的不是合法 JSON（可能触发了风控）：{url}"))
}

async fn get_bytes(
    client: &reqwest::Client,
    url: &str,
    ua: &str,
    referer: &str,
    cookie: &str,
) -> Result<Vec<u8>, String> {
    let mut req = client
        .get(url)
        .header("User-Agent", ua)
        .header("Referer", referer);
    if !cookie.is_empty() {
        req = req.header("Cookie", cookie);
    }
    let res = req
        .send()
        .await
        .map_err(|e| format!("网络请求失败：{e}"))?;
    let status = res.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("HTTP {status}：{url}"));
    }
    Ok(res.bytes().await.map_err(|e| e.to_string())?.to_vec())
}

/* ══════════════════════════════ JSON 取值小工具 ══════════════════════════════ */

/// 按 JSON Pointer 取字符串；数字也照样转成字符串（接口里 id 有时是数字有时是串）
fn s(v: &Value, ptr: &str) -> String {
    match v.pointer(ptr) {
        Some(Value::String(t)) => t.clone(),
        Some(Value::Number(n)) => n.to_string(),
        _ => String::new(),
    }
}

/// 按 JSON Pointer 取整数（字符串形式的数字也认）
fn n(v: &Value, ptr: &str) -> i64 {
    match v.pointer(ptr) {
        Some(Value::Number(x)) => x.as_i64().or_else(|| x.as_f64().map(|f| f as i64)).unwrap_or(0),
        Some(Value::String(t)) => t.trim().parse().unwrap_or(0),
        _ => 0,
    }
}

/// `[{name:"a"},{name:"b"}]` → `a/b`
fn names(arr: Option<&Value>, key: &str) -> String {
    arr.and_then(|v| v.as_array())
        .map(|list| {
            list.iter()
                .filter_map(|x| x.get(key).and_then(|v| v.as_str()))
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_default()
}

/// 网易云的封面地址有时是 http://，统一升成 https（下载与显示都省事）
fn https_url(u: &str) -> String {
    match u.strip_prefix("http://") {
        Some(rest) => format!("https://{rest}"),
        None => u.to_string(),
    }
}

/// QQ 的封面按专辑 mid 拼；拿不到 albummid 就没有封面
fn qq_cover(album_mid: &str) -> String {
    if album_mid.is_empty() {
        String::new()
    } else {
        format!("https://y.gtimg.cn/music/photo_new/T002R300x300M000{album_mid}.jpg")
    }
}

/* ══════════════════════════════════ 搜索 ══════════════════════════════════ */

pub fn normalize_source(source: &str) -> Result<&'static str, String> {
    match source.trim() {
        "netease" => Ok("netease"),
        "qq" => Ok("qq"),
        "" => Err("请先选择音乐来源".to_string()),
        other => Err(format!("不支持的来源：{other}")),
    }
}

/// 搜索歌曲，返回统一的形状：
/// `[{ id, name, artists, album, cover, durationSec }]`
pub async fn search(cfg: &Value, source: &str, keyword: &str) -> Result<Vec<Value>, String> {
    let client = client(cfg)?;
    let cookie = cookie_of(cfg, source);
    if source == "qq" {
        qq_search(&client, keyword, &cookie).await
    } else {
        netease_search(&client, keyword, &cookie).await
    }
}

async fn netease_search(
    client: &reqwest::Client,
    keyword: &str,
    cookie: &str,
) -> Result<Vec<Value>, String> {
    let url = format!(
        "https://music.163.com/api/cloudsearch/pc?s={}&type=1&limit=20",
        crate::net::encode_component(keyword)
    );
    let json = get_json(client, &url, DEFAULT_UA, REFER_NETEASE, cookie).await?;
    let songs = json
        .pointer("/result/songs")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    Ok(songs
        .iter()
        .filter_map(|song| {
            let id = n(song, "/id");
            if id == 0 {
                return None;
            }
            Some(json!({
                "id": id.to_string(),
                "name": s(song, "/name"),
                "artists": names(song.get("ar"), "name"),
                "album": s(song, "/al/name"),
                "cover": https_url(&s(song, "/al/picUrl")),
                "durationSec": n(song, "/dt") / 1000,
            }))
        })
        .collect())
}

async fn qq_search(
    client: &reqwest::Client,
    keyword: &str,
    cookie: &str,
) -> Result<Vec<Value>, String> {
    // 带参的 client_search_cp / musicu.fcg 在实测里都返回空列表或 code 500001（要签名），
    // 只有这个「手机端搜索」是通的：换手机 UA + y.qq.com 的 Referer 即可，无需签名。
    let url = format!(
        "https://c.y.qq.com/soso/fcgi-bin/search_for_qq_cp?w={}&p=1&n=20&format=json&t=0&\
         aggr=1&cr=1&catZhida=1&remoteplace=txt.mqq.all&platform=yqq&needNewCode=1&utf8=1",
        crate::net::encode_component(keyword)
    );
    let json = get_json(client, &url, QQ_UA, REFER_QQ_ROOT, cookie).await?;
    let list = json
        .pointer("/data/song/list")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    Ok(list
        .iter()
        .filter_map(|song| {
            let mid = s(song, "/songmid");
            if mid.is_empty() {
                return None;
            }
            Some(json!({
                "id": mid,
                "name": s(song, "/songname"),
                "artists": names(song.get("singer"), "name"),
                "album": s(song, "/albumname"),
                "cover": qq_cover(&s(song, "/albummid")),
                // 这个接口直接给时长（秒）
                "durationSec": n(song, "/interval"),
            }))
        })
        .collect())
}

/* ══════════════════════════════ 歌词与详情 ══════════════════════════════ */

/// 取歌词：`{ source, id, song:{name,artists,album,cover,durationSec}, lyric, trans }`
pub async fn fetch(cfg: &Value, source: &str, id: &str) -> Result<Value, String> {
    let client = client(cfg)?;
    let cookie = cookie_of(cfg, source);
    if source == "qq" {
        qq_fetch(&client, id, &cookie).await
    } else {
        netease_fetch(&client, id, &cookie).await
    }
}

async fn netease_fetch(
    client: &reqwest::Client,
    id: &str,
    cookie: &str,
) -> Result<Value, String> {
    let url = format!("https://music.163.com/api/song/lyric?id={id}&lv=-1&kv=-1&tv=-1");
    let data = get_json(client, &url, DEFAULT_UA, REFER_NETEASE, cookie).await?;

    let lyric = s(&data, "/lrc/lyric");
    if lyric.trim().is_empty() {
        return Err("接口没有返回歌词（可能是纯音乐，或这首歌的歌词需要登录后才有）".to_string());
    }
    if is_pure_music(&lyric) {
        return Err(PURE_MUSIC.to_string());
    }

    // 详情只用来补歌名/歌手/专辑/封面/时长，失败了不该把歌词一起废掉
    let detail = get_json(
        client,
        &format!("https://music.163.com/api/song/detail?ids=[{id}]"),
        DEFAULT_UA,
        REFER_NETEASE,
        cookie,
    )
    .await
    .unwrap_or(Value::Null);

    Ok(json!({
        "source": "netease",
        "id": id,
        "song": {
            "name": s(&detail, "/songs/0/name"),
            "artists": names(detail.pointer("/songs/0/artists"), "name"),
            "album": s(&detail, "/songs/0/album/name"),
            "cover": https_url(&s(&detail, "/songs/0/album/picUrl")),
            "durationSec": n(&detail, "/songs/0/duration") / 1000,
        },
        "lyric": lyric,
        "trans": s(&data, "/tlyric/lyric"),
    }))
}

async fn qq_fetch(client: &reqwest::Client, mid: &str, cookie: &str) -> Result<Value, String> {
    let url = format!(
        "https://c.y.qq.com/lyric/fcgi-bin/fcg_query_lyric_new.fcg?songmid={mid}&format=json&nobase64=1"
    );
    let data = get_json(client, &url, DEFAULT_UA, REFER_QQ, cookie).await?;

    let retcode = n(&data, "/retcode");
    if retcode != 0 {
        return Err(format!(
            "QQ 音乐接口返回错误码 {retcode}（歌曲可能已下架，或需要先填 Cookie）"
        ));
    }

    let lyric = html_unescape(&s(&data, "/lyric"));
    if lyric.trim().is_empty() {
        return Err("接口没有返回歌词（可能是纯音乐）".to_string());
    }
    if is_pure_music(&lyric) {
        return Err(PURE_MUSIC.to_string());
    }

    let detail = get_json(
        client,
        &format!(
            "https://c.y.qq.com/v8/fcg-bin/fcg_play_single_song.fcg?songmid={mid}&format=json&platform=yqq&needNewCode=0"
        ),
        DEFAULT_UA,
        REFER_QQ,
        cookie,
    )
    .await
    .unwrap_or(Value::Null);

    Ok(json!({
        "source": "qq",
        "id": mid,
        "song": {
            "name": s(&detail, "/data/0/name"),
            "artists": names(detail.pointer("/data/0/singer"), "name"),
            "album": s(&detail, "/data/0/album/name"),
            "cover": qq_cover(&s(&detail, "/data/0/album/mid")),
            "durationSec": n(&detail, "/data/0/interval"),
        },
        "lyric": lyric,
        // QQ 的翻译歌词经常是空的（实测多数歌就是空串），有就用，没有就照实说
        "trans": html_unescape(&s(&data, "/trans")),
    }))
}

/// 纯音乐占位歌词（移植自 163MusicLyrics 的 `IsPureMusic`）
fn is_pure_music(raw: &str) -> bool {
    raw.contains("纯音乐，请欣赏") || raw.contains("此歌曲为没有填词的纯音乐")
}

/// QQ 的歌词经过 HTML 转义（`&apos;` `&#39;` 等）。
///
/// 163MusicLyrics 走 XML 解析，实体是解析器顺手解掉的；这里拿到的是 JSON 字符串，
/// 只能自己反转义，否则存下来的歌词里会留一堆 `&apos;`。
fn html_unescape(input: &str) -> String {
    if !input.contains('&') {
        return input.to_string();
    }
    let chars: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '&' {
            if let Some(end) = chars[i..].iter().position(|c| *c == ';').map(|p| i + p) {
                let entity: String = chars[i + 1..end].iter().collect();
                let decoded = match entity.as_str() {
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    "nbsp" => Some(' '),
                    _ => {
                        let code = if let Some(hex) = entity
                            .strip_prefix("#x")
                            .or_else(|| entity.strip_prefix("#X"))
                        {
                            u32::from_str_radix(hex, 16).ok()
                        } else {
                            entity.strip_prefix('#').and_then(|d| d.parse::<u32>().ok())
                        };
                        code.and_then(char::from_u32)
                    }
                };
                if let Some(c) = decoded {
                    out.push(c);
                    i = end + 1;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/* ══════════════════════════════ 链接解析 ══════════════════════════════ */

/// 从粘贴的链接 / 编号里认出 `(来源, id)`。
///
/// ⚠️ **必须先判 songmid 再判 `id=`**：QQ 的 `...?songmid=0039MnYb0qxYhV` 里那句
/// `songmid=0039...` 会被 `id=(\d+)` 先匹配走，于是 songmid 变成网易云 id `0039`。
/// 这个坑实测踩过，顺序不能调。
pub fn parse_link(input: &str) -> Result<(String, String), String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err("请粘贴歌曲链接或歌曲编号".to_string());
    }

    // 1. QQ：显式 songmid 参数（放在最前面，见上面的注释）
    if let Some(mid) = param_value(raw, "songmid") {
        if looks_like_mid(&mid) {
            return Ok(("qq".to_string(), mid));
        }
    }
    // 2. QQ：/songDetail/<songmid> 这种路径
    if raw.contains("qq.com") {
        if let Some(mid) = segment_after(raw, "songDetail/") {
            if looks_like_mid(&mid) {
                return Ok(("qq".to_string(), mid));
            }
        }
    }
    // 3. 网易云：?id=<数字>
    if let Some(id) = param_value(raw, "id") {
        if !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()) {
            return Ok(("netease".to_string(), id));
        }
    }
    // 4. 纯数字 → 网易云 id
    if raw.chars().all(|c| c.is_ascii_digit()) {
        return Ok(("netease".to_string(), raw.to_string()));
    }
    // 5. 裸 songmid（14 位左右的字母数字）
    if looks_like_mid(raw) {
        return Ok(("qq".to_string(), raw.to_string()));
    }

    Err("无法识别的链接。支持：网易云歌曲链接 / 歌曲 ID，或 QQ 音乐的 songDetail 链接 / songmid".to_string())
}

/// `?name=值` 或 `&name=值`
fn param_value(url: &str, name: &str) -> Option<String> {
    for sep in ['?', '&'] {
        let needle = format!("{sep}{name}=");
        if let Some(idx) = url.find(&needle) {
            let rest = &url[idx + needle.len()..];
            let value: String = rest
                .chars()
                .take_while(|c| !matches!(c, '&' | '#' | '/' | '?' | ' '))
                .collect();
            if !value.is_empty() {
                return Some(value);
            }
        }
    }
    None
}

/// 固定路径片段后面那一段字母数字
fn segment_after(url: &str, prefix: &str) -> Option<String> {
    let idx = url.find(prefix)? + prefix.len();
    let value: String = url[idx..]
        .chars()
        .take_while(|c| c.is_ascii_alphanumeric())
        .collect();
    if value.is_empty() {
        None
    } else {
        Some(value)
    }
}

/// QQ 的 songmid 形如 `0039MnYb0qxYhV`：字母数字混排、长度十来位。
/// 要求至少有一个字母，免得把纯数字的网易云 id 认成 songmid。
fn looks_like_mid(text: &str) -> bool {
    let len = text.chars().count();
    (5..=30).contains(&len)
        && text.chars().all(|c| c.is_ascii_alphanumeric())
        && text.chars().any(|c| c.is_ascii_alphabetic())
}

/* ══════════════════════════════ 封面下载 ══════════════════════════════ */

/// 下载封面到 `dest`，返回写出的字节数。
pub async fn download_cover(cfg: &Value, url: &str, dest: &Path) -> Result<u64, String> {
    let client = client(cfg)?;
    let referer = if url.contains("qq.com") || url.contains("gtimg.cn") {
        REFER_QQ_ROOT
    } else {
        REFER_NETEASE
    };
    let bytes = get_bytes(&client, url, DEFAULT_UA, referer, "").await?;
    if bytes.is_empty() {
        return Err("下载到的封面是空的".to_string());
    }
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    std::fs::write(dest, &bytes).map_err(|e| format!("写入失败：{e}"))?;
    Ok(bytes.len() as u64)
}

/* ══════════════════════════ 短信验证码登录（网易云） ══════════════════════════ */

/// 问一下「现在登录的是谁」，只为把界面徽章写成「已登录为 xxx」。
///
/// 只用昵称（原 `account_info` 还回头像与 userId，没人用，已删）。
/// 没登录时接口回 `{"code":200,"account":null,"profile":null}`（实测），所以全程当可空处理；
/// 失败就回空串 —— 它只是装饰，不该让登录本身报错。
pub async fn account_nickname(cfg: &Value) -> Result<String, String> {
    let cookie = cookie_of(cfg, "netease");
    if cookie.is_empty() {
        return Ok(String::new());
    }
    let json = get_json(
        &client(cfg)?,
        "https://music.163.com/api/w/nuser/account/get",
        DEFAULT_UA,
        REFER_NETEASE,
        &cookie,
    )
    .await?;

    // 昵称的落点在不同版本里有 profile.nickname / profile.userName 两种，都认
    let nickname = s(&json, "/profile/nickname");
    Ok(if nickname.is_empty() { s(&json, "/profile/userName") } else { nickname })
}

/// 短信登录的路子（`/api/sms/captcha/sent` + `/api/w/login/cellphone`）**全是明文**，
/// 实测不需要任何加密：发码接口直接回 `{"code":200,"data":true}`；
/// 登录接口用假验证码回 `{"msg":"验证码错误","code":503}`（**没有** "ENC" 那一套）。
/// 对照组 `/api/login/cellphone` 才回 `{"code":401,"message":"无权限访问. ENC"}` —— 别换回去。
///
/// 它是网易云唯一还能用的登录路：扫码那条真机实测始终被 8821 挡掉（服务端风控），已整体移除。
///
/// 手机号只认「1 开头 + 11 位数字」。
///
/// 这层校验是**发短信前的第一道闸**：格式不对就地报错，绝不让请求出网。
/// 实测拿假验证码登录都只是报错，但发码接口是真会发短信的 —— 谁也不想给陌生人发。
pub fn phone_ok(phone: &str) -> bool {
    phone.len() == 11 && phone.starts_with('1') && phone.chars().all(|c| c.is_ascii_digit())
}

/// 号码存在性：`Ok(None)` 是「没查出来」（网络/风控失败，不该拦住后续操作），
/// `Ok(Some(true/false))` 是网易云明确回答「有 / 没有」。
///
/// 存在的号回 `{"exist":1,"nickname":"****","hasPassword":true}`（昵称是打码的，别外传）。
/// ponytail: 风控时这里会整天回「没查出来」，那就退化成「直接发码、让发码接口报错」，功能不受影响。
pub async fn phone_exists(cfg: &Value, phone: &str) -> Result<Option<bool>, String> {
    if !phone_ok(phone) {
        return Err("手机号格式错误：需要 11 位数字且以 1 开头".to_string());
    }
    let client = client(cfg)?;
    let json = get_json(
        &client,
        &format!("https://music.163.com/api/w/cellphone/existence/check?cellphone={phone}"),
        DEFAULT_UA,
        REFER_NETEASE,
        "",
    )
    .await?;

    match json.get("exist").and_then(|v| v.as_i64()) {
        Some(1) => Ok(Some(true)),
        // 明确是 0 才算「没有这个号」
        Some(0) => Ok(Some(false)),
        // 有的变体会用 true/false
        None if json.get("exist").and_then(|v| v.as_bool()) == Some(true) => Ok(Some(true)),
        None if json.get("exist").and_then(|v| v.as_bool()) == Some(false) => Ok(Some(false)),
        // 其余一律当「没查出来」，别把风控当成「号码不存在」把用户拦在门外
        _ => Ok(None),
    }
}

/// 发短信验证码，返回网易云的响应体。
///
/// ⚠️ **这个接口真会发短信。** 测试时只能用明显非法的格式（例如 `123`），
/// 让它停在参数校验上；不要用真实、或长得像真的手机号去试。
pub async fn sms_send(cfg: &Value, phone: &str) -> Result<Value, String> {
    if !phone_ok(phone) {
        return Err("手机号格式错误：需要 11 位数字且以 1 开头".to_string());
    }
    let client = client(cfg)?;
    get_json(
        &client,
        &format!("https://music.163.com/api/sms/captcha/sent?cellphone={phone}&ctcode=86"),
        DEFAULT_UA,
        REFER_NETEASE,
        "",
    )
    .await
}

/// 手机号 + 短信验证码登录，返回登录后的整条 Cookie 串（`MUSIC_U=…; __csrf=…`）。
pub async fn cellphone_login(cfg: &Value, phone: &str, captcha: &str) -> Result<String, String> {
    if !phone_ok(phone) {
        return Err("手机号格式错误：需要 11 位数字且以 1 开头".to_string());
    }
    if captcha.trim().is_empty() {
        return Err("请先填验证码".to_string());
    }
    let captcha = crate::net::encode_component(captcha.trim());

    let client = client(cfg)?;
    let url = format!(
        "https://music.163.com/api/w/login/cellphone?phone={phone}&captcha={captcha}&countrycode=86"
    );
    let res = client
        .get(&url)
        .header("User-Agent", DEFAULT_UA)
        .header("Referer", REFER_NETEASE)
        .header("Origin", "https://music.163.com")
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                format!("请求超时（20 秒）：{url}")
            } else {
                format!("网络请求失败：{e}")
            }
        })?;

    let status = res.status().as_u16();
    // 登录成功时网易云是在响应头里下发 Cookie 的 —— 先把头摘下来，body 解析失败也不丢
    let from_header = cookie_from_set_cookie(res.headers());
    let text = res.text().await.unwrap_or_default();
    let json: Value = serde_json::from_str(&text).unwrap_or(Value::Null);

    // 1) 响应体里的 cookie（老版接口的形状），2) Set-Cookie 响应头（现在多半走这条）
    for candidate in [s(&json, "/cookie"), from_header] {
        if candidate.contains("MUSIC_U") {
            return Ok(candidate);
        }
    }

    Err(login_error(&json, &text, status))
}

/// 登录失败时说清楚发生了什么。
///
/// 优先级刻意是「网易云自己的话 → 已知错误码的大白话 → 原始响应截断」：
/// 把未知情况压成一句「登录失败」等于把排查能力丢掉，原始响应片段必须带出来。
fn login_error(json: &Value, text: &str, status: u16) -> String {
    let code = n(json, "/code");
    let their = {
        let m = s(json, "/message");
        if m.is_empty() {
            s(json, "/msg")
        } else {
            m
        }
    };

    // 明文接口走错版本时网易云会甩 ENC（这个接口实测不会，但留着能一眼看出被改过）
    if their.contains("ENC") {
        return format!("网易云要求加密（ENC 报错），这个接口已经不能明文调用了：{their}");
    }
    if !their.is_empty() {
        let head = if code != 0 {
            format!("网易云：{their}（code {code}）")
        } else {
            format!("网易云：{their}")
        };
        // 知道码的时候补一句人话，省得用户去猜 503 是什么
        return match code {
            503 => format!("{head}　验证码不对，或已经过期（重新发一条再试）"),
            501 | 502 => format!("{head}　手机号或验证码格式不对"),
            400 => format!("{head}　这个号码在网易云没有注册过"),
            _ => head,
        };
    }
    // 连 message/msg 都没有：把原始响应截一段出来，比一句「失败」有用得多
    let raw = if text.trim().is_empty() {
        json.to_string()
    } else {
        text.trim().to_string()
    };
    let head: String = raw.chars().take(200).collect();
    format!("登录失败（HTTP {status}），网易云没有给出原因，原始响应：{head}")
}

/// 从 Set-Cookie 响应头拼 Cookie 请求头。
///
/// 只收 `名字=值`，`Path` / `Domain` / `Expires` 这些属性丢掉（塞进请求头是错的，
/// 而且 `Expires` 里带逗号，整段拼进去能把 Cookie 头弄废）。
fn cookie_from_set_cookie(headers: &reqwest::header::HeaderMap) -> String {
    let mut pairs: Vec<String> = Vec::new();
    for value in headers.get_all(reqwest::header::SET_COOKIE).iter() {
        let Ok(raw) = value.to_str() else { continue };
        let Some(first) = raw.split(';').next() else { continue };
        let Some((name, val)) = first.split_once('=') else { continue };
        let (name, val) = (name.trim(), val.trim());
        if name.is_empty() || val.is_empty() || name.eq_ignore_ascii_case("path") {
            continue;
        }
        let pair = format!("{name}={val}");
        if !pairs.contains(&pair) {
            pairs.push(pair);
        }
    }
    pairs.join("; ")
}

/* ══════════════════════════════ LRC / SRT ══════════════════════════════ */

/// 解析一个时间标签的时间值（毫秒）：`[mm:ss]` `[mm:ss.SS]` `[mm:ss:SS]` `[mm:ss:SS.SSS]` `[mm]`。
///
/// 移植自 163MusicLyrics（Core/Models/MusicLyricsVO.cs 的 `LyricTimestamp`）：
/// 毫秒位 1 位 ×100、2 位 ×10、3 位以上取前 3 位 —— 少乘一次就整整差一个数量级。
fn parse_timestamp(tag: &str) -> Option<u64> {
    let inner = tag.strip_prefix('[')?.strip_suffix(']')?;
    let parts: Vec<&str> = inner.split(':').collect();
    let minutes: u64 = parts.first()?.trim().parse().ok()?;
    if parts.len() < 2 {
        return Some(minutes * 60_000);
    }

    let (secs_text, frac_text) = match parts[1].split_once('.') {
        Some((a, b)) => (a, Some(b)),
        None => (parts[1], parts.get(2).copied()),
    };
    let secs: u64 = secs_text.trim().parse().ok()?;
    let frac: String = frac_text
        .unwrap_or("")
        .rsplit('.')
        .next()
        .unwrap_or("")
        .chars()
        .take(3)
        .collect();
    let ms = match frac.len() {
        0 => 0,
        1 => frac.parse::<u64>().ok()? * 100,
        2 => frac.parse::<u64>().ok()? * 10,
        _ => frac.parse::<u64>().ok()?,
    };
    Some(minutes * 60_000 + secs * 1000 + ms)
}

/// 一行歌词 → 若干 (毫秒, 正文)。一行可以有多个时间戳（`[00:12.00][01:20.00]歌词`）。
/// 元信息行（`[ti:]` `[ar:]` 等）没有正文，自然被丢掉。
fn parse_line(line: &str) -> Vec<(u64, String)> {
    let mut rest = line.trim();
    let mut times = Vec::new();
    while rest.starts_with('[') {
        let Some(end) = rest.find(']') else { break };
        // 注意切片要**带上**方括号：parse_timestamp 认的是 `[mm:ss]` 整体
        let tag = &rest[..=end];
        if let Some(ms) = parse_timestamp(tag) {
            times.push(ms);
        }
        rest = &rest[end + 1..];
    }
    let content = rest.trim();
    if times.is_empty() || content.is_empty() {
        return Vec::new();
    }
    times
        .into_iter()
        .map(|ms| (ms, content.to_string()))
        .collect()
}

/// 整段歌词 → 按时间排序的 `(毫秒, 正文)`。
///
/// `source == "qq"` 时套用 163MusicLyrics 的 QQ 处理：`[offset:0]` 与 `[kana:` 是
/// 「正文从这里开始」的分隔标记，出现在它们之前的内容属于另一个版本的歌词头，要丢掉。
pub fn parse_lrc(raw: &str, source: &str) -> Vec<(u64, String)> {
    let normalized = raw.replace("\r\n", "\n").replace('\r', "\n");
    let mut out: Vec<(u64, String)> = Vec::new();
    for line in normalized.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if source == "qq" && (line == "[offset:0]" || line.starts_with("[kana:")) {
            out.clear();
            continue;
        }
        for item in parse_line(line) {
            if is_illegal(&item.1) {
                continue;
            }
            out.push(item);
        }
    }
    out.sort_by_key(|(ms, _)| *ms);
    out
}

/// 没有实际内容的行（移植自 163MusicLyrics 的 `LyricLineVo.IsIllegalContent`）
fn is_illegal(content: &str) -> bool {
    let t = content.trim();
    t.is_empty() || t == "//"
}

/// 毫秒 → SRT 时间戳 `HH:MM:SS,mmm`（163MusicLyrics 默认的 `SrtTimestampFormat`）
fn srt_time(ms: u64) -> String {
    format!(
        "{:02}:{:02}:{:02},{:03}",
        ms / 3_600_000,
        ms / 60_000 % 60,
        ms / 1000 % 60,
        ms % 1000
    )
}

/// 找这个时间戳的译文：先精确匹配，再容忍 ±50ms 的抖动。
///
/// 「译文精度误差」的想法来自 163MusicLyrics（Core/Utils/LyricUtils.cs 的
/// `ResolveTransLyricDigitDeviationAndLost`，它把误差做成可配项）——实测网易云的
/// 译文时间戳偶尔和原文差个几毫秒，固定 50ms 的容忍够用，且不会错配到隔壁句。
fn pick_trans(list: &[(u64, String)], ms: u64) -> Option<String> {
    if let Some((_, text)) = list.iter().find(|(n, _)| *n == ms) {
        return Some(text.clone());
    }
    list.iter()
        .find(|(n, _)| n.abs_diff(ms) <= 50)
        .map(|(_, text)| text.clone())
}

/// 行首第一个真正的时间标签（沿用原文的写法，不重新格式化）
fn first_tag(line: &str) -> Option<String> {
    let stripped = line.trim_start().strip_prefix('[')?;
    let end = stripped.find(']')?;
    let tag = format!("[{}]", &stripped[..end]);
    parse_timestamp(&tag).map(|_| tag)
}

/// 原文 + 译文合成双语 LRC：译文行插在原文行后面，沿用原文那行的时间标签。
///
/// 163MusicLyrics 有 MERGE（同一时间戳合并成一行，中间放分隔符）与 STAGGER（交错成
/// 两行）两种模式，这里只做 STAGGER —— 同一时间戳连写两行是播放器通用认的双语写法，
/// 合并成一行会把原文和译文挤在一起，对着歌词翻调时反而难读。
/// ponytail: 要 MERGE 就在这里把两段用分隔符拼起来，界面和路由都不用动。
pub fn merge_lrc(raw: &str, trans: &str, source: &str) -> String {
    let trans_lines = parse_lrc(trans, source);
    if trans_lines.is_empty() {
        return raw.to_string();
    }
    let normalized = raw.replace("\r\n", "\n").replace('\r', "\n");
    let mut out = String::new();
    for line in normalized.lines() {
        out.push_str(line);
        out.push('\n');
        let Some(tag) = first_tag(line) else { continue };
        let Some(ms) = parse_timestamp(&tag) else { continue };
        if let Some(text) = pick_trans(&trans_lines, ms) {
            let text = text.trim();
            if !text.is_empty() {
                out.push_str(&tag);
                out.push_str(text);
                out.push('\n');
            }
        }
    }
    out
}

/// LRC → SRT。给了 `trans` 就做双语字幕（同一时间戳的译文放在原文下面一行）。
///
/// 结束时间取「后面第一个更晚的时间戳」，最后一句取歌曲时长（拿不到就 +4 秒）。
/// 这条规则移植自 163MusicLyrics 的 `SrtUtils.LrcToSrt`：时间戳相同的多行（双语正是
/// 这种）要收在同一个结束时间上，否则后一行会把前一行顶成零长度字幕。
pub fn lrc_to_srt(raw: &str, trans: Option<&str>, source: &str, duration_sec: u64) -> String {
    let lines = parse_lrc(raw, source);
    if lines.is_empty() {
        return String::new();
    }
    let trans_lines = trans.map(|t| parse_lrc(t, source)).unwrap_or_default();

    let last = lines.last().map(|(ms, _)| *ms).unwrap_or(0);
    let song_end = if duration_sec > 0 {
        duration_sec * 1000
    } else {
        last + 4000
    };

    let mut out = String::new();
    for (i, (ms, text)) in lines.iter().enumerate() {
        let end = lines[i + 1..]
            .iter()
            .map(|(n, _)| *n)
            .find(|n| n > ms)
            .unwrap_or_else(|| song_end.max(ms + 1000));

        out.push_str(&format!(
            "{}\n{} --> {}\n{}\n",
            i + 1,
            srt_time(*ms),
            srt_time(end),
            text
        ));
        if let Some(tr) = pick_trans(&trans_lines, *ms) {
            let tr = tr.trim();
            if !tr.is_empty() && tr != text.trim() {
                out.push_str(tr);
                out.push('\n');
            }
        }
        out.push('\n');
    }
    out
}

/// 给保存接口用：把歌词正文按格式转好。返回（文件内容, 扩展名）。
///
/// 编码一律 UTF-8 无 BOM：老播放器有只认 GBK 的，但 UTF-8 更通用，界面上不提供选择。
/// ponytail: 真需要 GBK 时在这里加一次转码（要引编码库），路由与前端都不用改。
pub fn render(
    format: &str,
    lyric: &str,
    trans: &str,
    source: &str,
    duration_sec: u64,
    bilingual: bool,
) -> Result<(String, &'static str), String> {
    let trans = if bilingual && !trans.trim().is_empty() {
        Some(trans)
    } else {
        None
    };
    match format {
        "srt" => Ok((lrc_to_srt(lyric, trans, source, duration_sec), "srt")),
        "lrc" => {
            let text = match trans {
                Some(t) => merge_lrc(lyric, t, source),
                None => format!("{}\n", lyric.replace("\r\n", "\n").trim_end()),
            };
            Ok((text, "lrc"))
        }
        other => Err(format!("不支持的格式：{other}（只支持 lrc / srt）")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_every_timestamp_shape_the_reference_supports() {
        assert_eq!(parse_timestamp("[00:12.00]"), Some(12_000));
        assert_eq!(parse_timestamp("[01:02.5]"), Some(62_500));
        assert_eq!(parse_timestamp("[01:02.345]"), Some(62_345));
        assert_eq!(parse_timestamp("[01:02:345]"), Some(62_345));
        assert_eq!(parse_timestamp("[01:02:34.567]"), Some(62_567));
        assert_eq!(parse_timestamp("[02:03]"), Some(123_000));
        assert_eq!(parse_timestamp("[03]"), Some(180_000));
        // 毫秒位超过 3 位只取前 3 位
        assert_eq!(parse_timestamp("[00:01.2345]"), Some(1_234));
        assert_eq!(parse_timestamp("[ti:晴天]"), None);
    }

    #[test]
    fn parses_lrc_lines_and_skips_metadata() {
        let raw = "[ti:晴天]\n[ar:周杰伦]\n[00:12.00]故事的小黄花\n[00:15.50][01:20.00]从出生那年就飘着\n";
        let lines = parse_lrc(raw, "netease");
        assert_eq!(
            lines,
            vec![
                (12_000, "故事的小黄花".to_string()),
                (15_500, "从出生那年就飘着".to_string()),
                (80_000, "从出生那年就飘着".to_string()),
            ]
        );
    }

    #[test]
    fn qq_header_before_offset_marker_is_dropped() {
        // QQ 的响应里 [offset:0] 之前的都是另一个版本的头，实测确实会带这种垃圾
        let raw = "[00:01.00]旧的错误歌词\n[offset:0]\n[00:12.00]真正的歌词\n";
        let lines = parse_lrc(raw, "qq");
        assert_eq!(lines, vec![(12_000, "真正的歌词".to_string())]);
        // 网易云不做这个处理
        assert_eq!(parse_lrc(raw, "netease").len(), 2);
    }

    #[test]
    fn lrc_to_srt_uses_next_distinct_timestamp_as_end() {
        let raw = "[00:01.00]第一句\n[00:03.00]第二句\n[00:03.00]第二句译文\n";
        let srt = lrc_to_srt(raw, None, "netease", 10);
        let lines: Vec<&str> = srt.lines().collect();
        assert_eq!(lines[0], "1");
        assert_eq!(lines[1], "00:00:01,000 --> 00:00:03,000");
        assert_eq!(lines[2], "第一句");
        // 时间戳相同的两行收在同一个结束时间（歌曲时长）上
        assert_eq!(lines[4], "2");
        assert_eq!(lines[5], "00:00:03,000 --> 00:00:10,000");
        assert_eq!(lines[8], "3");
        assert_eq!(lines[9], "00:00:03,000 --> 00:00:10,000");
    }

    #[test]
    fn lrc_to_srt_puts_translation_under_the_original() {
        let srt = lrc_to_srt(
            "[00:01.00]hello\n[00:03.00]world\n",
            Some("[00:01.00]你好\n"),
            "netease",
            8,
        );
        assert!(srt.contains("1\n00:00:01,000 --> 00:00:03,000\nhello\n你好\n"));
        // 没有译文的行不补空行
        assert!(srt.contains("2\n00:00:03,000 --> 00:00:08,000\nworld\n\n"));
    }

    #[test]
    fn netease_cookie_gets_its_name_back_when_only_the_value_was_pasted() {
        // 界面上教的取法是从开发者工具里双击 Value 列复制 —— 拿到的没有 `MUSIC_U=`
        let bare = json!({ "neteaseCookie": "abc123" });
        assert_eq!(cookie_of(&bare, "netease"), "MUSIC_U=abc123");
        // 已经有名字的（单段或整行）原样不动
        let named = json!({ "neteaseCookie": "MUSIC_U=abc123" });
        assert_eq!(cookie_of(&named, "netease"), "MUSIC_U=abc123");
        let full = json!({ "neteaseCookie": "MUSIC_U=abc123; __csrf=xyz" });
        assert_eq!(cookie_of(&full, "netease"), "MUSIC_U=abc123; __csrf=xyz");
        // 空值仍然是空：不能凭空造一个 MUSIC_U= 出来
        assert_eq!(cookie_of(&json!({}), "netease"), "");
        // QQ 不做这个补全（它的 Cookie 本来就不止一个键）
        assert_eq!(cookie_of(&json!({ "qqCookie": "abc" }), "qq"), "abc");
    }

    /// 网易云/QQ 的每个请求都走 `get_text`，而它跑的是 HTTPS —— 明文头抓不到。
    /// 所以拿本机一个 TCP 监听假装目标站点，直接看发出去的请求行里有没有 Cookie。
    #[tokio::test]
    async fn get_text_puts_the_cookie_into_the_request_header() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let server = tokio::spawn(async move {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut head = String::new();
            let mut buf = [0u8; 1024];
            while !head.contains("\r\n\r\n") {
                let n = sock.read(&mut buf).await.unwrap();
                if n == 0 {
                    break;
                }
                head.push_str(&String::from_utf8_lossy(&buf[..n]));
            }
            sock.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                .await
                .unwrap();
            head
        });

        let cfg = json!({ "neteaseCookie": "MUSIC_U=abc123" });
        let sent = get_text(
            &client(&cfg).unwrap(),
            &format!("http://{addr}/api/cloudsearch/pc?s=x"),
            DEFAULT_UA,
            REFER_NETEASE,
            &cookie_of(&cfg, "netease"),
        )
        .await
        .unwrap();
        assert_eq!(sent, "{}");

        let head = server.await.unwrap();
        // hyper 发出去的头名是小写的
        assert!(
            head.to_lowercase().contains("cookie: music_u=abc123\r\n"),
            "请求头里没带上 Cookie：{head}"
        );
    }

    #[test]
    fn merges_bilingual_lrc_with_the_original_tag() {
        let merged = merge_lrc(
            "[ti:x]\n[00:12.00]原文\n[00:15.00]第二句\n",
            "[00:12.00]译文\n",
            "netease",
        );
        assert_eq!(
            merged,
            "[ti:x]\n[00:12.00]原文\n[00:12.00]译文\n[00:15.00]第二句\n"
        );
    }

    #[test]
    fn render_picks_format_and_extension() {
        let lrc = "[00:01.00]hello\n";
        let (text, ext) = render("lrc", lrc, "", "netease", 0, true).unwrap();
        assert_eq!(ext, "lrc");
        assert_eq!(text, lrc);

        let (text, ext) = render("srt", lrc, "[00:01.00]译文", "netease", 5, true).unwrap();
        assert_eq!(ext, "srt");
        assert!(text.contains("00:00:01,000 --> 00:00:05,000\nhello\n译文"));

        // 关掉双语就不带译文
        let (text, _) = render("srt", lrc, "[00:01.00]译文", "netease", 5, false).unwrap();
        assert!(!text.contains("译文"));

        assert!(render("ass", lrc, "", "netease", 0, true).is_err());
    }

    #[test]
    fn detects_pure_music_placeholders() {
        assert!(is_pure_music("[00:00.00]纯音乐，请欣赏"));
        assert!(is_pure_music("此歌曲为没有填词的纯音乐，请您欣赏"));
        assert!(!is_pure_music("[00:01.00]故事的小黄花"));
    }

    #[test]
    fn only_accepts_11_digit_mobile_numbers() {
        assert!(phone_ok("13800000000"));
        assert!(phone_ok("19912345678"));
        // 这几条是「绝不把请求发出去」的闸门：格式不对就地报错
        assert!(!phone_ok("123"));
        assert!(!phone_ok("1380000000"));
        assert!(!phone_ok("138000000000"));
        assert!(!phone_ok("23800000000"));
        assert!(!phone_ok("1380000000a"));
        assert!(!phone_ok(""));
        assert!(!phone_ok("+8613800000000"));
    }

    /// 登录成功多半是**响应头**下发的 Cookie（响应体里没有 cookie 字段），
    /// 这里确认能从 Set-Cookie 拼出请求头要用的那串，且不把属性混进去。
    #[test]
    fn builds_cookie_header_from_set_cookie() {
        use reqwest::header::{HeaderMap, HeaderValue, SET_COOKIE};
        let mut h = HeaderMap::new();
        h.append(
            SET_COOKIE,
            HeaderValue::from_static("MUSIC_U=abc123; Path=/; Domain=.music.163.com; HttpOnly"),
        );
        h.append(
            SET_COOKIE,
            HeaderValue::from_static("__csrf=xyz; Path=/; Expires=Wed, 21 Oct 2099 07:28:00 GMT"),
        );
        let c = cookie_from_set_cookie(&h);
        assert_eq!(c, "MUSIC_U=abc123; __csrf=xyz");
        // 没有 Set-Cookie 时给空串，调用方据此判断「没拿到」
        assert_eq!(cookie_from_set_cookie(&HeaderMap::new()), "");
    }

    #[test]
    fn login_error_always_says_something_useful() {
        // 实测过的那条：假验证码 → 503「验证码错误」
        let e = login_error(&json!({"msg":"验证码错误","code":503,"message":"验证码错误"}), "", 200);
        assert!(e.contains("验证码错误") && e.contains("503"), "{e}");

        // 走到加密版接口才会出现的 ENC：得一眼看出来，而不是当成普通失败
        let e = login_error(&json!({"msg":"无权限访问. ENC","code":401}), "", 200);
        assert!(e.contains("ENC"), "{e}");

        // 网易云什么都没说：原始响应必须带出来（把未知压成「失败」= 丢掉排查能力）
        let e = login_error(&Value::Null, "<html>waf blocked</html>", 403);
        assert!(e.contains("HTTP 403") && e.contains("waf blocked"), "{e}");
    }

    #[test]
    fn unescapes_qq_lyric_entities() {
        assert_eq!(html_unescape("It&apos;s ok"), "It's ok");
        assert_eq!(html_unescape("a&amp;b &#39;c&#x27;"), "a&b 'c'");
        assert_eq!(html_unescape("no entities"), "no entities");
    }

    #[test]
    fn parses_links_with_songmid_before_id() {
        assert_eq!(
            parse_link("https://music.163.com/#/song?id=186016").unwrap(),
            ("netease".to_string(), "186016".to_string())
        );
        assert_eq!(
            parse_link("https://music.163.com/song?id=186016").unwrap(),
            ("netease".to_string(), "186016".to_string())
        );
        assert_eq!(
            parse_link("https://y.qq.com/n/ryqq/songDetail/0039MnYb0qxYhV").unwrap(),
            ("qq".to_string(), "0039MnYb0qxYhV".to_string())
        );
        // 这一条是踩过的坑：songmid 必须比 id= 先判，否则拿到的是 "0039"
        assert_eq!(
            parse_link("https://i.y.qq.com/v8/playsong.html?songmid=0039MnYb0qxYhV").unwrap(),
            ("qq".to_string(), "0039MnYb0qxYhV".to_string())
        );
        assert_eq!(
            parse_link("186016").unwrap(),
            ("netease".to_string(), "186016".to_string())
        );
        assert_eq!(
            parse_link("0039MnYb0qxYhV").unwrap(),
            ("qq".to_string(), "0039MnYb0qxYhV".to_string())
        );
        assert!(parse_link("").is_err());
        assert!(parse_link("随便写点什么").is_err());
    }
}
