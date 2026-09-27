// 一次性脚本：把资源库现状打印出来（调查用，不属于产品代码）
//   node tests/manual/dump-resources.mjs
import { readFileSync } from 'node:fs'

const d = JSON.parse(readFileSync('app/data/resources.json', 'utf8'))
console.log(`version=${d.version}  updatedAt=${d.updatedAt}`)
let total = 0
for (const g of d.groups) {
  console.log(`── ${g.id}  「${g.name}」  ${g.items.length} 条`)
  if (g.desc) console.log(`     说明：${g.desc}`)
  for (const it of g.items) {
    const flags = [it.official ? 'official' : '', it.wav ? 'wav' : '', it.verified ? `verified:${it.verified}` : '']
      .filter(Boolean).join(' ')
    console.log(`     ${it.name}  ${it.url}  ${flags}`)
  }
  total += g.items.length
}
console.log(`\n分组 ${d.groups.length} 个，条目 ${total} 条`)
