import { GlassSurface, type GlassSurfaceOptions } from '@ttqtt/liquid-glass-react'
import { createContext, useContext, type ReactNode } from 'react'

/**
 * 玻璃材质 —— **两种，都来自库，没有一行是手写的**。
 *
 * 以前这里是手写的 `.glass` / `.glass-panel` / `.glass-chip`（blur + saturate + inset 高光），
 * 效果只是个模糊的半透明方块。现在换成 [`@ttqtt/liquid-glass-react`](https://github.com/Tsdsj/liquid-glass-react)
 * 的 `GlassSurface` —— 库自己的 `docs/design-system.md` 第 5 节：
 *
 * > 材质由三样东西定义：**折射**、**一条发丝边**、**干净的内部**。
 *
 * 而手写版本一样都没有。
 *
 * | 材质 | 库的取值 | 观感 |
 * |---|---|---|
 * | 毛玻璃 `frosted` | `material="regular"`、`refraction={0}` | 模糊 + 提色 + 发丝边，不折射 |
 * | 液态玻璃 `liquid` | `material="clear"`、`refraction={32}` | 边缘把背后的内容折弯 |
 *
 * ⚠️ **只有 Chromium 认那条 SVG 位移滤镜**（WebView2 就是 Chromium，没问题；
 * macOS 的 WKWebView / Firefox 拿不到）。库对此有内置降级：它把**真实的 `blur()` 放在
 * CSS 链的最前面**，滤镜只负责位移 —— 所以哪家引擎丢掉了 `url()`，剩下的仍然是磨砂，
 * 而不是一块透明的洞。我们不需要自己写 `@supports` 兜底。
 *
 * ⚠️ 折射**开销约三倍**，库默认是关的（文档站的开关也写着「默认关着」）。
 * 所以它只在用户明确选了「液态玻璃」时才开。
 */

export type GlassMaterial = 'frosted' | 'liquid'

/**
 * 默认毛玻璃，不是液态玻璃。
 *
 * 设计系统第 3 节把两者的用处分得很清：`regular`（毛玻璃）是**默认**，「栏、侧边栏、
 * 菜单、文字较多的表面」都用它；`clear`（这里的液态玻璃）**只用于媒体内容之上、
 * 且上层内容本身明亮醒目**的场合。
 *
 * 实测过默认给 `clear` 的后果（明亮模式，`tone=light`）：库会叠一层
 * `.lg-tint = rgba(0,0,0,.35)` 的 35% 黑压，而 `clear/small` 的模糊只有 1.5px
 * （开折射后再减半，0.75px）—— 于是顶栏和侧栏变成两块**纯灰板**，
 * 既没有模糊也看不出折射。液态玻璃留着当可选项，但它不是这个界面的默认。
 */
export const DEFAULT_MATERIAL: GlassMaterial = 'frosted'

const STORAGE_KEY = 'qingmu.glass'

export function readMaterial(): GlassMaterial {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'frosted' || v === 'liquid') return v
  } catch {
    /* 隐私模式：用默认值 */
  }
  return DEFAULT_MATERIAL
}

export function writeMaterial(m: GlassMaterial) {
  try {
    localStorage.setItem(STORAGE_KEY, m)
  } catch {
    /* 隐私模式：本次会话仍然生效 */
  }
}

/** 材质 → 库的参数的映射。这是「两种材质」的唯一定义处。 */
export function materialOptions(m: GlassMaterial): GlassSurfaceOptions {
  return m === 'frosted'
    ? { material: 'regular', refraction: 0 }
    : { material: 'clear', refraction: 32 }
}

/* ══════════════════════════════════════════════════════════════════════════ */

interface GlassLayerProps extends Omit<GlassSurfaceOptions, 'material'> {
  children: React.ReactNode
  /** 挂到**玻璃面本身**上的类。尺寸、外边距、定位放这里。 */
  className?: string
  /** 挂到**内容层**（`.lg-content`）上的类。要撑满高度时用 `h-full`。 */
  contentClassName?: string
  /** 圆角。库的刻度：14 / 20 / 26 / 34，或 `'pill'`。 */
  radius?: number | 'pill'
  /** 内容内边距。默认 18px（库的 `.lg-surface` 值）。 */
  padding?: number
  style?: React.CSSProperties
  material: GlassMaterial
}

/**
 * 一块玻璃面。**浮起来的那一层**才用它 —— 栏、工具栏、侧栏、浮层、提示。
 *
 * ⚠️ 库自己的注释写得很直接：
 *
 * > This belongs to the navigation / control layer — bars, groups, overlays.
 * > **It is not a card**: content-layer containers use `Card`, `List` or `MaterialView`,
 * > which do not sample the backdrop at all.
 *
 * 也就是**别再往卡片上套玻璃**。满屏半透明 = 没有东西真的浮起来，这是「割裂」的真因。
 */
export function GlassLayer({
  children,
  className,
  contentClassName,
  radius,
  padding,
  style,
  material,
  ...rest
}: GlassLayerProps) {
  /**
   * 内容层的类名靠 **context 传下去**，由每个 `GlassPanel` 用它包一层真盒子。
   *
   * ⚠️ 这里踩过两次，别再改回「用 DOM 找子元素」那套：
   *
   *   1. `firstElementChild` —— 只给**第一个**子元素加类。顶栏里只有「品牌」拿到了
   *      `display:flex`，右边那组按钮没有 → 换行成两行，玻璃跟着撑高 32px。
   *   2. `display: contents` 的包装当锚点 —— **它不生成盒子**（`offsetWidth === 0`），
   *      所以我写在子元素上的 `display:flex` 全废了，`innerW=0`、内容塌掉。
   *
   * 库生成的 `.lg-content` 我们拿不到 ref，React 的子元素也没法批量加类 ——
   * 用一个 context 让它自己包，是最不容易出错的做法（一个真 div，看得见摸得着）。
   */
  return (
    <GlassSurface
      {...materialOptions(material)}
      {...rest}
      radius={radius}
      className={className}
      style={{ ...style, ...(padding !== undefined ? { padding } : null) }}
    >
      <ContentClass.Provider value={contentClassName ?? ''}>{children}</ContentClass.Provider>
    </GlassSurface>
  )
}

const ContentClass = createContext('')

/**
 * 玻璃面里的内容层。**自己**包一层 div，类名从 `GlassLayer` 传下来。
 *
 * 直接放内容进 `GlassLayer` 也行（会落到库的 `.lg-content` 里），但只要需要
 * flex / 滚动 / 撑满，就用这个 —— 它会拿到 `contentClassName`。
 */
export function GlassContent({
  children,
  className,
  fill = false,
}: {
  children: ReactNode
  className?: string
  /** 撑满玻璃面高度（侧栏那种要自己滚的用得上） */
  fill?: boolean
}) {
  const cls = useContext(ContentClass)
  return (
    <div
      className={`${cls} ${fill ? 'glass-fill' : ''} ${className ?? ''}`.trim()}
    >
      {children}
    </div>
  )
}

/**
 * 内联玻璃面：**不要新框**，就用祖先那层玻璃。
 *
 * 用于放在玻璃栏**里面**的控件。库对「玻璃叠玻璃」有内置处理（小玻璃在共享面上
 * 自动画成平面），但那需要同一条 `GlassSurface` 树；这里的做法更直接：什么都不画。
 * 库的规矩（`docs/design-system.md` 第 1 节第 2 条）：
 *
 * > 放在玻璃上的元素用填充、透明度和 vibrancy，**不再叠一层玻璃**。
 */
export function GlassInline({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={`glass-inline ${className ?? ''}`}>{children}</div>
}
