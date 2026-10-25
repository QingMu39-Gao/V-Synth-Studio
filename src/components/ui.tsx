import {
    type HTMLAttributes,
    type KeyboardEvent,
    type ReactNode,
    useEffect,
    useId,
    useRef,
} from 'react'

import {Icon} from '@/components/Icon'

/**
 * 无材质的界面控件。
 *
 * 只做行为与语义，外观集中在 `ui.css`：实色底、一条描边、没有模糊与位移动画。
 * 控件不读主题，也不认识任何第三方样式库。
 */

/* ══════════════════════════════════════════════════════════════ 弹窗 ══ */

/**
 * 模态框走原生 `<dialog>`：焦点圈定、Escape 与顶层渲染交给浏览器。
 *
 * 关闭请求一律只上报，由调用方决定 `open` 是否真的变 false —— 强制更新那种
 * 「关不掉」的框就是在 `onOpenChange` 里拒绝。
 */
export function Dialog({
                           open,
                           onOpenChange,
                           title,
                           description,
                           children,
                       }: {
    open: boolean
    onOpenChange: (open: boolean) => void
    title: ReactNode
    description?: ReactNode
    children: ReactNode
}) {
    const ref = useRef<HTMLDialogElement>(null)
    const titleId = useId()
    const descId = useId()

    useEffect(() => {
        const d = ref.current
        if (!d) return
        if (open && !d.open) d.showModal()
        else if (!open && d.open) d.close()
    }, [open])

    useEffect(() => {
        const d = ref.current
        if (!d) return
        const cancel = (e: Event) => {
            e.preventDefault()
            onOpenChange(false)
        }
        d.addEventListener('cancel', cancel)
        return () => d.removeEventListener('cancel', cancel)
    }, [onOpenChange])

    return (
        <dialog
            ref={ref}
            className="dialog"
            aria-labelledby={titleId}
            aria-describedby={description ? descId : undefined}
            onClick={(e) => {
                if (e.target === ref.current) onOpenChange(false)
            }}
        >
            <div className="dialog-inner">
                <header className="dialog-head">
                    <div className="dialog-head-text">
                        <h2 className="dialog-title" id={titleId}>{title}</h2>
                        {description && <p className="dialog-desc" id={descId}>{description}</p>}
                    </div>
                    <button
                        type="button"
                        className="dialog-close"
                        aria-label="关闭"
                        onClick={() => onOpenChange(false)}
                    >
                        ×
                    </button>
                </header>
                <div className="dialog-body">{children}</div>
            </div>
        </dialog>
    )
}

/* ══════════════════════════════════════════════════════════ 分段控件 ══ */

export interface SegmentItem {
    value: string
    label: ReactNode
    disabled?: boolean
}

/**
 * 一排互斥按钮。禁用项用 `aria-disabled` 而不是 `disabled`，
 * 这样父级的点击捕获还能接到它、解释为什么选不了。
 */
export function SegmentedControl({
                                     items,
                                     value,
                                     onValueChange,
                                     'aria-label': ariaLabel,
                                 }: {
    items: readonly SegmentItem[]
    value: string
    onValueChange: (value: string) => void
    'aria-label'?: string
}) {
    return (
        <div className="seg" role="group" aria-label={ariaLabel}>
            {items.map((item) => (
                <button
                    key={item.value}
                    type="button"
                    className="seg-item"
                    aria-pressed={item.value === value}
                    aria-disabled={item.disabled || undefined}
                    data-disabled={item.disabled ? 'true' : undefined}
                    onClick={() => {
                        if (!item.disabled) onValueChange(item.value)
                    }}
                >
                    {item.label}
                </button>
            ))}
        </div>
    )
}

/* ══════════════════════════════════════════════════════════════ 选择器 ══ */

export interface SelectOption {
    value: string
    label: string
}

export function Select({
                           label,
                           labelHidden = false,
                           value,
                           options,
                           onValueChange,
                       }: {
    label: string
    labelHidden?: boolean
    value: string
    options: readonly SelectOption[]
    onValueChange: (value: string) => void
}) {
    const id = useId()
    return (
        <span className="select-wrap">
            {!labelHidden && <label className="field-label" htmlFor={id}>{label}</label>}
            <select
                id={id}
                className="input select"
                value={value}
                aria-label={labelHidden ? label : undefined}
                onChange={(e) => onValueChange(e.target.value)}
            >
                {options.map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                ))}
            </select>
        </span>
    )
}

/* ══════════════════════════════════════════════════════════════ 步进器 ══ */

/** 去掉浮点加法尾巴（0.05 的步长会积出 0.30000000000000004）。 */
const round6 = (n: number) => Number(n.toFixed(6))

/**
 * 数值步进器。上下键一次一步，PageUp/PageDown（或按住 Shift 点按钮）走
 * `shiftMultiplier` 步。
 */
export function Stepper({
                            value,
                            min,
                            max,
                            step,
                            onValueChange,
                            formatValue,
                            shiftMultiplier = 10,
                            'aria-label': ariaLabel,
                        }: {
    value: number
    min: number
    max: number
    step: number
    onValueChange: (value: number) => void
    formatValue?: (value: number) => string
    shiftMultiplier?: number
    'aria-label'?: string
}) {
    const clamp = (n: number) => round6(Math.min(max, Math.max(min, n)))
    const bump = (direction: 1 | -1, steps = 1) => {
        const next = clamp(value + direction * step * steps)
        if (next !== value) onValueChange(next)
    }
    const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
        if (e.key === 'ArrowUp' || e.key === 'ArrowRight') bump(1, e.shiftKey ? shiftMultiplier : 1)
        else if (e.key === 'ArrowDown' || e.key === 'ArrowLeft') bump(-1, e.shiftKey ? shiftMultiplier : 1)
        else if (e.key === 'PageUp') bump(1, shiftMultiplier)
        else if (e.key === 'PageDown') bump(-1, shiftMultiplier)
        else if (e.key === 'Home') {
            if (value !== min) onValueChange(min)
        } else if (e.key === 'End') {
            if (value !== max) onValueChange(max)
        } else return
        e.preventDefault()
    }

    return (
        <div
            className="stepper"
            role="spinbutton"
            tabIndex={0}
            aria-label={ariaLabel}
            aria-valuenow={value}
            aria-valuemin={min}
            aria-valuemax={max}
            aria-valuetext={formatValue?.(value)}
            onKeyDown={onKeyDown}
        >
            <button
                type="button"
                className="stepper-btn"
                aria-label="减少"
                disabled={value <= min}
                onClick={(e) => bump(-1, e.shiftKey ? shiftMultiplier : 1)}
            >
                −
            </button>
            <span className="stepper-value">{formatValue ? formatValue(value) : value}</span>
            <button
                type="button"
                className="stepper-btn"
                aria-label="增加"
                disabled={value >= max}
                onClick={(e) => bump(1, e.shiftKey ? shiftMultiplier : 1)}
            >
                +
            </button>
        </div>
    )
}

/* ══════════════════════════════════════════════════════════ 开关 / 勾选 ══ */

export function Switch({
                           checked,
                           onCheckedChange,
                           disabled = false,
                           'aria-label': ariaLabel,
                       }: {
    checked: boolean
    onCheckedChange: (checked: boolean) => void
    disabled?: boolean
    'aria-label'?: string
}) {
    return (
        <label className="switch" data-disabled={disabled ? 'true' : undefined}>
            <input
                type="checkbox"
                role="switch"
                checked={checked}
                disabled={disabled}
                aria-label={ariaLabel}
                onChange={(e) => onCheckedChange(e.target.checked)}
            />
            <span className="switch-track" aria-hidden="true">
                <span className="switch-thumb"/>
            </span>
        </label>
    )
}

export function Checkbox({
                             checked,
                             onCheckedChange,
                             disabled = false,
                             'aria-label': ariaLabel,
                         }: {
    checked: boolean
    onCheckedChange: (checked: boolean) => void
    disabled?: boolean
    'aria-label'?: string
}) {
    return (
        <input
            type="checkbox"
            className="checkbox"
            checked={checked}
            disabled={disabled}
            aria-label={ariaLabel}
            onChange={(e) => onCheckedChange(e.target.checked)}
        />
    )
}

/* ══════════════════════════════════════════════════════════════ 折叠 ══ */

export function Disclosure({
                               label,
                               secondaryLabel,
                               className = '',
                               children,
                           }: {
    label: ReactNode
    secondaryLabel?: ReactNode
    className?: string
    children: ReactNode
}) {
    return (
        <details className={`disclosure ${className}`.trim()}>
            <summary className="disclosure-summary">
                <span className="disclosure-label">{label}</span>
                {secondaryLabel && <span className="disclosure-secondary">{secondaryLabel}</span>}
            </summary>
            <div className="disclosure-body">{children}</div>
        </details>
    )
}

/* ══════════════════════════════════════════════════════════════ 列表 ══ */

export function List({children}: { children: ReactNode }) {
    return <div className="list">{children}</div>
}

export function ListSection({
                                header,
                                footer,
                                children,
                            }: {
    header?: ReactNode
    footer?: ReactNode
    children: ReactNode
}) {
    return (
        <section className="list-section">
            {header && <div className="list-section-head">{header}</div>}
            <div className="list-rows">{children}</div>
            {footer && <div className="list-section-foot">{footer}</div>}
        </section>
    )
}

export function ListRow({
                            selected = false,
                            leading,
                            label,
                            secondaryLabel,
                            accessory,
                            onSelect,
                        }: {
    selected?: boolean
    leading?: ReactNode
    label: ReactNode
    secondaryLabel?: ReactNode
    accessory?: ReactNode
    onSelect?: () => void
}) {
    const content = (
        <>
            {leading && <span className="list-row-leading">{leading}</span>}
            <span className="list-row-text">
                <span className="list-row-label">{label}</span>
                {secondaryLabel && <span className="list-row-secondary">{secondaryLabel}</span>}
            </span>
            {accessory && <span className="list-row-accessory">{accessory}</span>}
        </>
    )
    const className = 'list-row'
    const dataSelected = selected ? 'true' : undefined

    if (onSelect) {
        return (
            <button type="button" className={className} data-selected={dataSelected} onClick={onSelect}>
                {content}
            </button>
        )
    }
    return <div className={className} data-selected={dataSelected}>{content}</div>
}

/* ══════════════════════════════════════════════════════ 提示 / 标记 ══ */

export function Banner({
                           tone = 'info',
                           title,
                           message,
                       }: {
    tone?: 'info' | 'warning'
    title: ReactNode
    message: ReactNode
}) {
    return (
        <div className="banner" data-tone={tone}>
            <p className="banner-title">{title}</p>
            <p className="banner-message">{message}</p>
        </div>
    )
}

export function Badge({
                          tone = 'default',
                          title,
                          children,
                          ...rest
                      }: {
    tone?: 'default' | 'ok' | 'warn' | 'err'
    title?: string
    children: ReactNode
} & Omit<HTMLAttributes<HTMLSpanElement>, 'title' | 'children'>) {
    return (
        <span className="badge" data-tone={tone} title={title} {...rest}>
            {children}
        </span>
    )
}

export function Card({className = '', children}: { className?: string; children: ReactNode }) {
    return <div className={`card ${className}`.trim()}>{children}</div>
}

/* ══════════════════════════════════════════════════════════ 搜索框 ══ */

export function SearchField({
                                value,
                                onValueChange,
                                placeholder,
                                clearLabel = '清空',
                                className = '',
                                'aria-label': ariaLabel,
                            }: {
    value: string
    onValueChange: (value: string) => void
    placeholder?: string
    clearLabel?: string
    className?: string
    'aria-label'?: string
}) {
    return (
        <div className={`search-field ${className}`.trim()}>
            <Icon name="search" size={15} className="search-icon"/>
            <input
                type="search"
                className="search-input"
                value={value}
                placeholder={placeholder}
                aria-label={ariaLabel}
                onChange={(e) => onValueChange(e.target.value)}
            />
            {value && (
                <button
                    type="button"
                    className="search-clear"
                    aria-label={clearLabel}
                    onClick={() => onValueChange('')}
                >
                    ×
                </button>
            )}
        </div>
    )
}
