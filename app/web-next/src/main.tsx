import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

/**
 * 样式表顺序**不能改**：
 *   1. 库自己的 token + 组件样式（`tokens.css` + `components.css` 拼成，约 197KB）
 *   2. 我们的外壳样式（只排布局，**没有一行玻璃**）
 *
 * 库的 token（`--lg-label` / `--lg-bg` / `--lg-space-*` / `--lg-radius-*` …）
 * **全部挂在 `[data-lg-theme="light|dark"]` 下**，`:root` 上没有裸定义 ——
 * 所以必须引它，否则我们的 `var(--lg-*)` 全解析不出来。
 *
 * README 的要求：「样式表在应用入口引一次就够了。」
 */
import '@ttqtt/liquid-glass-react/style.css'
import './index.css'

import App from './App'

const root = document.getElementById('root')
if (!root) throw new Error('找不到 #root 挂载点')

createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
