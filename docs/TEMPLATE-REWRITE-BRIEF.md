# 按模板重写 writer（重要架构变更）

## 背景：为什么必须这么做

用户反馈「转换出来的工程编辑器直接报错、打不开」。排查结论：

**原来的实现是「从零拼 JSON/XML」**——按自己对格式的理解逐个字段写出来。
这条路必然出错：漏一个必需字段、少一层嵌套、写错元素顺序，编辑器就拒绝加载，
而**自己写、自己读的往返自测永远发现不了**（reader 和 writer 一起错，往返照样全绿）。

**UtaFormatix 的做法完全不同**：它给每个格式都带了一个**真实工程当模板**，
生成时先把模板解析成对象，再往里填音符/速度/轨道，而不是从零构造：

```kotlin
// core/io/Vpr.kt:162
private fun generateContent(project: core.model.Project, features: List<FeatureConfиг>): String {
    val template = core.external.Resources.vprTemplate
    val vpr = jsonSerializer.decodeFromString(Project.serializer(), template)   // ← 先载入模板
    ...
}
```

模板本身就是编辑器接受的文件，所以「必需字段齐全」是天然保证的。

## 模板位置（已复制进项目）

```
app/server/core/formats/templates/
  template.vprjson      5339 B   VOCALOID5/6 工程骨架
  template.vsqx         4008 B   VOCALOID3/4 工程骨架
  template.svp          2813 B   Synthesizer V 工程骨架
  template.ccs          1819 B   CeVIO 工程骨架
  template.ustx         4357 B   OpenUtau 工程骨架
  LICENSE-utaformatix3.md        Apache-2.0 许可证（必须随代码保留）
```

## 参考实现（UtaFormatix 的 Kotlin 源码，Apache-2.0）

```
docs/reference/utaformatix3/
  Vpr.kt  Vsqx.kt  VsqLike.kt  Svp.kt  Ccs.kt  Ust.kt  Ustx.kt  UfData.kt  ...
  LICENSE-utaformatix3.md
```

**这些是权威参照**：字段名、默认值、必要结构、数值换算都以它为准。
遇到任何不确定，先去读它，不要猜。

## 要求

1. **写出时以模板为骨架**：深拷贝模板 → 填入实际数据 → 序列化。
   不要把模板里存在的字段当「可选」删掉；模板有的就保留。
2. **ZIP 条目名**以参考实现为准（`Vpr.kt` 的 `possibleJsonPaths.first()` 是
   `Project\sequence.json`，是**反斜杠**）。
3. **保留署名**：模块文件头注释里写明「本模块的结构与默认值参照 UtaFormatix3
   （sdercolin, Apache-2.0）实现」。改动要在 NOTICE 里说明（见下）。
4. **不得引入 npm 依赖**：程序仍是零依赖，模板以文件形式放在
   `app/server/core/formats/templates/` 并由模块读取。
5. 读入（reader）逻辑尽量不动，除非它与参考实现明显不符。

## 验收（三条都必须真实跑通）

```
node app/server/core/template.test.mjs     # 模板字段完整性（新增，见下）
node app/server/core/structure.test.mjs    # 与真实工程文件的结构指纹对比
node app/server/core/selftest.mjs <格式id>
```

另外：
- `node app/server/core/xsd.test.mjs` —— 用 VOCALOID6 自带的 vsq3.xsd / vsq4.xsd
  校验 VSQX 输出（这是编辑器自己的标准答案）
- `node app/server/core/fidelity.test.mjs` —— 保真度声明必须与实际一致

## 不要做的事

- 不要为了让测试通过而放宽断言。模板完整性测试失败就是真失败。
- 不要改动 `structure.test.mjs` / `template.test.mjs` 的判定逻辑或忽略名单。
- 不要修改 `templates/` 里的模板内容（那是编辑器的格式基准）。
