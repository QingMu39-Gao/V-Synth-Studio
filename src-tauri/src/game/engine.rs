//! GAME 推理引擎：把音频跑成音符。
//!
//! 这里是**纯 Rust 实现** —— 不启 Python 子进程、不开本地端口（对比音轨分离
//! 那套 `svsep` 的形态：那边是 Python HTTP 服务 + 固定端口转发，这边是进程内
//! 直接调 ONNX Runtime）。
//!
//! 需要两样东西：
//!
//! * **ONNX Runtime 动态库** —— 随包在 `tools/onnxruntime/`，也可以借用音轨分离
//!   运行时里那份（`runtime/Lib/site-packages/onnxruntime/capi/onnxruntime.dll`，
//!   那份是 GPU 构建）。挑哪一份由 `midi_transcribe::runtime_dll` 定。
//! * **三个模型图** —— `encoder.onnx` / `segmenter.onnx` / `estimator.onnx`，
//!   权重是 CC BY-NC-SA 4.0（非商业），所以**不进仓库、不随包分发**，
//!   由用户在界面上点一下从官方 release 下载。
//!
//! 数值正确性与 golden 向量 21 项全等、与真实人声 41 个音符逐个相等 ——
//! 算法改动必须保持这两项回归全绿。

use std::path::Path;

use ndarray::{Array1, Array2, ArrayD, IxDyn};
use ort::session::{Session, SessionInputs};
use ort::value::Tensor as OrtTensor;
use ort::value::Value as OrtValue;

use super::algo;
use super::midi::Note;
use crate::midi_transcribe::Device;

/// 一个音符。`pitch` 是**半音值**（A4 = 69），写 MIDI 时才取整 —— 保留小数
/// 是为了界面能显示「偏高/偏低多少音分」。
#[derive(Debug, Clone, Copy)]
pub struct NoteOut {
    pub onset: f64,
    pub offset: f64,
    pub pitch: f32,
}

/// 转录参数。默认值就是上游 CLI 的默认值（`infer.py extract`）。
#[derive(Debug, Clone)]
pub struct Options {
    /// D3PM 采样步数。上游默认 8 —— **这是质量与时间的主要旋钮**：
    /// CPU 上全程耗时几乎正比于它。
    pub steps: usize,
    /// 界面语言 id（`config.json` 的 `languages` 映射，0 = 通用）。
    pub language: i64,
    /// 每个 ONNX 会话的 intra-op 线程数。见 `ort_session` 的注释。
    pub threads: usize,
    /// 推理方式。只有 `Gpu` 会去挂 CUDA，其余一律纯 CPU。
    pub device: Device,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            steps: algo::D3PM_STEPS,
            language: 4,
            threads: 4,
            device: Device::Auto,
        }
    }
}

/// 进度回调：`(阶段说明, 已完成的占比 0..1)`。
pub type Progress<'a> = dyn Fn(&str, f64) + Send + Sync + 'a;

pub struct Report {
    pub notes: Vec<NoteOut>,
    /// 每个切片的 `(起始秒, 采样点数)`
    pub slices: Vec<(f64, usize)>,
    pub n_samples: usize,
    /// 各阶段耗时（秒），界面拿它估剩余时间
    pub encoder_seconds: f64,
    pub segmenter_seconds: f64,
    pub estimator_seconds: f64,
    /// D3PM 每一步的边界数，出问题时是唯一的现场记录
    pub per_step: Vec<usize>,
    /// 这一次**实际**用的执行后端：`"CPU"` 或 `"CUDA"`。
    ///
    /// ⚠️ 报的是「三个会话都建成了的那个后端」—— GPU 路上任何一张图建不出来都会
    /// 整条退回 CPU，这时这里就是 `"CPU"`，而 ORT 的原话在任务日志里
    /// （见 `build_sessions`）。
    pub backend: &'static str,
}

/// 建一个 ONNX 会话。
///
/// **必须显式指定 provider**：不指定的话 ORT 会按自身默认去挑后端，结果依机器
/// 而定（失败或静默降级两种结果都很难查）。`gpu = false` 时只挂 CPU —— 随包的
/// `onnxruntime.dll` 是 CUDA 构建，不指定就会去加载 CUDA，在没有 N 卡的机器上
/// 失败或悄悄降级。
///
/// 线程数也是显式设的：这个图偏窄，**ORT 按核数自己选的那个默认值反而最慢**
/// —— 8 核上 T=300 的单步 segmenter：1 线程 2.66 s、4 线程 1.04 s、8 线程 3.30 s。
fn ort_session(path: &Path, name: &str, threads: usize, gpu: bool) -> Result<Session, String> {
    let mut builder = Session::builder().map_err(|e| format!("{name}: {e}"))?;
    if gpu {
        /* CUDA 在前、CPU 在后。⛔ 别去掉 `error_on_failure()`：默认是 `fail_silently`，
        那样 CUDA 注册不上时会悄悄给一个 CPU 会话，界面显示在用 GPU、其实一直在 CPU
        上慢慢跑（这一格恰是用户专门去解锁的，报错比装死好）。 */
        builder = builder
            .with_execution_providers([
                ort::ep::CUDA::default().build().error_on_failure(),
                ort::ep::CPU::default().build(),
            ])
            .map_err(|e| format!("{name}: CUDA provider: {e}"))?;
    } else {
        builder = builder
            .with_execution_providers([ort::ep::CPU::default().build()])
            .map_err(|e| format!("{name}: CPU provider: {e}"))?;
    }
    builder = builder
        .with_optimization_level(ort::session::builder::GraphOptimizationLevel::Level3)
        .map_err(|e| format!("{name}: 优化级别: {e}"))?;
    builder = builder
        .with_intra_threads(threads.max(1))
        .map_err(|e| format!("{name}: 线程数: {e}"))?;
    builder
        .commit_from_file(path)
        .map_err(|e| format!("{name}: 载入 {} 失败：{e}", path.display()))
}

/// 建三个会话（encoder / segmenter / estimator），返回 `(enc, seg, est, 实际后端)`。
///
/// **GPU 建不出来就整条退回 CPU**，不让整首转录音失败：解锁 GPU 的代价只是装过
/// 音轨分离，驱动太老、显卡太旧、显存不够都会让 CUDA 建会话失败。退回时把 ORT 的
/// 原话写进任务日志 —— 界面显示 CPU，日志里查得到为什么。
fn build_sessions(
    models_dir: &Path,
    threads: usize,
    device: Device,
) -> Result<(Session, Session, Session, &'static str), String> {
    let enc = models_dir.join("encoder.onnx");
    let seg = models_dir.join("segmenter.onnx");
    let est = models_dir.join("estimator.onnx");
    if device != Device::Gpu {
        return Ok((
            ort_session(&enc, "encoder", threads, false)?,
            ort_session(&seg, "segmenter", threads, false)?,
            ort_session(&est, "estimator", threads, false)?,
            "CPU",
        ));
    }
    /* GPU 这三张图**顺序**建、失败就停：要的正是第一个失败原因，三张一起建会让
    后面两张白等十几秒 CUDA 初始化。 */
    let mut built = Vec::with_capacity(3);
    let mut why: Option<String> = None;
    for (p, name) in [(&enc, "encoder"), (&seg, "segmenter"), (&est, "estimator")] {
        match ort_session(p, name, threads, true) {
            Ok(s) => built.push(s),
            Err(e) => {
                why = Some(e);
                break;
            }
        }
    }
    if let Ok([a, b, c]) = <[Session; 3]>::try_from(built) {
        return Ok((a, b, c, "CUDA"));
    }
    if let Some(why) = why {
        crate::log_line(&format!(
            "人声转 MIDI：CUDA 建会话失败，这一首改用 CPU —— {why}"
        ));
    }
    Ok((
        ort_session(&enc, "encoder", threads, false)?,
        ort_session(&seg, "segmenter", threads, false)?,
        ort_session(&est, "estimator", threads, false)?,
        "CPU",
    ))
}

/// 加载 ONNX Runtime 动态库。只需成功一次，重复调用无害。
pub fn load_runtime(dll: &Path) -> Result<(), String> {
    if !dll.is_file() {
        return Err(format!("找不到 ONNX Runtime：{}", dll.display()));
    }
    ort::init_from(dll)
        .map_err(|e| format!("载入 ONNX Runtime 失败（{}）：{e}", dll.display()))?
        .commit();
    Ok(())
}

/// 跑完整条流水线。
///
/// `waveform` 必须是 **44.1 kHz 单声道** —— 重采样交给 ffmpeg，不在这里做，
/// 和音轨分离那边的做法一致（`audio::run_ffmpeg`）。
pub fn transcribe(
    models_dir: &Path,
    dll: &Path,
    waveform: &[f32],
    opts: &Options,
    progress: &Progress<'_>,
) -> Result<Report, String> {
    load_runtime(dll)?;

    progress("正在载入模型…", 0.0);
    let (mut enc, mut seg, mut est, backend) =
        build_sessions(models_dir, opts.threads, opts.device)?;

    // 官方导出的图里随机数节点是图内自带的（`RandomUniformLike`），但验证用的
    // 注入版把它改成了名为 `rnd` 的图输入。两种都要能跑：有 `rnd` 就自己抽随机
    // 数、先把边界噪声化再喂；没有就让图自己去噪。
    let seg_takes_rnd = seg.inputs().iter().any(|i| i.name() == "rnd");

    let steps = opts.steps.max(1);
    let ts = algo::d3pm_ts(algo::D3PM_T0, steps);
    let radius = (algo::SEG_RADIUS_SEC / algo::TIMESTEP).round() as i64;

    let slices = algo::slice_waveform(waveform, algo::SAMPLE_RATE);
    let mut report = Report {
        notes: Vec::new(),
        slices: slices.iter().map(|(o, w)| (*o, w.len())).collect(),
        n_samples: waveform.len(),
        encoder_seconds: 0.0,
        segmenter_seconds: 0.0,
        estimator_seconds: 0.0,
        per_step: Vec::new(),
        backend,
    };
    if slices.is_empty() {
        // 全静音：没有切片，也就没有音符。不是错误。
        progress("完成（没有检测到人声）", 1.0);
        return Ok(report);
    }

    // 每个切片在整体进度里的权重：切片越长占得越多（时间基本正比于长度）。
    let total_samples: usize = slices.iter().map(|(_, w)| w.len()).sum();
    let mut done_samples = 0usize;
    let mut rng_state = 0x2026_1003_2026_1003u64;

    for (si, (offset, chunk)) in slices.iter().enumerate() {
        let base = done_samples as f64 / total_samples as f64;
        let share = chunk.len() as f64 / total_samples as f64;
        let tag = if slices.len() > 1 {
            format!("第 {}/{} 段", si + 1, slices.len())
        } else {
            "正在扒谱".to_string()
        };

        let duration = chunk.len() as f32 / algo::SAMPLE_RATE as f32;
        let wf: Array2<f32> =
            Array2::from_shape_vec((1, chunk.len()), chunk.clone()).map_err(|e| e.to_string())?;
        let dur: Array1<f32> = Array1::from_vec(vec![duration]);

        progress(&format!("{tag}：提取特征…"), base);
        let t0 = std::time::Instant::now();
        let enc_out = enc
            .run(ort::inputs![
                OrtTensor::from_array(wf).map_err(|e| e.to_string())?,
                OrtTensor::from_array(dur).map_err(|e| e.to_string())?,
            ])
            .map_err(|e| format!("encoder 推理失败：{e}"))?;
        report.encoder_seconds += t0.elapsed().as_secs_f64();

        let x_seg = enc_out["x_seg"]
            .try_extract_array::<f32>()
            .map_err(|e| format!("x_seg: {e}"))?
            .to_owned();
        let x_est = enc_out["x_est"]
            .try_extract_array::<f32>()
            .map_err(|e| format!("x_est: {e}"))?
            .to_owned();
        let mask_t: Vec<bool> = enc_out["maskT"]
            .try_extract_array::<bool>()
            .map_err(|e| format!("maskT: {e}"))?
            .iter()
            .copied()
            .collect();
        let t_len = mask_t.len();

        // ── D3PM 采样环（宿主侧，见 `algo` 顶部的表）────────────────────
        let known = vec![false; t_len];
        let mut prev = known.clone();
        let t_seg = std::time::Instant::now();
        for (step, tv) in ts.iter().enumerate() {
            let p = algo::d3pm_time_schedule(*tv);
            let rnd: Vec<f32> = (0..t_len)
                .map(|_| algo::next_uniform(&mut rng_state))
                .collect();
            // 没有 `rnd` 输入时不能自己先去噪，否则等于噪化两遍。
            let prev_after = if seg_takes_rnd {
                algo::remove_mutable_boundaries(&prev, &known, p, &rnd)
            } else {
                prev.clone()
            };

            let prev_arr: Array2<bool> =
                Array2::from_shape_vec((1, t_len), prev_after).map_err(|e| e.to_string())?;
            let known_arr: Array2<bool> =
                Array2::from_shape_vec((1, t_len), known.clone()).map_err(|e| e.to_string())?;
            let mask_arr: Array2<bool> =
                Array2::from_shape_vec((1, t_len), mask_t.clone()).map_err(|e| e.to_string())?;
            let lang: Array1<i64> = Array1::from_vec(vec![opts.language]);
            let t_scalar: ArrayD<f32> = ArrayD::from_elem(IxDyn(&[]), *tv);
            let thr: ArrayD<f32> = ArrayD::from_elem(IxDyn(&[]), algo::SEG_THRESHOLD);
            let rad: ArrayD<i64> = ArrayD::from_elem(IxDyn(&[]), radius);

            // 输入要按需增删，所以用 `SessionInputs::from(Vec<(Cow<str>, Value)>)`
            // 而不是 `ort::inputs![]` —— 后者拼不出可选输入。
            let mut ins: Vec<(std::borrow::Cow<'_, str>, OrtValue)> = vec![
                (
                    "x_seg".into(),
                    OrtTensor::from_array(x_seg.clone())
                        .map_err(|e| e.to_string())?
                        .into(),
                ),
                (
                    "language".into(),
                    OrtTensor::from_array(lang)
                        .map_err(|e| e.to_string())?
                        .into(),
                ),
                (
                    "known_boundaries".into(),
                    OrtTensor::from_array(known_arr)
                        .map_err(|e| e.to_string())?
                        .into(),
                ),
                (
                    "prev_boundaries".into(),
                    OrtTensor::from_array(prev_arr)
                        .map_err(|e| e.to_string())?
                        .into(),
                ),
                (
                    "t".into(),
                    OrtTensor::from_array(t_scalar)
                        .map_err(|e| e.to_string())?
                        .into(),
                ),
                (
                    "maskT".into(),
                    OrtTensor::from_array(mask_arr)
                        .map_err(|e| e.to_string())?
                        .into(),
                ),
                (
                    "threshold".into(),
                    OrtTensor::from_array(thr)
                        .map_err(|e| e.to_string())?
                        .into(),
                ),
                (
                    "radius".into(),
                    OrtTensor::from_array(rad)
                        .map_err(|e| e.to_string())?
                        .into(),
                ),
            ];
            if seg_takes_rnd {
                let rnd_arr: Array2<f32> =
                    Array2::from_shape_vec((1, t_len), rnd).map_err(|e| e.to_string())?;
                ins.push((
                    "rnd".into(),
                    OrtTensor::from_array(rnd_arr)
                        .map_err(|e| e.to_string())?
                        .into(),
                ));
            }

            let out = seg
                .run(SessionInputs::from(ins))
                .map_err(|e| format!("segmenter 推理失败（第 {} 步）：{e}", step + 1))?;
            prev = out["boundaries"]
                .try_extract_array::<bool>()
                .map_err(|e| format!("boundaries: {e}"))?
                .iter()
                .copied()
                .collect();
            let n = prev.iter().filter(|b| **b).count();
            report.per_step.push(n);
            progress(
                &format!("{tag}：{}", seg_status(step + 1, steps, n)),
                base + share * (step + 1) as f64 / (steps + 1) as f64,
            );
        }
        report.segmenter_seconds += t_seg.elapsed().as_secs_f64();

        // ── 区间/时值 ────────────────────────────────────────────────
        let regions = algo::boundaries_to_regions(&prev, Some(&mask_t));
        let max_n = regions.iter().copied().max().unwrap_or(0) as usize;
        if max_n == 0 {
            done_samples += chunk.len();
            continue;
        }
        let n_mask: Vec<bool> = vec![true; max_n];
        let durations = algo::regions_to_durations(&regions, max_n);

        let mask_arr: Array2<bool> =
            Array2::from_shape_vec((1, t_len), mask_t.clone()).map_err(|e| e.to_string())?;
        let n_mask_arr: Array2<bool> =
            Array2::from_shape_vec((1, max_n), n_mask).map_err(|e| e.to_string())?;
        let bd_arr: Array2<bool> =
            Array2::from_shape_vec((1, t_len), prev.clone()).map_err(|e| e.to_string())?;
        let thr: ArrayD<f32> = ArrayD::from_elem(IxDyn(&[]), algo::EST_THRESHOLD);

        progress(
            &format!("{tag}：判断音高…"),
            base + share * steps as f64 / (steps + 1) as f64,
        );
        let t_est = std::time::Instant::now();
        let out = est
            .run(ort::inputs![
                OrtTensor::from_array(x_est.clone()).map_err(|e| e.to_string())?,
                OrtTensor::from_array(bd_arr).map_err(|e| e.to_string())?,
                OrtTensor::from_array(mask_arr).map_err(|e| e.to_string())?,
                OrtTensor::from_array(n_mask_arr).map_err(|e| e.to_string())?,
                OrtTensor::from_array(thr).map_err(|e| e.to_string())?,
            ])
            .map_err(|e| format!("estimator 推理失败：{e}"))?;
        report.estimator_seconds += t_est.elapsed().as_secs_f64();

        let presence: Vec<bool> = out["presence"]
            .try_extract_array::<bool>()
            .map_err(|e| format!("presence: {e}"))?
            .iter()
            .copied()
            .collect();
        let scores: Vec<f32> = out["scores"]
            .try_extract_array::<f32>()
            .map_err(|e| format!("scores: {e}"))?
            .iter()
            .copied()
            .collect();

        // 音符抽取，照 `inference/callbacks.py:47-88`：时值累加成起止时间，
        // 跳过没有 presence 的、以及零长度（去重叠后会出现）的。
        let mut cursor = *offset;
        // `durations` 的长度就是 `max_n`（见 `regions_to_durations`），`take` 只是兜底
        for (i, &raw) in durations.iter().enumerate().take(max_n) {
            let d = raw as f64 * algo::TIMESTEP as f64;
            let onset = cursor;
            let end = onset + d;
            cursor = end;
            if !presence.get(i).copied().unwrap_or(false) || end - onset <= 0.0 {
                continue;
            }
            report.notes.push(NoteOut {
                onset,
                offset: end,
                pitch: scores.get(i).copied().unwrap_or(0.0),
            });
        }
        done_samples += chunk.len();
    }

    report.notes.sort_by(|a, b| {
        a.onset
            .partial_cmp(&b.onset)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    progress("完成", 1.0);
    Ok(report)
}

fn seg_status(step: usize, steps: usize, n: usize) -> String {
    format!("去噪 {step}/{steps}（候选边界 {n} 个）")
}

/// 把音符写成单轨 MIDI 字节。
///
/// 上游的写出回调会先做**单音化去重叠**（按 `(onset, offset, pitch)` 排序后把
/// 每个起音顶到上一个的收尾），所以这里也照做 —— 保持和官方 CLI 输出一致。
pub fn notes_to_midi(notes: &[NoteOut]) -> Vec<u8> {
    let notes: Vec<Note> = notes
        .iter()
        .map(|n| Note {
            onset: n.onset,
            offset: n.offset,
            pitch: n.pitch,
        })
        .collect();
    super::midi::write_midi(&super::midi::deoverlap_mono(notes))
}

/// 把音符转成 `(onset, offset, pitch, midi)` 四列，界面表格和 CSV 都用它。
pub fn note_rows(notes: &[NoteOut]) -> Vec<(f64, f64, f32, i32)> {
    notes
        .iter()
        .map(|n| (n.onset, n.offset, n.pitch, n.pitch.round() as i32))
        .collect()
}

/// 模型目录里三个图的名字。
///
/// ⚠️ 这三个名字**同时也是** `artifact::ARTIFACTS` 里 `game.models` 那条 `need`
/// 的内容 —— 两份必须一致。留这个常量是因为有几处只想要「三个名字」本身
/// （建夹具、写日志），它们不需要整个产物表。判「齐没齐」一律走 `artifact`。
pub const MODEL_FILES: [&str; 3] = ["encoder.onnx", "segmenter.onnx", "estimator.onnx"];

/* ⚠️ 模型的位置与判据只在 `artifact::ARTIFACTS` 的 `game.models` 里，**别在这
文件里另写壳**，调用方直接问表：
  · 候选目录        → `artifact::dirs_of(root, writable, "game.models")`
  · 当前生效那一层  → `artifact::dir_of(root, writable, "game.models")`
  · 某个目录缺什么  → `artifact::missing_in_dir(dir, "game.models")`
  · 这台机器齐了吗  → `artifact::ready_of(root, writable, "game.models")`

⚠️ 「空目录不算齐」这条语义在表里（`locate` 只认「层里齐全」的），
**不许改成 `d.is_dir()`**。要改那条语义请去 `artifact::locate` 改，别在这里加壳。
⚠️ 「绿色版两层同路径、判层只能比绝对路径」那条也仍然有效，见
`midi_transcribe::status` 的 `origin` 与 `clear_downloads` 的注。 */

#[cfg(test)]
mod tests {
    use super::*;
    use crate::game::algo;
    use std::path::PathBuf;

    /// 一个模型目录：`VSS_MIDI_MODELS` 指到哪儿就用哪儿，否则跳过这条测试。
    fn models_dir() -> Option<PathBuf> {
        std::env::var_os("VSS_MIDI_MODELS").map(PathBuf::from)
    }

    /* ── 只解 `.onnx` 里我们要的那两个字段 ─────────────────────────────
    ONNX 是 protobuf，而这条测试要的东西只有两样：某个初始化张量的名字与形状。
    引一个 protobuf 生成器只为这个不值得（`build.rs` 要跟着吃一份 .proto），
    所以这里按线格式手解 —— 与 `midi_transcribe` 里那条 `mini_onnx_is_a_well_formed_model`
    同一套写法。 */

    /// 解一个 varint，返回 `(值, 吃掉几个字节)`。
    fn take_varint(b: &[u8], i: usize) -> Option<(u64, usize)> {
        let (mut v, mut n) = (0u64, 0usize);
        loop {
            let byte = *b.get(i + n)?;
            v |= ((byte & 0x7f) as u64) << (7 * n);
            n += 1;
            if byte & 0x80 == 0 {
                return Some((v, n));
            }
        }
    }

    /// 把一个 varint 编回线上形状。
    ///
    /// ⚠️ **必须编回 varint，不能存 `to_le_bytes()`**：`fields()` 的消费者都是按
    /// 线格式理解 `value` 的（`tensor_dims` 要把它再解一次，`str_of` 只对 LEN 用）。
    /// 存成定长小端再当 varint 解，等于把 varint 的字节读反 —— 实测 rope 的 5000
    /// （`88 13`）会变成 2440（`13 88`），而 2440 帧这个结论看起来又「很像真的」。
    fn push_varint(out: &mut Vec<u8>, mut v: u64) {
        loop {
            let mut byte = (v & 0x7f) as u8;
            v >>= 7;
            if v != 0 {
                byte |= 0x80;
            }
            out.push(byte);
            if v == 0 {
                return;
            }
        }
    }

    /// 把一个 message 拆成 `(字段号, 线格式, 内容)`。
    ///
    /// ⚠️ **必须能跳过 1/5 号线格式**（定长 64/32 位）：权重里那些 `raw_data`
    /// 就是定长块，遇到它们直接判解析失败的话，整张图的初始化张量一个都读不到
    /// （表现是「图里没有 rope.pe_cos」这种误判）。
    fn fields(b: &[u8]) -> Option<Vec<(u64, u64, Vec<u8>)>> {
        let mut out = Vec::new();
        let mut i = 0;
        while i < b.len() {
            let (tag, n) = take_varint(b, i)?;
            i += n;
            let (num, wire) = (tag >> 3, tag & 7);
            match wire {
                0 => {
                    let (v, n) = take_varint(b, i)?;
                    i += n;
                    let mut raw = Vec::new();
                    push_varint(&mut raw, v);
                    out.push((num, wire, raw));
                }
                1 => {
                    i = i.checked_add(8)?;
                    if i > b.len() {
                        return None;
                    }
                }
                2 => {
                    let (len, n) = take_varint(b, i)?;
                    i += n;
                    let end = i.checked_add(len as usize)?;
                    if end > b.len() {
                        return None;
                    }
                    out.push((num, wire, b[i..end].to_vec()));
                    i = end;
                }
                5 => {
                    i = i.checked_add(4)?;
                    if i > b.len() {
                        return None;
                    }
                }
                _ => return None,
            }
        }
        Some(out)
    }

    fn str_of(f: &[u8]) -> String {
        String::from_utf8_lossy(f).to_string()
    }

    /// `TensorProto.dims`（字段 1，repeated varint）。
    ///
    /// 实测量到的形状是 `[1, 5000, 32]`：dims 是**初始化张量自己的**字段，
    /// 不需要再往里找一层 TensorProto。
    fn tensor_dims(init: &[u8]) -> Vec<u64> {
        fields(init)
            .unwrap_or_default()
            .iter()
            .filter(|(n, wire, _)| *n == 1 && *wire == 0)
            .filter_map(|(_, _, v)| take_varint(v, 0).map(|(x, _)| x))
            .collect()
    }

    /// 从 `encoder.onnx` 里读出 rope 表的帧数。
    ///
    /// ⚠️ **dims 就在初始化张量本身**（`TensorProto` 的字段 1），不需要再往里
    /// 找一层；`name` 是恰好也是 8 的另一个字段（LEN）。实测量到的形状是
    /// `pe_cos` = `[1, 5000, 32]`，取第二维 —— 那就是帧数上限。
    fn rope_frames_from(onnx: &[u8]) -> Option<u64> {
        let top = fields(onnx)?;
        let graph = top
            .iter()
            .find(|(n, _, _)| *n == 7)
            .map(|(_, _, v)| v.clone())?;
        for (num, _, init) in fields(&graph)? {
            if num != 5 {
                continue; // GraphProto.initializer
            }
            let f = fields(&init)?;
            let name = f
                .iter()
                .find(|(n, _, _)| *n == 8)
                .map(|(_, _, v)| str_of(v))
                .unwrap_or_default();
            if !name.ends_with("rope.pe_cos") {
                continue;
            }
            return tensor_dims(&init).get(1).copied();
        }
        None
    }

    /// `MAX_ENCODER_SAMPLES` 这个常量是**照着导出图量化出来的**，不是随便挑的。
    ///
    /// `encoder.onnx` 的 rope 位置编码是导出时冻结的初始化张量 `[1, N, 32]`，超过
    /// N 帧的输入会死在那条应用它的 Mul 节点上：
    ///
    ///   Non-zero status code returned while running Mul node. Name:'node_mul_348'
    ///   Attempting to broadcast an axis by a dimension other than 1. 5000 by 6000
    ///
    /// 所以这条测试直接去**读那张表的真实形状**，断言我们的上限确实在它之下 ——
    /// 上游换一版导出（把 N 改小）时，这里会红，而不是等到用户扒长音频时才炸。
    ///
    ///     $env:VSS_MIDI_MODELS='%APPDATA%\com.qingmu.vocalworkstation\game\models'
    ///     cargo test --lib rope_limit -- --ignored --nocapture
    #[test]
    #[ignore = "要真模型，按需手动跑"]
    fn rope_limit_matches_max_encoder_samples() {
        let Some(dir) = models_dir() else {
            eprintln!("跳过：没有设 VSS_MIDI_MODELS");
            return;
        };
        let bytes = std::fs::read(dir.join("encoder.onnx")).expect("读 encoder.onnx 失败");
        let frames = rope_frames_from(&bytes).expect("图里没有 rope.pe_cos 初始化张量");
        let allowed = (algo::MAX_ENCODER_SAMPLES / 441) as u64;
        println!(
            "rope 表 {frames} 帧；MAX_ENCODER_SAMPLES={} ⇒ {allowed} 帧",
            algo::MAX_ENCODER_SAMPLES
        );
        assert!(
            allowed <= frames,
            "上限 {allowed} 帧超过了图里 rope 表的 {frames} 帧：长音频会死在 Mul 节点上"
        );
        // 也别退得太保守：留太多余量等于白白多切几刀
        assert!(
            allowed * 10 >= frames * 9,
            "上限 {allowed} 帧离 {frames} 帧太远，白白多切"
        );
    }

    /// 真模型上的回归：`encoder.onnx` 的 rope 表是冻结到 **5000 帧**的初始化张量
    /// （`…layers.N.attn.attn.rope.pe_cos/pe_sin` 形状 `[1, 5000, 32]`），比它长的
    /// 输入死在那条应用 rope 的 Mul 节点上，ORT 的原话是
    /// `Attempting to broadcast an axis by a dimension other than 1. 5000 by 6000`。
    /// 而切片器只在**静音处**切 —— 一段连续 3 分钟的人声（没有静音）原来会把整段
    /// 喂给 encoder，于是「部分音频扒谱必失败」，报错还看不出跟长度有关。
    ///
    /// 判定必须落在**真实推理**上：`algo` 侧那条单测只保证切出来的片不超限，
    /// 5000 这个数字是图里的常量，两边对不上的话只有跑一遍图才知道。
    ///
    ///     $env:VSS_MIDI_MODELS='%APPDATA%\com.qingmu.vocalworkstation\game\models'
    ///     cargo test --lib slices_run_through_the_real_encoder -- --ignored --nocapture
    #[test]
    #[ignore = "要真模型，按需手动跑"]
    fn slices_run_through_the_real_encoder() {
        let Some(models) = models_dir() else {
            eprintln!("跳过：没有设 VSS_MIDI_MODELS（见这个测试的注释）");
            return;
        };
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        let Some(dll) = crate::midi_transcribe::runtime_dll(&root, &root.join("data")) else {
            eprintln!("跳过：找不到 onnxruntime（tools/onnxruntime/）");
            return;
        };

        // 3 分钟、每帧都高于 -40 dB 的正弦：切片器判定「整段没有静音」，会原样交给 encoder
        let sr = algo::SAMPLE_RATE as usize;
        let wave: Vec<f32> = (0..sr * 180)
            .map(|i| (i as f32 * 0.05).sin() * 0.5)
            .collect();
        let opts = Options {
            // 1 步就够：这里验的是 encoder 的形状，不是 D3PM 的采样质量
            steps: 1,
            threads: 4,
            device: Device::Cpu,
            ..Options::default()
        };
        let report = transcribe(&models, &dll, &wave, &opts, &|_, _| {})
            .expect("3 分钟连续音频该能扒完（切片器必须把它切到 encoder 的 rope 上限之下）");
        assert!(
            report.slices.len() > 1,
            "3 分钟必须有多次切片，实际 {}",
            report.slices.len()
        );
        for (offset, n) in &report.slices {
            assert!(
                *n <= algo::MAX_ENCODER_SAMPLES,
                "offset={offset} 的切片有 {n} 个采样点，超过 encoder 的 {}",
                algo::MAX_ENCODER_SAMPLES
            );
        }
    }
}
