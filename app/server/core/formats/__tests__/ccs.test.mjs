/**
 * ccs（CeVIO CS/AI 工程）格式模块专项自测
 *
 * 重点覆盖「按模板填充」的写出路径（结构见 docs/TEMPLATE-REWRITE-BRIEF.md）：
 *  1. <Generation> 必须带全 <Author>/<TTS>/<SVSS>、各自的 <Dictionary> 与
 *     <SoundSources><SoundSource Version Id Name>——之前从零拼 XML 时这 6 项全漏，
 *     而「自己写自己读」的往返测试对这类缺失是瞎的。
 *  2. 工程里带回来的原生 Generation（读 .ccs 时的 extras）优先；跨格式转换时用模板默认。
 *  3. 原生没有 SoundSources 时补空列表，不借用模板里的音源条目（不凭空多出歌手）。
 *  4. Unit 与 Group 必须成对（同一个 Group Id）、每轨一份。
 *  5. 零轨道工程也要写出结构完整的骨架。
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createProject, noteCount, validateProject } from '../../ir.mjs'
import { canonicalProject } from '../../selftest.mjs'
import ccs, { meta, fidelity, read, write } from '../ccs.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SAMPLES_DIR = join(__dirname, '..', '..', '..', '..', '..', 'tests', 'samples')

/** 递归按键名排序后再比较：属性顺序、缩进空白这类差异不该影响判定 */
function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(value[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(value)
}

/** Generation 的结构摘要：每代的版本属性、Dictionary 等子节点、音源表 */
function genShape(gen) {
  if (!gen) return null
  return (gen.children ?? []).map((child) => ({
    name: child.name,
    attrs: child.attrs ?? {},
    kids: (child.children ?? [])
      .filter((c) => c.name !== 'SoundSources')
      .map((c) => ({ name: c.name, attrs: c.attrs ?? {} })),
    sources: (child.children ?? []).filter((c) => c.name === 'SoundSources').map((c) => (c.children ?? []).map((s) => s.attrs ?? {})),
  }))
}

/** 手写一份最小 .ccs：原生 Generation 里 TTS 没有 SoundSources、SVSS 的是空列表 */
function handWrittenCcs() {
  return `<?xml version="1.0" encoding="utf-8"?>
<Scenario Code="7251BC4B6168E7B2992FA620BD3E1E77">
  <Generation>
    <Author Version="9.9.9.9"/>
    <TTS Version="1.2.3">
      <Dictionary Version="4.5.6"/>
    </TTS>
    <SVSS Version="7.8.9">
      <Dictionary Version="1.0.0"/>
      <SoundSources/>
    </SVSS>
  </Generation>
  <Sequence Id="S1">
    <Scene Id="C1">
      <Units>
        <Unit Version="1.0" Id="" Category="SingerSong" Group="g1" StartTime="00:00:00" Duration="00:00:02" CastId="" Language="Japanese">
          <Song Version="1.02">
            <Tempo><Sound Clock="0" Tempo="120"/></Tempo>
            <Beat><Time Clock="0" Beats="4" BeatType="4"/></Beat>
            <Score>
              <Key Clock="0" Fifths="0" Mode="0"/>
              <Note Clock="3840" PitchStep="0" PitchOctave="4" Duration="960" Lyric="a"/>
            </Score>
          </Song>
        </Unit>
      </Units>
      <Groups>
        <Group Version="1.0" Id="g1" Category="SingerSong" Name="T" Color="#FF112233" Volume="0" Pan="0" IsSolo="false" IsMuted="false" CastId="" Language="Japanese"/>
      </Groups>
      <SoundSetting Rhythm="4/4" Tempo="120"/>
    </Scene>
  </Sequence>
</Scenario>
`
}

const countTag = (text, tag) => (text.match(new RegExp(`<${tag}\\b`, 'g')) ?? []).length
/** 取某个元素的属性值（\s 前缀避免匹配到 CastId/ActiveGroup 这类同后缀属性） */
const attrValues = (text, tag, attr) => [...text.matchAll(new RegExp(`<${tag}\\b[^>]*\\s${attr}="([^"]*)"`, 'g'))].map((m) => m[1])

export default async function run() {
  let passed = 0
  const failures = []
  const notes = []

  const check = (label, actual, expected, tol = 1e-6) => {
    const ok =
      typeof actual === 'number' && typeof expected === 'number'
        ? Math.abs(actual - expected) <= tol
        : stable(actual) === stable(expected)
    if (ok) passed += 1
    else failures.push(`${label}：期望 ${stable(expected)}，实际 ${stable(actual)}`)
  }
  const assert = (cond, label) => {
    if (cond) passed += 1
    else failures.push(label)
  }

  /* ============ A. 元信息 ============ */

  check('meta.id', meta.id, 'ccs')
  assert('meta 可读可写', meta.canRead === true && meta.canWrite === true)
  assert('fidelity 声明了 preserves/drops', Array.isArray(fidelity.preserves) && Array.isArray(fidelity.drops))

  /* ============ B. 跨格式转换：模板 Generation 必须完整 ============ */

  const src = canonicalProject()
  check('规范工程自身合法', validateProject(src), [])

  const outBuf = write(src, { name: src.name })
  const outText = outBuf.toString('utf8')
  assert('写出以 <Scenario> 为根', outText.includes('<Scenario'))
  assert('有 <Generation>', outText.includes('<Generation>'))
  check('<Author> 数量', countTag(outText, 'Author'), 1)
  check('<TTS> 数量', countTag(outText, 'TTS'), 1)
  check('<SVSS> 数量', countTag(outText, 'SVSS'), 1)
  check('<Dictionary> 数量（TTS + SVSS）', countTag(outText, 'Dictionary'), 2)
  check('<SoundSources> 数量（TTS + SVSS）', countTag(outText, 'SoundSources'), 2)
  assert(
    'SoundSource 带 Version/Id/Name 三个属性',
    /<SoundSource Version="[^"]*" Id="[^"]*" Name="[^"]*"/.test(outText),
  )
  check('模板 SVSS 的 2 条音源被保留', countTag(outText, 'SoundSource'), 2)
  assert('每条 SoundSource 都有 Version', [...outText.matchAll(/<SoundSource\b[^>]*>/g)].every((m) => / Version="/.test(m[0])))
  assert('每条 SoundSource 都有 Id', [...outText.matchAll(/<SoundSource\b[^>]*>/g)].every((m) => / Id="/.test(m[0])))
  assert('每条 SoundSource 都有 Name', [...outText.matchAll(/<SoundSource\b[^>]*>/g)].every((m) => / Name="/.test(m[0])))

  const back = read(outBuf, { name: src.name })
  check('回读工程合法', validateProject(back), [])
  check('回读轨道数', back.tracks.length, src.tracks.length)
  check('回读音符数', noteCount(back), noteCount(src))
  check('回读速度', back.tempos[0].bpm, src.tempos[0].bpm)
  const genBack = back.extras.ccs.generation
  check('回读 Generation 的子节点', genBack.children.map((c) => c.name), ['Author', 'TTS', 'SVSS'])
  check('回读 TTS 的子节点', genBack.children[1].children.map((c) => c.name), ['Dictionary', 'SoundSources'])
  check('回读 SVSS 的子节点', genBack.children[2].children.map((c) => c.name), ['Dictionary', 'SoundSources'])
  notes.push('跨格式转换：Generation/TTS/SVSS/SoundSources/SoundSource 全部由模板补齐')

  /* ============ C. Unit 与 Group 成对 ============ */

  const unitGroups = attrValues(outText, 'Unit', 'Group')
  const groupIds = attrValues(outText, 'Group', 'Id')
  check('Unit 数量 = 轨道数', unitGroups.length, src.tracks.length)
  check('Group 数量 = 轨道数', groupIds.length, src.tracks.length)
  check('Unit.Group 与 Group.Id 一一配对', unitGroups, groupIds)
  assert('每个 unit 的 Group 都是非空 uuid', unitGroups.every((g) => /^[0-9a-f-]{36}$/i.test(g)))
  check('Unit 的 Category', attrValues(outText, 'Unit', 'Category'), src.tracks.map(() => 'SingerSong'))
  check('轨 0 名称写进 Group', back.tracks[0].name, src.tracks[0].name)
  check('轨 0 歌词', back.tracks[0].notes[0].lyric, src.tracks[0].notes[0].lyric)

  /* ============ D. 原生 Generation 优先（且不借模板音源） ============ */

  const hand = read(Buffer.from(handWrittenCcs(), 'utf8'), { name: 'hand.ccs' })
  check('手写样本合法', validateProject(hand), [])
  check('手写样本轨道数', hand.tracks.length, 1)
  check('手写样本音符数', noteCount(hand), 1)

  const handText = write(hand, { name: 'hand' }).toString('utf8')
  assert('原生 Author 版本被保留', handText.includes('<Author Version="9.9.9.9"'))
  assert('原生 TTS 版本被保留（不是模板的 3.1.0）', handText.includes('<TTS Version="1.2.3"'))
  assert('原生 SVSS 版本被保留（不是模板的 3.0.5）', handText.includes('<SVSS Version="7.8.9"'))
  assert('原生 Dictionary 版本被保留', handText.includes('<Dictionary Version="4.5.6"'))
  assert('原生 TTS 缺 SoundSources 时补成空列表', /<TTS[\s\S]*?<SoundSources\/>[\s\S]*?<\/TTS>/.test(handText))
  check('原生空 SoundSources 不被塞进模板音源', countTag(handText, 'SoundSource'), 0)
  assert('Sequence Id 保留', handText.includes('<Sequence Id="S1"'))
  assert('Scene Id 保留', handText.includes('<Scene Id="C1"'))

  const handBack = read(Buffer.from(handText, 'utf8'), { name: 'hand.ccs' })
  check('手写样本往返合法', validateProject(handBack), [])
  check('手写样本往返音符数', noteCount(handBack), 1)
  check('手写样本往返后 Generation 形状', genShape(handBack.extras.ccs.generation), [
    { name: 'Author', attrs: { Version: '9.9.9.9' }, kids: [], sources: [] },
    { name: 'TTS', attrs: { Version: '1.2.3' }, kids: [{ name: 'Dictionary', attrs: { Version: '4.5.6' } }], sources: [[]] },
    { name: 'SVSS', attrs: { Version: '7.8.9' }, kids: [{ name: 'Dictionary', attrs: { Version: '1.0.0' } }], sources: [[]] },
  ])
  notes.push('原生 Generation 优先：版本号与空音源列表按原样回写，不借用模板音源')

  /* ============ E. 零轨道工程也要结构完整 ============ */

  const empty = createProject({ name: 'empty', tracks: [] })
  check('零轨道工程', empty.tracks.length, 0)
  const emptyText = write(empty, { name: 'empty' }).toString('utf8')
  check('零轨道仍有 1 个 <Unit>', countTag(emptyText, 'Unit'), 1)
  check('零轨道仍有 1 个 <Group>', countTag(emptyText, 'Group'), 1)
  check('零轨道也带完整 Generation', countTag(emptyText, 'SoundSources'), 2)
  const emptyBack = read(Buffer.from(emptyText, 'utf8'), { name: 'empty.ccs' })
  check('零轨道回读合法', validateProject(emptyBack), [])
  check('零轨道回读得到 1 条空轨道', [emptyBack.tracks.length, noteCount(emptyBack)], [1, 0])

  /* ============ F. 真实样本：结构完整且往返不丢音符 ============ */

  for (const file of ['real-sample-1.ccs', 'real-sample-2.ccs', 'real-sample-3.ccs']) {
    const p = join(SAMPLES_DIR, file)
    if (!existsSync(p)) {
      notes.push(`未找到 tests/samples/${file}，跳过`)
      continue
    }
    const sample = read(readFileSync(p), { name: file })
    check(`${file} 合法`, validateProject(sample), [])
    const out = write(sample, { name: file })
    const round = read(out, { name: file })
    check(`${file} 往返合法`, validateProject(round), [])
    check(`${file} 往返轨道数`, round.tracks.length, sample.tracks.length)
    check(`${file} 往返音符数`, noteCount(round), noteCount(sample))
    check(`${file} 往返 Generation 与原文件一致`, genShape(round.extras.ccs.generation), genShape(sample.extras.ccs.generation))
    const text = out.toString('utf8')
    assert(`${file} 写出带完整 Generation`, countTag(text, 'SoundSources') === 2 && countTag(text, 'Dictionary') >= 1)
    notes.push(`${file}：${sample.tracks.length} 轨 / ${noteCount(sample)} 音符，Generation 与音源表原样保留`)
  }

  if (failures.length) {
    throw new Error(`ccs 专项自测 ${failures.length} 项失败：\n  - ${failures.join('\n  - ')}`)
  }
  return { passed, notes }
}

// 允许单独运行：node app/server/core/formats/__tests__/ccs.test.mjs
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('__tests__/ccs.test.mjs')) {
  run().then((r) => {
    console.log(`✓ 通过 ${r.passed} 项断言`)
    for (const n of r.notes) console.log('  · ' + n)
  })
}
