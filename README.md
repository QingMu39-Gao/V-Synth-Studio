# V-Synth-Studio

**翻调用的桌面工作台。** 从「我想翻这首歌」到「工程能交给声库唱了」，中间那些琐碎活儿
—— 找伴奏、下 MV、扒工程、转格式、取歌词、做歌词视频 —— 全在这一个窗口里做完。

> 原名「清沐的虚拟歌姬工作站」，2026-09 更名。作者署名 QingMu39（不是软件名）。

**下载安装包**：<https://github.com/QingMu39-Gao/V-Synth-Studio/releases/latest>

---

## 目录

- [这是什么](#这是什么)
- [安装](#安装)
- [上手：一条完整的翻调流水线](#上手一条完整的翻调流水线)
- [九页功能](#九页功能)
- [关于「破解版 / 学习版」](#关于破解版--学习版)
- [运行要求与体积](#运行要求与体积)
- [从源码编译](#从源码编译)
- [二次开发 / 改代码](#二次开发--改代码)
- [分发与授权](#分发与授权)

---

## 这是什么

一个**完全离线**的 Windows 桌面程序。所有处理都在你本机跑，工程文件、音频、
歌词都不上传到任何地方 —— 唯一的例外是「视频解析」和「在线音轨分离」，
它们本来就要去 B 站 / MVSEP 取东西，用不用由你决定（离线那条路一直都有）。

技术上是一个 Tauri 程序：原生窗口 + 内嵌的本地 HTTP 服务（Rust 写的），
界面是 React。**运行时不需要 Node、Python、VC++ 运行库**，
唯一的前置条件是 WebView2（Win11 和较新的 Win10 都自带）。

---

## 安装

1. 打开 <https://github.com/QingMu39-Gao/V-Synth-Studio/releases/latest>
2. 下载 `V-Synth-Studio_1.2.0_x64_zh-CN.msi`（约 183 MB），双击安装。

装完直接能用，不联网也行。

**配置存在哪儿？** 安装版放在 `%APPDATA%\com.qingmu.vocalworkstation\`。
如果你把程序整个文件夹拷到 U 盘或别的机器上跑（绿色版），配置就跟着文件夹走
（`app\data\`）—— 判断依据是「那个目录能不能写」，你不用管。

> 万一启动就闪退，去看 `%APPDATA%\com.qingmu.vocalworkstation\desktop-error.log`，
> 错误提示里会写出真实路径。

---

## 上手：一条完整的翻调流水线

下面是一条真实会走的路，每一站对应左侧栏的一页。你不必全走，挑需要的用。

**① 找到伴奏** —— 打开「音轨分离」，把原曲拖进去，选「二轨（UVR MDX）」，
十几分钟后拿到人声和伴奏两条 WAV。不想把音频传到网上就用这个（第一次要先下
引擎和模型，见下）；不介意上传的话，同一页右边还有「在线 MVSEP」那条路。

> 第一次用离线分离要下两包东西：**运行时**（压缩包 4.7 GB，解压 7.4 GB）和
> **模型**（压缩包 462 MB，解压 730 MB）。下完就一直在了，升级程序也不用重下。
> 网慢的话可以中途「暂停」，它会把已经下好的部分留在磁盘上，下次**接着下**
> （关掉程序再打开也认）。不想留了就点「删除全部依赖」一次清干净。

**② 顺手拿素材** —— 「视频解析」页贴 B 站链接，下 MV 画面、封面、弹幕、字幕。
「音频工具」页拿 ffmpeg 转格式、裁剪、变调变速、响度归一化。

**③ 弄到工程文件** —— 两条路：
- 手上有别人的工程（`.vsqx` / `.ustx` / `.svp` …）→「工程转换」直接转成你要的编辑器格式；
- 只有 MIDI 或没有工程 →「资源库」里的 MIDIshow 之类下个 `.mid` 回来，一样能转成工程。

**④ 取歌词** —— 「网易云专栏」搜歌名，选中就能拿到歌词，双语一起导；
顺带能把**封面**和**歌曲音频**（mp3 直链）一起下下来。本地 `.lrc` 也能导入
（GBK 老文件自动识别）。导出 LRC 或 SRT。

**⑤ 做歌词视频** —— 「文字 PV」把上一步的歌词一键带进来，套模板、挑字体，
导出 MP4 或 PNG 序列。字体已经离线打包好了，不用联网。

**⑥ 开始调** —— 工程丢进你自己的编辑器（VOCALOID / SynthV / OpenUtau / …）。

---

## 九页功能

| 页 | 干什么 | 用什么做 |
|---|---|---|
| **总览** | 环境自检 + 常用入口 | — |
| **工程转换** | 40 种工程格式互转 | 内置 LibreSVIP CLI，纯离线 |
| **视频解析** | B 站原生解析 + yt-dlp 兜底（上千站点） | 可选下封面 / 弹幕 / 字幕；多线程分块 + SHA-256 校验 |
| **音轨分离** | 拆人声 / 伴奏 / 鼓 / 贝斯 / 钢琴 / 其它 | 在线 MVSEP（要上传）**或**离线内嵌引擎（不出本机） |
| **音频工具** | 格式转换、变调变速、裁剪、响度归一化、波形编辑 | 内置 ffmpeg |
| **网易云专栏** | 搜歌、取词、导 LRC/SRT、下封面、下歌曲 | 网易云官方接口，可选登录（手机号验证码或 Cookie） |
| **文字 PV** | 歌词做成动态歌词视频 / PNG 序列 | 内置 JIZURA，字体全离线 |
| **资源库** | 4 组 27 条：工程分享、免费音源、编辑器官网、UTAU 系开源 | 只收录链接，不转载文件 |
| **设置** | 外观与材质、路径、外部工具 | — |

工程转换支持的 **40 种格式**：

| 类别 | 格式 |
|---|---|
| VOCALOID | `.vsqx` `.vsq` `.vpr` `.vog` `.vspx` |
| Synthesizer V | `.svp` `.s5p` |
| UTAU / OpenUtau | `.ust` `.ustx` |
| CeVIO / ACE / DeepVocal | `.ccs` `.acep` `.dv` `.dspx` |
| 通用交换 | `.mid` `.musicxml` `.ufdata` |
| 歌词字幕 | `.lrc` `.ass` `.srt` `.svg` |

> 读工程是借道 LibreSVIP 导出的 `ufdata`（一种 JSON 中间格式）——
> 这样它支持的格式我们都能读，只需要解析一种结构。

**几个容易踩的点**：

- **网易云专栏**：搜索结果里标了「能下载 / 不能下载」。标 `VIP` 只是收费标签，
  **不等于下不了** —— 真正能不能下，按下「下载歌曲」那一刻才知道。碰上不能下的，
  换一条同名的再试（列表里那个「换一个能下的版本」就是干这个的）。
- **音轨分离的时长是估的**：进度条上的百分比按本机纯 CPU 实测线性外推，
  会长时间停在 90% 再跳到 100%。看到不动不用重试，底下有「已用时 N 秒」。
  装了 NVIDIA 显卡会快很多。
- **在线 MVSEP 会上传你的音频**，页面里写明了。不想上传就走离线那条。

---

## 关于「破解版 / 学习版」

资源库**不收录**任何破解、激活器、注册机、网盘转载的盗版声库或编辑器。

原因不是保守，而是这类东西在原理上无法验证安全性：没有数字签名、二次打包、
经常捆绑启动器，是木马和挖矿程序的高发区。而且翻调本来就有很多正经的免费选择
—— UTAU、OpenUtau、DiffSinger、NNSVS、VOICEVOX、NEUTRINO 这一批开源项目
资源库里都收了，零成本就能起步。

只收官方、开源与免费试用渠道。有永久黑名单，收录即等于协助侵权。

---

## 运行要求与体积

用户只需要 **WebView2 运行时** —— Win11 和较新的 Win10 都预装。

| 依赖 | 用户要装吗 | 说明 |
|---|---|---|
| WebView2 | **要**（多半已自带） | 唯一的硬依赖 |
| VC++ 运行库 | 不要 | 已静态链接 |
| Node.js | 不要 | 只在开发者编译前端时用 |
| Python | 不要 | 离线分离引擎自带一份便携运行时 |

**为什么安装包 183 MB？** 因为 ffmpeg、yt-dlp、LibreSVIP、JIZURA 与 2335 个字体
（合计约 340 MB 未压缩）都**随包分发**，装完不联网也能用。主要在国内使用，
让用户自己去 GitHub 下 ffmpeg 基本下不动。

**音轨分离的引擎和模型不在安装包里**，第一次用时按需下载（合计约 5.4 GB 压缩包）。
这不是偷懒：加上它们安装包会到 5 GB 以上，而且大部分人用不到。

---

## 从源码编译

需要 **Rust + MSVC 工具链 + Node**（Node 只在编译前端时用）。

```powershell
# ① 补齐两个大件（从本仓库 Release 的 assets-v1 附件下载，约 340 MB）
powershell -ExecutionPolicy Bypass -File app\desktop\fetch-tools.ps1

# ② 编译（它第一步会跑 npm run build 编前端，然后 cargo build，最后把 exe 复制到根目录）
powershell -ExecutionPolicy Bypass -File app\desktop\build.ps1

# ③ 双击运行
启动工作站.bat
```

`build.ps1` 是**唯一的构建入口**。常用参数：

| 参数 | 作用 |
|---|---|
| `-Release` | release 版（体积小、跑得快、无控制台窗口） |
| `-Bundle` | 出 MSI 安装包，要和 `-Release` 一起用 |
| `-SkipWeb` | 只编后端，跳过前端（改 Rust 时省几秒） |
| `-FetchTools` | 先补齐 `tools/` 与 JIZURA 字体 |
| `-NoCopy` | 编完不复制 exe 到根目录（CI 用） |

> ⚠️ **别直接用 `cargo build`** —— 它只编译、**不复制** exe，
> 根目录那个 `v-synth-studio.exe` 会悄悄停在旧版本，你会以为改动没生效。

只改前端的话，`build.ps1` 都不用跑：改完 `cd app\web-next; npm run watch`，
浏览器刷新即可（前端是每请求从磁盘读的，不编译进 exe）。

打 tag 推上去会由 GitHub Actions 自动出 MSI：

```
git tag v1.2.0 && git push origin v1.2.0
```

---

## 二次开发 / 改代码

**读 [`AGENTS.md`](AGENTS.md)。** 那份写的是看代码看不出来的东西：
架构为什么长这样、构建和验证的硬规矩、以及一张「踩过的坑」速查表
（zip 解析、子进程收尸、cmd 的中文、玻璃材质的坑都在里面）。

其他文档：

| 文档 | 内容 |
|---|---|
| [`AGENTS.md`](AGENTS.md) | 给开发者 / 智能体：架构、构建、验证、踩坑速查 |
| [`docs/FEATURES.md`](docs/FEATURES.md) | 每个功能怎么实现的、接口长什么样、实测数据 |
| [`docs/FRONTEND.md`](docs/FRONTEND.md) | 前端规范、页面约定、组件清单、接口契约坑 |
| [`docs/GLASS-HANDOFF.md`](docs/GLASS-HANDOFF.md) | 玻璃材质规范（动那部分代码前先读） |
| [`docs/LESSONS.md`](docs/LESSONS.md) | 界面上的历史取舍与踩坑来龙去脉 |
| [`docs/THIRD-PARTY-NOTICES.md`](docs/THIRD-PARTY-NOTICES.md) | 随包分发的第三方程序与许可 |

改完之后怎么验：

```powershell
# 起一个测试实例（端口 8891，别和正在用的实例打架）
$p = Start-Process -FilePath 'H:\工作站\v-synth-studio.exe' `
     -ArgumentList '--serve','--port=8891' -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 8

node tests\contract\verify.mjs 8891      # 接口契约，应 17/17
node tests\manual\next-smoke.mjs 8891    # 九页冒烟，应 9/9
cd app\desktop; cargo test --bins        # Rust 单测，应全绿

# 跑完记得停掉测试实例
$c = Get-NetTCPConnection -LocalPort 8891 -State Listen -EA SilentlyContinue | Select-Object -First 1
if ($c) { Stop-Process -Id $c.OwningProcess -Force }
```

---

## 目录说明

| 路径 | 说明 |
|---|---|
| `app/desktop/` | Tauri 外壳 + 内嵌 Rust 后端（构建脚本也在这里） |
| `app/web-next/` | 前端源码（React + Vite + TS） |
| `app/web/` | 前端产物 + 随包静态资源（后端伺服的就是这里） |
| `app/data/` | 资源库、拼音词典；绿色版的配置也落在这儿 |
| `tools/` | 随包分发：ffmpeg / LibreSVIP / yt-dlp（**不入库**，用 `fetch-tools.ps1` 补） |
| `tests/` | 契约测试、冒烟测试、样本 |
| `docs/` | 上面那几份文档 |
| `.github/workflows/` | CI：编译 + 打 MSI + 冒烟 |
| `资料归档/` | 上传 Release 用的大存档（**不入库**） |

仓库只有约 7 MB 源码，是有意为之 —— 大件都放在 Release 附件里，编译前补一次。

---

## 分发与授权

随包分发了几个独立的外部程序（FFmpeg / LibreSVIP / yt-dlp / JIZURA / 字体），
各自的许可与合规要求见 **[`docs/THIRD-PARTY-NOTICES.md`](docs/THIRD-PARTY-NOTICES.md)**。

> ⚠️ 当前 `tools/ffmpeg/` 是 **GPL v3** 构建。分发前请先读那份文档 ——
> 换成 LGPL 构建可以省掉大部分合规负担，而且不影响本程序的功能。
