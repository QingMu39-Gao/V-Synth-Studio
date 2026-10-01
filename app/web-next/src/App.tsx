import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { api } from '@/lib/api'
import type { AppState } from '@/lib/types'
import { Icon, type IconName } from '@/components/Icon'
import { GlassPanel, Panel } from '@/components/Panel'
import { Button } from '@/components/Button'
import {
  BackdropToneProvider,
  GlassProvider,
  ScrollEdge,
  useGlassPolicy,
} from '@ttqtt/liquid-glass-react'
import { levelMaterial, levelTransparency, useGlassLevel } from '@/lib/useGlass'
import { useNavLens } from '@/lib/useNavLens'
import { hideBoot } from '@/lib/boot'
import { materialOptions } from '@/components/Glass'
import { Dashboard } from '@/pages/Dashboard'
import { Settings } from '@/pages/Settings'
import { Placeholder } from '@/pages/Placeholder'
import { Resources } from '@/pages/Resources'
import { Convert } from '@/pages/Convert'
import { Video } from '@/pages/Video'
import { Audio } from '@/pages/Audio'
import { Lyrics } from '@/pages/Lyrics'
import { Pv } from '@/pages/Pv'

/**
 * 外壳：顶栏 + 侧栏 + 内容区。
 *
 * ## 玻璃用在哪 —— 这是这个文件唯一需要解释的事
 *
 * **玻璃的范围**：侧栏 + 顶栏里的控件 + 正文面板（「全局玻璃」开关，见 `components/Panel.tsx`）。
 * 顶栏右上角那组控件已被用户要求移除，现在顶栏只有品牌。
 * 上一版我给侧栏、主面板、每张卡、每个按钮都套了玻璃，结果满屏半透明、
 * 没有东西真的浮起来 —— 用户的原话是「明亮还是很割裂」。
 *
 * ## 两种材质
 *
 * `GlassProvider` 统一管主题与辅助功能偏好；**玻璃等级由 `useGlassLevel()` 决定**（材质 / 透明度 / 折射全从它派生）
 * （毛玻璃 / 液态玻璃），传给 `<GlassPanel>`。这两个东西是分开的：
 * 主题是全局的一套配色，材质是玻璃面自己的事。
 *
 * ## 主题为什么不能自己写 `data-theme`
 *
 * 库的 `GlassProvider` 会写 `<html data-lg-theme>`，而且它自己的全部 token
 * （`--lg-label` / `--lg-bg` / `--lg-separator` …）都挂在 `[data-lg-theme="light|dark"]`
 * 下 —— `:root` 上没有裸定义。所以主题**只有一个来源**：喂给 Provider 的那个值。
 * 两个写入方（我写 `data-theme`、它写 `data-lg-theme`）就会互相打架。
 */

const PAGES: {
  id: string
  title: string
  sub: string
  icon: IconName
  group: string
  ported?: boolean
}[] = [
  { id: 'dashboard', title: '总览', sub: '环境检测与常用入口', icon: 'home', group: '工作台', ported: true },
  { id: 'convert', title: '工程转换', sub: '离线把工程转到另一个编辑器', icon: 'swap', group: '工作台' },
  { id: 'video', title: '视频解析', sub: 'B 站 / YouTube 等平台的 MV 下载', icon: 'video', group: '素材获取' },
  { id: 'audio', title: '音频工具', sub: '人声分离 / 格式转换 / 变调变速', icon: 'wave', group: '素材获取' },
  { id: 'lyrics', title: '歌词', sub: '网易云 / QQ 音乐搜词，导出 LRC · SRT', icon: 'music', group: '素材获取' },
  { id: 'pv', title: '文字 PV', sub: '把歌词做成动态歌词视频（JIZURA）', icon: 'video', group: '素材获取' },
  { id: 'resources', title: '资源库', sub: '立绘、声库、插件、音源站（仅链接）', icon: 'library', group: '素材获取' },
  { id: 'settings', title: '设置', sub: '外观、路径、外部工具', icon: 'gear', group: '系统', ported: true },
]

export type ThemeMode = 'system' | 'light' | 'dark'

const THEME_KEY = 'qingmu.theme'

export function readTheme(): ThemeMode {
  try {
    const v = localStorage.getItem(THEME_KEY)
    if (v === 'light' || v === 'dark' || v === 'system') return v
  } catch {
    /* 隐私模式 */
  }
  return 'system'
}

export default function App() {
  const [active, setActive] = useState<string>(() => {
    const m = location.hash.match(/^#\/(\w+)/)
    return m && PAGES.some((p) => p.id === m[1]) ? m[1] : 'dashboard'
  })
  const [theme, setTheme] = useState<ThemeMode>(readTheme)
  const [state, setState] = useState<AppState | null>(null)
  const [refreshing, setRefreshing] = useState(true)
  const [dead, setDead] = useState<string | null>(null)
  const [toasts, setToasts] = useState<{ id: number; msg: string; tone: string }[]>([])

  const toast = useCallback((msg: string, tone = 'info') => {
    const id = Date.now() + Math.random()
    setToasts((t) => [...t, { id, msg, tone }])
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200)
  }, [])

  const refreshState = useCallback(async () => {
    setRefreshing(true)
    try {
      setState(await api.state())
      setDead(null)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setDead(msg)
      toast(`无法连接本地服务：${msg}`, 'err')
    } finally {
      setRefreshing(false)
    }
  }, [toast])

  useEffect(() => {
    void refreshState()
  }, [refreshState])

  /* 首次 /api/state 落定（成功或失败）就揭开启动画面 —— 失败也要揭，
     否则用户看到的是一个永远转圈的遮罩，而不是「连不上本地服务」那块提示。 */
  useEffect(() => {
    if (!refreshing) hideBoot()
  }, [refreshing])

  const navigate = useCallback((id: string) => {
    if (!PAGES.some((p) => p.id === id)) return
    setActive(id)
    location.hash = `#/${id}`
  }, [])

  useEffect(() => {
    const onHash = () => {
      const m = location.hash.match(/^#\/(\w+)/)
      if (m && PAGES.some((p) => p.id === m[1])) setActive(m[1])
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  const changeTheme = useCallback((m: ThemeMode) => {
    setTheme(m)
    try {
      localStorage.setItem(THEME_KEY, m)
    } catch {
      /* 隐私模式：本次会话仍然生效 */
    }
  }, [])

  const current = PAGES.find((p) => p.id === active)!

  /**
   * 页面表。**每个页面都从 App 拿同一份 state**（见 `pages/types.ts` 的注释：
   * 页面自己再拉一次就会出现两页数字对不上的画面）。
   * ⚠️ 用固定顺序写，别用对象字面量的插入顺序去依赖什么 —— 这里只是查表。
   */
  const pageProps = { state, onNavigate: navigate, onRefreshState: refreshState, onToast: toast }
  const pageViews: Record<string, ReactNode> = {
    dashboard: <Dashboard {...pageProps} refreshing={refreshing} />,
    settings: <Settings {...pageProps} theme={theme} onThemeChange={changeTheme} />,
    resources: <Resources {...pageProps} />,
    convert: <Convert {...pageProps} />,
    video: <Video {...pageProps} />,
    audio: <Audio {...pageProps} />,
    lyrics: <Lyrics {...pageProps} />,
    pv: <Pv {...pageProps} />,
  }
  const { level } = useGlassLevel()
  const material = levelMaterial(level)
  const navRef = useRef<HTMLElement>(null)
  const lensRef = useRef<HTMLSpanElement>(null)
  useNavLens(navRef, lensRef, active)


  return (
    <GlassProvider
      theme={theme}
      transparency={levelTransparency(level)}
      /* ⚠️ 材质要写在 **Provider** 上，不能只给自家包装的面传：库的控件
         （GlassButton / GlassSegmentedControl / TabBar…）不接材质参数，读的是 policy。
         之前漏了这行，实测「切到液态玻璃只有侧栏变 clear，按钮还是 regular」——
         用户看到的就是「除了侧栏都没有实现对应的玻璃材质」。
         GlassPolicy 里没有 refraction，所以折射仍由 materialOptions() 按面给。 */
      material={materialOptions(material).material}
      /*
        折射（SVG 位移滤镜）**只在选「液态玻璃」时打开**。
        库默认是关的，理由两条，都写在它的 README 和 AGENTS.md 里：
          - 「开销大约三倍」（它文档站的开关也这么写）
          - 「只有在自己的 Chrome / GPU 矩阵上验证过才打开」
        我们这里可以开：桌面端跑的就是 WebView2（Chromium），图形栈是确定的，
        不是「一堆未知浏览器」。而用户选「液态玻璃」要的就是边缘折弯 ——
        不开的话两种材质的差别只剩模糊半径，名不副实。
        选「毛玻璃」时是纯 CSS，零额外开销。
      */
      /* 折射只在液态档要（3、4 级）—— 按材质判，别再写死某一个等级号：
         写 `level === 3` 时 4 级反而没有位移贴图（踩过）。 */
      enableSvgAuto={material === 'liquid'}
    >
      <ToneScope>
        <div className="app">
          {/* 平栏的代价：内容会从它下面经过。库的 ScrollEdge 就是治这个的
              （它的注释：「不是装饰、不是色块，只在内容真的从浮动 UI 下面经过时出现」）。
              不给 targetRef 就是盯页面滚动 —— 正是我们这个场景。 */}
          <ScrollEdge edge="top" variant="soft" height={64} className="app-top-edge" />
          {/* ── 顶栏：只有品牌，**右上角整块移除** ──────────────────
              本来是「一条平的行 + 里面的玻璃控件」（库的 `GlassToolbar` 思路：
              工具栏本身不画底，玻璃是每一组）。用户要求去掉右上角那一组，
              于是这里只剩品牌。
              功能没有丢：材质切换在「设置 → 玻璃材质」里，重新检测在总览页的
              「环境就绪度」里，连接状态由连不上时那一整块提示负责。 */}
          <header className="app-topbar">
            <div className="app-topbar-inner">
              <div className="brand">
                {/* 真的应用图标（`app/desktop/icons/128x128.png` 拷进 app/web/img/ 才伺服得到）。
                    以前这里是个纯色方块 —— 没有图，用户看着就是「logo 显示不正常」。 */}
                <img className="brand-mark" src="/img/logo.png" alt="" width={26} height={26} />
                <span className="brand-name">V-Synth-Studio</span>
              </div>
            </div>
          </header>

          <div className="app-body">
            {/* ── 侧栏：玻璃（浮起来的那一层）──────────────────── */}
            <GlassPanel
              className="app-sidebar"
              contentClassName="app-sidebar-inner"
              fill
              /* 侧栏是**大玻璃**：228×500 的整列，模糊与不翻转都跟小玻璃不是一套参数 */
              size="large"
              radius={26}
              padding={12}
            >
              <nav aria-label="主导航" className="app-nav" ref={navRef}>
                {/* 高亮块本身来自库的 .lg-selection-lens：外观、弹簧曲线、阴影都是它的，
                    我们只负责量位置（见 useNavLens）*/}
                <span className="lg-selection-lens nav-lens" ref={lensRef} aria-hidden="true" />
                {PAGES.map((p, i) => (
                  <div key={p.id}>
                    {p.group !== PAGES[i - 1]?.group && <div className="nav-group">{p.group}</div>}
                    <button
                      type="button"
                      className="nav-row"
                      aria-current={active === p.id ? 'page' : undefined}
                      onClick={() => navigate(p.id)}
                    >
                      <Icon name={p.icon} size={17} />
                      <span className="nav-row-label">{p.title}</span>
                      {!p.ported && <span className="nav-row-tag">待迁</span>}
                    </button>
                  </div>
                ))}
              </nav>

              <div className="sidebar-foot">
                <ThemeSwitch value={theme} onChange={changeTheme} />
              </div>
            </GlassPanel>

            {/* ── 内容区：**不是玻璃**。正文用实色，字才读得清 ──── */}
            <main className="app-main" id="main" tabIndex={-1}>
              <header className="page-head">
                <h1 className="page-title">{current.title}</h1>
                <p className="page-sub">{current.sub}</p>
              </header>

              <div className="page-body" key={active}>
                {dead && !state ? (
                  <Panel>
                    <div className="stack">
                      <p className="finding-title">连不上本地服务</p>
                      <p className="finding-text">{dead}</p>
                      <Button icon="refresh" onClick={refreshState}>
                        重试
                      </Button>
                    </div>
                  </Panel>
                ) : (
                  /* 页面表：加一页 = 在 PAGES 里加一行 + 这里加一行。三元链到 8 页已经读不动了。 */
                  (pageViews[active] ?? <Placeholder title={current.title} />)
                )}
              </div>
            </main>
          </div>

          <div className="toasts" aria-live="polite">
            {toasts.map((t) => (
              <div key={t.id} className="toast" data-tone={t.tone}>
                {t.msg}
              </div>
            ))}
          </div>
        </div>
      </ToneScope>
    </GlassProvider>
  )
}

/* ══════════════════════════════════════════════════════════════ 侧栏高亮块 ══ */

/**
 * 让选中项外面那块高亮**滑**过去。
 *
 * 位置必须**实测**（`offsetTop` / `offsetHeight`），不能按数据算 —— 分组标题、行高、
 * 「待迁」标签都会影响它。库自己的 `useSelectionLens`（`controls/segmented.tsx`）就是
 * 这么做的，而且注释里写明「the same lens has to follow a row of segments and
 * **a vertical column of sidebar rows**」—— 正是这个场景。但它**没有从包里导出**，
 * 所以这里只重写「量位置」这十来行；**外观、弹簧曲线、阴影全部复用库的
 * `.lg-selection-lens`**：那块 span 由 `--lg-slot-x/y`、`--lg-lens-shown` 驱动，
 * 三个属性都带 `@property` 声明，过渡挂在 `transform` 上。
 *
 * 三个必须注意的点（都会变成看得见的 bug）：
 *
 *  1. **首帧不能滑。** 第一次量位置时先把 `transition` 关掉，量完强制回流再恢复；
 *     否则打开界面会看到一个方块从左上角飞过来。
 *  2. **用 `offsetTop`，不用 `getBoundingClientRect()`。** 侧栏内容会滚动，
 *     rect 随滚动偏移；`offsetTop` 相对 offsetParent 恒定 ——
 *     前提是 nav 上有 `position: relative`（CSS 里 `.app-nav` 那条）。
 *  3. **行要 `position: relative; z-index: 1`**，否则被这块绝对定位的高亮盖住。

/* ══════════════════════════════════════════════════════════════ 背景色调 ══ */

/**
 * 声明「这层玻璃背后是深是浅」。
 *
 * ⚠️ **不声明的话材质选不起来。** 库的规矩（`docs/design-system.md` 第 4 节）：
 *
 * > **背景色调：声明，不采样。** `tone="mixed"` 是安全默认值：未知背景保持应用外观，
 * > 并把 `clear` **退回 `regular`**，而不是赌一把。
 *
 * 实测踩过：不声明时选「液态玻璃」完全没反应 —— 玻璃面报的是
 * `data-material="regular"`，一个 `feDisplacementMap` 都没有，因为 `clear` 被退回了。
 *
 * 它为什么不能自己猜：读背景色调要么截屏页面、要么跨源读像素，库的 `AGENTS.md`
 * 明确禁止这两件事。所以由区域声明、后代继承。
 *
 * 我们用 `useGlassPolicy()` 拿 Provider **解析后**的主题（`'system'` 已经被
 * 解析成 light/dark），再把它声明成色调 —— 只有一个真相来源。
 */
function ToneScope({ children }: { children: React.ReactNode }) {
  const { resolvedTheme } = useGlassPolicy()
  return <BackdropToneProvider tone={resolvedTheme}>{children}</BackdropToneProvider>
}

/* ══════════════════════════════════════════════════════════════ 材质开关 ══ */

/**
 * 毛玻璃 / 液态玻璃的选择**搬去设置页了**（「设置 → 玻璃材质」两张选项卡）。
 *
 * 这里原来放的是顶栏那颗 `GlassSegmentedControl` 胶囊 —— 用户要求把右上角整块移除，
 * 于是它连同「重新检测」按钮一起走了。**功能没有丢**，只是换了地方。
 */
/* ══════════════════════════════════════════════════════════════ 主题开关 ══ */

/**
 * 主题切换。**故意留着手写的 `.seg`，不换成库的 `GlassSegmentedControl`。**
 *
 * 它在侧栏那块玻璃**里面** —— 库的规矩是「不要玻璃叠玻璃」（放玻璃上的元素用填充和
 * 透明度，不再叠一层）。顶栏那颗同理（已随右上角整块移除）。
 */
function ThemeSwitch({ value, onChange }: { value: ThemeMode; onChange: (m: ThemeMode) => void }) {
  const labels: Record<ThemeMode, string> = { system: '跟随系统', light: '明亮', dark: '黑暗' }
  const order: ThemeMode[] = ['system', 'light', 'dark']
  return (
    <div className="seg seg-block" role="group" aria-label="主题">
      {order.map((m) => (
        <button
          key={m}
          type="button"
          className="seg-item"
          aria-pressed={value === m}
          onClick={() => onChange(m)}
        >
          {labels[m]}
        </button>
      ))}
    </div>
  )
}
