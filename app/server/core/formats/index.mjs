/**
 * 格式注册表
 *
 * 每个格式模块位于同目录 <id>.mjs，导出 { meta, fidelity, read, write }。
 * 见 docs/FORMAT-MODULE-BRIEF.md。
 */

/**
 * 顺序即 UI 中的展示顺序；group 用于界面分组。
 * available=false 表示尚未实现（占位，UI 中会置灰）。
 */
export const FORMAT_DEFS = [
  // —— VOCALOID 系 ——
  { id: 'vsqx', name: 'VOCALOID3/4 工程', vendor: 'Yamaha', exts: ['.vsqx'], group: 'VOCALOID', kind: 'xml' },
  { id: 'vpr', name: 'VOCALOID5/6 工程', vendor: 'Yamaha', exts: ['.vpr'], group: 'VOCALOID', kind: 'zip' },
  { id: 'vsq', name: 'VOCALOID2 工程', vendor: 'Yamaha', exts: ['.vsq'], group: 'VOCALOID', kind: 'xml' },
  // —— UTAU 系 ——
  { id: 'ustx', name: 'OpenUtau 工程', vendor: 'OpenUtau', exts: ['.ustx'], group: 'UTAU', kind: 'yaml' },
  { id: 'ust', name: 'UTAU 工程', vendor: 'UTAU', exts: ['.ust'], group: 'UTAU', kind: 'text' },
  // —— 其它编辑器 ——
  { id: 'svp', name: 'Synthesizer V 工程', vendor: 'Dreamtonics', exts: ['.svp'], group: '合成器', kind: 'json' },
  { id: 'ccs', name: 'CeVIO 工程', vendor: 'CeVIO', exts: ['.ccs'], group: '合成器', kind: 'json' },
  // .acep / .dv 是二进制容器（不是 JSON）
  { id: 'acep', name: 'ACE Studio 工程', vendor: 'ACE Studio', exts: ['.acep'], group: '合成器', kind: 'binary' },
  { id: 'dv', name: 'DeepVocal 工程', vendor: 'DeepVocal', exts: ['.dv'], group: '合成器', kind: 'binary' },
  // —— 通用交换格式 ——
  { id: 'midi', name: 'MIDI 文件', vendor: '通用', exts: ['.mid', '.midi'], group: '通用', kind: 'binary' },
  { id: 'musicxml', name: 'MusicXML', vendor: '通用', exts: ['.musicxml', '.xml'], group: '通用', kind: 'xml' },
  { id: 'ufdata', name: 'UtaFormatix 数据', vendor: 'UtaFormatix', exts: ['.ufdata', '.json'], group: '通用', kind: 'json' },
]

const cache = new Map()

/** 动态加载格式模块；文件不存在时抛出可读错误 */
export async function loadFormat(id) {
  if (cache.has(id)) return cache.get(id)
  const def = FORMAT_DEFS.find((f) => f.id === id)
  if (!def) throw new Error(`未知格式：${id}`)
  let mod
  try {
    mod = await import(`./${id}.mjs`)
  } catch (err) {
    if (err && (err.code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module/.test(String(err.message)))) {
      throw new Error(`格式「${def.name}」的转换模块尚未安装（缺少 formats/${id}.mjs）`)
    }
    throw err
  }
  const entry = {
    ...def,
    ...(mod.meta ?? {}),
    fidelity: mod.fidelity ?? { preserves: [], drops: [], notes: '' },
    // 格式模块可声明自测框架需要跳过的通用比对项（仅限该格式无法表达的能力，
    // 例如 MusicXML 的音高曲线），fidelity.drops 必须同时如实声明
    __skipChecks: mod.__skipChecks ?? [],
    read: mod.read,
    write: mod.write,
  }
  if (typeof entry.read !== 'function' || typeof entry.write !== 'function') {
    throw new Error(`格式模块 ${id} 未正确导出 read/write`)
  }
  cache.set(id, entry)
  return entry
}

/** 当前真正可用的格式（用于 UI 展示） */
export async function listFormats() {
  const out = []
  for (const def of FORMAT_DEFS) {
    try {
      const f = await loadFormat(def.id)
      const canRead = f.canRead !== false
      const canWrite = f.canWrite !== false
      /*
       * 关键：模块「能加载」不等于「能用」。
       * acep / dv / vsq 这三个模块是如实标注的不支持实现——它们能正常 import，
       * 但 read/write 一调用就抛中文说明。若这里把 available 直接写成 true，
       * 界面会把它们显示成绿色可用，用户点了才发现用不了。
       */
      const usable = canRead || canWrite
      out.push({
        id: f.id,
        name: f.name,
        vendor: f.vendor,
        exts: f.exts,
        group: f.group,
        kind: f.kind,
        canRead,
        canWrite,
        writeExt: f.writeExt ?? f.exts[0],
        fidelity: f.fidelity,
        available: usable,
        reason: usable ? undefined : (f.fidelity?.notes ?? '该格式暂不支持'),
      })
    } catch (err) {
      out.push({ ...def, available: false, reason: String(err.message ?? err) })
    }
  }
  return out
}

/** 按扩展名或内容特征猜测格式 */
export function guessFormatByExt(filename) {
  const lower = String(filename).toLowerCase()
  const idx = lower.lastIndexOf('.')
  if (idx < 0) return null
  const ext = lower.slice(idx)
  // .json 需要靠内容判断，交由调用方处理
  const hit = FORMAT_DEFS.find((f) => f.exts.includes(ext) && ext !== '.json')
  return hit ? hit.id : null
}

/** 通过文件内容特征猜测（处理 .json / .vpr 之类的歧义或容器格式） */
export function guessFormatByContent(buffer, filename = '') {
  const byExt = guessFormatByExt(filename)
  if (byExt) return byExt

  // ZIP 容器优先判断：.vpr 就是一个 zip 包（内含 Project/sequence.json）
  if (buffer.length > 4 && buffer[0] === 0x50 && buffer[1] === 0x4b) {
    const scan = buffer.subarray(0, Math.min(buffer.length, 64 * 1024)).toString('latin1')
    if (scan.includes('sequence.json') || scan.includes('Project/') || scan.includes('Project\\')) return 'vpr'
    if (/acep|ACEStudio|ACE_Studio/i.test(scan)) return 'acep'
    return null
  }

  const head = buffer.subarray(0, 4096).toString('utf8').replace(/^\uFEFF/, '')
  const trimmed = head.trimStart()
  if (trimmed.startsWith('<?xml')) {
    if (trimmed.includes('vsq4') || trimmed.includes('vocaloid')) return 'vsqx'
    if (trimmed.includes('vsq3') || trimmed.includes('VOCALOID2')) return 'vsq'
    if (trimmed.includes('score-partwise') || trimmed.includes('score-timewise')) return 'musicxml'
    return 'vsqx'
  }
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    if (head.includes('"vocaloid"') && head.includes('"version"')) return 'vpr'
    if (head.includes('"tracks"') && head.includes('"library"')) return 'svp'
    if (head.includes('"formatVersion"') && head.includes('"project"')) return 'ufdata'
    if (head.includes('"TalkData"') || head.includes('"SongData"') || head.includes('"Casts"')) return 'ccs'
    if (head.includes('"formatVersion"') && head.includes('"tempos"')) return 'ufdata'
    return null
  }
  if (trimmed.startsWith('[#VERSION]') || trimmed.includes('[#SETTING]')) return 'ust'
  if (/^name:/.test(trimmed) || trimmed.includes('ustx_version')) return 'ustx'
  if (buffer.subarray(0, 4).toString('latin1') === 'MThd') return 'midi'
  return null
}

export default { FORMAT_DEFS, loadFormat, listFormats, guessFormatByExt, guessFormatByContent }
