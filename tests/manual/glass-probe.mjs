/**
 * 前端（/）玻璃材质的实测探针
 *
 *   node tests/manual/glass-probe.mjs [port] [theme] [material]
 *   node tests/manual/glass-probe.mjs 8891 light liquid
 *
 * 为什么要这个脚本：玻璃的观感**只能看渲染结果**，源码和文档都可能是过时的
 * （两份文档就都写着已经被改掉的参数）。它做两件事：
 *   1. 在页面里量真实计算值（玻璃面的 material/size/backdrop-filter、材质层的底色、
 *      背景层的 filter 与遮罩）—— 光看 CSS 看不出哪条声明被丢了；
 *   2. 截一张图存到 tests/manual/out/ —— 用 read_image 看。
 *
 * ⚠️ 两个必须遵守的坑（都踩过）：
 *   - **不要加 `--disable-gpu`**：带着它 backdrop-filter 会糊成一片空白。
 *   - 视口必须用 CDP 的 `Emulation.setDeviceMetricsOverride` 显式设，
 *     命令行的 `--window-size` 会被缩成 500×450，据此判断布局必然误判。
 *
 * 只用 Node 自带的 WebSocket（≥22），不装包。需要先起测试实例：
 *   v-synth-studio.exe --serve --port=8891
 */

import { spawn } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const PORT = Number(process.argv[2] ?? 0) || 8891
const THEME = process.argv[3] ?? 'light'
const MATERIAL = process.argv[4] ?? 'liquid'
/**
 * 第 5 个参数：截图前覆盖几个背景令牌，用来验证「玻璃看不见」到底卡在哪一环。
 * 形如 `--bg-blur=0px,--bg-veil=transparent`。诊断用，不改磁盘上的样式。
 */
const OVERRIDE = (process.argv[5] ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)] })
const SUFFIX = OVERRIDE.length
  ? '-' + OVERRIDE.map(([k, v]) => `${k.replace(/^--/, '')}${v.replace(/[^\w]/g, '')}`).join('_')
  : ''
const BASE = `http://127.0.0.1:${PORT}`
/** 第 6 个参数：落在哪个视图（dashboard / settings / …），用来截图核对具体页面 */
const PAGE = process.argv[6] ?? ''
/** 第 4 个参数是材质名（老叫法），映射到**玻璃等级**：off→1、frosted→2、liquid→3 */
const LEVEL = MATERIAL === 'liquid' ? '4' : MATERIAL === 'half' ? '3' : MATERIAL === 'off' || MATERIAL === 'none' ? '1' : '2'
/** 第 7 个参数：额外写进 localStorage 的键值，k=v,k=v。用来验「开关关掉」那一档 */
const LS = (process.argv[7] ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)] })
/**
 * CDP 端口与 profile 目录都可以用环境变量改 —— **并行跑多个探针时必需**：
 * 端口和 profile 写死的话，两个实例会抢同一个调试端口、互相杀掉对方的 Edge。
 *   $env:GLASS_PROBE_CDP=9401; $env:GLASS_PROBE_TAG='video'
 */
const CDP_PORT = Number(process.env.GLASS_PROBE_CDP ?? 0) || 9334
const PROBE_TAG = process.env.GLASS_PROBE_TAG ?? ''
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PROFILE = `${process.env.TEMP}\\glass-probe-profile${PROBE_TAG}`
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'out')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function startEdge() {
  rmSync(PROFILE, { recursive: true, force: true })
  mkdirSync(PROFILE, { recursive: true })
  return spawn(EDGE, [
    '--headless=old',
    '--no-sandbox',
    '--no-first-run',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    'about:blank',
  ], { stdio: 'ignore' })
}

async function cdpTargets() {
  // 已知：这个端口偶尔会返回一个 JWT 字符串而不是 JSON，所以调用方要能重试。
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
  return res.json()
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.id && pending.has(msg.id)) {
        const { resolve: res, reject: rej } = pending.get(msg.id)
        pending.delete(msg.id)
        if (msg.error) rej(new Error(JSON.stringify(msg.error)))
        else res(msg.result)
      }
    })
    ws.addEventListener('error', (e) => reject(new Error(`WebSocket 出错：${e.message ?? e.type}`)))
    ws.addEventListener('open', () => {
      const send = (method, params = {}) => new Promise((res, rej) => {
        const myId = ++id
        pending.set(myId, { resolve: res, reject: rej })
        ws.send(JSON.stringify({ id: myId, method, params }))
      })
      const evalJs = async (expr) => {
        const r = await send('Runtime.evaluate', {
          expression: expr, returnByValue: true, awaitPromise: true, userGesture: true,
        })
        if (r.exceptionDetails) {
          throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
        }
        return r.result.value
      }
      resolve({ send, evalJs, close: () => ws.close() })
    })
  })
}

/* 页面里跑的那段取数 —— 只读计算值，不改页面 */
const PROBE = String.raw`(async () => {
  const px = (v) => Math.round(v * 10) / 10
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: px(r.x), y: px(r.y), w: px(r.width), h: px(r.height) } }
  /**
   * 玻璃面的模糊挂在**哪一层**上是要看的：
   * 面上量到 backdrop:none 不等于没有模糊 —— 库把模糊放在 .lg-backdrop 子层，
   * 走 --lg-backdrop 这个自定义属性。上一轮就是量错节点才误判的。
   */
  const layer = (el) => {
    const s = getComputedStyle(el)
    return {
      node: el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).trim().split(/\s+/).join('.') : ''),
      backdrop: s.backdropFilter && s.backdropFilter !== 'none' ? s.backdropFilter : (s.webkitBackdropFilter || 'none'),
      bg: s.backgroundColor, opacity: s.opacity, radius: s.borderRadius,
      backdropVar: s.getPropertyValue('--lg-backdrop').trim(),
      tintVar: s.getPropertyValue('--lg-tint-alpha').trim(),
    }
  }
  const glass = [...document.querySelectorAll('[data-material]')].map((el) => ({
    cls: String(el.className).trim(),
    material: el.dataset.material, size: el.dataset.glassSize, renderer: el.dataset.renderer,
    tone: el.dataset.backdropTone,
    box: rect(el),
    /* 模糊在 .lg-backdrop 这一层上消费 --lg-backdrop，只量外层面会误判成「没有模糊」 */
    layers: [el, ...el.querySelectorAll('.lg-backdrop, .lg-tint, .lg-rim, .lg-glow')].map(layer),
  }))
  const svgFilters = [...document.querySelectorAll('feDisplacementMap')].length
  const probeImg = (url) => new Promise((res) => {
    const im = new Image()
    im.onload = () => res({ ok: true, w: im.naturalWidth, h: im.naturalHeight })
    im.onerror = (e) => res({ ok: false, why: String(e?.type ?? 'error') })
    im.src = url
  })
  const bgUrl = (getComputedStyle(document.body, '::before').backgroundImage.match(/url\("([^"]+)"\)/) ?? [])[1] ?? ''
  const image = bgUrl ? await probeImg(bgUrl) : { ok: false, why: '背景层没有 url()' }
  const materials = [...document.querySelectorAll('.lg-material-view')].map((el) => {
    const s = getComputedStyle(el)
    return { thickness: el.dataset.thickness, background: s.backgroundColor, backdrop: s.backdropFilter, box: rect(el) }
  })
  const bg = getComputedStyle(document.body, '::before')
  const root = getComputedStyle(document.documentElement)
  const resources = performance.getEntriesByType('resource')
    .map((e) => ({ name: e.name.replace(location.origin, ''), bytes: e.decodedBodySize, ms: Math.round(e.duration) }))
  const scrollEl = document.querySelector('.app-sidebar, .lg-tabbar') ?? document.body
  return {
    theme: document.documentElement.dataset.lgTheme,
    /* 玻璃等级滑块：**真的拖一下**（原生 setter + input 事件，React 才认），
       再看等级有没有落到 localStorage、玻璃面有没有跟着变。 */
    slider: await (async () => {
      const el = document.querySelector('input[type="range"]')
      if (!el) return { found: false }
      const before = { min: el.min, max: el.max, value: el.value }
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      const poke = async (v) => {
        /* ⚠️ **每次都重新取节点**：1 级时面板从玻璃面换成 MaterialView，
           React 会把整棵子树卸载重建，原来那个 el 就成了脱离文档的死节点 ——
           往它身上写值不会有任何反应（我第一版就是这么被骗了一次）。 */
        const live = document.querySelector('input[type="range"]')
        if (!live) return
        setter.call(live, String(v))
        live.dispatchEvent(new Event('input', { bubbles: true }))
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      }
      await poke(el.max)
      const top = {
        level: localStorage.getItem('qingmu.glassLevel'),
        clear: document.querySelectorAll('[data-material="clear"]').length,
      }
      await poke(el.min)
      const bottom = {
        level: localStorage.getItem('qingmu.glassLevel'),
        clear: document.querySelectorAll('[data-material="clear"]').length,
        materialViews: document.querySelectorAll('.lg-material-view').length,
      }
      await poke(before.value)
      return { found: true, ...before, top, bottom, restored: localStorage.getItem('qingmu.glassLevel') }
    })(),    /* 导航高亮块：主侧栏和设置页小节导航**各有一块**，两边都要落位准、都要能滑 */
    navs: [...document.querySelectorAll('.app-nav')].map((nav) => {
      const lens = nav.querySelector('.lg-selection-lens')
      const row = nav.querySelector('.nav-row[aria-current="page"]')
      const a = lens ? lens.getBoundingClientRect() : null
      const b = row ? row.getBoundingClientRect() : null
      return {
        label: nav.getAttribute('aria-label'),
        rows: nav.querySelectorAll('.nav-row').length,
        lens: !!lens,
        shown: lens ? getComputedStyle(lens).getPropertyValue('--lg-lens-shown').trim() : null,
        align: a && b ? { dx: px(a.x - b.x), dy: px(a.y - b.y), dw: px(a.width - b.width), dh: px(a.height - b.height) } : null,
      }
    }),    /* 回读 localStorage：验「开关有没有写进去 / 页面有没有读到」 */
    ls: {
      theme: localStorage.getItem('qingmu.theme'),
      glass: localStorage.getItem('qingmu.glass'),
      glassLevel: localStorage.getItem('qingmu.glassLevel'),
    },
    glass,
    materials,
    svgFilters,
    image,
    lenses: document.querySelectorAll('.lg-selection-lens').length,
    lensBox: document.querySelector('.lg-selection-lens') ? rect(document.querySelector('.lg-selection-lens')) : null,
    currentRow: (() => { const r = document.querySelector('.nav-row[aria-current="page"], .lg-tab-link[aria-current="page"]'); return r ? rect(r) : null })(),
    bgLayer: {
      filter: bg.filter, background: (bg.backgroundImage || '').slice(0, 90),
      veilVar: root.getPropertyValue('--bg-veil').trim(),
      blurVar: root.getPropertyValue('--bg-blur').trim(),
      contrastVar: root.getPropertyValue('--bg-contrast').trim(),
    },
    bodyBackground: getComputedStyle(document.body).backgroundColor,
    resources,
    layout: {
      sidebar: scrollEl ? rect(scrollEl) : null,
      sidebarPosition: scrollEl ? getComputedStyle(scrollEl).position : null,
      navCount: document.querySelectorAll('.nav-row, .lg-tab-link').length,
      docHeight: document.documentElement.scrollHeight, viewport: innerHeight,
      /* 左边缘对齐：品牌图标 / 品牌字 / 页面标题 / 侧栏 / 面板 各自从哪起 */
      align: (() => {
        const l = (sel) => {
          const el = document.querySelector(sel)
          if (!el) return null
          const r = el.getBoundingClientRect()
          return { x: px(r.x), y: px(r.y) }
        }
        return {
          brandMark: l('.brand-mark'), brandName: l('.brand-name'), pageTitle: l('.page-title'),
          sidebar: l('.app-sidebar'), panel: l('.panel'), navRow: l('.nav-row'), navGroup: l('.nav-group'),
        }
      })(),
    },
    /* 圆角：普通圆弧还是苹果式连续曲率 —— 光看 CSS 声明看不出来，要看计算值 */
    round: {
      supported: CSS.supports('corner-shape', 'squircle'),
      button: (() => { const b = document.querySelector('.btn'); return b ? getComputedStyle(b).getPropertyValue('corner-shape').trim() : null })(),
      panel: (() => { const p = document.querySelector('.lg-material-view'); return p ? getComputedStyle(p).getPropertyValue('corner-shape').trim() : null })(),
      glass: (() => { const g = document.querySelector('.app-sidebar'); return g ? getComputedStyle(g).getPropertyValue('corner-shape').trim() : null })(),
    },
  }
})()`

/* ── 主流程 ─────────────────────────────────────────────────── */

const edge = startEdge()
let cdp = null
try {
  let targets = null
  for (let i = 0; i < 60; i++) {
    try { targets = await cdpTargets(); if (targets?.length) break } catch { /* 还没起来 */ }
    await sleep(500)
  }
  if (!targets?.length) throw new Error(`连不上 Edge 的 CDP 端口 ${CDP_PORT}`)

  const page = targets.find((t) => t.type === 'page')
  cdp = await connect(page.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  })

  // 先落到同源的一个真实页面，再写 localStorage —— about:blank 上写的是另一个源。
  await cdp.send('Page.navigate', { url: `${BASE}/` })
  await sleep(1200)
  await cdp.evalJs(`(() => {
    localStorage.setItem('qingmu.theme', ${JSON.stringify(THEME)});
    localStorage.setItem('qingmu.glassLevel', ${JSON.stringify(LEVEL)});
    for (const [k, v] of ${JSON.stringify(LS)}) localStorage.setItem(k, v);
    return true
  })()`)
  /**
   * 首帧检查：**打开界面时高亮块不能飞过去**。
   * 在文档里装一个 rAF 采样器，从第一条脚本跑起就记录高亮块的 transform；
   * 若前几帧就已经在目标位置，说明首帧落位没有带过渡（这是 AGENTS.md 记的第一个坑）。
   */
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: `window.__lensFrames = [];
      (function tick() {
        const l = document.querySelector('.app-nav .lg-selection-lens');
        if (l && l.style.width) {
          if (!window.__lensStart) window.__lensStart = performance.now();
          window.__lensFrames.push(getComputedStyle(l).transform);
          if (performance.now() - window.__lensStart > 1200) return;
        }
        if (performance.now() < 10000) requestAnimationFrame(tick);
      })();`,
  })
  /**
   * ⚠️ **必须真·重载**（`Page.reload`），不能只 `Page.navigate` 到同一个 URL。
   *
   * 踩过：写 localStorage 之后再 `navigate` 到同一个地址，浏览器可能按**同文档导航**
   * 处理 —— 页面没重建，`useGlass` / `useGlobalGlass` 那两个模块级缓存的旧值还在，
   * 于是「localStorage 里明明是 off，界面还是全局玻璃」，看着像开关失效。
   * 视图切换改用 hash：`hashchange` 会被应用自己接住，不需要换文档。
   */
  await cdp.send('Page.reload', { ignoreCache: true })

  /**
   * 启动画面：**趁它还在的时候截一张** —— 等 ready 之后再截就永远是空的
   * （`hideBoot()` 在首次 `/api/state` 落定后就把它揭掉了，那要 2~3 秒）。
   *
   * ⚠️ **别贴着重载就截**：`Page.reload` 一返回就 `captureScreenshot`，
   * 合成器交出来的可能还是**旧文档的残留帧**（旧文档那时也在加载、遮罩是它那个主题的底色）。
   * 实测症状是「亮色跑的却截出一张暗图」，而同一刻读 DOM 明明是亮色 —— 我为此排查了一轮。
   * 所以：**先轮询到新文档真的接管了（遮罩在 + `<html data-theme>` 已经是本次要的主题），
   * 再截图**，顺便把那一刻的主题和底色一起记下来。
   */
  let splashInfo = null
  for (let i = 0; i < 25; i++) {
    splashInfo = await cdp.evalJs(`(() => {
      const b = document.getElementById('boot')
      return {
        shown: !!b,
        theme: document.documentElement.dataset.theme ?? null,
        bg: b ? getComputedStyle(b).backgroundColor : null,
        stored: localStorage.getItem('qingmu.theme'),
      }
    })()`)
    if (splashInfo.shown && splashInfo.theme === THEME) break
    await sleep(120)
  }
  const splashShot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const splashShown = splashInfo.shown

  if (PAGE) await cdp.evalJs(`(() => { location.hash = '#/${PAGE}'; return true })()`)

  // 等应用真渲染出来（后端 /api/state 本机要几秒），别写死 sleep。
  // 三个条件都要等：玻璃面出现 + 总览页不再显示「正在读取环境状态」占位 + **启动遮罩已经揭开**——
  // 只等前两个会截到「本地服务没有响应」那块兜底遮罩（`#boot` 是 position:fixed 的整屏层，
  // 盖住整页；页面其实早画好了）。`/api/state` 在本机被别的进程占着时会跑到 30 秒以上，
  // 60×500ms 的预算不够，所以这里放到 240 次。
  let ready = false
  for (let i = 0; i < 240; i++) {
    const state = await cdp.evalJs(`({
      glass: document.querySelectorAll('[data-material]').length,
      loading: document.body.innerText.includes('正在读取环境状态'),
      boot: !!document.getElementById('boot'),
    })`)
    if (state.glass > 0 && !state.loading && !state.boot) { ready = true; break }
    await sleep(500)
  }
  if (!ready) throw new Error('页面没渲染完（没有玻璃面，或状态一直停在加载中，或启动遮罩没揭开）')
  /**
   * **交接那一帧**：等 `data-boot="out"` 出现（遮罩开始淡出），立刻读双方的不透明度 ——
   * 遮罩应当在淡出中（<1），侧栏/内容区应当在入场中（<1）。
   * 两边同时 <1 才叫交叉过渡；只有遮罩 <1 就是「界面早就画好、啪地出现」。
   */
  let handoff = null
  for (let i = 0; i < 60; i++) {
    const st = await cdp.evalJs(`(() => {
      const op = (el) => (el ? Number(getComputedStyle(el).opacity) : null)
      const m = document.querySelector('.app-main')
      return {
        boot: document.documentElement.dataset.boot ?? null,
        splash: op(document.getElementById('boot')),
        main: op(m), sidebar: op(document.querySelector('.app-sidebar')),
        anim: m ? getComputedStyle(m).animationName : null,
      }
    })()`)
    if (st.boot === 'out') { handoff = st; break }
    await sleep(60)
  }
  const handoffShot = await cdp.send('Page.captureScreenshot', { format: 'png' })

  /* 淡出要 380ms，**就绪那一刻查会抓在淡出中间**，看着像没揭掉（我第一版就是这么误判的） */
  await sleep(1200)
  /* 揭开验完就删干净：加载页永久盖在界面上是最糟的结果 */
  const splashGone = await cdp.evalJs(`!document.getElementById('boot')`)
  await sleep(1500)   // 让首帧的透镜定位、字体就绪后的重新度量都跑完

  /* 首帧采样：前 3 帧就应当在目标位置（等于最终值），否则就是「打开时方块飞过来」 */
  const boot = await cdp.evalJs(`(() => {
    const f = window.__lensFrames ?? []
    return { frames: f.length, first: f.slice(0, 3), last: f.at(-1) ?? null,
             settled: f.length > 2 && f[0] === f.at(-1) }
  })()`)

  const data = await cdp.evalJs(PROBE)
  // 诊断覆盖：写在 <html> 的行内样式上，优先级高于 [data-lg-theme] 里的定义
  if (OVERRIDE.length) {
    await cdp.evalJs(`(() => {
      const o = ${JSON.stringify(OVERRIDE)};
      for (const [k, v] of o) document.documentElement.style.setProperty(k, v);
      return o.length
    })()`)
    await sleep(600)
  }
  mkdirSync(OUT, { recursive: true })
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const file = join(OUT, `glass-${THEME}-${MATERIAL}${SUFFIX}.png`)
  writeFileSync(file, Buffer.from(shot.data, 'base64'))

  /* 启动画面那张（趁它还在时截的）也存下来，当证据 */
  const splashFile = join(OUT, `boot-${THEME}${SUFFIX}.png`)
  writeFileSync(splashFile, Buffer.from(splashShot.data, 'base64'))
  /* 交接那一帧（遮罩淡出 + 界面入场同时进行） */
  const handoffFile = join(OUT, `boot-handoff-${THEME}${SUFFIX}.png`)
  writeFileSync(handoffFile, Buffer.from(handoffShot.data, 'base64'))

  /**
   * 侧栏高亮块：**逐帧采样**，别只看声明。
   * 只有 1~2 种取值说明是直接跳过去的；对齐偏差要接近 0。
   */
  const slide = await cdp.evalJs(`(async () => {
    const lens = document.querySelector('.app-nav .lg-selection-lens')
    if (!lens) return { lens: false }
    const rows = [...document.querySelectorAll('.nav-row')]
    const target = rows.find((r) => r.getAttribute('aria-current') !== 'page')
    const frames = []
    const t0 = performance.now()
    target.click()
    await new Promise((res) => {
      const tick = () => {
        frames.push(getComputedStyle(lens).transform)
        if (performance.now() - t0 < 700) requestAnimationFrame(tick)
        else res()
      }
      requestAnimationFrame(tick)
    })
    const row = document.querySelector('.nav-row[aria-current="page"]')
    const a = lens.getBoundingClientRect(), b = row.getBoundingClientRect()
    /* 内容从平栏下面经过时，库的 ScrollEdge 应当自己亮起来（data-active） */
    window.scrollTo(0, 400)
    await new Promise((r) => setTimeout(r, 500))
    const edge = document.querySelectorAll('.lg-scroll-edge')
    const scrolled = {
      count: edge.length,
      active: [...edge].map((e) => e.dataset.active ?? 'false'),
      opacity: [...edge].map((e) => getComputedStyle(e).opacity),
    }
    window.scrollTo(0, 0)
    return {
      lens: true, clicked: target.innerText.trim(),
      frames: frames.length, distinct: new Set(frames).size, scrolled,
      align: {
        dx: Math.round((a.x - b.x) * 10) / 10, dy: Math.round((a.y - b.y) * 10) / 10,
        dw: Math.round((a.width - b.width) * 10) / 10, dh: Math.round((a.height - b.height) * 10) / 10,
      },
    }
  })()`)

  console.log(
    JSON.stringify(
      {
        theme: THEME, material: MATERIAL, screenshot: file, boot,
        /* 启动画面：趁它还在时截的那张，以及「就绪后有没有揭干净」 */
        splash: { shownEarly: splashShown, atBoot: splashInfo, goneWhenReady: splashGone, file: splashFile, handoff, handoffFile },
        slide, ...data,
      },
      null,
      2,
    ),
  )
} finally {
  try { cdp?.close() } catch { /* 无所谓 */ }
  edge.kill()
  await sleep(300)
  // 无头 Edge 会留下子进程占内存，按 profile 目录的进程精确清掉
  try {
    const { execSync } = await import('node:child_process')
    execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='msedge.exe'\\" | Where-Object { $_.CommandLine -like '*glass-probe-profile${PROBE_TAG}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`, { stdio: 'ignore' })
  } catch { /* 没有残留就算了 */ }
}
