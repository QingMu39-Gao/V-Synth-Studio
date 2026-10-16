/**
 * **配置** —— `config.json` 在前端的门面。
 *
 * 用户偏好**只有一份真相**：后端那个 `config.json`（绿色版 `<根>/data/config.json`，
 * 安装版 `%APPDATA%\com.qingmu.vocalworkstation\config.json`）。浏览器存储不能用 ——
 * 它**按 origin 隔离**（端口一改就像换了新用户），而且**只有前端知道**
 * （后端读不到，重启后要等前端灌回来）。
 *
 * ⚠️ **本文件是整份前端里唯一碰浏览器存储的地方**，而且只碰一次：启动时把老键捞出来
 * 交给后端的 `migrate_legacy_settings`（见下面 `readLegacy()`）。
 * **别在别处再写 `localStorage.setItem`。**
 *
 * `main.tsx` 在挂载 React **之前** `await ensureConfig()` —— `get_config` 只读一个几百字节
 * 的文件，比首屏渲染快得多，等它一下换来的是「第一帧就是选定的主题」。真出错也不拦着
 * 界面出来（回落到默认值，由 `onConfigError` 报一句）。
 *
 * 改一项就 `saveConfig(patch)`：内存里立刻生效，落盘走 250ms 防抖（滑块那种连续改动
 * 不该每一帧都写文件）。后端的 `set_config` 是**局部更新**（只传要改的键），回完整配置。
 */

import {call} from './ipc'

/** `config.json` 的形状。后端 `default_config()` 里有的键就是这些（加了新键要两边一起加）。 */
export interface AppConfig {
    theme?: 'system' | 'light' | 'dark'
    glassLevel?: number
    outputDir?: string
    downloadDir?: string
    bilibiliCookie?: string
    neteaseCookie?: string
    /** 网易云 MUSIC_U 的过期时间（unix 秒，0 / 缺失表示没记过）；界面显示与自动续期用它 */
    neteaseCookieExpire?: number
    proxy?: string
    /* ── 页面自己那份设置（键名见 `readLegacy`）── */
    audio?: Record<string, unknown>
    video?: Record<string, unknown>
    convert?: Record<string, unknown>
    /** 歌词页 → 文字 PV 页的交接 */
    pvPendingLyrics?: string
    /** 上面那份已经填过一次了，别重复填 */
    pvSentLyrics?: string
    /** 人声转 MIDI 的输出目录 */
    midiOutDir?: string
    /**
     * 用户点过「忽略这个版本」的那个版本号（如 `1.4.2`）。
     *
     * 只影响**启动时那次静默检查**要不要弹窗 —— 「设置 → 关于」里手动查仍然照实报，
     * 否则用户会以为功能坏了。清空（`""`）就是取消忽略。
     */
    ignoredUpdate?: string
    /* 背景壁纸：`""` 静态图 / `"we:current"` 跟随 WE 当前壁纸 / `"we:<id>"` 固定一张。
       `wallpaperPaused` 暂停动画；`weDir` 手动指定的 WE 目录（自动找不到时才用）。 */
    wallpaper?: string
    wallpaperPaused?: boolean
    weDir?: string

    [k: string]: unknown
}

/* ══════════════════════════════════════ 模块级状态 ══════════════════════════════════════ */

let snapshot: AppConfig = {}
const listeners = new Set<() => void>()
let booted: Promise<AppConfig> | null = null
let errorHandler: ((msg: string) => void) | null = null

function emit() {
    for (const l of listeners) l()
}

/** 同步读当前配置（不认识 React 的地方用，比如 `useGlass` 的存储层）。 */
export function getConfig(): AppConfig {
    return snapshot
}

/**
 * 订阅配置变化，**不经过 React**。
 *
 * ⚠️ 回调里只读 `getConfig()` 做派生（`useGlass` 的等级就是这样的），不要在这里
 * 再 `saveConfig` —— 会在 `emit()` 里递归。
 *
 * 返回值是**退订函数** —— `useSyncExternalStore` 要求订阅函数回一个清理函数
 * （见 `lib/i18n.ts`），不回就会每次挂载都往 `listeners` 里叠一个回调。
 */
export function onConfigChange(cb: () => void): () => void {
    listeners.add(cb)
    return () => {
        listeners.delete(cb)
    }
}

/** 界面上报错的地方（App 挂载时接上 toast）。没接就只进控制台。 */
export function onConfigError(fn: ((msg: string) => void) | null) {
    errorHandler = fn
}

function fail(msg: string) {
    console.error('[config]', msg)
    errorHandler?.(msg)
}

/* ══════════════════════════════════════ 读 ══════════════════════════════════════ */

interface ConfigReply {
    config: AppConfig
}

/**
 * `qingmu.*` / `fandiao.*` 开头的浏览器存储键 —— 整份前端里唯一读它们的地方。
 *
 * ⚠️ **只负责把它们捞出来，映射规则在后端**（`ipc/config.rs` 的 `LEGACY_KEYS`）
 * —— 那张表是唯一的映射处，这里再抄一遍就会两边不同步。
 *
 * ⚠️ **老键在另一个 origin 下**（`http://127.0.0.1:17878`），而窗口是
 * `http://tauri.localhost` —— 存储区按 origin 隔离，两边不互通，所以这里读到空是正常结果。
 * 捞到就交给后端并进去，捞不到就什么都不做。
 */
function readLegacy(): Record<string, string> {
    const out: Record<string, string> = {}
    try {
        for (let i = 0; i < localStorage.length; i++) {
            const k = localStorage.key(i)
            if (!k || !(k.startsWith('qingmu.') || k.startsWith('fandiao.'))) continue
            const v = localStorage.getItem(k)
            if (v) out[k] = v
        }
    } catch {
        /* 隐私模式：当没有旧数据 */
    }
    return out
}

/**
 * 启动时那一次：拉配置 → 搬旧设置 → 再拉一次。
 *
 * `migrate_legacy_settings` 的合并规则是「**配置里已有的键优先**」，所以它**幂等**，
 * 多调几次无害 —— 前端不必（也无法）记「搬没搬过」的标记。
 */
async function boot(): Promise<AppConfig> {
    let cfg: AppConfig
    try {
        cfg = (await call<ConfigReply>('get_config')).config ?? {}
    } catch (e) {
        fail(`读取配置失败：${e instanceof Error ? e.message : String(e)}`)
        snapshot = {}
        emit()
        return snapshot
    }

    const old = readLegacy()
    if (Object.keys(old).length) {
        try {
            await call('migrate_legacy_settings', {old})
            cfg = (await call<ConfigReply>('get_config')).config ?? cfg
        } catch (e) {
            /* 搬不动不是致命的：用户在新界面里重设一次就行，别拦着启动 */
            console.warn('[config] 旧设置迁移失败：', e)
        }
        /* ⚠️ `theme` / `glassLevel` 这两个**轮不到后端那张表**：它们在
           `default_config()` 里本来就有默认值，而迁移的规则是「已有的键优先」——
           `cfg.get(key).is_some()` 恒为真，于是永远跳过。所以这里补一刀：
           **只有还停在默认值上**才把捞到的值提上来（已经改过就不动）。 */
        const patch: Record<string, unknown> = {}
        if (cfg.theme === 'system' && old['qingmu.theme']) {
            const t = old['qingmu.theme']
            if (t === 'light' || t === 'dark' || t === 'system') patch.theme = t
        }
        if ((cfg.glassLevel ?? 2) === 2 && old['qingmu.glassLevel']) {
            const n = Number(old['qingmu.glassLevel'])
            if (n >= 1 && n <= 4) patch.glassLevel = Math.round(n)
        }
        if (Object.keys(patch).length) {
            try {
                cfg = (await call<ConfigReply>('set_config', {patch})).config ?? cfg
            } catch (e) {
                console.warn('[config] 旧主题 / 玻璃等级没能提上来：', e)
            }
        }
    }

    snapshot = cfg
    emit()
    return snapshot
}

/** 启动时调一次（`main.tsx`）。重复调用拿到的是同一个 Promise。 */
export function ensureConfig(): Promise<AppConfig> {
    if (!booted) booted = boot()
    return booted
}

/* ══════════════════════════════════════ 写 ══════════════════════════════════════ */

let pending: Record<string, unknown> = {}
let timer: number | null = null
let writeGeneration = 0

async function flush() {
    timer = null
    const patch = pending
    pending = {}
    const generation = writeGeneration
    if (!Object.keys(patch).length) return
    try {
        const r = await call<ConfigReply>('set_config', {patch})
        /* 后端回的是**打码后**的完整配置，用它替掉本地那份 —— 这样 Cookie 类的键
           在内存里也不会留明文。（打码的值原样提交回来时后端会跳过，不会反向覆盖。） */
        if (r?.config && generation === writeGeneration) {
            snapshot = r.config
            emit()
        }
    } catch (e) {
        fail(`保存设置失败：${e instanceof Error ? e.message : String(e)}`)
    }
}

/**
 * 把**后端刚回的**配置合并进内存那份，不落盘。
 *
 * 用途是「后端自己改了配置」的那几条命令：手机号登录 / 退出登录 / 续期都把凭据写进
 * `config.json`，但它们**不经过 `saveConfig`** —— 内存那份还停在旧值，界面就会一直
 * 显示未登录、连「退出登录」都不给。拿到 `get_state` / `get_config` 的回包时顺手
 * 灌回来，后端才是唯一真相。
 *
 * ⚠️ 与 `saveConfig` 的区别：这里**不写文件、也不排队**。写操作一律走 `saveConfig`
 * （它有自己的乐观更新与防抖），拿它当「同步」用会把后端的值再发回去一遍。
 */
export function syncConfig(cfg: AppConfig | undefined): void {
    if (!cfg || typeof cfg !== 'object') return
    snapshot = {...snapshot, ...cfg}
    emit()
}

/**
 * 存几项设置。**立刻**在内存里生效（订阅者下一帧就重渲染），落盘防抖 250ms。
 */
export function saveConfig(patch: Record<string, unknown>): void {
    snapshot = {...snapshot, ...patch}
    writeGeneration += 1
    emit()
    pending = {...pending, ...patch}
    if (timer !== null) window.clearTimeout(timer)
    timer = window.setTimeout(() => void flush(), 250)
}
