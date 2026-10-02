# V-Synth-Studio

翻调 P 主的本地工作台。**完全离线运行，工程文件不出本机。**

> 原名「清沐的虚拟歌姬工作站」，2026-09 更名为 V-Synth-Studio。
>
> **要改代码？读 [`AGENTS.md`](AGENTS.md)。**
> 那份写的是看代码看不出来的东西：架构为什么长这样、踩过哪些坑、怎么编译怎么验证。
> 这份 README 只讲这是什么、怎么用。

---

## 下载安装（普通用户）

不用编译，直接下安装包：

**<https://github.com/QingMu39-Gao/V-Synth-Studio/releases/latest>**

下载 `V-Synth-Studio_1.2.0_x64_zh-CN.msi` 双击安装即可。安装包**自带 ffmpeg、yt-dlp、
LibreSVIP 与 JIZURA 字体**（约 183 MB），装完不联网也能用。唯一的前置条件是 WebView2
运行时（Win11 和较新的 Win10 都预装，没有的话安装程序会提示）。

> 下面那节是给**要改代码**的人看的。

---

## 快速开始（从源码编译）

```
app\desktop\build.ps1     ← 编译（首次约 13 分钟，之后增量几秒）
启动工作站.bat             ← 双击运行
```

`build.ps1` 编完会**自动把 exe 复制到程序根目录**，所以双击启动器跑的就是刚编出来的版本。

> ⚠️ **不要直接用 `cargo build`** —— 它只编译，**不复制**。根目录那个 exe 会悄悄停在旧版本。
> 详见 `AGENTS.md`。

| 命令 | 用途 |
|---|---|
| `build.ps1` | debug 版（默认，编得快，带控制台窗口方便看日志） |
| `build.ps1 -Release` | release 版（体积小、跑得快，无控制台窗口） |
| `build.ps1 -Bundle` | 出 Windows 安装包（MSI），要 `-Release` 一起用 |
| `build.ps1 -FetchTools` | 先把 `tools/` 与 JIZURA 字体补齐（干净机器 / CI 上用） |
| `build.ps1 -NoCopy` | 编完**不**往根目录复制 exe（CI 用，省得去动仓库根） |
| `build.ps1 -SkipWeb` | 只编后端，跳过前端（`app/web/` 会是上次的旧产物） |

打 tag 推上去（`git tag v1.2.0 && git push origin v1.2.0`）会由
`.github/workflows/build-msi.yml` 在 GitHub Actions 上自动编译、打包、传 Release。
（MSI 里的版本号取自 `app/desktop/tauri.conf.json` 的 `version`，不是 tag 名 ——
改版本号要动的地方见 `AGENTS.md` 的「版本号写在哪儿」。）

---

## 运行要求

**用户只需要 WebView2 运行时**（Win11 和较新的 Win10 都预装）。

| 依赖 | 用户需要吗 | 依据 |
|---|---|---|
| VC++ 运行库 | **不需要** | 已静态链接，导入表里没有 `VCRUNTIME140.dll` |
| Node.js | **不需要** | 见下方说明 |
| Python | **不需要** | LibreSVIP 自带运行时 |
| WebView2 | **需要** | 唯一的硬依赖 |

外部工具（ffmpeg / LibreSVIP / yt-dlp，共约 288 MB）**随包分发**在 `tools/` 里，
不需要联网下载 —— 主要在国内用，让用户自己去 GitHub 下 ffmpeg 基本下不动。
JIZURA 与它的 2335 个字体（约 54 MB）同理，在 `app/web/vendor/jizura/`。

> **这两块大件不在仓库里**（仓库只放源码，约 7 MB）。编译前补一次即可：
>
> ```
> powershell -ExecutionPolicy Bypass -File app\desktop\fetch-tools.ps1
> ```
>
> 它们从本仓库 Release 的 `assets-v1` 附件解出来（`tools.zip` + `jizura.zip`），
> 也可以加 `-Local <目录>` 用本机存着的 zip。仓库地址是从 `git remote origin` 推出来的，
> 所以 fork 出去也能直接用。见 `AGENTS.md` 的「打包与 CI」。
>
> **这两个附件要仓库主人传一次**（fork 的人不用管，直接用上游的）：
>
> ```
> powershell -ExecutionPolicy Bypass -File tools\zip-assets.ps1        # 打出两个 zip
> # 在网页上建一个 tag 为 assets-v1 的 Release，然后：
> $env:GITHUB_TOKEN = '<只给这一个仓库 Contents 写权限的 token>'
> powershell -ExecutionPolicy Bypass -File tools\upload-assets.ps1     # 传到那个 Release
> Remove-Item Env:\GITHUB_TOKEN
> ```
>
> 传完再打版本 tag（`git tag v1.2.0 && git push origin v1.2.0`）就会自动出 MSI。

### Node.js 到底在哪一步出现

界面用 React 写，构建要过 Vite，**Vite 是 Node 工具**。所以：

| 环节 | 需要 Node 吗 |
|---|---|
| 用户双击启动器运行 | **不需要** —— 打包出去的是静态 HTML/JS/CSS，exe 是 Rust |
| 后端运行时 | **不需要** —— 53 条路由全在 Rust 里，`node.exe` 进程数为 0 |
| **编译前端**（`build.ps1` 第一步） | **需要** |

也就是说 Node 只在**开发者编译时**跑一次，不随包分发、不驻留、不产生子进程。
`app/web-next/node_modules/` 有 90 多 MB，但它**不进安装包**——
`tauri.conf.json` 的 `resources` 只映射 `app/web`，而 Vite 产物里不含依赖。

> **历史说明**：这个项目早期的后端是 Node（约 19,000 行），后来整体重写成 Rust，
> 目的是消掉"两个进程要同步生死"的架构问题。**那些好处一条没丢**——
> 去掉的是*运行时*的 Node，不是*构建时*的。

---

## 功能

### 工程格式互转（离线）

转换引擎是 **LibreSVIP CLI**（`tools/libresvip/`），支持 **40 种格式**：

| 类别 | 格式 |
|---|---|
| VOCALOID | `.vsqx` `.vsq` `.vpr` `.vog` `.vspx` |
| Synthesizer V | `.svp` `.s5p` |
| UTAU / OpenUtau | `.ust` `.ustx` |
| CeVIO / ACE / DeepVocal | `.ccs` `.acep` `.dv` `.dspx` |
| 通用交换 | `.mid` `.musicxml` `.ufdata` |
| 歌词字幕 | `.lrc` `.ass` `.srt` `.svg` |

**读取工程**借道 LibreSVIP 导出的 `ufdata`（一种 JSON 中间格式）—— 这样任何它支持的格式
都能读，我们只解析一种结构，不需要为每个格式写 reader。

### 视频解析与下载

B 站原生解析（WBI 签名、DASH 流、番剧）+ yt-dlp 兜底（YouTube 等上千站点）。
可选下载封面、弹幕、字幕，多线程分块下载带 SHA-256 校验。

### 音频处理

基于 ffmpeg：格式转换（WAV/FLAC/MP3/M4A/OGG/Opus）、变调变速、裁剪、响度归一化、音频提取。
带波形编辑器。

### 歌词

网易云搜索与取词、双语、封面、本地 `.lrc` 导入（含 GBK 自动识别），导出 LRC / SRT；
顺带能把这首歌的封面和音频（mp3 直链）一起下载下来 —— 搜索结果里会标出哪些版本能下，
碰上要会员的版本可以直接换一条再点。

### 文字 PV

JIZURA 本地部署，歌词一键带入，导出 MP4 / PNG 序列。字体已离线化。

### 资源导航

4 组 27 条：工程分享、免费音源、编辑器/声库官网、UTAU 系开源项目。

**关于「破解版 / 学习版」**：本库**不收录**任何破解、激活器、网盘转载的盗版声库或编辑器链接。
原因不是保守，而是这类资源在原理上无法验证安全性 —— 无数字签名、二次打包、常捆绑启动器，
是木马和挖矿程序的高发区。只收录官方、开源与免费试用渠道。

### 双主题

亮 / 暗，跟随系统，可切换。

---

## 自己构建

编译需要 MSVC 工具链（`H:\DevTools\安装VC工具链.bat` 装一次即可）。
直接用 `cargo build` 会报 `linker link.exe not found` —— 必须先加载 vcvars，
`build.ps1` 会处理。

完整流程、平台差异与打包现状见 **[`AGENTS.md`](AGENTS.md)**。

---

## 分发与授权

随包分发了几个独立的外部程序（FFmpeg / LibreSVIP / yt-dlp / JIZURA / 字体），
各自的许可与合规要求见 **[`docs/THIRD-PARTY-NOTICES.md`](docs/THIRD-PARTY-NOTICES.md)**。

> ⚠️ 当前 `tools/ffmpeg/` 是 **GPL v3** 构建。分发前请先读那份文档 ——
> 换成 LGPL 构建可以省掉大部分合规负担，而且不影响本程序的功能。

---

## 目录说明

| 路径 | 说明 |
|---|---|
| `app/desktop/` | Tauri 外壳 + 内嵌 Rust 后端（构建脚本 `build.ps1` / `fetch-tools.ps1` 也在这里） |
| `app/web/` | 前端构建产物（React + Vite：`index.html` + `assets/`）；`vendor/`（JIZURA）与 `img/` 是不入仓库的随包资源 |
| `app/data/` | 配置、资源库、拼音词典 |
| `app/web-next/` | 前端源码（React + Vite + Tailwind） |
| `tools/` | 随包分发的 ffmpeg / LibreSVIP / yt-dlp；`zip-assets.ps1` 打 Release 用的存档 |
| `tests/` | 契约测试、冒烟测试、样本 |
| `.github/workflows/` | CI：编译 + 打 MSI + 冒烟 |
| `资料归档/` | 上传 Release 用的两个大存档（**不入库**） |
| `AGENTS.md` | **给开发者/智能体的技术文档** |
