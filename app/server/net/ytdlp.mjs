/**
 * yt-dlp 桥接
 *
 * 用途：YouTube 以及 yt-dlp 支持的上千个站点（含部分国内平台）的解析与下载。
 * 本模块不内置 yt-dlp，也不修改系统环境：只在程序目录 `tools/` 或 PATH 中查找，
 * 找不到时提供「一键获取」到 tools/ 目录（用户可选择）。
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { downloadToFile } from './download.mjs'
import { fetchJson } from './http.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
export const TOOLS_DIR = join(__dirname, '..', '..', '..', 'tools')

const WIN = process.platform === 'win32'
export const YTDLP_EXE = WIN ? 'yt-dlp.exe' : 'yt-dlp'

/** 查找可用的 yt-dlp */
export async function findYtDlp() {
  await mkdir(TOOLS_DIR, { recursive: true })
  const local = join(TOOLS_DIR, YTDLP_EXE)
  if (existsSync(local)) return { kind: 'binary', path: local, source: '程序目录' }

  // PATH
  const which = await runCapture(WIN ? 'where' : 'which', [YTDLP_EXE]).catch(() => null)
  if (which?.code === 0) {
    const first = which.stdout.split(/\r?\n/).find((l) => l.trim())
    if (first && existsSync(first.trim())) return { kind: 'binary', path: first.trim(), source: '系统 PATH' }
  }
  // python -m yt_dlp
  const py = await runCapture(WIN ? 'python' : 'python3', ['-m', 'yt_dlp', '--version']).catch(() => null)
  if (py?.code === 0) return { kind: 'python', path: WIN ? 'python' : 'python3', source: 'Python 模块' }

  return null
}

/** 版本号 */
export async function getVersion(found) {
  const f = found ?? (await findYtDlp())
  if (!f) return null
  const args = f.kind === 'python' ? ['-m', 'yt_dlp', '--version'] : ['--version']
  const r = await runCapture(f.path, args).catch(() => null)
  return r?.code === 0 ? r.stdout.trim() : null
}

/**
 * 一键获取 yt-dlp 到 tools/ 目录
 * @param {(p:{percent:number,received:number,total:number,speed:number})=>void} onProgress
 */
export async function installYtDlp(onProgress) {
  await mkdir(TOOLS_DIR, { recursive: true })
  const dest = join(TOOLS_DIR, YTDLP_EXE)
  const gh = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download'
  /*
   * 国内直连 GitHub 经常失败，所以按「直连 → 国内可用的 GitHub 加速镜像」顺序重试。
   * 这些镜像都实测可达；将来某个失效也不要紧，会自动跳到下一个继续试。
   */
  const mirrors = [
    `${gh}/${YTDLP_EXE}`,
    `https://ghproxy.net/${gh}/${YTDLP_EXE}`,
    `https://gh-proxy.com/${gh}/${YTDLP_EXE}`,
    `https://ghfast.top/${gh}/${YTDLP_EXE}`,
    `https://mirror.ghproxy.com/${gh}/${YTDLP_EXE}`,
  ]
  let lastError
  for (const u of mirrors) {
    try {
      onProgress?.({ percent: 0, received: 0, total: 0, speed: 0 })
      const r = await downloadToFile(u, dest, {
        onProgress: (p) => onProgress?.({ percent: p.percent, received: p.received, total: p.total, speed: p.speed }),
        threads: 4,
      })
      return { ok: true, path: dest, bytes: r.bytes, from: u }
    } catch (err) {
      lastError = err
    }
  }
  throw new Error(
    `下载 yt-dlp 失败（已尝试 ${mirrors.length} 个源，含 GitHub 直连与国内加速镜像）：${lastError?.message ?? '未知错误'}。` +
    `可手动从 github.com/yt-dlp/yt-dlp/releases 下载 ${YTDLP_EXE} 放入 tools 目录。`
  )
}

/* ------------------------------------------------------------ 进程封装 */

/**
 * 运行并捕获输出
 * @returns {Promise<{code:number, stdout:string, stderr:string}>}
 */
export function runCapture(cmd, args, opts = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', ...(opts.env ?? {}) },
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += d.toString('utf8')
    })
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8')
    })
    child.on('error', (err) => reject(new Error(`无法启动 ${cmd}：${err.message}`)))
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }))
    if (opts.timeout) {
      setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* ignore */
        }
      }, opts.timeout)
    }
  })
}

function baseArgs(found, opts = {}) {
  const args = found.kind === 'python' ? ['-m', 'yt_dlp'] : []
  args.push('--no-warnings', '--no-playlist', '--newline')
  if (opts.proxy) args.push('--proxy', opts.proxy)
  if (opts.cookiesFromBrowser) args.push('--cookies-from-browser', opts.cookiesFromBrowser)
  if (opts.cookiesFile) args.push('--cookies', opts.cookiesFile)
  if (opts.forceIpv4) args.push('-4')
  return args
}

/* ------------------------------------------------------------ 解析信息 */

/**
 * 解析链接，返回元信息与可选格式
 * @param {string} url
 * @param {{proxy?:string, cookiesFromBrowser?:string, cookiesFile?:string}} opts
 */
export async function inspect(url, opts = {}) {
  const found = await findYtDlp()
  if (!found) throw new Error('未找到 yt-dlp。请在「设置 → 外部工具」中一键获取，或手动放置 yt-dlp.exe 到 tools 目录。')
  const args = [...baseArgs(found, opts), '-J', '--no-progress', url]
  const r = await runCapture(found.path, args, { timeout: 120000 })
  if (r.code !== 0) {
    throw new Error(cleanYtDlpError(r.stderr || r.stdout))
  }
  let info
  try {
    info = JSON.parse(r.stdout)
  } catch {
    throw new Error('yt-dlp 返回内容无法解析，可能是该站点暂不受支持。')
  }
  return { engine: 'yt-dlp', enginePath: found.path, ...normalizeInfo(info) }
}

function normalizeInfo(info) {
  const formats = (info.formats ?? [])
    .filter((f) => f.url || f.format_id)
    .map((f) => ({
      formatId: f.format_id,
      ext: f.ext,
      note: f.format_note ?? '',
      resolution: f.width && f.height ? `${f.width}x${f.height}` : f.resolution ?? 'audio only',
      height: f.height ?? 0,
      fps: f.fps ?? 0,
      vcodec: f.vcodec ?? 'none',
      acodec: f.acodec ?? 'none',
      filesize: f.filesize ?? f.filesize_approx ?? 0,
      tbr: f.tbr ?? 0,
      isVideo: (f.vcodec ?? 'none') !== 'none',
      isAudio: (f.acodec ?? 'none') !== 'none',
      hasAudio: (f.acodec ?? 'none') !== 'none',
      hasVideo: (f.vcodec ?? 'none') !== 'none',
    }))
    .sort((a, b) => b.height - a.height || b.tbr - a.tbr)

  return {
    id: info.id,
    title: info.title ?? '',
    uploader: info.uploader ?? info.channel ?? '',
    durationSec: info.duration ?? 0,
    thumbnail: info.thumbnail ?? '',
    description: (info.description ?? '').slice(0, 500),
    webpageUrl: info.webpage_url ?? '',
    extractor: info.extractor_key ?? info.extractor ?? '',
    uploadDate: info.upload_date ?? '',
    viewCount: info.view_count ?? 0,
    formats,
    subtitles: Object.keys(info.subtitles ?? {}),
  }
}

function cleanYtDlpError(text) {
  const lines = String(text).split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('[debug]'))
  const errLine = lines.find((l) => /^ERROR/i.test(l)) ?? lines[lines.length - 1] ?? '未知错误'
  return `yt-dlp 失败：${errLine.replace(/^ERROR:\s*/i, '').slice(0, 400)}`
}

/* ------------------------------------------------------------ 下载 */

/**
 * 使用 yt-dlp 下载
 * @param {string} url
 * @param {object} opts
 * @param {string} opts.outDir
 * @param {string} [opts.outName] 不含扩展名的输出名
 * @param {string} [opts.formatId] yt-dlp 的 -f 表达式；缺省 bestvideo+bestaudio
 * @param {'video'|'audio'} [opts.mode]
 * @param {'mp4'|'mkv'|'mp3'|'wav'|'flac'|'m4a'} [opts.convertTo]
 * @param {boolean} [opts.embedSubs] 下载并内嵌字幕
 * @param {(p:{percent:number,speed:string,eta:string,stage:string,line:string})=>void} [opts.onProgress]
 * @param {AbortSignal} [opts.signal]
 */
export async function download(url, opts = {}) {
  const found = await findYtDlp()
  if (!found) throw new Error('未找到 yt-dlp。请在「设置 → 外部工具」中一键获取。')
  await mkdir(opts.outDir, { recursive: true })

  const args = [...baseArgs(found, opts)]
  args.push('--progress', '--progress-template',
    'download:{"p":"%(progress._percent_str)s","speed":"%(progress._speed_str)s","eta":"%(progress._eta_str)s","dl":"%(progress.downloaded_bytes)s","total":"%(progress.total_bytes_estimate)s"}')

  const outName = opts.outName ? `${opts.outName}.%(ext)s` : '%(title)s.%(ext)s'
  args.push('-o', join(opts.outDir, outName))
  args.push('--print', 'after_move:{"file":"%(filepath)s"}')

  if (opts.mode === 'audio') {
    args.push('-f', opts.formatId ?? 'bestaudio/best')
    if (opts.convertTo) args.push('--extract-audio', '--audio-format', opts.convertTo)
    if (opts.audioQuality) args.push('--audio-quality', String(opts.audioQuality))
  } else {
    args.push('-f', opts.formatId ?? 'bestvideo*+bestaudio/best')
    if (opts.convertTo && opts.convertTo !== 'mkv') args.push('--merge-output-format', opts.convertTo)
    else args.push('--merge-output-format', 'mkv')
  }
  if (opts.embedSubs) args.push('--write-subs', '--write-auto-subs', '--embed-subs', '--sub-langs', opts.subLangs ?? 'zh-Hans,zh-CN,zh,en')
  if (opts.extraArgs?.length) args.push(...opts.extraArgs)
  args.push(url)

  const files = []
  const result = await new Promise((resolve, reject) => {
    const child = spawn(found.path, args, { windowsHide: true, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } })
    let stderr = ''
    let stdoutTail = ''

    const handleLine = (line) => {
      const t = line.trim()
      if (t.startsWith('download:{')) {
        try {
          const o = JSON.parse(t.slice('download:'.length))
          opts.onProgress?.({
            stage: 'download',
            percent: parseFloat(String(o.p).replace('%', '').trim()) || 0,
            speed: o.speed ?? '',
            eta: o.eta ?? '',
            received: Number(o.dl) || 0,
            total: Number(o.total) || 0,
            line: t,
          })
        } catch {
          /* 忽略解析失败 */
        }
        return
      }
      if (t.startsWith('{"file"')) {
        try {
          const o = JSON.parse(t)
          if (o.file) files.push(o.file)
        } catch {
          /* ignore */
        }
        return
      }
      if (t.startsWith('[download]') || t.startsWith('[Merger]') || t.startsWith('[ExtractAudio]') || t.startsWith('[ffmpeg]')) {
        opts.onProgress?.({ stage: 'info', percent: -1, speed: '', eta: '', line: t })
      }
    }

    const onChunk = (buf) => {
      const text = buf.toString('utf8')
      stdoutTail = (stdoutTail + text).slice(-8000)
      for (const line of text.split(/\r?\n|\r/)) handleLine(line)
    }
    child.stdout.on('data', onChunk)
    child.stderr.on('data', (d) => {
      stderr += d.toString('utf8')
    })
    child.on('error', (err) => reject(new Error(`无法启动 yt-dlp：${err.message}`)))
    child.on('close', (code) => {
      if (code === 0) resolve({ files })
      else reject(new Error(cleanYtDlpError(stderr || stdoutTail)))
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

  return { ...result, engine: 'yt-dlp', enginePath: found.path }
}

/** yt-dlp 支持的站点数量（用于界面展示，避免夸大） */
export async function supportedSiteCount() {
  try {
    const found = await findYtDlp()
    if (!found) return null
    const r = await runCapture(found.path, found.kind === 'python' ? ['-m', 'yt_dlp', '--list-extractors'] : ['--list-extractors'], { timeout: 60000 })
    if (r.code !== 0) return null
    return r.stdout.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('[')).length
  } catch {
    return null
  }
}

export default { findYtDlp, getVersion, installYtDlp, inspect, download, runCapture, TOOLS_DIR, YTDLP_EXE, supportedSiteCount }
