/**
 * 总览视图：环境检测、快捷入口
 */

import { api, watchJob } from '../api.js'
import { h, mount, icon, toast, button, card } from '../ui.js'

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
      toolsCard(state, ctx),
      formatsCard(state),
    ])
  )
}

/* ------------------------------------------------------------ 片段 */

function hero(state, navigate) {
  const formats = state.formats.filter((f) => f.available).length
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
    })
  }
  if (!tools.ytdlp?.available) {
    checks.push({
      id: 'ytdlp',
      level: 'info',
      title: '未安装 yt-dlp',
      detail: 'B 站解析是本程序原生实现的，不受影响；但 YouTube 及其它上千个站点需要 yt-dlp 才能解析。',
    })
  }
  const unavailable = formats.filter((f) => !f.available)
  if (unavailable.length) {
    checks.push({
      id: 'formats',
      level: 'info',
      title: `有 ${unavailable.length} 种格式的转换模块尚未就绪`,
      detail: `可用：${formats.filter((f) => f.available).map((f) => f.name).join('、') || '无'}。未就绪：${unavailable.map((f) => f.name).join('、')}。`,
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
      ])
    )),
  })
}

/** 一键获取外部工具，带进度反馈 */

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
          : (r.key === 'python' ? null : h('span.small.muted', '随包分发')),
      ])
    )),
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
