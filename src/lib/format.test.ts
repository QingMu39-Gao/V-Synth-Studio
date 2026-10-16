import {describe, expect, it} from 'vitest'
import {baseName, dirName, errText, extOf, formatBytes, formatDuration, formatNumber, stripExt} from './format'

/*
 * 这些函数决定「界面上显示成什么样」，而它们的输入全是后端给的**可能缺失**的字段
 * （未解析的流、没返回时长的条目）。所以断言分两半：正常值的样子，以及缺值/怪值
 * 一律回 `-` 而不是 `NaN` / `undefined` / 空串。
 */

describe('formatBytes', () => {
  it('按 1024 进制换挡，小于 10 的档位多留一位', () => {
    expect(formatBytes(0)).toBe('-')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1024)).toBe('1.00 KB')
    expect(formatBytes(1024 * 1024 * 3.5)).toBe('3.50 MB')
    expect(formatBytes(1024 ** 4 * 20)).toBe('20.0 TB')
  })

  it('缺值 / 负数 / 非数一律回 `-`', () => {
    expect(formatBytes(undefined)).toBe('-')
    expect(formatBytes(null)).toBe('-')
    expect(formatBytes(-1)).toBe('-')
    expect(formatBytes(Number.NaN)).toBe('-')
  })
})

describe('formatDuration', () => {
  it('不足一小时是 m:ss，超过一小时是 h:mm:ss', () => {
    expect(formatDuration(0)).toBe('0:00')
    expect(formatDuration(59)).toBe('0:59')
    expect(formatDuration(61)).toBe('1:01')
    expect(formatDuration(3600)).toBe('1:00:00')
    expect(formatDuration(3725)).toBe('1:02:05')
  })

  it('小时位与分钟位都要补零，秒数取整', () => {
    expect(formatDuration(3660)).toBe('1:01:00')
    expect(formatDuration(59.6)).toBe('1:00')
  })

  it('缺值与负数回 `-`', () => {
    expect(formatDuration(undefined)).toBe('-')
    expect(formatDuration(-1)).toBe('-')
  })
})

describe('formatNumber', () => {
  it('按中文习惯用万 / 亿', () => {
    expect(formatNumber(9999)).toBe('9999')
    expect(formatNumber(10000)).toBe('1.0 万')
    expect(formatNumber(123456789)).toBe('1.2 亿')
  })

  it('缺值回 `-`', () => {
    expect(formatNumber(undefined)).toBe('-')
  })
})

describe('errText', () => {
  it('Error 取 message，其余原样字符串化', () => {
    expect(errText(new Error('连接超时'))).toBe('连接超时')
    expect(errText('boom')).toBe('boom')
    expect(errText(undefined)).toBe('undefined')
  })
})

describe('路径切片', () => {
  it('baseName / dirName 同时认两种分隔符，并忽略末尾分隔符', () => {
    expect(baseName('H:\\音乐\\mv.mp4')).toBe('mv.mp4')
    expect(baseName('/home/u/mv.mp4')).toBe('mv.mp4')
    expect(baseName('H:\\音乐\\')).toBe('音乐')
    expect(dirName('H:\\音乐\\mv.mp4')).toBe('H:\\音乐')
    expect(dirName('/home/u/mv.mp4')).toBe('/home/u')
  })

  it('没有上一级时 dirName 回空串（别把盘符当目录）', () => {
    expect(dirName('mv.mp4')).toBe('')
    expect(dirName('')).toBe('')
    expect(baseName(undefined)).toBe('')
  })

  it('extOf 小写化且不含点，stripExt 只剥最后一段扩展名', () => {
    expect(extOf('MV.MP4')).toBe('mp4')
    expect(extOf('没有扩展名')).toBe('')
    expect(extOf('a.b/c')).toBe('')
    expect(stripExt('mv.mp4')).toBe('mv')
    expect(stripExt('歌词.lrc.bak')).toBe('歌词.lrc')
    expect(stripExt('没有扩展名')).toBe('没有扩展名')
  })
})
