#!/usr/bin/env node
/**
 * 把**本机这一份** `tools/` 的内容摘要打出来，贴进 `assets.mjs::TOOL_DIGESTS`。
 *
 *     node tools/pin_tool_digests.mjs
 *
 * ⚠️ 钉的是「这台机器上现在这一份」，所以**只在来源可信时才跑**：走上游直取
 * （`node tools/fetch_tools.mjs --force`）、或已知无误的自建归档。来源不明的一份钉下去，
 * 等于把一个可疑的基线写进仓库，此后所有机器都拿它当标准。
 *
 * 没钉的件（见 `fetch_tools.mjs::PIN_EXEMPT`）也会列出来，并说明为什么不钉。
 */

import process from 'node:process'

import * as assets from './assets.mjs'
import {HERE, isMain, say} from './lib.mjs'
import {PARTS, PARTS_THIS_PLATFORM, PIN_EXEMPT, partPresent, toolDigest} from './fetch_tools.mjs'

export function pinRow(root = HERE) {
  const key = `${assets.PLATFORM}-${process.arch}`
  const rows = {}
  const missing = []
  for (const name of PARTS_THIS_PLATFORM) {
    if (PIN_EXEMPT[name]) continue
    if (!partPresent(root, name)) {
      missing.push(name)
      continue
    }
    rows[name] = toolDigest(root, name)
  }
  return {key, rows, missing}
}

function main() {
  const {key, rows, missing} = pinRow()
  say(`把下面这段贴进 tools/assets.mjs 的 TOOL_DIGESTS（键 ${key}）：`)
  say('')
  say(`  '${key}': {`)
  for (const [name, digest] of Object.entries(rows)) say(`    ${name}: '${digest}',`)
  say('  },')
  if (missing.length) {
    say('')
    say(`⚠️ 本机还没补上：${missing.map((n) => `${n}（${PARTS[n].what}）`).join('、')}`)
    say('  先 `node tools/fetch_tools.mjs` 补齐，再跑一次。')
  }
  say('')
  say('⚠️ 不钉的件：')
  for (const [name, why] of Object.entries(PIN_EXEMPT)) say(`  · ${name}：${why}`)
  return missing.length ? 1 : 0
}

if (isMain(import.meta.url)) process.exit(main())
