/**
 * MIDI 文件（SMF / Standard MIDI File）读写模块
 *
 * 读取：支持 format 0 / 1，运行状态（running status）、meta 事件
 *       （速度 0x51、拍号 0x58、调号 0x59、轨名 0x03、歌词 0x05、结束 0x2F）、
 *       通道事件（0x8n 0x9n 0xAn 0xBn 0xCn 0xDn 0xEn）。
 *       PPQ 分辨率统一换算到 IR 的 TPQ = 480；SMPTE 时间码（division 高位为 1）不支持并抛出中文错误。
 * 写出：默认 format 1（第 1 轨为速度/拍号指挥轨），PPQ 默认 480，正确写 delta 与 2F 结束事件。
 *
 * 能力边界见下方 fidelity。
 */

import { BufferReader, BufferWriter } from '../../util/bytes.mjs'
import {
  TPQ,
  createProject,
  createTrack,
  createNote,
  normalizeCurve,
  sortNotes,
  clamp,
} from '../ir.mjs'

export const meta = {
  id: 'midi',
  name: 'MIDI 文件',
  vendor: '通用',
  exts: ['.mid', '.midi'],
  kind: 'binary',
  canRead: true,
  canWrite: true,
  writeExt: '.mid',
  encoding: 'binary',
}

export const fidelity = {
  preserves: [
    'tempo', 'timeSignature', 'notes', 'lyrics', 'pitchCurve', 'velocity', 'multiTrack',
    'trackVolume',
    'trackPan',
  ],
  drops: [
    '参数曲线（力度/气声/张力等）',
    '颤音参数',
    '音素覆盖',
    '歌手名',
    '音符级 DETUNE / pitchOffset（力度可近似为 MIDI 力度）',
  ],
  notes:
    'MIDI 只能精确表达音高、时长、速度/拍号与歌词；音高曲线以弯音轮事件承载（默认 ±2 半音，可用 opts.pitchBendRange 调整），' +
    '其余参数曲线无法表达。歌词按字节原样写出（非 ASCII 用 UTF-8）。',
}

/** 收尾未配对 note on 时的默认时长 */
const DEFAULT_NOTE_DURATION = TPQ
/** 音高曲线重采样步长（IR tick） */
const PITCH_STEP = 4

/* ================================================================== 读取 */

export function read(buffer, opts = {}) {
  const r = new BufferReader(buffer)
  if (r.length < 14 || r.ascii(4) !== 'MThd') {
    throw new Error('不是有效的 MIDI 文件：文件开头应为 "MThd"（SMF 头），实际为其它数据')
  }
  const headLen = r.u32be()
  if (headLen < 6) throw new Error(`MIDI 头长度非法：${headLen}（至少应为 6 字节）`)
  const format = r.u16be()
  const trackCount = r.u16be()
  const division = r.u16be()
  r.seek(8 + headLen)

  if (division & 0x8000) {
    const fps = 256 - ((division >> 8) & 0xff)
    const sub = division & 0xff
    throw new Error(
      `暂不支持 SMPTE 时间码的 MIDI 文件（division=0x${division.toString(16)}，即每秒 ${fps} 帧 × ${sub} 子帧）。` +
        '请先用其它工具导出为 PPQ（每四分音符 tick 数）格式的 MIDI。',
    )
  }
  if (!division) throw new Error('MIDI 头中的 division 为 0，无法确定时间分辨率')

  const chunks = splitChunks(r)
  const rawTracks = chunks.filter((c) => c.id === 'MTrk').map((c) => parseTrack(c.data))
  if (!rawTracks.length) throw new Error('MIDI 文件中没有找到任何 MTrk 轨道块，文件可能已损坏')

  /* 速度与拍号：format 0/1 都允许任意轨携带，这里合并去重（同 tick 取先出现者） */
  const tempoMap = new Map()
  const tsMap = new Map()
  for (const t of rawTracks) {
    for (const e of t.tempos) if (!tempoMap.has(e.tick)) tempoMap.set(e.tick, e.bpm)
    for (const e of t.timeSignatures) if (!tsMap.has(e.tick)) tsMap.set(e.tick, e)
  }
  const tempos = [...tempoMap.entries()]
    .map(([tick, bpm]) => ({ tick: toIr(tick, division), bpm }))
    .sort((a, b) => a.tick - b.tick)
  if (!tempos.length) tempos.push({ tick: 0, bpm: 120 })
  const timeSignatures = [...tsMap.values()]
    .map((t) => ({ tick: toIr(t.tick, division), numerator: t.numerator, denominator: t.denominator }))
    .sort((a, b) => a.tick - b.tick)

  /* 工程名：优先指挥轨（无音符的轨）名 */
  const conductor = rawTracks.find((t) => !t.notes.length) ?? rawTracks[0]
  const fallbackName = opts.name ? String(opts.name).replace(/\.[^.\\/]+$/, '') : ''
  const projectName = (conductor.trackName || '').trim() || fallbackName || 'MIDI 导入'

  const hasAnyNote = rawTracks.some((t) => t.notes.length)
  const usedNames = new Map()
  const irTracks = []

  rawTracks.forEach((raw, index) => {
    if (!raw.notes.length && hasAnyNote) return // 有音符时不再产出空的指挥轨
    const rawName = (raw.trackName || '').trim()
    const baseName = rawName || `Track ${irTracks.length + 1}`
    const dup = usedNames.get(baseName) ?? 0
    usedNames.set(baseName, dup + 1)
    const name = dup ? `${baseName} (${dup + 1})` : baseName

    const extras = { mtrkIndex: index }
    if (raw.channel !== null) extras.channel = raw.channel
    if (raw.port !== null) extras.midiPort = raw.port
    if (rawName) extras.trackName = rawName
    if (raw.volumeCc !== null) extras.volumeCc = raw.volumeCc
    if (raw.panCc !== null) extras.panCc = raw.panCc
    if (raw.bendRaw.length) {
      extras.pitchBend = raw.bendRaw.map((b) => ({ tick: toIr(b.tick, division), value: b.value, channel: b.channel }))
    }
    if (raw.keySignature) extras.keySignature = raw.keySignature
    if (raw.smpteOffset) extras.smpteOffset = raw.smpteOffset

    const notes = toIrNotes(raw.notes, division)
    const lyrics = notes.map((n) => n.lyric).join('')
    irTracks.push(
      createTrack({
        id: `mtrk${index + 1}`,
        name,
        language: /[\u3040-\u30ff\u3400-\u9fff]/.test(lyrics) ? 'ja' : '',
        volume: raw.volumeCc === null ? 1 : clamp(raw.volumeCc / 127, 0, 1),
        pan: raw.panCc === null ? 0 : clamp((raw.panCc - 64) / 63, -1, 1),
        notes,
        pitch: bendCurveOf(raw, notes, division, opts),
        extras,
      }),
    )
  })

  if (!irTracks.length) irTracks.push(createTrack({ id: 'mtrk1', name: 'Track 1' }))

  return createProject({
    sourceFormat: 'midi',
    name: projectName,
    tempos,
    timeSignatures,
    tracks: irTracks,
    extras: {
      midi: {
        format,
        declaredTrackCount: trackCount,
        ppq: division,
        keySignature: rawTracks.find((t) => t.keySignature)?.keySignature ?? null,
        smpteOffset: rawTracks.find((t) => t.smpteOffset)?.smpteOffset ?? null,
        trackNames: rawTracks.map((t) => t.trackName || ''),
      },
    },
  })
}

/** 拆分顶层 chunk，容错处理长度越界/尾部垃圾 */
function splitChunks(r) {
  const chunks = []
  let pos = r.pos
  let guard = 0
  while (pos + 8 <= r.length && guard < 100000) {
    guard += 1
    const id = r.buf.toString('latin1', pos, pos + 4)
    const len = r.buf.readUInt32BE(pos + 4)
    const dataStart = pos + 8
    let end = dataStart + len
    if (end > r.length) {
      const next = findChunkHeader(r.buf, dataStart + 1)
      end = next < 0 ? r.length : next
    }
    chunks.push({ id, data: r.buf.subarray(dataStart, end), declaredLength: len })
    const nextPos = Math.max(end, dataStart + 1)
    if (nextPos <= pos) break
    pos = nextPos
  }
  return chunks
}

function findChunkHeader(buf, from) {
  const a = buf.indexOf('MTrk', from, 'latin1')
  const b = buf.indexOf('MThd', from, 'latin1')
  if (a < 0) return b
  if (b < 0) return a
  return Math.min(a, b)
}

/**
 * 解析一条轨道的事件流（native tick）
 * @returns 原始事件集合（音符已配对为 {tick,endTick,key,velocity}）
 */
function parseTrack(data) {
  const out = {
    notes: [],
    tempos: [],
    timeSignatures: [],
    bendRaw: [],
    trackName: '',
    keySignature: null,
    smpteOffset: null,
    channel: null,
    port: null,
    program: null,
    volumeCc: null,
    panCc: null,
    endTick: 0,
  }
  let pos = 0
  let tick = 0
  let running = 0
  let lastEvChannel = 0 // 最近一个通道事件所在声道
  const open = new Map() // "ch:key" -> 排队中的 note on
  const pendingLyric = new Map() // channel -> { tick, text }（文本 meta 归属最近出现的声道）
  let guard = 0
  const limit = data.length * 4 + 64

  while (pos < data.length && guard < limit) {
    guard += 1
    let delta
    ;[delta, pos] = readVlq(data, pos)
    if (pos >= data.length && delta === 0 && pos > data.length) break
    tick += delta
    if (tick > out.endTick) out.endTick = tick

    let status = data[pos]
    if (status === undefined) break
    if (status >= 0x80) pos += 1
    else if (running) status = running
    else {
      pos += 1 // 既无状态字节也无运行状态：跳过损坏字节
      continue
    }

    if (status === 0xff) {
      const type = data[pos]
      pos += 1
      let len
      ;[len, pos] = readVlq(data, pos)
      const body = data.subarray(pos, Math.min(pos + len, data.length))
      pos += len
      switch (type) {
        case 0x03:
          if (!out.trackName) out.trackName = decodeText(body)
          break
        case 0x21:
          if (body.length) out.port = body[0]
          break
        case 0x51:
          if (body.length >= 3) {
            const us = (body[0] << 16) | (body[1] << 8) | body[2]
            if (us > 0) out.tempos.push({ tick, bpm: 60000000 / us })
          }
          break
        case 0x58:
          if (body.length >= 2 && body[0] > 0) {
            out.timeSignatures.push({ tick, numerator: body[0], denominator: 2 ** Math.min(6, body[1]) })
          }
          break
        case 0x59:
          if (body.length >= 2) {
            out.keySignature = { sharps: body[0] > 127 ? body[0] - 256 : body[0], mode: body[1] === 1 ? 'minor' : 'major' }
          }
          break
        case 0x54:
          if (body.length >= 5) {
            out.smpteOffset = { hour: body[0], minute: body[1], second: body[2], frame: body[3], subFrame: body[4] }
          }
          break
        case 0x05:
        case 0x01:
        case 0x06:
          // 文本类事件：0x05 歌词 / 0x01 任意文本 / 0x06 标记，作为「该声道待配歌词」
          if (body.length) {
            pendingLyric.set(lastEvChannel, { tick, text: decodeText(body) })
          }
          break
        default:
          break // 版权 0x02 等其余 meta 不进 IR
      }
      continue
    }

    if (status === 0xf0 || status === 0xf7) {
      let len
      ;[len, pos] = readVlq(data, pos)
      pos += len
      running = 0
      continue
    }

    running = status
    const hi = status & 0xf0
    const channel = status & 0x0f
    if (out.channel === null && hi >= 0x80 && hi <= 0xe0) out.channel = channel

    if (hi === 0x80 || hi === 0x90 || hi === 0xa0 || hi === 0xb0 || hi === 0xe0) {
      const d1 = data[pos] ?? 0
      const d2 = data[pos + 1] ?? 0
      // 数据字节必须 < 0x80；否则说明事件被截断或流已错位，停止解析以免产生凭空音符
      if ((d1 & 0x80) !== 0 || (d2 & 0x80) !== 0) break
      pos += 2
      lastEvChannel = channel
      if (hi === 0x90 && d2 > 0) {
        const k = `${channel}:${d1}`
        const list = open.get(k) ?? []
        list.push({ tick, key: d1, velocity: d2, lyric: pickLyric(pendingLyric.get(channel), tick) })
        open.set(k, list)
      } else if (hi === 0x80 || hi === 0x90) {
        closeNote(open, channel, d1, tick, out.notes)
      } else if (hi === 0xb0) {
        if (d1 === 0x07 && out.volumeCc === null) out.volumeCc = d2
        else if (d1 === 0x0a && out.panCc === null) out.panCc = d2
      } else if (hi === 0xe0) {
        out.bendRaw.push({ tick, value: ((d2 & 0x7f) << 7) | (d1 & 0x7f), channel })
      }
      continue
    }

    if (hi === 0xc0 || hi === 0xd0) {
      const d1 = data[pos] ?? 0
      if ((d1 & 0x80) !== 0) break
      pos += 1
      lastEvChannel = channel
      if (hi === 0xc0) out.program = d1
      continue
    }
    if (status === 0xf1) {
      pos += 1
      continue
    }
    if (status === 0xf2 || status === 0xf3) {
      pos += 2
      continue
    }
    if (status === 0xf6 || status === 0xf8 || status === 0xfa || status === 0xfb || status === 0xfc || status === 0xfe) {
      running = 0
      continue
    }
  }

  // 收尾：仍在排队（没有对应 note off）的音符
  for (const list of open.values()) {
    for (const n of list) {
      out.notes.push({
        tick: n.tick,
        endTick: Math.max(n.tick + 1, out.endTick),
        key: n.key,
        velocity: n.velocity,
        lyric: n.lyric ?? '',
      })
    }
  }
  out.notes.sort((a, b) => a.tick - b.tick || a.key - b.key)
  if (process.env.DSH_MIDI_DEBUG) {
    console.log('[midi-debug] track raw notes:', JSON.stringify(out.notes), 'pending:', JSON.stringify([...pendingLyric.entries()]))
  }
  return out
}

/** 取最近一个歌词文本事件（同声道、且不早于音符起点超过约 4 拍） */
function pickLyric(entry, tick) {
  if (!entry) return ''
  if (entry.tick <= tick && tick - entry.tick <= 1920) return entry.text
  return ''
}

function closeNote(open, channel, key, tick, sink) {
  const k = `${channel}:${key}`
  const list = open.get(k)
  if (!list || !list.length) return // 没有对应 note on：忽略
  const n = list.shift()
  if (!list.length) open.delete(k)
  sink.push({ tick: n.tick, endTick: Math.max(n.tick + 1, tick), key, velocity: n.velocity, lyric: n.lyric ?? '' })
}

/** 原生音符 -> IR 音符 */
function toIrNotes(list, ppq) {
  return list
    .map((n) => ({
      tick: toIr(n.tick, ppq),
      duration: Math.max(1, toIr(n.endTick, ppq) - toIr(n.tick, ppq)),
      key: clamp(Math.round(n.key ?? 60), 0, 127),
      velocity: clamp(Math.round(n.velocity ?? 64), 1, 127),
      lyric: n.lyric ?? '',
    }))
    .sort((a, b) => a.tick - b.tick || a.key - b.key)
}

/** 弯音事件 -> 绝对音高曲线（semitones） */
function bendCurveOf(raw, notes, ppq, opts) {
  if (!raw.bendRaw.length || !notes.length) return normalizeCurve(null)
  const range = Number.isFinite(opts.pitchBendRange) ? Math.max(0.01, opts.pitchBendRange) : 2
  const ticks = []
  const values = []
  for (const b of raw.bendRaw) {
    const irTick = toIr(b.tick, ppq)
    const ref = referenceKey(notes, irTick)
    ticks.push(irTick)
    values.push(ref + ((b.value - 8192) / 8192) * range)
  }
  return normalizeCurve({ ticks, values })
}

/** 找 tick 处（或最近）的音符 key 作为弯音参照 */
function referenceKey(notes, tick) {
  let best = null
  for (const n of notes) {
    if (n.tick <= tick && (!best || n.tick > best.tick)) best = n
  }
  if (!best) {
    for (const n of notes) {
      if (!best || Math.abs(n.tick - tick) < Math.abs(best.tick - tick)) best = n
    }
  }
  return best ? best.key : 60
}

/** 原生 tick -> IR tick（TPQ=480） */
function toIr(nativeTick, ppq) {
  if (ppq === TPQ) return nativeTick
  return Math.round((nativeTick * TPQ) / ppq)
}

function readVlq(buf, pos) {
  let v = 0
  let i = pos
  for (let k = 0; k < 4; k += 1) {
    if (i >= buf.length) return [v, i]
    const b = buf[i]
    i += 1
    v = (v << 7) | (b & 0x7f)
    if ((b & 0x80) === 0) break
  }
  return [v, i]
}

/** 文本事件解码：能无损往返 UTF-8 就用 UTF-8，否则退回 latin1 */
function decodeText(buf) {
  if (!buf.length) return ''
  const utf8 = buf.toString('utf8')
  if (!utf8.includes('\ufffd') && Buffer.from(utf8, 'utf8').equals(buf)) return utf8
  return buf.toString('latin1')
}

function encodeText(str) {
  const s = String(str ?? '')
  if (!s) return Buffer.alloc(0)
  if (/^[\x00-\x7f]*$/.test(s)) return Buffer.from(s, 'latin1')
  return Buffer.from(s, 'utf8')
}

/* ================================================================== 写出 */

export function write(project, opts = {}) {
  if (!project || !Array.isArray(project.tracks)) throw new Error('write() 需要合法的 IR 工程对象（缺少 tracks 数组）')
  const ppq = Math.max(1, Math.round(opts.ppq ?? TPQ))
  const outFormat = Number(opts.format ?? 1) === 0 ? 0 : 1
  const bendRange = Number.isFinite(opts.pitchBendRange) ? Math.max(0.01, opts.pitchBendRange) : 2
  const tempos = normalizeTempos(project.tempos)
  const timeSignatures = normalizeTimeSignatures(project.timeSignatures)

  const parts = [buildConductorTrack(project, tempos, timeSignatures, ppq, opts)]
  const baseChannel = Number.isFinite(opts.channel) ? opts.channel : 0
  project.tracks.forEach((track, i) => {
    const ch = outFormat === 0 ? 0 : channelFor(track, baseChannel + i)
    parts.push(buildNoteTrack(track, ppq, ch, bendRange, outFormat))
  })

  const tracks = outFormat === 0 ? [mergeTracks(parts)] : parts
  const head = new BufferWriter()
  head.ascii('MThd')
  head.u32be(6)
  head.u16be(outFormat)
  head.u16be(tracks.length)
  head.u16be(ppq)
  for (const t of tracks) head.bytes(writeChunk('MTrk', renderTrack(t)))
  return head.toBuffer()
}

function channelFor(track, fallback) {
  const n = Number(track?.extras?.channel)
  if (Number.isInteger(n) && n >= 0 && n <= 15) return n
  return ((Math.round(fallback) % 16) + 16) % 16
}

function normalizeTempos(tempos) {
  const list = (tempos ?? [])
    .filter((t) => Number.isFinite(t?.tick) && Number.isFinite(t?.bpm) && t.bpm > 0)
    .map((t) => ({ tick: Math.max(0, Math.round(t.tick)), bpm: clamp(t.bpm, 1, 1000) }))
    .sort((a, b) => a.tick - b.tick)
  if (!list.length) return [{ tick: 0, bpm: 120 }]
  if (list[0].tick !== 0) list.unshift({ tick: 0, bpm: 120 })
  return list
}

function normalizeTimeSignatures(sigs) {
  const list = (sigs ?? [])
    .filter((s) => Number.isFinite(s?.tick) && s.numerator > 0)
    .map((s) => ({
      tick: Math.max(0, Math.round(s.tick)),
      numerator: clamp(Math.round(s.numerator), 1, 255),
      denominator: s.denominator > 0 ? s.denominator : 4,
    }))
    .sort((a, b) => a.tick - b.tick)
  if (!list.length || list[0].tick !== 0) list.unshift({ tick: 0, numerator: 4, denominator: 4 })
  return list
}

function pushAt(events, tick, priority, fn) {
  events.push({ tick: Math.max(0, Math.round(tick)), priority, fn })
}

function buildConductorTrack(project, tempos, timeSignatures, ppq, opts) {
  const events = []
  const name = String(opts.name ?? project.name ?? '').trim()
  pushAt(events, 0, 0, (ctx) => writeMetaText(ctx, 0x03, name || 'VPIR'))
  pushAt(events, 0, 1, (ctx) => writeMetaText(ctx, 0x02, 'Created by VPIR (DSH)'))
  const smpte = project?.extras?.midi?.smpteOffset
  if (smpte) {
    pushAt(events, 0, 1, (ctx) => {
      ctx.w.u8(0xff).u8(0x54).u8(5)
      ctx.w.u8(smpte.hour & 0xff).u8(smpte.minute & 0xff).u8(smpte.second & 0xff).u8(smpte.frame & 0xff).u8(smpte.subFrame & 0xff)
    })
  }
  for (const t of tempos) {
    pushAt(events, nativeTick(t.tick, ppq), 10, (ctx) => {
      const us = Math.max(1, Math.round(60000000 / t.bpm))
      ctx.w.u8(0xff).u8(0x51).u8(3)
      ctx.w.u8((us >> 16) & 0xff).u8((us >> 8) & 0xff).u8(us & 0xff)
    })
  }
  for (const s of timeSignatures) {
    pushAt(events, nativeTick(s.tick, ppq), 10, (ctx) => {
      const pow = clamp(Math.round(Math.log2(s.denominator)), 0, 7)
      ctx.w.u8(0xff).u8(0x58).u8(4)
      ctx.w.u8(s.numerator & 0xff).u8(pow).u8(24).u8(8)
    })
  }
  const key = project?.extras?.midi?.keySignature
  if (key && Number.isFinite(key.sharps)) {
    pushAt(events, 0, 11, (ctx) => {
      ctx.w.u8(0xff).u8(0x59).u8(2)
      ctx.w.u8(key.sharps < 0 ? key.sharps + 256 : key.sharps).u8(key.mode === 'minor' ? 1 : 0)
    })
  }
  return { events, endTick: 0 }
}

function buildNoteTrack(track, ppq, channel, bendRange, outFormat) {
  const events = []
  const name = String(track?.name ?? '').trim()
  const trackName = String(track?.extras?.trackName ?? name ?? '').trim()
  pushAt(events, 0, 0, (ctx) => writeMetaText(ctx, 0x03, trackName || name || 'Track'))
  const port = Number(track?.extras?.midiPort)
  if (Number.isInteger(port) && port >= 0 && port <= 127) {
    pushAt(events, 0, 1, (ctx) => {
      ctx.w.u8(0xff).u8(0x21).u8(1).u8(port)
    })
  }
  if (outFormat === 1) {
    const volumeCc =
      track?.extras?.volumeCc !== undefined ? clamp(Number(track.extras.volumeCc) | 0, 0, 127) : Math.round(clamp(track?.volume ?? 1, 0, 1) * 127)
    const panCc =
      track?.extras?.panCc !== undefined ? clamp(Number(track.extras.panCc) | 0, 0, 127) : Math.round(clamp((track?.pan ?? 0) + 1, 0, 2) * 63.5)
    if (track?.extras?.volumeCc !== undefined || Math.abs((track?.volume ?? 1) - 1) > 1e-6) {
      pushAt(events, 0, 2, (ctx) => writeChannel(ctx, 0xb0 | channel, [0x07, volumeCc]))
    }
    if (track?.extras?.panCc !== undefined || Math.abs(track?.pan ?? 0) > 1e-6) {
      pushAt(events, 0, 2, (ctx) => writeChannel(ctx, 0xb0 | channel, [0x0a, panCc]))
    }
  }

  const notes = sortNotes({ notes: (track?.notes ?? []).map((n) => createNote(n)) }).notes
  // 先写一条该声道的初始化事件：既让轨道明确占用哪个声道，也让后续歌词 meta 有明确的声道归属
  pushAt(events, 0, 2, (ctx) => writeChannel(ctx, 0xc0 | channel, [0x00]))
  let lastEnd = 0
  for (const note of notes) {
    const start = nativeTick(note.tick, ppq)
    const end = nativeTick(note.tick + note.duration, ppq)
    lastEnd = Math.max(lastEnd, end)
    const key = clamp(Math.round(note.key), 0, 127)
    const velocity = clamp(Math.round(note.velocity ?? 64), 1, 127)
    if (note.lyric) pushAt(events, start, 3, (ctx) => writeMetaText(ctx, 0x05, note.lyric))
    pushAt(events, start, 4, (ctx) => writeChannel(ctx, 0x90 | channel, [key, velocity]))
    pushAt(events, end, -1, (ctx) => writeChannel(ctx, 0x80 | channel, [key, 0x40]))
  }

  if (track?.pitch?.ticks?.length && notes.length) {
    for (const ev of pitchBendEvents(track.pitch, notes, ppq, bendRange)) {
      pushAt(events, ev.tick, 3, (ctx) => writeChannel(ctx, 0xe0 | channel, [ev.value & 0x7f, (ev.value >> 7) & 0x7f]))
    }
  }
  return { events, endTick: lastEnd }
}

/** 依据音高曲线与音符 key 生成弯音轮事件 */
function pitchBendEvents(curve, notes, ppq, bendRange) {
  const { ticks, values } = curve
  const out = []
  const seen = new Set()
  const push = (irTick, bend) => {
    const t = Math.max(0, Math.round(irTick))
    const v = clamp(Math.round(bend), 0, 16383)
    const k = `${t}:${v}`
    if (seen.has(k)) return
    seen.add(k)
    out.push({ tick: nativeTick(t, ppq), value: v })
  }
  for (const note of notes) {
    const start = note.tick
    const end = note.tick + note.duration
    for (let t = start; t < end; t += PITCH_STEP) {
      push(t, bendValue(curveValueAt(ticks, values, t) - note.key, bendRange))
    }
    push(end, bendValue(curveValueAt(ticks, values, end) - note.key, bendRange))
  }
  return out.sort((a, b) => a.tick - b.tick)
}

function bendValue(semitones, range) {
  return 8192 + (semitones / range) * 8192
}

/** 线性插值取曲线值 */
function curveValueAt(ticks, values, tick) {
  if (!ticks.length) return 60
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
  return values[lo] + ((values[hi] - values[lo]) * (tick - ticks[lo])) / span
}

function nativeTick(irTick, ppq) {
  if (ppq === TPQ) return Math.max(0, Math.round(irTick))
  return Math.max(0, Math.round((irTick * ppq) / TPQ))
}

/** 通道事件（带运行状态优化） */
function writeChannel(ctx, status, data) {
  if (ctx.lastStatus !== status) {
    ctx.w.u8(status)
    ctx.lastStatus = status
  }
  for (const d of data) ctx.w.u8(d & 0x7f)
}

/** meta 文本事件；meta 之后运行状态失效 */
function writeMetaText(ctx, type, text) {
  const data = encodeText(text)
  ctx.w.u8(0xff).u8(type)
  ctx.w.varInt(data.length)
  if (data.length) ctx.w.bytes(data)
  ctx.lastStatus = 0
}

/** 事件表 -> MTrk 数据（delta + 2F 结束事件） */
function renderTrack(part) {
  const events = part.events.slice().sort((a, b) => a.tick - b.tick || a.priority - b.priority)
  const ctx = { w: new BufferWriter(), lastStatus: 0 }
  let prev = 0
  for (const ev of events) {
    ctx.w.varInt(Math.max(0, ev.tick - prev))
    prev = ev.tick
    ev.fn(ctx)
  }
  ctx.w.varInt(0)
  ctx.w.u8(0xff).u8(0x2f).u8(0)
  return ctx.w.toBuffer()
}

function writeChunk(id, data) {
  const w = new BufferWriter()
  w.ascii(id)
  w.u32be(data.length)
  w.bytes(data)
  return w.toBuffer()
}

/** format 0：把所有轨道事件合并到一条轨 */
function mergeTracks(parts) {
  const events = []
  for (const p of parts) for (const ev of p.events) events.push(ev)
  return { events, endTick: Math.max(0, ...parts.map((p) => p.endTick ?? 0)) }
}

export default { meta, fidelity, read, write }
