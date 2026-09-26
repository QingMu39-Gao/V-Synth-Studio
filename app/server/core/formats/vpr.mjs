/**
 * VOCALOID5 / VOCALOID6 工程文件（.vpr）读写模块
 *
 * 容器：.vpr 实际是 ZIP 包，内含 `Project\sequence.json`（VOCALOID5.0）或
 *       `Project/sequence.json`（VOCALOID6.1），另有 `Project/Audio/` 资源目录。
 *       为兼容少数只存纯 JSON 的变体，reader 同时接受裸 UTF-8 JSON。
 * 时间：音符 pos / duration、控制器事件 pos、part duration 均为 tick，
 *       与 IR 的 TPQ = 480 一致（1 个四分音符 = 480 tick），无需换算。
 * 速度：masterTrack.tempo.events[].value = bpm × 100（实测 8600 → 86.00）。
 * 拍号：masterTrack.timeSig.events[] 用「小节号 bar」（0 基）+ numer/denom 表示。
 * 音高：PIT（控制器 pitchBend）为「相对当前音符音高的偏移」，
 *       换算 半音 = PIT × PBS / 8191；PBS（控制器 pitchBendSens）单位为半音，
 *       缺省 2。此换算已用真实工程验证：样本中 PIT 恒在 ±2048 内，
 *       换算后正好是 ±0.50 半音（即 ±50 音分）的规整颤音曲线。
 * 参数：控制器名 → IR 规范参数名，原生 0..127 → 0..1（velocity 保持 0..127）。
 *
 * 字段来源为真实工程样本与本机 VOCALOID6 自带的 vsq4.xsd（取值范围）核对，
 * 代码全部自行实现，未复制任何第三方源码。
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib'
import {
  TPQ,
  clamp,
  createCurve,
  createNote,
  createProject,
  createTrack,
  normalizeCurve,
} from '../ir.mjs'

export const meta = {
  id: 'vpr',
  name: 'VOCALOID5/6 工程',
  vendor: 'Yamaha',
  exts: ['.vpr'],
  // .vpr 是 ZIP 包而不是纯文本 JSON。loadFormat 的合并顺序为 { ...def, ...meta }，
  // 这里必须与注册表保持一致，否则会覆盖注册表的 kind（内容嗅探与 UI 都依赖它）。
  kind: 'zip',
  canRead: true,
  canWrite: true,
  writeExt: '.vpr',
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
    'velocity',
    'detune',
    'params.dynamics',
    'params.breathiness',
    'params.brightness',
    'params.clearness',
    'params.opening',
    'params.gender',
    'params.portamento',
    'params.growl',
    'params.harmonics',
    'params.vibratoDepth',
    'params.vibratoRate',
    'params.vibratoDelay',
    'vibrato',
    'multiTrack',
    'singer',
    'trackVolume',
    'trackPan',
  ],
  drops: [
    '弱起（第一小节线前的空拍，VPR 无此概念）',
    '小节内部的拍号变化（VPR 只能记到小节，会向前对齐到小节起点）',
    '轨道颜色（VPR 存的是调色板索引，无法可靠还原 #rrggbb）',
    '音频轨 / 伴奏（Project/Audio 内的音频资源不参与 IR）',
    '音符级 pitchOffset / exp（accent、decay、bendDepth、bendLength）保留在 attributes.vpr，不映射为规范参数',
    '轨道音量/声像的原生单位（dB / 有符号值）保留在 extras.vpr，换算为 IR 时可能被裁剪',
  ],
  notes:
    '.vpr 是 ZIP 包（内含 Project/sequence.json）。速度事件值 = bpm×100；PIT/PBS 换算为 半音 = PIT×PBS/8191（PBS 缺省 2 半音）；参数曲线原生 0..127。写出默认生成 VOCALOID5.0.0 版本结构（VOCALOID5/6 均可打开），声库 compID 按歌手名生成，目标机缺少该声库时编辑器会提示。',
}

/* =============================================================== 常量 */

/** PIT 原始值满量程（±8191） */
const PIT_FULL_SCALE = 8191
/** PBS 缺省灵敏度（半音） */
const DEFAULT_PBS = 2
/** PBS 允许范围（半音） */
const PBS_MIN = 1
const PBS_MAX = 24
/** VOCALOID 参数曲线原生范围 */
const PARAM_MAX = 127
/** 写出 zip 时使用的条目名（两种分隔符各写一份，兼容 V5/V6 的读取实现） */
const ZIP_SEQ_ENTRY_V5 = 'Project\\sequence.json'
const ZIP_SEQ_ENTRY_V6 = 'Project/sequence.json'
const ZIP_AUDIO_DIR = 'Project/Audio/'
const SEQ_ENTRY_RE = /(^|[\\/])sequence\.json$/i
/** 写出时用于定位「当前音符」的容差，越小越贴近原始曲线 */
const SINGING_SKILL_RATIO = 3

/**
 * 控制器名 → IR 规范参数名。
 * name 为写出时使用的首选名（取自真实工程中观察到的写法），aliases 为读取时的别名。
 */
const CONTROLLER_SPECS = [
  { name: 'dynamics', param: 'dynamics' },
  { name: 'breathiness', param: 'breathiness', aliases: ['bre'] },
  { name: 'brightness', param: 'brightness', aliases: ['bri'] },
  { name: 'clearness', param: 'clearness', aliases: ['cle'] },
  { name: 'character', param: 'gender', aliases: ['gender', 'gen'] },
  { name: 'opening', param: 'opening', aliases: ['ope'] },
  { name: 'portamento', param: 'portamento', aliases: ['por'] },
  { name: 'growl', param: 'growl', aliases: ['gro'] },
  { name: 'harmonics', param: 'harmonics', aliases: ['har'] },
  { name: 'tension', param: 'tension' },
  { name: 'mouth', param: 'mouth' },
  { name: 'roughness', param: 'roughness' },
  { name: 'velocity', param: 'velocity' },
  { name: 'vibratoDepth', param: 'vibratoDepth', aliases: ['vib'] },
  { name: 'vibratoRate', param: 'vibratoRate', aliases: ['vibs'] },
  { name: 'vibratoDelay', param: 'vibratoDelay', aliases: ['vibd'] },
]
const CONTROLLER_BY_NAME = new Map()
for (const spec of CONTROLLER_SPECS) {
  for (const alias of [spec.name, ...(spec.aliases ?? [])]) {
    CONTROLLER_BY_NAME.set(alias.toLowerCase(), spec)
  }
}
const CONTROLLER_BY_PARAM = new Map(CONTROLLER_SPECS.map((s) => [s.param, s]))

/** VOCALOID 语言 ID（推断值；原始 langID 始终保留在 extras 里以便无损回写） */
const LANG_ID_TO_IR = { 0: 'ja', 1: 'en', 2: 'zh', 3: 'es', 4: 'ko' }
const IR_TO_LANG_ID = { ja: 0, en: 1, zh: 2, es: 3, ko: 4 }

/** 缺省声库（真实工程中出现的 Yamaha 组件 ID 格式：16 位大写字母数字） */
const DEFAULT_VOICE = { compID: 'BCXDC6CZLSZHZCB4', name: 'VOCALOID' }

/* =============================================================== 工具 */

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const int = (v, fallback = 0) => (Number.isFinite(v) ? Math.round(v) : fallback)
const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback)

/** 由字符串稳定生成 16 位大写字母数字 ID（与 VOCALOID 的 compID 形态一致） */
function hashId(text, prefix = 'C') {
  let h1 = 0x811c9dc5
  let h2 = 0x01000193
  const s = String(text ?? '')
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 16777619) >>> 0
    h2 = Math.imul(h2 + c + i, 2246822519) >>> 0
  }
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
  let out = prefix
  let x = h1
  let y = h2 || 1
  while (out.length < 16) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0
    y = (Math.imul(y ^ (x >>> 7), 2654435761)) >>> 0
    out += alphabet[((x ^ y) >>> 0) % alphabet.length]
  }
  return out.slice(0, 16)
}

/* ------------------------------------------------------------ CRC / ZIP */

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function isZipBuffer(buf) {
  return (
    buf.length > 4 &&
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)
  )
}

/** 读取 zip 的全部条目（只用中央目录，忽略 data descriptor） */
function unzipEntries(buf) {
  let eocd = -1
  const lowest = Math.max(0, buf.length - 66000)
  for (let i = buf.length - 22; i >= lowest; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('vpr：ZIP 结构损坏（找不到中央目录结尾记录）')
  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const entries = []
  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`vpr：ZIP 中央目录第 ${i + 1} 项损坏`)
    }
    const method = buf.readUInt16LE(offset + 10)
    const compSize = buf.readUInt32LE(offset + 20)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8')
    if (localOffset + 30 <= buf.length && buf.readUInt32LE(localOffset) === 0x04034b50) {
      const dataStart =
        localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28)
      const raw = buf.subarray(dataStart, Math.min(dataStart + compSize, buf.length))
      let data = raw
      if (method === 8) data = inflateRawSync(raw)
      else if (method !== 0) {
        throw new Error(`vpr：ZIP 条目「${name}」使用了不支持的压缩方式 ${method}`)
      }
      entries.push({ name, data: Buffer.from(data), size: raw.length })
    }
    offset += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/** 生成 zip（deflate；目录条目用 store） */
function zipEntries(items) {
  const chunks = []
  const central = []
  let offset = 0
  const dosDate = ((2024 - 1980) << 9) | (1 << 5) | 1
  const dosTime = 0
  for (const item of items) {
    const nameBuf = Buffer.from(item.name, 'utf8')
    const raw = item.data ?? Buffer.alloc(0)
    const isDir = item.name.endsWith('/')
    const body = isDir || raw.length === 0 ? raw : deflateRawSync(raw, { level: 9 })
    const method = isDir || raw.length === 0 ? 0 : 8
    const crc = crc32(raw)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0800, 6)
    header.writeUInt16LE(method, 8)
    header.writeUInt16LE(dosTime, 10)
    header.writeUInt16LE(dosDate, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(body.length, 18)
    header.writeUInt32LE(raw.length, 22)
    header.writeUInt16LE(nameBuf.length, 26)
    header.writeUInt16LE(0, 28)
    chunks.push(header, nameBuf, body)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt16LE(dosTime, 12)
    cd.writeUInt16LE(dosDate, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(body.length, 20)
    cd.writeUInt32LE(raw.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30)
    cd.writeUInt16LE(0, 32)
    cd.writeUInt16LE(0, 34)
    cd.writeUInt16LE(0, 36)
    cd.writeUInt32LE(isDir ? 0x10 : 0, 38)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)
    offset += header.length + nameBuf.length + body.length
  }
  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(items.length, 8)
  end.writeUInt16LE(items.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, centralBuf, end])
}

/* --------------------------------------------------------- 音高 / 音符 */

/** 返回 tick 处的音符 key：优先包含该 tick 的音符，其次之前的最后一个音符 */
function keyAtTick(notes, tick) {
  if (!notes.length) return null
  let fallback = notes[0].key
  for (const n of notes) {
    if (n.tick <= tick) fallback = n.key
    if (tick >= n.tick && tick < n.tick + n.duration) return n.key
    if (n.tick > tick) break
  }
  return fallback
}

/** PBS 事件表（已按 pos 升序）在 tick 处的灵敏度 */
function sensitivityAt(pbsEvents, tick) {
  let sens = DEFAULT_PBS
  for (const e of pbsEvents) {
    if (e.pos > tick) break
    const v = int(e.value, DEFAULT_PBS)
    if (v >= PBS_MIN && v <= PBS_MAX) sens = v
  }
  return sens
}

/** 规范化灵敏度：非法值（缺失/0/越界）一律按缺省 2 半音处理 */
function normalizeSens(sensitivity) {
  const v = num(sensitivity, DEFAULT_PBS)
  return v >= PBS_MIN && v <= PBS_MAX ? v : DEFAULT_PBS
}

/** PIT 原始值 → 相对当前音符的半音偏移 */
export function pitToSemitones(pitValue, sensitivity = DEFAULT_PBS) {
  return (num(pitValue) * normalizeSens(sensitivity)) / PIT_FULL_SCALE
}

/** 半音偏移 → PIT 原始值（按给定灵敏度） */
export function semitonesToPit(semitones, sensitivity = DEFAULT_PBS) {
  const sens = normalizeSens(sensitivity)
  return clamp(Math.round((num(semitones) * PIT_FULL_SCALE) / sens), -PIT_FULL_SCALE, PIT_FULL_SCALE)
}

/* ============================================================ 读取实现 */

function controllerOf(part, name) {
  const list = Array.isArray(part?.controllers) ? part.controllers : []
  const lower = name.toLowerCase()
  return list.find((c) => String(c?.name ?? '').toLowerCase() === lower) ?? null
}

function eventsOf(controller, posOffset = 0) {
  const out = []
  if (!controller || !Array.isArray(controller.events)) return out
  for (const e of controller.events) {
    if (!Number.isFinite(e?.pos) || !Number.isFinite(e?.value)) continue
    out.push({ pos: Math.round(e.pos) + posOffset, value: e.value })
  }
  out.sort((a, b) => a.pos - b.pos)
  return out
}

/** 把 IR 曲线（0..1 或 0..127）转成原生控制器事件 */
function curveToEvents(curve, isVelocity) {
  const out = []
  if (!curve) return out
  const n = Math.min(curve.ticks?.length ?? 0, curve.values?.length ?? 0)
  for (let i = 0; i < n; i += 1) {
    const tick = Math.round(curve.ticks[i])
    const value = isVelocity
      ? clamp(Math.round(num(curve.values[i], 64)), 0, PARAM_MAX)
      : clamp(Math.round(num(curve.values[i], 0) * PARAM_MAX), 0, PARAM_MAX)
    out.push({ pos: tick, value })
  }
  return out
}

/** 原生控制器事件 → IR 曲线 */
function eventsToCurve(events, isVelocity) {
  const ticks = []
  const values = []
  for (const e of events) {
    ticks.push(e.pos)
    values.push(isVelocity ? clamp(e.value, 0, PARAM_MAX) : clamp(e.value / PARAM_MAX, 0, 1))
  }
  return createCurve({ ticks, values })
}

/** timeSig 事件（bar 形式）→ IR 的 tick 形式拍号表 */
function timeSignaturesFromEvents(events, warnings) {
  const list = [...(events ?? [])]
    .filter((e) => Number.isFinite(e?.bar))
    .sort((a, b) => a.bar - b.bar)
  const sigs = []
  for (const e of list) {
    const numerator = Math.max(1, int(e.numer, 4))
    const denominator = [1, 2, 4, 8, 16, 32].includes(int(e.denom, 4)) ? int(e.denom, 4) : 4
    const bar = Math.max(0, int(e.bar, 0))
    let tick
    if (!sigs.length) {
      // 第一个事件可能不在第 0 小节，前面的小节按 4/4 补默认拍号
      tick = measureStartTick(bar, [{ tick: 0, numerator: 4, denominator: 4 }])
      if (bar > 0) sigs.push({ tick: 0, numerator: 4, denominator: 4 })
    } else {
      tick = measureStartTick(bar, sigs)
    }
    if (sigs.length && tick <= sigs[sigs.length - 1].tick) {
      warnings.push(`拍号事件 bar=${bar} 与前一事件重叠，已忽略`)
      continue
    }
    sigs.push({ tick, numerator, denominator })
  }
  if (!sigs.length) sigs.push({ tick: 0, numerator: 4, denominator: 4 })
  if (sigs[0].tick !== 0) sigs.unshift({ tick: 0, numerator: 4, denominator: 4 })
  return sigs
}

/**
 * IR 拍号表 → timeSig 事件（bar 形式）。
 * VPR 只能按小节记录拍号，落在一小节内部的拍号变化会被对齐到该小节起点
 * （见 fidelity.drops），这是格式本身的限制。
 */
function eventsFromTimeSignatures(sigs) {
  const list = [...(sigs ?? [])].sort((a, b) => a.tick - b.tick)
  const out = []
  const accepted = []
  let lastTick = -1
  for (const s of list) {
    const probe = accepted.length ? accepted : [{ tick: 0, numerator: 4, denominator: 4 }]
    let info = measureIndexAt(Math.max(0, Math.round(s.tick)), probe)
    let tick = info.measureStart
    let bar = info.measure
    // 同一小节内出现第二个拍号时顺延到下一小节，避免事件被覆盖
    let guard = 0
    while (tick <= lastTick && guard < 10000) {
      const cur = sigAt(tick, probe)
      tick += Math.max(1, measureTicks(cur.numerator, cur.denominator))
      bar += 1
      guard += 1
    }
    const numerator = Math.max(1, int(s.numerator, 4))
    const denominator = [1, 2, 4, 8, 16, 32].includes(s.denominator) ? s.denominator : 4
    out.push({ bar, denom: denominator, numer: numerator })
    accepted.push({ tick, numerator, denominator })
    lastTick = tick
  }
  if (!out.length) out.push({ bar: 0, denom: 4, numer: 4 })
  return out
}

/** 某拍号下一小节的 tick 数 */
function measureTicks(numerator, denominator) {
  return Math.round(((TPQ * 4) / (denominator || 4)) * (numerator || 4))
}

function sigAt(tick, sigs) {
  let cur = sigs[0] ?? { tick: 0, numerator: 4, denominator: 4 }
  for (const s of sigs) {
    if (s.tick <= tick) cur = s
    else break
  }
  return cur
}

/**
 * tick → 所在小节的 { 小节号, 小节起始 tick }。
 * 拍号只在小节线上生效，因此这里始终按整小节累加（不做小节内截断），
 * 与 VOCALOID 编辑器的行为一致：VPR 的 timeSig 只能记录小节号。
 */
function measureIndexAt(tick, sigs) {
  let measureStart = 0
  let measure = 0
  let guard = 0
  while (guard < 200000) {
    const cur = sigAt(measureStart, sigs)
    const mt = Math.max(1, measureTicks(cur.numerator, cur.denominator))
    if (tick < measureStart + mt) return { measure, measureStart, measureTicks: mt }
    measureStart += mt
    measure += 1
    guard += 1
  }
  return { measure: 0, measureStart: 0, measureTicks: measureTicks(4, 4) }
}

/** 小节号 → 小节起始 tick（measureIndexAt 的逆运算） */
function measureStartTick(measure, sigs) {
  const target = Math.max(0, Math.round(measure))
  let measureStart = 0
  let index = 0
  let guard = 0
  while (index < target && guard < 200000) {
    const cur = sigAt(measureStart, sigs)
    measureStart += Math.max(1, measureTicks(cur.numerator, cur.denominator))
    index += 1
    guard += 1
  }
  return measureStart
}

/** 读取单个 part 的音符 */
function notesFromPart(part, partPos) {
  const notes = []
  const rawNotes = Array.isArray(part?.notes) ? part.notes : []
  for (let i = 0; i < rawNotes.length; i += 1) {
    const n = rawNotes[i]
    if (!isPlainObject(n)) continue
    if (!Number.isFinite(n.pos) || !Number.isFinite(n.number)) continue // 跳过坏节点
    const vibrato = isPlainObject(n.vibrato) ? { ...n.vibrato } : null
    notes.push(
      createNote({
        tick: partPos + Math.round(n.pos),
        duration: Math.max(1, int(n.duration, 120)),
        key: clamp(Math.round(n.number), 0, 127),
        lyric: typeof n.lyric === 'string' ? n.lyric : '',
        detune: num(n.detune, 0),
        velocity: clamp(int(n.velocity, 64), 0, PARAM_MAX),
        phoneme: typeof n.phoneme === 'string' && n.phoneme ? n.phoneme : null,
        attributes: {
          vpr: {
            exp: isPlainObject(n.exp) ? { ...n.exp } : undefined,
            aiExp: isPlainObject(n.aiExp) ? { ...n.aiExp } : undefined,
            singingSkill: isPlainObject(n.singingSkill) ? { ...n.singingSkill } : undefined,
            vibrato: vibrato ?? undefined,
            isProtected: n.isProtected === true ? true : undefined,
            langID: Number.isFinite(n.langID) ? n.langID : undefined,
          },
        },
      })
    )
  }
  notes.sort((a, b) => a.tick - b.tick || a.key - b.key)
  return notes
}

/** 由各 part 的 pitchBend / pitchBendSens 还原绝对音高曲线（半音） */
function pitchFromParts(parts, notes) {
  const ticks = []
  const values = []
  for (const { part, pos } of parts) {
    const pit = eventsOf(controllerOf(part, 'pitchBend'), pos)
    if (!pit.length) continue
    const pbs = eventsOf(controllerOf(part, 'pitchBendSens'), pos)
    for (const e of pit) {
      const key = keyAtTick(notes, e.pos)
      if (key === null) continue
      const abs = key + pitToSemitones(e.value, sensitivityAt(pbs, e.pos))
      ticks.push(e.pos)
      values.push(abs)
    }
  }
  return normalizeCurve({ ticks, values })
}

/** 参数曲线：把各 part 的同类控制器合并为一条 IR 曲线 */
function parametersFromParts(parts, warnings) {
  const buckets = new Map()
  const leftovers = []
  for (const { part } of parts) {
    for (const c of Array.isArray(part?.controllers) ? part.controllers : []) {
      const name = String(c?.name ?? '')
      if (!name || name === 'pitchBend' || name === 'pitchBendSens') continue
      const spec = CONTROLLER_BY_NAME.get(name.toLowerCase())
      if (!spec) {
        leftovers.push({ name, events: eventsOf(c).map((e) => ({ pos: e.pos, value: e.value })) })
        continue
      }
      const list = buckets.get(spec.param) ?? []
      for (const e of eventsOf(c)) list.push(e)
      buckets.set(spec.param, list)
    }
  }
  const parameters = {}
  const usedNames = {}
  for (const [param, events] of buckets) {
    const spec = CONTROLLER_BY_PARAM.get(param)
    const curve = eventsToCurve(events, param === 'velocity')
    if (!curve.ticks.length) continue
    parameters[param] = curve
    usedNames[param] = spec?.name ?? param
  }
  if (leftovers.length) warnings.push(`未映射的控制器：${leftovers.map((l) => l.name).join('、')}`)
  return { parameters, leftovers, usedNames }
}

/** 读一个 .vpr（Buffer）→ IR Project */
export function read(buffer, opts = {}) {
  if (!Buffer.isBuffer(buffer)) throw new Error('vpr：read() 需要一个 Buffer')
  const warnings = []
  let json
  if (isZipBuffer(buffer)) {
    let entries
    try {
      entries = unzipEntries(buffer)
    } catch (err) {
      throw new Error(`vpr：解压失败 —— ${err.message}`)
    }
    const entry = entries.find((e) => SEQ_ENTRY_RE.test(e.name))
    if (!entry) {
      const names = entries.map((e) => e.name).join('、') || '（空包）'
      throw new Error(`vpr：ZIP 包内找不到 Project/sequence.json（实际条目：${names}）`)
    }
    const text = entry.data.toString('utf8').replace(/^\uFEFF/, '')
    try {
      json = JSON.parse(text)
    } catch (err) {
      throw new Error(`vpr：sequence.json 不是合法 JSON —— ${err.message}`)
    }
  } else {
    const text = buffer.toString('utf8').replace(/^\uFEFF/, '')
    try {
      json = JSON.parse(text)
    } catch (err) {
      throw new Error(`vpr：既不是 ZIP 包也不是合法 JSON —— ${err.message}`)
    }
  }
  if (!isPlainObject(json)) throw new Error('vpr：工程内容不是 JSON 对象')
  if (!Array.isArray(json.tracks) && !isPlainObject(json.masterTrack)) {
    throw new Error('vpr：缺少 tracks/masterTrack 字段，可能不是 VOCALOID5/6 工程')
  }

  const master = isPlainObject(json.masterTrack) ? json.masterTrack : {}
  const tempos = []
  for (const e of Array.isArray(master.tempo?.events) ? master.tempo.events : []) {
    if (!Number.isFinite(e?.pos) || !Number.isFinite(e?.value)) continue
    const bpm = e.value / 100
    if (!(bpm > 0) || bpm > 1000) continue
    tempos.push({ tick: Math.round(e.pos), bpm })
  }
  if (!tempos.length) {
    warnings.push('工程没有速度事件，已按 120 BPM 处理')
    tempos.push({ tick: 0, bpm: 120 })
  }
  const timeSignatures = timeSignaturesFromEvents(master.timeSig?.events, warnings)

  // 声库表：compID → 歌手名
  const voiceNames = new Map()
  for (const v of Array.isArray(json.voices) ? json.voices : []) {
    if (!isPlainObject(v)) continue
    if (typeof v.compID === 'string') voiceNames.set(v.compID, typeof v.name === 'string' ? v.name : '')
  }

  const tracks = []
  const rawTracks = Array.isArray(json.tracks) ? json.tracks : []
  for (let ti = 0; ti < rawTracks.length; ti += 1) {
    const t = rawTracks[ti]
    if (!isPlainObject(t)) continue
    const parts = (Array.isArray(t.parts) ? t.parts : [])
      .filter((p) => isPlainObject(p))
      .map((p) => ({ part: p, pos: int(p.pos, 0) }))
    const notes = parts.flatMap(({ part, pos }) => notesFromPart(part, pos))
    notes.sort((a, b) => a.tick - b.tick || a.key - b.key)

    const { parameters, leftovers, usedNames } = parametersFromParts(parts, warnings)
    const pitch = pitchFromParts(parts, notes)

    const firstPart = parts[0]?.part
    const compID = typeof firstPart?.voice?.compID === 'string' ? firstPart.voice.compID : ''
    const singer = compID && voiceNames.has(compID) ? voiceNames.get(compID) : compID
    const langID = Number.isFinite(firstPart?.voice?.langID)
      ? firstPart.voice.langID
      : Number.isFinite(firstPart?.notes?.[0]?.langID)
        ? firstPart.notes[0].langID
        : null

    const volumeRaw = isPlainObject(t.volume) ? { ...t.volume } : null
    const panpotRaw = isPlainObject(t.panpot) ? { ...t.panpot } : null
    const volumeValue = Array.isArray(t.volume?.events) ? num(t.volume.events[0]?.value, 0) : 0
    const panValue = Array.isArray(t.panpot?.events) ? num(t.panpot.events[0]?.value, 0) : 0

    tracks.push(
      createTrack({
        id: `vpr${ti + 1}`,
        name: typeof t.name === 'string' && t.name ? t.name : `Track ${ti + 1}`,
        singer: singer ?? '',
        muted: t.isMuted === true,
        solo: t.isSoloMode === true,
        // 原生音量 0 = 0 dB（原始单位）；IR 只有 0..1，故 0 dB → 1，负值按 dB 换算
        volume: clamp(volumeValue <= 0 ? 10 ** (volumeValue / 20) : 1, 0, 1),
        pan: clamp(panValue / 64, -1, 1),
        language: langID !== null ? LANG_IDSafe(langID) : '',
        notes,
        pitch,
        parameters,
        extras: {
          vpr: {
            type: Number.isFinite(t.type) ? t.type : 0,
            color: Number.isFinite(t.color) ? t.color : 0,
            busNo: Number.isFinite(t.busNo) ? t.busNo : 0,
            isFolded: t.isFolded === true,
            height: num(t.height, 0),
            lastScrollPositionNoteNumber: Number.isFinite(t.lastScrollPositionNoteNumber)
              ? t.lastScrollPositionNoteNumber
              : null,
            volumeRaw,
            panpotRaw,
            controllerNames: usedNames,
            controllers: leftovers,
            midiEffects: Array.isArray(firstPart?.midiEffects)
              ? JSON.parse(JSON.stringify(firstPart.midiEffects))
              : null,
            styleName: typeof firstPart?.styleName === 'string' ? firstPart.styleName : null,
            voice: isPlainObject(firstPart?.voice) ? { ...firstPart.voice } : null,
            langID,
            hadName: typeof t.name === 'string',
          },
        },
      })
    )
  }
  if (!tracks.length) warnings.push('工程没有任何轨道')

  const version = isPlainObject(json.version)
    ? {
        major: int(json.version.major, 5),
        minor: int(json.version.minor, 0),
        revision: int(json.version.revision, 0),
      }
    : { major: 5, minor: 0, revision: 0 }

  const project = createProject({
    sourceFormat: 'vpr',
    name: typeof json.title === 'string' && json.title ? json.title : (opts.name ?? '未命名工程'),
    comment: '',
    tempos,
    timeSignatures,
    measurePrefix: 0,
    tracks,
    extras: {
      vpr: {
        version,
        vender: typeof json.vender === 'string' ? json.vender : 'Yamaha Corporation',
        samplingRate: Number.isFinite(master.samplingRate) ? master.samplingRate : 44100,
        loop: isPlainObject(master.loop) ? { ...master.loop } : { isEnabled: false, begin: 0, end: 0 },
        tempoExtra: {
          isFolded: master.tempo?.isFolded === true,
          height: num(master.tempo?.height, 0),
          global: isPlainObject(master.tempo?.global)
            ? { ...master.tempo.global }
            : { isEnabled: false, value: 12000 },
          ara: isPlainObject(master.tempo?.ara) ? { ...master.tempo.ara } : undefined,
        },
        timeSigFolded: master.timeSig?.isFolded === true,
        masterVolume: isPlainObject(master.volume)
          ? JSON.parse(JSON.stringify(master.volume))
          : { isFolded: false, height: 0, events: [{ pos: 0, value: 0 }] },
        voices: (Array.isArray(json.voices) ? json.voices : []).filter(isPlainObject).map((v) => ({ ...v })),
        warnings,
      },
    },
  })
  return project
}

/** langID → IR 语言，未知返回 '' */
function LANG_IDSafe(langId) {
  return LANG_ID_TO_IR[int(langId, -1)] ?? ''
}

/* ============================================================ 写出实现 */

/** 生成音符级 exp/aiExp/singingSkill/vibrato（优先复用读入时的原始数据） */
function noteExtras(note, isV6) {
  const raw = isPlainObject(note.attributes?.vpr) ? note.attributes.vpr : {}
  const exp = isPlainObject(raw.exp)
    ? { ...raw.exp }
    : isV6
      ? { accent: 50, decay: 50, bendDepth: 0, bendLength: 0, opening: 127 }
      : { opening: 127 }
  const out = { exp }
  if (isV6) {
    out.aiExp = isPlainObject(raw.aiExp)
      ? { ...raw.aiExp }
      : {
          pitchFine: 0.5,
          pitchDriftStart: 0.5,
          pitchDriftEnd: 0.5,
          pitchScalingCenter: 0.5,
          pitchScalingOrigin: 0.5,
          pitchTransitionStart: 0.5,
          pitchTransitionEnd: 0.5,
          amplitudeWhole: 0.5,
          amplitudeStart: 0.5,
          amplitudeEnd: 0.5,
          vibratoLeadingDepth: 0.5,
          vibratoFollowingDepth: 0.5,
        }
  }
  out.singingSkill = isPlainObject(raw.singingSkill)
    ? { ...raw.singingSkill }
    : {
        duration: Math.max(1, Math.round(note.duration / SINGING_SKILL_RATIO)),
        weight: { pre: 64, post: 64 },
      }
  out.vibrato = isPlainObject(raw.vibrato)
    ? { ...raw.vibrato }
    : { type: 0, duration: 0 }
  return { out, raw }
}

/** IR 轨道 → PIT/PBS 控制器事件 */
function pitchControllers(track) {
  const notes = track.notes ?? []
  const curve =
    track.pitch && track.pitch.ticks?.length
      ? track.pitch
      : track.parameters?.pitch?.ticks?.length
        ? track.parameters.pitch
        : null
  if (!curve || !notes.length) return []
  let maxAbs = 0
  const offsets = []
  for (let i = 0; i < curve.ticks.length; i += 1) {
    const key = keyAtTick(notes, curve.ticks[i])
    const offset = curve.values[i] - (key ?? 60)
    offsets.push(offset)
    maxAbs = Math.max(maxAbs, Math.abs(offset))
  }
  if (maxAbs < 1e-9) return []
  const sens = maxAbs <= DEFAULT_PBS ? DEFAULT_PBS : clamp(Math.ceil(maxAbs), PBS_MIN, PBS_MAX)
  const pit = []
  for (let i = 0; i < curve.ticks.length; i += 1) {
    const value = semitonesToPit(clamp(offsets[i], -sens, sens), sens)
    const pos = Math.round(curve.ticks[i])
    if (pit.length && pit[pit.length - 1].pos === pos) pit[pit.length - 1].value = value
    else pit.push({ pos, value })
  }
  const controllers = [{ name: 'pitchBend', events: pit }]
  if (sens !== DEFAULT_PBS) {
    controllers.unshift({
      name: 'pitchBendSens',
      events: [
        { pos: pit[0].pos, value: sens },
        { pos: pit[pit.length - 1].pos + 240, value: DEFAULT_PBS },
      ],
    })
  }
  return controllers
}

/** IR 轨道 → 控制器数组 */
function controllersForTrack(track) {
  const controllers = []
  const rawNames = isPlainObject(track.extras?.vpr?.controllerNames)
    ? track.extras.vpr.controllerNames
    : {}
  const mapped = new Set()
  for (const [param, curve] of Object.entries(track.parameters ?? {})) {
    if (param === 'pitch') continue
    const spec = CONTROLLER_BY_PARAM.get(param)
    if (!spec) continue
    const events = curveToEvents(curve, param === 'velocity')
    if (!events.length) continue
    controllers.push({ name: rawNames[param] ?? spec.name, events })
    mapped.add(param)
  }
  for (const c of pitchControllers(track)) controllers.push(c)
  // 未映射的原始控制器原样回写（同格式往返无损）
  for (const c of Array.isArray(track.extras?.vpr?.controllers) ? track.extras.vpr.controllers : []) {
    if (!isPlainObject(c) || typeof c.name !== 'string') continue
    const spec = CONTROLLER_BY_NAME.get(c.name.toLowerCase())
    if (spec && mapped.has(spec.param)) continue
    controllers.push({
      name: c.name,
      events: (Array.isArray(c.events) ? c.events : [])
        .filter((e) => Number.isFinite(e?.pos) && Number.isFinite(e?.value))
        .map((e) => ({ pos: Math.round(e.pos), value: e.value })),
    })
  }
  return controllers
}

/** VOCALOID 的 midiEffects 默认块（V5 五个，V6 另加 Take） */
function midiEffectsFor(isV6) {
  const effects = [
    {
      id: 'SingingSkill',
      isBypassed: true,
      isFolded: false,
      parameters: [
        { name: 'Name', value: '75F04D2B-D8E4-44b8-939B-41CD101E08FD' },
        { name: 'Skill', value: 5 },
        { name: 'Amount', value: 5 },
      ],
    },
    {
      id: 'VoiceColor',
      isBypassed: true,
      isFolded: false,
      parameters: [
        { name: 'Exciter', value: 0 },
        { name: 'Growl', value: 0 },
        { name: 'Breathiness', value: 0 },
        { name: 'Air', value: 0 },
        { name: 'Mouth', value: 0 },
        { name: 'Character', value: 0 },
      ],
    },
    { id: 'RobotVoice', isBypassed: true, isFolded: false, parameters: [{ name: 'Mode', value: 1 }] },
    {
      id: 'DefaultLyric',
      isBypassed: true,
      isFolded: false,
      parameters: [
        { name: 'CHS', value: 'a' },
        { name: 'ENG', value: 'Ooh' },
        { name: 'ESP', value: 'a' },
        { name: 'JPN', value: 'あ' },
        { name: 'KOR', value: '아' },
      ],
    },
    {
      id: 'Breath',
      isBypassed: true,
      isFolded: false,
      parameters: [
        { name: 'Mode', value: 1 },
        { name: 'Exhalation', value: 5 },
        { name: 'Type', value: 0 },
      ],
    },
  ]
  if (isV6) {
    effects.push({
      id: 'Take',
      isBypassed: false,
      isFolded: false,
      parameters: [{ name: 'Lane630', value: 0 }],
    })
  }
  return effects
}

/** IR Project → .vpr 的 JSON 对象 */
export function buildVprJson(project, opts = {}) {
  const raw = isPlainObject(project.extras?.vpr) ? project.extras.vpr : {}
  const wantV6 = opts.version === 6 || opts.version === '6'
  const version = wantV6
    ? { major: 6, minor: 1, revision: 0 }
    : isPlainObject(raw.version) && !opts.version
      ? { ...raw.version }
      : { major: 5, minor: 0, revision: 0 }
  const isV6 = version.major >= 6

  const tempos = [...(project.tempos ?? [])].sort((a, b) => a.tick - b.tick)
  if (!tempos.length || tempos[0].tick !== 0) tempos.unshift({ tick: 0, bpm: tempos[0]?.bpm ?? 120 })
  const tempoExtra = isPlainObject(raw.tempoExtra) ? raw.tempoExtra : {}

  /*
   * 声库分配。
   *
   * 铁律：**绝不写出本机不存在的 compID**。
   * VOCALOID 打开工程时会拿 compID 去查已安装声库，查不到就直接报错、拒绝打开文件——
   * 这正是「转换成功但编辑器打不开」的根因。
   * 所以匹配不到歌手时，宁可退而用本机任意一个已装声库（用户进去手动换一次声库即可），
   * 也不能凭歌手名 hash 出一个假 ID。
   *
   * 优先级：
   *   1) 源工程就是 vpr，且它记录的 compID 本机确实装了  → 原样保留（vpr→vpr 无损）
   *   2) voiceMap 按歌手名匹配到本机已装声库              → 用它
   *   3) 本机任意已装声库                                → 兜底，并在 report 里记一笔
   *   4) 拿不到本机声库列表时，才退回内置默认值
   */
  const installedVoices = Array.isArray(opts.installedVoices)
    ? opts.installedVoices.filter((v) => v && typeof v.compID === 'string' && v.compID)
    : []
  const installedById = new Map(installedVoices.map((v) => [v.compID, v]))
  const hasInstalledList = installedVoices.length > 0
  const installedOk = (id) => !hasInstalledList || installedById.has(id)
  const fallbackVoice = installedVoices[0] ?? DEFAULT_VOICE
  const report = opts.report && typeof opts.report === 'object' ? opts.report : null
  if (report) report.voiceSubstitutions = report.voiceSubstitutions ?? []

  const voiceList = []
  const voiceIndex = new Map()
  const voiceMap = isPlainObject(opts.voiceMap) ? opts.voiceMap : null

  const pushVoice = (compID, name) => {
    if (voiceIndex.has(compID)) return voiceIndex.get(compID).compID
    const entry = { compID, name: name || DEFAULT_VOICE.name }
    voiceIndex.set(compID, entry)
    voiceList.push(entry)
    return compID
  }

  const compIdFor = (track) => {
    const singer = typeof track.singer === 'string' ? track.singer : ''
    const rawVoice = isPlainObject(track.extras?.vpr?.voice) ? track.extras.vpr.voice : null

    // 1) 来源就是 vpr，且原 compID 在本机存在
    if (rawVoice && typeof rawVoice.compID === 'string' && rawVoice.compID && installedOk(rawVoice.compID)) {
      const known = installedById.get(rawVoice.compID)
      return pushVoice(rawVoice.compID, known?.name ?? singer ?? rawVoice.name)
    }

    // 同名歌手复用
    if (singer && voiceIndex.has(singer)) return voiceIndex.get(singer).compID

    // 2) 按歌手名匹配到本机声库
    const mapped = voiceMap && singer ? voiceMap[singer] : null
    if (typeof mapped === 'string' && mapped && installedOk(mapped)) {
      const known = installedById.get(mapped)
      const id = pushVoice(mapped, known?.name ?? singer)
      if (singer) voiceIndex.set(singer, voiceIndex.get(mapped))
      return id
    }

    // 3) 兜底：本机任意已装声库，保证文件能打开
    if (singer && hasInstalledList) {
      if (report) {
        report.voiceSubstitutions.push({ singer, usedCompID: fallbackVoice.compID, usedName: fallbackVoice.name })
      }
      const id = pushVoice(fallbackVoice.compID, fallbackVoice.name)
      voiceIndex.set(singer, voiceIndex.get(fallbackVoice.compID))
      return id
    }

    // 4) 没有歌手名（例如 SynthV 的伴奏轨）或拿不到本机声库列表
    //    有列表就用本机第一个已装声库，名字也用它自己的真名，别造 "VOCALOID" 这种无意义条目
    const v = hasInstalledList ? fallbackVoice : DEFAULT_VOICE
    const id = pushVoice(v.compID, v.name)
    if (singer) voiceIndex.set(singer, voiceIndex.get(v.compID))
    return id
  }

  const tracks = []
  let endTick = 0
  for (const track of project.tracks ?? []) {
    const tRaw = isPlainObject(track.extras?.vpr) ? track.extras.vpr : {}
    const notes = [...(track.notes ?? [])].sort((a, b) => a.tick - b.tick || a.key - b.key)
    const noteEnd = notes.reduce((m, n) => Math.max(m, n.tick + n.duration), 0)
    endTick = Math.max(endTick, noteEnd)
    const partDuration = Math.max(noteEnd, 1)
    const langID = IR_TO_LANG_ID[track.language] ?? (Number.isFinite(tRaw.langID) ? tRaw.langID : 0)
    const compID = compIdFor(track)

    const vprNotes = notes.map((note) => {
      const { out, raw: nRaw } = noteExtras(note, isV6)
      const item = {
        lyric: note.lyric ?? '',
        phoneme: typeof note.phoneme === 'string' && note.phoneme ? note.phoneme : '',
      }
      if (isV6) item.langID = Number.isFinite(nRaw.langID) ? nRaw.langID : langID
      item.isProtected = nRaw.isProtected === true
      item.pos = Math.max(0, Math.round(note.tick))
      item.duration = Math.max(1, Math.round(note.duration))
      item.number = clamp(Math.round(note.key), 0, 127)
      item.velocity = clamp(Math.round(note.velocity ?? 64), 0, PARAM_MAX)
      if (Number.isFinite(note.detune) && note.detune !== 0) item.detune = Math.round(note.detune)
      item.exp = out.exp
      if (out.aiExp) item.aiExp = out.aiExp
      item.singingSkill = out.singingSkill
      item.vibrato = out.vibrato
      return item
    })

    const volumeValue = Number.isFinite(track.volume) && track.volume < 1
      ? Math.round(20 * Math.log10(Math.max(track.volume, 1e-4)))
      : 0
    const panValue = clamp(Math.round(num(track.pan, 0) * 64), -64, 63)

    const part = {
      pos: 0,
      duration: partDuration,
      styleName: typeof tRaw.styleName === 'string' ? tRaw.styleName : 'No Effect',
      voice: {
        compID,
        langID: Number.isFinite(tRaw.voice?.langID) ? tRaw.voice.langID : langID,
      },
      midiEffects: Array.isArray(tRaw.midiEffects) && tRaw.midiEffects.length ? tRaw.midiEffects : midiEffectsFor(isV6),
      notes: vprNotes,
      controllers: controllersForTrack(track),
    }

    const item = {
      type: Number.isFinite(tRaw.type) ? tRaw.type : 0,
    }
    /*
     * 轨道名：模板（UtaFormatix 的 template.vprjson）里是有的，所以默认写出来。
     * 参考实现同样会写 name —— 之前按「真实 V5 文件里没有该字段」把它去掉是过度推断。
     */
    if (typeof track.name === 'string' && track.name) {
      item.name = track.name
    }
    item.color = Number.isFinite(tRaw.color) ? tRaw.color : 0
    item.busNo = Number.isFinite(tRaw.busNo) ? tRaw.busNo : 0
    item.isFolded = tRaw.isFolded === true
    item.height = num(tRaw.height, 0)
    item.volume = {
      isFolded: tRaw.volumeRaw?.isFolded !== false,
      height: num(tRaw.volumeRaw?.height, 40),
      events: [{ pos: 0, value: volumeValue }],
    }
    item.panpot = {
      isFolded: tRaw.panpotRaw?.isFolded !== false,
      height: num(tRaw.panpotRaw?.height, 40),
      events: [{ pos: 0, value: panValue }],
    }
    item.isMuted = track.muted === true
    item.isSoloMode = track.solo === true
    if (Number.isFinite(tRaw.lastScrollPositionNoteNumber)) {
      item.lastScrollPositionNoteNumber = tRaw.lastScrollPositionNoteNumber
    }
    item.parts = vprNotes.length ? [part] : []
    tracks.push(item)
  }

  const voices = voiceList.length
    ? voiceList
    : [{ compID: DEFAULT_VOICE.compID, name: DEFAULT_VOICE.name }]

  const json = {
    version,
    vender: typeof raw.vender === 'string' && raw.vender ? raw.vender : 'Yamaha Corporation',
    title: project.name || 'Untitled',
    masterTrack: {
      samplingRate: Number.isFinite(raw.samplingRate) ? raw.samplingRate : 44100,
      loop: isPlainObject(raw.loop)
        ? { ...raw.loop, end: Math.max(endTick, num(raw.loop.end, 0)) }
        : { isEnabled: false, begin: 0, end: endTick },
      tempo: {
        isFolded: tempoExtra.isFolded === true,
        height: num(tempoExtra.height, 0),
        global: isPlainObject(tempoExtra.global)
          ? { ...tempoExtra.global }
          : { isEnabled: false, value: 12000 },
        ...(isPlainObject(tempoExtra.ara) ? { ara: { ...tempoExtra.ara } } : {}),
        events: tempos.map((t) => ({ pos: Math.max(0, Math.round(t.tick)), value: Math.round(t.bpm * 100) })),
      },
      timeSig: {
        isFolded: raw.timeSigFolded === true,
        events: eventsFromTimeSignatures(project.timeSignatures),
      },
      volume: isPlainObject(raw.masterVolume)
        ? JSON.parse(JSON.stringify(raw.masterVolume))
        : { isFolded: false, height: 0, events: [{ pos: 0, value: 0 }] },
    },
    voices,
    tracks,
  }
  return json
}

function wantsName(opts) {
  return opts.trackNames === true
}

/** IR Project → .vpr（Buffer：ZIP 包） */
export function write(project, opts = {}) {
  if (!isPlainObject(project) || !Array.isArray(project.tracks)) {
    throw new Error('vpr：write() 需要一个合法的 IR 工程对象')
  }
  const json = buildVprJson(project, opts)
  const text = JSON.stringify(json, null, opts.pretty === false ? 0 : 1)
  const seq = Buffer.from(text, 'utf8')
  if (opts.container === 'json') return seq

  /*
   * ZIP 条目名：**默认按 UtaFormatix3（sdercolin, Apache-2.0）的写法**，
   * 也就是 `Project\sequence.json`（反斜杠），且**不加** Project/Audio/ 目录。
   *
   * 依据：core/io/Vpr.kt:144 里 `zip.file(possibleJsonPaths.first(), jsonText)`，
   * 而 possibleJsonPaths 的第一项就是 "Project\\sequence.json"。
   * 那是久经真实编辑器验证的写法；VOCALOID 是 .NET 程序，解压后按条目名精确查找，
   * 名字不一致会取到 null 再抛异常 —— 用户遇到的「编辑器直接报错打不开」正是这个形态。
   *
   * 注意：同一个包里不能同时放 "Project/sequence.json" 与 "Project\sequence.json"，
   * 在 Windows/.NET 下二者会被当作同一路径而冲突。
   * 需要 VOCALOID6 那种正斜杠写法时传 `{ v6EntryName: true }`。
   */
  const entryName = opts.v6EntryName === true ? ZIP_SEQ_ENTRY_V6 : ZIP_SEQ_ENTRY_V5
  if (opts.v6EntryName === true) {
    return zipEntries([
      { name: ZIP_AUDIO_DIR, data: Buffer.alloc(0) },
      { name: entryName, data: seq },
    ])
  }
  return zipEntries([{ name: entryName, data: seq }])
}

/** 供自测使用的内部工具（非契约 API） */
export const __internals = {
  unzipEntries,
  zipEntries,
  isZipBuffer,
  keyAtTick,
  sensitivityAt,
  measureIndexAt,
  measureStartTick,
  measureTicks,
  timeSignaturesFromEvents,
  eventsFromTimeSignatures,
  hashId,
  crc32,
  buildVprJson,
  PIT_FULL_SCALE,
  DEFAULT_PBS,
}

export default { meta, fidelity, read, write }
