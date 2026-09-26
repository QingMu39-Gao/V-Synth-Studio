/**
 * LibreSVIP 转换引擎封装
 *
 *   https://github.com/SoulMelody/LibreSVIP   （MIT License）
 *
 * 工程转换整个交给它，不再自己写格式读写。
 * 它支持 40 种工程格式（VOCALOID 全系、SynthV、ACE Studio、CeVIO、DeepVocal、
 * DiffSinger、UTAU/OpenUtau、TuneLab、VOX Factory、字幕类……），远多于手写实现。
 *
 * 命令行接口（v2.9.0）：
 *   libresvip-cli.exe proj convert {in_path} {out_path}
 *   格式按扩展名自动推断，不需要额外参数。
 *
 * 坑（实测得出，别再踩）：
 *   1. 转换过程中它会问一串导入选项（音高处理方式、导入信息保留模式等）。
 *      命令行下必须把答案从 stdin 喂进去，否则它会 Aborted 退出（退出码 1）。
 *      直接送空行即可 —— 提示里的 (y) / (plain) / (convert) 都是默认值。
 *   2. 这是 PyInstaller 打包的 GUI 程序附带的 CLI，输出编码是 UTF-8，
 *      但 Windows 控制台默认 GBK，外部直接看会乱码。这里统一按 UTF-8 解码。
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, dirname, extname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..', '..', '..')

/** 可能放着 CLI 的位置，按优先级排列 */
const CLI_CANDIDATES = [
  join(ROOT, 'tools', 'libresvip', 'libresvip-cli', 'libresvip-cli.exe'),
  join(ROOT, 'tools', 'libresvip', 'libresvip-cli.exe'),
  join(ROOT, 'tools', 'libresvip-cli', 'libresvip-cli.exe'),
  join(ROOT, 'tools', 'libresvip-cli.exe'),
]

/** 喂给 stdin 的空行数：交互提问目前最多十来个，给足余量 */
const STDIN_BLANKS = 60

let cachedCli = undefined

/** 找 CLI 可执行文件，找不到返回 null */
export function findCli() {
  if (cachedCli !== undefined) return cachedCli
  cachedCli = CLI_CANDIDATES.find((p) => existsSync(p)) ?? null
  return cachedCli
}

export function isAvailable() {
  return findCli() !== null
}

/** CLI 自带的插件目录（里面是各格式的元数据） */
function pluginDirs() {
  const cli = findCli()
  if (!cli) return []
  const base = dirname(cli)
  const dirs = [
    join(base, '_internal', 'libresvip', 'plugins'),
    join(base, 'libresvip', 'plugins'),
  ]
  // 顺带扫一下同级目录，防止打包结构变化
  try {
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory()) dirs.push(join(base, entry.name, 'libresvip', 'plugins'))
    }
  } catch {
    /* ignore */
  }
  return dirs.filter((d) => existsSync(d))
}

/** 解析 .yapsy-plugin（其实就是 INI） */
function parseYapsy(text) {
  const out = {}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][\w]*)\s*=\s*(.*)$/)
    if (m) out[m[1].toLowerCase()] = m[2].trim()
  }
  return out
}

let cachedFormats = null

/**
 * 支持的格式清单，直接读插件元数据（比解析 CLI 的表格输出可靠）。
 * @returns {Array<{id:string,name:string,format:string,author:string,description:string,ext:string[]}>}
 */
export function listFormats() {
  if (cachedFormats) return cachedFormats
  const seen = new Map()

  for (const dir of pluginDirs()) {
    let subs = []
    try {
      subs = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const sub of subs) {
      if (!sub.isDirectory()) continue
      const subPath = join(dir, sub.name)
      let files = []
      try {
        files = readdirSync(subPath).filter((f) => f.endsWith('.yapsy-plugin'))
      } catch {
        continue
      }
      for (const f of files) {
        let meta
        try {
          meta = parseYapsy(readFileSync(join(subPath, f), 'utf8'))
        } catch {
          continue
        }
        // Suffix 可能是逗号/空格分隔的多个扩展名，例如 "acep, acet"、"mid, midi"、"dv; sk"
        const exts = String(meta.suffix ?? sub.name)
          .split(/[,;\s]+/)
          .map((s) => s.replace(/^\./, '').trim().toLowerCase())
          .filter(Boolean)
        if (!exts.length) exts.push(sub.name.toLowerCase())
        const id = exts[0]
        if (seen.has(id)) continue
        seen.set(id, {
          id,
          name: meta.name ?? sub.name,
          format: meta.format ?? '',
          author: meta.author ?? '',
          description: meta.description ?? '',
          website: meta.website ?? '',
          ext: exts,
        })
      }
    }
  }

  cachedFormats = [...seen.values()].sort((a, b) => a.id.localeCompare(b.id))
  return cachedFormats
}

/** 按扩展名找格式（用于「自动识别」） */
export function formatOfFile(filePath) {
  const ext = extname(filePath).replace(/^\./, '').toLowerCase()
  if (!ext) return null
  return listFormats().find((f) => f.ext.some((e) => e.toLowerCase() === ext)) ?? null
}

/**
 * 转换一个工程。
 *
 * @param {string} inPath   源工程
 * @param {string} outPath  目标路径（扩展名决定目标格式）
 * @param {{signal?:AbortSignal, timeoutMs?:number, onLog?:(s:string)=>void}} [opts]
 * @returns {Promise<{ok:boolean, code:number, stdout:string, stderr:string, bytes:number}>}
 */
export function convert(inPath, outPath, opts = {}) {
  const cli = findCli()
  if (!cli) return Promise.reject(new Error('没有找到 LibreSVIP CLI（应该放在 tools\\libresvip\\）'))
  if (!existsSync(inPath)) return Promise.reject(new Error(`源文件不存在：${inPath}`))

  const { signal, timeoutMs = 15 * 60 * 1000, onLog } = opts

  return new Promise((resolve, reject) => {
    const child = spawn(cli, ['proj', 'convert', inPath, outPath], {
      cwd: dirname(cli),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const finish = (fn, arg) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(arg)
    }

    const timer = setTimeout(() => {
      try { child.kill() } catch { /* ignore */ }
      finish(reject, new Error(`转换超时（${Math.round(timeoutMs / 1000)} 秒）：${basename(inPath)}`))
    }, timeoutMs)

    if (signal) {
      signal.addEventListener('abort', () => {
        try { child.kill() } catch { /* ignore */ }
        finish(reject, new Error('已取消'))
      }, { once: true })
    }

    child.stdout.on('data', (d) => {
      const s = d.toString('utf8')
      stdout += s
      onLog?.(s)
    })
    child.stderr.on('data', (d) => {
      const s = d.toString('utf8')
      stderr += s
      onLog?.(s)
    })

    child.on('error', (err) => finish(reject, err))

    child.on('close', (code) => {
      const ok = code === 0 && existsSync(outPath)
      let bytes = 0
      if (ok) {
        try { bytes = statSync(outPath).size } catch { /* ignore */ }
      }
      finish(resolve, { ok, code, stdout, stderr, bytes })
    })

    /*
     * 把导入选项的答案喂进去。
     * 提示里的 (y) / (plain) / (convert) 全是默认值，空行就是接受默认。
     * 不喂的话它会一直等输入，最后 Aborted（退出码 1）—— 实测过。
     */
    try {
      child.stdin.write('\n'.repeat(STDIN_BLANKS))
      child.stdin.end()
    } catch {
      /* 管道断了就随它去，close 事件照样会到 */
    }
  })
}

/**
 * 批量转换。回调形状与原手写引擎一致，这样界面层一行都不用改。
 *
 * @param {object} o
 * @param {string[]} o.inputs
 * @param {string} o.toFormat   目标格式 id（如 'vpr'）
 * @param {string} o.outDir
 * @param {string} [o.nameTemplate]
 * @param {boolean} [o.overwrite]
 * @param {(p:object)=>void} [o.onProgress]
 * @param {AbortSignal} [o.signal]
 */
export async function convertBatch(o) {
  const {
    inputs = [], toFormat, outDir, nameTemplate = '{name}',
    overwrite = false, onProgress, signal,
  } = o

  const fmt = listFormats().find((f) => f.id === toFormat)
  if (!fmt) throw new Error(`LibreSVIP 不支持目标格式「${toFormat}」`)
  const ext = fmt.ext[0]

  const written = []
  const failed = []
  const results = []
  const total = inputs.length

  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i]
    const index = i + 1
    onProgress?.({ phase: 'start', index, total, input })

    try {
      const srcExt = extname(input).replace(/^\./, '').toLowerCase()
      if (srcExt === ext.toLowerCase()) {
        // 同格式转换没有意义，而且 LibreSVIP 会提示冲突
        const result = {
          outputs: [], findings: [{ level: 'warn', message: `源文件已经是 .${ext} 格式，跳过` }], logs: [],
        }
        results.push({ ok: true, input, skipped: true, outputs: [] })
        onProgress?.({ phase: 'done', index, total, input, result })
        continue
      }

      const outPath = uniquePath(join(outDir, `${baseNameOf(input, nameTemplate)}.${ext}`), overwrite)

      const r = await convert(input, outPath, { signal })

      if (!r.ok) {
        const detail = cleanOutput(r.stderr || r.stdout).slice(0, 300)
        throw new Error(`LibreSVIP 退出码 ${r.code}${detail ? `：${detail}` : ''}`)
      }

      const item = { path: outPath, name: basename(outPath), bytes: r.bytes, notes: null }
      written.push(item)
      results.push({ ok: true, input, outputs: [item] })
      onProgress?.({
        phase: 'done', index, total, input,
        result: { outputs: [item], findings: [], logs: [] },
      })
    } catch (err) {
      failed.push({ input, error: err.message })
      results.push({ ok: false, input, error: err.message })
      onProgress?.({ phase: 'error', index, total, input, error: err.message })
    }
  }

  return {
    results,
    summary: { ok: results.filter((r) => r.ok).length, failed: failed.length, total, written: written.length },
    written,
    failed,
    engine: 'LibreSVIP',
  }
}

/** 去掉 CLI 输出里的 ANSI 控制字符，方便直接显示在界面日志里 */
function cleanOutput(s) {
  return String(s ?? '')
    .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim()
}

/** 目标文件名：{name} 会被替换成源文件名（不含扩展名） */
function baseNameOf(input, template) {
  const base = basename(input, extname(input))
  return String(template || '{name}').replace(/\{name\}/g, base) || base
}

/** 不覆盖时自动加序号 */
function uniquePath(p, overwrite) {
  if (overwrite || !existsSync(p)) return p
  const dir = dirname(p)
  const ext = extname(p)
  const stem = basename(p, ext)
  for (let n = 2; n < 1000; n++) {
    const cand = join(dir, `${stem} (${n})${ext}`)
    if (!existsSync(cand)) return cand
  }
  return p
}

export default { findCli, isAvailable, listFormats, formatOfFile, convert, convertBatch }
