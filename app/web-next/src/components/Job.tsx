import { GlassProgress } from '@ttqtt/liquid-glass-react'
import { Button } from '@/components/Button'
import type { Job } from '@/lib/types'

/**
 * 任务进度 —— 长任务一律显示它（AGENTS.md 的硬性要求）。
 *
 * 用**库的 `GlassProgress`**：`percent` 是 0~100，所以 `total` 给 100。
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
      <GlassProgress aria-label="任务进度" value={pct} total={100} />
      {job.status === 'error' && job.error && <p className="finding-text">失败：{job.error}</p>}
      {job.status === 'canceled' && <p className="job-note">已取消</p>}
      {job.logs && job.logs.length > 0 && (
        /* 日志只留最后 200 行：后端会一直追加，全渲染会把 DOM 撑爆 */
        <pre className="job-log">{job.logs.slice(-200).join('\n')}</pre>
      )}
    </div>
  )
}
