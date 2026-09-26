/**
 * 系统路径探测
 *
 * 为什么不直接用 process.env.USERPROFILE：
 * 在沙箱 / 便携环境里 USERPROFILE 可能被改写到别处，注册表里的「用户 Shell 文件夹」
 * 也可能跟着被改。所以要多路探测，取第一个真实存在的。
 */

import { existsSync, readdirSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

/**
 * 取系统的「下载」目录。
 *
 * 顺序：
 *   1) 注册表 HKCU\...\Explorer\User Shell Folders 里的 Downloads 项（资源管理器真正在用的那个）
 *   2) %USERPROFILE%\Downloads
 *   3) 枚举 C:\Users\*\Downloads
 *   4) 退回传入的兜底目录
 *
 * @param {string} fallback 都找不到时用这个
 */
export function getDownloadsDir(fallback = '') {
  const candidates = []

  // 1) 注册表
  try {
    const out = execFileSync('powershell', [
      '-NoProfile', '-NonInteractive', '-Command',
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8; " +
        "(Get-ItemProperty 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders' " +
        "-ErrorAction SilentlyContinue).'{374DE290-123F-4565-9164-39C4925E467B}'",
    ], { encoding: 'utf8', timeout: 8000, windowsHide: true })
    const raw = (out ?? '').trim()
    if (raw) candidates.push(expandEnv(raw))
  } catch {
    /* 读不到就算了 */
  }

  // 2) 环境变量
  if (process.env.USERPROFILE) candidates.push(join(process.env.USERPROFILE, 'Downloads'))
  if (process.env.HOMEDRIVE && process.env.HOMEPATH) {
    candidates.push(join(`${process.env.HOMEDRIVE}${process.env.HOMEPATH}`, 'Downloads'))
  }

  // 3) 枚举 C:\Users\*
  const usersRoot = 'C:\\Users'
  if (existsSync(usersRoot)) {
    try {
      for (const entry of readdirSync(usersRoot, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        if (/^(Public|Default|Default User|All Users|WDAGUtilityAccount)$/i.test(entry.name)) continue
        candidates.push(join(usersRoot, entry.name, 'Downloads'))
      }
    } catch {
      /* ignore */
    }
  }

  for (const c of candidates) {
    if (c && existsSync(c)) return c
  }
  // 都不存在时，尽量创建第一个候选（父目录存在的话）
  for (const c of candidates) {
    if (!c) continue
    try {
      mkdirSync(c, { recursive: true })
      return c
    } catch {
      /* 试下一个 */
    }
  }
  return fallback
}

/** 展开 %VAR% 形式的路径 */
function expandEnv(p) {
  return String(p).replace(/%([^%]+)%/g, (m, name) => process.env[name] ?? m)
}

export default { getDownloadsDir }
