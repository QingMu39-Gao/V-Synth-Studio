# RESOURCES-README —— 翻调工作站资源库数据说明

本目录下的 `resources.json` 是面向「翻调 P 主」（虚拟歌手翻唱调教师）的**资源库数据文件**，
由前端资源库视图读取并渲染成分组卡片列表。

所有链接都经过脚本逐个实测，`verified` 字段记录的是**真实探测结果**，不是人工填写的估计值。

---

## 1. 目录内文件

| 文件 | 归属 | 说明 |
| --- | --- | --- |
| `resources.json` | 数据 | 资源库数据本体，前端唯一读取的数据源 |
| `check-links.mjs` | 工具 | 链接校验脚本（零依赖，只用 Node 内置 `fetch`） |
| `apply-link-report.mjs` | 工具 | 把校验报告回填进 `resources.json` 的 `verified` 字段 |
| `RESOURCES-README.md` | 文档 | 本文件 |
| `build-pinyin.mjs` / `pinyin.json` / `config.json` | 其它模块 | 与资源库无关，请勿改动 |

> `check-links.mjs` 自身也支持 `--write` 回填，适用于快速维护；
> `apply-link-report.mjs` 是更稳妥的标准流程（先出报告、人工过目、再回填）。

当前 `resources.json` 为 **7 个分组 / 121 条条目**，全部带 `desc` 与 `official` 标记。

---

## 2. 数据结构

```jsonc
{
  "version": 1,
  "updatedAt": "2026-09-26",        // 最近一次校验日期
  "notice": "安全提示文案",           // 前端顶部横幅展示
  "verifySummary": {                 // 最近一次校验的汇总（由 apply 脚本写入）
    "checkedAt": "2026-09-26",
    "total": 121, "ok": 104, "warn": 17, "dead": 0, "passRate": 100
  },
  "groups": [ /* 见下 */ ]
}
```

### 2.1 `groups[]` —— 分组

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 分组唯一标识，前端 `icon` 与样式按此绑定，**改动需同步前端** |
| `name` | string | 分组标题 |
| `icon` | string | 图标名（如 `wave` / `music` / `image` / `app` / `puzzle` / `book` / `shield`） |
| `description` | string | 一句话说明这一栏解决什么问题 |
| `items` | array | 条目列表，可为空 |

当前 **7 个分组、121 条**（`icon` 沿用原有取值，未新增图标名）：

| `id` | 名称 | 条目数 | 定位 |
| --- | --- | --- | --- |
| `stem-separation` | 人声分离 / 伴奏提取 | 11 | 拆人声与伴奏（MVSEP 在线 + UVR/Demucs 离线） |
| `free-audio` | 免费音源 / 伴奏 / 素材音乐 | 18 | 可合法使用的音乐与音效，逐条标注能否下 WAV |
| `character-art` | 歌姬立绘 / 官方素材 / 音源资料 | 10 | 角色形象、声库一览、音源资料库（**不收规约条款页**） |
| `editors` | 编辑器获取（官方 / 免费 / 开源 / 试用） | 17 | 只收正规渠道 |
| `plugins` | 第三方脚本与插件 | 47 | **本库重点**：SynthV 脚本 / OpenUtau 插件与引擎 / VOCALOID Job Plugin / UTAU 工具 |
| `learning` | 教程与文档 | 8 | 官方文档与手册；社区入口用**搜索页**而非单个视频 |
| `safety` | 安全提示 | 10 | 盗版风险说明 + 官方查毒入口 |

> 原 `free-alternatives`（免费替代方案）分组已按用户要求**整组删除**，
> 其内容与 `editors`／`plugins` 重复，不再单独成栏。

### 2.2 `items[]` —— 条目

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | string | 条目唯一标识，分组内不可重复 |
| `name` | string | 显示名称 |
| `url` | string | 主链接（会被校验） |
| `home` | string | 域名，用于卡片上显示来源 |
| `tags` | string[] | 标签。`free-audio` 分组**必须**含 WAV 相关标签 |
| `region` | string | 仅三选一：`国内` / `海外` / `均可` |
| `cost` | string | `免费` / `部分免费` / `付费` |
| `official` | boolean | **`true` = 官方或开源项目官方仓库；`false` = 社区/个人项目** |
| `desc` | string | 对翻调工作流的**实际价值**（为什么推荐、怎么用、有什么限制），不写「这是一个音乐网站」这类空话 |
| `tip` | string | 可选。使用技巧、坑点、合规提醒 |
| `verified` | object | 见下节 |

### 2.3 `verified` —— 校验结果

```jsonc
"verified": {
  "status": 403,
  "checkedAt": "2026-09-26",
  "verdict": "warn",            // 由 apply-link-report.mjs 写入
  "note": "需浏览器访问"
}
```

`verdict` 三态：

| `verdict` | 含义 | 前端表现 |
| --- | --- | --- |
| `ok` | 探测正常（200/301/302/307/308） | 正常徽章 |
| `warn` | **需浏览器访问**（反爬/限流，链接本身有效） | 提示徽章 |
| `dead` | 失效（404/410/超时/DNS 失败） | 异常徽章，应尽快处理 |

---

## 3. 状态码分类规则（重要）

```
200 / 301 / 302 / 307 / 308   → 可达（ok）
403 / 401 / 405 / 429         → 需浏览器访问（warn）—— 这是反爬，不是死链
404 / 410                     → 失效（dead）
超时 / DNS 解析失败 / 连接失败  → 失效（dead）
其它 5xx                       → 存疑，需人工确认
```

### 为什么 403 不算失效

Musopen、Pixabay、Dreamtonics 官网、爱给网、Booth 这类**完全正常**的站点，
会对脚本请求返回 403 来拦爬虫。把 403 当死链会误删大量好资源，
所以统一标注为「需浏览器访问」。用户点开浏览器是能正常打开的。

### 关于本机网络

本机对部分海外站点存在**间歇性连接超时**（`UND_ERR_CONNECT_TIMEOUT`，同一 URL 可能第一次超时、第二次就 200），
`check-links.mjs` 因此内置了**最多 5 次退避重试**。
若某条确实长期不可达，宁可删除也不写入伪造状态。

以下站点在收录时因**长期不可达/无对应页面**而被剔除，未写入数据（并非站点本身有问题，换网络环境可自行补录）：

- `archive.org`（Internet Archive）—— 本机 DNS 解析到黑洞地址，多次重试均超时
- `openutau.com`（官网域名）—— 同上，官方 GitHub 仓库可用且已收录
- `bandcamp.com`、`openverse.org`、`commons.wikimedia.org`、`incompetech.com` —— 持续连接超时
- `resource.dreamtonics.com/script/` 与 `utaformatix.dreamtonics.com` —— 分别返回 404 与 DNS 解析失败
  - 更正（2026-09-26 复核）：脚本手册的实际路径是 **`resource.dreamtonics.com/scripting/`**（无 `/script`），
    已作为 `plugins/dt-scripting-manual` 收录；
  - `sv2.docs.dreamtonics.com`（SynthV Studio 2 官方文档站）对脚本请求返回 403，浏览器正常，可自行访问。

---

## 4. 维护方式

### 4.1 标准校验流程

```powershell
# 1) 校验全部链接，生成报告
node app/server/data/check-links.mjs --report app/server/data/_report-final.json

# 2) 过目报告后，回填 verified 字段
node app/server/data/apply-link-report.mjs app/server/data/_report-final.json
```

校验报告 `_report-final.json` 是**中间产物**，仓库里不保留；重新校验会再次生成它，
`apply-link-report.mjs` 默认就是读这个路径，所以两步可以照上面直接跑。

### 4.2 常用参数

```powershell
node check-links.mjs                          # 只校验并打印汇总（有失效/存疑时退出码 1）
node check-links.mjs --write                  # 校验并直接回填（退出码 0）
node check-links.mjs --urls probe.txt         # 只探测候选清单，不动数据
node check-links.mjs --timeout 18000 --concurrency 4   # 网络差时放慢、加长超时
node check-links.mjs --report out.json --json # 导出报告并打印 JSON
```

候选清单格式（每行一条，`#` 开头为注释）：

```
id | url | 名称
mvsep | https://mvsep.com/zh | MVSEP
```

### 4.3 新增条目

1. 在对应 `groups[].items[]` 中按 2.2 的字段补一条，`id` 取小写短横线形式且组内唯一；
2. `verified` 可先留空对象，交由校验脚本回填（**不要手写猜测的状态码**）；
3. 跑 4.1 两步，确认该条 `verdict` 为 `ok` 或 `warn`；
4. 若为 `dead`，**删除或替换该条**，不要留着凑数。

**招募第三方脚本/插件前，先确认它是真的存在**：先搜索、再打开作者仓库/发布页看 README 与最近提交时间，
最后才写进数据。不要凭印象拼仓库名——写错的链接会直接变成死链。

### 4.4 新增分组

`groups[]` 追加对象，`id`/`icon` 需与前端约定一致；分组顺序即前端展示顺序。
前端对未识别的 `icon` 会回退到 `library`，但**新增分组前先确认这一栏真的值得单独成栏**。

---

## 5. 收录原则

1. **只收官方、开源、免费或官方试用渠道。**
   绝不收录破解版、学习版、激活器、注册机，以及网盘转载的盗版声库与编辑器。
   这类压缩包是木马与挖矿程序的主要投放渠道（详见 `safety` 分组）。
2. **不收录盗版分发渠道（明确黑名单）。**
   以下站点属于盗版声库／破解编辑器的分发渠道，**永久不收录、也不作为「替代方案」间接推荐**：
   瑟狐下载站、`pan.vocaloid.world`、`vocakey`（vocakey.wikidot.com）。
   理由有两条：一是收录即等于协助侵权；二是这类来源无法验证安全性
   （无数字签名、二次打包、常带启动器 exe），与 `safety` 分组的结论直接冲突。
3. **以「一个想调音的 P 主会不会主动点它」为取舍标准。**
   利用規約 / 使用条款 / Terms / 帮助中心 / 支持页 / 论坛首页 / 纯产品营销页 → **不收**；
   真正能学到东西的教程（官方手册的具体章节、入门教学、调声教程）→ 收。
   条款类信息会随时更新，需要时请到各版权方官网现查，静态收录反而会误导。
4. **`desc` 必须写实际价值。** 说明对翻调工作流有什么用、有什么限制，
   不写「这是一个 XX 网站」这类没有信息量的话。
   插件类条目尤其要写清**它具体解决哪个调音环节的什么问题**（音素/歌词转换、音高与颤音、
   批量参数、拆音、原音设定……），而不是「这是一个插件」。
5. **每条都要能说出来源性质。** 官方项目（作者本人／官方组织）标 `official: true`，
   社区/个人项目标 `false`，不要含糊。
6. **宁缺毋滥。** 校验不通过的条目直接删除，不用失效链接凑数量。
   宁可 15 条真的，不要 30 条假的。
7. **不伪造状态。** 确实无法访问的条目，如实记录或剔除，不为了让数据好看而写假状态码。

---

## 6. 数据现状（2026-09-26 校验）

- 分组 **7** 个，条目 **121** 条，全部带 `desc` 与 `official` 标记
- 校验结果：**正常 104 / 需浏览器访问 17 / 失效 0**，可用率 100%
  （`warn` 均为 403 反爬，Dreamtonics 官网、Musopen、Pixabay、爱给网等，浏览器打开正常）
- `plugins`（第三方脚本与插件）共 **47** 条，按来源分五块（组内也按这个顺序排列）：
  1. **通用工具** 6 条——vLabeler、UtaFormatix、WORLD/pyworld、RVC/so-vits-svc；
  2. **Synthesizer V 脚本** 19 条——官方脚本仓库与 API 手册、真实唱法参数迁移、
     歌词转音素／批量歌词编辑、跨语言发音词典（中日韩 + 方言）、音高曲线自动生成、自动和声；
  3. **OpenUtau** 6 条——官方仓库的插件/引擎机制、词典编辑器、多语言 YAML 词典、
     日语↔韩语与中文↔日语 phonemizer、粤语插件；
  4. **VOCALOID Job Plugin** 6 条——跨语种词典 + 批量歌词改写、和声生成、
     音符参数同步复制、Job Plugin 开发辅助与中文 API 文档；
  5. **UTAU 原音设定 / 音源工具** 10 条——setParam 原音设定、moresampler2、ENUNU、
     oatsu 插件集、批量包络编辑、CVVC/VCCV 拆音、utau-kua、vLabeler 重叠检查、Vocal2Midi、utsu。
- `free-audio` 共 18 条，其中明确标注能否下载 WAV 的条目以 `WAV 可下` / `WAV 不提供` / `WAV 需会员` 等标签标出
- 本次改造删除了 `free-alternatives` 分组，以及 25 条规约／条款／支持页／论坛首页／营销页类条目（另有 1 条重复条目合并）
