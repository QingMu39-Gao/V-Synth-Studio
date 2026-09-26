# 清沐的虚拟歌姬工作站

翻调 P 主的本地工作台。**完全离线运行，单进程，不需要 Node.js。**

---

## 快速开始

```
app\desktop\build.ps1     ← 编译（首次约 13 分钟，之后增量几秒）
启动工作站.bat             ← 双击运行
```

`build.ps1` 编完会**自动把 exe 复制到程序根目录**，所以双击启动器跑的就是刚编出来的版本。

| 命令 | 用途 |
|---|---|
| `build.ps1` | debug 版（默认，编得快，带控制台窗口方便看日志） |
| `build.ps1 -Release` | release 版（体积小、跑得快，无控制台窗口） |
| `build.ps1 -Bundle` | 出安装包 —— **见 `docs/PACKAGING.md`，现在还不能直接打** |

编译需要 MSVC 工具链（`H:\DevTools\安装VC工具链.bat` 装一次即可）。
直接用 `cargo build` 会报 `linker link.exe not found` —— 必须先加载 vcvars。

---

## 运行要求

**只需要 WebView2 运行时**（Win11 和较新的 Win10 都预装）。

| 依赖 | 需要吗 | 依据 |
|---|---|---|
| VC++ 运行库 | **不需要** | 已静态链接，导入表里没有 `VCRUNTIME140.dll` |
| Node.js | **不需要** | 后端是 Rust |
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
|  Synthesizer V | `.svp` `.s5p` |
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

### 资源导航

各类网站跳转与整理：人声分离、免费音源（标注**能否下 WAV**）、歌姬立绘与授权规约、
编辑器官方获取渠道、插件与工具、教程文档。

**关于「破解版 / 学习版」**：本库**不收录**任何破解、激活器、网盘转载的盗版声库或编辑器链接。
原因不是保守，而是这类资源在原理上无法验证安全性 —— 无数字签名、二次打包、常捆绑启动器，
是木马和挖矿程序的高发区。只收录官方、开源与免费试用渠道。

---

## 架构

```
清沐的虚拟歌姬工作站.exe      ← Tauri 外壳 + 内嵌 Rust 后端（同一个进程）
app/web/                     ← 界面（纯 HTML/CSS/JS，无构建步骤）
app/data/                    ← 配置、资源库、拼音词典
app/desktop/                 ← Rust 源码
tools/                       ← ffmpeg / LibreSVIP / yt-dlp
```

**窗口和 HTTP 服务跑在同一个进程里** —— 没有 node.exe，也没有 sidecar 子进程。
关掉窗口就是完全退出，不存在"外壳死了后端还在跑"的孤儿状态。

Rust 后端约 5,900 行，实现 31 个 HTTP 路由；前端零构建步骤。

### 为什么是 Rust 而不是 Node

原来用 Node 后端（约 19,000 行）+ Tauri 外壳拉子进程的方式。改成 Rust 之后：

| | 旧（sidecar） | 现在 |
|---|---|---|
| 进程数 | 9 | 8（其中 6 个是 WebView2） |
| 内存 | 494 MB | 472 MB |
| node.exe | 1 个 | **0 个** |
| 崩溃残留 | Node 会变孤儿 | 无 |

省下的几十 MB 不是重点，**重点是架构上不再有"两个进程要同步生死"这件事**。

### 刻意不做的事

- **不做音频渲染** —— 这是工程数据转换工具，不合成歌声。要出声音得用对应编辑器。
- **不检测本机声库**（曾经做过，784 行，已删）—— 它只被用来"显示装了什么"，
  **转换路径从头到尾没调用过**。换声库跟这个检测毫无关系。
- **不检测本机编辑器**（曾经 16 个，现在只留 UVR）—— 只有 UVR 被真正用到
  （音频页的人声分离要跳过去）。其余只是"从工作站启动别的编辑器"，
  而用户桌面本来就有快捷方式，绕这一层没意义，还带来 56 条要跟着版本维护的路径。

---

## 测试

```powershell
# 对照测试：把 Rust 后端的响应和从 Node 版抓的真实夹具逐字段比
$exe='app\desktop\target\debug\qingmu-workstation.exe'
Start-Process $exe -ArgumentList '--serve','--port=8891'
node tests\contract\verify.mjs 8891
```

夹具在 `tests/contract/fixtures/`（17 个），是 Node 后端还在时抓的真实响应，
**永久基准**。`verify.mjs` 逐字段 diff，并把「有意差异」单独标注（每条都写了理由）。

当前：**17/17 一致**。

`--serve` 模式只跑服务不开窗口，专门给测试用。

---

## 已知限制

- **打包还没做** —— MSI 打出来跑不起来，原因是 Tauri 的 `resources` 目录布局和
  程序的 `find_app_root()` 对不上。详见 `docs/PACKAGING.md`。
- **UTAU Shift-JIS** —— 纯 Rust 侧不生成 Shift-JIS，默认写 UTF-8。老版本 UTAU
  可能需要手动转码。
- **YouTube 在境内不可达** —— 相关功能要走代理（设置页可配）。

---

## 目录说明

| 路径 | 说明 |
|---|---|
| `docs/PACKAGING.md` | 打包前置条件与运行时依赖实测 |
| `docs/PLATFORM-PORT.md` | 移植 macOS 的平台边界地图 |
| `docs/THIRD-PARTY-NOTICES.md` | 第三方组件的授权说明 |
| `tests/contract/` | 契约对照测试与基准夹具 |
| `tests/manual/` | 手工验证脚本 |
| `tests/samples/` | 样本工程（**用户的真实作品不入库**，见其 README） |
