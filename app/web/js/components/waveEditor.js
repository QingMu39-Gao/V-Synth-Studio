/**
 * 波形编辑器（音频页「裁剪片段」用）
 *
 * 原来裁剪是让人填两个裸秒数，看不见、听不着，剪出来才知道剪错没有。
 * 这里换成：波形时间轴 + 试听播放头 + 可拖动端点 + 剪刀分段 + 逐段导出。
 *
 * 数据模型只有一样东西：**分段数组 segments**。选区就是「当前选中的那一段」，
 * 它的左右边界就是两个可拖动的把手 —— 不额外维护一套 selection，
 * 两套边界迟早会对不上。
 *
 * 波形怎么来的：`/api/fs/raw` 把文件原样吐出来 → AudioContext.decodeAudioData
 * → 混成单声道 → 按 2ms 一桶算 min/max 包络，整段 PCM 随即丢掉。
 *
 * ponytail: 解码是同步的 O(n)，而且 decodeAudioData 先把整段 PCM 解到内存里
 * （20 分钟立体声 44.1kHz ≈ 423MB Float32），所以超过 MAX_DECODE_SEC 直接不画波形，
 * 其余功能（选段、分段、导出）照常可用。真要支持更长的文件，让后端加一个
 * 「ffmpeg 输出 8kHz 单声道 WAV」的路由，前端只解码那个小文件即可。
 */

import { h, mount, icon, toast, button, formatDuration } from '../ui.js'
import { formatTime } from '../timecode.js'

const RULER_H = 20
const WAVE_H = 100
const CANVAS_H = RULER_H + WAVE_H

const PEAKS_PER_SEC = 500 // 2ms 一个桶：放到最大也看不出方块
const MAX_DECODE_SEC = 1200 // 20 分钟，见文件头注释
const HIT = 7 // 把手的命中半径（px）
const MIN_SEG = 0.05 // 最短分段（秒），比这更短的切/拖都不给
const UNDO_MAX = 20

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

/** 波形包的读取地址 */
export function rawUrl(path) {
  return `/api/fs/raw?path=${encodeURIComponent(path)}`
}

/**
 * 取回文件并算出波形包络
 * @returns {Promise<Float32Array>} [min0,max0,min1,max1,…]，每桶 2ms
 */
async function loadPeaks(url, durationSec) {
  if (durationSec > MAX_DECODE_SEC) {
    throw new Error(`文件超过 ${MAX_DECODE_SEC / 60} 分钟，为省内存不画波形`)
  }
  const res = await fetch(url)
  if (!res.ok) throw new Error(`读不到音频数据（HTTP ${res.status}）`)
  const raw = await res.arrayBuffer()

  const Ctx = window.AudioContext || window.webkitAudioContext
  const ac = new Ctx()
  try {
    const buf = await ac.decodeAudioData(raw)
    return computePeaks(buf)
  } finally {
    // 不关掉会一直占着一个音频输出设备，开几次就「设备被占用」
    void ac.close().catch(() => {})
  }
}

/**
 * 混单声道 + 分桶 min/max。
 * 只留包络不留 PCM：20 分钟 = 1200s × 500 桶 × 2 float ≈ 4.8MB。
 */
function computePeaks(buf) {
  const channels = []
  for (let c = 0; c < buf.numberOfChannels; c++) channels.push(buf.getChannelData(c))
  const len = buf.length
  const buckets = Math.max(1, Math.ceil((len / buf.sampleRate) * PEAKS_PER_SEC))
  const perBucket = len / buckets
  const peaks = new Float32Array(buckets * 2)

  for (let b = 0; b < buckets; b++) {
    const from = Math.floor(b * perBucket)
    const to = Math.min(len, Math.floor((b + 1) * perBucket))
    let lo = 0
    let hi = 0
    for (let i = from; i < to; i++) {
      let v = 0
      for (const data of channels) v += data[i]
      v /= channels.length
      if (v < lo) lo = v
      if (v > hi) hi = v
    }
    peaks[b * 2] = lo
    peaks[b * 2 + 1] = hi
  }
  return peaks
}

function palette() {
  const cs = getComputedStyle(document.documentElement)
  const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback
  return {
    bg: v('--bg-1', '#0f131b'),
    dim: v('--bg-0', '#0a0d13'),
    grid: v('--border', 'rgba(255,255,255,0.075)'),
    line: v('--border-strong', 'rgba(255,255,255,0.14)'),
    wave: v('--text-2', '#6d7789'),
    waveDim: v('--text-3', '#4a5364'),
    waveSel: v('--accent', '#39c5bb'),
    accent: v('--accent', '#39c5bb'),
    selBg: v('--accent-dim', 'rgba(57,197,187,0.14)'),
    pink: v('--pink', '#ff4d94'),
    pinkDim: v('--pink-dim', 'rgba(255,77,148,0.14)'),
    text: v('--text-1', '#a5b0c2'),
  }
}

/**
 * @param {{onChange?:Function, onExport?:Function, onExportAll?:Function}} opts
 *   onChange({start,end,count,selected}) —— 选区变了（拖把手、切段、换段…）
 *   onExport({index,start,end,total})    —— 单段导出
 *   onExportAll()                        —— 全部导出
 */
export function createWaveEditor({ onChange, onExport, onExportAll } = {}) {
  /* ---------------------------------------------------------- 状态 */

  let url = ''
  let duration = 0 // 秒；0 = 还不知道
  let segments = [{ start: 0, end: 0 }]
  let selected = 0
  let peaks = null
  let note = ''
  let decoding = false

  let viewStart = 0
  let viewSpan = 1
  let width = 600
  let dpr = 1

  let scissors = false
  let onlySelection = false
  let playing = false
  let activeSeg = -1 // 播放头所在的分段（只在播放时更新）
  let audioTime = 0
  let raf = 0
  let drag = null
  let triedUrl = '' // 已经试过解码的 url：失败的不要每次探测都重试一遍

  const history = [] // 撤销栈：切开/删除前压一份快照

  /* ---------------------------------------------------------- DOM */

  const canvas = h('canvas.wave-canvas')
  const ctx = canvas.getContext('2d')
  const buf = document.createElement('canvas') // 静态层：波形/分段/把手，只有状态变了才重画
  const bctx = buf.getContext('2d')
  const audio = h('audio.wave-audio', { controls: true, preload: 'metadata' })
  const segList = h('div.seg-list')
  const noteEl = h('div.tiny.dim.wave-note')

  const playBtn = h('button.btn.btn-sm', { type: 'button', title: '播放 / 暂停（空格）' })
  const scissorsBtn = button('剪刀', { size: 'btn-sm', iconName: 'scissors', title: '点一下进入剪刀模式，再点波形就在那里切开' })
  const onlySelBtn = button('只播放选区', { size: 'btn-sm', title: '播放到选区末尾自动停' })
  const undoBtn = button('撤销', { size: 'btn-sm', variant: 'btn-ghost', iconName: 'refresh', title: '撤销上一次切开或删除' })

  const toolbar = h('div.wave-toolbar', [
    playBtn,
    button('适应窗口', { size: 'btn-sm', variant: 'btn-ghost', onClick: () => { fit(); drawStatic() } }),
    button('−', { size: 'btn-sm', variant: 'btn-ghost', title: '缩小', onClick: () => zoom(1 / 1.6) }),
    button('+', { size: 'btn-sm', variant: 'btn-ghost', title: '放大', onClick: () => zoom(1.6) }),
    h('div.spacer'),
    scissorsBtn,
    button('在播放头切开', { size: 'btn-sm', onClick: () => splitAt(audioTime) }),
    undoBtn,
    onlySelBtn,
  ])

  const wrap = h('div.wave-wrap', [canvas])
  const root = h('div.wave-editor', [toolbar, wrap, audio, noteEl, segList])

  /* ---------------------------------------------------------- 画布 */

  function fit() {
    viewStart = 0
    viewSpan = duration || 1
  }

  function zoom(factor, anchor = 0.5) {
    if (!duration) return
    const at = viewStart + viewSpan * anchor
    const next = clamp(viewSpan / factor, Math.min(duration, 0.05), duration)
    viewStart = clamp(at - next * anchor, 0, Math.max(0, duration - next))
    viewSpan = next
    drawStatic()
  }

  const xOf = (t) => ((t - viewStart) / viewSpan) * width
  const tOf = (x) => viewStart + (x / width) * viewSpan

  function resize() {
    const w = Math.max(120, wrap.clientWidth || 600)
    if (w === width && buf.width) return
    width = w
    dpr = Math.min(2, window.devicePixelRatio || 1)
    for (const [el, c] of [[canvas, ctx], [buf, bctx]]) {
      el.width = Math.round(width * dpr)
      el.height = Math.round(CANVAS_H * dpr)
      c.setTransform(dpr, 0, 0, dpr, 0, 0)
    }
    canvas.style.height = `${CANVAS_H}px`
    drawStatic()
  }

  /** 时间轴刻度间隔：挑一个让标签不至于挤在一起的值 */
  function tickStep() {
    const target = (viewSpan / width) * 70 // 每 70px 一个标签
    for (const step of [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800]) {
      if (step >= target) return step
    }
    return 3600
  }

  let P = null // 调色板缓存：draw() 每帧都要用，不能每帧 getComputedStyle
  let pTheme = '' // 缓存对应的主题：切换明暗后要重取一次，否则波形图还留着旧配色

  function drawStatic() {
    if (!buf.width) return
    P = palette()
    pTheme = document.documentElement.dataset.theme ?? ''
    const g = bctx
    g.clearRect(0, 0, width, CANVAS_H)

    // 背景 + 时间轴
    g.fillStyle = P.bg
    g.fillRect(0, 0, width, CANVAS_H)
    g.fillStyle = P.text
    g.font = '10px Consolas, monospace'
    g.textBaseline = 'middle'
    const step = tickStep()
    for (let t = Math.ceil(viewStart / step) * step; t <= viewStart + viewSpan; t += step) {
      const x = Math.round(xOf(t)) + 0.5
      g.strokeStyle = P.grid
      g.beginPath()
      g.moveTo(x, RULER_H - 5)
      g.lineTo(x, RULER_H)
      g.stroke()
      if (x > 2 && x < width - 30) g.fillText(formatTime(t).replace(/\.\d+$/, ''), x + 3, RULER_H / 2)
    }
    g.strokeStyle = P.grid
    g.beginPath()
    g.moveTo(0, RULER_H + 0.5)
    g.lineTo(width, RULER_H + 0.5)
    g.stroke()

    // 分段底色：选中的亮一点，正在播放的再叠一层
    for (const [i, sg] of segments.entries()) {
      const x0 = xOf(sg.start)
      const x1 = xOf(sg.end)
      if (x1 < 0 || x0 > width) continue
      if (i === selected) {
        g.fillStyle = P.selBg
        g.fillRect(x0, RULER_H, Math.max(1, x1 - x0), WAVE_H)
      }
      if (i === activeSeg) {
        g.fillStyle = P.pinkDim
        g.fillRect(x0, RULER_H, Math.max(1, x1 - x0), WAVE_H)
      }
    }

    // 波形本体：逐像素列取这一列覆盖的所有桶的 min/max
    const mid = RULER_H + WAVE_H / 2
    const half = WAVE_H / 2 - 3
    const total = peaks ? peaks.length / 2 : 0
    g.fillStyle = P.wave
    if (!peaks) {
      // 没波形也要能剪：画一条中轴线，剩下的交互一个不少
      g.strokeStyle = P.waveDim
      g.beginPath()
      g.moveTo(0, mid + 0.5)
      g.lineTo(width, mid + 0.5)
      g.stroke()
    } else {
      for (let x = 0; x < width; x++) {
        const t0 = viewStart + (x / width) * viewSpan
        const t1 = viewStart + ((x + 1) / width) * viewSpan
        let b0 = Math.floor(t0 * PEAKS_PER_SEC)
        let b1 = Math.max(b0 + 1, Math.ceil(t1 * PEAKS_PER_SEC))
        b0 = clamp(b0, 0, total - 1)
        b1 = clamp(b1, b0 + 1, total)
        let lo = 0
        let hi = 0
        for (let b = b0; b < b1; b++) {
          if (peaks[b * 2] < lo) lo = peaks[b * 2]
          if (peaks[b * 2 + 1] > hi) hi = peaks[b * 2 + 1]
        }
        const sg = segments[selected]
        const inSel = sg && t0 >= sg.start && t0 <= sg.end
        g.fillStyle = inSel ? P.waveSel : P.waveDim
        const yTop = mid - hi * half
        const yBot = mid - lo * half
        g.fillRect(x, yTop, 1, Math.max(1, yBot - yTop))
      }
    }

    // 分段边界 + 选中段的把手
    for (const [i, sg] of segments.entries()) {
      const x0 = xOf(sg.start)
      const x1 = xOf(sg.end)
      g.strokeStyle = i === selected ? P.accent : P.line
      g.lineWidth = i === selected ? 2 : 1
      for (const x of [x0, x1]) {
        if (x < -2 || x > width + 2) continue
        const px = Math.round(x) + 0.5
        g.beginPath()
        g.moveTo(px, RULER_H)
        g.lineTo(px, CANVAS_H)
        g.stroke()
      }
      g.lineWidth = 1
      if (i === selected) {
        // 把手：上下两个小方块，抓的时候有手感
        g.fillStyle = P.accent
        for (const x of [x0, x1]) {
          if (x < -6 || x > width + 6) continue
          const px = clamp(x, 3, width - 3)
          g.fillRect(px - 3, RULER_H, 6, 7)
          g.fillRect(px - 3, CANVAS_H - 7, 6, 7)
        }
      }
    }
  }

  /** 每帧只重画播放头：静态层直接贴过来 */
  function draw() {
    if (!canvas.width) return
    // 切换主题后调色板要重取（比字符串本身便宜得多的是偶尔比一次，而不是每帧 getComputedStyle）
    if (P && pTheme !== (document.documentElement.dataset.theme ?? '')) drawStatic()
    ctx.clearRect(0, 0, width, CANVAS_H)
    ctx.drawImage(buf, 0, 0, width, CANVAS_H)
    const x = Math.round(xOf(audioTime)) + 0.5
    if (x >= 0 && x <= width) {
      ctx.strokeStyle = P?.pink ?? '#ff4d94'
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.moveTo(x, RULER_H)
      ctx.lineTo(x, CANVAS_H)
      ctx.stroke()
      ctx.lineWidth = 1
    }
  }

  /* ---------------------------------------------------------- 分段 */

  function pushHistory() {
    history.push(segments.map((sg) => ({ ...sg })))
    if (history.length > UNDO_MAX) history.shift()
    undoBtn.disabled = false
  }

  function splitAt(t) {
    if (!duration) {
      toast('还没拿到文件时长，没法分段', 'warn')
      return
    }
    const i = segments.findIndex((sg) => t > sg.start + MIN_SEG && t < sg.end - MIN_SEG)
    if (i < 0) {
      toast('这个位置切不了：不在任何分段里，或者离端点太近', 'warn')
      return
    }
    pushHistory()
    const sg = segments[i]
    segments.splice(i, 1, { start: sg.start, end: t }, { start: t, end: sg.end })
    selected = i + 1
    syncAll()
  }

  function removeSegment(i) {
    if (segments.length <= 1) {
      toast('只剩一段了，删掉就没有可导出的内容', 'warn')
      return
    }
    pushHistory()
    segments.splice(i, 1)
    selected = clamp(selected, 0, segments.length - 1)
    syncAll()
  }

  function undo() {
    const prev = history.pop()
    if (!prev) {
      toast('没有可撤销的操作', 'warn')
      return
    }
    segments = prev
    selected = clamp(selected, 0, segments.length - 1)
    undoBtn.disabled = history.length === 0
    syncAll()
  }

  function select(i) {
    if (i < 0 || i >= segments.length) return
    selected = i
    syncAll()
  }

  /**
   * 第 i 段的可动范围：被左右邻居夹住。
   * 分段是文件的一个划分，重叠了「全部导出」就会导出两遍同一段音频。
   */
  const segMin = (i) => (i > 0 ? segments[i - 1].end : 0)
  const segMax = (i) => (i < segments.length - 1 ? segments[i + 1].start : duration || Infinity)

  /** 把选中段的两端写成新值（输入框反向同步用） */
  function setSegment(i, start, end) {
    const sg = segments[i]
    if (!sg) return
    if (!duration) {
      // 还没拿到时长：填多少算多少，只保证 start ≤ end
      if (Number.isFinite(start)) sg.start = Math.max(0, start)
      if (Number.isFinite(end)) sg.end = Math.max(0, end)
      if (sg.end < sg.start) [sg.start, sg.end] = [sg.end, sg.start]
      syncAll()
      return
    }
    if (Number.isFinite(start)) sg.start = clamp(start, segMin(i), sg.end - MIN_SEG)
    if (Number.isFinite(end)) sg.end = clamp(end, sg.start + MIN_SEG, segMax(i))
    syncAll()
  }

  /* ---------------------------------------------------------- 界面同步 */

  function syncPlayBtn() {
    mount(playBtn, [icon(playing ? 'pause' : 'play', 13), playing ? '暂停' : '播放'])
  }

  function renderSegList() {
    if (segments.length < 2) {
      mount(segList, null)
      return
    }
    mount(segList, h('div.col.gap-sm', [
      h('div.row.gap-sm', [
        h('span.tiny.dim', `共 ${segments.length} 段，点一行选中它，再按「导出」单独导出`),
        h('div.spacer'),
        button(`全部导出（${segments.length} 段）`, { size: 'btn-sm', variant: 'btn-primary', iconName: 'download', onClick: () => onExportAll?.() }),
      ]),
      ...segments.map((sg, i) => h(`div.seg-row${i === selected ? '.selected' : ''}`, {
        onclick: () => select(i),
      }, [
        h('span.seg-index', String(i + 1)),
        h('span.seg-time.mono', `${formatTime(sg.start)} → ${formatTime(sg.end)}`),
        h('span.seg-dur', formatDuration(sg.end - sg.start)),
        h('div.spacer'),
        button('导出', {
          size: 'btn-sm',
          onClick: (e) => {
            e.stopPropagation()
            onExport?.({ index: i, start: sg.start, end: sg.end, total: segments.length })
          },
        }),
        button('删除', {
          size: 'btn-sm',
          variant: 'btn-ghost',
          iconName: 'trash',
          title: '删掉这一段',
          onClick: (e) => {
            e.stopPropagation()
            removeSegment(i)
          },
        }),
      ])),
    ]))
  }

  function syncNote() {
    if (decoding) {
      noteEl.textContent = '正在解码波形…'
      noteEl.className = 'tiny dim wave-note'
      return
    }
    if (!url) {
      noteEl.textContent = '选好文件后这里会显示波形：点波形跳转、拖两端把手裁剪、剪刀切开、分段导出。'
      noteEl.className = 'tiny dim wave-note'
      return
    }
    if (note) {
      noteEl.textContent = `${note}；仍然可以选段、分段、导出，只是看不见波形。`
      noteEl.className = 'tiny warn wave-note'
      return
    }
    noteEl.textContent = `波形 2ms 一档；Ctrl+滚轮缩放，拖动波形平移，点一下跳到那里。总长 ${formatDuration(duration)}。`
    noteEl.className = 'tiny dim wave-note'
  }

  function syncAll(notify = true) {
    if (duration && viewSpan > duration) fit()
    renderSegList()
    syncNote()
    drawStatic()
    draw()
    if (!notify) return
    const sg = segments[selected]
    onChange?.({ start: sg?.start ?? 0, end: sg?.end ?? 0, count: segments.length, selected })
  }

  /* ---------------------------------------------------------- 交互 */

  function toggleScissors() {
    scissors = !scissors
    scissorsBtn.classList.toggle('btn-primary', scissors)
    canvas.style.cursor = scissors ? 'crosshair' : ''
  }

  function toggleOnlySelection() {
    onlySelection = !onlySelection
    onlySelBtn.classList.toggle('btn-primary', onlySelection)
  }

  function togglePlay() {
    if (!url) return
    if (audio.paused) {
      const sg = segments[selected]
      if (onlySelection && sg && !(audioTime >= sg.start && audioTime < sg.end - 0.01)) seek(sg.start)
      void audio.play().catch((err) => toast(`播放失败：${err.message}`, 'err'))
    } else {
      audio.pause()
    }
  }

  function seek(t) {
    const end = duration || audio.duration || t
    audioTime = clamp(t, 0, end)
    try {
      audio.currentTime = audioTime
    } catch {
      /* 元数据还没到，先把播放头画过去 */
    }
    draw()
  }

  function pointerX(e) {
    return e.clientX - canvas.getBoundingClientRect().left
  }

  function onPointerDown(e) {
    if (e.button !== 0 || !duration) return
    // 合成事件（自动化测试）拿不到真实 pointerId，这里不能让它把整个交互打断
    try {
      canvas.setPointerCapture(e.pointerId)
    } catch {
      /* 没有指针捕获也能拖，只是拖出画布就断 */
    }
    const x = pointerX(e)
    const t = clamp(tOf(x), 0, duration)

    if (scissors) {
      splitAt(t)
      return
    }

    const sg = segments[selected]
    if (sg) {
      if (Math.abs(x - xOf(sg.start)) <= HIT) {
        drag = { kind: 'start' }
        pushHistory()
        return
      }
      if (Math.abs(x - xOf(sg.end)) <= HIT) {
        drag = { kind: 'end' }
        pushHistory()
        return
      }
    }

    const hit = segments.findIndex((s) => t >= s.start && t <= s.end)
    if (hit >= 0 && hit !== selected) select(hit)

    drag = { kind: 'pan', x0: x, view0: viewStart, moved: false, t }
  }

  function onPointerMove(e) {
    if (!duration) return
    const x = pointerX(e)

    if (!drag) {
      // 悬停反馈：靠近把手给左右箭头，剪刀模式给十字
      const sg = segments[selected]
      const onHandle = !scissors && sg && (Math.abs(x - xOf(sg.start)) <= HIT || Math.abs(x - xOf(sg.end)) <= HIT)
      canvas.style.cursor = scissors ? 'crosshair' : onHandle ? 'ew-resize' : 'grab'
      return
    }

    if (drag.kind === 'pan') {
      const dx = x - drag.x0
      if (Math.abs(dx) > 3) drag.moved = true
      if (drag.moved) {
        viewStart = clamp(drag.view0 - (dx / width) * viewSpan, 0, Math.max(0, duration - viewSpan))
        drawStatic()
      }
      return
    }

    const sg = segments[selected]
    if (!sg) return
    const t = clamp(tOf(x), 0, duration)
    if (drag.kind === 'start') sg.start = clamp(t, segMin(selected), sg.end - MIN_SEG)
    else sg.end = clamp(t, sg.start + MIN_SEG, segMax(selected))
    syncAll()
  }

  function onPointerUp(e) {
    if (!drag) return
    const d = drag
    drag = null
    try {
      canvas.releasePointerCapture(e.pointerId)
    } catch {
      /* 上面没捕获成功，这里也就没得释放 */
    }
    // 没拖动过的一下 = 跳到那个位置
    if (d.kind === 'pan' && !d.moved) seek(d.t)
    else if (d.kind === 'pan') drawStatic()
  }

  function onWheel(e) {
    if (!duration || !(e.ctrlKey || e.metaKey)) return // 不抢页面滚动，缩放走 Ctrl+滚轮
    e.preventDefault()
    const anchor = clamp(pointerX(e) / width, 0, 1)
    zoom(e.deltaY < 0 ? 1.25 : 1 / 1.25, anchor)
  }

  function onKey(e) {
    if (e.target.matches('input, textarea')) return
    if (e.ctrlKey || e.metaKey) {
      if (e.key.toLowerCase() === 'z') {
        e.preventDefault()
        undo()
      }
      return
    }
    if (e.key === ' ') {
      e.preventDefault()
      togglePlay()
    } else if (e.key.toLowerCase() === 's') {
      splitAt(audioTime)
    } else if (e.key === 'Delete') {
      removeSegment(selected)
    }
  }

  canvas.addEventListener('pointerdown', onPointerDown)
  canvas.addEventListener('pointermove', onPointerMove)
  canvas.addEventListener('pointerup', onPointerUp)
  canvas.addEventListener('pointercancel', onPointerUp)
  canvas.addEventListener('wheel', onWheel, { passive: false })
  root.addEventListener('keydown', onKey)
  playBtn.addEventListener('click', togglePlay)
  scissorsBtn.addEventListener('click', toggleScissors)
  onlySelBtn.addEventListener('click', toggleOnlySelection)
  undoBtn.addEventListener('click', undo)

  audio.addEventListener('play', () => {
    playing = true
    syncPlayBtn()
    cancelAnimationFrame(raf)
    raf = requestAnimationFrame(tick)
  })
  const onStop = () => {
    playing = false
    syncPlayBtn()
    cancelAnimationFrame(raf)
    draw()
  }
  audio.addEventListener('pause', onStop)
  audio.addEventListener('ended', onStop)
  audio.addEventListener('timeupdate', () => {
    audioTime = audio.currentTime
    if (!playing) draw()
  })
  audio.addEventListener('loadedmetadata', () => {
    // ffmpeg 没探测出时长时的兜底：浏览器自己也能报
    if (!duration && Number.isFinite(audio.duration) && audio.duration > 0) {
      duration = audio.duration
      segments = [{ start: 0, end: duration }]
      selected = 0
      fit()
      syncAll()
      void decode()
    }
  })

  function tick() {
    if (!playing) return
    audioTime = audio.currentTime
    if (onlySelection) {
      const sg = segments[selected]
      if (sg && audioTime >= sg.end) {
        audio.pause()
        seek(sg.end)
        return
      }
    }
    const i = segments.findIndex((sg) => audioTime >= sg.start && audioTime <= sg.end)
    if (i !== activeSeg) {
      activeSeg = i
      drawStatic()
    }
    draw()
    raf = requestAnimationFrame(tick)
  }

  const ro = new ResizeObserver(() => resize())
  ro.observe(wrap)

  // 初始。这里不能通知 onChange —— 调用方拿到返回值之前还没把编辑器存下来
  root.tabIndex = 0
  resize()
  syncPlayBtn()
  syncAll(false)
  undoBtn.disabled = true

  /* ---------------------------------------------------------- 对外 */

  /**
   * 换素材：重置分段、重新解码波形
   * @param {string} nextUrl  '' 表示没有文件
   * @param {number} nextDuration  秒，0 = 未知
   * @param {{startSec:number,endSec:number}} range  从设置里恢复的选区
   */
  function setSource(nextUrl, nextDuration, range) {
    audio.pause()
    audioTime = 0
    activeSeg = -1
    const changed = nextUrl !== url
    url = nextUrl || ''
    duration = Number(nextDuration) > 0 ? Number(nextDuration) : 0
    if (url) audio.src = url
    else {
      audio.removeAttribute('src')
      audio.load()
    }
    note = ''
    peaks = null

    if (changed) {
      history.length = 0
      undoBtn.disabled = true
      const start = clamp(Number(range?.startSec) || 0, 0, duration || Infinity)
      const end = Number(range?.endSec) > start ? clamp(Number(range.endSec), start, duration || Infinity) : duration
      segments = [{ start, end: end || duration || 0 }]
      selected = 0
      fit()
    }
    // 时长未知时先不解码：没有时长就没法判断这个文件会不会把内存吃爆
    if (url && duration && triedUrl !== url) void decode()
    syncAll()
    draw()
  }

  async function decode() {
    if (!url || decoding || triedUrl === url) return
    triedUrl = url
    decoding = true
    syncNote()
    try {
      peaks = await loadPeaks(url, duration)
      if (!duration) {
        duration = peaks.length / 2 / PEAKS_PER_SEC
        segments = [{ start: 0, end: duration }]
        selected = 0
        fit()
      }
    } catch (err) {
      peaks = null
      note = err.message
    } finally {
      decoding = false
      syncAll()
    }
  }

  function destroy() {
    cancelAnimationFrame(raf)
    ro.disconnect()
    audio.pause()
    audio.removeAttribute('src')
    audio.load()
  }

  return {
    el: root,
    setSource,
    select,
    setSegment,
    splitAt,
    undo,
    destroy,
    get segments() {
      return segments
    },
    get selectedIndex() {
      return selected
    },
    get duration() {
      return duration
    },
  }
}

export default { createWaveEditor, rawUrl }
