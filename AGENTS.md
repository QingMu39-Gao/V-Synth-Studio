# AGENTS.md —— 给接手这个项目的开发者 / 智能体

**先读这一份，再动手。** 这里写的是「看代码看不出来」的东西：架构为什么长这样、
踩过哪些坑、下一步该往哪走。`README.md` 只讲产品与使用。

---

## 一、这是什么

**清沐的虚拟歌姬工作站** —— 给翻调（VOCALOID/UTAU 等歌声合成）用的桌面工具。

功能：工程格式互转（40 种）、视频解析下载、音频处理、歌词获取、文字 PV 生成、资源导航。
全部离线，工程文件不出本机。

---

## 二、架构

### 一个进程，没有 Node

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

**历史上是 Node 后端，已全部重写成 Rust。** 现在 `node` 只出现在测试脚本里。

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
  web/                前端：纯 HTML/CSS/JS，无框架、无构建步骤
    index.html
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
| 工具链 | Rust 在 `H:\DevTools\cargo`、MSVC 在 `H:\VSBuildTools`（build.ps1 会加载 vcvars） |

### 文件编码

| 文件 | 要求 | 不遵守会怎样 |
|---|---|---|
| `.ps1` | **UTF-8 带 BOM** | PS 5.1 把中文注释按 ANSI 读 → 乱码吞掉换行 → 语法错 |
| `.bat` / `.cmd` | **CRLF** | cmd 解析不了 LF，命令会拆错 |

⚠️ **用编辑工具改 `.ps1` 会丢 BOM。** 改完检查头三字节是不是 `EF BB BF`。

---

## 四、前端（当前形态）

零构建、零依赖：原生 ES 模块 + 手写 CSS。程序完全离线可用。

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
  动效 `--dur-fast/--dur/--dur-slow` 与 `--spring`（带回弹，用于按压/开关/展开）。
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
$p = Start-Process -FilePath 'H:\工作站\清沐的虚拟歌姬工作站.exe' `
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

## 十一、下一步

**已定的方向**（用户已拍板，不要再问）：

1. **三端适配**：Windows + macOS + Android，**功能对等**。
2. **前端放弃「零构建」**：上 Vite + 开源组件库，但**保留离线运行**
   （产物仍是静态文件，只是开发时多一条构建链）。

**待办，按优先级**：

1. **`resolve_paths()` 改用 `resource_dir()`** —— 纯赚：修掉 MSI、修掉 macOS bundle、
   省掉构建脚本里复制 exe 那步。**跟前端选型无关，可以先做。**
2. **核实 Android 的媒体方案** —— ffmpeg 在 Android 上走哪种绑定、
   yt-dlp 到底能不能跑（Chaquopy 之类）。这一步没核实完，Android 的工程量就是未知数。
3. **媒体能力抽象层** —— 桌面走 `Command`、移动走 JNI，见第九节末尾。
4. **前端迁移 Vite + 组件库** —— 上去之后，第四节的「可用 CSS 类」表、
   `ui.js` 组件工厂、`build.ps1` 都要改；**本文档第四、五节需要按新形态重写**。

**上 Vite 时注意**（已想清楚的部分）：

- 只要 Vite 的 `outDir` 指向 `app/web/`，**服务端一行不用改、`resolve_paths()` 不用改、缓存头不用改**
  —— 因为窗口加载的是 `http://127.0.0.1:<port>`，`app/web/` 是每请求从磁盘读的。
- `build.ps1` 是**加一行 `vite build`**，不是废除。它仍是唯一构建入口。
- 代价两条：① 编译机多一个 Node.js 依赖（**用户那边仍然不用装**，但要在文档里说清）；
  ② 开发时不再「改完刷新就生效」，要跑 `vite build --watch` 或 `vite dev`。
- 第三节「不要直接 `cargo build`」那句警告反而更要紧了：以后忘了跑 Vite，
  改的前端根本不在产物里。
