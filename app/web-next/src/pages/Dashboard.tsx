import { api } from '@/lib/api'
import type { AppState, FormatInfo, ToolInfo } from '@/lib/types'
import { Button } from '@/components/Button'
import { Chip, Finding, Panel, PanelHead, Stat } from '@/components/Panel'

/**
 * 总览：环境检测与常用入口。
 *
 * **整页没有一个玻璃面。** 卡片、标签、统计都是内容层的东西 —— 实色。
 * 唯一会浮起来的是外壳的顶栏和侧栏（见 `App.tsx`）。
 * 这不是省事，是设计系统的地基：玻璃不给内容层。
 */

const QUICK: { id: string; title: string; desc: string }[] = [
  {
    id: 'convert',
    title: '工程转换',
    desc: 'vsqx / vpr / ust / ustx / svp / ccs 互转，批量、可选输出目录，转换前先告诉你哪些数据会丢',
  },
  {
    id: 'video',
    title: 'MV 解析下载',
    desc: 'B 站原生解析（含 WBI 签名、大会员画质、弹幕字幕）+ yt-dlp 覆盖 YouTube 等站点',
  },
  {
    id: 'audio',
    title: '人声分离 / 音频',
    desc: 'MVSEP、UVR 直达；本地 ffmpeg 做 WAV/MP3 导出、变调变速、响度标准化',
  },
  {
    id: 'resources',
    title: '资源导航',
    desc: '立绘、免费声库、插件、可下 WAV 的音源站 —— 只存链接，不占你的硬盘',
  },
]

interface Check {
  id: string
  level: 'warn' | 'info'
  title: string
  detail: string
}

function computeChecks(state: AppState | null): Check[] {
  if (!state) return []
  const out: Check[] = []
  const tools = state.tools ?? {}
  const formats = state.formats ?? []

  if (!tools.ffmpeg?.available) {
    out.push({
      id: 'ffmpeg',
      level: 'warn',
      title: '未找到 ffmpeg',
      detail:
        'MV 下载后无法把视频流和音频流合并成 mp4，也不能导出 WAV/MP3、不能做变调变速。它随程序分发，不需要联网下载 —— 若显示未找到，把 tools 目录重新解压到程序根目录。',
    })
  }
  if (!tools.ytdlp?.available) {
    out.push({
      id: 'ytdlp',
      level: 'info',
      title: '未找到 yt-dlp',
      detail:
        'B 站解析是本程序原生实现的，不受影响；但 YouTube 及其它上千个站点需要它才能解析。',
    })
  }
  const unavailable = formats.filter((f) => !f.available)
  if (unavailable.length) {
    out.push({
      id: 'formats',
      level: 'info',
      title: `有 ${unavailable.length} 种格式的转换模块尚未就绪`,
      detail: `未就绪：${unavailable.map((f) => f.name).join('、')}。`,
    })
  }
  return out
}

export function Dashboard({
  state,
  refreshing,
  onNavigate,
  onRefreshState,
  onToast,
}: {
  state: AppState | null
  refreshing: boolean
  onNavigate: (id: string) => void
  onRefreshState: () => Promise<void>
  onToast: (msg: string, tone?: string) => void
}) {
  const checks = computeChecks(state)
  const formats = state?.formats ?? []
  const available = formats.filter((f) => f.available).length

  const redetect = async () => {
    try {
      const data = await api.detect(true)
      await onRefreshState()
      onToast(`检测完成：${data.installedCount} 个程序可用`, 'ok')
    } catch (e) {
      onToast(`检测失败：${e instanceof Error ? e.message : String(e)}`, 'err')
    }
  }

  if (refreshing && !state) {
    return (
      <Panel>
        <p className="muted">
          正在读取环境状态…（后端要挨个探测 ffmpeg / yt-dlp 的版本，通常 2–3 秒）
        </p>
      </Panel>
    )
  }

  return (
    <>
      <Panel>
        <div className="stack">
          <PanelHead
            title="欢迎回来"
            desc="这里本是清沐方便自己调音、顺手用起来的工作台。把翻调流程里最烦的几件事收在一起：工程格式互转（完全离线）、MV 解析下载、人声分离与音频处理，以及一份随手可查的资源导航。所有转换都在你自己机器上完成，工程不会离开本地。"
          />
          <div className="btn-row">
            <Button variant="primary" icon="play" onClick={() => onNavigate('convert')}>
              开始转换工程
            </Button>
            <Button onClick={() => onNavigate('video')}>解析 MV 链接</Button>
            <Button onClick={() => onNavigate('resources')}>打开资源库</Button>
          </div>
        </div>
      </Panel>

      <Panel>
        <div className="stats-row">
          <Stat label="可用格式" value={available} sub={`共 ${formats.length} 种`} />
          <Stat label="外部工具" value={`${['ffmpeg', 'ytdlp'].filter((k) => state?.tools?.[k]?.available).length} / 2`} />
          <div className="stats-action">
            <Button size="sm" icon="refresh" onClick={redetect}>
              重新检测
            </Button>
          </div>
        </div>
      </Panel>

      {checks.length > 0 && (
        <Panel>
          <PanelHead title="环境就绪度" desc={`${checks.length} 项待处理`} />
          <div className="stack">
            {checks.map((c) => (
              <Finding key={c.id} level={c.level} title={c.title}>
                {c.detail}
              </Finding>
            ))}
          </div>
        </Panel>
      )}

      <Panel>
        <PanelHead title="从这里开始" />
        <div className="quick-grid">
          {QUICK.map((q) => (
            <button key={q.id} type="button" className="quick" onClick={() => onNavigate(q.id)}>
              <span className="quick-title">{q.title}</span>
              <span className="quick-desc">{q.desc}</span>
            </button>
          ))}
        </div>
      </Panel>

      <Panel>
        <PanelHead
          title="外部工具"
          desc="ffmpeg / yt-dlp 随程序分发，不需要联网下载；这里只做检测"
        />
        <div className="tool-list">
          <ToolRow label="ffmpeg" desc="音视频合并、导出 WAV/MP3、变调变速" info={state?.tools?.ffmpeg} onToast={onToast} />
          <ToolRow label="yt-dlp" desc="YouTube 等上千站点的解析与下载" info={state?.tools?.ytdlp} onToast={onToast} />
          <ToolRow label="Python" desc="可选：部分脚本与 yt-dlp 的模块模式" info={state?.tools?.python} onToast={onToast} />
        </div>
      </Panel>

      <FormatPanel formats={formats} />
    </>
  )
}

function ToolRow({
  label,
  desc,
  info,
  onToast,
}: {
  label: string
  desc: string
  info?: ToolInfo
  onToast: (msg: string, tone?: string) => void
}) {
  const ok = !!info?.available
  return (
    <div className="tool-row">
      <div className="tool-row-text">
        <span className="tool-name">{label}</span>
        <span className="tool-desc">{desc}</span>
      </div>
      <span className="tool-version" data-ok={ok ? 'true' : undefined}>
        {ok ? String(info?.version ?? '已就绪').slice(0, 28) : '未找到'}
      </span>
      {ok && info?.path && (
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
}

function FormatPanel({ formats }: { formats: FormatInfo[] }) {
  if (!formats.length) {
    return (
      <Panel>
        <p className="muted">还没有拿到格式表。</p>
      </Panel>
    )
  }
  const groups = new Map<string, FormatInfo[]>()
  for (const f of formats) {
    if (!groups.has(f.group)) groups.set(f.group, [])
    groups.get(f.group)!.push(f)
  }
  return (
    <Panel>
      <PanelHead title="格式支持" desc="带勾的是已就绪，灰的是模块待补齐" />
      <div className="stack-lg">
        {[...groups.entries()].map(([group, list]) => (
          <div key={group} className="stack">
            <span className="group-label">{group}</span>
            <div className="chips">
              {list.map((f) => (
                <Chip
                  key={f.id + f.name}
                  tone={f.available ? 'ok' : 'default'}
                  title={f.available ? (f.fidelity?.notes ?? '') : (f.reason ?? '未实现')}
                >
                  {f.name}
                  <span className="chip-ext">{f.exts.join('/')}</span>
                </Chip>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  )
}
