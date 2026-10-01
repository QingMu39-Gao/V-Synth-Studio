import { useCallback, useEffect, useState } from 'react'
import { GlassDialog, PathBar, List, ListSection, ListRow } from '@ttqtt/liquid-glass-react'
import { Button } from '@/components/Button'
import { api, type FsEntry } from '@/lib/api'

/**
 * 目录选择器 —— 旧前端 `components/dirPicker.js` 的对应物，但**建在库的组件上**：
 * `GlassDialog`（真正的 `<dialog>`，自带 Esc/焦点陷阱）+ `PathBar`（面包屑）+ `List`。
 *
 * 用法（受控）：
 * ```tsx
 * const [picking, setPicking] = useState(false)
 * <Button onClick={() => setPicking(true)}>选择目录</Button>
 * <DirPicker open={picking} onOpenChange={setPicking} onPick={(p) => setOutDir(p)} />
 * ```
 *
 * 后端接口：`/api/fs/roots`（盘符/主目录）、`/api/fs/list?path=&files=0`（只列目录）、
 * `/api/fs/mkdir`（新建文件夹）。**只选目录**，选文件走 `fsList(..., { files: true, exts })`。
 */
export function DirPicker({
  open,
  onOpenChange,
  onPick,
  title = '选择目录',
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onPick: (path: string) => void
  title?: string
}) {
  const [cwd, setCwd] = useState('')
  const [entries, setEntries] = useState<FsEntry[]>([])
  const [roots, setRoots] = useState<{ label: string; path: string }[]>([])
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async (path: string) => {
    setBusy(true)
    setErr(null)
    try {
      const data = await api.fsList(path, { files: false })
      setCwd(data.path)
      setEntries(data.entries)
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }, [])

  /* 打开时回到后端给的默认根；每次打开都重取，别缓存上一轮的目录树 */
  useEffect(() => {
    if (!open) return
    api
      .fsRoots()
      .then((d) => {
        setRoots(d.roots)
        void load('')
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }, [open, load])

  const segments = cwd
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .filter(Boolean)

  return (
    <GlassDialog
      open={open}
      onOpenChange={onOpenChange}
      title={title}
      /* 库要求给一句说明（读屏会念出来，不是装饰） */
      description="点进子目录，然后选「就选这里」"
      className="dir-dialog"
    >
      <div className="dir-body">
        <PathBar
          aria-label="所在路径"
          items={[
            { key: 'root', label: '此电脑', onSelect: () => void load('') },
            ...segments.map((seg, i) => ({
              key: seg + i,
              label: seg,
              /* 最后一级没有 onSelect —— 库的注释：当前项不是链接，是你已经在的地方 */
              onSelect:
                i === segments.length - 1
                  ? undefined
                  : () => void load(segments.slice(0, i + 1).join('\\')),
            })),
          ]}
        />

        {roots.length > 0 && (
          <List className="dir-roots">
            {roots.map((r) => (
              <ListRow key={r.path} label={r.label} secondaryLabel={r.path} onSelect={() => void load(r.path)} />
            ))}
          </List>
        )}

        <List>
          <ListSection header={busy ? '读取中…' : `${entries.length} 个子目录`}>
            {entries.map((e) => (
              <ListRow
                key={e.path}
                label={e.name}
                disclosure
                onSelect={() => void load(e.path)}
              />
            ))}
            {!busy && entries.length === 0 && <ListRow label="（没有子目录）" disabled />}
          </ListSection>
        </List>

        {err && <p className="finding-text">{err}</p>}
        {/* 大目录的 size/mtime 只在选文件时才有意义，这里不显示；列一下当前路径给用户核对 */}
        <p className="dir-note">当前：{cwd || '（未选择）'}</p>
      </div>

      <div className="dir-actions">
        <Button
          size="sm"
          onClick={async () => {
            const name = window.prompt('新建文件夹的名字')
            if (!name) return
            try {
              const r = await api.fsMkdir(cwd ? `${cwd}\\${name}` : name)
              await load(cwd)
              void r
            } catch (e) {
              setErr(e instanceof Error ? e.message : String(e))
            }
          }}
        >
          新建文件夹
        </Button>
        <span className="spacer" />
        <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>
          取消
        </Button>
        <Button
          size="sm"
          variant="primary"
          disabled={!cwd}
          onClick={() => {
            onPick(cwd)
            onOpenChange(false)
          }}
        >
          就选这里
        </Button>
      </div>
    </GlassDialog>
  )
}

/** 目录输入框 + 「选择」按钮 —— 表单里最常见的一格 */
export function DirectoryInput({
  value,
  onChange,
  placeholder = '留空则用设置里的默认目录',
}: {
  value: string
  onChange: (v: string) => void
  placeholder?: string
}) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <div className="input-group">
        <input
          className="input"
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        <Button size="sm" onClick={() => setOpen(true)}>
          选择
        </Button>
        {value && (
          <Button size="sm" variant="ghost" onClick={() => onChange('')}>
            清空
          </Button>
        )}
      </div>
      <DirPicker open={open} onOpenChange={setOpen} onPick={onChange} />
    </>
  )
}


