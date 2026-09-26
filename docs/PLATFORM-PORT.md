# 平台移植地图（macOS）

> **2026-09 重要更新**：后端已从 Node 重写为 **Rust**（`app/desktop/src/`，约 3,100 行，
> 替代原来的 `app/server/` 19,019 行）。下面第一节的 Node 清单只对**尚未删除的 Node 后端**
> 有效；新的平台边界在第二节。Node 后端在全部路由验证通过前保留作对照。

---

## 一、现状（Rust 后端）

后端现在是 Tauri 应用**进程内**的一部分，没有 node.exe。平台相关代码**全部集中在 `app/desktop/src/platform.rs`**：

| 功能 | 现在的实现 | macOS 需要 |
|---|---|---|
| 下载目录 | 读注册表 `User Shell Folders`，退回 `USERPROFILE\Downloads` | `$HOME/Downloads`（更简单，删掉注册表那段即可） |
| 文件管理器定位 | `explorer /select,` | `open -R`（代码里已经写了 cfg 分支） |
| 打开文件 | `explorer` | `open`（同上，已分支） |
| 回收站 | PowerShell `Shell.Application` | `trash` 命令或 `NSFileManager` |
| 平台名 | `node_platform_name()` 返回 `win32`/`darwin` | 已按 Node 命名返回 `darwin`，不用改 |
| 路径规范化 | 剥 `\\?\` 前缀 | `clean_path()` 里的 `#[cfg(windows)]` 块自然跳过 |

**编译器探测**（`src/tools.rs`）里的 16 个编辑器路径表是 Windows 专有的。macOS 上那张表要整体换成 `/Applications/*.app` 的扫描 —— 但那是**数据**，不是逻辑。

**声库探测**（`src/voices.rs`）里读注册表的部分用 `#[cfg(windows)]` 隔离，非 Windows 返回空数组（macOS 上确实没有 VOCALOID）。

**外部工具**（ffmpeg / yt-dlp）走 `find_binary()` + PATH，基础逻辑跨平台；只有"一键获取"的下载源是各平台一份（`app/server/core/audio.mjs` 里的 URL 表 —— 那部分还在 Node 侧，尚未移植到 Rust）。

## 二、还没移植的部分

`app/server/` 里这些**仍在使用**（阶段 4 之前），移植时要一并处理：

| 文件 | 处数 | 内容 |
|---|---|---|
| `core/tools.mjs` | 56 | 编辑器路径表（已在 Rust 侧重写，Node 侧是旧的） |
| `core/voices.mjs` | 21 | 注册表声库探测（已在 Rust 侧重写） |
| `core/audio.mjs` | 11 | ffmpeg 路径与一键安装（**待移植**） |
| `core/formats/ust.mjs` | 4 | Shift-JIS 转码走 PowerShell（**待移植**，macOS 换 `iconv`） |
| `net/ytdlp.mjs` | 3 | `yt-dlp.exe` 下载源（**待移植**） |
| `core/paths.mjs` | 3 | 已由 `platform.rs` 取代 |

---

## 三、历史：Node 后端时代的清单（已过时，保留作参考）

以下内容是重写前对 `app/server/` 的审计，**只对那个已不再默认启用的 Node 后端有效**。

### 结论

**核心是跨平台的，外壳曾经不是（现在换成 Tauri 了）。**

| 部分 | 跨平台状况 |
|---|---|
| 前端（`app/web/`） | **完全跨平台** —— 纯 HTML/CSS/JS，一行都不用改 |
| Node 后端核心 | **完全跨平台** —— 含全部格式模块、转换引擎、任务系统、HTTP 层、下载器、B 站解析 |
| 桌面外壳（`app/desktop/`，Tauri） | **跨平台** —— Windows 用 WebView2，macOS 用 WKWebView |
| 平台相关代码（13 个文件，约 120 处） | **需要各写一份** |

还有个隐性优势：**零 npm 依赖**意味着没有原生模块要编译，避开了 Electron/Tauri 项目在
macOS 上最常见的坑（node-gyp、Xcode 命令行工具、Python 版本冲突）。

---

## 需要改的地方（精确清单）

### 一类：真平台依赖 —— 必须各写一份

| 文件 | 处数 | 干了什么 | macOS 怎么办 |
|---|---|---|---|
| `core/tools.mjs` | 56 | 探测本机装的编辑器（`H:\VOCALOID6\Editor\VOCALOID6.exe` 这类硬编码路径 + `ProgramFiles` 环境变量） | 换成 `/Applications/*.app` 扫描 + `which`；路径表整体替换 |
| `core/voices.mjs` | 21 | 读注册表 `HKLM\SOFTWARE\...\VOCALOID4\DATABASE41` 找声库 | macOS 上 VOCALOID 不存在 → 声库探测返回空即可；SynthV 声库改扫 `~/Library/Application Support` |
| `core/audio.mjs` | 11 | ffmpeg 路径（`ffmpeg.exe`）、一键安装（gyan.dev 的 Windows 构建） | `which ffmpeg` + [evermeet.cx](https://evermeet.cx/ffmpeg/) 的 macOS 构建，或提示用 Homebrew |
| `index.mjs` | 9 | 用 Edge 的 `--app` 模式开应用窗口（**Tauri 接管后这条兜底路径基本不用了**） | `open -a "Safari" <url>`，或者干脆删掉这段 |
| `core/libresvip.mjs` | 5 | 找 `libresvip-cli.exe` | 官方有 [`LibreSVIP-CLI-2.9.0.macos-arm64.tar.gz`](https://github.com/SoulMelody/LibreSVIP/releases/tag/v2.9.0)，改路径表 + 二进制名 |
| `net/ytdlp.mjs` | 3 | 下载 `yt-dlp.exe` | yt-dlp 官方有 `yt-dlp_macos`，改 URL + 文件名 |
| `core/formats/ust.mjs` | 4 | 借 PowerShell 的 `GetEncoding(932)` 把 UST 转成 Shift-JIS | 改用 `iconv`（macOS 自带），或纯 JS 查表 |
| `core/paths.mjs` | 3 | 读注册表 `User Shell Folders` 拿下载目录，回退枚举 `C:\Users\*` | macOS 直接 `$HOME/Downloads` —— **比 Windows 简单** |

### 二类：可以彻底消除（不抽象，直接删掉依赖）

| 文件 | 处数 | 原做法 | 改法 |
|---|---|---|---|
| `core/structure.test.mjs` | 1 | 借 PowerShell 的 `System.IO.Compression` 解 `.vpr` | ✅ **已完成** —— 改用 `util/zip.mjs`（项目自己的纯 JS ZIP 读取器） |
| `core/template.test.mjs` | 2 | 同上 | ✅ **已完成** |

> 这一类的处理原则是**消除比抽象好**：与其给 ZIP 解压做一个平台抽象层，
> 不如用已有的纯 JS 实现把它变成跨平台代码。改完这两个文件已经 0 处平台依赖。

### 三类：只是注释 —— 不用动

| 文件 | 说明 |
|---|---|
| `core/formats/acep.mjs` | 注释里提到 `C:\Program Files\ACE Studio`，仅说明性文字 |
| `core/formats/vsq.mjs` | 注释里说明 Shift-JIS 需要 PowerShell，实际转码在 `ust.mjs` |

### 测试专用

| 文件 | 处数 | 说明 |
|---|---|---|
| `core/xsd.test.mjs` | 4 | 用 PowerShell + .NET 的 `XmlSchemaSet` 校验 VSQX。**这是测试工具，非 Windows 上直接跳过即可**（它本来就会在找不到 schema 时优雅退出） |

---

## 建议的重构：`app/server/platform/`

现在平台相关代码散在 8 个文件里。收拢成一个目录后，移植 = 写一个新文件，而不是翻 8 个文件。

```
app/server/platform/
├─ index.mjs      按 process.platform 分发，对外暴露稳定接口
├─ windows.mjs    现有实现（搬过来，不重写）
├─ darwin.mjs     macOS 实现（新增）
└─ README.md      接口契约：新平台要实现哪些函数
```

### 接口设计（只暴露调用方真正需要的）

```js
// 路径与环境
export function getDownloadsDir(fallback)        // paths.mjs 用
export function exeName(base)                    // 'ffmpeg' → 'ffmpeg.exe' / 'ffmpeg'
export function findBinary(name, extraDirs)      // 在 PATH 和常见位置找可执行文件
export function appSearchDirs()                  // tools.mjs 探测编辑器用

// 执行外部命令
export function runShell(script, opts)           // win: PowerShell / unix: sh
export function killProcessTree(pid)             // win: taskkill /T /F / unix: 给进程组发信号

// 领域相关
export function discoverVoicebanks()             // voices.mjs 用；macOS 返回 []
export function toShiftJis(text)                 // ust.mjs 用；unix 走 iconv
export function ffmpegDownloadUrls()             // 各平台的构建源
export function ytdlpDownloadUrls()
```

**估算**：核心逻辑一行不用改，工作量集中在 8 个文件 → 1 个新目录。
按现在的代码量，大概是一天的活（大部分时间在验证，而不是写）。

---

## 移植时不要做的事

- **不要重写格式模块**。13 个格式模块 + 转换引擎对平台一无所知，原样能用。
- **不要动前端**。一行都不用改。
- **不要为了「跨平台」引入抽象层**。先按第二类的思路看看能不能直接消除依赖
  （比如 ZIP 那个例子），消除了就不用抽象了。
- **不要在 macOS 上硬做 VOCALOID 声库探测**。macOS 上根本没有 VOCALOID，
  返回空列表 + 界面上隐藏那张卡，比强行兼容诚实。

---

## 附：审计用的命令

想复查这份清单是否过时，跑这个（PowerShell）：

```powershell
Get-ChildItem 'app/server' -Recurse -File -Include '*.mjs' |
  Where-Object { $_.FullName -notlike '*__tests__*' } |
  ForEach-Object {
    $h = Select-String -Path $_.FullName -Pattern `
      "powershell|cmd\.exe|taskkill|chcp|WOW6432Node|HKCU:|HKLM:|\.exe\b|win32|/usr/|ProgramFiles"
    if ($h) { "{0}  {1} 处" -f $_.FullName, $h.Count }
  }
```
