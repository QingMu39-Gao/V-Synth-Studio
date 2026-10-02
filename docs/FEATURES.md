# FEATURES.md —— 功能实现文档（给后续维护者）

**这份文档回答一件事**：每一项功能，从界面上点下去到后端做完，中间发生了什么、代码在哪个文件、有哪些不能踩的约束。

- 项目全貌、构建方式、已知坑的**结论** → `AGENTS.md`（不在这里重复）。
- 前端的目录约定、库组件清单、页面写法 → `docs/FRONTEND.md`。
- 玻璃材质规范 → `docs/GLASS-HANDOFF.md`（旧前端已整体退役，`docs/LEGACY-UI.md` 已删除）。
- **本文所有结论都来自源码与 `tests/contract/fixtures/` 的阅读**（写文档时按任务要求没有启动任何实例，运行时行为未实测）。拿不准的地方标了「未核实」。

---

## 1. 一页纸总览

### 请求怎么走

```
WebView2 窗口（Tauri 2）
  └─ 加载 http://127.0.0.1:<port>/                    ← main.rs: WebviewUrl::External(url)
       │  fetch('/api/...')                        ← 前端 lib/api.ts（**绝对路径**）
       ▼
  同进程 axum 服务（server/mod.rs::router，绑 127.0.0.1）
       ├─ /api/*  → server/{simple,convert,media,lyrics,tools}.rs 的处理器
       │              └─ 调 crate 模块做真活：
       │                 libresvip.rs（转换/读工程）· audio.rs（ffmpeg）
       │                 bili.rs（B 站原生）· ytdlp.rs（yt-dlp 桥）
       │                 lyrics.rs（网易云）· net.rs（HTTP 客户端）
       │                 platform.rs（路径/打开/回收站/find_binary）
       │                 tools.rs（探测）· data.rs（静态表）
       │                    └─ 外部进程：LibreSVIP CLI、ffmpeg/ffprobe、yt-dlp、explorer、音轨分离后端（python.exe）
       └─ 其它路径 → simple.rs::static_files（**每请求从磁盘读** app/web/ 下的文件，带 no-store）
```

要点：

| 事项 | 事实 | 出处 |
|---|---|---|
| 端口 | 固定 17878；被占用才退随机（`note!` 会写日志） | `main.rs::PICK_PORT/pick_port` |
| 服务形态 | 进程内 tokio 任务，**没有 sidecar 子进程** | `main.rs::serve` |
| 界面 | **只有一套**（React），固定在根路径 `/`；改前端不用重新编译（每请求从磁盘读） | `main.rs` 开窗口那几行 |
| 静态文件 | 每次 `fs::read` + `Cache-Control: no-store`；目录回退到其下 `index.html` | `simple.rs::static_files` |
| 错误形状 | `{ok:false, error, code:null}`；`media.rs` 的错误**故意用 500**（照抄 Node） | `simple.rs::ApiError`、`media.rs` 头注释 |
| 日志 | `<可写目录>/app.log`（无控制台窗口，不看 stdout） | `main.rs::log_line` |

### 前端（只有一套）

| | 事实 |
|---|---|
| 源码 | `app/web-next/`（React 19 + Vite 8 + TS 7 + Tailwind 4） |
| 产物 | `app/web/`（`index.html` + `assets/`）；同目录的 `vendor/`、`img/` 是随包静态资源，**不是产物** |
| 入口 | `app/web-next/src/main.tsx` → `App.tsx` |
| 状态来源 | `App.tsx` 用 `useState` 拿一次 `api.state()`，通过 `PageProps` 往下传（约定见 `docs/FRONTEND.md` §3.1） |
| 路由 | hash `#/<id>`，页表在 `App.tsx` 的 `PAGES` + `pageViews` |
| 主题 | `App.tsx` 的 `THEME_KEY='qingmu.theme'` → `GlassProvider theme` |
| 玻璃 | 库 `@ttqtt/liquid-glass-react`；等级在 `lib/useGlass.ts`（键 `qingmu.glassLevel`） |

> 旧的手写前端（`app/web/js` + `css` + 手写 `index.html`）、`--ui=next|old` 与启动器的
> `--old` 已于 2026-10-02 一起删除。exe 与启动器现在都加载根路径 `/`。

**页面偏好放哪**（都不进 `config.json`，除 Cookie / 路径 / 工具路径）：

| 键 | 在哪用 |
|---|---|
| `qingmu.theme` | 主题（`App.tsx`） |
| `qingmu.glassLevel` | 玻璃等级 1~4（`lib/useGlass.ts`） |
| `qingmu.glass` | 更早的**材质**键（`components/Glass.tsx`），`readMaterial()` 只读不写，为老用户兼容 |
| `qingmu.globalGlass` | 更早的「全局玻璃开关」键，`readLevel()` 里做兼容迁移（只读） |
| `fandiao.video.settings` | 视频页参数（`Video.tsx`） |
| `fandiao.audio.settings` | 音频页参数（`Audio.tsx`） |
| `fandiao.convert.settings` | 转换页选项（`Convert.tsx:830`） |
| `qingmu.pv.lyrics` / `qingmu.pv.sent` | 歌词 → 文字 PV 的交接（`Lyrics.tsx` 写；`Pv.tsx` 读，并且**两个键的读写都在 Pv.tsx**） |

> ⚠️ `Settings.tsx` 的 `reload()` **自己又调了一次 `api.state()`**（不只是用 App 传下来的那份）——与 `docs/FRONTEND.md` §3.1「不要自己去 `api.state()`」有出入，已核实存在。

---

## 2. 路由总表（53 条，逐条）

路由表在 `app/desktop/src/server/mod.rs::router`（53 个 `.route(...)`；`/api/config` 与 `/api/svsep/backend/inference` 各挂 GET+POST 两个方法，末尾还有一个 `fallback` 静态文件处理器，不计入 53）。

> 2026-10-02：加了「音轨分离」一页（41~53），路由从 40 涨到 53。前 40 条见下，顺序与 `router()` 一致。

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
| 26 | POST | `/api/tools/launch` | `server/tools.rs::launch` | 启动外部程序（`{path}`，`{id}` 回落已随 `customPrograms` 一起删） | （当前无调用方） |
| 27 | POST | `/api/video/parse` | `server/media.rs::video_parse` | 解析视频信息与播放流 | Video |
| 28 | POST | `/api/video/download` | `media.rs::video_download` | 下载，回 `{jobId}` | Video |
| 29 | POST | `/api/audio/probe` | `media.rs::audio_probe` | ffprobe 媒体信息 | Audio |
| 30 | POST | `/api/audio/run` | `media.rs::audio_run` | 6 种音频操作，回 `{jobId}` | Audio |
| 31 | POST | `/api/lyrics/search` | `server/lyrics.rs::search` | 搜歌（网易云） | Lyrics |
| 32 | POST | `/api/lyrics/get` | `lyrics.rs::get` | 取歌词 + 译文 + 歌曲信息 | Lyrics |
| 33 | POST | `/api/lyrics/parse-link` | `lyrics.rs::parse_link` | 网易云链接 / 编号 → id | Lyrics |
| 34 | POST | `/api/lyrics/import` | `lyrics.rs::import` | 导入本地 `.lrc`（形状同 get） | Lyrics、Pv |
| 35 | POST | `/api/lyrics/save` | `lyrics.rs::save` | 存 LRC / SRT（UTF-8 无 BOM） | Lyrics |
| 36 | POST | `/api/lyrics/cover` | `lyrics.rs::cover` | 下载封面 | Lyrics |
| 37 | POST | `/api/lyrics/song` | `lyrics.rs::song` | **下载歌曲**（网易云直链 → mp3） | Lyrics |
| 38 | POST | `/api/lyrics/login/sms` | `lyrics.rs::login_sms` | 发短信验证码（**真会发短信**） | Lyrics |
| 39 | POST | `/api/lyrics/login/cellphone` | `lyrics.rs::login_cellphone` | 手机号 + 验证码登录 → 写 Cookie | Lyrics |
| 40 | POST | `/api/lyrics/logout` | `lyrics.rs::logout` | 清空网易云 Cookie | Lyrics |
| 41 | GET | `/api/svsep/status` | `server/svsep.rs::status` | 运行时 / 模型 / 服务 / 下载进度（前端每 2 秒轮询） | Svsep |
| 42 | POST | `/api/svsep/start` | `svsep.rs::start` | 起离线分离服务（Python 子进程） | Svsep |
| 43 | POST | `/api/svsep/stop` | `svsep.rs::stop` | 停它（`taskkill /T /F` 整棵树） | Svsep |
| 44 | POST | `/api/svsep/runtime/download` | `svsep.rs::runtime_download` | **下运行时 zip（几 GB）并解压**，立刻返回 `{started}` | Svsep |
| 45 | POST | `/api/svsep/models/download` | `svsep.rs::models_download` | **下模型 zip（730 MB）并解压**，立刻返回 `{started}` | Svsep |
| 46 | POST | `/api/svsep/separate` | `svsep.rs::separate` | 提交一次分离（multipart **原样转发**；`?engine=`） | Svsep |
| 47 | GET | `/api/svsep/task/{id}` | `svsep.rs::task` | 查任务（进度**是估的**，见 §3.9） | Svsep |
| 48 | POST | `/api/svsep/task/{id}/cancel` | `svsep.rs::cancel` | 取消任务 | Svsep |
| 49 | GET | `/api/svsep/task/{id}/out/{index}` | `svsep.rs::output` | 取输出轨（**流式转发**，不整个读进内存；`?inline=1` 试听） | Svsep |
| 50 | POST | `/api/svsep/open-output` | `svsep.rs::open_output` | 打开输出目录 | Svsep |
| 51 | GET | `/api/svsep/backend/status` | `svsep.rs::backend_status` | 分离后端原始 `/api/status`（设备 / 队列 / 输出目录） | Svsep |
| 52 | GET | `/api/svsep/backend/system-stats` | `svsep.rs::system_stats` | 分离后端的 CPU / 内存 | Svsep |
| 53 | GET+POST | `/api/svsep/backend/inference` | `svsep.rs::inference_get` / `inference_set` | 推理模式 auto / cpu / gpu | Svsep |

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

- `collect` 要 `{dirs}`（**旧前端**发 `{dir}` → 永远 0 个文件，那套前端 2026-10-02 已删；坑的来历见 `docs/FRONTEND.md` §5）；`preview` 要 `{inputs,toFormat}`；`inspect` 用 `inputPath`。
- LibreSVIP CLI 位置由 `libresvip::cli_path` 四个候选决定（`tools/libresvip/libresvip-cli/…exe` 等），找不到就报「没有找到 LibreSVIP CLI」。
- 任务日志行首时间戳用 `convert.rs::clock()`，实现是 `秒 % 86400` ——**实际是 UTC**，与它注释里写的「本地时间」不符（已核实）。
- 任务 id 不是随机的：`format!("{:06x}", seq * 0x9e3779b9 % 0xffffff)`（`convert.rs::new_job`）。

**涉及文件**：`server/convert.rs`、`libresvip.rs`、`data.rs`（算子表）、`app/web-next/src/pages/Convert.tsx`、`lib/api.ts`、`lib/useJob.ts`、`components/Job.tsx`。

#### 转换选项（`options` 的键 = LibreSVIP 的**官方选项名**）

**背景**：这个 CLI 的 `proj convert` **没有任何选项参数**，选项是在转换过程中**逐题提问**的
（`导入选项：1. 导入音量包络 [y/n] (y): …`，输出按 GBK 编码）。后端 `libresvip::convert` 因此是个
「交互式应答器」：读 stdout，认出「安静下来且以冒号结尾」就是一道题；**`options` 里有没有对得上
官方选项名的键**，有就答它，没有就照抄提示里括号中的默认值（`(y)`→`y`、`(1/1)`→`1/1`）。

> **键名一律用官方的中文选项名**（`导入音量包络`、`音高信息输入模式`……），不要自造
> `import.pitchMode` 这类英文键 —— 自造键跟 LibreSVIP 的选项表没有任何对应关系。
> 官方选项名与取值可以用 `libresvip-cli.exe plugin detail svp` / `plugin detail vsqx` 查
> （**GBK 输出**，PowerShell 里要读 `StandardOutput.BaseStream` 原始字节再按 936 解码）。

| 官方选项名（svp 导入） | 类型 | 官方默认 |
|---|---|---|
| `导入音量包络` / `导入力度包络` / `导入音高曲线` | bool | true |
| `导入伴奏轨` / `导入性别包络` / `导入气声包络` | bool | true |
| `遵循即时音高模式设置` | bool | true |
| `音高信息输入模式` | `full` / `vibrato` / `plain` | **`plain`** |
| `换气音符处理方式` | `ignore` / `keep` / `convert` | `convert` |
| `音符组导入方式` | `split` / `merge` | `split` |
| `版本兼容性`（svp 导出） | `100` / `135` / `182` | `100` |

| 官方选项名（vsqx 输出） | 类型 | 官方默认 |
|---|---|---|
| `VSQX文件版本` | `3` / `4` | `4` |
| `美化XML` | bool | true |
| `默认语言` | `0`~`4`（0=日本語、1=英语…） | `4` |

中间件（`middleware.*`）：启用了才问参数，5 个开关 —— 音高变调 / 工程缩放 / 歌词发音转换 /
移除短的无声间隙 / 替换歌词（参数键 `transpose.semitones`、`scale.factor` 等；**给了参数会自动启用
对应中间件**）。

> ⚠️ **`音高信息输入模式` 的官方默认是 `plain`**（= 仅输入"已编辑"部分）。实测同一工程：
> `plain` 产物 1002 KB / 5556 个 `<cc>` 曲线点，`full` 是 5918 KB / 94026 个。
> **要完整保留源工程里画的音高，就在界面上把它选成「完整」** —— 界面上默认跟随官方（`plain`）。

**VSQX 自动降级**（LibreSVIP 2.9.0 的上游 bug）：目标格式是 VSQX 时，若源工程带参数曲线，
导出器会抛 `AttributeError: 'VocaloidParameterDef' object has no attribute 'vsqx_name'`
（`plugins/vsqx/vocaloid_controllers.py:100`）。实测把四个包络**全关**才能绕开，所以后端在
目标为 vsqx 时自动把 `导入音量包络` / `导入力度包络` / `导入性别包络` / `导入气声包络` 设为 `false`，
并在任务日志里写明「已丢弃这四条曲线」。实测样本从 10/16 提到 **15/16**
（剩下那 1 个是源工程自身音符重叠、LibreSVIP 正常拒绝）。

**两条踩过的坑**（都会让转换 100% 失败，症状都是任务里一句「退出码 1」）：

1. **别喂空行**。旧实现给 stdin 灌 60 个空行，以为「空行=接受默认」；但 y/n 提问不收空行，
   它会一直回 `Please enter Y or N` 把空行吃光，最后 `Aborted.`。
2. **输出目录必须先建**。LibreSVIP 不建中间目录，写文件时 `FileNotFoundError`
   （PyInstaller 打包后只显示 `Failed to execute script`）。

**另外**：`libresvip-cli.exe rpc server --port 15150` 是它的 gRPC 服务，
`ConversionRequest{input_options, output_options, middleware_options, mode(SPLIT/MERGE)}`
是官方给 GUI 用的机器接口（`_internal/libresvip/res/protos/libresvip.proto`，选项 schema 在
`PluginInfo.json_schema`）。现在走的是「驱动交互提问」这条路，够用；哪天要做得更正式可以换过去
（Rust 侧要 `tonic` + `prost` + `protoc`，本机都还没有）。

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

**界面上是什么**：Audio 页 —— 左列六种操作（格式转换 / 提取音频 / 变调 / 变速 / 裁剪片段 / 响度标准化）+ 参数表单；右边波形编辑区（`/api/fs/raw` 取字节 → `decodeAudioData`）。⚠️ 人声/音轨分离 2026-10-02 已搬到 Svsep 页（见 §3.11）。

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
- ⚠️ **音频页 2026-10-02 起不再管分离**：原来这里有在线 MVSEP 与离线 UVR 两条路，现在两者都搬到独立的 **Svsep 页**（见 §3.11）—— 音频页右栏只留一张「音轨分离 · 已搬家」的入口卡。「打开本地 UVR5」那个按钮与 `tools.rs` 的 UVR 路径候选**一起删了**（离线分离改成内嵌引擎，不再需要用户自己装 UVR）。**`/api/tools/launch` 仍在**，但当前没有调用方。

**涉及文件**：`server/media.rs`（`audio_probe` / `audio_run`）、`audio.rs`、`data.rs`、`net.rs`（Cancel 类型）、`app/web-next/src/pages/Audio.tsx`。

### 3.4 歌词

**界面上是什么**：Lyrics 页（**网易云专区**）—— 搜索 / 粘贴链接 / 导入本地 `.lrc` 三条取词路 → 预览（对照 / 只看原文 / 只看译文）→ 存 LRC / SRT、下封面、**下歌曲**、「用这段歌词做文字 PV」、登录（手机号+验证码 / 手工 Cookie）与退出。

> 2026-10-02 按用户要求改成网易云专区：删掉了「来源」分段与整套 QQ 音乐实现（前后端），
> 并新增**歌曲直链下载**。下面凡涉及 QQ 的描述都已按新状态改写；历史落点表见 `AGENTS.md`。

**请求链**：`api.lyricsSearch({source,keyword})` → 点一条 → `api.lyricsGet({source,id})`；或 `api.lyricsParseLink({url})`；或 `api.lyricsImport({path})`；存盘 `api.lyricsSave({format,lyric,trans,bilingual,durationSec,source,outDir,name})`；封面 `api.lyricsCover({url,outDir,name})`；歌曲 `api.lyricsSong({id,outDir,name})`。

**回包形状（权威）**：

| 路由 | 形状 |
|---|---|
| `search` | `{source, keyword, songs:[{id,name,artists,album,cover,durationSec,fee,playable}]}`（字段是 `name` / `artists`，不是 `title` / `artist`；`playable` 是后端批量探测出来的，见下） |
| `get` | `{source, id, song:{name,artists,album,cover,durationSec,fee}, lyric, trans}` |
| `import` | 与 `get` 同形，另有 `encoding: "utf-8"｜"gbk"｜"unknown"` |
| `song` | `{path, name, size, level, format}`；拿不到直链时 **400**（不是 500）。`format` 通常是 `mp3`，也可能是接口给的 `m4a` / `flac`，此时后端会把已写下的文件改名成对应扩展名 |

**后端做了什么**（`lyrics.rs` + `server/lyrics.rs`）：

- **只有一个来源**：`source` 字段仍在请求与回包里（回包固定 `"netease"`），但已没有分派逻辑 —— `server/lyrics.rs::source_of()` 永远返回 `"netease"`，传 `qq` 也不报错（功能已不存在，报错只会让人困惑）。出站客户端挂 `config.proxy`（不带协议自动补 `http://`）、20 秒超时，**UA 与 Referer 必带**。
- 网易云走**明文接口**（`/api/cloudsearch/pc` 搜索、`/api/song/lyric?id=&lv=-1&kv=-1&tv=-1` 取词+译文、`/api/song/detail` 补详情，详情失败不废歌词）。纯音乐用 `is_pure_music()` 识别并拒绝。
- **`parse_link` 只认网易云**（`lyrics.rs::parse_link`）：① `?id=<数字>`（`?` 与 `&` 都认）→ ② `/song/<数字>` → ③ 整个输入是纯数字。兜底文案「无法识别的链接。支持：网易云歌曲链接（music.163.com/song?id=…）或歌曲 ID」。注释里**保留了当年 songmid 顺序坑的教训**（加来源必须先判特征参数，否则会被 `id=(\d+)` 抢走）。
- **本地 `.lrc` 与编码**：`import_file` 先按 UTF-8 读，**不是合法 UTF-8 才按 GBK(936)**（Windows 走 `MultiByteToWideChar`，非 Windows 只认 UTF-8）；两种都不是就有损解码并回 `unknown`。解析不出时间轴 → 400「不像是 LRC 歌词」。双语拆分两种写法（`split_bilingual`）：行内 `原文 / 译文`（`/`、`／`、`|`，要求**至少一半**歌词行拆得开），或前后两段**时间戳逐条相同**（≥4 行且偶数）。
- **保存 LRC / SRT**（`render`）：`format` 只支持 `lrc` / `srt`；`bilingual`（默认 true）决定带不带译文；LRC 双语是**交错两行**（同时间戳写两条，不合并）；SRT 结束时间取「后面第一个更晚的时间戳」，最后一句用 `durationSec`（0 就 +4 秒），同时间戳多行收在同一结束时间上（双语正是这种）。译文匹配先精确、再容忍 ±50ms。**一律 UTF-8 无 BOM**，界面上不提供 GBK 选项。文件名去用户可能带的 `.lrc`/`.srt`/`.mp3` 再用 `bili::safe_title` 清洗。
- **封面**（`download_cover`）：`url` 必须 `http` 开头（否则「封面地址无效」）；扩展名从 URL 猜（jpg/jpeg/png/webp），猜不到按 jpg；下载**不带 Cookie**，Referer 用网易云。⚠️ 网易云给的原始 `picUrl` 是**3000×3000、7.1 MB** 的巨图，`lyrics.rs::cover_url()` 统一改写成 `?param=500y500`（URL 里已有 `?` 就不重复拼）。
- **歌曲直链下载**（`download_song` → `POST /api/lyrics/song`）：⚠️ **必须用 v1 接口** —— `GET /api/song/enhance/player/url/v1?ids=[<id>]&level=exhigh&encodeType=mp3`（带上登录 Cookie），拿 `data[0].url` 再下载，**直链本身不挂 Cookie**。2026-10-02 实测：**老的非 v1 接口 `/api/song/enhance/player/url?id=X&ids=[X]&br=320000` 已经拿不到链接了** —— 同一批 7 首歌里它只给 1 首，换 v1 + `level` + `encodeType` 后 6 首都能拿（剩下那首是真的要会员）。`level` 与 `encodeType` 这两个参数**一个都不能少**，少了就退化成老行为。`fetch_media()` 是唯一取直链入口，下载与搜索结果探测共用它。
- ⚠️ **下音频的客户端必须放宽超时**（`media_client()`）：搜索/取词用的 `client()` 是 20 秒总超时，而实测一首 320 kbps、9.8 MB 的歌单流传输要 **96 秒**，用 20 秒必被掐断，报出来还是含糊的 `error decoding response body`。所以 `media_client()` = 总超时 600 秒 + `read_timeout` 60 秒（「多久没收到新数据」才判死，数据在流就不超时）。前端 `api.ts::lyricsSong` 的超时也放到了 5 分钟。下载走 `save_stream()` 边到边写盘（几 MB 不占内存），写完用 `file_looks_like_audio()` 嗅探文件头（ID3 / fLaC / OggS / MPEG 帧同步），不是音频就**删掉文件**再报「直链可能已经过期」。格式取接口回的 `type`（`format_of()`），不是 mp3 时 `server/lyrics.rs::song()` 会把已写下的文件改名成对应扩展名。
- **能不能下**：搜索时 `netease_search` 调 `annotate_playable()` **一次批量**问接口（20 个 id 一起），给每条结果插 `playable: true/false`；探测本身失败就**整体不插这个字段**（前端按「未知」处理，不显示成不能下）。下载失败且有别的 `playable` 版本时，页面会自动换一个版本重试一次。⚠️ **`fee` 仍然不能当判据**（0 免费 / 1 VIP / 4 付费专辑 / 8 低音质免费，只当标签展示）：实测同为 `fee=0` 的歌有的拿得到直链、有的拿不到；真正的判据只有「接口有没有给 url」。
  - 拿不到时的文案按回包分支（`no_direct_link_reason()`）：`cannotListenReason` 1 → 版权或付费受限、建议先登录；2 → 只有会员能听；`code == -110` 或 `freeTrialPrivilege.userConsumable == false` → 这个版本不给免费账号下载、建议换一个版本；否则「网易云没有返回这首歌的下载地址」。状态码是 **400**，因为这是用户能理解并自己处理的事。
  - 音质用 `level` + `br` 渲染成人话（`standard`→标准、`exhigh`→极高、`lossless`→无损、`hires`→Hi-Res …，`br>0` 再拼 ` / 320 kbps`），存进回包的 `level`。
- **短信登录与 Cookie**：`login_sms` 先 `phone_exists`（**只有明确回答「没有」才拦**，查不出来就放行让发码接口自己说话）→ `sms_send`（成功形状 `code==200`）。`login_cellphone` 打 `/api/w/login/cellphone`，Cookie 从 **`Set-Cookie` 响应头**（或老版 body 里的 `cookie` 字段）里取，**必须含 `MUSIC_U`** 才认；成功后写 `config.neteaseCookie` 并落盘，顺手取昵称做提示（失败不影响登录）。`logout` 把它置空并落盘。
- 手机号校验 `phone_ok`：11 位、以 1 开头、纯数字；`phone_of` 会先归一化（去空格/`-`/`+`/括号、去 `86` 前缀）。
- **Cookie 回显一律脱敏**：`/api/config` 与 `/api/state` 把任何 `*Cookie` 的非空值换成占位串 `已设置`（`simple.rs::MASKED`）；前端把 `已设置` 原样提交回来时 `config_post` **跳过不覆盖**。`lyrics::cookie_of` 对网易云做补全：只粘了值（没有 `=`）时自动补 `MUSIC_U=`。

**关键约束 / 坑**：

- ⚠️ **扫码登录不做**：网易云始终回 `8821 请切换其他登录方式`，判为服务端风控，已整体移除（`AGENTS.md` 第十节）。**别再试图修它**。留了「手机号验证码 + 手工 Cookie」两条路。
- ⚠️ **测试时绝不要调 `lyricsSms`** —— 这个接口真会发短信（`lyrics.rs::sms_send` 注释）。只用明显非法的格式（如 `123`）让它停在参数校验上。
- ⚠️ **`default_config()` 里没有 `qqCookie` 了**（2026-10-02 删）。`load_config` 只认默认值里有的键，所以老用户 `config.json` 里残留的 `qqCookie` **不会报错**，会在下次 `save_config` 整份回写时自然被清掉。
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

- `default_config()` 的键：`bilibiliCookie` `neteaseCookie` `proxy` `outputDir` `downloadDir` `defaultTargetFormat` `nameTemplate` `threads` `quality` `audioQuality`。默认目录来自 `platform::downloads_dir()`。（`lastSourceFormat` / `customPrograms` / `voiceDirs` / `perfMode` 是 2026-10-02 清掉的历史键，`qqCookie` 随网易云专区改造一并删掉。）
- `load_config(writable)`：默认值打底 + 已存 JSON 逐键覆盖，**只认默认值里有的键** —— 所以配置文件里残留的历史键（`perfMode` / `qqCookie` / 更早的 `_root`）不会报错，下次 `save_config` 整份回写时自然被清掉；内部键 `_root` 不外泄；`migrate_legacy_dirs` 把指向旧 `<可写目录>/output|downloads` 的配置改成系统下载目录。
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

**编辑器探测**：`tools.rs::candidates()` 现在**返回空表**（2026-10-02）。原来 16 个编辑器的路径表先砍到只剩 UVR，随后离线分离改成内嵌引擎（§3.11），UVR 那条候选也删了 —— `/api/tools/detect` 的 `editors` 恒为空数组、`installedCount` 恒为 0，前端 `state.editors` 仍挂在同一条链上。**别因为「空函数很怪」就把 `candidates()` 删掉。** 理由另见 `AGENTS.md` 第十节。

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

### 3.11 音轨分离（在线 MVSEP + 离线内嵌引擎）

**界面上是什么**：Svsep 页（侧栏「音轨分离」，`video` 之后、`audio` 之前）。左栏三张卡：音频素材（拖/选一个文件）、分离模式（六轨 BS-Roformer / 二轨 UVR MDX）、分离完做什么；右栏：离线引擎（服务 / 运行时 / 模型 / 设备四个 `<Stat>` + 下载进度 + 启动/停止/下载/输出目录四个按钮）、分离进度（百分比 + 每轨试听与下载）、在线分离 MVSEP（只是一个 `api.fsOpen({url})` 的外链 + 隐私提示）、引擎队列。

**两条路的差别**（这一页存在的理由）：

| | 在线 MVSEP | 离线内嵌 |
|---|---|---|
| 怎么用 | 打开 `https://mvsep.com/zh`（默认浏览器），自己上传 | 页面上传 → 本机 Python 跑模型 |
| 音频出不出本机 | **出**（所以有 `<Chip tone="warn">需上传</Chip>` 与隐私提示） | 不出 |
| 依赖 | 浏览器 + 网 | 运行时（7.3 GB）+ 模型（730 MB），第一次要下 |
| 速度 | 看对方排队 | 本机纯 CPU 实测：二轨约 8 分钟、六轨约 11 分钟（20 秒测试音频） |

**架构**：Tauri 进程里**再起一个 Python 子进程**当分离服务（`crate::svsep::Svsep`，默认端口 17879，占用则 +1 重试），Rust 这层只是转发。**为什么不直接让前端打 Python**：前端只认一个后端、一套错误形状，而且「服务没起来」这话说得比 Python 的英文堆栈清楚。

**磁盘布局**（决定了哪些要下载、哪些随包发）：

```
<root>/app/data/svsep/          运行时（随包分发，只读）
  ├─ runtime/python.exe         Python 3.10 embeddable + torch + CUDA 运行库
  ├─ backend/                   app.py 等 12 个 .py（**上游前端已删**）
  └─ bin/ffmpeg.exe
<可写>/svsep/models/            模型（**不随包发**，730 MB，用户按需下）
<可写>/svsep/{uploads,outputs,logs,data}/
```

绿色版「可写」= `<root>/app/data`；安装版在 `%APPDATA%` 下（Program Files 只读）。⚠️ 于是安装版的**模型在 APPDATA、运行时在 Program Files**，两者分开 —— `config.py` 的 `MODEL_DIR` 被加了一个 `CHIXIAOYANG_MODELS_DIR` 环境变量分支来表达这个组合（上游原本只能表达「只读目录旁边有就有」，那段带注释标了「V-Synth-Studio 加的」，是**唯一一处**对上游源码的改动）。

**模型下载**：`svsep.rs::MODEL_URL` **是空串** —— zip 由用户传服务器后填。空链接时界面明确说「还没配置下载地址」，不转圈失败。下载走 `download_models()` → 写 `<models>/svsep-models.zip.part` → `extract_zip(..., "models/", ...)` 解到 `models/` 的父目录 → 删 zip。运行时同理（`RUNTIME_URL`、`svsep-runtime.zip`，`strip = ""` 因为要留着 `runtime/` 那一层）。**没有断点续传**（理由：730 MB 重下一次可接受，且用户很可能放本地服务器）。

⚠️ **runtime 包里必须同时有 `runtime\`、`backend\`、`bin\` 三样**（2026-10-02 修）：判据 `runtime_ready()` 看的是 `runtime/python.exe` 与 `backend/app.py` 两个文件，而 `bin/ffmpeg.exe` 是分离引擎自己要用的（`backend/config.py::_ensure_ffmpeg_on_path` 把 `<svsep>\bin` 塞进 PATH）。打包脚本第一版用 `CreateFromDirectory` 只装了 `runtime\` 一个顶层目录 —— 用户下完 4.5 GB 仍然起不来，界面还只会说「分离引擎还没装」。修法：`tools/svsep-pack.ps1` 改成 `ZipFile.Open` + `CreateEntryFromFile` 手工加条目（一个包可以放多个顶层目录，条目名用正斜杠），`$pairs` 里 `runtime` 那项是 `Dirs = @('runtime','backend','bin')`。回归测试 `svsep::tests::extracts_the_whole_real_runtime_pack_when_asked` 会逐个断言这三样 + 一个偏移超 4 GiB 的条目（`torch_cpu.lib`）。

**`extract_zip()` 是手写的**（`svsep.rs`，只支持「存 + deflate」）：为解一个 zip 引 `zip` crate 不划算，`flate2` 本来就在依赖树里。⚠️ `strip` 参数两个包不一样，写错不会报错，只会在用户点「开始分离」时才现形。⚠️ 累计压缩体积要在循环外先 `sum()` 一次（runtime 有 2.4 万个条目，每轮重算就是 6 亿次加法）。

**提交分离**：`POST /api/svsep/separate?engine=uvr|roformer`，audio 走 multipart 的 **`file`** 字段。Rust **不解析也不重打包** —— 把原始 multipart 字节原样转发（拆开再拼只会在文件名转义与大 body 缓冲上出错）。body 上限放宽到 600 MB（`SEPARATE_LIMIT`），因为 axum 默认 2 MB 连一首 3 分钟 wav 都装不下；真正的判据仍在 Python 那边（100 MB）。

**⚠️ 进度是估的不是真的**：`task_manager.py` 里 UVR 用 `pct = 5 + int(min(0.95, elapsed / 240.0) * 90)`、RoFormer 用 `elapsed / 480.0`，纯按时间线性插值 —— 长任务会**长时间停在 90% 再跳 100%**。页面上照实显示百分比 +「已用时 N 秒」并加了一句 note 说明「看到不动不用重试」。要改就调 `CHIXIAOYANG_EST_MINUTES_PER_TASK` / `CHIXIAOYANG_ROFORMER_EST_MINUTES`。

**⚠️ 它的设备徽章会误报**：`detect_acceleration()` 只看 `onnxruntime.get_available_providers()` 里有没有 `CUDAExecutionProvider`，**没真去加载 DLL**。在一台 AMD 机器上实测它报 `onnx_cuda: true / "CUDA (ONNX)"`，而 `torch.cuda.is_available()` 是 `False`。界面上那个 `badge` 不可全信。

**⚠️ `audio-separator` 的 output_dir 坑**（上游代码注释里记着）：它在 `load_model` 时把 `output_dir` 拷进 `model_instance`，只改 `Separator.output_dir` 无效，必须同时改 `model_instance.output_dir`，否则输出落到全局 `outputs/`、任务子目录为空、下载 404。

**上游前端已删**：`backend/templates/index.html`、`backend/static/{app.js,style.css,offline.css,favicon.ico,logo.png}` 全部不再随包（`app.py` 里那个 `GET /` 的 `render_template` 路由留着也是死路；我们只用 `/api/*`）。

**退出时收子进程，连强杀也收**（2026-10-02 补）：分离引擎是 `python.exe` 子进程，`impl Drop for Svsep` 只覆盖正常退出 —— **实测任务管理器强杀会留下孤儿**：它继续监听 17879（下次启动工作站以为端口被占，另挑一个，于是两个服务并存）、还占着几 GB 内存。兜底是 Windows 作业对象（`svsep.rs` 的 `job` 模块）：`CreateJobObjectW` + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` + `AssignProcessToJobObject(child)`，句柄**故意不关**（存 `OnceLock`）—— 进程一死，内核回收它持有的句柄，作业上挂的进程一起被终止。这比任何用户态析构都可靠。⚠️ 作业对象建不出来时只记一行日志、照常跑（这是兜底，不该让分离功能不可用）。⚠️ `windows-sys` 要同时开三个 feature：`Win32_System_JobObjects`（常量与结构体）、`Win32_System_Threading`（类型定义实际挂在这里）、`Win32_Security`（`CreateJobObjectW` 的参数用了 `SECURITY_ATTRIBUTES`）。

**实测（2026-10-02，最终 exe + 真包）**：
- `POST /api/svsep/start` → Python 服务起在 17879，`/api/svsep/status` 报 `runtimeReady: true` / `models.ok: true`（730.7 MB）。
- 真跑一次 UVR 分离（10 秒测试音，`ffmpeg -f lavfi -i sine` 生成）：**约 150 秒完成**，两轨都出来了（人声 / 伴奏），`outputs[].label` 由后端给中文。进度长时间停在 5% 再跳 —— 就是上面那条「估的」的直接证据。
- 下载落点回 `audio/wav`、带 `Content-Length` 与 `Accept-Ranges: bytes`，`Content-Disposition` 用 `filename*=UTF-8''`（中文轨名不乱码）；`?inline=1` 可直接喂 `<audio>`。
- 模型下载链路走本地 HTTP 服务器实测：484,975,838 字节 / 7396 次进度回调 / 6 个文件解到位 / `.zip` 与 `.part` 都清掉。回归测试 `svsep::tests::downloads_the_real_models_pack_when_asked`（`VSS_REAL_MODELS_URL` + `VSS_REAL_DOWNLOAD_DEST` 守着，默认跳过；⚠️ **绝不要把落点指向真的可写目录**，那会把用户装好的模型重下一遍）。
- 强杀验证：作业对象加上之前，`Stop-Process -Force` 后 python **活着**并占着 17879；加上之后同样操作 **跟着死了**、无残留。

**涉及文件**：`app/desktop/src/svsep.rs`（含 `job` 模块与真包/下载测试）、`server/svsep.rs`、`server/mod.rs`、`main.rs`（退出时收子进程；⚠️ `RunEvent::Exit` 里**没有**真正的收尾逻辑，原因见那里的注释）、`app/desktop/Cargo.toml`（`windows-sys` 的 JobObjects feature）、`tools/svsep-pack.ps1`、`app/web-next/src/pages/Svsep.tsx` / `Svsep.css`、`lib/api.ts`、`App.tsx`、`pages/Audio.tsx`（拆掉 SeparationCard，改成一个「去音轨分离」的入口卡）、`pages/Dashboard.tsx`、`.gitignore`。

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
| 6 | `npm run build`（用 `H:\node\npm.cmd`）→ 刷新 `#/<id>`；再跑契约 + 逐页冒烟 |

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
| 页面文案 | `next-smoke.mjs`（**9 页**逐页关键字断言）会变红 |
| `app/web-next/src/App.tsx` 的 `PAGES` / `pageViews` | 两处都要加，只加一处会渲染成空白（占位兜底已随旧前端一起删除） |
| `app/desktop/src/platform.rs` | 平台相关代码**只放这里**（移植 macOS 主要改这一个文件）；`tools.rs` 的路径表是数据不是逻辑 |
| `app/web/**` | `index.html` + `assets/` 是 Vite 产物，会被构建覆盖；`vendor/` + `img/` 是随包资源，**别让构建清掉**（`emptyOutDir` 必须 `false`） |
| `.ps1` / `.bat` | 编码与行尾要求见 `AGENTS.md` 第三节（BOM / CRLF / 逻辑块只用 ASCII） |
| 玻璃相关 | 先读 `docs/GLASS-HANDOFF.md`；`vite.config.ts` 里那个 `restoreStandardBackdropFilter` 插件**别删** |
| 前端构建 | 唯一入口是 `app/desktop/build.ps1`（前端 + 后端）；单独改前端用 `npm run build` / `npm run watch` |

---

## 5. 验证清单

工具与管什么**照 `docs/FRONTEND.md` 第 6 节的表**（契约 / 逐页冒烟 / 玻璃探针 / PV 交接探针），这里只补两条：

- 逐页冒烟：`tests/manual/next-smoke.mjs`（控制台报错 / 占位页 / 玻璃面 / 该页文案，**9/9** —— 2026-10-02 加了「音轨分离」一页）。
- Rust 单测：`cd app\desktop; cargo test --bins`（现有 **58 条**，含 svsep 的 Zip64 解析、`strip` 落点、作业对象相关路径；两条「真包」用例用环境变量守着，平时跳过：`VSS_REAL_ZIP` / `VSS_REAL_RUNTIME_ZIP`+`VSS_REAL_RUNTIME_DEST` / `VSS_REAL_MODELS_URL`+`VSS_REAL_DOWNLOAD_DEST`）。⚠️ 解真 runtime 包要 7.5 GB，**落点必须指到 H 盘**；两个 `cargo test` 并行会撞 linker（exit 1104），串行跑。

**启动测试实例一律用 8891**，跑完必须停实例 + 清无头 Edge（命令见 `AGENTS.md`「进程卫生」）。机器上常驻一个 8891 实例时**不要**再去抢它。

---

## 6. 没能核实的地方（诚实清单）

写这份文档时按任务要求**没有启动任何实例、没有发任何网络请求、没有跑构建与测试**。以下条目是「读代码得出的判断」，或「我不确定的」：

1. **运行时行为全部未实测** —— 所有请求链、回包形状、错误码都来自源码与 17 个契约夹具的阅读。
2. ~~⚠️ **`/api/fs/open` 不接受 `{url}`**~~ **已修（2026-10-02 复核）**：`simple.rs::fs_open` 现在 `path` 与 `url` 都收（`url` 走 `platform::looks_like_url` → 系统默认程序，不做存在性检查，带单测）。前端三处按 `{url}` 调用 —— `Resources.tsx:293`、`Video.tsx:775`、`Audio.tsx:1917` —— 现在是对的。
3. **`/api/tools/detect?force=1` 的参数被忽略**（handler 无 Query 提取器）；前端仍会传，判定为无副作用 —— 未运行验证。
4. **`convert.rs::clock()` 的注释与实现不符**：注释写「本地时间」，实现是 `secs % 86400`（UTC）。日志时间戳会与本地时间差时区（未实测差值）。
5. **两处页面注释已过期**：`Lyrics.tsx` 头注释说 `api.ts` 的歌词类型是 `{items:[{title,artist}]}`、`Video.tsx` 头注释说 `api.ts` 把 `currentPage` 写成数字 —— 现在 `api.ts` 已经是 `songs:[{name,artists}]` 与 `currentPage` 对象（已逐行核实）。
6. ~~**`/api/convert/preview-upload` 与 `/api/convert/run-upload` 没有任何前端调用者**~~ **已复核（2026-10-02）**：它们在 `lib/api.ts` 里没有包装，但页面**裸 fetch** 在用 —— `Convert.tsx:195`、`Convert.tsx:321`（拖入的文件没有磁盘路径时走上传版）。同一类「不在 api.ts 里但活着」的还有 `/api/fs/raw`（`Audio.tsx:1195` 的波形与试听）与 `/api/pv/save`（`Pv.tsx:277` 分块写 MP4）。**只查 `api.ts` 会把它们误判成死路由。**
7. **`/api/resources/check` 的真实实现不存在**（固定返回 `{results:[],pending:true}`）；`lib/api.ts::checkLinks` 却声明回 `{jobId}` —— 哪一边会先改未核实；`Resources.tsx` 里的「等后端接上」分支是按现状写的。
8. **`AGENTS.md` 第八节与 `tauri.conf.json` 互相矛盾**：前者写 `bundle.resources` 是空的、`resource_dir()` 那一步从没生效；后者**有 4 条映射**（`app/web`、两个 data JSON、`tools`）。我按文件本身写（§3.8），但**不知道哪一边是当前意图**，也没有打包实测。
9. **资源库 `verdict` 的前端兜底推断**（`Resources.tsx::verdictOf`）已逐行核实并写进 §3.6，但它与 `AGENTS.md` 第七节的三态定义是否处处等价（例如「其它 5xx」），未做逐条比对。
10. ~~**死配置键**~~ **已于 2026-10-02 处理**：`lastSourceFormat`、`voiceDirs`、`perfMode`、`customPrograms` 四个只写不读的键从 `server/simple.rs::default_config()` 里删掉了（连带 `/api/tools/launch` 的 `{id}` 分支与夹具同步更新）。只留 `defaultTargetFormat` —— 它**没有写入方**是事实，但 `Convert.tsx:57` 在读（目标格式的初值），所以不是死键，改默认值只能改那一行。
11. **`docs/GLASS-HANDOFF.md` 我只读了 `AGENTS.md` 对它的引用**，本文里的小节号（§2.2 / §3.1 / §4.1）按那份引用标注，**没有逐节核对正文**。
12. **平台相关分支只有 Windows 走过**：macOS 的 `open -R` / `$HOME/Downloads`、非 Windows 的 GBK 分支（`gbk_to_string` 直接返回 `None`）都只读了代码。
13. **外部站点的线上行为未验证**：B 站 WBI / 番剧 / durl、网易云明文接口、yt-dlp 各站点 —— 写文档期间没有发任何请求。
    （其中「网易云 `enhance/player/url` 直链能不能下」已由用户在 2026-10-02 实测并记进 `AGENTS.md` §十一。）
14. **并发改动的风险**：写这份文档期间仓库里还有别的改动（`main.rs` / `server/simple.rs` / `tests/manual/*` 都有未提交修改）。本文按**我读到的那一版工作区**写；如果这些文件随后又变了，请以代码为准。（其中 `docs/NEXT-UI.md` 已于 2026-10-02 改名为 `docs/FRONTEND.md`。）
