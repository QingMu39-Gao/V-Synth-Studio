/**
 * vsqx（VOCALOID3/4 工程）格式模块专项自测
 *
 * 重点覆盖「按模板填充」的写出路径（结构见 docs/TEMPLATE-REWRITE-BRIEF.md）：
 *  1. 每个音符都必须带完整的 <nStyle>（v3 为 <noteStyle>）——模板里有 9 格
 *     accent / bendDep / bendLen / decay / fallPort / opening / risePort / vibLen / vibType，
 *     少了它 VOCALOID 会拒绝加载，而「自己写自己读」的往返测试对这类缺失是瞎的。
 *  2. 原生 nStyle 值优先于模板默认值（读入时存进 note.attributes.nStyle，写出时回写）。
 *  3. 颤音 seq（v3 为 seqAttr/elem）随 IR 颤音或原生结构一起写出。
 *  4. 两代变体（vsq4 / vsq3）都由同一份模板改名得到，标签名与元素顺序必须各自正确。
 *  5. 真实样本的 nStyle 在同格式往返后逐音符保持一致。
 */

import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createProject, noteCount, validateProject } from '../../ir.mjs'
import { canonicalProject } from '../../selftest.mjs'
import vsqx, { meta, fidelity, read, write } from '../vsqx.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SAMPLES_DIR = join(__dirname, '..', '..', '..', '..', '..', 'tests', 'samples')

/** 模板 nStyle 的 9 格与默认值（与 formats/templates/template.vsqx 一致） */
const TEMPLATE_NSTYLE = {
  accent: 50,
  bendDep: 0,
  bendLen: 0,
  decay: 50,
  fallPort: 0,
  opening: 127,
  risePort: 0,
  vibLen: 0,
  vibType: 0,
}
const NSTYLE_IDS = Object.keys(TEMPLATE_NSTYLE)

/** 按键名排序后比较（读入顺序会随文件里 <v> 的排列变化，不该因此判失败） */
function sortedJson(obj) {
  const out = {}
  for (const k of Object.keys(obj ?? {}).sort()) out[k] = obj[k]
  return JSON.stringify(out)
}

/** 手写一份最小 vsq4：音符带自定义 nStyle 与颤音序列 */
function handWrittenVsq4() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<vsq4 xmlns="http://www.yamaha.co.jp/vocaloid/schema/vsq4/">
  <vender><![CDATA[Yamaha corporation]]></vender>
  <version><![CDATA[4.0.0.3]]></version>
  <masterTrack>
    <seqName><![CDATA[hand]]></seqName>
    <comment><![CDATA[hand]]></comment>
    <resolution>480</resolution>
    <preMeasure>1</preMeasure>
    <timeSig><m>0</m><nu>4</nu><de>4</de></timeSig>
    <tempo><t>0</t><v>12000</v></tempo>
  </masterTrack>
  <vsTrack>
    <tNo>0</tNo>
    <name><![CDATA[Hand]]></name>
    <comment><![CDATA[Hand]]></comment>
    <vsPart>
      <t>0</t>
      <playTime>960</playTime>
      <name><![CDATA[P]]></name>
      <comment><![CDATA[P]]></comment>
      <singer><t>0</t><bs>0</bs><pc>0</pc></singer>
      <note>
        <t>0</t><dur>480</dur><n>60</n><v>64</v>
        <y><![CDATA[a]]></y><p><![CDATA[a]]></p>
        <nStyle>
          <v id="accent">77</v>
          <v id="decay">31</v>
          <v id="bendDep">12</v>
          <v id="bendLen">5</v>
          <v id="fallPort">3</v>
          <v id="risePort">2</v>
          <v id="opening">100</v>
          <v id="vibLen">64</v>
          <v id="vibType">1</v>
          <seq id="vibrato">
            <cc><p>0</p><v>40</v></cc>
            <cc><p>2147483647</p><v>55</v></cc>
          </seq>
        </nStyle>
      </note>
      <note>
        <t>480</t><dur>480</dur><n>62</n><v>64</v>
        <y><![CDATA[i]]></y><p><![CDATA[i]]></p>
      </note>
    </vsPart>
  </vsTrack>
</vsq4>
`
}

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

  /* ============ A. 元信息 ============ */

  check('meta.id', meta.id, 'vsqx')
  assert('meta 可读可写', meta.canRead === true && meta.canWrite === true)
  assert('fidelity 声明了 preserves/drops', Array.isArray(fidelity.preserves) && Array.isArray(fidelity.drops))

  /* ============ B. 模板骨架：每个音符都要有完整 nStyle ============ */

  const src = canonicalProject()
  check('规范工程自身合法', validateProject(src), [])

  const out4 = write(src, { name: src.name })
  const text4 = out4.toString('utf8')
  assert('写出的是 vsq4', /<vsq4[\s>]/.test(text4.slice(0, 1200)))
  check('nStyle 出现次数 = 音符数', (text4.match(/<nStyle>/g) ?? []).length, noteCount(src))
  check('pStyle 出现次数 = 轨道数', (text4.match(/<pStyle>/g) ?? []).length, src.tracks.length)

  const back4 = read(out4, { name: src.name })
  check('回读工程合法', validateProject(back4), [])
  for (let ti = 0; ti < back4.tracks.length; ti += 1) {
    for (const [ni, n] of back4.tracks[ti].notes.entries()) {
      const style = n.attributes?.nStyle
      check(`轨 ${ti} 音符 ${ni} 有 nStyle`, !!style, true)
      check(`轨 ${ti} 音符 ${ni} nStyle 的 9 格`, sortedJson(style), sortedJson(TEMPLATE_NSTYLE))
    }
  }
  notes.push(`规范工程 vsq4：${noteCount(src)} 个音符全部带模板默认 nStyle（9 格）`)

  /* ============ C. vsq3 变体：由同一模板改名得到 ============ */

  const out3 = write(src, { name: src.name, variant: 'vsq3' })
  const text3 = out3.toString('utf8')
  assert('写出的是 vsq3', /<vsq3[\s>]/.test(text3.slice(0, 1200)))
  assert('vsq3 用 <musicalPart>', text3.includes('<musicalPart>'))
  assert('vsq3 用 <noteStyle>', text3.includes('<noteStyle>'))
  assert('vsq3 用 <attr id=', text3.includes('<attr id="accent">'))
  assert('vsq3 不含 <plane>（vsq3 schema 里没有这个元素）', !text3.includes('<plane>'))
  assert('vsq3 用 <partStyle>', text3.includes('<partStyle>'))
  assert('vsq3 用 <mCtrl>', text3.includes('<mCtrl>'))
  assert('vsq3 用 <seUnit>/<karaokeUnit>', text3.includes('<seUnit>') && text3.includes('<karaokeUnit>'))
  assert('vsq3 mixer 字段名是 inGain/sendLevel/sendEnable/mute/solo', /<seUnit>[\s\S]*?<inGain>/.test(text3) && text3.includes('<sendEnable>'))
  check('vsq3 noteStyle 出现次数 = 音符数', (text3.match(/<noteStyle>/g) ?? []).length, noteCount(src))

  const back3 = read(out3, { name: src.name, variant: 'vsq3' })
  check('vsq3 回读工程合法', validateProject(back3), [])
  check('vsq3 回读音符数', noteCount(back3), noteCount(src))
  for (let ti = 0; ti < back3.tracks.length; ti += 1) {
    for (const [ni, n] of back3.tracks[ti].notes.entries()) {
      check(`vsq3 轨 ${ti} 音符 ${ni} nStyle 的 9 格`, sortedJson(n.attributes?.nStyle), sortedJson(TEMPLATE_NSTYLE))
    }
  }
  check('vsq3 回读速度', back3.tempos.map((t) => [t.tick, t.bpm]), src.tempos.map((t) => [t.tick, t.bpm]))
  check(
    'vsq3 回读拍号',
    back3.timeSignatures.map((t) => [t.tick, t.numerator, t.denominator]),
    src.timeSignatures.map((t) => [t.tick, t.numerator, t.denominator]),
  )
  notes.push('规范工程 vsq3：nStyle/noteStyle、pStyle/partStyle、mCtrl 等标签按 vsq3 正确改名')

  /* ============ D. 原生 nStyle 优先于模板默认值 ============ */

  const hand = read(Buffer.from(handWrittenVsq4(), 'utf8'), { name: 'hand.vsqx' })
  check('手写样本合法', validateProject(hand), [])
  check('手写样本音符数', noteCount(hand), 2)
  check('手写样本音符 0 的 accent 被读出', hand.tracks[0].notes[0].attributes.nStyle.accent, 77)
  check('手写样本音符 0 的 vibLen 被读出', hand.tracks[0].notes[0].attributes.nStyle.vibLen, 64)
  assert('手写样本音符 0 的颤音被读出', !!hand.tracks[0].notes[0].attributes.vibrato)
  check('手写样本音符 1 没有 nStyle', hand.tracks[0].notes[1].attributes.nStyle, undefined)

  const handOut = write(hand, { name: 'hand' })
  const handText = handOut.toString('utf8')
  assert('回写保留原生 accent=77', handText.includes('<v id="accent">77</v>'))
  assert('回写保留原生 decay=31', handText.includes('<v id="decay">31</v>'))
  assert('回写保留原生 bendDep=12', handText.includes('<v id="bendDep">12</v>'))
  assert('回写保留原生 opening=100', handText.includes('<v id="opening">100</v>'))
  assert('回写保留原生 vibLen=64', handText.includes('<v id="vibLen">64</v>'))
  assert('回写保留原生 vibType=1', handText.includes('<v id="vibType">1</v>'))
  assert('回写保留颤音序列 <seq id="vibrato">', handText.includes('<seq id="vibrato">'))
  assert('没有原生 nStyle 的音符也补上了模板默认值', handText.includes('<v id="accent">50</v>'))
  check('回写后 nStyle 出现次数 = 音符数', (handText.match(/<nStyle>/g) ?? []).length, 2)

  const handBack = read(handOut, { name: 'hand.vsqx' })
  const styleBack = handBack.tracks[0].notes[0].attributes.nStyle
  check(
    '自定义 nStyle 往返一致',
    sortedJson({ ...styleBack, vibrato: undefined }),
    sortedJson({
      accent: 77,
      decay: 31,
      bendDep: 12,
      bendLen: 5,
      fallPort: 3,
      risePort: 2,
      opening: 100,
      vibLen: 64,
      vibType: 1,
    }),
  )
  check('颤音 depth 往返', handBack.tracks[0].notes[0].attributes.vibrato.depth, 40)
  check('颤音 rate 往返', handBack.tracks[0].notes[0].attributes.vibrato.rate, 55)
  notes.push('手写 vsq4：自定义 nStyle 9 格与颤音 seq 全部回写（原生值优先于模板默认值）')

  /* ============ E. 只有 IR 颤音（没有原生 seq）时也要生成 seq ============ */

  const irVib = createProject({
    name: 'irvib',
    tempos: [{ tick: 0, bpm: 120 }],
    timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }],
    tracks: [
      {
        name: 'V',
        notes: [{ tick: 0, duration: 480, key: 60, lyric: 'a', attributes: { vibrato: { length: 240, depth: 30, rate: 5.5, delay: 60 } } }],
      },
    ],
  })
  const irText = write(irVib, { name: 'irvib' }).toString('utf8')
  assert('IR 颤音生成了 seq', irText.includes('<seq id="vibrato">'))
  assert('IR 颤音把 vibLen 写成了非 0', /<v id="vibLen">(?!0<\/v>)\d+<\/v>/.test(irText))
  const irBack = read(write(irVib, { name: 'irvib' }), { name: 'irvib' })
  assert('IR 颤音往返后仍在', !!irBack.tracks[0].notes[0].attributes.vibrato)
  check('IR 颤音往返合法', validateProject(irBack), [])

  /* ============ F. 零轨道工程：仍然写出可被加载的骨架 ============ */

  const empty = createProject({ name: 'empty', tracks: [] })
  check('零轨道工程', empty.tracks.length, 0)
  const emptyText = write(empty, { name: 'empty' }).toString('utf8')
  assert('零轨道也保留了 <vsTrack>（vsq4 schema 要求至少一条）', emptyText.includes('<vsTrack>'))
  assert('零轨道不留占位音符', !emptyText.includes('<note>'))
  const emptyBack = read(Buffer.from(emptyText, 'utf8'), { name: 'empty' })
  check('零轨道回读合法', validateProject(emptyBack), [])
  check('零轨道回读音符数', noteCount(emptyBack), 0)

  /* ============ G. 真实样本：nStyle 逐音符保持一致 ============ */

  for (const [file, variant] of [
    ['real-sample-1.vsqx', 'vsq3'],
    ['real-sample-2.vsqx', 'vsq4'],
  ]) {
    const p = join(SAMPLES_DIR, file)
    if (!existsSync(p)) {
      notes.push(`未找到 tests/samples/${file}，跳过`)
      continue
    }
    const sample = read(readFileSync(p), { name: file })
    check(`${file} 合法`, validateProject(sample), [])
    const round = read(write(sample, { name: file }), { name: file })
    check(`${file} 往返合法`, validateProject(round), [])
    check(`${file} 往返音符数`, noteCount(round), noteCount(sample))

    let compared = 0
    let mismatched = 0
    let styled = 0
    for (let ti = 0; ti < sample.tracks.length; ti += 1) {
      const a = sample.tracks[ti].notes
      const b = round.tracks[ti]?.notes ?? []
      for (let ni = 0; ni < a.length; ni += 1) {
        const sa = { ...(a[ni].attributes?.nStyle ?? {}) }
        const sb = { ...(b[ni]?.attributes?.nStyle ?? {}) }
        delete sa.vibrato
        delete sb.vibrato
        if (Object.keys(sa).length) styled += 1
        compared += 1
        if (sortedJson(sa) !== sortedJson(sb)) mismatched += 1
      }
    }
    check(`${file} 逐音符 nStyle 往返不一致数`, mismatched, 0)
    assert(`${file} 样本里确实有原生 nStyle（${styled} 个音符）`, styled > 0)
    assert(`${file} 每个音符往返后都有 nStyle`, round.tracks.every((t) => t.notes.every((n) => n.attributes?.nStyle)))
    notes.push(`${file}（${variant}）：${compared} 个音符的原生 nStyle 往返后逐格一致`)
  }

  if (failures.length) {
    throw new Error(`vsqx 专项自测 ${failures.length} 项失败：\n  - ${failures.join('\n  - ')}`)
  }
  return { passed, notes }
}

// 允许单独运行：node app/server/core/formats/__tests__/vsqx.test.mjs
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('__tests__/vsqx.test.mjs')) {
  run().then((r) => {
    console.log(`✓ 通过 ${r.passed} 项断言`)
    for (const n of r.notes) console.log('  · ' + n)
  })
}
