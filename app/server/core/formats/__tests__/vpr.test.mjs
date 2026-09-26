/**
 * vpr（VOCALOID5/6 工程）格式模块专项自测
 *
 * 重点覆盖：
 *  1. PIT/PBS → 绝对音高（半音）的换算（本模块最容易出错的地方）
 *  2. 自建工程（2 轨 + 变速 + 变拍号 + 音高曲线 + 参数曲线）往返
 *  3. ZIP 容器读写、裸 JSON 容错、坏节点容错
 *  4. tests/samples/ 下真实 VOCALOID5 / VOCALOID6 工程的读取与同格式往返
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createProject, curveValueAt, noteCount, validateProject } from '../../ir.mjs'
import vpr, { __internals, buildVprJson, pitToSemitones, semitonesToPit } from '../vpr.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SAMPLES_DIR = join(__dirname, '..', '..', '..', '..', '..', 'tests', 'samples')

export default async function run() {
  let passed = 0
  const failures = []
  const notes = []

  const check = (label, actual, expected, tol = 1e-6) => {
    const ok =
      typeof actual === 'number' && typeof expected === 'number'
        ? Math.abs(actual - expected) <= tol
        : JSON.stringify(actual) === JSON.stringify(expected)
    if (ok) passed += 1
    else failures.push(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
  const assert = (cond, label) => {
    if (cond) passed += 1
    else failures.push(label)
  }
  const throws = (label, fn, re) => {
    try {
      fn()
      failures.push(`${label}：本应抛错但没有`)
    } catch (err) {
      if (re && !re.test(String(err.message))) failures.push(`${label}：错误信息不符（${err.message}）`)
      else passed += 1
    }
  }
  const maxDeviation = (notes0, curve) => {
    let worst = 0
    for (let i = 0; i < curve.ticks.length; i += 1) {
      const key = __internals.keyAtTick(notes0, curve.ticks[i])
      worst = Math.max(worst, Math.abs(curve.values[i] - key))
    }
    return worst
  }

  /* ============ A. PIT / PBS 换算（关键正确性点） ============ */

  check('pitToSemitones(2048, PBS=2) ≈ 0.5 半音', pitToSemitones(2048, 2), 0.5, 1e-3)
  check('pitToSemitones(8191, PBS=2) = 2 半音', pitToSemitones(8191, 2), 2, 1e-4)
  check('pitToSemitones(-8191, PBS=4) = -4 半音', pitToSemitones(-8191, 4), -4, 1e-4)
  check('pitToSemitones(4096, PBS=1) = 0.5 半音', pitToSemitones(4096, 1), 0.5, 1e-4)
  check('semitonesToPit(0.5, PBS=2) = 2048', semitonesToPit(0.5, 2), 2048)
  check('semitonesToPit(2, PBS=2) = 8191', semitonesToPit(2, 2), 8191)
  check('semitonesToPit(-1.5, PBS=3) = -4095', semitonesToPit(-1.5, 3), -4095)
  let pitWorst = 0
  for (const sens of [1, 2, 3, 8, 24]) {
    for (const semi of [-1, -0.4, 0, 0.25, 0.9, 1.9, 7.5, 24]) {
      if (Math.abs(semi) > sens) continue // 超出灵敏度会被裁剪，另行断言
      pitWorst = Math.max(pitWorst, Math.abs(pitToSemitones(semitonesToPit(semi, sens), sens) - semi))
    }
  }
  check('PIT 往返误差 < 0.005 半音', pitWorst < 0.005, true)
  check('PIT 值被裁剪到 ±8191', semitonesToPit(99, 1), 8191)
  check('非法 PBS 回落到缺省 2', pitToSemitones(2048, 0), 0.5, 1e-3)

  /* ============ B. 自建工程往返 ============ */

  const src = createProject({
    name: 'vpr 自测工程',
    tempos: [
      { tick: 0, bpm: 120 },
      { tick: 1920, bpm: 132.5 },
      { tick: 4800, bpm: 96 },
    ],
    timeSignatures: [
      { tick: 0, numerator: 4, denominator: 4 },
      { tick: 3840, numerator: 7, denominator: 8 },
      { tick: 7200, numerator: 3, denominator: 4 },
    ],
    tracks: [
      {
        name: '主唱',
        singer: 'Hatsune Miku V4X',
        language: 'ja',
        notes: [
          { tick: 0, duration: 480, key: 60, lyric: 'ら', velocity: 100, detune: 15, phoneme: '4 a' },
          { tick: 480, duration: 480, key: 64, lyric: 'り' },
          { tick: 960, duration: 960, key: 67, lyric: 'る' },
          { tick: 2400, duration: 480, key: 60, lyric: 'れ' },
        ],
        pitch: {
          ticks: [0, 240, 480, 960, 1440, 1920, 2400, 2880],
          values: [60, 62, 66.5, 64, 67, 69, 60.5, 57],
        },
        parameters: {
          dynamics: { ticks: [0, 960, 2880], values: [0.1, 0.55, 1] },
          breathiness: { ticks: [0, 1440], values: [0.25, 0.8] },
          gender: { ticks: [0, 1920], values: [0.5, 0.9] },
          portamento: { ticks: [480], values: [0.35] },
        },
      },
      {
        name: '和声',
        muted: true,
        volume: 0.5,
        pan: -0.25,
        notes: [{ tick: 0, duration: 1920, key: 55, lyric: 'あ' }],
      },
      { name: '空轨', notes: [] },
    ],
  })

  check('自建工程本身合法', validateProject(src), [])

  /*
   * 本机已装声库（模拟）。应用层每次都会把真实的已装列表传进来，
   * 所以测试也按真实调用方式来：writer 只用这个列表里的 compID。
   */
  const installedForTest = [{ compID: 'BCNFCY43LB2LZCD4', name: 'MIKU_V4X_Original_EVEC' }]

  const buf = vpr.write(src, { name: src.name, installedVoices: installedForTest })
  assert(Buffer.isBuffer(buf) && buf.length > 0, 'write() 应返回非空 Buffer')
  assert(buf[0] === 0x50 && buf[1] === 0x4b, 'write() 应输出 ZIP 容器（PK 头）')

  const json = buildVprJson(src)
  check('写出版本号', json.version, { major: 5, minor: 0, revision: 0 })
  check('写出 vender', json.vender, 'Yamaha Corporation')
  check('写出速度事件值 = bpm×100', json.masterTrack.tempo.events, [
    { pos: 0, value: 12000 },
    { pos: 1920, value: 13250 },
    { pos: 4800, value: 9600 },
  ])
  check(
    '拍号事件按小节表示（变拍号落在小节线上）',
    json.masterTrack.timeSig.events,
    [
      { bar: 0, denom: 4, numer: 4 },
      { bar: 2, denom: 8, numer: 7 },
      { bar: 4, denom: 4, numer: 3 },
    ]
  )
  const jsonNotes = json.tracks[0].parts[0].notes
  check('写出音符数', jsonNotes.length, 4)
  check('写出音符 pos/duration/number', [jsonNotes[0].pos, jsonNotes[0].duration, jsonNotes[0].number], [0, 480, 60])
  check('写出音符 velocity', jsonNotes[0].velocity, 100)
  check('写出音符 detune', jsonNotes[0].detune, 15)
  check('写出音符 phoneme', jsonNotes[0].phoneme, '4 a')
  check('写出音符 exp.opening', jsonNotes[0].exp.opening, 127)
  check('写出音符 vibrato', jsonNotes[0].vibrato, { type: 0, duration: 0 })
  const jsonControllers = json.tracks[0].parts[0].controllers
  const sensCtrl = jsonControllers.find((c) => c.name === 'pitchBendSens')
  assert(!!sensCtrl, '偏差超过 2 半音时应写出 pitchBendSens')
  check('pitchBendSens 灵敏度 = ceil(最大偏差 3)', sensCtrl.events[0].value, 3)
  check('pitchBendSens 末尾恢复缺省 2', sensCtrl.events[sensCtrl.events.length - 1].value, 2)
  const pitCtrl = jsonControllers.find((c) => c.name === 'pitchBend')
  check('PIT 事件数', pitCtrl.events.length, 8)
  check('PIT 值 = 半音偏移 × 8191 / PBS', pitCtrl.events[3].value, semitonesToPit(-3, 3))
  check('PIT 全部落在 ±8191 内', pitCtrl.events.every((e) => Math.abs(e.value) <= 8191), true)
  check('控制器名归一（gender → character）', jsonControllers.map((c) => c.name).sort(), [
    'breathiness',
    'character',
    'dynamics',
    'pitchBend',
    'pitchBendSens',
    'portamento',
  ])
  check('空轨道不产生 part', json.tracks[2].parts, [])
  /*
   * 声库分配的铁律：**绝不写出本机不存在的 compID**。
   *
   * 真实事故：SynthV 工程里的歌手是 AI 声库（GUMI AI / Kasane Teto AI 2），
   * 本机根本没有对应的 VOCALOID 声库。旧实现按歌手名 hash 出一个假 compID 写进工程，
   * VOCALOID 打开时按 compID 查不到声库，直接报错拒绝加载 —— 用户看到的就是「编辑器打不开」。
   *
   * 现在的行为：没有匹配就退用本机已装声库（这里传入了 installedVoices），
   * 并在 report.voiceSubstitutions 里记录替换，由应用层提示用户进去手动换一次声库。
   */
  const reportBox = {}
  const bufWithVoices = vpr.write(src, { installedVoices: installedForTest, report: reportBox })
  const jsonWithVoices = JSON.parse(__internals.unzipEntries(bufWithVoices).find((e) => e.name.endsWith('sequence.json')).data.toString('utf8'))
  check(
    '声库表只用本机已装的 compID（不按歌手名造 ID）',
    jsonWithVoices.voices.map((v) => v.compID),
    ['BCNFCY43LB2LZCD4']
  )
  check('未匹配的歌手被记入 report', (reportBox.voiceSubstitutions ?? []).length > 0, true)
  // 模板（UtaFormatix template.vprjson）里轨道是有 name 的，所以默认写出来
  check('写出 tracks[].name（模板里有该字段）', 'name' in jsonWithVoices.tracks[0], true)

  /*
   * ZIP 条目名以 UtaFormatix3 的写作为准（core/io/Vpr.kt 的 possibleJsonPaths.first()）：
   * 单个条目 `Project\sequence.json`（反斜杠），不带 Project/Audio/ 目录。
   * VOCALOID 是 .NET 程序，解压后按条目名精确查找，名字不一致会取到 null 并抛异常。
   */
  const entries = __internals.unzipEntries(buf)
  check('ZIP 条目数（默认单条目）', entries.length, 1)
  check('默认 ZIP 条目名为 VOCALOID5 的反斜杠写法', entries.map((e) => e.name), ['Project\\sequence.json'])
  const v6Buf = vpr.write(src, { v6EntryName: true })
  check('可切换为 VOCALOID6 的正斜杠写法 + Audio 目录', __internals.unzipEntries(v6Buf).map((e) => e.name).sort(), [
    'Project/Audio/',
    'Project/sequence.json',
  ])
  check('反斜杠条目同样可回读', vpr.read(buf).tracks[0].notes.length, 4)
  check('正斜杠条目同样可回读', vpr.read(v6Buf).tracks[0].notes.length, 4)
  check('opts.voiceMap 可注入本机声库 compID', buildVprJson(src, {
    voiceMap: { 'Hatsune Miku V4X': 'BLECA76YHKRGXLB7' },
  }).voices.map((v) => v.compID), ['BLECA76YHKRGXLB7', 'BCXDC6CZLSZHZCB4'])

  const back = vpr.read(buf, { name: src.name })
  check('回读工程合法', validateProject(back), [])
  check('回读工程名', back.name, 'vpr 自测工程')
  check('回读轨道数', back.tracks.length, 3)
  check('回读速度点数', back.tempos.length, 3)
  src.tempos.forEach((t, i) => {
    check(`回读 tempo[${i}].tick`, back.tempos[i].tick, t.tick)
    check(`回读 tempo[${i}].bpm`, back.tempos[i].bpm, t.bpm, 1e-9)
  })
  check('回读拍号数', back.timeSignatures.length, 3)
  src.timeSignatures.forEach((s, i) => {
    check(`回读拍号[${i}].tick`, back.timeSignatures[i].tick, s.tick)
    check(`回读拍号[${i}].numerator`, back.timeSignatures[i].numerator, s.numerator)
    check(`回读拍号[${i}].denominator`, back.timeSignatures[i].denominator, s.denominator)
  })
  check('回读 track0 音符数', back.tracks[0].notes.length, 4)
  src.tracks[0].notes.forEach((n, i) => {
    const b = back.tracks[0].notes[i]
    check(`回读音符[${i}].tick`, b.tick, n.tick)
    check(`回读音符[${i}].duration`, b.duration, n.duration)
    check(`回读音符[${i}].key`, b.key, n.key)
    check(`回读音符[${i}].lyric`, b.lyric, n.lyric)
    check(`回读音符[${i}].velocity`, b.velocity, n.velocity)
    check(`回读音符[${i}].detune`, b.detune, n.detune)
  })
  check('回读音素数（空音素 → null）', [back.tracks[0].notes[0].phoneme, back.tracks[0].notes[1].phoneme], ['4 a', null])
  check('回读音符 attributes.vpr.exp 保留', back.tracks[0].notes[0].attributes.vpr.exp, { opening: 127 })
  check('回读音符 attributes.vpr.vibrato 保留', back.tracks[0].notes[0].attributes.vpr.vibrato, {
    type: 0,
    duration: 0,
  })
  /*
   * 回读歌手：这里不再期望原歌手名。
   * 「Hatsune Miku V4X」在本机没有对应 VOCALOID 声库，写出时按铁律替换成了本机已装声库，
   * 所以回读到的歌手名是本机声库的名字 —— 具体是哪个不重要，重要的是它必须来自本机已装列表。
   */
  check('回读轨道歌手（已被替换为本机已装声库）', back.tracks[0].singer, 'MIKU_V4X_Original_EVEC')
  check('回读轨道语言', back.tracks[0].language, 'ja')
  check('回读 track1 muted', back.tracks[1].muted, true)
  check('回读 track1 volume ≈ 0.5（dB 换算）', back.tracks[1].volume, 0.5, 0.02)
  check('回读 track1 pan', back.tracks[1].pan, -0.25, 1e-9)
  check('回读空轨仍存在且无音符', back.tracks[2].notes.length, 0)

  check('回读音高曲线点数', back.tracks[0].pitch.ticks.length, src.tracks[0].pitch.ticks.length)
  let pitchWorst = 0
  for (const t of src.tracks[0].pitch.ticks) {
    pitchWorst = Math.max(pitchWorst, Math.abs(curveValueAt(back.tracks[0].pitch, t) - curveValueAt(src.tracks[0].pitch, t)))
  }
  check('回读音高曲线最大偏差 < 0.001 半音', pitchWorst < 0.001, true)
  for (const name of ['dynamics', 'breathiness', 'gender', 'portamento']) {
    assert(!!back.tracks[0].parameters[name], `回读参数曲线 ${name} 应存在`)
    let worst = 0
    for (const t of src.tracks[0].parameters[name].ticks) {
      worst = Math.max(
        worst,
        Math.abs(curveValueAt(back.tracks[0].parameters[name], t) - curveValueAt(src.tracks[0].parameters[name], t))
      )
    }
    check(`回读参数曲线 ${name} 误差 < 1/127`, worst < 1 / 127, true)
  }
  check('和声轨无音高曲线', back.tracks[1].pitch.ticks, [])

  // 二次往返（幂等）
  const again = vpr.read(vpr.write(back))
  check('二次往返音符数', again.tracks[0].notes.length, 4)
  check('二次往返拍号', again.timeSignatures, back.timeSignatures)
  check('二次往返速度', again.tempos, back.tempos)
  check('二次往返合法', validateProject(again), [])

  // 裸 JSON 容器
  const jsonBuf = vpr.write(src, { container: 'json' })
  assert(jsonBuf[0] === 0x7b, 'container=json 应输出裸 JSON')
  const fromJson = vpr.read(jsonBuf)
  check('裸 JSON 回读音符数', fromJson.tracks[0].notes.length, 4)
  check('裸 JSON 回读音高', curveValueAt(fromJson.tracks[0].pitch, 960), curveValueAt(src.tracks[0].pitch, 960), 0.001)

  /* ============ C. 容错 ============ */

  throws('非 ZIP 非 JSON 输入应报错', () => vpr.read(Buffer.from('这不是工程文件', 'utf8')), /vpr：/)
  throws('空 Buffer 应报错', () => vpr.read(Buffer.alloc(0)), /vpr：/)
  throws('非 Buffer 入参应报错', () => vpr.read('字符串'), /vpr：/)
  throws(
    'ZIP 内缺少 sequence.json 应报错',
    () => vpr.read(__internals.zipEntries([{ name: 'other.json', data: Buffer.from('{}') }])),
    /sequence\.json/
  )
  throws('缺少 tracks/masterTrack 应报错', () => vpr.read(Buffer.from('{"foo":1}')), /vpr：/)

  const tolerant = {
    version: { major: 5, minor: 0, revision: 0 },
    title: '容错',
    masterTrack: {
      tempo: { events: [{ pos: 0, value: 'x' }, { pos: 0, value: 10000 }] },
      timeSig: { events: [{ bar: 2, numer: 4, denom: 4 }, { bar: 0, numer: 4, denom: 4 }] },
    },
    tracks: [
      {
        type: 0,
        parts: [
          {
            pos: 960,
            duration: 1920,
            notes: [
              { pos: 0, duration: 240, number: 60, lyric: 'a' },
              { pos: 'bad', duration: 240, number: 62, lyric: 'b' },
              { pos: 240, duration: 240, number: 200, lyric: 'c' },
              { pos: 480, duration: 0, number: 64, lyric: 'd' },
            ],
            controllers: [
              { name: 'pitchBend', events: [{ pos: 0, value: 2048 }, { pos: 'x', value: 1 }] },
              { name: 'xsy', events: [{ pos: 0, value: 64 }] },
            ],
          },
        ],
      },
      null,
    ],
  }
  const tolProj = vpr.read(Buffer.from(JSON.stringify(tolerant), 'utf8'))
  check('容错：坏速度事件被跳过', tolProj.tempos, [{ tick: 0, bpm: 100 }])
  check('容错：拍号按小节排序并补 4/4', tolProj.timeSignatures, [
    { tick: 0, numerator: 4, denominator: 4 },
    { tick: 3840, numerator: 4, denominator: 4 },
  ])
  check('容错：坏音符被跳过', tolProj.tracks[0].notes.length, 3)
  check('容错：part.pos 计入音符 tick', tolProj.tracks[0].notes.map((n) => n.tick), [960, 1200, 1440])
  check('容错：key 越界被裁剪', tolProj.tracks[0].notes[1].key, 127)
  check('容错：duration 0 修正为 1', tolProj.tracks[0].notes[2].duration, 1)
  check('容错：坏 null 轨道被跳过', tolProj.tracks.length, 1)
  check('容错：PIT 依 part.pos 偏移', tolProj.tracks[0].pitch.ticks, [960])
  check('容错：PIT 相对音符换算（60 + 2048×2/8191）', tolProj.tracks[0].pitch.values[0], 60.5, 0.001)
  check('容错：未映射控制器进入 extras', tolProj.tracks[0].extras.vpr.controllers.map((c) => c.name), ['xsy'])
  assert(
    tolProj.extras.vpr.warnings.some((w) => w.includes('xsy')),
    '容错：未映射控制器应产生告警'
  )
  check('容错工程合法', validateProject(tolProj), [])

  // 无速度事件 → 120 兜底
  const noTempo = vpr.read(Buffer.from(JSON.stringify({ masterTrack: {}, tracks: [] }), 'utf8'))
  check('无速度事件时兜底 120 BPM', noTempo.tempos, [{ tick: 0, bpm: 120 }])

  // 内部工具
  check('keyAtTick：音符内', __internals.keyAtTick([{ tick: 0, duration: 480, key: 60 }], 100), 60)
  check('keyAtTick：最后一个音符之后取末值', __internals.keyAtTick([{ tick: 0, duration: 480, key: 60 }], 900), 60)
  check('keyAtTick：空音符表返回 null', __internals.keyAtTick([], 0), null)
  check('hashId 形态', /^CV[A-Z0-9]{14}$/.test(__internals.hashId('Hatsune Miku V4X', 'CV')), true)
  check('hashId 稳定', __internals.hashId('a') === __internals.hashId('a'), true)
  check('measureIndexAt(3840, 4/4)', __internals.measureIndexAt(3840, [
    { tick: 0, numerator: 4, denominator: 4 },
  ]), { measure: 2, measureStart: 3840, measureTicks: 1920 })
  check('measureStartTick(4, 4/4→7/8)', __internals.measureStartTick(4, [
    { tick: 0, numerator: 4, denominator: 4 },
    { tick: 3840, numerator: 7, denominator: 8 },
  ]), 7200)

  // 小节内部的拍号变化无法被 VPR 表示，写回时对齐到小节起点（已记入 fidelity.drops）
  const midMeasure = createProject({
    timeSignatures: [
      { tick: 0, numerator: 4, denominator: 4 },
      { tick: 2880, numerator: 3, denominator: 4 },
    ],
    tracks: [{ name: 't', notes: [{ tick: 0, duration: 480, key: 60, lyric: 'a' }] }],
  })
  const midJson = buildVprJson(midMeasure)
  check('小节内拍号变化对齐到小节起点', midJson.masterTrack.timeSig.events, [
    { bar: 0, denom: 4, numer: 4 },
    { bar: 1, denom: 4, numer: 3 },
  ])
  check('小节内拍号变化回读 tick 被对齐', vpr.read(vpr.write(midMeasure)).timeSignatures, [
    { tick: 0, numerator: 4, denominator: 4 },
    { tick: 1920, numerator: 3, denominator: 4 },
  ])

  /* ============ D. 真实样本 ============ */

  const sampleFiles = existsSync(SAMPLES_DIR)
    ? readdirSync(SAMPLES_DIR)
        .filter((f) => f.toLowerCase().endsWith('.vpr'))
        .map((f) => join(SAMPLES_DIR, f))
    : []
  if (!sampleFiles.length) {
    notes.push('tests/samples/ 下没有 .vpr 真实样本，已跳过样本验证')
  }
  for (const file of sampleFiles) {
    const name = file.split(/[\\/]/).pop()
    const buf2 = readFileSync(file)
    const proj = vpr.read(buf2, { name })
    const count = noteCount(proj)
    assert(count > 0, `样本 ${name} 应解析出音符`)
    check(`样本 ${name} 解析结果合法`, validateProject(proj), [])
    notes.push(`样本 ${name}：${proj.tracks.length} 轨 / ${count} 音符 / ${proj.tempos[0].bpm} BPM`)

    // 同格式往返（保留原版本与结构）
    const rt = vpr.read(vpr.write(proj))
    check(`样本 ${name} 往返轨道数`, rt.tracks.length, proj.tracks.length)
    check(`样本 ${name} 往返音符数`, noteCount(rt), count)
    check(`样本 ${name} 往返速度`, rt.tempos, proj.tempos)
    check(`样本 ${name} 往返拍号`, rt.timeSignatures, proj.timeSignatures)
    check(`样本 ${name} 往返版本号`, rt.extras.vpr.version, proj.extras.vpr.version)
    check(`样本 ${name} 往返工程名`, rt.name, proj.name)
    check(`样本 ${name} 往返合法`, validateProject(rt), [])

    const sample1 = proj.tracks.find((t) => t.pitch.ticks.length > 0)
    if (sample1) {
      // 真实工程里 PIT 恒在 ±2048 内，按 8191/PBS=2 换算正好是 ±0.5 半音；
      // 若把满量程当 2048 或忽略 PBS，这里会得到约 ±2 半音而失败。
      const dev = maxDeviation(sample1.notes, sample1.pitch)
      assert(dev > 0.4 && dev <= 0.6, `样本 ${name} 音高曲线应贴合音符 ±0.5 半音（实测 ${dev.toFixed(3)}）`)
      const rtTrack = rt.tracks[proj.tracks.indexOf(sample1)]
      let worst = 0
      for (const t of sample1.pitch.ticks) {
        worst = Math.max(worst, Math.abs(curveValueAt(rtTrack.pitch, t) - curveValueAt(sample1.pitch, t)))
      }
      check(`样本 ${name} 往返音高曲线最大偏差 < 0.01 半音`, worst < 0.01, true)
      notes.push(`样本 ${name}：音高曲线 ${sample1.pitch.ticks.length} 点，最大偏差 ${dev.toFixed(3)} 半音`)
    }
  }

  const sample1Path = sampleFiles.find((f) => /real-sample-1\.vpr$/.test(f))
  if (sample1Path) {
    const proj = vpr.read(readFileSync(sample1Path))
    check('样本1 版本 5.0.0', proj.extras.vpr.version, { major: 5, minor: 0, revision: 0 })
    check('样本1 速度 86 BPM', proj.tempos[0].bpm, 86)
    check('样本1 轨 0 歌手（来自 voices 表）', proj.tracks[0].singer, 'VY2V3')
    check('样本1 轨 0 音符数', proj.tracks[0].notes.length, 284)
    assert(proj.tracks[0].pitch.ticks.length > 1000, '样本1 音高曲线应有上千个点')
  }
  const sample2Path = sampleFiles.find((f) => /real-sample-2\.vpr$/.test(f))
  if (sample2Path) {
    const proj = vpr.read(readFileSync(sample2Path))
    check('样本2 版本 6.1.0', proj.extras.vpr.version, { major: 6, minor: 1, revision: 0 })
    check('样本2 轨数', proj.tracks.length, 4)
    check('样本2 速度 145 BPM', proj.tempos[0].bpm, 145)
    check('样本2 轨 0 歌手', proj.tracks[0].singer, 'RIN_V4X_Sweet')
    check('样本2 轨 0 参数曲线名', Object.keys(proj.tracks[0].parameters).sort(), [
      'brightness',
      'clearness',
      'dynamics',
      'gender',
    ])
    check('样本2 动态曲线范围', [
      Math.min(...proj.tracks[0].parameters.dynamics.values),
      Math.max(...proj.tracks[0].parameters.dynamics.values),
    ], [43 / 127, 117 / 127], 1e-9)
    check('样本2 语言（langID 0 → ja）', proj.tracks[0].language, 'ja')
    check('样本2 轨 2 声像', proj.tracks[2].pan, 4 / 64, 1e-9)
    const rt6 = vpr.read(vpr.write(proj))
    check('样本2 往返仍为 6.1.0', rt6.extras.vpr.version, { major: 6, minor: 1, revision: 0 })
    check('样本2 往返音符数', noteCount(rt6), noteCount(proj))
    check('样本2 往返保留 note.aiExp', !!rt6.tracks[0].notes[0].attributes.vpr.aiExp, true)
    check('样本2 往返保留 midiEffects', rt6.tracks[0].extras.vpr.midiEffects.map((m) => m.id), [
      'SingingSkill',
      'VoiceColor',
      'RobotVoice',
      'DefaultLyric',
      'Breath',
      'Take',
    ])
  }

  if (failures.length) {
    throw new Error(`vpr 专项自测 ${failures.length} 项失败：\n  - ${failures.join('\n  - ')}`)
  }
  return { passed, notes }
}

// 允许单独运行：node app/server/core/formats/__tests__/vpr.test.mjs
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('__tests__/vpr.test.mjs')) {
  run().then((r) => {
    console.log(`✓ 通过 ${r.passed} 项断言`)
    for (const n of r.notes) console.log('  · ' + n)
  })
}
