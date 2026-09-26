# 清沐的虚拟歌姬工作站 · QingMu's Vocal Workstation

> 这里本是清沐方便自己调音利用 ds 做的工作站。

给翻调 P 主用的本地工作台。零安装、零依赖、完全离线运行，把翻调流程里最零碎的几件事收在一个界面里：

1. **工程格式互转** —— 完全离线，批量、可选输出目录、转换前先告诉你哪些数据会丢
2. **MV 解析下载** —— B 站原生解析 + yt-dlp 覆盖 YouTube 等站点
3. **人声分离与音频处理** —— MVSEP 等站点直达 + 本地 ffmpeg 工具链
4. **资源导航** —— 立绘、插件脚本、能下 WAV 的音源站，**只存链接不占硬盘**

---

## 一、怎么启动

双击 **`启动工作站.bat`**。它会打开一个原生桌面窗口（C# + WebView2 外壳），不是浏览器标签页。

| 文件 | 用途 |
|---|---|
| `启动工作站.bat` | 启动（优先用桌面外壳；外壳不在时退回浏览器窗口模式） |
| `启动工作站（无窗口）.vbs` | 后台启动，不显示黑色控制台窗口 |
| `停止工作站.bat` | 停止后台服务 |
| `清沐的虚拟歌姬工作站.exe` | 桌面外壳本体，双击它也行 |

### 依赖

| 依赖 | 是否必需 | 说明 |
|---|---|---|
| **Node.js 20+** | **必需** | [官网下载](https://nodejs.org/zh-cn)。不需要 `npm install` —— 本项目自身零第三方依赖 |
| **LibreSVIP CLI** | **工程转换必需** | 40 种格式的转换引擎，见下 |
| WebView2 运行时 | 桌面外壳需要 | Win10 1803+ / Win11 自带（装了 Edge 就有），不用单独装 |
| ffmpeg / yt-dlp | 可选 | 视频下载与音频处理用，在「设置 → 外部工具」里一键获取 |
| .NET Framework 4.x | 仅编译外壳时需要 | Windows 自带 `csc.exe`，**不需要装 Visual Studio** |

### 配置 LibreSVIP（转换功能必需）

工程转换整个交给 [LibreSVIP](https://github.com/SoulMelody/LibreSVIP)（MIT 协议），它支持 40 种工程格式。

1. 下载 CLI 构建：`LibreSVIP-CLI-2.9.0.win-amd64.zip`
   <https://github.com/SoulMelody/LibreSVIP/releases/>
2. 解压，让路径长这样：

```
tools/
└─ libresvip/
   └─ libresvip-cli/
      ├─ libresvip-cli.exe
      └─ _internal/
```

放好后重启程序，「工程转换」页就会显示 40 种格式。**没放也能用**——只是转换页会退回内置的 9 种格式实现（能力弱得多）。

### 编译桌面外壳（可选）

桌面外壳用 **Tauri 2**（Rust），一份代码 Windows / macOS 都能出安装包。

```
powershell -ExecutionPolicy Bypass -File app\desktop\build.ps1           # 出 exe
powershell -ExecutionPolicy Bypass -File app\desktop\build.ps1 -Bundle   # 出 exe + MSI/NSIS
```

**前置**（仅 Windows 需要，macOS 装 Xcode Command Line Tools 即可）：

| 组件 | 装到哪 | 怎么装 |
|---|---|---|
| Rust | `H:\DevTools\`（可用环境变量改） | [rustup.rs](https://rustup.rs/) |
| MSVC 工具链 + Windows SDK | `H:\VSBuildTools` + `C:\Program Files (x86)\Windows Kits\10` | 见 `H:\DevTools\安装VC工具链.bat`（需管理员权限） |

> 脚本会自动加载 MSVC 环境（`vcvars64.bat`）—— 直接在普通终端跑 `cargo build` 会报
> `linker link.exe not found`，因为 `link.exe` 和 SDK 的库都需要那套环境变量。

编译产物在 `app\desktop\target\release\`，把它复制到根目录改名 `清沐的虚拟歌姬工作站.exe`
即可被 `启动工作站.bat` 直接使用。

没有 Node？启动器会明确告诉你，不会静默失败。

**关于应用窗口**：启动器用 Edge/Chrome 的 `--app` 模式打开一个没有地址栏和标签页的窗口，看起来就是个独立程序。
它使用**专属的浏览器配置目录**（`data/browser-profile`，首次启动会建，约 80MB）——必须这样，否则当你的 Edge 已经开着时，
新窗口会被当成"再开一个标签页"塞进现有浏览器里，就没有应用窗口的感觉了。这个目录可以随时删，下次启动会重建。

重复双击 `启动工作站.bat` 不会重复起服务、也不会开出好几个窗口：启动器会先探测端口，已在运行就只把窗口调出来。

> 如果双击后窗口一闪而过什么都没发生，最可能的原因是启动器文件的换行符被改成了 LF（Windows 批处理必须是 CRLF）。
> 用 `停止工作站.bat` 同级目录下的方式重新解压，或运行：
> `powershell -Command "$p='启动工作站.bat'; $t=[IO.File]::ReadAllText($p); [IO.File]::WriteAllText($p, ($t -replace \"`n\",\"`r`n\"), (New-Object Text.UTF8Encoding($false)))"`

---

## 二、功能说明

### 1. 工程转换（核心，完全离线）

转换由 **[LibreSVIP](https://github.com/SoulMelody/LibreSVIP) 引擎**执行，支持 **40 种工程格式**（配好 CLI 后界面里会全部列出）：

| 类别 | 格式 |
|---|---|
| VOCALOID | `.vsqx` `.vsq` `.vpr` `.vspx` `.vog` `.vvproj` `.xvsq` |
| Synthesizer V | `.svp` `.s5p` |
| UTAU / OpenUtau | `.ust` `.ustx` |
| ACE / AI 歌声 | `.acep` `.acet` `.ace` `.aisp` |
| 其它歌声编辑器 | `.ccs`（CeVIO）`.dv`（DeepVocal）`.dspx` `.ds`（DiffSinger）`.tlp` `.tlpx`（TuneLab）`.nn`（袅袅）`.mtp`（Muta）`.ps_project` `.ppsf` `.vshp` `.vfp` `.y77` 等 |
| 通用交换 | `.mid` `.musicxml` `.ufdata` `.json`（OpenSVIP） |
| 歌词 / 字幕 | `.lrc` `.ass` `.srt` `.svg` |

> 界面上「目标格式」一栏列出的就是它实际支持的全部格式，不会出现「列了但转不了」的情况。
> 没配 LibreSVIP 时程序仍可启动，但转换会退回内置的 9 种格式实现——**能力弱得多，建议一定配上**。

**这个程序在 LibreSVIP 之上做的事：**

- **失真预检**：转换前逐项列出「目标格式装不下哪些数据」。例如把含音高曲线的 SynthV 工程转成 MusicXML 时，会直接告诉你音高曲线、参数曲线会丢——而不是转完才发现白调了。
- **批量 + 可选输出目录 + 命名模板**：一次丢一堆工程进去，按模板命名，输出到指定目录。
- **转换前自动挂声库**：转成 `.vpr` 时，会**自动检测本机已装的 VOCALOID 声库**，按歌手名匹配 compID 写进工程。
  `Miku(V2)`、`初音ミク`、`miku_v4x` 都能匹配到本机的 `MIKU_V4X_Original_EVEC`；`洛天依` 会优先挑中文声库而不是日文声库；
  `镜音リン` / `鏡音リン` / `镜音铃` 这类繁简与中英日混写也会自动归一。
  没有这一步，转出来的工程在 VOCALOID 里歌手栏是空的，得手动再选一次。

  检测方式（**不依赖你把声库装在哪块盘**）：
  1. **读注册表**（首选）——VOCALOID 安装声库时会登记到 `HKLM\SOFTWARE\...\VOCALOID4\DATABASE*` 与 `VOCALOID5/6\...\Components`，
     里面直接写着 compID、安装路径和官方名称。这是最可靠的来源；
  2. 扫常见目录兜底（`H:\VoiceDB`、`C:\ProgramData\VOCALOID6\VoiceDB` 等），覆盖便携版/手动拷贝的声库；
  3. 都找不到时，在**「设置 → 声库目录」里手动指定**声库根目录 —— 添加前会先试探该目录并告诉你找到几个，
     不会等你加完才发现是空目录。同一页还有「试匹配歌手名」，可以直接验证某个歌手名能不能对上本机声库。
- **批量转换**：整目录收集、批量排队、逐个报告结果。
- **自定义输出目录 + 文件名模板**：`{name}_{format}_{date}` 这类模板，可用 `{index}` `{track}` 等变量。
- **每轨拆分导出**：多轨工程一键拆成多个单轨工程。
- **后期处理管线**（在任何格式转换之上叠加）：
  - 转调（音高曲线同步移动，参数曲线不受影响）
  - 歌词改写：假名 ↔ 罗马音、平假名 ↔ 片假名、**中文 → 拼音**（内置 26711 字拼音表，无声调；多音字取常用读音）
  - **VCV 化 / CV 化**：自动给 UTAU 连续音加前一个元音前缀，或反向去掉
  - 节奏量化、速度重设、整体平移、音域适配、限制音高范围
  - 清理过短音符、合并连续同音、按音高拆轨、合并全部轨道
  - 参数曲线重采样/丢弃（目标格式不支持时避免产生垃圾数据）

### 2. MV 解析下载

- **B 站**：原生实现，不依赖 yt-dlp。支持 BV 号、av 号、b23.tv 短链、分 P、合集、番剧（ep/ss）。
  - 带 WBI 签名（不签名会被风控拒绝，这是很多同类工具失效的原因）
  - DASH 流解析，可选画质与编码（默认优先 H.264，兼容性最好；HEVC 在老软件里常打不开）
  - 可同时保存**封面、弹幕 XML、官方字幕（转 SRT）**
  - **未登录只能拿到 480P**：在「设置 → 视频下载」里填入浏览器 Cookie（`SESSDATA`）即可解锁 1080P+ / 大会员画质
- **YouTube 及其它上千个站点**：走 yt-dlp（需在设置里一键获取）。**注意**：部分网络环境访问 YouTube 需要代理，在设置里填代理地址后 yt-dlp 会走代理。
- 下载用多线程分块 + 断点续传；装了 ffmpeg 会自动把音视频合并成 mp4，没装则保留分离的流并给出提示。

### 3. 音频工具

- **在线人声分离**：MVSEP 等站点一键跳转（明确提示：在线服务需要把音频传到对方服务器）
- **离线人声分离**：引导启动本机的 UVR（如果检测到），音频不出本机
- **本地 ffmpeg 工具链**：导出 WAV/FLAC/MP3、从视频提取音频、变调（半音）、变速（倍率）、裁剪、响度标准化

### 4. 资源导航

分类整理：人声分离 / 免费音源（标注**能否下 WAV**）/ 歌姬立绘与授权规约 / 编辑器官方获取渠道 / 插件与工具 / 教程文档 / 安全提示。

**关于「破解版 / 学习版」**：本库**不收录**任何破解、激活器、网盘转载的盗版声库或编辑器链接。原因不是保守，而是这类资源在原理上无法验证安全性——无数字签名、二次打包、常捆绑启动器，是木马与挖矿程序的高发区。取而代之的是：把官方、免费、开源、试用渠道整理齐全（覆盖了翻调绝大多数需求），并给出一张「想用付费编辑器的某功能 → 免费方案怎么做」的对照。所有链接都经过 HTTP 校验并标注了来源域名与可信度。

---

## 三、目录结构

```
工作站/
├─ 启动工作站.bat / .vbs / 停止工作站.bat   启动器
├─ app/
│  ├─ server/            后端（Node 原生，无依赖）
│  │  ├─ index.mjs       HTTP 服务 + API 路由
│  │  ├─ core/           转换引擎、IR、变换算子、任务管理
│  │  │  ├─ IR-SPEC.md   中间表示规范（加新格式看这个）
│  │  │  ├─ formats/     各格式读写模块
│  │  │  └─ selftest.mjs 自测框架
│  │  ├─ net/            HTTP / 下载器 / B站 / yt-dlp
│  │  └─ data/           资源库数据、拼音表、配置
│  └─ web/               前端（原生 ES 模块 + 手写 CSS）
├─ docs/                 开发文档（格式模块契约、UI 规范）
├─ tests/                样本与人工测试脚本
├─ tools/                外部工具（yt-dlp / ffmpeg 按需获取到这里）
├─ output/               默认转换输出目录
└─ downloads/            默认视频下载目录
```

---

## 四、常见问题

**Q：转换按钮点了没反应 / 提示找不到服务**
后台服务已停止。重新双击 `启动工作站.bat`。界面左下角有连接状态指示。

**Q：提示「未找到 ffmpeg」**
「设置 → 外部工具」点「一键获取」（约 40MB，下载到 `tools/`）。或自己去 [gyan.dev](https://www.gyan.dev/ffmpeg/builds/) 下载，把 `bin` 文件夹放到 `tools/ffmpeg/`。

**Q：B 站只能下 480P**
填入 Cookie。浏览器登录 B 站 → F12 → Application → Cookies → 复制 `SESSDATA` 的值，粘到设置页。

**Q：转换后的工程在目标编辑器里打不开**
请把这个文件的情况告诉我（源格式 → 目标格式），格式模块需要按真实样本校正。可以用「预检所选文件」先看报告。注意 `.ust` 写出为 UTF-8，老版 UTAU（飴屋版）只认 Shift-JIS，建议用 OpenUtau 打开。

**Q：我的工程会上传到网上吗？**
不会。转换全部在本机进程内完成。只有「视频下载」和「音频工具里的在线人声分离跳转」会联网。

---

## 五、开发与扩展

- 加一个新格式：读 `docs/FORMAT-MODULE-BRIEF.md`，照着 `app/server/core/formats/midi.mjs` 写一个模块，放进 `formats/` 目录并登记到 `formats/index.mjs`。
- 前端视图规范：`docs/UI-KIT.md`

### 自测命令

| 命令 | 作用 |
|---|---|
| `node app/server/core/selftest.mjs` | 全部格式的往返自测（读真实样本 + write→read 比对） |
| `node app/server/core/selftest.mjs svp` | 只测某个格式 |
| `node app/server/core/fidelity.test.mjs` | **校验 `fidelity.preserves` 声明与实际往返行为是否一致**（查虚假承诺/虚假警告） |
| `node app/server/core/transform.test.mjs` | 变换算子自测（转调、歌词、VCV、量化…） |
| `node app/server/net/download.test.mjs` | 下载器自测（多线程分块的 SHA256 完整性、Range 降级） |
| `powershell -ExecutionPolicy Bypass -File tests/manual/ui-smoke.ps1` | 用无头浏览器真实加载 6 个视图，检查渲染与报错 |
| `node tests/manual/bili-test.mjs BV1xxxxxxxxx` | B 站接口联调（WBI 签名、DASH 流、弹幕） |
| `node app/server/data/check-links.mjs` | 资源库链接校验（生成报告） |
| `node app/server/data/apply-link-report.mjs` | 把校验报告回填进 `resources.json` |

> `fidelity.test.mjs` 是这个项目里最值得保留的一个测试：界面上的「哪些数据会丢」提示完全依赖
> `fidelity.preserves` 声明，声明一旦和实际行为不符，用户就会按错误信息做决策（要么以为调好的东西还在，
> 要么以为要丢而白白重调）。它会把两种偏差都报出来。

---

## 六、它做不到的事（别踩坑）

- **不做音频渲染**：这是工程数据转换工具，不合成歌声。要出声音得用对应编辑器。
- **不做扒谱**：没有「音频 → 音符」的识别功能。
- **参数曲线不是全格式通用**：VOCALOID 的 PIT/BRE/BRI、SynthV 的音高偏差、CeVIO 的参数各自语义不同，能映射的会映射，映射不了的会在预检里列出来。
- **UTAU Shift-JIS**：纯 Node 无法生成 Shift-JIS（Windows 下可走 PowerShell 转码，见 `ust.mjs` 的说明），默认写 UTF-8。
- **ACE Studio / DeepVocal 的工程格式**：`.acep` 是加密压缩容器、`.dv` 是二进制容器，都没有公开规范，本机也没有可核对的样本。
  这两个格式被**如实标记为不支持**（而不是写出一个打不开的文件）。如果你能提供一个真实的 `.acep` / `.dv` 工程放进
  `tests/samples/`，读取功能可以补齐。
- **抖音/快手/小红书**：这些平台的接口需要 JS 签名，本程序不内置绕过方案；yt-dlp 能支持的部分会自动走 yt-dlp，不支持的会明确报错。
- **资源库不含盗版**：不收录破解版/学习版声库编辑器的分发链接。原因见界面里的安全提示——这类压缩包在原理上无法验证安全性。
