// 给 .ps1 补回 UTF-8 BOM
//
// 为什么必须有 BOM：PowerShell 5.1 读**没有 BOM**的 .ps1 时按 ANSI（GBK）解码，
// 中文注释会变乱码，乱码里若含反引号/引号就会吞掉换行 → 语法错。
// 任何编辑工具（含各种 AI 编辑器的 edit 功能）保存 .ps1 时都可能把 BOM 丢掉，
// 所以改完 .ps1 都跑一次这个。
//
//   node tests/manual/fix-ps1-bom.mjs          # 只报告
//   node tests/manual/fix-ps1-bom.mjs --write  # 补 BOM

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = process.cwd()
const WRITE = process.argv.includes('--write')
const BOM = Buffer.from([0xef, 0xbb, 0xbf])
const SKIP_DIRS = new Set(['node_modules', 'target', 'vendor', '.git', 'data'])

/** 递归收集 .ps1 */
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) walk(p, out)
    else if (name.endsWith('.ps1')) out.push(p)
  }
  return out
}

let missing = 0
let fixed = 0

for (const file of walk(ROOT)) {
  const buf = readFileSync(file)
  const hasBom = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf
  const rel = relative(ROOT, file)
  if (hasBom) {
    console.log(`  [有 BOM] ${rel}`)
    continue
  }
  missing++
  if (WRITE) {
    writeFileSync(file, Buffer.concat([BOM, buf]))
    console.log(`  [已补]   ${rel}`)
    fixed++
  } else {
    console.log(`  [缺 BOM] ${rel}`)
  }
}

console.log(
  missing === 0
    ? '\n全部 .ps1 都有 BOM。'
    : `\n${missing} 个 .ps1 缺 BOM${WRITE ? `，已补 ${fixed} 个` : '（加 --write 补上）'}`,
)
process.exit(missing === 0 || WRITE ? 0 : 1)
