import { useCallback, useSyncExternalStore } from 'react'
import { readMaterial, type GlassMaterial } from '@/components/Glass'

export type { GlassMaterial }

/**
 * **玻璃等级 1~3** —— 一个滑块管住原来三个开关：
 *
 * | 等级 | 名字 | 材质 | 透明度 | 内容面板 |
 * |---|---|---|---|---|
 * | 1 | 关 | — | `opaque`（库画不透明底、不做模糊） | 不是玻璃（`MaterialView`） |
 * | 2 | 毛玻璃 | `regular` | `system` | 玻璃 |
 * | 3 | 液态玻璃 | `clear` + 折射 | `system` | 玻璃 |
 *
 * 原来的「液态/毛玻璃」两张选项卡、「全局玻璃」勾选框、「降低透明度」勾选框
 * 各自管一件事，用户看到的是三个互相影响的开关。合成一档之后语义才清楚：
 * **级别越高越「玻璃」，代价也越大。**
 *
 * ⚠️ **必须用 `useSyncExternalStore`，不能用 `useState`。**
 * 踩过：钩子里用 `useState`、再被两个组件各调一次，两个组件各拿一份独立 state ——
 * localStorage 改了、DOM 没变，看着就是「改了没有任何用」。
 */
export type GlassLevel = 1 | 2 | 3

export const GLASS_LEVELS: { level: GlassLevel; label: string; desc: string }[] = [
  {
    level: 1,
    label: '关',
    desc: '不透明底色，不做模糊。文字对比最高，低端机、远控桌面选这档',
  },
  { level: 2, label: '毛玻璃', desc: '只模糊提色，不折射。安静、可读性最好，开销低' },
  { level: 3, label: '液态玻璃', desc: '边缘把背后的内容折弯，带轻微色差。开销约为毛玻璃的三倍' },
]

/** 等级 → 库的材质参数 */
export function levelMaterial(level: GlassLevel): GlassMaterial {
  return level === 3 ? 'liquid' : 'frosted'
}

/** 等级 → 库的透明度策略（1 级走 `opaque`：库会关掉模糊、改画不透明底） */
export function levelTransparency(level: GlassLevel): 'opaque' | 'system' {
  return level === 1 ? 'opaque' : 'system'
}

/** 等级 → 内容区的面板要不要玻璃面（1 级退回 `MaterialView`） */
export function levelGlobalGlass(level: GlassLevel): boolean {
  return level > 1
}

const LEVEL_KEY = 'qingmu.glassLevel'
const listeners = new Set<() => void>()
let current: GlassLevel | null = null

function readLevel(): GlassLevel {
  try {
    const raw = localStorage.getItem(LEVEL_KEY)
    if (raw === '1' || raw === '2' || raw === '3') return Number(raw) as GlassLevel
    /* 迁移：老版本把这件事拆成两个键（`qingmu.globalGlass` + `qingmu.glass`），
       老用户已经选过的不要丢。 */
    if (localStorage.getItem('qingmu.globalGlass') === 'off') return 1
    return readMaterial() === 'liquid' ? 3 : 2
  } catch {
    return 2 /* 隐私模式：用默认档 */
  }
}

function get(): GlassLevel {
  if (current === null) current = readLevel()
  return current
}

function set(level: GlassLevel) {
  if (current === level) return
  current = level
  try {
    localStorage.setItem(LEVEL_KEY, String(level))
  } catch {
    /* 隐私模式：本次会话仍然生效 */
  }
  for (const l of listeners) l()
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function useGlassLevel() {
  const level = useSyncExternalStore(subscribe, get, () => 2 as GlassLevel)
  const setLevel = useCallback((l: GlassLevel) => set(l), [])
  return { level, setLevel }
}

/* ── 下面两个是给不认识「等级」的地方用的派生值 ───────────────────── */

/** 材质（`components/Glass.tsx` 按它取折射参数） */
export function useMaterial() {
  return { material: levelMaterial(useGlassLevel().level) }
}

/** 内容面板要不要玻璃面（`components/Panel.tsx`） */
export function useGlobalGlass() {
  return { globalGlass: levelGlobalGlass(useGlassLevel().level) }
}
