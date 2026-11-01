"""GAME vocal-to-MIDI host pipeline for the embedded Python runtime.

The three ONNX graphs own feature extraction, boundary denoising and pitch
estimation; this script owns slicing, the D3PM sampling loop, region
bookkeeping and the note JSON consumed by the Rust host.
"""

import argparse
import json
import sys
import time

import numpy as np
import onnxruntime as ort

SAMPLE_RATE = 44100
TIMESTEP = 0.01
SEG_THRESHOLD = 0.2
SEG_RADIUS_SEC = 0.02
EST_THRESHOLD = 0.2
D3PM_T0 = 0.0
D3PM_STEPS = 8
MAX_ENCODER_SAMPLES = 49 * 44100
HOP_SAMPLES = 882
SIL_WINDOW_FRAMES = 5


def read_wav(path):
    raw = open(path, "rb").read()
    if len(raw) < 12 or raw[0:4] != b"RIFF" or raw[8:12] != b"WAVE":
        raise SystemExit("not a RIFF/WAVE file")
    pos = 12
    fmt = None
    data = None
    while pos + 8 <= len(raw):
        cid = raw[pos : pos + 4]
        size = int.from_bytes(raw[pos + 4 : pos + 8], "little")
        body = pos + 8
        if body + size > len(raw):
            break
        if cid == b"fmt " and size >= 16:
            tag = int.from_bytes(raw[body : body + 2], "little")
            channels = int.from_bytes(raw[body + 2 : body + 4], "little")
            rate = int.from_bytes(raw[body + 4 : body + 8], "little")
            bits = int.from_bytes(raw[body + 14 : body + 16], "little")
            if tag == 0xFFFE and size >= 40:
                tag = int.from_bytes(raw[body + 24 : body + 26], "little")
            fmt = (tag, channels, rate, bits)
        elif cid == b"data":
            data = raw[body : body + size]
            break
        pos = body + size + (size & 1)
    if fmt is None or data is None:
        raise SystemExit("missing fmt or data chunk")
    tag, channels, rate, bits = fmt
    if rate != SAMPLE_RATE:
        raise SystemExit(f"expected {SAMPLE_RATE} Hz, got {rate}")
    if tag == 3 and bits == 32:
        audio = np.frombuffer(data, dtype="<f4").astype(np.float32)
    elif tag == 1 and bits == 16:
        audio = np.frombuffer(data, dtype="<i2").astype(np.float32) / 32768.0
    else:
        raise SystemExit(f"unsupported WAV format {tag}/{bits}")
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    return audio


def d3pm_ts(t0, steps):
    step = (1.0 - t0) / steps
    return [t0 + i * step for i in range(steps)]


def d3pm_time_schedule(t):
    return (1.0 + np.cos(t * np.pi)) / 2.0


def remove_mutable_boundaries(boundaries, immutable, p, rnd):
    n = float(boundaries.sum())
    m = float((boundaries & ~immutable).sum())
    big_p = min(n * p / (m + 1e-8), 1.0)
    q = 1.0 - big_p
    return (boundaries & ~immutable & (rnd <= q)) | immutable


def rms_frames(y, frame_length, hop_length):
    pad = frame_length // 2
    padded = np.pad(y, (pad, pad), mode="constant")
    if len(padded) < frame_length:
        return np.zeros(0, dtype=np.float32)
    frames = np.lib.stride_tricks.sliding_window_view(padded, frame_length)[::hop_length]
    return np.sqrt(np.mean(frames * frames, axis=1)).astype(np.float32)


def argmin_range(x, lo, hi):
    hi = min(hi, len(x))
    if lo >= hi:
        return None
    return lo + int(np.argmin(x[lo:hi]))


def quiet_cut(samples, limit, hop_size):
    best = limit
    best_rms = np.inf
    lo = limit - max(limit % hop_size, SIL_WINDOW_FRAMES * hop_size)
    for f in range(lo, limit, hop_size):
        frame = samples[f : min(f + hop_size, len(samples))]
        rms = float(np.sqrt(np.mean(frame * frame))) if len(frame) else 0.0
        if rms < best_rms:
            best_rms = rms
            best = f
    return best


def split_oversized(offset, samples, sample_rate):
    if len(samples) <= MAX_ENCODER_SAMPLES:
        return [(offset, samples)]
    hop_size = HOP_SAMPLES * sample_rate // SAMPLE_RATE
    limit = MAX_ENCODER_SAMPLES // hop_size * hop_size
    out = []
    start = 0
    while len(samples) - start > MAX_ENCODER_SAMPLES:
        end = start + quiet_cut(samples[start:], limit, hop_size)
        out.append((offset + start / sample_rate, samples[start:end]))
        start = end if end > start else start + limit
    out.append((offset + start / sample_rate, samples[start:]))
    return out


def slice_waveform(y, sample_rate):
    threshold_db = -40.0
    min_length_ms = 1000.0
    min_interval_ms = 200.0
    hop_ms = 20.0
    threshold = 10.0 ** (threshold_db / 20.0)
    hop_size = int(round(sample_rate * hop_ms / 1000.0))
    min_interval_samples = sample_rate * min_interval_ms / 1000.0
    win_size = min(int(round(min_interval_samples)), 4 * hop_size)
    min_length = int(round(min_interval_samples / hop_size))
    min_interval = int(round(min_interval_samples / hop_size))
    hop_frames = (len(y) + hop_size - 1) // hop_size
    if hop_frames <= min_length or len(y) == 0:
        return split_oversized(0.0, y, sample_rate)

    rms = rms_frames(y, win_size, hop_size)
    sil_tags = []
    silence_start = None
    clip_start = 0
    for i, r in enumerate(rms):
        if r < threshold:
            if silence_start is None:
                silence_start = i
            continue
        if silence_start is None:
            continue
        s = silence_start
        is_leading = s == 0 and i > SIL_WINDOW_FRAMES
        need_middle = i - s >= min_interval and i - clip_start >= min_length
        if not is_leading and not need_middle:
            silence_start = None
            continue
        if i - s <= SIL_WINDOW_FRAMES:
            pos = argmin_range(rms, s, i + 1)
            pos = s if pos is None else pos
            sil_tags.append((0, pos) if s == 0 else (pos, pos))
            clip_start = pos
        elif i - s <= SIL_WINDOW_FRAMES * 2:
            pos = argmin_range(rms, max(i - SIL_WINDOW_FRAMES, 0), s + SIL_WINDOW_FRAMES + 1)
            pos_l = argmin_range(rms, s, s + SIL_WINDOW_FRAMES + 1)
            pos_r = argmin_range(rms, max(i - SIL_WINDOW_FRAMES, 0), i + 1)
            pos = s if pos is None else pos
            pos_l = s if pos_l is None else pos_l
            pos_r = s if pos_r is None else pos_r
            if s == 0:
                sil_tags.append((0, pos_r))
                clip_start = pos_r
            else:
                sil_tags.append((min(pos_l, pos), max(pos_r, pos)))
                clip_start = max(pos_r, pos)
        else:
            pos_l = argmin_range(rms, s, s + SIL_WINDOW_FRAMES + 1)
            pos_r = argmin_range(rms, max(i - SIL_WINDOW_FRAMES, 0), i + 1)
            pos_l = s if pos_l is None else pos_l
            pos_r = s if pos_r is None else pos_r
            if s == 0:
                sil_tags.append((0, pos_r))
            else:
                sil_tags.append((pos_l, pos_r))
            clip_start = pos_r
        silence_start = None

    total_frames = len(rms)
    if silence_start is not None and total_frames - silence_start >= min_interval:
        silence_end = min(total_frames, silence_start + SIL_WINDOW_FRAMES)
        pos = argmin_range(rms, silence_start, silence_end + 1)
        pos = silence_start if pos is None else pos
        sil_tags.append((pos, total_frames + 1))

    if not sil_tags:
        return split_oversized(0.0, y, sample_rate)

    chunks = []

    def apply(begin, end):
        s = begin * hop_size
        e = min(end * hop_size, len(y))
        return (s / sample_rate, y[min(s, len(y)) : e])

    if sil_tags[0][0] > 0:
        chunks.append(apply(0, sil_tags[0][0]))
    for left, right in zip(sil_tags, sil_tags[1:]):
        chunks.append(apply(left[1], right[0]))
    if sil_tags[-1][1] < total_frames:
        chunks.append(apply(sil_tags[-1][1], total_frames))
    if not chunks:
        return split_oversized(0.0, y, sample_rate)
    result = []
    for offset, samples in chunks:
        result.extend(split_oversized(offset, samples, sample_rate))
    return result


def boundaries_to_regions(boundaries, mask):
    regions = np.cumsum(boundaries.astype(np.int64)) + 1
    if mask is not None:
        regions = np.where(mask, regions, 0)
    return regions


def regions_to_durations(regions, max_n):
    out = np.zeros(max_n + 1, dtype=np.int64)
    for r in regions:
        if 0 <= r <= max_n:
            out[r] += 1
    return out[1:]


def make_session(path, threads, use_cuda):
    options = ort.SessionOptions()
    options.intra_op_num_threads = max(1, threads)
    options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    providers = ["CPUExecutionProvider"]
    if use_cuda:
        providers = ["CUDAExecutionProvider", "CPUExecutionProvider"]
    return ort.InferenceSession(path, sess_options=options, providers=providers)


def progress(fraction, text):
    print(f"PROGRESS {max(0.0, min(1.0, fraction)):.4f} {text}", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--models", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--steps", type=int, default=D3PM_STEPS)
    parser.add_argument("--threads", type=int, default=4)
    parser.add_argument("--language", type=int, default=4)
    parser.add_argument("--device", default="auto")
    args = parser.parse_args()

    wave = read_wav(args.input)
    if wave.size == 0:
        raise SystemExit("empty audio")
    steps = max(1, args.steps)
    use_cuda = args.device == "gpu"
    progress(0.005, "载入模型")

    models = args.models.rstrip("/\\")
    enc = make_session(f"{models}/encoder.onnx", args.threads, use_cuda)
    seg = make_session(f"{models}/segmenter.onnx", args.threads, use_cuda)
    est = make_session(f"{models}/estimator.onnx", args.threads, use_cuda)
    backend = "CUDA" if "CUDAExecutionProvider" in enc.get_providers() else "CPU"
    print(f"backend={backend}", flush=True)

    ts = d3pm_ts(D3PM_T0, steps)
    radius = int(round(SEG_RADIUS_SEC / TIMESTEP))
    slices = slice_waveform(wave, SAMPLE_RATE)
    print(f"chunks={len(slices)}", flush=True)
    if not slices:
        with open(args.output, "w", encoding="utf-8") as target:
            json.dump({"notes": [], "slices": [], "backend": backend}, target)
        print("DONE", flush=True)
        return

    seg_inputs = {item.name for item in seg.get_inputs()}
    seg_takes_rnd = "rnd" in seg_inputs
    rng = np.random.default_rng(0x20261003)
    total = sum(len(chunk) for _, chunk in slices)
    done = 0
    notes = []
    per_step = []
    timings = {"encoder": 0.0, "segmenter": 0.0, "estimator": 0.0}

    for si, (offset, chunk) in enumerate(slices):
        base = done / total
        share = len(chunk) / total
        tag = f"第 {si + 1}/{len(slices)} 段" if len(slices) > 1 else "正在扒谱"
        progress(base, f"{tag}：提取特征")
        started = time.time()
        enc_out = enc.run(None, {
            enc.get_inputs()[0].name: chunk[None, :].astype(np.float32),
            enc.get_inputs()[1].name: np.array([len(chunk) / SAMPLE_RATE], dtype=np.float32),
        })
        enc_values = {item.name: value for item, value in zip(enc.get_outputs(), enc_out)}
        timings["encoder"] += time.time() - started
        x_seg = enc_values["x_seg"]
        x_est = enc_values["x_est"]
        mask_t = np.asarray(enc_values["maskT"]).reshape(-1).astype(bool)
        t_len = mask_t.size

        known = np.zeros(t_len, dtype=bool)
        prev = known.copy()
        started = time.time()
        for step, tv in enumerate(ts):
            p = d3pm_time_schedule(tv)
            rnd = rng.random(t_len, dtype=np.float32)
            noised = remove_mutable_boundaries(prev, known, p, rnd) if seg_takes_rnd else prev
            feed = {
                "x_seg": x_seg,
                "language": np.array([args.language], dtype=np.int64),
                "known_boundaries": known[None, :],
                "prev_boundaries": noised[None, :],
                "t": np.array([tv], dtype=np.float32),
                "maskT": mask_t[None, :],
                "threshold": np.array(SEG_THRESHOLD, dtype=np.float32),
                "radius": np.array(radius, dtype=np.int64),
            }
            if seg_takes_rnd:
                feed["rnd"] = rnd[None, :]
            out = seg.run(None, feed)
            prev = np.asarray(out[0]).reshape(-1).astype(bool)
            count = int(prev.sum())
            per_step.append(count)
            progress(
                base + share * (step + 1) / (steps + 1),
                f"{tag}：去噪 {step + 1}/{steps}（候选边界 {count} 个）",
            )
        timings["segmenter"] += time.time() - started

        regions = boundaries_to_regions(prev, mask_t)
        max_n = int(regions.max()) if regions.size else 0
        if max_n <= 0:
            done += len(chunk)
            continue
        durations = regions_to_durations(regions, max_n)
        progress(base + share * steps / (steps + 1), f"{tag}：判断音高")
        started = time.time()
        est_out = est.run(None, {
            "x_est": x_est,
            "boundaries": prev[None, :],
            "maskT": mask_t[None, :],
            "maskN": np.ones((1, max_n), dtype=bool),
            "threshold": np.array(EST_THRESHOLD, dtype=np.float32),
        })
        timings["estimator"] += time.time() - started
        est_values = {item.name: value for item, value in zip(est.get_outputs(), est_out)}
        presence = np.asarray(est_values["presence"]).reshape(-1).astype(bool)
        scores = np.asarray(est_values["scores"]).reshape(-1).astype(np.float32)

        cursor = offset
        for i, raw in enumerate(durations[:max_n]):
            end = cursor + float(raw) * TIMESTEP
            onset = cursor
            cursor = end
            if i >= presence.size or not presence[i] or end - onset <= 0.0:
                continue
            pitch = float(scores[i]) if i < scores.size else 0.0
            notes.append({"onset": onset, "offset": end, "pitch": pitch})
        done += len(chunk)

    notes.sort(key=lambda n: (n["onset"], n["offset"], n["pitch"]))
    payload = {
        "backend": backend,
        "notes": notes,
        "slices": [{"offset": o, "samples": len(c)} for o, c in slices],
        "perStep": per_step,
        "seconds": timings,
    }
    with open(args.output, "w", encoding="utf-8") as target:
        json.dump(payload, target)
    progress(1.0, "完成")
    print("DONE", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"ERROR {error}", file=sys.stderr, flush=True)
        raise
