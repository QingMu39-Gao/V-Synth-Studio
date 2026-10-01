# 新前端（`app/web-next`）—— 结构、约定与迁移手册

> 这份文档是**动 `app/web-next` 之前先读的那一份**。
> 玻璃材质本身的规矩在 `docs/GLASS-HANDOFF.md`；交接优先级只在 `AGENTS.md`。
> 写这份文档的时间点：旧前端 8 页正在往 React 搬（见下面「迁移进度」）。

---

## 1. 为什么有两套前端

| | 旧前端 | 新前端 |
|---|---|---|
| 位置 | `app/web/`（`index.html` + `js/` + `css/`） | 源码 `app/web-next/`，产物 `app/web/next/` |
| URL | `/` | `/next/` |
| 技术 | 原生 ES 模块 + 手写 CSS，**零依赖、零构建** | React 19 + Vite 8 + TS 7 + Tailwind 4（只用了插件，没写工具类） |
| 控件 | `ui.js` 里的工厂函数 | **库 `@ttqtt/liquid-glass-react`** 的组件 |
| 状态 | 全局 `state` 对象 + 各视图自己管 | `App.tsx` 拿一次 `/api/state`，往下传 |

两套**同时在线**，互不影响。切换只改一个 URL 前缀：

- `启动工作站.bat` → `/next/`（**新前端；开发时用这个看更新**）
- `启动工作站.bat --old` → `/`
- 直接双击 `v-synth-studio.exe` → `/`（exe 自身的默认值，刻意留的逃生口）

⚠️ **在用户明确说「可以换」之前，不要改 `app/desktop/src/main.rs` 里 `ui_path` 的默认值。**
那是「exe 默认换成新前端」的开关，属于验收动作，不是开发动作。

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
      format.ts         formatBytes / Duration / Speed / Number / Time / timeAgo
      useJob.ts         任务进度订阅：SSE + 轮询兜底（旧 api.js 的 watchJob）
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

**每个页面的硬性要求**（照抄 `AGENTS.md` 第四节的旧前端要求，React 版同样适用）：

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

### 3.3 玻璃只在哪一层

（详细理由见 `GLASS-HANDOFF.md`）**内容不进玻璃层**：正文、列表、画布用
`Panel`（默认就是玻璃面板，按「玻璃等级」开关决定材质）或库的 `MaterialView`；
**控件才是玻璃**（按钮、分段、工具栏分组）。

- 玻璃等级 1~4 由 `lib/useGlass.ts` 的 `useGlassLevel()` 决定，页面**不要**自己判断材质。
- 背景参数、`--lg-*` 令牌都在 `index.css` 顶部，页面 CSS **一律用令牌**，不要写死颜色。
- 新加类名一律放在**页面自己的 `<Name>.css`** 里（并行开发时不会互相踩）。

### 3.4 迁移旧页面的标准动作

1. 读旧的 `app/web/js/views/<id>.js`（那是**功能清单**，也是文案来源）。
2. 用 `lib/api.ts` 里对应的方法（**不要新增 fetch**；缺方法就往 `api.ts` 里加，路径照旧 `api.js`）。
3. 用库组件重排界面。**结构可以变，功能与文案不要丢。**
4. 旧页面里 `watchJob` 的地方 → `useJob()` + `<JobProgress>`。
5. 旧页面里 `pickDirectory` 的地方 → `<DirectoryInput>` 或 `<DirPicker>`。
6. `npm run build`（在 `app/web-next/`，用 `H:\node\npm.cmd`）；
   在 `/next/#/<id>` 打开一次，用 `tests/manual/glass-probe.mjs` 截图核对。
7. 跑 `node tests/contract/verify.mjs 8891` 与 `tests/manual/ui-smoke.ps1`（**旧前端不能红**）。

---

## 4. 后端接口（页面只认这些）

全部在 `lib/api.ts`，绝对路径 `/api/*`（**不是** `/next/api/*`）。分组：

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

---

## 5. 迁移进度：**8 页全部搬完**（2026-10-02）

| 页面 | 旧文件 | 新文件 | 行数 | 状态 |
|---|---|---|---|---|
| 总览 | `views/dashboard.js` | `pages/Dashboard.tsx` | 262 | ✅ |
| 设置 | `views/settings.js` | `pages/Settings.tsx` | 444 | ✅ |
| 资源库 | `views/resources.js` | `pages/Resources.tsx` | 661 | ✅ |
| 工程转换 | `views/convert.js` | `pages/Convert.tsx` | 741 | ✅ |
| 歌词 | `views/lyrics.js` | `pages/Lyrics.tsx` | 937 | ✅ |
| 视频解析 | `views/video.js` | `pages/Video.tsx` | 1462 | ✅ |
| 音频工具 | `views/audio.js` | `pages/Audio.tsx` | 2064 | ✅ |
| 文字 PV | `views/pv.js` | `pages/Pv.tsx` | 600 | ✅ |

每页自带 `<Name>.css`；`next-smoke.mjs` 逐页断言已全绿。
**exe 默认界面仍未切换**（`main.rs` 的 `ui_path`）—— 那是验收动作，等用户拍板。

### 迁移时修掉的真问题（都在旧前端里，值得记一笔）

搬的过程等于把每条接口重新对了一遍后端，于是翻出四处**旧 `api.js` 与 Rust 后端不符**的包装：

| 接口 | 旧前端发的 | 后端要的 | 后果 |
|---|---|---|---|
| `convert/collect` | `{ dir, recursive }` | `{ dirs: [...] }` | **旧界面「从目录收集」永远 0 个文件**（实测 `{dir}`→0、`{dirs}`→命中） |
| `convert/preview` | `{ toFormat, inputPath }` | `{ inputs: [...], toFormat }` | 预检直接 400 |
| `convert/inspect` | `{ path }` | `{ inputPath }`（或 `path`） | 能跑，但类型/字段对不上 |
| `fs/list` | 回包读 `entries` | 回 `{ dirs, files }`；空 `path` **必须省略**（发 `path=` → 400） | 目录选择器永远空列表 / 「此电脑」点进去白屏 |

`fs/roots` 的字段是 **`name`**（不是 `label`）。新前端已全部按后端契约写；
旧前端的 `collect` 也顺手修了（`app/web/js/api.js`）。

### 还没做的（按优先级）

1. **`ui-smoke.ps1` 覆盖新前端** → 已由 `tests/manual/next-smoke.mjs` 接上（逐页断言），
   但它测的是「渲染 + 文案」，**点击穿透（真实操作链路）还没有自动化**。
2. **exe 默认界面切换**：改 `main.rs` 的 `ui_path` 默认值（**等用户确认**）。
3. 切完之后旧前端整体退役：`app/web/js/`、`app/web/css/`、`docs/LEGACY-UI.md` 可一起删。

---

## 6. 验证工具

| 工具 | 管什么 |
|---|---|
| `node tests/contract/verify.mjs 8891` | 后端接口契约（17 项，**必须全绿**） |
| `powershell -File tests/manual/ui-smoke.ps1 -BaseUrl http://127.0.0.1:8891` | **旧前端** 8 页渲染 + 关键字 |
| `node tests/manual/glass-probe.mjs 8891 <light\|dark> <frosted\|half\|liquid> [覆盖] [页面]` | **新前端**：玻璃计算值 + 截图 + 启动画面 + 侧栏高亮块逐帧采样 + 两个导航的对齐 + 滑块拖动 |
| `node tests/manual/pv-verify.mjs` | JIZURA iframe 内的交接（CDP） |

启动测试实例（端口 8891，别碰用户正在开的 17878）：

```powershell
Start-Process -FilePath 'H:\工作站\v-synth-studio.exe' `
  -ArgumentList '--serve','--port=8891','--ui=next' -WindowStyle Hidden
```

跑完**必须**停掉实例并清无头 Edge（见 `AGENTS.md` 的「进程卫生」）。
