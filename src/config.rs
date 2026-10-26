//! 过渡期的 UI 配置。键名沿用旧 `config.json` 的 `theme`，未知字段原样保留，
//! 避免 GPUI 版把 React 版还没迁移的设置写丢。

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

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

    pub fn label(self) -> &'static str {
        match self {
            Self::System => "跟随系统",
            Self::Light => "明亮",
            Self::Dark => "黑暗",
        }
    }

    pub fn short_label(self) -> &'static str {
        match self {
            Self::System => "系统",
            Self::Light => "明亮",
            Self::Dark => "黑暗",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    #[serde(default)]
    pub theme: ThemePreference,
    #[serde(default, rename = "outputDir")]
    pub output_dir: String,
    #[serde(default, rename = "downloadDir")]
    pub download_dir: String,
    #[serde(default, rename = "extDir")]
    pub ext_dir: String,
    #[serde(default, rename = "pvPendingLyrics")]
    pub pv_pending_lyrics: String,
    #[serde(default, rename = "pvSentLyrics")]
    pub pv_sent_lyrics: String,
    /// 旧版配置里的其它键（Cookie、页面设置、工具路径……）原样保留。
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            theme: ThemePreference::default(),
            output_dir: String::new(),
            download_dir: String::new(),
            ext_dir: String::new(),
            pv_pending_lyrics: String::new(),
            pv_sent_lyrics: String::new(),
            extra: Map::new(),
        }
    }
}

impl Config {
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
