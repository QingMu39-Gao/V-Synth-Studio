//! 任务与资源库的命令。
//!
//! 任务进度走 **`tauri::ipc::Channel`**：前端把一个 `Channel` 当参数传进来，Rust 每有变化
//! 就往里 `send` 一份**完整快照**。**不用事件系统（`app.emit`）**：官方文档写明事件系统
//! 「不为低延迟/高吞吐设计」、载荷永远是 JSON 字符串且不吃 capabilities，而 Channel 就是为
//! 「从 Rust 往前端流式推数据」准备的（原始字节还能走 `ArrayBuffer`）。
//!
//! 推的语义（前端 `useJob.ts` 按此写，四条都要保持）：连上先推一份当前快照；之后每次变化
//! 推**完整快照**（不是增量，丢一条也不会错位）；状态变成 `done` / `error` / `canceled` 后
//! 推完最后一条就**结束**（通道 drop，前端 onmessage 停止）；订阅者跟不上被丢消息
//! （`Lagged`）时**继续**，不自作主张结束。

use std::sync::Arc;

use serde_json::{Value, json};

use super::Cmd;

/* ══════════════════════════════════ 任务生命周期 ══════════════════════════════════ */

/// 建一个任务记录，回它的 id。
///
/// id 的算法（`seq * 0x9e3779b9 % 0xffffff` 再补成 6 位十六进制）是「看着像随机、
/// 实际可复现」的那种，**改算法会让日志里的 id 对不上**，没必要动。
pub fn new_job(st: &Arc<super::AppState>, kind: &str, title: &str) -> String {
    let mut guard = st.jobs.lock().unwrap();
    guard.seq += 1;
    let id = format!("{:06x}", guard.seq * 0x9e3779b9u64 % 0xffffff);
    guard.items.insert(
        id.clone(),
        json!({
            "id": id,
            "type": kind,
            "title": title,
            "status": "running",
            "percent": 0,
            "message": "开始…",
            "logs": [],
            "createdAt": super::config_file::now_millis(),
        }),
    );
    id
}

/// 改任务字段并广播一份新快照。
///
/// ⚠️ **在锁内取快照、锁外广播** —— 广播放在锁里的话，订阅者一多就会把正在干活的
/// 任务线程堵住（进度更新很密，而广播是同步遍历订阅者）。
pub fn set_job(st: &Arc<super::AppState>, id: &str, patch: Value) {
    let (snapshot, tx) = {
        let mut guard = st.jobs.lock().unwrap();
        let snapshot = guard.items.get_mut(id).map(|job| {
            // Terminal states are immutable. Otherwise a worker can finish after Cancel
            // and overwrite the canceled state with done or error.
            let terminal = is_terminal(job);
            if !terminal && let (Some(dst), Some(src)) = (job.as_object_mut(), patch.as_object()) {
                for (k, v) in src {
                    dst.insert(k.clone(), v.clone());
                }
            }
            job.clone()
        });
        (snapshot, guard.tx.clone())
    };
    if let Some(j) = snapshot {
        let _ = tx.send(j);
    }
}

/// 往任务日志里追加一行（带 `HH:MM:SS` 时间戳），并广播。
pub fn log_job(st: &Arc<super::AppState>, id: &str, line: &str) {
    let (snapshot, tx) = {
        let mut guard = st.jobs.lock().unwrap();
        let snapshot = guard.items.get_mut(id).map(|job| {
            if let Some(logs) = job.get_mut("logs").and_then(|l| l.as_array_mut()) {
                logs.push(json!(format!("[{}] {}", clock(), line)));
            }
            job.clone()
        });
        (snapshot, guard.tx.clone())
    };
    if let Some(j) = snapshot {
        let _ = tx.send(j);
    }
}

/// 收工：状态 `done`、进度 100%。
pub fn finish_job(st: &Arc<super::AppState>, id: &str, message: &str) {
    set_job(
        st,
        id,
        json!({ "status": "done", "percent": 100, "message": message }),
    );
}

/// 收工并带回结果：状态 `done`、进度 100%、`result` 里是这次任务产出的东西。
///
/// 比 [`finish_job`] 多一个 `result` —— 下载与音频处理要用它（前端从
/// `job.result.files` / `job.result.dir` 里读产物），转换与扒谱不需要。
pub fn finish_with_result(st: &Arc<super::AppState>, id: &str, result: Value, message: &str) {
    set_job(
        st,
        id,
        json!({ "status": "done", "percent": 100, "message": message, "result": result }),
    );
}

/// 本地时间 HH:MM:SS，不引 chrono —— 用纪元秒自己算。
///
/// ⚠️ 这其实是 **UTC**（`secs % 86400` 没有加时区偏移）。差异只体现在日志时间戳上，
/// **别为此引一个时间库**。
fn clock() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let t = secs % 86400;
    let (h, m, s) = (t / 3600, (t % 3600) / 60, t % 60);
    format!("{h:02}:{m:02}:{s:02}")
}

/// 任务是否已到终态（到了就该结束推送）
fn is_terminal(job: &Value) -> bool {
    matches!(
        job.get("status").and_then(|s| s.as_str()),
        Some("done") | Some("error") | Some("canceled")
    )
}

/// 这个任务是不是已经被取消。
///
/// ⚠️ 长循环必须自己来问这一句：[`set_job`] 只保证终态不被覆盖，
/// 挡不住已经跑着的循环继续往输出目录写文件。
pub fn is_canceled(st: &Arc<super::AppState>, id: &str) -> bool {
    st.jobs
        .lock()
        .map(|g| {
            g.items
                .get(id)
                .and_then(|j| j.get("status"))
                .and_then(|s| s.as_str())
                == Some("canceled")
        })
        .unwrap_or(false)
}

/// 任务列表（不带日志，列表只要这几列）。
#[tauri::command]
pub async fn list_jobs(st: super::St<'_>) -> Cmd {
    let guard = st.jobs.lock().map_err(|_| "任务表锁坏了")?;
    let list: Vec<Value> = guard
        .items
        .values()
        .map(|j| {
            json!({
                "id": j.get("id"),
                "type": j.get("type"),
                "title": j.get("title"),
                "status": j.get("status"),
                "percent": j.get("percent"),
                "message": j.get("message"),
                "createdAt": j.get("createdAt"),
            })
        })
        .collect();
    Ok(json!({ "jobs": list }))
}

/// 单个任务的完整快照（含日志）。
#[tauri::command]
pub async fn get_job(st: super::St<'_>, id: String) -> Cmd {
    let guard = st.jobs.lock().map_err(|_| "任务表锁坏了")?;
    let job = guard
        .items
        .get(&id)
        .cloned()
        .ok_or_else(|| "任务不存在".to_string())?;
    Ok(json!({ "job": job }))
}

/// 取消任务。
///
/// 真正把任务标成 `canceled`：长任务（下载 / 音频处理）在循环里读这个状态，
/// 读到就中断并掐掉子进程。**没有额外的取消通道 —— 任务表本身就是通道。**
#[tauri::command]
pub async fn cancel_job(st: super::St<'_>, id: String) -> Cmd {
    let (snapshot, tx) = {
        let mut guard = st.jobs.lock().map_err(|_| "任务表锁坏了")?;
        let job = guard
            .items
            .get_mut(&id)
            .ok_or_else(|| "任务不存在".to_string())?;
        let status = job.get("status").and_then(|v| v.as_str()).unwrap_or("");
        if !matches!(status, "done" | "error" | "canceled")
            && let Some(m) = job.as_object_mut()
        {
            m.insert("status".into(), json!("canceled"));
            m.insert("message".into(), json!("已取消"));
        }
        (job.clone(), guard.tx.clone())
    };
    // Cancellation is a state transition; wake live watchers immediately.
    let _ = tx.send(snapshot.clone());
    Ok(json!({ "job": snapshot }))
}

/// 订阅一个任务的进度。
///
/// 这是个**长驻**命令：它会一直 `await` 到任务到终态（或者前端把通道 drop 掉）。
/// 前端 `useJob.ts` 里同时保留了 700ms 轮询兜底 —— 那条路在 Channel 建不起来时接管，
/// **不要删**（它是断线保险，与「IPC 会不会失败」无关）。
#[tauri::command]
pub async fn job_watch(
    st: super::St<'_>,
    id: String,
    on_event: tauri::ipc::Channel<Value>,
) -> Result<(), String> {
    let (initial, mut rx) = {
        let guard = st.jobs.lock().map_err(|_| "任务表锁坏了")?;
        let job = guard
            .items
            .get(&id)
            .cloned()
            .ok_or_else(|| "任务不存在".to_string())?;
        // ⚠️ **先订阅再放开锁** —— 顺序反过来的话，这两步之间的更新会丢，
        // 表现是进度条卡在某一个百分比不动。
        (job, guard.tx.subscribe())
    };

    // 第一条：订阅前的当前快照
    let mut terminal = is_terminal(&initial);
    if on_event.send(initial).is_err() {
        // 前端已经不等了（页面切走），直接收工，别在这儿空转
        return Ok(());
    }
    if terminal {
        return Ok(());
    }

    loop {
        match rx.recv().await {
            Ok(v) => {
                if v.get("id").and_then(|x| x.as_str()) != Some(id.as_str()) {
                    continue;
                }
                terminal = is_terminal(&v);
                if on_event.send(v).is_err() {
                    return Ok(());
                }
                if terminal {
                    return Ok(());
                }
            }
            // 订阅者跟不上被丢了消息：**不是错误**，继续等下一批 ——
            // 推的是完整快照，丢掉一条只是少刷一帧。
            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
            // 发送端没了（进程要退了）
            Err(_) => return Ok(()),
        }
    }
}

/* ══════════════════════════════════ 资源库 ══════════════════════════════════ */

/// 资源库数据（`data/resources.json` 的内容）。
///
/// `reload` 参数**收下但没用**：每次都是读盘，没有进程内缓存可绕。
/// 留着是为了让前端的调用点一个字都不用改（传了也不会报错）。
#[tauri::command]
pub async fn get_resources(st: super::St<'_>, reload: Option<bool>) -> Cmd {
    let _ = reload;
    /* 位置（`data/resources.json`）只在 `artifact::ARTIFACTS` 的 `data.resources`
    里声明一次。 */
    let ctx = crate::artifact::Ctx::root_only(&st.inner().root);
    let a = crate::artifact::get("data.resources").expect("表里必须有 data.resources");
    let path =
        crate::artifact::entry_path(&crate::artifact::locate_or_default(&ctx, a), &a.need[0]);
    let text = std::fs::read_to_string(&path)
        .map_err(|e| format!("读不到资源库数据（{}）：{e}", path.display()))?;
    let data: Value =
        serde_json::from_str(&text).map_err(|e| format!("resources.json 解析失败：{e}"))?;
    Ok(json!({
        "version": data.get("version").cloned().unwrap_or(json!(1)),
        "updatedAt": data.get("updatedAt").cloned().unwrap_or(json!("")),
        "notice": data.get("notice").cloned().unwrap_or(json!("")),
        "groups": data.get("groups").cloned().unwrap_or(json!([])),
        "verifySummary": data.get("verifySummary").cloned().unwrap_or(json!({})),
    }))
}

/// 外链校验。
///
/// ⚠️ **还是占位实现**（回 `{results: [], pending: true}`）。前端 `Resources.tsx`
/// 认这个形状并提示「后端还没接上链接校验」，**别把它改成报错** —— 那会让整页变红。
/// 真正的校验脚本是离线的 `tests/manual/check-resources.mjs`（不属于运行时）。
#[tauri::command]
pub async fn check_resources() -> Cmd {
    Ok(json!({ "results": [], "pending": true }))
}
