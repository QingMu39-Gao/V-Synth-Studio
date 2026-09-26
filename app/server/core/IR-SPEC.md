# VPIR — Vocal Project Intermediate Representation

所有格式模块（reader/writer）必须且只能通过本中间表示交换数据。
实现见 `app/server/core/ir.mjs`，本文件是权威说明。

## 0. 铁律

1. **时间单位统一为 tick，`TPQ = 480`（每四分音符 480 tick）。**
   其它分辨率（SVP 的 blick = 705600000/Q、MIDI 文件头的 PPQ、VSQ 的 measure/beat）
   必须在各自模块内换算，**绝不**把外来单位泄漏进 IR。
2. **音高统一为 MIDI 音符号（整数 key）+ 浮点绝对音高曲线（semitones）。**
   曲线值 60 表示中央 C，60.5 表示 +50 音分。不要用「相对偏移」。
3. **参数曲线值统一归一化到 `0..1`**（`velocity` 为 `0..127`，`pitch` 曲线例外见上）。
   格式原生范围（VOCALOID 的 0..127、CeVIO 的 0..100、OpenUtau 的 -100..100 等）
   必须由格式模块的 `paramMap` 双向换算。
4. **同格式往返必须接近无损**：读入时把无法映射进 IR 的原始数据放进
   `extras`，写回同格式时优先取回 `extras`。这是「比 UtaFormatix 强」的关键指标之一。
5. **不得依赖任何 npm 包。** 只用 Node 内置模块与 `app/server/util/*`。
6. 所有读取器签名 `read(buf: Buffer, opts) -> Project`，写出器
   `write(project: Project, opts) -> Buffer`。`opts` 为 `{ name, encoding }` 等可选提示。

## 1. Project

```js
{
  formatVersion: 1,
  sourceFormat: 'vsqx',       // 来源格式 id，调试/提示用
  name: '未命名工程',
  comment: '',
  tempos: [{ tick: 0, bpm: 120 }],                  // 按 tick 升序，tick=0 必须存在
  timeSignatures: [{ tick: 0, numerator: 4, denominator: 4 }], // 按 tick 升序
  measurePrefix: 0,           // 第一小节线之前的 tick 数（弱起）；无弱起为 0
  tracks: [Track],
  extras: {}                  // 格式私有数据
}
```

## 2. Track

```js
{
  id: 'trk1',
  name: 'Track 1',
  singer: 'Hatsune Miku V4X', // 歌手/声库名，无则 ''
  color: '#66ccff',           // 可选
  muted: false,
  solo: false,
  volume: 1.0,                // 0..1（原生 0..127 / -∞..0dB 请换算）
  pan: 0.0,                   // -1..1
  language: 'ja',             // 'ja' | 'zh' | 'en' | '' (未知)
  notes: [Note],              // 必须按 tick 升序、无重叠歧义
  pitch: Curve,               // 绝对音高曲线（semitones），可为空
  parameters: { dynamics: Curve, ... },  // 见 §4
  phonemes: [Phoneme],        // 可选，逐音素时间轴（CeVIO/SynthV 有）
  extras: {}
}
```

`Curve = { ticks: number[], values: number[] }`，两数组等长、`ticks` 升序严格递增。
空曲线表示为 `{ ticks: [], values: [] }`。

## 3. Note

```js
{
  tick: 0,            // 起始 tick（整数）
  duration: 480,      // 时长 tick（整数，> 0）
  key: 60,            // MIDI 音符号
  lyric: 'la',        // 原文歌词，保留原始语言写法，无歌词为 ''
  pitchOffset: 0,     // 音分，音符级微调（VOCALOID 无 / SynthV pitchOffset）
  detune: 0,          // 音分，VOCALOID 的 DETUNE
  velocity: 64,       // 0..127，VOCALOID 的 VEL
  phoneme: null,      // 音素覆盖，无则 null
  attributes: {}      // 格式私有（vibrato 原始结构、POR 等）
}
```

音符级颤音若格式原生支持，存 `attributes.vibrato = {length, depth, rate, delay, drift}`，
`length`/`delay` 单位 tick，`depth` 单位音分，`rate` 单位 Hz。无统一模型时留在 `extras`。

## 4. 规范参数名（canonical params）

轨道 `parameters` 的键只能取下列之一（其余一律放入 `extras`）：

| 键 | 含义 | 取值范围 |
|---|---|---|
| `pitch` | 音高偏差曲线（相对音符 key 的偏移，semitones） | -12..12 |
| `dynamics` | 力度 / DYN / loudness | 0..1 |
| `breathiness` | 气声 / BRE | 0..1 |
| `brightness` | 明亮度 / BRI | 0..1 |
| `clearness` | 清晰度 / CLE | 0..1 |
| `gender` | 性别参数 / GEN | 0..1 |
| `tension` | 张力 / TEN | 0..1 |
| `voicing` | 发声 / VOI | 0..1 |
| `opening` | 开口度 / OPE | 0..1 |
| `mouth` | 口型 / MOU | 0..1 |
| `roughness` | 粗糙度 / ROU | 0..1 |
| `velocity` | 辅音速度 / VEL | 0..127 |
| `vibratoDepth` | 颤音深度 / VIB | 0..1 |
| `vibratoRate` | 颤音速度 / VIBS | 0..1 |
| `vibratoDelay` | 颤音延迟 / VIBD | 0..1 |
| `portamento` | 滑音时间 / POR | 0..1 |
| `growl` | 嘶吼 / GRO | 0..1 |
| `harmonics` | 泛音 / HAR | 0..1 |

注意：轨道级 `pitch` 是**绝对音高**（§2），音符级参数 `pitch` 是**相对偏移**。
`parameters.pitch` 与 `track.pitch` 语义相同、二者取其一即可，推荐统一使用 `track.pitch`。

## 5. Phoneme（可选）

```js
{ tick: 0, duration: 120, symbol: 'a', noteIndex: 0, extras: {} }
```

## 6. 必须由 `ir.mjs` 提供的工具（格式模块直接调用，不要自己重写）

- `TPQ`
- `createProject(init)` / `createTrack(init)` / `createNote(init)` / `createCurve()`
- `tickToSec(tick, tempos)` / `secToTick(sec, tempos)` —— 速度映射积分
- `measureToTick(m, {numerator, denominator}, measurePrefix, timeSignatures)`
- `tickToMeasure(tick, timeSignatures, measurePrefix)`
- `curveValueAt(curve, tick)` / `setCurveValue(curve, tick, value)` / `sortCurve(curve)`
- `normalizeCurve(curve)` —— 合并同 tick、剔除 NaN、排序
- `transposeProject(project, semitones)`
- `projectStartTick(project)` / `projectEndTick(project)`
- `validateProject(project)` —— 返回 `string[]` 问题列表（空数组表示合法）
- `uid(prefix)`

## 7. 解析库

- `util/xml.mjs`：`parseXml(text) -> node`、`buildXml(node, opts) -> string`、`find/findAll/text/attr` 辅助
- `util/yaml.mjs`：`parseYaml(text)`、`buildYaml(value)`（OpenUtau ustx 子集）
- `util/bytes.mjs`：`BufferReader` / `BufferWriter`（MIDI 变长整数、大端读写、字符串）

## 8. 测试要求

每个格式模块必须在 `app/server/core/formats/__tests__/<id>.test.mjs` 中提供可执行自测：

```
node app/server/core/selftest.mjs <formatId>
```

自测需覆盖：① 用本模块 writer 生成样本工程；② 用 reader 读回；③ 断言
tempo/拍号/音符数/音高/歌词/时长/pitch 曲线的数值在容差内一致；
④ 若磁盘上存在真实样本（`tests/samples/`），一并读取并断言不抛异常。
