/**
 * 下载器自测：用本地 HTTP 服务器验证分块下载的正确性
 *
 *   node app/server/net/download.test.mjs
 *
 * 为什么必须这么测：分块下载写错偏移不会报错，只会静默产生一个「大小对但内容错」的文件。
 * 所以这里生成确定性字节流，下载后逐字节核对 SHA256。
 */

import { createServer } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { readFile, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { downloadToFile, probe, formatSpeed, formatDuration } from './download.mjs'

const SIZE = 9 * 1024 * 1024 + 12345 // 故意用非整齐大小，暴露边界错误
const CONTENT = randomBytes(SIZE)
const CONTENT_SHA = createHash('sha256').update(CONTENT).digest('hex')

let passed = 0
const failures = []

function ok(label, cond, detail = '') {
  if (cond) passed += 1
  else failures.push(`✗ ${label} ${detail}`)
}

function eq(label, actual, expected) {
  if (actual === expected) passed += 1
  else failures.push(`✗ ${label}\n    期望 ${expected}\n    实际 ${actual}`)
}

/** 支持 Range 的测试服务器；supportsRange=false 时用来验证降级路径 */
function startServer({ supportsRange = true } = {}) {
  const server = createServer((req, res) => {
    const range = req.headers.range
    if (supportsRange && range) {
      const m = /bytes=(\d+)-(\d*)/.exec(range)
      if (m) {
        const start = Number(m[1])
        const end = m[2] ? Number(m[2]) : SIZE - 1
        const chunk = CONTENT.subarray(start, end + 1)
        res.writeHead(206, {
          'Content-Type': 'application/octet-stream',
          'Content-Length': chunk.length,
          'Content-Range': `bytes ${start}-${end}/${SIZE}`,
          'Accept-Ranges': 'bytes',
        })
        res.end(chunk)
        return
      }
    }
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': SIZE,
      ...(supportsRange ? { 'Accept-Ranges': 'bytes' } : {}),
    })
    // 分几次写，模拟真实网络
    let offset = 0
    const step = 256 * 1024
    const pump = () => {
      if (offset >= SIZE) {
        res.end()
        return
      }
      res.write(CONTENT.subarray(offset, Math.min(offset + step, SIZE)))
      offset += step
      setImmediate(pump)
    }
    pump()
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

async function downloadAndVerify(baseUrl, { threads, label }) {
  const dest = join(tmpdir(), `dsh-dltest-${threads}-${Date.now()}.bin`)
  await rm(dest, { force: true }).catch(() => {})
  let progressCalls = 0
  const r = await downloadToFile(`${baseUrl}/file`, dest, {
    threads,
    onProgress: () => {
      progressCalls += 1
    },
  })
  const st = await stat(dest)
  const buf = await readFile(dest)
  const sha = createHash('sha256').update(buf).digest('hex')

  eq(`${label}：报告字节数`, r.bytes, SIZE)
  eq(`${label}：磁盘文件大小`, st.size, SIZE)
  eq(`${label}：内容 SHA256 一致`, sha, CONTENT_SHA)
  ok(`${label}：进度回调被触发`, progressCalls > 0, `（${progressCalls} 次）`)
  await rm(dest, { force: true })
  return r
}

async function main() {
  console.log(`\n下载器自测（测试文件 ${(SIZE / 1048576).toFixed(2)} MB）`)

  // 1) 支持 Range：应走多线程分块
  const s1 = await startServer({ supportsRange: true })
  try {
    const info = await probe(`http://127.0.0.1:${s1.port}/file`)
    eq('probe 读取到文件大小', info.size, SIZE)
    ok('probe 正确识别支持分段', info.acceptRanges === true)

    const r4 = await downloadAndVerify(`http://127.0.0.1:${s1.port}`, { threads: 4, label: '4 线程' })
    eq('4 线程确实开了 4 个连接', r4.threads, 4)
    const r2 = await downloadAndVerify(`http://127.0.0.1:${s1.port}`, { threads: 2, label: '2 线程' })
    eq('2 线程确实开了 2 个连接', r2.threads, 2)
    await downloadAndVerify(`http://127.0.0.1:${s1.port}`, { threads: 1, label: '单线程' })
  } finally {
    s1.server.close()
  }

  // 2) 不支持 Range：必须自动降级为单连接，且内容仍要完整
  const s2 = await startServer({ supportsRange: false })
  try {
    const info = await probe(`http://127.0.0.1:${s2.port}/file`)
    ok('probe 正确识别不支持分段', info.acceptRanges === false)
    const r = await downloadAndVerify(`http://127.0.0.1:${s2.port}`, { threads: 4, label: '降级单流' })
    eq('降级后只用了 1 个连接', r.threads, 1)
  } finally {
    s2.server.close()
  }

  // 3) 格式化工具
  eq('formatSpeed', formatSpeed(1536), '1.5 KB/s')
  eq('formatDuration 65s', formatDuration(65), '1分05秒')

  console.log()
  for (const f of failures) console.log('  ' + f)
  console.log(`  ${failures.length ? '✗ 失败' : '✓ 通过'}：${passed} 项断言，${failures.length} 项失败\n`)
  if (failures.length) process.exitCode = 1
}

main().catch((err) => {
  console.error('自测异常：', err)
  process.exitCode = 1
})
