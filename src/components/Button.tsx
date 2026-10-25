import type {ButtonHTMLAttributes, ReactNode} from 'react'
import {Icon, type IconName} from '@/components/Icon'

/**
 * 按钮。变体只管颜色与边框，加载态显示一个转圈并把按钮锁住。
 */

type Variant = 'default' | 'primary' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg'

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
    children?: ReactNode
    variant?: Variant
    size?: Size
    icon?: IconName
    loading?: boolean
}

export function Button({
                           children,
                           variant = 'default',
                           size = 'md',
                           icon,
                           loading = false,
                           className = '',
                           disabled,
                           type = 'button',
                           ...rest
                       }: Props) {
    const glyph = size === 'sm' ? 14 : 16
    return (
        <button
            type={type}
            {...rest}
            disabled={disabled || loading}
            aria-busy={loading || undefined}
            className={`btn btn-${variant} btn-${size} ${className}`.trim()}
        >
            {loading
                ? <span className="spinner" aria-hidden="true"/>
                : icon && <Icon name={icon} size={glyph}/>}
            {children != null && <span>{children}</span>}
        </button>
    )
}

/** 只有图标的按钮。`label` 必填 —— 图标按钮必须有可访问名。 */
export function IconButton({
                               label,
                               icon,
                               size = 'md',
                               variant = 'default',
                               className = '',
                               type = 'button',
                               ...rest
                           }: Omit<Props, 'children' | 'icon'> & { label: string; icon: IconName }) {
    return (
        <button
            type={type}
            {...rest}
            aria-label={label}
            title={label}
            className={`btn btn-${variant} btn-${size} btn-icon ${className}`.trim()}
        >
            <Icon name={icon} size={size === 'sm' ? 14 : 16}/>
        </button>
    )
}
