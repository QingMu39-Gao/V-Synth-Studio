import {useEffect, useState} from 'react'
import {useI18n} from '@/lib/i18n'

import {api} from '@/lib/api'
import type {AppState, ToolInfo} from '@/lib/types'
import type {PageProps, ToastFn} from './types'
import {Button} from '@/components/Button'
import {Finding, Panel, PanelHead, Stat} from '@/components/Panel'

/**
 * 总览：环境检测与常用入口。
 *
 * 卡片按「全局玻璃」开关走：开着时是玻璃面，关掉退回轻量材质（见 `components/Panel.tsx`）。
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
        desc: 'B 站视频解析下载（含大会员画质、弹幕与字幕）；YouTube 等上千个站点',
    },
    {
        id: 'svsep',
        title: '音轨分离',
        desc: '在线 MVSEP（要上传）与本地引擎两条路，拆人声、伴奏、鼓、贝斯等',
    },
    {
        id: 'audio',
        title: '音频工具',
        desc: 'WAV/MP3 导出、裁剪、变调变速、响度标准化',
    },
    {
        id: 'resources',
        title: '资源导航',
        desc: '立绘、免费声库、插件、可下 WAV 的音源站 —— 只存链接，不下载文件',
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

    /* 「整台机器用不了」排在缺工具前面：这一条解释的正是后面那些「找不到 ffmpeg」 ——
       先说清是平台不支持，用户才不会去反复重装。 */
    if (state.platformNote) {
        out.push({
            id: 'platform',
            level: 'warn',
            title: '这个平台上跑不完整',
            detail: state.platformNote,
        })
    }

    if (!tools.ffmpeg?.available) {
        out.push({
            id: 'ffmpeg',
            level: 'warn',
            title: '未找到 ffmpeg',
            detail:
                'MV 下载后无法把视频流和音频流合并成 mp4，也不能导出 WAV/MP3、不能做变调变速。',
        })
    }
    if (!tools.ytdlp?.available) {
        out.push({
            id: 'ytdlp',
            level: 'info',
            title: '未找到 yt-dlp',
            detail: '没有它，YouTube 等上千个站点无法解析（B 站不受影响）。',
        })
    }
    return out
}

/**
 * 两个「扩展包」的安装状态：`null` = 还没问出来后端。
 *
 * ⚠️ 刻意**不问 `get_state`** 里的这两样：它们是各自功能的私有状态，判据以后端自己的话
 * 为准 —— 音轨分离 `runtimeReady && models.ok`、人声转 MIDI `runtime.ready && models.ready`。
 * 所以直接调各自的状态命令，两条互不依赖。
 */
interface Packs {
    svsep: boolean | null
    midi: boolean | null
}

function packStat(v: boolean | null, installed: string, missing: string) {
    if (v === null) return {value: '检测中', sub: '正在读取状态…'}
    return {value: v ? '已安装' : '未安装', sub: v ? installed : missing}
}

export function Dashboard({
                              state,
                              refreshing,
                              onNavigate,
                              onRefreshState,
                              onToast,
                          }: PageProps & {
    /** 后端快照正在重拉 */
    refreshing: boolean
}) {
    const {t} = useI18n()
    const checks = computeChecks(state)
    const [packs, setPacks] = useState<Packs>({svsep: null, midi: null})
    const [checking, setChecking] = useState(false)

    /** 问两个扩展包在不在本地。两条请求各自独立，一条挂了不影响另一条。 */
    const loadPacks = async () => {
        const [sv, md] = await Promise.allSettled([api.svsepStatus(), api.midiStatus()])
        setPacks({
            svsep: sv.status === 'fulfilled' ? !!(sv.value.runtimeReady && sv.value.models?.ok) : null,
            midi: md.status === 'fulfilled' ? !!(md.value.runtime?.ready && md.value.models?.ready) : null,
        })
    }

    useEffect(() => {
        void loadPacks()
        // 只在进页面时问一次：`midi_status` 会触发一次 ORT/CUDA 探测（没 N 卡时要 1 秒多）
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [])

    const redetect = async () => {
        setChecking(true)
        try {
            /* `tools_detect` 回的是 `{tools, editors, formats, summary}`；「几个可用」在
               `summary` 里（ffmpeg / ytdlp / python 三个布尔）—— 旧 HTTP 那条回的是
               `installedCount`，IPC 这一版没有这个字段。 */
            const data = await api.detect()
            const s = (data.summary ?? {}) as { ffmpeg?: boolean; ytdlp?: boolean; python?: boolean }
            const n = [s.ffmpeg, s.ytdlp, s.python].filter(Boolean).length
            await onRefreshState()
            await loadPacks()
            onToast(`检测完成：${n} 个外部程序可用`, 'ok')
        } catch (e) {
            onToast(`检测失败：${e instanceof Error ? e.message : String(e)}`, 'err')
        } finally {
            setChecking(false)
        }
    }

    if (refreshing && !state) {
        return (
            <Panel>
                <p className="muted">
                    正在检查环境…（约 2–3 秒）
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
                        desc="这里是一款专为P主打造的虚拟歌姬工作站，集合了很多便捷功能。"
                    />
                    <div className="btn-row">
                        <Button variant="primary" icon="play" onClick={() => onNavigate('convert')}>
                            开始转换工程
                        </Button>
                        <Button onClick={() => onNavigate('video')}>{t('解析 MV 链接')}</Button>
                        <Button onClick={() => onNavigate('resources')}>{t('打开资源库')}</Button>
                    </div>
                </div>
            </Panel>

            <Panel>
                <div className="stats-row">
                    <Stat
                        label="音轨分离扩展包"
                        {...packStat(
                            packs.svsep,
                            '引擎与模型已就绪',
                            '在「音轨分离」页里下载（约 8 GB）',
                        )}
                    />
                    <Stat
                        label="人声转 MIDI 扩展包"
                        {...packStat(
                            packs.midi,
                            '模型与运行时已就绪',
                            '在「人声转 MIDI」页里下载',
                        )}
                    />
                    <Stat
                        label="外部工具"
                        value={`${['ffmpeg', 'ytdlp'].filter((k) => state?.tools?.[k]?.available).length} / 2`}
                    />
                    <div className="stats-action">
                        <Button size="sm" icon="refresh" loading={checking} onClick={redetect}>
                            重新检测
                        </Button>
                    </div>
                </div>
            </Panel>

            {checks.length > 0 && (
                <Panel>
                    <PanelHead title="环境就绪度" desc={`${checks.length} 项待处理`}/>
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
                <PanelHead title="从这里开始"/>
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
                <PanelHead title="外部工具"/>
                <div className="tool-list">
                    <ToolRow label="ffmpeg" desc="音视频合并、导出 WAV/MP3、变调变速" info={state?.tools?.ffmpeg}
                             onToast={onToast}/>
                    <ToolRow label="yt-dlp" desc="YouTube 等上千站点的解析与下载" info={state?.tools?.ytdlp}
                             onToast={onToast}/>
                    <ToolRow label="Python" desc="可选：部分功能会用到它" info={state?.tools?.python} onToast={onToast}/>
                </div>
            </Panel>
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
    onToast: ToastFn
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
