import type {ReactNode} from 'react'

/** 实色内容面板。没有材质、没有透明层。 */
export function Panel({
                          children,
                          className = '',
                          padded = true,
                      }: {
    children: ReactNode
    className?: string
    padded?: boolean
}) {
    return (
        <div className={`panel ${padded ? 'panel-padded' : ''} ${className}`.trim()}>
            {children}
        </div>
    )
}

/** 面板里的小标题 + 说明。排版统一走这里，免得每处各写一套字号。 */
export function PanelHead({
                              title,
                              desc,
                              extra,
                          }: {
    title: ReactNode
    desc?: ReactNode
    extra?: ReactNode
}) {
    return (
        <header className="panel-head">
            <div className="panel-head-text">
                <h2 className="panel-title">{title}</h2>
                {desc && <p className="panel-desc">{desc}</p>}
            </div>
            {extra && <div className="panel-head-extra">{extra}</div>}
        </header>
    )
}

/** 小标签。 */
export function Chip({
                         children,
                         tone = 'default',
                         title,
                     }: {
    children: ReactNode
    tone?: 'default' | 'ok' | 'warn' | 'err' | 'accent'
    title?: string
}) {
    return (
        <span className="chip" data-tone={tone} title={title}>
            {children}
        </span>
    )
}

/**
 * 进度条。`pct` 为 `null` 表示拿不到分母（没有 Content-Length 的分块下载），
 * 此时显示来回扫动的未知进度。
 */
export function ProgressBar({pct}: { pct: number | null }) {
    const known = pct !== null
    return (
        <div
            className="progress-bar"
            role="progressbar"
            aria-valuenow={known ? pct : undefined}
            aria-valuemin={0}
            aria-valuemax={100}
        >
            <span
                className={known ? 'progress-fill' : 'progress-fill progress-unknown'}
                style={known ? {width: `${Math.min(100, pct)}%`} : undefined}
            />
        </div>
    )
}

/** 一条「发现」：环境就绪度里那种带标题的说明 */
export function Finding({
                            level,
                            title,
                            children,
                        }: {
    level: 'warn' | 'info'
    title: ReactNode
    children: ReactNode
}) {
    return (
        <div className="finding" data-level={level}>
            <p className="finding-title">{title}</p>
            <p className="finding-text">{children}</p>
        </div>
    )
}

/** 一对「标签 + 值」 */
export function Stat({
                         label,
                         value,
                         sub,
                     }: {
    label: ReactNode
    value: ReactNode
    sub?: ReactNode
}) {
    return (
        <div className="stat">
            <span className="stat-label">{label}</span>
            <span className="stat-value">{value}</span>
            {sub && <span className="stat-sub">{sub}</span>}
        </div>
    )
}
