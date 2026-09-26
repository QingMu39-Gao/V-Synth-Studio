/**
 * acep 模块专项自测
 *
 * 本模块目前如实标记为「不支持」：断言这一点不会被误改成「看似可用但实际打不开」，
 * 并断言错误信息是中文、说明了原因与所需条件。
 */

import { read, write, meta, fidelity } from '../acep.mjs'

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

  yes(meta.id === 'acep', 'id 应为 acep')
  yes(meta.canRead === false, 'canRead 必须为 false（无公开规范与样本，不能假装可读）')
  yes(meta.canWrite === false, 'canWrite 必须为 false')
  yes(Array.isArray(meta.exts) && meta.exts.includes('.acep'), 'exts 应包含 .acep')
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

  expectChineseError(() => read(Buffer.from('{}')), 'read()', ['.acep', '样本', '原因'])
  expectChineseError(() => write({ tracks: [] }), 'write()', ['.acep', '样本'])

  return { passed, notes }
}
