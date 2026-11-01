//! Short audio playback through the system media layer.
//!
//! Windows only: `winmm`'s MCI interface is driven with command strings, which
//! keeps the app dependency-free. The device is opened per file and closed
//! again, so only one clip plays at a time.

use std::path::Path;

#[cfg(windows)]
mod windows_mci {
    use std::ffi::c_void;
    use std::path::Path;

    #[link(name = "winmm")]
    unsafe extern "system" {
        fn mciSendStringW(
            command: *const u16,
            buffer: *mut u16,
            length: u32,
            callback: *mut c_void,
        ) -> i32;
        fn mciGetErrorStringW(error: u32, buffer: *mut u16, length: u32) -> u32;
    }

    const ALIAS: &str = "vss-play";
    const BUFFER: usize = 256;

    fn to_wide(value: &str) -> Vec<u16> {
        value.encode_utf16().chain(std::iter::once(0)).collect()
    }

    fn from_wide(buffer: &[u16]) -> String {
        let end = buffer
            .iter()
            .position(|unit| *unit == 0)
            .unwrap_or(buffer.len());
        String::from_utf16_lossy(&buffer[..end])
    }

    fn error_text(code: u32) -> String {
        let mut buffer = vec![0u16; BUFFER];
        unsafe {
            mciGetErrorStringW(code, buffer.as_mut_ptr(), buffer.len() as u32);
        }
        from_wide(&buffer)
    }

    pub fn command(input: &str) -> Result<String, String> {
        let mut buffer = vec![0u16; BUFFER];
        let code = unsafe {
            mciSendStringW(
                to_wide(input).as_ptr(),
                buffer.as_mut_ptr(),
                buffer.len() as u32,
                std::ptr::null_mut(),
            )
        };
        if code == 0 {
            Ok(from_wide(&buffer))
        } else {
            Err(format!("MCI {code}：{}", error_text(code as u32)))
        }
    }

    pub fn alias() -> &'static str {
        ALIAS
    }

    pub fn quoted(path: &Path) -> String {
        path.display().to_string().replace('"', "")
    }
}

#[cfg(windows)]
pub fn open(path: &Path) -> Result<(), String> {
    let _ = close();
    let file = windows_mci::quoted(path);
    // No `type` clause: MCI picks the driver from the extension, which covers
    // both the wave files the page writes and the mp3s it can open.
    windows_mci::command(&format!("open \"{file}\" alias {}", windows_mci::alias()))?;
    Ok(())
}

#[cfg(windows)]
pub fn play() -> Result<(), String> {
    windows_mci::command(&format!("play {}", windows_mci::alias())).map(|_| ())
}

#[cfg(windows)]
pub fn stop() -> Result<(), String> {
    windows_mci::command(&format!("stop {}", windows_mci::alias())).map(|_| ())
}

#[cfg(windows)]
pub fn close() -> Result<(), String> {
    windows_mci::command(&format!("close {}", windows_mci::alias())).map(|_| ())
}

#[cfg(windows)]
pub fn position_ms() -> Option<u64> {
    windows_mci::command(&format!("status {} position", windows_mci::alias()))
        .ok()?
        .trim()
        .parse::<u64>()
        .ok()
}

#[cfg(windows)]
pub fn mode() -> Option<String> {
    windows_mci::command(&format!("status {} mode", windows_mci::alias()))
        .ok()
        .map(|mode| mode.trim().to_string())
}

#[cfg(windows)]
pub fn playing() -> bool {
    mode().as_deref() == Some("playing")
}

#[cfg(not(windows))]
mod unsupported {
    use std::path::Path;

    fn unsupported<T>() -> Result<T, String> {
        Err("该平台不支持预览播放".to_string())
    }

    pub fn open(_: &Path) -> Result<(), String> {
        unsupported()
    }
    pub fn play() -> Result<(), String> {
        unsupported()
    }
    pub fn stop() -> Result<(), String> {
        unsupported()
    }
    pub fn close() -> Result<(), String> {
        unsupported()
    }
    pub fn position_ms() -> Option<u64> {
        None
    }
    pub fn mode() -> Option<String> {
        None
    }
    pub fn playing() -> bool {
        false
    }
}

#[cfg(not(windows))]
pub use unsupported::{close, mode, play, playing, position_ms, stop};

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::io::Write;
    use std::time::Duration;

    #[test]
    #[ignore = "plays sound through the default output device"]
    fn mci_reports_playing_position_and_stops() {
        let path = std::env::temp_dir().join(format!("vss-playback-{}.wav", std::process::id()));
        write_sine_wav(&path);
        open(&path).unwrap();
        play().unwrap();
        std::thread::sleep(Duration::from_millis(400));
        assert!(playing(), "MCI should report playing");
        let first = position_ms().expect("first position");
        std::thread::sleep(Duration::from_millis(400));
        let second = position_ms().expect("second position");
        assert!(second > first, "{first} -> {second}");
        stop().unwrap();
        close().unwrap();
        let _ = std::fs::remove_file(path);
    }

    fn write_sine_wav(path: &Path) {
        let rate = 8000u32;
        let samples: Vec<i16> = (0..rate)
            .map(|index| {
                ((index as f32 / rate as f32 * 220.0 * std::f32::consts::TAU).sin() * 3000.0) as i16
            })
            .collect();
        let mut data = Vec::with_capacity(samples.len() * 2);
        for sample in samples {
            data.extend_from_slice(&sample.to_le_bytes());
        }
        let mut file = std::fs::File::create(path).unwrap();
        file.write_all(b"RIFF").unwrap();
        file.write_all(&(36 + data.len() as u32).to_le_bytes())
            .unwrap();
        file.write_all(b"WAVEfmt ").unwrap();
        file.write_all(&16u32.to_le_bytes()).unwrap();
        file.write_all(&1u16.to_le_bytes()).unwrap();
        file.write_all(&1u16.to_le_bytes()).unwrap();
        file.write_all(&rate.to_le_bytes()).unwrap();
        file.write_all(&(rate * 2).to_le_bytes()).unwrap();
        file.write_all(&2u16.to_le_bytes()).unwrap();
        file.write_all(&16u16.to_le_bytes()).unwrap();
        file.write_all(b"data").unwrap();
        file.write_all(&(data.len() as u32).to_le_bytes()).unwrap();
        file.write_all(&data).unwrap();
    }
}
