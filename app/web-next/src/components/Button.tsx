import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Icon, type IconName } from '@/components/Icon'

/**
 * 按钮。
 *
 * ⚠️ **默认是实色的**，只有 `variant="glass"` 才浮起来 —— 理由同 `Panel.tsx`：
 * 设计系统的规矩是玻璃只给浮起来的那层。一屏里的主操作**最多一个**
 * （库的按钮文档：「都强调就等于都不强调」）。
 *
 * 折射/模糊**不在这里**：内容层的按钮不采背景。要玻璃就显式传 `glass`。
 */

type Variant = 'default' | 'primary' | 'glass' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg'

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'children'> {
  children?: ReactNode
  variant?: Variant
  size?: Size
  icon?: IconName
  trailingIcon?: IconName
  loading?: boolean
}

export function Button({
  children,
  variant = 'default',
  size = 'md',
  icon,
  trailingIcon,
  loading = false,
  className = '',
  disabled,
  ...rest
}: Props) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={`btn btn-${variant} btn-${size} ${className}`}
    >
      {loading ? (
        <span className="btn-spinner" aria-hidden="true" />
      ) : (
        icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} />
      )}
      {children}
      {trailingIcon && <Icon name={trailingIcon} size={size === 'sm' ? 14 : 16} />}
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
  ...rest
}: Omit<Props, 'children' | 'icon'> & { label: string; icon: IconName }) {
  return (
    <button
      type="button"
      {...rest}
      aria-label={label}
      title={label}
      className={`btn btn-${variant} btn-${size} btn-icon-only ${className}`}
    >
      <Icon name={icon} size={size === 'sm' ? 14 : 16} />
    </button>
  )
}

/** 按钮排成一行 */
export function ButtonRow({
  children,
  className = '',
}: {
  children: ReactNode
  className?: string
}) {
  return <div className={`btn-row ${className}`}>{children}</div>
}
