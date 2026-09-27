/**
 * 「关掉再打开，界面状态还在吗」的真机验证
 *
 *   node tests/manual/storage-verify.mjs
 *
 * 为什么需要它：localStorage 按 **origin（协议 + 主机 + 端口）** 隔离。
 * 程序早先每次启动都随机分配端口，于是每次打开都是全新的存储空间 ——
 * JIZURA 的教程标记、界面设置、**工程自动保存**全都丢，而且丢得没声没响。
 * 所以「端口稳定」这件事不能只看代码，要真的关掉再开一次、把值读回来。
 *
 * 做法：给 WebView2 挂上 --remote-debugging-port，起程序 → 写探针 → 关掉 →
 * 再起 → 读回来。只用 Node 自带的 WebSocket（Node ≥22）和 fetch，不装任何包。
 *
 * 前提：**先关掉正在运行的工作站**（否则探针写进的是那个实例的窗口）。
 * 注意：程序是 windows 子系统，没有控制台；这里全程用 stdio: 'ignore' 起进程。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const EXE = join(__dirname, '..', '..', '清沐的虚拟歌姬工作站.exe')
const CDP_PORT = 9222
const PROBE_KEY = 'qingmu.port-probe'
const PROBE_VALUE = 'still-here'

let pass = 0
let fail = 0
const ok = (name, extra = '') => { pass++; console.log(`  [通过] ${name}${extra ? ' —— ' + extra : ''}`) }
const bad = (name, why) => { fail++; console.log(`  [失败] ${name} —— ${why}`) }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── 起程序 + 等 CDP ─────────────────────────────────────────── */

async function targets() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
  return res.json()
}

/** 起一个实例，返回它的窗口 URL（<http://127.0.0.1:端口/>） */
async function launch() {
  const proc = spawn(EXE, [], {
    stdio: 'ignore',
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` },
  })

  let page = null
  for (let i = 0; i < 60; i++) {
    try {
      const list = await targets()
      page = list.find((t) => t.type === 'page' && /^http:\/\/127\.0\.0\.1:\d+/.test(t.url ?? ''))
      if (page) break
    } catch { /* CDP 还没起来 */ }
    await sleep(500)
  }
  if (!page) {
    proc.kill()
    throw new Error('等不到窗口的 CDP 目标（端口 9222）。程序起来了吗？')
  }
  // 首屏还要 boot（等 /api/state），多给一点时间再连
  await sleep(4000)
  return { proc, url: page.url, wsUrl: page.webSocketDebuggerUrl }
}

/** 极简 CDP 客户端：一条 WebSocket，顺序发命令并等回包（和 pv-verify.mjs 一致） */
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
        const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
        return r.result.value
      }
      resolve({ evalJs, close: () => ws.close() })
    })
  })
}

async function stop(proc) {
  try { proc.kill() } catch { /* 已经没了 */ }
  await sleep(3000)
}

/* ── 主流程 ─────────────────────────────────────────────────── */

if (!existsSync(EXE)) {
  console.error(`找不到 ${EXE}`)
  process.exit(2)
}

console.log(`程序：${EXE}\n`)

let first = null
let second = null
try {
  /* ① 第一次启动：记端口，写探针 */
  first = await launch()
  const cdp1 = await connect(first.wsUrl)
  const origin1 = await cdp1.evalJs('location.origin')
  const port1 = Number(new URL(first.url).port)
  ok('第一次启动，窗口地址已确定', first.url)

  // 教程标记是用户实际报的那一项，一并写进去
  await cdp1.evalJs(`localStorage.setItem(${JSON.stringify(PROBE_KEY)}, ${JSON.stringify(PROBE_VALUE)});
                     localStorage.setItem('jizura.tourDone', '1'); 'written'`)
  const written = await cdp1.evalJs(`localStorage.getItem(${JSON.stringify(PROBE_KEY)})`)
  if (written === PROBE_VALUE) ok('探针已写入', `${PROBE_KEY}=${written}`)
  else bad('探针没写进去', JSON.stringify(written))

  // 给 WebView2 一点时间把 localStorage 落盘（硬杀进程前必须等）
  await sleep(6000)
  cdp1.close()

  /* ② 关掉，再起一次 */
  await stop(first.proc)
  first = null
  second = await launch()
  const cdp2 = await connect(second.wsUrl)
  const origin2 = await cdp2.evalJs('location.origin')
  const port2 = Number(new URL(second.url).port)

  if (port1 === port2) ok('两次启动用的是同一个端口', `${port1} → ${port2}`)
  else bad('端口变了', `${port1} → ${port2}（localStorage 会跟着换一套）`)

  if (origin1 === origin2) ok('origin 没变', origin1)
  else bad('origin 变了', `${origin1} → ${origin2}`)

  /* ③ 核心断言：重启后把值读回来 */
  const probe = await cdp2.evalJs(`localStorage.getItem(${JSON.stringify(PROBE_KEY)})`)
  if (probe === PROBE_VALUE) ok('重启后 localStorage 里的值还在（核心）', `${PROBE_KEY}=${probe}`)
  else bad('重启后 localStorage 是空的', `读回来的是 ${JSON.stringify(probe)}`)

  const tour = await cdp2.evalJs(`localStorage.getItem('jizura.tourDone')`)
  if (tour === '1') ok('jizura.tourDone 也还在（教程不会重复弹）', `jizura.tourDone=${tour}`)
  else bad('jizura.tourDone 丢了', JSON.stringify(tour))

  cdp2.close()
} catch (err) {
  bad('验证过程出错', err.message)
} finally {
  if (first?.proc) await stop(first.proc)
  if (second?.proc) await stop(second.proc)
}

console.log('')
console.log(fail === 0 ? `全部通过：${pass} 项` : `${pass} 项通过，${fail} 项失败`)
process.exitCode = fail === 0 ? 0 : 1
