//! 视频解析下载 / 音频工具 / **预览缓存**。
//!
//! **预览必须落盘**：IPC 做不了「让 `<video>` 直接吃远端直链」—— `<video src>` 要一个
//! 可寻址的 URL，而 IPC 是请求-应答、没有流、没有 Range。所以 `preview_fetch(url)` 把流
//! 落到本机缓存文件，前端 `convertFileSrc()` 一包就交给 `<video>`（**Range 由 asset 协议
//! 内置**，206 可用）。
//! ⚠️ **别改成「直接给远端 URL」**：B 站 CDN 认 `Referer`、会给 403，yt-dlp 的 YouTube
//! 直链带 `n` 参数、不经过签名变换会限速。落盘的代价是预览多等几秒（缓存那一段），换来
//! 同一支 MV 只看一次就落地、**二次播放是瞬时的**。
//! `video_download` 只是入口，后面挂着 600 多行编排（挑流、进度、取消收尾）。

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use serde_json::{Map, Value, json};
// ⚠️ `asset_protocol_scope()` / `path()` 是 `Manager` trait 的方法 —— 不 use 它，
// `app` 上什么都没有（报错是「方法不存在」，很容易去翻 tauri 版本而不是补这行 use）。
use tauri::Manager;

use super::Cmd;
use super::jobs::{finish_with_result, new_job, set_job};
use crate::audio::CANCELED;
use crate::bili::{Bili, safe_title};
use crate::net;
use crate::ytdlp;

/// 缓存上限 1 GB。超了先删最久没动过的（LRU）。
///
/// 为什么要有上限：一支 1080P 的 MV 几百 MB，缓存目录在 `%LOCALAPPDATA%` 下、
/// 属于**系统盘**，而这个项目里已经有一次「把 C 盘撑到 0 字节」的记录。
const CACHE_LIMIT: u64 = 1024 * 1024 * 1024;

/* ══════════════════════════════ 任务小工具 ══════════════════════════════ */

/// 任务当前状态（`cancel_flag` 用它把「任务表里的状态」变成一个可传递的闭包）。
fn job_status(st: &Arc<super::AppState>, id: &str) -> String {
    let Ok(guard) = st.jobs.lock() else {
        return String::new();
    };
    guard
        .items
        .get(id)
        .and_then(|j| j.get("status"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// 取消标志：把「任务表里状态变成 canceled」变成一个可传给下载/子进程的闭包。
fn cancel_flag(st: &Arc<super::AppState>, id: &str) -> Arc<net::Cancel> {
    let st = Arc::clone(st);
    let id = id.to_string();
    Arc::new(move || job_status(&st, &id) == "canceled")
}

/// 改任务进度：percent/message 直接改，其余字段并进 `progress` 里。
/// （前端读的是 `job.progress.speedText`，所以额外字段必须放在 `progress` 下面。）
///
/// 和 `jobs::set_job` 一样：锁内取快照、**锁外广播** —— 下载进度更新很密，
/// 不广播的话前端 `job_watch` 拿到的是断断续续的进度。
fn set_progress(
    st: &Arc<super::AppState>,
    id: &str,
    percent: Option<f64>,
    message: Option<&str>,
    extra: Value,
) {
    let Ok(mut guard) = st.jobs.lock() else {
        return;
    };
    let snapshot = match guard.items.get_mut(id) {
        Some(job) => {
            if let Some(m) = job.as_object_mut() {
                if let Some(p) = percent {
                    if p >= 0.0 {
                        m.insert("percent".into(), json!(p.clamp(0.0, 100.0)));
                    }
                }
                if let Some(msg) = message {
                    if !msg.is_empty() {
                        m.insert("message".into(), json!(msg));
                    }
                }
                if !extra.is_null() {
                    if let Some(prog) = m.get_mut("progress").and_then(|v| v.as_object_mut()) {
                        if let Some(src) = extra.as_object() {
                            // null 值 = 删该字段。下载阶段的回调用 `{}` 表示「无附加字段」，
                            // 不能在每次更新时顺带清速率 —— 那会抹掉另一路并发回调刚写的值
                            for (k, v) in src {
                                if v.is_null() {
                                    prog.remove(k);
                                } else {
                                    prog.insert(k.clone(), v.clone());
                                }
                            }
                        }
                    }
                }
            }
            Some(job.clone())
        }
        None => None,
    };
    if let Some(j) = snapshot {
        guard.publish(&j);
    }
}

/// 把任务标成「已取消」。
///
/// ⚠️ 写成**本文件的私有助手**，而不是借 `super::jobs::job_canceled`：那个名字在
/// `jobs.rs` 里同时被一个 `#[tauri::command]` 用着，而宏会为它生成同名包装项 ——
/// 跨模块按那个名字调会解析到宏生成的那个，报出
/// 「expected `State<Arc<AppState>>`, found `&Arc<AppState>`」这种看着莫名其妙的错。
fn mark_canceled(st: &Arc<super::AppState>, id: &str) {
    set_job(st, id, json!({ "status": "canceled", "message": "已取消" }));
}

/// 把任务标成失败。状态词必须是 `error` —— 前端只认
/// `running | done | error | canceled`，别的词会让进度条一直转。
fn mark_failed(st: &Arc<super::AppState>, id: &str, error: &str) {
    set_job(
        st,
        id,
        json!({ "status": "error", "error": error, "message": error }),
    );
}

/// 文件名（不含目录）。下载完成的提示里要用它。
fn basename(p: &str) -> String {
    Path::new(p)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
}

/* ══════════════════════════════ 视频解析 / 下载 ══════════════════════════════ */

/// 解析一个视频链接（B 站原生 / 其它站点走 yt-dlp）。
///
/// 回包形状：B 站是 `{source, kind, info, streams, hasCookie}`，
/// 别的站点是 `{source, kind, info}`。`currentPage` 只在有分P时出现
/// （不出现比 `null` 好：前端按键的有无判断，见 `lib/api.ts` 的 `VideoParse`）。
#[tauri::command]
pub async fn video_parse(st: super::St<'_>, args: Value) -> Cmd {
    let raw = args
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if raw.is_empty() {
        return Err("请输入视频链接".into());
    }

    let cfg = st.config_snapshot();

    // B 站走原生解析
    if crate::bili::is_bilibili(&raw) {
        let cookie = args
            .get("cookie")
            .and_then(|v| v.as_str())
            .map(String::from)
            .unwrap_or_else(|| {
                cfg.get("bilibiliCookie")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string()
            });
        let client = Bili::new(&cookie);
        let parsed = client.parse_input(&raw).await.map_err(|e| e.to_string())?;

        if parsed.kind == "bangumi" {
            let info = client
                .get_bangumi_info(parsed.ep_id, parsed.season_id)
                .await
                .map_err(|e| e.to_string())?;
            let mut streams = Value::Null;
            if let Some(cid) = info.get("cid").and_then(|v| v.as_i64()) {
                let ep_id = info.get("epId").and_then(|v| v.as_i64());
                streams = client
                    .get_play_streams(None, None, cid, 127, ep_id)
                    .await
                    .unwrap_or_else(|e| json!({ "error": e }));
            }
            let value = json!({
                "source": "bilibili",
                "kind": "bangumi",
                "info": info,
                "streams": streams,
                "hasCookie": client.has_login(),
            });
            remember_hosts(&value);
            return Ok(value);
        }

        let info = client
            .get_video_info(parsed.bvid.as_deref(), parsed.aid)
            .await
            .map_err(|e| e.to_string())?;
        let pages = info
            .get("pages")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let page = pages
            .iter()
            .find(|p| p.get("page").and_then(|v| v.as_i64()) == Some(parsed.page))
            .or_else(|| pages.first())
            .cloned();

        let mut streams = Value::Null;
        if let Some(cid) = page
            .as_ref()
            .and_then(|p| p.get("cid"))
            .and_then(|v| v.as_i64())
        {
            let bvid = info.get("bvid").and_then(|v| v.as_str()).map(String::from);
            streams = client
                .get_play_streams(bvid.as_deref(), None, cid, 127, None)
                .await
                .unwrap_or_else(|e| json!({ "error": e }));
        }

        let mut out = Map::new();
        out.insert("source".into(), json!("bilibili"));
        out.insert("kind".into(), json!("video"));
        out.insert("info".into(), info);
        if let Some(p) = page {
            out.insert("currentPage".into(), p);
        }
        out.insert("streams".into(), streams);
        out.insert("hasCookie".into(), json!(client.has_login()));
        let value = Value::Object(out);
        remember_hosts(&value);
        return Ok(value);
    }

    // 其它站点交给 yt-dlp
    let proxy = cfg
        .get("proxy")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let info = ytdlp::inspect(&st.inner().root, &raw, proxy, None)
        .await
        .map_err(|e| e.to_string())?;
    let value = json!({
        "source": "ytdlp",
        "kind": "video",
        "info": info,
    });
    remember_hosts(&value);
    Ok(value)
}

/// 提交一次下载。立刻回 `{jobId}`，进度走 `job_watch`。
///
/// `args` 的形状（前端 `pages/Video.tsx` 按此提交，字段一个都不能改名）：
/// `{ url, source, outDir?, mode?, quality?, audioQuality?, page?, cookie?,
///    downloadCover?, downloadDanmaku?, downloadSubs?, formatId?, convertTo?,
///    cookiesFromBrowser? }`。
///
/// 两条下载路：B 站走原生（`download_bilibili`），别的站点交给 yt-dlp
/// （`download_ytdlp`）。**两条都在后台跑**，进度靠任务表广播出去。
#[tauri::command]
pub async fn video_download(st: super::St<'_>, args: Value) -> Cmd {
    let url = args
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if url.is_empty() {
        return Err("缺少视频链接".into());
    }

    let source = args
        .get("source")
        .and_then(|v| v.as_str())
        .unwrap_or("bilibili")
        .to_string();
    let st_arc: Arc<super::AppState> = st.inner().clone();
    let cfg = st_arc.config_snapshot();
    let target_dir = args
        .get("outDir")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(String::from)
        .or_else(|| {
            cfg.get("downloadDir")
                .and_then(|v| v.as_str())
                .map(String::from)
        })
        .unwrap_or_default();
    /* ⚠️ 空目录必须挡：`create_dir_all("")` 是 std 的特例、直接回 Ok，
    于是所有产物按相对路径落到进程 CWD（装在 Program Files 时是一片权限错误，
    否则文件散落安装目录）。前端目前会先拦，这里是给绕过前端的调用兜底。 */
    if target_dir.trim().is_empty() {
        return Err("没有输出目录：先到设置里选一个下载目录".into());
    }
    std::fs::create_dir_all(&target_dir).map_err(|e| e.to_string())?;

    let title = format!("下载 {}", url.chars().take(60).collect::<String>());
    let job_id = new_job(&st_arc, "download", &title);
    // 任务对象还带 meta / result / error，前端会读后两个
    set_job(
        &st_arc,
        &job_id,
        json!({
            "meta": { "url": url, "source": source },
            "progress": {},
            "result": Value::Null,
            "error": Value::Null,
        }),
    );

    // 后台执行，立刻返回 jobId（前端靠 job_watch 订阅）
    let st2 = Arc::clone(&st_arc);
    let job2 = job_id.clone();
    let body = args.clone();
    tokio::spawn(async move {
        let outcome = run_download(&st2, &job2, &body, &cfg, &source, &target_dir, &url).await;
        match outcome {
            Ok((_files, result, message)) => finish_with_result(&st2, &job2, result, &message),
            Err(e) if e == CANCELED => mark_canceled(&st2, &job2),
            Err(e) => mark_failed(&st2, &job2, &e),
        }
    });

    Ok(json!({ "jobId": job_id }))
}

/// 一次下载的产出：`(文件清单, 写进 job.result 的东西, 给用户看的一句话)`
type DownloadOutcome = (Vec<String>, Value, String);

async fn run_download(
    st: &Arc<super::AppState>,
    job: &str,
    body: &Value,
    cfg: &Value,
    source: &str,
    target_dir: &str,
    url: &str,
) -> Result<DownloadOutcome, String> {
    if source == "bilibili" {
        download_bilibili(st, job, body, cfg, target_dir, url).await
    } else {
        download_ytdlp(st, job, body, cfg, target_dir, url).await
    }
}

/// B 站下载：解析 → 挑流 → 并行下视频与音频 → ffmpeg 合流 → 封面 / 弹幕 / 字幕。
///
/// ⚠️ 每一段「附加内容」（封面、弹幕、字幕）失败都**只记一行日志**、不让整个任务失败 ——
/// 正片下好了才是用户要的，附加内容失败顶多让他少一个文件。
async fn download_bilibili(
    st: &Arc<super::AppState>,
    job: &str,
    body: &Value,
    cfg: &Value,
    target_dir: &str,
    url: &str,
) -> Result<DownloadOutcome, String> {
    let mode = body.get("mode").and_then(|v| v.as_str()).unwrap_or("video");
    let cancel = cancel_flag(st, job);
    let cancel_ref: &net::Cancel = &*cancel;

    let cookie = body
        .get("cookie")
        .and_then(|v| v.as_str())
        .map(String::from)
        .unwrap_or_else(|| {
            cfg.get("bilibiliCookie")
                .and_then(|v| v.as_str())
                .unwrap_or("")
                .to_string()
        });
    let client = Bili::new(&cookie);
    let parsed = client.parse_input(url).await?;
    set_progress(st, job, Some(1.0), Some("解析视频信息…"), json!({}));

    /// 解析出来的这次要下载的东西（分P/番剧两条路各返回一份）
    struct Picked {
        title: String,
        cid: Option<i64>,
        cover: Option<String>,
        bvid: Option<String>,
        aid: Option<i64>,
        ep_id: Option<i64>,
    }

    let picked = if parsed.kind == "bangumi" {
        let info = client
            .get_bangumi_info(parsed.ep_id, parsed.season_id)
            .await?;
        let episodes = info
            .get("episodes")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let want = parsed
            .ep_id
            .or_else(|| info.get("epId").and_then(|v| v.as_i64()));
        let ep = episodes
            .iter()
            .find(|e| e.get("epId").and_then(|v| v.as_i64()) == want)
            .or_else(|| episodes.first());
        let info_title = info.get("title").and_then(|v| v.as_str()).unwrap_or("");
        let ep_title = ep
            .and_then(|e| e.get("title"))
            .and_then(|v| v.as_str())
            .unwrap_or("");
        Picked {
            title: format!("{info_title} {ep_title}").trim().to_string(),
            cid: ep.and_then(|e| e.get("cid")).and_then(|v| v.as_i64()),
            ep_id: ep.and_then(|e| e.get("epId")).and_then(|v| v.as_i64()),
            cover: ep
                .and_then(|e| e.get("cover"))
                .and_then(|v| v.as_str())
                .map(String::from)
                .or_else(|| info.get("cover").and_then(|v| v.as_str()).map(String::from)),
            bvid: None,
            aid: None,
        }
    } else {
        let info = client
            .get_video_info(parsed.bvid.as_deref(), parsed.aid)
            .await?;
        let pages = info
            .get("pages")
            .and_then(|v| v.as_array())
            .cloned()
            .unwrap_or_default();
        let want = body
            .get("page")
            .and_then(|v| v.as_i64())
            .unwrap_or(parsed.page);
        let p = pages
            .iter()
            .find(|x| x.get("page").and_then(|v| v.as_i64()) == Some(want))
            .or_else(|| pages.first())
            .cloned();
        let info_title = info.get("title").and_then(|v| v.as_str()).unwrap_or("");
        Picked {
            title: if pages.len() > 1 {
                format!(
                    "{info_title} P{} {}",
                    p.as_ref()
                        .and_then(|x| x.get("page"))
                        .and_then(|v| v.as_i64())
                        .unwrap_or(1),
                    p.as_ref()
                        .and_then(|x| x.get("title"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                )
            } else {
                info_title.to_string()
            },
            cid: p
                .as_ref()
                .and_then(|x| x.get("cid"))
                .and_then(|v| v.as_i64()),
            bvid: info.get("bvid").and_then(|v| v.as_str()).map(String::from),
            aid: info.get("aid").and_then(|v| v.as_i64()),
            cover: info.get("cover").and_then(|v| v.as_str()).map(String::from),
            ep_id: None,
        }
    };

    let Picked {
        title,
        cid,
        cover,
        bvid,
        aid,
        ep_id,
    } = picked;

    let Some(cid) = cid else {
        return Err("未取得 cid，无法下载".to_string());
    };
    super::jobs::log_job(st, job, &format!("标题：{title}"));

    set_progress(st, job, Some(3.0), Some("获取播放流…"), json!({}));
    let quality = body.get("quality").and_then(|v| v.as_i64()).unwrap_or(127);
    let streams = client
        .get_play_streams(bvid.as_deref(), aid, cid, quality, ep_id)
        .await?;
    if let Some(err) = streams.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }

    let safe = safe_title(&title);
    let threads = threads_of(cfg);
    let mut written: Vec<String> = Vec::new();
    let audio_quality = body.get("audioQuality").and_then(|v| v.as_i64());

    if mode == "audio" {
        let pick = pick_for_audio(&streams, audio_quality)
            .ok_or_else(|| "这条视频没有可用的音频流".to_string())?;
        let dest = joined(target_dir, &format!("{safe}.m4a"));
        let backups = backup_urls(&pick);
        set_progress(st, job, Some(5.0), Some("下载音频…"), json!({}));
        let st_a = Arc::clone(st);
        let job_a = job.to_string();
        let on_audio = move |p: &net::Progress| {
            set_progress(
                &st_a,
                &job_a,
                Some(p.percent * 0.9),
                Some(&format!("音频 {:.1}%", p.percent)),
                json!({ "speedText": format!("{:.2} MB/s", p.speed / 1024.0 / 1024.0) }),
            );
        };
        client
            .download_asset(
                pick.get("url").and_then(|v| v.as_str()).unwrap_or(""),
                Path::new(&dest),
                &backups,
                threads,
                cancel_ref,
                &on_audio,
            )
            .await?;
        written.push(dest.clone());
        super::jobs::log_job(st, job, &format!("已保存：{}", basename(&dest)));
    } else {
        let (video_dest, audio_dest) = {
            let pick = decode_video_pick(&streams, body.get("quality").and_then(|v| v.as_i64()))
                .ok_or_else(|| "这条视频没有可用的视频流".to_string())?;
            let audio_pick = decode_audio_pick(&streams, audio_quality)
                .ok_or_else(|| "这条视频没有可用的音频流".to_string())?;

            let video_dest = joined(target_dir, &format!("{safe}.video.m4s"));
            let audio_dest = joined(target_dir, &format!("{safe}.audio.m4s"));

            let st_v = Arc::clone(st);
            let job_v = job.to_string();
            let on_video = move |p: &net::Progress| {
                set_progress(
                    &st_v,
                    &job_v,
                    Some(p.percent * 0.45),
                    Some(&format!("视频 {:.1}%", p.percent)),
                    json!({ "speedText": format!("{:.2} MB/s", p.speed / 1024.0 / 1024.0) }),
                );
            };
            let st_a = Arc::clone(st);
            let job_a = job.to_string();
            let on_audio = move |p: &net::Progress| {
                set_progress(
                    &st_a,
                    &job_a,
                    Some(50.0 + p.percent * 0.4),
                    Some(&format!("音频 {:.1}%", p.percent)),
                    json!({}),
                );
            };

            let video_backups = backup_urls(&pick);
            let audio_backups = backup_urls(&audio_pick);
            let video_fut = client.download_asset(
                pick.get("url").and_then(|v| v.as_str()).unwrap_or(""),
                Path::new(&video_dest),
                &video_backups,
                threads,
                cancel_ref,
                &on_video,
            );
            let audio_fut = client.download_asset(
                audio_pick.get("url").and_then(|v| v.as_str()).unwrap_or(""),
                Path::new(&audio_dest),
                &audio_backups,
                threads,
                cancel_ref,
                &on_audio,
            );
            let (vr, ar) = tokio::join!(video_fut, audio_fut);
            // 一半失败合并就不可能成；`and` 保留「任一边失败即失败」的原语义
            // （`or` 只在两边都失败时才报错，单边失败会带着缺失的输入进 ffmpeg）。
            // 这两个 .m4s 是中间产物，不进 `written`，删掉免得留成没人认领的垃圾。
            if let Err(e) = vr.and(ar) {
                let _ = std::fs::remove_file(&video_dest);
                let _ = std::fs::remove_file(&audio_dest);
                return Err(e);
            }
            (video_dest, audio_dest)
        };

        // 合并
        let ffmpeg = crate::audio::find_ffmpeg(&st.root);
        let mp4_dest = joined(target_dir, &format!("{safe}.mp4"));
        if ffmpeg.is_some() {
            /* 下载阶段最后那个速率/剩余还挂在 progress 上，不清就会一直显示在
               合并这几分钟里；显式传 null 走上面的删除分支。 */
            set_progress(
                st,
                job,
                Some(92.0),
                Some("合并音视频…"),
                json!({"speedText": null, "etaText": null, "eta": null}),
            );
            let merge = crate::audio::run_ffmpeg(
                &st.root,
                &[
                    "-i".into(),
                    video_dest.clone(),
                    "-i".into(),
                    audio_dest.clone(),
                    "-c".into(),
                    "copy".into(),
                    "-movflags".into(),
                    "+faststart".into(),
                    mp4_dest.clone(),
                ],
                0.0,
                cancel_ref,
                &|_, _| {},
            )
            .await;
            match merge {
                Ok(()) => {
                    let _ = std::fs::remove_file(&video_dest);
                    let _ = std::fs::remove_file(&audio_dest);
                    written.push(mp4_dest.clone());
                    super::jobs::log_job(st, job, &format!("已合并输出：{}", basename(&mp4_dest)));
                }
                Err(e) if e == CANCELED => {
                    // 中间产物不进 `written`，不删就成了没人认领的几个 GB
                    let _ = std::fs::remove_file(&video_dest);
                    let _ = std::fs::remove_file(&audio_dest);
                    return Err(e);
                }
                Err(e) => {
                    super::jobs::log_job(
                        st,
                        job,
                        &format!("⚠ 合并失败（{e}），已保留分离的音视频流"),
                    );
                    written.push(video_dest.clone());
                    written.push(audio_dest.clone());
                }
            }
        } else {
            super::jobs::log_job(
                st,
                job,
                "⚠ 未安装 ffmpeg，已保留分离的视频流与音频流；安装 ffmpeg 后可自动合并为 mp4",
            );
            written.push(video_dest.clone());
            written.push(audio_dest.clone());
        }
    }

    // 封面
    if body
        .get("downloadCover")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        if let Some(cover) = cover.filter(|c| !c.is_empty()) {
            let dest = joined(target_dir, &format!("{safe}.jpg"));
            match client
                .download_asset(&cover, Path::new(&dest), &[], 1, cancel_ref, &|_| {})
                .await
            {
                Ok(_) => {
                    written.push(dest.clone());
                    super::jobs::log_job(st, job, &format!("已保存封面：{}", basename(&dest)));
                }
                Err(e) => super::jobs::log_job(st, job, &format!("⚠ 封面下载失败：{e}")),
            }
        }
    }

    // 弹幕
    if body
        .get("downloadDanmaku")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        match client.get_danmaku_xml(cid).await {
            Ok(xml) => {
                let dest = joined(target_dir, &format!("{safe}.danmaku.xml"));
                if let Err(e) = std::fs::write(&dest, xml) {
                    super::jobs::log_job(st, job, &format!("⚠ 弹幕下载失败：{e}"));
                } else {
                    written.push(dest.clone());
                    super::jobs::log_job(st, job, &format!("已保存弹幕：{}", basename(&dest)));
                }
            }
            Err(e) => super::jobs::log_job(st, job, &format!("⚠ 弹幕下载失败：{e}")),
        }
    }

    // 字幕
    if body
        .get("downloadSubs")
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
    {
        match client.get_subtitles(bvid.as_deref(), aid, cid).await {
            Ok(subs) => {
                if subs.is_empty() {
                    super::jobs::log_job(st, job, "该视频没有官方字幕");
                }
                for s in &subs {
                    let url = s.get("url").and_then(|v| v.as_str()).unwrap_or("");
                    let lan = s.get("lan").and_then(|v| v.as_str()).unwrap_or("");
                    let lan_doc = s.get("lanDoc").and_then(|v| v.as_str()).unwrap_or("");
                    match net::fetch_bytes(url, net::headers(&[]), 20).await {
                        Ok(bytes) => {
                            let text = String::from_utf8_lossy(&bytes).to_string();
                            // `lan` 来自 B 站接口、没过任何清洗，带 `/` 或 `..` 时
                            // 目标就落到输出目录外面去了
                            let tag = if lan.is_empty() {
                                "unknown".to_string()
                            } else {
                                safe_title(lan)
                            };
                            let dest = joined(target_dir, &format!("{safe}.{tag}.srt"));
                            // 写失败不能当成功报：`files` 里推一个不存在的路径，
                            // 用户按提示去找是找不到的（同函数的弹幕分支就分了 Err）
                            if let Err(e) = std::fs::write(&dest, bcc_to_srt(&text)) {
                                super::jobs::log_job(st, job, &format!("⚠ 字幕保存失败：{e}"));
                            } else {
                                written.push(dest.clone());
                                super::jobs::log_job(
                                    st,
                                    job,
                                    &format!("已保存字幕：{}（{lan_doc}）", basename(&dest)),
                                );
                            }
                        }
                        Err(e) => super::jobs::log_job(st, job, &format!("⚠ 字幕下载失败：{e}")),
                    }
                }
            }
            Err(e) => super::jobs::log_job(st, job, &format!("⚠ 字幕下载失败：{e}")),
        }
    }

    let message = format!("下载完成：{} 个文件", written.len());
    Ok((
        written.clone(),
        json!({ "files": written, "title": title, "dir": target_dir }),
        message,
    ))
}

/// 其它站点：整段交给 yt-dlp（它自己挑流、自己合并、自己嵌字幕）。
async fn download_ytdlp(
    st: &Arc<super::AppState>,
    job: &str,
    body: &Value,
    cfg: &Value,
    target_dir: &str,
    url: &str,
) -> Result<DownloadOutcome, String> {
    set_progress(st, job, Some(1.0), Some("yt-dlp 启动中…"), json!({}));
    let cancel = cancel_flag(st, job);

    let proxy = cfg
        .get("proxy")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let opts = ytdlp::DlOptions {
        out_dir: target_dir,
        mode: body.get("mode").and_then(|v| v.as_str()).unwrap_or("video"),
        format_id: body.get("formatId").and_then(|v| v.as_str()),
        convert_to: body.get("convertTo").and_then(|v| v.as_str()),
        embed_subs: body
            .get("downloadSubs")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        proxy,
        cookies_from_browser: body.get("cookiesFromBrowser").and_then(|v| v.as_str()),
    };

    let st2 = Arc::clone(st);
    let job2 = job.to_string();
    let on_progress = move |p: &ytdlp::DlProgress| {
        if p.percent >= 0.0 {
            set_progress(
                &st2,
                &job2,
                Some(p.percent),
                Some(&format!("{} {:.1}%", p.stage, p.percent)),
                json!({ "speedText": p.speed, "etaText": p.eta }),
            );
        } else {
            let line: String = p.line.chars().take(120).collect();
            set_progress(&st2, &job2, None, Some(&line), json!({}));
        }
    };

    let files = ytdlp::download(&st.root, url, &opts, &*cancel, &on_progress).await?;
    let message = format!("下载完成：{} 个文件", files.len());
    Ok((
        files.clone(),
        json!({ "files": files, "dir": target_dir }),
        message,
    ))
}

/// 「仅音频」模式下挑音频流。
///
/// 单独一个函数是因为 `decode_audio_pick` 在**整段流**（durl）时回 `None` ——
/// 那时音频就在视频流里，没有独立音轨，所以这条要退回视频流本身（它带着声音）。
fn pick_for_audio(streams: &Value, audio_quality: Option<i64>) -> Option<Value> {
    decode_audio_pick(streams, audio_quality).or_else(|| decode_video_pick(streams, None))
}

/// 用户配置里的下载线程数（1..=16）。
fn threads_of(cfg: &Value) -> usize {
    cfg.get("threads")
        .and_then(|v| v.as_u64())
        .unwrap_or(4)
        .max(1) as usize
}

fn joined(dir: &str, name: &str) -> String {
    PathBuf::from(dir).join(name).to_string_lossy().to_string()
}

/* ══════════════════════════════ 音频工具 ══════════════════════════════ */

/// 探一个本地媒体的信息（时长 / 采样率 / 声道 / 编码）。`{ input }`
#[tauri::command]
pub async fn audio_probe(st: super::St<'_>, input: String) -> Cmd {
    if input.is_empty() || !Path::new(&input).exists() {
        return Err("文件不存在".into());
    }
    let info = crate::audio::probe_media(&st.inner().root, &input).await;
    Ok(json!({ "info": info }))
}

/// 提交一次音频处理（转格式 / 提取 / 变调 / 变速 / 裁剪 / 响度）。
///
/// `{ action, input, output, options? }` → `{ jobId }`。立刻返回，进度走 `job_watch`。
///
/// `options` 里同名的键会**覆盖**外层（等价于 `{ input, output, ...options }`）。
#[tauri::command]
pub async fn audio_run(st: super::St<'_>, args: Value) -> Cmd {
    let action = args
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let input = args
        .get("input")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if input.is_empty() {
        return Err("缺少输入文件".into());
    }

    let st_arc: Arc<super::AppState> = st.inner().clone();
    let job_id = new_job(&st_arc, "audio", &format!("音频处理：{action}"));
    set_job(
        &st_arc,
        &job_id,
        json!({ "progress": {}, "result": Value::Null, "error": Value::Null }),
    );

    // options 里同名的键覆盖外层（`{ input, output, ...options }`）
    let mut merged = Map::new();
    merged.insert(
        "input".into(),
        args.get("input").cloned().unwrap_or(json!("")),
    );
    merged.insert(
        "output".into(),
        args.get("output").cloned().unwrap_or(json!("")),
    );
    if let Some(opts) = args.get("options").and_then(|v| v.as_object()) {
        for (k, v) in opts {
            merged.insert(k.clone(), v.clone());
        }
    }

    let st2 = Arc::clone(&st_arc);
    let job2 = job_id.clone();
    tokio::spawn(async move {
        set_progress(&st2, &job2, Some(2.0), Some("处理中…"), json!({}));
        let cancel = cancel_flag(&st2, &job2);
        let cancel_ref: &net::Cancel = &*cancel;

        let st3 = Arc::clone(&st2);
        let job3 = job2.clone();
        let on_progress = move |percent: f64, _sec: f64| {
            set_progress(
                &st3,
                &job3,
                Some(percent),
                Some(&format!("处理中 {percent:.0}%")),
                json!({}),
            );
        };

        let root = st2.root.clone();
        let result = match action.as_str() {
            "convert" => {
                crate::audio::convert_audio(&root, &merged, cancel_ref, &on_progress).await
            }
            "extract" => {
                crate::audio::extract_audio(&root, &merged, cancel_ref, &on_progress).await
            }
            "pitch" => crate::audio::shift_pitch(&root, &merged, cancel_ref, &on_progress).await,
            "tempo" => crate::audio::change_tempo(&root, &merged, cancel_ref, &on_progress).await,
            "trim" => crate::audio::trim_audio(&root, &merged, cancel_ref, &on_progress).await,
            "normalize" => {
                crate::audio::normalize_loudness(&root, &merged, cancel_ref, &on_progress).await
            }
            _ => Err(format!("未知的音频操作：{action}")),
        };

        match result {
            Ok(value) => {
                let output = merged
                    .get("output")
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string();
                finish_with_result(&st2, &job2, value, &format!("完成：{}", basename(&output)));
            }
            Err(e) if e == CANCELED => mark_canceled(&st2, &job2),
            Err(e) => mark_failed(&st2, &job2, &e),
        }
    });

    Ok(json!({ "jobId": job_id }))
}

/* ══════════════════════════════ 流选择（纯数据） ══════════════════════════════ */

/// 一个流自己带的备用地址（B 站会给好几条 CDN，主地址挂了就换）
pub fn backup_urls(pick: &Value) -> Vec<String> {
    pick.get("backupUrls")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

/// 从解析结果里挑一条视频流。
///
/// 两种形态：`mode == "durl"`（整段流，只有 `streams[0]`）与 DASH（`video[]` 列表）。
/// 给了 `quality` 就精确找那一条，找不到就退回**列表第一条**（B 站给的是从高到低）。
pub fn decode_video_pick(streams: &Value, quality: Option<i64>) -> Option<Value> {
    if streams.get("mode").and_then(|v| v.as_str()) == Some("durl") {
        return streams
            .get("streams")
            .and_then(|v| v.as_array())
            .and_then(|a| a.first())
            .cloned();
    }
    let list = streams.get("video").and_then(|v| v.as_array())?;
    if list.is_empty() {
        return None;
    }
    if let Some(q) = quality {
        if let Some(exact) = list
            .iter()
            .find(|v| v.get("id").and_then(|x| x.as_i64()) == Some(q))
        {
            return Some(prefer_avc(list, exact));
        }
    }
    // 默认取最高画质，优先 H.264
    Some(prefer_avc(list, &list[0]))
}

/// 同画质下优先 AVC，避免 HEVC 在老编辑器/播放器里打不开。
fn prefer_avc(list: &[Value], target: &Value) -> Value {
    let id = target.get("id").and_then(|v| v.as_i64());
    list.iter()
        .filter(|v| v.get("id").and_then(|x| x.as_i64()) == id)
        .find(|v| {
            let c = v
                .get("codecs")
                .and_then(|x| x.as_str())
                .unwrap_or("")
                .to_lowercase();
            c.contains("avc") || c.contains("h264")
        })
        .cloned()
        .unwrap_or_else(|| target.clone())
}

/// 从解析结果里挑一条音频流。
///
/// 默认取 **192K**（id `30280`）而不是 Hi-Res：兼容性更好且体积合理。
/// `durl` 形态没有独立音轨，回 `None`。
pub fn decode_audio_pick(streams: &Value, audio_quality: Option<i64>) -> Option<Value> {
    if streams.get("mode").and_then(|v| v.as_str()) == Some("durl") {
        return None;
    }
    let list = streams.get("audio").and_then(|v| v.as_array())?;
    if list.is_empty() {
        return None;
    }
    if let Some(q) = audio_quality {
        if let Some(exact) = list
            .iter()
            .find(|a| a.get("id").and_then(|x| x.as_i64()) == Some(q))
        {
            return Some(exact.clone());
        }
    }
    Some(
        list.iter()
            .find(|a| a.get("id").and_then(|x| x.as_i64()) == Some(30280))
            .cloned()
            .unwrap_or_else(|| list[0].clone()),
    )
}

/// B 站字幕 JSON（`.bcc`）→ SRT。
///
/// 解析不了就**原样返回**：上游偶尔直接给 SRT，那时它已经是目标格式了。
pub fn bcc_to_srt(json_text: &str) -> String {
    let Ok(data) = serde_json::from_str::<Value>(json_text) else {
        return json_text.to_string();
    };
    let body = data
        .get("body")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();
    body.iter()
        .enumerate()
        .map(|(i, item)| {
            let from = item.get("from").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let to = item.get("to").and_then(|v| v.as_f64()).unwrap_or(0.0);
            let content = item.get("content").and_then(|v| v.as_str()).unwrap_or("");
            format!(
                "{}\n{} --> {}\n{}\n",
                i + 1,
                srt_time(from),
                srt_time(to),
                content
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// 秒 → `HH:MM:SS,mmm`（SRT 的时间格式，**逗号**不是点）。
///
/// ⚠️ 先折成整毫秒再拆位：按分量各自取整时，小数部分 ≥ 0.9995 会算出 `,1000`，
/// 既不是合法 SRT（毫秒必须 < 1000）也不会向秒进位，这条字幕在严格播放器上不显示。
fn srt_time(sec: f64) -> String {
    let total_ms = (sec.max(0.0) * 1000.0).round() as i64;
    let ms = total_ms % 1000;
    let total_s = total_ms.div_euclid(1000);
    let s = total_s % 60;
    let m = (total_s / 60) % 60;
    let h = total_s / 3600;
    format!("{h:02}:{m:02}:{s:02},{ms:03}")
}

#[cfg(test)]
mod pick_tests {
    use super::*;

    #[test]
    fn srt_timestamps_match_the_node_formatting() {
        assert_eq!(srt_time(0.0), "00:00:00,000");
        assert_eq!(srt_time(1.5), "00:00:01,500");
        assert_eq!(srt_time(3723.456), "01:02:03,456");
        // 小数部分 ≥ 0.9995：按分量各自取整会算出 ,1000，那不是合法 SRT
        assert_eq!(srt_time(5.9997), "00:00:06,000");
        assert_eq!(srt_time(119.9996), "00:02:00,000");
    }

    #[test]
    fn bcc_json_becomes_srt_and_bad_json_passes_through() {
        let srt = bcc_to_srt(r#"{"body":[{"from":0.5,"to":2.25,"content":"你好"}]}"#);
        assert!(srt.contains("00:00:00,500 --> 00:00:02,250"));
        assert!(srt.contains("你好"));
        // 上游直接给了 SRT（不是 JSON）时原样返回
        let already = "1\n00:00:00,000 --> 00:00:01,000\nx";
        assert_eq!(bcc_to_srt(already), already);
    }

    #[test]
    fn picks_avc_over_hevc_at_the_same_quality() {
        let streams = json!({
            "video": [
                { "id": 80, "codecs": "hev1.1.6.L120.90", "qualityName": "1080P" },
                { "id": 80, "codecs": "avc1.640032", "qualityName": "1080P" },
                { "id": 64, "codecs": "avc1.640028", "qualityName": "720P" },
            ]
        });
        let pick = decode_video_pick(&streams, Some(80)).unwrap();
        assert_eq!(pick["codecs"], "avc1.640032");
        // 不指定画质 → 第一条那一档，但同档里仍优先 AVC
        let pick = decode_video_pick(&streams, None).unwrap();
        assert_eq!(pick["codecs"], "avc1.640032");
    }

    #[test]
    fn durl_and_dash_shapes_are_both_understood() {
        // 整段流：只有 streams[0]，没有独立音轨
        let durl = json!({ "mode": "durl", "streams": [{ "url": "u", "size": 1 }] });
        assert!(decode_video_pick(&durl, None).is_some());
        assert!(decode_audio_pick(&durl, None).is_none());

        // DASH：默认音频取 192K（30280），不是列表第一条 Hi-Res
        let dash = json!({
            "video": [{ "id": 80, "codecs": "avc1" }],
            "audio": [
                { "id": 30250, "qualityName": "杜比全景声" },
                { "id": 30280, "qualityName": "192K" },
            ]
        });
        assert_eq!(decode_audio_pick(&dash, None).unwrap()["id"], 30280);
        assert_eq!(decode_audio_pick(&dash, Some(30250)).unwrap()["id"], 30250);
    }
}

/* ══════════════════════════════ 预览缓存 ══════════════════════════════ */

/// 预览缓存目录：`<app cache>/preview/`。
///
/// 用 `app_cache_dir()` 而不是程序的 writable 目录：这是**可再生的临时数据**，
/// 删掉只会导致「下次再看要重新缓存」，不该和配置、产物混在一起。
fn cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("拿不到缓存目录：{e}"))?;
    Ok(base.join("preview"))
}

/// 把一条远端直链缓存成本机文件，回它的路径。
///
/// `preview_fetch` 的临时文件序号 —— 同一 URL 的两次并发各写各的，见该函数里 `part` 的注释。
static PREVIEW_SEQ: AtomicU64 = AtomicU64::new(0);

/// 返回 `{ path, bytes, cached }`：`cached = true` 表示这次没下载（文件已存在）。
/// 前端拿到 `path` 之后 `convertFileSrc(path)` 就能喂给 `<video>`。
///
/// ⚠️ 只接受**本进程解析结果里出现过的主机**（`remember_hosts` / `SEEN_HOSTS`）。
/// 这条限制要留着：命令能被任何前端代码调用，而「把任意 URL 落盘」是一个数据外带口子。
#[tauri::command]
pub async fn preview_fetch(app: tauri::AppHandle, url: String, src: Option<String>) -> Cmd {
    let url = url.trim().to_string();
    if url.is_empty() {
        return Err("缺少 url".into());
    }
    let parsed = reqwest::Url::parse(&url).map_err(|_| "url 不是合法地址".to_string())?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("只缓存 http/https".into());
    }
    let host = parsed.host_str().unwrap_or("").to_lowercase();
    if !is_known_host(&host) {
        return Err(format!(
            "这个域名不在预览白名单里（先解析一次再预览）：{host}"
        ));
    }

    let dir = cache_dir(&app)?;
    tokio::fs::create_dir_all(&dir)
        .await
        .map_err(|e| format!("建缓存目录失败：{e}"))?;
    // 放行给 asset 协议 —— 漏了这一步，前端 `<video>` 静默 403。scope 是进程内状态，
    // 所以每条返回路径（含命中早退）都要走这一步：重启后第一次预览命中缓存时，
    // 早退不放行就是 403
    let _ = app.asset_protocol_scope().allow_directory(&dir, true);
    let name = format!("{}-{}", short_hash(&url), ext_hint(&parsed));
    let dest = dir.join(format!("{name}.bin"));

    if let Ok(md) = tokio::fs::metadata(&dest).await {
        if md.len() > 0 {
            let _ = touch(&dest).await;
            return Ok(json!({
                "path": crate::platform::clean_path(&dest),
                "bytes": md.len(),
                "cached": true,
            }));
        }
    }

    /* 字节写进 `part`，整份下完才改名成 `dest`。命中判据只有「`dest` 非空」且在**下载
    之前**就返回，所以 `dest` 只能在下完之后出现 —— 直接写 `dest` 的话，进程被杀留下的
    半截文件会被永久当成完整缓存，命中了也播不动，再点多少次都不会重下（失败路径有
    `give_up` 清理，被杀这条没有）。
    序号让同一 URL 的并发预览各写各的文件：共用一个 `part` 时，后启动的那次会先删掉
    前一次写到一半的文件，改名就可能把半截提拔成缓存。被杀留下的 `part` 命中判据看不见，
    由 LRU 按 1GB 上限和「清空缓存」清理。 */
    let seq = PREVIEW_SEQ.fetch_add(1, Ordering::Relaxed);
    let part = dir.join(format!("{name}.{seq}.part"));

    let src = src.unwrap_or_else(|| "bilibili".into());
    // 参考来源不同，Referer/Origin 不同（B 站校验这个，漏了就 403）
    let hdrs: Vec<(&str, &str)> = if src == "ytdlp" {
        vec![("Referer", "https://www.youtube.com/")]
    } else {
        vec![
            ("Referer", "https://www.bilibili.com/"),
            ("Origin", "https://www.bilibili.com"),
        ]
    };

    /* 边收边写：一支 1080P 的 MV 几百 MB，**不能** `.bytes().await` 全收进内存。
    ⚠️ **实现不在这个文件里** —— 所有「URL → 盘上文件」都走 `crate::download`。

    这个调用方需要的最小配置：单流、不续传、不重试（直链过期换链接是上层的事）、
    无进度（前台没显示条子）。 */
    let req = crate::download::Request {
        url: parsed.as_str(),
        label: "预览",
        part: &part,
        headers: &hdrs,
        shape: crate::download::Shape::Plain,
        client: crate::download::default_client(),
        retry: crate::download::Retry::NONE,
        expect: None,
    };
    // 前台没有取消按钮（预览是用户主动点的、几百 MB 的缓存）
    let ctl = crate::download::Control::new(|| false, || false);
    let total = match crate::download::download(&req, &ctl, &|_, _, _| {}).await {
        Ok(crate::download::Outcome::Done { bytes }) => bytes,
        Ok(_) => 0,
        /* 失败时**不用**自己删半截缓存 —— 引擎按 `Shape::Plain` 一并清了
        （它会连带删掉「下到一半」的文件，见 `download::give_up`）。 */
        Err(e) => return Err(e),
    };
    if total == 0 {
        /* 空文件是 `Done { bytes: 0 }`（不是失败），引擎按「下完了」正常返回，
        `give_up` 不会替我们删。改名只对非空文件做，所以这个 `part` 永远进不了
        命中判据，但留着白占 LRU 额度。 */
        let _ = tokio::fs::remove_file(&part).await;
        /* `.part.url` 记号只有可续传的形状才写（`Plain` 本来不该有），part 走不到改名
        就连它一起清 —— 同 `give_up` 对 `Plain` 的处理 */
        let _ = tokio::fs::remove_file(crate::download::url_marker(&part)).await;
        return Err("上游回了个空文件".into());
    }

    /* 改名才是「下好了」的那一刻：命中判据是「`dest` 非空」且在**下载之前**就返回，
    所以 `dest` 只能在这一步之后出现。改名会替换掉已存在的目标（Unix rename /
    Windows MoveFileExW），所以同一 URL 的两次并发各自落盘、后到的那份整份覆盖前一份，
    留在盘上的永远是完整文件。 */
    if let Err(e) = tokio::fs::rename(&part, &dest).await {
        let _ = tokio::fs::remove_file(&part).await;
        let _ = tokio::fs::remove_file(crate::download::url_marker(&part)).await;
        return Err(format!("缓存改名失败：{e}"));
    }
    let _ = tokio::fs::remove_file(crate::download::url_marker(&part)).await;

    // 顺手做一次 LRU 清理（不 await 结果：清不掉只是占点磁盘，不该让预览失败）
    let dir2 = dir.clone();
    tokio::task::spawn_blocking(move || evict(&dir2, CACHE_LIMIT));

    let bytes = tokio::fs::metadata(&dest)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    Ok(json!({
        "path": crate::platform::clean_path(&dest),
        "bytes": bytes,
        "cached": false,
    }))
}

/// 清掉整个预览缓存。回删掉多少字节。
#[tauri::command]
pub async fn preview_clear(app: tauri::AppHandle) -> Cmd {
    let dir = cache_dir(&app)?;
    let freed = tokio::task::spawn_blocking(move || {
        let mut total = 0u64;
        if let Ok(rd) = std::fs::read_dir(&dir) {
            for e in rd.flatten() {
                if let Ok(md) = e.metadata() {
                    total += md.len();
                }
                let _ = std::fs::remove_file(e.path());
            }
        }
        total
    })
    .await
    .unwrap_or(0);
    Ok(json!({ "freedBytes": freed }))
}

/* ────────────────────────────────── 白名单 ────────────────────────────────── */

/// 本进程解析结果里出现过的主机。
///
/// 为什么不写死一张域名表：B 站的直链会落在 PCDN 域名上，每个视频一个
/// （`*.edge.mountaintoys.cn`），yt-dlp 那边更是任何站点都可能有自己的 CDN ——
/// 写死后缀永远追不上。而「本程序自己刚解析出来的地址」天然可信。
static SEEN_HOSTS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();
const SEEN_HOSTS_MAX: usize = 512;

fn seen_hosts() -> &'static Mutex<HashSet<String>> {
    SEEN_HOSTS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn remember_hosts(v: &Value) {
    let mut found: Vec<String> = Vec::new();
    collect_hosts(v, &mut found);
    if found.is_empty() {
        return;
    }
    if let Ok(mut set) = seen_hosts().lock() {
        if set.len() + found.len() > SEEN_HOSTS_MAX {
            set.clear();
        }
        set.extend(found);
    }
}

fn is_known_host(host: &str) -> bool {
    if host.is_empty() {
        return false;
    }
    seen_hosts()
        .lock()
        .map(|set| set.contains(host))
        .unwrap_or(false)
}

/// 递归扫所有字符串、**不按字段名过滤**：直链会出现在 `streams.video[].url`、
/// `backupUrls[]`、`formats[].url`、`durl.streams[].url` 这些完全不同的位置，
/// 按字段名挑很容易漏一条。扫到的封面地址也无害（同一个 CDN）。
fn collect_hosts(v: &Value, out: &mut Vec<String>) {
    match v {
        Value::String(s) => {
            if let Ok(u) = reqwest::Url::parse(s) {
                if matches!(u.scheme(), "http" | "https") {
                    if let Some(h) = u.host_str() {
                        out.push(h.to_lowercase());
                    }
                }
            }
        }
        Value::Array(a) => a.iter().for_each(|x| collect_hosts(x, out)),
        Value::Object(m) => m.values().for_each(|x| collect_hosts(x, out)),
        _ => {}
    }
}

/* ────────────────────────────────── 小工具 ────────────────────────────────── */

/// 缓存文件名用 URL 的短哈希 —— 直链里有签名参数，名字里带不了。
fn short_hash(s: &str) -> String {
    net::md5_hex(s.as_bytes())[..16].to_string()
}

/// 从地址里猜个扩展名，纯粹为了缓存文件好认（不影响播放：MIME 由 asset 协议按扩展名给）。
fn ext_hint(u: &reqwest::Url) -> &'static str {
    let path = u.path().to_lowercase();
    if path.ends_with(".mp4") {
        "mp4"
    } else if path.ends_with(".m4a") || path.ends_with(".mp3") {
        "m4a"
    } else if path.ends_with(".webm") {
        "webm"
    } else if path.ends_with(".flv") {
        "flv"
    } else {
        "bin"
    }
}

/// 碰一下文件（读一个字节），让 mtime 跟上 —— LRU 按 mtime 排。
async fn touch(p: &Path) -> std::io::Result<()> {
    let _ = tokio::fs::read(p).await?;
    Ok(())
}

/// 超上限就按 mtime 从旧到新删。
///
/// 同步函数（`spawn_blocking` 里跑）：它只读目录元数据 + 删文件，很快，
/// 而 `std::fs` 在这里比 `tokio::fs` 直白。
fn evict(dir: &Path, limit: u64) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = rd
        .flatten()
        .filter_map(|e| {
            let md = e.metadata().ok()?;
            if !md.is_file() {
                return None;
            }
            Some((md.modified().ok()?, md.len(), e.path()))
        })
        .collect();
    let mut total: u64 = files.iter().map(|(_, n, _)| *n).sum();
    if total <= limit {
        return;
    }
    files.sort_by_key(|(t, _, _)| *t);
    for (_, n, p) in files {
        if total <= limit {
            break;
        }
        if std::fs::remove_file(&p).is_ok() {
            total = total.saturating_sub(n);
        }
    }
}
