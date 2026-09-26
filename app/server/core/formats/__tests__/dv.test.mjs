/**
 * dv 模块专项自测
 *
 * 本模块目前如实标记为「不支持」：.dv 是二进制格式，只有第三方反向工程实现，
 * 且本机没有样本可验证。断言这一点以及中文错误说明。
 */

import { read, write, meta, fidelity } from '../dv.mjs'

export default async function run(ctx = {}) {
  const assert =
    ctx.assert ??
    ((cond, label) => {
      if (!cond) throw new Error(label)
    })
  const notes = []
  let passed = 0
  const yes = (cond, label) => {
    passed += 1
    assert(cond, label)
  }

  yes(meta.id === 'dv', 'id 应为 dv')
  yes(meta.canRead === false, 'canRead 必须为 false（二进制格式无样本可验证）')
  yes(meta.canWrite === false, 'canWrite 必须为 false')
  yes(Array.isArray(meta.exts) && meta.exts.includes('.dv'), 'exts 应包含 .dv')
  yes(meta.kind === 'binary', '.dv 是二进制格式，kind 应为 binary（而非 json）')
  yes(typeof fidelity.notes === 'string' && fidelity.notes.length > 0, 'fidelity.notes 应说明限制')
  yes(fidelity.notes.includes('样本'), 'fidelity.notes 应说明需要用户提供样本')

  const expectChineseError = (fn, label, mustInclude) => {
    passed += 1
    let err = null
    try {
      fn()
    } catch (e) {
      err = e
    }
    if (!err) throw new Error(`${label}：应当抛出错误但没有`)
    if (!(err instanceof Error)) throw new Error(`${label}：抛出的不是 Error`)
    if (!/[\u4e00-\u9fa5]/.test(err.message)) throw new Error(`${label}：错误信息不是中文：${err.message}`)
    for (const token of mustInclude) {
      if (!err.message.includes(token)) throw new Error(`${label}：错误信息缺少「${token}」：${err.message}`)
    }
    notes.push(`${label} -> ${err.message}`)
  }

  expectChineseError(() => read(Buffer.alloc(64)), 'read()', ['.dv', '二进制', '样本'])
  expectChineseError(() => write({ tracks: [] }), 'write()', ['.dv'])

  return { passed, notes }
}
