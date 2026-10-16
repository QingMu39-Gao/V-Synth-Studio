//! 网易云：搜索、歌词与详情抓取、封面下载、歌曲直链下载、短信验证码登录，
//! 以及 LRC ↔ SRT 转换。
//!
//! 分工：平台相关的请求与解析都在这里（和 `bili.rs` 一个位置），路由在
//! `ipc::lyrics`，业务逻辑不碰 IPC 层。
//!
//! 只有网易云一个来源（歌词页是网易云专区）：`QQ_UA` / `y.qq.com` 那两套接口与
//! songmid 链接解析都不在。
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
//! 下载音质与网易云账号这两块**参考了 FusionMusicPlayer**
//! （<https://github.com/Janson20/FusionMusicPlayer>，GPL-3.0，Copyright (c) Janson20），
//! 照它的做法自行实现，未拷贝其代码：
//!   - 下载档位与「逐档往下试」的回退链、静默降级的识别
//!     —— `Quality` / `Quality::chain` / `level_rank`
//!   - 落盘前的文件头 + 时长双重校验、`.part` 临时文件
//!     —— `audio_format` / `duration_mismatch` / `part_path`
//!   - 会员标签带等级、凭据有效期与临近过期续期、登录态四态划分
//!     —— `vip_label` / `should_renew` / `refresh_login` / `account_info`
//!
//! 接口选择与它不同（也不依赖它的代码）：网易云的明文接口
//! `/api/cloudsearch/pc`、`/api/song/lyric`、`/api/song/detail` 直接可用，
//! 用不着 `weapi` 那套 AES + RSA 加密链路。
//! 短信验证码登录见 `sms_send` / `cellphone_login`，不需要加密。

use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Value, json};

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
/// ⚠️ 两个超时分工，**别删任何一个**：
/// - 总超时 10 分钟：给「整体多久还没下完」兜底。
/// - **`read_timeout` 60 秒：真正的关键**。它是「多久没收到新数据」才判死，
///   而不是整个请求的总时长 —— `client()` 那个 20 秒总超时对几 MB 的音频根本不够：
///   实测一首 320 kbps、9.8 MB 的歌单流传输要 **96 秒**，20 秒必被掐断，而且报出来的是
///   含糊的 `error decoding response body`。总超时放宽后仍怕「连上了但不发数据」，
///   所以留 60 秒读超时。
///
/// 前端对这条命令没有超时（`lib/ipc.ts` 约定 3），兜底就是上面这两个值。
fn media_client(cfg: &Value) -> Result<reqwest::Client, String> {
    let mut builder = base_builder(cfg, 600)?;
    // 60 秒没收到新数据才判死；数据一直在流就不会超时
    builder = builder.read_timeout(Duration::from_secs(60));
    builder
        .build()
        .map_err(|e| format!("HTTP 客户端创建失败：{e}"))
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
        builder = builder
            .proxy(reqwest::Proxy::all(&url).map_err(|e| format!("代理地址无效（{proxy}）：{e}"))?);
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

/// 清洗用户粘贴的 Cookie，返回能直接当 `Cookie` 头用的一行。
///
/// 为什么必须做：从开发者工具的 Value 格、或从聊天窗口复制出来的字符串常带**换行、
/// 制表符、全角空格**。`Cookie` 头的分隔符只能是 `; ` 加 ASCII 空格 —— 掺进一个换行，
/// 整个请求头就发不出去（reqwest 报「无效的请求头」，或者服务端收到一个断成几截的
/// cookie，表现是「明明粘贴了却一直未登录」）。所以这里把所有空白压成单个空格。
///
/// 只教 `MUSIC_U` 那一段的值也好使：整串里没有 `=` 时当成裸值，补上名字。
///
/// ⚠️ **认不出的东西宁可报错也不要写进配置**：配置文件是唯一真相，脏值一旦存进去，
/// 之后每次搜索 / 取歌词都会带着它发出去，而界面上只显示「已设置」——
/// 用户只能自己去翻 `config.json` 才看得出哪里不对。返回的 `Err` 是给用户看的一句话。
pub fn clean_cookie(raw: &str) -> Result<String, String> {
    /* 逐字符折叠：分号是唯一的分隔符，它两侧统一成 `; `（**分号不能丢** ——
    粘贴来源常常把 `;` 也换成一行的结尾，只按空白折叠会把两对键值粘成一串）；
    其余空白一律压成单个 ASCII 空格。 */
    let mut folded = String::with_capacity(raw.len());
    let mut pending_space = false;
    for c in raw.chars() {
        if c == ';' {
            while folded.ends_with(' ') {
                folded.pop();
            }
            folded.push_str("; ");
            pending_space = false;
        } else if c.is_whitespace() {
            pending_space = true;
        } else {
            if pending_space && !folded.is_empty() && !folded.ends_with(' ') {
                folded.push(' ');
            }
            pending_space = false;
            folded.push(c);
        }
    }
    let folded = folded.trim().trim_end_matches(';').trim_end().to_string();
    if folded.is_empty() {
        // 空串在 `set_config` 里是「清除凭据」的语义，不是错误
        return Ok(folded);
    }
    // 没有 `=` 的整串当裸值：两种粘贴法（只复制 Value / 复制整行）都要能用
    if !folded.contains('=') {
        return Ok(format!("MUSIC_U={folded}"));
    }
    if folded.matches('=').count() > 64 {
        return Err(
            "这串 Cookie 看着不像 Cookie（`=` 太多）。多半是把每个字符都粘成了一行 —— 重新复制一次，只取 MUSIC_U 那一格的值即可。"
                .into(),
        );
    }
    for pair in folded.split(';') {
        let pair = pair.trim();
        // 行尾分号（`a=1;\nb=2;`）折叠出来会多一个空段，那是粘贴的常态，不是错
        if pair.is_empty() {
            continue;
        }
        let Some((name, _)) = pair.split_once('=') else {
            return Err(format!(
                "Cookie 的这一段没有 `=`，不是键值对：「{}」。只复制 MUSIC_U 那一格的值，或整行 Cookie。",
                pair.chars().take(24).collect::<String>()
            ));
        };
        if name.is_empty() || !name.chars().all(|c| c.is_ascii_graphic() && c != '=') {
            return Err(format!(
                "Cookie 的键名不合法：「{}」。键名只能是 ASCII 可见字符（`=` 前面不能有空格）。",
                name.chars().take(24).collect::<String>()
            ));
        }
    }
    Ok(folded)
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
    serde_json::from_str(&text).map_err(|_| format!("返回的不是合法 JSON（可能触发了风控）：{url}"))
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
/// 只给音频下载用（封面几百 KB，`get_bytes` 一把读完更简单）。不占内存、
/// 也不需要「读完才写」。
///
/// ⚠️ **实现不在这个文件里**：所有「URL → 盘上文件」都走
/// `crate::download`。这里只负责把歌词这一路**特有**的东西递进去：
///   * `client` —— 这个必须是 `media_client()`（带用户配的代理 + `read_timeout`：
///     数据一直在流就不算超时）。引擎默认那个 `net::client()` 没有这两样；
///   * 每请求的 `User-Agent` / `Referer` / `Cookie`（网易云要用）；
///   * 其余全关：单流、不续传、不重试、无进度 —— 几 MB 的音频不需要那些，
///     多关一个就少一块出错面。
///
/// ⚠️ HTTP 状态不是 2xx 时的文案就是 `下载失败：HTTP 404` —— 调用方
/// （`ipc/lyrics.rs`）把它当字符串直报界面，没有人按字面匹配它。
async fn save_stream(
    client: &reqwest::Client,
    url: &str,
    ua: &str,
    referer: &str,
    cookie: &str,
    dest: &Path,
) -> Result<u64, String> {
    let mut hdrs: Vec<(&str, &str)> = vec![("User-Agent", ua), ("Referer", referer)];
    if !cookie.is_empty() {
        hdrs.push(("Cookie", cookie));
    }
    let req = crate::download::Request {
        url,
        label: "音频",
        part: dest,
        headers: &hdrs,
        shape: crate::download::Shape::Plain,
        /* ⚠️ 这里的 client 必须是 `media_client`（挂用户配的代理），不能换成
        默认那个。防卡死靠它的 `read_timeout`，不在引擎这边叠总超时。 */
        client,
        // 不重试：直链失效由上层换链接（`ipc/lyrics.rs` 有那套逻辑）
        retry: crate::download::Retry::NONE,
        expect: None,
    };
    // 没有取消/暂停这一说（几 MB，几秒的事）
    let ctl = crate::download::Control::new(|| false, || false);
    match crate::download::download(&req, &ctl, &|_, _, _| {}).await {
        Ok(crate::download::Outcome::Done { bytes }) => Ok(bytes),
        // 不续传 + 不暂停，所以另两种收场理论上到不了；真到了也按「没下成」处理
        Ok(_) => Err("下载没完成".to_string()),
        Err(e) => Err(e),
    }
}

/// reqwest 的英文错误对用户没意义（`error decoding response body` 之类），换成能看懂的话。
///
/// ⚠️ 实现只有一份，在 `crate::download::friendly` —— 下载那条路（`save_stream`）
/// 也用它。这里留个转发是给 `get_bytes`（整段读进内存，不走下载引擎）用的。
fn network_hint(e: &reqwest::Error) -> String {
    crate::download::friendly(e)
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
        Some(Value::Number(x)) => x
            .as_i64()
            .or_else(|| x.as_f64().map(|f| f as i64))
            .unwrap_or(0),
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
/// ⚠️ **它不等于「能不能下载」** —— 同为 `fee=0` 的歌，有的能拿到直链、
/// 有的（版权受限）拿不到。所以这里把它当标签展示，真正的判据是下载时那次
/// `player/url` 请求的返回。
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

/// 给搜索结果逐条标上「这个版本能不能拿到直链」（`playable`），以及这个账号能拿到的
/// 最高档（`maxLevel` / `maxBr`）。
///
/// 为什么这里要专门多打一次播放接口：**能不能下与 `fee` 无关**（同为 `fee=0`
/// 两种结果都有），只有真去打一次才知道。20 条**一次批量请求**就够（`ids` 收
/// JSON 数组），代价可接受；失败就整体不标（`playable` 留空），
/// 绝不让「探测失败」变成「搜索结果打不开」。
///
/// ⚠️ **必须按最高档探测，不能按某一档**：服务端对够不到的档位是**降级**而不是拒绝
/// （实测未登录求 `hires/flac` 照样回 `url`，只是 `level` 降到 `exhigh`）。按最高档探
/// 一次同时得到两个答案：`url` 非空 = 这个版本能下；回包的 `level` = 这个账号的天花板
/// （随搜索结果一起回给前端，字段是 `maxLevel` / `maxBr`）。
async fn annotate_playable(
    client: &reqwest::Client,
    cookie: &str,
    mut hits: Vec<Value>,
) -> Vec<Value> {
    if hits.is_empty() {
        return hits;
    }
    let ids = hits
        .iter()
        .map(|h| s(h, "/id"))
        .collect::<Vec<_>>()
        .join(",");
    let Ok(list) = fetch_media(client, cookie, &ids, Quality::Hires).await else {
        return hits;
    };

    for hit in hits.iter_mut() {
        let id = s(hit, "/id");
        let found = list.iter().find(|x| s(x, "/id") == id);
        let playable = found.map(|x| !s(x, "/url").is_empty()).unwrap_or(false);
        let Some(obj) = hit.as_object_mut() else {
            continue;
        };
        obj.insert("playable".to_string(), Value::Bool(playable));
        if playable && let Some(x) = found {
            obj.insert("maxLevel".to_string(), json!(s(x, "/level")));
            obj.insert("maxBr".to_string(), json!(n(x, "/br")));
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

async fn netease_fetch(client: &reqwest::Client, id: &str, cookie: &str) -> Result<Value, String> {
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
/// ⚠️ **顺序有讲究**：必须先判各自的特征参数，再判通用的 `id=`。照着反过来的
/// 话 `?songmid=0039MnYb0qxYhV` 会被 `id=(\d+)` 抢走。将来若再加别的来源，
/// 仍然要先判它自己那个特征参数。
pub fn parse_link(input: &str) -> Result<(String, String), String> {
    let raw = input.trim();
    if raw.is_empty() {
        return Err("请粘贴歌曲链接或歌曲编号".to_string());
    }

    // 1. `?id=<数字>` / `&id=<数字>`
    if let Some(id) = param_value(raw, "id")
        && !id.is_empty()
        && id.chars().all(|c| c.is_ascii_digit())
    {
        return Ok(("netease".to_string(), id));
    }
    // 2. `/song/<数字>` 这种路径
    if let Some(id) = segment_after(raw, "song/")
        && id.chars().all(|c| c.is_ascii_digit())
    {
        return Ok(("netease".to_string(), id));
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
    if value.is_empty() { None } else { Some(value) }
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

/// 下载档位。**档位是上限，不是承诺**：服务端会静默降级，实际拿到哪一档由回包的
/// `level` 决定，并如实报给用户。
///
/// 实测（未登录、免费歌，`player/url/v1` + `encodeType=flac`）：求 `standard` / `higher` /
/// `exhigh` 分别回 128 / 192 / 320 kbps；求 `lossless` / `hires` **也回 url**，但 `level`
/// 仍写 `exhigh`、`type` 仍写 `mp3`。所以**只看 `url` 非空会把 320 kbps 当成无损**，
/// 必须比对等级（`encodeType` 本身也按档位分，见 `encode_type`）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Quality {
    /// 不设上限：直接求最高档，服务端给到什么算什么。
    Auto,
    Hires,
    Lossless,
    Exhigh,
    Higher,
    Standard,
}

/// 从标准档到最高档，`chain()` 按它往前退。
const QUALITY_DESC: [Quality; 5] = [
    Quality::Hires,
    Quality::Lossless,
    Quality::Exhigh,
    Quality::Higher,
    Quality::Standard,
];

impl Quality {
    /// 请求时用的 `level` 名。`Auto` 从最高档起要 —— 服务端按账号权益往下给，
    /// 自己猜一个起点反而可能少拿。
    fn level(self) -> &'static str {
        match self {
            Quality::Auto | Quality::Hires => "hires",
            Quality::Lossless => "lossless",
            Quality::Exhigh => "exhigh",
            Quality::Higher => "higher",
            Quality::Standard => "standard",
        }
    }

    /// 请求的编码容器。**只有无损及以上能用 `flac`**：带 `mp3` 求 `lossless` 时
    /// 服务端不会给 flac 流，这一条漏了就永远拿不到无损。
    ///
    /// ⚠️ **反过来也成立，而且是 320K / 128K 档的坑**：`level=exhigh|higher|standard`
    /// 配 `encodeType=flac` 时服务端会把「本档的 mp3」换成一档 **flac** 回给有权益的账号
    /// —— 实测黑胶账号求 `exhigh` 得到 `level=exhigh, br=320000, type=mp3`，一换 `flac`
    /// 就变成同一首歌的 `lossless`。那样选「320K」下回来的既不是 320K，`downgraded`
    /// 也报不出来（`lossless` 比请求高，不算降级），用户拿到的和界面上说的不是一回事。
    fn encode_type(self) -> &'static str {
        match self {
            Quality::Hires | Quality::Lossless => "flac",
            Quality::Auto | Quality::Exhigh | Quality::Higher | Quality::Standard => "mp3",
        }
    }

    /// 档位高低，只用于比较（与 kbps 不是一回事：`Auto` 代表「不设上限」）。
    fn rank(self) -> i64 {
        match self {
            Quality::Auto | Quality::Hires => 4,
            Quality::Lossless => 3,
            Quality::Exhigh => 2,
            Quality::Higher => 1,
            Quality::Standard => 0,
        }
    }

    /// 请求体里来的档位。**认不出的一律当 `Auto`** —— 宁可多试几档，
    /// 也不要因为一个拼错的值直接让下载失败。
    pub fn parse(raw: &str) -> Quality {
        match raw.trim().to_ascii_lowercase().as_str() {
            "hires" | "hi-res" | "master" => Quality::Hires,
            "lossless" | "flac" => Quality::Lossless,
            "exhigh" | "320" | "320k" => Quality::Exhigh,
            "higher" | "192" | "192k" => Quality::Higher,
            "standard" | "128" | "128k" => Quality::Standard,
            _ => Quality::Auto,
        }
    }

    /// 本档位往下逐级要的序列（含自身）。
    ///
    /// 服务端**一般不会因为档位太高而拒绝**（实测求无损会给 320 kbps），所以这条链兜的
    /// 是另一类情形：某些账号在某个档位**整条不回 `url`**，退一档就能拿到。
    fn chain(self) -> Vec<Quality> {
        let top = match self {
            Quality::Auto => 0,
            other => QUALITY_DESC.iter().position(|q| *q == other).unwrap_or(0),
        };
        QUALITY_DESC[top..].to_vec()
    }
}

/// 回包 `level` 的等级，用来判断「是不是被静默降级了」。
///
/// **认不出的 `level` 一律当「不比请求低」**（99）：老接口、以后新加的档位名都不该
/// 把一条能用的直链判成降级。
fn level_rank(level: &str) -> i64 {
    match level.trim().to_ascii_lowercase().as_str() {
        "standard" => 0,
        "higher" => 1,
        "exhigh" => 2,
        "lossless" | "sky" | "jyeffect" => 3,
        "hires" | "jymaster" => 4,
        _ => 99,
    }
}

/// 统一的取直链入口：回包 `data` 那个数组，每项含 `url` / `level` / `br` / `size` /
/// `type` / `code` / `freeTrialPrivilege`。**下载与搜索结果的「能不能下」标注都走这里。**
///
/// 参数形状照网页播放器抄：`ids` 要是 JSON 数组（下载传一个、搜索结果一次传 20 个），
/// `level` + `encodeType` 缺一不可 —— **少了 `encodeType` 就对免费账号大面积不回 url**。
async fn fetch_media(
    client: &reqwest::Client,
    cookie: &str,
    ids: &str,
    quality: Quality,
) -> Result<Vec<Value>, String> {
    let url = format!(
        "https://music.163.com/api/song/enhance/player/url/v1\
         ?ids=%5B{ids}%5D&level={}&encodeType={}",
        quality.level(),
        quality.encode_type()
    );
    let data = get_json(client, &url, DEFAULT_UA, REFER_NETEASE, cookie).await?;
    Ok(data
        .pointer("/data")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default())
}

/// 下载结果。`level` 是**实际**拿到的档位（服务端可能降级），`format` 按**文件头**认。
pub struct SongFile {
    pub bytes: u64,
    pub level: String,
    pub format: String,
    /// 服务端给的档位低于请求档位（如求无损只给 320 kbps）——界面据此如实说明
    pub downgraded: bool,
}

/// 拿一首歌的直链并下载到 `dest`，返回实际拿到的档位与格式。
///
/// ⚠️ 取直链只认 `/api/song/enhance/player/url/v1` + `level` + `encodeType`（见 `fetch_media`）。
/// 别用 `song/media/outer/url`（302 到 404 页）或 `enhance/download/url`
/// （回 `{"data":null,"code":301}` 要登录）。
///
/// ⚠️ **能不能下只能看这个接口的返回，不能凭 `fee` 预判**（同为 `fee=0` 的歌两种
/// 结果都出现过）。歌能不能听是平台的事，本工具只如实报结果。
///
/// ⚠️ CDN 那一跳只挂 UA、**不挂 Cookie**（直链自带 token，不带 UA / Referer 也回
/// 206）—— 少一份把 Cookie 发去 CDN 的风险。**取直链那一跳必须带 Cookie**：
/// v1 对已登录用户才按账号权益给 url。
///
/// `expected_sec` 是曲目时长（搜索 / 详情接口给的），用来拦「只拿到 30 秒试听片段」；
/// 传 0 表示拿不到时长 —— 此时不判，宁可不判也不用一个猜的时长误杀整首歌。
pub async fn download_song(
    cfg: &Value,
    id: &str,
    dest: &Path,
    quality: Quality,
    expected_sec: i64,
) -> Result<SongFile, String> {
    // 取直链是小请求，用普通超时；**下音频必须换成 media_client**（见那里的注释：
    // 20 秒装不下几 MB 的歌，会被掐成含糊的「error decoding response body」）
    let client = media_client(cfg)?;
    let cookie = cookie_of(cfg);

    // 逐级往下试（链见 `Quality::chain`）：服务端一般会降级而不是拒绝，
    // 这条链兜的是「某个档位整条不回 url」那种账号
    let mut media = Value::Null;
    for q in quality.chain() {
        let got = fetch_media(&client, &cookie, id, q)
            .await?
            .into_iter()
            .next()
            .unwrap_or(Value::Null);
        let usable = !s(&got, "/url").is_empty();
        media = got;
        if usable {
            break;
        }
    }

    let direct = s(&media, "/url");
    if direct.is_empty() {
        return Err(no_direct_link_reason(&media));
    }

    let actual = s(&media, "/level");
    let br = n(&media, "/br");
    let declared_size = n(&media, "/size");
    // `Auto` 不设上限，「降级」对它没有意义
    let downgraded = quality != Quality::Auto && level_rank(&actual) < quality.rank();

    // 先写 `<目标>.part`，全部校验过了才改名成正式文件：中断 / 校验失败 / 改名失败
    // 都只留一个可清理的临时文件，用户目录里不会出现半截歌
    let part = part_path(dest);
    // 边下边写（`save_stream`）。不用 `get_bytes`：几 MB 的音频没必要占内存，
    // 而且流式读才能配合 `media_client()` 的 read_timeout（数据在流就不算超时）。
    let size = save_stream(&client, &direct, DEFAULT_UA, REFER_NETEASE, "", &part).await?;

    if size == 0 {
        return Err(discard(
            &part,
            "下载到的音频是空的（直链可能已经失效，重试一次通常就好了）",
        ));
    }

    // 直链失效时 CDN 可能回一页 HTML 而不是音频。格式也以文件头为准 ——
    // 接口的 `type` 会与实际内容不符（实测求 flac 时 `type` 写的是 mp3）
    let head = read_head(&part, 16);
    let Some(format) = audio_format(&head) else {
        return Err(discard(
            &part,
            "拿到的不是音频数据（直链可能已经过期，重试一次通常就好了）",
        ));
    };

    // 服务端给了准确体积就核对一遍：短一截说明传输中途断了
    if declared_size > 0 && (size as i64 - declared_size).abs() > declared_size / 20 {
        return Err(discard(
            &part,
            &format!(
                "下到的文件不完整（拿到 {size} 字节，服务端声明 {declared_size} 字节），\
                 重试一次通常就好了"
            ),
        ));
    }

    // 30 秒试听片段本身是合法音频，文件头拦不住，只能按时长认
    if let Some(why) = duration_mismatch(size, br, expected_sec) {
        return Err(discard(&part, &why));
    }

    std::fs::rename(&part, dest).map_err(|e| {
        let _ = std::fs::remove_file(&part);
        format!("保存失败：{e}")
    })?;

    Ok(SongFile {
        bytes: size,
        level: level_label(&actual, br),
        format: format.to_string(),
        downgraded,
    })
}

/// 删掉临时文件并返回给用户看的原因。失败路径一律走这里，免得漏删。
fn discard(part: &Path, why: &str) -> String {
    let _ = std::fs::remove_file(part);
    why.to_string()
}

/// 临时文件名：`.part` 追加在原名**之后**，不当扩展名用 ——
/// `with_extension("part")` 会把 `.mp3` 顶掉，校验通过后改回原名就对不上了。
fn part_path(dest: &Path) -> PathBuf {
    let mut raw = dest.as_os_str().to_os_string();
    raw.push(".part");
    PathBuf::from(raw)
}

/// 读文件头前 `n` 个字节；读不满就返回已有的部分（打不开返回空）。
fn read_head(dest: &Path, n: usize) -> Vec<u8> {
    use std::io::Read;
    let Ok(mut f) = std::fs::File::open(dest) else {
        return Vec::new();
    };
    let mut buf = vec![0u8; n];
    match f.read(&mut buf) {
        Ok(got) => {
            buf.truncate(got);
            buf
        }
        Err(_) => Vec::new(),
    }
}

/// 按文件头认容器格式，认不出返回 `None`（调用方据此判「这不是音频」）。
///
/// 认这四种够用：实测 `type` 只回 `mp3` / `flac` / `m4a`。**以文件头为准而不是接口的
/// `type`** —— 实测求 flac 时接口照样写 mp3，内容也确实是 mp3。
fn audio_format(head: &[u8]) -> Option<&'static str> {
    if head.len() < 4 {
        return None;
    }
    if head.starts_with(b"ID3") || (head[0] == 0xFF && head[1] & 0xE0 == 0xE0) {
        return Some("mp3");
    }
    if head.starts_with(b"fLaC") {
        return Some("flac");
    }
    if head.starts_with(b"OggS") {
        return Some("ogg");
    }
    // m4a / mp4：第 5..8 字节是 `ftyp`
    if head.len() >= 8 && &head[4..8] == b"ftyp" {
        return Some("m4a");
    }
    None
}

/// 时长对不上就返回一句给人看的原因，对得上返回 `None`。
///
/// 判据是 `字节数 × 8 ÷ 码率`：不用解码器，而 `size` 与 `br` 是服务端一起给的
/// （实测四个档位算出的时长只差 0.1 秒），所以这判据很稳。15% 的余量是留给 VBR 的，
/// 而 30 秒试听与整首歌差一个数量级，照样拦得住。
fn duration_mismatch(bytes: u64, br: i64, expected_sec: i64) -> Option<String> {
    if br <= 0 || bytes == 0 || expected_sec <= 0 {
        return None;
    }
    let got = bytes as f64 * 8.0 / br as f64;
    if got < expected_sec as f64 * 0.85 {
        return Some(format!(
            "只拿到约 {} 秒音频（这首歌约 {} 秒）。未登录或非会员有时只能试听，\
             登录后重试，或换搜索结果里的另一个版本试试。",
            got.round() as i64,
            expected_sec
        ));
    }
    None
}

/// 拿不到直链时，按接口给的信息说清楚为什么。
///
/// 三条判据（`id=26096272` 这类「真受限」的样本就是这样）：
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

/* ═════════════════ 登录态：校验 / 会员标签 / 过期与续期 ═════════════════ */

/// 服务端给 `MUSIC_U` 的 Max-Age 是 180 天，续期后重新计时。
/// 只在响应头里读不出有效期时当兜底估算用。
pub const COOKIE_TTL_SECONDS: i64 = 180 * 24 * 3600;

/// 剩余不足多少天就该自动续期。
pub const RENEW_BEFORE_DAYS: i64 = 7;

/// 会员等级用的中文大写数字 —— 网易云客户端写的是「黑胶SVIP·肆」而不是「黑胶SVIP Lv4」。
const CN_DIGITS: [&str; 10] = ["零", "壹", "贰", "叁", "肆", "伍", "陆", "柒", "捌", "玖"];

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// 现在这一刻（unix 秒）。IPC 层拿它配 `should_renew` 判断该不该续期 ——
/// 「现在几点」只在这一处取，免得前后端各算一遍还对不上。
pub fn now_unix() -> i64 {
    now_secs()
}

/// 凭据是否该续期了（剩余有效期不足 `days` 天）。
///
/// `days <= 0` 表示关掉自动续期；`expires_at` 缺失（只存了 Cookie、没记有效期的
/// 老配置）时**续一次**把有效期补上，否则永远判不出该不该续。
pub fn should_renew(expires_at: i64, now: i64, days: i64) -> bool {
    if days <= 0 {
        return false;
    }
    if expires_at <= 0 {
        return true;
    }
    expires_at - now <= days * 86400
}

/// 从响应头里读 `MUSIC_U` 的过期时间（unix 秒，读不到返回 0）。
///
/// 登录 / 续期接口**不在响应体里回 Cookie，而是用 `Set-Cookie` 换发一个新的
/// MUSIC_U**（值会变、Max-Age 重新计时）。所以有效期只能从响应头解析 ——
/// 比「拿到的时刻 + 180 天」准。只认 `Max-Age`（服务端一直在用）；
/// `Expires` 是绝对时间、解析要论 HTTP 日期格式，没把握就不猜，回 0 让调用方用 TTL 兜底。
fn cookie_expiry_from_set_cookie(headers: &reqwest::header::HeaderMap) -> i64 {
    for value in headers.get_all(reqwest::header::SET_COOKIE).iter() {
        let Ok(raw) = value.to_str() else { continue };
        let mut parts = raw.split(';');
        let Some(first) = parts.next() else { continue };
        if !first
            .split('=')
            .next()
            .unwrap_or("")
            .trim()
            .eq_ignore_ascii_case("MUSIC_U")
        {
            continue;
        }
        for attr in parts {
            let (key, val) = attr.split_once('=').unwrap_or(("", ""));
            if key.trim().eq_ignore_ascii_case("max-age")
                && let Ok(secs) = val.trim().parse::<i64>()
            {
                return now_secs() + secs;
            }
        }
    }
    0
}

/// 会员等级后缀：`4` → `·肆`。等级是服务端给的，**超出 1..99 时不猜**，
/// 原样退回阿拉伯数字；0 / 拿不到返回空串（界面就不显示等级）。
fn vip_level_suffix(level: i64) -> String {
    if level <= 0 {
        return String::new();
    }
    if level > 99 {
        return format!("·{level}");
    }
    if level < 10 {
        return format!("·{}", CN_DIGITS[level as usize]);
    }
    let (tens, ones) = (level / 10, level % 10);
    let head = if tens == 1 {
        "拾".to_string()
    } else {
        format!("{}拾", CN_DIGITS[tens as usize])
    };
    if ones == 0 {
        format!("·{head}")
    } else {
        format!("·{head}{}", CN_DIGITS[ones as usize])
    }
}

/// 会员标签。`vipType` 是**按十进制位值拼出来的**：`1` 音乐包、`10` 黑胶VIP、
/// `100` 黑胶SVIP，同时有多项就相加（实测同一个 SVIP 账号两处写法不同：
/// `account.vipType=11` 是标量、`profile.vipType=110` 是位掩码）。
/// 这三个值二进制位互不相交（0b1 / 0b1010 / 0b1100100），所以 `&` 判得出来，
/// **别把它们当二进制位读**（`0b100` = 4 是另一个数）。
/// 另有标量 `20` 与会员接口的 `vipCode=300` 也表示 SVIP。
/// `0` 与缺失单独处理，**别把 0 当成「音乐包」**。
fn vip_label(vip_type: i64, level: i64) -> String {
    if vip_type <= 0 {
        return "普通用户".to_string();
    }
    if vip_type == 20 || vip_type == 300 || vip_type & 100 != 0 {
        return format!("黑胶SVIP{}", vip_level_suffix(level));
    }
    if vip_type & 10 != 0 || vip_type == 10 || vip_type == 11 {
        return "黑胶VIP".to_string();
    }
    if vip_type & 1 != 0 || vip_type == 1 {
        return "音乐包".to_string();
    }
    "普通用户".to_string()
}

/// 登录态查询结果。
///
/// `state` 是四态，**必须把「凭据失效」和「网络不通」分开**：前者要把界面置为未登录并
/// 引导重新登录，后者绝不能因此清掉本地的登录态。
pub struct AccountInfo {
    /// `ok` / `expired` / `offline` / `anonymous`（本地根本没配 Cookie）
    pub state: &'static str,
    pub nickname: String,
    /// 「黑胶SVIP·肆」/「黑胶VIP」/「音乐包」/「普通用户」；未登录时是空串
    pub vip: String,
    /// 排查用的明细：等级这里特意保留服务端的 `LvN` 写法，报问题时能和服务端对上
    pub vip_detail: String,
}

impl AccountInfo {
    fn new(state: &'static str) -> AccountInfo {
        AccountInfo {
            state,
            nickname: String::new(),
            vip: String::new(),
            vip_detail: String::new(),
        }
    }
}

/// 会员等级（`redVipLevel`）。等级不在账号信息里，要单独问会员接口；
/// **拿不到就返回 0**（界面不显示等级），不影响账号的其它信息。
async fn vip_level(client: &reqwest::Client, cookie: &str) -> i64 {
    let url = "https://music.163.com/api/music-vip-membership/client/vip/info";
    let Ok(json) = get_json(client, url, DEFAULT_UA, REFER_NETEASE, cookie).await else {
        return 0;
    };
    if n(&json, "/code") != 200 {
        return 0;
    }
    n(&json, "/data/redVipLevel")
}

/// 问一下「现在登录的是谁、什么会员」，顺带把登录态判出来。
///
/// 没登录时账号接口回 `{"code":200,"account":null,"profile":null}`（实测），
/// 所以「code=200 但 account 与 profile 都是 null」= 凭据失效，不是成功。
/// 服务端用它自己的错误码说「这个凭据不行了」（250 需要验证 / 301、302 未登录 /
/// 401、403 无权限）；**其它错误码一律当网络问题**，不敢据此把用户登出。
pub async fn account_info(cfg: &Value) -> AccountInfo {
    let cookie = cookie_of(cfg);
    if cookie.is_empty() {
        return AccountInfo::new("anonymous");
    }
    let Ok(client) = client(cfg) else {
        return AccountInfo::new("offline");
    };
    let url = "https://music.163.com/api/w/nuser/account/get";
    let Ok(json) = get_json(&client, url, DEFAULT_UA, REFER_NETEASE, &cookie).await else {
        // 请求发不出去 / 回的解析不了：算网络问题，不动登录态
        return AccountInfo::new("offline");
    };
    let code = n(&json, "/code");
    if matches!(code, 250 | 301 | 302 | 401 | 403) {
        return AccountInfo::new("expired");
    }
    if code != 200 {
        return AccountInfo::new("offline");
    }
    let present = |ptr: &str| json.pointer(ptr).map(|v| !v.is_null()).unwrap_or(false);
    if !present("/account") && !present("/profile") {
        return AccountInfo::new("expired");
    }

    // 昵称的落点在不同版本里有 profile.nickname / profile.userName 两种，都认
    let nickname = {
        let a = s(&json, "/profile/nickname");
        if a.is_empty() {
            s(&json, "/profile/userName")
        } else {
            a
        }
    };
    // account.vipType 是标量、profile.vipType 是位掩码，两者含义不同 —— 标量优先
    let vip_type = {
        let a = n(&json, "/account/vipType");
        if a != 0 {
            a
        } else {
            n(&json, "/profile/vipType")
        }
    };
    let level = vip_level(&client, &cookie).await;

    AccountInfo {
        state: "ok",
        nickname,
        vip: vip_label(vip_type, level),
        vip_detail: if level > 0 {
            format!("vipType={vip_type} · 等级 Lv{level}")
        } else {
            format!("vipType={vip_type}")
        },
    }
}

/// 续期登录凭据。成功返回 `(新的 Cookie 串, 新的过期时间)`，失败返回 `None`。
///
/// 接口是 `/api/login/token/refresh`：**服务端不在响应体里回 Cookie，而是用
/// `Set-Cookie` 换发一个新的 MUSIC_U**（值会变、Max-Age 重新计时）。换发后旧的
/// MUSIC_U 仍然有效，所以即使落盘失败也不会把已登录的会话踢下线 —— 调用方因此
/// 可以放心地「续期失败就照旧用」。
///
/// 拿不到新的 `Set-Cookie` 时退回原 Cookie：值没变也可能只是服务端延长了 Max-Age，
/// 此时把有效期按 TTL 往前推一次，总比一直判「该续期」然后每次启动都白试一次强。
pub async fn refresh_login(cfg: &Value) -> Option<(String, i64)> {
    let cookie = cookie_of(cfg);
    if cookie.is_empty() {
        return None;
    }
    let client = client(cfg).ok()?;
    let url = "https://music.163.com/api/login/token/refresh";
    let res = client
        .post(url)
        .header("User-Agent", DEFAULT_UA)
        .header("Referer", REFER_NETEASE)
        .header("Origin", "https://music.163.com")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .header("Cookie", &cookie)
        .body("")
        .send()
        .await
        .ok()?;

    let status = res.status().as_u16();
    let renewed = cookie_from_set_cookie(res.headers());
    let expiry = cookie_expiry_from_set_cookie(res.headers());
    let text = res.text().await.unwrap_or_default();
    let json: Value = serde_json::from_str(&text).unwrap_or(Value::Null);

    if !(200..300).contains(&status) || n(&json, "/code") != 200 {
        return None;
    }
    if renewed.contains("MUSIC_U") {
        let at = if expiry > 0 {
            expiry
        } else {
            now_secs() + COOKIE_TTL_SECONDS
        };
        return Some((renewed, at));
    }
    Some((cookie, now_secs() + COOKIE_TTL_SECONDS))
}

/// 短信登录的路子（`/api/sms/captcha/sent` + `/api/w/login/cellphone`）**全是明文**，
/// 不需要任何加密：发码接口直接回 `{"code":200,"data":true}`；
/// 登录接口用假验证码回 `{"msg":"验证码错误","code":503}`（**没有** "ENC" 那一套）。
/// ⚠️ 别换成 `/api/login/cellphone`：那条回 `{"code":401,"message":"无权限访问. ENC"}`。
/// ⚠️ 扫码登录不可用（服务端风控，一直回 8821），所以短信是唯一一条登录路。
///
/// 手机号只认「1 开头 + 11 位数字」。
///
/// 这层校验是**发短信前的第一道闸**：格式不对就地报错，绝不让请求出网。
/// 验证码错了只是报错，但发码接口是真会发短信的 —— 谁也不想给陌生人发。
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

/// 手机号 + 短信验证码登录，返回 `(整条 Cookie 串, 过期时间)`。
///
/// Cookie 形如 `MUSIC_U=…; __csrf=…`。过期时间从响应头的 `Set-Cookie` 里读
/// （服务端下发 MUSIC_U 时会带上 Max-Age），读不到就按 180 天 TTL 估算 ——
/// 有这个时间才判得出「该不该续期」（见 `should_renew`）。
pub async fn cellphone_login(
    cfg: &Value,
    phone: &str,
    captcha: &str,
) -> Result<(String, i64), String> {
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
    let expiry = cookie_expiry_from_set_cookie(res.headers());
    let text = res.text().await.unwrap_or_default();
    let json: Value = serde_json::from_str(&text).unwrap_or(Value::Null);

    // 1) 响应体里的 cookie（老版接口的形状），2) Set-Cookie 响应头（现在多半走这条）
    for candidate in [s(&json, "/cookie"), from_header] {
        if candidate.contains("MUSIC_U") {
            let at = if expiry > 0 {
                expiry
            } else {
                now_secs() + COOKIE_TTL_SECONDS
            };
            return Ok((candidate, at));
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
        if m.is_empty() { s(json, "/msg") } else { m }
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
        let Some(first) = raw.split(';').next() else {
            continue;
        };
        let Some((name, val)) = first.split_once('=') else {
            continue;
        };
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
/// 网易云的歌词没有 `[offset:0]` / `[kana:` 这类「正文从这里开始」的分隔标记，
/// 所以整份都当正文解。
/// ponytail: 将来加的来源若有这种头（它之前的内容属于另一个版本的歌词头、要丢掉），
/// 在这儿加一段丢头逻辑。
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

/// 行首**连续**的时间标签（沿用原文的写法，不重新格式化）。
/// 遇到第一个不是时间的 `[...]` 就停 —— `[ar:xx]` 这类元数据不参与配对。
fn time_tags(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut rest = line.trim_start();
    while let Some(stripped) = rest.strip_prefix('[') {
        let Some(end) = stripped.find(']') else { break };
        let tag = format!("[{}]", &stripped[..end]);
        if parse_timestamp(&tag).is_none() {
            break;
        }
        out.push(tag);
        rest = &stripped[end + 1..];
    }
    out
}

/// 行首第一个真正的时间标签（沿用原文的写法，不重新格式化）
fn first_tag(line: &str) -> Option<String> {
    time_tags(line).into_iter().next()
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
        /* 一行可以挂多个时间标签（副歌重复是常见写法）。只补第一个的话，
        后面几处重复就没有译文 —— 而 `lrc_to_srt` 走 `parse_lrc` 是每个标签各展开
        一条，同一份输入导出 SRT 是双语、导出 LRC 却只剩半双语。 */
        for tag in time_tags(line) {
            let Some(ms) = parse_timestamp(&tag) else {
                continue;
            };
            let Some(text) = pick_trans(&trans_lines, ms) else {
                continue;
            };
            let text = text.trim();
            if text.is_empty() {
                continue;
            }
            out.push_str(&tag);
            out.push_str(text);
            out.push('\n');
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
/// 三端都用系统自带的转换器，不为一份 GBK 表引第三个 crate：
/// Windows 是 kernel32 的 `MultiByteToWideChar`（`windows-sys` 已在依赖里，
/// 只多开一个 `Win32_Globalization` feature），unix 是 libc 的 `iconv`
/// （`libc` 也已在依赖里）。
#[cfg(windows)]
fn gbk_to_string(bytes: &[u8]) -> Option<String> {
    use windows_sys::Win32::Globalization::MultiByteToWideChar;

    const CP_GBK: u32 = 936;
    let len = bytes.len() as i32;
    // 先问要多少个 UTF-16 码元，再一次性转（两步是 Win32 的固定用法）
    let need =
        unsafe { MultiByteToWideChar(CP_GBK, 0, bytes.as_ptr(), len, std::ptr::null_mut(), 0) };
    if need <= 0 {
        return None;
    }
    let mut buf = vec![0u16; need as usize];
    let got =
        unsafe { MultiByteToWideChar(CP_GBK, 0, bytes.as_ptr(), len, buf.as_mut_ptr(), need) };
    if got <= 0 {
        return None;
    }
    buf.truncate(got as usize);
    Some(String::from_utf16_lossy(&buf))
}

#[cfg(unix)]
fn gbk_to_string(bytes: &[u8]) -> Option<String> {
    /* macOS 的 libc 把 `iconv_*` 标了 deprecated（它不想让 std 静态链接 libiconv），
    而这里正是有意用它 —— 不引 crate 的代价就是这几个符号。 */
    #[allow(deprecated)]
    unsafe {
        let cd = libc::iconv_open(c"UTF-8".as_ptr(), c"GBK".as_ptr());
        if cd == -1isize as libc::iconv_t {
            return None;
        }
        /* UTF-8 每字符最多 4 字节、GBK 每字符 2 字节，4× 输入再加余量必够 ——
        不够的话 iconv 会回 E2BIG，那按下面 `rc == usize::MAX` 当失败。 */
        let cap = bytes.len() * 4 + 4;
        let mut out = vec![0u8; cap];
        let mut in_ptr = bytes.as_ptr() as *mut libc::c_char;
        let mut in_left = bytes.len();
        let mut out_ptr = out.as_mut_ptr() as *mut libc::c_char;
        let mut out_left = cap;
        let rc = libc::iconv(cd, &mut in_ptr, &mut in_left, &mut out_ptr, &mut out_left);
        libc::iconv_close(cd);
        /* `in_left != 0` = 中途撞上非法序列：宁可整个判失败（调用方回退有损解码、
        让用户看到乱码），也不要返回「前半截对、后半截错」的文本。 */
        if rc == usize::MAX || in_left != 0 {
            return None;
        }
        out.truncate(cap - out_left);
        String::from_utf8(out).ok()
    }
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
    let (at, sep) = content
        .char_indices()
        .find(|(_, c)| matches!(c, '/' | '／' | '|'))?;
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

    if timed.len() < 4 || !timed.len().is_multiple_of(2) {
        return None;
    }
    let (first, second) = timed.split_at(timed.len() / 2);
    if first
        .iter()
        .map(|(_, ms)| ms)
        .ne(second.iter().map(|(_, ms)| ms))
    {
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

    // 副歌重复常见写法：一行挂两个时间标签。只补第一个的话第二处重复没有译文，
    // 而同一份输入走 lrc_to_srt 是每个标签各展开一条 —— 导出 SRT 双语、导出 LRC 半双语。
    #[test]
    fn merges_every_tag_on_a_multi_timestamp_line() {
        let merged = merge_lrc(
            "[00:12.00][01:20.00]副歌\n[00:30.00]主歌\n",
            "[00:12.00]Chorus\n[01:20.00]Chorus again\n[00:30.00]Verse\n",
        );
        assert_eq!(
            merged,
            "[00:12.00][01:20.00]副歌\n[00:12.00]Chorus\n[01:20.00]Chorus again\n[00:30.00]主歌\n[00:30.00]Verse\n"
        );
        // 元数据标签不是时间，不能被当成时间标签去配译文
        assert_eq!(merge_lrc("[ti:x]\n", "[ti:x]\n"), "[ti:x]\n");
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
        // 假验证码 → 503「验证码错误」
        let e = login_error(
            &json!({"msg":"验证码错误","code":503,"message":"验证码错误"}),
            "",
            200,
        );
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
        let raw =
            "[ti:x]\n[00:01.00]原文一\n[00:03.00]原文二\n[00:01.00]译文一\n[00:03.00]译文二\n";
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

    /// 非法字节序列整条判失败（回退有损解码、让用户看到乱码），不返回「前半截对」的文本。
    ///
    /// 判据是 `gbk_to_string` 直接回 `None`：0xFF 在 GBK 里不可能是首字节，iconv 会在这里
    /// 报 EILSEQ。若实现只按「iconv 没报错」判成功，就会把 `[00:01.00]` 之后的乱码当正文。
    #[test]
    fn invalid_gbk_is_rejected_whole() {
        assert_eq!(gbk_to_string(&[0xff, 0xff]), None);
        // 合法 UTF-8 不该走这条路径，但直接喂给 gbk_to_string 时它按 GBK 解得对
        assert_eq!(gbk_to_string(b"abc"), Some("abc".to_string()));
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
        let e =
            no_direct_link_reason(&json!({ "freeTrialPrivilege": { "cannotListenReason": 2 } }));
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
    fn quality_maps_to_the_request_level_and_encoder() {
        // 实测：standard/higher/exhigh 回 128/192/320 kbps；lossless/hires 才是 flac 流
        assert_eq!(Quality::Standard.level(), "standard");
        assert_eq!(Quality::Exhigh.level(), "exhigh");
        assert_eq!(Quality::Lossless.level(), "lossless");
        assert_eq!(Quality::Hires.level(), "hires");
        // Auto 从最高档起要，服务端按账号权益往下给
        assert_eq!(Quality::Auto.level(), "hires");

        // 无损及以上必须用 flac 求，否则永远拿不到 flac 流；
        // ⚠️ 反向同样成立：exhigh / higher / standard 配 flac 会拿到**更高**一档的 flac，
        // 界面上写「320K」而下回来的是无损，且 downgraded 报不出来
        assert_eq!(Quality::Auto.encode_type(), "mp3");
        assert_eq!(Quality::Standard.encode_type(), "mp3");
        assert_eq!(Quality::Higher.encode_type(), "mp3");
        assert_eq!(Quality::Exhigh.encode_type(), "mp3");
        assert_eq!(Quality::Lossless.encode_type(), "flac");
        assert_eq!(Quality::Hires.encode_type(), "flac");
    }

    #[test]
    fn quality_chain_only_walks_down() {
        // 链必须从本档往下，不能往上：往上要只会拿到同一个降级结果，白费一次请求
        assert_eq!(
            Quality::Lossless.chain(),
            vec![
                Quality::Lossless,
                Quality::Exhigh,
                Quality::Higher,
                Quality::Standard
            ]
        );
        assert_eq!(Quality::Standard.chain(), vec![Quality::Standard]);
        assert_eq!(Quality::Auto.chain().len(), 5);
    }

    /// 用户从开发者工具里复制出来的 Cookie 会被各种空白弄脏：换行、制表符、
    /// 每行一个键值对的缩进，甚至**每个字符后面跟一个换行**（有的复制路径会这样）。
    /// 这些字符原样存进 `config.json` 再当 `Cookie` 头发出去，请求头就是废的，
    /// 而界面上只显示「已设置」——表现是「粘贴了却一直未登录」，用户查不到原因。
    ///
    /// 断言：清洗结果必须是**单行**、分号两侧规范、裸值自动补 `MUSIC_U=`；
    /// 认不出形状的输入要报错（不报错就会被静默写成脏配置）。
    #[test]
    fn clean_cookie_folds_whitespace_and_rejects_garbage() {
        // 每个字符一行：清洗后必须与原文一模一样（分号后统一成一个空格）
        let pairs = [
            ("MUSIC_U", "00D5640F"),
            ("__csrf", "43cba692"),
            ("NMTID", "00OxtNtTEG"),
        ];
        let mut dirty = String::new();
        for (name, value) in pairs {
            dirty.push_str(&format!("{name}={value};\n"));
        }
        let clean = clean_cookie(&dirty).expect("每行一对键值再加换行的粘贴要能洗干净");
        assert_eq!(clean, "MUSIC_U=00D5640F; __csrf=43cba692; NMTID=00OxtNtTEG");
        assert!(!clean.contains('\n') && !clean.contains('\r') && !clean.contains('\t'));
        // 用起来的形状也得对：清洗后的值已经是完整的 Cookie 头，`cookie_of` 不再补名字
        assert_eq!(
            cookie_of(&json!({ "neteaseCookie": clean })),
            "MUSIC_U=00D5640F; __csrf=43cba692; NMTID=00OxtNtTEG"
        );

        // 分号被换成行尾的粘贴（没有分号、只按换行分开）同样要洗干净；
        // 制表符 / 全角空格 / 分号两侧多余的空格一并规范化
        assert_eq!(
            clean_cookie("MUSIC_U=00D5640F\n__csrf=43cba692").unwrap(),
            "MUSIC_U=00D5640F __csrf=43cba692"
        );
        assert_eq!(
            clean_cookie("A=1 ;\tB=2\u{3000}; C=3").unwrap(),
            "A=1; B=2; C=3"
        );
        // 只复制 MUSIC_U 那一格的值：没有 `=` 时当成裸值
        assert_eq!(clean_cookie("00D5640FABC").unwrap(), "MUSIC_U=00D5640FABC");
        // 空串是「清除凭据」，不是错误
        assert_eq!(clean_cookie("   \n ").unwrap(), "");

        // 认不出来的形状要报错，不能静默写进配置
        assert!(clean_cookie("=没有键名").is_err(), "键名为空要报错");
        assert!(clean_cookie("键 名=值").is_err(), "键名里有空格要报错");
        assert!(
            clean_cookie(&"a=b;".repeat(70)).is_err(),
            "`=` 太多 ⇒ 多半是粘坏了"
        );
    }

    #[test]
    fn quality_parse_never_fails_on_a_typo() {
        assert_eq!(Quality::parse("  HIRES "), Quality::Hires);
        assert_eq!(Quality::parse("320k"), Quality::Exhigh);
        assert_eq!(Quality::parse("128"), Quality::Standard);
        // 认不出的值当 Auto（宁可多试几档，也不要因为拼错就直接失败）
        assert_eq!(Quality::parse(""), Quality::Auto);
        assert_eq!(Quality::parse("随便写的"), Quality::Auto);
    }

    #[test]
    fn level_rank_detects_the_silent_downgrade() {
        // 实测最要紧的一条：未登录求 lossless/hires，服务端回 level=exhigh + mp3，
        // 所以「回包 level 的等级 < 请求档位」就是降级，不能当成拿到了无损
        assert!(level_rank("exhigh") < Quality::Lossless.rank());
        assert!(level_rank("exhigh") < Quality::Hires.rank());
        // 够档位就不算降级
        assert!(level_rank("lossless") >= Quality::Lossless.rank());
        // 认不出的档位名（老接口 / 以后新加的）当作「不比请求低」，不误杀能用直链
        assert!(level_rank("something_new") >= Quality::Hires.rank());
    }

    #[test]
    fn audio_format_reads_the_magic_bytes() {
        assert_eq!(
            audio_format(b"ID3\x04\x00\x00\x00\x00\x00\x00\x00\x00\x00\x00"),
            Some("mp3")
        );
        assert_eq!(audio_format(&[0xFF, 0xFB, 0x90, 0x00]), Some("mp3"));
        assert_eq!(audio_format(b"fLaC\x00\x00\x00\x22"), Some("flac"));
        assert_eq!(audio_format(b"OggS\x00\x02\x00\x00"), Some("ogg"));
        // m4a：前 4 字节是 box 长度，第 5..8 字节才是 ftyp
        assert_eq!(audio_format(b"\x00\x00\x00\x20ftypM4A "), Some("m4a"));
        // CDN 的错误页 / 空文件不能被当成音频
        assert_eq!(audio_format(b"<!DOCTYPE html><html>"), None);
        assert_eq!(audio_format(b"Not Found"), None);
        assert_eq!(audio_format(b""), None);
    }

    #[test]
    fn duration_mismatch_catches_a_trial_clip() {
        // 32 kbps… 换成实测形状：320 kbps、整首 223 秒 ≈ 8.9 MB
        let whole = 320_000u64 * 223 / 8;
        assert!(duration_mismatch(whole, 320_000, 223).is_none());
        // 30 秒试听：同一个码率下只有整首的七分之一，必须判出来
        let trial = 320_000u64 * 30 / 8;
        let why = duration_mismatch(trial, 320_000, 223);
        assert!(why.is_some(), "30 秒试听必须判失败");
        assert!(why.unwrap().contains("30"));
        // VBR 的余量：15% 以内的偏差不判（拿不到准确码率时别误杀）
        let slightly_short = 320_000u64 * 200 / 8;
        assert!(duration_mismatch(slightly_short, 320_000, 223).is_none());
        // 时长 / 码率缺失时不判 —— 宁可不判，也不用猜的值误杀
        assert!(duration_mismatch(whole, 0, 223).is_none());
        assert!(duration_mismatch(whole, 320_000, 0).is_none());
        assert!(duration_mismatch(0, 320_000, 223).is_none());
    }

    #[test]
    fn part_path_keeps_the_original_extension() {
        // `.part` 必须追加在原名之后：with_extension("part") 会把 .mp3 顶掉，
        // 校验通过后改回原名就对不上了
        let p = part_path(&Path::new("out").join("歌.mp3"));
        // ⚠️ extension() 看到的是**最后**一段，所以这里是 part；原扩展名留在 file_stem
        // 里（`歌.mp3`）—— 这正是「追加」而非「替换」的意义，改回原名才对得上
        assert_eq!(p.extension().and_then(|x| x.to_str()), Some("part"));
        assert_eq!(p.file_stem().and_then(|x| x.to_str()), Some("歌.mp3"));
        assert!(p.to_string_lossy().ends_with("歌.mp3.part"));
    }

    #[test]
    fn should_renew_only_when_the_credential_is_running_out() {
        let now = 1_700_000_000;
        let day = 86_400;
        // 还剩 30 天：不该续
        assert!(!should_renew(now + 30 * day, now, 7));
        // 还剩 3 天：该续
        assert!(should_renew(now + 3 * day, now, 7));
        // 已经过期：也该续（续一次才有机会拿到新的）
        assert!(should_renew(now - day, now, 7));
        // 有效期未知（只存了 Cookie 的老配置）：续一次把有效期补上
        assert!(should_renew(0, now, 7));
        // days<=0 = 关掉自动续期，什么时候都不续
        assert!(!should_renew(0, now, 0));
        assert!(!should_renew(now + day, now, -1));
    }

    #[test]
    fn cookie_expiry_reads_max_age_from_the_renewal_header() {
        let mut h = reqwest::header::HeaderMap::new();
        // 线上形状：登录 / 续期用 Set-Cookie 换发 MUSIC_U，Max-Age 重新计时
        h.append(
            reqwest::header::SET_COOKIE,
            reqwest::header::HeaderValue::from_static(
                "MUSIC_U=abc123; Path=/; Max-Age=15552000; HttpOnly",
            ),
        );
        // 其它 Cookie 的过期时间不能算到 MUSIC_U 头上
        h.append(
            reqwest::header::SET_COOKIE,
            reqwest::header::HeaderValue::from_static("__csrf=xyz; Max-Age=60"),
        );
        let got = cookie_expiry_from_set_cookie(&h);
        let now = now_secs();
        assert!(
            got >= now + 15_500_000 && got <= now + 15_552_100,
            "应读 MUSIC_U 的 Max-Age（180 天），实际 {got}"
        );

        // 没有 Set-Cookie / 只有 Expires（绝对时间，不猜）都回 0，由调用方用 TTL 兜底
        let mut empty = reqwest::header::HeaderMap::new();
        empty.append(
            reqwest::header::SET_COOKIE,
            reqwest::header::HeaderValue::from_static(
                "MUSIC_U=abc; Expires=Wed, 01 Apr 2027 00:00:00 GMT",
            ),
        );
        assert_eq!(cookie_expiry_from_set_cookie(&empty), 0);
        assert_eq!(
            cookie_expiry_from_set_cookie(&reqwest::header::HeaderMap::new()),
            0
        );
    }

    #[test]
    fn vip_level_suffix_follows_the_client_wording() {
        // 客户端写「黑胶SVIP·肆」，不是「黑胶SVIP Lv4」
        assert_eq!(vip_level_suffix(4), "·肆");
        assert_eq!(vip_level_suffix(1), "·壹");
        assert_eq!(vip_level_suffix(10), "·拾");
        assert_eq!(vip_level_suffix(12), "·拾贰");
        assert_eq!(vip_level_suffix(99), "·玖拾玖");
        // 超出 1..99 不猜，原样退回阿拉伯数字
        assert_eq!(vip_level_suffix(100), "·100");
        // 0 / 负数（没等级）不显示
        assert_eq!(vip_level_suffix(0), "");
        assert_eq!(vip_level_suffix(-3), "");
    }

    #[test]
    fn vip_label_handles_both_vip_type_encodings() {
        // 实测同一个 SVIP 账号：account.vipType=11 标量、profile.vipType=110 位掩码
        assert_eq!(vip_label(11, 0), "黑胶VIP");
        assert_eq!(vip_label(110, 0), "黑胶SVIP");
        // 位值是十进制的 1 / 10 / 100，同时有多项就相加，显示取高的那一档
        assert_eq!(vip_label(10, 0), "黑胶VIP");
        assert_eq!(vip_label(100, 0), "黑胶SVIP");
        assert_eq!(vip_label(101, 0), "黑胶SVIP");
        assert_eq!(vip_label(111, 0), "黑胶SVIP");
        // 标量 20 与会员接口给的 vipCode 300 也记作 SVIP
        assert_eq!(vip_label(20, 4), "黑胶SVIP·肆");
        assert_eq!(vip_label(300, 4), "黑胶SVIP·肆");
        // 位 1 = 音乐包；0 与缺失不能当成「音乐包」
        assert_eq!(vip_label(1, 0), "音乐包");
        assert_eq!(vip_label(0, 0), "普通用户");
        assert_eq!(vip_label(-1, 0), "普通用户");
    }
}
