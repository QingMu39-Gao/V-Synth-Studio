import { useEffect, useLayoutEffect, useRef } from 'react'

/**
 * 让库的**滑动高亮块**落在当前选中的那一行上。
 *
 * 主侧栏（`App.tsx`）和设置页的小节导航（`pages/Settings.tsx`）都用它 ——
 * 两处的结构必须一致才复用得了：
 *
 * ```
 * <nav class="app-nav" ref={navRef}>                       ← position: relative，量位置拿它当基准
 *   <span class="lg-selection-lens nav-lens" ref={lensRef} />
 *   <button class="nav-row" aria-current="page">…</button>  ← 选中项必须标 aria-current
 * </nav>
 * ```
 *
 * 三个坑（都是量位置量出来的）：
 *  1. **首帧不能滑**：第一次量完把 `transition` 关掉、强制回流再恢复，
 *     否则打开界面会看到一个方块从左上角飞过来。
 *  2. **用 `offsetTop`，不用 `getBoundingClientRect()`**：父容器滚动后 rect 会偏，
 *     `offsetTop` 相对 offsetParent 恒定（前提是 nav 上有 `position: relative`）。
 *  3. **挤压只改喂进 `transform` 的变量**：另起一条 animation 会把 `transform`
 *     整个接管，过渡就不生效了（表现是「瞬移」，踩过）。
 */
export function useNavLens(
  navRef: React.RefObject<HTMLElement | null>,
  lensRef: React.RefObject<HTMLSpanElement | null>,
  active: string,
) {
  const placed = useRef(false)

  useLayoutEffect(() => {
    const nav = navRef.current
    const lens = lensRef.current
    if (!nav || !lens) return
    const place = () => {
      const row = nav.querySelector<HTMLElement>('.nav-row[aria-current="page"]')
      const first = !placed.current
      if (first) lens.style.transition = 'none'
      if (row && row.offsetWidth) {
        lens.style.width = `${row.offsetWidth}px`
        lens.style.height = `${row.offsetHeight}px`
        lens.style.setProperty('--lg-slot-x', `${row.offsetLeft}px`)
        lens.style.setProperty('--lg-slot-y', `${row.offsetTop}px`)
        lens.style.setProperty('--lg-lens-shown', '1')
        placed.current = true
      } else {
        lens.style.setProperty('--lg-lens-shown', '0')
      }
      /* 强制这一帧就落位（趁过渡还关着），再把它放回去 */
      if (first) {
        void lens.offsetWidth
        lens.style.transition = ''
      }
    }
    place()
    const observer = new ResizeObserver(place)
    observer.observe(nav)
    return () => observer.disconnect()
  }, [navRef, lensRef, active])

  /** 滑动时挤压一下。只改**一个**喂进 `transform` 的变量，没有第二条动画去抢 transform。 */
  const last = useRef<string | null>(null)
  useEffect(() => {
    const nav = navRef.current
    if (last.current === null) {
      last.current = active
      return
    }
    last.current = active
    if (!nav) return
    nav.dataset.moving = 'true'
    const timer = setTimeout(() => delete nav.dataset.moving, 180)
    return () => {
      clearTimeout(timer)
      delete nav.dataset.moving
    }
  }, [active, navRef])
}