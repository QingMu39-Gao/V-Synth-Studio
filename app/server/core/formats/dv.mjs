/**
 * DeepVocal 工程（.dv）
 *
 * 结论：目前无法可靠验证，故标记为不可读、不可写，并在调用时抛出中文说明。
 *
 * 依据（本次调查）：
 *   1) `.dv` 是二进制容器，不是 JSON（格式注册表里的 kind: json 是占位猜测，这里更正为 binary）。
 *      可参考的第三方实现（sdercolin/utaformatix3 的 core/io/Dv.kt、pypi 的 dvfile）显示其布局为
 *      48 字节文件头 + 速度块 + 拍号块 + 轨道块（音轨类型/名称/分段/音符/音高曲线），
 *      但这些都是反向工程结果，没有官方规范，也没有公开的字段级文档。
 *   2) 本机（含 H:\工作站\tests\samples）没有任何 .dv 样本，第三方包内也不附带样本文件，
 *      因此无法验证解析结果是否正确 —— 二进制偏移一旦猜错，会静默产出错误的工程。
 * 按「无法验证的宁可标为不支持」的原则，本模块只提供明确的中文错误，不假装可用。
 */

export const meta = {
  id: 'dv',
  name: 'DeepVocal 工程',
  vendor: 'DeepVocal',
  exts: ['.dv'],
  kind: 'binary',
  canRead: false,
  canWrite: false,
  writeExt: '.dv',
  encoding: 'binary',
}

export const fidelity = {
  preserves: [],
  drops: ['全部内容（尚未实现）'],
  notes:
    '暂不支持：.dv 是 DeepVocal 的二进制工程格式，只有第三方反向工程实现、没有官方规范，' +
    '本机也找不到可用于核对的 .dv 样本。请提供一个真实 .dv 样本以启用读取（写出还需更多样本验证）。',
}

const READ_REASON =
  '尚未支持读取 DeepVocal 工程（.dv）。原因：.dv 是二进制容器格式（文件头 + 速度/拍号/轨道/' +
  '分段/音符/音高数据块），官方没有公开规范，只能参考第三方反向工程的实现；' +
  '本机与样本目录（tests/samples）中都没有 .dv 文件，无法验证解析偏移是否正确。' +
  '为避免静默产出错误工程，本模块暂不解析 .dv。'

const WRITE_REASON =
  '尚未支持写出 DeepVocal 工程（.dv）。原因：二进制布局缺少公开规范，且没有样本可用于验证' +
  '生成文件能否被 DeepVocal 正常打开。'

export function read() {
  throw new Error(`${READ_REASON} 提供一个真实 .dv 样本后即可据此补齐读取实现。`)
}

export function write() {
  throw new Error(`${WRITE_REASON} 需要导出时请改用 .ufdata / .ustx 等格式中转。`)
}

export default { meta, fidelity, read, write }
