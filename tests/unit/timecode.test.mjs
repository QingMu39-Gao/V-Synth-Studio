/**
 * timecode.js 自测：直接跑，不需要框架
 *
 *   node tests/unit/timecode.test.mjs
 *
 * 这两个函数是纯函数，但边界特别多（空串、只有冒号、负数、超长毫秒、超过 60 分钟…），
 * 而且用户手输的时间会直接变成 ffmpeg 的 -ss / -to 参数 —— 解析错一次，
 * 剪出来的片段就是错的，所以这里把所有想得到的输入都钉死。
 */

import { parseTime, formatTime } from '../../app/web/js/timecode.js'

let passed = 0
let failed = 0

function eq(actual, expected, label) {
  const ok = Object.is(actual, expected)
  if (ok) {
    passed++
  } else {
    failed++
    console.error(`✗ ${label}\n    期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
  }
}

/* ── parseTime：正常输入 ─────────────────────────────────────── */

eq(parseTime('83'), 83, '裸秒数')
eq(parseTime('0'), 0, '零秒')
eq(parseTime('1:23'), 83, '1:23 = 83 秒')
eq(parseTime('0:05'), 5, '0:05 = 5 秒')
eq(parseTime('1:23.456'), 83.456, '带毫秒')
eq(parseTime('1:02:03'), 3723, '时:分:秒')
eq(parseTime('1:02:03.500'), 3723.5, '时:分:秒.毫秒')
eq(parseTime('60:00'), 3600, '60 分整')
eq(parseTime('  1:23  '), 83, '两端空白')
eq(parseTime('.5'), 0.5, '只有小数秒')
eq(parseTime('1:75'), 135, '秒段溢出不报错（宽容）')
eq(parseTime('1:2:3'), 3723, '单位数也认')

/* ── parseTime：超长毫秒 → 四舍五入到毫秒 ────────────────────── */

eq(parseTime('1:23.4567'), 83.457, '超长毫秒四舍五入')
eq(parseTime('0:00.0004'), 0, '亚毫秒归零')

/* ── parseTime：非法输入一律 null ────────────────────────────── */

eq(parseTime(''), null, '空串')
eq(parseTime('   '), null, '全空白')
eq(parseTime(':'), null, '只有一个冒号')
eq(parseTime('1:'), null, '冒号后半截为空')
eq(parseTime(':23'), null, '冒号前半截为空')
eq(parseTime('1::23'), null, '双冒号')
eq(parseTime('-1'), null, '负数')
eq(parseTime('-1:23'), null, '负的分秒')
eq(parseTime('abc'), null, '字母')
eq(parseTime('1m23s'), null, '带单位后缀')
eq(parseTime('1:23s'), null, '混了字母')
eq(parseTime('1:2:3:4'), null, '段数过多')
eq(parseTime('1.2.3'), null, '多个小数点')
eq(parseTime(null), null, 'null')
eq(parseTime(undefined), null, 'undefined')
eq(parseTime({}), null, '对象')
eq(parseTime('Infinity'), null, 'Infinity 文本')
eq(parseTime(-1 / 0), null, '负的 Infinity 数值')
eq(parseTime(Number.NaN), null, 'NaN 数值')

/* ── parseTime：数字入参 ─────────────────────────────────────── */

eq(parseTime(83.4567), 83.457, '数字也四舍五入到毫秒')

/* ── formatTime ─────────────────────────────────────────────── */

eq(formatTime(0), '0:00.000', '零')
eq(formatTime(5), '0:05.000', '个位数秒补零')
eq(formatTime(83.456), '1:23.456', '分:秒.毫秒')
eq(formatTime(59.9999), '1:00.000', '毫秒进位不能吐成 0:60.000')
eq(formatTime(3599.999), '59:59.999', '差一点到一小时')
eq(formatTime(3600), '1:00:00.000', '整一小时')
eq(formatTime(3723.5), '1:02:03.500', '超过 60 分钟')
eq(formatTime(-1), '0:00.000', '负数当 0')
eq(formatTime(Number.NaN), '0:00.000', 'NaN 当 0')
eq(formatTime(undefined), '0:00.000', 'undefined 当 0')
eq(formatTime('83.456'), '1:23.456', '字符串数字也认')

/* ── 往返一致：输入框改一下再改回来，值不能漂 ─────────────────── */

for (const sec of [0, 0.001, 5, 83.456, 599.999, 3600, 3723.5, 7325.125]) {
  eq(parseTime(formatTime(sec)), sec, `往返一致 ${sec}`)
}

/* ── 结果 ───────────────────────────────────────────────────── */

console.log(`timecode: ${passed}/${passed + failed} 通过`)
if (failed) {
  console.error(`${failed} 项断言失败`)
  process.exit(1)
}
