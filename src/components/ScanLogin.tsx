import {useCallback, useEffect, useRef, useState} from 'react'
import {Dialog} from '@/components/ui'
import {QRCodeSVG} from 'qrcode.react'
import {Button} from '@/components/Button'
import {api} from '@/lib/api'

/**
 * B 站扫码登录。
 *
 * 两段式，和 B 站官方的扫码流程一一对应：
 *   1. `bili_qr_generate` → `{ url, qrcodeKey }`，把 `url` 画成二维码；
 *   2. `bili_qr_poll` 带 `qrcodeKey` 轮询，直到后端说成了。
 *
 * ⚠️ **Cookie 永远不回前端**（`ipc/bili.rs` 只回 `{code, message, loggedIn}`）：
 * 拿到 `SESSDATA` 之后是**后端自己**写进配置文件的，这里连它的影子都看不到。
 * 所以这个弹窗不需要任何「保存 Cookie」的按钮 —— 后端说 `loggedIn` 就是已经落盘了。
 *
 * 轮询用 `setTimeout` 自己排下一轮，**不用 `setInterval`**：一轮请求慢过间隔时，
 * `setInterval` 会让请求叠起来，而这里每一轮都得等上一轮回来（`await`）再决定要不要继续。
 *
 * 关掉弹窗要**停轮询**（`open` 是依赖项）：不然用户关了窗，后台还在每 2 秒问一次，
 * 一直问到这个组件被卸载。
 */
export function ScanLogin({
                              open,
                              onClose,
                              onLoggedIn,
                              onToast,
                          }: {
    open: boolean
    onClose: () => void
    /** 登录成功（Cookie 已经由后端写好）—— 调用方据此重拉一次 state */
    onLoggedIn: () => void
    onToast?: (msg: string, tone?: 'ok' | 'err' | 'warn' | 'info') => void
}) {
    /** `idle` 还没申请；`loading` 正在申请；其余对应 B 站的状态码 */
    const [phase, setPhase] = useState<'idle' | 'loading' | 'waiting' | 'scanned' | 'expired' | 'ok' | 'error'>('idle')
    const [qrcode, setQrcode] = useState<{ url: string; key: string } | null>(null)
    const [status, setStatus] = useState('')
    /** 轮询期间按钮要禁用，否则用户会连点「换个二维码」堆出好几条轮询链 */
    const [busy, setBusy] = useState(false)

    /** 成功后只回调一次（轮询最后一轮与 effect 清理之间会有一小段重叠） */
    const done = useRef(false)
    const alive = useRef(true)
    useEffect(() => {
        alive.current = true
        return () => {
            alive.current = false
        }
    }, [])

    /** 申请一张新二维码（打开弹窗、或者上一张失效之后点「换个二维码」） */
    const generate = useCallback(async () => {
        setBusy(true)
        setPhase('loading')
        setStatus('正在申请二维码…')
        try {
            const r = await api.biliQrGenerate()
            if (!alive.current) return
            setQrcode({url: r.url, key: r.qrcodeKey})
            setPhase('waiting')
            setStatus('用手机 B 站扫这个码')
        } catch (e) {
            if (!alive.current) return
            setPhase('error')
            setStatus(e instanceof Error ? e.message : String(e))
        } finally {
            if (alive.current) setBusy(false)
        }
    }, [])

    /* 弹窗一开就申请一张；关掉就把状态收回去，下次打开是干净的 */
    useEffect(() => {
        if (!open) {
            setPhase('idle')
            setQrcode(null)
            setStatus('')
            done.current = false
            return
        }
        done.current = false
        void generate()
    }, [open, generate])

    /* 轮询：只在有码、且还没出终态时跑 */
    useEffect(() => {
        if (!open || !qrcode) return
        if (phase !== 'waiting' && phase !== 'scanned') return

        let timer: number | undefined
        let stopped = false

        const tick = async () => {
            try {
                const r = await api.biliQrPoll(qrcode.key)
                if (stopped || !alive.current) return
                if (r.loggedIn) {
                    setPhase('ok')
                    setStatus(r.message || '登录成功')
                    if (!done.current) {
                        done.current = true
                        onToast?.('B 站登录成功', 'ok')
                        /* 让用户看见「成功了」再关，别一成功就闪掉 */
                        window.setTimeout(() => {
                            if (alive.current) {
                                onLoggedIn()
                                onClose()
                            }
                        }, 900)
                    }
                    return
                }
                /* 86038 = 二维码失效。这时候再轮询下去也没意义，等用户点「换个二维码」 */
                if (r.code === 86038) {
                    setPhase('expired')
                    setStatus(r.message || '二维码已失效，点「换个二维码」重来')
                    return
                }
                /* 86090 = 扫到了、等手机确认。界面跟着后端的话走，别自己编 */
                setPhase(r.code === 86090 ? 'scanned' : 'waiting')
                setStatus(r.message)
            } catch (e) {
                if (stopped || !alive.current) return
                /* 单轮失败**不结束**轮询：网络抖一下就放弃的话，用户得自己重开弹窗。
                   把话摆在界面上，下一轮继续问。 */
                setStatus(`轮询失败，正在重试：${e instanceof Error ? e.message : String(e)}`)
            }
            if (!stopped) timer = window.setTimeout(() => void tick(), 2000)
        }

        timer = window.setTimeout(() => void tick(), 600)
        return () => {
            stopped = true
            if (timer !== undefined) window.clearTimeout(timer)
        }
    }, [open, qrcode, phase, onClose, onLoggedIn, onToast])

    const showQR = !!qrcode && phase !== 'expired'

    return (
        <Dialog
            open={open}
            onOpenChange={(o) => !o && onClose()}
            title="扫码登录 B 站"
            description="登录只是为了解锁 1080P+ 与大会员画质"
        >
            <div className="qr-login">
                <div className="qr-box">
                    {showQR ? (
                        /* ⚠️ 二维码**必须白底黑块**：它是给手机摄像头看的，跟着暗色主题走会扫不出来。
                           `.qr-box` 也是固定白底，两处颜色都写死，别改成主题令牌。
                           `marginSize` 给 1（默认 0）：留一点白边，摄像头更容易定位。 */
                        <QRCodeSVG
                            value={qrcode.url}
                            size={168}
                            marginSize={1}
                            bgColor="#ffffff"
                            fgColor="#000000"
                            title="B 站登录二维码"
                        />
                    ) : (
                        <div className="qr-placeholder">
                            <span>{phase === 'error' ? '二维码没申请到' : '正在申请二维码…'}</span>
                            {phase === 'expired' && <span>二维码已失效</span>}
                        </div>
                    )}
                </div>

                <p className="qr-status">{status}</p>
                <p className="hint">
                    手机上用 B 站 App 扫这个码、点确认即可。想退出在设置页点「退出登录」。
                </p>

                <div className="dir-actions">
                    <span className="spacer"/>
                    <Button size="sm" disabled={busy} onClick={() => void generate()}>
                        换个二维码
                    </Button>
                    <Button size="sm" variant={phase === 'ok' ? 'primary' : 'default'} onClick={onClose}>
                        {phase === 'ok' ? '完成' : '关闭'}
                    </Button>
                </div>
            </div>
        </Dialog>
    )
}
