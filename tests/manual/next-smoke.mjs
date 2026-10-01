/**
 * 新前端（`/next/`）逐页冒烟 —— 旧 `ui-smoke.ps1` 在新前端上的对应物。
 *
 *   node tests/manual/next-smoke.mjs [port]
 *   node tests/manual/next-smoke.mjs 8891
 *
 * **为什么需要它**：`ui-smoke.ps1` 只测旧前端（`/`）的 8 页，`/next/` 一直只有
 * `glass-probe.mjs` 探玻璃 —— 页面搬过来渲染成什么样没有自动化兜着。
 *
 * 每页检查四件事（都是「搬坏了立刻看得见」的）：
 *   1. **控制台没有报错**（React 崩了、库里抛异常，都会在这里现形）；
 *   2. 页面**不是「待迁移占位」** —— 占位页一律记为 PENDING，不算失败；
 *   3. 有**玻璃面**（`[data-material]`）—— 新前端的每个页面都该至少有一个面板；
 *   4. 正文里能找到该页的**文案关键词**（新前端类名与旧前端不同，所以不按类名断言）。
 *
 * ⚠️ 和探针一样：不要加 `--disable-gpu`（截图才需要，本脚本不截图，但保持一致省得混淆）；
 * 视口用 CDP 显式设；**端口/文件都要靠环境变量区分**，才能与探针并行跑：
 *   $env:NEXTSMOKE_CDP=9500
 */

import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'

const PORT = Number(process.argv[2] ?? 0) || 8891
const BASE = `http://127.0.0.1:${PORT}`
const CDP_PORT = Number(process.env.NEXTSMOKE_CDP ?? 0) || 9335
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PROFILE = `${process.env.TEMP}\\next-smoke-profile-${CDP_PORT}`

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 每页的期望。`any` 是**或**关系：搬家时文案可能微调，只要还认得出这一页在讲什么就行。
 * 新增页面/改文案后，这里跟着改 —— 它同时也是「这一页到底该有什么」的清单。
 */
const PAGES = [
  { id: 'dashboard', name: '总览', any: ['欢迎回来', '格式支持'] },
  { id: 'convert', name: '工程转换', any: ['来源工程', '源工程', '目标格式', '输出目录'] },
  { id: 'video', name: '视频解析', any: ['解析', '下载', '链接'] },
  { id: 'audio', name: '音频工具', any: ['音频', '采样率', '音高', '响度', '格式'] },
  { id: 'lyrics', name: '歌词', any: ['歌词', '搜索', '网易云', 'QQ'] },
  { id: 'pv', name: '文字 PV', any: ['PV', 'JIZURA', '歌词'] },
  { id: 'resources', name: '资源库', any: ['资源', '分组', '免费'] },
  { id: 'settings', name: '设置', any: ['设置', '外观', '玻璃'] },
]

/** 出现这些字样 = 页面自己报错了，一律算失败 */
const ERROR_MARKERS = ['视图加载失败', '视图渲染出错', '无法连接本地服务', '前端资源缺失']
const PLACEHOLDER = '还在旧前端'

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
    /** 页面里 console.error 与未捕获异常都收集起来 —— 这是本脚本最值钱的那条断言 */
    const consoleErrors = []
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data)
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 300))
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails
        consoleErrors.push((d.exception?.description ?? d.text ?? '异常').slice(0, 300))
      }
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
      resolve({ send, evalJs, consoleErrors, clearErrors: () => { consoleErrors.length = 0 }, close: () => ws.close() })
    })
  })
}

const edge = startEdge()
let cdp = null
const results = []
/** 侧栏「待迁」标签数量，在 try 里取，最后用来判定 */
let navTagCount = null

try {
  // 等 CDP 起来（这个端口偶尔会返回非 JSON，重试即可）
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
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1440, height: 900, deviceScaleFactor: 1, mobile: false,
  })

  // 先落到 /next/ 一次：hash 路由只改 hash 不会重新加载，所以要有个基准文档
  await cdp.send('Page.navigate', { url: `${BASE}/next/` })
  /**
   * ⚠️ **必须等应用真的就绪再开始断言**：首屏要等 `/api/state`（本机 2~3 秒），
   * 这期间是启动遮罩，正文是空的 —— 第一版没等，于是首页永远报「文案没命中」。
   * 就绪条件：遮罩已揭 + 有玻璃面 + 正文有内容。
   */
  let ready = false
  for (let i = 0; i < 60; i++) {
    ready = await cdp.evalJs(`!document.getElementById('boot') &&
      document.querySelectorAll('[data-material]').length > 0 &&
      (document.body.innerText || '').length > 200`)
    if (ready) break
    await sleep(300)
  }
  if (!ready) console.log('⚠️ 应用 18 秒内没就绪（下面每条都可能因此误报）')

  for (const p of PAGES) {
    cdp.clearErrors()
    // hash 直接设，不用重新加载整个应用（App 监听 hashchange）
    await cdp.evalJs(`(() => { location.hash = '#/${p.id}'; return true })()`)
    await sleep(700)

    const state = await cdp.evalJs(`(() => {
      const text = document.body.innerText || ''
      return {
        text,
        glass: document.querySelectorAll('[data-material]').length,
        rows: document.querySelectorAll('.nav-row').length,
        title: document.querySelector('.page-title')?.textContent ?? '',
        placeholder: text.includes(${JSON.stringify(PLACEHOLDER)}),
      }
    })()`)

    const errors = [...cdp.consoleErrors]
    const marker = ERROR_MARKERS.find((m) => state.text.includes(m))
    const missing = p.any.filter((k) => !state.text.includes(k))

    let verdict = 'PASS'
    const notes = []
    if (state.placeholder) {
      verdict = 'PENDING'
      notes.push('还是占位页（这一页没搬）')
    } else if (marker) {
      verdict = 'FAIL'
      notes.push(`页面报错：${marker}`)
    } else if (missing.length === p.any.length) {
      verdict = 'FAIL'
      notes.push(`文案没命中任何关键词（找的是：${p.any.join(' / ')}）`)
    }
    if (verdict !== 'PENDING' && state.glass === 0) {
      verdict = 'FAIL'
      notes.push('一个玻璃面都没有（[data-material] = 0）')
    }
    if (errors.length) {
      verdict = 'FAIL'
      notes.push(`控制台 ${errors.length} 条报错：${errors[0]}`)
    }
    results.push({ ...p, verdict, glass: state.glass, notes })
  }

  /**
   * 侧栏不该再挂「待迁」标签 —— 8 页全搬完后这是**回归护栏**：
   * 哪天新加一页忘了在 `App.tsx` 的 `PAGES` 里标 `ported: true`，这里会红。
   * ⚠️ 必须在 `cdp` 关掉之前取（放在 finally 之后会挂成 unsettled await）。
   */
  navTagCount = await cdp.evalJs(`document.querySelectorAll('.nav-row-tag').length`)
} finally {
  try { cdp?.close() } catch { /* 无所谓 */ }
  edge.kill()
  await sleep(300)
  // 无头 Edge 会留下子进程，按 profile 目录精确清掉（别按名字杀，会误伤）
  try {
    const { execSync } = await import('node:child_process')
    execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='msedge.exe'\\" | Where-Object { $_.CommandLine -like '*next-smoke-profile-${CDP_PORT}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`, { stdio: 'ignore' })
  } catch { /* 清不掉就算了 */ }
}


let navTags = navTagCount
const width = Math.max(...results.map((r) => r.name.length)) + 2
for (const r of results) {
  const tag = r.verdict === 'PASS' ? '通过' : r.verdict === 'PENDING' ? '待迁' : '失败'
  console.log(`${r.name.padEnd(width, '　')} #/${r.id.padEnd(10)} [${tag}]  玻璃面 ${r.glass}${r.notes.length ? '  —— ' + r.notes.join('；') : ''}`)
}
const fail = results.filter((r) => r.verdict === 'FAIL').length
const pending = results.filter((r) => r.verdict === 'PENDING').length
if (navTags !== null && navTags > 0) {
  console.log(`\n⚠️ 侧栏还有 ${navTags} 个「待迁」标签 —— 有页面搬完了却没在 App.tsx 的 PAGES 里标 ported: true`)
}
console.log(`\n═══ 通过 ${results.length - fail - pending} / 待迁 ${pending} / 失败 ${fail} ═══`)
process.exit(fail || (navTags ?? 0) > 0 ? 1 : 0)
