import { useEffect, useRef, useState } from 'react'
import {
  GlassDialog,
  GlassSegmentedControl,
  GlassStepper,
  List,
  ListRow,
  ListSection,
  PathBar,
  Picker,
} from '@ttqtt/liquid-glass-react'
import { api, type FsEntry } from '@/lib/api'
import { Button, IconButton } from '@/components/Button'
import { DirectoryInput } from '@/components/DirPicker'
import { Field, TextInput } from '@/components/Field'
import { Icon, type IconName } from '@/components/Icon'
import { JobProgress } from '@/components/Job'
import { Chip, Finding, Panel, PanelHead } from '@/components/Panel'
import { formatBytes, formatDuration } from '@/lib/format'
import { useJob } from '@/lib/useJob'
import type { Job } from '@/lib/types'
import type { PageProps } from './types'
import './Audio.css'

/**
 * 音频工具 —— 旧前端 `app/web/js/views/audio.js` 的搬家版（功能清单与文案来源）。
 *
 * 六种操作全部在本机由 ffmpeg 完成（`api.audioRun` → `useJob` + `<JobProgress>`）：
 * 格式转换 / 提取音频 / 变调 / 变速 / 裁剪片段 / 响度标准化。
 * 参数名**照旧文件**（`format` `sampleRate` `channels` `semitones` `ratio`
 * `startSec` `endSec` `targetLufs`），后端 `audio_run` 是把 `options` 摊平读的。
 *
 * 右边的「人声分离」两条路照旧：在线 MVSEP 走 `api.fsOpen({ url })`（在系统浏览器里开，
 * 不是 window.open）、离线 UVR 走 `api.launch`。ffmpeg 缺失时的说法也照旧 ——
 * **它随包分发，不引导用户去下载**，只说明「tools 目录缺失，从压缩包里重新解压」。
 *
 * 几条和旧实现的**有意差异**（都在文件末尾「与旧实现有意不同的地方」一节写清）：
 *   1. 探测结果用 `<Chip>` 组合而不是 innerHTML 拼串；
 *   2. 输出文件名在「操作 / 格式 / 变调量 / 倍率」变化时重算，和旧实现一致；
 *   3. 波形编辑器是简化版（见 `WaveEditor` 的注释）。
 */

/* ══════════════════════════════════════════════════════════ 常量与设置 ══ */

/** 设置持久化的键 —— **沿用旧前端的键**，用户之前选过的参数不丢 */
const LS_KEY = 'fandiao.audio.settings'
const MVSEP_URL = 'https://mvsep.com/zh'

const OPS: { id: string; name: string; desc: string; icon: IconName }[] = [
  { id: 'convert', name: '格式转换', desc: '导出 WAV / FLAC / MP3…', icon: 'swap' },
  { id: 'extract', name: '提取音频', desc: '把 MV / 视频的音轨抽出来', icon: 'film' },
  { id: 'pitch', name: '变调', desc: '按半音升降，时长不变', icon: 'music' },
  { id: 'tempo', name: '变速', desc: '按倍率快慢，音高不变', icon: 'activity' },
  { id: 'trim', name: '裁剪片段', desc: '波形上拖端点、切片分段导出', icon: 'scissors' },
  { id: 'normalize', name: '响度标准化', desc: '伴奏与干声拉到同一响度', icon: 'wave' },
]

const AUDIO_EXTS = ['wav', 'mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma', 'aiff', 'aif', 'ape', 'alac']
/** 文件选择器能挑的：音频 + 常见视频容器（提取音轨时要挑视频） */
const MEDIA_EXTS = new Set([...AUDIO_EXTS, 'mp4', 'mkv', 'flv', 'mov', 'webm', 'avi', 'ts', 'm4v', 'wmv'])

const SEMITONE_PRESETS = [-12, -7, -5, -3, -2, -1, 1, 2, 3, 5, 7, 12]
const TEMPO_PRESETS = [0.5, 0.75, 0.9, 1.1, 1.25, 1.5, 2]

const SAMPLE_RATES = [
  { value: '0', label: '保持原样' },
  { value: '44100', label: '44100 Hz（CD）' },
  { value: '48000', label: '48000 Hz（视频常用）' },
  { value: '22050', label: '22050 Hz（体积小）' },
  { value: '96000', label: '96000 Hz（高采样）' },
]
const CHANNELS = [
  { value: '0', label: '保持原样' },
  { value: '1', label: '单声道' },
  { value: '2', label: '立体声' },
]
/** `targetLufs` → 那句解释（旧的 `select` 选项文案，现在挂在分段控件下面） */
const LUFS = [
  { value: '-9', label: '-9 LUFS' },
  { value: '-14', label: '-14 LUFS' },
  { value: '-16', label: '-16 LUFS' },
  { value: '-23', label: '-23 LUFS' },
] as const
const LUFS_DESC: Record<string, string> = {
  '-9': '很响，适合短视频 / 翻唱投稿',
  '-14': '常用标准，推荐',
  '-16': '保守一点，留动态',
  '-23': '广播标准（EBU R128）',
}

/** 存进 localStorage 的那部分设置（不含分段 —— 分段由波形编辑器按当前素材重建） */
interface Settings {
  action: string
  input: string
  outDir: string
  outDirTouched: boolean
  outName: string
  nameEdited: boolean
  lastDir: string
  convertFormat: string
  sampleRate: number
  channels: number
  semitones: number
  ratio: number
  startSec: number
  endSec: number
  targetLufs: number
}

const DEFAULTS: Settings = {
  action: 'convert',
  input: '',
  outDir: '',
  outDirTouched: false,
  outName: '',
  nameEdited: false,
  lastDir: '',
  convertFormat: 'wav',
  sampleRate: 0,
  channels: 0,
  semitones: 0,
  ratio: 1,
  startSec: 0,
  endSec: 0,
  targetLufs: -14,
}

function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return { ...DEFAULTS }
    return { ...DEFAULTS, ...(JSON.parse(raw) as Partial<Settings>) }
  } catch {
    return { ...DEFAULTS }
  }
}

/* ══════════════════════════════════════════════════════════ 数据形状 ══ */

/**
 * `state.audioFormats` 的一项。
 *
 * `lib/types.ts` 里它声明成 `Record<string, unknown>`（只搬这一页时不去改公共类型），
 * 所以这里按后端 `data::audio_formats()` 的真实形状收一次。
 */
interface AudioFormat {
  label?: string
  ext?: string
  lossless?: boolean
}

/** `state.editors` 的一项（只用到 UVR 这三个字段） */
interface EditorInfo {
  id?: string
  installed?: boolean
  path?: string | null
}

/** `state.config` 里这一页读得到的字段 */
interface AudioConfig {
  outputDir?: string
}

/**
 * `api.audioProbe` 的返回。`lib/api.ts` 里那个 `AudioProbe['info']` 只声明了
 * 时长 / 音频 / 视频三样，而后端 `probe_media` 还会给容器、大小、总码率、
 * 以及「ffmpeg 缺失（`available:false`）」「读不出来（`probed:false` + `note`）」
 * 两种状态 —— 旧页面正是按这些画提示的，所以这里补全。
 */
interface ProbeInfo {
  available?: boolean
  probed?: boolean
  note?: string
  durationSec?: number
  sizeBytes?: number
  bitrate?: number
  formatName?: string
  audio?: { codec?: string; sampleRate?: number; channels?: number; bitrate?: number } | null
  video?: { codec?: string; width?: number; height?: number } | null
}

/** 一次要提交的音频任务（裁剪多段时一段一个） */
interface RunJob {
  action: string
  output: string
  options: Record<string, unknown>
}

/* ══════════════════════════════════════════════════════════════ 小工具 ══ */

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** 操作 id → 中文名（进度条标题、结果卡里都要用） */
const opNameFor = (id: string) => OPS.find((o) => o.id === id)?.name ?? id

/** `H:\音乐\mv.mp4` → `H:\音乐` */
function dirName(p: string | undefined): string {
  const s = String(p ?? '').replace(/[/\\]+$/, '')
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
  return i > 0 ? s.slice(0, i) : ''
}

/** `H:\音乐\mv.mp4` → `mv.mp4` */
function baseName(p: string | undefined): string {
  const s = String(p ?? '')
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
  return i >= 0 ? s.slice(i + 1) : s
}

const stripExt = (name: string) => name.replace(/\.[^.\\/]+$/, '')

function extOf(name: string): string {
  const m = /\.([^.\\/]+)$/.exec(String(name ?? ''))
  return m ? m[1].toLowerCase() : ''
}

function joinPath(dir: string | undefined, name: string | undefined): string {
  const d = String(dir ?? '').replace(/[/\\]+$/, '')
  const n = String(name ?? '').replace(/^[/\\]+/, '')
  return d ? `${d}\\${n}` : n
}

/** 1 → 单声道、2 → 立体声、其它 → N 声道 */
function channelsText(n: number | undefined): string {
  const c = Number(n)
  if (c === 1) return '单声道'
  if (c === 2) return '立体声'
  return `${c} 声道`
}

/* ── 时间码：`app/web/js/timecode.js` 的两个函数 ────────────────────────
   新前端的 `lib/format.ts` 里那个 `formatTime` 是**时钟时间**（HH:MM:SS），
   和这里要的「秒 ↔ 分:秒.毫秒」不是一回事，所以照旧实现一份（只这一页用）。 */

/** 秒 → `1:23.456`。非法 / 负数一律当 0（输入框里放 NaN 没有意义） */
function formatTimecode(sec: number): string {
  const n = Number(sec)
  const ms = Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : 0
  const h = Math.floor(ms / 3600000)
  const m = Math.floor(ms / 60000) % 60
  const s = Math.floor(ms / 1000) % 60
  const milli = ms % 1000
  const minutes = h ? String(m).padStart(2, '0') : String(m)
  return `${h ? `${h}:` : ''}${minutes}:${String(s).padStart(2, '0')}.${String(milli).padStart(3, '0')}`
}

/**
 * 宽松解析时间码（`83` / `1:23` / `1:23.456` / `1:02:03`），非法返回 `null`。
 * 后面的段允许溢出（`1:75` = 135 秒）—— 从别处抄来的时间不该因为秒超过 60 被打回。
 */
function parseTimecode(input: string): number | null {
  const text = String(input ?? '').trim()
  if (!text || !/^[\d:.]+$/.test(text)) return null
  const parts = text.split(':')
  if (parts.length > 3) return null
  let total = 0
  for (const part of parts) {
    if (part === '') return null
    const n = Number(part)
    if (!Number.isFinite(n) || n < 0) return null
    total = total * 60 + n
  }
  return Math.round(total * 1000) / 1000
}

/* ══════════════════════════════════════════════════════════════════ 页面 ══ */

export function Audio({ state, onNavigate, onToast }: PageProps) {
  const formats = (state?.audioFormats ?? {}) as Record<string, AudioFormat>
  const cfg = (state?.config ?? {}) as AudioConfig
  const ffmpeg = state?.tools?.ffmpeg
  const ffmpegOk = ffmpeg?.available === true
  const defaultOutDir = state?.paths?.outputDir ?? cfg.outputDir ?? ''

  const [settings, setSettings] = useState<Settings>(loadSettings)
  const [probe, setProbe] = useState<ProbeInfo | null>(null)
  const [probeErr, setProbeErr] = useState('')
  const [probing, setProbing] = useState(false)
  const [picking, setPicking] = useState(false)
  const [result, setResult] = useState<{ action: string; output: string } | null>(null)
  const [runErr, setRunErr] = useState('')
  /** 提交前的参数问题（要留在字段上，不能只弹个 toast 就没了） */
  const [fieldErr, setFieldErr] = useState('')
  /** 进度条的标题：多段导出时带上「第 n / m 段」 */
  const [jobLabel, setJobLabel] = useState('处理进度')

  /**
   * 裁剪的分段**放在页面这一层**，不放波形编辑器内部：切到别的操作再切回来时，
   * 编辑器会重新挂载，分段放在里面就没了。旧实现靠「只建一次、反复复用那个 DOM」
   * 绕开，React 里的等价做法是把状态提上来（惰性初值从设置里恢复上次的选区）。
   */
  const [trimState, setTrimState] = useState<{ segments: Seg[]; selected: number }>(() => {
    const s0 = Math.max(0, Number(settings.startSec) || 0)
    const e0 = Math.max(s0, Number(settings.endSec) || 0)
    return { segments: [{ start: s0, end: e0 }], selected: 0 }
  })

  /** 已探测过的路径 → 结果。点「重新读取」才会重探 */
  const probeCache = useRef(new Map<string, ProbeInfo | { error: string }>())

  const { job, start } = useJob()

  const patch = (p: Partial<Settings>) => setSettings((s) => ({ ...s, ...p }))

  /**
   * 旧页面支持 `#/audio?input=<路径>` 带一个素材进来（旧 `render(ctx)` 读 `params.input`）。
   * 新前端没有 params 通道，读一次 URL 里的 `input` 查询串顶上 —— 少了它，
   * 「把结果丢给音频页」这类跳转就会静默丢掉素材。
   */
  const urlSeeded = useRef(false)
  useEffect(() => {
    if (urlSeeded.current) return
    urlSeeded.current = true
    const q = location.hash.split('?')[1]
    const p = q ? new URLSearchParams(q).get('input') : null
    if (p) setInput(p)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /* ── 持久化 ─────────────────────────────────────────────── */

  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(settings))
    } catch {
      /* 存不了不影响使用（隐私模式） */
    }
  }, [settings])

  /* ── 探测 ───────────────────────────────────────────────── */

  const input = settings.input.trim()

  /** 只读探测：文件存在就能拿到 info（装了 ffmpeg 才有详细字段） */
  const probeFile = async (path: string, notify: boolean, force = false) => {
    if (!path || !ffmpegOk) {
      setProbe(null)
      setProbeErr('')
      return
    }
    if (!force) {
      const cached = probeCache.current.get(path)
      if (cached) {
        applyProbe(cached)
        return
      }
    }
    setProbing(true)
    try {
      const { info } = await api.audioProbe(path)
      const next = (info ?? {}) as ProbeInfo
      probeCache.current.set(path, next)
      if (settings.input.trim() === path) applyProbe(next)
    } catch (e) {
      const msg = errText(e)
      probeCache.current.set(path, { error: msg })
      if (settings.input.trim() === path) applyProbe({ error: msg })
      if (notify) onToast(`读不到这个文件：${msg}`, 'err')
    } finally {
      setProbing(false)
    }
  }

  const applyProbe = (v: ProbeInfo | { error: string }) => {
    if ('error' in v) {
      setProbe(null)
      setProbeErr(v.error)
      return
    }
    setProbeErr('')
    setProbe(v)
  }

  /** 换了素材：清缓存里的旧结果、重探、把名字按新素材重算 */
  const setInput = (path: string) => {
    patch({
      input: path,
      lastDir: dirName(path) || settings.lastDir,
      nameEdited: false,
    })
    setResult(null)
    setRunErr('')
    setFieldErr('')
    void probeFile(path, false, true)
  }

  /* 首屏：设置里存着路径就直接探一次（探测本身是只读的） */
  const booted = useRef(false)
  useEffect(() => {
    if (booted.current) return
    booted.current = true
    if (settings.input.trim() && ffmpegOk) void probeFile(settings.input.trim(), false)
    // 只在拿到 state 后跑一次
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ffmpegOk])

  /* `state` 到得比首屏晚时补一次：ffmpeg 从「未知」变「可用」后要重探 */
  const probedFor = useRef('')
  useEffect(() => {
    const p = settings.input.trim()
    if (!ffmpegOk || !p || p === probedFor.current) return
    probedFor.current = p
    if (!probe && !probeErr) void probeFile(p, false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ffmpegOk, settings.input])

  /* ── 输出目录 / 文件名 ──────────────────────────────────── */

  /** 输出目录的来源：用户改过就用他的，否则用设置里的默认目录 */
  const outDir = settings.outDirTouched && settings.outDir ? settings.outDir : defaultOutDir
  const formatExt = formats[settings.convertFormat]?.ext ?? '.wav'

  const keepAudioExt = () => {
    const e = extOf(settings.input)
    return e && AUDIO_EXTS.includes(e) ? `.${e}` : '.wav'
  }

  const inferOutName = () => {
    const base = stripExt(baseName(settings.input)) || 'output'
    const semi = Number(settings.semitones) || 0
    const ratio = Number(settings.ratio) || 1
    switch (settings.action) {
      case 'convert':
        return `${base}${formatExt}`
      case 'extract':
        return `${base}_音频${formatExt}`
      case 'pitch':
        return `${base}${semi ? `_${semi > 0 ? '+' : ''}${semi}半音` : '_变调'}${keepAudioExt()}`
      case 'tempo':
        return `${base}_x${ratio}${keepAudioExt()}`
      case 'trim':
        return `${base}_片段.wav`
      case 'normalize':
        return `${base}_标准化.wav`
      default:
        return `${base}.wav`
    }
  }

  /* 影响文件名的四样变了就重算（名字是用户手改过的就不动）；顺带补上首次的默认名 */
  useEffect(() => {
    if (settings.nameEdited) return
    const next = inferOutName()
    setSettings((s) => (s.outName === next ? s : { ...s, outName: next }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.action, settings.convertFormat, settings.semitones, settings.ratio, settings.input, settings.nameEdited])

  const outName = settings.outName.trim() || inferOutName()
  const output = joinPath(outDir, outName)
  const sameAsInput = !!input && output.toLowerCase() === input.toLowerCase()

  /* ── 执行 ───────────────────────────────────────────────── */

  const buildOptions = (action: string): Record<string, unknown> => {
    switch (action) {
      case 'convert':
      case 'extract': {
        const o: Record<string, unknown> = { format: settings.convertFormat }
        if (Number(settings.sampleRate)) o.sampleRate = Number(settings.sampleRate)
        if (Number(settings.channels)) o.channels = Number(settings.channels)
        return o
      }
      case 'pitch':
        return { semitones: Number(settings.semitones) }
      case 'tempo':
        return { ratio: Number(settings.ratio) }
      case 'trim':
        return { startSec: Number(settings.startSec) || 0, endSec: Number(settings.endSec) || 0 }
      case 'normalize':
        return { targetLufs: Number(settings.targetLufs) || -14 }
      default:
        return {}
    }
  }

  const validate = (action: string, options: Record<string, unknown>): string | null => {
    if (!formats[settings.convertFormat] && (action === 'convert' || action === 'extract')) {
      return '输出格式不可用，请重新选一个'
    }
    if (action === 'pitch' && !options.semitones) return '变调量不能是 0，先点一个半音数'
    if (action === 'tempo' && !(Number(options.ratio) > 0)) return '速度倍率必须大于 0'
    if (action === 'trim' && !(Number(options.endSec) > Number(options.startSec))) {
      return '裁剪的「结束」要大于「开始」'
    }
    return null
  }

  /**
   * 提交一批任务（裁剪多段时一段一个）。
   * 后端 `audio_run` 是把 `{ input, output, options }` 摊平读的，所以每次一个新任务；
   * 一段失败 / 取消就停下 —— 剩下的多半也会失败，一次跑完更浪费时间（旧实现同）。
   */
  const runJobs = async (jobs: RunJob[]) => {
    if (!jobs.length) {
      onToast('没有可导出的分段', 'warn')
      return
    }
    for (const j of jobs) {
      const problem = validate(j.action, j.options)
      if (problem) {
        setFieldErr(problem)
        onToast(problem, 'warn')
        return
      }
      if (j.output.toLowerCase() === input.toLowerCase()) {
        onToast('输出文件不能和输入文件同名，改一下文件名或目录', 'err')
        return
      }
    }
    setFieldErr('')
    setResult(null)
    setRunErr('')

    const total = jobs.length
    const submit = async (i: number) => {
      const j = jobs[i]
      const r = await api.audioRun({ action: j.action, input, output: j.output, options: j.options })
      if (!r?.jobId) throw new Error('服务端没有返回任务号')
      /* 多段导出时标题带上「第 n / m 段」—— 不然每一段都从头跑到尾，看着像卡住了 */
      setJobLabel(
        total > 1
          ? `${opNameFor(j.action)} · ${baseName(j.output)}（第 ${i + 1} / ${total} 段）`
          : `${opNameFor(j.action)} · ${baseName(j.output)}`,
      )
      start(r.jobId, {
        onDone: (done: Job) => {
          const wrote = String((done.result as { output?: string } | undefined)?.output ?? j.output)
          if (i + 1 < total) {
            void submit(i + 1).catch((e) => {
              const msg = errText(e)
              setRunErr(msg)
              onToast(`提交任务失败：${msg}`, 'err')
            })
            return
          }
          setResult({ action: j.action, output: wrote })
          onToast(total > 1 ? `已导出 ${total} 个分段` : `处理完成：${baseName(wrote)}`, 'ok')
        },
        onError: (err) => {
          setRunErr(err.message)
          onToast(`处理失败：${err.message}`, 'err')
        },
        onCancel: () => {
          setRunErr('')
          onToast('已取消', 'warn')
        },
      })
    }

    try {
      await submit(0)
    } catch (e) {
      const msg = errText(e)
      setRunErr(msg)
      onToast(`提交任务失败：${msg}`, 'err')
    }
  }

  /** 「开始处理」 */
  const run = () => {
    if (!input) {
      onToast('请先选择要处理的音频文件', 'warn')
      return
    }
    if (!/^[a-zA-Z]:[\\/]|^\\\\|^\//.test(input)) {
      onToast('请输入完整路径，例如 H:\\音乐\\mv.mp4', 'warn')
      return
    }
    if (!ffmpegOk) {
      onToast('未检测到 ffmpeg：它随程序分发，不需要联网下载。若 tools 目录缺失，从压缩包里重新把 tools 解压到程序根目录。', 'warn')
      return
    }
    if (!outDir) {
      onToast('请选择输出目录', 'warn')
      return
    }
    const action = settings.action
    void runJobs([{ action, output, options: buildOptions(action) }])
  }

  /** 波形编辑器的「导出这一段 / 全部导出」 */
  const exportSegments = (segs: Seg[], selected: number, all: boolean) => {
    if (!input) {
      onToast('请先选择要处理的音频文件', 'warn')
      return
    }
    if (!ffmpegOk) {
      onToast('未检测到 ffmpeg，裁剪需要它。它随程序分发，不用联网下载。', 'warn')
      return
    }
    if (!outDir) {
      onToast('请选择输出目录', 'warn')
      return
    }
    const picks = all ? segs.map((s, i) => ({ ...s, i })) : [{ ...segs[selected], i: selected }]
    /* 切成多段时文件名一律补 `_01` —— 不然单段导出会互相覆盖 */
    const numbered = segs.length > 1
    const ext = extOf(outName) ? `.${extOf(outName)}` : ''
    const jobs = picks.map((s) => ({
      action: 'trim',
      options: { startSec: s.start, endSec: s.end },
      output: joinPath(outDir, numbered ? `${stripExt(outName)}_${String(s.i + 1).padStart(2, '0')}${ext}` : outName),
    }))
    void runJobs(jobs)
  }

  /* ── 派生数据 ───────────────────────────────────────────── */

  const formatEntries = Object.entries(formats)
  const opName = OPS.find((o) => o.id === settings.action)?.name ?? settings.action
  const running = job?.status === 'running'
  const ratioValue = Math.pow(2, Number(settings.semitones) / 12)

  /* ── 渲染 ───────────────────────────────────────────────── */

  return (
    <div className="audio-layout">
      {/* ══════════════════════ 左：素材 / 操作 / 输出 ══════════════════════ */}
      <div className="audio-col">
        {/* ffmpeg 缺失：整块说明「怎么恢复」，不引导下载 */}
        {state && !ffmpegOk && (
          <Panel>
            <PanelHead
              title="未检测到 ffmpeg"
              desc="下面这些操作全靠它"
              extra={<Chip tone="err">未检测到</Chip>}
            />
            <div className="stack">
              <Finding level="warn" title="怎么恢复">
                格式转换、提取音轨、变调、变速、裁剪、响度标准化、读取媒体信息都需要 ffmpeg。
                ffmpeg 随程序分发，**不需要联网下载**；这里显示未检测到，说明 tools 目录缺失或不完整
                —— 从压缩包里把 tools 整个目录重新解压到程序根目录即可。
              </Finding>
              <div className="btn-row">
                <Button size="lg" icon="gear" onClick={() => onNavigate('settings')}>
                  去设置看看
                </Button>
              </div>
              <p className="hint">也可以自己装一份 ffmpeg 并加到系统 PATH，程序会自动检测到。</p>
            </div>
          </Panel>
        )}

        {/* ── 素材 ── */}
        <Panel>
          <PanelHead
            title="素材"
            desc="选一个音频或视频文件，所有处理都在本机完成"
            extra={
              <Chip tone={ffmpegOk ? 'ok' : 'warn'}>{ffmpegOk ? 'ffmpeg 已就绪' : 'ffmpeg 未就绪'}</Chip>
            }
          />
          <div className="stack">
            <Field
              label="文件路径"
              hint="点「浏览」直接在本机选文件；也可以把完整路径（含文件名）粘贴到这里，回车生效。"
            >
              <div className="input-group">
                <TextInput
                  value={settings.input}
                  spellCheck={false}
                  autoComplete="off"
                  placeholder="音频 / 视频文件的完整路径，例如 H:\音乐\Never Gonna Give You Up.mp4"
                  onChange={(e) => patch({ input: e.target.value })}
                  onKeyDown={(e) => {
                    if (e.key !== 'Enter') return
                    const next = e.currentTarget.value.trim()
                    if (next === settings.input.trim()) return
                    setInput(next)
                  }}
                />
                <Button icon="folder" onClick={() => setPicking(true)}>
                  浏览
                </Button>
                <Button
                  variant="ghost"
                  icon="x"
                  disabled={!settings.input}
                  onClick={() => setInput('')}
                >
                  清空
                </Button>
              </div>
            </Field>

            {/* 探测结果 */}
            {!input ? (
              <Finding level="info" title="还没有选文件">
                选好之后这里会显示时长、编码、采样率、声道；选视频的话还会显示分辨率。
              </Finding>
            ) : probing ? (
              <p className="muted">正在读取媒体信息…</p>
            ) : probeErr ? (
              <Finding level="warn" title="读不到这个文件">
                {probeErr}
              </Finding>
            ) : !ffmpegOk ? (
              <Finding level="warn" title="读不出媒体信息">
                装了 ffmpeg 之后，这里会显示时长、编码、采样率与声道（现在读不出来，但不影响先选好文件）。
              </Finding>
            ) : !probe || probe.available === false ? (
              <Finding level="warn" title="读不出媒体信息">
                装了 ffmpeg 之后，这里会显示时长、编码、采样率与声道（现在读不出来，但不影响先选文件）。
              </Finding>
            ) : probe.probed === false ? (
              <Finding level="info" title="没能读出媒体信息">
                {probe.note ?? '没能读出媒体信息'}
              </Finding>
            ) : (
              <div className="stack">
                <div className="audio-probe-head">
                  <span className="audio-probe-name" title={input}>
                    {baseName(input)}
                  </span>
                  <Chip tone={probe.audio ? 'ok' : 'warn'}>{probe.audio ? '含音轨' : '无音轨'}</Chip>
                  {probe.video ? <Chip tone="accent">含视频轨</Chip> : null}
                  <span className="spacer" />
                  <Button size="sm" variant="ghost" icon="refresh" onClick={() => void probeFile(input, true, true)}>
                    重新读取
                  </Button>
                </div>
                <div className="chips">
                  <Chip>
                    <span className="audio-dim">时长</span>
                    {probe.durationSec ? formatDuration(probe.durationSec) : '未知'}
                  </Chip>
                  {probe.formatName ? (
                    <Chip>
                      <span className="audio-dim">容器</span>
                      {probe.formatName}
                    </Chip>
                  ) : null}
                  {probe.sizeBytes ? (
                    <Chip>
                      <span className="audio-dim">大小</span>
                      {formatBytes(probe.sizeBytes)}
                    </Chip>
                  ) : null}
                  {probe.bitrate ? (
                    <Chip>
                      <span className="audio-dim">总码率</span>
                      {`${Math.round(probe.bitrate / 1000)} kbps`}
                    </Chip>
                  ) : null}
                  {probe.audio?.codec ? (
                    <Chip>
                      <span className="audio-dim">音频编码</span>
                      {probe.audio.codec}
                    </Chip>
                  ) : null}
                  {probe.audio?.sampleRate ? (
                    <Chip>
                      <span className="audio-dim">采样率</span>
                      {`${probe.audio.sampleRate} Hz`}
                    </Chip>
                  ) : null}
                  {probe.audio?.channels ? (
                    <Chip>
                      <span className="audio-dim">声道</span>
                      {channelsText(probe.audio.channels)}
                    </Chip>
                  ) : null}
                  {probe.video ? (
                    <Chip>
                      <span className="audio-dim">视频</span>
                      {`${probe.video.codec ?? ''} ${probe.video.width}x${probe.video.height}`.trim()}
                    </Chip>
                  ) : null}
                </div>
              </div>
            )}
          </div>
        </Panel>

        {/* ── 处理操作 ── */}
        <Panel>
          <PanelHead title="处理操作" desc="一次处理一件事，选好参数再点下面的「开始处理」" />
          <div className="stack-lg">
            <div className="audio-ops" role="group" aria-label="处理操作">
              {OPS.map((op) => (
                <button
                  key={op.id}
                  type="button"
                  className="audio-op"
                  title={op.desc}
                  data-selected={settings.action === op.id ? 'true' : undefined}
                  aria-pressed={settings.action === op.id}
                  onClick={() => {
                    if (settings.action === op.id) return
                    patch({ action: op.id, nameEdited: false })
                    setFieldErr('')
                    setResult(null)
                  }}
                >
                  <Icon name={op.icon} size={18} />
                  <span className="audio-op-name">{op.name}</span>
                  <span className="audio-op-desc">{op.desc}</span>
                </button>
              ))}
            </div>

            {/* 参数：随操作切换（表单字段是库的 / 我们 components 的包装） */}
            <div className="stack">
              {(settings.action === 'convert' || settings.action === 'extract') && (
                <>
                  <Field
                    label="输出格式"
                    hint="带「无损」标记的是 WAV / FLAC：做后期就用它们；只是想试听、传手机，MP3 320k 足够。"
                  >
                    {formatEntries.length === 0 ? (
                      <Finding level="warn" title="格式列表为空">
                        没有读到可用的音频格式列表，请刷新页面重试。
                      </Finding>
                    ) : (
                      <div className="audio-formats">
                        {formatEntries.map(([id, f]) => (
                          <button
                            key={id}
                            type="button"
                            className="audio-format"
                            data-selected={settings.convertFormat === id ? 'true' : undefined}
                            aria-pressed={settings.convertFormat === id}
                            title={f.lossless ? '无损格式' : '有损压缩格式'}
                            onClick={() => patch({ convertFormat: id, nameEdited: false })}
                          >
                            <span className="audio-format-name">
                              {f.label ?? id}
                              {f.lossless ? <Chip tone="ok">无损</Chip> : null}
                            </span>
                            <span className="audio-format-meta">
                              {f.lossless
                                ? `${f.ext ?? ''} · 不二次损失，适合继续做后期`
                                : `${f.ext ?? ''} · 有损压缩，体积小`}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </Field>

                  {/* 两个选择器：库的 `Picker`（选项多的走菜单、少的走分段控件），
                      外面套我们自己的 `Field`。**`labelHidden` 不能省** ——
                      `Field` 已经把标签显示出来了，再让 `Picker` 显示一遍就是同一个词出现两次。 */}
                  <div className="audio-num-row">
                    <Field label="采样率" hint="目标格式支持的话就跟着改；「保持原样」是不动它。">
                      <Picker
                        label="采样率"
                        labelHidden
                        value={String(settings.sampleRate)}
                        options={SAMPLE_RATES}
                        onValueChange={(v) => patch({ sampleRate: Number(v) })}
                      />
                    </Field>
                    <Field label="声道" hint="单声道体积小一半；做伴奏对轨一般保持立体声。">
                      <Picker
                        label="声道"
                        labelHidden
                        value={String(settings.channels)}
                        options={CHANNELS}
                        onValueChange={(v) => patch({ channels: Number(v) })}
                      />
                    </Field>
                  </div>

                  {settings.action === 'extract' && (
                    <Finding level="info" title="从 MV 里抽出音轨">
                      B 站的音频轨一般是 AAC，转成 WAV 之后再做后期不会二次损失。视频轨会被丢掉。
                    </Finding>
                  )}
                </>
              )}

              {settings.action === 'pitch' && (
                <>
                  <Field
                    label="变调（半音）"
                    hint="正数升调、负数降调；±12 半音以内精度最好。变调靠重采样加时间补偿实现，时长不变。"
                  >
                    <div className="audio-num-row">
                      <GlassStepper
                        aria-label="变调半音数"
                        min={-24}
                        max={24}
                        step={1}
                        value={Number(settings.semitones)}
                        onValueChange={(v) => patch({ semitones: Math.max(-24, Math.min(24, Math.round(v))), nameEdited: false })}
                        formatValue={(v) => `${v > 0 ? '+' : ''}${v} 半音`}
                        shiftMultiplier={1}
                      />
                      <span className="audio-num-note">
                        频率比 ×{ratioValue.toFixed(4)}（
                        {settings.semitones > 0 ? '升调' : settings.semitones < 0 ? '降调' : '还没设置'}）
                      </span>
                    </div>
                  </Field>
                  <div className="audio-presets">
                    {SEMITONE_PRESETS.map((n) => (
                      <Button
                        key={n}
                        size="sm"
                        variant={Number(settings.semitones) === n ? 'primary' : 'default'}
                        onClick={() => patch({ semitones: n, nameEdited: false })}
                      >
                        {n > 0 ? `+${n}` : String(n)}
                      </Button>
                    ))}
                  </div>
                </>
              )}

              {settings.action === 'tempo' && (
                <>
                  <Field
                    label="速度倍率"
                    hint="大于 1 是加速，小于 1 是减速；音高保持不变。超过 2 倍会自动串联处理。"
                  >
                    <div className="audio-num-row">
                      <GlassStepper
                        aria-label="速度倍率"
                        min={0.1}
                        max={10}
                        step={0.05}
                        value={Number(settings.ratio)}
                        onValueChange={(v) => patch({ ratio: Math.max(0.1, Math.min(10, v)), nameEdited: false })}
                        formatValue={(v) => `×${v}`}
                      />
                      <span className="audio-num-note">
                        {Number(settings.ratio) > 1 ? '加速' : Number(settings.ratio) < 1 ? '减速' : '原速'}
                      </span>
                    </div>
                  </Field>
                  <div className="audio-presets">
                    {TEMPO_PRESETS.map((n) => (
                      <Button
                        key={n}
                        size="sm"
                        variant={Number(settings.ratio) === n ? 'primary' : 'default'}
                        onClick={() => patch({ ratio: n, nameEdited: false })}
                      >
                        ×{n}
                      </Button>
                    ))}
                  </div>
                </>
              )}

              {settings.action === 'trim' && (
                <WaveEditor
                  path={input}
                  duration={Number(probe?.durationSec) || 0}
                  usable={!!input && !probeErr}
                  segments={trimState.segments}
                  selected={trimState.selected}
                  onChange={(next, selected) => {
                    setTrimState({ segments: next, selected })
                    const sg = next[selected]
                    if (sg) patch({ startSec: sg.start, endSec: sg.end })
                  }}
                  onExport={(segs, selected) => exportSegments(segs, selected, false)}
                  onExportAll={(segs, selected) => exportSegments(segs, selected, true)}
                  onToast={onToast}
                />
              )}

              {settings.action === 'normalize' && (
                <>
                  <Field label="目标响度（LUFS）" hint={LUFS_DESC[String(settings.targetLufs)] ?? ''}>
                    <GlassSegmentedControl
                      aria-label="目标响度"
                      items={LUFS.map((l) => ({ value: l.value, label: l.label }))}
                      value={String(settings.targetLufs)}
                      onValueChange={(v) => patch({ targetLufs: Number(v) })}
                    />
                  </Field>
                  <Finding level="info" title="响度标准化">
                    用 EBU R128 算法。分离出来的伴奏通常比人声轻，标准化之后对轨会省事很多。
                  </Finding>
                </>
              )}
            </div>
          </div>
        </Panel>

        {/* ── 输出 ── */}
        <Panel>
          <PanelHead
            title="输出"
            desc="不改的话写到系统下载目录"
            extra={
              <Button
                size="sm"
                variant="ghost"
                icon="refresh"
                onClick={() => {
                  const d = dirName(settings.input)
                  if (!d) {
                    onToast('还没选输入文件', 'warn')
                    return
                  }
                  patch({ outDir: d, outDirTouched: true })
                }}
              >
                与输入同目录
              </Button>
            }
          />
          <div className="stack">
            <Field
              label="输出目录"
              hint={
                settings.outDirTouched && settings.outDir
                  ? `已改过；清空后回到默认目录：${defaultOutDir || '（未读取到）'}`
                  : `留空 = 写到这里（设置页可改）：${defaultOutDir || '（未读取到）'}`
              }
            >
              <DirectoryInput
                value={settings.outDir}
                placeholder="留空 = 写到系统下载目录…"
                onChange={(v) => patch({ outDir: v, outDirTouched: !!v })}
              />
            </Field>

            <Field
              label="输出文件名"
              hint="按当前操作自动推断（例如 xxx.wav、xxx_+3半音.wav、xxx_x1.25.wav）；手动改过之后就不再自动覆盖，换操作会重新推断。"
            >
              <TextInput
                value={settings.outName}
                spellCheck={false}
                placeholder="自动按操作推断，例如 xxx_+3半音.wav"
                onChange={(e) => patch({ outName: e.target.value, nameEdited: true })}
              />
            </Field>

            <div className="audio-out-path">
              <span className="audio-out-path-label">将写入：</span>
              <span className={sameAsInput ? 'audio-out-same' : ''}>{output || '（还没确定）'}</span>
              {sameAsInput && <Chip tone="err">不能覆盖输入文件</Chip>}
            </div>

            <p className="muted">当前操作：{opName}</p>
            {fieldErr && <Finding level="warn" title="参数还不完整">{fieldErr}</Finding>}
          </div>
        </Panel>
      </div>

      {/* ══════════════════════ 右：执行 / 结果 / 人声分离 ══════════════════════ */}
      <div className="audio-col">
        <Panel>
          <div className="audio-run">
            <div className="btn-row">
              <Button variant="primary" size="lg" icon="zap" loading={running} onClick={run}>
                开始处理
              </Button>
              <Button
                size="lg"
                icon="folder"
                onClick={() => {
                  const d = dirName(settings.input)
                  if (!d) {
                    onToast('还没选输入文件', 'warn')
                    return
                  }
                  api.fsReveal(d, false).catch((e: unknown) => onToast(errText(e), 'err'))
                }}
              >
                打开输入所在目录
              </Button>
              <Button
                size="lg"
                variant="ghost"
                icon="folder"
                onClick={() => {
                  const d = outDir || dirName(settings.input)
                  if (!d) {
                    onToast('还没有确定输出目录', 'warn')
                    return
                  }
                  api.fsReveal(d, false).catch((e: unknown) => onToast(errText(e), 'err'))
                }}
              >
                打开输出目录
              </Button>
            </div>
            <p className="hint audio-run-note">
              处理在本机由 ffmpeg 完成，不联网、不上传；大文件会花点时间，进度和日志实时显示。
              裁剪时这个按钮导出「当前选中的那一段」，要一次导出全部就在下面的分段列表里点「全部导出」。
            </p>
          </div>

          <JobProgress
            job={job}
            title={jobLabel}
            onCancel={(id) => {
              api.cancelJob(id).catch((e: unknown) => onToast(`取消失败：${errText(e)}`, 'err'))
            }}
          />

          {runErr && (
            <Finding level="warn" title="处理失败">
              {runErr}
            </Finding>
          )}

          {result && job?.status === 'done' && (
            <div className="audio-result">
              <div className="audio-result-head">
                <Icon name="check" size={16} />
                <span className="audio-result-name">
                  {result.action === 'trim' ? '裁剪完成' : '处理完成'}
                </span>
                <Chip>{OPS.find((o) => o.id === result.action)?.name ?? result.action}</Chip>
              </div>
              <span className="audio-result-path">{result.output}</span>
              <div className="btn-row">
                <Button
                  size="sm"
                  variant="primary"
                  icon="play"
                  onClick={() => api.fsOpen({ path: result.output }).catch((e: unknown) => onToast(errText(e), 'err'))}
                >
                  打开文件
                </Button>
                <Button
                  size="sm"
                  icon="folder"
                  onClick={() => api.fsReveal(result.output, true).catch((e: unknown) => onToast(errText(e), 'err'))}
                >
                  在资源管理器中显示
                </Button>
                <Button
                  size="sm"
                  icon="refresh"
                  onClick={() => {
                    setInput(result.output)
                    onToast('已把处理结果设为新的输入', 'ok')
                  }}
                >
                  用这个结果继续处理
                </Button>
              </div>
            </div>
          )}
          {result && job?.status !== 'done' && (
            /* 上一轮的结果还在，但这次的任务没跑完 —— 仍然让用户能定位到那个文件 */
            <div className="audio-result">
              <span className="audio-result-path">上次结果：{result.output}</span>
              <Button size="sm" icon="folder" onClick={() => api.fsReveal(result.output, true).catch((e: unknown) => onToast(errText(e), 'err'))}>
                在资源管理器中显示
              </Button>
            </div>
          )}
        </Panel>

        <SeparationCard state={state} onNavigate={onNavigate} onToast={onToast} />
        <TipsCard />
      </div>

      {/* ── 本机文件选择器（选文件，不是选目录）── */}
      <MediaPicker
        open={picking}
        onOpenChange={setPicking}
        initialDir={dirName(settings.input) || settings.lastDir || defaultOutDir}
        onPick={setInput}
      />
    </div>
  )
}

/* ══════════════════════════════════════════════════════════ 波形编辑器 ══ */

/** 一段选区（秒）。**数据模型只有分段** —— 选区就是「当前选中的那段」 */
interface Seg {
  start: number
  end: number
}

/** 画布逻辑尺寸（CSS 像素）：上面 20px 时间轴 + 下面 100px 波形 */
const RULER_H = 20
const WAVE_H = 100
const CANVAS_H = RULER_H + WAVE_H
/** 包络分辨率：2ms 一个桶 */
const PEAKS_PER_SEC = 500
/** 超过 20 分钟不画波形 —— `decodeAudioData` 会把整段 PCM 解进内存（见 `loadPeaks`） */
const MAX_DECODE_SEC = 1200
/** 把手的命中半径（px） */
const HIT = 7
/** 最短分段（秒），比这更短的切 / 拖都不给 */
const MIN_SEG = 0.05
const UNDO_MAX = 20

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** 波形包的读取地址（后端 `/api/fs/raw`，支持 Range） */
const rawUrl = (path: string) => `/api/fs/raw?path=${encodeURIComponent(path)}`

/**
 * 取回文件并算出波形包络（`[min0,max0,min1,max1,…]`，每桶 2ms）。
 *
 * ponytail: 解码是同步的 O(n)，而且 `decodeAudioData` 先把整段 PCM 解到内存
 * （20 分钟立体声 44.1kHz ≈ 423MB Float32），所以超过 `MAX_DECODE_SEC` 直接不画，
 * 其余功能（选段、分段、导出）照常可用。真要支持更长的文件，让后端加一条
 * 「ffmpeg 输出 8kHz 单声道 WAV」的路由，前端只解码那个小文件。
 */
async function loadPeaks(url: string, durationSec: number): Promise<Float32Array> {
  if (durationSec > MAX_DECODE_SEC) {
    throw new Error(`文件超过 ${MAX_DECODE_SEC / 60} 分钟，为省内存不画波形`)
  }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`读不到音频数据（HTTP ${res.status}）`)
  const raw = await res.arrayBuffer()
  const Ctx = window.AudioContext
  if (!Ctx) throw new Error('这个环境不提供音频解码')
  const ac = new Ctx()
  try {
    const buf = await ac.decodeAudioData(raw)
    return computePeaks(buf)
  } finally {
    /* 不关掉会一直占着一个音频输出设备，开几次就「设备被占用」 */
    void ac.close().catch(() => {})
  }
}

/** 混单声道 + 分桶 min/max。只留包络不留 PCM（20 分钟 ≈ 4.8MB） */
function computePeaks(buf: AudioBuffer): Float32Array {
  const channels: Float32Array[] = []
  for (let c = 0; c < buf.numberOfChannels; c += 1) channels.push(buf.getChannelData(c))
  const len = buf.length
  const buckets = Math.max(1, Math.ceil((len / buf.sampleRate) * PEAKS_PER_SEC))
  const perBucket = len / buckets
  const peaks = new Float32Array(buckets * 2)
  for (let b = 0; b < buckets; b += 1) {
    const from = Math.floor(b * perBucket)
    const to = Math.min(len, Math.floor((b + 1) * perBucket))
    let lo = 0
    let hi = 0
    for (let i = from; i < to; i += 1) {
      let v = 0
      for (const data of channels) v += data[i]
      v /= channels.length || 1
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    peaks[b * 2] = lo
    peaks[b * 2 + 1] = hi
  }
  return peaks
}

/** 从库 / 我们自己的令牌里取画布用的颜色。**canvas 认不了 CSS 变量，只能取出来用** */
function palette(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement)
  const v = (name: string, fallback: string) => cs.getPropertyValue(name).trim() || fallback
  const separator = v('--lg-separator', 'rgba(127,127,127,0.25)')
  const accent = v('--lg-accent', '#39c5bb')
  return {
    grid: separator,
    wave: v('--lg-label-secondary', '#8a8f98'),
    waveSel: accent,
    accent,
    line: accent,
    selBg: `color-mix(in srgb, ${accent} 14%, transparent)`,
    playhead: v('--lg-pink', accent),
    text: v('--lg-label-tertiary', '#8a8f98'),
    /** 没波形时那条中轴线 */
    axis: separator,
  }
}

/**
 * 波形编辑器 —— 旧前端 `components/waveEditor.js` 的**简化版**。
 *
 * ## 简化了什么（有意，不是漏做）
 *
 * | 旧实现 | 这里 | 为什么可以省 |
 * |---|---|---|
 * | Ctrl+滚轮缩放、拖动平移（`viewStart` / `viewSpan` 两套坐标） | **整段适应窗口**，坐标只有一套 | 一屏看全整段；裁剪靠拖把手 + 输入框，缩放是加分项不是必需 |
 * | 空格播放、播放头 rAF 逐帧重画、只播放选区 | `<audio controls>` 原生播放器 + `timeupdate` 对齐播放头 | 播放本身交给浏览器控件；省掉 rAF 循环和一套播放状态 |
 * | 工具栏「适应窗口 / ± / 在播放头切开 / 撤销 / 只播放选区」 | 保留「剪刀模式 / 在播放头切开 / 撤销」三个 | 缩放相关的三个按键随缩放一起去掉 |
 *
 * ## 没省的（裁剪这件事本身）
 *
 * 波形包络（2ms 一档）、时间轴刻度、分段底色、可拖两端把手、点一下跳转、
 * 剪刀切开、分段列表（选中 / 导出 / 删除）、整段还原、撤销、起点终点输入框双向同步、
 * `S` 切开 / `Ctrl+Z` 撤销 / `Delete` 删段，以及「画不出波形也能剪」的兜底提示 ——
 * 全部保留（`waveEditor.js` 的注释里那句「没波形也要能剪」是硬要求）。
 */
function WaveEditor({
  path,
  duration,
  usable,
  segments,
  selected,
  onChange,
  onExport,
  onExportAll,
  onToast,
}: {
  path: string
  duration: number
  /** 有素材、且探测没报错，才去解码（解码失败不影响选段和导出） */
  usable: boolean
  segments: Seg[]
  selected: number
  onChange: (segments: Seg[], selected: number) => void
  onExport: (segments: Seg[], selected: number) => void
  onExportAll: (segments: Seg[], selected: number) => void
  onToast: (msg: string, tone?: 'ok' | 'err' | 'warn' | 'info') => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const audioRef = useRef<HTMLAudioElement>(null)
  const [peaks, setPeaks] = useState<Float32Array | null>(null)
  const [note, setNote] = useState('')
  const [decoding, setDecoding] = useState(false)
  const [scissors, setScissors] = useState(false)
  const [playhead, setPlayhead] = useState(0)
  const [history, setHistory] = useState<Seg[][]>([])
  const [startText, setStartText] = useState(() => formatTimecode(segments[selected]?.start ?? 0))
  const [endText, setEndText] = useState(() => formatTimecode(segments[selected]?.end ?? 0))
  const [size, setSize] = useState({ w: 600, h: CANVAS_H })

  const drag = useRef<{ kind: 'start' | 'end' } | null>(null)
  /** 已经试过解码的素材：失败的不要每次 `onChange` 都重试一遍 */
  const loaded = useRef('')

  const url = usable && path ? rawUrl(path) : ''
  const sg = segments[selected] ?? { start: 0, end: 0 }

  /* 回调放进 ref：父组件每次渲染都会给新函数，直接进依赖会导致反复解码 */
  const cb = useRef({ onChange, onToast })
  cb.current = { onChange, onToast }

  /* ── 换素材：解码波形（分段由父组件按素材重置）── */
  useEffect(() => {
    if (!url || !duration || loaded.current === url) return
    loaded.current = url
    let alive = true
    setDecoding(true)
    setNote('')
    void loadPeaks(url, duration)
      .then((p) => {
        if (alive) setPeaks(p)
      })
      .catch((e: unknown) => {
        if (!alive) return
        setPeaks(null)
        setNote(errText(e))
      })
      .finally(() => {
        if (alive) setDecoding(false)
      })
    return () => {
      alive = false
    }
  }, [url, duration])

  /* 素材换了就清掉包络（新素材还没解码出来之前不该画旧波形） */
  useEffect(() => {
    setPeaks(null)
    setNote('')
    setHistory([])
  }, [url])

  /**
   * 素材（或它的时长）变了 → 把分段对齐到整段文件。
   *
   * ⚠️ **这一步不能省。** 分段状态在页面那一层，波形编辑器只是被挂载 / 卸载；
   * 少了它，换文件之后分段仍然是上一个文件留下的（新文件是 `0-0`，导出的是一段空音频）。
   * 旧实现的 `setSource()` 就在做这件事（新素材重置成 `[0, duration]`，
   * 同素材只是重新夹一遍范围）。
   *
   * 只在**素材真的变了**的时候重置：否则父组件每次把新的数组引用回传（拖动把手的回声）
   * 都会把用户拉好的选区弹回整段。
   */
  const seeded = useRef('')
  useEffect(() => {
    if (!usable || !path || !duration) {
      if (!path) seeded.current = ''
      return
    }
    if (seeded.current !== path) {
      seeded.current = path
      const next = [{ start: 0, end: duration }]
      setHistory([])
      cb.current.onChange(next, 0)
      return
    }
    /* 同一个素材：时长可能后到（先探测后解码），把越界的端点夹回文件范围内 */
    let changed = false
    const next = segments.map((s) => {
      const start = clamp(s.start, 0, duration)
      const end = clamp(s.end, start, duration)
      if (start !== s.start || end !== s.end) changed = true
      return changed ? { start, end } : s
    })
    if (changed) cb.current.onChange(next, selected)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, duration, usable])

  /* ── 输入框跟着选中段走（正在输入的那一框别抢）── */
  useEffect(() => {
    if ((document.activeElement as HTMLElement | null)?.dataset.waveInput === 'start') return
    setStartText(formatTimecode(sg.start))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sg.start])
  useEffect(() => {
    if ((document.activeElement as HTMLElement | null)?.dataset.waveInput === 'end') return
    setEndText(formatTimecode(sg.end))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sg.end])

  /* ── 画布尺寸：跟着容器宽度走，dpr 上限 2 ── */
  useEffect(() => {
    const el = canvasRef.current
    const host = el?.parentElement
    if (!el || !host) return
    const measure = () => {
      const w = Math.max(200, host.clientWidth || 600)
      const dpr = Math.min(2, window.devicePixelRatio || 1)
      const c = canvasRef.current
      if (!c) return
      c.width = Math.round(w * dpr)
      c.height = Math.round(CANVAS_H * dpr)
      c.style.height = `${CANVAS_H}px`
      const ctx = c.getContext('2d')
      ctx?.setTransform(dpr, 0, 0, dpr, 0, 0)
      setSize({ w, h: CANVAS_H })
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(host)
    return () => ro.disconnect()
  }, [])

  /* ── 重画 ──
     依赖里带上 size：换主题时 `GlassProvider` 会写 `data-lg-theme`，`palette()` 每次重取，
     这里靠 `themeTick` 触发一次重画（canvas 拿不到 CSS 变量，只能重取）。 */
  const themeTick = useCanvasThemeTick()
  useEffect(() => {
    const el = canvasRef.current
    const ctx = el?.getContext('2d')
    if (!el || !ctx) return
    const w = size.w
    const P = palette()
    ctx.clearRect(0, 0, w, CANVAS_H)

    /* 时间轴 */
    ctx.fillStyle = P.text
    ctx.font = '10px ui-monospace, Consolas, monospace'
    ctx.textBaseline = 'middle'
    const span = duration || 1
    const step = tickStep(span, w)
    ctx.strokeStyle = P.grid
    for (let t = 0; t <= span; t += step) {
      const x = Math.round((t / span) * w) + 0.5
      ctx.beginPath()
      ctx.moveTo(x, RULER_H - 5)
      ctx.lineTo(x, RULER_H)
      ctx.stroke()
      if (x > 2 && x < w - 34) ctx.fillText(formatTimecode(t).replace(/\.\d+$/, ''), x + 3, RULER_H / 2)
    }
    ctx.beginPath()
    ctx.moveTo(0, RULER_H + 0.5)
    ctx.lineTo(w, RULER_H + 0.5)
    ctx.stroke()

    /* 选中段的底色 */
    const xOf = (t: number) => (t / span) * w
    if (segments[selected]) {
      ctx.fillStyle = P.selBg
      ctx.fillRect(xOf(sg.start), RULER_H, Math.max(1, xOf(sg.end) - xOf(sg.start)), WAVE_H)
    }

    /* 波形：逐像素列取这一列覆盖的所有桶的 min/max */
    const mid = RULER_H + WAVE_H / 2
    const half = WAVE_H / 2 - 3
    const total = peaks ? peaks.length / 2 : 0
    if (!peaks) {
      /* 没波形也要能剪：画一条中轴线，剩下的交互一个不少 */
      ctx.strokeStyle = P.axis
      ctx.beginPath()
      ctx.moveTo(0, mid + 0.5)
      ctx.lineTo(w, mid + 0.5)
      ctx.stroke()
    } else {
      for (let x = 0; x < w; x += 1) {
        const t0 = (x / w) * span
        const t1 = ((x + 1) / w) * span
        let b0 = clamp(Math.floor(t0 * PEAKS_PER_SEC), 0, Math.max(0, total - 1))
        const b1 = clamp(Math.max(b0 + 1, Math.ceil(t1 * PEAKS_PER_SEC)), b0 + 1, total)
        let lo = 0
        let hi = 0
        for (let b = b0; b < b1; b += 1) {
          if (peaks[b * 2] < lo) lo = peaks[b * 2]
          if (peaks[b * 2 + 1] > hi) hi = peaks[b * 2 + 1]
        }
        ctx.fillStyle = t0 >= sg.start && t0 <= sg.end ? P.waveSel : P.wave
        const yTop = mid - hi * half
        const yBot = mid - lo * half
        ctx.fillRect(x, yTop, 1, Math.max(1, yBot - yTop))
      }
    }

    /* 分段边界 + 选中段的把手 */
    segments.forEach((s, i) => {
      ctx.strokeStyle = i === selected ? P.line : P.grid
      ctx.lineWidth = i === selected ? 2 : 1
      for (const x of [xOf(s.start), xOf(s.end)]) {
        if (x < -2 || x > w + 2) continue
        const px = Math.round(x) + 0.5
        ctx.beginPath()
        ctx.moveTo(px, RULER_H)
        ctx.lineTo(px, CANVAS_H)
        ctx.stroke()
      }
      ctx.lineWidth = 1
      if (i === selected) {
        ctx.fillStyle = P.accent
        for (const x of [xOf(s.start), xOf(s.end)]) {
          const px = clamp(x, 3, w - 3)
          ctx.fillRect(px - 3, RULER_H, 6, 7)
          ctx.fillRect(px - 3, CANVAS_H - 7, 6, 7)
        }
      }
    })

    /* 播放头 */
    if (duration) {
      const x = Math.round(xOf(playhead)) + 0.5
      if (x >= 0 && x <= w) {
        ctx.strokeStyle = P.playhead
        ctx.lineWidth = 2
        ctx.beginPath()
        ctx.moveTo(x, RULER_H)
        ctx.lineTo(x, CANVAS_H)
        ctx.stroke()
        ctx.lineWidth = 1
      }
    }
  }, [peaks, segments, selected, sg.start, sg.end, size, duration, playhead, themeTick])

  /* ── 分段操作 ── */

  const pushHistory = () =>
    setHistory((h) => [...h, segments.map((s) => ({ ...s }))].slice(-UNDO_MAX))

  const splitAt = (t: number) => {
    if (!duration) {
      onToast('还没拿到文件时长，没法分段', 'warn')
      return
    }
    const i = segments.findIndex((s) => t > s.start + MIN_SEG && t < s.end - MIN_SEG)
    if (i < 0) {
      onToast('这个位置切不了：不在任何分段里，或者离端点太近', 'warn')
      return
    }
    pushHistory()
    const s = segments[i]
    const next = [...segments]
    next.splice(i, 1, { start: s.start, end: t }, { start: t, end: s.end })
    onChange(next, i + 1)
  }

  const removeSegment = (i: number) => {
    if (segments.length <= 1) {
      onToast('只剩一段了，删掉就没有可导出的内容', 'warn')
      return
    }
    pushHistory()
    const next = segments.filter((_, n) => n !== i)
    onChange(next, clamp(selected, 0, next.length - 1))
  }

  const undo = () => {
    if (!history.length) {
      onToast('没有可撤销的操作', 'warn')
      return
    }
    const prev = history[history.length - 1]
    setHistory((h) => h.slice(0, -1))
    onChange(prev, clamp(selected, 0, prev.length - 1))
  }

  /**
   * 第 i 段的可动范围：被左右邻居夹住。
   * 分段是文件的一个划分，重叠了「全部导出」就会导出两遍同一段音频。
   */
  const segMin = (i: number) => (i > 0 ? segments[i - 1].end : 0)
  const segMax = (i: number) => (i < segments.length - 1 ? segments[i + 1].start : duration || Number.POSITIVE_INFINITY)

  const setSegment = (i: number, start: number, end: number) => {
    const s = segments[i]
    if (!s) return
    if (!duration) {
      /* 时长未知：填多少算多少，只保证 start ≤ end */
      let a = Number.isFinite(start) ? Math.max(0, start) : s.start
      let b = Number.isFinite(end) ? Math.max(0, end) : s.end
      if (b < a) [a, b] = [b, a]
      const next = segments.map((x, n) => (n === i ? { start: a, end: b } : x))
      onChange(next, i)
      return
    }
    const a = Number.isFinite(start) ? clamp(start, segMin(i), s.end - MIN_SEG) : s.start
    const b = Number.isFinite(end) ? clamp(end, a + MIN_SEG, segMax(i)) : s.end
    const next = segments.map((x, n) => (n === i ? { start: a, end: b } : x))
    onChange(next, i)
  }

  /* ── 指针：拖把手 / 点一下跳转 / 剪刀切开 ── */

  const xOfEvent = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const r = e.currentTarget.getBoundingClientRect()
    return e.clientX - r.left
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.button !== 0 || !duration) return
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
      /* 没有指针捕获也能拖，只是拖出画布就断 */
    }
    const x = xOfEvent(e)
    const t = clamp((x / size.w) * duration, 0, duration)

    if (scissors) {
      splitAt(t)
      return
    }
    if (Math.abs(x - (sg.start / duration) * size.w) <= HIT) {
      pushHistory()
      drag.current = { kind: 'start' }
      return
    }
    if (Math.abs(x - (sg.end / duration) * size.w) <= HIT) {
      pushHistory()
      drag.current = { kind: 'end' }
      return
    }
    /* 点在别的分段上 = 选中它；否则跳转播放头 */
    const hit = segments.findIndex((s) => t >= s.start && t <= s.end)
    if (hit >= 0 && hit !== selected) {
      onChange(segments, hit)
      return
    }
    seek(t)
  }

  /** 悬停给左右箭头提示；按下拖动时改选中段的两端 */
  const hoverOrDrag = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!duration) return
    const x = xOfEvent(e)
    if (!drag.current) {
      const near =
        Math.abs(x - (sg.start / duration) * size.w) <= HIT ||
        Math.abs(x - (sg.end / duration) * size.w) <= HIT
      e.currentTarget.dataset.handle = near && !scissors ? 'true' : 'false'
      return
    }
    const t = clamp((x / size.w) * duration, 0, duration)
    const i = selected
    if (drag.current.kind === 'start') setSegment(i, clamp(t, segMin(i), sg.end - MIN_SEG), sg.end)
    else setSegment(i, sg.start, clamp(t, sg.start + MIN_SEG, segMax(i)))
  }

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drag.current) return
    drag.current = null
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* 上面没捕获成功，这里也就没得释放 */
    }
  }

  const seek = (t: number) => {
    const audio = audioRef.current
    const end = duration || audio?.duration || t
    const at = clamp(t, 0, end)
    setPlayhead(at)
    if (audio) {
      try {
        audio.currentTime = at
      } catch {
        /* 元数据还没到，先把播放头画过去 */
      }
    }
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).matches('input, textarea')) return
    if (e.ctrlKey || e.metaKey) {
      if (e.key.toLowerCase() === 'z') {
        e.preventDefault()
        undo()
      }
      return
    }
    if (e.key.toLowerCase() === 's') splitAt(playhead)
    else if (e.key === 'Delete') removeSegment(selected)
  }

  /* ── 输入框 → 分段 ── */

  const applyText = (which: 'start' | 'end') => {
    const raw = which === 'start' ? startText : endText
    const sec = parseTimecode(raw)
    if (sec === null) {
      onToast('时间看不懂。写成 1:23.456 这样（也可以只写 83）', 'warn')
      setStartText(formatTimecode(sg.start))
      setEndText(formatTimecode(sg.end))
      return
    }
    setSegment(selected, which === 'start' ? sec : sg.start, which === 'end' ? sec : sg.end)
  }

  /* ── 提示行 ── */

  let noteText: string
  let noteTone: 'dim' | 'warn' = 'dim'
  if (decoding) {
    noteText = '正在解码波形…'
  } else if (!url) {
    noteText = '选好文件后这里会显示波形：点波形跳转、拖两端把手裁剪、剪刀切开、分段导出。'
  } else if (note) {
    noteText = `${note}；仍然可以选段、分段、导出，只是看不见波形。`
    noteTone = 'warn'
  } else if (peaks) {
    noteText = `波形 2ms 一档；拖两端把手裁剪、点一下跳到那里、剪刀模式点波形切开。总长 ${formatDuration(duration)}。`
  } else {
    noteText = '还没有拿到可画的波形，选段、分段、导出照常可用。'
  }

  return (
    <div className="wave-editor" onKeyDown={onKeyDown}>
      <div className="wave-toolbar">
        <Button
          size="sm"
          variant={scissors ? 'primary' : 'default'}
          icon="scissors"
          title="点一下进入剪刀模式，再点波形就在那里切开"
          onClick={() => setScissors((v) => !v)}
        >
          剪刀
        </Button>
        <Button size="sm" title="在播放头的位置切开" onClick={() => splitAt(playhead)}>
          在播放头切开
        </Button>
        <Button size="sm" variant="ghost" icon="refresh" disabled={!history.length} title="撤销上一次切开或删除" onClick={undo}>
          撤销
        </Button>
        <span className="spacer" />
        <span className="hint">{`共 ${segments.length} 段`}</span>
      </div>

      <canvas
        ref={canvasRef}
        className="wave-canvas"
        tabIndex={0}
        data-scissors={scissors ? 'true' : undefined}
        aria-label="波形与分段；S 在播放头切开、Ctrl+Z 撤销、Delete 删除当前段"
        onPointerDown={onPointerDown}
        onPointerMove={hoverOrDrag}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />

      <audio
        ref={audioRef}
        className="wave-audio"
        controls
        preload="metadata"
        src={url || undefined}
        onTimeUpdate={(e) => setPlayhead(e.currentTarget.currentTime)}
        onEnded={() => setPlayhead(sg.end)}
      />

      <div className="wave-note" data-tone={noteTone}>
        {noteText}
      </div>

      <div className="wave-times">
        <span className="audio-num-note">起点 / 终点</span>
        <input
          className="input wave-time-input"
          data-wave-input="start"
          value={startText}
          spellCheck={false}
          title="支持 83 / 1:23 / 1:23.456 / 1:02:03"
          onChange={(e) => setStartText(e.target.value)}
          onBlur={() => applyText('start')}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
        <span className="audio-num-note">→</span>
        <input
          className="input wave-time-input"
          data-wave-input="end"
          value={endText}
          spellCheck={false}
          title="支持 83 / 1:23 / 1:23.456 / 1:02:03"
          onChange={(e) => setEndText(e.target.value)}
          onBlur={() => applyText('end')}
          onKeyDown={(e) => {
            if (e.key === 'Enter') e.currentTarget.blur()
          }}
        />
        <Button
          size="sm"
          variant="ghost"
          title="把选区拉回整个文件"
          disabled={!duration}
          onClick={() => setSegment(selected, 0, duration)}
        >
          整段
        </Button>
        <span className="spacer" />
        <span className="audio-num-note">
          {`${formatDuration(Math.max(0, sg.end - sg.start))} · 共 ${segments.length} 段`}
        </span>
      </div>

      <p className="hint">
        时间按「分:秒.毫秒」填，例如 1:23.456（直接写 83 也认）。
        拖波形两端的把手裁剪，和输入框双向同步：拖完框里会变，改完框里波形跟着动。
        剪刀模式下点波形等于在那里切开；快捷键 S = 在播放头切开，Ctrl+Z 撤销，Delete 删除选中段。
        裁剪结果固定导出 WAV。
      </p>

      {segments.length > 1 && (
        <div className="wave-segments">
          <div className="wave-seg-head">
            <span>{`共 ${segments.length} 段，点一行选中它，再按「导出」单独导出`}</span>
            <span className="spacer" />
            <Button size="sm" variant="primary" icon="download" onClick={() => onExportAll(segments, selected)}>
              {`全部导出（${segments.length} 段）`}
            </Button>
          </div>
          {segments.map((s, i) => (
            <div
              key={`${s.start}-${s.end}-${i}`}
              className="wave-seg-row"
              data-selected={i === selected ? 'true' : undefined}
              onClick={() => onChange(segments, i)}
            >
              <span className="wave-seg-index">{i + 1}</span>
              <span className="wave-seg-time">{`${formatTimecode(s.start)} → ${formatTimecode(s.end)}`}</span>
              <span className="wave-seg-dur">{formatDuration(s.end - s.start)}</span>
              <span className="spacer" />
              <Button
                size="sm"
                onClick={(e) => {
                  e.stopPropagation()
                  onExport(segments, i)
                }}
              >
                导出
              </Button>
              <IconButton
                label={`删除第 ${i + 1} 段`}
                icon="trash"
                size="sm"
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation()
                  removeSegment(i)
                }}
              />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** 主题变了就 +1 —— 画布的调色板要重取（canvas 读不到 CSS 变量） */
function useCanvasThemeTick(): number {
  const [tick, setTick] = useState(0)
  useEffect(() => {
    const obs = new MutationObserver(() => setTick((t) => t + 1))
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-lg-theme', 'data-theme'],
    })
    return () => obs.disconnect()
  }, [])
  return tick
}

/** 时间轴刻度间隔：挑一个让标签不至于挤在一起的值 */
function tickStep(viewSpan: number, width: number): number {
  const target = (viewSpan / Math.max(1, width)) * 70 /* 每 70px 一个标签 */
  for (const step of [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800]) {
    if (step >= target) return step
  }
  return 3600
}

/* ══════════════════════════════════════════════════════ 人声分离 / 流程 ══ */

function SeparationCard({
  state,
  onNavigate,
  onToast,
}: {
  state: PageProps['state']
  onNavigate: (id: string) => void
  onToast: (msg: string, tone?: 'ok' | 'err' | 'warn' | 'info') => void
}) {
  const editors = (state?.editors ?? []) as EditorInfo[]
  const uvr = editors.find((e) => e.id === 'uvr')
  const installed = !!uvr?.installed

  const openUrl = (url: string) => {
    api.fsOpen({ url }).catch((e: unknown) => onToast(`打开浏览器失败：${errText(e)}`, 'err'))
  }

  const launchUvr = async (path: string) => {
    try {
      await api.launch({ path })
      onToast('已启动 Ultimate Vocal Remover', 'ok')
    } catch (e) {
      onToast(`启动失败：${errText(e)}`, 'err')
    }
  }

  return (
    <Panel>
      <PanelHead title="人声分离" desc="把人声和伴奏拆开，再拿回来继续做" />
      <div className="stack-lg">
        <div className="stack">
          <div className="audio-sep-row">
            <span className="audio-sep-title">在线：MVSEP</span>
            <span className="spacer" />
            <Chip tone="warn">需上传文件</Chip>
          </div>
          <Finding level="warn" title="隐私提示">
            在线服务需要把音频上传到对方服务器才能处理。介意的话用下面的离线方案（UVR），音频不出本机。
          </Finding>
          <div className="audio-sep-row">
            <Button icon="external" onClick={() => openUrl(MVSEP_URL)}>
              打开 MVSEP 网站
            </Button>
            <span className="audio-url">{MVSEP_URL}</span>
          </div>
          <p className="hint">
            MVSEP 支持人声/伴奏、鼓/贝斯等多轨分离，有免费额度。上传前可以先用「裁剪片段」截出要用的部分，
            省流量也省时间。
          </p>
        </div>

        <div className="audio-divider" />

        {installed ? (
          <div className="stack">
            <div className="audio-sep-row">
              <span className="audio-sep-title">离线：Ultimate Vocal Remover</span>
              <span className="spacer" />
              <Chip tone="ok">已安装</Chip>
            </div>
            <span className="audio-sep-path" title={uvr?.path ?? ''}>
              {uvr?.path ?? ''}
            </span>
            <div className="audio-sep-row">
              <Button
                variant="primary"
                icon="play"
                onClick={() => {
                  if (uvr?.path) void launchUvr(uvr.path)
                }}
              >
                启动 UVR
              </Button>
              <Button
                size="sm"
                variant="ghost"
                icon="folder"
                onClick={() =>
                  api.fsReveal(uvr?.path ?? '', true).catch((e: unknown) => onToast(errText(e), 'err'))
                }
              >
                定位文件
              </Button>
            </div>
            <p className="hint">
              在 UVR 里选 MDX-Net 或 Demucs 模型分离，导出的人声 / 伴奏可以直接拖回本页继续变调、转 WAV。
            </p>
          </div>
        ) : (
          <div className="stack">
            <div className="audio-sep-row">
              <span className="audio-sep-title">离线：Ultimate Vocal Remover</span>
              <span className="spacer" />
              <Chip>未检测到</Chip>
            </div>
            <Finding level="info" title="建议装一个 UVR">
              免费开源的离线分离工具，音频不出本机。装好之后如果没被自动认出来，
              可以在「设置 → 自定义程序」里手动指定 UVR.exe 的路径。
            </Finding>
            <div className="btn-row">
              <Button size="sm" icon="gear" onClick={() => onNavigate('settings')}>
                去设置里指定路径
              </Button>
            </div>
          </div>
        )}
      </div>
    </Panel>
  )
}

function TipsCard() {
  return (
    <Panel>
      <PanelHead title="顺手流程" desc="从 MV 到能干活的伴奏" />
      <div className="stack">
        <pre className="job-log">{[
          '1. 视频解析 → 下载 MV（或只下音频）',
          '2. 这里「提取音频」→ 导出 WAV',
          '3. UVR 离线分离 → 人声 / 伴奏',
          '4. 「变调」把伴奏对到你的音域',
          '5. 「响度标准化」让两边音量接近',
          '6. 导出 WAV，拿去编辑器里继续做',
        ].join('\n')}</pre>
        <p className="hint">
          顺序只是建议：先在 UVR 里分离、再变调，通常比先变调再分离更干净（模型对原调更敏感）。
        </p>
      </div>
    </Panel>
  )
}

/* ══════════════════════════════════════════════════════ 本机文件选择器 ══ */

/**
 * 挑一个音频 / 视频文件 —— 旧页面的 `pickDirectory({ mode: 'file', exts })`。
 *
 * `components/DirPicker.tsx` 只选目录（后端 `files=0`），所以这里用同一套库组件
 * （`GlassDialog` + `PathBar` + `List`）再拼一个选文件的：`api.fsList(dir, { files: true, exts })`。
 * 样式复用 `index.css` 里那组 `.dir-*`（目录选择器已经在用的类），不再另写一套
 * —— 和 `pages/Convert.tsx` 的 `FilePicker` 是同一个做法。
 */
function MediaPicker({
  open,
  onOpenChange,
  onPick,
  initialDir,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (path: string) => void
  initialDir: string
}) {
  const [cwd, setCwd] = useState('')
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [roots, setRoots] = useState<{ name: string; path: string }[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = async (path: string) => {
    setBusy(true)
    setErr(null)
    try {
      const data = await api.fsList(path, { files: true, exts: [...MEDIA_EXTS] })
      setCwd(data.path)
      setEntries(data.entries)
    } catch (e) {
      setErr(errText(e))
    } finally {
      setBusy(false)
    }
  }

  const started = useRef(false)
  useEffect(() => {
    if (!open) {
      started.current = false
      return
    }
    if (started.current) return
    started.current = true
    api
      .fsRoots()
      .then((d) => {
        setRoots(d.roots)
        void load(initialDir)
      })
      .catch((e: unknown) => setErr(errText(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  const segments = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean)
  const dirs = entries.filter((e) => e.dir)
  const files = entries.filter((e) => !e.dir)

  return (
    <GlassDialog
      open={open}
      onOpenChange={onOpenChange}
      title="选择音频 / 视频文件"
      description="点进子目录，然后点一个音频或视频文件"
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
              onSelect: i === segments.length - 1 ? undefined : () => void load(segments.slice(0, i + 1).join('\\')),
            })),
          ]}
        />

        {roots.length > 0 && (
          <List className="dir-roots">
            {roots.map((r) => (
              <ListRow key={r.path} label={r.name} secondaryLabel={r.path} onSelect={() => void load(r.path)} />
            ))}
          </List>
        )}

        <List>
          <ListSection header={busy ? '读取中…' : `${dirs.length} 个子目录`}>
            {dirs.map((e) => (
              <ListRow key={e.path} label={e.name} disclosure onSelect={() => void load(e.path)} />
            ))}
            {!busy && dirs.length === 0 && <ListRow label="（没有子目录）" disabled />}
          </ListSection>
          <ListSection header={`${files.length} 个音频 / 视频文件`}>
            {files.map((e) => (
              <ListRow
                key={e.path}
                label={e.name}
                secondaryLabel={e.size ? formatBytes(e.size) : undefined}
                onSelect={() => {
                  onPick(e.path)
                  onOpenChange(false)
                }}
              />
            ))}
            {!busy && files.length === 0 && (
              <ListRow label="（这个目录里没有音频 / 视频文件）" disabled />
            )}
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

/*
 * ── 与旧实现有意不同的几点 ──────────────────────────────────────────────
 *
 * 1. **探测结果不再是 innerHTML 拼串**：旧实现 `esc()` + `mount()` 手拼 DOM，
 *    这里是一个 `<Chip>` 列表 —— 同样的字段、同样的文案，只是不再拼字符串。
 *
 * 2. **执行按钮的位置**：旧页面把「开始处理」放在左下那张窄卡里（`padding: 14px`），
 *    这里挪到右栏顶部，和进度 / 结果同一列 —— 点了之后眼睛不用来回找。
 *    文案与禁用逻辑一字未改。
 *
 * 3. **少了两个「顺手」按钮的重复**：旧页面在页头有一个「打开输出目录」、
 *    在运行卡里有一个「打开输入所在目录」。这里把两者都放在运行卡里，
 *    并补上「打开输出目录」（页头那组控件在新前端的顶栏里已经不存在了）。
 *
 * 4. **波形编辑器是简化版**：缩放 / 平移 / 空格播放 / 只播放选区 去掉了
 *    （见 `WaveEditor` 头顶那张表），裁剪本身的功能一个不少。
 */
