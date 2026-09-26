# 打包说明（MSI / NSIS）

**代码侧已就绪**（2026-09 更新）。路径定位改成了「先问 Tauri 的 `resource_dir()`，
再往上找 exe 旁边」，可写数据也分出来了。`tauri.conf.json` 的 `resources` 已配好。

**还没实测过**：这台机器没装 `tauri-cli`，也没跑过 `build.ps1 -Bundle`。
第一次打包时请重点验证下面两件事（`docs/PACKAGING.md` 末尾有清单）。

## 卡在哪

程序运行时靠 `main.rs::find_app_root()` **往上找 `app/web/index.html`** 来定位程序根目录。
它假定的是「绿色版」布局：

```
<根目录>/
  app/web/          ← 界面（Rust 内嵌服务从磁盘读，不是打包进 exe 的）
  app/data/         ← 配置、资源库、拼音词典
  tools/            ← ffmpeg 302 MB + LibreSVIP 70 MB + yt-dlp 17 MB
```

而 Tauri 的 `bundle.resources` 会把资源**平铺**到 `<安装目录>/resources/` 下，
目录结构和上面这套对不上，`find_app_root()` 就找不到 `app/web/index.html`。

所以 `tauri.conf.json` 里的 `resources` 现在是空的。

## 已做的事

### 1. 路径定位（已改）

`main.rs::resolve_paths()` 现在按这个顺序找：

1. **Tauri 的 `resource_dir()`** —— 安装版走这条
2. **从 exe 往上找** —— 绿色版走这条
3. **当前工作目录往上找** —— `cargo run` 走这条

判据是 `app/web/index.html` 存在。找到哪个，就用哪个当只读资源根目录。

### 2. 可写数据分离（已改）

**这是装到 `Program Files` 后最容易踩的坑**：那里是只读的（写它要管理员权限），
而 `config.json` 是运行时写的 —— 不分离的话，「保存设置」会直接失败。

| 内容 | 位置 | 说明 |
|---|---|---|
| `app/web/`、`tools/` | 只读资源根目录 | 随包分发，不改 |
| `resources.json`、`pinyin.json` | `<根>/app/data/` | 只读，随包分发 |
| `config.json` | **可写目录** | 绿色版 = `<根>/app/data/`；安装版 = `%APPDATA%\com.qingmu.vocalworkstation\` |

`/api/state` 里多了个 `installed` 字段，界面可据此区分两种形态给提示。

### 3. 打包资源（已配）

`tauri.conf.json` 的 `resources` 现在包含 `app/web`、`app/data` 的三个只读文件、`tools`。
**`config.json` 刻意不在里面** —— 它是运行时数据，不该随包分发。

## 第一次打包要验证的事

1. **装完之后界面能打开**（路径定位对不对）
2. **改一个设置、重启，设置还在**（可写目录对不对 —— 这条最容易挂）
3. **转换能跑**（`tools/libresvip/` 找得到）
4. **ffmpeg 能用**（`tools/ffmpeg/` 找得到）

## 原始的分析（保留）

两个方向，选一个：

- **改定位逻辑**：让 `find_app_root()` 也认识 Tauri 的安装布局，或者干脆改成用 Tauri 的
  `resource_dir()` API 拿路径（需要在 `setup()` 里把它传给 `AppState`）。
- **不用 resources**：把 `app/` 和 `tools/` 当成「安装后释放的负载」，
  用 NSIS 的 `installerHooks` 或者首次运行时自解压。

推荐第一个 —— 简单，而且不改变现在的目录结构。

### 2. 决定 `tools/` 怎么进包

`tools/` 一共约 **390 MB**（ffmpeg 302 + LibreSVIP 70 + yt-dlp 17），远超一般安装包的舒适区。

已经确定的原则是**随包分发**（不让用户自己下）—— 本程序主要在国内用，
让用户去 GitHub 下 ffmpeg 基本下不动。剩下的只是「怎么装进去」：

- 直接塞进 MSI：包会很大，但一次装完，最省事
- 首次运行时释放：安装包小，但第一次启动要等

## 在那之前怎么分发

**整个目录打压缩包**。解压后双击 `启动工作站.bat` 即可运行 —— 这条路径已经验证过，
不需要安装，也不需要 WebView2 以外的任何运行时。

注意 WebView2：`webviewInstallMode` 现在是 `downloadBootstrapper`（装的时候联网下约 1.5 MB）。
目标机器完全不联网的话要改成 `offlineInstaller`（包大 130 MB 左右）。
Win11 和较新的 Win10 都预装了 WebView2，一般不用操心。

## 运行时的外部依赖（已实测）

| 依赖 | 需要吗 | 依据 |
|---|---|---|
| VC++ 运行库 | **不需要** | 导入表里没有 `VCRUNTIME140.dll` / `MSVCP140.dll`，只依赖 Windows 自带的 UCRT |
| Node.js | **不需要** | 后端已完全重写为 Rust |
| Python | **不需要** | LibreSVIP 是 PyInstaller 打包的，自带 `python3.dll` |
| WebView2 运行时 | **需要** | 唯一的硬依赖，见上 |
