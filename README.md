# V-Synth-Studio —— **一个专为 P 主制作的本地工作站。**

> ## ⚠️ 完全测试版（Beta）
>
> **全部功能都还在测试与调整中**：可能有 bug、接口可能改动、极端情况下可能丢数据。
> **用之前请先备份工程文件**，别把它当成唯一的工作副本。
> 遇到问题欢迎到 Q 群（设置 → 关于）或 [Issues](https://github.com/QingMu39-Gao/V-Synth-Studio/issues) 反馈。

## 功能

| 页面 | 做什么 |
|---|---|
| 总览 | 环境检测（外部工具、扩展包装没装）与常用入口 |
| 工程转换 | **40 种工程格式互转**，批量、可选输出目录，转换前先告诉你哪些数据会丢 |
| 视频解析 | B 站原生解析 + yt-dlp 兜底（YouTube 等上千站点）；封面 / 弹幕 / 字幕，多线程分块下载，试听先缓存 |
| 音轨分离 | 拆人声 / 伴奏 / 鼓 / 贝斯 / 钢琴 / 其它；在线 MVSEP 或本地引擎。**A 卡 / 核显走 DirectML，N 卡走 CUDA** |
| 人声转 MIDI | 干声扒谱导出 `.mid`。GAME 的算法重写进 Rust，进程内推理、无子进程；有 N 卡时自动走 GPU |
| 音频工具 | 格式转换、变调变速、裁剪、响度归一化、波形编辑（基于 ffmpeg） |
| 网易云专栏 | 搜歌、取词、导 LRC/SRT、下封面、下歌曲（**可选下载音质**，服务端降级时如实上报实际档位）；可选登录：手机验证码或 Cookie，带会员标签与登录态自动续期 |
| 文字 PV | 歌词做成动态歌词视频 / PNG 序列（内置 JIZURA，离线可用） |
| 资源库 | 工程分享、免费音源、编辑器官网、UTAU 系开源 —— **只收录链接**，不转载文件 |
| 设置 | 玻璃材质 / 主题 / **背景壁纸** / 路径 / **扩展包目录** / 外部工具 / 关于（含检查更新） |

**背景壁纸**：可以把你自己 Steam 库里 Wallpaper Engine 的壁纸当界面背景（场景 / 视频 / 图片
都行）。只读你本机已有的文件 —— 不下载、不打包、不上传任何壁纸；场景壁纸在沙箱 iframe 里
渲染，壁纸自带的脚本碰不到程序本体。

## 安装

到 **[Releases](https://github.com/QingMu39-Gao/V-Synth-Studio/releases/latest)** 下载：

- `v-synth-studio_x.y.z_x64_zh-CN.msi` —— Windows，双击安装（推荐）
- `v-synth-studio_x.y.z_x64-setup.exe` —— 同一个程序的 exe 安装程序，按用户安装、不需要管理员
- `v-synth-studio_x.y.z_aarch64.dmg` —— macOS（Apple Silicon / M 系列），拖进「应用程序」
- `v-synth-studio_x.y.z_amd64.deb` —— Linux（x86_64，Debian 系），`sudo apt install ./…deb` 或双击由软件中心装

> 安装包**没有代码签名**：Windows 第一次运行会看到一次 SmartScreen 提示，点「更多信息」→「仍要运行」；
> macOS 是 ad-hoc 签名，第一次要**右键 →「打开」**（或到「系统设置 → 隐私与安全性 →「仍要打开」」）；
> Linux 的 deb 不签名，装的时候 apt 会按 control 里的依赖自动拉齐 webkit2gtk 等运行库
> **和 ffmpeg** —— Linux 版的 ffmpeg 不随包、用系统仓库的版本（`dpkg -i` 手装没拉依赖的话，
> `sudo apt install ffmpeg` 补上即可）。
>
> **macOS / Linux 版暂时没有这两样**：背景壁纸（Wallpaper Engine 只有 Windows 版）与
> 离线音轨分离引擎（运行时是 Windows 专属）。界面上它们会置灰并写明原因；
> 在线 MVSEP 与其余功能不受影响。
>
> **显卡加速**：Windows 的 A 卡 / 核显走 DirectML、N 卡走 CUDA，Linux 的 N 卡走 CUDA，
> macOS 没有 CUDA、只有 CPU。另外 macOS / Linux 没有统一的回收站 API，「删除」即彻底删除。
>
> 装完只有「外部工具」是齐的。**音轨分离**和**人声转 MIDI** 的引擎与模型不随包分发（合计约
> 8 GB，其中模型权重是非商业许可、不允许随源码分发）——在对应页面点「安装扩展包」按需下载，
> 支持暂停与续传，也能一键删除。
>
> 这些包放在本仓的 [release `modules`](https://github.com/QingMu39-Gao/V-Synth-Studio/releases/tag/modules)
> 上（runtime 是 6 卷分卷上传，程序自己按卷下、拼起来解）。GitHub 的 release 在国内常连不上，
> 所以程序会先按 <https://git.hiwiki.org/zh-CN/mirrors> 的名单在**本机**实测几面镜像、
> 挑最快的那面下；想强制走 GitHub 直连，设环境变量 `VSS_GH_MIRROR=off`。
>
> **下得慢就自己去网盘下**：两个页面在下载按钮下面都留了一行 123 云盘的链接。那份是压缩包，
> **不用先解压** —— 丢到界面上写明的那个目录（扩展包根）下就行，按钮会自己变成「解压」，
> 点了就地解开、不再联网；在「设置 → 扩展包目录」里改了落点，那行提示里的路径也跟着变。
>
> **这 8 GB 装在哪可以自己选**：第一次点「安装扩展包」时会问一次（也能随时在
> 「设置 → 扩展包目录」里改），C 盘紧张就把它们放到别的盘。换目录**只改落点、不搬文件**，
> 原位置里那份会留在那儿、由你自己清掉。

## 许可

**GPL-3.0**（GNU 通用公共许可证第 3 版）—— 全文见 [`LICENSE`](LICENSE)。

可以自由使用、修改、再分发；**再分发（含修改版）时必须同样以 GPL-3.0 开放源码**。

随包分发的外部工具与库（FFmpeg / LibreSVIP / yt-dlp / JIZURA 与字体 / webwallgl 等）
**各自独立授权**、不属于本许可证覆盖范围，逐项说明见
[`docs/THIRD-PARTY-NOTICES.md`](docs/THIRD-PARTY-NOTICES.md)。

## 致谢

感谢所有赞助者与测试者 —— 完整的感谢名单在程序里的「设置 → 关于」。

「歌词」页的**歌曲下载**与**网易云账号**两块参考了
[FusionMusicPlayer](https://github.com/Janson20/FusionMusicPlayer)（GPL-3.0）的做法
（照做法自行实现，未拷贝其代码），逐项说明见
[`docs/THIRD-PARTY-NOTICES.md`](docs/THIRD-PARTY-NOTICES.md)。

这个项目由 DeepSeek、Claude 等智能体辅助开发。
