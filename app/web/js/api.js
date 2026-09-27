/**
 * 后端 API 封装 + 任务进度订阅
 */

const BASE = ''

async function request(path, { method = 'GET', body, timeout = 120000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeout)
  try {
    const res = await fetch(BASE + path, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    })
    const text = await res.text()
    let data
    try {
      data = text ? JSON.parse(text) : {}
    } catch {
      throw new Error(`服务端返回异常内容（HTTP ${res.status}）`)
    }
    if (!res.ok || data.ok === false) {
      const err = new Error(data.error || `请求失败（HTTP ${res.status}）`)
      err.code = data.code
      err.status = res.status
      throw err
    }
    return data
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('请求超时，请检查后台服务是否仍在运行')
    throw err
  } finally {
    clearTimeout(timer)
  }
}

export const api = {
  get: (path, params) => {
    const qs = params ? '?' + new URLSearchParams(params).toString() : ''
    return request(path + qs)
  },
  post: (path, body, timeout) => request(path, { method: 'POST', body, timeout }),

  health: () => request('/api/health', { timeout: 5000 }),
  state: () => request('/api/state', { timeout: 60000 }),
  config: () => request('/api/config'),
  saveConfig: (patch) => request('/api/config', { method: 'POST', body: patch }),

  detect: (force) => request(`/api/tools/detect${force ? '?force=1' : ''}`, { timeout: 60000 }),
  launch: (payload) => request('/api/tools/launch', { method: 'POST', body: payload }),

  fsRoots: () => request('/api/fs/roots'),
  fsList: (path, { exts, files } = {}) => {
    const qs = new URLSearchParams({ path: path ?? '' })
    if (exts?.length) qs.set('exts', exts.join(','))
    if (files === false) qs.set('files', '0')
    return request(`/api/fs/list?${qs}`)
  },
  fsMkdir: (path) => request('/api/fs/mkdir', { method: 'POST', body: { path } }),
  fsReveal: (path, select = true) => request('/api/fs/reveal', { method: 'POST', body: { path, select } }),
  fsOpen: (payload) => request('/api/fs/open', { method: 'POST', body: payload }),

  collect: (dir, recursive = true) => request('/api/convert/collect', { method: 'POST', body: { dir, recursive } }),
  inspect: (payload) => request('/api/convert/inspect', { method: 'POST', body: payload }),
  preview: (payload) => request('/api/convert/preview', { method: 'POST', body: payload }),
  convert: (payload) => request('/api/convert/run', { method: 'POST', body: payload }),

  parseVideo: (payload) => request('/api/video/parse', { method: 'POST', body: payload, timeout: 180000 }),
  downloadVideo: (payload) => request('/api/video/download', { method: 'POST', body: payload }),

  audioRun: (payload) => request('/api/audio/run', { method: 'POST', body: payload }),
  audioProbe: (input) => request('/api/audio/probe', { method: 'POST', body: { input } }),

  resources: (reload) => request(`/api/resources${reload ? '?reload=1' : ''}`, { timeout: 30000 }),
  checkLinks: (ids) => request('/api/resources/check', { method: 'POST', body: { ids } }),

  // 歌词页（网易云 / QQ 音乐）
  lyricsSearch: (payload) => request('/api/lyrics/search', { method: 'POST', body: payload }),
  lyricsGet: (payload) => request('/api/lyrics/get', { method: 'POST', body: payload }),
  lyricsParseLink: (payload) => request('/api/lyrics/parse-link', { method: 'POST', body: payload }),
  lyricsSave: (payload) => request('/api/lyrics/save', { method: 'POST', body: payload }),
  lyricsCover: (payload) => request('/api/lyrics/cover', { method: 'POST', body: payload }),
  // 网易云登录：扫码 + 手机号验证码两条路，Cookie 兜底。
  // 扫码按官方写法（POST + 表单体，二维码内容是 http://）；8821 表示网易云挡了这条路，
  // 界面上要引导用户改用下面的手机号验证码。
  lyricsQr: () => request('/api/lyrics/login/qr', { method: 'POST', body: {}, timeout: 30000 }),
  lyricsPoll: (key) => request(`/api/lyrics/login/poll?key=${encodeURIComponent(key)}`, { timeout: 30000 }),
  lyricsAccount: () => request('/api/lyrics/login/account', { method: 'POST', body: {}, timeout: 30000 }),
  // 手机号 + 短信验证码（明文接口，不需要加密）
  lyricsSms: (phone) => request('/api/lyrics/login/sms', { method: 'POST', body: { phone }, timeout: 30000 }),
  lyricsCellphone: (phone, captcha) => request('/api/lyrics/login/cellphone', { method: 'POST', body: { phone, captcha }, timeout: 30000 }),

  jobs: () => request('/api/jobs'),
  job: (id) => request(`/api/jobs/get?id=${id}`),
  cancelJob: (id) => request('/api/jobs/cancel', { method: 'POST', body: { id } }),
}

/**
 * 订阅任务进度（SSE，失败自动退回轮询）
 * @param {string} jobId
 * @param {{onUpdate?:Function, onDone?:Function, onError?:Function}} handlers
 * @returns {() => void} 停止订阅
 */
export function watchJob(jobId, handlers = {}) {
  let source = null
  let pollTimer = null
  let stopped = false
  let sawTerminal = false

  const finish = (job) => {
    if (sawTerminal || stopped) return
    sawTerminal = true
    if (job.status === 'error') handlers.onError?.(new Error(job.error ?? '任务失败'), job)
    else if (job.status === 'canceled') handlers.onCancel?.(job)
    else handlers.onDone?.(job)
  }

  const handle = (job) => {
    if (stopped || !job) return
    handlers.onUpdate?.(job)
    if (['done', 'error', 'canceled'].includes(job.status)) {
      finish(job)
      stop()
    }
  }

  const startPolling = () => {
    if (pollTimer || stopped) return
    pollTimer = setInterval(async () => {
      try {
        const { job } = await api.job(jobId)
        handle(job)
      } catch {
        /* 忽略瞬时错误 */
      }
    }, 700)
  }

  const stop = () => {
    stopped = true
    if (source) {
      source.close()
      source = null
    }
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  try {
    source = new EventSource(`/api/jobs/${jobId}/stream`)
    source.onmessage = (ev) => {
      try {
        handle(JSON.parse(ev.data))
      } catch {
        /* 忽略坏包 */
      }
    }
    source.onerror = () => {
      if (stopped) return
      source.close()
      source = null
      startPolling()
    }
  } catch {
    startPolling()
  }

  return stop
}

export default api
