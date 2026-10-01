import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from './api'
import type { Job } from './types'

/**
 * 订阅一个后端任务的进度 —— 旧界面的 `watchJob`，改成 React 钩子。
 *
 * 契约**照旧不变**：优先 SSE（`/api/jobs/<id>/stream`，推的是完整快照），
 * 连接断了自动退回 700ms 轮询；`done | error | canceled` 三个状态是终态，
 * 到终态就收订阅、只回调一次。
 *
 * ⚠️ **页面卸载时要停订阅**：钩子里在 `useEffect` 的清理函数里做了，
 * 但**手动 `start()` 第二个任务前也要 `stop()`** —— 否则两个 SSE 同时刷同一份 state。
 */
interface JobHandlers {
  onUpdate?: (job: Job) => void
  onDone?: (job: Job) => void
  onError?: (err: Error, job: Job) => void
  onCancel?: (job: Job) => void
}

export function useJob() {
  const [job, setJob] = useState<Job | null>(null)
  const handlersRef = useRef<JobHandlers>({})
  const stopRef = useRef<(() => void) | null>(null)

  const stop = useCallback(() => {
    stopRef.current?.()
    stopRef.current = null
  }, [])

  const start = useCallback(
    (jobId: string, handlers: JobHandlers = {}) => {
      stopRef.current?.()
      handlersRef.current = handlers
      setJob(null)

      let source: EventSource | null = null
      let pollTimer: number | null = null
      let stopped = false
      let sawTerminal = false

      const finish = (j: Job) => {
        if (sawTerminal || stopped) return
        sawTerminal = true
        if (j.status === 'error') handlersRef.current.onError?.(new Error(j.error ?? '任务失败'), j)
        else if (j.status === 'canceled') handlersRef.current.onCancel?.(j)
        else handlersRef.current.onDone?.(j)
      }

      const handle = (j: Job | undefined | null) => {
        if (stopped || !j) return
        setJob(j)
        handlersRef.current.onUpdate?.(j)
        if (j.status === 'done' || j.status === 'error' || j.status === 'canceled') {
          finish(j)
          stopLocal()
        }
      }

      const startPolling = () => {
        if (pollTimer !== null || stopped) return
        pollTimer = window.setInterval(async () => {
          try {
            const { job: j } = await api.job(jobId)
            handle(j)
          } catch {
            /* 瞬时错误忽略，下一拍再试 */
          }
        }, 700)
      }

      const stopLocal = () => {
        stopped = true
        source?.close()
        source = null
        if (pollTimer !== null) {
          clearInterval(pollTimer)
          pollTimer = null
        }
      }
      stopRef.current = stopLocal

      try {
        source = new EventSource(`/api/jobs/${jobId}/stream`)
        source.onmessage = (ev) => {
          try {
            handle(JSON.parse(ev.data) as Job)
          } catch {
            /* 坏包忽略 */
          }
        }
        source.onerror = () => {
          if (stopped) return
          source?.close()
          source = null
          startPolling()
        }
      } catch {
        startPolling()
      }

      return stopLocal
    },
    [],
  )

  /* 离开页面时收干净 —— 挂着 SSE 会让后端一直广播给一个没人看的页面 */
  useEffect(() => () => stopRef.current?.(), [])

  return { job, start, stop }
}
