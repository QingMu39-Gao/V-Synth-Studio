# 交接文档 —— 给接手这个项目的新会话

**先读这一份，再动手。** 这里写的是"看代码看不出来"的东西：架构为什么长这样、
哪些坑踩过、下一步该往哪走。

最后更新：2026-09-27（UI 重构进行到一半时）

---

## 一、这个项目是什么

**清沐的虚拟歌姬工作站** —— 给翻调（VOCALOID/UTAU 等歌声合成）用的桌面工具。

功能：工程格式互转（40 种）、视频解析下载、音频处理、歌词获取、文字 PV 生成、资源导航。
全部离线，工程文件不出本机。

---

## 二、架构

### 一个进程，没有 Node

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

**历史上是 Node 后端，已全部重写成 Rust。** 现在 `node` 只出现在测试脚本里。

### 目录

```
app/
  desktop/            Tauri + Rust 后端
    src/
      main.rs         入口：选端口、开窗口、resolve_paths
      net.rs          共用 HTTP 客户端 + DEFAULT_UA
      platform.rs     跨平台路径、下载目录、回收站
      tools.rs        外部工具检测（ffmpeg / yt-dlp / Linux/macOS 编辑器）
      libresvip.rs    LibreSVIP 引擎封装（转换 + 读工程）
      lyrics.rs       歌词：搜索 / 取词 / LRC-SRT / 扫码与短信登录
      audio.rs        音频处理
      data.rs         静态数据（格式表、拼音）
      server/
        mod.rs        路由表（改路由来这里）
        simple.rs     health / state / config / fs / jobs / 静态文件
        convert.rs    工程转换
        media.rs      视频解析下载
        lyrics.rs     歌词相关路由
        tools.rs      工具检测
    tauri.conf.json   窗口、打包、resources
    build.ps1         唯一的构建入口（见下文）
  web/                前端：纯 HTML/CSS/JS，无框架、无构建步骤
    index.html
    css/  base.css（设计令牌 + 外壳）/ components.css / views.css
    js/
      main.js         路由、导航、状态、启动画面揭开
      theme.js        主题唯一入口
      api.js          所有后端调用
      ui.js           组件工厂（h/mount/button/card/chip/modal/toast…）
      timecode.js
      components/     dirPicker / waveEditor
      views/          dashboard convert video audio lyrics pv resources settings
    vendor/jizura/    JIZURA 文字 PV（上游构建产物 + 2335 个字体）
    img/bg/           桌面背景图（明亮/黑暗）
  data/                只读数据：resources.json / pinyin.json / RESOURCES-README.md
tools/                 随包分发：ffmpeg / yt-dlp / LibreSVIP（约 390 MB）
tests/
  contract/            接口契约（对冻结的夹具）
  manual/              浏览器 / 接口探针
  unit/                纯逻辑单测
docs/                  UI-KIT / PACKAGING / PLATFORM-PORT / THIRD-PARTY-NOTICES
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

**判断依据是"能不能写"，不是"装没装"。** 曾经因为 `resource_dir()` 在绿色版
也返回 exe 目录，导致绿色版被误判成安装版、配置写到 `%APPDATA%` 去了。

---

## 三、必须知道的坑（都是踩过的）

### 构建

| 事项 | 必须这样做 |
|---|---|
| 编译 | **只能** `powershell -ExecutionPolicy Bypass -File app\desktop\build.ps1` |
| | 直接 `cargo build` **不会**把 exe 复制到根目录，你跑的还是旧的，会以为改动没生效 |
| `-Release` / `-Bundle` | 可选参数；`-Bundle` 打 MSI（见 PACKAGING.md） |
| 工具链 | Rust 在 `H:\DevTools\cargo`、MSVC 在 `H:\VSBuildTools`（build.ps1 会加载 vcvars） |

### 文件编码

| 文件 | 要求 | 不遵守会怎样 |
|---|---|---|
| `.ps1` | **UTF-8 带 BOM** | PS 5.1 把中文注释按 ANSI 读 → 乱码吞掉换行 → 语法错 |
| `.bat` / `.cmd` | **CRLF** | cmd 解析不了 LF，命令会拆错 |

⚠️ **用编辑工具改 `.ps1` 会丢 BOM。** 改完检查头三字节是不是 `EF BB BF`。

### 前端

```powershell
# 语法检查：必须复制成 .mjs
Copy-Item app\web\js\views\x.js $env:TEMP\chk.mjs; node --check $env:TEMP\chk.mjs
```

**直接 `node --check x.js` 是假通过** —— Node 24 实测，ESM 里的语法错误也返回 0。

### 浏览器验证

```powershell
# Edge 在 C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
# 必须用 --headless=old（本机 --headless=new 报 Multiple targets）
& cmd /c "`"$edge`" --headless=old --no-sandbox --virtual-time-budget=9000 --dump-dom `"http://127.0.0.1:8891/#/dashboard`""
```

| 坑 | 说明 |
|---|---|
| **截图必须去掉 `--disable-gpu`** | 带着它 `backdrop-filter` 会糊成一片空白，看着像应用坏了 |
| `--dump-dom` 看不到 iframe 内部 | 要验 iframe 里的东西必须用 CDP（`--remote-debugging-port` + Node 自带 WebSocket，不要装包）。参考 `tests/manual/pv-verify.mjs` |
| **端口用 8891 跑测试** | 正式启动是 17878，测试用别的端口以免和用户正在开的实例打架 |

### 缓存（曾导致"改了看不到"）

静态文件**必须**发 `Cache-Control: no-store`（`simple.rs` 里已加）。

**曾经一个缓存头都不发**，WebView2 按启发式规则缓存了 CSS/JS —— 于是
"改了界面但用户看不到变化"。**这个 bug 极难自查**：测试每次开全新的无头
浏览器，永远命中不了缓存，本地怎么试都是新的。**只有用户那个常驻的
WebView2 拿着旧文件。** 以后凡是"我这边正常、用户说没变"，先怀疑缓存。

### 端口

**固定 17878**（`main.rs` 的 `PREFERRED_PORT`），被占用才退回随机并写
`app.log`。

不能随机：**localStorage 按 origin（协议+主机+端口）隔离**，端口一变就是
全新存储空间 —— JIZURA 的教程标记、界面设置、**PV 工程自动保存**全都会丢。

### CSS 层叠怪癖

- **`html::after` 做背景层会渲染到内容之上**（Chromium 对 `backdrop-filter`
  采样 `position:fixed` 伪元素的怪癖）。背景层要做成 `body` 内的普通元素。
- **`--glass` 系列令牌（4.5% 白）是给纯色背景设计的**，一旦有背景图就全透、
  文字没法看。有背景图时这些值要单独调。

### 网络

- **GitHub / Google 需要代理**，而**命令行默认不走系统代理**：
  `& curl.exe -x http://127.0.0.1:7890 ...`
- 网易云 / QQ 音乐**直连即可**，不用代理
- **测试短信接口绝不要用真实手机号**（会真的发短信）。只用 `123` 这类
  明显非法的格式验证"接口存在"。这个错犯过。

### 磁盘

- **C 盘很紧**（长期只剩几 GB）。临时大文件放 `H:\工作站\tmp-*` 并即时删。
- 构建产物在 `H:\工作站\app\desktop\target`（H 盘，没问题）。

### 进程卫生

跑完测试**必须**停掉测试实例、清掉无头 Edge：

```powershell
$c = Get-NetTCPConnection -LocalPort 8891 -State Listen -EA SilentlyContinue | Select-Object -First 1
if ($c) { Stop-Process -Id $c.OwningProcess -Force }
Get-Process -Name 'msedge' -EA SilentlyContinue | Where-Object { $_.MainWindowHandle -eq 0 } | Stop-Process -Force
```

不清会锁住 exe，别人编译失败；无头 Edge 每个约 60–100 MB，会堆到十几个。

⚠️ **杀进程只能按精确 PID 或端口 owner**，别按命令行子串匹配 —— 曾经误杀过
DSH 自己的任务进程。

---

## 四、怎么验证

```powershell
# 启动测试实例
$p = Start-Process -FilePath 'H:\工作站\清沐的虚拟歌姬工作站.exe' `
     -ArgumentList '--serve','--port=8891' -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 8

# 1) 接口契约（对冻结夹具，只报"期望的字段缺失"）
node tests\contract\verify.mjs 8891          # 应 17/17

# 2) 八个页面渲染 + 关键字断言
powershell -ExecutionPolicy Bypass -File tests\manual\ui-smoke.ps1 -BaseUrl http://127.0.0.1:8891   # 应 8/8

# 3) Rust 单测
cd app\desktop; cargo test --bins            # 应全绿
```

**契约测试里的 `INTENDED` 白名单**是"已知的有意差异"。加条目要写清理由 ——
**它很容易变成掩盖问题的垃圾桶**。

`ui-smoke.ps1` 会断言每页的关键字（如总览要有「欢迎回来」「格式支持」）。
**改页面文案会让它红**，改文案前先看它断言了什么。

---

## 五、当前状态

### 已完成

| 模块 | 状态 |
|---|---|
| 工程转换 | 40 种格式，走 LibreSVIP CLI |
| 视频解析下载 | B 站原生解析 + yt-dlp |
| 音频处理 | 波形编辑器、裁剪、变速变调、格式转换 |
| **歌词** | 网易云 / QQ 搜索、取词、LRC/SRT、双语、封面、**从本地文件导入（含 GBK 自动识别）** |
| **文字 PV** | JIZURA 本地部署（字体已离线化），歌词一键带入，导出可选路径 |
| 资源库 | 4 组 27 条 |
| 双主题 | 亮/暗，跟随系统，可切换 |
| 打包 | MSI 能出（配置见 PACKAGING.md），**但已过期，成品定了再重打** |

### 明确不做

- **网易云扫码登录**：服务端返回 `8821 请切换其他登录方式`。已按官方 JS
  逐字节对齐三处（POST unikey、`http://` 二维码内容、POST 轮询）**仍然失败**，
  判断是服务端风控。**留了手机号验证码 + Cookie 两条路**，扫码已移除。
  别再试图修它。
- **盗版资源收录**：用户明确拒绝，资源库只收官方/开源/免费渠道。

### 已知未修

- `mime_of` 不认 `.jpg`，返回 `application/octet-stream`（浏览器能渲染，但不规范）
- 无 `backdrop-filter` 环境的降级方案没做视觉验证

---

## 六、下一步：UI 重构（进行到一半）

### 用户的原话与判断标准

> 重构整个ui抛弃原有设计语言

**判断标准是一眼看上去"不是同一个软件"。** 已经失败过四轮，原因见下。

### 四轮尝试的教训（别重复）

| 轮次 | 做了什么 | 为什么用户仍说"没变" |
|---|---|---|
| 1 | 配色、高斯模糊、弹性动效、双主题 | 纯装饰，结构一行没动 |
| 2 | 圆角、阴影调大 | 还是装饰 |
| 3 | 骨架改成"两片浮起的面板" | 结构变了，但组件形状没变 |
| 4 | 尺度抬高（字号/间距/导航行高） | 密度变了，但"是什么"没变 |

**结论：参数改一百处也改不出另一种设计语言。**

### 用户已定的方向（不要再问）

- **布局保持侧边栏**
- **低密度、大留白**
- **组件走"浮起"**（already 部分实现：卡片去描边、长扩散阴影）
- 其余由实现者定

### 真正要动的是组件层，不是参数

| 现在 | 要变成 |
|---|---|
| 卡片 = 方块容器 + 标题 + 描述 + chip 堆叠 | 大留白分区；很多地方**不该有卡片**，标题直接落在背景上 |
| 导航 = 等宽列表行 + 小图标 | 换形态：大图标胶囊？收起成图标轨道？ |
| 栅格 = 等宽四宫格 | 主次不等的节奏，不要四等分 |
| 英雄卡 = 大数字 + 文案 + 按钮 | 去掉或换成完全不同的入口形态 |
| 一屏信息量 | 大幅减少，重要的放大 |

**这些要改 `app/web/js/views/*.js` 的渲染结构**（配合 `ui.js` 的组件工厂），
不是 CSS 能覆盖的。**那才是重构。**

### 建议的做法

1. **先只做一页**（总览），把新语言完整落地
2. **让用户看了认可之后再推平到其余 7 页**
3. 一上来铺全站，方向错了就是全错，返工代价大且用户无法中途叫停

### 可以复用的（别重造）

- 骨架已是"侧栏 + 主区两片浮起"，这个方向用户认可
- 尺度令牌已就位：`--font-size-base` / `--pad-card` / `--pad-view` /
  `--gap-section` / `--gap-card` / `--nav-h`
- 双主题变量体系、`@supports` 降级、`prefers-reduced-motion` 处理
- 启动画面（静态遮罩 + 三道兜底：报错 / 12s 超时 / 纯 CSS 15s 硬揭开）
- 背景图 `app/web/img/bg/{light,dark}.jpg`，主题自动切换
- **缓存头已修**，改了立刻能看到

### 约束

- **无框架、无构建步骤、无 npm**。纯手写 HTML/CSS/JS。
- 契约 17/17、smoke 8/8 必须保持。
- **别改页面文案**（smoke 断言关键字）。
- **`app/web/vendor/jizura/` 一个字节都别碰**（上游构建产物 + 2335 个字体，
  要能整份替换升级）。

---

## 七、给用户看的快速上手

```powershell
# 编译 + 复制 exe 到根目录
powershell -ExecutionPolicy Bypass -File app\desktop\build.ps1

# 启动
双击 启动工作站.bat        # 或直接跑 清沐的虚拟歌姬工作站.exe

# 只跑服务不开窗口（调试用）
清沐的虚拟歌姬工作站.exe --serve --port=8891
```

日志在 `<可写目录>/app.log`（绿色版是 `app/data/app.log`）。
程序**没有控制台窗口**（`#![windows_subsystem = "windows"]`），排查靠这个日志。
