/**
 * 下载器联调脚本（人工诊断用）
 *
 *   node tests/manual/download-test.mjs              # 用通用测速文件测分块下载
 *   node tests/manual/download-test.mjs <视频链接>    # 走 B 站真实音频流
 *
 * 会把文件下到系统临时目录并打印速度，结束后删除测试文件。
 */

import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { rm, stat } from 'node:fs/promises'
import { downloadToFile } from '../../app/server/net/download.mjs'
import { BilibiliClient } from '../../app/server/net/bilibili.mjs'

const TEST_URL = 'https://speed.cloudflare.com/__down?bytes=25165824' // 24MB
const target = process.argv[2]

function reporter(label) {
  let last = 0
  let maxSpeed = 0
  return {
    onProgress: (p) => {
      maxSpeed = Math.max(maxSpeed, p.speed)
      const now = Date.now()
      if (now - last < 700) return
      last = now
      process.stdout.write(
        `\r  ${label} ${p.percent.toFixed(1)}%  ${(p.received / 1048576).toFixed(1)}/${(p.total / 1048576).toFixed(1)} MB  ${(p.speed / 1048576).toFixed(2)} MB/s  ETA ${p.etaSec ? p.etaSec.toFixed(0) + 's' : '-'}   `
      )
    },
    get maxSpeed() {
      return maxSpeed
    },
  }
}

async function testGeneric() {
  console.log(`▶ 通用分块下载测试：${TEST_URL}`)
  const dest = join(tmpdir(), 'dsh-downloadtest.bin')
  await rm(dest, { force: true }).catch(() => {})
  const rep = reporter('下载中')
  const t0 = Date.now()
  const r = await downloadToFile(TEST_URL, dest, { onProgress: rep.onProgress, threads: 4 })
  const sec = (Date.now() - t0) / 1000
  const st = await stat(dest)
  console.log()
  console.log(`  完成：${r.bytes} 字节（磁盘 ${st.size} 字节），用时 ${sec.toFixed(1)}s，平均 ${(r.bytes / 1048576 / sec).toFixed(2)} MB/s，峰值 ${(rep.maxSpeed / 1048576).toFixed(2)} MB/s`)
  console.log(`  使用连接数：${r.threads}`)
  if (r.bytes !== st.size) throw new Error('写入字节数与报告不一致')
  await rm(dest, { force: true })
  console.log('  ✓ 通过（文件已清理）')
}

async function testBilibili(url) {
  console.log(`▶ B 站真实下载测试：${url}`)
  const client = new BilibiliClient()
  const parsed = await client.parseInput(url)
  const info = await client.getVideoInfo(parsed)
  const page = info.pages.find((p) => p.page === (parsed.page ?? 1)) ?? info.pages[0]
  console.log(`  《${info.title}》 第 ${page.page} P，时长 ${page.durationSec}s`)
  const streams = await client.getPlayStreams({ bvid: info.bvid, cid: page.cid, qn: 127 })
  const audio = (streams.audio ?? []).find((a) => a.id === 30280) ?? (streams.audio ?? [])[0]
  if (!audio) throw new Error('没有可用音频流')
  console.log(`  音频流：${audio.qualityName} ${(audio.bandwidth / 1000).toFixed(0)}kbps`)

  const dest = join(tmpdir(), 'dsh-bili-test.m4a')
  await rm(dest, { force: true }).catch(() => {})
  const rep = reporter('音频中')
  const t0 = Date.now()
  const r = await client.downloadAsset(audio.url, dest, {
    backupUrls: audio.backupUrls,
    threads: 4,
    onProgress: rep.onProgress,
  })
  const sec = (Date.now() - t0) / 1000
  const st = await stat(dest)
  console.log()
  console.log(`  完成：${(r.bytes / 1048576).toFixed(2)} MB，用时 ${sec.toFixed(1)}s，平均 ${(r.bytes / 1048576 / sec).toFixed(2)} MB/s，连接数 ${r.threads}`)
  // 校验确实是 MP4/AAC 容器（f typ 位于偏移 4）
  const { readFile } = await import('node:fs/promises')
  const head = (await readFile(dest)).subarray(0, 12)
  const isMp4 = head.subarray(4, 8).toString('latin1') === 'ftyp'
  console.log(`  文件头：${head.toString('hex')}  容器判定：${isMp4 ? 'MP4/M4A ✓' : '不是 MP4 ✗'}`)
  await rm(dest, { force: true })
  if (!isMp4) throw new Error('下载内容不是预期的 MP4 容器（可能是错误页）')
  console.log('  ✓ 通过（文件已清理）')
}

async function main() {
  if (target) {
    await testBilibili(target)
  } else {
    await testGeneric()
  }
  console.log('\n全部通过。')
}

main().catch((err) => {
  console.log()
  console.error('✗ 失败：', err.message)
  process.exitCode = 1
})
