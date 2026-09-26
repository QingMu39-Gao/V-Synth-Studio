/**
 * OpenUtau 工程（.ustx，YAML）读写模块
 *
 * 字段与单位依据（均核对真实工程 tests/samples/openutau-autosave.ustx 与 OpenUtau 源码）：
 *
 *  - 顶层：name / comment / output_dir / cache_dir / ustx_version / resolution /
 *    bpm / beat_per_bar / beat_unit / expressions / exp_selectors / exp_primary /
 *    exp_secondary / key / time_signatures / tempos / tracks / voice_parts / wave_parts
 *  - resolution 恒为 480（= IR 的 TPQ）；若非 480，读入时整体缩放到 480。
 *  - notes[].pitch.data[].x 单位是**毫秒**，相对音符起点（可为负）；
 *    y 单位是 **10 音分**（y = 10 即 100 音分 = 1 个半音），相对 note.tone。
 *    三重依据（不是猜的）：
 *      1) OpenUtau RenderPhrase.cs：
 *         `new PitchPoint(timeAxis.MsPosToTickPos(nodePosMs + point.X), point.Y * 10 + note.AdjustedTone * 100, ...)`
 *         —— X 加在**毫秒**上、Y 乘 10 后才与 `tone * 100`（音分）相加 ⇒ X=毫秒、Y=10 音分。
 *      2) UtaFormatix OpenUtauPitchConversion.kt：
 *         `data class Point(val x: Double, // milliSec;  val y: Double, // 10 cents)`
 *      3) 真实样本自证：样本第 2 个音符 tone=67、前一音符 tone=62，其首个音高点是
 *         `{x: -40, y: -50}`；要落到前音高度需要 -5 个半音 = -500 音分，存的是 -50，
 *         故 y 只能是 10 音分单位（按「cents」读会整体偏移 10 倍）。
 *  - voice_parts[].curves[].xs 单位是 tick（相对 part 起点），ys 取值在 expressions[abbr].min..max 内。
 *  - voice_parts[].track_no：OpenUtau 源码直接 `tracks[part.trackNo]`（0 基），
 *    但真实文件两种写法都有（本机 17 个真实工程：13 个 0 基、4 个 1 基）。
 *    因此读入时自动判别（detectTrackNoBase），判定基准存进 extras，写回时沿用同一基准；
 *    新工程默认 0 基，与用户本机 OpenUtau 0.1.565 的
 *    `UTrack.TrackNo = project.tracks.IndexOf(this)` / `tracks[part.trackNo]` 一致。
 */

import { parseYaml } from '../../util/yaml.mjs'
import {
  TPQ,
  createProject,
  createTrack,
  createNote,
  createCurve,
  normalizeCurve,
  curveValueAt,
  tickToSec,
  secToTick,
  measureToTick,
  tickToMeasure,
  toUnit,
  fromUnit,
  clamp,
  uid,
  normalizeColor,
} from '../ir.mjs'

export const meta = {
  id: 'ustx',
  name: 'OpenUtau 工程',
  vendor: 'OpenUtau',
  exts: ['.ustx'],
  kind: 'yaml',
  canRead: true,
  canWrite: true,
  writeExt: '.ustx',
  encoding: 'utf8',
}

export const fidelity = {
  preserves: [
    'tempo',
    'timeSignature',
    'notes',
    'lyrics',
    'pitchCurve',
    'vibrato',
    'params.dynamics',
    'params.breathiness',
    'params.gender',
    'params.tension',
    'params.voicing',
    'trackVolume',
    'trackPan',
    'trackMute',
    'trackSolo',
    'singer',
    'phonemizer',
    'multiTrack',
    'velocity',
    'phonemes',
  ],
  drops: [
    '音素覆盖 phoneme_overrides（原样保留在同格式 extras，转其它格式时丢弃）',
    '音素级表达式 phoneme_expressions（同上）',
    'resampler 引擎与 flags（保留在 extras）',
    'wave_parts 音频片段（保留在 extras）',
  ],
  notes:
    'OpenUtau 工程结构完整保留（多 part、颤音、音符音高曲线、part 参数曲线）。' +
    '音符音高按「毫秒 + 10 音分」原生存储，读入时换算成绝对音高曲线（半音）；' +
    '轨道音量由 dB 归一化到 0..1（大于 0dB 的提升会被削平）。',
}

/* ------------------------------------------------------------ 默认表达式表 */

/** OpenUtau 默认表达式描述表（与真实工程逐字段一致） */
const DEFAULT_EXPRESSIONS = {
  dyn: { name: 'dynamics (curve)', abbr: 'dyn', type: 'Curve', min: -240, max: 120, default_value: 0, is_flag: false, flag: '' },
  pitd: { name: 'pitch deviation (curve)', abbr: 'pitd', type: 'Curve', min: -1200, max: 1200, default_value: 0, is_flag: false, flag: '' },
  clr: { name: 'voice color', abbr: 'clr', type: 'Options', min: 0, max: -1, default_value: 0, is_flag: false, options: [] },
  eng: { name: 'resampler engine', abbr: 'eng', type: 'Options', min: 0, max: 1, default_value: 0, is_flag: false, options: ['', 'worldline'] },
  vel: { name: 'velocity', abbr: 'vel', type: 'Numerical', min: 0, max: 200, default_value: 100, is_flag: false, flag: '' },
  vol: { name: 'volume', abbr: 'vol', type: 'Numerical', min: 0, max: 200, default_value: 100, is_flag: false, flag: '' },
  atk: { name: 'attack', abbr: 'atk', type: 'Numerical', min: 0, max: 200, default_value: 100, is_flag: false, flag: '' },
  dec: { name: 'decay', abbr: 'dec', type: 'Numerical', min: 0, max: 100, default_value: 0, is_flag: false, flag: '' },
  gen: { name: 'gender', abbr: 'gen', type: 'Numerical', min: -100, max: 100, default_value: 0, is_flag: true, flag: 'g' },
  genc: { name: 'gender (curve)', abbr: 'genc', type: 'Curve', min: -100, max: 100, default_value: 0, is_flag: false, flag: '' },
  bre: { name: 'breath', abbr: 'bre', type: 'Numerical', min: 0, max: 100, default_value: 0, is_flag: true, flag: 'B' },
  brec: { name: 'breathiness (curve)', abbr: 'brec', type: 'Curve', min: -100, max: 100, default_value: 0, is_flag: false, flag: '' },
  lpf: { name: 'lowpass', abbr: 'lpf', type: 'Numerical', min: 0, max: 100, default_value: 0, is_flag: true, flag: 'H' },
  norm: { name: 'normalize', abbr: 'norm', type: 'Numerical', min: 0, max: 100, default_value: 86, is_flag: true, flag: 'P' },
  mod: { name: 'modulation', abbr: 'mod', type: 'Numerical', min: 0, max: 100, default_value: 0, is_flag: false, flag: '' },
  'mod+': { name: 'modulation plus', abbr: 'mod+', type: 'Numerical', min: 0, max: 100, default_value: 0, is_flag: false, flag: '' },
  alt: { name: 'alternate', abbr: 'alt', type: 'Numerical', min: 0, max: 16, default_value: 0, is_flag: false, flag: '' },
  dir: { name: 'direct', abbr: 'dir', type: 'Options', min: 0, max: 1, default_value: 0, is_flag: false, options: ['off', 'on'] },
  shft: { name: 'tone shift', abbr: 'shft', type: 'Numerical', min: -36, max: 36, default_value: 0, is_flag: false, flag: '' },
  shfc: { name: 'tone shift (curve)', abbr: 'shfc', type: 'Curve', min: -1200, max: 1200, default_value: 0, is_flag: false, flag: '' },
  tenc: { name: 'tension (curve)', abbr: 'tenc', type: 'Curve', min: -100, max: 100, default_value: 0, is_flag: false, flag: '' },
  voic: { name: 'voicing (curve)', abbr: 'voic', type: 'Curve', min: 0, max: 100, default_value: 100, is_flag: false, flag: '' },
}

const DEFAULT_SELECTORS = ['dyn', 'pitd', 'clr', 'eng', 'vel', 'vol', 'atk', 'dec', 'gen', 'bre']

/** part.curves[].abbr -> IR 规范参数名（仅这些能映射进 IR §4） */
const CURVE_TO_PARAM = {
  dyn: 'dynamics',
  brec: 'breathiness',
  genc: 'gender',
  tenc: 'tension',
  voic: 'voicing',
}
const PARAM_TO_CURVE = Object.fromEntries(Object.entries(CURVE_TO_PARAM).map(([k, v]) => [v, k]))

/** OpenUtau 轨道色名 -> #rrggbb（仅用于 IR 展示；原生色名另存 extras） */
const TRACK_COLORS = {
  blue: '#3388bb',
  red: '#dd5544',
  green: '#44aa66',
  yellow: '#ddcc44',
  orange: '#ee8833',
  purple: '#9977cc',
  pink: '#ee77aa',
  cyan: '#44cccc',
  gray: '#999999',
  grey: '#999999',
  white: '#ffffff',
  black: '#333333',
}

const DEFAULT_PITCH_SHAPE = 'io'
const VALID_SHAPES = new Set(['io', 'l', 'i', 'o'])

/* ------------------------------------------------------------------ 读入 */

export function read(buffer, opts = {}) {
  const text = decodeText(buffer)
  let doc
  try {
    doc = parseYaml(text)
  } catch (err) {
    throw new Error(`ustx 解析失败：YAML 语法错误（${err.message}）`)
  }
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('ustx 解析失败：文件内容不是 YAML 映射，可能不是 OpenUtau 工程')
  }
  if (doc.ustx_version === undefined && !Array.isArray(doc.tracks) && !Array.isArray(doc.voice_parts)) {
    throw new Error('ustx 解析失败：缺少 ustx_version / tracks / voice_parts，不是有效的 OpenUtau 工程')
  }

  const warnings = []
  const version = doc.ustx_version === undefined ? '' : String(doc.ustx_version)
  const resolution = num(doc.resolution, TPQ)
  const k = resolution > 0 ? TPQ / resolution : 1
  if (Math.abs(k - 1) > 1e-9) warnings.push(`resolution=${resolution}，已按 ${k} 缩放到 480 tick/四分音符`)

  const tempos = readTempos(doc, k, warnings)
  const timeSignatures = readTimeSignatures(doc, k, warnings)
  const expressions = isMap(doc.expressions) ? doc.expressions : null

  const rawTracks = Array.isArray(doc.tracks) ? doc.tracks : []
  if (!rawTracks.length) throw new Error('ustx 解析失败：tracks 为空，无法得到任何轨道')
  const tracks = rawTracks.map((t, i) => readTrack(t, i))

  const rawParts = Array.isArray(doc.voice_parts)
    ? doc.voice_parts
    : Array.isArray(doc.parts)
      ? doc.parts
      : []
  if (!Array.isArray(doc.voice_parts) && rawParts.length) {
    warnings.push('检测到旧版 parts 字段，已按 voice_parts 处理')
  }

  const base = detectTrackNoBase(rawParts, tracks.length, warnings)
  const perTrack = tracks.map(() => [])

  rawParts.forEach((part, pi) => {
    if (!isMap(part)) {
      warnings.push(`voice_parts[${pi}] 不是映射，已跳过`)
      return
    }
    const trackNo = num(part.track_no, base)
    const ti = trackNo - base
    if (!Number.isFinite(ti) || ti < 0 || ti >= tracks.length) {
      warnings.push(`voice_parts[${pi}].track_no=${trackNo} 超出轨道范围（基准 ${base}），已跳过该 part`)
      return
    }
    perTrack[ti].push(part)
  })

  tracks.forEach((track, ti) => {
    const list = perTrack[ti]
    track.extras.ustx.parts = list.map((raw) => ({
      name: str(raw.name, 'New Part'),
      comment: str(raw.comment, ''),
      position: Math.round(num(raw.position, 0) * k),
      duration: Math.round(num(raw.duration, 0) * k),
      curves: Array.isArray(raw.curves) ? raw.curves : [],
    }))
    const pitchPoints = []
    const deviationPoints = []
    list.forEach((raw, partIndex) => {
      const partPosition = num(raw.position, 0)
      const rawNotes = Array.isArray(raw.notes) ? raw.notes : []
      rawNotes.forEach((rawNote, ni) => {
        const note = readNote(rawNote, {
          partPosition,
          partIndex,
          k,
          tempos,
          warnings,
          label: `voice_parts[轨道${ti + 1}/part${partIndex}].notes[${ni}]`,
          pitchPoints,
        })
        if (note) track.notes.push(note)
      })
      readPartCurves(raw, { partPosition, k, track, expressions, deviationPoints, warnings, label: `${ti + 1}/${partIndex}` })
    })
    track.notes.sort((a, b) => a.tick - b.tick || a.key - b.key)
    track.pitch = buildAbsolutePitch(pitchPoints, deviationPoints)
  })

  const project = createProject({
    sourceFormat: 'ustx',
    name: str(doc.name, opts.name ?? 'New Project'),
    comment: str(doc.comment, ''),
    tempos,
    timeSignatures,
    tracks,
    extras: {
      ustx: {
        version,
        outputDir: str(doc.output_dir, 'Vocal'),
        cacheDir: str(doc.cache_dir, 'UCache'),
        key: num(doc.key, 0),
        expressions,
        expSelectors: Array.isArray(doc.exp_selectors) ? doc.exp_selectors.slice() : null,
        expPrimary: num(doc.exp_primary, 0),
        expSecondary: num(doc.exp_secondary, 1),
        beatPerBar: num(doc.beat_per_bar, 4),
        beatUnit: num(doc.beat_unit, 4),
        bpm: num(doc.bpm, 120),
        waveParts: Array.isArray(doc.wave_parts) ? doc.wave_parts : [],
        trackNoBase: base,
        warnings,
      },
    },
  })
  return project
}

/**
 * 判定 voice_parts[].track_no 的基准（0 或 1）。真实工程两种写法都存在：
 *   1) 出现 0 或负数 → 0 基（1 基不可能有 0）
 *   2) 最大值 >= 轨道数 → 1 基（0 基会越界）
 *   3) 其余（有轨道没有 part）→ 按 1 基解释，并记录 warning
 */
function detectTrackNoBase(parts, trackCount, warnings) {
  const nos = parts
    .filter((p) => isMap(p) && Number.isFinite(Number(p.track_no)))
    .map((p) => Math.round(Number(p.track_no)))
  if (!nos.length) return 0
  const min = Math.min(...nos)
  const max = Math.max(...nos)
  if (min <= 0) return 0
  if (max >= trackCount) return 1
  if (max === trackCount - 1) {
    warnings.push(
      `voice_parts[].track_no 取值为 ${min}..${max}（共 ${trackCount} 轨），两种基准都能容纳，已按 1 基解释（第 1 轨 = 1）`,
    )
    return 1
  }
  return 0
}

function readTempos(doc, k, warnings) {
  const list = []
  const raw = Array.isArray(doc.tempos) ? doc.tempos : []
  raw.forEach((t, i) => {
    const bpm = num(t?.bpm, NaN)
    if (!Number.isFinite(bpm) || bpm <= 0) {
      warnings.push(`tempos[${i}] bpm 非法，已跳过`)
      return
    }
    list.push({ tick: Math.round(num(t?.position, 0) * k), bpm })
  })
  if (!list.length) {
    const legacy = num(doc.bpm, 120)
    list.push({ tick: 0, bpm: legacy > 0 ? legacy : 120 })
  }
  list.sort((a, b) => a.tick - b.tick)
  if (list[0].tick !== 0) list.unshift({ tick: 0, bpm: list[0].bpm })
  return list
}

function readTimeSignatures(doc, k, warnings) {
  const raw = Array.isArray(doc.time_signatures) ? doc.time_signatures : []
  const built = []
  for (const item of raw) {
    const numerator = Math.max(1, Math.round(num(item?.beat_per_bar, 4)))
    const denominator = Math.max(1, Math.round(num(item?.beat_unit, 4)))
    const bar = Math.max(0, Math.round(num(item?.bar_position, 0)))
    let tick
    if (!built.length) {
      tick = bar === 0 ? 0 : Math.round(((TPQ * 4) / denominator) * numerator * bar * k)
    } else {
      tick = measureToTick(bar, { timeSignatures: built, measurePrefix: 0 })
    }
    if (built.length && tick <= built[built.length - 1].tick) {
      warnings.push(`time_signatures 中 bar_position=${bar} 未产生新的 tick，已跳过`)
      continue
    }
    built.push({ tick, numerator, denominator })
  }
  if (!built.length) {
    built.push({
      tick: 0,
      numerator: Math.max(1, Math.round(num(doc.beat_per_bar, 4))),
      denominator: Math.max(1, Math.round(num(doc.beat_unit, 4))),
    })
  }
  if (built[0].tick !== 0) built.unshift({ tick: 0, numerator: 4, denominator: 4 })
  return built
}

function readTrack(raw, index) {
  const t = isMap(raw) ? raw : {}
  const colorName = str(t.track_color, 'Blue').trim()
  const volumeDb = num(t.volume, 0)
  const phonemizer = str(t.phonemizer, '')
  const track = createTrack({
    id: uid('trk'),
    name: str(t.track_name, `Track${index + 1}`),
    singer: str(t.singer, ''),
    color: TRACK_COLORS[colorName.toLowerCase()] ?? '',
    muted: t.mute === true,
    solo: t.solo === true,
    volume: clamp(Math.pow(10, volumeDb / 20), 0, 1),
    pan: clamp(num(t.pan, 0), -1, 1),
    language: languageOf(phonemizer),
    notes: [],
    extras: {
      ustx: {
        singer: str(t.singer, ''),
        phonemizer,
        rendererSettings: isMap(t.renderer_settings) ? t.renderer_settings : {},
        trackColor: colorName,
        trackExpressions: Array.isArray(t.track_expressions) ? t.track_expressions : [],
        voiceColorNames: Array.isArray(t.voice_color_names) ? t.voice_color_names : [''],
        volumeDb,
        pan: num(t.pan, 0),
        // 原生轨道映射整体留档：写回时按源文件的键序摆放（OpenUtau 各版本字段顺序不同，
        // 例如 backup 版以 phonemizer 开头、autosave 版以 singer 开头），并搬运我们不认识的新字段
        rawTrack: isMap(raw) ? raw : null,
        parts: [],
      },
    },
  })
  applyTrackExpressions(track)
  return track
}

function readNote(raw, ctx) {
  const { partPosition, partIndex, k, tempos, warnings, label, pitchPoints } = ctx
  const n = isMap(raw) ? raw : {}
  const position = num(n.position, NaN)
  const duration = num(n.duration, NaN)
  const tone = num(n.tone, NaN)
  if (!Number.isFinite(position) || !Number.isFinite(duration) || !Number.isFinite(tone)) {
    warnings.push(`音符 ${label} 缺 position/duration/tone，已跳过`)
    return null
  }
  if (duration <= 0) {
    warnings.push(`音符 ${label} duration=${duration} 非法，已跳过`)
    return null
  }
  const startTick = Math.round((partPosition + position) * k)
  const durTick = Math.max(1, Math.round(duration * k))
  const key = clamp(Math.round(tone), 0, 127)
  if (key !== Math.round(tone)) warnings.push(`音符 ${label} tone=${tone} 超出 0..127，已裁剪`)

  const rawPitch = isMap(n.pitch) ? n.pitch : null
  const pitchData = Array.isArray(rawPitch?.data) ? rawPitch.data.filter((p) => isMap(p)) : []

  const note = createNote({
    tick: startTick,
    duration: durTick,
    key,
    lyric: str(n.lyric, ''),
    attributes: {
      ustx: {
        partIndex,
        snapFirst: rawPitch ? rawPitch.snap_first !== false : true,
        pitchData: pitchData.map((p) => ({
          x: num(p.x, 0),
          y: num(p.y, 0),
          shape: VALID_SHAPES.has(String(p.shape)) ? String(p.shape) : DEFAULT_PITCH_SHAPE,
        })),
        vibrato: isMap(n.vibrato) ? { ...n.vibrato } : null,
        phonemeExpressions: Array.isArray(n.phoneme_expressions) ? n.phoneme_expressions : [],
        phonemeOverrides: Array.isArray(n.phoneme_overrides) ? n.phoneme_overrides : [],
        phonemeIndexes: Array.isArray(n.phoneme_indexes) ? n.phoneme_indexes : [],
        phonemizer: n.phonemizer ?? null,
        tuning: num(n.tuning, 0),
      },
    },
  })
  note.velocity = velocityFromExpressions(note.attributes.ustx.phonemeExpressions, note.velocity)
  applyVibrato(note)

  // 音高曲线：x 毫秒（相对音符起点）、y 10 音分（相对 tone）→ 绝对 tick + 半音
  const startMs = tickToSec(startTick, tempos) * 1000
  if (pitchData.length) {
    for (const p of pitchData) {
      const tick = Math.round(secToTick((startMs + num(p.x, 0)) / 1000, tempos))
      pitchPoints.push({ tick, value: key + num(p.y, 0) / 10 })
    }
    const first = pitchData[0]
    const last = pitchData[pitchData.length - 1]
    const firstTick = Math.round(secToTick((startMs + num(first.x, 0)) / 1000, tempos))
    const lastTick = Math.round(secToTick((startMs + num(last.x, 0)) / 1000, tempos))
    if (firstTick > startTick) pitchPoints.push({ tick: startTick, value: key + num(first.y, 0) / 10 })
    const endTick = startTick + durTick
    if (lastTick < endTick) pitchPoints.push({ tick: endTick, value: key + num(last.y, 0) / 10 })
  } else {
    pitchPoints.push({ tick: startTick, value: key }, { tick: startTick + durTick, value: key })
  }
  return note
}

/** part.curves -> IR 参数曲线；pitd 叠加到绝对音高；不可映射的原样留在 extras */
function readPartCurves(rawPart, ctx) {
  const { partPosition, k, track, expressions, deviationPoints, warnings, label } = ctx
  const curves = Array.isArray(rawPart.curves) ? rawPart.curves : []
  for (const curve of curves) {
    if (!isMap(curve)) continue
    const abbr = str(curve.abbr, '')
    const xs = Array.isArray(curve.xs) ? curve.xs : []
    const ys = Array.isArray(curve.ys) ? curve.ys : []
    if (!abbr) continue
    if (abbr === 'pitd') {
      for (let i = 0; i < Math.min(xs.length, ys.length); i += 1) {
        deviationPoints.push({
          tick: Math.round((partPosition + num(xs[i], 0)) * k),
          value: num(ys[i], 0) / 100,
        })
      }
      continue
    }
    const param = CURVE_TO_PARAM[abbr]
    if (!param) continue
    const desc = (expressions && expressions[abbr]) || DEFAULT_EXPRESSIONS[abbr]
    const min = num(desc?.min, 0)
    const max = num(desc?.max, 1)
    if (!(max > min)) {
      warnings.push(`part ${label} 的曲线 ${abbr} 取值范围非法（min=${min}, max=${max}），已跳过`)
      continue
    }
    const ticks = []
    const values = []
    for (let i = 0; i < Math.min(xs.length, ys.length); i += 1) {
      ticks.push(Math.round((partPosition + num(xs[i], 0)) * k))
      values.push(toUnit(num(ys[i], 0), min, max))
    }
    track.parameters[param] = mergeCurve(track.parameters[param], normalizeCurve({ ticks, values }))
  }
}

function mergeCurve(a, b) {
  const map = new Map()
  for (let i = 0; i < (a?.ticks?.length ?? 0); i += 1) map.set(a.ticks[i], a.values[i])
  for (let i = 0; i < b.ticks.length; i += 1) map.set(b.ticks[i], b.values[i])
  const ticks = [...map.keys()].sort((x, y) => x - y)
  return { ticks, values: ticks.map((t) => map.get(t)) }
}

/** 音符音高点 + pitd 偏差曲线 -> IR 绝对音高曲线（半音、tick 升序） */
function buildAbsolutePitch(pitchPoints, deviationPoints) {
  const valid = pitchPoints.filter((p) => Number.isFinite(p.tick) && Number.isFinite(p.value) && p.tick >= 0)
  const devValid = deviationPoints.filter((p) => Number.isFinite(p.tick) && Number.isFinite(p.value) && p.tick >= 0)
  if (!valid.length && !devValid.length) return createCurve()
  const base = normalizeCurve({ ticks: valid.map((p) => p.tick), values: valid.map((p) => p.value) })
  const dev = normalizeCurve({ ticks: devValid.map((p) => p.tick), values: devValid.map((p) => p.value) })
  if (!base.ticks.length) return dev
  if (!dev.ticks.length) return base
  // 两条分段线性曲线之和：在断点并集上取值（分段线性函数的和仍分段线性）
  const ticks = [...new Set([...base.ticks, ...dev.ticks])].sort((a, b) => a - b)
  return { ticks, values: ticks.map((t) => curveValueAt(base, t) + curveValueAt(dev, t)) }
}

function applyVibrato(note) {
  const v = note.attributes.ustx.vibrato
  if (!v) return
  const length = num(v.length, 0)
  if (!(length > 0)) return
  const period = num(v.period, 175)
  note.attributes.vibrato = {
    length: Math.round(length),
    depth: num(v.depth, 0),
    rate: period > 0 ? Math.round((1000 / period) * 100) / 100 : 0,
    delay: Math.round(num(v.in, 0)),
    drift: num(v.drift, 0),
  }
}

/** 轨道级数值表达式（gen/bre）映射为常量参数曲线，便于跨格式转换 */
function applyTrackExpressions(track) {
  for (const exp of track.extras.ustx.trackExpressions) {
    if (!isMap(exp)) continue
    const abbr = str(exp.abbr, '')
    const value = num(exp.value, NaN)
    if (!abbr || !Number.isFinite(value)) continue
    const param = abbr === 'gen' ? 'gender' : abbr === 'bre' ? 'breathiness' : null
    if (!param) continue
    const desc = DEFAULT_EXPRESSIONS[abbr]
    track.parameters[param] = createCurve({
      ticks: [0],
      values: [toUnit(value, num(desc.min, 0), num(desc.max, 100))],
    })
  }
}

function velocityFromExpressions(list, fallback) {
  for (const exp of list) {
    if (!isMap(exp)) continue
    if (str(exp.abbr, '') !== 'vel') continue
    const value = num(exp.value, NaN)
    if (!Number.isFinite(value)) continue
    return clamp(Math.round((value / 200) * 127), 0, 127)
  }
  return fallback
}

/* ------------------------------------------------------------------ 写出 */

export function write(project) {
  if (!project || !Array.isArray(project.tracks)) throw new Error('ustx 写出失败：project.tracks 缺失')
  const src = project.extras?.ustx ?? {}
  const tempos = normalizeTempos(project.tempos)
  const timeSignatures = normalizeTimeSignatures(project.timeSignatures)
  const base = src.trackNoBase === 1 ? 1 : 0

  const expressions = isMap(src.expressions) && Object.keys(src.expressions).length ? src.expressions : DEFAULT_EXPRESSIONS
  const doc = {
    name: str(project.name, 'New Project') || 'New Project',
    comment: str(project.comment, ''),
    output_dir: str(src.outputDir, 'Vocal'),
    cache_dir: str(src.cacheDir, 'UCache'),
    ustx_version: '0.7',
    resolution: TPQ,
    bpm: Number.isFinite(src.bpm) ? src.bpm : tempos.length ? tempos[0].bpm : 120,
    beat_per_bar: timeSignatures[0]?.numerator ?? 4,
    beat_unit: timeSignatures[0]?.denominator ?? 4,
    expressions,
    exp_selectors: Array.isArray(src.expSelectors) && src.expSelectors.length ? src.expSelectors.slice() : DEFAULT_SELECTORS.slice(),
    exp_primary: num(src.expPrimary, 0),
    exp_secondary: num(src.expSecondary, 1),
    key: num(src.key, 0),
    time_signatures: buildTimeSignatures(timeSignatures),
    tempos: tempos.map((t) => ({ position: Math.round(t.tick), bpm: round(t.bpm, 3) })),
    tracks: [],
    voice_parts: [],
    wave_parts: Array.isArray(src.waveParts) ? src.waveParts : [],
  }

  project.tracks.forEach((track, ti) => {
    doc.tracks.push(buildTrack(track, ti))
    for (const part of buildParts(track, ti, tempos, base)) doc.voice_parts.push(part)
  })

  // .NET 的 Encoding.UTF8 带 BOM，OpenUtau 读回时自动剥离；保持一致
  return Buffer.from(`\uFEFF${emitDocument(doc)}`, 'utf8')
}

function buildTimeSignatures(timeSignatures) {
  const out = []
  for (const ts of timeSignatures) {
    out.push({
      bar_position: tickToMeasure(ts.tick, timeSignatures, 0).measure,
      beat_per_bar: ts.numerator,
      beat_unit: ts.denominator,
    })
  }
  if (!out.length) out.push({ bar_position: 0, beat_per_bar: 4, beat_unit: 4 })
  return out
}

function buildTrack(track, ti) {
  const e = track.extras?.ustx ?? {}
  const volume = clamp(num(track.volume, 1), 1e-4, 1)
  const volumeDb = Number.isFinite(e.volumeDb) ? e.volumeDb : round(20 * Math.log10(volume), 2)
  // track.phonemizer 是 OpenUtau 的必需字段（缺了工程打不开/唱不出声）：
  // 源工程没有该值时按语言给一个 OpenUtau 内置音素器作默认
  const phonemizer = str(e.phonemizer, '') || defaultPhonemizer(track.language)
  const managed = {
    singer: str(track.singer, str(e.singer, '')),
    phonemizer,
    renderer_settings: isMap(e.rendererSettings) ? e.rendererSettings : {},
    track_name: str(track.name, `Track${ti + 1}`),
    track_color: str(e.trackColor, colorNameOf(track.color)),
    mute: track.muted === true,
    solo: track.solo === true,
    volume: round(volumeDb, 3),
    pan: round(clamp(num(track.pan, 0), -1, 1), 3),
    track_expressions: buildTrackExpressions(track, e),
    voice_color_names: Array.isArray(e.voiceColorNames) && e.voiceColorNames.length ? e.voiceColorNames.slice() : [''],
  }
  // 同格式往返：沿用源文件的键序（并原样带上我们不认识的字段），
  // 否则 OpenUtau 各版本写出顺序不同，会把 phonemizer 挤到 singer 之后
  const raw = isMap(e.rawTrack) ? e.rawTrack : null
  if (!raw) return managed
  const out = {}
  for (const key of Object.keys(raw)) out[key] = Object.hasOwn(managed, key) ? managed[key] : raw[key]
  for (const [key, value] of Object.entries(managed)) {
    if (Object.hasOwn(out, key)) continue
    // 源文件没有 singer（旧版 OpenUtau 不写该字段）且本轨也没有歌手时不必补一个空值
    if (key === 'singer' && value === '') continue
    out[key] = value
  }
  return out
}

function buildTrackExpressions(track, e) {
  const out = []
  const seen = new Set()
  if (Array.isArray(e.trackExpressions) && e.trackExpressions.length) {
    for (const exp of e.trackExpressions) {
      if (!isMap(exp)) continue
      const abbr = str(exp.abbr, '')
      if (!abbr || seen.has(abbr)) continue
      seen.add(abbr)
      out.push({ abbr, value: num(exp.value, 0) })
    }
    return out
  }
  // 从常量参数曲线反推（gen / bre）
  for (const [abbr, param] of [['gen', 'gender'], ['bre', 'breathiness']]) {
    const curve = track.parameters?.[param]
    if (!curve?.values?.length) continue
    const first = curve.values[0]
    if (!curve.values.every((v) => Math.abs(v - first) < 1e-6)) continue
    const desc = DEFAULT_EXPRESSIONS[abbr]
    const value = Math.round(fromUnit(first, num(desc.min, 0), num(desc.max, 100)))
    if (value !== num(desc.default_value, 0)) out.push({ abbr, value })
  }
  return out
}

/** 按 extras 中记录的 part 划分音符；无 extras 时每轨一个 part */
function buildParts(track, ti, tempos, base) {
  const e = track.extras?.ustx ?? {}
  const rawParts = Array.isArray(e.parts) ? e.parts : []
  const buckets = new Map()
  track.notes.forEach((note) => {
    let idx = num(note.attributes?.ustx?.partIndex, 0)
    if (!Number.isInteger(idx) || idx < 0 || (rawParts.length && idx >= rawParts.length)) idx = 0
    if (!buckets.has(idx)) buckets.set(idx, [])
    buckets.get(idx).push(note)
  })
  if (!buckets.size) buckets.set(0, [])

  const partCount = Math.max(rawParts.length, Math.max(...buckets.keys()) + 1)
  const parts = []
  for (let i = 0; i < partCount; i += 1) {
    const meta = rawParts[i] ?? {}
    const notes = (buckets.get(i) ?? []).slice().sort((a, b) => a.tick - b.tick || a.key - b.key)
    if (!notes.length && !rawParts[i]) continue
    const position = Math.round(num(meta.position, 0))
    const notesYaml = notes.map((note) => buildNote(note, track, tempos, position))
    const lastEnd = notesYaml.length ? Math.max(...notesYaml.map((n) => n.position + n.duration)) : 0
    const duration = Math.max(Math.round(num(meta.duration, 0)), lastEnd, TPQ)
    parts.push({
      duration,
      name: str(meta.name, 'New Part'),
      comment: str(meta.comment, ''),
      track_no: ti + base, // OpenUtau 源码为 0 基（tracks[part.trackNo]）；沿用来源文件基准
      position,
      notes: notesYaml,
      curves: buildCurves(track, meta, position),
    })
  }
  return parts
}

function buildCurves(track, meta, partPosition) {
  const raw = Array.isArray(meta.curves) ? meta.curves : []
  if (raw.length) return raw
  const out = []
  for (const [param, abbr] of Object.entries(PARAM_TO_CURVE)) {
    const curve = track.parameters?.[param]
    if (!curve?.ticks?.length) continue
    const desc = DEFAULT_EXPRESSIONS[abbr]
    const xs = []
    const ys = []
    for (let i = 0; i < curve.ticks.length; i += 1) {
      const rel = curve.ticks[i] - partPosition
      if (rel < 0) continue
      xs.push(Math.round(rel))
      ys.push(Math.round(fromUnit(curve.values[i], num(desc.min, 0), num(desc.max, 1))))
    }
    if (xs.length) out.push({ abbr, xs, ys })
  }
  return out
}

function buildNote(note, track, tempos, partPosition) {
  const a = note.attributes?.ustx ?? {}
  const yaml = {
    position: Math.round(note.tick - partPosition),
    duration: Math.max(1, Math.round(note.duration)),
    tone: clamp(Math.round(num(note.key, 60)), 0, 127),
    lyric: str(note.lyric, ''),
    pitch: buildPitch(note, track, tempos),
    vibrato: buildVibrato(note),
    phoneme_expressions: buildPhonemeExpressions(note, a),
    phoneme_overrides: Array.isArray(a.phonemeOverrides) ? a.phonemeOverrides : [],
  }
  if (a.phonemizer) yaml.phonemizer = a.phonemizer
  if (Array.isArray(a.phonemeIndexes) && a.phonemeIndexes.length) yaml.phoneme_indexes = a.phonemeIndexes
  return yaml
}

function buildPitch(note, track, tempos) {
  const a = note.attributes?.ustx ?? {}
  const data = Array.isArray(a.pitchData) ? a.pitchData : null
  // 注意：OpenUtau 只把 PitchPoint / UVibrato / UExpression 设为流式，
  // UPitch 本身是块映射 `pitch:` -> `data:` 块序列（每个点是流式映射）
  if (data && data.length) {
    // 同格式往返：原生「毫秒 + 10 音分」数据原样复用，保形不丢
    return {
      data: data.map(
        (p) =>
          new Flow({
            x: round(num(p.x, 0), 4),
            y: round(num(p.y, 0), 4),
            shape: VALID_SHAPES.has(p.shape) ? p.shape : DEFAULT_PITCH_SHAPE,
          }),
      ),
      snap_first: a.snapFirst !== false,
    }
  }
  const derived = derivePitchData(note, track, tempos)
  return { data: derived.points.map((p) => new Flow(p)), snap_first: derived.snapFirst }
}

/** 由 IR 绝对音高曲线反推 OpenUtau 音符音高数据（毫秒 / 10 音分） */
function derivePitchData(note, track, tempos) {
  const curve = track.pitch
  const startMs = tickToSec(note.tick, tempos) * 1000
  const endTick = note.tick + note.duration
  const endMs = tickToSec(endTick, tempos) * 1000
  const prev = track.notes.find((n) => n.tick + n.duration === note.tick)
  const xs = []
  if (prev) xs.push(-40) // 与前音符相邻时补起点前的过渡点（OpenUtau 默认模板）
  xs.push(0)
  if (curve?.ticks?.length) {
    for (const t of curve.ticks) {
      if (t > note.tick && t < endTick) xs.push(round(tickToSec(t, tempos) * 1000 - startMs, 4))
    }
  }
  xs.push(round(endMs - startMs, 4))

  const seen = new Set()
  const points = []
  for (const x of xs.sort((a, b) => a - b)) {
    if (seen.has(x)) continue
    seen.add(x)
    const tick = secToTick((startMs + x) / 1000, tempos)
    const value = curve?.ticks?.length ? curveValueAt(curve, tick) : note.key
    points.push({ x, y: round((value - note.key) * 10, 2), shape: DEFAULT_PITCH_SHAPE })
  }
  if (points.length < 2) {
    points.length = 0
    points.push(
      { x: 0, y: 0, shape: DEFAULT_PITCH_SHAPE },
      { x: round(endMs - startMs, 4), y: 0, shape: DEFAULT_PITCH_SHAPE },
    )
  }
  return { points, snapFirst: !!prev }
}

function buildVibrato(note) {
  const raw = note.attributes?.ustx?.vibrato
  if (isMap(raw)) {
    return new Flow({
      length: round(num(raw.length, 0), 4),
      period: round(num(raw.period, 175), 4),
      depth: round(num(raw.depth, 25), 4),
      in: round(num(raw.in, 10), 4),
      out: round(num(raw.out, 10), 4),
      shift: round(num(raw.shift, 0), 4),
      drift: round(num(raw.drift, 0), 4),
      vol_link: round(num(raw.vol_link, 0), 4),
    })
  }
  const v = note.attributes?.vibrato
  const length = num(v?.length, 0)
  const period = num(v?.rate, 0) > 0 ? 1000 / v.rate : 175
  return new Flow({
    length: round(length, 4),
    period: round(period, 4),
    depth: round(num(v?.depth, 0), 4),
    in: round(num(v?.delay, 0), 4),
    out: round(num(v?.delay, 0), 4),
    shift: 0,
    drift: round(num(v?.drift, 0), 4),
    vol_link: 0,
  })
}

function buildPhonemeExpressions(note, a) {
  if (Array.isArray(a.phonemeExpressions) && a.phonemeExpressions.length) {
    return a.phonemeExpressions.map(
      (e) => new Flow({ index: Math.round(num(e.index, 0)), abbr: str(e.abbr, ''), value: num(e.value, 0) }),
    )
  }
  const out = []
  if (Number.isFinite(note.velocity) && Math.round(note.velocity) !== 64) {
    out.push(new Flow({ index: 0, abbr: 'vel', value: Math.round((clamp(note.velocity, 0, 127) / 127) * 200) }))
  }
  return out
}

/* -------------------------------------------------------- YAML 生成器 */

/** YamlDotNet(UnderscoredNamingConvention) 风格的 ustx 序列化（Windows 下为 CRLF） */
function emitDocument(doc) {
  const lines = []
  emitMap(doc, 0, lines)
  return lines.join('\r\n') + '\r\n'
}

/** 需要单行流式输出的对象（对应 OpenUtau 的 FlowEmitter） */
class Flow {
  constructor(obj) {
    this.obj = obj
  }
}

function emitMap(obj, indent, lines) {
  const pad = ' '.repeat(indent)
  for (const [key, value] of Object.entries(obj)) {
    emitEntry(pad, key, value, indent, lines)
  }
}

function emitEntry(pad, key, value, indent, lines) {
  const k = yamlKey(key)
  if (value instanceof Flow) {
    lines.push(`${pad}${k}: ${flowText(value.obj)}`)
    return
  }
  if (Array.isArray(value)) {
    if (!value.length) {
      lines.push(`${pad}${k}: []`)
      return
    }
    lines.push(`${pad}${k}:`)
    emitSeq(value, indent, lines)
    return
  }
  if (isMap(value)) {
    if (!Object.keys(value).length) {
      lines.push(`${pad}${k}: {}`)
      return
    }
    lines.push(`${pad}${k}:`)
    emitMap(value, indent + 2, lines)
    return
  }
  lines.push(`${pad}${k}: ${yamlScalar(value)}`)
}

/** 块序列与父键同缩进（YamlDotNet 默认风格，与真实样本一致） */
function emitSeq(arr, indent, lines) {
  const pad = ' '.repeat(indent)
  for (const item of arr) {
    if (item instanceof Flow) {
      lines.push(`${pad}- ${flowText(item.obj)}`)
      continue
    }
    if (Array.isArray(item)) {
      if (!item.length) {
        lines.push(`${pad}- []`)
        continue
      }
      lines.push(`${pad}-`)
      emitSeq(item, indent + 2, lines)
      continue
    }
    if (isMap(item)) {
      const keys = Object.keys(item)
      if (!keys.length) {
        lines.push(`${pad}- {}`)
        continue
      }
      const [first, ...rest] = keys
      emitSeqFirstEntry(pad, first, item[first], indent, lines)
      for (const key of rest) {
        emitEntry(' '.repeat(indent + 2), key, item[key], indent + 2, lines)
      }
      continue
    }
    lines.push(`${pad}- ${yamlScalar(item)}`)
  }
}

/** 序列项内联映射的第一个键：`- key: ...`（其余键 +2，嵌套值再 +2） */
function emitSeqFirstEntry(pad, key, value, indent, lines) {
  const k = yamlKey(key)
  if (value instanceof Flow) {
    lines.push(`${pad}- ${k}: ${flowText(value.obj)}`)
    return
  }
  if (Array.isArray(value)) {
    if (!value.length) {
      lines.push(`${pad}- ${k}: []`)
      return
    }
    lines.push(`${pad}- ${k}:`)
    emitSeq(value, indent + 2, lines)
    return
  }
  if (isMap(value)) {
    if (!Object.keys(value).length) {
      lines.push(`${pad}- ${k}: {}`)
      return
    }
    lines.push(`${pad}- ${k}:`)
    emitMap(value, indent + 4, lines)
    return
  }
  lines.push(`${pad}- ${k}: ${yamlScalar(value)}`)
}

/** 单行流式映射，如 `{x: -40, y: 0, shape: io}` */
function flowText(obj) {
  const parts = Object.entries(obj).map(([k, v]) => {
    if (v instanceof Flow) return `${yamlKey(k)}: ${flowText(v.obj)}`
    if (Array.isArray(v)) return `${yamlKey(k)}: [${v.map((x) => (x instanceof Flow ? flowText(x.obj) : yamlScalar(x))).join(', ')}]`
    if (isMap(v)) return `${yamlKey(k)}: ${flowText(v)}`
    return `${yamlKey(k)}: ${yamlScalar(v)}`
  })
  return `{${parts.join(', ')}}`
}

const TYPED = /^([-+]?\d+(\.\d*)?([eE][-+]?\d+)?|true|false|null|~|Null|NULL|True|False|[-+]?\.(inf|Inf|nan|NaN))$/

/**
 * 判断字符串是否需要加引号。
 * 对齐 YamlDotNet 的 WithQuotingNecessaryStrings：只对「会被误解成其它类型」
 * 或「YAML 语法不允许裸写」的字符串加引号，因此 `+`、`-`（单独出现时除外）
 * 等仍以裸标量输出，与 OpenUtau 写出的文件一致。
 */
function needsQuoteYaml(s) {
  if (s === '') return true
  if (/[\n\r\t]/.test(s)) return true
  if (TYPED.test(s)) return true
  if (/^\s|\s$/.test(s)) return true
  if (/^[,[\]{}#&*!|>'"%@`]/.test(s)) return true
  if (/^[-?:](\s|$)/.test(s)) return true
  if (/: /.test(s) || /\s#/.test(s)) return true
  return false
}

function yamlScalar(v) {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return v > 0 ? '.inf' : Number.isNaN(v) ? '.nan' : '-.inf'
    return String(v)
  }
  const s = String(v)
  return needsQuoteYaml(s) ? quoteStr(s) : s
}

function yamlKey(k) {
  return yamlScalar(k)
}

function quoteStr(s) {
  return `"${String(s)
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')}"`
}

/* ------------------------------------------------------------ 小工具 */

function decodeText(buffer) {
  if (typeof buffer === 'string') return buffer.replace(/^\uFEFF/, '')
  if (!Buffer.isBuffer(buffer)) throw new Error('ustx 读取失败：输入不是 Buffer')
  return buffer.toString('utf8').replace(/^\uFEFF/, '')
}

function isMap(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function num(v, fallback) {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return n
  }
  return fallback
}

function str(v, fallback) {
  if (typeof v === 'string') return v
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (typeof v === 'boolean') return String(v)
  return fallback
}

function round(v, digits) {
  const f = 10 ** digits
  return Math.round(v * f) / f
}

function normalizeTempos(tempos) {
  const list = (tempos ?? [])
    .filter((t) => Number.isFinite(t?.tick) && Number.isFinite(t?.bpm) && t.bpm > 0)
    .map((t) => ({ tick: Math.round(t.tick), bpm: t.bpm }))
    .sort((a, b) => a.tick - b.tick)
  if (!list.length) list.push({ tick: 0, bpm: 120 })
  if (list[0].tick !== 0) list.unshift({ tick: 0, bpm: list[0].bpm })
  return list
}

function normalizeTimeSignatures(list) {
  const out = (list ?? [])
    .filter((t) => Number.isFinite(t?.tick))
    .map((t) => ({
      tick: Math.round(t.tick),
      numerator: Math.max(1, Math.round(t.numerator || 4)),
      denominator: Math.max(1, Math.round(t.denominator || 4)),
    }))
    .sort((a, b) => a.tick - b.tick)
  if (!out.length) out.push({ tick: 0, numerator: 4, denominator: 4 })
  if (out[0].tick !== 0) out.unshift({ tick: 0, numerator: 4, denominator: 4 })
  return out
}

function languageOf(phonemizer) {
  const p = String(phonemizer ?? '').toLowerCase()
  if (!p) return ''
  if (p.includes('japanese') || p.includes('kana')) return 'ja'
  if (p.includes('chinese') || p.includes('mandarin') || p.includes('pinyin')) return 'zh'
  if (p.includes('korean')) return 'ko'
  if (p.includes('english') || p.includes('arpa')) return 'en'
  if (p.includes('spanish')) return 'es'
  if (p.includes('italian')) return 'it'
  if (p.includes('french')) return 'fr'
  if (p.includes('german')) return 'de'
  if (p.includes('russian')) return 'ru'
  if (p.includes('portuguese')) return 'pt'
  return ''
}

function defaultPhonemizer(language) {
  switch (language) {
    case 'ja': return 'OpenUtau.Plugin.Builtin.JapaneseVCVPhonemizer'
    case 'zh': return 'OpenUtau.Plugin.Builtin.ChineseCVVCPhonemizer'
    case 'en': return 'OpenUtau.Plugin.Builtin.ArpasingPhonemizer'
    case 'ko': return 'OpenUtau.Plugin.Builtin.KoreanCVCPhonemizer'
    default: return 'OpenUtau.Core.DefaultPhonemizer'
  }
}

function colorNameOf(hex) {
  const c = normalizeColor(hex, '')
  if (!c) return 'Blue'
  const hit = Object.entries(TRACK_COLORS).find(([, v]) => v === c)
  if (hit) return hit[0].charAt(0).toUpperCase() + hit[0].slice(1)
  return 'Blue'
}

export default { meta, fidelity, read, write }
