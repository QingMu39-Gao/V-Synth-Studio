/**
 * 翻调工作站 — 本地服务端
 *
 * 零依赖 Node HTTP 服务：托管前端静态资源 + 提供本地 API。
 * 只监听 127.0.0.1，不对外网开放。
 */

import { createServer } from 'node:http'
import { readFile, writeFile, mkdir, readdir, stat, rm } from 'node:fs/promises'
import { existsSync, mkdirSync } from 'node:fs'
import { join, dirname, extname, resolve, basename, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { networkInterfaces } from 'node:os'
import { spawn, execFileSync } from 'node:child_process'

import { listFormats, FORMAT_DEFS } from './core/formats/index.mjs'
import { convertFile, convertBatch, previewConversion, collectProjectFiles, analyzeProject } from './core/convert.mjs'
// 工程转换引擎：整个交给 LibreSVIP（支持 40 种格式），手写实现只保留读取分析用途
import * as libresvip from './core/libresvip.mjs'
import { TRANSFORM_OPS, pinyinStatus } from './core/transform.mjs'
import { detectAll, invalidateCache, launch, openInExplorer, openUrl, openWithDefault } from './core/tools.mjs'
import { jobs } from './core/jobs.mjs'
import * as audio from './core/audio.mjs'
import { BilibiliClient, QUALITY_NAMES, AUDIO_NAMES, safeTitle } from './net/bilibili.mjs'
import * as ytdlp from './net/ytdlp.mjs'
import { checkLink } from './net/http.mjs'
import { getVoices, setUserVoiceDirs, matchVoice } from './core/voices.mjs'
import { getDownloadsDir } from './core/paths.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB_DIR = join(__dirname, '..', 'web')
const DATA_DIR = join(__dirname, 'data')
const ROOT = join(__dirname, '..', '..')
const DEFAULT_OUTPUT = join(ROOT, 'output')
const CONFIG_PATH = join(DATA_DIR, 'config.json')

/* ------------------------------------------------------------------ 配置 */

/**
 * 默认输出目录。
 *
 * 用户明确要求：文件默认放到**系统下载目录**，而不是程序自己目录下的 output/。
 * 程序装在哪、用户从哪打开都不该影响「东西存哪去了」。
 * 用 getDownloadsDir() 多路探测，避免被沙箱/便携环境的 USERPROFILE 带偏。
 */
const DEFAULT_DOWNLOADS = getDownloadsDir(join(ROOT, 'downloads'))

const DEFAULT_CONFIG = {
  bilibiliCookie: '',
  proxy: '',
  outputDir: DEFAULT_DOWNLOADS,
  downloadDir: DEFAULT_DOWNLOADS,
  defaultTargetFormat: 'vsqx',
  nameTemplate: '{name}_converted',
  threads: 4,
  lastSourceFormat: 'auto',
  customPrograms: [],
  /** 用户手动添加的声库目录（自动检测不到时用） */
  voiceDirs: [],
  /** 下载默认画质偏好 */
  quality: 0,
  audioQuality: 0,
}

let configCache = null

/** 旧版本的默认输出目录；老配置里若还是这些值，就迁移到新的系统下载目录 */
const LEGACY_OUTPUT_DIRS = [join(ROOT, 'output'), join(ROOT, 'downloads')].map((p) => p.toLowerCase())

async function loadConfig() {
  if (configCache) return configCache
  let migrated = false
  try {
    const raw = await readFile(CONFIG_PATH, 'utf8')
    configCache = { ...DEFAULT_CONFIG, ...JSON.parse(raw) }
  } catch {
    configCache = { ...DEFAULT_CONFIG }
  }

  /*
   * 配置迁移：默认输出目录改成「系统下载目录」后，
   * 老用户的 config.json 里还留着程序目录下的 output/，会让新默认形同虚设。
   * 判据：值等于旧默认值（说明用户从没手动改过）才迁移，用户自己设过的路径绝不动。
   */
  for (const key of ['outputDir', 'downloadDir']) {
    const cur = String(configCache[key] ?? '')
    if (cur && LEGACY_OUTPUT_DIRS.includes(cur.toLowerCase())) {
      configCache[key] = DEFAULT_DOWNLOADS
      migrated = true
    }
  }

  // 把用户指定的声库目录注入扫描器，转换引擎就不必自己去读配置
  setUserVoiceDirs(configCache.voiceDirs)

  if (migrated) {
    try {
      await mkdir(DATA_DIR, { recursive: true })
      await writeFile(CONFIG_PATH, JSON.stringify(configCache, null, 2), 'utf8')
      console.log(`  已把默认输出目录迁移到系统下载目录：${DEFAULT_DOWNLOADS}`)
    } catch {
      /* 写不进去也不影响本次运行 */
    }
  }
  return configCache
}

async function saveConfig(patch) {
  const cfg = await loadConfig()
  const next = { ...cfg, ...patch }
  configCache = next
  // 声库目录改动后要立即生效并清缓存，否则用户加完目录还得等 5 分钟
  if (patch.voiceDirs !== undefined) setUserVoiceDirs(next.voiceDirs)
  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8')
  return next
}

/* ------------------------------------------------------------ HTTP 辅助 */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
}

function sendJson(res, data, status = 200) {
  const body = JSON.stringify(data)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  })
  res.end(body)
}

function sendError(res, err, status = 500) {
  const message = String(err?.message ?? err)
  sendJson(res, { ok: false, error: message, code: err?.code ?? null }, status)
}

async function readBody(req, limit = 4 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limit) throw new Error('请求体过大')
    chunks.push(chunk)
  }
  if (!chunks.length) return {}
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/* ------------------------------------------------------------ 路由定义 */

const routes = []
const route = (method, path, handler) => routes.push({ method, path, handler })

/* ---- 基础信息 ---- */

route('GET', '/api/health', async () => ({
  ok: true,
  name: '翻调工作站',
  version: '1.0.0',
  node: process.version,
  pid: process.pid,
  startedAt: START_TIME,
  uptimeSec: Math.round((Date.now() - START_TIME) / 1000),
}))

/**
 * 给 LibreSVIP 的格式分个组，纯粹为了界面上好找。
 * 顺序即优先级：先匹配到的算数。
 */
const FORMAT_GROUPS = [
  [/^(vsqx|vsq|xvsq|vpr|vspx|vog|vvproj|xvsq)$/i, 'VOCALOID'],
  [/^(svp|s5p)$/i, 'Synthesizer V'],
  [/^(ust|ustx)$/i, 'UTAU / OpenUtau'],
  [/^(acep|ace|aisp)$/i, 'ACE / AI 歌声'],
  [/^(ccs|dv|dspx|ds|nn|mtp|tlp|tlpx|tsmsln|tssln|vshp|vfp|y77|ps_project|ppsf)$/i, '其它歌声编辑器'],
  [/^(mid|musicxml)$/i, '通用交换格式'],
  [/^(ufdata|json|svip|svip3)$/i, '中间数据'],
  [/^(ass|lrc|srt|svg)$/i, '歌词 / 字幕'],
]

function guessFormatGroup(f) {
  for (const [re, group] of FORMAT_GROUPS) if (re.test(f.id)) return group
  return '其它'
}

route('GET', '/api/state', async () => {
  const [tools, cfg] = await Promise.all([detectAll(), loadConfig()])

  /*
   * 格式清单：以 LibreSVIP 为准（40 种），它才是真正执行转换的引擎。
   * 界面上的「可用格式」如果还按手写实现列，就会显示成 9 种 —— 与实际能力不符。
   */
  let formats
  if (libresvip.isAvailable()) {
    formats = libresvip.listFormats().map((f) => ({
      id: f.id,
      name: f.name,
      // 界面读的是 exts（复数），别写成 ext —— 写错会让整个转换视图渲染失败
      exts: f.ext,
      group: guessFormatGroup(f),
      available: true,
      canRead: true,
      canWrite: true,
      note: f.format || f.description || '',
      author: f.author,
    }))
  } else {
    formats = await listFormats()
  }

  let voices = { vocaloid: [], openutau: [], synthv: [], total: 0, scannedDirs: [], userDirs: [], hint: '' }
  try {
    const v = getVoices()
    voices = {
      vocaloid: v.vocaloid,
      openutau: v.openutau,
      synthv: v.synthv,
      total: v.total,
      registryCount: v.registryCount,
      scannedDirs: v.scannedDirs,
      userDirs: v.userDirs,
      hint: v.hint,
    }
  } catch (err) {
    voices.hint = `声库扫描失败：${err.message}`
  }
  const editors = [
    ...tools.editors,
    ...(cfg.customPrograms ?? []).map((p) => ({
      id: `custom-${p.id ?? p.name}`,
      name: p.name,
      vendor: '自定义',
      category: p.category ?? 'custom',
      formats: [],
      color: '#8b95a5',
      installed: existsSync(p.path),
      path: p.path,
      how: '自定义',
    })),
  ]
  return {
    ok: true,
    formats: formats.map((f) => ({
      id: f.id,
      name: f.name,
      vendor: f.vendor,
      exts: f.exts,
      group: f.group,
      kind: f.kind,
      available: f.available,
      reason: f.reason,
      canRead: f.canRead,
      canWrite: f.canWrite,
      writeExt: f.writeExt,
      fidelity: f.fidelity,
    })),
    editors,
    tools: tools.tools,
    voices,
    transformOps: TRANSFORM_OPS,
    audioFormats: audio.AUDIO_FORMATS,
    pinyin: pinyinStatus(),
    config: { ...cfg, bilibiliCookie: cfg.bilibiliCookie ? '已设置' : '' },
    paths: { root: ROOT, outputDir: cfg.outputDir, downloadDir: cfg.downloadDir, toolsDir: ytdlp.TOOLS_DIR },
    platform: process.platform,
  }
})

/* ---- 本机声库 ---- */

route('GET', '/api/voices', async ({ query }) => {
  const v = getVoices({ force: query.force === '1' })
  return { ok: true, ...v }
})

/**
 * 试探一个目录里有没有声库。
 * 用户手动添加目录之前先跑这个，能立刻告诉他「找到几个」，而不是加完才发现是空目录。
 */
route('POST', '/api/voices/probe', async ({ body }) => {
  const dir = String(body.dir ?? '').trim()
  if (!dir) throw new Error('缺少目录路径')
  if (!existsSync(dir)) throw new Error(`目录不存在：${dir}`)
  const v = getVoices({ extraDirs: [dir], force: true })
  const inDir = v.vocaloid.filter((b) => b.dir.toLowerCase().startsWith(dir.toLowerCase().replace(/[\\/]+$/, '')))
  const openutau = v.openutau.filter((b) => b.dir.toLowerCase().startsWith(dir.toLowerCase().replace(/[\\/]+$/, '')))
  const synthv = v.synthv.filter((b) => b.dir.toLowerCase().startsWith(dir.toLowerCase().replace(/[\\/]+$/, '')))
  return {
    ok: true,
    dir,
    found: inDir.length + openutau.length + synthv.length,
    vocaloid: inDir.map((b) => ({ compID: b.compID, name: b.name, dir: b.dir, source: b.source })),
    openutau: openutau.map((b) => ({ name: b.name, dir: b.dir })),
    synthv: synthv.map((b) => ({ name: b.name, dir: b.dir })),
    totalAfterAdd: v.total,
  }
})

/** 试匹配一个歌手名，让用户能直接验证「这个名字能不能对上」 */
route('POST', '/api/voices/match', async ({ body }) => {
  const singer = String(body.singer ?? '').trim()
  if (!singer) throw new Error('缺少歌手名')
  const banks = [...getVoices().vocaloid, ...getVoices().openutau]
  const hit = matchVoice(singer, banks)
  return {
    ok: true,
    singer,
    matched: !!hit,
    compID: hit?.bank?.compID ?? null,
    bankName: hit?.bank?.name ?? null,
    score: hit?.score ?? 0,
    reason: hit?.reason ?? '本机没有匹配到该歌姬的声库',
  }
})

/* ---- 配置 ---- */

route('GET', '/api/config', async () => ({ ok: true, config: await loadConfig() }))

route('POST', '/api/config', async ({ body }) => {
  const patch = { ...body }
  // 前端回传的是脱敏后的 '已设置'，不要覆盖真实 Cookie
  if (patch.bilibiliCookie === '已设置') delete patch.bilibiliCookie
  const saved = await saveConfig(patch)
  return { ok: true, config: { ...saved, bilibiliCookie: saved.bilibiliCookie ? '已设置' : '' } }
})

/* ---- 格式转换 ---- */

route('POST', '/api/convert/collect', async ({ body }) => {
  const { dir, recursive = true } = body
  if (!dir) throw new Error('缺少目录参数')
  if (!existsSync(dir)) throw new Error(`目录不存在：${dir}`)
  const files = await collectProjectFiles(dir, { recursive })
  const withInfo = []
  for (const f of files) {
    try {
      const st = await stat(f)
      withInfo.push({ path: f, name: basename(f), bytes: st.size, ext: extname(f).toLowerCase() })
    } catch {
      /* 跳过读不到的文件 */
    }
  }
  return { ok: true, files: withInfo, count: withInfo.length }
})

route('POST', '/api/convert/inspect', async ({ body }) => {
  const { inputPath, fromFormat } = body
  const { readProjectFromFile } = await import('./core/convert.mjs')
  const { project, format, formatId, validationIssues } = await readProjectFromFile(inputPath, { format: fromFormat })
  const analysis = analyzeProject(project)
  return {
    ok: true,
    input: { path: inputPath, name: basename(inputPath), format: formatId, formatName: format.name },
    stats: analysis.stats,
    capabilities: [...analysis.caps],
    tracks: project.tracks.map((t, i) => ({
      index: i,
      name: t.name,
      singer: t.singer,
      notes: t.notes.length,
      hasPitch: !!t.pitch?.ticks?.length,
      params: Object.keys(t.parameters ?? {}),
    })),
    validationIssues,
  }
})

route('POST', '/api/convert/preview', async ({ body }) => {
  const r = await previewConversion(body)
  return { ok: true, ...r }
})

/* ---- 浏览器上传（拖入文件）路径 ---- */
/*
 * 浏览器出于安全限制拿不到拖入文件的真实磁盘路径，所以这里把字节写到临时目录，
 * 复用同一套转换逻辑，转换结束后立刻删除临时文件。
 */

const TEMP_DIR = join(process.env.TEMP ?? process.env.TMP ?? ROOT, 'fandiao-workstation')

async function materializeUploads(files) {
  if (!Array.isArray(files) || !files.length) throw new Error('没有收到文件')
  if (files.length > 200) throw new Error('一次最多处理 200 个文件')
  const batchDir = join(TEMP_DIR, `batch-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`)
  await mkdir(batchDir, { recursive: true })
  const written = []
  for (const f of files) {
    const safeName = String(f.name ?? 'untitled').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    const buf = Buffer.from(String(f.base64 ?? ''), 'base64')
    if (!buf.length) throw new Error(`文件 ${safeName} 内容为空`)
    if (buf.length > 80 * 1024 * 1024) throw new Error(`文件 ${safeName} 超过 80MB，请改用「从目录收集」直接读本地路径`)
    // 每个上传放进独立子目录，文件名保持原样 —— 输出名才不会带上临时前缀
    const dest = join(batchDir, safeName)
    await writeFile(dest, buf)
    written.push({ path: dest, name: safeName, original: f.name })
  }
  return written
}

async function cleanupUploads(list) {
  const dirs = new Set(list.map((f) => dirname(f.path)))
  for (const d of dirs) {
    await rm(d, { recursive: true, force: true }).catch(() => {})
  }
}

route('POST', '/api/convert/preview-upload', async ({ body }) => {
  const files = await materializeUploads(body.files)
  try {
    const r = await previewConversion({
      inputPath: files[0].path,
      fromFormat: body.fromFormat,
      toFormat: body.toFormat,
      options: body.options ?? {},
    })
    // 用原始文件名回填，避免用户看到临时文件名
    r.input.name = files[0].original
    return { ok: true, ...r }
  } finally {
    await cleanupUploads(files)
  }
})

route('POST', '/api/convert/run-upload', async ({ body }) => {
  const { toFormat, outDir, options = {}, nameTemplate, overwrite = false, splitTracks = false, fromFormat = 'auto' } = body
  if (!toFormat) throw new Error('没有选择目标格式')
  const files = await materializeUploads(body.files)
  const target = await import('./core/formats/index.mjs').then((m) => m.loadFormat(toFormat))
  if (target.canWrite === false) throw new Error(`「${target.name}」目前不支持写出`)

  const job = jobs.create({
    type: 'convert',
    title: `转换 ${files.length} 个上传的工程 → ${target.name}`,
    meta: { toFormat, outDir, count: files.length, uploaded: true },
  })
  const controller = new AbortController()
  jobs.setController(job.id, controller)

  ;(async () => {
    try {
      jobs.setProgress(job.id, { percent: 1, message: '开始转换…' })
      const result = await convertBatch({
        inputs: files.map((f) => f.path),
        toFormat,
        outDir,
        options,
        nameTemplate,
        overwrite,
        splitTracks,
        fromFormat,
        onProgress: (p) => {
          const base = ((p.index - 1) / p.total) * 100
          const step = 100 / p.total
          const label = files.find((f) => f.path === p.input)?.original ?? basename(p.input)
          if (p.phase === 'start') {
            jobs.setProgress(job.id, { percent: base, message: `正在处理 ${label}` })
            jobs.log(job.id, `开始：${label}`)
          } else if (p.phase === 'done') {
            jobs.setProgress(job.id, { percent: base + step, message: `完成 ${label}` })
            for (const o of p.result.outputs) jobs.log(job.id, `  写出：${o.name}（${o.notes} 音符，${(o.bytes / 1024).toFixed(1)} KB）`)
            for (const f of p.result.findings.filter((x) => x.level === 'warn')) jobs.log(job.id, `  ⚠ ${f.message}`)
            for (const l of p.result.logs) jobs.log(job.id, `  · ${l}`)
          } else if (p.phase === 'error') {
            jobs.setProgress(job.id, { percent: base + step, message: `失败 ${label}` })
            jobs.log(job.id, `  ✗ ${p.error}`)
          }
        },
      })
      // 把临时文件名换回用户看到的原始文件名
      for (const r of result.results) {
        const hit = files.find((f) => f.path === r.input?.path)
        if (hit) r.input.name = hit.original
      }
      const failures = result.results.filter((r) => !r.ok).length
      jobs.finish(job.id, result, `完成：成功 ${result.summary.ok} / 失败 ${failures}`)
    } catch (err) {
      jobs.fail(job.id, err)
    } finally {
      await cleanupUploads(files)
    }
  })()

  return { ok: true, jobId: job.id }
})

route('POST', '/api/convert/run', async ({ body }) => {
  const { inputs = [], toFormat, outDir, options = {}, nameTemplate, overwrite = false, splitTracks = false, fromFormat = 'auto' } = body
  if (!inputs.length) throw new Error('没有选择要转换的文件')
  if (!toFormat) throw new Error('没有选择目标格式')

  const engine = libresvip.isAvailable() ? libresvip : null
  const target = engine
    ? engine.listFormats().find((f) => f.id === toFormat)
    : await import('./core/formats/index.mjs').then((m) => m.loadFormat(toFormat))
  if (!target) throw new Error(`不支持目标格式「${toFormat}」`)
  if (target.canWrite === false) throw new Error(`「${target.name}」目前不支持写出`)

  const job = jobs.create({
    type: 'convert',
    title: `转换 ${inputs.length} 个工程 → ${target.name}`,
    meta: { inputs, toFormat, outDir, count: inputs.length },
  })
  const controller = new AbortController()
  jobs.setController(job.id, controller)

  // 后台执行
  ;(async () => {
    try {
      jobs.setProgress(job.id, { percent: 1, message: '开始转换…' })
      if (engine) jobs.log(job.id, `引擎：LibreSVIP（支持 ${engine.listFormats().length} 种工程格式）`)
      const runBatch = engine ? engine.convertBatch : convertBatch
      const result = await runBatch({
        inputs,
        toFormat,
        outDir,
        options,
        nameTemplate,
        overwrite,
        splitTracks,
        fromFormat,
        signal: controller.signal,
        onProgress: (p) => {
          const base = ((p.index - 1) / p.total) * 100
          const step = 100 / p.total
          if (p.phase === 'start') {
            jobs.setProgress(job.id, { percent: base, message: `正在处理 ${basename(p.input)}` })
            jobs.log(job.id, `开始：${basename(p.input)}`)
          } else if (p.phase === 'done') {
            jobs.setProgress(job.id, { percent: base + step, message: `完成 ${basename(p.input)}` })
            for (const o of p.result.outputs) {
              // LibreSVIP 不回报音符数，这里就不硬编一个数字出来
              const size = `${(o.bytes / 1024).toFixed(1)} KB`
              jobs.log(job.id, o.notes == null
                ? `  写出：${o.name}（${size}）`
                : `  写出：${o.name}（${o.notes} 音符，${size}）`)
            }
            for (const f of (p.result.findings ?? []).filter((x) => x.level === 'warn')) jobs.log(job.id, `  ⚠ ${f.message}`)
            for (const l of p.result.logs ?? []) jobs.log(job.id, `  · ${l}`)
          } else if (p.phase === 'error') {
            jobs.setProgress(job.id, { percent: base + step, message: `失败 ${basename(p.input)}` })
            jobs.log(job.id, `  ✗ ${p.error}`)
          }
        },
      })
      const failures = result.results.filter((r) => !r.ok).length
      jobs.finish(job.id, result, `完成：成功 ${result.summary.ok} / 失败 ${failures}`)
    } catch (err) {
      jobs.fail(job.id, err)
    }
  })()

  return { ok: true, jobId: job.id }
})

/* ---- 任务 ---- */

route('GET', '/api/jobs', async () => ({
  ok: true,
  jobs: jobs.list().map((j) => ({ id: j.id, type: j.type, title: j.title, status: j.status, percent: j.percent, message: j.message, createdAt: j.createdAt })),
}))

route('GET', '/api/jobs/get', async ({ query }) => {
  const job = jobs.get(query.id)
  if (!job) throw new Error('任务不存在')
  return { ok: true, job }
})

route('POST', '/api/jobs/cancel', async ({ body }) => {
  const job = jobs.cancel(body.id)
  if (!job) throw new Error('任务不存在')
  return { ok: true, job }
})

/* ---- 文件系统 ---- */

route('GET', '/api/fs/roots', async () => {
  const roots = []
  for (const letter of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
    const p = `${letter}:\\`
    if (existsSync(p)) roots.push({ name: `${letter}:`, path: p, type: 'drive' })
  }
  const home = process.env.USERPROFILE
  if (home) {
    for (const [label, sub] of [['桌面', 'Desktop'], ['下载', 'Downloads'], ['文档', 'Documents'], ['音乐', 'Music'], ['视频', 'Videos']]) {
      const p = join(home, sub)
      if (existsSync(p)) roots.push({ name: label, path: p, type: 'user', parent: home })
    }
    roots.push({ name: '用户目录', path: home, type: 'user' })
  }
  return { ok: true, roots }
})

route('GET', '/api/fs/list', async ({ query }) => {
  const target = query.path || DEFAULT_OUTPUT
  if (!existsSync(target)) {
    // 目标不存在时返回其最近的已存在父目录
    let cur = resolve(target)
    while (!existsSync(cur) && dirname(cur) !== cur) cur = dirname(cur)
    return { ok: true, path: cur, requested: target, exists: false, dirs: await listDirs(cur), parent: dirname(cur) }
  }
  const st = await stat(target)
  if (!st.isDirectory()) throw new Error('目标不是目录')
  return { ok: true, path: resolve(target), exists: true, dirs: await listDirs(target), parent: dirname(resolve(target)) }
})

async function listDirs(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('$') && e.name !== 'System Volume Information')
      .map((e) => ({ name: e.name, path: join(dir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  } catch {
    return []
  }
}

route('POST', '/api/fs/mkdir', async ({ body }) => {
  const target = body.path
  if (!target) throw new Error('缺少路径')
  await mkdir(target, { recursive: true })
  return { ok: true, path: resolve(target) }
})

route('POST', '/api/fs/reveal', async ({ body }) => {
  const target = body.path
  if (!target || !existsSync(target)) throw new Error(`路径不存在：${target}`)
  openInExplorer(target, body.select !== false)
  return { ok: true }
})

route('POST', '/api/fs/open', async ({ body }) => {
  if (body.url) {
    openUrl(body.url)
    return { ok: true }
  }
  if (!body.path || !existsSync(body.path)) throw new Error(`路径不存在：${body.path}`)
  openWithDefault(body.path)
  return { ok: true }
})

route('POST', '/api/fs/delete', async ({ body }) => {
  const target = body.path
  if (!target || !existsSync(target)) throw new Error('路径不存在')
  await rm(target, { recursive: !!body.recursive, force: true })
  return { ok: true }
})

/* ---- 编辑器与工具 ---- */

route('GET', '/api/tools/detect', async ({ query }) => {
  const data = await detectAll(query.force === '1')
  return { ok: true, ...data }
})

route('POST', '/api/tools/launch', async ({ body }) => {
  const cfg = await loadConfig()
  let target = body.path
  if (!target && body.id) {
    const detected = await detectAll()
    const hit = detected.editors.find((e) => e.id === body.id)
      ?? (cfg.customPrograms ?? []).map((p) => ({ id: `custom-${p.id ?? p.name}`, path: p.path })).find((e) => e.id === body.id)
    if (!hit?.path) throw new Error('未找到该程序，请先在设置里指定路径')
    target = hit.path
  }
  if (!target) throw new Error('缺少程序路径')
  return { ok: true, ...launch(target, body.args ?? []) }
})

route('POST', '/api/tools/install', async ({ body }) => {
  const which = body.which
  if (!['ytdlp', 'ffmpeg'].includes(which)) throw new Error('不支持的工具')
  const job = jobs.create({ type: 'install', title: which === 'ytdlp' ? '获取 yt-dlp' : '获取 ffmpeg' })
  const controller = new AbortController()
  jobs.setController(job.id, controller)
  ;(async () => {
    try {
      jobs.setProgress(job.id, { percent: 0, message: '开始下载…' })
      if (which === 'ytdlp') {
        const r = await ytdlp.installYtDlp((p) => jobs.setProgress(job.id, { percent: p.percent * 0.95, message: `下载中 ${p.percent.toFixed(1)}%` }))
        jobs.log(job.id, `已保存到 ${r.path}`)
        jobs.finish(job.id, r, 'yt-dlp 已就绪')
      } else {
        const r = await audio.installFfmpeg((p) => jobs.setProgress(job.id, { percent: p.percent ?? 0, message: p.message ?? '处理中' }))
        jobs.log(job.id, `已安装到 ${r.path}`)
        jobs.finish(job.id, r, 'ffmpeg 已就绪')
      }
      invalidateCache()
    } catch (err) {
      jobs.fail(job.id, err)
    }
  })()
  return { ok: true, jobId: job.id }
})

/* ---- 视频解析与下载 ---- */

async function makeBiliClient(body = {}) {
  const cfg = await loadConfig()
  const cookie = body.cookie !== undefined ? body.cookie : cfg.bilibiliCookie
  return new BilibiliClient({ cookie })
}

route('POST', '/api/video/parse', async ({ body }) => {
  const raw = String(body.url ?? '').trim()
  if (!raw) throw new Error('请输入视频链接')

  // 先判断是不是 B 站
  const isBili = /bilibili\.com|b23\.tv|^BV[0-9A-Za-z]{10}$|^av\d+$/i.test(raw)
  if (isBili) {
    const client = await makeBiliClient(body)
    const parsed = await client.parseInput(raw)
    if (parsed.kind === 'bangumi') {
      const info = await client.getBangumiInfo(parsed)
      let streams = null
      if (info.cid) {
        try {
          streams = await client.getPlayStreams({ cid: info.cid, bangumiEpId: info.epId, qn: 127 })
        } catch (err) {
          streams = { error: err.message }
        }
      }
      return { ok: true, source: 'bilibili', kind: 'bangumi', info, streams, hasCookie: client.hasLogin }
    }
    const info = await client.getVideoInfo(parsed)
    const page = info.pages.find((p) => p.page === (parsed.page ?? 1)) ?? info.pages[0]
    let streams = null
    if (page) {
      try {
        streams = await client.getPlayStreams({ bvid: info.bvid, cid: page.cid, qn: 127 })
      } catch (err) {
        streams = { error: err.message }
      }
    }
    return { ok: true, source: 'bilibili', kind: 'video', info, currentPage: page, streams, hasCookie: client.hasLogin }
  }

  // 其它站点交给 yt-dlp
  const cfg = await loadConfig()
  const info = await ytdlp.inspect(raw, { proxy: cfg.proxy || undefined })
  return { ok: true, source: 'ytdlp', kind: 'video', info }
})

route('POST', '/api/video/download', async ({ body }) => {
  const { url, source = 'bilibili', outDir, mode = 'video', quality, audioQuality, downloadCover, downloadDanmaku, downloadSubs, formatId, page } = body
  if (!url) throw new Error('缺少视频链接')
  const cfg = await loadConfig()
  const targetDir = outDir || cfg.downloadDir
  await mkdir(targetDir, { recursive: true })

  const job = jobs.create({ type: 'download', title: `下载 ${url.slice(0, 60)}`, meta: { url, source } })
  const controller = new AbortController()
  jobs.setController(job.id, controller)

  ;(async () => {
    try {
      if (source === 'bilibili') {
        const client = await makeBiliClient(body)
        const parsed = await client.parseInput(url)
        jobs.setProgress(job.id, { percent: 1, message: '解析视频信息…' })

        let title = 'video'
        let cid = null
        let cover = null
        let bvid = null
        let aid = null
        let epId = null
        let durationSec = 0

        if (parsed.kind === 'bangumi') {
          const info = await client.getBangumiInfo(parsed)
          const ep = info.episodes.find((e) => e.epId === (parsed.epId ?? info.epId)) ?? info.episodes[0]
          title = `${info.title} ${ep?.title ?? ''}`.trim()
          cid = ep?.cid
          epId = ep?.epId
          cover = ep?.cover ?? info.cover
          durationSec = ep?.durationSec ?? 0
        } else {
          const info = await client.getVideoInfo(parsed)
          const p = info.pages.find((x) => x.page === (page ?? parsed.page ?? 1)) ?? info.pages[0]
          title = info.pages.length > 1 ? `${info.title} P${p.page} ${p.title}` : info.title
          cid = p?.cid
          bvid = info.bvid
          aid = info.aid
          cover = info.cover
          durationSec = p?.durationSec ?? info.durationSec
        }
        if (!cid) throw new Error('未取得 cid，无法下载')
        jobs.log(job.id, `标题：${title}`)

        jobs.setProgress(job.id, { percent: 3, message: '获取播放流…' })
        const streams = await client.getPlayStreams({ bvid, aid, cid, qn: quality ?? 127, bangumiEpId: epId })
        if (streams.error) throw new Error(streams.error)

        const safe = safeTitle(title)
        const written = []

        if (mode === 'audio') {
          const pick = decodeAudioPick(streams, audioQuality)
          if (!pick) throw new Error('未找到可用音频流')
          jobs.setProgress(job.id, { percent: 8, message: `下载音频 ${pick.qualityName}` })
          const dest = join(targetDir, `${safe}.m4a`)
          await client.downloadAsset(pick.url, dest, {
            backupUrls: pick.backupUrls,
            threads: cfg.threads ?? 4,
            signal: controller.signal,
            onProgress: (p) => jobs.setProgress(job.id, { percent: 8 + p.percent * 0.82, message: `音频 ${p.percent.toFixed(1)}%`, speedText: `${(p.speed / 1024 / 1024).toFixed(2)} MB/s` }),
          })
          written.push(dest)
          jobs.log(job.id, `已保存音频：${basename(dest)}`)
        } else {
          const pick = decodeVideoPick(streams, quality)
          if (!pick) throw new Error('未找到可用视频流')
          jobs.log(job.id, `画质：${pick.qualityName}（${pick.width}x${pick.height} ${pick.codecs}）`)
          jobs.setProgress(job.id, { percent: 5, message: `下载视频 ${pick.qualityName}` })
          const videoDest = join(targetDir, `${safe}.video.m4s`)
          const audioDest = join(targetDir, `${safe}.audio.m4s`)

          const videoPick = pick
          const audioPick = decodeAudioPick(streams, audioQuality)
          if (!audioPick) throw new Error('未找到可用音频流')

          await Promise.all([
            client.downloadAsset(videoPick.url, videoDest, {
              backupUrls: videoPick.backupUrls, threads: cfg.threads ?? 4, signal: controller.signal,
              onProgress: (p) => jobs.setProgress(job.id, { percent: 5 + p.percent * 0.45, message: `视频 ${p.percent.toFixed(1)}%`, speedText: `${(p.speed / 1024 / 1024).toFixed(2)} MB/s` }),
            }),
            client.downloadAsset(audioPick.url, audioDest, {
              backupUrls: audioPick.backupUrls, threads: cfg.threads ?? 4, signal: controller.signal,
              onProgress: (p) => jobs.setProgress(job.id, { percent: 50 + p.percent * 0.4, message: `音频 ${p.percent.toFixed(1)}%` }),
            }),
          ])

          // 合并
          const ffmpeg = await audio.findFfmpeg()
          const mp4Dest = join(targetDir, `${safe}.mp4`)
          if (ffmpeg) {
            jobs.setProgress(job.id, { percent: 92, message: '合并音视频…' })
            try {
              await audio.runFfmpeg(['-i', videoDest, '-i', audioDest, '-c', 'copy', '-movflags', '+faststart', mp4Dest], { signal: controller.signal })
              await rm(videoDest, { force: true })
              await rm(audioDest, { force: true })
              written.push(mp4Dest)
              jobs.log(job.id, `已合并输出：${basename(mp4Dest)}`)
            } catch (err) {
              jobs.log(job.id, `⚠ 合并失败（${err.message}），已保留分离的音视频流`)
              written.push(videoDest, audioDest)
            }
          } else {
            jobs.log(job.id, '⚠ 未安装 ffmpeg，已保留分离的视频流与音频流；安装 ffmpeg 后可自动合并为 mp4')
            written.push(videoDest, audioDest)
          }
        }

        // 封面
        if (downloadCover && cover) {
          try {
            const coverDest = join(targetDir, `${safe}.jpg`)
            await client.downloadAsset(cover, coverDest, { threads: 1, signal: controller.signal })
            written.push(coverDest)
            jobs.log(job.id, `已保存封面：${basename(coverDest)}`)
          } catch (err) {
            jobs.log(job.id, `⚠ 封面下载失败：${err.message}`)
          }
        }

        // 弹幕
        if (downloadDanmaku) {
          try {
            const xml = await client.getDanmakuXml(cid)
            const dest = join(targetDir, `${safe}.danmaku.xml`)
            await writeFile(dest, xml, 'utf8')
            written.push(dest)
            jobs.log(job.id, `已保存弹幕：${basename(dest)}`)
          } catch (err) {
            jobs.log(job.id, `⚠ 弹幕下载失败：${err.message}`)
          }
        }

        // 字幕
        if (downloadSubs) {
          try {
            const subs = await client.getSubtitles({ bvid, aid, cid })
            for (const s of subs) {
              const json = await (await fetch(s.url)).text()
              const dest = join(targetDir, `${safe}.${s.lan}.srt`)
              await writeFile(dest, bccToSrt(json), 'utf8')
              written.push(dest)
              jobs.log(job.id, `已保存字幕：${basename(dest)}（${s.lanDoc}）`)
            }
            if (!subs.length) jobs.log(job.id, '该视频没有官方字幕')
          } catch (err) {
            jobs.log(job.id, `⚠ 字幕下载失败：${err.message}`)
          }
        }

        jobs.finish(job.id, { files: written, title, dir: targetDir }, `下载完成：${written.length} 个文件`)
      } else {
        // yt-dlp
        jobs.setProgress(job.id, { percent: 1, message: 'yt-dlp 启动中…' })
        const r = await ytdlp.download(url, {
          outDir: targetDir,
          mode,
          formatId,
          convertTo: body.convertTo,
          proxy: cfg.proxy || undefined,
          cookiesFromBrowser: body.cookiesFromBrowser,
          embedSubs: downloadSubs,
          signal: controller.signal,
          onProgress: (p) => {
            if (p.percent >= 0) jobs.setProgress(job.id, { percent: p.percent, message: `${p.stage} ${p.percent.toFixed(1)}%`, speedText: p.speed, etaText: p.eta })
            else jobs.setProgress(job.id, { message: p.line.slice(0, 120) })
          },
        })
        jobs.finish(job.id, { files: r.files, dir: targetDir }, `下载完成：${r.files.length} 个文件`)
      }
      invalidateCache()
    } catch (err) {
      if (err.name === 'AbortError') jobs.cancel(job.id)
      else jobs.fail(job.id, err)
    }
  })()

  return { ok: true, jobId: job.id }
})

function decodeVideoPick(streams, quality) {
  if (streams.mode === 'durl') return streams.streams[0]
  const list = streams.video ?? []
  if (!list.length) return null
  if (quality) {
    const exact = list.find((v) => v.id === Number(quality))
    if (exact) return preferAvc(list, exact)
  }
  // 默认取最高画质，优先 H.264（兼容性最好）
  const highest = list[0]
  return preferAvc(list, highest)
}

/** 同画质下优先 AVC，避免 HEVC 在老编辑器/播放器里打不开 */
function preferAvc(list, target) {
  const sameQuality = list.filter((v) => v.id === target.id)
  return sameQuality.find((v) => /avc|h264/i.test(v.codecs ?? '')) ?? target
}

function decodeAudioPick(streams, audioQuality) {
  if (streams.mode === 'durl') return null
  const list = streams.audio ?? []
  if (!list.length) return null
  if (audioQuality) {
    const exact = list.find((a) => a.id === Number(audioQuality))
    if (exact) return exact
  }
  // 默认取 192K，而不是 Hi-Res：兼容性更好且体积合理
  return list.find((a) => a.id === 30280) ?? list[0]
}

/** B 站字幕 JSON → SRT */
function bccToSrt(jsonText) {
  let data
  try {
    data = JSON.parse(jsonText)
  } catch {
    return jsonText
  }
  const body = data.body ?? []
  const fmt = (sec) => {
    const ms = Math.round((sec % 1) * 1000)
    const s = Math.floor(sec) % 60
    const m = Math.floor(sec / 60) % 60
    const h = Math.floor(sec / 3600)
    const p = (n, w = 2) => String(n).padStart(w, '0')
    return `${p(h)}:${p(m)}:${p(s)},${p(ms, 3)}`
  }
  return body
    .map((item, i) => `${i + 1}\n${fmt(item.from)} --> ${fmt(item.to)}\n${item.content}\n`)
    .join('\n')
}

/* ---- 音频工具 ---- */

route('POST', '/api/audio/run', async ({ body }) => {
  const { action, input, output, options = {} } = body
  if (!input) throw new Error('缺少输入文件')
  const job = jobs.create({ type: 'audio', title: `音频处理：${action}` })
  const controller = new AbortController()
  jobs.setController(job.id, controller)
  ;(async () => {
    try {
      jobs.setProgress(job.id, { percent: 2, message: '处理中…' })
      const onProgress = (p) => jobs.setProgress(job.id, { percent: p.percent ?? 50, message: `处理中 ${(p.percent ?? 0).toFixed(0)}%` })
      let result
      switch (action) {
        case 'convert':
          result = await audio.convertAudio({ input, output, ...options, onProgress, signal: controller.signal })
          break
        case 'extract':
          result = await audio.extractAudio({ input, output, ...options, onProgress, signal: controller.signal })
          break
        case 'pitch':
          result = await audio.shiftPitch({ input, output, ...options, onProgress, signal: controller.signal })
          break
        case 'tempo':
          result = await audio.changeTempo({ input, output, ...options, onProgress, signal: controller.signal })
          break
        case 'trim':
          result = await audio.trimAudio({ input, output, ...options, onProgress, signal: controller.signal })
          break
        case 'normalize':
          result = await audio.normalizeLoudness({ input, output, ...options, onProgress, signal: controller.signal })
          break
        default:
          throw new Error(`未知的音频操作：${action}`)
      }
      jobs.finish(job.id, result, `完成：${basename(output)}`)
    } catch (err) {
      if (err.name === 'AbortError') jobs.cancel(job.id)
      else jobs.fail(job.id, err)
    }
  })()
  return { ok: true, jobId: job.id }
})

route('POST', '/api/audio/probe', async ({ body }) => {
  if (!body.input || !existsSync(body.input)) throw new Error('文件不存在')
  const info = await audio.probeMedia(body.input)
  return { ok: true, info }
})

/* ---- 资源库 ---- */

let resourcesCache = null

route('GET', '/api/resources', async ({ query }) => {
  if (!resourcesCache || query.reload === '1') {
    try {
      resourcesCache = JSON.parse(await readFile(join(DATA_DIR, 'resources.json'), 'utf8'))
    } catch (err) {
      return { ok: false, error: `资源库数据缺失或损坏：${err.message}`, groups: [] }
    }
  }
  return { ok: true, ...resourcesCache }
})

route('POST', '/api/resources/check', async ({ body }) => {
  const data = resourcesCache ?? JSON.parse(await readFile(join(DATA_DIR, 'resources.json'), 'utf8'))
  const only = body.ids?.length ? new Set(body.ids) : null
  const all = []
  for (const g of data.groups ?? []) {
    for (const item of g.items ?? []) {
      if (!item.url) continue
      if (only && !only.has(item.id)) continue
      all.push({ group: g.id, ...item })
    }
  }
  const job = jobs.create({ type: 'linkcheck', title: `校验 ${all.length} 条资源链接` })
  ;(async () => {
    try {
      const results = []
      let done = 0
      for (const item of all) {
        const r = await checkLink(item.url)
        results.push({ id: item.id, group: item.group, name: item.name, url: item.url, ...r })
        done += 1
        jobs.setProgress(job.id, { percent: (done / all.length) * 100, message: `已校验 ${done}/${all.length}` })
        if (!r.ok) jobs.log(job.id, `✗ ${item.name}（${r.status || r.error}）`)
      }
      const bad = results.filter((r) => !r.ok)
      jobs.finish(job.id, { results, ok: results.length - bad.length, bad: bad.length }, `校验完成：${results.length - bad.length} 正常 / ${bad.length} 异常`)
    } catch (err) {
      jobs.fail(job.id, err)
    }
  })()
  return { ok: true, jobId: job.id, count: all.length }
})

/* ------------------------------------------------------------ 静态资源 */

async function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0])
  if (rel === '/' || rel === '') rel = '/index.html'
  const filePath = resolve(join(WEB_DIR, rel))
  if (!filePath.startsWith(resolve(WEB_DIR))) {
    res.writeHead(403)
    res.end('Forbidden')
    return
  }
  try {
    const st = await stat(filePath)
    if (st.isDirectory()) return serveStatic(req, res, `${rel}/index.html`)
    const ext = extname(filePath).toLowerCase()
    const data = await readFile(filePath)
    res.writeHead(200, {
      'Content-Type': MIME[ext] ?? 'application/octet-stream',
      'Content-Length': data.length,
      'Cache-Control': 'no-cache',
    })
    res.end(data)
  } catch {
    // SPA 回退
    try {
      const data = await readFile(join(WEB_DIR, 'index.html'))
      res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': 'no-cache' })
      res.end(data)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('前端资源缺失')
    }
  }
}

/* ------------------------------------------------------------ SSE 进度 */

function handleJobStream(req, res, jobId) {
  const job = jobs.get(jobId)
  if (!job) {
    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify({ ok: false, error: '任务不存在' }))
    return
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  const send = (j) => {
    res.write(`data: ${JSON.stringify(j)}\n\n`)
  }
  send(job)
  const unsubscribe = jobs.subscribe(jobId, (j) => {
    send(j)
    if (j.status === 'done' || j.status === 'error' || j.status === 'canceled') {
      setTimeout(() => {
        unsubscribe()
        res.end()
      }, 300)
    }
  })
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 15000)
  req.on('close', () => {
    clearInterval(keepAlive)
    unsubscribe()
  })
}

/* --------------------------------------------------------------- 服务 */

const START_TIME = Date.now()
const CLI_ARGS = process.argv.slice(2)
const OPEN_BROWSER = CLI_ARGS.includes('--open')
const portArg = CLI_ARGS.find((a) => /^--port=\d+$/.test(a))
let PORT = portArg ? Number(portArg.split('=')[1]) : Number(process.env.DSH_WORKSTATION_PORT ?? 8787)

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`)
  const path = url.pathname

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  // SSE
  const streamMatch = path.match(/^\/api\/jobs\/([\w-]+)\/stream$/)
  if (streamMatch) {
    handleJobStream(req, res, streamMatch[1])
    return
  }

  if (path.startsWith('/api/')) {
    const matched = routes.find((r) => r.method === req.method && r.path === path)
    if (!matched) {
      sendError(res, new Error(`未知接口：${req.method} ${path}`), 404)
      return
    }
    try {
      const body = req.method === 'POST' ? await readBody(req) : {}
      const query = Object.fromEntries(url.searchParams.entries())
      const result = await matched.handler({ body, query, req, res })
      if (!res.writableEnded) sendJson(res, result)
    } catch (err) {
      console.error(`[API 错误] ${req.method} ${path}:`, err.message)
      sendError(res, err, err.code === 'NO_FFMPEG' ? 400 : 500)
    }
    return
  }

  serveStatic(req, res, path)
})

/**
 * 用 Edge / Chrome 的「应用窗口」模式打开，去掉地址栏与标签页，
 * 看起来就是一个独立桌面程序。都找不到时退回默认浏览器。
 *
 * 关键点：**必须带一个独立的 --user-data-dir**。
 * 否则当用户的 Edge 已经开着时，新传的 --app= 会被转发给已有实例，
 * 结果是「在现有窗口里多开一个标签页」——就没有应用窗口的感觉了。
 * 代价是首次启动会建一个干净的配置目录（约几十 MB），对这个本地工具是划算的。
 */
const APP_PROFILE_DIR = join(ROOT, 'data', 'browser-profile')

/** 是否已经有一个用我们专属配置目录跑着的应用窗口 */
function appWindowRunning() {
  if (process.platform !== 'win32') return false
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name='msedge.exe' OR Name='chrome.exe'\" | " +
        "Where-Object { $_.CommandLine -like '*--app=*' -and $_.CommandLine -like '*browser-profile*' } | " +
        'Select-Object -First 1 -ExpandProperty ProcessId',
    ], { encoding: 'utf8', timeout: 8000, windowsHide: true })
    return /\d/.test(out)
  } catch {
    return false
  }
}

function openAppWindow(url) {
  const candidates = [
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(process.env['ProgramFiles'] ?? 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(process.env['LOCALAPPDATA'] ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean)

  const appUrl = `${url}/?app=1`
  try {
    mkdirSync(APP_PROFILE_DIR, { recursive: true })
  } catch {
    /* 建不出来就退回不带配置目录的模式 */
  }

  for (const exe of candidates) {
    if (!existsSync(exe)) continue
    try {
      const args = [
        `--app=${appUrl}`,
        `--user-data-dir=${APP_PROFILE_DIR}`,
        '--window-size=1480,940',
        '--window-position=80,40',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-features=Translate,EdgeCollections',
      ]
      const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: false })
      child.unref()
      return { opened: true, browser: exe }
    } catch {
      /* 试下一个 */
    }
  }
  // 退回默认浏览器（这时只能开标签页了）
  try {
    const child = spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true })
    child.unref()
    return { opened: true, browser: '默认浏览器（标签页）' }
  } catch {
    return { opened: false }
  }
}

/**
 * 启动 HTTP 服务；端口被占用时自动向后续端口重试。
 *
 * 注意：端口号要用局部变量传递，不要改模块级的 PORT。
 * 早期写法改的是模块级 PORT，一旦重试，外层再调用 start() 就会从已经 +1 的端口继续，
 * 出现「同一个端口打印两次启动横幅」这类怪异现象。
 */
function start(port = PORT, attempt = 0) {
  return new Promise((resolvePromise, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening)
      if (err.code === 'EADDRINUSE' && port < 8800) {
        resolvePromise(start(port + 1, attempt + 1))
      } else if (err.code === 'EADDRINUSE') {
        reject(new Error(`端口 ${PORT}-8800 全部被占用，请先运行「停止工作站.bat」`))
      } else {
        reject(err)
      }
    }
    const onListening = () => {
      server.removeListener('error', onError)
      const addr = server.address()
      PORT = addr.port
      if (attempt > 0) {
        console.log(`\n  （端口 ${port - 1} 已被占用，改用 ${addr.port}）`)
      }
      console.log(`\n  翻调工作站已启动`)
      console.log(`  ─────────────────────────────────`)
      console.log(`  地址：http://127.0.0.1:${addr.port}`)
      console.log(`  根目录：${ROOT}`)
      console.log(`  停止服务：Ctrl+C\n`)
      if (OPEN_BROWSER) {
        if (appWindowRunning()) {
          console.log(`  应用窗口已在运行，跳过重复打开\n`)
        } else {
          const r = openAppWindow(`http://127.0.0.1:${addr.port}`)
          console.log(r.opened ? `  已打开应用窗口（${r.browser}）\n` : `  未能自动打开窗口，请手动访问上面的地址\n`)
        }
      }
      resolvePromise({ port: addr.port, url: `http://127.0.0.1:${addr.port}` })
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, '127.0.0.1')
  })
}

export { start, server, PORT }

// 直接运行时启动
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isMain) {
  /*
   * 辅助模式：只负责打开/复用应用窗口，不启动服务。
   * 启动器发现服务已在运行时，会用这个模式调用，避免重复双击开出好几个窗口。
   */
  const openUrlArg = CLI_ARGS.find((a) => a.startsWith('--open-url='))
  if (openUrlArg) {
    const url = openUrlArg.slice('--open-url='.length)
    if (appWindowRunning()) console.log('应用窗口已在运行，无需重复打开')
    else {
      const r = openAppWindow(url)
      console.log(r.opened ? `已打开应用窗口（${r.browser}）` : `未能自动打开窗口，请手动访问 ${url}`)
    }
    process.exit(0)
  }

  start().catch((err) => {
    if (err.code === 'EADDRINUSE') {
      console.error(`\n  端口被占用，可能工作站已经在运行了。`)
      console.error(`  直接打开 http://127.0.0.1:${PORT} 即可；或先运行「停止工作站.bat」。\n`)
    } else {
      console.error('启动失败：', err.message)
    }
    process.exitCode = 1
  })
}
