/**
 * UI 基础库：SVG 图标、DOM 构造、通知、模态框、格式化
 * 不依赖任何框架。
 */

/* ------------------------------------------------------------------ 图标 */

const ICON_PATHS = {
  home: 'M3 10.5 12 3l9 7.5V20a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
  swap: 'M7 4v13m0 0-3-3m3 3 3-3M17 20V7m0 0 3 3m-3-3-3 3',
  video: 'M15 10l5.5-3.2v10.4L15 14M4 6h11a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1z',
  wave: 'M3 12h2l2-6 3 12 3-9 2 5 2-3h4',
  library: 'M4 5h5v14H4zM11 5h4v14h-4zM17.5 5.6l3 13-3.6.8-3-13z',
  gear: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2V21a2 2 0 1 1-4 0v-.1A1.7 1.7 0 0 0 7 19.4a1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0-1.2-2.9H1a2 2 0 1 1 0-4h.1A1.7 1.7 0 0 0 2.6 7a1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 7 2.6h.1A1.7 1.7 0 0 0 8.3 1V1a2 2 0 1 1 4 0v.1A1.7 1.7 0 0 0 15 2.6h.1a1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9v.1a1.7 1.7 0 0 0 1.5 1.2H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1.2z',
  play: 'M7 4.5v15l13-7.5z',
  folder: 'M3 7a1 1 0 0 1 1-1h5l2 2h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z',
  file: 'M14 3v5h5M14 3H7a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V8z',
  check: 'M4 12.5 9 17.5 20 6.5',
  x: 'M6 6l12 12M18 6 6 18',
  alert: 'M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z',
  info: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 16v-4M12 8h.01',
  refresh: 'M21 12a9 9 0 1 1-3-6.7M21 4v5h-5',
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  chevronRight: 'M9 6l6 6-6 6',
  chevronLeft: 'M15 6l-6 6 6 6',
  chevronUp: 'M6 15l6-6 6 6',
  chevronDown: 'M6 9l6 6 6-6',
  upload: 'M12 16V4m0 0L7 9m5-5 5 5M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2',
  download: 'M12 4v12m0 0 5-5m-5 5-5-5M4 19h16',
  trash: 'M4 7h16M9 7V5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M6 7l1 13a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1l1-13',
  plus: 'M12 5v14M5 12h14',
  cpu: 'M6 6h12v12H6zM9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3',
  package: 'M12 2 3 7v10l9 5 9-5V7zM3 7l9 5 9-5M12 12v10',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  music: 'M9 18V5l10-2v13M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM19 16a3 3 0 1 1-6 0 3 3 0 0 1 6 0z',
  scissors: 'M6 4l12 12M18 4 6 16M8 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM21 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z',
  disc: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 14.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z',
  link: 'M10 13a5 5 0 0 0 7 0l3-3a5 5 0 0 0-7-7l-1 1M14 11a5 5 0 0 0-7 0l-3 3a5 5 0 0 0 7 7l1-1',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 7v5l3 2',
  zap: 'M13 2 4 14h7l-1 8 9-12h-7z',
  star: 'M12 3l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 18l-5.9 3 1.2-6.5L2.5 9.9 9.1 9z',
  book: 'M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z',
  tool: 'M14.7 6.3a4 4 0 0 0 5 5l-9.4 9.4a2.1 2.1 0 0 1-3-3z M17 3l4 4',
  film: 'M4 4h16v16H4zM4 9h16M4 15h16M9 4v16M15 4v16',
  image: 'M4 5h16v14H4zM8.5 11a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3zM5 17l4.5-5 3 3 2.5-2.5L20 17',
  pause: 'M8 5v14M16 5v14',
  grip: 'M9 6h.01M9 12h.01M9 18h.01M15 6h.01M15 12h.01M15 18h.01',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
  activity: 'M22 12h-4l-3 9L9 3l-3 9H2',
  layers: 'M12 2 2 7l10 5 10-5zM2 12l10 5 10-5M2 17l10 5 10-5',
  save: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2zM17 21v-8H7v8M7 3v5h8',
  edit: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z',
  globe: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM2 12h20M12 2a15 15 0 0 1 0 20 15 15 0 0 1 0-20z',
}

/** 生成 SVG 图标元素 */
export function icon(name, size = 16, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 24 24')
  svg.setAttribute('fill', 'none')
  svg.setAttribute('stroke', 'currentColor')
  svg.setAttribute('stroke-width', '1.8')
  svg.setAttribute('stroke-linecap', 'round')
  svg.setAttribute('stroke-linejoin', 'round')
  svg.setAttribute('width', size)
  svg.setAttribute('height', size)
  if (className) svg.setAttribute('class', className)
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', ICON_PATHS[name] ?? ICON_PATHS.info)
  svg.appendChild(path)
  return svg
}

/** 生成图标 HTML 字符串（用于模板字符串） */
export function iconHtml(name, size = 16) {
  const d = ICON_PATHS[name] ?? ICON_PATHS.info
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" width="${size}" height="${size}"><path d="${d}"/></svg>`
}

/* ------------------------------------------------------------------ DOM */

/**
 * 创建元素
 * h('div.card', {onclick}, [h('span', 'hi')])
 * h('div', {class:'x', html:'<b>粗</b>'})
 */
export function h(tag, props = null, children = null) {
  const [name, ...classes] = String(tag).split('.')
  const el = document.createElement(name || 'div')
  if (classes.length) el.className = classes.join(' ')

  if (props && typeof props === 'object' && !Array.isArray(props) && !(props instanceof Node)) {
    for (const [k, v] of Object.entries(props)) {
      if (v === null || v === undefined || v === false) continue
      if (k === 'class' || k === 'className') el.className = [el.className, v].filter(Boolean).join(' ')
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v)
      else if (k === 'html') el.innerHTML = v
      else if (k === 'text') el.textContent = v
      else if (k === 'dataset') Object.assign(el.dataset, v)
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v)
      else if (k === 'value') el.value = v
      else if (k === 'checked' || k === 'disabled' || k === 'selected') el[k] = !!v
      else el.setAttribute(k, v)
    }
  } else if (props !== null && props !== undefined) {
    children = props
  }

  appendChildren(el, children)
  return el
}

function appendChildren(el, children) {
  if (children === null || children === undefined || children === false) return
  if (Array.isArray(children)) {
    for (const c of children) appendChildren(el, c)
    return
  }
  if (children instanceof Node) {
    el.appendChild(children)
    return
  }
  el.appendChild(document.createTextNode(String(children)))
}

export function clear(el) {
  while (el.firstChild) el.removeChild(el.firstChild)
  return el
}

export function mount(parent, ...children) {
  clear(parent)
  appendChildren(parent, children)
  return parent
}

export const $ = (sel, root = document) => root.querySelector(sel)
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]

/* ------------------------------------------------------------ 通知 */

function ensureToaster() {
  let t = document.getElementById('toaster')
  if (!t) {
    t = h('div.toaster', { id: 'toaster' })
    document.body.appendChild(t)
  }
  return t
}

/**
 * 弹出通知
 * @param {string} message
 * @param {'info'|'ok'|'err'|'warn'} type
 * @param {{duration?:number, title?:string}} opts
 */
export function toast(message, type = 'info', opts = {}) {
  const duration = opts.duration ?? (type === 'err' ? 6500 : 3600)
  const iconName = { ok: 'check', err: 'alert', warn: 'alert', info: 'info' }[type] ?? 'info'
  const el = h(`div.toast.${type}`, [
    icon(iconName, 16),
    h('div.toast-body', [
      opts.title ? h('div.strong', opts.title) : null,
      h('div', String(message)),
    ]),
  ])
  ensureToaster().appendChild(el)
  const remove = () => {
    el.classList.add('leaving')
    setTimeout(() => el.remove(), 220)
  }
  const timer = setTimeout(remove, duration)
  el.addEventListener('click', () => {
    clearTimeout(timer)
    remove()
  })
  return remove
}

/* ------------------------------------------------------------ 模态框 */

/**
 * 打开模态框
 * @param {{title:string, body:Node|string, footer?:Node[], wide?:boolean, onClose?:Function}} opts
 * @returns {{close:Function, root:HTMLElement}}
 */
export function modal(opts) {
  const root = document.getElementById('modal-root') ?? document.body
  const backdrop = h('div.modal-backdrop')
  const bodyEl = h('div.modal-body')
  appendChildren(bodyEl, opts.body)

  const closeBtn = h('button.btn.btn-ghost.btn-icon.btn-sm', { onclick: () => close(), title: '关闭' }, [icon('x', 15)])
  const box = h(`div.modal${opts.wide ? '.wide' : ''}`, [
    h('div.modal-head', [h('h2', opts.title ?? ''), closeBtn]),
    bodyEl,
    opts.footer ? h('div.modal-foot', opts.footer) : null,
  ])
  backdrop.appendChild(box)

  const onKey = (e) => {
    if (e.key === 'Escape') close()
  }
  const close = () => {
    if (!backdrop.isConnected) return
    document.removeEventListener('keydown', onKey)
    backdrop.style.animation = 'fadeIn 160ms reverse'
    setTimeout(() => {
      backdrop.remove()
      opts.onClose?.()
    }, 140)
  }
  backdrop.addEventListener('mousedown', (e) => {
    if (e.target === backdrop) close()
  })
  document.addEventListener('keydown', onKey)
  root.appendChild(backdrop)
  return { close, root: backdrop, body: bodyEl }
}

/** 确认对话框 */
export function confirmDialog(opts) {
  return new Promise((resolve) => {
    const { close } = modal({
      title: opts.title ?? '确认',
      body: h('div', [h('p', opts.message ?? ''), opts.detail ? h('div.small.muted', opts.detail) : null]),
      footer: [
        h('button.btn', { onclick: () => { close(); resolve(false) } }, [opts.cancelText ?? '取消']),
        h(`button.btn.${opts.danger ? 'btn-danger' : 'btn-primary'}`, { onclick: () => { close(); resolve(true) } }, [opts.confirmText ?? '确定']),
      ],
      onClose: () => resolve(false),
    })
  })
}

/** 输入对话框 */
export function promptDialog(opts) {
  return new Promise((resolve) => {
    const input = h('input.input', { value: opts.value ?? '', placeholder: opts.placeholder ?? '' })
    const { close } = modal({
      title: opts.title ?? '输入',
      body: h('div.field', [opts.label ? h('label.field-label', opts.label) : null, input]),
      footer: [
        h('button.btn', { onclick: () => { close(); resolve(null) } }, ['取消']),
        h('button.btn.btn-primary', { onclick: () => { close(); resolve(input.value) } }, ['确定']),
      ],
      onClose: () => resolve(null),
    })
    setTimeout(() => input.focus(), 60)
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        close()
        resolve(input.value)
      }
    })
  })
}

/* ------------------------------------------------------------ 格式化 */

export function formatBytes(n) {
  if (!Number.isFinite(n) || n <= 0) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(i === 0 ? 0 : v < 10 ? 2 : 1)} ${units[i]}`
}

export function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '-'
  const s = Math.round(sec)
  const m = Math.floor(s / 60)
  const ss = s % 60
  if (m >= 60) {
    const hh = Math.floor(m / 60)
    return `${hh}:${String(m % 60).padStart(2, '0')}:${String(ss).padStart(2, '0')}`
  }
  return `${m}:${String(ss).padStart(2, '0')}`
}

export function formatSpeed(bytesPerSec) {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return ''
  return `${formatBytes(bytesPerSec)}/s`
}

export function formatNumber(n) {
  if (!Number.isFinite(n)) return '-'
  if (n >= 100000000) return `${(n / 100000000).toFixed(1)} 亿`
  if (n >= 10000) return `${(n / 10000).toFixed(1)} 万`
  return String(n)
}

export function formatTime(ts) {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (x) => String(x).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

/** 相对时间 */
export function timeAgo(ts) {
  const diff = Date.now() - ts
  if (diff < 60000) return '刚刚'
  if (diff < 3600000) return `${Math.floor(diff / 60000)} 分钟前`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)} 小时前`
  return `${Math.floor(diff / 86400000)} 天前`
}

/* ------------------------------------------------------------ 组件工厂 */

export function button(label, { onClick, variant = '', iconName, size = '', disabled = false, title = '' } = {}) {
  const btn = h(`button.btn${variant ? '.' + variant : ''}${size ? '.' + size : ''}`, {
    onclick: onClick,
    disabled,
    title: title || undefined,
  }, [iconName ? icon(iconName, size === 'btn-sm' ? 13 : 15) : null, label])
  return btn
}

export function switchToggle(checked, onChange) {
  const el = h(`button.switch${checked ? '.on' : ''}`, { type: 'button' })
  el.addEventListener('click', () => {
    const next = !el.classList.contains('on')
    el.classList.toggle('on', next)
    onChange(next)
  })
  return el
}

export function progressBar(percent = 0, { size = '' } = {}) {
  const bar = h(`div.progress-bar${size === 'lg' ? '' : ''}`)
  bar.style.width = `${Math.max(0, Math.min(100, percent))}%`
  const wrap = h(`div.progress${size ? '.progress-' + size : ''}`, [bar])
  wrap.setBar = (p, state) => {
    bar.style.width = `${Math.max(0, Math.min(100, p))}%`
    bar.classList.toggle('done', state === 'done')
    bar.classList.toggle('error', state === 'error')
    bar.classList.toggle('canceled', state === 'canceled')
  }
  return wrap
}

export function emptyState({ iconName = 'info', title, desc, action } = {}) {
  return h('div.empty', [
    h('div.empty-icon', [icon(iconName, 24)]),
    title ? h('h3', title) : null,
    desc ? h('p', desc) : null,
    action ?? null,
  ])
}

export function alertBox(type, message, title) {
  const iconName = { warn: 'alert', err: 'alert', ok: 'check', info: 'info' }[type] ?? 'info'
  return h(`div.alert.alert-${type}`, [
    icon(iconName, 16),
    h('div.alert-body', [title ? h('strong', title) : null, h('div', { html: message })]),
  ])
}

export function statBlock(label, value, { sub, color = '' } = {}) {
  return h('div.stat', [
    h('div.stat-label', label),
    h(`div.stat-value${color ? '.' + color : ''}`, String(value)),
    sub ? h('div.stat-sub', sub) : null,
  ])
}

export function card({ title, sub, iconName, iconColor = '', actions, body, className = '' }) {
  return h(`div.card${className ? '.' + className : ''}`, [
    title || actions
      ? h('div.card-head', [
          iconName ? h(`div.card-icon${iconColor ? '.' + iconColor : ''}`, [icon(iconName, 16)]) : null,
          h('div', [h('h2', title ?? ''), sub ? h('div.sub', sub) : null]),
          h('div.spacer'),
          actions ?? null,
        ])
      : null,
    body,
  ])
}

export function tabs(items, activeId, onChange) {
  const el = h('div.tabs')
  for (const item of items) {
    el.appendChild(
      h(`button.tab${item.id === activeId ? '.active' : ''}`, { onclick: () => onChange(item.id) }, [
        item.label,
        item.count !== undefined ? h('span.chip', { style: { marginLeft: '6px' } }, String(item.count)) : null,
      ])
    )
  }
  return el
}

export function segmented(items, active, onChange) {
  const el = h('div.segmented')
  for (const item of items) {
    el.appendChild(
      h(`button${item.value === active ? '.active' : ''}`, { onclick: () => onChange(item.value) }, [item.label])
    )
  }
  return el
}

export default {
  icon, iconHtml, h, clear, mount, $, $$,
  toast, modal, confirmDialog, promptDialog,
  formatBytes, formatDuration, formatSpeed, formatNumber, formatTime, timeAgo,
  button, switchToggle, progressBar, emptyState, alertBox, statBlock, card, tabs, segmented,
}
