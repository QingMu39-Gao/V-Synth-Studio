# RESOURCES-README —— 翻调工作站资源库数据说明

本目录下的 `resources.json` 是面向「翻调 P 主」（虚拟歌手翻唱调教师）的**资源库数据文件**，
由前端资源库视图读取并渲染成分组卡片列表。

所有链接都经过脚本逐个实测，`verified` 字段记录的是**真实探测结果**，不是人工填写的估计值。

---

## 1. 目录内文件

| 文件 | 归属 | 说明 |
| --- | --- | --- |
| `resources.json` | 数据 | 资源库数据本体，前端唯一读取的数据源 |
| `RESOURCES-README.md` | 文档 | 本文件 |
| `pinyin.json` / `config.json` | 其它模块 | 与资源库无关，请勿改动 |

> **链接校验工具已不存在**。原先同目录下有 `check-links.mjs`（批量校验链接）和
> `apply-link-report.mjs`（把报告回填进 `verified` 字段）两个 Node 脚本，
> 它们随 Node 后端一起删除了。现在 `resources.json` 里的 `verifySummary`
> 是最后一次校验的结果快照；要重新校验需要另写工具。

当前 `resources.json` 为 **3 个分组 / 24 条条目**，全部带 `desc` 与 `official` 标记。

---

## 2. 数据结构

```jsonc
{
  "version": 1,
  "updatedAt": "2026-09-26",        // 最近一次校验日期
  "notice": "安全提示文案",           // 前端顶部横幅展示
  "verifySummary": {                 // 最近一次校验的汇总（由 apply 脚本写入）
    "checkedAt": "2026-09-26",
    "total": 24, "ok": 21, "warn": 3, "dead": 0, "passRate": 88
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

当前 **3 个分组、24 条**：

| `id` | 名称 | 条目数 | 定位 |
| --- | --- | --- | --- |
| `free-audio` | 免费音源 / 伴奏 / 素材音乐 | 6 | 2 音乐库 + 2 音效库 + 2 音色库（sf2 / 免费 VST / 采样） |
| `editors` | 编辑器 / 声库官网 | 10 | **同一公司只留一条**，且只收根域名官网首页 |
| `utau` | UTAU 系与开源歌声合成 | 8 | 这一类**不分公司、有一个收一个**（免费开源为主） |

> **2026-09 大幅精简**：原来有 7 个分组、121 条，用户反馈「收录太多了」。
> 已删除：`stem-separation`（人声分离）、`character-art`（歌姬立绘）、
> `plugins`（第三方脚本与插件，47 条）、`learning`（教程与文档）、`safety`（安全提示）。
> 原 `editors`（编辑器获取）被新的 `editors`（编辑器 / 声库官网）取代。
>
> 两条收录规则的区别很重要：
> - **商业产品**：一个公司一条。收了 CeVIO 就不再单列 KAFU 的声库（KAFU 是 CeVIO 的声库）；
>   收了 VOCALOID 就不再单列 Miku / 洛天依的编辑器页。
> - **开源 / 免费项目**：有一个收一个。OpenUtau、UTAU、DiffSinger、NNSVS 属于这一类。

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
    （原先收在已删除的 `plugins` 分组里，指向 Dreamtonics 官方的脚本 API 手册）；
  - `sv2.docs.dreamtonics.com`（SynthV Studio 2 官方文档站）对脚本请求返回 403，浏览器正常，可自行访问。

---

## 4. 维护方式

> **链接校验工具已移除**。
>
> 原先这个目录下有两个 Node 脚本 —— `check-links.mjs`（批量校验链接有效性）
> 和 `apply-link-report.mjs`（把校验报告回填进 `verified` 字段）。它们随
> Node 后端一起删除了。
>
> `resources.json` 里的 `verifySummary` 是**最后一次校验的结果快照**，
> 不是实时状态。链接会随时间失效，要重新校验需要另写一个工具 ——
> 逻辑很简单：并发请求每条 `url`，把结果按分组统计后写回 `verifySummary`，
> 顺便按需更新各条目的 `verified` 字段。
## 5. 收录原则

1. **只收官方、开源、免费或官方试用渠道。**
   绝不收录破解版、学习版、激活器、注册机，以及网盘转载的盗版声库与编辑器。
   这类压缩包是木马与挖矿程序的主要投放渠道（见本文件顶部的 `notice` 安全提示，前端会把它渲染成横幅）。
2. **不收录盗版分发渠道（明确黑名单）。**
   以下站点属于盗版声库／破解编辑器的分发渠道，**永久不收录、也不作为「替代方案」间接推荐**：
   瑟狐下载站、`pan.vocaloid.world`、`vocakey`（vocakey.wikidot.com）。
   理由有两条：一是收录即等于协助侵权；二是这类来源无法验证安全性
   （无数字签名、二次打包、常带启动器 exe），与本库「只收录官方、开源与免费渠道」的原则直接冲突。
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

## 6. 数据现状（2026-09-27 校验）

- 分组 **3** 个，条目 **24** 条，全部带 `desc` 与 `official` 标记
- 校验结果：**正常 21 / 需浏览器访问 3 / 失效 0**，可用率 88%
  （`warn` 全是 403 反爬：Musopen、Musical Artifacts、Dreamtonics —— 浏览器打开都正常。
  这印证了「403 不算失效」这条规则的必要性：只看状态码会误杀三个好站。）
- `free-audio` 6 条：2 音乐（Free Music Archive、Musopen）、
  2 音效（Freesound、淘声网）、2 音色库（Musical Artifacts 的 sf2/sfz、Spitfire LABS 的免费 VST）
- `editors` 10 条：Yamaha、CeVIO、Dreamtonics、ACE Studio、AH-Software、
  Crypton、INTERNET、1st Place、Vsinger、DeepVocal —— **一司一条**
- `utau` 8 条：OpenUtau、UTAU、DiffSinger、NNSVS、VOICEVOX、COEIROINK、Neutrino、Sinsy
  —— 开源/免费项目**有一个收一个**

### 校验工具

```powershell
node tests\manual\check-resources.mjs          # 只报告
node tests\manual\check-resources.mjs --write  # 同时把结果写回 verified 字段与 verifySummary
```

超时与连接错误会自动重试 3 次 —— 境内访问境外站点抖动常见，
不重试会把「偶尔慢」误报成「站点有问题」（实测 COEIROINK、VOICEVOX 都出现过）。

### 历史

这份库经历过两轮大幅调整：
1. 早期删除 `free-alternatives`（免费替代方案）分组，以及 25 条规约/条款/支持页类条目；
2. 2026-09 按「收录太多了」的反馈精简，7 个分组 121 条 → **3 个分组 24 条**。
   删掉的是 `stem-separation`、`character-art`、`plugins`（47 条）、`learning`、`safety`。
   那些内容的详细来源清单见 git 历史：`git log --all -- app/data/resources.json`
