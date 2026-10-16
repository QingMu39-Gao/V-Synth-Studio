//! Host-side GAME pipeline: everything `encoder.onnx` / `segmenter.onnx` /
//! `estimator.onnx` do NOT do.
//!
//! Where each piece of work lives, and why:
//!
//! | stage                                   | owner            |
//! |-----------------------------------------|------------------|
//! | waveform -> log-mel -> latent           | `encoder.onnx`   |
//! | D3PM boundary removal (stochastic)      | **here**         |
//! | segmenter network + boundary decoding   | `segmenter.onnx` |
//! | pitch estimator network + decoding      | `estimator.onnx` |
//! | region/duration bookkeeping             | **here**         |
//! | slicing, resampling, MIDI writing       | **here**         |
//!
//! The D3PM loop has to live on the host because `t` is a graph *input*: the
//! upstream `WrappedSegmenterModel` (`deployment/exporter.py:25-42`) expects
//! `prev_boundaries` to already be noised by the caller.

use ndarray::{Array1, Array2, Array3, Array4, Axis};

// ---------------------------------------------------------------------------
// constants that mirror the upstream config; see `configs/midi.yaml` @ v1.0.0
// ---------------------------------------------------------------------------

/// `configs/base.yaml`: `audio_sample_rate: 44100`.
pub const SAMPLE_RATE: u32 = 44100;

/// `inference_config.features.timestep`: one frame is 10 ms, and the MIDI
/// network was trained at `hop_size=441` over 44.1 kHz.
pub const TIMESTEP: f32 = 0.01;
/// `boundary_decoding_threshold: 0.2` -- the recommended segmenter threshold.
pub const SEG_THRESHOLD: f32 = 0.2;
/// `boundary_decoding_radius: 0.02` **seconds**; frames = sec / timestep.
pub const SEG_RADIUS_SEC: f32 = 0.02;
/// `note_presence_threshold: 0.2`.
pub const EST_THRESHOLD: f32 = 0.2;
/// `d3pm_sample_t0: 0.0`, `d3pm_sample_steps: 8`.
pub const D3PM_T0: f32 = 0.0;
pub const D3PM_STEPS: usize = 8;
/// `midi_min: 0.0`, `midi_max: 128.0`, `midi_std: 0.5`, `midi_num_bins: 257`.
pub const MIDI_MIN: f32 = 0.0;
pub const MIDI_MAX: f32 = 128.0;
pub const MIDI_STD: f32 = 0.5;
pub const MIDI_BINS: usize = 257;

/// `infer.py:_t0_nstep_to_ts`.
pub fn d3pm_ts(t0: f32, nsteps: usize) -> Vec<f32> {
    let step = (1.0 - t0) / nsteps as f32;
    (0..nsteps).map(|i| t0 + i as f32 * step).collect()
}

/// `modules/d3pm.py:d3pm_time_schedule` -- cosine schedule, returns the
/// probability of *removing* a mutable boundary.
pub fn d3pm_time_schedule(t: f32) -> f32 {
    (1.0 + (t * std::f32::consts::PI).cos()) / 2.0
}

/// SplitMix64 -- the host-side source of the `[0, 1)` uniforms that D3PM needs
/// once the sampling loop is driven from Rust instead of from inside the graph.
///
/// `remove_boundaries` only compares the draw against a threshold, so the exact
/// distribution generator does not matter; what matters is that the draws are
/// genuinely random per step and reproducible from a seed when we want a
/// repeatable run. The low 24 bits of the mantissa give enough resolution for a
/// probability comparison.
pub fn next_uniform(state: &mut u64) -> f32 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^= z >> 31;
    ((z >> 40) as f32) / ((1u32 << 24) as f32)
}

/// `modules/d3pm.py:remove_mutable_boundaries`.
///
/// `boundaries`/`immutable`: `[T]` flags. `rnd`: `[T]` uniforms in `[0, 1)`.
///
/// Semantics worth keeping: the removal probability is rescaled by
/// `n / m` (total vs. mutable boundary count) so that the *expected* number of
/// surviving boundaries matches a uniform-`p` deletion over all boundaries; the
/// rescale is clamped at 1.0, which is why a fully-immutable input removes
/// nothing rather than dividing by zero (`m` is padded by `1e-8`).
pub fn remove_mutable_boundaries(
    boundaries: &[bool],
    immutable: &[bool],
    p: f32,
    rnd: &[f32],
) -> Vec<bool> {
    assert_eq!(boundaries.len(), immutable.len());
    assert_eq!(boundaries.len(), rnd.len());
    let n = boundaries.iter().filter(|b| **b).count() as f32;
    let m = boundaries
        .iter()
        .zip(immutable)
        .filter(|(b, i)| **b && !**i)
        .count() as f32;
    let big_p = (n * p / (m + 1e-8)).min(1.0);
    let q = 1.0 - big_p;
    boundaries
        .iter()
        .zip(immutable)
        .zip(rnd)
        .map(|((b, imm), r)| (*b && !*imm && *r <= q) || *imm)
        .collect()
}

/// `modules/functional.py:boundaries_to_regions`.
///
/// Frames are numbered 1..=N in order; padding frames become 0. Note the
/// cumulative sum is over *boundaries*, so a boundary frame starts a new
/// region rather than ending one.
pub fn boundaries_to_regions(boundaries: &[bool], mask: Option<&[bool]>) -> Vec<i64> {
    let mut acc = 0i64;
    boundaries
        .iter()
        .enumerate()
        .map(|(i, b)| {
            if *b {
                acc += 1;
            }
            let mut r = acc + 1;
            if let Some(m) = mask
                && !m[i]
            {
                r = 0;
            }
            r
        })
        .collect()
}

/// `modules/functional.py:regions_to_durations`, returning the per-region frame
/// counts for regions `1..=max_n`.
pub fn regions_to_durations(regions: &[i64], max_n: usize) -> Vec<i64> {
    let mut out = vec![0i64; max_n + 1];
    for &r in regions {
        if r >= 0 && (r as usize) <= max_n {
            out[r as usize] += 1;
        }
    }
    out[1..].to_vec()
}

/// `modules/functional.py:format_boundaries` -- durations (seconds) back to a
/// boundary frame mask.
///
/// The rounding step matters: PyTorch's `Tensor.round()` is round-half-to-even
/// while Rust's `f32::round()` is half-away-from-zero, so a cumulative duration
/// landing exactly on a half frame would otherwise shift a boundary by one
/// frame. `round_half_even` below is that fix.
pub fn format_boundaries(durations: &[f32], length: usize, timestep: f32) -> Vec<bool> {
    let mut out = vec![false; length];
    let mut cum = 0f32;
    // boundary_indices[..., :-1] -> the last cumulative duration is dropped.
    for &d in &durations[..durations.len().saturating_sub(1)] {
        cum += d;
        let idx = round_half_even(cum / timestep) as i64;
        if idx >= 0 && (idx as usize) < length {
            out[idx as usize] = true;
        }
    }
    out
}

/// IEEE-754 round-half-to-even, matching `torch.round()` / `np.round()`.
pub fn round_half_even(x: f32) -> f32 {
    let r = x.round();
    if (x - x.trunc()).abs() == 0.5 && r % 2.0 != 0.0 {
        r - x.signum()
    } else {
        r
    }
}

/// `modules/decoding.py:find_local_extremum` with `maxima=True`.
///
/// Implemented as the windowed argmax it is upstream: pad with `+inf` on both
/// sides, then "the maximum of every `2r+1` window sits at the center". Because
/// `argmax` reports the *first* maximum, a plateau is won by its leftmost
/// frame, and `+inf` padding suppresses any hit within `radius` of an edge.
pub fn find_local_extremum(x: &[f32], threshold: f32, radius: usize) -> Vec<bool> {
    let t = x.len();
    let mut out = vec![false; t];
    if t == 0 {
        return out;
    }
    let w = 2 * radius + 1;
    for i in 0..t {
        let mut best = usize::MAX;
        let mut best_val = f32::NEG_INFINITY;
        for k in 0..w {
            // index into the +inf-padded array
            let j = i as isize + k as isize - radius as isize;
            let val = if j < 0 || j >= t as isize {
                f32::INFINITY
            } else {
                x[j as usize]
            };
            if val > best_val {
                best_val = val;
                best = k;
            }
        }
        out[i] = best == radius && x[i] >= threshold;
    }
    out
}

/// `modules/decoding.py:decode_soft_boundaries`.
///
/// `boundaries` are sigmoid probabilities (`me_infer.py:63`), `barriers` are
/// the immutable/known boundaries. Both masked positions and barriers become
/// `+inf` so they can never be selected as an extremum.
pub fn decode_soft_boundaries(
    boundaries: &[f32],
    barriers: Option<&[bool]>,
    mask: Option<&[bool]>,
    threshold: f32,
    radius: usize,
) -> Vec<bool> {
    let t = boundaries.len();
    let mut x: Vec<f32> = boundaries.to_vec();
    if let Some(m) = mask {
        for i in 0..t {
            if !m[i] {
                x[i] = f32::INFINITY;
            }
        }
    }
    if let Some(b) = barriers {
        for i in 0..t {
            if b[i] {
                x[i] = f32::INFINITY;
            }
        }
    }
    let mut out = find_local_extremum(&x, threshold, radius);
    if let Some(m) = mask {
        for i in 0..t {
            out[i] &= m[i];
        }
    }
    out
}

/// `modules/decoding.py:decode_gaussian_blurred_probs` -- the soft-argmax pitch
/// read-out.
///
/// `width = ceil(deviation / (max_val - min_val) * (N - 1))`; only bins within
/// `width` of the argmax contribute, weighted by their probability, and the
/// result is a weighted mean over `linspace(min_val, max_val, N)`. That is why
/// `deviation` (here `midi_std * 3 = 1.5` semitones) controls how much
/// neighboring-bin mass pulls the estimate off the integer bin.
pub fn decode_gaussian_blurred_probs(
    probs: &[f32],
    min_val: f32,
    max_val: f32,
    deviation: f32,
    threshold: f32,
) -> (f32, bool) {
    let n = probs.len();
    if n == 0 {
        return (0.0, false);
    }
    let width = (deviation / (max_val - min_val) * (n - 1) as f32).ceil() as usize;
    let center = probs
        .iter()
        .enumerate()
        .fold((0usize, f32::NEG_INFINITY), |acc, (i, v)| {
            if *v > acc.1 { (i, *v) } else { acc }
        })
        .0;
    let start = center.saturating_sub(width);
    let end = (center + width + 1).min(n);
    let mut num = 0f64;
    let mut den = 0f64;
    let mut peak = f32::NEG_INFINITY;
    for (i, &p) in probs.iter().enumerate() {
        if p > peak {
            peak = p;
        }
        if i >= start && i < end {
            let w = p as f64;
            // equivalent to linspace(min_val, max_val, n)[i]
            let v = min_val as f64 + (max_val - min_val) as f64 * i as f64 / (n - 1) as f64;
            num += w * v;
            den += w;
        }
    }
    ((num / (den + 1e-8)) as f32, peak >= threshold)
}

// ---------------------------------------------------------------------------
// ONNX tensor plumbing
// ---------------------------------------------------------------------------

/// Root-mean-square level per frame, used by the slicer. Mirrors
/// `librosa.feature.rms` as called by `inference/slicer2.py`: reflect-free
/// constant padding of `frame_length // 2` on both sides, then a mean of
/// squares over a sliding window.
pub fn rms_frames(y: &[f32], frame_length: usize, hop_length: usize) -> Vec<f32> {
    let pad = frame_length / 2;
    let padded_len = y.len() + 2 * pad;
    // Upstream builds every sliding window first (`as_strided` gives
    // `padded_len - frame_length + 1` of them) and only then strides over the
    // frame axis by `hop_length`. The count is therefore taken in the *padded*
    // domain: `(padded_len - frame_length) / hop + 1`. Using
    // `samples.div_ceil(hop)` instead yields one extra frame for a 10 s input
    // (319 vs 318) and shifts the whole RMS series by one frame.
    let n_frames = if padded_len >= frame_length {
        (padded_len - frame_length) / hop_length + 1
    } else {
        0
    };
    let mut out = Vec::with_capacity(n_frames);
    for f in 0..n_frames {
        let base = f * hop_length;
        let mut sum = 0f64;
        // The window is always fully inside the padded array by construction,
        // so every one of the `frame_length` taps counts -- no early break.
        for k in 0..frame_length {
            let idx = base + k;
            let v = if idx < pad {
                0.0
            } else {
                let src = idx - pad;
                if src < y.len() { y[src] } else { 0.0 }
            };
            sum += (v as f64) * (v as f64);
        }
        out.push((sum / frame_length as f64).sqrt() as f32);
    }
    out
}

/// First index of the minimum, or `None` when the range is empty.
/// Mirrors `np.argmin` (and therefore `np.ndarray.argmin`): on a tie the
/// leftmost index wins, and `None` on an empty slice, which upstream would
/// raise on.
fn argmin_range(x: &[f32], lo: usize, hi: usize) -> Option<usize> {
    let end = hi.min(x.len());
    if lo >= end {
        return None;
    }
    let mut best = lo;
    for i in lo + 1..end {
        if x[i] < x[best] {
            best = i;
        }
    }
    Some(best)
}

/// Maximum number of samples one slice may hand to `encoder.onnx`.
///
/// The exported graph's rotary embedding tables are frozen initializers of
/// `[1, 5000, 32]` (`…layers.N.attn.attn.rope.pe_cos/pe_sin`), so any input
/// longer than 5000 frames fails inside the Mul node that applies them:
/// `Attempting to broadcast an axis by a dimension other than 1. 5000 by N`.
/// 5000 frames is 50 s at 44.1 kHz / hop 441; 49 s leaves room for the frame
/// count not landing exactly on `len / 441` (the cut searches 100 ms back, so
/// the piece lands at 4900 frames at most).
pub const MAX_ENCODER_SAMPLES: usize = 49 * 44_100;

/// 20 ms of samples at 44.1 kHz — the hop of both the slicer's RMS grid and of
/// the `quiet_cut` search window.
const HOP_SAMPLES: usize = 882;

/// `max_sil_kept = 100 ms` in 20 ms frames: the longest silence the upstream
/// slicer cuts through. Also the width of the window [`quiet_cut`] scans.
const SIL_WINDOW_FRAMES: usize = 5;

/// Where to cut a piece that would otherwise exceed [`MAX_ENCODER_SAMPLES`]:
/// the quietest 20 ms frame in the last [`SIL_WINDOW_FRAMES`] frames before
/// `limit`, expressed in samples. Falls back to `limit` when nothing in that
/// window is quieter than the limit itself.
fn quiet_cut(samples: &[f32], limit: usize, hop_size: usize) -> usize {
    let mut best = limit;
    let mut best_rms = f32::MAX;
    // `(lo..limit)` never contains `limit`, so a constant-valued window keeps the
    // fallback and the caller always advances by at least one frame
    let lo = limit - (limit % hop_size).max(SIL_WINDOW_FRAMES * hop_size);
    for f in (lo..limit).step_by(hop_size) {
        let frame = &samples[f..(f + hop_size).min(samples.len())];
        let rms = (frame.iter().map(|x| x * x).sum::<f32>() / frame.len().max(1) as f32).sqrt();
        if rms < best_rms {
            best_rms = rms;
            best = f;
        }
    }
    best
}

/// Split one slice into pieces no longer than [`MAX_ENCODER_SAMPLES`], cutting at
/// the quietest frame inside the 100 ms before the limit.
///
/// Why not cut at the hard limit: a cut lands wherever the sampling happens to
/// be, which is mid-note more often than not. Looking for the quietest frame
/// only moves the cut *earlier*, never past the limit. Notes split by the cut
/// are rejoined by the host's deoverlap pass before the MIDI is written.
fn split_oversized(offset: f64, samples: Vec<f32>, sample_rate: u32) -> Vec<(f64, Vec<f32>)> {
    if samples.len() <= MAX_ENCODER_SAMPLES {
        return vec![(offset, samples)];
    }
    let hop_size = HOP_SAMPLES * sample_rate as usize / SAMPLE_RATE as usize;
    let limit = MAX_ENCODER_SAMPLES / hop_size * hop_size;
    let mut out = Vec::new();
    let mut start = 0usize;
    while samples.len() - start > MAX_ENCODER_SAMPLES {
        let end = start + quiet_cut(&samples[start..], limit, hop_size);
        out.push((
            offset + start as f64 / sample_rate as f64,
            samples[start..end].to_vec(),
        ));
        // `quiet_cut` 的返回值永远 > start（窗口不含 `limit` 本身），这条只是兜底：
        // 切不动就按硬上限切，绝不能原地打转
        start = if end > start { end } else { start + limit };
    }
    out.push((
        offset + start as f64 / sample_rate as f64,
        samples[start..].to_vec(),
    ));
    out
}

/// Split a long waveform into the slices GAME transcribes independently.
///
/// Must match `inference/slicer2.py:Slicer.slice` line by line with the arguments
/// `infer.py` passes (`threshold=-40 dB, min_length=1000 ms, min_interval=200 ms,
/// `max_sil_kept=100 ms, hop_size=20 ms`). The structure matters: only a *loud*
/// frame closes a silence run, `silence_start` is a single recorded position (not
/// a list of runs), and `min_length` is counted in *frames* from `clip_start` —
/// "find silent runs, then cut" yields different slices on real audio.
/// Returns `(offset_seconds, samples)`, to be shifted back by `offset` when the
/// MIDI is written (each slice carries `known_durations = [slice length]`).
///
/// The cuts above are upstream's; on top of them every slice longer than
/// [`MAX_ENCODER_SAMPLES`] is additionally split by [`split_oversized`], which is
/// why the returned offsets are not all silence positions.
pub fn slice_waveform(y: &[f32], sample_rate: u32) -> Vec<(f64, Vec<f32>)> {
    const THRESHOLD_DB: f32 = -40.0;
    const MIN_LENGTH_MS: f32 = 1000.0;
    const MIN_INTERVAL_MS: f32 = 200.0;
    const HOP_MS: f32 = 20.0;

    let threshold = 10f32.powf(THRESHOLD_DB / 20.0);
    let hop_size = (sample_rate as f32 * HOP_MS / 1000.0).round() as usize;
    let min_interval_samples = sample_rate as f32 * MIN_INTERVAL_MS / 1000.0;
    let win_size = (min_interval_samples.round() as usize).min(4 * hop_size);
    let min_length =
        (sample_rate as f32 * MIN_LENGTH_MS / 1000.0 / hop_size as f32).round() as usize;
    let min_interval = (min_interval_samples / hop_size as f32).round() as usize;
    // `(samples.shape[0] + hop - 1) // hop <= min_length` -> leave it whole.
    let hop_frames = y.len().div_ceil(hop_size);
    if hop_frames <= min_length || y.is_empty() {
        return split_oversized(0.0, y.to_vec(), sample_rate);
    }

    let rms = rms_frames(y, win_size, hop_size);

    // Each tag is a (begin, end) pair of *frame* positions in the cut sense;
    // `total_frames + 1` is the upstream sentinel for "to the very end".
    let mut sil_tags: Vec<(usize, usize)> = Vec::new();
    let mut silence_start: Option<usize> = None;
    let mut clip_start: usize = 0;

    for (i, r) in rms.iter().enumerate() {
        // Keep looping while frame is silent.
        if *r < threshold {
            if silence_start.is_none() {
                silence_start = Some(i);
            }
            continue;
        }
        // Keep looping while frame is not silent and no silence was recorded.
        let s = match silence_start {
            Some(s) => s,
            None => continue,
        };

        let is_leading_silence = s == 0 && i > SIL_WINDOW_FRAMES;
        let need_slice_middle = i - s >= min_interval && i - clip_start >= min_length;
        if !is_leading_silence && !need_slice_middle {
            silence_start = None;
            continue;
        }

        if i - s <= SIL_WINDOW_FRAMES {
            let pos = argmin_range(&rms, s, i + 1).unwrap_or(s);
            if s == 0 {
                sil_tags.push((0, pos));
            } else {
                sil_tags.push((pos, pos));
            }
            clip_start = pos;
        } else if i - s <= SIL_WINDOW_FRAMES * 2 {
            // `argmin_range` already yields an *absolute* frame index, whereas
            // upstream's `rms_list[a:b].argmin()` yields an offset that then has
            // to be shifted back. Only the ranges that start at `s` (or that
            // need the `pos` comparison) are kept verbatim.
            let pos = argmin_range(
                &rms,
                i.saturating_sub(SIL_WINDOW_FRAMES),
                s + SIL_WINDOW_FRAMES + 1,
            )
            .unwrap_or(s);
            let pos_l = argmin_range(&rms, s, s + SIL_WINDOW_FRAMES + 1).unwrap_or(s);
            let pos_r = argmin_range(&rms, i.saturating_sub(SIL_WINDOW_FRAMES), i + 1).unwrap_or(s);
            if s == 0 {
                sil_tags.push((0, pos_r));
                clip_start = pos_r;
            } else {
                sil_tags.push((pos_l.min(pos), pos_r.max(pos)));
                clip_start = pos_r.max(pos);
            }
        } else {
            let pos_l = argmin_range(&rms, s, s + SIL_WINDOW_FRAMES + 1).unwrap_or(s);
            let pos_r = argmin_range(&rms, i.saturating_sub(SIL_WINDOW_FRAMES), i + 1).unwrap_or(s);
            if s == 0 {
                sil_tags.push((0, pos_r));
            } else {
                sil_tags.push((pos_l, pos_r));
            }
            clip_start = pos_r;
        }
        silence_start = None;
    }

    // Deal with trailing silence. `total_frames` here is the number of frames the
    // RMS pass actually produced, which is one more than the `div_ceil` count
    // used for the short-input test above.
    let total_frames = rms.len();
    if let Some(s) = silence_start
        && total_frames - s >= min_interval
    {
        let silence_end = total_frames.min(s + SIL_WINDOW_FRAMES);
        let pos = argmin_range(&rms, s, silence_end + 1).unwrap_or(s);
        sil_tags.push((pos, total_frames + 1));
    }

    if sil_tags.is_empty() {
        return split_oversized(0.0, y.to_vec(), sample_rate);
    }

    let apply = |begin: usize, end: usize| -> (f64, Vec<f32>) {
        let s = begin * hop_size;
        let e = (end * hop_size).min(y.len());
        (s as f64 / sample_rate as f64, y[s.min(y.len())..e].to_vec())
    };

    let mut chunks: Vec<(f64, Vec<f32>)> = Vec::new();
    if sil_tags[0].0 > 0 {
        chunks.push(apply(0, sil_tags[0].0));
    }
    for w in sil_tags.windows(2) {
        chunks.push(apply(w[0].1, w[1].0));
    }
    if sil_tags[sil_tags.len() - 1].1 < total_frames {
        chunks.push(apply(sil_tags[sil_tags.len() - 1].1, total_frames));
    }
    if chunks.is_empty() {
        split_oversized(0.0, y.to_vec(), sample_rate)
    } else {
        chunks
            .into_iter()
            .flat_map(|(o, s)| split_oversized(o, s, sample_rate))
            .collect()
    }
}

/// Linear resampling to 44.1 kHz.
///
/// GAME only ever sees 44100 Hz mono (`inference/data.py` calls
/// `librosa.load(..., sr=44100, mono=True)`), and `encoder.onnx` derives its
/// frame count purely from `duration`, so getting this wrong shifts every note.
pub fn resample_linear(y: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || y.is_empty() {
        return y.to_vec();
    }
    let ratio = to as f64 / from as f64;
    let out_len = ((y.len() as f64) * ratio).round() as usize;
    let mut out = Vec::with_capacity(out_len);
    for i in 0..out_len {
        let pos = i as f64 / ratio;
        let i0 = pos.floor() as usize;
        let frac = (pos - i0 as f64) as f32;
        let a = y.get(i0).copied().unwrap_or(0.0);
        let b = y.get(i0 + 1).copied().unwrap_or(a);
        out.push(a + (b - a) * frac);
    }
    out
}

/// Mix arbitrary channel count down to mono by averaging.
pub fn to_mono(channels: &[Vec<f32>]) -> Vec<f32> {
    match channels.len() {
        0 => Vec::new(),
        1 => channels[0].clone(),
        n => {
            let len = channels.iter().map(|c| c.len()).min().unwrap_or(0);
            (0..len)
                .map(|i| channels.iter().map(|c| c[i]).sum::<f32>() / n as f32)
                .collect()
        }
    }
}

// ---------------------------------------------------------------------------
// batched helpers used by the harness
// ---------------------------------------------------------------------------

/// `boundaries_to_regions` over a batch, returning `[B, T]`.
pub fn regions_batch(boundaries: &Array2<bool>, mask: &Array2<bool>) -> Array2<i64> {
    let b = boundaries.nrows();
    let t = boundaries.ncols();
    let mut out = Array2::<i64>::zeros((b, t));
    for i in 0..b {
        let row: Vec<bool> = boundaries.row(i).iter().copied().collect();
        let m: Vec<bool> = mask.row(i).iter().copied().collect();
        let r = boundaries_to_regions(&row, Some(&m));
        for j in 0..t {
            out[[i, j]] = r[j];
        }
    }
    out
}

/// Column-wise argmax over the last axis of a `[N, C]` block, used to sanity
/// check the estimator output against the encoded MIDI pitches.
pub fn argmax_rows(x: &Array2<f32>) -> Array1<usize> {
    let n = x.nrows();
    let mut out = Array1::<usize>::zeros(n);
    for i in 0..n {
        let mut best = 0usize;
        let mut bv = f32::NEG_INFINITY;
        for (j, v) in x.row(i).iter().enumerate() {
            if *v > bv {
                bv = *v;
                best = j;
            }
        }
        out[i] = best;
    }
    out
}

/// Reduce a `[B, T, C]` block to `[T, C]` by taking row 0. The engine always
/// runs batch size 1; batching exists only for the golden vectors.
pub fn first_batch(x: &Array3<f32>) -> Array2<f32> {
    x.index_axis(Axis(0), 0).to_owned()
}

/// Same for `[B, H, T, C]`.
pub fn first_batch4(x: &Array4<f32>) -> Array3<f32> {
    x.index_axis(Axis(0), 0).to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ts_schedule_matches_upstream() {
        let ts = d3pm_ts(0.0, 8);
        assert_eq!(ts.len(), 8);
        assert!((ts[0] - 0.0).abs() < 1e-7);
        assert!((ts[7] - 0.875).abs() < 1e-7);
        // cosine schedule: t=0 -> p=1 (delete everything), t->1 -> p->0
        assert!((d3pm_time_schedule(0.0) - 1.0).abs() < 1e-6);
        assert!(d3pm_time_schedule(0.875) < 0.05);
    }

    #[test]
    fn round_half_even_matches_torch() {
        assert_eq!(round_half_even(0.5), 0.0);
        assert_eq!(round_half_even(1.5), 2.0);
        assert_eq!(round_half_even(2.5), 2.0);
        assert_eq!(round_half_even(-0.5), 0.0);
        assert_eq!(round_half_even(2.4), 2.0);
    }

    #[test]
    fn regions_are_one_based_and_mask_zeroes() {
        // NOTE the off-by-one that looks wrong and is not: `boundaries_to_regions`
        // is `cumsum(boundaries) + 1`, so a boundary *at* frame 0 pushes the
        // first frame to region 2. Region 1 only exists if frame 0 is not a
        // boundary, and with `mask[0]=true, boundaries[0]=false` the first three
        // frames therefore land in region 1 only when no earlier boundary fired.
        let b = [false, true, false, true, false];
        let m = [true, true, true, true, false];
        assert_eq!(boundaries_to_regions(&b, Some(&m)), vec![1, 2, 2, 3, 0]);
        assert_eq!(boundaries_to_regions(&b, None), vec![1, 2, 2, 3, 3]);
        assert_eq!(regions_to_durations(&[1, 2, 2, 3, 3], 3), vec![1, 2, 2]);
        // A boundary on the first frame starts the count at 2.
        let b0 = [true, false, false];
        assert_eq!(boundaries_to_regions(&b0, None), vec![2, 2, 2]);
    }

    #[test]
    fn mutable_removal_keeps_immutable_and_scales_probability() {
        // p = 1 must delete every mutable boundary but never an immutable one.
        // NOTE: rnd must be > 0.0 here. `remove_boundaries` keeps a frame when
        // `rnd <= q`, and at p=1 we get q=0, so a random draw of exactly 0.0
        // would *keep* it -- the inclusive `<=` matters.
        let b = [true, true, true, false];
        let imm = [true, false, false, false];
        let out = remove_mutable_boundaries(&b, &imm, 1.0, &[0.5, 0.5, 0.5, 0.5]);
        assert_eq!(out, vec![true, false, false, false]);
        // p = 0 keeps everything.
        let out = remove_mutable_boundaries(&b, &imm, 0.0, &[0.9, 0.9, 0.9, 0.9]);
        assert_eq!(out, vec![true, true, true, false]);
    }

    #[test]
    fn local_extremum_matches_argmax_semantics() {
        // A plateau is won by its leftmost frame.
        let x = [0.0, 1.0, 1.0, 0.0];
        let out = find_local_extremum(&x, 0.5, 1);
        assert_eq!(out, vec![false, true, false, false]);
        // Radius 2 plus +inf padding kills any hit near the edges.
        let out = find_local_extremum(&x, 0.5, 2);
        assert!(out.iter().all(|b| !*b));
    }

    #[test]
    fn gaussian_decode_is_bounded_and_uses_three_sigma_width() {
        let n = MIDI_BINS;
        let width = (MIDI_STD * 3.0 / (MIDI_MAX - MIDI_MIN) * (n - 1) as f32).ceil();
        assert_eq!(width, 3.0);
        // Bin i carries the score `0.5 * i`, because `centers` is
        // `linspace(0, 128, 257)` -- one MIDI semitone spans TWO bins. So a
        // spike in bin 69 decodes to 34.5 semitones, not 69.
        let mut probs = vec![0.001f32; n];
        probs[69] = 0.9;
        let (v, present) = decode_gaussian_blurred_probs(
            &probs,
            MIDI_MIN,
            MIDI_MAX,
            MIDI_STD * 3.0,
            EST_THRESHOLD,
        );
        assert!(present);
        assert!((v - 34.5).abs() < 0.5, "decoded {v}, expected ~34.5");
        // And the inverse: a semitone value round-trips through bin space.
        let mut probs = vec![0.0f32; n];
        let want = 69.0f32; // A4
        probs[(want / (MIDI_MAX - MIDI_MIN) * (n - 1) as f32).round() as usize] = 1.0;
        let (v, present) = decode_gaussian_blurred_probs(
            &probs,
            MIDI_MIN,
            MIDI_MAX,
            MIDI_STD * 3.0,
            EST_THRESHOLD,
        );
        assert!(present);
        assert!((v - want).abs() < 0.5, "decoded {v}, expected ~{want}");
    }

    #[test]
    fn resample_roundtrips_length() {
        let y = vec![0.0f32; 48000];
        let z = resample_linear(&y, 48000, 44100);
        assert_eq!(z.len(), 44100);
    }

    /// `encoder.onnx`'s rope tables are frozen at 5000 frames, so a slice longer
    /// than that dies inside its Mul node with
    /// `Attempting to broadcast an axis by a dimension other than 1. 5000 by N`
    /// (reproduced on the real graph with a 60 s mono buffer). A continuous 3 min
    /// vocal has no silence for the slicer to cut at, so it hands the encoder the
    /// whole buffer; every returned piece must therefore stay under the limit and
    /// the pieces must still tile the input in order, offsets included.
    #[test]
    fn long_slices_are_split_below_the_encoder_rope_limit() {
        let sr = SAMPLE_RATE;
        let n = sr as usize * 180;
        // `sin` keeps every frame above the -40 dB silence threshold, so the
        // slicer returns the buffer whole.
        let y: Vec<f32> = (0..n).map(|i| (i as f32 * 0.05).sin() * 0.5).collect();
        let slices = slice_waveform(&y, sr);

        assert!(slices.len() >= 3, "3 分钟要切成至少 3 段：{}", slices.len());
        let mut at = 0usize;
        for (i, (offset, chunk)) in slices.iter().enumerate() {
            assert!(
                chunk.len() <= MAX_ENCODER_SAMPLES,
                "第 {i} 段 {} 个采样点，超过 encoder 的 {}",
                chunk.len(),
                MAX_ENCODER_SAMPLES
            );
            let want_offset = at as f64 / sr as f64;
            assert!(
                (offset - want_offset).abs() < 1e-9,
                "第 {i} 段的偏移 {offset} 与已消费的采样点对不上（应为 {want_offset}）"
            );
            assert_eq!(
                &y[at..at + chunk.len()],
                &chunk[..],
                "第 {i} 段的内容不是原音频的切片"
            );
            at += chunk.len();
        }
        assert_eq!(at, n, "切完必须正好覆盖整段音频");
    }
}
