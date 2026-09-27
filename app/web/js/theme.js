/**
 * 明暗主题：一处真相、两处持久化
 *
 * 为什么**主存 localStorage**、顺手备份进后端 config：
 *
 *  - localStorage 是**同步**的，`index.html` 里那段内联脚本能在**首次绘制前**读到它，
 *    所以页面不会先亮后暗地闪一下。后端 config 要等 `/api/state`（本机实测 3 秒多），
 *    只靠它必然闪 —— 这是选它当主存的唯一理由，也是决定性的理由。
 *  - 但 localStorage 挂在端口上（换端口、清掉 WebView2 缓存就没了），
 *    而端口现在是固定的 17878，所以正常情况下它能跨重启留存。
 *    为了那点万一，每次选择顺手写一份到 `app/data/config.json`
 *    （后端的 `config_post` 接受任意字段，不用改后端）。
 *  - 本地一个字都没存过时，用 config 里那份兜底（`adoptConfig`）。
 *
 * 取值 `'light' | 'dark' | 'system'`；`'system'` 与「没存过」都表示跟随系统。
 */

import { api } from './api.js'

const KEY = 'qingmu.theme'
const MQ = '(prefers-color-scheme: light)'
const VALID = ['light', 'dark', 'system']

function read() {
  try {
    return localStorage.getItem(KEY)
  } catch {
    return null
  }
}

function write(v) {
  try {
    localStorage.setItem(KEY, v)
  } catch {
    /* 隐私模式写不了：只影响本次会话，不影响当前显示 */
  }
}

/** 系统当前偏好（'light' | 'dark'） */
export function systemTheme() {
  return window.matchMedia?.(MQ).matches ? 'light' : 'dark'
}

/** 当前**生效**的主题 —— CSS 认的就是 <html data-theme> 这个值 */
export function currentTheme() {
  return document.documentElement.dataset.theme === 'light' ? 'light' : 'dark'
}

/** 用户的偏好，可能是 'system' */
export function themePref() {
  const v = read()
  return VALID.includes(v) ? v : 'system'
}

/** 应用偏好：写存储 + 落 <html data-theme> + 通知画布类组件重画 */
export function applyTheme(pref, { persist = true } = {}) {
  const p = VALID.includes(pref) ? pref : 'system'
  if (persist) {
    write(p)
    // 备份进 config.json（失败不影响本次使用，所以不 await、不报错）
    api.saveConfig({ theme: p }).catch(() => {})
  }
  const eff = p === 'system' ? systemTheme() : p
  document.documentElement.dataset.theme = eff
  // 波形图是画在 canvas 上的，拿不到 CSS 变量，只能让它自己按新配色重画一遍
  document.dispatchEvent(new CustomEvent('qm:theme', { detail: { pref: p, theme: eff } }))
  return eff
}

/** 顶栏那个小图标按钮：亮暗互切（偏好是 system 时，切到当前生效的相反面） */
export function toggleTheme() {
  return applyTheme(currentTheme() === 'dark' ? 'light' : 'dark')
}

/** 跟随系统：用户手动选过就一直听用户的，还是 'system' 时随系统实时变 */
export function watchSystem() {
  const mq = window.matchMedia?.(MQ)
  if (!mq) return
  mq.addEventListener('change', () => {
    if (themePref() === 'system') applyTheme('system', { persist: false })
  })
}

/**
 * 本地没存过时，用后端 config 里那份把选择找回来（换端口、清过 WebView2 缓存的情况）。
 * @returns {boolean} 是否真的采纳了
 */
export function adoptConfig(pref) {
  if (read() !== null || !VALID.includes(pref)) return false
  write(pref)
  applyTheme(pref, { persist: false })
  return true
}
