import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Banner,
  Card,
  GlassBadge,
  GlassDialog,
  List,
  ListSection,
  SearchField,
} from '@ttqtt/liquid-glass-react'
import { api, type ResourceItem } from '@/lib/api'
import { useJob } from '@/lib/useJob'
import { useMaterial } from '@/lib/useGlass'
import { Button } from '@/components/Button'
import { Icon } from '@/components/Icon'
import { Chip, Panel, Stat } from '@/components/Panel'
import { JobProgress } from '@/components/Job'
import type { PageProps } from './types'
import './Resources.css'

/**
 * 资源库 —— 从旧前端（已退役）搬过来的。
 *
 * 数据只有一份来源：`/api/resources`（读的是 `app/data/resources.json`）。
 * 结构照 `docs/FRONTEND.md` 第 3.2 节全部换成库的组件：
 * `SearchField` / `Banner` / `List`+`ListSection` / `Card` / `GlassBadge` / `GlassDialog`，
 * 按钮走 `components/Button.tsx`（库的 `GlassButton`）。
 *
 * 三条规则（`AGENTS.md` 第七节）在代码里的落点：
 *   1. **`verified.verdict` 三态**是徽章的唯一依据 —— `ok` 可达 / `warn` 存疑 / `dead` 失效，
 *      **403 属于 `warn`**：Musopen、Dreamtonics、Booth 这类正常站点会拦脚本请求。
 *      库里没写 verdict 的结果按状态码推（200/301/302/403 → warn 以上，404/410/无状态 → dead）。
 *   2. 只陈列链接，**不托管文件**；顶部 `notice` 原样展示（拒绝收录学习版 / 破解版）。
 *   3. 点条目走 `api.fsOpen({ url })` —— 在**系统默认浏览器**里打开，
 *      不是 `window.open`（新前端的 WebView 不该再多开一个壳内窗口）。
 */

/* ══════════════════════════════════════════════════════════ 文案与常量 ══ */

/** 兜底声明。正常情况下用 resources.json 里的 notice，这里只在 JSON 缺失时顶一下。 */
const DEFAULT_NOTICE =
  '抱歉！我们拒绝收录学习版以及破解版资源。如果有需要最好是去下载官方的正规体验版。再说现在这些免费资源其实蛮好找的。。。'

/**
 * `verified.verdict` → 徽章。三态都是**文字 + 语义色**，
 * 不能只靠颜色（色盲用户看不到 ok/dead 的差别）。
 */
const VERDICT = {
  ok: { text: '可达', tone: 'accent' as const, icon: 'check' as const },
  warn: { text: '存疑', tone: 'neutral' as const, icon: 'alert' as const },
  dead: { text: '失效', tone: 'notification' as const, icon: 'alert' as const },
}

/** tag → chip 语义色，按关键词猜，猜不中就中性（照旧实现） */
const TAG_TONES: Record<'ok' | 'warn', string[]> = {
  ok: ['官方', '免费', '开源'],
  warn: ['需付费', '注意', '付费'],
}

const MAX_TAGS = 3

/** 收起时每组先露几条。旧实现是按网格列数算的，这里用固定条数 —— 见文件末尾的说明。 */
const PEEK = 3

/**
 * 记住了哪些分组被展开。**故意放模块作用域**：切走再回来还记着，重启回到默认收起
 * （旧实现就是这么做的，没进 config）。
 */
const expandedGroups = new Set<string>()

/* ══════════════════════════════════════════════════════════ 工具函数 ══ */

function hostOf(item: ResourceItem): string {
  const home = String(item.home ?? '').trim()
  if (home) return home.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  try {
    return new URL(String(item.url ?? '')).hostname.replace(/^www\./i, '')
  } catch {
    return ''
  }
}

const httpLink = (url: string) => /^https?:\/\//i.test(url)

function tagTone(tag: string): 'ok' | 'warn' | undefined {
  for (const tone of ['ok', 'warn'] as const) {
    if (TAG_TONES[tone].some((w) => tag.includes(w))) return tone
  }
  return undefined
}

function stamp(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** 一次校验结果（库里自带的、或「检查失效链接」跑出来的），摊平成同一种形状 */
interface CheckInfo {
  status: number
  checkedAt: string
  note: string
  error: string
  /** 后端直接给了 verdict 就用它（`vspx` 那种 `skipProbe` 的条目没有状态码，只能靠它） */
  verdict?: 'ok' | 'warn' | 'dead'
}

const itemKey = (groupId: string, item: ResourceItem) => `${groupId}/${item.id || item.name || ''}`

/** 状态码 / 连接错误 → 三态。403 归 warn（是反爬，不是失效），404/410/无状态归 dead。 */
function verdictOf(c: CheckInfo): 'ok' | 'warn' | 'dead' {
  if (c.verdict) return c.verdict
  if (c.error) return 'dead'
  const s = c.status
  if (!s) return c.note ? 'warn' : 'dead'
  if (s === 200 || s === 301 || s === 302 || s === 307 || s === 308) return 'ok'
  if (s === 404 || s === 410) return 'dead'
  if (s === 403 || s === 401 || s === 405 || s === 429) return 'warn'
  return 'warn' // 其它 5xx：存疑，要人工确认
}

/* ══════════════════════════════════════════════════════════════════ 页面 ══ */

export function Resources({ onToast }: PageProps) {
  /* 档位派生的材质：给库那些「自带 regular 默认值」的大玻璃用（Banner / Dialog） */
  const { material } = useMaterial()
  const [groups, setGroups] = useState<{ id: string; name: string; description: string; icon: string; items: ResourceItem[] }[]>([])
  const [notice, setNotice] = useState('')
  const [updatedAt, setUpdatedAt] = useState('')
  const [summary, setSummary] = useState<{ checkedAt: string; total: number; ok: number; warn: number; dead: number; passRate: number } | null>(null)
  const [checks, setChecks] = useState<Record<string, CheckInfo>>({})
  const [loading, setLoading] = useState(true)
  const [loadErr, setLoadErr] = useState('')
  const [query, setQuery] = useState('')
  const [activeGroup, setActiveGroup] = useState('')
  const [expanded, setExpanded] = useState(() => new Set(expandedGroups))
  const [copyFallback, setCopyFallback] = useState<{ url: string; reason: string } | null>(null)

  const { job, start } = useJob()
  const [checking, setChecking] = useState(false)
  /** `checkLinks` 跑完后的落款，由 `onDone` 写、`JobProgress` 之外那行读 */
  const [checkNote, setCheckNote] = useState('')
  const sectionsRef = useRef<HTMLDivElement>(null)

  /* ── 加载 ───────────────────────────────────────────────── */

  const load = useCallback(
    async (reload: boolean) => {
      setLoading(true)
      setLoadErr('')
      setActiveGroup('')
      try {
        const res = await api.resources(reload)
        const gs = (res.groups ?? []).filter((g) => g && (g.items ?? []).length)
        setGroups(gs)
        setNotice(res.notice ?? '')
        setUpdatedAt(res.updatedAt ?? '')
        setSummary(res.verifySummary?.checkedAt ? res.verifySummary : null)
        /* 数据里自带的 verified 先当初始徽章 —— 一次校验都没跑过时也有东西可看 */
        const init: Record<string, CheckInfo> = {}
        for (const g of gs) {
          for (const it of g.items ?? []) {
            const v = it.verified
            if (!v) continue
            init[itemKey(g.id, it)] = {
              status: Number(v.status ?? 0),
              checkedAt: v.checkedAt ?? '',
              note: '',
              error: '',
              verdict: v.verdict,
            }
          }
        }
        setChecks(init)
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        setGroups([])
        setNotice('')
        setSummary(null)
        setLoadErr(msg)
        onToast(`资源库读取失败：${msg}`, 'err')
      } finally {
        setLoading(false)
      }
    },
    [onToast],
  )

  useEffect(() => {
    void load(false)
  }, [load])

  /* ── 搜索与筛选 ─────────────────────────────────────────── */

  const q = query.trim().toLowerCase()

  const itemMatches = useCallback(
    (it: ResourceItem) =>
      !q ||
      [it.name, it.desc, it.tip, it.region, it.cost, it.home, (it.tags ?? []).join(' '), hostOf(it)]
        .some((p) => String(p ?? '').toLowerCase().includes(q)),
    [q],
  )

  /** 每组当前要显示的条目：先按分组筛，再按关键词筛 */
  const shown = useMemo(
    () =>
      groups
        .filter((g) => !activeGroup || g.id === activeGroup)
        .map((g) => ({ group: g, items: (g.items ?? []).filter(itemMatches) }))
        .filter(({ group, items }) => !q || items.length > 0 || (group.name ?? '').toLowerCase().includes(q)),
    [groups, activeGroup, itemMatches, q],
  )

  const shownItems = shown.reduce((n, s) => n + s.items.length, 0)
  const totalItems = groups.reduce((n, g) => n + (g.items ?? []).length, 0)

  /* ── 检查失效链接 ───────────────────────────────────────── */

  const checkLinks = async () => {
    if (!totalItems) {
      onToast('资源库为空，没什么可校验的', 'warn')
      return
    }
    setChecking(true)
    setCheckNote('每个站点都会请求一次；403 多为反爬拦截，不代表站点失效。')
    try {
      const res = await api.checkLinks([])
      /* ⚠️ 后端 `/api/resources/check` 目前是**占位实现**（返回 `{ results: [], pending: true }`，
         还没有 jobId）。所以这里必须先判有没有 jobId 再订阅 —— 直接 `start(undefined)` 会
         挂一个永远不动的进度条，那正是「静默失败」。等后端接上真实校验，这段不用改。 */
      if (!res?.jobId) {
        setChecking(false)
        setCheckNote('')
        onToast('后端还没接上链接校验（/api/resources/check 返回待实现），暂时无法检查', 'err')
        return
      }
      start(res.jobId, {
        onDone: (j) => {
          const results = (j.result as { results?: { group?: string; id?: string; status?: number; note?: string; error?: string; checkedAt?: string }[] } | undefined)?.results ?? []
          let ok = 0
          const next: Record<string, CheckInfo> = {}
          for (const r of results) {
            const info: CheckInfo = {
              status: Number(r.status ?? 0),
              checkedAt: r.checkedAt ?? stamp(),
              note: r.note ?? '',
              error: r.error ?? '',
            }
            next[`${r.group}/${r.id ?? ''}`] = info
            if (verdictOf(info) === 'ok') ok += 1
          }
          setChecks((c) => ({ ...c, ...next }))
          const bad = results.length - ok
          setChecking(false)
          setCheckNote(`完成：${ok} 条可达 / ${bad} 条失效或存疑。`)
          onToast(`${ok} 条正常，${bad} 条异常（徽章已更新）`, bad ? 'warn' : 'ok')
        },
        onError: (err) => {
          setChecking(false)
          setCheckNote('')
          onToast(`校验失败：${err.message}`, 'err')
        },
        onCancel: () => {
          setChecking(false)
          setCheckNote('校验已取消')
        },
      })
    } catch (e) {
      setChecking(false)
      setCheckNote('')
      onToast(e instanceof Error ? e.message : String(e), 'err')
    }
  }

  /* ── 分组跳转 ───────────────────────────────────────────── */

  const goGroup = (id: string) => {
    setActiveGroup(id)
    if (!id) {
      window.scrollTo({ top: 0, behavior: 'smooth' })
      return
    }
    const el = sectionsRef.current?.querySelector(`section[data-group="${id}"]`)
    el?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  /* ── 打开 / 复制 ────────────────────────────────────────── */

  const open = async (url: string) => {
    if (!httpLink(url)) {
      onToast('这条资源没有可用链接', 'warn')
      return
    }
    try {
      await api.fsOpen({ url })
    } catch (e) {
      onToast(e instanceof Error ? e.message : String(e), 'err')
    }
  }

  const copy = async (url: string) => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('当前环境不提供剪贴板接口')
      await navigator.clipboard.writeText(url)
      onToast('链接已复制', 'ok')
    } catch (e) {
      /* 剪贴板拿不到就退到手动复制 —— 静默失败等于用户点了没反应 */
      setCopyFallback({ url, reason: e instanceof Error ? e.message : String(e) })
    }
  }

  /* ── 渲染 ───────────────────────────────────────────────── */

  return (
    <>
      {/* ── 工具条：搜索 / 分组筛选 / 两个动作 ── */}
      <div className="res-toolbar">
        <SearchField
          aria-label="搜索资源"
          clearLabel="清空搜索"
          placeholder="搜索名称、描述、标签…"
          value={query}
          onValueChange={setQuery}
          className="res-search"
        />
        <div className="res-chips">
          <button type="button" className="res-chip" onClick={() => goGroup('')}>
            <Chip tone={activeGroup ? 'default' : 'accent'}>全部</Chip>
          </button>
          {groups.map((g) => (
            <button
              key={g.id}
              type="button"
              className="res-chip"
              title={g.description ?? ''}
              onClick={() => goGroup(activeGroup === g.id ? '' : g.id)}
            >
              <Chip tone={activeGroup === g.id ? 'accent' : 'default'}>
                {g.name || g.id}
                <span className="res-chip-count">{(g.items ?? []).length}</span>
              </Chip>
            </button>
          ))}
        </div>
        <div className="res-actions">
          <span className="res-count">
            {totalItems} 条链接 / {groups.length} 个分组
          </span>
          <Button size="sm" variant="ghost" icon="refresh" loading={loading} onClick={() => void load(true)}>
            重新载入
          </Button>
          <Button size="sm" variant="primary" icon="shield" loading={checking} onClick={() => void checkLinks()}>
            检查失效链接
          </Button>
        </div>
      </div>

      {/* ── 顶部声明：不收录学习版 / 破解版（文案来自 resources.json）── */}
      {/*
        ⚠️ 库的 `Banner` / `GlassDialog` 是**大玻璃**，它们自带 `regular` 默认值，
        不跟 `GlassProvider` 的 policy 走（设计系统里「大面=毛玻璃」）。于是液态档下
        整页都是折射、只有这两块还是毛玻璃 —— 看着就是「这页材质没切」。
        这里显式把档位派生的材质传下去，让它跟页面一致。
      */}
      <Banner
        tone="warning"
        title="先看这条：别从网盘下「整合包」"
        message={notice || DEFAULT_NOTICE}
        material={material === 'liquid' ? 'clear' : 'regular'}
      />

      {/* ── 上次校验的汇总 ── */}
      {summary && (
        <Panel>
          <div className="stats-row">
            <Stat
              label="上次校验"
              value={summary.checkedAt || '—'}
              sub={`共 ${summary.total} 条${updatedAt ? ` · 数据 ${updatedAt}` : ''}`}
            />
            <Stat label="通过率" value={`${summary.passRate}%`} sub={`${summary.ok} 可达`} />
            <Stat label="存疑" value={summary.warn} sub="多为反爬拦截，不妨碍正常打开" />
            <Stat label="失效" value={summary.dead} sub={summary.dead ? '应尽快处理' : '没有失效条目'} />
          </div>
        </Panel>
      )}

      {/* ── 校验进度：长任务一律 JobProgress（库的 GlassProgress + 取消）── */}
      {(checking || job) && (
        <Panel>
          <JobProgress
            job={job}
            title={`正在校验 ${totalItems} 条链接`}
            onCancel={(id) => {
              api.cancelJob(id).catch((e: unknown) =>
                onToast(e instanceof Error ? e.message : String(e), 'err'),
              )
            }}
          />
          {checkNote && <p className="hint">{checkNote}</p>}
        </Panel>
      )}

      {/* ── 加载中 / 读取失败 / 空库 ── */}
      {loading && !groups.length && (
        <Panel>
          <p className="muted">正在读取资源库…</p>
        </Panel>
      )}

      {!loading && loadErr && (
        <Panel>
          <div className="stack">
            <p className="finding-title">资源库读取失败</p>
            <p className="finding-text">{loadErr}</p>
            <p className="muted">
              如果 <code>app/data/resources.json</code> 还没生成，等它写好后点下面重试即可。
            </p>
            <div className="btn-row">
              <Button icon="refresh" onClick={() => void load(true)}>
                重试
              </Button>
            </div>
          </div>
        </Panel>
      )}

      {!loading && !loadErr && !groups.length && (
        <Panel>
          <div className="empty">
            <Icon name="library" size={28} />
            <p className="finding-title">资源库还是空的</p>
            <p className="muted">
              <code>app/data/resources.json</code> 里还没有条目，或文件尚未生成。点「重新载入」再试一次。
            </p>
            <Button icon="refresh" onClick={() => void load(true)}>
              重新载入
            </Button>
          </div>
        </Panel>
      )}

      {!loading && !loadErr && !!groups.length && !shown.length && (
        <Panel>
          <div className="empty">
            <Icon name="search" size={28} />
            <p className="finding-title">没有匹配的资源</p>
            <p className="muted">
              {q ? `没有名称 / 描述 / 标签里含「${query.trim()}」的条目。换个词，或清空搜索框。` : '当前分组下没有条目。'}
            </p>
            <Button
              onClick={() => {
                setQuery('')
                setActiveGroup('')
              }}
            >
              清空搜索
            </Button>
          </div>
        </Panel>
      )}

      {/* ── 分组 + 条目 ── */}
      {!!shown.length && (
        <>
          {(q || activeGroup) && (
            <p className="res-filter-note">
              筛选出 {shownItems} 条 / {shown.length} 个分组
            </p>
          )}
          <div className="res-groups" ref={sectionsRef}>
            <List>
              {shown.map(({ group, items }) => {
                /* 搜索时**强制展开** —— 否则搜到的条目被折叠藏起来，等于没搜到 */
                const isOpen = !!q || expanded.has(group.id)
                const peek = isOpen ? items : items.slice(0, PEEK)
                return (
                  <section key={group.id} data-group={group.id}>
                    {/* 分组**整块**是一个面板：档 1~3 是 MaterialView、档 4 变玻璃面，
                        跟总览页的段落一致。以前这里只有裸的 List，条目永远是平的白卡，
                        于是「切材质」在这一页看不出变化。 */}
                    <Panel padded={false}>
                    <ListSection
                      header={
                        <div className="res-head">
                          <span className="res-head-icon">
                            <Icon name="library" size={16} />
                          </span>
                          <span className="res-head-text">
                            <span className="res-head-name">{group.name || group.id}</span>
                            {group.description && <span className="res-head-desc">{group.description}</span>}
                          </span>
                          <span className="res-head-count">{items.length} 条</span>
                        </div>
                      }
                      footer={
                        items.length > PEEK ? (
                          <button
                            type="button"
                            className="res-more"
                            onClick={() =>
                              setExpanded((prev) => {
                                const next = new Set(prev)
                                if (next.has(group.id)) next.delete(group.id)
                                else next.add(group.id)
                                expandedGroups.clear()
                                for (const id of next) expandedGroups.add(id)
                                return next
                              })
                            }
                          >
                            <Icon name={isOpen ? 'chevronUp' : 'chevronDown'} size={13} />
                            {isOpen ? '收起' : `展开全部 ${items.length} 条`}
                          </button>
                        ) : undefined
                      }
                    >
                      <div className="res-items">
                        {peek.map((it) => (
                          <ResourceCard
                            key={it.id || it.name}
                            item={it}
                            check={checks[itemKey(group.id, it)]}
                            onOpen={() => void open(it.url)}
                            onCopy={() => void copy(it.url)}
                          />
                        ))}
                      </div>
                    </ListSection>
                    </Panel>
                  </section>
                )
              })}
            </List>
          </div>
        </>
      )}

      {/* ── 剪贴板不可用时的退路：给一个已全选的输入框 ── */}
      <CopyDialog value={copyFallback} onClose={() => setCopyFallback(null)} />
    </>
  )
}

/** 手动复制：剪贴板接口不可用（非安全上下文 / 权限被拒）时的退路 */
function CopyDialog({
  value,
  onClose,
}: {
  value: { url: string; reason: string } | null
  onClose: () => void
}) {
  /*
   * ⚠️ 这里**故意不传 `material`**：库的 `GlassDialog` 内部是写死的
   *   `{ ...surface, material: 'regular', size: 'large' }`
   * （上游 `src/react/overlays/dialog.tsx`），传进去也会被它盖掉 —— 弹窗按设计
   * 系统就是「大面 = 毛玻璃」。实测：档 4 下整页都是折射，只有这个**模态框**仍是
   * 毛玻璃，那是库的行为，不是这一页没切材质。Banner 不同，它认 `material`，所以
   * 那边显式传了档位派生的值。
   */
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (value) inputRef.current?.select()
  }, [value])
  return (
    <GlassDialog
      open={!!value}
      onOpenChange={(o) => !o && onClose()}
      title="手动复制链接"
      description={value ? `${value.reason}。请手动全选复制：` : ''}
    >
      <input className="input res-copy-input" readOnly ref={inputRef} value={value?.url ?? ''} />
      <div className="dir-actions">
        <span className="spacer" />
        <Button size="sm" variant="primary" onClick={onClose}>
          关闭
        </Button>
      </div>
    </GlassDialog>
  )
}

/* ══════════════════════════════════════════════════════════════ 条目卡 ══ */

function ResourceCard({
  item,
  check,
  onOpen,
  onCopy,
}: {
  item: ResourceItem
  check?: CheckInfo
  onOpen: () => void
  onCopy: () => void
}) {
  const url = String(item.url ?? '')
  const hasUrl = httpLink(url)
  const host = hostOf(item)
  const tags = Array.isArray(item.tags) ? item.tags : []
  const verdict = check ? verdictOf(check) : null
  const badge = verdict ? VERDICT[verdict] : null
  /* 悬浮说明：校验时间 / 备注 / 链接，和旧实现一致 */
  const badgeTitle = check
    ? [
        check.checkedAt ? `校验时间：${check.checkedAt}` : '未记录校验时间',
        check.note ? `备注：${check.note}` : '',
        url,
      ]
        .filter(Boolean)
        .join('\n')
    : ''

  return (
    /* `Card` 是内容层容器（实色、不采样背景）—— 正好是「玻璃是浮起来那一层」的规矩：
       只有上面的工具条 / 按钮 / 弹层才带材质。 */
    <Card className="res-item">
      <div className="res-item-head">
        <span className="res-item-name" title={item.name ?? ''}>
          {item.name || '未命名'}
        </span>
        {item.official === true ? (
          <Chip tone="ok" title="来自官方 / 原作者渠道">
            <Icon name="shield" size={11} />
            官方
          </Chip>
        ) : (
          <Chip title="社区或第三方渠道，自己判断可靠性">
            <Icon name="globe" size={11} />
            社区/第三方
          </Chip>
        )}
      </div>

      <div className="res-item-host" title={hasUrl ? url : '（这条没有链接）'}>
        {host || (hasUrl ? url : '')}
      </div>

      <div className="chips">
        {item.region && <Chip>{item.region}</Chip>}
        {item.cost && <Chip tone={String(item.cost).includes('免费') ? 'ok' : 'default'}>{item.cost}</Chip>}
        {tags.slice(0, MAX_TAGS).map((t) => (
          <Chip key={t} tone={tagTone(t) ?? 'default'}>
            {t}
          </Chip>
        ))}
        {tags.length > MAX_TAGS && <Chip>+{tags.length - MAX_TAGS}</Chip>}
      </div>

      {item.desc && <p className="res-item-desc">{item.desc}</p>}
      {item.tip && (
        <p className="res-item-tip">
          <strong>提示：</strong>
          {item.tip}
        </p>
      )}

      <div className="res-item-foot">
        <Button size="sm" variant="primary" icon="external" disabled={!hasUrl} onClick={onOpen}>
          打开
        </Button>
        <Button size="sm" icon="link" disabled={!hasUrl} onClick={onCopy}>
          复制链接
        </Button>
        <span className="spacer" />
        {badge && (
          <GlassBadge tone={badge.tone} title={badgeTitle} aria-label={`链接状态：${badge.text}`}>
            <Icon name={badge.icon} size={11} />
            {check?.status ? `${check.status} ` : ''}
            {badge.text}
          </GlassBadge>
        )}
      </div>
    </Card>
  )
}

/*
 * ── 与旧实现有意不同的两点 ──────────────────────────────────────────────
 *
 * 1. **没有「滚动时高亮当前分组」**（旧实现用 IntersectionObserver 改 chip 的高亮）。
 *    新版的 chip 是**筛选器**：点了就把这一组单独列出来，高亮 = 当前筛选。
 *    两种语义混在一个控件上会互相打架（自动高亮会把用户刚点的筛选覆盖掉）。
 *
 * 2. **收起时按固定条数（3）预览，不按网格列数算**。旧实现要读
 *    `getComputedStyle(grid).gridTemplateColumns` 才知道一行能放几条，而那个值在窗口
 *    缩放后要等下次重渲染才更新（旧代码自己也留了注释）。固定条数在窄屏和宽屏都成立。
 */
