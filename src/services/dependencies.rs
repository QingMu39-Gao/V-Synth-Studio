//! Unified view of the tools, runtime and models that are downloaded on demand.

use std::fs;
use std::path::{Path, PathBuf};

use crate::services::artifacts;
use crate::services::jobs::JobContext;
use crate::services::midi;
use crate::services::python;
use crate::services::svsep;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Id {
    LibreSvip,
    Ffmpeg,
    YtDlp,
    Python,
    UvrModel,
    GameModel,
}

#[derive(Debug, Clone, Copy)]
pub struct Info {
    pub id: Id,
    pub name: &'static str,
    pub version: &'static str,
    pub size: u64,
}

pub const ALL: [Info; 6] = [
    Info {
        id: Id::LibreSvip,
        name: "LibreSVIP CLI",
        version: "2.9.2",
        size: 37_001_401,
    },
    Info {
        id: Id::Ffmpeg,
        name: "FFmpeg",
        version: "6.1.1",
        size: 29_581_307,
    },
    Info {
        id: Id::YtDlp,
        name: "yt-dlp",
        version: "2026.10.26",
        size: 23_575_744,
    },
    Info {
        id: Id::Python,
        name: "Python runtime",
        version: "3.10.11 + numpy + onnxruntime",
        size: 35_523_084,
    },
    Info {
        id: Id::UvrModel,
        name: "UVR-MDX-NET-Inst_HQ_3.onnx",
        version: "MDX-NET",
        size: 66_759_214,
    },
    Info {
        id: Id::GameModel,
        name: "GAME 1.0.3 large (ONNX)",
        version: "1.0.3",
        size: 361_619_205,
    },
];

#[derive(Debug, Clone)]
pub struct Status {
    pub ready: bool,
    pub location: PathBuf,
}

pub fn info(id: Id) -> &'static Info {
    ALL.iter()
        .find(|info| info.id == id)
        .expect("known dependency")
}

pub fn version(id: Id) -> &'static str {
    match id {
        Id::LibreSvip | Id::Ffmpeg | Id::YtDlp => artifacts::ALL
            .iter()
            .find(|artifact| artifact.id == artifact_id(id))
            .map(|artifact| artifact.version)
            .unwrap_or(info(id).version),
        _ => info(id).version,
    }
}

pub fn status(id: Id) -> Status {
    match id {
        Id::Python => Status {
            ready: python::ready(),
            location: python::runtime_dir(),
        },
        Id::UvrModel => {
            let path = svsep::model_file();
            Status {
                ready: path.is_file(),
                location: path,
            }
        }
        Id::GameModel => Status {
            ready: midi::status().models_ready,
            location: midi::model_dir(),
        },
        Id::LibreSvip | Id::Ffmpeg | Id::YtDlp => {
            let artifact_id = artifact_id(id);
            match artifacts::ALL
                .iter()
                .find(|artifact| artifact.id == artifact_id)
            {
                Some(artifact) => Status {
                    ready: artifact.is_installed(&crate::config::app_root()),
                    location: artifact.executable_path(&crate::config::app_root()),
                },
                None => Status {
                    ready: false,
                    location: PathBuf::new(),
                },
            }
        }
    }
}

pub fn install(id: Id, ctx: &JobContext) -> Result<(), String> {
    match id {
        Id::Python => python::ensure(ctx, 0.0, 1.0),
        Id::UvrModel => svsep::ensure_model_only(ctx),
        Id::GameModel => midi::ensure_models_only(ctx),
        Id::LibreSvip | Id::Ffmpeg | Id::YtDlp => {
            let artifact_id = artifact_id(id);
            let artifact = artifacts::ALL
                .iter()
                .find(|artifact| artifact.id == artifact_id)
                .ok_or_else(|| format!("没有可用的 {} 安装包", info(id).name))?;
            artifacts::install(artifact, &crate::config::app_root(), ctx)
        }
    }
}

/// Whether the component ships as one archive the user can hand over.
pub fn importable(id: Id) -> bool {
    !matches!(id, Id::Python)
}

pub fn import(id: Id, path: &Path, ctx: &JobContext) -> Result<(), String> {
    match id {
        Id::Python => Err(crate::i18n::t().err_python_not_importable.to_string()),
        Id::UvrModel => svsep::import_model(path, ctx),
        Id::GameModel => midi::import_models(path, ctx),
        Id::LibreSvip | Id::Ffmpeg | Id::YtDlp => {
            let artifact = artifacts::ALL
                .iter()
                .find(|artifact| artifact.id == artifact_id(id))
                .ok_or_else(|| format!("没有可用的 {} 安装包", info(id).name))?;
            artifacts::install_from_file(artifact, path, &crate::config::app_root(), ctx)
        }
    }
}

pub fn import_extensions(id: Id) -> &'static [&'static str] {
    match id {
        Id::Python => &[],
        Id::UvrModel => &["onnx"],
        Id::GameModel => &["zip"],
        Id::LibreSvip | Id::Ffmpeg | Id::YtDlp => {
            let artifact_id = artifact_id(id);
            artifacts::ALL
                .iter()
                .find(|artifact| artifact.id == artifact_id)
                .and_then(|artifact| artifact.file_name.rsplit_once('.'))
                .map(|(_, extension)| extension_filter(extension))
                .unwrap_or(&[])
        }
    }
}

fn extension_filter(extension: &str) -> &'static [&'static str] {
    match extension {
        "zip" => &["zip"],
        "gz" => &["gz"],
        "exe" => &["exe"],
        _ => &[],
    }
}

/// Everything 删除 takes away: the installed files and the cached archive, so a
/// later install downloads again instead of silently reusing a stale package.
pub fn paths(id: Id) -> Vec<PathBuf> {
    let root = crate::config::app_root();
    match id {
        Id::Python => vec![python::base_dir()],
        Id::UvrModel => vec![svsep::model_file()],
        Id::GameModel => vec![midi::model_dir(), midi::cache_dir()],
        Id::LibreSvip | Id::Ffmpeg | Id::YtDlp => {
            let artifact_id = artifact_id(id);
            artifacts::ALL
                .iter()
                .find(|artifact| artifact.id == artifact_id)
                .map(|artifact| vec![artifact.install_dir(&root), artifact.cache_path(&root)])
                .unwrap_or_default()
        }
    }
}

pub fn uninstall(id: Id, ctx: &JobContext) -> Result<(), String> {
    ctx.progress(Some(0.1), "删除组件");
    let mut removed = 0;
    for path in paths(id) {
        if remove_path(&path)? {
            removed += 1;
            ctx.log(format!("已删除 {}", path.display()));
        }
    }
    if removed == 0 {
        ctx.log("没有需要删除的文件");
    }
    ctx.progress(Some(1.0), "已删除");
    Ok(())
}

fn remove_path(path: &Path) -> Result<bool, String> {
    if path.is_dir() {
        fs::remove_dir_all(path)
            .map_err(|error| format!("删除目录失败（{}）：{error}", path.display()))?;
        return Ok(true);
    }
    if path.is_file() {
        fs::remove_file(path)
            .map_err(|error| format!("删除文件失败（{}）：{error}", path.display()))?;
        return Ok(true);
    }
    Ok(false)
}

fn artifact_id(id: Id) -> &'static str {
    match id {
        Id::LibreSvip => "libresvip",
        Id::Ffmpeg => "ffmpeg",
        Id::YtDlp => "ytdlp",
        _ => "",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dependency_table_covers_every_id() {
        for id in [
            Id::LibreSvip,
            Id::Ffmpeg,
            Id::YtDlp,
            Id::Python,
            Id::UvrModel,
            Id::GameModel,
        ] {
            assert_eq!(info(id).id, id);
        }
        assert_eq!(ALL.len(), 6);
    }

    #[test]
    fn single_file_components_declare_an_import_filter() {
        assert_eq!(import_extensions(Id::LibreSvip), &["zip"]);
        assert_eq!(import_extensions(Id::Ffmpeg), &["gz"]);
        assert_eq!(import_extensions(Id::YtDlp), &["exe"]);
        assert_eq!(import_extensions(Id::UvrModel), &["onnx"]);
        assert_eq!(import_extensions(Id::GameModel), &["zip"]);
        assert!(import_extensions(Id::Python).is_empty());
        assert!(!importable(Id::Python));
        assert!(importable(Id::GameModel));
    }

    #[test]
    fn remove_path_clears_directories_files_and_skips_absent() {
        let root = std::env::temp_dir().join(format!("vss-deps-remove-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("models/sub")).unwrap();
        fs::write(root.join("models/sub/weights.onnx"), b"x").unwrap();
        fs::write(root.join("tool.bin"), b"y").unwrap();

        assert!(remove_path(&root.join("models")).unwrap());
        assert!(!root.join("models").exists());
        assert!(remove_path(&root.join("tool.bin")).unwrap());
        assert!(!root.join("tool.bin").exists());
        assert!(!remove_path(&root.join("never-downloaded")).unwrap());
        let _ = fs::remove_dir_all(root);
    }
}
