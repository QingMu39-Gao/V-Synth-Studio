/**
 * 阶段 4 端到端对照：真下载、真转码，把 Node 和 Rust 两个后端的**产物**摆在一起比
 *
 *   node tests/manual/media-e2e.mjs <nodePort> <rustPort>
 *
 * 为什么单独一个脚本：
 *   tests/contract/verify.mjs 只比「请求的响应形状」——它证明接口没变，但证明不了
 *   「文件真的下下来了、转码真的转对了」。下载/转码是异步长任务，产物要等任务跑完才知道，
 *   所以这一层放在这里：两个后端各跑一遍同样的活，比文件名、比字节数、比内容哈希。
 *
 * 需要网络（B 站）和 tools/ 里的 ffmpeg + yt-dlp。
 */

import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync, mkdirSync, rmSync } from 'node:fs'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SAMPLES = join(__dirname, '..', 'samples')
const WORK = join(tmpdir(), 'qingmu-e2e')

/** 固定的测试视频：官方 MV，长期有效，时长 213 秒 */
const TEST_URL = 'https://www.bilibili.com/video/BV1GJ411x7h7'

const NODE_PORT = Number(process.argv[2] ?? 8790)
const RUST_PORT = Number(process.argv[3] ?? 8788)

let pass = 0
let fail = 0

function check(name, a, b) {
  const same = stable(a) === stable(b)
  if (same) {
    console.log(`  ✓ ${name}`)
    pass += 1
  } else {
    console.log(`  ✗ ${name}\n      Node: ${JSON.stringify(a)}\n      Rust: ${JSON.stringify(b)}`)
    fail += 1
  }
}

/**
 * 键排序后再比较。
 *
 * Rust 的 serde_json 用 BTreeMap 存对象，键是按字母序输出的；Node 是按插入序。
 * JSON 对象的键顺序本来就不属于接口契约（前端按键取值），所以比较时要把顺序抹平，
 * 否则每条都会报假差异。
 */
function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
  if (v && typeof v === 'object') {
    return `{${Object.keys(v)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(v[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v)
}

/** 取流地址是签名过的、每次都不一样；播放量每秒钟都在涨。这些不参与比对。 */
function scrub(v, key = '') {
  if (Array.isArray(v)) return v.map((x) => scrub(x, key))
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, x] of Object.entries(v)) out[k] = scrub(x, k)
    return out
  }
  if (typeof v === 'string' && /deadline=|upsig=/.test(v)) return '<URL>'
  if (/^(view|like|coin|favorite|share|reply|danmaku)$/.test(key)) return '<NUM>'
  return v
}

/** 抹掉产物路径里跟后端绑定的那段目录前缀（两个后端的输出目录本来就不同） */
function relativize(v, dir) {
  if (typeof v === 'string') return v.split(dir).join('<OUT>')
  if (Array.isArray(v)) return v.map((x) => relativize(x, dir))
  if (v && typeof v === 'object') {
    const out = {}
    for (const [k, x] of Object.entries(v)) out[k] = relativize(x, dir)
    return out
  }
  return v
}

async function post(port, path, body) {
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(180000),
  })
  return res.json()
}

/** 等任务跑完（下载/转码是异步的） */
async function waitJob(port, jobId, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { job } = await (await fetch(`http://127.0.0.1:${port}/api/jobs/get?id=${jobId}`)).json()
    if (['done', 'error', 'canceled'].includes(job.status)) return job
    if (Date.now() > deadline) throw new Error(`任务 ${jobId} 超时（最后状态 ${job.status}）`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

function listFiles(dir) {
  try {
    return readdirSync(dir)
      .filter((f) => !f.endsWith('.part'))
      .sort()
      .map((f) => ({
        name: f,
        bytes: statSync(join(dir, f)).size,
        sha: createHash('sha256').update(readFileSync(join(dir, f))).digest('hex').slice(0, 16),
      }))
  } catch {
    return []
  }
}

/** 一个后端的全套动作 */
async function run(port, label) {
  const outDir = join(WORK, label)
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })

  const result = {}

  // ── 1. 真下载：仅音频 + 封面 + 弹幕 + 字幕（把小分支都走一遍）
  const dl = await post(port, '/api/video/download', {
    url: TEST_URL,
    source: 'bilibili',
    outDir,
    mode: 'audio',
    audioQuality: 30216,
    downloadCover: true,
    downloadDanmaku: true,
    downloadSubs: true,
  })
  const job = await waitJob(port, dl.jobId)
  result.download = {
    status: job.status,
    error: job.error ?? null,
    files: listFiles(outDir),
    resultKeys: Object.keys(job.result ?? {}).sort(),
    title: job.result?.title ?? null,
    logs: (job.logs ?? []).map((l) => l.replace(/^\[[^\]]+\]\s*/, '')),
  }

  // ── 2. 真转码：样例 wav → mp3（有损，两边参数一样，产物应当一致）
  const conv = await post(port, '/api/audio/run', {
    action: 'convert',
    input: join(SAMPLES, 'tone-1s.wav'),
    output: join(outDir, 'tone.mp3'),
    options: { format: 'mp3' },
  })
  const convJob = await waitJob(port, conv.jobId)
  result.convert = {
    status: convJob.status,
    error: convJob.error ?? null,
    message: convJob.message,
    resultKeys: Object.keys(convJob.result ?? {}).sort(),
    output: convJob.result?.output ? basename(convJob.result.output) : null,
    bytes: statSync(join(outDir, 'tone.mp3')).size,
    sha: createHash('sha256').update(readFileSync(join(outDir, 'tone.mp3'))).digest('hex').slice(0, 16),
    // info 是 ffprobe 读出来的源文件信息，两边必须一模一样
    info: convJob.result?.info ?? null,
  }

  // ── 3. 变调（滤波器字符串拼错就出不来结果）
  const pitch = await post(port, '/api/audio/run', {
    action: 'pitch',
    input: join(SAMPLES, 'tone-1s.wav'),
    output: join(outDir, 'tone-p3.wav'),
    options: { semitones: 3 },
  })
  const pitchJob = await waitJob(port, pitch.jobId)
  result.pitch = {
    status: pitchJob.status,
    error: pitchJob.error ?? null,
    semitones: pitchJob.result?.semitones ?? null,
    ratio: pitchJob.result?.ratio ?? null,
    bytes: statSync(join(outDir, 'tone-p3.wav')).size,
    sha: createHash('sha256').update(readFileSync(join(outDir, 'tone-p3.wav'))).digest('hex').slice(0, 16),
  }

  // ── 3b. 其余音频操作：每个都是一条不同的 ffmpeg 参数/滤镜串，全都真跑一遍
  result.audioOps = {}
  const OPS = [
    ['tempo', { ratio: 1.25 }, 'tone-x125.wav'],
    ['tempo', { ratio: 3 }, 'tone-x3.wav'], // 超过 atempo 的 2.0 上限，必须串联
    ['trim', { startSec: 0.2, endSec: 0.8 }, 'tone-trim.wav'],
    ['normalize', { targetLufs: -16 }, 'tone-norm.wav'],
    ['extract', { format: 'flac' }, 'tone.flac'],
  ]
  for (const [action, options, out] of OPS) {
    const r = await post(port, '/api/audio/run', {
      action,
      input: join(SAMPLES, 'tone-1s.wav'),
      output: join(outDir, out),
      options,
    })
    const j = await waitJob(port, r.jobId)
    const st = statSync(join(outDir, out), { throwIfNoEntry: false })
    result.audioOps[`${action} ${JSON.stringify(options)}`] = {
      status: j.status,
      error: j.error ?? null,
      message: j.message,
      bytes: st ? st.size : 0,
      sha: st
        ? createHash('sha256').update(readFileSync(join(outDir, out))).digest('hex').slice(0, 16)
        : null,
      resultKeys: Object.keys(j.result ?? {}).sort(),
      result: relativize(j.result, outDir),
    }
  }

  // ── 4. 真合并：视频模式下 DASH 视频流 + 音频流，再让 ffmpeg 合成 mp4
  const videoDir = join(outDir, 'video')
  const merged = await post(port, '/api/video/download', {
    url: TEST_URL,
    source: 'bilibili',
    outDir: videoDir,
    mode: 'video',
    quality: 32,
    audioQuality: 30216,
  })
  const mergeJob = await waitJob(port, merged.jobId)
  result.merge = {
    status: mergeJob.status,
    error: mergeJob.error ?? null,
    files: listFiles(videoDir),
    logs: (mergeJob.logs ?? []).map((l) => l.replace(/^\[[^\]]+\]\s*/, '')),
  }

  // ── 5. 取消：起一个视频下载，立刻取消，任务必须停在 canceled
  const big = await post(port, '/api/video/download', {
    url: TEST_URL,
    source: 'bilibili',
    outDir: join(outDir, 'cancel'),
    mode: 'video',
    quality: 32,
    audioQuality: 30216,
  })
  await new Promise((r) => setTimeout(r, 700))
  const canceled = await post(port, '/api/jobs/cancel', { id: big.jobId })
  const canceledJob = await waitJob(port, big.jobId, 30000)
  result.cancel = {
    // Node 的 jobs.cancel 返回整个 job，不是 {canceled:true}
    hasJob: !!canceled.job,
    status: canceledJob.status,
    message: canceledJob.message,
  }

  return result
}

async function main() {
  console.log(`Node 后端：http://127.0.0.1:${NODE_PORT}`)
  console.log(`Rust 后端：http://127.0.0.1:${RUST_PORT}`)
  console.log(`工作目录：${WORK}\n`)

  for (const [port, name] of [[NODE_PORT, 'node'], [RUST_PORT, 'rust']]) {
    try {
      const h = await (await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(3000) })).json()
      if (!h.ok) throw new Error('health 不 ok')
    } catch (err) {
      console.error(`连不上 127.0.0.1:${port}（${name}）：${err.message}`)
      process.exitCode = 1
      return
    }
  }

  console.log('跑 Node 后端…')
  const a = await run(NODE_PORT, 'node')
  console.log('跑 Rust 后端…')
  const b = await run(RUST_PORT, 'rust')

  console.log('\n═══ 产物对照 ═══')

  check('下载任务状态', a.download.status, b.download.status)
  check('下载任务 error', a.download.error, b.download.error)
  check('下载任务 result 字段', a.download.resultKeys, b.download.resultKeys)
  check('下载标题', a.download.title, b.download.title)
  check('下载产物（文件名/字节数/内容哈希）', a.download.files, b.download.files)
  check('下载日志', a.download.logs, b.download.logs)

  check('转码任务状态', a.convert.status, b.convert.status)
  check('转码 result 字段', a.convert.resultKeys, b.convert.resultKeys)
  check('转码完成消息', a.convert.message, b.convert.message)
  check('转码产物字节数', a.convert.bytes, b.convert.bytes)
  check('ffprobe 读出的源信息', a.convert.info, b.convert.info)

  check('变调任务状态', a.pitch.status, b.pitch.status)
  check('变调 semi/ratio', [a.pitch.semitones, a.pitch.ratio], [b.pitch.semitones, b.pitch.ratio])
  check('变调产物（字节数 + 哈希）', [a.pitch.bytes, a.pitch.sha], [b.pitch.bytes, b.pitch.sha])

  check('其余音频操作（tempo/trim/normalize/extract）', a.audioOps, b.audioOps)

  check('合并（视频模式）状态', a.merge.status, b.merge.status)
  check('合并产物（文件名/字节数/哈希）', a.merge.files, b.merge.files)
  check('合并日志', a.merge.logs, b.merge.logs)

  check('取消接口返回 job', a.cancel.hasJob, b.cancel.hasJob)
  check('取消后任务状态', a.cancel.status, b.cancel.status)
  check('取消后任务消息', a.cancel.message, b.cancel.message)

  /*
   * ── 6. 实时 A/B：同一个链接同时打两个后端，全字段逐条比
   *
   * 夹具是「抓一次、以后一直比」，而这里是「两边同时抓」——播放量、码率这些
   * 会变的字段也能对上，所以能比夹具更严：连 info/streams 的每个字段都在比。
   */
  console.log('\n═══ 实时 A/B（同一链接同时打两个后端）═══')
  const CASES = [
    ['普通单P视频', TEST_URL],
    ['多P视频（分P选择）', 'https://www.bilibili.com/video/BV1RMaA6jEXs?p=2'],
    ['BV 号裸写', 'BV1GJ411x7h7'],
    ['番剧 ss（DASH + 剧集列表）', 'https://www.bilibili.com/bangumi/play/ss28747'],
    ['番剧 ss（整段 durl 回退）', 'https://www.bilibili.com/bangumi/play/ss33802'],
    ['番剧 ep（无 cid）', 'https://www.bilibili.com/bangumi/play/ep282230'],
  ]
  for (const [label, url] of CASES) {
    const [x, y] = await Promise.all([
      post(NODE_PORT, '/api/video/parse', { url }),
      post(RUST_PORT, '/api/video/parse', { url }),
    ])
    check(`video/parse · ${label}`, scrub(x), scrub(y))
  }

  // yt-dlp 的错误文本也要一字不差（走的是两条不同的实现）
  const [badA, badB] = await Promise.all([
    post(NODE_PORT, '/api/video/parse', { url: 'https://example.com/not-a-video' }),
    post(RUST_PORT, '/api/video/parse', { url: 'https://example.com/not-a-video' }),
  ])
  check('video/parse 错误文本（yt-dlp 路径）', badA, badB)

  // 音频探测：拿刚下下来的 m4a 比，两个后端读的是同一个文件
  const m4a = b.download.files.find((f) => f.name.endsWith('.m4a'))?.name
  if (m4a) {
    const probeTarget = join(WORK, 'node', m4a)
    const [pa, pb] = await Promise.all([
      post(NODE_PORT, '/api/audio/probe', { input: probeTarget }),
      post(RUST_PORT, '/api/audio/probe', { input: probeTarget }),
    ])
    check('audio/probe 全字段（真实 m4a）', pa, pb)
  }

  console.log(`\n═══ 端到端结果：一致 ${pass} / 有差异 ${fail} ═══`)
  if (fail) process.exitCode = 1
}

main().catch((err) => {
  console.error('端到端对照异常：', err)
  process.exitCode = 1
})
