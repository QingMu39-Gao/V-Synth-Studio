/**
 * 格式化 —— 旧前端 `app/web/js/ui.js` 里那几个 `format*` 的 1:1 移植。
 * 保持一致很重要：同一份数据在旧页面和新页面里要显示成同一个样子。
 */

export function formatBytes(n: number | undefined | null): string {
  if (!Number.isFinite(n) || (n as number) <= 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n as number
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(i === 0 ? 0 : v < 10 ? 2 : 1)} ${units[i]}`
}

export function formatDuration(sec: number | undefined | null): string {
  if (!Number.isFinite(sec) || (sec as number) < 0) return '-'
  const s = Math.round(sec as number)
  const m = Math.floor(s / 60)
  const ss = s % 60
  if (m >= 60) {
    const hh = Math.floor(m / 60)
    return `${hh}:${String(m % 60).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
  }
  return `${m}:${String(ss).padStart(2, '0')}`
}

export function formatSpeed(bytesPerSec: number | undefined | null): string {
  if (!Number.isFinite(bytesPerSec) || (bytesPerSec as number) <= 0) return ''
  return `${formatBytes(bytesPerSec)}/s`
}

export function formatNumber(n: number | undefined | null): string {
  if (!Number.isFinite(n)) return '-'
  const v = n as number
  if (v >= 100000000) return `${(v / 100000000).toFixed(1)} 亿`
  if (v >= 10000) return `${(v / 10000).toFixed(1)} 万`
  return String(v)
}

export function formatTime(ts: number | undefined | null): string {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (x: number) => String(x).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 相对时间 */
export function timeAgo(ts: number): string {
  const diff = Date.now() - ts
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  return `${Math.floor(diff / 86400000)} 天前`
}
