/**
 * 后端调用 —— 旧前端 `app/web/js/api.js` 的 1:1 移植（**只改类型，不改契约**）。
 *
 * ⚠️ 新前端挂在 `/next/` 下，而后端 API 在**根路径**的 `/api/*`。
 * 所以这里绝不能写相对路径 './api/state'（那会变成 /next/api/state，404）。
 * 统一走下面的 `request()`，它拼的是绝对路径 `/api/...`。
 *
 * ⚠️ **迁移页面时不要随便改这里的路径或请求体**：后端 39 条路由是既定的，
 * 契约夹具（`tests/contract/fixtures/`）盯着它们。要改先跑 `node tests/contract/verify.mjs 8891`。
 */

import type { AppState, HealthInfo, ToolInfo, Job } from './types'

export interface ApiError extends Error {
  code?: string
  status?: number
}

/**
 * 统一请求。三件事和旧前端对齐：
 *  - `data.ok === false` 也算失败（后端固定回 `{ ok, error?, code? }`）
 *  - **超时**：默认 120s；解析/下载这类长请求单独放宽
 *  - 非 JSON 响应给一句人话，而不是把 JSON 解析错误抛给用户
 */
async function request<T>(
  path: string,
  { method = 'GET', body, timeout = 120000 }: { method?: string; body?: unknown; timeout?: number } = {},
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    const text = await res.text()
    let data: (T & { ok?: boolean; error?: string; code?: string }) | null
    try {
      data = text ? JSON.parse(text) : ({} as T)
    } catch {
      throw new Error(`服务端返回异常内容（HTTP ${res.status}）`)
    }
    if (!res.ok || data?.ok === false) {
      const err = new Error(data?.error || `请求失败（HTTP ${res.status}）`) as ApiError
      err.code = data?.code
      err.status = res.status
      throw err
    }
    return data as T
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw new Error('请求超时，请检查后台服务是否仍在运行')
    throw e
  } finally {
    clearTimeout(timer)
  }
}

const get = <T,>(path: string, params?: Record<string, string | number>, timeout?: number) => {
  const qs = params ? '?' + new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])) : ''
  return request<T>(path + qs, { timeout })
}
const post = <T,>(path: string, body?: unknown, timeout?: number) =>
  request<T>(path, { method: 'POST', body, timeout })

export const api = {
  /* ── 基础 ─────────────────────────────────────────────── */
  health: () => request<HealthInfo>('/api/health', { timeout: 5000 }),
  state: () => request<AppState>('/api/state', { timeout: 60000 }),
  config: () => request<Record<string, unknown>>('/api/config'),
  /** 配置补丁。后端接受任意字段，不用改后端就能存新键。 */
  saveConfig: (patch: Record<string, unknown>) => post<{ ok: true }>('/api/config', patch),

  /* ── 外部工具 ─────────────────────────────────────────── */
  detect: (force = true) =>
    request<{ installedCount: number; tools: Record<string, ToolInfo> }>(
      `/api/tools/detect${force ? '?force=1' : ''}`,
      { timeout: 60000 },
    ),
  launch: (payload: { path: string }) => post<{ ok: true }>('/api/tools/launch', payload),

  /* ── 文件系统 ─────────────────────────────────────────── */
  fsRoots: () => request<{ roots: { label: string; path: string }[] }>('/api/fs/roots'),
  fsList: (path: string, opts: { exts?: string[]; files?: boolean } = {}) =>
    get<{ path: string; parent: string | null; entries: FsEntry[] }>('/api/fs/list', {
      path: path ?? '',
      ...(opts.exts?.length ? { exts: opts.exts.join(',') } : {}),
      ...(opts.files === false ? { files: '0' } : {}),
    }),
  fsMkdir: (path: string) => post<{ path: string }>('/api/fs/mkdir', { path }),
  fsReveal: (path: string, select = true) => post<{ ok: true }>('/api/fs/reveal', { path, select }),
  fsOpen: (payload: { path?: string; url?: string }) => post<{ ok: true }>('/api/fs/open', payload),

  /* ── 工程转换 ─────────────────────────────────────────── */
  collect: (dir: string, recursive = true) =>
    post<{ files: string[] }>('/api/convert/collect', { dir, recursive }),
  inspect: (payload: { path: string }) => post<ConvertInspect>('/api/convert/inspect', payload),
  preview: (payload: { path: string; target: string }) =>
    post<{ findings: Finding[] }>('/api/convert/preview', payload),
  convert: (payload: Record<string, unknown>) => post<{ jobId: string }>('/api/convert/run', payload),

  /* ── 视频解析下载 ─────────────────────────────────────── */
  parseVideo: (payload: { url: string; cookie?: string }) =>
    post<VideoParse>('/api/video/parse', payload, 180000),
  downloadVideo: (payload: Record<string, unknown>) => post<{ jobId: string }>('/api/video/download', payload),

  /* ── 音频 ─────────────────────────────────────────────── */
  audioProbe: (input: string) => post<AudioProbe>('/api/audio/probe', { input }),
  audioRun: (payload: Record<string, unknown>) => post<{ jobId: string }>('/api/audio/run', payload),

  /* ── 资源库 ───────────────────────────────────────────── */
  resources: (reload = false) => request<Resources>('/api/resources' + (reload ? '?reload=1' : ''), { timeout: 30000 }),
  checkLinks: (ids: string[]) => post<{ jobId: string }>('/api/resources/check', { ids }),

  /* ── 歌词（网易云 / QQ 音乐）──────────────────────────── */
  lyricsSearch: (payload: { source: LyricsSource; keyword: string }) =>
    post<{ items: LyricsHit[] }>('/api/lyrics/search', payload),
  lyricsGet: (payload: { source: LyricsSource; id: string | number }) => post<LyricsDoc>('/api/lyrics/get', payload),
  /** ⚠️ 后端先判 QQ songmid 再判网易云 id=，顺序不能反 —— 这里只负责原样传 */
  lyricsParseLink: (payload: { url: string }) => post<{ source: LyricsSource; id: string }>('/api/lyrics/parse-link', payload),
  lyricsImport: (payload: { path: string }) => post<LyricsDoc & { encoding: string }>('/api/lyrics/import', payload),
  lyricsSave: (payload: Record<string, unknown>) => post<{ path: string; files: string[] }>('/api/lyrics/save', payload),
  lyricsCover: (payload: { url: string; outDir: string; name?: string }) =>
    post<{ path: string }>('/api/lyrics/cover', payload),
  lyricsSms: (phone: string) => post<{ ok: true }>('/api/lyrics/login/sms', { phone }, 30000),
  lyricsCellphone: (phone: string, captcha: string) =>
    post<{ ok: true }>('/api/lyrics/login/cellphone', { phone, captcha }, 30000),
  lyricsLogout: (source: LyricsSource) => post<{ ok: true }>('/api/lyrics/logout', { source }),

  /* ── 任务 ─────────────────────────────────────────────── */
  jobs: () => request<{ jobs: Job[] }>('/api/jobs'),
  job: (id: string) => get<{ job: Job }>('/api/jobs/get', { id }),
  cancelJob: (id: string) => post<{ ok: true }>('/api/jobs/cancel', { id }),
}

/* ── 一些共用的数据形状（只写页面真会用到的字段）────────────── */

export interface FsEntry {
  name: string
  path: string
  dir: boolean
  size?: number
  mtime?: number
}

export interface Finding {
  level: 'info' | 'warn' | 'err'
  message: string
}

export interface ConvertInspect {
  ok: true
  format?: string
  tracks?: number
  notes?: number
  findings?: Finding[]
  [k: string]: unknown
}

export interface VideoParse {
  ok: true
  source: string
  kind: 'video' | 'bangumi'
  info: {
    bvid?: string
    aid?: number
    title: string
    cover?: string
    desc?: string
    durationSec?: number
    uploader?: string
    publishDate?: string
    view?: number
    pages?: { page: number; title: string; durationSec: number }[]
    episodes?: { id: number; title: string; durationSec: number }[]
    season?: { title: string } | null
  }
  currentPage: number
  streams: {
    mode: 'dash' | 'progressive' | 'other'
    video?: { id: number; qualityName: string; bandwidth: number; width?: number; height?: number; codecs?: string }[]
    audio?: { id: number; qualityName: string; bandwidth: number }[]
  }
  hasCookie: boolean
}

export interface AudioProbe {
  ok: true
  info: {
    durationSec: number
    audio?: { codec?: string; sampleRate?: number; channels?: number; bitRate?: number }
    video?: { codec?: string; width?: number; height?: number }
  }
}

export interface Resources {
  ok: true
  version: number
  updatedAt: string
  notice?: string
  verifySummary?: { checkedAt: string; total: number; ok: number; warn: number; dead: number; passRate: number }
  groups: {
    id: string
    name: string
    description: string
    icon: string
    items: ResourceItem[]
  }[]
}

export interface ResourceItem {
  id: string
  name: string
  url: string
  home: string
  tags: string[]
  region: '国内' | '海外' | '均可'
  cost: string
  official: boolean
  desc: string
  tip?: string
  verified?: { verdict: 'ok' | 'warn' | 'dead'; status?: number; checkedAt?: string }
}

export type LyricsSource = 'netease' | 'qq'

export interface LyricsHit {
  id: string | number
  title: string
  artist?: string
  album?: string
  durationSec?: number
}

export interface LyricsDoc {
  ok: true
  source?: LyricsSource
  id?: string | number
  title?: string
  artist?: string
  album?: string
  durationSec?: number
  lyric?: string
  trans?: string
  cover?: string
}

export default api
