/**
 * 「从文件导入 LRC」的端到端验证
 *
 *   node tests/manual/lyrics-import-verify.mjs [port]
 *
 * 起一个测试实例（和契约测试一样用 --serve，不动窗口那套）：
 *   app\desktop\target\debug\qingmu-workstation.exe --serve --port=8891
 *
 * 验的是三件事：
 *   1. 编码：UTF-8 照读，GBK 自动转（国内老歌词很多是 GBK，硬按 UTF-8 读就是乱码）
 *   2. 译文拆分：`原文 / 译文` 与「前后两段同时间轴」都认；拆不出来整份当原文
 *   3. 导入之后能和搜索来的歌词一样走保存流程（source=file 不该被后端拒绝）
 *
 * 脚本自己会写测试文件（临时目录），跑完删掉。
 */

import { writeFileSync, readFileSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const PORT = Number(process.argv[2] ?? 0) || 8891
const BASE = `http://127.0.0.1:${PORT}`
const TMP = join(tmpdir(), 'qingmu-import-verify')

let pass = 0
let fail = 0
const ok = (name, extra = '') => { pass++; console.log(`  [通过] ${name}${extra ? ' —— ' + extra : ''}`) }
const bad = (name, why) => { fail++; console.log(`  [失败] ${name} —— ${why}`) }

async function post(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  })
  return { status: res.status, data: await res.json() }
}

/* ── 测试文件 ───────────────────────────────────────────────── */

const UTF8_LRC = [
  '[ti:测试双语]',
  '[ar:清沐]',
  '[00:01.00]第一句原文 / First line',
  '[00:03.50]第二句原文 / Second line',
  '[00:06.20]这句没有译文',
  '[00:09.00]第四句原文 / Fourth line',
].join('\n')

const DUAL_LRC = [
  '[ti:双时间轴]',
  '[00:01.00]原文一',
  '[00:03.00]原文二',
  '[00:01.00]译文一',
  '[00:03.00]译文二',
].join('\n')

/** 只有个别行带斜杠：不是双语，整份当原文（`AC/DC` 不该被拆断） */
const SLASH_LRC = ['[00:01.00]AC/DC', '[00:03.00]Back in Black', '[00:05.00]Highway to Hell'].join('\n')

const files = {}

function setup() {
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(TMP, { recursive: true })

  files.utf8 = join(TMP, '测试-双语行内.lrc')
  writeFileSync(files.utf8, UTF8_LRC, 'utf8')

  files.gbk = join(TMP, '测试-GBK.lrc')
  // GBK(936) 字节：Node 没有内置编码器，这里手工给出「故事的小黄花」等字的 GBK 编码
  const gbkText = '[00:01.00]故事的小黄花\n[00:05.00]从出生那年就飘着\n'
  writeFileSync(files.gbk, Buffer.from(gbkBytes(gbkText)))

  files.dual = join(TMP, '测试-双时间轴.lrc')
  writeFileSync(files.dual, DUAL_LRC, 'utf8')

  files.slash = join(TMP, '测试-斜杠不是双语.lrc')
  writeFileSync(files.slash, SLASH_LRC, 'utf8')

  files.plain = join(TMP, '不是歌词.txt')
  writeFileSync(files.plain, '这不是歌词，只是一段话。\n', 'utf8')
}

/**
 * 把字符串按 GBK 编成字节。只覆盖本测试用到的那几个字 ——
 * 为一句话引一个编码表不值得（真要全表就用 PowerShell 的 GetEncoding(936)）。
 */
const GBK_TABLE = {
  故: [0xb9, 0xca], 事: [0xca, 0xc2], 的: [0xb5, 0xc4], 小: [0xd0, 0xa1], 黄: [0xbb, 0xc6],
  花: [0xbb, 0xa8], 从: [0xb4, 0xd3], 出: [0xb3, 0xf6], 生: [0xc9, 0xfa], 那: [0xc4, 0xc7],
  年: [0xc4, 0xea], 就: [0xbe, 0xcd], 飘: [0xc6, 0xae], 着: [0xd7, 0xc5],
}

function gbkBytes(text) {
  const out = []
  for (const ch of text) {
    const pair = GBK_TABLE[ch]
    if (pair) out.push(...pair)
    else if (ch.charCodeAt(0) < 128) out.push(ch.charCodeAt(0))
    else throw new Error(`GBK_TABLE 里没有「${ch}」`)
  }
  return out
}

/* ── 主流程 ─────────────────────────────────────────────────── */

try {
  setup()
  console.log(`目标：${BASE}\n测试文件：${TMP}\n`)

  /* ① UTF-8 + 行内双语 */
  const a = await post('/api/lyrics/import', { path: files.utf8 })
  const A = a.data
  if (a.status === 200 && A.ok) ok('UTF-8 文件能导入', `encoding=${A.encoding}`)
  else bad('UTF-8 文件导入失败', JSON.stringify(A))

  if (A.source === 'file') ok('source 标成 file（前端据此显示「本地文件」）')
  else bad('source 不对', A.source)
  if (A.song?.name === '测试-双语行内') ok('歌名取自文件名（去掉 .lrc）', A.song.name)
  else bad('歌名不对', JSON.stringify(A.song?.name))
  if (A.encoding === 'utf-8') ok('编码如实回报 utf-8')
  else bad('encoding 不对', A.encoding)

  if (A.lyric.includes('[ti:测试双语]') && A.lyric.includes('[00:01.00]第一句原文')) {
    ok('原文：元信息行保留、译文从原文里摘干净')
  } else {
    bad('原文不对', JSON.stringify(A.lyric))
  }
  if (A.lyric.includes('[00:06.20]这句没有译文')) ok('没有译文的那行原样留在原文里')
  else bad('没译文的那行丢了', JSON.stringify(A.lyric))

  const transLines = A.trans.split('\n').filter((l) => l.trim())
  if (transLines.length === 3 && transLines[0] === '[00:01.00]First line') {
    ok('译文拆出 3 行，时间戳沿用原文写法', transLines.join(' / '))
  } else {
    bad('译文拆得不对', JSON.stringify(A.trans))
  }

  /* ② GBK */
  const b = await post('/api/lyrics/import', { path: files.gbk })
  const B = b.data
  if (B.encoding === 'gbk') ok('GBK 文件被认出来并按 GBK 读', 'encoding=gbk')
  else bad('GBK 没认出来', `encoding=${B.encoding} lyric=${JSON.stringify(B.lyric)}`)
  if (B.lyric.includes('[00:01.00]故事的小黄花') && B.lyric.includes('[00:05.00]从出生那年就飘着')) {
    ok('GBK 中文逐字读对，没有乱码')
  } else {
    bad('GBK 读出来是乱的', JSON.stringify(B.lyric))
  }
  if (!B.lyric.includes('\uFFFD')) ok('没有替换字符（U+FFFD）')
  else bad('出现了替换字符', JSON.stringify(B.lyric))
  if (B.trans === '') ok('GBK 那份没有译文 → trans 为空，不报错')
  else bad('没有译文却给了 trans', JSON.stringify(B.trans))

  /* ③ 双时间轴 */
  const c = await post('/api/lyrics/import', { path: files.dual })
  const C = c.data
  const cOrig = C.lyric.split('\n').filter((l) => /^\[0/.test(l))
  const cTrans = C.trans.split('\n').filter((l) => /^\[0/.test(l))
  if (cOrig.length === 2 && cOrig[0] === '[00:01.00]原文一' && cTrans.length === 2 && cTrans[0] === '[00:01.00]译文一') {
    ok('两段同时间轴：前一半当原文、后一半当译文', `${cOrig.join(' / ')} ‖ ${cTrans.join(' / ')}`)
  } else {
    bad('双时间轴没拆对', `原文=${JSON.stringify(C.lyric)} 译文=${JSON.stringify(C.trans)}`)
  }

  /* ④ 拆不出来就整份当原文（不报错、不改坏） */
  const d = await post('/api/lyrics/import', { path: files.slash })
  const D = d.data
  if (D.ok && D.trans === '' && D.lyric.includes('AC/DC')) ok('个别行带斜杠不当双语，AC/DC 没被拆断')
  else bad('把 AC/DC 拆坏了', JSON.stringify(D))

  /* ⑤ 错误路径：能自己处理的事给 400 + 一句人话 */
  const cases = [
    ['文件不存在', { path: join(TMP, '没有这个文件.lrc') }],
    ['路径为空', { path: '' }],
    ['传的是目录', { path: TMP }],
    ['没有时间轴的文件', { path: files.plain }],
  ]
  for (const [name, body] of cases) {
    const r = await post('/api/lyrics/import', body)
    if (r.status === 400 && r.data.ok === false && typeof r.data.error === 'string' && r.data.error.length > 4) {
      ok(`${name} → 400 + 说明`, r.data.error)
    } else {
      bad(`${name} 的响应不对`, `HTTP ${r.status} ${JSON.stringify(r.data)}`)
    }
  }

  /* ⑥ 导入的歌词照样能走保存流程（这是「和搜到一首歌之后的状态一致」的关键） */
  const outDir = TMP
  const s = await post('/api/lyrics/save', {
    source: A.source, id: A.id, lyric: A.lyric, trans: A.trans, durationSec: 0,
    format: 'lrc', bilingual: true, outDir, name: A.song.name,
  })
  if (s.data.ok) ok('导入的歌词能存成 LRC（source=file 不被拒）', s.data.name)
  else bad('保存失败', JSON.stringify(s.data))

  if (s.data.ok) {
    const txt = readFileSync(s.data.path, 'utf8')
    if (txt.includes('[00:01.00]第一句原文') && txt.includes('[00:01.00]First line')) {
      ok('存出来的 LRC 是双语（原文 + 同时间戳译文）')
    } else {
      bad('存出来的 LRC 不对', JSON.stringify(txt.slice(0, 200)))
    }
  }

  const s2 = await post('/api/lyrics/save', {
    source: A.source, lyric: A.lyric, trans: A.trans, format: 'srt', bilingual: true, outDir, name: '导入验证-srt',
  })
  if (s2.data.ok) ok('也能存成 SRT', s2.data.name)
  else bad('存 SRT 失败', JSON.stringify(s2.data))
} catch (err) {
  bad('验证过程出错', err.message)
} finally {
  rmSync(TMP, { recursive: true, force: true })
}

console.log('')
console.log(fail === 0 ? `全部通过：${pass} 项` : `${pass} 项通过，${fail} 项失败`)
// 不用 process.exit：fetch 的连接还挂着，硬退出会触发 libuv 的 teardown 断言
process.exitCode = fail === 0 ? 0 : 1
