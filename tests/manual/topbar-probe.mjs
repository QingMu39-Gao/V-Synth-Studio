/**
 * 顶栏吸顶探针 —— 专治「滚轮滑动页面时左上角的软件名和图标跟着一起动」。
 *
 * 断言两条：
 *   ① 品牌（图标 + 名字）在任何滚动位置都不动（矩形与初始值逐像素相同）；
 *   ② 顶栏左边缘与侧栏左边缘对齐 —— 这条防的是 `inset-inline` 那个坑
 *      （绝对/粘性定位的包含块是内边距盒，写 0 会偏左一个 --lg-margin）。
 *
 * 用法：先起测试实例，再 `node tests\manual\topbar-probe.mjs 8891`
 * 可选：`$env:TOPBAR_CDP=9501` 换 CDP 端口（默认 9501）。
 */

import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'

const PORT = Number(process.argv[2] ?? 0) || 8891
const BASE = `http://127.0.0.1:${PORT}`
const CDP_PORT = Number(process.env.TOPBAR_CDP ?? 0) || 9501
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PROFILE = `${process.env.TEMP}\\topbar-probe-${CDP_PORT}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function startEdge() {
  rmSync(PROFILE, { recursive: true, force: true })
  mkdirSync(PROFILE, { recursive: true })
  return spawn(EDGE, [
    '--headless=old', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${CDP_PORT}`,
    `--user-data-dir=${PROFILE}`,
    'about:blank',
  ], { stdio: 'ignore' })
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
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
        return r.result.value
      }
      resolve({ send, evalJs, close: () => ws.close() })
    })
  })
}

/** 取品牌 / 顶栏 / 侧栏 / 第一个内容面板的矩形（都是视口坐标） */
const MEASURE = `(() => {
  const r = (el) => { if (!el) return null; const b = el.getBoundingClientRect()
    return { x: +b.x.toFixed(2), y: +b.y.toFixed(2), w: +b.width.toFixed(2), h: +b.height.toFixed(2) } }
  const cs = (el) => el ? getComputedStyle(el).position : null
  return {
    scrollY: +window.scrollY.toFixed(2),
    docScrollable: document.documentElement.scrollHeight - window.innerHeight,
    brand: r(document.querySelector('.brand')),
    mark: r(document.querySelector('.brand-mark')),
    topbar: r(document.querySelector('.app-topbar')),
    topbarPos: cs(document.querySelector('.app-topbar')),
    sidebar: r(document.querySelector('.app-sidebar')),
    main: r(document.querySelector('.app-main')),
    navLabel: (() => {
      const rows = [...document.querySelectorAll('.nav-row-label')]
      const hit = rows.find((e) => e.textContent.includes('网易云'))
      return hit ? hit.textContent : null
    })(),
  }
})()`

const edge = startEdge()
let cdp = null
const fails = []
const notes = []

try {
  let targets = null
  for (let i = 0; i < 40; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
      const list = await res.json()
      targets = Array.isArray(list) ? list : null
      if (targets?.length) break
    } catch { /* 还没起来 */ }
    await sleep(250)
  }
  if (!targets?.length) throw new Error(`连不上 Edge 的 CDP 端口 ${CDP_PORT}`)
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
  cdp = await connect(page.webSocketDebuggerUrl)
  await cdp.send('Runtime.enable')
  await cdp.send('Page.enable')

  for (const width of [1440, 1600, 1100]) {
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width, height: 900, deviceScaleFactor: 1, mobile: false,
    })
    await cdp.send('Page.navigate', { url: `${BASE}/#/lyrics` })
    let ready = false
    for (let i = 0; i < 60; i++) {
      ready = await cdp.evalJs(`!document.getElementById('boot') &&
        document.querySelectorAll('[data-material]').length > 0 &&
        (document.body.innerText || '').length > 200`)
      if (ready) break
      await sleep(300)
    }
    if (!ready) { fails.push(`${width}px：应用 18 秒内没就绪`); continue }

    // 歌词页内容不够高时滚不动 —— 先量一次，再滚。
    // ⚠️ 每个宽度都要**从 scrollY=0 起量**：换宽度不会自动回到顶部（第一次跑时
    //    1600/1100 那两轮开局就是 scrollY=400，量到的是吸顶后的状态，「初始」那一栏
    //    全是假的）。这里显式归零 + 强制一帧。
    await cdp.evalJs(`(async () => {
      window.scrollTo(0, 0)
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      void document.documentElement.offsetHeight
      return true
    })()`)
    await sleep(300)
    const before = await cdp.evalJs(MEASURE)
    /**
     * ⚠️ **滚动后必须强制一帧再量。**
     *
     * 无头 Edge 里 `window.scrollTo()` 之后不保证立刻重算粘性/固定定位的布局：
     * 第一次跑的时候，「滚动后」量到的还是滚之前的旧矩形（品牌 y=-16 出现在
     * 「初始」那一栏、Δy 假报 32px），而按 `scrollY` 看明明已经滚了。
     * 这里等两帧 + 读一次 `offsetHeight` 逼同步布局，量到的才是真的。
     */
    await cdp.evalJs(`(async () => {
      window.scrollTo(0, 400)
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
      void document.documentElement.offsetHeight
      return true
    })()`)
    await sleep(400)
    const after = await cdp.evalJs(MEASURE)

    console.log(`\n═══ 视口宽 ${width} ═══`)
    console.log(`  可滚高度        ${before.docScrollable}px`)
    console.log(`  topbar position ${before.topbarPos}`)
    console.log(`  初始 scrollY    ${before.scrollY} → 滚动后 ${after.scrollY}`)
    console.log(`  品牌  初始 x=${before.brand?.x} y=${before.brand?.y}  →  滚动后 x=${after.brand?.x} y=${after.brand?.y}`)
    console.log(`  图标  初始 x=${before.mark?.x} y=${before.mark?.y}  →  滚动后 x=${after.mark?.x} y=${after.mark?.y}`)
    console.log(`  侧栏  初始 x=${before.sidebar?.x} y=${before.sidebar?.y}  →  滚动后 x=${after.sidebar?.x} y=${after.sidebar?.y}`)
    console.log(`  内容  初始 x=${before.main?.x} y=${before.main?.y}  →  滚动后 x=${after.main?.x} y=${after.main?.y}`)
    console.log(`  侧栏导航里含「网易云」的行：${JSON.stringify(before.navLabel)}`)

    if (before.scrollY !== 0) notes.push(`${width}px：初始 scrollY 不是 0（${before.scrollY}）`)
    if (after.scrollY === 0) notes.push(`${width}px：滚不动（可滚高度 ${before.docScrollable}px）—— 本宽度下测不到吸顶`)

    // ① 品牌静止
    if (before.brand && after.brand) {
      const dx = Math.abs(after.brand.x - before.brand.x)
      const dy = Math.abs(after.brand.y - before.brand.y)
      if (dx > 0.5 || dy > 0.5) fails.push(`${width}px：品牌跟着滚了 Δx=${dx} Δy=${dy}`)
      else console.log(`  ✅ 品牌静止（Δx=${dx} Δy=${dy}）`)
    } else fails.push(`${width}px：量不到 .brand`)

    // ② 顶栏与侧栏左对齐
    if (before.topbar && before.sidebar) {
      const d = Math.abs(before.topbar.x - before.sidebar.x)
      if (d > 0.5) fails.push(`${width}px：顶栏左边缘与侧栏差 ${d}px（顶栏 ${before.topbar.x} / 侧栏 ${before.sidebar.x}）`)
      else console.log(`  ✅ 顶栏与侧栏左对齐（${before.topbar.x} / ${before.sidebar.x}）`)
    }

    // ③ 侧栏吸顶后不该往上跳
    if (before.sidebar && after.sidebar && after.scrollY > 0) {
      const d = Math.abs(after.sidebar.y - before.sidebar.y)
      console.log(`  侧栏吸顶位移 Δy=${d.toFixed(2)}（应 ≤ 顶部间距 ${before.sidebar.y}）`)
      if (after.sidebar.y < -0.5) fails.push(`${width}px：侧栏滚出视口顶部（y=${after.sidebar.y}）`)
    }
  }
} catch (e) {
  fails.push(`探针本身出错：${e.message}`)
} finally {
  try { cdp?.close() } catch { /* ignore */ }
  edge.kill()
  try {
    const { execSync } = await import('node:child_process')
    execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='msedge.exe'\\" | Where-Object { $_.CommandLine -like '*topbar-probe-${CDP_PORT}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`, { stdio: 'ignore' })
  } catch { /* ignore */ }
  rmSync(PROFILE, { recursive: true, force: true })
}

if (notes.length) {
  console.log('\n── 提醒 ──')
  for (const n of notes) console.log(`  · ${n}`)
}
console.log(`\n═══ ${fails.length ? `失败 ${fails.length} 条` : '全部通过'} ═══`)
for (const f of fails) console.log(`  ✗ ${f}`)
process.exit(fails.length ? 1 : 0)
