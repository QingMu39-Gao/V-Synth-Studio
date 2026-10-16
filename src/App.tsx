import * as React from 'react'
import {lazy, type ReactNode, Suspense, useCallback, useEffect, useRef, useState} from 'react'
import {api, type Announcement, type UpdateCheck} from '@/lib/api'
import {type AppConfig, getConfig, onConfigError, saveConfig, syncConfig} from '@/lib/config'
import {markSeen, unseen} from '@/lib/announce'
import {installerOf, installerSizeText, shouldNotifyUpdate} from '@/lib/update'
import {useUpdateDownload} from '@/lib/useUpdateDownload'
import {setUiLanguage, type UiLanguage, useI18n} from '@/lib/i18n'
import type {AppState} from '@/lib/types'
import {Icon, type IconName} from '@/components/Icon'
import {GlassPanel, Panel} from '@/components/Panel'
import {Button} from '@/components/Button'
import {BackdropToneProvider, GlassDialog, GlassProvider, ScrollEdge, useGlassPolicy,} from '@ttqtt/liquid-glass-react'
import {levelMaterial, levelTransparency, useGlassLevel} from '@/lib/useGlass'
import {useNavLens} from '@/lib/useNavLens'
import {materialOptions} from '@/components/Glass'
import {WallpaperLayer} from '@/components/WallpaperLayer'
/*
 * 页面**按需加载**：首屏只拿外壳，访问哪一页才拉哪一包
 * （各页那 8 份 CSS 也跟着分包，不再一次性压在 `index.css` 后面）。
 * 页面都是具名导出，`lazy()` 只认 default，所以要包一层。
 */
const Dashboard = lazy(() => import('@/pages/Dashboard').then((m) => ({default: m.Dashboard})))
const Settings = lazy(() => import('@/pages/Settings').then((m) => ({default: m.Settings})))
const Resources = lazy(() => import('@/pages/Resources').then((m) => ({default: m.Resources})))
const Convert = lazy(() => import('@/pages/Convert').then((m) => ({default: m.Convert})))
const Video = lazy(() => import('@/pages/Video').then((m) => ({default: m.Video})))
const Svsep = lazy(() => import('@/pages/Svsep').then((m) => ({default: m.Svsep})))
const Midi = lazy(() => import('@/pages/Midi').then((m) => ({default: m.Midi})))
const Audio = lazy(() => import('@/pages/Audio').then((m) => ({default: m.Audio})))
const Lyrics = lazy(() => import('@/pages/Lyrics').then((m) => ({default: m.Lyrics})))
const Pv = lazy(() => import('@/pages/Pv').then((m) => ({default: m.Pv})))

/**
 * 外壳：顶栏 + 侧栏 + 内容区。
 *
 * **玻璃的范围**：侧栏 + 顶栏里的控件 + 正文面板（「全局玻璃」开关，见 `components/Panel.tsx`）。
 * 顶栏只有品牌。玻璃是「浮起来的那一层」，铺满整屏就没有东西浮起来了。
 *
 * `GlassProvider` 统一管主题与辅助功能偏好；**玻璃等级由 `useGlassLevel()` 决定**
 * （材质 / 透明度 / 折射全从它派生）。主题是全局的一套配色，材质是玻璃面自己的事。
 *
 * ## 主题为什么不能自己写 `data-theme`
 *
 * 库的 `GlassProvider` 会写 `<html data-lg-theme>`，而且它自己的全部 token
 * （`--lg-label` / `--lg-bg` / `--lg-separator` …）都挂在 `[data-lg-theme="light|dark"]`
 * 下 —— `:root` 上没有裸定义。所以主题**只有一个来源**：喂给 Provider 的那个值。
 * 两个写入方（我写 `data-theme`、它写 `data-lg-theme`）就会互相打架。
 */

/** 侧栏一行。`icon` 必须是 `Icon.tsx` 那张表里有的名字。 */
interface PageDef {
    id: string
    title: string
    sub: string
    icon: IconName
    group: string
}

/**
 * 页面表。⚠️ **`as const` 不能去掉** —— 下面的 `PageId` 靠它取到**字面量联合**，
 * `pageViews` 才能把「加了一页却忘了配视图」变成编译错误。
 */
const PAGES = [
    {id: 'dashboard', title: '总览', sub: '环境检测与常用入口', icon: 'home', group: '工作台'},
    {id: 'convert', title: '工程转换', sub: '把工程转到另一个编辑器', icon: 'swap', group: '工作台'},
    {id: 'video', title: '视频解析', sub: 'B 站 / YouTube 等平台的 MV 下载', icon: 'video', group: '素材获取'},
    {id: 'svsep', title: '音轨分离', sub: '在线 MVSEP / 本地引擎，拆人声与伴奏', icon: 'layers', group: '素材获取'},
    {id: 'midi', title: '人声转 MIDI', sub: '干声扒谱：音符起止与音高，导出 .mid', icon: 'music', group: '素材获取'},
    {id: 'audio', title: '音频工具', sub: '格式转换 / 裁剪 / 变调变速', icon: 'wave', group: '素材获取'},
    {
        id: 'lyrics',
        title: '网易云专栏',
        sub: '网易云搜词，导出 LRC · SRT，下载封面 / 歌曲',
        icon: 'music',
        group: '素材获取'
    },
    {id: 'pv', title: '文字 PV', sub: '把歌词做成动态歌词视频', icon: 'video', group: '素材获取'},
    {id: 'resources', title: '资源库', sub: '立绘、声库、插件、音源站（仅链接）', icon: 'library', group: '素材获取'},
    {id: 'settings', title: '设置', sub: '外观、路径、外部工具', icon: 'gear', group: '系统'},
] as const satisfies readonly PageDef[]

/** 所有页面 id 的联合（从 `PAGES` 推出来，加一页就自动多一个成员） */
type PageId = (typeof PAGES)[number]['id']

export type ThemeMode = 'system' | 'light' | 'dark'

/**
 * 主题存在 **`config.json` 的 `theme`** 里。
 *
 * 这里直接同步读 —— 窗口在 `main.tsx` 里 `ensureConfig()` 落定后才 `show()`，
 * 所以第一帧就是用户选的那个主题，不会闪一下。
 */
function readTheme(): ThemeMode {
    const v = getConfig().theme
    if (v === 'light' || v === 'dark' || v === 'system') return v
    return 'system'
}

export default function App() {
    const {t} = useI18n()
    const [active, setActive] = useState<PageId>(() => {
        const m = location.hash.match(/^#\/(\w+)/)
        return PAGES.find((p) => p.id === m?.[1])?.id ?? 'dashboard'
    })
    const [theme, setTheme] = useState<ThemeMode>(readTheme)
    const [state, setState] = useState<AppState | null>(null)
    const [refreshing, setRefreshing] = useState(true)
    const [dead, setDead] = useState<string | null>(null)
    const [toasts, setToasts] = useState<{ id: number; msg: string; tone: string }[]>([])

    const toast = useCallback((msg: string, tone = 'info') => {
        const id = Date.now() + Math.random()
        setToasts((t) => [...t, {id, msg, tone}])
        setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200)
    }, [])

    const refreshState = useCallback(async () => {
        setRefreshing(true)
        try {
            const next = await api.state()
            setState(next)
            /* 后端可能自己改过配置：手机号登录、退出登录、续期都把凭据写进 config.json，
               而它们不走 `saveConfig`。不灌回内存那份，歌词页的登录徽章就一直是旧的
               （见 `lib/config.ts::syncConfig`）。 */
            syncConfig(next.config as AppConfig | undefined)
            /* 安装时选的语言：**只在第一次拿到状态时应用一次**。
               之后用户在「设置」里改过的以配置为准 —— 否则每次刷新状态都会把他改的
               语言按回安装时那个。装完之后这个字段不再有值也没关系（后端只读一次
               注册表，但前端这边只认第一次，逻辑上更稳）。 */
            if (!langApplied.current && next.installerLanguage) {
                langApplied.current = true
                setUiLanguage(next.installerLanguage as UiLanguage)
            }
            setDead(null)
        } catch (e) {
            const msg = e instanceof Error ? e.message : String(e)
            setDead(msg)
            toast(`读不到工作台状态：${msg}`, 'err')
        } finally {
            setRefreshing(false)
        }
    }, [toast])

    useEffect(() => {
        void refreshState()
    }, [refreshState])

    /*
     * 启动时**静默**查一次更新：只有「上游真有比本机新的版本」才弹窗，
     * 其余一概不打扰 —— 连不上 GitHub、上游没发过 Release、本机比远端新（自己编的包）
     * 全都是「什么都不做」（见 `update.rs`：那几种在回包里是 `ok:false` 或 `hasUpdate:false`）。
     *
     * ⚠️ **不 await、不进首屏**：请求由 Rust 那边发（十秒超时），这里 fire-and-forget，
     * 失败只进控制台。也别给它加 toast —— 那是「提醒」，不是「报错」。
     */
    const [update, setUpdate] = useState<UpdateCheck | null>(null)
    const [updateOpen, setUpdateOpen] = useState(false)
    /** 查到了更新、但**还没弹**（等公告那个框先关掉，两个弹窗不叠在一起） */
    const [updateReady, setUpdateReady] = useState(false)
    /* 下载新版本那条路（进度、下完的那份文件、核对结果）与「设置 → 关于」共用一份实现 */
    const dl = useUpdateDownload(toast)
    const installer = installerOf(update)
    const installerSize = installerSizeText(installer)
    /** 启动时要弹的公告（**还没读过的**，新的在前；`[0]` 就是当前这条） */
    const [announce, setAnnounce] = useState<Announcement[]>([])
    const [announceOpen, setAnnounceOpen] = useState(false)
    const currentAnnounce = announce[0] ?? null
    /** 安装时选的语言只应用一次（见 `refreshState`） */
    const langApplied = useRef(false)
    useEffect(() => {
        let alive = true
        void api
            .updateCheck()
            .then((r) => {
                if (!alive) return
                /* ⚠️ 用户忽略过的那个版本不再弹：这个判断在 `lib/update.ts` 里，
                   有测试钉着（忽略的是「这一个版本」，上游再发新版本仍然要提醒）。 */
                if (!shouldNotifyUpdate(r, getConfig().ignoredUpdate)) return
                setUpdate(r)
                setUpdateReady(true)
            })
            .catch((e: unknown) => console.warn('[update] 启动检查更新失败（静默）：', e))
        return () => {
            alive = false
        }
    }, [])

    /*
     * 启动时**静默**取一次公告：只有「有没读过的」才弹，其余一概不打扰 ——
     * 取不到（服务器在重启、断网）什么都不做，设置里那一栏才照实说（见 `announce.rs`）。
     *
     * ⚠️ 谁先弹：公告 → 更新。公告是「刚发生的事」，而更新那个框要等网络（慢）；
     * 两个一起弹会叠在一起，所以更新那个框在公告关掉之后才开（见下面那个 effect）。
     */
    useEffect(() => {
        let alive = true
        void api
            .announceList()
            .then((r) => {
                if (!alive || !r.ok) return
                const list = unseen(r.items, getConfig().seenAnnouncements)
                if (!list.length) return
                setAnnounce(list)
                setAnnounceOpen(true)
            })
            .catch((e: unknown) => console.warn('[announce] 取公告失败（静默）：', e))
        return () => {
            alive = false
        }
    }, [])

    /* 公告关掉之后，把等着的更新弹窗放出来。⚠️ 消费掉 `updateReady`：不然用户关掉
       更新弹窗的那一刻，这个 effect 会立刻把它再弹一次。 */
    useEffect(() => {
        if (!updateReady || announceOpen) return
        setUpdateReady(false)
        setUpdateOpen(true)
    }, [updateReady, announceOpen])

    /** 「知道了」：记下这一条读过，然后弹下一条（没有就关框）。 */
    const dismissAnnounce = useCallback(() => {
        const cur = announce[0]
        if (cur) {
            saveConfig({seenAnnouncements: markSeen(getConfig().seenAnnouncements, cur.id)})
        }
        const rest = announce.slice(1)
        setAnnounce(rest)
        if (!rest.length) setAnnounceOpen(false)
    }, [announce])

    /* 配置写失败（后端拒绝、盘满…）要说出来，否则用户只会看到「改了没反应」 */
    useEffect(() => {
        onConfigError((msg) => toast(msg, 'err'))
        return () => onConfigError(null)
    }, [toast])

    const navigate = useCallback((id: string) => {
        const page = PAGES.find((p) => p.id === id)
        if (!page) return
        setActive(page.id)
        location.hash = `#/${page.id}`
    }, [])

    useEffect(() => {
        const onHash = () => {
            const m = location.hash.match(/^#\/(\w+)/)
            const page = PAGES.find((p) => p.id === m?.[1])
            if (page) setActive(page.id)
        }
        window.addEventListener('hashchange', onHash)
        return () => window.removeEventListener('hashchange', onHash)
    }, [])

    const changeTheme = useCallback((m: ThemeMode) => {
        setTheme(m)
        saveConfig({theme: m})
    }, [])

    const current = PAGES.find((p) => p.id === active)!

    /**
     * 页面表。**每个页面都从 App 拿同一份 state**（见 `pages/types.ts` 的注释：
     * 页面自己再拉一次就会出现两页数字对不上的画面）。
     * ⚠️ 用固定顺序写，别用对象字面量的插入顺序去依赖什么 —— 这里只是查表。
     */
    const pageProps = {state, onNavigate: navigate, onRefreshState: refreshState, onToast: toast}
    const pageViews: Record<PageId, ReactNode> = {
        dashboard: <Dashboard {...pageProps} refreshing={refreshing}/>,
        settings: <Settings {...pageProps} theme={theme} onThemeChange={changeTheme}/>,
        resources: <Resources {...pageProps} />,
        convert: <Convert {...pageProps} />,
        video: <Video {...pageProps} />,
        svsep: <Svsep {...pageProps} />,
        midi: <Midi {...pageProps} />,
        audio: <Audio {...pageProps} />,
        lyrics: <Lyrics {...pageProps} />,
        pv: <Pv {...pageProps} />,
    }
    const {level} = useGlassLevel()
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
               只给自家包装的面传，库控件会停在 `regular`，切到液态玻璃时只有自家那几块变 clear。
               GlassPolicy 里没有 refraction，所以折射仍由 materialOptions() 按面给。 */
            material={materialOptions(material).material}
            /*
              折射（SVG 位移滤镜）**只在选「液态玻璃」时打开**。
              库默认是关的，理由两条，都写在它的 README 和 AGENTS.md 里：
                - 「开销大约三倍」（它文档站的开关也这么写）
                - 「只有在自己的 Chrome / GPU 矩阵上验证过才打开」
              我们这里可以开：桌面端跑的就是 WebView2（Chromium），图形栈是确定的，
              不是「一堆未知浏览器」。而「液态玻璃」要的就是边缘折弯 ——
              不开的话两种材质的差别只剩模糊半径，名不副实。
              选「毛玻璃」时是纯 CSS，零额外开销。
            */
            /* 折射只在液态档要（3、4 级）—— 按材质判，别写死某一个等级号：
               写 `level === 3` 时 4 级反而是纯模糊、没有位移贴图。 */
            enableSvgAuto={material === 'liquid'}
        >
            <ToneScope>
                {/* 背景壁纸（最底层，`body::before` 的替代品）。放这里而不是放页面里：
                    它整站只有一份，换页不该重建 —— 场景壁纸重建一次要几秒。 */}
                <WallpaperLayer/>
                <div className="app">
                    {/* 平栏的代价：内容会从它下面经过。库的 ScrollEdge 就是治这个的
              （它的注释：「不是装饰、不是色块，只在内容真的从浮动 UI 下面经过时出现」）。
              不给 targetRef 就是盯页面滚动 —— 正是我们这个场景。 */}
                    <ScrollEdge edge="top" variant="soft" height={64} className="app-top-edge"/>
                    {/* ── 顶栏：只有品牌 ──────────────────────────────────
              右上角那组控件不在顶栏里。功能没有丢：材质切换在「设置 → 玻璃材质」里，
              重新检测在总览页的「环境就绪度」里，连接状态由连不上时那一整块提示负责。 */}
                    <header className="app-topbar">
                        <div className="app-topbar-inner">
                            <div className="brand">
                                {/* 应用图标（`public/img/logo.png`，由 Vite 拷进 `dist/`） */}
                                <img className="brand-mark" src="/img/logo.png" alt="" width={26} height={26}/>
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
                                <span className="lg-selection-lens nav-lens" ref={lensRef} aria-hidden="true"/>
                                {PAGES.map((p, i) => (
                                    <div key={p.id}>
                                        {p.group !== PAGES[i - 1]?.group &&
                                            <div className="nav-group">{t(p.group)}</div>}
                                        <button
                                            type="button"
                                            className="nav-row"
                                            aria-current={active === p.id ? 'page' : undefined}
                                            onClick={() => navigate(p.id)}
                                        >
                                            <Icon name={p.icon} size={17}/>
                                            <span className="nav-row-label">{t(p.title)}</span>
                                        </button>
                                    </div>
                                ))}
                            </nav>

                            <div className="sidebar-foot">
                                <ThemeSwitch value={theme} onChange={changeTheme} t={t}/>
                            </div>
                        </GlassPanel>

                        {/* ── 内容区：**不是玻璃**。正文用实色，字才读得清 ──── */}
                        <main className="app-main" id="main" tabIndex={-1}>
                            <header className="page-head">
                                <h1 className="page-title">{t(current.title)}</h1>
                                <p className="page-sub">{t(current.sub)}</p>
                            </header>

                            <div className="page-body" key={active}>
                                {dead && !state ? (
                                    <Panel>
                                        <div className="stack">
                                            <p className="finding-title">读不到工作台状态</p>
                                            <p className="finding-text">{dead}</p>
                                            <Button icon="refresh" onClick={refreshState}>
                                                重试
                                            </Button>
                                        </div>
                                    </Panel>
                                ) : (
                                    /* 页面表：加一页 = 在 PAGES 里加一行 + 这里加一行（漏了这里 `tsc` 会报错）。
                                       只有 `active` 这一项会被渲染，所以其余的包不会提前下载。 */
                                    <Suspense fallback={<PageSkeleton/>}>{pageViews[active]}</Suspense>
                                )}
                            </div>
                        </main>
                    </div>

                    {/* 公告：启动时只有「没读过的」才弹（见上面那个 effect）。
                        一条条过，「知道了」记下这条再弹下一条。关框（右上角/背景）与
                        「知道了」等价 —— 否则关掉之后下次启动还会弹同一条。 */}
                    <GlassDialog
                        open={announceOpen}
                        onOpenChange={(open) => {
                            if (!open) dismissAnnounce()
                        }}
                        title={currentAnnounce?.title || t('公告')}
                        description={[
                            currentAnnounce?.date ? currentAnnounce.date.slice(0, 10) : '',
                            currentAnnounce?.level === 'warn' ? t('重要') : '',
                        ]
                            .filter(Boolean)
                            .join(' · ')}
                    >
                        <pre className="job-log">
                            {currentAnnounce?.body || t('这条公告没有正文。')}
                        </pre>
                        {announce.length > 1 && (
                            <p className="hint">
                                {`${t('还有')} ${announce.length - 1} ${t('条未读公告')}`}
                            </p>
                        )}
                        <div className="btn-row">
                            {currentAnnounce?.url && (
                                <Button
                                    icon="external"
                                    onClick={() => {
                                        api.fsOpen({url: currentAnnounce.url ?? ''}).catch(
                                            (e: unknown) => {
                                                const msg =
                                                    e instanceof Error ? e.message : String(e)
                                                toast(`${t('打开链接失败')}：${msg}`, 'err')
                                            },
                                        )
                                    }}
                                >
                                    {t('查看详情')}
                                </Button>
                            )}
                            <Button variant="primary" onClick={dismissAnnounce}>
                                {t('知道了')}
                            </Button>
                        </div>
                    </GlassDialog>

                    {/* 启动那次静默检查**只在真有新版时**把这个框打开（见上面那个 effect）。
                        「设置 → 关于」里还有一份手动的，两处共用同一个后端命令。 */}
                    <GlassDialog
                        open={updateOpen}
                        onOpenChange={setUpdateOpen}
                        title={`${t('有新版本')}：${update?.latest ?? ''}`}
                        description={`${update?.current ?? ''} → ${update?.latest ?? ''}`}
                    >
                        {(update?.name || update?.publishedAt || update?.prerelease) && (
                            <p className="hint">
                                {update?.name ? `${update.name} · ` : ''}
                                {update?.publishedAt
                                    ? `${t('发布于')} ${update.publishedAt.slice(0, 10)}`
                                    : ''}
                                {update?.prerelease ? t('（预览版）') : ''}
                            </p>
                        )}
                        <pre className="job-log">{update?.notes || t('这条发布没有写说明。')}</pre>
                        {/* 下载进度：任务表那条通道（见 `lib/useUpdateDownload`）。 */}
                        {dl.job?.status === 'running' && (
                            <p className="hint">
                                {dl.job.message || t('正在下载…')}
                                {typeof dl.job.percent === 'number' ? `（${dl.job.percent.toFixed(0)}%）` : ''}
                            </p>
                        )}
                        {dl.file && (
                            <p className="hint">
                                {dl.verified
                                    ? t('已核对 SHA-256，可以打开安装包了')
                                    : t('这次发布没有校验清单，没能核对完整性；打开前请自己确认来源')}
                            </p>
                        )}
                        {update && !installer && (
                            <p className="hint">{t('这次发布没有本平台的安装包，去发布页看看')}</p>
                        )}
                        <div className="btn-row">
                            {dl.file ? (
                                <Button
                                    variant="primary"
                                    icon="play"
                                    onClick={() => {
                                        /* 打开下载好的安装包交给系统（与扩展包那条路一致）：
                                           安装器要 UAC、要用户点下一步，程序不该替它做。 */
                                        api.fsOpen({path: dl.file}).catch((e: unknown) => {
                                            const msg = e instanceof Error ? e.message : String(e)
                                            toast(`${t('打开安装包失败')}：${msg}`, 'err')
                                        })
                                    }}
                                >
                                    {t('打开安装包')}
                                </Button>
                            ) : (
                                installer && (
                                    <Button
                                        variant="primary"
                                        icon="download"
                                        loading={dl.job?.status === 'running'}
                                        onClick={() => {
                                            if (!installer) return
                                            void dl.download(installer, update?.latest)
                                        }}
                                    >
                                        {`${t('下载新版本')}${installerSize ? `（${installerSize}）` : ''}`}
                                    </Button>
                                )
                            )}
                            <Button
                                variant="primary"
                                icon="external"
                                onClick={() => {
                                    /* 打不开不能只进控制台：用户按了按钮却什么都没发生，
                                       连「打不开」都不知道。url 为空也会走这条（后端回 400）。 */
                                    api.fsOpen({url: update?.url ?? ''}).catch((e: unknown) => {
                                        const msg = e instanceof Error ? e.message : String(e)
                                        toast(`${t('打开发布页失败')}：${msg}`, 'err')
                                    })
                                    setUpdateOpen(false)
                                }}
                            >
                                {t('打开发布页')}
                            </Button>
                            {/* 忽略只作用于**启动时那次静默检查**：手动查仍然照实报（见 `lib/update.ts`） */}
                            <Button
                                variant="ghost"
                                onClick={() => {
                                    saveConfig({ignoredUpdate: update?.latest ?? ''})
                                    setUpdateOpen(false)
                                    toast(
                                        `${t('不再提醒这个版本')}${update?.latest ? `：${update.latest}` : ''}`,
                                        'ok',
                                    )
                                }}
                            >
                                {t('忽略这个版本')}
                            </Button>
                            <Button variant="ghost" onClick={() => setUpdateOpen(false)}>
                                {t('稍后再说')}
                            </Button>
                        </div>
                    </GlassDialog>

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
 * 侧栏高亮块：选中项外面那块高亮**滑**过去。位置必须**实测**（`offsetTop` / `offsetHeight`），
 * 不能按数据算 —— 分组标题、行高都会影响它。库的 `useSelectionLens` 没从包里导出，
 * 所以这里重写「量位置」那几行；**外观、弹簧曲线、阴影全部复用库的 `.lg-selection-lens`**。
 *
 * 三个必须注意的点（都会变成看得见的 bug）：
 *
 *  1. **首帧不能滑**：第一次量位置时先把 `transition` 关掉，量完强制回流再恢复。
 *  2. **用 `offsetTop`，不用 `getBoundingClientRect()`**：侧栏滚动后 rect 会偏，
 *     `offsetTop` 相对 offsetParent 恒定 —— 前提是 nav 上有 `position: relative`。
 *  3. **行要 `position: relative; z-index: 1`**，否则被这块绝对定位的高亮盖住。
 */

/* ══════════════════════════════════════════════════════════════ 背景色调 ══ */

/**
 * 声明「这层玻璃背后是深是浅」。
 *
 * ⚠️ **不声明的话材质选不起来。** 库的规矩（`docs/design-system.md` 第 4 节）：
 * `tone="mixed"` 是安全默认值 —— 未知背景保持应用外观，并把 `clear` **退回 `regular`**。
 * 于是不声明时玻璃面报 `data-material="regular"`，一个 `feDisplacementMap` 都不会有，
 * 选「液态玻璃」等于没选。
 *
 * 它不能自己猜：读背景色调要么截屏页面、要么跨源读像素，库的 `AGENTS.md` 禁止这两件事。
 * 所以由区域声明、后代继承 —— 这里用 `useGlassPolicy()` 拿 Provider **解析后**的主题
 * （`'system'` 已解析成 light/dark），只有一个真相来源。
 */
function ToneScope({children}: { children: React.ReactNode }) {
    const {resolvedTheme} = useGlassPolicy()
    return <BackdropToneProvider tone={resolvedTheme}>{children}</BackdropToneProvider>
}

/* ══════════════════════════════════════════════════════════════ 页面占位 ══ */

/**
 * 页面包还没到时的占位。资源走本机，通常一闪而过；留这一块是为了**不白屏**，
 * 也让内容区的起止有个交代。
 */
function PageSkeleton() {
    return (
        <Panel>
            <p className="empty">正在载入页面…</p>
        </Panel>
    )
}

/* ══════════════════════════════════════════════════════════════ 主题开关 ══ */

/**
 * 主题切换。**故意留着手写的 `.seg`，不换成库的 `GlassSegmentedControl`。**
 *
 * 它在侧栏那块玻璃**里面** —— 库的规矩是「不要玻璃叠玻璃」（放玻璃上的元素用填充和
 * 透明度，不再叠一层）。
 */
function ThemeSwitch({value, onChange, t}: {
    value: ThemeMode;
    onChange: (m: ThemeMode) => void;
    t: (text: string) => string
}) {
    const labels: Record<ThemeMode, string> = {system: t('跟随系统'), light: t('明亮'), dark: t('黑暗')}
    const order: ThemeMode[] = ['system', 'light', 'dark']
    return (
        <div className="seg seg-block" role="group" aria-label={t('主题')}>
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
