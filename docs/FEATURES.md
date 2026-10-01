# FEATURES.md —— 功能实现文档（给后续维护者）

**这份文档回答一件事**：每一项功能，从界面上点下去到后端做完，中间发生了什么、代码在哪个文件、有哪些不能踩的约束。

- 项目全貌、构建方式、已知坑的**结论** → `AGENTS.md`（不在这里重复）。
- 新前端的目录约定、库组件清单、页面写法 → `docs/NEXT-UI.md`。
- 玻璃材质规范 → `docs/GLASS-HANDOFF.md`；旧前端契约 → `docs/LEGACY-UI.md`。
- **本文所有结论都来自源码与 `tests/contract/fixtures/` 的阅读**（写文档时按任务要求没有启动任何实例，运行时行为未实测）。拿不准的地方标了「未核实」。

---

## 1. 一页纸总览

### 请求怎么走

```
WebView2 窗口（Tauri 2）
  └─ 加载 http://127.0.0.1:<port>{/ 或 /next/}/     ← main.rs: WebviewUrl::External(url)
       │  fetch('/api/...')                        ← 新前端 lib/api.ts / 旧前端 js/api.js
       ▼
  同进程 axum 服务（server/mod.rs::router，绑 127.0.0.1）
       ├─ /api/*  → server/{simple,convert,media,lyrics,tools}.rs 的处理器
       │              └─ 调 crate 模块做真活：
       │                 libresvip.rs（转换/读工程）· audio.rs（ffmpeg）
       │                 bili.rs（B 站原生）· ytdlp.rs（yt-dlp 桥）
       │                 lyrics.rs（网易云 / QQ）· net.rs（HTTP 客户端）
       │                 platform.rs（路径/打开/回收站/find_binary）
       │                 tools.rs（探测）· data.rs（静态表）
       │                    └─ 外部进程：LibreSVIP CLI、ffmpeg/ffprobe、yt-dlp、explorer、UVR
       └─ 其它路径 → simple.rs::static_files（**每请求从磁盘读** app/web/ 下的文件，带 no-store）
```

要点：

| 事项 | 事实 | 出处 |
|---|---|---|
| 端口 | 固定 17878；被占用才退随机（`note!` 会写日志） | `main.rs::PICK_PORT/pick_port` |
| 服务形态 | 进程内 tokio 任务，**没有 sidecar 子进程** | `main.rs::serve` |
| 界面切换 | 只是 URL 前缀（`--ui=next|old`），不重新编译 | `main.rs` 的 `ui_path` 段 |
| 静态文件 | 每次 `fs::read` + `Cache-Control: no-store`；目录回退到其下 `index.html` | `simple.rs::static_files` |
| 错误形状 | `{ok:false, error, code:null}`；`media.rs` 的错误**故意用 500**（照抄 Node） | `simple.rs::ApiError`、`media.rs` 头注释 |
| 日志 | `<可写目录>/app.log`（无控制台窗口，不看 stdout） | `main.rs::log_line` |

### 两套前端

| | 旧前端 | 新前端 |
|---|---|---|
| URL / 源码 | `/` ← `app/web/`（零构建） | `/next/` ← `app/web-next/`（Vite 产物落 `app/web/next/`） |
| 入口 | `app/web/js/main.js` | `app/web-next/src/main.tsx` → `App.tsx` |
| 状态来源 | main.js 里一个**全局 `state` 对象** + `refreshState()`（调 `api.state()`） | `App.tsx` 用 `useState` 拿一次 `api.state()`，通过 `PageProps` 往下传 |
| 路由 | hash 视图表（`js/views/*.js`） | hash `#/<id>`，页表在 `App.tsx` 的 `PAGES` + `pageViews` |
| 主题 | `js/theme.js`（唯一入口） | `App.tsx` 的 `THEME_KEY='qingmu.theme'` → `GlassProvider theme` |
| 玻璃 | `css/*.css` 手写 | 库 `@ttqtt/liquid-glass-react`；等级在 `lib/useGlass.ts`（键 `qingmu.glassLevel`） |

`exe` 自身默认仍是旧前端（`main.rs` 里 `default => ""`），**这是刻意的逃生口**，属验收动作，别顺手改。

**页面偏好放哪**（都不进 `config.json`，除 Cookie / 路径 / 工具路径）：

| 键 | 在哪用 |
|---|---|
| `qingmu.theme` | 主题（`App.tsx`） |
| `qingmu.glassLevel` | 玻璃等级 1~4（`lib/useGlass.ts`） |
| `qingmu.globalGlass` | 等级之前的旧键，`readLevel()` 里做兼容迁移 |
| `fandiao.video.settings` | 视频页参数（`Video.tsx`，与旧前端共用） |
| `fandiao.audio.settings` | 音频页参数（`Audio.tsx`） |
| `qingmu.pv.lyrics` / `qingmu.pv.sent` | 歌词 → 文字 PV 的交接（`Lyrics.tsx` 写、`Pv.tsx` 读） |

> ⚠️ `Settings.tsx` 的 `reload()` **自己又调了一次 `api.state()`**（不只是用 App 传下来的那份）——与 `NEXT-UI.md` §3.1「不要自己去 `api.state()`」有出入，已核实存在。

---

## 2. 路由总表（39 条，逐条）

路由表在 `app/desktop/src/server/mod.rs::router`（39 个 `.route(...)`；`/api/config` 一条挂 GET+POST 两个方法，末尾还有一个 `fallback` 静态文件处理器，不计入 39）。

「用的页面」列指**新前端** `app/web-next/src/pages/*.tsx`（另有 `components/` 与 `lib/`）。

| # | 方法 | 路径 | 后端实现（文件::函数） | 作用 | 用的页面 |
|---|---|---|---|---|---|
| 1 | GET | `/api/health` | `server/simple.rs::health` | 版本 / 运行环境 / PID / uptime | Settings（关于） |
| 2 | GET | `/api/state` | `server/simple.rs::state` | 一次性环境快照（格式表、工具、配置、路径…） | 全部页（App 启动拉一次）+ Settings |
| 3 | GET / POST | `/api/config` | `simple.rs::config_get` / `config_post` | 读配置 / 打补丁保存（Cookie 脱敏） | 写：Settings、Lyrics；读：无人直接调（走 state.config） |
| 4 | GET | `/api/fs/roots` | `simple.rs::fs_roots` | 盘符 + 桌面/下载/文档…（字段是 `name` 不是 `label`） | DirPicker、Pv |
| 5 | GET | `/api/fs/list` | `simple.rs::fs_list` | 列目录 / 文件（`?path&exts&files=0`） | DirPicker、Convert、Video、Audio、Pv |
| 6 | POST | `/api/fs/mkdir` | `simple.rs::fs_mkdir` | 新建文件夹 | DirPicker |
| 7 | POST | `/api/fs/delete` | `simple.rs::fs_delete` | 删文件 / 目录（`trash:true` 走回收站） | **无人调用**（新旧前端都 grep 不到） |
| 8 | POST | `/api/fs/open` | `simple.rs::fs_open` | 用系统默认程序打开 `path` | Audio、Video、Resources（后两处传 `{url}` 见 §3.2 坑） |
| 9 | POST | `/api/fs/reveal` | `simple.rs::fs_reveal` | 资源管理器定位（`/select,`） | Convert、Video、Audio、Lyrics、Settings、Dashboard |
| 10 | GET | `/api/fs/raw` | `simple.rs::fs_raw` | 把本地媒体文件吐给页面，**支持 Range** | Audio（波形 + 试听） |
| 11 | POST | `/api/pv/save` | `simple.rs::pv_save` | 分块写**裸字节**（文字 PV 导出） | Pv |
| 12 | GET | `/api/jobs` | `simple.rs::jobs_list` | 任务列表（只回 7 个字段） | **无人调用**（`api.jobs` 没被页面用） |
| 13 | GET | `/api/jobs/get` | `simple.rs::jobs_get` | 单个任务（`?id=`） | `lib/useJob.ts`（轮询兜底） |
| 14 | POST | `/api/jobs/cancel` | `simple.rs::jobs_cancel` | 把任务标成 `canceled` | Convert、Video、Audio、Resources（`JobProgress`） |
| 15 | GET | `/api/jobs/{id}/stream` | `simple.rs::jobs_stream` | **SSE** 进度推送（id 在路径里） | `lib/useJob.ts` |
| 16 | GET | `/api/resources` | `simple.rs::resources` | 读 `app/data/resources.json`（`?reload` 被忽略） | Resources |
| 17 | POST | `/api/resources/check` | `simple.rs::resources_check` | **占位**：永远 `{results:[],pending:true}`，无 jobId | Resources（会提示「后端还没接上」） |
| 18 | POST | `/api/convert/collect` | `server/convert.rs::collect` | 递归收集工程文件（要 `{dirs:[…]}`） | Convert |
| 19 | POST | `/api/convert/inspect` | `convert.rs::inspect` | 读工程概览（轨道/音符/音域/歌词） | Convert |
| 20 | POST | `/api/convert/preview` | `convert.rs::preview` | 转换前预检 findings | Convert |
| 21 | POST | `/api/convert/preview-upload` | `convert.rs::preview_upload` | 上传（base64）版预检 | **Convert 页的拖入文件走它**（需放宽 body 上限；原先的 `lib/api.ts` 未包） |
| 22 | POST | `/api/convert/run` | `convert.rs::run` | 批量转换，回 `{jobId}` | Convert |
| 23 | POST | `/api/convert/run-upload` | `convert.rs::run_upload` | 上传版转换 | **Convert 页的拖入文件走它**（`simple::CONVERT_UPLOAD_LIMIT` = 96MB，axum 默认 2MB 装不下 base64 过的工程） |
| 24 | GET | `/api/tools/detect` | `server/tools.rs::detect` | 工具 + 编辑器探测（`?force=1` 被忽略） | Dashboard、Settings |
| 25 | POST | `/api/tools/install` | `server/tools.rs::install` | **固定 400**：工具随包分发，不联网下载 | **无人调用** |
| 26 | POST | `/api/tools/launch` | `server/tools.rs::launch` | 启动外部程序（`{path}`，或 `{id}` 查配置） | Audio（UVR） |
| 27 | POST | `/api/video/parse` | `server/media.rs::video_parse` | 解析视频信息与播放流 | Video |
| 28 | POST | `/api/video/download` | `media.rs::video_download` | 下载，回 `{jobId}` | Video |
| 29 | POST | `/api/audio/probe` | `media.rs::audio_probe` | ffprobe 媒体信息 | Audio |
| 30 | POST | `/api/audio/run` | `media.rs::audio_run` | 6 种音频操作，回 `{jobId}` | Audio |
| 31 | POST | `/api/lyrics/search` | `server/lyrics.rs::search` | 搜歌（网易云 / QQ） | Lyrics |
| 32 | POST | `/api/lyrics/get` | `lyrics.rs::get` | 取歌词 + 译文 + 歌曲信息 | Lyrics |
| 33 | POST | `/api/lyrics/parse-link` | `lyrics.rs::parse_link` | 链接 / 编号 → `(source,id)` | Lyrics |
| 34 | POST | `/api/lyrics/import` | `lyrics.rs::import` | 导入本地 `.lrc`（形状同 get） | Lyrics、Pv |
| 35 | POST | `/api/lyrics/save` | `lyrics.rs::save` | 存 LRC / SRT（UTF-8 无 BOM） | Lyrics |
| 36 | POST | `/api/lyrics/cover` | `lyrics.rs::cover` | 下载封面 | Lyrics |
| 37 | POST | `/api/lyrics/login/sms` | `lyrics.rs::login_sms` | 发短信验证码（**真会发短信**） | Lyrics |
| 38 | POST | `/api/lyrics/login/cellphone` | `lyrics.rs::login_cellphone` | 手机号 + 验证码登录 → 写 Cookie | Lyrics |
| 39 | POST | `/api/lyrics/logout` | `lyrics.rs::logout` | 清空该来源 Cookie | Lyrics |

---

## 3. 逐功能实现

### 3.1 工程格式互转

**界面上是什么**：Convert 页 —— 左列选来源（`从目录收集` / `浏览选文件`）与目标格式、输出目录、命名模板、覆盖开关；右列是预检报告（info / warn / err）+ 任务进度（`useJob` + `<JobProgress>`）。

**请求链**：`api.collect({dirs:[dir]})` →（可选 `api.inspect({inputPath})`）→ `api.preview({inputs,toFormat})` → `api.convert({inputs,toFormat,outDir,nameTemplate,overwrite})` → `{jobId}` → `useJob` 订阅 `/api/jobs/{id}/stream`。

**后端做了什么**（`server/convert.rs`）：

| 步骤 | 行为 | 关键点 |
|---|---|---|
| `collect` | 递归扫目录，只挑 LibreSVIP 认识的扩展名 | 读 **`dirs`（数组）**；深度 ≤6、累计 >5000 个就停；扩展名表来自 `libresvip::list_formats` |
| `inspect` | 读工程 → 概览 | 读 **`inputPath`**（兼容 `path`）；`read_project` 是「把源文件转成临时 `.ufdata` 再解析 JSON」，所以任何格式只解析一种结构；重活走 `spawn_blocking` |
| `preview` | 读 `inputs` + `toFormat`，产出 findings | **只分析 `inputs[0]`**，批量要逐个调；`capability(to)` 表决定 warn 文案（不支持音高曲线 / 单轨 / 不带歌词）；读不出来给 `level:"err"` |
| `run` | 逐文件跑 LibreSVIP CLI，边跑边更新任务 | 目标扩展名取该格式 `exts[0]`；输出名 `nameTemplate.replace("{name}", stem)`；`overwrite=false` 时 `unique_path` 加 ` (2)`；每文件 `set_job(percent)` + `log_job`，结束 `finish_job(status:done, percent:100)` |
| `run` 里的 `options` | **后端会读**（2026-10-02 起）：LibreSVIP 的选项是「转换时逐题提问」，`libresvip::convert` 按这些键回答，键名与取值见本节末尾「转换选项」表 |
| 上传变体 | `{files:[{name,base64}]}`（JSON 里的 base64，手写解码，不引 crate） | 单批 ≤200 文件、单文件 ≤80MB；落 `%TEMP%\qingmu-uploads-<pid>-<ms>\`，跑完删；**新前端未使用** |

CLI 调用形态（`libresvip.rs::convert`）：`libresvip-cli proj convert <in> <out>`，**stdin 喂 60 个空行**（不喂会卡在交互提问上、退出码 1）；`stdout/stderr` 去掉 ANSI 后进日志；`ok = 退出码 0 且输出文件存在`。

**关键约束 / 坑**：

- `collect` 要 `{dirs}`（旧前端发 `{dir}` → 永远 0 个文件，见 `NEXT-UI.md` §5）；`preview` 要 `{inputs,toFormat}`；`inspect` 用 `inputPath`。
- LibreSVIP CLI 位置由 `libresvip::cli_path` 四个候选决定（`tools/libresvip/libresvip-cli/…exe` 等），找不到就报「没有找到 LibreSVIP CLI」。
- 任务日志行首时间戳用 `convert.rs::clock()`，实现是 `秒 % 86400` ——**实际是 UTC**，与它注释里写的「本地时间」不符（已核实）。
- 任务 id 不是随机的：`format!("{:06x}", seq * 0x9e3779b9 % 0xffffff)`（`convert.rs::new_job`）。

**涉及文件**：`server/convert.rs`、`libresvip.rs`、`data.rs`（算子表）、`app/web-next/src/pages/Convert.tsx`、`lib/api.ts`、`lib/useJob.ts`、`components/Job.tsx`。

#### 转换选项（前端 `options` → LibreSVIP 的逐题提问）

**背景**：这个 CLI 的 `proj convert` **没有任何选项参数**，它的选项是在转换过程中**逐题提问**的
（`导入选项：1. 导入音量包络 [y/n] (y): …`，输出按 GBK 编码）。所以后端 `libresvip::convert`
改成了「交互式应答器」：读 stdout，认出「安静下来且以冒号结尾」就是一道题，然后
**照抄提示里括号中的默认值**（`(y)`→`y`、`(1/1)`→`1/1`）——除非 `options` 里有对得上关键词的键。

| 键 | 类型 | 默认 | 对应的提问 |
|---|---|---|---|
| `import.volume` / `import.dynamics` / `import.pitch` | bool | true | 导入音量包络 / 力度包络 / 音高曲线 |
| `import.accompaniment` / `import.gender` / `import.breath` | bool | true | 导入伴奏轨 / 性别包络 / 气声包络 |
| `import.instantPitch` | bool | true | 遵循即时音高模式设置 |
| `import.pitchMode` | `full\|vibrato\|plain` | `plain` | 音高信息输入模式 |
| `import.breathMode` | `ignore\|keep\|convert` | `convert` | 换气音符处理方式 |
| `import.noteGroup` | `split\|merge` | `split` | 音符组导入方式 |
| `middleware.transpose` / `.scale` / `.lyricsPron` / `.removeShort` / `.replaceLyrics` | bool | false | 启用 X 中间件吗 |
| `transpose.semitones` / `scale.factor` | 数字 / 字符串 | `0` / `1/1` | 中间件的追问参数（填了参数会自动启用对应中间件） |
| `export.vsqxVersion` / `export.prettyXml` / `export.language` | `"3"\|"4"` / bool / `"0".."4"` | `"4"` / true / `"4"` | VSQX 文件版本 / 美化 XML / 默认语言 |
| `export.compid` / `export.singer` | string | 提示里的默认 | 默认的 CompID / 默认歌手名称 |

**两条踩过的坑**（都会让转换 100% 失败，症状都是任务里一句「退出码 1」）：

1. **别喂空行**。旧实现给 stdin 灌 60 个空行，以为「空行=接受默认」；但 y/n 提问不收空行，
   它会一直回 `Please enter Y or N` 把空行吃光，最后 `Aborted.`。
2. **输出目录必须先建**。LibreSVIP 不建中间目录，写文件时 `FileNotFoundError`
   （PyInstaller 打包后只显示 `Failed to execute script`）。

**顺带**：`libresvip-cli.exe rpc server --port 15150` 是它的 gRPC 服务，
`ConversionRequest{input_options, output_options, middleware_options, mode(SPLIT/MERGE)}`
才是「正规」的机器接口（`_internal/libresvip/res/protos/libresvip.proto`）。
本轮**没用它**：Rust 侧要 `tonic` + `prost`，机器上既没有缓存也没有 `protoc`（要联网）。
哪天换过去，上面那张键表就是 `input_options`/`output_options` 的 JSON 字段来源。
## 3.2 视频解析下载

**界面上是什么**：Video 页 —— 粘贴链接 → 解析 → 分P/剧集选择、画质与编码选择（AVC 优先提示 HEVC 兼容性）、yt-dlp 格式列表、下载选项（封面/弹幕/字幕、仅音频、转封装）→ 队列顺序下载。

**请求链**：`api.parseVideo({url,cookie?})` → `api.downloadVideo(payload)` → `{jobId}` → `useJob`。

**后端做了什么**（`media.rs` + `bili.rs` / `ytdlp.rs`）：

1. `bili::is_bilibili(raw)`（含 `bilibili.com` / `b23.tv` / 12 位 BV 号）→ 走原生；否则 `ytdlp::inspect`。
2. 原生解析 `Bili::parse_input`：`b23.tv` 短链先跟重定向（最多 12 跳）→ `/bangumi/play/ep<n>` / `/ss<n>` 判番剧 → `find_bv` → `av` 号 → 纯数字当 aid；`?p=` 作分P号。
3. 取信息与流：`get_video_info`（`/x/web-interface/view`）或番剧 `get_bangumi_info`（`/pgc/view/web/season`）→ `get_play_streams`（`fnval=4048` + `fourk=1`；番剧走 PGC playurl）。
4. **WBI 签名**：`get_wbi_keys` 从 `/x/web-interface/nav` 取 img/sub key，进程内缓存 1 小时；`wbi_query` 按 key 排序、过滤 `!'()*`、`md5(query + mixin_key)` 追加 `w_rid`。不签名会被风控（HTTP 403 / code -352，`api_get` 把 -352 翻成「可能触发了风控」）。
5. 下载：`source=bilibili` → DASH 双流并行下（视频 + 音频，各自 `net::download_to_file`，带备用地址回退、线程数取 `config.threads`）→ 有 ffmpeg 就 `-c copy -movflags +faststart` 合并成 `.mp4`（成功删掉两个 `.m4s`），没有就保留分离流并在日志里说明；`mode=audio` 只下一个音频流，**直接存 `.m4a`（不转码）**。
6. 附加产物：封面 `.jpg`、弹幕 `.danmaku.xml`（接口回**裸 deflate、没有 Content-Encoding**，先试 `<` 再试 deflate/zlib 解压）、官方字幕 `.{"{lan}"}.srt`（BCC JSON → SRT）。

**回包形状（照 `tests/contract/fixtures/video-parse-bili.json`）**：

- `{source,kind,info,currentPage?,streams,hasCookie}`；`kind` 是 `video|bangumi`。
- **`currentPage` 是对象**（`{cid,page,title,durationSec,width,height}`），没有分P时**整个键不出现**（Node 的 `undefined` 语义）；`info.episodes` 只有番剧有。
- `streams`：`{mode:'dash', video[], audio[], acceptQuality, acceptDescription, durationMs, isPreview}`；`mode:'durl'` 时是 `{streams:[分段]}`；**B 站解析不出流时是 `{error:"…"}`，yt-dlp 来源根本没有 `streams`（缺字段 / null）**。
- 选流规则（`decode_video_pick` / `decode_audio_pick`，有单测）：同画质**优先 AVC**（`prefer_avc`，避免 HEVC 打不开）；默认取 `video[0]`；音频默认 **30280（192K）**，不默认 Hi-Res；`durl` 没有独立音轨。

**yt-dlp 路线**（`ytdlp.rs`）：查找顺序 `tools/yt-dlp.exe` → PATH → `python -m yt_dlp`；`inspect` 用 `-J`（120 秒超时，超时掐进程）；`normalize_info` 统一出 `title/uploader/durationSec/thumbnail/description(≤500字)/formats[]/subtitles[]`，格式按高度、再按码率降序；下载用 `--newline --progress-template` + `--print after_move:{"file":…}` 收产物路径，进度行按 `\n` 和 `\r` 双分隔解析（`p.percent < 0` 表示「只是一行信息」）。错误文本走 `clean_error`（挑一行有用的，滤掉 `[debug]`）。

**关键约束 / 坑**：

- ⚠️ **`/api/fs/open` 只认 `path`**：`Resources.tsx:293`、`Video.tsx:775`、`Audio.tsx:1917` 传的是 `{url:…}` → 按代码必然 400「路径不存在：」（`simple.rs::fs_open` 只读 `body["path"]` 且要求路径存在）。**这一点是按代码核对得出的，未运行验证**（见 §6「未核实」）。
- 解析成功的判定在 `media.rs`：`parse` 空 url 报「请输入视频链接」（HTTP 500），`download` 空 url 报「缺少视频链接」——夹具 `video-parse-nourl` / `video-download-nourl` 就是这两条。
- 下载任务对象比 convert 的多 `meta / progress / result / error`；前端读的是 `progress.speedText`（`media.rs::set_progress` 把额外字段并进 `progress`）。
- Cookie：请求体给了就用，否则用 `config.bilibiliCookie`；**只填 SESSDATA 的值也行**（`Bili::cookie()` 自动补 `SESSDATA=`）。

**涉及文件**：`server/media.rs`、`bili.rs`、`ytdlp.rs`、`net.rs`、`audio.rs`（合并）、`app/web-next/src/pages/Video.tsx`。

### 3.3 音频处理

**界面上是什么**：Audio 页 —— 左列六种操作（格式转换 / 提取音频 / 变调 / 变速 / 裁剪片段 / 响度标准化）+ 参数表单；右边波形编辑区（`/api/fs/raw` 取字节 → `decodeAudioData`）与人声分离两条路（在线 MVSEP、离线 UVR）。

**请求链**：`api.audioProbe(input)`（`{info}`，不是任务）→ `api.audioRun({action,input,output,options})` → `{jobId}` → `useJob`。

**后端做了什么**：

- `audio_probe`（`media.rs`）：文件不存在回 500「文件不存在」；`audio::probe_media` 调 **ffprobe** `-v quiet -print_format json -show_format -show_streams`；找不到 ffmpeg → `{available:false}`；有 ffmpeg 没 ffprobe → `{available:true,probed:false,note}`。**ffprobe 的数值字段是字符串**，`num()` 负责转（不转全是 0）。
- `audio_run`（`media.rs`）：`action` 分派到 `audio.rs` 的 `convert_audio / extract_audio / shift_pitch / change_tempo / trim_audio / normalize_loudness`；未知 action 报「未知的音频操作」。参数拼装是 **`{input,output}` + `options` 摊平（`options` 里同键覆盖外层）**，所以前端参数名就是 ffmpeg 参数名：`format / sampleRate / channels / semitones / ratio / startSec / endSec / targetLufs`。
- 六种操作的 ffmpeg 形态（`audio.rs`）：

| action | 形态 | 备注 |
|---|---|---|
| `convert` | `-i in -vn <格式预设 args> [-ar N] [-ac N] out` | 预设表在 `data.rs::audio_formats`（wav/wav24/flac/mp3/m4a/ogg/opus） |
| `extract` | **就是 `convert_audio` 的转发**（同一份实现） | 提取音轨 = 导出成音频格式 |
| `pitch` | `-filter:a asetrate=<sr*ratio>,aresample=<sr>,atempo=<1/ratio>` | `semitones=0` 直接报错；采样率取不到时默认 44100 |
| `tempo` | `atempo` 串联（单次限 0.5~2.0，超出自动拆分） | `ratio<=0` 报错 |
| `trim` | `[-ss start] [-to end] -vn -c:a pcm_s16le out` | 进度分母 = `end-start`（可能 ≤0，此时不报进度） |
| `normalize` | `-filter:a loudnorm=I=<lufs>:TP=-1.5:LRA=11 -c:a pcm_s16le` | 默认 -14 LUFS |

- 统一执行器 `audio.rs::run_ffmpeg`：`-hide_banner -y` + args；**边读 stderr 边解析 `time=H:MM:SS.ss`**（秒必须带小数，和 Node 的正则一致）算百分比（封顶 99）；每 200ms 查一次取消标志，取消就 `kill` 并返回哨兵 `CANCELED`；失败取最后 3 行非空输出（≤500 字）。
- 取消语义：`media.rs::cancel_flag` 把「任务表里 status == canceled」包成闭包传进下载/ffmpeg；`run` 拿到 `CANCELED` 就把任务标 `canceled`，其它错误 `fail_job`。
- ffmpeg 查找顺序（`audio::find_ffmpeg`）：`tools/ffmpeg/bin/ffmpeg.exe` → `tools/ffmpeg.exe` → PATH。找不到的报错文案是「它随程序一起打包…把 tools 整个目录重新解压」，**不引导用户去下载**。

**关键约束 / 坑**：

- 输出目录由 `prepare_out()` 顺手 `create_dir_all`；`require_input()` 只校验「路径存在」。
- `extract` 与 `convert` 共用一个实现，所以在界面上它们的差别只是默认格式与文案。
- 音频页的人声分离：MVSEP 走 `api.fsOpen({url})`（**见 §3.2 的 `{url}` 坑**）、UVR 走 `api.launch({path})`；UVR 路径来自 `/api/state` 的 `editors[0]`（`tools.rs` 的候选表只剩 UVR 一个）。

**涉及文件**：`server/media.rs`（`audio_probe` / `audio_run`）、`audio.rs`、`data.rs`、`net.rs`（Cancel 类型）、`app/web-next/src/pages/Audio.tsx`。

### 3.4 歌词

**界面上是什么**：Lyrics 页 —— 来源分段（网易云 / QQ 音乐）、搜索 / 粘贴链接 / 导入本地 `.lrc` 三条取词路 → 预览（对照 / 只看原文 / 只看译文）→ 存 LRC / SRT、下封面、「用这段歌词做文字 PV」、登录（手机号+验证码 / 手工 Cookie）与退出。

**请求链**：`api.lyricsSearch({source,keyword})` → 点一条 → `api.lyricsGet({source,id})`；或 `api.lyricsParseLink({url})`；或 `api.lyricsImport({path})`；存盘 `api.lyricsSave({format,lyric,trans,bilingual,durationSec,source,outDir,name})`；封面 `api.lyricsCover({url,outDir,name})`。

**回包形状（权威）**：

| 路由 | 形状 |
|---|---|
| `search` | `{source, keyword, songs:[{id,name,artists,album,cover,durationSec}]}`（字段是 `name` / `artists`，不是 `title` / `artist`） |
| `get` | `{source, id, song:{name,artists,album,cover,durationSec}, lyric, trans}` |
| `import` | 与 `get` 同形，另有 `encoding: "utf-8"｜"gbk"｜"unknown"` |

**后端做了什么**（`lyrics.rs` + `server/lyrics.rs`）：

- **两个来源**：`normalize_source` 只认 `netease` / `qq`（空串报「请先选择音乐来源」）。出站客户端挂 `config.proxy`（不带协议自动补 `http://`）、20 秒超时，**UA 与 Referer 必带**。
- 网易云走**明文接口**（`/api/cloudsearch/pc` 搜索、`/api/song/lyric?id=&lv=-1&kv=-1&tv=-1` 取词+译文、`/api/song/detail` 补详情，详情失败不废歌词）。QQ 必须用 `QQ_UA`（手机 UA，桌面 UA 会被要求签名）+ `y.qq.com` Referer；取词用 `fcg_query_lyric_new.fcg?nobase64=1`，回包是 HTML 转义过的 → `html_unescape()`；`retcode != 0` 直接报错。纯音乐用 `is_pure_music()` 识别并拒绝。
- **`parse_link` 的判定顺序不能调**（`lyrics.rs::parse_link`，注释里写明踩过）：① `?songmid=` → ② `qq.com` + `/songDetail/<mid>` → ③ `?id=<数字>` → ④ 纯数字 → ⑤ 裸 songmid（5~30 位字母数字且**至少含一个字母**）。反了的话 `songmid=0039MnYb0qxYhV` 会被 `id=(\d+)` 先吃掉，变成网易云 id `0039`。
- **本地 `.lrc` 与编码**：`import_file` 先按 UTF-8 读，**不是合法 UTF-8 才按 GBK(936)**（Windows 走 `MultiByteToWideChar`，非 Windows 只认 UTF-8）；两种都不是就有损解码并回 `unknown`。解析不出时间轴 → 400「不像是 LRC 歌词」。双语拆分两种写法（`split_bilingual`）：行内 `原文 / 译文`（`/`、`／`、`|`，要求**至少一半**歌词行拆得开），或前后两段**时间戳逐条相同**（≥4 行且偶数）。
- **保存 LRC / SRT**（`render`）：`format` 只支持 `lrc` / `srt`；`bilingual`（默认 true）决定带不带译文；LRC 双语是**交错两行**（同时间戳写两条，不合并）；SRT 结束时间取「后面第一个更晚的时间戳」，最后一句用 `durationSec`（0 就 +4 秒），同时间戳多行收在同一结束时间上（双语正是这种）。译文匹配先精确、再容忍 ±50ms。**一律 UTF-8 无 BOM**，界面上不提供 GBK 选项。文件名去用户可能带的 `.lrc`/`.srt` 再用 `bili::safe_title` 清洗。
- **封面**：`url` 必须 `http` 开头（否则「封面地址无效」）；扩展名从 URL 猜（jpg/jpeg/png/webp），猜不到按 jpg；下载**不带 Cookie**，Referer 按域名选（`qq.com`/`gtimg.cn` → QQ，否则网易云）。
- **短信登录与 Cookie**：`login_sms` 先 `phone_exists`（**只有明确回答「没有」才拦**，查不出来就放行让发码接口自己说话）→ `sms_send`（成功形状 `code==200`）。`login_cellphone` 打 `/api/w/login/cellphone`，Cookie 从 **`Set-Cookie` 响应头**（或老版 body 里的 `cookie` 字段）里取，**必须含 `MUSIC_U`** 才认；成功后写 `config.neteaseCookie` 并落盘，顺手取昵称做提示（失败不影响登录）。`logout` 把该来源 Cookie 置空并落盘。
- 手机号校验 `phone_ok`：11 位、以 1 开头、纯数字；`phone_of` 会先归一化（去空格/`-`/`+`/括号、去 `86` 前缀）。
- **Cookie 回显一律脱敏**：`/api/config` 与 `/api/state` 把任何 `*Cookie` 的非空值换成占位串 `已设置`（`simple.rs::MASKED`）；前端把 `已设置` 原样提交回来时 `config_post` **跳过不覆盖**。`lyrics::cookie_of` 对网易云做补全：只粘了值（没有 `=`）时自动补 `MUSIC_U=`。

**关键约束 / 坑**：

- ⚠️ **扫码登录不做**：网易云始终回 `8821 请切换其他登录方式`，判为服务端风控，已整体移除（`AGENTS.md` 第十节）。**别再试图修它**。留了「手机号验证码 + 手工 Cookie」两条路。
- ⚠️ **测试时绝不要调 `lyricsSms`** —— 这个接口真会发短信（`lyrics.rs::sms_send` 注释）。只用明显非法的格式（如 `123`）让它停在参数校验上。
- `Lyrics.tsx` 头部注释说 `lib/api.ts` 的 `LyricsHit/LyricsDoc` 是 `{items:[{title,artist}]}` —— **注释已过期**，`api.ts` 现在就是按 `songs:[{name,artists}]` 与 `{song,lyric,trans}` 声明的（已核实）。

**涉及文件**：`server/lyrics.rs`、`lyrics.rs`、`net.rs`（`encode_component`）、`bili.rs::safe_title`、`app/web-next/src/pages/Lyrics.tsx`、`pages/Pv.tsx`（复用 import）。

### 3.5 文字 PV（JIZURA iframe 交接）

**界面上是什么**：Pv 页 —— 一整块 iframe（`/vendor/jizura/index.html`，JIZURA 上游构建产物，同源）+ 一行工具条（状态、去歌词页、导入歌词文件）。

**为什么这么脏**：JIZURA 是随包分发的**构建产物**，它的界面一个字都不改（升级就整份替换那个目录），所以所有集成只能从父页面在外面做。

**四条交接规则**（`Pv.tsx` 头注释，逐条在代码里核实）：

1. **歌词走 `localStorage`**：键 `qingmu.pv.lyrics`（歌词页写、这里读）+ `qingmu.pv.sent`（同一份只自动填一次；用户手动清空后再切回来不该又被塞回去）。
2. **改它的歌词框必须派发冒泡的 `input` 事件**（`writeLyrics()`）：它的 `bind()` 挂的是 `input` 监听（`S.project.lyrics = e.target.value; replanSoon()`），光改 `value` 内部状态不变、预览不重排、自动保存也不触发。赋值用**它那个 realm** 的原生 setter（`win.HTMLTextAreaElement.prototype`）+ `win.Event`。
3. **填歌词按「读回值」收敛，不写死时间表**（`fill()`）：它 `boot()` 末尾会 `syncUI()` 把 `S.project.lyrics` 覆盖回输入框，所以第一次写入会被顶掉、必须补写；页面被节流时定时器会被拉长（无头环境实测 250ms → 6.9 秒），固定 `setTimeout` 串能把整轮拖到 20 多秒，用户看到的是「导入卡死」。现在的做法是每 200ms 重写一遍直到读回值一致，并且把「读到的内容在、但不是我们写的」当成「它 boot 跑完了」的信号，补一次再等 600ms 收工；上限 `FILL_TIMEOUT=15s`。
4. **导出保存由父页面接管**（`hookSave()`）：它所有保存都过 `J.saveFile(name, blob)`（MP4 / PNG 序列 ZIP / 附带的 WAV）→ 换成「弹目录选择 → 分块 POST `/api/pv/save`」，**并且无论选没选都返回 `'saved'`**（返回别的会让它再走一遍浏览器下载，等于偷偷又存一份到系统下载目录）。注意它界面上的 `mp4file`（「大型视频用」）走自己的 `showSaveFilePicker`，**不经过这里**（在 iframe 里也点不出来，属它既有行为）。

**`waitForEditor` 为什么要等 `readyState === 'complete'`**：React 挂载那一刻 iframe 里还是初始 `about:blank`，而**它本来就是 `complete`** —— 只看 readyState 会立刻开工，然后在 vendor 那份 HTML 还没到时找不到歌词框，误报「/vendor/jizura/ 文件缺失」。现在的判据是「`#lyrics`（或任意 textarea）出现 **且** 整个文档 `readyState === 'complete'`」：`load` 必然晚于 `DOMContentLoaded`，而 JIZURA 的 `boot()` 挂在 `DOMContentLoaded` 上（实测能晚到 8~13 秒），这样就保证 boot 已经跑完、不会再把内容顶掉；另外「加载完了却没有编辑器」直接判失败，不让用户白等 30 秒。接管保存前还要等 `J.saveFile` 真的出现（`booted()`，最多 30 秒），否则会被它后来的定义盖掉。

**`/api/pv/save` 的分块裸字节**（`simple.rs::pv_save`）：

- `POST /api/pv/save?dir=<已存在目录>&name=<文件名>&part=<第几块>`，body 就是这一块的字节；路由上限 16MB（`PV_CHUNK_LIMIT`），前端按 8MB 切（`CHUNK`），峰值内存只有一块。
- `part=0` 是**新建**（同名不覆盖，自动 `(1)(2)…`），`part>0` 追加到同一文件；`dir` 必须已存在且是目录（**不自动创建**）；`name` 只取最后一段并清掉 `<>:"/\|?*` 与控制字符。
- 前端**故意直接用 `fetch`**（没走 `lib/api.ts`）：`request()` 只会 `JSON.stringify(body)`，表达不了裸字节。
- `isBlob()` 用 `Object.prototype.toString` 判跨 realm Blob（`instanceof Blob` 对它那个 realm 造出来的 Blob 恒为 false，误判会把整份成片再拷一遍）。

**导入本地 `.lrc`**：复用 `/api/lyrics/import`（GBK 探测 + 译文拆分都在后端），读的是 **`lyric` / `trans`** 字段（旧前端一度读 `res.lrc` 恒 undefined，把字符串 "undefined" 填进了歌词框）；有译文时按「原文 + 译文 + 双语说明」拼好交给同一个 `fill()`，并写进 `qingmu.pv.lyrics` / `sent`。

**约束**：iframe **不能加 `sandbox`**（加了父页面拿不到 `contentDocument`，整个交接全废）；`allow="autoplay; clipboard-write; fullscreen"`。

**涉及文件**：`app/web-next/src/pages/Pv.tsx`、`server/simple.rs::pv_save`、`app/web/vendor/jizura/`、`tests/manual/pv-verify.mjs`。

### 3.6 资源库

**界面上是什么**：Resources 页 —— 分组 + 搜索 + 标签筛选 + 条目卡（`verified` 徽章：「可达 / 存疑 / 失效」三态文字 + 语义色，不只靠颜色）；点条目在**系统默认浏览器**打开。

**数据源与 schema**：`/api/resources` 只读 `<root>/app/data/resources.json`（只读目录，永远不写），映射出 `{version, updatedAt, notice, groups, verifySummary}`。**`?reload=1` 被后端忽略**（handler 没有 Query 提取器）。

```
resources.json
  version, updatedAt, notice
  groups[]: { id, name, icon, description, items[] }
    items[]: { id, name, url, home, tags[], region, cost, official, desc, tip?,
               verified?: { status, checkedAt, verdict? } }
  verifySummary: { checkedAt, total, ok, warn, dead, passRate }
```

当前 **4 个分组 / 27 条**（`project-share` 3、`free-audio` 6、`editors` 10、`utau` 8）。

**收录规则**（**不在这里重复**，见 `AGENTS.md` 第七节：三态判定与 403 的理由、收录红线与永久黑名单、`desc` 必须写实际价值）。

**`/api/resources/check` 的现状**：`simple.rs::resources_check` 是**占位实现**，固定回 `{ok:true, results:[], pending:true}`，**完全没有 jobId**。前端 `Resources.tsx::checkLinks()` 因此先判 `res?.jobId` 再决定要不要订阅，没有就直接 toast「后端还没接上链接校验（/api/resources/check 返回待实现），暂时无法检查」——**这是刻意写的「不静默失败」**，等后端接上真实校验，这段不用改。`lib/api.ts::checkLinks` 的类型声明是 `{jobId:string}`，与现状不符（**已知不一致，未核实哪一边会被先改**）。

**verdict 三态的落点**：条目徽章优先用 `verified.verdict`；库里没写 verdict 时前端按状态码推（`Resources.tsx::verdictOf`，已核实）：`error` → `dead`；无状态码时 `note` 在 → `warn`、否则 `dead`；200/301/302/307/308 → `ok`；404/410 → `dead`；401/403/405/429 → `warn`；**其它 5xx → `warn`（存疑，要人工确认）**。重新校验资源的工具是 `node tests/manual/check-resources.mjs [--write]`（**它不是前端功能** —— 新前端目前没有可用的校验入口）。

**涉及文件**：`app/data/resources.json`、`server/simple.rs::resources` / `resources_check`、`app/web-next/src/pages/Resources.tsx`、`tests/manual/check-resources.mjs`。

### 3.7 任务与进度

**任务表**（`simple.rs::JobTable`，挂在 `AppState.jobs`，`Mutex` 保护）：

- `items: BTreeMap<String, Value>` + `seq` + `tx: broadcast::Sender<Value>`（容量 256）。
- **一个全局广播通道**（不是每个任务一个）：任务状态一变就 `publish` 一份**完整快照**；订阅者按 id 过滤。丢消息也只是少刷一次。
- `set_job` / `log_job` 都是「锁内取快照、**锁外广播**」（广播放锁里会把干活的任务线程堵住）。
- 任务对象字段：`{id, type, title, status, percent, message, logs[], createdAt}`；下载/音频任务另有 `meta / progress / result / error`（`media.rs` 的 `set_progress` 把 `speedText` 之类的额外字段并进 `progress`）。
- `type` 取值：`convert`（转换）· `download`（视频下载）· `audio`（音频处理）。
- `percent` 0~100；`status` 终态是 `done | error | canceled`。

**路由**：

| 路由 | 语义 |
|---|---|
| `GET /api/jobs` | 列表，只回 `id/type/title/status/percent/message/createdAt`（**不含 logs/result**） |
| `GET /api/jobs/get?id=` | 单个任务（完整） |
| `POST /api/jobs/cancel {id}` | 把非终态任务改成 `canceled` + `message:"已取消"`；**没有额外取消通道 —— 任务表本身就是通道**：长任务在循环里读状态，读到就中断并掐掉子进程 |
| `GET /api/jobs/{id}/stream` | SSE：**id 在路径里**（早先写成 `/api/jobs/stream` 导致前端 404、进度条不动）；连上先推一份当前快照（前端不用再请求一次），之后每次变化推完整快照，**终态推完最后一条就结束**；15 秒一次心跳（`KeepAlive`）；`Lagged` 当无事发生继续等 |

**前端 `lib/useJob.ts`**：`new EventSource('/api/jobs/<id>/stream')` → `onmessage` 拿快照；`onerror` 时关掉 SSE、退回 **700ms 轮询** `api.job(id)`；`done|error|canceled` 三个终态只回调一次（`sawTerminal`）；组件卸载时在 `useEffect` 清理函数里收订阅；**手动 `start()` 第二个任务前要先 `stop()`**，否则两个 SSE 刷同一份 state。

**约束**：

- ⚠️ 新前端**没有全局任务面板**（旧前端有 `js/components/jobDock`）；任务进度只在发起它的那一页显示，切页即收订阅。
- `api.jobs()`（列表）**新前端无人调用**。

**涉及文件**：`server/simple.rs`（JobTable / jobs_*）、`server/convert.rs`（new_job/set_job/log_job/finish_job）、`server/media.rs`（set_progress/fail_job/cancel_job/finish_with_result）、`app/web-next/src/lib/useJob.ts`、`components/Job.tsx`。

### 3.8 配置与路径

**界面上是什么**：Settings 页四个小节 —— 外观（玻璃等级滑块 / 主题）、路径（默认输出目录 / 下载目录）、外部工具（检测结果 + 定位）、关于（版本 / 运行环境 / PID / uptime）。

**配置模型**（`simple.rs`）：

- `default_config()` 的键：`bilibiliCookie` `neteaseCookie` `qqCookie` `proxy` `outputDir` `downloadDir` `defaultTargetFormat` `nameTemplate` `threads` `lastSourceFormat` `customPrograms` `voiceDirs` `quality` `audioQuality` `perfMode`。默认目录来自 `platform::downloads_dir()`。
- `load_config(writable)`：默认值打底 + 已存 JSON 逐键覆盖；内部键 `_root` 不外泄；`migrate_legacy_dirs` 把指向旧 `<可写目录>/output|downloads` 的配置改成系统下载目录。
- `config_path = <writable>/config.json`；`config_post` 是**浅合并任意键**（不用改后端就能存新键）。
- 死键（grep 全仓核实）：**`voiceDirs` 没有任何读取方**；`perfMode` 只有默认值，新前端没接（`AGENTS.md` 已说明）；`customPrograms` 只被 `/api/tools/launch` 的 `{id}` 分支和**旧前端设置页**使用，新前端没有管理入口。

**绿色版 / 安装版判定**（`main.rs::resolve_paths`）：

1. 先问 Tauri `resource_dir()`，里面有 `app/web/index.html` 就用它；
2. 否则从 exe 所在目录**往上找**（≤5 层）；
3. 再从 cwd 往上找（开发时 `cargo run`）。
   然后 `is_writable(<root>/app/data)`（**真的写一个探测文件**，不看只读属性）决定：能写 = **绿色版**（配置写 `<root>/app/data/`），不能写 = **安装版**（配置写 `%APPDATA%\com.qingmu.vocalworkstation\`）。判据是「能不能写」，不是「装没装」。

**打包与 `resource_dir()` 的现状**：`app/desktop/tauri.conf.json` 的 `bundle.resources` **当前是有映射的** —— `../../app/web` → `app/web`、`../../app/data/resources.json`、`../../app/data/pinyin.json`、`../../tools` → `tools`（Tauri 会把它们铺到 `<安装目录>/resources/` 下，保持这里的相对结构）。所以安装版下 `resolve_paths()` 第 1 步（拿 `resource_dir()` + 找 `app/web/index.html`）**理论上能命中**。

> ⚠️ 这一条与 `AGENTS.md` 第八节写的「`resources` 现在是空的、第 1 步实际从没生效」**不一致** —— 我读的是文件本身，**哪一边是当前意图未核实**（第八节那段可能是旧的）。打包从未实测过（本机没装 `tauri-cli`、没跑过 `build.ps1 -Bundle`），第一次打包时按 `AGENTS.md` 第八节那四条重点验证。台面下的老问题仍在：`resolve_paths()` 的兜底路径是「往上找 `app/web/index.html`」，它对 macOS `.app` 的 `Contents/Resources/` 布局不成立。

**端口与存储**：端口固定 17878，被占用才随机 —— 而 localStorage 按 origin（含端口）隔离，**端口一变等于换了一套存储**（主题、玻璃等级、视频/音频设置、PV 交接与自动保存全不延续），`pick_port()` 会把这件事写进 `app.log`。

**日志**：`main.rs::log_line` 追加到 `<可写目录>/app.log`；启动早期路径还没解析出来时退回 `std::env::temp_dir()`。启动那行 `界面：…（URL 前缀 '…'）` 是排查「用户说还是旧界面」的第一现场。

**涉及文件**：`main.rs`、`server/simple.rs`（config/state）、`platform.rs`、`app/web-next/src/pages/Settings.tsx`。

### 3.9 外部工具与启动

**界面上是什么**：Dashboard 的「外部工具 / 环境就绪度」与 Settings 的「外部工具」小节显示 ffmpeg / yt-dlp / Python 的可用性、版本与路径（可定位）。

**探测**（`tools.rs`）：

| 工具 | 查找顺序 | 版本探测 |
|---|---|---|
| ffmpeg | `tools/ffmpeg/bin/ffmpeg.exe`（“程序目录”）→ PATH（“系统 PATH”） | `-version` 取第 3 个词 |
| yt-dlp | `tools/yt-dlp.exe` → PATH；运行时另有一层 `python -m yt_dlp`（`ytdlp::find_ytdlp`） | `--version` |
| python | 只查 PATH（`path` 字段固定回 `"python"`） | `--version` |

`/api/tools/detect` 的完整形状由 `tools::detect_all` 组装：`{checkedAt, platform, node, root, editors[], tools{ffmpeg,python,ytdlp}, installedCount}`。⚠️ **`?force=1` 被忽略**（handler 不读 Query，前端仍会带上，无副作用）。

**`find_binary(name, extra_dirs)`**（`platform.rs`）：先给定目录、再 PATH；Windows 上自动补 `.exe`。**这就是「将来换 Android 走 JNI」要替换的那一层**（`tools_dir` 形参已经一路穿好）。

**编辑器探测**：`tools.rs::candidates()` **只剩 UVR 一个**（硬编码 `H:\ChiXiaoYangUVR5\UVR.exe` / `Start.exe` + `%ProgramFiles%\Ultimate Vocal Remover\UVR.exe`，外加深度 2 的目录扫描）。原来 16 个编辑器的路径表被砍掉，理由见 `AGENTS.md` 第十节。

**`/api/tools/launch`**：`{path}` 优先；没有 path 才用 `{id}` 去 `config.customPrograms` 里查；还接受可选的 `file`（当参数传给被启动的程序）；文件不存在报「程序不存在或已被移动」；**工作目录设成程序自己所在目录**（不少编辑器的资源是相对路径找的）；用 `quiet_command`（Windows 下不弹窗）。⚠️ `{id}` 这条分支代码里保留了，但**新旧前端当前都只传 `{path}`**（grep 核实）。

**`/api/tools/install` 是刻意的 400**：ffmpeg / yt-dlp 改为**随包分发**，所以这个路由回一段中文说明（「tools 目录缺失或不完整就从压缩包里重新解压」）而不是 404 —— 界面若还显示未检测到，用户需要知道怎么办。

**随包分发约定**（`tools/`，约 390 MB，不入 git）：`tools/ffmpeg/`（约 302MB）、`tools/yt-dlp.exe`（17MB）、`tools/libresvip/`（70MB，CLI 路径见 §3.1）。

**LibreSVIP 格式表**：`libresvip::list_formats` 读插件目录里的 `.yapsy-plugin`（INI）元数据，**不解析 CLI 的表格输出**（表格有编码与折行问题）；`suffix` 支持多扩展名；`guess_group` 把 id 归到 VOCALOID / Synthesizer V / UTAU / ACE / 其它歌声编辑器 / 通用交换格式 / 中间数据 / 歌词字幕 / 其它。`/api/state` 的 `formats` 就是它。

**涉及文件**：`tools.rs`、`platform.rs`、`server/tools.rs`、`libresvip.rs`、`app/web-next/src/pages/Dashboard.tsx`、`pages/Settings.tsx`。

### 3.10 界面外壳（玻璃 / 主题 / 启动交接）

**玻璃等级 1~4**（`app/web-next/src/lib/useGlass.ts`，localStorage 键 `qingmu.glassLevel`）：

| 等级 | 材质 | 透明度策略 | 内容面板 |
|---|---|---|---|
| 1 关 | — | `opaque`（库画不透明底、不做模糊） | 轻量材质 |
| 2 毛玻璃 | `regular` | `system` | 轻量材质 |
| 3 液态玻璃 | `clear` + 折射 | `system` | 轻量材质 |
| 4 全液态 | `clear` + 折射 | `system` | **也是玻璃面（折射）** |

派生函数就三个：`levelMaterial()` / `levelTransparency()` / `levelGlobalGlass()`；`App.tsx` 把前两个喂给库的 `GlassProvider`（**材质必须写在 Provider 上**），`components/Panel.tsx` 只看 `level >= 4`。滑块在 Settings 的「外观」小节（库的 `GlassSlider`）。**规范、教训与实测数据都在 `docs/GLASS-HANDOFF.md`（§2.2 三条血的教训、§3.1 构建期 `backdrop-filter`、§4 启动画面），这里不抄。**

**主题**：唯一来源是 `App.tsx` 喂给 `GlassProvider` 的 `theme`（键 `qingmu.theme`，值 `system|light|dark`）。库会写 `<html data-lg-theme>`，它自己的全部 `--lg-*` 令牌都挂在那下面 —— **不要再自己写 `data-theme`**（两个写入方会互相打架）。

**外壳结构**：顶栏只有品牌（`/img/logo.png` + 名称）；侧栏是一整块大玻璃（`GlassPanel size="large" radius={26} padding={12}`），导航用「一个框 + 一个滑动高亮块」（库的 `.lg-selection-lens`，位置由 `lib/useNavLens.ts` 实测 `offsetTop`，**首帧不能滑**）；内容区**不是玻璃**（正文用实色）。Settings 的小节导航与主侧栏逐项同参数（`26 − 12` 得出 14px 同心圆角）。

**启动加载画面与交接**：`index.html` 里的静态遮罩 `#boot`（样式内联，另有一条 12 秒兜底就绪态）由 `lib/boot.ts::hideBoot()` 揭开 —— 调用时机是 **App 首次 `/api/state` 落定之后（成功失败都要揭）**，最短展示 520ms、淡出 400ms，`transitionend` 没来还有定时器兜底删节点；淡出时给 `<html>` 打 `dataset.boot='out'`，让侧栏与内容区在**同一帧**各来一段入场（两段交叉才是「交接」，参数见 `GLASS-HANDOFF` §4.1）。

**涉及文件**：`app/web-next/src/App.tsx`、`lib/useGlass.ts`、`lib/useNavLens.ts`、`lib/boot.ts`、`components/Glass.tsx`、`components/Panel.tsx`、`index.html`、`index.css`、`vite.config.ts`。

---

## 4. 改动指南

### 加一条后端路由

| 步骤 | 文件 | 说明 |
|---|---|---|
| 1 | `app/desktop/src/server/<模块>.rs` | 写 handler。错误统一用 `ApiError::bad_request/not_found/internal`；成功响应用 `super::ok(json!({…}))`（`ok` 一定在最前，便于逐字段对照） |
| 2 | `app/desktop/src/server/mod.rs` | 在 `router()` 里加 `.route(...)`；放在对应分组、保持注释风格 |
| 3 | `app/desktop/src/<crate 模块>.rs` | 真活放这里（业务逻辑不碰 axum），`server/` 只做参数校验与错误映射 |
| 4 | 跑 `node tests/contract/verify.mjs 8891` | **已有路由**改形状必须先改夹具并写清理由；**新路由**没有夹具，verify 不会覆盖它 |
| 5 | `app/web-next/src/lib/api.ts` | 加方法（绝对路径 `/api/...`；需要 `types.ts` 就一起加），**不要在页面里裸写 fetch**（`pv/save` 是唯一例外，因为要发裸字节） |
| 6 | 需要时 | 页面 + `<JobProgress>` / `useJob`（长任务一律走任务表） |

### 加一个页面（新前端）

| 步骤 | 文件 |
|---|---|
| 1 | `app/web-next/src/pages/<Name>.tsx` + `pages/<Name>.css`（**每页自带 CSS**，不要塞进 `index.css`） |
| 2 | `App.tsx`：`PAGES` 加一行（id / title / sub / icon / group）+ `pageViews` 加一行 |
| 3 | props 只用 `PageProps`（`pages/types.ts`）；**不要在页面里自己 `api.state()`**（历史例外：`Settings.tsx`） |
| 4 | 任务进度用 `useJob()` + `<JobProgress>`；目录选择用 `<DirectoryInput>` / `<DirPicker>` |
| 5 | 失败一律 `onToast(err.message, 'err')`，不许静默吞；缺外部依赖要说清怎么恢复，不引导下载 |
| 6 | `npm run build`（用 `H:\node\npm.cmd`）→ 刷新 `/next/#/<id>`；再跑契约 + 两个冒烟 |

### 改接口契约（**冻结**）

`tests/contract/fixtures/` 是 Node 后端还在时抓的真实响应，**永久基准**：

```powershell
node tests\contract\verify.mjs 8891     # 必须 17/17
```

- 夹具目录里除 `_index.json`（抓取索引，不参与比对）外共 **17 个** JSON，逐个按名字映射到路由；形状对不上会逐字段 diff 出来。
- `verify.mjs` 的 `INTENDED` 白名单是「有意差异」—— **加条目要写清理由，它很容易变成掩盖问题的垃圾桶**。
- 新增路由没有夹具；**改已有路由的响应形状 = 先改夹具 + 写理由 + 跑 verify**。

### 其它容易踩的改动

| 改什么 | 先看 |
|---|---|
| 页面文案 | `next-smoke.mjs`（新前端逐页断言）与 `ui-smoke.ps1`（旧前端 8 页关键字）会变红 |
| `main.rs` 的 `ui_path` 默认值 | **是验收动作**，必须等用户明确点头；改它等于把没验收的界面推给所有直接跑 exe 的人 |
| `app/desktop/src/platform.rs` | 平台相关代码**只放这里**（移植 macOS 主要改这一个文件）；`tools.rs` 的路径表是数据不是逻辑 |
| `app/web/js/**`（旧前端） | 读 `docs/LEGACY-UI.md` |
| `.ps1` / `.bat` | 编码与行尾要求见 `AGENTS.md` 第三节（BOM / CRLF / 逻辑块只用 ASCII） |
| 玻璃相关 | 先读 `docs/GLASS-HANDOFF.md`；`vite.config.ts` 里那个 `restoreStandardBackdropFilter` 插件**别删** |
| 前端构建 | 唯一入口是 `app/desktop/build.ps1`（前端 + 后端）；单独改前端用 `npm run build` / `npm run watch` |

---

## 5. 验证清单

工具与管什么**照 `docs/NEXT-UI.md` 第 6 节的表**（契约 / 旧前端冒烟 / 玻璃探针 / PV 交接探针），这里只补两条：

- 新前端逐页冒烟：`tests/manual/next-smoke.mjs`（控制台报错 / 占位页 / 玻璃面 / 该页文案，8/8）；只在 `/next/` 一侧生效。
- Rust 单测：`cd app\desktop; cargo test --bins`（现有单测覆盖 SRT 时间戳、AVC 优先选流、ffmpeg 进度解析、LRC 时间戳与双语拆分、WBI 签名等）。

**启动测试实例一律用 8891**，跑完必须停实例 + 清无头 Edge（命令见 `AGENTS.md`「进程卫生」）。机器上常驻一个 8891 实例时**不要**再去抢它。

---

## 6. 没能核实的地方（诚实清单）

写这份文档时按任务要求**没有启动任何实例、没有发任何网络请求、没有跑构建与测试**。以下条目是「读代码得出的判断」，或「我不确定的」：

1. **运行时行为全部未实测** —— 所有请求链、回包形状、错误码都来自源码与 17 个契约夹具的阅读。
2. ⚠️ **`/api/fs/open` 不接受 `{url}`**（`simple.rs::fs_open` 只读 `body["path"]` 且要求路径存在）。新前端有三处按 `{url}` 调用：`Resources.tsx:293`（打开资源链接）、`Video.tsx:775`（打开网页）、`Audio.tsx:1917`（打开 MVSEP）。**按代码它们会 400「路径不存在：」**；未运行验证，也没有在旧前端里找到 `fs/open` 的调用可比对。
3. **`/api/tools/detect?force=1` 的参数被忽略**（handler 无 Query 提取器）；前端仍会传，判定为无副作用 —— 未运行验证。
4. **`convert.rs::clock()` 的注释与实现不符**：注释写「本地时间」，实现是 `secs % 86400`（UTC）。日志时间戳会与本地时间差时区（未实测差值）。
5. **两处页面注释已过期**：`Lyrics.tsx` 头注释说 `api.ts` 的歌词类型是 `{items:[{title,artist}]}`、`Video.tsx` 头注释说 `api.ts` 把 `currentPage` 写成数字 —— 现在 `api.ts` 已经是 `songs:[{name,artists}]` 与 `currentPage` 对象（已逐行核实）。
6. **`/api/convert/preview-upload` 与 `/api/convert/run-upload` 没有任何前端调用者**（`lib/api.ts` 未包、页面未用），我只读了实现，未验证端到端可用。
7. **`/api/resources/check` 的真实实现不存在**（固定返回 `{results:[],pending:true}`）；`lib/api.ts::checkLinks` 却声明回 `{jobId}` —— 哪一边会先改未核实；`Resources.tsx` 里的「等后端接上」分支是按现状写的。
8. **`AGENTS.md` 第八节与 `tauri.conf.json` 互相矛盾**：前者写 `bundle.resources` 是空的、`resource_dir()` 那一步从没生效；后者**有 4 条映射**（`app/web`、两个 data JSON、`tools`）。我按文件本身写（§3.8），但**不知道哪一边是当前意图**，也没有打包实测。
9. **资源库 `verdict` 的前端兜底推断**（`Resources.tsx::verdictOf`）已逐行核实并写进 §3.6，但它与 `AGENTS.md` 第七节的三态定义是否处处等价（例如「其它 5xx」），未做逐条比对。
10. **死配置键**（grep 全仓）：`voiceDirs` 无任何读取方；`perfMode` 只有默认值；`customPrograms` 只被 `/api/tools/launch` 的 `{id}` 分支与旧前端设置页使用（新前端无管理入口）。`{id}` 这条 launch 分支当前**新旧前端都不传**（grep 核实），是否有意保留未核实。
11. **`docs/GLASS-HANDOFF.md` 我只读了 `AGENTS.md` 对它的引用**，本文里的小节号（§2.2 / §3.1 / §4.1）按那份引用标注，**没有逐节核对正文**。
12. **平台相关分支只有 Windows 走过**：macOS 的 `open -R` / `$HOME/Downloads`、非 Windows 的 GBK 分支（`gbk_to_string` 直接返回 `None`）都只读了代码。
13. **外部站点的线上行为未验证**：B 站 WBI / 番剧 / durl、网易云明文接口、QQ 音乐手机 UA 搜索、yt-dlp 各站点 —— 写文档期间没有发任何请求。
14. **并发改动的风险**：写这份文档期间仓库里还有别的改动（`main.rs` / `server/simple.rs` / `docs/NEXT-UI.md` / `tests/manual/*` 都有未提交修改）。本文按**我读到的那一版工作区**写；如果这些文件随后又变了，请以代码为准。
