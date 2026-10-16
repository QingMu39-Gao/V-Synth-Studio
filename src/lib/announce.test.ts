import {describe, expect, it} from 'vitest'
import type {Announcement} from './api'
import {markSeen, unseen} from './announce'

/*
 * 「读过没读过」这两个函数错了都不报错，只是行为不对：同一条公告每次启动都弹，
 * 或者新公告永远不弹。所以两种形状都要钉住。
 */

const a = (id: string, date = ''): Announcement => ({id, title: `标题 ${id}`, date})

describe('unseen', () => {
  it('只留没读过的，并保持后端给的顺序（新的在前）', () => {
    const items = [a('c', '2026-10-01'), a('b', '2026-09-01'), a('a', '2026-08-01')]
    expect(unseen(items, ['a']).map((x) => x.id)).toEqual(['c', 'b'])
    expect(unseen(items, []).map((x) => x.id)).toEqual(['c', 'b', 'a'])
    // 全读过 → 一条都不弹
    expect(unseen(items, ['a', 'b', 'c'])).toEqual([])
  })

  it('空值 / 坏数据不当成「有新公告」', () => {
    expect(unseen(null, null)).toEqual([])
    expect(unseen(undefined, ['x'])).toEqual([])
    // id 是空串的条目：认不出「读过没读过」，与其每次弹不如不弹
    expect(unseen([{id: ''}], [])).toEqual([])
    // 已读清单里的杂项（空串、非字符串）不该让比较炸
    expect(unseen([a('a')], ['', undefined as unknown as string]).map((x) => x.id)).toEqual(['a'])
  })
})

describe('markSeen', () => {
  it('追加到末尾、重复的只留一份（再标一次不会让数组变长）', () => {
    expect(markSeen(['a'], 'b')).toEqual(['a', 'b'])
    expect(markSeen(['a', 'b'], 'a')).toEqual(['b', 'a'])
    expect(markSeen(undefined, 'a')).toEqual(['a'])
  })

  it('封顶：只留最近的那些（这个数组要进 config.json）', () => {
    const many = Array.from({length: 100}, (_, i) => `id${i}`)
    const got = markSeen(many, 'new', 100)
    expect(got.length).toBe(100)
    expect(got.at(-1)).toBe('new')
    expect(got).not.toContain('id0')
  })
})
