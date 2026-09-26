# tests/samples —— 测试样本

这个目录放的是**格式模块的测试样本**，用来验证各编辑器工程能被正确解析。

## ⚠️ 关于版权

其中一部分是从使用者本机已有的真实工程复制过来的（例如 `real-sample-1.vpr`、`real-sample-2.vpr`
对应的商业歌曲工程）。这些文件**只用于本机开发自测**：

- 不要把本目录随程序一起分发给别人
- 不要把样本内容提交到公开仓库
- 如果你不希望这些歌曲数据留在工作目录里，直接删掉即可 —— 自测框架会跳过样本验证，
  只是少了一层真实文件校验（`node app/server/core/selftest.mjs` 仍能跑往返测试）

## 文件说明

| 文件 | 来源 | 用途 |
|---|---|---|
| `real-sample-1.vpr` | 本机真实工程（VOCALOID5，2 轨 561 音符） | vpr 读取验证 |
| `real-sample-2.vpr` | 本机真实工程（VOCALOID6，4 轨 747 音符） | vpr 读取验证 |
| `real-sample-1.vsqx` / `real-sample-2.vsqx` | 真实工程 | vsqx 读取验证 |
| `real-sample-1.svp` | SynthV 官方空工程模板 | svp 结构验证 |
| `real-sample-2.svp` | 真实 SynthV 2 工程（3 轨 360 音符） | svp 读取验证 |
| `real-sample-1~3.ccs` | 真实 CeVIO 工程 | ccs 读取验证 |
| `openutau-*.ustx` | 本机 OpenUtau 备份目录 | ustx 读取验证（含大量日文假名歌词） |
| `sample-C.mid` / `sample-Fs-min.mid` | UTAU 音源包自带 | midi 读取验证 |
| `sample-ufdata.ufdata` | 手工构造 | ufdata 读写验证 |

## 命名约定

自测框架只把 **`sample-`** 或 **`real-sample-`** 开头的文件当样本。
开发时下载的参考资料、临时模板请放到别处，不要用这两个前缀命名，否则会被误当成样本参与测试。
