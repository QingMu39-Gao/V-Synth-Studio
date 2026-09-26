/**
 * 本机编辑器 / 外部工具 检测与启动
 *
 * 设计原则：
 *  - 只检测与启动，绝不修改这些软件的任何文件
 *  - 结果带缓存（TTL 5 分钟），避免每次切页面都全盘扫描
 *  - 扫不到就如实报告「未检测到」，不猜测
 */

import { spawn } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runCapture, findYtDlp, getVersion as getYtDlpVersion, TOOLS_DIR } from '../net/ytdlp.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WORKSTATION_ROOT = join(__dirname, '..', '..', '..')

const WIN = process.platform === 'win32'
const PROGRAM_FILES = [process.env['ProgramFiles'], process.env['ProgramFiles(x86)'], process.env['LOCALAPPDATA']].filter(Boolean)

/**
 * 已知编辑器/工具候选。
 * paths：优先直接命中的绝对路径
 * scanDirs：找不到时在这些目录里按 exeName 递归搜索（限深度）
 */
const CANDIDATES = [
  {
    id: 'vocaloid6', name: 'VOCALOID6', vendor: 'Yamaha', category: 'editor',
    formats: ['vpr', 'vsqx'], color: '#00b3e3',
    paths: [
      'H:\\VOCALOID6\\Editor\\VOCALOID6.exe',
      'D:\\VOCALOID6\\Editor\\VOCALOID6.exe',
      'C:\\Program Files\\VOCALOID6\\Editor\\VOCALOID6.exe',
      'C:\\Program Files (x86)\\VOCALOID6\\Editor\\VOCALOID6.exe',
    ],
    scanDirs: ['H:\\VOCALOID6', 'D:\\VOCALOID6', 'C:\\Program Files\\VOCALOID6'],
    exePattern: /^VOCALOID6\.exe$/i,
  },
  {
    id: 'vocaloid5', name: 'VOCALOID5', vendor: 'Yamaha', category: 'editor',
    formats: ['vpr', 'vsqx'], color: '#00b3e3',
    paths: ['C:\\Program Files\\VOCALOID5\\Editor\\VOCALOID5.exe', 'D:\\VOCALOID5\\Editor\\VOCALOID5.exe'],
    scanDirs: ['C:\\Program Files\\VOCALOID5', 'D:\\VOCALOID5'],
    exePattern: /^VOCALOID5\.exe$/i,
  },
  {
    id: 'synthv2', name: 'Synthesizer V Studio 2 Pro', vendor: 'Dreamtonics', category: 'editor',
    formats: ['svp'], color: '#f5a623',
    paths: [
      'H:\\Synthesizer V Studio 2 Pro\\synthv-studio.exe',
      'D:\\Synthesizer V Studio 2 Pro\\synthv-studio.exe',
      'C:\\Program Files\\Synthesizer V Studio 2 Pro\\synthv-studio.exe',
    ],
    scanDirs: ['H:\\Synthesizer V Studio 2 Pro', 'D:\\Synthesizer V Studio 2 Pro', 'C:\\Program Files\\Synthesizer V Studio 2 Pro'],
    exePattern: /^synthv-studio\.exe$/i,
  },
  {
    id: 'synthv1', name: 'Synthesizer V Studio', vendor: 'Dreamtonics', category: 'editor',
    formats: ['svp'], color: '#f5a623',
    paths: ['C:\\Program Files\\Synthesizer V Studio\\synthv-studio.exe', 'D:\\Synthesizer V Studio\\synthv-studio.exe'],
    scanDirs: ['C:\\Program Files\\Synthesizer V Studio'],
    exePattern: /^synthv-studio\.exe$/i,
  },
  {
    id: 'cevio', name: 'CeVIO AI / CS', vendor: 'CeVIO', category: 'editor',
    formats: ['ccs'], color: '#e6007e',
    paths: ['H:\\cevio\\CeVIO AI.exe', 'C:\\Program Files\\CeVIO\\CeVIO AI.exe', 'C:\\Program Files (x86)\\CeVIO\\CeVIO Creative Studio.exe'],
    scanDirs: ['H:\\cevio', 'C:\\Program Files\\CeVIO', 'C:\\Program Files (x86)\\CeVIO'],
    exePattern: /^CeVIO (AI|Creative Studio)\.exe$/i,
  },
  {
    id: 'openutau', name: 'OpenUtau', vendor: 'OpenUtau', category: 'editor',
    formats: ['ustx', 'ust'], color: '#7c5cff',
    paths: ['H:\\OpenUtau\\OpenUtau.exe', 'C:\\Program Files\\OpenUtau\\OpenUtau.exe'],
    scanDirs: ['H:\\OpenUtau', 'C:\\Program Files\\OpenUtau', join(process.env.LOCALAPPDATA ?? '', 'OpenUtau')],
    exePattern: /^OpenUtau\.exe$/i,
  },
  {
    id: 'utau', name: 'UTAU', vendor: '飴屋／菖蒲', category: 'editor',
    formats: ['ust'], color: '#4caf50',
    paths: ['C:\\Program Files (x86)\\UTAU\\UTAU.exe', 'C:\\UTAU\\UTAU.exe', 'D:\\UTAU\\UTAU.exe'],
    scanDirs: ['C:\\Program Files (x86)\\UTAU', 'C:\\UTAU', 'D:\\UTAU'],
    exePattern: /^UTAU\.exe$/i,
  },
  {
    id: 'acestudio', name: 'ACE Studio', vendor: 'ACE Studio', category: 'editor',
    formats: ['acep'], color: '#ff5c8a',
    paths: ['C:\\Program Files\\ACE Studio\\ACE Studio.exe', 'D:\\ACE Studio\\ACE Studio.exe'],
    scanDirs: ['C:\\Program Files\\ACE Studio', 'D:\\ACE Studio'],
    exePattern: /^ACE ?Studio\.exe$/i,
  },
  {
    id: 'deepvocal', name: 'DeepVocal', vendor: 'DeepVocal', category: 'editor',
    formats: ['dv'], color: '#00c2a8',
    paths: ['C:\\Program Files\\DeepVocal\\DeepVocal.exe', 'D:\\DeepVocal\\DeepVocal.exe'],
    scanDirs: ['C:\\Program Files\\DeepVocal', 'D:\\DeepVocal'],
    exePattern: /^DeepVocal\.exe$/i,
  },
  {
    id: 'voicevox', name: 'VOICEVOX', vendor: 'Hiroshiba', category: 'editor',
    formats: [], color: '#39c5bb',
    paths: ['C:\\Program Files\\VOICEVOX\\VOICEVOX.exe', 'D:\\VOICEVOX\\VOICEVOX.exe', join(process.env.LOCALAPPDATA ?? '', 'Programs', 'VOICEVOX', 'VOICEVOX.exe')],
    scanDirs: ['C:\\Program Files\\VOICEVOX', join(process.env.LOCALAPPDATA ?? '', 'Programs', 'VOICEVOX')],
    exePattern: /^VOICEVOX\.exe$/i,
  },
  {
    id: 'uvr', name: 'Ultimate Vocal Remover (离线人声分离)', vendor: '社区', category: 'tool',
    formats: [], color: '#00d1b2',
    paths: [
      'H:\\ChiXiaoYangUVR5\\UVR.exe',
      'H:\\ChiXiaoYangUVR5\\Start.exe',
      'C:\\Program Files\\Ultimate Vocal Remover\\UVR.exe',
    ],
    scanDirs: ['H:\\ChiXiaoYangUVR5', 'C:\\Program Files\\Ultimate Vocal Remover'],
    exePattern: /^(UVR|Start|Ultimate Vocal Remover)\.exe$/i,
  },
  {
    id: 'vlabeler', name: 'vLabeler（原音设定标注）', vendor: 'sdercolin', category: 'tool',
    formats: [], color: '#9c88ff',
    paths: [
      'C:\\Users\\Administrator\\Desktop\\UTAU VOICE\\vlabeler-1.7.0-beta2-win64\\vLabeler.exe',
      join(process.env.USERPROFILE ?? '', 'Desktop', 'UTAU VOICE', 'vlabeler-1.7.0-beta2-win64', 'vLabeler.exe'),
    ],
    scanDirs: [join(process.env.USERPROFILE ?? '', 'Desktop', 'UTAU VOICE')],
    exePattern: /^vlabeler\.exe$/i, scanDepth: 3, scanBudgetMs: 6000,
  },
  {
    id: 'flstudio', name: 'FL Studio', vendor: 'Image-Line', category: 'daw',
    formats: ['midi'], color: '#ff8a00',
    paths: ['C:\\Program Files\\Image-Line\\FL Studio 2024\\FL64.exe', 'C:\\Program Files\\Image-Line\\FL Studio 2025\\FL64.exe'],
    scanDirs: ['C:\\Program Files\\Image-Line', 'D:\\Program Files\\Image-Line', 'H:\\Image-Line'],
    exePattern: /^FL64?\.exe$/i, scanDepth: 3,
  },
  {
    id: 'oremo', name: 'oremo（声库录音工具）', vendor: 'UTAU 生态', category: 'voicebank',
    formats: [], color: '#4caf50',
    paths: [],
    scanDirs: [join(process.env.USERPROFILE ?? '', 'Desktop', 'UTAU VOICE')],
    exePattern: /^oremo\.exe$/i, scanDepth: 2, scanBudgetMs: 6000,
  },
  {
    id: 'recstar', name: 'RecStar（声库录音工具）', vendor: 'UTAU 生态', category: 'voicebank',
    formats: [], color: '#4caf50',
    paths: [],
    scanDirs: [join(process.env.USERPROFILE ?? '', 'Desktop', 'UTAU VOICE')],
    exePattern: /^RecStar\.exe$/i, scanDepth: 2, scanBudgetMs: 6000,
  },
  {
    id: 'textgrid2oto', name: 'TextGrid2oto（自动原音设定）', vendor: 'UTAU 生态', category: 'voicebank',
    formats: [], color: '#4caf50',
    paths: [],
    scanDirs: [join(process.env.USERPROFILE ?? '', 'Desktop', 'UTAU VOICE')],
    exePattern: /^TextGrid2oto\.exe$/i, scanDepth: 2, scanBudgetMs: 6000,
  },
]

/* ------------------------------------------------------------ 扫描工具 */

/**
 * 目录扫描（广度优先）
 * 有严格时间预算与条目上限：宁可漏报，也绝不能把界面卡死。
 */
function scanForExe(dir, pattern, depth = 2, maxEntries = 12000, budgetMs = 1500) {
  if (!dir || !existsSync(dir)) return null
  const deadline = Date.now() + budgetMs
  let visited = 0
  const queue = [{ path: dir, depth: 0 }]
  // 这些目录名基本可以断定不含可执行文件，跳过以免把预算耗光
  const SKIP_DIR = /(\.caches?$|^cache|UCache|node_modules|^\$RECYCLE|System Volume Information|\.git$|sample-info|_internal$)/i
  while (queue.length) {
    if (Date.now() > deadline || visited > maxEntries) return null
    const { path: cur, depth: d } = queue.shift()
    let entries
    try {
      entries = readdirSync(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      visited += 1
      if (visited > maxEntries) return null
      const full = join(cur, entry.name)
      if (entry.isFile() && pattern.test(entry.name)) return full
      if (entry.isDirectory() && d < depth) {
        if (entry.name.startsWith('.') || SKIP_DIR.test(entry.name)) continue
        queue.push({ path: full, depth: d + 1 })
      }
    }
  }
  return null
}

function detectCandidate(cand) {
  // 已知路径命中最快，优先
  for (const p of cand.paths) {
    if (p && existsSync(p)) return { path: p, how: '已知路径' }
  }
  for (const dir of cand.scanDirs) {
    const found = scanForExe(dir, cand.exePattern, cand.scanDepth ?? 2, 3000, cand.scanBudgetMs ?? 1500)
    if (found) return { path: found, how: '目录扫描' }
  }
  return null
}

/* ------------------------------------------------------------ 外部工具 */

async function detectFfmpeg() {
  // 程序自带 tools/ffmpeg/bin
  const localBins = [
    join(TOOLS_DIR, 'ffmpeg', 'bin', WIN ? 'ffmpeg.exe' : 'ffmpeg'),
    join(TOOLS_DIR, WIN ? 'ffmpeg.exe' : 'ffmpeg'),
  ]
  for (const p of localBins) {
    if (!existsSync(p)) continue
    // 版本号也要读出来，界面上那栏才不是空的
    const ver = await runCapture(p, ['-version']).catch(() => null)
    const line = ver?.stdout?.split('\n')[0]?.trim() ?? ''
    const version = /ffmpeg version ([^\s]+)/.exec(line)?.[1] ?? line.slice(0, 40)
    return { available: true, path: p, source: '程序目录', version }
  }
  const r = await runCapture(WIN ? 'where' : 'which', [WIN ? 'ffmpeg.exe' : 'ffmpeg']).catch(() => null)
  if (r?.code === 0) {
    const first = r.stdout.split(/\r?\n/).find((l) => l.trim())
    if (first) {
      const ver = await runCapture(first.trim(), ['-version']).catch(() => null)
      const version = ver?.stdout?.split('\n')[0]?.trim() ?? ''
      return { available: true, path: first.trim(), source: '系统 PATH', version }
    }
  }
  return { available: false, path: null }
}

async function detectPython() {
  for (const cmd of WIN ? ['python', 'py'] : ['python3', 'python']) {
    const r = await runCapture(cmd, ['--version']).catch(() => null)
    if (r?.code === 0) return { available: true, path: cmd, version: (r.stdout || r.stderr).trim() }
  }
  return { available: false, path: null }
}

/* ------------------------------------------------------------ 对外接口 */

let cache = { at: 0, data: null }
const TTL = 5 * 60 * 1000

/**
 * 检测全部（带缓存）
 * @param {boolean} force 强制刷新
 */
export async function detectAll(force = false) {
  if (!force && cache.data && Date.now() - cache.at < TTL) return cache.data

  await mkdir(TOOLS_DIR, { recursive: true })

  const editors = []
  for (const cand of CANDIDATES) {
    const hit = detectCandidate(cand)
    editors.push({
      id: cand.id,
      name: cand.name,
      vendor: cand.vendor,
      category: cand.category,
      formats: cand.formats,
      color: cand.color,
      installed: !!hit,
      path: hit?.path ?? null,
      how: hit?.how ?? null,
    })
  }

  const [ffmpeg, python, ytdlpFound] = await Promise.all([detectFfmpeg(), detectPython(), findYtDlp()])
  const ytdlpVersion = ytdlpFound ? await getYtDlpVersion(ytdlpFound) : null

  const data = {
    checkedAt: new Date().toISOString(),
    platform: process.platform,
    node: process.version,
    root: WORKSTATION_ROOT,
    editors,
    tools: {
      ffmpeg,
      python,
      ytdlp: ytdlpFound
        ? { available: true, path: ytdlpFound.path, kind: ytdlpFound.kind, source: ytdlpFound.source, version: ytdlpVersion }
        : { available: false, path: null },
    },
    installedCount: editors.filter((e) => e.installed).length,
  }
  cache = { at: Date.now(), data }
  return data
}

export function invalidateCache() {
  cache = { at: 0, data: null }
}

/** 启动一个程序（分离进程，不阻塞服务） */
export function launch(exePath, args = [], opts = {}) {
  if (!exePath || !existsSync(exePath)) throw new Error(`程序不存在：${exePath}`)
  const child = spawn(exePath, args, {
    detached: true,
    stdio: 'ignore',
    cwd: opts.cwd ?? dirname(exePath),
    windowsHide: false,
  })
  child.unref()
  return { ok: true, pid: child.pid, path: exePath }
}

/** 在资源管理器中打开文件/目录 */
export function openInExplorer(target, select = false) {
  if (!existsSync(target)) throw new Error(`路径不存在：${target}`)
  const isDir = statSync(target).isDirectory()
  const args = isDir || !select ? [target] : ['/select,', target]
  const child = spawn('explorer.exe', args, { detached: true, stdio: 'ignore' })
  child.unref()
  return { ok: true }
}

/** 用默认浏览器打开链接 */
export function openUrl(url) {
  const child = spawn(WIN ? 'cmd' : 'xdg-open', WIN ? ['/c', 'start', '', url] : [url], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  return { ok: true }
}

/** 用系统默认程序打开文件 */
export function openWithDefault(path) {
  const child = spawn(WIN ? 'cmd' : 'xdg-open', WIN ? ['/c', 'start', '', path] : [path], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  })
  child.unref()
  return { ok: true }
}

export default { detectAll, invalidateCache, launch, openInExplorer, openUrl, openWithDefault, CANDIDATES }
