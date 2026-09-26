/**
 * HTTP 小工具：超时、重试、统一请求头。
 * 只用 Node 内置 fetch（Node 18+）。
 */

export const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'

export class HttpError extends Error {
  constructor(message, status, url, body) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.url = url
    this.body = body
  }
}

/**
 * 带超时的 fetch
 * @param {string} url
 * @param {RequestInit & {timeout?:number}} opts
 */
export async function fetchWithTimeout(url, opts = {}) {
  const { timeout = 15000, ...rest } = opts
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(url, { ...rest, signal: rest.signal ?? controller.signal })
    return res
  } catch (err) {
    if (err.name === 'AbortError') throw new HttpError(`请求超时（${timeout}ms）：${url}`, 0, url)
    throw new HttpError(`网络请求失败：${err.message}`, 0, url)
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 请求 JSON，失败重试
 * @param {string} url
 * @param {{headers?:object, timeout?:number, retries?:number, method?:string, body?:any}} opts
 */
export async function fetchJson(url, opts = {}) {
  const { headers = {}, timeout = 15000, retries = 2, method = 'GET', body } = opts
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetchWithTimeout(url, {
        method,
        headers: { 'User-Agent': DEFAULT_UA, Accept: 'application/json, text/plain, */*', ...headers },
        body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
        timeout,
      })
      const text = await res.text()
      if (!res.ok) throw new HttpError(`HTTP ${res.status}：${url}`, res.status, url, text.slice(0, 300))
      try {
        return JSON.parse(text)
      } catch {
        throw new HttpError(`返回内容不是合法 JSON：${url}`, res.status, url, text.slice(0, 300))
      }
    } catch (err) {
      lastError = err
      if (err.status && err.status >= 400 && err.status < 500 && err.status !== 429) break
      if (attempt < retries) await sleep(400 * (attempt + 1))
    }
  }
  throw lastError
}

/** 请求文本 */
export async function fetchText(url, opts = {}) {
  const { headers = {}, timeout = 15000, retries = 1 } = opts
  let lastError
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const res = await fetchWithTimeout(url, {
        headers: { 'User-Agent': DEFAULT_UA, ...headers },
        timeout,
      })
      const text = await res.text()
      if (!res.ok) throw new HttpError(`HTTP ${res.status}：${url}`, res.status, url, text.slice(0, 300))
      return text
    } catch (err) {
      lastError = err
      if (attempt < retries) await sleep(400 * (attempt + 1))
    }
  }
  throw lastError
}

/** 跟随重定向并返回最终 URL（用于 b23.tv 短链展开） */
export async function resolveRedirect(url, opts = {}) {
  const { timeout = 12000, headers = {} } = opts
  try {
    const res = await fetchWithTimeout(url, {
      method: 'GET',
      redirect: 'follow',
      headers: { 'User-Agent': DEFAULT_UA, ...headers },
      timeout,
    })
    return res.url || url
  } catch {
    return url
  }
}

/** 检查链接可达性（用于资源库健康检查） */
export async function checkLink(url, opts = {}) {
  const { timeout = 8000 } = opts
  const headers = { 'User-Agent': DEFAULT_UA, Accept: 'text/html,application/xhtml+xml,*/*' }
  try {
    let res = await fetchWithTimeout(url, { method: 'HEAD', headers, redirect: 'follow', timeout })
    if (res.status === 405 || res.status === 501 || res.status === 403) {
      res = await fetchWithTimeout(url, { method: 'GET', headers, redirect: 'follow', timeout })
    }
    return { url, status: res.status, ok: res.status < 400 || res.status === 403, finalUrl: res.url }
  } catch (err) {
    return { url, status: 0, ok: false, error: String(err.message ?? err) }
  }
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/** 把对象拼成查询串 */
export function qs(params) {
  const sp = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') sp.set(k, String(v))
  }
  return sp.toString()
}

export default { fetchWithTimeout, fetchJson, fetchText, resolveRedirect, checkLink, sleep, qs, DEFAULT_UA, HttpError }
