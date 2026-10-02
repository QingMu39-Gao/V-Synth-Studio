import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, svsepFileUrl, type SvsepOutput, type SvsepStatus, type SvsepTask } from '@/lib/api'
import { Button, IconButton } from '@/components/Button'
import { Icon } from '@/components/Icon'
import { Chip, Finding, Panel, PanelHead, Stat } from '@/components/Panel'
import { formatBytes } from '@/lib/format'
import type { PageProps } from './types'
import './Svsep.css'

/**
 * 音轨分离 —— 在线（MVSEP）与离线（内嵌引擎）两条路。
 *
 * ## 为什么这一页和别页长得不一样
 *
 * 别的页是「调本机的 Rust 后端」，这一页背后是**一个 Python 子进程**
 * （`炽小阳音轨分离站离线版` 的后端，源码在 `app/data/svsep/backend/`，
 * 由 Rust 的 `svsep.rs` 拉起）。这一个事实派生出页面上大部分状态：
 *
 *   * 服务**可以没起**（`running` 假）—— 那就先给一颗「启动服务」，别让用户
 *     点了「开始分离」再看一句 red toast。
 *   * 第一次用**两样都没有**：运行时 4.7 GB（解压 7.4 GB）+ 模型 462 MB
 *     （解压 731 MB），**都不随包发**。所以界面上必须把「要下多少」写清楚 ——
 *     用户看到「下载模型 730 MB」会以为是整个功能只要 730 MB，而真正的大头
 *     是运行时。两样缺哪样就下哪样，缺两样时把总字节数一并说出来。
 *     没有模型时提交任务会白等几十分钟再失败，绝不能画那颗按钮。
 *   * 一次任务**几分钟到几十分钟**（本机纯 CPU：二轨约 8 分钟、六轨约 11 分钟）
 *     —— 所以进度是这一页的主角，`running` 时必须自动轮询。
 *
 * ## 两条轮询，不要合并
 *
 * `/api/svsep/status` 每 2 秒（便宜：读几个文件大小 + 一次 socket 探活），
 * `/api/svsep/backend/status` 每 8 秒（贵：它会去查注册表探 GPU）。
 * App 里显示设备那一条就够用了，没必要为了「实时」把注册表查询打成每秒一次。
 *
 * ## ⚠️ 上游的进度是**估的**，不是真进度
 *
 * `task_manager.py` 里 UVR 按 `elapsed / 240s`、RoFormer 按 `elapsed / 480s`
 * 线性插值（源码 264 / 324 行）。所以它会长时间停在 90% 然后跳到 100%。
 * 界面上**照实显示百分比与那句「已用时 N 秒」**，另外用一句 note 说清
 * 「这个百分比是按时间估的」—— 不然用户会以为卡死了。
 */

/* ══════════════════════════════════════════════════════════ 常量 ══ */

const MVSEP_URL = 'https://mvsep.com/zh'

/** 上游 `config.MAX_CONTENT_LENGTH`，超了它自己会回一句人话 */
const MAX_UPLOAD = 100 * 1024 * 1024

const ENGINES = [
  {
    id: 'roformer' as const,
    name: '六轨（BS-Roformer）',
    desc: '人声 / 鼓 / 贝斯 / 吉他 / 钢琴 / 其它 —— 想做伴奏改编制作用这个',
    cost: '约 11 分钟',
  },
  {
    id: 'uvr' as const,
    name: '二轨（UVR MDX）',
    desc: '人声 / 伴奏 —— 只想把干声抠出来，或者先看看效果',
    cost: '约 8 分钟',
  },
]

/** 这两条是按本机（AMD RX 580，纯 CPU）实测写的；有 CUDA 的机器会快一个数量级 */
const ESTIMATE_NOTE = '按本机纯 CPU 实测估的时长；装了 NVIDIA 显卡会快很多'

/** 轮询间隔（毫秒） */
const POLL_STATUS = 2000
const POLL_BACKEND = 8000

const STEM_LABEL: Record<string, string> = {
  vocals: '人声',
  instrumental: '伴奏',
  drums: '鼓',
  bass: '贝斯',
  guitar: '吉他',
  piano: '钢琴',
  other: '其它',
}

/* ══════════════════════════════════════════════════════════ 小工具 ══ */

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** 从文件名猜一条轨是什么（上游给的是 `(Vocals)_xxx.wav` 这种） */
function stemOf(o: SvsepOutput): string {
  if (o.stem) return o.stem
  const name = o.download_name || o.filename || ''
  const m = name.match(/\(([A-Za-z]+)\)/)
  if (!m) return ''
  const key = m[1].toLowerCase()
  return STEM_LABEL[key] ? key : ''
}

function trackLabel(o: SvsepOutput, i: number): string {
  const stem = stemOf(o)
  return STEM_LABEL[stem] || o.download_name || o.filename || `第 ${i + 1} 轨`
}

/* ════════════════════════════════════════════════════════ 主组件 ══ */

export function Svsep({ onNavigate, onToast }: PageProps) {
  const [st, setSt] = useState<SvsepStatus | null>(null)
  const [backend, setBackend] = useState<Record<string, unknown> | null>(null)
  const [file, setFile] = useState<File | null>(null)
  const [engine, setEngine] = useState<'uvr' | 'roformer'>('roformer')
  const [busy, setBusy] = useState(false)
  const [starting, setStarting] = useState(false)
  const [task, setTask] = useState<SvsepTask | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  /** 拉一次总体状态。失败**不弹 toast**（轮询失败会刷屏），把错误放进 err 显示 */
  const [err, setErr] = useState<string | null>(null)
  const refresh = useCallback(async () => {
    try {
      const s = await api.svsepStatus()
      setSt(s)
      setErr(null)
      return s
    } catch (e) {
      setErr(errText(e))
      return null
    }
  }, [])

  /* ── 轮询：状态 ─────────────────────────────────────── */
  useEffect(() => {
    void refresh()
    const t = setInterval(() => void refresh(), POLL_STATUS)
    return () => clearInterval(t)
  }, [refresh])

  const running = !!st?.running

  /* ── 轮询：分离后端自己的状态（设备 / 队列）───────────── */
  useEffect(() => {
    if (!running) {
      setBackend(null)
      return
    }
    let alive = true
    const tick = async () => {
      try {
        const b = await api.svsepBackendStatus()
        if (alive) setBackend(b)
      } catch {
        /* 服务刚挂掉时这里会失败，状态轮询那边会把它标成 not running，不管 */
      }
    }
    void tick()
    const t = setInterval(() => void tick(), POLL_BACKEND)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [running])

  /* ── 任务轮询：任务没结束就一直问 ───────────────────── */
  const taskId = task?.id
  const settled = !!task && (task.status === 'done' || task.status === 'error' || task.status === 'failed')
  useEffect(() => {
    if (!taskId || settled) return
    let alive = true
    const t = setInterval(async () => {
      try {
        const v = await api.svsepTask(taskId)
        if (!alive) return
        setTask(v)
        if (v.status === 'done') {
          onToast('分离完成', 'ok')
        } else if (v.status === 'error' || v.status === 'failed') {
          onToast(v.error || v.message || '分离失败', 'err')
        }
      } catch (e) {
        if (alive) onToast(errText(e), 'err')
      }
    }, POLL_STATUS)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [taskId, settled, onToast])

  /* ── 两个模型都在？ ─────────────────────────────────── */
  /* ⚠️ `?.` 只能挡到它左边那一层：`st?.models.uvr.state` 在 `models` 存在而
     `models.uvr` 不存在（老版本后端的回包、或者字段改名）时照样抛
     `Cannot read properties of undefined (reading 'state')`。
     抛在这里 = 整棵 React 树卸载（导航也一起消失），下面几页全黑。
     所以每一层都要 `?.`，显示用的地方给兜底值。
     ⚠️ **`models` 是对象、模型列表在 `models.items[]` 里**（`svsep.rs::models_status()`）。
     2026-10-02 这里写成过 `st?.models?.uvr?.state` —— 字段不存在，于是恒为 `false`：
     模型明明在盘上，界面照样说「缺失」并把「下载模型」按钮一直摆着。 */
  const modelItems = st?.models?.items ?? []
  const modelsOk = modelItems.length > 0 && modelItems.every((m) => m.state === 'ok')
  const runtimeReady = !!st?.runtimeReady
  const dl = st?.download
  const dlPct = dl && dl.total > 0 ? Math.min(100, Math.round((dl.done / dl.total) * 100)) : 0

  /* 缺哪样、还要下多少 —— 数字全部来自后端（字节），**不要在界面里硬编码容量** */
  const modelBytes = modelItems.reduce(
    (n, m) => n + (m.state === 'ok' ? 0 : (m.expectedSize || 0)),
    0,
  ) || (st?.models?.expectedBytes || 0)
  const needBytes = (runtimeReady ? 0 : (st?.runtime?.expectedBytes || 0)) + (modelsOk ? 0 : modelBytes)
  /* 压缩包大小（下的是 zip），与解压后的大小是两回事 —— 两个数都给用户看 */
  const DL_RUNTIME_ZIP = '4.7 GB'
  const DL_MODELS_ZIP = '462 MB'

  const inference = (backend?.inference || {}) as Record<string, unknown>
  const acceleration = (backend?.acceleration || {}) as Record<string, unknown>
  const queues = (backend?.queues || {}) as Record<string, { waiting?: number; processing?: number }>
  const badge =
    (typeof backend?.inference_badge === 'string' && backend.inference_badge) ||
    (typeof acceleration.badge === 'string' && acceleration.badge) ||
    (typeof inference.badge === 'string' && inference.badge) ||
    ''

  const outputs = useMemo(() => task?.outputs ?? [], [task])

  /* ── 动作 ───────────────────────────────────────────── */

  const doStart = async () => {
    setStarting(true)
    try {
      await api.svsepStart()
      await refresh()
      onToast('分离服务已启动', 'ok')
    } catch (e) {
      onToast(errText(e), 'err')
    } finally {
      setStarting(false)
    }
  }

  const doStop = async () => {
    try {
      await api.svsepStop()
      await refresh()
      onToast('分离服务已停止', 'info')
    } catch (e) {
      onToast(errText(e), 'err')
    }
  }

  const doDownloadModels = async () => {
    try {
      await api.svsepDownloadModels()
      /* ⚠️ 说的是**压缩包**大小（462 MB），和界面上那个「解压后」的数是两回事。
         之前这里写「约 730 MB」（那是解压后的大小），用户会以为下 730 MB 就够了。 */
      onToast(`开始下载模型（压缩包约 ${DL_MODELS_ZIP}，解压后约 731 MB）`, 'info')
      void refresh()
    } catch (e) {
      onToast(errText(e), 'err')
    }
  }

  const doDownloadRuntime = async () => {
    try {
      await api.svsepDownloadRuntime()
      onToast(`开始下载运行时（压缩包约 ${DL_RUNTIME_ZIP}，解压后约 7.4 GB），会下一阵子`, 'info')
      void refresh()
    } catch (e) {
      onToast(errText(e), 'err')
    }
  }

  const doSeparate = async () => {
    if (!file) {
      onToast('先选一个音频文件', 'warn')
      return
    }
    setBusy(true)
    try {
      /* 服务没起就顺手起一下 —— 后端路由里也做了这件事，这里做是为了
         「启动中…」这段等待有反馈（起 Python 要十几秒） */
      if (!running) {
        onToast('分离服务还没起，先启动它…', 'info')
        await api.svsepStart()
        await refresh()
      }
      const res = await api.svsepSeparate(engine, file)
      setTask(res.task ?? null)
      onToast('已提交，开始分离', 'ok')
    } catch (e) {
      onToast(errText(e), 'err')
    } finally {
      setBusy(false)
    }
  }

  const doCancel = async () => {
    if (!task) return
    try {
      await api.svsepCancel(task.id)
      onToast('已请求取消', 'info')
    } catch (e) {
      onToast(errText(e), 'err')
    }
  }

  const previewOne = (i: number) => {
    if (!task) return
    const el = audioRef.current
    if (!el) return
    const url = svsepFileUrl(task.id, i, true)
    setPreviewIdx(i)
    /* 换 source 后要显式 load，不然改了 src 的播放器不会自己重载 */
    el.src = url
    el.load()
    void el.play().catch(() => {
      /* 浏览器可能因为没交互过而拒绝自动播放，用户自己点播放键就行 */
    })
  }

  const [previewIdx, setPreviewIdx] = useState<number | null>(null)
  const audioRef = useRef<HTMLAudioElement>(null)

  /* ── 渲染 ───────────────────────────────────────────── */

  return (
    <div className="page-body svsep-layout">
      {/* ══════════════ 左栏：素材 + 模式 ══════════════ */}
      <div className="svsep-col">
        <Panel>
          <PanelHead
            title="音频素材"
            desc="选一个本地音频，上传给分离引擎"
            extra={file ? <Chip tone="ok">已选</Chip> : <Chip>未选</Chip>}
          />
          <input
            ref={fileRef}
            type="file"
            accept=".mp3,.wav,.flac,.m4a,.aac,.ogg,.wma,audio/*"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0] ?? null
              setFile(f)
              setTask(null)
              setPreviewIdx(null)
              e.target.value = ''
            }}
          />
          <button type="button" className="svsep-drop" onClick={() => fileRef.current?.click()}>
            <Icon name="upload" size={22} />
            <span className="svsep-drop-name">{file ? file.name : '点这里选一个音频文件'}</span>
            <span className="svsep-drop-meta">
              {file ? formatBytes(file.size) : 'mp3 / wav / flac / m4a / aac / ogg / wma'}
            </span>
          </button>
          {file && (
            <div className="btn-row">
              <Button size="sm" variant="ghost" onClick={() => fileRef.current?.click()}>
                换一个
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setFile(null)
                  setTask(null)
                }}
              >
                清空
              </Button>
            </div>
          )}
          <p className="hint">
            上限 {formatBytes(MAX_UPLOAD)}。超过就先在「音频工具」里裁一段或转成 mp3 ——
            多出来的长度对分离结果没有帮助。
          </p>
        </Panel>

        <Panel>
          <PanelHead title="分离模式" desc="两种引擎模型不同，产出也不同" />
          <div className="choice-grid">
            {ENGINES.map((e) => (
              <button
                key={e.id}
                type="button"
                className="choice"
                aria-pressed={engine === e.id}
                onClick={() => setEngine(e.id)}
              >
                <span className="choice-head">
                  <span className="choice-label">{e.name}</span>
                  {engine === e.id && <Chip tone="accent">已选</Chip>}
                </span>
                <span className="choice-desc">{e.desc}</span>
                <span className="svsep-cost">{e.cost}</span>
              </button>
            ))}
          </div>
          <p className="hint">{ESTIMATE_NOTE}。</p>

          <div className="btn-row">
            <Button
              variant="primary"
              icon="play"
              loading={busy}
              disabled={!file || !modelsOk || !runtimeReady}
              onClick={() => void doSeparate()}
            >
              开始分离
            </Button>
            {task && !settled && (
              <Button variant="ghost" icon="x" onClick={() => void doCancel()}>
                取消
              </Button>
            )}
          </div>
          {!runtimeReady && st && (
            <Finding level="warn" title="分离引擎还没装">
              运行时（Python + torch + 后端程序）与模型都不随程序分发，要下两次：
              运行时压缩包约 {DL_RUNTIME_ZIP}、解压后 7.4 GB
              {!modelsOk && <>，模型压缩包约 {DL_MODELS_ZIP}、解压后 731 MB</>}。
              {needBytes > 0 && (
                <>
                  {' '}
                  这次总共还要下 <strong>约 {formatBytes(needBytes)}</strong>。
                </>
              )}
              到右边「离线引擎」那张卡上点对应的按钮，下完会自动解压到 <code>{st.dir}</code>，
              不用手动放。**只需要下一次**（之后升级工作站不用再下）。
              {!st.runtime?.downloadUrl && (
                <>
                  {' '}
                  ⚠️ 现在还没有配置下载地址（<code>svsep.rs</code> 里的 <code>RUNTIME_URL</code> 是空的），
                  点了会明确报一句「还没配置下载地址」。
                </>
              )}
            </Finding>
          )}
          {runtimeReady && !modelsOk && (
            <Finding level="warn" title="还没有模型，先下载">
              模型单独打包：压缩包约 {DL_MODELS_ZIP}、解压后 731 MB（六轨那个 BS-RoFormer
              自己就 667 MB，二轨的 UVR 只有 64 MB）。到右边「离线引擎」那张卡上点「下载模型」，
              下完会自动解压，不用手动放。**只需要下一次**。
              {!st.models?.downloadUrl && (
                <>
                  {' '}
                  ⚠️ 现在还没有配置下载地址（<code>svsep.rs</code> 里的 <code>MODEL_URL</code> 是空的）。
                </>
              )}
            </Finding>
          )}
        </Panel>

        <Panel>
          <PanelHead title="分离完做什么" desc="结果能直接拿回工作站继续用" />
          <ol className="svsep-steps">
            <li>在右边试听每一轨，确认分得干净。</li>
            <li>
              「下载」会把 WAV 存到浏览器的下载目录；文件其实一直在本机分离引擎的输出目录里，
              点「打开输出目录」就能看到。
            </li>
            <li>
              要变调、变速、转格式，把它带回
              <button type="button" className="svsep-link" onClick={() => onNavigate('audio')}>
                音频工具
              </button>
              。
            </li>
            <li>
              歌词要对轨、做动态歌词视频，去
              <button type="button" className="svsep-link" onClick={() => onNavigate('lyrics')}>
                网易云专栏
              </button>
              与
              <button type="button" className="svsep-link" onClick={() => onNavigate('pv')}>
                文字 PV
              </button>
              。
            </li>
          </ol>
        </Panel>
      </div>

      {/* ══════════════ 右栏：状态 + 任务 + 在线 ══════════════ */}
      <div className="svsep-col">
        <Panel>
          <PanelHead
            title="离线引擎"
            desc="在你自己电脑上跑，音频不出本机"
            extra={
              running ? <Chip tone="ok">运行中</Chip> : <Chip tone="warn">未启动</Chip>
            }
          />
          <div className="svsep-stats">
            <Stat label="服务" value={running ? `端口 ${st?.port ?? '—'}` : '未启动'} />
            <Stat
              label="运行时"
              value={runtimeReady ? '就绪' : '缺失'}
              /* ⚠️ `expectedBytes` 是**解压后**的容量（7.4 GB），要下的是 4.7 GB 的压缩包。
                 缺的时候两个数都给，不然用户会以为要下 7.4 GB。 */
              sub={runtimeReady ? undefined : `下 ${DL_RUNTIME_ZIP} · 解压 ${formatBytes(st?.runtime?.expectedBytes ?? 0)}`}
            />
            <Stat
              label="模型"
              value={modelsOk ? '就绪' : '缺失'}
              sub={
                modelsOk
                  ? modelItems.map((m) => formatBytes(m.size)).join(' + ')
                  : `下 ${DL_MODELS_ZIP} · 解压 ${formatBytes(modelBytes)}`
              }
            />
            {badge && <Stat label="设备" value={badge} />}
          </div>

          {dl?.active && (
            <div className="svsep-progress">
              <div className="svsep-progress-head">
                <span>{dl.kind === 'runtime' ? '正在下载运行时…' : '正在下载模型…'}</span>
                <span className="svsep-dim">
                  {formatBytes(dl.done)}
                  {dl.total > 0 ? ` / ${formatBytes(dl.total)}` : ''}
                </span>
              </div>
              <div
                className="svsep-bar"
                role="progressbar"
                aria-valuenow={dl.total > 0 ? dlPct : undefined}
                aria-valuemin={0}
                aria-valuemax={100}
              >
                <span
                  className={dl.total > 0 ? 'svsep-bar-fill' : 'svsep-bar-fill svsep-bar-unknown'}
                  style={dl.total > 0 ? { width: `${dlPct}%` } : undefined}
                />
              </div>
              {dl.kind === 'runtime' && (
                <p className="hint">
                  这一包几 GB，下完还要解压两万多个文件，可能要几十分钟 ——
                  下的时候可以让它自己跑，别关工作站。
                </p>
              )}
            </div>
          )}
          {dl?.error && (
            <Finding level="warn" title="上次下载没成功">
              {dl.error}
            </Finding>
          )}

          <div className="btn-row">
            {!running ? (
              <Button variant="primary" icon="zap" loading={starting} disabled={!runtimeReady} onClick={() => void doStart()}>
                启动服务
              </Button>
            ) : (
              <Button icon="pause" onClick={() => void doStop()}>
                停止服务
              </Button>
            )}
            {!runtimeReady && (
              <Button
                icon="download"
                disabled={!!dl?.active}
                onClick={() => void doDownloadRuntime()}
              >
                {dl?.active && dl.kind === 'runtime' ? '下载中…' : '下载运行时'}
              </Button>
            )}
            {runtimeReady && !modelsOk && (
              <Button
                icon="download"
                disabled={!!dl?.active}
                onClick={() => void doDownloadModels()}
              >
                {dl?.active && dl.kind === 'models' ? '下载中…' : '下载模型'}
              </Button>
            )}
            <Button variant="ghost" icon="folder" onClick={() => void api.fsOpen({ path: st?.dataDir })}>
              输出目录
            </Button>
          </div>
          <p className="hint">
            服务只在需要时跑，用完点「停止服务」把内存还回来（它会占约 5 GB）。
            关闭工作站时会自动停掉。
          </p>
          {st?.lastError && (
            <Finding level="warn" title="上次启动失败">
              {st.lastError}
            </Finding>
          )}
          {err && (
            <Finding level="warn" title="读不到分离状态">
              {err}
            </Finding>
          )}
        </Panel>

        <Panel>
          <PanelHead
            title="分离进度"
            desc="提交后会自动刷新"
            extra={
              task ? (
                <Chip tone={settled ? (task.status === 'done' ? 'ok' : 'err') : 'accent'}>
                  {task.status === 'done' ? '完成' : settled ? '失败' : '进行中'}
                </Chip>
              ) : (
                <Chip>待提交</Chip>
              )
            }
          />
          {!task ? (
            <p className="empty">左边选好文件与模式，点「开始分离」。</p>
          ) : (
            <>
              <div className="svsep-progress">
                <div className="svsep-progress-head">
                  <span>{task.message || '处理中…'}</span>
                  <span className="svsep-dim">{Math.round(task.progress || 0)}%</span>
                </div>
                <div
                  className="svsep-bar"
                  role="progressbar"
                  aria-valuenow={Math.round(task.progress || 0)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                >
                  <span className="svsep-bar-fill" style={{ width: `${Math.min(100, task.progress || 0)}%` }} />
                </div>
              </div>
              {!settled && (
                <p className="hint">
                  这个百分比是引擎按时间估的，不是真进度 —— 会长时间停在 90% 再跳到 100%，
                  看到不动不用重试。图上那句「已用时 N 秒」才是真信息。
                </p>
              )}
              {task.error && <Finding level="warn" title="分离失败">{task.error}</Finding>}

              {outputs.length > 0 && (
                <>
                  <audio ref={audioRef} className="svsep-audio" controls />
                  <ul className="svsep-tracks">
                    {outputs.map((o, i) => (
                      <li key={o.filename || i} className="svsep-track">
                        <span className="svsep-track-name">{trackLabel(o, i)}</span>
                        {typeof o.size === 'number' && o.size > 0 && (
                          <span className="svsep-dim">{formatBytes(o.size)}</span>
                        )}
                        <span className="spacer" />
                        <IconButton
                          label={`试听${trackLabel(o, i)}`}
                          icon="play"
                          size="sm"
                          variant={previewIdx === i ? 'primary' : 'default'}
                          onClick={() => previewOne(i)}
                        />
                        <a
                          className="svsep-dl"
                          href={svsepFileUrl(task.id, i)}
                          download={o.download_name || o.filename}
                        >
                          <Icon name="download" size={14} />
                          下载
                        </a>
                      </li>
                    ))}
                  </ul>
                  <div className="btn-row">
                    <Button size="sm" icon="folder" onClick={() => void api.svsepOpenOutput()}>
                      打开输出目录
                    </Button>
                  </div>
                </>
              )}
            </>
          )}
        </Panel>

        <Panel>
          <PanelHead
            title="在线分离：MVSEP"
            desc="效果最好的一档，代价是音频要传到别人的服务器"
            extra={<Chip tone="warn">需上传</Chip>}
          />
          <Finding level="warn" title="隐私提示">
            MVSEP 在云端跑模型，你上传的音频会离开这台电脑。介意的话用左边的离线引擎 ——
            它拿本机 CPU / 显卡算，一个字节都不外发。
          </Finding>
          <p className="svsep-url">{MVSEP_URL}</p>
          <div className="btn-row">
            <Button icon="external" onClick={() => void api.fsOpen({ url: MVSEP_URL })}>
              打开 MVSEP
            </Button>
          </div>
          <p className="hint">
            在系统浏览器里打开（不是站内窗口），因为 MVSEP 要你登录才能下结果。
            下载回来的音频可以直接拖进左边当素材，也可以拿回「音频工具」处理。
          </p>
        </Panel>

        {queues && (queues.uvr || queues.roformer) && (
          <Panel>
            <PanelHead title="引擎队列" desc="本地任务是串行的，一次只跑一个" />
            <div className="svsep-stats">
              <Stat
                label="二轨（UVR）"
                value={`排队 ${queues.uvr?.waiting ?? 0}`}
                sub={`在跑 ${queues.uvr?.processing ?? 0}`}
              />
              <Stat
                label="六轨（RoFormer）"
                value={`排队 ${queues.roformer?.waiting ?? 0}`}
                sub={`在跑 ${queues.roformer?.processing ?? 0}`}
              />
            </div>
          </Panel>
        )}
      </div>
    </div>
  )
}
