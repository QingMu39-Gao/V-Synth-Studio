/**
 * 「扩展包装到哪去」这一问 —— 音轨分离页与人声转 MIDI 页**共用**同一份。
 *
 * 背景：音轨分离的运行时（4.7 GB 下载 / 7.4 GB 解压）、模型、以及人声转 MIDI 的
 * GAME 模型（364 MB）全落在同一个**扩展包根**下，合计约 8 GB。所以：
 *
 *   * 第一次点「安装扩展包」之前问一次落点，选完写进 `config.json` 的 `extDir`；
 *   * 之后两个页面都不再问（同一个根），设置页里还能随时改。
 *
 * ⚠️ **只在没选过、而且运行时还没装好时问**：那个目录里已经躺着一份 7.4 GB 的运行时，
 * 再问一次只会让用户以为「这些包还要重下一遍」。
 * ⚠️ 「这个会话问过了」记在**模块级**而不是 ref：用户确认完切页/卸载组件之后 ref 就没了，
 * 回来再点安装会被问第二遍。
 */

import {useRef, useState} from 'react'
import {Dialog} from '@/components/ui'

import {Button} from '@/components/Button'
import {api, type ExtDirInfo} from '@/lib/api'

/** 这一次运行里问过落点了吗（模块级，见上面第二条约束）。 */
let askedThisRun = false

/**
 * 模块级的「弹一问」入口 —— 由 [`ExtDirAsk`] 挂上来。
 *
 * 没挂（页面没渲染那个组件）时直接放行：这一问是**体验**，不是下载的前置条件。
 */
let askRef: (() => Promise<boolean>) | null = null

/**
 * 开装之前问一次落点。已经问过、或者那个目录里已经装好了，就直接回 `true`。
 *
 * 给 `useInstaller` 的 `beforeInstall` 用（见 `lib/useInstaller.ts`）。
 * 回 `false` = 用户把这一问关掉了（不想现在装），调用方应当**放弃这一次安装**。
 */
export async function askExtDirOnce(): Promise<boolean> {
    if (askedThisRun) return true
    const ok = askRef ? await askRef() : true
    if (ok) askedThisRun = true
    return ok
}

/** 页面挂一次就够（`ExtDirAsk` 自己是个全局单例式的小组件）。 */
export function ExtDirAsk({onDecided}: { onDecided?: (info: ExtDirInfo) => void }) {
    const [info, setInfo] = useState<ExtDirInfo | null>(null)
    const [busy, setBusy] = useState(false)
    const resolve = useRef<((ok: boolean) => void) | null>(null)

    /* 把「弹一问」挂到模块级，供 `askExtDirOnce` 调 —— React 这边只负责画。
       每次渲染都重新赋值，所以拿到的永远是当前这一份 setState / ref。 */
    askRef = async (): Promise<boolean> => {
        let cur: ExtDirInfo
        try {
            cur = await api.extDirGet()
        } catch {
            /* 读不到就当默认位置放行：这只是「问到哪去」，不该拦住下载 */
            return true
        }
        if (!cur.isDefault || cur.hasRuntime) return true
        setInfo(cur)
        return await new Promise<boolean>((ok) => {
            resolve.current = ok
        })
    }

    const close = (ok: boolean, next?: ExtDirInfo) => {
        /* 只有用户真做了选择才算「问过」。把取消也记上的话，下次点安装会被
           `askExtDirOnce` 直接放行，悄悄把那 8 GB 装进默认位置（C 盘）。 */
        if (ok) askedThisRun = true
        if (next) onDecided?.(next)
        const r = resolve.current
        resolve.current = null
        setInfo(null)
        r?.(ok)
    }

    /** 「用默认位置」= 把配置清回可写目录 */
    const useDefault = async () => {
        setBusy(true)
        try {
            const next = await api.extDirSet('')
            close(true, next)
        } catch {
            /* 存不下来也别拦着这一次安装：这一次仍按当前配置落盘 */
            close(true)
        } finally {
            setBusy(false)
        }
    }

    /** 「换个目录…」= 系统「选择文件夹」对话框，选完就落在那个盘上 */
    const pick = async () => {
        setBusy(true)
        try {
            const r = await api.fsPick({folder: true, title: '选扩展包的存放位置'})
            if (!r.files.length) return
            const next = await api.extDirSet(r.files[0])
            close(true, next)
        } catch {
            close(true)
        } finally {
            setBusy(false)
        }
    }

    return (
        <Dialog
            open={!!info}
            onOpenChange={(o) => {
                /* 关掉这一问 = 现在不装；用户按的是「取消」而不是「用默认位置」，
                   别偷偷开始下几个 GB。 */
                if (!o) close(false)
            }}
            title="选扩展包的存放位置"
            description="音轨分离的运行时与模型、人声转 MIDI 的模型都装在这里，合计约 8 GB"
        >
            <p className="hint">
                默认位置：{info?.defaultDir}
                {info?.installed ? '（在系统盘上，紧张的话换一个盘）' : ''}
            </p>
            <p className="hint">选完就记住了，以后再下别的包不再问；设置页里也能改。</p>
            <div className="dir-actions">
                <span className="spacer"/>
                <Button size="sm" loading={busy} onClick={() => void pick()}>
                    换个目录…
                </Button>
                <Button size="sm" variant="primary" loading={busy} onClick={() => void useDefault()}>
                    用默认位置
                </Button>
            </div>
        </Dialog>
    )
}
