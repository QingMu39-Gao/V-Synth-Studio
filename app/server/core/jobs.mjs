/**
 * 任务管理器
 *
 * 用于转换 / 下载 / 工具安装等长任务的进度上报与前端实时订阅（SSE）。
 * 纯内存实现，任务列表上限 200 条，日志每条上限 500 行。
 */

import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'

const MAX_JOBS = 200
const MAX_LOGS = 500

export class JobManager {
  constructor() {
    this.jobs = new Map()
    this.emitter = new EventEmitter()
    this.emitter.setMaxListeners(200)
    this.controllers = new Map()
  }

  /**
   * 创建任务
   * @param {{type:string, title:string, meta?:object, cancellable?:boolean}} init
   */
  create(init) {
    const job = {
      id: randomUUID().slice(0, 8),
      type: init.type,
      title: init.title ?? '',
      meta: init.meta ?? {},
      status: 'queued',
      percent: 0,
      message: '',
      logs: [],
      result: null,
      error: null,
      createdAt: Date.now(),
      startedAt: null,
      finishedAt: null,
      cancellable: init.cancellable !== false,
      progress: {},
    }
    this.jobs.set(job.id, job)
    this.prune()
    this.emit(job)
    return job
  }

  get(id) {
    return this.jobs.get(id) ?? null
  }

  list() {
    return [...this.jobs.values()].sort((a, b) => b.createdAt - a.createdAt)
  }

  /** 注册取消控制器（AbortController） */
  setController(id, controller) {
    this.controllers.set(id, controller)
  }

  update(id, patch) {
    const job = this.jobs.get(id)
    if (!job) return null
    Object.assign(job, patch)
    this.emit(job)
    return job
  }

  setProgress(id, { percent, message, ...rest }) {
    const job = this.jobs.get(id)
    if (!job) return null
    if (job.status === 'queued') {
      job.status = 'running'
      job.startedAt = Date.now()
    }
    if (typeof percent === 'number' && percent >= 0) job.percent = Math.max(0, Math.min(100, percent))
    if (message) job.message = message
    Object.assign(job.progress, rest)
    this.emit(job)
    return job
  }

  log(id, line) {
    const job = this.jobs.get(id)
    if (!job || !line) return
    const stamp = new Date().toLocaleTimeString('zh-CN', { hour12: false })
    job.logs.push(`[${stamp}] ${line}`)
    if (job.logs.length > MAX_LOGS) job.logs.splice(0, job.logs.length - MAX_LOGS)
    this.emit(job)
  }

  finish(id, result = null, message = '完成') {
    const job = this.jobs.get(id)
    if (!job) return null
    job.status = 'done'
    job.percent = 100
    job.result = result
    job.message = message
    job.finishedAt = Date.now()
    this.controllers.delete(id)
    this.emit(job)
    return job
  }

  fail(id, error) {
    const job = this.jobs.get(id)
    if (!job) return null
    job.status = 'error'
    job.error = String(error?.message ?? error)
    job.message = job.error
    job.finishedAt = Date.now()
    this.controllers.delete(id)
    this.emit(job)
    return job
  }

  cancel(id) {
    const job = this.jobs.get(id)
    if (!job) return null
    if (job.status === 'done' || job.status === 'error' || job.status === 'canceled') return job
    const controller = this.controllers.get(id)
    if (controller) {
      try {
        controller.abort()
      } catch {
        /* ignore */
      }
    }
    job.status = 'canceled'
    job.message = '已取消'
    job.finishedAt = Date.now()
    this.emit(job)
    return job
  }

  prune() {
    const all = this.list()
    if (all.length <= MAX_JOBS) return
    for (const job of all.slice(MAX_JOBS)) {
      this.jobs.delete(job.id)
      this.controllers.delete(job.id)
    }
  }

  emit(job) {
    this.emitter.emit(`job:${job.id}`, job)
    this.emitter.emit('job', job)
  }

  /**
   * 订阅任务更新
   * @param {string} id
   * @param {(job:object)=>void} cb
   * @returns {() => void} 取消订阅
   */
  subscribe(id, cb) {
    const handler = (job) => cb(job)
    this.emitter.on(`job:${id}`, handler)
    return () => this.emitter.off(`job:${id}`, handler)
  }

  /** 清理超过 1 小时的已完成任务 */
  cleanup() {
    const cutoff = Date.now() - 3600_000
    for (const job of this.jobs.values()) {
      if (job.finishedAt && job.finishedAt < cutoff) {
        this.jobs.delete(job.id)
        this.controllers.delete(job.id)
      }
    }
  }
}

export const jobs = new JobManager()

/** 定时清理 */
setInterval(() => jobs.cleanup(), 10 * 60 * 1000).unref?.()

export default jobs
