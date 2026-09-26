/**
 * CeVIO Creative Studio / CeVIO AI 工程（.ccs）
 *
 * ⚠ 格式事实（已联网查证 + 用本机 CeVIO AI 生成的真实 .ccs 校验，勿凭印象改）：
 *   - .ccs 是 **UTF-8 XML**，不是 JSON。根元素 <Scenario Code="7251BC4B6168E7B2992FA620BD3E1E77">，
 *     层级为 Scenario > Sequence > Scene > { Units > Unit > Song, Groups > Group, SoundSetting }。
 *   - 歌唱轨：<Unit Category="SingerSong" Group="<uuid>">，与 <Groups><Group Id="<uuid>" Category="SingerSong"> 配对。
 *     对白轨 Category="TextVocal"（TalkData）本模块不转换。
 *   - <Song> 下：<Tempo><Sound Clock Tempo/></Tempo>、<Beat><Time Clock Beats BeatType/></Beat>、
 *     <Score><Key/>,<Dynamics/>,<Note/></Score>、<Parameter><LogF0|C0|Alpha|VibAmp|VibFrq|Husky|Timing/></Parameter>。
 *   - 音符：<Note Clock PitchStep PitchOctave Duration Lyric [Phonetic DoReMi Breath Accent Staccato SlurStart SlurStop Syllabic]/>
 *     音高 key = PitchStep + (PitchOctave + 1) * 12（PitchOctave=4、PitchStep=0 即中央 C）。
 *   - 时间单位 Clock：**960 Clock = 四分音符**（LibSasara 文档与真实样本音符时值双重确认），
 *     即 Clock = IR tick(TPQ 480) × 2，纯位置换算、与速度无关。
 *   - CeVIO 的第 1 小节起点固定在 Clock = 一个小节的长度处（第 0 小节为前置空小节）：
 *     故 IR tick = Clock/2 − 前置一小节长度 + measurePrefix。
 *   - <Parameter> 曲线：每点间隔 **0.005 秒**（200 点/秒），Data/NoData 的 Index/Repeat 为点序号；
 *     LogF0 值为**对数频率** key = 60 + (v − 5.566914341) / 0.05776226505。
 *
 * 写出采用「模板填充」：深拷贝 formats/templates/template.ccs，再把数据填进去，
 * 不再从零拼 XML（<Generation> 下的 TTS/SVSS 与 SoundSources/SoundSource 就是这么补全的）。
 *
 * 本模块的结构与默认值参照 UtaFormatix3（sdercolin, Apache-2.0）实现，见 docs/reference/utaformatix3/
 */

import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  TPQ,
  createProject,
  createTrack,
  createNote,
  createCurve,
  normalizeCurve,
  normalizeColor,
  clamp,
  tickToSec,
  secToTick,
} from '../ir.mjs'
import { parseXml, buildXml, el, find, findAll, attrOf, numAttr } from '../../util/xml.mjs'

export const meta = {
  id: 'ccs',
  name: 'CeVIO CS/AI 工程',
  vendor: 'CeVIO',
  exts: ['.ccs'],
  kind: 'xml', // 注意：.ccs 实为 XML（注册表里的 json 是占位猜测）
  canRead: true,
  canWrite: true,
  writeExt: '.ccs',
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
    'noteAttributes',
    'keySignature',
    'trackName',
    'trackVolume',
    'pan',
    'cast',
    'mute',
    'solo',
    'multiTrack',
    'phonemes',
    'trackPan',
    'params.dynamics',
    'params.breathiness',
  ],
  drops: [
    '对白轨（Category="TextVocal"）与音频轨不转换（原样留在 extras，回写同格式时保留）',
    '第 0 小节（前置空小节）内的速度/拍号事件',
    '参数曲线原有的 NoData 空档（曲线被修改后重编码时会按相邻点插值）',
    'Timing（音素时长）参数不映射到 IR，仅原样保留',
    '轨道快照 SnapShot、Unit 的剪辑时长语义',
  ],
  notes:
    'CeVIO 工程为 XML：时间以 Clock 计（960 Clock = 四分音符 = IR 的 2 tick），第 1 小节固定在 Clock=一小节长度处。' +
    '支持歌唱轨、歌词、音素覆盖（Note/@Phonetic）、音符属性、调号、LogF0 音高曲线；' +
    'C0(音量)/Alpha(声质)/VibAmp/VibFrq 采用 CeVIO 内部刻度，为近似线性映射（原始值存入 extras，回写时优先复用）。' +
    '<Generation> 下的 TTS/SVSS 结构（各代自己的 Dictionary 与 SoundSources/SoundSource）按模板写全：' +
    '读 .ccs 时原生的版本号与音源表原样回写，其它来源的工程用模板默认；原生缺 SoundSources 时补空列表，不凭空添加歌手。',
}

/* ------------------------------------------------------------------ 常量 */

const CLOCKS_PER_QUARTER = 960
const CLOCK_PER_TICK = CLOCKS_PER_QUARTER / TPQ // = 2
const PARAM_STEP_SEC = 0.005 // <Parameter> 每点 0.005 秒
const PARAM_PADDING_UNITS = 500 // 与 UtaFormatix 一致的曲线尾部余量
const KEY_CENTER_C = 60
const LOG_FRQ_CENTER_C = 5.566914341
const LOG_FRQ_DIFF_ONE_KEY = 0.05776226505
const SCENARIO_CODE = '7251BC4B6168E7B2992FA620BD3E1E77'
const DEFAULT_SONG_VERSION = '1.02'
const DEFAULT_UNIT_VERSION = '1.0'
/** CeVIO 默认轨道音量的内部值，作为 0 dB 参考（真实样本中恒为该值） */
const VOLUME_REF_NATIVE = -2.4177

/** 规范参数映射表：tag = CeVIO <Parameter> 子元素名，ir = IR 参数名 */
const PARAM_MAP = [
  { tag: 'C0', ir: 'dynamics', scale: { kind: 'db', ref: VOLUME_REF_NATIVE } },
  { tag: 'LogF0', ir: 'pitch', scale: { kind: 'logf0' } },
  { tag: 'Alpha', ir: 'breathiness', scale: { kind: 'range', min: -1, max: 1 } },
  { tag: 'VibAmp', ir: 'vibratoDepth', scale: { kind: 'range', min: 0, max: 300 } },
  { tag: 'VibFrq', ir: 'vibratoRate', scale: { kind: 'range', min: 0, max: 10 } },
  { tag: 'Husky', ir: 'roughness', scale: { kind: 'range', min: -1, max: 1 } },
]
const PARAM_TAGS = PARAM_MAP.map((p) => p.tag)
const EMOTION_ATTRS = ['Alpha', 'Emotion0', 'Emotion1', 'PitchShift', 'PitchTune', 'Husky', 'CommonKeys']

const LANG_TO_CEVIO = { ja: 'Japanese', en: 'English', zh: 'Chinese' }
const LANG_FROM_CEVIO = { japanese: 'ja', english: 'en', chinese: 'zh' }

/* -------------------------------------------------------------- 数值换算 */

/** CeVIO 对数频率 -> MIDI 音符号（浮点，绝对音高 semitones） */
function logF0ToKey(value) {
  return KEY_CENTER_C + (value - LOG_FRQ_CENTER_C) / LOG_FRQ_DIFF_ONE_KEY
}

/** MIDI 音符号 -> CeVIO 对数频率 */
function keyToLogF0(key) {
  return LOG_FRQ_CENTER_C + (key - KEY_CENTER_C) * LOG_FRQ_DIFF_ONE_KEY
}

/** CeVIO 内部值 -> IR 归一化值 */
function nativeToUnit(value, scale) {
  if (!Number.isFinite(value)) return 0
  if (scale.kind === 'logf0') return logF0ToKey(value)
  if (scale.kind === 'db') return clamp(10 ** ((value - scale.ref) / 20), 0, 1)
  const span = scale.max - scale.min
  return span === 0 ? 0 : clamp((value - scale.min) / span, 0, 1)
}

/** IR 归一化值 -> CeVIO 内部值 */
function unitToNative(value, scale) {
  if (!Number.isFinite(value)) return 0
  if (scale.kind === 'logf0') return keyToLogF0(value)
  if (scale.kind === 'db') return scale.ref + 20 * Math.log10(Math.max(value, 1e-4))
  return scale.min + clamp(value, 0, 1) * (scale.max - scale.min)
}

/** 数字转字符串：去掉多余小数位，避免 20*log10 造成的浮点尾巴 */
function fmtNum(value) {
  if (!Number.isFinite(value)) return '0'
  if (Number.isInteger(value)) return String(value)
  return String(Number(value.toFixed(6)))
}

const clampKey = (key) => clamp(Math.round(key), 0, 127)

/** 一个小节的 tick 数 */
function measureTicksOf(numerator, denominator) {
  return Math.round(((TPQ * 4) / (denominator || 4)) * (numerator || 4))
}

/* ---------------------------------------------------------------- 读入 */

function decodeText(buffer) {
  if (!buffer || !buffer.length) throw new Error('读取 .ccs 失败：文件内容为空')
  const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2))
    swapped.swap16()
    return swapped.toString('utf16le')
  }
  let text = buf.toString('utf8')
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)
  return text
}

/** 去掉 parent 引用，得到可 JSON 序列化的纯对象（存入 extras） */
function plain(node) {
  if (!node) return null
  return {
    name: node.name,
    attrs: { ...(node.attrs ?? {}) },
    children: (node.children ?? []).map(plain),
    text: node.text ?? '',
  }
}

/** plain() 的逆操作 */
function fromPlain(p) {
  return {
    name: p.name,
    attrs: { ...(p.attrs ?? {}) },
    children: (p.children ?? []).map(fromPlain),
    text: p.text ?? '',
    parent: null,
  }
}

function isSongUnit(unit) {
  const cat = attrOf(unit, 'Category', '')
  if (cat) return cat === 'SingerSong'
  return !!find(unit, 'Song') && !find(unit, 'Phonemes')
}

function readCastTable(scenario) {
  const table = {}
  const generation = find(scenario, 'Generation')
  if (!generation) return table
  for (const source of generation.children) {
    const list = find(source, 'SoundSources')
    if (!list) continue
    for (const item of findAll(list, 'SoundSource')) {
      const id = attrOf(item, 'Id', '')
      const name = attrOf(item, 'Name', '')
      if (id && name) table[id] = name
    }
  }
  return table
}

/** 读取 <Parameter> 下的所有曲线原始数据 */
function readRawParams(paramNode) {
  const out = {}
  if (!paramNode) return out
  for (const node of paramNode.children) {
    if (!node?.name) continue
    const items = []
    let pos = 0
    for (const d of node.children ?? []) {
      if (d.name !== 'Data' && d.name !== 'NoData') continue
      const idxAttr = attrOf(d, 'Index', null)
      const index = idxAttr === null || idxAttr === '' ? pos : Math.round(Number(idxAttr))
      const safeIndex = Number.isFinite(index) && index >= 0 ? index : pos
      const repeat = Math.max(1, Math.round(numAttr(d, 'Repeat', 1)) || 1)
      let value = null
      if (d.name === 'Data') {
        const num = Number(String(d.text ?? '').trim())
        value = Number.isFinite(num) ? num : null
      }
      items.push([safeIndex, repeat, value])
      pos = safeIndex + repeat
    }
    out[node.name] = { length: Math.round(numAttr(node, 'Length', 0)), items }
  }
  return out
}

/** 原始曲线数据 -> IR 曲线（含时间换算） */
function rawParamToCurve(raw, tempos, scale) {
  const ticks = []
  const values = []
  if (!raw) return createCurve()
  for (const [index, , value] of raw.items) {
    if (value === null || !Number.isFinite(value)) continue
    const tick = Math.max(0, secToTick(index * PARAM_STEP_SEC, tempos))
    ticks.push(tick)
    values.push(scale.kind === 'logf0' ? logF0ToKey(value) : nativeToUnit(value, scale))
  }
  return normalizeCurve({ ticks, values })
}

function readSong(unit) {
  const song = find(unit, 'Song')
  const temposNode = song ? find(song, 'Tempo') : null
  const beatsNode = song ? find(song, 'Beat') : null
  const score = song ? find(song, 'Score') : null
  const paramNode = song ? find(song, 'Parameter') : null

  const tempos = findAll(temposNode, 'Sound')
    .map((n) => ({ clock: numAttr(n, 'Clock', NaN), bpm: numAttr(n, 'Tempo', NaN) }))
    .filter((t) => Number.isFinite(t.clock) && t.clock >= 0 && t.bpm > 0)

  const beats = findAll(beatsNode, 'Time')
    .map((n) => ({
      clock: numAttr(n, 'Clock', NaN),
      numerator: Math.round(numAttr(n, 'Beats', 4)) || 4,
      denominator: Math.round(numAttr(n, 'BeatType', 4)) || 4,
    }))
    .filter((t) => Number.isFinite(t.clock) && t.clock >= 0)

  const rawNotes = []
  let skipped = 0
  for (const n of findAll(score, 'Note')) {
    const clock = numAttr(n, 'Clock', NaN)
    const duration = numAttr(n, 'Duration', NaN)
    if (!Number.isFinite(clock) || !Number.isFinite(duration) || duration <= 0) {
      skipped += 1
      continue
    }
    const step = Math.round(numAttr(n, 'PitchStep', 0))
    const octave = Math.round(numAttr(n, 'PitchOctave', 4))
    rawNotes.push({ clock, duration, key: clampKey(step + (octave + 1) * 12), node: n })
  }

  const keyNode = score ? find(score, 'Key') : null
  return {
    song,
    score,
    tempos,
    beats,
    rawNotes,
    skipped,
    rawParams: readRawParams(paramNode),
    paramOrder: paramNode ? (paramNode.children ?? []).map((c) => c.name) : [],
    scoreAttrs: score ? { ...(score.attrs ?? {}) } : {},
    songAttrs: song ? { ...(song.attrs ?? {}) } : {},
    key: null, // 由调用方按 tick 标度填写
    keyRaw: keyNode
      ? {
          clock: Math.round(numAttr(keyNode, 'Clock', 0)),
          fifths: Math.round(numAttr(keyNode, 'Fifths', 0)),
          mode: Math.round(numAttr(keyNode, 'Mode', 0)),
        }
      : null,
    dynamics: findAll(score, 'Dynamics').map((d) => ({
      clock: Math.round(numAttr(d, 'Clock', 0)),
      value: Math.round(numAttr(d, 'Value', 0)),
    })),
    extraScoreChildren: (score?.children ?? [])
      .filter((c) => !['Note', 'Key', 'Dynamics'].includes(c.name))
      .map(plain),
  }
}

/**
 * 读取 CeVIO .ccs
 * @param {Buffer} buffer
 * @param {{name?: string}} opts
 */
export function read(buffer, opts = {}) {
  const text = decodeText(buffer)
  const trimmed = text.trimStart()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    throw new Error('读取 .ccs 失败：文件是 JSON，但 CeVIO 工程为 XML（Scenario/Sequence/Scene/Units）')
  }
  const doc = parseXml(text)
  const scenario = find(doc, 'Scenario')
  if (!scenario) {
    throw new Error('读取 .ccs 失败：未找到 <Scenario> 根元素，不是有效的 CeVIO 工程')
  }
  const sequence = find(scenario, 'Sequence')
  const scene = sequence ? find(sequence, 'Scene') : null
  if (!scene) throw new Error('读取 .ccs 失败：<Scenario> 下缺少 <Sequence>/<Scene>')
  const unitsNode = find(scene, 'Units')
  if (!unitsNode) throw new Error('读取 .ccs 失败：<Scene> 下缺少 <Units>')

  const allUnits = findAll(unitsNode, 'Unit')
  const groupsNode = find(scene, 'Groups')
  const allGroups = groupsNode ? findAll(groupsNode, 'Group') : []
  const castTable = readCastTable(scenario)
  const songUnits = allUnits.filter(isSongUnit)
  const talkUnits = allUnits.filter((u) => !isSongUnit(u))

  const parsed = songUnits.map((unit) => ({ unit, ...readSong(unit) }))

  // 前置空小节长度（CeVIO 第 1 小节固定在 Clock = 一个小节处）
  const firstBeats = parsed.find((p) => p.beats.length)?.beats ?? []
  const firstSig = firstBeats[0] ?? { numerator: 4, denominator: 4 }
  const shift = measureTicksOf(firstSig.numerator, firstSig.denominator)

  let minRawTick = Infinity
  for (const p of parsed) {
    for (const n of p.rawNotes) minRawTick = Math.min(minRawTick, Math.floor(n.clock / CLOCK_PER_TICK))
  }
  // measurePrefix：内容若落在 CeVIO 第 0 小节，则视为弱起
  const measurePrefix = Number.isFinite(minRawTick) ? Math.max(0, Math.ceil(shift - minRawTick)) : 0
  const rawToTick = (clock) => Math.round(clock / CLOCK_PER_TICK) - shift + measurePrefix

  // 速度 / 拍号：取第一个含数据的歌唱轨，其余轨道的差异记入 extras
  const primary = parsed.find((p) => p.tempos.length || p.beats.length)
  const tempos = normalizeTempos(parsed, primary, rawToTick, scene)
  const timeSignatures = normalizeBeats(parsed, primary, rawToTick, scene)

  const tracks = parsed.map((p, i) => {
    const groupId = attrOf(p.unit, 'Group', '')
    const group = allGroups.find((g) => attrOf(g, 'Id', '') === groupId) ?? null
    return buildTrack(p, group, i, tempos, rawToTick, measurePrefix, shift, castTable)
  })

  const name = opts.name ? String(opts.name).replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '') : 'CeVIO 工程'

  const sceneExtras = {}
  for (const child of scene.children ?? []) {
    if (['Units', 'Groups', 'SoundSetting'].includes(child.name)) continue
    sceneExtras[child.name] = plain(child)
  }
  const soundSetting = find(scene, 'SoundSetting')

  return createProject({
    sourceFormat: 'ccs',
    name,
    comment: `CeVIO 工程（Song Version ${parsed.find((p) => p.songAttrs.Version)?.songAttrs.Version ?? '?'}）`,
    tempos,
    timeSignatures,
    measurePrefix,
    tracks: tracks.length ? tracks : [],
    extras: {
      ccs: {
        scenarioCode: attrOf(scenario, 'Code', SCENARIO_CODE),
        sequenceId: attrOf(sequence, 'Id', ''),
        sceneId: attrOf(scene, 'Id', ''),
        generation: plain(find(scenario, 'Generation')),
        activeGroup: groupsNode ? attrOf(groupsNode, 'ActiveGroup', '') : '',
        soundSetting: soundSetting ? { ...(soundSetting.attrs ?? {}) } : {},
        sceneExtras,
        talkUnits: talkUnits.map(plain),
        talkGroups: allGroups.filter((g) => !tracks.some((t) => t.extras.ccs?.groupId === attrOf(g, 'Id', ''))).map(plain),
        castTable,
        preMeasure: collectPreMeasure(parsed, rawToTick),
      },
    },
  })
}

/** 落在第 0 小节（tick <= 0）内的速度/拍号事件，原样保留以便回写参考 */
function collectPreMeasure(parsed, rawToTick) {
  const out = { tempos: [], beats: [] }
  for (const p of parsed) {
    for (const t of p.tempos) {
      if (rawToTick(t.clock) < 0) out.tempos.push({ clock: t.clock, bpm: t.bpm })
    }
    for (const b of p.beats) {
      if (rawToTick(b.clock) < 0) {
        out.beats.push({ clock: b.clock, numerator: b.numerator, denominator: b.denominator })
      }
    }
  }
  return out
}

function normalizeTempos(parsed, primary, rawToTick, scene) {
  const source = primary ?? { tempos: [] }
  let list = source.tempos.map((t) => ({ tick: rawToTick(t.clock), bpm: Number(t.bpm) }))
  list = dedupeByTick(list)
  if (!list.length) {
    const setting = find(scene, 'SoundSetting')
    const bpm = numAttr(setting, 'Tempo', 120) || 120
    return [{ tick: 0, bpm }]
  }
  if (list[list.length - 1].tick < 0) return [{ tick: 0, bpm: list[list.length - 1].bpm }]
  const lastBefore = [...list].reverse().find((t) => t.tick <= 0)
  const after = list.filter((t) => t.tick > 0)
  return [{ tick: 0, bpm: lastBefore ? lastBefore.bpm : after[0].bpm }, ...after]
}

function normalizeBeats(parsed, primary, rawToTick, scene) {
  const source = primary ?? { beats: [] }
  let list = source.beats.map((b) => ({
    tick: rawToTick(b.clock),
    numerator: Number(b.numerator) || 4,
    denominator: Number(b.denominator) || 4,
  }))
  list = dedupeByTick(list)
  if (!list.length) {
    const rhythm = attrOf(find(scene, 'SoundSetting'), 'Rhythm', '4/4') ?? '4/4'
    const m = String(rhythm).match(/^(\d+)\s*\/\s*(\d+)$/)
    return [{ tick: 0, numerator: m ? Number(m[1]) : 4, denominator: m ? Number(m[2]) : 4 }]
  }
  if (list[list.length - 1].tick < 0) return [{ tick: 0, ...pickSig(list[list.length - 1]) }]
  const lastBefore = [...list].reverse().find((t) => t.tick <= 0)
  const after = list.filter((t) => t.tick > 0)
  return [{ tick: 0, ...pickSig(lastBefore ?? after[0]) }, ...after]
}

const pickSig = (t) => ({ numerator: t.numerator, denominator: t.denominator })

function dedupeByTick(list) {
  const sorted = list.slice().sort((a, b) => a.tick - b.tick)
  const out = []
  for (const item of sorted) {
    if (out.length && out[out.length - 1].tick === item.tick) out[out.length - 1] = item
    else out.push(item)
  }
  return out
}

function buildTrack(p, group, index, tempos, rawToTick, measurePrefix, shift, castTable) {
  const unit = p.unit
  const groupAttrs = group ? { ...(group.attrs ?? {}) } : {}
  const unitCastId = attrOf(unit, 'CastId', '') || ''
  const groupCastId = attrOf(group, 'CastId', '') || ''
  const castId = groupCastId || unitCastId
  const singer = castTable[castId] ?? ''
  const rawVolume = group ? Number(attrOf(group, 'Volume', '0')) : 0
  const rawPan = group ? Number(attrOf(group, 'Pan', '0')) : 0

  const notes = p.rawNotes
    .map((n) => {
      const attrs = {}
      for (const key of ['DoReMi', 'Breath', 'Accent', 'Staccato', 'SlurStart', 'SlurStop', 'Syllabic']) {
        const v = attrOf(n.node, key, null)
        if (v !== null && v !== '') attrs[key.charAt(0).toLowerCase() + key.slice(1)] = v
      }
      const phonetic = attrOf(n.node, 'Phonetic', null)
      const note = createNote({
        tick: Math.max(0, rawToTick(n.clock)),
        duration: Math.max(1, Math.round(n.duration / CLOCK_PER_TICK)),
        key: n.key,
        lyric: attrOf(n.node, 'Lyric', '') ?? '',
        phoneme: phonetic ? String(phonetic).replace(/,/g, ' ').trim() : null,
        attributes: attrs,
      })
      if (phonetic) note.attributes.phonetic = phonetic
      return note
    })
    .sort((a, b) => a.tick - b.tick)

  const parameters = {}
  for (const entry of PARAM_MAP) {
    if (entry.tag === 'LogF0') continue
    const raw = p.rawParams[entry.tag]
    if (!raw) continue
    const curve = rawParamToCurve(raw, tempos, entry.scale)
    if (curve.ticks.length) parameters[entry.ir] = curve
  }
  const logRaw = p.rawParams.LogF0
  const pitch = logRaw ? rawParamToCurve(logRaw, tempos, { kind: 'logf0' }) : createCurve()

  const unmapped = {}
  for (const [tag, raw] of Object.entries(p.rawParams)) {
    if (PARAM_TAGS.includes(tag)) continue
    unmapped[tag] = raw
  }

  const extras = {
    ccs: {
      groupId: attrOf(unit, 'Group', ''),
      groupAttrs,
      unitAttrs: { ...(unit.attrs ?? {}) },
      songAttrs: p.songAttrs,
      scoreAttrs: p.scoreAttrs,
      key: p.keyRaw ? { tick: rawToTick(p.keyRaw.clock), fifths: p.keyRaw.fifths, mode: p.keyRaw.mode } : null,
      dynamics: p.dynamics,
      rawParams: p.rawParams,
      unmappedParams: unmapped,
      paramOrder: p.paramOrder,
      castId,
      unitCastId,
      groupCastId,
      rawVolume,
      rawPan,
      startTime: attrOf(unit, 'StartTime', '00:00:00'),
      duration: attrOf(unit, 'Duration', '00:00:02'),
      skippedNotes: p.skipped,
      extraScoreChildren: p.extraScoreChildren,
    },
  }

  const track = createTrack({
    id: `ccs${index + 1}`,
    name: attrOf(group, 'Name', '') || `Track ${index + 1}`,
    singer,
    color: normalizeColor(attrOf(group, 'Color', ''), ''),
    muted: attrOf(group, 'IsMuted', 'false') === 'true',
    solo: attrOf(group, 'IsSolo', 'false') === 'true',
    volume: nativeToUnit(rawVolume, { kind: 'db', ref: VOLUME_REF_NATIVE }),
    pan: clamp(rawPan / 100, -1, 1),
    language: LANG_FROM_CEVIO[String(attrOf(group, 'Language', '') || attrOf(unit, 'Language', '')).toLowerCase()] ?? '',
    notes,
    pitch,
    parameters,
    phonemes: derivePhonemes(notes),
    extras,
  })
  return track
}

/** 由音符的 Phonetic 覆盖推导 IR 音素轨（CeVIO 歌唱轨不存音素时间，按时长均分） */
function derivePhonemes(notes) {
  const out = []
  notes.forEach((note, index) => {
    const symbols = String(note.attributes?.phonetic ?? note.phoneme ?? '')
      .split(/[\s,]+/)
      .filter(Boolean)
    if (!symbols.length) return
    const each = Math.max(1, Math.round(note.duration / symbols.length))
    symbols.forEach((symbol, i) => {
      out.push({
        tick: note.tick + i * each,
        duration: each,
        symbol,
        noteIndex: index,
        extras: { derived: true },
      })
    })
  })
  return out
}

/* ---------------------------------------------------------------- 写出 */

/**
 * 写出以模板为骨架：先把 formats/templates/template.ccs 深拷贝成对象树，再把实际数据填进去，
 * 不再从零拼 XML。
 *
 * 为什么（见 docs/TEMPLATE-REWRITE-BRIEF.md）：模板就是 CeVIO 接受的真实工程骨架，
 * 「结构照抄 + 值替换」让必需节点天然齐全。之前的版本自己拼 XML，漏掉了
 * <Generation><TTS|SVSS><SoundSources><SoundSource Version Id Name>，
 * 而「自己写自己读」的往返自测对这类缺失是瞎的。
 */

const TEMPLATE_FILE = join(dirname(fileURLToPath(import.meta.url)), 'templates', 'template.ccs')

let templateScenarioCache = null

/** 读入模板根元素（首次写出时读盘，之后复用）；读不到就明确报错，而不是静默拼一个残缺工程 */
function loadTemplateScenario() {
  if (!templateScenarioCache) {
    let text
    try {
      text = readFileSync(TEMPLATE_FILE, 'utf8')
    } catch (err) {
      throw new Error(`写出 .ccs 失败：读不到模板 ${TEMPLATE_FILE}（${err?.message ?? err}）`)
    }
    templateScenarioCache = parseXml(text)
  }
  const scenario = find(templateScenarioCache, 'Scenario')
  if (!scenario) throw new Error('写出 .ccs 失败：模板 template.ccs 里找不到根元素 <Scenario>')
  return scenario
}

/** 深拷贝节点：丢掉 parent 引用与元素之间的缩进空白（序列化时会重新缩进） */
function cloneNode(node) {
  return {
    name: node.name,
    attrs: { ...(node.attrs ?? {}) },
    children: (node.children ?? []).map(cloneNode),
    text: String(node.text ?? '').trim(),
    parent: null,
  }
}

function setAttr(node, name, value) {
  if (!node) return node
  node.attrs = { ...(node.attrs ?? {}), [name]: value === undefined || value === null ? '' : String(value) }
  return node
}

/** 就地替换掉骨架里的某个子元素（保持位置） */
function replaceChild(parent, oldChild, newChild) {
  if (!parent || !oldChild) return newChild
  const at = parent.children.indexOf(oldChild)
  newChild.parent = parent
  if (at < 0) parent.children.push(newChild)
  else parent.children.splice(at, 1, newChild)
  return newChild
}

/**
 * 用模板里的「样板元素」克隆出若干个元素，替换掉样板本身并保持它的位置 ——
 * 元素顺序是 CeVIO 的硬要求，必须就地展开而不能追加到末尾。
 * items 为空时等于「删掉样板」。
 */
function stamp(parent, templateChild, items, fill) {
  const list = items ?? []
  if (!parent || !templateChild) {
    // 样板没了还硬写，结果就是静默丢数据（例如整条速度表都没写出去）——宁可报错
    if (list.length) throw new Error('写出 .ccs 失败：模板 template.ccs 里缺少样板元素，无法按模板写出')
    return []
  }
  const at = parent.children.indexOf(templateChild)
  if (at < 0) {
    if (list.length) throw new Error('写出 .ccs 失败：模板骨架里的样板元素不在预期位置，拒绝写出残缺工程')
    return []
  }
  parent.children.splice(at, 1)
  const out = []
  list.forEach((item, index) => {
    const node = cloneNode(templateChild)
    if (fill) fill(node, item, index)
    node.parent = parent
    parent.children.splice(at + index, 0, node)
    out.push(node)
  })
  return out
}

/** 把已经填好数据的元素放到样板的位置上（样板被替换掉） */
function insertSlot(parent, templateChild, nodes) {
  if (!parent || !templateChild) return nodes
  const at = parent.children.indexOf(templateChild)
  if (at < 0) {
    for (const node of nodes) parent.children.push(node)
    return nodes
  }
  parent.children.splice(at, 1, ...nodes)
  return nodes
}

/**
 * <Generation>：模板骨架 + 工程带回来的原生数据。
 *
 * 跨格式转换（工程里没有 ccs 原生数据）时直接用模板 —— 这样 Author/TTS/SVSS 的
 * Dictionary 与 SoundSources/SoundSource 一定齐全，CeVIO 不会因为缺节点拒绝加载。
 * 有原生数据时以原生为准，只把模板里有、原生里没有的容器（Dictionary、SoundSources）补齐；
 * 缺 SoundSources 时补的是空列表，不借用模板里的音源条目，避免凭空多出歌手。
 */
function buildGeneration(tplGen, nativeGen) {
  if (!tplGen) return nativeGen ? fromPlain(nativeGen) : el('Generation')
  if (!nativeGen) return cloneNode(tplGen)
  const out = el('Generation', { ...(nativeGen.attrs ?? {}) })
  for (const tpl of tplGen.children ?? []) {
    const native = find(nativeGen, tpl.name)
    if (!native) {
      out.children.push(cloneNode(tpl))
      continue
    }
    const node = cloneNode(native)
    if (tpl.name === 'TTS' || tpl.name === 'SVSS') {
      if (!find(node, 'Dictionary') && find(tpl, 'Dictionary')) {
        node.children.unshift(cloneNode(find(tpl, 'Dictionary')))
      }
      if (!find(node, 'SoundSources')) node.children.push(el('SoundSources'))
    }
    out.children.push(node)
  }
  // 原生里模板没有的节点也一并带上（不丢数据）
  for (const child of nativeGen.children ?? []) {
    if (!find(out, child.name)) out.children.push(cloneNode(child))
  }
  return out
}

/**
 * 写出 CeVIO .ccs
 * @param {object} project IR 工程
 * @param {{name?: string}} opts
 * @returns {Buffer}
 */
export function write(project, opts = {}) {
  if (!project || !Array.isArray(project.tracks)) {
    throw new Error('写出 .ccs 失败：传入的不是有效 IR 工程（缺少 tracks）')
  }
  const ex = project.extras?.ccs ?? {}
  const castTable = ex.castTable ?? {}

  const tempos = (project.tempos?.length ? project.tempos : [{ tick: 0, bpm: 120 }])
    .slice()
    .sort((a, b) => a.tick - b.tick)
  const beats = (project.timeSignatures?.length ? project.timeSignatures : [{ tick: 0, numerator: 4, denominator: 4 }])
    .slice()
    .sort((a, b) => a.tick - b.tick)
  const measurePrefix = Math.max(0, Math.round(project.measurePrefix ?? 0))
  const shift = measureTicksOf(beats[0].numerator, beats[0].denominator)

  /* --- 骨架：模板深拷贝 --- */
  const scenario = cloneNode(loadTemplateScenario())
  setAttr(scenario, 'Code', ex.scenarioCode || SCENARIO_CODE)

  const tplGen = find(scenario, 'Generation')
  replaceChild(scenario, tplGen, buildGeneration(tplGen, ex.generation))

  const sequence = find(scenario, 'Sequence')
  setAttr(sequence, 'Id', ex.sequenceId ?? '')
  const scene = find(sequence, 'Scene')
  setAttr(scene, 'Id', ex.sceneId ?? '')

  const unitsNode = find(scene, 'Units')
  const groupsNode = find(scene, 'Groups')
  if (ex.activeGroup) setAttr(groupsNode, 'ActiveGroup', ex.activeGroup)

  const tplUnit = find(unitsNode, 'Unit')
  const tplGroup = find(groupsNode, 'Group')
  const units = []
  const groups = []
  if ((!tplUnit || !tplGroup) && project.tracks.length) {
    throw new Error('写出 .ccs 失败：模板 template.ccs 里缺少 <Unit>/<Group> 样板，无法按模板写出')
  }
  // 没有任何轨道时也留一个空歌唱轨：CeVIO 不接受空的 Units/Groups，
  // 而且这样写出的文件读回来是「一条空轨道」而不是「工程损坏」。
  const tracks = project.tracks.length ? project.tracks : [{ name: 'Track 1', notes: [] }]

  /* --- 每轨一个 <Unit>（歌唱轨）与一个 <Group> --- */
  tracks.forEach((track, index) => {
    const tx = track.extras?.ccs ?? {}
    const groupId = tx.groupId || randomUUID()
    const unitCastId = tx.unitCastId || ''
    const castId = castIdForSinger(track.singer, tx.castId || unitCastId, castTable)
    const language = langToCevio(track.language)

    /* Unit：模板里已经带好 Song/Tempo/Beat/Score/Key 骨架 */
    const unit = cloneNode(tplUnit)
    setAttr(unit, 'Version', tx.unitAttrs?.Version || DEFAULT_UNIT_VERSION)
    setAttr(unit, 'Id', '')
    setAttr(unit, 'Category', 'SingerSong')
    setAttr(unit, 'Group', groupId)
    setAttr(unit, 'StartTime', tx.startTime || '00:00:00')
    setAttr(unit, 'Duration', tx.duration || '00:00:02')
    setAttr(unit, 'CastId', castId)
    setAttr(unit, 'Language', language)

    const song = find(unit, 'Song')
    setAttr(song, 'Version', tx.songAttrs?.Version || DEFAULT_SONG_VERSION)

    const tempoNode = find(song, 'Tempo')
    stamp(tempoNode, find(tempoNode, 'Sound'), tempos, (node, tempo, i) => {
      setAttr(node, 'Clock', clockOfTick(tempo.tick, measurePrefix, shift, i === 0))
      setAttr(node, 'Tempo', Number(tempo.bpm).toFixed(2))
    })

    const beatNode = find(song, 'Beat')
    stamp(beatNode, find(beatNode, 'Time'), beats, (node, beat, i) => {
      setAttr(node, 'Clock', clockOfTick(beat.tick, measurePrefix, shift, i === 0))
      setAttr(node, 'Beats', beat.numerator)
      setAttr(node, 'BeatType', beat.denominator)
    })

    const score = find(song, 'Score')
    const keyNode = find(score, 'Key')
    const key = tx.key
    setAttr(keyNode, 'Clock', key ? clockOfTick(key.tick ?? 0, measurePrefix, shift, false) : 0)
    setAttr(keyNode, 'Fifths', key ? key.fifths : 0)
    setAttr(keyNode, 'Mode', key ? key.mode : 0)

    for (const d of tx.dynamics ?? []) {
      score.children.push(el('Dynamics', { Clock: String(Math.max(0, Math.round(d.clock / CLOCK_PER_TICK))), Value: String(d.value) }))
    }

    const notes = (track.notes ?? []).slice().sort((a, b) => a.tick - b.tick)
    const phonemeByNote = groupPhonemes(track)
    notes.forEach((note, noteIndex) => {
      const src = note.attributes ?? {}
      const attrs = {
        Clock: String(Math.round((note.tick - measurePrefix + shift) * CLOCK_PER_TICK)),
        PitchStep: String(((note.key % 12) + 12) % 12),
        PitchOctave: String(Math.floor(note.key / 12) - 1),
        Duration: String(Math.max(1, Math.round(note.duration * CLOCK_PER_TICK))),
        Lyric: note.lyric ?? '',
      }
      for (const flag of ['doReMi', 'breath', 'accent', 'staccato', 'slurStart', 'slurStop', 'syllabic']) {
        if (src[flag] !== undefined && src[flag] !== null && src[flag] !== '') attrs[cap(flag)] = String(src[flag])
      }
      const phonetic = src.phonetic ?? phonemeByNote.get(noteIndex) ?? phonemeOverrideOf(note)
      if (phonetic) attrs.Phonetic = String(phonetic)
      score.children.push(el('Note', attrs))
    })
    for (const extra of tx.extraScoreChildren ?? []) score.children.push(fromPlain(extra))

    const scoreAttrs = { ...(tx.scoreAttrs ?? {}) }
    for (const name of Object.keys(scoreAttrs)) {
      if (EMOTION_ATTRS.includes(name) && String(scoreAttrs[name]).trim() === '') delete scoreAttrs[name]
    }
    score.attrs = { ...scoreAttrs }

    const paramChildren = buildParams(track, tx, tempos)
    if (paramChildren.length) song.children.push(el('Parameter', null, paramChildren))

    units.push(unit)

    /* Group：与 Unit 用同一个 Group Id 配对 */
    const group = cloneNode(tplGroup)
    setAttr(group, 'Version', tx.groupAttrs?.Version || DEFAULT_UNIT_VERSION)
    setAttr(group, 'Id', groupId)
    setAttr(group, 'Category', 'SingerSong')
    setAttr(group, 'Name', track.name ?? `Track ${index + 1}`)
    setAttr(group, 'Color', hexToCevioColor(track.color))
    setAttr(group, 'Volume', String(preferRawNumber(track.volume, tx.rawVolume, (v) => nativeToUnit(v, { kind: 'db', ref: VOLUME_REF_NATIVE }), (v) => unitToNative(v, { kind: 'db', ref: VOLUME_REF_NATIVE }), 0)))
    setAttr(group, 'Pan', String(preferRawNumber(track.pan, tx.rawPan, (v) => clamp(v / 100, -1, 1), (v) => clamp(v, -1, 1) * 100, 0)))
    setAttr(group, 'IsSolo', track.solo ? 'true' : 'false')
    setAttr(group, 'IsMuted', track.muted ? 'true' : 'false')
    setAttr(group, 'CastId', castId)
    setAttr(group, 'Language', language)
    groups.push(group)
  })

  insertSlot(unitsNode, tplUnit, units)
  insertSlot(groupsNode, tplGroup, groups)

  /* --- 对白轨等未转换内容原样保留 --- */
  for (const u of ex.talkUnits ?? []) unitsNode.children.push(fromPlain(u))
  for (const g of ex.talkGroups ?? []) groupsNode.children.push(fromPlain(g))

  const soundSetting = find(scene, 'SoundSetting')
  setAttr(soundSetting, 'Rhythm', `${beats[0].numerator}/${beats[0].denominator}`)
  setAttr(soundSetting, 'Tempo', Math.round(tempos[0].bpm))
  setAttr(soundSetting, 'MasterVolume', ex.soundSetting?.MasterVolume ?? '0')

  for (const extra of Object.values(ex.sceneExtras ?? {})) scene.children.push(fromPlain(extra))

  const xml = `<?xml version="1.0" encoding="utf-8"?>\n${buildXml(scenario, { declaration: false })}`
  return Buffer.from(xml, 'utf8')
}

/** 把原始曲线数据原样写成 <Tag Length><Data/NoData> */
function rawParamNode(tag, raw) {
  const children = (raw.items ?? []).map(([index, repeat, value]) => {
    const attrs = { Index: String(index) }
    if (repeat > 1) attrs.Repeat = String(repeat)
    if (value === null || !Number.isFinite(value)) return el('NoData', attrs)
    return el('Data', attrs, null, String(value))
  })
  return el(tag, { Length: String(raw.length ?? 0) }, children)
}

/** 从 IR 曲线生成 <Tag Length><Data/></Tag> */
function curveParamNode(tag, curve, tempos, scale) {
  const items = []
  for (let i = 0; i < curve.ticks.length; i += 1) {
    const index = Math.max(0, Math.round(tickToSec(curve.ticks[i], tempos) / PARAM_STEP_SEC))
    const value = unitToNative(curve.values[i], scale)
    const last = items[items.length - 1]
    if (last && index <= last[0]) last[2] = value
    else items.push([index, 1, value])
  }
  if (!items.length) return null
  const last = items[items.length - 1]
  const children = items.map(([index, repeat, value]) => {
    const attrs = { Index: String(index) }
    if (repeat > 1) attrs.Repeat = String(repeat)
    return el('Data', attrs, null, fmtNum(value))
  })
  return el(tag, { Length: String(last[0] + last[1] + PARAM_PADDING_UNITS) }, children)
}

/** 比较 IR 曲线与原始曲线是否一致（一致则原样回写，保留 NoData 与原始精度） */
function curvesEquivalent(curve, raw, tempos, scale) {
  if (!raw || !curve || !curve.ticks.length) return false
  const decoded = rawParamToCurve(raw, tempos, scale)
  if (decoded.ticks.length !== curve.ticks.length) return false
  for (let i = 0; i < decoded.ticks.length; i += 1) {
    if (decoded.ticks[i] !== curve.ticks[i]) return false
    if (Math.abs(decoded.values[i] - curve.values[i]) > 1e-9) return false
  }
  return true
}

function langToCevio(language) {
  return LANG_TO_CEVIO[String(language ?? '').toLowerCase()] ?? 'Japanese'
}

function castIdForSinger(singer, castId, castTable) {
  if (castId) return castId
  const name = String(singer ?? '').trim()
  if (name) {
    for (const [id, castName] of Object.entries(castTable ?? {})) {
      if (castName === name) return id
    }
  }
  return '' // 留空时 CeVIO 会自动选择音源
}

function hexToCevioColor(color) {
  const normalized = normalizeColor(color, '')
  if (!normalized) return '#FFAF1F14'
  return `#FF${normalized.slice(1).toUpperCase()}`
}

/** 首个事件写在小节前缀（Clock=0），其余按绝对位置换算 */
function clockOfTick(tick, measurePrefix, shift, isFirst) {
  if (isFirst) return 0
  return Math.round((tick - measurePrefix + shift) * CLOCK_PER_TICK)
}

function cap(name) {
  return name.charAt(0).toUpperCase() + name.slice(1)
}

/** 按 noteIndex 聚合音素轨，得到 "a,b,c" 形式的 Phonetic 覆盖 */
function groupPhonemes(track) {
  const map = new Map()
  for (const p of track.phonemes ?? []) {
    if (!p || p.noteIndex === undefined || p.noteIndex === null || p.noteIndex < 0) continue
    const list = map.get(p.noteIndex) ?? []
    list.push(p)
    map.set(p.noteIndex, list)
  }
  const out = new Map()
  for (const [noteIndex, list] of map) {
    list.sort((a, b) => a.tick - b.tick)
    const symbols = list.map((p) => p.symbol).filter(Boolean)
    if (symbols.length) out.set(noteIndex, symbols.join(','))
  }
  return out
}

function phonemeOverrideOf(note) {
  const value = note.phoneme
  if (!value) return null
  return String(value).trim().replace(/[\s,]+/g, ',')
}

/** 若 IR 值与原始值解码结果一致则复用原始值，否则按 IR 重新编码 */
function preferRawNumber(irValue, rawValue, decode, encode, fallback) {
  if (Number.isFinite(rawValue) && Number.isFinite(decode(rawValue)) && Math.abs(decode(rawValue) - irValue) < 1e-9) {
    return fmtNum(rawValue)
  }
  if (Number.isFinite(irValue)) return fmtNum(encode(irValue))
  if (Number.isFinite(rawValue)) return fmtNum(rawValue)
  return String(fallback)
}

function buildParams(track, tx, tempos) {
  const out = []
  const rawParams = tx.rawParams ?? {}
  const order = []
  for (const tag of tx.paramOrder ?? []) if (!order.includes(tag)) order.push(tag)
  for (const tag of PARAM_TAGS) if (rawParams[tag] && !order.includes(tag)) order.push(tag)
  for (const tag of Object.keys(rawParams)) if (!order.includes(tag)) order.push(tag)

  const emitted = new Set()
  for (const tag of order) {
    const entry = PARAM_MAP.find((p) => p.tag === tag)
    if (!entry) {
      if (rawParams[tag]) {
        out.push(rawParamNode(tag, rawParams[tag]))
        emitted.add(tag)
      }
      continue
    }
    const curve = entry.tag === 'LogF0' ? track.pitch : track.parameters?.[entry.ir]
    const raw = rawParams[tag]
    if (raw && curve && curvesEquivalent(curve, raw, tempos, entry.scale)) {
      out.push(rawParamNode(tag, raw))
      emitted.add(tag)
      continue
    }
    if (curve && curve.ticks?.length) {
      const node = curveParamNode(tag, curve, tempos, entry.scale)
      if (node) {
        out.push(node)
        emitted.add(tag)
      }
      continue
    }
    if (raw) {
      out.push(rawParamNode(tag, raw))
      emitted.add(tag)
    }
  }
  // 工程没有原始数据、但 IR 带曲线时补上
  if (!emitted.has('LogF0') && track.pitch?.ticks?.length) {
    const node = curveParamNode('LogF0', track.pitch, tempos, { kind: 'logf0' })
    if (node) out.push(node)
  }
  for (const entry of PARAM_MAP) {
    if (entry.tag === 'LogF0' || emitted.has(entry.tag)) continue
    const curve = track.parameters?.[entry.ir]
    if (curve && curve.ticks?.length) {
      const node = curveParamNode(entry.tag, curve, tempos, entry.scale)
      if (node) out.push(node)
    }
  }
  return out
}

export default { meta, fidelity, read, write }
