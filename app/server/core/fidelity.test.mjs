/**
 * 保真度声明校验
 *
 *   node app/server/core/fidelity.test.mjs
 *
 * 本工作站的核心卖点是「转换前告诉你哪些数据会丢」。既然要向用户承诺，
 * 声明就必须和实际行为一致。这个测试构造一个「用满了各种能力」的工程，
 * 对每个可用格式做 write → read，然后比对：
 *
 *   - 声明保留但实际丢了的 → 虚假承诺（严重，会让用户以为调好的东西还在）
 *   - 实际保留但没声明的   → 虚假警告（会让用户以为会丢，白白重调）
 */

import { createProject, createTrack, createNote, validateProject, curveValueAt } from './ir.mjs'
import { loadFormat, FORMAT_DEFS } from './formats/index.mjs'

/** 尽量把「能力」铺满的测试工程 */
function richProject() {
  return createProject({
    name: '保真度校验工程',
    tempos: [{ tick: 0, bpm: 120 }, { tick: 1920, bpm: 150 }],
    timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }, { tick: 3840, numerator: 3, denominator: 4 }],
    tracks: [
      createTrack({
        name: '主唱',
        singer: 'Miku(V2)',
        color: '#39c5bb',
        volume: 0.7,
        pan: -0.3,
        notes: [
          createNote({ tick: 0, duration: 480, key: 60, lyric: 'ら', velocity: 88, detune: 12 }),
          createNote({ tick: 480, duration: 480, key: 62, lyric: 'り', attributes: { vibrato: { length: 120, depth: 30, rate: 5.5, delay: 30 } } }),
          createNote({ tick: 960, duration: 480, key: 64, lyric: 'る' }),
        ],
        pitch: { ticks: [0, 240, 480, 960, 1440], values: [60, 60.5, 62, 63.2, 64] },
        parameters: {
          dynamics: { ticks: [0, 480, 960, 1440], values: [0.2, 0.5, 0.7, 0.9] },
          breathiness: { ticks: [0, 960, 1440], values: [0.15, 0.4, 0.65] },
        },
        phonemes: [
          { tick: 0, duration: 120, symbol: 'r', noteIndex: 0 },
          { tick: 120, duration: 360, symbol: 'a', noteIndex: 0 },
        ],
      }),
      createTrack({
        name: '和声',
        singer: 'Miku(V2)',
        notes: [createNote({ tick: 0, duration: 1440, key: 55, lyric: 'あ' })],
      }),
    ],
  })
}

/** 在对象的任意层级里找 key 是否出现过（用于判断数据是否被塞进格式私有 extras） */
function hasKeyDeep(obj, keyRe, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return false
  for (const [k, v] of Object.entries(obj)) {
    if (keyRe.test(k)) return true
    if (v && typeof v === 'object' && hasKeyDeep(v, keyRe, depth + 1)) return true
  }
  return false
}

/**
 * 检查某个能力在往返后是否真的还在。
 *
 * 判定原则：只要数据没丢就算「保留」——很多格式会把无法进 IR 标准位置的信息
 * 放进自己的 extras（例如 vpr 的 note.attributes.vpr），对用户而言那同样是不丢。
 */
function capabilitySurvived(cap, src, dst) {
  switch (cap) {
    case 'notes': {
      const srcTotal = src.tracks.reduce((n, t) => n + t.notes.length, 0)
      const dstTotal = dst.tracks.reduce((n, t) => n + t.notes.length, 0)
      if (dstTotal >= srcTotal) return true
      // 单轨格式（UST 等）只承载一个轨道：这时要求「信息量最大的那个源轨道」被完整保留，
      // 而不是把多轨相加来判定——那对单轨格式永远不成立。
      const maxTrackNotes = Math.max(...src.tracks.map((t) => t.notes.length))
      return dstTotal >= maxTrackNotes
    }
    case 'lyrics':
      return dst.tracks.some((t) => t.notes.some((n) => n.lyric && n.lyric.length))
    case 'tempo':
      return dst.tempos.length >= src.tempos.length
    case 'timeSignature':
      return dst.timeSignatures.length >= src.timeSignatures.length
    case 'multiTrack':
      return dst.tracks.length >= src.tracks.length
    case 'pitchCurve': {
      for (let i = 0; i < src.tracks.length; i += 1) {
        const a = src.tracks[i].pitch
        const b = dst.tracks[i]?.pitch
        if (!a?.ticks?.length) continue
        if (!b?.ticks?.length) return false
        for (const t of [a.ticks[0], a.ticks[a.ticks.length - 1]]) {
          const expected = curveValueAt(a, t)
          const actual = curveValueAt(b, t)
          if (actual === null || Math.abs(actual - expected) > 0.6) return false
        }
      }
      return true
    }
    case 'vibrato':
      // 标准位置是 note.attributes.vibrato；有些格式把颤音存进自己的 extras/attributes 命名空间
      return dst.tracks.some(
        (t) => t.notes.some((n) => n.attributes?.vibrato) || hasKeyDeep(t.extras, /vibrato/i) || t.notes.some((n) => hasKeyDeep(n.attributes, /vibrato/i))
      )
    case 'phonemes':
      // 注意：IR 轨道默认就有空的 phonemes 数组，不能只看属性是否存在，必须看有没有内容
      return dst.tracks.some(
        (t) =>
          (t.phonemes?.length ?? 0) > 0 ||
          t.notes.some((n) => n.phoneme) ||
          hasKeyDeep(t.extras, /phoneme/i) ||
          t.notes.some((n) => hasKeyDeep(n.attributes, /phoneme/i))
      )
    case 'singer':
      return dst.tracks.some((t) => t.singer)
    case 'trackVolume':
      return dst.tracks.some((t) => Math.abs(t.volume - 1) > 1e-6)
    case 'trackPan':
      return dst.tracks.some((t) => Math.abs(t.pan) > 1e-6)
    case 'detune':
      return dst.tracks.some((t) => t.notes.some((n) => n.detune))
    case 'velocity':
      return dst.tracks.some((t) => t.notes.some((n) => n.velocity && n.velocity !== 64))
    default: {
      if (cap.startsWith('params.')) {
        const name = cap.slice('params.'.length)
        return dst.tracks.some((t) => (t.parameters?.[name]?.ticks?.length ?? 0) > 0)
      }
      return null // 未知能力，跳过
    }
  }
}

/** 我们关心的能力全集 */
const CAPS = [
  'notes', 'lyrics', 'tempo', 'timeSignature', 'multiTrack',
  'pitchCurve', 'vibrato', 'phonemes', 'singer', 'trackVolume', 'trackPan',
  'detune', 'velocity', 'params.dynamics', 'params.breathiness',
]

async function main() {
  const src = richProject()
  const issues = validateProject(src)
  if (issues.length) {
    console.error('测试工程本身不合法：', issues.join('; '))
    process.exitCode = 1
    return
  }

  console.log('\n保真度声明校验（声明 vs 实际往返行为）\n')
  let falsePromise = 0
  let falseWarning = 0
  let checked = 0

  for (const def of FORMAT_DEFS) {
    let fmt
    try {
      fmt = await loadFormat(def.id)
    } catch {
      continue
    }
    if (fmt.canWrite === false || fmt.canRead === false) {
      console.log(`○ ${def.id.padEnd(9)} 只读或只写，跳过`)
      continue
    }

    let dst
    try {
      dst = fmt.read(fmt.write(src, { name: src.name }), { name: src.name })
    } catch (err) {
      console.log(`✗ ${def.id.padEnd(9)} 往返抛异常：${err.message}`)
      falsePromise += 1
      continue
    }

    const declared = new Set(fmt.fidelity?.preserves ?? [])
    const actual = new Set()
    for (const cap of CAPS) {
      const survived = capabilitySurvived(cap, src, dst)
      if (survived === true) actual.add(cap)
    }

    const promisedButLost = [...declared].filter((c) => CAPS.includes(c) && !actual.has(c))
    const keptButUnannounced = [...actual].filter((c) => !declared.has(c))
    checked += 1

    const status = promisedButLost.length ? '✗' : keptButUnannounced.length ? '△' : '✓'
    console.log(`${status} ${def.id.padEnd(9)} 保留 ${actual.size}/${CAPS.length} 项能力`)
    if (promisedButLost.length) {
      console.log(`    虚假承诺（声明保留但实际丢了）：${promisedButLost.join(', ')}`)
      falsePromise += promisedButLost.length
    }
    if (keptButUnannounced.length) {
      console.log(`    声明缺失（实际保留了却没说）：${keptButUnannounced.join(', ')} → 会弹出多余的「数据会丢」警告`)
      falseWarning += keptButUnannounced.length
    }
  }

  console.log(`\n检查了 ${checked} 个可读写格式`)
  console.log(`  虚假承诺：${falsePromise} 项${falsePromise ? ' ← 必须修（会误导用户）' : ''}`)
  console.log(`  声明缺失：${falseWarning} 项${falseWarning ? ' ← 建议修（会产生多余警告）' : ''}\n`)

  if (falsePromise > 0) process.exitCode = 1
}

main().catch((err) => {
  console.error('校验脚本异常：', err)
  process.exitCode = 1
})
