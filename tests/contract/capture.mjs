/**
 * 抓取 Node 后端的真实响应，作为 Rust 重写的对照夹具
 *
 *   node tests/contract/capture.mjs [port]
 *
 * 为什么这么做：
 *   重写后端最大的风险是「接口形状悄悄变了」——前端读某个字段读不到，
 *   界面上就某一块空白，而且很难定位。所以先把每个路由的真实响应存下来，
 *   Rust 版写完后再抓一次，逐字段 diff。这是唯一能证明「重写没丢功能」的办法。
 *
 * 只抓 GET（无副作用）。POST 路由需要构造请求体，单独处理。
 */

import { writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUT = join(__dirname, 'fixtures')

const PORT = Number(process.argv[2] ?? 0) || await detectPort()
const BASE = `http://127.0.0.1:${PORT}`

/** 自动找工作站后端（它会挑空闲端口，所以不能假定 8787） */
async function detectPort() {
  for (const p of [8787, 8788, 8789]) {
    try {
      const r = await fetch(`http://127.0.0.1:${p}/api/health`, { signal: AbortSignal.timeout(1500) })
      if (r.ok) return p
    } catch { /* 试下一个 */ }
  }
  throw new Error('找不到正在运行的工作站后端（试过 8787-8789）。先启动工作站，或用 node capture.mjs <port> 指定端口。')
}

/** GET 路由清单（无副作用，可直接抓） */
const GET_ROUTES = [
  ['health', '/api/health'],
  ['config', '/api/config'],
  ['state', '/api/state'],
  ['resources', '/api/resources'],
  ['fs-roots', '/api/fs/roots'],
  ['jobs', '/api/jobs'],
  ['tools-detect', '/api/tools/detect'],
  ['voices', '/api/voices'],
]

/** 带查询参数的路由 */
const QUERY_ROUTES = [
  ['fs-list-c', '/api/fs/list?path=' + encodeURIComponent('C:\\\\')],
  ['fs-list-tools', '/api/fs/list?path=' + encodeURIComponent(process.cwd())],
]

/** 归一化：把随环境变化的字段替换成占位符，否则两次抓取永远不可能一致 */
function normalize(value, keyPath = '') {
  if (Array.isArray(value)) return value.map((v, i) => normalize(v, `${keyPath}[${i}]`))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = normalize(v, keyPath ? `${keyPath}.${k}` : k)
    return out
  }
  if (typeof value === 'string') {
    // 绝对路径、端口、PID、时间戳都随运行环境变
    if (/^[A-Za-z]:\\/.test(value) || value.startsWith('/')) {
      if (/port|url|address/i.test(keyPath)) return '<URL>'
      return '<PATH>'
    }
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return '<TIME>'
    return value
  }
  if (typeof value === 'number') {
    if (/pid|port|uptime|startedAt|at$|Time$/i.test(keyPath)) return '<NUM>'
    return value
  }
  return value
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  console.log(`抓取目标：${BASE}`)
  console.log(`输出目录：${OUT}\n`)

  const results = {}
  let ok = 0
  let fail = 0

  for (const [name, path] of [...GET_ROUTES, ...QUERY_ROUTES]) {
    try {
      const res = await fetch(BASE + path, { signal: AbortSignal.timeout(30000) })
      const text = await res.text()
      let body
      try {
        body = JSON.parse(text)
      } catch {
        body = { __nonJson: text.slice(0, 2000) }
      }
      const norm = normalize(body)
      writeFileSync(join(OUT, `${name}.json`), JSON.stringify(norm, null, 2), 'utf8')
      const size = JSON.stringify(norm).length
      console.log(`  ✓ ${name.padEnd(16)} HTTP ${res.status}  ${String(size).padStart(7)} 字节`)
      results[name] = { path, status: res.status, bytes: size }
      ok += 1
    } catch (err) {
      console.log(`  ✗ ${name.padEnd(16)} ${err.message}`)
      results[name] = { path, error: err.message }
      fail += 1
    }
  }

  writeFileSync(join(OUT, '_index.json'), JSON.stringify({
    capturedAt: new Date().toISOString(),
    base: BASE,
    note: '这些是 Node 后端的真实响应，用作 Rust 重写的对照基准。归一化规则见 capture.mjs 的 normalize()。',
    routes: results,
  }, null, 2), 'utf8')

  console.log(`\n抓取完成：成功 ${ok} / 失败 ${fail}`)
  console.log(`夹具在 ${OUT}`)
  if (fail) process.exitCode = 1
}

main().catch((err) => {
  console.error('抓取失败：', err.message)
  process.exitCode = 1
})
