import {type RefObject, useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {api, svsepFileUrl, type SvsepOutput, type SvsepStatus, type SvsepTask,} from '@/lib/api'
import {Button, IconButton} from '@/components/Button'
import {Credit, Upstream} from '@/components/Credit'
import {Icon} from '@/components/Icon'
import {Chip, Finding, Panel, PanelHead, ProgressBar, Stat} from '@/components/Panel'
import {DangerZone, DownloadProgress} from '@/components/Dependency'
import {JobStatusChip, svsepTaskStatus} from '@/components/Job'
import {ManualPacks} from '@/components/ManualPacks'
import {SegmentedControl} from '@/components/ui'
import {DropHint, useFilePick} from '@/components/FilePick'
import {askExtDirOnce, ExtDirAsk} from '@/lib/extDir'
import {baseName, errText, formatBytes} from '@/lib/format'
import {POLL_STATUS, useStatusPoll} from '@/lib/polling'
import {
    downloadBytes,
    extractedBytes,
    installLabel,
    type InstallStep,
    missingSteps,
    useInstaller,
} from '@/lib/useInstaller'
import {capOk} from '@/lib/types'
import type {PageProps} from './types'
import './Svsep.css'
import {useI18n} from '@/lib/i18n'

/**
 * 音轨分离 —— 在线（MVSEP）与离线（内嵌引擎）两条路。
 *
 * 这一页背后是**一个 Python 子进程**（`炽小阳音轨分离站离线版` 的后端，源码在
 * `data/svsep/backend/`，由 Rust 的 `svsep.rs` 拉起）。由此派生出页面上大部分状态：
 *
 *   * 服务**由这一页自己管**：点「开始分离」时自动起（第一次要十几秒），任务跑完、
 *     队列空了自动关 —— 它常驻会占约 5 GB 内存。所以**不画**「启动服务 / 停止服务」
 *     两颗按钮，状态里只说「运行中 / 空闲」。
 *   * 运行时 4.7 GB（解压 7.4 GB）+ 模型 462 MB（解压 731 MB）**都不随包发**。
 *     界面上必须把「要下多少」写清楚 —— 只说「下载模型 730 MB」会被当成整个功能的代价，
 *     而真正的大头是运行时。缺哪样就下哪样，缺两样时把总字节数一并说出来。
 *     **没有模型时绝不能画提交按钮**：那会白等几十分钟再失败。
 *   * 一次任务**几分钟到几十分钟**（纯 CPU：二轨约 8 分钟、六轨约 11 分钟），
 *     所以进度是这一页的主角，`running` 时必须自动轮询。
 *
 * ⚠️ `svsep_status` 有事时 2 秒一拉、空闲 15 秒一拉，`svsep_backend_status` 固定 8 秒，
 * **两条不要合并**：前者便宜（读几个文件大小 + socket 探活），后者贵（要查注册表探 GPU）。
 *
 * ⚠️ **上游的进度是估的，不是真进度**：`task_manager.py` 里 UVR 按 `elapsed / 240s`、
 * RoFormer 按 `elapsed / 480s` 线性插值，所以会长时间停在 90% 再跳到 100%。
 * 界面上照实显示百分比与那句「已用时 N 秒」，另用一句 note 说清它是按时间估的。
 */

/* ══════════════════════════════════════════════════════════ 常量 ══ */

const MVSEP_URL = 'https://mvsep.com/zh'

/** 上游 `config.MAX_CONTENT_LENGTH`，超了它自己会回一句人话 */
const MAX_UPLOAD = 100 * 1024 * 1024

const ENGINES = [
    {
        id: 'roformer' as const,
        name: '六轨（BS-Roformer）',
        desc: '人声 / 鼓 / 贝斯 / 吉他 / 钢琴 / 其它 —— 想做伴奏改编制作用这个',
        cost: '约 11 分钟',
    },
    {
        id: 'uvr' as const,
        name: '二轨（UVR MDX）',
        desc: '人声 / 伴奏 —— 只想把干声抠出来，或者先看看效果',
        cost: '约 8 分钟',
    },
]

/** 这两条是按纯 CPU 机器估的量级；有 CUDA 的机器会快一个数量级 */
const ESTIMATE_NOTE = '装了 NVIDIA 显卡会快很多'

/** 后端探测的间隔：它要查注册表探 GPU，比状态那条贵，所以单独一个更慢的节奏 */
const POLL_BACKEND = 8000

/** 任务进度轮询连错这么多次就当这条路走不通：再问下去只会每 2 秒刷一条错误 toast */
const POLL_GIVE_UP = 5

/**
 * 推理方式 —— 原版软件标题栏上就有这个三选一（`自动 / GPU / CPU`），
 * 能不能真用上 GPU 由 Python 那边探（本机是 AMD 卡，只会回退 CPU）。
 */
const INFER_MODES = [
    {value: 'auto' as const, label: '自动'},
    {value: 'gpu' as const, label: 'GPU'},
    {value: 'cpu' as const, label: 'CPU'},
]
type InferMode = (typeof INFER_MODES)[number]['value']
const INFER_LABEL: Record<InferMode, string> = {auto: '自动', gpu: 'GPU', cpu: 'CPU'}
/** 认不出的值一律当 auto（后端也是这么兜的） */
const asInferMode = (v: unknown): InferMode => (v === 'cpu' || v === 'gpu' ? v : 'auto')

const STEM_LABEL: Record<string, string> = {
    vocals: '人声',
    instrumental: '伴奏',
    drums: '鼓',
    bass: '贝斯',
    guitar: '吉他',
    piano: '钢琴',
    other: '其它',
}

/* ══════════════════════════════════════════════════════════ 小工具 ══ */

/**
 * 两个模型文件（以及那几个索引文件）都在？
 *
 * ⚠️ 判据只能是后端状态里的 `models.items[].state` + `models.ok`，别在前端按文件大小猜。
 * `models` 是对象、列表在 `items[]` 里（写成 `models.uvr` 会恒为 false）。
 */
const svsepModelsOk = (s: SvsepStatus) => {
    const items = s.models?.items ?? []
    return items.length > 0 && items.every((m) => m.state === 'ok')
}

/** 从文件名猜一条轨是什么（上游给的是 `(Vocals)_xxx.wav` 这种） */
function stemOf(o: SvsepOutput): string {
    if (o.stem) return o.stem
    const name = o.download_name || o.filename || ''
    const m = name.match(/\(([A-Za-z]+)\)/)
    if (!m) return ''
    const key = m[1].toLowerCase()
    return STEM_LABEL[key] ? key : ''
}

function trackLabel(o: SvsepOutput, i: number): string {
    const stem = stemOf(o)
    return STEM_LABEL[stem] || o.download_name || o.filename || `第 ${i + 1} 轨`
}

/* ══════════════════════════════════════════════════════ 结果轨道 ══ */

/**
 * 分出来的轨道列表：一条 `<audio>` 共用，试听就是把它的 src 换成那轨。
 *
 * ⚠️ 取文件按**文件名**走磁盘（`svsepFileUrl`），不走服务 —— 任务跑完服务可能已经关了。
 */
function ResultTracks({
                          outputs,
                          taskId,
                          outputsDir,
                          audioRef,
                          previewIdx,
                          onPreview,
                      }: {
    outputs: SvsepOutput[]
    taskId: string
    outputsDir: string
    audioRef: RefObject<HTMLAudioElement | null>
    previewIdx: number | null
    onPreview: (i: number) => void
}) {
    return (
        <>
            <audio ref={audioRef} className="svsep-audio" controls/>
            <ul className="svsep-tracks">
                {outputs.map((o, i) => (
                    <li key={o.filename || i} className="svsep-track">
                        <span className="svsep-track-name">{trackLabel(o, i)}</span>
                        {typeof o.size === 'number' && o.size > 0 && (
                            <span className="dim">{formatBytes(o.size)}</span>
                        )}
                        <span className="spacer"/>
                        <IconButton
                            label={`试听${trackLabel(o, i)}`}
                            icon="play"
                            size="sm"
                            variant={previewIdx === i ? 'primary' : 'default'}
                            onClick={() => onPreview(i)}
                        />
                        <a
                            className="dep-dl"
                            href={svsepFileUrl(outputsDir, taskId, o.filename)}
                            download={o.download_name || o.filename}
                        >
                            <Icon name="download" size={14}/>
                            下载
                        </a>
                    </li>
                ))}
            </ul>
        </>
    )
}

/* ════════════════════════════════════════════════════════ 主组件 ══ */

export function Svsep({onNavigate, onToast, state}: PageProps) {
    const {t} = useI18n()
    /* 离线引擎整条链（运行时包 + 模型 + 推理方式 + 一键删依赖）只有 Windows 有 ——
       判据在后端 `platform.rs::caps`，这里不自己看 `state.platform`。 */
    const localEngine = state?.caps?.svsepLocal
    const localOk = capOk(localEngine)
    const [st, setSt] = useState<SvsepStatus | null>(null)
    const [backend, setBackend] = useState<Record<string, unknown> | null>(null)
    /**
     * 选中的音频 —— **是路径不是 `File`**。
     *
     * ⚠️ Python 服务要的本来就是**一个文件**，所以对话框与拖放都给**真路径**
     * （`pick_paths` / `DragDropEvent::Drop`）。别在前端把音频读成字节再传给后端 ——
     * 那一趟是白搬的字节。
     */
    const [file, setFile] = useState<{ path: string; name: string } | null>(null)
    const [engine, setEngine] = useState<'uvr' | 'roformer'>('roformer')
    const [busy, setBusy] = useState(false)
    /* 推理方式：跟盘上的 `inference_settings.json` 对齐（服务在跑时以 Python 为准） */
    const [inferMode, setInferMode] = useState<InferMode>('auto')
    const [task, setTask] = useState<SvsepTask | null>(null)
    /* 「删除全部依赖」的两段式确认：第一下只是把这个立起来，第二下才真删 */
    const [armDelete, setArmDelete] = useState(false)
    /* 六轨（RoFormer）不再提供「也用显卡」的开关：上游说它走 DirectML 容易 OOM，
       而显存不够时是**整个任务失败**（不是退回 CPU）。后端每次都会把那一行复位成
       上游的 False —— 老用户开过的也一并收回去。 */

    /** 拉一次总体状态。失败**不弹 toast**（轮询失败会刷屏），把错误放进 err 显示 */
    const [err, setErr] = useState<string | null>(null)
    const refresh = useCallback(async () => {
        try {
            const s = await api.svsepStatus()
            setSt(s)
            setErr(null)
            return s
        } catch (e) {
            setErr(errText(e))
            return null
        }
    }, [])

    /**
     * 要装哪几个包、按什么顺序。
     *
     * **顺序就是用户要的那条**：运行时 → 模型 →（没有 N 卡时）显卡加速包。
     * 每一步的 `ready` 都来自后端状态，所以「缺哪样下哪样」不用另外维护一份账。
     */
    const plan = useCallback(
        (s: SvsepStatus): InstallStep[] => {
            /* 盘上还留着半个包（上次下到一半关了窗口、或者解压没收尾）时，即便入口文件
               已经在了，也要让这一步重新算「没装完」—— 点安装**不会走网络**，直接把包里
               剩下的解开（`svsep.rs::part_is_whole_zip` 那条短路）。不这么判的话按钮不会
               出现，而下面那句「已下好 X，接着下」就指向一个不存在的按钮。 */
            const leftover = (kind: 'runtime' | 'models') =>
                !!s.download?.resumable && s.download?.pausedKind === kind
            return [
                {
                    key: 'runtime',
                    label: '运行时',
                    bytes: downloadBytes(s.runtime),
                    ready: !!s.runtimeReady && !leftover('runtime'),
                    /* 手放的整套包（网盘那条路）—— 后端扫目录认出来的，界面只负责改文案 */
                    manual: !!s.runtime?.manual?.length,
                    start: api.svsepDownloadRuntime,
                },
                {
                    key: 'models',
                    label: '模型',
                    bytes: downloadBytes(s.models),
                    ready: svsepModelsOk(s) && !leftover('models'),
                    manual: !!s.models?.manual?.length,
                    start: api.svsepDownloadModels,
                },
                {
                    key: 'dml',
                    label: '显卡加速包',
                    bytes: downloadBytes(s.dml),
                    ready: !!s.dml?.installed,
                    /* 有 N 卡时这一步**本来就不用装**：那份 DirectML ORT 里没有 CUDA，
                       给 N 卡机器装它反而更慢。标成 `skip` 而不是 `ready` —— 否则按钮会
                       把这一台机器说成「已经装过一部分」。 */
                    skip: !!s.dml?.nvidia,
                    /* A 卡 / 核显：盘上有手放的 `.whl` 就是「解压」（它从 PyPI 下来，
                       境内也常慢，所以网盘那条退路对它同样成立） */
                    manual: !!s.dml?.manual?.length,
                    start: api.svsepDmlDownload,
                },
            ]
        },
        [],
    )

    /* 开装之前问一次扩展包落点（共用那一份在 `lib/extDir.tsx`：设置页与 MIDI 页
       问的是**同一个根**，所以这一问只该有一份实现）。 */
    const installer = useInstaller<SvsepStatus>({
        load: refresh,
        plan,
        download: (s) => s.download,
        onToast,
        beforeInstall: askExtDirOnce,
    })

    /* ── 轮询：状态 ─────────────────────────────────────── */
    /* 安装中由 `useInstaller` 每 1.75 秒拉一次（它拉的也是 `refresh`），这里让开，
       免得同一条命令被两个定时器同时打 */
    /* 只有「会自己变的事」在跑才值得 2 秒一追：服务起着（队列空了它自己关）、
       下载或后台删除在动、提交还没回来。其余时候 15 秒一次足够。 */
    const fastStatus =
        busy || !!st?.running || !!st?.download?.active || !!st?.download?.delete?.active
    useStatusPoll(refresh, fastStatus, installer.installing)

    const running = !!st?.running

    /* ── 轮询：分离后端自己的状态（设备 / 队列）───────────── */
    /* ⚠️ 服务停了**不清空** `backend`：任务跑完服务就自动关了，可上次探到的设备
       与队列还得留在界面上 —— 清掉的话「设备」那条 Stat 会跟着服务一起消失。 */
    useEffect(() => {
        if (!running) return
        let alive = true
        const tick = async () => {
            try {
                const b = await api.svsepBackendStatus()
                if (alive) setBackend(b)
            } catch {
                /* 服务刚挂掉时这里会失败，状态轮询那边会把它标成 not running，不管 */
            }
        }
        void tick()
        const t = setInterval(() => void tick(), POLL_BACKEND)
        return () => {
            alive = false
            clearInterval(t)
        }
    }, [running])

    /* ── 推理方式：服务在跑问它，没跑读盘 ─────────────────── */
    useEffect(() => {
        let alive = true
        void (async () => {
            try {
                const v = await api.svsepInference()
                if (alive) setInferMode(asInferMode(v.mode))
            } catch {
                /* 读不到就留着 auto —— 跟后端缺省一致，不打扰用户 */
            }
        })()
        return () => {
            alive = false
        }
    }, [])

    /**
     * 改推理方式。
     *
     * 加速包（DirectML）跟着这一档走，所以这里没有第二个开关：后端写完盘就把
     * `._pth` 调好 —— 选 GPU 时若加速包还没下（A 卡 / 核显），它会顺手开始下，
     * 进度走下面那条现成的进度条（`dl.kind == 'dml'`）。
     */
    const doSetInfer = async (m: InferMode) => {
        const prev = inferMode
        setInferMode(m) // 先把按钮点亮，别让网络往返卡住手感
        try {
            const v = await api.svsepSetInference(m)
            setInferMode(asInferMode((v.mode as string) ?? m))
            /* 选了 GPU 而加速包还没下：后端已经在下了（24 MB），说一声 —— 用户得知道
               接下来那几十秒在干嘛，进度条就在下面。 */
            onToast(
                v.dmlDownloading
                    ? '推理方式：GPU（正在下载显卡加速包，下完自动生效）'
                    : `推理方式：${INFER_LABEL[m]}（下次分离生效）`,
                'ok',
            )
        } catch (e) {
            setInferMode(prev) // 没存下来就把按钮弹回去
            onToast(errText(e), 'err')
        }
    }

    /* ── 任务轮询：任务没结束就一直问 ───────────────────── */
    const taskId = task?.id
    const settled =
        !!task &&
        (task.status === 'done' ||
            task.status === 'error' ||
            task.status === 'failed' ||
            /* 上游的取消写 `cancelled`（`task_manager.py`），漏了它就会一直轮询下去 */
            task.status === 'cancelled')
    useEffect(() => {
        if (!taskId || settled) return
        let alive = true
        let fails = 0
        const t = setInterval(async () => {
            try {
                const v = await api.svsepTask(taskId)
                if (!alive) return
                setTask(v)
                if (v.status === 'done') {
                    /* 上游「done 但没有产出」= 处理失败被吞了（见下面那块 Finding），别报成「完成」 */
                    const n = (v.outputs ?? []).length
                    onToast(n ? '分离完成' : '分离结束，但没有产出（读不出这段音频）', n ? 'ok' : 'warn')
                } else if (v.status === 'error' || v.status === 'failed') {
                    onToast(v.error || v.message || '分离失败', 'err')
                }
                fails = 0
            } catch (e) {
                /* 轮询自己失败不算任务失败：接着问。问到次数上限才报一次并收手 */
                if (!alive || ++fails < POLL_GIVE_UP) return
                alive = false
                clearInterval(t)
                onToast(`读不到分离进度：${errText(e)}`, 'err')
            }
        }, POLL_STATUS)
        return () => {
            alive = false
            clearInterval(t)
        }
    }, [taskId, settled, onToast])

    /* ── 两个模型都在？ ─────────────────────────────────── */
    /* ⚠️ `?.` 只能挡到它左边那一层：`st?.models.uvr.state` 在 `models` 存在而
       `models.uvr` 不存在（后端字段改名、或者回包缺字段）时照样抛
       `Cannot read properties of undefined (reading 'state')`。
       抛在这里 = 整棵 React 树卸载（导航也一起消失），下面几页全黑。
       所以每一层都要 `?.`，显示用的地方给兜底值。
       ⚠️ **`models` 是对象、模型列表在 `models.items[]` 里**（`svsep.rs::models_status()`）：
       写成 `st?.models?.uvr?.state` 会恒为 `false` —— 模型明明在盘上，
       界面照样说「缺失」并把「下载模型」按钮一直摆着。 */
    const modelItems = st?.models?.items ?? []
    const modelsOk = modelItems.length > 0 && modelItems.every((m) => m.state === 'ok')
    const runtimeReady = !!st?.runtimeReady
    const dl = st?.download
    const dlPct = dl && dl.total > 0 ? Math.min(100, Math.round((dl.done / dl.total) * 100)) : 0

    /* 缺哪样、还要下多少 —— 数字全部来自后端（字节），**不要在界面里硬编码容量** */
    /* 压缩包大小（下的是 zip），与解压后的大小是两回事 —— 两个数都给用户看 */
    const steps = useMemo(() => (st ? plan(st) : []), [st, plan])
    /** 那颗大按钮的文案；`null` = 全装好了，那时不画按钮（上面那排 Stat 就是摘要） */
    const installText = installLabel(steps)
    /** 下一步那颗包在盘上已经有手放的整套了 → 按钮是「解压」，图标也跟着换 */
    const nextIsManual = !!missingSteps(steps)[0]?.manual
    /** 删依赖之后要重新下多少 —— 与安装按钮同一个来源 */
    const allBytes = steps.reduce((n, s) => n + (s.bytes || 0), 0)

    const inference = (backend?.inference || {}) as Record<string, unknown>
    const acceleration = (backend?.acceleration || {}) as Record<string, unknown>
    const queues = (backend?.queues || {}) as Record<string, { waiting?: number; processing?: number }>
    const badge =
        (typeof backend?.inference_badge === 'string' && backend.inference_badge) ||
        (typeof acceleration.badge === 'string' && acceleration.badge) ||
        (typeof inference.badge === 'string' && inference.badge) ||
        ''

    const outputs = useMemo(() => task?.outputs ?? [], [task])
    /** 分离结果的落盘根目录（由后端给）；播放与下载都要用它拼路径 */
    const outputsDir = st?.outputsDir ?? ''

    /**
     * 把输出目录放行给 **asset 协议**。
     *
     * ⚠️ **这条不能省**：asset 协议的 scope 是空的（用户挑的目录在编译期不可能知道），
     * 而分离产物不是用户「刚选的那个文件」—— 漏了放行时 `<audio>` 会**静默**不播、
     * 控制台只留一条 403，看着就像「播放器坏了」。放行是幂等的，重复调无害。
     */
    useEffect(() => {
        if (!outputsDir) return
        void api.allowPath(outputsDir).catch(() => {
            /* 放行失败不该打断这一页：真播不出来时那条 403 会露出来 */
        })
    }, [outputsDir])

    /* ── 动作 ───────────────────────────────────────────── */

    /* 打开输出目录。状态还没回来时 `outputsDir` 是空串 —— 直接丢给后端只会得到
       「缺少 path」的 Err，被 `void` 吞掉之后界面上没有任何反应。所以这里既不发
       空请求，也把失败弹出来（目录被删掉 / 被占用都要让用户知道）。 */
    const openOutputs = () => {
        if (!outputsDir) return
        void api.fsOpen({path: outputsDir}).catch((e) => onToast(errText(e), 'err'))
    }

    /* 暂停：`.part` 留着，下次点下载会带 Range 接着下。
       ⚠️ 后端是在**下一块数据到达时**才收手，所以按钮按下去到进度条停住之间
       还有一两秒 —— toast 说的是「正在暂停」，不是「已暂停」。 */
    const doPauseDownload = async () => {
        try {
            await api.svsepPauseDownload()
            onToast('正在暂停…下载的进度会留着，下次接着下', 'info')
        } catch (e) {
            onToast(errText(e), 'err')
        }
    }

    /* 停止：连 `.part` 一起删掉，下次从头下。
       界面必须把这句说清楚 —— 「暂停」和「停止」的全部区别就在于要不要重下 4.7 GB。 */
    const doStopDownload = async () => {
        try {
            await api.svsepStopDownload()
            onToast('已停止下载，半个包也删掉了，下次从头下', 'info')
        } catch (e) {
            onToast(errText(e), 'err')
        }
    }

    /** 进度条标签上「正在装什么」—— 优先用安装循环正在装的那一步，退回下载状态里的种类 */
    const stepName =
        installer.stepLabel ||
        (dl?.kind === 'runtime'
            ? '运行时'
            : dl?.kind === 'models'
                ? '模型'
                : dl?.kind === 'dml'
                    ? '显卡加速包'
                    : '')
    /** 安装失败要显示的那句话：循环自己撞上的错优先，否则是后端留下的那一句 */
    const installError = installer.error || dl?.error || null

    /* 一键删掉所有下下来的依赖（模型 730 MB + 运行时 7.4 GB + ffmpeg）。
       ⚠️ **不用 `window.confirm`**：它和整站的界面风格不是一套。做成**两段式按钮**
       —— 第一下把按钮变成「确认删除（要重下 8 GB）」，第二下才真删；旁边有「算了」。
       点别处不清除，所以这个态一直立着，直到用户切走再回来（页面重建）。
       几万个文件，后端在后台删，进度看 st.download.delete。 */
    const doDeleteDeps = async () => {
        if (!armDelete) {
            setArmDelete(true)
            return
        }
        setArmDelete(false)
        try {
            await api.svsepDeleteDeps()
            onToast('开始删除依赖文件，删完要重新下载才能用离线分离', 'warn')
            void refresh()
        } catch (e) {
            onToast(errText(e), 'err')
        }
    }

    /* 取消删除：已经删掉的不会回来，只是不再往下删。后端收手要等当前这一批走完，
       所以进度条照旧转，直到 `dl.delete.active` 自己变 false。 */
    const doStopDeleteDeps = async () => {
        try {
            await api.svsepStopDeleteDeps()
            onToast('正在取消删除…已删掉的文件不会恢复', 'info')
            void refresh()
        } catch (e) {
            onToast(errText(e), 'err')
        }
    }

    const doSeparate = async () => {
        if (!file) {
            onToast('先选一个音频文件', 'warn')
            return
        }
        setBusy(true)
        try {
            /* 服务没起就顺手起一下（后端 `separate` 里也做了这件事，这里做是为了
               「正在启动…」这段等待有反馈 —— 起 Python 要十几秒）。跑完之后服务会
               自己关掉：Rust 那边 `auto_stop_when_idle`。 */
            if (!running) {
                onToast('正在启动分离服务（第一次要十几秒）…', 'info')
                await api.svsepStart()
                await refresh()
            }
            const res = await api.svsepSeparate(engine, file.path)
            setTask(res.task ?? null)
            onToast('已提交，开始分离', 'ok')
        } catch (e) {
            onToast(errText(e), 'err')
        } finally {
            setBusy(false)
        }
    }

    const doCancel = async () => {
        if (!task) return
        try {
            await api.svsepCancel(task.id)
            onToast('已请求取消', 'info')
        } catch (e) {
            onToast(errText(e), 'err')
        }
    }

    const previewOne = (i: number) => {
        if (!task) return
        const el = audioRef.current
        if (!el) return
        // 按**文件名**取：落盘在 `<outputsDir>/<task_id>/<文件名>`，服务跑完就关了，这条路读磁盘
        const o = (task.outputs ?? [])[i]
        if (!o?.filename || !outputsDir) return
        const url = svsepFileUrl(outputsDir, task.id, o.filename)
        setPreviewIdx(i)
        /* 换 source 后要显式 load，不然改了 src 的播放器不会自己重载 */
        el.src = url
        el.load()
        void el.play().catch(() => {
            /* 浏览器可能因为没交互过而拒绝自动播放，用户自己点播放键就行 */
        })
    }

    const [previewIdx, setPreviewIdx] = useState<number | null>(null)
    const audioRef = useRef<HTMLAudioElement>(null)

    /**
     * 选音频：**系统「打开」对话框** + 把文件直接拖进窗口。
     *
     * ⚠️ 两条路给的都是**磁盘上的真路径**（拖放那條来自 Tauri 的 `DragDropEvent`，
     * 不是 HTML5 的 `DataTransfer`）—— 后端要的就是一个路径，不用再搬一遍字节。
     */
    const {
        pick,
        dropProps,
        dragging,
        busy: picking,
    } = useFilePick({
        exts: ['mp3', 'wav', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma'],
        label: '音频文件',
        title: '选一个音频文件',
        onPaths: (paths) => {
            const p = paths[0]
            if (!p) return
            setFile({path: p, name: baseName(p)})
            setTask(null)
            setPreviewIdx(null)
        },
        onToast,
    })

    /* ── 渲染 ───────────────────────────────────────────── */

    return (
        <div className="page-body svsep-layout" {...dropProps}>
            {/* ══════════════ 左栏：素材 + 模式 ══════════════ */}
            <div className="svsep-col">
                <Panel>
                    <PanelHead
                        title={t("音频素材")}
                        desc="交给分离引擎"
                        extra={file ? <Chip tone="ok">{t("已选")}</Chip> : <Chip>{t("未选")}</Chip>}
                    />
                    {/*
            系统「打开」对话框（`pick_paths`），**不画自制的虚线落区** ——
            跟别的页一个长相：一个「选音频文件」按钮 + 一条「也可以拖进来」的提示。
            ⚠️ 拖进来的也是**真路径**。
          */}
                    <div className="btn-row">
                        <Button icon="folder" loading={picking} onClick={() => void pick()}>
                            {file ? '换一个音频文件' : '选音频文件'}
                        </Button>
                    </div>
                    <p className="hint">
                        {file
                            ? `已选：${file.name}`
                            : '支持 mp3 / wav / flac / m4a / aac / ogg / wma'}
                    </p>
                    <DropHint dragging={dragging} text="音频文件也可以直接拖进这个窗口"/>
                    {file && (
                        <div className="btn-row">
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() => {
                                    setFile(null)
                                    setTask(null)
                                }}
                            >
                                清空
                            </Button>
                        </div>
                    )}
                    <p className="hint">
                        上限 {formatBytes(MAX_UPLOAD)}；超过先在「音频工具」里裁一段。
                    </p>
                </Panel>

                {localOk ? (
                    <Panel>
                        <PanelHead title={t("分离模式")} desc="两种引擎产出不同"/>
                        <div className="choice-grid">
                            {ENGINES.map((e) => (
                                <button
                                    key={e.id}
                                    type="button"
                                    className="choice"
                                    aria-pressed={engine === e.id}
                                    onClick={() => setEngine(e.id)}
                                >
                                    <span className="choice-head">
                                        <span className="choice-label">{e.name}</span>
                                        {engine === e.id && <Chip tone="accent">{t("已选")}</Chip>}
                                    </span>
                                    <span className="choice-desc">{e.desc}</span>
                                    <span className="svsep-cost">{e.cost}</span>
                                </button>
                            ))}
                        </div>
                        <p className="hint">{ESTIMATE_NOTE}。</p>

                        <div className="btn-row">
                            <Button
                                variant="primary"
                                icon="play"
                                loading={busy}
                                disabled={!file || !modelsOk || !runtimeReady}
                                onClick={() => void doSeparate()}
                            >
                                开始分离
                            </Button>
                            {task && !settled && (
                                <Button variant="ghost" icon="x" onClick={() => void doCancel()}>
                                    取消
                                </Button>
                            )}
                        </div>
                    </Panel>
                ) : (
                    /* 这一栏原本是「选哪套模型 + 开始分离」。引擎在这个平台不存在，
                    留着两颗按钮只会让用户以为「下了就能用」—— 说清并指向在线那条路。 */
                    <Panel>
                        <PanelHead title={t("离线引擎")} desc={t("这个平台没有它的运行时包")}/>
                        <Finding level="warn" title={t("本平台用不了离线分离")}>
                            {/* 原因那句话来自后端（`platform.rs::caps` 的 `why`），所以键就是它的中文原文 */}
                            {t(localEngine?.why ?? '这个平台没有离线分离的运行时包')}。
                            {t("分离请用右栏的「在线分离：MVSEP」—— 那条路与本平台无关。")}
                        </Finding>
                    </Panel>
                )}

                <Panel>
                    <PanelHead title={t("分离完做什么")}/>
                    <ol className="svsep-steps">
                        <li>{t("在右边试听每一轨，确认分得干净。")}</li>
                        <li>{t("「下载」存到系统下载目录；也可点「打开输出目录」直接看。")}</li>
                        <li>
                            要变调、变速、转格式，把它带回
                            <button type="button" className="dep-link" onClick={() => onNavigate('audio')}>
                                音频工具
                            </button>
                            。
                        </li>
                        <li>
                            歌词要对轨、做动态歌词视频，去
                            <button type="button" className="dep-link" onClick={() => onNavigate('lyrics')}>
                                网易云专栏
                            </button>
                            与
                            <button type="button" className="dep-link" onClick={() => onNavigate('pv')}>
                                文字 PV
                            </button>
                            。
                        </li>
                    </ol>
                </Panel>
            </div>

            {/* ══════════════ 右栏：状态 + 任务 + 在线 ══════════════ */}
            <div className="svsep-col">
                <Panel>
                    <PanelHead
                        title={t("离线引擎")}
                        extra={running ? <Chip tone="ok">{t("运行中")}</Chip> : <Chip>{t("空闲")}</Chip>}
                    />
                    {/* 没有引擎的平台上「运行时：缺失 / 模型：缺失」是会误导人的 ——
                        那两格看着像「下完就能用」，而这里根本没有可下的包。 */}
                    {!localOk && (
                        <Finding level="warn" title={t("这个平台没有离线引擎")}>
                            {t(localEngine?.why ?? '这个平台没有离线分离的运行时包')}。
                            {t("下面的「在线分离：MVSEP」照常用。")}
                        </Finding>
                    )}
                    {localOk && (
                        <div className="svsep-stats">
                            <Stat
                                label="服务"
                                value={running ? '运行中' : '空闲'}
                                sub="分离时自动启动，跑完自动关"
                            />
                            <Stat
                                label="运行时"
                                value={runtimeReady ? '就绪' : '缺失'}
                                /* ⚠️ `expectedBytes` 是**解压后**的容量（7.4 GB），要下的是 4.7 GB 的压缩包。
                                   缺的时候两个数都给，不然用户会以为要下 7.4 GB。 */
                                sub={
                                    runtimeReady
                                        ? undefined
                                        : `下 ${formatBytes(downloadBytes(st?.runtime))} · 解压 ${formatBytes(extractedBytes(st?.runtime))}`
                                }
                            />
                            <Stat
                                label="模型"
                                value={modelsOk ? '就绪' : '缺失'}
                                sub={
                                    modelsOk
                                        ? modelItems.map((m) => formatBytes(m.size)).join(' + ')
                                        : `下 ${formatBytes(downloadBytes(st?.models))} · 解压 ${formatBytes(extractedBytes(st?.models))}`
                                }
                            />
                            {badge && <Stat label="设备" value={badge}/>}
                        </div>
                    )}

                    {dl && (installer.installing || dl.active) && (
                        /* 下载与解压共用这一条进度条，标签必须说清是哪一段：解压的分母跟
                           整包字节数差不多大，只写「正在下载…」就成了「下到 100% 又归零
                           重爬」，看着像下完又重下了一遍（见 api.ts 里 `stage` 的注释）。
                           解压那一段**没有**暂停/停止可点（解压不吃 `ctl`，按了也不会停），
                           所以那时候不传动作 —— 留着两个按不动的按钮比没有更糟。 */
                        <DownloadProgress
                            label={dl.stage === 'extract' ? '正在解压…' : `正在装${stepName}…`}
                            done={dl.done}
                            total={dl.total}
                            pct={dl.total > 0 ? dlPct : null}
                        >
                            {dl.stage !== 'extract' ? (
                                <>
                                    <Button icon="pause" onClick={() => void doPauseDownload()}>
                                        暂停
                                    </Button>
                                    <Button variant="ghost" icon="x" onClick={() => void doStopDownload()}>
                                        停止（删掉已下的）
                                    </Button>
                                </>
                            ) : null}
                        </DownloadProgress>
                    )}
                    {installError && (
                        <Finding level="warn" title={t("安装失败")}>
                            {installError}
                        </Finding>
                    )}
                    {/* 删到一半就别让用户以为卡住了 —— 几万个文件，几十秒很正常 */}
                    {dl?.delete?.active && (
                        <div className="dep-progress">
                            <div className="dep-progress-head">
                                <span>{t("正在删除依赖文件…")}</span>
                                <span className="dim">{dl.delete.files} 个 / {formatBytes(dl.delete.bytes)}</span>
                            </div>
                            <ProgressBar pct={null}/>
                            <div className="btn-row">
                                <Button variant="ghost" icon="x" onClick={() => void doStopDeleteDeps()}>
                                    停止删除
                                </Button>
                            </div>
                        </div>
                    )}

                    {/* ── 一个按钮：把还缺的包按顺序装完 ──────────────────
              顺序是「运行时 → 模型 →（没有 N 卡时）显卡加速包」，中间不需要再点
              任何东西（状态机在 `lib/useInstaller.ts`）。
              全装好之后这颗按钮**不出现** —— 上面那排 Stat 就是状态摘要。 */}
                    {/* 只在有引擎的平台上给安装入口 —— 别的平台这颗按钮会去下 4.9 GB
                        的 Windows 运行时包（后端也拒，但不该让用户点到）。 */}
                    {localOk && installText && (
                        <div className="btn-row">
                            <Button
                                variant="primary"
                                icon={nextIsManual ? 'package' : 'download'}
                                loading={installer.installing}
                                disabled={!!dl?.active || !!dl?.delete?.active}
                                onClick={() => installer.install()}
                            >
                                {installText}
                            </Button>
                        </div>
                    )}
                    {/* 下得慢的那条退路：123 云盘。**只在还没装齐时才提** —— 装好了还劝人去
                        下载就成了噪音。落点用后端给的当前扩展包根（设置里改了它跟着变）。 */}
                    {localOk && installText && (
                        <ManualPacks
                            dir={st?.extDir}
                            what="网盘上那几个包（运行时整包或分卷、models.zip、A 卡 / 核显的显卡加速包 .whl）"
                            onToast={onToast}
                        />
                    )}

                    {/* 推理方式（自动 / GPU / CPU）：原版软件在标题栏上就有这个三选一。
               服务开着时改它立刻转给 Python（它清了引擎单例，下个任务按新方式来）；
               服务关着时写盘上的 `inference_settings.json`，下次分离读它。
               ⛔ 别再加「显卡加速」「六轨也用」那种开关：加速包该不该生效**由这一档
               推出来**（后端 `svsep::apply_infer_mode`）—— 分成两处，用户就得在两处
               做同一个决定，还可能出现「选了 GPU 但加速没开」这种自相矛盾的状态。
               选 GPU 时后端会顺手把没下的加速包下上（A 卡 / 核显）。 */}
                    {localOk && (
                        <div className="btn-row">
                            <div className="svsep-infer">
                                <span className="dim">{t("推理方式")}</span>
                                <SegmentedControl
                                    aria-label={t("推理方式")}
                                    items={INFER_MODES}
                                    value={inferMode}
                                    onValueChange={(v: string) => void doSetInfer(asInferMode(v))}
                                />
                            </div>
                            <Button
                                variant="ghost"
                                icon="folder"
                                disabled={!outputsDir}
                                onClick={openOutputs}
                            >
                                输出目录
                            </Button>
                        </div>
                    )}
                    {st?.dml?.nvidia && (
                        <p className="hint">{t("检测到 NVIDIA 显卡：选 GPU（或自动）就走 CUDA，不需要加速包。")}</p>
                    )}
                    {/* 上次暂停过（或者上次下载到一半被关掉了）：状态里只有一句「有半个包」，
              而用户真正需要知道的是「再点就是接着下，已经下过的那部分还在」 */}
                    {dl?.resumable && !dl.active && (
                        <p className="hint">
                            {dl.pausedKind === 'runtime' ? '运行时' : '模型'}已下好{' '}
                            {formatBytes(dl.pausedBytes)}，点「继续安装」会接着下。
                        </p>
                    )}
                    {/* 一键删依赖：几万个文件，后端在后台删，进度看 st.download.delete。
                        不做条件渲染 —— 引擎还没下全的时候也该留着这个入口，用户可能想
                        把之前下了一半的东西清掉。 */}
                    {localOk && (
                        <DangerZone
                            label="删除全部依赖"
                            armed={armDelete}
                            onArm={() => setArmDelete(true)}
                            onCancel={() => setArmDelete(false)}
                            onConfirm={() => void doDeleteDeps()}
                            confirmText={`确认删除（要重下约 ${formatBytes(allBytes)}）`}
                            armedText={
                                <>
                                    要删掉：运行时（解压后 {formatBytes(extractedBytes(st?.runtime))}）、模型（解压后{' '}
                                    {formatBytes(extractedBytes(st?.models))}）、分离引擎自带的 ffmpeg。
                                    删完离线分离就用不了了，得重新下 <strong>约 {formatBytes(allBytes)}</strong>。
                                    已经分离出来的音频<strong>{t("不会被删")}</strong>。
                                </>
                            }
                            idleText={
                                <>
                                    离线分离的引擎和模型约占{' '}
                                    {formatBytes(extractedBytes(st?.runtime) + extractedBytes(st?.models))}。
                                </>
                            }
                        />
                    )}
                    {st?.lastError && (
                        <Finding level="warn" title={t("上次启动失败")}>
                            {st.lastError}
                        </Finding>
                    )}
                    {err && (
                        <Finding level="warn" title={t("读不到分离状态")}>
                            {err}
                        </Finding>
                    )}
                </Panel>

                <Panel>
                    <PanelHead
                        title={t("分离进度")}
                        extra={
                            task ? (
                                <JobStatusChip status={svsepTaskStatus(task.status)}/>
                            ) : (
                                <Chip>{t("待提交")}</Chip>
                            )
                        }
                    />
                    {!task ? (
                        <p className="empty">{t("左边选好文件与模式，点「开始分离」。")}</p>
                    ) : (
                        <>
                            <div className="dep-progress">
                                <div className="dep-progress-head">
                                    <span>{task.message || '处理中…'}</span>
                                    <span className="dim">{Math.round(task.progress || 0)}%</span>
                                </div>
                                <ProgressBar pct={Math.min(100, task.progress || 0)}/>
                            </div>
                            {!settled && (
                                <p className="hint">
                                    百分比是按时间估的，会停在 90% 再跳到 100%；「已用时 N 秒」才是真信息。
                                </p>
                            )}
                            {task.error && <Finding level="warn" title={t("分离失败")}>{task.error}</Finding>}
                            {/* ⚠️ 上游把「处理失败」也标成 done：`separator_engine` 吞掉异常、回一个空结果，
                 于是任务收场是「完成 100%」而 `outputs` 是空的。不单独处理的话界面什么都不显示，
                 看着就是「点了没反应」—— 读不出音频时就是这个下场。 */}
                            {task.status === 'done' && outputs.length === 0 && (
                                <Finding level="warn" title={t("没有分离出结果")}>
                                    引擎读不出这段音频，换个文件或换个格式再试。
                                </Finding>
                            )}

                            {outputs.length > 0 && (
                                <>
                                    <ResultTracks
                                        outputs={outputs}
                                        taskId={task.id}
                                        outputsDir={outputsDir}
                                        audioRef={audioRef}
                                        previewIdx={previewIdx}
                                        onPreview={previewOne}
                                    />
                                    <div className="btn-row">
                                        <Button
                                            size="sm"
                                            icon="folder"
                                            disabled={!outputsDir}
                                            onClick={openOutputs}
                                        >
                                            打开输出目录
                                        </Button>
                                    </div>
                                </>
                            )}
                        </>
                    )}
                </Panel>

                <Panel>
                    <PanelHead
                        title={t("在线分离：MVSEP")}
                        desc="效果最好；音频会上传到 MVSEP 服务器"
                        extra={<Chip tone="warn">{t("需上传")}</Chip>}
                    />
                    <Finding level="warn" title={t("隐私提示")}>
                        上传的音频会发到 MVSEP 的服务器；介意就用离线引擎。
                    </Finding>
                    <p className="svsep-url">{MVSEP_URL}</p>
                    <div className="btn-row">
                        <Button icon="external" onClick={() => void api.fsOpen({url: MVSEP_URL})}>
                            打开 MVSEP
                        </Button>
                    </div>
                    <p className="hint">
                        要登录才能下结果；拿回来的音频可以直接拖进左边当素材。
                    </p>
                </Panel>

                {localOk && queues && (queues.uvr || queues.roformer) && (
                    <Panel>
                        <PanelHead title={t("引擎队列")} desc="本地任务是串行的，一次只跑一个"/>
                        <div className="svsep-stats">
                            <Stat
                                label="二轨（UVR）"
                                value={`排队 ${queues.uvr?.waiting ?? 0}`}
                                sub={`在跑 ${queues.uvr?.processing ?? 0}`}
                            />
                            <Stat
                                label="六轨（RoFormer）"
                                value={`排队 ${queues.roformer?.waiting ?? 0}`}
                                sub={`在跑 ${queues.roformer?.processing ?? 0}`}
                            />
                        </div>
                    </Panel>
                )}

                {/* 许可与出处：离线引擎是别人的项目，许可就摆在它旁边 */}
                <Credit
                    desc="离线分离用的是第三方引擎"
                    tags={
                        <>
                            <Chip tone="accent">{t("B站炽阳001")}</Chip>
                            <Chip>UVR5</Chip>
                        </>
                    }
                    items={[
                        {label: '代码', value: 'MIT', sub: 'audio-separator 0.39.1'},
                        {label: '模型', value: 'UVR', sub: 'BS-RoFormer / MDX，@Anjok07 训练'},
                    ]}
                >
                    离线引擎是{' '}
                    <Upstream href="https://github.com/nomadkaraoke/python-audio-separator">
                        nomadkaraoke/python-audio-separator
                    </Upstream>
                    （MIT，作者 Andrew Beveridge）。
                    它调用的 UVR 系列模型由 @Anjok07 训练，许可见模型自己带的那份说明。
                </Credit>

                {/* ── 装之前先定落点（**只问一次**）─────────────────────
            运行时 7.4 GB + 模型 0.7 GB，默认落在 C 盘的可写目录里；用户可能想挪到
            别的盘 —— 所以第一次下载之前问一次，选完/确认完才开始下。
            ⚠️ 这一问与「设置 → 扩展包目录」、以及人声转 MIDI 页那一问**是同一件事**
            （同一个根），实现只有 `lib/extDir.tsx` 一份 —— 三处各写一遍必然漂开。 */}
                <ExtDirAsk/>
            </div>
        </div>
    )
}
