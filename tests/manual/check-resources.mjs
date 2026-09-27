// 一次性脚本：验证资源库里每条链接的可达性，并把结果写回 verified 字段
//   node tests/manual/check-resources.mjs          # 只报告
//   node tests/manual/check-resources.mjs --write  # 同时写回 resources.json
//
// 判定规则（见 app/data/RESOURCES-README.md）：
//   2xx        → ok
//   3xx        → ok（跟随后仍是 2xx）
//   401/403    → warn（反爬拦截，站点本身是活的）
//   404/410    → dead
//   其它/超时   → warn

import { readFileSync, writeFileSync } from 'node:fs'

const FILE = 'app/data/resources.json'
const WRITE = process.argv.includes('--write')
const TIMEOUT = 20000

const data = JSON.parse(readFileSync(FILE, 'utf8'))

/**
 * 探一次。超时和连接错误会重试 —— 境内访问境外站点抖动很常见，
 * 不重试的话会把「偶尔慢」误报成「站点有问题」（实测 COEIROINK 就出现过
 * 一次超时一次 200）。
 */
async function probe(url, attempt = 1) {
  try {
    const ctl = new AbortController()
    const t = setTimeout(() => ctl.abort(), TIMEOUT)
    // 用 GET 但只读头部就断开 —— 有些站对 HEAD 直接 405
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: {
        // UA 要写完整：有些站（实测 Dreamtonics）会拦半截的 UA，返回 403
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    })
    clearTimeout(t)
    try { await res.body?.cancel() } catch { /* 无所谓 */ }
    return res.status
  } catch (e) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 1200 * attempt))
      return probe(url, attempt + 1)
    }
    return e.name === 'AbortError' ? 'timeout' : `err:${e.cause?.code ?? e.message}`
  }
}

function verdictOf(status) {
  if (typeof status !== 'number') return 'warn'
  if (status >= 200 && status < 400) return 'ok'
  if (status === 401 || status === 403 || status === 405 || status === 429) return 'warn'
  if (status === 404 || status === 410) return 'dead'
  return 'warn'
}

const today = new Date().toISOString().slice(0, 10)
let ok = 0, warn = 0, dead = 0
const deadList = []

for (const g of data.groups) {
  console.log(`\n── ${g.id}  ${g.name}`)
  for (const it of g.items) {
    // skipProbe：已知挂掉的站（用户明确说不用测），别浪费一次 20 秒超时，
    // 也别把它的旧结论覆盖掉
    if (it.skipProbe) {
      console.log(`  –  跳过（skipProbe）  ${it.name}`)
      const v = it.verified?.verdict ?? 'warn'
      if (v === 'ok') ok++
      else if (v === 'dead') { dead++; deadList.push(`${it.name}  ${it.url}  → 跳过`) }
      else warn++
      continue
    }
    const status = await probe(it.url)
    const verdict = verdictOf(status)
    it.verified = { status: typeof status === 'number' ? status : 0, checkedAt: today, verdict }
    if (verdict === 'ok') ok++
    else if (verdict === 'dead') { dead++; deadList.push(`${it.name}  ${it.url}  → ${status}`) }
    else warn++
    const mark = verdict === 'ok' ? '  ' : verdict === 'dead' ? '✗ ' : '? '
    console.log(`  ${mark}${String(status).padEnd(10)} ${it.name}`)
  }
}

const total = ok + warn + dead
data.verifiedSummaryPending = undefined
delete data.verifiedSummaryPending
data.verifySummary = {
  checkedAt: today,
  total,
  ok,
  warn,
  dead,
  passRate: total ? Math.round((ok / total) * 100) : 0,
}
data.updatedAt = today

console.log(`\n合计 ${total} 条：ok ${ok} / warn ${warn} / dead ${dead}`)
if (deadList.length) console.log('失效：\n  ' + deadList.join('\n  '))

if (WRITE) {
  writeFileSync(FILE, JSON.stringify(data, null, 2) + '\n', 'utf8')
  console.log(`\n已写回 ${FILE}`)
}
