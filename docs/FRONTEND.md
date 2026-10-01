# 前端（`app/web-next`）—— 结构、约定与维护手册

> 这份文档是**动前端之前先读的那一份**。
> 玻璃材质本身的规矩在 `docs/GLASS-HANDOFF.md`；接口与功能清单在 `docs/FEATURES.md`；
> 交接优先级只在 `AGENTS.md`。
>
> **2026-10-02 现状**：前端只有一套。旧的手写前端（`app/web/js/` + `app/web/css/` +
> 那个手写的 `app/web/index.html`）已整体删除，`docs/LEGACY-UI.md` 一并退役。
> exe 与启动器都加载根路径 `/`，`main.rs` 里的 `--ui=next|old` 选择逻辑也删掉了。

---

## 1. 一套前端，加载路径只有一个

| | |
|---|---|
| 源码 | `app/web-next/`（React 19 + Vite 8 + TS 7 + Tailwind 4，只用了插件、没写工具类） |
| 构建产物 | **直接落在 `app/web/` 根上**：`index.html` + `assets/` |
| URL | `/`（`vite.config.ts` 的 `base: '/'`、`outDir: '../web'`） |
| 控件 | 库 `@ttqtt/liquid-glass-react` 的组件 |
| 状态 | `App.tsx` 拿一次 `/api/state`，往下传给各页 |

产物是静态文件，后端**每请求从磁盘读**（`server/simple.rs::static_files`），
所以改前端**不需要重新编译 exe**，`npm run build` 完刷新页面即可。

### ⚠️ `app/web/` 里住着三样东西，只有两样是构建产物

```
app/web/
  index.html     ← 构建产物（Vite）
  assets/        ← 构建产物（Vite）
  img/           ← 不是产物：logo 与两张背景图，前端按绝对路径引用
  vendor/        ← 不是产物：JIZURA 字体与编辑器，PV 页用 iframe 指向它
```

所以 `vite.config.ts` 里 `emptyOutDir: false` **是必须的**，不是可选优化 ——
打开它 Vite 会把 `vendor/` 与 `img/` 一起清掉，而构建照样报成功：
运行时表现成 PV 页打不开、背景图消失，极难往回查。
`app/desktop/build.ps1` 为此加了一道核对（构建前记下 `vendor/` 在不在，构建后复查）。

`app/web/index.html` 还有第二个身份：**它是「程序根目录」的判定哨兵**
（`main.rs::resolve_paths` 靠往上找 `app/web/index.html` 定位根目录）。
它不在了，exe 会直接报「找不到程序文件」并退出 —— 这时先跑一次
`powershell -ExecutionPolicy Bypass -File app\desktop\build.ps1`。

---

## 2. 目录与文件

```
app/web-next/
  index.html            入口 + **启动加载画面**（#boot，样式内联、12 秒兜底）
  src/
    main.tsx            挂载；样式表顺序：库的 style.css → 我们的 index.css（**不能改**）
    App.tsx             外壳：顶栏（只有品牌）/ 侧栏 / 导航 / 路由（hash）/ toast / 主题
    index.css           **共用样式**：布局 + 共用类（.panel/.field/.job/.dir-…），零手写玻璃
    lib/
      api.ts            后端调用（39 条路由的 1:1 封装，绝对路径 /api/*）
      types.ts          后端数据结构（照 tests/contract/fixtures 定义）
      format.ts         formatBytes / Duration / Number（时钟时间的 formatTime 等暂时没人用）
      useJob.ts         任务进度订阅：SSE + 轮询兜底
      useGlass.ts       玻璃等级 1~4（材质 / 透明度 / 面板要不要玻璃，全由它派生）
      useNavLens.ts     侧栏与小节导航的滑动高亮块（量位置 + 首帧不滑）
      boot.ts           揭开启动画面（App 在首次 /api/state 落定后调）
    components/
      Glass.tsx         GlassLayer / GlassContent / materialOptions()
      Panel.tsx         Panel（玻璃面板）/ GlassPanel / PanelHead / Chip / Finding / Stat
      Button.tsx        → 库的 GlassButton / GlassIconButton
      Field.tsx         Field / TextInput / TextArea
      Icon.tsx          手写 SVG path 表（**没有图标库**，要离线）
      Job.tsx           JobProgress（库的 GlassProgress + 取消 + 日志）
      DirPicker.tsx     DirPicker（库的 GlassDialog + PathBar + List）/ DirectoryInput
    pages/
      Dashboard.tsx     总览
      Settings.tsx      设置
      <Name>.tsx        每个页面**自带**一个 <Name>.css（避免多人/多任务改同一个 index.css）
```

---

## 3. 页面的约定

### 3.1 组件签名

页面是普通函数组件，**props 由 `App.tsx` 传**，不要自己去 `api.state()`：

```tsx
export function Resources({
  state,            // AppState | null —— 后端快照，可能还没到（先渲染骨架/空态）
  onNavigate,       // (id: string) => void
  onRefreshState,   // () => Promise<void>  —— 改过配置/工具后叫它重拉
  onToast,          // (msg: string, tone?: 'ok'|'err'|'warn'|'info') => void
}: PageProps) {
```

`PageProps` 在 `pages/types.ts`（共享类型，别每页各写一份）。

**每个页面的硬性要求**（照抄 `AGENTS.md` 第四节的老要求，React 版同样适用）：

- 全部文案中文、务实、不要营销腔。
- **任何失败都要能被用户看到**：`try/catch` + `onToast(err.message, 'err')`，不许静默吞。
- 长任务一律 `<JobProgress>`：`const { job, start } = useJob()`，拿到 `jobId` 后
  `start(jobId, { onDone, onError })`；**离开页面时钩子自己会收订阅**。
- 缺外部依赖时说明**怎么恢复**并禁用相关功能，**不要引导用户去下载**。
- 空态用 `<Panel>` 里一句人话，不要空白页。

### 3.2 用库的组件，不要手写控件

库有 60+ 个组件，已经导出可直接用（`import { ... } from '@ttqtt/liquid-glass-react'`）：

| 场景 | 用 |
|---|---|
| 按钮 / 图标按钮 | `GlassButton` / `GlassIconButton`（经 `components/Button.tsx`） |
| 输入框 / 多行 | `TextField`（`multiline`）/ `SearchField` |
| 下拉 / 单选 | `Picker` / `RadioGroup` |
| 勾选 / 开关 | `GlassCheckbox` / `GlassSwitch` |
| 数值 | `GlassStepper` / `GlassSlider` |
| 分段控件 | `GlassSegmentedControl` |
| 进度 | `GlassProgress`（经 `components/Job.tsx`） |
| 弹出层 | `GlassDialog`（`title` + `description` **都必填**）/ `GlassAlert` / `Sheet` / `Popover` |
| 列表 | `List` + `ListSection` + `ListRow`（`onSelect` / `disclosure` / `selected`） |
| 卡片 / 分组 | `Card` / `GroupBox` |
| 面包屑 | `PathBar`（`items: { key?, label, onSelect? }`，最后一项不给 `onSelect`） |
| 表单布局 | `Form` / `FormSection` / `FormRow`（`label` + `description` + `error`） |
| 徽标 | `GlassBadge` |

**手写控件只在库确实没有的时候**（例如波形画布 —— 那是 canvas，不是控件）。
新增手写控件前，先 `Get-ChildItem node_modules/@ttqtt/liquid-glass-react/dist/react -Recurse` 翻一遍。

⚠️ 包名是 **`@ttqtt/liquid-glass-react`**（作者维护的那份），不是 `rdev/liquid-glass-react` ——
两个同名包，装错过一次。

### 3.3 玻璃只在哪一层

（详细理由见 `GLASS-HANDOFF.md`）**内容不进玻璃层**：正文、列表、画布用
`Panel`（默认就是玻璃面板，按「玻璃等级」开关决定材质）或库的 `MaterialView`；
**控件才是玻璃**（按钮、分段、工具栏分组）。

- 玻璃等级 1~4 由 `lib/useGlass.ts` 的 `useGlassLevel()` 决定，页面**不要**自己判断材质。
- 背景参数、`--lg-*` 令牌都在 `index.css` 顶部，页面 CSS **一律用令牌**，不要写死颜色。
- 新加类名一律放在**页面自己的 `<Name>.css`** 里（并行开发时不会互相踩）。
- 背景图只能用**绝对路径** `url('/img/bg/…')`：相对路径跟着当前文档目录走，
  历史上前端不在根路径时就 404 过，别改回去。

### 3.4 新增/修改一个页面的标准动作

1. 先看 `lib/api.ts` 里有没有对应方法；**缺方法就往 `api.ts` 里加**，别在页面里裸写 `fetch`
   （例外：上传版接口是 JSON + base64，`Convert.tsx` 里就地发了一次，见该处注释）。
2. 用库组件重排界面；结构可以变，**功能与文案不要丢**。
3. 长任务用 `useJob()` + `<JobProgress>`；目录选择用 `<DirectoryInput>` 或 `<DirPicker>`。
4. `npm run build`（在 `app/web-next/`，用 `H:\node\npm.cmd`）；
   在 `/#/<id>` 打开一次，必要时用 `tests/manual/glass-probe.mjs` 截图核对。
5. 跑 `node tests/contract/verify.mjs 8891` 与 `node tests/manual/next-smoke.mjs 8891`。

---

## 4. 后端接口（页面只认这些）

全部在 `lib/api.ts`，绝对路径 `/api/*`。分组：

| 组 | 方法 |
|---|---|
| 基础 | `health` `state` `config` `saveConfig` |
| 工具 | `detect` `launch` |
| 文件 | `fsRoots` `fsList` `fsMkdir` `fsReveal` `fsOpen` |
| 转换 | `collect` `inspect` `preview` `convert` |
| 视频 | `parseVideo` `downloadVideo` |
| 音频 | `audioProbe` `audioRun` |
| 资源库 | `resources` `checkLinks` |
| 歌词 | `lyricsSearch` `lyricsGet` `lyricsParseLink` `lyricsImport` `lyricsSave` `lyricsCover` `lyricsSms` `lyricsCellphone` `lyricsLogout` |
| 任务 | `jobs` `job` `cancelJob` |

**任务对象**（`/api/jobs/*`）：`{ id, type, title, status, percent(0~100), message, logs[], error? }`，
`status` 的终态是 `done | error | canceled`。

后端契约是**冻结**的：`tests/contract/fixtures/` 是永久基准，
`node tests/contract/verify.mjs 8891` 必须 17/17。要改后端先改夹具并写清理由。

**踩过的契约坑**（旧前端在四处发错了请求体，搬页面时逐个实测翻出来的）：

| 接口 | 要发的 | 发错的后果 |
|---|---|---|
| `convert/collect` | `{ dirs: [...] }` | 发 `{ dir }` → 永远 0 个文件 |
| `convert/preview` | `{ inputs: [...], toFormat }` | 发 `{ toFormat, inputPath }` → 400 |
| `convert/inspect` | `{ inputPath }`（或 `path`） | 字段对不上 |
| `fs/list` | 空 `path` **必须整个省略** | 发 `path=` → 400；回包读 `entries` → 永远空列表 |

`fs/roots` 的字段是 **`name`**（不是 `label`）。

---

## 5. 历史：搬迁那一轮（2026-10-02 完成，留作背景）

8 个页面在 2026-10-02 全部从手写 JS（约 7,200 行）搬到 React（`pages/*.tsx`），
2026-10-02 旧前端整体退役。搬的过程等于把每条接口重新对了一遍后端，翻出并修掉了
上表那四处契约错误，也把「任务面板、目录选择器、表单控件」这些共用件收进了
`components/`。**这一轮的经验教训在 `docs/LESSONS.md`**，这里不再重复。

---

## 6. 验证工具

| 工具 | 管什么 |
|---|---|
| `node tests/contract/verify.mjs 8891` | 后端接口契约（17 项，**必须全绿**） |
| `node tests/manual/next-smoke.mjs 8891` | 8 页逐页渲染：控制台无报错 + 非占位 + 有玻璃面 + 该页文案命中（**必须 8/8**） |
| `node tests/manual/glass-probe.mjs 8891 <light\|dark> <frosted\|half\|liquid>` | 玻璃计算值 + 截图 + 启动画面 + 侧栏高亮块逐帧采样 + 两个导航的对齐 + 滑块拖动 |
| `node tests/manual/pv-verify.mjs [port]` | JIZURA iframe 内的交接（CDP） |
| `node tests/manual/pv-export-probe.mjs [port] [输出目录]` | PV 导出链路 |
| `node tests/manual/convert-samples.mjs [端口] [--dir …] [--only …] [--options …]` | 拿 `tests/samples/` 的真样本跑批量转换 |
| `node tests/manual/lyrics-import-verify.mjs [port]` | 歌词导入（含 GBK） |
| `node tests/manual/storage-verify.mjs` | localStorage 键的落盘形状 |

> 探针截图写在 `tests/manual/out/`（**没有入库**：都是可再生成的 PNG）。

启动测试实例（端口 8891，别碰用户正在开的 17878）：

```powershell
Start-Process -FilePath 'H:\工作站\v-synth-studio.exe' `
  -ArgumentList '--serve','--port=8891' -WindowStyle Hidden
```

跑完**必须**停掉实例并清无头 Edge（见 `AGENTS.md` 的「进程卫生」）。

---

## 7. 人工验收清单（自动化测不到的那些）

自动化能覆盖的已经覆盖了（`next-smoke.mjs` 8/8、契约 17/17）。
**下面这些「要真跑一遍才知道」**，也正是冒烟脚本**测不到**的部分：

> 打开方式：双击 `启动工作站.bat`。

| 页面 | 要真跑一遍的 |
|---|---|
| **总览** | 「重新检测」能刷新工具状态；三个入口按钮跳到对应页 |
| **工程转换** | **拖入**一个真工程（或点「选择文件」按路径挑）→ 选目标格式 → 「开始转换」→ 进度到 100% → 输出目录里真有文件。**预检是手动的**（点「预检」才跑，慢，但不预检也能转）。**转换选项**在折叠面板里，改了确实会进产物（例如 VSQX 版本选 3 → 产物根节点是 `<vsq3>`）。批量：路径批与拖入批会**分两批串行**跑 |
| **视频解析** | 粘一个 B 站链接解析（封面/分P/流）→ 选画质 → 下载 → 文件落盘。**未登录**时确认「填入 Cookie 可解锁 1080P+」的提示在；番剧 ep 链接也能解析 |
| **音频工具** | 选一个音频 → 探测信息出来 → **格式转换**跑一遍出文件；**波形编辑器**：拖动两端裁剪、切开、分段导出；ffmpeg 缺失时的禁用与说明（本机有，可临时改名 `tools/ffmpeg/bin/ffmpeg.exe` 试） |
| **歌词** | 搜一个歌名 → 取词 → 保存 lrc / srt 到目录；本地 `.lrc` 导入（含 GBK 文件）；「用这段歌词做文字 PV」跳过去后歌词确实在 PV 页里（**这条最有价值**，PV 那个 boot 竞态就是在这儿翻出来的） |
| **文字 PV** | 页里 JIZURA 编辑器正常；点「一键生成」有预览；**导出 MP4** 弹目录选择、文件真落盘、体积正常 |
| **资源库** | 搜索、分组筛选、展开/收起；点条目在**系统浏览器**打开；「检查失效链接」——后端目前返回占位（没有 jobId），页面会明确提示「后端还没接上」，**不该是静默失败** |
| **设置** | 玻璃等级滑块 1~4 各档观感；主题三档（跟随系统/明亮/黑暗）；目录与外部工具设置存得下、重启还在 |

**已知的、非阻塞的差异**（不用当 bug 报）：

- 工程转换的 `splitTracks`（每轨导出为独立文件）：后端没接（LibreSVIP 的 `proj split` 可以，但本轮没做）。转换选项本身**已经真的生效**（后端按 `options` 回答 LibreSVIP 的逐题提问，键表见 `docs/FEATURES.md`）。
- 资源库「检查失效链接」：后端 `/api/resources/check` 还是占位响应（阶段 3）。
- 视频页的 `params` 深链（URL 里带参数自动解析）没搬 —— hash 路由没有 params 通道。
- 音频波形编辑器去掉了缩放/平移（整段适应面板宽度），其余操作齐全。
- **点击穿透（真实操作链路）还没有自动化**：`next-smoke.mjs` 只验「渲染 + 文案」，
  按钮点下去会怎样它管不着。这是目前最大的一块空白。
