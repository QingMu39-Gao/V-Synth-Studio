/**
 * 后端调用 —— 从退役的旧界面 1:1 移植过来（**只改类型，不改契约**）。
 *
 * ⚠️ 后端 API 在**根路径**的 `/api/*`。界面就在根路径，但这里仍然**必须**用绝对路径
 * `/api/...`：相对路径跟着「当前文档所在目录」走，前缀一改就会静默变成
 * `/<前缀>/api/state` → 404。统一走下面的 `request()`，它拼的是绝对路径 `/api/...`。
 *
 * ⚠️ **迁移页面时不要随便改这里的路径或请求体**：后端 39 条路由是既定的，
 * 契约夹具（`tests/contract/fixtures/`）盯着它们。要改先跑 `node tests/contract/verify.mjs 8891`。
 */

import type { AppState, HealthInfo, ToolInfo, Job } from './types'

interface ApiError extends Error {
  code?: string
  status?: number
}

/**
 * 统一请求。三件事沿袭旧界面的约定：
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
  /**
   * 常用位置（盘符 + 桌面/下载/文档…）。
   *
   * ⚠️ 字段是 **`name`**（不是 `label`）—— 冻结夹具 `fs-roots.json` 里就是
   * `{ name, path, type, parent? }`。第一版照旧界面的叫法写成 `label`，
   * 结果目录选择器的「常用位置」一片空白（`undefined` 渲染成空字符串，不报错）。
   */
  fsRoots: () => request<{ roots: { name: string; path: string; type?: string; parent?: string }[] }>('/api/fs/roots'),
  /**
   * 列一个目录。
   *
   * ⚠️ 后端回的是 **`{ dirs: [...], files: [...] }`**（旧界面读的就是这两个
   * 字段，冻结夹具 `fs-list-c.json` 也是这个形状），这里归一成 `entries`（靠 `FsEntry.dir` 区分）。
   * **不做这一步 `components/DirPicker.tsx` 就永远是空列表** —— 它读的是 `data.entries`，
   * 后端从来不发这个字段，于是目录选择器只显示「（没有子目录）」。
   */
  fsList: (path: string, opts: { exts?: string[]; files?: boolean } = {}) =>
    get<FsListRaw>('/api/fs/list', {
      /* ⚠️ 空路径要**整个省掉这个参数**，不能发 `path=`：后端只在参数缺失时才回落到
         设置里的默认目录，发空串直接 400「缺少 path 参数」——「此电脑」那一级点进去就白屏。 */
      ...(path ? { path } : {}),
      ...(opts.exts?.length ? { exts: opts.exts.join(',') } : {}),
      ...(opts.files === false ? { files: '0' } : {}),
    }).then(toEntries),
  fsMkdir: (path: string) => post<{ path: string }>('/api/fs/mkdir', { path }),
  fsReveal: (path: string, select = true) => post<{ ok: true }>('/api/fs/reveal', { path, select }),
  fsOpen: (payload: { path?: string; url?: string }) => post<{ ok: true }>('/api/fs/open', payload),

  /* ── 工程转换 ─────────────────────────────────────────── */
  /**
   * 递归收集一个目录里的工程文件（本地路径数组）。
   *
   * ⚠️ 后端读的是 **`dirs`（数组）**，不是 `dir` —— 旧界面发的是 `{dir, recursive}`，
   * Rust 后端整个忽略它、永远回 `files: []`（8891 实测：发 `{dir}` 得 `count: 0`，
   * 发 `{dirs}` 才进扫描；源码 `server/convert.rs:23`）。这里按后端契约发。
   */
  collect: (dir: string) =>
    post<{ files: string[]; count: number; extensions: string[] }>('/api/convert/collect', { dirs: [dir] }),
  /**
   * 读一个工程，给出轨道 / 音符概览。请求体是 `{inputPath}`（或 `{path}`），
   * 回 `{stats:{trackCount,noteCount}, tracks, tempos, timeSignatures, lyrics}`。
   * 读工程要跑 LibreSVIP，所以超时放宽。
   */
  inspect: (payload: { inputPath: string }) => post<ConvertInspect>('/api/convert/inspect', payload, 120000),
  /**
   * 转换前预检：`{inputs, toFormat}` → `findings`（info/warn/err）。
   *
   * ⚠️ 后端**只分析 `inputs[0]`**，批量要逐个文件调（源码 `server/convert.rs:119`）。
   * 旧界面发的是 `{toFormat, inputPath, options}`，后端读不到 `inputs` 直接 400
   * 「没有选择要转换的文件」—— 这一页的价值就在预检，所以按后端契约发。
   */
  preview: (payload: { inputs: string[]; toFormat: string }) =>
    post<{ findings: Finding[]; inputCount: number }>('/api/convert/preview', payload, 120000),
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
    /* ⚠️ 真实回包是 `{ source, keyword, songs: [...] }`，字段名是 **name / artists / album / cover**，
       不是 `title / artist`（源码 `server/lyrics.rs` 的 `json!({ "source", "keyword", "songs" })`
       + `lyrics.rs` 里建歌曲对象那几行）。这里照实声明 —— 第一版照旧界面猜的形状是错的。 */
    post<{ source: LyricsSource; keyword: string; songs: LyricsHit[] }>('/api/lyrics/search', payload),
  lyricsGet: (payload: { source: LyricsSource; id: string | number }) => post<LyricsDoc>('/api/lyrics/get', payload),
  /** ⚠️ 后端先判 QQ songmid 再判网易云 id=，顺序不能反 —— 这里只负责原样传 */
  lyricsParseLink: (payload: { url: string }) => post<{ source: LyricsSource; id: string }>('/api/lyrics/parse-link', payload),
  /** 回包是 { source, id, song, lyric, trans, encoding }（与 get 同形，另加 encoding: utf-8 | gbk） */
  lyricsImport: (payload: { path: string }) => post<LyricsDoc & { encoding?: string }>('/api/lyrics/import', payload),
  /* ⚠️ 保存的回包是 `{ path, name, format, size }`（`server/lyrics.rs:168-173`）。
     这里原来写的是 `{ path, files }` —— 后端**从来没有** `files` 字段，而页面一直在用的
     `name`（文件名）真实存在。是声明写错了，不是页面多读了字段。 */
  lyricsSave: (payload: Record<string, unknown>) =>
    post<{ ok: true; path: string; name: string; format: string; size: number }>('/api/lyrics/save', payload),
  lyricsCover: (payload: { url: string; outDir: string; name?: string }) =>
    post<{ path: string }>('/api/lyrics/cover', payload),
  lyricsSms: (phone: string) => post<{ ok: true }>('/api/lyrics/login/sms', { phone }, 30000),
  /* ⚠️ 登录成功回的是 `{ loggedIn, phone, nickname }`（`server/lyrics.rs:406`），不只是 `ok`
     —— 页面要拿 `nickname` 显示「登录成功：xxx」，那个字段是真有的。 */
  lyricsCellphone: (phone: string, captcha: string) =>
    post<{ ok: true; loggedIn: boolean; phone: string; nickname: string }>(
      '/api/lyrics/login/cellphone',
      { phone, captcha },
      30000,
    ),
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

/** `/api/fs/list` 的原始响应（后端按目录 / 文件分两个数组给） */
interface FsListRaw {
  path: string
  parent?: string | null
  dirs?: { name: string; path: string }[]
  files?: { name: string; path: string; size?: number }[]
}

/** 归一成页面好用的形状：一个 `entries`，目录在前 */
function toEntries(d: FsListRaw): { path: string; parent: string | null; entries: FsEntry[] } {
  return {
    path: d.path,
    parent: d.parent ?? null,
    entries: [
      ...(d.dirs ?? []).map((e) => ({ name: e.name, path: e.path, dir: true })),
      ...(d.files ?? []).map((e) => ({ name: e.name, path: e.path, dir: false, size: e.size })),
    ],
  }
}

export interface Finding {
  level: 'info' | 'warn' | 'err'
  message: string
}

interface ConvertInspect {
  ok: true
  /** 概览：轨道数 / 音符数 */
  stats?: { trackCount?: number; noteCount?: number }
  tracks?: unknown[]
  tempos?: unknown[]
  timeSignatures?: unknown[]
  lyrics?: unknown
  [k: string]: unknown
}

/**
 * `video/parse` 的回包 —— **照后端源码（`server/media.rs`、`bili.rs`、`ytdlp.rs`）与冻结夹具
 * `tests/contract/fixtures/video-parse-bili.json` 声明**。
 *
 * ⚠️ 第一版这里的类型是猜的，错得挺多（`currentPage` 写成页码数字、`streams` 写死非空、
 * 缺 `videoAvc`/`videoHevc`/`acceptQuality`），当时搬页面的同学只能在页内重写一份；
 * 现在这份是对的形状，`pages/Video.tsx` 直接用这里的类型，**页内那份已删**。
 *   - `currentPage` 是**对象**（`{cid,page,title,durationSec,width,height}`），不是页码数字；
 *   - 流对象带 `kind / url / backupUrls / mimeType`；
 *   - `streams` 还有 `acceptQuality / acceptDescription / videoAvc / videoHevc / durationMs / isPreview`
 *     （分编码列出，页面就是靠这个做「AVC 优先」和 HEVC 兼容性提示的）；
 *   - durl 回退是 `mode:'durl'` + `streams[]`（分段，带 `index/size/lengthMs`），没有 `video`/`audio`；
 *   - 解析失败时 `streams` 是 `{ error }` —— **这种回包没有 `mode`**，所以 `mode` 是可选的；
 *   - yt-dlp 来源**没有 `streams`**（是缺字段，不是 `null`），`info` 走 yt-dlp 那套字段；
 *   - 番剧多一个 `info.episodes`，且**没有 `currentPage`**。
 */
export interface VideoParse {
  ok: true
  source: string
  kind: 'video' | 'bangumi'
  info: VideoInfo
  /** ⚠️ 对象，不是数字 */
  currentPage?: VideoPage
  /** ⚠️ yt-dlp 来源没有它；B 站超出可解析范围时是 `{ error: ... }` */
  streams?: VideoStreams | null
  hasCookie?: boolean
}

export interface VideoInfo {
  kind?: string
  bvid?: string
  aid?: number
  title: string
  cover?: string
  desc?: string
  durationSec?: number
  publishDate?: string
  uploader?: string
  uploaderMid?: number
  /* 播放量 / 点赞：后端是把 B 站的 stat.view / stat.like 原样拷过来（bili.rs:495-496、:500-501），
     取不到就补 0 —— 都是 JSON 数字。原来写 `number | string` 是防御性猜测，
     会与 `formatNumber(info.view)`（lib/format.ts 只接受数字）冲突。 */
  view?: number
  like?: number
  pages?: VideoPage[]
  /** 番剧剧集（`kind === 'bangumi'` 时）；普通视频是 `null` */
  episodes?: VideoEpisode[]
  season?: { title?: string; episodes?: VideoEpisode[] } | null
  /** 番剧：当前这一集的 epId（剧集行靠它高亮） */
  epId?: number
  url?: string
  /* ── 以下是 yt-dlp 来源专有，B 站那份 info 不发这些字段 ── */
  id?: string
  thumbnail?: string
  description?: string
  uploadDate?: string
  viewCount?: number
  extractor?: string
  webpageUrl?: string
  /** 字幕**语言键**数组（`ytdlp.rs` 只取 key）；没有字幕时是 `[]` */
  subtitles?: string[]
  formats?: VideoFormat[]
}

export interface VideoPage {
  cid?: number
  page?: number
  title?: string
  durationSec?: number
  width?: number
  height?: number
}

export interface VideoEpisode {
  /** 番剧用 epId 定位，不是 cid */
  epId?: number
  id?: number
  bvid?: string
  title?: string
  /** 番剧的长标题（`title` 为空时页面拿它兜底） */
  longTitle?: string
  durationSec?: number
  cover?: string
}

export interface VideoStream {
  kind?: 'video' | 'audio' | 'segment'
  id: number
  qualityName: string
  url?: string
  backupUrls?: string[]
  bandwidth?: number
  mimeType?: string
  codecs?: string
  width?: number
  height?: number
  frameRate?: string
  /* ── 只有 durl 的分段（`kind: 'segment'`）有这三个 ── */
  index?: number
  size?: number
  lengthMs?: number
}

export interface VideoStreams {
  /** ⚠️ 出错时后端只发 `{ error }`，没有 `mode` —— 所以是可选的 */
  mode?: 'dash' | 'durl'
  acceptQuality?: number[]
  acceptDescription?: string[]
  video?: VideoStream[]
  /** 按编码分好组的三份（同一批流） */
  videoAvc?: VideoStream[]
  videoHevc?: VideoStream[]
  audio?: VideoStream[]
  /** durl 回退：整段流的各分段（没有 `video`/`audio`） */
  streams?: VideoStream[]
  durationMs?: number
  isPreview?: boolean
  error?: string
}

/** yt-dlp 的一条可下载格式（`ytdlp.rs` 归一化后的形状） */
export interface VideoFormat {
  formatId?: string
  ext?: string
  resolution?: string
  fps?: number
  vcodec?: string
  acodec?: string
  filesize?: number
  isVideo?: boolean
}
interface AudioProbe {
  ok: true
  info: {
    durationSec: number
    audio?: { codec?: string; sampleRate?: number; channels?: number; bitRate?: number }
    video?: { codec?: string; width?: number; height?: number }
  }
}

interface Resources {
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

type LyricsSource = 'netease' | 'qq'

/** 搜索结果里的一条（字段名以后端为准：`name` / `artists`，不是 `title` / `artist`） */
interface LyricsHit {
  /** 网易云是数字串，QQ 是 songmid 串 —— 统一按字符串传回去 */
  id: string
  name: string
  artists?: string
  album?: string
  cover?: string
  durationSec?: number
}

/** `lyrics/get` / `lyrics/import` 里那个 `song`：与搜索结果同形，但**没有 `id`**（id 在外层） */
type LyricsSongInfo = Omit<LyricsHit, 'id'>

/**
 * `lyrics/get` 与 `lyrics/import` 的回包。
 *
 * ⚠️ 歌曲信息**嵌在 `song` 里**，`source` / `id` / `lyric` / `trans` 在外层平铺 —— 不是全平铺。
 * 源码（`lyrics.rs:347-359` 网易云、`:395-408` QQ、`:1022-1037` 导入）三个来源都是这个形状：
 * `{ source: 'netease' | 'qq' | 'file', id, song: { name, artists, album, cover, durationSec },
 *    lyric, trans, encoding? }` —— **`song` 里那个 `id` 不存在**（这一条以前写反了），
 * 而外层的 `source` / `id` 一直都在（页面拿它们显示来源、打开所在目录）。
 */
interface LyricsDoc {
  ok: true
  /** netease / qq（取词）/ file（本地导入） */
  source: string
  /** 网易云是数字串、QQ 是 songmid、导入是完整路径 */
  id: string
  song?: LyricsSongInfo
  /** 原文 LRC */
  lyric?: string
  /** 译文（可能没有） */
  trans?: string
  /** 仅导入本地文件时有：utf-8 / gbk */
  encoding?: string
}

export default api
