# 第三方代码与素材的署名

本程序是零依赖的本地工具，但**格式转换部分的结构、默认值与模板取自 UtaFormatix3**，
在此保留原作者署名与许可证。

---

## UtaFormatix3

- 项目：<https://github.com/sdercolin/utaformatix3>
- 作者：sdercolin 及贡献者
- 许可证：**Apache License 2.0**（全文见 `app/server/core/formats/templates/LICENSE-utaformatix3.md`）
- 本项目如何使用：

| 使用方式 | 位置 | 说明 |
|---|---|---|
| 格式模板文件 | `app/server/core/formats/templates/*` | `template.vprjson` / `template.vsqx` / `template.svp` / `template.ccs` / `template.ustx` 等，原样复制。程序写出工程时以这些模板为骨架填充数据 —— 这是 UtaFormatix 的核心做法（见其 `core/io/*.kt` 中 `Resources.xxxTemplate` 的用法），也是「写出的文件能被编辑器打开」的关键保证 |
| 参考实现 | `docs/reference/utaformatix3/*.kt` | 字段语义、默认值、数值换算的权威参照。**不参与运行**，仅供开发时校对 |
| 中文拼音词典 | `docs/reference/utaformatix3/mandarin-pinyin-dict.txt` | 仅作对照。程序实际使用的是自建的 `app/server/data/pinyin.json` |

### 我们做的修改

按照 Apache-2.0 第 4 条的要求说明改动：

- 模板文件**原样使用，未作修改**。
- 参考实现（`docs/reference/`）**原样保留，未作修改**，也不参与构建。
- 格式模块（`app/server/core/formats/*.mjs`）是**独立编写的 JavaScript 实现**：
  以 UtaFormatix 的 Kotlin 实现为规范参照，复现其字段结构与默认值，
  但没有移植、翻译或复制其源码；数据结构用的是本项目的 IR（见 `IR-SPEC.md`）。
- 本程序整体采用与 UtaFormatix 不同的内部数据模型，故未沿用其源码组织方式。

---

## 其它

| 名称 | 用途 | 许可证 / 说明 |
|---|---|---|
| FFmpeg | 音视频处理（由用户在设置页一键获取，**不随程序分发**） | LGPL / GPL，见其官网 |
| yt-dlp | 视频站点解析（同上，不随程序分发） | Unlicense |
| pinyin-data | 中文拼音字典的数据来源（`app/server/data/build-pinyin.mjs` 据此生成 `pinyin.json`） | MIT |

> 本程序**不收录**任何破解、激活器或盗版声库/编辑器的分发链接，详见 `app/server/data/RESOURCES-README.md` 的收录原则。
