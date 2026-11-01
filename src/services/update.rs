//! Check the GPUI update manifest, download the setup and hand it to NSIS.

use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::Duration;

use serde_json::Value;

use crate::services::download;
use crate::services::jobs::JobContext;

const MANIFEST_URL: &str =
    "https://github.com/QingMu39-Gao/V-Synth-Studio/releases/latest/download/vss-gpui-version.json";
const MAX_BYTES: u64 = 1024 * 1024;

#[derive(Debug, Clone)]
pub struct UpdateInfo {
    pub version: String,
    pub published: String,
    pub changelog: String,
    pub url: String,
    pub size: u64,
    pub sha256: String,
    pub force: bool,
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
    // Both fields mean "refuse the old build", and both are only allowed to do
    // that for a release that really is newer: `is_newer` has already returned
    // None above, so a mistyped field cannot lock every install out.
    let min_version = value["min_version"].as_str().map(str::trim);
    let force = value["force"].as_bool().unwrap_or(false)
        || min_version.is_some_and(|min| !min.is_empty() && is_newer(min, current));
    Ok(Some(UpdateInfo {
        version,
        published: value["published_at"].as_str().unwrap_or("").to_string(),
        changelog: value["changelog"].as_str().unwrap_or("").to_string(),
        url,
        size,
        sha256,
        force,
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
    // The app runs inside a Windows job, so a child cmd dies when the app exits.
    // Ask WMI to create the delayed installer outside that job.
    let path = setup.display().to_string();
    let command_line = format!("cmd.exe /C ping -n 3 127.0.0.1 >nul & \"{path}\" /S");
    let escaped = command_line.replace('\'', "''");
    let script = format!(
        "$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{{CommandLine='{escaped}'}}; if ($r.ReturnValue -ne 0) {{ throw \"WMI $($r.ReturnValue)\" }}"
    );
    let mut process = Command::new("powershell");
    process.args(["-NoProfile", "-WindowStyle", "Hidden", "-Command", &script]);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        process.creation_flags(CREATE_NO_WINDOW);
    }
    let output = process
        .output()
        .map_err(|error| format!("启动安装程序失败：{error}"))?;
    if !output.status.success() {
        return Err(format!(
            "启动安装程序失败：{}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(())
}

fn allowed_url(url: &str) -> bool {
    url.starts_with("https://")
        || url.starts_with("http://127.0.0.1")
        || url.starts_with("http://localhost")
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
    fn force_applies_only_to_a_release_that_is_newer() {
        let forced = parse_manifest(&manifest("\"force\": true,"), "1.5.0").unwrap();
        assert!(forced.unwrap().force);
        // Same manifest, install already at or past it: not an update, so not a
        // gate either. This is the case a mistyped `force` would otherwise lock
        // every install out of the app with no way to dismiss it.
        assert!(parse_manifest(&manifest("\"force\": true,"), "1.6.0")
            .unwrap()
            .is_none());
        assert!(parse_manifest(&manifest("\"force\": true,"), "1.7.0")
            .unwrap()
            .is_none());
        assert!(
            !parse_manifest(&manifest(""), "1.5.0")
                .unwrap()
                .unwrap()
                .force
        );
    }

    #[test]
    fn min_version_gates_the_installs_below_it() {
        let text = manifest("\"min_version\": \"1.6.0\",");
        assert!(parse_manifest(&text, "1.5.9").unwrap().unwrap().force);
        assert!(
            !parse_manifest(&manifest("\"min_version\": \"1.4.0\","), "1.5.0")
                .unwrap()
                .unwrap()
                .force
        );
        // An empty or unreadable value must not be read as "gate everyone".
        assert!(
            !parse_manifest(&manifest("\"min_version\": \"\","), "1.5.0")
                .unwrap()
                .unwrap()
                .force
        );
        assert!(
            !parse_manifest(&manifest("\"min_version\": 7,"), "1.5.0")
                .unwrap()
                .unwrap()
                .force
        );
    }

    fn manifest(fields: &str) -> String {
        format!(
            r#"{{"version": "1.6.0", {fields}"downloads": {{"windows": {{"url": "https://example.com/a.exe", "size": 1, "sha256": "{}"}}}}}}"#,
            "a".repeat(64)
        )
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
