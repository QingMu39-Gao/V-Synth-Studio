/**
 * 格式模块自测框架
 *
 * 用法：
 *   node app/server/core/selftest.mjs             # 跑所有已实现格式
 *   node app/server/core/selftest.mjs vsqx        # 只跑指定格式
 *   node app/server/core/selftest.mjs --list      # 列出格式可用状态
 *
 * 对每个格式都会执行「规范工程往返测试」：write -> read -> 逐项比对。
 * 若存在 __tests__/<id>.test.mjs，还会执行该模块自己的专项测试。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import { createProject, validateProject, noteCount, curveValueAt } from './ir.mjs'
import { FORMAT_DEFS, loadFormat } from './formats/index.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SAMPLES_DIR = join(__dirname, '..', '..', '..', 'tests', 'samples')

/* ------------------------------------------------------- 规范测试工程 */

export function canonicalProject() {
  return createProject({
    name: '自测工程 Selftest',
    comment: '由 selftest.mjs 生成的规范测试工程',
    tempos: [
      { tick: 0, bpm: 120 },
      { tick: 1920, bpm: 140 },
    ],
    timeSignatures: [
      { tick: 0, numerator: 4, denominator: 4 },
      { tick: 3840, numerator: 3, denominator: 4 },
    ],
    tracks: [
      {
        name: '主唱',
        singer: 'TestSinger',
        color: '#66ccff',
        language: 'ja',
        notes: [
          { tick: 0, duration: 480, key: 60, lyric: 'ら' },
          { tick: 480, duration: 480, key: 62, lyric: 'り' },
          { tick: 960, duration: 960, key: 64, lyric: 'る' },
          { tick: 2400, duration: 480, key: 67, lyric: 'れ' },
        ],
        pitch: { ticks: [0, 480, 960, 1920, 2400], values: [60, 62, 64, 65, 67] },
        parameters: {
          dynamics: { ticks: [0, 960, 1920], values: [0.2, 0.5, 0.8] },
          breathiness: { ticks: [0, 1920], values: [0.1, 0.6] },
        },
      },
      {
        name: '和声',
        singer: '',
        notes: [{ tick: 0, duration: 1920, key: 55, lyric: 'あ' }],
      },
    ],
  })
}

/* ------------------------------------------------------------ 比对工具 */

const results = { passed: 0, failed: 0, messages: [] }

function check(label, actual, expected, tol = 1e-6) {
  const ok =
    typeof expected === 'number' && typeof actual === 'number'
      ? Math.abs(actual - expected) <= tol
      : JSON.stringify(actual) === JSON.stringify(expected)
  if (ok) {
    results.passed += 1
  } else {
    results.failed += 1
    results.messages.push(`✗ ${label}\n    期望: ${JSON.stringify(expected)}\n    实际: ${JSON.stringify(actual)}`)
  }
}

/**
 * 通用往返比对。
 * 允许格式做合理裁剪：这里只断言「核心信息」不丢。
 * @param {object} src 原始 IR
 * @param {object} dst 往返后的 IR
 * @param {string[]} skip 跳过的检查项：'pitch' | 'params' | 'trackCount'
 */
export function compareProjects(src, dst, skip = []) {
  check('tempo 数量', dst.tempos.length, src.tempos.length)
  src.tempos.forEach((t, i) => {
    check(`tempo[${i}].tick`, dst.tempos[i]?.tick, t.tick)
    check(`tempo[${i}].bpm`, dst.tempos[i]?.bpm, t.bpm, 0.02)
  })
  check('拍号数量', dst.timeSignatures.length, src.timeSignatures.length)
  src.timeSignatures.forEach((t, i) => {
    check(`timeSignature[${i}].tick`, dst.timeSignatures[i]?.tick, t.tick)
    check(`timeSignature[${i}].numerator`, dst.timeSignatures[i]?.numerator, t.numerator)
    check(`timeSignature[${i}].denominator`, dst.timeSignatures[i]?.denominator, t.denominator)
  })

  if (!skip.includes('trackCount')) check('轨道数', dst.tracks.length, src.tracks.length)

  const n = Math.min(src.tracks.length, dst.tracks.length)
  for (let ti = 0; ti < n; ti += 1) {
    const a = src.tracks[ti]
    const b = dst.tracks[ti]
    check(`轨 ${ti} 音符数`, b.notes.length, a.notes.length)
    const count = Math.min(a.notes.length, b.notes.length)
    for (let ni = 0; ni < count; ni += 1) {
      check(`轨 ${ti} 音符 ${ni} tick`, b.notes[ni].tick, a.notes[ni].tick)
      check(`轨 ${ti} 音符 ${ni} duration`, b.notes[ni].duration, a.notes[ni].duration)
      check(`轨 ${ti} 音符 ${ni} key`, b.notes[ni].key, a.notes[ni].key)
      check(`轨 ${ti} 音符 ${ni} lyric`, b.notes[ni].lyric, a.notes[ni].lyric)
    }
    if (!skip.includes('pitch') && a.pitch?.ticks?.length) {
      // 只比对首尾与中点，避免不同格式采样粒度差异导致误报
      const probes = [a.pitch.ticks[0], a.pitch.ticks[a.pitch.ticks.length - 1]]
      for (const t of probes) {
        const expected = curveValueAt(a.pitch, t)
        const actual = curveValueAt(b.pitch, t)
        if (actual === null) {
          results.failed += 1
          results.messages.push(`✗ 轨 ${ti} 音高曲线在 tick ${t} 处丢失`)
        } else {
          check(`轨 ${ti} 音高曲线@${t}`, actual, expected, 0.35)
        }
      }
    }
  }
}

function assert(cond, label) {
  if (cond) results.passed += 1
  else {
    results.failed += 1
    results.messages.push(`✗ ${label}`)
  }
}

function sampleFilesFor(def) {
  if (!existsSync(SAMPLES_DIR)) return []
  const all = readdirSync(SAMPLES_DIR)
  const exts = def.exts.filter((e) => e !== '.json')
  // 只把命名规范的样本当样本：避免参考源码、临时模板等文件污染测试
  return all
    .filter((f) => /^(real-)?sample[-_.]/i.test(f))
    .filter((f) => exts.some((e) => f.toLowerCase().endsWith(e)))
    .map((f) => join(SAMPLES_DIR, f))
}

/* --------------------------------------------------------------- 主流程 */

async function testFormat(id) {
  const def = FORMAT_DEFS.find((f) => f.id === id)
  if (!def) {
    console.log(`✗ 未注册的格式：${id}`)
    return false
  }
  results.passed = 0
  results.failed = 0
  results.messages = []

  let fmt
  try {
    fmt = await loadFormat(id)
  } catch (err) {
    console.log(`\n○ ${id} (${def.name}) — 未实现：${err.message}`)
    return null
  }

  console.log(`\n▶ ${id} (${fmt.name})`)

  // 1) 规范工程往返
  let roundTripOk = false
  try {
    const src = canonicalProject()
    const issues = validateProject(src)
    assert(issues.length === 0, `规范工程本身应合法，实际：${issues.join('; ')}`)

    if (fmt.canWrite !== false) {
      const buf = fmt.write(src, { name: src.name })
      assert(Buffer.isBuffer(buf) && buf.length > 0, 'write() 应返回非空 Buffer')

      if (fmt.canRead !== false) {
        const back = fmt.read(buf, { name: src.name })
        const problems = validateProject(back)
        assert(problems.length === 0, `回读工程应合法，实际：${problems.join('; ')}`)
        compareProjects(src, back, fmt.__skipChecks ?? [])
        roundTripOk = true
      }
    } else {
      console.log('  （该格式只读，跳过写出往返）')
    }
  } catch (err) {
    results.failed += 1
    results.messages.push(`✗ 规范工程往返抛出异常：${err.message}\n${String(err.stack).split('\n').slice(1, 4).join('\n')}`)
  }

  // 2) 真实样本读取
  const samples = sampleFilesFor(fmt)
  if (samples.length && fmt.canRead !== false) {
    for (const file of samples) {
      try {
        const buf = readFileSync(file)
        const proj = fmt.read(buf, { name: file })
        const notes = noteCount(proj)
        assert(notes > 0 || proj.tracks.length > 0, `样本 ${file} 解析后应至少有一个音符或轨道`)
        const issues = validateProject(proj)
        assert(issues.length === 0, `样本 ${file} 解析结果应合法，实际：${issues.join('; ')}`)
        console.log(`  · 样本 ${file.split('\\').pop()}：${proj.tracks.length} 轨 / ${notes} 音符 / ${proj.tempos.length} 个速度点`)
      } catch (err) {
        results.failed += 1
        results.messages.push(`✗ 读取样本 ${file} 失败：${err.message}`)
      }
    }
  }

  // 3) 模块专项测试
  const testPath = join(__dirname, 'formats', '__tests__', `${id}.test.mjs`)
  if (existsSync(testPath)) {
    try {
      const mod = await import(pathToFileUrl(testPath))
      const runner = mod.default ?? mod.run
      if (typeof runner === 'function') {
        const r = await runner({ check, assert, compareProjects, canonicalProject, results })
        if (r && typeof r === 'object') {
          if (Array.isArray(r.notes)) r.notes.forEach((x) => console.log(`  · ${x}`))
        }
      }
    } catch (err) {
      results.failed += 1
      results.messages.push(`✗ 专项测试失败：${err.message}\n${String(err.stack).split('\n').slice(1, 4).join('\n')}`)
    }
  }

  for (const m of results.messages) console.log('  ' + m)
  const status = results.failed === 0 ? '✓ 通过' : '✗ 失败'
  console.log(`  ${status}：${results.passed} 项断言，${results.failed} 项失败${roundTripOk ? '' : '（往返未完成）'}`)
  return results.failed === 0
}

function pathToFileUrl(p) {
  return new URL('file:///' + p.replace(/\\/g, '/').replace(/^\//, ''))
}

async function main() {
  const args = process.argv.slice(2)
  if (args.includes('--list')) {
    for (const def of FORMAT_DEFS) {
      try {
        await loadFormat(def.id)
        console.log(`✓ ${def.id.padEnd(9)} ${def.name}`)
      } catch {
        console.log(`○ ${def.id.padEnd(9)} ${def.name}  (未实现)`)
      }
    }
    return
  }

  const target = args.find((a) => !a.startsWith('-'))
  const ids = target ? [target] : FORMAT_DEFS.map((f) => f.id)

  let pass = 0
  let fail = 0
  let missing = 0
  for (const id of ids) {
    const r = await testFormat(id)
    if (r === null) missing += 1
    else if (r) pass += 1
    else fail += 1
  }
  console.log(`\n═══ 汇总：通过 ${pass} / 失败 ${fail} / 未实现 ${missing} ═══`)
  if (fail > 0) process.exitCode = 1
}

/*
 * 只有直接运行本文件时才跑自测。
 * 原来是无条件 main() —— 结果任何 import 它的模块（比如 template.test.mjs 只是
 * 想复用 canonicalProject）都会连带把整套自测跑一遍，输出混在一起、难以判断谁成功谁失败。
 */
const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))

if (isMain) {
  main().catch((err) => {
    console.error('自测框架异常：', err)
    process.exitCode = 1
  })
}
