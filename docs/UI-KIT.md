# 前端 UI 规范（视图开发必读）

零构建、零依赖：原生 ES 模块 + 手写 CSS。**不要引入任何 npm 包或 CDN 资源**（程序必须完全离线可用）。

## 1. 视图契约

`app/web/js/views/<id>.js` 必须导出：

```js
export async function render(ctx) {
  // ctx = { container, headerActions, params, state, navigate, refreshState }
  // container   : 主内容区元素（已清空，直接往里 mount）
  // headerActions: 顶栏右侧动作区（可放按钮/徽章）
  // state       : 全局状态快照（见 §4）
  // navigate(id) : 切换到其它视图
  // 返回值：可选。返回函数会被当作 cleanup（在离开视图时调用，用于关闭 SSE / 定时器）
}
export default { render }   // 建议同时默认导出
```

参考实现：`app/web/js/views/convert.js`（功能最全）、`app/web/js/views/dashboard.js`。

## 2. 可用模块

```js
import { api, watchJob } from '../api.js'
import { h, mount, clear, icon, iconHtml, toast, modal, confirmDialog, promptDialog,
         button, switchToggle, progressBar, emptyState, alertBox, statBlock, card, tabs, segmented,
         formatBytes, formatDuration, formatSpeed, formatNumber, formatTime, timeAgo } from '../ui.js'
import { pickDirectory, directoryInput } from '../components/dirPicker.js'
```

- `h(tag, props, children)` —— `tag` 支持 `'div.card.hoverable'` 点号语法；`props` 里 `onclick`/`oninput` 等直接绑定，`html` 设 innerHTML，`class`/`style`(对象)/`dataset` 都支持。
- `mount(parent, ...children)` —— 清空并填充。
- `toast(msg, 'ok'|'err'|'warn'|'info')`。
- `watchJob(jobId, { onUpdate, onDone, onError, onCancel })` —— SSE 订阅任务进度，断开自动退回轮询；**离开视图时务必调用返回的停止函数**。

## 3. 可用 CSS 类（已在 base.css / components.css / views.css 中定义，不要重复造）

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
| 其它 | `.log`、`.code-block`、`.stat`/`.stat-label`/`.stat-value`/`.stat-sub`、`.divider`、`.truncate`、`.muted`、`.dim`、`.small`、`.tiny`、`.strong`、`.mono`、`.link-card*`、`.video-*`、`.stream-*`、`.op-card`、`.res-*`、`.settings-*`、`.job-row` |

**全部使用 CSS 变量取色**：`var(--accent)` `var(--pink)` `var(--purple)` `var(--ok)` `var(--warn)` `var(--err)` `var(--info)` `var(--text-0/1/2/3)` `var(--bg-0..4)` `var(--border)` `var(--glass)` `var(--radius*)`。不要写死颜色。

## 4. 状态与接口

`state` 字段：`formats[]`（含 `available/canRead/canWrite/exts/fidelity`）、`editors[]`（含 `installed/path/color`）、`tools.{ffmpeg,ytdlp,python}`、`audioFormats{}`、`config`、`paths.{root,outputDir,downloadDir,toolsDir}`、`platform`。

`api` 可用方法（后端已实现，参数即请求体）：

```js
// 视频
api.parseVideo({ url, cookie })          // B站走原生解析，其它站点走 yt-dlp
api.downloadVideo({ url, source, outDir, mode:'video'|'audio', quality, audioQuality,
                    downloadCover, downloadDanmaku, downloadSubs, formatId, page, cookie })
// 音频
api.audioProbe(input)                    // 返回 { info: { durationSec, audio:{codec,sampleRate,channels}, video:{...} } }
api.audioRun({ action, input, output, options })
//   action: 'convert'|'extract'|'pitch'|'tempo'|'trim'|'normalize'
//   convert 的 options: { format:'wav'|'wav24'|'flac'|'mp3'|'m4a'|'ogg'|'opus', sampleRate, channels }
//   pitch 的 options: { semitones }   tempo 的 options: { ratio }
//   trim 的 options: { startSec, endSec }   normalize 的 options: { targetLufs }
// 资源库
api.resources(reload)                    // { groups: [{ id,name,icon,description,items:[{name,url,home,tags,region,cost,desc,tip,verified}] }] }
api.checkLinks(ids)                      // 返回 { jobId }，结果在 job.result.results
// 工具 / 文件
api.detect(force)、api.launch({ id|path })、api.installTool('ytdlp'|'ffmpeg')
api.fsList(path)、api.fsRoots()、api.fsReveal(path, select)、api.fsOpen({ path|url })
api.saveConfig(patch)
```

**B 站解析返回结构**（`api.parseVideo`，`source === 'bilibili'` 时）：
`{ source, kind:'video'|'bangumi', info, currentPage, streams, hasCookie }`

- `info`：`{ bvid, aid, title, cover, desc, durationSec, uploader, publishDate, view, pages:[{cid,page,title,durationSec}], season }`
- 番剧：`info.episodes:[{epId,cid,title,durationSec}]`、`info.title`
- `streams.mode === 'dash'`：`streams.video[]`（`{id, qualityName, width, height, codecs, bandwidth}`）与 `streams.audio[]`（`{id, qualityName, codecs, bandwidth}`）；`streams.acceptDescription[]` 是可选画质名列表
- `streams.mode === 'durl'`：整段流，`streams.streams[]`
- 未登录时高画质不可用，界面上要提示「填入 Cookie 可解锁 1080P+」，Cookie 在设置页配置

**yt-dlp 解析返回**（`source === 'ytdlp'`）：`{ info: { title, uploader, durationSec, thumbnail, formats:[{formatId,resolution,ext,note,isVideo,isAudio,filesize}], subtitles } }`

## 5. 硬性要求

- 全部文案中文，语气务实、不要营销腔。
- **任何失败都要能被用户看到**：`try/catch` + `toast(err.message, 'err')`，不要静默吞异常。
- 长任务一律用 `watchJob` 显示进度条 + 日志，不要在界面线程里假死等待。
- 缺少外部依赖（ffmpeg / yt-dlp）时，不要只报错：给出「一键获取」按钮（`api.installTool`）或指向设置页。
- 界面要「流畅」：切换视图不要闪烁，列表用 `.stagger` 做交错入场，操作后给即时反馈（按钮 `.loading`、toast）。
- 语法自检（必须做）：`Copy-Item app\web\js\views\xxx.js $env:TEMP\check.mjs; node --check $env:TEMP\check.mjs`
  （浏览器专用 API 无法在 Node 跑，只需要通过语法解析）。
- 服务端已在 `http://127.0.0.1:8787` 运行，可用
  `Invoke-RestMethod` 直接验证你要调的接口真实返回结构。
