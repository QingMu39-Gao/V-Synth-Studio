/**
 * 转换增强算子
 *
 * 这些算子是「比 UtaFormatix 功能更多」的主要来源：在格式转换之上叠加
 * 转调、歌词改写（假名/罗马音/拼音/VCV 化）、节奏量化、轨道拆分合并等后期处理。
 *
 * 所有算子都是纯函数：接收 Project，返回 { project, log }。
 */

import { existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  TPQ,
  createProject,
  cloneProject,
  sortNotes,
  unoverlapNotes,
  transposeProject,
  projectEndTick,
  projectStartTick,
  measureToTick,
  tickToMeasure,
  curveValueAt,
  normalizeCurve,
} from './ir.mjs'

/* ============================================================ 歌词处理 */

/** 五十音 + 拗音 → 罗马音（平文式/Hepburn 折中，偏向 UTAU 常用写法） */
const KANA_ROMAJI_PAIRS = [
  // 拗音（三拍）优先
  ['きゃ', 'kya'], ['きゅ', 'kyu'], ['きょ', 'kyo'], ['ぎゃ', 'gya'], ['ぎゅ', 'gyu'], ['ぎょ', 'gyo'],
  ['しゃ', 'sha'], ['しゅ', 'shu'], ['しょ', 'sho'], ['じゃ', 'ja'], ['じゅ', 'ju'], ['じょ', 'jo'],
  ['ちゃ', 'cha'], ['ちゅ', 'chu'], ['ちょ', 'cho'], ['ぢゃ', 'ja'], ['ぢゅ', 'ju'], ['ぢょ', 'jo'],
  ['にゃ', 'nya'], ['にゅ', 'nyu'], ['にょ', 'nyo'], ['ひゃ', 'hya'], ['ひゅ', 'hyu'], ['ひょ', 'hyo'],
  ['びゃ', 'bya'], ['びゅ', 'byu'], ['びょ', 'byo'], ['ぴゃ', 'pya'], ['ぴゅ', 'pyu'], ['ぴょ', 'pyo'],
  ['みゃ', 'mya'], ['みゅ', 'myu'], ['みょ', 'myo'], ['りゃ', 'rya'], ['りゅ', 'ryu'], ['りょ', 'ryo'],
  ['ふぁ', 'fa'], ['ふぃ', 'fi'], ['ふぇ', 'fe'], ['ふぉ', 'fo'], ['ふゅ', 'fyu'],
  ['てぃ', 'ti'], ['てゅ', 'tyu'], ['でぃ', 'di'], ['でゅ', 'dyu'], ['とぅ', 'tu'], ['どぅ', 'du'],
  ['うぃ', 'wi'], ['うぇ', 'we'], ['うぉ', 'wo'], ['ゔぁ', 'va'], ['ゔぃ', 'vi'], ['ゔぇ', 've'], ['ゔぉ', 'vo'],
  ['しぇ', 'she'], ['じぇ', 'je'], ['ちぇ', 'che'], ['つぁ', 'tsa'], ['つぃ', 'tsi'], ['つぇ', 'tse'], ['つぉ', 'tso'],
  ['いぇ', 'ye'], ['くぁ', 'kwa'], ['くぃ', 'kwi'], ['くぇ', 'kwe'], ['くぉ', 'kwo'], ['ぐぁ', 'gwa'],
  ['すぃ', 'si'], ['ずぃ', 'zi'], ['きぇ', 'kye'], ['ぎぇ', 'gye'], ['にぇ', 'nye'], ['ひぇ', 'hye'],
  // 基本五十音
  ['あ', 'a'], ['い', 'i'], ['う', 'u'], ['え', 'e'], ['お', 'o'],
  ['か', 'ka'], ['き', 'ki'], ['く', 'ku'], ['け', 'ke'], ['こ', 'ko'],
  ['が', 'ga'], ['ぎ', 'gi'], ['ぐ', 'gu'], ['げ', 'ge'], ['ご', 'go'],
  ['さ', 'sa'], ['し', 'shi'], ['す', 'su'], ['せ', 'se'], ['そ', 'so'],
  ['ざ', 'za'], ['じ', 'ji'], ['ず', 'zu'], ['ぜ', 'ze'], ['ぞ', 'zo'],
  ['た', 'ta'], ['ち', 'chi'], ['つ', 'tsu'], ['て', 'te'], ['と', 'to'],
  ['だ', 'da'], ['ぢ', 'ji'], ['づ', 'zu'], ['で', 'de'], ['ど', 'do'],
  ['な', 'na'], ['に', 'ni'], ['ぬ', 'nu'], ['ね', 'ne'], ['の', 'no'],
  ['は', 'ha'], ['ひ', 'hi'], ['ふ', 'fu'], ['へ', 'he'], ['ほ', 'ho'],
  ['ば', 'ba'], ['び', 'bi'], ['ぶ', 'bu'], ['べ', 'be'], ['ぼ', 'bo'],
  ['ぱ', 'pa'], ['ぴ', 'pi'], ['ぷ', 'pu'], ['ぺ', 'pe'], ['ぽ', 'po'],
  ['ま', 'ma'], ['み', 'mi'], ['む', 'mu'], ['め', 'me'], ['も', 'mo'],
  ['や', 'ya'], ['ゆ', 'yu'], ['よ', 'yo'],
  ['ら', 'ra'], ['り', 'ri'], ['る', 'ru'], ['れ', 're'], ['ろ', 'ro'],
  ['わ', 'wa'], ['ゐ', 'wi'], ['ゑ', 'we'], ['を', 'o'], ['ん', 'n'],
  ['ぁ', 'a'], ['ぃ', 'i'], ['ぅ', 'u'], ['ぇ', 'e'], ['ぉ', 'o'],
  ['ゃ', 'ya'], ['ゅ', 'yu'], ['ょ', 'yo'], ['ゎ', 'wa'],
  ['ゔ', 'vu'], ['ヴ', 'vu'], ['ー', '-'],
]

const KANA_TO_ROMAJI = new Map(KANA_ROMAJI_PAIRS)

/** 片假名 → 平假名 */
export function katakanaToHiragana(str) {
  return String(str).replace(/[\u30a1-\u30f6]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
}

/** 平假名 → 片假名 */
export function hiraganaToKatakana(str) {
  return String(str).replace(/[\u3041-\u3096]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
}

export function isKana(str) {
  return /[\u3041-\u3096\u30a1-\u30f6]/.test(String(str))
}

/** 假名（平/片）→ 罗马音；无法转换的字符原样保留 */
export function kanaToRomaji(input) {
  let s = katakanaToHiragana(String(input))
  let out = ''
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]
    if (c === 'っ') {
      // 促音：双写下一个辅音
      const next = KANA_TO_ROMAJI.get(s.slice(i + 1, i + 3)) ?? KANA_TO_ROMAJI.get(s[i + 1]) ?? ''
      const head = next.match(/^[a-z]/)?.[0] ?? ''
      out += head && !'aeiou'.includes(head) ? head : ''
      continue
    }
    if (c === 'ー') {
      // 长音符：延续上一个元音
      const vowel = out.match(/[aeiou]$/)?.[0] ?? ''
      out += vowel
      continue
    }
    if (c === 'ん') {
      // ん 后接元音或 y 时写作 n'
      const next = KANA_TO_ROMAJI.get(s.slice(i + 1, i + 3)) ?? KANA_TO_ROMAJI.get(s[i + 1]) ?? ''
      out += /^[aeiouy]/.test(next) ? "n'" : 'n'
      continue
    }
    const two = s.slice(i, i + 2)
    const three = s.slice(i, i + 3)
    if (KANA_TO_ROMAJI.has(three)) {
      out += KANA_TO_ROMAJI.get(three)
      i += 2
      continue
    }
    if (KANA_TO_ROMAJI.has(two)) {
      out += KANA_TO_ROMAJI.get(two)
      i += 1
      continue
    }
    if (KANA_TO_ROMAJI.has(c)) {
      out += KANA_TO_ROMAJI.get(c)
      continue
    }
    out += c
  }
  return out
}

const ROMAJI_TO_KANA = (() => {
  const map = new Map()
  // 长的先匹配，避免 'sha' 被 'sa' 抢先
  const pairs = [...KANA_ROMAJI_PAIRS].filter(([, r]) => r && r !== '-').sort((a, b) => b[1].length - a[1].length)
  for (const [kana, romaji] of pairs) {
    if (!map.has(romaji)) map.set(romaji, kana)
  }
  // 常见异写
  const aliases = {
    si: 'し', ti: 'てぃ', tu: 'つ', hu: 'ふ', zi: 'じ', sya: 'しゃ', syu: 'しゅ', syo: 'しょ',
    tya: 'ちゃ', tyu: 'ちゅ', tyo: 'ちょ', zya: 'じゃ', zyu: 'じゅ', zyo: 'じょ',
    cya: 'ちゃ', cyu: 'ちゅ', cyo: 'ちょ', ja: 'じゃ', ju: 'じゅ', jo: 'じょ',
    fa: 'ふぁ', fi: 'ふぃ', fe: 'ふぇ', fo: 'ふぉ', di: 'でぃ', du: 'どぅ', va: 'ゔぁ', vi: 'ゔぃ', ve: 'ゔぇ', vo: 'ゔぉ',
    ye: 'いぇ', wi: 'うぃ', we: 'うぇ', wo: 'うぉ', n: 'ん', nn: 'ん',
  }
  for (const [k, v] of Object.entries(aliases)) if (!map.has(k)) map.set(k, v)
  return map
})()

const ROMAJI_KEYS_BY_LENGTH = [...ROMAJI_TO_KANA.keys()].sort((a, b) => b.length - a.length)

/** 罗马音 → 平假名；无法识别的片段原样保留 */
export function romajiToKana(input) {
  const s = String(input).toLowerCase()
  let out = ''
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (/\s/.test(c)) {
      out += ' '
      i += 1
      continue
    }
    // 促音：双写辅音
    if (c === s[i + 1] && /[bcdfghjklmpqrstvwxyz]/.test(c)) {
      out += 'っ'
      i += 1
      continue
    }
    let matched = null
    for (const key of ROMAJI_KEYS_BY_LENGTH) {
      if (key.length > 1 && s.startsWith(key, i)) {
        matched = key
        break
      }
    }
    if (!matched && ROMAJI_TO_KANA.has(c)) matched = c
    if (matched) {
      out += ROMAJI_TO_KANA.get(matched)
      i += matched.length
      continue
    }
    if (c === "'") {
      i += 1
      continue
    }
    out += s[i]
    i += 1
  }
  return out
}

const VOWELS = ['a', 'i', 'u', 'e', 'o']

/** 从任意歌词提取元音（用于 VCV 前缀、连音判断） */
export function extractVowel(lyric) {
  if (!lyric) return ''
  let s = String(lyric).trim()
  if (s === '' || s === '-' || s === 'R' || s === 'r' || s === '息' || s === 'br') return ''
  if (isKana(s)) s = kanaToRomaji(s)
  const lower = s.toLowerCase().replace(/[^a-z']/g, '')
  if (!lower) return ''
  // 取最后一个元音
  for (let i = lower.length - 1; i >= 0; i -= 1) {
    if (VOWELS.includes(lower[i])) {
      // n 结尾特例
      return lower[i]
    }
  }
  if (/n$/.test(lower)) return 'n'
  return ''
}

/**
 * VCV 化：把 CV 歌词改写为 UTAU 连续音（VCV）所需的「前一个元音 + 本音」形式。
 * @param {object} project
 * @param {{separator?:string, skipRest?:boolean}} opts
 */
export function toVCV(project, opts = {}) {
  const sep = opts.separator ?? ' '
  let changed = 0
  for (const track of project.tracks) {
    let prevVowel = ''
    for (const note of track.notes) {
      const original = note.lyric
      if (!original || original === 'R' || original === '-') {
        if (original === '-') note.lyric = prevVowel ? `${prevVowel}${sep}-` : original
        continue
      }
      const vowel = extractVowel(original)
      if (!vowel) continue
      if (prevVowel) {
        note.lyric = `${prevVowel}${sep}${original}`
        changed += 1
      }
      prevVowel = vowel
      // 休符后重置
      if (opts.resetOnRest !== false && /^(R|r|息|br)$/.test(original)) prevVowel = ''
    }
  }
  return { project, log: `VCV 化：改写了 ${changed} 个音符的歌词` }
}

/** CV 化：去掉 VCV 前缀，回到单元音（"a き" → "き"） */
export function toCV(project) {
  let changed = 0
  for (const track of project.tracks) {
    for (const note of track.notes) {
      const m = String(note.lyric ?? '').match(/^[aiueon]'?\s+(.+)$/i)
      if (m) {
        note.lyric = m[1]
        changed += 1
      }
    }
  }
  return { project, log: `CV 化：去掉了 ${changed} 个 VCV 前缀` }
}

/* ------------------------------------------------------------ 中文拼音 */

let pinyinTable = null
let pinyinLoadError = null

/** 惰性加载拼音表（app/server/data/pinyin.json，可选数据文件） */
export async function loadPinyinTable() {
  if (pinyinTable || pinyinLoadError) return pinyinTable
  try {
    const { readFileSync, existsSync } = await import('node:fs')
    const { fileURLToPath } = await import('node:url')
    const { dirname, join } = await import('node:path')
    const here = dirname(fileURLToPath(import.meta.url))
    const path = join(here, '..', 'data', 'pinyin.json')
    if (!existsSync(path)) {
      pinyinLoadError = '未安装拼音表（app/server/data/pinyin.json）'
      return null
    }
    pinyinTable = JSON.parse(readFileSync(path, 'utf8'))
    return pinyinTable
  } catch (err) {
    pinyinLoadError = String(err.message ?? err)
    return null
  }
}

/** 拼音表状态。注意：表是惰性加载的，不能只看内存缓存——文件在磁盘上就算可用。 */
export function pinyinStatus() {
  const path = pinyinFilePath()
  let onDisk = false
  let bytes = 0
  try {
    onDisk = existsSync(path)
    if (onDisk) bytes = statSync(path).size
  } catch {
    /* 忽略 */
  }
  return {
    loaded: !!pinyinTable || onDisk,
    cached: !!pinyinTable,
    chars: pinyinTable ? Object.keys(pinyinTable).length : 0,
    bytes,
    error: pinyinLoadError,
  }
}

let pinyinPathCache = null
function pinyinFilePath() {
  if (!pinyinPathCache) {
    pinyinPathCache = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'pinyin.json')
  }
  return pinyinPathCache
}

/** 汉字 → 拼音（无声调）。无拼音表时抛中文错误。 */
export async function zhToPinyin(input, opts = {}) {
  const table = await loadPinyinTable()
  if (!table) throw new Error(`无法转换中文歌词：${pinyinLoadError ?? '拼音表未安装'}`)
  const sep = opts.separator ?? ' '
  const s = String(input)
  const out = []
  for (const ch of s) {
    if (/[\u4e00-\u9fff]/.test(ch)) {
      const py = table[ch]
      out.push(py ? (opts.tone === false ? py.replace(/[1-5]$/, '') : py) : ch)
    } else if (/[\u3400-\u4dbf]/.test(ch)) {
      out.push(table[ch] ?? ch)
    } else {
      out.push(ch)
    }
  }
  return out.join(sep).replace(/\s+/g, ' ').trim()
}

/** 异步歌词改写入口（供转换引擎调用） */
export async function convertLyrics(project, mode, opts = {}) {
  const modes = {
    kana2romaji: (l) => kanaToRomaji(l),
    katakana2hiragana: (l) => katakanaToHiragana(l),
    hiragana2katakana: (l) => hiraganaToKatakana(l),
    romaji2kana: (l) => romajiToKana(l),
  }
  if (mode === 'vcv') return toVCV(project, opts)
  if (mode === 'cv') return toCV(project)
  if (mode === 'zh2pinyin') {
    let n = 0
    for (const track of project.tracks) {
      for (const note of track.notes) {
        if (!note.lyric || !/[\u4e00-\u9fff]/.test(note.lyric)) continue
        const converted = await zhToPinyin(note.lyric, opts)
        if (converted !== note.lyric) {
          note.lyric = converted
          n += 1
        }
      }
    }
    return { project, log: `中文转拼音：改写了 ${n} 个音符` }
  }
  const fn = modes[mode]
  if (!fn) return { project, log: '' }
  let n = 0
  for (const track of project.tracks) {
    for (const note of track.notes) {
      if (!note.lyric) continue
      const converted = fn(note.lyric)
      if (converted !== note.lyric) {
        note.lyric = converted
        n += 1
      }
    }
  }
  return { project, log: `${mode}：改写了 ${n} 个音符的歌词` }
}

/* ============================================================ 节奏处理 */

/**
 * 节奏量化：音符起点（与可选的时长）吸附到网格
 * @param {number} grid 以四分音符为 1 的网格，如 0.25 = 十六分音符
 */
export function quantize(project, grid = 0.25, opts = {}) {
  const step = Math.max(1, Math.round(TPQ * grid))
  const strength = opts.strength ?? 1
  const quantizeDuration = opts.duration ?? true
  let n = 0
  for (const track of project.tracks) {
    for (const note of track.notes) {
      const target = Math.round(note.tick / step) * step
      const moved = Math.round(note.tick + (target - note.tick) * strength)
      if (moved !== note.tick) {
        note.tick = Math.max(0, moved)
        n += 1
      }
      if (quantizeDuration) {
        const dTarget = Math.max(step, Math.round(note.duration / step) * step)
        note.duration = Math.round(note.duration + (dTarget - note.duration) * strength)
      }
    }
    unoverlapNotes(track)
  }
  return { project, log: `量化到 1/${Math.round(1 / grid)} 音符：移动了 ${n} 个音符` }
}

/** 整体时间偏移 */
export function shiftTime(project, ticks) {
  const t = Math.round(ticks)
  if (!t) return { project, log: '' }
  for (const track of project.tracks) {
    for (const note of track.notes) note.tick = Math.max(0, note.tick + t)
    for (const c of [track.pitch, ...Object.values(track.parameters ?? {})]) {
      if (c?.ticks) c.ticks = c.ticks.map((x) => Math.max(0, x + t))
    }
    sortNotes(track)
  }
  return { project, log: `整体平移 ${t} tick` }
}

/** 按比例缩放所有时间（用于「贴到另一个 BPM 的伴奏上」） */
export function stretchTime(project, ratio) {
  if (!(ratio > 0) || Math.abs(ratio - 1) < 1e-9) return { project, log: '' }
  const scale = (v) => Math.round(v * ratio)
  for (const track of project.tracks) {
    for (const note of track.notes) {
      note.tick = scale(note.tick)
      note.duration = Math.max(1, scale(note.duration))
    }
    for (const c of [track.pitch, ...Object.values(track.parameters ?? {})]) {
      if (c?.ticks) c.ticks = c.ticks.map(scale)
    }
    sortNotes(track)
  }
  for (const t of project.tempos) t.tick = scale(t.tick)
  for (const t of project.timeSignatures) t.tick = scale(t.tick)
  return { project, log: `时间轴缩放 ${(ratio * 100).toFixed(2)}%` }
}

/** 把整个工程的速度改成指定值（并保持绝对时间不变地重算 tick） */
export function retargetBpm(project, newBpm) {
  if (!(newBpm > 0)) return { project, log: '' }
  const oldBpm = project.tempos[0]?.bpm ?? 120
  if (Math.abs(oldBpm - newBpm) < 1e-9 && project.tempos.length === 1) return { project, log: '' }
  const ratio = newBpm / oldBpm
  const result = stretchTime(project, ratio)
  project.tempos = [{ tick: 0, bpm: newBpm }]
  return { project, log: `速度改为 ${newBpm} BPM（${result.log}）` }
}

/* ============================================================ 音高/过滤 */

/** 音域限制：超出范围的音符整体平移八度（而不是裁掉） */
export function fitRange(project, minKey = 36, maxKey = 96) {
  let moved = 0
  for (const track of project.tracks) {
    let shift = 0
    for (const note of track.notes) {
      while (note.key + shift < minKey) shift += 12
      while (note.key + shift > maxKey) shift -= 12
    }
    if (shift !== 0) {
      for (const note of track.notes) note.key += shift
      if (track.pitch?.values) track.pitch.values = track.pitch.values.map((v) => v + shift)
      moved += 1
    }
  }
  return { project, log: moved ? `音域适配：${moved} 个轨道平移了八度` : '' }
}

/** 删除过短音符（常见的误录入灰尘音符清理） */
export function removeShortNotes(project, minTicks = 30) {
  let removed = 0
  for (const track of project.tracks) {
    const before = track.notes.length
    track.notes = track.notes.filter((n) => n.duration >= minTicks)
    removed += before - track.notes.length
  }
  return { project, log: removed ? `清理了 ${removed} 个过短音符（< ${minTicks} tick）` : '' }
}

/** 限制音高范围：把超范围音符吸到边界 */
export function clampPitch(project, minKey, maxKey) {
  let clamped = 0
  for (const track of project.tracks) {
    for (const note of track.notes) {
      if (note.key < minKey) {
        note.key = minKey
        clamped += 1
      } else if (note.key > maxKey) {
        note.key = maxKey
        clamped += 1
      }
    }
    if (track.pitch?.values) {
      track.pitch.values = track.pitch.values.map((v) => Math.min(maxKey, Math.max(minKey, v)))
    }
  }
  return { project, log: clamped ? `限制了 ${clamped} 个音符的音高` : '' }
}

/** 合并同音高连续音符（长音拼接） */
export function mergeTiedNotes(project, maxGapTicks = 5) {
  let merged = 0
  for (const track of project.tracks) {
    sortNotes(track)
    const out = []
    for (const note of track.notes) {
      const prev = out[out.length - 1]
      const gap = prev ? note.tick - (prev.tick + prev.duration) : Infinity
      const samePitch = prev && prev.key === note.key
      const sameLyric = prev && String(prev.lyric ?? '') === String(note.lyric ?? '')
      const isExtend = note.lyric === '-' || note.lyric === ''
      if (prev && samePitch && gap <= maxGapTicks && (sameLyric || isExtend)) {
        prev.duration = note.tick + note.duration - prev.tick
        merged += 1
      } else {
        out.push(note)
      }
    }
    track.notes = out
  }
  return { project, log: merged ? `合并了 ${merged} 个连续同音音符` : '' }
}

/* ============================================================ 轨道操作 */

/** 只保留指定轨道（按索引） */
export function selectTracks(project, indices) {
  if (!Array.isArray(indices) || !indices.length) return { project, log: '' }
  const set = new Set(indices)
  const removed = project.tracks.length - project.tracks.filter((_, i) => set.has(i)).length
  project.tracks = project.tracks.filter((_, i) => set.has(i))
  return { project, log: `保留了 ${project.tracks.length} 个轨道，移除 ${removed} 个` }
}

/** 合并所有轨道为一条（多声部合一，转换到单轨编辑器时用） */
export function mergeTracks(project) {
  if (project.tracks.length <= 1) return { project, log: '' }
  const all = []
  for (const track of project.tracks) all.push(...track.notes)
  const merged = {
    ...project.tracks[0],
    id: 'merged',
    name: project.tracks.map((t) => t.name).join(' + '),
    notes: all,
    pitch: { ticks: [], values: [] },
    parameters: {},
  }
  sortNotes(merged)
  unoverlapNotes(merged)
  const count = project.tracks.length
  project.tracks = [merged]
  return { project, log: `合并了 ${count} 个轨道` }
}

/** 按音高拆分：把一条轨道按音域拆成多条（分离主旋律与和声） */
export function splitTracksByPitch(project, threshold = 60) {
  const out = []
  for (const track of project.tracks) {
    const low = track.notes.filter((n) => n.key < threshold)
    const high = track.notes.filter((n) => n.key >= threshold)
    if (!low.length || !high.length) {
      out.push(track)
      continue
    }
    out.push({ ...track, notes: low, id: `${track.id}-low`, name: `${track.name} 低声部` })
    out.push({ ...track, notes: high, id: `${track.id}-high`, name: `${track.name} 高声部` })
  }
  const added = out.length - project.tracks.length
  project.tracks = out
  return { project, log: added ? `按音高拆分成 ${out.length} 个轨道` : '' }
}

/* ============================================================ 参数曲线 */

/** 移除所有参数曲线（目标格式不支持时避免产生垃圾数据） */
export function stripParameters(project, keep = []) {
  const keepSet = new Set(keep)
  let removed = 0
  for (const track of project.tracks) {
    for (const key of Object.keys(track.parameters ?? {})) {
      if (!keepSet.has(key)) {
        delete track.parameters[key]
        removed += 1
      }
    }
    if (!keepSet.has('pitch') && track.pitch) track.pitch = { ticks: [], values: [] }
  }
  return { project, log: removed ? `移除了 ${removed} 条参数曲线` : '' }
}

/** 把离散点曲线按固定步长重采样（部分格式只接受等距采样） */
export function resampleParameters(project, stepTicks = 20) {
  let n = 0
  for (const track of project.tracks) {
    const resample = (curve) => {
      if (!curve?.ticks?.length) return curve
      const out = { ticks: [], values: [] }
      const start = curve.ticks[0]
      const end = curve.ticks[curve.ticks.length - 1]
      for (let t = start; t <= end; t += stepTicks) {
        out.ticks.push(t)
        out.values.push(curveValueAt(curve, t))
      }
      return out
    }
    track.pitch = resample(track.pitch)
    for (const key of Object.keys(track.parameters ?? {})) {
      track.parameters[key] = resample(track.parameters[key])
    }
    n += 1
  }
  return { project, log: `参数曲线重采样到每 ${stepTicks} tick 一点（${n} 轨）` }
}

/* ============================================================ 变换管线 */

export const TRANSFORM_OPS = [
  { id: 'transpose', label: '转调', type: 'number', unit: '半音', default: 0, hint: '正数升调，负数降调，音高曲线同步移动' },
  { id: 'lyrics', label: '歌词改写', type: 'select', default: 'none',
    options: [
      { value: 'none', label: '不改写' },
      { value: 'kana2romaji', label: '假名 → 罗马音' },
      { value: 'romaji2kana', label: '罗马音 → 假名' },
      { value: 'katakana2hiragana', label: '片假名 → 平假名' },
      { value: 'hiragana2katakana', label: '平假名 → 片假名' },
      { value: 'zh2pinyin', label: '中文 → 拼音（需拼音表）' },
      { value: 'vcv', label: 'VCV 化（UTAU 连续音）' },
      { value: 'cv', label: 'CV 化（去掉 VCV 前缀）' },
    ] },
  { id: 'quantize', label: '节奏量化', type: 'select', default: 'none',
    options: [
      { value: 'none', label: '不量化' },
      { value: '1/4', label: '四分音符' },
      { value: '1/8', label: '八分音符' },
      { value: '1/16', label: '十六分音符' },
      { value: '1/32', label: '三十二分音符' },
    ] },
  { id: 'retargetBpm', label: '速度重设', type: 'number', unit: 'BPM', default: 0, hint: '0 表示不改；填写后所有音符时间会等比缩放以保持绝对时长' },
  { id: 'shiftBeats', label: '整体平移', type: 'number', unit: '拍', default: 0, hint: '常用 +1 拍留出前奏空位' },
  { id: 'fitRange', label: '音域适配', type: 'toggle', default: false, hint: '超出范围时整体平移八度而不是删音符' },
  { id: 'clampRange', label: '限制音高到', type: 'rangeKeys', default: null, hint: '把超范围音符吸附到边界（例如目标声库音域窄）' },
  { id: 'removeShort', label: '清理过短音符', type: 'number', unit: 'tick', default: 0, hint: '建议 30；0 表示不清' },
  { id: 'mergeTied', label: '合并连续同音', type: 'toggle', default: false },
  { id: 'mergeTracks', label: '合并全部轨道', type: 'toggle', default: false, hint: '目标格式单轨时使用' },
  { id: 'splitByPitch', label: '按音高拆轨', type: 'toggle', default: false },
  { id: 'stripParams', label: '丢弃参数曲线', type: 'toggle', default: false, hint: '目标格式不支持参数时避免产生垃圾数据' },
  { id: 'resampleParams', label: '参数曲线重采样', type: 'number', unit: 'tick', default: 0, hint: '目标格式要求等距采样时使用，建议 20' },
]

/**
 * 执行变换管线
 * @param {object} project
 * @param {object} options
 * @returns {Promise<{project:object, logs:string[]}>}
 */
export async function applyTransforms(project, options = {}) {
  const logs = []
  const p = cloneProject(project)
  const push = (r) => {
    if (r?.log) logs.push(r.log)
  }

  if (options.transpose) push(transposeProject(p, Number(options.transpose)) && { log: `转调 ${options.transpose > 0 ? '+' : ''}${options.transpose} 半音` })
  if (options.lyrics && options.lyrics !== 'none') push(await convertLyrics(p, options.lyrics, options.lyricOptions ?? {}))

  if (options.quantize && options.quantize !== 'none') {
    const grid = { '1/4': 1, '1/8': 0.5, '1/16': 0.25, '1/32': 0.125 }[options.quantize]
    if (grid) push(quantize(p, grid))
  }

  if (options.shiftBeats) push(shiftTime(p, Number(options.shiftBeats) * TPQ))
  if (options.retargetBpm > 0) push(retargetBpm(p, Number(options.retargetBpm)))
  if (options.fitRange) push(fitRange(p, options.minKey ?? 36, options.maxKey ?? 96))
  if (Array.isArray(options.clampRange) && options.clampRange.length === 2) {
    push(clampPitch(p, options.clampRange[0], options.clampRange[1]))
  }
  if (options.removeShort > 0) push(removeShortNotes(p, Number(options.removeShort)))
  if (options.mergeTied) push(mergeTiedNotes(p))
  if (options.splitByPitch) push(splitTracksByPitch(p, options.splitThreshold ?? 60))
  if (options.mergeTracks) push(mergeTracks(p))
  if (Array.isArray(options.keepTracks)) push(selectTracks(p, options.keepTracks))
  if (options.stripParams) push(stripParameters(p, options.keepParams ?? []))
  if (options.resampleParams > 0) push(resampleParameters(p, Number(options.resampleParams)))

  for (const track of p.tracks) {
    sortNotes(track)
    unoverlapNotes(track)
  }
  return { project: p, logs }
}

export default {
  applyTransforms,
  TRANSFORM_OPS,
  kanaToRomaji,
  romajiToKana,
  katakanaToHiragana,
  hiraganaToKatakana,
  extractVowel,
  toVCV,
  toCV,
  zhToPinyin,
  quantize,
  shiftTime,
  stretchTime,
  retargetBpm,
  fitRange,
  clampPitch,
  mergeTiedNotes,
  mergeTracks,
  splitTracksByPitch,
  selectTracks,
  stripParameters,
  resampleParameters,
  convertLyrics,
}
