/**
 * 格式化 —— 旧界面里那几个 `format*` 的 1:1 移植。
 * 保持一致很重要：同一份数据在不同页面里要显示成同一个样子。
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

export function formatNumber(n: number | undefined | null): string {
  if (!Number.isFinite(n)) return '-'
  const v = n as number
  if (v >= 100000000) return `${(v / 100000000).toFixed(1)} 亿`
  if (v >= 10000) return `${(v / 10000).toFixed(1)} 万`
  return String(v)
}
