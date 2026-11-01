//! Pinned HTTP downloads and ZIP extraction shared by the model-backed services.

use std::fs::{self, File};
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use sha2::{Digest, Sha256};
use zip::ZipArchive;

use crate::services::jobs::JobContext;

const USER_AGENT: &str = "V-Synth-Studio";
const PARALLEL_MIN: u64 = 16 * 1024 * 1024;
const PARALLEL_PARTS: usize = 8;

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
    fetch_all(
        &[url.to_string()],
        dest,
        sha256,
        size_hint,
        base,
        span,
        ctx,
        label,
    )
}

#[allow(clippy::too_many_arguments)]
pub fn fetch_all(
    urls: &[String],
    dest: &Path,
    sha256: &str,
    size_hint: u64,
    base: f32,
    span: f32,
    ctx: &JobContext,
    label: &str,
) -> Result<(), String> {
    fetch_all_with(
        urls,
        dest,
        sha256,
        size_hint,
        base,
        span,
        |fraction, message| ctx.progress(fraction, message),
        |line| ctx.log(line),
        || ctx.is_canceled(),
        label,
    )
}

/// Primary URL first, then the listed mirrors, then the GitHub proxy pair for
/// every entry already in the list.
pub fn candidate_urls(url: &str, mirrors: &[&str]) -> Vec<String> {
    const PROXY: &str = "https://gh-proxy.com/";
    let mut out: Vec<String> = Vec::new();
    push_unique(&mut out, url);
    for mirror in mirrors {
        push_unique(&mut out, mirror);
    }
    let known = out.len();
    for index in 0..known {
        let candidate = out[index].clone();
        if let Some(direct) = candidate.strip_prefix(PROXY) {
            push_unique(&mut out, direct);
        } else if candidate.starts_with("https://github.com/") {
            push_unique(&mut out, &format!("{PROXY}{candidate}"));
        }
    }
    out
}

fn push_unique(urls: &mut Vec<String>, candidate: &str) {
    if !candidate.is_empty() && !urls.iter().any(|url| url == candidate) {
        urls.push(candidate.to_string());
    }
}

#[allow(clippy::too_many_arguments)]
pub fn fetch_all_with<P, L, C>(
    urls: &[String],
    dest: &Path,
    sha256: &str,
    size_hint: u64,
    base: f32,
    span: f32,
    mut progress: P,
    mut log: L,
    canceled: C,
    label: &str,
) -> Result<(), String>
where
    P: FnMut(Option<f32>, String),
    L: FnMut(String),
    C: Fn() -> bool,
{
    if dest.is_file() {
        if verify_sha256(dest, sha256)? {
            return Ok(());
        }
        let _ = fs::remove_file(dest);
    }
    let mut failure = None;
    for (index, url) in urls.iter().enumerate() {
        if index > 0 {
            log(format!("换用备用地址下载 {label}"));
        }
        match attempt(
            url,
            dest,
            sha256,
            size_hint,
            base,
            span,
            &mut progress,
            &mut log,
            &canceled,
            label,
        ) {
            Ok(()) => return Ok(()),
            Err(error) => {
                if error == "已取消" {
                    return Err(error);
                }
                log(format!("⚠ 地址 {url} 失败：{error}"));
                failure = Some(error);
            }
        }
    }
    failure.map_or_else(|| Err(format!("没有可用的 {label} 下载源")), Err)
}

#[allow(clippy::too_many_arguments)]
fn attempt<P, L, C>(
    url: &str,
    dest: &Path,
    sha256: &str,
    size_hint: u64,
    base: f32,
    span: f32,
    progress: &mut P,
    log: &mut L,
    canceled: &C,
    label: &str,
) -> Result<(), String>
where
    P: FnMut(Option<f32>, String),
    L: FnMut(String),
    C: Fn() -> bool,
{
    if size_hint >= PARALLEL_MIN
        && fetch_ranges(
            url, dest, sha256, base, span, progress, log, canceled, label,
        )?
    {
        return Ok(());
    }
    let part = dest.with_extension("part");
    let _ = fs::remove_file(&part);
    log(format!("下载 {label}"));
    progress(Some(base), format!("下载 {label}"));
    let response = agent()
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
        if canceled() {
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
            progress(
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

fn agent() -> ureq::Agent {
    ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(30)))
            .timeout_recv_body(Some(Duration::from_secs(60 * 60)))
            .build(),
    )
}

#[allow(clippy::too_many_arguments)]
fn fetch_ranges<P, L, C>(
    url: &str,
    dest: &Path,
    sha256: &str,
    base: f32,
    span: f32,
    progress: &mut P,
    log: &mut L,
    canceled: &C,
    label: &str,
) -> Result<bool, String>
where
    P: FnMut(Option<f32>, String),
    L: FnMut(String),
    C: Fn() -> bool,
{
    let Some(total) = probe_range_total(url)? else {
        return Ok(false);
    };
    let chunk = total.div_ceil(PARALLEL_PARTS as u64);
    let downloaded = Arc::new(AtomicU64::new(0));
    let abort = Arc::new(AtomicBool::new(false));
    let mut handles = Vec::new();
    let mut part_files = Vec::new();
    for index in 0..PARALLEL_PARTS {
        let start = index as u64 * chunk;
        if start >= total {
            break;
        }
        let end = (start + chunk - 1).min(total - 1);
        let expected = end - start + 1;
        let part = dest.with_extension(format!("part{index}"));
        // A part left behind by an earlier run is kept and continued: the whole
        // file is hashed after merging, so a stale or wrong part can only ever
        // fail that check, and then every part is deleted.
        let have = fs::metadata(&part)
            .map(|meta| meta.len().min(expected))
            .unwrap_or(0);
        if have == expected {
            downloaded.fetch_add(expected, Ordering::Relaxed);
            part_files.push(part);
            continue;
        }
        part_files.push(part.clone());
        let url = url.to_string();
        let downloaded = downloaded.clone();
        let abort = abort.clone();
        handles.push(std::thread::spawn(move || -> Result<(), String> {
            let from = start + have;
            let response = agent()
                .get(&url)
                .header("User-Agent", USER_AGENT)
                .header("Range", format!("bytes={from}-{end}"))
                .call()
                .map_err(|error| error.to_string())?;
            if response.status().as_u16() != 206 {
                return Err(format!(
                    "服务器不支持分段下载（HTTP {}）",
                    response.status()
                ));
            }
            let mut file = if have > 0 {
                fs::OpenOptions::new()
                    .append(true)
                    .open(&part)
                    .map_err(|error| error.to_string())?
            } else {
                File::create(&part).map_err(|error| error.to_string())?
            };
            let mut reader = response.into_body().into_reader();
            let mut buffer = [0u8; 256 * 1024];
            let mut written = have;
            loop {
                if abort.load(Ordering::Relaxed) {
                    return Err("已取消".to_string());
                }
                let read = reader
                    .read(&mut buffer)
                    .map_err(|error| error.to_string())?;
                if read == 0 {
                    break;
                }
                file.write_all(&buffer[..read])
                    .map_err(|error| error.to_string())?;
                written += read as u64;
                downloaded.fetch_add(read as u64, Ordering::Relaxed);
            }
            file.flush().map_err(|error| error.to_string())?;
            if written != expected {
                return Err(format!("分段长度不符：{written} / {expected}"));
            }
            Ok(())
        }));
    }
    log(format!("并行下载 {label}（{} 段）", handles.len()));
    loop {
        if canceled() {
            abort.store(true, Ordering::Relaxed);
            for handle in handles {
                let _ = handle.join();
            }
            return Err("已取消".to_string());
        }
        let done = downloaded.load(Ordering::Relaxed).min(total);
        let fraction = base + span * (done as f32 / total as f32);
        progress(
            Some(fraction.clamp(0.0, 0.99)),
            format!(
                "下载 {label} {:.1} / {:.1} MB",
                done as f64 / 1_000_000.0,
                total as f64 / 1_000_000.0
            ),
        );
        if handles.iter().all(|handle| handle.is_finished()) {
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    let mut failure = None;
    for handle in handles {
        match handle.join() {
            Ok(Ok(())) => {}
            Ok(Err(error)) => failure = Some(error),
            Err(_) => failure = Some("下载线程崩溃".to_string()),
        }
    }
    if let Some(error) = failure {
        return Err(format!("下载 {label} 失败：{error}"));
    }
    let part = dest.with_extension("part");
    let mut output = File::create(&part).map_err(|error| error.to_string())?;
    for path in &part_files {
        let mut input = File::open(path).map_err(|error| error.to_string())?;
        std::io::copy(&mut input, &mut output).map_err(|error| error.to_string())?;
    }
    output.flush().map_err(|error| error.to_string())?;
    drop(output);
    if !verify_sha256(&part, sha256)? {
        // The merged file is only as good as its parts, so a mismatch throws all
        // of them away rather than letting the next run resume onto bad data.
        let _ = fs::remove_file(&part);
        for path in &part_files {
            let _ = fs::remove_file(path);
        }
        return Err(format!("{label} 校验失败"));
    }
    for path in &part_files {
        let _ = fs::remove_file(path);
    }
    fs::rename(&part, dest).map_err(|error| format!("保存 {label} 失败：{error}"))?;
    Ok(true)
}

fn probe_range_total(url: &str) -> Result<Option<u64>, String> {
    let response = agent()
        .get(url)
        .header("User-Agent", USER_AGENT)
        .header("Range", "bytes=0-0")
        .call()
        .map_err(|error| format!("探测分段下载失败：{error}"))?;
    if response.status().as_u16() != 206 {
        return Ok(None);
    }
    Ok(response
        .headers()
        .get("content-range")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.rsplit_once('/'))
        .and_then(|(_, total)| total.parse::<u64>().ok())
        .filter(|total| *total > 0))
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

pub fn verify_sha256(path: &Path, expected: &str) -> Result<bool, String> {
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
    use std::net::TcpListener;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    use super::*;

    #[test]
    fn resumes_existing_range_parts() {
        use crate::services::jobs::JobOutcome;
        use std::sync::Mutex;

        let size = (PARALLEL_MIN + 1024 * 1024) as usize;
        let data: Vec<u8> = (0..size).map(|index| (index * 31 % 251) as u8).collect();
        let sha = Sha256::digest(&data)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let total = size as u64;
        let chunk = total.div_ceil(PARALLEL_PARTS as u64);

        let directory =
            std::env::temp_dir().join(format!("vss-resume-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();
        let dest = directory.join("model.bin");

        // Half of every part is already on disk, as after an interrupted run.
        let mut seeded = 0u64;
        for index in 0..PARALLEL_PARTS {
            let start = index as u64 * chunk;
            if start >= total {
                break;
            }
            let end = (start + chunk - 1).min(total - 1);
            let expected = end - start + 1;
            let have = expected / 2;
            let part = dest.with_extension(format!("part{index}"));
            fs::write(&part, &data[start as usize..(start + have) as usize]).unwrap();
            seeded += have;
        }
        assert!(seeded > 0);

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let ranges = Arc::new(Mutex::new(Vec::new()));
        let server_ranges = ranges.clone();
        let server_data = data.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().take(PARALLEL_PARTS + 1) {
                let Ok(mut stream) = stream else { continue };
                let mut request = Vec::new();
                let mut buffer = [0u8; 2048];
                while let Ok(read) = stream.read(&mut buffer) {
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..read]);
                    if request.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }
                let text = String::from_utf8_lossy(&request).to_ascii_lowercase();
                let Some(line) = text.lines().find(|line| line.starts_with("range:")) else {
                    continue;
                };
                let spec = line.trim_start_matches("range: bytes=").trim();
                let (start, end) = spec.split_once('-').expect("range pair");
                let (start, end) = (
                    start.parse::<usize>().expect("start"),
                    end.parse::<usize>().expect("end"),
                );
                server_ranges.lock().unwrap().push((start, end));
                let body = &server_data[start..=end];
                let header = format!(
                    "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{end}/{}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                    body.len(),
                    server_data.len()
                );
                let _ = stream.write_all(header.as_bytes());
                let _ = stream.write_all(body);
            }
        });

        let urls = vec![format!("http://{address}/model.bin")];
        let job_dest = dest.clone();
        let job_sha = sha.clone();
        let (jobs, _events) = crate::services::jobs::Jobs::new();
        let job = jobs.start("resume", move |ctx| {
            fetch_all(&urls, &job_dest, &job_sha, total, 0.0, 1.0, &ctx, "test")
        });
        assert!(matches!(
            job.result.recv_blocking().unwrap(),
            JobOutcome::Done(())
        ));

        let requested = ranges.lock().unwrap().clone();
        // One probe plus one request per part; every part request must start
        // past its range head, otherwise nothing was resumed. Threads race, so
        // compare the sorted set of offsets rather than arrival order.
        assert_eq!(requested.len(), PARALLEL_PARTS + 1);
        assert_eq!(requested[0], (0, 0));
        let mut starts = requested
            .iter()
            .skip(1)
            .map(|(start, _)| *start as u64)
            .collect::<Vec<_>>();
        starts.sort_unstable();
        let expected = (0..PARALLEL_PARTS as u64)
            .map(|index| index * chunk + chunk / 2)
            .collect::<Vec<_>>();
        assert_eq!(starts, expected);
        assert_eq!(fs::read(&dest).unwrap(), data);
        for index in 0..PARALLEL_PARTS {
            assert!(!dest.with_extension(format!("part{index}")).exists());
        }
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn lists_primary_then_mirrors_then_proxy_pair() {
        let github = "https://github.com/yt-dlp/yt-dlp/releases/download/1/yt-dlp.exe";
        let proxied = format!("https://gh-proxy.com/{github}");
        let from_proxy = candidate_urls(&proxied, &[]);
        assert_eq!(from_proxy[0], proxied);
        assert_eq!(from_proxy[1], github);
        assert_eq!(from_proxy.len(), 2);

        let listed = candidate_urls(
            "https://registry.npmmirror.com/-/binary/ffmpeg-static/b6.1.1/ffmpeg-win32-x64.gz",
            &[github],
        );
        assert_eq!(listed[1], github);
        assert_eq!(listed[2], proxied);

        let deduped = candidate_urls(github, &[github, proxied.as_str()]);
        assert_eq!(deduped, vec![github.to_string(), proxied]);
    }

    #[test]
    fn falls_back_to_the_next_source_when_one_fails() {
        use crate::services::jobs::{JobOutcome, Jobs};

        let data = b"mirrored payload".to_vec();
        let sha = Sha256::digest(&data)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();

        let dead = TcpListener::bind("127.0.0.1:0").unwrap();
        let dead_address = dead.local_addr().unwrap();
        std::thread::spawn(move || {
            for stream in dead.incoming().take(1) {
                drop(stream.unwrap());
            }
        });

        let live = TcpListener::bind("127.0.0.1:0").unwrap();
        let live_address = live.local_addr().unwrap();
        let served = data.clone();
        std::thread::spawn(move || {
            let (mut stream, _) = live.accept().unwrap();
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

        let directory =
            std::env::temp_dir().join(format!("vss-mirror-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&directory);
        fs::create_dir_all(&directory).unwrap();
        let dest = directory.join("file.bin");
        let urls = vec![
            format!("http://{dead_address}/file.bin"),
            format!("http://{live_address}/file.bin"),
        ];
        let job_dest = dest.clone();
        let (jobs, _events) = Jobs::new();
        let job = jobs.start("mirrors", move |ctx| {
            fetch_all(&urls, &job_dest, &sha, 0, 0.0, 1.0, &ctx, "test")
        });
        assert!(matches!(
            job.result.recv_blocking().unwrap(),
            JobOutcome::Done(())
        ));

        assert_eq!(fs::read(&dest).unwrap(), data);
        let log = jobs.snapshot(job.id).expect("snapshot").log;
        assert!(
            log.iter().any(|line| line.contains("换用备用地址")),
            "{log:?}"
        );
        let _ = fs::remove_dir_all(directory);
    }

    #[test]
    fn rejects_unsafe_archive_paths() {
        assert!(safe_relative("../evil").is_none());
        assert!(safe_relative("/abs").is_none());
        assert_eq!(
            safe_relative("numpy/__init__.py"),
            Some(PathBuf::from("numpy/__init__.py"))
        );
    }

    #[test]
    fn downloads_large_files_in_ranges() {
        let size = (PARALLEL_MIN + 1024 * 1024) as usize;
        let data: Vec<u8> = (0..size).map(|index| (index * 31 % 251) as u8).collect();
        let sha = Sha256::digest(&data)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let requests = Arc::new(AtomicUsize::new(0));
        let server_requests = requests.clone();
        let server_data = data.clone();
        let server = std::thread::spawn(move || {
            for stream in listener.incoming().take(PARALLEL_PARTS + 1) {
                let mut stream = stream.unwrap();
                let mut request = Vec::new();
                let mut buffer = [0u8; 2048];
                loop {
                    let read = stream.read(&mut buffer).unwrap();
                    if read == 0 {
                        break;
                    }
                    request.extend_from_slice(&buffer[..read]);
                    if request.windows(4).any(|window| window == b"\r\n\r\n") {
                        break;
                    }
                }
                server_requests.fetch_add(1, Ordering::SeqCst);
                let text = String::from_utf8_lossy(&request);
                let range = text.lines().find_map(|line| {
                    let value = line.to_ascii_lowercase();
                    value
                        .strip_prefix("range: bytes=")
                        .and_then(|range| range.split_once('-'))
                        .map(|(start, end)| {
                            (
                                start.trim().parse::<usize>().unwrap(),
                                end.trim().parse::<usize>().unwrap(),
                            )
                        })
                });
                let (start, end) = range.unwrap();
                let body = &server_data[start..=end];
                let header = format!(
                    "HTTP/1.1 206 Partial Content\r\nContent-Length: {}\r\nContent-Range: bytes {start}-{end}/{}\r\nAccept-Ranges: bytes\r\nConnection: close\r\n\r\n",
                    body.len(),
                    server_data.len()
                );
                stream.write_all(header.as_bytes()).unwrap();
                stream.write_all(body).unwrap();
            }
        });

        let dir = std::env::temp_dir().join(format!("vss-download-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let dest = dir.join("model.bin");
        let job_dest = dest.clone();
        let job_sha = sha.clone();
        let url = format!("http://{address}/model.bin");
        let size = size as u64;
        let (jobs, _events) = crate::services::jobs::Jobs::new();
        let job = jobs.start("download", move |ctx| {
            fetch(&url, &job_dest, &job_sha, size, 0.0, 1.0, &ctx, "test")
        });
        match job.result.recv_blocking().unwrap() {
            crate::services::jobs::JobOutcome::Done(()) => {}
            other => panic!("{other:?}"),
        }
        assert_eq!(fs::read(&dest).unwrap(), data);
        assert_eq!(requests.load(Ordering::SeqCst), PARALLEL_PARTS + 1);
        server.join().unwrap();
        let _ = fs::remove_dir_all(dir);
    }
}
