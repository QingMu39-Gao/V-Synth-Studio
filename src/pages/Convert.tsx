import {useEffect, useMemo, useRef, useState} from 'react'
import {Disclosure, Select, Stepper} from '@/components/ui'
import {api, type Finding as ApiFinding} from '@/lib/api'
import {getConfig, saveConfig} from '@/lib/config'
import {baseName, errText, extOf} from '@/lib/format'
import {Button, IconButton} from '@/components/Button'
import {Credit, Upstream} from '@/components/Credit'
import {DirectoryInput} from '@/components/DirPicker'
import {Field, TextInput} from '@/components/Field'
import {useFilePick} from '@/components/FilePick'
import {Icon} from '@/components/Icon'
import {JobProgress} from '@/components/Job'
import {Chip, Finding, Panel, PanelHead} from '@/components/Panel'
import {SwitchRow} from '@/components/SwitchRow'
import {useJob} from '@/lib/useJob'
import type {FormatInfo, Job} from '@/lib/types'
import type {PageProps} from './types'
import './Convert.css'
import {useI18n} from '@/lib/i18n'

/**
 * 工程格式互转（40 种）。
 *
 * ## 加文件只有两种操作，而且**两种都给本机路径**
 *
 * | 操作 | 拿到什么 | 提交去哪 |
 * |---|---|---|
 * | **拖进来** | **真路径**（Tauri 的 `DragDropEvent` 载荷里直接带 `paths`） | `convert_run`（后端直接读盘） |
 * | **选择文件** | 本机路径（系统对话框，按扩展名过滤、可多选） | 同上 |
 *
 * ⚠️ **不要把文件读成 base64 再上传**：LibreSVIP 要的本来就是路径，而 base64
 * （+33% 体积、WebView 与 Rust 两边各存一份、还有 96MB 的 body 上限）是白搭的。
 * 拖放给的 `paths` 已经是磁盘上的真路径，直接用。
 *
 * 于是列表里只有一个来源类型，转换也只有一批。
 *
 * ## 预检是手动的
 *
 * 预检要**逐个文件起一次 LibreSVIP**，很慢，所以不做「一选文件就自动跑」——
 * 面板上一个「预检」按钮，点了才跑，跑的时候按钮转圈。**转换按钮任何时候都能点**，
 * 预检结果只是提示。
 */
export function Convert({state, onToast}: PageProps) {
    const {t} = useI18n()
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
    /** 上次从哪个目录挑的工程 —— 只当系统对话框的起点，下次接着从那儿开 */
    const [pickDir, setPickDir] = useState('')
    const [reports, setReports] = useState<PreviewReport[]>([])
    const [previewing, setPreviewing] = useState(false)
    /** 整队都在忙：批次之间没有 job，光看 job 状态会漏 */
    const [submitting, setSubmitting] = useState(false)
    const [batchLabel, setBatchLabel] = useState('')
    const {job, start, stop} = useJob()

    /* 首屏那次 get_state 到了之后灌一次默认值（只灌一次，之后归用户） */
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

    /* 转换选项记住 —— 存在 `config.json` 的 `convert` 里。`saveConfig` 内部已经防抖合并，这里不用再攒。 */
    useEffect(() => {
        saveConfig({convert: {options} as unknown as Record<string, unknown>})
    }, [options])

    const effectiveOutDir = outDir.trim() || defaultOutDir
    const targetName = formats.find((f) => f.id === target)?.name ?? target
    const busy = submitting || job?.status === 'running'

    /* ── 来源 ─────────────────────────────────────────────── */

    /** 加入一批本机路径（对话框与拖放都走这里 —— **两条路给的都是真路径**） */
    const addPaths = (paths: string[]) => {
        const incoming = paths.map<Source>((path) => ({
            key: `p:${path}`,
            name: baseName(path),
            ext: extOf(path),
            path,
        }))
        const fresh = incoming.filter((s) => !sources.some((x) => x.key === s.key))
        if (!fresh.length) {
            onToast(incoming.length === 1 ? '这个文件已经在列表里了' : '这些文件已经在列表里了', 'warn')
            return
        }
        setSources([...sources, ...fresh])
        onToast(`已加入 ${fresh.length === 1 ? fresh[0].name : `${fresh.length} 个文件`}`, 'ok')
    }

    /**
     * 「选择文件」走系统文件对话框（`pick_paths`）。工程文件一次挑好几个是常事，
     * 所以给 `multi`；挑完记住那个目录，下次从那儿开。拖放也由它挂上
     * （`dropProps` 现在是空对象，拖放走 Tauri 的窗口事件，见 `components/FilePick.tsx`）。
     */
    const {pick, dropProps, dragging, busy: picking} = useFilePick({
        exts: projectExts,
        label: '工程文件',
        title: '选择工程文件',
        dir: pickDir || undefined,
        multi: true,
        onPaths: (paths) => {
            addPaths(paths)
            const dir = paths[0].replace(/[\\/][^\\/]*$/, '')
            if (dir && dir !== paths[0]) setPickDir(dir)
        },
        onToast,
    })

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
                    const [info, pre] = await Promise.all([
                        api.inspect({inputPath: s.path}),
                        api.preview({inputs: [s.path], toFormat: target}),
                    ])
                    out.push({
                        key: s.key,
                        name: s.name,
                        tracks: info.stats?.trackCount,
                        notes: info.stats?.noteCount,
                        findings: pre.findings ?? [],
                    })
                } catch (e) {
                    /* 单个文件读不了不该让整批预检断掉 —— 记在它自己那一行上 */
                    out.push({key: s.key, name: s.name, findings: [], error: errText(e)})
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

    /* ── 执行（一批提交，串行盯到终态）──────────────────────── */

    /**
     * 提交一批并盯着它跑到终态。提交失败也算「没成」。
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
        /* ⚠️ `inputs` 全是**本机路径** —— 后端直接读盘，不再有 base64 那条路 */
        const result = await runBatch('工程转换', async () => {
            const {jobId} = await api.convert({inputs: sources.map((s) => s.path), ...common})
            return jobId
        })
        setSubmitting(false)
        if (result === 'ok') onToast(`全部完成：${sources.length} 个文件`, 'ok')
    }

    const reveal = (path: string, select: boolean) =>
        api.fsReveal(path, select).catch((e: unknown) => onToast(errText(e), 'err'))

    const setOpt = <K extends OptionKey>(key: K, value: ConvertOptions[K]) =>
        setOptions((prev) => ({...prev, [key]: value}))

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
        <div className="convert-layout" {...dropProps}>
            {/* ══════════════════════ 左：来源 + 目标 ══════════════════════ */}
            <div className="convert-col">
                <Panel>
                    <PanelHead
                        title={t("来源工程")}
                        desc="把工程文件拖进来，或点「选择文件」挑"
                        extra={<Chip>{availableCount} 种格式可用</Chip>}
                    />
                    <div className="stack">
                        {/* 拖放由 Tauri 的窗口事件接管（`components/FilePick.tsx`），所以这里
                **没有** DOM 上的 onDragOver / onDrop —— 写在这里的 HTML5 拖放事件
                根本不会触发（Tauri 默认把拖放截走了）。`data-over` 跟着拖放状态亮。 */}
                        <div className="convert-drop" data-over={dragging ? 'true' : undefined}>
                            <Icon name="upload" size={22}/>
                            <span className="convert-drop-title">{t("把工程文件拖到这里")}</span>
                        </div>

                        <div className="btn-row">
                            <Button icon="file" loading={picking} onClick={() => void pick()}>
                                选择文件
                            </Button>
                            <Button variant="ghost" icon="trash" disabled={!sources.length} onClick={clear}>
                                清空
                            </Button>
                        </div>

                        <div className="convert-sources">
                            {sources.length === 0 ? (
                                <div className="convert-empty">{t("还没有添加文件")}</div>
                            ) : (
                                sources.map((s) => (
                                    <div className="convert-source" key={s.key}>
                                        <Icon name="file" size={14}/>
                                        <span className="convert-source-name" title={s.path}>
                      {s.name}
                    </span>
                                        <span className="convert-source-ext">{s.ext || '?'}</span>
                                        <IconButton
                                            label={`在资源管理器中显示 ${s.name}`}
                                            icon="folder"
                                            size="sm"
                                            variant="ghost"
                                            onClick={() => void reveal(s.path, true)}
                                        />
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
                    <PanelHead title={t("目标格式")} desc="转换后要拿去哪个编辑器继续做"/>
                    {groups.length === 0 ? (
                        <p className="muted">{t("还没有读到可用的格式。")}</p>
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
                    <PanelHead title={t("输出设置")}/>
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
                                title={t("选输出目录")}
                                onToast={onToast}
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
                            hint="可用变量：{name} = 原文件名"
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
                    <PanelHead title={t("转换选项")} desc="默认与官方一致"/>
                    <Disclosure
                        className="convert-opts-fold"
                        label="展开转换选项"
                        secondaryLabel="导入 10 项 · 效果处理 7 项 · 导出 3 项"
                    >
                        <div className="convert-opts">
                            <section className="convert-opt-group">
                                <p className="group-label">{t("导入（默认全开）")}</p>
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
                                    <Field label="音高信息输入模式">
                                        <Select
                                            label="音高信息输入模式"
                                            labelHidden
                                            value={options['音高信息输入模式']}
                                            options={PITCH_MODES}
                                            onValueChange={(v) => setOpt('音高信息输入模式', v)}
                                        />
                                    </Field>
                                    <Field label="换气音符处理方式">
                                        <Select
                                            label="换气音符处理方式"
                                            labelHidden
                                            value={options['换气音符处理方式']}
                                            options={BREATH_MODES}
                                            onValueChange={(v) => setOpt('换气音符处理方式', v)}
                                        />
                                    </Field>
                                    <Field label="音符组导入方式">
                                        <Select
                                            label="音符组导入方式"
                                            labelHidden
                                            value={options['音符组导入方式']}
                                            options={NOTE_GROUPS}
                                            onValueChange={(v) => setOpt('音符组导入方式', v)}
                                        />
                                    </Field>
                                </div>
                            </section>

                            <section className="convert-opt-group">
                                <p className="group-label">{t("效果处理（默认全关）")}</p>
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
                                        <Stepper
                                            aria-label={t("音高变调半音数")}
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
                                <p className="group-label">{t("导出（只对支持这些开关的目标格式有意义）")}</p>
                                <div className="convert-opt-fields">
                                    <Field label="VSQX 文件版本" hint="写 VSQX 时用哪一版；别的格式忽略">
                                        <Select
                                            label="VSQX 文件版本"
                                            labelHidden
                                            value={options['VSQX文件版本']}
                                            options={VSQX_VERSIONS}
                                            onValueChange={(v) => setOpt('VSQX文件版本', v)}
                                        />
                                    </Field>
                                    <Field label="默认语言" hint="给歌手的默认发音语言">
                                        <Select
                                            label="默认语言"
                                            labelHidden
                                            value={options['默认语言']}
                                            options={LANGUAGES}
                                            onValueChange={(v) => setOpt('默认语言', v)}
                                        />
                                    </Field>
                                </div>
                                <SwitchRow
                                    label="美化 XML"
                                    desc="缩进排版的 XML 好读，体积大一点"
                                    checked={options['美化XML']}
                                    onChange={(v) => setOpt('美化XML', v)}
                                />
                            </section>
                        </div>
                    </Disclosure>
                </Panel>

                <Panel>
                    <PanelHead
                        title={t("转换预检")}
                        desc="点了才跑；不预检也能直接转换，结果只是提示"
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
                                    : '还没预检。点右上角「预检」。'}
                            </p>
                        ) : null}

                        {reports.length > 0 ? (
                            okReports === 0 ? (
                                <Finding level="warn" title={t("这批文件都读不了")}>
                                    工程读不出来通常意味着文件损坏，或不是该扩展名对应的格式。
                                </Finding>
                            ) : warnCount > 0 ? (
                                <Finding level="warn" title={t("目标格式装不下下列数据，转换后会丢失：")}>
                                    {`发现 ${warnCount} 项失配`}
                                </Finding>
                            ) : (
                                <Finding level="info" title={t("预检通过")}>
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
                                    {r.error ? <Chip tone="err">{t("读取失败")}</Chip> : null}
                                </div>
                                {r.error ? (
                                    <Finding level="warn" title={t("预检失败")}>
                                        {r.error}
                                    </Finding>
                                ) : (
                                    <div className="convert-findings">
                                        {/* Finding 只有 warn / info 两档，err 的照 warn 显示（消息原文不动） */}
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
                            <p className="hint">输出目录：{effectiveOutDir}</p>
                        </div>
                    ) : null}
                </Panel>

                {/* 许可与出处：四十来种工程格式的读写都是 LibreSVIP 做的 */}
                <Credit
                    items={[
                        {label: '代码', value: 'Apache-2.0', sub: 'LibreSVIP 2.9.0'},
                    ]}
                >
                    工程格式的读写由{' '}
                    <Upstream href="https://github.com/SoulMelody/LibreSVIP">LibreSVIP</Upstream>
                    （Apache-2.0）完成：四十来种格式都归它。
                </Credit>
            </div>
        </div>
    )
}

/* ══════════════════════════════════════════════════════ 转换选项 ══ */

/**
 * 选项默认值 —— **键名必须逐字对上后端 `libresvip::RULES`**，也就是 LibreSVIP 的
 * 官方选项名（中文）。来源：`libresvip-cli.exe plugin detail svp/vsqx`，LibreSVIP 2.9.0。
 * 后端的 `libresvip.rs` 按这些官方名称直接装配答案给 CLI。
 *
 * ⚠️ 默认值一律**跟随官方默认**，包括下面这条 —— `音高信息输入模式: 'plain'`
 * （官方默认；≈ 只带"已编辑"部分）。同一工程 `plain` 产物 1002 KB / 5556 个 `<cc>` 曲线点，
 * `full` 是 5918 KB / 94026 个。**要完整保留源工程里画的音高，用户在面板上选「完整」。**
 * （把默认改成 `full` 属于替用户改官方语义，不做。）
 */
interface ConvertOptions {
    '导入音量包络': boolean
    '导入力度包络': boolean
    '导入音高曲线': boolean
    '导入伴奏轨': boolean
    '导入性别包络': boolean
    '导入气声包络': boolean
    '遵循即时音高模式设置': boolean
    '音高信息输入模式': string
    '换气音符处理方式': string
    '音符组导入方式': string
    'middleware.transpose': boolean
    'middleware.scale': boolean
    'middleware.lyricsPron': boolean
    'middleware.removeShort': boolean
    'middleware.replaceLyrics': boolean
    'transpose.semitones': number
    'scale.factor': string
    'VSQX文件版本': string
    '美化XML': boolean
    '默认语言': string
}

type OptionKey = keyof ConvertOptions
/** 只挑出「值是 T」的那些键 —— 用来把开关列成表，省掉每处一个断言 */
type KeyOf<T> = { [K in OptionKey]: ConvertOptions[K] extends T ? K : never }[OptionKey]

const DEFAULTS: ConvertOptions = {
    '导入音量包络': true,
    '导入力度包络': true,
    '导入音高曲线': true,
    '导入伴奏轨': true,
    '导入性别包络': true,
    '导入气声包络': true,
    '遵循即时音高模式设置': true,
    '音高信息输入模式': 'plain',  // ← 使用官方默认值 plain
    '换气音符处理方式': 'convert',
    '音符组导入方式': 'split',
    'middleware.transpose': false,
    'middleware.scale': false,
    'middleware.lyricsPron': false,
    'middleware.removeShort': false,
    'middleware.replaceLyrics': false,
    'transpose.semitones': 0,
    'scale.factor': '1/1',
    'VSQX文件版本': '4',
    '美化XML': true,
    '默认语言': '4',
}

/** 转换选项的配置键。**键名固定，别改** —— 迁移按这个名字搬老设置。 */
const CFG_KEY = 'convert'

const IMPORT_SWITCHES: [KeyOf<boolean>, string, string][] = [
    ['导入音量包络', '音量包络', '音量 / 表情曲线（VEL）'],
    ['导入力度包络', '力度包络', '力度曲线（DYN）'],
    ['导入音高曲线', '音高曲线', '滑音曲线（PIT）'],
    ['导入伴奏轨', '伴奏轨', '工程里单独一条伴奏音轨'],
    ['导入性别包络', '性别包络', '性别参数曲线（GEN）'],
    ['导入气声包络', '气声包络', '气声 / 呼吸曲线（BRE）'],
    ['遵循即时音高模式设置', '遵循即时音高', '按音符上的即时音高唱，不受曲线影响'],
]

const MIDDLEWARE_SWITCHES: [KeyOf<boolean>, string, string][] = [
    ['middleware.transpose', '音高变调', '整体升 / 降调，半音数在下面'],
    ['middleware.scale', '工程缩放', '时值整体缩放，系数在下面'],
    ['middleware.lyricsPron', '歌词发音转换', '把歌词转成目标格式认识的发音记号'],
    ['middleware.removeShort', '移除短的无声间隙', '把碎拍之间的空档并掉'],
    ['middleware.replaceLyrics', '替换歌词', '按规则替换歌词文本'],
]

/** 音高信息输入模式的取值（LibreSVIP 官方枚举 PitchOption） */
const PITCH_MODES = [
    {value: 'full', label: '完整音高曲线'},
    {value: 'vibrato', label: '仅已编辑（颤音模式）'},
    {value: 'plain', label: '仅已编辑（平整模式）'},
]
/** 换气音符处理方式的取值（LibreSVIP 官方枚举 BreathOption） */
const BREATH_MODES = [
    {value: 'ignore', label: '忽略'},
    {value: 'keep', label: '保留'},
    {value: 'convert', label: '转成换气音'},
]
/** 音符组导入方式的取值（LibreSVIP 官方枚举 GroupOption） */
const NOTE_GROUPS = [
    {value: 'split', label: '全部拆分为轨道'},
    {value: 'merge', label: '保留原始位置'},
]
const VSQX_VERSIONS = [
    {value: '3', label: 'VSQX 3'},
    {value: '4', label: 'VSQX 4'},
]
/** LibreSVIP / VOCALOID 的语言序号：0 是「跟随工程」 */
const LANGUAGES = [
    {value: '0', label: '跟随工程'},
    {value: '1', label: '日语'},
    {value: '2', label: '英语'},
    {value: '3', label: '中文'},
    {value: '4', label: '西班牙语'},
]

/** 读存档：**按默认值的键和类型逐个取**，缺的 / 类型不对的一律用默认值 */
function loadOptions(): ConvertOptions {
    const out = {...DEFAULTS}
    const raw = getConfig()[CFG_KEY] as { options?: unknown } | undefined
    const saved = raw?.options as Record<string, unknown> | undefined
    if (!saved) return out
    for (const key of Object.keys(DEFAULTS) as OptionKey[]) {
        if (typeof saved[key] === typeof DEFAULTS[key]) out[key] = saved[key] as never
    }
    return out
}

/* ══════════════════════════════════════════════════════════════ 小工具 ══ */

/**
 * 列表里的一个来源。**只有这一种** —— 对话框与拖放都给本机路径
 * （拖放那条来自 Tauri 的 `DragDropEvent`，载荷里直接带 `paths`）。
 */
interface Source {
    key: string
    name: string
    ext: string
    path: string
}

interface PreviewReport {
    key: string
    name: string
    /** `api.inspect` 给的概览（读不出来时没有） */
    tracks?: number
    notes?: number
    findings: ApiFinding[]
    error?: string
}

/** 预检最多看几个文件 —— 每个文件要跑一次 LibreSVIP 读工程，慢 */
const PREVIEW_LIMIT = 12

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
