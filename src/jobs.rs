//! GPUI 侧的任务表副本，供页面读取与取消。

use gpui_kit::*;

use crate::services::jobs::{Job, JobContext, JobSnapshot, Jobs};

pub struct JobCenter {
    jobs: Jobs,
    snapshots: Vec<JobSnapshot>,
}

impl JobCenter {
    pub fn new(cx: &mut Context<Self>) -> Self {
        let (jobs, events) = Jobs::new();
        let listener = jobs.clone();
        cx.spawn(async move |this, cx| {
            while events.recv().await.is_ok() {
                let snapshots = listener.snapshots();
                let Some(this) = this.upgrade() else {
                    break;
                };
                this.update(cx, |this, cx| {
                    this.snapshots = snapshots;
                    cx.notify();
                });
            }
        })
            .detach();
        Self {
            jobs,
            snapshots: Vec::new(),
        }
    }

    pub fn start<T, F>(&self, title: impl Into<String>, work: F) -> Job<T>
    where
        T: Send + 'static,
        F: FnOnce(JobContext) -> Result<T, String> + Send + 'static,
    {
        self.jobs.start(title, work)
    }

    pub fn cancel(&self, id: u64) {
        self.jobs.cancel(id);
    }

    pub fn is_running(&self, id: u64) -> bool {
        self.jobs
            .snapshot(id)
            .is_some_and(|snapshot| snapshot.status.is_running())
    }

    pub fn snapshot(&self, id: u64) -> Option<JobSnapshot> {
        self.jobs.snapshot(id)
    }

    pub fn snapshots(&self) -> &[JobSnapshot] {
        &self.snapshots
    }
}
