import {StrictMode} from 'react'
import {createRoot} from 'react-dom/client'
import {getCurrentWindow} from '@tauri-apps/api/window'

import './index.css'
import './components/ui.css'

import App from './App'
import {ensureConfig} from './lib/config'

const root = document.getElementById('root')
if (!root) throw new Error('找不到 #root 挂载点')

/*
 * 窗口在 `tauri.conf.json` 里 `visible: false`，等 `get_config` 落定后再显示，
 * 避免第一帧用默认主题闪一下。超时兜底是必需的：后端卡死时窗口不能永远不可见。
 * `show()` 要 `core:window:allow-show` 权限（见 `capabilities/default.json`）。
 */
const REVEAL_TIMEOUT_MS = 6000
let revealed = false

function reveal() {
    if (revealed) return
    revealed = true
    createRoot(root as HTMLElement).render(
        <StrictMode>
            <App/>
        </StrictMode>,
    )
    /* ⛔ 不能用 `requestAnimationFrame` 等一帧再显示：窗口不可见时不参与合成，
       rAF 回调不会触发，`show()` 就永远等不到。 */
    void getCurrentWindow().show()
}

window.setTimeout(reveal, REVEAL_TIMEOUT_MS)
void ensureConfig()
    .catch(() => {
    })
    .then(reveal)
