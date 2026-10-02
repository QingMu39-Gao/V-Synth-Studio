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
    vite.config.ts    base '/'，outDir '../web'（emptyOutDir **必须是 false**，见下）
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
        api.ts        后端调用（39 条路由；API 在根路径 /api/*，**必须写绝对路径**）
        types.ts      后端数据结构（照 tests/contract/fixtures 定义）
        format.ts     formatBytes / formatDuration / formatNumber
        useJob.ts     任务订阅：SSE + 轮询兜底（旧 watchJob 的 React 版）
        useGlass.ts   玻璃等级 1~4（材质 / 透明度 / 面板要不要玻璃全由它派生）
        useNavLens.ts 侧栏与小节导航的滑动高亮块
        boot.ts       揭开启动加载画面
      pages/          8 页：Dashboard / Convert / Video / Audio / Lyrics / Pv / Resources / Settings
                      （每页自带一个同名 .css；页面约定与库组件清单见 docs/FRONTEND.md）
```

> **启动加载画面**：`index.html` 的 `#boot`（样式内联、12 秒兜底）+ `lib/boot.ts` 揭开，规范见 `GLASS-HANDOFF` §4。

> ⚠️ **目录树里这几个文件已经不存在了**：`lib/useTheme.ts`、`lib/usePerfMode.ts`。
> 主题与「降低透明度」现在都在 `App.tsx` 里，直接喂给库的 `GlassProvider`
> （`theme` / `transparency` 两个 prop）。`perfMode` 这个 config 字段后端有，
> **新前端还没接**。详见 `docs/GLASS-HANDOFF.md`。
  web/                前端**产物 + 随包静态资源**（后端伺服的就是这个目录）
    index.html        ← Vite 产物（index.html + assets/ 都归它，**刷新即生效**）
    assets/           ← Vite 产物（带内容哈希，每次构建新增；emptyOutDir:false 所以旧的不自动删）
    vendor/jizura/    JIZURA 文字 PV（上游构建产物 + 2335 个字体）—— **不是产物，别让构建清掉**
    img/bg/           桌面背景图（明亮/黑暗）—— 同上，被 index.css 以 url() 引用
    img/logo.png      顶栏图标（源 app/desktop/icons/128x128.png，拷进来才伺服得到）
  data/                只读数据：resources.json / pinyin.json（schema 见第七节）
                      绿色版的可写 config.json 也落在这里（安装版在 %APPDATA%）
tools/                 随包分发：ffmpeg / yt-dlp / LibreSVIP（约 288 MB）—— **不入库**，见第三节
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

> ⚠️ **「往上找」这套逻辑对 macOS bundle 已经出问题了**（Windows 安装版/绿色版都已核实无碍
> —— `resource_dir()` 在 Windows 上就是 exe 目录），见第八节。

---

## 三、构建

| 事项 | 必须这样做 |
|---|---|
| 编译 | **只能** `powershell -ExecutionPolicy Bypass -File app\desktop\build.ps1` |
| | 直接 `cargo build` **不会**把 exe 复制到根目录，你跑的还是旧的，会以为改动没生效 |
| `-Release` / `-Bundle` | 可选参数；`-Bundle` 打 MSI（见第八节） |
| `-SkipWeb` | 只编后端（改 Rust 时省几秒，但 `app/web/` 里会是旧产物） |
| `-FetchTools` | 先补齐 `tools/` 与 JIZURA 字体（干净机器 / CI 上用；要联网） |
| `-NoCopy` | 编完**不**把 exe 复制到程序根目录（CI 用；本地别加，加了双击启动器跑的还是旧的） |
| 工具链 | Rust 在 `H:\DevTools\cargo`、MSVC 在 `H:\VSBuildTools`（build.ps1 会加载 vcvars） |
| | **前端还要 Node + npm**（见下）—— 这是新前端引入的**构建期**依赖 |
| 打包 | CI 在 `.github/workflows/build-msi.yml`（打**版本 tag** `v1.2.0` 自动出 MSI 并传 Release）。⚠️ 规则是 `v[0-9]*` —— 附件 Release 那个 `assets-v1` 故意不开头，免得建附件就触发一次构建 |
| 跨平台 | `-Bundle` 只在 Windows 可用（脚本会主动报错），macOS / Android 要另写壳，见第九节 |

### 仓库只放源码，两大块大件编译前补齐

**约 7 MB 的仓库**是有意为之。下面两块不属于源码，但程序要能离线用就必须在打包前到位：

| 大件 | 体积 | 补齐后落在 | 谁在用 |
|---|---|---|---|
| ffmpeg + yt-dlp + LibreSVIP CLI | 约 288 MB | `tools/` | `audio.rs` / `tools.rs` / `libresvip.rs` |
| JIZURA 与 2335 个 woff2 字体 | 约 54 MB | `app/web/vendor/jizura/` | 文字 PV 页的 iframe（**离线可用靠它**） |

一条命令补齐（幂等，齐了就跳过）：

```
powershell -ExecutionPolicy Bypass -File app\desktop\fetch-tools.ps1
powershell -ExecutionPolicy Bypass -File app\desktop\fetch-tools.ps1 -Local 'D:\存着两个zip的目录'   # 不联网
```

来源是本仓库 Release 的附件（tag **`assets-v1`**）—— `tools.zip`（129 MB）与
`jizura.zip`（51 MB），由 `tools\zip-assets.ps1` 打出来（那个脚本**只打包、不上传**）。
两处 URL：`fetch-tools.ps1` 的仓库地址是**自动从 `git remote get-url origin` 推**的
（HTTPS / SSH 两种写法都认，fork 出去不用改；没有远端时退回文件里那个备选值），
附件名（`tools.zip` / `jizura.zip`）与工作流里的 `ASSETS_TAG` 才是硬编码的 ——
**换 tag 或换托管时改这两处**；想临时换地址用 `$env:VSYNTH_TOOLS_URL` / `$env:VSYNTH_JIZURA_URL`。
`fetch-tools.ps1` 拿不到存档时会退到三个上游官方地址现下（gyan.dev / yt-dlp release /
LibreSVIP release）—— 慢，但不用人去别处找。

**这两个附件要仓库主人亲手传一次**（fork 的人不用传，直接用上游的）：

```
powershell -ExecutionPolicy Bypass -File tools\zip-assets.ps1     # ① 打出资料归档\tools.zip、jizura.zip
# ② 在网页上建一个 tag 为 assets-v1 的 Release（Releases → Draft a new release → Publish）
$env:GITHUB_TOKEN = '<只给这一个仓库 Contents 写权限的 token>'
powershell -ExecutionPolicy Bypass -File tools\upload-assets.ps1  # ③ 传到那个 Release（只传，不建 Release）
Remove-Item Env:\GITHUB_TOKEN
```

`upload-assets.ps1` 会先查远端拿 `owner/repo`、再查那个 tag 的 Release，然后流式上传
（**不用 `Invoke-WebRequest -InFile`**，PS 5.1 传二进制会坏），已存在的同名附件默认跳过、
`-Force` 才先删再传。token 只走环境变量，**不要写进命令行**（会留在 PSReadLine 历史里）。
⚠️ **附件那个 Release 的 tag 别用 `v` 开头**：工作流是 `on.push.tags: ['v[0-9]*']`，
用 `v…` 建它会顺手触发一次没用的构建 —— 现有默认值 `assets-v1` 正是为避开它。
传完再打版本 tag（`git tag v1.2.0 && git push origin v1.2.0`）就会自动出 MSI。

> ⚠️ 六条实测教训，别再踩：
> ① **判「齐不齐」必须核对解压后的具体文件**，不能只看目录在不在 —— 半途失败的解压
>    会留下看似完整的空壳，而那要到用户点「工程转换」才现形。
> ② 下载用 `curl.exe` + **自己写的重试循环**。`Invoke-WebRequest` 读 GitHub release
>    的大文件实测会 `Received an unexpected EOF or 0 bytes`；Windows 自带的旧 curl
>    不认 `--retry-all-errors`（报 unknown option）。
> ③ `-Bundle` 现在会**在编译前**核对 `tools\`、`vendor\jizura\`、`app\web\index.html`
>    在不在 —— `bundle.resources` 是「源目录缺文件就静默少打包」，缺了要到用户手里才现形。
> ④ **搬目录前先把父目录建出来**（脚本里的 `Move-Into` 就是干这个的）。`Move-Item`
>    不建中间目录，往 `app\web\vendor\jizura` 搬而 `vendor\` 不存在时报
>    `Could not find a part of the path.`，而且**目标没到位**（源倒是没了）。
>    同理：**给函数返回值的函数里，报进度要用 `Write-Host` 不能用 `Write-Output`** ——
>    后者会混进返回值，调用方拿到「提示 + 路径」拼起来的垃圾字符串。
> ⑤ **`tools\` 里同时住着入库的源码**（`zip-assets.ps1`、`fetch-jizura-fonts.ps1`）。
>    所以补齐只能**合并**进去，不能整目录替换 —— 而 `zip-assets.ps1` **不在存档里**
>    （它就是打存档的那个），替换必删它。规则是「同名目录才先删、其余交给
>    `Move-Item -Force` 原地覆盖」。
> ⑥ ⚠️ **`Move-Item` 的目标已存在时是「嵌套」不是「覆盖」**，连目录对目录也一样：
>    把 `_verify-hold-X\tools` 搬回已经存在的 `tools\`，得到的是 `tools\tools\`
>    （`-Force` 也拦不住）。还原临时区要**逐项搬内容**，别搬整个目录。
>    ⑤⑥ 都是 2026-10-02 那轮干净房间验证抓出来的，和 ④ 同源：
>    **别再靠肉眼审脚本** —— 这个测试脚本一共 6 次运行，抓出 4 个必然踩中的 bug，
>    其中两个只有在「tools\*.ps1 留在原地」的前提下才测得出来（见下）。

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

### 版本号写在哪儿（改版本号时五处一起改）

对外显示的是 `1.2beta` 这种写法，但 Cargo / npm / 打包器各自要的是合法 semver：

| 位置 | 现在写的 | 谁读它 |
|---|---|---|
| `app/desktop/src/server/simple.rs` 的 `APP_VERSION` | `1.2beta` | **界面**（总览页脚、「关于」小节的「程序版本」），`/api/health` 与 `/api/state` 都发它 |
| `app/desktop/Cargo.toml` 的 `version` | `1.2.0` | cargo（必须是合法 semver，`1.2.0-beta` 那种给人看太啰嗦） |
| `app/desktop/tauri.conf.json` 的 `version` | `1.2.0` | **MSI 的版本号**（不是 git tag） |
| `app/web-next/package.json` 的 `version` | `1.2.0` | npm（只在日志里出现，但别让它落后） |
| 两个锁文件 `Cargo.lock` / `package-lock.json` | `1.2.0` | 别手改，跑下面两条命令让它们自己跟上 |

```powershell
# 锁文件（两处都别手改）
cargo update -p v-synth-studio --precise 1.2.0                                  # 在 app\desktop 下
cd app\web-next; npm install --package-lock-only --no-audit --no-fund
```

⚠️ 只改 `APP_VERSION` 而不改 `tauri.conf.json`，装出来的 MSI 版本号会跟界面显示的对不上；
只改 `tauri.conf.json` 而不改 `APP_VERSION`，界面还显示旧版本 —— **两处都没有自动同步**。
（`AUTHOR_TAG` 同理，作者署名固定 `QingMu39`，改名史见第一节。）

### 界面只有一套（2026-10-02 切换完成）

| 启动方式 | 界面 |
|---|---|
| `启动工作站.bat` | React 前端（URL 前缀 `/`） |
| 直接双击 `v-synth-studio.exe` | **同一个** React 前端 |
| `v-synth-studio.exe --serve --port=<端口>` | 只起服务不开窗（给测试用；浏览器开 `http://127.0.0.1:<端口>/`） |

**`--ui=next|old` 与启动器的 `--old` 已经删除**，现在写它们不会有任何效果（参数被忽略）。
旧的手写前端（`app/web/js/`、`app/web/css/`、手写 `index.html`）已整体删除，
`docs/LEGACY-UI.md` 一并退役。

> 这一节以前叫「切换界面（旧前端 / 新前端）」，记着「启动器默认新前端、exe 默认旧前端」那套
> 双界面机制。**那套机制已经不存在了，别再照它推理。** 切换发生在 2026-10-02：
> 用户验收通过后，`main.rs` 里那段 `--ui=` 选择逻辑整体删掉，窗口固定加载根路径 `/`。
>
> **改前端不用重新编译**（`app/web/` 仍是每请求从磁盘读）：`npm run build` 或
> `npm run watch` + 刷新即可，只有改 Rust 才需要 `build.ps1`。

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
#   → ① npm run build（app\web-next → app\web）
#   → ② cargo build  + 复制 exe 到根目录
```

单独弄前端时：

```powershell
cd app\web-next
npm install     # 首次
npm run build   # tsc -b && vite build → 产物落 ../web/
npm run watch   # 开发时推荐：改完自动重建，浏览器刷新即可
```

`-SkipWeb` 只编后端（改 Rust 时省几秒，但 `app/web/` 会是上次的旧产物）。

⚠️ **npm 的选取有讲究**：`build.ps1` 优先用 `H:\node\npm.cmd`（自装 Node），
其次 `%ProgramFiles%\nodejs`，最后才退回 PATH 搜索。**不要改成直接取 PATH 里第一个** ——
本机 PATH 第一顺位是 DSH 运行时自带的 `...\resources\node\`，DSH 一升级就没了。
另外 `Get-Command npm.cmd` 在本机**命中 2 个**，直接取 `.Source` 会拿到数组并拼成垃圾字符串
（踩过，报错信息是 `The term '...npm.cmd H:\node\npm.cmd' is not recognized`）。

工具链（本机实测可用）：

| | 版本 | 说明 |
|---|---|---|
| Node | v24.20.0 | **只有开发机需要**，用户那边不用装（CI 用 `actions/setup-node` 装 24） |
| npm | 11.19.0 | |
| React / react-dom | 19.3 | |
| Vite | 8.3 | |
| TypeScript | **7.0** | ⚠️ TS 7 移除了 `baseUrl`，`paths` 改成相对 tsconfig 解析 |
| Tailwind | 4.3 | 用 `@tailwindcss/vite` 插件（v4 不需要 postcss/tailwind.config） |

---

## 四、前端（`app/web-next` → `app/web`）

**只有一套界面了。** 旧的手写前端（`app/web/js` + `app/web/css` + 手写 `index.html`）
已于 2026-10-02 整体删除，`docs/LEGACY-UI.md` 一并退役 —— 别再去 `app/web/js/` 找东西。

前端规范、页面约定、库组件清单、接口契约坑、验证工具与人工验收清单
**全在 `docs/FRONTEND.md`** —— 动前端之前读那份。
界面上的历史取舍与踩过的坑见 `docs/LESSONS.md`。

⚠️ **`app/web/` 里有两类东西，别搞混**：`index.html` 与 `assets/` 是 Vite 产物
（会被构建覆盖）；`vendor/`（JIZURA）与 `img/` 是**随包静态资源**，被产物引用但**不产出**。
所以 `vite.config.ts` 的 `emptyOutDir` **必须是 `false`** —— 设成 `true` 会把 vendor 和 img
一起清掉（PV 页与全部背景图失效），而构建还报成功。`build.ps1` 为此加了防线，
改动它之前先读那里的注释。

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
node tests\manual\next-smoke.mjs 8891

# 3) Rust 单测
cd app\desktop; cargo test --bins      # 应全绿
```

- 契约夹具在 `tests/contract/fixtures/`（17 个），是 Node 后端还在时抓的真实响应，
  **永久基准**。`verify.mjs` 逐字段 diff，并把「有意差异」列在 `INTENDED` 白名单里 ——
  **加条目要写清理由，它很容易变成掩盖问题的垃圾桶**。
- `next-smoke.mjs` 会断言每页的关键字（如总览要有「欢迎回来」「格式支持」）。
  **改页面文案会让它红**，改文案前先看它断言了什么。
- `--serve` 模式只跑服务不开窗口，专门给测试用。

### 浏览器验证的坑

| 坑 | 说明 |
|---|---|
| 无头模式 | 必须 `--headless=old`（本机 `--headless=new` 报 Multiple targets 起不来） |
| `--disable-gpu` | **只对截图有害**：带着它 `backdrop-filter` 会糊成一片空白。<br>`next-smoke.mjs` 里带了它没关系 —— 那条路只 dump DOM，不看画面对不对 |
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
> 玻璃相关的另外两份：`docs/GLASS-HANDOFF.md`（材质规范）、`docs/FRONTEND.md`（前端约定）。

| 症状 / 场景 | 结论 |
|---|---|
| `/api/fs/open` 收两种参数 | `path`（本地路径，**要求存在**）或 `url`（http/https/ftp/mailto，走系统默认程序、不做存在性检查）。**2026-10-02 之前它只读 `path`**，于是所有传 `{url}` 的调用必然 400 —— 两个前端的「在浏览器打开」都是坏的，已修（`platform::open_url` + `looks_like_url`，带单测） |
| 接口「发了没反应 / 永远空列表」 | **先对后端源码与夹具**，别信旧前端的调用姿势：`collect` 要 `{dirs:[…]}`（旧前端发 `{dir}` → 永远 0 个文件）、`preview` 要 `{inputs,toFormat}`、`fs/list` 空 `path` **必须整个省略**（发 `path=` → 400）、`fs/roots` 字段是 `name` 不是 `label`。四处都是搬页面时实测翻出来的，见 `docs/FRONTEND.md` 第 5 节 |
| 「改了界面但用户看不到变化」 | **先怀疑缓存**：静态文件必须发 Cache-Control: no-store（simple.rs 已加）。测试每次开全新浏览器，永远命中不了缓存，只有用户常驻的 WebView2 拿着旧文件 |
| 端口不能随机 | 固定 17878；**localStorage 按 origin 隔离**，端口一变 = 全新存储（JIZURA 标记、界面设置、PV 工程自动保存全丢） |
| 悬停/过渡「生硬地闪一下」 | 多半是 `var(--x)` **没定义** → 整条 `transition` 静默失效。先跑 `LESSONS.md` 里那段查未定义变量的脚本 |
| 过渡曲线 | `--ease` 管微交互、--ease-out 管入场、--spring 只给大位移；取值表在 `LESSONS.md`（它记的是旧前端那套，搬页面时逐个对照过） |
| 侧栏/导航 | **一个框 + 一个滑动高亮块**（库的 .lg-selection-lens），行本身零描边零底色；首帧不能滑、用 offsetTop 量位置（lib/useNavLens.ts）。⚠️ 高亮块**不是玻璃面**，库的 `--lg-lens-bg` 只按主题分档（亮色故意不透明）；要玻璃得自己在 `.nav-lens` 上改半透明 + 消费 `--lg-backdrop`。⚠️ 侧栏 `position: sticky` 的 `top` **必须等于初始位置**（含让开顶栏那 44px），否则一滚就先跳 44px —— 看着就是「侧栏跟着滚轮走」（细节在 `LESSONS.md`） |
| 玻璃 | 用现成的库，**永远别自己写**；材质写在 GlassProvider 上；背景自身模糊要小（3~5px）；栏本身不画底。三条教训的细节在 GLASS-HANDOFF.md §2.2 |
| 苹果式圆角 | corner-shape: squircle + @supports 兜底；**别用在玻璃面上**（库的位移贴图是受限几何） |
| 自定义 CSS 与工具类 | 新前端目前是纯手写 CSS（没用 Tailwind 工具类）。哪天开始用工具类，自定义类必须进 @layer components，否则会静默盖掉工具类 |
| 亮色主题 | 次要文字色不能太浅（对比度 4.5:1 以上）；背景图参数与新前端的取值见 LESSONS.md |
| 背景图「压根不显示」 | 触发过两次（旧前端一次、新前端一次）。图在 `app/web/img/bg/`，被 `index.css` 以 `url()` 引用 —— 别让构建把它当成产物清掉（`emptyOutDir` 必须是 `false`） |
| 网络 | GitHub / Google 要走代理（curl -x http://127.0.0.1:7890）；网易云、QQ 音乐直连；**测试短信接口绝不用真实手机号** |
| CI 上 `link.exe` 报 `/usr/bin/link: extra operand` | **Git for Windows 的 `C:\Program Files\Git\usr\bin` 在 runner 的系统 PATH 里，那个 `link.exe` 是 coreutils 的 `ln` 别名**，rustc 调裸名 `link.exe` 就撞上它。后面那句「build tools may need to be repaired」是**纯误导**。修法在 `build.ps1`：把 `\Git\{usr,mingw64,cmd}` 从 PATH 剔掉、再把 MSVC 的 `bin\Hostx64\x64`（用 `VCToolsInstallDir` 问出来）顶到最前，开跑前用 `where link.exe` 第一行验身份。**本地没有 Git 那套 `usr\bin`，永远复现不了** —— 要复现就自己造个假 `link.exe` 放进 `H:\tmp\faker\Git\usr\bin` 并 prepend 到 PATH |
| 批处理里 `%PATH%` 死活不生效 | **别把命令拼成 `cmd /c "a && b && c"` 长链**：cmd 把整条链**先解析、把 `%VAR%` 全展开**再逐条执行，所以链里 `set "PATH=...;%PATH%"` 拿到的是**启动 cmd 时的原始 PATH**，前面 `set`/`vcvars` 改的全白费（实测：剔掉 Git 段的 PATH 又被原样放回，rustc 还是拿到 Git 的 link）。**改成写临时 `.cmd` 逐行执行**（批处理逐行解析，`%PATH%` 才在运行时展开）。另：`set "RUSTFLAGS=-C linker="C:\...\link.exe""` 的引号会原样传给 rustc，报 `os error 123`，**别用这条路**，把链接器目录顶到 PATH 最前就够了 |
| `npm install` 在 CI 报 `Could not read package.json` | **`npm install` 只在当前目录找 `package.json`**（不像 vite/tsc 往上找）。`build.ps1` 开头 `Push-Location $here`（= `app\desktop`）后直接 install 就会去找 `app\desktop\package.json`；同块的 `npm run build` 有 `Push-Location $webSrc` 所以没事。**开发机永远暴露不了**（`node_modules` 早装好了，这句不跑）—— 改构建脚本后要按「干净 clone」的心智过一遍 |
| `cargo install tauri-cli` 装完却找不到 `tauri` | cargo 子命令的可执行文件叫 **`cargo-tauri.exe`**（带 `cargo-` 前缀），缓存 path 与存在性判断都按这个写；验证别猜文件名，直接 `cargo tauri --version` 真调一次 |
| 契约用例在 CI 上红，本地却全绿 | 夹具是**开发机上抓的冻结基准**，凡是记录「**这台机器上有什么**」而不是「**接口返回什么形状**」的用例，换台机器必然对不上。已登记两条：`video-parse-bili`（B 站对匿名/机房 IP 回 HTTP 412）、`fs-list-c`（`C:\` 根目录开发机 13 个、GitHub runner 37 个）。⚠️ 判「有意」的条件要**收得紧** —— 用 `onlyWhenLine` 把原始响应当证据（例如必须真出现 `HTTP 412`），否则这个清单会变成掩盖问题的垃圾桶 |
| 磁盘 | C 盘很紧，临时大文件放 H:\工作站\tmp-* 并即时删 |
| 图标 | `components/Icon.tsx` 是一张手写 SVG path 表。**没有图标库**（要离线），加图标往表里加 |
| 大文件不能进 git | `tools/`（288MB）与 `app/web/vendor/jizura/`（54MB）都已从 git 移出（`git rm --cached`），靠 `fetch-tools.ps1` 补齐。**别因为「本地看得见」就以为它们在库里** —— 别人 clone 下来是没有的 |
| Rust 注释里别写 `/*` | 块注释会**嵌套**：文档注释里写 `` `app/web/js/views/*.js` `` 会让整个注释永不闭合，吞掉后面几十行，rustc 报出**29 条假错**（`prefix 'wav' is unknown`、`unterminated double quote string`）。看到成片的这类错先找「注释没闭合」，别逐个去改字符串 |

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
| **打包 MSI** | ✅ **已真机装过并验证通过（2026-10-02）**：界面能开、设置改了重启还在、工程转换能跑、文字 PV 能开。安装布局与 `resolve_paths()` 对齐也已用 MSI 表核实 —— 见下 |
| UTAU Shift-JIS | 纯 Rust 侧不生成 Shift-JIS，默认写 UTF-8 |
| YouTube | 境内不可达，相关功能要走代理（设置页可配） |
| `mime_of` | 已补齐（2026-10-02）：`.jpg/.jpeg/.webp/.gif/.woff/.ttf/.mp3/.wav/.mp4/.txt/.map` 都有映射，两张背景图实测回 `image/jpeg` |
| `backdrop-filter` 降级 | 无该特性环境的降级方案没做视觉验证 |
| `audio.rs` 顶部注释 | 写着「ffmpeg 不随程序分发」，与事实相反（注释是旧的） |
| Rust 代码行数 | README 曾写「约 5,900 行 / 31 条路由」，**都是旧数字**，现为 39 条路由 |
| **工程转换** | 选项键已改用 LibreSVIP **官方选项名**，VSQX 参数曲线崩溃已**自动降级**（16 个真样本 15 通过，剩下 1 个是源工程自身音符重叠）。⚠️ `音高信息输入模式` 默认档是官方 `plain`（≈ 只带"已编辑"部分），要完整保留手画音高就在选项面板选「完整」。选项表与实现见 `docs/FEATURES.md` §3.1 |

### 打包：CI 出 MSI，真机装过、验证通过

**2026-10-02**：`build.ps1 -Release -Bundle` 与 CI 工作流都通了 ——
`.github/workflows/build-msi.yml` 打版本 tag（`v[0-9]*`）就自动出 MSI 并传 Release。
成品是 `V-Synth-Studio_1.2.0_x64_zh-CN.msi`（182.85 MB），在 Release `v1.2.0` 上，
**可以直接发给别人装**：
<https://github.com/QingMu39-Gao/V-Synth-Studio/releases/latest>

**而且已经在真机上装过一遍，用户反馈验证通过** —— 逐条结果见下。
安装后的目录布局另外用 MSI 表核实过，与 `resolve_paths()` 对得上（下面那条引文）。

程序靠 `main.rs::resolve_paths()` **往上找 `app/web/index.html`** 定位根目录，
它假定的是「绿色版」布局：

```
<根目录>/
  app/web/          ← 界面（Rust 内嵌服务从磁盘读，不是打包进 exe 的）
  app/data/         ← 配置、资源库、拼音词典
  tools/            ← ffmpeg 201 MB + LibreSVIP 70 MB + yt-dlp 17 MB
```

`tauri.conf.json` 现在有 4 条映射，**映射键写什么就落在哪（相对 INSTALLDIR）**：

```jsonc
"../../app/web"                 → "app/web"
"../../app/data/resources.json" → "app/data/resources.json"
"../../app/data/pinyin.json"    → "app/data/pinyin.json"
"../../tools"                   → "tools"
```

> ✅ **2026-10-02 用 MSI 表核实过了：装出来的就是上面那个布局，`resolve_paths()` 天然适配。**
> 把 Release `v1.2.0` 那个 `V-Synth-Studio_1.2.0_x64_zh-CN.msi` 的
> `Directory` / `Component` / `File` 三张表读出来（Windows Installer COM，**不用真安装**）：
>
> ```
> C:\Program Files\V-Synth-Studio\        ← INSTALLDIR；直属子目录只有 app\ 和 tools\
>   v-synth-studio.exe                    （component `Path`，目录就是 INSTALLDIR）
>   app\web\index.html                    ← 界面入口，resolve_paths 找的就是它
>   app\data\resources.json   app\data\pinyin.json
>   tools\ffmpeg\bin\ffmpeg.exe  tools\ffmpeg\bin\ffprobe.exe  tools\yt-dlp.exe
>   tools\libresvip\libresvip-cli\libresvip-cli.exe
> ```
>
> 两条关键事实：
>
> 1. **Tauri v2 不再加 `resources\` 前缀** —— 映射键写什么就落在哪。
>    （本节此前写「会**平铺**到 `<安装目录>/resources/` 下」是 **Tauri v1 的行为，错的**。）
> 2. **`resource_dir()` 在 Windows 上就是 exe 所在目录**
>    （`tauri-2.12.0/src/path/desktop.rs` 的文档注释：「**Windows:** Resolves to the directory
>    that contains the main executable.」，实现是 `current_exe()?.parent()`）。
>    所以 `resolve_paths()` 第 1 步 `has_web(<resource_dir>/app/web/index.html)` 直接命中，
>    `is_writable` 在 Program Files 下为假 → 正确判成**安装版**，可写目录落到
>    `%APPDATA%\com.qingmu.vocalworkstation`。
>
> ⚠️ 剩下唯一的设计取舍：**以管理员身份装完又用管理员运行**时，
> `is_writable(安装目录\app\data)` 会真返回 true → 被当成绿色版，配置写进安装目录。
>
> 读 MSI 表的姿势（踩过的坑都在这儿）：SQL 里列名要**反引号**；`LIKE '%x%'` 一律报
> `OpenView,Sql`，要过滤就整表取回再用 PowerShell `-match`（三张表分别 476 / 3733 / 3729 行）；
> `InvokeMember` 的返回值**每个都要 `$null =` 接住**，否则混进函数输出把 `@(...)`
> 撑成假的 1-2 个元素（`Directory=1` 这种假数量就是这么来的）。

**剩下的问题只在别的形态上：**

- Windows **安装版** → ✅ 已核实可用（`resource_dir()` = exe 目录，映射键落在 INSTALLDIR 下）
- Windows **绿色版** → `resource_dir()` 同样返回 exe 目录，也命中；靠 `is_writable` 区分两者
- **macOS `.app` bundle** → `Contents/Resources/` 布局，**这条仍然没修**
- `--serve` 等传 `None` 的调用点 → 靠「往上找」，开发机与 CI 都成立

**所以「换掉往上找」不再是 Windows 的待办**，它现在只为 macOS bundle 而做，
以及省掉构建脚本里「把 exe 复制到根目录」那一步（Windows 绿色版特有的形态，
macOS 上产物是 `.app`，没有这回事）。

`tools/` 约 288 MB（+ JIZURA 字体 54 MB），远超一般安装包的舒适区。原则已定：**随包分发**
（不让用户自己下），已按此接进 `bundle.resources`。剩下的只是「直接塞进 MSI」还是「首次运行释放」。

### 实机安装验证结果（2026-10-02，已通过）

用 Release `v1.2.0` 的 MSI 在真机上装了一遍，**用户反馈正常**。对照当初列的五条验收点：

| # | 要验的 | 结果 |
|---|---|---|
| 1 | 装完界面能打开（路径定位对不对） | ✅ 能开 |
| 2 | 改一个设置 → 重启 → 设置还在（可写目录落在 `%APPDATA%`） | ✅ 还在 —— 当初判「最容易挂」的那条，没挂 |
| 3 | 工程转换能跑（`tools/libresvip/` 找得到） | ✅ 能跑 |
| 4 | ffmpeg 能用（`tools/ffmpeg/` 找得到） | ⬜ 没单独对着验（用户是「大致点了一圈」，音频那条没逐项确认） |
| 5 | 打开文字 PV（`app/web/vendor/jizura/` 找得到） | ✅ 能开 |

**所以安装版这条路是通的。** 第 4 条只是没专门试，不是已知有问题 —— 它和工程转换走的是同一套
`resolve_paths()`，转换能跑基本说明 `tools/` 定位没问题。

> ⚠️ 万一哪天安装版一启动就挂，看 `%APPDATA%\com.qingmu.vocalworkstation\desktop-error.log`
> （安装版的可写目录在那儿，不在 `<安装目录>\data\`；`main.rs::error_log_hint()` 会把
> 真实路径打在错误提示里）。

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

### ⚠️ 2026-10-02 重写过一次历史（有大件被从历史里剔掉）

仓库从 **83 MB 缩到 6.7 MB**：`app/web/vendor/`（JIZURA 字体，2338 个文件 / 50.7 MB）、
`tests/manual/out/`（探针截图 78 个 / 23.7 MB）、`app/shell/`（旧 WebView2 dll）
这三条路径**从全部历史里删掉了**（它们本来就不在 HEAD 上）。

```powershell
# 当时的做法（--prune-empty 没删掉任何提交；工作树字节级不变，HEAD 树哈希前后一致）
git filter-branch --force --index-filter `
  "git rm -r --cached --ignore-unmatch app/web/vendor tests/manual/out app/shell" `
  --prune-empty --tag-name-filter cat -- --all
```

**三条要记住的：**

1. **所有提交 SHA 都变了**（当时的 `refs/tags/v1.2.0` 从 `48049c4` 变 `ca0ff84`，
   `assets-v1` 从 `341d234` 变 `9f03e02`）。文档或聊天里出现的旧 SHA 已经不存在，
   别再照它们 `git show`。三个 tag 都是 force push 上去的，**Release 靠 tag 名绑定、附件没丢**。
2. `git log --all -- app/web/vendor`（或 `tests/manual/out`、`app/shell`）**现在恒为空**——
   不是「没删过」，是历史里没有了，别再怀疑命令写错。
   `app/server`（Node 后端）、`app/web/js`（旧前端）这些小体积历史**故意留着**，仍可考古。
3. **`app/web/vendor/jizura/` 在磁盘上还在**（2338 个文件，靠 `fetch-tools.ps1` 补），
   只是不入库 —— 别因为「历史里搜不到」就以为它被误删了。

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
| 前端脚手架 | `app/web-next/`（React 19 + Vite 8 + TS 7 + Tailwind 4），产物落 `app/web/`，访问 `/` |
| 主题 + 透明度 | ⚠️ **原表写的 `lib/useTheme.ts` / `lib/usePerfMode.ts` 已不存在**（换库时删了）。现在主题与「降低透明度」是 `App.tsx` 里喂给库 `GlassProvider` 的两个 prop；`perfMode` 字段后端有、前端**还没接** |
| **玻璃材质修好**（2026-10-01） | 默认改成毛玻璃、侧栏改 `size="large"`、面板降到 `thin`、顶栏（后改为绝对定位）、侧栏高亮块改用库的透镜、补回 `corner-shape: squircle`。见 `docs/GLASS-HANDOFF.md` 第二节 |
| **顶栏只留品牌**（2026-10-01） | 右上角那组控件（材质分段控件 / 重新检测 / 状态文字）按要求移除；左上角换成真图标。材质切换改在设置页（今为「玻璃等级」滑块）、重新检测在总览页。顶栏**移出文档流**，内容列上移 76px；⚠️ 顶栏 `inset-inline` 必须写 `var(--lg-margin)` —— 绝对定位的包含块是**内边距盒**，写 0 会偏左 20px |
| **`glass-probe.mjs`** | 玻璃专项探针：计算值 + 截图 + 高亮块逐帧/首帧采样（`tests/manual/glass-probe.mjs`） |
| **`app/web-next` 入库** | 首次提交 `83320cd` —— 在此之前它一个 commit 都没有 |
| **启动加载画面 + 交接**（2026-10-02） | `index.html` 的 `#boot` + `lib/boot.ts`；遮罩淡出与界面入场**交叉**（时长必须拉开，见 `GLASS-HANDOFF` §4.1） |
| **玻璃等级 1~4 滑块** | 材质 / 透明度 / 面板要不要玻璃全由这一档派生（`lib/useGlass.ts`），键 `qingmu.glassLevel` |
| **设置页小节导航复用主侧栏那套** | `lib/useNavLens.ts` + `.app-nav` / `.nav-row` / `.nav-lens`，两处外框参数逐项相同 |
| **8 页全部搬到 React**（2026-10-02） | 旧 `views/*.js` → `pages/*.tsx`（约 7,200 行）；`lib/api.ts` 补齐 39 条路由；任务进度 / 目录选择 / 表单共用件在 `components/`。迁移中翻出并修掉旧前端 4 处接口契约错误（见 `docs/FRONTEND.md` 第 5 节） |
| **`next-smoke.mjs`** | 8 页逐页冒烟：控制台报错 / 占位页 / 玻璃面 / 该页文案，8/8 全绿（文件名里的 `next-` 是历史遗留） |

### 🔜 下一个功能：歌词页做成「网易云专区」（用户 2026-10-02 定，还没开工）

用户原话：「我打算 把歌词页面做成网易云专区 让用户可以搜索歌曲后直链下载歌曲
甚至是歌曲封面（记得把填写QQ音乐cookie的功能删掉）」

拆成四件事：

1. **歌词页以网易云为主** —— 现在页面上有「来源」分段（网易云 / QQ 音乐），要改成一个网易云专区。
2. **搜索后能直链下载歌曲**（音频文件本身）—— ⚠️ **这是新链路，后端现在完全没有**：
   `lyrics.rs` 只取歌词与封面，没有任何「下音频」的代码。
3. **也能下封面** —— 后端**已经有了**：`lyrics.rs::download_cover(cfg, url, dest) -> Result<u64, String>`（552 行），
   路由 `/api/lyrics/cover` 也在（`server/mod.rs:145-154`）。缺的只是页面上的入口与「存到哪」。
4. **删掉「填写 QQ 音乐 cookie」的功能** —— 前端 `Lyrics.tsx` 的来源分段（45 行的 `{ value: 'qq', label: 'QQ 音乐' }`）、
   `isQq`（399）、`loginKey`（400）、`saveCookie('qqCookie', …)`（486）、QQ Cookie 输入框与保存/清除按钮（768-784）
   都要去掉；后端 `lyrics.rs::normalize_source()`（212）里的 `"qq"` 分支、`cookie_of()`（79-88）的 qq 分支一并处理。
   ⚠️ **`server/simple.rs:89-90` 的 `qqCookie` 字段先别急着从默认 config 里删** ——
   老用户的 `config.json` 里可能已经有它，删之前要确认读配置不会因此报错（`config_post` 是合并式的，
   多余键按说无害，但要实测，别推断）。

**动手前先读：**

- `docs/FEATURES.md` §3.4 歌词（290-322 行）—— 这一节是这块的权威描述，**改完必须同步改它**。
  尤其「关键约束」那几条：扫码登录不做（网易云始终回 `8821`）、
  **测试时绝不要调 `lyricsSms`（真会发短信）**、封面 `url` 必须 http 开头且下载**不带 Cookie**。
- `docs/FRONTEND.md` §3「新增/修改页面的标准动作」（145 行）。

⚠️ **别照猜写。** 下音频要先摸清网易云那边怎么拿直链 —— 歌词接口的回包里带没带、
要不要 `MUSIC_U` cookie、会不会也撞反爬，都得先用 `curl.exe` 直连实测
（网易云不用走代理；见第六节「网络」那行）。

#### QQ 音乐的全部落点（2026-10-02 grep 实测，删的时候照这张表过一遍）

后端 `app/desktop/src/`：

| 文件:行 | 内容 |
|---|---|
| `lyrics.rs:1` | 模块文档注释「网易云 / QQ 音乐的搜索、歌词抓取…」 |
| `lyrics.rs:31` | 注释 + `const QQ_UA`（QQ 搜索接口认的手机 UA，桌面 UA 会被要求签名） |
| `lyrics.rs:80-81` | `cookie_of()` 的 `if source == "qq" { return str_at(cfg, "qqCookie") }` |
| `lyrics.rs:215` | `normalize_source()` 的 `"qq" => Ok("qq")` |
| `lyrics.rs:226` / `313` | `search()` / `fetch()` 里的 `if source == "qq"` 分支（各一整段实现） |
| `lyrics.rs:371` | 错误文案「QQ 音乐接口返回错误码 {retcode}…」 |
| `lyrics.rs:396` | 回包里的 `"source": "qq"` |
| `lyrics.rs:479` / `486` / `502` | `parse_link()` 三段判定 QQ 链接（**顺序不能调**，见 FEATURES §3.4） |
| `lyrics.rs:505` | 兜底错误文案「…或 QQ 音乐的 songDetail 链接 / songmid」 |
| `lyrics.rs:833` / `843` | `parse_lrc` 里 `source == "qq"` 的 `[offset:0]` / `[kana:` 处理 |
| `lyrics.rs:1243` | 单测 `parse_lrc(raw, "qq")` |
| `lyrics.rs:1290` | 单测 `cookie_of(&json!({"qqCookie":"abc"}), "qq")` |
| `lyrics.rs:1445` / `1450` / `1458` | `parse_link` 的三个 qq 单测 |
| `server/lyrics.rs:260` | `let key = if source == "qq" { "qqCookie" } else { "neteaseCookie" }` |
| `server/simple.rs:88-90` | 默认 config 的 `"qqCookie": ""`（**字段先别删**，见上） |

前端 `app/web-next/src/`：

| 文件:行 | 内容 |
|---|---|
| `App.tsx:68` | 侧栏副标题「网易云 / QQ 音乐搜词，导出 LRC · SRT」 |
| `lib/api.ts:152` / `402` / `423` | 注释、`type LyricsSource = 'netease' \| 'qq'`、返回类型注释 |
| `pages/Lyrics.tsx:13` / `26` | 文件头注释（**本来就已过期**，见 FEATURES §3.4） |
| `pages/Lyrics.tsx:45` | 来源分段 `{ value: 'qq', label: 'QQ 音乐' }` |
| `pages/Lyrics.tsx:190` | `const [qqCookie, setQqCookie] = useState('')` |
| `pages/Lyrics.tsx:239` / `258` | `api.lyricsSearch` / `lyricsGet` 的 `'netease' \| 'qq'` 断言 |
| `pages/Lyrics.tsx:285` | toast「已识别为 QQ 音乐 / 网易云」 |
| `pages/Lyrics.tsx:399-402` | `isQq` / `loginKey` / `sourceLabel` |
| `pages/Lyrics.tsx:467` | `api.lyricsLogout(source as 'netease' \| 'qq')` |
| `pages/Lyrics.tsx:486` | `saveCookie(key: 'neteaseCookie' \| 'qqCookie', …)` |
| `pages/Lyrics.tsx:517-518` / `542` | 状态文案、以及「QQ 音乐走的是手机端搜索接口…」那段提示 |
| `pages/Lyrics.tsx:597` | 粘贴框 hint「…以及 QQ 音乐的 songDetail 链接 / songmid」 |
| `pages/Lyrics.tsx:768-784` | QQ Cookie 的 `Field` + 保存 / 清除两个 `Button` |

文档：`README.md:142`（歌词那条功能描述）、`docs/FEATURES.md:292`（§3.4 界面描述）、
`docs/FEATURES.md:412`（`default_config()` 键表里的 `qqCookie`）、
`docs/FEATURES.md:562`（§6 未核实项里的「QQ 音乐手机 UA 搜索」）、
`AGENTS.md:448`（第六节「网络」行的「网易云、QQ 音乐直连」）。
另有 `app/data/config.json:10` 的 `"qqCookie": ""`（**开发机上的实际配置文件**，不是源码）。

⚠️ `lyrics.rs` 里 qq 相关的单测有三个在 `parse_link` 上 —— **删功能时这些测试要一起删或改**，
不然 `cargo test --bins` 会红。

---

### 待办，按优先级

1. **`resolve_paths()` 改用 `resource_dir()`** —— ⚠️ **优先级已下调**：Windows 安装版与绿色版
   都已核实没问题（见第八节），现在这条只为 **macOS bundle**（`Contents/Resources/` 布局）
   和「省掉构建脚本复制 exe 那步」而做。跟前端选型无关。
2. **把剩下几处手写控件换成库的**：`Button`（已是 `GlassButton`）和 `List`/`Dialog`/`Slider`/
   `Progress`/`Badge`/`Switch` 都在用了，但 `Field.tsx` 的输入框、页面里的 `.seg` / `.input`
   还是手写的（只有材质走库）。库有对应的 `TextField`（`multiline`）/ `Picker` / `RadioGroup` /
   `GlassSegmentedControl`（胶囊、可拖、拖动中实时更新选择）。**换的时候注意**：
   库的分段控件是 `<label class="lg-segment"><input type=radio>`，`aria-label` 挂在内层
   `.lg-segmented-track` 上 —— 写自动化测试时别在外层 `.lg-segmented` 上取 `aria-label`（会拿到 null）。
3. **给前端补点击穿透测试** —— `next-smoke.mjs` 只验「渲染 + 文案 + 控制台」，
   真实操作链路（选文件 → 预检 → 提交任务）还没有自动化，目前靠人工 + 探针截图。
4. **侧栏形态要不要换成库的 `TabBar`？** 它自带透镜、拖拽换页、窄屏自动变底部胶囊栏，
   但它的侧栏形态是 `position: fixed` 的整列贴窗口左边，而且**没有分组标题**
   （现在的「工作台 / 素材获取 / 系统」是手写的）。两条路都成立，**属于要用户拍板的结构选择**。
5. **CI**：已经落地 —— `.github/workflows/build-msi.yml`（Windows 单平台出 MSI + 冒烟）。
   以后再谈 matrix：macOS 那一格要等第九节说的构建壳，Linux 编不出 Windows / macOS 的 GUI 包。

### 关于 Android（已核实，不用再查）

| 依赖 | Android 出路 | 状态 |
|---|---|---|
| ffmpeg | [ffmpeg-kit-maintained](https://github.com/ffmpegkit-maintained/ffmpeg-kit)（FFmpegKit 退役后的社区续作，改 group ID 即迁移） | 可用 |
| yt-dlp | [yt-dlp-android](https://github.com/ffmpegkit-maintained/yt-dlp-android)（Chaquopy 内嵌 CPython 3.13，进程内跑纯 Python） | 可用；AAR 60–80 MB |
| LibreSVIP | 未验证 | **不构成风险** —— 用户已明确「工程转换实现方式有很多」 |

关键约束：Android 应用数据目录是 noexec，**跑不了外部二进制**，必须走 JNI 从 `.so` 加载。
所以媒体层最终要桌面走 `Command`、移动走 JNI。**现在不用做** —— 调用链的 `tools_dir`
形参已经一路穿好了，将来是机械替换而非重写。

**上 Vite 时的四条硬约束**（当时想清楚、2026-10-02 全部已落地）：

- Vite 的 `outDir` 指向 `app/web/`、`base: '/'`，**服务端一行不用改** ——
  因为窗口加载的是 `http://127.0.0.1:<port>`，静态文件是每请求从磁盘读的。
- `emptyOutDir` **必须是 `false`**（`app/web/` 里躺着 `vendor/` 与 `img/` 两类非产物），
  设成 `true` 会把它们一起清掉而构建照样报成功 —— `build.ps1` 为此加了防线。
- ⚠️ **前端里所有 API 调用必须用绝对路径 `/api/...`**。相对路径 `./api/state` 在子路径下
  会变成 `/app/api/state` → 404。见 `lib/api.ts` 的注释。
- `build.ps1` 仍是唯一构建入口（它第一步就是 `npm run build`），
  代价是**编译机必须有 Node**（用户那边仍然不用装）；开发时改前端要 `npm run watch`。
