/**
 * 后端数据结构 —— 照着 `tests/contract/fixtures/state.json` 的真实抓包定义。
 *
 * ⚠️ 夹具是**永久基准**：字段对不上时先看夹具，别照着界面猜。
 */

/** 一种工程格式（40 种） */
export interface FormatInfo {
  id: string
  name: string
  exts: string[]
  /** 分组名，中文，直接当标题用 */
  group: string
  /** 模块是否就绪；false 时界面要置灰 */
  available: boolean
  canRead: boolean
  canWrite: boolean
  /** 仅 available 时有 */
  fidelity?: { notes?: string }
  /** 仅 !available 时有，说明为什么没就绪 */
  reason?: string
}

/** 外部工具检测结果（ffmpeg / yt-dlp / python） */
export interface ToolInfo {
  available: boolean
  path?: string
  version?: string
  /** '程序目录' / 'PATH' 等，界面上说明来源 */
  source?: string
  kind?: string
}

export interface ToolsMap {
  ffmpeg?: ToolInfo
  ytdlp?: ToolInfo
  python?: ToolInfo
  [k: string]: ToolInfo | undefined
}

export interface AppState {
  formats: FormatInfo[]
  /** 只剩 UVR 一项 —— 声库/编辑器探测已删，不要再写「编辑器列表」 */
  editors: unknown[]
  tools: ToolsMap
  transformOps: unknown[]
  audioFormats: Record<string, unknown>
  config: Record<string, unknown>
  paths: { root?: string; outputDir?: string; downloadDir?: string; toolsDir?: string }
  pinyin: Record<string, unknown>
  platform: string
  version: string
  installed?: boolean
}

export interface HealthInfo {
  name: string
  version: string
  /** 「关于」里那行运行环境，如 `Windows (x86_64)` */
  node: string
  author: string
  pid: number
  startedAt: number
  uptimeSec: number
}
