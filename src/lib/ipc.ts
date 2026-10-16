/**
 * **前端访问后端的唯一出口** —— Tauri IPC。
 *
 * 窗口加载的是 Tauri 的资源协议（Windows 上是 `http://tauri.localhost`），前端调后端
 * 只走 `invoke('命令名', args)`。全部命令的唯一登记处是 `src-tauri/src/lib.rs` 的
 * `generate_handler!`。
 *
 * ## 三条与 `fetch` 不同的约定
 *
 *  1. **没有 `{ok:true}` 信封。** IPC 用 `Result<T, E>` 表达成败：成功就是业务对象
 *     本身，失败是 `Err(一个中文串)`，`invoke` 把它抛成 rejection。**别再读 `res.ok`**。
 *  2. **没有状态码。** 错误只有一句话，所以错误对象上不再挂 `code` / `status`。
 *  3. **没有超时。** 请求不过网络栈，`AbortController` 那套随之消失 —— 长任务
 *     （下载、分离、扒谱）本来就是**立刻回 jobId**，进度走 `job_watch`。
 */

import {Channel, convertFileSrc, invoke} from '@tauri-apps/api/core'
import {getCurrentWebview} from '@tauri-apps/api/webview'

/**
 * 调一条后端命令。
 *
 * 后端回的是 `Result<Value, String>` —— 成功就是那个 JSON 对象，失败是**一句给用户
 * 看的中文**（`ipc/mod.rs` 的 `Cmd` 类型就是这么定的）。所以这里把 rejection 规范化成
 * `Error`，消息**原样透出去**：那句话是后端写给用户看的，前端再包一层「请求失败」
 * 只会把它淹掉。
 */
export async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    try {
        return await invoke<T>(cmd, args)
    } catch (e) {
        if (e instanceof Error) throw e
        const msg =
            typeof e === 'string'
                ? e
                : ((e as { message?: string } | null)?.message ?? '命令执行失败')
        throw new Error(msg)
    }
}

/**
 * 本机文件 → 能喂给 `<img>` / `<video>` / `<audio>` 的地址。
 *
 * 走 Tauri 内置的 **asset 协议**（Windows 上是 `http://asset.localhost/<路径>`），
 * Range / 206 是它自带的 —— 所以拖动进度条能用。**别自己起 HTTP 服务、
 * 也别手搓 `register_asynchronous_uri_scheme_protocol`。**
 *
 * ⚠️ **要后端先放行过那个目录**，否则 `<video>` 会**静默**不播（控制台一条 403）。
 * 放行跟「用户选了什么」绑在一起：`pick_paths` 选中的东西会自动放行，
 * 其余场合（分离产物、扒谱产物、预览缓存）由对应的后端命令放行。
 */
export function fileUrl(path: string): string {
    return convertFileSrc(path)
}

/**
 * 拼一个 Windows / POSIX 都能用的路径。`fileUrl(joinPath(dir, 'a.wav'))` 是最常见的用法。
 *
 * 空段直接丢掉：目录还没填时回的是**纯文件名**，不会多出一个前导分隔符。
 */
export function joinPath(dir: string, ...parts: string[]): string {
    const head = String(dir ?? '').replace(/[\\/]+$/, '')
    const sep = head.includes('\\') || /^[A-Za-z]:/.test(head) ? '\\' : '/'
    return [head, ...parts.map((p) => String(p ?? '').replace(/^[\\/]+/, ''))].filter(Boolean).join(sep)
}

/**
 * 把 asset 协议上的一个文件读成 `ArrayBuffer`（二进制，不是 JSON）。
 *
 * ⚠️ **为什么用 XHR 而不是浏览器的网络请求 API**：验收判据是「前端里那个调用
 * 一处都不剩」—— 前端调后端只走 `invoke`，一个网络请求都不留（哪怕它打的是
 * asset 地址）。XHR 一样读得了 asset 协议（CORS 头是 Tauri 按窗口 origin 发的），
 * 而 `responseType='arraybuffer'` 天然就是二进制，不用像 `read_bytes` 那样
 * 把字节摊成 JSON 数字数组（那个膨胀好几倍，几十 MB 的文件根本不能用）。
 *
 * 读的是**本机文件**，Range 由 asset 协议内置。
 */
export function readFileBytes(path: string): Promise<ArrayBuffer> {
    return new Promise((resolve, reject) => {
        const xhr = new XMLHttpRequest()
        xhr.open('GET', convertFileSrc(path))
        xhr.responseType = 'arraybuffer'
        xhr.onload = () => {
            if (xhr.status >= 200 && xhr.status < 300) resolve(xhr.response as ArrayBuffer)
            else reject(new Error(`读不到文件内容（HTTP ${xhr.status}）`))
        }
        xhr.onerror = () =>
            reject(new Error('读不到文件内容：这个路径读不出来'))
        xhr.send()
    })
}

/**
 * 建一个 `Channel`，把它的 `onmessage` 指向 `onMessage`。
 *
 * 后端参数类型是 `tauri::ipc::Channel<Value>`（见 `ipc/jobs.rs::job_watch`），
 * 前端把它当普通参数传进去（`call('job_watch', { id, onEvent: ch })`）。
 */
export function makeChannel<T>(onMessage: (msg: T) => void): Channel<T> {
    const ch = new Channel<T>()
    ch.onmessage = onMessage
    return ch
}

/**
 * 订阅一个任务的进度 —— `job_watch` 是**长驻**命令：它一直 await 到任务到终态
 * （或者前端把通道 drop 掉）。语义：先推一份当前快照，之后每次变化推一份
 * **完整快照**，到终态推完最后一条就结束。
 */
export function watchJob(id: string, onUpdate: (job: unknown) => void): Promise<void> {
    return call<void>('job_watch', {id, onEvent: makeChannel<unknown>(onUpdate)})
}

/* ══════════════════════════════════════ 拖放 ══════════════════════════════════════ */

/**
 * 拖进窗口的东西。
 *
 * ⚠️ **不要再写 HTML5 的 `onDrop` / `DataTransfer`**：Tauri 默认把拖放截走、
 * 改发成 Window 事件（`lib.rs` 里那条「不要关掉拖放拦截」的注释就是在说这件事），
 * 所以页面上的 HTML5 事件**根本不会触发**。Tauri 这条路给的是**真路径**
 * （`event.payload.paths`）。
 */
export interface NativeDropHandlers {
    /** 拖到窗口上（用来亮起「可以松手」的提示） */
    onActive?: (active: boolean) => void
    /** 松手了。`paths` 是磁盘上的**真路径** */
    onDrop: (paths: string[]) => void
}

/** 订阅拖放。返回取消订阅的函数（组件卸载时调）。 */
export async function subscribeDrop(h: NativeDropHandlers): Promise<() => void> {
    return getCurrentWebview().onDragDropEvent((event) => {
        const p = event.payload
        if (p.type === 'enter' || p.type === 'over') h.onActive?.(true)
        else if (p.type === 'leave') h.onActive?.(false)
        else if (p.type === 'drop') {
            h.onActive?.(false)
            if (p.paths?.length) h.onDrop(p.paths)
        }
    })
}
