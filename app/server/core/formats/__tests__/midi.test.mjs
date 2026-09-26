/**
 * MIDI 模块专项自测
 * 覆盖：真实样本读取、运行状态、变速/变拍号往返、非 480 PPQ 误差、弯音曲线、format 0、
 *       SMPTE 报错、歌词分轨不串轨、validateProject。
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import midi, { meta as midiMeta, fidelity as midiFidelity } from '../midi.mjs'
import { createProject, createNote, validateProject, noteCount, curveValueAt, tickToSec, TPQ } from '../../ir.mjs'
import { BufferWriter } from '../../../util/bytes.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SAMPLES = join(__dirname, '..', '..', '..', '..', '..', 'tests', 'samples')

export default async function run() {
  const notes = []
  let passed = 0
  const check = (label, actual, expected, tol = 1e-6) => {
    const ok =
      typeof expected === 'number' && typeof actual === 'number'
        ? Math.abs(actual - expected) <= tol
        : JSON.stringify(actual) === JSON.stringify(expected)
    if (!ok) throw new Error(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
    passed += 1
  }
  const assert = (cond, label) => {
    if (!cond) throw new Error(label)
    passed += 1
  }

  check('meta.id', midiMeta.id, 'midi')
  check('meta.canRead', midiMeta.canRead, true)
  check('meta.canWrite', midiMeta.canWrite, true)

  /* ---------------------------------------------------------- 1. 真实样本 */
  const sampleFiles = ['sample-C.mid', 'sample-Fs-min.mid']
    .map((f) => join(SAMPLES, f))
    .filter((f) => existsSync(f))
  assert(sampleFiles.length > 0, `tests/samples 下应存在 MIDI 样本，实际查找：${SAMPLES}`)

  let sampleNotes = 0
  for (const file of sampleFiles) {
    const buf = readFileSync(file)
    const proj = midi.read(buf, { name: file })
    const issues = validateProject(proj)
    check(`${file} 校验问题`, issues, [])
    sampleNotes = noteCount(proj)
    assert(sampleNotes > 0, `${file} 应解析出音符，实际 ${sampleNotes}`)
    check(`${file} 轨道数`, proj.tracks.length, 3)
    check(`${file} 音符合计`, sampleNotes, 298)
    check(`${file} 默认速度`, proj.tempos[0].bpm, 120, 1e-9)
    check(`${file} TPQ 直通（PPQ=480）`, proj.tracks[0].notes[0].tick, 0)
    check(`${file} 通道号进 extras`, proj.tracks[0].extras.channel, 0)
    check(`${file} 轨名进 extras`, proj.tracks[0].extras.trackName, 'drum')
    check(`${file} 轨道名`, proj.tracks[1].name, 'piano')
    check(`${file} 第二轨通道`, proj.tracks[2].extras.channel, 1)
    // 样本为 format 1 / PPQ 480，音符号与时长应可用
    const ks = proj.tracks[1].notes.map((n) => n.key)
    assert(ks.every((k) => Number.isInteger(k) && k >= 0 && k <= 127), `${file} 音符号应在 0..127`)
    assert(proj.tracks[0].notes.every((n) => n.duration >= 1), `${file} 时值应为正`)
    notes.push(`${file.split('\\').pop()}：${proj.tracks.length} 轨 / ${sampleNotes} 音符（PPQ 480）`)
  }

  // 样本再写回再读，音符数不应减少
  {
    const file = sampleFiles[0]
    const proj = midi.read(readFileSync(file), { name: file })
    const again = midi.read(midi.write(proj, { name: proj.name }), { name: file })
    check('样本二次往返音符数', noteCount(again), noteCount(proj))
    check('样本二次往返轨道数', again.tracks.length, proj.tracks.length)
    check('样本二次往返校验', validateProject(again), [])
  }

  /* ------------------------------------------------- 2. 变速工程往返 */
  const project = createProject({
    name: 'MIDI 专项测试',
    tempos: [
      { tick: 0, bpm: 120 },
      { tick: 960, bpm: 90 },
      { tick: 1921, bpm: 143.5 },
    ],
    timeSignatures: [
      { tick: 0, numerator: 4, denominator: 4 },
      { tick: 1920, numerator: 3, denominator: 4 },
      { tick: 3840, numerator: 6, denominator: 8 },
    ],
    tracks: [
      {
        name: '主唱',
        notes: [
          { tick: 0, duration: 480, key: 60, lyric: 'la', velocity: 100 },
          { tick: 480, duration: 480, key: 62, lyric: 'li', velocity: 90 },
          { tick: 960, duration: 960, key: 64, lyric: 'lu', velocity: 80 },
          { tick: 1920, duration: 240, key: 67, lyric: 'le', velocity: 70 },
        ],
        pitch: { ticks: [0, 480, 960, 1920, 2160], values: [59.5, 62, 64.25, 66, 67.5] },
      },
      {
        name: '和声',
        notes: [{ tick: 0, duration: 1920, key: 55, lyric: 'あ', velocity: 64 }],
      },
    ],
  })
  check('测试工程本身合法', validateProject(project), [])

  const buf = midi.write(project, { name: project.name })
  assert(Buffer.isBuffer(buf) && buf.length > 0, 'write() 应返回非空 Buffer')
  check('文件头为 MThd', buf.subarray(0, 4).toString('latin1'), 'MThd')
  check('写出 format', buf.readUInt16BE(8), 1)
  check('写出 PPQ', buf.readUInt16BE(12), TPQ)
  check('写出轨道数', buf.readUInt16BE(10), 3) // 指挥轨 + 2 轨

  const back = midi.read(buf, { name: project.name })
  check('往返校验', validateProject(back), [])
  check('速度点数', back.tempos.length, project.tempos.length)
  project.tempos.forEach((t, i) => {
    check(`速度[${i}].tick`, back.tempos[i].tick, t.tick)
    check(`速度[${i}].bpm`, back.tempos[i].bpm, t.bpm, 0.02)
  })
  check('拍号数', back.timeSignatures.length, project.timeSignatures.length)
  project.timeSignatures.forEach((t, i) => {
    check(`拍号[${i}].tick`, back.timeSignatures[i].tick, t.tick)
    check(`拍号[${i}]`, `${back.timeSignatures[i].numerator}/${back.timeSignatures[i].denominator}`, `${t.numerator}/${t.denominator}`)
  })
  check('轨道数', back.tracks.length, project.tracks.length)
  const backNotes = noteCount(back)
  check('音符总数', backNotes, noteCount(project))
  project.tracks.forEach((src, ti) => {
    const dst = back.tracks[ti]
    check(`轨 ${ti} 名`, dst.name, src.name)
    check(`轨 ${ti} 音符数`, dst.notes.length, src.notes.length)
    src.notes.forEach((n, ni) => {
      check(`轨 ${ti} 音符 ${ni} tick`, dst.notes[ni].tick, n.tick)
      check(`轨 ${ti} 音符 ${ni} duration`, dst.notes[ni].duration, n.duration)
      check(`轨 ${ti} 音符 ${ni} key`, dst.notes[ni].key, n.key)
      // 歌词必须保住，且不得串轨
      check(`轨 ${ti} 音符 ${ni} lyric`, dst.notes[ni].lyric, n.lyric)
      check(`轨 ${ti} 音符 ${ni} velocity`, dst.notes[ni].velocity, n.velocity)
    })
  })

  /* --------------------------------------- 3. 音高曲线（弯音）往返 */
  {
    const src = project.tracks[0]
    const dst = back.tracks[0]
    assert(dst.pitch.ticks.length > 0, '应解析出弯音曲线')
    for (const t of [0, 480, 960, 1920, 2160]) {
      const expected = curveValueAt(src.pitch, t)
      const actual = curveValueAt(dst.pitch, t)
      assert(actual !== null, `弯音曲线在 tick ${t} 处丢失`)
      check(`弯音曲线@${t}`, actual, expected, 0.01)
    }
    // 弯音范围可调
    const wide = midi.read(midi.write(project, { name: 'x', pitchBendRange: 12 }), { name: 'x', pitchBendRange: 12 })
    check('自定义 bend range@0', curveValueAt(wide.tracks[0].pitch, 0), curveValueAt(src.pitch, 0), 0.05)
    check('自定义 bend range@2160', curveValueAt(wide.tracks[0].pitch, 2160), curveValueAt(src.pitch, 2160), 0.05)
    notes.push('弯音轮 ±2 半音默认范围往返误差 < 0.01 半音（可用 opts.pitchBendRange 覆盖）')
  }

  /* --------------------------------------- 4. 非 480 PPQ 的往返误差 */
  for (const ppq of [96, 192, 960]) {
    const small = createProject({
      tempos: [
        { tick: 0, bpm: 120 },
        { tick: 1920, bpm: 140 },
      ],
      timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }],
      tracks: [
        {
          name: 'T',
          notes: [
            { tick: 0, duration: 480, key: 60, lyric: 'a' },
            { tick: 480, duration: 121, key: 63, lyric: 'b' },
            { tick: 601, duration: 1319, key: 65, lyric: 'c' },
            { tick: 2400, duration: 480, key: 67, lyric: 'd' },
          ],
        },
      ],
    })
    const file = midi.write(small, { name: 'ppq', ppq })
    check(`PPQ ${ppq} 写入头`, file.readUInt16BE(12), ppq)
    const rt = midi.read(file, { name: 'ppq' })
    check(`PPQ ${ppq} 校验`, validateProject(rt), [])
    check(`PPQ ${ppq} 速度点 tick`, rt.tempos[1].tick, 1920)
    check(`PPQ ${ppq} 速度值`, rt.tempos[1].bpm, 140, 0.02)
    let maxTickErr = 0
    let maxDurErr = 0
    small.tracks[0].notes.forEach((n, i) => {
      const d = rt.tracks[0].notes[i]
      maxTickErr = Math.max(maxTickErr, Math.abs(d.tick - n.tick))
      maxDurErr = Math.max(maxDurErr, Math.abs(d.duration - n.duration))
    })
    assert(maxTickErr < 2, `PPQ ${ppq} 的 tick 误差应 < 2，实际 ${maxTickErr}`)
    assert(maxDurErr < 2, `PPQ ${ppq} 的时长误差应 < 2，实际 ${maxDurErr}`)
    notes.push(`PPQ ${ppq} 往返：最大 tick 误差 ${maxTickErr}、最大时长误差 ${maxDurErr}（均 < 2）`)
  }

  /* --------------------------------------- 5. 手工构造：运行状态 */
  {
    const data = []
    const vlq = (v) => {
      const st = [v & 0x7f]
      let x = v >> 7
      while (x > 0) {
        st.push((x & 0x7f) | 0x80)
        x >>= 7
      }
      return st.reverse()
    }
    data.push(...vlq(0), 0xff, 0x51, 0x03, 0x07, 0xa1, 0x20) // 120 bpm
    data.push(...vlq(0), 0x90, 60, 100) // note on
    data.push(...vlq(480), 62, 90) // 运行状态 note on
    data.push(...vlq(0), 64, 80) // 运行状态 note on（和弦）
    data.push(...vlq(480), 60, 0) // 运行状态，velocity 0 = note off
    data.push(...vlq(0), 62, 0) // 运行状态，velocity 0 = note off
    data.push(...vlq(0), 64, 0) // 运行状态，velocity 0 = note off（和弦音）
    // 再补一个完整的三字节 note off（显式 0x80），验证两种 off 写法都能正确配对
    data.push(...vlq(0), 0x90, 67, 100)
    data.push(...vlq(240), 0x80, 67, 64)
    data.push(...vlq(0), 0xff, 0x2f, 0x00)
    const buf = handMade(data)
    const proj = midi.read(buf, { name: 'runstatus.mid' })
    check('运行状态：速度', proj.tempos[0].bpm, 120, 1e-9)
    check('运行状态：音符数', noteCount(proj), 4)
    check('运行状态：音符号', proj.tracks[0].notes.map((n) => n.key), [60, 62, 64, 67])
    check('运行状态：起点', proj.tracks[0].notes.map((n) => n.tick), [0, 480, 480, 960])
    check('运行状态：时长', proj.tracks[0].notes.map((n) => n.duration), [960, 480, 480, 240])
    check('运行状态：力度', proj.tracks[0].notes.map((n) => n.velocity), [100, 90, 80, 100])
    notes.push('运行状态（running status）与 velocity=0 视作 note off 的行为正确')
  }

  /* --------------------------------------- 6. 手工构造：歌词 + 多通道 */
  {
    const data = []
    const vlq = (v) => {
      const st = [v & 0x7f]
      let x = v >> 7
      while (x > 0) {
        st.push((x & 0x7f) | 0x80)
        x >>= 7
      }
      return st.reverse()
    }
    // 声道 0：歌词 "ka" + note 60
    data.push(...vlq(0), 0xc0, 0x00)
    data.push(...vlq(0), 0xff, 0x05, 0x02, 0x6b, 0x61)
    data.push(...vlq(0), 0x90, 60, 64)
    data.push(...vlq(480), 0x80, 60, 64)
    // 声道 1：歌词 "ki" + note 64
    data.push(...vlq(0), 0xc1, 0x00)
    data.push(...vlq(0), 0xff, 0x05, 0x02, 0x6b, 0x69)
    data.push(...vlq(0), 0x91, 64, 64)
    data.push(...vlq(480), 0x81, 64, 64)
    data.push(...vlq(0), 0xff, 0x2f, 0x00)
    const proj = midi.read(handMade(data), { name: 'lyric.mid' })
    check('歌词：音符数', noteCount(proj), 2)
    // 同一轨道内两个声道 -> 单轨两音符，歌词各自正确
    check('歌词：不串轨', proj.tracks[0].notes.map((n) => n.lyric), ['ka', 'ki'])
    notes.push('多声道歌词按最近通道事件归属，不互相串轨')
  }

  /* --------------------------------------- 7. format 0 读写 */
  {
    const f0 = midi.write(project, { name: 'f0', format: 0 })
    check('format 0 头', f0.readUInt16BE(8), 0)
    check('format 0 轨道数', f0.readUInt16BE(10), 1)
    const rt = midi.read(f0, { name: 'f0' })
    check('format 0 校验', validateProject(rt), [])
    check('format 0 音符总数', noteCount(rt), noteCount(project))
    check('format 0 速度点数', rt.tempos.length, project.tempos.length)
    assert(rt.tracks.length >= 1, 'format 0 至少应有一条轨道')
    notes.push('format 0（单轨合并）与 format 1 均可写出并读回')
  }

  /* --------------------------------------- 8. SMPTE / 非法文件报错 */
  {
    let msg = ''
    try {
      const bad = Buffer.from('MThd', 'latin1')
      const w = new BufferWriter()
      w.bytes(bad).u32be(6).u16be(0).u16be(1).u16be(0xe728) // division 高位为 1
      w.ascii('MTrk').u32be(4).bytes(Buffer.from([0, 0xff, 0x2f, 0]))
      midi.read(w.toBuffer(), { name: 'smpte.mid' })
    } catch (err) {
      msg = String(err.message)
    }
    assert(msg.includes('SMPTE'), `SMPTE 时间码应抛出中文错误，实际：${msg || '(未抛错)'}`)

    let msg2 = ''
    try {
      midi.read(Buffer.from('not a midi file at all', 'utf8'), { name: 'x' })
    } catch (err) {
      msg2 = String(err.message)
    }
    assert(msg2.includes('MThd'), `非 MIDI 文件应抛出可读错误，实际：${msg2 || '(未抛错)'}`)
    notes.push(`容错/报错：SMPTE -> “${msg.slice(0, 40)}…”；非 MIDI -> “${msg2.slice(0, 40)}…”`)
  }

  /* --------------------------------------- 9. 与 IR 时间换算一致 */
  {
    const end = Math.max(...back.tracks.flatMap((t) => t.notes.map((n) => n.tick + n.duration)))
    const sec = tickToSec(end, back.tempos)
    assert(sec > 0, '按速度映射积分应得到正时长')
    passed += 1
  }

  notes.push(`样本音符数（轨道合计）：${sampleNotes}`)
  notes.push(`fidelity.drops：${midiFidelity.drops.join('、')}`)
  return { passed, notes }
}

/** 拼装一个最小 SMF：MThd + 单条 MTrk */
function handMade(dataBytes) {
  const w = new BufferWriter()
  w.ascii('MThd').u32be(6).u16be(0).u16be(1).u16be(480)
  w.ascii('MTrk').u32be(dataBytes.length).bytes(Buffer.from(dataBytes))
  return w.toBuffer()
}
