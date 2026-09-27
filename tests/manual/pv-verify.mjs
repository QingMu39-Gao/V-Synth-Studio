/**
 * 文字 PV 集成的真浏览器验证（CDP）
 *
 *   node tests/manual/pv-verify.mjs [port]
 *
 * 为什么不用 --dump-dom：它只 dump **顶层文档**，iframe 里面什么都看不到。
 * 而这次集成要验的恰恰是「JIZURA 有没有真加载出来」「歌词有没有填进它的输入框」，
 * 所以必须用 CDP 连上去，在页面上下文里取 iframe.contentDocument。
 *
 * 只用 Node 自带的 WebSocket（Node ≥22），不装任何包。
 * 需要先起一个测试实例：
 *   app\desktop\target\debug\qingmu-workstation.exe --serve --port=8891
 */

const PORT = Number(process.argv[2] ?? 0) || 8891
const BASE = `http://127.0.0.1:${PORT}`
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
const PROFILE = `${process.env.TEMP}\\pv-verify-profile`

import { spawn } from 'node:child_process'
import { rmSync, mkdirSync } from 'node:fs'

let pass = 0
let fail = 0
function ok(name, extra = '') {
  pass++
  console.log(`  [通过] ${name}${extra ? ' —— ' + extra : ''}`)
}
function bad(name, why) {
  fail++
  console.log(`  [失败] ${name} —— ${why}`)
}

/** 同一个测试歌词：带 LRC 时间戳，验证「原文原样带过去」而不是被重新格式化 */
const LRC = ['[00:12.34]第一句歌词', '[00:15.00]第二句歌词', '[00:18.50]第三句歌词'].join('\n')

/* ── 起一个无头 Edge 并连 CDP ───────────────────────────────── */

function startEdge() {
  rmSync(PROFILE, { recursive: true, force: true })
  mkdirSync(PROFILE, { recursive: true })
  const proc = spawn(EDGE, [
    '--headless=old',
    '--disable-gpu',
    '--no-sandbox',
    '--no-first-run',
    '--remote-debugging-port=9333',
    `--user-data-dir=${PROFILE}`,
    'about:blank',
  ], { stdio: 'ignore', detached: false })
  return proc
}

async function cdpTargets() {
  const res = await fetch('http://127.0.0.1:9333/json/list')
  return res.json()
}

/** 极简 CDP 客户端：一个 page target 一条 WebSocket，顺序发命令并等回包 */
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
      /** 在页面里求值，返回 JSON 化的结果（awaitPromise 让 async 表达式也能用） */
      const evalJs = async (expr) => {
        const r = await send('Runtime.evaluate', {
          expression: expr,
          returnByValue: true,
          awaitPromise: true,
          userGesture: true,
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ── 主流程 ─────────────────────────────────────────────────── */

const edge = startEdge()
let cdp = null
try {
  // 等 CDP 端口起来
  let targets = null
  for (let i = 0; i < 60; i++) {
    try { targets = await cdpTargets(); if (targets?.length) break } catch { /* 还没起来 */ }
    await sleep(500)
  }
  if (!targets?.length) throw new Error('连不上 Edge 的 CDP 端口 9333')

  const page = targets.find((t) => t.type === 'page')
  cdp = await connect(page.webSocketDebuggerUrl)
  await cdp.send('Page.enable')
  await cdp.send('Runtime.enable')

  console.log(`目标：${BASE}\n`)

  /**
   * 切视图。
   *
   * 两个坑都在这里踩过：
   *  1. **不能直接 Page.navigate 到 `#/lyrics`** —— 只改 fragment 不触发 load，
   *     SPA 也不会收到通知（hashchange 只在变化时触发），页面会停在 about:blank。
   *  2. **首屏很慢**：boot() 要等 /api/state（本机实测 3 秒多）才会渲染第一个视图，
   *     dashboard 大约 6-10 秒才出来。所以不能写死 sleep，要轮询到真的渲染出来为止。
   *
   * 这里改成：加载一次 → 点导航项（等价用户手点）→ 轮询等视图内容出来。
   */
  const waitForView = async (minBytes = 800, timeoutMs = 30000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      const n = await cdp.evalJs(`(document.getElementById('view')?.innerHTML ?? '').length`)
      if (n >= minBytes) return n
      await sleep(400)
    }
    return await cdp.evalJs(`(document.getElementById('view')?.innerHTML ?? '').length`)
  }

  let booted = false
  const gotoView = async (view, minBytes = 800) => {
    if (!booted) {
      await cdp.send('Page.navigate', { url: `${BASE}/` })
      await waitForView()          // 等 boot 完成、第一个视图渲染出来
      booted = true
    }
    const clicked = await cdp.evalJs(`(() => {
      const b = [...document.querySelectorAll('.nav-item')].find(x => x.dataset.view === ${JSON.stringify(view)})
      if (!b) return false
      b.click(); return true
    })()`)
    if (!clicked) throw new Error(`导航里没有 ${view} 这一项`)
    return waitForView(minBytes)
  }

  /** 等文字 PV 页里的 JIZURA 真的加载并 boot 完（它自己的 J.uiApi 出现为止） */
  const waitForPvReady = async (timeoutMs = 45000) => {
    const t0 = Date.now()
    while (Date.now() - t0 < timeoutMs) {
      const ready = await cdp.evalJs(`(() => {
        const f = document.querySelector('iframe.pv-frame')
        return !!(f && f.contentDocument && f.contentWindow.J && f.contentWindow.J.uiApi)
      })()`)
      if (ready) { await sleep(1500); return true }   // 留点时间让 fill() 跑完
      await sleep(500)
    }
    return false
  }

  /* ① 静态资源：200 + 内容里没有任何 Google 字体域名 */
  const res = await fetch(`${BASE}/vendor/jizura/index.html`)
  const html = await res.text()
  if (res.status === 200) ok('/vendor/jizura/index.html 能拿到', `HTTP 200，${html.length} 字节`)
  else bad('/vendor/jizura/index.html', `HTTP ${res.status}`)

  const google = html.match(/fonts\.(googleapis|gstatic)\.com/g) ?? []
  if (google.length === 0) ok('index.html 里没有 Google 字体域名残留')
  else bad('index.html 里还有 Google 字体域名', google.join('、'))

  const cssRes = await fetch(`${BASE}/vendor/jizura/fonts.css`)
  if (cssRes.status === 200) {
    const css = await cssRes.text()
    const g2 = css.match(/fonts\.(googleapis|gstatic)\.com/g) ?? []
    if (g2.length === 0) ok('fonts.css 里没有 Google 字体域名残留', `${css.length} 字节`)
    else bad('fonts.css 里还有 Google 字体域名', `${g2.length} 处`)
  } else {
    bad('/vendor/jizura/fonts.css', `HTTP ${cssRes.status}`)
  }

  /* ② 歌词页：二维码元素没了、退出登录还在 */
  await gotoView('lyrics')
  const lyricsProbe = await cdp.evalJs(`(() => {
    const t = document.body.innerText
    return {
      hash: location.hash,
      viewHtml: (document.getElementById('view')?.innerHTML ?? '').length,
      viewText: (document.getElementById('view')?.innerText ?? '').slice(0, 400),
      hasQrCanvas: !!document.querySelector('canvas.lyrics-qr'),
      hasQrBtn: [...document.querySelectorAll('button')].some(b => b.textContent.includes('显示二维码')),
      mentionsQr: t.includes('扫码'),
      mentions8821: t.includes('8821'),
      // 退出登录按钮存在（未登录时本来就是 display:none，所以按 textContent 找，不看可见性）
      hasLogoutBtn: [...document.querySelectorAll('button')].some(b => b.textContent.includes('退出登录')),
      hasPvBtn: [...document.querySelectorAll('button')].some(b => b.textContent.includes('用这段歌词做文字 PV')),
      btnTexts: [...document.querySelectorAll('button')].map(b => b.textContent.trim()).filter(Boolean).slice(0, 40),
    }
  })()`)
  if (!lyricsProbe.hasQrCanvas && !lyricsProbe.hasQrBtn) ok('歌词页没有二维码元素了')
  else bad('歌词页仍残留二维码元素', JSON.stringify(lyricsProbe))
  if (!lyricsProbe.mentionsQr) ok('歌词页正文不再提「扫码」')
  else bad('歌词页正文还有「扫码」', '')
  if (!lyricsProbe.mentions8821) ok('歌词页不再出现 8821 文案')
  else bad('歌词页还有 8821 文案', '')
  if (lyricsProbe.hasLogoutBtn) ok('「退出登录」按钮还在')
  else bad('「退出登录」按钮不见了', `页面按钮：${JSON.stringify(lyricsProbe.btnTexts)}`)
  if (lyricsProbe.hasPvBtn) ok('「用这段歌词做文字 PV」按钮在歌词页')
  else bad('找不到「用这段歌词做文字 PV」按钮', `页面按钮：${JSON.stringify(lyricsProbe.btnTexts)}`)
  if (lyricsProbe.viewHtml > 500) ok('歌词页确实渲染出来了', `hash=${lyricsProbe.hash}, view ${lyricsProbe.viewHtml} 字节`)
  else bad('歌词页没渲染', `view=${JSON.stringify(lyricsProbe.viewText)}`)

  /* ③ 直接给 localStorage 塞歌词，然后进文字 PV 页，看有没有填进 JIZURA 的输入框 */
  await cdp.evalJs(`localStorage.setItem('qingmu.pv.lyrics', ${JSON.stringify(LRC)});
                    localStorage.removeItem('qingmu.pv.sent'); 'seeded'`)

  await gotoView('pv', 800)
  // iframe 要下 2.3MB 的 JIZURA 再 boot，轮询等它自己的 J.uiApi 就绪
  await waitForPvReady()

  const pvProbe = await cdp.evalJs(`(() => {
    const f = document.querySelector('iframe.pv-frame')
    if (!f) return { err: '页面上没有 iframe.pv-frame' }
    const d = f.contentDocument
    if (!d) return { err: '拿不到 iframe.contentDocument' }
    const ta = d.getElementById('lyrics')
    const app = d.getElementById('app')
    return {
      src: f.getAttribute('src'),
      docTitle: d.title,
      appChildren: app ? app.children.length : -1,
      // JIZURA 自己有没有活起来：J.uiApi 是它给宿主页面留的钩子
      hasUiApi: !!f.contentWindow.J?.uiApi,
      taFound: !!ta,
      taValue: ta ? ta.value : null,
      taRows: ta ? ta.rows : null,
      // 顶层文档里的 iframe 尺寸
      frameW: f.clientWidth,
      frameH: f.clientHeight,
      bodyText: d.body.innerText.slice(0, 120),
    }
  })()`)

  if (pvProbe.err) {
    bad('文字 PV 页的 iframe', pvProbe.err)
  } else {
    ok('文字 PV 页有 iframe.pv-frame', `src=${pvProbe.src} ${pvProbe.frameW}x${pvProbe.frameH}`)
    if (pvProbe.hasUiApi) ok('JIZURA 真的加载起来了（J.uiApi 就绪）', `title=${pvProbe.docTitle}`)
    else bad('JIZURA 似乎没 boot 完', `app.children=${pvProbe.appChildren}`)
    if ((pvProbe.bodyText ?? '').trim().length > 20) ok('iframe 首屏有实际内容（不是白屏）', JSON.stringify(pvProbe.bodyText.slice(0, 60)))
    else bad('iframe 首屏像是空的', JSON.stringify(pvProbe.bodyText))
    if (pvProbe.taFound) ok('找到 JIZURA 的歌词输入框 #lyrics')
    else bad('iframe 里找不到 #lyrics 输入框', '')

    // 核心断言：读回值逐字比对
    if (pvProbe.taValue === LRC) ok('歌词已原样填进 JIZURA 的输入框（读回值逐字一致）', `${LRC.split('\n').length} 行`)
    else bad('歌词没有正确填进去', `期望 ${JSON.stringify(LRC)}，实际 ${JSON.stringify(pvProbe.taValue)}`)
  }

  /* ④ 填完之后 JIZURA 自己有没有认下来：内部状态 + 行数 + localStorage 自动保存 */
  const internal = await cdp.evalJs(`(() => {
    const f = document.querySelector('iframe.pv-frame')
    const w = f?.contentWindow
    const ta = f?.contentDocument?.getElementById('lyrics')
    const saved = localStorage.getItem('jizura.project.v1') || ''
    let savedLyrics = null
    try { savedLyrics = JSON.parse(saved)?.lyrics ?? null } catch {}
    return {
      taValue: ta ? ta.value : null,
      // 它自己的 UI 状态（J.ui = S）：project.lyrics 应该跟输入框一致
      projectLyrics: w?.J?.ui?.project?.lyrics ?? null,
      savedLyrics,
      // 歌词行列表有没有按 LRC 时间轴解析出行来
      lineCount: (w?.J?.ui?.plan?.lines ?? []).length,
    }
  })()`)

  if (internal.projectLyrics === LRC) ok('JIZURA 内部状态已同步（J.ui.project.lyrics 一致）')
  else bad('JIZURA 内部状态没跟上', `project.lyrics=${JSON.stringify(internal.projectLyrics)}`)

  if (internal.savedLyrics === LRC) ok('已落进它自己的自动保存（localStorage jizura.project.v1）')
  else bad('没落进它的自动保存', JSON.stringify(internal.savedLyrics))

  if (internal.lineCount >= 3) ok('JIZURA 把 LRC 解析成了歌词行', `${internal.lineCount} 行`)
  else bad('JIZURA 没解析出歌词行', `lineCount=${internal.lineCount}`)

  /* ⑤ 不重复填：同一份歌词二次进入不应该再动它 */
  const before = await cdp.evalJs(`document.querySelector('iframe.pv-frame').contentDocument.getElementById('lyrics').value`)
  await cdp.evalJs(`(() => { const f = document.querySelector('iframe.pv-frame');
    const ta = f.contentDocument.getElementById('lyrics');
    ta.value = '用户手动改过了'; ta.dispatchEvent(new Event('input', { bubbles: true })); return 'edited' })()`)
  await gotoView('lyrics')
  await gotoView('pv', 800)
  await waitForPvReady()
  const afterEdit = await cdp.evalJs(`document.querySelector('iframe.pv-frame').contentDocument.getElementById('lyrics').value`)
  if (afterEdit === '用户手动改过了') ok('同一份歌词不会二次覆盖用户的手动修改')
  else bad('二次进入把用户改的内容覆盖了', `现在=${JSON.stringify(afterEdit)}，之前填的是=${JSON.stringify(before)}`)

  /* ⑦ 按钮的接线：没选中歌曲时点它应该只提示、不跳页 */
  const btnWiring = await cdp.evalJs(`(() => {
    // 先切回歌词页
    const nav = [...document.querySelectorAll('.nav-item')].find(x => x.dataset.view === 'lyrics')
    nav.click()
    return 'clicked'
  })()`)
  await sleep(2500)
  const beforeNav = await cdp.evalJs(`location.hash`)
  await cdp.evalJs(`(() => {
    const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('用这段歌词做文字 PV'))
    if (!b) return 'no button'
    b.click(); return 'clicked'
  })()`)
  await sleep(1500)
  const afterNav = await cdp.evalJs(`location.hash`)
  const toastText = await cdp.evalJs(`(document.querySelector('.toast, [class*=toast]')?.innerText ?? '').slice(0,80)`)
  if (beforeNav === afterNav) ok('没选中歌曲时点按钮不会跳页', `hash 仍是 ${afterNav}，提示=${JSON.stringify(toastText)}`)
  else bad('没选中歌曲时点按钮却跳页了', `${beforeNav} → ${afterNav}`)

  /* ⑧ 不触碰 JIZURA 的界面：它的品牌与主结构还在 */
  await gotoView('pv', 800)
  await waitForPvReady()
  const untouched = await cdp.evalJs(`(() => {
    const d = document.querySelector('iframe.pv-frame').contentDocument
    return {
      hasApp: !!d.getElementById('app'),
      hasReset: !!d.getElementById('btnReset'),
      hasFileProject: !!d.getElementById('fileProject'),
      hasStyleGrid: !!d.querySelector('.style-grid, [class*=style]'),
      title: d.title,
      lang: d.documentElement.lang,
    }
  })()`)
  if (untouched.hasApp && untouched.hasReset && untouched.hasFileProject) {
    ok('JIZURA 原有 UI 未被改动', `title=${untouched.title} lang=${untouched.lang} 风格网格=${untouched.hasStyleGrid}`)
  } else {
    bad('JIZURA 的 UI 结构好像被动了', JSON.stringify(untouched))
  }

  /* ⑦ 字体确实从本地来：数一下落在 vendor/jizura/fonts/ 的字体请求 */
  const fontCheck = await cdp.evalJs(`(() => {
    const d = document.querySelector('iframe.pv-frame').contentDocument
    const sheets = [...d.styleSheets].map(s => s.href).filter(Boolean)
    // 找一个实际在用的字体的 @font-face 是否可用（document.fonts 里有没有注册）
    const faces = [...d.fonts].map(f => f.family + ' ' + f.weight).slice(0, 6)
    return { sheetHrefs: sheets, faceCount: d.fonts.size, faces }
  })()`)
  const localSheets = (fontCheck.sheetHrefs ?? []).filter((h) => h.includes('/vendor/jizura/'))
  if (localSheets.length > 0) ok('JIZURA 的字体表是从本地伺服加载的', localSheets.join('、'))
  else bad('没看到本地字体表被加载', JSON.stringify(fontCheck.sheetHrefs))
  if (fontCheck.faceCount > 0) ok('本地字体已注册进文档（document.fonts 非空）', `${fontCheck.faceCount} 个 face`)

} finally {
  try { cdp?.close() } catch { /* ignore */ }
  try { edge.kill() } catch { /* ignore */ }
}

console.log('')
console.log(fail === 0 ? `全部通过：${pass} 项` : `${pass} 项通过，${fail} 项失败`)
process.exit(fail === 0 ? 0 : 1)
