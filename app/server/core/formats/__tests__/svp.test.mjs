/**
 * svp 模块专项自测
 *
 * 重点覆盖：
 *  1. blick(705600000/Q) <-> IR tick(480/Q) 的换算精度（1/16、附点、三连音、五连音…）
 *  2. 含 2 轨、变速、变拍号、音高曲线、参数曲线的规范工程往返
 *  3. 手写 .svp（含颤音属性、音素、相对 cent 音高曲线）的读取语义
 *  4. tests/samples/ 下的真实 .svp 样本读取 + 同格式无损往返
 */

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createProject, validateProject, curveValueAt, noteCount, TPQ } from '../../ir.mjs'
import { canonicalProject } from '../../selftest.mjs'
import svp, {
  meta,
  fidelity,
  read,
  write,
  blickToTick,
  tickToBlick,
  BLICK_PER_QUARTER,
  BLICK_PER_TICK,
} from '../svp.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SAMPLES_DIR = join(__dirname, '..', '..', '..', '..', '..', 'tests', 'samples')

/* ------------------------------------------------------------- 断言工具 */

function makeAsserter() {
  const state = { passed: 0, failed: 0, notes: [] }
  const check = (label, actual, expected, tol = 1e-9) => {
    const ok =
      typeof expected === 'number' && typeof actual === 'number'
        ? Math.abs(actual - expected) <= tol
        : JSON.stringify(actual) === JSON.stringify(expected)
    if (ok) state.passed += 1
    else {
      state.failed += 1
      throw new Error(
        `${label} 不符：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`,
      )
    }
  }
  const ok = (cond, label) => {
    if (cond) state.passed += 1
    else {
      state.failed += 1
      throw new Error(label)
    }
  }
  return { state, check, ok }
}

/* --------------------------------------------------------------- 主测试 */

export default async function run() {
  const { state, check, ok } = makeAsserter()

  /* ---------- 1. blick 换算精度 ---------- */

  check('BLICK_PER_QUARTER 常量', BLICK_PER_QUARTER, 705600000)
  check('1 tick 的 blick 数', BLICK_PER_TICK, 1470000)
  ok('705600000 % 480 === 0（整除）', BLICK_PER_QUARTER % TPQ === 0)

  // 常见时值（单位 tick）与它们对应的精确 blick：1 tick = 1470000 blick
  const durations = [
    ['1/1', 1920, 2822400000],
    ['1/2', 960, 1411200000],
    ['附点 1/4', 720, 1058400000],
    ['1/4', 480, 705600000],
    ['三连音 1/4', 320, 470400000],
    ['附点 1/8', 360, 529200000],
    ['1/8', 240, 352800000],
    ['三连音 1/8', 160, 235200000],
    ['1/16', 120, 176400000],
    ['附点 1/16', 180, 264600000],
    ['三连音 1/16', 80, 117600000],
    ['1/32', 60, 88200000],
    ['五连音 1/16', 96, 141120000],
  ]
  let maxErr = 0
  for (const [label, tick, blick] of durations) {
    const b = tickToBlick(tick)
    check(`${label}: tick ${tick} -> ${blick} blick`, b, blick)
    check(`${label}: blick ${blick} -> tick ${tick}`, blickToTick(blick), tick)
    maxErr = Math.max(maxErr, Math.abs(blickToTick(blick) - tick))
  }
  check('整 tick 时值换算最大误差', maxErr, 0)

  // 非整数 tick 的时值（七连音、十一连音等）：误差必须 < 1 tick
  const oddDurations = [
    ['七连音 1/8', 352800000 / 7],
    ['十一连音 1/8', 352800000 / 11],
    ['十三连音 1/4', 705600000 / 13],
    ['1/64', 44100000 / 2],
    ['自由拖动的 1000001 blick', 1000001],
  ]
  for (const [label, blick] of oddDurations) {
    const err = Math.abs(tickToBlick(blickToTick(blick)) - blick) / BLICK_PER_TICK
    ok(`${label}（${blick} blick）换算误差 ${err.toFixed(6)} tick 应 < 1`, err < 1)
    maxErr = Math.max(maxErr, err)
  }

  // 非整 tick 的极端情况：随机扫描，误差必须 < 1 tick
  let worst = 0
  let worstBlick = 0
  let seed = 12345
  for (let i = 0; i < 200000; i += 1) {
    seed = (seed * 1103515245 + 12345) % 2147483648
    const blick = seed * 7919 // 覆盖各种非整除余数
    const tick = blickToTick(blick)
    const err = Math.abs(tickToBlick(tick) - blick) / BLICK_PER_TICK
    if (err > worst) {
      worst = err
      worstBlick = blick
    }
  }
  ok(`20 万个随机 blick 的最大往返误差 ${worst.toFixed(6)} tick 应 < 1`, worst < 1)
  state.notes.push(`blick 换算最大误差 ${worst.toFixed(6)} tick（最坏样本 blick=${worstBlick}）`)

  // 非整数 blick（编辑器拖动可能产生）也要落在 1 tick 内
  for (const raw of [117600000.4, 88200000.4999, 705599999.6, 1470000.5, 0.4, 1e12 + 7]) {
    const t = blickToTick(raw)
    ok(`非整数 blick ${raw} 应落在 1 tick 内`, Math.abs(tickToBlick(t) - raw) / BLICK_PER_TICK < 1)
  }

  /* ---------- 2. 元信息 ---------- */

  check('meta.id', meta.id, 'svp')
  ok('meta 含 .svp 扩展名', meta.exts.includes('.svp'))
  ok('meta 可读可写', meta.canRead === true && meta.canWrite === true)
  ok('fidelity 声明了 preserves/drops', Array.isArray(fidelity.preserves) && Array.isArray(fidelity.drops))

  /* ---------- 3. 规范工程往返 ---------- */

  const src = canonicalProject()
  check('规范工程自身合法', validateProject(src), [])

  const buf = write(src, { name: src.name })
  ok('write() 返回非空 Buffer', Buffer.isBuffer(buf) && buf.length > 0)

  const parsedJson = JSON.parse(buf.toString('utf8'))
  check('写出顶层 version', parsedJson.version, 113)
  ok('写出含 time.meter', Array.isArray(parsedJson.time.meter))
  ok('写出含 time.tempo', Array.isArray(parsedJson.time.tempo))
  ok('写出含 renderConfig', !!parsedJson.renderConfig)
  ok('写出含 library 数组', Array.isArray(parsedJson.library))
  check('写出轨道数', parsedJson.tracks.length, 2)
  check('拍号 index 0', parsedJson.time.meter[0].index, 0)
  check('拍号 index 1（第 3 小节）', parsedJson.time.meter[1].index, 2)
  check('第 2 个速度点 blick', parsedJson.time.tempo[1].position, 1920 * BLICK_PER_TICK)
  check('首音符 duration blick', parsedJson.tracks[0].mainGroup.notes[0].duration, 480 * BLICK_PER_TICK)
  check('首音符 lyrics 字段名', parsedJson.tracks[0].mainGroup.notes[0].lyrics, 'ら')
  check('首音符 pitch', parsedJson.tracks[0].mainGroup.notes[0].pitch, 60)
  ok('mainGroup/mainRef uuid 一致', parsedJson.tracks[0].mainGroup.uuid === parsedJson.tracks[0].mainRef.groupID)
  ok(
    '音符必需属性齐全',
    ['onset', 'duration', 'lyrics', 'phonemes', 'pitch', 'attributes'].every(
      (k) => k in parsedJson.tracks[0].mainGroup.notes[0],
    ),
  )

  const back = read(buf, { name: src.name })
  check('回读工程合法', validateProject(back), [])
  check('回读轨道数', back.tracks.length, 2)
  check('回读速度数', back.tempos.length, 2)
  check('回读速度[1].tick', back.tempos[1].tick, 1920)
  check('回读速度[1].bpm', back.tempos[1].bpm, 140, 1e-9)
  check('回读拍号数', back.timeSignatures.length, 2)
  check('回读拍号[1].tick', back.timeSignatures[1].tick, 3840)
  check('回读拍号[1] 3/4', [back.timeSignatures[1].numerator, back.timeSignatures[1].denominator], [3, 4])

  check('轨 0 音符数', back.tracks[0].notes.length, 4)
  const expNotes = src.tracks[0].notes
  back.tracks[0].notes.forEach((n, i) => {
    check(`轨 0 音符 ${i} tick`, n.tick, expNotes[i].tick)
    check(`轨 0 音符 ${i} duration`, n.duration, expNotes[i].duration)
    check(`轨 0 音符 ${i} key`, n.key, expNotes[i].key)
    check(`轨 0 音符 ${i} lyric`, n.lyric, expNotes[i].lyric)
  })
  check('轨 1 音符 lyric', back.tracks[1].notes[0].lyric, 'あ')
  check('轨 1 音符 key', back.tracks[1].notes[0].key, 55)
  check('轨 1 音符 duration', back.tracks[1].notes[0].duration, 1920)

  // 音高曲线：绝对半音，逐点比对
  const srcPitch = src.tracks[0].pitch
  const dstPitch = back.tracks[0].pitch
  ok('音高曲线有点', dstPitch.ticks.length > 0)
  srcPitch.ticks.forEach((t) => {
    const expected = curveValueAt(srcPitch, t)
    const actual = curveValueAt(dstPitch, t)
    ok(`音高曲线@${t} 存在`, actual !== null)
    check(`音高曲线@${t}`, actual, expected, 0.02)
  })
  check('音高曲线首点', dstPitch.values[0], 60, 0.02)
  check('音高曲线末点绝对值', dstPitch.values[dstPitch.values.length - 1], 67, 0.02)

  // 参数曲线：dynamics / breathiness
  const srcDyn = src.tracks[0].parameters.dynamics
  const dstDyn = back.tracks[0].parameters.dynamics
  ok('dynamics 曲线存在', !!dstDyn && dstDyn.ticks.length > 0)
  srcDyn.ticks.forEach((t) => check(`dynamics@${t}`, curveValueAt(dstDyn, t), curveValueAt(srcDyn, t), 1e-6))
  const srcBre = src.tracks[0].parameters.breathiness
  const dstBre = back.tracks[0].parameters.breathiness
  srcBre.ticks.forEach((t) => check(`breathiness@${t}`, curveValueAt(dstBre, t), curveValueAt(srcBre, t), 1e-6))

  // 轨道元数据
  check('轨 0 名称', back.tracks[0].name, src.tracks[0].name)
  check('轨 0 颜色', back.tracks[0].color, src.tracks[0].color)
  check('轨 0 语言', back.tracks[0].language, 'ja')
  check('轨 0 歌手', back.tracks[0].singer, 'TestSinger')

  /* ---------- 4. 多轨 / 变拍号 / 变速 / 细腻时值 的完整往返 ---------- */

  const rich = createProject({
    name: 'rich',
    tempos: [
      { tick: 0, bpm: 96.5 },
      { tick: 1440, bpm: 133.25 },
      { tick: 5280, bpm: 72 },
    ],
    timeSignatures: [
      { tick: 0, numerator: 4, denominator: 4 },
      { tick: 1920, numerator: 6, denominator: 8 },
      { tick: 3840, numerator: 4, denominator: 4 }, // SynthV 的小节号锚在 4/4 网格上
    ],
    tracks: [
      {
        name: '细腻时值',
        singer: 'Singer A',
        language: 'zh',
        color: '#ff8800',
        notes: [
          { tick: 0, duration: 180, key: 60, lyric: '一' }, // 附点 1/16
          { tick: 180, duration: 80, key: 62, lyric: '二' }, // 三连音 1/16
          { tick: 260, duration: 240, key: 64, lyric: '三' }, // 1/8
          { tick: 500, duration: 120, key: 65, lyric: '四' }, // 1/16
          { tick: 620, duration: 720, key: 67, lyric: '五' }, // 附点 1/4
        ],
        pitch: { ticks: [0, 180, 260, 500, 620, 1340], values: [60, 61.5, 63.25, 64.75, 66.5, 67] },
        parameters: {
          dynamics: { ticks: [0, 500, 1340], values: [0.05, 0.6, 1] },
          tension: { ticks: [0, 1340], values: [0.25, 0.75] },
          gender: { ticks: [0, 1340], values: [0.1, 0.9] },
          voicing: { ticks: [0, 1340], values: [0.2, 0.8] },
          breathiness: { ticks: [0, 1340], values: [0.3, 0.7] },
        },
      },
      {
        name: '和声',
        notes: [{ tick: 960, duration: 320, key: 55, lyric: 'la' }],
      },
    ],
  })

  const richBack = read(write(rich, { name: 'rich' }), { name: 'rich' })
  check('rich 往返合法', validateProject(richBack), [])
  check('rich 轨道数', richBack.tracks.length, 2)
  check('rich 温度点数', richBack.tempos.length, 3)
  check('rich bpm[1]', richBack.tempos[1].bpm, 133.25, 1e-9)
  check('rich 拍号数', richBack.timeSignatures.length, 3)
  check('rich 拍号[1] tick', richBack.timeSignatures[1].tick, 1920)
  check('rich 拍号[1] 6/8', [richBack.timeSignatures[1].numerator, richBack.timeSignatures[1].denominator], [6, 8])
  check('rich 拍号[2] tick', richBack.timeSignatures[2].tick, 3840)
  rich.tracks[0].notes.forEach((n, i) => {
    check(`rich 音符 ${i} tick`, richBack.tracks[0].notes[i].tick, n.tick)
    check(`rich 音符 ${i} duration`, richBack.tracks[0].notes[i].duration, n.duration)
    check(`rich 音符 ${i} key`, richBack.tracks[0].notes[i].key, n.key)
    check(`rich 音符 ${i} lyric`, richBack.tracks[0].notes[i].lyric, n.lyric)
  })
  rich.tracks[0].pitch.ticks.forEach((t) => {
    check(
      `rich 音高@${t}`,
      curveValueAt(richBack.tracks[0].pitch, t),
      curveValueAt(rich.tracks[0].pitch, t),
      0.02,
    )
  })
  for (const key of ['dynamics', 'tension', 'gender', 'voicing', 'breathiness']) {
    const a = rich.tracks[0].parameters[key]
    const b = richBack.tracks[0].parameters[key]
    ok(`rich 参数 ${key} 存在`, !!b && b.ticks.length > 0)
    a.ticks.forEach((t) => check(`rich 参数 ${key}@${t}`, curveValueAt(b, t), curveValueAt(a, t), 1e-6))
  }
  check('rich 轨 0 语言', richBack.tracks[0].language, 'zh')
  check('rich 轨 0 名称', richBack.tracks[0].name, '细腻时值')

  // 参数原生范围方向检查：dynamics 0 -> -48dB, 1 -> +12dB（此处 0.05 -> -45dB）
  const rawDyn = JSON.parse(write(rich, { name: 'rich' }).toString('utf8')).tracks[0].mainGroup.parameters.loudness
  check('loudness points 为扁平数组', Array.isArray(rawDyn.points) && typeof rawDyn.points[0] === 'number', true)
  check('loudness 0.05 -> -45dB', rawDyn.points[1], -45, 1e-6)
  check('loudness@end 为 +12dB', rawDyn.points[rawDyn.points.length - 1], 12, 1e-6)
  const rawGender = JSON.parse(write(rich, { name: 'rich' }).toString('utf8')).tracks[0].mainGroup.parameters.gender
  check('gender 0.1 -> -0.8', rawGender.points[1], -0.8, 1e-6)
  check('gender 0.9 -> +0.8', rawGender.points[rawGender.points.length - 1], 0.8, 1e-6)
  const rawPitch = JSON.parse(write(rich, { name: 'rich' }).toString('utf8')).tracks[0].mainGroup.parameters.pitchDelta
  check('pitchDelta@0 为相对 cent（60-60=0）', rawPitch.points[1], 0, 1e-6)
  check('pitchDelta@180 为相对 cent（61.5-62=-50）', rawPitch.points[3], -50, 1e-6)
  check('pitchDelta@260 为相对 cent（63.25-64=-75）', rawPitch.points[5], -75, 1e-6)

  /* ---------- 5. 手写 .svp 语义：颤音 / 音素 / 相对音高 / 拍号 / 速度 ---------- */

  const handWritten = {
    version: 113,
    time: {
      meter: [
        { index: 0, numerator: 4, denominator: 4 },
        { index: 2, numerator: 3, denominator: 4 },
      ],
      tempo: [
        { position: 0, bpm: 120 },
        { position: 3840 * BLICK_PER_TICK, bpm: 150 },
      ],
    },
    library: [],
    tracks: [
      {
        name: 'Hand',
        dispColor: 'ff3366cc',
        dispOrder: 0,
        renderEnabled: true,
        mixer: { gainDecibel: -6, pan: -0.5, mute: false, solo: true, display: true },
        mainGroup: {
          name: 'main',
          uuid: '11111111-2222-3333-4444-555555555555',
          parameters: {
            pitchDelta: { mode: 'cubic', points: [0, 50, 480 * BLICK_PER_TICK, -100] },
            vibratoEnv: { mode: 'cubic', points: [0, 1, 960 * BLICK_PER_TICK, 0.5] },
            loudness: { mode: 'cubic', points: [0, 0, 960 * BLICK_PER_TICK, 6] },
            tension: { mode: 'cubic', points: [0, 0.5] },
            breathiness: { mode: 'cubic', points: [0, -1] },
            voicing: { mode: 'cubic', points: [0, 1] },
            gender: { mode: 'cubic', points: [0, 0.25] },
          },
          notes: [
            {
              onset: 0,
              duration: 480 * BLICK_PER_TICK,
              lyrics: 'ka',
              phonemes: 'k a',
              pitch: 60,
              attributes: {
                tF0VbrStart: 0.25,
                tF0VbrLeft: 0.2,
                tF0VbrRight: 0.2,
                dF0Vbr: 1.2,
                fF0Vbr: 5.5,
                pF0Vbr: 0.1,
              },
            },
            {
              onset: 480 * BLICK_PER_TICK,
              duration: 480 * BLICK_PER_TICK,
              lyrics: 'na',
              phonemes: '',
              pitch: 62,
              attributes: {},
            },
          ],
        },
        mainRef: {
          groupID: '11111111-2222-3333-4444-555555555555',
          blickOffset: 0,
          pitchOffset: 0,
          isInstrumental: false,
          database: { name: 'Saki', language: 'japanese', phoneset: '' },
          audio: { filename: '', duration: 0 },
          dictionary: '',
          voice: {},
        },
        groups: [],
      },
    ],
    renderConfig: { destination: './', filename: 'hand', numChannels: 1, sampleRate: 44100 },
  }

  const handRead = read(Buffer.from(JSON.stringify(handWritten), 'utf8'), { name: 'hand.svp' })
  check('手写样本合法', validateProject(handRead), [])
  check('手写轨道名', handRead.tracks[0].name, 'Hand')
  check('手写颜色', handRead.tracks[0].color, '#3366cc')
  check('手写歌手', handRead.tracks[0].singer, 'Saki')
  check('手写语言', handRead.tracks[0].language, 'ja')
  check('手写 solo', handRead.tracks[0].solo, true)
  check('手写 pan', handRead.tracks[0].pan, -0.5, 1e-9)
  check('手写 volume(-6dB -> 0.9)', handRead.tracks[0].volume, 0.9, 1e-9)
  check('手写拍号[1] tick', handRead.timeSignatures[1].tick, 3840)
  check('手写拍号[1] 3/4', [handRead.timeSignatures[1].numerator, handRead.timeSignatures[1].denominator], [3, 4])
  check('手写速度[1] tick', handRead.tempos[1].tick, 3840)
  check('手写速度[1] bpm', handRead.tempos[1].bpm, 150)

  const handNotes = handRead.tracks[0].notes
  check('手写音符数', handNotes.length, 2)
  check('手写音符 0 tick', handNotes[0].tick, 0)
  check('手写音符 0 duration', handNotes[0].duration, 480)
  check('手写音符 0 key', handNotes[0].key, 60)
  check('手写音符 0 lyric', handNotes[0].lyric, 'ka')
  check('手写音符 0 phoneme', handNotes[0].phoneme, 'k')
  check('手写音符 1 tick', handNotes[1].tick, 480)

  // 相对 cent 曲线 -> 绝对半音：note0 key=60, note1 key=62
  check('音高曲线@0 绝对 = 60 + 50/100', curveValueAt(handRead.tracks[0].pitch, 0), 60.5, 1e-9)
  check('音高曲线@480 绝对 = 62 - 100/100', curveValueAt(handRead.tracks[0].pitch, 480), 61, 1e-9)

  // 参数归一化
  check('loudness 0dB -> 0.8', curveValueAt(handRead.tracks[0].parameters.dynamics, 0), 0.8, 1e-6)
  check('loudness 6dB -> 0.9', curveValueAt(handRead.tracks[0].parameters.dynamics, 960), 0.9, 1e-6)
  check('breathiness -1 -> 1', curveValueAt(handRead.tracks[0].parameters.breathiness, 0), 1, 1e-6)
  check('voicing 1 -> 1', curveValueAt(handRead.tracks[0].parameters.voicing, 0), 1, 1e-6)
  check('gender 0.25 -> 0.625', curveValueAt(handRead.tracks[0].parameters.gender, 0), 0.625, 1e-6)
  check('tension 0.5 -> 0.75', curveValueAt(handRead.tracks[0].parameters.tension, 0), 0.75, 1e-6)

  // 音符级颤音
  const vib = handNotes[0].attributes.vibrato
  ok('颤音 attributes 存在', !!vib)
  check('颤音 depth 单位音分', vib.depth, 120, 1e-6)
  check('颤音 rate 单位 Hz', vib.rate, 5.5, 1e-6)
  check('颤音 delay 0.25s@120bpm -> 240 tick', vib.delay, 240)
  check('颤音 length 0.4s@120bpm -> 384 tick', vib.length, 384)
  check('原始颤音属性保留', handNotes[0].attributes.sv.tF0VbrStart, 0.25)
  check('音素时间轴', handRead.tracks[0].phonemes.map((p) => p.symbol), ['k', 'a'])
  check('音素 0 tick', handRead.tracks[0].phonemes[0].tick, 0)
  check('音素 1 tick', handRead.tracks[0].phonemes[1].tick, 240)

  // 同格式写回：原始 blick 与 mode 应逐字节保留
  const handOut = JSON.parse(write(handRead, { name: 'hand' }).toString('utf8'))
  check('同格式往返 pitchDelta.points 原样', handOut.tracks[0].mainGroup.parameters.pitchDelta.points, [0, 50, 480 * BLICK_PER_TICK, -100])
  check('同格式往返 loudness 原样', handOut.tracks[0].mainGroup.parameters.loudness, { mode: 'cubic', points: [0, 0, 960 * BLICK_PER_TICK, 6] })
  check('同格式往返 vibratoEnv 原样', handOut.tracks[0].mainGroup.parameters.vibratoEnv, { mode: 'cubic', points: [0, 1, 960 * BLICK_PER_TICK, 0.5] })
  check('同格式往返 uuid', handOut.tracks[0].mainGroup.uuid, handOut.tracks[0].mainRef.groupID)
  check('同格式往返拍号 index', handOut.time.meter[1].index, 2)
  check('同格式往返 tempo position', handOut.time.tempo[1].position, 3840 * BLICK_PER_TICK)
  check('同格式往返颤音属性', handOut.tracks[0].mainGroup.notes[0].attributes.dF0Vbr, 1.2)
  check('同格式往返 phonemes', handOut.tracks[0].mainGroup.notes[0].phonemes, 'k a')

  /* ---------- 5.5 从「非 svp 来源」的 IR 写出（跨格式转换主路径） ---------- */

  const foreign = createProject({
    name: 'foreign',
    sourceFormat: 'vsqx', // 非 svp：必须由 IR 生成 pitchDelta，不能复用任何原生缓存
    tempos: [{ tick: 0, bpm: 100 }],
    timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }],
    tracks: [
      {
        name: 'Foreign',
        language: 'en',
        notes: [
          { tick: 0, duration: 120, key: 60, lyric: 'a' },
          { tick: 120, duration: 120, key: 62, lyric: 'b' },
          { tick: 240, duration: 120, key: 64, lyric: 'c' },
        ],
        // 绝对音高：60、62.5（=62 上方 50 音分）、63（=64 下方 100 音分）
        pitch: { ticks: [0, 120, 240], values: [60, 62.5, 63] },
        parameters: { dynamics: { ticks: [0, 240], values: [0, 1] } },
      },
    ],
  })
  const foreignOut = JSON.parse(write(foreign, { name: 'foreign' }).toString('utf8'))
  const fPitch = foreignOut.tracks[0].mainGroup.parameters.pitchDelta
  check('跨格式：pitchDelta@0 = 0 cent', fPitch.points[1], 0, 1e-6)
  check('跨格式：pitchDelta@120 = +50 cent（相对 key 62）', fPitch.points[3], 50, 1e-6)
  check('跨格式：pitchDelta@240 = -100 cent（相对 key 64）', fPitch.points[5], -100, 1e-6)
  check('跨格式：pitchDelta 的 blick 位置', fPitch.points[2], 120 * BLICK_PER_TICK)
  check('跨格式：loudness 0..1 -> -48..+12 dB', [foreignOut.tracks[0].mainGroup.parameters.loudness.points[1], foreignOut.tracks[0].mainGroup.parameters.loudness.points[3]], [-48, 12])
  check('跨格式：library 为空数组', foreignOut.library, [])
  check('跨格式：language en -> english', foreignOut.tracks[0].mainRef.database.language, 'english')
  ok('跨格式：mainGroup uuid 是合法 UUID', /^[0-9a-f-]{36}$/i.test(foreignOut.tracks[0].mainGroup.uuid))
  ok('跨格式：uuid 非空且与 mainRef 一致', foreignOut.tracks[0].mainGroup.uuid === foreignOut.tracks[0].mainRef.groupID)
  const foreignBack = read(write(foreign, { name: 'foreign' }), { name: 'foreign.svp' })
  check('跨格式往返合法', validateProject(foreignBack), [])
  check('跨格式往返音符数', foreignBack.tracks[0].notes.length, 3)
  foreign.tracks[0].pitch.ticks.forEach((t) =>
    check(`跨格式往返音高@${t}`, curveValueAt(foreignBack.tracks[0].pitch, t), curveValueAt(foreign.tracks[0].pitch, t), 0.02),
  )
  foreign.tracks[0].notes.forEach((n, i) => {
    check(`跨格式往返音符 ${i} tick`, foreignBack.tracks[0].notes[i].tick, n.tick)
    check(`跨格式往返音符 ${i} duration`, foreignBack.tracks[0].notes[i].duration, n.duration)
    check(`跨格式往返音符 ${i} key`, foreignBack.tracks[0].notes[i].key, n.key)
  })
  check('跨格式往返 language', foreignBack.tracks[0].language, 'en')

  /* ---------- 5.6 大工程压力：多轨 + 密集曲线 + 非整 tick 时值 ---------- */

  const bigNotes = []
  const bigPitchTicks = []
  const bigPitchValues = []
  for (let i = 0; i < 400; i += 1) {
    // 交替使用三连音/附点等非整拍时值
    const dur = i % 3 === 0 ? 160 : i % 3 === 1 ? 180 : 240
    bigNotes.push({ tick: 0, duration: dur, key: 48 + (i % 24), lyric: `s${i % 10}` })
    bigPitchTicks.push(0)
    bigPitchValues.push(48 + (i % 24) + ((i % 5) - 2) / 4)
  }
  let cursor = 0
  bigNotes.forEach((n, i) => {
    n.tick = cursor
    bigPitchTicks[i] = cursor
    cursor += n.duration
  })
  const big = createProject({
    name: 'big',
    tempos: [
      { tick: 0, bpm: 128 },
      { tick: 1920, bpm: 90 },
    ],
    timeSignatures: [
      { tick: 0, numerator: 4, denominator: 4 },
      { tick: 1920, numerator: 3, denominator: 4 },
    ],
    tracks: [0, 1, 2].map((k) => ({
      name: `T${k}`,
      notes: bigNotes.map((n, i) => ({ ...n, tick: n.tick + k * 0, key: n.key + k })),
      pitch: { ticks: bigPitchTicks, values: bigPitchValues.map((v) => v + k) },
      parameters: {
        dynamics: { ticks: [0, 500, 1000, 2000], values: [0.1, 0.4, 0.7, 1] },
        breathiness: { ticks: [0, 2000], values: [0.2, 0.9] },
        tension: { ticks: [0, 2000], values: [0.3, 0.8] },
      },
    })),
  })
  const bigBack = read(write(big, { name: 'big' }), { name: 'big.svp' })
  check('大工程往返合法', validateProject(bigBack), [])
  check('大工程轨道数', bigBack.tracks.length, 3)
  check('大工程音符总数', noteCount(bigBack), 1200)
  check('大工程速度点数', bigBack.tempos.length, 2)
  let bigMismatch = 0
  for (let ti = 0; ti < 3; ti += 1) {
    const a = big.tracks[ti].notes
    const b = bigBack.tracks[ti].notes
    for (let i = 0; i < a.length; i += 1) {
      if (b[i].tick !== a[i].tick || b[i].duration !== a[i].duration || b[i].key !== a[i].key) bigMismatch += 1
    }
    for (const t of big.tracks[ti].pitch.ticks) {
      if (Math.abs(curveValueAt(bigBack.tracks[ti].pitch, t) - curveValueAt(big.tracks[ti].pitch, t)) > 0.02) bigMismatch += 1
    }
  }
  check('大工程 1200 音符 tick/duration/key 全部一致', bigMismatch, 0)

  /* ---------- 6. 容错 ---------- */

  const messy = {
    version: 113,
    time: {
      meter: [{ index: 0, numerator: 4, denominator: 4 }, { index: 1, numerator: 0, denominator: 7 }],
      tempo: [{ position: 0, bpm: 0 }, { position: 0, bpm: 128 }],
    },
    tracks: [
      {
        name: 'Messy',
        mainGroup: {
          uuid: 'u1',
          parameters: {},
          notes: [
            { onset: -1, duration: 480 * BLICK_PER_TICK, lyrics: 'x', pitch: 60, attributes: {} },
            { onset: 0, duration: 0, lyrics: 'y', pitch: 61, attributes: {} },
            { onset: 0, duration: null, lyrics: 'z', pitch: 62, attributes: {} },
            { onset: 0, duration: 240 * BLICK_PER_TICK, lyrics: 'ok', pitch: 63, attributes: {} },
            { onset: 'x', duration: 480, lyrics: 'bad', pitch: 64, attributes: {} },
          ],
        },
        mainRef: { groupID: 'u1' },
      },
    ],
  }
  const messyRead = read(Buffer.from(JSON.stringify(messy), 'utf8'), { name: 'messy.svp' })
  check('容错：非法拍号被丢弃', messyRead.timeSignatures.length, 1)
  check('容错：bpm=0 被丢弃', messyRead.tempos.length, 1)
  check('容错：bpm 取有效值', messyRead.tempos[0].bpm, 128)
  // 5 个音符里 3 个不可用（duration=0、duration=null、onset 非数字），保留 2 个
  check('容错：坏音符被跳过', messyRead.tracks[0].notes.length, 2)
  ok('容错：所有音符 tick >= 0', messyRead.tracks[0].notes.every((n) => n.tick >= 0 && n.duration >= 1))
  check('容错：负 onset 被夹到 0', messyRead.tracks[0].notes[0].tick, 0)
  check('容错：保留音符 0 duration', messyRead.tracks[0].notes[0].duration, 480)
  check('容错：保留音符 0 lyric', messyRead.tracks[0].notes[0].lyric, 'x')
  check('容错：保留音符 1 duration', messyRead.tracks[0].notes[1].duration, 240)
  check('容错：保留音符 1 lyric', messyRead.tracks[0].notes[1].lyric, 'ok')
  check('容错：validateProject 为空', validateProject(messyRead), [])

  let threw = ''
  try {
    read(Buffer.from('这不是 JSON', 'utf8'))
  } catch (err) {
    threw = err.message
  }
  ok('完全无法识别时抛出中文错误', threw.includes('svp') && /[\u4e00-\u9fa5]/.test(threw))
  threw = ''
  try {
    read(Buffer.from('{"foo":1}', 'utf8'))
  } catch (err) {
    threw = err.message
  }
  ok('缺少 tracks 时抛出可读错误', /tracks/.test(threw))

  threw = ''
  try {
    read(Buffer.alloc(0))
  } catch (err) {
    threw = err.message
  }
  ok('空文件抛出可读错误', threw.length > 0 && /[\u4e00-\u9fa5]/.test(threw))

  threw = ''
  try {
    read(12345)
  } catch (err) {
    threw = err.message
  }
  ok('非 Buffer 输入抛出可读错误', /Buffer/.test(threw))

  threw = ''
  try {
    write(createProject({ tracks: [] }))
  } catch (err) {
    threw = err.message
  }
  ok('零轨道工程写出时抛出可读错误', threw.length > 0 && /[\u4e00-\u9fa5]/.test(threw))

  // 边界：空轨道（有轨但无音符）也要能写出合法文件
  const emptyTrack = createProject({ name: 'empty', tracks: [{ name: '空轨' }] })
  check('空轨道工程合法', validateProject(emptyTrack), [])
  const emptyOut = JSON.parse(write(emptyTrack, { name: 'empty' }).toString('utf8'))
  check('空轨道写出音符数组', emptyOut.tracks[0].mainGroup.notes, [])
  check('空轨道写出 pitchDelta.points', emptyOut.tracks[0].mainGroup.parameters.pitchDelta.points, [])
  const emptyBack = read(write(emptyTrack, { name: 'empty' }), { name: 'empty.svp' })
  check('空轨道回读合法', validateProject(emptyBack), [])
  check('空轨道回读轨道数', emptyBack.tracks.length, 1)
  check('空轨道回读音符数', noteCount(emptyBack), 0)
  check('空轨道回读名称', emptyBack.tracks[0].name, '空轨')

  /* ---------- 7. 真实样本 ---------- */

  const samplePath = join(SAMPLES_DIR, 'real-sample-1.svp')
  if (existsSync(samplePath)) {
    const sampleBuf = readFileSync(samplePath)
    const sample = read(sampleBuf, { name: 'real-sample-1.svp' })
    check('样本合法', validateProject(sample), [])
    check('样本轨道数', sample.tracks.length, 1)
    check('样本音符数', noteCount(sample), 1)
    check('样本音符 tick', sample.tracks[0].notes[0].tick, 0)
    check('样本音符 duration 1/4', sample.tracks[0].notes[0].duration, 480)
    check('样本音符 key', sample.tracks[0].notes[0].key, 60)
    check('样本音符 lyric', sample.tracks[0].notes[0].lyric, 'la')
    check('样本速度', sample.tempos[0].bpm, 120)
    check('样本拍号', [sample.timeSignatures[0].numerator, sample.timeSignatures[0].denominator], [4, 4])
    check('样本 color', sample.tracks[0].color, '#7db235')
    ok('样本 renderConfig 保留', !!sample.extras.svp.renderConfig)

    // 同格式往返：结构应与原文件等价
    const reOut = JSON.parse(write(sample, { name: 'real-sample-1' }).toString('utf8'))
    check('样本往返音符 duration blick', reOut.tracks[0].mainGroup.notes[0].duration, 705600000)
    check('样本往返 version', reOut.version, 113)
    check('样本往返 library', reOut.library, [])
    check('样本往返 meter index', reOut.time.meter[0].index, 0)
    check('样本往返 tempo bpm', reOut.time.tempo[0].bpm, 120)
    check('样本往返音符 attrs', reOut.tracks[0].mainGroup.notes[0].phonemes, '')
    const backAgain = read(write(sample, { name: 'real-sample-1' }), { name: 'real-sample-1.svp' })
    check('样本二次往返合法', validateProject(backAgain), [])
    check('样本二次往返音符数', noteCount(backAgain), 1)
    check('样本二次往返音高', backAgain.tracks[0].notes[0].key, 60)

    state.notes.push(`真实样本 real-sample-1.svp：${sample.tracks.length} 轨 / ${noteCount(sample)} 音符，同格式往返无损`)
  } else {
    state.notes.push('未找到 tests/samples/real-sample-1.svp，跳过真实样本验证')
  }

  // SynthV Studio 2 生成的工程（version 153，尾部带 NUL，含 instrumental 轨）
  const sample2Path = join(SAMPLES_DIR, 'real-sample-2.svp')
  if (existsSync(sample2Path)) {
    const buf2 = readFileSync(sample2Path)
    const s2 = read(buf2, { name: 'real-sample-2.svp' })
    check('样本2 合法', validateProject(s2), [])
    check('样本2 version 被识别', s2.extras.svp.version, 153)
    check('样本2 轨道数（含 2 条 instrumental）', s2.tracks.length, 3)
    check('样本2 音符数', noteCount(s2), 360)
    check('样本2 歌手名', s2.tracks[0].singer, 'GUMI AI')
    check('样本2 语言', s2.tracks[0].language, 'ja')
    check('样本2 颜色', s2.tracks[0].color, '#7db235')
    check('样本2 速度', s2.tempos[0].bpm, 72)
    ok('样本2 音高曲线非空', s2.tracks[0].pitch.ticks.length > 0)
    ok(
      '样本2 音高曲线为绝对半音（贴近音符 key）',
      Math.abs(s2.tracks[0].pitch.values[0] - s2.tracks[0].notes[0].key) < 24,
    )
    ok('样本2 参数曲线 tension 非空', (s2.tracks[0].parameters.tension?.ticks.length ?? 0) > 0)
    ok('样本2 音素时间轴非空', s2.tracks[0].phonemes.length > 0)
    check('样本2 第二条轨为 instrumental（无音符）', s2.tracks[1].notes.length, 0)
    check('样本2 第二条轨 mute', s2.tracks[1].muted, true)
    ok('样本2 v2 原始字段保留（systemPitchDelta/pitchTakes）', !!s2.tracks[0].extras.svp.rawMainRef.systemPitchDelta)

    const s2out = write(s2, { name: 'real-sample-2' })
    const s2back = read(s2out, { name: 'real-sample-2.svp' })
    check('样本2 往返合法', validateProject(s2back), [])
    check('样本2 往返轨道数', s2back.tracks.length, 3)
    check('样本2 往返音符数', noteCount(s2back), 360)
    check('样本2 往返音高点数', s2back.tracks[0].pitch.ticks.length, s2.tracks[0].pitch.ticks.length)
    let s2worst = 0
    for (const t of s2.tracks[0].pitch.ticks) {
      const a = curveValueAt(s2.tracks[0].pitch, t)
      const b = curveValueAt(s2back.tracks[0].pitch, t)
      if (b === null) s2worst = Infinity
      else s2worst = Math.max(s2worst, Math.abs(a - b))
    }
    check('样本2 音高曲线往返无偏差（半音）', s2worst, 0, 1e-9)
    check('样本2 往返音量（-6.9dB）', s2back.tracks[2].volume, (60 - 6.9) / 60, 1e-6)
    check('样本2 往返 tempo', JSON.stringify(s2back.tempos), JSON.stringify(s2.tempos))
    check('样本2 往返拍号', JSON.stringify(s2back.timeSignatures), JSON.stringify(s2.timeSignatures))
    check('样本2 往返首音符', [s2back.tracks[0].notes[0].tick, s2back.tracks[0].notes[0].duration, s2back.tracks[0].notes[0].key, s2back.tracks[0].notes[0].lyric], [16800, 480, 56, 'AP'])
    state.notes.push(`真实样本 real-sample-2.svp（SynthV 2 / version 153）：3 轨 / 360 音符 / ${s2.tracks[0].pitch.ticks.length} 音高点，往返无损`)
  } else {
    state.notes.push('未找到 tests/samples/real-sample-2.svp，跳过 SynthV 2 样本验证')
  }

  if (state.failed > 0) throw new Error(`svp 专项测试失败 ${state.failed} 项`)
  return { passed: state.passed, notes: state.notes }
}
