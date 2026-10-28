"""Minimal UVR MDX-NET vocal/instrumental separator.

Runs with the bundled embeddable Python (numpy + onnxruntime only). Audio I/O
uses the standard library; the Rust host converts inputs to 44.1 kHz stereo WAV.
"""

import argparse
import sys
import wave

import numpy as np
import onnxruntime as ort

N_FFT = 6144
HOP = 1024
DIM_F = 3072
SEGMENT = 256
OVERLAP = 0.25
TRIM = N_FFT // 2
CHUNK = HOP * (SEGMENT - 1)
GEN = CHUNK - 2 * TRIM


def hann(length):
    if length <= 1:
        return np.ones(max(length, 1), dtype=np.float32)
    return (0.5 - 0.5 * np.cos(2.0 * np.pi * np.arange(length) / length)).astype(np.float32)


WINDOW = hann(N_FFT)


def read_wav(path):
    with wave.open(path, "rb") as source:
        channels = source.getnchannels()
        rate = source.getframerate()
        width = source.getsampwidth()
        frames = source.readframes(source.getnframes())
    if rate != 44100 or width != 2:
        raise SystemExit(f"expected 44.1 kHz 16-bit WAV, got {rate} Hz / {width * 8} bit")
    data = np.frombuffer(frames, dtype="<i2").astype(np.float32) / 32768.0
    if channels == 1:
        data = np.stack([data, data])
    elif channels >= 2:
        data = data.reshape(-1, channels).T[:2]
    else:
        raise SystemExit("unsupported channel count")
    return data.astype(np.float32)


def write_wav(path, data):
    samples = np.clip(data, -1.0, 1.0).T.reshape(-1)
    with wave.open(path, "wb") as target:
        target.setnchannels(2)
        target.setsampwidth(2)
        target.setframerate(44100)
        target.writeframes((samples * 32767.0).astype("<i2").tobytes())


def stft(mix):
    padded = np.pad(mix, ((0, 0), (TRIM, TRIM)), mode="reflect")
    frames = np.lib.stride_tricks.sliding_window_view(padded, N_FFT, axis=1)[:, ::HOP, :]
    spectrum = np.fft.rfft(frames * WINDOW, n=N_FFT, axis=-1)[:, :, :DIM_F]
    spectrum = spectrum.transpose(0, 2, 1)
    stacked = np.stack(
        [spectrum[0].real, spectrum[0].imag, spectrum[1].real, spectrum[1].imag],
        axis=0,
    )[None]
    stacked[:, :, :3, :] = 0
    return np.ascontiguousarray(stacked, dtype=np.float32)


def istft(spectrum):
    spectrum = spectrum[0]
    left = spectrum[0] + 1j * spectrum[1]
    right = spectrum[2] + 1j * spectrum[3]
    pad = np.zeros((N_FFT // 2 + 1 - DIM_F, spectrum.shape[-1]), dtype=np.complex64)
    left = np.concatenate([left, pad], axis=0)
    right = np.concatenate([right, pad], axis=0)
    frames = np.stack(
        [np.fft.irfft(left, n=N_FFT, axis=0), np.fft.irfft(right, n=N_FFT, axis=0)],
        axis=0,
    )
    count = frames.shape[-1]
    output = np.zeros((2, N_FFT + (count - 1) * HOP), dtype=np.float32)
    weight = np.zeros_like(output)
    for index in range(count):
        start = index * HOP
        output[:, start : start + N_FFT] += frames[:, :, index] * WINDOW
        weight[:, start : start + N_FFT] += WINDOW * WINDOW
    output /= np.maximum(weight, 1e-8)
    return output[:, TRIM : TRIM + HOP * (count - 1)]


def demix(session, input_name, mix):
    pad = GEN + TRIM - (mix.shape[1] % GEN)
    mixture = np.concatenate(
        [np.zeros((2, TRIM), dtype=np.float32), mix, np.zeros((2, pad), dtype=np.float32)],
        axis=1,
    )
    step = int((1.0 - OVERLAP) * CHUNK)
    result = np.zeros_like(mixture)
    divider = np.zeros_like(mixture)
    starts = list(range(0, mixture.shape[1], step))
    print(f"chunks={len(starts)}", flush=True)
    for index, start in enumerate(starts):
        end = min(start + CHUNK, mixture.shape[1])
        actual = end - start
        chunk = mixture[:, start:end]
        if actual < CHUNK:
            chunk = np.pad(chunk, ((0, 0), (0, CHUNK - actual)))
        prediction = session.run(None, {input_name: stft(chunk)})[0]
        wave = istft(prediction)[:, :actual]
        local_window = hann(actual)
        result[:, start:end] += wave * local_window[None, :]
        divider[:, start:end] += local_window[None, :]
        print(f"PROGRESS {(index + 1) / len(starts):.4f} {index + 1}/{len(starts)}", flush=True)
    result /= np.maximum(divider, 1e-8)
    return result[:, TRIM : TRIM + mix.shape[1]]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--output-dir", required=True)
    args = parser.parse_args()

    mix = read_wav(args.input)
    session = ort.InferenceSession(args.model, providers=["CPUExecutionProvider"])
    input_name = session.get_inputs()[0].name
    print(f"model_input={session.get_inputs()[0].shape}", flush=True)
    instrumental = demix(session, input_name, mix)
    vocals = mix - instrumental
    write_wav(f"{args.output_dir}/instrumental.wav", instrumental)
    write_wav(f"{args.output_dir}/vocals.wav", vocals)
    print("DONE", flush=True)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"ERROR {error}", file=sys.stderr, flush=True)
        raise
