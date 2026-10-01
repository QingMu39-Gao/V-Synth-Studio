# 交接文档 —— 新前端（`app/web-next`）玻璃材质

> **给新会话的接手者。** 这份只讲「看代码看不出来」的东西：现在卡在哪、
> 哪些路已经试过并且**走不通**、下一步从哪下手。
> 项目整体架构看 `AGENTS.md`，产品与使用看 `README.md`。

**写于**：玻璃材质从手写换成 `@ttqtt/liquid-glass-react` 之后。
**当前状态**：能跑（契约 17/17、旧前端冒烟 8/8），**两个缺陷已定位并修掉**（见第二节）。
明亮模式与深色模式的实测截图在 `tests/manual/out/`。

---

## 零、库的上游仓库在**本机磁盘上**（先看这个）

```
C:\Users\Administrator\Desktop\工作站素材\liquid-glass-react-main\liquid-glass-react-main\
```

用户提供的，是 `@ttqtt/liquid-glass-react` 的**完整源码仓库**（版本也是 0.0.2，与 npm 上装的一致）。
npm 包里只有 `dist/`，判断行为只能靠猜；这里有：

| 看什么 | 在哪 |
|---|---|
| 设计规则（两层结构、小玻璃/大玻璃、regular/clear、同心圆角） | `docs/design-system.md` |
| 库自己承认的边界（SVG 几何受限、tone 是声明的） | `docs/known-limitations.md` |
| 组件源码（`useSelectionLens`、`TabBar`、`MaterialView` …） | `src/react/**` |
| 材质参数表（每种材质的 blur / saturation / displacement / edge） | `src/tokens/index.ts` |

**这一轮的两个缺陷就是靠它定位的**，别再只对着 `node_modules` 里的 `dist` 猜。

---

## 一、现在的技术选型（已定，别再改）

| 项 | 值 |
|---|---|
| 玻璃库 | **`@ttqtt/liquid-glass-react@0.0.2`**（npm 名；上游是 GitHub `Tsdsj/liquid-glass-react`） |
| 手写玻璃 | **已全部删除**，`src/index.css` 里一行都没有 |
| 内容层 | 库的 `MaterialView`（`thickness="regular"`） |
| 浮层玻璃 | 库的 `GlassSurface`（经 `GlassLayer` 包装） |
| 依赖 | 只有 `@ttqtt/liquid-glass-react` + react + react-dom |

### ⚠️ 一个必须知道的历史坑：装错过库

**有两个同名的库，完全不同的项目：**

| npm 包 | 上游 | 是什么 |
|---|---|---|
| `liquid-glass-react` | `rdev/liquid-glass-react` | **单个**玻璃组件，**包里一个 CSS 都没有**（皮肤要自己写） |
| **`@ttqtt/liquid-glass-react`** | **`Tsdsj/liquid-glass-react`** | **66 个组件的完整 Apple 设计系统**，自带 `style.css` 197KB |

**用户要的是 `@ttqtt` 那个**（他给过 GitHub 链接）。我一开始 fetch GitHub 失败，
就去 npm 搜「liquid-glass-react」，装了 rdev 那个**同名包**，然后花了一整轮
在手工复刻 `@ttqtt` 已有的功能，效果一直不对。

**教训**：用户给了 GitHub 链接而 fetch 失败时，去 `npm search <项目名>` 找**作者名**
对得上的那个，别直接装搜到的第一个同名包。

### rdev 那个包走不通的两条路（别再试）

1. **明亮模式渲染不出浅色玻璃。** 实测把整条 CSS 链都调对了
   （`--panel-scrim: #ffffffe6`、`.glass` 计算值 = `rgba(255,255,255,0.9)`、
   body 浅色、背景用 light.jpg），**画面依然是黑的**。
   我改了五处参数（`--bg-veil` / `--panel-scrim` / `--glass` / `--bg-image` / `--bg-1`），
   全部正确生效、全部没解决。**这是死路，不是参数没调对。**
2. **皮肤要自己写。** 它的 `.glass` / `.glass__warp` / `.glass__content` 类
   **包里没有任何 CSS**，你必须自己实现玻璃外观 —— 那就等于手写玻璃。

---

## 二、两个缺陷：根因与修法（**已修**，2026-10-01）

上一版这一节写的是「都没修」+ 一组参数猜测。**实测下来根因不是参数，是三件配置错误**
（都违反库自己 `docs/design-system.md` 的明文规定），另外有一件是结构性误判。

### 实测到的旧状态（1440×900，明亮模式，液态玻璃）

| 项 | 实测值 | 判定 |
|---|---|---|
| 顶栏 | `data-material=clear`、`data-glass-size=**small**`、`.lg-tint = rgba(0,0,0,.35)`、`.lg-backdrop` 的模糊 = **0.75px** | 灰板 |
| 侧栏 | 同上（228×493 的整列，却也是 `small`）；模糊 = 0.75px | 灰板 |
| 内容面板 | 5 × `MaterialView` `thickness=regular` = `rgba(255,255,255,.82)` + `blur(30px)`，每块 1116px 宽 | 盖住整屏 |
| 背景图 | **加载正常**（1600×1200 / 182KB），`body::before` = `blur(12px) brightness(1) contrast(1.45)` + 18% 白遮罩 | 无问题 |
| 侧栏高亮块 | `.lg-selection-lens` 数量 = **0** | 功能缺失 |

### 根因（按影响排序）

1. **默认材质选错了。** 默认给的是 `clear`（液态玻璃）。设计系统第 3 节写明 `clear`
   **只用于媒体内容之上、且上层内容本身明亮醒目**的场合；`regular` 才是「栏、侧边栏、
   菜单、文字较多的表面」的默认。而 `clear` 配浅色背景时库会叠一层
   `.lg-tint = rgba(0,0,0,.35)` 的 35% 黑压，`clear/small` 的 CSS 模糊又只有 1.5px
   （开折射后再减半 = 0.75px）—— **两者相加就是一块纯灰板**：既没有模糊，也没有
   折射可看（背后是接近纯白的图）。这就是「液态玻璃只有侧栏看得出来」的观感来源。
2. **侧栏用了 `size="small"`。** 设计系统第 2 节：小玻璃与大玻璃**不是同一个效果的两种大小**。
   侧栏这种整列必须 `large`（模糊 40px、底色 0.86/0.90、**不随背景翻转**、阴影更深）。
   给 `small` 之后它的模糊只有 1.5px，等于没糊。
3. **内容面板 82% 白**（`thickness=regular`），5 块各 1116px 宽 —— 把背景照片整片盖掉。
   「像叠了一层白」的主因是它们，不是背景层参数。
4. **顶栏是文档流里的一条横栏**（`position: static`）：背后永远是页面背景的一部分，
   **没有内容从它背后经过**。玻璃的观感来自「有东西从背后经过」，这一条不是调参能解决的。

### 改了什么

| 文件 | 改动 |
|---|---|
| `components/Glass.tsx` | `DEFAULT_MATERIAL`：`'liquid'` → **`'frosted'`**（默认毛玻璃；液态玻璃仍可切） |
| `components/Panel.tsx` | `Panel` 默认厚度 `'regular'` → **`'thin'`**（.82 → .70）；`GlassPanel` 新增 `size` 透传 |
| `App.tsx` | 侧栏 `size="large"`；导航选中态换成库的 `.lg-selection-lens`（`useNavLens`，见 §2.1） |
| `index.css` | 顶栏 `position: sticky`；导航行透明、选中交给高亮块；`@supports (corner-shape: squircle)` 补回苹果式圆角 |

### 改后的实测值

| | 之前 | 现在 |
|---|---|---|
| 顶栏 | `clear/small`，tint 35% 黑，blur **0.75px** | `regular/small`，tint `rgba(252,252,254,.7)`（深色 `.78`），blur **14px** |
| 侧栏 | `clear/small` | `regular/**large**`，tint `.86`（深色 `.9`），blur **40px** |
| 内容面板 | 82% 白 | **70%** |
| 侧栏高亮块 | 0 个 | 1 个，切换时逐帧 30+ 个不同取值、与选中行偏差 `0/0/0/0` |
| 位移贴图 | 2（液态） | 毛玻璃 **0**（纯 CSS，零额外开销）／液态 2 |

**怎么验**（本轮新加的探针，只用 Node 自带的 WebSocket，不装包）：

```powershell
v-synth-studio.exe --serve --port=8891          # 另开一个测试实例
node tests\manual\glass-probe.mjs 8891 light frosted   # 也可 dark / liquid
```
它只读计算值（玻璃面的 material/size/tone、`.lg-backdrop` 的模糊、`.lg-tint` 的底色、
面板厚度、背景层 filter、高亮块的逐帧采样与首帧落位），并把截图写到
`tests/manual/out/glass-<主题>-<材质>.png`。

### 2.1 侧栏的滑动高亮块：用库的透镜，别自己画

`useSelectionLens`（`src/react/controls/segmented.tsx`）就是干这个的，注释里明写
「the same lens has to follow a row of segments and **a vertical column of sidebar rows**」——
正是侧栏这个场景。但它**没有从包里导出**（`dist/react/index.d.ts` 只导出了
`GlassSegmentedControl`），所以现在的做法是：

- **只自己写「量位置」那十来行**（`App.tsx` 的 `useNavLens`），
- **外观、弹簧曲线、阴影全部复用库的 `.lg-selection-lens`** —— 那块 span 由
  `--lg-slot-x/y`、`--lg-lens-shown` 驱动，三个属性都带 `@property` 声明，过渡挂在
  `transform` 上（`--lg-duration-spring: 520ms` + `--lg-spring` 这条 `linear()` 弹簧）。

三个坑照旧（都实测过，见第六节的验证片段）：**首帧不能滑**、**量位置用 `offsetTop`**、
**行要 `position: relative; z-index: 1`**。

挤压（「滑动时缩放」）现在只改**一个**喂进 `transform` 的变量（`--lg-lens-swell-y`），
所以不存在「动画抢走 transform」的问题 —— 上一版需要分两层正是因为这个冲突，现在不需要了。

### 2.2 第二轮（用户复报「除了侧栏都没有实现对应的玻璃材质」）

上一轮把材质参数修对了，但用户看到的仍然是「只有侧栏有玻璃」。**这次不是参数问题**，
三件事各自独立，任何一件都能单独造成那个观感：

**① 背景层自己糊过头了（最要命的一条）。**

`--bg-blur` 原来是亮色 12px / 暗色 14px。整页先被自己糊成一团奶白，
玻璃压上去**再糊一次等于没糊** —— 唯一还能看出差别的只剩 40px 模糊的侧栏。
**玻璃的观感来自「背后有东西被它糊掉」，不是来自玻璃自己。**

实测（`glass-probe.mjs` 的第 5 个参数可以临时覆盖令牌再截图）：

```powershell
node tests\manual\glass-probe.mjs 8891 light frosted '--bg-blur=0px'
node tests\manual\glass-probe.mjs 8891 light frosted '--bg-blur=3px'
```

现取值：亮色 **3px** / 暗色 **4px**（`app/web-next/src/index.css` 的
`[data-lg-theme=...]` 两处）。改完玻璃边缘立刻把背后的细节糊开，材质成立。

**② 材质没写在 `GlassProvider` 上 —— 库的控件根本不跟着切。**

只有自家包装的两个面（顶栏 / 侧栏）传了 `material`。库的控件
（`GlassButton` / `GlassSegmentedControl` / `TabBar` …）**不接材质参数，读的是 policy**。
实测：切到「液态玻璃」时侧栏变 `clear`，而按钮和分段控件仍是 `regular`。

修法一行：`<GlassProvider material={materialOptions(material).material}>`。
（`GlassPolicy` 里没有 `refraction`，折射仍按面给。）

**③ 控件层全是手写的平控件，顶栏却是一整块玻璃。**

手写 `.btn`（背景 + 描边 + `scale(.97)`）**材质是零**；`.seg` 只是换个底色。
于是整屏的材质只剩两块大板。而库的规矩恰恰相反 —— 它的 `GlassToolbar` 注释写着：

> 工具栏本身不携带背景：它是一行**分组**，玻璃是每一组。

本轮改法：

| 改了什么 | 怎么改 |
|---|---|
| 按钮 | `components/Button.tsx` 换成库的 `GlassButton`（`default→glass`、`primary→glassProminent`、`ghost→plain`、`danger→destructive`，`size→controlSize`）。手写 `.btn*` / 加载转圈全部删除 |
| 顶栏材质切换 | 换成库的 `GlassSegmentedControl`（自带滑动透镜、可拖） |
| 顶栏本身 | **去掉那层大玻璃**，留一条平的行 —— 玻璃交给里面的控件 |
| 平栏的代价 | 内容会从它下面经过 → 加库的 `ScrollEdge`（不给 `targetRef` 即「盯页面滚动」），吸顶时自动亮起 |
| 侧栏的主题切换 | **故意留着**手写 `.seg`：它在侧栏那块玻璃**里面**，库的规矩是不要玻璃叠玻璃 |

改完实测（四种组合都跑过）：

| | 毛玻璃 | 液态玻璃 |
|---|---|---|
| 玻璃面 | 分段控件 1 + 按钮 8 + 侧栏 1，**全部 `regular`** | 同样 10 个面，**全部 `clear`** |
| 位移贴图 | 0（纯 CSS，零开销） | **10**（每个控件都折射） |
| 背景层模糊 | 3px / 4px | 同 |
| `ScrollEdge` | 滚动时 `data-active=true`、opacity 1 | 同 |

### 2.3 明亮模式的背景参数（2026-10-01 二次调整）

用户报「背景图太恍了，而且比例似乎被裁切不成样子，什么也看不到」。两个独立的原因，
**都是 2.2 那一轮改出来的副作用**：

**① 只降了模糊，没收对比度。** 把 `--bg-blur` 从 12px 降到 3px 时，
`--bg-contrast` 还是 145% —— 那张图的原始亮噪点全暴露，对比再一拉就是一片扎眼的高频白斑，
有效信息（43 / 94 / 条码）反而被淹没。

现在（亮色）：`blur 5px` + `brightness 86%` + `contrast 112%` + **veil 全撤** ——
也就是**压暗 + 撤遮罩**（旧前端那条结论，实测仍然对）。
四个候选值的截图留在 `tests/manual/out/`（文件名带 `bg-dim…`）。

**② `inset: -10%` 是个隐藏的放大镜。** 那个值是给 `blur()` 留的采样溢出量，
但背景层比视口大 20% 时，`background-size: cover` 就得**再放大一档**去填满 ——
等于把图放大 20% 再裁。模糊 12px 时看不出来，模糊降到 3~5px 之后用户一眼就是
「比例被裁切不成样子」。

改成跟模糊联动：

```css
body::before { inset: calc(var(--bg-blur) * -2); }   /* 够采样，几乎不放大 */
```

**没解决、也不打算用参数解决的**：`light.jpg` 是 1600×1200（4:3），
而窗口一般是 16:10 / 16:9 —— `cover` 必然上下裁掉约 15~25%。
要让整张图都看得见只有两条路：换一张横向的浅色底图，或者用 `contain` 留出背景色的边。
**这是素材问题，不是 CSS 问题。**

### 2.4 仍然存在、但**属于库的设计**的两件事

- **液态玻璃（`clear`）在明亮模式下就是灰调。** `clear` + 浅背景 = 库的 35% 黑压（第 3 节）。
  这不是 bug，是这个材质的适用条件。想更亮就别用 `clear` —— 所以它不再是默认。
- **亮色背景图本身极浅**（glitch art，像素挤在 #e0–#f5）：玻璃压在上面「有东西可折射」
  的程度天然有限。要真正拉开层次得换一张有明暗层次的浅色图，参数层面已经到头。


---

## 三、已经修好、**不能弄坏**的东西

### 3.1 构建期：标准 `backdrop-filter` 会被 lightningcss 删掉

**症状**：库的样式表里明明是 `backdrop-filter: blur(30px)`，
浏览器 `getComputedStyle` 却报 `none`，面板变成一片不透明底色。
**源码怎么查都是对的 —— 问题只在构建产物里。**

**根因**：Vite 8（rolldown 版）用 lightningcss 压缩 CSS，它按浏览器目标
自动裁剪厂商前缀，这里**裁错了**：删掉标准属性、只留 `-webkit-`。
而 WebView2 / Chromium **只认标准属性名**：

```
CSS.supports('backdrop-filter','blur(1px)')         → true
CSS.supports('-webkit-backdrop-filter','blur(1px)') → false
```

**修法**：`vite.config.ts` 里的 `restoreStandardBackdropFilter()` 插件
（`enforce: 'post'` + `generateBundle`，在压缩之后补回标准属性）。
产物里标准版从 **0 处** 变回 **15 处**（每次构建都会打一行 warn 报数量，看到它才算生效）。

⚠️ **量模糊时别量错节点**：模糊挂在 `.lg-decoration > .lg-backdrop` 这一层上
（它消费 `--lg-backdrop` 这个自定义属性），**玻璃面根节点自己的
`backdrop-filter` 恒为 `none`**。本轮就因为量了根节点，一度误判成「模糊全没了」。
探针里已经按类名取到那一层。

**试过、都不行的办法（别再试）：**

| 办法 | 结果 |
|---|---|
| `build.target: 'chrome120'` | 管不到 CSS 这一步 |
| `css.lightningcss.targets` | 无效（标准版仍是 0 处） |
| `build.cssMinify: 'esbuild'` | Vite 8 不再自带 esbuild，**直接构建失败** |
| `build.cssMinify: false` | 有效，但产物 **+100KB**（120KB→220KB） |

### 3.2 折射要显式打开

库默认走保守 CSS 路径（README：「默认是磨砂…边缘折射要自己打开」）。
`App.tsx` 里 **`enableSvgAuto={material === 'liquid'}`** ——
选「液态玻璃」才开折射，选「毛玻璃」是纯 CSS、零额外开销。
**去掉这个 prop 会让两种材质几乎没差别。**

### 3.3 背景色调必须声明

库不采样背景（它明令禁止 DOM 截屏与跨源读像素），要区域自己声明：

```tsx
<BackdropToneProvider tone={resolvedTheme}>   // 见 App.tsx 的 ToneScope
```

**不声明的话材质选不起来** —— `tone="mixed"` 时库会把 `clear` **退回 `regular`**。
实测：不声明时选「液态玻璃」完全没反应，玻璃面报 `data-material="regular"`、
一个 `feDisplacementMap` 都没有。

### 3.4 `GlassContent` 那套 context 的由来

库生成的 `.lg-content` 我们拿不到 ref，React 子元素也没法批量加类。
我踩了两次：

1. `firstElementChild` → 只给**第一个**子元素加类，顶栏里只有「品牌」拿到 flex
   规则 → **换行成两行**，玻璃跟着撑高 32px。
2. `display: contents` 的包装当锚点 → **它不生成盒子**（`offsetWidth === 0`），
   写在它上面的 `display:flex` 全废 → `innerW=0`、内容塌掉。

**现在的做法**：`GlassLayer` 用 context 把 `contentClassName` 传下去，
由 `GlassContent` **自己包一层真 div**。别改回 DOM 查找那套。

---

## 四、库的设计约束（理解「为什么内容区不折射」）

上游 `docs/design-system.md` 第 1 节，三条不能违反的规则：

1. **玻璃不进内容层。** 满屏半透明卡片是最常见的「不像 Apple」的写法。
2. **不要玻璃叠玻璃。**
3. **克制使用。** 到处都是就等于没有。

库源码里 `GlassSurface` 的注释说得更直接：

> This belongs to the navigation / control layer — bars, groups, overlays.
> **It is not a card**: content-layer containers use `Card`, `List` or `MaterialView`,
> which do not sample the backdrop at all.

`MaterialView` 的注释：

> A *standard material* — the content layer's translucency tool, and **the right answer
> whenever the instinct is to reach for glass on something that does not float**.
> It blurs and tints, but it does **not** lens, does **not** carry a specular rim and
> does **not** flip with its backdrop.

**所以缺陷 2 有相当一部分是「库就是这么设计的」。**
要改之前先想清楚：是用户真的要满屏折射，还是只要「液态玻璃看得出来」。

---

## 五、验证怎么做

```powershell
# 起测试实例（端口 8891，别和用户正开的 17878 打架）
$p = Start-Process -FilePath 'H:\工作站\v-synth-studio.exe' `
     -ArgumentList '--serve','--port=8891' -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 8

node tests\contract\verify.mjs 8891                                   # 应 17/17
node tests\manual\next-smoke.mjs 8891                                 # 应 8/8（8 页渲染 + 文案断言）

# 玻璃材质专项：取计算值 + 截图 + 高亮块的逐帧/首帧采样
node tests\manual\glass-probe.mjs 8891 light frosted
node tests\manual\glass-probe.mjs 8891 dark  liquid
```

`glass-probe.mjs` 一次给三样东西，都是「光看源码看不出来」的：

| 字段 | 说明 |
|---|---|
| `glass[].layers` | 每块玻璃面的 `material/size/tone` + `.lg-backdrop` 的**真实模糊**与 `.lg-tint` 的底色 |
| `boot.settled` | 打开界面时高亮块**有没有飞过去**（首帧采样：首帧就应等于最终值） |
| `slide.distinct` / `slide.align` | 切换时逐帧的不同取值个数（>3 才算滑动）+ 与选中行的偏差（应 `0/0/0/0`） |
| `round` | `corner-shape: squircle` 在按钮/面板上是否真的生效、玻璃面是否保持 `round` |
| `screenshot` | 截图落 `tests/manual/out/`，用 read_image 看 |

### ⚠️ 截图必须显式设视口

**`--window-size` 会被缩成 500×450**，我因此误判过好几轮
（以为布局坏了，其实是窄屏布局）。必须用 CDP：

```js
await send('Emulation.setDeviceMetricsOverride', {width:1440, height:900, deviceScaleFactor:1, mobile:false})
```

### ⚠️ 别用 `--disable-gpu` 截图

带着它 `backdrop-filter` 会糊成一片空白。`next-smoke.mjs` 里带了它没关系 ——
那条路只 dump DOM，不看画面。

### CDP 端口会随机被拒

`fetch('http://127.0.0.1:PORT/json/list')` 偶尔返回一个 JWT 字符串而不是 JSON
（`.json()` 会抛 `SyntaxError: Unexpected token 'e'`）。**准备一组端口循环重试。**

### 进程卫生

跑完必须停测试实例、清无头 Edge：

```powershell
$c = Get-NetTCPConnection -LocalPort 8891 -State Listen -EA SilentlyContinue | Select-Object -First 1
if ($c) { Stop-Process -Id $c.OwningProcess -Force }
Get-Process -Name 'msedge' -EA SilentlyContinue | Where-Object { $_.MainWindowHandle -eq 0 } | Stop-Process -Force
```

⚠️ **杀进程只能按精确 PID 或端口 owner**，别按命令行子串匹配（误杀过 DSH 自己的进程）。

---

## 六、文件地图

```
app/web-next/
  vite.config.ts                    ⚠️ 含 restoreStandardBackdropFilter 插件，别删
  src/
    main.tsx                        引库的 style.css（顺序不能改）
    App.tsx                         GlassProvider / ToneScope / 顶栏 / 侧栏 / 导航
    index.css                       只有外壳布局，**零手写玻璃**
    components/
      Glass.tsx                     ★ materialOptions() = 两种材质的唯一定义处
                                     GlassLayer / GlassContent / GlassInline
      Panel.tsx                     Panel(MaterialView) + GlassPanel(GlassSurface)
                                     + Chip / Finding / Stat / PanelHead
      Button.tsx  Field.tsx  Icon.tsx
    lib/
      useGlass.ts                   材质 store（useSyncExternalStore）
      useTheme.ts                   主题 store（同上）
      usePerfMode.ts                性能模式 store（同上）
      api.ts  types.ts
    pages/
      Dashboard.tsx  Settings.tsx  Placeholder.tsx
```

**三个 `use*.ts` 都必须用 `useSyncExternalStore`，不能改成 `useState`** ——
踩过：钩子里用 `useState` 再被两个组件各调一次，两个组件各持一份独立 state，
localStorage 改了、DOM 不动，看着就是「切材质没有任何用」。

---

## 七、备份与版本控制现状

| | |
|---|---|
| `app/web-next/` | 已入库：`83320cd`（首次）+ 本轮玻璃修复的后续提交 |
| `app/web-next-ttqtt库版-备份/` | 手工备份，**已彻底冗余，可以删** |
| git | 干净了 —— 不用再靠手工备份回退 |

⚠️ 上一轮 `app/web-next` 一个 commit 都没有，回退只能靠手工备份，代价是
「改坏一次、靠记忆重建一次、备份误删一次」。**现在有回退点了，继续用 git，别再手工复制目录。**

---

## 八、下一步建议（按优先级）

1. **控件层换成库的组件。** 现在 `Button`/`Field`/`.seg`/`.input` 还是手写的
   （虽然材质走库）。库自带 `GlassSegmentedControl`（胶囊、可拖、选中在拖动中实时更新）、
   `GlassButton`、`TextField`、`List`…。顶栏的「毛玻璃/液态玻璃」和侧栏底部的主题切换
   最该先换 —— 它们本来就是分段控件。
   **换完之后再判断 shadcn 还需不需要**：库已经提供了 66 个控件，
   `AGENTS.md` 第十一节里「接 shadcn/ui」这条待办可能是多余的。
2. ~~**一页页搬页面到 React**~~ **已完成（2026-10-02）**：8 页全部搬完，
   旧前端与 `ui-smoke.ps1` 已于 2026-10-02 一起删除。
3. ~~**给新前端补冒烟**~~ **已完成**：`tests/manual/next-smoke.mjs` 覆盖 8 页
   （控制台报错 / 占位页 / 玻璃面 / 该页文案），跑法见上面第五节。
4. **`resolve_paths()` 改用 `resource_dir()`**（`AGENTS.md` 第八节的核心遗留问题，
   修掉 MSI 与 macOS bundle 都靠它）。
5. **侧栏的形态要不要换？** 库的 `TabBar` 自带透镜、拖拽换页、窄屏自动变成底部胶囊栏，
   但它的侧栏形态是 `position: fixed` 的**整列贴窗口左边**，而且**没有分组标题**
   （我们现在的「工作台 / 素材获取 / 系统」三组是手写的）。现在是「保留分组标题 +
   复用库的透镜」，两条路都成立，属于**要用户拍板的结构选择**，别自作主张。
6. **液态玻璃的观感上限**：`clear` 在浅色背景下是灰的（库的设计）。
   要让它好看，得换一张**有明暗层次的浅色背景图**（现在这张像素挤在 #e0–#f5）。
   这是素材问题，不是代码问题。
7. 剩下的页面（`convert` / `video` / `audio` / `lyrics` / `pv` / `resources`）
   还在旧前端跑，`/` 上功能完整。搬迁见 `AGENTS.md` 第十一节。


---

## 4. 启动加载画面（`#boot`）

新前端原来是在「等 JS 下载解析 + 等 `/api/state` 探测 ffmpeg/yt-dlp」这段时间**白屏** 2~3 秒。
现在 `app/web-next/index.html` 里有一层静态遮罩，`lib/boot.ts` 负责揭开。

**四条规矩**（都是踩出来的）：

1. **样式内联在 `index.html` 那段**，不能等 CSS 包 —— 等它就没意义了。
   颜色也只能用字面量：库的 `--lg-*` token 挂在 `[data-lg-theme]` 下，
   而那是 `GlassProvider` 运行后才写的；这里只认 `<head>` 里那段内联脚本写的 `data-theme`。
2. **必须有兜底**：12 秒还没揭开就显示「重新载入」。**谁都不该被永久卡在加载页。**
   `hideBoot()` 内部除了 `transitionend` 还有一条定时器强制删节点（后台标签页会被节流）。
3. **最短展示 520ms**：接口偶尔很快，直接揭会闪一下，比不做还难看。
4. **失败也要揭**：`/api/state` 挂了要让用户看到「连不上本地服务」那块提示，
   而不是一个永远转圈的遮罩。

**动画本身**：图标呼吸 + 一圈 `conic-gradient` 光弧绕它转 + 一条不定长滑动的进度条。
光弧不是新画的图形 —— 图标本身就是个圆环，几何是共通的。
`prefers-reduced-motion` 下全部动画停掉。

**验证**（`tests/manual/glass-probe.mjs`）：探针在重载后**轮询到新文档接管**再截图
（`splash.shownEarly` / `splash.atBoot` / `splash.goneWhenReady`），产出
`tests/manual/out/boot-<theme>.png`。

⚠️ **别贴着重载就截图**：`Page.reload` 一返回就 `captureScreenshot`，
合成器可能还在交**旧文档的残留帧**（旧文档那时也在加载、遮罩是它那个主题的底色）。
症状是「亮色跑的却截出一张暗图」，而同一刻读 DOM 明明是亮色 —— 排查了一轮才定位到。
### 4.1 交接：遮罩 → 界面

**只把遮罩淡出是不够的。** 界面在遮罩底下**早就画好了** —— React 在 `/api/state`
回来之前就挂载完了，所以「一降不透明度」的结果是「整块界面已经在那儿」，
用户看到的仍然是没有过渡。用户的原话：「加载完进到主界面的过渡太生硬 甚至没有过渡」。

做法：`hideBoot()` 在淡出前给 `<html>` 打 `data-boot="out"`，`index.css` 用它给
`.app-sidebar` / `.app-main` 各来一段 **720ms 的入场**（淡入 + 上浮 10px，`--lg-ease-out`）；
遮罩那边 **300ms** 收掉、卡片再自己往上收一点。两边**同一帧**开始，形成交叉。

⚠️ **两边的时长要拉开**（遮罩快、界面慢）。一样长的话，界面入场的绝大部分是在遮罩
还盖着的时候走完的，露出来的只剩最后一两成 —— 观感上依然接近「啪」。
实测：520/380 那一版的交接帧是「遮罩 0.22 / 界面 0.91」，动作基本白做；
改成 720/300 之后，遮罩让开时界面才走到一半左右。

⚠️ **入场只能加在 `.app-sidebar` 和 `.app-main` 上，不能加在 `.app` 上。**
`.app` 里有两个 `position: fixed` 的**直接子元素**（`.app-top-edge`、`.toasts`），
父级一旦有 `transform` 就不再是它们的包含块，它们会跟着页面滚走。
这两个元素内部没有 fixed 后代，安全；而且动画结尾是 `transform: none`，不留包含块。

**验证**：探针等 `data-boot="out"` 出现的那一帧，读双方的不透明度
（`splash.handoff`），并留一张 `boot-handoff-<theme>.png`。
**两边同时 <1 才叫交叉**；只有遮罩 <1 就是「界面早就画好、啪地出现」。