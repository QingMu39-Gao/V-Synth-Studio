/**
 * 设置视图
 *
 * 六块内容：路径 / 声库目录 / 视频下载 / 外部工具 / 自定义程序 / 关于
 * 配置存在服务端 app/server/data/config.json，通过 /api/config 读写；
 * 默认下载画质只是前端的记忆值（localStorage），真实画质在下载时会重新选。
 *
 * 注意：服务端返回的 bilibiliCookie 是脱敏字符串「已设置」，
 * 用户没动过输入框时绝不把它提交回去（否则会把真实 Cookie 覆盖成「已设置」）。
 */

import { api, watchJob } from '../api.js'
import {
  h, mount, icon, toast, promptDialog, confirmDialog, modal, button, card, progressBar, statBlock, alertBox,
} from '../ui.js'
import { directoryInput, pickDirectory } from '../components/dirPicker.js'

const LS_QUALITY = 'fandiao.settings.quality'
const LS_SECTION = 'fandiao.settings.section'
const MASK = '已设置'

/** 画质偏好 → B 站 qn 号（只是为了显示一句人话，真实画质在下载时按登录态再定） */
const QUALITY_QN = {
  '240P': 6, '360P': 16, '480P': 32, '720P': 64, '720P60': 74,
  '1080P': 80, '1080P+': 112, '1080P60': 116, '4K': 120, '8K': 127,
}

const SECTIONS = [
  { id: 'paths', label: '路径', iconName: 'folder', title: '路径', sub: '下载与转换结果默认存到哪里' },
  { id: 'voices', label: '声库目录', iconName: 'music', title: '声库目录', sub: '自动检测本机声库；检测不到时可以手动指定目录' },
  { id: 'video', label: '视频下载', iconName: 'video', title: '视频下载', sub: 'B 站 Cookie、代理、画质与线程' },
  { id: 'tools', label: '外部工具', iconName: 'package', title: '外部工具', sub: 'ffmpeg / yt-dlp / Python 的检测与获取' },
  { id: 'programs', label: '自定义程序', iconName: 'cpu', title: '自定义程序', sub: '把常用软件挂进来，随时启动' },
  { id: 'about', label: '关于', iconName: 'info', title: '关于', sub: '版本与本机信息' },
]

/* ------------------------------------------------------------------ 小工具 */

function isAbsPath(p) {
  return typeof p === 'string' && /^[a-zA-Z]:[\\/]/.test(p)
}

function shortVersion(v) {
  const s = String(v ?? '').trim()
  if (!s) return ''
  return s.length > 34 ? `${s.slice(0, 34)}…` : s
}

function qualityHint(raw) {
  const s = String(raw ?? '').trim().toUpperCase()
  if (!s) return '不指定：下载时再选，默认取最高可用画质'
  const upper = s.replace(/\s+/g, '')
  if (QUALITY_QN[upper]) {
    const extra = ['4K', '8K', '1080P60', '1080P+'].includes(upper) ? '（需要登录 Cookie，否则会自动降级）' : ''
    return `对应 B 站 qn=${QUALITY_QN[upper]}${extra}`
  }
  const n = Number(s)
  if (Number.isFinite(n) && n > 0) return `按 B 站 qn 号 ${n} 请求，取不到时自动降级`
  return '按画质名匹配；认不出时退回默认（最高可用）'
}

/** 密码型输入框：显示切换（显/隐）+ 清空 */
function passwordInput({ value = '', placeholder = '' } = {}) {
  const input = h('input.input.mono', { type: 'password', value, placeholder, autocomplete: 'off', spellcheck: 'false' })
  const eye = button('显', {
    variant: 'btn-ghost',
    size: 'btn-sm',
    title: '显示 / 隐藏',
    onClick: () => {
      const show = input.type === 'password'
      input.type = show ? 'text' : 'password'
      eye.textContent = show ? '隐' : '显'
    },
  })
  const clr = h('button.btn.btn-ghost.btn-icon', {
    type: 'button',
    title: '清空输入框',
    onclick: () => {
      input.value = ''
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.focus()
    },
  }, [icon('trash', 14)])
  return { el: h('div.input-group', [input, eye, clr]), input }
}

function toolRow(key, name, desc, info, installFn) {
  const available = !!info?.available
  const version = shortVersion(info?.version)
  const path = info?.path ?? ''
  return h('div.row-wrap', { style: { alignItems: 'flex-start', padding: '10px 0', borderTop: '1px solid var(--border)' } }, [
    h('div', { style: { flex: '1 1 260px', minWidth: '0' } }, [
      h('div.row.gap-sm', [
        h('span', { style: { fontSize: '13px', fontWeight: '500' } }, name),
        available ? h('span.chip.ok', [icon('check', 11), '已就绪']) : h('span.chip.warn', '未安装'),
        version ? h('span.chip', { title: info.version }, version) : null,
      ]),
      h('div.tiny.dim', { style: { marginTop: '2px' } }, desc),
      path ? h('div.tiny.mono.truncate', { title: path, style: { marginTop: '3px', color: 'var(--text-3)' } }, path) : null,
    ]),
    h('div.row.gap-sm', [
      available && isAbsPath(path)
        ? button('定位文件', {
            size: 'btn-sm',
            variant: 'btn-ghost',
            iconName: 'folder',
            onClick: async (e) => {
              const btn = e.currentTarget
              btn.classList.add('loading')
              try {
                await api.fsReveal(path, true)
              } catch (err) {
                toast(err.message, 'err')
              } finally {
                btn.classList.remove('loading')
              }
            },
          })
        : null,
      available
        ? null
        : key === 'python'
          ? button('去官网装', {
              size: 'btn-sm',
              iconName: 'external',
              onClick: () => api.fsOpen({ url: 'https://www.python.org/downloads/windows/' }).catch((err) => toast(err.message, 'err')),
            })
          : button('一键获取', { size: 'btn-sm', variant: 'btn-primary', iconName: 'download', onClick: () => installFn?.(key) }),
    ]),
  ])
}

/** 正在运行的任务订阅，离开视图时统一收掉 */
const jobStops = []

/**
 * 一键获取外部工具
 * 进度卡挂在 box 上（不放进切区块时会重建的面板里），装完调 onReady 重新检测
 */
function install(which, { box, onReady } = {}) {
  const label = which === 'ffmpeg' ? 'ffmpeg' : 'yt-dlp'
  if (!box) return
  const bar = progressBar(0, { size: 'lg' })
  const msg = h('div.small.muted', '正在请求服务端…')
  const log = h('div.log', { style: { maxHeight: '140px' } })
  mount(box, h('div.card', [
    h('div.card-head', [
      h('div.card-icon.pink', [icon('download', 16)]),
      h('h2', `获取 ${label}`),
      h('div.spacer'),
      button('收起', { size: 'btn-sm', variant: 'btn-ghost', iconName: 'x', onClick: () => mount(box, null) }),
    ]),
    h('div.col', [bar, msg, log]),
  ]))
  ;(async () => {
    try {
      const { jobId } = await api.installTool(which)
      const stop = watchJob(jobId, {
        onUpdate: (job) => {
          bar.setBar(job.percent ?? 0, '')
          msg.textContent = job.message ?? '处理中…'
          if (job.logs?.length) {
            mount(log, job.logs.join('\n'))
            log.scrollTop = log.scrollHeight
          }
        },
        onDone: (job) => {
          bar.setBar(100, 'done')
          msg.textContent = job.message ?? `${label} 已就绪`
          toast(`${label} 已就绪`, 'ok')
          onReady?.()
        },
        onError: (err) => {
          bar.setBar(0, 'error')
          msg.textContent = `获取失败：${err.message}`
          toast(`${label} 获取失败：${err.message}`, 'err')
        },
        onCancel: () => {
          bar.setBar(0, 'canceled')
          msg.textContent = '已取消'
        },
      })
      jobStops.push(stop)
    } catch (err) {
      msg.textContent = err.message
      toast(err.message, 'err')
    }
  })()
}

function cookieHelp() {
  return h('div.col', [
    h('div.small.muted', 'SESSDATA 是 B 站登录态里的一段值，填进来之后才能下 1080P+、大会员画质、番剧与部分字幕弹幕。'),
    h('div.divider'),
    h('ol', { style: { paddingLeft: '20px', margin: '0', lineHeight: '1.95', fontSize: '12.5px' } }, [
      h('li', '用电脑浏览器打开 bilibili.com 并确认已登录。'),
      h('li', '按 F12 打开开发者工具，切到「应用程序 / Application」→「Cookie」→ https://www.bilibili.com。'),
      h('li', '在列表里找到名为 SESSDATA 的一行，双击「值」，整段复制（形如 xxxxx%2Cxxxxxxxxxx%2Cxxxxx*xx）。'),
      h('li', '粘贴到上面的输入框，点「保存设置」。'),
    ]),
    h('div.small.dim', '也可以按 F12 → Network，随便点开一个请求，在 Cookie 请求头里找 SESSDATA= 后面那段。'),
    h('div.divider'),
    h('div.small.muted', 'Cookie 只写进本机的 app/server/data/config.json，不会上传到任何服务器；它等同于你的登录凭证，别截图、别外发。'),
  ])
}

/* ------------------------------------------------------------------ 视图 */

export async function render(ctx) {
  const { container, headerActions, state, refreshState } = ctx

  let cfg = { ...(state.config ?? {}) }
  let section = (() => {
    // 支持用 #/settings/voices 这样的地址直达某一节（也方便自测）
    const fromUrl = String(ctx.params?.section ?? '').trim()
    if (fromUrl && SECTIONS.some((s) => s.id === fromUrl)) return fromUrl
    try {
      return localStorage.getItem(LS_SECTION) ?? 'paths'
    } catch {
      return 'paths'
    }
  })()
  if (!SECTIONS.some((s) => s.id === section)) section = 'paths'

  /** B 站 Cookie 输入缓冲；cookieDirty 表示用户真的动过输入框 */
  let cookieBuf = null
  let cookieBase = ''
  let cookieDirty = false
  let health = null

  const navEl = h('div.settings-nav')
  const pane = h('div.col.gap-lg')
  const installBox = h('div')

  mount(container, h('div.settings-layout', [navEl, pane]))

  /** 一键获取：进度卡放在 installBox，装完自动重新检测 + 重绘 */
  const startInstall = (which) => install(which, { box: installBox, onReady: refresh })

  function renderNav() {
    mount(navEl, SECTIONS.map((s) =>
      h(`button${section === s.id ? '.active' : ''}`, {
        type: 'button',
        onclick: () => {
          if (section === s.id) return
          section = s.id
          try {
            localStorage.setItem(LS_SECTION, section)
          } catch {
            /* 隐私模式下写不了，无所谓 */
          }
          renderNav()
          renderPane()
        },
      }, [icon(s.iconName, 15), h('span', { style: { marginLeft: '8px' } }, s.label)])
    ))
  }

  async function reload() {
    const conf = await api.config()
    cfg = { ...(conf.config ?? {}) }
    return cfg
  }

  /** 保存 / 获取工具之后：重新读配置、重新检测、刷新全局状态，再重绘 */
  async function refresh() {
    try {
      await reload()
      await api.detect(true).catch(() => null)
      await refreshState({ silent: true })
      renderPane()
    } catch (err) {
      toast(err.message, 'err')
    }
  }

  /** 统一保存：成功 toast + 刷新全局状态 */
  async function save(patch, okMsg = '设置已保存') {
    try {
      const res = await api.saveConfig(patch)
      cfg = { ...(res.config ?? cfg) }
      cookieDirty = false
      await refreshState({ silent: true })
      toast(okMsg, 'ok')
      return true
    } catch (err) {
      toast(err.message, 'err')
      return false
    }
  }

  function pendingCookiePatch(extra = {}) {
    const raw = cookieBuf?.input.value.trim() ?? ''
    if (!cookieDirty) return extra
    // 没改过就别提交；改过就按真实内容提交（空字符串 = 清除）
    if (raw === MASK) return extra
    return { ...extra, bilibiliCookie: raw }
  }

  /* ---------------- 路径 ---------------- */

  function pathsSection() {
    const out = directoryInput({ value: cfg.outputDir ?? state.paths?.outputDir ?? '', title: '选择默认输出目录', placeholder: '转换结果的默认保存位置…' })
    const dl = directoryInput({ value: cfg.downloadDir ?? state.paths?.downloadDir ?? '', title: '选择默认下载目录', placeholder: '视频 / 音频的默认下载位置…' })
    const saveBtn = button('保存路径设置', {
      variant: 'btn-primary',
      iconName: 'save',
      onClick: async (e) => {
        const btn = e.currentTarget
        btn.classList.add('loading')
        try {
          await save({ outputDir: out.getValue(), downloadDir: dl.getValue() }, '路径已保存')
        } finally {
          btn.classList.remove('loading')
        }
      },
    })
    return [
      card({
        title: '默认目录',
        sub: '只影响默认值，每次操作时还能单独改',
        iconName: 'folder',
        body: h('div.col.gap-lg', [
          h('div.field', [
            h('label.field-label', '默认输出目录（转换结果）'),
            out.el,
            h('div.field-hint', `程序根目录：${state.paths?.root ?? '未读取到'}`),
          ]),
          h('div.field', [
            h('label.field-label', '默认下载目录（视频 / 音频）'),
            dl.el,
            h('div.field-hint', '目录不存在时，下载或转换会按需自动创建。'),
          ]),
          h('div.row', [saveBtn]),
        ]),
      }),
    ]
  }

  /* ---------------- 视频下载 ---------------- */

  function videoSection() {
    // 记住服务端回显的值（可能是脱敏占位「已设置」），用来判断用户是否真的改动过
    cookieBase = cfg.bilibiliCookie ?? ''
    cookieBuf = passwordInput({
      value: cfg.bilibiliCookie === MASK ? MASK : cookieBase,
      placeholder: '粘贴 SESSDATA 的值…',
    })
    cookieDirty = false
    cookieBuf.input.addEventListener('input', () => {
      cookieDirty = cookieBuf.input.value.trim() !== cookieBase
    })

    const setCookieBtn = button('保存 Cookie', {
      variant: 'btn-primary',
      size: 'btn-sm',
      iconName: 'save',
      onClick: async (e) => {
        const btn = e.currentTarget
        const raw = cookieBuf.input.value.trim()
        if (raw === MASK) {
          toast('输入框里还是脱敏占位「已设置」，没有可保存的新值', 'warn')
          return
        }
        btn.classList.add('loading')
        try {
          const ok = await save({ bilibiliCookie: raw }, raw ? 'Cookie 已保存' : 'Cookie 已清除')
          if (ok) renderPane()
        } finally {
          btn.classList.remove('loading')
        }
      },
    })
    const clearCookieBtn = button('清空', {
      size: 'btn-sm',
      variant: 'btn-danger',
      iconName: 'trash',
      onClick: async () => {
        const ok = await confirmDialog({
          title: '清空 B 站 Cookie',
          message: '清空后只能用游客身份解析，1080P+ 与番剧会不可用。',
          detail: '真实 Cookie 会从本机 config.json 里删除。',
          confirmText: '清空',
          danger: true,
        })
        if (!ok) return
        cookieBuf.input.value = ''
        cookieDirty = true
        if (await save({ bilibiliCookie: '' }, 'Cookie 已清除')) renderPane()
      },
    })
    const howBtn = button('如何获取', { size: 'btn-sm', variant: 'btn-ghost', iconName: 'info', onClick: () => cookieHelpModal() })

    const proxyInput = h('input.input.mono', { value: cfg.proxy ?? '', placeholder: 'http://127.0.0.1:7890' })
    let quality = ''
    try {
      quality = localStorage.getItem(LS_QUALITY) ?? ''
    } catch {
      quality = ''
    }
    const qualityInput = h('input.input.mono', {
      value: quality,
      placeholder: '1080P / 720P / 127（留空 = 最高可用）',
      oninput: (e) => {
        try {
          localStorage.setItem(LS_QUALITY, e.target.value.trim())
        } catch {
          /* ignore */
        }
      },
      onchange: () => renderQualityHint(),
    })
    const qualityHintEl = h('div.field-hint')
    function renderQualityHint() {
      qualityHintEl.textContent = qualityHint(qualityInput.value)
    }
    renderQualityHint()

    const threadsInput = h('input.input', { type: 'number', min: '1', max: '16', value: String(cfg.threads ?? 4), style: { maxWidth: '110px' } })

    const saveBtn = button('保存视频设置', {
      variant: 'btn-primary',
      iconName: 'save',
      onClick: async (e) => {
        const btn = e.currentTarget
        const patch = pendingCookiePatch({
          proxy: proxyInput.value.trim(),
          threads: Math.max(1, Math.min(16, Number(threadsInput.value) || 4)),
        })
        btn.classList.add('loading')
        try {
          const ok = await save(patch, '视频设置已保存')
          if (ok) renderPane()
        } finally {
          btn.classList.remove('loading')
        }
      },
    })

    return [
      card({
        title: 'B 站 Cookie',
        sub: '填了才能下高画质、番剧与部分字幕',
        iconName: 'shield',
        iconColor: 'pink',
        actions: howBtn,
        body: h('div.col', [
          h('div.field', [
            h('label.field-label', 'SESSDATA'),
            cookieBuf.el,
            h('div.field-hint', cfg.bilibiliCookie
              ? '已保存（真实值不会回显到页面上）。直接粘贴新值即可覆盖，留空保存等于清除。'
              : '还没设置。不填也能下载，但画质最高只到 480P 左右。'),
          ]),
          h('div.row.gap-sm', [setCookieBtn, clearCookieBtn]),
        ]),
      }),
      card({
        title: '下载行为',
        sub: '代理、画质偏好与并发线程',
        iconName: 'download',
        iconColor: 'info',
        body: h('div.col.gap-lg', [
          h('div.field', [
            h('label.field-label', '代理地址'),
            proxyInput,
            h('div.field-hint', '只对 yt-dlp（YouTube 等站点）生效；B 站走程序内置解析，不受这里影响。支持 http:// 与 socks5://。'),
          ]),
          h('div.field', [
            h('label.field-label', '默认下载画质偏好'),
            qualityInput,
            qualityHintEl,
          ]),
          h('div.field', [
            h('label.field-label', '下载线程数'),
            threadsInput,
            h('div.field-hint', '单文件分片并发，1–16。线路不好时调小更稳，默认 4。'),
          ]),
          h('div.row', [saveBtn]),
        ]),
      }),
    ]
  }

  function cookieHelpModal() {
    const box = modal({
      title: '怎么拿到 SESSDATA',
      wide: true,
      body: cookieHelp(),
      footer: [button('知道了', { variant: 'btn-primary', onClick: () => box.close() })],
    })
  }

  /* ---------------- 外部工具 ---------------- */

  function toolsSection() {
    const tools = state.tools ?? {}
    const detectBtn = button('重新检测', {
      iconName: 'refresh',
      onClick: async (e) => {
        const btn = e.currentTarget
        btn.classList.add('loading')
        try {
          await api.detect(true)
          await refreshState({ silent: true })
          await reload()
          renderPane()
          toast('检测完成', 'ok')
        } catch (err) {
          toast(err.message, 'err')
        } finally {
          btn.classList.remove('loading')
        }
      },
    })
    const missing = ['ffmpeg', 'ytdlp'].filter((k) => !tools[k]?.available)
    return [
      card({
        title: '外部工具',
        sub: '不随程序分发，按需获取到本机 tools 目录',
        iconName: 'package',
        iconColor: 'purple',
        actions: detectBtn,
        body: h('div.col', [
          missing.length
            ? h('div.alert.alert-warn', [
                icon('alert', 16),
                h('div.alert-body', [
                  h('strong', `还缺 ${missing.map((m) => (m === 'ytdlp' ? 'yt-dlp' : m)).join(' / ')}`),
                  h('div', '音频导出、变调变速、非 B 站站点下载会不可用。点下面的「一键获取」，从官方发布地址下载，不走第三方镜像。'),
                ]),
              ])
            : h('div.alert.alert-ok', [icon('check', 16), h('div.alert-body', [h('div', '三个外部工具都齐了，音频与下载功能完整可用。')])]),
          toolRow('ffmpeg', 'ffmpeg', '音视频合并、导出 WAV/MP3、变调变速、响度标准化', tools.ffmpeg, startInstall),
          toolRow('ytdlp', 'yt-dlp', 'YouTube 等上千站点的解析与下载（B 站走内置解析，不需要它）', tools.ytdlp, startInstall),
          toolRow('python', 'Python', '可选：部分脚本与 yt-dlp 的模块模式会用到', tools.python, startInstall),
          h('div.tiny.dim', { style: { marginTop: '6px' } },
            `工具目录：${state.paths?.toolsDir ?? '未读取到'}（已装工具的可执行文件都在这里，不写注册表、不写系统 PATH）`),
        ]),
      }),
    ]
  }

  /* ---------------- 自定义程序 ---------------- */

  function programsSection() {
    const editors = state.editors ?? []
    const detected = editors.filter((e) => e.installed)
    const custom = (cfg.customPrograms ?? []).filter(Boolean)

    const rows = [
      ...detected.map((e) => programRow({
        name: e.name,
        sub: `已检测到 · ${e.vendor ?? ''} ${e.how ? `· ${e.how}` : ''}`.trim(),
        path: e.path,
        color: e.color,
        launchId: e.id,
      })),
      ...custom
        .filter((p) => !detected.some((e) => e.path && p.path && e.path.toLowerCase() === String(p.path).toLowerCase()))
        .map((p) => programRow({
          name: p.name || '(未命名)',
          sub: `手动添加${p.category ? ` · ${p.category}` : ''}`,
          path: p.path,
          color: '#8b95a5',
          removable: true,
          onRemove: async () => {
            const next = custom.filter((x) => x !== p)
            if (await save({ customPrograms: next }, `已移除 ${p.name || '自定义程序'}`)) renderPane()
          },
        })),
    ]

    const nameInput = h('input.input', { placeholder: '例如：我的编辑器', style: { maxWidth: '240px' } })
    const pathInput = h('input.input.mono', { placeholder: 'C:\\Program Files\\xxx\\xxx.exe' })

    const addBtn = button('添加', {
      variant: 'btn-primary',
      iconName: 'plus',
      onClick: async (e) => {
        const btn = e.currentTarget
        const name = nameInput.value.trim()
        const path = pathInput.value.trim()
        if (!name) {
          toast('先给这个程序起个名字', 'warn')
          return
        }
        if (!isAbsPath(path)) {
          toast('请填完整路径，形如 C:\\Program Files\\xxx\\xxx.exe', 'warn')
          return
        }
        btn.classList.add('loading')
        try {
          const next = [...custom, { name, path, category: 'custom' }]
          if (await save({ customPrograms: next }, `已添加 ${name}`)) {
            nameInput.value = ''
            pathInput.value = ''
            renderPane()
          }
        } finally {
          btn.classList.remove('loading')
        }
      },
    })

    return [
      card({
        title: '已检测到的程序',
        sub: '来自本机常见安装位置扫描',
        iconName: 'cpu',
        body: rows.length ? h('div.col', rows) : h('div.empty', { style: { padding: '22px' } }, [
          h('div.empty-icon', [icon('cpu', 22)]),
          h('h3', '没有检测到任何程序'),
          h('p', '编辑器没装在常见目录里？用下面的表单手动指定 exe 路径。'),
        ]),
      }),
      card({
        title: '手动添加程序',
        sub: '把任意 exe 挂进来，之后一键启动',
        iconName: 'plus',
        iconColor: 'info',
        body: h('div.col.gap-lg', [
          h('div.row-wrap', { style: { alignItems: 'flex-end' } }, [
            h('div.field', { style: { flex: '0 1 240px' } }, [h('label.field-label', '名称'), nameInput]),
            h('div.field', { style: { flex: '1 1 320px', minWidth: '220px' } }, [
              h('label.field-label', '可执行文件路径'),
              h('div.input-group', [
                pathInput,
                button('浏览文件', {
                  iconName: 'folder',
                  onClick: async () => {
                    const p = await promptDialog({
                      title: '粘贴 exe 完整路径',
                      label: '在资源管理器里复制路径后粘贴到这里（Ctrl+Shift+C 可复制完整路径）',
                      value: pathInput.value,
                      placeholder: 'C:\\Program Files\\xxx\\xxx.exe',
                    })
                    if (p !== null) pathInput.value = p.trim()
                  },
                }),
              ]),
            ]),
            addBtn,
          ]),
          h('div.field-hint', '这里只登记路径，程序本身由你自行获取安装；登记后可以在本页启动，也能在总览里看到。'),
        ]),
      }),
    ]
  }

  function programRow({ name, sub, path, color = '#8b95a5', launchId, removable, onRemove }) {
    return h('div.row-wrap', { style: { padding: '10px 0', borderTop: '1px solid var(--border)' } }, [
      h('div.app-dot', {
        style: {
          background: `linear-gradient(135deg, ${color}, ${color}88)`,
          color: '#06131a',
          width: '30px',
          height: '30px',
          borderRadius: '9px',
          display: 'grid',
          placeItems: 'center',
          fontSize: '12px',
          fontWeight: '600',
          flexShrink: '0',
        },
      }, String(name ?? '?').slice(0, 1)),
      h('div', { style: { flex: '1 1 240px', minWidth: '0' } }, [
        h('div', { style: { fontSize: '12.5px', fontWeight: '500' } }, name),
        h('div.tiny.dim.truncate', { title: path ?? '' }, sub || path || ''),
        path ? h('div.tiny.mono.truncate', { title: path, style: { color: 'var(--text-3)' } }, path) : null,
      ]),
      h('div.row.gap-sm', [
        launchId
          ? button('启动', {
              size: 'btn-sm',
              iconName: 'play',
              onClick: async (e) => {
                const btn = e.currentTarget
                btn.classList.add('loading')
                try {
                  await api.launch({ id: launchId })
                  toast(`已启动 ${name}`, 'ok')
                } catch (err) {
                  toast(err.message, 'err')
                } finally {
                  btn.classList.remove('loading')
                }
              },
            })
          : path
            ? button('启动', {
                size: 'btn-sm',
                iconName: 'play',
                onClick: async () => {
                  try {
                    await api.launch({ path })
                    toast(`已启动 ${name}`, 'ok')
                  } catch (err) {
                    toast(err.message, 'err')
                  }
                },
              })
            : null,
        path
          ? button('定位文件', {
              size: 'btn-sm',
              variant: 'btn-ghost',
              iconName: 'folder',
              onClick: () => api.fsReveal(path, true).catch((err) => toast(err.message, 'err')),
            })
          : null,
        removable
          ? button('移除', { size: 'btn-sm', variant: 'btn-ghost', iconName: 'trash', onClick: onRemove })
          : null,
      ]),
    ])
  }

  /* ---------------- 关于 ---------------- */

  function aboutSection() {
    const root = state.paths?.root ?? '未读取到'
    return [
      card({
        title: '关于翻调工作站',
        sub: '本地跑的小工具集合',
        iconName: 'info',
        body: h('div.col.gap-lg', [
          h('div.grid.grid-4', [
            statBlock('程序版本', health?.version ?? state.version ?? '1.0.0'),
            statBlock('Node 版本', health?.node ?? '未知'),
            statBlock('运行端口', health?.pid ? `PID ${health.pid}` : '—', { sub: health?.uptimeSec ? `已运行 ${Math.floor(health.uptimeSec / 60)} 分钟` : '' }),
            statBlock('外部工具', `${['ffmpeg', 'ytdlp'].filter((k) => state.tools?.[k]?.available).length} / 2`, { sub: state.tools?.python?.available ? '含 Python' : '无 Python' }),
          ]),
          h('div.field', [
            h('label.field-label', '根目录'),
            h('div.input-group', [
              h('input.input.mono', { value: root, readonly: true, onfocus: (e) => e.target.select() }),
              button('打开', { variant: 'btn-ghost', iconName: 'external', onClick: () => api.fsReveal(root, false).catch((err) => toast(err.message, 'err')) }),
            ]),
          ]),
          h('div.alert.alert-ok', [
            icon('shield', 16),
            h('div.alert-body', [
              h('strong', '所有工程转换均在本机完成，不联网'),
              h('div', '工程文件、音频、Cookie 都只留在这台机器上：转换、音频处理走本地模块，只有你主动点视频解析 / 打开资源链接时才会联网。'),
            ]),
          ]),
          h('div.row-wrap.gap-sm', [
            button('重新读取配置', {
              size: 'btn-sm',
              iconName: 'refresh',
              onClick: async () => {
                try {
                  await reload()
                  renderPane()
                  toast('已重新读取', 'ok')
                } catch (err) {
                  toast(err.message, 'err')
                }
              },
            }),
            button('查看后台日志', {
              size: 'btn-sm',
              variant: 'btn-ghost',
              iconName: 'activity',
              onClick: () => ctx.navigate('dashboard'),
            }),
          ]),
          h('div.tiny.dim', '零依赖实现：不引入任何 npm 包与 CDN 资源，断网也能用。'),
        ]),
      }),
    ]
  }

  /* ---------------- 声库目录 ---------------- */

  function voicesSection() {
    const v = state.voices ?? { vocaloid: [], openutau: [], synthv: [], total: 0 }
    const userDirs = Array.isArray(cfg.voiceDirs) ? [...cfg.voiceDirs] : []
    const banks = [...(v.vocaloid ?? []), ...(v.openutau ?? []), ...(v.synthv ?? [])]

    const listBox = h('div')
    const probeBox = h('div')

    function renderList() {
      mount(listBox, null)
      if (!banks.length) {
        listBox.appendChild(alertBox('warn',
          '没有检测到任何声库。VOCALOID 声库正常安装时会登记到注册表，一般都能自动识别；' +
          '如果用的是便携版或被手动拷贝过，请在下面手动添加声库所在目录。',
          '未检测到声库'))
        return
      }
      // 按引擎 + 产品分组，避免几十个音色变体平铺
      const groups = new Map()
      for (const b of banks) {
        const key = b.engine === 'vocaloid'
          ? (b.name.replace(/_(Original|Sweet|Soft|Dark|Solid|Power|Warm|Cold|Serious|Straight|Whisper|Natural|Normal|Meng|Ning|Wan|EVEC).*$/i, '') || b.name)
          : b.engine === 'openutau' ? 'OpenUtau 歌手' : 'Synthesizer V 声库'
        if (!groups.has(key)) groups.set(key, [])
        groups.get(key).push(b)
      }
      listBox.appendChild(h('div.col', [...groups.entries()].map(([name, list]) =>
        h('div', [
          h('div.row.gap-sm', { style: { marginBottom: '6px' } }, [
            h('span.strong.small', name),
            h('span.chip', String(list.length)),
            h('span.tiny.dim', list[0].source ? `来源：${[...new Set(list.map((x) => x.source))].join(' / ')}` : ''),
          ]),
          h('div.chip-group', list.map((b) =>
            h('span.chip.accent', { title: `${b.name}\ncompID: ${b.compID ?? '-'}\n${b.dir ?? ''}` },
              [icon('music', 11), b.name])
          )),
        ])
      )))
    }

    renderList()

    const addBtn = button('添加声库目录', {
      variant: 'btn-primary',
      iconName: 'plus',
      onClick: () => pickDirectory({
        title: '选择声库所在目录（例如 VOCALOID 的 VoiceDB 根目录）',
        initial: userDirs[0] ?? '',
        onPick: async (dir) => {
          // 先试探：立刻告诉用户这里面有几个声库，而不是加完才发现是空目录
          mount(probeBox, h('div.small.muted', '正在检查该目录…'))
          try {
            const r = await api.post('/api/voices/probe', { dir })
            mount(probeBox, r.found
              ? alertBox('ok', `在该目录（含子目录）里找到 <b>${r.found}</b> 个声库：<br>${[
                  ...r.vocaloid.map((x) => `VOCALOID · ${x.name}`),
                  ...r.openutau.map((x) => `OpenUtau · ${x.name}`),
                  ...r.synthv.map((x) => `SynthV · ${x.name}`),
                ].slice(0, 12).join('<br>')}${r.found > 12 ? '<br>…' : ''}`, '目录检查通过')
              : alertBox('warn', '这个目录下没有找到声库。请选到<b>包含 compID 目录或声库文件夹的那一层</b>（例如 <code>H:\\VoiceDB</code>），而不是某一个音色文件夹里面。', '没找到声库'))
            if (r.found) {
              const next = [...new Set([...userDirs, dir])]
              await save({ voiceDirs: next }, `已添加声库目录，共扫描到 ${r.totalAfterAdd} 个声库`)
              const fresh = await api.get('/api/voices', { force: 1 }).catch(() => null)
              if (fresh) {
                state.voices = { ...state.voices, ...fresh }
                renderPane()
              }
            }
          } catch (err) {
            mount(probeBox, alertBox('err', err.message, '检查失败'))
          }
        },
      }),
    })

    const rescanBtn = button('重新扫描', {
      iconName: 'refresh',
      onClick: async (e) => {
        const btn = e.currentTarget
        btn.classList.add('loading')
        try {
          const fresh = await api.get('/api/voices', { force: 1 })
          state.voices = { ...state.voices, ...fresh }
          await refreshState({ silent: true })
          renderPane()
          toast(`重新扫描完成：共 ${fresh.total} 个声库`, fresh.total ? 'ok' : 'warn')
        } catch (err) {
          toast(err.message, 'err')
        } finally {
          btn.classList.remove('loading')
        }
      },
    })

    return [
      h('div.card', [
        h('div.card-head', [
          h('div.card-icon.pink', [icon('music', 16)]),
          h('div', [
            h('h2', '检测结果'),
            h('div.sub', `共 ${banks.length} 个` +
              (v.registryCount ? `（其中 ${v.registryCount} 个来自注册表登记）` : '')),
          ]),
          h('div.spacer'),
          rescanBtn,
        ]),
        h('div.col', [
          h('div.tiny.dim', '转成 VOCALOID 工程（.vpr）时，会按歌手名在这里自动匹配声库并写入 compID —— 否则打开工程时歌手栏是空的。'),
          v.hint ? alertBox('info', v.hint) : null,
          listBox,
        ]),
      ]),

      h('div.card', [
        h('div.card-head', [
          h('div.card-icon.purple', [icon('folder', 16)]),
          h('div', [h('h2', '手动指定目录'), h('div.sub', '自动检测不到时用这个')]),
        ]),
        h('div.col', [
          h('div.tiny.dim', 'VOCALOID 声库装在注册表登记过的位置时会自动识别，跟你装在哪块盘无关。若你的声库是便携版、或从别的机器拷过来的，在这里指定它所在的<b>根目录</b>即可。'),
          userDirs.length
            ? h('div.list', userDirs.map((d, i) => h('div.list-item', [
                icon('folder', 14),
                h('span.truncate.mono.small', { style: { flex: '1' }, title: d }, d),
                h('button.btn.btn-ghost.btn-sm', {
                  onclick: () => api.fsReveal(d, false).catch((err) => toast(err.message, 'err')),
                }, [icon('external', 12), '打开']),
                h('button.btn.btn-danger.btn-sm', {
                  onclick: async () => {
                    const next = userDirs.filter((_, idx) => idx !== i)
                    if (await save({ voiceDirs: next }, '已移除该目录')) renderPane()
                  },
                }, [icon('trash', 12), '移除']),
              ])))
            : h('div.tiny.dim', '（还没有手动添加任何目录）'),
          h('div.row', [addBtn]),
          probeBox,
        ]),
      ]),

      h('div.card', [
        h('div.card-head', [
          h('div.card-icon.info', [icon('search', 16)]),
          h('div', [h('h2', '试匹配歌手名'), h('div.sub', '验证工程里的歌手名能不能对上本机声库')]),
        ]),
        (() => {
          const input = h('input.input', { placeholder: '例如 初音ミク / Miku(V2) / 洛天依 / 镜音リン', style: { flex: '1' } })
          const out = h('div')
          const test = async () => {
            const singer = input.value.trim()
            if (!singer) return
            mount(out, h('div.small.muted', '查询中…'))
            try {
              const r = await api.post('/api/voices/match', { singer })
              mount(out, r.matched
                ? alertBox('ok', `匹配到 <b>${r.bankName}</b><br>compID：<code>${r.compID}</code><br>依据：${r.reason}（匹配度 ${r.score}）`, '能对上')
                : alertBox('warn', `本机没有找到与「${singer}」对应的声库。转 .vpr 时会按名称生成一个占位 compID，在 VOCALOID 里手动选一次声库即可。`, '对不上'))
            } catch (err) {
              mount(out, alertBox('err', err.message))
            }
          }
          input.addEventListener('keydown', (e) => { if (e.key === 'Enter') test() })
          return h('div.col', [
            h('div.row', [input, button('测试', { variant: 'btn-primary', iconName: 'search', onClick: test })]),
            h('div.tiny.dim', '支持中/日/英混写：初音ミク、初音未来、Miku(V2) 都能对上 MIKU_V4X_*；洛天依会优先挑中文声库；繁简差异也会自动归一。'),
            out,
          ])
        })(),
      ]),
    ]
  }

  /* ---------------- 渲染 ---------------- */

  function renderPane() {
    const def = SECTIONS.find((s) => s.id === section)
    const body =
      section === 'paths' ? pathsSection()
        : section === 'voices' ? voicesSection()
          : section === 'video' ? videoSection()
            : section === 'tools' ? toolsSection()
              : section === 'programs' ? programsSection()
                : aboutSection()

    mount(pane,
      h('div', [
        h('h2', { style: { fontSize: '16px', margin: '0 0 4px' } }, def?.title ?? ''),
        h('div.small.muted', def?.sub ?? ''),
      ]),
      ...body,
      installBox
    )
  }

  /* ---------------- 首屏 ---------------- */

  mount(headerActions, [
    h('span.chip', state.config?.bilibiliCookie ? 'B 站 Cookie 已设置' : 'B 站 Cookie 未设置'),
    h('span.chip.info', `v${state.version ?? '1.0.0'}`),
  ])

  renderNav()
  renderPane()

  // 配置以服务端为准，页面挂载后再拉一次（state.config 里 Cookie 是脱敏值）
  try {
    await reload()
    renderPane()
  } catch (err) {
    toast(`读取配置失败：${err.message}`, 'err')
  }
  try {
    health = await api.health()
    if (section === 'about') renderPane()
  } catch {
    /* 健康检查拿不到不影响使用 */
  }

  return () => {
    for (const stop of jobStops.splice(0)) {
      try {
        stop()
      } catch {
        /* ignore */
      }
    }
    mount(pane, null)
    mount(headerActions, null)
  }
}

export default { render }
