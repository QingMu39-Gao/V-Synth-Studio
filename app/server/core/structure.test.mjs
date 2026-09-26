/**
 * 结构指纹测试
 *
 *   node app/server/core/structure.test.mjs
 *
 * 为什么需要它：
 *   格式模块的「往返自测」是 write → read（自己写、自己读），属于循环论证——
 *   如果 reader 和 writer 对格式的理解**一致地错**，往返照样完美通过，
 *   但真实编辑器打开时会直接报错。用户的 SVP → VPR 就是这么翻车的：
 *   往返全绿，VOCALOID 却打不开。
 *
 *   这个测试换个基准：拿**真实工程文件**当参照物，把我生成的文件与它做
 *   「结构指纹」对比（JSON 键路径 / XML 元素与属性 / 文本字段名），
 *   报出「真实文件有、我生成的文件没有」的结构——那正是编辑器会拒绝的地方。
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadFormat } from './formats/index.mjs'
import { getVoices } from './voices.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SAMPLES = join(__dirname, '..', '..', '..', 'tests', 'samples')
const WORK = join(tmpdir(), 'vpir-structure')

/* ------------------------------------------------------- 结构指纹提取 */

/** JSON → 所有键路径（数组归一为 []） */
function jsonFingerprint(text) {
  let data
  try {
    // 真实文件可能带 BOM，SynthV 的文件末尾还会有 NUL 字节，都要容忍
    data = JSON.parse(text.replace(/^\uFEFF/, '').replace(/[\u0000\s]+$/, ''))
  } catch {
    return null
  }
  const out = new Set()
  const walk = (obj, prefix, depth) => {
    if (depth > 9 || obj === null || typeof obj !== 'object') return
    if (Array.isArray(obj)) {
      for (const item of obj.slice(0, 3)) walk(item, `${prefix}[]`, depth + 1)
      return
    }
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k
      out.add(path)
      walk(v, path, depth + 1)
    }
  }
  walk(data, '', 0)
  return out
}

/** XML → 元素路径 + 属性名 */
function xmlFingerprint(text) {
  const out = new Set()
  const stack = []
  const tagRe = /<([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*"[^"]*")*)\s*(\/?)>|<\/([A-Za-z_][\w.:-]*)>/g
  let m
  while ((m = tagRe.exec(text))) {
    if (m[4]) {
      const idx = stack.lastIndexOf(m[4])
      if (idx >= 0) stack.length = idx
      continue
    }
    const name = m[1]
    const path = [...stack, name].join('/')
    out.add(path)
    // 属性名也纳入指纹（VOCALOID 对必需属性很敏感）
    const attrs = m[2] ?? ''
    for (const a of attrs.matchAll(/([\w.:-]+)\s*=/g)) out.add(`${path}@${a[1]}`)
    if (!m[3]) stack.push(name)
  }
  return out
}

/** 段式文本（UTAU .ust 等）→ 段名与字段名 */
function textFingerprint(text) {
  const out = new Set()
  for (const line of text.split(/\r?\n/)) {
    const sec = line.match(/^\s*(\[[^\]]+\])\s*$/)
    if (sec) {
      out.add(sec[1].startsWith('[#') && /^\[#\d+\]$/.test(sec[1]) ? '[#note]' : sec[1])
      continue
    }
    const kv = line.match(/^\s*([A-Za-z_][\w]*)\s*=/)
    if (kv) out.add(`key:${kv[1]}`)
  }
  return out
}

/** YAML（OpenUtau .ustx）→ 按键缩进还原键路径 */
function yamlFingerprint(text) {
  const out = new Set()
  const stack = [] // [{indent, key}]
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue
    const m = raw.match(/^(\s*)(-\s+)?([A-Za-z_][\w]*):/)
    if (!m) continue
    const indent = m[1].length + (m[2] ? 2 : 0)
    const key = m[3]
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
    const path = [...stack.map((s) => s.key), key].join('.')
    out.add(m[2] ? `${path}[]` : path)
    stack.push({ indent, key })
  }
  return out.size ? out : null
}

function fingerprint(text, kind) {
  if (kind === 'json') return jsonFingerprint(text)
  if (kind === 'xml') return xmlFingerprint(text)
  if (kind === 'yaml') return yamlFingerprint(text)
  if (kind === 'text') return textFingerprint(text)
  return null
}

/* ------------------------------------------------------- VPR 解包 */

function extractVprSequence(vprPath, tag) {
  const dir = join(WORK, tag)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, 'sequence.json')
  const ps = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `$z=[System.IO.Compression.ZipFile]::OpenRead('${vprPath}')`,
    "$e=$z.Entries | Where-Object { $_.FullName -like '*sequence.json' } | Select-Object -First 1",
    `if($e){ [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, '${dest}', $true) }`,
    '$z.Dispose()',
  ].join('\n')
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true })
  return readFileSync(dest, 'utf8')
}

/** 把模块写出的 Buffer 落盘（vpr 是 zip，统一按文件处理） */
function materialize(buffer, ext, tag) {
  const dir = join(WORK, tag)
  mkdirSync(dir, { recursive: true })
  const p = join(dir, `out${ext}`)
  writeFileSync(p, buffer)
  return p
}

/* ------------------------------------------------------------ 主流程 */

const CASES = [
  { id: 'vpr', kind: 'json', zip: true, sample: /^real-sample-\d\.vpr$/i },
  { id: 'svp', kind: 'json', sample: /^real-sample-\d\.svp$/i },
  // 注意：.ccs 是 XML，不是 JSON（真实样本以 <?xml 开头）
  { id: 'ccs', kind: 'xml', sample: /^real-sample-\d\.ccs$/i },
  { id: 'vsqx', kind: 'xml', sample: /^real-sample-\d\.vsqx$/i },
  { id: 'ustx', kind: 'yaml', sample: /^openutau-.*\.ustx$/i },
]

async function main() {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })

  let checked = 0
  let problems = 0

  for (const c of CASES) {
    let fmt
    try {
      fmt = await loadFormat(c.id)
    } catch {
      continue
    }
    if (fmt.canRead === false || fmt.canWrite === false) continue

    const files = readdirSync(SAMPLES).filter((f) => c.sample.test(f))
    if (!files.length) continue

    for (const file of files) {
      const samplePath = join(SAMPLES, file)
      checked += 1
      try {
        // 真实文件的结构指纹
        const realText = c.zip ? extractVprSequence(samplePath, `real-${c.id}`) : readFileSync(samplePath, 'utf8')
        const realFp = fingerprint(realText, c.kind)
        if (!realFp) {
          console.log(`○ ${c.id} / ${file}：样本无法解析结构，跳过`)
          continue
        }

        // 用真实样本跑一遍 read → write，再取我生成文件的结构指纹
        const project = fmt.read(readFileSync(samplePath), { name: file })
        const buf = fmt.write(project, { name: file, installedVoices: installedVoicesForTest() })
        const outPath = materialize(buf, fmt.writeExt ?? '.out', `mine-${c.id}`)
        const myText = c.zip ? extractVprSequence(outPath, `mine-${c.id}-z`) : readFileSync(outPath, 'utf8')
        const myFp = fingerprint(myText, c.kind)
        if (!myFp) {
          console.log(`✗ ${c.id} / ${file}：我写出的文件结构无法解析`)
          problems += 1
          continue
        }

        // 只关心「真实有、我没有」的结构缺失；我多出来的字段单独提示（严格的反序列化器可能拒绝）
        const missing = [...realFp].filter((k) => !myFp.has(k))
        const extra = [...myFp].filter((k) => !realFp.has(k))

        // 排除已知的版本差异（V6 专有字段等），避免误报
        const IGNORE = /(aiExp|langID|lastScrollPositionNoteNumber|tempo\.ara|\.ara)/
        const realMissing = missing.filter((k) => !IGNORE.test(k))

        if (realMissing.length) {
          console.log(`✗ ${c.id} / ${file}：缺 ${realMissing.length} 项真实文件里存在的结构`)
          for (const k of realMissing.slice(0, 12)) console.log(`      ${k}`)
          if (realMissing.length > 12) console.log(`      …还有 ${realMissing.length - 12} 项`)
          problems += 1
        } else {
          console.log(`✓ ${c.id} / ${file}：结构与真实文件一致（多出 ${extra.length} 项${extra.length ? '：' + extra.slice(0, 5).join(', ') : ''}）`)
        }
      } catch (err) {
        console.log(`✗ ${c.id} / ${file}：处理失败 —— ${err.message}`)
        problems += 1
      }
    }
  }

  console.log(`\n═══ 结构指纹检查：${checked} 个真实样本，${problems} 项问题 ═══`)
  console.log('（本测试只比较结构，不比较数值；数值正确性由各格式的往返自测负责）')
  if (problems) process.exitCode = 1
}

/** 测试里给 writer 一份「本机已装声库」，让 vpr 的声库校验走真实分支 */
function installedVoicesForTest() {
  try {
    return getVoices().vocaloid.map((b) => ({ compID: b.compID, name: b.name }))
  } catch {
    return []
  }
}

main().catch((err) => {
  console.error('结构指纹测试异常：', err)
  process.exitCode = 1
})
