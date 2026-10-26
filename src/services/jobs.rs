//! 后台任务表：进度、日志与协作式取消。
//!
//! 每个任务跑在独立线程，状态写入共享表；UI 通过 [`Jobs`] 的广播通道刷新。
//! 取消是协作式的：工作闭包在检查点调用 [`JobContext::check_cancel`]，
//! 阻塞中的外部进程不会被这里强行杀掉。

use std::collections::BTreeMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Instant;

use async_channel::{Receiver, Sender, bounded, unbounded};

const LOG_LIMIT: usize = 200;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum JobStatus {
    Running,
    Succeeded,
    Failed,
    Canceled,
}

impl JobStatus {
    pub fn is_running(self) -> bool {
        self == Self::Running
    }
}

#[derive(Debug, Clone)]
pub struct JobSnapshot {
    pub id: u64,
    pub title: String,
    pub status: JobStatus,
    pub progress: Option<f32>,
    pub message: String,
    pub log: Vec<String>,
    pub started: Instant,
}

#[derive(Debug, Clone)]
pub enum JobOutcome<T> {
    Done(T),
    Failed(String),
    Canceled,
}

pub struct Job<T> {
    pub id: u64,
    pub result: Receiver<JobOutcome<T>>,
}

#[derive(Clone)]
pub struct Jobs {
    inner: Arc<Inner>,
}

struct Inner {
    next_id: AtomicU64,
    entries: Mutex<BTreeMap<u64, Entry>>,
    events: Sender<u64>,
}

struct Entry {
    snapshot: JobSnapshot,
    cancel: Arc<AtomicBool>,
}

impl Inner {
    fn entries(&self) -> MutexGuard<'_, BTreeMap<u64, Entry>> {
        self.entries
            .lock()
            .unwrap_or_else(|error| error.into_inner())
    }

    fn notify(&self, id: u64) {
        let _ = self.events.try_send(id);
    }
}

impl Jobs {
    pub fn new() -> (Self, Receiver<u64>) {
        let (events, receiver) = unbounded();
        let jobs = Self {
            inner: Arc::new(Inner {
                next_id: AtomicU64::new(1),
                entries: Mutex::new(BTreeMap::new()),
                events,
            }),
        };
        (jobs, receiver)
    }

    pub fn start<T, F>(&self, title: impl Into<String>, work: F) -> Job<T>
    where
        T: Send + 'static,
        F: FnOnce(JobContext) -> Result<T, String> + Send + 'static,
    {
        let id = self.inner.next_id.fetch_add(1, Ordering::Relaxed);
        let cancel = Arc::new(AtomicBool::new(false));
        self.inner.entries().insert(
            id,
            Entry {
                snapshot: JobSnapshot {
                    id,
                    title: title.into(),
                    status: JobStatus::Running,
                    progress: None,
                    message: "准备中…".to_string(),
                    log: Vec::new(),
                    started: Instant::now(),
                },
                cancel: cancel.clone(),
            },
        );
        self.inner.notify(id);

        let (tx, rx) = bounded(1);
        let inner = self.inner.clone();
        let ctx = JobContext {
            id,
            inner: inner.clone(),
            canceled: cancel.clone(),
        };
        std::thread::spawn(move || {
            let result = catch_unwind(AssertUnwindSafe(|| work(ctx)))
                .unwrap_or_else(|_| Err("任务异常终止".to_string()));
            let canceled = cancel.load(Ordering::SeqCst);
            let (status, message, outcome) = match result {
                _ if canceled => (
                    JobStatus::Canceled,
                    "已取消".to_string(),
                    JobOutcome::Canceled,
                ),
                Ok(value) => {
                    let message = {
                        let mut entries = inner.entries();
                        let entry = entries.get_mut(&id).expect("job entry exists");
                        if entry.snapshot.message.is_empty() || entry.snapshot.message == "准备中…"
                        {
                            entry.snapshot.message = "完成".to_string();
                        }
                        entry.snapshot.message.clone()
                    };
                    (JobStatus::Succeeded, message, JobOutcome::Done(value))
                }
                Err(error) => (JobStatus::Failed, error.clone(), JobOutcome::Failed(error)),
            };
            {
                let mut entries = inner.entries();
                if let Some(entry) = entries.get_mut(&id) {
                    entry.snapshot.status = status;
                    entry.snapshot.message = message;
                    if status == JobStatus::Succeeded {
                        entry.snapshot.progress = Some(1.0);
                    }
                }
            }
            inner.notify(id);
            let _ = tx.send_blocking(outcome);
        });

        Job { id, result: rx }
    }

    pub fn cancel(&self, id: u64) {
        let mut changed = false;
        {
            let mut entries = self.inner.entries();
            if let Some(entry) = entries.get_mut(&id)
                && entry.snapshot.status.is_running()
            {
                entry.cancel.store(true, Ordering::SeqCst);
                entry.snapshot.message = "正在取消…".to_string();
                changed = true;
            }
        }
        if changed {
            self.inner.notify(id);
        }
    }

    pub fn snapshot(&self, id: u64) -> Option<JobSnapshot> {
        self.inner
            .entries()
            .get(&id)
            .map(|entry| entry.snapshot.clone())
    }

    pub fn snapshots(&self) -> Vec<JobSnapshot> {
        let mut snapshots = self
            .inner
            .entries()
            .values()
            .map(|entry| entry.snapshot.clone())
            .collect::<Vec<_>>();
        snapshots.sort_by_key(|snapshot| std::cmp::Reverse(snapshot.id));
        snapshots
    }
}

#[derive(Clone)]
pub struct JobContext {
    id: u64,
    inner: Arc<Inner>,
    canceled: Arc<AtomicBool>,
}

impl JobContext {
    pub fn progress(&self, fraction: Option<f32>, message: impl Into<String>) {
        let fraction = fraction.map(|value| value.clamp(0.0, 1.0));
        let message = message.into();
        self.update(|snapshot| {
            snapshot.progress = fraction;
            snapshot.message = message;
        });
    }

    pub fn log(&self, line: impl Into<String>) {
        let line = line.into();
        self.update(|snapshot| {
            snapshot.log.push(line);
            if snapshot.log.len() > LOG_LIMIT {
                snapshot.log.remove(0);
            }
        });
    }

    pub fn is_canceled(&self) -> bool {
        self.canceled.load(Ordering::SeqCst)
    }

    fn update(&self, apply: impl FnOnce(&mut JobSnapshot)) {
        let changed = {
            let mut entries = self.inner.entries();
            match entries.get_mut(&self.id) {
                Some(entry) if entry.snapshot.status.is_running() => {
                    apply(&mut entry.snapshot);
                    true
                }
                _ => false,
            }
        };
        if changed {
            self.inner.notify(self.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;
    use std::time::Duration;

    #[test]
    fn reports_progress_result_and_log() {
        let (jobs, _events) = Jobs::new();
        let job = jobs.start("test", |ctx| {
            ctx.progress(Some(0.5), "half");
            ctx.log("line");
            Ok(7)
        });
        assert!(matches!(
            job.result.recv_blocking(),
            Ok(JobOutcome::Done(7))
        ));
        let snapshot = jobs.snapshot(job.id).expect("snapshot");
        assert_eq!(snapshot.status, JobStatus::Succeeded);
        assert_eq!(snapshot.progress, Some(1.0));
        assert_eq!(snapshot.message, "half");
        assert_eq!(snapshot.log, vec!["line"]);
    }

    #[test]
    fn cancel_stops_at_the_next_checkpoint() {
        let (jobs, _events) = Jobs::new();
        let started = Arc::new(Barrier::new(2));
        let worker_started = started.clone();
        let job: Job<()> = jobs.start("cancel", move |ctx| {
            worker_started.wait();
            loop {
                if ctx.is_canceled() {
                    return Err("已取消".to_string());
                }
                std::thread::sleep(Duration::from_millis(5));
            }
        });
        started.wait();
        jobs.cancel(job.id);
        assert!(matches!(
            job.result.recv_blocking(),
            Ok(JobOutcome::Canceled)
        ));
        assert_eq!(
            jobs.snapshot(job.id).expect("snapshot").status,
            JobStatus::Canceled
        );
    }

    #[test]
    fn failure_is_reported() {
        let (jobs, _events) = Jobs::new();
        let job: Job<()> = jobs.start("fail", |_| Err("boom".to_string()));
        assert!(matches!(
            job.result.recv_blocking(),
            Ok(JobOutcome::Failed(message)) if message == "boom"
        ));
        let snapshot = jobs.snapshot(job.id).expect("snapshot");
        assert_eq!(snapshot.status, JobStatus::Failed);
        assert_eq!(snapshot.message, "boom");
    }
}
