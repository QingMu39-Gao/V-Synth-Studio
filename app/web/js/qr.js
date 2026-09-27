/**
 * 极小的二维码生成器（字节模式 · 纠错等级 L · 版本 1–5 · 固定掩码 0）
 *
 * ── 为什么手写 ──────────────────────────────────────────
 * 网易云**没有二维码图片接口**了，实测（2026-09，本机）：
 *   GET https://music.163.com/login?codekey=<unikey>
 *       → 登录页 HTML（Content-Type: text/html），不是 PNG
 *   GET https://music.163.com/api/login/qrcode/client/qrcode?key=<unikey>
 *       → {"code":404,"message":"接口未找到！"}
 *   GET https://music.163.com/login/qrcode?codekey=<unikey>   → 302 到 /404
 * 官方网页版也是自己在前端画码（它的 pt_login_*.js 里带着二维码实现）。
 *
 * 又不能引 npm 包，所以按 ISO/IEC 18004 手写一个够用的子集：
 * 只做字节模式 + L 级纠错 + 版本 1~5 + 固定掩码 0，容量上限 106 字节
 * （登录链接约 73 字节，够用）。这些都是**合法**的二维码 —— 规范允许编码器自选掩码，
 * 只是不做「最小惩罚分」那套优选，省掉一大坨代码。
 *
 * 正确性不靠肉眼：开发时用 jsQR 解码本模块生成的图，内容必须一字不差
 * （临时校验脚本不进仓库）。
 */

/* ── GF(256) 指数/对数表，按 0x11D 生成 ── */
const EXP = new Uint8Array(512)
const LOG = new Uint8Array(256)
{
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP[i] = x
    LOG[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]
}

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]])

/** 生成多项式 (x-α^0)(x-α^1)…(x-α^(n-1))，返回**去掉首项 1** 后的 n 个系数（降幂） */
function generator(n) {
  let poly = [1]
  for (let i = 0; i < n; i++) {
    const next = new Array(poly.length + 1).fill(0)
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j] // 乘 x
      next[j + 1] ^= mul(poly[j], EXP[i]) // 乘 α^i
    }
    poly = next
  }
  return poly.slice(1)
}

/** Reed-Solomon 纠错码字（LFSR 除法取余） */
function ecc(data, ecLen) {
  const gen = generator(ecLen)
  const res = new Uint8Array(ecLen)
  for (const byte of data) {
    const factor = byte ^ res[0]
    res.copyWithin(0, 1)
    res[ecLen - 1] = 0
    for (let i = 0; i < ecLen; i++) res[i] ^= mul(gen[i], factor)
  }
  return res
}

/* 版本表：L 级纠错，1~5 版都是**单块**（不用做分块交织） */
const VERSIONS = {
  1: { data: 19, ec: 7, align: [] },
  2: { data: 34, ec: 10, align: [6, 18] },
  3: { data: 55, ec: 15, align: [6, 22] },
  4: { data: 80, ec: 20, align: [6, 26] },
  5: { data: 108, ec: 26, align: [6, 30] },
}

/**
 * 生成二维码模块矩阵
 * @param {string} text 内容（按 UTF-8 字节数算容量）
 * @returns {boolean[][]} `matrix[y][x] === true` 表示该模块是黑的
 */
export function encode(text) {
  const bytes = new TextEncoder().encode(String(text))

  const version = Object.keys(VERSIONS).map(Number).find((v) => bytes.length <= VERSIONS[v].data - 2)
  if (!version) {
    throw new Error(`内容太长（${bytes.length} 字节），当前只支持到 ${VERSIONS[5].data - 2} 字节`)
  }
  const { data: dataWords, ec: ecWords, align } = VERSIONS[version]

  /* ── 1. 数据码字：模式(0100) + 长度(8 位) + 字节 + 结束符 + 填充 ── */
  const bits = []
  const push = (value, len) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1)
  }
  push(0b0100, 4)
  push(bytes.length, 8)
  for (const b of bytes) push(b, 8)
  push(0, Math.min(4, dataWords * 8 - bits.length)) // 结束符
  while (bits.length % 8 !== 0) bits.push(0) // 补齐到字节

  const codewords = []
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j]
    codewords.push(byte)
  }
  // 交替填充字节，凑满数据容量
  for (let i = 0; codewords.length < dataWords; i++) codewords.push(i % 2 === 0 ? 0xec : 0x11)

  const all = Uint8Array.from([...codewords, ...ecc(codewords, ecWords)])

  /* ── 2. 矩阵：定位 / 校正 / 定时 / 格式信息 ── */
  const size = version * 4 + 17
  const modules = Array.from({ length: size }, () => new Array(size).fill(false))
  const reserved = Array.from({ length: size }, () => new Array(size).fill(false))
  const set = (x, y, dark) => {
    modules[y][x] = dark
    reserved[y][x] = true
  }

  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || y < 0 || x >= size || y >= size) continue
        const d = Math.max(Math.abs(dx), Math.abs(dy))
        set(x, y, d !== 2 && d !== 4) // 7×7 实心 + 一圈空白（d=4 即分隔符）
      }
    }
  }
  finder(3, 3)
  finder(size - 4, 3)
  finder(3, size - 4)

  for (let i = 8; i < size - 8; i++) {
    set(i, 6, i % 2 === 0) // 横向定时图形
    set(6, i, i % 2 === 0) // 纵向定时图形
  }

  // 校正图形：三个角上的与定位图形重叠，跳过
  for (let i = 0; i < align.length; i++) {
    for (let j = 0; j < align.length; j++) {
      if ((i === 0 && j === 0) || (i === 0 && j === align.length - 1) || (i === align.length - 1 && j === 0)) continue
      const cx = align[j]
      const cy = align[i]
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) {
          set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
        }
      }
    }
  }

  // 格式信息的位置先占住（值在掩码之后写）
  for (let i = 0; i <= 8; i++) {
    set(8, i, false)
    set(i, 8, false)
  }
  for (let i = 0; i < 8; i++) {
    set(size - 1 - i, 8, false)
    set(8, size - 1 - i, false)
  }

  /* ── 3. 数据位按「右→左两列一组、上下蛇形」填进去 ── */
  let bit = 0
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5 // 纵向定时图形那一列不填
    for (let vert = 0; vert < size; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j
        const upward = ((right + 1) & 2) === 0
        const y = upward ? size - 1 - vert : vert
        if (!reserved[y][x] && bit < all.length * 8) {
          modules[y][x] = ((all[bit >> 3] >>> (7 - (bit & 7))) & 1) === 1
          bit++
        }
      }
    }
  }

  /* ── 4. 掩码 0：(x+y) 为偶数就取反（只作用于数据区） ── */
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!reserved[y][x] && (x + y) % 2 === 0) modules[y][x] = !modules[y][x]
    }
  }

  /* ── 5. 格式信息：纠错等级 L(01) + 掩码 0，BCH(15,5) 后异或 0x5412 ── */
  const formatData = (0b01 << 3) | 0
  let rem = formatData
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
  const format = ((formatData << 10) | rem) ^ 0x5412
  const fmt = (i) => ((format >>> i) & 1) === 1

  for (let i = 0; i <= 5; i++) modules[i][8] = fmt(i)
  modules[7][8] = fmt(6)
  modules[8][8] = fmt(7)
  modules[8][7] = fmt(8)
  for (let i = 9; i < 15; i++) modules[8][14 - i] = fmt(i)
  for (let i = 0; i < 8; i++) modules[8][size - 1 - i] = fmt(i)
  for (let i = 8; i < 15; i++) modules[size - 15 + i][8] = fmt(i)
  modules[size - 8][8] = true // 固定黑模块

  return modules
}

/**
 * 把二维码画到 canvas 上（内联 SVG 会塞进几万个字符的 DOM，canvas 干净得多）
 * @param {HTMLCanvasElement} canvas
 * @param {string} text
 * @param {{scale?:number, quiet?:number}} opts scale = 每个模块多少像素
 */
export function drawQr(canvas, text, { scale = 6, quiet = 4 } = {}) {
  const matrix = encode(text)
  const n = matrix.length
  const dim = (n + quiet * 2) * scale
  canvas.width = dim
  canvas.height = dim
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, dim, dim)
  ctx.fillStyle = '#000'
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      if (matrix[y][x]) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale)
    }
  }
  return matrix.length
}

export default { encode, drawQr }
