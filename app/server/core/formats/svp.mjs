/**
 * Synthesizer V Studio 工程（.svp）读写模块
 *
 * 格式事实（已联网查证，勿凭印象改字段名）：
 *  - .svp 是 UTF-8 JSON；顶层 { version, time{meter[],tempo[]}, renderConfig, library[], tracks[] }
 *  - 时间单位 blick：SV.QUARTER = 705600000 blick / 四分音符
 *    （Dreamtonics 脚本手册 SV.QUARTER；Automation/Note 的 onset/duration 均为 blick）
 *  - 轨道结构：tracks[i] = { name, dispColor, dispOrder, renderEnabled, mixer,
 *      mainGroup{ name, uuid, parameters{...}, notes[] }, mainRef{ groupID, blickOffset,
 *      pitchOffset, isInstrumental, database, audio, dictionary, voice }, groups[] }
 *  - library[] 存放被 groups[] 引用的额外 NoteGroup（与 mainGroup 同构）
 *  - 音符：{ onset, duration, lyrics, phonemes, pitch(MIDI), attributes{} }
 *    attributes 可用键（SynthV 1.x）：tF0Offset/tF0Left/tF0Right/dF0Left/dF0Right/
 *      tF0VbrStart/tF0VbrLeft/tF0VbrRight/dF0Vbr/pF0Vbr/fF0Vbr/tNoteOffset/dur/alt…
 *  - 参数曲线：{ mode:"linear"|"cosine"|"cubic", points:[x0,y0,x1,y1,…] }，x 为 blick
 *    pitchDelta  单位 cent，范围 -1200..1200（相对音符 key 的偏差）
 *    vibratoEnv  范围 0..2，默认 1
 *    loudness    单位 dB，范围 -48..12，默认 0
 *    tension     -1..1（默认 0）、breathiness -1..1（默认 0）
 *    voicing     0..1（默认 1）、gender -1..1（默认 0）
 *    （Dreamtonics 脚本手册 Automation#getDefinition 的 range/defaultValue 表）
 *
 * 时间换算：
 *  BLICK_PER_QUARTER = 705600000，IR 的 TPQ = 480
 *  => 1 tick = 705600000 / 480 = 1470000 blick（整数，正好整除）
 *  blick -> tick 用 Math.round，最大误差 0.5 tick；所有常见时值（1/16、附点、三连音、
 *  1/32、五连音）在 705600000 下都能整除，往返误差为 0。
 */

import { randomUUID } from 'node:crypto'
import {
  TPQ,
  createProject,
  createTrack,
  createNote,
  createCurve,
  clamp,
} from '../ir.mjs'

/* ------------------------------------------------------------------ 元信息 */

export const meta = {
  id: 'svp',
  name: 'Synthesizer V 工程',
  vendor: 'Dreamtonics',
  exts: ['.svp'],
  kind: 'json',
  canRead: true,
  canWrite: true,
  writeExt: '.svp',
  encoding: 'utf8',
}

export const fidelity = {
  preserves: [
    'tempo',
    'timeSignature',
    'notes',
    'lyrics',
    'phonemes',
    'pitchCurve',
    'vibrato',
    'multiTrack',
    'singer',
    'trackVolume',
    'trackPan',
    'params.dynamics',
    'params.breathiness',
    'params.tension',
    'params.gender',
    'params.voicing',
    'trackName',
    'trackColor',
    'mixer',
  ],
  drops: [
    '自动化曲线插值模式（cubic 读取时按 cosine/线性采样，写回同格式时原样保留）',
    '音符级颤音参数（写回同格式保留，转其它格式会退化为 attributes.vibrato 近似）',
    '音素时长/替代发音（dur/alt 保留在 note.attributes）',
    'Vocal Mode / 声库渲染设置（保留在 extras）',
  ],
  notes:
    'Synthesizer V 原生 blick 时间（705600000/Q）会精确换算为 IR 的 480 TPQ；' +
    '音高曲线为「相对音符的 cent 偏差」，读取时叠加到音符 key 转成绝对半音，写回时还原；' +
    'loudness/f0 类参数按格式原生范围线性归一化，同格式往返无损。',
}

/* -------------------------------------------------------------- 时间换算 */

export const BLICK_PER_QUARTER = 705600000
/** 1 IR tick（1/480 四分音符）对应多少 blick；705600000 / 480 正好整除 */
export const BLICK_PER_TICK = BLICK_PER_QUARTER / TPQ // 1470000

/** blick -> IR tick（四舍五入，最大误差 0.5 tick） */
export function blickToTick(blick) {
  const n = Number(blick)
  if (!Number.isFinite(n)) return 0
  return Math.round(n / BLICK_PER_TICK)
}

/** IR tick -> blick（整数 blick，无精度损失） */
export function tickToBlick(tick) {
  const n = Number(tick)
  if (!Number.isFinite(n)) return 0
  return Math.round(n * BLICK_PER_TICK)
}

/** 记录换算误差（供自测统计最大误差） */
export function blickRoundTripError(tick) {
  return Math.abs(blickToTick(tickToBlick(tick)) - tick)
}

/* ---------------------------------------------------------------- 小工具 */

/** SynthV 的小节号固定锚在 4/4 网格上（1 小节 = 1920 tick = 4 拍） */
const MEASURE_GRID = TPQ * 4

// null/undefined/'' 都视为缺失，避免 Number(null)===0 把坏数据洗成合法值
const num = (v, dflt = 0) =>
  v === null || v === undefined || v === '' || typeof v === 'boolean' || !Number.isFinite(Number(v))
    ? dflt
    : Number(v)
const clamp01 = (v) => clamp(Number.isFinite(v) ? v : 0, 0, 1)
const centsToSemitones = (c) => num(c) / 100
const semitonesToCents = (s) => num(s) * 100

/** 解析 {"mode":"cubic","points":[…]}; points 兼容扁平静音数组与 [[x,y],…] 两种写法 */
function parseAutomation(raw) {
  if (!raw || typeof raw !== 'object') return null
  const mode = typeof raw.mode === 'string' ? raw.mode : 'cubic'
  const src = Array.isArray(raw.points) ? raw.points : []
  const xs = []
  const ys = []
  if (src.length && Array.isArray(src[0])) {
    for (const p of src) {
      if (!Array.isArray(p) || p.length < 2) continue
      const x = num(p[0], NaN)
      const y = num(p[1], NaN)
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      xs.push(x)
      ys.push(y)
    }
  } else {
    for (let i = 0; i + 1 < src.length; i += 2) {
      const x = num(src[i], NaN)
      const y = num(src[i + 1], NaN)
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      xs.push(x)
      ys.push(y)
    }
  }
  return { mode, xs, ys }
}

/** 把 blick 域的自动化曲线换算成 IR 曲线（tick + 映射后的值） */
function automationToCurve(raw, mapValue) {
  const a = parseAutomation(raw)
  if (!a || !a.xs.length) return null
  const pairs = []
  for (let i = 0; i < a.xs.length; i += 1) {
    const tick = Math.max(0, blickToTick(a.xs[i]))
    const value = mapValue(a.ys[i])
    if (!Number.isFinite(value)) continue
    pairs.push([tick, value])
  }
  if (!pairs.length) return null
  pairs.sort((p, q) => p[0] - q[0])
  const ticks = []
  const values = []
  for (const [t, v] of pairs) {
    if (ticks.length && ticks[ticks.length - 1] === t) values[values.length - 1] = v
    else {
      ticks.push(t)
      values.push(v)
    }
  }
  return { ticks, values }
}

/** IR 曲线 -> SynthV 自动化（tick -> blick，值经 mapValue 反算，可整除时保持原始 blick） */
function curveToAutomation(curve, mapValue, unit) {
  const points = []
  if (curve && curve.ticks && curve.ticks.length) {
    const n = Math.min(curve.ticks.length, curve.values.length)
    for (let i = 0; i < n; i += 1) {
      const x = tickToBlick(curve.ticks[i])
      const y = num(mapValue(curve.values[i]))
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue
      points.push(x, y)
    }
  }
  return { mode: 'cubic', points, ...(unit ? { unit } : {}) }
}

/** 取得读取时缓存的原始自动化（同格式写回时优先复用，做到无损） */
function rawAutomation(extras, key) {
  const stash = extras && extras.svpAutomation
  const raw = stash ? stash[key] : null
  if (!raw || typeof raw !== 'object') return null
  const a = parseAutomation(raw)
  if (!a || !a.xs.length) return null
  const points = []
  for (let i = 0; i < a.xs.length; i += 1) points.push(num(a.xs[i]), num(a.ys[i]))
  return { mode: a.mode, points }
}

function paramCurve(track, key) {
  const c = track.parameters ? track.parameters[key] : null
  if (c && c.ticks && c.ticks.length) return c
  return null
}

/* ------------------------------------------------------- 参数归一化映射 */

// loudness: dB(-48..12) <-> IR dynamics 0..1
const loudnessToUnit = (db) => clamp01((num(db) + 48) / 60)
const unitToLoudness = (u) => clamp01(u) * 60 - 48
// tension / gender: -1..1 -> 0..1（0 为中性）
const bipolarToUnit = (v) => clamp01((num(v) + 1) / 2)
const unitToBipolar = (u) => clamp01(u) * 2 - 1
// breathiness: SynthV -1(气声) .. 1(干净) -> IR 0..1（1 = 更气声）
const breathinessToUnit = (v) => clamp01((1 - num(v)) / 2)
const unitToBreathiness = (u) => 1 - clamp01(u) * 2
// voicing: 0..1 直接沿用（SynthV 的语义方向与 IR 名称一致：值越大越「voiced」）
const voicingToUnit = (v) => clamp01(num(v))
const unitToVoicing = (u) => clamp01(u)

/* ------------------------------------------------------------ 音高参考 */

/** 找出覆盖 tick 的音符；落在空隙时取前一个音符（二分查找，曲线点多时也不退化） */
function refKeyAt(notes, tick) {
  const n = notes.length
  if (!n) return 60
  let lo = 0
  let hi = n - 1
  let idx = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (notes[mid].tick <= tick) {
      idx = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (idx < 0) return notes[0].key
  const cur = notes[idx]
  if (tick < cur.tick + Math.max(1, cur.duration)) return cur.key
  const next = notes[idx + 1]
  if (!next) return cur.key
  // 落在空隙里：取更近的一端
  const gapEnd = next.tick
  return tick - (cur.tick + cur.duration) <= gapEnd - tick ? cur.key : next.key
}

/** 把 SynthV 的相对 cent 偏差曲线转成 IR 的绝对半音曲线 */
function pitchDeltaToAbsolute(pitchDelta, notes, groupKeyOffset) {
  const a = parseAutomation(pitchDelta)
  if (!a || !a.xs.length) return null
  const pairs = []
  for (let i = 0; i < a.xs.length; i += 1) {
    const tick = blickToTick(a.xs[i])
    const absolute = refKeyAt(notes, tick) + groupKeyOffset + centsToSemitones(a.ys[i])
    if (!Number.isFinite(absolute)) continue
    pairs.push([Math.max(0, tick), absolute])
  }
  if (!pairs.length) return null
  pairs.sort((p, q) => p[0] - q[0])
  const ticks = []
  const values = []
  for (const [t, v] of pairs) {
    if (ticks.length && ticks[ticks.length - 1] === t) values[values.length - 1] = v
    else {
      ticks.push(t)
      values.push(v)
    }
  }
  return { ticks, values }
}

/** 把 IR 的绝对半音曲线转成 SynthV 的相对 cent 偏差曲线 */
function absoluteToPitchDelta(curve, notes, groupKeyOffset) {
  const points = []
  if (curve && curve.ticks && curve.ticks.length) {
    const n = Math.min(curve.ticks.length, curve.values.length)
    for (let i = 0; i < n; i += 1) {
      const tick = Math.max(0, Math.round(curve.ticks[i]))
      const value = num(curve.values[i], NaN)
      if (!Number.isFinite(value)) continue
      const cents = semitonesToCents(value - refKeyAt(notes, tick) - groupKeyOffset)
      points.push(tickToBlick(tick), Math.round(cents * 1000) / 1000)
    }
  }
  return { mode: 'cubic', points }
}

/* ------------------------------------------------------------ 语言/颜色 */

const SVP_TO_IR_LANG = {
  japanese: 'ja',
  mandarin: 'zh',
  cantonese: 'zh',
  english: 'en',
  korean: 'ko',
  spanish: 'es',
}
const IR_TO_SVP_LANG = { ja: 'japanese', zh: 'mandarin', en: 'english', ko: 'korean', es: 'spanish' }

function languageFromDatabase(db) {
  if (!db || typeof db !== 'object') return ''
  const raw = String(db.language ?? '').toLowerCase()
  if (!raw) return ''
  if (SVP_TO_IR_LANG[raw]) return SVP_TO_IR_LANG[raw]
  const hit = Object.keys(SVP_TO_IR_LANG).find((k) => raw.startsWith(k.slice(0, 3)))
  return hit ? SVP_TO_IR_LANG[hit] : ''
}

/** #aarrggbb -> #rrggbb */
function colorToHex(dispColor) {
  if (typeof dispColor !== 'string') return ''
  let s = dispColor.trim().replace(/^#/, '')
  if (s.length === 8) s = s.slice(2)
  if (!/^[0-9a-f]{6}$/i.test(s)) return ''
  return `#${s.toLowerCase()}`
}

/** #rrggbb -> aarrggbb（alpha 固定 ff，与 SynthV 模板一致） */
function hexToDispColor(hex) {
  const s = String(hex ?? '').trim().replace(/^#/, '')
  if (/^[0-9a-f]{6}$/i.test(s)) return `ff${s.toLowerCase()}`
  if (/^[0-9a-f]{8}$/i.test(s)) return s.toLowerCase()
  return 'ff7db235'
}

/* ------------------------------------------------------------ 音素/颤音 */

function phonemesToIr(str) {
  if (typeof str !== 'string' || !str.trim()) return []
  return str.trim().split(/\s+/).filter(Boolean)
}

/** 写出音符的 phonemes 字段；同格式往返时优先取回原始串（保留空格写法） */
function phonemeToSvp(note) {
  const raw = note.attributes?.svNote
  if (raw && typeof raw.phonemes === 'string' && raw.phonemes.trim()) return raw.phonemes
  if (typeof note.phoneme === 'string' && note.phoneme.trim()) return note.phoneme.trim()
  const list = note.attributes && Array.isArray(note.attributes.svPhonemes) ? note.attributes.svPhonemes : []
  return list.join(' ')
}

/** 抽出 SynthV 私有的音符属性（用于原样写回） */
function extractNoteAttributes(raw) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [k, v] of Object.entries(raw)) {
    if (k === 'phonemes') continue
    out[k] = v
  }
  return out
}

/** 由 SynthV 音符构建音素时间轴（无音素信息时不生成） */
function buildPhonemes(symbols, tick, duration, noteIndex) {
  if (!symbols.length) return []
  const per = Math.max(1, Math.round(duration / symbols.length))
  return symbols.map((symbol, i) => ({
    tick: tick + i * per,
    duration: i === symbols.length - 1 ? Math.max(1, duration - i * per) : per,
    symbol,
    noteIndex,
    extras: {},
  }))
}

/** 音符级颤音：SynthV 原生参数 -> IR-SPEC §3 的 attributes.vibrato */
function vibratoToIr(raw, note, tempos) {
  if (!raw || typeof raw !== 'object') return null
  const keys = ['tF0VbrStart', 'dF0Vbr', 'fF0Vbr', 'tF0VbrLeft', 'tF0VbrRight', 'dF0VbrMod']
  if (!keys.some((k) => raw[k] !== undefined && raw[k] !== null)) return null

  const bpmAt = (tick) => {
    let bpm = tempos?.[0]?.bpm || 120
    for (const t of tempos ?? []) if (t.tick <= tick) bpm = t.bpm || bpm
    return bpm
  }
  // tF0* 单位是秒，按音符起始处的速度换算成 tick
  const secToTicks = (sec) => {
    if (!Number.isFinite(Number(sec))) return 0
    return Math.round((Number(sec) * bpmAt(note.tick) * TPQ) / 60)
  }

  const vibrato = {}
  if (Number.isFinite(Number(raw.tF0VbrStart))) vibrato.delay = secToTicks(raw.tF0VbrStart)
  if (Number.isFinite(Number(raw.tF0VbrLeft)) || Number.isFinite(Number(raw.tF0VbrRight))) {
    vibrato.length = secToTicks(raw.tF0VbrLeft ?? 0) + secToTicks(raw.tF0VbrRight ?? 0)
  }
  if (Number.isFinite(Number(raw.dF0Vbr))) vibrato.depth = num(raw.dF0Vbr) * 100 // 半音 -> 音分
  if (Number.isFinite(Number(raw.fF0Vbr))) vibrato.rate = num(raw.fF0Vbr) // Hz
  if (Number.isFinite(Number(raw.dF0VbrMod))) vibrato.drift = num(raw.dF0VbrMod)
  return Object.keys(vibrato).length ? vibrato : null
}

/* ================================================================== 读取 */

export function read(buffer, opts = {}) {
  if (!Buffer.isBuffer(buffer)) {
    if (typeof buffer === 'string') buffer = Buffer.from(buffer, 'utf8')
    else throw new Error('svp 读取失败：输入不是 Buffer 或字符串')
  }
  let text = buffer.toString('utf8').replace(/^\uFEFF/, '')
  let json = null
  let lastError = null

  // .svp 可能是「一个 JSON + 尾部 NUL」，也可能是用 NUL 分隔的多份文档
  // （UtaFormatix 导出时会出现）。逐段尝试解析，取 version 最大的一份。
  const candidates = text.split('\u0000').map((s) => s.trim()).filter(Boolean)
  const list = candidates.length ? candidates : [text.trim()]
  for (const part of list) {
    if (!part.startsWith('{') && !part.startsWith('[')) continue
    try {
      const parsed = JSON.parse(part)
      if (!json || num(parsed && parsed.version, 0) > num(json.version, 0)) json = parsed
    } catch (err) {
      lastError = err
    }
  }
  if (!json) {
    if (lastError) throw new Error(`svp 解析失败：不是合法 JSON（${lastError.message}）`)
    throw new Error('svp 解析失败：文件里没有找到 JSON 对象')
  }
  if (typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('svp 解析失败：顶层不是 JSON 对象')
  }
  if (!Array.isArray(json.tracks)) {
    if (json.mainGroup || json.version === undefined) {
      throw new Error('svp 解析失败：缺少 tracks 数组，可能不是 Synthesizer V 工程')
    }
    throw new Error('svp 解析失败：顶层缺少 tracks 数组')
  }

  const name =
    (opts && opts.name ? String(opts.name).replace(/\.svp$/i, '') : '') ||
    (json.renderConfig && typeof json.renderConfig.filename === 'string' ? json.renderConfig.filename : '') ||
    '未命名工程'

  const tempos = readTempos(json)
  const timeSignatures = readTimeSignatures(json)
  const tracks = []
  for (let i = 0; i < json.tracks.length; i += 1) {
    try {
      const t = readTrack(json, json.tracks[i], i, tempos)
      if (t) tracks.push(t)
    } catch {
      // 单轨坏数据不应中断整体读取
    }
  }
  if (!tracks.length) tracks.push(createTrack({ name: 'Track 1' }))

  const project = createProject({
    name,
    sourceFormat: 'svp',
    tempos,
    timeSignatures,
    measurePrefix: 0,
    tracks,
  })
  project.extras.svp = {
    version: Number.isFinite(Number(json.version)) ? Number(json.version) : 113,
    renderConfig: json.renderConfig && typeof json.renderConfig === 'object' ? json.renderConfig : null,
    library: Array.isArray(json.library) ? json.library : [],
    rawTempos: Array.isArray(json.time?.tempo) ? json.time.tempo : [],
    rawMeters: Array.isArray(json.time?.meter) ? json.time.meter : [],
  }
  return project
}

function readTempos(json) {
  const raw = Array.isArray(json.time && json.time.tempo) ? json.time.tempo : []
  const out = []
  for (const t of raw) {
    const bpm = num(t && t.bpm, NaN)
    if (!Number.isFinite(bpm) || bpm <= 0) continue
    out.push({ tick: Math.max(0, blickToTick(t.position ?? t.tick ?? 0)), bpm })
  }
  out.sort((a, b) => a.tick - b.tick)
  if (!out.length) out.push({ tick: 0, bpm: 120 })
  if (out[0].tick !== 0) out.unshift({ tick: 0, bpm: out[0].bpm })
  return dedupeByTick(out)
}

function readTimeSignatures(json) {
  const raw = Array.isArray(json.time && json.time.meter) ? json.time.meter : []
  const entries = []
  for (const m of raw) {
    const numerator = Math.round(num(m && m.numerator, 4))
    const denominator = Math.round(num(m && m.denominator, 4))
    const index = Math.max(0, Math.round(num(m && m.index, 0)))
    if (!(numerator > 0) || ![1, 2, 4, 8, 16, 32].includes(denominator)) continue
    entries.push({ index, numerator, denominator })
  }
  entries.sort((a, b) => a.index - b.index)
  if (!entries.length) return [{ tick: 0, numerator: 4, denominator: 4 }]

  // meter.index 是 0 基小节号：第 M 小节的起点固定落在 tick = M * 1920（4/4 网格，
  // 与 SynthV 内部一致），拍号在该小节起点生效。这样「tick <-> 小节号」是无歧义双射，
  // 与写出的 tickMeasureGrid() 严格对称，保证变拍号工程的往返精度。
  const sigs = []
  let cursor = 0
  let cur = { numerator: 4, denominator: 4 }
  const lastIndex = entries[entries.length - 1].index
  for (let measure = 0; measure <= lastIndex && measure < 200000; measure += 1) {
    while (cursor < entries.length && entries[cursor].index <= measure) {
      cur = entries[cursor]
      cursor += 1
    }
    const tick = measure * MEASURE_GRID
    const prev = sigs[sigs.length - 1]
    if (!prev || prev.numerator !== cur.numerator || prev.denominator !== cur.denominator) {
      sigs.push({ tick, numerator: cur.numerator, denominator: cur.denominator })
    }
  }
  return sigs.length ? dedupeByTick(sigs) : [{ tick: 0, numerator: 4, denominator: 4 }]
}

function dedupeByTick(list) {
  const out = []
  for (const item of list) {
    const prev = out[out.length - 1]
    if (prev && prev.tick === item.tick) out[out.length - 1] = item
    else out.push(item)
  }
  return out
}

function readTrack(json, raw, index, tempos) {
  if (!raw || typeof raw !== 'object') return null
  const groupsById = new Map()
  if (Array.isArray(json.library)) {
    for (const g of json.library) if (g && typeof g === 'object' && g.uuid) groupsById.set(g.uuid, g)
  }

  const notes = []

  const mainRef = raw.mainRef && typeof raw.mainRef === 'object' ? raw.mainRef : {}
  const mainGroup = raw.mainGroup && typeof raw.mainGroup === 'object' ? raw.mainGroup : null
  const blickOffset = num(mainRef.blickOffset, 0)
  const pitchOffsetSemis = Math.round(num(mainRef.pitchOffset, 0))

  const mainPitchDelta = mainGroup
    ? readGroupNotes(mainGroup, blickOffset, pitchOffsetSemis, notes, tempos)
    : null

  // groups[] 引用的额外 NoteGroup 也属于同一轨
  const extraPitchPoints = []
  if (Array.isArray(raw.groups)) {
    for (const ref of raw.groups) {
      if (!ref || typeof ref !== 'object') continue
      const g = groupsById.get(ref.groupID)
      if (!g) continue
      const off = num(ref.blickOffset, 0)
      const po = Math.round(num(ref.pitchOffset, 0))
      const pd = readGroupNotes(g, off, po, notes, tempos)
      if (pd) extraPitchPoints.push({ pitchDelta: pd })
    }
  }

  const allNotes = notes.filter((n) => n.tick >= 0).sort((a, b) => a.tick - b.tick || a.key - b.key)
  const { notes: irNotes, phonemes } = splitNotesAndPhonemes(allNotes)

  const pitchCurve = readPitchCurve(mainPitchDelta, extraPitchPoints, allNotes)

  const parameters = {}
  const rawAutomationStash = {}
  const pmap = [
    ['loudness', 'dynamics', loudnessToUnit],
    ['tension', 'tension', bipolarToUnit],
    ['breathiness', 'breathiness', breathinessToUnit],
    ['voicing', 'voicing', voicingToUnit],
    ['gender', 'gender', bipolarToUnit],
  ]
  if (mainGroup) {
    for (const [svKey, irKey, mapValue] of pmap) {
      const rawParam = mainGroup.parameters ? mainGroup.parameters[svKey] : null
      const curve = automationToCurve(rawParam, mapValue)
      if (curve) parameters[irKey] = createCurve(curve)
      if (rawParam && typeof rawParam === 'object') rawAutomationStash[svKey] = rawParam
    }
    if (mainGroup.parameters) {
      for (const key of ['pitchDelta', 'vibratoEnv']) {
        const p = mainGroup.parameters[key]
        if (p && typeof p === 'object') rawAutomationStash[key] = p
      }
    }
  }

  const mixer = raw.mixer && typeof raw.mixer === 'object' ? raw.mixer : {}
  const gainDb = num(mixer.gainDecibel, 0)
  const database = mainRef.database && typeof mainRef.database === 'object' ? mainRef.database : {}

  const track = createTrack({
    id: `svp-trk${index + 1}`,
    name: typeof raw.name === 'string' && raw.name ? raw.name : `Track ${index + 1}`,
    singer: typeof database.name === 'string' ? database.name : '',
    color: colorToHex(raw.dispColor),
    muted: !!mixer.mute,
    solo: !!mixer.solo,
    volume: clamp01((gainDb + 60) / 60),
    pan: clamp(num(mixer.pan, 0), -1, 1),
    language: languageFromDatabase(database),
    notes: irNotes,
    pitch: pitchCurve,
    parameters,
    phonemes,
  })

  track.extras.svpAutomation = rawAutomationStash
  track.extras.svp = {
    dispOrder: Number.isFinite(Number(raw.dispOrder)) ? Number(raw.dispOrder) : index,
    renderEnabled: raw.renderEnabled !== false,
    dispColor: typeof raw.dispColor === 'string' ? raw.dispColor : null,
    rawTrack: sanitizeRaw(raw),
    rawMainRef: mainRef,
    rawMainGroup: mainGroup,
    // SynthV 2 的原生结构：参数块里的 toneShift（移调曲线）与 vocalModes（Vocal Mode
    // 参数曲线）在 IR 里没有对应位置，原样留在这里供同格式写回（丢了用户会觉得音色变了）
    rawParameters: mainGroup && mainGroup.parameters && typeof mainGroup.parameters === 'object'
      ? mainGroup.parameters
      : null,
    rawVocalModes: mainGroup && mainGroup.vocalModes && typeof mainGroup.vocalModes === 'object'
      ? mainGroup.vocalModes
      : null,
    rawGroups: Array.isArray(raw.groups) ? raw.groups : [],
    isInstrumental: !!mainRef.isInstrumental,
  }
  return track
}

/** 读取一个 NoteGroup 的音符（推入 notes），返回其原始 pitchDelta */
function readGroupNotes(group, blickOffset, pitchOffsetSemis, notes, tempos) {
  const params = group.parameters && typeof group.parameters === 'object' ? group.parameters : null
  const rawNotes = Array.isArray(group.notes) ? group.notes : []
  for (const rn of rawNotes) {
    if (!rn || typeof rn !== 'object') continue
    try {
      const onset = num(rn.onset, NaN)
      const duration = num(rn.duration, NaN)
      const pitch = num(rn.pitch, NaN)
      if (!Number.isFinite(onset) || !Number.isFinite(duration) || !Number.isFinite(pitch)) continue
      if (duration <= 0) continue
      const tick = blickToTick(onset + blickOffset)
      const dur = Math.max(1, blickToTick(duration))
      const key = Math.round(pitch) + pitchOffsetSemis
      if (key < 0 || key > 127) continue
      const attributes = extractNoteAttributes(rn.attributes)
      const symbols = phonemesToIr(rn.phonemes)
      const note = createNote({
        tick,
        duration: dur,
        key,
        lyric: typeof rn.lyrics === 'string' ? rn.lyrics : '',
        velocity: 64,
        phoneme: symbols.length ? symbols[0] : null,
        attributes: {},
      })
      note.attributes.sv = { ...attributes }
      if (symbols.length) note.attributes.svPhonemes = symbols
      note.attributes.svNote = rn
      const vibrato = vibratoToIr(rn.attributes, note, tempos)
      if (vibrato) note.attributes.vibrato = vibrato
      notes.push(note)
    } catch {
      // 跳过坏音符
    }
  }
  return params ? params.pitchDelta : null
}

/** IR 音符拆成「音符 + 音素时间轴」 */
function splitNotesAndPhonemes(notes) {
  const phonemes = []
  const out = notes.map((n, i) => {
    const symbols = Array.isArray(n.attributes.svPhonemes) ? n.attributes.svPhonemes : []
    if (symbols.length > 1) phonemes.push(...buildPhonemes(symbols, n.tick, n.duration, i))
    return n
  })
  return { notes: out, phonemes }
}

function readPitchCurve(mainPitchDelta, extras, notes) {
  const lists = []
  const main = pitchDeltaToAbsolute(mainPitchDelta, notes, 0)
  if (main) lists.push(main)
  for (const e of extras) {
    const c = pitchDeltaToAbsolute(e.pitchDelta, notes, 0)
    if (c) lists.push(c)
  }
  if (!lists.length) return createCurve()
  const ticks = []
  const values = []
  for (const c of lists) {
    for (let i = 0; i < c.ticks.length; i += 1) {
      ticks.push(c.ticks[i])
      values.push(c.values[i])
    }
  }
  return createCurve({ ticks, values })
}

function sanitizeRaw(raw) {
  const skip = new Set(['name', 'dispOrder', 'dispColor', 'renderEnabled', 'mixer', 'mainGroup', 'mainRef', 'groups'])
  const out = {}
  for (const [k, v] of Object.entries(raw)) if (!skip.has(k)) out[k] = v
  return out
}

/* ================================================================== 写出 */

export function write(project, opts = {}) {
  if (!project || typeof project !== 'object') throw new Error('svp 写出失败：project 不是对象')
  const tracksIn = Array.isArray(project.tracks) ? project.tracks : []
  if (!tracksIn.length) throw new Error('svp 写出失败：工程没有任何轨道')

  const rawTempos = project.extras?.svp?.rawTempos
  const rawMeters = project.extras?.svp?.rawMeters
  const keepRaw = project.sourceFormat === 'svp'

  const tempo = buildTempo(project, keepRaw ? rawTempos : null)
  const meter = buildMeter(project, keepRaw ? rawMeters : null)

  const tracks = tracksIn.map((track, i) => buildTrack(track, i, keepRaw))

  const out = {
    version: Number.isFinite(Number(project.extras?.svp?.version)) ? Number(project.extras.svp.version) : 113,
    time: { meter, tempo },
    library: keepRaw && Array.isArray(project.extras?.svp?.library) ? project.extras.svp.library : [],
    tracks,
    renderConfig: buildRenderConfig(project, opts),
  }
  return Buffer.from(JSON.stringify(out, null, 2), 'utf8')
}

function buildTempo(project, rawTempos) {
  const seen = new Set()
  const out = []
  for (const t of project.tempos ?? []) {
    const bpm = num(t.bpm, NaN)
    if (!Number.isFinite(bpm) || bpm <= 0) continue
    const position = tickToBlick(Math.max(0, t.tick))
    if (seen.has(position)) continue
    seen.add(position)
    out.push({ position, bpm })
  }
  if (!out.length) out.push({ position: 0, bpm: 120 })
  if (rawTempos && rawTempos.length === out.length) {
    // 值未变时复用原始浮点写法，避免 120.0 -> 120 之类的表征漂移
    const same = rawTempos.every((r, i) => num(r.bpm) === out[i].bpm && num(r.position) === out[i].position)
    if (same) return rawTempos.map((r) => ({ position: num(r.position), bpm: num(r.bpm) }))
  }
  return out
}

function buildMeter(project, rawMeters) {
  const sigs = (project.timeSignatures ?? [])
    .filter((s) => s && Number(s.numerator) > 0 && [1, 2, 4, 8, 16, 32].includes(Number(s.denominator)))
    .slice()
    .sort((a, b) => a.tick - b.tick)
  if (!sigs.length) sigs.push({ tick: 0, numerator: 4, denominator: 4 })

  const out = []
  for (const s of sigs) {
    const index = tickMeasureGrid(Math.max(0, Math.round(s.tick)))
    const numerator = Math.round(Number(s.numerator))
    const denominator = Math.round(Number(s.denominator))
    const prev = out[out.length - 1]
    if (prev && prev.index === index) {
      out[out.length - 1] = { index, numerator, denominator }
      continue
    }
    if (!prev || prev.numerator !== numerator || prev.denominator !== denominator) {
      out.push({ index, numerator, denominator })
    }
  }

  if (rawMeters && rawMeters.length === out.length) {
    const same = rawMeters.every(
      (r, i) =>
        num(r.index) === out[i].index &&
        num(r.numerator) === out[i].numerator &&
        num(r.denominator) === out[i].denominator,
    )
    if (same) {
      return rawMeters.map((r) => ({
        index: num(r.index),
        numerator: num(r.numerator),
        denominator: num(r.denominator),
      }))
    }
  }
  return out
}

/** tick -> 0 基小节号（4/4 网格，与 readTimeSignatures 严格互逆） */
function tickMeasureGrid(tick) {
  return Math.max(0, Math.round(Math.max(0, Math.round(tick)) / MEASURE_GRID))
}

function buildRenderConfig(project, opts) {
  const raw = project.extras?.svp?.renderConfig
  const base = {
    destination: './',
    filename: 'untitled',
    numChannels: 1,
    aspirationFormat: 'noAspiration',
    bitDepth: 16,
    sampleRate: 44100,
    exportMixDown: true,
  }
  const out = { ...base, ...(raw && typeof raw === 'object' ? raw : {}) }
  const name = (opts && opts.name) || project.name
  if (name) out.filename = String(name).replace(/\.svp$/i, '')
  return out
}

function buildTrack(track, index, keepRaw) {
  const svpExtras = track.extras?.svp ?? {}
  const rawTrack = keepRaw && svpExtras.rawTrack && typeof svpExtras.rawTrack === 'object' ? svpExtras.rawTrack : {}
  const rawMainRef =
    keepRaw && svpExtras.rawMainRef && typeof svpExtras.rawMainRef === 'object' ? svpExtras.rawMainRef : null

  const uuid = keepRaw && typeof svpExtras.rawMainGroup?.uuid === 'string' ? svpExtras.rawMainGroup.uuid : randomUUID()

  const notes = (Array.isArray(track.notes) ? track.notes : [])
    .slice()
    .sort((a, b) => a.tick - b.tick || a.key - b.key)

  const params = buildParameters(track, notes, keepRaw)
  const rawGroup = keepRaw && svpExtras.rawMainGroup && typeof svpExtras.rawMainGroup === 'object' ? svpExtras.rawMainGroup : {}

  // SynthV 2 的声库信息：languageOverride / phonesetOverride / backendType / version 这些
  // 渲染相关字段 IR 不承载，同格式往返时按原值写回，否则编辑器可能按默认声库重渲染
  const rawDb =
    keepRaw && rawMainRef?.database && typeof rawMainRef.database === 'object' ? rawMainRef.database : {}
  const database = {
    ...rawDb,
    name: typeof rawDb.name === 'string' && rawDb.name ? rawDb.name : String(track.singer ?? ''),
    language: pickLanguage(track, rawMainRef),
    phoneset: typeof rawDb.phoneset === 'string' ? rawDb.phoneset : '',
  }

  return {
    ...rawTrack,
    name: typeof track.name === 'string' && track.name ? track.name : `Track ${index + 1}`,
    dispColor: track.color ? hexToDispColor(track.color) : svpExtras.dispColor || 'ff7db235',
    dispOrder: Number.isFinite(Number(svpExtras.dispOrder)) ? Number(svpExtras.dispOrder) : index,
    renderEnabled: svpExtras.renderEnabled !== false,
    mixer: buildMixer(track),
    // 同格式往返：先展开原生 NoteGroup（保留 vocalModes 等 SynthV 2 结构），再覆盖我们管理的字段
    mainGroup: {
      ...rawGroup,
      ...(rawGroup.extra && typeof rawGroup.extra === 'object' ? rawGroup.extra : {}),
      name: typeof rawGroup.name === 'string' && rawGroup.name ? rawGroup.name : 'main',
      parameters: params,
      notes: notes.map((n) => buildNote(n, keepRaw)),
      uuid,
    },
    mainRef: {
      ...(rawMainRef ?? {}),
      groupID: uuid,
      blickOffset: num(rawMainRef?.blickOffset, 0),
      pitchOffset: num(rawMainRef?.pitchOffset, 0),
      isInstrumental: !!rawMainRef?.isInstrumental,
      database,
      audio:
        rawMainRef?.audio && typeof rawMainRef.audio === 'object'
          ? rawMainRef.audio
          : { filename: '', duration: 0 },
      dictionary: typeof rawMainRef?.dictionary === 'string' ? rawMainRef.dictionary : '',
      voice: rawMainRef?.voice && typeof rawMainRef.voice === 'object' ? rawMainRef.voice : {},
    },
    groups: Array.isArray(svpExtras.rawGroups) ? svpExtras.rawGroups : [],
  }
}

function pickLanguage(track, rawMainRef) {
  const raw = rawMainRef?.database?.language
  const irLang = String(track.language ?? '').toLowerCase()
  if (irLang && IR_TO_SVP_LANG[irLang] && raw !== IR_TO_SVP_LANG[irLang]) return IR_TO_SVP_LANG[irLang]
  if (typeof raw === 'string' && raw) return raw
  return IR_TO_SVP_LANG[irLang] ?? ''
}

function buildMixer(track) {
  return {
    gainDecibel: Math.round((clamp01(num(track.volume, 1)) * 60 - 60) * 1000) / 1000,
    pan: clamp(num(track.pan, 0), -1, 1),
    mute: !!track.muted,
    solo: !!track.solo,
    display: true,
  }
}

function buildNote(note, keepRaw) {
  const raw = note.attributes?.svNote && typeof note.attributes.svNote === 'object' ? note.attributes.svNote : null
  const attributes = {}
  if (raw && raw.attributes && typeof raw.attributes === 'object') {
    for (const [k, v] of Object.entries(raw.attributes)) {
      if (k === 'phonemes') continue
      attributes[k] = v
    }
  } else if (note.attributes?.sv && typeof note.attributes.sv === 'object') {
    for (const [k, v] of Object.entries(note.attributes.sv)) attributes[k] = v
  }
  // 同格式往返：先展开原生音符，保留 SynthV 2 的 musicalType / accent / detune /
  // instantMode / systemAttributes / pitchTakes / timbreTakes 等 IR 不承载的字段，
  // 再覆盖本模块管理的六个字段（键序也与源文件一致）
  const base = keepRaw && raw ? { ...raw } : {}
  return {
    ...base,
    onset: tickToBlick(Math.max(0, Math.round(note.tick))),
    duration: Math.max(1, tickToBlick(Math.max(1, Math.round(note.duration)))),
    lyrics: typeof note.lyric === 'string' ? note.lyric : '',
    phonemes: phonemeToSvp(note),
    pitch: Math.round(num(note.key, 60)),
    attributes,
  }
}

function buildParameters(track, notes, keepRaw) {
  const stash = track.extras?.svpAutomation ?? null
  const params = {}
  params.pitchDelta = buildPitchDelta(track, notes, keepRaw, stash)
  params.vibratoEnv = buildVibratoEnv(track, keepRaw, stash)
  params.loudness = buildAutomation(
    paramCurve(track, 'dynamics'),
    unitToLoudness,
    keepRaw ? rawAutomation(track.extras, 'loudness') : null,
  )
  params.tension = buildAutomation(
    paramCurve(track, 'tension'),
    unitToBipolar,
    keepRaw ? rawAutomation(track.extras, 'tension') : null,
  )
  params.breathiness = buildAutomation(
    paramCurve(track, 'breathiness'),
    unitToBreathiness,
    keepRaw ? rawAutomation(track.extras, 'breathiness') : null,
  )
  params.voicing = buildAutomation(
    paramCurve(track, 'voicing'),
    unitToVoicing,
    keepRaw ? rawAutomation(track.extras, 'voicing') : null,
  )
  params.gender = buildAutomation(
    paramCurve(track, 'gender'),
    unitToBipolar,
    keepRaw ? rawAutomation(track.extras, 'gender') : null,
  )
  // SynthV 2 新增的 toneShift（移调曲线）等参数 IR 里没有规范名，同格式往返原样写回
  if (keepRaw) {
    const raw = track.extras?.svp?.rawParameters
    if (raw && typeof raw === 'object') {
      for (const [key, value] of Object.entries(raw)) {
        if (Object.hasOwn(params, key)) continue
        params[key] = value
      }
    }
  }
  return params
}

function buildPitchDelta(track, notes, keepRaw, stash) {
  if (keepRaw) {
    const raw = rawAutomation(track.extras, 'pitchDelta')
    if (raw) return raw
    if (stash && stash.pitchDelta) {
      const a = parseAutomation(stash.pitchDelta)
      if (a && a.xs.length) {
        const points = []
        for (let i = 0; i < a.xs.length; i += 1) points.push(a.xs[i], a.ys[i])
        return { mode: a.mode, points }
      }
    }
  }
  const curve = track.pitch && track.pitch.ticks && track.pitch.ticks.length ? track.pitch : null
  if (!curve) return { mode: 'cubic', points: [] }
  return absoluteToPitchDelta(curve, notes, 0)
}

function buildVibratoEnv(track, keepRaw, stash) {
  if (keepRaw) {
    const raw = rawAutomation(track.extras, 'vibratoEnv')
    if (raw) return raw
    if (stash && stash.vibratoEnv) {
      const a = parseAutomation(stash.vibratoEnv)
      if (a && a.xs.length) {
        const points = []
        for (let i = 0; i < a.xs.length; i += 1) points.push(a.xs[i], a.ys[i])
        return { mode: a.mode, points }
      }
    }
  }
  return { mode: 'cubic', points: [] }
}

function buildAutomation(curve, mapValue, raw) {
  if (raw) return raw
  return curveToAutomation(curve, mapValue)
}

export default { meta, fidelity, read, write }
