/**
 * VOCALOID2 工程（.vsq）
 *
 * 结论：暂未实现读写。本文件如实说明原因、可行替代方案，以及需要什么才能补上。
 *
 * ── 查证结果（结构已查清，但缺少可验证的样本）──
 * `.vsq` **不是一个文本文件，也不是 XML**，而是一个 **MIDI 文件（SMF）**：
 *   1) 用标准 MIDI 解析器读它，能拿到 MThd / MTrk；
 *   2) 真正的工程文本被切成若干段，作为 **meta 事件**藏在 MIDI 轨道里
 *      （对应实现里的 `extractVsqTextsFromMetaEvents`）；
 *   3) 取出的文本是 `[#0000]` / `[#SETTING]` 风格的段式结构，字段名如 `PreMeasure=`、
 *      `Length=`、`NoteNum=`、`Lyric=`、`PitchBend=` 等，与 UTAU 的 .ust 类似但取值语义不同；
 *   4) 文本编码通常是 **Shift-JIS**（CP932），纯 Node 无法生成，需要走 PowerShell 转码。
 *
 * 也就是说：解析它需要「MIDI 容器解析 + 文本段解析 + Shift-JIS 双向转码」三层，
 * 其中任何一层的字段语义搞错，都会产出「看起来能用、实际音符全错」的工程。
 *
 * ── 为什么现在不做 ──
 * 本机（工作站目录、桌面、文档、下载、样本目录、VOCALOID6 安装目录）**没有任何 .vsq 样本**，
 * 无法核对字段与取值口径。宁可如实标记不支持，也不写出一个会让用户以为能用、实际打不开的模块。
 *
 * ── 现在就能用的替代路径（推荐）──
 * `.vsq` 是 VOCALOID2 的老格式，而本机装的是 VOCALOID6：
 *   用 VOCALOID6 打开 .vsq（它支持导入），另存为 **.vpr** 或 **.vsqx**，
 *   再进本工作站转换 —— VOCALOID6 自己做的解析一定比第三方猜测准确。
 * 同理，VOCALOID4 Editor 也能打开 .vsq 并另存为 .vsqx。
 *
 * ── 怎样启用 ──
 * 把一个 `.vsq` 文件放进 `tests/samples/`（命名以 `sample-` 或 `real-sample-` 开头），
 * 读取实现即可据此补齐；由于该格式是 MIDI 容器，MIDI 模块（`midi.mjs`）已经能复用其容器解析部分。
 */

export const meta = {
  id: 'vsq',
  name: 'VOCALOID2 工程',
  vendor: 'Yamaha',
  exts: ['.vsq'],
  kind: 'binary',
  canRead: false,
  canWrite: false,
  writeExt: '.vsq',
  encoding: 'binary',
}

export const fidelity = {
  preserves: [],
  drops: ['全部内容（尚未实现）'],
  notes:
    '暂不支持：.vsq 实为「MIDI 容器 + 内嵌段式文本（Shift-JIS）」的复合结构，字段语义需要真实样本核对。' +
    '替代方案：用 VOCALOID6 / VOCALOID4 Editor 打开 .vsq 并另存为 .vpr 或 .vsqx，再进本工作站转换。',
}

const READ_REASON =
  '尚未支持读取 VOCALOID2 工程（.vsq）。原因：.vsq 是「MIDI 容器 + 内嵌 Shift-JIS 段式文本」的复合结构，' +
  '字段取值语义需要真实样本核对，而本机没有任何 .vsq 样本可用。' +
  '可行的替代做法：用 VOCALOID6（或 VOCALOID4 Editor）打开该 .vsq 并另存为 .vpr / .vsqx，再转换。'

const WRITE_REASON =
  '尚未支持写出 VOCALOID2 工程（.vsq）。原因：需要同时生成 MIDI 容器与 Shift-JIS 段式文本，' +
  '且没有样本可验证生成结果能否被 VOCALOID2 打开。' +
  '如果目标是老编辑器，建议改写出 .vsqx（VOCALOID3/4 可读）或 .ust（UTAU 可读）。'

export function read() {
  throw new Error(`${READ_REASON} 如能提供一个 .vsq 样本（放入 tests/samples/），即可补齐读取实现。`)
}

export function write() {
  throw new Error(`${WRITE_REASON} 需要写出时请改用 .vsqx / .vpr / .ufdata 等格式。`)
}

export default { meta, fidelity, read, write }
