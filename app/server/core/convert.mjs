/**
 * 转换引擎
 *
 * 能力：
 *  - 单文件 / 批量 / 整目录转换，全部离线
 *  - 转换前的「失真预检」：明确列出目标格式装不下的数据（UtaFormatix 不提供）
 *  - 变换管线：转调、歌词改写、VCV 化、量化、轨道拆分合并等（见 transform.mjs）
 *  - 输出命名模板、覆盖策略、按轨拆分导出
 */

import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, join, resolve, dirname } from 'node:path'
import { createProject, validateProject, noteCount, projectEndTick, tickToSec, projectStartTick } from './ir.mjs'
import { loadFormat, FORMAT_DEFS, guessFormatByContent, guessFormatByExt } from './formats/index.mjs'
import { applyTransforms } from './transform.mjs'
import { getVoices, buildVoiceMap } from './voices.mjs'

/* ------------------------------------------------------------ 能力模型 */

/** fidelity.preserves 中使用的能力标识 → 中文名 */
export const CAPABILITY_LABELS = {
  tempo: '速度变化',
  timeSignature: '拍号变化',
  notes: '音符',
  lyrics: '歌词',
  pitchCurve: '音高曲线（PIT）',
  vibrato: '颤音参数',
  phonemes: '音素数据',
  multiTrack: '多轨道',
  trackVolume: '轨道音量',
  trackPan: '声像',
  singer: '歌手名',
  'params.dynamics': '力度曲线',
  'params.breathiness': '气声曲线',
  'params.brightness': '明亮度曲线',
  'params.gender': '性别参数',
  'params.tension': '张力曲线',
  'params.voicing': '发声曲线',
  'params.opening': '开口度',
  'params.velocity': '辅音速度',
  'params.clearness': '清晰度',
  'params.portamento': '滑音时间',
  detune: '音符微调（DETUNE）',
  velocity: '音符力度（VEL）',
  trackName: '轨道名',
  trackColor: '轨道颜色',
  mixer: '混音设置',
}

function label(token) {
  return CAPABILITY_LABELS[token] ?? token
}

/** 分析工程「实际用到了哪些能力」 */
export function analyzeProject(project) {
  const caps = new Set(['notes', 'lyrics'])
  if (project.tempos.length > 1) caps.add('tempo')
  if (project.timeSignatures.length > 1) caps.add('timeSignature')
  if (project.tracks.length > 1) caps.add('multiTrack')

  const paramList = new Set()
  let hasPitch = false
  let hasVibrato = false
  let hasPhonemes = false
  let hasDetune = false
  let hasVelocity = false
  let notes = 0

  for (const track of project.tracks) {
    notes += track.notes.length
    if (track.pitch?.ticks?.length) hasPitch = true
    if (track.phonemes?.length) hasPhonemes = true
    if (track.singer) caps.add('singer')
    if (Math.abs(track.volume - 1) > 1e-6) caps.add('trackVolume')
    if (Math.abs(track.pan) > 1e-6) caps.add('trackPan')
    for (const key of Object.keys(track.parameters ?? {})) paramList.add(key)
    for (const note of track.notes) {
      if (note.attributes?.vibrato) hasVibrato = true
      if (note.detune) hasDetune = true
      if (note.velocity && note.velocity !== 64) hasVelocity = true
    }
  }

  if (hasPitch) caps.add('pitchCurve')
  if (hasVibrato) caps.add('vibrato')
  if (hasPhonemes) caps.add('phonemes')
  if (hasDetune) caps.add('detune')
  if (hasVelocity) caps.add('velocity')
  for (const p of paramList) caps.add(`params.${p}`)

  const endTick = projectEndTick(project)
  return {
    caps,
    params: [...paramList],
    stats: {
      trackCount: project.tracks.length,
      noteCount: notes,
      startTick: projectStartTick(project),
      endTick,
      durationSec: tickToSec(endTick, project.tempos),
      tempoCount: project.tempos.length,
      timeSignatureCount: project.timeSignatures.length,
      hasPitchCurve: hasPitch,
      hasPhonemes,
      params: [...paramList],
      lyricSample: project.tracks.flatMap((t) => t.notes.slice(0, 12).map((n) => n.lyric)).filter(Boolean).slice(0, 12),
    },
  }
}

/** 目标格式能力集合 */
function targetCaps(fmt) {
  const set = new Set(fmt.fidelity?.preserves ?? [])
  // 任何能写歌词的格式都能写音符
  set.add('notes')
  return set
}

/**
 * 失真预检：源工程用到的能力中，目标格式装不下的部分
 * @returns {{level:'warn'|'info', token:string, message:string}[]}
 */
export function preflight(project, fmt) {
  const { caps, params, stats } = analyzeProject(project)
  const tCaps = targetCaps(fmt)
  const findings = []

  // 音高曲线是最容易丢且最影响翻调工作量的数据
  if (caps.has('pitchCurve') && !tCaps.has('pitchCurve')) {
    findings.push({ level: 'warn', token: 'pitchCurve',
      message: `源工程含音高曲线，但「${fmt.name}」无法保存音高曲线 —— 滑音/颤音的细腻处理会丢失，目标编辑器里需要重调。` })
  }
  if (caps.has('vibrato') && !tCaps.has('vibrato')) {
    findings.push({ level: 'warn', token: 'vibrato',
      message: '源工程含音符级颤音参数，目标格式不支持，颤音会退化为固定音高。' })
  }
  if (caps.has('phonemes') && !tCaps.has('phonemes')) {
    findings.push({ level: 'warn', token: 'phonemes',
      message: '源工程含音素（发音符号）数据，目标格式不支持，目标编辑器会按歌词重新推断发音。' })
  }
  if (caps.has('multiTrack') && !tCaps.has('multiTrack')) {
    findings.push({ level: 'warn', token: 'multiTrack',
      message: `源工程有 ${stats.trackCount} 个轨道，但「${fmt.name}」只承载单轨：多余轨道要么被丢弃、要么被压到一条轨上（具体见下方该格式的已知限制）。` +
        `需要保留多轨的话，请改用支持多轨的格式（如 .vsqx / .vpr / .svp / .ustx）。` })
  }
  if (caps.has('tempo') && !tCaps.has('tempo')) {
    findings.push({ level: 'warn', token: 'tempo',
      message: '源工程含变速，目标格式只支持单一速度，变速会被拍平。' })
  }
  if (caps.has('timeSignature') && !tCaps.has('timeSignature')) {
    findings.push({ level: 'warn', token: 'timeSignature',
      message: '源工程含变拍号，目标格式只支持单一拍号。' })
  }

  const droppedParams = params.filter((p) => !tCaps.has(`params.${p}`))
  if (droppedParams.length) {
    findings.push({ level: 'warn', token: 'params',
      message: `以下参数曲线目标格式不支持，将被丢弃：${droppedParams.map(label).join('、')}。` })
  }
  if ((caps.has('detune') || caps.has('velocity')) && !tCaps.has('detune') && !tCaps.has('velocity')) {
    findings.push({ level: 'info', token: 'noteAttrs',
      message: '音符级微调/力度参数目标格式不支持，已按默认值处理。' })
  }

  if (fmt.fidelity?.drops?.length) {
    findings.push({ level: 'info', token: 'declared',
      message: `该格式模块声明的已知限制：${fmt.fidelity.drops.join('、')}。` })
  }
  if (fmt.fidelity?.notes) {
    findings.push({ level: 'info', token: 'notes', message: fmt.fidelity.notes })
  }
  return findings
}

/* ------------------------------------------------------------ 读取文件 */

/**
 * 读取工程文件
 * @param {string} filePath
 * @param {{format?:string}} opts
 */
export async function readProjectFromFile(filePath, opts = {}) {
  const buf = await readFile(filePath)
  let formatId = opts.format && opts.format !== 'auto' ? opts.format : null
  if (!formatId) {
    formatId = guessFormatByExt(filePath) ?? guessFormatByContent(buf, filePath)
  }
  // 扩展名歧义（例如 .json）时用内容再猜一次
  if (!formatId) formatId = guessFormatByContent(buf, filePath)
  if (!formatId) {
    throw new Error(`无法识别工程格式：${basename(filePath)}。请手动指定源格式。`)
  }
  const fmt = await loadFormat(formatId)
  if (fmt.canRead === false) throw new Error(`「${fmt.name}」目前只支持导出，不支持读取。`)
  const project = fmt.read(buf, { name: basename(filePath), path: filePath })
  const issues = validateProject(project)
  if (issues.length) {
    // 不阻断转换，但把问题带出去给用户看
    project.extras.__validationIssues = issues
  }
  return { project, format: fmt, formatId, buffer: buf, validationIssues: issues }
}

/* ------------------------------------------------------------ 命名模板 */

export function applyNameTemplate(template, ctx) {
  const date = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const map = {
    name: ctx.name ?? 'untitled',
    format: ctx.format ?? '',
    ext: ctx.ext ?? '',
    index: String(ctx.index ?? 1).padStart(2, '0'),
    track: ctx.track ?? '',
    date: `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`,
    time: `${pad(date.getHours())}${pad(date.getMinutes())}`,
    srcformat: ctx.srcFormat ?? '',
  }
  let out = String(template || '{name}')
  for (const [k, v] of Object.entries(map)) out = out.replaceAll(`{${k}}`, String(v))
  return sanitizeFileName(out)
}

/** 去掉 Windows 非法文件名字符 */
export function sanitizeFileName(name) {
  return String(name)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/, '')
    .slice(0, 120) || 'untitled'
}

/** 避免覆盖：返回一个不冲突的路径 */
async function uniquePath(path) {
  if (!existsSync(path)) return path
  const ext = extname(path)
  const base = path.slice(0, path.length - ext.length)
  for (let i = 2; i < 1000; i += 1) {
    const candidate = `${base} (${i})${ext}`
    if (!existsSync(candidate)) return candidate
  }
  return `${base} (${Date.now()})${ext}`
}

/* ------------------------------------------------------------ 转换核心 */

/**
 * 转换单个文件
 * @param {object} req
 * @param {string} req.inputPath
 * @param {string} req.toFormat
 * @param {string} [req.outDir]       目标目录；缺省与源文件同目录
 * @param {object} [req.options]      变换管线选项
 * @param {string} [req.nameTemplate] 默认 '{name}'
 * @param {boolean}[req.overwrite]    默认 false（自动改名）
 * @param {boolean}[req.splitTracks]  每个轨道导出为独立文件
 * @param {boolean}[req.dryRun]       只预检不写盘
 */
export async function convertFile(req) {
  const started = Date.now()
  const { inputPath, toFormat, options = {}, nameTemplate = '{name}_converted', overwrite = false } = req
  if (!existsSync(inputPath)) throw new Error(`找不到源文件：${inputPath}`)

  const { project: srcProject, format: srcFmt, formatId: srcFormatId, validationIssues } = await readProjectFromFile(inputPath, {
    format: req.fromFormat,
  })
  const dstFmt = await loadFormat(toFormat)
  if (dstFmt.canWrite === false) throw new Error(`「${dstFmt.name}」目前不支持写出。`)

  const findings = preflight(srcProject, dstFmt)
  const { project, logs } = await applyTransforms(srcProject, options)
  const after = analyzeProject(project)

  /*
   * 写出参数：某些格式需要额外的本机环境信息才能「转出来真的能用」。
   *
   * 目前只有 .vpr，而且这里有个**必须做对**的点：
   * VOCALOID 打开工程时会拿 compID 去查已安装声库，查不到就直接报错拒绝打开。
   * 所以除了「按歌手名匹配」，还要把「本机到底装了哪些声库」整份交给 writer，
   * 让它匹配失败时退而用本机已有的声库，绝不写出一个不存在的 compID。
   */
  const writeOptions = { ...(req.writeOptions ?? {}) }
  const writeReport = {}
  if (toFormat === 'vpr') {
    try {
      const voices = getVoices()
      const banks = [...(voices.vocaloid ?? []), ...(voices.openutau ?? [])]
      writeOptions.installedVoices = (voices.vocaloid ?? []).map((b) => ({ compID: b.compID, name: b.name }))
      writeOptions.report = writeReport
      if (banks.length) {
        const { map, matches } = buildVoiceMap(project, banks)
        if (matches.length) {
          writeOptions.voiceMap = map
          for (const m of matches) {
            logs.push(`声库匹配：${m.singer} → ${m.bankName}（${m.compID}）`)
          }
        }
      }
    } catch (err) {
      logs.push(`声库匹配跳过：${err.message}`)
    }
  }

  const ext = dstFmt.writeExt ?? dstFmt.exts[0]
  const srcName = basename(inputPath, extname(inputPath))
  const outDir = req.outDir ? resolve(req.outDir) : dirname(resolve(inputPath))

  const written = []
  if (!req.dryRun) {
    await mkdir(outDir, { recursive: true })

    const outputs = []
    if (req.splitTracks && project.tracks.length > 1) {
      project.tracks.forEach((track, i) => {
        const single = createProject({ ...project, tracks: [track] })
        outputs.push({
          project: single,
          name: applyNameTemplate(nameTemplate, {
            name: srcName, format: toFormat, ext, index: i + 1,
            track: track.name || `track${i + 1}`, srcFormat: srcFormatId,
          }),
        })
      })
    } else {
      outputs.push({
        project,
        name: applyNameTemplate(nameTemplate, { name: srcName, format: toFormat, ext, srcFormat: srcFormatId }),
      })
    }

    for (const out of outputs) {
      const target = join(outDir, `${out.name}${ext}`)
      const finalPath = overwrite ? target : await uniquePath(target)
      const buf = dstFmt.write(out.project, { name: out.name, sourceFormat: srcFormatId, ...writeOptions })
      if (!Buffer.isBuffer(buf)) throw new Error(`格式模块 ${toFormat} 的 write() 未返回 Buffer`)
      await writeFile(finalPath, buf)
      const st = await stat(finalPath)

      /*
       * 报告口径：写出后立刻用同一模块回读一遍，报告「文件里真实有多少内容」。
       *
       * 为什么不能直接用工程对象的统计：单轨格式（如 UST）只承载一个轨道，
       * 5 轨 964 音符的工程写出来其实只有 1 轨 517 音符。若照搬工程统计，
       * 日志会显示「964 音符」，用户会以为全都写进去了 —— 这是会误导人的错误信息。
       */
      let reportedTracks = out.project.tracks.length
      let reportedNotes = noteCount(out.project)
      let verifiedByReadback = false
      if (dstFmt.canRead !== false) {
        try {
          const check = dstFmt.read(buf, { name: out.name })
          reportedTracks = check.tracks.length
          reportedNotes = noteCount(check)
          verifiedByReadback = true
        } catch (err) {
          logs.push(`⚠ 写出后回读校验失败（不影响文件已生成）：${err.message}`)
        }
      }

      const sourceNotes = noteCount(out.project)
      if (verifiedByReadback && reportedNotes < sourceNotes) {
        const diff = sourceNotes - reportedNotes
        logs.push(
          `该格式实际承载 ${reportedTracks} 轨 / ${reportedNotes} 音符；` +
          `源工程 ${out.project.tracks.length} 轨 / ${sourceNotes} 音符，有 ${diff} 个音符未被写入` +
          `（单轨格式的正常结果，详见转换前提示）`
        )
      }

      // 声库被替换过要说清楚：用户进去会发现歌手不是原来那个
      const subs = writeReport.voiceSubstitutions ?? []
      if (subs.length) {
        const list = [...new Set(subs.map((s) => `「${s.singer}」→ ${s.usedName}`))]
        logs.push(
          `声库替换：${list.join('，')}。本机没有这些歌手对应的 VOCALOID 声库，` +
          `工程里改用了本机已装的声库 —— 不这么做 VOCALOID 会因为找不到声库而拒绝打开文件。` +
          `进去后在轨道上手动选一次想要的声库即可。`
        )
      }

      written.push({
        path: finalPath,
        name: basename(finalPath),
        bytes: st.size,
        tracks: reportedTracks,
        notes: reportedNotes,
        sourceTracks: out.project.tracks.length,
        sourceNotes,
        verifiedByReadback,
      })
    }
  }

  return {
    ok: true,
    input: { path: inputPath, name: basename(inputPath), format: srcFormatId, formatName: srcFmt.name },
    target: { format: toFormat, name: dstFmt.name, ext },
    outputs: written,
    outDir,
    findings,
    validationIssues,
    logs,
    stats: after.stats,
    elapsedMs: Date.now() - started,
  }
}

/**
 * 批量转换
 * @param {{inputs:string[], onProgress?:Function}} req
 */
export async function convertBatch(req) {
  const { inputs = [], onProgress } = req
  const results = []
  let index = 0
  for (const input of inputs) {
    index += 1
    onProgress?.({ phase: 'start', index, total: inputs.length, input })
    try {
      const r = await convertFile({ ...req, inputPath: input })
      results.push(r)
      onProgress?.({ phase: 'done', index, total: inputs.length, input, result: r })
    } catch (err) {
      const failure = {
        ok: false,
        input: { path: input, name: basename(input) },
        error: String(err.message ?? err),
      }
      results.push(failure)
      onProgress?.({ phase: 'error', index, total: inputs.length, input, error: failure.error })
    }
  }
  const okCount = results.filter((r) => r.ok).length
  return {
    results,
    summary: {
      total: inputs.length,
      ok: okCount,
      failed: inputs.length - okCount,
      outputFiles: results.reduce((n, r) => n + (r.outputs?.length ?? 0), 0),
      elapsedMs: results.reduce((n, r) => n + (r.elapsedMs ?? 0), 0),
    },
  }
}

/** 递归收集目录下所有可识别的工程文件 */
export async function collectProjectFiles(dir, opts = {}) {
  const { recursive = true, maxFiles = 500 } = opts
  const out = []
  const exts = new Set()
  for (const def of FORMAT_DEFS) for (const e of def.exts) if (e !== '.json') exts.add(e)

  async function walk(current, depth) {
    if (out.length >= maxFiles) return
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (out.length >= maxFiles) return
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (recursive && depth < 6 && !entry.name.startsWith('.')) await walk(full, depth + 1)
      } else if (exts.has(extname(entry.name).toLowerCase())) {
        out.push(full)
      }
    }
  }
  await walk(resolve(dir), 0)
  return out
}

/** 预检（不写盘）—— 供 UI 在转换前展示 */
export async function previewConversion(req) {
  const { inputPath, toFormat, options = {} } = req
  const { project: srcProject, formatId, format: srcFmt, validationIssues } = await readProjectFromFile(inputPath, { format: req.fromFormat })
  const dstFmt = await loadFormat(toFormat)
  const findings = preflight(srcProject, dstFmt)
  const { project, logs } = await applyTransforms(srcProject, options)
  const before = analyzeProject(srcProject)
  const after = analyzeProject(project)
  return {
    input: { path: inputPath, name: basename(inputPath), format: formatId, formatName: srcFmt.name },
    target: { format: toFormat, name: dstFmt.name },
    before: before.stats,
    after: after.stats,
    findings,
    logs,
    validationIssues,
    sourceFidelity: srcFmt.fidelity,
    targetFidelity: dstFmt.fidelity,
  }
}

export default {
  convertFile,
  convertBatch,
  previewConversion,
  readProjectFromFile,
  preflight,
  analyzeProject,
  collectProjectFiles,
  applyNameTemplate,
  CAPABILITY_LABELS,
}
