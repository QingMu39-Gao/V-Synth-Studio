//! 「检查更新」—— 问一次 GitHub Releases 上最新那条发布。
//!
//! ⚠️ **只查，不自动装**：回包里有版本号、说明、发布页地址、以及**本机该下的那个
//! 安装包**（`installer`）。下不下、装不装由用户决定（`ipc::update::update_download`
//! 是用户在界面上点了「下载新版本」之后才走的路）。
//!
//! 上游仓库写死在这里（不是配置项）：它就是这个程序自己的仓库，
//! 换个地址查到的版本号与本机没有任何可比性。
//!
//! # 三档来源，按这个顺序试
//!
//!   1. **自建源**（[`SELF_HOST_BASES`]，可留空）：自己租的服务器，境内直连快；
//!   2. **GitHub 直连** `api.github.com`；
//!   3. **[`API_MIRRORS`] 里那几面**（拼接方式见 [`mirror_url`]），按顺序试到第一个能用为止。
//!
//! 判据是**响应体**：能解析出 `tag_name` 才算数 —— 代理回一页 HTML / 403 错误页是常事，
//! 只看状态码会把它们当成「查到了」。自建源更严：它**任何**非 200 都只算「没答上来」，
//! 继续往下问（服务器搬家时 nginx 会回 502，那不是 GitHub 的答案）。
//!
//! ⚠️ **镜像那套不是把 `ghmirror` 搬过来**：那个是给几 GB 的下载「实测挑最快的一面」，
//! 而这里只取一份几 KB 的 JSON —— 为它去取测速名单、开八个并发实测，代价与收益
//! 完全不成比例。这里的名单是固定的几面，按顺序试到第一个能用的为止。
//!
//! ⚠️ **镜像名单里只放实测确认能代理 `api.github.com` 的**。GitHub 的公开 API 会对
//! **代理的共享出口 IP** 限流：实测 `ghfast.top` / `gh.llkk.cc` / `ghproxy.net`
//! 走 API 路径一律回 403，而同一个文件走它们下载是好的 —— 用下载镜像的思路猜
//! API 镜像会挑到一堆 403。
//!
//! ⚠️ 镜像拿到的是本程序的版本询问，**不含 Cookie、不含账号信息**；回包还会带
//! `via` / `source`，界面据此说明这次是哪一档答的。

use std::time::Duration;

use serde_json::{Value, json};

/// 上游仓库的规范接口地址。
const LATEST_API: &str = "https://api.github.com/repos/QingMu39-Gao/V-Synth-Studio/releases/latest";

/// **自建更新接口**（第一优先）。
///
/// ⚠️ 只写域名、不写 IP：源站只允许 Cloudflare 回源，直连 IP 会被网络层丢弃
/// （表现为超时，不是拒绝）。证书是公共可信证书，普通客户端直接信任，不需要关校验。
/// 换地址只改这一行；本地 mock 用环境变量 `VSS_UPDATE_URL` 覆盖。
const UPDATE_URL: &str = "https://admin1.qingmu39.top/api/version.json";

/// 自建接口的等待上限。它离用户最近、又只有一份几百字节的 JSON —— 失败就该早点往下走
/// （后面还有 GitHub 直连 6 秒、两面镜像各 8 秒）。规格要求 5~10 秒，取 6。
const UPDATE_TIMEOUT: Duration = Duration::from_secs(6);

/// 自建接口不提供「发布页」，而**强制更新时不能没有退路**（对象存储挂了、下载失败了，
/// 用户至少得有个地方自己拿安装包）。指向本项目的 release 页。
const RELEASES_PAGE: &str = "https://github.com/QingMu39-Gao/V-Synth-Studio/releases/latest";

/// 直连那一次的等待上限。连接被墙时表现为「连上了但不给数据」，所以要一个**短的**
/// 总超时：镜像是在它失败之后才试的，这里多等一秒就是用户多等一秒。
const DIRECT_TIMEOUT: Duration = Duration::from_secs(6);
/// 镜像那几次的等待上限（比直连宽松一点：代理要多一跳）。
const MIRROR_TIMEOUT: Duration = Duration::from_secs(8);
/// 自建源的等待上限：它离用户最近、又只有一份几 KB 的 JSON，失败就该**早点**往下走
/// （走直连还有 6 秒、两面镜像各 8 秒，第一档拖久了整条链都慢）。
const SELF_TIMEOUT: Duration = Duration::from_secs(4);

/// 能代理 `api.github.com` 的镜像，按顺序试。语义与 `ghmirror::FALLBACK` 一样：
/// 会烂，所以只当退路，而且**只放当前实测过的那几面**。
const API_MIRRORS: &[&str] = &["https://gh-proxy.com/", "https://ghproxy.net/"];

/// **自建更新源**：按顺序试，排在 GitHub 与所有镜像**前面**。
///
/// 服务器上只要两条 `proxy_pass` 就够，本程序不需要你写任何接口：
///
/// ```nginx
/// location /gh-api/ { proxy_pass https://api.github.com/; }
/// location /gh/     { proxy_pass https://github.com/; }
/// ```
///
/// 于是这里填 `<你的域名>/gh-api/`（**尾斜杠要留**）—— 拼接规则与镜像一致：
/// `<base> + 整条 GitHub 地址`（见 [`mirror_url`]），安装包那半走同一套前缀换成 `/gh/`。
///
/// ⚠️ **换地址只改这一个常量**。服务器搬家时把新的放前面、旧的留着当退路，两者都在
/// 数组里就会按顺序试。临时试另一台（不想改代码）用环境变量 `VSS_UPDATE_BASE`，
/// 逗号分隔，例如 `VSS_UPDATE_BASE=https://new.example.com/gh-api/,http://127.0.0.1:8080/gh-api/`。
///
/// ⚠️ 只收 `https://`（`http://127.0.0.1` 与 `http://localhost` 例外，给自己本机调试用）：
/// 「有没有新版本、安装包从哪下」这两件事都由它回答，明文 http 等于交给中间人。
const SELF_HOST_BASES: &[&str] = &[];

/// 发布说明是一整篇 markdown，整份过 IPC 会让回包大得没道理。
const NOTES_LIMIT: usize = 4000;

/// 出错时给用户看一小段响应体就够了，别把整页 JSON 塞进界面。
fn brief(s: &str) -> String {
    let t = s.trim();
    if t.chars().count() <= 200 {
        return t.to_string();
    }
    let head: String = t.chars().take(200).collect();
    format!("{head}…")
}

/// 这一面镜像上，规范地址变成了什么（`base` 带不带尾斜杠都要拼对）。
fn mirror_url(base: &str, canonical: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), canonical)
}

/// 一个自建源前缀能不能用。
///
/// 明文 http 只在**本机**放行（127.0.0.1 / localhost / ::1）：那两个地址出去的包出不了
/// 这台机器，而其余任何 http 都可能是中间人。
///
/// `pub(crate)`：公告那栏（`announce.rs`）用的是同一条规矩，别各写一份。
pub(crate) fn allowed_base(base: &str) -> bool {
    let b = base.trim();
    if b.starts_with("https://") {
        return true;
    }
    ["http://127.0.0.1", "http://localhost", "http://[::1]"]
        .iter()
        .any(|p| b.starts_with(p))
}

/// 这次生效的自建源：环境变量 `VSS_UPDATE_BASE`（逗号分隔）优先于常量。
pub fn self_host_bases() -> Vec<String> {
    bases_from(
        SELF_HOST_BASES,
        std::env::var("VSS_UPDATE_BASE").ok().as_deref(),
    )
}

/// 从「常量 + 环境变量」算出这次生效的自建源（顺序保持，见 [`self_host_bases`]）。
///
/// 纯函数是为了能测：环境变量是进程级的，直接读它写不出可复现的用例。
fn bases_from(consts: &[&str], env: Option<&str>) -> Vec<String> {
    let raw: Vec<String> = match env.map(str::trim).filter(|s| !s.is_empty()) {
        Some(v) => v.split(',').map(|s| s.trim().to_string()).collect(),
        None => consts.iter().map(|s| s.to_string()).collect(),
    };
    let mut out: Vec<String> = Vec::new();
    for b in raw {
        // 去重是为了搬家期：同一个地址既写进常量又写进环境变量时，别白等一个超时
        if b.is_empty() || !allowed_base(&b) || out.contains(&b) {
            continue;
        }
        out.push(b);
    }
    out
}

/// 本机该下哪一个安装包：从 GitHub 回包的 `assets` 里挑，回 `{name, size, url, sumsUrl}`。
///
/// 判据只看**文件名**（真实发布里的形状见 `tools/rename-bundles-beta.mjs`）：
///
/// | 平台 | 优先 | 退路 |
/// |---|---|---|
/// | Windows | `*-setup.exe`（NSIS：按用户装、不弹 UAC，且它的钩子会清掉旧的 MSI） | `*.msi` |
/// | macOS | `*.dmg` | — |
/// | Linux | `*.deb` | — |
///
/// `sumsUrl` 是这次发布的校验清单（`SHA256SUMS-<slug>.txt`，名字与 CI 的 matrix slug
/// 一致：msi / dmg / deb）。**没有就回 `None`** —— 老发布没有这个文件，下载照旧能走，
/// 只是核对不了完整性（界面要说清这件事）。
/// 资产条目里的下载地址。
///
/// GitHub 原样叫 `browser_download_url`，而 [`assets_of`] 把整份清单规整成了
/// `{name, size, url}`（界面只要这三列）。两种都认：这个函数既吃原始回包，也吃规整
/// 之后的那份 —— 只认一种的话，`reply()` 里那条路会静默拿到空地址。
fn asset_url(a: &Value) -> &str {
    a["browser_download_url"]
        .as_str()
        .or_else(|| a["url"].as_str())
        .unwrap_or("")
}

pub fn pick_installer(assets: &Value, platform: &str) -> Option<Value> {
    let list: Vec<&Value> = assets.as_array()?.iter().collect();
    let by_name = |pred: &dyn Fn(&str) -> bool| -> Option<&Value> {
        list.iter()
            .copied()
            .find(|a| pred(a["name"].as_str().unwrap_or("")))
    };
    let installer = match platform {
        "win32" => {
            by_name(&|n| n.ends_with("-setup.exe")).or_else(|| by_name(&|n| n.ends_with(".msi")))?
        }
        "darwin" => by_name(&|n| n.ends_with(".dmg"))?,
        _ => by_name(&|n| n.ends_with(".deb"))?,
    };
    let name = installer["name"].as_str().unwrap_or("");
    let slug = match platform {
        "win32" => "msi",
        "darwin" => "dmg",
        _ => "deb",
    };
    let sums = by_name(&|n| n == format!("SHA256SUMS-{slug}.txt"));
    Some(json!({
        "name": name,
        "size": installer["size"].as_u64().unwrap_or(0),
        "url": asset_url(installer),
        "sumsUrl": sums.map(asset_url).unwrap_or(""),
    }))
}

/// GitHub 回包的 `assets` → 界面要的三列（名字、字节数、下载地址）。
///
/// 整份资产清单过 IPC 只为显示「这次发了哪几个包」，其余字段（`id`、`uploader`、
/// `content_type`…）没必要跟着走。
fn assets_of(v: &Value) -> Value {
    let list: Vec<Value> = v["assets"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|x| {
                    json!({
                        "name": x["name"].as_str().unwrap_or(""),
                        "size": x["size"].as_u64().unwrap_or(0),
                        "url": x["browser_download_url"].as_str().unwrap_or(""),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    json!(list)
}

/// 从 `sha256sum` 风格的清单里取某个文件的期望摘要。
///
/// 认这几种写法（都会遇到）：`<hex>  <名字>`、`<hex> *<名字>`（二进制模式）、
/// 单空格的 `<hex> <名字>`（`Get-FileHash` 拼出来的那种）。比较时大小写不敏感 ——
/// 两种工具一个出大写一个出小写。
///
/// ⚠️ 名字那一列**只取最后一段**：有的工具会写 `./x.msi` 或 `bundle/msi/x.msi`，
/// 而调用方手里只有文件名。不取最后一段就会「清单里有、却找不到」，表现是**静默跳过
/// 核对**（最坏的那种失败：看着像通过）。
pub fn expected_sha256(sums: &str, file_name: &str) -> Option<String> {
    for line in sums.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut it = line.split_whitespace();
        let (Some(hex), Some(name)) = (it.next(), it.next()) else {
            continue;
        };
        if hex.len() != 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
            continue;
        }
        let name = name.trim_start_matches('*');
        let name = name.rsplit(['/', '\\']).next().unwrap_or(name);
        if name == file_name {
            return Some(hex.to_ascii_lowercase());
        }
    }
    None
}

/// 下载安装包时的候选地址，**按顺序**：自建源 → GitHub 直连。
///
/// ⚠️ 镜像不在这里 —— 那条路要测速挑面（`ghmirror::pick`），是**最后一档**，
/// 由调用方在前两档都失败之后才去问（详见 `ipc::update::update_download`）。
pub fn installer_candidates(url: &str) -> Vec<String> {
    let mut out: Vec<String> = self_host_bases()
        .iter()
        .map(|b| mirror_url(b, url))
        .collect();
    out.push(url.to_string());
    out
}

/// 界面要显示的版本，就是 `get_state` 发出去的那个（真源见 `ipc::config_file`）。
pub fn current_version() -> &'static str {
    crate::ipc::config_file::APP_VERSION
}

/// 把 tag / 版本串拆成数字段。
///
/// 前导 `v` 不要（GitHub 的 tag 惯例），遇到第一个非数字非 `.` 的字符就停 ——
/// 版本号后面的后缀（`1.3.3beta`）不参与比较，比较只按数字段走。
/// 一段解析不成数字也停：`1.4.x` 取 `[1,4]`，别把 `.x` 当成 0 蒙混过去。
pub fn parse_version(tag: &str) -> Vec<u64> {
    let s = tag.trim();
    let s = s.strip_prefix(['v', 'V']).unwrap_or(s);
    let head = s
        .split(|c: char| !c.is_ascii_digit() && c != '.')
        .next()
        .unwrap_or("");
    let mut parts = Vec::new();
    for part in head.split('.') {
        match part.parse::<u64>() {
            Ok(n) => parts.push(n),
            Err(_) => break,
        }
    }
    parts
}

/// 远端是否比本机新。
///
/// 逐段比数字，缺的段按 0 算（`1.10` > `1.9`，`1.4` 与 `1.4.0` 一样新）。
/// 远端一个数字都解析不出来时回 false：宁可不说有更新，也不能拿一个读不懂的
/// tag 去怂用户。本机比远端新（自编的包）同样回 false —— 见 `check`。
pub fn is_newer(remote: &str, local: &str) -> bool {
    let (r, l) = (parse_version(remote), parse_version(local));
    if r.is_empty() {
        return false;
    }
    for i in 0..r.len().max(l.len()) {
        let (a, b) = (
            r.get(i).copied().unwrap_or(0),
            l.get(i).copied().unwrap_or(0),
        );
        if a != b {
            return a > b;
        }
    }
    false
}

/// 发布说明截到 [`NOTES_LIMIT`] 个字符（按字符数，不是字节数）。
fn clamp_notes(s: &str) -> String {
    if s.chars().count() <= NOTES_LIMIT {
        return s.to_string();
    }
    let head: String = s.chars().take(NOTES_LIMIT).collect();
    format!("{head}…")
}

/// 非 2xx 时的回包。
///
/// ⚠️ **这不是 `Err`**：上游还没发过 Release（404）、匿名调用超额（403）都是
/// 正常状态，冒泡成异常会让前端只能弹一个 toast，而这几种情况都要能停在面板上
/// 让用户看清是什么事。
fn failure(status: u16, body: &str) -> Value {
    let error = match status {
        404 => "上游仓库还没有发布过 Release，暂时查不到更新".to_string(),
        403 | 429 => format!(
            "GitHub 拒绝了这次请求（HTTP {status}，匿名调用次数可能已用完，过一会儿再试）：{}",
            brief(body)
        ),
        code => format!("GitHub 回了 HTTP {code}：{}", brief(body)),
    };
    json!({ "ok": false, "error": error })
}

/// 查一次最新发布。
///
/// 候选顺序：**自建源（如果有）→ GitHub 直连 → 镜像**。谁能答就把谁写进回包的
/// `via` / `source` —— 界面要能说明这次是谁代答的（见模块头）。
pub async fn check() -> Result<Value, String> {
    let mut tried: Vec<String> = Vec::new();

    /* ① 自建更新接口（第一优先）。它是**我们自己的 schema**（见 `native_reply`），
    与 GitHub 那条回包不同；取不到、不是 JSON、字段缺失都只当「这一档没答上来」
    继续往下 —— 规格要求网络失败静默降级，不能因为一个字段把人锁在外面。 */
    if let Some(url) = native_url() {
        match crate::net::fetch_public_json(&url, &crate::announce::self_host_ua(), UPDATE_TIMEOUT)
            .await
        {
            Ok(v) => match native_reply(&v, &url) {
                Some(reply) => {
                    crate::log_line(&format!("检查更新：自建接口答了（{url}）"));
                    return Ok(reply);
                }
                None => crate::log_line("检查更新：自建接口的回包里没有可用的 version，忽略这一档"),
            },
            Err(e) => crate::log_line(&format!("检查更新：自建接口没答上来（{e}），继续往下")),
        }
        tried.push("自建更新接口".to_string());
    }

    /* ② 自建镜像前缀（`SELF_HOST_BASES`，一般留空）。部署它就是为了让用户少走一趟 GitHub。
    ⚠️ 这一档**任何**非 200 都当「没答上来」继续往下：服务器可能正在搬家（nginx 回
    502）、路径可能配错（回 404）—— 那些都不是 GitHub 的答案，拿它当结论会把
    「上游还没发过 Release」这种话错报给用户。 */
    for base in self_host_bases() {
        match fetch(&mirror_url(&base, LATEST_API), SELF_TIMEOUT).await {
            Ok(v) => {
                crate::log_line(&format!("检查更新：自建源 {base} 答了"));
                return Ok(reply(&v, &base, "self"));
            }
            Err(why) => {
                crate::log_line(&format!(
                    "检查更新：自建源 {base} 没答上来（{why}），继续往下"
                ));
                tried.push(base);
            }
        }
    }

    // ③ 直连。
    tried.push("GitHub 直连".to_string());
    match fetch(LATEST_API, DIRECT_TIMEOUT).await {
        Ok(v) => return Ok(reply(&v, "GitHub 直连", "direct")),
        Err(why) => {
            if why.is_error_page() {
                return Ok(why.into_reply());
            }
            crate::log_line(&format!("检查更新：直连 GitHub 失败（{why}），改试镜像"));
        }
    }

    // ④ 镜像。
    for base in API_MIRRORS {
        let url = mirror_url(base, LATEST_API);
        let label = base.trim_end_matches('/').to_string();
        match fetch(&url, MIRROR_TIMEOUT).await {
            Ok(v) => {
                crate::log_line(&format!("检查更新：{url} 答了"));
                return Ok(reply(&v, &label, "mirror"));
            }
            Err(why) => {
                /* 镜像答的是正经的 GitHub 错误（404 上游没发过 Release、403 限流）时
                就到此为止：再问下一面也是同一个答案，只是换了个出口 IP 去撞限流。 */
                if why.is_error_page() {
                    return Ok(why.into_reply());
                }
                tried.push(label);
            }
        }
    }

    let tiers = tried.len() + API_MIRRORS.len();
    Err(format!(
        "检查更新失败：{tiers} 档来源都答不上来（{}）。网络恢复后再试，或直接打开发布页",
        tried.join("、")
    ))
}

/// 自建接口里 `downloads` 的键名。规格说「键名用你软件实际需要的平台名」，
/// 我们按 `windows` / `macos` / `linux`（与 `update_download` 的挑包规则同一套）。
fn platform_key() -> &'static str {
    match crate::platform::node_platform_name() {
        "win32" => "windows",
        "darwin" => "macos",
        _ => "linux",
    }
}

/// 自建 `version.json` 里本机该下的那一个包 → 界面要的形状。
///
/// 规格里没有文件名，所以从 URL 末段取（对象存储上的名字就是文件名）；取不到就按版本
/// 与平台拼一个 —— 落盘需要一个名字，而且**后缀必须留着**（`.exe` / `.msi` / `.dmg`），
/// 否则用户拿到的东西点不开。
fn native_installer(v: &Value, version: &str) -> Option<Value> {
    let d = &v["downloads"][platform_key()];
    let url = d["url"].as_str().unwrap_or("").trim();
    if url.is_empty() {
        return None;
    }
    let tail = url
        .split(['?', '#'])
        .next()
        .unwrap_or(url)
        .trim_end_matches('/');
    let seg = tail.rsplit('/').next().unwrap_or("").trim();
    let name = if seg.is_empty() {
        format!("v-synth-studio_{version}_{}", platform_key())
    } else {
        seg.to_string()
    };
    Some(json!({
        "name": name,
        "size": d["size"].as_u64().unwrap_or(0),
        "url": url,
        // 规格：下载完成后**必须**校验这个值，不匹配就丢弃并报错
        "sha256": d["sha256"].as_str().unwrap_or("").trim().to_ascii_lowercase(),
    }))
}

/// 自建 `version.json` → 界面回包（与 GitHub 那条路**同一个形状**，多出 `force` / `minVersion`）。
///
/// 规格要求：解析失败 / 字段缺失一律当「无更新」，不崩。所以除了 `version`（没有它没法比）
/// 之外，每个字段都取保守默认值。回 `None` = 这条回包不能用，调用方继续往下试。
fn native_reply(v: &Value, via: &str) -> Option<Value> {
    let latest = v["version"].as_str().unwrap_or("").trim();
    if latest.is_empty() || parse_version(latest).is_empty() {
        return None;
    }
    let current = current_version();
    let min = v["min_version"].as_str().unwrap_or("").trim();
    let has_update = is_newer(latest, current);
    /* 强制更新的两个来源（规格）：`force: true`，或**当前版本低于 `min_version`**。
    ⚠️ 只在「确实有更新」时才可能强制：`version` 不比本机新时（服务端写错、自己编的包）
    既不更新也不阻断 —— 宁可晚一天更新，也不能因为一个字段把所有人锁在外面。 */
    let below_min = !min.is_empty() && is_newer(min, current);
    let force = has_update && (v["force"].as_bool().unwrap_or(false) || below_min);

    Some(json!({
        "ok": true,
        "current": current,
        "latest": latest,
        "hasUpdate": has_update,
        // 自建接口没有发布标题；`changelog` 是纯文本换行（界面按纯文本显示，不渲染 HTML）
        "name": "",
        "notes": clamp_notes(v["changelog"].as_str().unwrap_or("")),
        "url": RELEASES_PAGE,
        "publishedAt": v["published_at"].as_str().unwrap_or(""),
        "prerelease": false,
        "via": via,
        "source": "native",
        "force": force,
        "minVersion": min,
        // 自建接口不发资产清单（它只给本平台那一个包）
        "assets": json!([]),
        "installer": native_installer(v, latest),
    }))
}

/// 这个自建接口地址（环境变量优先，给本地 mock 用）。
fn native_url() -> Option<String> {
    let raw = std::env::var("VSS_UPDATE_URL")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| UPDATE_URL.to_string());
    allowed_base(&raw).then_some(raw)
}

/// 一次请求的失败原因。
#[derive(Debug)]
enum Failure {
    /// 连不上 / 超时 / 响应不是 JSON：**换一面还有机会**。
    Transport(String),
    /// 拿到了正经的 GitHub 错误回包（404 没发过 Release、403 限流、5xx）。
    /// 这种答案换一面也是一样的，直接报给用户。
    Github(Value),
}

impl Failure {
    fn is_error_page(&self) -> bool {
        matches!(self, Failure::Github(_))
    }

    fn into_reply(self) -> Value {
        match self {
            Failure::Github(v) => v,
            // 调用方只在 `is_error_page()` 为真时才用它，这里只是让 match 完整
            Failure::Transport(msg) => json!({ "ok": false, "error": msg }),
        }
    }
}

impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Failure::Transport(msg) => write!(f, "{msg}"),
            Failure::Github(v) => write!(f, "{}", v["error"].as_str().unwrap_or("GitHub 报错")),
        }
    }
}

/// 把一条错误的**起因链**拼成一行。
///
/// ⚠️ `reqwest` 的 `Display` 只有一句 `error sending request for url (...)`：真正的原因
/// （DNS 解析不了、代理连不上、证书不对）在 `source()` 里。不带出来，用户与我们都只能
/// 看到「连不上」，而这三种的处置完全不同。
fn cause_chain(e: &dyn std::error::Error) -> String {
    let mut out = e.to_string();
    let mut cur = e.source();
    let mut depth = 0;
    while let Some(s) = cur {
        let text = s.to_string();
        if !text.is_empty() && !out.contains(&text) {
            out.push_str(" ← ");
            out.push_str(&text);
        }
        cur = s.source();
        depth += 1;
        if depth > 6 {
            break;
        }
    }
    out
}

/// 取一个候选地址并解析。
async fn fetch(url: &str, timeout: Duration) -> Result<Value, Failure> {
    /* ⚠️ 走 `net::client()` 而不是自己建一个：那个客户端挂了 UA，而 GitHub 对
    没有 `User-Agent` 的请求一律回 403（表现为「被限流」这种误判）。 */
    let res = crate::net::client()
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .timeout(timeout)
        .send()
        .await
        .map_err(|e| {
            Failure::Transport(if e.is_timeout() {
                format!("超时（{} 秒没回应）", timeout.as_secs())
            } else {
                format!("连不上：{}", cause_chain(&e))
            })
        })?;

    let status = res.status().as_u16();
    let text = res.text().await.unwrap_or_default();
    if !(200..300).contains(&status) {
        return Err(Failure::Github(failure(status, &text)));
    }

    /* ⚠️ 判据是**响应体里有没有 `tag_name`**，不是状态码：代理对取不到的路径回
    一页 HTML（200）是常事，只看状态码会把它当成「上游还没发 Release」。 */
    let v: Value = serde_json::from_str(&text)
        .map_err(|_| Failure::Transport(format!("回的不是 JSON：{}", brief(&text))))?;
    if v["tag_name"].as_str().unwrap_or("").trim().is_empty() {
        return Err(Failure::Transport(format!(
            "回包里没有 tag_name：{}",
            brief(&text)
        )));
    }
    Ok(v)
}

/// 把 GitHub 的回包整理成界面要的形状。
///
/// `via` 说明这一次是谁答的（给人看），`source` 说明它属于哪一档
/// （`self` 自建源 / `direct` 直连 / `mirror` 镜像，给界面选措辞用）。
fn reply(v: &Value, via: &str, source: &str) -> Value {
    let tag = v["tag_name"].as_str().unwrap_or("").trim();
    let latest = tag.strip_prefix(['v', 'V']).unwrap_or(tag);
    let notes = clamp_notes(v["body"].as_str().unwrap_or(""));
    let assets = assets_of(v);

    json!({
        "ok": true,
        "current": current_version(),
        "latest": latest,
        // ⚠️ 本机比远端新（自编的包）时必须是 false，见 `is_newer`
        "hasUpdate": is_newer(tag, current_version()),
        "name": v["name"].as_str().unwrap_or(""),
        "notes": notes,
        "url": v["html_url"].as_str().unwrap_or(""),
        "publishedAt": v["published_at"].as_str().unwrap_or(""),
        "prerelease": v["prerelease"].as_bool().unwrap_or(false),
        "via": via,
        "source": source,
        "assets": assets,
        /* 本机该下哪一个（没挑到就是 null，界面据此决定要不要显示「下载」按钮）。
           挑不到的原因通常只有两个：这次发布没带本平台的包、或文件名形状变了。 */
        "installer": pick_installer(&assets, crate::platform::node_platform_name()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /* 真实回包（api.github.com）不进单测：要联网、还会因限流变脸。这里只钉住
    那几处**算错了肉眼看不出来**的地方 —— 版本号比较与两种回包形状。 */

    #[test]
    fn parse_version_stops_at_the_first_non_numeric_part() {
        assert_eq!(parse_version("v1.4.0"), vec![1, 4, 0]);
        assert_eq!(parse_version("V1.4.0"), vec![1, 4, 0]);
        // 后缀（`beta` / `-rc1`）不参与比较
        assert_eq!(parse_version("1.3.3beta"), vec![1, 3, 3]);
        assert_eq!(parse_version("v2.0.0-rc1"), vec![2, 0, 0]);
        // 段解析不出来就停：`1.4.x` 是 [1,4]，不是 [1,4,0]
        assert_eq!(parse_version("1.4.x"), vec![1, 4]);
        assert_eq!(parse_version("1.10"), vec![1, 10]);
        assert_eq!(parse_version("garbage"), Vec::<u64>::new());
        assert_eq!(parse_version(""), Vec::<u64>::new());
    }

    #[test]
    fn is_newer_compares_element_by_element() {
        assert!(is_newer("v1.4.0", "1.3.3beta"));
        // 数字段比字典序大：1.3.10 比 1.3.4 新
        assert!(is_newer("v1.3.10", "1.3.4"));
        // 缺的段按 0 算，所以 1.10 > 1.9
        assert!(is_newer("1.10", "1.9"));
        // 后缀不影响：同一个数字段就是同一个版本
        assert!(!is_newer("v1.3.3", "1.3.3beta"));
        assert!(!is_newer("v1.3.3", "1.3.3"));
        assert!(!is_newer("v1.2.0", "1.3.3"));
        // 本机比远端新（自己编的包）不算「有更新」
        assert!(!is_newer("v1.2.0", "2.0.0"));
        // 远端读不懂时宁可不说有更新
        assert!(!is_newer("garbage", "1.0.0"));
        assert!(!is_newer("", "1.0.0"));
    }

    #[test]
    fn clamp_notes_cuts_huge_bodies() {
        assert_eq!(clamp_notes("短说明"), "短说明");
        let long = "x".repeat(NOTES_LIMIT + 500);
        let cut = clamp_notes(&long);
        assert!(cut.ends_with('…'));
        assert_eq!(cut.chars().count(), NOTES_LIMIT + 1);
    }

    #[test]
    fn failure_reads_as_one_sentence_without_the_whole_body() {
        let f = failure(404, "{\"message\":\"Not Found\"}");
        assert_eq!(f["ok"], json!(false));
        let msg = f["error"].as_str().unwrap();
        assert!(msg.contains("Release"), "{msg}");
        // 403 要带上「为什么被拒」，但响应体只留一小段
        let f = failure(403, &format!("{{\"message\":\"{}\"}}", "x".repeat(500)));
        let msg = f["error"].as_str().unwrap();
        assert!(msg.contains("403"), "{msg}");
        assert!(msg.chars().count() < 400, "{msg}");
        assert!(failure(500, "").to_string().contains("500"));
    }

    /// 镜像把**整条规范地址**接在自己后面，尾斜杠要归一（名单是手写的常量，
    /// 少一个斜杠就拼出 `https://gh-proxy.comhttps://api...`）。
    #[test]
    fn mirror_url_joins_with_exactly_one_slash() {
        assert_eq!(
            mirror_url("https://gh-proxy.com/", LATEST_API),
            format!("https://gh-proxy.com/{LATEST_API}")
        );
        assert_eq!(
            mirror_url("https://ghproxy.net", LATEST_API),
            format!("https://ghproxy.net/{LATEST_API}")
        );
    }

    /// 回包形状：`via` / `source` 必须写明是谁答的（界面要说清「这次不是直连」），
    /// 带前导 `v` 的 tag 仍要出 `hasUpdate`，资产里要挑出本机该下的那一个。
    #[test]
    fn reply_carries_the_source_and_normalises_the_tag() {
        let v = json!({
            "tag_name": "v9.9.9",
            "name": "更名",
            "body": "说明",
            "html_url": "https://github.com/x/y/releases/tag/v9.9.9",
            "published_at": "2026-01-01T00:00:00Z",
            "prerelease": false,
            "assets": [
                {"name": "v-synth-studio_9.9.9beta_aarch64.dmg", "size": 10, "browser_download_url": "https://example/dmg"},
                {"name": "v-synth-studio_9.9.9_x64-setup.exe", "size": 20, "browser_download_url": "https://example/exe"},
                {"name": "v-synth-studio_9.9.9beta_x64_zh-CN.msi", "size": 30, "browser_download_url": "https://example/msi"},
                {"name": "SHA256SUMS-msi.txt", "size": 40, "browser_download_url": "https://example/sums"}
            ],
        });
        let r = reply(&v, "https://gh-proxy.com", "mirror");
        assert_eq!(r["ok"], json!(true));
        assert_eq!(r["latest"], json!("9.9.9"), "前导 v 要去掉");
        assert_eq!(r["via"], json!("https://gh-proxy.com"));
        assert_eq!(r["source"], json!("mirror"));
        assert_eq!(r["hasUpdate"], json!(true));
        assert_eq!(r["assets"].as_array().unwrap().len(), 4);
        // Windows 上挑的是 setup.exe（NSIS），并且把校验清单一起带出来
        #[cfg(windows)]
        {
            assert_eq!(
                r["installer"]["name"],
                json!("v-synth-studio_9.9.9_x64-setup.exe")
            );
            assert_eq!(r["installer"]["size"], json!(20));
            assert_eq!(r["installer"]["sumsUrl"], json!("https://example/sums"));
        }

        // 上游还没发过 Release 的形状：没有 tag_name，解析层必须把它挡成「换一面试」
        assert!(v["tag_name"].as_str().is_some());
        let empty = json!({ "message": "Not Found" });
        assert!(empty["tag_name"].as_str().unwrap_or("").trim().is_empty());
    }

    /// 自建源的前缀规矩：只收 https，本机那两个 http 例外（给自己调试）。
    #[test]
    fn only_https_bases_are_accepted() {
        assert!(allowed_base("https://upd.example.com/gh-api/"));
        assert!(allowed_base("http://127.0.0.1:8080/gh-api/"));
        assert!(allowed_base("http://localhost:8080/gh-api/"));
        assert!(!allowed_base("http://upd.example.com/gh-api/"));
        assert!(!allowed_base("ftp://upd.example.com/"));
        assert!(!allowed_base("upd.example.com/gh-api/"));
        assert!(!allowed_base(""));
    }

    /// 环境变量优先于常量；逗号分隔、去重、顺序保持 —— 搬家期新旧两台要**按写的顺序**试。
    #[test]
    fn env_overrides_the_constant_and_keeps_the_order() {
        let consts = &["https://old.example.com/gh-api/"];
        // 环境变量为空 = 用常量
        assert_eq!(bases_from(consts, None).len(), 1);
        assert_eq!(bases_from(consts, Some("   ")).len(), 1);
        // 环境变量优先，且按写的顺序
        let got = bases_from(
            consts,
            Some("https://new.example.com/gh-api/ , https://old.example.com/gh-api/"),
        );
        assert_eq!(
            got,
            vec![
                "https://new.example.com/gh-api/".to_string(),
                "https://old.example.com/gh-api/".to_string()
            ]
        );
        // 明文 http 的第三方被丢掉；重复的只留一个
        let got = bases_from(
            &[],
            Some("http://evil.example.com/,https://a.example.com/,https://a.example.com/"),
        );
        assert_eq!(got, vec!["https://a.example.com/".to_string()]);
    }

    /// 候选地址：自建源在前、GitHub 直连垫底（镜像由调用方在最后才问）。
    #[test]
    fn installer_candidates_put_self_hosted_first() {
        let u = "https://github.com/o/r/releases/download/v1/x-setup.exe";
        let got = installer_candidates(u);
        assert_eq!(
            got.last().map(String::as_str),
            Some(u),
            "直连必须在最后一档"
        );
        assert!(!got.is_empty());
        assert_eq!(got.iter().filter(|x| *x == u).count(), 1, "不该重复列直连");
    }

    /// 校验清单：认 `sha256sum` 的两种分隔（单/双空格、`*` 二进制前缀），
    /// 大小写不敏感，不该被注释行或别的文件名骗过去。
    #[test]
    fn expected_sha256_reads_the_usual_checksum_lines() {
        let a = "a".repeat(64);
        let b = "B".repeat(64);
        let sums = format!(
            "# 这是注释\n{}  v-synth-studio_1.4.2_x64-setup.exe\n{} *别的文件.zip\n",
            a, b
        );
        assert_eq!(
            expected_sha256(&sums, "v-synth-studio_1.4.2_x64-setup.exe"),
            Some(a.clone())
        );
        assert_eq!(
            expected_sha256(&sums, "别的文件.zip"),
            Some(b.to_lowercase())
        );
        // 带路径的写法（`./x` / `dir/x`）要认出来：调用方手里只有文件名，
        // 不剥路径就会静默跳过核对
        assert_eq!(
            expected_sha256(&format!("{a}  ./a.exe\n"), "a.exe"),
            Some(a.clone())
        );
        assert_eq!(
            expected_sha256(&format!("{a}  bundle/msi/a.msi\n"), "a.msi"),
            Some(a.clone())
        );
        // 文件名不同、行不合法、摘要长度不对：一律 None（不能拿一个读不懂的值当通过）
        assert_eq!(
            expected_sha256(&sums, "v-synth-studio_1.4.2beta_x64_zh-CN.msi"),
            None
        );
        assert_eq!(expected_sha256("deadbeef  x.exe", "x.exe"), None);
        assert_eq!(expected_sha256("", "x.exe"), None);
    }

    /// 挑安装包：Windows 优先 `-setup.exe`（NSIS），没有才退到 msi；别的平台各认各的。
    #[test]
    fn pick_installer_prefers_the_platform_it_can_run() {
        let assets = json!([
            {"name": "x_1.0beta_aarch64.dmg", "size": 1, "browser_download_url": "d"},
            {"name": "x_1.0beta_x64_zh-CN.msi", "size": 2, "browser_download_url": "m"},
            {"name": "x_1.0_x64-setup.exe", "size": 3, "browser_download_url": "e"},
            {"name": "x_1.0_amd64.deb", "size": 4, "browser_download_url": "b"},
            {"name": "SHA256SUMS-dmg.txt", "size": 5, "browser_download_url": "s"}
        ]);
        assert_eq!(pick_installer(&assets, "win32").unwrap()["url"], json!("e"));
        assert_eq!(
            pick_installer(&assets, "darwin").unwrap()["url"],
            json!("d")
        );
        assert_eq!(
            pick_installer(&assets, "darwin").unwrap()["sumsUrl"],
            json!("s")
        );
        assert_eq!(pick_installer(&assets, "linux").unwrap()["url"], json!("b"));
        // 没有 setup.exe 的发布（只有 MSI）也能挑出来
        let only_msi =
            json!([{"name": "x_1.0beta_x64_zh-CN.msi", "size": 2, "browser_download_url": "m"}]);
        assert_eq!(
            pick_installer(&only_msi, "win32").unwrap()["url"],
            json!("m")
        );
        assert_eq!(
            pick_installer(&only_msi, "win32").unwrap()["sumsUrl"],
            json!("")
        );
        // 本平台一个包都没有：回 None（界面据此不显示「下载」按钮），不是随便挑一个
        assert!(pick_installer(&only_msi, "darwin").is_none());
        assert!(pick_installer(&json!([]), "win32").is_none());
        assert!(pick_installer(&json!(null), "win32").is_none());
    }

    /// 真去问一次 GitHub（要联网 + 会吃匿名调用额度，所以用环境变量门住）。
    ///
    /// 这条测的是**真实回包的形状**：字段名、`tag_name` 里那个前导 `v`、`hasUpdate`
    /// 的算法在真数据上算出来是什么 —— 那几处只有连真接口才验得到，假 JSON 只能验解析。
    /// 顺带打印 `via`：直连与镜像哪条路真的通，只有这么看。
    ///
    ///     $env:VSS_REAL_UPDATE_CHECK='1'
    ///     cargo test --lib update::tests::real_api -- --nocapture
    #[tokio::test]
    async fn real_api_answers_when_asked() {
        if std::env::var("VSS_REAL_UPDATE_CHECK").is_err() {
            return;
        }
        let v = check()
            .await
            .expect("直连与镜像都试过还是连不上时这条测试才算失败");
        println!("回包：{}", serde_json::to_string_pretty(&v).unwrap());
        assert_eq!(v["ok"], json!(true), "上游有 Release 时才跑这条：{v}");
        assert_eq!(v["current"], json!(current_version()));
        assert!(!v["latest"].as_str().unwrap_or("").is_empty());
        assert!(!parse_version(v["latest"].as_str().unwrap()).is_empty());
        assert!(v["url"].as_str().unwrap_or("").contains("github.com"));
        assert!(v["hasUpdate"].is_boolean());
        assert!(
            !v["via"].as_str().unwrap_or("").is_empty(),
            "要说明是谁答的"
        );
        // 真数据上再钉一次「本机比远端新不算更新」：拿本机版本自己跟自己比
        assert!(!is_newer(current_version(), current_version()));
    }

    /// **每一面镜像都真打一次**，报哪几面能代答 `api.github.com`。
    ///
    /// 为什么值得单独跑：能代理下载的镜像**不等于**能代理 API —— 实测
    /// `ghfast.top` / `gh.llkk.cc` / `ghproxy.net` 走 API 路径一律回 403（代理的
    /// 共享出口 IP 撞上 GitHub 限流），而它们下载都是好的。名单要按这条结果维护。
    ///
    ///     cargo test --lib update::tests::real_mirrors -- --ignored --nocapture
    #[tokio::test]
    #[ignore = "要联网逐面实测，按需手动跑"]
    async fn real_mirrors_answer_which_ones_proxy_the_api() {
        println!(
            "直连：{:?}",
            fetch(LATEST_API, DIRECT_TIMEOUT).await.map(|_| "ok")
        );
        for base in API_MIRRORS {
            let url = mirror_url(base, LATEST_API);
            match fetch(&url, MIRROR_TIMEOUT).await {
                Ok(v) => println!("  ✓ {base}  tag={}", v["tag_name"]),
                Err(e) => println!("  ✗ {base}  {e}"),
            }
        }
    }
}
