/**
 * 本机声库扫描与匹配
 *
 * 为什么需要它：转成 .vpr 时，工程里只写歌手名的话，VOCALOID 打开后
 * 挂不上任何声库（歌手栏是空的）。把本机已安装声库的 compID 注入写出参数，
 * 转出来的工程才能直接出声。
 *
 * 检测策略（重要）：
 *   1) **注册表优先** —— VOCALOID 安装声库时会登记到注册表，里面直接写着 compID、
 *      安装路径和官方名称。这跟用户把声库装在哪块盘、哪个目录完全无关，
 *      是最可靠的自动检测方式（不要靠猜某个固定文件夹）。
 *   2) **常见目录扫描** —— 兜底，覆盖没登记进注册表的便携安装 / 手动拷贝的声库。
 *   3) **用户手动添加的目录** —— 前两步都没找到时，由用户在设置页指定。
 *
 * 全部只读，不修改任何文件与注册表。
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

/** 注册表里可能出现声库登记的位置（64 位与 32 位视图都查） */
const REGISTRY_KEYS = [
  'HKLM:\\SOFTWARE\\WOW6432Node\\VOCALOID4\\DATABASE41',
  'HKLM:\\SOFTWARE\\WOW6432Node\\VOCALOID4\\DATABASE',
  'HKLM:\\SOFTWARE\\VOCALOID4\\DATABASE41',
  'HKLM:\\SOFTWARE\\VOCALOID4\\DATABASE',
  'HKLM:\\SOFTWARE\\VOCALOID5\\Voice\\Components',
  'HKLM:\\SOFTWARE\\WOW6432Node\\VOCALOID5\\Voice\\Components',
  'HKLM:\\SOFTWARE\\VOCALOID6\\Application\\Components',
  'HKLM:\\SOFTWARE\\WOW6432Node\\VOCALOID6\\Application\\Components',
  'HKCU:\\SOFTWARE\\VOCALOID4\\DATABASE41',
  'HKCU:\\SOFTWARE\\VOCALOID4\\DATABASE',
  'HKCU:\\SOFTWARE\\VOCALOID5\\Voice\\Components',
  'HKCU:\\SOFTWARE\\VOCALOID6\\Application\\Components',
]

/** 没有注册表信息时的兜底扫描目录 */
const FALLBACK_VOICE_DIRS = [
  'H:\\VoiceDB', 'D:\\VoiceDB', 'E:\\VoiceDB', 'F:\\VoiceDB', 'G:\\VoiceDB', 'C:\\VoiceDB',
  'C:\\ProgramData\\VOCALOID6\\VoiceDB',
  'C:\\Program Files\\VOCALOID6\\VoiceDB',
  'C:\\Program Files (x86)\\VOCALOID6\\VoiceDB',
  'C:\\Program Files\\VOCALOID5\\VoiceDB',
  'D:\\VOCALOID6\\VoiceDB',
]

/**
 * 找出所有可能的「用户主目录」。
 * 不能只信 process.env.USERPROFILE —— 在沙箱/便携环境里它可能被改写到别处，
 * 那会导致 OpenUtau 歌手、用户文档目录里的东西全部找不到。
 */
function candidateHomes() {
  const homes = new Set()
  for (const key of ['USERPROFILE', 'HOME']) {
    const v = process.env[key]
    if (v && existsSync(v)) homes.add(v)
  }
  const drive = process.env.HOMEDRIVE
  const path = process.env.HOMEPATH
  if (drive && path) homes.add(`${drive}${path}`)
  try {
    const h = homedir()
    if (h && existsSync(h)) homes.add(h)
  } catch {
    /* ignore */
  }
  const usersRoot = 'C:\\Users'
  if (existsSync(usersRoot)) {
    try {
      for (const entry of readdirSync(usersRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        if (/^(Public|Default|Default User|All Users|WDAGUtilityAccount)$/i.test(entry.name)) continue
        const full = join(usersRoot, entry.name)
        if (existsSync(join(full, 'Documents')) || existsSync(join(full, 'Desktop'))) homes.add(full)
      }
    } catch {
      /* ignore */
    }
  }
  return [...homes]
}

/** 名称归一化：去空格/下划线/标点，转小写，全角转半角 */
export function normalizeName(name) {
  return String(name)
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .replace(/[\s_\-./\\()（）[\]【】·、,，.。:：]+/g, '')
}

/* -------------------------------------------------------- 注册表检测 */

const COMPID_RE = /^[A-Za-z0-9]{12,}$/

/**
 * 从注册表读取已登记声库。
 * 用 PowerShell 执行并强制 UTF-8 输出，避免中文路径在 OEM 代码页下乱码。
 */
function readRegistryBanks() {
  const keyList = REGISTRY_KEYS.map((k) => `'${k.replace(/'/g, "''")}'`).join(',')
  const script = [
    '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
    `$keys=@(${keyList})`,
    '$out=@()',
    'foreach($k in $keys){',
    '  if(-not (Test-Path $k)){continue}',
    '  Get-ChildItem $k -ErrorAction SilentlyContinue | ForEach-Object {',
    '    $p=Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue',
    '    if($p -eq $null){return}',
    '    $out += [pscustomobject]@{',
    '      key=$k; compID=$_.PSChildName;',
    '      path=$p.PATH; path2=$p.Path; name=$p.NAME; bankName=$p.BankName;',
    '      installed=$p.INSTALLED',
    '    }',
    '  }',
    '}',
    'if($out.Count -gt 0){ $out | ConvertTo-Json -Compress -Depth 3 } else { "[]" }',
  ].join('\n')

  let raw
  try {
    raw = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 20000,
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
    })
  } catch {
    return []
  }
  if (!raw || !raw.trim()) return []
  let parsed
  try {
    parsed = JSON.parse(raw.trim())
  } catch {
    return []
  }
  const list = Array.isArray(parsed) ? parsed : [parsed]

  const out = []
  for (const item of list) {
    const compID = String(item.compID ?? '').trim()
    if (!COMPID_RE.test(compID)) continue // 跳过 KEYS / Presets 这类非声库子键
    if (item.installed !== undefined && Number(item.installed) === 0) continue
    const basePath = String(item.path ?? item.path2 ?? '').trim().replace(/[\\/]+$/, '')
    if (!basePath) continue

    // 声库目录 = 登记路径 与 compID 的组合；两者都试，取真实存在的那个
    const candidates = [join(basePath, compID), basePath]
    const dir = candidates.find((d) => existsSync(d)) ?? join(basePath, compID)

    // 名称优先级：BankName（V5/V6 的干净名）> NAME 括号里的名字（V4）> 目录里的 .ddb 文件名
    let name = String(item.bankName ?? '').trim()
    if (!name) {
      const m = String(item.name ?? '').match(/\(([^)]+)\)\s*$/)
      name = m ? m[1].trim() : String(item.name ?? '').trim()
    }
    if (!name) name = ddbNameIn(dir) || compID

    out.push({ compID, name, dir, engine: 'vocaloid', source: '注册表' })
  }
  return out
}

/** 读目录里的 <名字>.ddb / .vvd / .ddi，作为声库名 */
function ddbNameIn(dir) {
  try {
    const files = readdirSync(dir)
    for (const re of [/\.ddb$/i, /\.vvd$/i, /\.ddi$/i]) {
      const hit = files.find((f) => re.test(f))
      if (hit) return hit.replace(re, '')
    }
  } catch {
    /* 读不到就算了 */
  }
  return ''
}

/* -------------------------------------------------------- 目录扫描 */

/** 读一个 compID 目录，返回声库信息 */
function readBankDir(full, compID, groupName = '') {
  const name = ddbNameIn(full) || compID
  const aliases = new Set([compID, name].map(normalizeName).filter(Boolean))
  if (groupName) aliases.add(normalizeName(groupName))
  const simplified = normalizeName(
    name.replace(/(_V[0-9]+X?|_EVEC|_Straight|_Soft|_Whisper|_Original|_Solid|_Dark|_Sweet|_Power|_Native|_Jpn|_CHN|_ENG)/gi, '')
  )
  if (simplified) aliases.add(simplified)
  return {
    engine: 'vocaloid',
    compID,
    name,
    group: groupName,
    dir: full,
    source: '目录扫描',
    aliases: [...aliases],
  }
}

/**
 * 扫描一个声库根目录。支持两种真实布局：
 *   <根>\<compID>\<名字>.ddb
 *   <根>\<声库组名>\<compID>\<名字>.ddb
 */
function scanVoiceRoot(dir) {
  const out = []
  if (!dir || !existsSync(dir)) return out
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const full = join(dir, entry.name)
    if (COMPID_RE.test(entry.name)) {
      out.push(readBankDir(full, entry.name))
      continue
    }
    let subs
    try {
      subs = readdirSync(full, { withFileTypes: true })
    } catch {
      continue
    }
    for (const sub of subs) {
      if (!sub.isDirectory() || !COMPID_RE.test(sub.name)) continue
      out.push(readBankDir(join(full, sub.name), sub.name, entry.name))
    }
  }
  return out
}

function scanOpenUtauSingers() {
  const out = []
  const seen = new Set()
  for (const home of candidateHomes()) {
    const base = join(home, 'Documents', 'OpenUtau', 'Singers')
    if (!existsSync(base) || seen.has(base)) continue
    seen.add(base)
    let entries
    try {
      entries = readdirSync(base, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = join(base, entry.name)
      let name = entry.name
      for (const file of ['character.txt', 'character.yaml']) {
        const p = join(full, file)
        if (!existsSync(p)) continue
        try {
          const m = readFileSync(p, 'utf8').match(/^\s*name\s*[:=]\s*"?([^"\r\n]+)"?/im)
          if (m) {
            name = m[1].trim()
            break
          }
        } catch {
          /* ignore */
        }
      }
      out.push({
        engine: 'openutau',
        compID: entry.name,
        name,
        dir: full,
        source: 'OpenUtau 歌手目录',
        aliases: [...new Set([entry.name, name].map(normalizeName).filter(Boolean))],
      })
    }
  }
  return out
}

function scanSynthV() {
  const out = []
  const bases = []
  for (const home of candidateHomes()) {
    bases.push(join(home, 'Documents', 'SynthV Studio 2 Pro', 'voicebanks'))
    bases.push(join(home, 'Documents', 'SynthV Studio Pro', 'voicebanks'))
  }
  bases.push(
    'C:\\Program Files\\Synthesizer V Studio 2 Pro\\voicebanks',
    'H:\\Synthesizer V Studio 2 Pro\\voicebanks',
    'D:\\Synthesizer V Studio 2 Pro\\voicebanks'
  )
  for (const base of bases) {
    if (!existsSync(base)) continue
    let entries
    try {
      entries = readdirSync(base, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      out.push({
        engine: 'synthv',
        compID: entry.name,
        name: entry.name,
        dir: join(base, entry.name),
        source: 'SynthV 声库目录',
        aliases: [normalizeName(entry.name)],
      })
    }
  }
  return out
}

/* ------------------------------------------------------------ 用户目录 */

/**
 * 用户在设置页手动添加的声库目录。
 * 由服务端在读取/保存配置时注入，这样转换引擎不必自己去找配置文件。
 */
let userVoiceDirs = []

export function setUserVoiceDirs(dirs) {
  const next = [...new Set((Array.isArray(dirs) ? dirs : []).filter((d) => typeof d === 'string' && d.trim()))]
  const changed = next.join('|') !== userVoiceDirs.join('|')
  userVoiceDirs = next
  if (changed) invalidateVoiceCache()
  return userVoiceDirs
}

export function getUserVoiceDirs() {
  return [...userVoiceDirs]
}

/* ------------------------------------------------------------ 缓存接口 */

let cache = { at: 0, data: null, key: '' }
const TTL = 5 * 60 * 1000

/**
 * 扫描本机声库
 * @param {{extraDirs?:string[], force?:boolean}} opts extraDirs 追加目录（不传则用设置里的）
 */
export function getVoices(opts = {}) {
  const { extraDirs, force = false } = opts
  const dirs = extraDirs === undefined ? userVoiceDirs : [...new Set([...userVoiceDirs, ...extraDirs])]
  const key = dirs.join('|')
  if (!force && cache.data && cache.key === key && Date.now() - cache.at < TTL) return cache.data

  const userDirs = dirs.filter(Boolean)

  // 1) 注册表（最可靠，与安装位置无关）
  const registryBanks = readRegistryBanks()

  // 2) 目录扫描：用户指定的目录优先，其次兜底目录；注册表里出现过的父目录也顺带扫一遍
  const scanDirs = new Set()
  for (const d of userDirs) scanDirs.add(d)
  for (const b of registryBanks) if (b.dir) scanDirs.add(b.dir.replace(/[\\/][A-Za-z0-9]{12,}$/, ''))
  for (const d of FALLBACK_VOICE_DIRS) if (existsSync(d)) scanDirs.add(d)

  const scanned = []
  const dirResult = new Map() // compID -> bank
  for (const d of scanDirs) {
    for (const bank of scanVoiceRoot(d)) {
      if (!dirResult.has(bank.compID)) dirResult.set(bank.compID, bank)
    }
    // 目录本身也可能就是某个声库（用户直接把 compID 目录填进来）
    const base = d.replace(/[\\/]+$/, '')
    const tail = base.split(/[\\/]/).pop()
    if (COMPID_RE.test(tail) && existsSync(base)) {
      if (!dirResult.has(tail)) dirResult.set(tail, readBankDir(base, tail))
    }
    scanned.push(d)
  }

  // 3) 合并：注册表信息优先（名称与 compID 都是官方登记的），目录扫描补漏
  const byCompId = new Map()
  for (const bank of dirResult.values()) byCompId.set(bank.compID, bank)
  for (const bank of registryBanks) {
    const prev = byCompId.get(bank.compID)
    byCompId.set(bank.compID, {
      ...(prev ?? {}),
      ...bank,
      // 注册表给了名字就用注册表的；目录里的 .ddb 名字作为别名补充
      aliases: [...new Set([...(prev?.aliases ?? []), ...(bank.aliases ?? []), normalizeName(bank.compID), normalizeName(bank.name)])].filter(Boolean),
    })
  }

  const vocaloid = [...byCompId.values()]
  for (const b of vocaloid) {
    if (!b.aliases) b.aliases = [normalizeName(b.compID), normalizeName(b.name)].filter(Boolean)
  }

  const openutau = scanOpenUtauSingers()
  const synthv = scanSynthV()

  const data = {
    scannedAt: new Date().toISOString(),
    registryCount: registryBanks.length,
    scannedDirs: scanned,
    userDirs,
    vocaloid,
    openutau,
    synthv,
    total: vocaloid.length + openutau.length + synthv.length,
    hint:
      vocaloid.length || openutau.length || synthv.length
        ? ''
        : '没有读到任何声库。VOCALOID 声库正常情况下会登记在注册表里自动被识别；' +
          '如果你的声库是便携版/手动拷贝的，请在下方手动添加声库所在目录。',
  }
  cache = { at: Date.now(), data, key }
  return data
}

export function invalidateVoiceCache() {
  cache = { at: 0, data: null, key: '' }
}

export function defaultVoiceDirs() {
  return FALLBACK_VOICE_DIRS.filter((d) => existsSync(d))
}

/* ------------------------------------------------------------ 匹配 */

/**
 * 版本号与音色变体词。匹配歌手时要把它们剥掉：
 * 「Miku(V2)」应当能匹配到本机的「MIKU_V4X_Original_EVEC」——
 * 用户手上的工程往往是老版本编辑器做的，声库却是新装的，不剥版本号就永远匹不上。
 *
 * 实现要点：必须按分隔符**整词**判断，不能用子串替换。
 * 曾经的 bug：用子串替换 'eng' 会把 Yuezhengling 削成 yuezhling，乐正绫就再也匹配不上。
 */
const VARIANT_SET = new Set([
  'original', 'normal', 'straight', 'natural', 'basic', 'default',
  'sweet', 'soft', 'dark', 'solid', 'power', 'warm', 'cold', 'serious',
  'whisper', 'light', 'vivid', 'evec', 'vcv', 'jpn', 'chn', 'eng', 'spa', 'kor',
  'meng', 'ning', 'wan', 'plus', 'pro', 'library', 'vocaloid',
])
const VERSION_TOKEN_RE = /^(v\d+x?|ver\d*|version\d*|\d+(\.\d+)*)$/i
const VERSION_SUFFIX_RE = /(v\d+x?|ver\d*)$/i

/**
 * 繁体字 → 简体字（只覆盖歌姬名里会出现的字）。
 * 用户经常混着打，例如「镜音リン」（简体镜 + 片假名）与「鏡音リン」都要能认出来。
 */
const TRAD_TO_SIMP = {
  鏡: '镜', 鈴: '铃', 連: '连', 結: '结', 緣: '缘', 樂: '乐', 綾: '绫', 龍: '龙',
  徵: '征', 塵: '尘', 詩: '诗', 裏: '里', 聲: '声', 葉: '叶', 鳴: '鸣',
  東: '东', 亞: '亚', 紲: '绁', 貓: '猫', 來: '来', 儚: '儚', 櫻: '樱',
}

function tradToSimp(str) {
  let out = ''
  for (const ch of String(str)) out += TRAD_TO_SIMP[ch] ?? ch
  return out
}

/** 常见歌姬的中/日文写法 → 拉丁核心名 */
const SINGER_ALIAS = new Map(Object.entries({
  '初音ミク': 'miku', '初音未来': 'miku', '初音未來': 'miku', 'miku': 'miku', 'hatsune miku': 'miku',
  '鏡音リン': 'rin', '鏡音铃': 'rin', '镜音铃': 'rin', '镜音リン': 'rin', 'rin': 'rin', 'kagamine rin': 'rin',
  '鏡音レン': 'len', '鏡音连': 'len', '镜音连': 'len', '镜音レン': 'len', 'len': 'len', 'kagamine len': 'len',
  '巡音ルカ': 'luka', '巡音流歌': 'luka', 'luka': 'luka', 'megurine luka': 'luka',
  'meiko': 'meiko', 'kaito': 'kaito', 'gumi': 'gumi', 'ia': 'ia',
  '結月ゆかり': 'yukari', '结月ゆかり': 'yukari', '结月缘': 'yukari', 'yukari': 'yukari', 'yuzuki yukari': 'yukari',
  'vflower': 'flower', 'flower': 'flower', 'v4flower': 'flower',
  '洛天依': 'luotianyi', 'luotianyi': 'luotianyi', 'luo tianyi': 'luotianyi', 'tianyi': 'luotianyi',
  '乐正绫': 'yuezhengling', '樂正綾': 'yuezhengling', 'yuezhengling': 'yuezhengling', 'ling': 'yuezhengling',
  '言和': 'yanhe', 'yanhe': 'yanhe',
  '乐正龙牙': 'yuezhenglongya', '樂正龍牙': 'yuezhenglongya', 'longya': 'yuezhenglongya',
  '徵羽摩柯': 'zhiyumoke', '征羽摩柯': 'zhiyumoke', 'moke': 'zhiyumoke',
  '墨清弦': 'moqingxian', 'qingxian': 'moqingxian',
  '星尘': 'xingchen', '星塵': 'xingchen', 'xingchen': 'xingchen', 'stardust': 'xingchen',
  '海伊': 'haiyi', 'haiyi': 'haiyi', '诗岸': 'shian', '赤羽': 'chiyu',
  '可不': 'kafu', 'kafu': 'kafu',
  '重音テト': 'teto', 'teto': 'teto', '重音テトsv': 'teto',
  '波音リツ': 'rits', 'rits': 'rits', '欲音ルコ': 'ruko', '桃音モモ': 'momo',
  '亜北ネル': 'neru', 'neru': 'neru', '東北ずん子': 'zunko', 'zunko': 'zunko',
  '琴葉茜': 'akane', '琴葉葵': 'aoi', 'ずんだもん': 'zundamon', 'zundamon': 'zundamon',
  '紲星あかり': 'akari', 'akari': 'akari', '小春六花': 'rikka', '夏色花梨': 'karin',
  '花隈千冬': 'chifuyu', '星界': 'sekai', 'sekai': 'sekai', '鳴花ミコト': 'mikoto',
  '鳴花ヒメ': 'hime', 'one': 'one', '裏命': 'rim',
  'yuki': 'yuki', 'miki': 'miki', 'mew': 'mew', 'seeu': 'seeu', 'uncia': 'uncia',
  'cyber diva': 'cyberdiva', 'cyberdiva': 'cyberdiva', 'fukase': 'fukase',
}))

/**
 * 别名查找表：把每个键的原文、小写、简体形式都注册进去。
 * 这样「鏡音リン / 镜音リン / 镜音铃」等混写都能命中同一个歌姬。
 */
const SINGER_ALIAS_LOOKUP = (() => {
  const m = new Map()
  for (const [key, value] of SINGER_ALIAS) {
    for (const k of [key, key.toLowerCase(), tradToSimp(key), tradToSimp(key).toLowerCase()]) {
      if (!m.has(k)) m.set(k, value)
    }
  }
  return m
})()

/**
 * 抽出「核心名」：按分隔符切词后整词剔除版本/音色词，再拼回去
 * Miku(V2) → miku ; MIKU_V4X_Original_EVEC → miku ; YuezhenglingV3 → yuezhengling
 */
export function coreName(name) {
  const s = String(name).replace(/[（(【\[].*?[)）】\]]/g, ' ')
  const tokens = s.split(/[^A-Za-z0-9\u3041-\u3096\u30a1-\u30fa\u4e00-\u9fff]+/).filter(Boolean)
  const kept = []
  for (let token of tokens) {
    const lower = token.toLowerCase()
    if (VARIANT_SET.has(lower)) continue
    if (VERSION_TOKEN_RE.test(token)) continue
    token = token.replace(VERSION_SUFFIX_RE, '')
    if (token) kept.push(token)
  }
  return normalizeName(kept.join(''))
}

/** 归一化到可比较的「歌姬身份」：先查中日文别名表，再退回核心名 */
export function canonicalSinger(name) {
  const raw = String(name ?? '').trim()
  if (!raw) return ''
  const simp = tradToSimp(raw)
  for (const key of [raw, raw.toLowerCase(), simp, simp.toLowerCase()]) {
    const hit = SINGER_ALIAS_LOOKUP.get(key)
    if (hit) return hit
  }
  const core = coreName(simp)
  const hit = SINGER_ALIAS_LOOKUP.get(core)
  if (hit) return hit
  return core
}

function nameLanguage(name) {
  const s = String(name ?? '')
  if (/[\u3041-\u3096\u30a1-\u30fa]/.test(s)) return 'ja'
  if (/[\u4e00-\u9fff]/.test(s)) return 'zh'
  return ''
}

/**
 * 声库名里的语言标记。
 * 除了看名字，也要看安装路径 —— 例如「洛天依」的中文声库叫 LuoTianyi_V4_Meng（名字里没有 CHN），
 * 但它装在 ...\LuoTianyiV4_CHN\ 下，路径里的 CHN 才是判断依据。
 */
function bankLanguage(name, dir = '') {
  const s = `${name ?? ''} ${dir ?? ''}`
  if (/(^|[_\s\\/-])(chn|chi|zh|cn)([_\s\\/-]|$)/i.test(s)) return 'zh'
  if (/(^|[_\s\\/-])(jpn|jp|ja)([_\s\\/-]|$)/i.test(s)) return 'ja'
  return ''
}

function defaultVariantBonus(name) {
  return /(original|normal|straight|natural|basic)/i.test(name) ? 6 : 0
}

function languageBonus(singerLang, bankName, bankDir = '') {
  if (!singerLang) return 0
  const bl = bankLanguage(bankName, bankDir)
  if (!bl) return 0
  return bl === singerLang ? 10 : -6
}

/**
 * 给一个歌手名找最合适的本机声库
 * @param {string} singer
 * @param {Array} banks
 * @returns {{bank:object, score:number, reason:string}|null}
 */
export function matchVoice(singer, banks) {
  if (!singer || !banks?.length) return null
  const target = normalizeName(singer)
  const targetCore = canonicalSinger(singer)
  const singerLang = nameLanguage(singer)
  if (!target && !targetCore) return null

  let best = null
  for (const bank of banks) {
    const bankCore = canonicalSinger(bank.name)
    const langBonus = languageBonus(singerLang, bank.name, bank.dir)
    const bonus = defaultVariantBonus(bank.name) + langBonus
    for (const alias of bank.aliases ?? []) {
      if (!alias) continue
      let score = 0
      let reason = ''
      if (alias === target) {
        score = 100 + langBonus
        reason = '名称完全一致'
      } else if (targetCore && bankCore && targetCore === bankCore) {
        score = 88 + bonus
        reason = '同一歌姬（忽略版本/音色差异）'
      } else if (target.includes(alias) || alias.includes(target)) {
        score = 60 + Math.round((Math.min(alias.length, target.length) / Math.max(alias.length, target.length)) * 30) + bonus
        reason = '名称部分匹配'
      } else if (targetCore.length >= 3 && bankCore.length >= 3 && (targetCore.includes(bankCore) || bankCore.includes(targetCore))) {
        score = 70 + bonus
        reason = '核心名部分匹配'
      } else {
        const a = new Set(alias.match(/[a-z0-9\u4e00-\u9fff]+/g) ?? [])
        const b = new Set(target.match(/[a-z0-9\u4e00-\u9fff]+/g) ?? [])
        if (a.size && b.size) {
          let shared = 0
          for (const t of a) if (b.has(t)) shared += 1
          if (shared) {
            score = Math.round((shared / Math.max(a.size, b.size)) * 50)
            reason = '词元部分重合'
          }
        }
      }
      if (score > 0 && (!best || score > best.score)) best = { bank, score, reason }
    }
  }
  return best && best.score >= 50 ? best : null
}

/**
 * 为工程的每个歌手名生成 {singer: compID} 映射（供 vpr 写出使用）
 * @returns {{map:object, matches:Array}}
 */
export function buildVoiceMap(project, banks = null) {
  const list = banks ?? getVoices().vocaloid
  const map = {}
  const matches = []
  for (const track of project.tracks ?? []) {
    const singer = track.singer
    if (!singer || map[singer]) continue
    const hit = matchVoice(singer, list)
    if (!hit) continue
    map[singer] = hit.bank.compID
    matches.push({ singer, compID: hit.bank.compID, bankName: hit.bank.name, score: hit.score, reason: hit.reason })
  }
  return { map, matches }
}

export default {
  getVoices,
  invalidateVoiceCache,
  buildVoiceMap,
  matchVoice,
  normalizeName,
  defaultVoiceDirs,
  setUserVoiceDirs,
  getUserVoiceDirs,
}
