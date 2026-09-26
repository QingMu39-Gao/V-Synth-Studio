/**
 * 把 pinyin-data 的 pinyin.txt 转换成程序用的紧凑拼音表。
 *
 * 用法：node app/server/data/build-pinyin.mjs <pinyin.txt 路径>
 * 输出：app/server/data/pinyin.json  ——  { "一": "yi", ... }
 *
 * 说明：
 *  - 声调符号会被去掉（声库/UTAU 中文音源普遍使用无声调拼音）
 *  - 多音字只取第一个读音（词级别消歧需要分词，超出本工具范围，界面上已注明）
 *  - 只保留基本区与扩展 A 区汉字，控制文件体积
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))

/** 带声调符号的拼音 → 无声调 */
const TONE_MAP = {
  ā: 'a', á: 'a', ǎ: 'a', à: 'a', a: 'a',
  ē: 'e', é: 'e', ě: 'e', è: 'e', e: 'e',
  ī: 'i', í: 'i', ǐ: 'i', ì: 'i', i: 'i',
  ō: 'o', ó: 'o', ǒ: 'o', ò: 'o', o: 'o',
  ū: 'u', ú: 'u', ǔ: 'u', ù: 'u', u: 'u',
  ǖ: 'v', ǘ: 'v', ǚ: 'v', ǜ: 'v', ü: 'v', v: 'v',
  ń: 'n', ň: 'n', ǹ: 'n', ṅ: 'n',
  m̄: 'm', m̀: 'm', ế: 'e', ề: 'e', ể: 'e', ễ: 'e',
}

function stripTone(pinyin) {
  let out = ''
  for (const ch of pinyin) {
    if (TONE_MAP[ch] !== undefined) out += TONE_MAP[ch]
    else if (/[1-5]/.test(ch)) continue // 数字声调
    else out += ch
  }
  return out.toLowerCase().replace(/ü/g, 'v')
}

function main() {
  const input = process.argv[2]
  if (!input) {
    console.error('用法：node build-pinyin.mjs <pinyin.txt 路径>')
    process.exitCode = 1
    return
  }
  const text = readFileSync(input, 'utf8')
  const table = {}
  let total = 0
  let kept = 0

  for (const line of text.split(/\r?\n/)) {
    if (!line || line.startsWith('#')) continue
    const m = line.match(/^U\+([0-9A-Fa-f]+):\s*([^#]+)/)
    if (!m) continue
    total += 1
    const code = parseInt(m[1], 16)
    // 基本区 4E00-9FFF 与扩展 A 区 3400-4DBF
    const isBase = code >= 0x4e00 && code <= 0x9fff
    const isExtA = code >= 0x3400 && code <= 0x4dbf
    if (!isBase && !isExtA) continue
    const readings = m[2].split(',').map((s) => s.trim()).filter(Boolean)
    if (!readings.length) continue
    const first = stripTone(readings[0])
    if (!first) continue
    table[String.fromCodePoint(code)] = first
    kept += 1
  }

  const outPath = join(__dirname, 'pinyin.json')
  writeFileSync(outPath, JSON.stringify(table), 'utf8')
  const size = Buffer.byteLength(JSON.stringify(table))
  console.log(`解析 ${total} 条，收录 ${kept} 个汉字`)
  console.log(`已写出 ${outPath}（${(size / 1024).toFixed(0)} KB）`)
  const samples = ['一', '中', '文', '调', '教', '初', '音', '未', '来']
  console.log('抽查：' + samples.map((c) => `${c}=${table[c] ?? '?'}`).join('  '))
}

main()
