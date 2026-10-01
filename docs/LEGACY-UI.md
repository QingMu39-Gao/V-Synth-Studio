# 旧前端（`app/web/js`）—— 参考手册

> **这一套正在退役。** 新前端（`app/web-next`，访问 `/next/`）正在逐页取代它；
> 在用户确认切换之前，`/` 仍是 exe 的默认界面，所以这份手册要留着。
> 新前端的规范在 `docs/NEXT-UI.md`；两边的取舍与坑在 `docs/LESSONS.md`。
>
> 卸载时机：8 页全部验收、`main.rs` 的 `ui_path` 默认值改成 `next` 之后，
> 这份文件和 `app/web/js/` 可以一起删。

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
