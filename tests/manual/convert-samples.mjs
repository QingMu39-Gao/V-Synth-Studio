/**
 * 工程转换的样本冒烟 —— 把一批真 .svp 逐个走后端转成 vsqx，打印成功/失败与失败原因。
 *
 * 用法：
 *   node tests/manual/convert-samples.mjs [端口] [--dir <样本目录>] [--only <文件名>] [--options <JSON>]
 *
 * 为什么要它：转换的真实失败率与失败原因（上游 bug / 音符重叠 / 提问没答上）
 * 只能靠真工程量出来。2026-10-02 的基线是 **成功 10 / 16**，其中 5 个撞上游
 * `AttributeError: vsqx_name`。细节与待办见 docs/CONVERT-HANDOFF.md。
 *
 * ⚠️ 样本目录**不在 git 里**（默认指向本机的素材目录），别的机器上要 --dir 指定。
 */
import { existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const port = Number(argv[0]) || 8891
const flag = (name, dflt = null) => {
  const i = argv.indexOf(`--${name}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt
}
const PORT = port
const BASE = `http://127.0.0.1:${PORT}`
const DIR = flag('dir', 'C:\\Users\\Administrator\\Desktop\\素材\\sv')
const ONLY = flag('only')
const OPTIONS = flag('options')
const OUT = join(process.env.TEMP ?? 'C:\\Windows\\Temp', 'vss-convert-samples')

if (!existsSync(DIR)) {
  console.log(`样本目录不存在：${DIR}\n（用 --dir 指定，或跳过这条测试）`)
  process.exit(0)
}
rmSync(OUT, { recursive: true, force: true })
mkdirSync(OUT, { recursive: true })

const options = OPTIONS ? JSON.parse(OPTIONS) : {}
const wait = (ms) => new Promise((r) => setTimeout(r, ms))

let files = readdirSync(DIR).filter((f) => /\.svp$/i.test(f)).sort()
if (ONLY) files = files.filter((f) => f.includes(ONLY))
if (!files.length) {
  console.log('没有匹配的 .svp')
  process.exit(0)
}
console.log(`样本 ${files.length} 个 · 来源 ${DIR} · 输出 ${OUT}\n`)

/** 从任务日志里认出失败原因（顺序有讲究：先认最具体的） */
function reasonOf(job) {
  const last = String(job.logs?.slice(-1)[0] ?? '')
  if (/vsqx_name/.test(last)) return 'AttributeError: vsqx_name（上游 vsqx 导出器 bug，见 CONVERT-HANDOFF §2.1）'
  if (/FileNotFoundError/.test(last)) return 'FileNotFoundError（输出目录 / 写入失败）'
  if (/Aborted/.test(last)) return 'Aborted（交互提问没答上）'
  if (/重叠|overlap/i.test(last)) return '源工程音符重叠，LibreSVIP 拒绝转换'
  if (/无效的音频文件/.test(last)) return '引用的音频文件无效（注意：这条通常是 stderr 噪音，别当唯一原因）'
  return last.replace(/\s+/g, ' ').slice(-140)
}

const rows = []
for (const f of files) {
  const submitted = await fetch(`${BASE}/api/convert/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      inputs: [join(DIR, f)], toFormat: 'vsqx', outDir: OUT,
      nameTemplate: '{name}', overwrite: true, options,
    }),
  })
    .then((r) => r.json().catch(() => null))
    .catch(() => null)

  if (!submitted?.jobId) {
    rows.push([f, '提交失败', `HTTP ${submitted === null ? '无响应' : '非 JSON'}（实例起了吗？端口 ${PORT}）`])
    continue
  }

  const t0 = Date.now()
  let job = null
  for (let i = 0; i < 400; i++) {
    await wait(400)
    job = await fetch(`${BASE}/api/jobs/get?id=${submitted.jobId}`).then((r) => r.json()).then((j) => j.job).catch(() => null)
    if (job && ['done', 'error', 'canceled'].includes(job.status)) break
  }
  const secs = Math.round((Date.now() - t0) / 1000)
  const ok = /成功 1/.test(job?.message ?? '')
  rows.push([f, ok ? `✅ ${secs}s` : '❌', ok ? '' : reasonOf(job ?? {})])
}

const pad = (s, n) => {
  // 中文按两个宽度算，列才对得齐
  const w = [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 0x2e80 ? 2 : 1), 0)
  return String(s) + ' '.repeat(Math.max(0, n - w))
}
console.log(pad('工程', 42) + pad('结果', 10) + '原因')
for (const [f, r, w] of rows) console.log(pad(f, 42) + pad(r, 10) + w)

const okCount = rows.filter((r) => r[1].startsWith('✅')).length
console.log(`\n合计：成功 ${okCount} / ${rows.length}`)
const reasons = {}
for (const [, r, w] of rows) if (!r.startsWith('✅')) reasons[w || '（空）'] = (reasons[w || '（空）'] ?? 0) + 1
if (Object.keys(reasons).length) console.log('失败原因分布：', JSON.stringify(reasons, null, 0))
console.log(`产物在 ${OUT}（可删）`)
