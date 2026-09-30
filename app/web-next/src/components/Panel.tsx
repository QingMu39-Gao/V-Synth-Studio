import type { ReactNode } from 'react'
import { MaterialView } from '@ttqtt/liquid-glass-react'
import { GlassContent, GlassLayer } from '@/components/Glass'
import { useMaterial } from '@/lib/useGlass'

/**
 * 面板 / 卡片 —— **内容层的半透明材质**，用库的 `MaterialView`。
 *
 * 它自己的注释就是为这件事写的：
 *
 * > A *standard material* — the content layer's translucency tool, and **the right answer
 * > whenever the instinct is to reach for glass on something that does not float**.
 * > It blurs and tints, but it does **not** lens, does **not** carry a specular rim and
 * > does **not** flip with its backdrop, because it is part of the content rather than
 * > hovering above it.
 *
 * ⚠️ **这里返工过一次，方向值得记住。**
 *
 * 第一版我把面板做成**不透明实色**（`background: var(--lg-bg)`），依据是设计系统第 1 节
 * 那条「玻璃不进内容层」。结果用户的原话是「现在似乎只有侧边栏和顶部是玻璃材质」——
 * 界面看着像「两条玻璃 + 一堆白板」，割裂。
 *
 * 我把那条规矩理解得太死了。规矩要防的是**玻璃**进内容层（折射 + 高光边 + 跟背景翻转，
 * 这些让内容"浮起来"，满屏都浮就没有层次可言）。而 `MaterialView` 恰恰是库为了
 * 防止大家滥用玻璃而准备的东西 —— 有模糊、有底色，但没有折射、没有高光边、不跟背景翻转。
 *
 * 三档厚度（库的 token，浅色/深色各一套，自动切换）：
 *   thin     rgb(255 255 255 / .70)   透得多，正文对比会不够
 *   regular  rgb(255 255 255 / .82)   ← 默认，有透感、字也读得清
 *   thick    rgb(255 255 255 / .93)   几乎不透明
 *
 * 两件它替我们做的事（都在库的 `components.css` 里）：
 *   - 减少透明度时 `backdrop-filter: none` + 不透明底色
 *   - 强制色彩模式时加一圈 `inset` 内描边
 * 自己写 `backdrop-filter` 会把这些全丢掉。
 */
export function Panel({
  children,
  className = '',
  padded = true,
  thickness = 'regular',
}: {
  children: ReactNode
  className?: string
  padded?: boolean
  /** 内容层材质的厚度。想让某块更实就传 `thick` */
  thickness?: 'ultraThin' | 'thin' | 'regular' | 'thick'
}) {
  return (
    <MaterialView
      thickness={thickness}
      radius={20}
      className={`panel ${padded ? 'panel-padded' : ''} ${className}`}
    >
      {children}
    </MaterialView>
  )
}

/** 玻璃面的面板 —— **只在浮起来的那一层用**（栏、浮层、提示条） */
export function GlassPanel({
  children,
  className = '',
  contentClassName,
  fill = false,
  radius,
  padding,
}: {
  children: ReactNode
  className?: string
  contentClassName?: string
  /** 内容层撑满玻璃面高度（侧栏那种要自己滚的用得上） */
  fill?: boolean
  radius?: number | 'pill'
  padding?: number
}) {
  const { material } = useMaterial()
  return (
    <GlassLayer
      material={material}
      className={className}
      contentClassName={contentClassName}
      radius={radius}
      padding={padding}
    >
      <GlassContent fill={fill}>{children}</GlassContent>
    </GlassLayer>
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

/** 小标签。实色填充 —— 同样是内容层的东西，不套玻璃。 */
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
