/**
 * MusicXML 读写模块（score-partwise，兼容 2.0 / 3.0 / 3.1 / 4.0 文档）
 *
 * 读取：
 *  - part-list/score-part 与 part/measure
 *  - attributes：divisions / key / time / clef
 *  - note：pitch(step|alter|octave) / duration / type / rest / chord / voice / staff /
 *          lyric(syllabic|text) / tie / notations/tied
 *  - direction/sound(tempo)、direction/offset
 *  - backup / forward 游标回退与推进；<chord/> 并行音；ties 合并
 *  时间统一由 divisions 换算到 IR 的 TPQ = 480（divisions 除不尽时按比例取整）。
 *
 * 写出：
 *  - score-partwise 3.1，divisions = 480（与 IR 同分辨率，避免二次量化）
 *  - 每个 IR 轨道 -> 一个 <part>（extras.channel 相同的轨道合并为同 part 的多声部）
 *  - 按拍号自动切分小节，跨小节音符用 tie/tied 连接，空隙补 rest，重叠用 backup 回退
 *  - 音高曲线、参数曲线无法表达，如实写入 fidelity.drops
 */

import { parseXml, buildXml, el, find, findAll, findPath, childNum } from '../../util/xml.mjs'
import { TPQ, createProject, createTrack, createNote, sortNotes, clamp } from '../ir.mjs'

export const meta = {
  id: 'musicxml',
  name: 'MusicXML',
  vendor: '通用',
  exts: ['.musicxml', '.xml'],
  kind: 'xml',
  canRead: true,
  canWrite: true,
  writeExt: '.musicxml',
  encoding: 'utf8',
}

export const fidelity = {
  preserves: ['notes', 'lyrics', 'tempo', 'timeSignature', 'multiTrack'],
  drops: [
    '音高曲线（弯音 / PIT）',
    '参数曲线（力度、气声、张力等）',
    '颤音参数',
    '音素覆盖',
    '歌手名',
    '音符级 DETUNE / pitchOffset',
    '小节中途的拍号变更（会向后对齐到最近的小节线）',
  ],
  notes:
    'MusicXML 是乐谱交换格式：承载音高、时值、歌词、速度与拍号，时值由 divisions 精确记录，往返不丢音高/歌词/时长。' +
    '音高曲线与所有参数曲线无法表达；歌词按 note/lyric/text 写出，不含音素与颤音。' +
    '注意：MusicXML 的小节没有绝对坐标，读者只能按当前拍号逐小节累加来推算位置，' +
    '因此「小节走到一半变拍号」无法表达，写出时会向后对齐到最近的小节线（速度点不受影响，仍精确）。',
}

/**
 * 自测框架的「声明式已知限制」：
 * MusicXML 没有表示音高曲线（滑音/弯音包络）的标准元素 —— 本模块不写 <bend>，
 * 因此 selftest 的通用往返比对里跳过 pitch 曲线一项。这是能力边界，不是 bug：
 * fidelity.drops 已如实声明，__tests__/musicxml.test.mjs 里也单独断言
 * 「读回的音高曲线为空」以固定该行为。
 */
export const __skipChecks = ['pitch']

const NOTE_TYPES = ['whole', 'half', 'quarter', 'eighth', '16th', '32nd', '64th', '128th']
const STEP_SEMITONES = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }
const SHARP_SPELLING = [
  ['C', 0], ['C', 1], ['D', 0], ['D', 1], ['E', 0], ['F', 0],
  ['F', 1], ['G', 0], ['G', 1], ['A', 0], ['A', 1], ['B', 0],
]
const FLAT_SPELLING = [
  ['C', 0], ['D', -1], ['D', 0], ['E', -1], ['E', 0], ['F', 0],
  ['G', -1], ['G', 0], ['A', -1], ['A', 0], ['B', -1], ['B', 0],
]
/** fifths -> 大调主音（判断该用升号还是降号拼写） */
const FIFTHS_TO_MAJOR = {
  '-7': 'Cb', '-6': 'Gb', '-5': 'Db', '-4': 'Ab', '-3': 'Eb', '-2': 'Bb', '-1': 'F',
  0: 'C', 1: 'G', 2: 'D', 3: 'A', 4: 'E', 5: 'B', 6: 'F#', 7: 'C#',
}

/* ================================================================== 读取 */

export function read(buffer, opts = {}) {
  const text =
    Buffer.isBuffer(buffer) || buffer instanceof Uint8Array ? Buffer.from(buffer).toString('utf8') : String(buffer)
  if (!text.trim()) throw new Error('MusicXML 文件为空')
  const doc = parseXml(text)
  const root = (doc.children ?? []).find((c) => c.name === 'score-partwise' || c.name === 'score-timewise')
  if (!root) {
    throw new Error('不是有效的 MusicXML：根元素应为 <score-partwise>（未找到，文件可能不是乐谱 XML）')
  }
  const parts = root.name === 'score-timewise' ? timewiseToPartwise(root) : findAll(root, 'part')
  if (!parts.length) throw new Error('MusicXML 中没有任何 <part> 声部')

  const partListNode = find(root, 'part-list')
  const scoreParts = findAll(partListNode, 'score-part')
  const title =
    nodeText(findPath(root, 'work/work-title')) ||
    nodeText(find(root, 'movement-title')) ||
    (opts.name ? String(opts.name).replace(/\.[^.\\/]+$/, '') : '')
  const composer = nodeText(findAll(find(root, 'identification'), 'creator')[0])

  const tempos = new Map() // tick -> bpm
  const timeSignatures = new Map() // tick -> {tick,numerator,denominator}
  const keyMap = new Map() // tick -> fifths
  const tracks = []
  const usedNames = new Map()

  parts.forEach((partNode, partIndex) => {
    const partId = partNode.attrs?.id ?? `P${partIndex + 1}`
    const scorePart = scoreParts.find((sp) => sp.attrs?.id === partId)
    const partName = nodeText(find(scorePart, 'part-name')) || `Part ${partIndex + 1}`

    let divisions = 1
    let measureStartTick = 0 // 当前小节起点（IR tick）
    let lastDurationUnits = 0 // 最近一个非 chord 音符的时值（divisions 单位），供 <chord/> 定位
    const records = []
    let seq = 0

    for (const measure of findAll(partNode, 'measure')) {
      let cursor = 0 // 小节内游标（divisions 单位）
      let contentEndUnits = 0 // 本小节内容到达的最大位置（divisions 单位）
      const toIrLocal = (units) => measureStartTick + Math.round((units * TPQ) / divisions)

      for (const node of measure.children ?? []) {
        switch (node.name) {
          case 'attributes': {
            const d = childNum(node, 'divisions', 0)
            if (d > 0) divisions = Math.round(d)
            const time = find(node, 'time')
            if (time && !find(time, 'senza-misura')) {
              const beats = childNum(time, 'beats', 0)
              const beatType = childNum(time, 'beat-type', 0)
              if (beats > 0 && beatType > 0) {
                const at = toIrLocal(cursor)
                if (!timeSignatures.has(at)) timeSignatures.set(at, { tick: at, numerator: beats, denominator: beatType })
              }
            }
            const key = find(node, 'key')
            if (key) {
              const at = toIrLocal(cursor)
              if (!keyMap.has(at)) keyMap.set(at, childNum(key, 'fifths', 0))
            }
            break
          }
          case 'note': {
            const duration = Math.max(0, Math.round(childNum(node, 'duration', divisions)))
            const isRest = !!find(node, 'rest')
            const isChord = !!find(node, 'chord')
            const startUnits = isChord ? Math.max(0, cursor - lastDurationUnits) : cursor
            if (!isRest) {
              const key = pitchToKey(node)
              if (key !== null) {
                const tick = toIrLocal(startUnits)
                records.push({
                  voice: childNum(node, 'voice', 1),
                  staff: childNum(node, 'staff', 1),
                  tick,
                  duration: Math.max(1, toIrLocal(startUnits + duration) - tick),
                  key,
                  lyric: lyricOf(node),
                  tieStart: tieFlag(node, 'start'),
                  tieStop: tieFlag(node, 'stop'),
                  seq: seq++,
                })
              }
            }
            if (!isChord) {
              cursor += duration
              lastDurationUnits = duration
            }
            contentEndUnits = Math.max(contentEndUnits, cursor, startUnits + duration)
            break
          }
          case 'backup':
            cursor = Math.max(0, cursor - Math.round(childNum(node, 'duration', 0)))
            break
          case 'forward':
            cursor += Math.round(childNum(node, 'duration', 0))
            contentEndUnits = Math.max(contentEndUnits, cursor)
            break
          case 'direction': {
            const sound = find(node, 'sound')
            const bpm = sound ? Number(sound.attrs?.tempo) : NaN
            if (Number.isFinite(bpm) && bpm > 0) {
              const offset = Math.round(childNum(node, 'offset', 0))
              const at = Math.max(0, toIrLocal(cursor + offset))
              if (!tempos.has(at)) tempos.set(at, bpm)
            }
            break
          }
          default:
            break
        }
      }
      // 下一小节起点：默认按拍号推导的小节长度推进；
      // 若本小节实际内容超出（例如缺少小节线的不规范文件），则以内容末端为准，避免音符漂移
      const sigList = [...timeSignatures.values()].sort((a, b) => a.tick - b.tick)
      const sig = sigAt(sigList, measureStartTick)
      let length = measureTicks(sig)
      const nextSig = sigList.find((s) => s.tick > measureStartTick)
      if (nextSig && nextSig.tick < measureStartTick + length) length = nextSig.tick - measureStartTick
      const measureEndTick = measureStartTick + Math.round((contentEndUnits * TPQ) / divisions)
      measureStartTick = Math.max(measureStartTick + Math.max(1, length), measureEndTick)
    }

    const collapsed = collapseTies(records)
    if (process.env.DSH_MX_DEBUG) {
      console.log('[mx-debug] records:', JSON.stringify(records.map((r) => [r.tick, r.duration, r.key, r.tieStart, r.tieStop, r.voice])))
      console.log('[mx-debug] collapsed:', JSON.stringify(collapsed.map((r) => [r.tick, r.duration, r.key])))
    }
    const byVoice = new Map()
    for (const rec of collapsed) {
      const list = byVoice.get(rec.voice) ?? []
      list.push(rec)
      byVoice.set(rec.voice, list)
    }
    const voices = [...byVoice.keys()].sort((a, b) => a - b)
    if (!voices.length) {
      tracks.push(createTrack({ id: partId, name: uniqueName(usedNames, partName), notes: [] }))
      return
    }
    voices.forEach((voice) => {
      const list = byVoice.get(voice)
      const baseName = voices.length > 1 ? `${partName} V${voice}` : partName
      tracks.push(
        createTrack({
          id: `${partId}${voices.length > 1 ? `v${voice}` : ''}`,
          name: uniqueName(usedNames, baseName),
          language: /[\u3040-\u30ff\u3400-\u9fff]/.test(list.map((n) => n.lyric).join('')) ? 'ja' : '',
          notes: list
            .slice()
            .sort((a, b) => a.tick - b.tick || a.key - b.key || a.seq - b.seq)
            .map((r) => ({ tick: r.tick, duration: Math.max(1, r.duration), key: r.key, lyric: r.lyric })),
          extras: {
            partId,
            partName,
            voice,
            staff: list[0]?.staff ?? 1,
            divisions,
          },
        }),
      )
    })
  })

  const tempoList = [...tempos.entries()]
    .map(([tick, bpm]) => ({ tick, bpm }))
    .sort((a, b) => a.tick - b.tick)
  if (!tempoList.length) tempoList.push({ tick: 0, bpm: 120 })
  if (tempoList[0].tick !== 0) tempoList.unshift({ tick: 0, bpm: tempoList[0].bpm })

  /*
   * 拍号：去掉「与上一项完全相同」的重复声明。
   * MusicXML 里很多导出器会在每个小节都重写一次 <time>（哪怕没变化），
   * 不去重的话会得到一串同值拍号，界面上看起来像变了好几次拍号，实际并没有变。
   */
  const tsRaw = [...timeSignatures.values()].sort((a, b) => a.tick - b.tick)
  const tsList = []
  for (const ts of tsRaw) {
    const prev = tsList[tsList.length - 1]
    if (prev && prev.numerator === ts.numerator && prev.denominator === ts.denominator) continue
    tsList.push(ts)
  }
  if (!tsList.length) tsList.push({ tick: 0, numerator: 4, denominator: 4 })
  if (tsList[0].tick !== 0) tsList.unshift({ tick: 0, numerator: tsList[0].numerator, denominator: tsList[0].denominator })

  return createProject({
    sourceFormat: 'musicxml',
    name: title || 'MusicXML 导入',
    comment: composer,
    tempos: tempoList,
    timeSignatures: tsList,
    tracks: tracks.length ? tracks : [createTrack()],
    extras: {
      musicxml: {
        partCount: parts.length,
        divisions: 1,
        keys: [...keyMap.entries()].map(([tick, fifths]) => ({ tick, fifths })),
      },
    },
  })
}

function uniqueName(used, base) {
  const n = used.get(base) ?? 0
  used.set(base, n + 1)
  return n ? `${base} (${n + 1})` : base
}

function nodeText(node) {
  return node ? String(node.text ?? '').trim() : ''
}

/** <pitch> -> MIDI 音符号（无音高返回 null） */
function pitchToKey(noteNode) {
  const pitch = find(noteNode, 'pitch')
  if (!pitch) return null
  const step = nodeText(find(pitch, 'step')).toUpperCase()
  if (!(step in STEP_SEMITONES)) return null
  const alter = childNum(pitch, 'alter', 0)
  const octave = childNum(pitch, 'octave', 4)
  return Math.round(clamp((octave + 1) * 12 + STEP_SEMITONES[step] + alter, 0, 127))
}

function lyricOf(noteNode) {
  for (const lyric of findAll(noteNode, 'lyric')) {
    const t = nodeText(find(lyric, 'text'))
    if (t) return t
  }
  return ''
}

function tieFlag(noteNode, type) {
  for (const tie of findAll(noteNode, 'tie')) if (tie.attrs?.type === type) return true
  const notations = find(noteNode, 'notations')
  for (const tied of findAll(notations, 'tied')) if (tied.attrs?.type === type) return true
  return false
}

/** 合并被 tie 拆开的音符（同声部、同音高、首尾相接） */
function collapseTies(records) {
  const byVoice = new Map()
  for (const r of records) {
    const list = byVoice.get(r.voice) ?? []
    list.push(r)
    byVoice.set(r.voice, list)
  }
  const out = []
  for (const list of byVoice.values()) {
    list.sort((a, b) => a.tick - b.tick || a.seq - b.seq)
    let current = null
    for (const rec of list) {
      if (
        current &&
        rec.key === current.key &&
        rec.tick === current.tick + current.duration &&
        (current.tieStart || rec.tieStop)
      ) {
        current.duration += rec.duration
        current.tieStart = rec.tieStart
        if (!current.lyric) current.lyric = rec.lyric
        continue
      }
      if (current) out.push(current)
      current = { ...rec }
    }
    if (current) out.push(current)
  }
  return out.sort((a, b) => a.tick - b.tick || a.seq - b.seq)
}

/** score-timewise -> partwise 视图（容错：多数编辑器不写 timewise） */
function timewiseToPartwise(root) {
  const measures = findAll(root, 'measure')
  const partIds = []
  for (const m of measures) {
    for (const p of findAll(m, 'part')) if (p.attrs?.id && !partIds.includes(p.attrs.id)) partIds.push(p.attrs.id)
  }
  return partIds.map((id) => {
    const part = el('part', { id })
    for (const m of measures) {
      const measure = el('measure', { number: m.attrs?.number ?? '1' })
      const src = findAll(m, 'part').find((p) => p.attrs?.id === id)
      if (src) for (const child of src.children ?? []) measure.children.push(child)
      part.children.push(measure)
    }
    return part
  })
}

/** divisions 单位 -> IR tick（写出时 divisions = TPQ，故此处等价于恒等映射） */
function toIrTick(nativeTick, divisions = TPQ) {
  if (divisions === TPQ) return Math.round(nativeTick)
  return Math.round((nativeTick * TPQ) / divisions)
}

/* ================================================================== 写出 */

export function write(project, opts = {}) {
  if (!project || !Array.isArray(project.tracks)) {
    throw new Error('write() 需要合法的 IR 工程对象（缺少 tracks 数组）')
  }
  const divisions = TPQ
  const tempos = normalizeTempos(project.tempos)
  // 拍号必须对齐到小节线，否则小节位置在读者侧会整体偏移（见 snapTimeSignatures 说明）
  const timeSignatures = snapTimeSignatures(project.timeSignatures)
  const keys = project?.extras?.musicxml?.keys ?? []

  const root = el('score-partwise', { version: '3.1' })
  const title = String(opts.name ?? project.name ?? 'VPIR').trim() || 'VPIR'
  const work = el('work')
  work.children.push(el('work-title', null, null, title))
  root.children.push(work)

  const identification = el('identification')
  if (project.comment) identification.children.push(el('creator', { type: 'composer' }, null, project.comment))
  const encoding = el('encoding')
  encoding.children.push(el('software', null, null, 'VPIR (DSH)'))
  encoding.children.push(el('encoding-date', null, null, new Date().toISOString().slice(0, 10)))
  identification.children.push(encoding)
  root.children.push(identification)

  const defaults = el('defaults')
  const scaling = el('scaling')
  scaling.children.push(el('millimeters', null, null, '7'))
  scaling.children.push(el('tenths', null, null, '40'))
  defaults.children.push(scaling)
  root.children.push(defaults)

  const groups = groupTracks(project.tracks)
  const partList = el('part-list')
  groups.forEach((group) => {
    const scorePart = el('score-part', { id: group.id })
    scorePart.children.push(el('part-name', null, null, group.name))
    const scoreInstrument = el('score-instrument', { id: `${group.id}-I1` })
    scoreInstrument.children.push(el('instrument-name', null, null, 'Voice'))
    scorePart.children.push(scoreInstrument)
    const midiInstrument = el('midi-instrument', { id: `${group.id}-I1` })
    midiInstrument.children.push(el('midi-channel', null, null, String(group.channel + 1)))
    midiInstrument.children.push(el('midi-program', null, null, '1'))
    scorePart.children.push(midiInstrument)
    partList.children.push(scorePart)
  })
  root.children.push(partList)

  const totalTicks = contentTotalTicks(project.tracks, timeSignatures, tempos)
  for (const group of groups) {
    root.children.push(buildPart(group, divisions, totalTicks, tempos, timeSignatures, keys))
  }

  const xml = buildXml(root, { declaration: true, indent: '  ' })
  return Buffer.from(xml, 'utf8')
}

/** 相同 extras.channel 的轨道合并为一个 part（多声部），其余各自成 part */
function groupTracks(tracks) {
  const groups = []
  tracks.forEach((track, i) => {
    const channel = Number(track?.extras?.channel)
    if (Number.isInteger(channel) && channel >= 0 && channel <= 15) {
      const hit = groups.find((g) => g.channel === channel)
      if (hit) {
        hit.tracks.push(track)
        return
      }
      groups.push({ id: `P${groups.length + 1}`, name: track.name || `Part ${groups.length + 1}`, channel, tracks: [track] })
      return
    }
    groups.push({ id: `P${groups.length + 1}`, name: track.name || `Part ${groups.length + 1}`, channel: i % 16, tracks: [track] })
  })
  if (!groups.length) groups.push({ id: 'P1', name: 'Part 1', channel: 0, tracks: [] })
  return groups
}

function trackEnd(track) {
  let end = 0
  for (const n of track.notes ?? []) end = Math.max(end, Math.round(n.tick + n.duration))
  return end
}

/**
 * 需要写出的小节总长度：
 * 音符终点之外，还要保证「每个拍号变更点所在的整小节」都被写出，
 * 否则工程末尾的拍号变更（以及紧随其后的速度点）会整个丢失。
 */
function contentTotalTicks(tracks, timeSignatures, tempos) {
  let end = 1
  for (const track of tracks) end = Math.max(end, trackEnd(track))
  for (const t of tempos) end = Math.max(end, t.tick)
  for (const s of timeSignatures) {
    if (s.tick <= 0) continue
    // 推进到「起点恰好等于该拍号位置」的小节
    let cursor = 0
    let guard = 0
    while (cursor < s.tick && guard < 20000) {
      guard += 1
      const cur = sigAt(timeSignatures, cursor)
      const next = timeSignatures.find((x) => x.tick > cursor)
      let len = measureTicks(cur)
      if (next && next.tick < cursor + len) len = next.tick - cursor
      if (len <= 0) break
      cursor += len
    }
    // 该小节必须完整写出，拍号才会落在小节起点上
    end = Math.max(end, cursor + measureTicks(sigAt(timeSignatures, cursor)))
  }
  return Math.max(1, end)
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
      numerator: clamp(Math.round(s.numerator), 1, 32),
      denominator: s.denominator > 0 ? s.denominator : 4,
    }))
    .sort((a, b) => a.tick - b.tick)
  if (!list.length || list[0].tick !== 0) list.unshift({ tick: 0, numerator: 4, denominator: 4 })
  return list
}

function sigAt(list, tick) {
  let cur = list[0]
  for (const s of list) if (s.tick <= tick) cur = s
  return cur
}

function measureTicks(sig) {
  return Math.round(((TPQ * 4) / sig.denominator) * sig.numerator)
}

/**
 * 把拍号对齐到小节线。
 *
 * 为什么必须这么做：MusicXML 里小节没有绝对位置，读者只能「从上一小节起点累加当前拍号」来推算位置。
 * 所以「小节中途变拍号」（例如 3/4 小节走到一半变成 6/8）在 MusicXML 里无法表达——
 * 若在变更处截断小节，读者累加出来的是完整小节长度，位置就会整体偏移。
 * 标准做法是把变更对齐到最近的后续小节线；这也是记谱软件的实际行为。
 */
function snapTimeSignatures(sigs) {
  const list = normalizeTimeSignatures(sigs)
  const out = []
  let grid = 0 // 当前小节起点
  let cur = list[0]
  for (const sig of list) {
    if (sig.tick === 0 || out.length === 0) {
      out.push({ ...sig, tick: 0 })
      cur = { ...sig, tick: 0 }
      grid = 0
      continue
    }
    let start = grid
    let guard = 0
    while (start < sig.tick && guard < 20000) {
      start += measureTicks(cur)
      guard += 1
    }
    if (start === cur.tick) start += measureTicks(cur) // 原地重复的拍号要往后挪一小节
    out.push({ ...sig, tick: start })
    cur = { ...sig, tick: start }
    grid = start
  }
  // 去重
  const dedup = []
  for (const s of out) {
    const prev = dedup[dedup.length - 1]
    if (prev && prev.tick === s.tick) dedup[dedup.length - 1] = s
    else dedup.push(s)
  }
  return dedup.length ? dedup : [{ tick: 0, numerator: 4, denominator: 4 }]
}

/** 计算小节边界（拍号变更处截断当前小节） */
function buildBars(timeSignatures, totalTicks) {
  const bars = []
  let tick = 0
  let guard = 0
  // 用 <= 保证「起点恰好在末尾拍号处」的小节也会生成
  while (tick < totalTicks && guard < 20000) {
    guard += 1
    const sig = sigAt(timeSignatures, tick)
    const next = timeSignatures.find((s) => s.tick > tick)
    let len = measureTicks(sig)
    if (next && next.tick < tick + len) len = next.tick - tick
    if (len <= 0) break
    bars.push({ start: tick, end: tick + len, sig })
    tick += len
  }
  if (!bars.length) bars.push({ start: 0, end: measureTicks(timeSignatures[0]), sig: timeSignatures[0] })
  return bars
}

/** 把音符按小节切成片段，并标注 tie 方向 */
function segmentNotes(notes, bars) {
  const out = []
  let barIndex = 0
  for (const note of notes) {
    const tick0 = Math.round(note.tick)
    const dur0 = Math.max(1, Math.round(note.duration))
    while (barIndex + 1 < bars.length && bars[barIndex].end <= tick0) barIndex += 1
    const raw = []
    let tick = tick0
    let remaining = dur0
    let guard = 0
    while (remaining > 0 && guard < 8192) {
      guard += 1
      while (barIndex + 1 < bars.length && bars[barIndex].end <= tick) barIndex += 1
      const bar = bars[barIndex] ?? bars[bars.length - 1]
      if (tick < bar.start) {
        const jump = Math.min(remaining, bar.start - tick)
        tick += jump
        remaining -= jump
        continue
      }
      const len = Math.max(1, Math.min(remaining, bar.end - tick))
      raw.push({ tick, len, bar })
      tick += len
      remaining -= len
    }
    if (!raw.length) continue
    raw.forEach((seg, i) => {
      out.push({
        note,
        tick: seg.tick,
        len: seg.len,
        bar: seg.bar,
        tiedFrom: i > 0,
        tieTo: i < raw.length - 1,
      })
    })
  }
  return out
}

function buildPart(group, divisions, totalTicks, tempos, timeSignatures, keys) {
  const part = el('part', { id: group.id })
  const bars = buildBars(timeSignatures, totalTicks)
  const voices = group.tracks.map((track, vi) => ({
    track,
    voice: vi + 1,
    segments: segmentNotes(sortNotes({ notes: (track.notes ?? []).map((n) => createNote(n)) }).notes, bars),
  }))

  let tempoIndex = 0
  const keyFifths = Number.isFinite(group.tracks[0]?.extras?.keySignature?.sharps)
    ? group.tracks[0].extras.keySignature.sharps
    : keys.find((k) => Number.isFinite(k?.fifths))?.fifths ?? 0
  const spelling = fifthSpelling(keyFifths)

  bars.forEach((bar, barIndex) => {
    const measure = el('measure', { number: String(barIndex + 1) })
    const attributes = el('attributes')
    attributes.children.push(el('divisions', null, null, String(divisions)))
    const key = el('key')
    key.children.push(el('fifths', null, null, String(clamp(Math.round(keyFifths), -7, 7))))
    attributes.children.push(key)
    if (bar.sig.tick === bar.start) {
      const time = el('time')
      time.children.push(el('beats', null, null, String(bar.sig.numerator)))
      time.children.push(el('beat-type', null, null, String(bar.sig.denominator)))
      attributes.children.push(time)
    }
    if (barIndex === 0) {
      const clef = el('clef')
      clef.children.push(el('sign', null, null, 'G'))
      clef.children.push(el('line', null, null, '2'))
      attributes.children.push(clef)
    }
    measure.children.push(attributes)

    // 小节内的速度变化：必要时用 forward/backup 把游标移到速度点，避免影响音符流
    let tempoCursor = bar.start
    while (tempoIndex < tempos.length && tempos[tempoIndex].tick < bar.end) {
      const t = tempos[tempoIndex]
      tempoIndex += 1
      if (t.tick < bar.start) continue // 小节起点之前的速度已由前一小节承载
      const advance = t.tick - tempoCursor
      if (advance > 0) {
        const forward = el('forward')
        forward.children.push(el('duration', null, null, String(advance)))
        measure.children.push(forward)
      }
      measure.children.push(tempoDirection(t.bpm))
      if (advance > 0) {
        const backup = el('backup')
        backup.children.push(el('duration', null, null, String(advance)))
        measure.children.push(backup)
      }
      tempoCursor = t.tick
    }

    let wrote = false
    for (const v of voices) {
      const cursor = emitVoice(measure, v, bar, divisions, spelling)
      if (cursor !== null) {
        wrote = true
        if (cursor < bar.end) measure.children.push(restElement(bar.end - cursor, divisions, v.voice))
      }
    }
    if (!wrote) measure.children.push(restElement(bar.end - bar.start, divisions))
    part.children.push(measure)
  })
  return part
}

/**
 * 把一个声部在小节内的片段写入 measure
 * @returns 结束游标（本小节无内容返回 null）
 */
function emitVoice(measure, voice, bar, divisions, spelling) {
  const segments = voice.segments.filter((s) => s.tick >= bar.start && s.tick < bar.end)
  if (!segments.length) return null
  let cursor = bar.start
  for (const seg of segments) {
    if (seg.tick > cursor) {
      measure.children.push(restElement(seg.tick - cursor, divisions, voice.voice))
      cursor = seg.tick
    } else if (seg.tick < cursor) {
      const backup = el('backup')
      backup.children.push(el('duration', null, null, String(cursor - seg.tick)))
      measure.children.push(backup)
      cursor = seg.tick
    }
    measure.children.push(noteElement(seg, divisions, voice, spelling))
    cursor += seg.len
  }
  return cursor
}

function tempoDirection(bpm) {
  const direction = el('direction', { placement: 'above' })
  const directionType = el('direction-type')
  const metronome = el('metronome')
  metronome.children.push(el('beat-unit', null, null, 'quarter'))
  metronome.children.push(el('per-minute', null, null, String(round1(bpm))))
  directionType.children.push(metronome)
  direction.children.push(directionType)
  direction.children.push(el('sound', { tempo: String(round1(bpm)) }))
  return direction
}

function restElement(duration, divisions, voice) {
  const note = el('note')
  const len = Math.max(1, Math.round(duration))
  note.children.push(el('rest'))
  note.children.push(el('duration', null, null, String(len)))
  if (voice) note.children.push(el('voice', null, null, String(voice)))
  note.children.push(el('type', null, null, typeFor(len, divisions)))
  return note
}

function noteElement(seg, divisions, voice, spelling) {
  const note = seg.note
  const node = el('note')
  const pitch = spelling(note.key)
  const pitchNode = el('pitch')
  pitchNode.children.push(el('step', null, null, pitch.step))
  if (pitch.alter) pitchNode.children.push(el('alter', null, null, String(pitch.alter)))
  pitchNode.children.push(el('octave', null, null, String(pitch.octave)))
  node.children.push(pitchNode)
  node.children.push(el('duration', null, null, String(seg.len)))
  if (seg.tieTo) node.children.push(el('tie', { type: 'start' }))
  if (seg.tiedFrom) node.children.push(el('tie', { type: 'stop' }))
  node.children.push(el('voice', null, null, String(voice.voice)))
  node.children.push(el('type', null, null, typeFor(seg.len, divisions)))
  if (seg.tieTo || seg.tiedFrom) {
    const notations = el('notations')
    if (seg.tiedFrom) notations.children.push(el('tied', { type: 'stop' }))
    if (seg.tieTo) notations.children.push(el('tied', { type: 'start' }))
    node.children.push(notations)
  }
  if (note.lyric) {
    const lyric = el('lyric', { number: '1' })
    lyric.children.push(el('syllabic', null, null, 'single'))
    lyric.children.push(el('text', null, null, note.lyric))
    node.children.push(lyric)
  }
  return node
}

/** 时值 -> MusicXML type 名（duration 才是权威，type 仅作提示） */
function typeFor(duration, divisions) {
  const beats = duration / divisions
  if (!(beats > 0)) return 'quarter'
  const idx = clamp(Math.round(Math.log2(beats)), -2, NOTE_TYPES.length - 3)
  return NOTE_TYPES[idx + 2] ?? 'quarter'
}

function round1(v) {
  return Math.round(v * 10) / 10
}

/** fifths -> 音高拼写函数 */
function fifthSpelling(fifths) {
  const major = FIFTHS_TO_MAJOR[String(clamp(Math.round(fifths), -7, 7))] ?? 'C'
  const useFlats = major.includes('b') || major === 'F'
  const table = useFlats ? FLAT_SPELLING : SHARP_SPELLING
  return (key) => {
    const k = ((Math.round(key) % 12) + 12) % 12
    const [step, alter] = table[k]
    return { step, alter, octave: Math.floor(Math.round(key) / 12) - 1 }
  }
}

export default { meta, fidelity, read, write }
