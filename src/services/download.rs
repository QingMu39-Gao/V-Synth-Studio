//! Pinned HTTP downloads and ZIP extraction shared by the model-backed services.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::Duration;

use sha2::{Digest, Sha256};
use zip::ZipArchive;

use crate::services::jobs::JobContext;

const USER_AGENT: &str = "V-Synth-Studio";

#[allow(clippy::too_many_arguments)]
pub fn fetch(
    url: &str,
    dest: &Path,
    sha256: &str,
    size_hint: u64,
    base: f32,
    span: f32,
    ctx: &JobContext,
    label: &str,
) -> Result<(), String> {
    if dest.is_file() {
        if verify_sha256(dest, sha256)? {
            return Ok(());
        }
        let _ = fs::remove_file(dest);
    }
    let part = dest.with_extension("part");
    let _ = fs::remove_file(&part);
    ctx.log(format!("下载 {label}"));
    ctx.progress(Some(base), format!("下载 {label}"));
    let response = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(30)))
            .timeout_recv_body(Some(Duration::from_secs(60 * 60)))
            .build(),
    )
    .get(url)
    .header("User-Agent", USER_AGENT)
    .call()
    .map_err(|error| format!("下载 {label} 失败：{error}"))?;
    let total = response
        .body()
        .content_length()
        .filter(|length| *length > 0)
        .unwrap_or(size_hint);
    let mut reader = response.into_body().into_reader();
    let mut file = File::create(&part).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut downloaded = 0u64;
    let mut reported = 0u64;
    let mut buffer = [0u8; 256 * 1024];
    loop {
        if ctx.is_canceled() {
            drop(file);
            let _ = fs::remove_file(&part);
            return Err("已取消".to_string());
        }
        let read = reader
            .read(&mut buffer)
            .map_err(|error| format!("下载 {label} 失败：{error}"))?;
        if read == 0 {
            break;
        }
        file.write_all(&buffer[..read])
            .map_err(|error| format!("写入 {label} 失败：{error}"))?;
        hasher.update(&buffer[..read]);
        downloaded += read as u64;
        if downloaded - reported >= 1024 * 1024 || downloaded == total {
            reported = downloaded;
            let fraction = if total > 0 {
                base + span * (downloaded as f32 / total as f32)
            } else {
                base
            };
            ctx.progress(
                Some(fraction.clamp(0.0, 0.99)),
                format!(
                    "下载 {label} {:.1} / {:.1} MB",
                    downloaded as f64 / 1_000_000.0,
                    total as f64 / 1_000_000.0
                ),
            );
        }
    }
    file.flush().map_err(|error| error.to_string())?;
    drop(file);
    let actual = hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    if !actual.eq_ignore_ascii_case(sha256) {
        let _ = fs::remove_file(&part);
        return Err(format!("{label} 校验失败"));
    }
    fs::rename(&part, dest).map_err(|error| format!("保存 {label} 失败：{error}"))?;
    Ok(())
}

pub fn extract_zip(archive: &Path, dest: &Path) -> Result<(), String> {
    let file = File::open(archive).map_err(|error| error.to_string())?;
    let mut zip = ZipArchive::new(file).map_err(|error| format!("解析压缩包失败：{error}"))?;
    for index in 0..zip.len() {
        let mut entry = zip
            .by_index(index)
            .map_err(|error| format!("读取压缩包失败：{error}"))?;
        let name = entry
            .name()
            .map_err(|error| format!("压缩包名称无效：{error}"))?
            .into_owned();
        let Some(relative) = safe_relative(&name) else {
            continue;
        };
        let target = dest.join(&relative);
        if entry.is_dir() {
            fs::create_dir_all(&target).map_err(|error| error.to_string())?;
            continue;
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(format!("压缩包包含符号链接：{name}"));
        }
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut output = File::create(&target)
            .map_err(|error| format!("创建文件失败（{}）：{error}", target.display()))?;
        std::io::copy(&mut entry, &mut output)
            .map_err(|error| format!("解压失败（{}）：{error}", target.display()))?;
    }
    Ok(())
}

fn verify_sha256(path: &Path, expected: &str) -> Result<bool, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 256 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>()
        .eq_ignore_ascii_case(expected))
}

fn safe_relative(name: &str) -> Option<PathBuf> {
    let mut clean = PathBuf::new();
    for component in Path::new(name).components() {
        match component {
            Component::Normal(part) => clean.push(part),
            Component::CurDir => {}
            _ => return None,
        }
    }
    (!clean.as_os_str().is_empty()).then_some(clean)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_unsafe_archive_paths() {
        assert!(safe_relative("../evil").is_none());
        assert!(safe_relative("/abs").is_none());
        assert_eq!(
            safe_relative("numpy/__init__.py"),
            Some(PathBuf::from("numpy/__init__.py"))
        );
    }
}
