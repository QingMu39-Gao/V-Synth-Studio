/**
 * 总览视图：环境检测、快捷入口、编辑器启动
 */

import { api, watchJob } from '../api.js'
import { h, mount, icon, toast, button, card, statBlock, alertBox, progressBar, emptyState } from '../ui.js'

export async function render(ctx) {
  const { container, headerActions, state, navigate, refreshState } = ctx

  mount(headerActions,
    button('重新检测', {
      iconName: 'refresh',
      onClick: async (e) => {
        const btn = e.currentTarget
        btn.classList.add('loading')
        try {
          const data = await api.detect(true)
          await refreshState()
          toast(`检测完成：${data.installedCount} 个程序可用`, 'ok')
          render(ctx)
        } catch (err) {
          toast(`检测失败：${err.message}`, 'err')
        } finally {
          btn.classList.remove('loading')
        }
      },
    })
  )

  const checks = computeChecks(state)

  mount(container,
    h('div.col.gap-lg.stagger', [
      hero(state, navigate),
      checks.length ? readinessCard(checks, navigate) : null,
      quickActions(navigate),
      h('div.grid.grid-2', [
        editorsCard(state),
        toolsCard(state, ctx),
      ]),
      voicesCard(state, navigate),
      formatsCard(state),
    ])
  )
}

/* ------------------------------------------------------------ 片段 */

function hero(state, navigate) {
  const formats = state.formats.filter((f) => f.available).length
  const editors = state.editors.filter((e) => e.installed).length
  return h('div.hero', [
    h('div.hero-main', [
      h('h2', '欢迎回来'),
      h('p', {
        style: { marginBottom: '6px' },
        html: `<b style="color:var(--accent)">这里本是清沐方便自己调音利用 ds 做的工作站。</b>`,
      }),
      h('p', {
        html: `顺手把翻调流程里最烦的几件事也收在了一起：<b>工程格式互转</b>（完全离线）、<b>MV 解析下载</b>、<b>人声分离与音频处理</b>、以及一份随手可查的<b>资源导航</b>。所有转换都在你自己机器上完成，工程不会离开本地。`,
      }),
      h('div.hero-actions', [
        button('开始转换工程', { variant: 'btn-primary', iconName: 'swap', onClick: () => navigate('convert') }),
        button('解析 MV 链接', { iconName: 'video', onClick: () => navigate('video') }),
        button('打开资源库', { iconName: 'library', onClick: () => navigate('resources') }),
      ]),
    ]),
    h('div', { style: { textAlign: 'right', flexShrink: '0' } }, [
      h('div.stat-value.accent', { style: { fontSize: '30px' } }, String(formats)),
      h('div.stat-label', '可用格式'),
      h('div', { style: { height: '12px' } }),
      h('div.stat-value.purple', { style: { fontSize: '30px' } }, String(editors)),
      h('div.stat-label', '已装编辑器'),
    ]),
  ])
}

/** 环境就绪度检查：把「缺什么、缺了会怎样」直接讲清楚 */
function computeChecks(state) {
  const checks = []
  const tools = state.tools ?? {}
  const formats = state.formats ?? []

  if (!tools.ffmpeg?.available) {
    checks.push({
      id: 'ffmpeg',
      level: 'warn',
      title: '未安装 ffmpeg',
      detail: 'MV 下载后无法自动把视频流和音频流合并成 mp4，也不能导出 WAV/MP3、不能做变调变速。',
      fix: 'install-ffmpeg',
      fixLabel: '一键获取',
    })
  }
  if (!tools.ytdlp?.available) {
    checks.push({
      id: 'ytdlp',
      level: 'info',
      title: '未安装 yt-dlp',
      detail: 'B 站解析是本程序原生实现的，不受影响；但 YouTube 及其它上千个站点需要 yt-dlp 才能解析。',
      fix: 'install-ytdlp',
      fixLabel: '一键获取',
    })
  }
  const unavailable = formats.filter((f) => !f.available)
  if (unavailable.length) {
    checks.push({
      id: 'formats',
      level: 'info',
      title: `有 ${unavailable.length} 种格式的转换模块尚未就绪`,
      detail: `可用：${formats.filter((f) => f.available).map((f) => f.name).join('、') || '无'}。未就绪：${unavailable.map((f) => f.name).join('、')}。`,
      fix: null,
    })
  }
  if (state.editors.filter((e) => e.installed).length === 0) {
    checks.push({
      id: 'editors',
      level: 'info',
      title: '没有检测到任何编辑器',
      detail: '如果确实装了但没被认出来，可以在「设置 → 自定义程序」里手动指定 exe 路径。',
      fix: 'settings',
      fixLabel: '去设置',
    })
  }
  return checks
}

function readinessCard(checks, navigate) {
  return card({
    title: '环境就绪度',
    sub: `${checks.length} 项待处理`,
    iconName: 'shield',
    iconColor: 'warn',
    body: h('div.col', checks.map((c) =>
      h('div.row', { style: { alignItems: 'flex-start' } }, [
        h(`div.finding.${c.level}`, { style: { flex: '1' } }, [
          icon(c.level === 'warn' ? 'alert' : 'info', 14),
          h('div', [h('div.strong', { style: { marginBottom: '2px' } }, c.title), h('div', c.detail)]),
        ]),
        c.fix
          ? button(c.fixLabel ?? '处理', {
              size: 'btn-sm',
              variant: c.fix.startsWith('install') ? 'btn-primary' : '',
              onClick: () => {
                if (c.fix === 'settings') navigate('settings')
                else installTool(c.fix.replace('install-', ''), navigate)
              },
            })
          : null,
      ])
    )),
  })
}

/** 一键获取外部工具，带进度反馈 */
async function installTool(which, navigate) {
  try {
    const { jobId } = await api.installTool(which)
    toast(`正在获取 ${which}…`, 'info')
    watchJob(jobId, {
      onUpdate: (job) => {
        const dot = document.getElementById('status-text')
        if (dot) dot.textContent = `${job.message ?? ''} ${job.percent ? Math.round(job.percent) + '%' : ''}`
      },
      onDone: async (job) => {
        toast(`${which} 已就绪`, 'ok')
        const { refreshState: rs } = await import('../main.js')
        await rs()
        navigate('dashboard')
      },
      onError: (err) => toast(`${which} 获取失败：${err.message}`, 'err'),
    })
  } catch (err) {
    toast(err.message, 'err')
  }
}

function quickActions(navigate) {
  const items = [
    { id: 'convert', iconName: 'swap', title: '工程转换', desc: 'vsqx / vpr / ust / ustx / svp / ccs 互转，批量、可选输出目录，转换前先告诉你哪些数据会丢', cls: '' },
    { id: 'video', iconName: 'video', title: 'MV 解析下载', desc: 'B 站原生解析（含 WBI 签名、大会员画质、弹幕字幕）+ yt-dlp 覆盖 YouTube 等站点', cls: 'pink' },
    { id: 'audio', iconName: 'wave', title: '人声分离 / 音频', desc: 'MVSEP、UVR 直达；本地 ffmpeg 做 WAV/MP3 导出、变调变速、响度标准化', cls: 'purple' },
    { id: 'resources', iconName: 'library', title: '资源导航', desc: '立绘、免费声库、插件、可下 WAV 的音源站 —— 只存链接，不占你的硬盘', cls: 'info' },
  ]
  return h('div.quick-grid', items.map((it) =>
    h(`button.quick-card${it.cls ? '.' + it.cls : ''}`, { onclick: () => navigate(it.id) }, [
      h('div.qc-icon', [icon(it.iconName, 18)]),
      h('h3', it.title),
      h('p', it.desc),
    ])
  ))
}

function editorsCard(state) {
  const editors = state.editors ?? []
  const installed = editors.filter((e) => e.installed)
  const missing = editors.filter((e) => !e.installed)

  const renderApp = (e) => {
    const initial = e.name.slice(0, 1)
    return h(`div.app-card${e.installed ? '.installed' : '.missing'}`, [
      h('div.app-dot', {
        style: { background: e.installed ? `linear-gradient(135deg, ${e.color ?? '#39c5bb'}, ${e.color ?? '#39c5bb'}88)` : 'var(--bg-4)', color: e.installed ? '#06131a' : 'var(--text-3)' },
      }, initial),
      h('div.app-info', [
        h('div.app-name.truncate', e.name),
        h('div.app-meta.truncate', e.installed ? (e.how ?? '已检测到') : (e.vendor ?? '未检测到')),
      ]),
      e.installed
        ? h('button.btn.btn-ghost.btn-icon.btn-sm', {
            title: '启动',
            onclick: async () => {
              try {
                await api.launch({ id: e.id })
                toast(`已启动 ${e.name}`, 'ok')
              } catch (err) {
                toast(`启动失败：${err.message}`, 'err')
              }
            },
          }, [icon('play', 14)])
        : null,
    ])
  }

  return card({
    title: '本机编辑器',
    sub: installed.length ? `已检测到 ${installed.length} 个` : '未检测到',
    iconName: 'cpu',
    actions: h('span.chip', `${editors.length} 个候选`),
    body: h('div.col', [
      h('div.app-grid', installed.map(renderApp)),
      missing.length
        ? h('details', { style: { marginTop: '6px' } }, [
            h('summary', { style: { cursor: 'pointer', fontSize: '12px', color: 'var(--text-3)' } }, `未检测到的 ${missing.length} 个`),
            h('div.app-grid', { style: { marginTop: '10px' } }, missing.map(renderApp)),
          ])
        : null,
    ]),
  })
}

function toolsCard(state, ctx) {
  const tools = state.tools ?? {}
  const rows = [
    {
      key: 'ffmpeg',
      name: 'ffmpeg',
      desc: '音视频合并、导出 WAV/MP3、变调变速',
      info: tools.ffmpeg,
    },
    {
      key: 'ytdlp',
      name: 'yt-dlp',
      desc: 'YouTube 等上千站点的解析与下载',
      info: tools.ytdlp,
    },
    {
      key: 'python',
      name: 'Python',
      desc: '可选，用于部分脚本与 yt-dlp 模块模式',
      info: tools.python,
    },
  ]
  return card({
    title: '外部工具',
    sub: '不随程序分发，按需获取',
    iconName: 'package',
    iconColor: 'purple',
    body: h('div.col', rows.map((r) =>
      h('div.row', [
        h('div', { style: { flex: '1', minWidth: '0' } }, [
          h('div.row.gap-sm', [
            h('span', { style: { fontSize: '12.5px', fontWeight: '500' } }, r.name),
            r.info?.available ? h('span.chip.ok', r.info.version ? String(r.info.version).slice(0, 26) : '已就绪') : h('span.chip', '未安装'),
          ]),
          h('div.tiny.dim.truncate', r.desc),
        ]),
        r.info?.available
          ? r.info.path
            ? h('button.btn.btn-ghost.btn-icon.btn-sm', {
                title: '定位文件',
                onclick: () => api.fsReveal(r.info.path, true).catch((e) => toast(e.message, 'err')),
              }, [icon('folder', 13)])
            : null
          : (r.key === 'python' ? null : button('获取', { size: 'btn-sm', iconName: 'download', onClick: () => installTool(r.key, ctx.navigate) })),
      ])
    )),
  })
}

/**
 * 本机声库：转 .vpr 时会用这里的 compID 自动挂上对应声库
 * （否则转出来的 VOCALOID 工程打开后是空歌手）
 */
function voicesCard(state, navigateRef) {
  const voices = state.voices ?? { vocaloid: [], openutau: [], synthv: [], total: 0 }
  const banks = [...(voices.vocaloid ?? []), ...(voices.openutau ?? []), ...(voices.synthv ?? [])]
  const gotoVoices = () => navigateRef('settings', { section: 'voices' })
  if (!banks.length) {
    return card({
      title: '本机声库',
      sub: '未检测到',
      iconName: 'music',
      iconColor: 'pink',
      actions: button('手动指定目录', { size: 'btn-sm', variant: 'btn-primary', iconName: 'folder', onClick: gotoVoices }),
      body: h('div.col', [
        h('div.small.muted', voices.hint || '没有检测到声库。VOCALOID 声库正常安装时会登记到注册表，一般都能自动识别；便携版或手动拷贝的声库请在「设置 → 声库目录」里指定它所在的根目录。'),
      ]),
    })
  }

  // 按「所属产品」分组，避免 24 个变体平铺成一坨
  const byProduct = new Map()
  for (const b of banks) {
    const key = b.group || b.name.replace(/(_V[0-9]X?|_[A-Z]{3,4})+$/i, '').replace(/_(Original|Sweet|Soft|Dark|Solid|Power|Warm|Cold|Serious|Straight|Whisper|Natural|Normal|Meng|Ning|Wan|EVEC).*$/i, '')
    if (!byProduct.has(key)) byProduct.set(key, [])
    byProduct.get(key).push(b)
  }
  const products = [...byProduct.entries()].sort((a, b) => b[1].length - a[1].length)

  return card({
    title: '本机声库',
    sub: `检测到 ${banks.length} 个` + (voices.registryCount ? `（其中 ${voices.registryCount} 个来自注册表登记）` : ''),
    iconName: 'music',
    iconColor: 'pink',
    actions: h('div.row.gap-sm', [
      button('声库目录设置', { size: 'btn-sm', iconName: 'gear', onClick: gotoVoices }),
      h('button.btn.btn-ghost.btn-sm', {
        title: '重新扫描',
        onclick: async () => {
          const { refreshState: rs } = await import('../main.js')
          await rs()
          toast('已重新扫描声库', 'ok')
        },
      }, [icon('refresh', 13), '重新扫描']),
    ]),
    body: h('div.col', [
      h('div.tiny.dim', '转成 VOCALOID5/6 工程（.vpr）时，会按歌手名自动匹配这里的声库并写入 compID，这样打开工程就能直接出声——否则歌手栏会是空的。'),
      h('div.grid.grid-2', products.map(([name, list]) =>
        h('div', [
          h('div.row.gap-sm', { style: { marginBottom: '5px' } }, [
            h('span.strong.small', name || '其它'),
            h('span.chip', String(list.length)),
          ]),
          h('div.chip-group', list.map((b) =>
            h('span.chip', { title: `${b.name}\ncompID: ${b.compID}\n${b.dir}` }, [
              b.name.replace(name + '_', '').replace(/^_/, '') || b.name,
            ])
          )),
        ])
      )),
    ]),
  })
}

function formatsCard(state) {
  const groups = {}
  for (const f of state.formats ?? []) {
    groups[f.group] = groups[f.group] ?? []
    groups[f.group].push(f)
  }
  return card({
    title: '格式支持',
    sub: '绿色为已就绪，灰色为模块待补齐',
    iconName: 'layers',
    iconColor: 'info',
    body: h('div.col', Object.entries(groups).map(([group, list]) =>
      h('div', [
        h('div.tiny.dim', { style: { marginBottom: '6px', letterSpacing: '0.06em' } }, group.toUpperCase()),
        h('div.chip-group', list.map((f) =>
          h(`span.chip${f.available ? '.accent' : ''}`, { title: f.available ? (f.fidelity?.notes ?? '') : (f.reason ?? '未实现') }, [
            f.available ? icon('check', 11) : null,
            f.name,
            h('span.dim', { style: { fontFamily: 'Consolas, monospace', fontSize: '10px' } }, f.exts.join('/')),
          ])
        )),
      ])
    )),
  })
}

export default { render }
