import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {SegmentedControl} from '@/components/ui'
import {api, MIDI_LANGUAGES, type MidiDeviceMode, type MidiNote, type MidiStatus,} from '@/lib/api'
import {getConfig, saveConfig} from '@/lib/config'
import {fileUrl, joinPath} from '@/lib/ipc'
import {Button} from '@/components/Button'
import {DropHint, useFilePick} from '@/components/FilePick'
import {Chip, Finding, Panel, PanelHead, ProgressBar, Stat} from '@/components/Panel'
import {DangerZone, DownloadProgress} from '@/components/Dependency'
import {JobStatusChip} from '@/components/Job'
import {ManualPacks} from '@/components/ManualPacks'
import {Field, TextInput} from '@/components/Field'
import {DirectoryInput} from '@/components/DirPicker'
import {baseName, dirName, errText, formatBytes} from '@/lib/format'
import {askExtDirOnce, ExtDirAsk} from '@/lib/extDir'
import {useStatusPoll} from '@/lib/polling'
import {downloadBytes, installLabel, type InstallStep, missingSteps, useInstaller} from '@/lib/useInstaller'
import {useJob} from '@/lib/useJob'
import type {PageProps} from './types'
import './Midi.css'
import {useI18n} from '@/lib/i18n'

/**
 * 人声转 MIDI —— 把干声扒成音符（GAME 的原生 Rust 移植）。
 *
 * 输入是「音轨分离」**之后**的干声。这一页背后就是这个进程本身（`crate::game::engine`
 * 直接算，ONNX Runtime 用 `ort` crate 动态加载），**不是**分离页那种 Python 子进程：
 *
 *   * **没有「服务起没起」**，也没有启动按钮。`status.running` 装的是「正在跑的那次
 *     任务 id」（同时只允许一个），不是服务的生死。
 *   * **第一次用要下 364 MB 模型包**（官方 ONNX 导出：三个 `.onnx` + `config.json`，
 *     `midi_transcribe.rs::GAME_ZIP`）。权重是 **CC BY-NC-SA 4.0（非商业）**，
 *     不随包发 —— 界面上必须把许可写出来。
 *   * **动态库随包分发**：ONNX Runtime 由 `tools/fetch_tools.mjs` 补齐、经
 *     `bundle.resources` 进安装包，运行期不下载。
 *
 * ⚠️ **它很慢，而且慢得必须在点按钮之前说出来。** 纯 CPU 下约 10 秒墙钟换 1 秒音频
 * （`game/engine.rs` / `midi_transcribe.rs`），3 分钟干声就是半小时。耗时几乎与
 * 「去噪步数」成正比，所以步数是这一页最值得动的旋钮。线程数也是「一定有效」的旋钮
 * （1 线程 2.66s / 4 线程 1.04s / 8 线程 3.30s 每步）。
 */

/* ══════════════════════════════════════════════════════════ 常量 ══ */

/**
 * 估时用的吞吐：**约 10 秒墙钟 / 1 秒音频**（纯 CPU）。
 *
 * 给用户一个量级，而不是精确承诺。机器不同差距很大（有 CUDA 会快一个数量级），
 * 所以这只是个提示，不参与判断。
 */
const SECONDS_PER_AUDIO_SECOND = 10

/** 去噪步数。8 是上游默认；耗时几乎与它线性相关，所以文案里要说清。 */
const STEP_CHOICES = [4, 8, 16, 32] as const

/** 推理方式三选一。`auto` 与 `cpu` 今天等价（引擎只在 `gpu` 时挂 CUDA）。 */
const DEVICE_MODES = [
    {value: 'auto' as const, label: '自动'},
    {value: 'gpu' as const, label: 'GPU'},
    {value: 'cpu' as const, label: 'CPU'},
]
const DEVICE_LABEL: Record<MidiDeviceMode, string> = {auto: '自动', gpu: 'GPU', cpu: 'CPU'}

/** 输入的音频扩展名（后端 ffmpeg 能解的都能给，这里只是文件选择器的过滤） */
const AUDIO_EXTS = ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma', 'aiff', 'ape']

/** 输出目录的配置键 */
const OUT_DIR_KEY = 'midiOutDir'

/* ══════════════════════════════════════════════════════════ 小工具 ══ */

/** 秒 → `3 分 12 秒` / `45 秒`。估时用的，不追求精确。 */
function humanSecs(sec: number): string {
    const s = Math.max(0, Math.round(sec))
    if (s < 60) return `${s} 秒`
    const m = Math.floor(s / 60)
    const r = s % 60
    if (m < 60) return r > 0 ? `${m} 分 ${r} 秒` : `${m} 分`
    return `${Math.floor(m / 60)} 小时 ${m % 60} 分`
}

/** 半音号 → `A3` 这样的音名（69 → A4，和 MIDI 的记法一致） */
function midiName(n: number): string {
    const NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
    return `${NAMES[((n % 12) + 12) % 12]}${Math.floor(n / 12) - 1}`
}

/* ══════════════════════════════════════════════════ 钢琴卷帘 ══ */

/** `ipc/midi.rs` 回包里的 `result`，字段一律「可能没有」 */
interface MidiResult {
    dir?: string
    files?: string[]
    notes?: number
    seconds?: { encoder?: number; segmenter?: number; estimator?: number }
    preview?: MidiNote[]
}

/**
 * 结果预览 —— 一个极简钢琴卷帘。
 *
 * 后端只回**前 200 个音符**（`ipc/midi.rs` 的 `result.preview`）：
 * 一首歌几千个音符没必要塞进每 2 秒一次的轮询回包里，要全的都在 `.json` 里。
 * 所以图上写清「预览前 N 个」—— 不然会以为整首歌只有这么点音符。
 *
 * 音高按**实际出现的范围**铺满，而不是固定 0..127：干声通常只在两个八度里，
 * 固定量程会把它压成一条线。
 */
function PianoRoll({notes}: { notes: MidiNote[] }) {
    const box = useMemo(() => {
        if (notes.length === 0) return null
        let lo = Infinity
        let hi = -Infinity
        let end = 0
        for (const n of notes) {
            if (n.midi < lo) lo = n.midi
            if (n.midi > hi) hi = n.midi
            if (n.offset > end) end = n.offset
        }
        // 上下各留 2 个半音的余量，免得最高的音贴着顶边
        lo -= 2
        hi += 2
        return {lo, span: Math.max(1, hi - lo), end: Math.max(0.001, end)}
    }, [notes])

    if (!box) return null
    const W = 1000
    const H = 160
    const rowH = H / box.span

    return (
        <svg
            className="midi-roll"
            viewBox={`0 0 ${W} ${H}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`钢琴卷帘预览，${notes.length} 个音符`}
        >
            {notes.map((n, i) => {
                const x = (n.onset / box.end) * W
                const w = Math.max(1.5, ((n.offset - n.onset) / box.end) * W)
                const y = H - (n.midi - box.lo + 0.5) * rowH
                return (
                    <rect
                        key={i}
                        x={x}
                        y={y - rowH * 0.45}
                        width={w}
                        height={Math.max(2, rowH * 0.9)}
                        rx={1.5}
                    />
                )
            })}
        </svg>
    )
}

/* ══════════════════════════════════════════════════════ 结果卡 ══ */

/** 扒谱出来的音符：卷帘 + 前 40 行表 + 结果文件的下载链接 */
function TranscribeResult({result, preview, taskId}: {
    result: MidiResult
    preview: MidiNote[]
    taskId: string | null
}) {
    const {t} = useI18n()
    return (
        <Panel>
            <PanelHead
                title={t("结果")}
                desc={`${result.notes} 个音符 · 预览前 ${preview.length} 个`}
                extra={<Chip tone="ok">{t("已写出")}</Chip>}
            />
            <div className="midi-roll-box">
                <PianoRoll notes={preview}/>
                <div className="midi-roll-axis">
                    <span>{preview[0]?.onset.toFixed(2)}s</span>
                    <span>{preview[preview.length - 1]?.offset.toFixed(2)}s</span>
                </div>
            </div>
            <div className="midi-notes">
                <div className="midi-notes-head">
                    <span>{t("起点")}</span>
                    <span>{t("时长")}</span>
                    <span>{t("音高")}</span>
                </div>
                {preview.slice(0, 40).map((n, i) => (
                    <div className="midi-note-row" key={i}>
                        <span>{n.onset.toFixed(2)}s</span>
                        <span>{(n.offset - n.onset).toFixed(2)}s</span>
                        <span>
                            {midiName(n.midi)}
                            <span className="dim"> ({n.midi})</span>
                        </span>
                    </div>
                ))}
                {preview.length > 40 && (
                    <p className="hint">还有 {preview.length - 40} 个在结果文件里。</p>
                )}
            </div>
            {taskId && result.dir && (result.files?.length ?? 0) > 0 && (
                <div className="btn-row">
                    {(result.files ?? []).map((f) => (
                        /* ⚠️ 输出目录是**用户任选的**（不是固定的 `<数据目录>/outputs/<id>`），
                           所以地址要用任务 `result.dir` 拼 —— 后端 `midi_open_output` 的注释
                           也说了同一件事。取文件走 asset 协议（`fileUrl`）。 */
                        <a
                            key={f}
                            className="dep-dl"
                            href={fileUrl(joinPath(result.dir!, f))}
                            download={f}
                        >
                            {f}
                        </a>
                    ))}
                </div>
            )}
            {result.seconds && (
                <p className="hint">
                    耗时{' '}
                    {(
                        (result.seconds.encoder ?? 0) +
                        (result.seconds.segmenter ?? 0) +
                        (result.seconds.estimator ?? 0)
                    ).toFixed(1)}
                    s
                </p>
            )}
        </Panel>
    )
}

/* ══════════════════════════════════════════════════════════ 页面 ══ */

export function Midi({onToast, onNavigate}: PageProps) {
    const {t} = useI18n()
    const [st, setSt] = useState<MidiStatus | null>(null)
    const [statusErr, setStatusErr] = useState<string | null>(null)

    const [input, setInput] = useState('')
    /* 输出目录存在 `config.json` 的 `midiOutDir` 里。 */
    const [outDir, setOutDir] = useState(() => String(getConfig()[OUT_DIR_KEY] ?? ''))
    const [steps, setSteps] = useState(8)
    const [language, setLanguage] = useState(4)
    const [threads, setThreads] = useState(4)
    /** 推理方式。真值在盘上（`<可写>/midi/midi_settings.json`），这里只是镜像。 */
    const [device, setDevice] = useState<MidiDeviceMode>('auto')

    const [busy, setBusy] = useState(false)
    /** 危险区第一下：只立旗标，第二下才真删（与音轨分离页同一套）。 */
    const [armDelete, setArmDelete] = useState(false)
    /** 输入文件的时长（秒）。拿 `audioProbe` 探；探不到就是 0，那时不给估时。 */
    const [duration, setDuration] = useState(0)

    /* 选文件：系统对话框 + 把文件直接拖进这个窗口，两条入口都回**本机路径**
       （拖进来的是 Tauri 给的真路径，见 `components/FilePick.tsx`）。
       这一页一次只扒一个文件，所以多给了也只取第一个。 */
    const {pick, dropProps, dragging, busy: dropping} = useFilePick({
        exts: AUDIO_EXTS,
        label: '音频文件',
        title: '选一段干声',
        dir: input ? dirName(input) : undefined,
        onPaths: (paths) => {
            setInput(paths[0])
            if (paths.length > 1) {
                onToast(`一次只转一个，用了 ${baseName(paths[0])}`, 'info')
            }
        },
        onToast,
    })

    const {job, start, stop} = useJob()
    /** 正在跑的那次任务 id（提交后记下，用来调 cancel 与拼结果下载地址） */
    const [taskId, setTaskId] = useState<string | null>(null)

    /* ── 轮询状态 ─────────────────────────────────────────── */
    /**
     * 上一次改推理方式的时刻。轮询据此忽略「在那之前出发、之后才回来」的那一轮 ——
     * 那种响应手里拿的是旧值，照它写会让刚点亮的那格弹回去。
     * 别改成「改了之后 N 秒内一律不动」：那会把 N 秒内别的窗口改的值也一起挡掉。
     */
    const deviceChangedAt = useRef(0)
    /** `refresh` 的依赖是空的（只挂一次定时器），所以要比值就得比 ref。 */
    const deviceRef = useRef(device)
    deviceRef.current = device

    const refresh = useCallback(async () => {
        const t0 = Date.now()
        try {
            const v = await api.midiStatus()
            setSt(v)
            /* 顺带把推理方式同步过来。⚠️ **每轮都跟** —— 本地改动是「点了立刻发请求」，
               几毫秒就落盘，2 秒后的这一轮跟的是自己；不跟才会出问题：另一个窗口
               （或用户直接改那个 json）会让界面显示的和引擎按的不一致，且毫无提示。 */
            if (v.device.mode !== deviceRef.current && t0 >= deviceChangedAt.current) {
                setDevice(v.device.mode)
            }
            setStatusErr(null)
            return v
        } catch (e) {
            setStatusErr(errText(e))
            return null
        }
    }, [])

    /**
     * 要装哪个包。只有模型（364 MB）—— 推理运行库随包分发，运行期不下。
     */
    const plan = useCallback(
        (s: MidiStatus): InstallStep[] => [
            {
                key: 'models',
                label: '模型',
                bytes: downloadBytes(s.models),
                ready: !!s.models.ready,
                /* 手放的整套包（网盘那条路）：后端扫目录认出来的，界面只负责改成「解压」 */
                manual: !!s.models?.manual?.length,
                start: api.midiDownloadModels,
            },
        ],
        [],
    )

    /**
     * 「一键装」：一颗按钮把还缺的包按顺序下完（状态机在 `lib/useInstaller.ts`）。
     * ⚠️ 这边**没有暂停**：这两个包不支持续传（停下就是重来），后端也刻意没给
     * 「继续下载」这个动作 —— 所以进度条下只留「停止下载」。
     * ⚠️ 开装之前问一次**扩展包落点**：模型与音轨分离的那几个包落在同一个根下
     * （约 8 GB），两个页面共用 `lib/extDir.tsx` 那一问。
     */
    const installer = useInstaller<MidiStatus>({
        load: refresh,
        plan,
        download: (s) => s.download,
        onToast,
        beforeInstall: askExtDirOnce,
    })

    /* 空闲时慢轮询：这一页的状态只有「装没装齐 / 下到多少 / 有没有任务」，
       没在动就不会自己变。安装中由 `useInstaller` 每 1.75 秒拉一次（拉的也是
       `refresh`），所以那边跑着的时候这里让开。 */
    const fastStatus =
        busy || !!st?.running || job?.status === 'running' || !!st?.download?.active
    useStatusPoll(refresh, fastStatus, installer.installing)

    /* 离开页面时收干净订阅（`useJob` 内部也做了，这里显式一点） */
    useEffect(() => () => stop(), [stop])

    const rememberOutDir = (v: string) => {
        setOutDir(v)
        saveConfig({[OUT_DIR_KEY]: v})
    }

    /* ── 探测输入时长（只用来估时）─────────────────────────── */
    useEffect(() => {
        const path = input.trim()
        if (!path) {
            setDuration(0)
            return
        }
        let alive = true
        api
            .audioProbe(path)
            .then((r) => {
                if (!alive) return
                const d = Number(r.info?.durationSec ?? 0)
                setDuration(Number.isFinite(d) && d > 0 ? d : 0)
            })
            .catch(() => {
                /* 探不到就没有估时 —— 不该因此报错，提交时后端还会再探一次 */
                if (alive) setDuration(0)
            })
        return () => {
            alive = false
        }
    }, [input])

    const ready = !!st?.models.ready && !!st?.runtime.ready
    const running = !!job && job.status === 'running'
    const dl = st?.download
    /** 那颗大按钮的文案；`null` = 全装好了，那时不画按钮（上面那排 Stat 就是摘要） */
    const installText = installLabel(st ? plan(st) : [])
    /** 下一步那颗包在盘上已经有手放的整套了 → 按钮是「解压」，图标也跟着换 */
    const nextIsManual = !!missingSteps(st ? plan(st) : [])[0]?.manual
    /** 进度条标签上「正在装什么」—— 优先用安装循环正在装的那一步，退回下载状态里的种类 */
    const stepName =
        installer.stepLabel || (dl?.kind === 'models' ? '模型' : '')
    /** 安装失败要显示的那句话：循环自己撞上的错优先，否则是后端留下的那一句 */
    const installError = installer.error || dl?.error || null
    /**
     * 这台机器能不能用 GPU。`undefined` = 状态还没拉回来，那一格先按锁着画
     * （宁可晚两秒解锁，也不要在没探明时把格子放开）。
     *
     * ⛔ 只能来自后端：真正的判据是「后端真拿一张 1×1 的图建出了 CUDA 会话」，前端没有
     * 任何办法知道（`navigator.gpu` 说的是浏览器那套，与 ONNX Runtime 无关）。
     */
    const cuda = st?.device?.cuda
    /* 估时：吞吐 × 时长 × 步数比例。只是量级，不是承诺。 */
    const estimate = useMemo(
        () => (duration > 0 ? (duration * SECONDS_PER_AUDIO_SECOND * steps) / 8 : 0),
        [duration, steps],
    )

    /* ── 动作 ─────────────────────────────────────────────── */

    const doStopDownload = async () => {
        setBusy(true)
        try {
            await api.midiStopDownload()
            onToast('已请求停止下载', 'info')
            void refresh()
        } catch (e) {
            onToast(errText(e), 'err')
        } finally {
            setBusy(false)
        }
    }

    /**
     * 删依赖：**两段式**，和音轨分离页（`Svsep.tsx`）用同一套危险区。
     *
     * 为什么不用 `window.confirm`：这个操作不可逆、删完要重下几百 MB，
     * 一个系统弹窗点快了就没了；两段式把「要删什么、删完怎样」写在页面上，
     * 用户能看清再点第二下。两个页面长得一样，才不会一边一个样。
     */
    const doDeleteDeps = async () => {
        setBusy(true)
        try {
            const r = await api.midiDeleteDeps()
            // ⚠️ 必须把后端的 `note` 一起显示：**安装版**下模型分两层，「删掉下下来
            // 那份」之后引擎可能还靠随包只读那份顶着、状态仍是「就绪」，下载按钮就
            // 不会出现 —— 不说清原因，看着就是「点了删除没反应」。
            // （绿色版两层同路径，这句 `note` 是空串，那时删掉就是真没了。）
            onToast(`已删掉 ${r.files} 个文件（${formatBytes(r.bytes)}）。${r.note}`, 'ok')
            setArmDelete(false)
            void refresh()
        } catch (e) {
            onToast(errText(e), 'err')
        } finally {
            setBusy(false)
        }
    }

    /**
     * 改推理方式：**乐观点亮**，失败弹回并把后端的错说出来。
     *
     * 后端不校验硬件（盘上记的是意愿），所以这里也不拦：真正用不了时引擎自己退回 CPU
     * 并把原因写进任务日志。
     */
    const doSetDevice = async (mode: MidiDeviceMode) => {
        if (mode === device) return
        const before = device
        /* 打一个时间戳，轮询那边据此忽略「在我之前出发、之后才回来」的那一轮 ——
           少了这一条就会出现「点了 GPU 又自己跳回 CPU」（那一轮请求是 2 秒前发出的）。 */
        deviceChangedAt.current = Date.now()
        setDevice(mode)
        try {
            const r = await api.midiSetDevice(mode)
            // 以盘上返回的值为准（它才是权威），并更新忽略窗口。
            deviceChangedAt.current = Date.now()
            setDevice(r.mode)
            // 引擎在下次提交扒谱时才读盘，所以说清「什么时候生效」。
            onToast(`推理方式已改成「${DEVICE_LABEL[r.mode]}」，下次开始扒谱时生效。`, 'ok')
            void refresh()
        } catch (e) {
            deviceChangedAt.current = 0
            setDevice(before)
            onToast(errText(e), 'err')
        }
    }

    const doTranscribe = async () => {
        const path = input.trim()
        if (!path) {
            onToast('先选一个音频文件', 'warn')
            return
        }
        setBusy(true)
        try {
            const r = await api.midiTranscribe({
                input: path,
                outDir: outDir.trim() || undefined,
                steps,
                language,
                threads,
            })
            setTaskId(r.jobId)
            start(r.jobId, {
                onDone: () => {
                    onToast('扒谱完成', 'ok')
                    void refresh()
                },
                onError: (err) => {
                    onToast(err.message, 'err')
                    void refresh()
                },
                onCancel: () => {
                    onToast('已取消', 'info')
                    void refresh()
                },
            })
        } catch (e) {
            onToast(errText(e), 'err')
        } finally {
            setBusy(false)
        }
    }

    const doCancel = async () => {
        if (!taskId) return
        try {
            await api.midiCancel(taskId)
            onToast('已请求取消（当前这一段跑完才停）', 'info')
        } catch (e) {
            onToast(errText(e), 'err')
        }
    }

    /* ── 结果 ─────────────────────────────────────────────── */
    const result = (job?.result ?? null) as MidiResult | null

    const dlPct = dl && dl.total > 0 ? Math.min(100, (dl.done / dl.total) * 100) : 0

    /**
     * 把输出目录放行给 **asset 协议**。
     *
     * ⚠️ 不能省：输出目录是用户任选的，不在「刚选过的东西」那一批里（`pick_paths`
     * 只放行用户当下选中的）；漏了的话结果文件那几个下载链接会**静默**失效
     * （控制台一条 403，页面看不出哪里不对）。
     */
    useEffect(() => {
        if (!result?.dir) return
        void api.allowPath(result.dir).catch(() => {
            /* 放行失败不打断这一页 */
        })
    }, [result?.dir])

    /* ── 渲染 ─────────────────────────────────────────────── */
    return (
        <div className="page-body midi-layout" {...dropProps}>
            {/* ══════════════ 左栏：素材 + 参数 ══════════════ */}
            <div className="midi-col">
                <Panel>
                    <PanelHead
                        title={t("干声素材")}
                        desc="把「音轨分离」拆出来的人声给这里"
                        extra={input ? <Chip tone="ok">{t("已选")}</Chip> : <Chip>{t("未选")}</Chip>}
                    />
                    <input
                        type="text"
                        className="input"
                        value={input}
                        onChange={(e) => setInput(e.target.value)}
                        placeholder={t("D:\\歌\\干声.wav")}
                        spellCheck={false}
                    />
                    <div className="btn-row">
                        <Button icon="folder" onClick={() => void pick()}>
                            选音频文件
                        </Button>
                        {input && (
                            <Button variant="ghost" icon="x" onClick={() => setInput('')}>
                                清空
                            </Button>
                        )}
                    </div>
                    <DropHint dragging={dragging} busy={dropping} text="音频文件也可以直接拖进这个窗口"/>
                    {input ? (
                        <p className="hint">
                            {baseName(input)}
                            {duration > 0 ? ` · ${humanSecs(duration)}` : ''}
                        </p>
                    ) : (
                        <p className="hint">
                            还没做过分离？
                            <button type="button" className="dep-link" onClick={() => onNavigate('svsep')}>
                                先去音轨分离页
                            </button>
                            拆出干声。
                        </p>
                    )}
                </Panel>

                <Panel>
                    <PanelHead title={t("参数")} desc="只有「去噪步数」值得反复试"/>
                    <Field
                        label="去噪步数"
                        hint={`默认 8 步。耗时几乎与它成正比。${
                            estimate > 0 ? `按当前设置估约 ${humanSecs(estimate)}。` : ''
                        }`}
                    >
                        <div className="midi-steps">
                            {STEP_CHOICES.map((s) => (
                                <button
                                    key={s}
                                    type="button"
                                    className="midi-step"
                                    data-on={steps === s ? 'true' : undefined}
                                    onClick={() => setSteps(s)}
                                >
                                    {s}
                                </button>
                            ))}
                        </div>
                    </Field>

                    <Field label="语言" hint="告诉它唱的是哪种语言，能提高音符边界的准确度">
                        <select
                            className="input"
                            value={language}
                            onChange={(e) => setLanguage(Number(e.target.value))}
                        >
                            {MIDI_LANGUAGES.map((l) => (
                                <option key={l.id} value={l.id}>
                                    {l.label}
                                </option>
                            ))}
                        </select>
                    </Field>

                    <Field
                        label="线程数"
                        hint="4 左右通常最快；开太多反而更慢"
                    >
                        <TextInput
                            type="number"
                            min={1}
                            max={32}
                            value={threads}
                            onChange={(e) => setThreads(Number(e.target.value) || 4)}
                        />
                    </Field>

                    {/* 推理方式（自动 / GPU / CPU）：和音轨分离页同一个形状的三选一。
                        ⛔ GPU 那一格**只在 `cuda.ok` 时可选**，而这个值只能来自后端
                        （`status.device.cuda`）—— 别按 `navigator` 或显卡名字猜：
                        真正的判据是「后端建得出一个 CUDA 会话」，只有后端探得到，
                        而猜错的方向恰好是最坏的那个（放出格子 → 跑起来才发现不行）。
                        ⛔ 这里**不能套 `<Field>`**：它是个 `<label>`，而控件里面是
                        `<input type="radio">` —— 点标签上任意一处（包括下面那行说明）
                        都会激活第一个单选项，等于悄悄把推理方式改回「自动」。 */}
                    <div className="field">
                        <span className="field-label">{t("推理方式")}</span>
                        {/* 被禁的那一格用 `aria-disabled`，点击照样冒泡，所以「点了给提示、
                            但不选中」要在**捕获阶段**做。
                            ⛔ 别给这个容器加 `pointer-events: none` 来表达禁用 —— 那就成了
                            点了毫无反应，而这正是用户会来报的那个问题。 */}
                        <div
                            className="midi-infer"
                            onClickCapture={(e) => {
                                const seg = (e.target as HTMLElement).closest('.seg-item')
                                if (!seg || seg.getAttribute('data-disabled') !== 'true') return
                                e.preventDefault()
                                e.stopPropagation()
                                onToast(
                                    cuda?.ok
                                        ? '这一格现在选不了。'
                                        : `GPU 现在用不了：${cuda?.detail ?? '正在探测'}。`,
                                    'warn',
                                )
                            }}
                        >
                            <SegmentedControl
                                aria-label={t("推理方式")}
                                items={DEVICE_MODES.map((m) => ({
                                    ...m,
                                    /* 锁死那一格：只有 `cuda.ok` 为假时锁 GPU。`disabled` 同时
                                       供读屏与键盘识别，视觉置灰由 `.seg-item[data-disabled]` 做。 */
                                    disabled: m.value === 'gpu' && !cuda?.ok,
                                }))}
                                value={device}
                                onValueChange={(v: string) => void doSetDevice(v as MidiDeviceMode)}
                            />
                        </div>
                        <span className="field-hint">
                            {cuda?.ok
                                ? '这台机器能用 GPU，扒谱会明显更快。'
                                : st
                                    ? `GPU 暂不可用：${cuda?.detail ?? ''}`
                                    : '正在探这台机器能不能用 GPU…'}
                        </span>
                    </div>

                    {/* 选着 GPU 但当前用不上 —— 后端给的话术，直接显示，别自己另编一套 */}
                    {st?.device?.note && <p className="midi-note-warn">{st.device.note}</p>}

                </Panel>

                <Panel>
                    <PanelHead title={t("输出")} desc="留空就写到音频同目录下的 midi 文件夹"/>
                    <DirectoryInput
                        value={outDir}
                        onChange={rememberOutDir}
                        placeholder={t("留空 = 音频同目录\\midi")}
                        title={t("选 MIDI 写到哪个目录")}
                        onToast={onToast}
                    />
                    <div className="btn-row">
                        <Button
                            variant="ghost"
                            icon="folder"
                            disabled={!result?.dir}
                            onClick={() => {
                                if (!result?.dir) return
                                void api.midiOpenOutput(result.dir).catch((e) => onToast(errText(e), 'err'))
                            }}
                        >
                            打开输出目录
                        </Button>
                    </div>
                </Panel>
            </div>

            {/* ══════════════ 右栏：状态 + 结果 ══════════════ */}
            <div className="midi-col">
                <Panel>
                    <PanelHead
                        title={t("扒谱")}
                        desc="进度看下面；界面照常能用"
                        extra={
                            running ? (
                                <Chip tone="accent">{t("运行中")}</Chip>
                            ) : ready ? (
                                <Chip tone="ok">{t("可以开始")}</Chip>
                            ) : (
                                <Chip tone="warn">{t("缺依赖")}</Chip>
                            )
                        }
                    />

                    {statusErr && (
                        <Finding level="warn" title={t("读不到状态")}>
                            {statusErr}
                        </Finding>
                    )}

                    <div className="midi-stats">
                        <Stat
                            label="模型"
                            value={st ? (st.models.ready ? '就绪' : `缺 ${st.models.missing.length} 个`) : '…'}
                            sub={st?.models.ready ? undefined : st?.models.missing.join('、')}
                        />
                        <Stat
                            label="ONNX Runtime"
                            value={st ? (st.runtime.ready ? '就绪' : '缺') : '…'}
                        />
                        <Stat
                            label="耗时"
                            value={estimate > 0 ? `约 ${humanSecs(estimate)}` : '—'}
                            sub={duration > 0 ? `${humanSecs(duration)} 素材 · 估算` : '选了文件后估算'}
                        />
                    </div>

                    {/* ── 一个按钮：把还缺的模型装完 ────────────────────
              推理运行库随包分发、不下载；这里只需要下模型（状态机在 `lib/useInstaller.ts`）。
              全装好之后这颗按钮**不出现** —— 上面那排 Stat 就是状态摘要。 */}
                    {installText && (
                        <div className="btn-row">
                            <Button
                                variant="primary"
                                icon={nextIsManual ? 'package' : 'download'}
                                loading={installer.installing}
                                disabled={!!dl?.active}
                                onClick={() => installer.install()}
                            >
                                {installText}
                            </Button>
                        </div>
                    )}
                    {/* 下得慢的那条退路：123 云盘。落点用后端给的当前扩展包根
                        （用户在设置里改了它跟着变，与音轨分离页显示的是同一个根）。 */}
                    {installText && (
                        <ManualPacks
                            dir={st?.extDir}
                            what="GAME-1.0.3-large-onnx.zip"
                            onToast={onToast}
                        />
                    )}

                    {dl && (installer.installing || dl.active) && (
                        /* 下载与解压共用一条进度条，标签必须说清是哪一段：解压的分母跟
                           整包字节数差不多大，只写「正在下载」就成了「下到 100% 又归零
                           重爬」，看着像下完又重下了一遍 */
                        <DownloadProgress
                            label={dl.stage === 'extract' ? '正在解压…' : `正在装${stepName}…`}
                            done={dl.done}
                            total={dl.total}
                            pct={dl.total > 0 ? dlPct : null}
                            footer={
                                <p className="hint">
                                    这个包<strong>{t("不支持续传")}</strong>，停下就要重来。
                                </p>
                            }
                        >
                            <Button
                                size="sm"
                                variant="ghost"
                                disabled={busy}
                                onClick={() => void doStopDownload()}
                            >
                                停止下载
                            </Button>
                        </DownloadProgress>
                    )}

                    {installError && (
                        <Finding level="warn" title={t("安装失败")}>
                            {installError}
                        </Finding>
                    )}

                    <div className="btn-row">
                        <Button
                            variant="primary"
                            icon="play"
                            disabled={busy || !ready || running || !input.trim()}
                            onClick={() => void doTranscribe()}
                        >
                            {running ? '正在扒谱…' : '开始扒谱'}
                        </Button>
                        {running && (
                            <Button variant="danger" icon="x" onClick={() => void doCancel()}>
                                取消
                            </Button>
                        )}
                    </div>

                    {estimate > 0 && !running && (
                        <p className="hint">
                            ⚠️ 纯 CPU 下大约<strong>{t(" 10 秒换 1 秒音频")}</strong> —— 3 分钟干声就是半小时左右。
                        </p>
                    )}

                    {/* 删依赖：刻意不做条件渲染 —— 依赖还没下全时也该留着这个入口。
                        ⚠️ 那条「删完仍是就绪」的说明只在**安装版**（两层是不同目录、引擎在用
                        随包那份）才该出现，那时删除删不到引擎正在用的模型，下载按钮也不会回来，
                        不说清用户只会以为按钮坏了。判据只能是后端回的 `models.origin`：
                        downloaded / bundled / local 三种路径都以 `\game\models` 结尾，按 `dir`
                        尾巴猜必错。 */}
                    <DangerZone
                        label="删除全部依赖"
                        armed={armDelete}
                        onArm={() => setArmDelete(true)}
                        onCancel={() => setArmDelete(false)}
                        onConfirm={() => void doDeleteDeps()}
                        disabled={busy || !!dl?.active}
                        confirmText={`确认删除（要重下${st ? formatBytes(st.models.zipBytes) : '几百 MB'}）`}
                        notice={
                            st?.models.ready && st.models.origin === 'bundled' ? (
                                <p className="hint">
                                    引擎现在用的是随程序自带的那份模型，下面的删除只清下载来的那份，所以删完状态仍是「就绪」。
                                </p>
                            ) : null
                        }
                        armedText={
                            <>
                                要删掉：GAME 模型
                                {st ? `（解压后 ${formatBytes(st.models.extractBytes)}）` : ''}
                                。删完就扒不了谱了，得重新下
                                {st ? ` ${formatBytes(st.models.zipBytes)}` : '几百 MB'}
                                。已经转出来的 MIDI <strong>{t("不会被删")}</strong>。
                            </>
                        }
                        idleText={
                            <>
                                下好的模型占约
                                {st ? ` ${formatBytes(st.models.extractBytes)}` : ' 几百 MB'}
                                。
                            </>
                        }
                    />
                </Panel>

                {(running || job) && (
                    <Panel>
                        <PanelHead
                            title={t("进度")}
                            desc={job?.title}
                            extra={<JobStatusChip status={job?.status ?? 'running'}/>}
                        />
                        <div className="dep-progress">
                            <div className="dep-progress-head">
                                <span>{job?.message ?? '正在准备…'}</span>
                                <span className="dim">{Math.round(job?.percent ?? 0)}%</span>
                            </div>
                            <ProgressBar pct={Math.min(100, job?.percent ?? 0)}/>
                        </div>
                        {job?.error && (
                            <Finding level="warn" title={t("失败")}>
                                {job.error}
                            </Finding>
                        )}
                        {(job?.logs?.length ?? 0) > 0 && (
                            <div className="midi-logs">
                                {(job?.logs ?? []).slice(-6).map((l, i) => (
                                    <p key={i}>{l}</p>
                                ))}
                            </div>
                        )}
                    </Panel>
                )}

                {result?.preview && result.preview.length > 0 && (
                    <TranscribeResult result={result} preview={result.preview} taskId={taskId}/>
                )}

                <Panel>
                    <PanelHead title={t("许可与出处")} desc="模型与代码是两套许可"/>
                    <div className="midi-stats">
                        <Stat label="代码" value="MIT" sub="openvpi/GAME"/>
                        <Stat label="权重" value="CC BY-NC-SA 4.0" sub="非商业"/>
                    </div>
                    <p className="hint">
                        模型来自官方发布（
                        <a href={st?.source ?? 'https://github.com/openvpi/GAME'} target="_blank" rel="noreferrer">
                            {st?.source ?? 'github.com/openvpi/GAME'}
                        </a>
                        ）。
                    </p>
                    {st && (
                        <div className="btn-row">
                            <Button size="sm" variant="ghost" icon="refresh" onClick={() => void refresh()}>
                                刷新状态
                            </Button>
                        </div>
                    )}
                </Panel>

                {/* 装模型之前问一次落点 —— 与音轨分离页、设置页那一问是同一件事
                    （模型和那几个包落在同一个扩展包根下），实现只有一处。 */}
                <ExtDirAsk/>
            </div>
        </div>
    )
}
