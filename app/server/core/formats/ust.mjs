/**
 * UTAU 工程（.ust，INI 风格文本）读写模块
 *
 * 结构（依据真实语料：本机 180 个真实 .ust、共 15275 个音符，以及 OpenUtau
 * OpenUtau.Core/Classic/Ust.cs + UstNote.cs、UtaFormatix core/io/Ust.kt）：
 *
 *   [#VERSION]      UST Version1.2
 *   [#SETTING]      Tempo= / Tracks= / ProjectName= / VoiceDir= / OutFile= /
 *                   CacheDir= / Tool1= / Tool2= / Mode2= / Flags= / Charset=
 *   [#0000]         Length= / Lyric= / NoteNum= / PreUtterance= / VoiceOverlap= /
 *                   Intensity= / Modulation=(亦作 Moduration=) / Velocity= / Flags= /
 *                   StartPoint= / Envelope= / VBR= / Tempo= /
 *                   Mode2 音高：PBS= / PBW= / PBY= / PBM=
 *                   Mode1 音高：PitchBend=(亦作 Pitches= / Piches=) / PBStart= / PBType=
 *   [#TRACKEND]
 *
 *  - 音符位置是隐含的：按块顺序累加 Length；补空档要用 Lyric=R 的休止符。
 *  - [#SETTING] Tempo 的小数点可能是逗号（本地化，如 `Tempo=159,00`），需容错；
 *    音符块里的 Tempo= 表示该音符起点处变速。
 *  - 编码：默认 Shift-JIS；文件可用 `Charset=UTF-8` 声明为 UTF-8。
 *
 * 音高单位（已交叉验证，别弄错）：
 *  - Mode2：PBS.x / PBW 是**毫秒**（相对音符起点，可为负），PBS.y / PBY 是 **10 音分**
 *    （UtaFormatix：`start: Double // milliSec`、`startShift: Double // 10 cents`；
 *     真实语料 PBS.y 最大 ±120 ⇒ ±1200 音分 = ±1 个八度，正是 UTAU 的音高弯曲上限）。
 *  - Mode1：PitchBend/Pitches/Piches 是**音分**数组，从音符起点起每 **5 tick** 采样一个点；
 *    PBStart 为起始位置（负值表示从 PreUtterance 开始），PBType 固定 5。
 *
 * IR 映射：
 *  - Tempo / 音符 / 歌词 / 音高曲线（半音） / 颤音 / 力度（Intensity→dynamics）
 *  - 无法映射的（Envelope、Flags、Modulation、PreUtterance…）存进 extras，写回时优先复用。
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  TPQ,
  createProject,
  createTrack,
  createNote,
  createCurve,
  curveValueAt,
  tickToSec,
  secToTick,
  clamp,
  uid,
} from '../ir.mjs'

export const meta = {
  id: 'ust',
  name: 'UTAU 工程',
  vendor: 'UTAU',
  exts: ['.ust'],
  kind: 'text',
  canRead: true,
  canWrite: true,
  writeExt: '.ust',
  encoding: 'utf8',
}

/** 自测框架跳过项：UST 是单轨格式，多轨工程只写出第 1 轨（见 fidelity.drops） */
export const __skipChecks = ['trackCount']

export const fidelity = {
  preserves: [
    'notes',
    'tempo',
    'lyrics',
    'timeSignature',
    'pitchCurve',
    'vibrato',
    'velocity',
    'params.dynamics',
  ],
  drops: [
    '第 2 轨及之后的音符（UST 是单轨格式，只导出第 1 个有音符的轨道）',
    '多轨本身（轨道数、轨道音量 / 声像 / 静音）',
    '歌手（UTAU 的声库是编辑器里的全局设置，不写在 .ust 内；读入时只能从 VoiceDir 提示还原）',
    '音素（phonemes）、detune（UTAU 没有对应的逐音素数据）',
    '参数曲线：breathiness / gender / tension / voicing 等 UST 没有',
    '包络 Envelope、Flags、Modulation、PreUtterance 等原生字段（同格式往返时保留在 extras，转其它格式会丢）',
    '拍号仅以扩展设置行 TimeSignatures= 保留（UTAU 无小节概念，会忽略该行；OpenUtau 亦忽略）',
  ],
  notes:
    'UTAU 原生工程。音符位置由 Length 顺序累加、空档写成 R 休止符；' +
    '音高以 Mode2（PBS/PBW/PBY/PBM，毫秒 + 10 音分）写出，来源若是旧版 Mode1 文件则原样保留 PitchBend/PBStart/PBType。' +
    'Intensity（强度）映射为 IR 的 dynamics 曲线，Velocity 映射为音符 velocity，VoiceDir 记录歌手名。' +
    '默认写 UTF-8 并加 Charset=UTF-8 声明（OpenUtau 与现代编辑器可读）；' +
    '需要 UTAU 本体可读时用 write(project, { encoding: "shift-jis" }) 转码为 CP932。',
}

const MODE1_SAMPLING_TICK = 5
const PBM_BY_SHAPE = { io: '', o: 'r', l: 's', i: 'j' }
const SHAPE_BY_PBM = { r: 'o', s: 'l', j: 'i', '': 'io' }

/* ------------------------------------------------------------------ 读入 */

export function read(buffer, opts = {}) {
  const text = decodeText(buffer)
  const blocks = splitBlocks(text)
  if (!blocks.length) throw new Error('ust 解析失败：文件为空或没有 [#...] 段落')

  const warnings = []
  const settings = new Map()
  const noteBlocks = []

  for (const block of blocks) {
    const name = block.header.toUpperCase()
    if (name === '[#SETTING]') {
      for (const [k, v] of block.fields) if (!settings.has(k)) settings.set(k, v)
    } else if (name === '[#VERSION]' || name === '[#TRACKEND]') {
      // 忽略
    } else if (/^\[#[0-9]+\]$/.test(name) || name === '[#PREV]' || name === '[#NEXT]') {
      if (name !== '[#PREV]' && name !== '[#NEXT]') noteBlocks.push(block)
    } else {
      warnings.push(`未知段落 ${block.header}，已跳过`)
    }
  }
  if (!noteBlocks.length && !settings.size) {
    throw new Error('ust 解析失败：既没有 [#SETTING] 也没有音符段落，可能不是 UTAU 工程')
  }

  const track = createTrack({
    id: uid('trk'),
    name: str(settings.get('ProjectName'), opts.name ? baseName(opts.name) : 'UTAU Track'),
    singer: singerFromVoiceDir(settings.get('VoiceDir')),
    notes: [],
    extras: {
      ust: {
        settings: Object.fromEntries(settings),
        voiceDir: str(settings.get('VoiceDir'), ''),
        outFile: str(settings.get('OutFile'), ''),
        cacheDir: str(settings.get('CacheDir'), ''),
        tool1: str(settings.get('Tool1'), ''),
        tool2: str(settings.get('Tool2'), ''),
        mode2: /^true$/i.test(str(settings.get('Mode2'), '')),
        flags: str(settings.get('Flags'), ''),
        warnings,
      },
    },
  })

  const tempos = []
  const noteTempos = []
  let lastNotePos = 0
  let lastNoteEnd = 0
  let restCount = 0

  noteBlocks.forEach((block, index) => {
    const raw = parseNoteBlock(block)
    if (!raw) {
      warnings.push(`段落 ${block.header} 缺 Length/NoteNum，已跳过`)
      return
    }
    const position = raw.delta !== null && raw.duration !== null && raw.length !== null
      ? lastNotePos + raw.delta
      : lastNoteEnd
    const duration = raw.delta !== null && raw.duration !== null && raw.length !== null ? raw.duration : raw.length
    if (!Number.isFinite(duration) || duration <= 0) {
      warnings.push(`段落 ${block.header} Length=${duration} 非法，已跳过`)
      return
    }
    lastNotePos = position
    lastNoteEnd = position + duration
    if (raw.tempo !== null) noteTempos.push({ tick: position, bpm: raw.tempo })

    const lyric = String(raw.lyric ?? '').replace(/^\?/, '')
    if (lyric.toLowerCase() === 'r') {
      restCount += 1
      return // 休止符不进 IR，但位置照常前进
    }

    const key = Math.round(raw.noteNum)
    if (key < 0 || key > 127) {
      warnings.push(`段落 ${block.header} NoteNum=${raw.noteNum} 超出 0..127，已跳过`)
      return
    }
    const note = createNote({
      tick: position,
      duration,
      key,
      lyric: lyric.startsWith('!') ? `[${lyric.slice(1)}]` : lyric,
      attributes: {
        ust: {
          block: index,
          rawLyric: String(raw.lyric ?? ''),
          velocity: raw.velocity,
          intensity: raw.intensity,
          modulation: raw.modulation,
          preUtterance: raw.preUtterance,
          voiceOverlap: raw.voiceOverlap,
          startPoint: raw.startPoint,
          envelope: raw.envelope,
          envelopeRaw: raw.envelopeRaw,
          flags: raw.flags,
          parsedFlags: parseFlags(raw.flags),
          vbr: raw.vbr,
          mode1: raw.mode1,
          mode2: raw.mode2,
          unknown: raw.unknown,
        },
      },
    })
    if (raw.velocity !== null) note.velocity = clamp(Math.round((raw.velocity / 200) * 127), 0, 127)
    applyVibrato(note)
    track.notes.push(note)

    // Intensity(0..200) -> IR dynamics(0..1)：逐音符阶梯曲线，便于跨格式转换
    if (raw.intensity !== null) {
      const value = clamp(raw.intensity / 200, 0, 1)
      const curve = track.parameters.dynamics ?? createCurve()
      setCurvePoint(curve, position, value)
      setCurvePoint(curve, position + duration, value)
      track.parameters.dynamics = curve
    }
  })

  // 速度表：设置里的 Tempo 为 0 号；音符块里的 Tempo 依次追加
  const settingTempo = parseNumber(settings.get('Tempo'))
  const headerBpm = Number.isFinite(settingTempo) && settingTempo > 0 && settingTempo <= 1000 ? settingTempo : null
  if (headerBpm !== null) tempos.push({ tick: 0, bpm: headerBpm })
  for (const t of noteTempos) {
    if (!tempos.length && t.tick === 0) tempos.push({ tick: 0, bpm: t.bpm })
    else tempos.push({ tick: Math.max(0, t.tick), bpm: t.bpm })
  }
  if (!tempos.length) tempos.push({ tick: 0, bpm: 120 })
  if (tempos[0].tick !== 0) tempos.unshift({ tick: 0, bpm: tempos[0].bpm })
  dedupeTempos(tempos)

  // 音高曲线：Mode2（毫秒/10 音分）与 Mode1（音分/5tick）统一换算为绝对半音
  const pitchPoints = []
  for (const note of track.notes) {
    collectPitchPoints(note, tempos, pitchPoints, warnings)
  }
  track.pitch = normalizePoints(pitchPoints)
  track.notes.sort((a, b) => a.tick - b.tick)

  const timeSignatures = readTimeSignatures(settings, warnings)

  return createProject({
    sourceFormat: 'ust',
    name: str(settings.get('ProjectName'), opts.name ? baseName(opts.name) : 'UTAU 工程'),
    comment: '',
    tempos,
    timeSignatures,
    measurePrefix: readMeasurePrefix(settings),
    tracks: [track],
    extras: {
      ust: {
        version: readVersion(text),
        settings: Object.fromEntries(settings),
        mode2: track.extras.ust.mode2,
        flags: track.extras.ust.flags,
        warnings,
        restCount,
      },
    },
  })
}

/** 拆成 [#XXX] 段落；容忍缺 [#VERSION]、行尾空白、`key=value` 含 `=` 的值 */
function splitBlocks(text) {
  const blocks = []
  let current = null
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.replace(/\uFEFF/g, '')
    const m = line.match(/^\s*(\[#[^\]]*\])\s*$/)
    if (m) {
      current = { header: m[1], fields: [], lines: [] }
      blocks.push(current)
      continue
    }
    if (!current) continue
    if (!line.trim()) continue
    const eq = line.indexOf('=')
    if (eq < 0) {
      current.lines.push(line)
      continue
    }
    const key = line.slice(0, eq).trim()
    const value = line.slice(eq + 1)
    current.fields.push([key, value])
    current.lines.push(line)
  }
  return blocks
}

function parseNoteBlock(block) {
  const get = (name) => {
    const hit = block.fields.find(([k]) => k.toLowerCase() === name.toLowerCase())
    return hit ? hit[1] : undefined
  }
  const length = intOrNull(get('Length'))
  const noteNum = intOrNull(get('NoteNum'))
  if (length === null || noteNum === null) return null

  const consumed = new Set(['length', 'lyric', 'notenum', 'preutterance', 'voiceoverlap', 'intensity', 'modulation', 'moduration', 'velocity', 'flags', 'startpoint', 'envelope', 'vbr', 'tempo', 'delta', 'duration', 'pbs', 'pbw', 'pby', 'pbm', 'pitchbend', 'pitches', 'piches', 'pbstart', 'pbtype', '@filename', '@alias'])
  const unknown = {}
  for (const [k, v] of block.fields) {
    if (!consumed.has(k.toLowerCase()) && !(k in unknown)) unknown[k] = v
  }

  return {
    length,
    noteNum,
    delta: intOrNull(get('Delta')),
    duration: intOrNull(get('Duration')),
    lyric: get('Lyric'),
    tempo: parseNumber(get('Tempo')) ?? null,
    velocity: intOrNull(get('Velocity')),
    intensity: intOrNull(get('Intensity')),
    modulation: intOrNull(get('Modulation') ?? get('Moduration')),
    preUtterance: get('PreUtterance') === undefined || get('PreUtterance').trim() === '' ? null : (parseNumber(get('PreUtterance')) ?? null),
    voiceOverlap: parseNumber(get('VoiceOverlap')) ?? null,
    startPoint: parseNumber(get('StartPoint')) ?? null,
    envelopeRaw: get('Envelope') ?? null,
    envelope: parseEnvelope(get('Envelope')),
    flags: get('Flags') ?? null,
    vbr: parseNumberList(get('VBR')),
    mode1: parseMode1(get('PitchBend') ?? get('Pitches') ?? get('Piches'), get('PBStart'), get('PBType')),
    mode2: parseMode2(get('PBS'), get('PBW'), get('PBY'), get('PBM')),
    unknown,
  }
}

/** PBS/PBW/PBY/PBM（x 毫秒、y 10 音分） */
function parseMode2(pbs, pbw, pby, pbm) {
  if (pbs === undefined && pbw === undefined && pby === undefined) return null
  const start = String(pbs ?? '').split(/[;,]/)
  const points = []
  let x = start.length && start[0].trim() !== '' ? (parseNumber(start[0]) ?? 0) : 0
  let y = start.length > 1 && start[1].trim() !== '' ? (parseNumber(start[1]) ?? 0) : 0
  points.push({ x, y })
  const widths = parseNumberList(pbw) ?? []
  const shifts = parseNumberList(pby) ?? []
  const shapes = pbm === undefined ? [] : String(pbm).split(',')
  for (let i = 0; i < widths.length; i += 1) {
    x += widths[i]
    points.push({ x, y: shifts[i] ?? 0 })
  }
  if (points.length < 2 && !widths.length) return null
  return {
    pbs,
    pbw,
    pby,
    pbm,
    points: points.map((p, i) => ({ x: p.x, y: p.y, shape: SHAPE_BY_PBM[String(shapes[i] ?? '').trim()] ?? 'io' })),
  }
}

/** PitchBend=…（音分，自音符起点每 5 tick 一点） */
function parseMode1(pitchBend, pbStart, pbType) {
  const values = parseNumberList(pitchBend)
  if (!values || !values.length) return null
  return {
    pitchBend,
    pbStart: parseNumber(pbStart) ?? 0,
    pbType: pbType === undefined ? '5' : String(pbType).trim(),
    values,
  }
}

function parseEnvelope(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null
  const tokens = String(raw).split(',').map((t) => t.trim())
  const nums = []
  const percents = []
  for (const t of tokens) {
    if (t === '%') {
      percents.push(nums.length)
      continue
    }
    const n = parseNumber(t)
    nums.push(n === null || n < 0 ? 0 : n)
  }
  if (nums.length < 7) return { raw, values: nums }
  const at = (i) => nums[i] ?? 0
  return {
    raw,
    p1: at(0), p2: at(1), p3: at(2),
    v1: at(3), v2: at(4), v3: at(5), v4: at(6),
    p4: at(7), p5: at(8), v5: at(9),
    hasRelease: nums.length >= 10 || percents.length > 0,
    values: nums,
  }
}

function parseFlags(raw) {
  if (!raw) return {}
  const out = {}
  const re = /([A-Za-z])(-?\d+(?:\.\d+)?)?/g
  let m
  while ((m = re.exec(String(raw))) !== null) {
    out[m[1]] = m[2] === undefined ? true : Number(m[2])
  }
  return out
}

function collectPitchPoints(note, tempos, out, warnings) {
  const a = note.attributes.ust
  const startMs = tickToSec(note.tick, tempos) * 1000
  if (a.mode2?.points?.length) {
    for (const p of a.mode2.points) {
      out.push({
        tick: Math.round(secToTick((startMs + p.x) / 1000, tempos)),
        value: note.key + p.y / 10, // 10 音分 -> 半音
      })
    }
    return
  }
  if (a.mode1?.values?.length) {
    a.mode1.values.forEach((cents, i) => {
      out.push({
        tick: note.tick + i * MODE1_SAMPLING_TICK,
        value: note.key + cents / 100, // Mode1 是音分
      })
    })
    return
  }
  out.push({ tick: note.tick, value: note.key }, { tick: note.tick + note.duration, value: note.key })
}

function normalizePoints(points) {
  const map = new Map()
  for (const p of points) {
    if (!Number.isFinite(p.tick) || !Number.isFinite(p.value) || p.tick < 0) continue
    map.set(Math.round(p.tick), p.value)
  }
  const ticks = [...map.keys()].sort((a, b) => a - b)
  return { ticks, values: ticks.map((t) => map.get(t)) }
}

function setCurvePoint(curve, tick, value) {
  const t = Math.round(tick)
  const idx = curve.ticks.indexOf(t)
  if (idx >= 0) {
    curve.values[idx] = value
    return
  }
  curve.ticks.push(t)
  curve.values.push(value)
  const order = curve.ticks.map((v, i) => i).sort((a, b) => curve.ticks[a] - curve.ticks[b])
  curve.ticks = order.map((i) => curve.ticks[i])
  curve.values = order.map((i) => curve.values[i])
}

function applyVibrato(note) {
  const vbr = note.attributes.ust.vbr
  if (!vbr || vbr.length < 2) return
  const [lengthPct, periodMs, depthCents, fadeInPct, fadeOutPct, , shiftPct] = vbr
  if (!(lengthPct > 0)) return
  note.attributes.vibrato = {
    length: Math.round((note.duration * lengthPct) / 100),
    depth: Number.isFinite(depthCents) ? depthCents : 0,
    rate: periodMs > 0 ? Math.round((1000 / periodMs) * 100) / 100 : 0,
    delay: Math.round((note.duration * (fadeInPct ?? 0)) / 100),
    fadeOut: Math.round((note.duration * (fadeOutPct ?? 0)) / 100),
    shift: Number.isFinite(shiftPct) ? shiftPct : 0,
  }
}

function readVersion(text) {
  const m = text.match(/\[#VERSION\][^\r\n]*(?:\r?\n)?\s*([^\r\n]*)/i)
  return m ? m[1].trim() : ''
}

function readTimeSignatures(settings, warnings) {
  const raw = settings.get('TimeSignatures')
  const out = []
  if (raw) {
    for (const item of String(raw).split(',')) {
      const m = item.trim().match(/^(-?\d+)\s*[:@]\s*(\d+)\s*\/\s*(\d+)$/)
      if (!m) continue
      const numerator = Number(m[2])
      const denominator = Number(m[3])
      if (!(numerator > 0) || ![1, 2, 4, 8, 16, 32].includes(denominator)) continue
      out.push({ tick: Math.max(0, Number(m[1])), numerator, denominator })
    }
    if (!out.length) warnings.push('扩展设置 TimeSignatures 格式无法识别，已忽略')
  }
  if (!out.length) out.push({ tick: 0, numerator: 4, denominator: 4 })
  out.sort((a, b) => a.tick - b.tick)
  if (out[0].tick !== 0) out.unshift({ tick: 0, numerator: 4, denominator: 4 })
  return out
}

function readMeasurePrefix(settings) {
  const n = parseNumber(settings.get('MeasurePrefix'))
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0
}

function dedupeTempos(tempos) {
  const seen = new Map()
  for (const t of tempos) seen.set(Math.round(t.tick), t.bpm)
  const ticks = [...seen.keys()].sort((a, b) => a - b)
  tempos.length = 0
  for (const tick of ticks) tempos.push({ tick, bpm: seen.get(tick) })
}

/* ------------------------------------------------------------------ 写出 */

/**
 * @param {object} project
 * @param {{encoding?: 'utf8'|'shift-jis'}} opts
 *   encoding='shift-jis' 时通过 PowerShell(GetEncoding(932)) 转码；
 *   失败会自动回退 UTF-8，并在返回 Buffer 的 .notes / .encoding 上说明。
 */
export function write(project, opts = {}) {
  if (!project || !Array.isArray(project.tracks) || !project.tracks.length) {
    throw new Error('ust 写出失败：project.tracks 为空')
  }
  const notes = []
  const track = project.tracks[0]
  const src = project.extras?.ust ?? {}
  const trackExtras = track.extras?.ust ?? {}
  const tempos = normalizeTempos(project.tempos)
  const timeSignatures = (project.timeSignatures ?? []).filter((t) => Number.isFinite(t?.tick))
  const isMode2 = trackExtras.mode2 !== false && !allNotesMode1(track)
  const lines = []

  lines.push('[#VERSION]')
  lines.push('UST Version1.2')
  lines.push('[#SETTING]')
  lines.push(`Tempo=${formatNumber(tempos[0].bpm)}`)
  lines.push('Tracks=1')
  lines.push(`ProjectName=${str(project.name, 'New Project')}`)
  if (trackExtras.voiceDir || src.voiceDir) lines.push(`VoiceDir=${trackExtras.voiceDir || src.voiceDir}`)
  if (trackExtras.outFile || src.outFile) lines.push(`OutFile=${trackExtras.outFile || src.outFile}`)
  if (trackExtras.cacheDir || src.cacheDir) lines.push(`CacheDir=${trackExtras.cacheDir || src.cacheDir}`)
  if (trackExtras.tool1 || src.tool1) lines.push(`Tool1=${trackExtras.tool1 || src.tool1}`)
  if (trackExtras.tool2 || src.tool2) lines.push(`Tool2=${trackExtras.tool2 || src.tool2}`)
  lines.push(`Mode2=${isMode2 ? 'True' : 'False'}`)
  if (trackExtras.flags || src.flags) lines.push(`Flags=${trackExtras.flags || src.flags}`)
  if (needsTimeSignatureExtension(timeSignatures)) {
    lines.push(`TimeSignatures=${timeSignatures.map((t) => `${Math.round(t.tick)}:${t.numerator}/${t.denominator}`).join(',')}`)
  }
  if (Number.isFinite(project.measurePrefix) && project.measurePrefix > 0) {
    lines.push(`MeasurePrefix=${Math.round(project.measurePrefix)}`)
  }
  // 编码声明：默认写 UTF-8，需让 OpenUtau 的 DetectEncoding 能识别
  const wantSjis = isShiftJis(opts.encoding)
  if (!wantSjis) lines.push('Charset=UTF-8')

  const sequence = buildSequence(track, tempos, isMode2)
  sequence.forEach((entry, i) => {
    lines.push(`[#${String(i).padStart(4, '0')}]`)
    for (const line of entry) lines.push(line)
  })
  lines.push('[#TRACKEND]')

  const text = lines.join('\r\n') + '\r\n'
  const result = encodeText(text, wantSjis)
  if (project.tracks.length > 1) {
    result.notes = (result.notes ?? []).concat(`源工程有 ${project.tracks.length} 轨，UST 为单轨格式，只导出了第 1 轨「${track.name}」`)
  }
  return result
}

function allNotesMode1(track) {
  if (!track.notes.length) return false
  return track.notes.every((n) => n.attributes?.ust?.mode1?.values?.length && !n.attributes?.ust?.mode2)
}

/** 生成音符 / R 休止符块序列（含补空档与变速点插入），返回 string[][] */
function buildSequence(track, tempos, isMode2) {
  const blocks = []
  let position = 0
  const pendingTempos = tempos.filter((t) => t.tick > 0).map((t) => ({ ...t }))

  const takeTempos = (start, end, block) => {
    while (pendingTempos.length && pendingTempos[0].tick >= start && pendingTempos[0].tick < end) {
      block.push(`Tempo=${formatNumber(pendingTempos.shift().bpm)}`)
    }
  }

  for (const note of track.notes) {
    const start = Math.max(0, Math.round(note.tick))
    const duration = Math.max(1, Math.round(note.duration))
    if (start < position) continue // 与前一音符重叠：UST 无法表达，跳过
    if (start > position) {
      // 补空档：必要时拆成多个 R 休止符，保证变速点落在精确 tick
      let restStart = position
      while (restStart < start) {
        const nextTempo = pendingTempos.find((t) => t.tick > restStart && t.tick < start)
        const restEnd = nextTempo ? nextTempo.tick : start
        const block = [`Length=${restEnd - restStart}`, 'Lyric=R', 'NoteNum=60', 'PreUtterance=']
        takeTempos(restStart, restEnd, block)
        blocks.push(block)
        restStart = restEnd
      }
    }
    blocks.push(buildNoteLines(note, track, tempos, isMode2, (block) => takeTempos(start, start + duration, block)))
    position = start + duration
  }

  // 末尾的变速点：补一段到最后一个变速位置的 R 休止符，否则会被丢掉
  const lastTempo = pendingTempos.length ? pendingTempos[pendingTempos.length - 1].tick : 0
  if (lastTempo > position) {
    let restStart = position
    while (restStart < lastTempo) {
      const nextTempo = pendingTempos.find((t) => t.tick > restStart && t.tick <= lastTempo)
      const restEnd = nextTempo ? nextTempo.tick : lastTempo
      const block = [`Length=${restEnd - restStart}`, 'Lyric=R', 'NoteNum=60', 'PreUtterance=']
      takeTempos(restStart, restEnd + 1, block)
      blocks.push(block)
      restStart = restEnd
    }
  }
  return blocks
}

function buildNoteLines(note, track, tempos, isMode2, attachTempo) {
  const a = note.attributes?.ust ?? {}
  const lines = []
  lines.push(`Length=${Math.max(1, Math.round(note.duration))}`)
  lines.push(`Lyric=${a.rawLyric ?? str(note.lyric, '')}`)
  lines.push(`NoteNum=${clamp(Math.round(note.key), 0, 127)}`)
  lines.push(`PreUtterance=${a.preUtterance === null || a.preUtterance === undefined ? '' : formatNumber(a.preUtterance)}`)
  attachTempo(lines)
  const velocity = Number.isFinite(a.velocity) ? a.velocity : Math.round((clamp(note.velocity ?? 64, 0, 127) / 127) * 200)
  if (velocity !== 100 || Number.isFinite(a.velocity)) lines.push(`Velocity=${Math.round(velocity)}`)
  const intensity = Number.isFinite(a.intensity) ? a.intensity : derivedIntensity(note, track)
  if (intensity !== null && (intensity !== 100 || Number.isFinite(a.intensity))) lines.push(`Intensity=${Math.round(intensity)}`)
  if (Number.isFinite(a.modulation)) lines.push(`Modulation=${Math.round(a.modulation)}`)
  if (Number.isFinite(a.voiceOverlap)) lines.push(`VoiceOverlap=${formatNumber(a.voiceOverlap)}`)
  if (Number.isFinite(a.startPoint)) lines.push(`StartPoint=${formatNumber(a.startPoint)}`)
  if (a.flags) lines.push(`Flags=${a.flags}`)
  if (a.envelopeRaw) lines.push(`Envelope=${a.envelopeRaw}`)
  for (const [k, v] of Object.entries(a.unknown ?? {})) lines.push(`${k}=${v}`)

  if (a.vbr?.length) lines.push(`VBR=${a.vbr.map((v) => formatNumber(v)).join(',')}`)
  else {
    const derived = deriveVbr(note)
    if (derived) lines.push(`VBR=${derived}`)
  }

  if (a.mode1?.values?.length && !isMode2) {
    lines.push(`PitchBend=${a.mode1.values.map((v) => String(Math.round(v))).join(',')}`)
    lines.push(`PBStart=${formatNumber(a.mode1.pbStart)}`)
    lines.push(`PBType=${a.mode1.pbType || '5'}`)
  } else {
    for (const line of buildMode2Pitch(note, track, tempos, a)) lines.push(line)
  }
  return lines
}

/** 由 IR 绝对音高曲线生成 PBS/PBW/PBY/PBM（毫秒 + 10 音分） */
function buildMode2Pitch(note, track, tempos, a) {
  const raw = a.mode2
  if (raw && raw.pbs !== undefined && String(raw.pbs).trim() !== '') {
    // 同格式往返：原生字符串原样复用（PBS 可带 `;y` 的第二值，OpenUtau 会读）
    const lines = [`PBS=${String(raw.pbs).trim()}`]
    if (raw.pbw !== undefined) lines.push(`PBW=${String(raw.pbw).trim()}`)
    else if (raw.points?.length > 1) lines.push(`PBW=${raw.points.slice(1).map((p, i) => formatNumber(round(p.x - raw.points[i].x, 4))).join(',')}`)
    if (raw.pby !== undefined) lines.push(`PBY=${String(raw.pby).trim()}`)
    if (raw.pbm !== undefined) lines.push(`PBM=${String(raw.pbm).trim()}`)
    return lines
  }
  if (a.mode2?.points?.length) {
    const pts = a.mode2.points
    const widths = []
    const shifts = []
    const shapes = []
    for (let i = 1; i < pts.length; i += 1) {
      widths.push(round(pts[i].x - pts[i - 1].x, 4))
      shifts.push(round(pts[i].y, 4))
      shapes.push(PBM_BY_SHAPE[pts[i].shape] ?? '')
    }
    // 首个点的 y 放进一个 1ms 的极短段（UTAU 会忽略 PBS 的第二个值，参考 UtaFormatix）
    return [
      `PBS=${formatNumber(round(pts[0].x, 4))}`,
      `PBW=1,${widths.map((v) => formatNumber(v)).join(',')}`,
      `PBY=${[round(pts[0].y, 4), ...shifts].map((v) => formatNumber(v)).join(',')}`,
      `PBM=,${shapes.join(',')}`,
    ]
  }

  const curve = track.pitch
  const startMs = tickToSec(note.tick, tempos) * 1000
  const endTick = note.tick + note.duration
  const endMs = tickToSec(endTick, tempos) * 1000
  const points = []
  if (curve?.ticks?.length) {
    points.push({ x: 0, y: round((curveValueAt(curve, note.tick) - note.key) * 10, 3), shape: 'io' })
    for (const t of curve.ticks) {
      if (t <= note.tick || t >= endTick) continue
      points.push({
        x: round(tickToSec(t, tempos) * 1000 - startMs, 4),
        y: round((curveValueAt(curve, t) - note.key) * 10, 3),
        shape: 'io',
      })
    }
    points.push({
      x: round(endMs - startMs, 4),
      y: round((curveValueAt(curve, endTick) - note.key) * 10, 3),
      shape: 'io',
    })
  }
  if (!points.length) {
    points.push({ x: 0, y: 0, shape: 'io' }, { x: round(endMs - startMs, 4), y: 0, shape: 'io' })
  }
  if (points.length === 1) points.push({ x: round(endMs - startMs, 4), y: points[0].y, shape: 'io' })

  // 首个点的 y 放进一个 1ms 的极短段（UTAU 会忽略 PBS 的第二个值，参考 UtaFormatix）
  const head = points[0]
  const rest = points.slice(1)
  const widths = [1]
  const shifts = [round(head.y, 3)]
  const shapes = ['']
  let prevX = head.x + 1
  for (const p of rest) {
    widths.push(round(p.x - prevX, 4))
    shifts.push(round(p.y, 3))
    shapes.push(PBM_BY_SHAPE[p.shape] ?? '')
    prevX = p.x
  }
  return [
    `PBS=${formatNumber(round(head.x, 4))}`,
    `PBW=${widths.map((v) => formatNumber(Math.max(v, 0))).join(',')}`,
    `PBY=${shifts.map((v) => formatNumber(v)).join(',')}`,
    `PBM=${shapes.join(',')}`,
  ]
}

function derivedIntensity(note, track) {
  const curve = track.parameters?.dynamics
  if (!curve?.ticks?.length) return null
  const v = curveValueAt(curve, note.tick)
  return v === null ? null : clamp(v, 0, 1) * 200
}

function deriveVbr(note) {
  const v = note.attributes?.vibrato
  if (!v || !(v.length > 0) || !(note.duration > 0)) return null
  const lengthPct = clamp((v.length / note.duration) * 100, 0, 100)
  const period = v.rate > 0 ? 1000 / v.rate : 175
  const fadeIn = clamp(((v.delay ?? 0) / note.duration) * 100, 0, 100)
  return [lengthPct, period, v.depth ?? 0, fadeIn, fadeIn, v.shift ?? 0, v.drift ?? 0, 0]
    .map((x) => formatNumber(round(Number(x) || 0, 4)))
    .join(',')
}

function needsTimeSignatureExtension(timeSignatures) {
  if (timeSignatures.length > 1) return true
  const ts = timeSignatures[0]
  return !!ts && (ts.numerator !== 4 || ts.denominator !== 4)
}

/* ------------------------------------------------------------ 编码处理 */

function decodeText(buffer) {
  if (typeof buffer === 'string') return buffer.replace(/^\uFEFF/, '')
  if (!Buffer.isBuffer(buffer)) throw new Error('ust 读取失败：输入不是 Buffer')
  const head = buffer.subarray(0, 4096).toString('latin1')
  const declared = head.match(/Charset\s*=\s*([A-Za-z0-9_\-]+)/i)
  if (declared) {
    const label = charsetLabel(declared[1])
    if (label) {
      try {
        return new TextDecoder(label).decode(buffer).replace(/^\uFEFF/, '')
      } catch {
        /* 落到自动探测 */
      }
    }
  }
  // 合法 UTF-8 且含非 ASCII → UTF-8；否则按 UTAU 默认的 Shift-JIS
  try {
    const strict = new TextDecoder('utf-8', { fatal: true }).decode(buffer)
    if (/[^\u0000-\u007F]/.test(strict)) return strict.replace(/^\uFEFF/, '')
  } catch {
    /* 不是合法 UTF-8，按 Shift-JIS 处理 */
  }
  try {
    return new TextDecoder('shift-jis').decode(buffer).replace(/^\uFEFF/, '')
  } catch {
    return buffer.toString('utf8').replace(/^\uFEFF/, '')
  }
}

function charsetLabel(name) {
  const n = String(name).toLowerCase().replace(/[_\s]/g, '-')
  if (n === 'utf-8' || n === 'utf8') return 'utf-8'
  if (n === 'shift-jis' || n === 'sjis' || n === 'cp932' || n === 'windows-31j' || n === 'ms932') return 'shift-jis'
  if (n === 'euc-jp' || n === 'eucjp') return 'euc-jp'
  if (n === 'gbk' || n === 'gb2312' || n === 'gb18030') return 'gbk'
  if (n === 'big5') return 'big5'
  if (n === 'utf-16' || n === 'utf-16le' || n === 'unicode') return 'utf-16le'
  return null
}

function isShiftJis(encoding) {
  return charsetLabel(encoding ?? '') === 'shift-jis'
}

/** UTF-8 直出；Shift-JIS 走 PowerShell（.NET GetEncoding(932)），失败回退 UTF-8 */
function encodeText(text, wantSjis) {
  if (!wantSjis) {
    const buf = Buffer.from(text, 'utf8')
    buf.encoding = 'utf8'
    buf.notes = []
    return buf
  }
  let dir = null
  try {
    dir = mkdtempSync(join(tmpdir(), 'ust-sjis-'))
    const inPath = join(dir, 'in.txt')
    const outPath = join(dir, 'out.ust')
    writeFileSync(inPath, text, 'utf8')
    const q = (p) => `'${p.replace(/'/g, "''")}'`
    const script =
      `$t=[System.IO.File]::ReadAllText(${q(inPath)},[System.Text.Encoding]::UTF8);` +
      `[System.IO.File]::WriteAllBytes(${q(outPath)},[System.Text.Encoding]::GetEncoding(932).GetBytes($t))`
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      stdio: 'ignore',
      timeout: 60000,
      windowsHide: true,
    })
    const buf = readFileSync(outPath)
    buf.encoding = 'shift-jis'
    buf.notes = ['已通过 PowerShell 转码为 Shift-JIS(CP932)']
    return buf
  } catch (err) {
    const buf = Buffer.from(text, 'utf8')
    buf.encoding = 'utf8'
    buf.notes = [`Shift-JIS 转码失败（${err.message}），已回退 UTF-8 并写入 Charset=UTF-8`]
    return buf
  } finally {
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        /* 忽略清理失败 */
      }
    }
  }
}

/* ------------------------------------------------------------ 小工具 */

function parseNumber(v) {
  if (v === undefined || v === null) return null
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  const s = String(v).trim()
  if (s === '') return null
  const n = Number(s)
  if (Number.isFinite(n)) return n
  // 本地化小数逗号（如 Tempo=159,00）
  if (/^[-+]?\d+,\d+$/.test(s)) {
    const m = Number(s.replace(',', '.'))
    return Number.isFinite(m) ? m : null
  }
  return null
}

function parseNumberList(v) {
  if (v === undefined || v === null || String(v).trim() === '') return null
  return String(v)
    .split(',')
    .map((x) => parseNumber(x) ?? 0)
}

function intOrNull(v) {
  const n = parseNumber(v)
  return n === null ? null : Math.round(n)
}

function formatNumber(v) {
  if (!Number.isFinite(v)) return '0'
  const r = Math.round(v * 10000) / 10000
  return Number.isInteger(r) ? String(r) : String(r)
}

function round(v, digits) {
  const f = 10 ** digits
  return Math.round(v * f) / f
}

function normalizeTempos(tempos) {
  const list = (tempos ?? [])
    .filter((t) => Number.isFinite(t?.tick) && Number.isFinite(t?.bpm) && t.bpm > 0)
    .map((t) => ({ tick: Math.max(0, Math.round(t.tick)), bpm: t.bpm }))
    .sort((a, b) => a.tick - b.tick)
  if (!list.length) list.push({ tick: 0, bpm: 120 })
  if (list[0].tick !== 0) list.unshift({ tick: 0, bpm: list[0].bpm })
  return list
}

function singerFromVoiceDir(voiceDir) {
  if (!voiceDir) return ''
  const cleaned = String(voiceDir).replace(/%[A-Z]+%/gi, '').replace(/[\\/]+$/, '')
  const parts = cleaned.split(/[\\/]/).filter(Boolean)
  return parts.length ? parts[parts.length - 1] : ''
}

function baseName(p) {
  const s = String(p)
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
  const base = i >= 0 ? s.slice(i + 1) : s
  return base.replace(/\.[^.]+$/, '')
}

function str(v, fallback) {
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  return fallback
}

export default { meta, fidelity, read, write }
