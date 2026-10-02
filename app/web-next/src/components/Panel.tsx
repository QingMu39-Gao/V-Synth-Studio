import type { ReactNode } from 'react'
import { MaterialView } from '@ttqtt/liquid-glass-react'
import { GlassContent, GlassLayer } from '@/components/Glass'
import { useGlobalGlass, useMaterial } from '@/lib/useGlass'

/**
 * 面板 / 卡片 —— **现在是玻璃面**（用户要求「全局玻璃」）。
 *
 * ⚠️ 这一条**违反了库的设计分层**，而且是被明确写进 `docs/design-system.md` 的第一条：
 *
 * > 玻璃不进内容层。满屏半透明卡片是最常见的"不像 Apple"的写法。
 *
 * 之前这里用的是库替这种情况准备的 `MaterialView`（有模糊、有底色，但没有折射、
 * 没有高光边、不跟背景翻转）。用户看过之后的要求是「实现全局玻璃」——
 * 需求优先，所以改成 `GlassSurface`，但把代价记在这里：
 *
 * - 面板用 **`size="large"`**：它是容器，里面坐着小玻璃控件（按钮、分段控件）。
 *   小玻璃套小玻璃会被库判为「玻璃叠玻璃」（开发模式直接告警），大玻璃才是合法容器。
 * - 大玻璃更实（0.86 / 0.90 不透明）→ 背景照片透过来得少。要更透只能用 `small`，
 *   但那样面板里就不能再放玻璃控件了。
 * - 一个视图里的折射元素要守住库给的预算（≤20 个），页面上每多一块面板就多一个位移贴图。
 *
 * 内层那些卡片（`.quick` / `.choice` / 输入框…）**不再各自画不透明的底**，
 * 改成玻璃上的半透明填充 —— 在玻璃里画一块实色，等于在材质上凿了个洞
 * （库的 `known-limitations.md` 记过一模一样的问题）。
 */
export function Panel({
  children,
  className = '',
  padded = true,
}: {
  children: ReactNode
  className?: string
  padded?: boolean
}) {
  const { globalGlass } = useGlobalGlass()
  /* 材质两档共用的背景参数 —— 这个开关不碰背景（`useMaterial()` 只读等级）。 */
  const { material } = useMaterial()

  /**
   * ⚠️ **两档必须渲染同一个元素类型，不能一个走 `MaterialView`、一个走 `GlassSurface`。**
   *
   * 踩过（用户报「玻璃等级滑条没有任何动画，甚至一帧拉过去的」）：组件**类型**一变，
   * React 到那个边界就把整棵子树卸载重建 —— 实测 3 级 → 4 级时
   * `滑块根同一个节点: false`、`滑块镜头同一个节点: false`、`轨道同一个节点: false`，
   * 全页 DOM 换一遍。后果有两个，第二个才是要命的：
   *
   *   1. 整页重建阻塞主线程 >1.1s（`requestAnimationFrame` 都被饿死）；
   *   2. 滑块那 520ms 的弹簧过渡**永远放不出来** —— 新建的 lens 元素一出生就带着
   *      最终位置的 `--lg-progress`，没有「从旧位置到新位置」这个过程可插值。
   *
   * 所以这里从 `GlassLayer` 那套（`GlassSurface` + `.lg-content` 内层）改成**直接驱动
   * `MaterialView`**，两个分支的类名与子节点结构都对齐，React 复用同一个 div：
   *
   * | | 1~3 级 | 4 级 |
   * |---|---|---|
   * | 玻璃面本身 | `.lg-material-view` + 轻量底色 | 同一层 + `.lg-root.lg-surface` |
   * | 内边距 | 直接挂在这一层 | 挂在内层内容 div |
   *
   * `MaterialView` 的来源（`index.js:974`）只是把剩余 props 透传给一个普通 `div`，
   * 所以 class / data 属性都能直接给 —— **不要**在这种情况下换成 `GlassSurface`。
   */
  return (
    <MaterialView
      radius={20}
      /* 玻璃那一档要压掉 `.lg-material-view` 自带的 `background: var(--lg-material-thin)`：
         那张位移贴图是**采样背后再画一遍**，本层不透明就等于把它盖住了（看不见折射）。 */
      thickness={globalGlass ? 'ultraThin' : 'thin'}
      {...(globalGlass
        ? {
            className: `lg-root lg-surface panel ${className}`,
            style: { padding: 0, background: 'transparent' },
            'data-lg-glass': 'small',
            'data-material': material,
          }
        : { className: `panel ${padded ? 'panel-padded' : ''} ${className}` })}
    >
      {/* ⚠️ **两个分支的子树形状必须一模一样** —— 都包一层 div，只是类名不同。
          第一版这里写了 `{globalGlass ? <div className={…}>{children}</div> : children}`，
          结果切档时 MutationObserver 抓到的是
          `-header.panel-head / -div.slider-row / -p.hint / -div.choice-grid` ——
          **面板元素本身复用了，孩子却全被删了重建**（裸 children ↔ 包一层的 children
          在 React 眼里不是一个形状）。滑块就在 `.slider-row` 里，于是它仍然一帧到位。

          内边距在非玻璃档挂在 MaterialView 自己身上（`.panel-padded` 在它的类名表里），
          在玻璃档必须挂在内容层：玻璃面的 `padding={0}` 是行内样式，
          写在 CSS 里的 `.panel-padded` 会被它盖掉（第一版就是这么丢的，
          表现是文字贴着玻璃边缘）。 */}
      <div className={globalGlass && padded ? 'panel-padded' : ''}>{children}</div>
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
  size,
}: {
  children: ReactNode
  className?: string
  contentClassName?: string
  /** 内容层撑满玻璃面高度（侧栏那种要自己滚的用得上） */
  fill?: boolean
  radius?: number | 'pill'
  padding?: number
  /**
   * 小玻璃还是大玻璃 —— **这不是同一个效果的两种大小**（设计系统第 2 节）。
   *
   * | | `small` | `large` |
   * |---|---|---|
   * | 用于 | 按钮、标签栏、工具栏 | 侧边栏、菜单、sheet、浮层 |
   * | 模糊 | 14px | 40px |
   * | 明暗翻转 | 随背景翻转 | **不翻转** |
   *
   * 侧栏那种 200×500 的整列必须 `large`：给 `small` 的话模糊只有 1.5px（clear 材质），
   * 等于没糊；而且它会跟着背后的内容翻转明暗，大表面翻起来是没法读的。
   */
  size?: 'small' | 'large'
}) {
  const { material } = useMaterial()
  return (
    <GlassLayer
      material={material}
      className={className}
      contentClassName={contentClassName}
      radius={radius}
      padding={padding}
      size={size}
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
