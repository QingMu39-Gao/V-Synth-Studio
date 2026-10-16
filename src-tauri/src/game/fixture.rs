//! Reader for the raw golden-vector bundle produced by `export/make_golden.py`.
//!
//! Format: a directory holding `index.json` plus one little-endian `.bin` per
//! tensor. **Not `.npz`** -- that is a zip, and the Rust side must not grow a
//! zip dependency just to load test fixtures.

use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};

use ndarray::{ArrayD, IxDyn};
use serde::Deserialize;

#[derive(Debug, Deserialize)]
pub struct Index {
    pub entries: Vec<Entry>,
}

#[derive(Debug, Deserialize)]
pub struct Entry {
    pub name: String,
    pub dtype: String,
    pub shape: Vec<usize>,
    pub file: String,
    pub bytes: usize,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dtype {
    U8,
    F32,
    I64,
}

pub enum Tensor {
    U8(ArrayD<u8>),
    F32(ArrayD<f32>),
    I64(ArrayD<i64>),
}

impl Tensor {
    pub fn shape(&self) -> &[usize] {
        match self {
            Tensor::U8(a) => a.shape(),
            Tensor::F32(a) => a.shape(),
            Tensor::I64(a) => a.shape(),
        }
    }
    pub fn as_f32(&self) -> &ArrayD<f32> {
        match self {
            Tensor::F32(a) => a,
            _ => panic!("tensor is not f32"),
        }
    }
    pub fn as_u8(&self) -> &ArrayD<u8> {
        match self {
            Tensor::U8(a) => a,
            _ => panic!("tensor is not u8"),
        }
    }
    pub fn as_u8_bool(&self) -> ArrayD<bool> {
        self.as_u8().mapv(|v| v != 0)
    }
    pub fn as_i64(&self) -> &ArrayD<i64> {
        match self {
            Tensor::I64(a) => a,
            _ => panic!("tensor is not i64"),
        }
    }
    pub fn as_f32_scalar(&self) -> f32 {
        self.as_f32().iter().next().copied().unwrap_or(f32::NAN)
    }
    pub fn as_i64_scalar(&self) -> i64 {
        self.as_i64().iter().next().copied().unwrap_or(0)
    }
}

pub struct Golden {
    pub dir: PathBuf,
    pub index: Index,
    tensors: HashMap<String, Tensor>,
}

impl Golden {
    pub fn load(dir: impl AsRef<Path>) -> io::Result<Self> {
        let dir = dir.as_ref().to_path_buf();
        let index: Index = serde_json::from_str(&std::fs::read_to_string(dir.join("index.json"))?)?;
        let mut tensors = HashMap::new();
        for e in &index.entries {
            let raw = std::fs::read(dir.join(&e.file))?;
            if raw.len() != e.bytes {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("{}: expected {} bytes, got {}", e.file, e.bytes, raw.len()),
                ));
            }
            let dim = IxDyn(&e.shape);
            let t = match e.dtype.as_str() {
                "u8" => Tensor::U8(ArrayD::from_shape_vec(dim, raw).map_err(to_io)?),
                "f32" => {
                    let v: Vec<f32> = raw
                        .as_chunks::<4>()
                        .0
                        .iter()
                        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
                        .collect();
                    Tensor::F32(ArrayD::from_shape_vec(dim, v).map_err(to_io)?)
                }
                "i64" => {
                    let mut v = Vec::with_capacity(raw.len() / 8);
                    for c in raw.as_chunks::<8>().0 {
                        v.push(i64::from_le_bytes([
                            c[0], c[1], c[2], c[3], c[4], c[5], c[6], c[7],
                        ]));
                    }
                    Tensor::I64(ArrayD::from_shape_vec(dim, v).map_err(to_io)?)
                }
                other => {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidData,
                        format!("unknown dtype {other}"),
                    ));
                }
            };
            tensors.insert(e.name.clone(), t);
        }
        Ok(Self {
            dir,
            index,
            tensors,
        })
    }

    pub fn get(&self, name: &str) -> Option<&Tensor> {
        self.tensors.get(name)
    }

    pub fn require(&self, name: &str) -> &Tensor {
        self.tensors
            .get(name)
            .unwrap_or_else(|| panic!("golden tensor `{name}` not found"))
    }

    pub fn has(&self, name: &str) -> bool {
        self.tensors.contains_key(name)
    }
}

fn to_io(e: ndarray::ShapeError) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, e.to_string())
}

/// Read a raw little-endian f32 buffer.
pub fn read_f32_bin(path: impl AsRef<Path>) -> io::Result<Vec<f32>> {
    let raw = std::fs::read(path.as_ref())?;
    if raw.len() % 4 != 0 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "{}: length {} is not a multiple of 4",
                path.as_ref().display(),
                raw.len()
            ),
        ));
    }
    Ok(raw
        .as_chunks::<4>()
        .0
        .iter()
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect())
}

/// Read a mono `float32` WAV file.
///
/// Only the one format the host pipeline produces is supported
/// (`ffmpeg -ac 1 -ar 44100 -c:a pcm_f32le`). Everything else is ffmpeg's job,
/// exactly as the rest of the workstation does it.
pub fn read_wav_mono_f32(path: &Path) -> io::Result<Vec<f32>> {
    let raw = std::fs::read(path)?;
    if raw.len() < 12 || &raw[0..4] != b"RIFF" || &raw[8..12] != b"WAVE" {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "not a RIFF/WAVE file",
        ));
    }
    let mut pos = 12usize;
    let mut fmt: Option<(u16, u16, u32, u16)> = None; // (format, channels, rate, bits)
    while pos + 8 <= raw.len() {
        let id = &raw[pos..pos + 4];
        let size =
            u32::from_le_bytes([raw[pos + 4], raw[pos + 5], raw[pos + 6], raw[pos + 7]]) as usize;
        let body = pos + 8;
        if body + size > raw.len() {
            break;
        }
        if id == b"fmt " && size >= 16 {
            let format = u16::from_le_bytes([raw[body], raw[body + 1]]);
            let channels = u16::from_le_bytes([raw[body + 2], raw[body + 3]]);
            let rate =
                u32::from_le_bytes([raw[body + 4], raw[body + 5], raw[body + 6], raw[body + 7]]);
            let bits = u16::from_le_bytes([raw[body + 14], raw[body + 15]]);
            fmt = Some((format, channels, rate, bits));
        } else if id == b"data" {
            let (format, channels, rate, bits) = fmt.ok_or_else(|| {
                io::Error::new(io::ErrorKind::InvalidData, "data chunk before fmt chunk")
            })?;
            // 3 == IEEE float. ffmpeg writes WAVE_FORMAT_IEEE_FLOAT for
            // `pcm_f32le`; WAVE_FORMAT_EXTENSIBLE (0xFFFE) shows up when the
            // output carries a channel mask, so accept it and trust the bits.
            if (format != 3 && format != 0xFFFE) || bits != 32 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("expected 32-bit float samples, got format={format} bits={bits}"),
                ));
            }
            if rate != 44100 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!("expected 44100 Hz, got {rate} Hz"),
                ));
            }
            let frames = size / 4 / channels.max(1) as usize;
            let mut out = vec![0f32; frames];
            for (i, slot) in out.iter_mut().enumerate() {
                let mut acc = 0f32;
                for c in 0..channels as usize {
                    let off = body + (i * channels as usize + c) * 4;
                    acc += f32::from_le_bytes([raw[off], raw[off + 1], raw[off + 2], raw[off + 3]]);
                }
                *slot = acc / channels.max(1) as f32;
            }
            return Ok(out);
        }
        pos = body + size + (size & 1);
    }
    Err(io::Error::new(io::ErrorKind::InvalidData, "no data chunk"))
}

/// Flatten a `[steps, 1, T]` (or `[1, steps*T]`) float buffer into per-step rows.
pub fn split_draws(raw: &[f32], n_steps: usize) -> Option<Vec<Vec<f32>>> {
    if n_steps == 0 || !raw.len().is_multiple_of(n_steps) {
        return None;
    }
    let per = raw.len() / n_steps;
    Some(raw.chunks_exact(per).map(|c| c.to_vec()).collect())
}

/// The slicer fixture written by `export/make_slicer_golden.py`.
#[derive(Debug, Deserialize)]
pub struct SlicerGolden {
    pub samplerate: u32,
    pub n_samples: usize,
    pub n_slices: usize,
    pub slices: Vec<SlicerSlice>,
}

#[derive(Debug, Deserialize)]
pub struct SlicerSlice {
    pub offset: f64,
    pub n: usize,
}

/// Minimal `.npy` reader, enough for the 1-D float32 slice the golden bundle
/// was built from. `.npy` is not a zip, so this costs no dependency.
pub fn read_npy_f32(path: impl AsRef<Path>) -> io::Result<ArrayD<f32>> {
    let raw = std::fs::read(path.as_ref())?;
    let bad = |m: String| io::Error::new(io::ErrorKind::InvalidData, m);
    if raw.len() < 10 || &raw[0..6] != b"\x93NUMPY" {
        return Err(bad("not a .npy file (bad magic)".into()));
    }
    let major = raw[6];
    let (hlen, hstart) = if major == 1 {
        (u16::from_le_bytes([raw[8], raw[9]]) as usize, 10usize)
    } else {
        (
            u32::from_le_bytes([raw[8], raw[9], raw[10], raw[11]]) as usize,
            12usize,
        )
    };
    let header = std::str::from_utf8(&raw[hstart..hstart + hlen])
        .map_err(|e| bad(format!("npy header is not utf-8: {e}")))?;
    if !header.contains("'<f4'") && !header.contains("\"<f4\"") {
        return Err(bad(format!(
            "npy dtype is not little-endian float32: {header}"
        )));
    }
    let shape_txt = header
        .split("'shape':")
        .nth(1)
        .or_else(|| header.split("\"shape\":").nth(1))
        .ok_or_else(|| bad("npy header has no shape".into()))?;
    let shape_txt = shape_txt
        .split('(')
        .nth(1)
        .and_then(|s| s.split(')').next())
        .ok_or_else(|| bad("npy shape is malformed".into()))?;
    let dims: Vec<usize> = shape_txt
        .split(',')
        .filter_map(|s| s.trim().parse::<usize>().ok())
        .collect();
    let data = &raw[hstart + hlen..];
    let v: Vec<f32> = data
        .as_chunks::<4>()
        .0
        .iter()
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect();
    let want: usize = dims.iter().product();
    if v.len() != want {
        return Err(bad(format!(
            "npy declares {} elements but holds {}",
            want,
            v.len()
        )));
    }
    ArrayD::from_shape_vec(IxDyn(&dims), v).map_err(to_io)
}
