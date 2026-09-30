import { useCallback, useSyncExternalStore } from 'react'
import { readMaterial, writeMaterial, type GlassMaterial } from '@/components/Glass'

export type { GlassMaterial }

/**
 * 当前的玻璃材质：`frosted`（毛玻璃）/ `liquid`（液态玻璃）。
 *
 * ⚠️ **必须用 `useSyncExternalStore`，不能用 `useState`。**
 * 踩过：钩子里用 `useState`、再被两个组件各调一次，两个组件各拿一份独立 state ——
 * localStorage 改了、DOM 没变，看着就是「切材质没有任何用」。
 * 模块级 store + `useSyncExternalStore` 才是共享的。
 */

const listeners = new Set<() => void>()
let current: GlassMaterial | null = null

function get(): GlassMaterial {
  if (current === null) current = readMaterial()
  return current
}

function set(m: GlassMaterial) {
  if (current === m) return
  current = m
  writeMaterial(m)
  for (const l of listeners) l()
}

function subscribe(cb: () => void) {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

export function useMaterial() {
  const material = useSyncExternalStore(subscribe, get, () => 'liquid' as GlassMaterial)
  const setMaterial = useCallback((m: GlassMaterial) => set(m), [])
  const toggle = useCallback(() => set(get() === 'liquid' ? 'frosted' : 'liquid'), [])
  return { material, setMaterial, toggle }
}

/* ══════════════════════════════════════════════════════════════ 全局玻璃 ══ */

/**
 * 「全局玻璃」开关：内容区的**面板**也当玻璃面（`GlassSurface`）。
 *
 * 关掉就回到换库之后、全局玻璃之前的样子 —— 面板用库的 `MaterialView`
 * （有模糊、有底色，但没有折射、没有高光边），只有栏 / 侧栏 / 控件是玻璃。
 * 那一版在 `git tag backup-pre-global-glass`。
 *
 * ⚠️ **这个开关只影响面板材质，不动背景参数**（`--bg-blur` / `--bg-dim` /
 * `--bg-contrast` / `--bg-veil` 在 `index.css` 里，两档共用一套）。
 *
 * 和 `useMaterial` 一样必须用 `useSyncExternalStore`：两个组件各存一份 state 的话，
 * localStorage 改了、界面不动（那个坑踩过）。
 */

const GG_KEY = 'qingmu.globalGlass'
const ggListeners = new Set<() => void>()
let ggCurrent: boolean | null = null

function ggGet(): boolean {
  if (ggCurrent === null) {
    try {
      ggCurrent = localStorage.getItem(GG_KEY) !== 'off'
    } catch {
      ggCurrent = true /* 隐私模式：用默认值 */
    }
  }
  return ggCurrent
}

function ggSet(on: boolean) {
  if (ggCurrent === on) return
  ggCurrent = on
  try {
    localStorage.setItem(GG_KEY, on ? 'on' : 'off')
  } catch {
    /* 隐私模式：本次会话仍然生效 */
  }
  for (const l of ggListeners) l()
}

function ggSubscribe(cb: () => void) {
  ggListeners.add(cb)
  return () => {
    ggListeners.delete(cb)
  }
}

export function useGlobalGlass() {
  const globalGlass = useSyncExternalStore(ggSubscribe, ggGet, () => true)
  const setGlobalGlass = useCallback((v: boolean) => ggSet(v), [])
  return { globalGlass, setGlobalGlass }
}
