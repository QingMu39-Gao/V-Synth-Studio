import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest'

/*
 * 配置的门面。这里钉的是三条**看不出来但改错就坏**的约束：
 *
 *  1. 旧 localStorage 键只在启动时捞一次（`theme` / `glassLevel` 要按「还停在默认值」
 *     才提上来 —— 后端那张迁移表对这两个键恒为「已有」，轮不到它）；
 *  2. `saveConfig` 立刻改内存、250ms 后才落盘，且多次改动合并成一次 `set_config`；
 *  3. 迟到的回包不许覆盖更新的值（打码后的完整配置回灌，靠 generation 挡住）。
 */

const {callMock} = vi.hoisted(() => ({callMock: vi.fn()}))

vi.mock('./ipc', () => ({call: callMock}))

/** 每个用例都要一份新的模块级状态（snapshot / listeners / 防抖计时器都是模块级的）。 */
async function fresh() {
  vi.resetModules()
  return await import('./config')
}

const replied = (config: unknown) => ({config})

beforeEach(() => {
  callMock.mockReset()
  vi.stubGlobal('window', globalThis)
  vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('ensureConfig', () => {
  it('后端是唯一真相：读到的配置立刻可用，重复调用只打一次 IPC', async () => {
    const cfg = await fresh()
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_config') return replied({theme: 'dark', glassLevel: 3})
      throw new Error(`不该调 ${cmd}`)
    })

    expect(cfg.getConfig()).toEqual({})
    expect(await cfg.ensureConfig()).toEqual({theme: 'dark', glassLevel: 3})
    expect(cfg.getConfig()).toEqual({theme: 'dark', glassLevel: 3})

    await cfg.ensureConfig()
    expect(callMock).toHaveBeenCalledTimes(1)
  })

  it('读不到配置也不拦着界面出来：回落到空配置 + 报一句给用户的话', async () => {
    const cfg = await fresh()
    callMock.mockRejectedValue(new Error('IO 错误'))
    const seen: string[] = []
    cfg.onConfigError((m) => seen.push(m))

    await cfg.ensureConfig()

    expect(cfg.getConfig()).toEqual({})
    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('读取配置失败')
    expect(seen[0]).toContain('IO 错误')
  })
})

describe('旧浏览器存储的迁移', () => {
  function stubLegacy(): void {
    const store: Record<string, string> = {'qingmu.theme': 'dark', 'qingmu.glassLevel': '4', '别的键': 'x'}
    vi.stubGlobal('localStorage', {
      length: Object.keys(store).length,
      key: (i: number) => Object.keys(store)[i],
      getItem: (k: string) => store[k] ?? null,
    })
  }

  it('只捞 qingmu. / fandiao. 开头的键，交给后端的迁移命令', async () => {
    const cfg = await fresh()
    stubLegacy()
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_config') return replied({theme: 'system', glassLevel: 2})
      if (cmd === 'migrate_legacy_settings') return replied({})
      if (cmd === 'set_config') return replied({theme: 'dark', glassLevel: 4})
      throw new Error(`不该调 ${cmd}`)
    })

    await cfg.ensureConfig()

    const migrate = callMock.mock.calls.find((c) => c[0] === 'migrate_legacy_settings')
    expect(migrate?.[1]).toEqual({old: {'qingmu.theme': 'dark', 'qingmu.glassLevel': '4'}})
    expect(cfg.getConfig()).toEqual({theme: 'dark', glassLevel: 4})
  })

  it('只把还停在默认值上的那两项提上来（用户已经改过的绝不动）', async () => {
    const cfg = await fresh()
    stubLegacy()
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_config') return replied({theme: 'light', glassLevel: 2})
      if (cmd === 'migrate_legacy_settings') return replied({})
      if (cmd === 'set_config') return replied({theme: 'light', glassLevel: 4})
      throw new Error(`不该调 ${cmd}`)
    })

    await cfg.ensureConfig()

    const set = callMock.mock.calls.find((c) => c[0] === 'set_config')
    expect(set?.[1]).toEqual({patch: {glassLevel: 4}})
  })

  it('迁移失败不是致命的：保留读到的那份配置', async () => {
    const cfg = await fresh()
    stubLegacy()
    callMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'get_config') return replied({theme: 'system'})
      if (cmd === 'migrate_legacy_settings') throw new Error('后端不认识这个命令')
      throw new Error(`不该调 ${cmd}`)
    })

    await cfg.ensureConfig()

    expect(cfg.getConfig()).toEqual({theme: 'system'})
  })
})

describe('saveConfig', () => {
  it('内存立刻生效，落盘走 250ms 防抖且合并成一次调用', async () => {
    const cfg = await fresh()
    vi.useFakeTimers()
    callMock.mockImplementation(async () => replied({theme: 'dark', glassLevel: 3}))

    cfg.saveConfig({theme: 'dark'})
    expect(cfg.getConfig().theme).toBe('dark')

    cfg.saveConfig({glassLevel: 3})
    await vi.advanceTimersByTimeAsync(249)
    expect(callMock).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(callMock).toHaveBeenCalledTimes(1)
    expect(callMock.mock.calls[0][1]).toEqual({patch: {theme: 'dark', glassLevel: 3}})
  })

  it('后端回的是打码后的完整配置，用它替掉内存那份', async () => {
    const cfg = await fresh()
    vi.useFakeTimers()
    callMock.mockImplementation(async () => replied({neteaseCookie: '****'}))

    cfg.saveConfig({neteaseCookie: 'MUSIC_U=真凭据'})
    await vi.advanceTimersByTimeAsync(250)

    expect(cfg.getConfig()).toEqual({neteaseCookie: '****'})
  })

  it('迟到的回包不覆盖更新的值', async () => {
    const cfg = await fresh()
    vi.useFakeTimers()
    const pendingReplies: ((v: unknown) => void)[] = []
    callMock.mockImplementation(() => new Promise((resolve) => { pendingReplies.push(resolve) }))

    cfg.saveConfig({theme: 'dark'})
    await vi.advanceTimersByTimeAsync(250)      // 第一次落盘，回包还挂着

    cfg.saveConfig({glassLevel: 4})             // 更晚的一次改动
    pendingReplies[0](replied({theme: 'system'}))   // 旧回包现在才回来
    await vi.advanceTimersByTimeAsync(0)

    expect(cfg.getConfig().theme).toBe('dark')
    expect(cfg.getConfig().glassLevel).toBe(4)
  })

  it('保存失败时报一句，但内存那份不回滚', async () => {
    const cfg = await fresh()
    vi.useFakeTimers()
    callMock.mockRejectedValue(new Error('磁盘只读'))
    const seen: string[] = []
    cfg.onConfigError((m) => seen.push(m))

    cfg.saveConfig({outputDir: 'D:\\out'})
    await vi.advanceTimersByTimeAsync(250)

    expect(seen).toHaveLength(1)
    expect(seen[0]).toContain('保存设置失败')
    expect(cfg.getConfig().outputDir).toBe('D:\\out')
  })
})

describe('syncConfig / 订阅', () => {
  it('只合并内存、不落盘（写操作一律走 saveConfig）', async () => {
    const cfg = await fresh()

    cfg.syncConfig({neteaseCookieExpire: 123})
    cfg.syncConfig(undefined)

    expect(callMock).not.toHaveBeenCalled()
    expect(cfg.getConfig()).toEqual({neteaseCookieExpire: 123})
  })

  it('onConfigChange 还回退订函数（不回就会随每次挂载叠一份回调）', async () => {
    const cfg = await fresh()
    let hits = 0
    const off = cfg.onConfigChange(() => { hits += 1 })

    cfg.syncConfig({a: 1})
    expect(hits).toBe(1)

    off()
    cfg.syncConfig({a: 2})
    expect(hits).toBe(1)
  })
})
