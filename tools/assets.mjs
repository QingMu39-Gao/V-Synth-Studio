/**
 * **外面那些东西的单一真源** —— 谁在哪个 zip 里、解到哪、必须有什么。
 *
 * 这个文件本身不干活，只描述。干活的脚本都 import 它：
 *
 *     tools/fetch_tools.mjs        补齐 tools/
 *     tools/fetch_jizura_fonts.mjs 补齐 public/vendor/jizura/
 *     tools/pack_assets.mjs        打包（CDN 大件）
 *     tools/stage_svsep.mjs        把素材搬成 data/svsep/
 *
 * 合起来的是打包侧与解包侧共用的那部分（哪个目录进哪个 zip、带不带壳、白名单、
 * 实测字节数）。分开写就会出现「打包写错、解包不知道」。
 *
 * ── ⚠️ 三条约束，改表前必读 ────────────────────────────────────────
 *
 * **① `strip`（解包剥壳）不是自由的，它由 Rust 侧的解包代码决定。**
 * 改这里的 `strip` 就要同时改 `svsep.rs::Bundle`，否则包解出来会多一层目录，
 * 而**两边都不会报错** —— `engine::missing_models` 只会说「模型还没装全」。
 *
 * **② `prefix`（打包带壳）与 `strip`（解包剥壳）必须互为镜像。**
 * `prefix="models/"` 就必须 `strip="models/"`。下面有一条自检（`selfCheck()`）。
 *
 * **③ 「摊平」是 `prefix=""`，不是「不写」。**
 *
 * ── 不合并的部分（有意留着）────────────────────────────────────────
 *
 * `artifact/mod.rs`（Rust）管**运行期去哪儿找**（含系统 PATH 兜底）。那张表的形状
 * 是为「找」服务的，和「打进哪个 zip」不是一回事。`check_tablesAgree()` 只核对两边
 * 都声明了的那些（`bundled` 的）。
 */

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import {HERE} from './lib.mjs'

export const MB = 1024 * 1024

// ── 解包落点里的两个特殊标记 ────────────────────────────────────────
export const ROOT = '<root>'            // 程序根目录（resources.json 所在那一层）
export const WRITABLE = '<writable>'    // 用户可写目录（安装后程序目录是只读的）

// ── 托管方式 ────────────────────────────────────────────────────────
export const HOST_RELEASE = 'release'    // 我们自己的 GitHub release，用户点按钮时下
export const HOST_UPSTREAM = 'upstream'  // 上游官网，构建时补齐脚本下
export const HOST_REPO = 'repo'          // 就在仓库里

// ── 平台 ────────────────────────────────────────────────────────────
// 随包的几个二进制是**平台专属**的（ffmpeg / yt-dlp / LibreSVIP / onnxruntime）：
// 补哪一份、落点叫什么名字，跟着编译所在的平台变。名字形状只在这里定义一次 ——
// `fetch_tools.mjs`（补）与 `build.rs::MUST_HAVE`（查）必须与它一致。
export const PLATFORM = {win32: 'windows', darwin: 'macos'}[process.platform] || 'linux'

/** 可执行文件的名字：Windows 带 `.exe`，其余平台裸名。 */
export const exeName = (base) => (PLATFORM === 'windows' ? `${base}.exe` : base)

/** 动态库的名字：win `x.dll` / mac `libx.dylib` / linux `libx.so`。 */
export const dylibName = (base) =>
  ({windows: `${base}.dll`, macos: `lib${base}.dylib`})[PLATFORM] || `lib${base}.so`

// ── 随包产物的内容摘要 ──────────────────────────────────────────────
/**
 * 每件产物**装好之后**那棵树的内容摘要，键是 `<平台>-<架构>`（如 `windows-x64`）。
 *
 * `fetch_tools.mjs::verify()` 每次补件都逐件比对：对不上就让这一步失败，而不是把来源
 * 不明的二进制打进安装包。它挡的是**来源被换掉**的那几条路 —— 自建归档、别人拷来的
 * `--local` 目录、镜像 —— 那几条都拿不到上游的签名，只有内容摘要判得了。
 *
 * 摘要算的是**整件**（相对路径 + 字节数 + 每个文件的 SHA-256，按路径排序后一起哈希）：
 * `libresvip/` 有上千个文件，逐条钉不现实；而少一个插件、多一个 dll 恰好就是「装出来
 * 缺功能」的形状。
 *
 * ⚠️ 只钉**上游按版本发布**的件（URL 里带版本号）。`ffmpeg` 那条指向 BtbN 的
 * `releases/download/latest/`，是**滚动发布**：上游一重新构建摘要就对不上，而两边都没错；
 * 改钉某个 `autobuild-<日期>` 标签也不行 —— 那些标签会被上游清掉（见「如何编译打包.md」4.2）。
 * 没钉的件在补件时打一行说明，**不算失败**（否则那个平台直接构建不了）。
 *
 * 补一个新平台 / 架构：在那台机器上跑 `node tools/fetch_tools.mjs --force`，再跑
 * `node tools/pin_tool_digests.mjs`，把它打印的那一行贴进来。
 */
export const TOOL_DIGESTS = {
  'windows-x64': {
    ytdlp: '0A48FD7693AB539CCEF334781F84627918A518889DB275A31239439A7ED0EF53',
    libresvip: 'B3FA901769404C9F8BF7FCD1DA1D4B5D3D404D92814404EB6C6A779BA187A5FD',
    onnxruntime: '7B2A8F2E4966F73D43F108DCBD247B0E31D1C2A3A8F588A909B12256A24D8507',
  },
}

// ── 上游：JIZURA（文字 PV 的前端）────────────────────────────────────
// 钉 commit SHA 而非分支名：`index.html` 要按字节打补丁，上游一动补丁就对不上。
// 查上游新版本：`git ls-remote https://github.com/852wa/JIZURA main`
export const UPSTREAM_JIZURA_SHA = 'fc16bfe43ea4a6c25a21f1caf04d17326de14f00'   // v0.10.1
export const UPSTREAM_JIZURA_REPO = '852wa/JIZURA'
// 与 SHA 对应的版本号，供界面鸣谢显示（`src/pages/Settings.tsx`，MIT 要求署名）。
// 两处语言不同、无法共享常量，由 `check_assets_agree.mjs` 核对；换 SHA 时要一起改。
export const UPSTREAM_JIZURA_VERSION = '0.10.1'
// 取自上游的两个文件（相对仓库根）。字体不在此列：上游仓库没有字体文件，
// 它是运行时从 Google Fonts 拉的，所以字体由 fetch_jizura_fonts.mjs 现场抓。
export const UPSTREAM_JIZURA_FILES = ['zh-hans/index.html', 'LICENSE']
// 用 `github.com/<repo>/raw/<sha>/<path>`：`raw.githubusercontent.com` 在境内直连不通。
export const UPSTREAM_JIZURA_URL =
  `https://github.com/${UPSTREAM_JIZURA_REPO}/raw/${UPSTREAM_JIZURA_SHA}/`

// ── 自建分发点：两块随包产物的第二条来源 ─────────────────────────────
// `tools/` 与 `public/vendor/jizura/` 的上游是 GitHub 与 Google Fonts，境内直连常不通，
// 而它们又是打包必需的（缺了不报错，只是功能悄悄少一块）。所以除上游之外还认一份
// **我们自己打的归档**，布局与本仓库一致（`tools/pack_archives.mjs` 产出的就是它），
// 放在一个境内直连可用的网盘目录里。
//
// ⚠️ 这块**与用户点按钮下的那几个扩展包无关**：那些走的是 GitHub release
// （`RELEASE_DIR`，见下面每条 `url`），境内那条路由 Rust 侧的 `ghmirror` 现挑镜像。
// 这里只管**打包时**要补齐的两块随包产物。
//
// ⚠️ 归档是**退路、不是替代**：它由人手工上传，会随网盘状态失效；上游才是权威。
// 完全不联网（用别人拷来的归档）用 `--local <目录>` 或 `VSS_ASSETS_LOCAL=<目录>`；
// 换托管地址用 `VSS_ASSETS_URL`。
export const SELF_HOST_BASE =
  (process.env.VSS_ASSETS_URL || '').trim() ||
  'https://1856610041.cdn.123clouddisk.com/1856610041/V-Synth-Studio'

/** 自建归档的文件名（键与 [`ARTIFACTS`] 的 id 对应）。 */
export const SELF_HOST_ARCHIVE = {tools: 'tools.zip', jizura: 'jizura.zip'}

/** 某件产物的自建归档地址（没配就回 `null`，调用方只走上游）。 */
export function selfHostUrl(id) {
  const file = SELF_HOST_ARCHIVE[id]
  return file ? `${SELF_HOST_BASE}/${file}` : null
}

/**
 * zip 里的一棵子树：从 `src` 收，条目名加前缀 `prefix`。
 * `prefix=''` 就是摊平（条目名 = 相对 `src` 的路径）。
 */
export function piece(src, prefix = '') { return {src, prefix} }

/**
 * 解包**之后**必须存在的东西（用来判「齐没齐」）。
 * `bytes` 给得出就给 —— 光看文件名分不出「官方版」与「注入版」（只小 37 字节）。
 * `min_files` 只对 `dir` 有意义 —— 「目录存在」是弱判据，半途失败会留下空壳。
 */
export function need(rel, bytes = null, kind = 'file', minFiles = 0) {
  return {rel, bytes, kind, minFiles}
}

// 下载 URL 是编译期常量，这里只是**抄一份给人看**，改了这里不能自动生效 ——
// 真正的真源在 Rust 里（见每条 note）。
export const ARTIFACTS = [
  // ═══════════════ 构建时补齐：从上游直取，随包进安装包 ═══════════════
  {
    id: 'tools',
    label: '外部工具（ffmpeg / yt-dlp / LibreSVIP）',
    pieces: [],
    into: `${ROOT}/tools`,
    strip: '',
    need: [
      /* Linux 的 deb 不带 ffmpeg：发行版仓库都有，deb 的 Depends 在安装时自动带上
         （`tauri.conf.json` 的 `bundle.linux.deb.depends`），所以这一行只列另两端。 */
      ...(PLATFORM === 'linux' ? [] : [need(`ffmpeg/bin/${exeName('ffmpeg')}`)]),
      need(exeName('yt-dlp')),
      need(`libresvip/libresvip-cli/${exeName('libresvip-cli')}`),
      need('libresvip/libresvip-cli/_internal/libresvip/plugins', null, 'dir', 1),
      // 人声转 MIDI 的 ONNX Runtime（随包，运行期不再下载）。
      // ⚠️ 名字必须与 `artifact/mod.rs` 里 `midi.ort` 的 `NameKind::Dll` 一致。
      need(`onnxruntime/${dylibName('onnxruntime')}`),
    ],
    host: HOST_UPSTREAM,
    bundled: true,
    fetcher: 'tools',
    note:
      '补齐方式见 fetch_tools.mjs：ffmpeg 从 gyan.dev / BtbN、yt-dlp 与 LibreSVIP 从各自\n' +
      'GitHub Release 直取（URL 在 fetch_tools.mjs::UPSTREAM）。因此它不产出 zip，\n' +
      '没有 zip / min_bytes / exclude 字段。',
  },
  {
    id: 'jizura',
    label: 'JIZURA 文字 PV（上游页面 + 现场抓的字体）',
    pieces: [],
    into: `${ROOT}/public/vendor/jizura`,
    strip: 'jizura/',
    need: [
      need('index.html'),
      need('LICENSE'),
      need('fonts', null, 'dir', 2000),
      need('fonts.css'),
    ],
    host: HOST_UPSTREAM,
    bundled: true,
    fetcher: 'jizura',
    note:
      '补齐方式见 fetch_jizura_fonts.mjs：index.html / LICENSE 从上游按 commit 直取\n' +
      '（index.html 要打 3 处补丁再落盘），fonts/ 与 fonts.css 从 Google Fonts 现场抓。\n' +
      '因此它不产出 zip，没有 zip / min_bytes / exclude 字段。',
  },

  // ═══════════════ 用户按需下载：我们自己打包、放 CDN ═══════════════
  {
    id: 'game.models',
    label: '人声转 MIDI 的 GAME 模型',
    zip: 'GAME-1.0.3-large-onnx.zip',
    // ⚠️ 只打白名单 4 个文件，**不整目录**：开发机上那个目录可能有 *.bak 或调试
    // 模型（segmenter_det.onnx），整目录打包会把它们一起发出去 —— 几百 MB 白流量。
    pieces: [
      piece('data/game/models/encoder.onnx', 'GAME-1.0.3-large-onnx/'),
      piece('data/game/models/segmenter.onnx', 'GAME-1.0.3-large-onnx/'),
      piece('data/game/models/estimator.onnx', 'GAME-1.0.3-large-onnx/'),
      piece('data/game/models/config.json', 'GAME-1.0.3-large-onnx/'),
    ],
    into: `${WRITABLE}/game/models`,
    strip: 'GAME-1.0.3-large-onnx/',
    need: [
      need('encoder.onnx', 81_312_536),
      need('segmenter.onnx', 160_373_028),
      need('estimator.onnx', 152_478_761),
      need('config.json', 198),
    ],
    host: HOST_RELEASE,
    url: 'https://github.com/QingMu39-Gao/V-Synth-Studio/releases/download/modules/GAME-1.0.3-large-onnx.zip',
    min_bytes: 300 * MB,
    note:
      '顶层目录名**必须**是 GAME-1.0.3-large-onnx/ —— 上游官方包的布局就是它，沿用之后\n' +
      '「官方包」与「我们的包」可以互换（midi_transcribe.rs::download_models 的 strip\n' +
      '常量两边都命得中）。⚠️ segmenter 要用**官方那版**（带 RandomUniformLike，真随机），\n' +
      '不是逐位验证用的注入版 —— 注入版是固定种子，且只小 37 字节，拿错不报错、只静默换掉随机性。',
  },
  {
    id: 'svsep.models',
    label: '音轨分离的模型',
    zip: 'models.zip',
    pieces: [piece('data/svsep/models', 'models/')],
    into: `${WRITABLE}/svsep/models`,
    strip: 'models/',
    need: [need('BS-Roformer-SW.ckpt'), need('UVR-MDX-NET-Inst_HQ_3.onnx')],
    host: HOST_RELEASE,
    url: 'https://github.com/QingMu39-Gao/V-Synth-Studio/releases/download/modules/models.zip',
    min_bytes: 500 * MB,
    note:
      '⚠️ 本地临时 zip 叫 models.zip（也就是 release 上那个资产名）。\n' +
      '⚠️ 落点判据是逐条目剥 `models/`（Rust `Bundle::models` 的 strip），改打包布局要同步改。',
  },
  {
    id: 'svsep.runtime',
    label: '音轨分离的运行时',
    zip: 'runtime.zip',
    // ⚠️ 三棵子树进同一个包 —— 缺一棵都不行：只装 runtime/ 的后果是「下完 4.5 GB 仍起不来」。
    pieces: [
      piece('data/svsep/runtime', 'runtime/'),
      piece('data/svsep/backend', 'backend/'),
      piece('data/svsep/bin', 'bin/'),
    ],
    into: `${WRITABLE}/svsep`,
    strip: '',   // 整棵留着：要的正是 runtime/python.exe 与 backend/app.py
    need: [
      need('runtime/python.exe'),
      need('backend/app.py'),
      need('bin/ffmpeg.exe'),
    ],
    host: HOST_RELEASE,
    /* ⚠️ **分卷**：GitHub 单个 release 资产上限 2 GB，4.94 GB 只能拆。
       拆法与顺序**由 `tools/split_volumes.mjs` 定死**（按字节切开：每卷 0.9 GiB，
       最后一卷是尾巴），这份 `volumes` 就是那个脚本的输出名单 —— 与
       `svsep.rs::RUNTIME_PARTS` 必须逐字一致，两边名字或卷数一变，用户那边下完
       就拼不出 zip。⛔ 别用 WinZip / Bandizip 的「跨卷 zip」：那是另一种格式。 */
    url: 'https://github.com/QingMu39-Gao/V-Synth-Studio/releases/download/modules/runtime.z01',
    volumes: ['runtime.z01', 'runtime.z02', 'runtime.z03', 'runtime.z04', 'runtime.z05', 'runtime.zip'],
    min_bytes: 1000 * MB,
    exclude: ['__pycache__', '*.pyc', 'templates', 'static'],
    note:
      '⚠️ strip 是**空**（留着 runtime/ 那一层）—— 与 models 那条相反，因为落点就是\n' +
      'svsep/ 本身。改这里要同步 svsep.rs::Bundle::runtime。\n' +
      '⚠️ bin/ffmpeg.exe 是分离引擎自己要用的（backend/config.py 把它塞进 PATH）。',
  },

  // ═══════════════════ 上游：程序直接下，我们不碰 ═══════════════════
  {
    id: 'data.pinyin',
    label: '拼音词典',
    zip: '',
    pieces: [],
    into: `${ROOT}/data`,
    strip: '',
    need: [need('pinyin.json')],
    host: HOST_REPO,
    bundled: true,
    note: '已入库、已进 bundle.resources，什么都不用做。',
  },
  {
    id: 'data.resources',
    label: '资源库清单',
    zip: '',
    pieces: [],
    into: `${ROOT}/data`,
    strip: '',
    need: [need('resources.json')],
    host: HOST_REPO,
    bundled: true,
    note: '已入库。它同时还是 lib.rs::resolve_paths 判定「程序根目录」的哨兵。',
  },
]

export function byId(assetId) {
  const a = ARTIFACTS.find((x) => x.id === assetId)
  if (!a) throw new Error(`表里没有 ${assetId}`)
  return a
}

/** 某个补齐脚本负责的那些（`--only` 的取值就从这儿来）。 */
export function fetchedBy(fetcher) {
  return ARTIFACTS.filter((a) => a.fetcher === fetcher)
}

/** 我们自己打包的那些（现在只剩 CDN 大件）。 */
export function packable() {
  return ARTIFACTS.filter((a) => a.pieces.length > 0)
}

/**
 * 表自身的自检 —— `pack_assets.mjs` 开跑前会先过一遍。
 *
 * 只查**表内部**说得通说不通（不碰磁盘、不碰 Rust）。查的是那三条约束里最容易写错、
 * 而错了不报错的两条：prefix 与 strip 互为镜像、摊平别有前缀。
 */
export function selfCheck() {
  const bad = []
  for (const a of ARTIFACTS) {
    const packs = a.pieces.length > 0
    if (packs && !a.zip) bad.push(`${a.id}: 要打包，却没有 zip 名`)
    if (!packs && a.zip) bad.push(`${a.id}: 不打包（pieces 为空），却写着 zip=${JSON.stringify(a.zip)}`)
    if (!packs) continue

    //   条目名 = prefix + 相对路径        （打包侧）
    //   落盘   = into / (条目名 - strip)   （解包侧）
    //   ⇒ need.rel 必须 = 剥完剩下的那一段
    const remainders = new Set()
    for (const pc of a.pieces) {
      if (!pc.prefix.startsWith(a.strip)) {
        bad.push(`${a.id}: strip=${JSON.stringify(a.strip)} 不是 prefix=${JSON.stringify(pc.prefix)} 的前缀 —— 解包会剥错地方，而两边都不报错`)
        continue
      }
      remainders.add(pc.prefix.slice(a.strip.length))
    }
    for (const nd of a.need) {
      if (![...remainders].some((rem) => nd.rel.startsWith(rem))) {
        bad.push(`${a.id}: need ${JSON.stringify(nd.rel)} 不在剥完之后剩下的 ${JSON.stringify([...remainders].sort())} 下 —— 解出来会多一层或少一层目录`)
      }
    }

    // 条目名不能撞。单文件子树取「文件基本名」，目录子树是整棵。
    const seenFiles = new Map()
    const dirPrefixes = new Set()
    for (const pc of a.pieces) {
      const src = pc.src.replace(/\/+$/, '')
      const base = src.split('/').pop()
      if (base.includes('.') || base === 'config.json') {
        const key = `${pc.prefix}\u0000${base}`
        if (seenFiles.has(key)) bad.push(`${a.id}: ${pc.prefix}${base} 有两个来源，会互相覆盖`)
        seenFiles.set(key, true)
      } else {
        if (dirPrefixes.has(pc.prefix)) bad.push(`${a.id}: 前缀 ${JSON.stringify(pc.prefix)} 下有两棵目录，条目名会撞`)
        dirPrefixes.add(pc.prefix)
      }
    }
    for (const nd of a.need) {
      if (nd.rel.startsWith('/') || nd.rel.split('/').includes('..')) {
        bad.push(`${a.id}: need 里有个可疑路径 ${JSON.stringify(nd.rel)}`)
      }
    }

    /* 分卷：拆法要与 Rust `svsep.rs::RUNTIME_PARTS` 逐字一致，而那边读不到这张表
       （跨语言，和 `build.rs::MUST_HAVE` 同一类重复）。这里只能查**表内**说得通：
       至少两卷、名字不重复、最后一卷就是 `zip` 那个名字（WinZip 的老约定：
       其余叫 .z01…，最后一卷用 .zip）。卷名或顺序错了，用户下完拼不出 zip，
       而那时几个 GB 已经下完了。 */
    if (a.volumes) {
      if (a.volumes.length < 2) bad.push(`${a.id}: volumes 只有 ${a.volumes.length} 项，那不叫分卷`)
      if (new Set(a.volumes).size !== a.volumes.length) {
        bad.push(`${a.id}: volumes 里有重名 —— 两卷共用一个文件名，后下的会盖掉先下的`)
      }
      if (a.volumes.at(-1) !== a.zip) {
        bad.push(`${a.id}: 最后一卷必须是 ${JSON.stringify(a.zip)}，写的是 ${JSON.stringify(a.volumes.at(-1))}`)
      }
      if (!a.volumes[0].includes('.z')) {
        bad.push(`${a.id}: 第一卷该是 .z01 这种名字，写的是 ${JSON.stringify(a.volumes[0])}`)
      }
    }
  }
  return bad
}

/**
 * 让 `build.rs::MUST_HAVE` 与这张表对一对 —— 漂了就在这里红。
 *
 * `build.rs` 那份重复**是故意的**（它是独立编译单元），但「故意重复」和「可以漂」
 * 是两回事。只对**打进安装包**的那些（`bundled`）：CDN 大件不进包，build.rs 里不该有。
 */
export function checkTablesAgree(root = HERE) {
  const buildRs = path.join(root, 'src-tauri', 'build.rs')
  if (!fs.existsSync(buildRs)) return [`找不到 ${buildRs}，无法核对`]

  const text = fs.readFileSync(buildRs, 'utf8')
  /* `MUST_HAVE` 的每一行是 `(路径, 说明, 平台)`。平台那一列取 `ANY` / `WIN` / `MAC` /
     `LINUX` 四个常量名（build.rs 那边展开成 `CARGO_CFG_TARGET_OS` 的取值）。
     ⚠️ 收尾符要同时认 `)` 与 `,`：表里既有写成一行的、也有折成三行的。
     ⚠️ 只对照**本平台**的行：另一平台的二进制在这台机器上本来就不该存在，
     参与对照必然红。
     ⚠️ 正则里的平台名要与 `TAG` 的键逐字一致：漏掉一个（如 `LINUX`）不会报错，
     那条会被静默跳过 —— 表现为本平台的产物漏检。 */
  const TAG = {ANY: null, WIN: 'windows', MAC: 'macos', LINUX: 'linux'}
  const listed = new Set()
  for (const m of text.matchAll(/^\s*\(\s*"([^"]+)"\s*,\s*"[^"]*"\s*,\s*(ANY|WIN|MAC|LINUX)\s*[),]/gm)) {
    const only = TAG[m[2]]
    if (only && only !== PLATFORM) continue
    listed.add(m[1])
  }
  if (listed.size === 0) return ['build.rs 里没抠出 MUST_HAVE 的路径（正则失效了？）']

  const expected = new Set()
  for (const a of ARTIFACTS) {
    if (!a.bundled) continue
    for (const nd of a.need) {
      const rel = a.into.includes('/') ? a.into.slice(a.into.indexOf('/') + 1) : ''
      const joined = `${rel}/${nd.rel}`.replace(/^\/+/, '')
      expected.add(`../${joined}`)
    }
  }

  const bad = []
  for (const p of [...expected].sort()) if (!listed.has(p)) bad.push(`${p} 在 assets.mjs 里有，build.rs::MUST_HAVE 里没有`)
  for (const p of [...listed].sort()) if (!expected.has(p)) bad.push(`${p} 在 build.rs::MUST_HAVE 里有，assets.mjs 里没有`)
  return bad
}
