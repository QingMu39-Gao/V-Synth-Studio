import { useCallback, useEffect, useState } from 'react'
import { api } from '@/lib/api'
import type { AppState, HealthInfo } from '@/lib/types'
import { Button } from '@/components/Button'
import { Field, TextInput } from '@/components/Field'
import { Chip, Panel, PanelHead, Stat } from '@/components/Panel'
import { GlassSlider } from '@ttqtt/liquid-glass-react'
import { GLASS_LEVELS, useGlassLevel, type GlassLevel } from '@/lib/useGlass'
import type { ThemeMode } from '@/App'

/**
 * 设置。
 *
 * ## 「性能模式」这一项换掉了
 *
 * 旧版这里有个手写的「性能模式」开关，切 `<html data-perf>` 来全局关模糊。
 * 现在用库的 `transparency`（由 `App.tsx` 喂给 `GlassProvider`）——
 * 它同时做三件旧版没做的事：
 *
 *   1. 系统里开了「减少透明度」时**自动**生效，不用用户再点一次
 *   2. 关掉的是整个材质（模糊 + 半透明 + 折射），不只是 `backdrop-filter`
 *   3. 开关一开，所有玻璃面一起变，不会漏掉某个角落
 *
 * 语义也改了：不是「性能模式」（听起来像降级），而是**降低透明度**（这是无障碍需求）。
 */

const SECTIONS = [
  { id: 'appearance', label: '外观' },
  { id: 'paths', label: '路径' },
  { id: 'tools', label: '外部工具' },
  { id: 'about', label: '关于' },
] as const

type SectionId = (typeof SECTIONS)[number]['id']

export function Settings({
  state,
  theme,
  onThemeChange,
  onRefreshState,
  onNavigate,
  onToast,
}: {
  state: AppState | null
  theme: ThemeMode
  onThemeChange: (m: ThemeMode) => void
  onRefreshState: () => Promise<void>
  onNavigate: (id: string) => void
  onToast: (msg: string, tone?: string) => void
}) {
  const [section, setSection] = useState<SectionId>('appearance')
  const [cfg, setCfg] = useState<Record<string, unknown>>({})
  const [health, setHealth] = useState<HealthInfo | null>(null)

  const reload = useCallback(async () => {
    try {
      const s = await api.state()
      setCfg((s.config ?? {}) as Record<string, unknown>)
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e), 'err')
    }
  }, [onToast])

  useEffect(() => {
    void reload()
    api.health().then(setHealth).catch(() => {})
  }, [reload])

  const save = useCallback(
    async (patch: Record<string, unknown>, okMsg = '设置已保存') => {
      try {
        await api.saveConfig(patch)
        setCfg((c) => ({ ...c, ...patch }))
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
      <nav className="settings-nav" aria-label="设置分节">
        {SECTIONS.map((s) => (
          <button
            key={s.id}
            type="button"
            className="nav-row"
            aria-current={section === s.id ? 'page' : undefined}
            onClick={() => setSection(s.id)}
          >
            <span className="nav-row-label">{s.label}</span>
          </button>
        ))}
      </nav>

      <div className="stack-lg settings-body">
        {section === 'appearance' && (
          <Appearance theme={theme} onThemeChange={onThemeChange} />
        )}
        {section === 'paths' && (
          <Paths cfg={cfg} state={state} onSave={save} onToast={onToast} />
        )}
        {section === 'tools' && (
          <Tools state={state} onRefreshState={onRefreshState} onToast={onToast} />
        )}
        {section === 'about' && (
          <About
            state={state}
            health={health}
            onRefresh={reload}
            onNavigate={onNavigate}
            onToast={onToast}
          />
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
  const { level, setLevel } = useGlassLevel()

  /** 滑块给的是 number，收进 1~3（拖动/键盘理论上都给不出界外值，防御一下） */
  const clampLevel = (v: number): GlassLevel =>
    Math.min(GLASS_LEVELS.length, Math.max(1, Math.round(v))) as GlassLevel
  const THEMES: { id: ThemeMode; label: string; desc: string }[] = [
    { id: 'system', label: '跟随系统', desc: '系统切换配色时自动跟着换' },
    { id: 'light', label: '明亮', desc: '浅色底、细描边' },
    { id: 'dark', label: '黑暗', desc: '深色底，长时间看不刺眼' },
  ]

  return (
    <>
      {/*
        玻璃等级：一个滑块管住原来三件事 —— 材质（毛玻璃/液态）、
        「全局玻璃」（内容面板要不要玻璃面）、「降低透明度」（库的 opaque 策略）。
        用户看到的是三个互相影响的开关，合成分级之后语义才清楚：级别越高越「玻璃」，代价越大。
        滑块本身是**库的 `GlassSlider`**（真 `<input type=range>` 打底，键盘/读屏都能用）。
      */}
      <Panel>
        <PanelHead
          title="玻璃等级"
          desc="拖动滑块调整。级别越高越「玻璃」，开销也越大 —— 1 级最省、对比最高，4 级折射最全"
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
          1 级把玻璃换成不透明底色；2 级只模糊提色、3 级开折射 —— 这两级**内容面板都是轻量材质**；
          4 级连内容面板也变成玻璃，画面里每个玻璃面都会多一层 SVG 位移贴图（开销最大）。
          等级只影响材质，背景图参数不变。
          系统里开了「减少透明度」时，模糊会自动失效 —— 那是库的无障碍策略，不受这里影响。
        </p>
      </Panel>

      <Panel>
        <PanelHead title="主题" desc="整套界面的配色，选完立刻生效" />
        <div className="choice-grid">
          {THEMES.map((t) => (
            <button
              key={t.id}
              type="button"
              className="choice"
              aria-pressed={theme === t.id}
              onClick={() => onThemeChange(t.id)}
            >
              <span className="choice-head">
                <span className="choice-label">{t.label}</span>
                {theme === t.id && <Chip tone="accent">已选</Chip>}
              </span>
              <span className="choice-desc">{t.desc}</span>
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
  onToast: (m: string, t?: string) => void
}) {
  const [out, setOut] = useState('')
  const [dl, setDl] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setOut(String(cfg.outputDir ?? state?.paths?.outputDir ?? ''))
    setDl(String(cfg.downloadDir ?? state?.paths?.downloadDir ?? ''))
  }, [cfg.outputDir, cfg.downloadDir, state?.paths?.outputDir, state?.paths?.downloadDir])

  return (
    <Panel>
      <PanelHead title="默认目录" desc="只影响默认值，每次操作时还能单独改" />
      <div className="stack">
        <Field label="默认输出目录（转换结果）">
          <TextInput value={out} onChange={(e) => setOut(e.target.value)} />
        </Field>
        <Field label="默认下载目录（视频 / 音频）">
          <TextInput value={dl} onChange={(e) => setDl(e.target.value)} />
        </Field>
        <div className="btn-row">
          <Button
            variant="primary"
            loading={busy}
            onClick={async () => {
              setBusy(true)
              try {
                await onSave({ outputDir: out, downloadDir: dl }, '路径已保存')
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
  onToast: (m: string, t?: string) => void
}) {
  const tools = state?.tools ?? {}
  const [busy, setBusy] = useState(false)
  const missing = ['ffmpeg', 'ytdlp'].filter((k) => !tools[k]?.available)
  const rows = [
    { key: 'ffmpeg', name: 'ffmpeg', desc: '音视频合并、导出 WAV/MP3、变调变速、响度标准化' },
    { key: 'ytdlp', name: 'yt-dlp', desc: 'YouTube 等上千站点的解析与下载（B 站走内置解析）' },
    { key: 'python', name: 'Python', desc: '可选：部分脚本与 yt-dlp 的模块模式会用到' },
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
          ? `未检测到 ${missing.map((m) => (m === 'ytdlp' ? 'yt-dlp' : m)).join(' / ')}。它们随程序分发、不需要联网下载；若显示未找到，把 tools 目录重新解压到程序根目录即可。`
          : '三个外部工具都齐了，音频与下载功能完整可用。'}
      </p>
    </Panel>
  )
}

/* ══════════════════════════════════════════════════════════════ 关于 ══ */

function About({
  state,
  health,
  onRefresh,
  onNavigate,
  onToast,
}: {
  state: AppState | null
  health: HealthInfo | null
  onRefresh: () => Promise<void>
  onNavigate: (id: string) => void
  onToast: (m: string, t?: string) => void
}) {
  const toolsReady = ['ffmpeg', 'ytdlp'].filter((k) => state?.tools?.[k]?.available).length
  return (
    <>
      <Panel>
        <PanelHead title="关于 V-Synth-Studio" />
        <div className="stats-row">
          <Stat label="程序版本" value={health?.version ?? state?.version ?? '—'} />
          <Stat label="运行环境" value={health?.node ?? state?.platform ?? '—'} />
          <Stat
            label="进程"
            value={health?.pid ? `PID ${health.pid}` : '—'}
            sub={health?.uptimeSec ? `已运行 ${Math.floor(health.uptimeSec / 60)} 分钟` : undefined}
          />
          <Stat
            label="外部工具"
            value={`${toolsReady} / 2`}
            sub={state?.tools?.python?.available ? '含 Python' : '无 Python'}
          />
        </div>
        <p className="hint">程序根目录：{state?.paths?.root ?? '未读取到'}</p>
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

      <Panel>
        <PanelHead title="界面素材" />
        <p className="muted">
          玻璃材质、配色、字号、间距、圆角与动效来自开源项目{' '}
          <a href="https://github.com/Tsdsj/liquid-glass-react" target="_blank" rel="noreferrer">
            @ttqtt/liquid-glass-react
          </a>
          （MIT）。它是按 Apple 设计语言做的独立组件库，不是 Apple 官方产品，
          也不含 Apple 的字体或图标素材。
        </p>
      </Panel>
    </>
  )
}
