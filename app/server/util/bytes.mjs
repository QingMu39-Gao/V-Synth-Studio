/**
 * 二进制读写辅助（零依赖），用于 MIDI (SMF) 等二进制格式。
 */

/** 统一把各种输入转成 Buffer */
export function toBuffer(input) {
  if (Buffer.isBuffer(input)) return input
  if (input instanceof Uint8Array) return Buffer.from(input)
  if (input instanceof ArrayBuffer) return Buffer.from(input)
  if (typeof input === 'string') return Buffer.from(input, 'utf8')
  throw new TypeError('无法转换为 Buffer: ' + typeof input)
}

export class BufferReader {
  constructor(input) {
    this.buf = toBuffer(input)
    this.pos = 0
  }

  get length() {
    return this.buf.length
  }

  get remaining() {
    return this.buf.length - this.pos
  }

  eof() {
    return this.pos >= this.buf.length
  }

  seek(pos) {
    this.pos = pos
    return this
  }

  skip(n) {
    this.pos += n
    return this
  }

  tell() {
    return this.pos
  }

  peek(n = 1) {
    return this.buf.subarray(this.pos, this.pos + n)
  }

  bytes(n) {
    const out = this.buf.subarray(this.pos, this.pos + n)
    this.pos += n
    return out
  }

  u8() {
    return this.buf.readUInt8(this.pos++)
  }

  i8() {
    return this.buf.readInt8(this.pos++)
  }

  u16be() {
    const v = this.buf.readUInt16BE(this.pos)
    this.pos += 2
    return v
  }

  i16be() {
    const v = this.buf.readInt16BE(this.pos)
    this.pos += 2
    return v
  }

  u24be() {
    const v = (this.buf[this.pos] << 16) | (this.buf[this.pos + 1] << 8) | this.buf[this.pos + 2]
    this.pos += 3
    return v
  }

  u32be() {
    const v = this.buf.readUInt32BE(this.pos)
    this.pos += 4
    return v
  }

  i32be() {
    const v = this.buf.readInt32BE(this.pos)
    this.pos += 4
    return v
  }

  u16le() {
    const v = this.buf.readUInt16LE(this.pos)
    this.pos += 2
    return v
  }

  u32le() {
    const v = this.buf.readUInt32LE(this.pos)
    this.pos += 4
    return v
  }

  /** 变长整数（MIDI VLQ） */
  varInt() {
    let value = 0
    for (let i = 0; i < 4; i += 1) {
      const b = this.u8()
      value = (value << 7) | (b & 0x7f)
      if ((b & 0x80) === 0) break
    }
    return value
  }

  /** 定长 ASCII/UTF-8 字符串 */
  str(len) {
    return this.bytes(len).toString('utf8')
  }

  ascii(len) {
    return this.bytes(len).toString('latin1')
  }

  /** 以 NUL 结尾的字符串 */
  cstr(encoding = 'utf8') {
    const end = this.buf.indexOf(0, this.pos)
    const stop = end < 0 ? this.buf.length : end
    const s = this.buf.subarray(this.pos, stop).toString(encoding)
    this.pos = stop + 1
    return s
  }
}

export class BufferWriter {
  constructor() {
    this.chunks = []
    this.size = 0
  }

  push(buf) {
    this.chunks.push(buf)
    this.size += buf.length
    return this
  }

  u8(v) {
    const b = Buffer.allocUnsafe(1)
    b.writeUInt8(v & 0xff, 0)
    return this.push(b)
  }

  i8(v) {
    const b = Buffer.allocUnsafe(1)
    b.writeInt8(v, 0)
    return this.push(b)
  }

  u16be(v) {
    const b = Buffer.allocUnsafe(2)
    b.writeUInt16BE(v & 0xffff, 0)
    return this.push(b)
  }

  i16be(v) {
    const b = Buffer.allocUnsafe(2)
    b.writeInt16BE(v, 0)
    return this.push(b)
  }

  u24be(v) {
    return this.push(Buffer.from([(v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff]))
  }

  u32be(v) {
    const b = Buffer.allocUnsafe(4)
    b.writeUInt32BE(v >>> 0, 0)
    return this.push(b)
  }

  i32be(v) {
    const b = Buffer.allocUnsafe(4)
    b.writeInt32BE(v | 0, 0)
    return this.push(b)
  }

  u16le(v) {
    const b = Buffer.allocUnsafe(2)
    b.writeUInt16LE(v & 0xffff, 0)
    return this.push(b)
  }

  u32le(v) {
    const b = Buffer.allocUnsafe(4)
    b.writeUInt32LE(v >>> 0, 0)
    return this.push(b)
  }

  /** 变长整数（MIDI VLQ） */
  varInt(value) {
    let v = Math.max(0, Math.round(value))
    const stack = [v & 0x7f]
    v >>= 7
    while (v > 0) {
      stack.push((v & 0x7f) | 0x80)
      v >>= 7
    }
    for (let i = stack.length - 1; i >= 0; i -= 1) this.u8(stack[i])
    return this
  }

  ascii(str) {
    return this.push(Buffer.from(str, 'latin1'))
  }

  utf8(str) {
    return this.push(Buffer.from(str, 'utf8'))
  }

  bytes(buf) {
    return this.push(toBuffer(buf))
  }

  /** 写入占位长度（返回位置，稍后 patchU32 回填） */
  placeholderU32() {
    const at = this.size
    this.u32be(0)
    return at
  }

  toBuffer() {
    return Buffer.concat(this.chunks, this.size)
  }

  sliceFrom(offset) {
    return this.toBuffer().subarray(offset)
  }
}

/** 在已有 Buffer 上回填 4 字节大端值 */
export function patchU32(buf, offset, value) {
  buf.writeUInt32BE(value >>> 0, offset)
  return buf
}

/** 人类可读的字节数 */
export function formatBytes(n) {
  if (!Number.isFinite(n)) return '-'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = n
  let i = 0
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i += 1
  }
  return `${v.toFixed(i === 0 ? 0 : v < 10 ? 2 : 1)} ${units[i]}`
}

export default { BufferReader, BufferWriter, toBuffer, patchU32, formatBytes }
