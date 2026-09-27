/**
 * 目录 / 文件选择器
 * 服务端浏览式（不依赖浏览器 File System Access API），任何浏览器都可用。
 */

import { api } from '../api.js'
import { h, mount, icon, modal, toast, button, formatBytes } from '../ui.js'

/** 路径最后一段 */
const baseName = (p) => String(p).split(/[\\/]/).filter(Boolean).pop() ?? ''
/** 去掉最后一段（文件路径 → 所在目录） */
const dirName = (p) => String(p).replace(/[\\/][^\\/]*$/, '')

/**
 * 打开选择对话框
 * @param {{
 *   mode?: 'dir'|'file', title?: string, initial?: string, exts?: string[],
 *   onPick: (path: string, entry?: {name:string,path:string,size:number,ext:string}) => void
 * }} opts
 *   mode='dir'（默认）只列文件夹；mode='file' 列文件夹 + 文件，可点选文件
 *   exts 只在 mode='file' 下生效，不带点、大小写不敏感
 *   onClose 对话框关掉时调用，参数是「选中的路径」；用户没选就取消时是 undefined
 *           （调用方要区分「选完了」和「放弃了」时用得上，比如导出保存）
 */
export async function pickDirectory(opts = {}) {
  const mode = opts.mode === 'file' ? 'file' : 'dir'
  const exts = (opts.exts ?? []).map((e) => String(e).toLowerCase().replace(/^\./, '')).filter(Boolean)
  const isFileMode = mode === 'file'
  let showAll = false
  let currentPath = opts.initial || ''
  let listEl
  let pathEl
  let rootsBox
  let selected = currentPath
  let pickedFile = null // file 模式下真正选中的文件

  const body = h('div.dir-browser')
  const pathRow = h('div.dir-path')
  pathEl = h('span.truncate.full', { text: '正在读取…' })
  const upBtn = button('上级', { size: 'btn-sm', iconName: 'chevronUp' })
  const newBtn = button('新建文件夹', { size: 'btn-sm', iconName: 'plus' })
  const homeBtn = button('常用位置', { size: 'btn-sm', iconName: 'star' })
  // 选文件时没有「新建文件夹」这回事
  if (isFileMode) pathRow.append(pathEl, h('div.spacer'), upBtn, homeBtn)
  else pathRow.append(pathEl, h('div.spacer'), upBtn, newBtn, homeBtn)

  rootsBox = h('div.dir-list', { style: { maxHeight: '130px' } })
  listEl = h('div.dir-list')

  const pathInput = h('input.input.mono', {
    value: currentPath,
    placeholder: isFileMode ? '也可以把完整文件路径粘贴到这里，回车' : '也可以直接把路径粘贴到这里',
    oninput: (e) => { selected = e.target.value },
    onkeydown: (e) => { if (e.key === 'Enter') load(e.target.value) },
  })

  const filterBtn = exts.length
    ? button('显示全部文件', {
        size: 'btn-sm',
        variant: 'btn-ghost',
        title: `当前只看：${exts.join(' / ')}`,
        onClick: () => {
          showAll = !showAll
          filterBtn.textContent = showAll ? `只看 ${exts.length} 种支持的格式` : '显示全部文件'
          load(currentPath)
        },
      })
    : null

  body.append(
    h('div.field', [
      h('label.field-label', '当前路径'),
      h('div.input-group', [pathInput]),
    ]),
    h('div.field', [h('label.field-label', '常用位置'), rootsBox]),
    h('div.field', [
      h('div.row', [
        h('label.field-label', isFileMode ? '文件夹与文件' : '子文件夹'),
        h('div.spacer'),
        filterBtn,
      ]),
      pathRow,
      listEl,
    ]),
  )

  const confirmBtn = button(isFileMode ? '选择此文件' : '选择此目录', {
    variant: 'btn-primary',
    disabled: isFileMode,
    title: isFileMode ? '先在下面的列表里点一个文件' : '',
    onClick: () => confirm(),
  })

  let pickedDir = null

  const { close } = modal({
    title: opts.title ?? (isFileMode ? '选择文件' : '选择目录'),
    wide: true,
    body,
    footer: [button('取消', { onClick: () => close() }), confirmBtn],
    onClose: () => opts.onClose?.(pickedDir),
  })

  function confirm() {
    if (isFileMode) {
      if (!pickedFile) {
        toast('请选择一个文件', 'warn')
        return
      }
      pickedDir = pickedFile.path
      close()
      opts.onPick?.(pickedFile.path, pickedFile)
      return
    }
    if (!selected) {
      toast('请先选择目录', 'warn')
      return
    }
    pickedDir = selected
    close()
    opts.onPick?.(selected)
  }

  function setPicked(entry) {
    pickedFile = entry
    confirmBtn.disabled = isFileMode && !entry
  }

  /** 高亮选中的那一行（和「正在浏览的目录」区分开：目录只在顶部路径栏显示） */
  function markSelected(row) {
    for (const el of listEl.querySelectorAll('.dir-entry.selected')) el.classList.remove('selected')
    row?.classList.add('selected')
  }

  function showPath(p) {
    selected = p
    pathEl.textContent = p
    pathInput.value = p
  }

  /** file 模式下判断一个粘贴进来的路径是不是文件 */
  function looksLikeFile(p) {
    if (!isFileMode) return false
    const m = /\.([a-z0-9_]+)$/i.exec(String(p).trim())
    if (!m) return false
    const ext = m[1].toLowerCase()
    return exts.length ? exts.includes(ext) : true
  }

  async function load(target) {
    let pastedFile = null
    if (looksLikeFile(target)) {
      pastedFile = String(target).trim()
      target = dirName(pastedFile)
    }
    mount(listEl, h('div.dir-entry', [icon('refresh', 14), '读取中…']))
    let data = null
    try {
      data = await api.fsList(target, { exts: showAll ? [] : exts, files: isFileMode })
      currentPath = data.path
      showPath(data.path)
      mount(listEl, null)
      setPicked(null)
      const files = isFileMode ? (data.files ?? []) : []
      if (!data.dirs.length && !files.length) {
        const msg = isFileMode
          ? '（这个目录里没有符合条件的文件 —— 进子文件夹找找，或点上面「显示全部文件」）'
          : '（没有内容）'
        listEl.appendChild(h('div.dir-entry', { style: { cursor: 'default', color: 'var(--text-3)' } }, [msg]))
      }
      for (const dir of data.dirs) {
        listEl.appendChild(
          h('button.dir-entry', {
            ondblclick: () => load(dir.path),
            onclick: (e) => {
              markSelected(e.currentTarget)
              showPath(dir.path)
            },
          }, [icon('folder', 14), h('span.truncate', dir.name)])
        )
      }
      for (const f of files) {
        const row = h('button.dir-entry.file', {
          title: f.path,
          ondblclick: () => { setPicked(f); confirm() },
          onclick: () => {
            markSelected(row)
            setPicked(f)
            showPath(f.path)
          },
        }, [icon('file', 14), h('span.truncate', f.name), h('span.size', formatBytes(f.size))])
        row.dataset.path = f.path
        listEl.appendChild(row)
      }
      if (pastedFile) {
        const f = files.find((x) => x.path === pastedFile)
        setPicked(f ?? { name: baseName(pastedFile), path: pastedFile, size: 0, ext: '' })
        markSelected([...listEl.querySelectorAll('.dir-entry.file')].find((el) => el.dataset.path === pastedFile))
      }
      upBtn.onclick = () => {
        if (data.parent && data.parent !== currentPath) load(data.parent)
      }
      if (data.exists === false) toast('该目录还不存在，转换时会自动创建', 'info')
    } catch (err) {
      mount(listEl, h('div.dir-entry', { style: { cursor: 'default', color: 'var(--err)' } }, [icon('alert', 14), err.message]))
      // 目标读不了（不存在 / 不是目录 / 没权限）时退回上一个能用的位置或第一个盘符 ——
      // 不然用户就卡在一个空的/报错的列表里，看着像「选择器坏了」。
      try {
        const roots = await api.fsRoots()
        const first = roots.roots?.find((r) => r.type === 'drive') ?? roots.roots?.[0]
        const up = data?.parent && data.parent !== data.path ? data.parent : ''
        const fallback = up || first?.path || ''
        // 退到的位置和原地一样就不再重试，避免来回打转
        if (fallback && fallback !== target) return load(fallback)
      } catch { /* 连常用位置都读不到，就留着错误信息 */ }
    }
  }

  newBtn.onclick = async () => {
    const name = prompt('新文件夹名称')
    if (!name) return
    const target = `${currentPath}\\${name}`.replace(/\\\\/g, '\\')
    try {
      await api.fsMkdir(target)
      toast('已创建', 'ok')
      load(target)
    } catch (err) {
      toast(`创建失败：${err.message}`, 'err')
    }
  }

  homeBtn.onclick = async () => {
    try {
      const data = await api.fsRoots()
      mount(rootsBox, null)
      for (const root of data.roots) {
        rootsBox.appendChild(
          h('button.dir-entry', { class: `dir-entry ${root.type === 'drive' ? 'drive' : 'quick'}`, onclick: () => load(root.path) }, [
            icon(root.type === 'drive' ? 'disc' : 'star', 14),
            h('span', root.name),
            h('span.truncate.dim.small', { style: { marginLeft: 'auto' } }, root.path),
          ])
        )
      }
    } catch (err) {
      toast(`读取常用位置失败：${err.message}`, 'err')
    }
  }

  // 初始加载：粘贴/带入的可能是文件路径，交给 load() 拆
  homeBtn.click()
  const start = opts.initial || ''
  if (start) load(start)
  else {
    try {
      const data = await api.fsRoots()
      const first = data.roots.find((r) => r.type === 'drive')
      if (first) load(first.path)
    } catch {
      /* ignore */
    }
  }
}

/**
 * 内联的目录输入框（带选择按钮）
 * @returns {{el:HTMLElement, getValue:()=>string, setValue:(v:string)=>void}}
 */
export function directoryInput({ value = '', placeholder = '选择输出目录…', title = '选择目录' } = {}) {
  const input = h('input.input.mono', { value, placeholder })
  const btn = button('浏览', {
    iconName: 'folder',
    onClick: () => pickDirectory({
      title,
      initial: input.value,
      onPick: (p) => {
        input.value = p
        // 触发外面的 change 监听，让选择当场存进设置（换页 / 重渲染之后还在）
        input.dispatchEvent(new Event('change', { bubbles: true }))
      },
    }),
  })
  const openBtn = button('打开', {
    variant: 'btn-ghost',
    iconName: 'external',
    title: '在资源管理器中打开',
    onClick: async () => {
      try {
        await api.fsReveal(input.value, false)
      } catch (err) {
        toast(err.message, 'err')
      }
    },
  })
  const el = h('div.input-group', [input, btn, openBtn])
  return { el, getValue: () => input.value.trim(), setValue: (v) => { input.value = v } }
}

/**
 * 输出目录的来源提示：默认值（配置里那个）还是用户自己改过的
 * @param {{custom:boolean, fallback:string, onReset:()=>void}} opts
 */
export function outputDirHint({ custom, fallback, onReset }) {
  if (custom) {
    return h('div.field-hint', [
      '已自定义，不再跟着默认走。',
      button('恢复默认', { size: 'btn-sm', variant: 'btn-ghost', iconName: 'refresh', onClick: onReset }),
    ])
  }
  return h('div.field-hint', `默认写到：${fallback || '（还没设默认目录，去「设置」页填一个）'}`)
}

export default { pickDirectory, directoryInput, outputDirHint }
