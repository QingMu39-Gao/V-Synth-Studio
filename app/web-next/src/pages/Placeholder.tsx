import { Button } from '@/components/Button'
import { Panel } from '@/components/Panel'

/**
 * 未迁移页面的占位。
 *
 * 刻意**不假装能用**：明确写「还没搬过来」，并告诉用户旧前端在哪。
 * 迁移期间两套前端并存（见 AGENTS.md 第十一节），旧前端在 `/` 上功能完整。
 */
export function Placeholder({ title }: { title: string }) {
  return (
    <Panel>
      <div className="empty">
        <h2 className="panel-title">「{title}」还没搬过来</h2>
        <p className="muted">这一页仍在旧前端里跑。新前端一页页搬，搬完一页就会出现在这里。</p>
        <Button variant="primary" onClick={() => window.open('/', '_blank')}>
          在新标签打开旧界面
        </Button>
      </div>
    </Panel>
  )
}
