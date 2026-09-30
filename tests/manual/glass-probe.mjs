/**
 * 新前端（/next/）玻璃材质的实测探针
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
const BASE = `http://127.0.0.1:${PORT}`
const CDP_PORT = 9334
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PROFILE = `${process.env.TEMP}\\glass-probe-profile`
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
  await cdp.send('Page.navigate', { url: `${BASE}/next/` })
  await sleep(1200)
  await cdp.evalJs(`(() => {
    localStorage.setItem('qingmu.theme', ${JSON.stringify(THEME)});
    localStorage.setItem('qingmu.glass', ${JSON.stringify(MATERIAL)});
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
  await cdp.send('Page.navigate', { url: `${BASE}/next/` })

  // 等应用真渲染出来（后端 /api/state 本机要几秒），别写死 sleep。
  // 两个条件都要等：玻璃面出现 + 总览页不再显示「正在读取环境状态」占位 —— 只等前者会截到半成品。
  let ready = false
  for (let i = 0; i < 60; i++) {
    const state = await cdp.evalJs(`({
      glass: document.querySelectorAll('[data-material]').length,
      loading: document.body.innerText.includes('正在读取环境状态'),
    })`)
    if (state.glass > 0 && !state.loading) { ready = true; break }
    await sleep(500)
  }
  if (!ready) throw new Error('页面没渲染完（没有玻璃面，或状态一直停在加载中）')
  await sleep(1500)   // 让首帧的透镜定位、字体就绪后的重新度量都跑完

  /* 首帧采样：前 3 帧就应当在目标位置（等于最终值），否则就是「打开时方块飞过来」 */
  const boot = await cdp.evalJs(`(() => {
    const f = window.__lensFrames ?? []
    return { frames: f.length, first: f.slice(0, 3), last: f.at(-1) ?? null,
             settled: f.length > 2 && f[0] === f.at(-1) }
  })()`)

  const data = await cdp.evalJs(PROBE)
  mkdirSync(OUT, { recursive: true })
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png' })
  const file = join(OUT, `glass-${THEME}-${MATERIAL}.png`)
  writeFileSync(file, Buffer.from(shot.data, 'base64'))

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
    return {
      lens: true, clicked: target.innerText.trim(),
      frames: frames.length, distinct: new Set(frames).size,
      align: {
        dx: Math.round((a.x - b.x) * 10) / 10, dy: Math.round((a.y - b.y) * 10) / 10,
        dw: Math.round((a.width - b.width) * 10) / 10, dh: Math.round((a.height - b.height) * 10) / 10,
      },
    }
  })()`)

  console.log(JSON.stringify({ theme: THEME, material: MATERIAL, screenshot: file, boot, slide, ...data }, null, 2))
} finally {
  try { cdp?.close() } catch { /* 无所谓 */ }
  edge.kill()
  await sleep(300)
  // 无头 Edge 会留下子进程占内存，按 profile 目录的进程精确清掉
  try {
    const { execSync } = await import('node:child_process')
    execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='msedge.exe'\\" | Where-Object { $_.CommandLine -like '*glass-probe-profile*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`, { stdio: 'ignore' })
  } catch { /* 没有残留就算了 */ }
}
