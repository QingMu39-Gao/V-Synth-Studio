/**
 * 极简 XML 解析/构建器（零依赖）
 * 用于 VSQX / VSQ / MusicXML 等 XML 系工程格式。
 *
 * 设计取向：
 *  - 保留元素原始标签名（含命名空间前缀），不做命名空间解析
 *  - 保留属性顺序（数组形式），便于写出时保持与原文件一致的观感
 *  - 文本节点按原样返回（不 trim），由调用方决定是否 trim
 *  - 面向大文件：单遍字符扫描，O(n)
 */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' }

export function decodeEntities(str) {
  if (!str.includes('&')) return str
  return str.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (m, body) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10)
      return Number.isFinite(code) ? String.fromCodePoint(code) : m
    }
    return ENTITIES[body] ?? m
  })
}

export function encodeEntities(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]))
}

/**
 * 解析 XML 文本
 * @returns {{name:string, attrs:Record<string,string>, children:Array, text:string, parent:object|null}}
 */
export function parseXml(input) {
  const text = stripBom(String(input))
  let i = 0
  const n = text.length
  const root = { name: '#document', attrs: {}, children: [], text: '', parent: null }
  const stack = [root]

  while (i < n) {
    const lt = text.indexOf('<', i)
    if (lt < 0) {
      appendText(stack[stack.length - 1], text.slice(i))
      break
    }
    if (lt > i) appendText(stack[stack.length - 1], text.slice(i, lt))

    // 注释
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4)
      i = end < 0 ? n : end + 3
      continue
    }
    // CDATA
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9)
      const cdata = text.slice(lt + 9, end < 0 ? n : end)
      appendText(stack[stack.length - 1], cdata)
      i = end < 0 ? n : end + 3
      continue
    }
    // DOCTYPE / 处理指令
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2)
      i = end < 0 ? n : end + 2
      continue
    }
    if (text.startsWith('<!', lt)) {
      const end = text.indexOf('>', lt + 2)
      i = end < 0 ? n : end + 1
      continue
    }
    // 闭合标签
    if (text[lt + 1] === '/') {
      const end = text.indexOf('>', lt)
      if (end < 0) break
      const name = text.slice(lt + 2, end).trim()
      // 容错：找到匹配的祖先并弹栈
      for (let s = stack.length - 1; s > 0; s -= 1) {
        if (stack[s].name === name) {
          stack.length = s
          break
        }
      }
      i = end + 1
      continue
    }
    // 开始标签
    const tagEnd = findTagEnd(text, lt + 1)
    const raw = text.slice(lt + 1, tagEnd)
    const selfClosing = raw.trimEnd().endsWith('/')
    const body = selfClosing ? raw.trimEnd().slice(0, -1) : raw
    const { name, attrs } = parseStartTag(body)
    const node = { name, attrs, children: [], text: '', parent: stack[stack.length - 1] }
    stack[stack.length - 1].children.push(node)
    if (!selfClosing) stack.push(node)
    i = tagEnd + 1
  }
  return root
}

function findTagEnd(text, from) {
  let quote = null
  for (let i = from; i < text.length; i += 1) {
    const c = text[i]
    if (quote) {
      if (c === quote) quote = null
    } else if (c === '"' || c === "'") quote = c
    else if (c === '>') return i
  }
  return text.length
}

function parseStartTag(body) {
  const trimmed = body.trim()
  const sp = trimmed.search(/[\s/]/)
  const name = sp < 0 ? trimmed : trimmed.slice(0, sp)
  const attrs = {}
  if (sp < 0) return { name, attrs }
  const attrRe = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+))/g
  let m
  const rest = trimmed.slice(sp)
  while ((m = attrRe.exec(rest))) {
    attrs[m[1]] = decodeEntities(m[3] ?? m[4] ?? m[5] ?? '')
  }
  return { name, attrs }
}

function appendText(node, chunk) {
  if (!chunk) return
  node.text += decodeEntities(chunk)
}

function stripBom(s) {
  return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
}

/* --------------------------------------------------------------- 查询辅助 */

export function find(node, name) {
  if (!node?.children) return null
  for (const c of node.children) if (c.name === name) return c
  return null
}

export function findAll(node, name) {
  if (!node?.children) return []
  return node.children.filter((c) => c.name === name)
}

/** 支持 'a/b/c' 路径查找 */
export function findPath(node, path) {
  let cur = node
  for (const part of String(path).split('/')) {
    if (!part) continue
    cur = find(cur, part)
    if (!cur) return null
  }
  return cur
}

export function textOf(node, fallback = '') {
  if (!node) return fallback
  return node.text ?? fallback
}

export function numOf(node, fallback = 0) {
  const t = textOf(node, '').trim()
  if (!t) return fallback
  const v = Number(t)
  return Number.isFinite(v) ? v : fallback
}

export function attrOf(node, name, fallback = null) {
  const v = node?.attrs?.[name]
  return v === undefined ? fallback : v
}

export function numAttr(node, name, fallback = 0) {
  const v = attrOf(node, name, null)
  if (v === null || v === '') return fallback
  const num = Number(v)
  return Number.isFinite(num) ? num : fallback
}

/** 直接子元素文本，语义糖 */
export function childText(node, name, fallback = '') {
  return textOf(find(node, name), fallback)
}

export function childNum(node, name, fallback = 0) {
  return numOf(find(node, name), fallback)
}

/** 便捷构造元素 */
export function el(name, attrs = null, children = null, text = null) {
  const node = { name, attrs: attrs ?? {}, children: [], text: text ?? '', parent: null }
  if (children) for (const c of children) push(node, c)
  return node
}

export function push(parent, child) {
  child.parent = parent
  parent.children.push(child)
  return child
}

/* ------------------------------------------------------------------ 构建 */

const DEFAULT_OPTS = { indent: '  ', declaration: true, escapeText: true }

export function buildXml(node, opts = {}) {
  const o = { ...DEFAULT_OPTS, ...opts }
  const parts = []
  if (o.declaration) parts.push('<?xml version="1.0" encoding="UTF-8"?>')
  writeNode(node, parts, 0, o)
  return parts.join('\n')
}

function writeNode(node, parts, depth, o) {
  const pad = o.indent.repeat(depth)
  const attrStr = Object.entries(node.attrs ?? {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => ` ${k}="${encodeEntities(v)}"`)
    .join('')
  const children = node.children ?? []
  const text = node.text ?? ''
  const hasText = text.length > 0

  if (!children.length && !hasText) {
    parts.push(`${pad}<${node.name}${attrStr}/>`)
    return
  }
  if (!children.length && hasText) {
    // 单行文本
    if (text.includes('\n') || text.length > 120) {
      parts.push(`${pad}<${node.name}${attrStr}>${o.escapeText ? encodeEntities(text) : text}</${node.name}>`)
    } else {
      parts.push(`${pad}<${node.name}${attrStr}>${o.escapeText ? encodeEntities(text) : text}</${node.name}>`)
    }
    return
  }
  // 有子元素：文本与子元素混排时，文本前置
  parts.push(`${pad}<${node.name}${attrStr}>`)
  if (hasText) parts.push(`${o.indent.repeat(depth + 1)}${o.escapeText ? encodeEntities(text) : text}`)
  for (const c of children) writeNode(c, parts, depth + 1, o)
  parts.push(`${pad}</${node.name}>`)
}

/** 生成不带缩进的紧凑 XML（体积敏感时使用） */
export function buildXmlCompact(node) {
  const parts = ['<?xml version="1.0" encoding="UTF-8"?>']
  compactNode(node, parts)
  return parts.join('')
}

function compactNode(node, parts) {
  const attrStr = Object.entries(node.attrs ?? {})
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => ` ${k}="${encodeEntities(v)}"`)
    .join('')
  const children = node.children ?? []
  const text = node.text ?? ''
  if (!children.length && !text) {
    parts.push(`<${node.name}${attrStr}/>`)
    return
  }
  parts.push(`<${node.name}${attrStr}>`)
  if (text) parts.push(encodeEntities(text))
  for (const c of children) compactNode(c, parts)
  parts.push(`</${node.name}>`)
}

export default { parseXml, buildXml, buildXmlCompact, find, findAll, findPath, el, push, attrOf, numAttr, childText, childNum }
