import {useCallback, useEffect, useRef, useState} from 'react'
import {api} from '@/lib/api'
import {getConfig, saveConfig} from '@/lib/config'
import {Button} from '@/components/Button'
import {DropHint, useFilePick} from '@/components/FilePick'
import {Panel} from '@/components/Panel'
import {errText, formatBytes} from '@/lib/format'
import type {PageProps} from './types'
import './Pv.css'
import {useI18n} from '@/lib/i18n'

/**
 * 文字 PV：把歌词做成动态歌词视频（JIZURA）。
 *
 * 整页就是一个 iframe，指向 `/vendor/jizura/index.html`：JIZURA
 * （<https://github.com/852wa/JIZURA>，MIT）的页面与字体，位于 `public/vendor/jizura/`
 * （不入库，由 `tools/fetch_jizura_fonts.mjs` 补齐）。与主界面同源，所以父页面可以
 * 直接操作它的 DOM。**它的界面一个字都不改**，升级就重新跑那个脚本。
 *
 * 四条约束：
 *
 *   1. **歌词走配置交接**（`config.json` 的 `pvPendingLyrics`）：歌词页写、这里读，
 *      填完把同一份写进 `pvSentLyrics` 以免重复填。**不能用浏览器存储** —— 它按 origin
 *      隔离，两页之间的交接会**静默**断掉（读到一个空串）。
 *   2. **改它的歌词框必须同时派发冒泡的 `input` 事件**：它的 `bind()` 挂了 `input`
 *      监听，光改 `value` 它内部状态不变、预览不重排、自动保存也不触发。见 `writeLyrics()`。
 *   3. **填歌词按「读回值」收敛，不要写死时间表**：它的 `boot()` 末尾会用 `syncUI()`
 *      覆盖回输入框，所以第一次写入会被顶掉、得补写；页面被节流时定时器会被拉长
 *      （250ms 能变成 6.9 秒），一串固定 `setTimeout` 能把整轮拖到二十多秒。
 *      「内容在、但不是我们写的」= 它的 boot 跑完了，补一次再等 600ms 收工。见 `fill()`。
 *   4. **导出 MP4 的保存路径由父页面接管**：它的所有保存都过 `J.saveFile(name, blob)`
 *      （MP4、PNG 序列 ZIP、附带的 WAV），换成「弹目录选择 → 分块 `pv_save_chunk`」就够了；
 *      别去 hook `URL.createObjectURL` 或 `<a>` 的 click —— 那些路径会误伤别的东西。
 *      返回 `'saved'` 是为了不让它再走一遍浏览器下载（否则会偷偷又存一份到系统下载目录）。
 */

/* ══════════════════════════════════════════════════════════════ 常量 ══ */

/** 歌词页把歌词写进这里，这一页读（`pages/Lyrics.tsx` 的 `saveConfig`） */
const CFG_LYRICS = 'pvPendingLyrics'
/** 这份歌词已经填过一次了，别重复填 */
const CFG_SENT = 'pvSentLyrics'
/** 歌词页「用这段歌词做文字 PV」会在这条后面补一句双语说明，导入本地文件时保持一致 */
const BILINGUAL_NOTE =
    '# 上面第一段是原文、第二段是译文。请把译文放到「注釈」的位置：原文|译文（同一行用竖线分开），别当成两句歌词。'

const SRC = '/vendor/jizura/index.html'

/** 一次传多大。后端 `pv_save_chunk` 的单块上限是 16MB，留一倍余量。 */
const CHUNK = 8 * 1024 * 1024

/** 填歌词最多等多久（按读回值收敛，不是时间表 —— 见 `fill()`） */
const FILL_TIMEOUT = 15000

const sleep = (ms: number) => new Promise<void>((r) => window.setTimeout(r, ms))

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

/* ══════════════════════════════════════════════════════ iframe 里的事 ══ */

/**
 * 等 iframe 里的编辑器真的出现，返回它的 document（超时返回 null）。
 *
 * ⚠️ **别拿 `readyState === 'complete'` 判「iframe 加载完了」**：
 * React 挂载这一刻 iframe 里还是初始的 `about:blank`，而**它本来就是 complete**，
 * 于是「先查 readyState，是 complete 就开工」会立刻返回，接着我们在 vendor 那份 HTML
 * 还没到的时候去找歌词框，白白误报「/vendor/jizura/ 文件缺失」。
 *
 * 这里盯住**它 HTML 里静态就有的歌词框**（`#lyrics`）：它出现 = 那份构建产物加载出来了，
 * 顺便把「文件到底在不在」也验了。另外：如果那个文档已经加载完（`complete`）
 * 却连歌词框都没有，那就是真的坏了（404 的错误页 / 被改坏的 HTML），不必等到超时。
 */
async function waitForEditor(
    frame: HTMLIFrameElement,
    isAlive: () => boolean,
    timeoutMs = 30000,
): Promise<Document | null> {
    const deadline = Date.now() + timeoutMs
    for (; ;) {
        const doc = frame.contentDocument
        /**
         * ⚠️ **`#lyrics` 出现 ≠ JIZURA 的 `boot()` 跑完。**
         *
         * vendor 末尾是 `if (readyState === 'loading') addEventListener('DOMContentLoaded', boot)
         * else boot(); J.ui = S; J.uiApi = {…}` —— 解析期就赋好 `uiApi`，而 `boot()` 挂在
         * DOMContentLoaded 上，能晚到 8~13 秒才跑。它 `boot()` 末尾的 `syncUI()` 会把
         * `S.project.lyrics` 覆盖回输入框，于是出现「填进去 → 读回一致 → 几秒后被默认工程顶掉」。
         *
         * 所以这里**额外要求整个文档 `readyState === 'complete'`**：`load` 必然在
         * DOMContentLoaded 之后 ⇒ boot 一定已经跑完。
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
    ta.dispatchEvent(new win.Event('input', {bubbles: true}))
    return true
}

/**
 * 填歌词：**按读回值收敛**。每 200ms 重写一遍，直到读回值一致就收工，最多 `FILL_TIMEOUT`。
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
        return {ok: false, why: '没找到歌词输入框', got: 0, want: text.length}
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
    for (; ;) {
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

    return {ok: got === text, got: got.length, want: text.length}
}

/* ══════════════════════════════════════════════════ 导出时的保存路径 ══ */

/*
 * 为什么要在外面拦：JIZURA 导出 MP4 走的是**浏览器下载**（`URL.createObjectURL(blob)` +
 * 造一个 `<a download>` 点一下）。在 Tauri 的 WebView2 里，那只能落到系统默认下载目录，
 * 用户没法选。它自己的界面一个字都不能改，所以只能在外面做：它的所有保存都过
 * `J.saveFile(name, blob)` 这一个口子，在父页面把这个函数换掉就够了。
 *
 * 注意 `mp4file`（「大型视频用（直接保存为文件）」）走的是它自己的 `showSaveFilePicker`
 * + FileSystemWritableFileStream，**不经过这里** —— 那条路本来就是系统保存对话框，
 * 等于已经能选路径。它在这个 iframe 里点不出来（File System Access API 要求顶层文档），
 * 属于它的既有行为。
 */

/** `pv_save_chunk` 回的形状（`ipc/pv.rs`） */
interface PvSaveRes {
    path?: string
    name?: string
    size?: number
    part?: number
    done?: boolean
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
 * 把一块字节写进用户选的目录（分块走 `pv_save_chunk`）。
 *
 * 分块的意义：峰值内存只有一块（8MB），与成片大小无关。
 * ⚠️ **别为了「IPC 方便」改成一次传完** —— 那等于把几百 MB 同时按在 WebView 和 Rust 两边。
 */
async function saveChunks(
    dir: string,
    name: string,
    blob: Blob,
    onProgress: (pct: number) => void,
): Promise<PvSaveRes | null> {
    const total = Math.ceil(blob.size / CHUNK) || 1
    let last: PvSaveRes | null = null
    /* 落点跟着后端的回答走。目标名已存在时 0 号块会把它改成 `xxx (1).mp4`，
    而 part>0 是按调用方传来的名字去找文件的 —— 一路传原名，后面的块会追加进
    用户早就存在的那个同名文件里，而新导出的那份只剩 0 号块。 */
    let target = name
    for (let part = 0; part < total; part++) {
        const slice = blob.slice(part * CHUNK, Math.min((part + 1) * CHUNK, blob.size))
        const bytes = new Uint8Array(await slice.arrayBuffer())
        last = await api.pvSaveChunk(dir, target, part, total, bytes)
        target = last.name ?? target
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

export function Pv({state, onNavigate, onToast}: PageProps) {
    const {t} = useI18n()
    const [status, setStatus] = useState('正在载入编辑器…')
    const [importing, setImporting] = useState(false)
    const frameRef = useRef<HTMLIFrameElement>(null)
    /**
     * 保存请求的 resolver 与 blob 放 ref 里：系统「选择文件夹」对话框没有回调可挂，
     * 只能等它返回之后拿着那个地址接着存 —— 那一头要能找到最初的 resolver。
     */
    const pending = useRef<PendingSave | null>(null)
    /** 切页（卸载）后停掉轮询，别对着一个已经拆掉的 iframe 写十几秒 */
    const alive = useRef(true)

    const downloadDir = state?.paths?.downloadDir ?? ''

    /* 选歌词文件：系统对话框 + 把 .lrc 直接拖进这个窗口，两条入口都回本机路径
       （见 `components/FilePick.tsx`；拖进来的那份由后端落成临时文件换回路径）。
       起点给下载目录 —— 用户手上那批 .lrc 基本就在那儿，但它只是起点，不是限制。 */
    const {pick, dropProps, dragging, busy: dropping} = useFilePick({
        exts: ['lrc'],
        label: '歌词文件',
        title: '选一个歌词文件',
        dir: downloadDir || undefined,
        onPaths: (paths) => void importLrc(paths[0]),
        onToast,
    })

    /* ── 保存路径的接管 ─────────────────────────────────────── */

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

    /** 用户取消（或对话框打不开）：别让它的导出流程一直等在那里 */
    const cancelSave = useCallback(() => {
        const p = pending.current
        if (!p) return
        pending.current = null
        setStatus(`已取消保存「${p.name}」`)
        p.resolve('')
    }, [])

    /**
     * 弹**系统**「选择文件夹」对话框，把 JIZURA 的保存接管过来。
     *
     * 系统对话框能新建文件夹、能跳盘符、能用用户自己收藏的快捷方式 —— 这些都不用我们再写一遍。
     * 取消 = 空数组，当作用户放弃这次导出（`resolve('')`），不是错误。
     */
    const askDirectory = useCallback(
        (name: string, blob: Blob) =>
            new Promise<string>((resolve) => {
                const p: PendingSave = {name, blob, resolve}
                pending.current = p
                setStatus(`正在等「${name}」选保存目录…`)
                void api
                    .fsPick({
                        folder: true,
                        title: `保存「${name}」（${formatBytes(blob.size)}）到哪个目录`,
                        dir: downloadDir || undefined,
                    })
                    .then((r) => {
                        const dir = r.files[0]
                        if (!dir) return cancelSave()
                        pending.current = null
                        void saveInto(dir, p)
                    })
                    .catch((e) => {
                        pending.current = null
                        const msg = `打不开系统对话框：${errText(e)}`
                        setStatus(msg)
                        onToast(msg, 'err')
                        p.resolve('')
                    })
            }),
        [cancelSave, downloadDir, onToast, saveInto],
    )

    /** 把它的保存接管过来。返回 false = 没找到它的保存函数（那就还是浏览器下载） */
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
                fail('编辑器没能加载：程序文件缺失或损坏。')
                return
            }

            const win = frame.contentWindow as JizuraWindow | null
            if (!win?.document?.getElementById) {
                fail('编辑器载入失败：程序文件缺失或损坏。')
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
                onToast('这次没能让你选保存目录，导出会落到系统下载目录', 'err')
            }

            // 歌词从歌词页留在配置里的那份来（`config.json` 的 `pvPendingLyrics`）
            const text = String(getConfig()[CFG_LYRICS] ?? '')
            if (!text.trim()) {
                setStatus('编辑器已就绪。想带歌词进来的话，去「歌词」页点「用这段歌词做文字 PV」。')
                return
            }
            // 同一份歌词只自动填一次：用户手动清空后再切回来，不该又被塞回去
            if (String(getConfig()[CFG_SENT] ?? '') === text) {
                setStatus('编辑器已就绪（歌词已带入）。')
                return
            }

            const res = await fill(win, text, isAlive)
            if (!isAlive()) return
            saveConfig({[CFG_SENT]: text})
            if (res.ok) {
                setStatus(`已把歌词填进编辑器（${text.split('\n').length} 行）。`)
            } else {
                fail('歌词没能自动填进编辑器，请手动粘贴')
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
     * 复用后端 `lyrics_import`（它已经处理好 GBK 探测与译文拆分），拿回来的
     * `lyric` / `trans` 走的是**和「歌词页带过来」完全相同的 `fill()`**。
     *
     * ⚠️ **接口字段名是 `lyric` / `trans`，不是 `lrc` / `tlyric`**。写成后者会恒为
     * undefined，把字符串 "undefined" 填进它的歌词框、状态栏永远停在「正在读取歌词文件…」。
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
            const res = await api.lyricsImport({path})
            const lyric = String(res.lyric ?? '').trim()
            if (!lyric) throw new Error('这个文件里没有读到歌词')

            // 有译文就原文 + 译文一起给它（和歌词页的「双语」一致），它自己按时间轴对上
            const trans = String(res.trans ?? '').trim()
            const parts = [lyric]
            if (trans) parts.push(trans, BILINGUAL_NOTE)
            const text = parts.join('\n')

            const r = await fill(win, text, () => alive.current)
            // 记成和歌词页同一种「带过来」的形态，切走再回来不会被重复填一遍
            saveConfig({[CFG_LYRICS]: text, [CFG_SENT]: text})
            if (r.ok) {
                const note = res.encoding === 'gbk' ? '（按 GBK 读取）' : ''
                setStatus(`已导入「${res.song?.name ?? '歌词'}」${note}，共 ${text.split('\n').length} 行。`)
                onToast('歌词已导入编辑器', 'ok')
            } else {
                // 失败要能被看到：状态条可能被忽略，所以还要 toast
                onToast('歌词没能自动填进编辑器，请手动粘贴', 'err')
                setStatus('歌词没能自动填进编辑器，请手动粘贴')
            }
        } catch (e) {
            setStatus(`导入失败：${errText(e)}`)
            onToast(`导入失败：${errText(e)}`, 'err')
        } finally {
            setImporting(false)
        }
    }

    return (
        <div className="pv-page" {...dropProps}>
            {/* 工具条只有一行：状态 + 两个按钮。**不做额外工具条占高度** ——
          这是个多栏编辑器，空间都留给它。 */}
            <Panel padded={false}>
                <div className="pv-bar">
                    <p className="pv-status">{status}</p>
                    <DropHint
                        className="pv-drop"
                        dragging={dragging}
                        busy={dropping}
                        text=".lrc 也能拖进来"
                    />
                    <Button size="sm" variant="ghost" icon="music" onClick={() => onNavigate('lyrics')}>
                        去「歌词」页取词
                    </Button>
                    <Button size="sm" icon="file" loading={importing} onClick={() => void pick()}>
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
                    title={t("JIZURA 文字 PV 编辑器")}
                    allow="autoplay; clipboard-write; fullscreen"
                />
            </div>

            {/* 许可与出处**不在这里**：这一页的高度全给编辑器，那一块搬去
          「设置 → 关于」了（见 `Settings.tsx` 的 `About()`）。

          导出 MP4 / PNG 时的「存到哪里」走系统「选择文件夹」对话框
          （`askDirectory` 里直接调 `pick_paths`），页面上不再有自画的目录树。 */}
        </div>
    )
}
