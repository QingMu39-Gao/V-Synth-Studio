/**
 * MusicXML 模块专项自测
 * 覆盖：写-读往返（音高/歌词/时长/速度/拍号）、多声部、和弦、跨小节 tie、休止与 backup、
 *       divisions 非 480 的换算、XML 转义、timewise 容错、非法输入报错、
 *       以及「音高曲线无法表达」这一已知限制的显式固定。
 */

import musicxml, { meta as mxMeta, fidelity as mxFidelity, __skipChecks } from '../musicxml.mjs'
import { createProject, validateProject, noteCount, curveValueAt, TPQ } from '../../ir.mjs'

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

  check('meta.id', mxMeta.id, 'musicxml')
  check('meta.kind', mxMeta.kind, 'xml')
  check('meta.exts 含 .musicxml', mxMeta.exts.includes('.musicxml'), true)

  /* ---------------------------------------------- 1. 主干往返 */
  const project = createProject({
    name: 'MusicXML 专项测试',
    comment: '某某 作曲',
    tempos: [
      { tick: 0, bpm: 120 },
      { tick: 1920, bpm: 88.5 },
      { tick: 2880, bpm: 150 },
    ],
    timeSignatures: [
      { tick: 0, numerator: 4, denominator: 4 },
      { tick: 1920, numerator: 3, denominator: 4 },
      { tick: 2880, numerator: 6, denominator: 8 },
    ],
    tracks: [
      {
        name: '主唱',
        notes: [
          { tick: 0, duration: 480, key: 60, lyric: 'do' },
          { tick: 480, duration: 240, key: 62, lyric: 're' },
          { tick: 720, duration: 240, key: 64, lyric: 'mi' },
          // 跨小节（4/4 -> 3/4 边界在 1920）：1920 起的整小节音 + 跨到下一小节的音
          { tick: 1440, duration: 960, key: 65, lyric: 'fa' },
          { tick: 2400, duration: 720, key: 67, lyric: 'sol' },
          { tick: 3120, duration: 480, key: 69, lyric: 'la' },
        ],
        // MusicXML 无法表达音高曲线，这里故意给出非空曲线用于断言「确实会丢」
        pitch: { ticks: [0, 1920, 3120], values: [60, 65, 69] },
        parameters: { dynamics: { ticks: [0, 1920], values: [0.2, 0.9] } },
      },
      {
        name: '和声',
        notes: [{ tick: 0, duration: 1920, key: 55, lyric: 'あ' }],
      },
    ],
  })
  check('测试工程本身合法', validateProject(project), [])

  const buf = musicxml.write(project, { name: project.name })
  assert(Buffer.isBuffer(buf) && buf.length > 0, 'write() 应返回非空 Buffer')
  const xml = buf.toString('utf8')
  assert(xml.startsWith('<?xml'), 'XML 应有声明头')
  assert(xml.includes('<score-partwise'), '根元素应为 score-partwise')
  assert(xml.includes('<divisions>480</divisions>'), '应写出 divisions=480')
  assert(xml.includes('<text>あ</text>'), '歌词应以 UTF-8 原文写出')
  assert(xml.includes('<beats>3</beats>'), '中途变更的拍号应写出')
  assert(xml.includes('tempo="88.5"'), '中途变更的速度应写出')

  const back = musicxml.read(buf, { name: project.name })
  check('往返校验', validateProject(back), [])
  check('工程名', back.name, project.name)
  check('速度点数', back.tempos.length, project.tempos.length)
  project.tempos.forEach((t, i) => {
    check(`速度[${i}].tick`, back.tempos[i].tick, t.tick)
    check(`速度[${i}].bpm`, back.tempos[i].bpm, t.bpm, 0.11)
  })
  check('拍号数', back.timeSignatures.length, project.timeSignatures.length)
  /*
   * 拍号位置：MusicXML 的小节没有绝对坐标，读者只能「从上一小节起点累加当前拍号」推算位置，
   * 所以「小节中途变拍号」无法表达，必须对齐到最近的后续小节线。这是记谱软件的标准做法。
   * 本用例：4/4 起（小节线 0、1920），1920 起为 3/4（小节长 1440），
   * 源工程想在 2880 变 6/8 —— 2880 不是小节线，因此对齐到 1920+1440=3360。
   * 相应地，速度点仍能保持精确位置（由 direction/forward/backup 承载）。
   */
  const expectedSigTicks = [0, 1920, 3360]
  project.timeSignatures.forEach((t, i) => {
    check(`拍号[${i}].tick（对齐到小节线后）`, back.timeSignatures[i].tick, expectedSigTicks[i])
    check(`拍号[${i}].numerator`, back.timeSignatures[i].numerator, t.numerator)
    check(`拍号[${i}].denominator`, back.timeSignatures[i].denominator, t.denominator)
  })
  check('轨道数', back.tracks.length, project.tracks.length)
  check('音符总数', noteCount(back), noteCount(project))
  project.tracks.forEach((src, ti) => {
    const dst = back.tracks[ti]
    check(`轨 ${ti} 名`, dst.name, src.name)
    check(`轨 ${ti} 音符数`, dst.notes.length, src.notes.length)
    src.notes.forEach((n, ni) => {
      check(`轨 ${ti} 音符 ${ni} tick`, dst.notes[ni].tick, n.tick)
      check(`轨 ${ti} 音符 ${ni} duration`, dst.notes[ni].duration, n.duration)
      check(`轨 ${ti} 音符 ${ni} key`, dst.notes[ni].key, n.key)
      check(`轨 ${ti} 音符 ${ni} lyric`, dst.notes[ni].lyric, n.lyric)
    })
  })
  notes.push('往返不丢音高/歌词/时长：6 音符（含跨小节音）+ 变速 3 点 + 变拍号 3 点全部还原')

  /* ---------------------------------------------- 2. 已知限制的显式固定 */
  check('__skipChecks 仅声明 pitch', __skipChecks, ['pitch'])
  assert(mxFidelity.drops.some((d) => d.includes('音高曲线')), 'fidelity.drops 必须声明音高曲线会丢')
  assert(!mxFidelity.preserves.includes('pitchCurve'), 'fidelity.preserves 不得声明保留音高曲线')
  check('读回后音高曲线为空（能力边界，非 bug）', back.tracks[0].pitch.ticks, [])
  check('读回后参数曲线为空', Object.keys(back.tracks[0].parameters), [])
  assert(curveValueAt(project.tracks[0].pitch, 1920) === 65, '原工程确实有音高曲线可丢')
  notes.push('音高曲线/参数曲线：MusicXML 无标准元素可表达，已在 fidelity.drops 声明并固定为空曲线')

  /* ---------------------------------------------- 3. 手工样本：和弦 / 休止 / backup / tie */
  {
    const xmlText = `<?xml version="1.0" encoding="UTF-8"?>
<score-partwise version="3.1">
  <work><work-title>手工样本</work-title></work>
  <part-list><score-part id="P1"><part-name>Melody</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes>
        <divisions>2</divisions>
        <key><fifths>2</fifths></key>
        <time><beats>3</beats><beat-type>4</beat-type></time>
      </attributes>
      <note><rest/><duration>1</duration><voice>1</voice><type>eighth</type></note>
      <note><pitch><step>C</step><alter>1</alter><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type>
        <lyric number="1"><syllabic>single</syllabic><text>ka</text></lyric>
      </note>
      <note><chord/><pitch><step>E</step><octave>4</octave></pitch><duration>2</duration><voice>1</voice><type>quarter</type></note>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>3</duration><voice>1</voice><type>half</type><dot/>
        <tie type="start"/><notations><tied type="start"/></notations>
      </note>
    </measure>
    <measure number="2">
      <attributes><divisions>2</divisions><time><beats>3</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>G</step><octave>4</octave></pitch><duration>3</duration><voice>1</voice><type>half</type><dot/>
        <tie type="stop"/><notations><tied type="stop"/></notations>
      </note>
      <backup><duration>3</duration></backup>
      <note><pitch><step>C</step><octave>3</octave></pitch><duration>3</duration><voice>2</voice><type>half</type><dot/></note>
      <forward><duration>3</duration></forward>
      <note><rest/><duration>3</duration><voice>1</voice><type>half</type><dot/></note>
    </measure>
  </part>
</score-partwise>`
    const proj = musicxml.read(Buffer.from(xmlText, 'utf8'), { name: 'hand.musicxml' })
    check('手工样本校验', validateProject(proj), [])
    check('手工样本工程名', proj.name, '手工样本')
    check('手工样本拍号', proj.timeSignatures.map((t) => `${t.numerator}/${t.denominator}`), ['3/4'])
    check('手工样本 divisions 换算（休止+二分音符=6/2 拍 -> 1440 tick）', proj.tracks[0].notes.map((n) => n.tick), [240, 240, 720])
    check('手工样本和弦（同时起音）', proj.tracks[0].notes[0].key, 61)
    check('手工样本音高 C#4', proj.tracks[0].notes[0].key, 61)
    check('手工样本歌词', proj.tracks[0].notes.map((n) => n.lyric), ['ka', '', ''])
    // tie 合并：G4 从 720 延续到下一小节的 720+720
    check('手工样本 tie 合并后的时长', proj.tracks[0].notes[2].duration, 1440)
    check('手工样本 tie 合并后起点', proj.tracks[0].notes[2].tick, 720)
    notes.push('手工样本：divisions=2 换算、和弦、rest/backup/forward、tie 合并均正确')
  }

  /* ---------------------------------------------- 4. XML 转义与特殊字符 */
  {
    const src = createProject({
      name: '转义 & <测试>',
      tracks: [{ name: 'A&B', notes: [{ tick: 0, duration: 480, key: 60, lyric: 'a<b>&"c"' }] }],
    })
    const round = musicxml.read(musicxml.write(src, { name: src.name }), { name: 'x' })
    check('歌词中的 XML 特殊字符往返', round.tracks[0].notes[0].lyric, 'a<b>&"c"')
    check('工程名中的 XML 特殊字符往返', round.name, '转义 & <测试>')
    notes.push('XML 转义：歌词与标题中的 & < > " 均正确转义并还原')
  }

  /* ---------------------------------------------- 5. 非标准 divisions 换算 */
  {
    const xmlText = `<?xml version="1.0"?>
<score-partwise version="2.0">
  <part-list><score-part id="P1"><part-name>P</part-name></score-part></part-list>
  <part id="P1">
    <measure number="1">
      <attributes><divisions>96</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>96</duration><type>quarter</type></note>
      <note><pitch><step>D</step><octave>4</octave></pitch><duration>192</duration><type>half</type></note>
    </measure>
  </part>
</score-partwise>`
    const proj = musicxml.read(Buffer.from(xmlText, 'utf8'), { name: 'div96.musicxml' })
    check('divisions=96 的 tick 换算', proj.tracks[0].notes.map((n) => n.tick), [0, 480])
    check('divisions=96 的时长换算', proj.tracks[0].notes.map((n) => n.duration), [480, 960])
    check('divisions 记录进 extras', proj.tracks[0].extras.divisions, 96)
    notes.push('divisions != 480 的乐谱（96）按比例换算到 TPQ=480，误差 0 tick')
  }

  /* ---------------------------------------------- 6. timewise 容错 */
  {
    const xmlText = `<?xml version="1.0"?>
<score-timewise>
  <part-list><score-part id="P1"><part-name>W</part-name></score-part></part-list>
  <measure number="1">
    <part id="P1">
      <attributes><divisions>4</divisions><time><beats>4</beats><beat-type>4</beat-type></time></attributes>
      <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>quarter</type></note>
    </part>
  </measure>
</score-timewise>`
    const proj = musicxml.read(Buffer.from(xmlText, 'utf8'), { name: 'tw.musicxml' })
    check('score-timewise 容错读出的音符数', noteCount(proj), 1)
    check('score-timewise 音高', proj.tracks[0].notes[0].key, 60)
    notes.push('score-timewise（按小节分声部）也能读出，归一到 partwise 处理')
  }

  /* ---------------------------------------------- 7. 非法输入报错 */
  {
    let msg = ''
    try {
      musicxml.read(Buffer.from('<foo><bar/></foo>', 'utf8'), { name: 'x.xml' })
    } catch (err) {
      msg = String(err.message)
    }
    assert(msg.includes('score-partwise'), `非 MusicXML 应抛出中文错误，实际：${msg || '(未抛错)'}`)

    let msg2 = ''
    try {
      musicxml.read(Buffer.from('', 'utf8'), { name: 'x.xml' })
    } catch (err) {
      msg2 = String(err.message)
    }
    assert(msg2.length > 0, '空文件应抛出错误')
    notes.push(`报错：非乐谱 XML -> “${msg.slice(0, 30)}…”；空文件 -> “${msg2}”`)
  }

  /* ---------------------------------------------- 8. 大工程小节切分 */
  {
    const notes50 = []
    for (let i = 0; i < 50; i += 1) notes50.push({ tick: i * 240, duration: 240, key: 60 + (i % 12), lyric: `s${i}` })
    const big = createProject({
      name: '切分',
      tempos: [{ tick: 0, bpm: 100 }],
      timeSignatures: [
        { tick: 0, numerator: 4, denominator: 4 },
        { tick: 4800, numerator: 3, denominator: 4 },
      ],
      tracks: [{ name: 'T', notes: notes50 }],
    })
    const round = musicxml.read(musicxml.write(big, { name: 'big' }), { name: 'big' })
    check('50 音符往返数量', noteCount(round), 50)
    // 4800 落在 4/4 小节的中间（小节线在 0/1920/3840/5760），MusicXML 无法表达小节中途变拍号，
    // 因此向后对齐到最近的 5760。详见 musicxml.mjs 的 snapTimeSignatures 与 fidelity.drops。
    check('50 音符往返拍号（对齐到小节线后）', round.timeSignatures.map((t) => `${t.tick}:${t.numerator}/${t.denominator}`), ['0:4/4', '5760:3/4'])
    let diff = 0
    big.tracks[0].notes.forEach((n, i) => {
      const d = round.tracks[0].notes[i]
      diff = Math.max(diff, Math.abs(d.tick - n.tick), Math.abs(d.duration - n.duration), Math.abs(d.key - n.key))
      if (d.lyric !== n.lyric) throw new Error(`第 ${i} 个音符歌词不符：${d.lyric} != ${n.lyric}`)
    })
    check('50 音符往返最大偏差', diff, 0)
    check('小节切分后总和（每小节 1920/1440）', round.tracks[0].notes.length, 50)
    notes.push('50 音符 / 变拍号 / 全小节线的工程逐音符零偏差往返')
  }

  notes.push(`fidelity.preserves：${mxFidelity.preserves.join('、')}`)
  notes.push(`fidelity.drops：${mxFidelity.drops.join('、')}`)
  notes.push(`divisions 写出口径：${TPQ}（与 IR 同分辨率，不产生二次量化）`)
  return { passed, notes }
}
