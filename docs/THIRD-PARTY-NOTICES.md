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

## 收录原则

本程序**不收录**任何破解、激活器或盗版声库/编辑器的分发链接 —— 详见
`app/data/RESOURCES-README.md` 的收录原则。原因不是保守，而是这类资源在原理上
无法验证安全性（无数字签名、二次打包、常捆绑启动器），是木马和挖矿程序的高发区。
