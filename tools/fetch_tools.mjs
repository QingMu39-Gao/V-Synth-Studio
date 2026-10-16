#!/usr/bin/env node
/**
 * 补齐 `tools/` —— 干净机器 / CI 上编译前要跑的第一件事。
 *
 *     node tools/fetch_tools.mjs
 *     node tools/fetch_tools.mjs --only ffmpeg        # 只补一件
 *     node tools/fetch_tools.mjs --force
 *     node tools/fetch_tools.mjs --root <目录>        # 补到别处（验证用）
 *     node tools/fetch_tools.mjs --local <目录>       # 只用 <目录> 里的 tools.zip，不联网
 *
 * 这个仓库只放源码。`tools/`（ffmpeg + yt-dlp + LibreSVIP CLI + onnxruntime，
 * 约 200MB）不入库，但它由 tauri.conf.json 的 `bundle.resources` 打进安装包，
 * 缺了程序就没有音频转换 / MV 下载 / 工程格式互转 / 人声转 MIDI。
 *
 * 各件产物**互相独立**：各自一个上游、各自判「缺不缺」。URL 见 `UPSTREAM`（按平台分列，
 * 有的件还要按架构分 —— macOS 的 arm64 与 x86_64 是两份不同的发布物）。
 *
 * ── 三条来源，按这个顺序试 ──────────────────────────────────────────
 *
 *   1. `--local <目录>` / `VSS_ASSETS_LOCAL`：那里的 `tools.zip`，**不联网**；
 *   2. 自建归档（`assets.mjs::SELF_HOST_BASE`，布局与本仓库一致，境内直连可用）；
 *   3. 上游各发布页（`UPSTREAM`，GitHub，境内常不通）。
 *
 * ⚠️ **第 2 条只有 Windows**：那份 `tools.zip` 里是 `ffmpeg.exe` / `yt-dlp.exe`，
 * 别的平台上命不中任何一件。非 Windows 直接走上游（`--local` 会明确报错，不偷偷联网）。
 *
 * ⚠️ 归档里可能缺件（旧归档就没有 onnxruntime），所以解完要**重新判一次**，
 * 剩下的回上游补 —— 不能让「归档解过了」被当成「齐了」。
 *
 * ⚠️ 解出来的二进制在 mac/Linux 上要自己补可执行位（`chmodX`）：压缩包里的权限位
 * 不跟着 `writeFileSync` 走，少了它 `Command::new` 直接 `EACCES`。
 *
 * ⚠️ 「运行期去哪儿找」只在 `src-tauri/src/artifact/mod.rs` 那张表里写一次。
 * 下面 `verify()` 列的是「打包前必须存在」的文件，与 `build.rs` 的 MUST_HAVE 对应 ——
 * 这份重复是有意的：为了在「还没编译」时给人一句能读懂的错。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import {createHash} from 'node:crypto'
import {spawnSync} from 'node:child_process'

import * as assets from './assets.mjs'
import {HERE, copyFile, download, isDir, isFile, mkdirp, rmrf, say, sha256File, walkFiles, isMain} from './lib.mjs'
import {archiveSuffix, extractAny, findOne, obtainArchive} from './archive.mjs'

// ── 平台 ─────────────────────────────────────────────────────────────
// 三端各取各的上游二进制，落点形状一致（`tools/ffmpeg/bin/ffmpeg`…），
// 只是文件名在 Windows 上带 `.exe`。
const PLATFORM = {win32: 'windows', darwin: 'macos'}[process.platform] || 'linux'

/** 目标架构（`arm64` / `x64`）。上游有的件按架构分开发布物，取错了到用户机器上才现形。 */
const ARCH = process.arch
const MARK_ROOT = assets.ROOT
const MARK_WRITABLE = assets.WRITABLE

const exe = (name) => (PLATFORM === 'windows' ? `${name}.exe` : name)

// ── 产物：每件独立 ──────────────────────────────────────────────────
// 各自一个上游、各自判「缺不缺」。URL 都是上游发布页的直链，没有镜像、没有网盘兜底。
// ⚠️ 上游换版本时这里要一起改（版本号在 URL 里）。
const UPSTREAM = {
  // BtbN 的 lgpl 档：程序只用音频编码器（mp3lame / vorbis / opus + 内建的 aac/flac/pcm），
  // lgpl 全都有。gpl 档多带 x264/x265，而程序从不编码视频（6 处调用都是 `-vn`）。
  ffmpeg: {
    windows: 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-lgpl.zip',
    /* BtbN 不出 macOS 档，而 macOS 上的静态构建几乎都是 GPL。挑 jellyfin-ffmpeg 的可携包：
       GitHub 上钉 tag、全功能（它本来就是给转码用的），本程序要的 `atempo` / `asetrate` /
       `loudnorm` / mp4 与 matroska 的拆与合都在里面。
       ⚠️ 别换成为省体积的「纯音频」构建（acoustid 那档 LGPL）：它没有那几个滤镜，
       变调变速与响度归一化会直接失败。
       ⚠️ 许可是 GPL —— 与本程序（GPL-3.0）同系，随包分发无冲突（见 docs/THIRD-PARTY-NOTICES.md）。
       ⚠️ 它是 `.tar.xz`：解它要系统的 `xz`（Node 没有 liblzma）。
       Linux 没有这里的位置：deb 不带 ffmpeg，由系统仓库提供（见 `PARTS_THIS_PLATFORM`）。 */
    macos: {
      arm64: 'https://github.com/jellyfin/jellyfin-ffmpeg/releases/download/v8.1.3-1/jellyfin-ffmpeg_8.1.3-1_portable_macarm64-gpl.tar.xz',
      x64: 'https://github.com/jellyfin/jellyfin-ffmpeg/releases/download/v8.1.3-1/jellyfin-ffmpeg_8.1.3-1_portable_mac64-gpl.tar.xz',
    },
  },
  ytdlp: {
    windows: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp.exe',
    linux: {
      x64: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp_linux',
      arm64: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp_linux_aarch64',
    },
    macos: 'https://github.com/yt-dlp/yt-dlp/releases/download/2026.08.19/yt-dlp_macos',
  },
  // LibreSVIP 的 CLI 三端都发（`*-CLI-<版本>.<平台>-<架构>.tar.gz`）。
  // ⚠️ macOS 的包里有符号链接（`_internal/Python`），解压器要真的建出链接来。
  libresvip: {
    windows: 'https://github.com/SoulMelody/LibreSVIP/releases/download/v2.9.0/LibreSVIP-CLI-2.9.0.win-amd64.zip',
    linux: {
      x64: 'https://github.com/SoulMelody/LibreSVIP/releases/download/v2.9.0/LibreSVIP-CLI-2.9.0.linux-x86_64.tar.gz',
      arm64: 'https://github.com/SoulMelody/LibreSVIP/releases/download/v2.9.0/LibreSVIP-CLI-2.9.0.linux-aarch64.tar.gz',
    },
    macos: {
      arm64: 'https://github.com/SoulMelody/LibreSVIP/releases/download/v2.9.0/LibreSVIP-CLI-2.9.0.macos-arm64.tar.gz',
      x64: 'https://github.com/SoulMelody/LibreSVIP/releases/download/v2.9.0/LibreSVIP-CLI-2.9.0.macos-x86_64.tar.gz',
    },
  },
  // ONNX Runtime 官方 release。整包里只拎出那一个动态库。
  onnxruntime: {
    windows: 'https://github.com/microsoft/onnxruntime/releases/download/v1.23.2/onnxruntime-win-x64-1.23.2.zip',
    /* CPU 构建（与 Windows 随包的那份对齐）：GPU 构建是 240 MB 的包、解出 368 MB 的
       `libonnxruntime_providers_cuda.so`，而 Linux 上没有音轨分离运行时可以借 CUDA 版
       —— 想要 GPU 推理得自己把一份带 CUDA provider 的 ORT 放进 `<可写>/midi`
       （`midi_transcribe::runtime_dll` 认得）。 */
    linux: {
      x64: 'https://github.com/microsoft/onnxruntime/releases/download/v1.23.2/onnxruntime-linux-x64-1.23.2.tgz',
      arm64: 'https://github.com/microsoft/onnxruntime/releases/download/v1.23.2/onnxruntime-linux-aarch64-1.23.2.tgz',
    },
    macos: {
      arm64: 'https://github.com/microsoft/onnxruntime/releases/download/v1.23.2/onnxruntime-osx-arm64-1.23.2.tgz',
      x64: 'https://github.com/microsoft/onnxruntime/releases/download/v1.23.2/onnxruntime-osx-x86_64-1.23.2.tgz',
    },
  },
}

/** 某件产物在本平台的地址。值可以是一串、也可以按架构分列（`{arm64, x64}`）。 */
function sourceOf(name) {
  const per = UPSTREAM[name][PLATFORM]
  const url = typeof per === 'string' ? per : per?.[ARCH]
  if (!url) {
    throw new Error(`${name} 没有 ${PLATFORM}/${ARCH} 的上游地址（上游只发了别的平台或架构）`)
  }
  return url
}

// ── 解包落点 ────────────────────────────────────────────────────────
/** 用户可写目录。⚠️ 必须与 Rust 侧 `lib.rs::user_data_dir()` 一致，抄错了会「下完了但认不出来」。 */
function writableDir() {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData/Roaming')
    return path.join(base, 'com.qingmu.vocalworkstation')
  }
  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library/Application Support/com.qingmu.vocalworkstation')
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local/share')
  return path.join(base, 'com.qingmu.vocalworkstation')
}

/** 把表里的 `<root>` / `<writable>` 标记换成真路径。 */
function destOf(asset, root) {
  if (asset.into.startsWith(MARK_WRITABLE + '/')) {
    return path.join(writableDir(), asset.into.slice(MARK_WRITABLE.length + 1))
  }
  if (asset.into.startsWith(MARK_ROOT + '/')) {
    return path.join(root, asset.into.slice(MARK_ROOT.length + 1))
  }
  throw new Error(`${asset.id}: into 既不是 ${MARK_ROOT} 也不是 ${MARK_WRITABLE}`)
}

// ── 从上游补齐 ──────────────────────────────────────────────────────
/** 随包的四件产物（`--only` 的取值）。 */
export const PARTS = {
  ffmpeg: {what: 'ffmpeg（音频转换 / 合并 / 扒谱解码）'},
  ytdlp: {what: 'yt-dlp（MV 解析下载）'},
  libresvip: {what: 'LibreSVIP CLI（工程格式互转）'},
  onnxruntime: {what: 'ONNX Runtime（人声转 MIDI 的推理运行时）'},
}

/* ffmpeg 不进 Linux 的 deb：各发行版仓库都有，deb 的 Depends 声明它、安装时由
   包管理器自动带上；运行期认不到随包副本就退回系统 PATH。其余三件仍随包 ——
   yt-dlp 要跟着站点改版走（发行版版本普遍落后），LibreSVIP 与 onnxruntime
   不在任何发行版的仓库里。 */
export const PARTS_THIS_PLATFORM =
  Object.keys(PARTS).filter((n) => n !== 'ffmpeg' || PLATFORM !== 'linux')

/** 某件产物在本平台下的相对落点（Windows 加 `.exe`；`onnxruntime` 换动态库名）。 */
function needRel(name) {
  const dll = {windows: 'onnxruntime.dll', macos: 'libonnxruntime.dylib'}[PLATFORM] || 'libonnxruntime.so'
  if (name === 'ffmpeg') return `ffmpeg/bin/${exe('ffmpeg')}`
  if (name === 'ytdlp') return exe('yt-dlp')
  if (name === 'libresvip') return `libresvip/libresvip-cli/${exe('libresvip-cli')}`
  return `onnxruntime/${dll}`
}

/**
 * 把落好的二进制标成可执行。
 *
 * ⚠️ **必须补这一步**：`archive.mjs` 解出来的文件是 `fs.writeFileSync` 写的，
 * 压缩包里的权限位（tar 的 mode、zip 的外部属性）**一律不带过来**，于是 mac/Linux 上
 * 拿到的是 0644 —— `Command::new` 直接 `EACCES`，症状是「工具明明在，却说缺」。
 */
function chmodX(file) {
  if (PLATFORM === 'windows') return
  fs.chmodSync(file, 0o755)
}

/** 上游只给一个**裸二进制**（不是压缩包）的件 —— 直接下到落点，不解压。 */
const BARE_BINARY = new Set(['ytdlp'])

function installFfmpeg(ex, base) {
  // ⚠️ **只要 ffmpeg**，不拷 ffprobe —— 媒体信息由 `ffmpeg -i` 自己读（见 audio.rs）。
  const found = findOne(ex, exe('ffmpeg'))
  if (!found) throw new Error(`包里找不到 ${exe('ffmpeg')}（上游布局变了？看 ${ex}）`)
  const dest = path.join(base, 'ffmpeg', 'bin', exe('ffmpeg'))
  copyFile(found, dest)
  chmodX(dest)
}

function installLibresvip(ex, base) {
  // 整个 `libresvip-cli/` 目录搬到位 —— 只搬 exe 会缺 `_internal/` 里的插件。
  const found = findOne(ex, exe('libresvip-cli'))
  if (!found) throw new Error(`包里找不到 ${exe('libresvip-cli')}（上游布局变了？看 ${ex}）`)
  const dst = path.join(base, 'libresvip', 'libresvip-cli')
  rmrf(dst)
  mkdirp(path.dirname(dst))
  // 跨设备 rename 会 EXDEV（`--root` 指到别的盘时），拷过去更稳。
  // ⚠️ `verbatimSymlinks` 必须开着：macOS 的包里 `_internal/Python` 是**相对**符号链接，
  //    默认行为会把链接目标按源目录重算，落到新位置就可能指空。
  fs.cpSync(path.dirname(found), dst, {recursive: true, verbatimSymlinks: true})
  // 入口那个二进制要可执行；`_internal/` 里的 dylib 不需要（dlopen 不看权限位）
  chmodX(path.join(dst, path.basename(found)))
}

/**
 * 上游包里那个动态库的**真身**。
 *
 * ⚠️ macOS / Linux 的包里它带版本号、不带版本号的那个是**符号链接**，而 `walkFiles`
 * 不跟符号链接（见 lib.mjs），照名字找会找不到。两种平台的版本号位置**不同**：
 *   macOS  `libonnxruntime.1.23.2.dylib`（版本号在扩展名**前**）
 *   Linux  `libonnxruntime.so.1.23.2`  （版本号在扩展名**后**）
 * 落点仍然写成不带版本号的名字 —— `artifact/mod.rs` 的 `NameKind::Dll` 认的就是它。
 */
function onnxruntimeSource(ex, name) {
  const direct = findOne(ex, name)
  if (direct) return direct
  const stem = name.replace(/\.(dylib|so)$/, '')
  const versioned = new RegExp(`^${stem}(?:\\.\\d[^/]*\\.(?:dylib|so)|\\.(?:dylib|so)\\.\\d[^/]*)$`)
  return walkFiles(ex).find((f) => versioned.test(path.basename(f))) ?? null
}

function installOnnxruntime(ex, base) {
  // 只拎出那一个动态库（含相邻的 providers_shared），头文件/.lib/PDB 一律不落地。
  const name = {windows: 'onnxruntime.dll', macos: 'libonnxruntime.dylib'}[PLATFORM] || 'libonnxruntime.so'
  const found = onnxruntimeSource(ex, name)
  if (!found) throw new Error(`包里找不到 ${name}（上游布局变了？看 ${ex}）`)
  const dstDir = path.join(base, 'onnxruntime')
  mkdirp(dstDir)
  copyFile(found, path.join(dstDir, name))
  // `shared` provider 用不上，但放在同目录无害，且 ORT 会在本目录找它
  const shared = {windows: 'onnxruntime_providers_shared.dll', macos: 'libonnxruntime_providers_shared.dylib'}[PLATFORM]
    || 'libonnxruntime_providers_shared.so'
  const src = path.join(path.dirname(found), shared)
  if (isFile(src)) copyFile(src, path.join(dstDir, shared))
}

export async function fetchTools(tmp, force, root, only = null, local = null) {
  const base = destOf(assets.byId('tools'), root)
  mkdirp(base)

  const todo = only === null ? PARTS_THIS_PLATFORM : PARTS_THIS_PLATFORM.filter((n) => only.includes(n))
  let missing = todo.filter((name) => force || !isFile(path.join(base, needRel(name))))
  if (missing.length === 0) {
    say(`  ${todo.join(' / ')} 都已在，跳过`)
    return
  }

  /* 先试归档（一次补齐整件，且是境内可达/本地的来源）。解完必须重新判一次：
     归档可能缺件（旧归档没有 onnxruntime），而「解过了」不等于「齐了」。

     ⚠️ **自建归档只有 Windows 那一份**（`tools.zip` 里是 `ffmpeg.exe` / `yt-dlp.exe`…），
     别的平台上它一件都命不中，白下 188 MB。所以非 Windows 直接走上游；
     `--local` 是明确要求离线，那时归档对不上就没退路，直接报错而不是偷偷联网。 */
  if (PLATFORM !== 'windows' && local) {
    throw new Error(
      `--local / VSS_ASSETS_LOCAL 里的 ${assets.SELF_HOST_ARCHIVE.tools} 是 Windows 的产物，` +
      `${PLATFORM} 上命不中任何一件 —— 撤掉它，走上游补齐。`
    )
  }
  const zip = PLATFORM === 'windows'
    ? await obtainArchive({
        file: assets.SELF_HOST_ARCHIVE.tools,
        tmp,
        localDir: local,
        url: assets.selfHostUrl('tools'),
      })
    : null
  if (zip) {
    say(`  从归档解到 ${base}`)
    extractAny(zip, base, tmp)
    missing = todo.filter((name) => force || !isFile(path.join(base, needRel(name))))
    if (missing.length === 0) {
      say(`  ${todo.join(' / ')} 都齐了`)
      return
    }
    if (local) {
      throw new Error(
        `本地归档里缺：${missing.join('、')}\n` +
        `  归档是别人打的那一份，缺件说明它过期了；不想离线就撤掉 --local / VSS_ASSETS_LOCAL。`
      )
    }
    say(`  归档里还缺 ${missing.join('、')}，回上游补`)
  }

  say(`  缺：${missing.join('、')}`)

  const failed = []
  for (const name of missing) {
    say(`  ── ${PARTS[name].what} ──`)
    try {
      const url = sourceOf(name)
      // 裸二进制（`yt-dlp` 的上游就是一个可执行文件）：直接下到目标位置，不用解压。
      if (BARE_BINARY.has(name)) {
        const dest = path.join(base, needRel(name))
        mkdirp(path.dirname(dest))
        await download(url, dest)
        chmodX(dest)
        continue
      }
      const z = path.join(tmp, `${name}${archiveSuffix(url)}`)
      await download(url, z)
      const ex = path.join(tmp, name)
      extractAny(z, ex, tmp)
      ;({ffmpeg: installFfmpeg, libresvip: installLibresvip, onnxruntime: installOnnxruntime}[name])(ex, base)
      rmrf(ex)
      fs.rmSync(z, {force: true})
    } catch (e) {
      failed.push(`${name}: ${e.message}`)
    }
  }

  if (failed.length) {
    say('')
    for (const item of failed) say(`  ✗ ${item}`)
    throw new Error(
      `${failed.length} 件补不齐。上游地址见 \`UPSTREAM\`（按平台分列）—— ` +
      `检查它是否还有效、这个平台上游发没发。`
    )
  }
}

// ── 校验：**这才是本脚本的重点** ─────────────────────────────────────
/**
 * 跑一下二进制，把首行版本号拿出来当**佐证**。
 *
 * ⚠️ 这纯属额外信息，**跑不起来不算失败**：在 Linux 上跑的可能是 Windows PE
 * （`EACCES`/`ENOEXEC`），那**正常** —— 所以措辞要能区分「平台不对」与「真坏了」。
 */
function runVersion(binary, args) {
  const r = spawnSync(binary, args, {encoding: 'utf8', timeout: 20_000})
  if (r.error) {
    const code = r.error.code
    if (code === 'EACCES' || code === 'ENOEXEC') return '（不是本平台的可执行文件，只核对存在）'
    return `（本机跑不了：${r.error.message}）`
  }
  const out = (r.stdout || r.stderr || '').trim()
  return out ? out.split('\n')[0] : '(无输出)'
}

// 想报版本的二进制：件名 → 跑它的参数。
const VERSION_ARGS = {ffmpeg: ['-version'], ytdlp: ['--version']}

// ── 内容摘要：来源被换掉时唯一判得了的东西 ───────────────────────────
/**
 * 一件产物在 `tools/` 下占的**那棵树** —— 摘要算的就是它。
 *
 * 与 `needRel` 的分工：那个回答「打包前必须存在哪个文件」，这个回答「哪一片属于这件」。
 * 目录名与三个 `install*` 的落点一致（`libresvip/` 整个搬、`onnxruntime/` 只放 dll）；
 * `ytdlp` 是裸二进制，没有目录，只有那一个文件。
 */
const PART_TREES = {ffmpeg: 'ffmpeg', ytdlp: null, libresvip: 'libresvip', onnxruntime: 'onnxruntime'}

/** 没钉摘要的件，以及**为什么**不钉 —— 补件时逐条打出来。 */
export const PIN_EXEMPT = {
  ffmpeg: '上游是滚动发布（BtbN 的 latest），按日期钉标签又会被上游清理，所以这件钉不住',
  onnxruntime:
    '归档里那份与上游 v1.23.2 不是同一份字节（15551032 / 14186016 字节，文件版本号却相同），先弄清该用哪份再钉',
}

/** 这一件补上了没有（摘要只能对已经补上的件算）。 */
export function partPresent(root, name) {
  const base = destOf(assets.byId('tools'), root)
  const dir = PART_TREES[name]
  return dir ? walkFiles(path.join(base, dir)).length > 0 : isFile(path.join(base, needRel(name)))
}

/**
 * 一件产物的内容摘要：整棵子树的「相对路径 + 字节数 + 文件 SHA-256」按路径排序后
 * 再哈希一次。
 *
 * ⚠️ 只用**内容与路径**，不带时间戳 / 权限位 / 符号链接：`chmodX` 会改权限位，macOS 的
 * 包里 `_internal/Python` 是符号链接（`walkFiles` 本来就不跟）—— 带上它们摘要会随机器变。
 * ⚠️ 排序用码位比较，**别用 `localeCompare`**：那个随 locale 变，换台机器摘要就不一样。
 */
export function toolDigest(root, name) {
  const base = destOf(assets.byId('tools'), root)
  const dir = PART_TREES[name]
  const files = dir ? walkFiles(path.join(base, dir)) : [path.join(base, needRel(name))]
  const rows = files.map((f) => {
    const rel = path.relative(base, f).split(path.sep).join('/')
    return {rel, line: `${rel}\n${fs.statSync(f).size}\n${sha256File(f)}\n`}
  })
  rows.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return createHash('sha256').update(rows.map((r) => r.line).join('')).digest('hex').toUpperCase()
}

/**
 * 按表核一遍，缺什么现在就说。返回问题列表（空 = 齐了）。
 *
 * 除了「在不在」，这里还核**钉住的内容摘要**（`assets.mjs::TOOL_DIGESTS`）——
 * 它是自建归档 / `--local` 目录 / 镜像这几条路唯一判得了的东西。摘要对不上算**失败**，
 * 因为下一步就是把这份二进制打进安装包。
 */
export function verify(selected, root) {
  const bad = []
  for (const asset of selected) {
    const base = destOf(asset, root)
    const descs = []
    for (const nd of asset.need) {
      const p = path.join(base, nd.rel)
      if (nd.kind === 'dir') {
        const n = isDir(p) ? walkFiles(p).length : 0
        if (n < nd.minFiles) {
          bad.push(`${asset.into}/${nd.rel}/（只有 ${n} 个，至少要 ${nd.minFiles}）`)
          continue
        }
        descs.push(`${nd.rel}（${n} 个文件）`)
      } else if (!isFile(p)) {
        bad.push(`${asset.into}/${nd.rel}`)
      } else {
        const key = Object.keys(VERSION_ARGS).find((k) => nd.rel.endsWith(exe(k)))
        descs.push(key ? `${nd.rel}: ${runVersion(p, VERSION_ARGS[key])}` : nd.rel)
      }
    }
    if (descs.length) say(`  ${asset.id.padEnd(10)}: ${descs.join('，')}`)
  }

  if (selected.some((a) => a.id === 'tools')) {
    const base = destOf(assets.byId('tools'), root)
    const pins = assets.TOOL_DIGESTS[`${PLATFORM}-${ARCH}`] ?? {}
    const unpinned = []
    for (const name of PARTS_THIS_PLATFORM) {
      // 缺件的件不核摘要：上面已经报过「缺」，再报一条只会把真正的错埋掉
      if (!isFile(path.join(base, needRel(name)))) continue
      const want = pins[name]
      if (!want) {
        unpinned.push(PIN_EXEMPT[name] ? `${name}（${PIN_EXEMPT[name]}）` : name)
        continue
      }
      const got = toolDigest(root, name)
      if (got !== want) {
        bad.push(
          `tools/ 里 ${name} 的内容摘要与钉住的对不上（盘上 ${got.slice(0, 16)}…，钉的是 ${want.slice(0, 16)}…）` +
          `—— 来源被换过，或者上游换了发布物。确认来源无误后重新钉：node tools/pin_tool_digests.mjs`,
        )
      }
    }
    if (unpinned.length) say(`  没钉内容摘要：${unpinned.join('、')}`)
  }
  return bad
}

// ── 主流程 ──────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {only: 'all', force: false, root: null, local: null}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--force') a.force = true
    else if (argv[i] === '--only') a.only = argv[++i]
    else if (argv[i] === '--root') a.root = argv[++i]
    else if (argv[i] === '--local') a.local = argv[++i]
  }
  return a
}

export async function main(argv = process.argv.slice(2)) {
  const a = parseArgs(argv)
  const root = a.root ? path.resolve(a.root) : HERE
  const local = a.local || (process.env.VSS_ASSETS_LOCAL || '').trim() || null
  if (a.root) say(`程序根（--root）：${root}`)
  if (local) say(`本地归档目录（--local）：${local}`)

  const problems = assets.selfCheck()
  if (problems.length) {
    say('assets.mjs 自检没过，先修表：')
    for (const item of problems) say(`  - ${item}`)
    return 1
  }

  const want = a.only.split(',').filter(Boolean)
  if (!(want.length === 1 && want[0] === 'all')) {
    const unknown = want.filter((x) => !PARTS_THIS_PLATFORM.includes(x))
    if (unknown.length) {
      say(`不认识的件：${unknown}（本平台可选：${PARTS_THIS_PLATFORM.join('、')}）`)
      return 1
    }
  }

  const tmp = path.join(root, 'src-tauri', 'target', 'vss-cache', 'tmp')
  mkdirp(tmp)

  say('补齐 tools/')
  await fetchTools(tmp, a.force, root, want.length === 1 && want[0] === 'all' ? null : want, local)

  say('')
  say('校验')
  const bad = verify([assets.byId('tools')], root)

  say('')
  if (bad.length) {
    say('不齐：')
    for (const item of bad) say(`  - ${item}`)
    return 1
  }
  say('全部齐了')
  return 0
}

if (isMain(import.meta.url)) {
  main().then((code) => process.exit(code), (e) => { say(`✗ ${e.message}`); process.exit(1) })
}
