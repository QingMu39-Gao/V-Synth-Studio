/**
 * 后端调用。
 *
 * ⚠️ 新前端挂在 /next/ 下，而后端 API 在**根路径**的 /api/*。
 * 所以这里绝不能写相对路径 './api/state'（那会变成 /next/api/state，404）。
 * 统一走下面的 `call()`，它拼的是绝对路径 `/api/...`。
 */

import type { AppState, HealthInfo, ToolInfo } from './types'

/** 统一拆包：后端固定返回 { ok, ... }，失败时读 error 字段（和旧 api.js 一致） */
async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/${path}`, {
    headers: { 'Content-Type': 'application/json' },
    ...init,
  })
  const data = await res.json().catch(() => null)
  if (!res.ok || (data && data.ok === false)) {
    throw new Error(data?.error ?? `请求失败（HTTP ${res.status}）`)
  }
  return data as T
}

const post = <T,>(path: string, body: unknown) =>
  call<T>(path, { method: 'POST', body: JSON.stringify(body ?? {}) })

export const api = {
  health: () => call<HealthInfo>('health'),
  state: () => call<AppState>('state'),

  /** 配置补丁。后端 config_post 接受任意字段，不用改后端就能存新键。 */
  saveConfig: (patch: Record<string, unknown>) => post('config', patch),

  /** 重新探测外部工具。返回 { installedCount, tools } —— 之后要再拉一次 state */
  detect: (force = true) => call<{ installedCount: number; tools: Record<string, ToolInfo> }>(`tools/detect${force ? '?force=1' : ''}`),

  /** 在文件管理器里定位文件（select=true 时选中它） */
  fsReveal: (path: string, select = false) => post('fs/reveal', { path, select }),
}
