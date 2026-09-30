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
