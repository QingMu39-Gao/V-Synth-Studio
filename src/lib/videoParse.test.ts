import {describe, expect, it} from 'vitest'
import type {VideoFormat, VideoParse, VideoStream, VideoStreams} from '@/lib/api'
import {codecOf, countItems, estimateSize, itemList, lockedQualities, mbps, pickDefaults, renderSubDir, riskyCodec} from './videoParse'

/*
 * 解析结果的读法：全是纯函数，但判据来自后端几种**形状不同**的返回（B 站 dash、
 * yt-dlp 的 formats、番剧的 episodes）。这里把每种形状各钉一遍 —— 尤其是
 * 「一批可选项该从哪个字段数」（曾按 formats 数，而 formats 是编码清单不是分 P）。
 */

function stream(over: Partial<VideoStream>): VideoStream {
  return {id: 0, qualityName: '', ...over}
}

function format(over: Partial<VideoFormat>): VideoFormat {
  return {...over}
}

function parse(over: Partial<VideoParse> = {}): VideoParse {
  return {source: 'bilibili', kind: 'video', info: {title: '测试视频'}, ...over}
}

function streams(over: Partial<VideoStreams> = {}): VideoStreams {
  return {mode: 'dash', ...over}
}

describe('estimateSize / mbps', () => {
  it('码率 × 时长换算成体积，缺一项就不显示估算', () => {
    expect(estimateSize(1_000_000, 60)).toBe('≈ 7.15 MB')
    expect(estimateSize(undefined, 60)).toBe('')
    expect(estimateSize(1_000_000, 0)).toBe('')
    expect(estimateSize(0, 60)).toBe('')
  })

  it('百万以上写 Mbps，以下写 kbps', () => {
    expect(mbps(2_500_000)).toBe('2.5 Mbps')
    expect(mbps(128_000)).toBe('128 kbps')
    expect(mbps(0)).toBe('码率未知')
    expect(mbps(undefined)).toBe('码率未知')
  })
})

describe('codecOf / riskyCodec', () => {
  it('按编码串认族名', () => {
    expect(codecOf('hev1.1.6.L120.90')).toBe('HEVC')
    expect(codecOf('av01.0.08M.08')).toBe('AV1')
    expect(codecOf('avc1.640028')).toBe('H.264')
    expect(codecOf('')).toBe('')
    expect(codecOf(undefined)).toBe('')
  })

  it('老编辑器打不开的编码要标出来（H.264 不标）', () => {
    expect(riskyCodec('hev1.1.6')).toBe(true)
    expect(riskyCodec('av01.0.08M.08')).toBe(true)
    expect(riskyCodec('avc1.640028')).toBe(false)
    expect(riskyCodec(undefined)).toBe(false)
  })
})

describe('renderSubDir', () => {
  it('填模板、清洗非法字符、分隔符统一成反斜杠', () => {
    const p = parse({info: {title: 'A/B:C', uploader: 'UP主'}, currentPage: {page: 3}})
    expect(renderSubDir(p, '1080P', '{title}_{uploader}_P{p}_{quality}'))
      .toBe('A\\B_C_UP主_P3_1080P')
  })

  it('认不出的占位符原样留着（不要静默吃掉）', () => {
    expect(renderSubDir(parse(), '1080P', '{title}-{nope}')).toBe('测试视频-{nope}')
  })

  it('空模板回空串（调用方靠它决定要不要建子目录）', () => {
    expect(renderSubDir(parse(), '1080P', '   ')).toBe('')
    expect(renderSubDir(null, '1080P', '')).toBe('')
  })

  it('没解析结果也能渲染：空值替成空串（不是把占位符留下），日期优先 publishDate', () => {
    expect(renderSubDir(null, '', '')).toBe('')
    expect(renderSubDir(null, '', '{title}')).toBe('')
    const p = parse({info: {title: 'T', publishDate: '2026-01-02', uploadDate: '2026-03-04'}})
    expect(renderSubDir(p, '720P', '{date}')).toBe('2026-01-02')
  })

  it('首尾的分隔符不留（否则会建出相对路径）', () => {
    expect(renderSubDir(parse(), '1080P', '\\{title}\\')).toBe('测试视频')
  })
})

describe('countItems', () => {
  it('普通视频按 pages 数，没有 pages 就是 1', () => {
    expect(countItems(null)).toBe(0)
    expect(countItems(parse())).toBe(1)
    expect(countItems(parse({info: {title: 'T', pages: [{page: 1}, {page: 2}, {page: 3}]}}))).toBe(3)
  })

  it('番剧按 episodes 数', () => {
    expect(countItems(parse({kind: 'bangumi', info: {title: 'T', episodes: [{epId: 1}, {epId: 2}]}}))).toBe(2)
  })

  it('yt-dlp 的 formats 不参与计数（那是编码清单，不是分 P）', () => {
    const p = parse({source: 'ytdlp', info: {title: 'T', formats: [format({isVideo: true}), format({isVideo: true})]}})
    expect(countItems(p)).toBe(1)
  })
})

describe('pickDefaults', () => {
  it('同画质优先 AVC，音频优先 192K（id 30280）', () => {
    const p = parse({
      streams: streams({
        video: [stream({id: 120, codecs: 'hev1.1.6', qualityName: '1080P'}), stream({id: 80, codecs: 'avc1.640028', qualityName: '1080P'})],
        audio: [stream({id: 30216, qualityName: '64K'}), stream({id: 30280, qualityName: '192K'})],
      }),
    })
    expect(pickDefaults(p)).toEqual({quality: 80, audio: 30280, formatId: null})
  })

  it('一路 AVC 都没有时退到最高画质（不返回 null 让界面空着）', () => {
    const p = parse({streams: streams({video: [stream({id: 120, codecs: 'hev1.1.6', qualityName: '1080P'})]})})
    expect(pickDefaults(p).quality).toBe(120)
  })

  it('yt-dlp 来源只挑第一条视频格式，画质 / 音轨不适用', () => {
    const p = parse({
      source: 'ytdlp',
      info: {title: 'T', formats: [format({isVideo: false, formatId: '140'}), format({isVideo: true, formatId: '137'})]},
    })
    expect(pickDefaults(p)).toEqual({quality: null, audio: null, formatId: '137'})
  })
})

describe('lockedQualities', () => {
  it('acceptQuality / acceptDescription 是平行数组，只留当前拿不到且 >= 80 的', () => {
    const s = streams({
      video: [stream({id: 64, qualityName: '720P'})],
      acceptQuality: [80, 64, 32],
      acceptDescription: ['1080P', '720P', '480P'],
    })
    expect(lockedQualities(s)).toEqual([{q: 80, name: '1080P'}])
  })

  it('没有 acceptQuality 时退化成按名字认（只报确实缺的那些）', () => {
    const s = streams({
      video: [stream({id: 80, qualityName: '1080P'})],
      acceptDescription: ['1080P', '1080P+', '4K'],
    })
    expect(lockedQualities(s)).toEqual([{q: 999, name: '1080P+'}, {q: 999, name: '4K'}])
  })

  it('没有流时回空数组', () => {
    expect(lockedQualities(null)).toEqual([])
    expect(lockedQualities(undefined)).toEqual([])
  })
})

describe('itemList', () => {
  it('没有结果时两边都空', () => {
    expect(itemList(null)).toEqual({pages: [], season: []})
  })

  it('普通视频摊平成 P1 / P2，当前 P 高亮', () => {
    const p = parse({
      info: {title: 'T', url: 'https://www.bilibili.com/video/BV1', pages: [{page: 1, title: '开场'}, {page: 2}]},
      currentPage: {page: 2},
    })
    const {pages, season} = itemList(p)
    expect(season).toEqual([])
    expect(pages).toEqual([
      {key: 'p1', label: 'P1', title: '开场', durationSec: undefined, url: 'https://www.bilibili.com/video/BV1?p=1', active: false},
      {key: 'p2', label: 'P2', title: '', durationSec: undefined, url: 'https://www.bilibili.com/video/BV1?p=2', active: true},
    ])
  })

  it('番剧摊平成 EP1 / EP2（用 epId 拼链接，不是 cid）', () => {
    const p = parse({
      kind: 'bangumi',
      info: {title: 'T', epId: 222, episodes: [{epId: 111, title: '第一集'}, {epId: 222, longTitle: '第二集长标题'}]},
    })
    expect(itemList(p).pages).toEqual([])
    expect(itemList(p).season).toEqual([
      {key: 'ep111', label: 'EP1', title: '第一集', durationSec: undefined, url: 'https://www.bilibili.com/bangumi/play/ep111', active: false},
      {key: 'ep222', label: 'EP2', title: '第二集长标题', durationSec: undefined, url: 'https://www.bilibili.com/bangumi/play/ep222', active: true},
    ])
  })

  it('合集用 bvid 拼链接，当前集高亮', () => {
    const p = parse({info: {title: 'T', bvid: 'BV2', season: {episodes: [{bvid: 'BV1'}, {bvid: 'BV2'}]}}})
    expect(itemList(p).season).toEqual([
      {key: 'sBV1', label: '第1集', title: '', durationSec: undefined, url: 'https://www.bilibili.com/video/BV1', active: false},
      {key: 'sBV2', label: '第2集', title: '', durationSec: undefined, url: 'https://www.bilibili.com/video/BV2', active: true},
    ])
  })
})
