/**
 * 工程转换视图
 *
 * 支持两种来源：
 *  1) 拖入文件 / 文件选择器 —— 浏览器读取字节上传（不需要知道本地路径）
 *  2) 从目录批量收集 —— 服务端直接读路径，适合整批转换
 */

import { api, watchJob } from '../api.js'
import { h, mount, icon, toast, button, card, progressBar, emptyState, formatBytes, alertBox, modal } from '../ui.js'
import { pickDirectory, directoryInput, outputDirHint } from '../components/dirPicker.js'

const LS_KEY = 'fandiao.convert.settings'

const defaultSettings = {
  targetFormat: 'vsqx',
  outDir: '',
  nameTemplate: '{name}_converted',
  overwrite: false,
  splitTracks: false,
  options: {
    transpose: 0,
    lyrics: 'none',
    quantize: 'none',
    retargetBpm: 0,
    shiftBeats: 0,
    fitRange: false,
    clampRange: null,
    removeShort: 0,
    mergeTied: false,
    mergeTracks: false,
    splitByPitch: false,
    stripParams: false,
    resampleParams: 0,
  },
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return structuredClone(defaultSettings)
    const parsed = JSON.parse(raw)
    return { ...structuredClone(defaultSettings), ...parsed, options: { ...defaultSettings.options, ...(parsed.options ?? {}) } }
  } catch {
    return structuredClone(defaultSettings)
  }
}

function saveSettings(s) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s))
  } catch {
    /* ignore */
  }
}

export async function render(ctx) {
  const { container, headerActions, state } = ctx
  const settings = loadSettings()
  if (!settings.targetFormat) settings.targetFormat = defaultSettings.targetFormat
  if (!settings.outDir && state.paths?.outputDir) settings.outDir = state.paths.outputDir

  /** 待转换文件：{ path? , name, size, ext, buffer? } */
  let sources = []
  let previewResult = null
  let activeJob = null
  let lastResult = null

  const writable = state.formats.filter((f) => f.available && f.canWrite !== false)
  if (writable.length && !writable.some((f) => f.id === settings.targetFormat)) {
    settings.targetFormat = writable[0].id
  }

  /** 所有工程格式的扩展名（不带点），给本机文件选择器当过滤器 */
  const projectExts = [...new Set(state.formats.flatMap((f) => f.exts ?? []).map((e) => String(e).replace(/^\./, '').toLowerCase()))]

  /* ---------------- 头部动作 ---------------- */
  mount(headerActions,
    h('span.chip', `${state.formats.filter((f) => f.available).length} 种格式可用`)
  )

  /* ---------------- 布局骨架 ---------------- */
  const left = h('div.col.gap-lg')
  const right = h('div.col')
  mount(container, h('div.convert-layout', [left, right]))

  /* ---------------- 来源区 ---------------- */
  const fileRows = h('div.file-rows')
  const dropzone = h('div.dropzone', [
    h('div.dropzone-icon', [icon('upload', 22)]),
    h('h3', '把工程文件拖进来'),
    h('p', '支持 .vsqx / .vpr / .vsq / .ustx / .ust / .svp / .ccs / .mid 等；文件只在本机处理'),
  ])
  const fileInput = h('input', { type: 'file', multiple: true, style: { display: 'none' } })
  fileInput.addEventListener('change', async () => {
    await addBrowserFiles([...fileInput.files])
    fileInput.value = ''
  })

  dropzone.addEventListener('click', () => fileInput.click())
  dropzone.addEventListener('dragover', (e) => {
    e.preventDefault()
    dropzone.classList.add('dragover')
  })
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'))
  dropzone.addEventListener('drop', async (e) => {
    e.preventDefault()
    dropzone.classList.remove('dragover')
    const files = await filesFromDataTransfer(e.dataTransfer)
    if (!files.length) {
      toast('没有读到文件。如果拖的是文件夹，请改用「从目录收集」', 'warn')
      return
    }
    await addBrowserFiles(files)
  })

  async function addBrowserFiles(files) {
    let added = 0
    for (const f of files) {
      const ext = (f.name.match(/\.[^.]+$/) ?? [''])[0].toLowerCase()
      if (sources.some((s) => s.name === f.name && s.size === f.size)) continue
      try {
        const buffer = await f.arrayBuffer()
        sources.push({ name: f.name, size: f.size, ext, buffer })
        added += 1
      } catch (err) {
        toast(`读取 ${f.name} 失败：${err.message}`, 'err')
      }
    }
    if (added) {
      toast(`已加入 ${added} 个文件`, 'ok')
      previewResult = null
      renderSources()
      maybeAutoPreview()
    }
  }

  const sourceCard = card({
    title: '来源工程',
    sub: '拖入文件，或从目录批量收集',
    iconName: 'file',
    actions: h('div.row.gap-sm', [
      button('浏览本机文件', { size: 'btn-sm', variant: 'btn-primary', iconName: 'folder', onClick: browseLocalFile }),
      button('从目录收集', { size: 'btn-sm', iconName: 'folder', onClick: collectFromDirectory }),
      button('清空', {
        size: 'btn-sm',
        variant: 'btn-ghost',
        iconName: 'trash',
        onClick: () => {
          sources = []
          previewResult = null
          lastResult = null
          renderSources()
          renderResult()
          renderPreview()
        },
      }),
    ]),
    body: h('div.col', [dropzone, fileInput, fileRows]),
  })

  /** 在本机磁盘上挑一个工程文件（拿到的是真实路径，服务端直接读） */
  function browseLocalFile() {
    pickDirectory({
      mode: 'file',
      exts: projectExts,
      title: '选择工程文件',
      initial: sources.find((s) => s.path)?.path || settings.outDir,
      onPick: (_p, entry) => {
        if (!entry?.path) return
        if (sources.some((s) => s.path === entry.path)) {
          toast('这个文件已经在列表里了', 'warn')
          return
        }
        sources.push({
          path: entry.path,
          name: entry.name,
          size: entry.size,
          ext: entry.ext ? `.${entry.ext}` : '',
        })
        previewResult = null
        renderSources()
        maybeAutoPreview()
      },
    })
  }

  async function collectFromDirectory() {
    pickDirectory({
      title: '选择包含工程文件的目录',
      initial: settings.outDir,
      onPick: async (dir) => {
        try {
          const btn = toast('正在扫描目录…', 'info', { duration: 1200 })
          const { files } = await api.collect(dir, true)
          let added = 0
          for (const f of files) {
            if (sources.some((s) => s.path === f.path)) continue
            sources.push({ path: f.path, name: f.name, size: f.bytes, ext: f.ext })
            added += 1
          }
          if (!added) toast('该目录下没有找到可识别的工程文件', 'warn')
          else {
            toast(`找到 ${added} 个工程文件`, 'ok')
            previewResult = null
            renderSources()
          }
        } catch (err) {
          toast(`扫描失败：${err.message}`, 'err')
        }
      },
    })
  }

  function renderSources() {
    mount(fileRows, null)
    if (!sources.length) {
      fileRows.appendChild(h('div.empty', { style: { padding: '20px' } }, [
        h('p.small', '还没有添加文件'),
      ]))
      return
    }
    sources.forEach((s, i) => {
      fileRows.appendChild(h('div.file-row', [
        icon(s.path ? 'file' : 'upload', 14),
        h('span.fname.truncate', { title: s.path ?? s.name }, s.name),
        h('span.fext', s.ext.replace('.', '') || '?'),
        h('span.tiny.dim.nowrap', s.size ? formatBytes(s.size) : ''),
        h('button.btn.btn-ghost.btn-icon.btn-sm', {
          title: '移除',
          onclick: () => {
            sources.splice(i, 1)
            previewResult = null
            renderSources()
            renderPreview()
          },
        }, [icon('x', 12)]),
      ]))
    })
  }

  /* ---------------- 目标格式 ---------------- */
  const formatPicker = h('div.format-picker')
  function renderFormats() {
    mount(formatPicker, null)
    for (const f of state.formats) {
      const usable = f.available && f.canWrite !== false
      formatPicker.appendChild(
        h(`button.format-chip${f.id === settings.targetFormat ? '.selected' : ''}`, {
          disabled: !usable,
          title: usable ? (f.fidelity?.notes ?? '') : (f.reason ?? '模块未就绪'),
          onclick: () => {
            settings.targetFormat = f.id
            saveSettings(settings)
            renderFormats()
            renderPreview()
          },
        }, [
          h('span.fc-name', f.name),
          h('span.fc-meta', usable ? f.exts.join(' / ') : '暂不可用'),
        ])
      )
    }
  }

  const targetCard = card({
    title: '目标格式',
    sub: '转换后要拿去哪个编辑器继续做',
    iconName: 'layers',
    body: formatPicker,
  })

  /* ---------------- 转换选项 ---------------- */
  const optionRows = h('div')
  function renderOptions() {
    mount(optionRows, null)
    for (const op of state.transformOps ?? []) {
      const value = settings.options[op.id]
      let control
      if (op.type === 'toggle') {
        control = h('button.switch', { class: `switch${value ? ' on' : ''}`, type: 'button' })
        control.addEventListener('click', () => {
          settings.options[op.id] = !settings.options[op.id]
          control.classList.toggle('on', settings.options[op.id])
          saveSettings(settings)
          renderPreview()
        })
      } else if (op.type === 'select') {
        control = h('select.select', {
          onchange: (e) => {
            settings.options[op.id] = e.target.value
            saveSettings(settings)
            renderPreview()
          },
        }, op.options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)))
      } else if (op.type === 'rangeKeys') {
        const lo = h('input.input', { type: 'number', value: value?.[0] ?? '', placeholder: '最低', style: { width: '62px' } })
        const hi = h('input.input', { type: 'number', value: value?.[1] ?? '', placeholder: '最高', style: { width: '62px' } })
        const apply = () => {
          const a = Number(lo.value)
          const b = Number(hi.value)
          settings.options[op.id] = Number.isFinite(a) && Number.isFinite(b) && lo.value && hi.value ? [a, b] : null
          saveSettings(settings)
        }
        lo.addEventListener('change', apply)
        hi.addEventListener('change', apply)
        control = h('div.row.gap-sm', [lo, h('span.dim', '~'), hi])
      } else {
        control = h('input.input', {
          type: 'number',
          value: value ?? 0,
          onchange: (e) => {
            settings.options[op.id] = Number(e.target.value) || 0
            saveSettings(settings)
            renderPreview()
          },
        })
      }
      optionRows.appendChild(h('div.option-row', [
        h('div.opt-label', [
          h('div.name', [op.label, op.unit ? h('span.dim.small', ` (${op.unit})`) : null]),
          op.hint ? h('div.hint', op.hint) : null,
        ]),
        h(`div.opt-control${op.type === 'toggle' || op.type === 'rangeKeys' ? '.wide' : ''}`, [control]),
      ]))
    }
  }

  const optionsCard = card({
    title: '转换处理',
    sub: '这些是 UtaFormatix 没有的后期处理，按需开启',
    iconName: 'tool',
    iconColor: 'purple',
    body: optionRows,
  })

  /* ---------------- 输出设置 ---------------- */
  const cfgOutDir = state.paths?.outputDir || ''
  const outDirHintEl = h('div')

  const dirInput = directoryInput({
    value: settings.outDir,
    title: '选择输出目录',
    placeholder: '留空 = 用设置里的默认输出目录…',
  })
  dirInput.el.querySelector('input').addEventListener('change', (e) => {
    // 清空 = 回到默认目录，别让用户以为「没目录所以不能转」
    settings.outDir = e.target.value.trim() || cfgOutDir
    if (!e.target.value.trim()) dirInput.setValue(cfgOutDir)
    saveSettings(settings)
    renderOutDirHint()
  })

  function renderOutDirHint() {
    mount(outDirHintEl, outputDirHint({
      custom: !!settings.outDir && settings.outDir !== cfgOutDir,
      fallback: cfgOutDir,
      onReset: () => {
        settings.outDir = cfgOutDir
        dirInput.setValue(cfgOutDir)
        saveSettings(settings)
        renderOutDirHint()
      },
    }))
  }
  renderOutDirHint()

  const nameInput = h('input.input.mono', {
    value: settings.nameTemplate,
    placeholder: '{name}_converted',
    onchange: (e) => {
      settings.nameTemplate = e.target.value || '{name}_converted'
      saveSettings(settings)
    },
  })

  const overwriteSwitch = h(`button.switch${settings.overwrite ? '.on' : ''}`, { type: 'button' })
  overwriteSwitch.addEventListener('click', () => {
    settings.overwrite = !settings.overwrite
    overwriteSwitch.classList.toggle('on', settings.overwrite)
    saveSettings(settings)
  })

  const splitSwitch = h(`button.switch${settings.splitTracks ? '.on' : ''}`, { type: 'button' })
  splitSwitch.addEventListener('click', () => {
    settings.splitTracks = !settings.splitTracks
    splitSwitch.classList.toggle('on', settings.splitTracks)
    saveSettings(settings)
  })

  const outputCard = card({
    title: '输出设置',
    sub: '结果存到哪里、叫什么名字',
    iconName: 'save',
    iconColor: 'info',
    body: h('div.col', [
      h('div.field', [h('label.field-label', '输出目录'), dirInput.el, outDirHintEl]),
      h('div.field', [
        h('label.field-label', '文件名模板'),
        nameInput,
        h('div.field-hint', '可用变量：{name} 原文件名、{format} 目标格式、{index} 序号、{track} 轨道名、{date} 日期'),
      ]),
      h('div.row', { style: { justifyContent: 'space-between' } }, [
        h('div', [h('div.name', { style: { fontSize: '12.5px' } }, '覆盖同名文件'), h('div.tiny.dim', '关闭时会自动加 (2) 后缀，避免覆盖')]),
        overwriteSwitch,
      ]),
      h('div.row', { style: { justifyContent: 'space-between' } }, [
        h('div', [h('div.name', { style: { fontSize: '12.5px' } }, '每轨导出为独立文件'), h('div.tiny.dim', '多轨工程拆成多个单轨工程')]),
        splitSwitch,
      ]),
    ]),
  })

  /* ---------------- 预检 ---------------- */
  const previewBox = h('div')
  function renderPreview() {
    mount(previewBox, null)
    if (!previewResult) return
    const { findings, before, after, target, input, logs } = previewResult
    const warns = findings.filter((f) => f.level === 'warn')
    previewBox.appendChild(h('div.col', [
      h('div.row', [
        h('span.chip.info', `${input.formatName} → ${target.name}`),
        h('span.chip', `${before.trackCount} 轨 / ${before.noteCount} 音符`),
        after.noteCount !== before.noteCount ? h('span.chip.warn', `处理后 ${after.noteCount} 音符`) : null,
      ]),
      warns.length
        ? alertBox('warn', `目标格式装不下下列数据，转换后会丢失：`, `发现 ${warns.length} 项失配`)
        : alertBox('ok', '没有发现数据失配，可以放心转换。', '预检通过'),
      ...warns.map((f) => h('div.finding.warn', [icon('alert', 14), h('div', f.message)])),
      ...findings.filter((f) => f.level === 'info').map((f) => h('div.finding.info', [icon('info', 14), h('div', f.message)])),
      logs?.length ? h('div.log', logs.map((l) => `· ${l}`).join('\n')) : null,
    ]))
  }

  async function maybeAutoPreview() {
    if (sources.length !== 1 || !settings.targetFormat) {
      previewResult = null
      renderPreview()
      return
    }
    try {
      const s = sources[0]
      const payload = {
        toFormat: settings.targetFormat,
        options: settings.options,
        ...(s.path ? { inputPath: s.path } : { name: s.name, base64: await toBase64(s.buffer) }),
      }
      previewResult = await api.post(s.path ? '/api/convert/preview' : '/api/convert/preview-upload', payload, 60000)
      renderPreview()
    } catch (err) {
      previewResult = null
      renderPreview()
      mount(previewBox, h('div.alert.alert-err', [icon('alert', 16), h('div.alert-body', `预检失败：${err.message}`)]))
    }
  }

  /* ---------------- 执行 ---------------- */
  const runBtn = button('开始转换', {
    variant: 'btn-primary',
    size: 'btn-lg',
    iconName: 'zap',
    onClick: runConversion,
  })
  const previewBtn = button('预检所选文件', {
    size: 'btn-lg',
    variant: '',
    iconName: 'shield',
    onClick: async () => {
      if (!sources.length) {
        toast('请先添加文件', 'warn')
        return
      }
      if (sources.length === 1) {
        await maybeAutoPreview()
        if (previewResult) toast('预检完成', 'ok')
        return
      }
      previewBtn.classList.add('loading')
      try {
        const reports = []
        for (const s of sources.slice(0, 12)) {
          const payload = {
            toFormat: settings.targetFormat,
            options: settings.options,
            ...(s.path ? { inputPath: s.path } : { name: s.name, base64: await toBase64(s.buffer) }),
          }
          try {
            reports.push(await api.post(s.path ? '/api/convert/preview' : '/api/convert/preview-upload', payload, 60000))
          } catch (err) {
            reports.push({ input: { name: s.name }, error: err.message, findings: [] })
          }
        }
        showBatchPreview(reports)
      } finally {
        previewBtn.classList.remove('loading')
      }
    },
  })

  const progressBox = h('div')
  const resultBox = h('div')

  function renderResult() {
    mount(resultBox, null)
    if (!lastResult) return
    const { summary, results } = lastResult
    resultBox.appendChild(h('div.col', [
      alertBox(
        summary.failed ? 'warn' : 'ok',
        `共 ${summary.total} 个文件：成功 ${summary.ok}，失败 ${summary.failed}；写出 ${summary.outputFiles} 个文件，用时 ${(summary.elapsedMs / 1000).toFixed(1)} 秒。`,
        summary.failed ? '部分完成' : '转换完成'
      ),
      h('div', [
        h('div.row', { style: { marginBottom: '8px' } }, [
          h('span.strong', '输出文件'),
          h('div.spacer'),
          button('打开输出目录', {
            size: 'btn-sm',
            iconName: 'folder',
            onClick: () => api.fsReveal(settings.outDir, false).catch((e) => toast(e.message, 'err')),
          }),
        ]),
        h('table.data', [
          h('thead', [h('tr', [h('th', '文件'), h('th', '轨'), h('th', '音符'), h('th', '大小'), h('th', '')])]),
          h('tbody', results.flatMap((r) =>
            r.ok
              ? r.outputs.map((o) => h('tr', [
                  h('td.truncate', { style: { maxWidth: '320px' } }, o.name),
                  h('td', String(o.tracks)),
                  h('td', String(o.notes)),
                  h('td', formatBytes(o.bytes)),
                  h('td', [
                    h('button.btn.btn-ghost.btn-icon.btn-sm', {
                      title: '在资源管理器中显示',
                      onclick: () => api.fsReveal(o.path, true).catch((e) => toast(e.message, 'err')),
                    }, [icon('folder', 12)]),
                  ]),
                ]))
              : [h('tr', [
                  h('td.truncate', { style: { maxWidth: '320px' } }, r.input.name),
                  h('td', { colspan: '4', style: { color: 'var(--err)' } }, r.error),
                ])]
          )),
        ]),
      ]),
    ]))
  }

  async function runConversion() {
    if (!sources.length) {
      toast('请先添加要转换的文件', 'warn')
      return
    }
    if (!settings.targetFormat) {
      toast('请选择目标格式', 'warn')
      return
    }
    if (!settings.outDir) {
      toast('请选择输出目录', 'warn')
      return
    }

    runBtn.classList.add('loading')
    mount(progressBox, null)
    mount(resultBox, null)

    const bar = progressBar(0, { size: 'lg' })
    const msg = h('div.small.muted', '正在准备…')
    const log = h('div.log', { style: { maxHeight: '180px' } })
    mount(progressBox, h('div.card', [
      h('div.card-head', [h('div.card-icon', [icon('activity', 16)]), h('h2', '转换进度')]),
      h('div.col', [bar, msg, log]),
    ]))

    try {
      const pathFiles = sources.filter((s) => s.path)
      const bufFiles = sources.filter((s) => !s.path)
      const jobs = []

      if (pathFiles.length) {
        const { jobId } = await api.convert({
          inputs: pathFiles.map((s) => s.path),
          toFormat: settings.targetFormat,
          outDir: settings.outDir,
          options: settings.options,
          nameTemplate: settings.nameTemplate,
          overwrite: settings.overwrite,
          splitTracks: settings.splitTracks,
        })
        jobs.push({ jobId, count: pathFiles.length })
      }
      if (bufFiles.length) {
        const payload = {
          files: await Promise.all(bufFiles.map(async (s) => ({ name: s.name, base64: await toBase64(s.buffer) }))),
          toFormat: settings.targetFormat,
          outDir: settings.outDir,
          options: settings.options,
          nameTemplate: settings.nameTemplate,
          overwrite: settings.overwrite,
          splitTracks: settings.splitTracks,
        }
        const { jobId } = await api.post('/api/convert/run-upload', payload, 300000)
        jobs.push({ jobId, count: bufFiles.length })
      }

      const collected = []
      for (const j of jobs) {
        await new Promise((resolve, reject) => {
          const stop = watchJob(j.jobId, {
            onUpdate: (job) => {
              bar.setBar(job.percent, job.status === 'error' ? 'error' : job.status === 'done' ? 'done' : '')
              msg.textContent = job.message ?? ''
              mount(log, (job.logs ?? []).join('\n'))
              log.scrollTop = log.scrollHeight
            },
            onDone: (job) => {
              collected.push(job.result)
              resolve()
            },
            onError: (err) => reject(err),
            onCancel: () => resolve(),
          })
        })
      }

      const merged = {
        results: collected.flatMap((r) => r?.results ?? []),
        summary: {
          total: collected.reduce((n, r) => n + (r?.summary?.total ?? 0), 0),
          ok: collected.reduce((n, r) => n + (r?.summary?.ok ?? 0), 0),
          failed: collected.reduce((n, r) => n + (r?.summary?.failed ?? 0), 0),
          outputFiles: collected.reduce((n, r) => n + (r?.summary?.outputFiles ?? 0), 0),
          elapsedMs: collected.reduce((n, r) => n + (r?.summary?.elapsedMs ?? 0), 0),
        },
      }
      lastResult = merged
      renderResult()
      const failed = merged.summary.failed
      toast(failed ? `转换完成，${failed} 个文件失败` : `转换完成，写出 ${merged.summary.outputFiles} 个文件`, failed ? 'warn' : 'ok')
    } catch (err) {
      toast(`转换失败：${err.message}`, 'err')
      mount(progressBox, h('div.alert.alert-err', [icon('alert', 16), h('div.alert-body', err.message)]))
    } finally {
      runBtn.classList.remove('loading')
    }
  }

  function showBatchPreview(reports) {
    const body = h('div.col', reports.map((r) =>
      h('div.card', { style: { padding: '12px' } }, [
        h('div.row', [
          h('span.strong', r.input?.name ?? '未知文件'),
          h('div.spacer'),
          r.error
            ? h('span.chip.err', '读取失败')
            : h('span.chip', `${r.before?.trackCount ?? 0} 轨 / ${r.before?.noteCount ?? 0} 音符`),
        ]),
        r.error
          ? h('div.finding.warn', [icon('alert', 14), h('div', r.error)])
          : h('div.col', { style: { marginTop: '8px' } }, (r.findings ?? []).map((f) =>
              h(`div.finding.${f.level}`, [icon(f.level === 'warn' ? 'alert' : 'info', 14), h('div', f.message)])
            )),
      ])
    ))
    modal({ title: `批量预检结果（${reports.length} 个文件）`, wide: true, body, footer: [button('知道了', { variant: 'btn-primary', onClick: () => document.querySelector('.modal-backdrop')?.remove() })] })
  }

  /* ---------------- 首屏渲染 ---------------- */
  mount(left, [sourceCard, targetCard, optionsCard])
  mount(right, [outputCard, previewBox, h('div.card', { style: { padding: '14px' } }, [
    h('div.col', [runBtn, previewBtn, h('div.tiny.dim', { style: { textAlign: 'center' } }, '全部处理在本机完成，不联网、不上传')]),
  ]), progressBox, resultBox])

  renderSources()
  renderFormats()
  renderOptions()

  return () => {
    if (activeJob) activeJob()
  }
}

/* ------------------------------------------------------------ 工具函数 */

async function filesFromDataTransfer(dt) {
  const out = []
  const items = [...(dt.items ?? [])]
  if (items.length && typeof items[0].getAsFileSystemHandle === 'function') {
    for (const item of items) {
      if (item.kind !== 'file') continue
      try {
        const handle = await item.getAsFileSystemHandle()
        if (handle?.kind === 'file') out.push(await handle.getFile())
      } catch {
        /* 退回 dt.files */
      }
    }
  }
  if (!out.length && dt.files?.length) out.push(...dt.files)
  return out
}

/** ArrayBuffer → base64（分块，避免大文件爆栈） */
export async function toBase64(buffer) {
  if (!buffer) return ''
  const bytes = new Uint8Array(buffer)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}

export default { render }
