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

import { h, mount, button, toast, formatBytes } from '../ui.js'
import { pickDirectory } from '../components/dirPicker.js'
import { api } from '../api.js'

/** 与歌词页约定的交接键：两边都要用，改名字要一起改 */
const LS_LYRICS = 'qingmu.pv.lyrics'
/** 同上：这份歌词已经填过一次了，别重复填 */
const LS_SENT = 'qingmu.pv.sent'
/** 歌词页「用这段歌词做文字 PV」会在这条后面补一句双语说明，导入本地文件时保持一致 */
const BILINGUAL_NOTE = '# 上面第一段是原文、第二段是译文。请把译文放到「注釈」的位置：原文|译文（同一行用竖线分开），别当成两句歌词。'

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
 * 所以「写 DOM + 派发 input」要重复几次，横跨它整个 boot，最后一次落在 boot 之后。
 *
 * ⚠️ 但**不能用固定的时间表**（早先是 [0,400,1000,2000,3500] 一串 setTimeout）：
 * 页面被节流时定时器会被拉长（实测一次 250ms 的等待能变成 6.9 秒），整轮能拖到二十多秒，
 * 状态栏一直停在「正在读取…」，用户看着就像导入卡死了。改成轮询：
 * 每 200ms 重写一遍，直到**读回值一致**就收工，最多 15 秒。
 * 收敛得快就结束得快，boot 慢就多等几轮，与机器快慢无关。
 */
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

  const ta = () => doc.getElementById('lyrics')
  const deadline = Date.now() + 15000
  let got = ''
  // 它 boot 末尾那次 syncUI() 会把我们的内容顶掉 —— 那一顶就是「它写完了」的信号：
  // 此后我们写进去的不会再被覆盖，补一次、喘口气就能收工，
  // 不用一直重写到超时（那样状态栏会白挂十几秒）。
  let overwriteAt = 0
  for (;;) {
    const cur = ta()
    got = cur ? cur.value : ''
    // 第一次读到「内容在、但不是我们写的」就是被它顶掉了
    if (!overwriteAt && got !== '' && got !== text) overwriteAt = Date.now()
    if (got === text && (!overwriteAt || Date.now() - overwriteAt > 600)) break
    if (Date.now() >= deadline) break
    writeLyrics(doc, text)
    kick()
    await new Promise((r) => setTimeout(r, 200))
  }

  return { ok: got === text, got: got.length, want: text.length }
}

/**
 * 人在这一页时，不该为了读一个 .lrc 先跑去「歌词」页绕一圈。
 *
 * 复用后端 `/api/lyrics/import`（它已经处理好 GBK 探测与译文拆分），
 * 拿回来的 `lyric` / `trans` 直接填进 JIZURA —— 走的是和「歌词页带过来」
 * 完全相同的 fill()。
 */
function importFromFile(w, status, initialDir) {
  // ⚠️ pickDirectory **不返回路径**，结果是从 onPick 回调出来的（见 dirPicker.js:106）。
  // 写成 `const path = await pickDirectory(...)` 会永远拿到 undefined，点了没反应还查不出原因。
  //
  // initial 给 state.paths.downloadDir（和歌词页那条路一致），用户手上那批 .lrc
  // 基本就在下载目录 —— 但**它只是起点，不是限制**：不给或目录不存在时
  // dirPicker 会退到第一个盘符 / 最近的可用父目录，用户可以自己往上往下走。
  pickDirectory({
    title: '选择歌词文件（.lrc）',
    mode: 'file',
    exts: ['lrc'],
    initial: initialDir || '',
    onPick: (path) => loadInto(w, status, path),
  })
}

/**
 * 读文件 → 填进 JIZURA。抽出来是因为它是 onPick 回调，不是 pickDirectory 的返回值。
 *
 * ⚠️ **接口字段名是 `lyric` / `trans`，不是 `lrc` / `tlyric`**
 * （形状见 docs/UI-KIT.md 的「歌词页接口」，后端 `lyrics.rs` 的 `import_file`）。
 * 早先这里读的是 `res.lrc`，恒为 undefined，结果把字符串 "undefined"
 * 填进了 JIZURA 的歌词框、状态栏永远停在「正在读取歌词文件…」——
 * 用户看到的就是「导入失败」。改字段名时两边要一起改。
 */
async function loadInto(w, status, path) {
  status.textContent = '正在读取歌词文件…'
  try {
    const res = await api.lyricsImport({ path })
    const lyric = String(res.lyric ?? '').trim()
    if (!lyric) throw new Error('这个文件里没有读到歌词')

    // 有译文就原文 + 译文一起给它（和歌词页的「双语」一致），它自己按时间轴对上
    const trans = String(res.trans ?? '').trim()
    const parts = [lyric]
    if (trans) parts.push(trans, BILINGUAL_NOTE)
    const text = parts.join('\n')

    const r = await fill(w, text)
    // 记成和歌词页同一种「带过来」的形态，切走再回来不会被重复填一遍
    lsSet(LS_LYRICS, text)
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

/* ══════════════════════════ 导出时的保存路径 ══════════════════════════ */

/*
 * 为什么要拦：JIZURA 导出 MP4 走的是**浏览器下载**（`URL.createObjectURL(blob)` +
 * 造一个 `<a download>` 点一下）。在 Tauri 的 WebView2 里，那只能落到系统默认下载目录，
 * 用户没法选。它自己的界面一个字都不能改，所以只能在外面做：
 *
 *   它的所有保存都过 `J.saveFile(name, blob)` 这一个口子
 *   （MP4、PNG 序列 ZIP、附带的 WAV 音频全走它），在父页面把这个函数换掉就够了 ——
 *   不用去 hook `URL.createObjectURL` 或 `<a>` 的 click，那些路径还会误伤别的东西。
 *
 * 注意 `mp4file`（「大型视频用（直接保存为文件）」）走的是它自己的
 * `showSaveFilePicker` + FileSystemWritableFileStream，**不经过这里** ——
 * 那条路本来就是系统保存对话框，等于已经能选路径。它现在在这个 iframe 里点不出来
 * （File System Access API 要求顶层文档），属于它的既有行为，与本次改动无关。
 */

/** 一次传多大。后端 `/api/pv/save` 的单块上限是 16MB，留一倍余量。 */
const CHUNK = 8 * 1024 * 1024

/**
 * 把 blob 写进用户选的目录（分块 POST）。
 *
 * 为什么不用 `<a download>` + 后端 `/api/fs/raw`：那还是浏览器下载，选不了路径。
 * 为什么不分块不行：4K 的 MP4 几百 MB，一次塞进内存再拼 base64 会顶到 GB 级占用。
 */
async function saveBlobTo(dir, name, blob, status) {
  const total = Math.ceil(blob.size / CHUNK) || 1
  let last = null
  for (let part = 0; part < total; part++) {
    const slice = blob.slice(part * CHUNK, Math.min((part + 1) * CHUNK, blob.size))
    const qs = new URLSearchParams({ dir, name, part: String(part) })
    const res = await fetch(`/api/pv/save?${qs}`, { method: 'POST', body: slice })
    const data = await res.json().catch(() => ({}))
    if (!res.ok || data.ok === false) throw new Error(data.error || `写入失败（HTTP ${res.status}）`)
    last = data
    if (total > 1) {
      status.textContent = `正在保存「${data.name}」… ${Math.round(((part + 1) / total) * 100)}%`
    }
  }
  return last
}

/** 弹目录选择器 → 落盘。返回新文件名，取消则返回 ''。 */
function saveWithPicker(name, blob, status) {
  return new Promise((resolve) => {
    let settled = false
    const done = (v) => { if (!settled) { settled = true; resolve(v) } }
    pickDirectory({
      title: `保存「${name}」到哪个目录`,
      onPick: async (dir) => {
        try {
          const saved = await saveBlobTo(dir, name, blob, status)
          status.textContent = saved?.path ? `已保存到 ${saved.path}` : '已保存'
          toast('已保存到所选目录', 'ok')
          done(saved?.name ?? name)
        } catch (err) {
          status.textContent = `保存失败：${err.message}`
          toast(err.message, 'err')
          done('')
        }
      },
      // 用户把对话框关了：别让它的导出流程一直等在那里
      onClose: (picked) => { if (!picked) { status.textContent = `已取消保存「${name}」`; done('') } },
    })
  })
}

/**
 * 把它的保存接管过来。返回 false 表示没找到它的保存函数（那就还是原来的浏览器下载，
 * 至少不会比现在更糟）。
 */
function hookSave(w) {
  if (typeof w?.J?.saveFile !== 'function') return false
  w.J.saveFile = async (name, data) => {
    const status = document.getElementById('pv-export-status')
    const blob = data instanceof w.Blob ? data : new w.Blob([data])
    if (status) status.textContent = `准备保存「${name}」（${formatBytes(blob.size)}）…`
    await saveWithPicker(String(name ?? '未命名'), blob, status ?? { textContent: '' })
    // 无论选没选，都当作「已经处理过」：返回 declined 之外的字符串会让它
    // 再走一遍浏览器下载，等于偷偷又存了一份到系统下载目录。
    return 'saved'
  }
  return true
}

export async function render(ctx) {
  const { container } = ctx

  const status = h('div.tiny.dim', { id: 'pv-export-status' }, '正在载入编辑器…')
  const iframe = h('iframe.pv-frame', {
    src: SRC,
    title: 'JIZURA 文字 PV 编辑器',
    // 音频试听要 autoplay，导出时点下载要走 clipboard / 下载 —— 但**不能加 sandbox**，
    // 加了就没有同源权限，下面那句 contentDocument 会被拦成 null
    allow: 'autoplay; clipboard-write; fullscreen',
  })

  mount(container, h('div.pv-view', [iframe]))

  // head 上：状态条 + 导入按钮。不做额外工具条占高度 —— 这是个编辑器，空间都留给它
  const importBtn = button('导入歌词文件', { iconName: 'file', size: 'btn-sm', onClick: () => importFromFile(iframe.contentWindow, status, ctx.state?.paths?.downloadDir) })
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

  // 接管它的保存（导出 MP4 / PNG 序列 / 附带的 WAV 都走 J.saveFile）—— 用户就能选目录了
  hookSave(w)

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
