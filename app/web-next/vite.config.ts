import { defineConfig } from 'vite'
import type { Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath, URL } from 'node:url'

/**
 * ⚠️ **为什么需要这个插件：lightningcss 会删掉标准的 `backdrop-filter`。**
 *
 * Vite 8（rolldown 版）用 lightningcss 压缩 CSS，它按浏览器目标自动裁剪厂商前缀。
 * 这个项目里它**裁错了**：把标准属性 `backdrop-filter` 删掉、只留
 * `-webkit-backdrop-filter`。而 WebView2 / Chromium **只认标准属性名**：
 *
 *     CSS.supports('backdrop-filter','blur(1px)')         → true
 *     CSS.supports('-webkit-backdrop-filter','blur(1px)') → false
 *
 * 于是库的样式表里明明写着 `backdrop-filter: blur(30px)`，
 * 浏览器里 `getComputedStyle` 却报 `none`，内容面板变成一片不透明的底色。
 * **查源码怎么查都是对的 —— 问题只在构建产物里**，这类 bug 极难自查。
 * （当时顶栏和侧栏还是糊的，因为库给它们走的是 CSS 变量 `--lg-backdrop`，
 *   那条没被改前缀，所以只有内容面板坏掉，很容易误判成「设计如此」。）
 *
 * 试过、**都不行**的办法（别再试一遍）：
 *   - `build.target: 'chrome120'`     → 管不到 CSS 这一步
 *   - `css.lightningcss.targets`      → 无效（实测产物里标准版仍是 0 处）
 *   - `build.cssMinify: 'esbuild'`    → Vite 8 不再自带 esbuild，直接构建失败
 *   - `build.cssMinify: false`        → 有效，但产物从 120KB 涨到 220KB（+100KB）
 *
 * 实测确认**只有 `backdrop-filter` 这一个属性被删错**
 * （`-webkit-mask-composite`、`-webkit-user-drag`、`-webkit-tap-highlight-color`
 * 的标准版本来就不存在，不需要补）。
 *
 * 所以：保留默认压缩（体积不变），只把这一条补回去。
 * `enforce: 'post'` + `generateBundle` 保证跑在压缩**之后**。
 */
function restoreStandardBackdropFilter(): Plugin {
  return {
    name: 'restore-standard-backdrop-filter',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type !== 'asset' || !file.fileName.endsWith('.css')) continue
        const src =
          typeof file.source === 'string' ? file.source : new TextDecoder().decode(file.source)
        /**
         * 按**声明块**处理，块里已经有标准 `backdrop-filter` 就整块跳过。
         *
         * 两个必须注意的点，都是实测踩出来的：
         *
         * 1. **不能整文件盲目替换。** 库里有 `[data-transparency="opaque"]` 这类规则，
         *    原本就是 `-webkit-backdrop-filter:none`（故意关掉模糊的）。
         *    复制成标准属性没错，但如果**插错位置**就会把别的规则弄坏 ——
         *    第一版写到 `var()` 声明前面去，于是 `.lg-backdrop`（玻璃面自己的模糊，
         *    走 `backdrop-filter:var(--lg-backdrop,…)`）变成先 `none` 再 `var(...)`，
         *    **玻璃面直接失去模糊**（实测顶栏 `backdrop=none`）。
         *
         * 2. **负向后顾 `(?<![\w-])` 是必须的。** 库里有自定义属性
         *    `--lg-backdrop`，它的名字以 `backdrop-filter` 结尾；不加后顾
         *    会把 `--lg-backdrop:` 也当成属性来插，产出一堆垃圾。
         *
         * 按 `{...}` 分块 + 检查块内是否已有标准属性，两个问题一起解决：
         * 只在「有前缀版、没标准版」的块里补，且插在该前缀版**前面**。
         */
        const fixed = src.replace(/\{[^{}]*\}/g, (block) => {
          if (/(?<![\w-])backdrop-filter\s*:/.test(block)) return block
          return block.replace(
            /(?<![\w-])-webkit-backdrop-filter\s*:\s*([^;}]+)/g,
            (whole, value) => `backdrop-filter:${value};${whole}`,
          )
        })
        if (fixed === src) continue
        const added = (fixed.match(/(?<!-)\bbackdrop-filter\s*:/g) ?? []).length
        this.warn(`补回标准 backdrop-filter：${file.fileName}（共 ${added} 条）`)
        file.source = fixed
      }
    },
  }
}

export default defineConfig({
  /*
   * 根路径。旧前端（`app/web/index.html` + `js/` + `css/`）已在 2026-10-05 整体退役，
   * 现在是**唯一**的界面 —— exe 加载 `http://127.0.0.1:<port>/`，直接就是这里。
   */
  base: '/',
  plugins: [react(), tailwindcss(), restoreStandardBackdropFilter()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    /*
     * 产物直接落 `app/web/`（Rust 后端伺服的目录，见 server/simple.rs::web_dir）。
     * 产物只占 `index.html` + `assets/`，目录里另有 `vendor/`（JIZURA，PV 页 iframe 用）
     * 与 `img/`（logo 与两张背景图）是**随包分发的静态资源、不是构建产物**：
     *
     *   ⚠️ 所以 `emptyOutDir` 必须是 false —— 打开它 Vite 会把 vendor/ 和 img/
     *      一起清掉，PV 页和背景图当场失效，而且因为构建「成功」了，很难往这上面想。
     */
    outDir: '../web',
    emptyOutDir: false,
    // 内嵌 WebView 场景，体积比极致拆包更重要 —— 目标机器全离线，
    // 少文件少请求比多 chunk 划算。
    chunkSizeWarningLimit: 1500,
  },
})
