/**
 * 后端调用 —— **每个方法就是一条 Tauri IPC 命令**。
 *
 * 后端命令只走 `call('命令名', args)`（实现见 `lib/ipc.ts`）。全部命令的唯一登记处
 * 是 `src-tauri/src/lib.rs` 的 `generate_handler!`。
 *
 * ⚠️ **没有 `{ok:true}` 信封。** 成功就是业务对象本身，失败是后端抛出来的一句
 * 中文（`call()` 会把它变成 `Error`）。**别再读 `res.ok`。**
 */

import {call, fileUrl, joinPath} from './ipc'
import type {AppState, Job, ToolInfo} from './types'

export const api = {
    /* ── 基础 ─────────────────────────────────────────────── */
    /**
     * 首屏聚合状态。**取代旧的三条**（状态 + 健康检查 + 工具探测）：
     * 版本、路径、工具、格式表、配置（Cookie 已打码）全在这一个回包里。
     *
     * ⚠️ 它会**探测外部工具**（真的 spawn `yt-dlp --version` / `python --version`），
     * 不过后端有 60 秒缓存 + 启动预热，正常情况下是毫秒级。界面那边仍有 1.2 秒兜底揭遮罩。
     */
    state: () => call<AppState>('get_state'),
    /** 全量配置（Cookie 已打码）。日常读写走 `lib/config.ts` 的 `getConfig()` / `saveConfig()` */
    config: () => call<{ config: Record<string, unknown> }>('get_config').then((r) => r.config),
    /** 配置补丁（局部更新）。回的是**更新后**的完整配置（同样打码） */
    saveConfig: (patch: Record<string, unknown>) =>
        call<{ config: Record<string, unknown> }>('set_config', {patch}),

    /* ── 检查更新（GitHub Releases）────────────────────────── */
    /**
     * 问一次上游仓库最新那条发布。**只查不装** —— 装不装由用户自己点发布页。
     *
     * ⚠️ 「上游还没发过 Release」与「GitHub 匿名调用超额」都是 `ok: false` 的
     * **正常回包**（各带一句 `error`），不是异常；`hasUpdate` 为 false 也可能是
     * **本机比远端新**（自编的包），不一定是「一样新」。
     */
    updateCheck: () => call<UpdateCheck>('update_check'),

    /* ── 音轨分离（内嵌离线引擎）──────────────────────────── */
    /**
     * 状态。页面每 2 秒轮询一次它 —— 服务的生死、模型的多少、下载的进度
     * 全在这一个回包里（少一个轮询目标就少一处不一致）。
     */
    svsepStatus: () => call<SvsepStatus>('svsep_status'),
    /** 起分离服务。已经起着就原样回（`started: false`）。**没有端口了**，别读 `port`。 */
    svsepStart: () => call<{ running: boolean; started: boolean; baseUrl?: string | null }>('svsep_start'),
    svsepStop: () => call<{ running: boolean }>('svsep_stop'),
    /**
     * 下模型（压缩包 462 MB，解压后 730 MB）。**立刻返回**，进度靠
     * `svsepStatus().download` 看 —— 后端那边是在一个后台任务里下的，不占着这个请求。
     *
     * ⚠️ 上次是**暂停**收场的话，后端自己会带 `Range` 接着下 —— 前端不用传任何
     * 「从哪继续」的参数，`.part` 在不在、链接还对不对是后端的事。
     */
    svsepDownloadModels: () => call<{ started: boolean }>('svsep_models_download'),
    /**
     * 下运行时（Python + torch，压缩包 4.7 GB、解压后 7.4 GB，**只该下一次**）。
     *
     * 与 `svsepDownloadModels` 同一套：立刻返回，进度看 `svsepStatus().download`
     * （`download.kind` 会告诉你是 `'runtime'` 还是 `'models'`，同一时刻只有
     * 一个下载在跑）。⚠️ 它解到**程序目录** `data/svsep/` —— 安装版装在
     * `Program Files` 下时那里不可写，后端会以「建目录失败」失败，页面照实显示。
     */
    svsepDownloadRuntime: () => call<{ started: boolean }>('svsep_runtime_download'),
    /**
     * 扩展包现在装在哪、默认会装到哪。
     *
     * 这是「下载时让用户选位置」那一问的数据来源：`dir` 是**当前生效**的根，
     * `defaultDir` 是「用默认位置」会写进去的那个（可写目录 —— 安装版在 `%APPDATA%`，
     * 也就是 C 盘，而扩展包合计约 8 GB）。
     */
    extDirGet: () => call<ExtDirInfo>('ext_dir_get'),
    /**
     * 换扩展包目录。**`dir: ""` = 回到默认**（可写目录）。
     *
     * ⚠️ 只改配置、**不搬文件**：8 GB 搬到一半失败比不动更糟。原位置里那份原地留着，
     * 返回的 `legacyDir` 会告诉界面它在哪。
     */
    extDirSet: (dir: string) => call<ExtDirInfo>('ext_dir_set', {dir}),
    /**
     * 下显卡加速包（24 MB，A 卡 / Intel 核显用的 DirectML）。
     *
     * ⚠️ 它和「运行时 / 模型」**共用同一份下载状态**（`svsepStatus().download`，
     * `kind` 是 `'dml'`）—— 界面不用为它学第二套进度。
     */
    svsepDmlDownload: () => call<{ started: boolean }>('svsep_dml_download'),
    /**
     * 暂停下载：`.part` 留着，下次点下载会带 `Range` 接着下。
     *
     * 不是立刻停 —— 后端是在下一块数据到达时才收手，所以按完按钮界面还会走一两秒。
     * 真正的「停了」由 `svsepStatus().download.active` 变 false 表示。
     */
    svsepPauseDownload: () => call<{ pausing: boolean }>('svsep_download_pause'),
    /**
     * 停止下载：连 `.part` 一起删掉，下次从头下。
     *
     * 和暂停的区别只有这一个 —— 用户看到的是「要不要重新下 4.7 GB」。
     */
    svsepStopDownload: () => call<{ stopping: boolean }>('svsep_download_stop'),
    /**
     * 一键删掉**所有下下来的依赖**：模型（730 MB）+ 运行时（7.4 GB）+ ffmpeg。
     *
     * ⚠️ 界面必须先让用户确认 —— 删完要重新下 4.7 GB 才能再用离线分离。
     * ⚠️ 这个调用**立刻返回**（几万个文件，后端在后台删），进度看
     * `svsepStatus().download.delete`；删完 `status` 里的 `runtimeReady` / `models.ok`
     * 自己就变 false 了。
     */
    svsepDeleteDeps: () => call<{ started: boolean }>('svsep_deps_delete'),
    /**
     * 取消正在跑的删除。已经删掉的文件不复原，只是不再往下删 —— 后端收手要等
     * 当前这一批 walk 完，所以界面照旧显示进度、等 `download.delete.active` 变 false。
     */
    svsepStopDeleteDeps: () => call<{ stopping: boolean }>('svsep_deps_delete_stop'),
    /**
     * 提交一次分离。
     *
     * ⚠️ **收的是本机路径，不是文件字节。** Python 服务要的本来就是**一个文件**，
     * 让前端把音频读成 multipart 传上来只是白搬一趟字节。
     * 所以调用方必须先拿到路径（`pick_paths` 或拖放给的**真路径**）。
     */
    svsepSeparate: (engine: 'uvr' | 'roformer', path: string) =>
        call<{ task: SvsepTask }>('svsep_separate', {path, engine}),
    svsepTask: (id: string) => call<SvsepTask>('svsep_task', {id}),
    svsepCancel: (id: string) => call<Record<string, unknown>>('svsep_cancel', {id}),
    /** 分离后端自己的设备 / 队列 / 输出目录（我们只透传） */
    svsepBackendStatus: () => call<Record<string, unknown>>('svsep_backend_status'),
    /**
     * 推理方式：自动 / GPU / CPU。
     *
     * 分离服务在跑就问它（它顺手探硬件、给 badge）；**服务没跑就读盘**上的
     * `inference_settings.json` —— 任务一结束服务会自动关，可这个开关得一直能用。
     * 回包键跟上游 `public_settings()` 一致：`{mode, effective_mode, badge, detail, offline?}`。
     *
     * ⚠️ 加速包（DirectML）**没有单独的开关**：它跟着这一档走。选 `gpu` 时若还没下，
     * 后端会顺手开始下并在回包里带 `dmlDownloading: true`（进度走 `svsepStatus().download`）。
     */
    svsepInference: () => call<Record<string, unknown>>('svsep_inference_get'),
    svsepSetInference: (mode: 'auto' | 'cpu' | 'gpu') =>
        call<Record<string, unknown> & { dmlDownloading?: boolean }>('svsep_set_inference', {mode}),

    /* ── 人声转 MIDI（原生 Rust，无子进程）──────────────────── */
    /**
     * 状态。页面每 2 秒轮询它 —— 动态库、模型、下载进度全在这一个回包里。
     *
     * 和音轨分离那套的区别只有一个：**没有「服务起没起」**。这边不拉子进程、
     * 不占端口，`running` 装的是「正在跑的那次任务 id」（同时只允许一个）。
     */
    midiStatus: () => call<MidiStatus>('midi_status'),
    /**
     * 下官方 ONNX 权重包（压缩包 364 MB，解压后 376 MB）。**立刻返回**，
     * 进度靠 `midiStatus().download` 看。
     *
     * ⚠️ 这个包**不支持续传**（后端 `svsep::fetch_to_file` 的注释说明了原因）——
     * 暂停就是重来一遍，所以界面上给的是「停止」而不是「暂停」。
     */
    midiDownloadModels: () => call<{ started: boolean }>('midi_models_download'),
    /** 停止下载并删掉半个包（不支持续传，所以没有「暂停」这个动作）。 */
    midiStopDownload: () => call<{ stopping: boolean }>('midi_download_stop'),
    /**
     * 删掉下下来的模型与动态库。界面必须先让用户确认 —— 删完要重下 364 MB。
     *
     * ⚠️ `note` 是**后端算好的中文说明**，必须显示给用户。它要说的是**安装版**
     * 才有的那种情况：可写目录在 `%APPDATA%`，而引擎可能正用着随包只读那份，
     * 删完状态仍是「就绪」、下载按钮不会出现。绿色版两层是同一个路径
     * （`models.origin === 'local'`），删掉就是真没了，这时 `note` 是空串。
     * 不把这话说出来，用户看到的就是「点了删除没反应、按钮也没了」。
     */
    midiDeleteDeps: () => call<{ files: number; bytes: number; note: string }>('midi_deps_delete'),
    /**
     * 读推理方式（自动 / GPU / CPU）与这台机器的显卡现状。
     *
     * 回包与 `midiStatus().device` **同源**，单开一条是为了让那一格能独立刷新。
     */
    midiDevice: () => call<MidiDevice>('midi_device_get'),
    /**
     * 写推理方式。**盘上记的是意愿，不是硬件现状** —— 所以后端不校验这台机器能不能用
     * GPU，界面按 `device.cuda.ok` 拦。真跑起来用不了时引擎自己退回 CPU 并写进任务日志。
     */
    midiSetDevice: (mode: MidiDeviceMode) => call<MidiDevice>('midi_device_set', {mode}),
    /**
     * 提交一次扒谱。传的是**本机音频路径**，不是文件字节 ——
     * 音频本来就在用户盘上，多传一遍只是把同一份数据从磁盘搬到磁盘。
     *
     * 立刻返回 `jobId`，进度走 `job_watch`（`useJob` 已封装）。
     */
    midiTranscribe: (body: {
        input: string
        outDir?: string
        /** 去噪步数，1~32。上游默认 8；**耗时几乎与它成正比**。 */
        steps?: number
        /** 语言 id：0 通用 / 1 en / 2 ja / 3 yue / 4 zh。 */
        language?: number
        /** ONNX 的 intra 线程数，1~32。本机实测 4 最快（见 `engine.rs` 注释）。 */
        threads?: number
    }) => call<{ jobId: string }>('midi_transcribe', {args: body}),
    /** 取消任务。**不是立刻停** —— 去噪循环在下一个 step 边界才收手。 */
    midiCancel: (id: string) => call<{ canceled: boolean }>('midi_cancel', {id}),
    /**
     * 在资源管理器里选中输出目录。
     *
     * ⚠️ 结果落在用户任选的目录里（不是固定的 `<数据目录>/outputs/<id>`），
     * 所以**必须把 `result.dir` 传回来**；`dir` 空串只会打开本功能的数据目录。
     */
    midiOpenOutput: (dir: string) => call<{ path: string }>('midi_open_output', {args: {dir}}),

    /* 类型定义在文件末尾，见 `MidiStatus`。 */

    /* ── 外部工具 ─────────────────────────────────────────── */
    /**
     * 重新检测外部工具。**它本来就绕过缓存**（这条命令的全部价值就是这个），
     * 所以没有 `force` 参数 —— 旧签名那个 `force` 保留在形参里只为不改调用点。
     */
    detect: (_force = true) =>
        call<{
            tools: Record<string, ToolInfo>;
            editors: unknown[];
            formats: FormatInfo[];
            summary: Record<string, unknown>
        }>(
            'tools_detect',
        ),
    launch: (payload: { path: string; file?: string }) =>
        call<{ launched: string }>('tools_launch', {path: payload.path, file: payload.file}),

    /* ── 文件系统 ─────────────────────────────────────────── */
    /**
     * 弹**系统**对话框，回选中的绝对路径。
     *
     * 四条入口合一：`folder` 选目录、`multi` 多选、`save` 另存、默认单选。
     *
     * ⚠️ 取消**不是错误**：回的是空数组（`files: []`）。
     * ⚠️ 选中的东西会**同时被放行给 asset 协议**（选目录是递归放行），所以前端拿到
     * 路径就能直接 `fileUrl(path)` 播放，不用再问一次权限。
     *
     * （返回字段仍叫 `files` 是为了少改调用点；后端回的是 `{paths}`，这里归一了一下。）
     */
    fsPick: async (
        opts: { exts?: string[]; label?: string; title?: string; dir?: string; multi?: boolean; folder?: boolean } = {},
    ) => {
        const mode = opts.folder ? 'folder' : opts.multi ? 'open-multi' : 'open'
        const r = await call<{ paths: string[] }>('pick_paths', {
            mode,
            title: opts.title,
            dir: opts.dir,
            exts: opts.exts?.length ? opts.exts : undefined,
            label: opts.label,
        })
        return {files: r.paths ?? []}
    },
    /**
     * 把**只有 `File` 对象、没有路径**的场合兜底成一条本机路径（落进临时目录）。
     *
     * ⚠️ 2 GiB 上限必须在**读进内存之前**按 `size` 拦：`upload_dropped` 的 `LIMIT`
     * 查的是收完的字节数（`src-tauri/src/ipc/fs.rs`），后端拒超限时最坏的那类文件
     * 已经在内存里了。两处上限要一起改。
     */
    fsUpload: async (file: File) => {
        const LIMIT = 2 * 1024 * 1024 * 1024
        if (file.size > LIMIT) {
            throw new Error(`单个文件不能超过 ${LIMIT / (1024 * 1024 * 1024)} GiB`)
        }
        const bytes = new Uint8Array(await file.arrayBuffer())
        return call<{ path: string; name: string; bytes: number }>('upload_dropped', {
            name: file.name,
            bytes,
        })
    },
    /** 新建目录 */
    fsMkdir: (path: string) => call<{ path: string }>('mkdir', {path}),
    /** 在文件管理器里**选中**它（`select = false` 则是直接打开） */
    fsReveal: (path: string, select = true) => call<{ path: string }>('open_path', {path, reveal: select}),
    /**
     * 打开一个路径或网址。
     *
     * ⚠️ 两条路在 IPC 里是**两条命令**（`open_path` / `open_url`）——旧 HTTP 那条
     * `fs/open` 把两种参数混在一个入口里，结果是「传了 url 却被当成不存在的路径」
     * 这种必然 400 的 bug 藏了很久。这里按参数分派，行为与旧入口一致。
     */
    fsOpen: (payload: { path?: string; url?: string }) =>
        payload.url
            ? call<{ ok: boolean; url: string }>('open_url', {url: payload.url})
            : call<{ path: string }>('open_path', {path: payload.path ?? ''}),
    /**
     * 放行一个目录给 **asset 协议**。
     *
     * ⚠️ 这条不是可选的：asset 协议的 scope 是**空**的（用户挑的目录在编译期不可能
     * 知道），所以凡是「播放一个不是用户刚选的文件」（分离产物、扒谱产物）都要先放行
     * 一次 —— 漏了的症状是 `<audio>` **静默**不播、控制台一条 403。
     */
    allowPath: (path: string) => call<{ allowed: string }>('allow_path', {path}),

    /* ── 背景壁纸（只读用户自己的 Wallpaper Engine 库）────────── */
    /**
     * 扫一遍壁纸库：装了没、有哪些、现在用的是哪一张。
     *
     * 只读磁盘上的 `project.json`（几十个小文件），不联网、不改动任何东西。
     */
    wallpaperScan: () => call<WeScan>('wallpaper_scan'),
    /**
     * 读一个场景包（`scene.pkg`）的字节，给 webwallgl 的 `bytesSource` 用。
     *
     * ⚠️ 后端回的是 **`tauri::ipc::Response`（原始字节）**，不是 JSON 数组 ——
     * 几十 MB 的包过 JSON 会膨胀好几倍、把窗口卡死。所以这里的返回类型不是普通对象，
     * 用之前先 `loadPkg()`（`lib/wallpaper.ts`）归一化。
     */
    wallpaperPkg: (path: string) => call<ArrayBuffer>('wallpaper_pkg', {path}),

    /* ── 工程转换 ─────────────────────────────────────────── */
    /**
     * 递归收集一个目录里的工程文件（本地路径数组）。
     *
     * ⚠️ 后端读的是 **`dirs`（数组）**，不是 `dir` —— 旧界面发的是 `{dir, recursive}`，
     * Rust 后端整个忽略它、永远回 `files: []`。这里按后端契约发。
     */
    collect: (dir: string) =>
        call<{ files: string[]; count: number; extensions: string[] }>('convert_collect', {
            args: {dirs: [dir]},
        }),
    /**
     * 读一个工程，给出轨道 / 音符概览。请求体是 `{inputPath}`（或 `{path}`），
     * 回 `{stats:{trackCount,noteCount}, tracks, tempos, timeSignatures, lyrics}`。
     */
    inspect: (payload: { inputPath: string }) => call<ConvertInspect>('convert_inspect', {args: payload}),
    /**
     * 转换前预检：`{inputs, toFormat}` → `findings`（info/warn/err）。
     *
     * ⚠️ 后端**只分析 `inputs[0]`**，批量要逐个文件调。
     */
    preview: (payload: { inputs: string[]; toFormat: string }) =>
        call<{ findings: Finding[]; inputCount: number }>('convert_preview', {args: payload}),
    /**
     * 真转。`{inputs, toFormat, outDir?, nameTemplate?, overwrite?, options?}` → `{jobId}`
     *
     * ⚠️ `inputs` 是**本机路径**。旧 HTTP 时代还有一对 `*-upload`（JSON + base64 编码
     * 的文件内容），那是「页面拿不到本机路径」逼出来的；现在对话框与拖放都给真路径，
     * **那条路整个删了，别再把它加回来**。
     */
    convert: (payload: Record<string, unknown>) => call<{ jobId: string }>('convert_run', {args: payload}),

    /* ── 文字 PV 的分块落盘 ───────────────────────────────── */
    /**
     * 写一块二进制到 `<dir>/<name>`（文字 PV 导出 MP4 / PNG 序列 / WAV 用）。
     *
     * `part` 从 0 开始，**0 是新建**（同名自动挑一个不重名的），之后是追加；
     * `total` 是一共几块，只用来算 `done`。
     *
     * ⚠️ **为什么是分块**：4K 的 MP4 有几百 MB，一次传完等于把几百 MB 同时按在
     * WebView 和 Rust 两边的内存里。分块之后峰值内存只有一块的大小。
     * ⚠️ 单块上限 **16 MB**（`ipc/pv.rs::PV_CHUNK_LIMIT`，IPC 没有 body limit 这个概念了，
     * 这个上限是后端自己守的），前端按 8 MB 切。
     */
    pvSaveChunk: (dir: string, name: string, part: number, total: number, bytes: Uint8Array) =>
        call<{ path: string; name: string; size: number; part: number; done: boolean }>('pv_save_chunk', {
            dir,
            name,
            part,
            total,
            bytes,
        }),

    /* ── 视频解析下载 ─────────────────────────────────────── */
    parseVideo: (payload: { url: string; cookie?: string }) => call<VideoParse>('video_parse', {args: payload}),
    downloadVideo: (payload: Record<string, unknown>) =>
        call<{ jobId: string }>('video_download', {args: payload}),
    /**
     * 把一条远端直链**缓存成本机文件**，回它的路径。
     *
     * 这是旧那条本机反代路由的替代品：`<video src>` 要的是一个可寻址的地址，
     * 而 IPC 是请求-应答、没有流也没有 Range。所以改成先落盘、再 `fileUrl(path)`
     * 交给 `<video>`（Range 由 asset 协议内置）。
     *
     * ⚠️ **首播要等几秒**（一支 1080P 的 MV 几百 MB），界面必须给「缓存中…」的提示；
     * 同一支看第二次是瞬时的（`cached: true`）。
     * ⚠️ 只接受**本进程解析结果里出现过的主机** —— 先 `parseVideo` 再预览。
     */
    previewFetch: (url: string, src: 'bilibili' | 'ytdlp' = 'bilibili') =>
        call<{ path: string; bytes: number; cached: boolean }>('preview_fetch', {url, src}),
    /** 清掉整个预览缓存，回删掉多少字节。 */
    previewClear: () => call<{ freedBytes: number }>('preview_clear'),

    /* ── B 站扫码登录（Cookie 后端落盘，回包里永远没有 Cookie）── */
    biliQrGenerate: () => call<{ url: string; qrcodeKey: string }>('bili_qr_generate'),
    biliQrPoll: (qrcodeKey: string) =>
        call<{ code: number; message: string; loggedIn: boolean }>('bili_qr_poll', {qrcodeKey}),
    biliLogout: () => call<{ loggedOut: boolean }>('bili_logout'),

    /* ── 音频 ─────────────────────────────────────────────── */
    audioProbe: (input: string) => call<AudioProbe>('audio_probe', {input}),
    audioRun: (payload: Record<string, unknown>) => call<{ jobId: string }>('audio_run', {args: payload}),

    /* ── 资源库 ───────────────────────────────────────────── */
    resources: (reload = false) => call<Resources>('get_resources', {reload}),
    /**
     * 外链校验。⚠️ 后端**还是占位实现**（回 `{results: [], pending: true}`，没有 `jobId`），
     * 页面认这个形状并提示「后端还没接上链接校验」。
     * `jobId` 留在类型里是为了「哪天后端接上真实校验时页面不用改」。
     */
    checkLinks: () => call<{ results: unknown[]; pending?: boolean; jobId?: string }>('check_resources'),

    /* ── 歌词（网易云专区）───────────────────────────────── */
    /* 歌词页只有网易云，`source` 只剩 'netease' 一个值。
       后端仍然**收**这个字段（回包里也带 `source`），所以这里继续传 —— 只是没有第二档可选。 */
    lyricsSearch: (payload: { source: LyricsSource; keyword: string }) =>
        call<{ source: LyricsSource; keyword: string; songs: LyricsHit[] }>('lyrics_search', {args: payload}),
    lyricsGet: (payload: { source: LyricsSource; id: string | number }) =>
        call<LyricsDoc>('lyrics_get', {args: payload}),
    /** 后端现在只认网易云的 `?id=` / `/song/<id>` / 纯数字；认不出来会明确报错 */
    lyricsParseLink: (payload: { url: string }) =>
        call<{ source: LyricsSource; id: string }>('lyrics_parse_link', {args: payload}),
    /** 回包是 { source, id, song, lyric, trans, encoding }（与 get 同形，另加 encoding: utf-8 | gbk） */
    lyricsImport: (payload: { path: string }) =>
        call<LyricsDoc & { encoding?: string }>('lyrics_import', {args: payload}),
    lyricsSave: (payload: Record<string, unknown>) =>
        call<{ path: string; name: string; format: string; size: number }>('lyrics_save', {args: payload}),
    lyricsCover: (payload: { url: string; outDir: string; name?: string }) =>
        call<{ path: string; name?: string; size?: number }>('lyrics_cover', {args: payload}),
    /* 歌曲直链下载的回包是 `{ path, name, size, level, format, downgraded }`。
       ⚠️ 拿不到直链时后端**抛一句给用户看的中文**（版权受限 / 只有会员能听），
       页面直接 `toast(e.message)`，不要再包一层「下载失败」。

       下载档位与网易云登录态这两组的做法参考了 FusionMusicPlayer
       （https://github.com/Janson20/FusionMusicPlayer，GPL-3.0），未拷贝其代码。 */
    /**
     * 下载歌曲音频。
     *
     * `quality` 是档位上限（`auto` / `hires` / `lossless` / `exhigh` / `higher` / `standard`）。
     * 回包里的 `level` 是**实际**拿到的档位 —— 服务端会静默降级（求无损只给 320 kbps），
     * `downgraded` 说明是否发生了这件事，提示里要如实写明。
     * `durationSec` 用来拦「只拿到 30 秒试听片段」，拿不到就不传（后端此时不判）。
     */
    lyricsSong: (payload: {
        id: string | number
        outDir: string
        name?: string
        quality?: string
        durationSec?: number
    }) =>
        call<{
            path: string
            name: string
            size: number
            level: string
            format: string
            downgraded: boolean
        }>('lyrics_song', {args: payload}),
    lyricsSms: (phone: string) => call<{ sent: boolean; phone: string }>('lyrics_login_sms', {args: {phone}}),
    lyricsCellphone: (phone: string, captcha: string) =>
        call<{
            loggedIn: boolean
            phone: string
            nickname: string
            vip: string
            vipDetail: string
            expiresAt: number
        }>('lyrics_login_cellphone', {args: {phone, captcha}}),
    /**
     * 查登录态与账号信息。
     *
     * `state` 必须分开处理：`expired` 是服务端说凭据不行了（置为未登录并引导重新登录），
     * `offline` 只是网络不通，**绝不能因此清掉本地的登录态**。
     */
    lyricsAccount: () =>
        call<{
            state: 'ok' | 'expired' | 'offline' | 'anonymous'
            nickname: string
            vip: string
            vipDetail: string
            expiresAt: number
            renewBeforeDays: number
            /** 后端按 renewBeforeDays 算好的（现在几点只在一处取），前端据此决定要不要续期 */
            shouldRenew: boolean
        }>('lyrics_account', {args: {}}),
    /** 手动续期。续期是换发（旧的也还有效），所以失败不代表掉登录 */
    lyricsRenew: () =>
        call<{ renewed: boolean; nickname: string; vip: string; expiresAt: number }>('lyrics_renew', {
            args: {},
        }),
    lyricsLogout: (source: LyricsSource) => call<Record<string, unknown>>('lyrics_logout', {args: {source}}),

    /* ── 任务 ─────────────────────────────────────────────── */
    jobs: () => call<{ jobs: Job[] }>('list_jobs'),
    job: (id: string) => call<{ job: Job }>('get_job', {id}),
    cancelJob: (id: string) => call<{ job: Job }>('cancel_job', {id}),
}

/* ── 一些共用的数据形状（只写页面真会用到的字段）────────────── */

export interface Finding {
    level: 'info' | 'warn' | 'err'
    message: string
}

interface ConvertInspect {
    /** 概览：轨道数 / 音符数 */
    stats?: { trackCount?: number; noteCount?: number }
    tracks?: unknown[]
    tempos?: unknown[]
    timeSignatures?: unknown[]
    lyrics?: unknown

    [k: string]: unknown
}

/**
 * `video_parse` 的回包 —— 照后端源码（`ipc/media.rs`、`bili.rs`、`ytdlp.rs`）声明。
 *
 *   - `currentPage` 是**对象**（`{cid,page,title,durationSec,width,height}`），不是页码数字；
 *   - 流对象带 `kind / url / backupUrls / mimeType`；
 *   - `streams` 还有 `acceptQuality / acceptDescription / videoAvc / videoHevc / durationMs / isPreview`；
 *   - durl 回退是 `mode:'durl'` + `streams[]`（分段，带 `index/size/lengthMs`），没有 `video`/`audio`；
 *   - 解析失败时 `streams` 是 `{ error }` —— **这种回包没有 `mode`**，所以 `mode` 是可选的；
 *   - yt-dlp 来源**没有 `streams`**（是缺字段，不是 `null`），`info` 走 yt-dlp 那套字段；
 *   - 番剧多一个 `info.episodes`，且**没有 `currentPage`**。
 */
export interface VideoParse {
    source: string
    kind: 'video' | 'bangumi'
    info: VideoInfo
    /** ⚠️ 对象，不是数字 */
    currentPage?: VideoPage
    /** ⚠️ yt-dlp 来源没有它；B 站超出可解析范围时是 `{ error: ... }` */
    streams?: VideoStreams | null
    hasCookie?: boolean
}

export interface VideoInfo {
    kind?: string
    bvid?: string
    aid?: number
    title: string
    cover?: string
    desc?: string
    durationSec?: number
    publishDate?: string
    uploader?: string
    uploaderMid?: number
    /* 播放量 / 点赞：后端是把 B 站的 stat.view / stat.like 原样拷过来，取不到就补 0 —— 都是 JSON 数字。 */
    view?: number
    like?: number
    pages?: VideoPage[]
    /** 番剧剧集（`kind === 'bangumi'` 时）；普通视频是 `null` */
    episodes?: VideoEpisode[]
    season?: { title?: string; episodes?: VideoEpisode[] } | null
    /** 番剧：当前这一集的 epId（剧集行靠它高亮） */
    epId?: number
    url?: string
    /* ── 以下是 yt-dlp 来源专有，B 站那份 info 不发这些字段 ── */
    id?: string
    thumbnail?: string
    description?: string
    uploadDate?: string
    viewCount?: number
    extractor?: string
    webpageUrl?: string
    /** 字幕**语言键**数组（`ytdlp.rs` 只取 key）；没有字幕时是 `[]` */
    subtitles?: string[]
    formats?: VideoFormat[]
}

export interface VideoPage {
    cid?: number
    page?: number
    title?: string
    durationSec?: number
    width?: number
    height?: number
}

export interface VideoEpisode {
    /** 番剧用 epId 定位，不是 cid */
    epId?: number
    id?: number
    bvid?: string
    title?: string
    /** 番剧的长标题（`title` 为空时页面拿它兜底） */
    longTitle?: string
    durationSec?: number
    cover?: string
}

export interface VideoStream {
    kind?: 'video' | 'audio' | 'segment'
    id: number
    qualityName: string
    url?: string
    backupUrls?: string[]
    bandwidth?: number
    mimeType?: string
    codecs?: string
    width?: number
    height?: number
    frameRate?: string
    /* ── 只有 durl 的分段（`kind: 'segment'`）有这三个 ── */
    index?: number
    size?: number
    lengthMs?: number
}

export interface VideoStreams {
    /** ⚠️ 出错时后端只发 `{ error }`，没有 `mode` —— 所以是可选的 */
    mode?: 'dash' | 'durl'
    acceptQuality?: number[]
    acceptDescription?: string[]
    video?: VideoStream[]
    /** 按编码分好组的三份（同一批流） */
    videoAvc?: VideoStream[]
    videoHevc?: VideoStream[]
    audio?: VideoStream[]
    /** durl 回退：整段流的各分段（没有 `video`/`audio`） */
    streams?: VideoStream[]
    durationMs?: number
    isPreview?: boolean
    error?: string
}

/** yt-dlp 的一条可下载格式（`ytdlp.rs` 归一化后的形状） */
export interface VideoFormat {
    formatId?: string
    ext?: string
    resolution?: string
    fps?: number
    vcodec?: string
    acodec?: string
    filesize?: number
    isVideo?: boolean
    /**
     * 直链。**只给预览用**（页面里的 `<video>` 要它），下载一律走后端、不用这个 URL。
     * ⚠️ 预览也不能直接用它 —— 要先 `api.previewFetch(url, 'ytdlp')` 缓存成本机文件。
     */
    url?: string
}

interface AudioProbe {
    info: {
        durationSec: number
        audio?: { codec?: string; sampleRate?: number; channels?: number; bitrate?: number }
        video?: { codec?: string; width?: number; height?: number }
    }
}

/** 一种工程格式（40 种），`tools_detect` 与 `get_state` 都发 */
interface FormatInfo {
    id: string
    name: string
    exts: string[]
    group: string
    available: boolean
}

interface Resources {
    version: number
    updatedAt: string
    notice?: string
    verifySummary?: { checkedAt: string; total: number; ok: number; warn: number; dead: number; passRate: number }
    groups: {
        id: string
        name: string
        description: string
        icon: string
        items: ResourceItem[]
    }[]
}

export interface ResourceItem {
    id: string
    name: string
    url: string
    home: string
    tags: string[]
    region: '国内' | '海外' | '均可'
    cost: string
    official: boolean
    desc: string
    tip?: string
    verified?: { verdict: 'ok' | 'warn' | 'dead'; status?: number; checkedAt?: string }
}

/**
 * 歌曲来源。2026-10-02 起歌词页是**网易云专区**，只剩这一个值 ——
 * 类型留成联合是为了让「以后再加来源」时改动点集中在这里（`'file'` 只在
 * 本地 `.lrc` 导入的回包里出现，不参与请求）。
 */
type LyricsSource = 'netease'

/** 搜索结果里的一条（字段名以后端为准：`name` / `artists`，不是 `title` / `artist`） */
interface LyricsHit {
    /** 网易云歌曲 id（数字串）—— 统一按字符串传回去 */
    id: string
    name: string
    artists?: string
    album?: string
    cover?: string
    durationSec?: number
    /**
     * 网易云的收费标记：0 免费、1 VIP、8 低音质免费（还有 4 等）。
     * ⚠️ **不是「能不能下载」**：实测同为 0 的歌，有的拿得到直链、有的拿不到。
     * 界面只把它当标签，真正决定能不能下的看下面那个 `playable`。
     */
    fee?: number
    /**
     * 这个版本能不能拿到直链 —— 后端在搜索后**批量**打一次播放接口标出来的。
     * 探测失败时后端**不写这个字段**，所以是可选值：`undefined` = 没探测到，
     * 界面别显示成「不能下」。
     */
    playable?: boolean
}

/** `lyrics_get` / `lyrics_import` 里那个 `song`：与搜索结果同形，但**没有 `id`**（id 在外层） */
type LyricsSongInfo = Omit<LyricsHit, 'id'>

/**
 * `lyrics_get` 与 `lyrics_import` 的回包。
 *
 * ⚠️ 歌曲信息**嵌在 `song` 里**，`source` / `id` / `lyric` / `trans` 在外层平铺 —— 不是全平铺。
 */
interface LyricsDoc {
    /** netease（取词）/ file（本地导入）—— 2026-10-02 起没有 qq 了 */
    source: string
    /** 网易云歌曲 id、或导入时的完整路径 */
    id: string
    song?: LyricsSongInfo
    /** 原文 LRC */
    lyric?: string
    /** 译文（可能没有） */
    trans?: string
    /** 仅导入本地文件时有：utf-8 / gbk */
    encoding?: string
    /**
     * 「这个版本能不能下」—— **不是后端回的**，是页面从搜索结果那条 `LyricsHit` 上带过来的。
     * `undefined` = 从链接/导入进来的，没探测过。
     */
    playable?: boolean
}

/* ── 音轨分离（内嵌的离线引擎）─────────────────────────────
 *
 * 这一组和别的都不一样：它转发给一个**跑在本机的 Python 子进程**（见 Rust 的 `svsep.rs`）。
 * 三条不成文的规矩：
 *
 *  1. **它不是随叫随到的。** 服务没起时所有命令都会报「分离服务还没启动」，
 *     页面必须先看 `svsep_status` 的 `running` 再决定给不给按钮。
 *  2. **第一次用之前没有模型**（730 MB，不随包发）。
 *  3. **一次任务几分钟到几十分钟**。提交完只拿 `task`，进度靠轮询 `svsepTask`。
 */

/**
 * 「扩展包下得慢就自己去网盘下」那个分享链接 —— 音轨分离页与人声转 MIDI 页**共用一份**。
 *
 * ⚠️ 这是**国内直连**的那条退路（GitHub release 即便走镜像也可能很慢）。
 * ⚠️ 用户下下来的是**压缩包**，不用解压：丢到扩展包目录下就行 —— 后端扫目录认出来
 * （`svsep.rs::manual_sets` / `midi_transcribe.rs::manual_zip`），界面把按钮从「下载」
 * 换成「解压」，点了直接解盘上那份、一个字节都不下。
 */
export const MANUAL_PACKS_URL =
    'https://1856610041.share.123pan.cn/123pan/xHE8vd-0v0h3?pwd=QM39'

/** 一个模型的落盘状态。⚠️ `size` 与 `expectedSize` 都是**字节**。 */
export interface SvsepModel {
    /** `uvr` | `roformer` */
    key: string
    name: string
    label: string
    /** `missing` | `partial`（下了一半）| `ok` */
    state: string
    size: number
    expectedSize: number
}

/** `status` 回包里 `models` 那一整块 */
export interface SvsepModels {
    dir: string
    ok: boolean
    downloadedBytes: number
    /** ⚠️ 解压后的体积，**不是要下多少** —— 要下的那个看 `zipBytes` */
    expectedBytes: number
    /**
     * 压缩包体积（真正要下的字节）。
     * ⚠️ **不是** `expectedBytes`（那是解压后占多大）—— 拿错会把 4.9 GB 说成 7.9 GB。
     * 运行时的包是**分卷**上传的，这个数是各卷之和。
     */
    zipBytes?: number
    downloadUrl: string
    items: SvsepModel[]
    missingIndex: string[]
    /** 盘上有没有**用户手放的**整套包 —— 有就把按钮写成「解压」（见 `MANUAL_PACKS_URL`） */
    manual?: string[]
}

/** 运行时（Python + torch）的状态。**几 GB，只该下一次**。 */
export interface SvsepRuntime {
    dir: string
    /** `python.exe` 与 `backend/app.py` 都在 —— 这才是判据 */
    ready: boolean
    downloadUrl: string
    /** ⚠️ 解压后的体积，**不是要下多少** */
    expectedBytes: number
    /** 压缩包体积（见 `SvsepModels.zipBytes` 那条同样的话） */
    zipBytes?: number
    python: boolean
    backend: boolean
    pythonPath: string
    backendPath: string
    /** 见 `SvsepModels.manual` */
    manual?: string[]
}

/**
 * 显卡加速（DirectML，A 卡 / Intel 核显）的现状。
 *
 * `installed` = 包装没装；`active` = 那份 ORT 是不是真排在 `site-packages` 前面；
 * `nvidia` = 这台机器有没有 N 卡（有就该走 CUDA，`auto` 模式下不会开 DML）。
 */
export interface SvsepDml {
    installed: boolean
    active: boolean
    nvidia: boolean
    dir: string
    /** 压缩包体积（24 MB 上下） */
    zipBytes: number
    /**
     * 盘上有没有**用户手放的**加速包（`.whl`）—— 有就把这一步的按钮写成「解压」。
     *
     * 这个包是从 PyPI 下的（不是我们的 release），境内也常常很慢，所以网盘那条退路
     * 对它同样成立。见 `MANUAL_PACKS_URL`。
     */
    manual?: string[]
}

/** 库里的一张壁纸（`wallpaper_scan` 回包里的元素；解析逻辑见 `lib/wallpaper.ts`）。 */
export interface WeItem {
    id: string
    title: string
    /** `scene` / `video` / `web` / …（`project.json` 的 type，已小写） */
    type: string
    /** workshop / myprojects / defaultprojects / local */
    source: string
    dir: string
    pkg: string | null
    media: string | null
    preview: string | null
}

/** `wallpaper_scan` 的回包。 */
export interface WeScan {
    found: boolean
    weDir: string | null
    currentFile: string | null
    current: WeItem | null
    items: WeItem[]
}

/**
 * 扩展包目录（`ext_dir_get` / `ext_dir_set` 的回包）。
 *
 * 音轨分离的运行时 / 模型、人声转 MIDI 的 GAME 模型全落在它下面，合计约 8 GB ——
 * 所以界面在**第一次下载之前**要拿这份信息问一次用户（见 `lib/extDir.tsx`）。
 */
export interface ExtDirInfo {
    /** 这一次运行真正用的根 */
    dir: string
    /** 正在用的是不是默认位置（可写目录）。`true` 时就是「没选过」 */
    isDefault: boolean
    /** 「用默认位置」会写到哪 */
    defaultDir: string
    /** 安装版还是绿色版 —— 默认位置在 `%APPDATA%`（C 盘）时值得提醒一句 */
    installed: boolean
    /** 音轨分离的运行时已经装好了吗（`python.exe` 与 `backend/app.py` 都在） */
    hasRuntime: boolean
    /** 换过目录后老位置可能还留着几 GB —— 没换过就是 `null` */
    legacyDir: string | null
}

/** 大包 zip 的下载进度（后端内存里的一份，不是磁盘上的） */
export interface SvsepDownload {
    active: boolean
    /** `'dml'` 是显卡加速包（24 MB，走同一份状态） */
    kind?: 'runtime' | 'models' | 'dml' | null
    done: number
    total: number
    /**
     * `'download'` = 还在从网上拿字节，`'extract'` = 整包已经下完、正在解压。
     *
     * ⚠️ 两个阶段的**进度分母差不多一样大**，所以不分段的界面看着就是「下到 100% →
     * 归零 → 再爬一遍」。别把这个字段删了。
     */
    stage: 'download' | 'extract'
    error?: string | null
    resumable: boolean
    pausedKind: 'runtime' | 'models' | null
    pausedBytes: number
    delete: { active: boolean; files: number; bytes: number }
}

export interface SvsepStatus {
    runtimeReady: boolean
    dir: string
    modelsDir: string
    dataDir: string
    /** 分离结果落在 `<outputsDir>/<task_id>/<文件名>` */
    outputsDir: string
    /**
     * 扩展包根（**当前生效**的那个：设置里改过就是用户选的）。
     * 界面上「下得慢就自己去网盘下」那行提示显示它 —— 用户改了落点这行跟着变。
     */
    extDir?: string
    runtime: SvsepRuntime
    models: SvsepModels
    /** 显卡加速那一块（`installed` / `active` / `nvidia` / `zipBytes`） */
    dml?: SvsepDml
    download: SvsepDownload
    /** 分离服务在不在听 */
    running: boolean
    lastError: string | null
}

/** 分离后端自己的一条输出轨 */
export interface SvsepOutput {
    filename: string
    /** 给人看的文件名（`(Vocals)_xxx.wav`） */
    download_name?: string
    /** 上游给的相对地址 —— **前端不用它**，播放/下载都按文件名自己拼本机路径 */
    download_url?: string
    preview_url?: string
    size?: number
    stem?: string
}

export interface SvsepTask {
    id: string
    engine: 'uvr' | 'roformer'
    status: string
    /** ⚠️ 上游是**按时间估的**，不是真进度：会长时间卡在 90% 再跳 100% */
    progress: number
    message?: string
    outputs?: SvsepOutput[]
    error?: string | null
}

/**
 * 一条分离输出轨的地址。
 *
 * 落盘位置是 `<outputsDir>/<task_id>/<文件名>`（`svsep.rs::output_path`）——
 * 任务结束分离服务会自动关，而文件就在盘上，所以服务关着也能试听、也能下载。
 *
 * ⚠️ 传进来的 `outputsDir` 得是**放行过给 asset 协议**的那个（`api.allowPath`），
 * 否则 `<audio>` 会静默 403。
 */
export const svsepFileUrl = (outputsDir: string, taskId: string, filename: string) =>
    fileUrl(joinPath(outputsDir, taskId, filename))

/* ── 人声转 MIDI（GAME 的原生 Rust 移植）─────────────────────
 *
 * 这一组和音轨分离**形态上像、底下完全不同**：那边转发给一个 Python 子进程，
 * 这边直接在工作站进程里算。所以这里没有端口、没有「服务起没起」。
 */

/** 一个结果音符。`pitch` 是**半音浮点**（69 = A4），`midi` 是它四舍五入后的整数。 */
export interface MidiNote {
    onset: number
    offset: number
    pitch: number
    midi: number
}

export interface MidiRuntime {
    ready: boolean
    dll: string | null
}

export interface MidiModels {
    ready: boolean
    missing: string[]
    dir: string
    /**
     * 引擎此刻用的模型**在哪个目录**：
     * - `'downloaded'` —— `<可写>/game/models`
     * - `'bundled'` —— `<root>/data/game/models`，且它**不是**下载落点（只可能出现在安装版）
     * - `'local'` —— 绿色版：两层是**同一个绝对路径**
     *
     * ⛔ 别在前端按 `dir` 的尾巴猜：三种情况的路径都以 `\game\models` 结尾。
     */
    origin: 'downloaded' | 'bundled' | 'local'
    zipBytes: number
    extractBytes: number
    partBytes: number
    /** 盘上有没有**用户手放的**整套包 —— 有就把按钮写成「解压」（见 `MANUAL_PACKS_URL`） */
    manual?: string[]
}

export interface MidiDownload {
    active: boolean
    kind: string | null
    stage: string
    done: number
    total: number
    error: string | null
    /** 恒为 false —— 这个包不支持续传（停下就是重来），前端据此不画「继续」 */
    resumable: boolean
}

/** 推理方式（自动 / GPU / CPU）。落盘在 `<可写>/midi/midi_settings.json`。 */
export type MidiDeviceMode = 'auto' | 'gpu' | 'cpu'

/**
 * 推理方式的现状 —— `midi_device_get` / `midi_device_set` 的回包，也是
 * `midi_status().device` 那一块。
 */
export interface MidiDevice {
    mode: MidiDeviceMode
    cuda: {
        /**
         * ⚠️ 报的是「CUDA **建得出会话**」（后端真拿一张 1×1 的图试过），**不是**「保证跑得完」。
         * GPU 那一格能不能选**只看这个值**：`navigator.gpu`、显卡名字之类都与 ONNX Runtime 无关。
         */
        ok: boolean
        /** 后端算好的一句话，`!ok` 时直接显示给用户，界面别自己另编一套 */
        detail: string
    }
    /** 选了 GPU 但当前用不上时后端给的话术；空串 = 没有要说的 */
    note: string
}

export interface MidiStatus {
    runtime: MidiRuntime
    models: MidiModels
    license: string
    source: string
    /** 扩展包根（见 `SvsepStatus.extDir` 那条同样的话） */
    extDir?: string
    download: MidiDownload
    /** 推理方式与显卡现状（与 `midiDevice()` 同源） */
    device: MidiDevice
    /** 正在跑的那次任务 id；null = 空闲（同时只允许一个） */
    running: string | null
}

/* ── 检查更新（后端 `update.rs` 拼的回包）─────────────────── */

/**
 * `update_check` 的回包。
 *
 * ⚠️ `ok: false` 是**正常回包**（上游没发过 Release、GitHub 匿名调用超额），
 * 只有真连不上才走 `Error`；`hasUpdate: false` 也可能是本机比远端新。
 * 所以除 `ok` 外都是可选的 —— 失败时后端只发 `ok` + `error`。
 */
export interface UpdateCheck {
    ok: boolean
    /** 失败的原因（后端写好的中文，直接显示） */
    error?: string
    /** 本机版本，例如 `1.3.3beta` */
    current?: string
    /** 上游最新 tag，已去掉前导 `v` */
    latest?: string
    /** 上游比本机新。**本机比上游新时也是 false** */
    hasUpdate?: boolean
    /** 发布的标题（可能为空串） */
    name?: string
    /** 发布说明（markdown 原文，后端截到 4000 字） */
    notes?: string
    /** 发布页地址 */
    url?: string
    /** ISO 8601，例如 `2026-08-01T12:00:00Z` */
    publishedAt?: string
    prerelease?: boolean
    /** 那条发布带的附件文件名 */
    assets?: string[]
    /**
     * 这一次是**谁答的**：`GitHub 直连`、或镜像的域名（如 `https://gh-proxy.com`）。
     *
     * ⚠️ 直连不通时后端会自动改走镜像（境内常见），界面要把这件事说出来 ——
     * 用户有权知道版本信息是第三方代答的。
     */
    via?: string
}

/**
 * 语言 id。**照官方 `config.json` 的 `languages` 映射**，不是自己编的
 * （实测 `{'en':1,'ja':2,'yue':3,'zh':4}`，0 = 通用）。
 */
export const MIDI_LANGUAGES = [
    {id: 0, label: '通用（不告诉它语言）'},
    {id: 4, label: '中文'},
    {id: 1, label: '英语'},
    {id: 2, label: '日语'},
    {id: 3, label: '粤语'},
] as const

export default api
