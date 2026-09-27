/**
 * 文字 PV 导出「选择保存路径」的真浏览器验证（CDP）
 *
 *   node tests/manual/pv-export-probe.mjs [port] [输出目录]
 *
 * 验的是我们从父页面接管 JIZURA 保存的那条路：
 *   进「文字 PV」页 → 装好接管 → 造一个和它导出时同样形状的 blob
 *   → 调它自己的 `J.saveFile(name, blob)`（**它导出的唯一出口**）
 *   → 弹我们的目录选择器 → 选目录 → 文件真的落到那个目录（列目录看，不是看返回的 JSON）
 *
 * ⚠️ 无头 Edge 里 WebCodecs 编不出 H.264，**真实 MP4 导出验不了** ——
 * 这里用的是内容可校验的假 blob，验的是「拦截 → 选目录 → 落盘」这条链路本身。
 *
 * 只用 Node 自带的 WebSocket（Node ≥22），不装任何包。
 */

const PORT = Number(process.argv[2] ?? 0) || 8891
const OUT_DIR = process.argv[3] || 'H:\\工作站\\downloads'
const BASE = `http://127.0.0.1:${PORT}`
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PROFILE = 'H:\\工作站\\tmp-pv-export-profile'
const CDP_PORT = 9341

import { spawn } from 'node:child_process'
import { rmSync, mkdirSync, existsSync, readFileSync, statSync, readdirSync, writeFileSync } from 'node:fs'

let pass = 0
let fail = 0
const ok = (name, extra = '') => { pass++; console.log(`  [通过] ${name}${extra ? ' —— ' + extra : ''}`) }
const bad = (name, why) => { fail++; console.log(`  [失败] ${name} —— ${why}`) }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 假 MP4：20MB + 一个可校验的尾部，验证分块拼接没把内容写坏
const FAKE_MB = 20
const TAIL = 'QINGMU-TAIL-CHECK'
const TAIL_BYTES = new TextEncoder().encode(TAIL).length
const NAME = '导出选路径验证.mp4'

try { rmSync(PROFILE, { recursive: true, force: true, maxRetries: 3, retryDelay: 400 }) } catch {
  spawn('powershell', ['-NoProfile', '-Command',
    "Get-Process -Name msedge -EA SilentlyContinue | Where-Object { $_.MainWindowHandle -eq 0 } | Stop-Process -Force"], { stdio: 'ignore' })
  await sleep(2500)
  rmSync(PROFILE, { recursive: true, force: true, maxRetries: 5, retryDelay: 400 })
}
mkdirSync(PROFILE, { recursive: true })

// 先清掉可能残留的目标文件（同名时后端会自动加 (1)，那样断言就找不到原名了）
const target = `${OUT_DIR}\\${NAME}`
for (let i = 0; i < 20 && existsSync(target); i++) rmSync(target, { force: true })

const edge = spawn(EDGE, [
  '--headless=old', '--disable-gpu', '--no-sandbox', '--no-first-run',
  `--remote-debugging-port=${CDP_PORT}`, `--user-data-dir=${PROFILE}`, 'about:blank',
], { stdio: 'ignore' })

let cdp = null
try {
  let t = null
  for (let i = 0; i < 60 && !t; i++) {
    try { t = (await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()).find((x) => x.type === 'page') } catch {}
    if (!t) await sleep(500)
  }
  if (!t) throw new Error(`连不上 CDP 端口 ${CDP_PORT}`)
  const ws = new WebSocket(t.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true })
    ws.addEventListener('error', () => rej(new Error('WebSocket 连不上')), { once: true })
  })
  let id = 0
  const pending = new Map()
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data)
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result)
  })
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id
    pending.set(i, { resolve, reject })
    ws.send(JSON.stringify({ id: i, method, params }))
  })
  const evalJs = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
    return r.result.value
  }
  cdp = { send, evalJs, close: () => ws.close() }

  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')
  console.log(`目标：${BASE}\n输出目录：${OUT_DIR}\n`)

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
  await cdp.evalJs(`(() => { [...document.querySelectorAll('.nav-item')].find(x => x.dataset.view === 'pv').click(); return true })()`)
  await waitForView(700)

  let ready = false
  for (let i = 0; i < 90 && !ready; i++) {
    ready = await cdp.evalJs(`(() => { const f = document.querySelector('iframe.pv-frame'); return !!(f && f.contentWindow && f.contentWindow.J && f.contentWindow.J.uiApi) })()`)
    if (!ready) await sleep(500)
  }
  if (ready) ok('JIZURA 已加载并 boot 完')
  else bad('JIZURA 没 boot 完', '找不到 J.uiApi')

  /* ① 它的保存已经被我们接管 */
  const hooked = await cdp.evalJs(`(() => {
    const w = document.querySelector('iframe.pv-frame').contentWindow
    return { hasSaveFile: typeof w.J?.saveFile === 'function', src: String(w.J.saveFile) }
  })()`)
  if (hooked.hasSaveFile && hooked.src.includes('saveWithPicker')) ok('J.saveFile 已被父页面接管', '它导出时唯一出口')
  else bad('J.saveFile 没被接管', JSON.stringify(hooked).slice(0, 200))

  /* ② 它的界面一个字没动 */
  const ui = await cdp.evalJs(`(() => {
    const d = document.querySelector('iframe.pv-frame').contentDocument
    const txt = [...d.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean)
    return {
      hasApp: !!d.getElementById('app'),
      hasMP4: !!d.getElementById('btnMP4'),
      hasPNG: !!d.getElementById('btnPNG'),
      mp4Label: d.getElementById('btnMP4')?.textContent.trim(),
      pngLabel: d.getElementById('btnPNG')?.textContent.trim(),
      btnCount: txt.length,
      hasOurs: txt.some(t => t.includes('保存到')),
      lyrics: !!d.getElementById('lyrics'),
    }
  })()`)
  if (ui.hasApp && ui.hasMP4 && ui.hasPNG && ui.lyrics) ok('JIZURA 界面结构与按钮都在', `MP4=「${ui.mp4Label}」 PNG=「${ui.pngLabel}」共 ${ui.btnCount} 个按钮`)
  else bad('JIZURA 界面结构变了', JSON.stringify(ui))
  if (!ui.hasOurs) ok('没有往它的界面里塞任何我们的按钮/文案')
  else bad('它的界面里出现了我们的东西', JSON.stringify(ui))

  /* ③ 真的调它的保存出口：等价于用户点了「导出 MP4」 */
  const called = await cdp.evalJs(`(async () => {
    const w = document.querySelector('iframe.pv-frame').contentWindow
    // 和它导出时一样：先编出一个真正的 Blob（内容可校验），再交给 saveFile
    const head = new Uint8Array(${FAKE_MB} * 1024 * 1024).fill(7)
    const tail = new TextEncoder().encode('QINGMU-TAIL-CHECK')
    const blob = new w.Blob([head, tail], { type: 'video/mp4' })
    const p = w.J.saveFile(${JSON.stringify(NAME)}, blob)
    window.__savePromise = p
    return { size: blob.size, type: blob.type }
  })()`)
  await sleep(2500)
  console.log(`  [信息] 交给它保存的 blob：${FAKE_MB}MB，type=${called.type}`)

  /* ④ 我们的目录选择器应该弹出来 —— JIZURA 那边不该有任何变化 */
  const dlg = await cdp.evalJs(`(() => {
    const m = document.querySelector('.modal-backdrop .modal')
    if (!m) return { err: '没有弹出目录选择器' }
    const jz = document.querySelector('iframe.pv-frame').contentDocument
    return {
      title: m.querySelector('.modal-head h2')?.textContent ?? '',
      path: m.querySelector('input.input.mono')?.value ?? '',
      entries: m.querySelectorAll('.dir-entry').length,
      jzExporting: jz.querySelector('.exp-box') && !jz.querySelector('.exp-box').hidden,
      status: document.querySelector('#pv-export-status')?.textContent ?? '',
    }
  })()`)
  if (dlg.err) bad('点导出后弹出我们的目录选择器', dlg.err)
  else {
    ok('导出时弹出了我们的目录选择器', `标题=「${dlg.title}」`)
    if (dlg.entries > 0) ok('选择器列表有内容', `${dlg.entries} 项，起始路径=${dlg.path}`)
    else bad('选择器列表是空的', JSON.stringify(dlg))
  }
  console.log(`  [信息] 顶栏状态：${JSON.stringify(dlg.status)}`)

  /* ⑤ 选目录 → 落盘 */
  await cdp.evalJs(`(() => {
    const m = document.querySelector('.modal-backdrop .modal')
    const input = m.querySelector('input.input.mono')
    input.value = ${JSON.stringify(OUT_DIR)}
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    return true
  })()`)
  await sleep(2000)
  const before = existsSync(target)
  await cdp.evalJs(`(() => {
    const m = document.querySelector('.modal-backdrop .modal')
    const btn = m.querySelector('.modal-foot button.btn-primary')
    const disabled = btn.disabled
    btn.click()
    return disabled
  })()`)

  // 20MB / 8MB = 3 块
  let landed = false
  for (let i = 0; i < 30 && !landed; i++) {
    await sleep(1000)
    landed = existsSync(target) && statSync(target).size >= (FAKE_MB * 1024 * 1024 + TAIL_BYTES)
  }

  if (before) bad('测试前目标文件已存在', target)
  if (landed) ok('文件真的落到了所选目录（列目录看到的，不是返回的 JSON）', target)
  else {
    bad('文件没落到目标目录', existsSync(target) ? `存在但大小=${existsSync(target) ? statSync(target).size : 0}` : '文件不存在')
    console.log('  [信息] 目录内容：' + JSON.stringify(readdirSync(OUT_DIR).slice(0, 10)))
  }

  if (landed) {
    const size = statSync(target).size
    const expect = FAKE_MB * 1024 * 1024 + TAIL_BYTES
    if (size === expect) ok('分块拼接后的字节数完全正确', `${size} 字节`)
    else bad('字节数不对', `实际 ${size}，应为 ${expect}`)

    const buf = readFileSync(target)
    const tail = buf.subarray(buf.length - TAIL_BYTES).toString('utf8')
    const headOk = buf[0] === 7 && buf[1024 * 1024] === 7 && buf[FAKE_MB * 1024 * 1024 - 1] === 7
    if (tail === TAIL) ok('尾部（最后一块）内容正确', JSON.stringify(tail))
    else bad('尾部内容不对', JSON.stringify(tail))
    if (headOk) ok('首块内容正确（没有被截断/写歪）')
    else bad('首块内容不对', `${buf[0]} / ${buf[1024 * 1024]} / ${buf[FAKE_MB * 1024 * 1024 - 1]}`)
  }

  /* ⑥ 它的导出流程没被弄坏：saveFile 正常返回，且没再走浏览器下载 */
  const settled = await cdp.evalJs(`window.__savePromise?.then(r => 'resolved:' + r, e => 'rejected:' + e.message) ?? 'pending'`)
  await sleep(1500)
  const result = await cdp.evalJs(`window.__savePromise?.then(r => 'resolved:' + r, e => 'rejected:' + e.message) ?? 'pending'`)
  if (String(result).startsWith('resolved:')) ok('它的 saveFile 正常返回（导出流程不会卡住）', String(result))
  else bad('saveFile 没正常结束', String(result))
  console.log(`  [信息] 返回前的状态：${JSON.stringify(settled)}`)

  /* ⑦ 取消不卡死：再调一次，把对话框关掉，saveFile 也必须有返回 */
  await cdp.evalJs(`(() => {
    const w = document.querySelector('iframe.pv-frame').contentWindow
    window.__cancelPromise = w.J.saveFile('取消验证.mp4', new w.Blob([new Uint8Array(1024)]))
    return true
  })()`)
  await sleep(2500)
  const cancelDlg = await cdp.evalJs(`!!document.querySelector('.modal-backdrop .modal')`)
  if (cancelDlg) ok('第二次调用同样弹出了选择器')
  else bad('第二次没弹出选择器', '')
  await cdp.evalJs(`(() => {
    const m = document.querySelector('.modal-backdrop .modal')
    m.querySelector('.modal-head button').click()
    return true
  })()`)
  await sleep(2000)
  const cancelResult = await cdp.evalJs(`window.__cancelPromise?.then(r => 'resolved:' + r, e => 'rejected:' + e.message) ?? 'pending'`)
  if (String(cancelResult).startsWith('resolved:')) ok('用户关掉对话框时 saveFile 也会返回（不会永远挂着）', String(cancelResult))
  else bad('取消后 saveFile 没返回', String(cancelResult))
  const cancelFile = `${OUT_DIR}\\取消验证.mp4`
  if (!existsSync(cancelFile)) ok('取消时没有偷偷落盘任何文件')
  else { bad('取消却写了文件', cancelFile); rmSync(cancelFile, { force: true }) }

  /* ⑧ 顺手验路径安全：文件名带 .. 不能写到别处 */
  const evil = await cdp.evalJs(`(async () => {
    const r = await fetch('/api/pv/save?dir=' + encodeURIComponent(${JSON.stringify(OUT_DIR)}) + '&name=' + encodeURIComponent('..\\\\..\\\\evil.mp4') + '&part=0', { method: 'POST', body: new Uint8Array([1,2,3]) })
    const d = await r.json()
    return { status: r.status, path: d.path ?? null, err: d.error ?? null }
  })()`)
  const evilLanded = String(evil.path ?? '').includes('evil.mp4') && String(evil.path).replace(/\//g, '\\').startsWith(OUT_DIR)
  if (evilLanded) ok('文件名里的路径分隔符被清掉，只落在所选目录里', evil.path)
  else bad('路径安全没兜住', JSON.stringify(evil))
  if (evilLanded) rmSync(String(evil.path), { force: true })

  /* ⑨ 目录不存在时必须报错，不能瞎写 */
  const noDir = await cdp.evalJs(`(async () => {
    const r = await fetch('/api/pv/save?dir=' + encodeURIComponent('Z:\\\\绝对不存在的目录') + '&name=x.mp4&part=0', { method: 'POST', body: new Uint8Array([1]) })
    return { status: r.status, body: (await r.text()).slice(0, 120) }
  })()`)
  if (noDir.status === 400) ok('目录不存在时返回 400 且说明原因', noDir.body)
  else bad('目录不存在时没按 400 拒绝', JSON.stringify(noDir))
} catch (err) {
  bad('脚本异常', err.stack ?? String(err))
} finally {
  try { cdp?.close() } catch { /* ignore */ }
  try { edge.kill() } catch { /* ignore */ }
}

console.log('')
console.log(fail === 0 ? `全部通过：${pass} 项` : `${pass} 项通过，${fail} 项失败`)
process.exit(fail === 0 ? 0 : 1)
