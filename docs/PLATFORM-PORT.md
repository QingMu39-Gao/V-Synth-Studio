# 平台移植地图（macOS）

后端是 Tauri 应用**进程内**的一部分（Rust，约 5,900 行），没有 node.exe。
平台相关代码**全部集中在 `app/desktop/src/platform.rs`** —— 移植时主要就是改这一个文件。

```
src/platform.rs     ← 平台层（注册表、explorer、回收站、路径规范化、下载目录）
src/tools.rs        ← 编辑器路径表（Windows 专有，是**数据**不是逻辑）
src/main.rs         ← 窗口与服务启动（Tauri 本身就是跨平台的）
```

## 一、平台边界逐项对照

| 功能 | 现在的实现（Windows） | macOS 需要 |
|---|---|---|
| 下载目录 | 读注册表 `User Shell Folders`，退回 `USERPROFILE\Downloads` | `$HOME/Downloads`（更简单，删掉注册表那段） |
| 文件管理器定位 | `explorer /select,` | `open -R`（代码里已写好 cfg 分支） |
| 打开文件 | `explorer` | `open`（同上，已分支） |
| 回收站 | PowerShell `Shell.Application` | `trash` 命令或 `NSFileManager` |
| 平台名 | `node_platform_name()` 返回 `win32` | 已按 Node 命名返回 `darwin`，不用改 |
| 路径规范化 | 剥 `\\?\` 前缀 | `clean_path()` 里的 `#[cfg(windows)]` 块自然跳过 |
| 无窗口子进程 | `quiet_command()` 设 `CREATE_NO_WINDOW` | 非 Windows 下该标志不存在，函数本身已有 cfg 分支 |
| 注册表读取 | `voices.rs` 已删除；`platform.rs` 的下载目录读取用 `#[cfg(windows)]` 隔离 | 自动跳过 |

**外部工具**（ffmpeg / yt-dlp）走 `find_binary()` + PATH，逻辑本身跨平台。
它们现在**随包分发**在 `tools/` 里，macOS 版需要换成对应平台的二进制
（ffmpeg 的 macOS 构建 + yt-dlp 的 `yt-dlp_macos`）。

## 二、要注意的两处

**1. `src/tools.rs` 的编辑器路径表**

现在只剩 UVR 一个，路径表是 Windows 专有的（`H:\ChiXiaoYangUVR5` 等）。
macOS 上要么换成 `/Applications/*.app` 扫描，要么直接去掉这个探测
（UVR 在 macOS 上的安装方式本来就不统一）。这是**数据**，不是逻辑，改动很小。

**2. 打包**

macOS 用 `.app` bundle，目录结构和现在这套「绿色版」布局不同
（见 `docs/PACKAGING.md` 里说的是同一个问题）。`find_app_root()` 往上找
`app/web/index.html` 的逻辑需要适配 bundle 布局，或者改用 Tauri 的
`resource_dir()` API。

## 三、历史

Node 后端（`app/server/`，19,019 行）已整体删除，其中包含 12 个格式模块
和一套平台相关的探测代码。移植历史留档见 git：

```
git log --all -- app/server
```
