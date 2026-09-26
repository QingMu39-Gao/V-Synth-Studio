/**
 * 音频工具（依赖外部 ffmpeg，不随程序分发）
 *
 * 提供翻调工作流里高频用到的本地音频处理：
 *  格式转换（含导出 WAV）、从视频提取音频、变调、变速、裁剪、响度标准化。
 * ffmpeg 缺失时所有函数都会抛出带引导的中文错误。
 */

import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { mkdir, rm, readdir, rename } from 'node:fs/promises'
import { join, dirname, extname } from 'node:path'
import { runCapture, TOOLS_DIR } from '../net/ytdlp.mjs'
import { downloadToFile } from '../net/download.mjs'

const WIN = process.platform === 'win32'

/** 音频输出格式 → ffmpeg 参数 */
export const AUDIO_FORMATS = {
  wav: { label: 'WAV 无损（推荐用于继续编辑）', ext: '.wav', args: ['-c:a', 'pcm_s16le'], lossless: true },
  wav24: { label: 'WAV 24bit 无损', ext: '.wav', args: ['-c:a', 'pcm_s24le'], lossless: true },
  flac: { label: 'FLAC 无损压缩', ext: '.flac', args: ['-c:a', 'flac'], lossless: true },
  mp3: { label: 'MP3（320kbps）', ext: '.mp3', args: ['-c:a', 'libmp3lame', '-b:a', '320k'], lossless: false },
  m4a: { label: 'M4A / AAC（256kbps）', ext: '.m4a', args: ['-c:a', 'aac', '-b:a', '256k'], lossless: false },
  ogg: { label: 'OGG Vorbis（192kbps）', ext: '.ogg', args: ['-c:a', 'libvorbis', '-b:a', '192k'], lossless: false },
  opus: { label: 'Opus（192kbps，体积小）', ext: '.opus', args: ['-c:a', 'libopus', '-b:a', '192k'], lossless: false },
}

let ffmpegCache = { at: 0, path: null }

/** 查找 ffmpeg（程序目录优先，其次 PATH） */
export async function findFfmpeg(force = false) {
  if (!force && ffmpegCache.path && Date.now() - ffmpegCache.at < 60000) return ffmpegCache.path
  const candidates = [
    join(TOOLS_DIR, 'ffmpeg', 'bin', WIN ? 'ffmpeg.exe' : 'ffmpeg'),
    join(TOOLS_DIR, WIN ? 'ffmpeg.exe' : 'ffmpeg'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) {
      ffmpegCache = { at: Date.now(), path: p }
      return p
    }
  }
  const r = await runCapture(WIN ? 'where' : 'which', [WIN ? 'ffmpeg.exe' : 'ffmpeg']).catch(() => null)
  if (r?.code === 0) {
    const first = r.stdout.split(/\r?\n/).find((l) => l.trim())
    if (first && existsSync(first.trim())) {
      ffmpegCache = { at: Date.now(), path: first.trim() }
      return first.trim()
    }
  }
  ffmpegCache = { at: Date.now(), path: null }
  return null
}

async function requireFfmpeg() {
  const p = await findFfmpeg()
  if (!p) {
    const err = new Error('未找到 ffmpeg。音频工具需要它：请在「设置 → 外部工具」一键获取，或自行安装后把 ffmpeg.exe 放入 tools 目录。')
    err.code = 'NO_FFMPEG'
    throw err
  }
  return p
}

/** ffprobe 路径（与 ffmpeg 同目录） */
function ffprobePath(ffmpeg) {
  const dir = dirname(ffmpeg)
  const candidate = join(dir, WIN ? 'ffprobe.exe' : 'ffprobe')
  return existsSync(candidate) ? candidate : null
}

/* ------------------------------------------------------------ 基础执行 */

/**
 * 运行 ffmpeg，解析进度
 * @param {string[]} args
 * @param {{durationSec?:number, onProgress?:Function, signal?:AbortSignal}} opts
 */
export function runFfmpeg(args, opts = {}) {
  return new Promise(async (resolve, reject) => {
    let bin
    try {
      bin = await requireFfmpeg()
    } catch (err) {
      reject(err)
      return
    }
    const child = spawn(bin, ['-hide_banner', '-y', ...args], { windowsHide: true })
    let stderr = ''
    child.stderr.on('data', (d) => {
      const text = d.toString('utf8')
      stderr = (stderr + text).slice(-20000)
      if (opts.durationSec && opts.onProgress) {
        const m = text.match(/time=(\d+):(\d+):(\d+\.\d+)/)
        if (m) {
          const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
          opts.onProgress({ percent: Math.min(99, (sec / opts.durationSec) * 100), seconds: sec })
        }
      }
    })
    child.on('error', (err) => reject(new Error(`无法启动 ffmpeg：${err.message}`)))
    child.on('close', (code) => {
      if (code === 0) resolve({ ok: true })
      else reject(new Error(`ffmpeg 执行失败（退出码 ${code}）：${stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(' | ').slice(0, 500)}`))
    })
    if (opts.signal) {
      opts.signal.addEventListener('abort', () => {
        try {
          child.kill()
        } catch {
          /* ignore */
        }
        reject(Object.assign(new Error('已取消'), { name: 'AbortError' }))
      })
    }
  })
}

/** 读取媒体信息 */
export async function probeMedia(input) {
  const ffmpeg = await findFfmpeg()
  if (!ffmpeg) return { available: false }
  const ffprobe = ffprobePath(ffmpeg)
  if (!ffprobe) return { available: true, probed: false, note: '缺少 ffprobe，无法读取详细媒体信息' }
  const r = await runCapture(ffprobe, ['-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams', input]).catch(() => null)
  if (!r || r.code !== 0) return { available: true, probed: false, note: '读取媒体信息失败' }
  try {
    const info = JSON.parse(r.stdout)
    const audio = (info.streams ?? []).find((s) => s.codec_type === 'audio')
    const video = (info.streams ?? []).find((s) => s.codec_type === 'video')
    return {
      available: true,
      probed: true,
      durationSec: Number(info.format?.duration ?? 0),
      sizeBytes: Number(info.format?.size ?? 0),
      bitrate: Number(info.format?.bit_rate ?? 0),
      formatName: info.format?.format_name ?? '',
      audio: audio
        ? { codec: audio.codec_name, sampleRate: Number(audio.sample_rate), channels: audio.channels, bitrate: Number(audio.bit_rate ?? 0) }
        : null,
      video: video ? { codec: video.codec_name, width: video.width, height: video.height, fps: video.r_frame_rate } : null,
    }
  } catch {
    return { available: true, probed: false, note: '解析媒体信息失败' }
  }
}

/* ------------------------------------------------------------ 具体操作 */

/**
 * 转换音频格式（导出 WAV / MP3 / FLAC ...）
 */
export async function convertAudio(req) {
  const { input, output, format = 'wav', sampleRate, channels, onProgress, signal } = req
  if (!existsSync(input)) throw new Error(`找不到输入文件：${input}`)
  const preset = AUDIO_FORMATS[format]
  if (!preset) throw new Error(`不支持的输出格式：${format}`)
  const info = await probeMedia(input)
  await mkdir(dirname(output), { recursive: true })
  const args = ['-i', input, '-vn', ...preset.args]
  if (sampleRate) args.push('-ar', String(sampleRate))
  if (channels) args.push('-ac', String(channels))
  args.push(output)
  await runFfmpeg(args, { durationSec: info.durationSec, onProgress, signal })
  return { output, format, info }
}

/** 从视频中提取音频（保存 MV 的音轨） */
export async function extractAudio(req) {
  const { input, output, format = 'wav', onProgress, signal } = req
  return convertAudio({ input, output, format, onProgress, signal })
}

/**
 * 变调（保持时长）：asetrate + aresample + atempo
 * @param {number} semitones 半音数，±12 内精度最好
 */
export async function shiftPitch(req) {
  const { input, output, semitones = 0, onProgress, signal } = req
  if (!existsSync(input)) throw new Error(`找不到输入文件：${input}`)
  if (!semitones) throw new Error('变调量不能为 0')
  const info = await probeMedia(input)
  const sr = info.audio?.sampleRate || 44100
  const ratio = Math.pow(2, semitones / 12)
  const filters = `asetrate=${Math.round(sr * ratio)},aresample=${sr},atempo=${(1 / ratio).toFixed(6)}`
  await mkdir(dirname(output), { recursive: true })
  await runFfmpeg(['-i', input, '-vn', '-filter:a', filters, output], { durationSec: info.durationSec, onProgress, signal })
  return { output, semitones, ratio }
}

/** 变速（保持音高） */
export async function changeTempo(req) {
  const { input, output, ratio = 1, onProgress, signal } = req
  if (!existsSync(input)) throw new Error(`找不到输入文件：${input}`)
  if (!(ratio > 0)) throw new Error('速度比例不合法')
  const info = await probeMedia(input)
  // atempo 单次只支持 0.5~2.0，超出需要串联
  const chain = []
  let remaining = ratio
  while (remaining > 2) {
    chain.push('atempo=2')
    remaining /= 2
  }
  while (remaining < 0.5) {
    chain.push('atempo=0.5')
    remaining /= 0.5
  }
  chain.push(`atempo=${remaining.toFixed(6)}`)
  await mkdir(dirname(output), { recursive: true })
  await runFfmpeg(['-i', input, '-vn', '-filter:a', chain.join(','), output], { durationSec: info.durationSec, onProgress, signal })
  return { output, ratio }
}

/** 裁剪片段 */
export async function trimAudio(req) {
  const { input, output, startSec = 0, endSec, onProgress, signal } = req
  if (!existsSync(input)) throw new Error(`找不到输入文件：${input}`)
  const args = ['-i', input]
  if (startSec) args.push('-ss', String(startSec))
  if (endSec) args.push('-to', String(endSec))
  args.push('-vn', '-c:a', 'pcm_s16le', output)
  await mkdir(dirname(output), { recursive: true })
  await runFfmpeg(args, { durationSec: (endSec ?? 0) - startSec, onProgress, signal })
  return { output, startSec, endSec }
}

/** 响度标准化（把伴奏/干声拉到统一响度，方便对轨） */
export async function normalizeLoudness(req) {
  const { input, output, targetLufs = -14, onProgress, signal } = req
  if (!existsSync(input)) throw new Error(`找不到输入文件：${input}`)
  const info = await probeMedia(input)
  await mkdir(dirname(output), { recursive: true })
  await runFfmpeg(['-i', input, '-vn', '-filter:a', `loudnorm=I=${targetLufs}:TP=-1.5:LRA=11`, '-c:a', 'pcm_s16le', output], {
    durationSec: info.durationSec,
    onProgress,
    signal,
  })
  return { output, targetLufs }
}

/** 拼接多个音频（例如把多段和声合起来） */
export async function concatAudio(req) {
  const { inputs = [], output, signal } = req
  if (inputs.length < 2) throw new Error('至少需要两个输入文件')
  for (const f of inputs) if (!existsSync(f)) throw new Error(`找不到输入文件：${f}`)
  const listPath = join(dirname(output), `concat-${Date.now()}.txt`)
  const { writeFile, rm: rmf } = await import('node:fs/promises')
  await writeFile(listPath, inputs.map((f) => `file '${f.replace(/'/g, "'\\''")}'`).join('\n'), 'utf8')
  try {
    await runFfmpeg(['-f', 'concat', '-safe', '0', '-i', listPath, '-c:a', 'pcm_s16le', output], { signal })
  } finally {
    await rmf(listPath).catch(() => {})
  }
  return { output, count: inputs.length }
}

/* ------------------------------------------------------- ffmpeg 安装 */

/*
 * ffmpeg 下载源。gyan.dev 在国内通常可直连（实测可达），
 * BtbN 走 GitHub，所以额外挂几个国内加速镜像 —— 国内直连 GitHub 经常失败。
 */
const FFMPEG_URLS = [
  'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip',
  'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
  'https://ghproxy.net/https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
  'https://gh-proxy.com/https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip',
]

/**
 * 一键获取 ffmpeg 到 tools/ 目录（约 40-80MB）
 * 仅下载官方/知名构建，解压后只保留 bin 目录。
 */
export async function installFfmpeg(onProgress) {
  if (!WIN) throw new Error('一键获取目前仅支持 Windows，请用系统包管理器安装 ffmpeg')
  await mkdir(TOOLS_DIR, { recursive: true })
  const zipPath = join(TOOLS_DIR, 'ffmpeg-download.zip')

  /*
   * 已经下好完整压缩包就直接复用。
   * 真实场景里很常见：下载到 90% 时用户关了程序，下次再点「一键获取」不该从头再下 100MB。
   * 判据：文件存在且大于 20MB（ffmpeg essentials 构建约 100MB，残缺文件不可能这么大）。
   */
  let haveZip = existsSync(zipPath) && statSync(zipPath).size > 20 * 1024 * 1024
  let lastError
  if (haveZip) {
    onProgress?.({ percent: 80, message: '发现已下载的压缩包，直接解压…' })
  } else {
    for (const url of FFMPEG_URLS) {
      try {
        onProgress?.({ percent: 0, message: `正在从 ${new URL(url).host} 下载…` })
        await downloadToFile(url, zipPath, {
          threads: 4,
          onProgress: (p) => onProgress?.({ percent: p.percent * 0.8, message: `下载中 ${p.percent.toFixed(1)}%` }),
        })
        haveZip = true
        break
      } catch (err) {
        lastError = err
      }
    }
  }
  if (!haveZip || !existsSync(zipPath)) {
    throw new Error(
      `下载 ffmpeg 失败（已尝试 ${FFMPEG_URLS.length} 个源，含国内加速镜像）：${lastError?.message ?? '未知错误'}` +
      `。可手动下载 ffmpeg-release-essentials.zip 放到 tools 目录后重试，或直接解压出 bin 文件夹放到 tools/ffmpeg/bin。`
    )
  }

  onProgress?.({ percent: 82, message: '解压中…' })
  const extractDir = join(TOOLS_DIR, 'ffmpeg-extract')
  await rm(extractDir, { recursive: true, force: true }).catch(() => {})
  await mkdir(extractDir, { recursive: true })

  // Windows 自带 tar 可解压 zip；失败再退回 PowerShell Expand-Archive
  let extracted = await runCapture('tar', ['-xf', zipPath, '-C', extractDir]).catch(() => null)
  if (!extracted || extracted.code !== 0) {
    extracted = await runCapture('powershell', [
      '-NoProfile', '-Command',
      `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force`,
    ]).catch(() => null)
  }
  if (!extracted || extracted.code !== 0) {
    throw new Error(`解压 ffmpeg 失败：${(extracted?.stderr ?? '').slice(0, 300)}`)
  }

  // 找到 bin/ffmpeg.exe 并搬到 tools/ffmpeg/bin
  const binDir = await findDirContaining(extractDir, 'ffmpeg.exe', 3)
  if (!binDir) throw new Error('解压后未找到 ffmpeg.exe')
  const target = join(TOOLS_DIR, 'ffmpeg')
  await rm(target, { recursive: true, force: true }).catch(() => {})
  await rename(binDir, join(target, 'bin'))
  await rm(extractDir, { recursive: true, force: true }).catch(() => {})
  await rm(zipPath, { force: true }).catch(() => {})

  ffmpegCache = { at: 0, path: null }
  const ffmpeg = await findFfmpeg(true)
  onProgress?.({ percent: 100, message: '安装完成' })
  return { ok: true, path: ffmpeg }
}

async function findDirContaining(root, filename, maxDepth) {
  const queue = [{ path: root, depth: 0 }]
  while (queue.length) {
    const { path: cur, depth } = queue.shift()
    let entries
    try {
      entries = await readdir(cur, { withFileTypes: true })
    } catch {
      continue
    }
    if (entries.some((e) => e.isFile() && e.name.toLowerCase() === filename.toLowerCase())) return cur
    if (depth < maxDepth) {
      for (const e of entries) if (e.isDirectory()) queue.push({ path: join(cur, e.name), depth: depth + 1 })
    }
  }
  return null
}

export default {
  findFfmpeg,
  probeMedia,
  convertAudio,
  extractAudio,
  shiftPitch,
  changeTempo,
  trimAudio,
  normalizeLoudness,
  concatAudio,
  installFfmpeg,
  AUDIO_FORMATS,
  runFfmpeg,
}
