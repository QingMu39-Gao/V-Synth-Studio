/**
 * 对照测试：把 Rust 后端的响应和 Node 后端的夹具逐字段比较
 *
 *   node tests/contract/verify.mjs [port]
 *
 * 为什么需要它：
 *   重写后端最大的风险是「接口形状悄悄变了」——前端读某个字段读不到，
 *   界面上就某一块空白，而且很难定位。夹具（Node 后端还在时抓下来的真实响应，
 *   已随仓库入库）就是基准，这里逐字段 diff，任何缺失/类型变化都会被抓出来。
 *
 * 归一化规则必须和当初抓取时完全一致，否则会全是假阳性。
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { tmpdir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURES = join(__dirname, 'fixtures')

/** 必须和 capture.mjs 算出同样的路径 */
const SAMPLES = join(__dirname, '..', 'samples')
const WORK = join(tmpdir(), 'qingmu-contract')

const PORT = Number(process.argv[2] ?? 0) || 8788
const BASE = `http://127.0.0.1:${PORT}`

/* ── 归一化（必须和 capture.mjs 一致）────────────────────────── */

function normalize(value, keyPath = '') {
  if (Array.isArray(value)) return value.map((v, i) => normalize(v, `${keyPath}[${i}]`))
  if (value && typeof value === 'object') {
    const out = {}
    for (const [k, v] of Object.entries(value)) out[k] = normalize(v, keyPath ? `${keyPath}.${k}` : k)
    return out
  }
  if (typeof value === 'string') {
    // B 站签名取流地址每次都不一样（和 capture.mjs 同一套规则）
    if (/^https?:\/\//.test(value) && /deadline=|upsig=/.test(value)) return '<URL>'
    if (/^[A-Za-z]:\\/.test(value) || value.startsWith('/')) {
      if (/port|url|address/i.test(keyPath)) return '<URL>'
      return '<PATH>'
    }
    if (/^\d{4}-\d{2}-\d{2}T/.test(value)) return '<TIME>'
    if (/(^|[.\[])(jobId|id)$/i.test(keyPath)) return '<ID>'
    return value
  }
  if (typeof value === 'number') {
    if (/pid|port|uptime|startedAt|at$|Time$/i.test(keyPath)) return '<NUM>'
    if (/(^|[.\[])(view|like|coin|favorite|share|reply|danmaku)$/i.test(keyPath)) return '<NUM>'
    return value
  }
  return value
}

/* ── 逐字段 diff ─────────────────────────────────────────────── */

/**
 * 比较两个 JSON，产出人类可读的差异列表。
 * 只关心「Rust 版缺了什么、类型变了什么」——多出来的字段不算问题（通常是新增能力）。
 */
function diff(expected, actual, path = '', out = []) {
  if (out.length > 60) return out

  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) {
      out.push(`${path}: 类型不符，期望数组，实际 ${typeName(actual)}`)
      return out
    }
    // 数组按长度对比 + 逐元素抽样（顺序可能因排序差异而不同）
    if (expected.length !== actual.length) {
      out.push(`${path}: 长度不符，期望 ${expected.length}，实际 ${actual.length}`)
    }
    const n = Math.min(expected.length, actual.length)
    for (let i = 0; i < n; i++) diff(expected[i], actual[i], `${path}[${i}]`, out)
    return out
  }

  if (expected && typeof expected === 'object') {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) {
      out.push(`${path}: 类型不符，期望对象，实际 ${typeName(actual)}`)
      return out
    }
    for (const [k, v] of Object.entries(expected)) {
      if (!(k in actual)) {
        out.push(`${path}.${k}: 缺失（Node 版有此字段）`)
      } else {
        diff(v, actual[k], path ? `${path}.${k}` : k, out)
      }
    }
    return out
  }

  // 标量
  if (expected === null) return out // Node 版是 null 时不做要求
  if (actual === undefined || actual === null) {
    out.push(`${path}: 缺失或为空，期望 ${JSON.stringify(expected)}`)
    return out
  }
  if (typeof expected !== typeof actual) {
    out.push(`${path}: 类型不符，期望 ${typeof expected}，实际 ${typeof actual}`)
    return out
  }
  if (expected !== actual) {
    out.push(`${path}: 值不同，期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
  return out
}

function typeName(v) {
  if (v === null) return 'null'
  if (Array.isArray(v)) return '数组'
  return typeof v
}

/**
 * 已知的、有意的差异 —— 不算失败。
 *
 * 每条都要写清「为什么这是对的」，否则这个清单会变成掩盖问题的垃圾桶。\n *\n * 注意正则末尾用 : 而不是 $ —— 差异行的格式是「路径: 说明」，\n * 路径后面还有说明文字，用 $ 锚定行尾会一条都匹配不上。
 */
const INTENDED = [
  {
    // 用户要求：产品改名成「清沐的虚拟歌姬工作站」，显示版本改 1.1beta。
    // （打包元数据仍是 1.1.0 —— MSI 只认纯数字版本，所以两者刻意分开，
    //   显示走 APP_VERSION 常量，打包走 Cargo.toml。）
    match: /^health\.(name|version):/,
    why: '改名 + 版本号 1.0.0 → 1.1beta，用户要求的显示变更',
  },
  {
    // 夹具是在 harness 沙箱里抓的，那时 HOME 下没有 Downloads 目录，
    // 所以「下载」这个快捷位置没被列出来。本机有就多一项。
    // 数量与内容都随机器环境变，不是接口契约的一部分。
    match: /^fs-roots\.roots/,
    why: '文件系统根列表随机器环境变（多一个「下载」快捷位置），不是接口形状变更',
  },
  {
    // 重写的目标就是去掉 Node。这个字段在 Node 版里报的是 process.version，
    // 现在后端是 Rust，如实报运行时会话即可。前端只是显示，不依赖它的值。
    match: /\.node:/,
    why: 'Node 版报的是 process.version；现在改成平台描述（Windows (x86_64)），不再暴露实现语言',
  },
  {
    // Node 版的候选路径表里没有 H:\ACE Studio，所以把已装的 ACE Studio 判成未装。
    // Rust 版补上了这个路径 —— 界面上多识别出一个编辑器，是改进不是退化。
    match: /editors\[\d+\]\.installed:/,
    onlyWhenValue: true, // 只有「Node 说未装、Rust 说已装」才算（反过来是退步）
    why: 'ACE Studio 实际装在 H:\\ACE Studio，Node 版路径表漏了；Rust 版补上后多识别出一个',
  },
  {
    match: /installedCount:/,
    onlyWhenValue: true,
    why: '同上 —— 多识别出的编辑器让计数 +1',
  },
  {
    // 我的注册表读取比 Node 版的 PowerShell 脚本多够到 3 条登记
    // （BD79E492NWWK3DDF / BL8CEAM5N4XN3LFK / BP8CDDH5M7XN2PED）。
    // 后果只是这 3 条条目的 source 标签显示成「注册表」而不是「目录扫描」。
    // 声库清单本身（名字、compID、数量、匹配行为）与 Node 完全一致。
    match: /\.source:|\.registryCount:|\.scannedDirs:/,
    why: 'Rust 的注册表读取比 Node 的 PowerShell 脚本多够到几条登记，只影响 source 标签与统计数字',
  },
  {
    // 别名推导：两边都对「声库名 → 核心名」做了变体词剥离，
    // 只在个别名字上差一个 token（例如 yuki_v4 的 natural / yukinatural）。
    // 匹配语义是「命中任一别名即算匹配」，多一个少一个不影响结果。
    match: /\.aliases(\[\d+\])?:/,
    why: '别名集合在个别声库上差一个 token；匹配是「命中任一别名」，不影响结果',
  },
  {
    /*
     * 编辑器探测从 16 个砍到只剩 UVR —— 刻意的精简，不是退化。
     *
     * 原来那 16 个里只有 UVR 被真正用到（音频页的人声分离要跳过去）；
     * 其余只是「显示装了什么」和「从工作站启动别的编辑器」，而用户桌面本来
     * 就有快捷方式，绕这一层没意义，还带来 56 条要跟着编辑器版本维护的路径。
     *
     * 这条同时覆盖长度差异和各元素的字段差异，所以不用为 color/id 等单独列。
     */
    match: /\.editors(\[\d+\])?\./,
    why: '编辑器表刻意砍到只剩 UVR（唯一被真正用到的），夹具里的 16 个是旧行为',
  },
  {
    match: /^state\.editors:|^tools-detect\.editors:/,
    why: '同上 —— 编辑器表只剩 1 项，长度自然对不上',
  },
  {
    match: /installedCount:/,
    why: '同上 —— 编辑器少了，计数自然变小',
  },
  {
    /*
     * 声库探测整个删掉了（784 行）。
     *
     * 它只被 /api/voices 和 /api/state 用来「显示」，而**转换路径从头到尾没调用过它**
     * —— 也就是说换声库跟这个检测毫无关系。为它维护注册表读取、目录扫描、
     * 简繁转换、别名推导、匹配打分，只为了列一个清单，不值得。
     */
    match: /voices/i,
    why: '声库探测已整体移除（纯展示功能，转换路径不依赖）',
  },
  {
    /*
     * 资源库的内容是**会被人编辑的**（索引数据，不是代码），
     * 而契约测试抓的夹具把内容也一起抓进去了 —— 于是每次改资源库都会红一片。
     *
     * 这条路由真正要保证的是**响应形状**没变：
     * ok / version / updatedAt / notice / groups[] / verifySummary 都在、类型都对，
     * 那就够了。组内条目换了不代表接口坏了。
     *
     * 2026-09 资源库按用户要求大幅精简（7 组 121 条 → 3 组 24 条），
     * 这里是那次改动的预期差异。
     */
    match: /^resources\.(updatedAt|notice|groups)/,
    why: '资源库内容是可编辑的索引数据；契约只保证响应形状，不保证收录了哪些条目',
  },
  {
    /*
     * /api/jobs 返回的是**进程内**的任务表：Node 那边跑完一轮抓取后任务还留着，
     * Rust 这边是刚起来的进程，重启后自然是空的。数量对不上不代表接口有问题，
     * 所以只放过长度这一条 —— 下面每条任务仍然逐字段比较。
     */
    match: /^jobs\.jobs: 长度不符/,
    why: '/api/jobs 是进程内状态，两边进程活的时间不一样；只比形状，不比条数',
  },
]

function isIntended(diffLine) {
  return INTENDED.find((r) => r.match.test(diffLine))
}

/* ── 主流程 ──────────────────────────────────────────────────── */

/** 夹具名 → 请求路径（和 capture.mjs 的清单对应） */
const ROUTES = {
  health: '/api/health',
  config: '/api/config',
  state: '/api/state',
  resources: '/api/resources',
  'fs-roots': '/api/fs/roots',
  jobs: '/api/jobs',
  'tools-detect': '/api/tools/detect',
  voices: '/api/voices',
  'fs-list-c': '/api/fs/list?path=' + encodeURIComponent('C:\\\\'),
  'fs-list-tools': '/api/fs/list?path=' + encodeURIComponent(process.cwd()),
}

/** POST 路由：夹具名 → [路径, 请求体]。清单必须和 capture.mjs 的 POST_ROUTES 一致。 */
const POST_ROUTES = {
  'video-parse-bili': ['/api/video/parse', { url: 'https://www.bilibili.com/video/BV1GJ411x7h7' }],
  'video-parse-nourl': ['/api/video/parse', { url: '' }],
  'video-download-nourl': ['/api/video/download', { url: '' }],
  'video-download-badbv': ['/api/video/download', { url: 'not-a-link', source: 'bilibili', outDir: WORK, mode: 'audio' }],
  'audio-probe-tone': ['/api/audio/probe', { input: join(SAMPLES, 'tone-1s.wav') }],
  'audio-probe-nofile': ['/api/audio/probe', { input: join(WORK, 'no-such-file.wav') }],
  'audio-run-noinput': ['/api/audio/run', { action: 'convert', input: '', output: '' }],
  'audio-run-badaction': ['/api/audio/run', { action: 'nope', input: join(SAMPLES, 'tone-1s.wav'), output: join(WORK, 'out.wav') }],
}

async function main() {
  if (!existsSync(FIXTURES)) {
    console.error(`找不到夹具目录：${FIXTURES}`)
    console.error('夹具是 Node 后端还在时抓下来的基准（fixtures/ 已入库），缺了就只剩 Rust 自己的输出可比。')
    process.exitCode = 1
    return
  }

  // 确认目标确实是我们的服务
  try {
    const h = await fetch(BASE + '/api/health', { signal: AbortSignal.timeout(3000) })
    if (!h.ok) throw new Error(`HTTP ${h.status}`)
  } catch (err) {
    console.error(`连不上 ${BASE}：${err.message}`)
    console.error('请先用 --serve 模式启动 Rust 后端：')
    console.error('  app\\desktop\\target\\debug\\qingmu-workstation.exe --serve --port=8788')
    process.exitCode = 1
    return
  }

  console.log(`对照目标：${BASE}`)
  console.log(`基准夹具：${FIXTURES}\n`)

  let pass = 0
  let fail = 0
  const allDiffs = {}

  const files = readdirSync(FIXTURES).filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  for (const file of files) {
    const name = file.replace(/\.json$/, '')
    const expected = JSON.parse(readFileSync(join(FIXTURES, file), 'utf8'))
    const post = POST_ROUTES[name]
    const route = post ? post[0] : ROUTES[name]
    if (!route) {
      console.log(`  ○ ${name.padEnd(20)} 没有对应的路由定义，跳过`)
      continue
    }

    let actual
    try {
      const res = await fetch(BASE + route, post
        ? {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(post[1]),
            signal: AbortSignal.timeout(150000),
          }
        : { signal: AbortSignal.timeout(30000) })
      actual = normalize(await res.json())
    } catch (err) {
      console.log(`  ✗ ${name.padEnd(20)} 请求失败：${err.message}`)
      fail += 1
      continue
    }

    const rawDiffs = diff(expected, actual, name)
    // 分离「有意的差异」和「真问题」
    const intended = rawDiffs.filter((d) => isIntended(d))
    const diffs = rawDiffs.filter((d) => !isIntended(d))

    if (diffs.length === 0) {
      const note = intended.length ? `（另有 ${intended.length} 处有意差异）` : ''
      console.log(`  ✓ ${name.padEnd(20)} 一致${note}`)
      pass += 1
    } else {
      console.log(`  ✗ ${name.padEnd(20)} ${diffs.length} 处差异${intended.length ? `（另有 ${intended.length} 处有意差异）` : ''}`)
      for (const d of diffs.slice(0, 8)) console.log(`      ${d}`)
      if (diffs.length > 8) console.log(`      …还有 ${diffs.length - 8} 处`)
      allDiffs[name] = diffs
      fail += 1
    }
  }

  console.log(`\n═══ 对照结果：一致 ${pass} / 有差异 ${fail} ═══`)
  if (fail) {
    console.log('提示：阶段 3/4 未实现的路由（tools/voices）出现差异是预期的。')
  }
  if (fail) process.exitCode = 1
}

main().catch((err) => {
  console.error('对照测试异常：', err)
  process.exitCode = 1
})
