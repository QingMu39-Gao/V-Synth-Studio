import {useEffect, useRef, useState} from 'react'
import {SegmentedControl, Select, Stepper} from '@/components/ui'
import {api} from '@/lib/api'
import {getConfig, saveConfig} from '@/lib/config'
import {baseName, dirName, errText, extOf, formatBytes, formatDuration, stripExt} from '@/lib/format'
import {joinPath} from '@/lib/ipc'
import {Button} from '@/components/Button'
import {Credit, Upstream} from '@/components/Credit'
import {DirectoryInput} from '@/components/DirPicker'
import {DropHint, useFilePick} from '@/components/FilePick'
import {Field, TextInput} from '@/components/Field'
import {Icon, type IconName} from '@/components/Icon'
import {JobProgress} from '@/components/Job'
import {Chip, Finding, Panel, PanelHead} from '@/components/Panel'
import {type Seg, WaveEditor} from '@/components/WaveEditor'
import {useJob} from '@/lib/useJob'
import type {Job} from '@/lib/types'
import type {PageProps} from './types'
import './Audio.css'
import {useI18n} from '@/lib/i18n'

/**
 * 音频工具。
 *
 * 六种操作全部在本机由 ffmpeg 完成（`api.audioRun` → `useJob` + `<JobProgress>`）：
 * 格式转换 / 提取音频 / 变调 / 变速 / 裁剪片段 / 响度标准化。
 * 参数名是约定的接口形状（`format` `sampleRate` `channels` `semitones` `ratio`
 * `startSec` `endSec` `targetLufs`），后端 `audio_run` 是把 `options` 摊平读的。
 *
 * ⚠️ **这一页不管分离。** 分离整条链在独立页 `pages/Svsep.tsx`（侧栏「音轨分离」）：
 * 离线那条要下模型、跑几十分钟、占 5 GB 内存，和三分钟的 ffmpeg 转格式根本不是
 * 一种东西，挤在一个页面里用户看不出该点哪个。这里只留一张指路卡。
 * `state.editors` 现在是空数组（后端候选表也清空了，见 `tools.rs::candidates`），
 * 别拿它去找 UVR。
 *
 * ffmpeg 缺失时**它随包分发，不引导用户去下载**，
 * 只说明「tools 目录缺失，从压缩包里重新解压」。
 *
 * 三条实现约束：
 *   1. 探测结果用 `<Chip>` 组合，不拼 innerHTML；
 *   2. 输出文件名在「操作 / 格式 / 变调量 / 倍率」变化时重算（名字是手改过的不动）；
 *   3. 波形编辑器是简化版（见 `WaveEditor` 的注释）。
 */

/* ══════════════════════════════════════════════════════════ 常量与设置 ══ */

/**
 * 设置持久化 —— 存在 **`config.json` 的 `audio`** 里。
 * **键名固定，别改** —— `migrate_legacy_settings` 按这个名字搬老设置。
 */
const CFG_KEY = 'audio'

const OPS: { id: string; name: string; desc: string; icon: IconName }[] = [
    {id: 'convert', name: '格式转换', desc: '导出 WAV / FLAC / MP3…', icon: 'swap'},
    {id: 'extract', name: '提取音频', desc: '把 MV / 视频的音轨抽出来', icon: 'film'},
    {id: 'pitch', name: '变调', desc: '按半音升降，时长不变', icon: 'music'},
    {id: 'tempo', name: '变速', desc: '按倍率快慢，音高不变', icon: 'activity'},
    {id: 'trim', name: '裁剪片段', desc: '波形上拖端点、切片分段导出', icon: 'scissors'},
    {id: 'normalize', name: '响度标准化', desc: '伴奏与干声拉到同一响度', icon: 'wave'},
]

const AUDIO_EXTS = ['wav', 'mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma', 'aiff', 'aif', 'ape', 'alac']
/** 文件选择器能挑的：音频 + 常见视频容器（提取音轨时要挑视频） */
const MEDIA_EXTS = new Set([...AUDIO_EXTS, 'mp4', 'mkv', 'flv', 'mov', 'webm', 'avi', 'ts', 'm4v', 'wmv'])

const SEMITONE_PRESETS = [-12, -7, -5, -3, -2, -1, 1, 2, 3, 5, 7, 12]
const TEMPO_PRESETS = [0.5, 0.75, 0.9, 1.1, 1.25, 1.5, 2]

const SAMPLE_RATES = [
    {value: '0', label: '保持原样'},
    {value: '44100', label: '44100 Hz（CD）'},
    {value: '48000', label: '48000 Hz（视频常用）'},
    {value: '22050', label: '22050 Hz（体积小）'},
    {value: '96000', label: '96000 Hz（高采样）'},
]
const CHANNELS = [
    {value: '0', label: '保持原样'},
    {value: '1', label: '单声道'},
    {value: '2', label: '立体声'},
]
/** `targetLufs` → 那句解释（挂在分段控件下面） */
const LUFS = [
    {value: '-9', label: '-9 LUFS'},
    {value: '-14', label: '-14 LUFS'},
    {value: '-16', label: '-16 LUFS'},
    {value: '-23', label: '-23 LUFS'},
] as const
const LUFS_DESC: Record<string, string> = {
    '-9': '很响，适合短视频 / 翻唱投稿',
    '-14': '常用标准，推荐',
    '-16': '保守一点，留动态',
    '-23': '广播标准（EBU R128）',
}

/** 存进配置的那部分设置（不含分段 —— 分段由波形编辑器按当前素材重建） */
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
    const saved = getConfig()[CFG_KEY]
    if (saved && typeof saved === 'object') {
        return {...DEFAULTS, ...(saved as Partial<Settings>)}
    }
    return {...DEFAULTS}
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

/** `state.config` 里这一页读得到的字段 */
interface AudioConfig {
    outputDir?: string
}

/**
 * `api.audioProbe` 的返回。`lib/api.ts` 里那个 `AudioProbe['info']` 只声明了
 * 时长 / 音频 / 视频三样，而后端 `probe_media` 还会给容器、大小、总码率、
 * 以及「ffmpeg 缺失（`available:false`）」「读不出来（`probed:false` + `note`）」
 * 两种状态 —— 这两种都要在界面上画出来，所以这里补全。
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

/** 操作 id → 中文名（进度条标题、结果卡里都要用） */
const opNameFor = (id: string) => OPS.find((o) => o.id === id)?.name ?? id

/** 1 → 单声道、2 → 立体声、其它 → N 声道 */
function channelsText(n: number | undefined): string {
    const c = Number(n)
    if (c === 1) return '单声道'
    if (c === 2) return '立体声'
    return `${c} 声道`
}

/* ══════════════════════════════════════════════════════════════════ 页面 ══ */

export function Audio({state, onNavigate, onToast}: PageProps) {
    const {t} = useI18n()
    const formats = (state?.audioFormats ?? {}) as Record<string, AudioFormat>
    const cfg = (state?.config ?? {}) as AudioConfig
    const ffmpeg = state?.tools?.ffmpeg
    const ffmpegOk = ffmpeg?.available === true
    const defaultOutDir = state?.paths?.outputDir ?? cfg.outputDir ?? ''

    const [settings, setSettings] = useState<Settings>(loadSettings)
    const [probe, setProbe] = useState<ProbeInfo | null>(null)
    const [probeErr, setProbeErr] = useState('')
    const [probing, setProbing] = useState(false)
    const [result, setResult] = useState<{ action: string; output: string } | null>(null)
    const [runErr, setRunErr] = useState('')
    /** 提交前的参数问题（要留在字段上，不能只弹个 toast 就没了） */
    const [fieldErr, setFieldErr] = useState('')
    /** 进度条的标题：多段导出时带上「第 n / m 段」 */
    const [jobLabel, setJobLabel] = useState('处理进度')
    /** 连点「开始处理」会提交两个任务，第二个把第一个顶掉。这个标志从按下起保持到
        后端第一帧任务快照到达 —— `start()` 会先把 `job` 清成 null，光看 `job?.status`
        挡不住这段空窗，多段导出的段间空档同理。 */
    const [submitting, setSubmitting] = useState(false)

    /**
     * 裁剪的分段**放在页面这一层**，不放波形编辑器内部：切到别的操作再切回来时，
     * 编辑器会重新挂载，分段放在里面就没了。状态提上来才能活过重新挂载
     * （惰性初值从设置里恢复上次的选区）。
     */
    const [trimState, setTrimState] = useState<{ segments: Seg[]; selected: number }>(() => {
        const s0 = Math.max(0, Number(settings.startSec) || 0)
        const e0 = Math.max(s0, Number(settings.endSec) || 0)
        return {segments: [{start: s0, end: e0}], selected: 0}
    })

    /** 已探测过的路径 → 结果。点「重新读取」才会重探 */
    const probeCache = useRef(new Map<string, ProbeInfo | { error: string }>())

    const {job, start} = useJob()

    /* 提交成功后 `start()` 把 `job` 清成 null，第一帧快照到达前 `job?.status` 什么都不是；
       快照带着任一状态就说明守卫可以交回给 `job?.status` 了。 */
    useEffect(() => {
        if (job?.status) setSubmitting(false)
    }, [job?.status])

    const patch = (p: Partial<Settings>) => setSettings((s) => ({...s, ...p}))

    /**
     * 支持 `#/audio?input=<路径>` 带一个素材进来。没有 params 通道，读一次 URL 里的
     * `input` 查询串顶上 —— 少了它，「把结果丢给音频页」这类跳转就会静默丢掉素材。
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

    /* 设置存进 `config.json` 的 `audio` 里。`saveConfig` 内部已经防抖合并，这里不用再攒。 */
    useEffect(() => {
        saveConfig({audio: settings as unknown as Record<string, unknown>})
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
            const {info} = await api.audioProbe(path)
            const next = (info ?? {}) as ProbeInfo
            probeCache.current.set(path, next)
            if (settings.input.trim() === path) applyProbe(next)
        } catch (e) {
            const msg = errText(e)
            probeCache.current.set(path, {error: msg})
            if (settings.input.trim() === path) applyProbe({error: msg})
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

    /* 选素材：系统对话框 + 直接拖进窗口，两条入口都回**本机路径**
       （见 `components/FilePick.tsx`）。这里既能给音频也能给视频 —— 提取音轨、
       转格式都要用到视频，所以过滤器给 `MEDIA_EXTS`。 */
    const {pick, dropProps, dragging, busy: dropping} = useFilePick({
        exts: [...MEDIA_EXTS],
        label: '音频 / 视频文件',
        title: '选一个素材',
        dir: settings.lastDir || defaultOutDir,
        onPaths: (paths) => {
            setInput(paths[0])
            onToast(
                paths.length > 1 ? `一次处理一个，用了 ${baseName(paths[0])}` : `已选：${baseName(paths[0])}`,
                'ok',
            )
        },
        onToast,
    })

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
        setSettings((s) => (s.outName === next ? s : {...s, outName: next}))
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
                const o: Record<string, unknown> = {format: settings.convertFormat}
                if (Number(settings.sampleRate)) o.sampleRate = Number(settings.sampleRate)
                if (Number(settings.channels)) o.channels = Number(settings.channels)
                return o
            }
            case 'pitch':
                return {semitones: Number(settings.semitones)}
            case 'tempo':
                return {ratio: Number(settings.ratio)}
            case 'trim':
                return {startSec: Number(settings.startSec) || 0, endSec: Number(settings.endSec) || 0}
            case 'normalize':
                return {targetLufs: Number(settings.targetLufs) || -14}
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
     * 一段失败 / 取消就停下 —— 剩下的多半也会失败，一次跑完更浪费时间。
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
        if (submitting) return
        setSubmitting(true)
        setFieldErr('')
        setResult(null)
        setRunErr('')

        const total = jobs.length
        const submit = async (i: number) => {
            const j = jobs[i]
            const r = await api.audioRun({action: j.action, input, output: j.output, options: j.options})
            if (!r?.jobId) throw new Error('任务没能启动，请重试')
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
                    setResult({action: j.action, output: wrote})
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
            setSubmitting(false)
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
            onToast('未检测到 ffmpeg：tools 目录缺失，请重新解压程序包', 'warn')
            return
        }
        if (!outDir) {
            onToast('请选择输出目录', 'warn')
            return
        }
        const action = settings.action
        void runJobs([{action, output, options: buildOptions(action)}])
    }

    /** 波形编辑器的「导出这一段 / 全部导出」 */
    const exportSegments = (segs: Seg[], selected: number, all: boolean) => {
        if (!input) {
            onToast('请先选择要处理的音频文件', 'warn')
            return
        }
        if (!ffmpegOk) {
            onToast('未检测到 ffmpeg：tools 目录缺失，请重新解压程序包', 'warn')
            return
        }
        if (!outDir) {
            onToast('请选择输出目录', 'warn')
            return
        }
        const picks = all ? segs.map((s, i) => ({...s, i})) : [{...segs[selected], i: selected}]
        /* 切成多段时文件名一律补 `_01` —— 不然单段导出会互相覆盖 */
        const numbered = segs.length > 1
        const ext = extOf(outName) ? `.${extOf(outName)}` : ''
        const jobs = picks.map((s) => ({
            action: 'trim',
            options: {startSec: s.start, endSec: s.end},
            output: joinPath(outDir, numbered ? `${stripExt(outName)}_${String(s.i + 1).padStart(2, '0')}${ext}` : outName),
        }))
        void runJobs(jobs)
    }

    /* ── 派生数据 ───────────────────────────────────────────── */

    const formatEntries = Object.entries(formats)
    const busy = submitting || job?.status === 'running'

    /* ── 渲染 ───────────────────────────────────────────────── */

    return (
        <div className="audio-layout" {...dropProps}>
            {/* ══════════════════════ 左：素材 / 操作 / 输出 ══════════════════════ */}
            <div className="audio-col">
                {/* ffmpeg 缺失：只报状态 + 一句最短的恢复提示，不引导下载 */}
                {state && !ffmpegOk && (
                    <Panel>
                        <PanelHead
                            title={t("未检测到 ffmpeg")}
                            extra={<Chip tone="err">{t("未检测到")}</Chip>}
                        />
                        <div className="stack">
                            <p className="hint">{t("tools 目录缺失，请重新解压程序包。")}</p>
                            <div className="btn-row">
                                <Button size="lg" icon="gear" onClick={() => onNavigate('settings')}>
                                    去设置看看
                                </Button>
                            </div>
                        </div>
                    </Panel>
                )}

                {/* ── 素材 ── */}
                <Panel>
                    <PanelHead
                        title={t("素材")}
                        desc="选一个音频或视频文件"
                        extra={
                            <Chip tone={ffmpegOk ? 'ok' : 'warn'}>{ffmpegOk ? 'ffmpeg 已就绪' : 'ffmpeg 未就绪'}</Chip>
                        }
                    />
                    <div className="stack">
                        <Field
                            label="文件路径"
                            hint="点「浏览」选文件；也可以把完整路径（含文件名）粘贴到这里，回车生效。"
                        >
                            <div className="input-group">
                                <TextInput
                                    value={settings.input}
                                    spellCheck={false}
                                    autoComplete="off"
                                    placeholder={t("音频 / 视频文件的完整路径，例如 H:\\音乐\\Never Gonna Give You Up.mp4")}
                                    onChange={(e) => patch({input: e.target.value})}
                                    onKeyDown={(e) => {
                                        if (e.key !== 'Enter') return
                                        const next = e.currentTarget.value.trim()
                                        if (next === settings.input.trim()) return
                                        setInput(next)
                                    }}
                                />
                                <Button icon="folder" onClick={() => void pick()}>
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

                        <DropHint dragging={dragging} busy={dropping} text="音频 / 视频文件也可以直接拖进这个窗口"/>

                        {/* 探测结果 */}
                        {!input ? (
                            <Finding level="info" title={t("还没有选文件")}>
                                选好之后这里会显示时长、编码、采样率、声道。
                            </Finding>
                        ) : probing ? (
                            <p className="muted">{t("正在读取媒体信息…")}</p>
                        ) : probeErr ? (
                            <Finding level="warn" title={t("读不到这个文件")}>
                                {probeErr}
                            </Finding>
                        ) : !ffmpegOk || !probe || probe.available === false ? (
                            <Finding level="warn" title={t("读不出媒体信息")}>
                                装了 ffmpeg 之后，这里会显示时长、编码、采样率与声道。
                            </Finding>
                        ) : probe.probed === false ? (
                            <Finding level="info" title={t("没能读出媒体信息")}>
                                {probe.note ?? '没能读出媒体信息'}
                            </Finding>
                        ) : (
                            <div className="stack">
                                <div className="audio-probe-head">
                  <span className="audio-probe-name" title={input}>
                    {baseName(input)}
                  </span>
                                    <Chip tone={probe.audio ? 'ok' : 'warn'}>{probe.audio ? '含音轨' : '无音轨'}</Chip>
                                    {probe.video ? <Chip tone="accent">{t("含视频轨")}</Chip> : null}
                                    <span className="spacer"/>
                                    <Button size="sm" variant="ghost" icon="refresh"
                                            onClick={() => void probeFile(input, true, true)}>
                                        重新读取
                                    </Button>
                                </div>
                                <div className="chips">
                                    <Chip>
                                        <span className="audio-dim">{t("时长")}</span>
                                        {probe.durationSec ? formatDuration(probe.durationSec) : '未知'}
                                    </Chip>
                                    {probe.formatName ? (
                                        <Chip>
                                            <span className="audio-dim">{t("容器")}</span>
                                            {probe.formatName}
                                        </Chip>
                                    ) : null}
                                    {probe.sizeBytes ? (
                                        <Chip>
                                            <span className="audio-dim">{t("大小")}</span>
                                            {formatBytes(probe.sizeBytes)}
                                        </Chip>
                                    ) : null}
                                    {probe.bitrate ? (
                                        <Chip>
                                            <span className="audio-dim">{t("总码率")}</span>
                                            {`${Math.round(probe.bitrate / 1000)} kbps`}
                                        </Chip>
                                    ) : null}
                                    {probe.audio?.codec ? (
                                        <Chip>
                                            <span className="audio-dim">{t("音频编码")}</span>
                                            {probe.audio.codec}
                                        </Chip>
                                    ) : null}
                                    {probe.audio?.sampleRate ? (
                                        <Chip>
                                            <span className="audio-dim">{t("采样率")}</span>
                                            {`${probe.audio.sampleRate} Hz`}
                                        </Chip>
                                    ) : null}
                                    {probe.audio?.channels ? (
                                        <Chip>
                                            <span className="audio-dim">{t("声道")}</span>
                                            {channelsText(probe.audio.channels)}
                                        </Chip>
                                    ) : null}
                                    {probe.video ? (
                                        <Chip>
                                            <span className="audio-dim">{t("视频")}</span>
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
                    <PanelHead title={t("处理操作")}/>
                    <div className="stack-lg">
                        <div className="audio-ops" role="group" aria-label={t("处理操作")}>
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
                                        patch({action: op.id, nameEdited: false})
                                        setFieldErr('')
                                        setResult(null)
                                    }}
                                >
                                    <Icon name={op.icon} size={18}/>
                                    <span className="audio-op-name">{op.name}</span>
                                    <span className="audio-op-desc">{op.desc}</span>
                                </button>
                            ))}
                        </div>

                        {/* 参数：随操作切换（表单字段走 `Field` 与 `components/ui`） */}
                        <div className="stack">
                            {(settings.action === 'convert' || settings.action === 'extract') && (
                                <>
                                    <Field
                                        label="输出格式"
                                        hint="带「无损」标记的是 WAV / FLAC：做后期就用它们；只是想试听、传手机，MP3 320k 足够。"
                                    >
                                        {formatEntries.length === 0 ? (
                                            <Finding level="warn" title={t("格式列表为空")}>
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
                                                        onClick={() => patch({convertFormat: id, nameEdited: false})}
                                                    >
                            <span className="audio-format-name">
                              {f.label ?? id}
                                {f.lossless ? <Chip tone="ok">{t("无损")}</Chip> : null}
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

                                    {/* 两个选择器外面套 `Field`，`labelHidden` 避免标签出现两次。 */}
                                    <div className="audio-num-row">
                                        <Field label="采样率" hint="目标格式支持的话就跟着改。">
                                            <Select
                                                label="采样率"
                                                labelHidden
                                                value={String(settings.sampleRate)}
                                                options={SAMPLE_RATES}
                                                onValueChange={(v) => patch({sampleRate: Number(v)})}
                                            />
                                        </Field>
                                        <Field label="声道" hint="单声道体积小一半；做伴奏对轨一般保持立体声。">
                                            <Select
                                                label="声道"
                                                labelHidden
                                                value={String(settings.channels)}
                                                options={CHANNELS}
                                                onValueChange={(v) => patch({channels: Number(v)})}
                                            />
                                        </Field>
                                    </div>

                                    {settings.action === 'extract' && (
                                        <Finding level="info" title={t("从 MV 里抽出音轨")}>
                                            转 WAV 不会二次损失；视频轨会被丢掉
                                        </Finding>
                                    )}
                                </>
                            )}

                            {settings.action === 'pitch' && (
                                <>
                                    <Field
                                        label="变调（半音）"
                                        hint="正数升调、负数降调；±12 半音以内精度最好。"
                                    >
                                        <div className="audio-num-row">
                                            <Stepper
                                                aria-label={t("变调半音数")}
                                                min={-24}
                                                max={24}
                                                step={1}
                                                value={Number(settings.semitones)}
                                                onValueChange={(v) => patch({
                                                    semitones: Math.max(-24, Math.min(24, Math.round(v))),
                                                    nameEdited: false
                                                })}
                                                formatValue={(v) => `${v > 0 ? '+' : ''}${v} 半音`}
                                                shiftMultiplier={1}
                                            />
                                        </div>
                                    </Field>
                                    <div className="audio-presets">
                                        {SEMITONE_PRESETS.map((n) => (
                                            <Button
                                                key={n}
                                                size="sm"
                                                variant={Number(settings.semitones) === n ? 'primary' : 'default'}
                                                onClick={() => patch({semitones: n, nameEdited: false})}
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
                                        hint="大于 1 是加速，小于 1 是减速；音高保持不变。"
                                    >
                                        <div className="audio-num-row">
                                            <Stepper
                                                aria-label={t("速度倍率")}
                                                min={0.1}
                                                max={10}
                                                step={0.05}
                                                value={Number(settings.ratio)}
                                                onValueChange={(v) => patch({
                                                    ratio: Math.max(0.1, Math.min(10, v)),
                                                    nameEdited: false
                                                })}
                                                formatValue={(v) => `×${v}`}
                                            />
                                            <span className="audio-num-note">
                                                {Number(settings.ratio) > 1
                                                    ? t("加速")
                                                    : Number(settings.ratio) < 1
                                                        ? t("减速")
                                                        : t("原速")}
                                            </span>
                                        </div>
                                    </Field>
                                    <div className="audio-presets">
                                        {TEMPO_PRESETS.map((n) => (
                                            <Button
                                                key={n}
                                                size="sm"
                                                variant={Number(settings.ratio) === n ? 'primary' : 'default'}
                                                onClick={() => patch({ratio: n, nameEdited: false})}
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
                                        setTrimState({segments: next, selected})
                                        const sg = next[selected]
                                        if (sg) patch({startSec: sg.start, endSec: sg.end})
                                    }}
                                    onExport={(segs, selected) => exportSegments(segs, selected, false)}
                                    onExportAll={(segs, selected) => exportSegments(segs, selected, true)}
                                    onToast={onToast}
                                />
                            )}

                            {settings.action === 'normalize' && (
                                <>
                                    <Field label="目标响度（LUFS）" hint={LUFS_DESC[String(settings.targetLufs)] ?? ''}>
                                        <SegmentedControl
                                            aria-label={t("目标响度")}
                                            items={LUFS.map((l) => ({value: l.value, label: l.label}))}
                                            value={String(settings.targetLufs)}
                                            onValueChange={(v) => patch({targetLufs: Number(v)})}
                                        />
                                    </Field>
                                    <Finding level="info" title={t("响度标准化")}>
                                        分离出来的伴奏通常比人声轻，标准化之后对轨会省事很多。
                                    </Finding>
                                </>
                            )}
                        </div>
                    </div>
                </Panel>
            </div>

            {/* ══════════════════════ 右：执行 / 结果 / 输出 ══════════════════════ */}
            <div className="audio-col">
                <Panel>
                    <div className="audio-run">
                        <div className="btn-row">
                            <Button variant="primary" size="lg" icon="zap" loading={busy} onClick={run}>
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
                            大文件会花点时间，进度和日志实时显示。
                            {settings.action === 'trim' &&
                                '裁剪时这个按钮导出「当前选中的那一段」，要一次导出全部就在下面的分段列表里点「全部导出」。'}
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
                        <Finding level="warn" title={t("处理失败")}>
                            {runErr}
                        </Finding>
                    )}

                    {result && job?.status === 'done' && (
                        <div className="audio-result">
                            <div className="audio-result-head">
                                <Icon name="check" size={16}/>
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
                                    onClick={() => api.fsOpen({path: result.output}).catch((e: unknown) => onToast(errText(e), 'err'))}
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
                            <Button size="sm" icon="folder"
                                    onClick={() => api.fsReveal(result.output, true).catch((e: unknown) => onToast(errText(e), 'err'))}>
                                在资源管理器中显示
                            </Button>
                        </div>
                    )}
                </Panel>

                {/* ── 输出（含改输出目录）── */}
                <Panel>
                    <PanelHead
                        title={t("输出")}
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
                                    patch({outDir: d, outDirTouched: true})
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
                                placeholder={t("留空 = 写到系统下载目录…")}
                                title={t("选输出目录")}
                                onToast={onToast}
                                onChange={(v) => patch({outDir: v, outDirTouched: !!v})}
                            />
                        </Field>

                        <Field
                            label="输出文件名"
                            hint="留空 = 按操作自动命名；改过之后不再自动覆盖"
                        >
                            <TextInput
                                value={settings.outName}
                                spellCheck={false}
                                placeholder={t("自动按操作推断，例如 xxx_+3半音.wav")}
                                onChange={(e) => patch({outName: e.target.value, nameEdited: true})}
                            />
                        </Field>

                        <div className="audio-out-path">
                            <span className="audio-out-path-label">{t("将写入：")}</span>
                            <span className={sameAsInput ? 'audio-out-same' : ''}>{output || '（还没确定）'}</span>
                            {sameAsInput && <Chip tone="err">{t("不能覆盖输入文件")}</Chip>}
                        </div>

                        {fieldErr && <Finding level="warn" title={t("参数还不完整")}>{fieldErr}</Finding>}
                    </div>
                </Panel>

                {/* 许可与出处：这一页的活全是随包的 ffmpeg 干的 */}
                <Credit
                    items={[
                        {label: '代码', value: 'GPL v3', sub: 'FFmpeg 9.0.2（gyan.dev essentials）'},
                    ]}
                >
                    <Upstream href="https://ffmpeg.org/">ffmpeg</Upstream>
                    {' '}的许可是 GPL v3，用的是 gyan.dev essentials 构建，许可全文见仓库里的
                    THIRD-PARTY-NOTICES。
                </Credit>
            </div>
        </div>
    )
}

/* ══════════════════════════════════════════════════════ 布局与范围约定 ══ */

/*
 * ── 布局约束 ────────────────────────────────────────────────────────────
 *
 * 1. **探测结果是 `<Chip>` 列表**，不拼 innerHTML —— 同样的字段、同样的文案。
 *
 * 2. **「开始处理」在右栏顶部**，和进度 / 结果同一列 —— 点了之后眼睛不用来回找。
 *
 * 3. **「打开输出目录」与「打开输入所在目录」都在运行卡里**：
 *    页头那组控件在顶栏里已经不存在了，两个按钮别再分开放。
 *
 * 4. **波形编辑器有意收敛了范围**（无缩放 / 平移 / 空格播放 / 只播放选区），
 *    但裁剪本身的功能一个不少（见 `WaveEditor` 头顶那段）。
 */
