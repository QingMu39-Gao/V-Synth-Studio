import { useCallback, useEffect, useRef, useState } from 'react'
import { GlassDialog, List, ListRow, ListSection, PathBar } from '@ttqtt/liquid-glass-react'
import { api, type FsEntry } from '@/lib/api'
import { Button } from '@/components/Button'
import { DirPicker } from '@/components/DirPicker'
import { Panel } from '@/components/Panel'
import { formatBytes } from '@/lib/format'
import type { PageProps } from './types'
import './Pv.css'

/**
 * 文字 PV：把歌词做成动态歌词视频（JIZURA）—— 旧前端 `app/web/js/views/pv.js` 的搬家版。
 *
 * 整页就是一个 iframe，指向 `/vendor/jizura/index.html`：JIZURA
 * （<https://github.com/852wa/JIZURA>，MIT）的**构建产物**随包分发在 `app/web/vendor/jizura/`，
 * 与主界面同源，所以父页面可以直接操作它的 DOM。**它的界面一个字都不改**，
 * 升级就整份替换那个目录 —— 这一页所有的脏活都来自这条约束。
 *
 * 四件事必须照旧（都是踩出来的，细节见 `docs/LEGACY-UI.md`「文字 PV 页的交接」）：
 *
 *   1. **歌词走 `localStorage` 交接**（键 `qingmu.pv.lyrics`）：歌词页写、这里读。
 *      填完把同一份写进 `qingmu.pv.sent`，同一份不再重复填 —— 用户手动清空后再切回来，
 *      不该又被塞回去。
 *   2. **改它的歌词框必须同时派发冒泡的 `input` 事件**：它的 `bind()` 挂了
 *      `input` 监听（`S.project.lyrics = e.target.value; replanSoon()`），
 *      光改 `value` 它内部状态不变、预览不重排、自动保存也不触发。见 `writeLyrics()`。
 *   3. **填歌词按「读回值」收敛，不要写死时间表**：它的 `boot()` 末尾会用 `syncUI()`
 *      把 `S.project.lyrics` 覆盖回输入框，所以第一次写入会被顶掉、得补写；
 *      而页面被节流时定时器会被拉长（无头环境实测 250ms 变成 6.9 秒），
 *      一串固定的 `setTimeout` 能把整轮拖到二十多秒，用户看到的就是「导入卡死」。
 *      改成轮询到「读回值一致」，并且读到「内容在、但不是我们写的」= 它的 boot 跑完了，
 *      补一次再等 600ms 收工。见 `fill()`。
 *   4. **导出 MP4 的保存路径由父页面接管**：它的所有保存都过 `J.saveFile(name, blob)`
 *      （MP4、PNG 序列 ZIP、附带的 WAV），换成「弹目录选择 → 分块 POST `/api/pv/save`」就够了，
 *      不用去 hook `URL.createObjectURL` 或 `<a>` 的 click —— 那些路径会误伤别的东西。
 *      返回 `'saved'` 是为了不让它再走一遍浏览器下载（否则会偷偷又存一份到系统下载目录）。
 *
 * 与旧实现**故意不同**的一处：旧页面还能吃 `ctx.params.lyrics`（歌词页导航时带过来的参数），
 * 新前端的 `PageProps` 里没有 params 这条路；而且 params 只在这一次导航里有效、按 F5 就没了。
 * 所以只留 `localStorage` 那一条 —— 新歌词页「用这段歌词做文字 PV」写的也正是它。
 */

/* ══════════════════════════════════════════════════════════════ 常量 ══ */

/** 与歌词页约定的交接键：两边都要用，改名字要一起改（`pages/Lyrics.tsx` 的 `LS_PV_LYRICS`） */
const LS_LYRICS = 'qingmu.pv.lyrics'
/** 同上：这份歌词已经填过一次了，别重复填 */
const LS_SENT = 'qingmu.pv.sent'
/** 歌词页「用这段歌词做文字 PV」会在这条后面补一句双语说明，导入本地文件时保持一致 */
const BILINGUAL_NOTE =
  '# 上面第一段是原文、第二段是译文。请把译文放到「注釈」的位置：原文|译文（同一行用竖线分开），别当成两句歌词。'

const SRC = '/vendor/jizura/index.html'

/** 一次传多大。后端 `/api/pv/save` 的单块上限是 16MB，留一倍余量。 */
const CHUNK = 8 * 1024 * 1024

/** 填歌词最多等多久（按读回值收敛，不是时间表 —— 见 `fill()`） */
const FILL_TIMEOUT = 15000

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms))

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** localStorage 只存字符串，能坏也就能抛（隐私模式下 setItem 会直接抛） */
function lsGet(key: string): string {
  try {
    return localStorage.getItem(key) ?? ''
  } catch {
    return ''
  }
}

function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 存不下就不存：正文里的流程不依赖它 */
  }
}

/**
 * JIZURA 挂在它自己 window 上的那几个东西（只声明用得到的，别照它的源码抄一遍）。
 * 它是 `window.J`：`uiApi`（replan / flushSave）、`saveFile`（所有导出的唯一出口）。
 */
interface JizuraWindow extends Window {
  /**
   * 这两个构造器运行时就在 `window` 上，但 lib.dom 把它们声明成全局 `var`、
   * **没写进 `Window` 接口**，所以要显式补一下才能 `win.HTMLTextAreaElement.prototype`。
   */
  HTMLTextAreaElement: typeof HTMLTextAreaElement
  Event: typeof Event
  J?: {
    uiApi?: { replan?: () => void; flushSave?: () => void }
    saveFile?: (name: string, data: unknown) => unknown
  }
}

/** `/api/lyrics/import` 实际回的形状（`server/lyrics.rs`）：`{ song, lyric, trans, encoding }` */
interface ImportedLrc {
  song?: { name?: string }
  lyric?: string
  trans?: string
  encoding?: string
}

/* ══════════════════════════════════════════════════════ iframe 里的事 ══ */

/**
 * 等 iframe 里的编辑器真的出现，返回它的 document（超时返回 null）。
 *
 * ⚠️ **别拿 `readyState === 'complete'` 判「iframe 加载完了」** —— 这一条和旧前端不同：
 * React 挂载这一刻 iframe 里还是初始的 `about:blank`，而**它本来就是 complete**，
 * 于是「先查 readyState，是 complete 就开工」会立刻返回，接着我们在 vendor 那份 HTML
 * 还没到的时候去找歌词框，白白误报「/vendor/jizura/ 文件缺失」（实测踩到，
 * 截图上它的界面明明在跑）。旧前端是先建元素、同时给 `src`，那会儿还是 loading，所以没暴露。
 *
 * 这里改成盯住**它 HTML 里静态就有的歌词框**（`#lyrics`）：它出现 = 那份构建产物加载出来了，
 * 顺便把「文件到底在不在」也验了。另外：如果那个文档已经加载完（`complete`）
 * 却连歌词框都没有，那就是真的坏了（404 的错误页 / 被改坏的 HTML），不必等到超时。
 */
async function waitForEditor(
  frame: HTMLIFrameElement,
  isAlive: () => boolean,
  timeoutMs = 30000,
): Promise<Document | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const doc = frame.contentDocument
    /**
     * ⚠️ **`#lyrics` 出现 ≠ JIZURA 的 `boot()` 跑完。**
     *
     * vendor 末尾是 `if (readyState === 'loading') addEventListener('DOMContentLoaded', boot)
     * else boot(); J.ui = S; J.uiApi = {…}` —— 解析期就赋好 `uiApi`，而 `boot()` 挂在
     * DOMContentLoaded 上，实测能晚到 8~13 秒才跑。它 `boot()` 末尾的 `syncUI()` 会把
     * `S.project.lyrics` 覆盖回输入框，于是出现「填进去 → 读回一致 → 几秒后被默认工程顶掉」。
     *
     * 所以这里**额外要求整个文档 `readyState === 'complete'`**：`load` 必然在
     * DOMContentLoaded 之后 ⇒ boot 一定已经跑完。旧前端没有这个坑，正是因为它 await 了
     * iframe 的 `load` 事件 —— 同一个条件，只是这边用轮询表达。
     */
    const booted = doc?.readyState === 'complete'
    if (doc && booted && (doc.getElementById('lyrics') || doc.querySelector('textarea'))) return doc
    // 加载完了还是没有编辑器 → 失败得快一点，别让用户对着空白等半分钟
    if (booted && String(doc?.location?.href ?? '').includes('/vendor/jizura/')) {
      return null
    }
    if (Date.now() >= deadline || !isAlive()) return null
    await sleep(150)
  }
}

/**
 * 把歌词写进它的歌词框（一次）。
 *
 * 它的歌词框是 `<textarea id="lyrics">`。用原型上的原生 setter 赋值（绕开可能被改写的
 * `value` 属性），再派发一个冒泡的 `input` 事件 —— 等价于用户手打。
 *
 * setter 与 `Event` 都取**它那个 realm 的**（`win.HTMLTextAreaElement` / `win.Event`）：
 * 借父页面的构造器也能用，但那是没写在规范里的行为，不如各归各的。
 */
function writeLyrics(win: JizuraWindow, text: string): boolean {
  const doc = win.document
  const ta = (doc.getElementById('lyrics') ?? doc.querySelector('textarea')) as HTMLTextAreaElement | null
  if (!ta) return false
  const setter = Object.getOwnPropertyDescriptor(win.HTMLTextAreaElement.prototype, 'value')?.set
  if (setter) setter.call(ta, text)
  else ta.value = text
  ta.dispatchEvent(new win.Event('input', { bubbles: true }))
  return true
}

/**
 * 填歌词：**按读回值收敛**（旧前端是 `[0,400,1000,2000,3500]` 一串 setTimeout，被节流时
 * 整轮能拖到二十多秒，状态栏一直停在「正在读取…」）。这里每 200ms 重写一遍，
 * 直到读回值一致就收工，最多 `FILL_TIMEOUT`。
 *
 * 「它 boot 末尾那次 `syncUI()` 把我们的内容顶掉」正是「它写完了」的信号：
 * 此后我们写进去的不会再被覆盖，补一次、喘口气（600ms）就能收工，
 * 不用一直重写到超时（那样状态栏会白挂十几秒）。
 */
async function fill(
  win: JizuraWindow,
  text: string,
  isAlive: () => boolean,
): Promise<{ ok: boolean; why?: string; got: number; want: number }> {
  if (!writeLyrics(win, text)) {
    return { ok: false, why: '没找到歌词输入框', got: 0, want: text.length }
  }

  /** 它自己会 `replanSoon(260ms)`，这里只是让首屏立刻跟上；失败不影响已经填进去的内容 */
  const kick = () => {
    try {
      win.J?.uiApi?.replan?.()
    } catch {
      /* 它内部还没准备好就算了 */
    }
    try {
      win.J?.uiApi?.flushSave?.()
    } catch {
      /* 同上 */
    }
  }
  kick()

  const ta = () => win.document.getElementById('lyrics') as HTMLTextAreaElement | null
  const deadline = Date.now() + FILL_TIMEOUT
  let got = ''
  let overwriteAt = 0
  for (;;) {
    const cur = ta()
    got = cur ? cur.value : ''
    // 第一次读到「内容在、但不是我们写的」就是被它顶掉了
    if (!overwriteAt && got !== '' && got !== text) overwriteAt = Date.now()
    if (got === text && (!overwriteAt || Date.now() - overwriteAt > 600)) break
    if (Date.now() >= deadline || !isAlive()) break
    writeLyrics(win, text)
    kick()
    await sleep(200)
  }

  return { ok: got === text, got: got.length, want: text.length }
}

/* ══════════════════════════════════════════════════ 导出时的保存路径 ══ */

/*
 * 为什么要拦：JIZURA 导出 MP4 走的是**浏览器下载**（`URL.createObjectURL(blob)` +
 * 造一个 `<a download>` 点一下）。在 Tauri 的 WebView2 里，那只能落到系统默认下载目录，
 * 用户没法选。它自己的界面一个字都不能改，所以只能在外面做：它的所有保存都过
 * `J.saveFile(name, blob)` 这一个口子，在父页面把这个函数换掉就够了。
 *
 * 注意 `mp4file`（「大型视频用（直接保存为文件）」）走的是它自己的 `showSaveFilePicker`
 * + FileSystemWritableFileStream，**不经过这里** —— 那条路本来就是系统保存对话框，
 * 等于已经能选路径。它在这个 iframe 里点不出来（File System Access API 要求顶层文档），
 * 属于它的既有行为，与这次搬家无关。
 */

/** `POST /api/pv/save` 回的形状（`simple.rs::pv_save`） */
interface PvSaveRes {
  ok?: boolean
  error?: string
  path?: string
  name?: string
  size?: number
  part?: number
}

/**
 * 跨 realm 的 Blob 判断。
 *
 * ⚠️ `data instanceof Blob` 对**它那个 realm 造出来的 Blob** 恒为 false（两边的 Blob
 * 构造器不是同一个对象），而误判的代价是 `new Blob([blob])` 把整份成片再拷一遍 ——
 * 4K 的 MP4 几百 MB，白拷一份。所以按内部标记判，不按构造器判。
 */
const isBlob = (v: unknown): v is Blob =>
  typeof v === 'object' && v !== null && Object.prototype.toString.call(v) === '[object Blob]'

/**
 * 把一块字节写进用户选的目录（分块 POST）。
 *
 * ⚠️ 这里**故意直接用 `fetch`**，没走 `lib/api.ts`：那条路（`request()`）只会
 * `JSON.stringify(body)`，而这条路由要的是**裸字节**（body 就是这一块本身），
 * 表达不了。分块的意义也在这里：峰值内存只有一块（8MB），与成片大小无关。
 */
async function saveChunks(
  dir: string,
  name: string,
  blob: Blob,
  onProgress: (pct: number) => void,
): Promise<PvSaveRes | null> {
  const total = Math.ceil(blob.size / CHUNK) || 1
  let last: PvSaveRes | null = null
  for (let part = 0; part < total; part++) {
    const slice = blob.slice(part * CHUNK, Math.min((part + 1) * CHUNK, blob.size))
    const qs = new URLSearchParams({ dir, name, part: String(part) })
    const res = await fetch(`/api/pv/save?${qs}`, { method: 'POST', body: slice })
    const data = (await res.json().catch(() => ({}))) as PvSaveRes
    if (!res.ok || data.ok === false) throw new Error(data.error || `写入失败（HTTP ${res.status}）`)
    last = data
    if (total > 1) onProgress(Math.round(((part + 1) / total) * 100))
  }
  return last
}

/** 一次「它要保存、我们在等用户选目录」的请求 */
interface PendingSave {
  name: string
  blob: Blob
  resolve: (savedName: string) => void
}

/* ══════════════════════════════════════════════════════════════ 页面 ══ */

export function Pv({ state, onNavigate, onToast }: PageProps) {
  const [status, setStatus] = useState('正在载入编辑器…')
  const [importing, setImporting] = useState(false)
  const [pickingLrc, setPickingLrc] = useState(false)
  /** 非 null = 保存对话框开着（只用来渲染标题；真正的请求在 `pending` 里） */
  const [ask, setAsk] = useState<{ name: string; size: number } | null>(null)

  const frameRef = useRef<HTMLIFrameElement>(null)
  /**
   * 保存请求的 resolver 与 blob 放 ref 里：`onPick` 与 `onOpenChange` 是两个回调，
   * 而 DirPicker 选完会先 `onPick` 再 `onOpenChange(false)` —— 靠 state 分不清这两件事。
   */
  const pending = useRef<PendingSave | null>(null)
  /** 切页（卸载）后停掉轮询，别对着一个已经拆掉的 iframe 写十几秒 */
  const alive = useRef(true)

  const downloadDir = state?.paths?.downloadDir ?? ''

  /* ── 保存路径的接管 ─────────────────────────────────────── */

  const askDirectory = useCallback(
    (name: string, blob: Blob) =>
      new Promise<string>((resolve) => {
        pending.current = { name, blob, resolve }
        setAsk({ name, size: blob.size })
      }),
    [],
  )

  const saveInto = useCallback(
    async (dir: string, p: PendingSave) => {
      setStatus(`正在保存「${p.name}」…`)
      try {
        const saved = await saveChunks(dir, p.name, p.blob, (pct) =>
          setStatus(`正在保存「${p.name}」… ${pct}%`),
        )
        setStatus(saved?.path ? `已保存到 ${saved.path}` : '已保存')
        onToast('已保存到所选目录', 'ok')
        p.resolve(saved?.name ?? p.name)
      } catch (e) {
        setStatus(`保存失败：${errText(e)}`)
        onToast(`保存失败：${errText(e)}`, 'err')
        p.resolve('')
      }
    },
    [onToast],
  )

  /** 用户把对话框关了：别让它的导出流程一直等在那里 */
  const cancelSave = useCallback(() => {
    const p = pending.current
    if (!p) return
    pending.current = null
    setAsk(null)
    setStatus(`已取消保存「${p.name}」`)
    p.resolve('')
  }, [])

  const takeDirectory = useCallback(
    (dir: string) => {
      const p = pending.current
      if (!p) return
      // 先摘掉：DirPicker 点完「就选这里」会紧接着调 onOpenChange(false)，那不该被当成取消
      pending.current = null
      setAsk(null)
      void saveInto(dir, p)
    },
    [saveInto],
  )

  /** 把它的保存接管过来。返回 false = 没找到它的保存函数（那就还是原来的浏览器下载） */
  const hookSave = useCallback(
    (win: JizuraWindow): boolean => {
      if (typeof win.J?.saveFile !== 'function') return false
      win.J.saveFile = async (name: string, data: unknown) => {
        const blob = isBlob(data) ? data : new Blob([data as BlobPart])
        setStatus(`准备保存「${name}」（${formatBytes(blob.size)}）…`)
        await askDirectory(String(name ?? '未命名'), blob)
        // 无论选没选都返回 'saved'：返回别的东西会让它再走一遍浏览器下载，
        // 等于偷偷又存一份到系统下载目录
        return 'saved'
      }
      return true
    },
    [askDirectory],
  )

  /* ── 挂载：载入 → 等它 boot → 接管保存 → 填歌词 ─────────── */

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    alive.current = true
    const isAlive = () => alive.current
    const fail = (msg: string) => {
      setStatus(msg)
      onToast(msg, 'err')
    }

    void (async () => {
      const doc = await waitForEditor(frame, isAlive)
      if (!isAlive()) return
      if (!doc) {
        fail('编辑器没能加载：/vendor/jizura/ 下的文件缺失或损坏。重新解压一份完整程序即可恢复。')
        return
      }

      const win = frame.contentWindow as JizuraWindow | null
      if (!win?.document?.getElementById) {
        fail('编辑器载入失败：拿不到它的文档。多半是 vendor/jizura 被删了或改坏了，重新解压一份完整程序即可恢复。')
        return
      }

      /**
       * 等它 boot 完。boot 挂在 DOMContentLoaded 上、`load` 在它之后，所以通常已经就绪；
       * 但它是 2.4MB 的构建产物 + 2335 个字体子集，这里给到 30 秒。
       * **连 `J.saveFile` 一起等**：接管保存必须在它自己定义出这个函数之后，
       * 早了会被它后来的定义盖掉，用户就又只能存到系统下载目录了。
       */
      const booted = () => !!win.J?.uiApi && typeof win.J.saveFile === 'function'
      for (let i = 0; i < 150 && !booted(); i++) await sleep(200)
      if (!isAlive()) return

      // 接管它的保存（导出 MP4 / PNG 序列 / 附带的 WAV 都走 J.saveFile）—— 用户就能选目录了
      if (!hookSave(win)) {
        onToast('没能接管导出的保存路径（JIZURA 的 saveFile 一直没出现），导出会落到系统下载目录', 'err')
      }

      // 歌词从歌词页留在 localStorage 的那份来
      const text = lsGet(LS_LYRICS)
      if (!text.trim()) {
        setStatus('编辑器已就绪。想带歌词进来的话，去「歌词」页点「用这段歌词做文字 PV」。')
        return
      }
      // 同一份歌词只自动填一次：用户手动清空后再切回来，不该又被塞回去
      if (lsGet(LS_SENT) === text) {
        setStatus('编辑器已就绪（歌词已经带过来了，没有重复填写）。')
        return
      }

      const res = await fill(win, text, isAlive)
      if (!isAlive()) return
      lsSet(LS_SENT, text)
      if (res.ok) {
        setStatus(`已把歌词填进编辑器（${text.split('\n').length} 行）。`)
      } else {
        fail(`歌词填写可能没成功（填进去 ${res.got} / 应为 ${res.want} 字）：${res.why ?? '读回的值不一致'}`)
      }
    })()

    return () => {
      alive.current = false
    }
    /* 只在挂载时跑一次：这一页的全部内容就是这个 iframe，重建 = 重走一遍交接。
       `onToast` / `hookSave` 都是稳定引用（App 的 useCallback([]) 与本人的 useCallback）。 */
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ── 人在这一页时导入本地 .lrc ───────────────────────────── */

  /**
   * 读文件 → 填进 JIZURA。
   *
   * 复用后端 `/api/lyrics/import`（它已经处理好 GBK 探测与译文拆分），拿回来的
   * `lyric` / `trans` 走的是**和「歌词页带过来」完全相同的 `fill()`**。
   *
   * ⚠️ **接口字段名是 `lyric` / `trans`，不是 `lrc` / `tlyric`**。旧前端早先读的是
   * `res.lrc`，恒为 undefined，结果把字符串 "undefined" 填进了它的歌词框、状态栏永远停在
   * 「正在读取歌词文件…」，用户看到的就是「导入失败」。
   */
  const importLrc = async (path: string) => {
    const win = frameRef.current?.contentWindow as JizuraWindow | null
    if (!win?.document) {
      onToast('编辑器还没载入完，等它出来再导入', 'err')
      return
    }
    setImporting(true)
    setStatus('正在读取歌词文件…')
    try {
      const res = (await api.lyricsImport({ path })) as unknown as ImportedLrc
      const lyric = String(res.lyric ?? '').trim()
      if (!lyric) throw new Error('这个文件里没有读到歌词')

      // 有译文就原文 + 译文一起给它（和歌词页的「双语」一致），它自己按时间轴对上
      const trans = String(res.trans ?? '').trim()
      const parts = [lyric]
      if (trans) parts.push(trans, BILINGUAL_NOTE)
      const text = parts.join('\n')

      const r = await fill(win, text, () => alive.current)
      // 记成和歌词页同一种「带过来」的形态，切走再回来不会被重复填一遍
      lsSet(LS_LYRICS, text)
      lsSet(LS_SENT, text)
      if (r.ok) {
        const note = res.encoding === 'gbk' ? '（按 GBK 读取）' : ''
        setStatus(`已导入「${res.song?.name ?? '歌词'}」${note}，共 ${text.split('\n').length} 行。`)
        onToast('歌词已导入编辑器', 'ok')
      } else {
        // 旧前端这里只改状态条；新前端的规矩是任何失败都要能被看到（状态条也可能被忽略）
        onToast(`导入后填写可能没成功（${r.got} / 应为 ${r.want} 字）：${r.why ?? '读回值不一致'}`, 'err')
        setStatus(`导入后填写可能没成功（${r.got} / 应为 ${r.want} 字）：${r.why ?? '读回值不一致'}`)
      }
    } catch (e) {
      setStatus(`导入失败：${errText(e)}`)
      onToast(`导入失败：${errText(e)}`, 'err')
    } finally {
      setImporting(false)
    }
  }

  return (
    <div className="pv-page">
      {/* 工具条只有一行：状态 + 两个按钮。**不做额外工具条占高度** ——
          这是个多栏编辑器，空间都留给它。 */}
      <Panel padded={false}>
        <div className="pv-bar">
          <p className="pv-status">{status}</p>
          <Button size="sm" variant="ghost" icon="music" onClick={() => onNavigate('lyrics')}>
            去「歌词」页取词
          </Button>
          <Button size="sm" icon="file" loading={importing} onClick={() => setPickingLrc(true)}>
            导入歌词文件
          </Button>
        </div>
      </Panel>

      <div className="pv-frame-wrap">
        {/* ⚠️ **不能加 `sandbox`**：加了就没有同源权限，父页面拿它的
            `contentDocument` / `contentWindow` 会变成 null，整个交接（填歌词、接管保存）全废。
            音频试听要 autoplay，导出时要碰剪贴板，所以 `allow` 给这两样 + 全屏。 */}
        <iframe
          ref={frameRef}
          className="pv-frame"
          src={SRC}
          title="JIZURA 文字 PV 编辑器"
          allow="autoplay; clipboard-write; fullscreen"
        />
      </div>

      {/* 导出 MP4 / PNG 序列时由 `hookSave` 弹出来：JIZURA 自己只会走浏览器下载 */}
      <DirPicker
        open={ask !== null}
        onOpenChange={(open) => {
          if (!open) cancelSave()
        }}
        onPick={takeDirectory}
        title={ask ? `保存「${ask.name}」（${formatBytes(ask.size)}）到哪个目录` : '选择目录'}
      />

      <LrcPicker
        open={pickingLrc}
        onOpenChange={setPickingLrc}
        initial={downloadDir}
        onPick={(path) => {
          setPickingLrc(false)
          void importLrc(path)
        }}
      />
    </div>
  )
}

/* ══════════════════════════════════════════════════════ 选 .lrc 文件 ══ */

/**
 * 选一个 .lrc 文件 —— 旧页面的 `pickDirectory({ mode: 'file', exts: ['lrc'] })`。
 *
 * `components/DirPicker.tsx` 只选目录（后端 `files=0`），所以这里用同一套库组件
 * （`GlassDialog` + `PathBar` + `List`）把「列文件」打开。样式复用 `index.css` 里
 * 那组 `.dir-*`（目录选择器已经在用的类），不再另写一套 —— 和 `Convert.tsx` 的
 * 文件选择器是同一个路子。
 *
 * 起点给下载目录（和歌词页那条路一致 —— 用户手上那批 .lrc 基本就在那儿），
 * 但**它只是起点，不是限制**：用户可以自己往上往下走。
 */
function LrcPicker({
  open,
  onOpenChange,
  onPick,
  initial,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (path: string) => void
  initial: string
}) {
  const [cwd, setCwd] = useState('')
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (path: string) => {
    setBusy(true)
    setErr(null)
    try {
      let target = path
      for (let attempt = 0; ; attempt++) {
        try {
          const data = await api.fsList(target, { files: true, exts: ['lrc'] })
          setCwd(data.path)
          setEntries(data.entries)
          return
        } catch (e) {
          // 起点目录不可用（盘符不在 / 被删了）就退回后端给的默认目录，别再退第二次
          if (!target || attempt > 0) {
            setErr(errText(e))
            return
          }
          target = ''
        }
      }
    } finally {
      setBusy(false)
    }
  }, [])

  useEffect(() => {
    if (!open) return
    void load(initial)
  }, [open, initial, load])

  const segments = cwd
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .filter(Boolean)
  const dirs = entries.filter((e) => e.dir)
  const files = entries.filter((e) => !e.dir)

  return (
    <GlassDialog
      open={open}
      onOpenChange={onOpenChange}
      title="选择歌词文件（.lrc）"
      description="点进子目录，然后点一个 .lrc 文件；读进来之后会直接填进右边的编辑器"
      className="dir-dialog"
    >
      <div className="dir-body">
        <PathBar
          aria-label="所在路径"
          items={[
            { key: 'root', label: '此电脑', onSelect: () => void load('') },
            ...segments.map((seg, i) => ({
              key: seg + i,
              label: seg,
              /* 最后一级不给 onSelect —— 当前项不是链接（和 DirPicker 同一条规矩） */
              onSelect:
                i === segments.length - 1
                  ? undefined
                  : () => void load(segments.slice(0, i + 1).join('\\')),
            })),
          ]}
        />

        <List>
          <ListSection header={busy ? '读取中…' : `${dirs.length} 个子目录`}>
            {dirs.map((e) => (
              <ListRow key={e.path} label={e.name} disclosure onSelect={() => void load(e.path)} />
            ))}
            {!busy && dirs.length === 0 && <ListRow label="（没有子目录）" disabled />}
          </ListSection>
          <ListSection header={`${files.length} 个歌词文件`}>
            {files.map((e) => (
              <ListRow
                key={e.path}
                label={e.name}
                secondaryLabel={e.size ? formatBytes(e.size) : undefined}
                onSelect={() => onPick(e.path)}
              />
            ))}
            {!busy && files.length === 0 && <ListRow label="（这个目录里没有 .lrc 文件）" disabled />}
          </ListSection>
        </List>

        {err && <p className="finding-text">{err}</p>}
        <p className="dir-note">当前：{cwd || '（未选择）'}</p>
      </div>

      <div className="dir-actions">
        <span className="spacer" />
        <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
          取消
        </Button>
      </div>
    </GlassDialog>
  )
}
