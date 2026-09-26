/**
 * 音频工具视图
 *
 * 左边：本机 ffmpeg 干实际活 —— 格式转换（导出 WAV/FLAC/MP3）、从视频抽音轨、
 *      变调（半音）、变速（倍率）、裁剪片段、响度标准化。
 *      其中「裁剪片段」是可视化编辑器（波形 + 试听 + 拖端点 + 剪刀分段 + 分段导出），
 *      实现在 components/waveEditor.js。
 * 右边：人声分离两条路 —— 在线 MVSEP（外链，需上传）与本机 UVR（离线，音频不出机器）。
 *
 * 长任务一律走 api.audioRun + watchJob，进度与日志实时显示，随时可取消。
 */

import { api, watchJob } from '../api.js'
import {
  h, mount, icon, toast, button, card, progressBar, alertBox,
  formatBytes, formatDuration,
} from '../ui.js'
import { parseTime, formatTime } from '../timecode.js'
import { createWaveEditor, rawUrl } from '../components/waveEditor.js'
import { pickDirectory, directoryInput } from '../components/dirPicker.js'

const LS_KEY = 'fandiao.audio.settings'
const MVSEP_URL = 'https://mvsep.com/zh'

const OPS = [
  { id: 'convert', name: '格式转换', desc: '导出 WAV / FLAC / MP3…', iconName: 'swap' },
  { id: 'extract', name: '提取音频', desc: '把 MV / 视频的音轨抽出来', iconName: 'film' },
  { id: 'pitch', name: '变调', desc: '按半音升降，时长不变', iconName: 'music' },
  { id: 'tempo', name: '变速', desc: '按倍率快慢，音高不变', iconName: 'activity' },
  { id: 'trim', name: '裁剪片段', desc: '波形上拖端点、切片分段导出', iconName: 'scissors' },
  { id: 'normalize', name: '响度标准化', desc: '伴奏与干声拉到同一响度', iconName: 'wave' },
]

const AUDIO_EXTS = ['wav', 'mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wma', 'aiff', 'aif', 'ape', 'alac']

const defaultSettings = {
  action: 'convert',
  input: '',
  outDir: '',
  outDirTouched: false,
  outName: '',
  nameEdited: false,
  lastDir: '',
  convertFormat: 'wav',
  sampleRate: 0,
  channels: 0,
  semitones: 0,
  ratio: 1,
  startSec: 0,
  endSec: 0,
  targetLufs: -14,
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(LS_KEY)
    if (!raw) return { ...defaultSettings }
    return { ...defaultSettings, ...JSON.parse(raw) }
  } catch {
    return { ...defaultSettings }
  }
}

/** 只读探测：文件存在就能拿到 info（装了 ffmpeg 才有详细字段） */
function dirName(p) {
  const s = String(p ?? '').replace(/[/\\]+$/, '')
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
  return i > 0 ? s.slice(0, i) : ''
}

function baseName(p) {
  const s = String(p ?? '')
  const i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'))
  return i >= 0 ? s.slice(i + 1) : s
}

function stripExt(name) {
  return String(name ?? '').replace(/\.[^.\\/]+$/, '')
}

function extOf(name) {
  const m = String(name ?? '').match(/\.([^.\\/]+)$/)
  return m ? m[1].toLowerCase() : ''
}

function joinPath(dir, name) {
  const d = String(dir ?? '').replace(/[/\\]+$/, '')
  const n = String(name ?? '').replace(/^[/\\]+/, '')
  if (!d) return n
  return `${d}\\${n}`
}

export async function render(ctx) {
  const { container, headerActions, state, navigate, params } = ctx
  const settings = loadSettings()
  if (params?.input) settings.input = String(params.input)

  const stops = new Set()
  const waiters = new Set()
  let disposed = false

  let probe = null
  let probeLoading = false
  let nameEdited = !!settings.nameEdited
  let lastResult = null

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

  function save() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(settings))
    } catch {
      /* 存不了不影响使用 */
    }
  }

  /* ------------------------------------------------------------ 任务订阅 */

  function waitJob(jobId, onUpdate) {
    return new Promise((resolve) => {
      let settled = false
      let stop = null
      const finish = (payload) => {
        if (settled) return
        settled = true
        waiters.delete(finish)
        if (stop) stops.delete(stop)
        resolve(payload)
      }
      waiters.add(finish)
      stop = watchJob(jobId, {
        onUpdate: (job) => {
          if (!disposed) onUpdate?.(job)
        },
        onDone: (job) => finish({ status: 'done', job }),
        onError: (err, job) => finish({ status: 'error', error: err, job }),
        onCancel: (job) => finish({ status: 'canceled', job }),
      })
      stops.add(stop)
    })
  }

  /* ------------------------------------------------------------ 头部动作 */

  const toolChip = h('span.chip')
  function renderHeader() {
    const ok = !!state.tools?.ffmpeg?.available
    mount(toolChip, ok ? 'ffmpeg 已就绪' : 'ffmpeg 未安装')
    toolChip.className = `chip${ok ? ' ok' : ' warn'}`
    mount(headerActions, [
      toolChip,
      button('打开输出目录', {
        size: 'btn-sm',
        iconName: 'folder',
        onClick: () => {
          const dir = dirInput.getValue() || settings.outDir || dirName(settings.input)
          if (!dir) {
            toast('还没有确定输出目录', 'warn')
            return
          }
          api.fsReveal(dir, false).catch((e) => toast(e.message, 'err'))
        },
      }),
    ])
  }

  /* ------------------------------------------------------------ 布局 */

  const left = h('div.col.gap-lg')
  const right = h('div.col.gap-lg')
  mount(container, h('div.audio-layout', [left, right]))

  /* ------------------------------------------------------------ 输入文件 */

  const inputEl = h('input.input.mono', {
    value: settings.input,
    placeholder: '音频 / 视频文件的完整路径，例如 H:\\音乐\\Never Gonna Give You Up.mp4',
    spellcheck: 'false',
    autocomplete: 'off',
  })
  inputEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commitInput()
  })
  inputEl.addEventListener('change', () => commitInput())

  const filePicker = h('input', { type: 'file', accept: 'audio/*,video/*', style: { display: 'none' } })
  filePicker.addEventListener('change', async () => {
    const f = filePicker.files?.[0]
    filePicker.value = ''
    if (!f) return
    await acceptBrowserFile(f.name)
  })

  const MEDIA_EXTS = new Set([...AUDIO_EXTS, 'mp4', 'mkv', 'flv', 'mov', 'webm', 'avi', 'ts', 'm4v', 'wmv'])

  const probeBox = h('div')

  async function probePath(path) {
    try {
      const { info } = await api.audioProbe(path)
      return info ?? null
    } catch {
      return null
    }
  }

  async function acceptBrowserFile(name) {
    const dir = settings.lastDir || dirName(settings.input)
    if (dir) {
      const candidate = joinPath(dir, name)
      const info = await probePath(candidate)
      if (info) {
        setInput(candidate)
        toast(`已按上次的文件夹拼出路径：${candidate}`, 'info')
        return
      }
    }
    pickDirectory({
      title: `请选择《${name}》所在的文件夹`,
      initial: dir || state.paths?.downloadDir || '',
      onPick: (d) => {
        settings.lastDir = d
        save()
        setInput(joinPath(d, name))
        toast('文件夹已记住，下次「选文件」会自动拼出完整路径', 'info')
      },
    })
  }

  function commitInput() {
    const next = inputEl.value.trim()
    const changed = next !== settings.input
    settings.input = next
    if (changed) {
      nameEdited = false
      settings.nameEdited = false
    }
    save()
    if (changed) {
      syncOutDir()
      refreshName()
      void probeFile(true)
    }
  }

  function setInput(path) {
    settings.input = path
    inputEl.value = path
    settings.lastDir = dirName(path) || settings.lastDir
    nameEdited = false
    settings.nameEdited = false
    save()
    syncOutDir()
    refreshName()
    probe = null
    renderProbe()
    void probeFile(false)
  }

  const inputCard = card({
    title: '素材',
    sub: '选一个音频或视频文件，所有处理都在本机完成',
    iconName: 'music',
    iconColor: 'purple',
    actions: h('div.row.gap-sm', [
      button('选文件夹', { size: 'btn-sm', iconName: 'folder', onClick: pickFolder }),
      button('选文件', { size: 'btn-sm', variant: 'btn-primary', iconName: 'plus', onClick: () => filePicker.click() }),
    ]),
    body: h('div.col.gap-lg', [
      h('div.field', [
        h('label.field-label', '文件路径'),
        h('div.input-group', [
          inputEl,
          button('清空', {
            variant: 'btn-ghost',
            iconName: 'x',
            onClick: () => {
              settings.input = ''
              inputEl.value = ''
              probe = null
              save()
              renderProbe()
              refreshName()
            },
          }),
        ]),
        h('div.field-hint', '浏览器的文件选择器拿不到完整磁盘路径，所以：先「选文件夹」再「选文件」会自动拼好路径（记住一次就行）；也可以直接在资源管理器里 Shift+右键 →「复制文件地址」粘进来。'),
      ]),
      filePicker,
      probeBox,
    ]),
  })

  function pickFolder() {
    pickDirectory({
      title: '选择音频所在的文件夹',
      initial: settings.lastDir || dirName(settings.input) || state.paths?.downloadDir || '',
      onPick: (d) => {
        settings.lastDir = d
        save()
        if (settings.input && dirName(settings.input) !== d) {
          const composed = joinPath(d, baseName(settings.input))
          const exts = MEDIA_EXTS.has(extOf(composed)) ? composed : ''
          if (exts) {
            setInput(composed)
            toast(`已按新文件夹重算路径：${composed}`, 'info')
            return
          }
        }
        toast('已记住这个文件夹，接着点「选文件」就会自动拼出完整路径', 'ok')
      },
    })
  }

  async function probeFile(notify) {
    const path = settings.input.trim()
    if (!path) {
      probe = null
      renderProbe()
      return
    }
    if (!state.tools?.ffmpeg?.available) {
      probe = null
      renderProbe()
      return
    }
    probeLoading = true
    renderProbe()
    try {
      const { info } = await api.audioProbe(path)
      probe = info
    } catch (err) {
      probe = { error: err.message }
      if (notify) toast(`读不到这个文件：${err.message}`, 'err')
    } finally {
      probeLoading = false
      renderProbe()
      renderOpOptions()
      renderOutPath()
    }
  }

  function channelsText(n) {
    const c = Number(n)
    if (c === 1) return '单声道'
    if (c === 2) return '立体声'
    return `${c} 声道`
  }

  function renderProbe() {
    const path = settings.input.trim()
    if (!path) {
      mount(probeBox, h('div.finding.info', [icon('info', 14), h('div', '还没有选文件。选好之后这里会显示时长、编码、采样率、声道；选视频的话还会显示分辨率。')]))
      return
    }
    if (probeLoading) {
      mount(probeBox, h('div.skeleton', { style: { height: '54px', width: '100%' } }))
      return
    }
    if (!probe) {
      mount(probeBox, state.tools?.ffmpeg?.available
        ? h('div.finding.info', [icon('info', 14), h('div', '还没有读取这个文件的信息。')])
        : h('div.finding.warn', [icon('alert', 14), h('div', '装了 ffmpeg 之后，这里会显示时长、编码、采样率与声道（现在读不出来，但不影响先选好文件）。')]))
      return
    }
    if (probe.error) {
      mount(probeBox, h('div.finding.warn', [icon('alert', 14), h('div', [h('div.strong', '读不到这个文件'), h('div', esc(probe.error))])]))
      return
    }
    if (probe.available === false) {
      mount(probeBox, h('div.finding.warn', [icon('alert', 14), h('div', '装了 ffmpeg 之后，这里会显示时长、编码、采样率与声道（现在读不出来，但不影响先选文件）。')]))
      return
    }
    if (probe.probed === false) {
      mount(probeBox, h('div.finding.info', [icon('info', 14), h('div', probe.note ?? '没能读出媒体信息')]))
      return
    }

    const chips = [
      ['时长', probe.durationSec ? formatDuration(probe.durationSec) : '未知'],
      probe.formatName ? ['容器', probe.formatName] : null,
      probe.sizeBytes ? ['大小', formatBytes(probe.sizeBytes)] : null,
      probe.bitrate ? ['总码率', `${Math.round(probe.bitrate / 1000)} kbps`] : null,
      probe.audio?.codec ? ['音频编码', probe.audio.codec] : null,
      probe.audio?.sampleRate ? ['采样率', `${probe.audio.sampleRate} Hz`] : null,
      probe.audio?.channels ? ['声道', channelsText(probe.audio.channels)] : null,
      probe.video ? ['视频', `${probe.video.codec ?? ''} ${probe.video.width}x${probe.video.height}`.trim()] : null,
    ].filter(Boolean)

    mount(probeBox, h('div.col.gap-sm', [
      h('div.row', [
        h('span.strong', { style: { fontSize: '12.5px' } }, baseName(path)),
        h('span.chip', probe.audio ? '含音轨' : '无音轨'),
        probe.video ? h('span.chip.info', '含视频轨') : null,
        h('div.spacer'),
        button('重新读取', { size: 'btn-sm', variant: 'btn-ghost', iconName: 'refresh', onClick: () => void probeFile(true) }),
      ]),
      h('div.chip-group', chips.map(([k, v]) => h('span.chip', [h('span.dim', k), String(v)]))),
    ]))
  }

  /* ------------------------------------------------------------ 操作选择 */

  const opGrid = h('div.op-grid')
  const opOptions = h('div.col')
  const opHint = h('div.tiny.dim')

  function renderOps() {
    mount(opGrid, OPS.map((op) => h(`button.op-card${settings.action === op.id ? '.selected' : ''}`, {
      type: 'button',
      title: op.desc,
      onclick: () => {
        settings.action = op.id
        nameEdited = false
        settings.nameEdited = false
        save()
        renderOps()
        renderOpOptions()
        refreshName()
      },
    }, [
      icon(op.iconName, 18),
      h('div.op-name', op.name),
      h('div.op-desc', op.desc),
    ])))
  }

  const opCard = card({
    title: '处理操作',
    sub: '一次处理一件事，选好参数再点下面的「开始处理」',
    iconName: 'tool',
    body: h('div.col.gap-lg', [opGrid, opOptions]),
  })

  function formatField() {
    const entries = Object.entries(state.audioFormats ?? {})
    if (!entries.length) return alertBox('warn', '没有读到可用的音频格式列表，请刷新页面重试。', '格式列表为空')
    return h('div.field', [
      h('label.field-label', '输出格式'),
      h('div.format-picker', entries.map(([id, f]) => h(`button.format-chip${settings.convertFormat === id ? '.selected' : ''}`, {
        type: 'button',
        title: f.lossless ? '无损格式' : '有损压缩格式',
        onclick: () => {
          settings.convertFormat = id
          save()
          renderOpOptions()
          refreshName()
        },
      }, [
        h('span.fc-name', [f.label, f.lossless ? h('span.chip.ok', { style: { marginLeft: '5px' } }, '无损') : null]),
        h('span.fc-meta', f.lossless ? `${f.ext} · 不二次损失，适合继续做后期` : `${f.ext} · 有损压缩，体积小`),
      ]))),
      h('div.field-hint', '带「无损」标记的是 WAV / FLAC：做后期就用它们；只是想试听、传手机，MP3 320k 足够。'),
    ])
  }

  function selectRow(labelText, value, options, onPick) {
    const sel = h('select.select', {
      onchange: (e) => onPick(Number(e.target.value)),
    }, options.map((o) => h('option', { value: String(o.value), selected: Number(value) === Number(o.value) }, o.label)))
    return h('div.field', [h('label.field-label', labelText), sel])
  }

  function pitchField() {
    const num = h('input.input', { type: 'number', step: '1', min: '-24', max: '24', value: String(settings.semitones), style: { width: '90px' } })
    num.addEventListener('change', () => {
      const v = Math.max(-24, Math.min(24, Math.round(Number(num.value) || 0)))
      settings.semitones = v
      save()
      renderOpOptions()
      refreshName()
    })
    const presets = [-12, -7, -5, -3, -2, -1, 1, 2, 3, 5, 7, 12]
    const ratio = Math.pow(2, Number(settings.semitones) / 12)
    return h('div.col.gap-sm', [
      h('div.row.gap-sm', [
        h('span.small', { style: { width: '42px' } }, '半音'),
        num,
        h('span.tiny.dim', `频率比 ×${ratio.toFixed(4)}（${settings.semitones > 0 ? '升调' : settings.semitones < 0 ? '降调' : '还没设置'}）`),
      ]),
      h('div.row-wrap.gap-sm', presets.map((n) => button(`${n > 0 ? '+' : ''}${n}`, {
        size: 'btn-sm',
        variant: Number(settings.semitones) === n ? 'btn-primary' : '',
        onClick: () => {
          settings.semitones = n
          save()
          renderOpOptions()
          refreshName()
        },
      }))),
      h('div.field-hint', '正数升调、负数降调；±12 半音以内精度最好。变调靠重采样加时间补偿实现，时长不变。'),
    ])
  }

  function tempoField() {
    const num = h('input.input', { type: 'number', step: '0.05', min: '0.1', max: '10', value: String(settings.ratio), style: { width: '90px' } })
    num.addEventListener('change', () => {
      const v = Math.max(0.1, Math.min(10, Number(num.value) || 1))
      settings.ratio = v
      save()
      renderOpOptions()
      refreshName()
    })
    const presets = [0.5, 0.75, 0.9, 1.1, 1.25, 1.5, 2]
    return h('div.col.gap-sm', [
      h('div.row.gap-sm', [
        h('span.small', { style: { width: '42px' } }, '倍率'),
        num,
        h('span.tiny.dim', Number(settings.ratio) > 1 ? '加速' : Number(settings.ratio) < 1 ? '减速' : '原速'),
      ]),
      h('div.row-wrap.gap-sm', presets.map((n) => button(`×${n}`, {
        size: 'btn-sm',
        variant: Number(settings.ratio) === n ? 'btn-primary' : '',
        onClick: () => {
          settings.ratio = n
          save()
          renderOpOptions()
          refreshName()
        },
      }))),
      h('div.field-hint', '大于 1 是加速，小于 1 是减速；音高保持不变。超过 2 倍会自动串联处理。'),
    ])
  }

  /* ------------------------------------------------------------ 裁剪编辑器 */

  /**
   * 波形编辑器只建一次。
   * renderOpOptions() 会随动作切换反复重挂 opOptions，每次新建编辑器会漏掉
   * ResizeObserver / audio 元素、并丢掉已经切好的分段 —— 所以这里建好留着复用。
   */
  let waveEditor = null
  let editorEl = null

  function buildEditor() {
    const startEl = h('input.input.mono', {
      value: formatTime(settings.startSec),
      style: { width: '104px' },
      spellcheck: 'false',
      title: '支持 83 / 1:23 / 1:23.456 / 1:02:03',
    })
    const endEl = h('input.input.mono', {
      value: formatTime(settings.endSec),
      style: { width: '104px' },
      spellcheck: 'false',
      title: '支持 83 / 1:23 / 1:23.456 / 1:02:03',
    })
    const infoEl = h('span.tiny.dim')

    waveEditor = createWaveEditor({
      onChange: ({ start, end, count }) => {
        settings.startSec = start
        settings.endSec = end
        save()
        syncInputs()
        infoEl.textContent = `${formatDuration(Math.max(0, end - start))} · 共 ${count} 段`
        renderOutPath()
      },
      // 单段导出：文件名跟「开始处理」一致；多段时补 _02 这种序号，不然互相覆盖
      onExport: (seg) => void run({ segments: [seg] }),
      onExportAll: () => void run({ all: true }),
    })

    function syncInputs() {
      if (!waveEditor) return
      const sg = waveEditor.segments[waveEditor.selectedIndex]
      if (!sg) return
      // 正在输入的那一框别抢，等用户敲完 Enter / 失焦再同步
      if (document.activeElement !== startEl) startEl.value = formatTime(sg.start)
      if (document.activeElement !== endEl) endEl.value = formatTime(sg.end)
    }

    const applyField = (el, which) => {
      const sec = parseTime(el.value)
      if (sec === null) {
        toast('时间看不懂。写成 1:23.456 这样（也可以只写 83）', 'warn')
        syncInputs()
        return
      }
      const i = waveEditor.selectedIndex
      const sg = waveEditor.segments[i]
      waveEditor.setSegment(i, which === 'start' ? sec : sg.start, which === 'end' ? sec : sg.end)
    }

    for (const [el, which] of [[startEl, 'start'], [endEl, 'end']]) {
      el.addEventListener('change', () => applyField(el, which))
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') el.blur()
      })
    }

    editorEl = h('div.col.gap-sm.wave-field', [
      waveEditor.el,
      h('div.row-wrap.gap-sm', [
        h('span.small', { style: { width: '84px' } }, '起点 / 终点'),
        startEl,
        h('span.dim', '→'),
        endEl,
        button('整段', {
          size: 'btn-sm',
          variant: 'btn-ghost',
          title: '把选区拉回整个文件',
          onClick: () => {
            const i = waveEditor.selectedIndex
            waveEditor.setSegment(i, 0, waveEditor.duration)
          },
        }),
        h('div.spacer'),
        infoEl,
      ]),
      h('div.field-hint', [
        '时间按「分:秒.毫秒」填，例如 1:23.456（直接写 83 也认）。',
        '拖波形两端的把手裁剪，和输入框双向同步：拖完框里会变，改完框里波形跟着动。',
        '剪刀模式下点波形等于在那里切开；快捷键 S = 在播放头切开，Ctrl+Z 撤销，Delete 删除选中段。',
        '裁剪结果固定导出 WAV。',
      ].join('')),
    ])

    syncInputs()
    infoEl.textContent = ''
  }

  function trimField() {
    if (!waveEditor) buildEditor()
    return editorEl
  }

  /** 输入文件 / 探测结果变了 → 把新素材交给编辑器 */
  function syncEditor() {
    if (!waveEditor) return
    const path = settings.input.trim()
    const usable = path && !probe?.error
    waveEditor.setSource(usable ? rawUrl(path) : '', Number(probe?.durationSec) || 0, settings)
  }

  function normalizeField() {
    return selectRow('目标响度（LUFS）', settings.targetLufs, [
      { value: -9, label: '-9 LUFS · 很响，适合短视频 / 翻唱投稿' },
      { value: -14, label: '-14 LUFS · 常用标准，推荐' },
      { value: -16, label: '-16 LUFS · 保守一点，留动态' },
      { value: -23, label: '-23 LUFS · 广播标准（EBU R128）' },
    ], (v) => {
      settings.targetLufs = v
      save()
    })
  }

  function renderOpOptions() {
    const a = settings.action
    const rows = []
    if (a === 'convert' || a === 'extract') {
      rows.push(formatField())
      rows.push(h('div.grid.grid-2', [
        selectRow('采样率', settings.sampleRate, [
          { value: 0, label: '保持原样' },
          { value: 44100, label: '44100 Hz（CD）' },
          { value: 48000, label: '48000 Hz（视频常用）' },
          { value: 22050, label: '22050 Hz（体积小）' },
          { value: 96000, label: '96000 Hz（高采样）' },
        ], (v) => {
          settings.sampleRate = v
          save()
        }),
        selectRow('声道', settings.channels, [
          { value: 0, label: '保持原样' },
          { value: 1, label: '单声道' },
          { value: 2, label: '立体声' },
        ], (v) => {
          settings.channels = v
          save()
        }),
      ]))
      if (a === 'extract') {
        rows.push(h('div.finding.info', [
          icon('info', 14),
          h('div', '从 MV 里抽出音轨：B 站的音频轨一般是 AAC，转成 WAV 之后再做后期不会二次损失。视频轨会被丢掉。'),
        ]))
      }
    } else if (a === 'pitch') {
      rows.push(pitchField())
    } else if (a === 'tempo') {
      rows.push(tempoField())
    } else if (a === 'trim') {
      rows.push(trimField())
    } else if (a === 'normalize') {
      rows.push(normalizeField())
      rows.push(h('div.finding.info', [icon('info', 14), h('div', '响度标准化用 EBU R128 算法。分离出来的伴奏通常比人声轻，标准化之后对轨会省事很多。')]))
    }
    mount(opOptions, rows)
    mount(opHint, `当前操作：${OPS.find((o) => o.id === a)?.name ?? a}`)
    syncEditor()
  }

  /* ------------------------------------------------------------ 输出 */

  const dirInput = directoryInput({
    value: settings.outDir,
    title: '选择输出目录',
    placeholder: '默认与输入文件同一目录…',
  })
  const dirEl = dirInput.el.querySelector('input')
  const onDirEdit = () => {
    settings.outDir = dirInput.getValue()
    settings.outDirTouched = true
    save()
    renderOutPath()
  }
  dirEl.addEventListener('input', onDirEdit)
  dirEl.addEventListener('change', onDirEdit)

  const nameEl = h('input.input.mono', {
    value: settings.outName,
    placeholder: '自动按操作推断，例如 xxx_+3半音.wav',
    oninput: (e) => {
      nameEdited = true
      settings.nameEdited = true
      settings.outName = e.target.value
      save()
      renderOutPath()
    },
  })

  const outPathEl = h('div.mono.small')

  function syncOutDir() {
    if (settings.outDirTouched && settings.outDir) return
    const d = dirName(settings.input)
    if (d) {
      settings.outDir = d
      dirInput.setValue(d)
      save()
    }
  }

  function formatExt() {
    const f = state.audioFormats?.[settings.convertFormat]
    return f?.ext ?? '.wav'
  }

  function keepAudioExt() {
    const e = extOf(settings.input)
    return e && AUDIO_EXTS.includes(e) ? `.${e}` : '.wav'
  }

  function inferOutName() {
    const base = stripExt(baseName(settings.input)) || 'output'
    const semi = Number(settings.semitones) || 0
    const ratio = Number(settings.ratio) || 1
    switch (settings.action) {
      case 'convert':
        return `${base}${formatExt()}`
      case 'extract':
        return `${base}_音频${formatExt()}`
      case 'pitch':
        return `${base}${semi ? `_${semi > 0 ? '+' : ''}${semi}半音` : '_变调'}${keepAudioExt()}`
      case 'tempo':
        return `${base}_x${ratio}${keepAudioExt()}`
      case 'trim':
        return `${base}_片段.wav`
      case 'normalize':
        return `${base}_标准化.wav`
      default:
        return `${base}.wav`
    }
  }

  function refreshName() {
    if (!nameEdited) {
      settings.outName = inferOutName()
      nameEl.value = settings.outName
      save()
    }
    renderOutPath()
  }

  function resolveOutput() {
    const input = settings.input.trim()
    const outDir = (dirInput.getValue() || settings.outDir || dirName(input) || '').trim()
    const name = (nameEl.value.trim() || inferOutName())
    return { outDir, name, output: joinPath(outDir, name) }
  }

  function renderOutPath() {
    const { output } = resolveOutput()
    const same = settings.input.trim() && output.toLowerCase() === settings.input.trim().toLowerCase()
    mount(outPathEl, [
      h('span.dim', '将写入：'),
      h('span', { style: { color: same ? 'var(--err)' : 'var(--text-1)' } }, output || '（还没确定）'),
      same ? h('span.chip.err', '不能覆盖输入文件') : null,
    ])
  }

  const outCard = card({
    title: '输出',
    sub: '默认跟输入文件放在一起，可以改',
    iconName: 'save',
    iconColor: 'info',
    actions: button('与输入同目录', {
      size: 'btn-sm',
      variant: 'btn-ghost',
      iconName: 'refresh',
      onClick: () => {
        settings.outDirTouched = false
        const d = dirName(settings.input)
        if (!d) {
          toast('还没选输入文件', 'warn')
          return
        }
        settings.outDir = d
        dirInput.setValue(d)
        save()
        renderOutPath()
      },
    }),
    body: h('div.col', [
      h('div.field', [h('label.field-label', '输出目录'), dirInput.el]),
      h('div.field', [
        h('label.field-label', '输出文件名'),
        nameEl,
        h('div.field-hint', '按当前操作自动推断（例如 xxx.wav、xxx_+3半音.wav、xxx_x1.25.wav）；手动改过之后就不再自动覆盖，换操作会重新推断。'),
      ]),
      outPathEl,
      opHint,
    ]),
  })

  /* ------------------------------------------------------------ 执行 */

  const jobHost = h('div')
  const resultHost = h('div')

  function buildOptions(action) {
    switch (action) {
      case 'convert':
      case 'extract': {
        const o = { format: settings.convertFormat }
        if (Number(settings.sampleRate)) o.sampleRate = Number(settings.sampleRate)
        if (Number(settings.channels)) o.channels = Number(settings.channels)
        return o
      }
      case 'pitch':
        return { semitones: Number(settings.semitones) }
      case 'tempo':
        return { ratio: Number(settings.ratio) }
      case 'trim':
        return { startSec: Number(settings.startSec) || 0, endSec: Number(settings.endSec) || 0 }
      case 'normalize':
        return { targetLufs: Number(settings.targetLufs) || -14 }
      default:
        return {}
    }
  }

  function validate(action, options) {
    if (!state.audioFormats?.[settings.convertFormat] && (action === 'convert' || action === 'extract')) {
      return '输出格式不可用，请重新选一个'
    }
    if (action === 'pitch' && !options.semitones) return '变调量不能是 0，先点一个半音数'
    if (action === 'tempo' && !(options.ratio > 0)) return '速度倍率必须大于 0'
    if (action === 'trim' && !(options.endSec > options.startSec)) return '裁剪的「结束」要大于「开始」'
    return null
  }

  function renderResult(res) {
    if (!res) {
      mount(resultHost, null)
      return
    }
    mount(resultHost, h('div.card', [
      h('div.card-head', [
        h('div.card-icon', [icon('check', 16)]),
        h('div', [h('h2', '处理完成'), h('div.sub', baseName(res.output))]),
        h('div.spacer'),
        h('span.chip', OPS.find((o) => o.id === res.action)?.name ?? res.action),
      ]),
      h('div.col.gap-sm', [
        h('div.mono.small.truncate', { title: res.output }, res.output),
        h('div.row-wrap.gap-sm', [
          button('打开文件', { size: 'btn-sm', variant: 'btn-primary', iconName: 'play', onClick: () => api.fsOpen({ path: res.output }).catch((e) => toast(e.message, 'err')) }),
          button('在资源管理器中显示', { size: 'btn-sm', iconName: 'folder', onClick: () => api.fsReveal(res.output, true).catch((e) => toast(e.message, 'err')) }),
          button('用这个结果继续处理', {
            size: 'btn-sm',
            iconName: 'refresh',
            onClick: () => {
              setInput(res.output)
              toast('已把处理结果设为新的输入', 'ok')
            },
          }),
        ]),
      ]),
    ]))
  }

  /**
   * 裁剪导出任务表：一段一个文件。
   * 编辑器里已经切成多段时，文件名一律补 _01 _02 —— 不然单段导出会互相覆盖。
   */
  function trimJobs({ all = false, segments: pick = null } = {}) {
    const segs = waveEditor
      ? waveEditor.segments
      : [{ start: Number(settings.startSec) || 0, end: Number(settings.endSec) || 0 }]
    const sel = waveEditor ? waveEditor.selectedIndex : 0
    const list = all
      ? segs.map((sg, i) => ({ start: sg.start, end: sg.end, i }))
      : (pick ?? [segs[clampIndex(sel, segs.length)]]).map((sg) => ({
          start: sg.start,
          end: sg.end,
          // 单段导出带的是 index（分段列表里的序号），「开始处理」没带就用当前选中段
          i: Number.isFinite(sg.index) ? sg.index : clampIndex(sel, segs.length),
        }))

    const { outDir, name } = resolveOutput()
    const ext = extOf(name) ? `.${extOf(name)}` : ''
    const numbered = segs.length > 1
    return list.map((sg) => ({
      action: 'trim',
      options: { startSec: sg.start, endSec: sg.end },
      output: joinPath(outDir, numbered ? `${stripExt(name)}_${String(sg.i + 1).padStart(2, '0')}${ext}` : name),
    }))
  }

  function clampIndex(i, len) {
    return Math.min(Math.max(0, Number(i) || 0), Math.max(0, len - 1))
  }

  /**
   * @param {{all?:boolean, segments?:{start:number,end:number,index?:number}[]}} [what]
   *   all      —— 导出全部分段（分段列表里的「全部导出」）
   *   segments —— 只导出这几段（分段列表每行的「导出」）
   *   都不传    —— 「开始处理」：裁剪时导出当前选中的那一段，其它动作照旧
   */
  async function run(what = {}) {
    const input = settings.input.trim()
    if (!input) {
      toast('请先选择要处理的音频文件', 'warn')
      inputEl.focus()
      return
    }
    if (!/^[a-zA-Z]:[\\/]|^\\\\|^\//.test(input)) {
      toast('请输入完整路径，例如 H:\\音乐\\mv.mp4', 'warn')
      inputEl.focus()
      return
    }
    if (!state.tools?.ffmpeg?.available) {
      toast('未检测到 ffmpeg：它随程序分发，不需要联网下载。若 tools 目录缺失，从压缩包里重新把 tools 解压到程序根目录。', 'warn')
      return
    }
    const action = settings.action
    const { outDir } = resolveOutput()
    if (!outDir) {
      toast('请选择输出目录', 'warn')
      return
    }

    const jobs = action === 'trim' ? trimJobs(what) : [{ action, output: resolveOutput().output, options: buildOptions(action) }]
    if (!jobs.length) {
      toast('没有可导出的分段', 'warn')
      return
    }
    for (const j of jobs) {
      const problem = validate(j.action, j.options)
      if (problem) {
        toast(problem, 'warn')
        return
      }
      if (j.output.toLowerCase() === input.toLowerCase()) {
        toast('输出文件不能和输入文件同名，改一下文件名或目录', 'err')
        return
      }
    }

    runBtn.classList.add('loading')
    mount(resultHost, null)

    const bar = progressBar(0, { size: 'lg' })
    const msg = h('div.small.muted', '正在提交任务…')
    const log = h('div.log', { style: { maxHeight: '220px' } })
    const subEl = h('div.sub.truncate', baseName(jobs[0].output))
    let jobId = null
    const cancelBtn = button('取消', {
      size: 'btn-sm',
      variant: 'btn-danger',
      iconName: 'x',
      onClick: async () => {
        if (!jobId) return
        try {
          await api.cancelJob(jobId)
        } catch (err) {
          toast(`取消失败：${err.message}`, 'err')
        }
      },
    })

    mount(jobHost, h('div.card', [
      h('div.card-head', [
        h('div.card-icon', [icon('activity', 16)]),
        h('div', [h('h2', OPS.find((o) => o.id === action)?.name ?? '处理中'), subEl]),
        h('div.spacer'),
        cancelBtn,
      ]),
      h('div.col', [bar, msg, log]),
    ]))

    try {
      let done = 0
      for (const [n, j] of jobs.entries()) {
        subEl.textContent = jobs.length > 1 ? `${baseName(j.output)}（第 ${n + 1} / ${jobs.length} 段）` : baseName(j.output)
        msg.textContent = '正在提交任务…'
        const r = await api.audioRun({ action: j.action, input, output: j.output, options: j.options })
        jobId = r.jobId
        if (!jobId) throw new Error('服务端没有返回任务号')
        const outcome = await waitJob(jobId, (job) => {
          const pct = job.percent ?? 0
          // 多段时进度条按整体算，不然每段都从头跑到尾，看着像卡住了
          const overall = jobs.length > 1 ? ((n + pct / 100) / jobs.length) * 100 : pct
          bar.setBar(overall, job.status === 'error' ? 'error' : job.status === 'done' ? 'done' : job.status === 'canceled' ? 'canceled' : '')
          msg.textContent = job.message || '处理中…'
          mount(log, (job.logs ?? []).join('\n'))
          log.scrollTop = log.scrollHeight
        })
        if (disposed) return
        if (outcome.status === 'done') {
          done++
          lastResult = { action: j.action, input, output: outcome.job?.result?.output ?? j.output }
          continue
        }
        // 失败或取消就停：剩下的段多半也会失败，一次跑完更浪费时间
        if (outcome.status === 'error') {
          bar.setBar(100, 'error')
          msg.textContent = outcome.error?.message ?? '处理失败'
          mount(log, [(outcome.job?.logs ?? []).join('\n'), `✗ ${outcome.error?.message ?? '处理失败'}`].filter(Boolean).join('\n'))
          toast(`处理失败：${outcome.error?.message ?? '未知错误'}`, 'err')
        } else {
          bar.setBar(100, 'canceled')
          msg.textContent = '已取消'
          toast('已取消', 'warn')
        }
        break
      }
      if (done === jobs.length) {
        bar.setBar(100, 'done')
        msg.textContent = jobs.length > 1 ? `${jobs.length} 段都导出完了` : outcomeText(action)
        renderResult(lastResult)
        toast(jobs.length > 1 ? `已导出 ${jobs.length} 个分段` : `处理完成：${baseName(lastResult.output)}`, 'ok')
      }
    } catch (err) {
      toast(`提交任务失败：${err.message}`, 'err')
      mount(jobHost, h('div.alert.alert-err', [icon('alert', 16), h('div.alert-body', esc(err.message))]))
    } finally {
      runBtn.classList.remove('loading')
    }
  }

  function outcomeText(action) {
    return action === 'trim' ? '裁剪完成' : '处理完成'
  }

  const runBtn = button('开始处理', { variant: 'btn-primary', size: 'btn-lg', iconName: 'zap', onClick: () => void run() })

  const runCard = h('div.card', { style: { padding: '14px' } }, [
    h('div.col.gap-sm', [
      h('div.row-wrap.gap-sm', [
        runBtn,
        button('打开输入所在目录', {
          size: 'btn-lg',
          iconName: 'folder',
          onClick: () => {
            const d = dirName(settings.input)
            if (!d) {
              toast('还没选输入文件', 'warn')
              return
            }
            api.fsReveal(d, false).catch((e) => toast(e.message, 'err'))
          },
        }),
      ]),
      h('div.tiny.dim', { style: { textAlign: 'center' } }, '处理在本机由 ffmpeg 完成，不联网、不上传；大文件会花点时间，进度和日志实时显示。裁剪时这个按钮导出「当前选中的那一段」，要一次导出全部就在下面的分段列表里点「全部导出」。'),
    ]),
  ])

  /* ------------------------------------------------------------ ffmpeg 提示 */

  const toolBox = h('div')

  function renderTools() {
    if (state.tools?.ffmpeg?.available) {
      mount(toolBox, null)
      return
    }
    mount(toolBox, h('div.card', [
      h('div.card-head', [
        h('div.card-icon.warn', [icon('alert', 16)]),
        h('div', [h('h2', '未检测到 ffmpeg'), h('div.sub', '下面这些操作全靠它')]),
        h('div.spacer'),
        h('span.chip.err', '未检测到'),
      ]),
      h('div.col.gap-sm', [
        alertBox('err', '格式转换、提取音轨、变调、变速、裁剪、响度标准化、读取媒体信息都需要 ffmpeg。ffmpeg 随程序分发，不需要联网下载；若这里显示未检测到，说明 tools 目录缺失或不完整 —— 从压缩包里把 tools 整个目录重新解压到程序根目录即可。', '怎么恢复'),
        h('div.row-wrap.gap-sm', [
          button('去设置看看', { size: 'btn-lg', iconName: 'gear', onClick: () => navigate('settings') }),
        ]),
        h('div.tiny.dim', '也可以自己装一份 ffmpeg 并加到系统 PATH，程序会自动检测到。'),
      ]),
    ]))
  }

  /* ------------------------------------------------------------ 人声分离 */

  function openUrl(url) {
    api.fsOpen({ url }).catch((err) => toast(`打开浏览器失败：${err.message}`, 'err'))
  }

  async function launchUvr(path) {
    try {
      await api.launch({ path })
      toast('已启动 Ultimate Vocal Remover', 'ok')
    } catch (err) {
      toast(`启动失败：${err.message}`, 'err')
    }
  }

  function separationCard() {
    const uvr = (state.editors ?? []).find((e) => e.id === 'uvr')
    const installed = !!uvr?.installed

    return card({
      title: '人声分离',
      sub: '把人声和伴奏拆开，再拿回来继续做',
      iconName: 'wave',
      iconColor: 'pink',
      body: h('div.col.gap-lg', [
        h('div.col.gap-sm', [
          h('div.row', [
            h('span.strong', { style: { fontSize: '13px' } }, '在线：MVSEP'),
            h('div.spacer'),
            h('span.chip.warn', '需上传文件'),
          ]),
          alertBox('warn', '在线服务需要把音频上传到对方服务器才能处理。介意的话用下面的离线方案（UVR），音频不出本机。', '隐私提示'),
          h('div.row-wrap.gap-sm', [
            button('打开 MVSEP 网站', { variant: 'btn-pink', iconName: 'external', onClick: () => openUrl(MVSEP_URL) }),
            h('span.tiny.dim.mono', MVSEP_URL),
          ]),
          h('div.tiny.dim', 'MVSEP 支持人声/伴奏、鼓/贝斯等多轨分离，有免费额度。上传前可以先用「裁剪片段」截出要用的部分，省流量也省时间。'),
        ]),
        h('div.divider'),
        installed
          ? h('div.col.gap-sm', [
              h('div.row', [
                h('span.strong', { style: { fontSize: '13px' } }, '离线：Ultimate Vocal Remover'),
                h('div.spacer'),
                h('span.chip.ok', '已安装'),
              ]),
              h('div.tiny.dim.truncate', { title: uvr.path ?? '' }, uvr.path ?? ''),
              h('div.row-wrap.gap-sm', [
                button('启动 UVR', { variant: 'btn-primary', iconName: 'play', onClick: () => void launchUvr(uvr.path) }),
                button('定位文件', {
                  size: 'btn-sm',
                  variant: 'btn-ghost',
                  iconName: 'folder',
                  onClick: () => api.fsReveal(uvr.path, true).catch((e) => toast(e.message, 'err')),
                }),
              ]),
              h('div.tiny.dim', '在 UVR 里选 MDX-Net 或 Demucs 模型分离，导出的人声 / 伴奏可以直接拖回本页继续变调、转 WAV。'),
            ])
          : h('div.col.gap-sm', [
              h('div.row', [
                h('span.strong', { style: { fontSize: '13px' } }, '离线：Ultimate Vocal Remover'),
                h('div.spacer'),
                h('span.chip', '未检测到'),
              ]),
              h('div.finding.info', [icon('info', 14), h('div', [h('div.strong', '建议装一个 UVR'), h('div', '免费开源的离线分离工具，音频不出本机。装好之后如果没被自动认出来，可以在「设置 → 自定义程序」里手动指定 UVR.exe 的路径。')])]),
              button('去设置里指定路径', { size: 'btn-sm', iconName: 'gear', onClick: () => navigate('settings') }),
            ]),
      ]),
    })
  }

  function tipsCard() {
    return card({
      title: '顺手流程',
      sub: '从 MV 到能干活的伴奏',
      iconName: 'book',
      iconColor: 'purple',
      body: h('div.col.gap-sm', [
        h('div.log', { style: { maxHeight: 'none' } }, [
          '1. 视频解析 → 下载 MV（或只下音频）',
          '2. 这里「提取音频」→ 导出 WAV',
          '3. UVR 离线分离 → 人声 / 伴奏',
          '4. 「变调」把伴奏对到你的音域',
          '5. 「响度标准化」让两边音量接近',
          '6. 导出 WAV，拿去编辑器里继续做',
        ].join('\n')),
        h('div.tiny.dim', '顺序只是建议：先在 UVR 里分离、再变调，通常比先变调再分离更干净（模型对原调更敏感）。'),
      ]),
    })
  }

  /* ------------------------------------------------------------ 首屏 */

  mount(left, [toolBox, inputCard, opCard, outCard, runCard, jobHost, resultHost])
  mount(right, [separationCard(), tipsCard()])

  renderHeader()
  renderTools()
  renderOps()
  renderOpOptions()
  renderProbe()
  syncOutDir()
  refreshName()
  renderOutPath()
  renderResult(lastResult)
  if (settings.input.trim()) void probeFile(false)

  return function cleanup() {
    disposed = true
    // 不销毁编辑器，换页之后试听还在响、rAF 还在跑
    waveEditor?.destroy()
    for (const stop of [...stops]) {
      try {
        stop()
      } catch {
        /* ignore */
      }
    }
    stops.clear()
    for (const resolve of [...waiters]) {
      try {
        resolve()
      } catch {
        /* ignore */
      }
    }
    waiters.clear()
  }
}

export default { render }
