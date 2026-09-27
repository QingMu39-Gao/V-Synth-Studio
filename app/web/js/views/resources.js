/**
 * 资源库视图
 *
 * 只收录官方、免费、开源、试用渠道的链接，不托管任何文件。
 * 数据来自服务端 app/data/resources.json（经 /api/resources 返回）：
 *   { updatedAt, notice, groups:[{ id, name, icon, description, items:[…] }] }
 *   item: { id, name, url, home, tags[], region, cost, desc, tip, official, verified:{ status, checkedAt, note } }
 */

import { api, watchJob } from '../api.js'
import { h, mount, icon, toast, button, emptyState, progressBar, alertBox, modal } from '../ui.js'

const DEFAULT_NOTICE =
  '盗版声库 / 编辑器压缩包是木马与挖矿程序的高发区：本库只收录官方、免费、开源与试用渠道，不放任何网盘安装包。下载任何可执行文件后，请核对来源、文件大小与哈希，装完先杀毒。'

/** tag → chip 颜色（按关键词猜，猜不中就中性） */
const TAG_TONES = {
  accent: ['官方', '免费', '开源'],
  warn: ['需付费', '注意', '付费'],
  info: ['试用', '需注册', '需登录'],
}

const MAX_TAGS = 3

/** 已展开的分组 id。只存内存：切走视图再回来还记着，但重启就回到默认折叠，不进 config。 */
const expandedGroups = new Set()

/* ------------------------------------------------------------------ 工具函数 */

function safeUrl(raw) {
  const s = String(raw ?? '').trim()
  if (!s) return null
  try {
    return new URL(s)
  } catch {
    if (!/^https?:\/\//i.test(s)) return null
    try {
      return new URL(s)
    } catch {
      return null
    }
  }
}

/** 取展示用域名：优先 home，其次 URL 主机名 */
function hostOf(item) {
  const home = String(item.home ?? '').trim()
  if (home) return home.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  const u = safeUrl(item.url)
  return u ? u.hostname.replace(/^www\./i, '') : ''
}

const STATUS_TEXT = { ok: '可达', dead: '失效', warn: '存疑' }

function statusClass(status, error) {
  if (error) return 'bad'
  if ([200, 301, 302, 403].includes(status)) return 'ok'
  if ([404, 410].includes(status) || !status) return 'bad'
  return '' // 401 / 429 / 5xx 归为存疑
}

function tagTone(tag) {
  for (const [tone, words] of Object.entries(TAG_TONES)) {
    if (words.some((w) => String(tag).includes(w))) return tone
  }
  return ''
}

function stamp(ms) {
  if (!ms) return ''
  try {
    const d = new Date(ms)
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
  } catch {
    return ''
  }
}

/** 复制到剪贴板；剪贴板不可用（非 https、权限被拒）时返回失败 */
async function copyText(text) {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('当前浏览器不提供剪贴板接口')
    await navigator.clipboard.writeText(text)
    return { ok: true }
  } catch (err) {
    return { ok: false, reason: err.message || '剪贴板不可用' }
  }
}

/** 退回手动复制：给一个已全选的输入框 */
function showCopyFallback(text, reason) {
  const input = h('input.input.mono', { value: text, readonly: true, onfocus: (e) => e.target.select() })
  const { close } = modal({
    title: '手动复制链接',
    body: h('div.col', [
      h('div.small.muted', `${reason}。请手动全选复制：`),
      input,
    ]),
    footer: [button('关闭', { onClick: () => close() })],
  })
  setTimeout(() => {
    input.focus()
    input.select()
  }, 60)
}

/** 把一条接口返回的校验结果摊平成卡片徽章能用的形状 */
function normalizeResult(r, prev = {}) {
  const status = Number(r?.status ?? r?.verified?.status ?? prev.status ?? 0)
  const checkedAt = r?.checkedAt ?? r?.verified?.checkedAt ?? prev.checkedAt ?? stamp(Date.now())
  const note = r?.note ?? r?.verified?.note ?? r?.error ?? prev.note ?? ''
  const error = r?.error ?? (status ? '' : note)
  return { status, checkedAt, note, error }
}

/* ------------------------------------------------------------------ 视图 */

export async function render(ctx) {
  const { container, headerActions, state } = ctx

  let data = { groups: [], notice: '', updatedAt: '' }
  let loadErr = ''
  let linksJob = null
  /** `${groupId}/${itemId}` → { status, checkedAt, note } */
  const checkResults = new Map()
  /** 校验结果的键：后端用 `${group}/${item.id}`，item 没写 id 时退回名称 */
  const itemKey = (groupId, item) => `${groupId}/${item?.id ?? item?.name ?? ''}`

  let query = ''
  let activeGroup = ''
  const groupEls = new Map()
  const groupChips = new Map()
  let groupsBox
  let groupBar
  let emptyBox

  /** 加载骨架 */
  const skeleton = () => h('div.col.gap-lg', { style: { paddingTop: '4px' } }, [
    h('div.skeleton', { style: { height: '58px' } }),
    h('div.skeleton', { style: { height: '132px' } }),
    h('div.skeleton', { style: { height: '132px' } }),
  ])

  /* ---------------- 工具栏 ---------------- */

  const searchInput = h('input.input', {
    type: 'search',
    placeholder: '搜索名称、描述、标签…',
    style: { paddingLeft: '30px' },
    oninput: (e) => {
      query = e.target.value.trim().toLowerCase()
      renderGroups()
    },
    onkeydown: (e) => {
      if (e.key === 'Escape') {
        e.target.value = ''
        query = ''
        renderGroups()
      }
    },
  })

  const searchBox = h('div', { style: { position: 'relative', flex: '1 1 240px', minWidth: '190px', maxWidth: '380px' } }, [
    h('span', { style: { position: 'absolute', left: '9px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-3)', display: 'flex' } }, [
      icon('search', 14),
    ]),
    searchInput,
  ])

  groupBar = h('div.row-wrap.gap-sm', { style: { flex: '1 1 auto', minWidth: '0' } })

  const checkBtn = button('校验链接', { variant: 'btn-pink', iconName: 'shield', onClick: checkAll })
  const reloadBtn = button('重新载入', { size: 'btn-sm', variant: 'btn-ghost', iconName: 'refresh', onClick: () => load(true) })

  const resToolbar = h('div.res-toolbar', [
    searchBox,
    h('div', { style: { width: '1px', height: '22px', background: 'var(--border)' } }),
    groupBar,
    h('div.spacer'),
    reloadBtn,
    checkBtn,
  ])

  /* ---------------- 安全提示 ---------------- */

  const noticeBox = h('div', { style: { marginBottom: '4px' } })
  const verifyBox = h('div')

  /* ---------------- 主体容器 ---------------- */

  groupsBox = h('div.col.gap-lg')
  emptyBox = h('div')

  mount(container, h('div.col', [resToolbar, noticeBox, verifyBox, emptyBox, groupsBox]))
  mount(groupsBox, skeleton())

  /* ---------------- 数据加载 ---------------- */

  async function load(reload = false) {
    mount(groupsBox, skeleton())
    mount(emptyBox, null)
    loadErr = ''
    activeGroup = ''
    groupCache.clear()
    try {
      const res = await api.resources(reload)
      checkResults.clear()
      data = {
        groups: Array.isArray(res.groups) ? res.groups.filter((g) => g && (g.items ?? []).length) : [],
        notice: res.notice ?? '',
        updatedAt: res.updatedAt ?? '',
      }
      // 数据里自带 verified 的，先当作初始徽章
      for (const g of data.groups) {
        for (const it of g.items ?? []) {
          if (it?.verified?.status || it?.verified?.checkedAt) {
            checkResults.set(itemKey(g.id, it), normalizeResult(null, it.verified))
          }
        }
      }
    } catch (err) {
      data = { groups: [], notice: '', updatedAt: '' }
      loadErr = err.message
    }
    renderNotice()
    renderGroupBar()
    renderGroups()
    renderHeader()
  }

  /* ---------------- 顶部提示 ---------------- */

  function renderNotice() {
    mount(noticeBox, h('div.alert.alert-warn', [
      icon('alert', 16),
      h('div.alert-body', [
        h('strong', '先看这条：别从网盘下“整合包”'),
        h('div', { html: escapeHtml(data.notice || DEFAULT_NOTICE) }),
      ]),
    ]))
  }

  function renderHeader() {
    const items = data.groups.reduce((n, g) => n + (g.items ?? []).length, 0)
    const groups = data.groups.length
    mount(headerActions, [
      h('span.chip', `${items} 条链接 / ${groups} 个分组`),
      data.updatedAt ? h('span.chip.info', { title: '资源库数据日期' }, `数据 ${data.updatedAt}`) : null,
    ].filter(Boolean))
  }

  /* ---------------- 分组跳转 ---------------- */

  function renderGroupBar() {
    groupChips.clear()
    mount(groupBar, null)
    if (!data.groups.length) return
    const all = h(`button.chip${activeGroup === '' ? '.accent' : ''}`, {
      type: 'button',
      title: '回到顶部',
      onclick: () => {
        setActiveGroup('')
        groupsBox.scrollIntoView({ behavior: 'smooth', block: 'start' })
      },
    }, ['全部'])
    groupChips.set('', all)
    groupBar.appendChild(all)
    for (const g of data.groups) {
      const chip = h(`button.chip${activeGroup === g.id ? '.accent' : ''}`, {
        type: 'button',
        title: g.description ?? '',
        onclick: () => {
          setActiveGroup(g.id)
          groupEls.get(g.id)?.head.scrollIntoView({ behavior: 'smooth', block: 'start' })
        },
      }, [g.name ?? g.id, h('span.dim', String((g.items ?? []).length))])
      groupChips.set(g.id, chip)
      groupBar.appendChild(chip)
    }
  }

  /** 只切高亮，不重建 DOM（滚动时高频调用，重建会打断滚动） */
  function setActiveGroup(id) {
    if (activeGroup === id) return
    const prev = activeGroup
    activeGroup = id
    groupChips.get(prev)?.classList.remove('accent')
    groupChips.get(id)?.classList.add('accent')
  }

  /* ---------------- 卡片 ---------------- */

  function renderCard(group, item) {
    const key = itemKey(group.id, item)
    const url = String(item.url ?? '')
    const hasUrl = /^https?:\/\//i.test(url)
    const verified = checkResults.get(key)

    const badges = []
    if (verified) {
      const cls = statusClass(verified.status, verified.error)
      const verdict = cls === 'ok' ? 'ok' : cls === 'bad' ? 'dead' : 'warn'
      const text = verified.status ? `${verified.status} ${STATUS_TEXT[verdict]}` : (verified.error ? '连接失败' : '未知')
      const title = [
        verified.checkedAt ? `校验时间：${verified.checkedAt}` : '未记录校验时间',
        verified.note ? `备注：${verified.note}` : '',
        url,
      ].filter(Boolean).join('\n')
      badges.push(h(`span.verified-badge${cls ? '.' + cls : ''}`, { title }, [icon(cls === 'ok' ? 'check' : 'alert', 11), text]))
    }

    const chips = []
    if (item.region) chips.push(h('span.chip.info', item.region))
    if (item.cost) chips.push(h(`span.chip${String(item.cost).includes('免费') || String(item.cost).includes('开源') ? '.ok' : ''}`, item.cost))
    const tags = Array.isArray(item.tags) ? item.tags : []
    for (const t of tags.slice(0, MAX_TAGS)) {
      const tone = tagTone(t)
      chips.push(h(`span.chip${tone ? '.' + tone : ''}`, t))
    }
    if (tags.length > MAX_TAGS) chips.push(h('span.chip', `+${tags.length - MAX_TAGS}`))

    return h('div.link-card', [
      h('div.link-card-head', [
        h('div.link-card-title.truncate', { title: item.name ?? '' }, item.name ?? '未命名'),
        h('div.spacer'),
        item.official === true
          ? h('span.chip.ok', { title: '来自官方 / 原作者渠道' }, [icon('shield', 11), '官方'])
          : h('span.chip', { title: '社区或第三方渠道，自己判断可靠性' }, [icon('globe', 11), '社区/第三方']),
      ]),
      h('div.link-card-host.truncate', { title: hasUrl ? url : '（这条没有链接）' }, hostOf(item) || (hasUrl ? url : '')),
      chips.length ? h('div.chip-group', chips) : null,
      item.desc ? h('div.link-card-desc', item.desc) : null,
      item.tip ? h('div.link-card-tip', [h('span.strong', '提示：'), item.tip]) : null,
      h('div.row.gap-sm', { style: { marginTop: '2px' } }, [
        h('button.btn.btn-sm.btn-primary', {
          title: hasUrl ? '用系统默认浏览器打开' : '这条资源没有可用链接',
          disabled: !hasUrl,
          onclick: async (e) => {
            const btn = e.currentTarget
            btn.classList.add('loading')
            try {
              await api.fsOpen({ url })
            } catch (err) {
              toast(err.message, 'err')
            } finally {
              btn.classList.remove('loading')
            }
          },
        }, [icon('external', 13), '打开']),
        h('button.btn.btn-sm', {
          title: hasUrl ? '复制链接到剪贴板' : '没有可复制的链接',
          disabled: !hasUrl,
          onclick: async (e) => {
            const btn = e.currentTarget
            try {
              const r = await copyText(url)
              if (r.ok) toast('链接已复制', 'ok')
              else showCopyFallback(url, r.reason)
            } catch (err) {
              toast(err.message, 'err')
            } finally {
              btn.blur()
            }
          },
        }, [icon('link', 13), '复制链接']),
        h('div.spacer'),
        ...badges,
      ]),
    ])
  }

  /* ---------------- 分组渲染 ---------------- */

  const groupCache = new Map()

  function groupMatches(group) {
    if (activeGroup && group.id !== activeGroup) return false
    if (!query) return true
    const hay = (group.name ?? '').toLowerCase()
    return hay.includes(query) || (group.items ?? []).some((it) => itemMatches(it))
  }

  function itemMatches(item) {
    if (!query) return true
    const parts = [
      item.name,
      item.desc,
      item.tip,
      item.region,
      item.cost,
      item.home,
      Array.isArray(item.tags) ? item.tags.join(' ') : '',
      hostOf(item),
    ]
    return parts.some((p) => String(p ?? '').toLowerCase().includes(query))
  }

  /**
   * 折叠/展开按钮。
   * 就地切换 class，不整体重渲染：重渲染会重建所有分组、把滚动位置和焦点晃一下。
   */
  function makeFoldButton(groupId, grid, count) {
    const btn = button('', { size: 'btn-sm', variant: 'btn-ghost' })
    const sync = () => {
      const open = !grid.classList.contains('is-collapsed')
      btn.title = open ? '收回到一行' : `展开这一组的全部 ${count} 条`
      mount(btn, icon(open ? 'chevronUp' : 'chevronDown', 13), open ? '收起' : `展开全部 ${count} 条`)
    }
    btn.addEventListener('click', () => {
      if (grid.classList.toggle('is-collapsed')) expandedGroups.delete(groupId)
      else expandedGroups.add(groupId)
      sync()
    })
    sync()
    return btn
  }

  function renderGroups() {
    groupEls.clear()
    mount(groupsBox, null)
    mount(emptyBox, null)

    if (loadErr) {
      mount(emptyBox, h('div.card', [
        alertBox('err', escapeHtml(loadErr), '资源库读取失败'),
        h('div.small.muted', { style: { marginTop: '10px' } }, '如果 app/data/resources.json 还没生成，等它写好后点下面重试即可。'),
        h('div.row.gap-sm', { style: { marginTop: '10px' } }, [
          button('重试', { onClick: () => load(true) }),
        ]),
      ]))
      observeGroups()
      return
    }

    if (!data.groups.length) {
      mount(emptyBox, emptyState({
        iconName: 'library',
        title: '资源库还是空的',
        desc: 'app/data/resources.json 里还没有条目，或文件尚未生成。点“重新载入”再试一次。',
        action: button('重新载入', { onClick: () => load(true) }),
      }))
      observeGroups()
      return
    }

    let shownGroups = 0
    let shownItems = 0

    for (const group of data.groups) {
      if (!groupMatches(group)) continue
      const items = (group.items ?? []).filter((it) => itemMatches(it))
      if (query && !items.length) continue
      // 未搜索且未筛选时缓存「全部」渲染结果，后续过滤直接复用
      let grid
      if (!query && !activeGroup && groupCache.has(group.id)) {
        grid = groupCache.get(group.id)
      } else {
        grid = h('div.res-grid.stagger', items.map((it) => renderCard(group, it)))
        if (!query && !activeGroup) groupCache.set(group.id, grid)
      }
      // 默认收起成一行；搜索时强制展开 —— 否则搜到的条目被折叠藏起来，等于没搜到
      grid.classList.toggle('is-collapsed', !query && !expandedGroups.has(group.id))
      const head = h('div.res-group-head', [
        h('div.res-group-icon', [icon(group.icon || 'library', 16)]),
        h('div', { style: { minWidth: '0' } }, [
          h('h2', group.name ?? group.id),
          group.description ? h('div.sub.truncate', group.description) : null,
        ]),
        h('span.res-count', `${items.length} 条`),
      ])
      const sec = h('section', { dataset: { group: group.id } }, [head, grid])
      groupsBox.appendChild(sec)
      // 一行就装得下的小组就不给按钮了，按了也没变化只会让人困惑。
      // 列数是 auto-fill 按实际宽度算出来的，读 computed style 才能拿到，
      // 顺便逼一次同步布局（每组一次，可忽略）。
      // ponytail: 缩放窗口后按钮要等下次重渲染才跟着变；真嫌不准再加 ResizeObserver。
      const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length
      if (items.length > cols) head.appendChild(makeFoldButton(group.id, grid, items.length))
      groupEls.set(group.id, { head, section: sec })
      shownGroups += 1
      shownItems += items.length
    }

    if (!shownGroups) {
      mount(emptyBox, emptyState({
        iconName: 'search',
        title: '没有匹配的资源',
        desc: query ? `没有名称 / 描述 / 标签里含“${query}”的条目。换个词，或清空搜索框。` : '当前分组下没有条目。',
        action: button('清空搜索', {
          onClick: () => {
            searchInput.value = ''
            query = ''
            setActiveGroup('')
            renderGroups()
          },
        }),
      }))
      return
    }

    if (query || activeGroup) {
      groupsBox.prepend(h('div.small.dim', { style: { padding: '2px 2px 0' } },
        `筛选出 ${shownItems} 条 / ${shownGroups} 个分组`))
    }
    observeGroups()
  }

  /* ---------------- 链接校验 ---------------- */

  const verifyState = { bar: null, msg: null, log: null }

  function renderVerifyShell(title) {
    verifyState.bar = progressBar(0, { size: 'lg' })
    verifyState.msg = h('div.small.muted', '准备中…')
    verifyState.log = h('div.log', { style: { maxHeight: '150px' } })
    mount(verifyBox, h('div.card', [
      h('div.card-head', [
        h('div.card-icon.pink', [icon('shield', 16)]),
        h('h2', title),
        h('div.spacer'),
        button('收起', {
          size: 'btn-sm',
          variant: 'btn-ghost',
          iconName: 'x',
          onClick: () => mount(verifyBox, null),
        }),
      ]),
      h('div.col', [verifyState.bar, verifyState.msg, verifyState.log]),
    ]))
  }

  async function checkAll() {
    if (!data.groups.length) {
      toast('资源库为空，没什么可校验的', 'warn')
      return
    }
    const total = data.groups.reduce((n, g) => n + (g.items ?? []).length, 0)
    if (!total) {
      toast('资源库为空，没什么可校验的', 'warn')
      return
    }

    checkBtn.classList.add('loading')
    renderVerifyShell(`正在校验 ${total} 条链接`)
    verifyState.bar.setBar(2, '')
    verifyState.msg.textContent = '正在请求服务端…'
    mount(verifyState.log, h('div', '每个站点都会 HEAD 一次，403 多为反爬拦截，不代表站点失效。'))

    try {
      const { jobId } = await api.checkLinks([])
      const done = await new Promise((resolve, reject) => {
        linksJob = watchJob(jobId, {
          onUpdate: (job) => {
            verifyState.bar.setBar(job.percent ?? 0, '')
            verifyState.msg.textContent = job.message ?? '校验中…'
            if (job.logs?.length) {
              mount(verifyState.log, job.logs.join('\n'))
              verifyState.log.scrollTop = verifyState.log.scrollHeight
            }
          },
          onDone: (job) => resolve(job.result ?? {}),
          onError: (err) => reject(err),
          onCancel: () => resolve(null),
        })
      })
      linksJob = null
      if (!done) {
        verifyState.bar.setBar(0, 'canceled')
        verifyState.msg.textContent = '校验已取消'
        return
      }

      let ok = 0
      let bad = 0
      for (const r of done.results ?? []) {
        const norm = normalizeResult(r)
        checkResults.set(`${r.group}/${r.id ?? r.name ?? ''}`, norm)
        if (statusClass(norm.status, norm.error) === 'ok') ok += 1
        else bad += 1
      }
      groupCache.clear()
      renderGroups()
      verifyState.bar.setBar(100, 'done')
      verifyState.msg.textContent = `完成：${ok} 条可达 / ${bad} 条失效或存疑。`
      toast(`${ok} 条正常，${bad} 条异常（徽章已更新）`, bad ? 'warn' : 'ok')
    } catch (err) {
      linksJob = null
      verifyState.bar?.setBar(0, 'error')
      if (verifyState.msg) verifyState.msg.textContent = `校验失败：${err.message}`
      toast(err.message, 'err')
    } finally {
      checkBtn.classList.remove('loading')
    }
  }

  /* ---------------- 滚动高亮当前分组 ---------------- */

  let observer = null
  if (typeof IntersectionObserver === 'function') {
    observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue
          const id = e.target.dataset.group
          if (id) setActiveGroup(id)
        }
      },
      { rootMargin: '-15% 0px -70% 0px', threshold: 0 }
    )
  }

  function observeGroups() {
    if (!observer) return
    observer.disconnect()
    for (const el of groupsBox.querySelectorAll('section[data-group]')) observer.observe(el)
  }

  /* ---------------- 首屏 ---------------- */

  renderNotice()
  renderHeader()
  await load(false)

  return () => {
    observer?.disconnect()
    linksJob?.()
    mount(headerActions, null)
  }
}

/* ------------------------------------------------------------------ 其它 */

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

export default { render }
