/**
 * B 站解析与下载（原生实现，不依赖 yt-dlp）
 *
 * 支持：
 *  - BV 号 / av 号 / b23.tv 短链 / 番剧 ep 号 / 分P / 合集
 *  - DASH 流解析（视频+音频分离），可选画质与编码
 *  - 官方字幕、弹幕 XML、封面
 *  - 登录 Cookie（SESSDATA）以解锁 1080P+ / 大会员画质
 *  - WBI 签名（不签名会被风控拒绝，HTTP 403 / code -352）
 */

import { createHash } from 'node:crypto'
import { inflateRawSync, inflateSync } from 'node:zlib'
import { basename } from 'node:path'
import { DEFAULT_UA, fetchJson, fetchWithTimeout, resolveRedirect } from './http.mjs'
import { downloadToFile } from './download.mjs'

const API = {
  view: 'https://api.bilibili.com/x/web-interface/view',
  playurl: 'https://api.bilibili.com/x/player/playurl',
  playerV2: 'https://api.bilibili.com/x/player/v2',
  nav: 'https://api.bilibili.com/x/web-interface/nav',
  pgcSeason: 'https://api.bilibili.com/pgc/view/web/season',
  pgcPlayurl: 'https://api.bilibili.com/pgc/player/web/playurl',
  danmakuXml: 'https://api.bilibili.com/x/v1/dm/list.so',
}

/** WBI 混淆表（B 站公开实现约定） */
const MIXIN_KEY_ENC_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49,
  33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61,
  26, 17, 0, 1, 60, 51, 30, 4, 22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36,
  20, 34, 44, 52,
]

/** 画质号 → 中文名 */
export const QUALITY_NAMES = {
  6: '240P 极速',
  16: '360P 流畅',
  32: '480P 清晰',
  64: '720P 高清',
  74: '720P60 高帧率',
  80: '1080P 高清',
  100: '智能修复',
  112: '1080P+ 高码率',
  116: '1080P60 高帧率',
  120: '4K 超清',
  125: 'HDR 真彩',
  126: '杜比视界',
  127: '8K 超高清',
}

/** 音频流 id → 中文名 */
export const AUDIO_NAMES = {
  30216: '64K 低码率',
  30232: '132K 中码率',
  30280: '192K 高码率',
  30250: '杜比全景声',
  30251: 'Hi-Res 无损',
}

const md5 = (s) => createHash('md5').update(s).digest('hex')

function getMixinKey(orig) {
  return MIXIN_KEY_ENC_TAB.map((n) => orig[n]).join('').slice(0, 32)
}

export class BilibiliClient {
  /**
   * @param {{cookie?:string, userAgent?:string, timeout?:number}} opts
   * cookie 可以直接粘贴浏览器里完整的 Cookie 串，或只给 SESSDATA 值
   */
  constructor(opts = {}) {
    this.rawCookie = (opts.cookie ?? '').trim()
    this.userAgent = opts.userAgent ?? DEFAULT_UA
    this.timeout = opts.timeout ?? 20000
    this.wbiCache = null
  }

  get cookie() {
    if (!this.rawCookie) return ''
    // 允许只填 SESSDATA 的值
    if (!this.rawCookie.includes('=')) return `SESSDATA=${this.rawCookie}`
    return this.rawCookie
  }

  get hasLogin() {
    return /SESSDATA=/.test(this.cookie)
  }

  headers(extra = {}) {
    const h = {
      'User-Agent': this.userAgent,
      Referer: 'https://www.bilibili.com/',
      Origin: 'https://www.bilibili.com',
      ...extra,
    }
    if (this.cookie) h.Cookie = this.cookie
    return h
  }

  /* ------------------------------------------------------------ WBI */

  async getWbiKeys() {
    if (this.wbiCache && Date.now() - this.wbiCache.at < 3600_000) return this.wbiCache
    const json = await fetchJson(API.nav, { headers: this.headers(), timeout: this.timeout })
    const imgUrl = json?.data?.wbi_img?.img_url ?? ''
    const subUrl = json?.data?.wbi_img?.sub_url ?? ''
    if (!imgUrl || !subUrl) throw new Error('无法获取 WBI 密钥（B 站接口返回异常）')
    const pick = (u) => basename(u).split('.')[0]
    const keys = { imgKey: pick(imgUrl), subKey: pick(subUrl), at: Date.now() }
    this.wbiCache = keys
    return keys
  }

  /** 给参数加上 wts 与 w_rid 签名 */
  async signParams(params) {
    const { imgKey, subKey } = await this.getWbiKeys()
    const mixinKey = getMixinKey(imgKey + subKey)
    const wts = Math.round(Date.now() / 1000)
    const all = { ...params, wts }
    const query = Object.keys(all)
      .sort()
      .map((k) => {
        const v = String(all[k]).replace(/[!'()*]/g, '')
        return `${encodeURIComponent(k)}=${encodeURIComponent(v)}`
      })
      .join('&')
    return `${query}&w_rid=${md5(query + mixinKey)}`
  }

  async apiGet(url, params = {}, opts = {}) {
    const signed = await this.signParams(params)
    const full = `${url}?${signed}`
    const json = await fetchJson(full, { headers: this.headers(opts.headers), timeout: this.timeout })
    if (json.code !== 0) {
      throw new Error(`B 站接口错误 ${json.code}：${json.message ?? '未知错误'}${json.code === -352 ? '（可能触发了风控，请稍后重试或填写 Cookie）' : ''}`)
    }
    return json
  }

  /* -------------------------------------------------------- 输入解析 */

  /**
   * 解析用户输入的各种链接/编号
   * @returns {Promise<{kind:'video'|'bangumi'|'unknown', bvid?:string, aid?:number, epId?:number, seasonId?:number, page?:number, raw:string, normalized:string}>}
   */
  async parseInput(raw) {
    const input = String(raw).trim()
    if (!input) throw new Error('请输入视频链接或 BV 号')

    // 短链展开
    let url = input
    if (/^https?:\/\/b23\.tv\//i.test(input) || /^b23\.tv\//i.test(input)) {
      const full = input.startsWith('http') ? input : `https://${input}`
      url = await resolveRedirect(full, { headers: this.headers(), timeout: 12000 })
    }

    // 番剧
    const epMatch = url.match(/\/bangumi\/play\/ep(\d+)/i)
    if (epMatch) return { kind: 'bangumi', epId: Number(epMatch[1]), raw: input, normalized: url }
    const ssMatch = url.match(/\/bangumi\/play\/ss(\d+)/i)
    if (ssMatch) return { kind: 'bangumi', seasonId: Number(ssMatch[1]), raw: input, normalized: url }

    // 普通视频
    const bvMatch = url.match(/(BV[0-9A-Za-z]{10})/)
    const avMatch = url.match(/\/video\/av(\d+)/i) ?? url.match(/^av(\d+)$/i)
    const pageMatch = url.match(/[?&]p=(\d+)/i)

    if (bvMatch) {
      return { kind: 'video', bvid: bvMatch[1], page: pageMatch ? Number(pageMatch[1]) : 1, raw: input, normalized: url }
    }
    if (avMatch) {
      return { kind: 'video', aid: Number(avMatch[1]), page: pageMatch ? Number(pageMatch[1]) : 1, raw: input, normalized: url }
    }
    if (/^\d+$/.test(input)) {
      return { kind: 'video', aid: Number(input), page: 1, raw: input, normalized: url }
    }
    throw new Error('无法识别的链接。支持：BV 号、av 号、b23.tv 短链、bilibili.com/video/... 、番剧 ep/ss 链接')
  }

  /* ---------------------------------------------------------- 视频信息 */

  /** 获取视频信息（含分P、合集） */
  async getVideoInfo({ bvid, aid }) {
    const params = bvid ? { bvid } : { aid }
    const json = await this.apiGet(API.view, params)
    const d = json.data
    const pages = (d.pages ?? []).map((p) => ({
      cid: p.cid,
      page: p.page,
      title: p.part || `P${p.page}`,
      durationSec: p.duration,
      width: p.dimension?.width,
      height: p.dimension?.height,
    }))

    // 合集
    let season = null
    const sections = d.ugc_season?.sections ?? []
    if (sections.length || d.ugc_season) {
      season = {
        id: d.ugc_season?.id,
        title: d.ugc_season?.title ?? '',
        episodes: sections.flatMap((s) =>
          (s.episodes ?? []).map((e) => ({
            bvid: e.bvid,
            aid: e.aid,
            cid: e.cid,
            title: e.title || e.arc?.title || '',
            durationSec: e.arc?.duration ?? e.pages?.[0]?.duration ?? 0,
          })),
        ),
      }
    }

    return {
      kind: 'video',
      bvid: d.bvid,
      aid: d.aid,
      title: d.title,
      cover: d.pic,
      desc: d.desc ?? '',
      durationSec: d.duration,
      publishDate: d.pubdate ? new Date(d.pubdate * 1000).toISOString().slice(0, 10) : '',
      uploader: d.owner?.name ?? '',
      uploaderMid: d.owner?.mid,
      view: d.stat?.view ?? 0,
      like: d.stat?.like ?? 0,
      pages,
      season,
      url: `https://www.bilibili.com/video/${d.bvid}`,
    }
  }

  /** 番剧信息 */
  async getBangumiInfo({ epId, seasonId }) {
    const params = epId ? { ep_id: epId } : { season_id: seasonId }
    const json = await this.apiGet(API.pgcSeason, params)
    const r = json.result
    const episodes = (r.episodes ?? []).map((e) => ({
      epId: e.ep_id,
      aid: e.aid,
      bvid: e.bvid,
      cid: e.cid,
      title: e.share_copy || e.title || '',
      longTitle: e.long_title ?? '',
      durationSec: e.duration ? Math.round(e.duration / 1000) : 0,
      cover: e.cover,
    }))
    const first = epId ? episodes.find((e) => e.epId === epId) ?? episodes[0] : episodes[0]
    return {
      kind: 'bangumi',
      seasonId: r.season_id,
      epId: first?.epId ?? epId,
      cid: first?.cid,
      title: r.title ?? '',
      cover: r.cover ?? '',
      desc: r.evaluate ?? '',
      episodes,
      url: first ? `https://www.bilibili.com/bangumi/play/ep${first.epId}` : '',
    }
  }

  /* ---------------------------------------------------------- 取流地址 */

  /**
   * 获取 DASH 播放流
   * @param {{bvid?:string, aid?:number, cid:number, qn?:number, bangumiEpId?:number}} opts
   */
  async getPlayStreams(opts) {
    const { cid, qn = 127, bangumiEpId } = opts
    const fnval = 4048 // DASH + 4K + HDR + 杜比 + 8K + AV1
    let payload
    if (bangumiEpId) {
      const json = await this.apiGet(API.pgcPlayurl, {
        ep_id: bangumiEpId,
        cid,
        qn,
        fnval,
        fourk: 1,
      })
      payload = json.result
    } else {
      const json = await this.apiGet(API.playurl, {
        bvid: opts.bvid,
        ...(opts.aid ? { avid: opts.aid } : {}),
        cid,
        qn,
        fnval,
        fourk: 1,
        platform: 'pc',
      })
      payload = json.data
    }
    if (!payload) throw new Error('未获取到播放流（该视频可能受版权限制、需要大会员或已下架）')

    const dash = payload.dash
    if (!dash) {
      // 退回 durl（老视频/番剧有时只有整段 FLV/MP4）
      const durl = payload.durl ?? []
      if (!durl.length) throw new Error('该视频没有可用的 DASH 流，也没有整段流')
      return {
        mode: 'durl',
        acceptQuality: payload.accept_quality ?? [],
        acceptDescription: payload.accept_description ?? [],
        streams: durl.map((d, i) => ({
          kind: 'segment',
          index: i + 1,
          url: d.url,
          backupUrls: d.backup_url ?? [],
          size: d.size,
          lengthMs: d.length,
        })),
      }
    }

    const video = (dash.video ?? []).map((v) => ({
      kind: 'video',
      id: v.id,
      qualityName: QUALITY_NAMES[v.id] ?? `画质 ${v.id}`,
      url: v.baseUrl ?? v.base_url,
      backupUrls: v.backupUrl ?? v.backup_url ?? [],
      bandwidth: v.bandwidth,
      mimeType: v.mimeType ?? v.mime_type,
      codecs: v.codecs,
      width: v.width,
      height: v.height,
      frameRate: v.frameRate ?? v.frame_rate,
    }))
    const audio = (dash.audio ?? []).map((a) => ({
      kind: 'audio',
      id: a.id,
      qualityName: AUDIO_NAMES[a.id] ?? `音频 ${a.id}`,
      url: a.baseUrl ?? a.base_url,
      backupUrls: a.backupUrl ?? a.backup_url ?? [],
      bandwidth: a.bandwidth,
      mimeType: a.mimeType ?? a.mime_type,
      codecs: a.codecs,
    }))
    // 去重：同一画质保留码率最高的
    const bestByQuality = new Map()
    for (const v of video) {
      const cur = bestByQuality.get(v.id)
      if (!cur || v.bandwidth > cur.bandwidth) bestByQuality.set(v.id, v)
    }
    // 优先 AVC/H.264（兼容性最好），除非用户指定
    const byQuality = [...bestByQuality.values()].sort((a, b) => b.id - a.id)
    const avc = byQuality.filter((v) => /avc|h264/i.test(v.codecs ?? ''))
    const hevc = byQuality.filter((v) => /hev|h265/i.test(v.codecs ?? ''))

    return {
      mode: 'dash',
      acceptQuality: payload.accept_quality ?? [],
      acceptDescription: payload.accept_description ?? [],
      video: byQuality,
      videoAvc: avc,
      videoHevc: hevc,
      audio: audio.sort((a, b) => b.id - a.id),
      durationMs: payload.timelength,
      isPreview: !!payload.is_preview,
    }
  }

  /** 官方字幕列表 */
  async getSubtitles({ bvid, aid, cid }) {
    const json = await this.apiGet(API.playerV2, { bvid, ...(aid ? { aid } : {}), cid })
    const list = json.data?.subtitle?.subtitles ?? []
    return list.map((s) => ({
      lan: s.lan,
      lanDoc: s.lan_doc,
      url: s.subtitle_url?.startsWith('//') ? `https:${s.subtitle_url}` : s.subtitle_url,
      isAi: s.ai_type === 1 || s.type === 1,
    }))
  }

  /** 弹幕（XML 文本） */
  async getDanmakuXml(cid) {
    const res = await fetchWithTimeout(`${API.danmakuXml}?oid=${cid}`, {
      headers: this.headers({ Accept: 'text/xml, */*' }),
      timeout: this.timeout,
    })
    if (!res.ok) throw new Error(`获取弹幕失败 HTTP ${res.status}`)
    const buf = Buffer.from(await res.arrayBuffer())
    // B 站弹幕接口返回裸 deflate，没有 Content-Encoding 头
    let text = buf.toString('utf8')
    if (text.trimStart().startsWith('<')) return text
    for (const inflate of [inflateRawSync, inflateSync]) {
      try {
        const out = inflate(buf).toString('utf8')
        if (out.trimStart().startsWith('<')) return out
      } catch {
        /* 换下一种 */
      }
    }
    return text
  }

  /* ------------------------------------------------------------ 下载 */

  /** 用 B 站必需的请求头下载单个资源 */
  async downloadAsset(url, destPath, opts = {}) {
    const urls = [url, ...(opts.backupUrls ?? [])]
    let lastError
    for (const u of urls) {
      try {
        return await downloadToFile(u, destPath, {
          headers: this.headers(u.includes('bilivideo') || u.includes('akamaized') ? {} : {}),
          onProgress: opts.onProgress,
          threads: opts.threads ?? 4,
          signal: opts.signal,
        })
      } catch (err) {
        lastError = err
      }
    }
    throw lastError ?? new Error('下载失败')
  }
}

/** 文件名友好的标题 */
export function safeTitle(title) {
  return String(title)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100) || 'video'
}

export default { BilibiliClient, QUALITY_NAMES, AUDIO_NAMES, safeTitle }
