import {beforeEach, describe, expect, it, vi} from 'vitest'

/*
 * 界面文案。`translate` 的兜底是「查不到就把原文显示出来」（中文是词条的键），
 * 所以词条漏一列**不会报错** —— 只会在那个语言的界面上静默显示中文。
 * 这里钉住三件事：三语齐全、查不到时的兜底、语言取值只认三个。
 */

const {state} = vi.hoisted(() => ({
  state: {
    cfg: {} as Record<string, unknown>,
    saved: [] as Record<string, unknown>[],
    listeners: new Set<() => void>(),
  },
}))

vi.mock('./config', () => ({
  getConfig: () => state.cfg,
  onConfigChange: (cb: () => void) => {
    state.listeners.add(cb)
    return () => state.listeners.delete(cb)
  },
  saveConfig: (patch: Record<string, unknown>) => { state.saved.push(patch) },
}))

const {DICT, getUiLanguage, setUiLanguage, translate} = await import('./i18n')

beforeEach(() => {
  state.cfg = {}
  state.saved = []
  state.listeners.clear()
})

describe('DICT', () => {
  it('每个词条三语都有，且都不是空串', () => {
    const missing: string[] = []
    for (const [key, langs] of Object.entries(DICT)) {
      for (const lang of ['zh-CN', 'en-US', 'ja-JP'] as const) {
        if (!langs[lang]) missing.push(`${key} → ${lang}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('中文那一列就是键本身（查不到时显示的正是它）', () => {
    const drift = Object.entries(DICT).filter(([key, langs]) => langs['zh-CN'] !== key).map(([k]) => k)
    expect(drift).toEqual([])
  })
})

describe('translate', () => {
  it('按语言取值，查不到就把原文还回去', () => {
    expect(translate('设置', 'zh-CN')).toBe('设置')
    expect(translate('设置', 'en-US')).toBe('Settings')
    expect(translate('设置', 'ja-JP')).toBe('設定')
    expect(translate('这个词条不存在', 'en-US')).toBe('这个词条不存在')
  })

  it('不传语言时用当前界面语言', () => {
    state.cfg = {language: 'ja-JP'}
    expect(translate('主题')).toBe(DICT['主题']['ja-JP'])
  })
})

describe('语言取值', () => {
  it('只认三个取值，其余（含没设过、被写坏）一律回简中', () => {
    state.cfg = {}
    expect(getUiLanguage()).toBe('zh-CN')
    state.cfg = {language: 'en-US'}
    expect(getUiLanguage()).toBe('en-US')
    state.cfg = {language: 'ja-JP'}
    expect(getUiLanguage()).toBe('ja-JP')
    state.cfg = {language: 'fr-FR'}
    expect(getUiLanguage()).toBe('zh-CN')
  })

  it('切语言就是存一项配置（唯一真相在后端）', () => {
    setUiLanguage('en-US')
    expect(state.saved).toEqual([{language: 'en-US'}])
  })
})
