# 第三方组件与许可

**本程序自身以 GPL-3.0 授权**（全文见仓库根目录的 `LICENSE`，Copyright (C) 2026 QingMu39）。

下面这些是**随包分发的独立外部程序**：以**独立进程**方式调用（不链接、不修改），
分发时各自遵守自己的许可条款。其中 **FFmpeg 是 GPL v3 构建**，与本程序同属 GPL 系，
合在一起分发没有许可冲突；其余的（Apache-2.0 / Unlicense / MIT / OFL）也都与 GPL-3.0 兼容。

> **2026-09 更新**：格式转换已改用 **LibreSVIP**，原先取自 UtaFormatix3 的模板与参考实现
> 已全部移除（相关代码随 Node 后端一并删除），署名不再必需。分发时请把本文件一起带上。

---

## 随包分发的组件

| 组件 | 位置 | 版本 | 许可 |
|---|---|---|---|
| FFmpeg | `tools/ffmpeg/` | Windows / Linux：BtbN 的 LGPL 构建（master）；macOS：jellyfin-ffmpeg 8.1.3 可携包 | Windows/Linux **LGPL**；macOS **GPL v3** ⚠️ |
| yt-dlp | `tools/yt-dlp`（Windows 上 `yt-dlp.exe`） | 2026.08.19 | Unlicense（公有领域） |
| LibreSVIP | `tools/libresvip/` | 2.9.0 | Apache License 2.0 |
| JIZURA | `public/vendor/jizura/` | v0.10.1（单文件构建产物） | MIT |
| Google Fonts（12 个家族） | `public/vendor/jizura/fonts/` | — | SIL OFL 1.1 |

> ⚠️ 这张表里的 `tools/` 与 `public/vendor/` 都**不入库**（由补齐脚本现场取），所以它们的版本
> 随「补齐那一刻的上游」变。换上游版本时记得回来改这一行。
>
> ⚠️ **FFmpeg 三端来源不同**：Windows / Linux 取 BtbN 的 **LGPL** 档（够用，本程序不编码
> 视频），macOS 上没有同样可用的 LGPL 静态构建 —— 唯一那档 LGPL（acoustid）是纯音频的、
> **没有 `atempo` / `loudnorm` 这些滤镜**，变调变速与响度归一化会直接失败。所以 macOS
> 取 jellyfin-ffmpeg 的可携包，是 **GPL** 构建：与本程序（GPL-3.0）同系，随包分发无冲突，
> 但按下面「FFmpeg 是 GPL 构建」那一节的义务办。

运行时依赖：

| 组件 | 说明 |
|---|---|
| WebView2 Runtime | 微软，Win11 与较新 Win10 预装 |
| Tauri | Apache-2.0 / MIT 双许可，已静态链接进 exe |
| Rust 标准库与各 crate | MIT / Apache-2.0，已静态链接进 exe |
| ONNX Runtime（`ort` crate，MIT） | **运行时按需加载**，见下面「人声转 MIDI」一节 |

前端依赖（打包进 `app/web/assets/index-*.js`，不是独立程序，也不联网请求）：

| 组件 | 实际版本 | 许可 | 用途 |
|---|---|---|---|
| React / React DOM | 19.3.0 | MIT | 整个界面的运行时 |
| qrcode.react | 4.2.0 | ISC | 把 B 站登录二维码画成 SVG（纯前端渲染） |

> 两者的许可全文随源码仓库的 `app/web-next/node_modules/` 分发；`package.json` 里记的是
> 范围（`^`），上表这一列是**实际装上的版本**（`npm ls --depth=0` 实测）。

---

## 人声转 MIDI（GAME）—— ⚠️ 权重是**非商业**许可

2026-10-03 加入的功能（`app/desktop/src/game/**`、`src/midi_transcribe.rs`、扒谱页）。

**上游**：[openvpi/GAME](https://github.com/openvpi/GAME)。它有两套许可，**必须分开说**：

| 部分 | 许可 | 本程序怎么用它 |
|---|---|---|
| **代码** | MIT | 推理算法（D3PM 采样、边界解码、切片、MIDI 写出）是**照它的算法在 Rust 里重写的**，没有链接或拷贝它的代码 |
| **模型权重** | **CC BY-NC-SA 4.0（署名 — 非商业性使用 — 相同方式共享）** | **不随包分发** —— 由界面按需下载（`GAME-1.0.3-large-onnx.zip`）。界面上写明许可与出处 |

⚠️ **「非商业」是硬约束**：带这个功能分发/使用时不能用于商业用途。界面「许可与出处」
那一栏就是为这条规矩放的，**别删**。这也和资源库的收录原则（`AGENTS.md` 第六节）同源。

⚠️ **权重包是「自己托管」，不是「自己产的」**：下载地址是本仓 release `modules` 标签上的
**同一份官方 ONNX 导出**（`tools/pack_assets.mjs --only game.models` 从 `data/game/models/`
打出来，白名单四个文件、逐个校验实测字节数；顶层目录名沿用上游的 `GAME-1.0.3-large-onnx/`，
所以两个包可以互换）。许可与出处仍然照上面那一行写：署名给 openvpi/GAME，许可 CC BY-NC-SA 4.0。
⇒ **打这个包的人要把这条规矩当回事**：包里的东西一字未改，别往里塞自己训的或来路不明的权重。

⚠️ **托管在 GitHub release，境内那条线路靠镜像**：release 资产会 302 到
`objects.githubusercontent.com`，国内直连常不通。所以程序在下载前会按
<https://git.hiwiki.org/zh-CN/mirrors> 的名单在**本机**实测几面镜像、挑最快的那面取字节
（实现见 `src-tauri/src/ghmirror.rs`）。⚠️ 这一层**只改「从哪台服务器取字节」，不改包的内容**：
镜像回来的字节同样要过大小核对与解压时的逐条 CRC。想强制走直连就设 `VSS_GH_MIRROR=off`。

**ONNX Runtime**：本功能用 `ort` crate（MIT）以 `load-dynamic` 方式**在运行时加载**
`onnxruntime.dll`，不静态链接它；那份 dll **随包分发**（`tools/onnxruntime/`，构建时由
`tools/fetch_tools.mjs` 从 Microsoft 官方 release 取 `onnxruntime-win-x64-1.23.2.zip`，
MIT，再随 `bundle.resources` 打进安装包）——所以**运行期不需要下任何运行库**。

找不到随机那份时按能力借用户机器上已有的（`midi_transcribe::runtime_dll`）：
优先带 `onnxruntime_providers_cuda.dll` 的那份（**音轨分离运行时**里那份是 GPU 构建），
其次是 `<可写>/midi` 或 DirectML 加速包里的。⚠️ 借用顺序**不是**候选顺序 —— 按顺序挑会让
一份 CPU 构建把后面那份能跑 CUDA 的遮蔽掉，GPU 那一格就再也点不亮。

---

## ⚠️ FFmpeg 的许可按平台不同 —— 分发前请确认

三端各取各的构建（见上表），所以**许可不是一回事**：

- **Windows / Linux：LGPL**（BtbN 的 `ffmpeg-master-latest-*-lgpl`，不带 `--enable-gpl`）。
  LGPL 只要求附许可全文、并允许用户替换该组件，不要求源码要约。
  代价是失去 H.264/H.265 **编码**能力 —— 本程序不做视频编码（6 处调用都带 `-vn`，
  合流是 `-c copy`），没有实际损失。
- **macOS：GPL**（jellyfin-ffmpeg 的可携包，`--enable-gpl` + `--enable-libx264`）。
  用它是因为 macOS 上没有同样可用的 LGPL 静态构建（见上表那条警告）。分发它要：

  1. **附上 GPL v3 全文**（从 <https://www.gnu.org/licenses/gpl-3.0.txt> 取一份）；
  2. **提供对应源码**，或一份**书面要约**（written offer）加上明确的源码获取地址：
     - FFmpeg 源码：<https://ffmpeg.org/download.html>
     - jellyfin-ffmpeg 的构建脚本与发布：<https://github.com/jellyfin/jellyfin-ffmpeg>

> 开发机上那份 Windows ffmpeg 若是 gyan.dev 的 essentials（`--enable-gpl --enable-version3`），
> 也按上面第 2 条办：源码 <https://ffmpeg.org/download.html>，构建脚本
> <https://www.gyan.dev/ffmpeg/builds/>。CI 打的是 BtbN 的 LGPL 档，不受这一条约束。

> 换 ffmpeg 之前先核对编码器：`ffmpeg -encoders` 里要有 `libmp3lame` / `libopus` /
> `libvorbis`，滤镜里有 `atempo` / `asetrate` / `loudnorm`（macOS 那条 LGPL 的纯音频构建
> 就缺这几个滤镜），再跑一遍音频页的转换 / 变调 / 裁剪与视频页的合流确认没退化。
> CI 的 macOS 冒烟那一步已经把编码器查了一遍。

---

## LibreSVIP（Apache License 2.0）

- 项目：<https://github.com/SoulMelody/LibreSVIP>
- 使用方式：作为**独立可执行程序**调用（`libresvip-cli proj convert …`，Windows 上是
  `libresvip-cli.exe`），不修改、不链接其代码。
- 它自身打包了 Python 运行时和若干依赖（PyInstaller 产物），各自许可见
  `tools/libresvip/libresvip-cli/_internal/*.dist-info/licenses/`。

## yt-dlp（Unlicense）

- 项目：<https://github.com/yt-dlp/yt-dlp>
- Unlicense 属公有领域奉献，无附加义务。

## pinyin-data（MIT）

`app/data/pinyin.json` 的汉字读音数据来源。程序运行时只读这个 JSON，不依赖其代码。

---

## 历史：UtaFormatix3（已不再使用，代码与参考文件均已删除）

早期版本的格式写出模块以 UtaFormatix3 的模板为骨架，参考实现放在
`app/server/core/formats/`，另在 `docs/reference/utaformatix3/`（19 个 Kotlin 文件）
留了一份源码参考。

**两处都已删除** —— 格式转换现在交给 LibreSVIP（40 种格式），不需要自己写
reader/writer，因此不再使用 UtaFormatix3 的任何代码或素材。本程序不含该项目的任何代码，
**无需署名**。

保留此段只为说明历史来源。若日后重新引入相关代码，需恢复 Apache-2.0 署名：
<https://github.com/sdercolin/utaformatix3>（Copyright 2020 sdercolin）

---

## uiverse.io（仅参考观感，未移植代码）

<https://uiverse.io/> —— 站内 UI 组件（loader / switch / 卡片 / 玻璃拟态）声明为 **MIT**。

界面改版时参考过该站的 loader 类组件来确定「环形转圈进度条」的观感。
**没有逐字搬运任何组件代码**：`app/web/css/base.css` 里的 `.boot-ring` 是用本站自己的配色变量、
以 `conic-gradient` + 环形 `mask` 自写的；开关与分段控件用的是本项目原有的结构，只重写了动效。
因此这里没有需要随包分发的第三方代码，列出仅为来源说明。若日后真的整段移植某个组件，
按 MIT 要求在该文件里补上版权与许可全文，并在此处登记。

---

## 收录原则
本程序**不收录**任何破解、激活器或盗版声库/编辑器的分发链接 —— 收录原则见 `AGENTS.md` 第七节。
原因不是保守，而是这类资源在原理上无法验证安全性（无数字签名、二次打包、常捆绑启动器），
是木马和挖矿程序的高发区。

---

## 163MusicLyrics（歌词处理部分，Apache-2.0）

<https://github.com/jitwxs/163MusicLyrics>

本工作站的「歌词」页在**歌词文本处理**上移植了该项目的实现（Apache License 2.0）：

| 移植内容 | 位置 | 来源 |
| --- | --- | --- |
| LRC 时间戳多写法解析（`[mm:ss]` / `[mm:ss.SS]` / `[mm:ss:SS]` / `[mm:ss:SS.SSS]` / `[mm]`，含毫秒位 1/2/3 位的换算） | `app/desktop/src/lyrics.rs` | `Core/Models/MusicLyricsVO.cs` 的 `LyricTimestamp` |
| LRC→SRT 的结束时间规则（下一时间戳收尾、同时间戳多行同收、末句用歌曲时长） | 同上 | `Core/Utils/SrtUtils.cs` 的 `LrcToSrt` |
| 译文对齐与容错（精确匹配 + ±50ms 抖动容忍、译文缺失处理） | 同上 | `Core/Utils/LyricUtils.cs` 的 `ResolveTransLyricDigitDeviationAndLost` |
| QQ 歌词丢弃 `[offset:0]` / `[kana:` 之前的头部内容 | 同上 | `LyricUtils.SplitLrc` |
| 空行 / `//` / 纯音乐占位文案判定 | 同上 | `LyricVo.IsIllegalContent` / `IsPureMusic` |
| 双语组织方式（STAGGER：同时间戳连写两行） | 同上 | `LyricUtils.FormatLyric` |

**未移植、按实测接口自行实现的部分**：全部 HTTP 调用与端点选择。
该项目走网易云的 `weapi`（AES + RSA）加密链路；本工作站改用明文端点
（`/api/cloudsearch/pc`、`/api/song/lyric`、`/api/song/detail`），
QQ 侧用 `search_for_qq_cp`（搜索）与 `fcg_query_lyric_new.fcg`（歌词），
均为其源码中未使用的接口。扫码登录、链接解析、封面下载、前端二维码生成器亦为自研。

源文件中的移植处均有行内注释标注来源。

---

## FusionMusicPlayer（歌曲下载与网易云账号部分，GPL-3.0）

<https://github.com/Janson20/FusionMusicPlayer> —— **GPL-3.0**（Copyright (c) Janson20）。

本工作站「歌词」页的**下载音质**与**网易云账号**这两块参考了它的做法，
代码按本仓的接口与结构自行编写，**未拷贝其代码**（与本程序同为 GPL-3.0，无许可冲突）：

| 参考内容 | 位置 | 来源（上游） |
| --- | --- | --- |
| 下载档位（128K / 320K / 无损 / Hi-Res / 自动）与逐档向下的回退链 | `src-tauri/src/lyrics.rs` | `app/core/resolver.py` 的降级链 |
| 静默降级的识别：非会员求无损拿到 `level=exhigh` 时不算成功 | 同上 | 同上 |
| 落盘前的文件头 + 时长双重校验、`<文件名>.part` 临时文件 | 同上 | `app/core/resolver.py` |
| 会员标签按客户端写法带等级（「黑胶SVIP·肆」，等级超出 1..99 时退回阿拉伯数字） | 同上 | `app/core/account.py` |
| 凭据有效期（服务端 `MUSIC_U` 的 Max-Age 约 180 天）与临近过期自动续期（`/api/login/token/refresh`） | 同上 | 同上 |
| 登录态划分：服务端确认失效才置为未登录，网络故障不动登录态 | 同上 | 同上 |

**未参考、按实测接口自行实现的部分**：全部端点选择与请求参数形状、
`vipType` 两种编码（标量 / 位掩码）的判定、文件头魔术字节的解析。
上游是 PySide6 + FluentUI QML 的 Python 实现，本项目是 Rust + Tauri，
两边没有共享代码，也不链接。

界面上的登记见「歌词」页页脚的「许可与出处」，与设置页的第三方组件许可总表同源。

---

## JIZURA（文字 PV 编辑器）

- 出处：<https://github.com/852wa/JIZURA>　Copyright (c) 2026 hakoniwa
- 许可：**MIT**，全文见 `app/web/vendor/jizura/LICENSE`
- 位置：`app/web/vendor/jizura/index.html`（作者发布的**单文件构建产物**，未做构建，
  直接取 `https://852wa.github.io/JIZURA/zh-hans/index.html`）

集成方式：以 iframe 嵌入「文字 PV」页（同源，由本程序自己的本地服务伺服）。
**它的界面与功能未作任何修改** —— 唯一的改动是把字体来源从 Google Fonts 换成本地文件
（改动的 3 处：删掉 2 条 `preconnect`、把静态字体表指向 `fonts.css`、
把运行时惰性插 `<link>` 的那一句也指向 `fonts.css`）。升级时整份替换该目录即可，
替换后需要重新执行 `tools/fetch-jizura-fonts.ps1` 并重做这三处替换。

⚠️ 这个目录（约 54MB：index.html + 2335 个 woff2 + fonts.css）**不入库**，两个脚本分工不同：

- `app/desktop/fetch-tools.ps1` —— 常规路径。把存档 `jizura.zip` 解到
  `app\web\vendor\jizura\`，**不解析、不改动**里面任何东西，所以它既快又不会跑偏。
  开发机、CI 都走这条。
- `tools/fetch-jizura-fonts.ps1` —— **只在真的要升级 JIZURA 时**用：它按上面那三处改动
  从上游重新生成 `index.html` + `fonts.css` + 字体，改完要往 `jizura.zip` 里重打一份存档。
  它抓 Google Fonts，所以依赖能访问 Google（脚本里写死了本机代理 127.0.0.1:7890）——
  正因如此它不适合放进 CI。

### 随它分发的字体

`app/web/vendor/jizura/fonts/` 与 `fonts.css` 由 `tools/fetch-jizura-fonts.ps1` 从
Google Fonts 抓取（用现代浏览器 UA 取 `css2`，拿到的是 woff2 子集；Google 按
`unicode-range` 把 CJK 字体切成了大量子集，所以是几千个小文件而不是十几个大文件）。

涉及的字体家族与其授权（**全部为 SIL Open Font License 1.1**，允许随程序再分发）：

| 家族 | 版权方 |
|---|---|
| Dela Gothic One | The Dela Gothic One Project Authors |
| DotGothic16 | The DotGothic16 Project Authors |
| IBM Plex Mono / IBM Plex Sans JP | IBM Corp. |
| Kaisei Tokumin | The Kaisei Project Authors |
| M PLUS Rounded 1c | The M PLUS Project Authors |
| Mochiy Pop One | The Mochiy Pop Project Authors |
| Noto Sans JP / Noto Serif JP | The Noto Project Authors |
| Potta One | The Potta One Project Authors |
| Rampart One | The Rampart One Project Authors |
| Reggae One | The Reggae One Project Authors |
| Shippori Mincho B1 | The Shippori Mincho Project Authors |
| Yuji Syuku | The Yuji Syuku Project Authors |
| Zen Kaku Gothic New / Zen Old Mincho | The Zen Project Authors |

OFL 1.1 全文：<https://openfontlicense.org/open-font-license-official-text/>。
注意 OFL 的**保留字体名称**条款：不得把修改过的字体以原名称分发（本程序未修改字形，
只是原样搬运子集文件）。
