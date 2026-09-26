/**
 * VPIR — Vocal Project Intermediate Representation
 * 权威说明见同目录 IR-SPEC.md
 *
 * 时间单位：tick，TPQ = 480 tick / 四分音符
 * 音高：MIDI 音符号（整数）+ 绝对音高曲线（semitones，浮点）
 * 参数：归一化 0..1（velocity 为 0..127）
 */

export const TPQ = 480

/** 规范参数名 -> 取值范围 */
export const PARAM_RANGE = {
  pitch: [-12, 12],
  dynamics: [0, 1],
  breathiness: [0, 1],
  brightness: [0, 1],
  clearness: [0, 1],
  gender: [0, 1],
  tension: [0, 1],
  voicing: [0, 1],
  opening: [0, 1],
  mouth: [0, 1],
  roughness: [0, 1],
  velocity: [0, 127],
  vibratoDepth: [0, 1],
  vibratoRate: [0, 1],
  vibratoDelay: [0, 1],
  portamento: [0, 1],
  growl: [0, 1],
  harmonics: [0, 1],
}

export const PARAM_NAMES = Object.keys(PARAM_RANGE)

let uidCounter = 0
export function uid(prefix = 'id') {
  uidCounter += 1
  return `${prefix}${uidCounter.toString(36)}${Math.floor(Math.random() * 46656).toString(36)}`
}

/* ------------------------------------------------------------------ 构造 */

export function createCurve(init = {}) {
  const ticks = Array.isArray(init.ticks) ? init.ticks.slice() : []
  const values = Array.isArray(init.values) ? init.values.slice() : []
  return normalizeCurve({ ticks, values })
}

export function createNote(init = {}) {
  return {
    tick: Math.round(init.tick ?? 0),
    duration: Math.max(1, Math.round(init.duration ?? TPQ)),
    key: Math.round(init.key ?? 60),
    lyric: init.lyric ?? '',
    pitchOffset: init.pitchOffset ?? 0,
    detune: init.detune ?? 0,
    velocity: init.velocity ?? 64,
    phoneme: init.phoneme ?? null,
    attributes: init.attributes ? { ...init.attributes } : {},
  }
}

export function createTrack(init = {}) {
  return {
    id: init.id ?? uid('trk'),
    name: init.name ?? 'Track 1',
    singer: init.singer ?? '',
    color: init.color ?? '',
    muted: !!init.muted,
    solo: !!init.solo,
    volume: init.volume ?? 1,
    pan: init.pan ?? 0,
    language: init.language ?? '',
    notes: (init.notes ?? []).map((n) => createNote(n)),
    pitch: createCurve(init.pitch),
    parameters: mapParams(init.parameters),
    phonemes: (init.phonemes ?? []).map((p) => ({
      tick: Math.round(p.tick ?? 0),
      duration: Math.max(1, Math.round(p.duration ?? 1)),
      symbol: p.symbol ?? '',
      noteIndex: p.noteIndex ?? -1,
      extras: p.extras ?? {},
    })),
    extras: init.extras ? { ...init.extras } : {},
  }
}

function mapParams(parameters) {
  const out = {}
  if (!parameters) return out
  for (const [key, curve] of Object.entries(parameters)) {
    if (!curve) continue
    if (!PARAM_NAMES.includes(key)) continue
    out[key] = createCurve(curve)
  }
  return out
}

export function createProject(init = {}) {
  const tempos = (init.tempos ?? [{ tick: 0, bpm: 120 }])
    .map((t) => ({ tick: Math.round(t.tick ?? 0), bpm: Number(t.bpm) || 120 }))
    .sort((a, b) => a.tick - b.tick)
  if (!tempos.length || tempos[0].tick !== 0) tempos.unshift({ tick: 0, bpm: tempos[0]?.bpm ?? 120 })

  const timeSignatures = (init.timeSignatures ?? [{ tick: 0, numerator: 4, denominator: 4 }])
    .map((t) => ({
      tick: Math.round(t.tick ?? 0),
      numerator: t.numerator ?? 4,
      denominator: t.denominator ?? 4,
    }))
    .sort((a, b) => a.tick - b.tick)
  if (!timeSignatures.length || timeSignatures[0].tick !== 0) {
    timeSignatures.unshift({ tick: 0, numerator: 4, denominator: 4 })
  }

  return {
    formatVersion: 1,
    sourceFormat: init.sourceFormat ?? 'unknown',
    name: init.name ?? '未命名工程',
    comment: init.comment ?? '',
    tempos,
    timeSignatures,
    measurePrefix: Math.round(init.measurePrefix ?? 0),
    tracks: (init.tracks ?? [createTrack()]).map((t) => createTrack(t)),
    extras: init.extras ? { ...init.extras } : {},
  }
}

/* ------------------------------------------------------------------ 曲线 */

export function normalizeCurve(curve) {
  if (!curve) return { ticks: [], values: [] }
  const { ticks = [], values = [] } = curve
  const pairs = []
  const n = Math.min(ticks.length, values.length)
  for (let i = 0; i < n; i += 1) {
    const t = ticks[i]
    const v = values[i]
    if (!Number.isFinite(t) || !Number.isFinite(v)) continue
    pairs.push([Math.round(t), v])
  }
  pairs.sort((a, b) => a[0] - b[0])
  const outT = []
  const outV = []
  for (const [t, v] of pairs) {
    if (outT.length && outT[outT.length - 1] === t) outV[outV.length - 1] = v
    else {
      outT.push(t)
      outV.push(v)
    }
  }
  return { ticks: outT, values: outV }
}

export function sortCurve(curve) {
  const n = normalizeCurve(curve)
  curve.ticks = n.ticks
  curve.values = n.values
  return curve
}

/** 曲线在 tick 处的线性插值；超出范围取端点值；空曲线返回 null */
export function curveValueAt(curve, tick) {
  if (!curve || !curve.ticks || curve.ticks.length === 0) return null
  const { ticks, values } = curve
  if (tick <= ticks[0]) return values[0]
  const last = ticks.length - 1
  if (tick >= ticks[last]) return values[last]
  let lo = 0
  let hi = last
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (ticks[mid] <= tick) lo = mid
    else hi = mid
  }
  const span = ticks[hi] - ticks[lo]
  if (span <= 0) return values[hi]
  const ratio = (tick - ticks[lo]) / span
  return values[lo] + (values[hi] - values[lo]) * ratio
}

/** 写入曲线点（同 tick 覆盖） */
export function setCurveValue(curve, tick, value) {
  const t = Math.round(tick)
  const idx = curve.ticks.indexOf(t)
  if (idx >= 0) curve.values[idx] = value
  else {
    curve.ticks.push(t)
    curve.values.push(value)
    sortCurve(curve)
  }
  return curve
}

/** 把曲线重采样到固定步长（导出到只支持等距采样的格式时用） */
export function resampleCurve(curve, step, fromTick, toTick) {
  const out = { ticks: [], values: [] }
  if (!curve || !curve.ticks.length || step <= 0) return out
  const start = fromTick ?? curve.ticks[0]
  const end = toTick ?? curve.ticks[curve.ticks.length - 1]
  for (let t = start; t <= end; t += step) {
    out.ticks.push(t)
    out.values.push(curveValueAt(curve, t))
  }
  return out
}

/* -------------------------------------------------------------- 速度映射 */

/** 速度映射积分：tick -> 秒 */
export function tickToSec(tick, tempos) {
  const map = normalizeTempos(tempos)
  if (tick <= 0) return 0
  let sec = 0
  for (let i = 0; i < map.length; i += 1) {
    const cur = map[i]
    const next = map[i + 1]
    const segEnd = next ? next.tick : Infinity
    if (tick <= cur.tick) break
    const end = Math.min(tick, segEnd)
    sec += ((end - cur.tick) / TPQ) * (60 / cur.bpm)
    if (tick <= segEnd) break
  }
  return sec
}

/** 秒 -> tick（速度映射反解） */
export function secToTick(sec, tempos) {
  const map = normalizeTempos(tempos)
  let acc = 0
  for (let i = 0; i < map.length; i += 1) {
    const cur = map[i]
    const next = map[i + 1]
    const segSec = next ? ((next.tick - cur.tick) / TPQ) * (60 / cur.bpm) : Infinity
    if (sec <= acc + segSec || !next) {
      return Math.round(cur.tick + ((sec - acc) / (60 / cur.bpm)) * TPQ)
    }
    acc += segSec
  }
  return Math.round(sec * TPQ * (map[0].bpm / 60))
}

function normalizeTempos(tempos) {
  const list = (tempos ?? []).filter((t) => Number.isFinite(t?.tick) && Number.isFinite(t?.bpm) && t.bpm > 0)
  if (!list.length) return [{ tick: 0, bpm: 120 }]
  list.sort((a, b) => a.tick - b.tick)
  if (list[0].tick !== 0) list.unshift({ tick: 0, bpm: list[0].bpm })
  return list
}

export function bpmAt(tick, tempos) {
  const map = normalizeTempos(tempos)
  let bpm = map[0].bpm
  for (const t of map) {
    if (t.tick <= tick) bpm = t.bpm
    else break
  }
  return bpm
}

export function timeSignatureAt(tick, timeSignatures) {
  const list = (timeSignatures ?? []).filter((t) => Number.isFinite(t?.tick)).sort((a, b) => a.tick - b.tick)
  let ts = { tick: 0, numerator: 4, denominator: 4 }
  for (const t of list) {
    if (t.tick <= tick) ts = { tick: t.tick, numerator: t.numerator || 4, denominator: t.denominator || 4 }
    else break
  }
  return ts
}

/* ------------------------------------------------------------ 小节换算 */

function measureTicks(numerator, denominator) {
  return Math.round(((TPQ * 4) / denominator) * numerator)
}

/**
 * 小节/拍 -> tick
 * measure 为 0 基小节号；beat 为 1 基拍号；tickInBeat 为拍内 tick
 */
export function measureToTick(measure, opts = {}) {
  const {
    numerator = 4,
    denominator = 4,
    measurePrefix = 0,
    timeSignatures = null,
    beat = 1,
    tickInBeat = 0,
  } = opts
  if (timeSignatures && timeSignatures.length) {
    let tick = measurePrefix
    let m = 0
    let cur = timeSignatureAt(0, timeSignatures)
    let guard = 0
    while (m < measure && guard < 100000) {
      const next = timeSignatures.find((t) => t.tick > tick)
      cur = timeSignatureAt(tick, timeSignatures)
      const mt = measureTicks(cur.numerator, cur.denominator)
      // 若下一拍号落在本小节内，则本小节在拍号处截断
      if (next && next.tick < tick + mt) {
        tick = next.tick
        m += 1
        continue
      }
      tick += mt
      m += 1
      guard += 1
    }
    cur = timeSignatureAt(tick, timeSignatures)
    const beatTicks = (TPQ * 4) / cur.denominator
    return Math.round(tick + (beat - 1) * beatTicks + tickInBeat)
  }
  const mt = measureTicks(numerator, denominator)
  const beatTicks = (TPQ * 4) / denominator
  return Math.round(measurePrefix + measure * mt + (beat - 1) * beatTicks + tickInBeat)
}

/** tick -> { measure, beat, tickInBeat, numerator, denominator }（全部 1 基拍号、0 基小节） */
export function tickToMeasure(tick, timeSignatures = null, measurePrefix = 0) {
  const sigs = (timeSignatures && timeSignatures.length ? timeSignatures : [{ tick: 0, numerator: 4, denominator: 4 }])
    .slice()
    .sort((a, b) => a.tick - b.tick)

  let cur = sigs[0]
  let measureStart = measurePrefix
  let measure = 0
  let guard = 0
  while (guard < 200000) {
    const next = sigs.find((s) => s.tick > measureStart)
    cur = timeSignatureAt(measureStart, sigs)
    let mt = measureTicks(cur.numerator, cur.denominator)
    if (next && next.tick < measureStart + mt) mt = next.tick - measureStart
    if (tick < measureStart + mt) {
      const beatTicks = (TPQ * 4) / cur.denominator
      const offset = tick - measureStart
      const beat = Math.floor(offset / beatTicks) + 1
      const tickInBeat = Math.round(offset - (beat - 1) * beatTicks)
      return {
        measure,
        beat,
        tickInBeat,
        numerator: cur.numerator,
        denominator: cur.denominator,
        measureStartTick: measureStart,
      }
    }
    measureStart += mt
    measure += 1
    guard += 1
  }
  return { measure: 0, beat: 1, tickInBeat: 0, numerator: 4, denominator: 4, measureStartTick: measurePrefix }
}

/* ------------------------------------------------------------ 统计/编辑 */

export function projectStartTick(project) {
  let min = Infinity
  for (const t of project.tracks) {
    for (const n of t.notes) min = Math.min(min, n.tick)
    if (t.pitch?.ticks?.length) min = Math.min(min, t.pitch.ticks[0])
  }
  return Number.isFinite(min) ? min : 0
}

export function projectEndTick(project) {
  let max = 0
  for (const t of project.tracks) {
    for (const n of t.notes) max = Math.max(max, n.tick + n.duration)
    if (t.pitch?.ticks?.length) max = Math.max(max, t.pitch.ticks[t.pitch.ticks.length - 1])
    for (const c of Object.values(t.parameters ?? {})) {
      if (c?.ticks?.length) max = Math.max(max, c.ticks[c.ticks.length - 1])
    }
  }
  return max
}

export function noteCount(project) {
  return project.tracks.reduce((sum, t) => sum + t.notes.length, 0)
}

/**
 * 整体转调：音符 key 与「绝对音高曲线」同步移动。
 *
 * 注意：只能动 pitch 类曲线。dynamics / breathiness 等参数是 0..1 的归一化值，
 * parameters.pitch 是相对音符的偏移（音符移了它自然跟着移），
 * 给它们加半音会把力度之类的数据彻底搞坏。
 */
export function transposeProject(project, semitones) {
  if (!semitones) return project
  for (const track of project.tracks) {
    for (const note of track.notes) note.key += semitones
    if (track.pitch?.values) {
      track.pitch.values = track.pitch.values.map((v) => v + semitones)
    }
  }
  return project
}

/** 音符按 tick 排序，并裁剪负时值 */
export function sortNotes(track) {
  track.notes.sort((a, b) => a.tick - b.tick || a.key - b.key)
  for (const n of track.notes) {
    if (n.duration < 1) n.duration = 1
  }
  return track
}

/** 让同轨音符不重叠（超出下一个音符起点则裁剪），部分格式要求严格不重叠 */
export function unoverlapNotes(track) {
  sortNotes(track)
  for (let i = 0; i < track.notes.length - 1; i += 1) {
    const cur = track.notes[i]
    const next = track.notes[i + 1]
    if (cur.tick + cur.duration > next.tick) cur.duration = Math.max(1, next.tick - cur.tick)
  }
  return track
}

/* ------------------------------------------------------------------ 校验 */

export function validateProject(project) {
  const issues = []
  if (!project || typeof project !== 'object') return ['project 不是对象']
  if (!Array.isArray(project.tracks)) issues.push('tracks 不是数组')
  if (!project.tempos?.length) issues.push('缺少速度信息')
  else if (project.tempos[0].tick !== 0) issues.push('速度列表首项 tick 不为 0')
  project.tempos?.forEach((t, i) => {
    if (!(t.bpm > 0) || t.bpm > 1000) issues.push(`tempos[${i}] bpm 非法: ${t.bpm}`)
  })
  project.timeSignatures?.forEach((t, i) => {
    if (!(t.numerator > 0)) issues.push(`timeSignatures[${i}] numerator 非法`)
    if (![1, 2, 4, 8, 16, 32].includes(t.denominator)) issues.push(`timeSignatures[${i}] denominator 非法: ${t.denominator}`)
  })
  project.tracks?.forEach((track, ti) => {
    if (!Array.isArray(track.notes)) issues.push(`tracks[${ti}] notes 不是数组`)
    track.notes?.forEach((n, ni) => {
      if (!Number.isFinite(n.tick) || n.tick < 0) issues.push(`tracks[${ti}].notes[${ni}] tick 非法: ${n.tick}`)
      if (!Number.isFinite(n.duration) || n.duration < 1) issues.push(`tracks[${ti}].notes[${ni}] duration 非法: ${n.duration}`)
      if (!Number.isInteger(n.key) || n.key < 0 || n.key > 127) issues.push(`tracks[${ti}].notes[${ni}] key 非法: ${n.key}`)
      if (typeof n.lyric !== 'string') issues.push(`tracks[${ti}].notes[${ni}] lyric 不是字符串`)
    })
    for (const [name, curve] of Object.entries(track.parameters ?? {})) {
      if (!PARAM_NAMES.includes(name)) issues.push(`tracks[${ti}] 未知参数名 ${name}`)
      if (!curve?.ticks || !curve?.values || curve.ticks.length !== curve.values.length) {
        issues.push(`tracks[${ti}].parameters.${name} 曲线长度不一致`)
      }
    }
    if (track.pitch && track.pitch.ticks.length !== track.pitch.values.length) {
      issues.push(`tracks[${ti}].pitch 曲线长度不一致`)
    }
  })
  return issues
}

/** 深拷贝（结构化克隆，避免 structuredClone 对 undefined 的兼容问题） */
export function cloneProject(project) {
  return JSON.parse(JSON.stringify(project))
}

/* ---------------------------------------------------- 常用换算小工具 */

export const clamp = (v, min, max) => Math.min(max, Math.max(min, v))

/** 任意范围 -> 0..1 */
export function toUnit(value, min, max) {
  if (max === min) return 0
  return clamp((value - min) / (max - min), 0, 1)
}

/** 0..1 -> 任意范围 */
export function fromUnit(unit, min, max) {
  return min + clamp(unit, 0, 1) * (max - min)
}

/** 线性映射（不裁剪） */
export function remap(value, inMin, inMax, outMin, outMax) {
  if (inMax === inMin) return outMin
  return outMin + ((value - inMin) / (inMax - inMin)) * (outMax - outMin)
}

/** 解析 #rrggbb / #aarrggbb / rgb() 为 #rrggbb */
export function normalizeColor(input, fallback = '') {
  if (!input || typeof input !== 'string') return fallback
  let s = input.trim()
  const rgb = s.match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i)
  if (rgb) {
    const hex = (x) => Number(x).toString(16).padStart(2, '0')
    return `#${hex(rgb[1])}${hex(rgb[2])}${hex(rgb[3])}`
  }
  if (!s.startsWith('#')) return fallback
  s = s.slice(1)
  if (s.length === 8) s = s.slice(0, 6) // 丢弃 alpha
  if (s.length === 3) s = s.split('').map((c) => c + c).join('')
  if (s.length !== 6 || !/^[0-9a-f]{6}$/i.test(s)) return fallback
  return `#${s.toLowerCase()}`
}

/** 音名 <-> MIDI 音符号 */
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
export function keyToName(key) {
  const octave = Math.floor(key / 12) - 1
  return `${NOTE_NAMES[((key % 12) + 12) % 12]}${octave}`
}
export function nameToKey(name) {
  const m = String(name).trim().match(/^([A-Ga-g])([#b]?)(-?\d+)$/)
  if (!m) return null
  const base = NOTE_NAMES.indexOf(m[1].toUpperCase())
  let key = base + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0)
  return key + (Number(m[3]) + 1) * 12
}
