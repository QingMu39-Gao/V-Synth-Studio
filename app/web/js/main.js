/* 清沐的虚拟歌姬工作站 · QingMu39 */
/**
 * 应用入口：状态、路由、视图挂载
 */

import { api } from './api.js'
import { h, mount, icon, toast } from './ui.js'

/* ------------------------------------------------------------ 视图注册 */

const VIEWS = [
  { id: 'dashboard', title: '总览', sub: '环境检测与常用入口', iconName: 'home', group: '工作台' },
  { id: 'convert', title: '工程转换', sub: '离线把工程转到另一个编辑器', iconName: 'swap', group: '工作台' },
  { id: 'video', title: '视频解析', sub: 'B 站 / YouTube 等平台的 MV 下载', iconName: 'video', group: '素材获取' },
  { id: 'audio', title: '音频工具', sub: '人声分离 / 格式转换 / 变调变速', iconName: 'wave', group: '素材获取' },
  { id: 'lyrics', title: '歌词', sub: '网易云 / QQ 音乐搜词，导出 LRC · SRT', iconName: 'music', group: '素材获取' },
  { id: 'pv', title: '文字 PV', sub: '把歌词做成动态歌词视频（JIZURA，本地运行）', iconName: 'film', group: '素材获取' },
  { id: 'resources', title: '资源库', sub: '立绘、声库、插件、音源站（仅链接）', iconName: 'library', group: '素材获取' },
  { id: 'settings', title: '设置', sub: '路径、Cookie、外部工具', iconName: 'gear', group: '系统' },
]

/* ------------------------------------------------------------ 全局状态 */

export const state = {
  ready: false,
  formats: [],
  editors: [],
  tools: {},
  transformOps: [],
  audioFormats: {},
  config: {},
  paths: {},
  pinyin: {},
  platform: '',
  version: '',
}

const viewModules = new Map()
let currentView = null
let currentCleanup = null
/** 最近一次导航带的参数，重渲染时要复用 */
let lastParams = {}

/* ------------------------------------------------------------ 导航 */

function buildNav() {
  const nav = document.getElementById('nav')
  mount(nav, null)
  let lastGroup = null
  for (const view of VIEWS) {
    if (view.group !== lastGroup) {
      nav.appendChild(h('div.nav-section', view.group))
      lastGroup = view.group
    }
    const btn = h('button.nav-item', { dataset: { view: view.id }, onclick: () => navigate(view.id) }, [
      icon(view.iconName, 17),
      h('span', view.title),
    ])
    nav.appendChild(btn)
  }
}

function highlightNav(viewId) {
  for (const el of document.querySelectorAll('.nav-item')) {
    el.classList.toggle('active', el.dataset.view === viewId)
  }
}

async function loadViewModule(id) {
  if (viewModules.has(id)) return viewModules.get(id)
  try {
    const mod = await import(`./views/${id}.js`)
    viewModules.set(id, mod)
    return mod
  } catch (err) {
    console.error(`加载视图 ${id} 失败：`, err)
    return null
  }
}

/**
 * 切换视图
 * @param {string} id
 * @param {object} params 传给视图的参数（如跳转时预填）
 */
export async function navigate(id, params = {}) {
  const def = VIEWS.find((v) => v.id === id)
  if (!def) return
  // 记住当前参数：boot() 在拿到状态后会再导航一次，若不带上参数
  // 就会出现「用 #/settings/tools 进来，一闪又回到默认节」这种问题
  lastParams = { ...params }
  if (currentCleanup) {
    try {
      currentCleanup()
    } catch {
      /* ignore */
    }
    currentCleanup = null
  }

  highlightNav(id)
  location.hash = params.section ? `#/${id}/${params.section}` : `#/${id}`
  setViewChrome(def)

  const viewEl = document.getElementById('view')
  const headerActions = document.getElementById('header-actions')
  mount(headerActions, null)
  mount(viewEl, h('div.empty', [h('div.skeleton', { style: { width: '100%', height: '90px', marginBottom: '14px' } })]))

  const mod = await loadViewModule(id)
  if (!mod) {
    mount(viewEl, h('div.alert.alert-err', '视图加载失败，请刷新页面'))
    return
  }

  viewEl.classList.remove('view-enter')
  void viewEl.offsetWidth
  viewEl.classList.add('view-enter')
  viewEl.scrollTop = 0

  currentView = id
  try {
    const result = await mod.render({
      container: viewEl,
      headerActions,
      params,
      state,
      navigate,
      refreshState,
    })
    if (typeof result === 'function') currentCleanup = result
    else if (result?.destroy) currentCleanup = () => result.destroy()
  } catch (err) {
    console.error(err)
    mount(viewEl, h('div.alert.alert-err', [
      h('div.alert-body', [h('strong', '视图渲染出错'), h('div', String(err.message ?? err))]),
    ]))
  }
}

/* ------------------------------------------------------------ 状态刷新 */

export async function refreshState({ silent = true } = {}) {
  try {
    const data = await api.state()
    Object.assign(state, {
      ready: true,
      formats: data.formats ?? [],
      editors: data.editors ?? [],
      tools: data.tools ?? {},
      transformOps: data.transformOps ?? [],
      audioFormats: data.audioFormats ?? {},
      config: data.config ?? {},
      paths: data.paths ?? {},
      pinyin: data.pinyin ?? {},
      platform: data.platform ?? '',
      version: data.version ?? '1.0.0',
    })
    padStatus()
    return state
  } catch (err) {
    if (!silent) toast(`读取状态失败：${err.message}`, 'err')
    throw err
  }
}

function padStatus() {
  const dot = document.getElementById('status-dot')
  const text = document.getElementById('status-text')
  const availableFormats = state.formats.filter((f) => f.available).length
  if (dot) dot.style.background = 'var(--ok)'
  if (text) text.textContent = `${availableFormats} 种格式`
  const vt = document.getElementById('version-text')
  if (vt) {
    const missing = []
    if (!state.tools?.ffmpeg?.available) missing.push('ffmpeg')
    if (!state.tools?.ytdlp?.available) missing.push('yt-dlp')
    vt.textContent = missing.length ? `v1.0.0 · 未安装：${missing.join(' / ')}` : 'v1.0.0 · 工具齐备'
  }
}

/* ------------------------------------------------------------ 启动 */

/// 视图的标题栏（navigate 和骨架共用）
function setViewChrome(def) {
  document.title = `${def.title} · 清沐的虚拟歌姬工作站`
  document.getElementById('view-title').textContent = def.title
  document.getElementById('view-sub').textContent = def.sub
}

/// 状态还没回来时的占位
function showSkeleton(id) {
  const def = VIEWS.find((v) => v.id === id)
  if (def) {
    highlightNav(id)
    setViewChrome(def)
  }
  mount(document.getElementById('view'), h('div.empty', [h('div.skeleton', { style: { width: '100%', height: '90px', marginBottom: '14px' } })]))
}

async function boot() {
  buildNav()

  const initialMatch = location.hash.match(/^#\/(\w+)(?:\/([\w-]+))?/)
  const initial = initialMatch?.[1] ?? 'dashboard'
  const initialParam = initialMatch?.[2]
  const id = VIEWS.some((v) => v.id === initial) ? initial : 'dashboard'
  const params = initialParam ? { section: initialParam } : {}

  /*
   * 先挂骨架，状态回来之后再渲染真视图 —— 只渲染一次。
   *
   * 早先是「先渲染一遍视图、拿到状态再渲染第二遍」，第二遍会把第一遍的 DOM 整块换掉。
   * 这中间用户要是点开了「选择文件 / 选择目录」，对话框的回调闭包指向的是已经被换掉的
   * 旧实例：选完文件界面毫无反应（配置文件那类走 localStorage 的勉强能靠第二遍读回来，
   * 转换页的待转列表这种只在内存里的就直接没了）。
   */
  showSkeleton(id)
  try {
    await refreshState()
  } catch (err) {
    console.error(err)
    toast('无法连接本地服务，请确认服务仍在运行', 'err')
    const dot = document.getElementById('status-dot')
    if (dot) dot.style.background = 'var(--err)'
  }

  // 等状态的这段时间用户自己切过页，就按新状态渲染那一页（带上原来的参数）
  if (currentView) await navigate(currentView, lastParams)
  else await navigate(id, params)

  state.ready = true
}

window.addEventListener('hashchange', () => {
  const m = location.hash.match(/^#\/(\w+)(?:\/([\w-]+))?/)
  const id = m?.[1]
  if (!id) return
  // 第二段是可选参数，例如 #/settings/tools 直达设置里的某一节
  if (id !== currentView || m[2]) navigate(id, m[2] ? { section: m[2] } : {})
})

// 快捷键：1-6 切换视图，Ctrl+R 刷新状态
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, textarea, select')) return
  if (e.ctrlKey || e.metaKey || e.altKey) return
  const n = Number(e.key)
  if (n >= 1 && n <= VIEWS.length) navigate(VIEWS[n - 1].id)
})

boot()

export { VIEWS }
