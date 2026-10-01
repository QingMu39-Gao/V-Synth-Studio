import type { AppState } from '@/lib/types'

/**
 * 页面组件的统一 props —— **每个页面都从 `App.tsx` 拿这些，不要自己去 `api.state()`**。
 *
 * 为什么要统一：状态只有一份来源（App 启动时拉一次 `/api/state`），
 * 页面各自再拉一次就会出现「总览显示 2/2 个工具、音频页显示 1/2」这种自相矛盾的画面。
 * 页面需要刷新时调 `onRefreshState()`。
 */
export type ToastTone = 'ok' | 'err' | 'warn' | 'info'

export interface PageProps {
  /** 后端快照；首屏可能还是 null（启动画面揭开前后那一小段），页面要给空态 */ 
  state: AppState | null
  /** 切到别的页面（hash 路由，App 负责） */
  onNavigate: (id: string) => void
  /** 改过配置 / 工具后叫它重拉一次 state */
  onRefreshState: () => Promise<void>
  /** 右下角提示。**任何失败都要抛给用户看**，不要静默 */
  onToast: (msg: string, tone?: ToastTone) => void
}
