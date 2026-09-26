/**
 * UtaFormatix Data（.ufdata）读写模块
 *
 * 字段名与语义依据（仅参考字段定义，代码全部自行实现）：
 *   - sdercolin/utaformatix-data（Apache-2.0）类型定义，UtaFormatixDataVersion = 1
 *   - sdercolin/utaformatix3 `core/src/main/kotlin/core/io/UfData.kt`
 *
 * 文档结构（v1）：
 *   {
 *     "formatVersion": 1,
 *     "project": {
 *       "name": String,
 *       "tracks": [ { "name": String,
 *                     "notes": [ { "key": Int, "tickOn": Int64, "tickOff": Int64,
 *                                  "lyric": String, "phoneme": String? } ],
 *                     "pitch": { "ticks": [Int64], "values": [Double?], "isAbsolute": Bool } } ],
 *       "timeSignatures": [ { "measurePosition": Int, "numerator": Int, "denominator": Int } ],
 *       "tempos": [ { "tickPosition": Int64, "bpm": Double } ],
 *       "measurePrefix": Int
 *     }
 *   }
 *
 * 关键差异（相对本 IR）：
 *   1) 音符用 tickOn / tickOff（起止 tick），不是 tick + duration；
 *   2) 速度用 tickPosition，拍号用 measurePosition（小节序号，不是 tick！）；
 *   3) measurePrefix 是「前缀小节数」（这些小节不能放音符），不是 tick 数；
 *   4) pitch.values 可含 null（表示前一个音高的持续在此结束）；isAbsolute 为 false 时
 *      音高是相对所在音符 key 的偏移；
 *   5) 格式本身没有参数曲线、歌手、轨道音量等概念 —— 本模块把这些写进 vpir 扩展字段
 *      （UtaFormatix 的解析器 ignoreUnknownKeys，会安全忽略），从而本站内部往返无损。
 *
 * vpir 扩展字段（本站私有；读出时优先取回，opts.extended === false 时不写出）：
 *   project.vpir = { comment, extras,
 *                    measurePrefixTicks?,              // 非整小节的弱起，精确保留
 *                    timeSignatures?[] }               // {measurePosition, numerator, denominator, offset}
 *   track.vpir   = { singer, color, muted, solo, volume, pan, language, parameters, extras }
 *   note.vpir    = { pitchOffset, detune, velocity, attributes, tickOff? }
 */

import {
  TPQ,
  PARAM_NAMES,
  clamp,
  createProject,
  createTrack,
  createNote,
  createCurve,
  normalizeCurve,
} from '../ir.mjs'

export const meta = {
  id: 'ufdata',
  name: 'UtaFormatix 数据',
  vendor: 'UtaFormatix',
  exts: ['.ufdata', '.json'],
  kind: 'json',
  canRead: true,
  canWrite: true,
  writeExt: '.ufdata',
  encoding: 'utf8',
}

export const fidelity = {
  preserves: [
    'tempo',
    'timeSignature',
    'notes',
    'lyrics',
    'pitchCurve',
    'phoneme',
    'measurePrefix',
    '工程名/轨道名',
    'multiTrack',
    'vibrato',
    'singer',
    'trackVolume',
    'trackPan',
    'detune',
    'velocity',
    'params.dynamics',
    'params.breathiness',
  ],
  drops: [
    '参数曲线（dynamics / breathiness 等）—— 仅在经过 UtaFormatix 网页版时会丢失',
    '歌手名、轨道颜色/音量/声像、音符 DETUNE/VEL 等 —— 同上',
    '音高的 null 断点（isAbsolute 时表示「前一音高到此结束」）',
  ],
  notes:
    'UtaFormatix 官方交换格式（v1）只描述 名称/轨道/音符/速度/拍号/音高曲线，' +
    '音高支持绝对与相对两种表示。本站额外把格式装不下的 IR 数据（参数曲线、歌手、颜色、' +
    '音量、音符 DETUNE/VEL、小节内的拍号位置等）写进 vpir 扩展字段，UtaFormatix 会安全忽略，' +
    '因此本站内部往返无损；但经 UtaFormatix 网页版转存后这些扩展会消失。',
}

/** 全音符 tick 数（UtaFormatix 内部同样为 480 tick/四分音符） */
const FULL_NOTE_TICKS = TPQ * 4
const EMPTY_PITCH = () => ({ ticks: [], values: [], isAbsolute: false })

/* ------------------------------------------------------------------ 小工具 */

function toText(buffer) {
  if (typeof buffer === 'string') return buffer
  if (buffer == null) throw new Error('UtaFormatix 数据为空，无法读取')
  if (!Buffer.isBuffer(buffer)) {
    if (buffer instanceof Uint8Array) return Buffer.from(buffer).toString('utf8')
    throw new Error('UtaFormatix 数据必须是 Buffer 或字符串')
  }
  return buffer.toString('utf8')
}

function num(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function intOr(value, fallback) {
  const n = Number(value)
  return Number.isFinite(n) ? Math.round(n) : fallback
}

function ticksInMeasure(numerator, denominator) {
  const n = Math.max(1, intOr(numerator, 4))
  const d = Math.max(1, intOr(denominator, 4))
  return Math.round((FULL_NOTE_TICKS * n) / d)
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

/** 判断是否为规范参数名 */
function isCanonicalParam(name) {
  return PARAM_NAMES.includes(name)
}

/**
 * 小节序号 -> tick（读取方向）。
 *
 * 与 utaformatix3 的 `TickCounter` 同一套算法：从第 0 小节（tick 0）开始，
 * 按「当前生效拍号」的小节长度逐小节累加，拍号变化从它所在的小节起生效。
 * 因此 tick(小节 m) = Σ 前 m 个小节的长度，长度取各小节当时生效的拍号。
 *
 * @param {Array} mainSigs 主列表里的拍号节点（measurePosition / numerator / denominator）
 * @param {Array} extSigs  vpir 扩展里的拍号节点（带 offset，用于表示小节内的拍号变化）
 * @returns {Array<{tick:number,numerator:number,denominator:number}>}
 */
function resolveTimeSignatures(mainSigs, extSigs) {
  const norm = (node, offset, kind, seq) => ({
    measurePosition: Math.max(0, intOr(node.measurePosition ?? node.tick, 0)),
    numerator: Math.max(1, intOr(node.numerator, 4)),
    denominator: Math.max(1, intOr(node.denominator, 4)),
    offset: num(offset, 0),
    kind,
    seq,
  })
  const events = []
  mainSigs.forEach((s, i) => events.push(norm(s, 0, 0, i)))
  extSigs.forEach((s, i) => events.push(norm(s, s.offset, 1, i)))
  // 同一小节序号内：主列表的节点在前（写端保证它是最早那个），扩展节点按书写顺序在后
  events.sort(
    (a, b) => a.measurePosition - b.measurePosition || a.kind - b.kind || a.seq - b.seq,
  )

  const out = []
  let measure = 0
  let measureStart = 0
  let cur = { numerator: 4, denominator: 4 }
  for (const event of events) {
    let guard = 0
    while (measure < event.measurePosition && guard < 1000000) {
      measureStart += ticksInMeasure(cur.numerator, cur.denominator)
      measure += 1
      guard += 1
    }
    out.push({
      tick: Math.max(0, Math.round(measureStart + event.offset)),
      numerator: event.numerator,
      denominator: event.denominator,
    })
    cur = { numerator: event.numerator, denominator: event.denominator }
  }
  // 同一 tick 只保留最后一个
  const map = new Map()
  for (const sig of out) map.set(sig.tick, { numerator: sig.numerator, denominator: sig.denominator })
  return [...map.entries()]
    .map(([tick, v]) => ({ tick, numerator: v.numerator, denominator: v.denominator }))
    .sort((a, b) => a.tick - b.tick)
}

/**
 * tick -> 小节序号（写出方向），与上面同一套累加规则。
 * 返回值带 offset：tick 落在小节内部时表示相对小节起点的偏移（UtaFormatix 表示不了，走扩展字段）。
 * @returns {Array<{measurePosition:number,numerator:number,denominator:number,offset:number}>}
 */
function ticksToMeasurePositions(sigs) {
  const events = []
  let measure = 0
  let measureStart = 0
  let cur = { numerator: 4, denominator: 4 }
  for (const sig of sigs) {
    let guard = 0
    for (;;) {
      const len = ticksInMeasure(cur.numerator, cur.denominator)
      if (measureStart + len > sig.tick || guard >= 1000000) break
      measureStart += len
      measure += 1
      guard += 1
    }
    events.push({
      measurePosition: measure,
      numerator: sig.numerator,
      denominator: sig.denominator,
      offset: sig.tick - measureStart,
    })
    cur = { numerator: sig.numerator, denominator: sig.denominator }
  }
  return events
}

/* -------------------------------------------------------------- 音高换算 */

/** 相邻音符的分界 tick：相邻则取分界点，有空隙则取中点（与 utaformatix3 一致） */
function noteBorders(notes) {
  const borders = []
  let pos = -1
  for (const note of notes) {
    if (pos < 0) {
      pos = note.tick + note.duration
      continue
    }
    if (pos === note.tick) borders.push(pos)
    else if (pos < note.tick) borders.push(Math.round((note.tick + pos) / 2))
    else borders.push(note.tick) // 音符重叠：容错，取后一个音符起点
    pos = note.tick + note.duration
  }
  return borders
}

/** 相对音高（相对所在音符 key 的偏移）-> 绝对音高（semitones） */
function relativeToAbsolute(points, notes) {
  if (!notes.length) return null
  const borders = noteBorders(notes)
  const paired = points
    .map(([tick, value]) => [intOr(tick, NaN), Number(value)])
    .filter(([tick, value]) => Number.isFinite(tick) && Number.isFinite(value))
    .sort((a, b) => a[0] - b[0])
  let index = 0
  let border = borders.length ? borders[0] : Number.MAX_SAFE_INTEGER
  const out = []
  for (const [tick, value] of paired) {
    while (tick >= border && index < notes.length - 1) {
      index += 1
      border = index < borders.length ? borders[index] : Number.MAX_SAFE_INTEGER
    }
    out.push([tick, notes[index].key + value])
  }
  return out
}

/** 绝对音高 -> 相对所在音符 key 的偏移 */
function absoluteToRelative(points, notes) {
  if (!notes.length) return points
  const borders = noteBorders(notes)
  let index = 0
  let border = borders.length ? borders[0] : Number.MAX_SAFE_INTEGER
  return points.map(([tick, value]) => {
    while (tick >= border && index < notes.length - 1) {
      index += 1
      border = index < borders.length ? borders[index] : Number.MAX_SAFE_INTEGER
    }
    return [tick, value - notes[index].key]
  })
}

/* ------------------------------------------------------------------ 读取 */

function readPitch(node, notes, trackExtras, warnings) {
  if (!isPlainObject(node)) return createCurve()
  const ticks = Array.isArray(node.ticks) ? node.ticks : []
  const values = Array.isArray(node.values) ? node.values : []
  const n = Math.min(ticks.length, values.length)
  // 规范中 isAbsolute 的默认值是 false（相对音符 key 的偏移）。
  // 缺少该字段属于不规范数据：按数值范围判断（音高偏移通常不超过 ±2 个八度），并记录告警。
  let isAbsolute = node.isAbsolute !== false
  if (typeof node.isAbsolute !== 'boolean') {
    const numeric = []
    for (let i = 0; i < n; i += 1) {
      const v = Number(values[i])
      if (Number.isFinite(v)) numeric.push(v)
    }
    const looksRelative = numeric.length > 0 && numeric.every((v) => Math.abs(v) <= 24)
    isAbsolute = !looksRelative
    warnings.push(
      `音高曲线缺少 isAbsolute 字段，按数值范围判断为「${isAbsolute ? '绝对' : '相对'}音高」，` +
        '若结果不对请补上该字段',
    )
  }
  const points = []
  let nullCount = 0
  for (let i = 0; i < n; i += 1) {
    const tick = Number(ticks[i])
    const value = values[i]
    if (!Number.isFinite(tick)) continue
    if (value === null || value === undefined) {
      // null 表示前一个音高的持续到此结束，IR 无法表达，跳过并记录
      nullCount += 1
      continue
    }
    if (!Number.isFinite(Number(value))) continue
    points.push([Math.round(tick), Number(value)])
  }
  if (nullCount) warnings.push(`音高曲线中有 ${nullCount} 个 null 断点（表示前值到此结束），IR 无法表达，已跳过`)
  trackExtras.ufdata = { ...(trackExtras.ufdata ?? {}), pitchIsAbsolute: isAbsolute }
  if (!points.length) return createCurve()
  if (isAbsolute) return createCurve({ ticks: points.map((p) => p[0]), values: points.map((p) => p[1]) })
  if (!notes.length) {
    warnings.push('音高曲线为相对表示，但该轨道没有音符，无法换算成绝对音高，已丢弃')
    return createCurve()
  }
  const abs = relativeToAbsolute(points, notes)
  return createCurve({ ticks: abs.map((p) => p[0]), values: abs.map((p) => p[1]) })
}

function readNote(node, index, warnings) {
  if (!isPlainObject(node)) {
    warnings.push(`第 ${index + 1} 个音符不是对象，已跳过`)
    return null
  }
  const tick = intOr(node.tickOn ?? node.tick, NaN)
  if (!Number.isFinite(tick) || tick < 0) {
    warnings.push(`第 ${index + 1} 个音符的 tickOn 非法（${node.tickOn ?? node.tick}），已跳过`)
    return null
  }
  const rawOff = intOr(node.tickOff, NaN)
  const rawDuration = intOr(node.duration ?? node.length, NaN)
  const duration = Number.isFinite(rawOff) ? rawOff - tick : rawDuration
  const key = intOr(node.key ?? node.noteNumber, NaN)
  if (!Number.isFinite(key) || key < 0 || key > 127) {
    warnings.push(`第 ${index + 1} 个音符的音高非法（${node.key}），已跳过`)
    return null
  }
  const vpir = isPlainObject(node.vpir) ? node.vpir : {}
  const attributes = isPlainObject(vpir.attributes) ? { ...vpir.attributes } : {}
  const note = createNote({
    tick,
    duration: Number.isFinite(duration) && duration >= 1 ? duration : 1,
    key,
    lyric: typeof node.lyric === 'string' ? node.lyric : node.lyric == null ? '' : String(node.lyric),
    phoneme: typeof node.phoneme === 'string' && node.phoneme !== '' ? node.phoneme : null,
    pitchOffset: num(vpir.pitchOffset, 0),
    detune: num(vpir.detune, 0),
    velocity: clamp(num(vpir.velocity, 64), 0, 127),
    attributes,
  })
  // 时值被裁剪过（tickOff <= tickOn）时记住原始值，写回时复用
  if (!Number.isFinite(duration) || duration < 1) {
    warnings.push(`第 ${index + 1} 个音符时值非法，已按 1 tick 处理`)
    note.attributes.ufdataTickOff = Number.isFinite(rawOff) ? rawOff : tick + 1
  }
  if (Object.keys(vpir).length) {
    const unknown = { ...vpir }
    delete unknown.pitchOffset
    delete unknown.detune
    delete unknown.velocity
    delete unknown.attributes
    if (Object.keys(unknown).length) note.attributes.ufdataVpir = unknown
  }
  return note
}

function readTrack(node, index, warnings) {
  const trackExtras = {}
  if (!isPlainObject(node)) {
    warnings.push(`第 ${index + 1} 个轨道不是对象，已跳过`)
    return null
  }
  const notes = []
  const rawNotes = Array.isArray(node.notes) ? node.notes : []
  rawNotes.forEach((raw, ni) => {
    const note = readNote(raw, ni, warnings)
    if (note) notes.push(note)
  })
  // IR 要求按 tick 升序
  const ordered = notes
    .map((note, i) => ({ note, i }))
    .sort((a, b) => a.note.tick - b.note.tick || a.i - b.i)
    .map((entry) => entry.note)

  const vpir = isPlainObject(node.vpir) ? node.vpir : {}
  const parameters = {}
  if (isPlainObject(vpir.parameters)) {
    for (const [name, curve] of Object.entries(vpir.parameters)) {
      if (!isCanonicalParam(name) || !isPlainObject(curve)) continue
      parameters[name] = createCurve({
        ticks: Array.isArray(curve.ticks) ? curve.ticks : [],
        values: Array.isArray(curve.values) ? curve.values : [],
      })
    }
  }
  const extras = isPlainObject(vpir.extras) ? { ...vpir.extras } : {}
  const unknownVpir = { ...vpir }
  for (const key of ['singer', 'color', 'muted', 'solo', 'volume', 'pan', 'language', 'parameters', 'extras']) {
    delete unknownVpir[key]
  }
  if (Object.keys(unknownVpir).length) extras.ufdataVpir = unknownVpir

  const track = createTrack({
    id: `trk${index + 1}`,
    name: typeof node.name === 'string' && node.name !== '' ? node.name : `Track ${index + 1}`,
    singer: typeof vpir.singer === 'string' ? vpir.singer : '',
    color: typeof vpir.color === 'string' ? vpir.color : '',
    muted: vpir.muted === true,
    solo: vpir.solo === true,
    volume: clamp(num(vpir.volume, 1), 0, 1),
    pan: clamp(num(vpir.pan, 0), -1, 1),
    language: typeof vpir.language === 'string' ? vpir.language : '',
    notes: ordered,
    parameters,
    extras,
  })
  track.pitch = readPitch(node.pitch, ordered, trackExtras, warnings)
  track.extras = { ...track.extras, ...trackExtras }
  return track
}

/**
 * 读取 UtaFormatix Data。
 * @param {Buffer|string} buffer
 * @param {{name?:string}} [opts]
 * @returns {object} IR Project
 */
export function read(buffer, opts = {}) {
  const text = toText(buffer).replace(/^\uFEFF/, '')
  let root
  try {
    root = JSON.parse(text)
  } catch (err) {
    throw new Error(`不是合法的 JSON，无法作为 UtaFormatix 数据读取：${err.message}`)
  }
  if (!isPlainObject(root)) {
    throw new Error('UtaFormatix 数据的顶层必须是 JSON 对象（应包含 formatVersion 与 project）')
  }
  const node = isPlainObject(root.project) ? root.project : root
  const hasShape =
    Array.isArray(node.tracks) || Array.isArray(node.tempos) || Array.isArray(node.timeSignatures) || Array.isArray(node.notes)
  if (!hasShape) {
    throw new Error('无法识别为 UtaFormatix 数据：缺少 project.tracks / tempos / timeSignatures 字段')
  }

  const warnings = []
  const formatVersion = intOr(root.formatVersion ?? root.version ?? root.format_version, 1)
  if (formatVersion > 1) {
    warnings.push(`文件 formatVersion 为 ${formatVersion}，高于本模块支持的 1，已按 v1 尽力解析`)
  }

  // —— 速度 ——
  const rawTempos = Array.isArray(node.tempos) ? node.tempos : []
  const tempoMap = new Map()
  rawTempos.forEach((t, i) => {
    if (!isPlainObject(t)) return
    const tick = intOr(t.tickPosition ?? t.tick, NaN)
    const bpm = num(t.bpm, NaN)
    if (!Number.isFinite(tick) || !Number.isFinite(bpm) || bpm <= 0) {
      warnings.push(`第 ${i + 1} 个速度标记非法，已跳过`)
      return
    }
    tempoMap.set(Math.max(0, tick), bpm)
  })
  const tempos = [...tempoMap.entries()]
    .map(([tick, bpm]) => ({ tick, bpm }))
    .sort((a, b) => a.tick - b.tick)

  // —— 拍号 ——
  const rawSigs = Array.isArray(node.timeSignatures) ? node.timeSignatures : []
  const vpirProject = isPlainObject(node.vpir) ? node.vpir : {}
  const extSigs = Array.isArray(vpirProject.timeSignatures)
    ? vpirProject.timeSignatures.filter(isPlainObject)
    : []
  const timeSignatures = resolveTimeSignatures(rawSigs.filter(isPlainObject), extSigs)

  // —— measurePrefix：小节数 -> tick 数 ——
  const prefixCount = Math.max(0, intOr(node.measurePrefix ?? vpirProject.measurePrefix, 0))
  const firstSig = timeSignatures[0] ?? { numerator: 4, denominator: 4 }
  const derivedPrefix = prefixCount * ticksInMeasure(firstSig.numerator, firstSig.denominator)
  const measurePrefix = intOr(vpirProject.measurePrefixTicks, derivedPrefix)

  // —— 轨道 ——
  const rawTracks = Array.isArray(node.tracks) ? node.tracks : []
  const tracks = []
  rawTracks.forEach((raw, i) => {
    const track = readTrack(raw, i, warnings)
    if (track) tracks.push(track)
  })

  const extras = {}
  if (typeof vpirProject.comment === 'string' && vpirProject.comment !== '') extras.comment = vpirProject.comment
  if (isPlainObject(vpirProject.extras)) Object.assign(extras, vpirProject.extras)
  const unknownProjectVpir = { ...vpirProject }
  for (const key of ['comment', 'extras', 'measurePrefixTicks', 'measurePrefix', 'timeSignatures']) {
    delete unknownProjectVpir[key]
  }
  if (Object.keys(unknownProjectVpir).length) extras.ufdataVpir = unknownProjectVpir

  const project = createProject({
    sourceFormat: 'ufdata',
    name:
      typeof node.name === 'string' && node.name !== ''
        ? node.name
        : typeof node.title === 'string' && node.title !== ''
          ? node.title
          : opts.name
            ? String(opts.name).replace(/\.[^.\\/]+$/, '')
            : '未命名工程',
    comment: extras.comment ?? '',
    tempos: tempos.length ? tempos : [{ tick: 0, bpm: 120 }],
    timeSignatures: timeSignatures.length ? timeSignatures : [{ tick: 0, numerator: 4, denominator: 4 }],
    measurePrefix,
    // tracks 字段存在时如实映射（可以为空数组）；字段缺失才补一条占位轨道
    tracks: Array.isArray(node.tracks) ? tracks : [createTrack()],
    extras,
  })
  project.extras.ufdata = {
    ...(isPlainObject(project.extras.ufdata) ? project.extras.ufdata : {}),
    formatVersion,
    measurePrefixCount: prefixCount,
    warnings,
  }
  return project
}

/* ------------------------------------------------------------------ 写出 */

function writeNote(note) {
  const tickOn = Math.max(0, intOr(note.tick, 0))
  const duration = Math.max(1, intOr(note.duration, 1))
  const out = {
    tickOn,
    tickOff: tickOn + duration,
    key: clamp(intOr(note.key, 60), 0, 127),
    lyric: typeof note.lyric === 'string' ? note.lyric : '',
  }
  if (note.phoneme) out.phoneme = note.phoneme
  const attributes = isPlainObject(note.attributes) ? note.attributes : {}
  if (Number.isFinite(attributes.ufdataTickOff)) out.tickOff = Math.round(attributes.ufdataTickOff)
  const vpir = {}
  if (num(note.pitchOffset, 0) !== 0) vpir.pitchOffset = note.pitchOffset
  if (num(note.detune, 0) !== 0) vpir.detune = note.detune
  if (num(note.velocity, 64) !== 64) vpir.velocity = note.velocity
  const extraAttributes = { ...attributes }
  delete extraAttributes.ufdataTickOff
  if (Object.keys(extraAttributes).length) vpir.attributes = extraAttributes
  if (isPlainObject(attributes.ufdataVpir)) Object.assign(vpir, attributes.ufdataVpir, vpir)
  if (Object.keys(vpir).length) out.vpir = vpir
  return out
}

function writePitch(track) {
  const notes = track.notes ?? []
  const curve = track.pitch ?? createCurve()
  const ticks = Array.isArray(curve.ticks) ? curve.ticks : []
  const values = Array.isArray(curve.values) ? curve.values : []
  const stored = track.extras?.ufdata
  const hadRelative = stored && stored.pitchIsAbsolute === false
  const n = Math.min(ticks.length, values.length)
  const points = []
  for (let i = 0; i < n; i += 1) {
    const tick = Number(ticks[i])
    const value = Number(values[i])
    if (!Number.isFinite(tick) || !Number.isFinite(value)) continue
    points.push([Math.round(tick), value])
  }
  if (!points.length) return EMPTY_PITCH()
  if (hadRelative && notes.length) {
    const rel = absoluteToRelative(points, notes)
    return { ticks: rel.map((p) => p[0]), values: rel.map((p) => p[1]), isAbsolute: false }
  }
  return { ticks: points.map((p) => p[0]), values: points.map((p) => p[1]), isAbsolute: true }
}

function writeTrack(track, extended) {
  const out = {
    name: typeof track.name === 'string' ? track.name : '',
    notes: (track.notes ?? []).map(writeNote),
    pitch: writePitch(track),
  }
  if (!extended) return out
  const vpir = {}
  if (track.singer) vpir.singer = track.singer
  if (track.color) vpir.color = track.color
  if (track.muted) vpir.muted = true
  if (track.solo) vpir.solo = true
  if (num(track.volume, 1) !== 1) vpir.volume = track.volume
  if (num(track.pan, 0) !== 0) vpir.pan = track.pan
  if (track.language) vpir.language = track.language
  const params = {}
  for (const [name, curve] of Object.entries(track.parameters ?? {})) {
    if (!isCanonicalParam(name) || !curve) continue
    const norm = normalizeCurve(curve)
    if (!norm.ticks.length) continue
    params[name] = norm
  }
  if (Object.keys(params).length) vpir.parameters = params
  const extras = { ...(track.extras ?? {}) }
  delete extras.ufdata
  if (isPlainObject(extras.ufdataVpir)) {
    Object.assign(vpir, extras.ufdataVpir, vpir)
    delete extras.ufdataVpir
  }
  if (Object.keys(extras).length) vpir.extras = extras
  if (Object.keys(vpir).length) out.vpir = vpir
  return out
}

/**
 * 写出 UtaFormatix Data。
 * @param {object} project IR Project
 * @param {{name?:string, pretty?:boolean, extended?:boolean}} [opts]
 *        extended 默认 true：把格式装不下的 IR 数据写进 vpir 扩展字段
 * @returns {Buffer}
 */
export function write(project, opts = {}) {
  if (!isPlainObject(project)) throw new Error('write() 需要一个工程对象')
  const extended = opts.extended !== false
  const pretty = opts.pretty !== false

  const tempos = (project.tempos ?? [])
    .map((t) => ({ tickPosition: Math.max(0, intOr(t.tick, 0)), bpm: num(t.bpm, 120) }))
    .filter((t) => t.bpm > 0)
    .sort((a, b) => a.tickPosition - b.tickPosition)
  if (!tempos.length || tempos[0].tickPosition !== 0) tempos.unshift({ tickPosition: 0, bpm: tempos[0]?.bpm ?? 120 })

  const sourceSigs = (project.timeSignatures ?? [])
    .map((s) => ({
      tick: Math.max(0, intOr(s.tick, 0)),
      numerator: Math.max(1, intOr(s.numerator, 4)),
      denominator: Math.max(1, intOr(s.denominator, 4)),
    }))
    .sort((a, b) => a.tick - b.tick)
  if (!sourceSigs.length || sourceSigs[0].tick !== 0) {
    sourceSigs.unshift({ tick: 0, numerator: 4, denominator: 4 })
  }

  // tick -> 小节序号（0 基，与 UtaFormatix 的 measurePosition 同义）
  const sigEvents = ticksToMeasurePositions(sourceSigs)
  const timeSignatures = []
  const sigOffsets = []
  const seen = new Set()
  for (const entry of sigEvents) {
    const { offset, ...plain } = entry
    const duplicate = seen.has(entry.measurePosition)
    seen.add(entry.measurePosition)
    // UtaFormatix 只能表示「整小节处」的拍号；小节内的偏移与同小节的重复项写进扩展字段
    if (offset !== 0 || duplicate) sigOffsets.push({ ...plain, offset })
    else timeSignatures.push(plain)
  }
  timeSignatures.sort((a, b) => a.measurePosition - b.measurePosition)
  if (!timeSignatures.length || timeSignatures[0].measurePosition !== 0) {
    timeSignatures.unshift({
      measurePosition: 0,
      numerator: timeSignatures[0]?.numerator ?? 4,
      denominator: timeSignatures[0]?.denominator ?? 4,
    })
  }

  // measurePrefix：tick -> 前缀小节数
  const prefixTicks = Math.max(0, intOr(project.measurePrefix, 0))
  const first = timeSignatures[0]
  const measureTicks = ticksInMeasure(first?.numerator ?? 4, first?.denominator ?? 4)
  const prefixCount = Math.round(prefixTicks / measureTicks)
  const prefixRemainder = prefixTicks - prefixCount * measureTicks

  const vpirProject = {}
  if (extended) {
    if (typeof project.comment === 'string' && project.comment !== '') vpirProject.comment = project.comment
    const extras = { ...(project.extras ?? {}) }
    delete extras.ufdata
    if (isPlainObject(extras.ufdataVpir)) {
      Object.assign(vpirProject, extras.ufdataVpir, vpirProject)
      delete extras.ufdataVpir
    }
    if (Object.keys(extras).length) vpirProject.extras = extras
    if (sigOffsets.length) vpirProject.timeSignatures = sigOffsets
    if (prefixRemainder !== 0) vpirProject.measurePrefixTicks = prefixTicks
  }

  const inner = {
    name: typeof project.name === 'string' ? project.name : '未命名工程',
    tracks: (project.tracks ?? []).map((track) => writeTrack(track, extended)),
    timeSignatures,
    tempos,
    measurePrefix: Math.max(0, prefixCount),
  }
  if (Object.keys(vpirProject).length) inner.vpir = vpirProject

  const doc = { formatVersion: 1, project: inner }
  const text = pretty ? JSON.stringify(doc, null, 2) : JSON.stringify(doc)
  return Buffer.from(text, 'utf8')
}

export default { meta, fidelity, read, write }
