/**
 * 歌词：从网易云 / QQ 音乐搜歌 → 取歌词 → 导出 LRC / SRT / 封面
 *
 * 后端：`server/lyrics.rs`（路由）+ `lyrics.rs`（平台实现）；接口见 api.js 的 lyrics*。
 * 与「工程转换」页里的 lrc/srt **是两回事**：那边是 LibreSVIP 的工程格式，
 * 这边是给翻调打歌词用的、带时间轴的双语歌词文本。
 */

import { api } from '../api.js'
import {
  h, mount, icon, toast, button, card, segmented, emptyState, alertBox,
  switchToggle, formatDuration,
} from '../ui.js'
import { directoryInput } from '../components/dirPicker.js'
import { drawQr } from '../qr.js'

/** 后端对已保存的 Cookie 只回显这个占位串（真实值不出后端） */
const MASK = '已设置'

const SOURCES = [
  { value: 'netease', label: '网易云' },
  { value: 'qq', label: 'QQ 音乐' },
]

/* ------------------------------------------------------------ 歌词文本工具 */

/**
 * 解析 LRC 成 [{ ms, text }]（只用来在界面上对齐显示，落盘由后端负责）
 * 支持 [mm:ss] / [mm:ss.SS] / [mm:ss:SS] 以及一行多个时间戳
 */
function parseLrc(text) {
  const out = []
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const re = /\[(\d+):(\d+(?:[.:]\d+)?)\]/g
    const times = []
    let m
    let end = 0
    while ((m = re.exec(line))) {
      times.push(toMs(m[1], m[2]))
      end = re.lastIndex
    }
    const content = line.slice(end).trim()
    if (!times.length || !content) continue
    for (const ms of times) out.push({ ms, text: content })
  }
  return out.sort((a, b) => a.ms - b.ms)
}

/** "02:345" / "02.34" → 毫秒，毫秒位数按 1 位 ×100、2 位 ×10、3 位原样 */
function toMs(min, sec) {
  const [s, frac = ''] = String(sec).split(/[.:]/)
  const digits = frac.slice(0, 3)
  const ms = digits.length === 1 ? Number(digits) * 100
    : digits.length === 2 ? Number(digits) * 10
      : Number(digits || 0)
  return (Number(min) * 60 + Number(s)) * 1000 + ms
}

/** 毫秒 → mm:ss.xx（预览用） */
function mmss(ms) {
  const m = Math.floor(ms / 60000)
  const s = Math.floor((ms % 60000) / 1000)
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(Math.floor((ms % 1000) / 10)).padStart(2, '0')}`
}

/** 译文按时间戳对齐：先精确匹配，再容忍 ±50ms（和后端同一条规则） */
function alignTrans(text) {
  const list = parseLrc(text)
  const exact = new Map()
  for (const l of list) if (!exact.has(l.ms)) exact.set(l.ms, l.text)
  return (ms) => {
    if (exact.has(ms)) return exact.get(ms)
    const near = list.find((l) => Math.abs(l.ms - ms) <= 50)
    return near ? near.text : ''
  }
}

/* ------------------------------------------------------------ 视图 */

export async function render(ctx) {
  const { container, state } = ctx

  // 页面状态全在这几个变量里，离开视图就随闭包一起丢掉
  let source = 'netease'
  let results = []
  let current = null // { id, source, song:{name,artists,album,cover,durationSec}, lyric, trans }
  let previewMode = 'both'
  let outFormat = 'lrc'
  let bilingual = true
  let qrKey = ''
  let pollTimer = null

  /* ── 元素 ── */
  const sourceSeg = h('div')
  const keywordInput = h('input.input', {
    placeholder: '歌名 / 歌手，回车搜索（例如：千本桜）',
    onkeydown: (e) => { if (e.key === 'Enter') doSearch() },
  })
  const searchBtn = button('搜索', { variant: 'btn-primary', iconName: 'search', onClick: () => doSearch() })
  const resultBox = h('div.lyrics-results')
  const sourceHint = h('div.field-hint')

  const linkInput = h('input.input.mono', {
    placeholder: '粘贴歌曲链接，例如 https://music.163.com/#/song?id=186016',
    onkeydown: (e) => { if (e.key === 'Enter') doParseLink() },
  })
  const linkBtn = button('解析链接', { iconName: 'link', onClick: () => doParseLink() })

  const loginChip = h('span.chip')
  // 二维码本地画：网易云已经不提供二维码图片接口了（见 qr.js 顶部说明）
  const qrCanvas = h('canvas.lyrics-qr', { style: { display: 'none' } })
  const qrHint = h('div.small.muted', '扫码登录后可以取到需要登录的歌词（版权曲、部分翻译）。')
  const qrBtn = button('显示二维码', { iconName: 'refresh', onClick: () => showQr() })
  const logoutBtn = button('退出登录', { variant: 'btn-ghost', size: 'btn-sm', iconName: 'trash', onClick: () => logout() })
  const cookieInput = h('input.input.mono', { placeholder: '也可以直接粘贴网易云 Cookie（MUSIC_U=...）' })
  const cookieBtn = button('保存 Cookie', { size: 'btn-sm', iconName: 'save', onClick: () => saveCookie('neteaseCookie', cookieInput) })
  const qqCookieInput = h('input.input.mono', { placeholder: 'QQ 音乐 Cookie（可选，部分歌曲需要）' })
  const qqCookieBtn = button('保存 Cookie', { size: 'btn-sm', iconName: 'save', onClick: () => saveCookie('qqCookie', qqCookieInput) })

  const metaBox = h('div.lyrics-meta')
  const previewBox = h('div.lyrics-preview')
  const modeSeg = h('div')

  const dirInput = directoryInput({
    // 默认走 state.paths.outputDir（系统下载目录）—— 设置页改默认目录，这里跟着变
    value: state.paths?.outputDir ?? state.config?.outputDir ?? '',
    title: '选择歌词保存目录',
    placeholder: '歌词保存目录…',
  })
  const nameInput = h('input.input', { placeholder: '文件名（默认：歌名 - 歌手）' })
  const formatSeg = h('div')
  let bilingualToggle = null
  const saveBtn = button('保存歌词', { variant: 'btn-primary', iconName: 'save', onClick: () => saveLyric() })
  const coverBtn = button('下载封面', { variant: '', iconName: 'image', onClick: () => downloadCover() })
  const savedBox = h('div.saved-box')

  /* ── 渲染来源切换 ── */
  function renderSource() {
    mount(sourceSeg, segmented(SOURCES, source, (v) => {
      source = v
      renderSource()
      renderLogin()
      mount(resultBox, null)
    }))
    sourceHint.textContent = source === 'qq'
      ? 'QQ 音乐走的是手机端搜索接口（桌面接口现在要签名，会返回空结果）。'
      : '网易云的搜索结果里带专辑与时长，信息更全。'
  }

  /* ── 搜索 ── */
  function renderResults() {
    if (!results.length) {
      mount(resultBox, h('div.small.dim', '没有结果。换个关键词，或换一个来源再试。'))
      return
    }
    const list = h('div.list.stagger')
    for (const song of results) {
      const row = h('button.list-item', {
        style: { textAlign: 'left', cursor: 'pointer' },
        onclick: () => pick(song),
      }, [
        icon('music', 15),
        h('div', { style: { flex: '1', minWidth: '0' } }, [
          h('div.strong.truncate', song.name || '(无标题)'),
          h('div.small.muted.truncate', `${song.artists || '未知歌手'}${song.album ? ` · ${song.album}` : ''}`),
        ]),
        song.durationSec ? h('span.chip', formatDuration(song.durationSec)) : null,
      ])
      list.appendChild(row)
    }
    mount(resultBox, list)
  }

  async function doSearch() {
    const keyword = keywordInput.value.trim()
    if (!keyword) {
      toast('请先输入歌名或歌手', 'warn')
      return
    }
    searchBtn.classList.add('loading')
    searchBtn.disabled = true
    mount(resultBox, h('div.small.dim', '搜索中…'))
    try {
      const res = await api.lyricsSearch({ source, keyword })
      results = res.songs ?? []
      renderResults()
      if (!results.length) toast('没有搜到结果', 'warn')
    } catch (err) {
      mount(resultBox, alertBox('err', err.message))
      toast(err.message, 'err')
    } finally {
      searchBtn.classList.remove('loading')
      searchBtn.disabled = false
    }
  }

  /* ── 取歌词 ── */
  async function pick(song) {
    await loadLyric(song.id, source)
  }

  async function loadLyric(id, src) {
    try {
      const res = await api.lyricsGet({ source: src, id })
      current = { ...res, id, source: src }
      const song = res.song ?? {}
      nameInput.value = [song.name, song.artists].filter(Boolean).join(' - ')
      renderPreview()
      renderMeta()
      if (!String(res.trans ?? '').trim()) {
        toast('这首歌没有翻译歌词，只能导出原文', 'info')
      }
    } catch (err) {
      toast(err.message, 'err')
      mount(previewBox, alertBox('err', err.message))
    }
  }

  async function doParseLink() {
    const url = linkInput.value.trim()
    if (!url) {
      toast('请先粘贴歌曲链接', 'warn')
      return
    }
    linkBtn.classList.add('loading')
    try {
      const res = await api.lyricsParseLink({ url })
      source = res.source
      renderSource()
      renderLogin()
      // 解析出来直接拉歌词（粘贴链接的场景不用再点一次）
      await loadLyric(res.id, res.source)
      toast(`已识别为${res.source === 'qq' ? ' QQ 音乐' : '网易云'}：${res.id}`, 'ok')
    } catch (err) {
      toast(err.message, 'err')
    } finally {
      linkBtn.classList.remove('loading')
    }
  }

  /* ── 预览 ── */
  function renderPreview() {
    if (!current) {
      mount(previewBox, emptyState({
        iconName: 'music',
        title: '还没有选中歌曲',
        desc: '上面搜一首歌，或粘贴链接；歌词取回来会显示在这里。',
      }))
      return
    }
    const lines = parseLrc(current.lyric)
    const trans = alignTrans(current.trans)
    if (!lines.length) {
      mount(previewBox, alertBox('warn', '这首歌的歌词里没有可识别的时间轴，无法导出 LRC / SRT。'))
      return
    }
    const box = h('div.lyrics-lines')
    for (const line of lines) {
      const tr = trans(line.ms)
      const row = h('div.lyrics-line', [
        h('div.t.mono', mmss(line.ms)),
        previewMode === 'trans' ? null : h('div.orig', line.text),
        previewMode === 'orig' ? null : h('div.trans', tr || ''),
      ])
      box.appendChild(row)
    }
    mount(previewBox, box)
  }

  function renderMode() {
    mount(modeSeg, segmented([
      { value: 'both', label: '对照' },
      { value: 'orig', label: '只看原文' },
      { value: 'trans', label: '只看译文' },
    ], previewMode, (v) => {
      previewMode = v
      renderMode()
      renderPreview()
    }))
  }

  function renderMeta() {
    if (!current) {
      mount(metaBox, null)
      return
    }
    const song = current.song ?? {}
    const thumb = song.cover
      ? h('img.lyrics-cover', {
          src: song.cover,
          alt: '封面',
          // 浏览器直连封面 CDN 不受程序里的代理影响；拉不到就提示用「下载封面」（那条走后端）
          onerror: (e) => { e.target.replaceWith(h('span.small.dim', '封面预览加载失败，可点「下载封面」从后端拉取')) },
        })
      : null
    mount(metaBox, h('div.row.gap-sm', { style: { alignItems: 'center' } }, [
      thumb,
      h('div', { style: { minWidth: '0' } }, [
        h('div.strong.truncate', song.name || '(未取到歌名)'),
        h('div.small.muted.truncate', [song.artists, song.album].filter(Boolean).join(' · ')),
        h('div.tiny.dim', `${current.source === 'qq' ? 'QQ 音乐' : '网易云'} · ${current.id}${song.durationSec ? ` · ${formatDuration(song.durationSec)}` : ''}`),
      ]),
    ]))
  }

  /* ── 保存 ── */
  function renderFormat() {
    mount(formatSeg, segmented([
      { value: 'lrc', label: 'LRC' },
      { value: 'srt', label: 'SRT' },
    ], outFormat, (v) => { outFormat = v; renderFormat() }))
  }

  async function saveLyric() {
    if (!current) {
      toast('请先选中一首歌并取到歌词', 'warn')
      return
    }
    saveBtn.classList.add('loading')
    try {
      const res = await api.lyricsSave({
        source: current.source,
        id: current.id,
        lyric: current.lyric,
        trans: current.trans,
        durationSec: current.song?.durationSec ?? 0,
        format: outFormat,
        bilingual,
        outDir: dirInput.getValue(),
        name: nameInput.value.trim(),
      })
      toast(`已保存 ${res.name}`, 'ok')
      showSaved(res.path)
    } catch (err) {
      toast(err.message, 'err')
    } finally {
      saveBtn.classList.remove('loading')
    }
  }

  async function downloadCover() {
    const url = current?.song?.cover
    if (!url) {
      toast('这首歌没有封面，或还没选中歌曲', 'warn')
      return
    }
    coverBtn.classList.add('loading')
    try {
      const res = await api.lyricsCover({
        url,
        outDir: dirInput.getValue(),
        name: nameInput.value.trim() || current.song?.name || 'cover',
      })
      toast(`封面已保存 ${res.name}`, 'ok')
      showSaved(res.path)
    } catch (err) {
      toast(err.message, 'err')
    } finally {
      coverBtn.classList.remove('loading')
    }
  }

  function showSaved(path) {
    mount(savedBox, h('div.field-hint', [
      `已写入：${path} `,
      button('打开所在目录', {
        size: 'btn-sm',
        variant: 'btn-ghost',
        iconName: 'external',
        onClick: async () => {
          try {
            await api.fsReveal(path)
          } catch (err) {
            toast(err.message, 'err')
          }
        },
      }),
    ]))
  }

  /* ── 登录 ── */
  function renderLogin() {
    const key = source === 'qq' ? 'qqCookie' : 'neteaseCookie'
    const has = !!state.config?.[key]
    loginChip.className = `chip${has ? ' ok' : ''}`
    mount(loginChip, has ? `${source === 'qq' ? 'QQ 音乐' : '网易云'}：已登录` : `${source === 'qq' ? 'QQ 音乐' : '网易云'}：未登录`)
    // 二维码只有网易云有；QQ 那边只能填 Cookie
    qrBtn.style.display = source === 'qq' ? 'none' : ''
    if (!qrKey) qrCanvas.style.display = 'none'
    if (source === 'qq') {
      qrHint.textContent = 'QQ 音乐没有扫码登录，需要的话把 Cookie 粘在下面（不填也能取大部分歌词）。'
    } else if (!qrKey) {
      qrHint.textContent = '扫码登录后可以取到需要登录的歌词（版权曲、部分翻译）。'
    }
  }

  async function showQr() {
    stopPoll()
    qrBtn.classList.add('loading')
    try {
      const res = await api.lyricsQr()
      qrKey = res.key
      // 后端只给「要编进二维码的内容」，画码在本地做：二维码里带的是登录 token，
      // 交给任何外部服务都等于把登录态送出去
      try {
        drawQr(qrCanvas, res.url)
        qrCanvas.style.display = ''
      } catch (err) {
        qrHint.textContent = `二维码生成失败：${err.message}`
        toast(err.message, 'err')
        return
      }
      qrHint.textContent = '用网易云音乐 App 扫码，然后在手机上确认…'
      pollTimer = setInterval(pollOnce, 2000)
    } catch (err) {
      qrHint.textContent = `获取二维码失败：${err.message}`
      toast(err.message, 'err')
    } finally {
      qrBtn.classList.remove('loading')
    }
  }

  async function pollOnce() {
    if (!qrKey) return
    try {
      const res = await api.lyricsPoll(qrKey)
      qrHint.textContent = res.message
      if (res.code === 803) {
        stopPoll()
        qrKey = ''
        qrCanvas.style.display = 'none'
        toast('登录成功，Cookie 已保存', 'ok')
        await ctx.refreshState({ silent: true })
        renderLogin()
      } else if (res.code === 800) {
        stopPoll()
        qrKey = ''
        qrCanvas.style.display = 'none'
        qrHint.textContent = '二维码已过期，点「显示二维码」重新获取。'
      }
    } catch (err) {
      // 轮询失败就停下并说明原因 —— 每 2 秒弹一次 toast 会刷屏
      stopPoll()
      qrHint.textContent = `轮询失败：${err.message}`
      toast(err.message, 'err')
    }
  }

  function stopPoll() {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  async function saveCookie(key, input) {
    const raw = input.value.trim()
    if (raw === MASK) {
      toast('输入框里是脱敏占位「已设置」，没有可保存的新值', 'warn')
      return
    }
    try {
      await api.saveConfig({ [key]: raw })
      await ctx.refreshState({ silent: true })
      input.value = ''
      renderLogin()
      toast(raw ? 'Cookie 已保存' : 'Cookie 已清除', 'ok')
    } catch (err) {
      toast(err.message, 'err')
    }
  }

  async function logout() {
    const key = source === 'qq' ? 'qqCookie' : 'neteaseCookie'
    try {
      await api.saveConfig({ [key]: '' })
      await ctx.refreshState({ silent: true })
      stopPoll()
      qrKey = ''
      qrCanvas.style.display = 'none'
      renderLogin()
      toast('已退出登录', 'ok')
    } catch (err) {
      toast(err.message, 'err')
    }
  }

  /* ── 组装 ── */
  bilingualToggle = switchToggle(bilingual, (v) => { bilingual = v })
  renderSource()
  renderMode()
  renderFormat()
  renderLogin()
  renderPreview()
  renderMeta()
  mount(resultBox, h('div.small.dim', '搜到的歌会列在这里，点一条就开始取歌词。'))

  const left = h('div.col.gap-lg', [
    card({
      title: '搜索歌曲',
      sub: '搜到之后点一条就能取歌词',
      iconName: 'search',
      className: 'lyrics-search',
      body: h('div.col.gap-lg', [
        h('div.row', [sourceSeg]),
        h('div.field', [
          h('div.input-group', [keywordInput, searchBtn]),
          sourceHint,
        ]),
        resultBox,
      ]),
    }),
    card({
      title: '粘贴链接',
      sub: '不想搜就在播放器里复制链接过来',
      iconName: 'link',
      className: 'lyrics-link',
      body: h('div.col', [
        h('div.input-group', [linkInput, linkBtn]),
        h('div.field-hint', '支持网易云歌曲链接 / 歌曲 ID，以及 QQ 音乐的 songDetail 链接 / songmid。'),
      ]),
    }),
    card({
      title: '登录',
      sub: '取版权曲与翻译歌词时用得上',
      iconName: 'shield',
      iconColor: 'pink',
      actions: loginChip,
      className: 'lyrics-login',
      body: h('div.col.gap-lg', [
        h('div.row', [qrBtn, logoutBtn]),
        qrCanvas,
        qrHint,
        h('div.field', [
          h('label.field-label', '网易云 Cookie（扫码不方便时直接粘贴）'),
          h('div.input-group', [cookieInput, cookieBtn]),
          h('div.field-hint', '保存后不会回显真实值，只会显示「已设置」。留空保存 = 清除。'),
        ]),
        h('div.field', [
          h('label.field-label', 'QQ 音乐 Cookie（可选）'),
          h('div.input-group', [qqCookieInput, qqCookieBtn]),
          h('div.field-hint', 'QQ 没有扫码登录，只能粘贴。多数歌词不填也能取。'),
        ]),
      ]),
    }),
  ])

  const right = h('div.col.gap-lg', [
    card({
      title: '歌词预览',
      sub: '原文与译文分开显示',
      iconName: 'book',
      actions: modeSeg,
      className: 'lyrics-preview-card',
      body: h('div.col', [metaBox, h('div.divider'), previewBox]),
    }),
    card({
      title: '保存',
      sub: 'LRC 给播放器，SRT 给剪辑 / 字幕',
      iconName: 'save',
      className: 'lyrics-save',
      body: h('div.col.gap-lg', [
        h('div.field', [
          h('label.field-label', '格式'),
          h('div.row', [formatSeg, h('div.spacer'), h('span.small.muted', '双语'), bilingualToggle]),
          h('div.field-hint', '双语导出：LRC 会在原文下面加一行同时间戳的译文；SRT 会把译文放在同一条字幕的第二行。'),
        ]),
        h('div.field', [
          h('label.field-label', '输出目录'),
          dirInput.el,
          h('div.field-hint', `默认是系统下载目录（设置页可改）：${state.paths?.outputDir || '未读取到'}`),
        ]),
        h('div.field', [
          h('label.field-label', '文件名'),
          nameInput,
          h('div.field-hint', '不用加扩展名，按上面的格式自动补 .lrc / .srt。文件一律 UTF-8 编码。'),
        ]),
        h('div.row', [saveBtn, coverBtn]),
        savedBox,
      ]),
    }),
  ])

  mount(container, h('div.lyrics-layout', [left, right]))

  // 离开视图时把轮询停掉，别让定时器在后台一直打接口
  return () => stopPoll()
}

export default { render }
