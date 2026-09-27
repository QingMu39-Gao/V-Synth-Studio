/**
 * 歌词：从网易云 / QQ 音乐搜歌 → 取歌词 → 导出 LRC / SRT / 封面 → 带去「文字 PV」
 *
 * 后端：`server/lyrics.rs`（路由）+ `lyrics.rs`（平台实现）；接口见 api.js 的 lyrics*。
 * 登录：网易云两条路 —— 手机号 + 短信验证码、浏览器 Cookie 兜底。
 * （扫码那条已移除：真机实测网易云始终回 8821，判断是服务端风控，不修了。）
 * 与「工程转换」页里的 lrc/srt **是两回事**：那边是 LibreSVIP 的工程格式，
 * 这边是给翻调打歌词用的、带时间轴的双语歌词文本。
 */

import { api } from '../api.js'
import {
  h, mount, icon, toast, button, card, segmented, emptyState, alertBox,
  switchToggle, formatDuration,
} from '../ui.js'
import { directoryInput } from '../components/dirPicker.js'

/** 后端对已保存的 Cookie 只回显这个占位串（真实值不出后端） */
const MASK = '已设置'

/** 「用这段歌词做文字 PV」把 LRC 交给文字 PV 页用的 localStorage 键（两边要一致） */
const LS_PV_LYRICS = 'qingmu.pv.lyrics'

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
  let smsTimer = null
  let smsLeft = 0
  let nickname = ''

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
  const phoneInput = h('input.input', {
    type: 'tel',
    inputmode: 'numeric',
    maxlength: '11',
    autocomplete: 'off',
    placeholder: '11 位手机号，不用填 +86',
  })
  const smsBtn = button('发送验证码', { onClick: () => sendSms() })
  const captchaInput = h('input.input.mono', {
    inputmode: 'numeric',
    maxlength: '10',
    autocomplete: 'off',
    placeholder: '手机收到的短信验证码',
    onkeydown: (e) => { if (e.key === 'Enter') doLogin() },
  })
  const loginBtn = button('登录', { variant: 'btn-primary', iconName: 'shield', onClick: () => doLogin() })
  // 退出：默认隐藏，renderLogin() 里按登录态显示
  const logoutBtn = button('退出登录', { variant: 'btn-ghost', size: 'btn-sm', iconName: 'x', onClick: () => doLogout() })
  logoutBtn.style.display = 'none'
  const loginMsg = h('div.field-hint')
  // Cookie 用 textarea：整行 Cookie 很长，单行输入框里根本看不全
  const cookieInput = h('textarea.textarea.mono', {
    rows: 3,
    spellcheck: 'false',
    placeholder: 'MUSIC_U=...　（怎么拿见下面的步骤说明）',
  })
  const cookieBtn = button('保存', { variant: 'btn-primary', size: 'btn-sm', iconName: 'save', onClick: () => saveCookie('neteaseCookie', cookieInput) })
  const cookieClearBtn = button('清除', { variant: 'btn-ghost', size: 'btn-sm', iconName: 'trash', onClick: () => clearCookie('neteaseCookie', cookieInput) })
  const qqCookieInput = h('textarea.textarea.mono', {
    rows: 2,
    spellcheck: 'false',
    placeholder: 'QQ 音乐 Cookie（可选，多数歌词不填也能取）',
  })
  const qqCookieBtn = button('保存', { size: 'btn-sm', iconName: 'save', onClick: () => saveCookie('qqCookie', qqCookieInput) })
  const qqCookieClearBtn = button('清除', { variant: 'btn-ghost', size: 'btn-sm', iconName: 'trash', onClick: () => clearCookie('qqCookie', qqCookieInput) })

  /* 怎么拿 Cookie：用户基本都不知道，写细一点，能照着做 */
  const cookieHelp = h('details.lyrics-help', [
    h('summary', '怎么拿到 Cookie？（点开看步骤）'),
    h('div.col.gap-sm', [
      h('ol', [
        h('li', ['用浏览器打开 ', h('span.mono', 'https://music.163.com'), ' 并登录（手机号、验证码都行）。']),
        h('li', ['按 ', h('kbd', 'F12'), ' 打开开发者工具。']),
        h('li', ['切到 ', h('strong', 'Application'), ' 标签（中文界面是「应用程序」，在顶部一排里）。']),
        h('li', ['左边展开 ', h('strong', 'Cookies'), ' → 点 ', h('span.mono', 'https://music.163.com'), '。']),
        h('li', ['在列表里找到名为 ', h('span.mono', 'MUSIC_U'), ' 的那一行，双击 Value 那一格，全选复制。']),
        h('li', '回到这里粘进上面的框，点「保存」。'),
      ]),
      h('div.field-hint', '只复制 MUSIC_U 那一格的值就行（保存时会自动补上 MUSIC_U=）；把整行 Cookie（MUSIC_U=xxx; __csrf=yyy; …）整个粘进来也能用。'),
      // alertBox 的 message 走 innerHTML，只能给字符串
      alertBox('warn', 'MUSIC_U 是 HttpOnly cookie，在 Console 里敲 document.cookie 是看不到它的 —— 网上教程那招在这里没用，必须按上面的步骤在 Application → Cookies 里找。'),
      // 安全提示：这个是登录凭据，不能外传。界面上必须写清楚。
      alertBox('err', 'MUSIC_U 等同账号登录态：不要发给别人、不要贴到群里、不要截图发出来。谁拿到它就能用你的账号。'),
    ]),
  ])

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
  const pvBtn = button('用这段歌词做文字 PV', { iconName: 'film', onClick: () => toTextPv() })
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

  /* ── 一键带去「文字 PV」 ── */

  /**
   * 把当前这首歌的歌词交给「文字 PV」页。
   *
   * 交接方式：写 localStorage（同源，两边都读得到），再 navigate 过去。
   * 为什么不用 params 传：params 只在这次导航里存在，用户在 PV 页按一下 F5 就没了。
   *
   * 带的是**原文 LRC 原文**，不自己拼双语 —— JIZURA 认 LRC 时间戳，也认
   * `歌词|注音` 这种一行两段的写法，把两段 LRC 和格式说明一起交给它，比在这里
   * 猜它的语法稳妥（时间戳归它解析，自己不重复实现一遍）。
   */
  function toTextPv() {
    const lyric = String(current?.lyric ?? '').trim()
    if (!lyric) {
      toast('还没有选中歌曲，先搜一首或粘贴链接把歌词取回来', 'warn')
      return
    }

    const parts = [lyric]
    const trans = String(current?.trans ?? '').trim()
    // 只有双语开关打开、且这首真有译文时才带译文（和后端保存 LRC 的规则一致）
    if (bilingual && trans) parts.push(trans)
    if (parts.length > 1) {
      parts.push('# 上面第一段是原文、第二段是译文。请把译文放到「注釈」的位置：原文|译文（同一行用竖线分开），别当成两句歌词。')
    }

    const text = parts.join('\n')
    try {
      localStorage.setItem(LS_PV_LYRICS, text)
    } catch (err) {
      // 存不下（隐私模式 / 配额满）就别硬跳 —— 跳过去是空的，用户只会以为功能坏了
      toast(`歌词存不进浏览器缓存，没法带过去：${err.message}`, 'err')
      return
    }
    ctx.navigate('pv')
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
    const label = source === 'qq' ? 'QQ 音乐' : '网易云'
    const has = !!state.config?.[key]
    loginChip.className = `chip${has ? ' ok' : ''}`
    // 昵称是登录成功时后端顺手带回来的，没带到就只说已登录
    mount(loginChip, `${label}：${has ? (source === 'netease' && nickname ? `已登录为 ${nickname}` : '已登录') : '未登录'}`)
    // 退出按钮只在已登录时出现 —— 之前没有它，登录完就没法退出了
    logoutBtn.style.display = has ? '' : 'none'
  }

  /**
   * 退出登录：清掉当前来源的 Cookie。
   *
   * 登录态就是 config 里一个 Cookie 字段，清空即退出，没有别的状态要处理。
   */
  async function doLogout() {
    logoutBtn.classList.add('loading')
    try {
      await api.lyricsLogout(source)
      nickname = ''
      // 先把界面上那份 config 同步掉，再重渲染 —— 顺序反了徽章会慢一拍
      await ctx.refreshState({ silent: true })
      if (cookieInput) cookieInput.value = ''
      if (source === 'qq' && qqCookieInput) qqCookieInput.value = ''
      renderLogin()
      setLoginMsg('已退出登录。', 'ok')
      toast('已退出登录', 'ok')
    } catch (err) {
      setLoginMsg(`退出失败：${err.message}`, 'err')
    } finally {
      logoutBtn.classList.remove('loading')
    }
  }

  /** 一条提示只改内容：错误留在页面上，别只弹个 toast 就没了 */
  function setLoginMsg(text, type = 'warn') {
    loginMsg.textContent = text ?? ''
    // 颜色用现成的 CSS 变量，不新增类（UI-KIT 里没有 .field-hint 的修饰类）
    loginMsg.style.color = type === 'err' ? 'var(--err)' : type === 'ok' ? 'var(--ok)' : ''
  }

  function stopSmsTimer() {
    if (smsTimer) {
      clearInterval(smsTimer)
      smsTimer = null
    }
  }

  /** 倒计时期间按钮禁用：既是防连点，也是免得用户一直点着发短信 */
  function startSmsCountdown(seconds) {
    stopSmsTimer()
    smsLeft = seconds
    const tick = () => {
      if (smsLeft <= 0) {
        stopSmsTimer()
        smsBtn.disabled = false
        smsBtn.textContent = '重新发送'
        return
      }
      smsBtn.disabled = true
      smsBtn.textContent = `${smsLeft} 秒后可重发`
      smsLeft -= 1
    }
    tick()
    smsTimer = setInterval(tick, 1000)
  }

  async function sendSms() {
    const phone = phoneInput.value.replace(/\D/g, '')
    if (phone.length !== 11) {
      setLoginMsg('请填 11 位手机号（不用填 +86）', 'err')
      toast('手机号要 11 位数字', 'warn')
      return
    }
    smsBtn.classList.add('loading')
    smsBtn.disabled = true
    setLoginMsg('正在发送验证码…', 'info')
    try {
      await api.lyricsSms(phone)
      startSmsCountdown(60)
      setLoginMsg(`验证码已发到 ${phone}，收到后填在下面。`, 'ok')
      toast('验证码已发送', 'ok')
    } catch (err) {
      // 号码没注册 / 今天发太多 / 网络不通：原样显示网易云或本地给出的话
      setLoginMsg(err.message, 'err')
      toast(err.message, 'err')
    } finally {
      smsBtn.classList.remove('loading')
      // 发失败时把按钮放回去（成功的话下面那段倒计时会接管它），
      // 否则用户得干等 60 秒才知道短信根本没发出去
      if (!smsTimer) smsBtn.disabled = false
    }
  }

  async function doLogin() {
    const phone = phoneInput.value.replace(/\D/g, '')
    const captcha = captchaInput.value.trim()
    if (phone.length !== 11) {
      setLoginMsg('请填 11 位手机号（不用填 +86）', 'err')
      return
    }
    if (!captcha) {
      setLoginMsg('请先填短信验证码', 'err')
      return
    }
    loginBtn.classList.add('loading')
    loginBtn.disabled = true
    setLoginMsg('登录中…', 'info')
    try {
      const res = await api.lyricsCellphone(phone, captcha)
      captchaInput.value = ''
      nickname = res.nickname ?? ''
      setLoginMsg(nickname
        ? `登录成功：${nickname}　登录态已经保存，可以直接搜索取歌词了。`
        : '登录成功，登录态已经保存，可以直接搜索取歌词了。', 'ok')
      toast(nickname ? `登录成功：${nickname}` : '登录成功', 'ok')
      await ctx.refreshState({ silent: true })
      renderLogin()
    } catch (err) {
      // 验证码错误 / 号码没注册 / 接口变更，都要原样显示出来
      setLoginMsg(err.message, 'err')
      toast(err.message, 'err')
    } finally {
      loginBtn.classList.remove('loading')
      loginBtn.disabled = false
    }
  }

  async function saveCookie(key, input) {
    // 从开发者工具整行复制出来的 Cookie 常带换行，Cookie 头里不能有换行 —— 折成一行再存
    const raw = input.value.replace(/\s*\r?\n\s*/g, ' ').trim()
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

  /** 清除 = 清空输入框并按空值保存（后端语义：留空即清除），登录态一起丢 */
  async function clearCookie(key, input) {
    input.value = ''
    await saveCookie(key, input)
    if (key === 'neteaseCookie') {
      nickname = ''
      setLoginMsg('已清除网易云的登录态 Cookie，取歌词会退回未登录。', 'warn')
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
      sub: '手机号验证码，或者填浏览器里的 Cookie',
      iconName: 'shield',
      iconColor: 'pink',
      actions: h('div.row.gap-sm', [loginChip, logoutBtn]),
      className: 'lyrics-login',
      body: h('div.col.gap-lg', [
        h('div.field', [
          h('label.field-label', '手机号 + 短信验证码（推荐，只有网易云支持）'),
          h('div.input-group', [phoneInput, smsBtn]),
          h('div.field-hint', '先点「发送验证码」，收到短信后把验证码填在下面点「登录」。没收到就别重复点，多半是号码不对或今天发得太多。'),
        ]),
        h('div.field', [
          h('label.field-label', '短信验证码'),
          h('div.input-group', [captchaInput, loginBtn]),
          h('div.field-hint', '登录成功后登录态存在本机（等同网页版登录），搜索、取歌词、下封面都会带上它。'),
        ]),
        loginMsg,
        h('div.divider'),
        h('div.field', [
          h('label.field-label', '网易云 Cookie（兜底：发不出短信、或想直接用浏览器里那个登录态时用）'),
          cookieInput,
          h('div.row.gap-sm', [cookieBtn, cookieClearBtn]),
          h('div.field-hint', '保存后不会回显真实值，只会显示「已设置」（输入框保持空白）。留空保存 = 清除。'),
          h('div.field-hint', '⚠ 这个值等同于你的账号登录态，别分享给别人、别截图发出来。'),
        ]),
        cookieHelp,
        h('div.field', [
          h('label.field-label', 'QQ 音乐 Cookie（可选）'),
          qqCookieInput,
          h('div.row.gap-sm', [qqCookieBtn, qqCookieClearBtn]),
          h('div.field-hint', 'QQ 音乐没有短信登录，只能粘贴 Cookie。多数歌词不填也能取。'),
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
        h('div.field', [
          h('div.field-hint', '想直接出视频（动态歌词 MP4 / PNG 序列）：把这段歌词带去「文字 PV」。'),
          h('div.row', [pvBtn]),
        ]),
        savedBox,
      ]),
    }),
  ])

  mount(container, h('div.lyrics-layout', [left, right]))

  // 离开视图时把短信倒计时停掉，别让定时器在后台一直打接口
  return () => {
    stopSmsTimer()
  }
}

export default { render }
