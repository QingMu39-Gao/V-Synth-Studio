//! Unified view of the tools, runtime and models that are downloaded on demand.

use std::path::PathBuf;

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
}
