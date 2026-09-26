/**
 * ufdata 格式模块专项自测
 *
 * 除通用往返外，重点校验：
 *   - 写出的 JSON 字段名与 UtaFormatix Data v1 规范完全一致
 *     （tickOn/tickOff、tickPosition、measurePosition、isAbsolute ...）；
 *   - 能读入 UtaFormatix 网页版导出的规范文件（含相对音高、measurePrefix）；
 *   - 容错：旧字段名、坏音符、BOM、超版本号、完全无法识别时的中文报错。
 */

import { createProject, createNote, validateProject, curveValueAt } from '../../ir.mjs'
import { read, write, meta, fidelity } from '../ufdata.mjs'

/** 一个纯规范文件（形如 UtaFormatix 网页版导出的 .ufdata） */
function pureDocument() {
  return {
    formatVersion: 1,
    project: {
      name: 'Pure',
      tracks: [
        {
          name: 'T1',
          notes: [
            { tickOn: 0, tickOff: 480, key: 60, lyric: 'a' },
            { tickOn: 480, tickOff: 960, key: 62, lyric: 'i', phoneme: 'i' },
          ],
          pitch: { ticks: [0, 240, 480], values: [0, 0.5, 1], isAbsolute: false },
        },
      ],
      timeSignatures: [
        { measurePosition: 0, numerator: 4, denominator: 4 },
        { measurePosition: 2, numerator: 3, denominator: 4 },
      ],
      tempos: [
        { tickPosition: 0, bpm: 100 },
        { tickPosition: 960, bpm: 150.5 },
      ],
      measurePrefix: 0,
    },
  }
}

export default async function run(ctx = {}) {
  const check =
    ctx.check ??
    ((label, actual, expected, tol = 1e-6) => {
      const ok =
        typeof expected === 'number' && typeof actual === 'number'
          ? Math.abs(actual - expected) <= tol
          : JSON.stringify(actual) === JSON.stringify(expected)
      if (!ok) throw new Error(`${label}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
    })
  const assert =
    ctx.assert ??
    ((cond, label) => {
      if (!cond) throw new Error(label)
    })

  const notes = []
  let passed = 0
  const ok = (label, actual, expected, tol) => {
    passed += 1
    check(label, actual, expected, tol)
  }
  const yes = (cond, label) => {
    passed += 1
    assert(cond, label)
  }

  const parse = (buf) => JSON.parse(buf.toString('utf8'))

  /* ---------------------------------------------------- 1) 字段名与结构 */
  const canonical = ctx.canonicalProject ? ctx.canonicalProject() : defaultCanonical()
  const doc = parse(write(canonical))

  ok('formatVersion', doc.formatVersion, 1)
  ok('project.name', doc.project.name, '自测工程 Selftest')
  yes('project.tracks 是数组', Array.isArray(doc.project.tracks))
  ok('轨道数', doc.project.tracks.length, 2)
  ok('轨道名', doc.project.tracks[0].name, '主唱')
  const note0 = doc.project.tracks[0].notes[0]
  ok('音符 tickOn', note0.tickOn, 0)
  ok('音符 tickOff', note0.tickOff, 480)
  ok('音符 key', note0.key, 60)
  ok('音符 lyric', note0.lyric, 'ら')
  yes('音符不含旧字段 tick', !('tick' in note0))
  yes('音符不含旧字段 duration', !('duration' in note0))
  ok('速度字段 tickPosition', doc.project.tempos[0].tickPosition, 0)
  ok('速度字段 bpm', doc.project.tempos[0].bpm, 120)
  ok('速度数量', doc.project.tempos.length, 2)
  ok('速度 2 tickPosition', doc.project.tempos[1].tickPosition, 1920)
  ok('速度 2 bpm', doc.project.tempos[1].bpm, 140)
  ok('拍号字段 measurePosition', doc.project.timeSignatures[0].measurePosition, 0)
  ok('拍号 numerator', doc.project.timeSignatures[0].numerator, 4)
  ok('拍号 denominator', doc.project.timeSignatures[0].denominator, 4)
  ok('拍号 2 measurePosition（3840 tick = 第 2 小节）', doc.project.timeSignatures[1].measurePosition, 2)
  ok('拍号 2 numerator', doc.project.timeSignatures[1].numerator, 3)
  ok('measurePrefix', doc.project.measurePrefix, 0)
  const pitch0 = doc.project.tracks[0].pitch
  ok('pitch.ticks', pitch0.ticks, [0, 480, 960, 1920, 2400])
  ok('pitch.values', pitch0.values, [60, 62, 64, 65, 67])
  ok('pitch.isAbsolute', pitch0.isAbsolute, true)
  ok('无音高轨道写出空曲线', doc.project.tracks[1].pitch.ticks, [])
  notes.push('写出的 JSON 字段名与 UtaFormatix Data v1 规范一致（tickOn/tickOff、tickPosition、measurePosition）')

  /* ---------------------------------------- 2) 读入网页版导出的规范文件 */
  const pure = read(Buffer.from(JSON.stringify(pureDocument()), 'utf8'))
  ok('纯文件 速度数', pure.tempos.length, 2)
  ok('纯文件 速度 0 bpm', pure.tempos[0].bpm, 100)
  ok('纯文件 速度 1 tick', pure.tempos[1].tick, 960)
  ok('纯文件 速度 1 bpm', pure.tempos[1].bpm, 150.5)
  ok('纯文件 拍号 1 tick（第 2 小节 = 2×1920）', pure.timeSignatures[1].tick, 3840)
  ok('纯文件 拍号 1 numerator', pure.timeSignatures[1].numerator, 3)
  ok('纯文件 音符数', pure.tracks[0].notes.length, 2)
  ok('纯文件 音符 tickOff -> duration', pure.tracks[0].notes[1].duration, 480)
  ok('纯文件 音素', pure.tracks[0].notes[1].phoneme, 'i')
  ok('相对音高 -> 绝对：音符 1 起点', curveValueAt(pure.tracks[0].pitch, 0), 60)
  ok('相对音高 -> 绝对：音符 1 内部', curveValueAt(pure.tracks[0].pitch, 240), 60.5)
  ok('相对音高 -> 绝对：音符 2（key 62 + 1）', curveValueAt(pure.tracks[0].pitch, 480), 63)
  ok('纯文件解析结果合法', validateProject(pure), [])
  notes.push('相对音高（isAbsolute:false）按音符 key 换算为 IR 绝对音高')

  // 相对音高写回时保持相对表示
  const rewritten = parse(write(pure))
  ok('相对音高写回仍为相对', rewritten.project.tracks[0].pitch.isAbsolute, false)
  ok('相对音高写回值', rewritten.project.tracks[0].pitch.values, [0, 0.5, 1])

  /* -------------------------------------------------- 3) measurePrefix */
  const prefixed = pureDocument()
  prefixed.project.measurePrefix = 2
  const prefixedIr = read(Buffer.from(JSON.stringify(prefixed), 'utf8'))
  ok('measurePrefix 小节数 -> tick', prefixedIr.measurePrefix, 3840)
  const prefixedOut = parse(write(prefixedIr))
  ok('measurePrefix 回写小节数', prefixedOut.project.measurePrefix, 2)
  ok('measurePrefix 往返后 tick', read(write(prefixedIr)).measurePrefix, 3840)

  // 非整小节的弱起（IR 里是 tick 数）用扩展字段精确保留
  const odd = createProject({
    tracks: [{ notes: [{ tick: 100, duration: 200, key: 60, lyric: 'a' }] }],
  })
  odd.measurePrefix = 100
  const oddBack = read(write(odd))
  ok('非整小节 measurePrefix 精确保留', oddBack.measurePrefix, 100)

  /* ------------------------------------------- 4) 逐项数据完整往返 */
  const rich = createProject({
    name: '富工程',
    comment: '这是备注',
    tempos: [
      { tick: 0, bpm: 96 },
      { tick: 960, bpm: 137 },
    ],
    timeSignatures: [
      { tick: 0, numerator: 3, denominator: 4 },
      { tick: 1440, numerator: 4, denominator: 4 },
    ],
    tracks: [
      {
        name: '轨 A',
        singer: 'SingerX',
        color: '#ff8800',
        muted: true,
        solo: true,
        volume: 0.42,
        pan: -0.3,
        language: 'zh',
        notes: [
          createNote({ tick: 0, duration: 480, key: 61, lyric: '你', phoneme: 'ni', velocity: 100, detune: -12.5, pitchOffset: 3 }),
          createNote({ tick: 480, duration: 960, key: 63, lyric: '好' }),
        ],
        pitch: { ticks: [0, 240, 1440], values: [61.25, 61.5, 63.75] },
        parameters: {
          dynamics: { ticks: [0, 480, 1440], values: [0.25, 0.5, 0.75] },
          breathiness: { ticks: [0, 960], values: [0.1, 0.9] },
        },
      },
    ],
  })
  const richBack = read(write(rich))
  ok('富工程 速度数', richBack.tempos.length, 2)
  ok('富工程 速度 1 bpm', richBack.tempos[1].bpm, 137)
  ok('富工程 拍号数', richBack.timeSignatures.length, 2)
  ok('富工程 拍号 1 tick', richBack.timeSignatures[1].tick, 1440)
  ok('富工程 拍号 1 numerator', richBack.timeSignatures[1].numerator, 4)
  ok('富工程 备注', richBack.comment, '这是备注')
  ok('富工程 歌手', richBack.tracks[0].singer, 'SingerX')
  ok('富工程 颜色', richBack.tracks[0].color, '#ff8800')
  ok('富工程 静音', richBack.tracks[0].muted, true)
  ok('富工程 独奏', richBack.tracks[0].solo, true)
  ok('富工程 音量', richBack.tracks[0].volume, 0.42)
  ok('富工程 声像', richBack.tracks[0].pan, -0.3)
  ok('富工程 语言', richBack.tracks[0].language, 'zh')
  ok('富工程 音素', richBack.tracks[0].notes[0].phoneme, 'ni')
  ok('富工程 VEL', richBack.tracks[0].notes[0].velocity, 100)
  ok('富工程 DETUNE', richBack.tracks[0].notes[0].detune, -12.5)
  ok('富工程 pitchOffset', richBack.tracks[0].notes[0].pitchOffset, 3)
  ok('富工程 音高曲线值', richBack.tracks[0].pitch.values, [61.25, 61.5, 63.75])
  ok('富工程 dynamics 曲线', richBack.tracks[0].parameters.dynamics.values, [0.25, 0.5, 0.75])
  ok('富工程 breathiness 曲线 tick', richBack.tracks[0].parameters.breathiness.ticks, [0, 960])
  ok('富工程 解析结果合法', validateProject(richBack), [])
  notes.push('经 vpir 扩展字段，UtaFormatix 装不下的 IR 数据（参数曲线/歌手/颜色/音量/DETUNE/VEL）本站往返无损')

  // 关闭扩展后仍是合法的纯规范文件
  const plain = parse(write(rich, { extended: false }))
  yes('extended:false 时不含 vpir', !('vpir' in plain.project) && !('vpir' in plain.project.tracks[0]))
  ok('extended:false 后音符仍在', read(write(rich, { extended: false })).tracks[0].notes.length, 2)

  /* --------------------------------------------------------- 5) 容错 */
  const legacy = {
    formatVersion: 1,
    project: {
      name: 'Legacy',
      tracks: [
        {
          name: 'T',
          notes: [
            { tick: 0, duration: 480, key: 60, lyric: 'a' },
            { tick: 480, duration: 480, key: 999, lyric: 'bad' },
            { tickOn: 960, tickOff: 1200, key: 64, lyric: 'c' },
          ],
        },
      ],
      timeSignatures: [],
      tempos: [],
      measurePrefix: 0,
    },
  }
  const legacyIr = read(Buffer.from('\uFEFF' + JSON.stringify(legacy), 'utf8'))
  ok('旧字段 tick/duration 可读', legacyIr.tracks[0].notes.length, 2)
  ok('旧字段 tick', legacyIr.tracks[0].notes[0].tick, 0)
  ok('旧字段 duration', legacyIr.tracks[0].notes[0].duration, 480)
  ok('坏音符被跳过', legacyIr.tracks[0].notes[1].key, 64)
  yes(
    '容错告警已记录',
    Array.isArray(legacyIr.extras.ufdata?.warnings) && legacyIr.extras.ufdata.warnings.length > 0,
  )
  ok('缺省速度补 120', legacyIr.tempos[0].bpm, 120)
  ok('缺省拍号补 4/4', legacyIr.timeSignatures[0].numerator, 4)
  ok('容错结果合法', validateProject(legacyIr), [])

  const future = pureDocument()
  future.formatVersion = 3
  const futureIr = read(Buffer.from(JSON.stringify(future), 'utf8'))
  ok('高版本号仍可解析', futureIr.tracks[0].notes.length, 2)
  yes(
    '高版本号有告警',
    futureIr.extras.ufdata.warnings.some((w) => w.includes('formatVersion')),
  )

  const throwsChinese = (fn, label, pattern) => {
    passed += 1
    let err = null
    try {
      fn()
    } catch (e) {
      err = e
    }
    if (!err) throw new Error(`${label}：应当抛错但没有`)
    if (!/[\u4e00-\u9fa5]/.test(err.message)) throw new Error(`${label}：错误信息不是中文：${err.message}`)
    if (pattern && !pattern.test(err.message)) throw new Error(`${label}：错误信息未说明原因：${err.message}`)
    notes.push(`${label} -> ${err.message}`)
  }
  throwsChinese(() => read(Buffer.from('not json at all', 'utf8')), '非 JSON 输入', /JSON/)
  throwsChinese(() => read(Buffer.from('{"hello":1}', 'utf8')), '结构不符的 JSON', /UtaFormatix/)
  throwsChinese(() => read(Buffer.from('[]', 'utf8')), '顶层为数组', /UtaFormatix/)

  /* ------------------------------------- 5.5) 小节/拍号换算与其它边界 */
  // 小节内的拍号变化：UtaFormatix 只能记「第几小节」，本站用扩展字段精确保留
  const midSig = createProject({
    tempos: [{ tick: 0, bpm: 120 }],
    timeSignatures: [
      { tick: 0, numerator: 4, denominator: 4 },
      { tick: 960, numerator: 3, denominator: 4 },
    ],
    tracks: [{ notes: [{ tick: 0, duration: 3840, key: 60, lyric: 'a' }] }],
  })
  const midOut = parse(write(midSig))
  ok('小节内拍号：主列表只留整小节处的拍号', midOut.project.timeSignatures.length, 1)
  ok('小节内拍号：偏移写入扩展字段', midOut.project.vpir.timeSignatures[0].offset, 960)
  const midBack = read(write(midSig))
  ok('小节内拍号：往返 tick 不变', midBack.timeSignatures.map((s) => s.tick), [0, 960])
  ok('小节内拍号：往返拍号不变', midBack.timeSignatures[1].denominator, 4)

  // 拍号变化会改变后续小节长度（与 utaformatix3 的 TickCounter 一致）
  const shift = createProject({
    timeSignatures: [
      { tick: 0, numerator: 4, denominator: 4 },
      { tick: 1920, numerator: 3, denominator: 4 },
      { tick: 4800, numerator: 4, denominator: 4 },
    ],
    tracks: [{ notes: [{ tick: 0, duration: 480, key: 60, lyric: 'a' }] }],
  })
  const shiftOut = parse(write(shift))
  ok(
    '拍号变化 -> measurePosition',
    shiftOut.project.timeSignatures.map((s) => s.measurePosition),
    [0, 1, 3],
  )
  ok('measurePosition 回读 tick', read(write(shift)).timeSignatures.map((s) => s.tick), [0, 1920, 4800])

  // 缺少 isAbsolute：按数值范围判断并告警
  const mislabeled = pureDocument()
  delete mislabeled.project.tracks[0].pitch.isAbsolute
  const mislabeledIr = read(Buffer.from(JSON.stringify(mislabeled), 'utf8'))
  ok('缺 isAbsolute 的相对数值 -> 按相对处理', curveValueAt(mislabeledIr.tracks[0].pitch, 240), 60.5)
  yes(
    '缺 isAbsolute 有告警',
    mislabeledIr.extras.ufdata.warnings.some((w) => w.includes('isAbsolute')),
  )
  const absLike = pureDocument()
  delete absLike.project.tracks[0].pitch.isAbsolute
  absLike.project.tracks[0].pitch.values = [60, 60.5, 62]
  ok(
    '缺 isAbsolute 的绝对数值 -> 按绝对处理',
    curveValueAt(read(Buffer.from(JSON.stringify(absLike), 'utf8')).tracks[0].pitch, 240),
    60.5,
  )

  // 没有 pitch 字段 / 音高含 null 断点
  const noPitch = pureDocument()
  delete noPitch.project.tracks[0].pitch
  ok('缺少 pitch 字段 -> 空曲线', read(Buffer.from(JSON.stringify(noPitch), 'utf8')).tracks[0].pitch.ticks, [])
  const withNull = pureDocument()
  withNull.project.tracks[0].pitch = { ticks: [0, 240, 480], values: [60, null, 62], isAbsolute: true }
  const withNullIr = read(Buffer.from(JSON.stringify(withNull), 'utf8'))
  ok('音高 null 断点被跳过', withNullIr.tracks[0].pitch.ticks, [0, 480])
  yes(
    '音高 null 断点有告警',
    withNullIr.extras.ufdata.warnings.some((w) => w.includes('null')),
  )

  // 空轨道列表
  const emptyOut = parse(write(createProject({ tracks: [] })))
  ok('空工程 tracks 为空数组', emptyOut.project.tracks.length, 0)
  ok('空工程回读后仍是空轨道', read(write(createProject({ tracks: [] }))).tracks.length, 0)

  /* ------------------------------------------------------ 6) 模块元信息 */
  ok('id', meta.id, 'ufdata')
  ok('canRead', meta.canRead, true)
  ok('canWrite', meta.canWrite, true)
  ok('writeExt', meta.writeExt, '.ufdata')
  ok('encoding', meta.encoding, 'utf8')
  ok('exts 含 .ufdata', meta.exts.includes('.ufdata'), true)
  yes('fidelity.notes 非空', typeof fidelity.notes === 'string' && fidelity.notes.length > 0)

  return { passed, notes }
}

/** 未注入 canonicalProject 时的兜底（与 selftest.mjs 的规范工程等价） */
function defaultCanonical() {
  return createProject({
    name: '自测工程 Selftest',
    comment: '由 selftest.mjs 生成的规范测试工程',
    tempos: [
      { tick: 0, bpm: 120 },
      { tick: 1920, bpm: 140 },
    ],
    timeSignatures: [
      { tick: 0, numerator: 4, denominator: 4 },
      { tick: 3840, numerator: 3, denominator: 4 },
    ],
    tracks: [
      {
        name: '主唱',
        singer: 'TestSinger',
        color: '#66ccff',
        language: 'ja',
        notes: [
          { tick: 0, duration: 480, key: 60, lyric: 'ら' },
          { tick: 480, duration: 480, key: 62, lyric: 'り' },
          { tick: 960, duration: 960, key: 64, lyric: 'る' },
          { tick: 2400, duration: 480, key: 67, lyric: 'れ' },
        ],
        pitch: { ticks: [0, 480, 960, 1920, 2400], values: [60, 62, 64, 65, 67] },
        parameters: {
          dynamics: { ticks: [0, 960, 1920], values: [0.2, 0.5, 0.8] },
          breathiness: { ticks: [0, 1920], values: [0.1, 0.6] },
        },
      },
      {
        name: '和声',
        singer: '',
        notes: [{ tick: 0, duration: 1920, key: 55, lyric: 'あ' }],
      },
    ],
  })
}
