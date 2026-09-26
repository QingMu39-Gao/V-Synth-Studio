/**
 * 变换算子自测
 *   node app/server/core/transform.test.mjs
 */

import { createProject, createTrack, createNote, TPQ } from './ir.mjs'
import {
  applyTransforms,
  kanaToRomaji,
  romajiToKana,
  katakanaToHiragana,
  extractVowel,
  toVCV,
  toCV,
  zhToPinyin,
  quantize,
  shiftTime,
  retargetBpm,
  mergeTracks,
  mergeTiedNotes,
  splitTracksByPitch,
  removeShortNotes,
  clampPitch,
} from './transform.mjs'

let passed = 0
const failures = []

function eq(label, actual, expected) {
  const a = JSON.stringify(actual)
  const b = JSON.stringify(expected)
  if (a === b) passed += 1
  else failures.push(`✗ ${label}\n    期望 ${b}\n    实际 ${a}`)
}

function ok(label, cond, detail = '') {
  if (cond) passed += 1
  else failures.push(`✗ ${label} ${detail}`)
}

function demoProject() {
  return createProject({
    name: '变换测试',
    tempos: [{ tick: 0, bpm: 120 }],
    tracks: [
      createTrack({
        name: '主唱',
        notes: [
          createNote({ tick: 0, duration: 480, key: 60, lyric: 'きょう' }),
          createNote({ tick: 480, duration: 480, key: 62, lyric: 'は' }),
          createNote({ tick: 960, duration: 120, key: 64, lyric: 'る' }),
          createNote({ tick: 1203, duration: 480, key: 64, lyric: 'る' }),
        ],
      }),
    ],
  })
}

async function main() {
  /* ---------- 假名 ↔ 罗马音 ---------- */
  eq('きょう → kyou', kanaToRomaji('きょう'), 'kyou')
  eq('しゃしゅしょ', kanaToRomaji('しゃしゅしょ'), 'shashusho')
  eq('がっこう（促音）', kanaToRomaji('がっこう'), 'gakkou')
  eq('コーヒー（片假名+长音）', kanaToRomaji('コーヒー'), 'koohii')
  eq('しんいち（ん 后接元音）', kanaToRomaji('しんいち'), "shin'ichi")
  eq('かたかな → ひらがな', katakanaToHiragana('カタカナ'), 'かたかな')
  eq('kyou → きょう', romajiToKana('kyou'), 'きょう')
  eq('gakkou → がっこう', romajiToKana('gakkou'), 'がっこう')

  /* ---------- 元音提取（VCV 的基础） ---------- */
  eq('extractVowel(きょう)', extractVowel('きょう'), 'u')
  eq('extractVowel(は)', extractVowel('は'), 'a')
  eq('extractVowel(R 休符)', extractVowel('R'), '')
  eq('extractVowel(a き) 已是 VCV', extractVowel('a き'), 'i')

  /* ---------- VCV / CV ---------- */
  const vcv = demoProject()
  toVCV(vcv)
  eq('VCV 第一个音符不变', vcv.tracks[0].notes[0].lyric, 'きょう')
  eq('VCV 第二个音符加前缀', vcv.tracks[0].notes[1].lyric, 'u は')
  eq('VCV 第三个音符加前缀', vcv.tracks[0].notes[2].lyric, 'a る')
  toCV(vcv)
  eq('CV 还原', vcv.tracks[0].notes[1].lyric, 'は')

  /* ---------- 中文拼音 ---------- */
  const py = await zhToPinyin('中文调教')
  eq('中文 → 拼音', py, 'zhong wen diao jiao')
  const pySep = await zhToPinyin('初音未来', { separator: '' })
  eq('拼音无分隔符', pySep, 'chuyinweilai')
  const pyMixed = await zhToPinyin('hello 世界')
  ok('中英混排保留英文', pyMixed.includes('shi') && pyMixed.includes('jie'), `实际：${pyMixed}`)

  /* ---------- 转调：音高曲线必须同步 ---------- */
  const t = createProject({
    tempos: [{ tick: 0, bpm: 120 }],
    tracks: [createTrack({
      notes: [createNote({ tick: 0, duration: 480, key: 60, lyric: 'a' })],
      pitch: { ticks: [0, 480], values: [60, 62] },
      parameters: { dynamics: { ticks: [0, 480], values: [0.2, 0.8] } },
    })],
  })
  const up = await applyTransforms(t, { transpose: 3 })
  eq('转调后 note.key', up.project.tracks[0].notes[0].key, 63)
  eq('转调后音高曲线首值', up.project.tracks[0].pitch.values[0], 63)
  eq('转调后音高曲线末值', up.project.tracks[0].pitch.values[1], 65)
  eq('参数曲线不应被转调影响', up.project.tracks[0].parameters.dynamics.values, [0.2, 0.8])

  /* ---------- 量化 ---------- */
  const q = demoProject()
  quantize(q, 0.25) // 十六分音符 = 120 tick
  eq('量化后 tick 对齐', q.tracks[0].notes.map((n) => n.tick), [0, 480, 960, 1200])
  ok('量化后不与下一个音符重叠', q.tracks[0].notes[2].tick + q.tracks[0].notes[2].duration <= 1200,
    `实际结束于 ${q.tracks[0].notes[2].tick + q.tracks[0].notes[2].duration}`)

  /* ---------- 过短音符与合并 ---------- */
  const s = demoProject()
  removeShortNotes(s, 200)
  eq('清理短音符后剩 3 个', s.tracks[0].notes.length, 3)

  const m = createProject({
    tracks: [createTrack({
      notes: [
        createNote({ tick: 0, duration: 480, key: 60, lyric: 'あ' }),
        createNote({ tick: 480, duration: 480, key: 60, lyric: '-' }),
        createNote({ tick: 960, duration: 480, key: 62, lyric: 'い' }),
      ],
    })],
  })
  mergeTiedNotes(m)
  eq('合并同音后剩 2 个', m.tracks[0].notes.length, 2)
  eq('合并后时长', m.tracks[0].notes[0].duration, 960)

  /* ---------- 平移与速度重设 ---------- */
  const sh = demoProject()
  shiftTime(sh, TPQ)
  eq('平移 1 拍', sh.tracks[0].notes[0].tick, 480)

  const bpm = createProject({
    tempos: [{ tick: 0, bpm: 120 }],
    tracks: [createTrack({ notes: [createNote({ tick: 0, duration: 1920, key: 60, lyric: 'a' })] })],
  })
  retargetBpm(bpm, 240)
  eq('速度翻倍后 tick 翻倍', bpm.tracks[0].notes[0].duration, 3840)
  eq('速度已改为 240', bpm.tempos[0].bpm, 240)

  /* ---------- 轨道操作 ---------- */
  const multi = createProject({
    tracks: [
      createTrack({ name: 'A', notes: [createNote({ tick: 0, duration: 240, key: 55, lyric: 'a' })] }),
      createTrack({ name: 'B', notes: [createNote({ tick: 0, duration: 240, key: 72, lyric: 'b' })] }),
    ],
  })
  mergeTracks(multi)
  eq('合并轨道后剩 1 轨', multi.tracks.length, 1)
  eq('合并后音符数', multi.tracks[0].notes.length, 2)

  const sp = createProject({
    tracks: [createTrack({
      notes: [
        createNote({ tick: 0, duration: 240, key: 50, lyric: 'a' }),
        createNote({ tick: 240, duration: 240, key: 70, lyric: 'b' }),
      ],
    })],
  })
  splitTracksByPitch(sp, 60)
  eq('按音高拆成 2 轨', sp.tracks.length, 2)

  const cl = createProject({
    tracks: [createTrack({
      notes: [
        createNote({ tick: 0, duration: 240, key: 20, lyric: 'a' }),
        createNote({ tick: 240, duration: 240, key: 110, lyric: 'b' }),
      ],
    })],
  })
  clampPitch(cl, 48, 84)
  eq('限制音高后', cl.tracks[0].notes.map((n) => n.key), [48, 84])

  /* ---------- 组合管线：一次跑完 ---------- */
  const combo = await applyTransforms(demoProject(), {
    transpose: -2,
    lyrics: 'kana2romaji',
    quantize: '1/16',
    removeShort: 200,
    mergeTied: true,
    shiftBeats: 1,
  })
  // demoProject 有 4 个音符：量化后为 (0,480)(480,480)(960,120)(1200,480)
  // 清理过短音符（<200）去掉 960 那个 → 剩 3 个；后两个音高相同但间隙 240 tick，不会被合并
  eq('组合管线：音符数', combo.project.tracks[0].notes.length, 3)
  eq('组合管线：歌词已罗马音化', combo.project.tracks[0].notes[0].lyric, 'kyou')
  eq('组合管线：已平移 1 拍', combo.project.tracks[0].notes[0].tick, 480)
  eq('组合管线：已移调', combo.project.tracks[0].notes[0].key, 58)
  ok('组合管线产生了日志', combo.logs.length >= 4, `实际 ${combo.logs.length} 条：${combo.logs.join(' / ')}`)

  /* ---------- 输出 ---------- */
  console.log(`\n变换算子自测`)
  for (const f of failures) console.log('  ' + f)
  console.log(`  ${failures.length ? '✗ 失败' : '✓ 通过'}：${passed} 项断言，${failures.length} 项失败\n`)
  if (failures.length) process.exitCode = 1
}

main().catch((err) => {
  console.error('自测异常：', err)
  process.exitCode = 1
})
