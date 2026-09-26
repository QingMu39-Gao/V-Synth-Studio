/**
 * 时间码：parseTime / formatTime
 *
 * 界面上让用户填「几分几秒」而不是裸秒数 —— 裸秒数要人自己心算，填 1:23.456
 * 一眼就知道在哪儿。解析刻意宽容，因为用户常常是从播放器上抄一个时间过来：
 *
 *   83        → 83 秒
 *   1:23      → 1 分 23 秒
 *   1:23.456  → 带毫秒
 *   0:05      → 5 秒
 *   1:02:03   → 时:分:秒（超过 1 小时才用得上）
 *
 * 后面的段允许溢出（1:75 当作 135 秒），从别处抄来的时间不该因为「秒超过 60」
 * 就被打回去。真正的非法输入（空串、负数、字母、1: 这种半截）返回 null，
 * 由调用方决定是还原旧值还是提示。
 *
 * 自测：tests/unit/timecode.test.mjs（node tests/unit/timecode.test.mjs）
 */

const MS = 1000

/** 统一到毫秒精度，避免 0.1+0.2 那种浮点尾巴渗进输入框 */
const toMs = (sec) => Math.round(sec * MS) / MS

/**
 * 宽松解析时间码。非法输入返回 null。
 * @param {string|number} input
 * @returns {number|null} 秒
 */
export function parseTime(input) {
  if (typeof input === 'number') return Number.isFinite(input) && input >= 0 ? toMs(input) : null
  if (typeof input !== 'string') return null

  const text = input.trim()
  // 先挡掉空串、负数、字母和其它杂字符，后面就能安心按冒号切
  if (!text || !/^[\d:.]+$/.test(text)) return null

  const parts = text.split(':')
  if (parts.length > 3) return null // 时:分:秒 已经够用，再多是乱输

  let total = 0
  for (const part of parts) {
    if (part === '') return null // "1:" / ":23" 这种半截输入不猜
    const n = Number(part)
    if (!Number.isFinite(n) || n < 0) return null
    total = total * 60 + n
  }
  return toMs(total)
}

/**
 * 秒 → 时间码。1 小时以内 `m:ss.mmm`，超过给 `h:mm:ss.mmm`。
 * 非法/负数一律当 0（输入框里放个 NaN 没有任何意义）。
 * @param {number} sec
 * @returns {string}
 */
export function formatTime(sec) {
  const n = Number(sec)
  const ms = Number.isFinite(n) && n > 0 ? Math.round(n * MS) : 0

  const h = Math.floor(ms / 3600000)
  const m = Math.floor(ms / 60000) % 60
  const s = Math.floor(ms / MS) % 60
  const milli = ms % MS

  const minutes = h ? String(m).padStart(2, '0') : String(m)
  return `${h ? `${h}:` : ''}${minutes}:${String(s).padStart(2, '0')}.${String(milli).padStart(3, '0')}`
}

export default { parseTime, formatTime }
