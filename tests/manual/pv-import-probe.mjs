/**
 * 文字 PV 页「导入歌词文件」的真浏览器验证（CDP）
 *
 *   node tests/manual/pv-import-probe.mjs [port]
 *
 * 验的是**用户手点那一条路**：
 *   进「文字 PV」页 → 点我们的「导入歌词文件」→ 目录选择器里文件列表真的列出来了
 *   → 选中一个 .lrc → 歌词进了 JIZURA 的 #lyrics。
 *
 * 只用 Node 自带的 WebSocket（Node ≥22），不装任何包。
 * 需要先起一个测试实例：
 *    v-synth-studio.exe --serve --port=8891
 */

const PORT = Number(process.argv[2] ?? 0) || 8891
const BASE = `http://127.0.0.1:${PORT}`
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PROFILE = 'H:\\工作站\\tmp-pv-import-profile'
const CDP_PORT = 9334

import { spawn } from 'node:child_process'
import { rmSync, mkdirSync, writeFileSync } from 'node:fs'

let pass = 0
let fail = 0
const ok = (name, extra = '') => { pass++; console.log(`  [通过] ${name}${extra ? ' —— ' + extra : ''}`) }
const bad = (name, why) => { fail++; console.log(`  [失败] ${name} —— ${why}`) }

/* 自己造一份待导入的 LRC（不依赖机器上碰巧存在的文件），跑完删掉 */
const LRC_DIR = 'H:\\工作站\\tmp-pv-lrc'
const LRC_NAME = '导入验证歌词.lrc'
const LRC_TEXT = [
  '[ti:导入验证]',
  '[00:01.00]第一句歌词',
  '[00:03.50]第二句歌词',
  '[00:06.20]第三句歌词',
].join('\n')
rmSync(LRC_DIR, { recursive: true, force: true })
mkdirSync(LRC_DIR, { recursive: true })
writeFileSync(`${LRC_DIR}\\${LRC_NAME}`, LRC_TEXT, 'utf8')

/* ── 无头 Edge + CDP ─────────────────────────────────────── */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 上一次跑剩的**无头** Edge 占着 profile 目录就清不掉，所以顺序是：
 * 先删（删不掉说明还有残留）→ 再起新的。
 * ⚠️ **不能「先杀 msedge 再起」**：那样会把自己刚起的那个也一起杀掉
 * （实测 Edge 立刻以 0xFFFFFFFF 退出，然后卡在「连不上 CDP」查半天）。
 * 只杀没有主窗口的（headless），用户自己开着的 Edge 不动。
 */
try {
  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 3, retryDelay: 400 })
} catch {
  spawn('powershell', ['-NoProfile', '-Command',
    "Get-Process -Name msedge -EA SilentlyContinue | Where-Object { $_.MainWindowHandle -eq 0 } | Stop-Process -Force",
  ], { stdio: 'ignore' })
  await sleep(2500)
  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 })
}
mkdirSync(PROFILE, { recursive: true })

const edge = spawn(EDGE, [
  '--headless=old', '--disable-gpu', '--no-sandbox', '--no-first-run',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`, 'about:blank',
], { stdio: 'ignore' })
edge.on('error', (e) => console.log(`  [信息] Edge 起不来：${e.message}`))
edge.on('exit', (c) => console.log(`  [信息] Edge 退出了，退出码 ${c}`))

async function connect() {
  let target = null
  for (let i = 0; i < 60 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
      target = list.find((t) => t.type === 'page')
    } catch { /* 还没起来 */ }
    if (!target) await sleep(500)
  }
  if (!target) throw new Error(`连不上 CDP 端口 ${CDP_PORT}`)

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', () => rej(new Error('WebSocket 连不上')), { once: true })
  })
  let id = 0
  const pending = new Map()
  const logs = []
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    if (m.method === 'Runtime.exceptionThrown') {
      logs.push('页面异常：' + (m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text))
    }
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
      logs.push(`console.${m.params.type}：` + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
    }
    if (m.method === 'Runtime.consoleAPICalled' && String(m.params.args?.[0]?.value ?? '').startsWith('[pv]')) {
      logs.push('pv: ' + m.params.args.map((a) => a.value ?? a.description ?? '').join(' '))
    }
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
  })
  const send = (method, params = {}) => new Promise((res, rej) => {
    const myId = ++id
    pending.set(myId, { resolve: res, reject: rej })
    ws.send(JSON.stringify({ id: myId, method, params }))
  })
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }
  return { send, evalJs, close: () => ws.close(), logs }
}

/* ── 主流程 ──────────────────────────────────────────────── */

let cdp = null
try {
  cdp = await connect()
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  console.log(`目标：${BASE}\n`)

  // 视图渲染的字节数门槛：PV 页整页就是一个 iframe，加上 head 上的按钮
  const waitForView = async (minBytes = 700, timeoutMs = 40000) => {
    const t0 = Date.now()
    let n = 0
    while (Date.now() - t0 < timeoutMs) {
      n = await cdp.evalJs(`(document.getElementById('view')?.innerHTML ?? '').length`)
      if (n >= minBytes) return n
      await sleep(400)
    }
    return n
  }

  await cdp.send('Page.navigate', { url: `${BASE}/` })
  await waitForView()
  await cdp.evalJs(`(() => {
    const b = [...document.querySelectorAll('.nav-item')].find(x => x.dataset.view === 'pv')
    b.click(); return true
  })()`)
  await waitForView(700)

  // 等 JIZURA 自己 boot 完（它的 J.uiApi 出现）
  let ready = false
  for (let i = 0; i < 90 && !ready; i++) {
    ready = await cdp.evalJs(`(() => {
      const f = document.querySelector('iframe.pv-frame')
      return !!(f && f.contentWindow && f.contentWindow.J && f.contentWindow.J.uiApi)
    })()`)
    if (!ready) await sleep(500)
  }
  if (ready) ok('JIZURA 已经加载并 boot 完', 'J.uiApi 就绪')
  else bad('JIZURA 没 boot 完', '找不到 J.uiApi')

  /* ① head 上有我们的按钮 */
  const head = await cdp.evalJs(`(() => {
    const btns = [...document.querySelectorAll('#header-actions button')].map(b => b.textContent.trim())
    return { btns, html: document.getElementById('header-actions').innerHTML.length }
  })()`)
  if (head.btns.includes('导入歌词文件')) ok('顶栏有「导入歌词文件」按钮', JSON.stringify(head.btns))
  else bad('顶栏找不到「导入歌词文件」按钮', JSON.stringify(head))

  /* ② 点它 —— 应该弹出目录选择器，并且**文件列表真的列出来** */
  await cdp.evalJs(`(() => {
    [...document.querySelectorAll('#header-actions button')].find(b => b.textContent.includes('导入歌词文件')).click()
    return true
  })()`)
  await sleep(2500)

  const dlg = await cdp.evalJs(`(() => {
    const m = document.querySelector('.modal-backdrop .modal')
    if (!m) return { err: '没有弹出对话框' }
    const entries = [...m.querySelectorAll('.dir-list .dir-entry')].map(e => e.textContent.trim())
    const files = [...m.querySelectorAll('.dir-list .dir-entry.file')].map(e => e.textContent.trim())
    const pathInput = m.querySelector('input.input.mono')
    return {
      title: m.querySelector('.modal-head h2')?.textContent ?? '',
      path: pathInput?.value ?? '',
      entryCount: entries.length,
      fileCount: files.length,
      files: files.slice(0, 10),
      // 有没有「读取中…」还没落地 / 错误行
      stuck: entries.some(t => t.includes('读取中')),
      errored: [...m.querySelectorAll('.dir-list .dir-entry')].some(e => e.style.color.includes('err')),
      confirmDisabled: m.querySelector('.modal-foot button.btn-primary')?.disabled ?? null,
    }
  })()`)

  if (dlg.err) {
    bad('点「导入歌词文件」后弹出目录选择器', dlg.err)
  } else {
    ok('点「导入歌词文件」弹出了目录选择器', `标题=${dlg.title}`)
    if (dlg.path) ok('选择器带上了初始路径（不是空）', dlg.path)
    else bad('选择器的路径是空的', JSON.stringify(dlg))
    if (dlg.entryCount > 0) ok('文件列表真的列出来了', `${dlg.entryCount} 项，其中 .lrc ${dlg.fileCount} 个`)
    else bad('文件列表是空的', JSON.stringify(dlg))
    if (!dlg.stuck) ok('列表没有卡在「读取中…」')
    else bad('列表卡在「读取中…」', JSON.stringify(dlg))
    if (!dlg.errored) ok('列表没有报错行')
    else bad('列表里有错误行', JSON.stringify(dlg))
    if (dlg.confirmDisabled === true) ok('未选文件时「选择此文件」是禁用的', '符合预期')
  }

  /* ③ 在路径框里填我们造的那个目录，确认能列出并选中 */
  await cdp.evalJs(`(() => {
    const m = document.querySelector('.modal-backdrop .modal')
    const input = m.querySelector('input.input.mono')
    input.value = ${JSON.stringify(LRC_DIR)}
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`)
  await sleep(2000)

  const listed = await cdp.evalJs(`(() => {
    const m = document.querySelector('.modal-backdrop .modal')
    const rows = [...m.querySelectorAll('.dir-entry.file')]
    return { names: rows.map(r => r.textContent.trim()), count: rows.length }
  })()`)
  if (listed.names.some((t) => t.includes(LRC_NAME.replace('.lrc', '')))) {
    ok(`切到 ${LRC_DIR} 后列出了目标歌词文件`, JSON.stringify(listed.names.slice(0, 4)))
  } else {
    bad('没列出目标歌词文件', JSON.stringify(listed.names))
  }

  /* ④ 选中它 → 走 onPick → 后端导入 → 填进 JIZURA */
  const clicked = await cdp.evalJs(`(() => {
    const m = document.querySelector('.modal-backdrop .modal')
    const row = [...m.querySelectorAll('.dir-entry.file')].find(r => r.title.includes(${JSON.stringify(LRC_NAME)}))
    if (!row) return false
    row.click()
    const btn = m.querySelector('.modal-foot button.btn-primary')
    if (btn.disabled) return 'confirm-disabled'
    btn.click()
    return true
  })()`)
  if (clicked === true) ok('选中文件后「选择此文件」可点，已点击')
  else bad('选中文件后无法确认', String(clicked))

  // 等导入 + fill() 跑完。
  // ⚠️ toast 3.6 秒就自己消失了，所以**边等边看**，不能等完再查（早先是等完再查，
  // 结果「没有成功提示」—— 其实提示出现过，只是早没了）。
  let toastSeen = ''
  let statusSeen = ''
  for (let i = 0; i < 40; i++) {
    await sleep(400)
    const seen = await cdp.evalJs(`(() => ({
      t: [...document.querySelectorAll('.toast')].map(x => x.innerText.trim()).join(' | '),
      s: document.querySelector('#pv-export-status')?.textContent ?? '',
    }))()`)
    if (seen.t && !toastSeen) toastSeen = seen.t
    if (seen.s.includes('已导入') || seen.s.includes('失败')) statusSeen = seen.s
    if (toastSeen && statusSeen) break
  }

  const after = await cdp.evalJs(`(() => {
    const f = document.querySelector('iframe.pv-frame')
    const d = f.contentDocument
    const ta = d.getElementById('lyrics')
    return {
      taLen: ta ? ta.value.length : -1,
      taHead: ta ? ta.value.slice(0, 60) : null,
      projectLyrics: f.contentWindow?.J?.ui?.project?.lyrics?.length ?? -1,
      lines: (f.contentWindow?.J?.ui?.plan?.lines ?? []).length,
      status: document.querySelector('#pv-export-status')?.textContent ?? '',
      modalGone: !document.querySelector('.modal-backdrop'),
    }
  })()`)
  after.toasts = toastSeen ? [toastSeen] : []
  if (statusSeen) after.status = statusSeen

  const looksLikeLrc = /^\[/.test(String(after.taHead ?? '').trim())
  if (after.taLen > 0 && looksLikeLrc) ok('歌词真的进了 JIZURA 的 #lyrics（点出来的，不是塞的）', `${after.taLen} 字，开头=${JSON.stringify(after.taHead)}`)
  else bad('歌词没进去 / 进去的不是歌词', JSON.stringify(after))
  if (after.taLen === LRC_TEXT.length) ok('进去的字节数就是那份 LRC', `${after.taLen} 字`)
  else bad('长度对不上', `实际 ${after.taLen}，应为 ${LRC_TEXT.length}`)
  if (!String(after.taHead ?? '').includes('undefined')) ok('没有把 "undefined" 当歌词填进去')
  else bad('填进去的是 undefined', JSON.stringify(after.taHead))
  if (after.status.includes('已导入')) ok('顶栏状态变成了成功文案', after.status)
  else bad('顶栏状态不是成功文案', after.status)
  if (after.toasts.some((t) => t.includes('歌词已导入'))) ok('给了成功提示（右上角 toast）', JSON.stringify(after.toasts))
  else bad('没有成功提示', JSON.stringify(after.toasts))
  if (after.projectLyrics === after.taLen && after.taLen > 0) ok('JIZURA 内部状态同步了', `project.lyrics=${after.projectLyrics} 字`)
  else bad('JIZURA 内部状态没跟上', JSON.stringify(after))
  if (after.lines > 0) ok('JIZURA 把歌词解析成了行', `${after.lines} 行`)
  else bad('没解析出歌词行', JSON.stringify(after))
  if (after.modalGone) ok('选完文件对话框正常关闭')
  else console.log('  [信息] 对话框关闭动画还没走完（不是失败，只是时序）')
  console.log(`  [信息] 顶栏状态：${JSON.stringify(after.status)}`)
  if (cdp.logs.length) console.log('  [信息] 页面异常：\n' + cdp.logs.join('\n'))

  // 内容也要对得上：不能只是「有字」，得是那份 LRC
  if (after.taHead && String(after.taHead).includes('第一句歌词')) ok('进去的就是我们那份 LRC', JSON.stringify(String(after.taHead).slice(0, 40)))
  else bad('进去的不是我们那份 LRC', JSON.stringify(after.taHead))

  /* ⑤ 兜底：初始目录不存在时还能不能用 */
  await cdp.evalJs(`(() => {
    [...document.querySelectorAll('#header-actions button')].find(b => b.textContent.includes('导入歌词文件')).click()
    return true
  })()`)
  await sleep(2000)
  await cdp.evalJs(`(() => {
    const m = document.querySelector('.modal-backdrop .modal')
    const input = m.querySelector('input.input.mono')
    input.value = 'Z:\\\\不存在的目录\\\\更深的目录'
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`)
  await sleep(2500)
  const missing = await cdp.evalJs(`(() => {
    const m = document.querySelector('.modal-backdrop .modal')
    const rows = [...m.querySelectorAll('.dir-list .dir-entry')]
    return {
      path: m.querySelector('input.input.mono')?.value ?? '',
      count: rows.length,
      stuck: rows.some(r => r.textContent.includes('读取中')),
      text: rows.slice(0, 3).map(r => r.textContent.trim()),
    }
  })()`)
  console.log(`  [信息] 输入不存在的目录后：${JSON.stringify(missing)}`)
  if (!missing.stuck && missing.count > 0) ok('目录不存在时仍退到最近的可用目录（没卡住、有内容）', `${missing.count} 项，路径=${missing.path}`)
  else bad('目录不存在时列表降级失败', JSON.stringify(missing))

  await cdp.evalJs(`document.querySelector('.modal-backdrop')?.remove(); true`)
} catch (err) {
  bad('脚本异常', err.stack ?? String(err))
} finally {
  try { cdp?.close() } catch { /* ignore */ }
  try { edge.kill() } catch { /* ignore */ }
  rmSync(LRC_DIR, { recursive: true, force: true })
}

console.log('')
console.log(fail === 0 ? `全部通过：${pass} 项` : `${pass} 项通过，${fail} 项失败`)
process.exit(fail === 0 ? 0 : 1)
