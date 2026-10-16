//! 统一的下载引擎 —— **全仓只有这一份**「把 URL 变成盘上文件」的实现。
//!
//! 取字节有两种真实的模式：分块并行（bili 视频/音频，`Shape::Parallel`）与单流
//! 串行（`Plain` / `Resumable`）。大文件要并行、续传必须串行，这个差别是真的；
//! 落点、清理、记号、错误文案全共用。**同一件事两份实现就是修一处忘一处**：
//! 分块那条路上「用只读句柄做定位写」会每一块 EBADF 后静默退回单流。
//!
//! 边界：**不负责解压**（调用方自己去解，这里只保证「字节落齐在 `part` 上」）；
//! **不认识 svsep 的包**（落点、剥层、包里有什么都由调用方给）；**不管「请求」**
//! —— 要一小段数据回来用的走 `net::fetch_json` / `net::fetch_bytes` /
//! `lyrics::get_bytes`，**分界线是「这段字节最终要落成一个文件」**。
//!
//! ⚠️ 它还负责一件事：**GitHub 链接的镜像加速**（`ghmirror`）。`req.url` 一律是
//! **规范链接**，真正取字节的地址每轮现挑 —— 所以换镜像不会让 `.part.url` 记号
//! 失配、也就不会丢掉几个 GB 的续传点。非 GitHub 链接原样返回、一个请求都不多发。
//!
//! ⚠️ 查「还有没有漏掉的调用方」别按函数名或 `bytes_stream` 找：
//! `ipc::media::preview_fetch` 用的是 `res.chunk()`、`lyrics::save_stream` 短得
//! 不像下载器。按**行为**找：任何「读 HTTP 响应 → 写进文件」的循环。
//!
//! 现有 6 个调用方：`net::download_to_file`（bili，`Parallel`+`BILI`）、
//! `svsep::fetch_bundle`（几 GB，`Resumable`+`BIG_PACK`）、`svsep::fetch_to_file`、
//! `lyrics::save_stream`、`ipc::media::preview_fetch`
//! —— 后面三个都是 `Plain` + `NONE`，区别只在落点与 client。

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use futures_util::StreamExt;
use reqwest::header::{HeaderMap, HeaderName, HeaderValue};

/// 默认 HTTP 客户端。绝大多数调用方用它（带默认 UA、跟随重定向）。
pub fn default_client() -> &'static reqwest::Client {
    crate::net::client()
}

/// `reqwest` 的英文错误对用户没意义（`error decoding response body` 之类），
/// 换成能看懂的话。
///
/// ⚠️ 所有下载共用这一份文案：分成两份的话「下模型时报 `error decoding response
/// body`、下歌曲时报『下载中断了』」—— 同一件事两种说法。
pub fn friendly(e: &reqwest::Error) -> String {
    if e.is_timeout() {
        "下载超时（网络太慢或连接被中断，再试一次）".to_string()
    } else if e.is_body() || e.is_decode() {
        "下载中断了（网络不稳定，再试一次通常就好）".to_string()
    } else {
        format!("网络请求失败：{e}")
    }
}

/// 「下载模型」/「下载」—— 出错信息开头那两个字。
fn what(label: &str) -> String {
    if label.is_empty() {
        "下载".to_string()
    } else {
        format!("下载{label}")
    }
}

/// 小于这个不值得分块（和原 Node 版一致）。
const CHUNK_MIN_SIZE: u64 = 2 * 1024 * 1024;

/// 引擎内部用的哨兵：表示「用户让它停下来」，不是真失败。
/// 不外泄 —— 对外是 [`Outcome`]。
const STOPPED: &str = "__stopped__";

/// 分块专用哨兵：服务端对 `Range` 回了 200（整份），再重试也是同样结果，
/// 调用方拿到它应当直接退回单流而不是把五次重试烧完。
const CHUNK_UNSUPPORTED: &str = "服务端忽略了 Range 请求，不能分块下载";

/// 进度回调报的是**哪一段**：还在下，还是（调用方的）解压阶段。
///
/// 为什么非有这个区分不可：下载与解压共用同一个 `on_progress` 通道，而解压的
/// 分母（所有条目压缩后大小之和）跟 zip 的字节数几乎一样大。不区分的话界面上
/// 就是「条子冲到 100% → 归零 → 在同一个『正在下载…』标签下再爬一遍」—— 看着
/// 像下完又自动重下了一遍（实际在解压）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Stage {
    /// 正在从网上拿字节
    Download,
    /// 整包已经在盘上，正在解压
    Extract,
}

/// 「该停了吗」与「停下来算哪一种」。
///
/// 分成两个谓词是因为 bili 那边**没有暂停这个概念**（只有取消），而 svsep 有；
/// 合成一个就必然让一边撒谎。
///
/// ⚠️ 两个都是**有主的** `Box<dyn Fn>`，不是借用 —— 借用会让「从 `&DownloadCtl`
/// 造一个 Control」这种最自然的用法没法写在辅助函数里（闭包是那个函数的局部量，
/// 不能把引用返回出去），结果就得在每个调用点抄两行、或者 `Box::leak` 漏内存。
/// 有主之后 `Control<'_>` 仍能借用调用方的东西，只是自己负责持有那两个闭包。
pub struct Control<'a> {
    /// 该停下来了吗 —— **暂停或停止都算**。
    pub check: Box<dyn Fn() -> bool + Send + Sync + 'a>,
    /// 停下来之后算「取消」（删掉续传点）还是「暂停」（留着）。
    pub is_cancel: Box<dyn Fn() -> bool + Send + Sync + 'a>,
}

impl<'a> Control<'a> {
    pub fn new(
        check: impl Fn() -> bool + Send + Sync + 'a,
        is_cancel: impl Fn() -> bool + Send + Sync + 'a,
    ) -> Self {
        Self {
            check: Box::new(check),
            is_cancel: Box::new(is_cancel),
        }
    }

    /// 「只有取消、没有暂停」那种调用方（bili 用）：停下来永远是取消，
    /// 永远不留续传点。
    pub fn cancel_only(check: impl Fn() -> bool + Send + Sync + 'a) -> Self {
        Self::new(check, || true)
    }
}

/// 一次下载的**形状**：怎么取字节、断了之后怎么收场。
///
/// ## 为什么是一个枚举而不是三个 bool/usize
///
/// `threads` / `probe` / `resume` 这三个属性是**关联**的，拆成独立字段就能配出
/// 没有意义的组合：
///
/// * `threads = 4, probe = false` —— 分块要先知道总长才能切，少了 probe 就只能
///   **静默退回单流**（不报错）。界面上「线程数」填了 4、实际单流，用户看到的
///   是「设了没用」（见 `download_range_once` 的注释）。
/// * `threads = 4, resume = true` —— 引擎里 `chunked` 的条件带着 `start == 0`，
///   于是续传时**永远**不会分块。配了也不报错，只是不生效。
///
/// 枚举让这些组合**根本写不出来**，也就不会有人再配错。三态对应 6 个调用方：
/// bili 视频/音频用 `Parallel`（线程数用户可配 1..=16）、svsep 的模型与运行时
/// （几 GB）用 `Resumable`、其余 4 处用 `Plain`。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Shape {
    /// **普通**：单流、不续传、断了从头。
    ///
    /// 给「几十~几百 MB、重试代价可接受」的包：bili 之外的 4 个调用方。
    /// ⚠️ 用它时 `part` 里若有旧字节会被**先删掉**（留着而从头写会拼出坏文件）。
    Plain,
    /// **可续传**：单流 + 维护 `.part.url` 记号 + 断了从盘上接着下。
    ///
    /// 给「几 GB、重下一次很痛」的包（svsep 的模型与运行时）。
    ///
    /// ⚠️ **不用分块**：分块要先把文件撑到最终大小再各写各的偏移，而续传的起点
    /// 在文件中间，两者放一起得为每块单独算「还缺哪一段」，复杂度和出错面都不值。
    /// 单流续传是几十年验证过的做法（`Range: bytes=N-`）。
    Resumable,
    /// **并行分块**：先 `probe` 出总长，再按 `threads` 切段并行写各自的偏移。
    ///
    /// 给「同一个大文件、服务端支持 Range、想要快」的场合（bili 的视频）。
    /// 不续传：分块与续传互斥（见 [`Shape::Resumable`]），一次不顺就退回单流。
    Parallel { threads: usize },
}

impl Shape {
    /// 分块并行要几个线程（非分块恒 1）。
    fn threads(self) -> usize {
        match self {
            Shape::Parallel { threads } => threads.max(1),
            _ => 1,
        }
    }

    /// 要不要先发 `bytes=0-0` 探总长。
    ///
    /// ⚠️ **它是从 `Shape` 推出来的，不是调用方填的** —— 这正是把三态收成枚举
    /// 的主要收益：分块必然要 probe，非分块必然不要（`svsep` 的测试在数请求
    /// 次数，平白多一个 probe 会破坏那种「到底发了几次」的判据）。
    fn probe(self) -> bool {
        matches!(self, Shape::Parallel { .. })
    }

    /// 盘上的旧 `.part` 认不认、断了接不接着下。
    fn resumable(self) -> bool {
        matches!(self, Shape::Resumable)
    }
}

/// 重试策略。
///
/// 为什么是参数而不是常量：两个调用方的包差三个数量级 —— bili 的视频几十 MB
/// （抖动一两轮就过去，等 10 秒反而难受），svsep 的运行时 4.7 GB（多等一会儿
/// 换「几个 GB 不白下」非常划算）。
#[derive(Clone, Copy)]
pub struct Retry {
    /// 一轮失败之后最多再来几轮（`0` = 失败即放弃，交给外层决定）
    pub rounds: u32,
    /// 两轮之间歇多久
    pub wait: Duration,
}

impl Retry {
    /// 不重试：失败立刻返回，由调用方处理（换源 / 换链接 / 报错给用户）。
    pub const NONE: Retry = Retry {
        rounds: 0,
        wait: Duration::ZERO,
    };

    /// bili 的媒体下载：几十 MB 的抖动，短等快试。
    pub const BILI: Retry = Retry {
        rounds: 4,
        wait: Duration::from_millis(800),
    };

    /// svsep 的几 GB 大包：多等一会儿换「不白下几 GB」。
    pub const BIG_PACK: Retry = Retry {
        rounds: 5,
        wait: Duration::from_secs(10),
    };
}

/// 一次下载要什么。
#[derive(Clone)]
pub struct Request<'a> {
    /// **规范链接**（那个文件在官方站上的地址）。真正取字节的地址由 `ghmirror`
    /// 现挑（只有 GitHub 链接会换），而 `.part.url` 记号记的是这里这个 ——
    /// 记号跟着镜像走的话，换一面镜像就等于把几个 GB 的续传点作废。
    pub url: &'a str,
    /// 出错时怎么称呼它（「模型」「运行时」…）。空串 = 不点名。
    pub label: &'a str,
    /// 字节写进**这个文件**（不是最终文件名 —— 由调用方决定何时 rename）。
    ///
    /// ⚠️ 调用方给的多半是 `xxx.part`。引擎**不会**替你改名：svsep 要拿它去
    /// 解压然后自己删，bili 要 rename 成成品。那是两种不同的收尾。
    pub part: &'a Path,
    pub headers: &'a [(&'a str, &'a str)],
    /// 怎么取字节、断了怎么收场。见 [`Shape`]。
    ///
    /// ⚠️ 拆成三个独立字段（`threads` / `probe` / `resume`）就能配出
    /// 「设了线程数却不分块」这种没有意义的组合。收成一个枚举之后写不出来了。
    pub shape: Shape,
    /// 用哪个 HTTP 客户端。
    ///
    /// 多数调用方该用 [`default_client`]。例外是歌词那一路：它要走**用户配的
    /// 代理**，那是 client 级别的设置，只能靠传一个不一样的 client 进来。
    pub client: &'a reqwest::Client,
    pub retry: Retry,
    /// 下完之后要求盘上正好是这么多字节，否则**这一轮算失败**（删掉重下）。
    ///
    /// 给「知道官方大小」的包用（`fetch_to_file`：GitHub release 偶尔回一个
    /// 截断的响应 —— 连接好好地结束了、`Content-Length` 也对，但字节数不够）。
    /// 不核对就会把一个半截文件当好文件交给调用方，而那种文件往往要到解压或
    /// 运行时才炸。
    ///
    /// 对不上时报错会带上「拿到多少、期望多少」，别写成光秃秃一句「下载失败」。
    pub expect: Option<u64>,
}

/// 收场。**失败不在里面** —— 失败是 `Err`。
#[derive(Debug, PartialEq, Eq)]
pub enum Outcome {
    /// 字节落齐了
    Done { bytes: u64 },
    /// 用户按了暂停：`part` 留着，下次带着 `Range` 接着下
    Paused { bytes: u64 },
    /// 用户按了停止
    Cancelled,
}

/// 进度回调：`(已下字节, 总长（未知则 None）, 阶段)`。
pub type Note<'a> = &'a (dyn Fn(u64, Option<u64>, Stage) + Send + Sync);

/* ══════════════════════════ 续传点（半个包）══════════════════════════ */

/// `.part` 旁边那个小文件里记着「这半个包是谁的」。见 [`stored_resume`]。
pub fn url_marker(part: &Path) -> PathBuf {
    let mut s = part.as_os_str().to_os_string();
    s.push(".url");
    PathBuf::from(s)
}

/// 把这个包的链接记在 `.part` 旁边。
pub fn write_url_marker(part: &Path, url: &str) -> std::io::Result<()> {
    std::fs::write(url_marker(part), url)
}

/// 盘上那半个包**是不是这个链接**的。
///
/// 为什么要记：`.part` 只有字节，没有出处。用户换了下载服务器（或者我们在安装版
/// 里换了个地址）之后，拿旧的半个包去接新链接的 `Range`，拼出来的是「旧包的前半段
/// ＋ 新包的后半段」—— 一个要到解压才炸的坏 zip，而且看着像我们的解析器有问题。
/// 链接对不上就当没有，从头下。
///
/// ⚠️ **记号缺失**（`.part` 没有配套记号、或者写记号那一下失败了）算「可以续」，
/// 不算「换了链接」：盘上有几个 GB 而记号只是个几十字节的附属品，为了它丢掉几个
/// GB 是坏交易。反过来，**记号在且写着别的链接**就必须当真 —— 那才是这个函数
/// 存在的理由。两种情况的区别是「`read_to_string` 失败」还是「读出来不等于 url」。
pub fn stored_resume(part: &Path, url: &str) -> bool {
    if !part.is_file() {
        return false;
    }
    match std::fs::read_to_string(url_marker(part)) {
        Ok(s) => s.trim() == url,
        // 没有记号文件（或读不出来）：按能续处理，第一次发 Range 之前会把记号补上
        Err(_) => true,
    }
}

/// 文件大小，读不到算 0。
pub fn file_size(p: &Path) -> u64 {
    std::fs::metadata(p).map(|m| m.len()).unwrap_or(0)
}

/* ══════════════════════════════ 引擎 ══════════════════════════════ */

/// 把 `req.url` 下到 `req.part`。**全仓唯一的下载实现。**
///
/// 返回的 [`Outcome`] 说清是下完了、暂停了还是取消了；真失败是 `Err`。
pub async fn download(
    req: &Request<'_>,
    ctl: &Control<'_>,
    note: Note<'_>,
) -> Result<Outcome, String> {
    if !req.url.starts_with("https://") && !req.url.starts_with("http://") {
        return Err(format!("下载地址必须是 http(s) 链接：{}", req.url));
    }
    if let Some(parent) = req.part.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("建目录失败：{e}"))?;
    }

    /* ── 续传点：从哪接着写 ────────────────────────────────────────────
     *
     * ⚠️ **不看内存里的计数，只看盘。** 工作站在下载中途被关掉、或者进程重启
     * 之后，内存里那点记忆就没了，而 4.7 GB 的半个包还在盘上 —— 只看内存会让
     * 「继续下载」从头开始，白烧用户几个 GB 的流量。
     *
     * ⚠️ 不允许续传时必须先把旧 `part` 删掉：留着它而从头写，会拼出「旧包前半段
     * + 新包整段」的坏文件（`.part` 是要拿去解压的，那时才炸）。 */
    let resumable = req.shape.resumable();
    let mut start: u64 = 0;
    if resumable {
        if stored_resume(req.part, req.url) {
            start = file_size(req.part);
        }
    } else if req.part.exists() {
        let _ = std::fs::remove_file(req.part);
    }
    // 记号写在发请求**之前**，而且**从头下时也要写**：万一进程在这儿被掐掉，
    // 下次才知道这半个包属于哪条链接。缺记号的 `.part` 会被当成「谁的都行」。
    if resumable {
        let _ = write_url_marker(req.part, req.url);
    }

    /* 真正从哪儿取字节 —— 镜像加速（`ghmirror`）。`req.url` 始终是**规范链接**，
    `.part.url` 记号记的也是它，所以换镜像不会让几个 GB 的续传点作废。
    非 GitHub 链接原样返回，一个额外的请求都不发。 */
    let mut fetch = crate::ghmirror::pick(req.url).await;

    // ── 总长与分段能力 ──
    let header_map = header_map(req.headers);
    let mut total: Option<u64> = None;
    let mut accept_ranges = false;
    if req.shape.probe() {
        let (size, ranges) = probe(&fetch, &header_map, req.client).await?;
        total = (size > 0).then_some(size);
        accept_ranges = ranges;
    }

    /* 分块只在「从头下、够大、够多线程、且服务端认 Range」时才用。
    ⚠️ 续传中不用分块：分块要先把文件撑到最终大小再各写各的偏移，而续传的
    起点在文件中间，两者放一起就要为每个块单独算「还缺哪一段」，复杂度和
    出错面都不值。单流续传是几十年验证过的做法。 */
    let chunked = accept_ranges
        && start == 0
        && req.shape.threads() > 1
        && total.is_some_and(|t| t > CHUNK_MIN_SIZE);

    let mut rounds: u32 = 0;
    // 循环里每一轮失败都会覆盖它；初值只是给「一轮都没跑成」兜底
    #[allow(unused_assignments)]
    let mut last = String::from("未知原因");
    loop {
        rounds += 1;
        if (ctl.check)() {
            return Ok(settle(ctl, req, start));
        }
        if rounds > 1 {
            /* 上一轮失败了 → 换一面镜像再来。规范链接没变，所以盘上的续传点还算数
            （`.part.url` 记的是它，不是镜像地址）。
            ⚠️ **只在失败之后换**：排名是开工前实测出来的，每轮都重测等于把吞吐
            反复押在刚测出来的那条线路上，而换个镜像并不需要重测（`ghmirror`
            记着整张名次表）。 */
            crate::ghmirror::discard(req.url);
            fetch = crate::ghmirror::pick(req.url).await;
        }

        let attempt = if chunked {
            let t = total.unwrap_or(0);
            let tracker = Tracker::new(total, note);
            match download_chunked(&fetch, req, &header_map, t, &tracker, ctl).await {
                Ok(()) => Ok(tracker.received()),
                // 用户让它停 → 不要退化成单流再跑一遍
                Err(e) if e == STOPPED => Err(e),
                /* ⚠️ 分块失败就退回单流（原样保留的行为）。
                注意这里**不能**把 `part` 删掉：分块已经写了那么多，单流从头
                覆盖同一个文件是安全的（`File::create` 会截断），删了反而多一次
                系统调用。 */
                Err(chunk_err) => {
                    /* ⚠️ 退回单流**不保证**能成（服务端可能连单流都拒）。
                    两边的错都留着：单流失败时把「分块为什么没成」也带上，
                    否则用户只看到最后那一句，排查时看不出真正的起因。 */
                    note(0, total, Stage::Download);
                    match download_stream(&fetch, req, &header_map, 0, &mut total, &tracker, ctl)
                        .await
                    {
                        Ok(()) => Ok(tracker.received()),
                        Err(stream_err) if stream_err == STOPPED => Err(stream_err),
                        Err(stream_err) => Err(format!("（分块先失败：{chunk_err}）{stream_err}")),
                    }
                }
            }
        } else {
            let tracker = Tracker::new(total, note);
            match download_stream(&fetch, req, &header_map, start, &mut total, &tracker, ctl).await
            {
                Ok(()) => Ok(tracker.received()),
                Err(e) => Err(e),
            }
        };

        // 下完之后核对字节数（`expect`）—— 对不上当成这一轮失败
        let attempt = match attempt {
            Ok(bytes) => match req.expect {
                Some(want) if bytes != want => {
                    Err(format!("下到的文件是 {bytes} 字节，应是 {want} 字节"))
                }
                _ => Ok(bytes),
            },
            Err(e) => Err(e),
        };

        match attempt {
            Ok(bytes) => return Ok(Outcome::Done { bytes }),
            Err(e) if e == STOPPED => return Ok(settle(ctl, req, file_size(req.part))),
            Err(e) => {
                last = e;
                if rounds > req.retry.rounds {
                    return Err(give_up(req, resumable, &last));
                }
                note(file_size(req.part), total, Stage::Download);
                // ⚠️ 等的时候也要能立刻响应暂停/停止，所以切小段轮着看谓词
                if !wait_before_retry(ctl, req.retry.wait).await {
                    return Ok(settle(ctl, req, file_size(req.part)));
                }
                /* 「断在哪儿就从哪儿接着下」—— 这一轮真落进盘的那些字节算数。
                ⚠️ 只在 `Resumable` 时这么干：`Plain` 每一轮都从头（那段字节
                与这一轮要下的是两个东西，拿它当起点会拼出一个错文件）。 */
                if resumable {
                    start = file_size(req.part);
                }
            }
        }
    }
}

/// 彻底放弃时的收场：把错误**装配好**，并按 `Shape` 决定盘上留不留。
///
/// ## 为什么「删不删」由 `Shape` 定，而不是留给调用方
///
/// 这个差别**不是选择**，所以不能让每个调用方各自记得：
///
/// * `Resumable` 的半截文件是**下次的起点**，删了就等于白下几个 GB，必须留；
/// * `Plain` 的半截文件**没有任何东西会去认领**（没有记号、没有断点查询），
///   留着只会在用户眼前摆一个「看着像下好了、其实播不动」的文件。
///   `lyrics` 那条路径的落点是**用户的音乐目录**（`<输出目录>/<歌名>.mp3`），
///   留一个半截的 mp3 尤其糟。
///
/// `Plain` 下这里顺手把半截文件删掉（连带记号，虽然它本来也不该有）。
fn give_up(req: &Request<'_>, resumable: bool, last: &str) -> String {
    if resumable {
        format!(
            "{last}（试了 {} 轮、每轮隔 {} 秒。已下的 {} 字节留在盘上，             下次点「继续下载」从这儿接着下）",
            req.retry.rounds,
            req.retry.wait.as_secs(),
            file_size(req.part)
        )
    } else {
        let had = file_size(req.part);
        let _ = std::fs::remove_file(req.part);
        let _ = std::fs::remove_file(url_marker(req.part));
        let tail = if had > 0 {
            format!("（已下到一半的 {had} 字节已清掉，不会留下一个播不动的文件）")
        } else {
            String::new()
        };
        format!(
            "{last}（试了 {} 轮、每轮隔 {} 秒）{tail}",
            req.retry.rounds,
            req.retry.wait.as_secs()
        )
    }
}

/// 收场：暂停还是停止，以及要不要把半个包删掉。
///
/// ⚠️ 删除**只在允许续传时**做。不允许续传的调用方（bili）的 `part` 由它自己管，
/// 这里不碰 —— 顺手「清理」会是一次没人要求的行为变更。
fn settle(ctl: &Control<'_>, req: &Request<'_>, bytes: u64) -> Outcome {
    if (ctl.is_cancel)() {
        if req.shape.resumable() {
            let _ = std::fs::remove_file(req.part);
            let _ = std::fs::remove_file(url_marker(req.part));
        }
        Outcome::Cancelled
    } else {
        Outcome::Paused { bytes }
    }
}

/// 重试之前歇一会儿。返回 `true` = 歇够了可以再试；`false` = 期间用户按了暂停/停止。
///
/// ⚠️ **别写成一句 `sleep(wait)`**：用户按暂停要立刻见效，所以切成小段轮着看谓词。
async fn wait_before_retry(ctl: &Control<'_>, wait: Duration) -> bool {
    // 至少切一段，免得 wait 比 200ms 还短时一次都不检查
    let slices = (wait.as_millis() / 200).max(1);
    for _ in 0..slices {
        tokio::time::sleep(Duration::from_millis(200).min(wait)).await;
        if (ctl.check)() {
            return false;
        }
    }
    true
}

fn header_map(pairs: &[(&str, &str)]) -> HeaderMap {
    let mut h = HeaderMap::new();
    for (k, v) in pairs {
        if let (Ok(name), Ok(val)) = (
            HeaderName::from_bytes(k.as_bytes()),
            HeaderValue::from_str(v),
        ) {
            h.insert(name, val);
        }
    }
    h
}

/* ══════════════════════════ 单流 ══════════════════════════ */

/// 单流下：从 `start` 起顺序追加。`total` 会被响应头补全（如果还不知道）。
async fn download_stream(
    fetch: &str,
    req: &Request<'_>,
    hdrs: &HeaderMap,
    start: u64,
    total: &mut Option<u64>,
    tracker: &Tracker<'_>,
    ctl: &Control<'_>,
) -> Result<(), String> {
    let mut h = hdrs.clone();
    if start > 0 {
        h.insert(
            reqwest::header::RANGE,
            HeaderValue::from_str(&format!("bytes={start}-")).map_err(|e| e.to_string())?,
        );
    }
    let res = req
        .client
        .get(fetch)
        .headers(h)
        .send()
        .await
        .map_err(|e| format!("{}失败：{}", what(req.label), friendly(&e)))?;
    let status = res.status().as_u16();
    /* 416 = 服务端说「这个区间不存在」：`start` 已经不小于整个文件了，也就是盘上
    那一份**已经下全**（续传时对着一整卷再要一次就是这个症状）。分卷下载全靠
    这一条：卷是按顺序下的，中间停一次之后前面那几卷都是一整份。
    ⚠️ 只有 `Resumable` 能这么读 —— 它写的是「同一条链接的追加流」，`start`
    就是盘上已有的字节数；`Plain` 不续传，416 只能是真的出错。 */
    if status == 416 && start > 0 && req.shape.resumable() {
        tracker.reset(start);
        tracker.tick(start, *total);
        return Ok(());
    }
    if !(200..300).contains(&status) {
        /* ⚠️ 带上真正用的那个地址：走镜像时一句「HTTP 404」分不出是这一面镜像挂了、
        还是发布点上真没这个文件 —— 而这两件事的处置完全不同。 */
        return Err(format!("{}失败：HTTP {status}（{fetch}）", what(req.label)));
    }
    // 206 = 服务端认了 Range；200 = 不认，要从头写
    let resumed = status == 206 && start > 0;
    let written = if resumed { start } else { 0 };
    // 206 时 Content-Length 是「还剩多少」，总长要把已有的加上
    if let Some(len) = res.content_length() {
        *total = Some(len + written);
    }

    let mut file = if resumed {
        std::fs::OpenOptions::new()
            .append(true)
            .open(req.part)
            .map_err(|e| format!("打开临时文件失败：{e}"))?
    } else {
        /* ⚠️ `create` 会把已有的半个包**截断** —— 服务端不认 Range 时这是对的：
        追加会拼出「旧包前半段 + 新包后半段」的坏文件，要到解压才炸。 */
        std::fs::File::create(req.part).map_err(|e| format!("写临时文件失败：{e}"))?
    };
    tracker.reset(written);
    tracker.tick(written, *total);
    use std::io::Write;
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| format!("下载中断：{e}"))?;
        file.write_all(&chunk)
            .map_err(|e| format!("写文件失败（磁盘满了？）：{e}"))?;
        tracker.add(chunk.len() as u64);
        // ⚠️ 这个判断要放在写盘之后、下一块之前：放到外面会让一次暂停多下几 MB
        if (ctl.check)() {
            let _ = file.flush();
            drop(file);
            return Err(STOPPED.to_string());
        }
    }
    let _ = file.flush();
    Ok(())
}

/* ══════════════════════════ 分块 ══════════════════════════ */

/// 按 `threads` 切段并行下，各写各的偏移。
async fn download_chunked(
    fetch: &str,
    req: &Request<'_>,
    hdrs: &HeaderMap,
    total: u64,
    tracker: &Tracker<'_>,
    ctl: &Control<'_>,
) -> Result<(), String> {
    if total == 0 {
        return Err("分块下载需要知道总长".into());
    }
    let chunk_size = total.div_ceil(req.shape.threads() as u64).max(1);

    // 先把文件撑到最终大小，各分块写各自的偏移
    {
        let f = std::fs::File::create(req.part).map_err(|e| e.to_string())?;
        f.set_len(total).map_err(|e| e.to_string())?;
    }

    let ranges: Vec<(u64, u64)> = (0..total)
        .step_by(chunk_size as usize)
        .map(|s| (s, (s + chunk_size - 1).min(total - 1)))
        .collect();

    // join_all 而不是 spawn：这些 future 互不依赖，并发跑在同一条任务上就够了，
    // 也就不需要把回调塞进 'static。
    let futs = ranges
        .into_iter()
        .map(|(s, e)| download_range(fetch, req, hdrs, s, e, tracker, ctl));
    for r in futures_util::future::join_all(futs).await {
        r?;
    }
    Ok(())
}

async fn download_range(
    fetch: &str,
    req: &Request<'_>,
    hdrs: &HeaderMap,
    start: u64,
    end: u64,
    tracker: &Tracker<'_>,
    ctl: &Control<'_>,
) -> Result<(), String> {
    let mut last = String::new();
    // 每一轮往 tracker 里记了多少：重试要先把上一轮扣掉，
    // 否则同一个窗口数两遍，进度会先到 100% 而文件还没下全。
    let mut counted: u64 = 0;
    for attempt in 0..=4u32 {
        if (ctl.check)() {
            return Err(STOPPED.to_string());
        }
        match download_range_once(fetch, req, hdrs, start..=end, tracker, ctl, &mut counted).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                /* 服务端不肯按 Range 给：再试四次也是同样结果，直接放出去
                让外层退回单流。用户按了停止同理 —— 停就停，别再睡一轮。 */
                if e.starts_with(CHUNK_UNSUPPORTED) || e == STOPPED {
                    return Err(e);
                }
                tracker.sub(counted);
                counted = 0;
                last = e;
                if attempt < 4 {
                    tokio::time::sleep(Duration::from_millis(500 * (attempt as u64 + 1))).await;
                }
            }
        }
    }
    Err(last)
}

async fn download_range_once(
    fetch: &str,
    req: &Request<'_>,
    hdrs: &HeaderMap,
    window: std::ops::RangeInclusive<u64>,
    tracker: &Tracker<'_>,
    ctl: &Control<'_>,
    counted: &mut u64,
) -> Result<(), String> {
    let (start, end) = (*window.start(), *window.end());
    let mut h = hdrs.clone();
    h.insert(
        reqwest::header::RANGE,
        HeaderValue::from_str(&format!("bytes={start}-{end}")).map_err(|e| e.to_string())?,
    );
    let res = req
        .client
        .get(fetch)
        .headers(h)
        .send()
        .await
        .map_err(|e| friendly(&e))?;
    let status = res.status().as_u16();
    /* ⚠️ 200 必须挡住。RFC 9110 允许服务端忽略 Range 而整份回 200，
    这时每个分块都从自己的 `start` 写整份 body，块间互相重叠或留洞 ——
    成品是坏文件，而且 download() 随后 rename 会把它当成功提交，用户一点提示都收不到。 */
    if status == 200 {
        return Err(format!("{CHUNK_UNSUPPORTED}（{fetch}）"));
    }
    if status != 206 {
        return Err(format!("分块下载失败 HTTP {status}（{fetch}）"));
    }
    /* ⚠️ 认了 206 还要核对回的正是这个窗口：窗口偏了照样写坏成品。
    头缺席时不判死，交给下面的字节数核对兜底。 */
    if let Some(cr) = res
        .headers()
        .get(reqwest::header::CONTENT_RANGE)
        .and_then(|v| v.to_str().ok())
        && !content_range_matches(cr, start, end)
    {
        return Err(format!(
            "分块下载：服务端回的区间不是 {start}-{end}（{cr}，{fetch}）"
        ));
    }

    /* ⚠️ **必须是可写的句柄。** 用 `File::open`（`O_RDONLY`）时 Windows 的
    `seek_write` / Unix 的 `write_at` 都要写权限，于是**每一块都立刻 EBADF**、
    重试 5 次，再被上面「分块失败退回单流」静默接住：表现是「多线程下载从来没
    生效过」，界面上的 `threads` 填 4 也没用，而且一个错都不报。 */
    let file = std::fs::OpenOptions::new()
        .write(true)
        .open(req.part)
        .map_err(|e| e.to_string())?;
    let mut pos = start;
    let mut stream = res.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        /* ⚠️ 越过窗口边界 = 回的区间比要的长，写下去会盖掉下一块。
        到这儿才判，是因为头可以骗人、盘上的字节数不会。 */
        if pos.saturating_add(chunk.len() as u64) > end + 1 {
            return Err(format!(
                "分块下载：服务端给的字节超出 {start}-{end}（{fetch}）"
            ));
        }
        write_at(&file, &chunk, pos).map_err(|e| e.to_string())?;
        pos += chunk.len() as u64;
        tracker.add(chunk.len() as u64);
        *counted += chunk.len() as u64;
        // ⚠️ 与单流同款：判据放在写盘之后、下一块之前，否则一次停止会多下几 MB
        if (ctl.check)() {
            return Err(STOPPED.to_string());
        }
    }
    // 头对了、字节数也要对：窗口比要的短时 pos 停在 end 之前，成品留个洞
    let want = end - start + 1;
    if pos < end + 1 {
        return Err(format!(
            "分块下载：区间 {start}-{end} 只下到 {} / {want} 字节（{fetch}）",
            pos - start
        ));
    }
    Ok(())
}

/// `Content-Range: bytes 100-199/1234` —— 核对它说的正是我们要的窗口。
fn content_range_matches(value: &str, start: u64, end: u64) -> bool {
    let Some(spec) = value.trim().strip_prefix("bytes ") else {
        return false;
    };
    let Some((span, _total)) = spec.split_once('/') else {
        return false;
    };
    let Some((s, e)) = span.split_once('-') else {
        return false;
    };
    match (s.trim().parse::<u64>(), e.trim().parse::<u64>()) {
        (Ok(s), Ok(e)) => s == start && e == end,
        _ => false,
    }
}

/// 定位写入。每个分块任务各持一个文件句柄，所以不能用共享的 seek 位置。
#[cfg(windows)]
fn write_at(f: &std::fs::File, buf: &[u8], offset: u64) -> std::io::Result<()> {
    use std::os::windows::fs::FileExt;
    f.seek_write(buf, offset).map(|_| ())
}

#[cfg(unix)]
fn write_at(f: &std::fs::File, buf: &[u8], offset: u64) -> std::io::Result<()> {
    use std::os::unix::fs::FileExt;
    f.write_at(buf, offset).map(|_| ())
}

/* ══════════════════════════ 探测与进度 ══════════════════════════ */

/// 探测远端大小与是否支持分段（`Range: bytes=0-0`）。
pub async fn probe(
    url: &str,
    hdrs: &HeaderMap,
    client: &reqwest::Client,
) -> Result<(u64, bool), String> {
    let mut h = hdrs.clone();
    h.insert(
        reqwest::header::RANGE,
        HeaderValue::from_static("bytes=0-0"),
    );
    let res = client
        .get(url)
        .headers(h)
        .timeout(Duration::from_secs(15))
        .send()
        .await
        .map_err(|e| {
            if e.is_timeout() {
                format!("请求超时（15000ms）：{url}")
            } else {
                friendly(&e)
            }
        })?;

    let status = res.status().as_u16();
    let range = res
        .headers()
        .get("content-range")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();
    let len = res
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .unwrap_or(0);
    let accept = res
        .headers()
        .get("accept-ranges")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .contains("bytes");
    // 读完并丢弃，避免连接悬挂
    let _ = res.bytes().await;

    let size = match range.split_once('/') {
        Some((_, t)) => t.parse::<u64>().unwrap_or(0),
        None => len,
    };
    Ok((size, status == 206 || accept))
}

/// 累计已下的字节、必要时回报进度。
///
/// **不自己算速度与百分数**，只报原始字节数。那两样（`speed` / `percent`）是
/// bili 那边的展示需求，由 `net` 的适配层算 —— 引擎不该知道界面要显示什么。
struct Tracker<'a> {
    received: AtomicU64,
    total: Option<u64>,
    note: Note<'a>,
}

impl<'a> Tracker<'a> {
    fn new(total: Option<u64>, note: Note<'a>) -> Self {
        Self {
            received: AtomicU64::new(0),
            total,
            note,
        }
    }

    fn received(&self) -> u64 {
        self.received.load(Ordering::Relaxed)
    }

    /// 把计数归到 `n`（续传/回退时用：盘上已经有 `n` 字节）。
    fn reset(&self, n: u64) {
        self.received.store(n, Ordering::Relaxed);
    }

    fn add(&self, n: u64) {
        let got = self.received.fetch_add(n, Ordering::Relaxed) + n;
        self.tick(got, self.total);
    }

    /// 把 `n` 退回去（重试同一个窗口时，上一轮已经数过一遍）。
    fn sub(&self, n: u64) {
        if n == 0 {
            return;
        }
        let got = self.received.fetch_sub(n, Ordering::Relaxed) - n;
        self.tick(got, self.total);
    }

    fn tick(&self, got: u64, total: Option<u64>) {
        (self.note)(got, total.or(self.total), Stage::Download);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::AtomicBool;

    /* 下面这一组钉的是**引擎自己的收场规则**（盘上留不留东西、暂停与取消的
    区别、重试用哪一轮的字节数当起点）—— `net::tests` 那几条只管取字节。 */

    /// 认 `Range` 的最小服务器，回整份或指定区间。
    fn server(payload: Vec<u8>) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let total = payload.len();
            for conn in listener.incoming() {
                let Ok(mut s) = conn else { continue };
                let mut buf = [0u8; 4096];
                let read = s.read(&mut buf).unwrap_or(0);
                if read == 0 {
                    continue;
                }
                let head = String::from_utf8_lossy(&buf[..read]).to_string();
                let (code, from, to) = match range_of(&head) {
                    Some((a, b)) => ("206 Partial Content", a.min(total), b.min(total - 1)),
                    None => ("200 OK", 0, total.saturating_sub(1)),
                };
                let body = if total == 0 {
                    &[][..]
                } else {
                    &payload[from..=to]
                };
                let mut resp = format!(
                    "HTTP/1.1 {code}\r\nContent-Length: {}\r\nAccept-Ranges: bytes\r\n\
                     Connection: close\r\n",
                    body.len()
                );
                if code.starts_with("206") {
                    resp.push_str(&format!("Content-Range: bytes {from}-{to}/{total}\r\n"));
                }
                resp.push_str("\r\n");
                let _ = s.write_all(resp.as_bytes());
                let _ = s.write_all(body);
                let _ = s.flush();
            }
        });
        format!("http://127.0.0.1:{port}/f.bin")
    }

    fn range_of(head: &str) -> Option<(usize, usize)> {
        for line in head.lines() {
            let low = line.to_ascii_lowercase();
            if let Some(rest) = low.strip_prefix("range:") {
                let v = rest.trim().strip_prefix("bytes=")?;
                let (a, b) = v.split_once('-')?;
                let a: usize = a.trim().parse().ok()?;
                let b = if b.trim().is_empty() {
                    usize::MAX
                } else {
                    b.trim().parse().ok()?
                };
                return Some((a, b));
            }
        }
        None
    }

    /// 一个**发一半就掐断**的服务器：声明整个长度，只写一部分就关连接。
    /// 用它才能得到「引擎真的往盘上写了半个文件、然后失败」这个现场。
    fn half_then_break(payload: Vec<u8>) -> String {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let total = payload.len();
            for conn in listener.incoming() {
                let Ok(mut s) = conn else { continue };
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf);
                // 声明整长、只发一半 → 客户端读到的是「少了半截」
                let resp = format!(
                    "HTTP/1.1 200 OK\r\nContent-Length: {total}\r\nConnection: close\r\n\r\n"
                );
                let _ = s.write_all(resp.as_bytes());
                let _ = s.write_all(&payload[..total / 2]);
                let _ = s.flush();
            }
        });
        format!("http://127.0.0.1:{port}/f.bin")
    }

    /// 一个连不上的地址（端口没人听）。
    fn dead_server() -> String {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let p = l.local_addr().unwrap().port();
        drop(l); // 关掉，端口就没人听了
        format!("http://127.0.0.1:{p}/x.bin")
    }

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("vss-dl-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn no_stop() -> Control<'static> {
        Control::new(|| false, || false)
    }

    /// 下成之后 `part` 里是整份内容。
    #[tokio::test]
    async fn a_successful_download_leaves_the_whole_payload() {
        let dir = tmp("ok");
        let payload: Vec<u8> = (0..5000u32).map(|i| (i % 251) as u8).collect();
        let url = server(payload.clone());
        let part = dir.join("a.bin");

        let req = Request {
            url: &url,
            label: "",
            part: &part,
            headers: &[],
            shape: Shape::Plain,
            client: default_client(),
            retry: Retry::NONE,
            expect: None,
        };
        let out = download(&req, &no_stop(), &|_, _, _| {}).await.unwrap();
        assert_eq!(
            out,
            Outcome::Done {
                bytes: payload.len() as u64
            }
        );
        assert_eq!(std::fs::read(&part).unwrap(), payload);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★ `Plain`（不可续传）下失败之后**盘上不该留下半截文件**。
    ///
    /// 为什么这条最要紧：`Plain` 调用方的落点往往是**用户的目录**（`lyrics`
    /// 那个直接写成 `<音乐目录>/<歌名>.mp3`）。引擎不统一收拾的话，下载失败会在
    /// 用户眼前留一个播不动的文件、名字还像正常的。
    #[tokio::test]
    async fn plain_shape_removes_the_partial_after_failure() {
        let dir = tmp("plain-fail");
        let part = dir.join("half.bin");

        /* ⚠️ 别用一个「端口没人听」的地址来测这条：引擎在开工前就把旧字节删了
        （`Plain` 的清理），断言「文件不在」自然成立 —— 那证明的是「开工前
        清理」，不是「失败后清理」。要测后者，必须让引擎**先真写进去半个文件、
        再失败**，所以用 `half_then_break`。 */
        let payload = vec![0x5Au8; 200_000];
        let url = half_then_break(payload);
        let req = Request {
            url: &url,
            label: "",
            part: &part,
            headers: &[],
            shape: Shape::Plain,
            client: default_client(),
            retry: Retry::NONE,
            expect: None,
        };
        let err = download(&req, &no_stop(), &|_, _, _| {}).await.unwrap_err();
        assert!(!err.is_empty());
        assert!(
            !part.exists(),
            "Plain 失败后还留着半截文件：内容是「引擎写进去的那一半」——             用户会把它当成下好了（`lyrics` 那条路径的落点是他的音乐目录）"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★ `Resumable`（可续传）下失败之后**要留着**：那是下次接着下的起点。
    ///
    /// 与上一条刚好相反，所以这个区别不能靠调用方各自记得 —— 得由 `Shape` 定。
    #[tokio::test]
    async fn resumable_shape_keeps_the_partial_after_failure() {
        let dir = tmp("resumable-fail");
        let part = dir.join("half.part");

        // 同样要「先写进去再失败」才是真现场（见上一条的注释）
        let payload = vec![0x5Au8; 200_000];
        let url = half_then_break(payload);
        let req = Request {
            url: &url,
            label: "",
            part: &part,
            headers: &[],
            shape: Shape::Resumable,
            client: default_client(),
            retry: Retry::NONE,
            expect: None,
        };
        let _ = download(&req, &no_stop(), &|_, _, _| {}).await.unwrap_err();
        assert!(
            part.exists(),
            "Resumable 失败后把续传点删了（下次得从头下）"
        );
        assert!(
            file_size(&part) > 0,
            "留着的是个空文件 —— 那下次续传等于从头下，白留"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 暂停与取消的区别：暂停**留**着（下次接着下），取消**删掉**（这次不算数）。
    #[tokio::test]
    async fn pause_keeps_the_partial_but_cancel_drops_it() {
        let dir = tmp("pause-cancel");
        let part = dir.join("p.part");
        let url = dead_server();
        let base = Request {
            url: &url,
            label: "",
            part: &part,
            headers: &[],
            shape: Shape::Resumable,
            client: default_client(),
            retry: Retry::NONE,
            expect: None,
        };

        // 暂停：check 立着、is_cancel 不立 → Paused，文件留着
        std::fs::write(&part, b"kept").unwrap();
        let paused = download(&base, &Control::new(|| true, || false), &|_, _, _| {})
            .await
            .unwrap();
        assert!(
            matches!(paused, Outcome::Paused { .. }),
            "该是暂停：{paused:?}"
        );
        assert!(part.exists(), "暂停后该留着续传点");

        // 取消：两个都立 → Cancelled，文件及记号都删
        std::fs::write(&part, b"dropped").unwrap();
        write_url_marker(&part, &url).unwrap();
        let gone = download(&base, &Control::new(|| true, || true), &|_, _, _| {})
            .await
            .unwrap();
        assert_eq!(gone, Outcome::Cancelled);
        assert!(!part.exists(), "取消后该把续传点删掉");
        assert!(!url_marker(&part).exists(), "取消后该把记号也删掉");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `Retry { rounds: 2 }` = 失败后再试 2 轮，**总共 3 轮**。
    ///
    /// ⚠️ 这个「`rounds` 是"再来几轮"不是"一共几轮"」的语义很容易配错，而配错的
    /// 后果是「说好 5 轮实际 6 轮」这种看不出来的偏差。用调用次数钉住它。
    #[tokio::test]
    async fn retry_rounds_means_extra_attempts_after_the_first() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let h2 = hits.clone();
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(mut s) = conn else { continue };
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf);
                h2.fetch_add(1, Ordering::Relaxed);
                // 一律 500，逼它重试到放弃
                let _ = s.write_all(
                    b"HTTP/1.1 500 Oops\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                );
                let _ = s.flush();
            }
        });
        let url = format!("http://127.0.0.1:{port}/f.bin");
        let dir = tmp("rounds");
        let part = dir.join("r.bin");
        let req = Request {
            url: &url,
            label: "",
            part: &part,
            headers: &[],
            shape: Shape::Plain,
            client: default_client(),
            retry: Retry {
                rounds: 2,
                wait: Duration::from_millis(10),
            },
            expect: None,
        };
        let err = download(&req, &no_stop(), &|_, _, _| {}).await.unwrap_err();
        assert!(err.contains("试了 2 轮"), "报错该说清试了几轮：{err}");
        assert_eq!(
            hits.load(Ordering::Relaxed),
            3,
            "rounds=2 该是「首轮 + 再来 2 轮」= 3 次请求"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 不可续传时**开工前**要把盘上的旧字节删掉。
    ///
    /// ⚠️ 不删的后果不是「多下一点」而是**拼出坏文件**：`part` 里是旧内容的前
    /// 半段，新内容从头覆盖，两段接在一起 —— 要到用它的时候才炸。
    #[tokio::test]
    async fn plain_shape_clears_stale_bytes_before_starting() {
        let dir = tmp("stale");
        let part = dir.join("s.bin");
        // 旧字节比新内容长：不删的话文件会比应该的长
        std::fs::write(&part, vec![0xAAu8; 9000]).unwrap();
        let payload = vec![0x11u8; 100];
        let url = server(payload.clone());

        let req = Request {
            url: &url,
            label: "",
            part: &part,
            headers: &[],
            shape: Shape::Plain,
            client: default_client(),
            retry: Retry::NONE,
            expect: None,
        };
        download(&req, &no_stop(), &|_, _, _| {}).await.unwrap();
        assert_eq!(
            std::fs::read(&part).unwrap(),
            payload,
            "旧字节没清干净，拼出了「旧前半段 + 新整段」"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★ `expect`：下完的字节数与期望不符时**当成这一轮失败**（删掉重下）。
    ///
    /// 这是在测「GitHub release 偶发回一个截断的响应」那种坏结果 —— 它不是网络
    /// 错（连接好好地结束了），不核对就会把一个半截文件当好文件交给调用方
    /// （`fetch_to_file` 存在的全部理由）。
    #[tokio::test]
    async fn a_size_mismatch_counts_as_this_round_failing() {
        // 服务器只给 100 字节，但我们期望 200 —— 每轮都对不上
        let url = server(vec![0x7Eu8; 100]);
        let dir = tmp("expect-mismatch");
        let part = dir.join("e.bin");
        let req = Request {
            url: &url,
            label: "",
            part: &part,
            headers: &[],
            shape: Shape::Plain,
            client: default_client(),
            retry: Retry {
                rounds: 1,
                wait: Duration::from_millis(10),
            },
            expect: Some(200),
        };
        let err = download(&req, &no_stop(), &|_, _, _| {}).await.unwrap_err();
        assert!(
            err.contains("200") && err.contains("100"),
            "报错该说清「拿到多少、期望多少」：{err}"
        );
        assert!(!part.exists(), "大小不对的坏文件不该留在盘上");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `expect` 对得上就正常放行（别把正常情况也判失败）。
    #[tokio::test]
    async fn a_matching_expect_passes() {
        let payload = vec![0x31u8; 4096];
        let url = server(payload.clone());
        let dir = tmp("expect-ok");
        let part = dir.join("e.bin");
        let req = Request {
            url: &url,
            label: "",
            part: &part,
            headers: &[],
            shape: Shape::Plain,
            client: default_client(),
            retry: Retry::NONE,
            expect: Some(payload.len() as u64),
        };
        let out = download(&req, &no_stop(), &|_, _, _| {}).await.unwrap();
        assert_eq!(
            out,
            Outcome::Done {
                bytes: payload.len() as u64
            }
        );
        assert_eq!(std::fs::read(&part).unwrap(), payload);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// ★ `expect` 对不上时必须**重下**，而重下要能成功（服务器第二次给对）。
    ///
    /// 这一条同时钉住「重下是删掉从头来」：`Plain` 下不清掉上一轮的字节，
    /// 第二轮写完的文件会带着第一轮的残渣（长度或内容不对）。
    #[tokio::test]
    async fn a_size_mismatch_is_retried_and_can_succeed() {
        use std::io::{Read, Write};
        use std::sync::atomic::AtomicUsize;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = std::sync::Arc::new(AtomicUsize::new(0));
        let h2 = hits.clone();
        let good = vec![0x42u8; 300];
        let good2 = good.clone();
        std::thread::spawn(move || {
            let mut n = 0;
            for conn in listener.incoming() {
                let Ok(mut s) = conn else { continue };
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf);
                n += 1;
                h2.fetch_add(1, Ordering::Relaxed);
                // 第一次只给一半（截断的响应），之后给整份
                let body: &[u8] = if n == 1 { &good2[..150] } else { &good2 };
                let resp = format!(
                    "HTTP/1.1 200 OK
Content-Length: {}
Connection: close

",
                    body.len()
                );
                let _ = s.write_all(resp.as_bytes());
                let _ = s.write_all(body);
                let _ = s.flush();
            }
        });
        let url = format!("http://127.0.0.1:{port}/f.bin");
        let dir = tmp("expect-retry");
        let part = dir.join("e.bin");
        let req = Request {
            url: &url,
            label: "",
            part: &part,
            headers: &[],
            shape: Shape::Plain,
            client: default_client(),
            retry: Retry {
                rounds: 3,
                wait: Duration::from_millis(10),
            },
            expect: Some(good.len() as u64),
        };
        let out = download(&req, &no_stop(), &|_, _, _| {}).await.unwrap();
        assert_eq!(
            out,
            Outcome::Done {
                bytes: good.len() as u64
            }
        );
        assert_eq!(
            std::fs::read(&part).unwrap(),
            good,
            "重下之后内容还是不对 —— 多半是没清掉上一轮的字节就接着写"
        );
        assert!(hits.load(Ordering::Relaxed) >= 2, "该真的重下了一次");
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `Shape` 的三个推导：probe 只跟着分块走，threads 只在分块时有意义。
    #[test]
    fn shape_derives_probe_and_threads() {
        assert!(!Shape::Plain.probe());
        assert!(!Shape::Resumable.probe());
        assert!(
            Shape::Parallel { threads: 4 }.probe(),
            "分块必须先 probe 才知道切几块"
        );

        assert_eq!(Shape::Plain.threads(), 1);
        assert_eq!(Shape::Resumable.threads(), 1, "续传不分块，线程数无意义");
        assert_eq!(Shape::Parallel { threads: 8 }.threads(), 8);
        // 0 是配置里不该出现的值，但真给了也不能让它把 div_ceil 弄炸
        assert_eq!(Shape::Parallel { threads: 0 }.threads(), 1);

        assert!(!Shape::Plain.resumable());
        assert!(Shape::Resumable.resumable());
        assert!(
            !Shape::Parallel { threads: 4 }.resumable(),
            "分块与续传互斥"
        );
    }

    /// `.part.url` 记号的判定：写着本链接才认；缺记号算「可以续」。
    #[test]
    fn stored_resume_only_trusts_a_matching_or_missing_marker() {
        let dir = tmp("marker");
        let part = dir.join("m.part");

        assert!(!stored_resume(&part, "u"), "文件都不在，没什么可续的");

        std::fs::write(&part, b"abc").unwrap();
        assert!(
            stored_resume(&part, "u"),
            "缺记号算可以续（旧版本留下的 .part）"
        );

        write_url_marker(&part, "u").unwrap();
        assert!(stored_resume(&part, "u"), "记号写着同一条链接，当然认");
        assert!(
            !stored_resume(&part, "other"),
            "记号写着别的链接 —— 要当真（否则会拼出坏文件）"
        );

        // 记号的空白要忽略（`DownloadCtl` 存进去的是 trim 过的）
        write_url_marker(&part, "  u  ").unwrap();
        assert!(stored_resume(&part, "u"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 只允许 http(s)。`file://` / `ftp://` 之类不该走到发请求那一步。
    #[tokio::test]
    async fn only_http_urls_are_accepted() {
        let dir = tmp("scheme");
        let part = dir.join("x.bin");
        for bad in ["file:///etc/passwd", "ftp://x/y", "/local/path"] {
            let req = Request {
                url: bad,
                label: "",
                part: &part,
                headers: &[],
                shape: Shape::Plain,
                client: default_client(),
                retry: Retry::NONE,
                expect: None,
            };
            let err = download(&req, &no_stop(), &|_, _, _| {}).await.unwrap_err();
            assert!(err.contains("http"), "{bad} 该被拒：{err}");
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// `Shape` 与 `Retry` 都是 `Copy` —— 调用方要在循环里复用它们。
    #[test]
    fn the_knobs_are_copy() {
        let sh = Shape::Parallel { threads: 4 };
        let a = sh;
        let b = sh; // Copy：还能再用一次
        assert_eq!(a, b);
        let r = Retry::BILI;
        let _ = r;
        let _ = r;
        let _ = Retry::NONE;
        let _ = Retry::BIG_PACK;
    }

    /// 两个旗标都立着时按「取消」算（`is_cancel` 说了算）。
    #[tokio::test]
    async fn cancel_wins_from_pause_when_both_flags_are_up() {
        static BOTH: AtomicBool = AtomicBool::new(true);
        let ctl = Control::new(
            || BOTH.load(Ordering::Relaxed),
            || BOTH.load(Ordering::Relaxed),
        );
        let dir = tmp("both");
        let part = dir.join("b.part");
        std::fs::write(&part, b"x").unwrap();
        let req = Request {
            url: "http://example.invalid/x",
            label: "",
            part: &part,
            headers: &[],
            shape: Shape::Resumable,
            client: default_client(),
            retry: Retry::NONE,
            expect: None,
        };
        // 引擎开工前就查 check，所以这里不会真发请求
        let out = download(&req, &ctl, &|_, _, _| {}).await.unwrap();
        assert_eq!(out, Outcome::Cancelled);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// 续传时服务端回 `416`：盘上那一份**已经下全了**，这一轮算成功。
    ///
    /// 分卷下载全靠这一条：卷是按顺序下的，中间停一次之后前面那几卷都是一整份，
    /// 而「这一卷下完没有」在下一轮开工时只能靠再要一次 `Range` 来问 ——
    /// 服务端对「起点 == 文件末尾」的回法就是 416。不认它的表现是：用户暂停一次，
    /// 再点「继续下载」时前面每一卷都报一次错、重试 5 轮、最后整个包失败。
    #[tokio::test]
    async fn a_416_means_the_part_on_disk_is_already_whole() {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let hits = std::sync::Arc::new(AtomicU64::new(0));
        let hits2 = hits.clone();
        std::thread::spawn(move || {
            for conn in listener.incoming() {
                let Ok(mut s) = conn else { continue };
                let mut buf = [0u8; 4096];
                let _ = s.read(&mut buf);
                hits2.fetch_add(1, Ordering::Relaxed);
                // ⚠️ 只回 416，一个字节的 body 都不给 —— 引擎不该把它当成失败
                let _ = s.write_all(
                    b"HTTP/1.1 416 Range Not Satisfiable\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                );
            }
        });
        let url = format!("http://127.0.0.1:{port}/x.bin");

        let dir = tmp("range-416");
        let part = dir.join("x.part");
        std::fs::write(&part, vec![3u8; 1000]).unwrap();
        // 记号要指同一条链接，否则引擎会当成「别人的半个包」从头下
        write_url_marker(&part, &url).unwrap();

        let req = Request {
            url: &url,
            label: "分卷",
            part: &part,
            headers: &[],
            shape: Shape::Resumable,
            client: default_client(),
            retry: Retry::BIG_PACK,
            expect: None,
        };
        let out = download(&req, &no_stop(), &|_, _, _| {}).await.unwrap();
        assert_eq!(
            out,
            Outcome::Done { bytes: 1000 },
            "盘上那一卷已经下全了，416 该被当成「下完了」"
        );
        assert_eq!(
            std::fs::metadata(&part).unwrap().len(),
            1000,
            "416 不该往文件里写东西"
        );
        assert_eq!(
            hits.load(Ordering::Relaxed),
            1,
            "416 是成功收场，不该再重试"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    // 窗口对不上就写不进去：服务器答 200 或给别的区间时，盘上那段字节不属于请求的
    // 窗口，拼出来的 .part 内容是错的，而且不会报任何错。
    #[test]
    fn content_range_only_passes_when_it_matches_the_requested_window() {
        assert!(content_range_matches("bytes 0-99/1000", 0, 99));
        assert!(
            !content_range_matches("bytes 100-199/1000", 0, 99),
            "区间不同"
        );
        assert!(!content_range_matches("bytes */1000", 0, 99), "没给区间");
        assert!(!content_range_matches("bytes 0-99", 0, 99), "没给总长");
        assert!(!content_range_matches("0-99/1000", 0, 99), "缺 bytes 前缀");
        assert!(!content_range_matches("bytes a-b/1000", 0, 99), "非数字");
    }

    // 重试同一个窗口时，上一轮已经数过一遍的字节要退回来。不退进度会提前冲到 100%，
    // 退多了又会倒着走。
    #[test]
    fn tracker_sub_pulls_back_the_bytes_a_retry_never_wrote() {
        let ticks: std::sync::Mutex<Vec<u64>> = std::sync::Mutex::new(Vec::new());
        let note: Note<'_> = &|got, _, _| ticks.lock().unwrap().push(got);
        let t = Tracker::new(Some(1000), note);
        t.add(400);
        t.sub(400);
        assert_eq!(t.received(), 0, "没写进盘的 400 字节要从进度里退掉");
        assert_eq!(
            *ticks.lock().unwrap().last().unwrap(),
            0,
            "最后一次回报该是 0，不是 400"
        );
        t.sub(0);
        assert_eq!(t.received(), 0, "退 0 是空操作，不该把计数搞坏");
        t.add(100);
        assert_eq!(t.received(), 100);
    }
}
