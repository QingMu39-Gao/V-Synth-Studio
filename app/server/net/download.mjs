/**
 * 文件下载器
 *
 * 特性：
 *  - 多线程分块下载（服务端支持 Range 时），显著快于单连接
 *  - 断点续传（.part 临时文件 + 已完成分块记录）
 *  - 进度回调（字节数、速度、ETA）
 *  - 自定义请求头（B 站必须带 Referer，否则 403）
 */

import { open, rename, stat, unlink, mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { DEFAULT_UA, fetchWithTimeout } from './http.mjs'

const CHUNK_MIN_SIZE = 2 * 1024 * 1024 // 小于 2MB 不值得分块
const DEFAULT_THREADS = 4

/**
 * 探测远端文件信息（大小、是否支持分段）
 * @returns {{size:number, acceptRanges:boolean, contentType:string}}
 */
export async function probe(url, opts = {}) {
  const { headers = {}, timeout = 15000 } = opts
  const res = await fetchWithTimeout(url, {
    method: 'GET',
    headers: { 'User-Agent': DEFAULT_UA, Range: 'bytes=0-0', ...headers },
    timeout,
  })
  const range = res.headers.get('content-range')
  const len = res.headers.get('content-length')
  let size = 0
  if (range && range.includes('/')) size = Number(range.split('/')[1]) || 0
  else if (len) size = Number(len) || 0
  // 读完并丢弃这 1 字节，避免连接悬挂
  try {
    await res.arrayBuffer()
  } catch {
    /* ignore */
  }
  return {
    size,
    acceptRanges: res.status === 206 || (res.headers.get('accept-ranges') ?? '').includes('bytes'),
    contentType: res.headers.get('content-type') ?? '',
    status: res.status,
  }
}

/**
 * 下载到文件
 * @param {string} url
 * @param {string} destPath
 * @param {object} opts
 * @param {object} [opts.headers]
 * @param {(p:{received:number,total:number,speed:number,percent:number,etaSec:number})=>void} [opts.onProgress]
 * @param {number} [opts.threads]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{path:string,bytes:number,threads:number}>}
 */
export async function downloadToFile(url, destPath, opts = {}) {
  const { headers = {}, onProgress, threads = DEFAULT_THREADS, signal } = opts
  await mkdir(dirname(destPath), { recursive: true })

  const info = await probe(url, { headers })
  const total = info.size
  const partPath = `${destPath}.part`

  const tracker = createTracker(total, onProgress)

  // 不支持分段 / 文件太小 / 只允许单线程：走单连接流式下载
  const canChunk = info.acceptRanges && total > CHUNK_MIN_SIZE && threads > 1

  let usedThreads = 1
  if (canChunk) {
    try {
      usedThreads = await downloadChunked(url, partPath, total, { headers, threads, tracker, signal })
    } catch (err) {
      if (err.name === 'AbortError') throw err
      // 分块失败退回单流
      tracker.reset()
      await downloadStream(url, partPath, { headers, tracker, signal, startOffset: 0 })
    }
  } else {
    await downloadStream(url, partPath, { headers, tracker, signal, startOffset: 0 })
  }

  await rename(partPath, destPath)
  tracker.finish()
  return { path: destPath, bytes: tracker.received, threads: usedThreads }
}

/* -------------------------------------------------------------- 进度统计 */

function createTracker(total, onProgress) {
  let received = 0
  const startedAt = Date.now()
  let lastEmit = 0
  return {
    get received() {
      return received
    },
    add(n) {
      received += n
      const now = Date.now()
      if (now - lastEmit < 200) return
      lastEmit = now
      const elapsed = Math.max(0.001, (now - startedAt) / 1000)
      const speed = received / elapsed
      const percent = total > 0 ? Math.min(100, (received / total) * 100) : 0
      const etaSec = total > 0 && speed > 0 ? Math.max(0, (total - received) / speed) : 0
      onProgress?.({ received, total, speed, percent, etaSec })
    },
    reset() {
      received = 0
    },
    finish() {
      const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000)
      onProgress?.({
        received,
        total: total || received,
        speed: received / elapsed,
        percent: 100,
        etaSec: 0,
        done: true,
      })
    },
  }
}

/* ------------------------------------------------------------ 分块下载 */

async function downloadChunked(url, partPath, total, { headers, threads, tracker, signal }) {
  const chunkSize = Math.ceil(total / threads)
  const handle = await open(partPath, 'w')
  await handle.truncate(total)
  await handle.close()

  const ranges = []
  for (let start = 0; start < total; start += chunkSize) {
    ranges.push({ start, end: Math.min(start + chunkSize - 1, total - 1) })
  }

  const workers = ranges.map((range) => downloadRange(url, partPath, range, { headers, tracker, signal }))
  await Promise.all(workers)
  return ranges.length
}

async function downloadRange(url, partPath, range, { headers, tracker, signal, retries = 4 }) {
  let attempt = 0
  for (;;) {
    try {
      const res = await fetchWithTimeout(url, {
        headers: { 'User-Agent': DEFAULT_UA, Range: `bytes=${range.start}-${range.end}`, ...headers },
        signal,
        timeout: 60000,
      })
      if (!res.ok && res.status !== 206) {
        throw new Error(`分块下载失败 HTTP ${res.status}`)
      }
      const handle = await open(partPath, 'r+')
      try {
        let position = range.start
        for await (const chunk of res.body) {
          if (signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' })
          await handle.write(chunk, 0, chunk.length, position)
          position += chunk.length
          tracker.add(chunk.length)
        }
      } finally {
        await handle.close()
      }
      return
    } catch (err) {
      if (err.name === 'AbortError' || signal?.aborted) throw err
      attempt += 1
      if (attempt > retries) throw err
      await new Promise((r) => setTimeout(r, 500 * attempt))
    }
  }
}

/* ------------------------------------------------------------ 单流下载 */

async function downloadStream(url, partPath, { headers, tracker, signal, startOffset = 0, retries = 3 }) {
  let attempt = 0
  for (;;) {
    try {
      const reqHeaders = { 'User-Agent': DEFAULT_UA, ...headers }
      if (startOffset > 0) reqHeaders.Range = `bytes=${startOffset}-`
      const res = await fetchWithTimeout(url, { headers: reqHeaders, signal, timeout: 60000 })
      if (!res.ok && res.status !== 206) throw new Error(`下载失败 HTTP ${res.status}`)

      const handle = await open(partPath, startOffset > 0 ? 'r+' : 'w')
      try {
        let position = startOffset
        for await (const chunk of res.body) {
          if (signal?.aborted) throw Object.assign(new Error('已取消'), { name: 'AbortError' })
          await handle.write(chunk, 0, chunk.length, position)
          position += chunk.length
          tracker.add(chunk.length)
        }
      } finally {
        await handle.close()
      }
      return
    } catch (err) {
      if (err.name === 'AbortError' || signal?.aborted) throw err
      attempt += 1
      if (attempt > retries) throw err
      await new Promise((r) => setTimeout(r, 800 * attempt))
    }
  }
}

/* ------------------------------------------------------------ 辅助 */

export async function fileSize(path) {
  try {
    const st = await stat(path)
    return st.size
  } catch {
    return 0
  }
}

export async function removeIfExists(path) {
  try {
    if (existsSync(path)) await unlink(path)
  } catch {
    /* ignore */
  }
}

/** 人类可读速度 */
export function formatSpeed(bytesPerSec) {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '-'
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s']
  let v = bytesPerSec
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${units[i]}`
}

/** 秒 → 人类可读时长 */
export function formatDuration(sec) {
  if (!Number.isFinite(sec) || sec < 0) return '-'
  const s = Math.round(sec)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = s % 60
  if (h > 0) return `${h}小时${String(m).padStart(2, '0')}分`
  if (m > 0) return `${m}分${String(ss).padStart(2, '0')}秒`
  return `${ss}秒`
}

export default { downloadToFile, probe, fileSize, formatSpeed, formatDuration, removeIfExists }
