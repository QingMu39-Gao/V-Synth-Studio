/**
 * B 站解析联调脚本（人工诊断用）
 *
 *   node tests/manual/bili-test.mjs [链接或BV号]
 *
 * 不带参数时使用内置测试视频，只解析不下载。
 */

import { BilibiliClient } from '../../app/server/net/bilibili.mjs'

const input = process.argv[2] ?? 'BV1GJ411x7h7'

async function main() {
  const client = new BilibiliClient()
  console.log(`▶ 解析输入：${input}`)

  const parsed = await client.parseInput(input)
  console.log('  解析结果：', parsed)
  if (parsed.kind === 'unknown') throw new Error('无法识别输入')

  if (parsed.kind === 'bangumi') {
    const info = await client.getBangumiInfo(parsed)
    console.log(`\n▶ 番剧：${info.title}`)
    console.log(`  集数：${info.episodes.length}  当前 ep：${info.epId}  cid：${info.cid}`)
    if (!info.cid) throw new Error('未取得 cid')
    const streams = await client.getPlayStreams({ cid: info.cid, bangumiEpId: info.epId, qn: 127 })
    reportStreams(streams)
    return
  }

  const info = await client.getVideoInfo(parsed)
  console.log(`\n▶ 视频：${info.title}`)
  console.log(`  UP：${info.uploader}  时长：${info.durationSec}s  发布：${info.publishDate}`)
  console.log(`  分P：${info.pages.length} 个`)
  for (const p of info.pages.slice(0, 5)) {
    console.log(`    P${p.page} cid=${p.cid} ${p.durationSec}s ${p.title}`)
  }
  if (info.season) {
    console.log(`  合集：${info.season.title}（${info.season.episodes.length} 个视频）`)
  }

  const page = info.pages.find((p) => p.page === (parsed.page ?? 1)) ?? info.pages[0]
  if (!page) throw new Error('该视频没有可播放分P')

  console.log(`\n▶ 请求播放流（cid=${page.cid}）`)
  const streams = await client.getPlayStreams({ bvid: info.bvid, cid: page.cid, qn: 127 })
  reportStreams(streams)

  console.log('\n▶ 官方字幕')
  try {
    const subs = await client.getSubtitles({ bvid: info.bvid, cid: page.cid })
    if (!subs.length) console.log('  （该视频没有官方字幕）')
    for (const s of subs) console.log(`  ${s.lanDoc}${s.isAi ? '（AI 生成）' : ''} → ${s.url}`)
  } catch (err) {
    console.log('  字幕获取失败：', err.message)
  }

  console.log('\n▶ 弹幕')
  try {
    const xml = await client.getDanmakuXml(page.cid)
    const count = (xml.match(/<d p=/g) ?? []).length
    console.log(`  弹幕条数：${count}（XML 长度 ${xml.length}）`)
  } catch (err) {
    console.log('  弹幕获取失败：', err.message)
  }
}

function reportStreams(streams) {
  if (streams.mode === 'durl') {
    console.log(`  整段流模式，共 ${streams.streams.length} 段`)
    return
  }
  console.log(`  可选画质：${streams.acceptDescription?.join(' / ') || '-'}`)
  console.log(`  视频流 ${streams.video.length} 条：`)
  for (const v of streams.video.slice(0, 8)) {
    console.log(`    [${v.id}] ${v.qualityName} ${v.width}x${v.height} ${v.codecs} ${(v.bandwidth / 1000).toFixed(0)}kbps`)
  }
  console.log(`  音频流 ${streams.audio.length} 条：`)
  for (const a of streams.audio) {
    console.log(`    [${a.id}] ${a.qualityName} ${a.codecs} ${(a.bandwidth / 1000).toFixed(0)}kbps`)
  }
}

main().catch((err) => {
  console.error('\n✗ 失败：', err.message)
  process.exitCode = 1
})
