/**
 * 全局任务悬浮窗
 *
 * 轮询后端任务列表，把正在跑（以及刚结束）的任务显示在右下角，
 * 这样切到别的视图也不会「看不见进度」。完成后自动消失。
 */

import { api } from '../api.js'
import { h, mount, icon, toast } from '../ui.js'

const POLL_MS = 2000
const KEEP_DONE_MS = 9000
const MAX_SHOWN = 4

export function startJobDock() {
  const dock = h('div.dock', { style: { display: 'none' } })
  document.body.appendChild(dock)

  let stopped = false

  async function tick() {
    if (stopped) return
    try {
      const { jobs } = await api.jobs()
      const now = Date.now()
      const active = jobs.filter((j) => j.status === 'running' || j.status === 'queued')
      const justDone = jobs.filter(
        (j) => !['running', 'queued'].includes(j.status) && now - (j.finishedAt ?? j.createdAt) < KEEP_DONE_MS
      )
      const shown = [...active, ...justDone].slice(0, MAX_SHOWN)

      if (!shown.length) {
        dock.style.display = 'none'
        return
      }
      dock.style.display = 'flex'
      mount(dock, shown.map(renderJob))
    } catch {
      dock.style.display = 'none'
    }
  }

  function renderJob(job) {
    const running = job.status === 'running' || job.status === 'queued'
    const stateClass = job.status === 'done' ? 'done' : job.status === 'error' ? 'error' : job.status === 'canceled' ? 'canceled' : ''
    const statusIcon = {
      running: 'activity',
      queued: 'clock',
      done: 'check',
      error: 'alert',
      canceled: 'x',
    }[job.status] ?? 'info'
    const statusColor = {
      done: 'var(--ok)',
      error: 'var(--err)',
      canceled: 'var(--text-3)',
    }[job.status] ?? 'var(--accent)'

    const bar = h('div.progress', [h('div.progress-bar', { style: { width: `${job.percent ?? 0}%` } })])
    const inner = bar.firstChild
    if (stateClass) inner.classList.add(stateClass)

    return h('div.job-row.card', { style: { padding: '11px 12px', background: 'var(--bg-1)', boxShadow: 'var(--shadow)' } }, [
      h('div.job-head', [
        h('span', { style: { color: statusColor, display: 'grid', placeItems: 'center' } }, [icon(statusIcon, 14)]),
        h('span.truncate.strong', { style: { flex: '1' }, title: job.title }, job.title || '任务'),
        running
          ? h('button.btn.btn-ghost.btn-icon.btn-sm', {
              title: '取消任务',
              onclick: async () => {
                try {
                  await api.cancelJob(job.id)
                  toast('已请求取消', 'info')
                  tick()
                } catch (err) {
                  toast(err.message, 'err')
                }
              },
            }, [icon('x', 12)])
          : null,
      ]),
      bar,
      h('div.job-msg.truncate', { title: job.message ?? '' },
        running
          ? `${job.message ?? '处理中'}　${Math.round(job.percent ?? 0)}%`
          : (job.error ?? job.message ?? '已完成')),
    ])
  }

  const timer = setInterval(tick, POLL_MS)
  tick()

  return () => {
    stopped = true
    clearInterval(timer)
    dock.remove()
  }
}

export default { startJobDock }
