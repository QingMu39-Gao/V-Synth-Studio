# 格式模块开发契约（所有 reader/writer 必须遵守）

## 1. 交付物

在 `app/server/core/formats/<id>.mjs` 实现一个格式模块，并在
`app/server/core/formats/__tests__/<id>.test.mjs` 提供自测。

模块必须导出：

```js
export const meta = {
  id: 'vsqx',                    // 唯一 id，小写
  name: 'VOCALOID3/4 工程',       // 中文显示名
  vendor: 'Yamaha',
  exts: ['.vsqx'],               // 读取时匹配的扩展名（小写，含点）
  kind: 'xml',                   // 'xml' | 'json' | 'text' | 'binary' | 'yaml' | 'zip'
  canRead: true,
  canWrite: true,
  writeExt: '.vsqx',             // 写出时使用的扩展名
  encoding: 'utf8',              // 写出的文本编码；二进制为 'binary'
}

export const fidelity = {
  preserves: ['tempo', 'timeSignature', 'notes', 'lyrics', 'pitchCurve', 'vibrato', 'params.dynamics'],
  drops: ['音素覆盖', '歌手名'],
  notes: '一句话说明该格式的能力边界（会展示给用户，用于转换前提示）',
}

export function read(buffer, opts = {}) { /* Buffer -> Project */ }
export function write(project, opts = {}) { /* Project -> Buffer */ }

export default { meta, fidelity, read, write }
```

## 2. 硬性约束

- **禁止任何 npm 依赖**。只允许 Node 内置模块，以及：
  - `../ir.mjs`（中间表示与工具，必读 `../IR-SPEC.md`）
  - `../../util/xml.mjs`（XML）、`../../util/yaml.mjs`（YAML）、`../../util/bytes.mjs`（二进制）
  需要新的通用工具时，**在模块内实现**，不要改 `util/`（避免并发冲突）。
- 时间单位换算到 `TPQ = 480` 后才能进入 IR，不得泄漏原生单位。
- 参数曲线值归一化到 `0..1`（`velocity` 为 `0..127`，音高曲线为半音浮点）。
- 同格式往返尽量无损：读入时把无法映射的原始数据存进 `extras`，写回时优先复用。
- `read()` 遇到轻微不规范的数据要**容错**（跳过坏节点并继续），只有完全无法识别才抛错；
  抛错信息用中文写明原因与位置。
- `write()` 产出必须能被目标编辑器真正打开：属性顺序、必需字段、版本号要正确。
- 注释与错误信息用中文；代码风格：2 空格缩进、无分号结尾歧义、ESM。

## 3. 自测要求

`__tests__/<id>.test.mjs` 导出：

```js
export default async function run() {
  // 断言失败请 throw new Error('中文说明')
  // 返回 { passed: number, notes: string[] }
}
```

必须覆盖：
1. 构造一个含 2 轨、变速、变拍号、含音高曲线与参数曲线的 IR 工程；
2. `write()` 后 `read()` 回来，逐项断言 tempo/拍号/音符 tick+duration+key+lyric/pitch 曲线；
3. 若 `tests/samples/` 下有该格式的真实文件，读取并断言音符数 > 0；
4. 断言 `validateProject()` 返回空数组。

运行方式（必须跑通才算完成）：

```
node app/server/core/selftest.mjs <id>
```

## 4. 参考实现与样本

- 真实样本目录：`H:\工作站\tests\samples\`
- 查找格式规范时优先参考公开的格式文档与开源实现的**样本文件**；
  不要凭印象猜字段名——字段名错了目标编辑器就打不开。
- 用户本机已安装编辑器（可用来找样本或核对行为）：
  - VOCALOID6 → `H:\VOCALOID6\Editor\VOCALOID6.exe`
  - Synthesizer V Studio 2 Pro → `H:\Synthesizer V Studio 2 Pro\synthv-studio.exe`
  - CeVIO AI → `H:\cevio\CeVIO AI.exe`
  - OpenUtau → `H:\OpenUtau\OpenUtau.exe`
  - ACE Studio → `C:\Program Files\ACE Studio`
  只读检查，**不要修改或运行**这些目录里的任何内容。

## 5. 完成标准

- `node app/server/core/selftest.mjs <id>` 输出全部通过；
- 用一句话向主代理报告：`<id> 完成 | 往返通过 N 项 | 已知限制：...`
