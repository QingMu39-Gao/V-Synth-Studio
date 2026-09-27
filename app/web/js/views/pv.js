/**
 * 文字 PV：把歌词做成动态歌词视频（JIZURA）
 *
 * JIZURA 是随包分发的**构建产物**，放在 `app/web/vendor/jizura/index.html`，
 * 跟主界面同源（同一个本地服务），所以这里用 iframe 嵌进来就够了，不新开窗口。
 * 它的界面一个字都没改 —— 要升级就整份替换那个目录里的文件。
 *
 * 歌词是从「歌词」页带过来的：那条路会先把 LRC 写进 localStorage，再切到这里，
 * 由下面的 fill() 填进它的歌词框（细节见该函数）。
 */

import { h, mount, button, toast } from '../ui.js'
import { pickDirectory } from '../components/dirPicker.js'
import { api } from '../api.js'

/** 与歌词页约定的交接键：两边都要用，改名字要一起改 */
const LS_LYRICS = 'qingmu.pv.lyrics'
/** 已经填过一次就别再填，免得把用户在 JIZURA 里改过的歌词覆盖掉 */
const LS_SENT = 'qingmu.pv.sent'

const SRC = '/vendor/jizura/index.html'

/** localStorage 只存字符串，能坏也就能抛（隐私模式下 setItem 会直接抛） */
function lsGet(key) {
  try { return localStorage.getItem(key) ?? '' } catch { return '' }
}

function lsSet(key, value) {
  try { localStorage.setItem(key, value) } catch { /* 存不下就不存，下面还有 params 兜底 */ }
}

/**
 * 把歌词写进它的歌词框（一次）。
 *
 * 它的歌词框是 `<textarea id="lyrics">`，`bind()` 里挂了 `input` 监听
 * （`S.project.lyrics = e.target.value; replanSoon()`），所以**光改 value 不派事件**
 * 是没用的：它内部状态不变，预览不会重排，自动保存也不会触发。
 * 这里用原型上的原生 setter 赋值（绕开可能被改写的 value 属性），再派发一个
 * 冒泡的 input 事件，等价于用户手打。
 */
function writeLyrics(doc, text) {
  const ta = doc.getElementById('lyrics') || doc.querySelector('textarea')
  if (!ta) return false
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
  setter.call(ta, text)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  return true
}

/**
 * 填歌词。
 *
 * ⚠️ **填一次不够**。它的 `boot()` 是 `S.project = loadLocal()`（从
 * `localStorage['jizura.project.v1']` 读，没存过就用 `J.defaultProject()` 的示例歌词）
 * 然后 `syncUI()` 把 `S.project.lyrics` 写回 textarea —— 也就是**它自己会在启动末尾
 * 覆盖一次输入框**。实测：我们填进去那一刻是对的（读回一致），一两秒后 boot 跑完就被
 * 示例歌词顶掉了。
 *
 * 所以这里按时间点重写几次，横跨它整个 boot；最后一次落在 boot 之后，才是最终生效的那次。
 * 每次都是「写 DOM + 派发 input」，它自己的状态与自动保存会跟着最后一次走。
 */
const REPLAY_MS = [0, 400, 1000, 2000, 3500]

async function fill(w, text) {
  const doc = w.document
  if (!writeLyrics(doc, text)) return { ok: false, why: '没找到歌词输入框', got: 0, want: text.length }

  // 它自己会 replanSoon(260ms)，这里只是让首屏立刻跟上；失败不影响已填进去的内容
  const api = w.J?.uiApi
  const kick = () => {
    try { api?.replan?.() } catch { /* 它内部还没准备好就算了 */ }
    try { api?.flushSave?.() } catch { /* 同上 */ }
  }
  kick()

  for (const ms of REPLAY_MS.slice(1)) {
    await new Promise((r) => setTimeout(r, ms))
    writeLyrics(doc, text)
    kick()
  }

  // 读回来比对：这一步是判断「真的填进去了」而不是「以为填进去了」
  const ta = doc.getElementById('lyrics')
  const got = ta ? ta.value : ''
  return { ok: got === text, got: got.length, want: text.length }
}

/**
 * 人在这一页时，不该为了读一个 .lrc 先跑去「歌词」页绕一圈。
 *
 * 复用后端 `/api/lyrics/import`（它已经处理好 GBK 探测与译文拆分），
 * 拿回来的 `lrc` / `tlyric` 直接填进 JIZURA —— 走的是和「歌词页带过来」
 * 完全相同的 fill()。
 */
async function importFromFile(w, status) {
  // ⚠️ pickDirectory **不返回路径**，结果是从 onPick 回调出来的（见 dirPicker.js:106）。
  // 写成 `const path = await pickDirectory(...)` 会永远拿到 undefined，点了没反应还查不出原因。
  pickDirectory({
    title: '选择歌词文件（.lrc）',
    mode: 'file',
    exts: ['lrc'],
    initial: '',
    onPick: (path) => loadInto(w, status, path),
  })
}

/** 读文件 → 填进 JIZURA。抽出来是因为它是 onPick 回调，不是 pickDirectory 的返回值 */
async function loadInto(w, status, path) {
  status.textContent = '正在读取歌词文件…'
  try {
    const res = await api.lyricsImport({ path })
    // 有译文就按「原文 + 译文」一起给 JIZURA，它自己会按时间轴对上
    const text = res.tlyric?.trim() ? `${res.lrc}\n\n${res.tlyric}` : res.lrc
    const r = await fill(w, text)
    lsSet(LS_SENT, text)
    if (r.ok) {
      const note = res.encoding === 'gbk' ? '（按 GBK 读取）' : ''
      status.textContent = `已导入「${res.song?.name ?? '歌词'}」${note}，共 ${text.split('\n').length} 行。`
      toast('歌词已导入编辑器', 'ok')
    } else {
      status.textContent = `导入后填写可能没成功（${r.got ?? 0} / 应为 ${r.want ?? 0} 字）：${r.why ?? '读回值不一致'}`
    }
  } catch (err) {
    status.textContent = `导入失败：${err.message}`
    toast(err.message, 'err')
  }
}

export async function render(ctx) {
  const { container } = ctx

  const status = h('div.tiny.dim', '正在载入编辑器…')
  const iframe = h('iframe.pv-frame', {
    src: SRC,
    title: 'JIZURA 文字 PV 编辑器',
    // 音频试听要 autoplay，导出时点下载要走 clipboard / 下载 —— 但**不能加 sandbox**，
    // 加了就没有同源权限，下面那句 contentDocument 会被拦成 null
    allow: 'autoplay; clipboard-write; fullscreen',
  })

  mount(container, h('div.pv-view', [iframe]))

  // head 上：状态条 + 导入按钮。不做额外工具条占高度 —— 这是个编辑器，空间都留给它
  const importBtn = button('导入歌词文件', { iconName: 'file', size: 'btn-sm', onClick: () => importFromFile(iframe.contentWindow, status) })
  const head = document.getElementById('header-actions')
  if (head) mount(head, h('div.row.gap-sm', [status, importBtn]))

  // 等 iframe 加载完。
  //
  // ⚠️ 这里**不能只是** addEventListener('load')：本地服务很快，iframe 完全可能在本函数
  // 挂上监听之前就已经 load 完（load 只发一次），那样这个 Promise 永远不会 settle，
  // 整页就卡在「正在载入编辑器…」—— 实测就是这样，歌词一直没填进去。
  // 所以：先查 readyState，再把监听挂上，然后**再查一次** readyState 兜住中间那一瞬。
  await new Promise((resolve) => {
    const doc = iframe.contentDocument
    if (doc?.readyState === 'complete') {
      resolve()
      return
    }
    let settled = false
    const done = () => { if (!settled) { settled = true; resolve() } }
    iframe.addEventListener('load', done, { once: true })
    if (iframe.contentDocument?.readyState === 'complete') done()
    // 兜底：万一两种情况都没命中（比如 iframe 被浏览器回收了），别把整页钉死
    setTimeout(done, 15000)
  })

  const w = iframe.contentWindow
  if (!w?.document?.getElementById) {
    mount(status, '编辑器载入失败：拿不到它的文档。多半是 vendor/jizura 被删了或改坏了。')
    return
  }

  // 等它自己 boot() 完 —— boot 在 DOMContentLoaded 上，而 load 在它之后，
  // 所以此刻 J.uiApi 一般已经就绪；真没有就等一会儿，别硬填。
  for (let i = 0; i < 60 && !w.J?.uiApi; i++) await new Promise((r) => setTimeout(r, 100))

  // 优先用导航带过来的（F5 之后就没了），否则读歌词页留在 localStorage 的那份
  const text = String(ctx.params?.lyrics ?? lsGet(LS_LYRICS))
  if (!text.trim()) {
    mount(status, '编辑器已就绪。想带歌词进来的话，去「歌词」页点「用这段歌词做文字 PV」。')
    return
  }
  // 同一份歌词只自动填一次：用户手动清空后再切回来，不该又被塞回去
  if (lsGet(LS_SENT) === text) {
    mount(status, '编辑器已就绪（歌词已经带过来了，没有重复填写）。')
    return
  }

  const res = await fill(w, text)
  lsSet(LS_SENT, text)
  mount(status, res.ok
    ? `已把歌词填进编辑器（${text.split('\n').length} 行）。`
    : `歌词填写可能没成功（填进去 ${res.got ?? 0} / 应为 ${res.want ?? 0} 字）：${res.why ?? '读回的值不一致'}`)
}

export default { render }
