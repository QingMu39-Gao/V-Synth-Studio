import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  DisclosureGroup,
  GlassDialog,
  GlassStepper,
  GlassSwitch,
  List,
  ListRow,
  ListSection,
  PathBar,
  Picker,
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
import type { FormatInfo, Job } from '@/lib/types'
import type { PageProps } from './types'
import './Convert.css'

/**
 * 工程格式互转（40 种）—— 旧前端 `app/web/js/views/convert.js` 的搬家版。
 *
 * ## 加文件只有两种操作
 *
 * | 操作 | 拿到什么 | 提交去哪 |
 * |---|---|---|
 * | **拖进来** | `File`，**没有本机路径**（浏览器不给） | `run-upload`（读成 base64 上传） |
 * | **选择文件** | 本机路径（能列目录、按扩展名过滤） | `run`（后端直接读盘） |
 *
 * 两种可以混在一个列表里。**转换时按来源分批、串行提交**：`useJob()` 的 `start()` 一次只盯
 * 一个任务，所以一批跑到终态（done / error / canceled）才起下一批；进度条显示的永远是当前那批。
 * 「从目录批量收集」那一整块已经删掉（用户要的就是上面两种操作）。
 *
 * ## 上传版接口直接 fetch，没进 `lib/api.ts`
 *
 * 上传版（`/api/convert/run-upload`、`/api/convert/preview-upload`）是 JSON + base64
 * （`{ files: [{ name, base64 }] }`，不是 multipart）。`lib/api.ts` 里只包了路径版，
 * 这里就地发一次 —— 为一个页面改公共库不值得。传的是字节，所以拖入的工程比路径版慢，
 * 而且受后端 96MB 的 body 上限约束（见下 `UPLOAD_LIMIT`）。
 *
 * ## 预检是手动的
 *
 * 预检要**逐个文件起一次 LibreSVIP**，很慢，所以不做「一选文件就自动跑」——
 * 面板上一个「预检」按钮，点了才跑，跑的时候按钮转圈。**转换按钮任何时候都能点**，
 * 预检结果只是提示。
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
  const [options, setOptions] = useState<ConvertOptions>(loadOptions)
  const [picking, setPicking] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [reports, setReports] = useState<PreviewReport[]>([])
  const [previewing, setPreviewing] = useState(false)
  /** 整队都在忙：批次之间（读 base64、等下一批）没有 job，光看 job 状态会漏 */
  const [submitting, setSubmitting] = useState(false)
  const [batchLabel, setBatchLabel] = useState('')
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

  /* 转换选项记住（键沿用旧前端的，字段挪进 `options`；老数据没有它就整份用默认值） */
  useEffect(() => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ options }))
    } catch {
      /* 隐私模式写不进去 —— 不该因此影响这次转换 */
    }
  }, [options])

  /* 拖歪了掉在拖放区外面时，浏览器默认会直接把那个文件打开（整页被替换、当前选择全丢）—— 拦掉 */
  useEffect(() => {
    const block = (e: DragEvent) => e.preventDefault()
    window.addEventListener('dragover', block)
    window.addEventListener('drop', block)
    return () => {
      window.removeEventListener('dragover', block)
      window.removeEventListener('drop', block)
    }
  }, [])

  const effectiveOutDir = outDir.trim() || defaultOutDir
  const targetName = formats.find((f) => f.id === target)?.name ?? target
  const busy = submitting || job?.status === 'running'

  /* ── 来源 ─────────────────────────────────────────────── */

  /** 拖入：拿不到路径，只留 `File`（转换时读成 base64 上传） */
  const addFiles = (files: FileList | null) => {
    const incoming = [...(files ?? [])].map<DropSource>((f) => ({
      key: `f:${f.name}:${f.size}:${f.lastModified}`,
      name: f.name,
      ext: extOf(f.name),
      size: f.size,
      file: f,
    }))
    const fresh = incoming.filter((s) => !sources.some((x) => x.key === s.key))
    if (!fresh.length) {
      if (incoming.length) onToast('这些文件已经在列表里了', 'warn')
      return
    }
    setSources([...sources, ...fresh])
    onToast(`已加入 ${fresh.length} 个拖入的文件`, 'ok')
  }

  /** 选择文件：拿到的是本机路径 */
  const pickFile = (path: string) => {
    const key = `p:${path}`
    if (sources.some((s) => s.key === key)) {
      onToast('这个文件已经在列表里了', 'warn')
      return
    }
    setSources([...sources, { key, name: baseName(path), ext: extOf(path), path }])
    onToast(`已加入 ${baseName(path)}`, 'ok')
  }

  const remove = (key: string) => {
    setSources((prev) => prev.filter((s) => s.key !== key))
    setReports([]) /* 列表变了，旧的预检结果对不上号了 */
  }

  const clear = () => {
    setSources([])
    setReports([])
    stop()
  }

  /* ── 预检（手动）───────────────────────────────────────── */

  const runPreview = async () => {
    if (!sources.length) {
      onToast('请先添加文件', 'warn')
      return
    }
    if (!target) {
      onToast('请选择目标格式', 'warn')
      return
    }
    const list = sources.slice(0, PREVIEW_LIMIT)
    setPreviewing(true)
    const out: PreviewReport[] = []
    try {
      for (const s of list) {
        try {
          if (isDrop(s)) {
            /* 拖入的走上传版预检：后端一次只分析第一个文件，所以一个文件一发 */
            const pre = await postUpload<UploadPreview>('/api/convert/preview-upload', {
              files: [{ name: s.name, base64: await toBase64(s.file) }],
              toFormat: target,
            })
            out.push({
              key: s.key,
              name: s.name,
              tracks: pre.input?.trackCount ?? undefined,
              notes: pre.input?.noteCount ?? undefined,
              findings: pre.findings ?? [],
            })
          } else {
            const [info, pre] = await Promise.all([
              api.inspect({ inputPath: s.path }),
              api.preview({ inputs: [s.path], toFormat: target }),
            ])
            out.push({
              key: s.key,
              name: s.name,
              tracks: info.stats?.trackCount,
              notes: info.stats?.noteCount,
              findings: pre.findings ?? [],
            })
          }
        } catch (e) {
          /* 单个文件读不了不该让整批预检断掉 —— 记在它自己那一行上 */
          out.push({ key: s.key, name: s.name, findings: [], error: errText(e) })
        }
      }
    } finally {
      setReports(out)
      setPreviewing(false)
    }
    const bad = out.filter((r) => r.error).length
    onToast(bad ? `预检完成，${bad} 个文件读不了` : '预检完成', bad ? 'warn' : 'ok')
    if (sources.length > PREVIEW_LIMIT) {
      onToast(`只预检了前 ${PREVIEW_LIMIT} 个文件（共 ${sources.length} 个）`, 'warn')
    }
  }

  /* ── 执行（按来源分批、串行）────────────────────────────── */

  /**
   * 提交一批并盯着它跑到终态。提交失败也算「这批没成」，**不打断后面的批次**。
   * 取消是唯一会停掉整队的情况 —— 用户按了取消，多半就是不想再转了。
   */
  const runBatch = async (
    label: string,
    submit: () => Promise<string>,
  ): Promise<'ok' | 'fail' | 'canceled'> => {
    try {
      const jobId = await submit()
      setBatchLabel(label)
      return await new Promise<'ok' | 'fail' | 'canceled'>((resolve) => {
        start(jobId, {
          onDone: (j) => {
            onToast(j.message ?? `${label}转换完成`, 'ok')
            resolve('ok')
          },
          onError: (err, j) => {
            onToast(`转换失败：${err.message}${logTail(j)}`, 'err')
            resolve('fail')
          },
          onCancel: () => {
            onToast(`${label}已取消`, 'warn')
            resolve('canceled')
          },
        })
      })
    } catch (e) {
      onToast(`转换失败：${errText(e)}`, 'err')
      return 'fail'
    }
  }

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
    const paths = sources.filter((s): s is PathSource => !isDrop(s))
    const drops = sources.filter(isDrop)
    const dropBytes = drops.reduce((n, s) => n + s.size, 0)
    if (dropBytes > UPLOAD_LIMIT) {
      onToast(
        `拖入的文件一共 ${formatBytes(dropBytes)}，超过上传上限 ${formatBytes(UPLOAD_LIMIT)}；请改用「选择文件」按路径转`,
        'err',
      )
      return
    }

    const common = {
      toFormat: target,
      outDir: effectiveOutDir,
      nameTemplate: nameTemplate.trim() || '{name}_converted',
      overwrite,
      /* 整份发出去（不是只发改过的键）：后端 `normalize_options` 只在**缺**某一个中间件键时
         才拿它的参数自动打开它；键全在，开关就完全由这里的开关说了算。 */
      options,
    }

    setSubmitting(true)
    const results: string[] = []
    /* 路径批：后端直接读本机文件 */
    if (paths.length) {
      results.push(
        await runBatch('本机文件', async () => {
          const { jobId } = await api.convert({ inputs: paths.map((s) => s.path), ...common })
          return jobId
        }),
      )
    }
    /* 拖入批：没有路径，读成 base64 走上传版 */
    if (drops.length && !results.includes('canceled')) {
      results.push(
        await runBatch('拖入文件', async () => {
          const files: { name: string; base64: string }[] = []
          for (const s of drops) files.push({ name: s.name, base64: await toBase64(s.file) })
          const { jobId } = await postUpload<{ jobId: string }>('/api/convert/run-upload', { files, ...common })
          return jobId
        }),
      )
    }
    setSubmitting(false)
    if (results.length > 1) {
      const ok = results.filter((r) => r === 'ok').length
      onToast(`全部跑完：${ok} / ${results.length} 批成功`, ok === results.length ? 'ok' : 'warn')
    }
  }

  const reveal = (path: string, select: boolean) =>
    api.fsReveal(path, select).catch((e: unknown) => onToast(errText(e), 'err'))

  const setOpt = <K extends OptionKey>(key: K, value: ConvertOptions[K]) =>
    setOptions((prev) => ({ ...prev, [key]: value }))

  const warnCount = reports.flatMap((r) => r.findings).filter((f) => f.level !== 'info').length
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
            desc="把工程文件拖进来，或点「选择文件」按路径挑；两种可以混着加。工程只发给本机后端（127.0.0.1），不出这台机器"
            extra={<Chip>{availableCount} 种格式可用</Chip>}
          />
          <div className="stack">
            <div
              className="convert-drop"
              data-over={dragOver ? 'true' : undefined}
              onDragOver={(e) => {
                e.preventDefault()
                setDragOver(true)
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
              }}
              onDrop={(e) => {
                e.preventDefault()
                setDragOver(false)
                addFiles(e.dataTransfer.files)
              }}
            >
              <Icon name="upload" size={22} />
              <span className="convert-drop-title">把工程文件拖到这里</span>
              <span className="convert-drop-note">
                拖入的文件浏览器不给路径，转换时按上传通道走；按路径挑的不受影响
              </span>
            </div>

            <div className="btn-row">
              <Button icon="file" onClick={() => setPicking(true)}>
                选择文件
              </Button>
              <Button variant="ghost" icon="trash" disabled={!sources.length} onClick={clear}>
                清空
              </Button>
            </div>

            <div className="convert-sources">
              {sources.length === 0 ? (
                <div className="convert-empty">还没有添加文件：拖进来，或点上面的「选择文件」</div>
              ) : (
                sources.map((s) => (
                  <div className="convert-source" key={s.key}>
                    <Icon name="file" size={14} />
                    <span className="convert-source-name" title={isDrop(s) ? s.name : s.path}>
                      {s.name}
                    </span>
                    <span className="convert-source-ext">{s.ext || '?'}</span>
                    <span className="convert-source-src">{isDrop(s) ? '拖入' : '路径'}</span>
                    {isDrop(s) ? (
                      <span className="convert-source-size">{formatBytes(s.size)}</span>
                    ) : null}
                    {/* 拖入的没有本机路径，没有可定位的东西 */}
                    {isDrop(s) ? null : (
                      <IconButton
                        label={`在资源管理器中显示 ${s.name}`}
                        icon="folder"
                        size="sm"
                        variant="ghost"
                        onClick={() => void reveal(s.path, true)}
                      />
                    )}
                    <IconButton
                      label={`从列表移除 ${s.name}`}
                      icon="x"
                      size="sm"
                      variant="ghost"
                      onClick={() => remove(s.key)}
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

      {/* ══════════════════════ 右：输出 + 选项 + 预检 + 执行 ══════════════════════ */}
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

            <SwitchRow
              label="覆盖同名文件"
              desc="关闭时会自动加 (2) 后缀，避免覆盖"
              checked={overwrite}
              onChange={setOverwrite}
            />
          </div>
        </Panel>

        <Panel>
          <PanelHead title="转换选项" desc="不确定就别动，默认跟 LibreSVIP 官方一致" />
          <DisclosureGroup
            className="convert-opts-fold"
            label="展开转换选项"
            secondaryLabel="导入 10 项 · 效果处理 7 项 · 导出 3 项"
          >
            <div className="convert-opts">
              <section className="convert-opt-group">
                <p className="group-label">导入（默认全开：工程里有什么就带什么进来）</p>
                <div className="convert-opt-grid">
                  {IMPORT_SWITCHES.map(([key, label, desc]) => (
                    <SwitchRow
                      key={key}
                      label={label}
                      desc={desc}
                      checked={options[key]}
                      onChange={(v) => setOpt(key, v)}
                    />
                  ))}
                </div>
                <div className="convert-opt-fields">
                  <Field label="音高信息" hint="「仅颤音」只搬颤音、「不带音高」等于丢掉调好的滑音">
                    <Picker
                      label="音高信息"
                      labelHidden
                      value={options['import.pitchMode']}
                      options={PITCH_MODES}
                      onValueChange={(v) => setOpt('import.pitchMode', v)}
                    />
                  </Field>
                  <Field label="换气音符" hint="源工程里的换气记号怎么处理">
                    <Picker
                      label="换气音符"
                      labelHidden
                      value={options['import.breathMode']}
                      options={BREATH_MODES}
                      onValueChange={(v) => setOpt('import.breathMode', v)}
                    />
                  </Field>
                  <Field label="音符组" hint="拆开成单个音符，还是合成一整块">
                    <Picker
                      label="音符组"
                      labelHidden
                      value={options['import.noteGroup']}
                      options={NOTE_GROUPS}
                      onValueChange={(v) => setOpt('import.noteGroup', v)}
                    />
                  </Field>
                </div>
              </section>

              <section className="convert-opt-group">
                <p className="group-label">效果处理（中间件，默认全关；开了才动工程）</p>
                <div className="convert-opt-grid">
                  {MIDDLEWARE_SWITCHES.map(([key, label, desc]) => (
                    <SwitchRow
                      key={key}
                      label={label}
                      desc={desc}
                      checked={options[key]}
                      onChange={(v) => setOpt(key, v)}
                    />
                  ))}
                </div>
                <div className="convert-opt-fields">
                  <Field label="音高变调（半音）" hint="正数升调、负数降调；要开「音高变调」才会生效">
                    <GlassStepper
                      aria-label="音高变调半音数"
                      min={-24}
                      max={24}
                      step={1}
                      value={options['transpose.semitones']}
                      onValueChange={(v) => setOpt('transpose.semitones', Math.round(v))}
                      formatValue={(v) => `${v > 0 ? '+' : ''}${v} 半音`}
                      shiftMultiplier={1}
                    />
                  </Field>
                  <Field label="工程缩放系数" hint="分数写法，如 2/1（时值翻倍、放慢）、1/2（减半、加快）">
                    <TextInput
                      value={options['scale.factor']}
                      placeholder="1/1"
                      onChange={(e) => setOpt('scale.factor', e.target.value)}
                    />
                  </Field>
                </div>
              </section>

              <section className="convert-opt-group">
                <p className="group-label">导出（只对支持这些开关的目标格式有意义）</p>
                <div className="convert-opt-fields">
                  <Field label="VSQX 版本" hint="写 VSQX 时用哪一版；别的格式忽略">
                    <Picker
                      label="VSQX 版本"
                      labelHidden
                      value={options['export.vsqxVersion']}
                      options={VSQX_VERSIONS}
                      onValueChange={(v) => setOpt('export.vsqxVersion', v)}
                    />
                  </Field>
                  <Field label="默认语言" hint="给歌手的默认发音语言；「跟随工程」= 用工程里带的">
                    <Picker
                      label="默认语言"
                      labelHidden
                      value={options['export.language']}
                      options={LANGUAGES}
                      onValueChange={(v) => setOpt('export.language', v)}
                    />
                  </Field>
                </div>
                <SwitchRow
                  label="美化 XML"
                  desc="缩进排版的 XML 好读，体积大一点"
                  checked={options['export.prettyXml']}
                  onChange={(v) => setOpt('export.prettyXml', v)}
                />
              </section>
            </div>
          </DisclosureGroup>
        </Panel>

        <Panel>
          <PanelHead
            title="转换预检"
            desc="点了才跑（逐个文件起一次引擎，慢）；不预检也能直接转换，结果只是提示"
            extra={
              <Button
                size="sm"
                icon="shield"
                loading={previewing}
                disabled={!sources.length}
                onClick={() => void runPreview()}
              >
                预检
              </Button>
            }
          />
          <div className="stack">
            {reports.length === 0 ? (
              <p className="muted">
                {sources.length === 0
                  ? '先加一个源工程，这里会报出目标格式装不下哪些数据。'
                  : '还没预检。点右上角「预检」，它要逐个文件读一遍工程，所以不会自动跑。'}
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
              <div className="convert-report" key={r.key}>
                <div className="convert-report-head">
                  <span className="convert-report-name" title={r.name}>
                    {r.name}
                  </span>
                  <Chip title={`${sourceNameOf(formats, r.name)} → ${targetName}`}>
                    {`${sourceNameOf(formats, r.name)} → ${targetName}`}
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
                        key={`${r.key}-${i}`}
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
              <Button variant="primary" size="lg" icon="zap" loading={busy} onClick={() => void run()}>
                开始转换
              </Button>
            </div>
            <p className="hint convert-note">
              {sources.some(isDrop)
                ? '拖入的文件按上传通道转（字节发给本机后端），按路径挑的直接读盘；两种混着加时会分批提交'
                : '全部处理在本机完成，不联网、不出这台机器'}
            </p>
          </div>

          <JobProgress
            job={job}
            title={batchLabel ? `转换进度（${batchLabel}）` : '转换进度'}
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

/* ══════════════════════════════════════════════════════ 转换选项 ══ */

/**
 * 选项默认值 —— **键名必须逐字对上后端 `libresvip::RULES`**
 * （`app/desktop/src/libresvip.rs`，后端就是按这些键回答 LibreSVIP 的逐题提问的）。
 *
 * ⚠️ 写错一个字母**不会报错**：那一题后端读不到，照抄 LibreSVIP 自己的默认值 ——
 * 表现就是「设了跟没设一样」。改这里的键名时对着 `RULES` 一个一个核。
 *
 * 默认值也按官方来：导入全开、中间件全关、导出 VSQX 4 + 美化 XML + 语言 4（西班牙语，LibreSVIP 的默认）。
 */
interface ConvertOptions {
  'import.volume': boolean
  'import.dynamics': boolean
  'import.pitch': boolean
  'import.accompaniment': boolean
  'import.gender': boolean
  'import.breath': boolean
  'import.instantPitch': boolean
  'import.pitchMode': string
  'import.breathMode': string
  'import.noteGroup': string
  'middleware.transpose': boolean
  'middleware.scale': boolean
  'middleware.lyricsPron': boolean
  'middleware.removeShort': boolean
  'middleware.replaceLyrics': boolean
  'transpose.semitones': number
  'scale.factor': string
  'export.vsqxVersion': string
  'export.prettyXml': boolean
  'export.language': string
}

type OptionKey = keyof ConvertOptions
/** 只挑出「值是 T」的那些键 —— 用来把开关列成表，省掉每处一个断言 */
type KeyOf<T> = { [K in OptionKey]: ConvertOptions[K] extends T ? K : never }[OptionKey]

const DEFAULTS: ConvertOptions = {
  'import.volume': true,
  'import.dynamics': true,
  'import.pitch': true,
  'import.accompaniment': true,
  'import.gender': true,
  'import.breath': true,
  'import.instantPitch': true,
  'import.pitchMode': 'plain',
  'import.breathMode': 'convert',
  'import.noteGroup': 'split',
  'middleware.transpose': false,
  'middleware.scale': false,
  'middleware.lyricsPron': false,
  'middleware.removeShort': false,
  'middleware.replaceLyrics': false,
  'transpose.semitones': 0,
  'scale.factor': '1/1',
  'export.vsqxVersion': '4',
  'export.prettyXml': true,
  'export.language': '4',
}

/** 沿用旧前端的键（老数据里是另一套平铺字段、没有 `options`，那就整份用默认值） */
const LS_KEY = 'fandiao.convert.settings'

const IMPORT_SWITCHES: [KeyOf<boolean>, string, string][] = [
  ['import.volume', '音量包络', '音量 / 表情曲线（VEL）'],
  ['import.dynamics', '力度包络', '力度曲线（DYN）'],
  ['import.pitch', '音高曲线', '滑音曲线（PIT）'],
  ['import.accompaniment', '伴奏轨', '工程里单独一条伴奏音轨'],
  ['import.gender', '性别包络', '性别参数曲线（GEN）'],
  ['import.breath', '气声包络', '气声 / 呼吸曲线（BRE）'],
  ['import.instantPitch', '遵循即时音高', '按音符上的即时音高唱，不受曲线影响'],
]

const MIDDLEWARE_SWITCHES: [KeyOf<boolean>, string, string][] = [
  ['middleware.transpose', '音高变调', '整体升 / 降调，半音数在下面'],
  ['middleware.scale', '工程缩放', '时值整体缩放，系数在下面'],
  ['middleware.lyricsPron', '歌词发音转换', '把歌词转成目标格式认识的发音记号'],
  ['middleware.removeShort', '移除短的无声间隙', '把碎拍之间的空档并掉'],
  ['middleware.replaceLyrics', '替换歌词', '按规则替换歌词文本'],
]

const PITCH_MODES = [
  { value: 'full', label: '完整' },
  { value: 'vibrato', label: '仅颤音' },
  { value: 'plain', label: '不带音高' },
]
const BREATH_MODES = [
  { value: 'ignore', label: '忽略' },
  { value: 'keep', label: '保留' },
  { value: 'convert', label: '转成换气音' },
]
const NOTE_GROUPS = [
  { value: 'split', label: '拆分' },
  { value: 'merge', label: '合并' },
]
const VSQX_VERSIONS = [
  { value: '3', label: 'VSQX 3' },
  { value: '4', label: 'VSQX 4' },
]
/** LibreSVIP / VOCALOID 的语言序号：0 是「跟随工程」 */
const LANGUAGES = [
  { value: '0', label: '跟随工程' },
  { value: '1', label: '日语' },
  { value: '2', label: '英语' },
  { value: '3', label: '中文' },
  { value: '4', label: '西班牙语' },
]

/** 读存档：**按默认值的键和类型逐个取**，缺的 / 类型不对的一律用默认值 */
function loadOptions(): ConvertOptions {
  const out = { ...DEFAULTS }
  try {
    const raw = JSON.parse(localStorage.getItem(LS_KEY) ?? '{}') as { options?: unknown }
    const saved = raw?.options as Record<string, unknown> | undefined
    if (!saved) return out
    for (const key of Object.keys(DEFAULTS) as OptionKey[]) {
      if (typeof saved[key] === typeof DEFAULTS[key]) out[key] = saved[key] as never
    }
  } catch {
    /* 存档坏了当没存过 */
  }
  return out
}

/** 一行开关：左边标签 + 说明，右边库的 `GlassSwitch` */
function SwitchRow({
  label,
  desc,
  checked,
  onChange,
}: {
  label: string
  desc?: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <div className="convert-switch-row">
      <div className="convert-switch-text">
        <span className="convert-switch-label">{label}</span>
        {desc ? <span className="convert-switch-desc">{desc}</span> : null}
      </div>
      <GlassSwitch aria-label={label} checked={checked} onCheckedChange={onChange} />
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

/** 有本机路径的来源：走 `run`，后端直接读盘 */
interface PathSource {
  key: string
  name: string
  ext: string
  path: string
}

/** 拖入的来源：**没有路径**（浏览器不给），只能把字节发上去 —— 走 `run-upload` */
interface DropSource {
  key: string
  name: string
  ext: string
  size: number
  file: File
}

type Source = PathSource | DropSource

const isDrop = (s: Source): s is DropSource => 'file' in s

interface PreviewReport {
  key: string
  name: string
  /** `api.inspect` / 上传版预检给的概览（读不出来时没有） */
  tracks?: number
  notes?: number
  findings: ApiFinding[]
  error?: string
}

/** 上传版预检的回包（`{ findings, input: { name, trackCount, noteCount } }`） */
interface UploadPreview {
  findings?: ApiFinding[]
  input?: { name?: string; trackCount?: number; noteCount?: number }
}

/** 预检最多看几个文件 —— 每个文件要跑一次 LibreSVIP 读工程，慢 */
const PREVIEW_LIMIT = 12

/** 后端的 body 上限（`simple::CONVERT_UPLOAD_LIMIT`，96MB）—— 拖入的整批超了就提前拦下来 */
const UPLOAD_LIMIT = 96 * 1024 * 1024

const baseName = (p: string) => p.split(/[\\/]/).pop() || p

const extOf = (p: string) => {
  /* ⚠️ 捕获组不能漏：`m[1]` 在没写括号时是 undefined，`.toLowerCase()` 直接抛 ——
     React 会把整棵树卸掉（表现是整个页面空白），而控制台只有一行 TypeError。 */
  const m = /\.([^.\\/]+)$/.exec(p)
  return m ? m[1].toLowerCase() : ''
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

/** 失败提示里带上任务日志末尾 —— 真正的报错在日志里，光回一句「任务失败」等于没说 */
function logTail(job: Job, max = 160): string {
  const lines = (job.logs ?? [])
    .slice(-3)
    .map((l) => l.trim())
    .filter(Boolean)
  if (!lines.length) return ''
  const text = lines.join('；')
  return `（日志末尾：${text.length > max ? `…${text.slice(-max)}` : text}）`
}

/** 按扩展名反查源格式名（预检那行「源格式 → 目标格式」用） */
function sourceNameOf(formats: FormatInfo[], name: string): string {
  const ext = extOf(name)
  const hit = formats.find((f) =>
    (f.exts ?? []).some((e) => String(e).replace(/^\./, '').toLowerCase() === ext),
  )
  return hit?.name ?? (ext ? `.${ext}` : '未知格式')
}

/** File → base64（去掉 data URL 前缀）。拖入的文件没有路径，只能把字节发上去 */
const toBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`读取 ${file.name} 失败`))
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '')
    reader.readAsDataURL(file)
  })

/**
 * 上传版接口直接 `fetch`（`/api/convert/run-upload`、`/api/convert/preview-upload`）。
 *
 * `lib/api.ts` 里没有包这两条，本轮也不动公共库 —— 上传版就是 JSON + base64，
 * 就地发一次比为一个页面改公共库省事。拼的是绝对路径 `/api/...`（页面在 `/next/` 下）。
 */
async function postUpload<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  let data: (T & { ok?: boolean; error?: string }) | null
  try {
    data = text ? JSON.parse(text) : ({} as T)
  } catch {
    throw new Error(`服务端返回异常内容（HTTP ${res.status}）`)
  }
  if (!res.ok || data?.ok === false) {
    throw new Error(data?.error || `请求失败（HTTP ${res.status}）`)
  }
  return data as T
}
