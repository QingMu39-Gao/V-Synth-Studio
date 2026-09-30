import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { api } from '@/lib/api'
import type { AppState } from '@/lib/types'
import { Icon, type IconName } from '@/components/Icon'
import { GlassPanel } from '@/components/Panel'
import { Button } from '@/components/Button'
import { BackdropToneProvider, GlassProvider, MaterialView, useGlassPolicy } from '@ttqtt/liquid-glass-react'
import { useMaterial } from '@/lib/useGlass'
import { Dashboard } from '@/pages/Dashboard'
import { Settings } from '@/pages/Settings'
import { Placeholder } from '@/pages/Placeholder'

/**
 * 外壳：顶栏 + 侧栏 + 内容区。
 *
 * ## 玻璃用在哪 —— 这是这个文件唯一需要解释的事
 *
 * **只有顶栏和侧栏是玻璃**，正文区的卡片一律实色。理由见 `components/Panel.tsx`。
 * 上一版我给侧栏、主面板、每张卡、每个按钮都套了玻璃，结果满屏半透明、
 * 没有东西真的浮起来 —— 用户的原话是「明亮还是很割裂」。
 *
 * ## 两种材质
 *
 * `GlassProvider` 统一管主题与辅助功能偏好；**材质由 `useMaterial()` 决定**
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
  const [opaque, setOpaque] = useState(false)
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
  const { material } = useMaterial()
  const navRef = useRef<HTMLElement>(null)
  const lensRef = useRef<HTMLSpanElement>(null)
  useNavLens(navRef, lensRef, active)
  const formatCount = useMemo(
    () => (state?.formats ?? []).filter((f) => f.available).length,
    [state],
  )

  return (
    <GlassProvider
      theme={theme}
      transparency={opaque ? 'opaque' : 'system'}
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
      enableSvgAuto={material === 'liquid'}
    >
      <ToneScope>
        <div className="app">
          {/* ── 顶栏：玻璃（浮起来的那一层）────────────────────── */}
          <GlassPanel
            className="app-topbar"
            contentClassName="app-topbar-inner"
            radius={20}
            padding={0}
          >
            <div className="brand">
              <span className="brand-mark" aria-hidden="true" />
              <span className="brand-name">V-Synth-Studio</span>
            </div>
            <div className="topbar-actions">
              <span className="topbar-status" data-dead={dead ? 'true' : undefined}>
                {dead ? '服务未连接' : refreshing ? '连接中…' : `${formatCount} 种格式`}
              </span>
              <MaterialSwitch />
              <Button size="sm" icon="refresh" onClick={refreshState} disabled={refreshing}>
                重新检测
              </Button>
            </div>
          </GlassPanel>

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
                  <MaterialView thickness="regular" radius={20}>
                    <div className="stack">
                      <p className="finding-title">连不上本地服务</p>
                      <p className="finding-text">{dead}</p>
                      <Button icon="refresh" onClick={refreshState}>
                        重试
                      </Button>
                    </div>
                  </MaterialView>
                ) : active === 'dashboard' ? (
                  <Dashboard
                    state={state}
                    refreshing={refreshing}
                    onNavigate={navigate}
                    onRefreshState={refreshState}
                    onToast={toast}
                  />
                ) : active === 'settings' ? (
                  <Settings
                    state={state}
                    theme={theme}
                    onThemeChange={changeTheme}
                    opaque={opaque}
                    onOpaqueChange={setOpaque}
                    onRefreshState={refreshState}
                    onNavigate={navigate}
                    onToast={toast}
                  />
                ) : (
                  <Placeholder title={current.title} />
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
 */
function useNavLens(
  navRef: React.RefObject<HTMLElement | null>,
  lensRef: React.RefObject<HTMLSpanElement | null>,
  active: string,
) {
  const placed = useRef(false)

  useLayoutEffect(() => {
    const nav = navRef.current
    const lens = lensRef.current
    if (!nav || !lens) return
    const place = () => {
      const row = nav.querySelector<HTMLElement>('.nav-row[aria-current="page"]')
      const first = !placed.current
      if (first) lens.style.transition = 'none'
      if (row && row.offsetWidth) {
        lens.style.width = `${row.offsetWidth}px`
        lens.style.height = `${row.offsetHeight}px`
        lens.style.setProperty('--lg-slot-x', `${row.offsetLeft}px`)
        lens.style.setProperty('--lg-slot-y', `${row.offsetTop}px`)
        lens.style.setProperty('--lg-lens-shown', '1')
        placed.current = true
      } else {
        lens.style.setProperty('--lg-lens-shown', '0')
      }
      // 强制这一帧就落位（趁过渡还关着），再把它放回去
      if (first) {
        void lens.offsetWidth
        lens.style.transition = ''
      }
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(nav)
    return () => observer.disconnect()
  }, [navRef, lensRef, active])

  /** 滑动时挤压一下。只改**一个**喂进 `transform` 的变量，没有第二条动画去抢 transform。 */
  const last = useRef<string | null>(null)
  useEffect(() => {
    const nav = navRef.current
    if (last.current === null) {
      last.current = active
      return
    }
    last.current = active
    if (!nav) return
    nav.dataset.moving = 'true'
    const timer = setTimeout(() => delete nav.dataset.moving, 180)
    return () => {
      clearTimeout(timer)
      delete nav.dataset.moving
    }
  }, [active, navRef])
}

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
 * 毛玻璃 / 液态玻璃切换。
 *
 * 两种材质的**唯一**区别在 `components/Glass.tsx` 的 `materialOptions()`：
 * `frosted` = `material:"regular"` + 不折射；`liquid` = `material:"clear"` + 折射 32。
 */
function MaterialSwitch() {
  const { material, setMaterial } = useMaterial()
  return (
    <div className="seg" role="group" aria-label="玻璃材质">
      {(['frosted', 'liquid'] as const).map((m) => (
        <button
          key={m}
          type="button"
          className="seg-item"
          aria-pressed={material === m}
          onClick={() => setMaterial(m)}
        >
          {m === 'frosted' ? '毛玻璃' : '液态玻璃'}
        </button>
      ))}
    </div>
  )
}

/* ══════════════════════════════════════════════════════════════ 主题开关 ══ */

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
