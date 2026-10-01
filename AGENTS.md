# AGENTS.md —— 给接手这个项目的开发者 / 智能体

**先读这一份，再动手。** 这里写的是「看代码看不出来」的东西：架构为什么长这样、
踩过哪些坑、下一步该往哪走。`README.md` 只讲产品与使用。

---

## 一、这是什么

**V-Synth-Studio** —— 给翻调（VOCALOID/UTAU 等歌声合成）用的桌面工具。

> **改名历史**：本项目原叫「清沐的虚拟歌姬工作站」，2026-09 改为 V-Synth-Studio。
> `QingMu39` 是**作者署名**，不是软件名，保留不动。
> **存储键与配置目录刻意没跟着改**（`qingmu.theme` / `qingmu.pv.*` /
> `%APPDATA%\com.qingmu.vocalworkstation`）—— 改了老用户的主题偏好、PV 歌词交接
> 和全部配置就丢了。看到 `qingmu` 不要以为是漏改的。

功能：工程格式互转（40 种）、视频解析下载、音频处理、歌词获取、文字 PV 生成、资源导航。
全部离线，工程文件不出本机。

---

## 二、架构

### 一个进程（运行时不依赖 Node）

```
┌─ Tauri 2 外壳（原生窗口）
│   └─ 同进程内嵌 axum HTTP 服务（http://127.0.0.1:17878）
│        ├─ 提供 REST API（39 条路由）
│        └─ 伺服前端静态文件（app/web/）
└─ 窗口用 WebviewUrl::External 加载那个本地地址
```

**关键点**：窗口加载的是 `http://127.0.0.1:<port>`，**不是** Tauri 标准的
`frontendDist` 内嵌方式。所以 `app/web/` 是**每请求从磁盘读**的 —— 改了
HTML/CSS/JS 刷新就生效，**不需要重新编译**。

`frontendDist: "./dist"` 只是个错误页，别被它误导。

**历史上是 Node 后端，已全部重写成 Rust。** 运行时没有 `node.exe`。
（`node` 现在出现在**构建期**：前端走 Vite，见第三节。别和运行时的 Node 搞混。）

### 目录

```
app/
  desktop/            Tauri + Rust 后端
    src/
      main.rs         入口：选端口、开窗口、resolve_paths
      net.rs          共用 HTTP 客户端 + DEFAULT_UA
      platform.rs     跨平台路径、下载目录、回收站、find_binary
      tools.rs        外部工具检测（ffmpeg / yt-dlp / python / 编辑器路径表）
      libresvip.rs    LibreSVIP 引擎封装（转换 + 读工程）
      lyrics.rs       歌词：搜索 / 取词 / LRC-SRT / 短信登录
      bili.rs         B 站原生解析（WBI 签名、DASH、番剧）
      ytdlp.rs        yt-dlp 桥接
      audio.rs        音频处理（ffmpeg）
      data.rs         静态数据（格式表、拼音）
      server/
        mod.rs        路由表（改路由来这里）
        simple.rs     health / state / config / fs / jobs / 静态文件
        convert.rs    工程转换
        media.rs      视频解析下载 + 音频
        lyrics.rs     歌词相关路由
        tools.rs      工具检测
    tauri.conf.json   窗口、打包、resources
    build.ps1         唯一的构建入口（见下文）
  web-next/           前端**源码**（React + Vite + TS + Tailwind）—— 正在迁移中
    vite.config.ts    base '/next/'，outDir '../web/next'
                      ⚠️ 含 restoreStandardBackdropFilter 插件（lightningcss 会删标准
                      backdrop-filter），别删，见 docs/GLASS-HANDOFF.md §3.1
    src/
      main.tsx        入口（引库的 style.css + 我们的 index.css，**顺序不能改**）
      App.tsx         外壳：顶栏 / 侧栏 / 导航 / 主题与材质开关 / 路由（hash）
      index.css       **零手写玻璃**：只排布局，颜色全用库的 --lg-* 令牌
      components/
        Glass.tsx     玻璃材质（库的 GlassSurface 包装）+ materialOptions()
        Panel.tsx     Panel(库的 MaterialView) / GlassPanel(玻璃面) / Chip / Finding / Stat
        Button.tsx  Field.tsx  Icon.tsx
      lib/
        api.ts        后端调用（注意 API 在根路径 /api/*，不是 /next/api/*）
        useGlass.ts   材质 store（毛玻璃 / 液态玻璃，键 qingmu.glass）
        types.ts
      pages/          Dashboard.tsx  Settings.tsx  Placeholder.tsx
```

> ⚠️ **目录树里这几个文件已经不存在了**：`lib/useTheme.ts`、`lib/usePerfMode.ts`。
> 主题与「降低透明度」现在都在 `App.tsx` 里，直接喂给库的 `GlassProvider`
> （`theme` / `transparency` 两个 prop）。`perfMode` 这个 config 字段后端有，
> **新前端还没接**。详见 `docs/GLASS-HANDOFF.md`。
  web/                前端**产物 + 旧前端**（后端伺服的就是这个目录）
    next/             ← 新前端的构建产物（Vite 输出 app/web/next/），浏览器访问 /next/
    index.html        旧前端入口（访问 /）
    css/  base.css（设计令牌 + 外壳）/ components.css / views.css
    js/
      main.js         路由、导航、状态、启动画面揭开
      theme.js        主题唯一入口
      api.js          所有后端调用
      ui.js           组件工厂（h/mount/button/card/chip/modal/toast…）
      timecode.js
      components/     dirPicker / waveEditor / jobDock
      views/          dashboard convert video audio lyrics pv resources settings
    vendor/jizura/    JIZURA 文字 PV（上游构建产物 + 2335 个字体）
    img/bg/           桌面背景图（明亮/黑暗）
    img/logo.png      顶栏图标（源 app/desktop/icons/128x128.png，拷进来才伺服得到）
  data/                只读数据：resources.json / pinyin.json（schema 见第七节）
tools/                 随包分发：ffmpeg / yt-dlp / LibreSVIP（约 390 MB）
tests/
  contract/            接口契约（对冻结的夹具）
  manual/              浏览器 / 接口探针
docs/                  THIRD-PARTY-NOTICES.md
```

### 路径模型（这段很重要）

`main.rs` 的 `resolve_paths()` 按顺序找应用根目录：

1. Tauri 的 `resource_dir()`（安装版）
2. 从 exe 往上找（绿色版）
3. 从 cwd 往上找（开发时）

找到后再判断 `is_writable(<root>/app/data)` 区分**绿色版**还是**安装版**：

| | 绿色版 | 安装版 |
|---|---|---|
| 只读资源 | `<root>/app/`、`<root>/tools/` | 同左（Program Files，只读） |
| 可写数据 | `<root>/app/data/` | `%APPDATA%/com.qingmu.vocalworkstation/` |

**判断依据是「能不能写」，不是「装没装」。** 曾经因为 `resource_dir()` 在绿色版
也返回 exe 目录，导致绿色版被误判成安装版、配置写到 `%APPDATA%` 去了。

> ⚠️ **`find_app_root()` 这套「往上找」的逻辑已经出问题了**，见第八节。

---

## 三、构建

| 事项 | 必须这样做 |
|---|---|
| 编译 | **只能** `powershell -ExecutionPolicy Bypass -File app\desktop\build.ps1` |
| | 直接 `cargo build` **不会**把 exe 复制到根目录，你跑的还是旧的，会以为改动没生效 |
| `-Release` / `-Bundle` | 可选参数；`-Bundle` 打 MSI（见第八节） |
| `-SkipWeb` | 只编后端（改 Rust 时省几秒，但 `/next/` 会是旧产物） |
| 工具链 | Rust 在 `H:\DevTools\cargo`、MSVC 在 `H:\VSBuildTools`（build.ps1 会加载 vcvars） |
| | **前端还要 Node + npm**（见下）—— 这是新前端引入的**构建期**依赖 |

### Node 只在构建期出现（别和"去 Node"搞混）

项目历史上把 Node 后端整体重写成 Rust，去掉的是**运行时**的 Node：

| 环节 | 需要 Node 吗 |
|---|---|
| 用户运行打包好的 exe | **不需要** —— 产物是静态 HTML/JS/CSS，exe 是 Rust |
| 后端运行时 | **不需要** —— 39 条路由全在 Rust，`node.exe` 进程数为 0 |
| **编译前端**（`build.ps1` 第一步） | **需要** —— Vite 是 Node 工具 |

`app/web-next/node_modules/` 约 91 MB，**但不进安装包**：
`tauri.conf.json` 的 `resources` 只映射 `../../app/web`（Vite 产物里不含依赖），
`web-next` 一个字都没被映射。**往 `bundle.resources` 里加东西时别把 `web-next` 加进去。**

启动器/CI 里任何"这台机器没有 Node"的假设都已失效 —— 编译机必须有。

### 切换界面（旧前端 / 新前端）

窗口加载的是**一个 URL 前缀**，所以切界面不用重新编译（前端每请求从磁盘读）。

| 启动方式 | 界面 |
|---|---|
| `启动工作站.bat` | **新前端**（React，`/next/`）—— 启动器默认 |
| `启动工作站.bat --old` | 旧前端（`/`） |
| 直接双击 `v-synth-studio.exe` | 旧前端（**exe 自身的默认**，是刻意的兜底逃生口） |
| `v-synth-studio.exe --ui=next` \| `--ui=old` | 显式指定 |

也可以不起窗口，浏览器开 `http://127.0.0.1:17878/next/`。

**启动器默认新前端、exe 默认旧前端** —— 这是故意的：命令行/快捷方式直接跑 exe 的人
（和打包后的正常用户）拿到功能完整的旧界面，而开发时双击启动器就进新界面。

**两套界面同时都在**，互不影响。等 8 页搬完、验收通过，改 `main.rs` 里 `ui_path`
那段的默认值，exe 的默认也就跟着换了，一处改动完成切换。

### 文件编码

| 文件 | 要求 | 不遵守会怎样 |
|---|---|---|
| `.ps1` | **UTF-8 带 BOM** | PS 5.1 把中文注释按 ANSI 读 → 乱码吞掉换行 → 语法错 |
| `.bat` / `.cmd` | **CRLF** | cmd 解析不了 LF，命令会拆错 |
| `.bat` / `.cmd` | **逻辑块只用 ASCII** | 见下，中文会让 cmd 冒出假报错、甚至弄坏分支判断 |

⚠️ **用编辑工具改 `.ps1` 会丢 BOM。** 改完检查头三字节是不是 `EF BB BF`。
已经踩过一次：`build.ps1` 被编辑器存成无 BOM，中文注释全变乱码。

```powershell
node tests\manual\fix-ps1-bom.mjs          # 只报告缺 BOM 的 .ps1
node tests\manual\fix-ps1-bom.mjs --write  # 补上
```

⚠️ **`.bat` 里的中文只能出现在 `echo` 行，别的地方一律 ASCII。** 踩过两次：

1. `REM` 注释里有中文 → 跑起来冒出一串假的
   `'xxx' is not recognized as an internal or external command`
2. **`if/else` 块里的 `echo` 带中文 → 不只冒噪音，还会弄坏分支判断本身**：
   `if /i "%~1"=="--old"` 明明该命中，却一直走 `else` 分支。
   多行括号块遇到多字节 UTF-8 时 cmd 的解析会出错。

修法：**把判断逻辑和中文彻底分开** —— 逻辑用纯 ASCII 的 `if`/`goto`，
中文只留在块外的单行 `echo`，或者干脆让程序自己报（用户看到窗口就知道是哪个界面）。

改 `.bat` 之后必须确认这几件事：

```powershell
# 行尾 CRLF、无 BOM、非 echo 行里不能有非 ASCII
$t = [IO.File]::ReadAllText('启动工作站.bat', [Text.Encoding]::UTF8)
$t.Contains("`r`n")                                      # 要 True
[regex]::IsMatch($t, "(?<!`r)`n")                        # 要 False（没有裸 LF）
($t -split "`r`n" | Where-Object { $_ -match '[^\x00-\x7F]' -and $_ -notmatch '^\s*echo' }).Count  # 要 0
```

**光看代码不够 —— 必须真的把两条分支都启动一次**，并看 `app/data/app.log` 里那行
`界面：...` 确认选中了预期的界面。上面第 2 条坑就是静态检查全绿但分支是坏的。

- **`write` / `edit` 工具会把 `.bat` 存成裸 LF** —— 改完必须转回 CRLF，否则 cmd 直接把命令拆错
- 反过来 `edit` 会保留已有行尾，但**不敢保证**，所以每次都验一遍

### 前端构建（app/web-next）

**`build.ps1` 已经接好 Vite 了**，正常只需要跑它一个：

```powershell
powershell -ExecutionPolicy Bypass -File app\desktop\build.ps1
#   → ① npm run build（app\web-next → app\web\next）
#   → ② cargo build  + 复制 exe 到根目录
```

单独弄前端时：

```powershell
cd app\web-next
npm install     # 首次
npm run build   # tsc -b && vite build → 产物落 ../web/next/
npm run watch   # 开发时推荐：改完自动重建，浏览器刷新即可
```

`-SkipWeb` 只编后端（改 Rust 时省几秒，但 `/next/` 会是旧产物）。

⚠️ **npm 的选取有讲究**：`build.ps1` 优先用 `H:\node\npm.cmd`（自装 Node），
其次 `%ProgramFiles%\nodejs`，最后才退回 PATH 搜索。**不要改成直接取 PATH 里第一个** ——
本机 PATH 第一顺位是 DSH 运行时自带的 `...\resources\node\`，DSH 一升级就没了。
另外 `Get-Command npm.cmd` 在本机**命中 2 个**，直接取 `.Source` 会拿到数组并拼成垃圾字符串
（踩过，报错信息是 `The term '...npm.cmd H:\node\npm.cmd' is not recognized`）。

工具链（本机实测可用）：

| | 版本 | 说明 |
|---|---|---|
| Node | v24.18.0 | **只有开发机需要**，用户那边不用装 |
| npm | 11.16.0 | |
| React / react-dom | 19.3 | |
| Vite | 8.3 | |
| TypeScript | **7.0** | ⚠️ TS 7 移除了 `baseUrl`，`paths` 改成相对 tsconfig 解析 |
| Tailwind | 4.3 | 用 `@tailwindcss/vite` 插件（v4 不需要 postcss/tailwind.config） |

---

## 四、前端（旧前端 —— 正在被 React 版取代）

**运行时不依赖任何第三方 JS**：原生 ES 模块 + 手写 CSS，没有 npm 依赖、没有构建步骤。
（说的是**旧前端**；新前端要过 Vite。见第三节。）

> **这一节描述的是 `app/web/js/` 那套旧前端**，它现在仍伺服在根路径 `/`，照常可用。
> 新前端的源码在 `app/web-next/`（React + Vite + TS + Tailwind），构建产物 `app/web/next/`，
> 访问 `/next/`。两者并行存在，一页页往新前端搬（见第十一节）。
> 搬完后这一节整节作废。

### 视图契约

`app/web/js/views/<id>.js` 必须导出：

```js
export async function render(ctx) {
  // ctx = { container, headerActions, params, state, navigate, refreshState }
  // container   : 主内容区元素（已清空，直接往里 mount）
  // headerActions: 顶栏右侧动作区（可放按钮/徽章）
  // state       : 全局状态快照（见下）
  // navigate(id) : 切换到其它视图
  // 返回值：可选。返回函数会被当作 cleanup（离开视图时调用，用于关闭 SSE / 定时器）
}
export default { render }
```

参考实现：`views/convert.js`（功能最全）、`views/dashboard.js`。

### 可用模块

```js
import { api, watchJob } from '../api.js'
import { h, mount, clear, icon, iconHtml, toast, modal, confirmDialog, promptDialog,
         button, switchToggle, progressBar, emptyState, alertBox, statBlock, card, tabs, segmented,
         formatBytes, formatDuration, formatSpeed, formatNumber, formatTime, timeAgo } from '../ui.js'
import { pickDirectory, directoryInput } from '../components/dirPicker.js'
```

- `h(tag, props, children)` —— `tag` 支持 `'div.card.hoverable'` 点号语法；
  `props` 里 `onclick`/`oninput` 等直接绑定，`html` 设 innerHTML，`class`/`style`(对象)/`dataset` 都支持。
- `toast(msg, 'ok'|'err'|'warn'|'info')`
- `watchJob(jobId, { onUpdate, onDone, onError, onCancel })` —— SSE 订阅任务进度，
  断开自动退回轮询；**离开视图时务必调用返回的停止函数**。

### 可用 CSS 类（已在三个 css 里定义，不要重复造）

| 用途 | 类名 |
|---|---|
| 卡片 | `.card`、`.card.hoverable`、`.card-head`、`.card-icon`（`.pink/.purple/.warn/.info`） |
| 栅格 | `.grid.grid-2 / .grid-3 / .grid-4`、`.row`、`.row-wrap`、`.col`、`.gap-sm`、`.gap-lg`、`.spacer` |
| 按钮 | `.btn`、`.btn-primary`、`.btn-pink`、`.btn-ghost`、`.btn-danger`、`.btn-sm`、`.btn-lg`、`.btn-icon`、`.btn-block`；加载态加 `.loading` |
| 表单 | `.field`、`.field-label`、`.field-hint`、`.input`、`.select`、`.textarea`、`.input-group`、`.checkbox`、`.switch(.on)` |
| 标签 | `.chip`（`.accent/.pink/.purple/.ok/.warn/.err/.info`）、`.badge`、`.chip-group` |
| 列表 | `.list`、`.list-item`、`table.data` |
| 进度 | `.progress` + `.progress-bar`（`.done/.error/.canceled`），或用 `progressBar()` |
| 提示 | `.alert.alert-warn/.alert-err/.alert-ok/.alert-info`、`.finding.warn/.finding.info` |
| 空态/骨架 | `.empty`、`.empty-icon`、`.skeleton` |
| 拖放 | `.dropzone`、`.dropzone.dragover`、`.dropzone-icon` |
| 标签页 | `.tabs` + `.tab(.active)`、`.segmented` |
| 其它 | `.log`、`.code-block`、`.stat*`、`.divider`、`.truncate`、`.muted`、`.dim`、`.small`、`.tiny`、`.strong`、`.mono`、`.link-card*`、`.video-*`、`.stream-*`、`.op-card`、`.res-*`、`.settings-*`、`.job-row`、`.stagger` |

### 明暗双主题（写视图必须知道）

- 令牌集中在 `base.css` 顶部：`:root` 是**暗色**，`[data-theme="light"]` 覆盖成**亮色**。
  **两套都要能看** —— 别写死颜色，也别假设背景一定是深的。
  写死 `#fff` / `rgba(255,255,255,.05)` 这类值在亮色下会直接瞎掉。
- 语义色一律用令牌：正文 `--text-0/1/2/3`、面板底 `--glass`/`--surface`/`--panel`、
  分隔线 `--hairline` 与 `--border`、代码块/日志底 `--sunken`、强调 `--accent`/`--pink`/`--purple`/`--ok`/`--warn`/`--err`/`--info`。
  语义色带描边时用 `color-mix(in srgb, var(--err) 30%, transparent)` 推
  （老 WebView2 不认 `color-mix`，声明会被丢掉、退回灰边，是安全的降级）。
- 浅底上的文字用 `--warn-fg` 这类「配浅底的文字色」，直接拿 `--warn` 当正文色在亮底上会读不清。
- 圆角 `--radius-lg/--radius/--radius-sm/--radius-xs`；阴影 `--shadow-sm/--shadow/--shadow-lg`（亮色下自动变轻）；
  动效 `--dur-fast/--dur/--dur-slow` 与缓动 `--ease`（微交互）/ `--ease-out`（入场）/
  `--spring`（**仅限抽屉、模态这类大位移；别用在缩放上**，过冲 56% 会抖 —— 见第六节）。
- 高斯模糊（`backdrop-filter`）**只给固定的少数元素**：侧栏、顶栏、模态遮罩与面板、toast、
  悬浮任务条、吸顶工具条、气泡提示。**列表里的卡片一律不加**（很贵，滚动会卡），
  且必须在 `base.css` 末尾的 `@supports not` 段里有一条不透明兜底。
- 画在 canvas 上的东西（如 `components/waveEditor.js`）拿不到 CSS 变量，
  要么在 `qm:theme` 事件里重取调色板，要么比对 `document.documentElement.dataset.theme` 后重画。
- 主题由 `js/theme.js` 统一管：`themePref()`（可能是 `'system'`）、`currentTheme()`、
  `applyTheme(pref)`、`toggleTheme()`。**不要自己去写 `localStorage` 或 `data-theme`。**
  取值同时写 localStorage（首次绘制前生效，不闪）与后端 `config.theme`。

### 状态与接口

`state` 字段：`formats[]`（含 `available/canRead/canWrite/exts`）、`editors[]`（含 `installed/path/color`）、
`tools.{ffmpeg,ytdlp,python}`、`audioFormats{}`、`config`、`paths.{root,outputDir,downloadDir,toolsDir}`、
`platform`、`version`、`transformOps[]`、`pinyin{}`。

> **`state.voices` 已移除**。声库探测整个删掉了 —— 它只被用来「显示装了什么」，
> 转换路径从头到尾没调用过。
>
> **`state.editors` 只剩 UVR**（音频页的人声分离要跳过去）。不要再写「编辑器列表」这类界面。
>
> **外部工具随程序打包分发**，不再联网下载。`/api/tools/install` 恒定返回 400；
> 界面上不要提供「一键获取」按钮，改成说明文字。但 `tools?.ffmpeg?.available`
> 这类**能力判断要保留** —— 工具真缺失时靠它禁用功能。

`api` 可用方法（后端已实现，参数即请求体）：

```js
// 视频
api.parseVideo({ url, cookie })          // B站走原生解析，其它站点走 yt-dlp
api.downloadVideo({ url, source, outDir, mode:'video'|'audio', quality, audioQuality,
                    downloadCover, downloadDanmaku, downloadSubs, formatId, page, cookie })
// 音频
api.audioProbe(input)                    // { info: { durationSec, audio:{...}, video:{...} } }
api.audioRun({ action, input, output, options })
//   action: 'convert'|'extract'|'pitch'|'tempo'|'trim'|'normalize'
//   convert 的 options: { format:'wav'|'wav24'|'flac'|'mp3'|'m4a'|'ogg'|'opus', sampleRate, channels }
//   pitch {semitones} / tempo {ratio} / trim {startSec,endSec} / normalize {targetLufs}
// 资源库
api.resources(reload)、api.checkLinks(ids)
// 工具 / 文件
api.detect(force)、api.launch({ path })
api.fsList(path)、api.fsRoots()、api.fsReveal(path, select)、api.fsOpen({ path|url })
api.saveConfig(patch)
// 歌词
api.lyricsSearch({ source, keyword })    // source: 'netease'|'qq'
api.lyricsGet({ source, id })
api.lyricsParseLink({ url })             // 先判 QQ songmid 再判网易云 id=，顺序不能反
api.lyricsImport({ path })               // 本地 .lrc，含 encoding:'utf-8'|'gbk'|'unknown'
api.lyricsSave({ source, id, lyric, trans, durationSec, format:'lrc'|'srt', bilingual, outDir, name })
api.lyricsCover({ url, outDir, name })
api.lyricsSms(phone)、api.lyricsCellphone(phone, captcha)、api.lyricsLogout(source)
```

**B 站解析返回**：`{ source, kind:'video'|'bangumi', info, currentPage, streams, hasCookie }`。
`info` 含 `bvid/aid/title/cover/desc/durationSec/uploader/publishDate/view/pages[]/season`；
番剧有 `info.episodes[]`。`streams.mode === 'dash'` 时有 `streams.video[]` 与 `streams.audio[]`
（各含 `id/qualityName/bandwidth`，视频另含 `width/height/codecs`）。未登录时高画质不可用，
界面要提示「填入 Cookie 可解锁 1080P+」。

**文字 PV 写文件**：`POST /api/pv/save?dir=<已存在目录>&name=<文件名>&part=<第几块，从 0 起>`，
body 是**裸字节**（不是 JSON、不是 base64），单块上限 16MB，前端按 8MB 切。
返回 `{ path, name, size, part }`；part=0 新建（同名自动加 (1)(2)，不覆盖），之后追加。

### 文字 PV 页的交接（`views/pv.js`）

整页就是一个 iframe，指向 `/vendor/jizura/index.html` —— JIZURA
（<https://github.com/852wa/JIZURA>，MIT）的**构建产物**随包分发在 `app/web/vendor/jizura/`，
与主界面同源，所以父页面可以直接操作它的 DOM。**它的界面一个字都不改**，升级就整份替换那个目录。

- 页内交接用 `localStorage`（键 `qingmu.pv.lyrics`）：`params` 只在这一次导航里有效，F5 就没了。
  歌词页写，PV 页读；PV 页填完把同一份内容写进 `qingmu.pv.sent`，同一份歌词不再重复填。
- 填入方式：它的歌词框是 `<textarea id="lyrics">`，`bind()` 里挂了 `input` 监听，
  所以**改 value 必须同时派发冒泡的 `input` 事件**，否则它内部状态不变、预览不重排。
- **写进去之后要按「读回值」收敛，不要写死时间表**：它的 `boot()` 末尾会用 `syncUI()`
  把 `S.project.lyrics` 覆盖回输入框，所以第一次写进去会被顶掉，得补写。
  早先是一串固定的 `setTimeout`（0/400/1000/2000/3500ms），页面被**定时器节流**时
  （无头环境实测一次 250ms 的等待能变成 6.9 秒）整轮拖到二十多秒，状态栏一直停在
  「正在读取…」，用户看着就是导入卡死。现在改成轮询到「读回值一致」，
  并且**读到「内容在、但不是我们写的」就说明它的 boot 已经跑完**，补一次再等 600ms 就收工。
- **导出 MP4 的保存路径由父页面接管**：它的所有保存都过 `J.saveFile(name, blob)`，
  父页面在 iframe boot 完后把这个函数换掉，改弹 `pickDirectory`，选完分块 POST 到
  `POST /api/pv/save`。返回 `'saved'` 是为了不让它再走一遍浏览器下载。
- 字体已本地化成 `vendor/jizura/fonts.css` + `fonts/`（Google Fonts 按 unicode-range
  切了 2335 个子集）。`index.html` 里**不能再出现 `fonts.googleapis.com`** ——
  它还会在运行时按 family 惰性插 `<link>` 到 Google，那段被末尾一小段脚本改写成 `fonts.css`。

### 硬性要求

- 全部文案中文，语气务实、不要营销腔。
- **任何失败都要能被用户看到**：`try/catch` + `toast(err.message, 'err')`，不要静默吞异常。
- 长任务一律用 `watchJob` 显示进度条 + 日志。
- 缺少外部依赖时不要只报错：说明**怎么恢复**，并禁用依赖它的功能。
  **不要引导用户去下载** —— 境内下不动，这个程序从一开始就不该让用户自己折腾环境。
- 界面要「流畅」：切换视图不要闪烁，列表用 `.stagger` 做交错入场，操作后给即时反馈。
- **语法自检（必须做）**：

  ```powershell
  Copy-Item app\web\js\views\xxx.js $env:TEMP\check.mjs
  node --check $env:TEMP\check.mjs
  ```

  ⚠️ **不要直接 `node --check xxx.js`，它是假通过的。** 实测（Node v24.18.0）：
  一个故意写坏的 `.js` 返回退出码 0 且无输出，同一个文件改名成 `.mjs` 才报出
  `SyntaxError`。这个坑真实发生过：`dashboard.js` 少了一个 `})`，
  `node --check *.js` 全绿，但**整个总览页加载失败**，问题在 HEAD 里待了一轮才发现。

  **所以除了语法检查，改完视图一定要用浏览器实际打开一次。**

### 界面改版的教训（别再重复）

总览页已经按「结构改、不是参数改」重做过一轮（`.dash-bento` / `.tile`，
旧的 hero 卡 + 四等分已删除）。此前**失败过四轮**，值得记下来：

| 轮次 | 做了什么 | 为什么看起来「没变」 |
|---|---|---|
| 1 | 配色、高斯模糊、弹性动效、双主题 | 纯装饰，结构一行没动 |
| 2 | 圆角、阴影调大 | 还是装饰 |
| 3 | 骨架改成「两片浮起的面板」 | 结构变了，但组件形状没变 |
| 4 | 尺度抬高（字号/间距/导航行高） | 密度变了，但「是什么」没变 |

**结论：参数改一百处也改不出另一种设计语言。** 真正要动的是**组件层**：
卡片该不该存在、导航是什么形态、栅格要不要等分、一屏放多少信息。
这些要改 `views/*.js` 的渲染结构（配合 `ui.js` 的组件工厂），**不是 CSS 能覆盖的**。

---

## 五、怎么验证

```powershell
# 启动测试实例（端口用 8891，别和用户正在开的实例打架）
$p = Start-Process -FilePath 'H:\工作站\v-synth-studio.exe' `
     -ArgumentList '--serve','--port=8891' -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 8

# 1) 接口契约（对冻结夹具）—— 应 17/17
node tests\contract\verify.mjs 8891

# 2) 八个页面渲染 + 关键字断言 —— 应 8/8
powershell -ExecutionPolicy Bypass -File tests\manual\ui-smoke.ps1 -BaseUrl http://127.0.0.1:8891

# 3) Rust 单测
cd app\desktop; cargo test --bins      # 应全绿
```

- 契约夹具在 `tests/contract/fixtures/`（17 个），是 Node 后端还在时抓的真实响应，
  **永久基准**。`verify.mjs` 逐字段 diff，并把「有意差异」列在 `INTENDED` 白名单里 ——
  **加条目要写清理由，它很容易变成掩盖问题的垃圾桶**。
- `ui-smoke.ps1` 会断言每页的关键字（如总览要有「欢迎回来」「格式支持」）。
  **改页面文案会让它红**，改文案前先看它断言了什么。
- `--serve` 模式只跑服务不开窗口，专门给测试用。

### 浏览器验证的坑

| 坑 | 说明 |
|---|---|
| 无头模式 | 必须 `--headless=old`（本机 `--headless=new` 报 Multiple targets 起不来） |
| `--disable-gpu` | **只对截图有害**：带着它 `backdrop-filter` 会糊成一片空白。<br>`ui-smoke.ps1` 里带了它没关系 —— 那条路只 dump DOM，不看画面对不对 |
| `--dump-dom` 看不到 iframe 内部 | 要验 iframe 里的东西必须用 CDP（`--remote-debugging-port` + Node 自带 WebSocket，不要装包）。参考 `tests/manual/pv-verify.mjs` |
| 端口 | 正式启动是 17878，**测试用 8891** |

### 进程卫生

跑完测试**必须**停掉测试实例、清掉无头 Edge（不清会锁住 exe 让别人编译失败；
无头 Edge 每个约 60–100 MB，会堆到十几个）：

```powershell
$c = Get-NetTCPConnection -LocalPort 8891 -State Listen -EA SilentlyContinue | Select-Object -First 1
if ($c) { Stop-Process -Id $c.OwningProcess -Force }
Get-Process -Name 'msedge' -EA SilentlyContinue | Where-Object { $_.MainWindowHandle -eq 0 } | Stop-Process -Force
```

⚠️ **杀进程只能按精确 PID 或端口 owner**，别按命令行子串匹配 —— 曾经误杀过 DSH 自己的任务进程。

---

## 六、踩过的坑

### 缓存（曾导致「改了看不到」）

静态文件**必须**发 `Cache-Control: no-store`（`simple.rs` 里已加）。
**曾经一个缓存头都不发**，WebView2 按启发式规则缓存了 CSS/JS —— 于是「改了界面但用户看不到变化」。
**这个 bug 极难自查**：测试每次开全新的无头浏览器，永远命中不了缓存，本地怎么试都是新的，
**只有用户那个常驻的 WebView2 拿着旧文件**。以后凡是「我这边正常、用户说没变」，先怀疑缓存。

### 端口

**固定 17878**（`main.rs` 的 `PREFERRED_PORT`），被占用才退回随机并写 `app.log`。
不能随机：**localStorage 按 origin（协议+主机+端口）隔离**，端口一变就是全新存储空间 ——
JIZURA 的教程标记、界面设置、**PV 工程自动保存**全都会丢。

### CSS

- **`html::after` 做背景层会渲染到内容之上**（Chromium 对 `backdrop-filter` 采样
  `position:fixed` 伪元素的怪癖）。背景层要做成 `body` 内的普通元素。
- **`--glass` 系列令牌（4.5% 白）是给纯色背景设计的**，一旦有背景图就全透、文字没法看。
  有背景图时这些值要单独调。

### Tailwind 工具类：现在一个都没用（原「@theme 半径令牌」那节已删）

新前端的 `index.css` 是**纯手写 CSS**，`@theme` / `rounded-*` / `@layer components` 三件事
**当前都不适用**（Tailwind 插件还挂在 `vite.config.ts` 上，但没人写工具类）。半径刻度归库管：
`--lg-radius-xs/s/m/l/xl/xxl` = 6 / 10 / 14 / 20 / 26 / 34。

⚠️ 真要开始用 Tailwind 工具类，**先回 git 历史里翻这一节**（`git log -p -- AGENTS.md`）：
`@theme inline { --radius-sm: var(--radius-sm) }` 这种同名别名会造成**循环引用**，
整条声明失效、所有控件变直角，而编译/tsc/控制台**都不会报错**；裸 CSS 还会盖掉工具类。

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

**现在的结构**（`App.tsx` 的导航 + `index.css` 的 `.app-nav` 一组）：

```
GlassPanel.app-sidebar        ← **唯一**的框（一层玻璃 + 一条描边 + 一个圆角）
  └ div.app-sidebar-inner
      └ nav.app-nav           ← position: relative（量位置要拿它当基准）
          ├ span.lg-selection-lens.nav-lens  ← 高亮块，**库的组件**，靠 --lg-slot-x/y 滑
          ├ div.nav-group × 3 ← 只是小字，**不参与框选**
          └ button.nav-row × 8 ← 完全透明，自身零描边零底色
```

⚠️ **这一节原先写的 `.nav-rail` / `.nav-thumb` / `.nav-thumb-track` / `data-nav-ready`
在仓库里一个都不存在**（全 git 历史搜过，零命中）—— 那是新前端换库之前的手写玻璃时代，
换库时连同手写玻璃一起被覆盖掉了，文档没跟着改。**现在用的是上一节说的库的透镜。**

**「丝滑」是靠 transform，不是给每项加背景色**：量出选中项相对 nav 的 `offsetTop`，
写进库的 `--lg-slot-y`，那块 span 自己 `translate` 过去 —— 合成层动画，不触发布局重排。

**三个必须注意的点（都会导致可见的 bug，逐条实测过）：**

1. **首帧不能滑。** 第一次量位置时先把 `transition` 关掉，量完 `void lens.offsetWidth`
   强制回流再恢复；否则打开界面会看到一个方块从左上角飞过来。
   （`App.tsx` 的 `useNavLens` 就是这么写的，探针里 `boot.settled` 那条在验它。）
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

### 液态玻璃用现成的库，别自己写

**这条原则仍然成立** —— 用户提供过参考项目，就必须先问「能不能直接用」，别照着原理自己实现（被用户当场指出过）。

⚠️ 但具体用哪个库、怎么接，见 **`docs/GLASS-HANDOFF.md`**：现在用的是 `@ttqtt/liquid-glass-react`，不是这节原文写的 `rdev/liquid-glass-react`（**两个同名包，完全不同的项目**，我装错过）。
**三条血的教训**（用户复报「除了侧栏都没有实现对应的玻璃材质」时定位到的，详见那份文档 §2.2）：

1. **材质要写在 `GlassProvider` 上。** 库的控件（`GlassButton` / `GlassSegmentedControl` /
   `TabBar` …）**不接材质参数**，读的是 policy。只给自家包装的面传，切到液态玻璃时
   只有那两个面变 `clear`、控件还是 `regular` —— 看着就是「只有侧栏有材质」。
2. **背景自身的 `--bg-blur` 必须小（3~4px）。** 背景先糊成奶白，玻璃再糊一次等于没糊。
   **玻璃的观感来自「背后有东西被它糊掉」**，不是来自玻璃自己。
3. **栏本身不画底。** 库的 `GlassToolbar` 注释：「工具栏本身不携带背景 —— 它是一行分组，
   玻璃是每一组」。一整条大玻璃 + 一堆手写平控件 = 屏幕上看不出材质。
   平栏要配 `ScrollEdge`（不给 `targetRef` 即盯页面滚动），否则内容会从文字下面穿过去。
4. **全局玻璃是设置里的开关**（默认开）：关掉就回到 `git tag backup-pre-global-glass`
   那一版的面板材质（`MaterialView`），**背景参数两档共用、不受影响**。
   存在 localStorage `qingmu.globalGlass`，实现是 `lib/useGlass.ts` 的 `useGlobalGlass()`
   + `components/Panel.tsx` 里的分支。

---

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

### 玻璃通透度与背景可见度（旧前端的令牌，新前端不用了）

旧前端 `/` 有一组互相抵消的令牌（`--glass` / `--blur-chrome` / `--blur-panel` /
`--bg-veil` / `--bg-blur`），两条规律都实测过，换个前端也成立：

1. **「通透」靠低不透明度 + 低模糊**，不是靠加大模糊（高模糊 + 高透明 = 一片奶白）。
2. **背景看不见时先看玻璃自身的不透明度**，别只调背景 —— 玻璃 72% 不透明时，
   背景调多亮都会被挡掉大半。

新前端这两样都归库管（材质由 `material` + `size` 决定），不用手调这几个令牌。

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

### 网络

- **GitHub / Google 需要代理**，而**命令行默认不走系统代理**：
  `& curl.exe -x http://127.0.0.1:7890 ...`
- 网易云 / QQ 音乐**直连即可**，不用代理
- **测试短信接口绝不要用真实手机号**（会真的发短信）。只用 `123` 这类明显非法的格式
  验证「接口存在」。这个错犯过。

### 磁盘

**C 盘很紧**（长期只剩几 GB）。临时大文件放 `H:\工作站\tmp-*` 并即时删。

### 图标

`ui.js` 的 `ICON_PATHS` 是手写 SVG path 表，**没有图标库**（要离线）。
加图标就往那张表里加，别去引 CDN。

---

## 七、资源库数据

`app/data/resources.json` 是前端资源库**唯一的数据源**。当前 4 个分组 / 27 条。

```jsonc
{
  "version": 1,
  "updatedAt": "2026-09-26",     // 最近一次校验日期
  "notice": "顶部横幅文案",        // resources.json 里是拒绝收录学习版/破解版的声明
  "verifySummary": {              // 最近一次校验的汇总（由 check-resources.mjs --write 写入）
    "checkedAt": "...", "total": 27, "ok": 22, "warn": 5, "dead": 0, "passRate": 81
  },
  "groups": [ /* 见下 */ ]
}
```

### `groups[]`

| 字段 | 说明 |
|---|---|
| `id` | 分组唯一标识，前端 `icon` 与样式按此绑定，**改动需同步前端** |
| `name` / `description` | 分组标题 / 一句话说明这一栏解决什么问题 |
| `icon` | 图标名（`wave` / `music` / `image` / `app` / `puzzle` / `book` / `shield`） |
| `items[]` | 条目列表，可为空 |

当前 4 组：`project-share`（工程分享，3）、`free-audio`（免费音源/伴奏，6）、
`editors`（编辑器/声库官网，10）、`utau`（UTAU 系与开源歌声合成，8）。

**两条收录规则的区别很重要**：

- **商业产品**：一个公司一条。收了 CeVIO 就不再单列 KAFU 的声库；收了 VOCALOID 就不再单列 Miku / 洛天依。
- **开源 / 免费项目**：有一个收一个（OpenUtau、UTAU、DiffSinger、NNSVS 属这一类）。

### `items[]`

| 字段 | 说明 |
|---|---|
| `id` / `name` / `url` / `home` | 唯一标识 / 显示名 / 主链接（会被校验）/ 域名 |
| `tags[]` | 标签。`free-audio` 分组**必须**含 WAV 相关标签 |
| `region` | 仅三选一：`国内` / `海外` / `均可` |
| `cost` | `免费` / `部分免费` / `付费` |
| `official` | **`true` = 官方或开源项目官方仓库；`false` = 社区/个人项目** |
| `desc` | 对翻调工作流的**实际价值**，不写「这是一个音乐网站」这类空话 |
| `tip` | 可选。使用技巧、坑点、合规提醒 |
| `verified` | 见下 |

### `verified.verdict` 三态

| `verdict` | 状态码 | 前端表现 |
|---|---|---|
| `ok` | 200 / 301 / 302 / 307 / 308 | 正常徽章 |
| `warn` | 403 / 401 / 405 / 429 | 提示徽章 |
| `dead` | 404 / 410 / 超时 / DNS 失败 | 异常徽章，应尽快处理 |
| —— | 其它 5xx | 存疑，需人工确认 |

**为什么 403 不算失效**：Musopen、Pixabay、Dreamtonics 官网、爱给网、Booth 这类**完全正常**的站点，
会对脚本请求返回 403 来拦爬虫。把 403 当死链会误删大量好资源。用户点开浏览器是能正常打开的。

- 重新校验：`node tests\manual\check-resources.mjs [--write]`
  （超时与连接错误自动重试 3 次 —— 境内访问境外站点抖动常见，不重试会把「偶尔慢」误报成「站点有问题」）。
- 库里有个条目带 `skipProbe: true`（`vspx.top`）—— 已知站点挂了，用户明确说不必测连通性。

### 收录原则

1. **只收官方、开源、免费或官方试用渠道。** 绝不收录破解版、学习版、激活器、注册机，
   以及网盘转载的盗版声库与编辑器。
2. **明确黑名单（永久不收录，也不作为「替代方案」间接推荐）**：瑟狐下载站、
   `pan.vocaloid.world`、`vocakey`（vocakey.wikidot.com）。理由两条：收录即等于协助侵权；
   这类来源无法验证安全性（无数字签名、二次打包、常带启动器 exe）。
3. 以「一个想调音的 P 主会不会主动点它」为取舍标准。利用規約 / 使用条款 / 帮助中心 /
   纯营销页 → **不收**；真正能学到东西的教程 → 收。
4. **`desc` 必须写实际价值**，插件类尤其要写清它解决哪个调音环节的什么问题。
5. **宁缺毋滥**：校验不通过的条目直接删除，宁可 15 条真的，不要 30 条假的。
   **不伪造状态** —— 无法访问的如实记录或剔除。

### 历史

早期删掉 `free-alternatives` 分组与 25 条规约/条款类条目；
2026-09 按「收录太多了」的反馈精简，7 组 121 条 → 4 组 27 条
（删掉 `stem-separation`、`character-art`、`plugins` 47 条、`learning`、`safety`）。
详细来源清单见 git：`git log --all -- app/data/resources.json`

---

## 八、已知问题与未完成

| 事项 | 状态 |
|---|---|
| **打包 MSI** | **打出来跑不起来** —— 见下 |
| UTAU Shift-JIS | 纯 Rust 侧不生成 Shift-JIS，默认写 UTF-8 |
| YouTube | 境内不可达，相关功能要走代理（设置页可配） |
| `mime_of` | 不认 `.jpg`，返回 `application/octet-stream`（能渲染，但不规范） |
| `backdrop-filter` 降级 | 无该特性环境的降级方案没做视觉验证 |
| `audio.rs` 顶部注释 | 写着「ffmpeg 不随程序分发」，与事实相反（注释是旧的） |
| Rust 代码行数 | README 曾写「约 5,900 行 / 31 条路由」，**都是旧数字**，现为 39 条路由 |

### 打包卡在哪（这是本次的核心遗留问题）

程序靠 `main.rs::find_app_root()` **往上找 `app/web/index.html`** 定位根目录，
它假定的是「绿色版」布局：

```
<根目录>/
  app/web/          ← 界面（Rust 内嵌服务从磁盘读，不是打包进 exe 的）
  app/data/         ← 配置、资源库、拼音词典
  tools/            ← ffmpeg 302 MB + LibreSVIP 70 MB + yt-dlp 17 MB
```

而 Tauri 的 `bundle.resources` 会把资源**平铺**到 `<安装目录>/resources/` 下，
结构与上面这套对不上，`find_app_root()` 就找不到 `app/web/index.html`。
所以 `tauri.conf.json` 里的 `resources` 现在是空的。

**这个问题不止影响 MSI。** 同一个「往上找」的假定在别的地方也不成立：

- Windows **安装版** → 找不到（就是上面这个）
- **macOS `.app` bundle** → `Contents/Resources/` 布局，同样找不到
- 而 `resolve_paths()` 第一步**本来就写了**「问 Tauri 的 `resource_dir()`」，
  只是因为 `resources` 是空的，这一步实际从没生效，一直在走兜底

**所以正确的修法是换掉「往上找」、真正改用 `resource_dir()`。**
一次修好 MSI + macOS bundle 两件事，还能省掉构建脚本里「把 exe 复制到根目录」那个动作
（Windows 绿色版特有的形态，macOS 上产物是 `.app`，没有这回事）。

`tools/` 约 390 MB，远超一般安装包的舒适区。原则已定：**随包分发**
（不让用户自己下）。剩下的只是「直接塞进 MSI」还是「首次运行释放」。

### 还没实测过

这台机器没装 `tauri-cli`，也没跑过 `build.ps1 -Bundle`。第一次打包时重点验证：

1. 装完之后界面能打开（路径定位对不对）
2. 改一个设置、重启，设置还在（可写目录对不对 —— 这条最容易挂）
3. 转换能跑（`tools/libresvip/` 找得到）
4. ffmpeg 能用（`tools/ffmpeg/` 找得到）

---

## 九、平台移植

平台相关代码**全部集中在 `app/desktop/src/platform.rs`** —— 移植时主要改这一个文件。

| 功能 | 现在（Windows） | macOS 需要 |
|---|---|---|
| 下载目录 | 读注册表 `User Shell Folders`，退回 `USERPROFILE\Downloads` | `$HOME/Downloads`（更简单，删掉注册表那段） |
| 文件管理器定位 | `explorer /select,` | `open -R`（**已写好 cfg 分支**） |
| 打开文件 | `explorer` | `open`（同上，已分支） |
| 回收站 | PowerShell `Shell.Application` | `trash` 命令或 `NSFileManager` |
| 平台名 | `node_platform_name()` 返回 `win32` | 已按 Node 命名返回 `darwin`，不用改 |
| 路径规范化 | 剥 `\\?\` 前缀 | `clean_path()` 里的 `#[cfg(windows)]` 块自然跳过 |
| 无窗口子进程 | `quiet_command()` 设 `CREATE_NO_WINDOW` | 该标志不存在，函数已有 cfg 分支 |
| 注册表读取 | 下载目录读取用 `#[cfg(windows)]` 隔离 | 自动跳过 |

**外部工具**（ffmpeg / yt-dlp）走 `find_binary()` + PATH，逻辑本身跨平台。
但它们现在**随包分发**，macOS 版需要换成对应平台的二进制。

**两处要注意**：

1. `src/tools.rs` 的编辑器路径表是 Windows 专有的（`H:\ChiXiaoYangUVR5` 等）。
   macOS 上要么换成 `/Applications/*.app` 扫描，要么直接去掉（UVR 在 macOS 上安装方式本来就不统一）。
   这是**数据**不是逻辑，改动很小。
2. 打包见上一节。

**构建脚本不跨平台**：`build.ps1` 是 PowerShell，只能在 Windows 跑。
macOS 需要另写一个薄壳（`vite build` 那类跨平台步骤两边一样，但 vcvars 那步 Mac 上没有）。
**不要为了「一个构建入口」去引 task runner** —— 两个平台两个壳，各十来行。

**Android 是另一回事**：Tauri 的 Android 构建要 SDK + NDK + Gradle，入口是 `tauri android build`。
更关键的是**后端现在依赖「起外部进程」**（`Command::new` 调 ffmpeg / yt-dlp / LibreSVIP），
而 Android 应用数据目录是 noexec 挂载，装在里面的可执行文件跑不起来，原生库必须走 JNI 从 `.so` 加载。
`tools/` 里现在发的还是 `.exe`。真要做 Android，第一步是**把媒体能力抽成抽象层**
（桌面走 `Command`，移动走 JNI），否则就是复制一整个后端。
历史上 Node 后端那 19,019 行就是这么来的。

---

## 十、历史（留档）

- Node 后端（`app/server/`，19,019 行）已整体删除，其中包含 12 个格式模块和一套平台探测代码。
- 格式转换原取自 UtaFormatix3 的模板，现已全部移除（相关代码与参考文件一并删除）。
- 声库探测（784 行）已删 —— 只被用来「显示装了什么」，转换路径从没调用过。
- 编辑器探测从 16 个砍到只剩 UVR。
- 网易云扫码登录已移除：服务端返回 `8821 请切换其他登录方式`，按官方 JS 逐字节对齐
  三处仍失败，判断是服务端风控。**别再试图修它**，留了手机号验证码 + Cookie 两条路。

移植历史与旧实现见 git：

```
git log --all -- app/server
git log --all -- app/data/resources.json
```

---

## 十一之前：新前端的玻璃材质（**先读那份**）

`app/web-next`（React 新前端）的玻璃材质有过一次大改 —— 从手写玻璃换成
`@ttqtt/liquid-glass-react`。**动那部分代码之前先读 `docs/GLASS-HANDOFF.md`**，
里面写了：

- **库的上游源码仓库就在本机磁盘上**（`C:\Users\Administrator\Desktop\工作站素材\`），
  含 `docs/design-system.md`（小玻璃/大玻璃、regular/clear 的适用条件）、
  组件源码、材质参数表。**判断库的行为以它为准，别对着 `node_modules/dist` 猜。**
- **装错过库的教训**：有两个同名的 `liquid-glass-react`，
  用户要的是 `@ttqtt/liquid-glass-react`（上游 `Tsdsj/liquid-glass-react`），
  不是 `rdev/liquid-glass-react`
- **两个曾经报过的缺陷已定位并修掉**（2026-10-01）：默认材质选错（`clear` 配浅背景 =
  35% 黑压）、侧栏误用 `size="small"`、面板 82% 白盖住背景、顶栏没吸顶。
  根因、改法与实测数据都在那份文档第二节
- **已修好、不能弄坏的三件事**：构建期 standard `backdrop-filter` 被删、
  折射要显式 `enableSvgAuto`、背景色调必须 `BackdropToneProvider` 声明
- **验证工具**：`tests/manual/glass-probe.mjs`（取计算值 + 截图 + 高亮块逐帧/首帧采样）

---
## 十一、下一步

**已定的方向**（用户已拍板，不要再问）：

1. **三端适配**：Windows + macOS + Android，**功能对等**。但**优先 Windows**，
   Android 是后续；唯一要求是「别把门焊死」。
2. **前端换 React + Vite + Tailwind + shadcn**，UI 控件层全部替换，**保留离线运行**。
   **不用 React Native** —— WebView + 同一套 React，三端共用一份 UI。
3. **全局毛玻璃材质**（参考 liquid-glass-react 的观感）+ **设置里可开关性能模式**
   （开启即全局取消毛玻璃）。

### 已完成（2026-09）

| 事项 | 说明 |
|---|---|
| 改名 V-Synth-Studio | 界面可见处全改；exe 变 `v-synth-studio.exe`；存储键与配置目录**刻意不动** |
| 图标全套 | 由 `图标.png` 生成（Win/macOS/Android/iOS），`cargo tauri icon --fit contain` |
| 前端脚手架 | `app/web-next/`（React 19 + Vite 8 + TS 7 + Tailwind 4），产物落 `app/web/next/`，访问 `/next/` |
| 主题 + 透明度 | ⚠️ **原表写的 `lib/useTheme.ts` / `lib/usePerfMode.ts` 已不存在**（换库时删了）。现在主题与「降低透明度」是 `App.tsx` 里喂给库 `GlassProvider` 的两个 prop；`perfMode` 字段后端有、前端**还没接** |
| **玻璃材质修好**（2026-10-01） | 默认改成毛玻璃、侧栏改 `size="large"`、面板降到 `thin`、顶栏吸顶、侧栏高亮块改用库的透镜、补回 `corner-shape: squircle`。见 `docs/GLASS-HANDOFF.md` 第二节 |
| **顶栏只留品牌**（2026-10-01） | 右上角那组控件（材质分段控件 / 重新检测 / 状态文字）按要求移除；左上角换成真图标。材质切换改在设置页，重新检测在总览页「环境就绪度」里。顶栏现在只有品牌 |
| **`glass-probe.mjs`** | 玻璃专项探针：计算值 + 截图 + 高亮块逐帧/首帧采样（`tests/manual/glass-probe.mjs`） |
| **`app/web-next` 入库** | 首次提交 `83320cd` —— 在此之前它一个 commit 都没有 |

### 待办，按优先级

1. **`resolve_paths()` 改用 `resource_dir()`** —— 修掉 MSI、修掉 macOS bundle，
   省掉构建脚本里复制 exe 那步。跟前端选型无关。
2. **控件层换成库的组件**：`Button`/`Field`/`.seg`/`.input` 现在还是手写的（材质走库）。
   库自带 `GlassSegmentedControl`（胶囊、可拖、拖动中实时更新选择）、`GlassButton`、
   `TextField`、`List`…。顶栏的材质切换和侧栏底部的主题切换最该先换 —— 它们本来就是分段控件。
   **换完再判断 shadcn 还需不需要**：库已经提供 66 个控件，原「接 shadcn/ui」这条待办
   可能整条作废（而且 shadcn 初始化要联网，与离线目标相冲）。
3. **一页页搬页面到 React**：建议顺序 `resources`（最纯，无 SSE 无表单状态）
   → `dashboard` → `settings` → `lyrics` → `video`/`audio`（最重，波形 + 大量表单）。
   **每搬完一页跑一次 `ui-smoke.ps1`**，旧前端在 `/` 一直可用。
4. **`ui-smoke.ps1` 覆盖新前端** —— 目前只测旧前端的 8 页，`/next/` 没有自动化冒烟
   （只有 `glass-probe.mjs` 探玻璃）。
5. **侧栏形态要不要换成库的 `TabBar`？** 它自带透镜、拖拽换页、窄屏自动变底部胶囊栏，
   但它的侧栏形态是 `position: fixed` 的整列贴窗口左边，而且**没有分组标题**
   （现在的「工作台 / 素材获取 / 系统」是手写的）。两条路都成立，**属于要用户拍板的结构选择**。
6. **CI**：`.github/workflows/build.yml`，matrix `windows-latest` + `macos-latest`。
   注意 Ubuntu 编不出 Windows/macOS 的 GUI 包（见第九节），且 `tools/` 不在 git 里。

### 关于 Android（已核实，不用再查）

| 依赖 | Android 出路 | 状态 |
|---|---|---|
| ffmpeg | [ffmpeg-kit-maintained](https://github.com/ffmpegkit-maintained/ffmpeg-kit)（FFmpegKit 退役后的社区续作，改 group ID 即迁移） | 可用 |
| yt-dlp | [yt-dlp-android](https://github.com/ffmpegkit-maintained/yt-dlp-android)（Chaquopy 内嵌 CPython 3.13，进程内跑纯 Python） | 可用；AAR 60–80 MB |
| LibreSVIP | 未验证 | **不构成风险** —— 用户已明确「工程转换实现方式有很多」 |

关键约束：Android 应用数据目录是 noexec，**跑不了外部二进制**，必须走 JNI 从 `.so` 加载。
所以媒体层最终要桌面走 `Command`、移动走 JNI。**现在不用做** —— 调用链的 `tools_dir`
形参已经一路穿好了，将来是机械替换而非重写。

**上 Vite 时注意**（已想清楚的部分）：

- Vite 的 `outDir` 指向 `app/web/next/`、`base: '/next/'`，**服务端一行不用改** ——
  因为窗口加载的是 `http://127.0.0.1:<port>`，静态文件是每请求从磁盘读的。
- ⚠️ **新前端里所有 API 调用必须用绝对路径 `/api/...`**。相对路径 `./api/state`
  在 `/next/` 下会变成 `/next/api/state` → 404。见 `lib/api.ts` 的注释。
- `build.ps1` 是**加一行 `vite build`**，不是废除。它仍是唯一构建入口。
- 代价两条：① 编译机多一个 Node.js 依赖（**用户那边仍然不用装**）；
  ② 开发时不再「改完刷新就生效」，要跑 `npm run watch` 或 `vite dev`。
