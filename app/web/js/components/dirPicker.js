/**
 * 目录选择器
 * 服务端浏览式（不依赖浏览器 File System Access API），任何浏览器都可用。
 */

import { api } from '../api.js'
import { h, mount, icon, modal, toast, button } from '../ui.js'

/**
 * 打开目录选择对话框
 * @param {{title?:string, initial?:string, onPick:(path:string)=>void}} opts
 */
export async function pickDirectory(opts = {}) {
  let currentPath = opts.initial || ''
  let listEl
  let pathEl
  let rootsBox
  let selected = currentPath

  const body = h('div.dir-browser')
  const pathRow = h('div.dir-path')
  pathEl = h('span.truncate.full', { text: '正在读取…' })
  const upBtn = button('上级', { size: 'btn-sm', iconName: 'chevronUp' })
  const newBtn = button('新建文件夹', { size: 'btn-sm', iconName: 'plus' })
  const homeBtn = button('常用位置', { size: 'btn-sm', iconName: 'star' })
  pathRow.append(pathEl, h('div.spacer'), upBtn, newBtn, homeBtn)

  rootsBox = h('div.dir-list', { style: { maxHeight: '130px' } })
  listEl = h('div.dir-list')

  body.append(
    h('div.field', [
      h('label.field-label', '当前路径'),
      h('div.input-group', [h('input.input.mono', {
        value: currentPath,
        placeholder: '也可以直接把路径粘贴到这里',
        oninput: (e) => { selected = e.target.value },
        onkeydown: (e) => { if (e.key === 'Enter') load(e.target.value) },
      })]),
    ]),
    h('div.field', [h('label.field-label', '常用位置'), rootsBox]),
    h('div.field', [h('label.field-label', '子文件夹'), pathRow, listEl]),
  )

  const { close } = modal({
    title: opts.title ?? '选择目录',
    wide: true,
    body,
    footer: [
      button('取消', { onClick: () => close() }),
      button('选择此目录', {
        variant: 'btn-primary',
        onClick: () => {
          if (!selected) {
            toast('请先选择目录', 'warn')
            return
          }
          close()
          opts.onPick?.(selected)
        },
      }),
    ],
  })

  async function load(target) {
    mount(listEl, h('div.dir-entry', [icon('refresh', 14), '读取中…']))
    try {
      const data = await api.fsList(target)
      currentPath = data.path
      selected = data.path
      pathEl.textContent = data.path
      const input = body.querySelector('input.input')
      if (input) input.value = data.path
      mount(listEl, null)
      if (!data.dirs.length) {
        listEl.appendChild(h('div.dir-entry', { style: { cursor: 'default', color: 'var(--text-3)' } }, ['（没有子文件夹）']))
      }
      for (const dir of data.dirs) {
        listEl.appendChild(
          h('button.dir-entry', {
            ondblclick: () => load(dir.path),
            onclick: () => {
              selected = dir.path
              pathEl.textContent = dir.path
              const input = body.querySelector('input.input')
              if (input) input.value = dir.path
            },
          }, [icon('folder', 14), h('span.truncate', dir.name)])
        )
      }
      upBtn.onclick = () => {
        if (data.parent && data.parent !== currentPath) load(data.parent)
      }
      if (data.exists === false) toast('该目录还不存在，转换时会自动创建', 'info')
    } catch (err) {
      mount(listEl, h('div.dir-entry', { style: { cursor: 'default', color: 'var(--err)' } }, [icon('alert', 14), err.message]))
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

  // 初始加载
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
    onClick: () => pickDirectory({ title, initial: input.value, onPick: (p) => { input.value = p } }),
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

export default { pickDirectory, directoryInput }
