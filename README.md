# 清沐的虚拟歌姬工作站

翻调 P 主的本地工作台。**完全离线运行，工程文件不出本机。**

> **要改代码？读 [`AGENTS.md`](AGENTS.md)。**
> 那份写的是看代码看不出来的东西：架构为什么长这样、踩过哪些坑、怎么编译怎么验证。
> 这份 README 只讲这是什么、怎么用。

---

## 快速开始

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
| `build.ps1 -Bundle` | 出安装包 —— **见 `AGENTS.md`，现在还不能直接打** |

---

## 运行要求

**用户只需要 WebView2 运行时**（Win11 和较新的 Win10 都预装）。

| 依赖 | 用户需要吗 | 依据 |
|---|---|---|
| VC++ 运行库 | **不需要** | 已静态链接，导入表里没有 `VCRUNTIME140.dll` |
| Node.js | **不需要** | 后端是 Rust（只有跑测试的开发机需要） |
| Python | **不需要** | LibreSVIP 自带运行时 |
| WebView2 | **需要** | 唯一的硬依赖 |

外部工具（ffmpeg / LibreSVIP / yt-dlp，共约 390 MB）**随包分发**在 `tools/` 里，
不需要联网下载 —— 主要在国内用，让用户自己去 GitHub 下 ffmpeg 基本下不动。

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

网易云 / QQ 音乐搜索与取词、双语、封面、本地 `.lrc` 导入（含 GBK 自动识别），导出 LRC / SRT。

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
| `app/desktop/` | Tauri 外壳 + 内嵌 Rust 后端 |
| `app/web/` | 界面（纯 HTML/CSS/JS） |
| `app/data/` | 配置、资源库、拼音词典 |
| `tools/` | 随包分发的 ffmpeg / LibreSVIP / yt-dlp |
| `tests/` | 契约测试、冒烟测试、样本 |
| `AGENTS.md` | **给开发者/智能体的技术文档** |
