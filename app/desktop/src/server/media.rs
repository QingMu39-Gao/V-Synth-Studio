//! 阶段 4：视频解析 / 下载 / 音频处理
//!
//! 4 个路由：`video/parse`、`video/download`、`audio/probe`、`audio/run`。
//! 实现是 Node 版（`app/server/index.mjs` + `net/*.mjs` + `core/audio.mjs`）的逐行移植，
//! 响应形状以 `tests/contract/fixtures/` 里的真实抓包为准。
//!
//! 错误响应的 HTTP 状态码也照抄 Node：那边统一 500（body 是 `{ok:false,error,code:null}`），
//! 前端只看 body 里的 ok/error，所以状态码保持 500 是最不容易出岔子的选择。

use std::path::{Path, PathBuf};
use std::sync::Arc;

use axum::extract::State;
use axum::Json;
use serde_json::{json, Map, Value};

use super::convert::{log_job, new_job, set_job};
use super::{ok, ApiError, AppState};
use crate::audio::{self, CANCELED};
use crate::bili::{safe_title, Bili};
use crate::net;
use crate::ytdlp;

/* ══════════════════════════════════ 任务小工具 ══════════════════════════════════ */

/// 任务当前状态（取消就是靠它传递的：没有额外的取消通道）
fn job_status(st: &Arc<AppState>, id: &str) -> String {
    let guard = match st.jobs.lock() {
        Ok(g) => g,
        Err(_) => return String::new(),
    };
    guard
        .items
        .get(id)
        .and_then(|j| j.get("status"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

/// 取消标志：把「任务表里状态变成 canceled」变成一个可传给下载/子进程的闭包
fn cancel_flag(st: &Arc<AppState>, id: &str) -> Arc<net::Cancel> {
    let st = st.clone();
    let id = id.to_string();
    Arc::new(move || job_status(&st, &id) == "canceled")
}

/// 对应 Node 的 jobs.setProgress：percent/message 直接改，其余字段并进 progress 里。
/// （前端读的是 `job.progress.speedText`，所以额外字段必须放在 progress 下面。）
fn set_progress(st: &Arc<AppState>, id: &str, percent: Option<f64>, message: Option<&str>, extra: Value) {
    let Ok(mut guard) = st.jobs.lock() else { return };
    let Some(job) = guard.items.get_mut(id) else {
        return;
    };
    let Some(m) = job.as_object_mut() else { return };
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
    let prog = m.entry("progress").or_insert_with(|| json!({}));
    if let (Some(pm), Some(ex)) = (prog.as_object_mut(), extra.as_object()) {
        for (k, v) in ex {
            pm.insert(k.clone(), v.clone());
        }
    }
}

/// 对应 Node 的 jobs.fail
fn fail_job(st: &Arc<AppState>, id: &str, error: &str) {
    set_job(
        st,
        id,
        json!({ "status": "error", "error": error, "message": error }),
    );
}

/// 对应 Node 的 jobs.cancel
fn cancel_job(st: &Arc<AppState>, id: &str) {
    set_job(
        st,
        id,
        json!({ "status": "canceled", "message": "已取消" }),
    );
}

/// 对应 Node 的 jobs.finish（比 convert 用的 finish_job 多了 result）
fn finish_with_result(st: &Arc<AppState>, id: &str, result: Value, message: &str) {
    set_job(
        st,
        id,
        json!({ "status": "done", "percent": 100, "message": message, "result": result }),
    );
}

fn threads_of(cfg: &Value) -> usize {
    cfg.get("threads").and_then(|v| v.as_u64()).unwrap_or(4).max(1) as usize
}

fn basename(p: &str) -> String {
    Path::new(p)
        .file_name()
        .map(|n| n.to_string_lossy().to_string())
        .unwrap_or_default()
}

fn joined(dir: &str, name: &str) -> String {
    PathBuf::from(dir).join(name).to_string_lossy().to_string()
}

/* ══════════════════════════════════ POST /api/video/parse ══════════════════════════════════ */

pub async fn video_parse(
    State(st): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let raw = body
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if raw.is_empty() {
        return Err(ApiError::internal("请输入视频链接"));
    }

    let cfg = st.config_snapshot();

    // B 站走原生解析
    if crate::bili::is_bilibili(&raw) {
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
        let parsed = client.parse_input(&raw).await.map_err(ApiError::internal)?;

        if parsed.kind == "bangumi" {
            let info = client
                .get_bangumi_info(parsed.ep_id, parsed.season_id)
                .await
                .map_err(ApiError::internal)?;
            let mut streams = Value::Null;
            if let Some(cid) = info.get("cid").and_then(|v| v.as_i64()) {
                let ep_id = info.get("epId").and_then(|v| v.as_i64());
                streams = match client.get_play_streams(None, None, cid, 127, ep_id).await {
                    Ok(s) => s,
                    Err(e) => json!({ "error": e }),
                };
            }
            return Ok(Json(ok(json!({
                "source": "bilibili",
                "kind": "bangumi",
                "info": info,
                "streams": streams,
                "hasCookie": client.has_login(),
            }))));
        }

        let info = client
            .get_video_info(parsed.bvid.as_deref(), parsed.aid)
            .await
            .map_err(ApiError::internal)?;
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
        if let Some(cid) = page.as_ref().and_then(|p| p.get("cid")).and_then(|v| v.as_i64()) {
            let bvid = info.get("bvid").and_then(|v| v.as_str()).map(String::from);
            streams = match client.get_play_streams(bvid.as_deref(), None, cid, 127, None).await {
                Ok(s) => s,
                Err(e) => json!({ "error": e }),
            };
        }

        // currentPage 在没有分P时是 undefined —— Node 那里会被 JSON.stringify 丢掉
        let mut out = Map::new();
        out.insert("source".into(), json!("bilibili"));
        out.insert("kind".into(), json!("video"));
        out.insert("info".into(), info);
        if let Some(p) = page {
            out.insert("currentPage".into(), p);
        }
        out.insert("streams".into(), streams);
        out.insert("hasCookie".into(), json!(client.has_login()));
        return Ok(Json(ok(Value::Object(out))));
    }

    // 其它站点交给 yt-dlp
    let proxy = cfg
        .get("proxy")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty());
    let info = ytdlp::inspect(&st.tools_dir(), &raw, proxy, None)
        .await
        .map_err(ApiError::internal)?;
    Ok(Json(ok(json!({
        "source": "ytdlp",
        "kind": "video",
        "info": info,
    }))))
}

/* ══════════════════════════════════ POST /api/video/download ══════════════════════════════════ */

pub async fn video_download(
    State(st): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let url = body
        .get("url")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if url.is_empty() {
        return Err(ApiError::internal("缺少视频链接"));
    }

    let source = body
        .get("source")
        .and_then(|v| v.as_str())
        .unwrap_or("bilibili")
        .to_string();
    let cfg = st.config_snapshot();
    let target_dir = body
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
    std::fs::create_dir_all(&target_dir).map_err(ApiError::from)?;

    let title = format!("下载 {}", url.chars().take(60).collect::<String>());
    let job_id = new_job(&st, "download", &title, &source);
    // Node 的任务对象还带 meta / progress / result / error，前端会读后三个
    set_job(
        &st,
        &job_id,
        json!({
            "meta": { "url": url, "source": source },
            "progress": {},
            "result": Value::Null,
            "error": Value::Null,
        }),
    );

    // 后台执行，立刻返回 jobId（和 Node 版一致，前端靠 watchJob 订阅）
    let st2 = st.clone();
    let job2 = job_id.clone();
    tokio::spawn(async move {
        let outcome = run_download(&st2, &job2, &body, &cfg, &source, &target_dir, &url).await;
        match outcome {
            Ok((files, result, message)) => {
                let _ = files;
                finish_with_result(&st2, &job2, result, &message);
            }
            Err(e) if e == CANCELED => cancel_job(&st2, &job2),
            Err(e) => fail_job(&st2, &job2, &e),
        }
    });

    Ok(Json(ok(json!({ "jobId": job_id }))))
}

type DownloadOutcome = (Vec<String>, Value, String);

async fn run_download(
    st: &Arc<AppState>,
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

async fn download_bilibili(
    st: &Arc<AppState>,
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
            cid: p.as_ref().and_then(|x| x.get("cid")).and_then(|v| v.as_i64()),
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
    log_job(st, job, &format!("标题：{title}"));

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
        let pick = decode_audio_pick(&streams, audio_quality)
            .ok_or_else(|| "未找到可用音频流".to_string())?;
        let quality_name = pick
            .get("qualityName")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        set_progress(
            st,
            job,
            Some(8.0),
            Some(&format!("下载音频 {quality_name}")),
            json!({}),
        );

        let dest = joined(target_dir, &format!("{safe}.m4a"));
        let st3 = st.clone();
        let job3 = job.to_string();
        let on_progress = move |p: &net::Progress| {
            set_progress(
                &st3,
                &job3,
                Some(8.0 + p.percent * 0.82),
                Some(&format!("音频 {:.1}%", p.percent)),
                json!({ "speedText": format!("{:.2} MB/s", p.speed / 1024.0 / 1024.0) }),
            );
        };
        client
            .download_asset(
                pick.get("url").and_then(|v| v.as_str()).unwrap_or(""),
                Path::new(&dest),
                &backup_urls(&pick),
                threads,
                cancel_ref,
                &on_progress,
            )
            .await?;
        written.push(dest.clone());
        log_job(st, job, &format!("已保存音频：{}", basename(&dest)));
    } else {
        let pick =
            decode_video_pick(&streams, body.get("quality").and_then(|v| v.as_i64()))
                .ok_or_else(|| "未找到可用视频流".to_string())?;
        log_job(
            st,
            job,
            &format!(
                "画质：{}（{}x{} {}）",
                pick.get("qualityName").and_then(|v| v.as_str()).unwrap_or(""),
                pick.get("width").and_then(|v| v.as_i64()).unwrap_or(0),
                pick.get("height").and_then(|v| v.as_i64()).unwrap_or(0),
                pick.get("codecs").and_then(|v| v.as_str()).unwrap_or("")
            ),
        );
        set_progress(
            st,
            job,
            Some(5.0),
            Some(&format!(
                "下载视频 {}",
                pick.get("qualityName").and_then(|v| v.as_str()).unwrap_or("")
            )),
            json!({}),
        );

        let video_dest = joined(target_dir, &format!("{safe}.video.m4s"));
        let audio_dest = joined(target_dir, &format!("{safe}.audio.m4s"));
        let audio_pick = decode_audio_pick(&streams, audio_quality)
            .ok_or_else(|| "未找到可用音频流".to_string())?;

        let st_v = st.clone();
        let job_v = job.to_string();
        let on_video = move |p: &net::Progress| {
            set_progress(
                &st_v,
                &job_v,
                Some(5.0 + p.percent * 0.45),
                Some(&format!("视频 {:.1}%", p.percent)),
                json!({ "speedText": format!("{:.2} MB/s", p.speed / 1024.0 / 1024.0) }),
            );
        };
        let st_a = st.clone();
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
        vr?;
        ar?;

        // 合并
        let ffmpeg = audio::find_ffmpeg(&st.tools_dir());
        let mp4_dest = joined(target_dir, &format!("{safe}.mp4"));
        if ffmpeg.is_some() {
            set_progress(st, job, Some(92.0), Some("合并音视频…"), json!({}));
            let merge = audio::run_ffmpeg(
                &st.tools_dir(),
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
                    log_job(st, job, &format!("已合并输出：{}", basename(&mp4_dest)));
                }
                Err(e) if e == CANCELED => return Err(e),
                Err(e) => {
                    log_job(st, job, &format!("⚠ 合并失败（{e}），已保留分离的音视频流"));
                    written.push(video_dest.clone());
                    written.push(audio_dest.clone());
                }
            }
        } else {
            log_job(
                st,
                job,
                "⚠ 未安装 ffmpeg，已保留分离的视频流与音频流；安装 ffmpeg 后可自动合并为 mp4",
            );
            written.push(video_dest.clone());
            written.push(audio_dest.clone());
        }
    }

    // 封面
    if body.get("downloadCover").and_then(|v| v.as_bool()).unwrap_or(false) {
        if let Some(cover) = cover.filter(|c| !c.is_empty()) {
            let dest = joined(target_dir, &format!("{safe}.jpg"));
            match client
                .download_asset(&cover, Path::new(&dest), &[], 1, cancel_ref, &|_| {})
                .await
            {
                Ok(_) => {
                    written.push(dest.clone());
                    log_job(st, job, &format!("已保存封面：{}", basename(&dest)));
                }
                Err(e) => log_job(st, job, &format!("⚠ 封面下载失败：{e}")),
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
                    log_job(st, job, &format!("⚠ 弹幕下载失败：{e}"));
                } else {
                    written.push(dest.clone());
                    log_job(st, job, &format!("已保存弹幕：{}", basename(&dest)));
                }
            }
            Err(e) => log_job(st, job, &format!("⚠ 弹幕下载失败：{e}")),
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
                    log_job(st, job, "该视频没有官方字幕");
                }
                for s in &subs {
                    let url = s.get("url").and_then(|v| v.as_str()).unwrap_or("");
                    let lan = s.get("lan").and_then(|v| v.as_str()).unwrap_or("");
                    let lan_doc = s.get("lanDoc").and_then(|v| v.as_str()).unwrap_or("");
                    match net::fetch_bytes(url, net::headers(&[]), 20).await {
                        Ok(bytes) => {
                            let text = String::from_utf8_lossy(&bytes).to_string();
                            let dest = joined(target_dir, &format!("{safe}.{lan}.srt"));
                            let _ = std::fs::write(&dest, bcc_to_srt(&text));
                            written.push(dest.clone());
                            log_job(st, job, &format!("已保存字幕：{}（{lan_doc}）", basename(&dest)));
                        }
                        Err(e) => log_job(st, job, &format!("⚠ 字幕下载失败：{e}")),
                    }
                }
            }
            Err(e) => log_job(st, job, &format!("⚠ 字幕下载失败：{e}")),
        }
    }

    let message = format!("下载完成：{} 个文件", written.len());
    Ok((
        written.clone(),
        json!({ "files": written, "title": title, "dir": target_dir }),
        message,
    ))
}

async fn download_ytdlp(
    st: &Arc<AppState>,
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

    let st2 = st.clone();
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

    let files = ytdlp::download(&st.tools_dir(), url, &opts, &*cancel, &on_progress).await?;
    let message = format!("下载完成：{} 个文件", files.len());
    Ok((
        files.clone(),
        json!({ "files": files, "dir": target_dir }),
        message,
    ))
}

/* ------------------------------------------------------------ 流选择 */

fn backup_urls(pick: &Value) -> Vec<String> {
    pick.get("backupUrls")
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .filter_map(|x| x.as_str().map(String::from))
                .collect()
        })
        .unwrap_or_default()
}

fn decode_video_pick(streams: &Value, quality: Option<i64>) -> Option<Value> {
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

/// 同画质下优先 AVC，避免 HEVC 在老编辑器/播放器里打不开
fn prefer_avc(list: &[Value], target: &Value) -> Value {
    let id = target.get("id").and_then(|v| v.as_i64());
    list.iter()
        .filter(|v| v.get("id").and_then(|x| x.as_i64()) == id)
        .find(|v| {
            let c = v.get("codecs").and_then(|x| x.as_str()).unwrap_or("").to_lowercase();
            c.contains("avc") || c.contains("h264")
        })
        .cloned()
        .unwrap_or_else(|| target.clone())
}

fn decode_audio_pick(streams: &Value, audio_quality: Option<i64>) -> Option<Value> {
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
    // 默认取 192K，而不是 Hi-Res：兼容性更好且体积合理
    Some(
        list.iter()
            .find(|a| a.get("id").and_then(|x| x.as_i64()) == Some(30280))
            .cloned()
            .unwrap_or_else(|| list[0].clone()),
    )
}

/// B 站字幕 JSON → SRT
fn bcc_to_srt(json_text: &str) -> String {
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

fn srt_time(sec: f64) -> String {
    let ms = ((sec % 1.0) * 1000.0).round() as i64;
    let s = sec.floor() as i64 % 60;
    let m = (sec.floor() as i64 / 60) % 60;
    let h = sec.floor() as i64 / 3600;
    format!("{h:02}:{m:02}:{s:02},{ms:03}")
}

/* ══════════════════════════════════ POST /api/audio/run ══════════════════════════════════ */

pub async fn audio_run(
    State(st): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let action = body
        .get("action")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let input = body
        .get("input")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if input.is_empty() {
        return Err(ApiError::internal("缺少输入文件"));
    }

    let job_id = new_job(&st, "audio", &format!("音频处理：{action}"), "");
    set_job(
        &st,
        &job_id,
        json!({ "progress": {}, "result": Value::Null, "error": Value::Null }),
    );

    // 对应 Node 的 `{ input, output, ...options }` —— options 里同名的键会覆盖外层
    let mut merged = Map::new();
    merged.insert(
        "input".into(),
        body.get("input").cloned().unwrap_or(json!("")),
    );
    merged.insert(
        "output".into(),
        body.get("output").cloned().unwrap_or(json!("")),
    );
    if let Some(opts) = body.get("options").and_then(|v| v.as_object()) {
        for (k, v) in opts {
            merged.insert(k.clone(), v.clone());
        }
    }

    let st2 = st.clone();
    let job2 = job_id.clone();
    tokio::spawn(async move {
        set_progress(&st2, &job2, Some(2.0), Some("处理中…"), json!({}));
        let cancel = cancel_flag(&st2, &job2);
        let cancel_ref: &net::Cancel = &*cancel;

        let st3 = st2.clone();
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

        let tools = st2.tools_dir();
        let result = match action.as_str() {
            "convert" => audio::convert_audio(&tools, &merged, cancel_ref, &on_progress).await,
            "extract" => audio::extract_audio(&tools, &merged, cancel_ref, &on_progress).await,
            "pitch" => audio::shift_pitch(&tools, &merged, cancel_ref, &on_progress).await,
            "tempo" => audio::change_tempo(&tools, &merged, cancel_ref, &on_progress).await,
            "trim" => audio::trim_audio(&tools, &merged, cancel_ref, &on_progress).await,
            "normalize" => audio::normalize_loudness(&tools, &merged, cancel_ref, &on_progress).await,
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
            Err(e) if e == CANCELED => cancel_job(&st2, &job2),
            Err(e) => fail_job(&st2, &job2, &e),
        }
    });

    Ok(Json(ok(json!({ "jobId": job_id }))))
}

/* ══════════════════════════════════ POST /api/audio/probe ══════════════════════════════════ */

pub async fn audio_probe(
    State(st): State<Arc<AppState>>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let input = body
        .get("input")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if input.is_empty() || !Path::new(&input).exists() {
        return Err(ApiError::internal("文件不存在"));
    }
    let info = audio::probe_media(&st.tools_dir(), &input).await;
    Ok(Json(ok(json!({ "info": info }))))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn srt_timestamps_match_the_node_formatting() {
        assert_eq!(srt_time(0.0), "00:00:00,000");
        assert_eq!(srt_time(1.5), "00:00:01,500");
        assert_eq!(srt_time(3723.456), "01:02:03,456");
    }

    #[test]
    fn bcc_json_becomes_srt_and_bad_json_passes_through() {
        let srt = bcc_to_srt(r#"{"body":[{"from":0.5,"to":2.25,"content":"你好"}]}"#);
        assert_eq!(srt, "1\n00:00:00,500 --> 00:00:02,250\n你好\n");
        assert_eq!(bcc_to_srt("not json"), "not json");
        assert_eq!(bcc_to_srt("{}"), "");
    }

    #[test]
    fn picks_avc_over_hevc_at_the_same_quality() {
        let streams = json!({
            "mode": "dash",
            "video": [
                { "id": 80, "qualityName": "1080P", "codecs": "hev1.1.6", "url": "hevc" },
                { "id": 80, "qualityName": "1080P", "codecs": "avc1.640028", "url": "avc" },
                { "id": 32, "qualityName": "480P", "codecs": "avc1.64001F", "url": "low" }
            ],
            "audio": [
                { "id": 30280, "qualityName": "192K" },
                { "id": 30251, "qualityName": "Hi-Res" }
            ]
        });
        let v = decode_video_pick(&streams, None).unwrap();
        assert_eq!(v.get("url").unwrap(), "avc");
        // 指定画质时也优先 AVC
        let v = decode_video_pick(&streams, Some(80)).unwrap();
        assert_eq!(v.get("url").unwrap(), "avc");
        // 默认音频取 192K 而不是 Hi-Res
        let a = decode_audio_pick(&streams, None).unwrap();
        assert_eq!(a.get("id").unwrap(), 30280);
        // 整段流（durl）没有独立音轨
        assert!(decode_audio_pick(&json!({"mode":"durl"}), None).is_none());
        assert!(decode_video_pick(&json!({"mode":"durl","streams":[{"url":"x"}]}), None).is_some());
    }
}
