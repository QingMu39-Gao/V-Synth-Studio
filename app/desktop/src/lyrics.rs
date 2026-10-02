//! 网易云：搜索、歌词与详情抓取、封面下载、歌曲直链下载、短信验证码登录，
//! 以及 LRC ↔ SRT 转换。
//!
//! 分工：平台相关的请求与解析都在这里（和 `bili.rs` 一个位置），路由在
//! `server/lyrics.rs`，业务逻辑不碰 axum。
//!
//! 只有网易云一个来源：2026-10-02 起按用户要求删掉了 QQ 音乐（歌词页做成
//! 网易云专区），连带删掉 `QQ_UA` / `y.qq.com` 的两套接口与 songmid 链接解析。
//!
//! ── 出处说明 ──────────────────────────────────────────────
//! 以下三块**移植自 163MusicLyrics**（<https://github.com/jitwxs/163MusicLyrics>，
//! Apache-2.0，Copyright (c) jitwxs），已在对应函数上注明：
//!   - LRC 时间戳解析（`[mm:ss]` / `[mm:ss.SS]` / `[mm:ss:SS]` 等多种写法）
//!     —— Core/Models/MusicLyricsVO.cs 的 `LyricTimestamp`
//!   - LRC → SRT 的结束时间规则（同一时间戳的多行收在同一个结束时间上）
//!     —— Core/Utils/SrtUtils.cs 的 `LrcToSrt`
//!   - 译文按时间戳对齐 / 译文缺失与精度误差的处理思路、纯音乐与空行的判定
//!     —— Core/Utils/LyricUtils.cs、Core/Models/MusicLyricsVO.cs
//!
//! 接口选择没有照搬它：它走 `weapi` 加密链路（AES + RSA，见
//! NetEaseMusicNativeApi.cs 的 120 行加密代码），而实测明文接口
//! `/api/cloudsearch/pc`、`/api/song/lyric`、`/api/song/detail` 直接可用，
//! 于是这里按实测端点重写，省掉整套加密。
//! 登录它没有（它是手工填 Cookie），短信验证码登录这条完全按实测接口自己写。

use std::path::Path;
use std::time::Duration;

use futures_util::StreamExt;
use serde_json::{json, Value};

use crate::net::DEFAULT_UA;

const REFER_NETEASE: &str = "https://music.163.com/";

/// 纯音乐的占位歌词（移植自 163MusicLyrics 的 `IsPureMusic`）
const PURE_MUSIC: &str = "这首歌是纯音乐，没有歌词可导出";

/// 封面预览用的尺寸。网易云的 `picUrl` 是**原图**（实测 3000×3000、7.1 MB），
/// 列表里几十张一起加载会卡，所以统一在地址后拼 `?param={n}y{n}` 让服务端现缩。
/// 实测同一个封面：原图 7172604 B、`?param=300y300` 102216 B、`?param=500y500` 249916 B。
const COVER_PARAM: &str = "?param=500y500";

/* ══════════════════════════════════ 出站请求 ══════════════════════════════════ */

/// 建一个走配置代理的客户端。
///
/// 不用全局的 `net::client()`：那个没挂代理（它服务 B 站，用户给了 Cookie 就直连）。
/// 歌词这一页的操作都是用户手点出来的，一次几下，不值得为它维护客户端缓存。
/// ponytail: 每次新建客户端会多一次 TLS 握手；真嫌慢再按代理串缓存一个实例。
fn client(cfg: &Value) -> Result<reqwest::Client, String> {
    build_client(cfg, 20)
}

/// 下音频专用的客户端：只放宽超时，其余（代理、重定向）与 `client()` 一致。
///
/// ⚠️ 两个超时分工（2026-10-02 实测踩到，别删任何一个）：
/// - 总超时 10 分钟：给「整体多久还没下完」兜底。
/// - **`read_timeout` 60 秒：真正的关键**。它是「多久没收到新数据」才判死，
///   而不是整个请求的总时长 —— `client()` 那个 20 秒总超时对几 MB 的音频根本不够：
///   实测一首 320 kbps、9.8 MB 的歌单流传输要 **96 秒**，20 秒必被掐断，而且报出来的是
///   含糊的 `error decoding response body`。总超时放宽后仍怕「连上了但不发数据」，
///   所以留 60 秒读超时。
///
/// 前端给这个接口的超时也是 5 分钟（`api.ts` 的 `lyricsSong`）。
fn media_client(cfg: &Value) -> Result<reqwest::Client, String> {
    let mut builder = base_builder(cfg, 600)?;
    // 60 秒没收到新数据才判死；数据一直在流就不会超时
    builder = builder.read_timeout(Duration::from_secs(60));
    builder.build().map_err(|e| format!("HTTP 客户端创建失败：{e}"))
}

fn build_client(cfg: &Value, timeout_secs: u64) -> Result<reqwest::Client, String> {
    base_builder(cfg, timeout_secs)?
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败：{e}"))
}

fn base_builder(cfg: &Value, timeout_secs: u64) -> Result<reqwest::ClientBuilder, String> {
    let mut builder = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
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
    Ok(builder)
}

fn str_at(cfg: &Value, key: &str) -> String {
    cfg.get(key)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string()
}

fn cookie_of(cfg: &Value) -> String {
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
    let res = req.send().await.map_err(|e| network_hint(&e))?;
    let status = res.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("HTTP {status}：{url}"));
    }
    Ok(res.bytes().await.map_err(|e| network_hint(&e))?.to_vec())
}

/// 把响应**边到边写进文件**，返回写出的字节数。
///
/// 只给音频下载用（封面几百 KB，`get_bytes` 一把读完更简单）。这样写有两个好处：
/// 1. 几 MB 的音频不占内存，也不会因为「读完才写」而在中途失败时白下一个文件；
/// 2. 配合 `media_client()` 的 `read_timeout`，只要数据在流就不会被判超时。
async fn save_stream(
    client: &reqwest::Client,
    url: &str,
    ua: &str,
    referer: &str,
    cookie: &str,
    dest: &Path,
) -> Result<u64, String> {
    let mut req = client
        .get(url)
        .header("User-Agent", ua)
        .header("Referer", referer);
    if !cookie.is_empty() {
        req = req.header("Cookie", cookie);
    }
    let res = req.send().await.map_err(|e| network_hint(&e))?;
    let status = res.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("HTTP {status}：{url}"));
    }

    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    let mut file = std::fs::File::create(dest).map_err(|e| format!("打开文件失败：{e}"))?;
    let mut got: u64 = 0;
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| network_hint(&e))?;
        std::io::Write::write_all(&mut file, &chunk).map_err(|e| format!("写入失败：{e}"))?;
        got += chunk.len() as u64;
    }
    std::io::Write::flush(&mut file).map_err(|e| format!("写入失败：{e}"))?;
    Ok(got)
}

/// reqwest 的英文错误对用户没意义（`error decoding response body` 之类），换成能看懂的话。
fn network_hint(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "下载超时（网络太慢或连接被中断，再试一次）".to_string()
    } else if e.is_body() || e.is_decode() {
        "下载中断了（网络不稳定，再试一次通常就好）".to_string()
    } else {
        format!("网络请求失败：{e}")
    }
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

/// 网易云的封面地址有时是 http://，统一升成 https（下载与显示都省事），
/// 再拼上 `?param=` 缩小尺寸 —— 原图是 3000×3000、7 MB，列表里几十张加载不动。
/// 地址里已经有查询串的（理论上不会有）就不再拼，免得拼出两个 `?`。
fn cover_url(raw: &str) -> String {
    let url = https_url(raw);
    if url.is_empty() || url.contains('?') {
        url
    } else {
        format!("{url}{COVER_PARAM}")
    }
}

/* ══════════════════════════════════ 搜索 ══════════════════════════════════ */

/// 搜索歌曲，返回统一的形状：
/// `[{ id, name, artists, album, cover, durationSec, fee }]`
///
/// `fee` 是网易云自己的收费标记：0 免费、1 VIP、8 低音质免费（还有 4 等）。
/// ⚠️ **它不等于「能不能下载」** —— 实测同为 `fee=0` 的歌，有的能拿到直链、
/// 有的（版权受限）拿不到。所以这里只把它当标签展示，真正的判据是下载时
/// `netease_download` 那次 `player/url` 请求的返回。
pub async fn search(cfg: &Value, keyword: &str) -> Result<Vec<Value>, String> {
    let client = client(cfg)?;
    let cookie = cookie_of(cfg);
    netease_search(&client, keyword, &cookie).await
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

    let hits: Vec<Value> = songs
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
                "cover": cover_url(&s(song, "/al/picUrl")),
                "durationSec": n(song, "/dt") / 1000,
                "fee": n(song, "/fee"),
            }))
        })
        .collect();

    Ok(annotate_playable(client, cookie, hits).await)
}

/// 给搜索结果逐条标上「这个版本能不能拿到直链」（`playable`）。
///
/// 为什么要多打一次接口：用户实测「搜到的三首都不能下」，而**能不能下与 `fee` 无关**
/// （实测同为 `fee=0` 两种结果都有），只有真去打播放接口才知道。20 条**一次批量请求**
/// 就够（`ids` 收 JSON 数组），代价可接受；失败就整体不标（`playable` 留空），
/// 绝不让「探测失败」变成「搜索结果打不开」。
async fn annotate_playable(client: &reqwest::Client, cookie: &str, mut hits: Vec<Value>) -> Vec<Value> {
    if hits.is_empty() {
        return hits;
    }
    let ids = hits
        .iter()
        .map(|h| s(h, "/id"))
        .collect::<Vec<_>>()
        .join(",");
    let Ok(list) = fetch_media(client, cookie, &ids).await else {
        return hits;
    };

    for hit in hits.iter_mut() {
        let id = s(hit, "/id");
        let playable = list
            .iter()
            .find(|x| s(x, "/id") == id)
            .map(|x| !s(x, "/url").is_empty())
            .unwrap_or(false);
        if let Some(obj) = hit.as_object_mut() {
            obj.insert("playable".to_string(), Value::Bool(playable));
        }
    }
    hits
}

/* ══════════════════════════════ 歌词与详情 ══════════════════════════════ */

/// 取歌词：`{ source, id, song:{name,artists,album,cover,durationSec,fee}, lyric, trans }`
pub async fn fetch(cfg: &Value, id: &str) -> Result<Value, String> {
    let client = client(cfg)?;
    let cookie = cookie_of(cfg);
    netease_fetch(&client, id, &cookie).await
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
            "cover": cover_url(&s(&detail, "/songs/0/album/picUrl")),
            "durationSec": n(&detail, "/songs/0/duration") / 1000,
            "fee": n(&detail, "/songs/0/fee"),
        },
        "lyric": lyric,
        "trans": s(&data, "/tlyric/lyric"),
    }))
}

/// 纯音乐占位歌词（移植自 163MusicLyrics 的 `IsPureMusic`）
fn is_pure_music(raw: &str) -> bool {
    raw.contains("纯音乐，请欣赏") || raw.contains("此歌曲为没有填词的纯音乐")
}

/* ══════════════════════════════ 链接解析 ══════════════════════════════ */

/// 从粘贴的链接 / 编号里认出网易云歌曲 id。
///
/// 网易云的链接花样比想象中多：分享链接是 `/song?id=123`，也有 `/#/song?id=123`、
/// `music.163.com/song/123`、`?id=123&userid=...`。统一按「先找 `?id=` / `&id=`，
/// 再找 `/song/<数字>`，最后认纯数字」处理。
///
/// ⚠️ 2026-10-02 删掉 QQ 音乐时，这里原来的第 1、2、5 步（`?songmid=`、
/// `/songDetail/<mid>`、裸 songmid）也一起删了。**顺序坑的教训保留**：当初必须先判
/// songmid 再判 `id=`，否则 `?songmid=0039MnYb0qxYhV` 会被 `id=(\d+)` 抢走。
/// 将来若再加别的来源，仍然要先判它自己那个特征参数。
pub fn parse_link(input: &str) -> Result<(String, String), String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err("请粘贴歌曲链接或歌曲编号".to_string());
    }

    // 1. `?id=<数字>` / `&id=<数字>`
    if let Some(id) = param_value(raw, "id") {
        if !id.is_empty() && id.chars().all(|c| c.is_ascii_digit()) {
            return Ok(("netease".to_string(), id));
        }
    }
    // 2. `/song/<数字>` 这种路径
    if let Some(id) = segment_after(raw, "song/") {
        if id.chars().all(|c| c.is_ascii_digit()) {
            return Ok(("netease".to_string(), id));
        }
    }
    // 3. 纯数字 → 歌曲 id
    if raw.chars().all(|c| c.is_ascii_digit()) {
        return Ok(("netease".to_string(), raw.to_string()));
    }

    Err("无法识别的链接。支持：网易云歌曲链接（music.163.com/song?id=…）或歌曲 ID".to_string())
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

/* ══════════════════════════ 封面 / 歌曲直链下载 ══════════════════════════ */

/// 下载封面到 `dest`，返回写出的字节数。
///
/// **不带 Cookie**（实测封面 CDN 不校验登录态，带上反而多一份泄露面）。
pub async fn download_cover(cfg: &Value, url: &str, dest: &Path) -> Result<u64, String> {
    let client = client(cfg)?;
    let bytes = get_bytes(&client, url, DEFAULT_UA, REFER_NETEASE, "").await?;
    if bytes.is_empty() {
        return Err("下载到的封面是空的".to_string());
    }
    write_file(dest, &bytes)?;
    Ok(bytes.len() as u64)
}

/// 建目录 + 写文件，两处下载共用。
fn write_file(dest: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(dir) = dest.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("创建目录失败：{e}"))?;
    }
    std::fs::write(dest, bytes).map_err(|e| format!("写入失败：{e}"))
}

/// 统一的取直链入口：回包 `data` 那个数组，每项含 `url` / `level` / `br` / `type` /
/// `code` / `freeTrialPrivilege`。**下载与搜索结果的「能不能下」标注都走这里，参数只此一份。**
///
/// 参数形状照网页播放器抄：`ids` 要是 JSON 数组（下载传一个、搜索结果一次传 20 个），
/// `level` + `encodeType` 缺一不可（少了 `encodeType` 就退回旧接口行为，对免费账号大面积
/// 不回 url）。`exhigh` = 极高档，配合 `mp3` 实测回 320 kbps。
async fn fetch_media(client: &reqwest::Client, cookie: &str, ids: &str) -> Result<Vec<Value>, String> {
    let url = format!(
        "https://music.163.com/api/song/enhance/player/url/v1\
         ?ids=%5B{ids}%5D&level=exhigh&encodeType=mp3"
    );
    let data = get_json(client, &url, DEFAULT_UA, REFER_NETEASE, cookie).await?;
    Ok(data
        .pointer("/data")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default())
}

/// 拿一首歌的直链并下载到 `dest`，返回 `(写出的字节数, 实际下到的音质标签, 格式)`。
///
/// ── 为什么这么写（2026-10-02 实测记录，别照着「直觉」改） ────────────────
/// 老的 `music.163.com/song/media/outer/url?id=<id>.mp3` **已经废了**（302 到 404 页），
/// `/api/song/enhance/download/url` 明确回 `{"data":null,"code":301}` 要登录，
/// 而第三方解析站是侵权灰产 —— 都不碰。能用的是播放接口 `enhance/player/url/v1`。
///
/// 判据只能是这个接口的返回，**不能凭 `fee` 预判**：实测同为 `fee=0` 的歌两种结果都出现过。
/// 歌本身能不能听是平台的事，本工具只如实把结果告诉用户。
///
/// ⚠️⚠️ **2026-10-02 二次修正（关键，别改回去）** —— 最初那版实现（旧接口
/// `/api/song/enhance/player/url?id=X&ids=[X]&br=320000`，不带 `level`/`encodeType`）
/// **对免费账号大面积不回 url**：同一批 7 首里只 1 首成功。当时误判成「这些歌版权受限」，
/// 实际是**请求写法过时**。
///
/// - 网页播放器用的是 **`/api/song/enhance/player/url/v1` + `level` + `encodeType`**
///   （扒 `s3.music.126.net/web/s/core_*.js` 确认，见 `AGENTS.md` §十一）。换成 v1 之后
///   **同一批 7 首里 6 首全通**，`level=exhigh&encodeType=mp3` 回 320 kbps mp3。
/// - 所以「网页端能播、我们下不了」的绝大多数就是**请求写错**，先改参数再谈权益。
///
/// 换 v1 后仍然拿不到的，才是真受限：实测 `id=26096272`（千本桜）回 `code:-110` 且
/// `freeTrialPrivilege.userConsumable=false`，**免费账号确实拿不到**（它 fee=1）。
///
/// 直链自带 token，实测**不带 UA / 不带 Referer 也回 206**，走配置的代理同样通 ——
/// 所以下 CDN 那一跳只挂 UA，不挂 Cookie（登录 Cookie 是给 `/api/` 接口用的，cdn 不吃这套；
/// 不挂也少一份把 Cookie 发去 CDN 的风险）。但**取直链那一跳必须带 Cookie**：
/// v1 对已登录用户才按账号权益给 url。
///
/// 返回值是 (`字节数`, `音质文案`, `格式`)；格式由接口回包的 `type` 决定，不是写死 mp3。
pub async fn download_song(cfg: &Value, id: &str, dest: &Path) -> Result<(u64, String, String), String> {
    // 取直链是小请求，用普通超时；**下音频必须换成 media_client**（见那里的注释：
    // 20 秒装不下几 MB 的歌，会被掐成含糊的「error decoding response body」）
    let client = media_client(cfg)?;
    let cookie = cookie_of(cfg);

    let media = fetch_media(&client, &cookie, id)
        .await?
        .into_iter()
        .next()
        .unwrap_or(Value::Null);

    let direct = s(&media, "/url");
    if direct.is_empty() {
        return Err(no_direct_link_reason(&media));
    }

    // 边下边写（`save_stream`）。不用 `get_bytes`：几 MB 的音频没必要占内存，
    // 而且流式读才能配合 `media_client()` 的 read_timeout（数据在流就不算超时）。
    let size = save_stream(&client, &direct, DEFAULT_UA, REFER_NETEASE, "", dest).await?;
    if size == 0 {
        let _ = std::fs::remove_file(dest);
        return Err("下载到的音频是空的（直链可能已经失效，重试一次通常就好了）".to_string());
    }

    // 直链失效时 CDN 可能回一页 HTML 而不是音频。已经写下去了，读回头几个字节挡一下，
    // 别把错误页当成歌留在用户目录里
    if !file_looks_like_audio(dest) {
        let _ = std::fs::remove_file(dest);
        return Err("拿到的不是音频数据（直链可能已经过期，重试一次通常就好了）".to_string());
    }

    Ok((
        size,
        level_label(&s(&media, "/level"), n(&media, "/br")),
        format_of(&media),
    ))
}

/// 读文件头判断是不是音频（`looks_like_audio` 的按文件版本）。
fn file_looks_like_audio(dest: &Path) -> bool {
    use std::io::Read;
    let mut head = [0u8; 4];
    let Ok(mut f) = std::fs::File::open(dest) else {
        return false;
    };
    match f.read_exact(&mut head) {
        Ok(()) => looks_like_audio(&head),
        // 文件比 4 字节还短：不是音频
        Err(_) => false,
    }
}

/// 接口回包里的容器格式（`mp3` / `m4a` / `flac`），空则按 mp3 兜底。
fn format_of(media: &Value) -> String {
    let t = s(media, "/type");
    if t.is_empty() {
        "mp3".to_string()
    } else {
        t
    }
}

/// 拿不到直链时，按接口给的信息说清楚为什么。
///
/// 实测三条判据（`id=26096272` 这类「真受限」的样本）：
/// `code=-110` + `freeTrialPrivilege.userConsumable=false` + `fee=1`。而**未登录**时
/// 最常见的还是 `cannotListenReason=1`（先登录就能解决），所以两者分开说。
fn no_direct_link_reason(media: &Value) -> String {
    let reason = n(media, "/freeTrialPrivilege/cannotListenReason");
    let consumable = media
        .pointer("/freeTrialPrivilege/userConsumable")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let code = n(media, "/code");

    match reason {
        // 1 = 版权/付费受限；未登录时最多见，登录后多数能解
        1 => "这首歌拿不到下载地址：版权或付费受限。先在下面的「登录」里用短信登录或填 Cookie \
              再试一次；如果登录后还是拿不到，说明这个版本网易云不给免费账号，\
              换搜索结果里的另一个版本试试。"
            .to_string(),
        2 => "这首歌只有会员能听，没有可下载的直链。换搜索结果里的另一个版本试试。".to_string(),
        _ if !consumable || code == -110 => "这个版本网易云不给免费账号下载（要会员）。\
              搜索结果里同一首歌往往有好几个版本，换一个能下的试试。"
            .to_string(),
        _ => "网易云没有返回这首歌的下载地址（可能已下架，或需要登录）。".to_string(),
    }
}

/// 前几个字节看着像不像音频。
///
/// 认四种：`ID3`（带标签的 mp3）、`0xFF 0xEx`（裸 mp3 帧头）、`fLaC`、`OggS`。
/// 不是要当解码器，只是不想把 CDN 的错误页当 mp3 存下来。
fn looks_like_audio(bytes: &[u8]) -> bool {
    bytes.len() >= 4
        && (bytes.starts_with(b"ID3")
            || bytes.starts_with(b"fLaC")
            || bytes.starts_with(b"OggS")
            || (bytes[0] == 0xFF && bytes[1] & 0xE0 == 0xE0))
}

/// 把接口回的 `level` + `br` 说成人话，用于「已下载（320 kbps）」这类提示。
fn level_label(level: &str, br: i64) -> String {
    let name = match level {
        "standard" => "标准",
        "higher" => "较高",
        "exhigh" => "极高",
        "lossless" => "无损",
        "hires" => "Hi-Res",
        "jyeffect" => "沉浸环绕声",
        "sky" => "沉浸环绕声",
        "jymaster" => "超清母带",
        _ => "",
    };
    let kbps = if br > 0 { br / 1000 } else { 0 };
    match (name.is_empty(), kbps) {
        (false, k) if k > 0 => format!("{name} / {k} kbps"),
        (false, _) => name.to_string(),
        (true, k) if k > 0 => format!("{k} kbps"),
        _ => "未知音质".to_string(),
    }
}

/* ══════════════════════════ 短信验证码登录（网易云） ══════════════════════════ */

/// 问一下「现在登录的是谁」，只为把界面徽章写成「已登录为 xxx」。
///
/// 只用昵称（原 `account_info` 还回头像与 userId，没人用，已删）。
/// 没登录时接口回 `{"code":200,"account":null,"profile":null}`（实测），所以全程当可空处理；
/// 失败就回空串 —— 它只是装饰，不该让登录本身报错。
pub async fn account_nickname(cfg: &Value) -> Result<String, String> {
    let cookie = cookie_of(cfg);
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
/// 以前这里有个 `source` 参数，QQ 来源要额外处理 `[offset:0]` 与 `[kana:` 这两个
/// 「正文从这里开始」的分隔标记（出现在它们之前的内容属于另一个版本的歌词头，
/// 要丢掉）。删掉 QQ 之后网易云的歌词没有这种标记，参数也就一起去掉了。
/// ponytail: 将来再加来源、又碰到这种头，再把这个丢头逻辑加回来。
pub fn parse_lrc(raw: &str) -> Vec<(u64, String)> {
    let normalized = raw.replace("\r\n", "\n").replace('\r', "\n");
    let mut out: Vec<(u64, String)> = Vec::new();
    for line in normalized.lines() {
        let line = line.trim();
        if line.is_empty() {
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
pub fn merge_lrc(raw: &str, trans: &str) -> String {
    let trans_lines = parse_lrc(trans);
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
pub fn lrc_to_srt(raw: &str, trans: Option<&str>, duration_sec: u64) -> String {
    let lines = parse_lrc(raw);
    if lines.is_empty() {
        return String::new();
    }
    let trans_lines = trans.map(parse_lrc).unwrap_or_default();

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
    duration_sec: u64,
    bilingual: bool,
) -> Result<(String, &'static str), String> {
    let trans = if bilingual && !trans.trim().is_empty() {
        Some(trans)
    } else {
        None
    };
    match format {
        "srt" => Ok((lrc_to_srt(lyric, trans, duration_sec), "srt")),
        "lrc" => {
            let text = match trans {
                Some(t) => merge_lrc(lyric, t),
                None => format!("{}\n", lyric.replace("\r\n", "\n").trim_end()),
            };
            Ok((text, "lrc"))
        }
        other => Err(format!("不支持的格式：{other}（只支持 lrc / srt）")),
    }
}

/* ══════════════════════════════ 本地 LRC 导入 ══════════════════════════════ */

/// 读一个本地 LRC 文件，返回和 `fetch` **同样的形状** ——
/// 前端「搜歌」和「从文件导入」两条路共用一套预览 / 保存 / 带去 PV 的逻辑。
///
/// 编码：先按 UTF-8，读不出合法 UTF-8 再按 GBK(936) 重读（国内老 LRC 很多是 GBK，
/// 硬按 UTF-8 读就是满屏乱码，而用户看不出来是编码问题）。读的是哪一种如实回给界面。
pub fn import_file(path: &Path) -> Result<Value, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("读不了这个文件：{e}"))?;
    if bytes.is_empty() {
        return Err("这个文件是空的".to_string());
    }

    let (text, encoding) = decode_text(&bytes);
    let (lyric, trans) = split_bilingual(&text);
    if parse_lrc(&lyric).is_empty() {
        return Err("这个文件里没有可识别的时间轴，不像是 LRC 歌词".to_string());
    }

    Ok(json!({
        "source": "file",
        // id 用完整路径：界面上显示来源、以及以后要「打开所在目录」都用得上
        "id": path.to_string_lossy(),
        "song": {
            // 文件名当歌名（去掉 .lrc），保存和带去文字 PV 时就有名字可用
            "name": path.file_stem().map(|s| s.to_string_lossy().to_string()).unwrap_or_default(),
            "artists": "",
            "album": "",
            "cover": "",
            "durationSec": 0,
        },
        "lyric": lyric,
        "trans": trans,
        "encoding": encoding,
    }))
}

/// 按 UTF-8 读；不是合法 UTF-8 就按 GBK(936) 重读。返回（文本, 编码名）。
///
/// 判据用「是不是合法 UTF-8」而不是「替换字符占比」：合法就是零替换字符，
/// 非法就说明根本不是 UTF-8 —— 少一个阈值要调。
fn decode_text(bytes: &[u8]) -> (String, &'static str) {
    let bytes = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF][..]).unwrap_or(bytes);
    if let Ok(text) = std::str::from_utf8(bytes) {
        return (text.to_string(), "utf-8");
    }
    match gbk_to_string(bytes) {
        Some(text) => (text, "gbk"),
        // 两种都不是：有损解码，让用户看到乱码本身，而不是一个空文件
        None => (String::from_utf8_lossy(bytes).to_string(), "unknown"),
    }
}

/// GBK(936) → UTF-8。走系统 API，不引编码库。
///
/// windows-sys 本来就在依赖里（注册表、进程管理在用），这里只多开一个
/// `Win32_Globalization` feature —— 同一份 kernel32 绑定，不增加体积。
#[cfg(windows)]
fn gbk_to_string(bytes: &[u8]) -> Option<String> {
    use windows_sys::Win32::Globalization::MultiByteToWideChar;

    const CP_GBK: u32 = 936;
    let len = bytes.len() as i32;
    // 先问要多少个 UTF-16 码元，再一次性转（两步是 Win32 的固定用法）
    let need = unsafe { MultiByteToWideChar(CP_GBK, 0, bytes.as_ptr(), len, std::ptr::null_mut(), 0) };
    if need <= 0 {
        return None;
    }
    let mut buf = vec![0u16; need as usize];
    let got = unsafe { MultiByteToWideChar(CP_GBK, 0, bytes.as_ptr(), len, buf.as_mut_ptr(), need) };
    if got <= 0 {
        return None;
    }
    buf.truncate(got as usize);
    Some(String::from_utf16_lossy(&buf))
}

#[cfg(not(windows))]
fn gbk_to_string(_bytes: &[u8]) -> Option<String> {
    // ponytail: 非 Windows 只认 UTF-8；真要在那边读 GBK 就换个纯 Rust 编码库
    None
}

/// 把 LRC 拆成（原文, 译文）。认不出来就整份当原文、译文给空串 —— 不报错、不瞎猜。
///
/// 认两种国内常见的双语写法（判据都要「成规模」，见下）：
///   1. 一行两段：`[00:12.00]原文 / 译文`（`/` `／` `|` 都算分隔符）
///   2. 两段同时间轴：先把原文列一遍，再从头把译文列一遍
fn split_bilingual(text: &str) -> (String, String) {
    inline_bilingual(text)
        .or_else(|| dual_track_bilingual(text))
        .unwrap_or_else(|| (text.to_string(), String::new()))
}

/// 一行的（时间标签前缀, 正文）。元信息行（`[ti:]` `[offset:0]`）没有正文，返回 None。
fn timed_line(line: &str) -> Option<(&str, &str)> {
    let mut end = 0;
    let mut hit = false;
    loop {
        let rest = &line[end..];
        let lead = rest.len() - rest.trim_start().len();
        let rest = &rest[lead..];
        if !rest.starts_with('[') {
            break;
        }
        let Some(close) = rest.find(']') else { break };
        if parse_timestamp(&rest[..=close]).is_none() {
            break;
        }
        hit = true;
        end += lead + close + 1;
    }
    let content = line[end..].trim();
    if hit && !content.is_empty() {
        Some((&line[..end], content))
    } else {
        None
    }
}

/// `原文 / 译文` → 两段。取**第一个**分隔符（译文里再出现斜杠不该被当第二段）；
/// 有一边是空的就不算，返回 None。
fn split_pair(content: &str) -> Option<(&str, &str)> {
    let (at, sep) = content.char_indices().find(|(_, c)| matches!(c, '/' | '／' | '|'))?;
    let left = content[..at].trim_end();
    let right = content[at + sep.len_utf8()..].trim();
    if left.is_empty() || right.is_empty() {
        None
    } else {
        Some((left, right))
    }
}

/// 写法 1：逐行拆 `原文 / 译文`。
///
/// 要求**至少一半**的歌词行拆得开才认：只有个别行带斜杠（`AC/DC` 这种）说明这不是
/// 双语文件，硬拆会把原文拆坏。拆不开的行原样留在原文里。
fn inline_bilingual(text: &str) -> Option<(String, String)> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut orig = String::new();
    let mut trans = String::new();
    let (mut hits, mut total) = (0usize, 0usize);

    for line in normalized.lines() {
        let Some((tag, content)) = timed_line(line) else {
            // 元信息行、空行原样留下（原文那份里）
            orig.push_str(line.trim_end());
            orig.push('\n');
            continue;
        };
        total += 1;
        match split_pair(content) {
            Some((a, b)) => {
                hits += 1;
                orig.push_str(&format!("{tag}{a}\n"));
                trans.push_str(&format!("{tag}{b}\n"));
            }
            None => {
                orig.push_str(line.trim_end());
                orig.push('\n');
            }
        }
    }

    if total == 0 || hits * 2 < total {
        return None;
    }
    Some((orig, trans))
}

/// 写法 2：前后两段的时间戳逐条相同 —— 前一半是原文，后一半是译文。
///
/// 逐条比对是这里唯一的判据，比「行数一样」严得多：正常的歌词不可能两次出现
/// 一模一样的时间序列，所以误判概率极低；对不上就当普通歌词（整份原文）。
fn dual_track_bilingual(text: &str) -> Option<(String, String)> {
    let normalized = text.replace("\r\n", "\n").replace('\r', "\n");
    let lines: Vec<&str> = normalized.lines().collect();
    let timed: Vec<(usize, u64)> = lines
        .iter()
        .enumerate()
        .filter_map(|(i, line)| {
            let tag = first_tag(line)?;
            parse_timestamp(&tag).map(|ms| (i, ms))
        })
        .collect();

    if timed.len() < 4 || timed.len() % 2 != 0 {
        return None;
    }
    let (first, second) = timed.split_at(timed.len() / 2);
    if first.iter().map(|(_, ms)| ms).ne(second.iter().map(|(_, ms)| ms)) {
        return None;
    }

    let at = second[0].0;
    if at == 0 {
        return None;
    }
    Some((
        format!("{}\n", lines[..at].join("\n").trim_end()),
        format!("{}\n", lines[at..].join("\n").trim_end()),
    ))
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
        let lines = parse_lrc(raw);
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
    fn lrc_to_srt_uses_next_distinct_timestamp_as_end() {
        let raw = "[00:01.00]第一句\n[00:03.00]第二句\n[00:03.00]第二句译文\n";
        let srt = lrc_to_srt(raw, None, 10);
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
        assert_eq!(cookie_of(&bare), "MUSIC_U=abc123");
        // 已经有名字的（单段或整行）原样不动
        let named = json!({ "neteaseCookie": "MUSIC_U=abc123" });
        assert_eq!(cookie_of(&named), "MUSIC_U=abc123");
        let full = json!({ "neteaseCookie": "MUSIC_U=abc123; __csrf=xyz" });
        assert_eq!(cookie_of(&full), "MUSIC_U=abc123; __csrf=xyz");
        // 空值仍然是空：不能凭空造一个 MUSIC_U= 出来
        assert_eq!(cookie_of(&json!({})), "");
    }

    /// 网易云的每个请求都走 `get_text`，而它跑的是 HTTPS —— 明文头抓不到。
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
            &cookie_of(&cfg),
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
        );
        assert_eq!(
            merged,
            "[ti:x]\n[00:12.00]原文\n[00:12.00]译文\n[00:15.00]第二句\n"
        );
    }

    #[test]
    fn render_picks_format_and_extension() {
        let lrc = "[00:01.00]hello\n";
        let (text, ext) = render("lrc", lrc, "", 0, true).unwrap();
        assert_eq!(ext, "lrc");
        assert_eq!(text, lrc);

        let (text, ext) = render("srt", lrc, "[00:01.00]译文", 5, true).unwrap();
        assert_eq!(ext, "srt");
        assert!(text.contains("00:00:01,000 --> 00:00:05,000\nhello\n译文"));

        // 关掉双语就不带译文
        let (text, _) = render("srt", lrc, "[00:01.00]译文", 5, false).unwrap();
        assert!(!text.contains("译文"));

        assert!(render("ass", lrc, "", 0, true).is_err());
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
    fn parses_netease_links_and_bare_ids() {
        assert_eq!(
            parse_link("https://music.163.com/#/song?id=186016").unwrap(),
            ("netease".to_string(), "186016".to_string())
        );
        assert_eq!(
            parse_link("https://music.163.com/song?id=186016").unwrap(),
            ("netease".to_string(), "186016".to_string())
        );
        assert_eq!(
            parse_link("https://music.163.com/song/186016").unwrap(),
            ("netease".to_string(), "186016".to_string())
        );
        // 分享链接常带一堆参数，id 后面的东西不能混进去
        assert_eq!(
            parse_link("https://music.163.com/song?id=186016&userid=123456").unwrap(),
            ("netease".to_string(), "186016".to_string())
        );
        assert_eq!(
            parse_link("186016").unwrap(),
            ("netease".to_string(), "186016".to_string())
        );
        // 删掉 QQ 之后，songmid 这类链接必须明确报「认不出来」，而不是当成 id 硬认
        assert!(parse_link("https://i.y.qq.com/v8/playsong.html?songmid=0039MnYb0qxYhV").is_err());
        assert!(parse_link("0039MnYb0qxYhV").is_err());
        assert!(parse_link("").is_err());
        assert!(parse_link("随便写点什么").is_err());
    }

    /* ── 本地 LRC 导入 ── */

    #[test]
    fn splits_inline_bilingual_lrc() {
        let (orig, trans) =
            split_bilingual("[ti:x]\n[00:12.00]原文一 / 译文一\n[00:15.00]原文二|译文二\n");
        assert_eq!(orig, "[ti:x]\n[00:12.00]原文一\n[00:15.00]原文二\n");
        assert_eq!(trans, "[00:12.00]译文一\n[00:15.00]译文二\n");
    }

    #[test]
    fn splits_dual_track_bilingual_lrc() {
        let raw = "[ti:x]\n[00:01.00]原文一\n[00:03.00]原文二\n[00:01.00]译文一\n[00:03.00]译文二\n";
        let (orig, trans) = split_bilingual(raw);
        assert_eq!(orig, "[ti:x]\n[00:01.00]原文一\n[00:03.00]原文二\n");
        assert_eq!(trans, "[00:01.00]译文一\n[00:03.00]译文二\n");
        assert_eq!(parse_lrc(&trans).len(), 2);
    }

    /// 只有个别行带斜杠时**不能**当双语拆 —— 拆了就是把原文改坏（`AC/DC`）。
    #[test]
    fn single_slash_is_not_bilingual() {
        let raw = "[00:01.00]AC/DC\n[00:03.00]Back in Black\n[00:05.00]Highway to Hell\n";
        let (orig, trans) = split_bilingual(raw);
        assert_eq!(trans, "");
        assert_eq!(orig, raw);
    }

    /// 时间戳对不上就是普通歌词，不许硬拆成两半。
    #[test]
    fn dual_track_needs_matching_timestamps() {
        let raw = "[00:01.00]第一句\n[00:03.00]第二句\n[00:05.00]第三句\n[00:07.00]第四句\n";
        let (_, trans) = split_bilingual(raw);
        assert_eq!(trans, "");
    }

    #[test]
    fn decode_takes_utf8_bom_off_and_survives_gbk() {
        let (text, enc) = decode_text("\u{FEFF}[00:01.00]晴天\n".as_bytes());
        assert_eq!(enc, "utf-8");
        assert_eq!(text, "[00:01.00]晴天\n");
    }

    #[cfg(windows)]
    #[test]
    fn decode_falls_back_to_gbk() {
        // GBK(936) 的「晴天」是 C7 E7 CC EC —— 不是合法 UTF-8，只能靠 GBK 才读得对
        let bytes: &[u8] = &[
            0x5b, 0x30, 0x30, 0x3a, 0x30, 0x31, 0x2e, 0x30, 0x30, 0x5d, 0xc7, 0xe7, 0xcc, 0xec,
            0x0a,
        ];
        let (text, enc) = decode_text(bytes);
        assert_eq!(enc, "gbk");
        assert_eq!(text, "[00:01.00]晴天\n");
    }

    #[test]
    fn import_file_uses_stem_as_song_name() {
        let path = std::env::temp_dir().join("qingmu-import-测试.lrc");
        std::fs::write(&path, "[00:01.00]原文\n[00:03.00]第二句\n").unwrap();

        let v = import_file(&path).unwrap();
        assert_eq!(v["source"], "file");
        assert_eq!(v["song"]["name"], "qingmu-import-测试");
        assert_eq!(v["encoding"], "utf-8");
        assert_eq!(v["trans"], "");
        assert!(v["lyric"].as_str().unwrap().contains("第二句"));

        // 没有时间轴的文件要明确报错，而不是给一份空歌词
        std::fs::write(&path, "这不是歌词\n").unwrap();
        assert!(import_file(&path).is_err());
        let _ = std::fs::remove_file(&path);
    }

    /* ── 封面与直链下载 ── */

    #[test]
    fn cover_url_upgrades_scheme_and_shrinks_the_original() {
        // 原图 3000×3000、7 MB —— 一定要拼上 ?param=
        assert_eq!(
            cover_url("http://p1.music.126.net/abc.jpg"),
            "https://p1.music.126.net/abc.jpg?param=500y500"
        );
        assert_eq!(
            cover_url("https://p1.music.126.net/abc.jpg"),
            "https://p1.music.126.net/abc.jpg?param=500y500"
        );
        // 没有封面时是空串，不能拼出一个只有参数的怪地址
        assert_eq!(cover_url(""), "");
        // 已经有查询串的不重复拼（拼出两个 ? 会 404）
        assert_eq!(
            cover_url("http://p1.music.126.net/abc.jpg?x=1"),
            "https://p1.music.126.net/abc.jpg?x=1"
        );
    }

    #[test]
    fn audio_sniffing_rejects_html_error_pages() {
        // 实测下到的 mp3 头是 ID3（49 44 33 04）
        assert!(looks_like_audio(b"ID3\x04\x00\x00\x00\x00\x00\x00"));
        // 裸 mp3 帧头 0xFF 0xEx
        assert!(looks_like_audio(&[0xFF, 0xFB, 0x90, 0x00]));
        assert!(looks_like_audio(b"fLaC\x00\x00\x00\x22"));
        assert!(looks_like_audio(b"OggS\x00\x02\x00\x00"));
        // 直链过期时 CDN 会回一页 HTML，不能当 mp3 存下来
        assert!(!looks_like_audio(b"<!DOCTYPE html><html>"));
        assert!(!looks_like_audio(b"Not Found"));
        assert!(!looks_like_audio(b""));
    }

    #[test]
    fn level_label_reads_like_a_human() {
        assert_eq!(level_label("exhigh", 320_001), "极高 / 320 kbps");
        assert_eq!(level_label("lossless", 999_000), "无损 / 999 kbps");
        // 码率缺失时只说音质名，不写「0 kbps」
        assert_eq!(level_label("standard", 0), "标准");
        // 两个都没有就照实说不知道，而不是编一个
        assert_eq!(level_label("", 0), "未知音质");
        assert_eq!(level_label("something_new", 128_000), "128 kbps");
    }

    #[test]
    fn missing_direct_link_explains_why() {
        // 实测最常见：版权/付费受限
        let e = no_direct_link_reason(&json!({
            "url": null,
            "freeTrialPrivilege": { "cannotListenReason": 1 }
        }));
        assert!(e.contains("版权") && e.contains("登录"), "{e}");
        let e = no_direct_link_reason(&json!({ "freeTrialPrivilege": { "cannotListenReason": 2 } }));
        assert!(e.contains("会员"), "{e}");
        // 实测 id=26096272 的回包：code=-110 且 userConsumable=false（免费账号真拿不到）
        let e = no_direct_link_reason(&json!({
            "url": null,
            "code": -110,
            "fee": 1,
            "freeTrialPrivilege": { "cannotListenReason": 0, "userConsumable": false }
        }));
        assert!(e.contains("会员") && e.contains("版本"), "{e}");
        // 不认识的 reason 也要给一句话，不能是空串
        assert!(!no_direct_link_reason(&json!({})).is_empty());
    }

    #[test]
    fn format_of_falls_back_to_mp3() {
        // 实测 exhigh + mp3 回 type=mp3；有些档位回 m4a（扩展名要跟着改）
        assert_eq!(format_of(&json!({ "type": "mp3" })), "mp3");
        assert_eq!(format_of(&json!({ "type": "m4a" })), "m4a");
        assert_eq!(format_of(&json!({ "type": "" })), "mp3");
        assert_eq!(format_of(&Value::Null), "mp3");
    }
}
