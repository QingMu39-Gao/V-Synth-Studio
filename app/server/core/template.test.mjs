/**
 * 模板字段完整性测试
 *
 *   node app/server/core/template.test.mjs
 *
 * 判定标准（很硬，但正是编辑器的要求）：
 *   **模板里存在的每一个字段路径，我写出的文件里也必须存在。**
 *
 * 为什么用它当验收：模板是编辑器接受的真实工程骨架（取自 UtaFormatix3，
 * 见 docs/TEMPLATE-REWRITE-BRIEF.md）。缺任何一个字段都可能导致编辑器拒绝加载，
 * 而「自己写自己读」的往返测试对这类缺失是瞎的。
 *
 * 反向（我多写了模板没有的字段）只提示、不判失败 —— 编辑器通常能容忍多余字段。
 */

import { readFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadFormat } from './formats/index.mjs'
import { canonicalProject } from './selftest.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TEMPLATES = join(__dirname, 'formats', 'templates')
const WORK = join(tmpdir(), 'vpir-template')

/** 格式 → 模板文件 */
const CASES = [
  { id: 'vpr', template: 'template.vprjson', kind: 'json', zip: true },
  { id: 'vsqx', template: 'template.vsqx', kind: 'xml' },
  { id: 'svp', template: 'template.svp', kind: 'json' },
  { id: 'ccs', template: 'template.ccs', kind: 'xml' },
  { id: 'ustx', template: 'template.ustx', kind: 'yaml' },
]

/* ------------------------------------------------------- 结构指纹提取 */

function jsonPaths(text) {
  let data
  try {
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
      const p = prefix ? `${prefix}.${k}` : k
      out.add(p)
      walk(v, p, depth + 1)
    }
  }
  walk(data, '', 0)
  return out
}

function xmlPaths(text) {
  const out = new Set()
  const stack = []
  const re = /<([A-Za-z_][\w.:-]*)((?:\s+[\w.:-]+\s*=\s*"[^"]*")*)\s*(\/?)>|<\/([A-Za-z_][\w.:-]*)>/g
  let m
  while ((m = re.exec(text))) {
    if (m[4]) {
      const i = stack.lastIndexOf(m[4])
      if (i >= 0) stack.length = i
      continue
    }
    const path = [...stack, m[1]].join('/')
    out.add(path)
    for (const a of (m[2] ?? '').matchAll(/([\w.:-]+)\s*=/g)) out.add(`${path}@${a[1]}`)
    if (!m[3]) stack.push(m[1])
  }
  return out
}

function yamlPaths(text) {
  const out = new Set()
  const stack = []
  for (const raw of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (!raw.trim() || /^\s*#/.test(raw)) continue
    const m = raw.match(/^(\s*)(-\s+)?([A-Za-z_][\w]*):/)
    if (!m) continue
    const indent = m[1].length + (m[2] ? 2 : 0)
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop()
    out.add([...stack.map((s) => s.key), m[3]].join('.'))
    stack.push({ indent, key: m[3] })
  }
  return out
}

function fingerprint(text, kind) {
  if (kind === 'json') return jsonPaths(text)
  if (kind === 'xml') return xmlPaths(text)
  if (kind === 'yaml') return yamlPaths(text)
  return null
}

/** 从 .vpr（zip）里取出 sequence.json */
function extractVpr(path, tag) {
  const dir = join(WORK, tag)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const dest = join(dir, 'sequence.json')
  const ps = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `$z=[System.IO.Compression.ZipFile]::OpenRead('${path}')`,
    "$e=$z.Entries | Where-Object { $_.FullName -like '*sequence.json' } | Select-Object -First 1",
    `if($e){ [System.IO.Compression.ZipFileExtensions]::ExtractToFile($e, '${dest}', $true) }`,
    '$z.Dispose()',
  ].join('\n')
  execFileSync('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true })
  return readFileSync(dest, 'utf8')
}

/** .vpr 的 ZIP 条目名（用于单独检查反斜杠约定） */
function vprEntryNames(path) {
  const ps = [
    'Add-Type -AssemblyName System.IO.Compression.FileSystem',
    `$z=[System.IO.Compression.ZipFile]::OpenRead('${path}')`,
    '$z.Entries | ForEach-Object { $_.FullName }',
    '$z.Dispose()',
  ].join('\n')
  const out = execFileSync('powershell', ['-NoProfile', '-Command', ps], { encoding: 'utf8', windowsHide: true })
  return String(out ?? '').split(/\r?\n/).filter((l) => l.trim())
}

/* ------------------------------------------------------------ 主流程 */

async function main() {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })

  let checked = 0
  let problems = 0

  for (const c of CASES) {
    const tplPath = join(TEMPLATES, c.template)
    if (!existsSync(tplPath)) {
      console.log(`○ ${c.id}：没有模板文件（${c.template}），跳过`)
      continue
    }
    let fmt
    try {
      fmt = await loadFormat(c.id)
    } catch {
      continue
    }
    if (fmt.canWrite === false) {
      console.log(`○ ${c.id}：不支持写出，跳过`)
      continue
    }

    checked += 1
    try {
      const tplText = readFileSync(tplPath, 'utf8')
      const tplFp = fingerprint(tplText, c.kind)
      if (!tplFp) {
        console.log(`✗ ${c.id}：模板自身无法解析，测试无法进行`)
        problems += 1
        continue
      }

      const project = canonicalProject()
      const buf = fmt.write(project, { name: '模板完整性测试' })
      const outPath = join(WORK, `out${fmt.writeExt ?? '.out'}`)
      writeFileSync(outPath, buf)

      const myText = c.zip ? extractVpr(outPath, `z-${c.id}`) : readFileSync(outPath, 'utf8')
      const myFp = fingerprint(myText, c.kind)
      if (!myFp) {
        console.log(`✗ ${c.id}：写出的文件无法解析`)
        problems += 1
        continue
      }

      // 模板里有、我没有 —— 这是硬失败
      const missing = [...tplFp].filter((k) => !myFp.has(k))
      const extra = [...myFp].filter((k) => !tplFp.has(k))

      if (missing.length) {
        console.log(`✗ ${c.id}：缺 ${missing.length} 项模板里存在的字段（编辑器可能因此拒绝加载）`)
        for (const k of missing.slice(0, 15)) console.log(`      ${k}`)
        if (missing.length > 15) console.log(`      …还有 ${missing.length - 15} 项`)
        problems += 1
      } else {
        console.log(`✓ ${c.id}：模板字段齐全（另多出 ${extra.length} 项，不影响）`)
      }

      // vpr 额外检查 ZIP 条目名约定
      if (c.zip) {
        const entries = vprEntryNames(outPath)
        const hasBackslash = entries.some((e) => e.includes('Project\\sequence.json'))
        const hasSlash = entries.some((e) => e.includes('Project/sequence.json'))
        console.log(`      ZIP 条目：${entries.join(' | ')}`)
        if (!hasBackslash && !hasSlash) {
          console.log('      ✗ 条目名里找不到 sequence.json')
          problems += 1
        } else if (!hasBackslash) {
          console.log('      ⚠ 只有正斜杠条目；UtaFormatix 写的是反斜杠 `Project\\sequence.json`（VOCALOID5 的约定）')
        }
      }
    } catch (err) {
      console.log(`✗ ${c.id}：处理失败 —— ${err.message}`)
      problems += 1
    }
  }

  console.log(`\n═══ 模板完整性：检查 ${checked} 个格式，${problems} 项问题 ═══`)
  if (problems) process.exitCode = 1
}

main().catch((err) => {
  console.error('模板完整性测试异常：', err)
  process.exitCode = 1
})
