/**
 * 揭开启动画面（`index.html` 里那段静态遮罩 `#boot`）。
 *
 * 什么时候调：**App 首次 `/api/state` 落定之后**（成功失败都要调）——
 * 后端要挨个探测 ffmpeg / yt-dlp，通常 2~3 秒，这段时间屏幕上就是它。
 * 失败也要揭：那样用户看到的是「连不上本地服务」那块提示，而不是一个转圈的遮罩
 * （**把人永久卡在加载页是最糟的结果**，所以 `index.html` 里还有一条 12 秒兜底）。
 *
 * 两个细节：
 *  - **最短展示时间**：接口偶尔很快，直接揭会闪一下，比不做还难看。
 *  - **兜底移除**：`transitionend` 万一没来（标签页在后台被节流时真的会），
 *    再用一个定时器强制删节点，不然那层遮罩会永久盖在界面上。
 */

/** 最短展示时长（从模块求值算起；遮罩本身在更早的首屏就画出来了） */
const MIN_VISIBLE_MS = 520
const FADE_MS = 400

const evaluatedAt = performance.now()
let hidden = false

export function hideBoot() {
  if (hidden) return
  hidden = true

  const el = document.getElementById('boot')
  if (!el) return

  const wait = Math.max(0, MIN_VISIBLE_MS - (performance.now() - evaluatedAt))
  window.setTimeout(() => {
    el.dataset.out = 'true' /* 淡出交给 CSS 的 transition */
    el.addEventListener('transitionend', () => el.remove(), { once: true })
    window.setTimeout(() => el.remove(), FADE_MS + 200)
  }, wait)
}
