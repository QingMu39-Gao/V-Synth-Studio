/**
 * 视频解析下载视图
 *
 * B 站走本程序的原生解析（WBI 签名 + DASH 取流），其它站点交给 yt-dlp。
 * 下载是长任务：一律交给后端任务队列，前端只订阅进度（watchJob），
 * 多分P / 多集时排成一条顺序队列，不并发轰炸站点。
 */

import { api, watchJob } from '../api.js'
import {
  h, mount, icon, toast, button, card, progressBar, emptyState, alertBox,
  formatBytes, formatDuration, formatNumber, segmented,
} from '../ui.js'
import { directoryInput } from '../components/dirPicker.js'

const LS_KEY = 'fandiao.video.settings'

const defaultSettings = {
  outDir: '',
  mode: 'video',
  downloadCover: true,
  downloadDanmaku: false,
  downloadSubs: false,
  subDir: '',
  convertTo: '',
  lastUrl: '',
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

function saveSettings(s) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(s))
  } catch {
    /* 存不了就算了，不影响使用 */
  }
}

export async function render(ctx) {
  const { container, headerActions, state, navigate, params } = ctx
  const settings = loadSettings()
  if (!settings.outDir) settings.outDir = state.paths?.downloadDir || state.paths?.outputDir || ''

  /* 订阅与清理 */
  const stops = new Set()
  const waiters = new Set()
  let disposed = false

  /* 数据 */
  let parsed = null
  let activeTab = 'pages'
  let selection = new Set()
  const picked = { quality: null, audio: null, formatId: null }

  /* 下载队列 */
  let queue = []
  let queueRunning = false
  let uidSeq = 0
  const rowRefs = new Map()

  /* ------------------------------------------------------------ 工具 */

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))

  function etaText(item, job) {
    const direct = job.progress?.etaText ?? job.progress?.eta
    if (direct && !/^(na|unknown|none)$/i.test(String(direct).trim())) return `剩余 ${String(direct).trim()}`
    const p = Number(job.percent ?? 0)
    const now = Date.now()
    const prev = item._etaAt
    if (!prev || now - prev.t >= 1000) {
      if (prev && p > prev.p) {
        const rate = (p - prev.p) / ((now - prev.t) / 1000)
        item._etaAt = { t: now, p }
        if (rate > 0) {
          const sec = (100 - p) / rate
          if (Number.isFinite(sec) && sec > 0 && sec < 86400) return `剩余约 ${formatDuration(sec)}`
        }
      } else {
        item._etaAt = { t: now, p }
      }
    }
    return ''
  }

  const baseNameOf = (p) => String(p ?? '').split(/[\\/]/).pop() || String(p ?? '')

  /** DASH 流的码率 + 时长 → 估算体积 */
  function estimateSize(bandwidth, durationSec) {
    const bits = Number(bandwidth)
    if (!Number.isFinite(bits) || bits <= 0 || !durationSec) return ''
    return `≈ ${formatBytes((bits / 8) * durationSec)}`
  }

  const mbps = (b) => {
    const n = Number(b)
    if (!Number.isFinite(n) || n <= 0) return '码率未知'
    return n >= 1000000 ? `${(n / 1000000).toFixed(1)} Mbps` : `${Math.round(n / 1000)} kbps`
  }

  function joinPath(dir, sub) {
    const d = String(dir ?? '').replace(/[/\\]+$/, '')
    const s = String(sub ?? '').replace(/^[/\\]+/, '')
    return s ? `${d}\\${s}` : d
  }

  function currentDir() {
    return dirInput.getValue() || settings.outDir || state.paths?.downloadDir || ''
  }

  function effectiveMode() {
    if (parsed?.source === 'bilibili' && parsed.streams?.mode === 'durl') return 'video'
    return settings.mode
  }

  /** 子目录模板：{title} {uploader} {date} {p} {quality} */
  function renderSubDir() {
    const t = String(settings.subDir ?? '').trim()
    if (!t) return ''
    const info = parsed?.info ?? {}
    const quality = parsed?.streams?.video?.find((v) => v.id === picked.quality)
    const map = {
      title: info.title ?? '',
      uploader: info.uploader ?? '',
      date: info.publishDate ?? info.uploadDate ?? '',
      p: parsed?.currentPage?.page != null ? String(parsed.currentPage.page) : '',
      quality: quality?.qualityName ?? '',
    }
    return t
      .replace(/\{(\w+)\}/g, (m, k) => (k in map ? String(map[k]) : m))
      .replace(/[<>:"|?*\u0000-\u001f]/g, '_')
      .replace(/[/\\]+/g, '\\')
      .replace(/\\+/g, '\\')
      .replace(/^\\|\\$/g, '')
      .trim()
  }

  /* ------------------------------------------------------------ 任务订阅 */

  function subscribe(jobId, handlers) {
    let stop = null
    const wrapped = {
      onUpdate: (job) => { if (!disposed) handlers.onUpdate?.(job) },
      onDone: (job) => { try { handlers.onDone?.(job) } finally { release() } },
      onError: (err, job) => { try { handlers.onError?.(err, job) } finally { release() } },
      onCancel: (job) => { try { handlers.onCancel?.(job) } finally { release() } },
    }
    function release() {
      if (stop) stops.delete(stop)
    }
    stop = watchJob(jobId, wrapped)
    stops.add(stop)
    return () => { release(); stop() }
  }

  /** 等一个任务跑完；离开视图时会被强制 resolve，避免队列卡死 */
  function waitForJob(jobId, item) {
    return new Promise((resolve) => {
      let done = false
      let unsubscribe = null
      const finish = () => {
        if (done) return
        done = true
        waiters.delete(finish)
        resolve()
      }
      waiters.add(finish)
      unsubscribe = subscribe(jobId, {
        onUpdate: (job) => onJobUpdate(item, job),
        onDone: (job) => {
          item.status = 'done'
          item.percent = 100
          item.files = job.result?.files ?? []
          item.dir = job.result?.dir ?? currentDir()
          item.message = job.message ?? '下载完成'
          onJobUpdate(item, job)
          finish()
        },
        onError: (err) => {
          item.status = 'error'
          item.error = err.message
          item.message = err.message
          finish()
        },
        onCancel: () => {
          item.status = 'canceled'
          item.message = '已取消'
          finish()
        },
      })
      if (done && unsubscribe) unsubscribe()
    })
  }

  function onJobUpdate(item, job) {
    item.percent = Number(job.percent ?? 0)
    item.message = job.message || item.message || ''
    const speed = job.progress?.speedText ?? job.progress?.speed ?? ''
    const eta = etaText(item, job)
    item.detail = [`速度 ${String(speed).trim()}`, eta].filter((x) => x && !/速度\s*$/.test(x)).join(' · ')
    const logs = job.logs ?? []
    item.logs = logs
    const refs = rowRefs.get(item.uid)
    if (!refs) return
    refs.bar.style.display = ''
    refs.bar.setBar(item.percent, job.status === 'error' ? 'error' : job.status === 'done' ? 'done' : job.status === 'canceled' ? 'canceled' : '')
    refs.msg.textContent = [item.message, item.detail].filter(Boolean).join(' · ')
    mount(refs.log, logs.join('\n'))
    refs.log.style.display = logs.length ? '' : 'none'
    refs.log.scrollTop = refs.log.scrollHeight
  }

  /* ------------------------------------------------------------ 头部动作 */

  const cookieChip = h('span.chip')
  function renderHeader() {
    const hasCookie = !!state.config?.bilibiliCookie
    mount(cookieChip, hasCookie ? 'B 站：已配置 Cookie' : 'B 站：未配置 Cookie')
    cookieChip.className = `chip${hasCookie ? ' ok' : ''}`
    mount(headerActions, [
      cookieChip,
      button('打开下载目录', {
        size: 'btn-sm',
        iconName: 'folder',
        onClick: () => api.fsReveal(currentDir(), false).catch((e) => toast(e.message, 'err')),
      }),
    ])
  }

  /* ------------------------------------------------------------ 解析栏 */

  const urlInput = h('input.input.mono', {
    placeholder: '粘贴 B 站链接 / BV 号 / 番剧 ep，或 YouTube 等站点链接',
    spellcheck: 'false',
    autocomplete: 'off',
  })
  urlInput.value = settings.lastUrl || params?.url || ''
  urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') parse()
  })

  const parseBtn = button('解析', { variant: 'btn-primary', size: 'btn-lg', iconName: 'search', onClick: () => parse() })

  const pasteBtn = button('粘贴', {
    title: '从剪贴板读链接',
    iconName: 'link',
    onClick: async () => {
      try {
        const text = await navigator.clipboard.readText()
        if (!text?.trim()) {
          toast('剪贴板里没有文本', 'warn')
          return
        }
        urlInput.value = text.trim()
        await parse()
      } catch {
        toast('浏览器不允许读剪贴板，请手动粘贴（Ctrl+V）', 'warn')
        urlInput.focus()
      }
    },
  })

  const noticeBox = h('div.col.gap-sm')
  const resultBox = h('div')
  const optionsBody = h('div.col')
  const queueHost = h('div')

  const parseCard = card({
    title: '解析视频',
    sub: 'B 站原生解析（分P / 合集 / 番剧 / 大会员画质），其它站点走 yt-dlp',
    iconName: 'video',
    iconColor: 'pink',
    actions: h('span.chip', '回车即解析'),
    body: h('div.col.gap-lg', [h('div.col', [h('div.video-parse-bar', [urlInput, pasteBtn, parseBtn])]), noticeBox]),
  })

  function renderNotices() {
    const rows = []
    if (!state.tools?.ffmpeg?.available) {
      rows.push(toolNotice({
        level: 'warn',
        title: '未安装 ffmpeg',
        detail: 'B 站的 DASH 流是音视频分开的：没有 ffmpeg 就不会自动合并成 mp4，只会留下 .video.m4s 与 .audio.m4s 两个文件。「仅音频」模式不受影响。',
        which: 'ffmpeg',
      }))
    }
    if (!state.tools?.ytdlp?.available) {
      rows.push(toolNotice({
        level: 'info',
        title: '未安装 yt-dlp',
        detail: 'B 站解析是本程序原生实现的，不受影响；YouTube 等其它上千个站点需要 yt-dlp 才能解析。',
        which: 'ytdlp',
      }))
    }
    mount(noticeBox, rows.length ? h('div.col.gap-sm', rows) : null)
  }

  function toolNotice({ level, title, detail, which }) {
    return h(`div.finding.${level}`, [
      icon(level === 'warn' ? 'alert' : 'info', 14),
      h('div', { style: { flex: '1', minWidth: '0' } }, [
        h('div.strong', title),
        h('div', detail),
        h('div.tiny.dim', { style: { marginTop: '6px' } },
          `${which === 'ytdlp' ? 'yt-dlp' : which} 随程序分发，不需要联网下载；若这里显示未检测到，从压缩包里把 tools 目录重新解压到程序根目录即可。`),
      ]),
    ])
  }

  /* ------------------------------------------------------------ 解析 */

  async function parse(input) {
    const url = String(typeof input === 'string' ? input : urlInput.value).trim()
    if (!url) {
      toast('请输入视频链接或 BV 号', 'warn')
      urlInput.focus()
      return
    }
    urlInput.value = url
    settings.lastUrl = url
    saveSettings(settings)
    parseBtn.classList.add('loading')
    mount(resultBox, h('div.card', { style: { padding: '18px' } }, [
      h('div.skeleton', { style: { height: '110px', width: '100%' } }),
      h('div.skeleton', { style: { height: '54px', width: '100%', marginTop: '12px' } }),
    ]))
    try {
      const data = await api.parseVideo({ url })
      parsed = data
      selection = new Set()
      activeTab = 'pages'
      resetPicked()
      renderResult()
      renderOptions()
      renderQueue()
      const n = countItems()
      toast(n > 1 ? `解析成功：共 ${n} 个可选内容` : '解析成功', 'ok')
    } catch (err) {
      parsed = null
      toast(`解析失败：${err.message}`, 'err')
      const needYtdlp = /yt-dlp/i.test(err.message ?? '')
      mount(resultBox, h('div.card', { style: { padding: '16px' } }, [
        alertBox('err', esc(err.message), '解析失败'),
        needYtdlp && !state.tools?.ytdlp?.available
          ? h('div', { style: { marginTop: '10px' } }, [
              toolNotice({
                level: 'warn',
                title: '这个站点需要 yt-dlp',
                detail: '装好之后不用改任何设置，重新点「解析」即可。',
                which: 'ytdlp',
              }),
            ])
          : null,
        h('div.tiny.dim', { style: { marginTop: '10px' } }, '提示：B 站链接异常时，可以先确认 BV 号是否完整，或到「设置」里填一份 Cookie。'),
      ]))
      renderOptions()
    } finally {
      parseBtn.classList.remove('loading')
    }
  }

  function resetPicked() {
    if (parsed?.source === 'ytdlp') {
      const list = (parsed.info?.formats ?? []).filter((f) => f.isVideo)
      picked.quality = null
      picked.audio = null
      picked.formatId = list[0]?.formatId ?? null
      return
    }
    const streams = parsed?.streams ?? {}
    const videos = streams.video ?? []
    // 默认：最高画质，同画质优先 AVC/H.264（老编辑器/播放器打不开 HEVC）
    const avc = videos.filter((v) => /avc|h264/i.test(v.codecs ?? ''))
    picked.quality = (avc[0] ?? videos[0])?.id ?? null
    const audios = streams.audio ?? []
    picked.formatId = null
    picked.audio = (audios.find((a) => a.id === 30280) ?? audios[0])?.id ?? null
  }

  function countItems() {
    if (!parsed) return 0
    if (parsed.source === 'ytdlp') return (parsed.info?.formats ?? []).filter((f) => f.isVideo).length
    if (parsed.kind === 'bangumi') return (parsed.info?.episodes ?? []).length
    return Math.max(1, (parsed.info?.pages ?? []).length)
  }

  /* ------------------------------------------------------------ 结果渲染 */

  function renderResult() {
    if (!parsed) {
      mount(resultBox, h('div.card', { style: { padding: '10px 0' } }, [
        emptyState({
          iconName: 'video',
          title: '还没有解析任何视频',
          desc: '把 B 站或 YouTube 的链接粘到上面的输入框，按回车就能看到封面、分P、合集和可选画质。',
        }),
      ]))
      return
    }
    mount(resultBox, parsed.source === 'ytdlp' ? ytdlpResult() : biliResult())
  }

  function coverEl(src, coverFallback) {
    const url = src || coverFallback
    if (!url) {
      return h('div.video-cover', { style: { display: 'grid', placeItems: 'center' } }, [h('span.tiny.dim', '没有封面')])
    }
    const img = h('img.video-cover', { src: url, alt: '封面', referrerpolicy: 'no-referrer', loading: 'lazy' })
    img.addEventListener('error', () => {
      const ph = h('div.video-cover', { style: { display: 'grid', placeItems: 'center' } }, [h('span.tiny.dim', '封面加载失败')])
      img.replaceWith(ph)
    })
    return img
  }

  function streamRow({ selected, quality, detail, size, badge, onClick }) {
    return h(`button.stream-row${selected ? '.selected' : ''}`, { type: 'button', onclick: onClick }, [
      h('span.sr-quality.truncate', quality),
      h('span.sr-detail.truncate', { style: { flex: '1', minWidth: '0' } }, detail),
      badge ?? null,
      size ? h('span.sr-size', size) : null,
    ])
  }

  /* -------------------------------------------------- B 站结果 */

  function biliResult() {
    const { kind, info = {}, streams = null, hasCookie, currentPage } = parsed
    const isBangumi = kind === 'bangumi'
    const pages = info.pages ?? []
    const episodes = info.episodes ?? []
    const seasonEps = info.season?.episodes ?? []

    const left = h('div.col.gap-lg', [
      coverEl(info.cover, currentPage?.cover),
      h('div.grid.grid-2', [
        h('div.stat', [h('div.stat-label', '时长'), h('div.stat-value', { style: { fontSize: '17px' } }, formatDuration(isBangumi ? (currentPage?.durationSec ?? episodes[0]?.durationSec ?? 0) : (currentPage?.durationSec ?? info.durationSec ?? 0)))]),
        h('div.stat', [h('div.stat-label', '播放量'), h('div.stat-value', { style: { fontSize: '17px' } }, info.view != null ? formatNumber(info.view) : '-')]),
        h('div.stat', [h('div.stat-label', isBangumi ? '剧集数' : '分P数'), h('div.stat-value', { style: { fontSize: '17px' } }, String(isBangumi ? episodes.length || 1 : pages.length || 1))]),
        h('div.stat', [h('div.stat-label', '发布日期'), h('div.stat-value', { style: { fontSize: '17px' } }, info.publishDate || '-')]),
      ]),
      info.desc ? h('details', [h('summary', { style: { cursor: 'pointer', fontSize: '12px', color: 'var(--text-3)' } }, '视频简介'), h('div.small.muted', { style: { marginTop: '8px', maxHeight: '150px', overflowY: 'auto' } }, info.desc)]) : null,
    ])

    const meta = h('div.video-meta', [
      info.uploader ? h('span.chip', `UP：${info.uploader}`) : null,
      isBangumi ? h('span.chip.purple', '番剧') : null,
      info.bvid ? h('span.chip', info.bvid) : null,
      currentPage?.page != null && pages.length > 1 ? h('span.chip.accent', `正在看 P${currentPage.page}`) : null,
      hasCookie ? h('span.chip.ok', '已登录') : h('span.chip.warn', '未登录'),
    ])

    const right = h('div.col.gap-lg', [
      h('div.col', [h('h2.video-title', info.title || '（没有标题）'), meta]),
      itemSections({ isBangumi, pages, episodes, seasonEps, info }),
      qualitySection({ streams, isBangumi }),
    ])

    return h('div.card', [
      h('div.card-head', [
        h('div.card-icon.pink', [icon(isBangumi ? 'film' : 'video', 16)]),
        h('div', [h('h2', '解析结果'), h('div.sub', `${isBangumi ? '番剧' : '视频'} · ${info.uploader || 'UP 未知'} · 共 ${countItems()} 个可选内容`)]),
        h('div.spacer'),
        info.url ? h('button.btn.btn-ghost.btn-sm', { onclick: () => api.fsOpen({ url: info.url }).catch((e) => toast(e.message, 'err')) }, [icon('external', 13), '在浏览器打开']) : null,
      ]),
      h('div.video-result', [left, right]),
    ])
  }

  /* -------------------------------------------------- 分P / 合集 / 剧集 */

  function itemList() {
    if (!parsed) return { pages: [], season: [], kind: parsed?.kind }
    const info = parsed.info ?? {}
    if (parsed.kind === 'bangumi') {
      return {
        pages: [],
        season: (info.episodes ?? []).map((e, i) => ({
          key: `ep${e.epId}`,
          label: `EP${i + 1}`,
          title: e.title || e.longTitle || '',
          durationSec: e.durationSec,
          url: `https://www.bilibili.com/bangumi/play/ep${e.epId}`,
          active: e.epId === info.epId,
        })),
        kind: 'bangumi',
      }
    }
    return {
      pages: (info.pages ?? []).map((p) => ({
        key: `p${p.page}`,
        label: `P${p.page}`,
        title: p.title || '',
        durationSec: p.durationSec,
        url: `${info.url ?? ''}?p=${p.page}`,
        active: p.page === (parsed.currentPage?.page ?? 1),
      })),
      season: (info.season?.episodes ?? []).map((e, i) => ({
        key: `s${e.bvid ?? i}`,
        label: `第${i + 1}集`,
        title: e.title || '',
        durationSec: e.durationSec,
        url: `https://www.bilibili.com/video/${e.bvid}`,
        active: e.bvid === info.bvid,
      })),
      kind: 'video',
    }
  }

  function itemSections() {
    const { pages, season } = itemList()
    const multiPages = pages.length > 1
    const hasSeason = season.length > 0
    if (!multiPages && !hasSeason) {
      if (pages.length === 1) {
        return h('div.col', [
          h('div.field-label', '内容'),
          h('div.finding.info', [icon('info', 14), h('div', `单 P 视频：${pages[0].title || '（无分P标题）'}${pages[0].durationSec ? ` · ${formatDuration(pages[0].durationSec)}` : ''}`)]),
        ])
      }
      return null
    }

    const tabId = multiPages && hasSeason ? activeTab : multiPages ? 'pages' : 'season'
    const list = tabId === 'season' ? season : pages
    const groupLabel = tabId === 'season' ? (parsed.kind === 'bangumi' ? '剧集' : '合集') : '分P'

    const tabsEl = multiPages && hasSeason
      ? h('div.tabs', [
          h(`button.tab${tabId === 'pages' ? '.active' : ''}`, { onclick: () => { activeTab = 'pages'; renderResult() } }, ['分P', h('span.chip', { style: { marginLeft: '6px' } }, String(pages.length))]),
          h(`button.tab${tabId === 'season' ? '.active' : ''}`, { onclick: () => { activeTab = 'season'; renderResult() } }, [parsed.kind === 'bangumi' ? '剧集' : '合集', h('span.chip', { style: { marginLeft: '6px' } }, String(season.length))]),
        ])
      : null

    const rows = list.map((it) => {
      const cb = h('input', { type: 'checkbox', checked: selection.has(it.key) })
      const label = h('label.checkbox', { title: '勾选以便批量下载', style: { flexShrink: '0' } }, [
        cb,
        h('span.box', [icon('check', 11)]),
      ])
      label.addEventListener('click', (e) => e.stopPropagation())
      cb.addEventListener('change', () => {
        if (cb.checked) selection.add(it.key)
        else selection.delete(it.key)
        renderResult()
      })
      return h(`div.stream-row${it.active ? '.selected' : ''}`, { onclick: () => switchItem(it) }, [
        label,
        h('span.sr-quality', it.label),
        h('span.truncate', { style: { flex: '1', minWidth: '0' } }, it.title || '（无标题）'),
        h('span.sr-size', it.durationSec ? formatDuration(it.durationSec) : ''),
      ])
    })

    const selectedHere = list.filter((it) => selection.has(it.key)).length
    return h('div.col', [
      h('div.row', [
        h('div.field-label', { style: { margin: '0' } }, `${groupLabel}（${list.length}）`),
        h('div.spacer'),
        selectedHere ? h('span.chip.accent', `已选 ${selectedHere}`) : null,
      ]),
      tabsEl,
      h('div.page-list', rows),
      h('div.row-wrap.gap-sm', [
        button(selectedHere === list.length ? '取消全选' : '全选本页', {
          size: 'btn-sm',
          variant: 'btn-ghost',
          onClick: () => {
            if (selectedHere === list.length) for (const it of list) selection.delete(it.key)
            else for (const it of list) selection.add(it.key)
            renderResult()
          },
        }),
        button(selection.size > 1 ? `批量加入下载队列（${selection.size}）` : '把选中的加入队列', {
          size: 'btn-sm',
          variant: 'btn-primary',
          iconName: 'download',
          disabled: selection.size === 0,
          onClick: () => {
            const all = [...itemList().pages, ...itemList().season]
            const items = all.filter((it) => selection.has(it.key))
            if (!items.length) {
              toast('还没有勾选任何内容', 'warn')
              return
            }
            enqueue(items.map((it) => ({ key: it.key, label: `${it.label} ${it.title}`.trim(), url: it.url })), false)
          },
        }),
      ]),
      h('div.tiny.dim', '勾选多个分P/剧集后加入队列，会按顺序一个一个下载，不会同时开一堆连接。'),
    ])
  }

  async function switchItem(it) {
    if (!it?.url) {
      toast('这一项没有可用的链接', 'warn')
      return
    }
    urlInput.value = it.url
    await parse(it.url)
  }

  /* -------------------------------------------------- 画质 / 音频流 */

  function qualitySection({ streams, isBangumi }) {
    if (!streams) {
      return alertBox('warn', '没有取到播放流信息：这个视频可能受版权限制、需要大会员，或者已经失效。')
    }
    if (streams.error) {
      return alertBox('err', `取播放流出错：${esc(streams.error)}`, '无法获取画质列表')
    }

    const durationSec = streams.durationMs ? streams.durationMs / 1000 : (parsed.currentPage?.durationSec ?? parsed.info?.durationSec ?? 0)

    if (streams.mode === 'durl') {
      const segs = streams.streams ?? []
      return h('div.col.gap-lg', [
        h('div.field-label', '播放流（整段）'),
        alertBox('info', '这个视频只有整段流（老视频或部分番剧），画质由 B 站决定，不能单独挑视频轨 / 音频轨。<b>「仅音频」模式在整段流下不可用</b>，可以整段下载后用「音频工具 → 从视频提取音频」再抽音轨。', '整段流模式'),
        h('div.stream-list', segs.map((s) => streamRow({
          selected: false,
          quality: `第 ${s.index} 段`,
          detail: `整段流 · ${s.lengthMs ? formatDuration(s.lengthMs / 1000) : '时长未知'}`,
          size: s.size ? formatBytes(s.size) : '',
        }))),
      ])
    }

    const videos = streams.video ?? []
    const audios = streams.audio ?? []
    const locked = lockedQualities(streams)

    const videoRows = videos.map((v) => streamRow({
      selected: v.id === picked.quality,
      quality: v.qualityName,
      detail: `${v.width}x${v.height} · ${v.codecs ?? '编码未知'} · ${mbps(v.bandwidth)}`,
      size: estimateSize(v.bandwidth, durationSec),
      badge: /hev|h265/i.test(v.codecs ?? '') ? h('span.chip.warn', 'HEVC') : /av01|av1/i.test(v.codecs ?? '') ? h('span.chip.warn', 'AV1') : h('span.chip.ok', 'H.264'),
      onClick: () => {
        picked.quality = v.id
        renderResult()
      },
    }))

    const audioRows = audios.map((a) => streamRow({
      selected: a.id === picked.audio,
      quality: a.qualityName,
      detail: `${a.codecs ?? '编码未知'} · ${mbps(a.bandwidth)}`,
      size: estimateSize(a.bandwidth, durationSec),
      onClick: () => {
        picked.audio = a.id
        renderResult()
      },
    }))

    const needCookie = hasCookieFalse() && locked.length > 0
    const selectedVideo = videos.find((v) => v.id === picked.quality)

    return h('div.col.gap-lg', [
      needCookie ? h('div.col.gap-sm', [
        alertBox(
          'warn',
          `这个视频有 <b>${locked.map((l) => l.name).join('、')}</b> 等高画质，但没登录 B 站只能取到 <b>${videos.map((v) => v.qualityName).join('、') || '低画质'}</b>。填一份 Cookie 就能解锁（设置页一次填好，之后一直有效）。`,
          '画质受限：未登录'
        ),
        h('div.row-wrap.gap-sm', [
          button('去设置填 Cookie', { size: 'btn-sm', variant: 'btn-primary', iconName: 'gear', onClick: () => navigate('settings') }),
          h('span.tiny.dim', 'Cookie 只保存在本机配置文件里，不会上传到任何地方。'),
        ]),
      ]) : null,
      h('div.col.gap-sm', [
        h('div.row', [
          h('div.field-label', { style: { margin: '0' } }, '视频流'),
          h('span.chip', `${videos.length} 条`),
          h('div.spacer'),
          effectiveMode() === 'audio' ? h('span.chip.info', '仅音频模式：不会下载视频流') : null,
        ]),
        videos.length ? h('div.stream-list', videoRows) : alertBox('warn', '这个视频没有可用的 DASH 视频流。'),
        selectedVideo && /hev|h265|av01|av1/i.test(selectedVideo.codecs ?? '')
          ? h('div.finding.warn', [icon('alert', 14), h('div', `选中的 ${selectedVideo.qualityName} 是 ${selectedVideo.codecs}：体积更小，但不少老编辑器、老播放器打不开。要拿去剪辑就换一条 H.264 的。`)])
          : null,
        h('div.tiny.dim', '默认选最高画质并优先 H.264；同一画质下 B 站只会给一条流（按码率最高的那条算）。'),
      ]),
      h('div.col.gap-sm', [
        h('div.row', [
          h('div.field-label', { style: { margin: '0' } }, '音频流'),
          h('span.chip', `${audios.length} 条`),
          h('div.spacer'),
          h('span.tiny.dim', '默认 192K，兼容性最好'),
        ]),
        audios.length ? h('div.stream-list', audioRows) : alertBox('warn', '没有可用的音频流。'),
      ]),
      isBangumi ? h('div.finding.info', [icon('info', 14), h('div', '番剧的高画质通常需要大会员；如果列表里只有低画质，先确认账号权限。')]) : null,
    ])
  }

  function hasCookieFalse() {
    return parsed?.source === 'bilibili' && parsed.hasCookie === false
  }

  /** acceptQuality / acceptDescription 是平行数组：挑出「视频支持、但当前拿不到」的高画质 */
  function lockedQualities(streams) {
    const avail = new Set((streams.video ?? []).map((v) => v.id))
    const qs = streams.acceptQuality ?? []
    const ds = streams.acceptDescription ?? []
    if (!qs.length) {
      // 没有 acceptQuality 时退化成按名字判断
      const names = new Set((streams.video ?? []).map((v) => v.qualityName))
      return ds
        .filter((n) => /1080P\+|1080P60|4K|8K|HDR|杜比/.test(n) && !names.has(n))
        .map((n) => ({ q: 999, name: n }))
    }
    return qs
      .map((q, i) => ({ q, name: ds[i] ?? `画质 ${q}` }))
      .filter((x) => !avail.has(x.q) && x.q >= 80)
      .sort((a, b) => b.q - a.q)
  }

  /* -------------------------------------------------- yt-dlp 结果 */

  function ytdlpResult() {
    const info = parsed.info ?? {}
    const formats = (info.formats ?? []).filter((f) => f.isVideo)

    const left = h('div.col.gap-lg', [
      coverEl(info.thumbnail),
      h('div.grid.grid-2', [
        h('div.stat', [h('div.stat-label', '时长'), h('div.stat-value', { style: { fontSize: '17px' } }, info.durationSec ? formatDuration(info.durationSec) : '-')]),
        h('div.stat', [h('div.stat-label', '播放量'), h('div.stat-value', { style: { fontSize: '17px' } }, info.viewCount ? formatNumber(info.viewCount) : '-')]),
        h('div.stat', [h('div.stat-label', '来源'), h('div.stat-value', { style: { fontSize: '15px' } }, info.extractor || '-')]),
        h('div.stat', [h('div.stat-label', '上传日期'), h('div.stat-value', { style: { fontSize: '15px' } }, info.uploadDate || '-')]),
      ]),
      info.description ? h('details', [h('summary', { style: { cursor: 'pointer', fontSize: '12px', color: 'var(--text-3)' } }, '视频简介'), h('div.small.muted', { style: { marginTop: '8px', maxHeight: '150px', overflowY: 'auto' } }, info.description)]) : null,
    ])

    const rows = formats.map((f) => streamRow({
      selected: f.formatId === picked.formatId,
      quality: `${f.resolution}${f.fps ? ` ${f.fps}fps` : ''}`,
      detail: `${f.formatId} · ${f.ext} · ${f.vcodec}${f.acodec && f.acodec !== 'none' ? `+${f.acodec}` : '（无音轨）'}`,
      size: f.filesize ? formatBytes(f.filesize) : '',
      badge: f.acodec && f.acodec !== 'none' ? h('span.chip.ok', '含音轨') : null,
      onClick: () => {
        picked.formatId = f.formatId
        renderResult()
      },
    }))

    const right = h('div.col.gap-lg', [
      h('div.col', [h('h2.video-title', info.title || '（没有标题）'), h('div.video-meta', [
        info.uploader ? h('span.chip', `UP：${info.uploader}`) : null,
        info.extractor ? h('span.chip.purple', info.extractor) : null,
        info.id ? h('span.chip', info.id) : null,
      ])]),
      h('div.col.gap-sm', [
        h('div.row', [
          h('div.field-label', { style: { margin: '0' } }, '可选格式'),
          h('span.chip', `${formats.length} 条`),
          h('div.spacer'),
          h('span.tiny.dim', '由 yt-dlp 列出，选择会作为 -f 参数'),
        ]),
        formats.length ? h('div.stream-list', rows) : alertBox('warn', 'yt-dlp 没有列出可用格式。'),
        h('div.tiny.dim', '「仅音频」模式不传格式号，由 yt-dlp 自己挑 bestaudio。'),
      ]),
      info.subtitles?.length
        ? h('div.finding.info', [icon('info', 14), h('div', `有官方字幕：${info.subtitles.join('、')}。勾选「下载官方字幕」后会按站点语言内嵌。`)])
        : h('div.finding.info', [icon('info', 14), h('div', '这个站点没有列出官方字幕。')]),
    ])

    return h('div.card', [
      h('div.card-head', [
        h('div.card-icon.pink', [icon('globe', 16)]),
        h('div', [h('h2', '解析结果'), h('div.sub', `${info.extractor || 'yt-dlp'} · ${info.uploader || '作者未知'}`)]),
        h('div.spacer'),
        info.webpageUrl ? h('button.btn.btn-ghost.btn-sm', { onclick: () => api.fsOpen({ url: info.webpageUrl }).catch((e) => toast(e.message, 'err')) }, [icon('external', 13), '在浏览器打开']) : null,
      ]),
      h('div.video-result', [left, right]),
    ])
  }

  /* ------------------------------------------------------------ 下载选项 */

  const dirInput = directoryInput({
    value: settings.outDir,
    title: '选择视频保存目录',
    placeholder: '视频保存到哪里…',
  })
  dirInput.el.querySelector('input').addEventListener('input', () => {
    settings.outDir = dirInput.getValue()
    saveSettings(settings)
  })
  dirInput.el.querySelector('input').addEventListener('change', () => {
    settings.outDir = dirInput.getValue()
    saveSettings(settings)
  })

  const subDirInput = h('input.input.mono', {
    value: settings.subDir,
    placeholder: '留空 = 直接放在输出目录',
    oninput: (e) => {
      settings.subDir = e.target.value
      saveSettings(settings)
    },
  })

  const modeSeg = h('div')
  const convertToSelect = h('select.select')

  function renderOptions() {
    const isBili = parsed?.source !== 'ytdlp'
    const durl = isBili && parsed?.streams?.mode === 'durl'
    if (durl) settings.mode = 'video'

    mount(modeSeg, durl
      ? h('div.finding.info', [icon('info', 14), h('div', '整段流模式下只能整段下载（视频与音频在一起），选不了「仅音频」。')])
      : segmented([
          { value: 'video', label: '视频（含音频）' },
          { value: 'audio', label: '仅音频' },
        ], settings.mode, (v) => {
          settings.mode = v
          saveSettings(settings)
          renderOptions()
          renderResult()
        }))

    const rows = [
      h('div.field', [h('label.field-label', '输出目录'), dirInput.el]),
      h('div.field', [
        h('label.field-label', '下载模式'),
        modeSeg,
        h('div.field-hint', settings.mode === 'audio'
          ? '只下音频轨（B 站是 m4a），体积小、适合先做分离与对轨。'
          : (isBili ? '视频与音频分开下载，再用 ffmpeg 合成 mp4。' : '由 yt-dlp 合并为 mkv/mp4。')),
      ]),
      switchRow('downloadCover', '下载封面', 'B 站封面存成同名 .jpg（部分视频没有封面图）', !isBili),
      switchRow('downloadDanmaku', '下载弹幕 XML', '存成同名 .danmaku.xml，可丢给弹幕工具', !isBili),
      switchRow('downloadSubs', '下载官方字幕', 'B 站存成 .srt；yt-dlp 走 --write-subs 内嵌字幕', false),
      h('div.field', [
        h('label.field-label', '保存到子目录（可选）'),
        subDirInput,
        h('div.field-hint', '可用变量：{title} 标题、{uploader} UP主、{date} 发布日期、{p} 分P号、{quality} 画质。文件名仍按视频标题命名（服务端决定），这里只控制放在哪个子目录里。'),
      ]),
    ]

    if (!isBili && settings.mode === 'audio') {
      mount(convertToSelect, [
        h('option', { value: '' }, '保持原样（不转码，最快）'),
        h('option', { value: 'mp3' }, 'MP3 320k'),
        h('option', { value: 'm4a' }, 'M4A / AAC'),
        h('option', { value: 'wav' }, 'WAV 无损'),
        h('option', { value: 'flac' }, 'FLAC 无损'),
      ])
      convertToSelect.value = settings.convertTo ?? ''
      rows.push(h('div.field', [
        h('label.field-label', '音频转码格式'),
        convertToSelect,
        h('div.field-hint', state.tools?.ffmpeg?.available
          ? '转码由 yt-dlp 调用 ffmpeg 完成。'
          : '注意：转码需要 ffmpeg，现在还没装，先保持「不转码」也能下到音频。'),
      ]))
    }

    mount(optionsBody, rows)
  }

  convertToSelect.addEventListener('change', () => {
    settings.convertTo = convertToSelect.value
    saveSettings(settings)
  })

  function switchRow(key, label, desc, disabled) {
    const sw = h(`button.switch${settings[key] ? '.on' : ''}`, { type: 'button', disabled: !!disabled })
    if (disabled) sw.style.opacity = '0.35'
    sw.addEventListener('click', () => {
      if (disabled) {
        toast('这一项只在 B 站下载时可用', 'warn')
        return
      }
      settings[key] = !settings[key]
      sw.classList.toggle('on', settings[key])
      saveSettings(settings)
    })
    return h('div.row', { style: { justifyContent: 'space-between' } }, [
      h('div', { style: { minWidth: '0' } }, [
        h('div', { style: { fontSize: '12.5px' } }, label),
        h('div.tiny.dim', desc),
      ]),
      sw,
    ])
  }

  const optionsCard = card({
    title: '下载选项',
    sub: '存到哪里、下哪些附带内容（会自动记住）',
    iconName: 'save',
    iconColor: 'info',
    body: optionsBody,
  })

  /* ------------------------------------------------------------ 队列 */

  function buildPayload(url) {
    const isBili = parsed?.source !== 'ytdlp'
    const sub = renderSubDir()
    const base = currentDir()
    const payload = {
      url,
      source: isBili ? 'bilibili' : 'ytdlp',
      outDir: sub ? joinPath(base, sub) : base,
      mode: effectiveMode(),
      downloadCover: !!(isBili && settings.downloadCover),
      downloadDanmaku: !!(isBili && settings.downloadDanmaku),
      downloadSubs: !!settings.downloadSubs,
    }
    if (isBili) {
      if (parsed?.streams?.mode === 'dash') {
        if (payload.mode === 'video' && picked.quality != null) payload.quality = picked.quality
        if (picked.audio != null) payload.audioQuality = picked.audio
      }
    } else {
      if (payload.mode === 'video' && picked.formatId) payload.formatId = picked.formatId
      if (payload.mode === 'audio' && settings.convertTo) payload.convertTo = settings.convertTo
    }
    return payload
  }

  function currentEntry() {
    const url = urlInput.value.trim() || parsed?.info?.url || ''
    const page = parsed?.currentPage?.page
    const label = parsed?.kind === 'bangumi'
      ? `${parsed?.info?.title ?? '番剧'} ${parsed?.currentPage?.title ?? ''}`.trim()
      : (page && (parsed?.info?.pages?.length ?? 0) > 1
          ? `${parsed?.info?.title ?? ''} P${page}`.trim()
          : (parsed?.info?.title || url))
    return { key: `${url}#${effectiveMode()}#${picked.quality ?? ''}`, label, url }
  }

  function enqueue(entries, runNow) {
    if (!parsed) {
      toast('请先解析视频链接', 'warn')
      return
    }
    if (!currentDir()) {
      toast('请选择输出目录', 'warn')
      return
    }
    const fresh = []
    for (const e of entries) {
      if (!e?.url) continue
      if (queue.some((q) => q.key === e.key && (q.status === 'queued' || q.status === 'running'))) continue
      if (fresh.some((f) => f.key === e.key)) continue
      fresh.push({
        ...e,
        uid: ++uidSeq,
        status: 'queued',
        percent: 0,
        files: [],
        logs: [],
        mode: effectiveMode(),
        payload: buildPayload(e.url),
      })
    }
    if (!fresh.length) {
      toast('这些内容已经在队列里了', 'warn')
      return
    }
    if (runNow) queue.unshift(...fresh)
    else queue.push(...fresh)
    renderQueue()
    toast(runNow ? '已开始下载' : `已加入队列：${fresh.map((f) => f.label).join('、')}`, 'info')
    runQueue()
  }

  function statusText(item) {
    return {
      queued: '等待中',
      running: '下载中',
      done: '已完成',
      error: '失败',
      canceled: '已取消',
    }[item.status] ?? item.status
  }

  function statusChipClass(status) {
    return { running: '.info', done: '.ok', error: '.err', canceled: '' }[status] ?? ''
  }

  function fileList(item) {
    return h('div.col', { style: { marginTop: '4px' } }, [
      h('div.row.gap-sm', [
        h('span.tiny.dim.truncate', { style: { flex: '1' } }, `${item.files.length} 个文件 · ${item.dir ?? ''}`),
        item.dir ? button('打开所在目录', {
          size: 'btn-sm',
          variant: 'btn-ghost',
          iconName: 'folder',
          onClick: () => api.fsReveal(item.dir, false).catch((e) => toast(e.message, 'err')),
        }) : null,
      ]),
      ...item.files.map((p) => h('div.row.gap-sm', [
        icon('file', 13),
        h('span.small.truncate', { style: { flex: '1', minWidth: '0' }, title: p }, baseNameOf(p)),
        h('button.btn.btn-ghost.btn-icon.btn-sm', {
          title: '用默认程序打开',
          onclick: () => api.fsOpen({ path: p }).catch((e) => toast(e.message, 'err')),
        }, [icon('play', 12)]),
        h('button.btn.btn-ghost.btn-icon.btn-sm', {
          title: '在资源管理器中显示',
          onclick: () => api.fsReveal(p, true).catch((e) => toast(e.message, 'err')),
        }, [icon('folder', 12)]),
      ])),
    ])
  }

  function queueRow(item) {
    const bar = progressBar(item.percent ?? 0)
    bar.style.display = item.status === 'queued' ? 'none' : ''
    const chip = h(`span.chip${statusChipClass(item.status)}`, statusText(item))
    const msg = h('div.job-msg', [item.message || statusText(item), item.detail].filter(Boolean).join(' · '))
    const log = h('div.log', { style: { maxHeight: '150px', display: item.logs?.length ? '' : 'none' } }, (item.logs ?? []).join('\n'))
    const cancelBtn = (item.status === 'queued' || item.status === 'running')
      ? h('button.btn.btn-ghost.btn-icon.btn-sm', { title: '取消这一项', onclick: () => cancelItem(item) }, [icon('x', 12)])
      : null
    const retryBtn = (item.status === 'error' || item.status === 'canceled')
      ? h('button.btn.btn-ghost.btn-icon.btn-sm', {
          title: '重试',
          onclick: () => {
            item.status = 'queued'
            item.error = null
            item.percent = 0
            renderQueue()
            runQueue()
          },
        }, [icon('refresh', 12)])
      : null

    const row = h('div.job-row', [
      h('div.job-head', [
        icon(item.mode === 'audio' ? 'music' : 'video', 14),
        h('span.truncate', { style: { flex: '1', minWidth: '0' }, title: item.label }, item.label),
        chip,
        cancelBtn,
        retryBtn,
      ]),
      bar,
      msg,
      log,
      item.status === 'done' && item.files?.length ? fileList(item) : null,
    ])
    rowRefs.set(item.uid, { bar, msg, log, chip })
    return row
  }

  function renderQueue() {
    if (!queue.length) {
      mount(queueHost, null)
      return
    }
    const done = queue.filter((q) => q.status === 'done').length
    const failed = queue.filter((q) => q.status === 'error').length
    const pending = queue.some((q) => q.status === 'queued' || q.status === 'running')
    mount(queueHost, h('div.card', [
      h('div.card-head', [
        h('div.card-icon.info', [icon('list', 16)]),
        h('div', [
          h('h2', '下载队列'),
          h('div.sub', `${done}/${queue.length} 已完成${failed ? ` · ${failed} 个失败` : ''}${queueRunning ? ' · 顺序下载中' : ''}`),
        ]),
        h('div.spacer'),
        button('全部取消', { size: 'btn-sm', variant: 'btn-ghost', iconName: 'x', disabled: !pending, onClick: cancelAll }),
        button('清空已完成', { size: 'btn-sm', variant: 'btn-ghost', iconName: 'trash', onClick: clearDone }),
      ]),
      h('div.col', queue.map(queueRow)),
      h('div.tiny.dim', '下载在后台进行：切走视图也不会中断，回来重新解析即可继续。'),
    ]))
  }

  async function runQueue() {
    if (queueRunning || disposed) return
    queueRunning = true
    renderQueue()
    try {
      for (;;) {
        if (disposed) break
        const item = queue.find((q) => q.status === 'queued')
        if (!item) break
        await runItem(item)
        if (!disposed) renderQueue()
      }
    } finally {
      queueRunning = false
      if (!disposed) renderQueue()
    }
  }

  async function runItem(item) {
    item.status = 'running'
    item.message = '正在创建下载任务…'
    item._etaAt = null
    renderQueue()
    let jobId = null
    try {
      const r = await api.downloadVideo(item.payload)
      jobId = r.jobId
      if (!jobId) throw new Error('服务端没有返回任务号')
    } catch (err) {
      item.status = 'error'
      item.error = err.message
      item.message = err.message
      toast(`「${item.label}」下载失败：${err.message}`, 'err')
      renderQueue()
      return
    }
    item.jobId = jobId
    await waitForJob(jobId, item)
    if (disposed) return
    if (item.status === 'done') {
      toast(`「${item.label}」下载完成：${item.files.length} 个文件`, 'ok')
    } else if (item.status === 'error') {
      toast(`「${item.label}」下载失败：${item.error ?? '未知错误'}`, 'err')
    } else if (item.status === 'canceled') {
      toast(`「${item.label}」已取消`, 'warn')
    }
  }

  async function cancelItem(item) {
    if (item.status === 'queued') {
      item.status = 'canceled'
      item.message = '已取消'
      renderQueue()
      return
    }
    if (item.status === 'running' && item.jobId) {
      try {
        await api.cancelJob(item.jobId)
      } catch (err) {
        toast(`取消失败：${err.message}`, 'err')
      }
    }
  }

  async function cancelAll() {
    for (const item of queue) {
      if (item.status === 'queued') {
        item.status = 'canceled'
        item.message = '已取消'
      }
    }
    renderQueue()
    const running = queue.filter((q) => q.status === 'running' && q.jobId)
    for (const item of running) {
      try {
        await api.cancelJob(item.jobId)
      } catch (err) {
        toast(`取消失败：${err.message}`, 'err')
      }
    }
  }

  function clearDone() {
    queue = queue.filter((q) => q.status === 'queued' || q.status === 'running')
    renderQueue()
  }

  /* ------------------------------------------------------------ 动作区 */

  const runBtn = button('开始下载', {
    variant: 'btn-primary',
    size: 'btn-lg',
    iconName: 'download',
    onClick: () => {
      if (!parsed) {
        toast('请先解析视频链接', 'warn')
        return
      }
      enqueue([currentEntry()], true)
    },
  })

  const queueBtn = button('加入下载队列', {
    size: 'btn-lg',
    iconName: 'list',
    onClick: () => {
      if (!parsed) {
        toast('请先解析视频链接', 'warn')
        return
      }
      enqueue([currentEntry()], false)
    },
  })

  const actionCard = h('div.card', { style: { padding: '14px' } }, [
    h('div.col', [
      h('div.row-wrap.gap-sm', [runBtn, queueBtn]),
      h('div.tiny.dim', { style: { textAlign: 'center' } }, '下载由本地服务完成，不会上传任何东西；解析与下载都走 B 站官方接口。'),
    ]),
  ])

  /* ------------------------------------------------------------ 首屏 */

  mount(container, h('div.col.gap-lg.stagger', [
    parseCard,
    resultBox,
    optionsCard,
    actionCard,
    queueHost,
  ]))

  renderHeader()
  renderNotices()
  renderResult()
  renderOptions()
  renderQueue()
  setTimeout(() => urlInput.focus(), 60)

  if (params?.url) void parse(params.url)
  else if (params?.autoParse && urlInput.value.trim()) void parse()

  return function cleanup() {
    disposed = true
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
    rowRefs.clear()
  }
}

export default { render }
