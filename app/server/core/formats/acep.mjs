/**
 * ACE Studio 工程（.acep）
 *
 * 结论：目前无法可靠实现，故标记为不可读、不可写，并在调用时抛出中文说明。
 *
 * 依据（本次调查，只读）：
 *   1) `.acep` 不是纯 JSON，而是专有加密/压缩容器。公开社区工具 flutydeer/AceCompressor
 *      明确以「解密 / 加密」描述 .acep（acedecomp / acecomp），且只支持 ACE Studio 1.7.8
 *      及以后版本保存的工程（更早版本须先用新版另存）。
 *   2) 本机注册表显示已安装 ACE Studio 2.1.8，但 `C:\Program Files\ACE Studio` 目录
 *      实际为空（0 个文件，ACL 允许读取，非权限问题），因此无法从安装目录推断任何字段。
 *   3) 全盘（工作站、桌面、文档、下载、样本目录）未找到任何 .acep 样本。
 * 没有样本就没有可核对的字段名与结构，强行猜测只会产出「看起来能用、实际打不开」的模块，
 * 因此这里如实标记为不支持。
 */

export const meta = {
  id: 'acep',
  name: 'ACE Studio 工程',
  vendor: 'ACE Studio',
  exts: ['.acep'],
  kind: 'binary',
  canRead: false,
  canWrite: false,
  writeExt: '.acep',
  encoding: 'binary',
}

export const fidelity = {
  preserves: [],
  drops: ['全部内容（尚未实现）'],
  notes:
    '暂不支持：.acep 是 ACE Studio 的专有加密/压缩容器，官方未公开字段规范，' +
    '本机安装目录为空且找不到可用于核对的 .acep 样本。请提供一个 .acep 样本' +
    '（若是解密后的 JSON 更好）以启用读写。',
}

const READ_REASON =
  '尚未支持读取 ACE Studio 工程（.acep）。原因：该格式是经过加密/压缩的专有容器，' +
  '官方没有公开字段规范（社区工具需要对 .acep 解密，且只支持 ACE Studio 1.7.8+ 保存的工程）；' +
  '本机 ACE Studio 2.1.8 的安装目录 C:\\Program Files\\ACE Studio 为空，' +
  '工作站与样本目录中也没有 .acep 文件可供核对字段。为避免转换出错，本模块暂不解析 .acep。'

const WRITE_REASON =
  '尚未支持写出 ACE Studio 工程（.acep）。原因：写出需要完整的容器封装（加密/压缩）与' +
  '字段规范，官方均未公开，且本机没有 .acep 样本可用于验证生成结果能否被 ACE Studio 打开。'

export function read() {
  throw new Error(`${READ_REASON} 如能提供一个 .acep 样本，即可据此补齐读取实现。`)
}

export function write() {
  throw new Error(`${WRITE_REASON} 需要写出时请先提供 .acep 样本，或改用 .ufdata / 其它格式中转。`)
}

export default { meta, fidelity, read, write }
