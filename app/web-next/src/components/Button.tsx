import type { ButtonHTMLAttributes, ReactNode } from 'react'
import {
  GlassButton,
  GlassIconButton,
  type ControlSize,
  type GlassButtonVariant,
} from '@ttqtt/liquid-glass-react'
import { Icon, type IconName } from '@/components/Icon'

/**
 * 按钮 —— **库的 `GlassButton`**，不是手写的。
 *
 * 之前这里是手写 `.btn`：背景 + 描边 + `scale(.97)`，**材质一点都没有**。
 * 用户报的是「除了侧边栏都没有实现对应的玻璃材质」—— 而控件层恰恰是材质最该出现的地方：
 * 库的演示页里，玻璃就是一颗颗小胶囊（按钮、分段控件、工具栏分组），
 * 正文区反而是平的。手写按钮让整个界面只剩两块大板有材质。
 *
 * 变体映射（对齐库 `button.tsx` 的注释：style 而不是 size 标记主操作，一屏最多一个）：
 *
 * | 我们 | 库 | 用在哪 |
 * |---|---|---|
 * | `default` | `glass` | 浮起来的玻璃胶囊。**内容区也是它** —— 演示页的「默认按钮」就是白的玻璃 |
 * | `primary` | `glassProminent` | 唯一的主动作：底色 `--lg-accent-fill`，白字（对比度量过的那个） |
 * | `ghost` | `plain` | 无底，只有字 |
 * | `danger` | `destructive` | 危险操作 |
 *
 * `controlSize` 管视觉高度（`GlassSurfaceOptions.size` 管的是**玻璃厚度**，两件事别混）。
 */

type Variant = 'default' | 'primary' | 'glass' | 'ghost' | 'danger'
type Size = 'sm' | 'md' | 'lg'

const VARIANT: Record<Variant, GlassButtonVariant> = {
  default: 'glass',
  primary: 'glassProminent',
  glass: 'glass',
  ghost: 'plain',
  danger: 'destructive',
}

const SIZE: Record<Size, ControlSize> = { sm: 'small', md: 'regular', lg: 'large' }

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
  const glyph = size === 'sm' ? 14 : 16
  return (
    <GlassButton
      type="button"
      {...rest}
      disabled={disabled || loading}
      loading={loading}
      variant={VARIANT[variant]}
      controlSize={SIZE[size]}
      className={className}
      icon={icon && <Icon name={icon} size={glyph} />}
      trailingIcon={trailingIcon && <Icon name={trailingIcon} size={glyph} />}
    >
      {children}
    </GlassButton>
  )
}

/** 只有图标的按钮。`label` 必填 —— 图标按钮必须有可访问名（库的 `GlassIconButton` 强制要求）。 */
export function IconButton({
  label,
  icon,
  size = 'md',
  variant = 'default',
  className = '',
  ...rest
}: Omit<Props, 'children' | 'icon' | 'trailingIcon'> & { label: string; icon: IconName }) {
  return (
    <GlassIconButton
      type="button"
      {...rest}
      aria-label={label}
      title={label}
      variant={VARIANT[variant]}
      controlSize={SIZE[size]}
      className={className}
      icon={<Icon name={icon} size={size === 'sm' ? 14 : 16} />}
    />
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
