//! 人声转 MIDI（扒谱）的命令。扒谱算法在 `crate::game` 与 `crate::midi_transcribe` 里，
//! 这一层只做**参数校验、任务表、进度上报**。
//!
//! ⚠️ **只有 `status` 碰得到 ORT 的状态，而它不建会话。**
//! `ort` 的 `setup_api()` 是**惰性**的，任何 ORT 调用之前必须先
//! `ort::init_from(<绝对路径的 onnxruntime.dll>).commit()`，否则它去找裸文件名然后
//! panic —— 而 tokio worker 线程 panic 的表现是「请求没有任何回复」，不是路由问题。
//! 真正的初始化在 `game/engine.rs::load_runtime`。
//!
//! 不收上传的音频（音频就在用户盘上），结果也不经过 IPC 转发（目录记在 `result.dir`）。

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use serde_json::{Value, json};

use super::Cmd;
use super::jobs::{finish_job, log_job, new_job, set_job};
use crate::game::engine;
use crate::midi_transcribe as mt;

/// 下载进度（前端每 2 秒轮询 `midi_status`）。
///
/// 和音轨分离那三个静态量是**分开的一份**，不是共用：两边可以同时下（用户一边
/// 下分离引擎一边下扒谱模型完全合理），共用一份状态会让两条进度条互相踩。
static DL_ACTIVE: AtomicU64 = AtomicU64::new(0);
static DL_BYTES: AtomicU64 = AtomicU64::new(0);
static DL_TOTAL: AtomicU64 = AtomicU64::new(0);
/// 0 = 在下字节，1 = 下完了、正在解压（`crate::svsep::Stage`）
static DL_STAGE: AtomicU64 = AtomicU64::new(0);
static DL_KIND: std::sync::Mutex<Option<&'static str>> = std::sync::Mutex::new(None);
static DL_ERROR: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);
static DL_PAUSE: AtomicBool = AtomicBool::new(false);
static DL_STOP: AtomicBool = AtomicBool::new(false);

/// 正在跑的任务 id 与它的取消旗标。
///
/// 同时只允许一个：推理是**纯 CPU 的多秒级阻塞活**，两个一起跑只会让两边都慢
/// 一倍（还有 400 MB 的图各占一份内存）。前端也不给并发入口。
static RUNNING: std::sync::Mutex<Option<(String, Arc<mt::Cancel>)>> = std::sync::Mutex::new(None);

/* ══════════════════════════════════ 状态 ══════════════════════════════════ */

fn download_state() -> Value {
    let active = DL_ACTIVE.load(Ordering::Relaxed) == 1;
    json!({
        "active": active,
        "kind": DL_KIND.lock().ok().and_then(|k| *k),
        "stage": if DL_STAGE.load(Ordering::Relaxed) == 1 { "extract" } else { "download" },
        "done": DL_BYTES.load(Ordering::Relaxed) as f64,
        "total": DL_TOTAL.load(Ordering::Relaxed) as f64,
        "error": DL_ERROR.lock().ok().and_then(|e| e.clone()),
        // 这个包**不支持续传**（见 `svsep::fetch_to_file` 的注释），
        // 所以永远没有「继续下载」这一说 —— 前端据此把按钮文案固定成「下载模型」。
        "resumable": false,
    })
}

/// 扒谱依赖状态：模型 / 运行时（可能借音轨分离那份）/ 推理设备 / 当前任务。
#[tauri::command]
pub async fn midi_status(st: super::St<'_>) -> Cmd {
    let mut v = mt::status(&st.inner().root, &st.inner().writable);
    if let Some(o) = v.as_object_mut() {
        o.insert("download".into(), download_state());
        let running = RUNNING
            .lock()
            .ok()
            .and_then(|r| r.as_ref().map(|(id, _)| id.clone()));
        o.insert("running".into(), json!(running));
    }
    Ok(v)
}

/* ══════════════════════════════════ 推理方式 ══════════════════════════════════ */

/// 现在选的推理方式，以及这台机器能不能用 GPU。
///
/// 内容与 `midi_status` 里的 `device` 一节**同源**（都出自 `mt::device_status`）。
/// 单开一条是为了让设置页那一格能独立刷新 —— 用户刚装完音轨分离，不必等整个
/// 状态对象重新拉一遍。
///
/// ⚠️ `cuda.ok` 报的是「CUDA **建得出会话**」，不是「保证跑得完」：真跑起来失败时
/// `engine::build_sessions` 会整条退回 CPU，原因写在任务日志里。
#[tauri::command]
pub async fn midi_device_get(st: super::St<'_>) -> Cmd {
    Ok(device_payload(&st.inner().root, &st.inner().writable))
}

/// 设置推理方式。`{ mode: "auto" | "cpu" | "gpu" }`
///
/// ⛔ **不校验「GPU 到底能不能用」**：盘上记的是用户的意愿，不是硬件现状。硬拦下来
/// 会出现「换台机器就得重设一次」这种莫名其妙的限制；真用不了时引擎自己会退回 CPU。
/// 界面负责在**选不了的时候**把那一格锁住，后端不重复一遍这个判断。
#[tauri::command]
pub async fn midi_device_set(st: super::St<'_>, mode: String) -> Cmd {
    let m = mode.trim().to_ascii_lowercase();
    if !["auto", "cpu", "gpu"].contains(&m.as_str()) {
        return Err(format!(
            "不认识的推理方式：{mode}（只能是 auto / cpu / gpu）"
        ));
    }
    let dev = mt::Device::parse(&m);
    mt::write_device(&st.inner().writable, dev).map_err(|e| format!("写推理方式失败：{e}"))?;
    crate::log_line(&format!("人声转 MIDI：推理方式改成 {}", dev.as_str()));
    Ok(device_payload(&st.inner().root, &st.inner().writable))
}

/// 给界面的那一小段状态（`midi_device_get` / `midi_device_set` 共用一份，免得两边漂）。
fn device_payload(root: &std::path::Path, writable: &std::path::Path) -> Value {
    let dll = mt::runtime_dll(root, writable);
    let ds = mt::device_status(writable, dll.as_deref());
    json!({
        "mode": ds.device.as_str(),
        "cuda": { "ok": ds.cuda_ok, "detail": ds.cuda_detail },
        "note": ds.note,
    })
}

/* ══════════════════════════════════ 下载 ══════════════════════════════════ */

fn note_progress(got: u64, total: Option<u64>, stage: crate::svsep::Stage) {
    DL_BYTES.store(got, Ordering::Relaxed);
    if let Some(t) = total {
        DL_TOTAL.store(t, Ordering::Relaxed);
    }
    DL_STAGE.store(
        if stage == crate::svsep::Stage::Extract {
            1
        } else {
            0
        },
        Ordering::Relaxed,
    );
}

/// 起一个后台下载，立刻返回。`kind` 是 `"models"` / `"runtime"`。
///
/// 和音轨分离那边同一套骨架：**不占着请求**，进度由前端轮询 `midi_status`。
/// 那边还要照顾暂停续传、`.part` 记号、五轮重试的收场；这里因为不分段续传，
/// 收场简单得多（错了就删半截文件）。
fn spawn_download<F>(kind: &'static str, job: F) -> Result<Value, String>
where
    F: Future<Output = Result<Value, String>> + Send + 'static,
{
    if DL_ACTIVE.load(Ordering::Relaxed) == 1 {
        return Err("已经有一个下载在跑了，等它结束。".into());
    }
    if let Ok(mut e) = DL_ERROR.lock() {
        *e = None;
    }
    if let Ok(mut k) = DL_KIND.lock() {
        *k = Some(kind);
    }
    DL_PAUSE.store(false, Ordering::Relaxed);
    DL_STOP.store(false, Ordering::Relaxed);
    DL_STAGE.store(0, Ordering::Relaxed);
    DL_BYTES.store(0, Ordering::Relaxed);
    DL_ACTIVE.store(1, Ordering::Relaxed);

    tokio::spawn(async move {
        let res = job.await;
        DL_ACTIVE.store(0, Ordering::Relaxed);
        if let Ok(mut k) = DL_KIND.lock() {
            *k = None;
        }
        if let Err(e) = res
            && let Ok(mut slot) = DL_ERROR.lock()
        {
            *slot = Some(e);
        }
    });

    Ok(json!({ "started": true }))
}

/// 下载模型包（364 MB）。已经装了就报错，而不是白下一遍。
#[tauri::command]
pub async fn midi_models_download(st: super::St<'_>) -> Cmd {
    let root = st.inner().root.clone();
    let writable = st.inner().writable.clone();

    /* 已经装齐了就别再下 364 MB —— 前端按钮本来也会换掉，这是防手快。
    ⚠️ **判「齐」的语义在 `artifact` 表里**，这里只问结论：自己拼「外层有缺失、
    内层没缺失」那种嵌套判断容易写成两句互斥，那个 `Err` 就永远不可能触发。 */
    /* ⚠️ 用 `artifact::ready_of`（认两层：可写那层与随包那层）而不是
    自己拼 `dir_of(...).join("encoder.onnx")` —— 那样只认一层，
    随包那份齐全时也会误判成「要下」。 */
    if crate::artifact::ready_of(&root, &writable, "game.models") {
        return Err("模型已经装好了，不用再下。".into());
    }

    // `DownloadCtl` 收的是 `&'static AtomicBool`，而这两个旗标正是 `'static` ——
    // 直接借，不用 clone（clone 出来的是个临时值，借不成 'static）。
    let ctl = crate::svsep::DownloadCtl::new(&DL_PAUSE, &DL_STOP, false);
    spawn_download("models", async move {
        let v = mt::download_models(&writable, &ctl, note_progress).await?;
        crate::log_line(&format!("人声转 MIDI：模型下载完成 {:?}", v.get("dir")));
        Ok(v)
    })
}

/// 停止下载。**不支持续传**，所以没有「暂停」这个动作 —— 停了就删掉半个包。
#[tauri::command]
pub async fn midi_download_stop() -> Cmd {
    if DL_ACTIVE.load(Ordering::Relaxed) != 1 {
        return Err("现在没有在下载".into());
    }
    DL_STOP.store(true, Ordering::Relaxed);
    Ok(json!({ "stopping": true }))
}

/// 一键删掉下好的模型 / 运行时（正在跑或正在下时拒绝）。
#[tauri::command]
pub async fn midi_deps_delete(st: super::St<'_>) -> Cmd {
    if DL_ACTIVE.load(Ordering::Relaxed) == 1 {
        return Err("正在下载，先停下再删。".into());
    }
    if RUNNING
        .lock()
        .ok()
        .and_then(|r| r.as_ref().map(|_| ()))
        .is_some()
    {
        return Err("正在扒谱，等它跑完再删模型。".into());
    }
    let (files, bytes, note) = mt::delete_deps(&st.inner().root, &st.inner().writable);
    crate::log_line(&format!(
        "人声转 MIDI：删掉 {files} 个文件、{bytes} 字节；{note}"
    ));
    Ok(json!({ "files": files, "bytes": bytes, "note": note }))
}

/* ══════════════════════════════════ 扒谱 ══════════════════════════════════ */

/// 提交一次扒谱：
///
/// ```json
/// { "input": "D:\\歌\\干声.wav", "outDir": "D:\\歌\\midi", "steps": 8, "language": 4 }
/// ```
///
/// `input` **是路径不是上传的字节**（见文件头的说明）；`outDir` 不给就写到音频
/// 同目录下的 `midi` 子目录。立刻回 `{jobId}`，进度走 `job_watch`。
#[tauri::command]
pub async fn midi_transcribe(st: super::St<'_>, args: Value) -> Cmd {
    let input = args
        .get("input")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim()
        .to_string();
    if input.is_empty() {
        return Err("没给音频路径".into());
    }
    let input_path = std::path::PathBuf::from(&input);
    if !input_path.is_file() {
        return Err(format!("文件不存在：{input}"));
    }
    // 输出不能盖住输入：用户把 .mid 拖进来（想「再扒一遍」）时，
    // 输出主干和输入同名同目录，会直接把源文件写没。
    if input_path
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase() == "mid")
        .unwrap_or(false)
    {
        return Err("输入是 MIDI 文件，扒谱要的是音频（wav / mp3 / flac…）。".into());
    }

    let root = st.inner().root.clone();
    let writable = st.inner().writable.clone();

    let missing = crate::artifact::missing_of(&root, &writable, "game.models");
    if !missing.is_empty() {
        return Err(format!(
            "模型还没装全（缺 {}）。先点「下载模型」。",
            missing.join("、")
        ));
    }
    let Some(dll) = mt::runtime_dll(&root, &writable) else {
        return Err(
            "缺 ONNX Runtime 动态库（随包的 tools/onnxruntime/ 不在，安装可能不完整）。".into(),
        );
    };

    /* ⚠️ 检查与占位必须在**同一次持锁**里做。分两步写（先看、后放）时两次并发提交
    都能通过检查，后写者还会覆盖前一个任务的 `Cancel` 句柄 —— 从此第一个任务
    `midi_cancel` 永远比不中 id，只能等它自己跑完，而「一次只跑一个」也名存实亡。
    这里先用空 id 占住（下面到写 id 为止没有任何失败分支），拿到 job_id 后再补上。 */
    let cancel = mt::Cancel::new();
    {
        let mut guard = RUNNING.lock().map_err(|_| "任务表坏了".to_string())?;
        if guard.is_some() {
            return Err("已经有一次扒谱在跑了。这个功能一次只跑一个（CPU 都被它占着）。".into());
        }
        *guard = Some((String::new(), cancel.clone()));
    }

    let out_dir = args
        .get("outDir")
        .and_then(|v| v.as_str())
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| {
            input_path
                .parent()
                .unwrap_or_else(|| std::path::Path::new("."))
                .join("midi")
        });

    let opts = engine::Options {
        steps: clamp_usize(args.get("steps").and_then(|v| v.as_u64()), 8, 1, 32),
        language: clamp_usize(
            args.get("language")
                .and_then(|v| v.as_i64().map(|i| i as u64)),
            4,
            0,
            126,
        ) as i64,
        threads: clamp_usize(args.get("threads").and_then(|v| v.as_u64()), 4, 1, 32),
        // 真正的判据是盘上的设置（`mt::transcribe_blocking` 会再读一次），这里填进去
        // 只是让日志里那一行与用户选的一致 —— 任务也可能来自「再跑一次」。
        device: mt::read_device(&writable),
    };

    let st_arc: Arc<super::AppState> = st.inner().clone();
    let title = format!("人声转 MIDI · {}", mt::output_stem(&input_path));
    let job_id = new_job(&st_arc, "transcribe", &title);
    log_job(
        &st_arc,
        &job_id,
        &format!("输入：{input}（去噪 {} 步）", opts.steps),
    );

    // 把占位换成真 id。用的必须是上面占位时那把 `cancel` —— 重造一把会让
    // 「停止」按到旧句柄上，而推理循环只认槽里这一把。
    RUNNING
        .lock()
        .map_err(|_| "任务表坏了".to_string())
        .map(|mut slot| {
            *slot = Some((job_id.clone(), cancel.clone()));
        })?;

    let st2 = Arc::clone(&st_arc);
    let id2 = job_id.clone();
    let root_dir = st_arc.root.clone();
    let writable_dir = st_arc.writable.clone();
    // 模型目录在这里就定下来（表给的「当前生效那一层」），随任务一起进去 ——
    // 任务跑到一半时用户要是点了「删除依赖」，至少这一次用的还是任务开始时那一份。
    let models = crate::artifact::dir_of(&root, &writable, "game.models");
    let stem = mt::output_stem(&input_path);
    let scratch = mt::data_dir(&writable).join("work");
    tokio::spawn(async move {
        run_job(
            st2,
            id2,
            input_path,
            out_dir,
            scratch,
            root_dir,
            writable_dir,
            models,
            dll,
            opts,
            cancel,
            stem,
        )
        .await;
    });

    Ok(json!({ "jobId": job_id }))
}

/// 任务主体：ffmpeg 转码 → 推理 → 落盘。所有失败都变成任务里的 `status: error`。
#[allow(clippy::too_many_arguments)]
async fn run_job(
    st: Arc<super::AppState>,
    job_id: String,
    input: std::path::PathBuf,
    out_dir: std::path::PathBuf,
    scratch: std::path::PathBuf,
    root: std::path::PathBuf,
    writable: std::path::PathBuf,
    models: std::path::PathBuf,
    dll: std::path::PathBuf,
    opts: engine::Options,
    cancel: Arc<mt::Cancel>,
    stem: String,
) {
    let result = run_job_inner(
        Arc::clone(&st),
        job_id.clone(),
        &input,
        &out_dir,
        &scratch,
        &root,
        &writable,
        &models,
        &dll,
        &opts,
        &cancel,
        &stem,
    )
    .await;

    // 收工时把「正在跑」这一格腾出来，**而且要认 id**：取消之后用户可能已经
    // 提交了下一次任务，这时槽里装的是后来那个 —— 无条件清空会把新任务
    // 从「忙」变成「空闲」，界面就允许再提交一个了。
    if let Ok(mut slot) = RUNNING.lock()
        && slot.as_ref().map(|(id, _)| id.as_str()) == Some(job_id.as_str())
    {
        *slot = None;
    }
    match result {
        Ok(notes) => finish_job(&st, &job_id, &format!("完成：{notes} 个音符")),
        Err(e) if e == mt::CANCELLED => {
            set_job(
                &st,
                &job_id,
                json!({ "status": "canceled", "message": "已取消" }),
            );
        }
        Err(e) => {
            log_job(&st, &job_id, &e);
            // ⚠️ 状态词是 `"error"` 不是 `"failed"` —— 前端 `Job['status']` 的联合类型
            // 只有 `running | done | error | canceled`，别的词会让 `useJob` 永远
            // 收不到终态、进度条一直转。
            set_job(
                &st,
                &job_id,
                json!({ "status": "error", "error": e, "message": e }),
            );
        }
    }
}

#[allow(clippy::too_many_arguments)]
async fn run_job_inner(
    st: Arc<super::AppState>,
    job_id: String,
    input: &std::path::Path,
    out_dir: &std::path::Path,
    scratch: &std::path::Path,
    root: &std::path::Path,
    writable: &std::path::Path,
    models: &std::path::Path,
    dll: &std::path::Path,
    opts: &engine::Options,
    cancel: &Arc<mt::Cancel>,
    stem: &str,
) -> Result<usize, String> {
    std::fs::create_dir_all(scratch).map_err(|e| format!("建临时目录失败：{e}"))?;
    // 临时 wav 用任务 id 命名：跑两次同一首歌不会撞车，异常退出留下的残骸
    // 也能一眼看出是哪次任务留下的。
    let wav = scratch.join(format!("{job_id}.wav"));

    // ── 1. 解码 ─────────────────────────────────────────────────────────
    //
    // ⚠️ 两个回调都必须**拿走所有权**（`move` + `Arc<AppState>` / `String`），
    //    不能借用 `&Arc<AppState>` 与 `&str`：`crate::audio::Progress` 是
    //    `dyn Fn(f64, f64) + Send + Sync`（隐式 `'static`），借用会让
    //    `borrowed data escapes outside of function`（E0521）。
    //    代价只是每个闭包一份 `Arc` 的引用计数，很便宜。
    let probe = crate::audio::probe_media(root, &input.to_string_lossy()).await;
    let duration = probe
        .get("duration")
        .and_then(|v| v.as_f64())
        .filter(|d| *d > 0.0)
        .unwrap_or(0.0);
    let st_dec = Arc::clone(&st);
    let id_dec = job_id.clone();
    set_job(
        &st_dec,
        &id_dec,
        json!({ "message": "正在解码音频…", "percent": 1 }),
    );
    let ctl = cancel.clone();
    let cancel_flag = move || ctl.stopped();
    let on_dec = move |pct: f64, _sec: f64| {
        set_job(
            &st_dec,
            &id_dec,
            json!({ "message": "正在解码音频…", "percent": (pct * 0.05).min(5.0) }),
        );
    };
    mt::decode_to_wav(root, input, &wav, duration, &cancel_flag, &on_dec).await?;
    if cancel.stopped() {
        let _ = std::fs::remove_file(&wav);
        return Err(mt::CANCELLED.into());
    }

    // ── 2. 推理（阻塞，必须 spawn_blocking）──────────────────────────────
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<(String, f64)>();
    let models = models.to_path_buf();
    let dll = dll.to_path_buf();
    let writable2 = writable.to_path_buf();
    let wav2 = wav.clone();
    let opts2 = opts.clone();
    let cancel2 = cancel.clone();
    let started = std::time::Instant::now();
    let handle = tokio::task::spawn_blocking(move || {
        mt::transcribe_blocking(
            &writable2,
            &models,
            &dll,
            &wav2,
            &opts2,
            &cancel2,
            move |what, pct| {
                // 推理只占整条时间线的 5%..95%（前面解码、后面落盘都要留位置）
                let _ = tx.send((what.to_string(), 5.0 + pct * 90.0));
            },
        )
    });

    // 边等边把进度灌进任务表：`spawn_blocking` 的返回值要 await，
    // 而进度是从另一个线程经 channel 过来的 —— 轮询式 `try_recv` + 短 sleep
    // 是最省事的写法（进度本来就只有几十条，不值得为它上 select!）。
    let report = loop {
        while let Ok((what, pct)) = rx.try_recv() {
            set_job(&st, &job_id, json!({ "message": what, "percent": pct }));
        }
        if handle.is_finished() {
            break handle.await;
        }
        tokio::time::sleep(std::time::Duration::from_millis(120)).await;
    };
    let _ = std::fs::remove_file(&wav);

    let report = report.map_err(|e| format!("推理线程崩了：{e}"))??;

    // ── 3. 落盘 ─────────────────────────────────────────────────────────
    set_job(
        &st,
        &job_id,
        json!({ "message": "正在写文件…", "percent": 96 }),
    );
    let written = mt::write_outputs(out_dir, stem, &report)?;
    let names: Vec<String> = written
        .iter()
        .filter_map(|p| p.file_name().map(|n| n.to_string_lossy().to_string()))
        .collect();
    log_job(
        &st,
        &job_id,
        &format!(
            "写出 {}（encoder {:.1}s / segmenter {:.1}s / estimator {:.1}s，总 {:.1}s，后端 {}）",
            names.join("、"),
            report.encoder_seconds,
            report.segmenter_seconds,
            report.estimator_seconds,
            started.elapsed().as_secs_f64(),
            report.backend,
        ),
    );

    let notes = report.notes.len();
    let dir = crate::platform::clean_path(out_dir);
    set_job(
        &st,
        &job_id,
        json!({
            "message": format!("完成：{notes} 个音符"),
            "percent": 100,
            "result": {
                "dir": dir,
                "files": names,
                "notes": notes,
                // 这次**实际**用的后端（`"CUDA"` / `"CPU"`）。用户选了 GPU 但建会话
                // 失败时会退回 CPU，界面据这一项说清「为什么还是这么慢」。
                "backend": report.backend,
                "seconds": {
                    "encoder": report.encoder_seconds,
                    "segmenter": report.segmenter_seconds,
                    "estimator": report.estimator_seconds,
                },
                // 前 200 个音符给界面画钢琴卷帘 —— 一首歌几千个音符没必要全塞进
                // 轮询响应里，要全的都在 .json 里。
                "preview": engine::note_rows(&report.notes).into_iter().take(200)
                    .map(|(o, e, p, m)| json!({ "onset": o, "offset": e, "pitch": p, "midi": m }))
                    .collect::<Vec<_>>(),
            },
        }),
    );
    Ok(notes)
}

/// 把界面给的值夹在合理区间里（`steps` / `threads` 之类的滑块不该由用户手打越界值）。
fn clamp_usize(v: Option<u64>, default: usize, lo: usize, hi: usize) -> usize {
    match v {
        Some(n) => (n as usize).clamp(lo, hi),
        None => default,
    }
}

/* ══════════════════════════════════ 任务查询 ══════════════════════════════════ */

/// 查一个扒谱任务。
#[tauri::command]
pub async fn midi_task(st: super::St<'_>, id: String) -> Cmd {
    let guard = st
        .inner()
        .jobs
        .lock()
        .map_err(|_| "任务表坏了".to_string())?;
    let job = guard.items.get(&id).cloned();
    drop(guard);
    match job {
        Some(mut j) => {
            if let Some(o) = j.as_object_mut() {
                o.insert("id".into(), json!(id));
            }
            Ok(j)
        }
        None => Err(format!("没有这个任务：{id}")),
    }
}

/// 取消扒谱。**不是立刻停** —— 去噪循环在下一个 step 边界才收手。
#[tauri::command]
pub async fn midi_cancel(st: super::St<'_>, id: String) -> Cmd {
    let mut hit = false;
    // 只读地看一眼槽里是谁 —— 不去改它：**这里不该把槽清空**，清空是
    // `run_job` 收工时的活（它要认 id）。否则任务还在跑，`status.running`
    // 就已经是空的，界面会放开「再提交一个」。
    if let Ok(slot) = RUNNING.lock()
        && let Some((cur, cancel)) = slot.as_ref()
        && *cur == id
    {
        cancel.stop();
        hit = true;
    }
    // 旗标立了，真正的收场在推理那一侧（它在每个切片边界看一眼）。
    // 这里**不改任务状态** —— 由 `run_job` 统一写，免得两边打架。
    if hit {
        log_job(
            &st.inner().clone(),
            &id,
            "收到取消请求，正在当前这一段结束后停下…",
        );
    }
    Ok(json!({ "canceled": hit }))
}

/// 在资源管理器里选中一个目录。`{ dir }`
///
/// ⚠️ 和音轨分离那边不同：结果**不在固定的 `<数据目录>/outputs/<id>`**，
/// 而是落在用户选的目录（或音频同目录下的 `midi/`）。所以前端必须把
/// 任务 `result.dir` 原样传回来；空串只兜底开本功能的数据目录。
#[tauri::command]
pub async fn midi_open_output(st: super::St<'_>, args: Option<Value>) -> Cmd {
    let args = args.unwrap_or_else(|| json!({}));
    let dir = args
        .get("dir")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .trim();
    let target = if dir.is_empty() {
        // 不给就开本功能的数据目录（模型、动态库都在这儿，用户想翻也翻得到）
        mt::data_dir(&st.inner().writable)
            .to_string_lossy()
            .to_string()
    } else {
        dir.to_string()
    };
    let p = std::path::Path::new(&target);
    if !p.exists() {
        return Err(format!("目录不存在：{target}"));
    }
    crate::platform::reveal_in_explorer(&target, false).map_err(|e| e.to_string())?;
    Ok(json!({ "path": target }))
}
