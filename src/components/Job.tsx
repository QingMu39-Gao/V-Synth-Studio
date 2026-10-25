import {Button} from '@/components/Button'
import {Chip, ProgressBar} from '@/components/Panel'
import type {Job} from '@/lib/types'

/* ── 状态 → 芯片 ─────────────────────────────────────────────
   文案和色调只这一份：三页各写一套嵌套三元，加一个终态就要改三遍，而且早就漂了。 */

export type JobStatus = 'queued' | 'running' | 'done' | 'error' | 'canceled'

const JOB_STATUS: Record<JobStatus, { tone: 'default' | 'ok' | 'warn' | 'err' | 'accent'; label: string }> = {
    queued: {tone: 'default', label: '等待中'},
    running: {tone: 'accent', label: '运行中'},
    done: {tone: 'ok', label: '完成'},
    error: {tone: 'err', label: '失败'},
    canceled: {tone: 'warn', label: '已取消'},
}

export function jobStatusText(status: JobStatus): string {
    return JOB_STATUS[status].label
}

/** 只要色调、文案自己定（比如队列那一行要把 running 说成「下载中」）时用这个 */
export function jobStatusTone(status: JobStatus): 'default' | 'ok' | 'warn' | 'err' | 'accent' {
    return JOB_STATUS[status].tone
}

export function JobStatusChip({status}: { status: JobStatus }) {
    const {tone, label} = JOB_STATUS[status]
    return <Chip tone={tone}>{label}</Chip>
}

/**
 * 上游分离任务的状态词表和后端任务不是一套（`task_manager.py` 写 `cancelled`，
 * 失败还分 `error` / `failed`），先进这个函数归一，再交给上面的映射。
 */
export function svsepTaskStatus(s: string | undefined): JobStatus {
    if (s === 'done') return 'done'
    if (s === 'cancelled' || s === 'canceled') return 'canceled'
    if (s === 'error' || s === 'failed') return 'error'
    return 'running'
}

/**
 * 任务进度 —— 长任务一律显示它（AGENTS.md 的硬性要求）。
 *
 * 「取消」只在 running 时出现；终态（done/error/canceled）由调用方的 toast 说明结果，
 * 这里只把状态落在标签上，别让用户盯着一根 100% 的条猜到底成没成。
 */

export function JobProgress({
                                job,
                                onCancel,
                                title,
                            }: {
    job: Job | null
    onCancel?: (id: string) => void
    title?: string
}) {
    if (!job) return null
    const pct = Math.max(0, Math.min(100, job.percent ?? 0))
    return (
        <div className="job" data-status={job.status}>
            <div className="job-head">
                <span className="job-title">{title ?? job.title ?? '任务'}</span>
                <span className="job-message">{job.message ?? ''}</span>
                <span className="job-pct">{pct}%</span>
                {job.status === 'running' && onCancel && (
                    <Button size="sm" variant="ghost" onClick={() => onCancel(job.id)}>
                        取消
                    </Button>
                )}
            </div>
            <ProgressBar pct={pct}/>
            {job.status === 'error' && job.error && <p className="finding-text">失败：{job.error}</p>}
            {job.status === 'canceled' && <p className="job-note">已取消</p>}
            {job.logs && job.logs.length > 0 && (
                /* 日志只留最后 200 行：后端会一直追加，全渲染会把 DOM 撑爆 */
                <pre className="job-log">{job.logs.slice(-200).join('\n')}</pre>
            )}
        </div>
    )
}
