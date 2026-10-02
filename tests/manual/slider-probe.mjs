/**
 * 玻璃等级滑条的动效探针 —— 断言「值变了之后，滑块不是一帧跳过去」。
 *
 * 用法：node tests\manual\slider-probe.mjs 8891
 *   前置：起一个测试实例（`v-synth-studio.exe --serve --port=8891`）。
 *
 * ## 为什么要有这个探针
 *
 * 用户报「调整玻璃等级那个滑条 没有任何动画 甚至是一帧拉过去的」。查库的 CSS
 * （`node_modules/@ttqtt/liquid-glass-react/dist/components.css:317-323`）发现：
 * 滑块（`.lg-slider-lens`）的位置是 `inset-inline-start: calc(var(--lg-progress) * (100% - 26px))`，
 * 它的 `transition` **只列了 `scale` / `translate` / `box-shadow`，没有位置**；
 * 填充条 `.lg-slider-fill` 的 `width` 也没有 transition。所以点刻度或按方向键时，
 * 滑块**真的**是一帧到位 —— 库就是这么写的（它只给「按下抬起」做了弹簧）。
 * 本地在 `src/index.css` 里补了两条 `transition` 覆盖来修这件事，这个探针守住它。
 *
 * ## 量法
 *
 * 直接 `input.value = n` + 派发 `input` 事件（React 的 onChange 监听的是 input 事件），
 * 然后在**同一帧之后连续采样**滑块的 `getBoundingClientRect().x`：
 *  - 有动画 → 采样到的 x 是**逐渐逼近**目标的一串中间值；
 *  - 没动画 → 第一次采样就已经是终点值（所有采样点全等）。
 *
 * ⚠️ **采样必须在同一帧内连续做**，不能每个采样点之间 `await sleep` ——
 * 无头 Edge 里 `requestAnimationFrame` 的回调节奏不稳，隔帧采样很容易全落在动画结束后。
 * 这里用一次 `Runtime.evaluate` 里的一个 `rAF` 循环把整条轨迹收完再返回。
 *
 * ⚠️ 停在这一页之前要确认滑条在 DOM 里 —— `/settings` 是 SPA 路由，切页是异步的。
 */

import { spawn, execSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'

const PORT = process.argv[2] ?? '8891'
const CDP = Number(process.env.SLIDER_CDP ?? 9502)
const BASE = `http://127.0.0.1:${PORT}`
const EDGE = process.env.EDGE_PATH ?? 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PROFILE = `${process.env.TEMP}\\slider-probe-${CDP}`
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

mkdirSync(PROFILE, { recursive: true })

/* ── 起无头 Edge（必须 --headless=old，AGENTS.md 里记过）───────────────── */
const edge = spawn(
  EDGE,
  [
    '--headless=old',
    '--no-sandbox',
    '--no-first-run',
    `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${PROFILE}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
)

let target = null
for (let i = 0; i < 40 && !target; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${CDP}/json/list`)).json()
    target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl) ?? null
  } catch {
    /* 还没起来 */
  }
  if (!target) await sleep(250)
}
if (!target) {
  edge.kill()
  rmSync(PROFILE, { recursive: true, force: true })
  console.error('起不来无头 Edge')
  process.exit(1)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data)
  const p = pending.get(m.id)
  if (!p) return
  pending.delete(m.id)
  m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
})
await new Promise((r) => ws.addEventListener('open', r))
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval 失败')
  return r.result.value
}

await send('Runtime.enable')
await send('Page.enable')
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false })
await send('Page.navigate', { url: `${BASE}/#/settings` })

/* SPA 切页 + 玻璃面挂载要等一会儿 */
let ready = false
for (let i = 0; i < 60 && !ready; i++) {
  ready = await evaluate(`!!document.querySelector('.lg-slider input[type=range]')`)
  if (!ready) await sleep(300)
}
if (!ready) {
  console.error('设置页里没找到玻璃等级滑条')
  ws.close()
  edge.kill()
  rmSync(PROFILE, { recursive: true, force: true })
  process.exit(1)
}

/**
 * ⚠️ **等外壳的入场动画跑完再量。**
 *
 * `.app` 上有 `animation: app-enter 720ms`（`index.css:165`，带 `transform`）。
 * 实测踩过：页面刚挂上就开测，第一轮只采到 **2 帧**（900ms 的窗口里），
 * 后一轮采到 93 帧 —— 主线程被入场动画和玻璃面的首帧构建占着，`requestAnimationFrame`
 * 被饿死，采到的「轨迹」全是假的（看着像"一帧跳过去"，其实是根本没在采样）。
 */
await sleep(1500)

const SLIDER = `document.querySelector('.lg-slider')`
const LENS = `${SLIDER}.querySelector('.lg-slider-lens')`
const FILL = `${SLIDER}.querySelector('.lg-slider-fill')`

/** 一次把滑条的现状全量出来 —— 单看一个 x 没法定位问题（踩过） */
const snap = `(() => {
  const s = ${SLIDER}, lens = s.querySelector('.lg-slider-lens'), rail = s.querySelector('.lg-slider-rail'),
        fill = s.querySelector('.lg-slider-fill'), input = s.querySelector('input[type=range]')
  const cs = getComputedStyle(lens)
  return {
    value: input.value,
    progress: getComputedStyle(s).getPropertyValue('--lg-progress').trim(),
    sliderX: +s.getBoundingClientRect().x.toFixed(2),
    railX: +rail.getBoundingClientRect().x.toFixed(2),
    railW: +rail.getBoundingClientRect().width.toFixed(2),
    lensX: +lens.getBoundingClientRect().x.toFixed(2),
    lensW: +lens.getBoundingClientRect().width.toFixed(2),
    inset: cs.insetInlineStart,
    fillW: +fill.getBoundingClientRect().width.toFixed(2),
    lensTP: cs.transitionProperty,
    fillT: cs.transitionProperty,
  }
})()`

/** 把值改成 n，然后在**同一次 evaluate 里**用 rAF 连续采样 lens.x / fill 宽 900ms */
const track = (n) => `(async () => {
  const s = ${SLIDER}, lens = s.querySelector('.lg-slider-lens'), fill = s.querySelector('.lg-slider-fill'),
        input = s.querySelector('input[type=range]')
  const before = ${snap}
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  setter.call(input, String(${n}))
  input.dispatchEvent(new Event('input', { bubbles: true }))
  /**
   * ⚠️ 轨道左边缘**必须在改值前抓下来存成常量**。
   * 第一版这里读的是外面那个变量，量出来的全是 0 —— 而且原因很隐蔽：
   * 我一度以为是"元素没动"，其实是选择器写错（有个拼错的类名），
   * getBoundingClientRect() 对**不存在的元素**不报错，返回全 0 的矩形，
   * 减去轨道 x 之后正好是「恒定 0」，看起来就像"没有中间帧"。
   * 所以量位置一定要把原始 rect 也打出来（见下面的 before/after 和对齐断言）。
   */
  const railX = s.querySelector('.lg-slider-rail').getBoundingClientRect().x
  const xs = [], ws = []
  const t0 = performance.now()
  await new Promise((done) => {
    const tick = () => {
      xs.push(+(lens.getBoundingClientRect().x - railX).toFixed(2))
      ws.push(+fill.getBoundingClientRect().width.toFixed(2))
      if (performance.now() - t0 < 900) requestAnimationFrame(tick)
      else done()
    }
    requestAnimationFrame(tick)
  })
  return { xs, ws, frames: xs.length, before, after: ${snap} }
})()`

/** 从采样串里判断「有没有中间帧」：去掉首尾后还有没有既不等于起点、也不等于终点的值 */
function verdict(series) {
  const values = series.filter((v) => typeof v === 'number' && Number.isFinite(v))
  if (values.length === 0) return { first: NaN, last: NaN, span: 0, mid: 0, sample: series, raw: series }
  const first = values[0]
  const last = values[values.length - 1]
  const span = Math.abs(last - first)
  const mid = values.filter((v) => Math.abs(v - first) > 0.5 && Math.abs(v - last) > 0.5)
  return { first, last, span: +span.toFixed(2), mid: mid.length, sample: values.slice(0, 8), raw: series }
}

let failures = 0
const check = (ok, label, detail) => {
  if (!ok) failures++
  console.log(`  ${ok ? '✅' : '✗'} ${label}${detail ? `  ${detail}` : ''}`)
}

for (const [from, to] of [
  [2, 4],
  [4, 1],
]) {
  await evaluate(`(async () => {
    const input = ${SLIDER}.querySelector('input[type=range]')
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
    setter.call(input, '${from}')
    input.dispatchEvent(new Event('input', { bubbles: true }))
  })()`)
  await sleep(1200) /* 等上一次动画彻底停下，否则量到的是上一段的尾巴 */

  const r = await evaluate(track(to))
  const lens = verdict(r.xs)
  const fill = verdict(r.ws)

  console.log(`\n═══ ${from} 级 → ${to} 级（采样 ${r.frames} 帧 / 900ms）═══`)
  console.log(`  改值前：${JSON.stringify(r.before)}`)
  console.log(`  改值后：${JSON.stringify(r.after)}`)
  console.log(`  滑块 x（相对轨道）：${lens.first} → ${lens.last}  位移 ${lens.span}px  中间帧 ${lens.mid} 个`)
  console.log(`  填充宽：${fill.first} → ${fill.last}  变化 ${fill.span}px  中间帧 ${fill.mid} 个`)
  console.log(`  滑块轨迹前 8 帧：${lens.sample.join(', ')}`)
  console.log(`  滑块轨迹原始（前 12 项，typeof 标出来）：${lens.raw.slice(0, 12).map((v) => `${typeof v}:${v}`).join(', ')}`)

  check(lens.span > 20, '滑块确实换了位置', `${lens.span}px`)
  check(lens.mid >= 2, '滑块位置有中间帧（不是一帧跳过去）', `${lens.mid} 个中间帧`)
  check(fill.mid >= 2, '填充条也有中间帧', `${fill.mid} 个中间帧`)
}

console.log(`\n═══ ${failures === 0 ? '全部通过' : `失败 ${failures} 条`} ═══`)

ws.close()
edge.kill()
try {
  execSync(
    `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='msedge.exe'\\" | Where-Object { $_.CommandLine -like '*slider-probe-${CDP}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`,
    { stdio: 'ignore' },
  )
} catch {
  /* 已经退了 */
}
rmSync(PROFILE, { recursive: true, force: true })
process.exit(failures === 0 ? 0 : 1)
