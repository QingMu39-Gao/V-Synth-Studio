/**
 * VOCALOID3 / VOCALOID4 工程（.vsqx）
 *
 * 结构与字段名依据本机安装的官方 schema（只读查阅）：
 *   H:\VOCALOID6\Editor\vsq3.xsd   （VOCALOID3，根节点 <vsq3>）
 *   H:\VOCALOID6\Editor\vsq4.xsd   （VOCALOID4，根节点 <vsq4>）
 * 并用真实工程样本 tests/samples/real-sample-1.vsqx(v3)、real-sample-2.vsqx(v4) 验证读取。
 *
 * 两代标签名不同，本模块统一用标签表 TAGS 描述，读写共用同一份定义：
 *
 *   概念          vsq3（VOCALOID3）          vsq4（VOCALOID4）
 *   ---------------------------------------------------------------------
 *   分辨率        resolution                 resolution
 *   前导小节      preMeasure                 preMeasure
 *   拍号          posMes/nume/denomi         m/nu/de
 *   速度          posTick/bpm                t/v        （bpm × 100 的整数）
 *   歌手轨道      vsTrack / musicalPart      vsTrack / vsPart
 *   控制曲线      mCtrl + attr               cc + v
 *   音符          posTick/durTick/noteNum/   t/dur/n/v/y/p/nStyle
 *                 velocity/lyric/phnms/noteStyle
 *   音符样式      noteStyle / attr           nStyle / v
 *   颤音序列      seqAttr/elem/posNrm/elv    seq/cc(p,v)
 *   风格插件      stylePlugin                sPlug
 *   风格参数      partStyle / attr           pStyle / v
 *   波形轨道      seTrack / karaokeTrack     monoTrack / stTrack
 *
 * 关键换算（详见对应函数注释）：
 *   - 时间：文件 tick = IR tick + 前导小节对应的 tick 偏移；resolution 非 480 时按比例缩放。
 *   - 速度：<bpm>/<v> 是 bpm × 100 的整数（12000 → 120.00 BPM）。
 *   - 音高：文件里的音高是「绝对音高」曲线，由两条控制曲线共同表达：
 *         cc id="P"（v3 为 PIT，取值 −8191..8191，0 = 不弯音）
 *         cc id="S"（v3 为 PBS，半音灵敏度，缺省 2）
 *     半音偏差 = PIT / 8191 × PBS；基线取「该 tick 处正在发声的音符 key」。
 *
 * 写出采用「模板填充」：深拷贝 formats/templates/template.vsqx，再把数据填进去
 * （vsq3 变体由同一模板改名得到，见 V3_RENAME），不再从零拼 XML。
 *
 * 本模块的结构与默认值参照 UtaFormatix3（sdercolin, Apache-2.0）实现，见 docs/reference/utaformatix3/
 */

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
  clamp,
} from '../ir.mjs'
import { parseXml, findAll, find, el, push, decodeEntities } from '../../util/xml.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const meta = {
  id: 'vsqx',
  name: 'VOCALOID3/4 工程',
  vendor: 'Yamaha',
  exts: ['.vsqx'],
  kind: 'xml',
  canRead: true,
  canWrite: true,
  writeExt: '.vsqx',
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
    'multiTrack',
    'params.dynamics',
    'params.breathiness',
    'params.brightness',
    'params.clearness',
    'params.gender',
    'params.opening',
    'params.portamento',
    'trackName',
    'singer',
    'muted',
    'solo',
    'trackVolume',
    'trackPan',
    'velocity',
  ],
  drops: [
    '颤音 DEPTH/RATE 的绝对物理量：VOCALOID 未公开 vibDep/vibRate 与音分/Hz 的换算表，读入时按原生整数值给出近似量，原生结构完整保留在 note.attributes.nStyle.vibrato',
    '段落级 VOCALOID2 兼容演唱风格参数（accent/decay/bendDep/bendLen/fallPort/risePort）—— 原样保留在 track.extras.vsqx.partStyles',
    '歌手音色库 compID 与 vVoice 参数（bre/bri/cle/gen/ope）—— 表整体保留在 project.extras.vsqx.voiceTable',
    '波形轨道（seTrack / monoTrack / stTrack）与 aux 段内容',
    '整条「音素时间轴」：VSQX 的音素是逐音符的 <p> 覆盖，能带着走；但 IR 里独立于音符的音素时间轴（track.phonemes）没有对应结构，跨格式转换时不会保留',
  ],
  notes:
    'VOCALOID3/4 原生工程：音符、歌词、音符级音素覆盖、绝对音高曲线、速度/拍号与常用参数曲线均可双向映射；' +
    '颤音的 DEPTH/RATE 与其它格式之间只能近似换算（原生值随工程保留）。' +
    '音符的演唱风格参数（<nStyle>/<noteStyle>）按模板写全 9 格：读入的原生值优先回写，源工程里没有的格子用模板默认值，' +
    '因此任何来源的工程写出的 VSQX 都带完整 nStyle。',
}

/* --------------------------------------------------------------- 标签表 */

/** V4 用短标签，V3 用长标签；只列有差异的项 */
const TAGS = {
  vsq4: {
    ns: 'http://www.yamaha.co.jp/vocaloid/schema/vsq4/',
    root: 'vsq4',
    xsd: 'http://www.yamaha.co.jp/vocaloid/schema/vsq4/ vsq4.xsd',
    rootVersion: '4.0.0.3',
    voice: { bs: 'bs', pc: 'pc', id: 'id', name: 'name', prm: 'vPrm' },
    timeSig: { pos: 'm', nume: 'nu', denomi: 'de' },
    tempo: { pos: 't', bpm: 'v' },
    track: { no: 'tNo', name: 'name', comment: 'comment', part: 'vsPart' },
    partTag: 'vsPart',
    part: {
      t: 't',
      playTime: 'playTime',
      name: 'name',
      comment: 'comment',
      plug: 'sPlug',
      style: 'pStyle',
      singer: 'singer',
      cc: 'cc',
      note: 'note',
      plane: 'plane',
    },
    cc: { pos: 't', value: 'v' },
    note: {
      t: 't',
      dur: 'dur',
      n: 'n',
      v: 'v',
      y: 'y',
      p: 'p',
      style: 'nStyle',
      styleAttr: 'v',
      seq: 'seq',
      seqItem: 'cc',
      seqPos: 'p',
      seqValue: 'v',
    },
    ccIds: {
      pitch: 'P',
      pitchSens: 'S',
      dynamics: 'DYN',
      breathiness: 'BRE',
      brightness: 'BRI',
      clearness: 'CLE',
      gender: 'GEN',
      opening: 'OPE',
      harmonics: 'HAR',
      tension: 'TEN',
      voicing: 'VOI',
      growl: 'GRO',
      roughness: 'ROU',
      mouth: 'MOU',
      portamento: 'POR',
      velocity: 'VEL',
      vibratoDepth: 'VIB',
      vibratoRate: 'VIBS',
      vibratoDelay: 'VIBD',
    },
    vibe: { len: 'vibLen', type: 'vibType', dep: 'vibDep', rate: 'vibRate' },
    vibratoSeqId: 'vibrato',
    // 风格插件：v4 用短标签，v3 用 stylePluginID / stylePluginName
    plug: { id: 'id', name: 'name', version: 'version' },
    /**
     * mixer 子元素名。两代标签名不同，但结构同形：
     *   masterUnit(outDev/retLevel/vol) + 每轨 vsUnit + 一条音频轨 + 一条伴奏轨
     *   v3 的音频轨叫 seUnit、伴奏轨叫 karaokeUnit；v4 叫 monoUnit / stUnit
     */
    mixer: {
      master: { outDev: 'oDev', retLevel: 'rLvl', vol: 'vol' },
      unit: {
        no: 'tNo',
        inGain: 'iGin',
        sendLevel: 'sLvl',
        sendEnable: 'sEnable',
        mute: 'm',
        solo: 's',
        pan: 'pan',
        vol: 'vol',
      },
      monoTag: 'monoUnit',
      stTag: 'stUnit',
    },
    mono: 'monoTrack',
    st: 'stTrack',
    aux: { id: 'id', content: 'content' },
  },
  vsq3: {
    ns: 'http://www.yamaha.co.jp/vocaloid/schema/vsq3/',
    root: 'vsq3',
    xsd: 'http://www.yamaha.co.jp/vocaloid/schema/vsq3/ vsq3.xsd',
    rootVersion: '3.0.0.11',
    voice: { bs: 'vBS', pc: 'vPC', id: 'compID', name: 'vVoiceName', prm: 'vVoiceParam' },
    timeSig: { pos: 'posMes', nume: 'nume', denomi: 'denomi' },
    tempo: { pos: 'posTick', bpm: 'bpm' },
    track: { no: 'vsTrackNo', name: 'trackName', comment: 'comment', part: 'musicalPart' },
    partTag: 'musicalPart',
    part: {
      t: 'posTick',
      playTime: 'playTime',
      name: 'partName',
      comment: 'comment',
      plug: 'stylePlugin',
      style: 'partStyle',
      singer: 'singer',
      cc: 'mCtrl',
      note: 'note',
      plane: 'plane',
    },
    cc: { pos: 'posTick', value: 'attr' },
    note: {
      t: 'posTick',
      dur: 'durTick',
      n: 'noteNum',
      v: 'velocity',
      y: 'lyric',
      p: 'phnms',
      style: 'noteStyle',
      styleAttr: 'attr',
      seq: 'seqAttr',
      seqItem: 'elem',
      seqPos: 'posNrm',
      seqValue: 'elv',
    },
    ccIds: {
      pitch: 'PIT',
      pitchSens: 'PBS',
      dynamics: 'DYN',
      breathiness: 'BRE',
      brightness: 'BRI',
      clearness: 'CLE',
      gender: 'GEN',
      opening: 'OPE',
      harmonics: 'HAR',
      tension: 'TEN',
      voicing: 'VOI',
      growl: 'GRO',
      roughness: 'ROU',
      mouth: 'MOU',
      portamento: 'POR',
      velocity: 'VEL',
      vibratoDepth: 'VIB',
      vibratoRate: 'VIBS',
      vibratoDelay: 'VIBD',
    },
    vibe: { len: 'vibLen', type: 'vibType', dep: 'vibDep', rate: 'vibRate' },
    vibratoSeqId: 'vibrato',
    // 风格插件：v3 用 stylePluginID / stylePluginName（v4 的 id/name 见 TAGS.vsq4）
    plug: { id: 'stylePluginID', name: 'stylePluginName', version: 'version' },
    mixer: {
      master: { outDev: 'outDev', retLevel: 'retLevel', vol: 'vol' },
      unit: {
        no: 'vsTrackNo',
        inGain: 'inGain',
        sendLevel: 'sendLevel',
        sendEnable: 'sendEnable',
        mute: 'mute',
        solo: 'solo',
        pan: 'pan',
        vol: 'vol',
      },
      monoTag: 'seUnit',
      stTag: 'karaokeUnit',
    },
    mono: 'seTrack',
    st: 'karaokeTrack',
    aux: { id: 'auxID', content: 'content' },
  },
}

/** 段落级控制曲线 id -> IR 规范参数名。max=127 时直接取整数值，max=1 时归一化到 0..1 */
const CC_TO_PARAM = [
  ['dynamics', 'dynamics', 127],
  ['breathiness', 'breathiness', 127],
  ['brightness', 'brightness', 127],
  ['clearness', 'clearness', 127],
  ['gender', 'gender', 127],
  ['opening', 'opening', 127],
  ['harmonics', 'harmonics', 127],
  ['tension', 'tension', 127],
  ['voicing', 'voicing', 127],
  ['growl', 'growl', 127],
  ['roughness', 'roughness', 127],
  ['mouth', 'mouth', 127],
  ['portamento', 'portamento', 127],
  ['vibratoDepth', 'vibratoDepth', 127],
  ['vibratoRate', 'vibratoRate', 127],
  ['vibratoDelay', 'vibratoDelay', 127],
]

/** 音符级样式标量 id（无 IR 对应，原样搬运到 attributes.nStyle） */
const NOTE_STYLE_IDS = ['accent', 'decay', 'bendDep', 'bendLen', 'fallPort', 'risePort', 'opening']

/** PIT 满量程（14bit 有符号） */
const PIT_FULL = 8191
/** VOCALOID 默认音高弯曲灵敏度（半音） */
const DEFAULT_PBS = 2
/** 曲线分段的最小间隔（tick）：超过它则重发一次 PBS */
const PIT_SECTION_GAP = 480
/** 颤音序列 posNrm 的定点满量程（0x7fffffff = 音符末尾） */
const POS_NRM_FULL = 0x7fffffff

/* --------------------------------------------------------------- 基础工具 */

function toBuffer(buffer) {
  if (Buffer.isBuffer(buffer)) return buffer
  if (buffer instanceof ArrayBuffer) return Buffer.from(buffer)
  if (ArrayBuffer.isView(buffer)) return Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  if (typeof buffer === 'string') return Buffer.from(buffer, 'utf8')
  throw new Error('vsqx：无法识别的输入类型，期望 Buffer')
}

/** 解码文本：VSQX 规定 UTF-8，非 UTF-8 时回退（部分工具会写本地编码） */
function decodeText(buf) {
  const utf8 = buf.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  for (const enc of ['utf-16le', 'shift-jis']) {
    try {
      const alt = new TextDecoder(enc).decode(buf)
      if (!alt.includes('\uFFFD')) return alt
    } catch {
      /* 编码不可用则继续 */
    }
  }
  return utf8
}

/** 元素文本（含 CDATA），去首尾空白 */
function rawText(node, fallback = '') {
  if (!node) return fallback
  return decodeEntities(String(node.text ?? '')).trim()
}

function numOf(node, fallback = 0) {
  const t = rawText(node, '')
  if (t === '') return fallback
  const v = Number(t)
  return Number.isFinite(v) ? v : fallback
}

function intOf(node, fallback = null) {
  const t = rawText(node, '')
  if (t === '') return fallback
  const v = parseInt(t, 10)
  return Number.isFinite(v) ? v : fallback
}

function simple(name, value) {
  return el(name, null, null, value === undefined || value === null ? '' : String(value))
}

/** 建一个带文本的子元素（颤音序列的 p/v 用得到） */
function childEl(parent, name, value) {
  return push(parent, simple(name, value))
}

/* ------------------------------------------------------- 小节 / tick 换算 */

function measureTicks(numerator, denominator) {
  return Math.round(((TPQ * 4) / (denominator || 4)) * (numerator || 4))
}

/** 规范拍号表（首项 tick=0，按 tick 升序，去重） */
function normSigs(timeSignatures) {
  const list = (timeSignatures ?? [])
    .filter((t) => t && Number.isFinite(t.tick))
    .map((t) => ({
      tick: Math.max(0, Math.round(t.tick)),
      numerator: t.numerator || 4,
      denominator: t.denominator || 4,
    }))
    .sort((a, b) => a.tick - b.tick)
  const out = []
  for (const ts of list) {
    const prev = out[out.length - 1]
    if (prev && prev.tick === ts.tick) out[out.length - 1] = ts
    else out.push(ts)
  }
  if (!out.length) out.push({ tick: 0, numerator: 4, denominator: 4 })
  if (out[0].tick !== 0) out.unshift({ tick: 0, numerator: out[0].numerator, denominator: out[0].denominator })
  return out
}

/**
 * 以「小节号」为时间轴的小节长度表 -> 绝对 tick。
 * sigs 中 tick 字段表示小节号；第 0 小节之前缺省 4/4。
 * 拍号在文件里天然按小节对齐，因此逐个整小节累加即可。
 */
function measureNoToTick(measureNo, sigs) {
  const list = sigs
  const target = Math.max(0, Math.round(measureNo))
  let m = 0
  let tick = 0
  let guard = 0
  while (m < target && guard < 500000) {
    let cur = { numerator: 4, denominator: 4 }
    for (const s of list) {
      if (s.tick <= m) cur = s
      else break
    }
    let mt = measureTicks(cur.numerator, cur.denominator)
    if (mt <= 0) mt = measureTicks(4, 4)
    tick += mt
    m += 1
    guard += 1
  }
  return tick
}

/** 绝对 tick -> 小节号（向下取整）；sigs 以 tick 为单位 */
function tickToMeasureNo(tick, sigs) {
  const list = sigs
  const target = Math.max(0, Math.round(tick))
  let m = 0
  let start = 0
  let guard = 0
  while (guard < 500000) {
    let cur = { numerator: 4, denominator: 4 }
    for (const s of list) {
      if (s.tick <= start) cur = s
      else break
    }
    const next = list.find((s) => s.tick > start)
    let mt = measureTicks(cur.numerator, cur.denominator)
    if (next && next.tick < start + mt) mt = next.tick - start
    if (mt <= 0) mt = measureTicks(4, 4)
    if (target < start + mt) return m
    start += mt
    m += 1
    guard += 1
  }
  return m
}

/**
 * 「文件小节 -> 文件 tick」（读入侧专用，先用文件自带拍号建立时间轴）。
 * sigs 里 tick 字段是小节号；第 0 小节之前缺省 4/4。
 */
function fileMeasureToTickRaw(measure, rawSigs) {
  return Math.round(measureNoToTick(Math.max(0, Math.round(measure)), rawSigs))
}

/** tick 落在第几个小节（0 基，按 4/4 计） */
function measureIndexOfTick(tick) {
  return Math.max(0, Math.floor(Math.max(0, Math.round(tick)) / (TPQ * 4)))
}

/**
 * 唯一的时间轴换算入口（读 / 写共用，避免两侧口径不一致）。
 *
 * 坐标定义：
 *   - 「文件小节」就是文件里 <m>/<posMes> 写的那个小节号，文件第 0 小节起点 = file tick 0。
 *   - IR tick 0 对齐到文件里第 (preMeasure-1) 个小节。
 *
 * @param {number} prefixTick IR tick 0 在文件里的 tick 位置
 * @param {Array} sigs 以 IR tick 计位的拍号表（首项 tick = 0）
 */
function buildTimeline(prefixTick, timeSignatures, preMeasure) {
  const sigs = normSigs(timeSignatures)
  const irTickToFile = (irTick) => Math.max(0, Math.round(irTick)) + prefixTick
  const fileTickToIr = (fileTick) => Math.max(0, Math.round(fileTick) - prefixTick)
  const fileMeasureToDerived = (measure) => Math.round(measure) - (preMeasure - 1)
  const irTickToFileMeasure = (irTick) => tickToMeasureNo(Math.max(0, Math.round(irTick)), sigs) + (preMeasure - 1)
  return { sigs, prefixTick, irTickToFile, fileTickToIr, fileMeasureToDerived, irTickToFileMeasure }
}

/* ------------------------------------------------------------------ 读取 */

export function read(buffer, opts = {}) {
  const buf = toBuffer(buffer)
  const doc = safeParse(decodeText(buf))
  const root = findAll(doc, 'vsq4')[0] ?? findAll(doc, 'vsq3')[0]
  if (!root) {
    throw new Error('vsqx：未找到根节点 <vsq4> 或 <vsq3>，可能不是 VOCALOID3/4 的工程文件')
  }
  const T = detectVariant(root)
  if (!T) {
    throw new Error('vsqx：根节点命名空间不是 VOCALOID 的 vsq3/vsq4 schema，无法识别')
  }

  const master = find(root, 'masterTrack')
  if (!master) throw new Error('vsqx：缺少 <masterTrack>，文件不完整')

  const voiceTable = readVoiceTable(root, T)
  const resolution = intOf(find(master, 'resolution'), TPQ) || TPQ
  const scale = TPQ / resolution
  const preMeasure = intOf(find(master, 'preMeasure'), 0) ?? 0
  const seqName = rawText(find(master, 'seqName'), '')
  const comment = rawText(find(master, 'comment'), '')

  /* ---- 拍号（文件里以小节号定位） ---- */
  const rawSigs = []
  for (const node of findAll(master, 'timeSig')) {
    const pos = intOf(find(node, T.timeSig.pos), null)
    const numerator = intOf(find(node, T.timeSig.nume), null)
    const denominator = intOf(find(node, T.timeSig.denomi), null)
    if (pos === null || !numerator || !denominator) continue
    rawSigs.push({ measure: pos, numerator, denominator })
  }
  if (!rawSigs.length) rawSigs.push({ measure: 0, numerator: 4, denominator: 4 })
  rawSigs.sort((a, b) => a.measure - b.measure)

  // 文件小节坐标下的拍号表（tick 字段 = 小节号），用于建立文件时间轴
  const fileSigs = []
  for (const s of rawSigs) {
    const last = fileSigs[fileSigs.length - 1]
    if (last && last.tick === s.measure) {
      last.numerator = s.numerator
      last.denominator = s.denominator
    } else {
      fileSigs.push({ tick: s.measure, numerator: s.numerator, denominator: s.denominator })
    }
  }
  // IR tick 0 对齐到「前导小节」之后的第一个小节线。
  // 前导小节按 4/4 计长（VOCALOID 各版本的 preMeasure 使用的都是固定小节长度），
  // 读写两侧共用同一算法，保证往返一致。
  const prefixTick = fileMeasureToTickRaw(Math.max(0, preMeasure - 1), [{ tick: 0, numerator: 4, denominator: 4 }])
  // 文件小节 -> IR tick
  const measureToIrTick = (measure) => Math.max(0, fileMeasureToTickRaw(measure, fileSigs) - prefixTick)

  const timeSignatures = []
  for (const s of rawSigs) {
    const tick = measureToIrTick(s.measure)
    const prev = timeSignatures[timeSignatures.length - 1]
    const item = { tick, numerator: s.numerator, denominator: s.denominator }
    if (prev && prev.tick === tick) timeSignatures[timeSignatures.length - 1] = item
    else timeSignatures.push(item)
  }
  if (!timeSignatures.length) timeSignatures.push({ tick: 0, numerator: 4, denominator: 4 })
  if (timeSignatures[0].tick !== 0) {
    timeSignatures.unshift({ tick: 0, numerator: timeSignatures[0].numerator, denominator: timeSignatures[0].denominator })
  }
  const timeline = buildTimeline(prefixTick, timeSignatures, preMeasure)

  /* ---- 速度（bpm 是 ×100 的整数） ---- */
  const tempos = []
  for (const node of findAll(master, 'tempo')) {
    const pos = intOf(find(node, T.tempo.pos), null)
    const bpmRaw = intOf(find(node, T.tempo.bpm), null)
    if (pos === null || bpmRaw === null || bpmRaw <= 0) continue
    tempos.push({ tick: Math.max(0, Math.round(pos * scale) - prefixTick), bpm: bpmRaw / 100 })
  }
  tempos.sort((a, b) => a.tick - b.tick)
  const dedupTempos = []
  for (const t of tempos) {
    const prev = dedupTempos[dedupTempos.length - 1]
    if (prev && prev.tick === t.tick) dedupTempos[dedupTempos.length - 1] = t
    else dedupTempos.push(t)
  }
  if (!dedupTempos.length) dedupTempos.push({ tick: 0, bpm: 120 })
  if (dedupTempos[0].tick !== 0) dedupTempos.unshift({ tick: 0, bpm: dedupTempos[0].bpm })

  /* ---- 轨道 ---- */
  const mixerNode = find(root, 'mixer')
  const vsUnits = mixerNode ? findAll(mixerNode, 'vsUnit') : []
  const nativeMixer = readMixer(mixerNode, T)
  const tracks = []
  findAll(root, 'vsTrack').forEach((trackNode, index) => {
    const track = readTrack(trackNode, index, T, { scale, prefixTick, timeline, voiceTable, vsUnits })
    if (track) tracks.push(track)
  })
  if (!tracks.length) tracks.push(createTrack({ name: 'Track 1' }))

  const projectName = opts.name
    ? String(opts.name).replace(/\.vsqx$/i, '')
    : seqName && seqName !== 'Untitled0'
      ? seqName
      : '未命名工程'

  return createProject({
    sourceFormat: 'vsqx',
    name: projectName,
    comment: comment && comment !== 'New VSQ File' ? comment : '',
    tempos: dedupTempos,
    timeSignatures,
    measurePrefix: 0,
    tracks,
    extras: {
      vsqx: {
        variant: T.root,
        version: rawText(find(root, 'version'), T.rootVersion),
        vender: rawText(find(root, 'vender'), 'Yamaha corporation'),
        resolution,
        preMeasure,
        prefixTick,
        seqName,
        comment,
        voiceTable,
        // 原生 <mixer> 里 IR 不承载的推子值（inGain/sendLevel/sendEnable、masterUnit、
        // 音频轨与伴奏轨），同格式写回时原样复用
        nativeMixer,
      },
    },
  })
}

function safeParse(text) {
  try {
    return parseXml(text)
  } catch (err) {
    throw new Error(`vsqx：XML 解析失败（${err?.message ?? err}）`)
  }
}

function detectVariant(root) {
  if (root.name === 'vsq4') return TAGS.vsq4
  if (root.name === 'vsq3') return TAGS.vsq3
  const ns = String(root.attrs?.xmlns ?? '')
  if (ns.includes('vsq4')) return TAGS.vsq4
  if (ns.includes('vsq3')) return TAGS.vsq3
  return null
}

function readVoiceTable(root, T) {
  const out = []
  const table = find(root, 'vVoiceTable')
  if (!table) return out
  for (const v of findAll(table, 'vVoice')) {
    out.push({
      bs: intOf(find(v, T.voice.bs), 0) ?? 0,
      pc: intOf(find(v, T.voice.pc), 0) ?? 0,
      id: rawText(find(v, T.voice.id), ''),
      name: rawText(find(v, T.voice.name), ''),
    })
  }
  return out
}

/**
 * 读取 <mixer>。
 *
 * IR 只承载每轨的 mute / solo / pan / vol，其余推子（主控 masterUnit、每轨的
 * inGain / sendLevel / sendEnable、音频轨与伴奏轨）在 IR 里没有位置，
 * 按变体标签原样取出存进 extras，同格式写回时复用——否则用户调好的发送量会归零。
 */
function readMixer(node, T) {
  if (!node) return null
  const M = T.mixer
  const pick = (parent, tag) => (parent && tag ? intOf(find(parent, tag), null) : null)
  const val = (v, fallback) => (Number.isFinite(v) ? v : fallback)
  const master = find(node, 'masterUnit')
  const mono = find(node, M.monoTag)
  const st = find(node, M.stTag)
  return {
    master: {
      outDev: val(pick(master, M.master.outDev), 0),
      retLevel: val(pick(master, M.master.retLevel), 0),
      vol: val(pick(master, M.master.vol), 0),
    },
    mono: {
      inGain: val(pick(mono, M.unit.inGain), 0),
      sendLevel: val(pick(mono, M.unit.sendLevel), -898),
      sendEnable: val(pick(mono, M.unit.sendEnable), 0),
      mute: val(pick(mono, M.unit.mute), 0),
      solo: val(pick(mono, M.unit.solo), 0),
      pan: val(pick(mono, M.unit.pan), 64),
      vol: val(pick(mono, M.unit.vol), 0),
    },
    st: {
      inGain: val(pick(st, M.unit.inGain), 0),
      mute: val(pick(st, M.unit.mute), 0),
      solo: val(pick(st, M.unit.solo), 0),
      vol: val(pick(st, M.unit.vol), -129),
    },
    units: findAll(node, 'vsUnit').map((u) => ({
      no: pick(u, M.unit.no),
      inGain: val(pick(u, M.unit.inGain), 0),
      sendLevel: val(pick(u, M.unit.sendLevel), -898),
      sendEnable: val(pick(u, M.unit.sendEnable), 0),
      vol: val(pick(u, M.unit.vol), null),
      pan: val(pick(u, M.unit.pan), null),
    })),
  }
}

/** 读取单个 vsTrack */
function readTrack(trackNode, index, T, ctx) {
  const { scale, prefixTick, voiceTable, vsUnits } = ctx
  const tNo = intOf(find(trackNode, T.track.no), index) ?? index
  const name = rawText(find(trackNode, T.track.name), '') || `Track ${index + 1}`
  const comment = rawText(find(trackNode, T.track.comment), '')
  const parts = findAll(trackNode, T.track.part)

  const notes = []
  const pitchRaw = []
  const pbsRaw = []
  const paramPoints = {}
  const partStyles = {}
  const singers = []
  let partName = ''

  const addParamPoint = (key, tick, value) => {
    if (!paramPoints[key]) paramPoints[key] = []
    paramPoints[key].push([tick, value])
  }

  for (const part of parts) {
    const partTickRaw = intOf(find(part, T.part.t), 0) ?? 0
    if (!partName) partName = rawText(find(part, T.part.name), '')

    for (const s of findAll(part, T.part.singer)) {
      const pc = intOf(find(s, T.voice.pc), null)
      if (pc === null) continue
      const entry = voiceTable.find((v) => v.pc === pc)
      singers.push({
        tick: Math.round((intOf(find(s, T.part.t), 0) ?? 0) * scale) - prefixTick,
        pc,
        bs: intOf(find(s, T.voice.bs), 0) ?? 0,
        name: entry?.name ?? '',
      })
    }

    const styleNode = find(part, T.part.style)
    if (styleNode) {
      const holder = T.root === 'vsq4' ? 'v' : 'attr'
      for (const a of findAll(styleNode, holder)) {
        const id = a.attrs?.id
        if (id) partStyles[id] = numOf(a, 0)
      }
    }

    for (const cc of findAll(part, T.part.cc)) {
      const pos = intOf(find(cc, T.cc.pos), null)
      const valNode = find(cc, T.cc.value)
      const value = intOf(valNode, null)
      const id = valNode?.attrs?.id
      if (pos === null || value === null || !id) continue
      // 与音符一致：part 内的坐标都是相对 part 起点的，必须先加回 partTickRaw
      const tick = Math.round((pos + partTickRaw) * scale) - prefixTick
      if (id === T.ccIds.pitch) {
        pitchRaw.push({ tick, value })
        continue
      }
      if (id === T.ccIds.pitchSens) {
        pbsRaw.push({ tick, value })
        continue
      }
      const entry = CC_TO_PARAM.find(([key]) => T.ccIds[key] === id)
      if (!entry) continue
      const [key, , max] = entry
      addParamPoint(key, tick, max > 1 ? clamp(value, 0, max) : clamp(value / max, 0, 1))
    }

    for (const noteNode of findAll(part, T.part.note)) {
      const tRaw = intOf(find(noteNode, T.note.t), null)
      const durRaw = intOf(find(noteNode, T.note.dur), null)
      const keyRaw = intOf(find(noteNode, T.note.n), null)
      if (tRaw === null || durRaw === null || keyRaw === null) continue
      if (durRaw <= 0 || keyRaw < 0 || keyRaw > 127) continue
      const duration = Math.max(1, Math.round(durRaw * scale))
      const velocity = clamp(intOf(find(noteNode, T.note.v), 64) ?? 64, 0, 127)
      const lyric = rawText(find(noteNode, T.note.y), '')
      const phonemeNode = find(noteNode, T.note.p)
      const phoneme = phonemeNode ? rawText(phonemeNode, '') : ''

      const attributes = {}
      if (phonemeNode?.attrs?.lock === '1') attributes.phonemeLocked = true
      const styles = readNoteStyle(find(noteNode, T.note.style), T)
      const nStyle = {}
      for (const id of NOTE_STYLE_IDS) {
        if (Number.isFinite(styles[id])) nStyle[id] = styles[id]
      }
      for (const id of [T.vibe.len, T.vibe.type]) {
        if (Number.isFinite(styles[id])) nStyle[id] = styles[id]
      }
      const vibrato = readVibrato(styles, T, duration)
      if (vibrato) {
        attributes.vibrato = vibrato
        nStyle.vibrato = vibrato.native
      }
      if (Object.keys(nStyle).length) attributes.nStyle = nStyle

      notes.push(
        createNote({
          tick: Math.round((tRaw + partTickRaw) * scale) - prefixTick,
          duration,
          key: keyRaw,
          lyric,
          velocity,
          phoneme: phoneme || null,
          attributes,
        }),
      )
    }
  }

  notes.sort((a, b) => a.tick - b.tick || a.key - b.key)

  const pitch = buildPitchCurve(pitchRaw, pbsRaw, notes)

  const parameters = {}
  for (const [key, points] of Object.entries(paramPoints)) {
    points.sort((a, b) => a[0] - b[0])
    const curve = normalizeCurve({
      ticks: points.map((p) => p[0]).filter((t) => t >= 0),
      values: points.filter((p) => p[0] >= 0).map((p) => p[1]),
    })
    if (curve.ticks.length) parameters[key] = curve
  }

  const unit = vsUnits.find((u) => (intOf(find(u, T.mixer.unit.no), -1) ?? -1) === tNo)
  return createTrack({
    id: `vsqx${tNo}`,
    name,
    singer: singers[0]?.name ?? '',
    muted: unit ? (intOf(find(unit, T.mixer.unit.mute), 0) ?? 0) === 1 : false,
    solo: unit ? (intOf(find(unit, T.mixer.unit.solo), 0) ?? 0) === 1 : false,
    volume: unit ? midiVolumeToUnit(intOf(find(unit, T.mixer.unit.vol), 0) ?? 0) : 1,
    pan: unit ? clamp((intOf(find(unit, T.mixer.unit.pan), 64) ?? 64) / 64 - 1, -1, 1) : 0,
    notes,
    pitch,
    parameters,
    extras: {
      vsqx: {
        tNo,
        comment,
        partName,
        partCount: parts.length,
        partStyles,
        singers,
        nativePitch: pitchRaw.length || pbsRaw.length ? { pit: pitchRaw, pbs: pbsRaw } : null,
      },
      vsqxPc: singers[0]?.pc ?? 0,
    },
  })
}

/** 读取 nStyle / noteStyle：标量 attr/v 与序列 seqAttr/seq */
function readNoteStyle(styleNode, T) {
  const out = {}
  if (!styleNode) return out
  for (const a of findAll(styleNode, T.note.styleAttr)) {
    const id = a.attrs?.id
    if (!id) continue
    out[id] = numOf(a, 0)
  }
  for (const seq of findAll(styleNode, T.note.seq)) {
    const id = seq.attrs?.id
    if (!id) continue
    const points = []
    for (const item of findAll(seq, T.note.seqItem)) {
      const pos = intOf(find(item, T.note.seqPos), null)
      const value = intOf(find(item, T.note.seqValue), null)
      if (pos === null || value === null) continue
      points.push([pos, value])
    }
    out[`seq:${id}`] = points
  }
  return out
}

/**
 * 原生颤音 -> IR 颤音。
 * VOCALOID 没有公开 vibDep/vibRate 与音分/Hz 的换算表，因此：
 *   - depth 给出「按 1 原生单位 ≈ 1 音分」的近似量（保证 Monotonic 且可回写）
 *   - rate  给出同样近似的 Hz 量
 *   - native 保存完整原生结构，写回同格式时优先复用，保证同格式往返无损
 */
function readVibrato(styles, T, duration) {
  const len = styles[T.vibe.len]
  if (!Number.isFinite(len) || len <= 0) return null
  const seqPairs = styles[`seq:${T.vibratoSeqId}`] ?? []
  // 原生约定：两个 elem，第一个是 vibDep，第二个是 vibRate
  const depth = seqPairs.length >= 1 ? seqPairs[0][1] : null
  const rate = seqPairs.length >= 2 ? seqPairs[1][1] : null
  const delayNrm = seqPairs.length >= 1 ? seqPairs[0][0] : 0
  return {
    length: clamp(Math.round((len / 127) * duration), 0, duration),
    lengthRatio: clamp(len / 127, 0, 1),
    depth: Number.isFinite(depth) ? depth : null,
    rate: Number.isFinite(rate) ? rate : null,
    delay: clamp(Math.round((delayNrm / POS_NRM_FULL) * duration), 0, duration),
    type: Number.isFinite(styles[T.vibe.type]) ? styles[T.vibe.type] : 0,
    native: { len, type: Number.isFinite(styles[T.vibe.type]) ? styles[T.vibe.type] : 0, seq: seqPairs },
  }
}

/**
 * PIT/PBS -> 绝对音高曲线（半音）。
 * 半音偏差 = PIT / 8191 × PBS；基线 = 该 tick 处正在发声的音符 key。
 */
function buildPitchCurve(pitRaw, pbsRaw, notes) {
  if (!pitRaw.length || !notes.length) return createCurve()
  const pit = pitRaw.slice().sort((a, b) => a.tick - b.tick)
  const pbs = pbsRaw.slice().sort((a, b) => a.tick - b.tick)

  const ticks = []
  const values = []
  let sens = DEFAULT_PBS
  let pi = 0
  for (const event of pit) {
    while (pi < pbs.length && pbs[pi].tick <= event.tick) {
      if (pbs[pi].value > 0) sens = pbs[pi].value
      pi += 1
    }
    const base = baseKeyAt(notes, event.tick)
    if (base === null) continue
    ticks.push(event.tick)
    values.push(base + (event.value / PIT_FULL) * sens)
  }
  return createCurve({ ticks, values })
}

/** 取覆盖该 tick 的音符 key；无覆盖时取时间上最近的音符 */
function baseKeyAt(notes, tick) {
  if (!notes.length) return null
  let best = null
  let bestDist = Infinity
  for (const n of notes) {
    if (tick >= n.tick && tick < n.tick + n.duration) return n.key
    const dist = tick < n.tick ? n.tick - tick : tick - (n.tick + n.duration)
    if (dist < bestDist) {
      bestDist = dist
      best = n.key
    }
  }
  return best
}

/* --------------------------------------------------- 模板骨架（UtaFormatix 做法） */

/**
 * 写出以模板为骨架：先把 templates/template.vsqx 深拷贝成对象树，再把实际数据「填」进去，
 * 而不是从零拼 XML。
 *
 * 为什么（见 docs/TEMPLATE-REWRITE-BRIEF.md）：模板本身就是编辑器接受的文件，
 * 「结构照抄 + 值替换」让必需字段、元素顺序、命名空间天然正确；从零拼写只要漏一个字段
 * （例如音符的 <nStyle>）编辑器就会拒绝加载，而「自己写自己读」的往返自测对这类缺失是瞎的。
 */

const TEMPLATE_FILE = join(dirname(fileURLToPath(import.meta.url)), 'templates', 'template.vsqx')

let templateRootCache = null

/** 读入模板根节点（首次写出时读盘，之后复用）；模板读不到时明确报错，而不是静默拼一个残缺工程 */
function loadTemplateRoot() {
  if (!templateRootCache) {
    let text
    try {
      text = readFileSync(TEMPLATE_FILE, 'utf8')
    } catch (err) {
      throw new Error(`vsqx：读不到模板 ${TEMPLATE_FILE}（${err?.message ?? err}）`)
    }
    templateRootCache = safeParse(text)
  }
  const root = findAll(templateRootCache, 'vsq4')[0]
  if (!root) throw new Error('vsqx：模板 template.vsqx 里找不到根节点 <vsq4>')
  return root
}

/** 深拷贝节点：丢掉 parent 引用与元素之间的缩进空白（序列化时会重新缩进） */
function cloneNode(node) {
  const out = {
    name: node.name,
    attrs: { ...(node.attrs ?? {}) },
    children: (node.children ?? []).map(cloneNode),
    text: String(node.text ?? '').trim(),
    parent: null,
  }
  if (node.cdata) out.cdata = true
  return out
}

/**
 * vsq4 模板 → vsq3 骨架的元素改名表，按「父元素 → 子元素」分组。
 *
 * 必须按上下文分组：同名标签在不同位置对应不同的 vsq3 名字
 * （<name> 在 vVoice 里是 vVoiceName、在 vsTrack 里是 trackName、在 vsPart 里是 partName；
 *   <v> 在 tempo 里是 bpm、在 cc/nStyle 里是 attr；<t> 在 tempo 里是 posTick……）。
 * 值为 null 表示 vsq3 的 schema 里没有这个元素（<plane> 只存在于 vsq4），要删掉。
 */
const V3_RENAME = {
  vsq4: { vsTrack: 'vsTrack', monoTrack: 'seTrack', stTrack: 'karaokeTrack' },
  vVoice: { bs: 'vBS', pc: 'vPC', id: 'compID', name: 'vVoiceName', vPrm: 'vVoiceParam' },
  masterUnit: { oDev: 'outDev', rLvl: 'retLevel' },
  mixer: { monoUnit: 'seUnit', stUnit: 'karaokeUnit' },
  // 混音单元：v4 的 vsUnit / monoUnit / stUnit 在 v3 里字段名相同，只是单元名不同
  vsUnit: { tNo: 'vsTrackNo', iGin: 'inGain', sLvl: 'sendLevel', sEnable: 'sendEnable', m: 'mute', s: 'solo' },
  monoUnit: { iGin: 'inGain', sLvl: 'sendLevel', sEnable: 'sendEnable', m: 'mute', s: 'solo' },
  stUnit: { iGin: 'inGain', m: 'mute', s: 'solo' },
  timeSig: { m: 'posMes', nu: 'nume', de: 'denomi' },
  tempo: { t: 'posTick', v: 'bpm' },
  vsTrack: { tNo: 'vsTrackNo', name: 'trackName', vsPart: 'musicalPart' },
  vsPart: { t: 'posTick', name: 'partName', sPlug: 'stylePlugin', pStyle: 'partStyle', cc: 'mCtrl', plane: null },
  sPlug: { id: 'stylePluginID', name: 'stylePluginName' },
  pStyle: { v: 'attr' },
  singer: { t: 'posTick', bs: 'vBS', pc: 'vPC' },
  cc: { t: 'posTick', v: 'attr' },
  note: { t: 'posTick', dur: 'durTick', n: 'noteNum', v: 'velocity', y: 'lyric', p: 'phnms', nStyle: 'noteStyle' },
  nStyle: { v: 'attr', seq: 'seqAttr' },
  seq: { cc: 'elem' },
  elem: { p: 'posNrm', v: 'elv' },
  aux: { id: 'auxID' },
}

/** 按改名表就地改造（v4Name 是节点在 vsq4 模板里的原始标签名） */
function convertSkeletonToV3(node, v4Name) {
  const map = V3_RENAME[v4Name] ?? null
  const kept = []
  for (const child of node.children ?? []) {
    const v4ChildName = child.name
    const mapped = map && Object.prototype.hasOwnProperty.call(map, v4ChildName) ? map[v4ChildName] : v4ChildName
    if (mapped === null) continue // 该元素在 vsq3 schema 里不存在
    child.name = mapped
    convertSkeletonToV3(child, v4ChildName)
    kept.push(child)
  }
  node.children = kept
}

/** 取一份可写的工程骨架：模板深拷贝 + 目标变体的根属性（v3 还要改名） */
function buildSkeleton(T) {
  const root = cloneNode(loadTemplateRoot())
  if (T.root === 'vsq3') {
    root.name = 'vsq3'
    convertSkeletonToV3(root, 'vsq4')
  }
  root.attrs = {
    ...root.attrs,
    xmlns: T.ns,
    'xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
    'xsi:schemaLocation': T.xsd,
  }
  return root
}

/* ------------------------------------------------------------ 骨架填充工具 */

/** 骨架里的唯一子元素；模板缺了才补空壳（正常模板不会走到这一步） */
function slot(parent, name) {
  let node = parent ? find(parent, name) : null
  if (!node && parent) node = push(parent, el(name))
  return node
}

function setText(node, value) {
  if (!node) return node
  node.text = value === undefined || value === null ? '' : String(value)
  return node
}

/** 名称 / 歌词这类字段在 VOCALOID 原生文件里都是 CDATA，保持一致 */
function setCdata(node, value) {
  if (!node) return node
  node.cdata = true
  return setText(node, value)
}

/** 有覆盖值就用覆盖值，否则保留模板里的值（模板即默认值），并标成 CDATA */
function setCdataOrKeep(node, value) {
  const fallback = node?.text ?? ''
  return setCdata(node, value === undefined || value === null || value === '' ? fallback : value)
}

/**
 * 用模板里的「样板元素」克隆出若干个元素，替换掉样板本身并保持它的位置 ——
 * 元素顺序是 XSD 的硬性要求，所以必须就地展开，不能追加到末尾。
 * items 为空时等于「删掉样板」（例如没有音符的段落不留占位音符）。
 */
function stamp(parent, templateChild, items, fill) {
  const list = items ?? []
  if (!parent || !templateChild) {
    // 样板没了还硬写，结果就是静默丢数据（例如整条轨道一个音符都没有）——宁可报错
    if (list.length) throw new Error('vsqx：模板 template.vsqx 里缺少样板元素，无法按模板写出')
    return []
  }
  const at = parent.children.indexOf(templateChild)
  if (at < 0) {
    if (list.length) throw new Error('vsqx：模板骨架里的样板元素不在预期位置，拒绝写出残缺工程')
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

/* ------------------------------------------------------------------ 写出 */

/** 段落级演唱风格参数的模板默认值（pStyle / partStyle） */
const PART_STYLE_DEFAULTS = [
  ['accent', 50],
  ['bendDep', 8],
  ['bendLen', 0],
  ['decay', 50],
  ['fallPort', 0],
  ['opening', 127],
  ['risePort', 0],
]

export function write(project, opts = {}) {
  if (!project || !Array.isArray(project.tracks)) {
    throw new Error('vsqx：write() 需要合法的 Project（缺少 tracks 数组）')
  }
  const V = project.extras?.vsqx ?? {}
  const variant = opts.variant === 'vsq3' ? 'vsq3' : opts.variant === 'vsq4' ? 'vsq4' : V.variant
  const T = variant === 'vsq3' ? TAGS.vsq3 : TAGS.vsq4

  // 时间轴：读过同格式文件时沿用其原始前导偏移，保证「读→写」逐 tick 一致；
  // 否则按项目自身拍号给出一个合理的前导小节（默认 4 小节，与 VOCALOID 新建工程一致）。
  const ownPreMeasure = fileMeasureToTickRaw(
    clamp(Number.isFinite(opts.preMeasure) ? Math.round(opts.preMeasure) : 4, 1, 127) - 1,
    [{ tick: 0, numerator: 4, denominator: 4 }],
  )
  const prefixTick = Number.isFinite(V.prefixTick) && V.prefixTick >= 0 ? Math.round(V.prefixTick) : ownPreMeasure
  // preMeasure 与 prefixTick 必须自洽：选一个使 prefixTick 落在它起点上的小节数
  const preMeasure = clamp(measureIndexOfTick(prefixTick) + 1, 1, 127)

  const timeline = buildTimeline(prefixTick, project.timeSignatures, preMeasure)
  const tickToFile = timeline.irTickToFile
  // 文件里的拍号（小节号定位）
  const fileSigs = timeline.sigs.map((ts) => ({
    measure: timeline.irTickToFileMeasure(ts.tick),
    numerator: ts.numerator,
    denominator: ts.denominator,
  }))
  const masterSigs = []
  for (const s of fileSigs) {
    const prev = masterSigs[masterSigs.length - 1]
    if (prev && prev.measure === s.measure) masterSigs[masterSigs.length - 1] = s
    else masterSigs.push(s)
  }

  /* ---- 骨架：模板深拷贝（v3 变体在此改造成 vsq3 的标签） ---- */
  const root = buildSkeleton(T)

  // 没有任何轨道时也要留一条空轨道：vsq4/vsq3 的 schema 要求 <vsTrack> 至少出现一次，
  // 少了它 VOCALOID 会直接拒绝加载（空的 <vsPart> 才是合法写法）。
  const tracks = project.tracks.length ? project.tracks : [{ name: 'Track 1', notes: [] }]

  setCdata(slot(root, 'vender'), V.vender || 'Yamaha corporation')
  setCdata(slot(root, 'version'), V.version || T.rootVersion)

  fillVoiceTable(slot(root, 'vVoiceTable'), project, V, T)
  fillMixer(slot(root, 'mixer'), tracks, T, V.nativeMixer)
  fillMasterTrack(slot(root, 'masterTrack'), project, V, T, { masterSigs, tickToFile, preMeasure })

  // 模板里只有一个 <vsTrack> 样板：按轨道数就地展开
  const tplTrack = find(root, 'vsTrack')
  if (!tplTrack) throw new Error('vsqx：模板 template.vsqx 里缺少 <vsTrack> 样板')
  stamp(root, tplTrack, tracks, (node, track, index) => fillTrack(node, track, index, T, tickToFile, prefixTick))

  /* ---- monoTrack / stTrack / aux 保持模板原样（模板就是编辑器的空工程骨架） ---- */
  const aux = find(root, 'aux')
  if (aux) {
    setCdataOrKeep(find(aux, T.aux.id), V.auxId)
    setCdataOrKeep(find(aux, T.aux.content), V.auxContent)
  }

  const text = serializeXml(root, { declaration: '<?xml version="1.0" encoding="UTF-8" standalone="no"?>' })
  return Buffer.from(text, 'utf8')
}

function normalizeTempos(tempos) {
  const list = (tempos ?? [])
    .filter((t) => Number.isFinite(t?.bpm) && t.bpm > 0)
    .map((t) => ({ tick: Math.max(0, Math.round(t.tick ?? 0)), bpm: clamp(t.bpm, 20, 300) }))
    .sort((a, b) => a.tick - b.tick)
  const out = []
  for (const t of list) {
    const prev = out[out.length - 1]
    if (prev && prev.tick === t.tick) out[out.length - 1] = t
    else out.push(t)
  }
  if (!out.length) out.push({ tick: 0, bpm: 120 })
  if (out[0].tick !== 0) out.unshift({ tick: 0, bpm: out[0].bpm })
  return out
}

/** 由各轨 singer 组装 vVoiceTable，并记录每轨使用的 vPC */
function buildVoiceTable(project, V, T) {
  const out = []
  const byName = new Map()
  const saved = Array.isArray(V.voiceTable) ? V.voiceTable : []
  for (const track of project.tracks) {
    const name = String(track.singer ?? '').trim()
    if (name && byName.has(name)) {
      track.extras = { ...(track.extras ?? {}), vsqxPc: byName.get(name) }
      continue
    }
    const matched = name ? saved.find((v) => v.name === name) : null
    const entry = {
      bs: Number.isFinite(matched?.bs) ? matched.bs : guessBs(track.language),
      pc: out.length,
      id: matched?.id && matched.id.length === 16 ? matched.id : defaultCompId(out.length),
      name: name || matched?.name || 'Unknown',
    }
    out.push(entry)
    if (name) byName.set(name, entry.pc)
    track.extras = { ...(track.extras ?? {}), vsqxPc: entry.pc }
  }
  if (!out.length) out.push({ bs: 0, pc: 0, id: defaultCompId(0), name: 'Unknown' })
  return out
}

/** 语言 -> 歌手库 bs（0=日语，1=英语，4=汉语） */
function guessBs(language) {
  if (language === 'en') return 1
  if (language === 'zh') return 4
  return 0
}

/** compID 必须是 16 字符（schema 约束） */
function defaultCompId(index) {
  const base = 'BCXDC6CZLSZHZCB4'
  if (index === 0) return base
  return `${base.slice(0, 14)}${String(index % 100).padStart(2, '0')}`
}

/** 模板的 vVoiceTable：按声库逐条展开，vPrm（bre/bri/cle/gen/ope）保持模板默认 */
function fillVoiceTable(table, project, V, T) {
  const tpl = find(table, 'vVoice')
  if (!tpl) return
  const voices = buildVoiceTable(project, V, T)
  stamp(table, tpl, voices, (node, voice) => {
    setText(find(node, T.voice.bs), voice.bs)
    setText(find(node, T.voice.pc), voice.pc)
    setCdata(find(node, T.voice.id), voice.id)
    setCdata(find(node, T.voice.name), voice.name)
  })
}

function numOr(value, fallback) {
  return Number.isFinite(value) ? value : fallback
}

/** 0..1 -> v3/v4 的 vol（-898..60，0 ≈ 0dB，单位 0.1dB） */
function unitToMidiVolume(volume) {
  const v = clamp(Number.isFinite(volume) ? volume : 1, 0, 1)
  if (v >= 0.9999) return 0
  if (v <= 0.0001) return -898
  return clamp(Math.round((20 * Math.log10(v)) * 10), -898, 60)
}

function midiVolumeToUnit(vol) {
  if (!Number.isFinite(vol)) return 1
  if (vol <= -898) return 0
  return clamp(10 ** (vol / 200), 0, 1)
}

function unitToMidiPan(pan) {
  const p = clamp(Number.isFinite(pan) ? pan : 0, -1, 1)
  return clamp(Math.round((p + 1) * 64), 0, 128)
}

/**
 * 模板的 <mixer>：masterUnit / 每轨 vsUnit / 音频轨 / 伴奏轨。
 *
 * 元素名按变体取（v3: outDev/retLevel/inGain/sendLevel/sendEnable/mute/solo/seUnit/karaokeUnit，
 * v4: oDev/rLvl/iGin/sLvl/sEnable/m/s/monoUnit/stUnit）——名字写错编辑器会直接拒绝工程。
 * 每轨的 mute/solo/pan/vol 反映 IR 当前状态（用户可能改过），其余推子优先复用原生值。
 */
function fillMixer(mixer, tracks, T, native) {
  const M = T.mixer
  const master = find(mixer, 'masterUnit')
  setText(find(master, M.master.outDev), numOr(native?.master?.outDev, 0))
  setText(find(master, M.master.retLevel), numOr(native?.master?.retLevel, 0))
  setText(find(master, M.master.vol), numOr(native?.master?.vol, 0))

  const nativeUnits = Array.isArray(native?.units) ? native.units : []
  const tplUnit = find(mixer, 'vsUnit')
  stamp(mixer, tplUnit, tracks ?? [], (node, track, i) => {
    // 原生 vsUnit 优先按轨道号对齐，其次按出现次序；找不到就用模板默认值
    const n = nativeUnits.find((u) => u.no === i) ?? nativeUnits[i] ?? {}
    setText(find(node, M.unit.no), i)
    setText(find(node, M.unit.inGain), numOr(n.inGain, 0))
    setText(find(node, M.unit.sendLevel), numOr(n.sendLevel, -898))
    setText(find(node, M.unit.sendEnable), numOr(n.sendEnable, 0))
    setText(find(node, M.unit.mute), track.muted ? 1 : 0)
    setText(find(node, M.unit.solo), track.solo ? 1 : 0)
    setText(find(node, M.unit.pan), unitToMidiPan(track.pan))
    setText(find(node, M.unit.vol), unitToMidiVolume(track.volume))
  })

  const mono = find(mixer, M.monoTag)
  setText(find(mono, M.unit.inGain), numOr(native?.mono?.inGain, 0))
  setText(find(mono, M.unit.sendLevel), numOr(native?.mono?.sendLevel, -898))
  setText(find(mono, M.unit.sendEnable), numOr(native?.mono?.sendEnable, 0))
  setText(find(mono, M.unit.mute), numOr(native?.mono?.mute, 0))
  setText(find(mono, M.unit.solo), numOr(native?.mono?.solo, 0))
  setText(find(mono, M.unit.pan), numOr(native?.mono?.pan, 64))
  setText(find(mono, M.unit.vol), numOr(native?.mono?.vol, 0))

  const st = find(mixer, M.stTag)
  setText(find(st, M.unit.inGain), numOr(native?.st?.inGain, 0))
  setText(find(st, M.unit.mute), numOr(native?.st?.mute, 0))
  setText(find(st, M.unit.solo), numOr(native?.st?.solo, 0))
  setText(find(st, M.unit.vol), numOr(native?.st?.vol, -129))
}

/** 模板的 <masterTrack>：名称 / 分辨率 / 前导小节 / 拍号 / 速度 */
function fillMasterTrack(master, project, V, T, ctx) {
  setCdata(find(master, 'seqName'), V.seqName || project.name || 'Untitled')
  setCdata(find(master, 'comment'), V.comment || project.comment || 'New VSQ File')
  setText(find(master, 'resolution'), TPQ)
  setText(find(master, 'preMeasure'), ctx.preMeasure)

  const tplTimeSig = find(master, 'timeSig')
  stamp(master, tplTimeSig, ctx.masterSigs, (node, ts) => {
    setText(find(node, T.timeSig.pos), ts.measure)
    setText(find(node, T.timeSig.nume), clamp(Math.round(ts.numerator) || 4, 1, 255))
    setText(find(node, T.timeSig.denomi), clamp(Math.round(ts.denominator) || 4, 1, 255))
  })

  const tplTempo = find(master, 'tempo')
  stamp(master, tplTempo, normalizeTempos(project.tempos), (node, tempo) => {
    setText(find(node, T.tempo.pos), ctx.tickToFile(tempo.tick))
    setText(find(node, T.tempo.bpm), Math.round(tempo.bpm * 100))
  })
}

/* --------------------------------------------------------------- 轨道写出 */

/** 模板里的 <vsTrack>（含一个 <vsPart> 样板）填成一条实际轨道 */
function fillTrack(node, track, index, T, tickToFile, prefixTick) {
  setText(find(node, T.track.no), index)
  setCdata(find(node, T.track.name), track.name ?? `Track ${index + 1}`)
  setCdata(find(node, T.track.comment), track.extras?.vsqx?.comment ?? track.name ?? '')

  const notes = (track.notes ?? []).slice().sort((a, b) => a.tick - b.tick || a.key - b.key)

  /*
   * VSQX 里 part 的坐标是「相对 part 起点」的 —— 这一点由真实工程核对确认：
   *   real-sample-1.vsqx: musicalPart.posTick = 1440，其 note.posTick 从 0 开始；
   *   real-sample-2.vsqx: vsPart.t = 5760，note.t 范围 0 ~ 20160，playTime = 20160。
   * 所以 part 起点要取「这个 part 内所有内容（音符 + 音高曲线 + 参数曲线）的最小文件 tick」，
   * note / cc 的 tick 全部减去它；playTime 则是相对长度。
   * 早期版本这里写的是绝对 tick，会让导出的工程在 VOCALOID 里整条时间轴错位。
   */
  const fileTicks = []
  for (const n of notes) fileTicks.push(tickToFile(n.tick))
  for (const t of track.pitch?.ticks ?? []) if (Number.isFinite(t) && t >= 0) fileTicks.push(tickToFile(t))
  for (const curve of Object.values(track.parameters ?? {})) {
    for (const t of curve?.ticks ?? []) if (Number.isFinite(t) && t >= 0) fileTicks.push(tickToFile(t))
  }
  const partTick = fileTicks.length ? Math.min(...fileTicks) : tickToFile(0)
  const tickToLocal = (t) => Math.max(0, Math.round(tickToFile(t)) - partTick)

  // playTime 是 part 的相对长度
  let endLocal = 0
  for (const n of notes) {
    endLocal = Math.max(endLocal, tickToLocal(n.tick) + Math.max(1, Math.round(n.duration)))
  }
  const storedPlayTime = Number.isFinite(track.extras?.vsqx?.playTime) ? track.extras.vsqx.playTime : 0
  const playTime = Math.max(endLocal, 1, storedPlayTime)

  const part = find(node, T.track.part)
  if (!part) return

  setText(find(part, T.part.t), partTick)
  setText(find(part, T.part.playTime), playTime)
  setCdata(find(part, T.part.name), track.extras?.vsqx?.partName || track.name || 'NewPart')
  setCdata(find(part, T.part.comment), track.extras?.vsqx?.partComment || 'New Musical Part')

  // <sPlug>/<stylePlugin> 的名称类字段：模板值即默认值，只补 CDATA 标记
  const plug = find(part, T.part.plug)
  if (plug) {
    setCdataOrKeep(find(plug, T.plug.id), null)
    setCdataOrKeep(find(plug, T.plug.name), null)
    setCdataOrKeep(find(plug, T.plug.version), null)
  }

  // 段落级演唱风格参数：模板里已有全部 <v id="..."> 默认格子，只覆盖有值的那些
  const styleHolder = T.note.styleAttr
  const style = find(part, T.part.style)
  if (style) {
    const partStyles = track.extras?.vsqx?.partStyles ?? {}
    const known = new Set()
    for (const item of findAll(style, styleHolder)) {
      const id = item.attrs?.id
      if (!id) continue
      known.add(id)
      const def = PART_STYLE_DEFAULTS.find(([key]) => key === id)
      const value = Number.isFinite(partStyles[id]) ? partStyles[id] : def ? def[1] : numOf(item, 0)
      setText(item, Math.round(value))
    }
    for (const [id, value] of Object.entries(partStyles)) {
      if (known.has(id) || !Number.isFinite(value)) continue
      push(style, el(styleHolder, { id }, null, String(Math.round(value))))
    }
  }

  const singer = find(part, T.part.singer)
  setText(find(singer, T.part.t), 0)
  setText(find(singer, T.voice.bs), guessBs(track.language))
  setText(find(singer, T.voice.pc), Number.isFinite(track.extras?.vsqxPc) ? track.extras.vsqxPc : index)

  // cc / note 都拿模板里的样板就地展开（顺序：singer -> cc -> note -> plane）
  const tplCc = find(part, T.part.cc)
  const ccEvents = [
    ...collectPitchControls(track, notes, tickToLocal, T),
    ...collectParamControls(track, tickToLocal, T),
  ]
  stamp(part, tplCc, ccEvents, (cc, event) => {
    setText(find(cc, T.cc.pos), event.tick)
    const value = find(cc, T.cc.value)
    if (value) value.attrs = { ...(value.attrs ?? {}), id: event.id }
    setText(value, event.value)
  })

  const tplNote = find(part, T.part.note)
  stamp(part, tplNote, notes, (noteNode, note) => fillNote(noteNode, note, T, tickToLocal))
}

/** 段落级参数曲线 -> cc 事件 */
function collectParamControls(track, tickToFile, T) {
  const out = []
  const params = track.parameters ?? {}
  for (const [key, , max] of CC_TO_PARAM) {
    const curve = params[key]
    const id = T.ccIds[key]
    if (!curve?.ticks?.length || !id) continue
    const normalized = normalizeCurve(curve)
    for (let i = 0; i < normalized.ticks.length; i += 1) {
      const tick = normalized.ticks[i]
      if (tick < 0) continue
      const raw = max > 1
        ? Math.round(clamp(normalized.values[i], 0, max))
        : Math.round(clamp(normalized.values[i], 0, 1) * max)
      out.push({ tick: tickToFile(tick), id, value: raw })
    }
  }
  out.sort((a, b) => a.tick - b.tick)
  return out
}

/**
 * IR 绝对音高曲线 -> PIT/PBS 事件。
 * PIT = (半音偏差 / PBS) × 8191，偏差相对「该点最近的音符 key」；
 * 分段间隔超限时补发 PBS。
 */
function collectPitchControls(track, notes, tickToFile, T) {
  const curve = track.pitch
  if (!curve?.ticks?.length || !notes.length) return []
  const points = []
  for (let i = 0; i < curve.ticks.length; i += 1) {
    const tick = curve.ticks[i]
    const value = curve.values[i]
    if (!Number.isFinite(tick) || !Number.isFinite(value) || tick < 0) continue
    const base = baseKeyAt(notes, tick)
    if (base === null) continue
    points.push({ tick, offset: value - base })
  }
  if (!points.length) return []
  points.sort((a, b) => a.tick - b.tick)

  const sections = []
  let current = null
  for (const p of points) {
    if (!current || p.tick - current.last >= PIT_SECTION_GAP) {
      current = { items: [], last: p.tick }
      sections.push(current)
    }
    current.items.push(p)
    current.last = p.tick
  }

  const events = []
  for (const section of sections) {
    const maxAbs = section.items.reduce((m, p) => Math.max(m, Math.abs(p.offset)), 0)
    let sens = Math.max(DEFAULT_PBS, Math.ceil(maxAbs - 1e-9))
    sens = clamp(sens, 1, 127)
    if (sens !== DEFAULT_PBS) {
      events.push({ tick: tickToFile(section.items[0].tick), id: T.ccIds.pitchSens, value: sens })
    }
    for (const p of section.items) {
      const pit = Math.round(clamp((p.offset / sens) * PIT_FULL, -PIT_FULL, PIT_FULL))
      events.push({ tick: tickToFile(p.tick), id: T.ccIds.pitch, value: pit })
    }
  }
  events.sort((a, b) => a.tick - b.tick)
  return events
}

/** 模板里的 <note> 样板填成一个实际音符（含完整的 <nStyle>） */
function fillNote(node, note, T, tickToLocal) {
  setText(find(node, T.note.t), tickToLocal(note.tick))
  setText(find(node, T.note.dur), Math.max(1, Math.round(note.duration)))
  setText(find(node, T.note.n), clamp(Math.round(note.key), 0, 127))
  setText(find(node, T.note.v), clamp(Math.round(note.velocity ?? 64), 0, 127))
  setCdata(find(node, T.note.y), note.lyric ?? '')

  const p = find(node, T.note.p)
  if (p) {
    setCdata(p, note.phoneme ?? '')
    if (note.attributes?.phonemeLocked || note.phoneme) p.attrs = { ...(p.attrs ?? {}), lock: '1' }
    else if (p.attrs) delete p.attrs.lock
  }

  fillNoteStyle(find(node, T.note.style), note, T)
}

/**
 * 模板里的 <nStyle>/<noteStyle> 骨架填成音符的演唱风格参数。
 *
 * 模板的每个 <v id="...">（v3 为 <attr>）都是一格带默认值的参数，
 * 因此：读入时存进 attributes.nStyle 的原生值优先回写，没有的格子保留模板默认值 ——
 * 这正是「模板当骨架」的意义：即使这个音符没有原生风格参数，nStyle 也一定完整存在。
 * 模板与真实工程一致，两代都是 9 格：accent / bendDep / bendLen / decay / fallPort /
 * opening / risePort / vibLen / vibType（vibLen、vibType 承载颤音长度与类型）。
 */
function fillNoteStyle(style, note, T) {
  if (!style) return
  const attrs = note.attributes ?? {}
  const native = attrs.nStyle && typeof attrs.nStyle === 'object' ? attrs.nStyle : null
  const vib = attrs.vibrato

  const values = new Map()
  if (native) {
    for (const [id, value] of Object.entries(native)) {
      if (id === 'vibrato') continue
      if (Number.isFinite(value)) values.set(id, Math.round(value))
    }
  }

  const nativeVib = native?.vibrato && typeof native.vibrato === 'object' ? native.vibrato : null
  if (vib) {
    if (nativeVib && Number.isFinite(nativeVib.len)) {
      values.set(T.vibe.len, clamp(Math.round(nativeVib.len), 0, 127))
      if (Number.isFinite(nativeVib.type)) values.set(T.vibe.type, Math.round(nativeVib.type))
    } else {
      const ratio = Number.isFinite(vib.lengthRatio)
        ? vib.lengthRatio
        : Number.isFinite(vib.length) && note.duration > 0
          ? vib.length / note.duration
          : 0.5
      values.set(T.vibe.len, clamp(Math.round(ratio * 127), 1, 127))
      if (Number.isFinite(vib.type)) values.set(T.vibe.type, Math.round(vib.type))
    }
  }

  const holder = T.note.styleAttr
  const known = new Set()
  for (const item of findAll(style, holder)) {
    const id = item.attrs?.id
    if (!id) continue
    known.add(id)
    if (values.has(id)) setText(item, values.get(id))
  }
  // 原生值里有、模板里没有的参数 id 也带上（不丢数据）
  for (const [id, value] of values) {
    if (known.has(id)) continue
    push(style, el(holder, { id }, null, String(value)))
  }

  // 颤音序列：原生结构优先，否则按 IR 颤音近似生成
  if (vib) {
    let depPair
    let ratePair
    if (nativeVib && Array.isArray(nativeVib.seq) && nativeVib.seq.length) {
      depPair = nativeVib.seq[0]
      ratePair = nativeVib.seq[1]
    }
    const duration = Math.max(1, Math.round(note.duration))
    const delayNrm = Number.isFinite(depPair?.[0])
      ? depPair[0]
      : clamp(Math.round(((vib.delay ?? 0) / duration) * POS_NRM_FULL), 0, POS_NRM_FULL)
    const dep = Number.isFinite(depPair?.[1]) ? depPair[1] : clamp(Math.round(vib.depth ?? 64), 0, POS_NRM_FULL)
    const ratePos = Number.isFinite(ratePair?.[0]) ? ratePair[0] : POS_NRM_FULL
    const rate = Number.isFinite(ratePair?.[1]) ? ratePair[1] : clamp(Math.round(vib.rate ?? 64), 0, POS_NRM_FULL)
    const seq = el(T.note.seq, { id: T.vibratoSeqId })
    push(seq, seqItem(T, delayNrm, dep))
    push(seq, seqItem(T, ratePos, rate))
    push(style, seq)
  }
}

function seqItem(T, pos, value) {
  const item = el(T.note.seqItem)
  childEl(item, T.note.seqPos, Math.round(pos))
  childEl(item, T.note.seqValue, Math.round(value))
  return item
}

/* ---------------------------------------------------------- XML 序列化 */

/**
 * 序列化 XML。与 util/xml.mjs 的 buildXml 同构，额外支持 CDATA 文本
 * （VOCALOID 原生文件用 <![CDATA[...]]> 承载名称/歌词，保持一致更安全）。
 */
export function serializeXml(node, opts = {}) {
  const indent = opts.indent ?? '\t'
  const parts = []
  if (opts.declaration) parts.push(opts.declaration)
  writeNode(node, parts, 0, indent)
  return `${parts.join('\n')}\n`
}

function writeNode(node, parts, depth, indent) {
  const pad = indent.repeat(depth)
  const attrStr = Object.entries(node.attrs ?? {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => ` ${k}="${escapeAttr(v)}"`)
    .join('')
  const children = node.children ?? []
  const text = node.text ?? ''
  const hasText = text.length > 0

  if (!children.length && !hasText) {
    parts.push(`${pad}<${node.name}${attrStr}/>`)
    return
  }
  if (!children.length) {
    parts.push(`${pad}<${node.name}${attrStr}>${body(text, node.cdata)}</${node.name}>`)
    return
  }
  parts.push(`${pad}<${node.name}${attrStr}>`)
  if (hasText) parts.push(`${indent.repeat(depth + 1)}${body(text, node.cdata)}`)
  for (const c of children) writeNode(c, parts, depth + 1, indent)
  parts.push(`${pad}</${node.name}>`)
}

function body(text, asCdata) {
  const str = String(text)
  if (asCdata || /[<>&]/.test(str)) {
    return `<![CDATA[${str.replace(/]]>/g, ']]]]><![CDATA[>')}]]>`
  }
  return str
}

function escapeAttr(value) {
  return String(value).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

export default { meta, fidelity, read, write }
