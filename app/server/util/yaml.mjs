/**
 * YAML 子集解析/生成器（零依赖）
 *
 * 目标格式：OpenUtau `.ustx`（YamlDotNet 风格：块序列与父键同缩进）。
 * 支持：块映射、块序列、流映射 `{a: 1}`、流序列 `[a, b]`、引号标量与转义、
 *       块标量 `|` `>`、注释、文档起始 `---`、数字/布尔/null 推断。
 * 不支持（按需扩展）：锚点别名、标签、复杂键、多文档合并。
 */

/* ------------------------------------------------------------------ 解析 */

export function parseYaml(text) {
  const ctx = { lines: preprocess(text), i: 0, warnings: [] }
  if (!ctx.lines.length) return null
  const value = parseBlock(ctx, ctx.lines[0].indent)
  return value
}

/** 解析并返回警告（格式不规范时给出可用信息，而不是直接抛错） */
export function parseYamlWithWarnings(text) {
  const ctx = { lines: preprocess(text), i: 0, warnings: [] }
  const value = ctx.lines.length ? parseBlock(ctx, ctx.lines[0].indent) : null
  return { value, warnings: ctx.warnings }
}

function preprocess(text) {
  const raw = String(text).replace(/^\uFEFF/, '').split(/\r\n|\r|\n/)
  const out = []
  for (let idx = 0; idx < raw.length; idx += 1) {
    const line = raw[idx]
    if (/^\s*$/.test(line)) continue
    if (/^\s*#/.test(line)) continue
    if (/^\s*---\s*(#.*)?$/.test(line)) continue
    if (/^\s*\.\.\.\s*$/.test(line)) break
    const indent = (line.match(/^[ \t]*/) || [''])[0].replace(/\t/g, '  ').length
    out.push({ indent, content: line.trim().replace(/^\t+/, ''), no: idx + 1 })
  }
  return out
}

function parseBlock(ctx, indent) {
  const line = ctx.lines[ctx.i]
  if (!line || line.indent < indent) return null
  if (isSeqLine(line.content)) return parseSeq(ctx, line.indent)
  return parseMap(ctx, line.indent)
}

function isSeqLine(content) {
  return content === '-' || content.startsWith('- ')
}

function parseMap(ctx, indent) {
  const obj = {}
  while (ctx.i < ctx.lines.length) {
    const line = ctx.lines[ctx.i]
    if (line.indent < indent) break
    if (isSeqLine(line.content)) break
    if (line.indent > indent) {
      ctx.warnings.push(`第 ${line.no} 行缩进异常（期望 ${indent}，实际 ${line.indent}），已跳过`)
      ctx.i += 1
      continue
    }
    const { key, value } = splitKey(line.content)
    if (key === null) {
      ctx.warnings.push(`第 ${line.no} 行不是合法的 key: value，已跳过：${line.content.slice(0, 40)}`)
      ctx.i += 1
      continue
    }
    ctx.i += 1
    obj[key] = parseValue(value, ctx, indent, line)
  }
  return obj
}

function parseSeq(ctx, indent) {
  const arr = []
  while (ctx.i < ctx.lines.length) {
    const line = ctx.lines[ctx.i]
    if (line.indent !== indent || !isSeqLine(line.content)) break
    const rest = line.content === '-' ? '' : line.content.slice(2).trim()
    ctx.i += 1

    if (rest === '') {
      const next = ctx.lines[ctx.i]
      if (next && next.indent > indent) arr.push(parseBlock(ctx, next.indent))
      else if (next && next.indent === indent && isSeqLine(next.content)) arr.push(parseSeq(ctx, indent))
      else arr.push(null)
      continue
    }

    if (isKeyValue(rest)) {
      // 序列项是内联映射：首个键在本行，后续键在更深缩进
      const itemIndent = indent + 2
      const map = {}
      const { key, value } = splitKey(rest)
      map[key] = parseValue(value, ctx, itemIndent, line)
      while (ctx.i < ctx.lines.length) {
        const l2 = ctx.lines[ctx.i]
        if (l2.indent < itemIndent || isSeqLine(l2.content)) break
        if (l2.indent > itemIndent) {
          ctx.warnings.push(`第 ${l2.no} 行缩进异常（序列项内期望 ${itemIndent}，实际 ${l2.indent}），已跳过`)
          ctx.i += 1
          continue
        }
        const kv = splitKey(l2.content)
        if (kv.key === null) break
        ctx.i += 1
        map[kv.key] = parseValue(kv.value, ctx, itemIndent, l2)
      }
      arr.push(map)
      continue
    }

    arr.push(parseScalarOrFlow(rest, ctx, indent, line))
  }
  return arr
}

function parseValue(rest, ctx, parentIndent, line) {
  const value = stripComment(rest).trim()

  if (value === '') {
    const next = ctx.lines[ctx.i]
    if (!next) return null
    if (next.indent > parentIndent) return parseBlock(ctx, next.indent)
    // YamlDotNet 风格：块序列可以与父键同缩进
    if (next.indent === parentIndent && isSeqLine(next.content)) return parseSeq(ctx, parentIndent)
    return null
  }

  // 块标量
  if (/^[|>][+-]?\d*$/.test(value)) return parseBlockScalar(ctx, parentIndent, value)

  return parseScalarOrFlow(value, ctx, parentIndent, line)
}

function parseScalarOrFlow(value, ctx, parentIndent, line) {
  if (value.startsWith('[') || value.startsWith('{')) {
    const flow = new FlowParser(value)
    const parsed = flow.parse()
    if (flow.rest().trim() !== '') {
      ctx.warnings.push(`第 ${line.no} 行流式语法有多余内容：${flow.rest().trim().slice(0, 30)}`)
    }
    return parsed
  }
  return parseScalar(value)
}

function parseBlockScalar(ctx, parentIndent, marker) {
  const folded = marker.startsWith('>')
  const chomp = marker.includes('-') ? 'strip' : marker.includes('+') ? 'keep' : 'clip'
  const collected = []
  let blockIndent = -1
  while (ctx.i < ctx.lines.length) {
    const line = ctx.lines[ctx.i]
    if (line.indent <= parentIndent) break
    if (blockIndent < 0) blockIndent = line.indent
    collected.push(' '.repeat(Math.max(0, line.indent - blockIndent)) + line.content)
    ctx.i += 1
  }
  let text = folded ? collected.join(' ') : collected.join('\n')
  if (chomp === 'clip' && collected.length) text += '\n'
  return text
}

/** 拆分 `key: value`；返回 {key:null} 表示不是键值行 */
function splitKey(content) {
  let quote = null
  let depth = 0
  for (let i = 0; i < content.length; i += 1) {
    const c = content[i]
    if (quote) {
      if (c === '\\' && quote === '"') i += 1
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (c === '[' || c === '{') depth += 1
    else if (c === ']' || c === '}') depth -= 1
    else if (c === ':' && depth === 0) {
      const next = content[i + 1]
      if (next === undefined || next === ' ' || next === '\t') {
        let key = content.slice(0, i).trim()
        if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
          key = parseScalar(key)
        }
        return { key, value: content.slice(i + 1) }
      }
    }
  }
  return { key: null, value: '' }
}

function isKeyValue(content) {
  return splitKey(content).key !== null
}

/** 去掉行尾注释（不在引号内、且 # 前有空白） */
function stripComment(s) {
  let quote = null
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]
    if (quote) {
      if (c === '\\' && quote === '"') i += 1
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      continue
    }
    if (c === '#' && (i === 0 || /\s/.test(s[i - 1]))) return s.slice(0, i)
  }
  return s
}

export function parseScalar(raw) {
  const s = String(raw).trim()
  if (s === '') return null
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') return unescapeDouble(s.slice(1, -1))
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") return s.slice(1, -1).replace(/''/g, "'")
  if (s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null
  if (s === 'true' || s === 'True' || s === 'TRUE') return true
  if (s === 'false' || s === 'False' || s === 'FALSE') return false
  if (/^[-+]?\d+$/.test(s)) {
    const n = Number(s)
    if (Number.isSafeInteger(n)) return n
    return s
  }
  if (/^[-+]?(\d+\.\d*|\.\d+|\d+)([eE][-+]?\d+)?$/.test(s)) {
    const n = Number(s)
    if (Number.isFinite(n)) return n
  }
  if (s === '.inf' || s === '.Inf') return Infinity
  if (s === '-.inf') return -Infinity
  if (s === '.nan') return NaN
  return s
}

function unescapeDouble(s) {
  return s.replace(/\\(x[0-9a-fA-F]{2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (m, body) => {
    switch (body[0]) {
      case 'n': return '\n'
      case 't': return '\t'
      case 'r': return '\r'
      case '0': return '\0'
      case 'b': return '\b'
      case 'f': return '\f'
      case '"': return '"'
      case '/': return '/'
      case '\\': return '\\'
      case 'x': return String.fromCharCode(parseInt(body.slice(1), 16))
      case 'u': return String.fromCharCode(parseInt(body.slice(1), 16))
      case 'U': return String.fromCodePoint(parseInt(body.slice(1), 16))
      default: return body
    }
  })
}

/** 流式集合解析器 */
class FlowParser {
  constructor(text) {
    this.s = text
    this.i = 0
  }

  rest() {
    return this.s.slice(this.i)
  }

  ws() {
    while (this.i < this.s.length && /\s/.test(this.s[this.i])) this.i += 1
  }

  parse() {
    this.ws()
    const c = this.s[this.i]
    if (c === '[') return this.parseSeq()
    if (c === '{') return this.parseMap()
    return this.parseScalarToken()
  }

  parseSeq() {
    this.i += 1
    const out = []
    for (;;) {
      this.ws()
      if (this.i >= this.s.length) break
      if (this.s[this.i] === ']') {
        this.i += 1
        break
      }
      out.push(this.parse())
      this.ws()
      if (this.s[this.i] === ',') {
        this.i += 1
        continue
      }
      if (this.s[this.i] === ']') {
        this.i += 1
        break
      }
      break
    }
    return out
  }

  parseMap() {
    this.i += 1
    const out = {}
    for (;;) {
      this.ws()
      if (this.i >= this.s.length) break
      if (this.s[this.i] === '}') {
        this.i += 1
        break
      }
      const key = this.parseKeyToken()
      this.ws()
      let value = null
      if (this.s[this.i] === ':') {
        this.i += 1
        this.ws()
        if (this.s[this.i] === ',' || this.s[this.i] === '}') value = null
        else value = this.parse()
      }
      out[key] = value
      this.ws()
      if (this.s[this.i] === ',') {
        this.i += 1
        continue
      }
      if (this.s[this.i] === '}') {
        this.i += 1
        break
      }
      break
    }
    return out
  }

  parseKeyToken() {
    this.ws()
    const c = this.s[this.i]
    if (c === '"' || c === "'") return String(this.parseQuoted())
    let start = this.i
    while (this.i < this.s.length && !/[:,}\]]/.test(this.s[this.i])) this.i += 1
    return this.s.slice(start, this.i).trim()
  }

  parseQuoted() {
    const quote = this.s[this.i]
    this.i += 1
    let out = ''
    while (this.i < this.s.length) {
      const c = this.s[this.i]
      if (c === '\\' && quote === '"') {
        out += this.s[this.i + 1]
        this.i += 2
        continue
      }
      if (c === quote) {
        if (quote === "'" && this.s[this.i + 1] === "'") {
          out += "'"
          this.i += 2
          continue
        }
        this.i += 1
        return out
      }
      out += c
      this.i += 1
    }
    return out
  }

  parseScalarToken() {
    const c = this.s[this.i]
    if (c === '"' || c === "'") return this.parseQuoted()
    let start = this.i
    while (this.i < this.s.length && !/[,\]}:#]/.test(this.s[this.i])) this.i += 1
    // 允许 `:` 出现在无空格的位置（如 URL）
    while (this.i < this.s.length && this.s[this.i] === ':' && !/[\s,\}\]]/.test(this.s[this.i + 1] ?? ' ')) {
      this.i += 1
      while (this.i < this.s.length && !/[,\]}:#]/.test(this.s[this.i])) this.i += 1
    }
    return parseScalar(this.s.slice(start, this.i))
  }
}

/* ------------------------------------------------------------------ 生成 */

const PLAIN_SAFE = /^[A-Za-z0-9\u00a0-\uffff][A-Za-z0-9 _.\-+()/\u00a0-\uffff]*$/

export function needsQuote(s) {
  if (typeof s !== 'string') return false
  if (s === '') return true
  if (!PLAIN_SAFE.test(s)) return true
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return true
  if (/\s$/.test(s) || /^\s/.test(s)) return true
  if (/[:#]\s/.test(s) || /\s#/.test(s)) return true
  if (parseScalarLooksTyped(s)) return true
  return false
}

function parseScalarLooksTyped(s) {
  if (/^[-+]?\d+(\.\d*)?([eE][-+]?\d+)?$/.test(s)) return true
  if (/^(true|false|null|~|Null|NULL|True|False)$/i.test(s)) return true
  if (/^[-+]?\.(inf|Inf|nan|NaN)$/.test(s)) return true
  return false
}

function quote(s) {
  return `"${String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`
}

function scalarOut(v) {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return v > 0 ? '.inf' : Number.isNaN(v) ? '.nan' : '-.inf'
    return String(v)
  }
  const s = String(v)
  if (s.includes('\n')) {
    // 多行文本用双引号转义，保持单行可解析
    return quote(s)
  }
  return needsQuote(s) ? quote(s) : s
}

/**
 * 生成 YAML
 * @param {any} value
 * @param {{indent?:number, seqIndent?:boolean}} opts seqIndent=true 时序列额外缩进（默认与父键同缩进）
 */
export function buildYaml(value, opts = {}) {
  const indentStep = opts.indent ?? 2
  const seqIndented = opts.seqIndent ?? false
  const lines = []
  emit(value, 0, lines, indentStep, seqIndented, true)
  return lines.join('\n') + '\n'
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

function emit(node, indent, lines, step, seqIndented, isRoot) {
  const pad = ' '.repeat(indent)
  if (Array.isArray(node)) {
    if (!node.length) {
      if (isRoot) lines.push(pad + '[]')
      return
    }
    for (const item of node) {
      if (isPlainObject(item) && Object.keys(item).length) {
        const keys = Object.keys(item)
        const [first, ...others] = keys
        lines.push(`${pad}- ${first}: ${inlineValue(item[first], indent + step, lines, step, seqIndented)}`)
        for (const k of others) {
          lines.push(`${pad}  ${k}: ${inlineValue(item[k], indent + step, lines, step, seqIndented)}`)
        }
      } else if (Array.isArray(item) && item.length) {
        lines.push(`${pad}-`)
        emit(item, indent + step, lines, step, seqIndented, false)
      } else {
        lines.push(`${pad}- ${scalarOut(item)}`)
      }
    }
    return
  }
  if (isPlainObject(node)) {
    const keys = Object.keys(node)
    if (!keys.length) {
      if (isRoot) lines.push(pad + '{}')
      return
    }
    for (const k of keys) {
      lines.push(`${pad}${keyOut(k)}: ${inlineValue(node[k], indent, lines, step, seqIndented)}`)
    }
    return
  }
  lines.push(pad + scalarOut(node))
}

function keyOut(k) {
  return needsQuote(k) ? quote(k) : k
}

/** 返回 `key: ` 之后的文本；若值需要嵌套则自行 push 行并返回 '' */
function inlineValue(v, indent, lines, step, seqIndented) {
  if (Array.isArray(v)) {
    if (!v.length) return '[]'
    const childIndent = seqIndented ? indent + step : indent
    emit(v, childIndent, lines, step, seqIndented, false)
    return ''
  }
  if (isPlainObject(v)) {
    if (!Object.keys(v).length) return '{}'
    emit(v, indent + step, lines, step, seqIndented, false)
    return ''
  }
  return scalarOut(v)
}

export default { parseYaml, parseYamlWithWarnings, buildYaml, parseScalar, needsQuote }
