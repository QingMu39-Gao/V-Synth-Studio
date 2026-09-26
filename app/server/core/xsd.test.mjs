/**
 * 用 VOCALOID 自带的官方 XSD 校验 VSQX 输出
 *
 *   node app/server/core/xsd.test.mjs
 *
 * 为什么这是最硬的验证：
 *   VOCALOID6 安装目录里有 vsq3.xsd / vsq4.xsd，就是它自己加载工程时用的 schema。
 *   拿它来校验我们写出的文件，等于「用编辑器的标准答案批改自己的作业」——
 *   比结构指纹更进一步（结构指纹只比对键名，XSD 还管元素顺序、必需/可选、类型）。
 *
 * 实现方式：借 Windows 自带的 .NET（XmlSchemaSet + XmlReader）做真正的 schema 校验，
 * 不引入任何 npm 依赖。
 */

import { readFileSync, readdirSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadFormat } from './formats/index.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SAMPLES = join(__dirname, '..', '..', '..', 'tests', 'samples')
const WORK = join(tmpdir(), 'vpir-xsd')

/** VOCALOID 安装目录里自带的 schema（只读） */
const SCHEMA_CANDIDATES = [
  'H:\\VOCALOID6\\Editor',
  'C:\\Program Files\\VOCALOID6\\Editor',
  'D:\\VOCALOID6\\Editor',
  'C:\\Program Files\\VOCALOID5\\Editor',
  'D:\\VOCALOID5\\Editor',
]

function findSchemas() {
  const found = {}
  for (const dir of SCHEMA_CANDIDATES) {
    if (!existsSync(dir)) continue
    for (const name of ['vsq3.xsd', 'vsq4.xsd']) {
      const p = join(dir, name)
      if (existsSync(p) && !found[name]) found[name] = p
    }
  }
  return found
}

/**
 * 用 .NET 做 XSD 校验
 * @returns {{ok:boolean, errors:string[]}}
 */
function validateWithDotNet(xmlPath, xsdPath) {
  const script = [
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    'Add-Type -AssemblyName System.Xml',
    '$errors = New-Object System.Collections.ArrayList',
    '$schemas = New-Object System.Xml.Schema.XmlSchemaSet',
    // 注意：不能用 $schemas.Add('', $xsd)——XmlSchemaSet 会把空字符串当成
    // 「与 schema 的 targetNamespace 不一致」而抛异常（本机 PowerShell 5.1 上必定失败，
    // 连真实样本都校验不了）。改成先读成 XmlSchema 对象再 Add，判定标准不变。
    `$sr = [System.Xml.XmlReader]::Create('${xsdPath}')`,
    '$null = $schemas.Add([System.Xml.Schema.XmlSchema]::Read($sr, $null))',
    '$sr.Close()',
    '$settings = New-Object System.Xml.XmlReaderSettings',
    '$settings.Schemas = $schemas',
    "$settings.ValidationType = [System.Xml.ValidationType]::Schema",
    '$settings.ValidationFlags = [System.Xml.Schema.XmlSchemaValidationFlags]::ReportValidationWarnings',
    '$handler = { param($s, $e) $null = $errors.Add($e.Message) }',
    '$settings.add_ValidationEventHandler($handler)',
    `$reader = [System.Xml.XmlReader]::Create('${xmlPath}', $settings)`,
    'try { while ($reader.Read()) {} } catch { $null = $errors.Add("读取异常: " + $_.Exception.Message) }',
    '$reader.Close()',
    'if ($errors.Count -eq 0) { "PASS" } else { $errors | ForEach-Object { "ERR: " + $_ } }',
  ].join('\n')

  const out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    timeout: 30000,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  })
  const lines = String(out ?? '').split(/\r?\n/).filter((l) => l.trim())
  if (lines.some((l) => l.trim() === 'PASS')) return { ok: true, errors: [] }
  return { ok: false, errors: lines.filter((l) => l.startsWith('ERR:')).map((l) => l.slice(4).trim()) }
}

async function main() {
  rmSync(WORK, { recursive: true, force: true })
  mkdirSync(WORK, { recursive: true })

  const schemas = findSchemas()
  if (!Object.keys(schemas).length) {
    console.log('○ 本机没找到 VOCALOID 自带的 vsq3.xsd / vsq4.xsd，跳过 XSD 校验')
    console.log('  （装上 VOCALOID 后这个测试会自动生效）')
    return
  }
  console.log('找到官方 schema：')
  for (const [n, p] of Object.entries(schemas)) console.log(`  ${n}  ←  ${p}`)
  console.log('')

  let checked = 0
  let problems = 0

  const vsqx = await loadFormat('vsqx')
  const samples = readdirSync(SAMPLES).filter((f) => /^real-sample-\d\.vsqx$/i.test(f))

  for (const file of samples) {
    const samplePath = join(SAMPLES, file)
    const text = readFileSync(samplePath, 'utf8')
    // 判断是 v3 还是 v4 schema
    const isV3 = /<vsq3[\s>]/.test(text.slice(0, 1200))
    const xsd = isV3 ? schemas['vsq3.xsd'] : schemas['vsq4.xsd']
    if (!xsd) continue

    // 1) 真实样本本身应当通过（用来确认校验器本身工作正常）
    const realResult = validateWithDotNet(samplePath, xsd)
    console.log(`真实样本 ${file}（${isV3 ? 'vsq3' : 'vsq4'} schema）：${realResult.ok ? '通过 ✓' : '不通过（校验器或样本有问题）'}`)
    if (!realResult.ok) {
      for (const e of realResult.errors.slice(0, 3)) console.log(`      ${e}`)
    }

    // 2) 我读入再写出的文件，必须同样通过
    checked += 1
    try {
      const project = vsqx.read(readFileSync(samplePath), { name: file })
      const buf = vsqx.write(project, { name: file })
      const outPath = join(WORK, file)
      writeFileSync(outPath, buf)

      const myText = buf.toString('utf8')
      const myV3 = /<vsq3[\s>]/.test(myText.slice(0, 1200))
      if (myV3 !== isV3) {
        console.log(`  ✗ 变体不一致：源是 ${isV3 ? 'vsq3' : 'vsq4'}，写出却是 ${myV3 ? 'vsq3' : 'vsq4'}`)
        problems += 1
        continue
      }

      const r = validateWithDotNet(outPath, xsd)
      if (r.ok) {
        console.log(`  写出文件（同变体往返）：XSD 校验通过 ✓`)
      } else {
        console.log(`  ✗ 写出文件 XSD 校验失败（VOCALOID 会拒开），${r.errors.length} 条错误：`)
        for (const e of r.errors.slice(0, 10)) console.log(`      ${e}`)
        problems += 1
      }
    } catch (err) {
      console.log(`  ✗ 处理失败：${err.message}`)
      problems += 1
    }
  }

  console.log(`\n═══ XSD 校验：检查 ${checked} 个样本，${problems} 项问题 ═══`)
  if (problems) process.exitCode = 1
}

main().catch((err) => {
  console.error('XSD 校验脚本异常：', err)
  process.exitCode = 1
})
