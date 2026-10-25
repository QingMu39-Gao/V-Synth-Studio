import {useEffect, useMemo, useRef, useState} from 'react'
import {Checkbox, List, ListRow, ListSection, SegmentedControl, Select} from '@/components/ui'
import type {VideoInfo, VideoParse} from '@/lib/api'
import {api} from '@/lib/api'
import {
    codecOf,
    countItems,
    estimateSize,
    type Item,
    itemList,
    lockedQualities,
    mbps,
    pickDefaults,
    type Picked,
    renderSubDir,
    riskyCodec,
} from '@/lib/videoParse'
import {getConfig, saveConfig} from '@/lib/config'
import {fileUrl, joinPath} from '@/lib/ipc'
import {Button, IconButton} from '@/components/Button'
import {Credit, Upstream} from '@/components/Credit'
import {DirectoryInput} from '@/components/DirPicker'
import {Field, TextInput} from '@/components/Field'
import {Icon} from '@/components/Icon'
import {JobProgress, type JobStatus, jobStatusText, jobStatusTone} from '@/components/Job'
import {Chip, Finding, Panel, PanelHead, Stat} from '@/components/Panel'
import {VideoPreview} from '@/components/Preview'
import {ScanLogin} from '@/components/ScanLogin'
import {SwitchRow} from '@/components/SwitchRow'
import {baseName, errText, formatBytes, formatDuration, formatNumber} from '@/lib/format'
import {useJob} from '@/lib/useJob'
import type {PageProps} from './types'
import './Video.css'
import {useI18n} from '@/lib/i18n'

/**
 * 视频解析下载（MV 素材）。
 *
 * B 站走本程序的原生解析（WBI 签名 + DASH 取流），其它站点交给 yt-dlp；
 * 下载是长任务，交给后端任务队列，前端只订阅进度。
 *
 * ⚠️ **载荷字段名与设置键都不能改**（`source` / `outDir` / `mode` /
 * `downloadCover` / `downloadDanmaku` / `downloadSubs` / `quality` / `audioQuality` /
 * `formatId` / `convertTo`，设置键 `fandiao.video.settings`）：同一个 origin 下有
 * 别的地方也在读这份偏好，改键名等于把设置丢掉。
 *
 * ⚠️ **只有一个 `useJob()`**，由 `runQueue()` 顺序驱动：一项跑完（拿到终态）才 `start()`
 * 下一项。不并发 —— 排成一条顺序队列，不轰炸站点；`<JobProgress>` 天然只显示跑的那一项。
 *
 * 三处布局约束：
 *  1. **分P / 剧集行本身不可点**：把 checkbox 塞进可点行是嵌套交互元素（无效 HTML、
 *     读屏也会错乱）。`ListRow` 有 `onSelect` 时渲染的是真 `<button>`。
 *     勾选框负责批量选择，行尾一个图标按钮负责「切到这一项重新解析」。
 *  2. **编码徽章（H.264 / HEVC / AV1）是第二行的文字，不是 chip**：chip 自带边框与颜色，
 *     挤在行尾会和选中底色打架。
 *  3. **不做参数化深链**：hash 路由里没有对应物，`App.tsx` 也不传 params。
 *
 * 解析结果的类型来自 `lib/api.ts` —— 页内不要另声明一份 `VideoParse`，
 * 后端才是权威（夹具是它的快照）。要改形状就改 `api.ts`。
 */

/* ══════════════════════════════════════════════════════ 设置 ══ */

type Mode = 'video' | 'audio'

interface Settings {
    outDir: string
    mode: Mode
    downloadCover: boolean
    downloadDanmaku: boolean
    downloadSubs: boolean
    subDir: string
    convertTo: string
    lastUrl: string
}

/**
 * 设置持久化 —— 存在 **`config.json` 的 `video`** 里。
 * **键名固定，别改** —— `migrate_legacy_settings` 按这个名字搬老设置。
 */
const CFG_KEY = 'video'

const DEFAULT_SETTINGS: Settings = {
    outDir: '',
    mode: 'video',
    downloadCover: true,
    downloadDanmaku: false,
    downloadSubs: false,
    subDir: '',
    convertTo: '',
    lastUrl: '',
}

function loadSettings(): Settings {
    const saved = getConfig()[CFG_KEY]
    if (saved && typeof saved === 'object') {
        return {...DEFAULT_SETTINGS, ...(saved as Partial<Settings>)}
    }
    return {...DEFAULT_SETTINGS}
}

function saveSettings(s: Settings) {
    saveConfig({[CFG_KEY]: s as unknown as Record<string, unknown>})
}

/** 后端 config 里 Cookie 类的脱敏占位（`ipc/config_file.rs` 的 `MASKED`） */
const MASKED = '已设置'

const CONVERT_TO = [
    {value: '', label: '保持原样（不转码，最快）'},
    {value: 'mp3', label: 'MP3 320k'},
    {value: 'm4a', label: 'M4A / AAC'},
    {value: 'wav', label: 'WAV 无损'},
    {value: 'flac', label: 'FLAC 无损'},
]

/** 这一页的队列是下载队列，`running` 的说法和通用任务不同，其余沿用同一份表 */
const statusText = (s: JobStatus) => (s === 'running' ? '下载中' : jobStatusText(s))

/* ══════════════════════════════════════════════════════════════ 队列 ══ */

interface QueueItem {
    uid: number
    key: string
    label: string
    url: string
    mode: Mode
    payload: Record<string, unknown>
    status: JobStatus
    message: string
    error?: string
    jobId?: string
    files: string[]
    dir: string
}

/** 一项下载的终态结论 —— `waitOutcome()` 的返回值 */
interface Outcome {
    files: string[]
    dir: string
    message: string
    error?: string
    canceled?: boolean
}

/**
 * 队列与 uid 的**模块级副本**：`App` 只渲染当前页，切走就把本组件卸载了，而后端
 * 的下载还在跑。放组件 state 里的话队列整个消失 —— 跑着的任务既看不到进度也点不了
 * 重试，再切回来队列是空的，但那几个任务还在后端跑。
 *
 * `bump()` 是唯一的发布口，顺手把最新一份写回这里；切回来时 `runQueue()` 按 `jobId`
 * 重新接上订阅（收订阅的是 `useJob` 的卸载清理，旧那条 promise 从此回不来）。
 */
let STORED_QUEUE: QueueItem[] = []
let STORED_UID = 0

/* ══════════════════════════════════════════════════════════════ 页面 ══ */

export function Video({state, onNavigate, onRefreshState, onToast}: PageProps) {
    const {t} = useI18n()
    const [settings, setSettings] = useState<Settings>(loadSettings)
    const [url, setUrl] = useState(() => loadSettings().lastUrl)

    const [parsing, setParsing] = useState(false)
    const [parsed, setParsed] = useState<VideoParse | null>(null)
    const [parseErr, setParseErr] = useState<string | null>(null)
    const [coverErr, setCoverErr] = useState(false)
    const [loginOpen, setLoginOpen] = useState(false)

    const [tab, setTab] = useState<'pages' | 'season'>('pages')
    const [selection, setSelection] = useState<Set<string>>(() => new Set())
    const [picked, setPicked] = useState<Picked>({quality: null, audio: null, formatId: null})

    const [queue, setQueue] = useState<QueueItem[]>(STORED_QUEUE)
    const [detail, setDetail] = useState('')
    const etaRef = useRef<{ t: number; p: number } | null>(null)

    /**
     * 预览：远端直链 → 本机缓存文件 → `fileUrl()`。
     *
     * `cache` 是「远端 url → 本机路径」的记忆：换画质来回点时不用重下，
     * 而且**同一支看第二次是瞬时的**（后端那边命中缓存也直接返回）。
     */
    const [preview, setPreview] = useState<{
        videoUrl: string
        audioUrl?: string
        poster?: string
        note?: string
    } | null>(null)
    const [previewBusy, setPreviewBusy] = useState(false)
    const [previewErr, setPreviewErr] = useState('')
    const previewCache = useRef(new Map<string, string>())

    const {job, start} = useJob()

    const cfgDownDir = state?.paths?.downloadDir || state?.paths?.outputDir || ''

    const setSetting = <K extends keyof Settings>(key: K, value: Settings[K]) => {
        setSettings((s) => {
            const next = {...s, [key]: value}
            saveSettings(next)
            return next
        })
    }

    /* 首屏那次 get_state 到了之后，把默认下载目录灌进设置（只灌一次，之后归用户） */
    const seeded = useRef(false)
    useEffect(() => {
        if (seeded.current || !state) return
        seeded.current = true
        if (!settings.outDir) setSetting('outDir', cfgDownDir)
        // 只认首次拿到的那份 state
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [state])

    /* 速度 / 剩余时间：后端给了就照用，没给就按进度差算（B 站那条路只有 speedText） */
    useEffect(() => {
        if (!job) {
            setDetail('')
            return
        }
        const prog = (job.progress ?? {}) as { speedText?: string; etaText?: string; eta?: string }
        const speed = String(prog.speedText ?? '').trim()
        const direct = String(prog.etaText ?? prog.eta ?? '').trim()
        const hasDirect = !!direct && !/^(na|unknown|none)$/i.test(direct)
        const p = Number(job.percent ?? 0)
        const now = Date.now()
        const prev = etaRef.current
        let computed = ''
        if (!hasDirect && prev && p > prev.p && now > prev.t) {
            const rate = (p - prev.p) / ((now - prev.t) / 1000)
            if (rate > 0) {
                const sec = (100 - p) / rate
                if (Number.isFinite(sec) && sec > 0 && sec < 86400) computed = `剩余约 ${formatDuration(sec)}`
            }
        }
        if (!prev || now - prev.t >= 1000) etaRef.current = {t: now, p}
        setDetail([speed ? `速度 ${speed}` : '', hasDirect ? `剩余 ${direct}` : computed].filter(Boolean).join(' · '))
    }, [job])

    /* ── 派生值 ─────────────────────────────────────────────── */

    const isBili = parsed?.source !== 'ytdlp'
    const isBangumi = parsed?.kind === 'bangumi'
    const info: Partial<VideoInfo> = parsed?.info ?? {}
    const streams = parsed?.streams ?? null
    /** 整段流（durl）只能整段下载：仅音频模式在它下面不可用 */
    const durl = !!isBili && streams?.mode === 'durl'
    const mode: Mode = durl ? 'video' : settings.mode
    const outDir = settings.outDir.trim() || cfgDownDir
    const customDir = !!settings.outDir.trim() && settings.outDir.trim() !== cfgDownDir

    const videos = streams?.video ?? []
    const audios = streams?.audio ?? []
    const locked = useMemo(() => lockedQualities(streams), [streams])
    const selectedVideo = videos.find((v) => v.id === picked.quality)

    /* ⚠️ 这两个必须 memo：下载进度每拍都重渲染这一页，而 `itemList` 会把整季/整部
       的分项重新映射一遍。 */
    const {pages, season} = useMemo(() => itemList(parsed), [parsed])
    const multiPages = pages.length > 1
    const hasSeason = season.length > 0
    const group: 'pages' | 'season' = multiPages && hasSeason ? tab : multiPages ? 'pages' : 'season'
    const list = group === 'season' ? season : pages
    const selectedHere = list.filter((it) => selection.has(it.key)).length

    const ytFormats = (info.formats ?? []).filter((f) => f.isVideo)
    /* ⚠️ 字段不符（已核实，留原样）：currentPage 就是后端 pages[] 里的一项，而 pages[] 的每个元素
       只有 cid / page / title / durationSec / width / height（bili.rs:394-419），冻结夹具
       里面没有 cover。
       所以这一截回退实际恒为 undefined —— 不崩，但永远不生效。没有删它、也没改运行逻辑，
       只加了个窄断言让它编译，怎么处理交给知道契约那边的人。 */
    const cover = info.cover || (parsed?.currentPage as { cover?: string } | undefined)?.cover || info.thumbnail

    /* ── 预览用的直链 ──────────────────────────────────────────
       B 站的 dash 流视频/音频是分开的（这正是 yt-dlp 要 merge 的原因），
       yt-dlp 那边也常只有「分开的轨」，所以预览得跟着当前选中的画质走：
       durl 只放第一段，dash 取选中视频轨 + 对应音频轨，yt-dlp 优先「有音有画」那条。

       ⚠️ **`<video src>` 不能直接吃远端直链。** 它要的是一个可寻址地址，
       而 IPC 是请求-应答、没有流也没有 Range —— 所以走
       `previewFetch(url)` 把流**落到本机缓存**，再 `fileUrl(路径)` 交给 `<video>`
       （Range 由 asset 协议内置）。代价是首播要等几秒（界面里必须说出来），
       好处是同一支看第二次瞬时，而且不再受 B 站 CDN 认 Referer 那件事的影响。

       这一段只算「**该拿哪几条远端直链**」，落盘与播放状态在下面的 `preview` 里。 */
    const previewSrc = ((): {
        video?: string;
        audio?: string;
        poster?: string;
        note?: string;
        src: 'bilibili' | 'ytdlp'
    } | null => {
        if (!parsed) return null
        if (!isBili) {
            const fs = (info.formats ?? []).filter((f) => !!f.url)
            const both = fs.find(
                (f) => !!f.vcodec && f.vcodec !== 'none' && !!f.acodec && f.acodec !== 'none',
            )
            const onlyV = fs.find((f) => !!f.vcodec && f.vcodec !== 'none')
            const onlyA = fs.find(
                (f) => !!f.acodec && f.acodec !== 'none' && (!f.vcodec || f.vcodec === 'none'),
            )
            const v = both ?? onlyV
            if (!v?.url) return null
            return {
                video: v.url,
                audio: both ? undefined : onlyA?.url,
                poster: info.thumbnail,
                src: 'ytdlp',
                note: both
                    ? `预览这条是「有音有画」的整段流（${both.resolution || both.formatId || '默认'}）。`
                    : '这个站点只给了分开的视频轨 / 音频轨，播放时画面与声音会自动对齐；直链有时会被站点限速，卡就先下载。',
            }
        }
        if (durl) {
            const seg = streams?.streams?.[0]
            if (!seg?.url) return null
            return {
                video: seg.url,
                poster: cover,
                src: 'bilibili',
                note: '整段流是分段的，预览只放第一段（下载仍是整段排队）。',
            }
        }
        const a = audios.find((x) => x.id === picked.audio) ?? audios[0]
        const src = selectedVideo?.url || selectedVideo?.backupUrls?.[0]
        if (!src) return null
        return {
            video: src,
            audio: a?.url,
            poster: cover,
            src: 'bilibili',
            note: selectedVideo
                ? `正在预览：${selectedVideo.qualityName}${a?.qualityName ? ` + ${a.qualityName}` : ''}。换个画质这里会跟着换。`
                : undefined,
        }
    })()

    const runningItem = queue.find((q) => q.status === 'running')
    const doneCount = queue.filter((q) => q.status === 'done').length

    const failedCount = queue.filter((q) => q.status === 'error').length
    const pending = queue.some((q) => q.status === 'queued' || q.status === 'running')

    /* 把上面选中那几条远端直链落到本机缓存，再交给 `<video>`。
       依赖项一个个列出来（不用 `previewSrc` 整个对象）—— 那是每帧新造的，会让这个
       effect 无限重跑。 */
    const pvSrc = previewSrc?.src ?? ''
    const pvVideo = previewSrc?.video ?? ''
    const pvAudio = previewSrc?.audio ?? ''
    const pvPoster = previewSrc?.poster ?? ''
    const pvNote = previewSrc?.note ?? ''
    useEffect(() => {
        if (!pvVideo) {
            setPreview(null)
            setPreviewErr('')
            setPreviewBusy(false)
            return
        }
        let alive = true
        setPreviewBusy(true)
        setPreviewErr('')
        const one = async (u: string, kind: 'bilibili' | 'ytdlp') => {
            const hit = previewCache.current.get(u)
            if (hit) return hit
            const r = await api.previewFetch(u, kind)
            previewCache.current.set(u, r.path)
            return r.path
        }
        void (async () => {
            try {
                const [v, a] = await Promise.all([
                    one(pvVideo, pvSrc as 'bilibili' | 'ytdlp'),
                    pvAudio ? one(pvAudio, pvSrc as 'bilibili' | 'ytdlp') : Promise.resolve(''),
                ])
                if (!alive) return
                setPreview({
                    videoUrl: fileUrl(v),
                    audioUrl: a ? fileUrl(a) : undefined,
                    poster: pvPoster || undefined,
                    note: pvNote || undefined,
                })
            } catch (e) {
                if (!alive) return
                setPreview(null)
                setPreviewErr(errText(e))
            } finally {
                if (alive) setPreviewBusy(false)
            }
        })()
        return () => {
            alive = false
        }
    }, [pvSrc, pvVideo, pvAudio, pvPoster, pvNote])

    /* ── 解析 ───────────────────────────────────────────────── */

    const doParse = async (input?: string) => {
        const target = String(input ?? url).trim()
        if (!target) {
            onToast('请输入视频链接或 BV 号', 'warn')
            return
        }
        setUrl(target)
        setSetting('lastUrl', target)
        setParsing(true)
        setParseErr(null)
        setCoverErr(false)
        try {
            /* Cookie 一般走 config（后端在 body 里没给 cookie 时读 config 里那份）。
               config 回显的是脱敏占位「已设置」，那个值不能当 cookie 发回去 —— 只有拿到真实值才带。 */
            const ck = String(state?.config?.bilibiliCookie ?? '')
            const data = await api.parseVideo({
                url: target,
                cookie: ck && ck !== MASKED ? ck : undefined,
            })
            setParsed(data)
            setSelection(new Set())
            setTab('pages')
            setPicked(pickDefaults(data))
            const n = countItems(data)
            onToast(n > 1 ? `解析成功：共 ${n} 个可选内容` : '解析成功', 'ok')
        } catch (e) {
            setParsed(null)
            const msg = errText(e)
            setParseErr(msg)
            onToast(`解析失败：${msg}`, 'err')
        } finally {
            setParsing(false)
        }
    }

    const pasteAndParse = async () => {
        try {
            const text = (await navigator.clipboard.readText()).trim()
            if (!text) {
                onToast('剪贴板里没有文本', 'warn')
                return
            }
            setUrl(text)
            await doParse(text)
        } catch {
            onToast('浏览器不允许读剪贴板，请手动粘贴（Ctrl+V）', 'warn')
        }
    }

    const switchItem = async (it: Item) => {
        if (!it.url) {
            onToast('这一项没有可用的链接', 'warn')
            return
        }
        setUrl(it.url)
        await doParse(it.url)
    }

    /* ── 下载载荷（字段名是约定好的接口形状，别改）───────────── */

    const buildPayload = (target: string): Record<string, unknown> => {
        const qualityName = selectedVideo?.qualityName ?? ''
        const sub = renderSubDir(parsed, qualityName, settings.subDir)
        const base = settings.outDir.trim() || cfgDownDir
        const payload: Record<string, unknown> = {
            url: target,
            source: isBili ? 'bilibili' : 'ytdlp',
            outDir: sub ? joinPath(base, sub) : base,
            mode,
            downloadCover: !!(isBili && settings.downloadCover),
            downloadDanmaku: !!(isBili && settings.downloadDanmaku),
            downloadSubs: !!settings.downloadSubs,
        }
        if (isBili) {
            if (streams?.mode === 'dash') {
                if (payload.mode === 'video' && picked.quality != null) payload.quality = picked.quality
                if (picked.audio != null) payload.audioQuality = picked.audio
            }
        } else {
            if (payload.mode === 'video' && picked.formatId) payload.formatId = picked.formatId
            if (payload.mode === 'audio' && settings.convertTo) payload.convertTo = settings.convertTo
        }
        return payload
    }

    const currentEntry = () => {
        const target = url.trim() || info.url || ''
        const page = parsed?.currentPage?.page
        const label = isBangumi
            ? `${info.title ?? '番剧'} ${parsed?.currentPage?.title ?? ''}`.trim()
            : page && (info.pages?.length ?? 0) > 1
                ? `${info.title ?? ''} P${page}`.trim()
                : info.title || target
        return {
            key: `${target}#${mode}#${picked.quality ?? ''}`,
            label,
            url: target,
        }
    }

    /* ── 队列（一个 useJob 顺序驱动）─────────────────────────── */

    const queueRef = useRef<QueueItem[]>(STORED_QUEUE)
    const runningRef = useRef(false)
    const uidRef = useRef(STORED_UID)

    const bump = () => {
        STORED_QUEUE = queueRef.current
        setQueue([...queueRef.current])
    }

    const nextUid = () => {
        uidRef.current += 1
        STORED_UID = uidRef.current
        return uidRef.current
    }

    const patch = (uid: number, p: Partial<QueueItem>) => {
        const it = queueRef.current.find((q) => q.uid === uid)
        if (!it) return
        Object.assign(it, p)
        bump()
    }

    /* 挂上这个 jobId 的订阅，等它到终态 —— 终态只有一次，所以只会 resolve 一次。
       ⚠️ 切走视图时 `useJob` 会收订阅，这条 promise 就永远悬着，调用它的那个
       `runItem` 再也回不来（见 `runQueue` 开头的续跑）。 */
    const waitOutcome = (jobId: string) =>
        new Promise<Outcome>((resolve) => {
            start(jobId, {
                onDone: (j) => {
                    const r = (j.result ?? {}) as { files?: string[]; dir?: string }
                    resolve({files: r.files ?? [], dir: r.dir ?? '', message: j.message ?? '下载完成'})
                },
                onError: (err) => resolve({files: [], dir: '', message: err.message, error: err.message}),
                onCancel: () => resolve({files: [], dir: '', message: '已取消', canceled: true}),
            })
        })

    const settle = (item: QueueItem, outcome: Outcome) => {
        if (outcome.canceled) {
            patch(item.uid, {status: 'canceled', message: '已取消'})
            onToast(`「${item.label}」已取消`, 'warn')
        } else if (outcome.error) {
            patch(item.uid, {status: 'error', error: outcome.error, message: outcome.message})
            onToast(`「${item.label}」下载失败：${outcome.error}`, 'err')
        } else {
            patch(item.uid, {
                status: 'done',
                files: outcome.files,
                dir: outcome.dir,
                message: outcome.message,
            })
            onToast(`「${item.label}」下载完成：${outcome.files.length} 个文件`, 'ok')
        }
    }

    const runItem = async (item: QueueItem) => {
        patch(item.uid, {status: 'running', message: '正在创建下载任务…', error: undefined})
        let jobId = ''
        try {
            const r = await api.downloadVideo(item.payload)
            jobId = r.jobId
            if (!jobId) throw new Error('任务没能启动，请重试')
        } catch (e) {
            const msg = errText(e)
            patch(item.uid, {status: 'error', error: msg, message: msg})
            onToast(`「${item.label}」下载失败：${msg}`, 'err')
            return
        }
        patch(item.uid, {jobId})
        settle(item, await waitOutcome(jobId))
    }

    const runQueue = async () => {
        if (runningRef.current) return
        runningRef.current = true
        try {
            /* 上一次跑队列时被切走了：那条 promise 悬在收掉的订阅上回不来，这一项
               就一直挂着 `running`。按 jobId 重新接上，否则它永远卡在这儿。 */
            const stuck = queueRef.current.find((q) => q.status === 'running' && q.jobId)
            if (stuck?.jobId) settle(stuck, await waitOutcome(stuck.jobId))
            for (;;) {
                const next = queueRef.current.find((q) => q.status === 'queued')
                if (!next) break
                await runItem(next)
            }
        } finally {
            runningRef.current = false
        }
    }

    /* 队列是模块级的，切回来要主动把它接上：没有这一下，上一批没跑完的项会永远
       停在 `running`，而排在它后面的也再没人去取。 */
    useEffect(() => {
        void runQueue()
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const enqueue = (entries: { key: string; label: string; url: string }[], runNow: boolean) => {
        if (!parsed) {
            onToast('请先解析视频链接', 'warn')
            return
        }
        if (!outDir) {
            onToast('请选择输出目录', 'warn')
            return
        }
        const fresh: QueueItem[] = []
        for (const e of entries) {
            if (!e?.url) continue
            if (queueRef.current.some((q) => q.key === e.key && (q.status === 'queued' || q.status === 'running'))) continue
            if (fresh.some((f) => f.key === e.key)) continue
            fresh.push({
                uid: nextUid(),
                key: e.key,
                label: e.label,
                url: e.url,
                mode,
                payload: buildPayload(e.url),
                status: 'queued',
                message: '',
                files: [],
                dir: '',
            })
        }
        if (!fresh.length) {
            onToast('这些内容已经在队列里了', 'warn')
            return
        }
        if (runNow) queueRef.current.unshift(...fresh)
        else queueRef.current.push(...fresh)
        bump()
        onToast(runNow ? '已开始下载' : `已加入队列：${fresh.map((f) => f.label).join('、')}`, 'info')
        void runQueue()
    }

    const enqueueSelected = () => {
        const items = [...pages, ...season].filter((it) => selection.has(it.key))
        if (!items.length) {
            onToast('还没有勾选任何内容', 'warn')
            return
        }
        enqueue(
            items.map((it) => ({key: it.key, label: `${it.label} ${it.title}`.trim(), url: it.url})),
            false,
        )
    }

    const cancelItem = async (item: QueueItem) => {
        if (item.status === 'queued') {
            patch(item.uid, {status: 'canceled', message: '已取消'})
            return
        }
        if (item.status === 'running' && item.jobId) {
            try {
                await api.cancelJob(item.jobId)
            } catch (e) {
                onToast(`取消失败：${errText(e)}`, 'err')
            }
        }
    }

    const cancelAll = async () => {
        for (const q of queueRef.current) {
            if (q.status === 'queued') {
                q.status = 'canceled'
                q.message = '已取消'
            }
        }
        bump()
        for (const q of queueRef.current) {
            if (q.status === 'running' && q.jobId) {
                try {
                    await api.cancelJob(q.jobId)
                } catch (e) {
                    onToast(`取消失败：${errText(e)}`, 'err')
                }
            }
        }
    }

    const clearDone = () => {
        queueRef.current = queueRef.current.filter((q) => q.status === 'queued' || q.status === 'running')
        bump()
    }

    const retry = (item: QueueItem) => {
        patch(item.uid, {status: 'queued', error: undefined, message: ''})
        void runQueue()
    }

    const toggleSelect = (key: string, on: boolean) => {
        setSelection((prev) => {
            const next = new Set(prev)
            if (on) next.add(key)
            else next.delete(key)
            return next
        })
    }

    const reveal = (path: string, select: boolean) =>
        api.fsReveal(path, select).catch((e: unknown) => onToast(errText(e), 'err'))

    const openPath = (path: string) => api.fsOpen({path}).catch((e: unknown) => onToast(errText(e), 'err'))

    const openUrl = (u: string) => api.fsOpen({url: u}).catch((e: unknown) => onToast(errText(e), 'err'))

    const streamDuration = streams?.durationMs
        ? streams.durationMs / 1000
        : (parsed?.currentPage?.durationSec ?? parsed?.info?.durationSec ?? 0)

    /* ── 渲染 ───────────────────────────────────────────────── */

    return (
        <>
            {/* ══════════════════════ 解析 ══════════════════════ */}
            <Panel>
                <PanelHead
                    title={t("解析视频")}
                    desc="B 站支持分P / 合集 / 番剧 / 大会员画质"
                    extra={<Chip>{t("回车即解析")}</Chip>}
                />
                <div className="stack">
                    <div className="input-group">
                        <TextInput
                            value={url}
                            aria-label={t("视频链接")}
                            spellCheck={false}
                            autoComplete="off"
                            placeholder={t("粘贴 B 站链接 / BV 号 / 番剧 ep，或 YouTube 等站点链接")}
                            onChange={(e) => setUrl(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') void doParse()
                            }}
                        />
                        <Button icon="link" title={t("从剪贴板读链接")} onClick={() => void pasteAndParse()}>
                            粘贴
                        </Button>
                        <Button variant="primary" icon="search" loading={parsing} onClick={() => void doParse()}>
                            解析
                        </Button>
                    </div>

                    {state && !state.tools?.ffmpeg?.available && (
                        <Finding level="warn" title={t("未安装 ffmpeg")}>
                            MV 下载后不会自动合并成 mp4。「仅音频」模式不受影响。
                            <br/>
                            tools 目录缺失，请重新解压程序包。
                        </Finding>
                    )}
                    {state && !state.tools?.ytdlp?.available && (
                        <Finding level="info" title={t("未安装 yt-dlp")}>
                            B 站不受影响；YouTube 等其它站点需要 yt-dlp 才能解析。
                        </Finding>
                    )}
                </div>
            </Panel>

            {/* ══════════════════════ 解析中 / 失败 / 空态 ══════════════════════ */}
            {parsing && (
                <Panel>
                    <p className="muted">{t("正在解析视频信息…")}</p>
                </Panel>
            )}

            {!parsing && parseErr && (
                <Panel>
                    <div className="stack">
                        <Finding level="warn" title={t("解析失败")}>
                            {parseErr}
                        </Finding>
                        {/yt-dlp/i.test(parseErr) && !state?.tools?.ytdlp?.available && (
                            <Finding level="warn" title={t("这个站点需要 yt-dlp")}>
                                装好之后不用改任何设置，重新点「解析」即可。
                            </Finding>
                        )}
                        <p className="video-note">
                            B 站链接异常时，先确认 BV 号是否完整，或到「设置」里填一份 Cookie。
                        </p>
                    </div>
                </Panel>
            )}

            {!parsing && !parseErr && !parsed && (
                <Panel>
                    <div className="empty">
                        <Icon name="video" size={28}/>
                        <p className="finding-title">{t("还没有解析任何视频")}</p>
                        <p className="muted">
                            把链接粘到上面的输入框，按回车即可解析
                        </p>
                    </div>
                </Panel>
            )}

            {/* ══════════════════════ 解析结果 ══════════════════════ */}
            {!parsing && parsed && (
                <Panel>
                    <PanelHead
                        title={t("解析结果")}
                        desc={
                            isBili
                                ? `${isBangumi ? '番剧' : '视频'} · ${info.uploader || 'UP 未知'}`
                                : `${info.extractor || 'yt-dlp'} · ${info.uploader || '作者未知'}`
                        }
                        extra={
                            (isBili ? info.url : info.webpageUrl) ? (
                                <Button size="sm" variant="ghost" icon="external"
                                        onClick={() => void openUrl((isBili ? info.url : info.webpageUrl)!)}>
                                    在浏览器打开
                                </Button>
                            ) : null
                        }
                    />

                    <div className="video-result">
                        {/* ── 左：封面 + 数字 + 简介 ── */}
                        <div className="video-side">
                            {cover && !coverErr ? (
                                <img
                                    className="video-cover"
                                    src={cover}
                                    alt="封面"
                                    referrerPolicy="no-referrer"
                                    loading="lazy"
                                    onError={() => setCoverErr(true)}
                                />
                            ) : (
                                <div className="video-cover video-cover-empty">
                                    <span className="video-note">{coverErr ? '封面加载失败' : '没有封面'}</span>
                                </div>
                            )}

                            <div className="video-stats">
                                <Stat
                                    label="时长"
                                    value={formatDuration(
                                        isBangumi
                                            ? (parsed.currentPage?.durationSec ?? info.episodes?.[0]?.durationSec ?? 0)
                                            : (parsed.currentPage?.durationSec ?? info.durationSec ?? 0),
                                    )}
                                />
                                <Stat
                                    label="播放量"
                                    value={isBili ? (info.view != null ? formatNumber(info.view) : '-') : info.viewCount ? formatNumber(info.viewCount) : '-'}
                                />
                                {isBili ? (
                                    <Stat
                                        label={isBangumi ? '剧集数' : '分P数'}
                                        value={String(isBangumi ? info.episodes?.length || 1 : info.pages?.length || 1)}
                                    />
                                ) : (
                                    <Stat label="来源" value={info.extractor || '-'}/>
                                )}
                                <Stat label={isBili ? '发布日期' : '上传日期'}
                                      value={(isBili ? info.publishDate : info.uploadDate) || '-'}/>
                            </div>

                            {(isBili ? info.desc : info.description) ? (
                                <details className="video-desc-block">
                                    <summary>{t("视频简介")}</summary>
                                    <div className="video-desc">{isBili ? info.desc : info.description}</div>
                                </details>
                            ) : null}
                        </div>

                        {/* ── 右：标题 + 分P/剧集 + 画质 ── */}
                        <div className="video-main">
                            <div className="video-title-block">
                                <h2 className="video-title">{info.title || '（没有标题）'}</h2>
                                <div className="video-meta">
                                    {info.uploader ? <Chip>{`UP：${info.uploader}`}</Chip> : null}
                                    {isBili && isBangumi ? <Chip tone="accent">{t("番剧")}</Chip> : null}
                                    {isBili && info.bvid ? <Chip>{info.bvid}</Chip> : null}
                                    {!isBili && info.extractor ? <Chip tone="accent">{info.extractor}</Chip> : null}
                                    {!isBili && info.id ? <Chip>{info.id}</Chip> : null}
                                    {isBili && parsed.currentPage?.page != null && pages.length > 1 ? (
                                        <Chip tone="accent">{`正在看 P${parsed.currentPage.page}`}</Chip>
                                    ) : null}
                                    {isBili ? (
                                        parsed.hasCookie === false ? (
                                            <Chip tone="warn">{t("未登录")}</Chip>
                                        ) : (
                                            <Chip tone="ok">{t("已登录")}</Chip>
                                        )
                                    ) : null}
                                </div>
                            </div>

                            {/* 分P / 合集 / 剧集 */}
                            {!multiPages && !hasSeason ? (
                                pages.length === 1 ? (
                                    <Finding level="info" title={t("内容")}>
                                        {`单 P 视频：${pages[0].title || '（无分P标题）'}${
                                            pages[0].durationSec ? ` · ${formatDuration(pages[0].durationSec)}` : ''
                                        }`}
                                    </Finding>
                                ) : null
                            ) : (
                                <div className="video-section">
                                    <div className="video-section-head">
                    <span className="field-label">
                      {`${group === 'season' ? (isBangumi ? '剧集' : '合集') : '分P'}（${list.length}）`}
                    </span>
                                        <span className="spacer"/>
                                        {selectedHere > 0 ? <Chip tone="accent">{`已选 ${selectedHere}`}</Chip> : null}
                                    </div>

                                    {multiPages && hasSeason && (
                                        <SegmentedControl
                                            aria-label={t("内容分组")}
                                            items={[
                                                {value: 'pages', label: `分P ${pages.length}`},
                                                {
                                                    value: 'season',
                                                    label: `${isBangumi ? '剧集' : '合集'} ${season.length}`
                                                },
                                            ]}
                                            value={group}
                                            onValueChange={(v) => setTab(v as 'pages' | 'season')}
                                        />
                                    )}

                                    {/* 行包在 `ListSection` 里；分隔线与选中底色由它统一画。 */}
                                    <List>
                                        <ListSection>
                                            {list.map((it) => (
                                                <ListRow
                                                    key={it.key}
                                                    selected={it.active}
                                                    leading={
                                                        <Checkbox
                                                            aria-label={`勾选 ${it.label}`}
                                                            checked={selection.has(it.key)}
                                                            onCheckedChange={(c) => toggleSelect(it.key, c)}
                                                        />
                                                    }
                                                    label={it.label}
                                                    secondaryLabel={`${it.title || '（无标题）'}${
                                                        it.durationSec ? ` · ${formatDuration(it.durationSec)}` : ''
                                                    }`}
                                                    accessory={
                                                        <IconButton
                                                            label={`切到 ${it.label} 并解析`}
                                                            icon="refresh"
                                                            size="sm"
                                                            variant="ghost"
                                                            onClick={() => void switchItem(it)}
                                                        />
                                                    }
                                                />
                                            ))}
                                        </ListSection>
                                    </List>

                                    <div className="btn-row">
                                        <Button
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => {
                                                setSelection((prev) => {
                                                    const next = new Set(prev)
                                                    if (selectedHere === list.length) for (const it of list) next.delete(it.key)
                                                    else for (const it of list) next.add(it.key)
                                                    return next
                                                })
                                            }}
                                        >
                                            {selectedHere === list.length ? '取消全选' : '全选本页'}
                                        </Button>
                                        <Button
                                            size="sm"
                                            variant="primary"
                                            icon="download"
                                            disabled={selection.size === 0}
                                            onClick={enqueueSelected}
                                        >
                                            {selection.size > 1 ? `批量加入下载队列（${selection.size}）` : '把选中的加入队列'}
                                        </Button>
                                    </div>
                                </div>
                            )}

                            {/* 画质 / 音轨（B 站）*/}
                            {isBili && (
                                <div className="video-section">
                                    {!streams ? (
                                        <Finding level="warn" title={t("没有取到播放流信息")}>
                                            这个视频可能受版权限制、需要大会员，或者已经失效。
                                        </Finding>
                                    ) : streams.error ? (
                                        <Finding level="warn" title={t("无法获取画质列表")}>
                                            {`取播放流出错：${streams.error}`}
                                        </Finding>
                                    ) : streams.mode === 'durl' ? (
                                        <>
                                            <span className="field-label">{t("播放流（整段）")}</span>
                                            <Finding level="info" title={t("整段流模式")}>
                                                这个视频只有整段流，画质由 B 站决定，不能单独挑视频轨 / 音频轨；可以整段下载后用
                                                「音频工具 → 从视频提取音频」再抽音轨。
                                            </Finding>
                                            <List>
                                                <ListSection>
                                                    {(streams.streams ?? []).map((s) => (
                                                        <ListRow
                                                            key={s.index}
                                                            label={`第 ${s.index} 段`}
                                                            secondaryLabel={[
                                                                '整段流',
                                                                s.lengthMs ? formatDuration(s.lengthMs / 1000) : '时长未知',
                                                                s.size ? formatBytes(s.size) : '',
                                                            ]
                                                                .filter(Boolean)
                                                                .join(' · ')}
                                                        />
                                                    ))}
                                                </ListSection>
                                            </List>
                                        </>
                                    ) : (
                                        <>
                                            {parsed.hasCookie === false && (
                                                <div className="video-cookie">
                                                    <Finding level="warn" title={t("画质受限：未登录")}>
                                                        {locked.length
                                                            ? `这个视频有 ${locked
                                                                .map((l) => l.name)
                                                                .join('、')} 等高画质，未登录只能取到 ${
                                                                videos.map((v) => v.qualityName).join('、') || '低画质'
                                                            }。`
                                                            : '扫码登录就能解锁 1080P+ 等大会员画质。'}
                                                    </Finding>
                                                    <div className="btn-row">
                                                        <Button
                                                            size="sm"
                                                            variant="primary"
                                                            icon="bilibili"
                                                            onClick={() => setLoginOpen(true)}
                                                        >
                                                            扫码登录
                                                        </Button>
                                                        <Button size="sm" icon="gear"
                                                                onClick={() => onNavigate('settings')}>
                                                            去设置填 Cookie
                                                        </Button>
                                                    </div>
                                                    <p className="video-note">
                                                        扫码最省事：手机 B 站扫一下、确认一下。
                                                    </p>
                                                </div>
                                            )}

                                            <div className="video-section-head">
                                                <span className="field-label">{t("视频流")}</span>
                                                <Chip>{`${videos.length} 条`}</Chip>
                                                <span className="spacer"/>
                                                {mode === 'audio' ?
                                                    <Chip tone="accent">{t("仅音频：不下载视频流")}</Chip> : null}
                                            </div>
                                            {videos.length ? (
                                                <List>
                                                    <ListSection>
                                                        {videos.map((v) => {
                                                            const tag = codecOf(v.codecs)
                                                            return (
                                                                <ListRow
                                                                    key={`${v.id}-${v.codecs ?? ''}`}
                                                                    selected={v.id === picked.quality}
                                                                    label={v.qualityName ?? `画质 ${v.id}`}
                                                                    secondaryLabel={[
                                                                        `${v.width ?? '?'}x${v.height ?? '?'}`,
                                                                        `${v.codecs ?? '编码未知'}${tag ? `（${tag}）` : ''}`,
                                                                        mbps(v.bandwidth),
                                                                        estimateSize(v.bandwidth, streamDuration),
                                                                    ]
                                                                        .filter(Boolean)
                                                                        .join(' · ')}
                                                                    onSelect={() => setPicked((p) => ({
                                                                        ...p,
                                                                        quality: v.id
                                                                    }))}
                                                                />
                                                            )
                                                        })}
                                                    </ListSection>
                                                </List>
                                            ) : (
                                                <Finding level="warn" title={t("没有视频流")}>
                                                    这个视频没有可用的视频流。
                                                </Finding>
                                            )}
                                            {selectedVideo && riskyCodec(selectedVideo.codecs) ? (
                                                <Finding level="warn" title={t("选中的编码兼容性差")}>
                                                    {`选中的 ${selectedVideo.qualityName} 是 ${selectedVideo.codecs}：体积更小，但不少老编辑器、老播放器打不开。要拿去剪辑就换一条 H.264 的。`}
                                                </Finding>
                                            ) : null}
                                            <p className="video-note">{t("默认选最高画质并优先 H.264。")}</p>

                                            <div className="video-section-head">
                                                <span className="field-label">{t("音频流")}</span>
                                                <Chip>{`${audios.length} 条`}</Chip>
                                                <span className="spacer"/>
                                                <span className="video-note">{t("默认 192K，兼容性最好")}</span>
                                            </div>
                                            {audios.length ? (
                                                <List>
                                                    <ListSection>
                                                        {audios.map((a) => (
                                                            <ListRow
                                                                key={a.id}
                                                                selected={a.id === picked.audio}
                                                                label={a.qualityName ?? `音频 ${a.id}`}
                                                                secondaryLabel={[
                                                                    a.codecs ?? '编码未知',
                                                                    mbps(a.bandwidth),
                                                                    estimateSize(a.bandwidth, streamDuration),
                                                                ]
                                                                    .filter(Boolean)
                                                                    .join(' · ')}
                                                                onSelect={() => setPicked((p) => ({...p, audio: a.id}))}
                                                            />
                                                        ))}
                                                    </ListSection>
                                                </List>
                                            ) : (
                                                <Finding level="warn" title={t("没有音频流")}>
                                                    没有可用的音频流。
                                                </Finding>
                                            )}

                                            {isBangumi ? (
                                                <Finding level="info" title={t("番剧画质")}>
                                                    番剧高画质需要大会员
                                                </Finding>
                                            ) : null}
                                        </>
                                    )}
                                </div>
                            )}

                            {/* 可选格式（yt-dlp）*/}
                            {!isBili && (
                                <div className="video-section">
                                    <div className="video-section-head">
                                        <span className="field-label">{t("可选格式")}</span>
                                        <Chip>{`${ytFormats.length} 条`}</Chip>
                                        <span className="spacer"/>
                                    </div>
                                    {ytFormats.length ? (
                                        <List>
                                            <ListSection>
                                                {ytFormats.map((f) => (
                                                    <ListRow
                                                        key={`${f.formatId}-${f.ext ?? ''}`}
                                                        selected={f.formatId === picked.formatId}
                                                        label={`${f.resolution ?? '分辨率未知'}${f.fps ? ` ${f.fps}fps` : ''}`}
                                                        secondaryLabel={[
                                                            f.formatId,
                                                            f.ext,
                                                            `${f.vcodec ?? '?'}${
                                                                f.acodec && f.acodec !== 'none' ? `+${f.acodec}` : '（无音轨）'
                                                            }`,
                                                            f.filesize ? formatBytes(f.filesize) : '',
                                                        ]
                                                            .filter(Boolean)
                                                            .join(' · ')}
                                                        onSelect={() => setPicked((p) => ({
                                                            ...p,
                                                            formatId: f.formatId ?? null
                                                        }))}
                                                    />
                                                ))}
                                            </ListSection>
                                        </List>
                                    ) : (
                                        <Finding level="warn" title={t("没有可用格式")}>
                                            yt-dlp 没有列出可用格式。
                                        </Finding>
                                    )}
                                    {info.subtitles?.length ? (
                                        <Finding level="info" title={t("官方字幕")}>
                                            {`有官方字幕：${info.subtitles.join('、')}。`}
                                        </Finding>
                                    ) : (
                                        <Finding level="info" title={t("官方字幕")}>
                                            这个站点没有列出官方字幕。
                                        </Finding>
                                    )}
                                </div>
                            )}
                        </div>
                    </div>
                </Panel>
            )}

            {/* ══════════════════════ 预览 ══════════════════════ */}
            {!parsing && previewBusy && (
                <Panel>
                    <PanelHead title={t("预览")}/>
                    <p className="muted">
                        正在准备预览…（第一次要等几秒）
                    </p>
                </Panel>
            )}
            {!parsing && !previewBusy && previewErr && (
                <Panel>
                    <PanelHead title={t("预览")}/>
                    <p className="muted">这一段预览不了：{previewErr}</p>
                </Panel>
            )}
            {!parsing && !previewBusy && preview && (
                <Panel>
                    <PanelHead title={t("预览")} desc="不用先下载，直接在这儿看一眼"/>
                    <VideoPreview
                        videoUrl={preview.videoUrl}
                        audioUrl={preview.audioUrl}
                        poster={preview.poster}
                        note={preview.note}
                    />
                </Panel>
            )}

            <ScanLogin
                open={loginOpen}
                onClose={() => setLoginOpen(false)}
                onLoggedIn={() => void onRefreshState()}
                onToast={onToast}
            />

            {/* ══════════════════════ 下载选项 ══════════════════════ */}
            <Panel>
                <PanelHead title={t("下载选项")} desc="存到哪里、下哪些附带内容（会自动记住）"/>
                <div className="stack">
                    <Field
                        label="输出目录"
                        hint={
                            customDir
                                ? `已覆盖设置里的默认下载目录；本次将输出到：${outDir}`
                                : `留空 = 用设置里的默认下载目录：${cfgDownDir || '（未设置）'}`
                        }
                    >
                        <DirectoryInput
                            value={settings.outDir}
                            placeholder={t("留空 = 用设置里的默认下载目录…")}
                            title={t("选下载到哪个目录")}
                            onToast={onToast}
                            onChange={(v) => setSetting('outDir', v)}
                        />
                    </Field>
                    {customDir && (
                        <div className="btn-row">
                            <Button size="sm" variant="ghost" onClick={() => setSetting('outDir', cfgDownDir)}>
                                恢复默认目录
                            </Button>
                        </div>
                    )}

                    <Field
                        label="下载模式"
                        hint={
                            mode === 'audio'
                                ? '只下音频轨（B 站是 m4a），体积小、适合先做分离与对轨。'
                                : isBili
                                    ? '视频与音频分开下载，再用 ffmpeg 合成 mp4。'
                                    : '由 yt-dlp 合并为 mkv/mp4。'
                        }
                    >
                        {durl ? (
                            <Finding level="info" title={t("整段流模式")}>
                                整段流模式下只能整段下载（视频与音频在一起），选不了「仅音频」。
                            </Finding>
                        ) : (
                            <SegmentedControl
                                aria-label={t("下载模式")}
                                items={[
                                    {value: 'video', label: '视频（含音频）'},
                                    {value: 'audio', label: '仅音频'},
                                ]}
                                value={settings.mode}
                                onValueChange={(v) => setSetting('mode', v as Mode)}
                            />
                        )}
                    </Field>

                    <SwitchRow
                        label="下载封面"
                        desc="B 站封面存成同名 .jpg"
                        disabled={!isBili}
                        disabledHint="只在 B 站下载时可用"
                        checked={settings.downloadCover}
                        onChange={(v) => setSetting('downloadCover', v)}
                    />
                    <SwitchRow
                        label="下载弹幕 XML"
                        desc="存成同名 .danmaku.xml"
                        disabled={!isBili}
                        disabledHint="只在 B 站下载时可用"
                        checked={settings.downloadDanmaku}
                        onChange={(v) => setSetting('downloadDanmaku', v)}
                    />
                    <SwitchRow
                        label="下载官方字幕"
                        desc="B 站存成 .srt；其它站点下内嵌字幕"
                        checked={settings.downloadSubs}
                        onChange={(v) => setSetting('downloadSubs', v)}
                    />

                    <Field
                        label="保存到子目录（可选）"
                        hint="可用变量：{title} 标题、{uploader} UP主、{date} 发布日期、{p} 分P号、{quality} 画质。"
                    >
                        <TextInput
                            value={settings.subDir}
                            placeholder={t("留空 = 直接放在输出目录")}
                            onChange={(e) => setSetting('subDir', e.target.value)}
                        />
                    </Field>

                    {!isBili && settings.mode === 'audio' && (
                        <Field
                            label="音频转码格式"
                            hint={
                                state?.tools?.ffmpeg?.available
                                    ? '转码会用到 ffmpeg。'
                                    : '转码需要 ffmpeg，当前未检测到，保持「不转码」即可下载。'
                            }
                        >
                            <Select
                                label="音频转码格式"
                                labelHidden
                                options={CONVERT_TO}
                                value={settings.convertTo}
                                onValueChange={(v) => setSetting('convertTo', v)}
                            />
                        </Field>
                    )}
                </div>
            </Panel>

            {/* ══════════════════════ 动作 ══════════════════════ */}
            <Panel>
                <div className="video-actions">
                    <div className="btn-row">
                        <Button variant="primary" size="lg" icon="download"
                                onClick={() => enqueue([currentEntry()], true)}>
                            开始下载
                        </Button>
                        <Button size="lg" icon="list" onClick={() => enqueue([currentEntry()], false)}>
                            加入下载队列
                        </Button>
                    </div>
                </div>
            </Panel>

            {/* ══════════════════════ 下载队列 ══════════════════════ */}
            {queue.length > 0 && (
                <Panel>
                    <PanelHead
                        title={t("下载队列")}
                        desc={`${doneCount}/${queue.length} 已完成${failedCount ? ` · ${failedCount} 个失败` : ''}${
                            runningItem ? ' · 顺序下载中' : ''
                        }`}
                        extra={
                            <div className="btn-row">
                                <Button size="sm" variant="ghost" icon="x" disabled={!pending}
                                        onClick={() => void cancelAll()}>
                                    全部取消
                                </Button>
                                <Button size="sm" variant="ghost" icon="trash" onClick={clearDone}>
                                    清空已完成
                                </Button>
                            </div>
                        }
                    />

                    <JobProgress
                        job={job}
                        title={runningItem?.label ?? '下载'}
                        onCancel={(id) => void api.cancelJob(id).catch((e: unknown) => onToast(errText(e), 'err'))}
                    />
                    {detail && <p className="video-note">{detail}</p>}

                    <div className="video-queue">
                        {queue.map((it) => (
                            <QueueRow
                                key={it.uid}
                                item={it}
                                percent={job?.status === 'running' ? Math.round(job.percent ?? 0) : null}
                                onCancel={() => void cancelItem(it)}
                                onRetry={() => retry(it)}
                                onOpenDir={() => void reveal(it.dir, false)}
                                onOpenFile={(p) => void openPath(p)}
                                onRevealFile={(p) => void reveal(p, true)}
                            />
                        ))}
                    </div>

                    <p className="video-note">{t("下载在后台进行：切走视图不会中断。")}</p>
                </Panel>
            )}

            {/* 许可与出处：解析下载走 yt-dlp、合流转码走 ffmpeg，都是别人的东西 */}
            <Credit
                items={[
                    {label: '解析下载', value: 'Unlicense', sub: 'yt-dlp 2026.08.19'},
                    {label: '合流转码', value: 'GPL v3', sub: 'FFmpeg 9.0.2（gyan.dev）'},
                ]}
            >
                B 站以外的站点交给 <Upstream href="https://github.com/yt-dlp/yt-dlp">yt-dlp</Upstream>
                （Unlicense）；音视频合流、抽音轨、转码交给{' '}
                <Upstream href="https://ffmpeg.org/">ffmpeg</Upstream>
                （GPL v3）。许可全文见仓库里的 THIRD-PARTY-NOTICES。
            </Credit>
        </>
    )
}

/* ══════════════════════════════════════════════════════ 局部组件 ══ */

/** 队列里的一行：状态、取消/重试、以及完成后的文件清单 */
function QueueRow({
                      item,
                      percent,
                      onCancel,
                      onRetry,
                      onOpenDir,
                      onOpenFile,
                      onRevealFile,
                  }: {
    item: QueueItem
    percent: number | null
    onCancel: () => void
    onRetry: () => void
    onOpenDir: () => void
    onOpenFile: (path: string) => void
    onRevealFile: (path: string) => void
}) {
    return (
        <div className="video-q-row" data-status={item.status}>
            <div className="video-q-head">
                <Icon name={item.mode === 'audio' ? 'music' : 'video'} size={14}/>
                <span className="video-q-label" title={item.label}>
          {item.label}
        </span>
                <Chip tone={jobStatusTone(item.status)}>
                    {`${statusText(item.status)}${item.status === 'running' && percent != null ? ` ${percent}%` : ''}`}
                </Chip>
                {item.status === 'queued' || item.status === 'running' ? (
                    <IconButton label="取消这一项" icon="x" size="sm" variant="ghost" onClick={onCancel}/>
                ) : null}
                {item.status === 'error' || item.status === 'canceled' ? (
                    <IconButton label="重试" icon="refresh" size="sm" variant="ghost" onClick={onRetry}/>
                ) : null}
            </div>

            {item.status === 'error' && item.error ? (
                <p className="video-q-msg video-q-err">{item.error}</p>
            ) : item.message ? (
                <p className="video-q-msg">{item.message}</p>
            ) : null}

            {item.status === 'done' && item.files.length > 0 ? (
                <div className="video-files">
                    <div className="video-file-head">
                        <span className="video-note">{`${item.files.length} 个文件 · ${item.dir}`}</span>
                        <Button size="sm" variant="ghost" icon="folder" onClick={onOpenDir}>
                            打开所在目录
                        </Button>
                    </div>
                    {item.files.map((p) => (
                        <div className="video-file" key={p}>
                            <Icon name="file" size={13}/>
                            <span className="video-file-name" title={p}>
                {baseName(p)}
              </span>
                            <IconButton label="用默认程序打开" icon="play" size="sm" variant="ghost"
                                        onClick={() => onOpenFile(p)}/>
                            <IconButton
                                label="在资源管理器中显示"
                                icon="folder"
                                size="sm"
                                variant="ghost"
                                onClick={() => onRevealFile(p)}
                            />
                        </div>
                    ))}
                </div>
            ) : null}
        </div>
    )
}
