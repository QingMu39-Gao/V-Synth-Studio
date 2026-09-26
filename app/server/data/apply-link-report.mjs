/**
 * 把链接校验报告回填进 resources.json
 *
 * 用法：node app/server/data/apply-link-report.mjs [_report-final.json 路径]
 *
 * 为什么需要它：界面按 item.verified.status 显示「已校验/异常」徽章。
 * 校验结果若只留在独立报告里，用户就看不到任何可信度提示。
 */

import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RES_PATH = join(__dirname, 'resources.json')
const reportPath = process.argv[2] ?? join(__dirname, '_report-final.json')

if (!existsSync(RES_PATH)) {
  console.error('找不到 resources.json')
  process.exitCode = 1
  process.exit()
}
if (!existsSync(reportPath)) {
  console.error(`找不到校验报告：${reportPath}`)
  process.exitCode = 1
  process.exit()
}

const res = JSON.parse(readFileSync(RES_PATH, 'utf8'))
const report = JSON.parse(readFileSync(reportPath, 'utf8'))

// 报告里 id 形如 "stem-separation/mvsep"；也允许按 url 兜底匹配
const byId = new Map()
const byUrl = new Map()
for (const t of report.targets ?? []) {
  if (t.id) byId.set(t.id, t)
  if (t.url) byUrl.set(t.url.replace(/\/$/, ''), t)
}

const checkedAt = (report.checkedAt ?? new Date().toISOString()).slice(0, 10)
let filled = 0
let missing = 0
const dead = []
const warn = []

/**
 * 状态码分类。
 * 注意：403 / 405 / 429 是反爬与限流，**不代表链接失效**——
 * Musopen、Pixabay、Dreamontics 官网这类正常站点都会对脚本请求返回 403。
 * 把它们当成死链会误导用户，也会白白丢掉好资源。
 */
function classify(status, verdict) {
  const s = Number(status) || 0
  if (s === 0) return 'dead'
  if (s === 403 || s === 405 || s === 429 || s === 401) return 'warn'
  if (s >= 400) return 'dead'
  if (verdict === 'dead') return 'dead'
  if (verdict === 'warn') return 'warn'
  return 'ok'
}

for (const group of res.groups ?? []) {
  for (const item of group.items ?? []) {
    const hit = byId.get(`${group.id}/${item.id}`) ?? byUrl.get(String(item.url ?? '').replace(/\/$/, ''))
    if (!hit) {
      missing += 1
      continue
    }
    const kind = classify(hit.status, hit.verdict)
    const note = hit.note || (kind === 'warn' ? '需浏览器访问（有反爬，属正常）' : hit.error ?? '')
    item.verified = {
      status: hit.status ?? 0,
      checkedAt,
      verdict: kind,
      ...(note ? { note } : {}),
    }
    filled += 1
    if (kind === 'dead') dead.push(`${group.id}/${item.id} ${item.name} → ${hit.status || hit.error || '无响应'}`)
    else if (kind === 'warn') warn.push(`${group.id}/${item.id} ${item.name} → ${hit.status}`)
  }
}

res.updatedAt = checkedAt
res.verifySummary = {
  checkedAt,
  total: filled,
  ok: filled - dead.length - warn.length,
  warn: warn.length,
  dead: dead.length,
  passRate: filled ? Math.round(((filled - dead.length) / filled) * 100) : 0,
}

writeFileSync(RES_PATH, JSON.stringify(res, null, 2), 'utf8')

console.log(`已回填 ${filled} 条校验结果到 resources.json（未匹配 ${missing} 条）`)
console.log(`  正常 ${res.verifySummary.ok} / 需浏览器访问 ${warn.length} / 失效 ${dead.length} / 可用率 ${res.verifySummary.passRate}%`)
for (const d of dead) console.log(`  ✗ 失效：${d}`)
if (warn.length) console.log(`  ⚠ ${warn.length} 条返回 403（反爬，链接本身有效），例如：${warn.slice(0, 3).join('；')}`)
