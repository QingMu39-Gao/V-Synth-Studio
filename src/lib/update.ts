import type {UpdateCheck, UpdateInstaller} from './api'

/**
 * 「检查更新」里那两处**看不出来但错了就烦人**的判断。
 *
 * 抽出来是为了能测：一个在启动时静默弹窗，一个决定「忽略这个版本」到底管不管用。
 */

/**
 * 启动时那次静默检查要不要弹窗。
 *
 * 只有「上游真有更新的版本、而且这个版本没被忽略过」才弹。连不上、上游没发过
 * Release、本机比远端新（自己编的包）全都是「什么都不做」—— 那几种在回包里是
 * `ok:false` 或 `hasUpdate:false`（见 `update.rs`）。
 *
 * ⚠️ 忽略只按**版本号**比：`latest` 是后端去掉了前导 `v` 的那个串，存进配置的也是它。
 * 用户忽略 1.4.2 之后上游发了 1.4.3，仍然要提醒 —— 忽略的是「这一个版本」。
 */
export function shouldNotifyUpdate(
    r: UpdateCheck | null | undefined,
    ignored: string | undefined,
): boolean {
    if (!r?.ok || !r.hasUpdate) return false
    const latest = (r.latest ?? '').trim()
    if (!latest) return false
    return latest !== (ignored ?? '').trim()
}

/**
 * 界面上「下载新版本」该不该给：这条发布里得有本机平台的包。
 *
 * 后端已经按平台挑好了（`installer`），这里只判「挑到了没有」—— 挑不到（这次发布
 * 只发了别的平台、或文件名形状变了）就不该给一个点了会失败的按钮。
 */
export function canDownloadInstaller(r: UpdateCheck | null | undefined): boolean {
    return installerOf(r) !== null
}

/** 挑好的安装包；没有就回 `null`（顺手把空 `url` 也当没有）。 */
export function installerOf(r: UpdateCheck | null | undefined): UpdateInstaller | null {
    const ins = r?.installer
    if (!ins || !(ins.url ?? '').trim()) return null
    return ins
}

/**
 * 这次更新能不能「稍后再说」。
 *
 * `force` 由后端算好（服务端 `force: true`，或本机低于 `min_version`），而它**只在确实
 * 有新版时为真** —— 接口取不到、字段缺失、版本比本机低时都是 false。所以这里不必再防
 * 一层：后端一旦说强制，那就是服务端明确要求的。
 *
 * ⚠️ **强制不等于把人锁死**：界面上仍然要留「打开发布页」与「退出程序」两条路 ——
 * 对象存储挂了、下载失败了，用户至少得能自己拿到安装包，或者干脆先不用。
 */
export function isForcedUpdate(r: UpdateCheck | null | undefined): boolean {
    return !!r?.ok && !!r.hasUpdate && r.force === true
}

/** 人看的体积，例如 `153.3 MB`。`size` 缺失时回空串（界面不显示那一行）。 */
export function installerSizeText(ins: UpdateInstaller | null): string {
    const n = Number(ins?.size ?? 0)
    if (!Number.isFinite(n) || n <= 0) return ''
    return `${(n / 1048576).toFixed(1)} MB`
}
