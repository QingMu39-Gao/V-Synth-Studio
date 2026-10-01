# 踩坑史与取舍（`AGENTS.md` 第六节的外移部分）

> 这份记的是**为什么**：当时是什么症状、怎么定位的、改了什么、还留下什么。
> AGENTS.md 第六节只保留结论速查；要动相关代码之前，来这里看细节。
> 玻璃材质本身的规范在 docs/GLASS-HANDOFF.md；新前端约定在 docs/NEXT-UI.md。

---

### CSS

- **`html::after` 做背景层会渲染到内容之上**（Chromium 对 `backdrop-filter` 采样
  `position:fixed` 伪元素的怪癖）。背景层要做成 `body` 内的普通元素。
- **`--glass` 系列令牌（4.5% 白）是给纯色背景设计的**，一旦有背景图就全透、文字没法看。
  有背景图时这些值要单独调。

### 悬停动效：微交互和大位移要用不同的曲线

**改动效前先做这一步检查 —— 未定义的 CSS 变量会让整条声明静默失效：**

```powershell
# 列出「被 var() 引用、但没有任何地方定义」的变量
$t = [IO.File]::ReadAllText((Get-ChildItem app\web\next\assets\*.css | Select-Object -First 1).FullName, [Text.Encoding]::UTF8)
$defined = [regex]::Matches($t, '(--[\w-]+)\s*:') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
$used = [regex]::Matches($t, 'var\((--[\w-]+)') | ForEach-Object { $_.Groups[1].Value } | Sort-Object -Unique
$used | Where-Object { $defined -notcontains $_ }
```

（Tailwind 内部那几个 `--default-*` 变量属正常，可忽略。）

**踩过的两个坑，都是「动效很奇怪」的真因：**

1. **`var(--ease)` 以前根本没定义。** 于是 `transition: background var(--ease)`
   **整条声明失效** → 悬停时底色是瞬变、没有过渡，看着就是生硬地闪一下。
   浏览器不会报错，控制台一片安静。
2. **`--spring`（y 控制点 1.56，过冲 56%）被拿去驱动 `scale(0.97)`。**
   过冲量是按**大位移**设计的：位移越小，过冲占比越夸张。
   0.97 只该走 0.03，却先弹过头再回来 —— 看着就是在抖。

**现在的分工**（⚠️ **两套前端各有一套曲线，别互相套用**）：

| 前端 | 令牌与取值 | 说明 |
|---|---|---|
| 旧前端 `/` | `--ease: cubic-bezier(0.32, 0.72, 0, 1)`<br>`--ease-out: cubic-bezier(0.16, 1, 0.3, 1)`<br>`--spring: cubic-bezier(0.34, 1.56, 0.64, 1)` | 定义在 `app/web/css/base.css:129-131`，**唯一一处** |
| 新前端 `/next/` | **没有自己的缓动令牌** | 曲线来自库：`--lg-duration-spring: 520ms` + `--lg-spring`（一条 `linear()` 弹簧采样），`--lg-duration-press/release/layout` 分级。写在库的 `dist/tokens.css`，改不了也不用改 |

⚠️ **本节此前那两版取值都是错的**（`(.4,0,.2,1)` / `(0.2,0.9,0.25,1)` / `--spring: 1.28`
这些数字**在代码里一个都不存在**）：那是新前端换库之前的手写玻璃时代的令牌，
换库时连同手写玻璃一起删了，但文档没跟着改。**看到数字先 `grep` 一遍再照抄。**

**位移规矩**（用户报过「鼠标放上去动效很奇怪」）：

| 元素 | 悬停 | 按压 |
|---|---|---|
| 控件（按钮 / 导航项 / 标签） | **只改底色**，不动 | `scale(0.97)`，80ms |
| 大卡片（入口卡） | `translateY(-2px)`，220ms | `scale(0.995)`，100ms |

**验证方法**（必须看渲染结果，不能只看源码）：

```js
// 旧前端：读令牌本身有没有被解析出来（未定义的话整条 transition 会静默失效）
getComputedStyle(document.querySelector('.nav-item')).transitionTimingFunction
// 新前端：微交互的曲线应当来自库（出现 1.56 这类过冲曲线基本就是用错地方了）
getComputedStyle(document.querySelector('.quick')).transition.replace(/\s+/g, ' ')
```

### 侧栏导航：一个框 + 一个滑动的高亮块

**用户的原话**：「侧边栏被分成了三大板块，不要这么做」「每个选项都被框起来了，
我希望只有一个框」「选中某个选项时在该选项上再套一个框」「切换选项时选择框应该
丝滑地滑动过去」。

**改前的错**：每个导航项各带 `glass-chip` —— 于是 8 个选项**各自**被描边 + 底色框住，
再加上 `.glass-sheen` 每次切换还有一道 720ms 斜光扫过。视觉上就是一堆小方块。

**现在的结构**（`App.tsx` 的导航 + `index.css` 的 `.app-nav` 一组；设置页同款）：

```
GlassPanel.app-sidebar        ← **唯一**的框（一层玻璃 + 一条描边 + 一个圆角）
  └ div.app-sidebar-inner
      └ nav.app-nav           ← position: relative（量位置要拿它当基准）
          ├ span.lg-selection-lens.nav-lens  ← 高亮块，**库的组件**，靠 --lg-slot-x/y 滑
          ├ div.nav-group × 3 ← 只是小字，**不参与框选**
          └ button.nav-row × 8 ← 完全透明，自身零描边零底色
```

⚠️ 本节曾写的 `.nav-rail` / `.nav-thumb` 等类名在仓库里零命中（换库前的手写玻璃时代遗留）。

⚠️ **设置页那条小节导航是同一套东西**（`lib/useNavLens.ts` + `.app-nav` / `.nav-row` /
`.nav-lens`，外框参数与主侧栏逐项相同）—— 改主侧栏的样式会同时改到它。

**「丝滑」是靠 transform，不是给每项加背景色**：量出选中项相对 nav 的 `offsetTop`，
写进库的 `--lg-slot-y`，那块 span 自己 `translate` 过去 —— 合成层动画，不触发布局重排。

**三个必须注意的点（都会导致可见的 bug，逐条实测过）：**

1. **首帧不能滑。** 第一次量位置时先把 `transition` 关掉，量完 `void lens.offsetWidth`
   强制回流再恢复；否则打开界面会看到一个方块从左上角飞过来。
   （`lib/useNavLens.ts` 就是这么写的，探针里 `boot.settled` 那条在验它。）
2. **量位置用 `offsetTop`，不用 `getBoundingClientRect()`。** 侧栏是滚动的，
   滚动后 rect 会偏；`offsetTop` 相对 offsetParent 恒定。前提是 nav 上有 `position: relative`
   —— 而库的 `.lg-content` 本身就是 `position: relative`，所以 nav 必须是最近的那个。
3. **高亮块是绝对定位，`.nav-row` 必须显式 `position: relative; z-index: 1`** ——
   `z-index` 只对定位元素生效，漏了行就会被高亮块盖住。

**验证方法**（这三条就是用户提的三个要求，逐条可测；`tests/manual/glass-probe.mjs` 已实现）：

```js
// ① 只有面板一个框：自带描边的导航项必须是 0
[...document.querySelectorAll('.nav-row')].filter(r => parseFloat(getComputedStyle(r).borderTopWidth) > 0).length
// ② 高亮块只有一个，且和选中项零偏差（实测 dx/dy/dw/dh 全 0）
document.querySelectorAll('.app-nav .lg-selection-lens').length
// ③ 切换时逐帧采样，不同取值要多于 3 个 —— 只有 1~2 个说明是直接跳过去的
//    （在 rAF 循环里读 getComputedStyle(lens).transform，探针实测 30+ 种）
```

⚠️ **写验证脚本时注意**：别用 `[regex]::IsMatch` 去查类名如 `duration-[280ms]` ——
`[280ms]` 会被当成字符类，永远匹配不到，会让你误判成「类没编译出来」。
查产物里的类名请用 `IndexOf` 或先 `[regex]::Escape()`。

### 动效（历史教训，一句话版）

「像直线」的根因是用了 `cubic-bezier(0.4, 0, 0.2, 1)`（加速太平缓，短位移看不出加减速）；
「甩过头」的根因是过冲量贪大（`--spring` 的 y 控制点 1.42 → 300px 位移冲出 42px）。
**两套前端各自的分工见上面那张表**，别互相套用。旧前端唯一一处定义在
`app/web/css/base.css:129-131`。

### 侧栏滑动高亮块：**为什么现在不需要分两层了**

用户当时要「切换时选择框丝滑地滑动过去」+「滑动时缩放」。

**上一版分两层是被迫的**（`.nav-thumb-track` 做位移 + `.nav-thumb-squash` 做挤压）：
`animation` 在层叠里**优先于 `transition`**，同一元素上一边过渡位移、一边动画缩放，
动画会把 `transform` 整个接管，过渡完全不生效 —— 实测表现是**瞬移过去**。
当时试过两种时序技巧（错开一帧、错开 50ms）都不行，只能拆两层。

**现在不用拆了**，因为挤压不再用 `animation`，而是改**一个喂进 `transform` 的变量**：

```css
.app-nav[data-moving='true'] .lg-selection-lens { --lg-lens-swell-y: 0.86; --lg-lens-swell-x: 1.02; }
```

位移和挤压落在**同一条** `transform` 上（库自己就是这么合成的），
所以没有第二个东西去抢它 —— 两层是为绕开冲突而付的复杂度，冲突没了就不该留着。

**还踩过一个（结论仍然有效）**：挤压最初写的是 `scale: 1 0.86`（独立的 `scale` 属性）。
Chromium 里 `scale` 和 `transform` 是**两个独立属性**，动 `scale` 时 `transform` 矩阵不变，
而过渡挂在 `transform` 上 —— 实测 `scale` 全程恒为 1，**完全没有形变**。
必须走 `transform`（或像现在这样喂进库的合成链）。

**验证方法**（逐帧采样，别只看声明）：

```js
// 不同取值要 >3 种（不然是跳变）；探针实测切换时有 30+ 种
// 在 rAF 循环里读 getComputedStyle(lens).transform
```

### 苹果式圆角：用 `corner-shape: squircle`，别用 SVG

用户反馈「圆角不够美观，能参考苹果的 r 角吗」。

普通 `border-radius` 画的是**圆弧** —— 直线到圆弧的曲率变化是**突变**的，
放大能看出「直边突然接上一段圆」，这就是它显得生硬的原因。
苹果用的是 **squircle**（超椭圆、连续曲率）：曲率从直线平滑过渡到圆角。

**CSS 现在能直接表达，不用 SVG、不用 clip-path**（`app/web-next/src/index.css` 里已加回）：

```css
@supports (corner-shape: squircle) {
  :where(.panel, .quick, .choice, .tool-list, .finding, .toast,
         .btn, .input, .textarea, .chip, .seg, .seg-item, .nav-row, .nav-lens) {
    corner-shape: squircle;
  }
}
```

本机实测 `CSS.supports('corner-shape','squircle') === true`（Chromium 151）。
**必须配 `@supports` 兜底**（不支持的会忽略整条声明、保持圆弧，是安全降级）。

⚠️ **别把它用在玻璃面上。** 库的折射位移贴图是受限的圆角矩形 / 胶囊几何
（它自己的 `known-limitations.md` 写着），画成 squircle 就对不上、边缘会错位。
所以只给内容层和控件用 —— 这些没有 SVG 滤镜跟着。
实测确认：`.btn` / `.lg-material-view` 的计算值是 `squircle`，
玻璃面（`.app-sidebar`）保持 `round`，这是**有意**的。

⚠️ **半径刻度归库管，不归 Tailwind 管**（这一节原先写的是 Tailwind 的 `--radius-*`
工具类，那套已经不用了）：库的刻度是 `--lg-radius-xs/s/m/l/xl/xxl` = 6 / 10 / 14 / 20 / 26 / 34。
本机前端里**只有一个地方写死了半径**：`.nav-row` 与 `.nav-lens` 的 `14px`
（= 面板 26 − 内边距 12，同心），其余一律走 `var(--lg-radius-*)`。

**验证方法**（光看 CSS 看不出来，必须看**渲染结果**）：

```js
// 探针里已实现：玻璃面应当仍是 round，控件/面板才是 squircle
getComputedStyle(document.querySelector('.btn')).getPropertyValue('corner-shape')       // "squircle"
getComputedStyle(document.querySelector('.app-sidebar')).getPropertyValue('corner-shape') // "round"
```

### 液态玻璃接入的坑（rdev 库 —— **已被弃用**）

⚠️ 这一节原本记的是 `rdev/liquid-glass-react` 的 `blurAmount` 公式、`overLight`、
`--panel-scrim` 等。**那个库已经不用了**，参数全部过时，照它改会改错。

现在的库、新的坑、以及两个当前缺陷，见 **`docs/GLASS-HANDOFF.md`**。

---

### ⚠️ 自定义 CSS 必须放进 `@layer components`

> **条件性条目 —— 只有在用 Tailwind 工具类时才成立。** 新前端现在的 `index.css`
> 是**纯手写 CSS**（一个工具类都没有），所以没有分层问题。哪天开始写 `bg-accent` 这类
> 工具类了，这条立刻生效 —— 否则你的裸 CSS 会静默盖掉工具类。

**未分层的 CSS 优先级高于 Tailwind 的 utilities 层。**
踩过：`.glass-chip { background: var(--glass) }` 写在裸 CSS 里，
把同一元素上的 `bg-accent` 工具类**盖掉了** —— 主按钮写了 `bg-accent` 但背景仍是灰的。

所有自定义组件类（`.glass` / `.glass-chip` / `.glass-sheen` / `.lift` / `.nav-*` …）
都要包在 `@layer components { … }` 里。

### 亮色主题的文字对比

亮色的次要文字色**不能太浅**。原来 `--text-3: #98a0b0` 压在浅背景上对比度只有约 2.6:1，
侧栏的「素材获取」「待迁」这类小字几乎看不见。当前值（都在 4.5:1 以上）：

```
--text-0: #14181f   --text-1: #333b4a   --text-2: #525c6e   --text-3: #6b7488
```

主按钮同理：`bg-accent/85` + `text-bg-0` 在亮色下对比崩掉，
改成 `bg-accent`（不透明）+ `text-[#04231f]`（深墨绿）。

### 背景图参数（调过头会导致「图压根不显示」）

**症状**：用户报「背景图压根不显示」，界面是一片纯色。图本身没问题。

**触发过两次，两个前端各一次** —— 改其中一个时记得另一个也要改：

| 前端 | 背景在哪 | 状态 |
|---|---|---|
| 旧前端 `/` | `app/web/css/base.css` 的 `&lt;html&gt;::before`（`--bg-image` / `--bg-blur` / `--bg-veil`） | 已修 |
| 新前端 `/next/` | `app/web-next/src/index.css` 的 `.bg-layer::before`（同名令牌） | 已修 |

⚠️ 新前端第一版**只铺了纯 CSS 渐变、根本没放图**，于是 `backdrop-filter` 明明生效却
看不出毛玻璃（纯色底上模糊与不模糊一模一样）。修旧前端时漏了新前端，用户又报了一次。

### 玻璃通透度（旧前端的令牌；新前端归库管，不用手调）

旧前端 `/` 一组互相抵消的令牌（`--glass` / `--blur-chrome` / `--blur-panel` /
`--bg-veil` / `--bg-blur`）换来两条通用规律：**「通透」靠低不透明度 + 低模糊，不是靠加大模糊**；
**背景看不见时先看玻璃自身的不透明度**，别只调背景。新前端材质由库的 `material` + `size` 决定。

### 亮色背景图与取参（⚠️ 这一节说的是**旧前端** `/`，新前端的值不一样）

`light.jpg` 是浅灰故障艺术图（像素挤在 #d0–#f5），`dark.jpg` 是高对比作品 ——
所以两个主题的取参**方向相反**，旧前端总结出的三条规律仍然成立：

1. **「通透」靠低不透明度 + 低模糊**，不是靠加大模糊。
2. **遮罩（`--bg-veil`）和压暗只能选一个**，两个一起上就彻底没影（实测过三轮）。
3. **背景自身的模糊要小** —— 旧前端当年把 `--bg-blur` 调到 10~14px，
   结果整页糊成奶白、玻璃再糊一次等于没糊（新前端因此定在 3~4px，见 `GLASS-HANDOFF` §2.2）。
   要真正解决观感得换图，参数层面已经到头。

**新前端**（`app/web-next/src/index.css`）现在是：暗色 `blur 4px` / 100% / 118% / veil 30%；
亮色 `blur 5px` / **86%** / 112% / **veil 全撤**。两条硬规矩：

1. **背景自身的模糊必须小（3~5px）** —— 糊过头玻璃就没东西可糊（见上面的三条教训）。
2. **溢出量要跟模糊走**：`body::before { inset: calc(var(--bg-blur) * -2) }`。
   原来是写死的 `-10%`，那是隐藏的放大镜 —— 层比视口大 20%，`cover` 就得再放大一档去填满，
   模糊一小就显形（用户报「比例被裁切不成样子」）。

⚠️ 遗留：`light.jpg` 是 1600×1200（4:3），窗口通常 16:10/16:9，`cover` 必然上下裁 15~25%。
**这是素材问题** —— 要整张可见只能换一张横向的浅色底图。

---

### 内容层的卡片**不能画不透明的底**（资源库页「材质切不动」的真因）

**症状**（用户原话）：「资源库那一页还是不能正确的切换材质」。

**实际量到的**（`tests/manual/` 里的临时探针，逐档对比 `[data-material]`）：
那一页在档 1 与档 2 完全一样、档 3 与档 4 也几乎一样 —— 因为**内容层压根不是玻璃面**：

- 资源条目用的是库的 `Card`，它自带 `background: var(--lg-bg-grouped-2)`（亮色下就是
  `rgb(252,252,253)` 的近白实色）。**玻璃面板上画一块不透明的白卡，等于在材质上凿了个洞** ——
  切哪一档，看上去都是「一堆白卡」，能变的只有侧栏和按钮。
- 分组块是裸的 `List`/`ListSection`，没有用 `Panel`，所以档 4「全液态」时别页的内容层
  都折射了，这一页还是平的。

**改法**：分组整块包进 `Panel`（跟总览页的段落一致，档 1~3 是 `MaterialView`、档 4 变玻璃面）；
条目卡的底改成 `var(--lg-fill-quaternary)`（跟 `.quick` / `.choice` 一样的半透明填充）。
改完实测：档 1 → 32 个 `regular` + 5 个 `MaterialView`；档 4 → 36 个 `clear` + **0 个 MaterialView**，
不刷新拖滑块切换也即时生效。

**两条顺带记下的库行为**（都是读上游源码确认的，别照猜的改）：

1. **`GlassDialog` 的材质是写死的**：上游 `src/react/overlays/dialog.tsx` 里是
   `{ ...surface, material: 'regular', size: 'large' }` —— 传 `material` 进去会被它盖掉。
   弹窗按设计系统就是「大面 = 毛玻璃」，液液态档下它仍是毛玻璃**是库的行为，不是页面没切**。
2. **`Banner` 认 `material`**：它不会自己盖掉，所以液态档下要显式传
   `material={level === 4 ? 'clear' : 'regular'}`，否则整页只有它还是毛玻璃。

⚠️ **查这类问题的正确方法**：别看源码猜，**逐档量 `[data-material]` 的分布**
（`material` / `size` / 有没有 `.lg-material-view`），一眼就能看出哪一层没跟着走。
只看截图很容易把「内容层是实色」误判成「库没生效」。
---

### 侧栏的两条：高亮块要自己做玻璃 + 粘性位置必须等于初始位置

用户报「侧栏的选择框不能正确应用液态玻璃（包括设置子侧边栏）」和「侧栏不应该跟随滚轮滚动」。

**高亮块（选择框）**：库的 `.lg-selection-lens` 外观全部来自 `--lg-lens-bg` /
`--lg-lens-border` / `--lg-lens-shadow` 三个 token，它**本身不是玻璃面**（没有
`backdrop-filter`、没有 `data-material`）。而 `--lg-lens-bg` 在库里**只按主题分档、
不按材质**：

| 主题 | 库的取值 | 库的理由（源码注释） |
|---|---|---|
| 亮色 | `rgb(255 255 255)` **不透明** | 「白轨道上放半透明白胶囊会看不见，所以做成不透明 + 一条比轨道深的细边 + 阴影」 |
| 暗色 | `rgb(255 255 255 / .20)` | 「胶囊是从轨道里抬起来的一级，靠边而不是靠阴影」 |

放在**玻璃侧栏**上时，亮色下那块不透明纯白就是「贴上去的一张白纸」——
所以观感上完全没有液态玻璃。改法是把它改回玻璃（`index.css` 的 `.nav-lens`）：

```css
.app-nav .nav-lens {
  --lg-lens-bg: rgb(255 255 255 / 0.22);
  --lg-lens-border: rgb(255 255 255 / 0.5);
  backdrop-filter: var(--lg-backdrop, blur(10px) saturate(1.5));
}
```

关键是**消费面板自己的 `--lg-backdrop`**：液态档下那个值里带位移贴图
（`blur(3px) url("#lg-…") saturate(…)`），于是选中块和面板**一起折射** —— 才像同一块玻璃。
`var()` 的 fallback 必须给（未定义的 `var()` 会让整条声明失效，这坑踩过多次）。

**侧栏「跟着滚轮走」**：不是粘性失效，而是**粘性位置与初始位置不一致**。
它靠 `margin-block-start: 44px` 让开顶栏那行品牌，但 `top` 写的是 `--lg-space-4`（16px）——
于是页面一滚，侧栏先自己往上跳 44px 再吸附（实测 `top` 从 60 变 16）。
改成 `top: calc(var(--lg-space-4) + 44px)`（= 初始的 60px）后，滚 400px 位置纹丝不动。
`max-height` 也要跟着减掉那 44px，否则吸附后底边会顶出视口。

**验证**：`top` 滚动前后都是 60；高亮块 `background: rgba(255,255,255,.22)` +
`backdrop-filter: blur(3px) url(#lg-…)`（液态档）；探针对齐仍是 dx/dy/dw/dh = 0、切换 31 帧。
截图：`tests/manual/out/nav-lens-*.png`（亮/暗 × 主侧栏/设置子导航）。
---

### 工程转换：三个让「转换直接失败 / 满屏窗口」的真因

> ⚠️ **本节写于「以为修好了」的时候，结论不完整。**
> 后来实测：16 个真工程只成功 10 个（5 个撞 LibreSVIP 自己的
> `AttributeError: vsqx_name` 导出崩溃），且**音高与源工程不一致**
> （默认走官方 `音高信息输入模式=PLAIN`）。**当前实现（逐题回答交互提问 + 自造选项键）
> 偏离了 LibreSVIP 设计的机器接口** —— 现状、权威选项表、正确做法见
> **`docs/CONVERT-HANDOFF.md`**。本节只保留「表层原因」的记录，别再据此认为转换已修好。

用户报「工程转换坏了：**预检拖慢了很多进度**、**转换出来直接失败了**、**转换时莫名冒出来很多窗口**、
**可选项都没了**」。逐条查下来，前三条都是后端的老问题，跟界面无关。

**① 转换失败的真因：往 stdin 喂空行。**
旧实现（`libresvip.rs` 的 `STDIN_BLANKS = 60`）以为「空行 = 接受默认值」，于是灌 60 个空行。
但 LibreSVIP 的 y/n 提问**不收空行** —— 它会一直回 `Please enter Y or N`，把空行一条条吃光，
最后 EOF → `Aborted.`（退出码 1）。实测复现：

```
$ libresvip-cli proj convert 分之子.svp out.vsqx   # stdin 喂 8 个空行
1. 导入音量包络 [y/n] (y): Please enter Y or N
1. 导入音量包络 [y/n] (y): 2. 导入力度包络 [y/n] (y): … 7. …: Please enter Y or N
Aborted.        ← 退出码 1，没有产物
```

**正确做法**：CLI 的提示是 `print` 出来的、**不带换行**，所以「安静下来 + 结尾是冒号」= 它在等你回答；
**照抄提示里括号中的默认值**（`(y)` → `y`、`(1/1)` → `1/1`、`(BETDB8W6KWZPYEB9)` → 原样）。
⚠️ **别在方括号的候选里挑第一个**：`[1/1/2/1/1/2/5/3/3/2/6/5/4/5/3/5/3/4] (1/1)` 是按 `/` 切开的碎片
（里面混着 `1/2`、`3/5` 这种分数），挑第一个会给出非法值 → 它一直重问 → Aborted。
按这个规则驱动之后，20 道题全部答上，`分之子.svp → vsqx` 120 KB、`十年人间.svp → vsqx` 172 KB，退出码 0。

**② 第二条失败原因：输出目录不存在。**
LibreSVIP **不会层层建目录**，写文件时直接 `FileNotFoundError`（PyInstaller 包成
`Failed to execute script`），任务里只剩一句「退出码 1」。`run` 与 `run_upload` 都补了
`create_dir_all(out_dir)`。⚠️ 日志里那句「无效的音频文件：…」是 **stderr 噪音**（工程引用了已挪走的
伴奏 wav），不是失败原因 —— 我一开始就是被它带偏的，真正致命的是最后那行 `FileNotFoundError`。

**③ 满屏窗口：`Command::new` 没设 CREATE_NO_WINDOW。**
`libresvip.rs` 用的是裸 `Command::new`，而它是控制台程序 —— 每个文件（预检一次 + 转换一次）
都弹一个黑窗口，批量转换就是几十个。改用仓库里的 `simple::quiet_command`。
**顺手扫了全后端**：只有这一处漏了；`audio.rs`（ffmpeg）、`ytdlp.rs` 本来就是静的，
`platform.rs` 里那几个是 explorer / rundll32（GUI 程序，不产生控制台）。

**④ 「可选项都没了」的真相**：CLI 的 `proj convert --help` **只有 `--help`**，没有任何选项参数 ——
选项全是转换过程中**逐题提问**的（导入 10 题 + 中间件 5 题 + 导出 5 题）。
旧前端那 13 个「转换处理」开关（`transpose`/`retargetBpm`/`removeShort`…）就是这些中间件的参数，
只是以前发了没人读。现在后端按 `options` 的键回答对应提问，键表见 `docs/FEATURES.md`。

**⑤ 拖入文件走的是「上传版」**：浏览器**不给**拖进来的文件的本机路径，所以
`run-upload`（base64）才是拖放的路。它的 body 上限原来没放宽 —— axum 默认 **2MB**，
而一个 2MB 的工程 base64 后 ~2.7MB，直接被 413 挡掉。加了 `simple::CONVERT_UPLOAD_LIMIT`（96MB）。
另外 Tauri 默认的 `drag_drop_enabled = true` 会把拖放**截走**（改成发它自己的事件），
而我们是「网页 + 本地 HTTP」架构、页面收不到 Tauri IPC —— 于是 HTML5 的 `drop` 永远不触发。
窗口构建处加了 `.disable_drag_drop_handler()`（Tauri 2 的方法名，不是 `drag_drop_enabled(bool)`）。

**验证**（都是真工程、走 API 实测）：路径版 `run` 成功 120 KB / 带 `export.vsqxVersion:"3"` 输出
`<vsq3>`（默认是 `<vsq4>`）；上传版 `run-upload` 成功 213 KB 且同样是 `<vsq3>`；
`inspect` 12.2 秒、`preview` 11.5 秒都正常返回（以前卡死）。