/**
 * 最小 ZIP 读写（纯 Node，无依赖）
 *
 * 从 vpr.mjs 里抽出来的 —— 那里原本自己实现了一份，现在 vpr 和测试共用这一份。
 * 抽出来的直接动机：测试原来借 PowerShell 的 System.IO.Compression 解 vpr，
 * 那是 Windows 独有的，去掉它移植到 macOS 时就不用改测试了。
 *
 * 支持范围（够用即可，不追求完整 ZIP 规范）：
 *   - 读：中央目录遍历，压缩方式 store(0) / deflate(8)
 *   - 写：deflate(8)，空条目和目录用 store(0)
 *   - 编码：条目名按 UTF-8（写时置 0x0800 标志位）
 * 不支持 ZIP64、加密、data descriptor —— 见文件末尾的说明。
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let i = 0; i < 256; i += 1) {
    let c = i
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[i] = c
  }
  return table
})()

export function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i += 1) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

/** 文件头看起来是不是 ZIP（PK\x03\x04 / PK\x05\x06 / PK\x07\x08） */
export function isZipBuffer(buf) {
  return (
    buf.length > 4 &&
    buf[0] === 0x50 &&
    buf[1] === 0x4b &&
    (buf[2] === 0x03 || buf[2] === 0x05 || buf[2] === 0x07)
  )
}

/**
 * 读取 zip 的全部条目（只用中央目录，忽略 data descriptor）
 * @param {Buffer} buf
 * @param {string} [label] 出错信息里用的名字，便于定位是哪个文件坏了
 * @returns {Array<{name:string, data:Buffer, size:number}>}
 */
export function unzipEntries(buf, label = 'ZIP') {
  let eocd = -1
  const lowest = Math.max(0, buf.length - 66000)
  for (let i = buf.length - 22; i >= lowest; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error(`${label}：ZIP 结构损坏（找不到中央目录结尾记录）`)

  const count = buf.readUInt16LE(eocd + 10)
  let offset = buf.readUInt32LE(eocd + 16)
  const entries = []

  for (let i = 0; i < count; i += 1) {
    if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`${label}：ZIP 中央目录第 ${i + 1} 项损坏`)
    }
    const method = buf.readUInt16LE(offset + 10)
    const compSize = buf.readUInt32LE(offset + 20)
    const nameLen = buf.readUInt16LE(offset + 28)
    const extraLen = buf.readUInt16LE(offset + 30)
    const commentLen = buf.readUInt16LE(offset + 32)
    const localOffset = buf.readUInt32LE(offset + 42)
    const name = buf.subarray(offset + 46, offset + 46 + nameLen).toString('utf8')

    if (localOffset + 30 <= buf.length && buf.readUInt32LE(localOffset) === 0x04034b50) {
      const dataStart =
        localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28)
      const raw = buf.subarray(dataStart, Math.min(dataStart + compSize, buf.length))
      let data = raw
      if (method === 8) data = inflateRawSync(raw)
      else if (method !== 0) {
        throw new Error(`${label}：ZIP 条目「${name}」使用了不支持的压缩方式 ${method}`)
      }
      entries.push({ name, data: Buffer.from(data), size: raw.length })
    }
    offset += 46 + nameLen + extraLen + commentLen
  }
  return entries
}

/**
 * 生成 zip（deflate；空条目和目录用 store）
 * @param {Array<{name:string, data?:Buffer}>} items
 * @returns {Buffer}
 */
export function zipEntries(items) {
  const chunks = []
  const central = []
  let offset = 0
  const dosDate = ((2024 - 1980) << 9) | (1 << 5) | 1
  const dosTime = 0

  for (const item of items) {
    const nameBuf = Buffer.from(item.name, 'utf8')
    const raw = item.data ?? Buffer.alloc(0)
    const isDir = item.name.endsWith('/')
    const body = isDir || raw.length === 0 ? raw : deflateRawSync(raw, { level: 9 })
    const method = isDir || raw.length === 0 ? 0 : 8
    const crc = crc32(raw)

    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(0x0800, 6) // UTF-8 名字标志
    header.writeUInt16LE(method, 8)
    header.writeUInt16LE(dosTime, 10)
    header.writeUInt16LE(dosDate, 12)
    header.writeUInt32LE(crc, 14)
    header.writeUInt32LE(body.length, 18)
    header.writeUInt32LE(raw.length, 22)
    header.writeUInt16LE(nameBuf.length, 26)
    header.writeUInt16LE(0, 28)
    chunks.push(header, nameBuf, body)

    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt16LE(method, 10)
    cd.writeUInt16LE(dosTime, 12)
    cd.writeUInt16LE(dosDate, 14)
    cd.writeUInt32LE(crc, 16)
    cd.writeUInt32LE(body.length, 20)
    cd.writeUInt32LE(raw.length, 24)
    cd.writeUInt16LE(nameBuf.length, 28)
    cd.writeUInt16LE(0, 30)
    cd.writeUInt16LE(0, 32)
    cd.writeUInt16LE(0, 34)
    cd.writeUInt16LE(0, 36)
    cd.writeUInt32LE(isDir ? 0x10 : 0, 38)
    cd.writeUInt32LE(offset, 42)
    central.push(cd, nameBuf)
    offset += header.length + nameBuf.length + body.length
  }

  const centralBuf = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(items.length, 8)
  end.writeUInt16LE(items.length, 10)
  end.writeUInt32LE(centralBuf.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, centralBuf, end])
}

/** 便捷：按名字取一个条目（找不到返回 null） */
export function findEntry(buf, matcher, label) {
  const test = typeof matcher === 'function' ? matcher : (n) => n === matcher
  return unzipEntries(buf, label).find((e) => test(e.name)) ?? null
}

/*
 * ponytail: 不支持 ZIP64（>4GB 或条目数 >65535）、加密、data descriptor。
 * 工程文件（.vpr 等）都在几十 MB 内、条目数个位数，用不上。
 * 真遇到超规格的包，换 yauzl 之类的库，别在这里手写 ZIP64。
 */
