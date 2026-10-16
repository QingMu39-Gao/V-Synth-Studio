import {describe, expect, it} from 'vitest'
import type {UpdateCheck} from './api'
import {canDownloadInstaller, installerOf, installerSizeText, shouldNotifyUpdate} from './update'

/*
 * 「检查更新」里那几处判断。它们错了都不报错、只是行为不对：
 * 忽略过的版本照弹、上游发的**新**版本被旧忽略值吃掉、或者给一个点了必然失败的下载按钮。
 */

const reply = (over: Partial<UpdateCheck> = {}): UpdateCheck => ({
  ok: true,
  current: '1.4.1beta',
  latest: '1.4.2',
  hasUpdate: true,
  ...over,
})

describe('shouldNotifyUpdate', () => {
  it('真有新版才弹', () => {
    expect(shouldNotifyUpdate(reply(), '')).toBe(true)
    expect(shouldNotifyUpdate(reply({hasUpdate: false}), '')).toBe(false)
    // 连不上/上游没发过 Release 都是这个形状：不打扰
    expect(shouldNotifyUpdate(reply({ok: false, error: '连不上'}), '')).toBe(false)
    expect(shouldNotifyUpdate(null, '')).toBe(false)
    expect(shouldNotifyUpdate(undefined, undefined)).toBe(false)
  })

  it('忽略只吃掉被忽略的那一个版本，再发新的仍然要提醒', () => {
    expect(shouldNotifyUpdate(reply({latest: '1.4.2'}), '1.4.2')).toBe(false)
    expect(shouldNotifyUpdate(reply({latest: '1.4.3'}), '1.4.2')).toBe(true)
    // 前后空格不该让忽略失效
    expect(shouldNotifyUpdate(reply({latest: '1.4.2'}), ' 1.4.2 ')).toBe(false)
    // 忽略值被清成空串 = 取消忽略
    expect(shouldNotifyUpdate(reply({latest: '1.4.2'}), '')).toBe(true)
  })

  it('回包没有版本号时不弹（宁可不说有新版本）', () => {
    expect(shouldNotifyUpdate(reply({latest: ''}), '')).toBe(false)
  })
})

describe('installer 挑选结果的读法', () => {
  it('挑到了才给下载按钮', () => {
    expect(canDownloadInstaller(reply({installer: {url: 'https://x/a.exe', name: 'a.exe'}}))).toBe(true)
    // 这次发布没有本平台的包
    expect(canDownloadInstaller(reply({installer: null}))).toBe(false)
    expect(canDownloadInstaller(reply({}))).toBe(false)
    // 有对象但地址是空串（后端挑到条目却读不出地址）：同样不给
    expect(installerOf(reply({installer: {name: 'a.exe', url: ''}}))).toBeNull()
  })

  it('体积写法固定成 MB，缺了就不显示那一行', () => {
    expect(installerSizeText({size: 153326600})).toBe('146.2 MB')
    expect(installerSizeText({size: 0})).toBe('')
    expect(installerSizeText(null)).toBe('')
  })
})
