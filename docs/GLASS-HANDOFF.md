# 交接文档 —— 新前端（`app/web-next`）玻璃材质

> **给新会话的接手者。** 这份只讲「看代码看不出来」的东西：现在卡在哪、
> 哪些路已经试过并且**走不通**、下一步从哪下手。
> 项目整体架构看 `AGENTS.md`，产品与使用看 `README.md`。

**写于**：玻璃材质从手写换成 `@ttqtt/liquid-glass-react` 之后。
**当前状态**：能跑（契约 17/17、旧前端冒烟 8/8），但**明亮模式有明确缺陷**。

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

## 二、当前两个缺陷（用户明确报的，**都没修**）

### 缺陷 1：明亮模式下背景可见度低，像叠了一层白

**实测数据**（`data-lg-theme=light`）：

| 项 | 值 | 说明 |
|---|---|---|
| `body` 背景 | `rgb(240, 240, 245)` | `--lg-bg-grouped` |
| `--bg-veil` | `#ffffff2e` | **18% 白遮罩**，压在背景图上 |
| 内容材质 `.lg-material-view` | `rgba(255, 255, 255, 0.82)` | **82% 白** + `blur(30px) saturate(1.8)` |
| `data-thickness` | `regular` | |

**「叠了一层白」的直接来源有两个，量级差很多：**

1. **`--bg-veil: #ffffff2e`** —— 这是我在 `index.css` 里写死的浅色遮罩。
   旧前端在明亮模式用的是 `transparent`（它的理由是「压暗 + 撤遮罩」，
   但那是配 `light.jpg` + `brightness(82%)` 的组合，**当前配置不是那个组合**）。
2. **5 个 `MaterialView` 各 82% 白** —— 面板占了屏幕绝大部分面积，
   所以真正糊住背景的是它们。想让背景透出来，主要得动这里。

**相关位置：**
- `src/index.css` → `[data-lg-theme='light']` 块里的 `--bg-veil` 与背景层规则
- `src/components/Panel.tsx` → `Panel` 组件，`thickness` 默认 `'regular'`
- 库的厚度取值（浅色）：`thin .70` / `regular .82` / `thick .93`
  → 想更透可以降到 `thin`，但**要在浅色背景上复核文字对比度**
  （库自己的注释警告：thin/ultraThin 上别用 `Text tone="quaternary"`，会掉到可读线以下）

**没试过的方向（留给接手者）：**
- `--bg-veil` 降到 `transparent` 或很淡，观察背景图能否出来
- `Panel` 默认厚度从 `regular` 降到 `thin`，逐页复核文字
- 检查背景层本身的 `filter: blur(10px) brightness(82%) contrast(112%)` 是不是压过头

### 缺陷 2：液态玻璃「只有侧边栏实现了」

**实测 —— 顶栏和侧栏其实配置完全一样，都有折射：**

```
玻璃面0 class=app-topbar  material=clear  renderer=svg  size=small
    backdrop=blur(0.75px) url("#lg-_r_0_") saturate(1.08) contrast(1.05)
玻璃面1 class=app-sidebar material=clear  renderer=svg  size=small
    backdrop=blur(0.75px) url("#lg-_r_1_") saturate(1.08) contrast(1.05)
→ 位移贴图总数: 2
→ 内容层用的是什么: lg-material-view × 5
```

所以「只有侧栏」这个感受，**真实原因是两件事**：

1. **顶栏虽然也是 `clear/svg`，但视觉上看不出来。** 它是文档流里的一条横栏
   （`position: static`），背后是页面背景的一部分；折射要「边缘把背后的内容折弯」
   才显眼，而顶栏背后没有可折弯的对比结构。
   ⚠️ 另外顶栏的 `backdrop` 是 `blur(0.75px)` —— **几乎不模糊**，
   因为 `clear` 材质在 `size=small` 时 blur 只有 1.5px（减半后 0.75px）。
   它靠折射而不是模糊，可折射又看不出来 → 结果就是「像一块纯色条」。
2. **内容区的 5 个面板是 `MaterialView`，不是玻璃。** 这是库的设计要求
   （见下面第四节引的原文），所以**内容区本来就不会有液态玻璃**。

**用户想要的很可能是**：让「液态玻璃」这个材质在**内容区**也看得出来。
两条可选路（都需要先想清楚代价）：

- **A. 让 `Panel` 也用 `GlassSurface`**（`material="clear"` + 折射）
  → 违反库的设计分层；满屏折射，开销三倍，且内容区文字压在折射上可能不好读。
  实测过一版「满屏玻璃」，用户当时的评价是**「很割裂」**。
- **B. 加大 `clear` 材质的可见度**（提高 `refraction`，或让顶栏的折射显出来）
  → 不改变结构，只让已有的玻璃更明显。**成本低，建议先试这条。**
  `GlassSurface` 的 `refraction` 默认按材质给（regular 18/26、clear 32/40），
  可以显式传更大的值。

**相关位置：**
- `src/components/Glass.tsx` → `materialOptions()` 是「两种材质的唯一定义处」
- `src/App.tsx` → 顶栏 / 侧栏两个 `GlassPanel` 调用点
- `src/components/Panel.tsx` → `Panel`（内容层，目前是 `MaterialView`）

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
产物里标准版从 **0 处** 变回 **15 处**。

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
     -ArgumentList '--serve','--port=8891','--ui=next' -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 8

node tests\contract\verify.mjs 8891                                   # 应 17/17
powershell -ExecutionPolicy Bypass -File tests\manual\ui-smoke.ps1 -BaseUrl http://127.0.0.1:8891  # 应 8/8（测的是旧前端）
```

### ⚠️ 截图必须显式设视口

**`--window-size` 会被缩成 500×450**，我因此误判过好几轮
（以为布局坏了，其实是窄屏布局）。必须用 CDP：

```js
await send('Emulation.setDeviceMetricsOverride', {width:1440, height:900, deviceScaleFactor:1, mobile:false})
```

### ⚠️ 别用 `--disable-gpu` 截图

带着它 `backdrop-filter` 会糊成一片空白。`ui-smoke.ps1` 里带了它没关系 ——
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
| `app/web-next/` | 当前（`@ttqtt` 库版） |
| `app/web-next-ttqtt库版-备份/` | 20 个文件，**内容与当前一致**，冗余，可删 |
| git | **`app/web-next` 一个 commit 都没有** |

⚠️ **`app/web-next` 从未提交过。** 这一轮我能「退回上一版」全靠手工备份，
而中间我有一次**已经把备份删了**（后来靠对话记录重建）。

**动手前先提交一次。** 没有回退点的代价这一轮已经付过了：
一次改坏、一次靠记忆重建、一次备份误删。

---

## 八、下一步建议（按优先级）

1. **先提交一次**，拿到回退点。
2. **缺陷 1**：`--bg-veil` 与 `Panel` 厚度这两处下手，改完**在明亮模式截图核对**。
3. **缺陷 2**：先试最小改动 —— 显式加大 `refraction`（`Glass.tsx` 的
   `materialOptions()`），看顶栏的折射能不能显出来。
   如果用户要的是「内容区也有玻璃」，那是结构性改动，**先问清楚再动**
   （满屏玻璃我试过，用户当时的评价是「很割裂」）。
4. 亮色改完后**两个主题都要截图核对**，别只看一个。
5. 剩下的页面（`convert` / `video` / `audio` / `lyrics` / `pv` / `resources`）
   还在旧前端跑，`/` 上功能完整。搬迁见 `AGENTS.md` 第十一节。
