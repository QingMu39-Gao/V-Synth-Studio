# 第三方组件与许可

本程序自身不含第三方代码，但**随包分发**了几个独立的外部程序。它们以**独立进程**方式调用
（不链接、不修改），属于「聚合分发」（mere aggregation），因此不影响本程序自身的授权方式。
但分发时仍须遵守各自的许可条款 —— 下面逐项说明。

> **2026-09 更新**：格式转换已改用 **LibreSVIP**，原先取自 UtaFormatix3 的模板与参考实现
> 已全部移除（相关代码随 Node 后端一并删除），署名不再必需。分发时请把本文件一起带上。

---

## 随包分发的组件

| 组件 | 位置 | 版本 | 许可 |
|---|---|---|---|
| FFmpeg | `tools/ffmpeg/` | 9.0.2（gyan.dev essentials 构建） | **GPL v3** ⚠️ |
| yt-dlp | `tools/yt-dlp.exe` | 2026.08.19 | Unlicense（公有领域） |
| LibreSVIP | `tools/libresvip/` | 2.9.0 | Apache License 2.0 |
| JIZURA | `app/web/vendor/jizura/` | v0.9.0（单文件构建产物） | MIT |
| Google Fonts（12 个家族） | `app/web/vendor/jizura/fonts/` | — | SIL OFL 1.1 |

运行时依赖：

| 组件 | 说明 |
|---|---|
| WebView2 Runtime | 微软，Win11 与较新 Win10 预装 |
| Tauri | Apache-2.0 / MIT 双许可，已静态链接进 exe |
| Rust 标准库与各 crate | MIT / Apache-2.0，已静态链接进 exe |

---

## ⚠️ FFmpeg 是 GPL 构建 —— 分发前请确认

用 `ffmpeg -version` 看配置参数，当前这份是：

```
--enable-gpl --enable-version3 ... --enable-libx264 --enable-libx265 ...
```

`--enable-gpl` 加 `--enable-version3` 意味着这是 **GPL v3** 构建。分发它需要：

1. **附上 GPL v3 全文**（`tools/ffmpeg/` 里若自带 `LICENSE` 就带上，否则从
   <https://www.gnu.org/licenses/gpl-3.0.txt> 取一份）
2. **提供对应源码**，或一份**书面要约**（written offer）加上明确的源码获取地址。
   最省事的做法是在说明里写上源码地址：
   - FFmpeg 源码：<https://ffmpeg.org/download.html>
   - gyan.dev 的构建脚本：<https://www.gyan.dev/ffmpeg/builds/>

### 更省事的选择：换成 LGPL 构建

本程序对 ffmpeg 的用法**只需要音频能力**（格式转换、变调变速、裁剪、响度、音轨提取），
加上视频下载后的**流拷贝合并**（`-c copy`，不解码视频）。

也就是说 **x264 / x265 这两个 GPL 组件根本用不到**。换成不带 `--enable-gpl` 的
**LGPL 构建**（例如 BtBN 的 `ffmpeg-master-latest-win64-lgpl`），合规负担小很多：
LGPL 只要求附许可全文并允许用户替换该组件，不要求源码要约。

代价是失去 H.264/H.265 **编码**能力 —— 但本程序不做视频编码，没有实际损失。

> 换之前建议先跑一遍 `tests/contract/verify.mjs` 和音频页的转换/变调/裁剪，
> 确认新构建带齐了 `libmp3lame` / `libopus` / `libvorbis` 这些音频编码器
> （LGPL 构建通常都带）。

---

## LibreSVIP（Apache License 2.0）

- 项目：<https://github.com/SoulMelody/LibreSVIP>
- 使用方式：作为**独立可执行程序**调用（`libresvip-cli.exe proj convert …`），
  不修改、不链接其代码。
- 它自身打包了 Python 运行时和若干依赖（PyInstaller 产物），各自许可见
  `tools/libresvip/libresvip-cli/_internal/*.dist-info/licenses/`。

## yt-dlp（Unlicense）

- 项目：<https://github.com/yt-dlp/yt-dlp>
- Unlicense 属公有领域奉献，无附加义务。

## pinyin-data（MIT）

`app/data/pinyin.json` 的汉字读音数据来源。程序运行时只读这个 JSON，不依赖其代码。

---

## 历史：UtaFormatix3（已不再使用）

早期版本的格式写出模块以 UtaFormatix3 的模板为骨架，参考实现放在
`app/server/core/formats/`。

**该架构已整体删除** —— 格式转换现在交给 LibreSVIP（40 种格式），不需要自己写
reader/writer，因此不再使用 UtaFormatix3 的任何代码或素材。

保留此段只为说明历史来源。若日后重新引入相关代码，需恢复 Apache-2.0 署名：
<https://github.com/sdercolin/utaformatix3>

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
本程序**不收录**任何破解、激活器或盗版声库/编辑器的分发链接 —— 详见
`app/data/RESOURCES-README.md` 的收录原则。原因不是保守，而是这类资源在原理上
无法验证安全性（无数字签名、二次打包、常捆绑启动器），是木马和挖矿程序的高发区。

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