//! Check the GPUI update manifest, download the setup and hand it to NSIS.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde_json::Value;

use crate::services::download;
use crate::services::jobs::JobContext;

const MANIFEST_URL: &str = "https://admin1.qingmu39.top/api/vss-gpui-version.json";
const MAX_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone)]
pub struct UpdateInfo {
    pub version: String,
    pub published: String,
    pub changelog: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
}

pub fn check() -> Result<Option<UpdateInfo>, String> {
    let url = std::env::var("VSS_UPDATE_URL").unwrap_or_else(|_| MANIFEST_URL.to_string());
    let response = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(6)))
            .timeout_recv_body(Some(Duration::from_secs(6)))
            .build(),
    )
    .get(&url)
    .header(
        "User-Agent",
        concat!("V-Synth-Studio/", env!("CARGO_PKG_VERSION")),
    )
    .call()
    .map_err(|error| format!("检查更新失败：{error}"))?;
    let mut text = String::new();
    response
        .into_body()
        .into_reader()
        .take(MAX_BYTES)
        .read_to_string(&mut text)
        .map_err(|error| format!("读取更新清单失败：{error}"))?;
    parse_manifest(&text, env!("CARGO_PKG_VERSION"))
}

pub fn parse_manifest(text: &str, current: &str) -> Result<Option<UpdateInfo>, String> {
    let value: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|error| format!("解析更新清单失败：{error}"))?;
    let version = value["version"]
        .as_str()
        .map(str::trim)
        .filter(|version| !version.is_empty())
        .ok_or_else(|| "更新清单缺少版本号".to_string())?
        .to_string();
    if !is_newer(&version, current) {
        return Ok(None);
    }
    let windows = value
        .pointer("/downloads/windows")
        .or_else(|| value.get("windows"))
        .ok_or_else(|| "更新清单没有 Windows 安装包".to_string())?;
    let url = windows["url"]
        .as_str()
        .map(str::trim)
        .filter(|url| allowed_url(url))
        .ok_or_else(|| "更新清单的下载地址无效".to_string())?
        .to_string();
    let size = windows["size"].as_u64().unwrap_or(0);
    let sha256 = windows["sha256"]
        .as_str()
        .map(str::trim)
        .filter(|hash| hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit()))
        .ok_or_else(|| "更新清单缺少 SHA-256".to_string())?
        .to_string();
    Ok(Some(UpdateInfo {
        version,
        published: value["published_at"].as_str().unwrap_or("").to_string(),
        changelog: value["changelog"].as_str().unwrap_or("").to_string(),
        url,
        size,
        sha256,
    }))
}

pub fn download(info: &UpdateInfo, ctx: &JobContext) -> Result<PathBuf, String> {
    let directory = crate::config::data_dir().join("updates");
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    let name = info
        .url
        .split('/')
        .next_back()
        .filter(|name| name.ends_with(".exe"))
        .unwrap_or("v-synth-studio-setup.exe");
    let destination = directory.join(name);
    download::fetch(
        &info.url,
        &destination,
        &info.sha256,
        info.size,
        0.0,
        1.0,
        ctx,
        "更新安装包",
    )?;
    Ok(destination)
}

pub fn is_installed() -> bool {
    crate::config::app_root().join("Uninstall.exe").is_file()
}

pub fn launch_installer(setup: &Path) -> Result<(), String> {
    let path = setup.display().to_string();
    let command = format!("ping -n 3 127.0.0.1 >nul & \"{path}\" /S");
    let mut process = Command::new("cmd");
    process.args(["/C", &command]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        process.creation_flags(0x0800_0000);
    }
    process
        .spawn()
        .map_err(|error| format!("启动安装程序失败：{error}"))?;
    Ok(())
}

fn allowed_url(url: &str) -> bool {
    url.starts_with("https://")
        || cfg!(debug_assertions)
            && (url.starts_with("http://127.0.0.1") || url.starts_with("http://localhost"))
}

fn is_newer(latest: &str, current: &str) -> bool {
    let latest = version_parts(latest);
    let current = version_parts(current);
    for index in 0..latest.len().max(current.len()) {
        let left = latest.get(index).copied().unwrap_or(0);
        let right = current.get(index).copied().unwrap_or(0);
        if left != right {
            return left > right;
        }
    }
    false
}

fn version_parts(version: &str) -> Vec<u64> {
    version
        .trim_start_matches(['v', 'V'])
        .split(['-', '+'])
        .next()
        .unwrap_or("")
        .split('.')
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compares_numeric_versions() {
        assert!(is_newer("0.2.0", "0.1.0"));
        assert!(is_newer("0.1.10", "0.1.9"));
        assert!(is_newer("v1.0.0", "0.9.9"));
        assert!(!is_newer("0.1.0", "0.1.0"));
        assert!(!is_newer("0.0.9", "0.1.0"));
    }

    #[test]
    fn parses_a_newer_windows_manifest() {
        let text = r#"{
            "version": "0.2.0",
            "published_at": "2026-10-29T00:00:00Z",
            "changelog": "notes",
            "downloads": {"windows": {"url": "https://example.com/setup.exe", "size": 10, "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}
        }"#;
        let info = parse_manifest(text, "0.1.0").unwrap().unwrap();
        assert_eq!(info.version, "0.2.0");
        assert_eq!(info.size, 10);
        assert!(parse_manifest(text, "0.2.0").unwrap().is_none());
        assert!(parse_manifest(text, "0.3.0").unwrap().is_none());
    }

    #[test]
    fn rejects_insecure_or_incomplete_manifests() {
        let insecure = r#"{"version":"0.2.0","downloads":{"windows":{"url":"http://example.com/a.exe","size":1,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}}"#;
        assert!(parse_manifest(insecure, "0.1.0").is_err());
        let missing = r#"{"version":"0.2.0"}"#;
        assert!(parse_manifest(missing, "0.1.0").is_err());
        let bad_hash = r#"{"version":"0.2.0","downloads":{"windows":{"url":"https://example.com/a.exe","size":1,"sha256":"abcd"}}}"#;
        assert!(parse_manifest(bad_hash, "0.1.0").is_err());
    }
}
