//! 外部组件的下载、校验与安装。
//!
//! 组件固定到上游 URL 与 SHA-256；安装包缓存在 `data/cache/artifacts/`，
//! 校验通过后解压到 `tools/<id>/`。解压拒绝绝对路径、父级路径和符号链接。

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};

use sha2::{Digest, Sha256};
use zip::ZipArchive;

use crate::services::jobs::JobContext;

const CACHE_DIR: &str = "data/cache/artifacts";

#[derive(Debug, Clone, Copy)]
pub enum ArtifactKind {
    Zip { strip_prefix: &'static str },
    Gzip,
    File,
}

#[derive(Debug, Clone, Copy)]
pub struct Artifact {
    pub id: &'static str,
    pub name: &'static str,
    pub version: &'static str,
    pub url: &'static str,
    pub mirrors: &'static [&'static str],
    pub sha256: &'static str,
    pub size: u64,
    pub file_name: &'static str,
    pub kind: ArtifactKind,
    pub executable: &'static str,
}

impl Artifact {
    pub fn install_dir(&self, root: &Path) -> PathBuf {
        root.join("tools").join(self.id)
    }

    pub fn executable_path(&self, root: &Path) -> PathBuf {
        self.install_dir(root).join(self.executable)
    }

    pub fn is_installed(&self, root: &Path) -> bool {
        self.executable_path(root).is_file()
    }

    pub fn cache_path(&self, root: &Path) -> PathBuf {
        root.join(CACHE_DIR).join(self.file_name)
    }
}

#[cfg(all(target_os = "windows", target_arch = "x86_64"))]
pub const ALL: &[Artifact] = &[
    Artifact {
        id: "libresvip",
        name: "LibreSVIP CLI",
        version: "2.9.2",
        url: "https://github.com/SoulMelody/LibreSVIP/releases/download/v2.9.2/LibreSVIP-CLI-2.9.2.win-amd64.zip",
        mirrors: &[],
        sha256: "eb4321274f58b4080ffd545b63f0ef9191b0da130664f6bb5de314b6440d9dcd",
        size: 37_001_401,
        file_name: "libresvip-cli-2.9.2-win-amd64.zip",
        kind: ArtifactKind::Zip {
            strip_prefix: "libresvip-cli/",
        },
        executable: "libresvip-cli.exe",
    },
    Artifact {
        id: "ffmpeg",
        name: "FFmpeg",
        version: "6.1.1",
        url: "https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.1.1/ffmpeg-win32-x64.gz",
        mirrors: &[
            "https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/ffmpeg-win32-x64.gz",
        ],
        sha256: "8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77",
        size: 29_581_307,
        file_name: "ffmpeg-win32-x64-6.1.1.gz",
        kind: ArtifactKind::Gzip,
        executable: "bin/ffmpeg.exe",
    },
    Artifact {
        id: "ytdlp",
        name: "yt-dlp",
        version: "2026.10.26",
        url: "https://gh-proxy.com/https://github.com/yt-dlp/yt-dlp/releases/download/2026.10.26/yt-dlp.exe",
        mirrors: &[],
        sha256: "f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d",
        size: 23_575_744,
        file_name: "yt-dlp-2026.10.26.exe",
        kind: ArtifactKind::File,
        executable: "yt-dlp.exe",
    },
];

#[cfg(not(all(target_os = "windows", target_arch = "x86_64")))]
pub const ALL: &[Artifact] = &[];

pub fn install(artifact: &Artifact, root: &Path, ctx: &JobContext) -> Result<(), String> {
    install_with(
        artifact,
        root,
        |fraction, message| ctx.progress(fraction, message),
        |line| ctx.log(line),
        || ctx.is_canceled(),
    )
}

/// Install from a file the user already has. The pinned SHA-256 still decides,
/// so a wrong or tampered archive is refused instead of half-installed.
pub fn install_from_file(
    artifact: &Artifact,
    source: &Path,
    root: &Path,
    ctx: &JobContext,
) -> Result<(), String> {
    if !source.is_file() {
        return Err(format!("文件不存在：{}", source.display()));
    }
    ctx.progress(Some(0.05), "校验本地安装包");
    if !verify_sha256(source, artifact.sha256)? {
        return Err(crate::i18n::t()
            .err_import_hash
            .replace("{0}", artifact.name));
    }
    ctx.log(format!("使用本地安装包：{}", source.display()));
    install_archive(
        artifact,
        root,
        source,
        &mut |fraction, message| ctx.progress(fraction, message),
        &mut |line| ctx.log(line),
        &|| ctx.is_canceled(),
    )
}

fn install_with<P, L, C>(
    artifact: &Artifact,
    root: &Path,
    mut progress: P,
    mut log: L,
    canceled: C,
) -> Result<(), String>
where
    P: FnMut(Option<f32>, &str),
    L: FnMut(String),
    C: Fn() -> bool,
{
    if canceled() {
        return Err("已取消".to_string());
    }

    let archive = artifact.cache_path(root);
    if let Some(parent) = archive.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建组件缓存目录失败（{}）：{error}", parent.display()))?;
    }

    let mut cached = false;
    if archive.is_file() {
        if verify_sha256(&archive, artifact.sha256)? {
            cached = true;
            log(format!("使用已校验的安装包：{}", archive.display()));
        } else {
            log("缓存校验失败，重新下载".to_string());
            let _ = fs::remove_file(&archive);
        }
    }
    if !cached {
        if canceled() {
            return Err("已取消".to_string());
        }
        progress(Some(0.02), "连接下载源");
        let urls = crate::services::download::candidate_urls(artifact.url, artifact.mirrors);
        crate::services::download::fetch_all_with(
            &urls,
            &archive,
            artifact.sha256,
            artifact.size,
            0.02,
            0.78,
            |fraction, message| progress(fraction, &message),
            &mut log,
            &canceled,
            artifact.name,
        )?;
    }

    install_archive(artifact, root, &archive, &mut progress, &mut log, &canceled)
}

fn install_archive<P, L, C>(
    artifact: &Artifact,
    root: &Path,
    archive: &Path,
    progress: &mut P,
    log: &mut L,
    canceled: &C,
) -> Result<(), String>
where
    P: FnMut(Option<f32>, &str),
    L: FnMut(String),
    C: Fn() -> bool,
{
    if canceled() {
        return Err("已取消".to_string());
    }
    progress(Some(0.8), "解压组件");
    let tools = root.join("tools");
    fs::create_dir_all(&tools)
        .map_err(|error| format!("创建 tools 目录失败（{}）：{error}", tools.display()))?;
    let staging = tools.join(format!(".{}-installing", artifact.id));
    remove_dir_if_exists(&staging)?;
    fs::create_dir_all(&staging)
        .map_err(|error| format!("创建临时目录失败（{}）：{error}", staging.display()))?;

    if let Err(error) = match artifact.kind {
        ArtifactKind::Zip { strip_prefix } => {
            extract_zip(archive, &staging, strip_prefix, progress, canceled)
        }
        ArtifactKind::Gzip => extract_gzip(
            archive,
            &staging.join(artifact.executable),
            progress,
            canceled,
        ),
        ArtifactKind::File => {
            progress(Some(0.9), "安装组件");
            fs::copy(archive, staging.join(artifact.executable))
                .map(|_| ())
                .map_err(|error| format!("安装组件失败：{error}"))
        }
    } {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    if !staging.join(artifact.executable).is_file() {
        let _ = fs::remove_dir_all(&staging);
        return Err(format!("安装包缺少 {}", artifact.executable));
    }

    let target = artifact.install_dir(root);
    let backup = tools.join(format!(".{}-old", artifact.id));
    remove_dir_if_exists(&backup)?;
    if target.exists() {
        fs::rename(&target, &backup)
            .map_err(|error| format!("备份旧版本失败（{}）：{error}", target.display()))?;
    }
    if let Err(error) = fs::rename(&staging, &target) {
        let _ = fs::remove_dir_all(&staging);
        let _ = fs::rename(&backup, &target);
        return Err(format!("安装组件失败（{}）：{error}", target.display()));
    }
    let _ = fs::remove_dir_all(&backup);

    progress(Some(1.0), "安装完成");
    log(format!("已安装到 {}", target.display()));
    Ok(())
}

fn extract_zip<P, C>(
    archive: &Path,
    dest: &Path,
    strip_prefix: &str,
    progress: &mut P,
    canceled: &C,
) -> Result<(), String>
where
    P: FnMut(Option<f32>, &str),
    C: Fn() -> bool,
{
    let file = File::open(archive)
        .map_err(|error| format!("打开安装包失败（{}）：{error}", archive.display()))?;
    let mut zip = ZipArchive::new(file)
        .map_err(|error| format!("解析安装包失败（{}）：{error}", archive.display()))?;
    let total = zip.len().max(1);
    let step = (total / 50).max(1);

    for index in 0..zip.len() {
        if canceled() {
            return Err("已取消".to_string());
        }
        let mut entry = zip
            .by_index(index)
            .map_err(|error| format!("读取安装包条目失败：{error}"))?;
        let name = entry
            .name()
            .map_err(|error| format!("安装包条目名无效：{error}"))?
            .into_owned();
        let Some(relative) = name.strip_prefix(strip_prefix) else {
            continue;
        };
        if relative.is_empty() {
            continue;
        }
        let Some(relative) = safe_relative(relative) else {
            return Err(format!("安装包包含非法路径：{name}"));
        };
        if entry.is_dir() {
            fs::create_dir_all(dest.join(&relative))
                .map_err(|error| format!("创建目录失败（{}）：{error}", relative.display()))?;
            continue;
        }
        if entry
            .unix_mode()
            .is_some_and(|mode| mode & 0o170000 == 0o120000)
        {
            return Err(format!("安装包包含符号链接：{name}"));
        }
        let target = dest.join(&relative);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent)
                .map_err(|error| format!("创建目录失败（{}）：{error}", parent.display()))?;
        }
        let mut output = File::create(&target)
            .map_err(|error| format!("创建文件失败（{}）：{error}", target.display()))?;
        io::copy(&mut entry, &mut output)
            .map_err(|error| format!("解压文件失败（{}）：{error}", target.display()))?;
        if index % step == 0 || index + 1 == total {
            progress(
                Some(0.8 + 0.18 * (index + 1) as f32 / total as f32),
                "解压组件",
            );
        }
    }
    Ok(())
}

fn extract_gzip<P, C>(
    archive: &Path,
    target: &Path,
    progress: &mut P,
    canceled: &C,
) -> Result<(), String>
where
    P: FnMut(Option<f32>, &str),
    C: Fn() -> bool,
{
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("创建目录失败（{}）：{error}", parent.display()))?;
    }
    let file = File::open(archive)
        .map_err(|error| format!("打开安装包失败（{}）：{error}", archive.display()))?;
    let mut decoder = flate2::read::GzDecoder::new(file);
    let mut output = File::create(target)
        .map_err(|error| format!("创建文件失败（{}）：{error}", target.display()))?;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        if canceled() {
            drop(output);
            let _ = fs::remove_file(target);
            return Err("已取消".to_string());
        }
        let read = decoder
            .read(&mut buffer)
            .map_err(|error| format!("解压失败（{}）：{error}", archive.display()))?;
        if read == 0 {
            break;
        }
        output
            .write_all(&buffer[..read])
            .map_err(|error| format!("写入文件失败（{}）：{error}", target.display()))?;
    }
    progress(Some(0.98), "解压组件");
    Ok(())
}

fn verify_sha256(path: &Path, expected: &str) -> Result<bool, String> {
    let mut file = File::open(path)
        .map_err(|error| format!("读取安装包失败（{}）：{error}", path.display()))?;
    let mut hasher = Sha256::new();
    let mut buffer = [0u8; 256 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(|error| format!("读取安装包失败（{}）：{error}", path.display()))?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hex(&hasher.finalize()).eq_ignore_ascii_case(expected))
}

fn safe_relative(name: &str) -> Option<PathBuf> {
    if name.is_empty() {
        return None;
    }
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

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn remove_dir_if_exists(path: &Path) -> Result<(), String> {
    if !path.exists() {
        return Ok(());
    }
    fs::remove_dir_all(path).map_err(|error| format!("清理目录失败（{}）：{error}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;
    use zip::write::SimpleFileOptions;

    #[test]
    fn hex_is_lowercase() {
        assert_eq!(
            hex(&Sha256::digest(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn rejects_escaping_paths() {
        assert!(safe_relative("../evil.txt").is_none());
        assert!(safe_relative("a/../../evil.txt").is_none());
        assert!(safe_relative("/absolute.txt").is_none());
        assert_eq!(safe_relative("a/./b.txt"), Some(PathBuf::from("a/b.txt")));
    }

    #[test]
    fn installs_from_cached_zip_with_prefix() {
        let root = temp_root("install");
        let zip_path = root.join(CACHE_DIR).join("test-pkg-1.0.zip");
        fs::create_dir_all(zip_path.parent().expect("cache parent")).unwrap();
        write_test_zip(&zip_path);
        let hash = hex(&Sha256::digest(fs::read(&zip_path).unwrap()));
        let artifact = Artifact {
            id: "test-pkg",
            name: "Test Package",
            version: "1.0",
            url: "http://127.0.0.1:9/not-used",
            mirrors: &[],
            sha256: Box::leak(hash.into_boxed_str()),
            size: fs::metadata(&zip_path).unwrap().len(),
            file_name: "test-pkg-1.0.zip",
            kind: ArtifactKind::Zip {
                strip_prefix: "pkg/",
            },
            executable: "hello.txt",
        };

        install_with(&artifact, &root, |_, _| {}, |_| {}, || false).unwrap();

        assert!(artifact.is_installed(&root));
        assert_eq!(
            fs::read_to_string(root.join("tools/test-pkg/hello.txt")).unwrap(),
            "hello"
        );
        assert_eq!(
            fs::read_to_string(root.join("tools/test-pkg/sub/file.txt")).unwrap(),
            "world"
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn installs_from_cached_gzip() {
        let root = temp_root("gzip");
        let archive = root.join(CACHE_DIR).join("tool.gz");
        fs::create_dir_all(archive.parent().expect("cache parent")).unwrap();
        let data = b"standalone binary";
        let mut encoder = flate2::write::GzEncoder::new(
            File::create(&archive).unwrap(),
            flate2::Compression::default(),
        );
        encoder.write_all(data).unwrap();
        encoder.finish().unwrap();
        let hash = hex(&Sha256::digest(fs::read(&archive).unwrap()));
        let artifact = Artifact {
            id: "gzip-pkg",
            name: "Gzip Package",
            version: "1.0",
            url: "http://127.0.0.1:9/not-used",
            mirrors: &[],
            sha256: Box::leak(hash.into_boxed_str()),
            size: fs::metadata(&archive).unwrap().len(),
            file_name: "tool.gz",
            kind: ArtifactKind::Gzip,
            executable: "bin/tool.bin",
        };

        install_with(&artifact, &root, |_, _| {}, |_| {}, || false).unwrap();

        assert!(artifact.is_installed(&root));
        assert_eq!(
            fs::read(root.join("tools/gzip-pkg/bin/tool.bin")).unwrap(),
            data
        );
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn rejects_symlink_entries() {
        let root = temp_root("symlink");
        let archive = root.join("link.zip");
        let mut writer = zip::ZipWriter::new(File::create(&archive).unwrap());
        writer
            .add_symlink("link", "target", SimpleFileOptions::default())
            .unwrap();
        writer.finish().unwrap();

        let error =
            extract_zip(&archive, &root.join("out"), "", &mut |_, _| {}, &|| false).unwrap_err();
        assert!(error.contains("符号链接"));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn downloads_from_http_and_installs() {
        let root = temp_root("download");
        let source = root.join("source.zip");
        write_test_zip(&source);
        let bytes = fs::read(&source).unwrap();
        let hash = hex(&Sha256::digest(&bytes));

        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let served = bytes.clone();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0u8; 1024];
            let _ = stream.read(&mut request);
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                served.len()
            )
            .unwrap();
            stream.write_all(&served).unwrap();
        });

        let artifact = Artifact {
            id: "download-pkg",
            name: "Download Package",
            version: "1.0",
            url: Box::leak(format!("http://{address}/pkg.zip").into_boxed_str()),
            mirrors: &[],
            sha256: Box::leak(hash.into_boxed_str()),
            size: bytes.len() as u64,
            file_name: "pkg.zip",
            kind: ArtifactKind::Zip {
                strip_prefix: "pkg/",
            },
            executable: "hello.txt",
        };
        install_with(&artifact, &root, |_, _| {}, |_| {}, || false).unwrap();
        server.join().unwrap();

        assert!(artifact.is_installed(&root));
        assert_eq!(
            fs::read_to_string(root.join("tools/download-pkg/hello.txt")).unwrap(),
            "hello"
        );
        assert!(root.join(CACHE_DIR).join("pkg.zip").is_file());
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    #[ignore = "installs the real LibreSVIP archive into tools/"]
    fn installs_libresvip_into_repo_tools() {
        let artifact = ALL.first().expect("artifact");
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        install_with(
            artifact,
            &root,
            |_, _| {},
            |line| println!("{line}"),
            || false,
        )
        .unwrap();
        assert!(artifact.is_installed(&root));
    }

    #[test]
    #[ignore = "reinstalls yt-dlp from the archive already in data/cache"]
    fn imports_the_cached_ytdlp_archive_as_a_local_file() {
        let artifact = *ALL
            .iter()
            .find(|artifact| artifact.id == "ytdlp")
            .expect("ytdlp artifact");
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        let source = artifact.cache_path(&root);
        assert!(
            source.is_file(),
            "no cached archive at {}",
            source.display()
        );

        install_file_job(&artifact, &source, &root).unwrap();
        assert!(artifact.is_installed(&root));
    }

    #[test]
    #[ignore = "installs the real ffmpeg archive into tools/"]
    fn installs_ffmpeg_into_repo_tools() {
        let artifact = ALL
            .iter()
            .find(|artifact| artifact.id == "ffmpeg")
            .expect("ffmpeg artifact");
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        install_with(
            artifact,
            &root,
            |_, _| {},
            |line| println!("{line}"),
            || false,
        )
        .unwrap();
        assert!(artifact.is_installed(&root));
    }

    #[test]
    fn rejects_a_local_file_with_the_wrong_hash() {
        let root = temp_root("local-bad");
        let source = root.join("pkg.zip");
        write_test_zip(&source);
        let artifact = local_artifact("deadbeef");

        let error = install_file_job(&artifact, &source, &root).unwrap_err();
        assert!(error.contains("校验值"), "{error}");
        assert!(!artifact.is_installed(&root));
        let _ = fs::remove_dir_all(root);
    }

    #[test]
    fn installs_from_a_local_file_without_filling_the_cache() {
        let root = temp_root("local-import");
        let source = root.join("hand-carried").join("pkg.zip");
        fs::create_dir_all(source.parent().expect("source parent")).unwrap();
        write_test_zip(&source);
        let hash = hex(&Sha256::digest(fs::read(&source).unwrap()));
        let artifact = local_artifact(&hash);

        install_file_job(&artifact, &source, &root).unwrap();

        assert!(artifact.is_installed(&root));
        assert_eq!(
            fs::read_to_string(root.join("tools/local-pkg/hello.txt")).unwrap(),
            "hello"
        );
        assert!(!artifact.cache_path(&root).exists());
        let _ = fs::remove_dir_all(root);
    }

    fn local_artifact(sha256: &str) -> Artifact {
        Artifact {
            id: "local-pkg",
            name: "Local Package",
            version: "1.0",
            url: "http://127.0.0.1:9/not-used",
            mirrors: &[],
            sha256: Box::leak(sha256.to_string().into_boxed_str()),
            size: 4096,
            file_name: "pkg.zip",
            kind: ArtifactKind::Zip {
                strip_prefix: "pkg/",
            },
            executable: "hello.txt",
        }
    }

    fn install_file_job(artifact: &Artifact, source: &Path, root: &Path) -> Result<(), String> {
        use crate::services::jobs::{JobOutcome, Jobs};

        let (jobs, _events) = Jobs::new();
        let source = source.to_path_buf();
        let root = root.to_path_buf();
        let artifact = *artifact;
        let job = jobs.start("artifact import", move |ctx| {
            install_from_file(&artifact, &source, &root, &ctx)
        });
        match job.result.recv_blocking().expect("job result") {
            JobOutcome::Done(()) => Ok(()),
            JobOutcome::Failed(error) => Err(error),
            JobOutcome::Canceled => Err("已取消".to_string()),
        }
    }

    fn write_test_zip(path: &Path) {
        let mut writer = zip::ZipWriter::new(File::create(path).unwrap());
        let options = SimpleFileOptions::default();
        writer.add_directory("pkg/", options).unwrap();
        writer.start_file("pkg/hello.txt", options).unwrap();
        writer.write_all(b"hello").unwrap();
        writer.add_directory("pkg/sub/", options).unwrap();
        writer.start_file("pkg/sub/file.txt", options).unwrap();
        writer.write_all(b"world").unwrap();
        writer.finish().unwrap();
    }

    fn temp_root(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "vss-artifacts-{label}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        root
    }
}
