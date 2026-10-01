# 工程转换 —— 交接文档（写给下一个对话）

> **状态：没修好。** 别在现在的实现上继续叠东西，先读完这一份。
> 上个对话（2026-10-02）修掉了「转换直接失败」的**表层**原因，但把转换做成了
> **「逐题回答 LibreSVIP 的交互提问」** —— 这**偏离了 LibreSVIP 设计的机器接口**，
> 于是留下了两个新问题：**音高参数不对**、**一多半工程仍然转换不了**。
> 这份文档把「已经确证的事实」和「我引入的偏离」分开写清楚，并给出正确的做法。

---

## 0. 一句话现状（实测，不是估计）

用 `tests/manual/convert-samples.mjs` 把素材里 16 个真 `.svp` 全转一遍：

```
合计：成功 10 / 16
失败原因分布：{"AttributeError: vsqx_name（上游导出器 bug）":5, "音符重叠":1}
```

- **5 个工程撞的是 LibreSVIP 自己的 bug**（不是我们的代码）。
- **1 个工程是源工程本身有音符重叠**，LibreSVIP 拒绝转换。
- 成功的 10 个里，**音高与 SynthV 里画的不一致** —— 因为默认走的是
  `音高信息输入模式 = PLAIN`（LibreSVIP 的官方默认，但它会丢掉大部分音高曲线）。

---

## 1. 怎么复现（照抄可跑）

```powershell
# 测试实例（8891，别用用户正在开的 17878）
$p = Start-Process -FilePath 'H:\工作站\v-synth-studio.exe' `
     -ArgumentList '--serve','--port=8891','--ui=next' -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 9

# 16 个样本一起转，打印成功/失败与原因
node tests\manual\convert-samples.mjs 8891

# 单个工程 + 指定选项（options 的键见第 4 节；这里用的是当前实现自造的键）
node tests\manual\convert-samples.mjs 8891 --only ウミユリ海底譚.svp `
     --options '{"export.vsqxVersion":"3"}'

# 收尾（必须）
$c = Get-NetTCPConnection -LocalPort 8891 -State Listen -EA SilentlyContinue | Select-Object -First 1
if ($c) { Stop-Process -Id $c.OwningProcess -Force }
Get-Process msedge -EA SilentlyContinue | Where-Object { $_.MainWindowHandle -eq 0 } | Stop-Process -Force
```

样本目录默认 `C:\Users\Administrator\Desktop\素材\sv`（**不在 git 里**，用 `--dir` 指定别的）。
输出默认落到 `%TEMP%\vss-convert-samples`（跑完可以删）。

**直接对着 CLI 复现上游 bug**（不经我们的后端）：

```powershell
$cli = 'H:\工作站\tools\libresvip\libresvip-cli\libresvip-cli.exe'
# 手工逐题回车/照抄括号默认值，或直接用 convert-samples.mjs 观察 traceback
& $cli proj convert 'C:\Users\Administrator\Desktop\素材\sv\ウミユリ海底譚.svp' 'H:\工作站\tmp-x.vsqx'
```

---

## 2. 三个真因（都有实测证据）

### 2.1 上游 bug：工程带参数曲线时，导出 VSQX 必崩（5/16）

```
AttributeError: 'VocaloidParameterDef' object has no attribute 'vsqx_name'
  libresvip/plugins/vsqx/vocaloid_controllers.py:100 in create_mctrl_list
      vsqx_param_id = param_def.vsqx_name if param_def else curve.name
```

- **位置**：`tools/libresvip/libresvip-cli/_internal/libresvip/plugins/vsqx/vocaloid_controllers.py:100`
  （这个文件在磁盘上是 **`.py` 源码**，可读；但核心包 `libresvip/model/vocaloid/controller_registry`
  是打进 exe 的 PYZ，**读不到**，所以不知道 `VocaloidParameterDef` 到底有哪些字段）。
- **触发条件**：源工程里有 **音量 / 力度 / 性别 / 气声** 这四类包络中的任意一类被导出为 VSQX 的
  mctrl 曲线，就会走到这一行并抛异常。
- **实测矩阵**（源：`ウミユリ海底譚.svp`，输出 vsqx）：

  | 选项 | 结果 |
  |---|---|
  | 全默认（四个包络都导入） | ❌ AttributeError |
  | `export.vsqxVersion=3`（换 VSQ3 生成器） | ❌ 同样崩 |
  | 只关「性别+气声」 | ❌ 照样崩 |
  | 只关「音量」/ 只关「力度」/ 只关「音量+力度」/ 只关「伴奏轨」 | ❌ 全部照样崩 |
  | **四个包络全关**（音量+力度+性别+气声） | ✅ 成功 |

  也就是说：**只要有一条这类曲线被导出就崩**，没有「少关一点」的中间地带。

**这意味着**：这个 LibreSVIP CLI 版本（`LibreSVIP-CLI-2.9.0.win-amd64`）**无法把参数曲线导出成 VSQX**。
正确的解法只有两条（第 5 节展开）：

1. **换一个修好的 LibreSVIP 版本**（首选；本机没验证过更新版本是否存在/是否修了，
   `H:\11111\Compressed\LibreSVIP-CLI-2.9.0.win-amd64.zip` 是当前这份的来源）。
2. **按插件自己的导入选项，把会崩的曲线关掉**（`导入音量包络` / `导入力度包络` /
   `导入性别包络` / `导入气声包络` = `false`）—— 转换能成功，但这四条曲线**没有带过去**，
   必须**明确告诉用户丢了什么**，不能静默。

> ⚠️ 不要去改那个 `.py`（把 `param_def.vsqx_name` 换成 `getattr(...)`）。
> 我考虑过：VSQX 的 mctrl 需要的是 VOCALOID 的参数 id（`DYN`/`VEL`/`BRE`/`GEN` 之类），
> 拿 `curve.name` 顶上去很可能写出**编辑器不认的参数曲线** —— 变成「转换成功但文件是坏的」，
> 比直接报错更糟。而且 `tools/` 不在 git 里，改了别人复现不了、升级就被覆盖。

### 2.2 音高不对：官方默认档 `PLAIN` 会丢音高（用户报「完全跑调」）

`plugin detail svp` 里这两个选项的**原文**（这是权威说明）：

```
音高信息输入模式 = PitchOption
  说明：本选项控制音高曲线被导入的范围和判定条件。其中「经过编辑」的定义为：
        参数面板中的音高偏差、颤音包络和音符属性中的音高转变、颤音中的任意一项经过编辑。
  默认值：PitchOption.PLAIN
    full    => 输入完整音高曲线
    vibrato => 仅输入已编辑部分（颤音模式）
    plain   => 仅输入已编辑部分（平整模式）

遵循即时音高模式设置 = bool  默认 True
```

**实测同一工程（`初音未来的消失.svp`）三档的体积与内容**：

| `音高信息输入模式` | 产物大小 | `<cc>`（控制器曲线）事件数 | 说明 |
|---|---|---|---|
| `plain`（当前默认） | **1002 KB** | 5,556 | 用户看到的就是这一档 → 音高与 SynthV 不一致 |
| `full` | **5918 KB** | 94,026 | 多出约 8.8 万个曲线点 |
| `vibrato` | 5918 KB | 94,026 | 与 full 同大小（**可疑，需要单独查**） |

> **注意**：`vibrato` 与 `full` 产物一样大，这一点**没有解释清楚**。
> 怀疑是「该工程所有音高都算『经过编辑』」导致两档结果相同。
> 换一个没有编辑过音高的工程再对比一次，能证伪或证实。

**还没做的事（下一个对话请先做这个）**：把源工程里画的音高与产物里的音高**逐点比**。
`.svp` 是 JSON，音高在 `tracks[].mainGroup.parameters.pitchDelta.points`
（以及每个音符的 `attributes`）。做法：

1. 用 `full` 和 `vibrato` 各转一份；
2. 把 `.svp` 的 `pitchDelta.points` 与 `.vsqx` 里的曲线点（`<cc>` 的 `<t>`/`<v>`）按 tick 对齐比较；
3. 结论写进本文档第 2.2 节，再决定**默认档**。

> **产品判断（供参考，未拍板）**：用户期望是「我在 SynthV 里画的音高要跟过去」，
> 那默认就该是 `full`。LibreSVIP 官方默认是 `plain`，**我们要不要偏离官方默认、偏离到什么程度，
> 属于要跟用户确认的产品决定**，别自己悄悄改（这个对话就是因为悄悄照抄默认值才出的问题）。

### 2.3 我引入的偏离：用「逐题回答交互提问」代替了 LibreSVIP 的机器接口

**LibreSVIP 自己设计的机器接口是 RPC**，不是 CLI 的交互提问。
证据在 `tools/libresvip/libresvip-cli/_internal/libresvip/res/protos/libresvip.proto`：

```proto
enum PluginCategory { INPUT = 0; OUTPUT = 1; MIDDLEWARE = 2; }
enum ConversionMode { DIRECT = 0; SPLIT = 1; MERGE = 2; }

message PluginInfo {
  string identifier = 1;  string name = 2;  string version = 3;  string description = 4;
  string author = 5;      string website = 6;
  string json_schema = 7;        // ← 插件选项的 JSON Schema（前端据此生成选项表单）
  string file_format = 8; repeated string suffixes = 9; string icon_base64 = 10;
}
message ConversionRequest {
  string input_format = 1;   string output_format = 2;
  ConversionMode mode = 3;   int32 max_track_count = 4;
  repeated ConversionGroup groups = 5;
  string input_options = 6;      // ← 选项走 JSON 字符串
  string output_options = 7;
  map<string, string> middleware_options = 8;
}
service Conversion { rpc PluginInfos(...); rpc Convert(...); }
```

启动方式：`libresvip-cli.exe rpc server --host 127.0.0.1 --port 15150`（gRPC）。

**我实际做的**（`app/desktop/src/libresvip.rs`）：spawn `proj convert`，
从 stdout 里认出「安静下来且结尾是冒号」的提问，**照抄提示里括号中的默认值**，
只在我自造的键命中中文关键词时才改成别的值。**问题**：

1. **默认值照抄 = 音高按官方默认 `plain` 走** → 就是 2.1/2.2 里那两个问题；
2. **选项表达不了**：只能用中文关键词碰运气匹配，题库、语言、顺序一变就失效；
3. `Options` 的**键名是我自造的**（`import.pitchMode` 这类），跟官方选项名没有任何关系，
   谁也不知道两边对不对得上；
4. 上游一崩，我们只能报「退出码 1 + 一坨 traceback」。

**这不是「乱改」——是「用了非官方路径、并且没有把选项当真传」**。
该改回官方路径（第 5 节）。

---

## 3. 我改了什么（逐条，标明性质）

提交：`73fab9f`（转换修复）、`ac1cccd`（单测）。`git show --stat` 可看全。

| 文件 | 改动 | 性质 |
|---|---|---|
| `app/desktop/src/libresvip.rs` | 删掉「喂 60 个空行」，改成交互式应答器（判断题 + 照抄括号默认值 + GBK 编解码 + 超时/题量上限 + `quiet_command`） | **权宜**（要换成官方 JSON 选项） |
| 同上 | 新增 `RULES`（我自造的键 → 中文关键词）与 `normalize_options` | **权宜** |
| 同上 | `convert(root, input, output, options: &Value)` 多了一个参数；`read_project` 传 `json!({})` | 必要（接口） |
| `app/desktop/src/server/convert.rs` | `run` / `run_upload` 读 `options` 并透传；**转换前 `create_dir_all(out_dir)`** | 读 options = 权宜；**建目录 = 必要**（LibreSVIP 不建中间目录，不建就 `FileNotFoundError`） |
| `app/desktop/src/server/simple.rs` | 新增 `CONVERT_UPLOAD_LIMIT = 96MB` | **必要**（axum 默认 2MB，base64 过的工程会超） |
| `app/desktop/src/server/mod.rs` | 两条 upload 路由挂 `DefaultBodyLimit` | 必要（同上） |
| `app/desktop/src/main.rs` | `.disable_drag_drop_handler()` | **必要**（Tauri 默认截走拖放，网页收不到 `drop`） |
| `app/web-next/src/pages/Convert.tsx` `.css` | 拖入 + 选择文件两种来源、预检改手动、选项面板（自造键） | UI 部分保留；**选项键要改成官方名字** |
| `app/desktop/src/libresvip.rs` 末尾 | 5 条单测（括号默认值、优先级、GBK 关键词、中间件自动开、判题） | 保留，但**测的是权宜实现** |

**用户原报的四条里，哪些是真的修好了**：

| 用户原话 | 状态 |
|---|---|
| 「文件选择逻辑很乱，只要拖入和选择两种」 | ✅ 已改（拖放区 + 选择文件，目录批量收集删了） |
| 「预检拖慢了很多进度」 | ✅ 已改（手动点「预检」才跑） |
| 「转换时冒出来很多窗口」 | ✅ 已改（`Command::new` → `quiet_command`，实测全后端只有这一处漏） |
| 「转换直接失败」 | ⚠️ **一半**：表层原因（空行喂 stdin → `Aborted`、输出目录不存在 → `FileNotFoundError`）已修；但**上游 bug 与音高默认档没解决** |
| 「可选项都没了」 | ⚠️ **一半**：面板回来了、值也真的传下去了，但**键名自造、默认档不对** |

---

## 4. LibreSVIP 的权威选项模型（照这个来，别自己起名字）

来源：`libresvip-cli.exe plugin detail <插件id>`（中文输出是 **GBK 编码**，
PowerShell 里要读 `StandardOutput.BaseStream` 原始字节再按 936 解码，否则全是问号）。

### 4.1 `svp` 插件（SynthV Studio，1.11.2）—— 输入选项

| 官方选项名 | 类型 | 默认 | 取值 |
|---|---|---|---|
| `导入音量包络` | bool | True | |
| `导入力度包络` | bool | True | |
| `导入音高曲线` | bool | True | |
| `导入伴奏轨` | bool | True | |
| `导入性别包络` | bool | True | |
| `导入气声包络` | bool | True | |
| `遵循即时音高模式设置` | bool | True | |
| `音高信息输入模式` | PitchOption | **PLAIN** | `full` 完整音高曲线 / `vibrato` 仅已编辑（颤音模式）/ `plain` 仅已编辑（平整模式） |
| `换气音符处理方式` | BreathOption | CONVERT | `ignore` / `keep` / `convert` |
| `音符组导入方式` | GroupOption | SPLIT | `split` 全部拆分为轨道 / `merge` 保留原始位置 |

`svp` 输出选项：`版本兼容性` = SVProjectVersionCompatibility，默认 `100`
（`100` = 兼容 SynthV Studio 1.9.0 及以下 / `135` = 1.10.0~1.11.2 / `182` = 2.0+）。

### 4.2 `vsqx` 插件（1.0.0，作者「科林」，来自 UtaFormatix3）

输入选项：`导入力度包络` / `导入性别包络` / `导入气声包络` / `导入音量包络` / `导入音高曲线` /
`导入伴奏轨`（bool，默认 True）、`合并音节`（bool，默认 **False**，说明「将拆分后的多音节歌词合并回独立的单词」）。

输出选项：

| 官方选项名 | 类型 | 默认 | 取值 |
|---|---|---|---|
| `VSQX文件版本` | VsqxVersion | `4` | `3` = VSQx 3 / `4` = VSQx 4 |
| `美化XML` | bool | True | |
| `默认语言` | VocaloidLanguage | `4` | `0` = 日本語 / `1` = 英语 / …（`plugin detail vsqx` 里是完整表） |

> 交互提问里还会问 `默认的CompID`、`默认歌手名称`，但 `plugin detail` 的**输入/输出选项表里没有它们** ——
> 猜测它们是**插件内部的附加问项**（不在 `json_schema` 里）。用 RPC 时如果发现传不进去，
> 就去 `plugin detail vsqx` 的完整输出里再核一遍，别猜。

### 4.3 中间件（`PluginCategory.MIDDLEWARE`，走 `middleware_options` map）

从交互提问里实测到 5 个（`plugin list` 的表格不带中间件分类，没列全）：

| 中间件（提问原文） | 追问参数（提问原文） |
|---|---|
| 启用 音高变调 中间件吗? | `1. 音高变化量 (0)` |
| 启用 工程缩放 中间件吗? | `1. 缩放系数 [1/1/2/1/…] (1/1)` |
| 启用 歌词发音转换 中间件吗? | 未探 |
| 启用 移除短的无声间隙 中间件吗? | 未探 |
| 启用 替换歌词 中间件吗? | 未探（旧前端有「原文/替换为」两个字段） |

### 4.4 我自造的键 ↔ 官方选项名（**改的时候照这张表换**）

| 我自造的键（前端 + `RULES`） | 官方选项名 |
|---|---|
| `import.volume` | `导入音量包络` |
| `import.dynamics` | `导入力度包络` |
| `import.pitch` | `导入音高曲线` |
| `import.accompaniment` | `导入伴奏轨` |
| `import.gender` | `导入性别包络` |
| `import.breath` | `导入气声包络` |
| `import.instantPitch` | `遵循即时音高模式设置` |
| `import.pitchMode` | `音高信息输入模式` |
| `import.breathMode` | `换气音符处理方式` |
| `import.noteGroup` | `音符组导入方式` |
| `export.vsqxVersion` | （vsqx 输出）`VSQX文件版本` |
| `export.prettyXml` | （vsqx 输出）`美化XML` |
| `export.language` | （vsqx 输出）`默认语言` |
| `middleware.*` | 中间件（`middleware_options`）的 5 个开关 |
| `transpose.semitones` / `scale.factor` | 中间件的追问参数 |

---

## 5. 下一步（按优先级，别再绕路）

### ① 换成官方接口：`rpc server` + JSON 选项（这是「严格遵循 LibreSVIP 实现逻辑」的正解）

- 起服务：`libresvip-cli.exe rpc server --host 127.0.0.1 --port 15150`（后台常驻一个进程，
  不要每次转换都起）。
- 用 `PluginInfos` 拿 `json_schema` → 前端据此生成选项表单（**选项名与取值都从 schema 来，
  不再有自造键**）。
- 用 `Convert` 传 `input_options` / `output_options`（JSON 字符串）+ `middleware_options`（map）。
  `mode` 还能顺带实现旧前端的 `splitTracks`（`SPLIT`）。
- **依赖问题（先解决这个再动手）**：Rust 侧要 `tonic` + `prost`（+ 代码生成要 `protoc`）。
  2026-10-02 核查过：cargo 缓存里**没有** `tonic`/`prost`/`protoc-bin-vendored`，
  机器上也没有 `protoc` → **需要联网**（本机 GitHub 要走代理 `http://127.0.0.1:7890`，
  上次试 `curl -x ... api.github.com` 没返回，代理是否在跑要先验）。
  - 如果联网不可行：**退一步**——保留交互应答，但把「答案」严格按第 4 节的
    **官方选项名与取值**来装配（先做这件事，成本很低，立刻能让选项「名副其实」）；
    同时把默认档改成用户期望的（见 ③）。
  - 还要注意：`json_schema` 能否从 CLI 侧离线拿到？`plugin detail` 只有人读的文本，
    **没有机器可读的 schema**。所以不走 RPC 就拿不到 schema —— 那就照第 4 节的表硬编码，
    并在 `docs/FEATURES.md` 里注明来源与版本（`LibreSVIP 2.9.0`），升级时要复核。

### ② 处理上游导出崩溃（5/16，必须给用户一个明确结果）

三条路，取舍要跟用户确认：

1. **升级 LibreSVIP CLI**（首选）。先确认有没有修掉 `vsqx_name` 的新版本，
   有就换掉 `tools/libresvip/`，然后重跑 `convert-samples.mjs` 看 16/16 是否成立。
   ⚠️ `tools/` 不在 git 里，换之前把旧包留一份（`H:\11111\Compressed\` 那份 zip 就是备份）。
2. **自动降级 + 明确告知**：转换失败且错误里含 `vsqx_name` 时，自动按 4.2 的输入选项
   关掉四个包络重试一次，日志里写清楚「这四条曲线没能带过去（上游 bug）」。
   **不要静默**，也不要谎报成功。
3. **导出成别的中间格式再转**（例如先转 `.ufdata`/`.ustx` 再转 vsqx）—— 没试过，
   属于「换条路绕开 bug」，值得在 ① 之后花十分钟试一次。

### ③ 定音高默认档（产品决定，要问用户）

建议默认 `full`，并在选项面板里把三档用**官方说明**写清楚（见 2.2 的原文）。
但**先做 2.2 里那个逐点比对**，用数据支撑这个决定。

### ④ 把「丢掉的东西」告诉用户

任何一次转换，如果因为上游 bug 或选项而丢弃了包络/音高，产物的日志里必须有一行
明确的「本次丢弃了什么」。

### ⑤ 保留（别再改坏）

- `quiet_command`（不然满屏控制台窗口）；
- 转换前 `create_dir_all(out_dir)`（不然 `FileNotFoundError`）；
- 两条 upload 路由的 `DefaultBodyLimit`（不然 base64 过的工程被 413 挡）；
- `main.rs` 的 `.disable_drag_drop_handler()`（不然网页收不到拖放）；
- 前端「拖入 + 选择文件」两种入口、手动预检。

---

## 6. 别再踩这些（都实测过）

| 别做 | 为什么 |
|---|---|
| 往 stdin 灌空行 | y/n 提问**不收空行**：会一直回 `Please enter Y or N`，把空行吃光后 `Aborted.`（退出码 1、无产物） |
| 在 `[...]` 候选里挑第一个 | `[1/1/2/1/1/2/5/…] (1/1)` 是按 `/` 切开的碎片，挑第一个必非法 → 一直重问 → Aborted |
| 试 `PYTHONIOENCODING=utf-8` / `PYTHONUTF8=1` | 试过，中文提示**照样是 GBK** |
| 用 `Command::new` 起 LibreSVIP | 它是控制台程序，每个文件弹一个黑窗（预检 + 转换 = 两个） |
| 用 PowerShell 的 `StandardOutput` 读它 | .NET Framework 的 `ProcessStartInfo` **没有** `StandardOutputEncoding`；要读 `StandardOutput.BaseStream` 原始字节再按 936 解码 |
| 用 `grep` 中文关键词去匹配 GBK 输出 | 必须先把字节按 GBK 解成 `String` 再 `contains`（现在 Rust 里用 `windows-sys` 的 `Win32_Globalization`，没引第三方编码表） |
| 改 `tools/libresvip/**/*.py` 去打补丁 | `tools/` 不在 git，改了别人复现不了、升级即失效；而且把 `vsqx_name` 换成 `curve.name` 很可能产出**编辑器不认的 mCurve** |
| 相信 `plugin list` 的表格 | 它是 GBK + 折行，且**列不出中间件**；要看选项用 `plugin detail` |

---

## 7. 证据与产物

| 东西 | 位置 |
|---|---|
| 16 个样本的转换结果 | 跑 `tests/manual/convert-samples.mjs 8891` 现出 |
| 三个工程的失败 traceback | 同上前提下看任务日志（`/api/jobs/get?id=…` 的 `logs`） |
| 音高三档产物 | `H:\工作站\tmp-matrix\消失-{plain(默认),full,vibrato}.vsqx`（临时的，重跑即可再有） |
| 新前端的转换页截图 | `tests/manual/out/convert-ui-flow.png`（拖放区 + 选项面板 + 手动预检） |
| CLI 的选项定义原文 | `libresvip-cli.exe plugin detail svp` / `plugin detail vsqx`（GBK） |
| 官方 proto | `tools/libresvip/libresvip-cli/_internal/libresvip/res/protos/libresvip.proto` |
| 相关的踩坑记录 | `docs/LESSONS.md` 末尾「工程转换：三个让…的真因」一节（**注意**：那一节写于「以为修好了」的时候，结论要跟本文档对齐后再引用） |

---

## 8. 一句话给下一个人

> 转换的**表层 bug 已经修完**（空行、目录、窗口），但**选项系统是自造的、且默认档会丢音高**，
> 上游还有 5/16 的导出崩溃。**先用第 4 节的官方选项名把选项系统改成名副其实，再决定
> 走不走 gRPC；崩溃那条必须先确认能不能升级 LibreSVIP，别去 patch 它的 `.py`。**
