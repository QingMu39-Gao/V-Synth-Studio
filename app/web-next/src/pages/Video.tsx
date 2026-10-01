import { useEffect, useRef, useState } from 'react'
import {
  GlassCheckbox,
  GlassSegmentedControl,
  GlassSwitch,
  List,
  ListRow,
  ListSection,
  Picker,
} from '@ttqtt/liquid-glass-react'
import { api } from '@/lib/api'
import { Button, IconButton } from '@/components/Button'
import { DirectoryInput } from '@/components/DirPicker'
import { Field, TextInput } from '@/components/Field'
import { Icon } from '@/components/Icon'
import { JobProgress } from '@/components/Job'
import { Chip, Finding, Panel, PanelHead, Stat } from '@/components/Panel'
import { formatBytes, formatDuration, formatNumber } from '@/lib/format'
import { useJob } from '@/lib/useJob'
import type { PageProps } from './types'
import './Video.css'

/**
 * 视频解析下载（MV 素材）—— 旧前端 `app/web/js/views/video.js` 的搬家版。
 *
 * B 站走本程序的原生解析（WBI 签名 + DASH 取流），其它站点交给 yt-dlp；
 * 下载是长任务，一律交给后端任务队列，前端只订阅进度。
 * **功能与文案都照旧页面搬，参数名一个没改**（`source` / `outDir` / `mode` /
 * `downloadCover` / `downloadDanmaku` / `downloadSubs` / `quality` / `audioQuality` /
 * `formatId` / `convertTo`，连 localStorage 键 `fandiao.video.settings` 都是同一个 ——
 * 同一个 origin 下新旧界面共用这份偏好，改键名等于把用户的设置丢掉）。
 *
 * ## 队列
 *
 * 旧页面每个队列项各挂一个 `watchJob` 订阅；这里只有**一个** `useJob()`，
 * 由 `runQueue()` 顺序驱动：一项跑完（拿到终态）才 `start()` 下一项 ——
 * 正好是旧页面那条「排成一条顺序队列，不并发轰炸站点」的语义，
 * 而且 `<JobProgress>` 天然就只在跑的那一项上。
 *
 * ## 与旧页面有意不同的三处
 *
 * 1. **分P / 剧集行不再「点哪都是切换解析」**：行的选择（打勾）与切换解析分成了两个控件。
 *    旧页面把 `GlassCheckbox` 塞在可点行里 —— 库的 `ListRow` 有 `onSelect` 时渲染的是真
 *    `<button>`，把 checkbox 嵌进 button 是嵌套交互元素（无效 HTML、读屏也会错乱）。
 *    现在行本身不可点，勾选框负责批量选择，行尾一个图标按钮负责「切到这一项重新解析」。
 * 2. **编码徽章（H.264 / HEVC / AV1）从 chip 变成第二行的文字**：`ListRow` 的选中态会把行内
 *    文字刷成 `--lg-accent-contrast`，而 chip 有自己的颜色，压在强调色底上读不清。
 *    信息没丢，只是换了个地方写。
 * 3. **参数化深链没搬**：旧路由的 `params.url` / `autoParse`（从别的页面带链接跳过来）
 *    在新前端的 hash 路由里没有对应物，`App.tsx` 也不传 params。
 *
 * ## 这里为什么有一份本地的解析结果类型
 *
 * 搬这一页的时候 `lib/api.ts` 的 `VideoParse` 是错的（`currentPage` 写成 number、
 * `streams` 写死非空、缺 `videoAvc`/`videoHevc`/`acceptQuality`），而那次任务不允许改公共库，
 * 于是按 `server/media.rs` + `bili.rs` + 夹具 `video-parse-bili.json` 在页面里声明了一份，
 * 调用点用 `as unknown as` 断言。
 *
 * ⚠️ **`api.ts` 后来已经改成正确形状了**（`VideoParse` / `VideoInfo` / `VideoStreams` …），
 * 本地这份属于重复定义。下次动这一页时可以直接用 `api.ts` 的类型、删掉断言；
 * **但不要照着这两份中的任何一份去改后端** —— 后端才是权威（夹具是它的快照）。
 */

/* ══════════════════════════════════════════════════════════ 后端形状 ══ */

interface Stream {
  id: number
  qualityName?: string
  bandwidth?: number
  width?: number
  height?: number
  codecs?: string
  /* durl 的整段流 */
  index?: number
  size?: number
  lengthMs?: number
}

interface BiliPage {
  page: number
  title?: string
  durationSec?: number
}

interface BiliEpisode {
  epId?: number
  bvid?: string
  title?: string
  longTitle?: string
  durationSec?: number
}

interface YtFormat {
  formatId?: string
  ext?: string
  resolution?: string
  fps?: number
  vcodec?: string
  acodec?: string
  filesize?: number
  isVideo?: boolean
}

interface VideoInfo {
  title?: string
  cover?: string
  thumbnail?: string
  desc?: string
  description?: string
  durationSec?: number
  uploader?: string
  publishDate?: string
  uploadDate?: string
  view?: number
  viewCount?: number
  bvid?: string
  url?: string
  epId?: number
  /* yt-dlp 专有 */
  id?: string
  extractor?: string
  webpageUrl?: string
  subtitles?: string[]
  formats?: YtFormat[]
  /* B 站专有 */
  pages?: BiliPage[]
  episodes?: BiliEpisode[]
  season?: { episodes?: BiliEpisode[] } | null
}

interface Streams {
  mode?: 'dash' | 'durl'
  error?: string
  durationMs?: number
  video?: Stream[]
  audio?: Stream[]
  /** durl：整段流的各分段 */
  streams?: Stream[]
  acceptQuality?: number[]
  acceptDescription?: string[]
}

interface Parsed {
  source?: string
  kind?: string
  info?: VideoInfo
  streams?: Streams | null
  hasCookie?: boolean
  currentPage?: { page?: number; title?: string; durationSec?: number; cover?: string }
}

/* ══════════════════════════════════════════════════════ 设置（同旧页）══ */

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

/** ⚠️ 和旧前端同一个键：新旧界面共用这份设置 */
const LS_KEY = 'fandiao.video.settings'

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
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

function saveSettings(s: Settings) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s))
  } catch {
    /* 存不了就算了，不影响使用 */
  }
}

/** 后端 config 里 Cookie 类的脱敏占位（`server/simple.rs` 的 MASKED） */
const MASKED = '已设置'

const CONVERT_TO = [
  { value: '', label: '保持原样（不转码，最快）' },
  { value: 'mp3', label: 'MP3 320k' },
  { value: 'm4a', label: 'M4A / AAC' },
  { value: 'wav', label: 'WAV 无损' },
  { value: 'flac', label: 'FLAC 无损' },
]

const STATUS_TEXT: Record<QueueItem['status'], string> = {
  queued: '等待中',
  running: '下载中',
  done: '已完成',
  error: '失败',
  canceled: '已取消',
}

/* ══════════════════════════════════════════════════════════════ 工具 ══ */

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

const baseName = (p: string) => String(p ?? '').split(/[\\/]/).pop() || String(p ?? '')

/** DASH 流的码率 + 时长 → 估算体积 */
function estimateSize(bandwidth: number | undefined, durationSec: number): string {
  const bits = Number(bandwidth)
  if (!Number.isFinite(bits) || bits <= 0 || !durationSec) return ''
  return `≈ ${formatBytes((bits / 8) * durationSec)}`
}

function mbps(b: number | undefined): string {
  const n = Number(b)
  if (!Number.isFinite(n) || n <= 0) return '码率未知'
  return n >= 1000000 ? `${(n / 1000000).toFixed(1)} Mbps` : `${Math.round(n / 1000)} kbps`
}

/** 编码族名 —— 旧页面那颗 chip 的文字，现在写在流的第二行里 */
function codecOf(codecs: string | undefined): string {
  const c = String(codecs ?? '').toLowerCase()
  if (/hev|h265/.test(c)) return 'HEVC'
  if (/av01|av1/.test(c)) return 'AV1'
  if (/avc|h264/.test(c)) return 'H.264'
  return ''
}

const riskyCodec = (codecs: string | undefined) => /hev|h265|av01|av1/i.test(String(codecs ?? ''))

function joinPath(dir: string, sub: string): string {
  const d = String(dir ?? '').replace(/[/\\]+$/, '')
  const s = String(sub ?? '').replace(/^[/\\]+/, '')
  return s ? `${d}\\${s}` : d
}

/** 子目录模板：{title} {uploader} {date} {p} {quality}（照旧页面的替换与清洗规则） */
function renderSubDir(parsed: Parsed | null, qualityName: string, template: string): string {
  const t = String(template ?? '').trim()
  if (!t) return ''
  const info = parsed?.info ?? {}
  const map: Record<string, string> = {
    title: info.title ?? '',
    uploader: info.uploader ?? '',
    date: info.publishDate ?? info.uploadDate ?? '',
    p: parsed?.currentPage?.page != null ? String(parsed.currentPage.page) : '',
    quality: qualityName,
  }
  return t
    .replace(/\{(\w+)\}/g, (m, k: string) => (k in map ? String(map[k]) : m))
    .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
    .replace(/[/\\]+/g, '\\')
    .replace(/\\+/g, '\\')
    .replace(/^\\|\\$/g, '')
    .trim()
}

function countItems(d: Parsed | null): number {
  if (!d) return 0
  if (d.source === 'ytdlp') return (d.info?.formats ?? []).filter((f) => f.isVideo).length
  if (d.kind === 'bangumi') return (d.info?.episodes ?? []).length
  return Math.max(1, (d.info?.pages ?? []).length)
}

/** 默认选：最高画质、同画质优先 AVC/H.264（老编辑器打不开 HEVC）；音频默认 192K */
function pickDefaults(d: Parsed): Picked {
  if (d.source === 'ytdlp') {
    const list = (d.info?.formats ?? []).filter((f) => f.isVideo)
    return { quality: null, audio: null, formatId: list[0]?.formatId ?? null }
  }
  const videos = d.streams?.video ?? []
  const avc = videos.filter((v) => /avc|h264/i.test(v.codecs ?? ''))
  const audios = d.streams?.audio ?? []
  return {
    quality: (avc[0] ?? videos[0])?.id ?? null,
    audio: (audios.find((a) => a.id === 30280) ?? audios[0])?.id ?? null,
    formatId: null,
  }
}

/**
 * `acceptQuality` / `acceptDescription` 是平行数组：挑出「视频支持、但当前拿不到」的高画质。
 * 没有 `acceptQuality` 时退化成按名字判断（照旧页面）。
 */
function lockedQualities(streams: Streams | null | undefined): { q: number; name: string }[] {
  const videos = streams?.video ?? []
  const qs = streams?.acceptQuality ?? []
  const ds = streams?.acceptDescription ?? []
  if (!qs.length) {
    const names = new Set(videos.map((v) => v.qualityName))
    return ds
      .filter((n) => /1080P\+|1080P60|4K|8K|HDR|杜比/.test(n) && !names.has(n))
      .map((n) => ({ q: 999, name: n }))
  }
  const avail = new Set(videos.map((v) => v.id))
  return qs
    .map((q, i) => ({ q, name: ds[i] ?? `画质 ${q}` }))
    .filter((x) => !avail.has(x.q) && x.q >= 80)
    .sort((a, b) => b.q - a.q)
}

/** 分P / 合集 / 剧集，摊平成同一种可选项 */
interface Item {
  key: string
  label: string
  title: string
  durationSec?: number
  url: string
  active: boolean
}

function itemList(parsed: Parsed | null): { pages: Item[]; season: Item[] } {
  if (!parsed) return { pages: [], season: [] }
  const info = parsed.info ?? {}
  if (parsed.kind === 'bangumi') {
    return {
      pages: [],
      season: (info.episodes ?? []).map((e, i) => ({
        key: `ep${e.epId}`,
        label: `EP${i + 1}`,
        title: e.title || e.longTitle || '',
        durationSec: e.durationSec,
        url: `https://www.bilibili.com/bangumi/play/ep${e.epId}`,
        active: e.epId === info.epId,
      })),
    }
  }
  return {
    pages: (info.pages ?? []).map((p) => ({
      key: `p${p.page}`,
      label: `P${p.page}`,
      title: p.title || '',
      durationSec: p.durationSec,
      url: `${info.url ?? ''}?p=${p.page}`,
      active: p.page === (parsed.currentPage?.page ?? 1),
    })),
    season: (info.season?.episodes ?? []).map((e, i) => ({
      key: `s${e.bvid ?? i}`,
      label: `第${i + 1}集`,
      title: e.title || '',
      durationSec: e.durationSec,
      url: `https://www.bilibili.com/video/${e.bvid}`,
      active: e.bvid === info.bvid,
    })),
  }
}

/* ══════════════════════════════════════════════════════════════ 队列 ══ */

interface QueueItem {
  uid: number
  key: string
  label: string
  url: string
  mode: Mode
  payload: Record<string, unknown>
  status: 'queued' | 'running' | 'done' | 'error' | 'canceled'
  message: string
  error?: string
  jobId?: string
  files: string[]
  dir: string
}

interface Picked {
  quality: number | null
  audio: number | null
  formatId: string | null
}

/* ══════════════════════════════════════════════════════════════ 页面 ══ */

export function Video({ state, onNavigate, onToast }: PageProps) {
  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [url, setUrl] = useState(() => loadSettings().lastUrl)

  const [parsing, setParsing] = useState(false)
  const [parsed, setParsed] = useState<Parsed | null>(null)
  const [parseErr, setParseErr] = useState<string | null>(null)
  const [coverErr, setCoverErr] = useState(false)

  const [tab, setTab] = useState<'pages' | 'season'>('pages')
  const [selection, setSelection] = useState<Set<string>>(() => new Set())
  const [picked, setPicked] = useState<Picked>({ quality: null, audio: null, formatId: null })

  const [queue, setQueue] = useState<QueueItem[]>([])
  const [detail, setDetail] = useState('')
  const etaRef = useRef<{ t: number; p: number } | null>(null)

  const { job, start } = useJob()

  const cfgDownDir = state?.paths?.downloadDir || state?.paths?.outputDir || ''

  const setSetting = <K extends keyof Settings>(key: K, value: Settings[K]) => {
    setSettings((s) => {
      const next = { ...s, [key]: value }
      saveSettings(next)
      return next
    })
  }

  /* 首屏那次 /api/state 到了之后，把默认下载目录灌进设置（只灌一次，之后归用户） */
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
    if (!prev || now - prev.t >= 1000) etaRef.current = { t: now, p }
    setDetail([speed ? `速度 ${speed}` : '', hasDirect ? `剩余 ${direct}` : computed].filter(Boolean).join(' · '))
  }, [job])

  /* ── 派生值 ─────────────────────────────────────────────── */

  const isBili = parsed?.source !== 'ytdlp'
  const isBangumi = parsed?.kind === 'bangumi'
  const info = parsed?.info ?? {}
  const streams = parsed?.streams ?? null
  /** 整段流（durl）只能整段下载：仅音频模式在它下面不可用 */
  const durl = !!isBili && streams?.mode === 'durl'
  const mode: Mode = durl ? 'video' : settings.mode
  const outDir = settings.outDir.trim() || cfgDownDir
  const customDir = !!settings.outDir.trim() && settings.outDir.trim() !== cfgDownDir

  const videos = streams?.video ?? []
  const audios = streams?.audio ?? []
  const locked = lockedQualities(streams)
  const selectedVideo = videos.find((v) => v.id === picked.quality)

  const { pages, season } = itemList(parsed)
  const multiPages = pages.length > 1
  const hasSeason = season.length > 0
  const group: 'pages' | 'season' = multiPages && hasSeason ? tab : multiPages ? 'pages' : 'season'
  const list = group === 'season' ? season : pages
  const selectedHere = list.filter((it) => selection.has(it.key)).length

  const ytFormats = (info.formats ?? []).filter((f) => f.isVideo)
  const cover = info.cover || parsed?.currentPage?.cover || info.thumbnail

  const runningItem = queue.find((q) => q.status === 'running')
  const doneCount = queue.filter((q) => q.status === 'done').length
  const failedCount = queue.filter((q) => q.status === 'error').length
  const pending = queue.some((q) => q.status === 'queued' || q.status === 'running')

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
      const data = (await api.parseVideo({
        url: target,
        cookie: ck && ck !== MASKED ? ck : undefined,
      })) as unknown as Parsed
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

  /* ── 下载载荷（参数名照旧页面，一个没改）─────────────────── */

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

  const queueRef = useRef<QueueItem[]>([])
  const runningRef = useRef(false)
  const uidRef = useRef(0)

  const bump = () => setQueue([...queueRef.current])

  const patch = (uid: number, p: Partial<QueueItem>) => {
    const it = queueRef.current.find((q) => q.uid === uid)
    if (!it) return
    Object.assign(it, p)
    bump()
  }

  const runItem = async (item: QueueItem) => {
    patch(item.uid, { status: 'running', message: '正在创建下载任务…', error: undefined })
    let jobId = ''
    try {
      const r = await api.downloadVideo(item.payload)
      jobId = r.jobId
      if (!jobId) throw new Error('服务端没有返回任务号')
    } catch (e) {
      const msg = errText(e)
      patch(item.uid, { status: 'error', error: msg, message: msg })
      onToast(`「${item.label}」下载失败：${msg}`, 'err')
      return
    }
    patch(item.uid, { jobId })

    /* 等这一项跑到终态 —— 终态只有一次，所以只会 resolve 一次。
       ⚠️ 切走视图时 useJob 会收订阅，这个 promise 就永远悬着：循环跟着停，
       不会再有 state 更新（旧页面是强行 resolve 掉队列；这里靠组件卸载收场）。 */
    const outcome = await new Promise<{
      files: string[]
      dir: string
      message: string
      error?: string
      canceled?: boolean
    }>((resolve) => {
      start(jobId, {
        onDone: (j) => {
          const r = (j.result ?? {}) as { files?: string[]; dir?: string }
          resolve({ files: r.files ?? [], dir: r.dir ?? '', message: j.message ?? '下载完成' })
        },
        onError: (err) => resolve({ files: [], dir: '', message: err.message, error: err.message }),
        onCancel: () => resolve({ files: [], dir: '', message: '已取消', canceled: true }),
      })
    })

    if (outcome.canceled) {
      patch(item.uid, { status: 'canceled', message: '已取消' })
      onToast(`「${item.label}」已取消`, 'warn')
    } else if (outcome.error) {
      patch(item.uid, { status: 'error', error: outcome.error, message: outcome.message })
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

  const runQueue = async () => {
    if (runningRef.current) return
    runningRef.current = true
    try {
      for (;;) {
        const next = queueRef.current.find((q) => q.status === 'queued')
        if (!next) break
        await runItem(next)
      }
    } finally {
      runningRef.current = false
    }
  }

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
        uid: ++uidRef.current,
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
      items.map((it) => ({ key: it.key, label: `${it.label} ${it.title}`.trim(), url: it.url })),
      false,
    )
  }

  const cancelItem = async (item: QueueItem) => {
    if (item.status === 'queued') {
      patch(item.uid, { status: 'canceled', message: '已取消' })
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
    patch(item.uid, { status: 'queued', error: undefined, message: '' })
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

  const openPath = (path: string) => api.fsOpen({ path }).catch((e: unknown) => onToast(errText(e), 'err'))

  const openUrl = (u: string) => api.fsOpen({ url: u }).catch((e: unknown) => onToast(errText(e), 'err'))

  const streamDuration = streams?.durationMs
    ? streams.durationMs / 1000
    : (parsed?.currentPage?.durationSec ?? parsed?.info?.durationSec ?? 0)

  /* ── 渲染 ───────────────────────────────────────────────── */

  return (
    <>
      {/* ══════════════════════ 解析 ══════════════════════ */}
      <Panel>
        <PanelHead
          title="解析视频"
          desc="B 站原生解析（分P / 合集 / 番剧 / 大会员画质），其它站点走 yt-dlp"
          extra={<Chip>回车即解析</Chip>}
        />
        <div className="stack">
          <div className="input-group">
            <TextInput
              value={url}
              aria-label="视频链接"
              spellCheck={false}
              autoComplete="off"
              placeholder="粘贴 B 站链接 / BV 号 / 番剧 ep，或 YouTube 等站点链接"
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void doParse()
              }}
            />
            <Button icon="link" title="从剪贴板读链接" onClick={() => void pasteAndParse()}>
              粘贴
            </Button>
            <Button variant="primary" icon="search" loading={parsing} onClick={() => void doParse()}>
              解析
            </Button>
          </div>

          {state && !state.tools?.ffmpeg?.available && (
            <Finding level="warn" title="未安装 ffmpeg">
              B 站的 DASH 流是音视频分开的：没有 ffmpeg 就不会自动合并成 mp4，只会留下 .video.m4s 与
              .audio.m4s 两个文件。「仅音频」模式不受影响。
              <br />
              ffmpeg 随程序分发，不需要联网下载；若这里显示未检测到，从压缩包里把 tools
              目录重新解压到程序根目录即可。
            </Finding>
          )}
          {state && !state.tools?.ytdlp?.available && (
            <Finding level="info" title="未安装 yt-dlp">
              B 站解析是本程序原生实现的，不受影响；YouTube 等其它上千个站点需要 yt-dlp 才能解析。
              <br />
              yt-dlp 随程序分发，不需要联网下载；若这里显示未检测到，从压缩包里把 tools
              目录重新解压到程序根目录即可。
            </Finding>
          )}
        </div>
      </Panel>

      {/* ══════════════════════ 解析中 / 失败 / 空态 ══════════════════════ */}
      {parsing && (
        <Panel>
          <p className="muted">正在解析视频信息…（B 站要签名取流，稍等几秒）</p>
        </Panel>
      )}

      {!parsing && parseErr && (
        <Panel>
          <div className="stack">
            <Finding level="warn" title="解析失败">
              {parseErr}
            </Finding>
            {/yt-dlp/i.test(parseErr) && !state?.tools?.ytdlp?.available && (
              <Finding level="warn" title="这个站点需要 yt-dlp">
                装好之后不用改任何设置，重新点「解析」即可。
              </Finding>
            )}
            <p className="video-note">
              提示：B 站链接异常时，可以先确认 BV 号是否完整，或到「设置」里填一份 Cookie。
            </p>
          </div>
        </Panel>
      )}

      {!parsing && !parseErr && !parsed && (
        <Panel>
          <div className="empty">
            <Icon name="video" size={28} />
            <p className="finding-title">还没有解析任何视频</p>
            <p className="muted">
              把 B 站或 YouTube 的链接粘到上面的输入框，按回车就能看到封面、分P、合集和可选画质。
            </p>
          </div>
        </Panel>
      )}

      {/* ══════════════════════ 解析结果 ══════════════════════ */}
      {!parsing && parsed && (
        <Panel>
          <PanelHead
            title="解析结果"
            desc={
              isBili
                ? `${isBangumi ? '番剧' : '视频'} · ${info.uploader || 'UP 未知'} · 共 ${countItems(parsed)} 个可选内容`
                : `${info.extractor || 'yt-dlp'} · ${info.uploader || '作者未知'}`
            }
            extra={
              (isBili ? info.url : info.webpageUrl) ? (
                <Button size="sm" variant="ghost" icon="external" onClick={() => void openUrl((isBili ? info.url : info.webpageUrl)!)}>
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
                  <Stat label="来源" value={info.extractor || '-'} />
                )}
                <Stat label={isBili ? '发布日期' : '上传日期'} value={(isBili ? info.publishDate : info.uploadDate) || '-'} />
              </div>

              {(isBili ? info.desc : info.description) ? (
                <details className="video-desc-block">
                  <summary>视频简介</summary>
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
                  {isBili && isBangumi ? <Chip tone="accent">番剧</Chip> : null}
                  {isBili && info.bvid ? <Chip>{info.bvid}</Chip> : null}
                  {!isBili && info.extractor ? <Chip tone="accent">{info.extractor}</Chip> : null}
                  {!isBili && info.id ? <Chip>{info.id}</Chip> : null}
                  {isBili && parsed.currentPage?.page != null && pages.length > 1 ? (
                    <Chip tone="accent">{`正在看 P${parsed.currentPage.page}`}</Chip>
                  ) : null}
                  {isBili ? (
                    parsed.hasCookie === false ? (
                      <Chip tone="warn">未登录</Chip>
                    ) : (
                      <Chip tone="ok">已登录</Chip>
                    )
                  ) : null}
                </div>
              </div>

              {/* 分P / 合集 / 剧集 */}
              {!multiPages && !hasSeason ? (
                pages.length === 1 ? (
                  <Finding level="info" title="内容">
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
                    <span className="spacer" />
                    {selectedHere > 0 ? <Chip tone="accent">{`已选 ${selectedHere}`}</Chip> : null}
                  </div>

                  {multiPages && hasSeason && (
                    <GlassSegmentedControl
                      aria-label="内容分组"
                      items={[
                        { value: 'pages', label: `分P ${pages.length}` },
                        { value: 'season', label: `${isBangumi ? '剧集' : '合集'} ${season.length}` },
                      ]}
                      value={group}
                      onValueChange={(v) => setTab(v as 'pages' | 'season')}
                    />
                  )}

                  {/* ⚠️ 行必须包在 `ListSection` 里：库的 `List` 只是个外层 div，
                      真正的 `<ul class="lg-list-group">`（分隔线、圆角组框、选中底色）是
                      `ListSection` 渲染的 —— 直接塞 `ListRow` 会掉样式。 */}
                  <List>
                    <ListSection>
                      {list.map((it) => (
                        <ListRow
                          key={it.key}
                          selected={it.active}
                          leading={
                            <GlassCheckbox
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
                  <p className="video-note">
                    勾选多个分P/剧集后加入队列，会按顺序一个一个下载，不会同时开一堆连接。
                  </p>
                </div>
              )}

              {/* 画质 / 音轨（B 站）*/}
              {isBili && (
                <div className="video-section">
                  {!streams ? (
                    <Finding level="warn" title="没有取到播放流信息">
                      这个视频可能受版权限制、需要大会员，或者已经失效。
                    </Finding>
                  ) : streams.error ? (
                    <Finding level="warn" title="无法获取画质列表">
                      {`取播放流出错：${streams.error}`}
                    </Finding>
                  ) : streams.mode === 'durl' ? (
                    <>
                      <span className="field-label">播放流（整段）</span>
                      <Finding level="info" title="整段流模式">
                        这个视频只有整段流（老视频或部分番剧），画质由 B 站决定，不能单独挑视频轨 /
                        音频轨。「仅音频」模式在整段流下不可用，可以整段下载后用「音频工具 →
                        从视频提取音频」再抽音轨。
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
                          <Finding level="warn" title="画质受限：未登录">
                            {locked.length
                              ? `填入 Cookie 可解锁 1080P+。这个视频有 ${locked
                                  .map((l) => l.name)
                                  .join('、')} 等高画质，但没登录 B 站只能取到 ${
                                  videos.map((v) => v.qualityName).join('、') || '低画质'
                                }。填一份 Cookie 就能解锁（设置页一次填好，之后一直有效）。`
                              : '填入 Cookie 可解锁 1080P+ 等大会员画质（设置页一次填好，之后一直有效）。'}
                          </Finding>
                          <div className="btn-row">
                            <Button size="sm" variant="primary" icon="gear" onClick={() => onNavigate('settings')}>
                              去设置填 Cookie
                            </Button>
                            <span className="video-note">Cookie 只保存在本机配置文件里，不会上传到任何地方。</span>
                          </div>
                        </div>
                      )}

                      <div className="video-section-head">
                        <span className="field-label">视频流</span>
                        <Chip>{`${videos.length} 条`}</Chip>
                        <span className="spacer" />
                        {mode === 'audio' ? <Chip tone="accent">仅音频模式：不会下载视频流</Chip> : null}
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
                                  onSelect={() => setPicked((p) => ({ ...p, quality: v.id }))}
                                />
                              )
                            })}
                          </ListSection>
                        </List>
                      ) : (
                        <Finding level="warn" title="没有视频流">
                          这个视频没有可用的 DASH 视频流。
                        </Finding>
                      )}
                      {selectedVideo && riskyCodec(selectedVideo.codecs) ? (
                        <Finding level="warn" title="选中的编码兼容性差">
                          {`选中的 ${selectedVideo.qualityName} 是 ${selectedVideo.codecs}：体积更小，但不少老编辑器、老播放器打不开。要拿去剪辑就换一条 H.264 的。`}
                        </Finding>
                      ) : null}
                      <p className="video-note">
                        默认选最高画质并优先 H.264；同一画质下 B 站只会给一条流（按码率最高的那条算）。
                      </p>

                      <div className="video-section-head">
                        <span className="field-label">音频流</span>
                        <Chip>{`${audios.length} 条`}</Chip>
                        <span className="spacer" />
                        <span className="video-note">默认 192K，兼容性最好</span>
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
                                onSelect={() => setPicked((p) => ({ ...p, audio: a.id }))}
                              />
                            ))}
                          </ListSection>
                        </List>
                      ) : (
                        <Finding level="warn" title="没有音频流">
                          没有可用的音频流。
                        </Finding>
                      )}

                      {isBangumi ? (
                        <Finding level="info" title="番剧画质">
                          番剧的高画质通常需要大会员；如果列表里只有低画质，先确认账号权限。
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
                    <span className="field-label">可选格式</span>
                    <Chip>{`${ytFormats.length} 条`}</Chip>
                    <span className="spacer" />
                    <span className="video-note">由 yt-dlp 列出，选择会作为 -f 参数</span>
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
                            onSelect={() => setPicked((p) => ({ ...p, formatId: f.formatId ?? null }))}
                          />
                        ))}
                      </ListSection>
                    </List>
                  ) : (
                    <Finding level="warn" title="没有可用格式">
                      yt-dlp 没有列出可用格式。
                    </Finding>
                  )}
                  <p className="video-note">「仅音频」模式不传格式号，由 yt-dlp 自己挑 bestaudio。</p>
                  {info.subtitles?.length ? (
                    <Finding level="info" title="官方字幕">
                      {`有官方字幕：${info.subtitles.join('、')}。勾选「下载官方字幕」后会按站点语言内嵌。`}
                    </Finding>
                  ) : (
                    <Finding level="info" title="官方字幕">
                      这个站点没有列出官方字幕。
                    </Finding>
                  )}
                </div>
              )}
            </div>
          </div>
        </Panel>
      )}

      {/* ══════════════════════ 下载选项 ══════════════════════ */}
      <Panel>
        <PanelHead title="下载选项" desc="存到哪里、下哪些附带内容（会自动记住）" />
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
              placeholder="留空 = 用设置里的默认下载目录…"
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
              <Finding level="info" title="整段流模式">
                整段流模式下只能整段下载（视频与音频在一起），选不了「仅音频」。
              </Finding>
            ) : (
              <GlassSegmentedControl
                aria-label="下载模式"
                items={[
                  { value: 'video', label: '视频（含音频）' },
                  { value: 'audio', label: '仅音频' },
                ]}
                value={settings.mode}
                onValueChange={(v) => setSetting('mode', v as Mode)}
              />
            )}
          </Field>

          <SwitchRow
            label="下载封面"
            desc="B 站封面存成同名 .jpg（部分视频没有封面图）"
            disabled={!isBili}
            checked={settings.downloadCover}
            onChange={(v) => setSetting('downloadCover', v)}
          />
          <SwitchRow
            label="下载弹幕 XML"
            desc="存成同名 .danmaku.xml，可丢给弹幕工具"
            disabled={!isBili}
            checked={settings.downloadDanmaku}
            onChange={(v) => setSetting('downloadDanmaku', v)}
          />
          <SwitchRow
            label="下载官方字幕"
            desc="B 站存成 .srt；yt-dlp 走 --write-subs 内嵌字幕"
            checked={settings.downloadSubs}
            onChange={(v) => setSetting('downloadSubs', v)}
          />

          <Field
            label="保存到子目录（可选）"
            hint="可用变量：{title} 标题、{uploader} UP主、{date} 发布日期、{p} 分P号、{quality} 画质。文件名仍按视频标题命名（服务端决定），这里只控制放在哪个子目录里。"
          >
            <TextInput
              value={settings.subDir}
              placeholder="留空 = 直接放在输出目录"
              onChange={(e) => setSetting('subDir', e.target.value)}
            />
          </Field>

          {!isBili && settings.mode === 'audio' && (
            <Field
              label="音频转码格式"
              hint={
                state?.tools?.ffmpeg?.available
                  ? '转码由 yt-dlp 调用 ffmpeg 完成。'
                  : '注意：转码需要 ffmpeg，现在还没装，先保持「不转码」也能下到音频。'
              }
            >
              <Picker
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
            <Button variant="primary" size="lg" icon="download" onClick={() => enqueue([currentEntry()], true)}>
              开始下载
            </Button>
            <Button size="lg" icon="list" onClick={() => enqueue([currentEntry()], false)}>
              加入下载队列
            </Button>
          </div>
          <p className="video-note video-center">
            下载由本地服务完成，不会上传任何东西；解析与下载都走 B 站官方接口。
          </p>
        </div>
      </Panel>

      {/* ══════════════════════ 下载队列 ══════════════════════ */}
      {queue.length > 0 && (
        <Panel>
          <PanelHead
            title="下载队列"
            desc={`${doneCount}/${queue.length} 已完成${failedCount ? ` · ${failedCount} 个失败` : ''}${
              runningItem ? ' · 顺序下载中' : ''
            }`}
            extra={
              <div className="btn-row">
                <Button size="sm" variant="ghost" icon="x" disabled={!pending} onClick={() => void cancelAll()}>
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

          <p className="video-note">下载在后台进行：切走视图也不会中断，回来重新解析即可继续。</p>
        </Panel>
      )}
    </>
  )
}

/* ══════════════════════════════════════════════════════ 局部组件 ══ */

/** 开关行：左边两行说明、右边库的 `GlassSwitch`（照旧页面的 switchRow） */
function SwitchRow({
  label,
  desc,
  checked,
  disabled,
  onChange,
}: {
  label: string
  desc: string
  checked: boolean
  disabled?: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="video-switch-row">
      <div className="video-switch-text">
        <span className="video-switch-label">{label}</span>
        {/* 旧页面点这一行会弹「这一项只在 B 站下载时可用」；库的 switch 禁用了就不响应点击，
            所以把同一句话写进说明里 —— 信息不丢，而且不用点就知道。 */}
        <span className="video-switch-desc">{disabled ? `${desc}（只在 B 站下载时可用）` : desc}</span>
      </div>
      <GlassSwitch aria-label={label} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </div>
  )
}

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
  const tone = item.status === 'error' ? 'err' : item.status === 'done' ? 'ok' : item.status === 'running' ? 'accent' : 'default'
  return (
    <div className="video-q-row" data-status={item.status}>
      <div className="video-q-head">
        <Icon name={item.mode === 'audio' ? 'music' : 'video'} size={14} />
        <span className="video-q-label" title={item.label}>
          {item.label}
        </span>
        <Chip tone={tone}>
          {`${STATUS_TEXT[item.status]}${item.status === 'running' && percent != null ? ` ${percent}%` : ''}`}
        </Chip>
        {item.status === 'queued' || item.status === 'running' ? (
          <IconButton label="取消这一项" icon="x" size="sm" variant="ghost" onClick={onCancel} />
        ) : null}
        {item.status === 'error' || item.status === 'canceled' ? (
          <IconButton label="重试" icon="refresh" size="sm" variant="ghost" onClick={onRetry} />
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
              <Icon name="file" size={13} />
              <span className="video-file-name" title={p}>
                {baseName(p)}
              </span>
              <IconButton label="用默认程序打开" icon="play" size="sm" variant="ghost" onClick={() => onOpenFile(p)} />
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
