/**
 * 后端数据结构 —— **手写**，照 `ipc/state.rs::get_state` 那个 `json!({...})` 的真实形状。
 *
 * ⚠️ **不引 `ts-rs` 之类的构建期类型生成**（用户已拍板）：那几个类型就这么点，
 * 生成器带来的构建负担比省下的手写更大。改后端回包时**两处一起改**。
 *
 * ⚠️ `get_state` 里不放 `pid` / `uptimeSec`：那是「跑在一个 HTTP 端口上」才需要的信息，
 * IPC 下前端与 Rust 同进程同生命周期。版本号、运行环境、安装形态都在 `get_state` 里。
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

interface ToolsMap {
    ffmpeg?: ToolInfo
    ytdlp?: ToolInfo
    python?: ToolInfo

    [k: string]: ToolInfo | undefined
}

export interface AppState {
    formats: FormatInfo[]
    /** 编辑器探测的候选表（`tools.rs` 的候选已经清空，正常是空数组） */
    editors: unknown[]
    tools: ToolsMap
    transformOps: unknown[]
    audioFormats: Record<string, unknown>
    config: Record<string, unknown>
    /**
     * **安装时选的**界面语言（`zh-CN` / `en-US` / `ja-JP`），读不到是缺失。
     *
     * ⚠️ 与 `config.language` 是两件事：这一个是「安装器希望我用哪个语言」，
     * 由 `App.tsx` 在**第一次**拿到状态时应用一次（写进配置，之后就以配置为准）；
     * 绿色版没有这一项。
     */
    installerLanguage?: string
    paths: { root?: string; outputDir?: string; downloadDir?: string; toolsDir?: string }
    pinyin: Record<string, unknown>
    /** `win32` / `darwin` 这种（Node 命名，跨平台代码沿用了） */
    platform: string
    /** 给人看的一行，如 `Windows (x86_64)` */
    platformDesc?: string
    /**
     * 整台机器用不了时的一句话（Intel Mac 上随包的 ffmpeg 是 arm64 的）。
     * 缺失 / `null` = 没有这句话，正常用。
     */
    platformNote?: string | null
    version: string
    /** 作者署名 */
    author?: string
    /** 安装版（Program Files）还是绿色版（解压即用） */
    installed?: boolean
    /** 这个平台上哪些功能做不到（判据在后端 `platform.rs::caps`） */
    caps?: Caps
}

/**
 * 一项平台能力。`ok: false` 时必带 `why` —— 界面要能说清「为什么这里用不了」。
 *
 * ⚠️ **判断一律走 {@link capOk}**，别自己写 `caps?.x?.ok`：字段缺失（老后端、回包被裁）
 * 时那种写法会把功能判成不可用，而默认应当是「照旧可用」。
 */
export interface CapInfo {
    ok: boolean
    why?: string
}

export interface Caps {
    /** 背景壁纸：读 Wallpaper Engine 的 Steam 库 */
    wallpaper?: CapInfo
    /** 本地音轨分离引擎（运行时可下载包） */
    svsepLocal?: CapInfo
    /** 显卡加速包（DirectML） */
    svsepDirectml?: CapInfo
    /** 人声转 MIDI 的 GPU 档（CUDA） */
    midiGpu?: CapInfo
    /** 删除进回收站 */
    trash?: CapInfo
}

/** 这项能力在这个平台上可用吗。字段缺失按可用算（见 {@link CapInfo} 上的警告）。 */
export const capOk = (c?: CapInfo): boolean => c?.ok !== false

/**
 * 后端任务（`ipc/jobs.rs`）。
 *
 * 形状照建任务时那个 `json!({...})`：
 * `{ id, type, title, status, percent, message, logs, createdAt }`，失败时多一个 `error`。
 * **`percent` 是 0~100**（不是 0~1）—— `GlassProgress` 要 `value`/`total`，直接给 100 当 total。
 */
export interface Job {
    id: string
    type?: string
    title?: string
    status: 'running' | 'done' | 'error' | 'canceled'
    percent?: number
    message?: string
    logs?: string[]
    error?: string
    createdAt?: number

    [k: string]: unknown
}
