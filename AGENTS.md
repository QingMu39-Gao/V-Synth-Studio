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
  web-next/           前端**源码**（React + Vite + TS + Tailwind）—— 8 页已全部搬完
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
        Button.tsx    库的 GlassButton / GlassIconButton
        Field.tsx     Field / TextInput / TextArea
        Icon.tsx      手写 SVG path 表（**没有图标库**，要离线）
        Job.tsx       任务进度（库的 GlassProgress + 取消 + 日志）
        DirPicker.tsx 目录选择（库的 GlassDialog + PathBar + List）/ DirectoryInput
      lib/
        api.ts        后端调用（39 条路由；API 在根路径 /api/*，不是 /next/api/*）
        types.ts      后端数据结构（照 tests/contract/fixtures 定义）
        format.ts     formatBytes / Duration / Speed / Number / Time / timeAgo
        useJob.ts     任务订阅：SSE + 轮询兜底（旧 watchJob 的 React 版）
        useGlass.ts   玻璃等级 1~4（材质 / 透明度 / 面板要不要玻璃全由它派生）
        useNavLens.ts 侧栏与小节导航的滑动高亮块
        boot.ts       揭开启动加载画面
      pages/          8 页：Dashboard / Convert / Video / Audio / Lyrics / Pv / Resources / Settings
                      （每页自带一个同名 .css；页面约定与库组件清单见 docs/NEXT-UI.md）
```

> **启动加载画面**：`index.html` 的 `#boot`（样式内联、12 秒兜底）+ `lib/boot.ts` 揭开，规范见 `GLASS-HANDOFF` §4。

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

> **新前端 8 页已全部搬完（2026-10-02）**，但 **exe 的默认界面还没切** —— 见下面那条。
>
> **`启动工作站.bat` = 更新预览入口。** 换界面不用重新编译（前端每请求从磁盘读），
> 所以新前端改完只要 `npm run build`（或 `npm run watch`）+ 刷新，双击这个 bat 就能看。
> **exe 自身的默认界面在用户确认验收之前不动** —— 那是「切换」这个动作，
> 不是开发动作；改它等于把还没验收的界面推给用户。

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

## 四、旧前端（`app/web/js`）—— 正在退役

**在用户确认切换之前，`/` 仍是 exe 的默认界面**，所以它还能用、也还要能改。
它的视图契约、可用模块、CSS 类表、双主题规则、状态字段、文字 PV 交接细节
**整节搬到了 `docs/LEGACY-UI.md`** —— 改 `app/web/js/` 之前读那份。

新前端（`app/web-next`，`/next/`）才是后续维护的重点，规范见 `docs/NEXT-UI.md`。
两套界面的取舍、以及踩过的坑，见 `docs/LESSONS.md`。

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

## 六、踩过的坑（结论速查）

> **细节与来龙去脉都在 `docs/LESSONS.md`** —— 这一节只留「别再犯」的结论。
> 玻璃相关的另外两份：`docs/GLASS-HANDOFF.md`（材质规范）、`docs/NEXT-UI.md`（新前端约定）。

| 症状 / 场景 | 结论 |
|---|---|
| `/api/fs/open` 收两种参数 | `path`（本地路径，**要求存在**）或 `url`（http/https/ftp/mailto，走系统默认程序、不做存在性检查）。**2026-10-02 之前它只读 `path`**，于是所有传 `{url}` 的调用必然 400 —— 两个前端的「在浏览器打开」都是坏的，已修（`platform::open_url` + `looks_like_url`，带单测） |
| 接口「发了没反应 / 永远空列表」 | **先对后端源码与夹具**，别信旧前端的调用姿势：`collect` 要 `{dirs:[…]}`（旧前端发 `{dir}` → 永远 0 个文件）、`preview` 要 `{inputs,toFormat}`、`fs/list` 空 `path` **必须整个省略**（发 `path=` → 400）、`fs/roots` 字段是 `name` 不是 `label`。四处都是搬页面时实测翻出来的，见 `docs/NEXT-UI.md` 第 5 节 |
| 「改了界面但用户看不到变化」 | **先怀疑缓存**：静态文件必须发 Cache-Control: no-store（simple.rs 已加）。测试每次开全新浏览器，永远命中不了缓存，只有用户常驻的 WebView2 拿着旧文件 |
| 端口不能随机 | 固定 17878；**localStorage 按 origin 隔离**，端口一变 = 全新存储（JIZURA 标记、界面设置、PV 工程自动保存全丢） |
| 悬停/过渡「生硬地闪一下」 | 多半是 `var(--x)` **没定义** → 整条 `transition` 静默失效。先跑 `LESSONS.md` 里那段查未定义变量的脚本 |
| 过渡曲线 | `--ease` 管微交互、--ease-out 管入场、--spring 只给大位移；**两套前端各有一套，别互相套用**（表在 `LESSONS.md`） |
| 侧栏/导航 | **一个框 + 一个滑动高亮块**（库的 .lg-selection-lens），行本身零描边零底色；首帧不能滑、用 offsetTop 量位置（lib/useNavLens.ts）。⚠️ 高亮块**不是玻璃面**，库的 `--lg-lens-bg` 只按主题分档（亮色故意不透明）；要玻璃得自己在 `.nav-lens` 上改半透明 + 消费 `--lg-backdrop`。⚠️ 侧栏 `position: sticky` 的 `top` **必须等于初始位置**（含让开顶栏那 44px），否则一滚就先跳 44px —— 看着就是「侧栏跟着滚轮走」（细节在 `LESSONS.md`） |
| 玻璃 | 用现成的库，**永远别自己写**；材质写在 GlassProvider 上；背景自身模糊要小（3~5px）；栏本身不画底。三条教训的细节在 GLASS-HANDOFF.md §2.2 |
| 苹果式圆角 | corner-shape: squircle + @supports 兜底；**别用在玻璃面上**（库的位移贴图是受限几何） |
| 自定义 CSS 与工具类 | 新前端目前是纯手写 CSS（没用 Tailwind 工具类）。哪天开始用工具类，自定义类必须进 @layer components，否则会静默盖掉工具类 |
| 亮色主题 | 次要文字色不能太浅（对比度 4.5:1 以上）；背景图参数与新前端的取值见 LESSONS.md |
| 背景图「压根不显示」 | 触发过两次（两个前端各一次）；改一个记得改另一个 |
| 网络 | GitHub / Google 要走代理（curl -x http://127.0.0.1:7890）；网易云、QQ 音乐直连；**测试短信接口绝不用真实手机号** |
| 磁盘 | C 盘很紧，临时大文件放 H:\工作站\tmp-* 并即时删 |
| 图标 | 新前端 components/Icon.tsx 是手写 SVG path 表；旧前端在 ui.js 的 ICON_PATHS。**没有图标库**（要离线），加图标往表里加 |

---

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
4. **玻璃是设置里的 1~4 级滑块**（库的 `GlassSlider`，键 `qingmu.glassLevel`）：
   1 级不透明、2 级毛玻璃（这两级内容面板用轻量材质）、**3 级液态 = 只有栏/侧栏/控件折射**
   （= `backup-pre-global-glass` 那一版，用户报过「一半液态玻璃的效果没了」，就是这档）、
   4 级连内容面板也折射。材质 / 透明度 / 面板要不要玻璃三件事全由这一档派生
   （`lib/useGlass.ts` 的 `level*()`），`Panel.tsx` 只看 `level >= 4`。

---

## 七、资源库数据（`app/data/resources.json`）

前端资源库**唯一的数据源**，当前 4 个分组 / 27 条。字段含义看文件本身（自解释），
功能侧的读法见 `docs/FEATURES.md`。要记住的是**三条规则**：

1. **`verified.verdict` 三态**：`ok`(200/301/302/307/308) / `warn`(403/401/405/429) /
   `dead`(404/410/超时/DNS 失败)；其它 5xx 存疑、要人工确认。
   **403 不算失效** —— Musopen、Pixabay、Dreamtonics、爱给网、Booth 这类**完全正常**的站点
   会对脚本请求返 403 拦爬虫，把 403 当死链会误删大量好资源。
   重新校验：`node tests\manual\check-resources.mjs [--write]`（超时/连接错误自动重试 3 次）。
2. **收录原则**：只收官方 / 开源 / 免费或官方试用渠道，**绝不收破解版、学习版、激活器、
   注册机**，也不收网盘转载的盗版声库与编辑器。永久黑名单：瑟狐下载站、
   `pan.vocaloid.world`、`vocakey`（vocakey.wikidot.com）—— 收录即等于协助侵权，
   且这类来源无法验证安全性。
3. **`desc` 必须写实际价值**（对翻调工作流的用处），不写「这是一个音乐网站」这类空话。
   宁缺毋滥：校验不过的条目直接删，宁可 15 条真的，不要 30 条假的；**不伪造状态**。

商业产品**一个公司一条**（收了 CeVIO 就不再单列 KAFU），开源/免费项目**有一个收一个**。
历史：2026-09 按「收录太多了」的反馈从 7 组 121 条精简到 4 组 27 条
（来源清单见 `git log --all -- app/data/resources.json`）。

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

而 Tauri 的 `bundle.resources` 会把资源**平铺**到 `<安装目录>/resources/` 下。

> ⚠️ **本节此前写着「所以 `resources` 现在是空的」—— 那句已经过时了（2026-10-02 核实）。**
> `tauri.conf.json` 现在有 4 条映射，而且键名与 `resolve_paths()` 的期望**正好对齐**：
>
> ```jsonc
> "../../app/web"                 → "app/web"
> "../../app/data/resources.json" → "app/data/resources.json"
> "../../app/data/pinyin.json"    → "app/data/pinyin.json"
> "../../tools"                   → "tools"
> ```
>
> 也就是说 `resource_dir()`（第 1 步）**可能已经能定位到** `<安装目录>/resources/app/web`，
> 只是**没打过包、没人实测过**。第一次打 MSI 时先验这一条，再决定还要不要改
> `find_app_root()`。

**这个问题不止影响 MSI。** 同一个「往上找」的假定在别的地方也不成立：

- Windows **安装版** → 找不到（就是上面这个）
- **macOS `.app` bundle** → `Contents/Resources/` 布局，同样找不到
- 而 `resolve_paths()` 第一步**本来就写了**「问 Tauri 的 `resource_dir()`」——
  既然 `resources` 现在有映射（见上面那条），这一步可能已经能生效，**但没人验过**

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

## 附一、新前端玻璃材质（**动那部分代码前先读**）

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
2. **前端换 React + Vite + Tailwind**，UI 控件层全部替换，**保留离线运行**。
   ⚠️ 原计划的 **shadcn/ui 不再引**：`@ttqtt/liquid-glass-react` 自带 60+ 个控件
   （按钮/输入/列表/弹出层/工具栏/侧栏…），再叠一层 UI 库只会打架，
   而且 shadcn 初始化要联网，与离线目标相冲。**不用 React Native** ——
   WebView + 同一套 React，三端共用一份 UI。
3. **全局毛玻璃材质**（参考 liquid-glass-react 的观感）+ **设置里可开关性能模式**
   （开启即全局取消毛玻璃）。

### 已完成（2026-09）

| 事项 | 说明 |
|---|---|
| 改名 V-Synth-Studio | 界面可见处全改；exe 变 `v-synth-studio.exe`；存储键与配置目录**刻意不动** |
| 图标全套 | 由 `图标.png` 生成（Win/macOS/Android/iOS），`cargo tauri icon --fit contain` |
| 前端脚手架 | `app/web-next/`（React 19 + Vite 8 + TS 7 + Tailwind 4），产物落 `app/web/next/`，访问 `/next/` |
| 主题 + 透明度 | ⚠️ **原表写的 `lib/useTheme.ts` / `lib/usePerfMode.ts` 已不存在**（换库时删了）。现在主题与「降低透明度」是 `App.tsx` 里喂给库 `GlassProvider` 的两个 prop；`perfMode` 字段后端有、前端**还没接** |
| **玻璃材质修好**（2026-10-01） | 默认改成毛玻璃、侧栏改 `size="large"`、面板降到 `thin`、顶栏（后改为绝对定位）、侧栏高亮块改用库的透镜、补回 `corner-shape: squircle`。见 `docs/GLASS-HANDOFF.md` 第二节 |
| **顶栏只留品牌**（2026-10-01） | 右上角那组控件（材质分段控件 / 重新检测 / 状态文字）按要求移除；左上角换成真图标。材质切换改在设置页（今为「玻璃等级」滑块）、重新检测在总览页。顶栏**移出文档流**，内容列上移 76px；⚠️ 顶栏 `inset-inline` 必须写 `var(--lg-margin)` —— 绝对定位的包含块是**内边距盒**，写 0 会偏左 20px |
| **`glass-probe.mjs`** | 玻璃专项探针：计算值 + 截图 + 高亮块逐帧/首帧采样（`tests/manual/glass-probe.mjs`） |
| **`app/web-next` 入库** | 首次提交 `83320cd` —— 在此之前它一个 commit 都没有 |
| **启动加载画面 + 交接**（2026-10-02） | `index.html` 的 `#boot` + `lib/boot.ts`；遮罩淡出与界面入场**交叉**（时长必须拉开，见 `GLASS-HANDOFF` §4.1） |
| **玻璃等级 1~4 滑块** | 材质 / 透明度 / 面板要不要玻璃全由这一档派生（`lib/useGlass.ts`），键 `qingmu.glassLevel` |
| **设置页小节导航复用主侧栏那套** | `lib/useNavLens.ts` + `.app-nav` / `.nav-row` / `.nav-lens`，两处外框参数逐项相同 |
| **8 页全部搬到 React**（2026-10-02） | 旧 `views/*.js` → `pages/*.tsx`（约 7,200 行）；`lib/api.ts` 补齐 39 条路由；任务进度 / 目录选择 / 表单共用件在 `components/`。迁移中翻出并修掉旧前端 4 处接口契约错误（见 `docs/NEXT-UI.md` 第 5 节） |
| **`next-smoke.mjs`** | 新前端逐页冒烟（旧 `ui-smoke.ps1` 只管 `/`）：控制台报错 / 占位页 / 玻璃面 / 该页文案，8/8 全绿 |

### 待办，按优先级

1. **`resolve_paths()` 改用 `resource_dir()`** —— 修掉 MSI、修掉 macOS bundle，
   省掉构建脚本里复制 exe 那步。跟前端选型无关。
2. **把剩下几处手写控件换成库的**：`Button`（已是 `GlassButton`）和 `List`/`Dialog`/`Slider`/
   `Progress`/`Badge`/`Switch` 都在用了，但 `Field.tsx` 的输入框、页面里的 `.seg` / `.input`
   还是手写的（只有材质走库）。库有对应的 `TextField`（`multiline`）/ `Picker` / `RadioGroup` /
   `GlassSegmentedControl`（胶囊、可拖、拖动中实时更新选择）。**换的时候注意**：
   库的分段控件是 `<label class="lg-segment"><input type=radio>`，`aria-label` 挂在内层
   `.lg-segmented-track` 上 —— 写自动化测试时别在外层 `.lg-segmented` 上取 `aria-label`（会拿到 null）。
3. **切换 exe 默认界面**（8 页已搬完，就等这一步）：改 `main.rs` 里 `ui_path` 的默认值，
   `default` 从 `""`（旧前端）改成 `"next"`。**这是验收动作，必须等用户明确点头** ——
   改了等于把还没验收的界面推给所有直接跑 exe 的人。切换后再考虑退役旧前端
   （`app/web/js/`、`docs/LEGACY-UI.md`）。
4. **给新前端补点击穿透测试** —— `next-smoke.mjs` 只验「渲染 + 文案 + 控制台」，
   真实操作链路（选文件 → 预检 → 提交任务）还没有自动化，目前靠人工 + 探针截图。
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
