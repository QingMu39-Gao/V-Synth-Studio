import {useCallback, useState} from 'react'
import {api, type UpdateInstaller} from './api'
import {useJob} from './useJob'
import type {Job} from './types'

type Toast = (msg: string, tone?: 'ok' | 'err' | 'warn' | 'info') => void

/**
 * 「下载新版本」这一条路：起一个下载任务、跟它的进度、记住下完的那份文件。
 *
 * 启动弹窗与「设置 → 关于」两个入口共用同一份实现 —— 校验结果怎么说、失败怎么报
 * 只该有一份说法，两处各写一遍必然漂。
 */
export function useUpdateDownload(onToast: Toast) {
    const {job, start} = useJob()
    const [file, setFile] = useState<string>('')
    /** 这份有没有核对过 SHA-256（`null` = 还没下完）。没有清单时是 `false`，界面要照实说 */
    const [verified, setVerified] = useState<boolean | null>(null)

    const download = useCallback(
        async (installer: UpdateInstaller, version?: string) => {
            setFile('')
            setVerified(null)
            try {
                const {jobId} = await api.updateDownload({...installer, version})
                start(jobId, {
                    onDone: (j: Job) => {
                        const r = (j.result ?? {}) as { file?: string; verified?: boolean }
                        setFile(String(r.file ?? ''))
                        setVerified(!!r.verified)
                    },
                    onError: (e: Error) => onToast(`下载新版本失败：${e.message}`, 'err'),
                    // 取消不算错：用户自己按的
                    onCancel: () => undefined,
                })
            } catch (e) {
                onToast(`下载新版本失败：${e instanceof Error ? e.message : String(e)}`, 'err')
            }
        },
        [start, onToast],
    )

    return {job, download, file, verified}
}
