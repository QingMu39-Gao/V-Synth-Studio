import {useCallback, useEffect, useRef, useState} from 'react'
import {api, type AnnounceReply, type ExtDirInfo, type UpdateCheck} from '@/lib/api'
import {getConfig, onConfigChange, saveConfig} from '@/lib/config'
import {markSeen, unseen} from '@/lib/announce'
import {installerOf, installerSizeText} from '@/lib/update'
import {useUpdateDownload} from '@/lib/useUpdateDownload'
import type {AppState} from '@/lib/types'
import type {PageProps, ToastFn} from './types'
import {Button} from '@/components/Button'
import {Field, TextInput} from '@/components/Field'
import {Chip, Finding, GlassPanel, Panel, PanelHead, Stat} from '@/components/Panel'
import {Wallpaper} from '@/components/WallpaperSettings'
import {Upstream} from '@/components/Credit'
import {GlassSlider} from '@ttqtt/liquid-glass-react'
import {GLASS_LEVELS, type GlassLevel, useGlassLevel} from '@/lib/useGlass'
import {useNavLens} from '@/lib/useNavLens'
import {useI18n} from '@/lib/i18n'
import type {ThemeMode} from '@/App'
import './Settings.css'

/**
 * 设置。
 *
 * 全局关模糊走**库的 `transparency`**（由 `App.tsx` 喂给 `GlassProvider`），它同时做三件事：
 * 系统里开了「减少透明度」时**自动**生效；关掉的是整个材质（模糊 + 半透明 + 折射）
 * 而不只是 `backdrop-filter`；开关一开所有玻璃面一起变，不会漏掉某个角落。
 *
 * 语义是**降低透明度**（无障碍需求），不是「性能模式」那种听起来像降级的说法。
 */

const SECTIONS = [
    {id: 'appearance', label: '外观'},
    {id: 'wallpaper', label: '壁纸'},
    {id: 'paths', label: '路径'},
    {id: 'tools', label: '外部工具'},
    /* 「公告」在「赞助 / 关于」之前：它是**要看的消息**，与设置项不是一类；放最后
       就等于没人看得到 */
    {id: 'announce', label: '公告'},
    /* 「赞助」在「关于」之前：它要的是被看见（关于那一栏是署名与致谢，看到最后才轮到） */
    {id: 'sponsor', label: '赞助'},
    {id: 'about', label: '关于'},
] as const

type SectionId = (typeof SECTIONS)[number]['id']

export function Settings({
                             state,
                             theme,
                             onThemeChange,
                             onRefreshState,
                             onNavigate,
                             onToast,
                         }: PageProps & {
    theme: ThemeMode
    onThemeChange: (m: ThemeMode) => void
}) {
    const {t} = useI18n()
    const [section, setSection] = useState<SectionId>('appearance')
    /* 高亮块要量位置：和主侧栏同一套（见 lib/useNavLens.ts） */
    const navRef = useRef<HTMLElement>(null)
    const lensRef = useRef<HTMLSpanElement>(null)
    useNavLens(navRef, lensRef, section)
    const [cfg, setCfg] = useState<Record<string, unknown>>({})

    /**
     * 重新读一遍配置。
     *
     * ⚠️ 走 `get_config` 而不是 `get_state`：这里只要配置那几项，而 `get_state` 会
     * 顺带探测外部工具（真的 spawn `yt-dlp --version` / `python --version`）。
     * 版本与运行环境由 App 共享的 `state` 提供，不在这里重复拉。
     */
    const reload = useCallback(async () => {
        try {
            setCfg(await api.config())
        } catch (e) {
            onToast(e instanceof Error ? e.message : String(e), 'err')
        }
    }, [onToast])

    useEffect(() => {
        void reload()
    }, [reload])

    const save = useCallback(
        async (patch: Record<string, unknown>, okMsg = '设置已保存') => {
            try {
                await api.saveConfig(patch)
                setCfg((c) => ({...c, ...patch}))
                onToast(okMsg, 'ok')
            } catch (e) {
                onToast(`保存失败：${e instanceof Error ? e.message : String(e)}`, 'err')
                throw e
            }
        },
        [onToast],
    )

    return (
        <div className="settings">
            {/* 这一条小节导航和**主侧栏是同一种东西**：一块玻璃 + 一个滑过去的高亮块。
          结构必须和 `App.tsx` 的主导航一致（`useNavLens` 靠这三个类名找目标）。 */}
            <GlassPanel
                className="settings-nav"
                /* 参数**和主侧栏逐项对齐**（large 玻璃 / 26 圆角 / 12 内边距）——
                   `.nav-lens` 那个 14px 圆角就是按「26 − 12」算的同心情形，换数字就对不上了 */
                size="large"
                radius={26}
                padding={12}
            >
                <nav className="app-nav" aria-label={t("设置分节")} ref={navRef}>
                    <span className="lg-selection-lens nav-lens" ref={lensRef} aria-hidden="true"/>
                    {SECTIONS.map((s) => (
                        <button
                            key={s.id}
                            type="button"
                            className="nav-row"
                            aria-current={section === s.id ? 'page' : undefined}
                            onClick={() => setSection(s.id)}
                        >
                            <span className="nav-row-label">{t(s.label)}</span>
                        </button>
                    ))}
                </nav>
            </GlassPanel>

            <div className="stack-lg settings-body">
                {section === 'appearance' && (
                    <Appearance theme={theme} onThemeChange={onThemeChange}/>
                )}
                {section === 'wallpaper' && (
                    <Wallpaper onToast={onToast} state={state}/>
                )}
                {section === 'paths' && (
                    <Paths cfg={cfg} state={state} onSave={save} onToast={onToast}/>
                )}
                {section === 'tools' && (
                    <Tools state={state} onRefreshState={onRefreshState} onToast={onToast}/>
                )}
                {section === 'announce' && <Announce onToast={onToast}/>}
                {section === 'sponsor' && <Sponsor/>}
                {section === 'about' && (
                    <About state={state} onRefresh={reload} onNavigate={onNavigate} onToast={onToast}/>
                )}
            </div>
        </div>
    )
}

/* ══════════════════════════════════════════════════════════════ 外观 ══ */

function Appearance({
                        theme,
                        onThemeChange,
                    }: {
    theme: ThemeMode
    onThemeChange: (m: ThemeMode) => void
}) {
    const {level, setLevel} = useGlassLevel()
    const {language, t, setLanguage} = useI18n()

    /** 滑块给的是 number，收进 1~3（拖动/键盘理论上都给不出界外值，防御一下） */
    const clampLevel = (v: number): GlassLevel =>
        Math.min(GLASS_LEVELS.length, Math.max(1, Math.round(v))) as GlassLevel
    const THEMES: { id: ThemeMode; label: string; desc: string }[] = [
        {id: 'system', label: t('跟随系统'), desc: t('系统切换配色时自动跟着换')},
        {id: 'light', label: t('明亮'), desc: t('浅色底、细描边')},
        {id: 'dark', label: t('黑暗'), desc: t('深色底，长时间看不刺眼')},
    ]

    return (
        <>
            {/*
        玻璃等级：一个滑块管住三件事 —— 材质（毛玻璃/液态）、
        「全局玻璃」（内容面板要不要玻璃面）、「降低透明度」（库的 opaque 策略）。
        三个独立开关互相影响，合成分级之后语义才清楚：级别越高越「玻璃」，代价越大。
        滑块本身是**库的 `GlassSlider`**（真 `<input type=range>` 打底，键盘/读屏都能用）。
      */}
            <Panel>
                <PanelHead
                    title={t("玻璃等级")}
                    desc={t("级别越高越「玻璃」，开销也越大")}
                />
                <div className="slider-row">
                    <GlassSlider
                        aria-label="玻璃等级"
                        min={1}
                        max={GLASS_LEVELS.length}
                        step={1}
                        marks
                        value={level}
                        onValueChange={(v) => setLevel(clampLevel(v))}
                        formatValue={(v) => `${v} 级：${GLASS_LEVELS[v - 1]?.label ?? ''}`}
                        minLabel="1"
                        maxLabel={String(GLASS_LEVELS.length)}
                    />
                    <div className="slider-legend">
                        {GLASS_LEVELS.map((l) => (
                            <button
                                key={l.level}
                                type="button"
                                className="slider-legend-item"
                                aria-pressed={level === l.level}
                                onClick={() => setLevel(l.level)}
                            >
                <span className="slider-legend-label">
                  {l.level} 级 · {l.label}
                </span>
                                <span className="slider-legend-desc">{l.desc}</span>
                            </button>
                        ))}
                    </div>
                </div>
                <p className="hint">
                    {t('等级只影响材质，背景图不变。')}
                </p>
            </Panel>

            <Panel>
                <PanelHead title={t("主题")} desc={t("整套界面的配色")}/>
                <div className="choice-grid">
                    {THEMES.map((themeOption) => (
                        <button
                            key={themeOption.id}
                            type="button"
                            className="choice"
                            aria-pressed={theme === themeOption.id}
                            onClick={() => onThemeChange(themeOption.id)}
                        >
              <span className="choice-head">
                <span className="choice-label">{themeOption.label}</span>
                  {theme === themeOption.id && <Chip tone="accent">{t("已选")}</Chip>}
              </span>
                            <span className="choice-desc">{themeOption.desc}</span>
                        </button>
                    ))}
                </div>
            </Panel>

            <Panel>
                <PanelHead title={t("语言")} desc={t("选择应用界面语言")}/>
                <div className="choice-grid">
                    {([["zh-CN", "简体中文"], ["en-US", "English"], ["ja-JP", "日本語"]] as const).map(([id, label]) => (
                        <button key={id} type="button" className="choice" aria-pressed={language === id}
                                onClick={() => setLanguage(id)}>
                            <span className="choice-head">
                                <span className="choice-label">{t(label)}</span>
                                {language === id && <Chip tone="accent">{t("已选")}</Chip>}
                            </span>
                        </button>
                    ))}
                </div>
            </Panel>
        </>
    )
}

/* ══════════════════════════════════════════════════════════════ 路径 ══ */

function Paths({
                   cfg,
                   state,
                   onSave,
                   onToast,
               }: {
    cfg: Record<string, unknown>
    state: AppState | null
    onSave: (patch: Record<string, unknown>, ok?: string) => Promise<void>
    onToast: ToastFn
}) {
    const [out, setOut] = useState('')
    const [dl, setDl] = useState('')
    const [busy, setBusy] = useState(false)
    const {t} = useI18n()
    /* 扩展包目录：音轨分离的运行时 / 模型、人声转 MIDI 的模型都落在这儿（约 8 GB）。
       ⚠️ 它**不走 `cfg`**（那一份是页面自己拉的配置快照），而是直接问后端的
       `ext_dir_get` —— 那一条会把「默认位置」与「老位置还留着一份」一并算出来，
       在前端重算一遍就成了两套判据。 */
    const [ext, setExt] = useState<ExtDirInfo | null>(null)

    useEffect(() => {
        setOut(String(cfg.outputDir ?? state?.paths?.outputDir ?? ''))
        setDl(String(cfg.downloadDir ?? state?.paths?.downloadDir ?? ''))
    }, [cfg.outputDir, cfg.downloadDir, state?.paths?.outputDir, state?.paths?.downloadDir])

    useEffect(() => {
        void api
            .extDirGet()
            .then(setExt)
            .catch(() => {
                /* 读不到就不画下面那一块 */
            })
    }, [])

    /** 换扩展包目录。`dir` 传空串 = 回到默认（可写目录）。 */
    const setExtDir = async (dir: string) => {
        setBusy(true)
        try {
            setExt(await api.extDirSet(dir))
            onToast(dir ? '扩展包目录已改，新下载的包落在这里' : '扩展包目录已恢复默认', 'ok')
        } catch (e) {
            onToast(e instanceof Error ? e.message : String(e), 'err')
        } finally {
            setBusy(false)
        }
    }

    const pickExtDir = async () => {
        try {
            const r = await api.fsPick({folder: true, title: '选扩展包的存放位置'})
            if (!r.files.length) return
            await setExtDir(r.files[0])
        } catch (e) {
            onToast(e instanceof Error ? e.message : String(e), 'err')
        }
    }

    return (
        <>
            <Panel>
                <PanelHead title="默认目录" desc="只影响默认值，每次操作时还能单独改"/>
                <div className="stack">
                    <Field label="默认输出目录（转换结果）">
                        <TextInput value={out} onChange={(e) => setOut(e.target.value)}/>
                    </Field>
                    <Field label="默认下载目录（视频 / 音频）">
                        <TextInput value={dl} onChange={(e) => setDl(e.target.value)}/>
                    </Field>
                    <div className="btn-row">
                        <Button
                            variant="primary"
                            loading={busy}
                            onClick={async () => {
                                setBusy(true)
                                try {
                                    await onSave({outputDir: out, downloadDir: dl}, '路径已保存')
                                } catch {
                                    /* save 已经报过 toast */
                                } finally {
                                    setBusy(false)
                                }
                            }}
                        >
                            保存路径设置
                        </Button>
                        <Button
                            onClick={() =>
                                api.fsReveal(out, false).catch((e: unknown) =>
                                    onToast(e instanceof Error ? e.message : String(e), 'err'),
                                )
                            }
                        >
                            打开输出目录
                        </Button>
                    </div>
                    <p className="hint">程序根目录：{state?.paths?.root ?? '未读取到'}</p>
                </div>
            </Panel>

            {/* ── 扩展包目录 ────────────────────────────────────────────
          音轨分离的运行时（解压后 7.4 GB）+ 模型 + 人声转 MIDI 的模型合计约 8 GB，
          默认落在可写目录里 —— 安装版就是 `%APPDATA%`，也就是 C 盘。这一格给
          「想挪到别的盘」的人一个出口；第一次点「安装扩展包」时还会再问一次
          （同一个键、同一个实现，见 `lib/extDir.tsx`）。 */}
            {ext && (
                <Panel>
                    <PanelHead
                        title="扩展包目录"
                        desc="音轨分离与人声转 MIDI 下载的包都放在这里，合计约 8 GB"
                        extra={
                            ext.isDefault
                                ? <Chip>{t('默认位置')}</Chip>
                                : <Chip tone="accent">{t('已自定义')}</Chip>
                        }
                    />
                    <div className="stack">
                        <Field label="当前目录">
                            <TextInput value={ext.dir} readOnly/>
                        </Field>
                        <div className="btn-row">
                            <Button size="sm" loading={busy} onClick={() => void pickExtDir()}>
                                换个目录…
                            </Button>
                            {!ext.isDefault && (
                                <Button size="sm" variant="ghost" loading={busy} onClick={() => void setExtDir('')}>
                                    恢复默认位置
                                </Button>
                            )}
                            <Button
                                size="sm"
                                variant="ghost"
                                onClick={() =>
                                    api.fsReveal(ext.dir, false).catch((e: unknown) =>
                                        onToast(e instanceof Error ? e.message : String(e), 'err'),
                                    )
                                }
                            >
                                打开目录
                            </Button>
                        </div>
                        {ext.isDefault && (
                            <p className="hint">
                                默认位置：{ext.defaultDir}
                                {ext.installed ? '（在系统盘上，紧张的话换到别的盘）' : ''}
                            </p>
                        )}
                        {/* ⚠️ 换目录**不搬文件**：老位置里那份原地留着（可能几 GB），
                            所以必须说清「它还在那儿、要自己清」。 */}
                        {ext.legacyDir && (
                            <p className="hint">
                                原位置还留着一份：{ext.legacyDir} —— 换目录不会自动搬或删文件，
                                <strong>{t('确认新位置能用之后再手动清掉它')}</strong>。
                            </p>
                        )}
                        {ext.hasRuntime && <p className="hint">{t('这个目录里已经有一份音轨分离运行时。')}</p>}
                    </div>
                </Panel>
            )}
        </>
    )
}

/* ══════════════════════════════════════════════════════════ 外部工具 ══ */

function Tools({
                   state,
                   onRefreshState,
                   onToast,
               }: {
    state: AppState | null
    onRefreshState: () => Promise<void>
    onToast: ToastFn
}) {
    const tools = state?.tools ?? {}
    const [busy, setBusy] = useState(false)
    const missing = ['ffmpeg', 'ytdlp'].filter((k) => !tools[k]?.available)
    const rows = [
        {key: 'ffmpeg', name: 'ffmpeg', desc: '音视频合并、导出 WAV/MP3、变调变速、响度标准化'},
        {key: 'ytdlp', name: 'yt-dlp', desc: 'YouTube 等上千站点的解析与下载（B 站走内置解析）'},
        {key: 'python', name: 'Python', desc: '可选：个别功能会用到'},
    ]

    return (
        <Panel>
            <PanelHead
                title="外部工具"
                desc={`工具目录：${state?.paths?.toolsDir ?? '未读取到'}`}
                extra={
                    <Button
                        size="sm"
                        loading={busy}
                        onClick={async () => {
                            setBusy(true)
                            try {
                                await api.detect(true)
                                await onRefreshState()
                                onToast('检测完成', 'ok')
                            } catch (e) {
                                onToast(e instanceof Error ? e.message : String(e), 'err')
                            } finally {
                                setBusy(false)
                            }
                        }}
                    >
                        重新检测
                    </Button>
                }
            />
            <div className="tool-list">
                {rows.map((r) => {
                    const info = tools[r.key]
                    return (
                        <div key={r.key} className="tool-row">
                            <div className="tool-row-text">
                                <span className="tool-name">{r.name}</span>
                                <span className="tool-desc">{r.desc}</span>
                            </div>
                            <span className="tool-version" data-ok={info?.available ? 'true' : undefined}>
                {info?.available ? String(info.version ?? '已就绪').slice(0, 28) : '未找到'}
              </span>
                            {info?.available && info.path && (
                                <Button
                                    size="sm"
                                    onClick={() =>
                                        api.fsReveal(info.path!, true).catch((e: unknown) =>
                                            onToast(e instanceof Error ? e.message : String(e), 'err'),
                                        )
                                    }
                                >
                                    定位
                                </Button>
                            )}
                        </div>
                    )
                })}
            </div>
            <p className="hint">
                {missing.length
                    ? `未检测到 ${missing.map((m) => (m === 'ytdlp' ? 'yt-dlp' : m)).join(' / ')}，相关功能不可用。tools 目录缺失，请重新解压程序包。`
                    : '三个外部工具都齐了，音频与下载功能完整可用。'}
            </p>
        </Panel>
    )
}

/* ══════════════════════════════════════════════════════════════ 关于 ══ */

/** 「关于作者」那一栏的邮箱。点按钮就复制这一串。 */
const AUTHOR_MAIL = '1813616607@qq.com'

/**
 * 感谢名单。
 *
 * ⚠️ 顺序**不代表排名** —— 面板上那行「排名无先后顺序」就是为这条写的，改名单时别按
 * 「贡献大小」重排。ID 一律**照抄对方自己写的样子**（大小写、空格、假名、emoji 都别动）。
 */
const SPONSORS = [
    '坎伊bbb',
    'Desire Control',
    '浅唱教主',
    '老钱',
    '三无',
    '入さん',
    'ゆりかごから墓場まで',
    '小偷人机在线逃跑',
    'WuJinGY',
    'venom',
    'LYT',
    '唠蟹公主',
    '火橘子',
    '筱箖',
    'nxy',
    '让我们一起陷入狂赌之渊吧',
    '星街彗星',
    '神野冬花',
    '落款未名',
    '酒韵星回',
    '凌宇',
    '界兔',
    '绝望病',
    '寿司公主',
    '茶绪P',
]

/**
 * 第三方组件许可总表（关于页）。
 *
 * 事实以 `docs/THIRD-PARTY-NOTICES.md` 为准 —— 拿不准就先查那一份，别凭印象写许可名。
 * ⚠️ 这张表和**各功能页自己那块 `Credit` 是同一批事实**，两处都留
 * （功能旁边写一份、关于页再汇总一份），所以改一处就得同步另一处。
 */
const LICENSES: { feature: string; upstream: string; href?: string; license: string; how: string }[] = [
    {
        feature: '工程转换',
        upstream: 'LibreSVIP 2.9.0',
        href: 'https://github.com/SoulMelody/LibreSVIP',
        license: 'Apache-2.0',
        how: '随程序一起分发，工程格式的读写由它完成',
    },
    {
        feature: '视频解析下载',
        upstream: 'yt-dlp 2026.08.19',
        href: 'https://github.com/yt-dlp/yt-dlp',
        license: 'Unlicense',
        how: '随程序一起分发；Unlicense 属公有领域，无附加义务',
    },
    {
        feature: '视频解析（扫码登录）',
        upstream: 'qrcode.react 4.2.0',
        href: 'https://github.com/zpao/qrcode.react',
        license: 'ISC',
        how: '登录二维码在界面上生成，不联网；登录凭据只写进本机配置',
    },
    {
        feature: '音频处理',
        upstream: 'FFmpeg 9.0.2（gyan.dev essentials）',
        href: 'https://ffmpeg.org/',
        license: 'GPL v3',
        how: '随程序一起分发；格式转换 / 变调变速 / 裁剪 / 响度 / 抽音轨都由它完成（GPL v3 全文随程序附带）',
    },
    {
        feature: '视频合流转码',
        upstream: 'FFmpeg 9.0.2（gyan.dev essentials）',
        href: 'https://ffmpeg.org/',
        license: 'GPL v3',
        how: '与「音频处理」是同一个 FFmpeg；只换封装、不重编码时最快',
    },
    {
        feature: '音轨分离',
        upstream: 'python-audio-separator 0.39.1',
        href: 'https://github.com/nomadkaraoke/python-audio-separator',
        license: 'MIT',
        how: '运行时与模型不随程序分发，第一次使用要先把它们下载好',
    },
    {
        feature: '音轨分离（模型）',
        upstream: 'UVR 系列 BS-RoFormer / MDX，@Anjok07 训练',
        license: '随模型自带说明',
        how: '由 @Anjok07 训练，许可见模型自带的说明；第一次使用按需下载',
    },
    {
        feature: '人声转 MIDI（算法）',
        upstream: 'openvpi/GAME',
        href: 'https://github.com/openvpi/GAME',
        license: 'MIT',
        how: '扒谱算法按其公开实现编写，未使用其代码',
    },
    {
        feature: '人声转 MIDI（权重）',
        upstream: 'GAME-1.0.3-large-onnx',
        license: 'CC BY-NC-SA 4.0',
        how: '非商业许可：不随程序分发，由界面按需下载；用它产出的结果不得用于商业用途',
    },
    {
        feature: '人声转 MIDI（推理运行时）',
        upstream: 'ONNX Runtime 1.23.2（ort crate）',
        href: 'https://github.com/microsoft/onnxruntime',
        license: 'MIT',
        how: '不随程序分发，需要时按需下载',
    },
    {
        feature: '歌词处理',
        upstream: '163MusicLyrics',
        href: 'https://github.com/jitwxs/163MusicLyrics',
        license: 'Apache-2.0',
        how: '歌词文本的处理规则（多写法时间戳、LRC 转 SRT、译文对齐）移植自它',
    },
    {
        feature: '歌曲下载 / 网易云账号',
        upstream: 'FusionMusicPlayer',
        href: 'https://github.com/Janson20/FusionMusicPlayer',
        license: 'GPL-3.0',
        how: '下载档位与回退链、静默降级的识别、落盘前校验、会员标签与凭据续期参考自它（照做法自行实现，未拷贝其代码）',
    },
    {
        feature: '文字 PV（编辑器）',
        // ⚠️ 与 `tools/assets.mjs` 的 `UPSTREAM_JIZURA_VERSION` 保持一致（MIT 要求署名）。
        // 两处无法共享常量，由 `tools/check_assets_agree.mjs` 核对，升级时一起改。
        upstream: 'JIZURA v0.10.1 · © 2026 hakoniwa',
        href: 'https://github.com/852wa/JIZURA',
        license: 'MIT',
        how: '使用作者发布的原始版本，界面与功能没有改动；字体改为随程序内置（离线可用）',
    },
    {
        feature: '文字 PV（随包字体）',
        upstream: 'Google Fonts 18 个家族',
        license: 'SIL OFL 1.1',
        how: '随程序内置字体子集，字形未修改（SIL OFL 1.1）',
    },
    {
        feature: '界面素材',
        upstream: '@ttqtt/liquid-glass-react',
        href: 'https://github.com/Tsdsj/liquid-glass-react',
        license: 'MIT',
        how: '玻璃材质、配色、字号、间距、圆角与动效来自它（独立的第三方组件库，非 Apple 官方产品，也不含 Apple 素材）',
    },
    {
        feature: '汉字读音',
        upstream: 'pinyin-data',
        license: 'MIT',
        how: '汉字读音数据来源',
    },
]

/**
 * 赞助那一栏：一段话 + 两张收款码（微信 / 支付宝各一张）。
 *
 * 图片在 `public/img/sponsor*.jpg`，由 Vite 原样拷进 `dist/`（`public/` 下的东西
 * 不走打包，路径就是 `/img/…`）。
 *
 * ⚠️ **两张码不能合并成一张**：微信只认微信的码、支付宝只认支付宝的（支付宝那张
 * 图上还写着「推荐使用支付宝」），所以两张并排摆、各自带标题，用户扫之前看得出扫的是哪张。
 *
 * ⚠️ **码必须保持原本的白底**：它们是给手机摄像头扫的，跟着暗色主题走会扫不出来 ——
 * 和 B 站扫码登录那块 `.qr-box` 同一条规矩（样式在 `Settings.css` 的 `.sponsor-code`）。
 *
 * 文案是作者的话，**不翻译**：与「关于作者」里那几段同一条规矩 —— 第一人称说给
 * 赞助者的句子，用机器译成三种语言反而怪。
 */
function Sponsor() {
    return (
        <Panel>
            <PanelHead title="赞助" desc="扫码赞赏 —— 记得备注 ID，会同步到「关于」里的感谢名单"/>
            <div className="sponsor">
                <p className="sponsor-words">
                    软件的开发与运营几乎得靠你们赞助了。作者只是个学生，拿不出太多钱为爱发电，抱歉。
                    有能力的希望可以赞助一下，记得备注 ID，会同步到感谢名单，谢谢！
                </p>
                {/* 左边是微信（`sponsor.jpg` 那张写着「赞赏码」），右边是支付宝。
                    两张图的宽高比差很多（正方形 vs 竖长条），所以只约束宽度、让高度各自走 */}
                <div className="sponsor-codes">
                    <figure className="sponsor-card">
                        <img className="sponsor-code" src="/img/sponsor.jpg" alt="微信赞赏码"/>
                        <figcaption className="sponsor-caption">微信</figcaption>
                    </figure>
                    <figure className="sponsor-card">
                        <img
                            className="sponsor-code sponsor-code-alipay"
                            src="/img/sponsor-alipay.jpg"
                            alt="支付宝赞赏码"
                        />
                        <figcaption className="sponsor-caption">支付宝</figcaption>
                    </figure>
                </div>
                <p className="sponsor-hint">
                    右键（或长按）保存图片，用对应的应用扫一扫。
                </p>
            </div>
        </Panel>
    )
}

function About({
                   state,
                   onRefresh,
                   onNavigate,
                   onToast,
               }: {
    state: AppState | null
    onRefresh: () => Promise<void>
    onNavigate: (id: string) => void
    onToast: ToastFn
}) {
    const toolsReady = ['ffmpeg', 'ytdlp'].filter((k) => state?.tools?.[k]?.available).length
    const {t} = useI18n()

    /* 检查更新。只有真连不上 GitHub 才抛异常；「上游没发过 Release」「匿名调用
       超额」都是 `ok: false` 的回包，落进 `update` 由面板照实说。 */
    const [update, setUpdate] = useState<UpdateCheck | null>(null)
    const [updateBusy, setUpdateBusy] = useState(false)
    const [updateErr, setUpdateErr] = useState('')
    /* 「忽略这个版本」存的是配置里那一个键：**手动查这里仍然照实报**（那是用户自己问的），
       它只影响启动时那次静默检查弹不弹（见 `lib/update.ts`）。 */
    const [ignored, setIgnored] = useState(() => getConfig().ignoredUpdate ?? '')
    useEffect(() => onConfigChange(() => setIgnored(getConfig().ignoredUpdate ?? '')), [])
    /* 下载那条路与启动弹窗共用一份实现（见 `lib/useUpdateDownload`） */
    const dl = useUpdateDownload(onToast)
    const installer = installerOf(update)
    const installerSize = installerSizeText(installer)
    const checkUpdate = async () => {
        setUpdateBusy(true)
        setUpdateErr('')
        try {
            setUpdate(await api.updateCheck())
        } catch (e) {
            setUpdate(null)
            setUpdateErr(e instanceof Error ? e.message : String(e))
        } finally {
            setUpdateBusy(false)
        }
    }

    /* 「关于作者」那三个按钮：两个外链走系统默认浏览器（和 `Upstream` 同一条路，
       比指望 WebView 处理 `target="_blank"` 稳）；邮箱按钮复制到剪贴板 ——
       界面跑在 http://127.0.0.1 上，是安全上下文，剪贴板接口能用；万一被拒就提示手动抄。 */
    const openInBrowser = (url: string) => {
        api.fsOpen({url}).catch((err: unknown) => {
            console.warn('打不开系统浏览器：', err)
            onToast('打不开系统浏览器', 'err')
        })
    }
    const copyMail = async () => {
        try {
            await navigator.clipboard.writeText(AUTHOR_MAIL)
            onToast('邮箱已复制', 'ok')
        } catch {
            onToast('复制不了，手动抄一下吧', 'err')
        }
    }
    return (
        <>
            <Panel>
                <PanelHead title="关于 V-Synth-Studio"/>
                <div className="stats-row">
                    <Stat label="程序版本" value={state?.version ?? '—'}/>
                    <Stat label="运行环境" value={state?.platformDesc ?? state?.platform ?? '—'}/>
                    {/* 这里只放用户真需要知道的一件事：配置与产物落在哪一侧。
              「进程（PID / 已运行多久）」不在此列 —— IPC 下前端和后端同进程同生命周期，
              问它没有意义（见 `ipc/state.rs` 的说明）。 */}
                    <Stat
                        label="配置形态"
                        value={state?.installed ? '安装版' : '绿色版'}
                        /* 安装版的可写目录三端不一样（`%APPDATA%` / `~/Library/Application Support`），
                           别在界面上写死 Windows 那一套。 */
                        sub={t(
                            state?.installed
                                ? state?.platform === 'darwin'
                                    ? '配置在 ~/Library/Application Support'
                                    : '配置在 %APPDATA%'
                                : '配置在程序目录',
                        )}
                    />
                    <Stat
                        label="外部工具"
                        value={`${toolsReady} / 2`}
                        sub={state?.tools?.python?.available ? '含 Python' : '无 Python'}
                    />
                </div>
                <p className="hint">程序根目录：{state?.paths?.root ?? '未读取到'}</p>
                <p className="hint">
                    项目地址：
                    <Upstream href="https://github.com/QingMu39-Gao/V-Synth-Studio">
                        github.com/QingMu39-Gao/V-Synth-Studio
                    </Upstream>
                </p>
                <div className="btn-row">
                    <Button
                        onClick={async () => {
                            await onRefresh()
                            onToast('已重新读取', 'ok')
                        }}
                    >
                        重新读取配置
                    </Button>
                    <Button onClick={() => onNavigate('dashboard')}>回到总览</Button>
                </div>
            </Panel>

            {/* 检查更新：问一次 GitHub Releases。只查不装 —— 装不装由用户点发布页决定，
           所以这里**没有**下载按钮。 */}
            <Panel>
                <PanelHead
                    title={t('检查更新')}
                    desc={t('从 GitHub 的 Release 页查一次最新发布')}
                />
                <p className="hint">当前版本：{state?.version ?? '未读取到'}</p>
                <div className="btn-row">
                    <Button loading={updateBusy} onClick={checkUpdate}>
                        {t('检查更新')}
                    </Button>
                    {dl.file ? (
                        <Button
                            variant="primary"
                            icon="play"
                            onClick={() => {
                                api.fsOpen({path: dl.file}).catch((e: unknown) => {
                                    onToast(
                                        `${t('打开安装包失败')}：${e instanceof Error ? e.message : String(e)}`,
                                        'err',
                                    )
                                })
                            }}
                        >
                            {t('打开安装包')}
                        </Button>
                    ) : (
                        update?.ok &&
                        update.hasUpdate &&
                        installer && (
                            <Button
                                variant="primary"
                                icon="download"
                                loading={dl.job?.status === 'running'}
                                onClick={() => void dl.download(installer, update.latest)}
                            >
                                {`${t('下载新版本')}${installerSize ? `（${installerSize}）` : ''}`}
                            </Button>
                        )
                    )}
                    {update?.ok && update.hasUpdate && (
                        <Button
                            variant="primary"
                            onClick={() => openInBrowser(update.url ?? '')}
                        >
                            {t('打开发布页')}
                        </Button>
                    )}
                    {update?.ok && update.hasUpdate && (
                        <Button
                            variant="ghost"
                            onClick={() => {
                                saveConfig({ignoredUpdate: update.latest ?? ''})
                                onToast(`${t('不再提醒这个版本')}：${update.latest ?? ''}`, 'ok')
                            }}
                        >
                            {t('忽略这个版本')}
                        </Button>
                    )}
                </div>
                {updateErr && <p className="hint">{updateErr}</p>}
                {update?.ok === false && <p className="hint">{update.error}</p>}
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
                {/* 直连不通时后端会自动改走自建源或镜像：这件事要说出来，
                    用户有权知道版本信息是第三方代答的（值由后端给，见 `update.rs`） */}
                {update?.ok && update.via && update.source !== 'direct' && (
                    <p className="hint">
                        {update.source === 'self'
                            ? t('这次由自建源代查')
                            : t('GitHub 直连不通，这次是经镜像代查的')}
                        ：{update.via}
                    </p>
                )}
                {ignored && (
                    <p className="hint">
                        {`${t('已忽略这个版本')}：${ignored}`}
                        <Button
                            size="sm"
                            onClick={() => {
                                saveConfig({ignoredUpdate: ''})
                                onToast(t('已恢复提醒'), 'ok')
                            }}
                        >
                            {t('恢复提醒')}
                        </Button>
                    </p>
                )}
                {update?.ok && update.hasUpdate && (
                    <>
                        <Finding level="info" title={`${t('有新版本')}：${update.latest ?? ''}`}>
                            {`${update.name ? `${update.name} · ` : ''}${t('发布于')} ${
                                update.publishedAt ? update.publishedAt.slice(0, 10) : t('未知日期')
                            }${update.prerelease ? t('（预览版）') : ''}`}
                        </Finding>
                        <pre className="job-log">{update.notes || t('这条发布没有写说明。')}</pre>
                    </>
                )}
                {update?.ok && !update.hasUpdate && (
                    <p className="hint">
                        {t('已经是最新版本')}
                        {update.latest ? `（${t('上游最新发布')}：${update.latest}）` : ''}
                    </p>
                )}
            </Panel>

            {/* 关于作者 → 作者的话 → 感谢名单 → 第三方组件许可总表，顺序固定：
          人名在前、致谢在后，许可垫底。别把许可挪到前面。 */}
            <Panel>
                <PanelHead
                    title="关于作者"
                    desc="初次见面的人初次见面，好久不见的人好久不见 —— 一个热爱 Vocaloid 的普通人"
                />
                <div className="author-name">叫我清沐就好</div>
                <div className="btn-row">
                    <Button
                        size="sm"
                        icon="bilibili"
                        onClick={() => openInBrowser('https://b23.tv/qfAgBjQ')}
                    >
                        哔哩哔哩
                    </Button>
                    <Button
                        size="sm"
                        icon="douyin"
                        onClick={() =>
                            openInBrowser(
                                'https://www.douyin.com/user/MS4wLjABAAAAC4OEMmA9ito6EUZwSHNw2pZQ7e5pqEPH3EJhDEfs3jqiT4EwydjMLiD2QMVrZYy0?from_tab_name=main',
                            )
                        }
                    >
                        抖音
                    </Button>
                    <Button
                        size="sm"
                        icon="users"
                        onClick={() => openInBrowser('https://qm.qq.com/q/1oM0jFK7Va')}
                    >
                        Q 群 · 清沐的小窝
                    </Button>
                    <Button size="sm" icon="mail" onClick={copyMail}>
                        {AUTHOR_MAIL}
                    </Button>
                </div>
                <p className="hint">
                    邮箱按钮点一下复制到剪贴板；其余按钮在系统默认浏览器里打开。
                </p>
            </Panel>

            <Panel>
                <PanelHead title="作者的话"/>
                <p className="muted">
                    这个项目由 DeepSeek、Claude 等智能体辅助开发。最初只是清沐想集结各种方便的功能，便于虚拟歌姬调教罢了。
                    作者也只是个学生，很感谢大家的支持呀 —— 这个项目一半的资金都是大家赞助的！真的很谢谢大家！
                </p>
            </Panel>

            <Panel>
                <PanelHead title="感谢名单" desc="赞助者 —— 排名无先后顺序"/>
                <div className="chips">
                    {SPONSORS.map((n) => (
                        <Chip key={n}>{n}</Chip>
                    ))}
                </div>
                <p className="hint">以及一些无法展示 id 的用户和测试者们，同样谢谢你们。</p>
            </Panel>

            {/* 全量许可清单：所有用到第三方开源项目的功能在这儿各占一行。
          各功能页自己那块 `Credit` 仍然保留，改一处要同步另一处。 */}
            <Panel>
                <PanelHead title="第三方组件许可" desc="所有用到第三方开源项目的功能，按功能逐项列出"/>
                <div className="lic-list">
                    {LICENSES.map((l) => (
                        <div className="lic-row" key={l.feature}>
                            <div className="lic-feature">{l.feature}</div>
                            <div>
                                <div className="lic-head">
                  <span className="lic-upstream">
                    {l.href ? <Upstream href={l.href}>{l.upstream}</Upstream> : l.upstream}
                  </span>
                                    <Chip>{l.license}</Chip>
                                </div>
                                <p className="hint">{l.how}</p>
                            </div>
                        </div>
                    ))}
                </div>
                <p className="hint">
                    本程序自身以 <strong>GPL-3.0</strong> 授权（版权归 QingMu39）：可自由使用、修改、再分发，
                    再分发时需同样以 GPL-3.0 开放源码。界面运行在系统自带的 WebView2 上。
                    各组件许可全文与更多合规说明见仓库里的 docs/THIRD-PARTY-NOTICES.md。
                </p>
            </Panel>
        </>
    )
}

/* ══════════════════════════════════════════════════════════ 公告 ══ */

/**
 * 公告栏 —— 自己那一栏，内容来自自建源（见 `announce.rs`）。
 *
 * 与启动弹窗共用同一份「已读」记录（`config.seenAnnouncements`）：弹窗里点过「知道了」
 * 的，这里就是已读；这里标了已读的，启动时也不再弹。
 *
 * ⚠️ 取不到**不是错误**（服务器在重启、断网）：这里只把后端那句话显示出来，不弹 toast ——
 * 用户没点「刷新」时，一次失败不该打断他。
 */
function Announce({onToast}: { onToast: ToastFn }) {
    const {t} = useI18n()
    const [reply, setReply] = useState<AnnounceReply | null>(null)
    const [busy, setBusy] = useState(false)
    const [seen, setSeen] = useState<string[]>(() => getConfig().seenAnnouncements ?? [])

    /* 弹窗那边也会写这个键：订阅一下，两边始终是同一份「已读」 */
    useEffect(() => onConfigChange(() => setSeen(getConfig().seenAnnouncements ?? [])), [])

    const load = useCallback(async () => {
        setBusy(true)
        try {
            setReply(await api.announceList())
        } catch (e) {
            onToast(e instanceof Error ? e.message : String(e), 'err')
        } finally {
            setBusy(false)
        }
    }, [onToast])

    useEffect(() => {
        void load()
    }, [load])

    const items = reply?.items ?? []
    const unread = unseen(items, seen)
    const markAll = () => {
        let next = getConfig().seenAnnouncements
        for (const a of unread) next = markSeen(next, a.id)
        saveConfig({seenAnnouncements: next ?? []})
        onToast(t('全部标为已读'), 'ok')
    }

    return (
        <Panel>
            <PanelHead
                title={t('公告')}
                desc={t('从自建源取；有没读过的，下次启动会弹一次')}
            />
            <div className="btn-row">
                <Button loading={busy} icon="refresh" onClick={() => void load()}>
                    {t('刷新')}
                </Button>
                {unread.length > 0 && (
                    <Button onClick={markAll}>
                        {`${t('全部标为已读')}（${unread.length}）`}
                    </Button>
                )}
                {reply?.ok && reply.via && <span className="hint">{reply.via}</span>}
            </div>
            {reply?.ok === false && (
                <p className="hint">{`${t('取不到公告')}：${reply.error ?? ''}`}</p>
            )}
            {reply?.ok && items.length === 0 && <p className="hint">{t('还没有公告')}</p>}
            <div className="stack">
                {items.map((a) => {
                    const isUnread = unread.some((u) => u.id === a.id)
                    return (
                        <Finding
                            key={a.id}
                            level={isUnread && a.level === 'warn' ? 'warn' : 'info'}
                            title={`${isUnread ? `[${t('未读')}] ` : ''}${a.title || t('公告')}`}
                        >
                            <span className="hint">
                                {a.date ? `${a.date.slice(0, 10)} · ` : ''}
                            </span>
                            {a.body || ''}
                            <span className="btn-row">
                                {a.url && (
                                    <Button
                                        size="sm"
                                        icon="external"
                                        onClick={() => {
                                            api.fsOpen({url: a.url ?? ''}).catch((e: unknown) => {
                                                onToast(
                                                    `${t('打开链接失败')}：${e instanceof Error ? e.message : String(e)}`,
                                                    'err',
                                                )
                                            })
                                        }}
                                    >
                                        {t('查看详情')}
                                    </Button>
                                )}
                                {isUnread && (
                                    <Button
                                        size="sm"
                                        onClick={() =>
                                            saveConfig({
                                                seenAnnouncements: markSeen(
                                                    getConfig().seenAnnouncements,
                                                    a.id,
                                                ),
                                            })
                                        }
                                    >
                                        {t('标为已读')}
                                    </Button>
                                )}
                            </span>
                        </Finding>
                    )
                })}
            </div>
        </Panel>
    )
}
