//! 应用配置，读写 `<程序根>/data/config.json`。

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::i18n::Language;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum ThemePreference {
    #[default]
    System,
    Light,
    Dark,
}

impl ThemePreference {
    pub const ALL: [Self; 3] = [Self::System, Self::Light, Self::Dark];

    pub fn key(self) -> &'static str {
        match self {
            Self::System => "system",
            Self::Light => "light",
            Self::Dark => "dark",
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub theme: ThemePreference,
    #[serde(default)]
    pub language: Language,
    #[serde(default)]
    pub output_dir: String,
    #[serde(default)]
    pub download_dir: String,
    #[serde(default)]
    pub ext_dir: String,
    #[serde(default)]
    pub seen_announcements: Vec<String>,
}

impl Config {
    pub fn announcement_seen(&self, id: &str) -> bool {
        self.seen_announcements.iter().any(|seen| seen == id)
    }

    pub fn mark_announcement_seen(&mut self, id: &str) {
        self.seen_announcements.retain(|seen| seen != id);
        self.seen_announcements.push(id.to_string());
        if self.seen_announcements.len() > 100 {
            let excess = self.seen_announcements.len() - 100;
            self.seen_announcements.drain(..excess);
        }
    }
    pub fn load() -> Self {
        let path = config_path();
        let Ok(text) = fs::read_to_string(&path) else {
            return Self::default();
        };
        serde_json::from_str(&text).unwrap_or_else(|err| {
            eprintln!("读取配置失败（{}）：{err}", path.display());
            Self::default()
        })
    }

    pub fn save(&self) -> Result<(), String> {
        let path = config_path();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)
                .map_err(|err| format!("创建配置目录失败（{}）：{err}", parent.display()))?;
        }
        let text =
            serde_json::to_string_pretty(self).map_err(|err| format!("序列化配置失败：{err}"))?;
        fs::write(&path, text).map_err(|err| format!("写入配置失败（{}）：{err}", path.display()))
    }
}

pub fn app_root() -> PathBuf {
    root()
}

pub fn data_dir() -> PathBuf {
    app_root().join("data")
}

pub fn tools_dir() -> PathBuf {
    app_root().join("tools")
}

pub fn config_path() -> PathBuf {
    data_dir().join("config.json")
}

#[cfg(debug_assertions)]
fn root() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}

#[cfg(not(debug_assertions))]
fn root() -> PathBuf {
    std::env::current_exe()
        .ok()
        .and_then(|path| path.parent().map(PathBuf::from))
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seen_announcements_are_deduplicated_and_capped() {
        let mut config = Config::default();
        config.mark_announcement_seen("a");
        config.mark_announcement_seen("a");
        assert_eq!(config.seen_announcements, vec!["a"]);
        for index in 0..120 {
            config.mark_announcement_seen(&format!("id-{index}"));
        }
        assert_eq!(config.seen_announcements.len(), 100);
        assert!(!config.announcement_seen("a"));
        assert!(config.announcement_seen("id-119"));
    }
}
