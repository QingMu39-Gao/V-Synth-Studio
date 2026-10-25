import * as React from 'react'
import {useCallback, useEffect, useMemo, useRef, useState} from 'react'
import {Button, IconButton} from '@/components/Button'
import {errText, formatDuration} from '@/lib/format'
import {fileUrl, readFileBytes} from '@/lib/ipc'
import './WaveEditor.css'

/* ── 时间码：秒 ↔ `1:23.456` ──────────────────────────────────────────
   这不是时钟时间（HH:MM:SS），也不是任务进度那种时长格式，
   只有波形编辑器的起点 / 终点输入框用它。 */

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


/* ══════════════════════════════════════════════════════════ 波形编辑器 ══ */

/** 一段选区（秒）。**数据模型只有分段** —— 选区就是「当前选中的那段」 */
export interface Seg {
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

/**
 * 取回文件并算出波形包络（`[min0,max0,min1,max1,…]`，每桶 2ms）。
 *
 * 字节走 **asset 协议**（`readFileBytes` → `convertFileSrc` + XHR）。
 * **别改成浏览器的网络请求 API**：验收判据是前端 `grep` 那个调用为 0
 * （见 `lib/ipc.ts` 的 `readFileBytes`）。
 *
 * `decodeAudioData` 把整段 PCM 解进内存（20 分钟立体声 44.1kHz ≈ 423MB），超过
 * `MAX_DECODE_SEC` 就直接不画，选段、分段、导出照常可用；要支持更长的文件，让后端加
 * 一条「ffmpeg 输出 8kHz 单声道 WAV」的命令，前端只解那个小文件。
 * 这段**不能搬进 Worker**：Chromium 不在 Worker 里提供 Web Audio，解码过不去，
 * 而把声道数据搬过去要多复制一份 423MB —— 比省下的那不到 300ms 更亏。
 */
async function loadPeaks(path: string, durationSec: number): Promise<Float32Array> {
    if (durationSec > MAX_DECODE_SEC) {
        throw new Error(`文件超过 ${MAX_DECODE_SEC / 60} 分钟，为省内存不画波形`)
    }
    const raw = await readFileBytes(path)
    const Ctx = window.AudioContext
    if (!Ctx) throw new Error('这个环境不提供音频解码')
    const ac = new Ctx()
    try {
        const buf = await ac.decodeAudioData(raw)
        return computePeaks(buf)
    } finally {
        /* 不关掉会一直占着一个音频输出设备，开几次就「设备被占用」 */
        void ac.close().catch(() => {
        })
    }
}

/**
 * 混单声道 + 分桶 min/max。只留包络不留 PCM（20 分钟 ≈ 4.8MB）。
 *
 * ⚠️ 内层按**声道数特化**：每样本走一次 `for (const data of channels)` 在 20 分钟
 * 立体声上要 282ms，摊成两个取样点是 74ms（同一份数据实测，结果逐桶相同）。
 */
function computePeaks(buf: AudioBuffer): Float32Array {
    const channels: Float32Array[] = []
    for (let c = 0; c < buf.numberOfChannels; c += 1) channels.push(buf.getChannelData(c))
    const len = buf.length
    const buckets = Math.max(1, Math.ceil((len / buf.sampleRate) * PEAKS_PER_SEC))
    const perBucket = len / buckets
    const peaks = new Float32Array(buckets * 2)
    const n = channels.length
    for (let b = 0; b < buckets; b += 1) {
        const from = Math.floor(b * perBucket)
        const to = Math.min(len, Math.floor((b + 1) * perBucket))
        let lo = 0
        let hi = 0
        if (n === 2) {
            const [l, r] = channels
            for (let i = from; i < to; i += 1) {
                const v = (l[i] + r[i]) * 0.5
                if (v < lo) lo = v
                else if (v > hi) hi = v
            }
        } else if (n === 1) {
            const m = channels[0]
            for (let i = from; i < to; i += 1) {
                const v = m[i]
                if (v < lo) lo = v
                else if (v > hi) hi = v
            }
        } else {
            for (let i = from; i < to; i += 1) {
                let v = 0
                for (const data of channels) v += data[i]
                v /= n
                if (v < lo) lo = v
                else if (v > hi) hi = v
            }
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
        text: v('--lg-label-tertiary', '#8a8f98'),
        /** 没波形时那条中轴线 */
        axis: separator,
    }
}

/**
 * 波形编辑器 —— 裁剪这件事本身全靠它。
 *
 * ## 有意收敛的范围
 *
 * **整段适应窗口**，坐标只有一套（没有缩放 / 平移）；播放交给 `<audio controls>`
 * + `timeupdate` 对齐播放头（没有自画的播放头 rAF 循环、没有「只播放选区」）；
 * 工具栏只有「剪刀模式 / 在播放头切开 / 撤销」三个。
 *
 * ## 不能省的
 *
 * 波形包络（2ms 一档）、时间轴刻度、分段底色、可拖两端把手、点一下跳转、
 * 剪刀切开、分段列表（选中 / 导出 / 删除）、整段还原、撤销、起点终点输入框双向同步、
 * `S` 切开 / `Ctrl+Z` 撤销 / `Delete` 删段，以及「画不出波形也能剪」的兜底提示 ——
 * **没波形也要能剪**是硬要求。
 */
export function WaveEditor({
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
    /**
     * 播放头**不进 state**：`timeupdate` 约 4 次/秒，每拍重渲染就会把波形按像素列重画。
     * `headRef` 是那条线本身（只改 transform），`headTime` 是给「在播放头切开」留的读数。
     */
    const headRef = useRef<HTMLDivElement>(null)
    const headTime = useRef(0)
    const [history, setHistory] = useState<Seg[][]>([])
    const [startText, setStartText] = useState(() => formatTimecode(segments[selected]?.start ?? 0))
    const [endText, setEndText] = useState(() => formatTimecode(segments[selected]?.end ?? 0))
    const [size, setSize] = useState({w: 600, h: CANVAS_H})

    const drag = useRef<{ kind: 'start' | 'end' } | null>(null)
    /** 已经试过解码的素材：失败的不要每次 `onChange` 都重试一遍 */
    const loaded = useRef('')

    /* 素材地址：`<audio src>` 与波形都认它一个（asset 协议，Range 是内置的）。
       ⚠️ 它是 `http://asset.localhost/...`，**只在那个文件被放行过之后**才读得到 ——
       用户是走系统对话框 / 拖放选进来的，`pick_paths` 已经顺手放行了。 */
    const url = usable && path ? fileUrl(path) : ''
    const sg = segments[selected] ?? {start: 0, end: 0}

    /* 回调放进 ref：父组件每次渲染都会给新函数，直接进依赖会导致反复解码 */
    const cb = useRef({onChange, onToast})
    cb.current = {onChange, onToast}

    /* ── 换素材：解码波形（分段由父组件按素材重置）── */
    useEffect(() => {
        if (!url || !duration || loaded.current === url) return
        loaded.current = url
        let alive = true
        setDecoding(true)
        setNote('')
        void loadPeaks(path, duration)
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
     * 新素材重置成 `[0, duration]`，同素材只是重新夹一遍范围。
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
            const next = [{start: 0, end: duration}]
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
            return changed ? {start, end} : s
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
            setSize({w, h: CANVAS_H})
        }
        measure()
        const ro = new ResizeObserver(measure)
        ro.observe(host)
        return () => ro.disconnect()
    }, [])

    /* ── 播放头 ──
       只写一个 transform。位置映射与波形同一套（`t / span * w`），
       尺寸或时长变了要重摆一次，所以 `placeHead` 的依赖就是这两个数。 */
    const placeHead = useCallback((t: number) => {
        headTime.current = t
        const el = headRef.current
        if (!el) return
        const x = (t / (duration || 1)) * size.w
        el.dataset.on = duration && x >= 0 && x <= size.w ? 'true' : 'false'
        el.style.transform = `translateX(${Math.round(x)}px)`
    }, [duration, size.w])
    useEffect(() => {
        placeHead(headTime.current)
    }, [placeHead])

    /* ── 重画 ──
       换主题时 `<html data-theme>` 变化，靠 `themeTick` 触发一次重画
       （canvas 拿不到 CSS 变量，只能把令牌取出来用）。 */
    const themeTick = useCanvasThemeTick()
    /* ⚠️ 调色板按主题缓存：每轮重画都 `getComputedStyle` + 逐条读令牌会强制样式重算 */
    const P = useMemo(() => palette(), [themeTick])
    useEffect(() => {
        const el = canvasRef.current
        const ctx = el?.getContext('2d')
        if (!el || !ctx) return
        const w = size.w
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

        /* 播放头不在这里画 —— 它是 `.wave-head` 那一根，移动只改 transform，
           免得每拍 `timeupdate` 把整段波形按列重算一遍。 */
    }, [peaks, segments, selected, sg.start, sg.end, size, duration, themeTick])

    /* ── 分段操作 ── */

    const pushHistory = () =>
        setHistory((h) => [...h, segments.map((s) => ({...s}))].slice(-UNDO_MAX))

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
        next.splice(i, 1, {start: s.start, end: t}, {start: t, end: s.end})
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
            const next = segments.map((x, n) => (n === i ? {start: a, end: b} : x))
            onChange(next, i)
            return
        }
        const a = Number.isFinite(start) ? clamp(start, segMin(i), s.end - MIN_SEG) : s.start
        const b = Number.isFinite(end) ? clamp(end, a + MIN_SEG, segMax(i)) : s.end
        const next = segments.map((x, n) => (n === i ? {start: a, end: b} : x))
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
            drag.current = {kind: 'start'}
            return
        }
        if (Math.abs(x - (sg.end / duration) * size.w) <= HIT) {
            pushHistory()
            drag.current = {kind: 'end'}
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
        placeHead(at)
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
        if (e.key.toLowerCase() === 's') splitAt(headTime.current)
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
        noteText = '选好文件后这里会显示波形。'
    } else if (note) {
        noteText = `${note}；仍然可以选段、分段、导出，只是看不见波形。`
        noteTone = 'warn'
    } else if (peaks) {
        noteText = `总长 ${formatDuration(duration)}。`
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
                <Button size="sm" title="在播放头的位置切开" onClick={() => splitAt(headTime.current)}>
                    在播放头切开
                </Button>
                <Button size="sm" variant="ghost" icon="refresh" disabled={!history.length} title="撤销上一次切开或删除"
                        onClick={undo}>
                    撤销
                </Button>
                <span className="spacer"/>
                <span className="hint">{`共 ${segments.length} 段`}</span>
            </div>

            <div className="wave-stage">
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
                <div className="wave-head" ref={headRef} style={{top: RULER_H, height: WAVE_H}}
                     aria-hidden="true"/>
            </div>

            <audio
                ref={audioRef}
                className="wave-audio"
                controls
                preload="metadata"
                src={url || undefined}
                onTimeUpdate={(e) => placeHead(e.currentTarget.currentTime)}
                onEnded={() => placeHead(sg.end)}
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
                <span className="spacer"/>
                <span className="audio-num-note">
          {`${formatDuration(Math.max(0, sg.end - sg.start))} · 共 ${segments.length} 段`}
        </span>
            </div>

            <p className="hint">
                时间按「分:秒.毫秒」填，例如 1:23.456（直接写 83 也认）。
                拖波形两端的把手裁剪，和输入框双向同步。
                剪刀模式下点波形等于在那里切开；快捷键 S = 在播放头切开，Ctrl+Z 撤销，Delete 删除选中段。
                裁剪结果固定导出 WAV。
            </p>

            {segments.length > 1 && (
                <div className="wave-segments">
                    <div className="wave-seg-head">
                        <span className="spacer"/>
                        <Button size="sm" variant="primary" icon="download"
                                onClick={() => onExportAll(segments, selected)}>
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
                            <span
                                className="wave-seg-time">{`${formatTimecode(s.start)} → ${formatTimecode(s.end)}`}</span>
                            <span className="wave-seg-dur">{formatDuration(s.end - s.start)}</span>
                            <span className="spacer"/>
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
            attributeFilter: ['data-theme'],
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
