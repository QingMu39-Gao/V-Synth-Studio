//! B 站解析与下载（原生实现，不依赖 yt-dlp）
//!
//! 对应 Node 的 `net/bilibili.mjs`。支持：
//!  - BV 号 / av 号 / b23.tv 短链 / 番剧 ep 号 / 分P / 合集
//!  - DASH 流解析（视频+音频分离），可选画质与编码
//!  - 官方字幕、弹幕 XML、封面
//!  - 登录 Cookie（SESSDATA）解锁 1080P+ / 大会员画质
//!  - WBI 签名（不签名会被风控拒绝，HTTP 403 / code -352）

use std::io::Read;
use std::path::Path;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Map, Value};

use crate::net::{self, DEFAULT_UA};

const API_VIEW: &str = "https://api.bilibili.com/x/web-interface/view";
const API_PLAYURL: &str = "https://api.bilibili.com/x/player/playurl";
const API_PLAYER_V2: &str = "https://api.bilibili.com/x/player/v2";
const API_NAV: &str = "https://api.bilibili.com/x/web-interface/nav";
const API_PGC_SEASON: &str = "https://api.bilibili.com/pgc/view/web/season";
const API_PGC_PLAYURL: &str = "https://api.bilibili.com/pgc/player/web/playurl";
const API_DANMAKU_XML: &str = "https://api.bilibili.com/x/v1/dm/list.so";

/// WBI 混淆表（B 站公开实现约定）
const MIXIN_KEY_ENC_TAB: [usize; 64] = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
    28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
    54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

/// 画质号 → 中文名
fn quality_name(id: i64) -> String {
    let name = match id {
        6 => "240P 极速",
        16 => "360P 流畅",
        32 => "480P 清晰",
        64 => "720P 高清",
        74 => "720P60 高帧率",
        80 => "1080P 高清",
        100 => "智能修复",
        112 => "1080P+ 高码率",
        116 => "1080P60 高帧率",
        120 => "4K 超清",
        125 => "HDR 真彩",
        126 => "杜比视界",
        127 => "8K 超高清",
        _ => return format!("画质 {id}"),
    };
    name.to_string()
}

/// 音频流 id → 中文名
fn audio_name(id: i64) -> String {
    let name = match id {
        30216 => "64K 低码率",
        30232 => "132K 中码率",
        30280 => "192K 高码率",
        30250 => "杜比全景声",
        30251 => "Hi-Res 无损",
        _ => return format!("音频 {id}"),
    };
    name.to_string()
}

/* ══════════════════════════════════ 小工具 ══════════════════════════════════ */

/// 按路径取嵌套字段（对应 JS 的可选链 `a?.b?.c`）
fn at<'a>(v: &'a Value, path: &[&str]) -> Option<&'a Value> {
    let mut cur = v;
    for k in path {
        cur = cur.get(k)?;
    }
    if cur.is_null() {
        None
    } else {
        Some(cur)
    }
}

/// 只在有值时插入 —— Node 的 `undefined` 会被 JSON.stringify 丢掉，
/// 这里也必须丢掉，否则形状就不一样了。
fn put(m: &mut Map<String, Value>, k: &str, v: Option<Value>) {
    if let Some(v) = v {
        m.insert(k.to_string(), v);
    }
}

fn put_at(m: &mut Map<String, Value>, k: &str, src: &Value, path: &[&str]) {
    put(m, k, at(src, path).cloned());
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// 时间戳（秒）→ `YYYY-MM-DD`（UTC，和 `new Date(x*1000).toISOString().slice(0,10)` 等价）
fn iso_date(secs: i64) -> String {
    let (y, m, d) = crate::tools::civil_from_days(secs.div_euclid(86400));
    format!("{y:04}-{m:02}-{d:02}")
}

/// 文件名友好的标题
pub fn safe_title(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || (c as u32) < 0x20
            {
                '_'
            } else {
                c
            }
        })
        .collect();
    let collapsed = cleaned.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim();
    if trimmed.is_empty() {
        return "video".to_string();
    }
    trimmed.chars().take(100).collect()
}

/* ══════════════════════════════════ WBI 签名 ══════════════════════════════════ */

fn mixin_key(orig: &str) -> String {
    let bytes = orig.as_bytes();
    MIXIN_KEY_ENC_TAB
        .iter()
        .filter_map(|&n| bytes.get(n).copied())
        .map(|b| b as char)
        .take(32)
        .collect()
}

/// 给参数加上 wts 与 w_rid 签名。抽成纯函数是为了能用固定向量做单元测试。
pub fn wbi_query(params: &[(&str, String)], wts: u64, img_key: &str, sub_key: &str) -> String {
    let key = mixin_key(&format!("{img_key}{sub_key}"));
    let mut all: Vec<(&str, String)> = params.to_vec();
    all.push(("wts", wts.to_string()));
    all.sort_by(|a, b| a.0.cmp(b.0));

    let query = all
        .iter()
        .map(|(k, v)| {
            let cleaned: String = v.chars().filter(|c| !"!'()*".contains(*c)).collect();
            format!(
                "{}={}",
                net::encode_component(k),
                net::encode_component(&cleaned)
            )
        })
        .collect::<Vec<_>>()
        .join("&");

    let rid = net::md5_hex(format!("{query}{key}").as_bytes());
    format!("{query}&w_rid={rid}")
}

/* ══════════════════════════════════ 客户端 ══════════════════════════════════ */

#[derive(Clone)]
struct WbiKeys {
    img_key: String,
    sub_key: String,
    at: u64,
}

pub struct Bili {
    raw_cookie: String,
    user_agent: String,
    timeout: u64,
    wbi: Mutex<Option<WbiKeys>>,
}

/// 解析结果（对应 Node 的 parseInput 返回值）
#[derive(Default)]
pub struct Parsed {
    pub kind: String,
    pub bvid: Option<String>,
    pub aid: Option<i64>,
    pub ep_id: Option<i64>,
    pub season_id: Option<i64>,
    pub page: i64,
}

impl Bili {
    pub fn new(cookie: &str) -> Self {
        Self {
            raw_cookie: cookie.trim().to_string(),
            user_agent: DEFAULT_UA.to_string(),
            timeout: 20,
            wbi: Mutex::new(None),
        }
    }

    /// 允许只填 SESSDATA 的值
    fn cookie(&self) -> String {
        if self.raw_cookie.is_empty() {
            return String::new();
        }
        if !self.raw_cookie.contains('=') {
            return format!("SESSDATA={}", self.raw_cookie);
        }
        self.raw_cookie.clone()
    }

    pub fn has_login(&self) -> bool {
        self.cookie().contains("SESSDATA=")
    }

    fn headers(&self) -> Vec<(String, String)> {
        let mut h = vec![
            ("User-Agent".to_string(), self.user_agent.clone()),
            ("Referer".to_string(), "https://www.bilibili.com/".to_string()),
            ("Origin".to_string(), "https://www.bilibili.com".to_string()),
        ];
        let cookie = self.cookie();
        if !cookie.is_empty() {
            h.push(("Cookie".to_string(), cookie));
        }
        h
    }

    fn header_refs(h: &[(String, String)]) -> Vec<(&str, &str)> {
        h.iter().map(|(k, v)| (k.as_str(), v.as_str())).collect()
    }

    async fn get_wbi_keys(&self) -> Result<(String, String), String> {
        if let Ok(cache) = self.wbi.lock() {
            if let Some(k) = cache.as_ref() {
                if now_secs().saturating_sub(k.at) < 3600 {
                    return Ok((k.img_key.clone(), k.sub_key.clone()));
                }
            }
        }
        let h = self.headers();
        let json = net::fetch_json(API_NAV, net::headers(&Self::header_refs(&h)), self.timeout, 2)
            .await?;
        let img_url = at(&json, &["data", "wbi_img", "img_url"])
            .and_then(|v| v.as_str())
            .unwrap_or("");
        let sub_url = at(&json, &["data", "wbi_img", "sub_url"])
            .and_then(|v| v.as_str())
            .unwrap_or("");
        if img_url.is_empty() || sub_url.is_empty() {
            return Err("无法获取 WBI 密钥（B 站接口返回异常）".to_string());
        }
        // basename(u).split('.')[0]
        let pick = |u: &str| {
            u.rsplit('/')
                .next()
                .unwrap_or(u)
                .split('.')
                .next()
                .unwrap_or("")
                .to_string()
        };
        let keys = WbiKeys {
            img_key: pick(img_url),
            sub_key: pick(sub_url),
            at: now_secs(),
        };
        let out = (keys.img_key.clone(), keys.sub_key.clone());
        if let Ok(mut cache) = self.wbi.lock() {
            *cache = Some(keys);
        }
        Ok(out)
    }

    /// 带 WBI 签名的 GET，顺带把 B 站的业务错误码转成人话
    async fn api_get(&self, url: &str, params: &[(&str, String)]) -> Result<Value, String> {
        let (img_key, sub_key) = self.get_wbi_keys().await?;
        let signed = wbi_query(params, now_secs(), &img_key, &sub_key);
        let h = self.headers();
        let json = net::fetch_json(
            &format!("{url}?{signed}"),
            net::headers(&Self::header_refs(&h)),
            self.timeout,
            2,
        )
        .await?;

        let code = json.get("code").and_then(|v| v.as_i64()).unwrap_or(0);
        if code != 0 {
            let msg = json
                .get("message")
                .and_then(|v| v.as_str())
                .unwrap_or("未知错误");
            let hint = if code == -352 {
                "（可能触发了风控，请稍后重试或填写 Cookie）"
            } else {
                ""
            };
            return Err(format!("B 站接口错误 {code}：{msg}{hint}"));
        }
        Ok(json)
    }

    /* -------------------------------------------------------- 输入解析 */

    pub async fn parse_input(&self, raw: &str) -> Result<Parsed, String> {
        let input = raw.trim();
        if input.is_empty() {
            return Err("请输入视频链接或 BV 号".to_string());
        }

        // 短链展开
        let lower = input.to_lowercase();
        let mut url = input.to_string();
        if lower.starts_with("http://b23.tv/")
            || lower.starts_with("https://b23.tv/")
            || lower.starts_with("b23.tv/")
        {
            let full = if input.starts_with("http") {
                input.to_string()
            } else {
                format!("https://{input}")
            };
            let h = self.headers();
            url = net::resolve_redirect(&full, net::headers(&Self::header_refs(&h)), 12).await;
        }

        // 番剧
        if let Some(ep) = digits_after(&url, "/bangumi/play/ep") {
            return Ok(Parsed {
                kind: "bangumi".into(),
                ep_id: Some(ep),
                page: 1,
                ..Default::default()
            });
        }
        if let Some(ss) = digits_after(&url, "/bangumi/play/ss") {
            return Ok(Parsed {
                kind: "bangumi".into(),
                season_id: Some(ss),
                page: 1,
                ..Default::default()
            });
        }

        // 普通视频
        let page = param_number(&url, "p").unwrap_or(1);
        if let Some(bv) = find_bv(&url) {
            return Ok(Parsed {
                kind: "video".into(),
                bvid: Some(bv),
                page,
                ..Default::default()
            });
        }
        if let Some(av) = digits_after(&url, "/video/av").or_else(|| {
            input
                .strip_prefix("av")
                .filter(|rest| !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit()))
                .and_then(|rest| rest.parse::<i64>().ok())
        }) {
            return Ok(Parsed {
                kind: "video".into(),
                aid: Some(av),
                page,
                ..Default::default()
            });
        }
        if !input.is_empty() && input.chars().all(|c| c.is_ascii_digit()) {
            return Ok(Parsed {
                kind: "video".into(),
                aid: input.parse::<i64>().ok(),
                page: 1,
                ..Default::default()
            });
        }
        Err("无法识别的链接。支持：BV 号、av 号、b23.tv 短链、bilibili.com/video/... 、番剧 ep/ss 链接".to_string())
    }

    /* ---------------------------------------------------------- 视频信息 */

    pub async fn get_video_info(&self, bvid: Option<&str>, aid: Option<i64>) -> Result<Value, String> {
        let params: Vec<(&str, String)> = match bvid {
            Some(b) => vec![("bvid", b.to_string())],
            None => vec![("aid", aid.unwrap_or(0).to_string())],
        };
        let json = self.api_get(API_VIEW, &params).await?;
        let d = json
            .get("data")
            .cloned()
            .ok_or_else(|| "B 站接口错误：返回内容缺少 data".to_string())?;

        let pages: Vec<Value> = at(&d, &["pages"])
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|p| {
                        let page_no = p.get("page").and_then(|v| v.as_i64()).unwrap_or(1);
                        let mut m = Map::new();
                        put_at(&mut m, "cid", p, &["cid"]);
                        m.insert("page".into(), json!(page_no));
                        let part = p.get("part").and_then(|v| v.as_str()).unwrap_or("");
                        m.insert(
                            "title".into(),
                            json!(if part.is_empty() {
                                format!("P{page_no}")
                            } else {
                                part.to_string()
                            }),
                        );
                        put_at(&mut m, "durationSec", p, &["duration"]);
                        put_at(&mut m, "width", p, &["dimension", "width"]);
                        put_at(&mut m, "height", p, &["dimension", "height"]);
                        Value::Object(m)
                    })
                    .collect()
            })
            .unwrap_or_default();

        // 合集
        let sections = at(&d, &["ugc_season", "sections"])
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let season = if !sections.is_empty() || at(&d, &["ugc_season"]).is_some() {
            let mut episodes = Vec::new();
            for s in &sections {
                if let Some(eps) = s.get("episodes").and_then(|v| v.as_array()) {
                    for e in eps {
                        let mut m = Map::new();
                        put_at(&mut m, "bvid", e, &["bvid"]);
                        put_at(&mut m, "aid", e, &["aid"]);
                        put_at(&mut m, "cid", e, &["cid"]);
                        let title = at(e, &["title"])
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty())
                            .map(String::from)
                            .or_else(|| {
                                at(e, &["arc", "title"])
                                    .and_then(|v| v.as_str())
                                    .map(String::from)
                            })
                            .unwrap_or_default();
                        m.insert("title".into(), json!(title));
                        let dur = at(e, &["arc", "duration"])
                            .cloned()
                            .or_else(|| at(e, &["pages"]).and_then(|v| v.as_array()).and_then(|a| a.first()).and_then(|p| p.get("duration")).cloned())
                            .unwrap_or(json!(0));
                        m.insert("durationSec".into(), dur);
                        episodes.push(Value::Object(m));
                    }
                }
            }
            let mut m = Map::new();
            put_at(&mut m, "id", &d, &["ugc_season", "id"]);
            m.insert(
                "title".into(),
                at(&d, &["ugc_season", "title"])
                    .cloned()
                    .unwrap_or(json!("")),
            );
            m.insert("episodes".into(), Value::Array(episodes));
            Some(Value::Object(m))
        } else {
            None
        };

        let bvid_out = d.get("bvid").cloned();
        let mut m = Map::new();
        m.insert("kind".into(), json!("video"));
        put(&mut m, "bvid", bvid_out.clone());
        put_at(&mut m, "aid", &d, &["aid"]);
        put_at(&mut m, "title", &d, &["title"]);
        put_at(&mut m, "cover", &d, &["pic"]);
        put(&mut m, "desc", Some(at(&d, &["desc"]).cloned().unwrap_or(json!(""))));
        put_at(&mut m, "durationSec", &d, &["duration"]);
        let pubdate = d.get("pubdate").and_then(|v| v.as_i64()).unwrap_or(0);
        m.insert(
            "publishDate".into(),
            json!(if pubdate != 0 {
                iso_date(pubdate)
            } else {
                String::new()
            }),
        );
        put(
            &mut m,
            "uploader",
            Some(at(&d, &["owner", "name"]).cloned().unwrap_or(json!(""))),
        );
        put_at(&mut m, "uploaderMid", &d, &["owner", "mid"]);
        put(
            &mut m,
            "view",
            Some(at(&d, &["stat", "view"]).cloned().unwrap_or(json!(0))),
        );
        put(
            &mut m,
            "like",
            Some(at(&d, &["stat", "like"]).cloned().unwrap_or(json!(0))),
        );
        m.insert("pages".into(), Value::Array(pages));
        m.insert("season".into(), season.unwrap_or(Value::Null));
        m.insert(
            "url".into(),
            json!(format!(
                "https://www.bilibili.com/video/{}",
                bvid_out.and_then(|v| v.as_str().map(String::from)).unwrap_or_default()
            )),
        );
        Ok(Value::Object(m))
    }

    /* ------------------------------------------------------------ 番剧信息 */

    pub async fn get_bangumi_info(&self, ep_id: Option<i64>, season_id: Option<i64>) -> Result<Value, String> {
        let params: Vec<(&str, String)> = match ep_id {
            Some(ep) => vec![("ep_id", ep.to_string())],
            None => vec![("season_id", season_id.unwrap_or(0).to_string())],
        };
        let json = self.api_get(API_PGC_SEASON, &params).await?;
        let r = json
            .get("result")
            .cloned()
            .ok_or_else(|| "B 站接口错误：番剧接口没有返回 result".to_string())?;

        let episodes: Vec<Value> = at(&r, &["episodes"])
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|e| {
                        let mut m = Map::new();
                        put_at(&mut m, "epId", e, &["ep_id"]);
                        put_at(&mut m, "aid", e, &["aid"]);
                        put_at(&mut m, "bvid", e, &["bvid"]);
                        put_at(&mut m, "cid", e, &["cid"]);
                        let title = at(e, &["share_copy"])
                            .and_then(|v| v.as_str())
                            .filter(|s| !s.is_empty())
                            .map(String::from)
                            .or_else(|| at(e, &["title"]).and_then(|v| v.as_str()).map(String::from))
                            .unwrap_or_default();
                        m.insert("title".into(), json!(title));
                        m.insert(
                            "longTitle".into(),
                            at(e, &["long_title"]).cloned().unwrap_or(json!("")),
                        );
                        let dur = e.get("duration").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        m.insert(
                            "durationSec".into(),
                            json!(if dur != 0.0 { (dur / 1000.0).round() as i64 } else { 0 }),
                        );
                        put_at(&mut m, "cover", e, &["cover"]);
                        Value::Object(m)
                    })
                    .collect()
            })
            .unwrap_or_default();

        let first_ep_id = match ep_id {
            Some(ep) => episodes
                .iter()
                .find(|e| e.get("epId").and_then(|v| v.as_i64()) == Some(ep))
                .or_else(|| episodes.first()),
            None => episodes.first(),
        }
        .map(|f| {
            (
                f.get("epId").cloned(),
                f.get("cid").cloned(),
            )
        });
        let (first_ep, first_cid) = match first_ep_id {
            Some((a, b)) => (a, b),
            None => (None, None),
        };

        let mut m = Map::new();
        m.insert("kind".into(), json!("bangumi"));
        put_at(&mut m, "seasonId", &r, &["season_id"]);
        match first_ep {
            Some(v) => {
                m.insert("epId".into(), v);
            }
            None => put(&mut m, "epId", ep_id.map(|e| json!(e))),
        }
        put(&mut m, "cid", first_cid);
        m.insert(
            "title".into(),
            at(&r, &["title"]).cloned().unwrap_or(json!("")),
        );
        m.insert(
            "cover".into(),
            at(&r, &["cover"]).cloned().unwrap_or(json!("")),
        );
        m.insert(
            "desc".into(),
            at(&r, &["evaluate"]).cloned().unwrap_or(json!("")),
        );
        m.insert("episodes".into(), Value::Array(episodes));
        let url = match m.get("epId").and_then(|v| v.as_i64()) {
            Some(id) => format!("https://www.bilibili.com/bangumi/play/ep{id}"),
            None => String::new(),
        };
        m.insert("url".into(), json!(url));
        Ok(Value::Object(m))
    }

    /* ---------------------------------------------------------- 取流地址 */

    pub async fn get_play_streams(
        &self,
        bvid: Option<&str>,
        aid: Option<i64>,
        cid: i64,
        qn: i64,
        bangumi_ep_id: Option<i64>,
    ) -> Result<Value, String> {
        const FNVAL: i64 = 4048; // DASH + 4K + HDR + 杜比 + 8K + AV1

        let payload = if let Some(ep) = bangumi_ep_id {
            let json = self
                .api_get(
                    API_PGC_PLAYURL,
                    &[
                        ("ep_id", ep.to_string()),
                        ("cid", cid.to_string()),
                        ("qn", qn.to_string()),
                        ("fnval", FNVAL.to_string()),
                        ("fourk", "1".to_string()),
                    ],
                )
                .await?;
            json.get("result").cloned()
        } else {
            let mut params = vec![("bvid", bvid.unwrap_or("").to_string())];
            if let Some(a) = aid {
                params.push(("avid", a.to_string()));
            }
            params.push(("cid", cid.to_string()));
            params.push(("qn", qn.to_string()));
            params.push(("fnval", FNVAL.to_string()));
            params.push(("fourk", "1".to_string()));
            params.push(("platform", "pc".to_string()));
            let json = self.api_get(API_PLAYURL, &params).await?;
            json.get("data").cloned()
        };

        let payload = payload.filter(|v| !v.is_null()).ok_or_else(|| {
            "未获取到播放流（该视频可能受版权限制、需要大会员或已下架）".to_string()
        })?;

        let accept_quality = payload
            .get("accept_quality")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let accept_description = payload
            .get("accept_description")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();

        let dash = payload.get("dash").filter(|v| !v.is_null());
        let Some(dash) = dash else {
            // 退回 durl（老视频/番剧有时只有整段 FLV/MP4）
            let durl = payload
                .get("durl")
                .and_then(|v| v.as_array())
                .cloned()
                .unwrap_or_default();
            if durl.is_empty() {
                return Err("该视频没有可用的 DASH 流，也没有整段流".to_string());
            }
            let streams = durl
                .iter()
                .enumerate()
                .map(|(i, d)| {
                    let mut m = Map::new();
                    m.insert("kind".into(), json!("segment"));
                    m.insert("index".into(), json!(i + 1));
                    put_at(&mut m, "url", d, &["url"]);
                    m.insert(
                        "backupUrls".into(),
                        d.get("backup_url").cloned().unwrap_or(json!([])),
                    );
                    put_at(&mut m, "size", d, &["size"]);
                    put_at(&mut m, "lengthMs", d, &["length"]);
                    Value::Object(m)
                })
                .collect();
            let mut m = Map::new();
            m.insert("mode".into(), json!("durl"));
            m.insert("acceptQuality".into(), Value::Array(accept_quality));
            m.insert("acceptDescription".into(), Value::Array(accept_description));
            m.insert("streams".into(), Value::Array(streams));
            return Ok(Value::Object(m));
        };

        let id_of = |v: &Value| v.get("id").and_then(|x| x.as_i64()).unwrap_or(0);
        let bandwidth_of = |v: &Value| v.get("bandwidth").and_then(|x| x.as_i64()).unwrap_or(0);

        let mut video: Vec<Value> = dash
            .get("video")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|v| {
                        let id = id_of(v);
                        let mut m = Map::new();
                        m.insert("kind".into(), json!("video"));
                        m.insert("id".into(), json!(id));
                        m.insert("qualityName".into(), json!(quality_name(id)));
                        put(
                            &mut m,
                            "url",
                            at(v, &["baseUrl"]).or_else(|| at(v, &["base_url"])).cloned(),
                        );
                        m.insert(
                            "backupUrls".into(),
                            at(v, &["backupUrl"])
                                .or_else(|| at(v, &["backup_url"]))
                                .cloned()
                                .unwrap_or(json!([])),
                        );
                        put_at(&mut m, "bandwidth", v, &["bandwidth"]);
                        put(
                            &mut m,
                            "mimeType",
                            at(v, &["mimeType"]).or_else(|| at(v, &["mime_type"])).cloned(),
                        );
                        put_at(&mut m, "codecs", v, &["codecs"]);
                        put_at(&mut m, "width", v, &["width"]);
                        put_at(&mut m, "height", v, &["height"]);
                        put(
                            &mut m,
                            "frameRate",
                            at(v, &["frameRate"]).or_else(|| at(v, &["frame_rate"])).cloned(),
                        );
                        Value::Object(m)
                    })
                    .collect()
            })
            .unwrap_or_default();

        let audio: Vec<Value> = dash
            .get("audio")
            .and_then(|v| v.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|a| {
                        let id = id_of(a);
                        let mut m = Map::new();
                        m.insert("kind".into(), json!("audio"));
                        m.insert("id".into(), json!(id));
                        m.insert("qualityName".into(), json!(audio_name(id)));
                        put(
                            &mut m,
                            "url",
                            at(a, &["baseUrl"]).or_else(|| at(a, &["base_url"])).cloned(),
                        );
                        m.insert(
                            "backupUrls".into(),
                            at(a, &["backupUrl"])
                                .or_else(|| at(a, &["backup_url"]))
                                .cloned()
                                .unwrap_or(json!([])),
                        );
                        put_at(&mut m, "bandwidth", a, &["bandwidth"]);
                        put(
                            &mut m,
                            "mimeType",
                            at(a, &["mimeType"]).or_else(|| at(a, &["mime_type"])).cloned(),
                        );
                        put_at(&mut m, "codecs", a, &["codecs"]);
                        Value::Object(m)
                    })
                    .collect()
            })
            .unwrap_or_default();

        // 去重：同一画质保留码率最高的
        let mut best: Vec<Value> = Vec::new();
        for v in video.drain(..) {
            match best.iter_mut().find(|b| id_of(b) == id_of(&v)) {
                Some(cur) => {
                    if bandwidth_of(&v) > bandwidth_of(cur) {
                        *cur = v;
                    }
                }
                None => best.push(v),
            }
        }
        best.sort_by_key(|v| -id_of(v));

        // 优先 AVC/H.264（兼容性最好）
        let is_avc = |v: &Value| {
            let c = v.get("codecs").and_then(|x| x.as_str()).unwrap_or("").to_lowercase();
            c.contains("avc") || c.contains("h264")
        };
        let is_hevc = |v: &Value| {
            let c = v.get("codecs").and_then(|x| x.as_str()).unwrap_or("").to_lowercase();
            c.contains("hev") || c.contains("h265")
        };
        let video_avc: Vec<Value> = best.iter().filter(|v| is_avc(v)).cloned().collect();
        let video_hevc: Vec<Value> = best.iter().filter(|v| is_hevc(v)).cloned().collect();

        let mut audio = audio;
        audio.sort_by_key(|a| -id_of(a));

        let mut m = Map::new();
        m.insert("mode".into(), json!("dash"));
        m.insert("acceptQuality".into(), Value::Array(accept_quality));
        m.insert("acceptDescription".into(), Value::Array(accept_description));
        m.insert("video".into(), Value::Array(best));
        m.insert("videoAvc".into(), Value::Array(video_avc));
        m.insert("videoHevc".into(), Value::Array(video_hevc));
        m.insert("audio".into(), Value::Array(audio));
        put_at(&mut m, "durationMs", &payload, &["timelength"]);
        m.insert(
            "isPreview".into(),
            json!(payload.get("is_preview").and_then(|v| v.as_bool()).unwrap_or(false)),
        );
        Ok(Value::Object(m))
    }

    /* ---------------------------------------------------------- 字幕 / 弹幕 */

    pub async fn get_subtitles(&self, bvid: Option<&str>, aid: Option<i64>, cid: i64) -> Result<Vec<Value>, String> {
        let mut params: Vec<(&str, String)> = vec![("bvid", bvid.unwrap_or("").to_string())];
        if let Some(a) = aid {
            params.push(("aid", a.to_string()));
        }
        params.push(("cid", cid.to_string()));
        let json = self.api_get(API_PLAYER_V2, &params).await?;

        let list = at(&json, &["data", "subtitle", "subtitles"])
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        Ok(list
            .iter()
            .map(|s| {
                let mut m = Map::new();
                put_at(&mut m, "lan", s, &["lan"]);
                put_at(&mut m, "lanDoc", s, &["lan_doc"]);
                let url = s.get("subtitle_url").and_then(|v| v.as_str()).unwrap_or("");
                m.insert(
                    "url".into(),
                    json!(if let Some(rest) = url.strip_prefix("//") {
                        format!("https:{rest}")
                    } else {
                        url.to_string()
                    }),
                );
                let is_ai = s.get("ai_type").and_then(|v| v.as_i64()) == Some(1)
                    || s.get("type").and_then(|v| v.as_i64()) == Some(1);
                m.insert("isAi".into(), json!(is_ai));
                Value::Object(m)
            })
            .collect())
    }

    /// 弹幕（XML 文本）
    pub async fn get_danmaku_xml(&self, cid: i64) -> Result<String, String> {
        let mut h = self.headers();
        h.push(("Accept".to_string(), "text/xml, */*".to_string()));
        let bytes = net::fetch_bytes(
            &format!("{API_DANMAKU_XML}?oid={cid}"),
            net::headers(&Self::header_refs(&h)),
            self.timeout,
        )
        .await?;

        // B 站弹幕接口返回裸 deflate，没有 Content-Encoding 头
        let text = String::from_utf8_lossy(&bytes).to_string();
        if text.trim_start().starts_with('<') {
            return Ok(text);
        }
        for raw in [true, false] {
            let mut out = String::new();
            let ok = if raw {
                flate2::read::DeflateDecoder::new(&bytes[..]).read_to_string(&mut out)
            } else {
                flate2::read::ZlibDecoder::new(&bytes[..]).read_to_string(&mut out)
            };
            if ok.is_ok() && out.trim_start().starts_with('<') {
                return Ok(out);
            }
        }
        Ok(text)
    }

    /* ------------------------------------------------------------ 下载 */

    /// 用 B 站必需的请求头下载单个资源（主地址失败自动试备用地址）
    pub async fn download_asset(
        &self,
        url: &str,
        dest: &Path,
        backup_urls: &[String],
        threads: usize,
        cancel: &net::Cancel,
        on_progress: &net::OnProgress,
    ) -> Result<u64, String> {
        let owned = self.headers();
        let refs = Self::header_refs(&owned);

        let mut last = String::new();
        for u in std::iter::once(url.to_string()).chain(backup_urls.iter().cloned()) {
            match net::download_to_file(&u, dest, &refs, threads, cancel, on_progress).await {
                Ok(n) => return Ok(n),
                Err(e) => last = e,
            }
        }
        Err(if last.is_empty() {
            "下载失败".to_string()
        } else {
            last
        })
    }
}

/* ══════════════════════════════════ 输入解析小工具 ══════════════════════════════════ */

/// `/bangumi/play/ep123` 这类固定前缀后面的数字
fn digits_after(text: &str, prefix: &str) -> Option<i64> {
    let lower = text.to_lowercase();
    let idx = lower.find(&prefix.to_lowercase())? + prefix.len();
    let digits: String = text[idx..]
        .chars()
        .take_while(|c| c.is_ascii_digit())
        .collect();
    if digits.is_empty() {
        None
    } else {
        digits.parse().ok()
    }
}

/// 找第一个 `BV` + 10 位字母数字
fn find_bv(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    for i in 0..bytes.len().saturating_sub(1) {
        if bytes[i] == b'B' && bytes[i + 1] == b'V' {
            let rest: String = text[i + 2..].chars().take(10).collect();
            if rest.chars().count() == 10 && rest.chars().all(|c| c.is_ascii_alphanumeric()) {
                return Some(format!("BV{rest}"));
            }
        }
    }
    None
}

/// `?p=3` / `&p=3` 里的数字
fn param_number(url: &str, name: &str) -> Option<i64> {
    let lower = url.to_lowercase();
    for sep in ['?', '&'] {
        let needle = format!("{sep}{}=", name.to_lowercase());
        if let Some(idx) = lower.find(&needle) {
            let digits: String = url[idx + needle.len()..]
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect();
            if !digits.is_empty() {
                return digits.parse().ok();
            }
        }
    }
    None
}

/// 判断是不是 B 站链接 / 编号（对应 Node 路由里的 isBili 正则）
pub fn is_bilibili(raw: &str) -> bool {
    let lower = raw.to_lowercase();
    if lower.contains("bilibili.com") || lower.contains("b23.tv") {
        return true;
    }
    let bytes = raw.as_bytes();
    if bytes.len() == 12 && raw.starts_with("BV") {
        let rest = &raw[2..];
        if rest.chars().all(|c| c.is_ascii_alphanumeric()) {
            return true;
        }
    }
    if lower.starts_with("av") {
        let rest = &raw[2..];
        return !rest.is_empty() && rest.chars().all(|c| c.is_ascii_digit());
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wbi_signature_matches_the_reference_implementation() {
        // 期望值来自 Node 版同一套参数算出来的结果（见 tests/manual 里的说明）
        let params = vec![
            ("bvid", "BV1GJ411x7h7".to_string()),
            ("cid", "137649199".to_string()),
            ("qn", "127".to_string()),
            ("fnval", "4048".to_string()),
            ("fourk", "1".to_string()),
            ("platform", "pc".to_string()),
        ];
        let q = wbi_query(
            &params,
            1700000000,
            "7cd084941338484aae1ad9425b84077c",
            "4932caff0ff746eab6f01bf08b70ac45",
        );
        assert_eq!(
            q,
            "bvid=BV1GJ411x7h7&cid=137649199&fnval=4048&fourk=1&platform=pc&qn=127&wts=1700000000&w_rid=00ad4f9c8d274fc57772863d59d8ab2b"
        );
    }

    #[tokio::test]
    async fn parses_every_link_shape_the_node_version_supports() {
        let cases = [
            ("BV1GJ411x7h7", "video"),
            ("https://www.bilibili.com/video/BV1GJ411x7h7?p=3", "video"),
            ("https://www.bilibili.com/video/av80433022", "video"),
            ("av80433022", "video"),
            ("80433022", "video"),
            ("https://www.bilibili.com/bangumi/play/ep123456", "bangumi"),
            ("https://www.bilibili.com/bangumi/play/ss28747", "bangumi"),
        ];
        for (input, kind) in cases {
            let parsed = Bili::new("").parse_input(input).await.unwrap();
            assert_eq!(parsed.kind, kind, "输入 {input}");
        }

        assert!(Bili::new("").parse_input("随便写点什么").await.is_err());
        assert_eq!(
            Bili::new("")
                .parse_input("https://www.bilibili.com/video/BV1GJ411x7h7?p=3")
                .await
                .unwrap()
                .page,
            3
        );
    }

    #[test]
    fn safe_title_strips_illegal_characters() {
        assert_eq!(safe_title("a/b\\c:d*e?f\"g<h>i|j"), "a_b_c_d_e_f_g_h_i_j");
        assert_eq!(safe_title("  hello   world  "), "hello world");
        assert_eq!(safe_title(""), "video");
        assert_eq!(safe_title("///"), "___");
    }

    #[test]
    fn detects_bilibili_inputs() {
        assert!(is_bilibili("https://www.bilibili.com/video/BV1GJ411x7h7"));
        assert!(is_bilibili("b23.tv/abc"));
        assert!(is_bilibili("BV1GJ411x7h7"));
        assert!(is_bilibili("av12345"));
        assert!(!is_bilibili("https://www.youtube.com/watch?v=x"));
        assert!(!is_bilibili("BV1GJ411x7h")); // 位数不够
    }
}
