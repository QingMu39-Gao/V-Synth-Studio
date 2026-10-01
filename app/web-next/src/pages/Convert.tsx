import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  GlassDialog,
  GlassSwitch,
  List,
  ListRow,
  ListSection,
  PathBar,
} from '@ttqtt/liquid-glass-react'
import { api, type Finding as ApiFinding, type FsEntry } from '@/lib/api'
import { Button, IconButton } from '@/components/Button'
import { DirectoryInput } from '@/components/DirPicker'
import { Field, TextInput } from '@/components/Field'
import { Icon } from '@/components/Icon'
import { JobProgress } from '@/components/Job'
import { Chip, Finding, Panel, PanelHead } from '@/components/Panel'
import { formatBytes } from '@/lib/format'
import { useJob } from '@/lib/useJob'
import type { FormatInfo } from '@/lib/types'
import type { PageProps } from './types'
import './Convert.css'

/**
 * 工程格式互转（40 种）—— 旧前端 `app/web/js/views/convert.js` 的搬家版。
 *
 * ## 只按本地路径走
 *
 * 旧页面有两条来源：**浏览器拖进来 / 选文件（读字节 → base64 上传）** 和 **从目录收集（服务端直接读路径）**。
 * 这一版只保留了后者那种「按路径」的做法 —— 理由三条，都不是省事：
 *
 *   1. 桌面程序本来就能直接读本机路径，用户从资源管理器拖进来再转成 base64，纯属绕路；
 *   2. 后端自己就在劝用户走路径（`convert.rs`：超过 80MB 回「请改用『从目录收集』直接读本地路径」）；
 *   3. 上传那两条路由（`/api/convert/run-upload`、`/preview-upload`）连 `lib/api.ts` 都没包，
 *      搬过来要连着改公共库。
 *
 * 拖拽（`dragover`/`drop`）也就跟着没了 —— 浏览器拖进来拿到的是 `File`（没有本地路径），
 * 留着只能走上传链路。
 *
 * ## 预检是这个页面的价值所在
 *
 * 转换前一定先跑 `api.preview({ inputs, toFormat })` 拿到 findings（info / warn / err），
 * 配合 `api.inspect({ inputPath })` 的轨道 / 音符数，先告诉用户「目标格式装不下哪些数据」。
 * 后端**只分析 `inputs[0]`**，所以批量要逐个文件调（旧页面也是这么干的，同样只取前 12 个）。
 */
export function Convert({ state, onToast }: PageProps) {
  const formats = useMemo(() => state?.formats ?? [], [state])
  const cfg = state?.config as Record<string, unknown> | undefined
  const defaultOutDir = state?.paths?.outputDir ?? ''
  const cfgTarget = String(cfg?.defaultTargetFormat ?? '')

  /** 本机文件选择器的过滤器：所有工程格式的扩展名（不带点） */
  const projectExts = useMemo(
    () => [
      ...new Set(
        formats.flatMap((f) => f.exts ?? []).map((e) => String(e).replace(/^\./, '').toLowerCase()),
      ),
    ],
    [formats],
  )
  /** 能当目标的格式：模块就绪、且写得出来 */
  const writable = useMemo(
    () => formats.filter((f) => f.available && f.canWrite !== false),
    [formats],
  )
  const availableCount = formats.filter((f) => f.available).length

  const [sources, setSources] = useState<Source[]>([])
  const [target, setTarget] = useState('')
  const [outDir, setOutDir] = useState('')
  const [nameTemplate, setNameTemplate] = useState('{name}_converted')
  const [overwrite, setOverwrite] = useState(false)
  const [srcDir, setSrcDir] = useState('')
  const [collecting, setCollecting] = useState(false)
  const [picking, setPicking] = useState(false)
  const [reports, setReports] = useState<PreviewReport[]>([])
  const [previewErr, setPreviewErr] = useState<string | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const { job, start, stop } = useJob()

  /* 首屏那次 /api/state 到了之后灌一次默认值（只灌一次，之后归用户） */
  const seeded = useRef(false)
  useEffect(() => {
    if (seeded.current || !state) return
    seeded.current = true
    const tpl = String(cfg?.nameTemplate ?? '').trim()
    if (tpl) setNameTemplate(tpl)
    if (defaultOutDir) setOutDir(defaultOutDir)
  }, [state, cfg, defaultOutDir])

  /* 目标格式：用户选过的留着；否则用设置里的默认格式；再退回第一个可写格式 */
  useEffect(() => {
    if (!writable.length) return
    setTarget((cur) => {
      if (writable.some((f) => f.id === cur)) return cur
      if (cfgTarget && writable.some((f) => f.id === cfgTarget)) return cfgTarget
      return writable[0].id
    })
  }, [writable, cfgTarget])

  const effectiveOutDir = outDir.trim() || defaultOutDir
  const targetName = formats.find((f) => f.id === target)?.name ?? target
  const running = job?.status === 'running'

  /* ── 来源 ─────────────────────────────────────────────── */

  const addPaths = (paths: Source[]) => {
    setSources((prev) => {
      const out = [...prev]
      for (const s of paths) if (!out.some((x) => x.path === s.path)) out.push(s)
      return out
    })
  }

  const pickFile = (path: string) => {
    if (sources.some((s) => s.path === path)) {
      onToast('这个文件已经在列表里了', 'warn')
      return
    }
    addPaths([{ path }])
    onToast(`已加入 ${baseName(path)}`, 'ok')
  }

  const collect = async () => {
    const dir = srcDir.trim()
    if (!dir) {
      onToast('请先选择要扫描的目录', 'warn')
      return
    }
    setCollecting(true)
    try {
      const { files } = await api.collect(dir)
      const list = (files ?? []).map((p) => ({ path: p }))
      if (!list.length) {
        onToast('该目录下没有找到可识别的工程文件', 'warn')
        return
      }
      addPaths(list)
      onToast(`找到 ${list.length} 个工程文件`, 'ok')
    } catch (e) {
      onToast(`扫描失败：${errText(e)}`, 'err')
    } finally {
      setCollecting(false)
    }
  }

  const clear = () => {
    setSources([])
    setReports([])
    setPreviewErr(null)
    stop()
  }

  /* ── 预检 ─────────────────────────────────────────────── */

  /** 每次预检发一个序号下去，回来时对不上就丢掉（防止慢的那次盖掉新的） */
  const seq = useRef(0)

  const runPreview = useCallback(
    async (announce: boolean) => {
      if (!sources.length) {
        if (announce) onToast('请先添加文件', 'warn')
        return
      }
      if (!target) {
        if (announce) onToast('请选择目标格式', 'warn')
        return
      }
      const mine = ++seq.current
      const list = sources.slice(0, PREVIEW_LIMIT)
      setPreviewing(true)
      setPreviewErr(null)
      const out: PreviewReport[] = []
      for (const s of list) {
        try {
          const [info, pre] = await Promise.all([
            api.inspect({ inputPath: s.path }),
            api.preview({ inputs: [s.path], toFormat: target }),
          ])
          out.push({
            path: s.path,
            name: baseName(s.path),
            tracks: info.stats?.trackCount,
            notes: info.stats?.noteCount,
            findings: pre.findings ?? [],
          })
        } catch (e) {
          /* 单个文件读不了不该让整批预检断掉 —— 记在它自己那一行上 */
          out.push({
            path: s.path,
            name: baseName(s.path),
            findings: [],
            error: errText(e),
          })
        }
      }
      if (mine !== seq.current) return
      setReports(out)
      setPreviewing(false)
      if (announce) {
        const bad = out.filter((r) => r.error).length
        onToast(bad ? `预检完成，${bad} 个文件读不了` : '预检完成', bad ? 'warn' : 'ok')
      }
      if (sources.length > PREVIEW_LIMIT) {
        onToast(`只预检了前 ${PREVIEW_LIMIT} 个文件（共 ${sources.length} 个）`, 'warn')
      }
    },
    [sources, target, onToast],
  )

  /* 只有一个源文件时自动预检（换目标格式也跟着重跑）—— 旧页面就是这个行为 */
  useEffect(() => {
    if (sources.length !== 1 || !target) return
    void runPreview(false).catch((e: unknown) => setPreviewErr(errText(e)))
  }, [sources, target, runPreview])

  /* ── 执行 ─────────────────────────────────────────────── */

  const run = async () => {
    if (!sources.length) {
      onToast('请先添加要转换的文件', 'warn')
      return
    }
    if (!target) {
      onToast('请选择目标格式', 'warn')
      return
    }
    if (!effectiveOutDir) {
      onToast('请选择输出目录', 'warn')
      return
    }
    try {
      const { jobId } = await api.convert({
        inputs: sources.map((s) => s.path),
        toFormat: target,
        outDir: effectiveOutDir,
        nameTemplate: nameTemplate.trim() || '{name}_converted',
        overwrite,
      })
      start(jobId, {
        onDone: (j) => onToast(j.message ?? `转换完成，写出到 ${effectiveOutDir}`, 'ok'),
        onError: (err) => onToast(`转换失败：${err.message}`, 'err'),
        onCancel: () => onToast('已取消转换', 'warn'),
      })
    } catch (e) {
      onToast(`转换失败：${errText(e)}`, 'err')
    }
  }

  const reveal = (path: string, select: boolean) =>
    api.fsReveal(path, select).catch((e: unknown) => onToast(errText(e), 'err'))

  const warnCount = reports
    .flatMap((r) => r.findings)
    .filter((f) => f.level !== 'info').length
  const okReports = reports.filter((r) => !r.error).length

  const groups = useMemo(() => {
    const map = new Map<string, FormatInfo[]>()
    for (const f of formats) {
      if (!map.has(f.group)) map.set(f.group, [])
      map.get(f.group)!.push(f)
    }
    return [...map.entries()]
  }, [formats])

  return (
    <div className="convert-layout">
      {/* ══════════════════════ 左：来源 + 目标 ══════════════════════ */}
      <div className="convert-col">
        <Panel>
          <PanelHead
            title="来源工程"
            desc="在本机挑文件，或从目录批量收集；工程只在本机读，不联网、不上传"
            extra={<Chip>{availableCount} 种格式可用</Chip>}
          />
          <div className="stack">
            <div className="btn-row">
              <Button icon="file" onClick={() => setPicking(true)}>
                浏览本机文件
              </Button>
              <Button variant="ghost" icon="trash" disabled={!sources.length} onClick={clear}>
                清空
              </Button>
            </div>

            <Field
              label="从目录批量收集"
              hint="递归扫描子目录，只收已知的工程格式（最深 6 层、最多 5000 个）"
            >
              <DirectoryInput
                value={srcDir}
                onChange={setSrcDir}
                placeholder="选择或粘贴要扫描的目录…"
              />
            </Field>
            <div className="btn-row">
              <Button size="sm" loading={collecting} onClick={() => void collect()}>
                扫描并加入
              </Button>
            </div>

            <div className="convert-sources">
              {sources.length === 0 ? (
                <div className="convert-empty">还没有添加文件</div>
              ) : (
                sources.map((s) => (
                  <div className="convert-source" key={s.path}>
                    <Icon name="file" size={14} />
                    <span className="convert-source-name" title={s.path}>
                      {baseName(s.path)}
                    </span>
                    <span className="convert-source-ext">{extOf(s.path) || '?'}</span>
                    {s.size ? (
                      <span className="convert-source-size">{formatBytes(s.size)}</span>
                    ) : null}
                    <IconButton
                      label={`在资源管理器中显示 ${baseName(s.path)}`}
                      icon="folder"
                      size="sm"
                      variant="ghost"
                      onClick={() => void reveal(s.path, true)}
                    />
                    <IconButton
                      label={`从列表移除 ${baseName(s.path)}`}
                      icon="x"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setSources((prev) => prev.filter((x) => x.path !== s.path))
                        setReports([])
                      }}
                    />
                  </div>
                ))
              )}
            </div>
          </div>
        </Panel>

        <Panel>
          <PanelHead title="目标格式" desc="转换后要拿去哪个编辑器继续做" />
          {groups.length === 0 ? (
            <p className="muted">还没有拿到格式表。</p>
          ) : (
            <div className="convert-formats">
              {groups.map(([group, list]) => (
                <div key={group} className="convert-format-group">
                  <span className="group-label">{group}</span>
                  <div className="convert-format-grid">
                    {list.map((f) => {
                      const usable = f.available && f.canWrite !== false
                      const meta = usable ? f.exts.join(' / ') : (f.reason ?? '暂不可用')
                      return (
                        <button
                          key={f.id}
                          type="button"
                          className="convert-format"
                          data-selected={f.id === target ? 'true' : undefined}
                          disabled={!usable}
                          title={usable ? (f.fidelity?.notes ?? f.name) : meta}
                          onClick={() => setTarget(f.id)}
                        >
                          <span className="convert-format-name">{f.name}</span>
                          <span className="convert-format-meta">{meta}</span>
                          {!usable && f.reason ? (
                            <span className="convert-format-reason">{f.reason}</span>
                          ) : null}
                        </button>
                      )
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </div>

      {/* ══════════════════════ 右：输出 + 预检 + 执行 ══════════════════════ */}
      <div className="convert-col">
        <Panel>
          <PanelHead title="输出设置" desc="结果存到哪里、叫什么名字" />
          <div className="stack">
            <Field
              label="输出目录"
              hint={
                outDir.trim() && outDir.trim() !== defaultOutDir
                  ? `已覆盖设置里的默认目录；本次将输出到：${effectiveOutDir}`
                  : `留空 = 用设置里的默认输出目录：${defaultOutDir || '（未设置）'}`
              }
            >
              <DirectoryInput
                value={outDir}
                onChange={setOutDir}
                placeholder="留空 = 用设置里的默认输出目录…"
              />
            </Field>
            {outDir.trim() && outDir.trim() !== defaultOutDir ? (
              <div className="btn-row">
                <Button size="sm" variant="ghost" onClick={() => setOutDir(defaultOutDir)}>
                  恢复默认目录
                </Button>
              </div>
            ) : null}

            <Field
              label="文件名模板"
              hint="可用变量：{name} 原文件名（后端目前只认这一个；{format} / {index} / {track} / {date} 填了会原样留在文件名里）"
            >
              <TextInput
                value={nameTemplate}
                placeholder="{name}_converted"
                onChange={(e) => setNameTemplate(e.target.value)}
              />
            </Field>

            <div className="convert-switch-row">
              <div className="convert-switch-text">
                <span className="convert-switch-label">覆盖同名文件</span>
                <span className="convert-switch-desc">
                  关闭时会自动加 (2) 后缀，避免覆盖
                </span>
              </div>
              <GlassSwitch
                aria-label="覆盖同名文件"
                checked={overwrite}
                onCheckedChange={setOverwrite}
              />
            </div>

            <p className="hint">
              转调、歌词改写、节奏量化这些后期处理（旧页面的「转换处理」一组）没有搬过来：
              后台的转换引擎现在完全不读 options，参数发过去会被丢掉。等它接上再补。
            </p>
          </div>
        </Panel>

        <Panel>
          <PanelHead
            title="转换预检"
            desc="转换前先告诉你哪些数据会丢"
            extra={previewing ? <Chip>预检中…</Chip> : null}
          />
          <div className="stack">
            {previewErr ? (
              <Finding level="warn" title="预检失败">
                {previewErr}
              </Finding>
            ) : null}

            {reports.length === 0 && !previewErr ? (
              <p className="muted">
                {sources.length === 0
                  ? '先挑一个源工程，这里会报出目标格式装不下哪些数据。'
                  : `正在等目标格式…（多个文件时只预检前 ${PREVIEW_LIMIT} 个）`}
              </p>
            ) : null}

            {reports.length > 0 ? (
              okReports === 0 ? (
                <Finding level="warn" title="这批文件都读不了">
                  下面每一行都写了原因；工程读不出来通常意味着文件损坏，或不是该扩展名对应的格式。
                </Finding>
              ) : warnCount > 0 ? (
                <Finding level="warn" title="目标格式装不下下列数据，转换后会丢失：">
                  {`发现 ${warnCount} 项失配`}
                </Finding>
              ) : (
                <Finding level="info" title="预检通过">
                  没有发现数据失配，可以放心转换。
                </Finding>
              )
            ) : null}

            {reports.map((r) => (
              <div className="convert-report" key={r.path}>
                <div className="convert-report-head">
                  <span className="convert-report-name" title={r.path}>
                    {r.name}
                  </span>
                  <Chip title={`${sourceNameOf(formats, r.path)} → ${targetName}`}>
                    {`${sourceNameOf(formats, r.path)} → ${targetName}`}
                  </Chip>
                  {r.tracks !== undefined ? (
                    <Chip>{`${r.tracks ?? 0} 轨 / ${r.notes ?? 0} 音符`}</Chip>
                  ) : null}
                  {r.error ? <Chip tone="err">读取失败</Chip> : null}
                </div>
                {r.error ? (
                  <Finding level="warn" title="预检失败">
                    {r.error}
                  </Finding>
                ) : (
                  <div className="convert-findings">
                    {/* 库的 Finding 只有 warn / info 两档，err 的照 warn 显示（消息原文不动） */}
                    {r.findings.map((f, i) => (
                      <Finding
                        key={`${r.path}-${i}`}
                        level={f.level === 'info' ? 'info' : 'warn'}
                        title={f.level === 'err' ? '读取失败' : f.level === 'warn' ? '数据失配' : '源工程'}
                      >
                        {f.message}
                      </Finding>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Panel>

        <Panel>
          <div className="convert-run">
            <div className="btn-row">
              <Button variant="primary" size="lg" icon="zap" loading={running} onClick={() => void run()}>
                开始转换
              </Button>
              <Button
                size="lg"
                icon="shield"
                loading={previewing}
                onClick={() => void runPreview(true)}
              >
                预检所选文件
              </Button>
            </div>
            <p className="hint convert-note">全部处理在本机完成，不联网、不上传</p>
          </div>

          <JobProgress
            job={job}
            title="转换进度"
            onCancel={(id) => void api.cancelJob(id).catch((e: unknown) => onToast(errText(e), 'err'))}
          />

          {job && job.status !== 'running' && job.status !== 'canceled' ? (
            <div className="convert-result">
              <div className="btn-row">
                <Button icon="folder" onClick={() => void reveal(effectiveOutDir, false)}>
                  打开输出目录
                </Button>
              </div>
              <p className="hint">
                输出目录：{effectiveOutDir}
                <br />
                后台只回任务日志、不回逐文件的输出清单，所以这里没有旧页面那张「文件 / 轨 / 音符 /
                大小」的表；每个文件写出了什么、多大，都记在上面的日志里。
              </p>
            </div>
          ) : null}
        </Panel>
      </div>

      <FilePicker
        open={picking}
        onOpenChange={setPicking}
        exts={projectExts}
        onPick={pickFile}
      />
    </div>
  )
}

/* ══════════════════════════════════════════════════════ 本机文件选择器 ══ */

/**
 * 按路径挑工程文件 —— 旧页面的 `pickDirectory({ mode: 'file' })`。
 *
 * `components/DirPicker.tsx` 只选目录（后端 `files=0`），所以这里用同一套库组件
 * （`GlassDialog` + `PathBar` + `List`）再拼一个选文件的：`api.fsList(dir, { files: true, exts })`。
 * 样式复用 `index.css` 里那组 `.dir-*`（目录选择器已经在用的类），不再另写一套。
 */
function FilePicker({
  open,
  onOpenChange,
  onPick,
  exts,
  title = '选择工程文件',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (path: string) => void
  /** 扩展名过滤器（不带点）；空数组 = 不过滤 */
  exts: string[]
  title?: string
}) {
  const [cwd, setCwd] = useState('')
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [roots, setRoots] = useState<{ name: string; path: string }[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(
    async (path: string) => {
      setBusy(true)
      setErr(null)
      try {
        const data = await api.fsList(path, { files: true, exts })
        setCwd(data.path)
        setEntries(data.entries)
      } catch (e) {
        setErr(errText(e))
      } finally {
        setBusy(false)
      }
    },
    [exts],
  )

  useEffect(() => {
    if (!open) return
    api
      .fsRoots()
      .then((d) => {
        setRoots(d.roots)
        void load('')
      })
      .catch((e: unknown) => setErr(errText(e)))
  }, [open, load])

  const segments = cwd
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .filter(Boolean)
  const dirs = entries.filter((e) => e.dir)
  const files = entries.filter((e) => !e.dir)

  return (
    <GlassDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      description="点进子目录，然后点一个工程文件"
      className="dir-dialog"
    >
      <div className="dir-body">
        <PathBar
          aria-label="所在路径"
          items={[
            { key: 'root', label: '此电脑', onSelect: () => void load('') },
            ...segments.map((seg, i) => ({
              key: seg + i,
              label: seg,
              /* 最后一级不给 onSelect —— 当前项不是链接（和 DirPicker 同一条规矩） */
              onSelect:
                i === segments.length - 1
                  ? undefined
                  : () => void load(segments.slice(0, i + 1).join('\\')),
            })),
          ]}
        />

        {roots.length > 0 && (
          <List className="dir-roots">
            {roots.map((r) => (
              <ListRow
                key={r.path}
                label={r.name}
                secondaryLabel={r.path}
                onSelect={() => void load(r.path)}
              />
            ))}
          </List>
        )}

        <List>
          <ListSection header={busy ? '读取中…' : `${dirs.length} 个子目录`}>
            {dirs.map((e) => (
              <ListRow key={e.path} label={e.name} disclosure onSelect={() => void load(e.path)} />
            ))}
            {!busy && dirs.length === 0 && <ListRow label="（没有子目录）" disabled />}
          </ListSection>
          <ListSection header={`${files.length} 个工程文件`}>
            {files.map((e) => (
              <ListRow
                key={e.path}
                label={e.name}
                secondaryLabel={e.size ? formatBytes(e.size) : undefined}
                onSelect={() => {
                  onPick(e.path)
                  onOpenChange(false)
                }}
              />
            ))}
            {!busy && files.length === 0 && (
              <ListRow label="（这个目录里没有这个扩展名的工程文件）" disabled />
            )}
          </ListSection>
        </List>

        {err && <p className="finding-text">{err}</p>}
        <p className="dir-note">当前：{cwd || '（未选择）'}</p>
      </div>

      <div className="dir-actions">
        <span className="spacer" />
        <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
          取消
        </Button>
      </div>
    </GlassDialog>
  )
}

/* ══════════════════════════════════════════════════════════════ 小工具 ══ */

interface Source {
  path: string
  size?: number
}

interface PreviewReport {
  path: string
  name: string
  /** `api.inspect` 给的概览（读不出来时没有） */
  tracks?: number
  notes?: number
  findings: ApiFinding[]
  error?: string
}

/** 预检最多看几个文件 —— 每个文件要跑一次 LibreSVIP 读工程，慢 */
const PREVIEW_LIMIT = 12

const baseName = (p: string) => p.split(/[\\/]/).pop() || p

const extOf = (p: string) => {
  /* ⚠️ 捕获组不能漏：`m[1]` 在没写括号时是 undefined，`.toLowerCase()` 直接抛 —— 
     React 会把整棵树卸掉（表现是整个页面空白），而控制台只有一行 TypeError。 */
  const m = /\.([^.\\/]+)$/.exec(p)
  return m ? m[1].toLowerCase() : ''
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** 按扩展名反查源格式名（预检那行「源格式 → 目标格式」用） */
function sourceNameOf(formats: FormatInfo[], path: string): string {
  const ext = extOf(path)
  const hit = formats.find((f) => (f.exts ?? []).some((e) => String(e).replace(/^\./, '').toLowerCase() === ext))
  return hit?.name ?? (ext ? `.${ext}` : '未知格式')
}
