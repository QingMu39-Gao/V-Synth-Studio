import type {ReactNode} from 'react'
import {Button} from '@/components/Button'
import {ProgressBar} from '@/components/Panel'
import {formatBytes} from '@/lib/format'
import './Dependency.css'

/**
 * 下载 / 解压进度条 —— 音轨分离与扒谱两页同一种形状，合成一份。
 *
 * `pct` 传 `null` 表示拿不到分母（chunked 下载没有 Content-Length）。
 */
export function DownloadProgress({
                                     label,
                                     done,
                                     total,
                                     pct,
                                     children,
                                     footer,
                                 }: {
    label: string
    done: number
    total: number
    pct: number | null
    /** 进度条正下方的动作（暂停 / 停止）；不传就不占一行 */
    children?: ReactNode
    footer?: ReactNode
}) {
    return (
        <div className="dep-progress">
            <div className="dep-progress-head">
                <span>{label}</span>
                <span className="dim">
                    {formatBytes(done)}
                    {total > 0 ? ` / ${formatBytes(total)}` : ''}
                </span>
            </div>
            <ProgressBar pct={pct}/>
            {children && <div className="btn-row dep-acts">{children}</div>}
            {footer}
        </div>
    )
}

/**
 * 不可逆操作的**两段式**危险区：第一下把按钮换成「确认删除」，第二下才真删。
 *
 * ⚠️ 不用 `window.confirm` —— 它和整站的界面风格不是一套。旁边那个「算了」
 * 是唯一的撤销口，所以确认那一行必须一直看得见。
 */
export function DangerZone({
                               label,
                               armed,
                               onArm,
                               onCancel,
                               onConfirm,
                               confirmText,
                               armedText,
                               idleText,
                               disabled,
                               notice,
                           }: {
    /** 同时当小标题和未 armed 时那个按钮的文字 */
    label: string
    armed: boolean
    onArm: () => void
    onCancel: () => void
    onConfirm: () => void
    confirmText: ReactNode
    armedText: ReactNode
    idleText: ReactNode
    disabled?: boolean
    /** 两块文案之外的补充说明（比如「删完仍是就绪」那种特例） */
    notice?: ReactNode
}) {
    return (
        <div className="dep-danger">
            <div className="dep-danger-head">{label}</div>
            {notice}
            {armed ? (
                <>
                    <p className="hint">{armedText}</p>
                    <div className="btn-row">
                        <Button icon="trash" disabled={disabled} onClick={onConfirm}>
                            {confirmText}
                        </Button>
                        <Button variant="ghost" onClick={onCancel}>
                            算了
                        </Button>
                    </div>
                </>
            ) : (
                <>
                    <p className="hint">{idleText}</p>
                    <div className="btn-row">
                        <Button variant="ghost" icon="trash" disabled={disabled} onClick={onArm}>
                            {label}
                        </Button>
                    </div>
                </>
            )}
        </div>
    )
}
