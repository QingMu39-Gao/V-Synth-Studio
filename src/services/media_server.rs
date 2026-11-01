//! Single-file localhost media server with HTTP Range support.

use std::fs::File;
use std::io::{Read, Seek, SeekFrom, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread::JoinHandle;
use std::time::Duration;

pub struct MediaServer {
    url: String,
    shutdown: Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl MediaServer {
    pub fn start(path: PathBuf, title: String) -> Result<Self, String> {
        let listener = TcpListener::bind("127.0.0.1:0")
            .map_err(|error| format!("启动预览服务失败：{error}"))?;
        listener
            .set_nonblocking(true)
            .map_err(|error| format!("启动预览服务失败：{error}"))?;
        let address = listener
            .local_addr()
            .map_err(|error| format!("读取预览端口失败：{error}"))?;
        let shutdown = Arc::new(AtomicBool::new(false));
        let stop = shutdown.clone();
        let path = Arc::new(path);
        let title = Arc::new(title);
        let handle = std::thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let path = path.clone();
                        let title = title.clone();
                        std::thread::spawn(move || {
                            let _ = handle_connection(stream, &path, &title);
                        });
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    Err(_) => break,
                }
            }
        });
        Ok(Self {
            url: format!("http://{address}/"),
            shutdown,
            handle: Some(handle),
        })
    }

    pub fn url(&self) -> &str {
        &self.url
    }
}

impl Drop for MediaServer {
    fn drop(&mut self) {
        self.shutdown.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

fn handle_connection(mut stream: TcpStream, path: &PathBuf, title: &str) -> Result<(), String> {
    let mut request = Vec::new();
    let mut chunk = [0u8; 1024];
    while !request.windows(4).any(|window| window == b"\r\n\r\n") && request.len() < 16 * 1024 {
        let read = stream
            .read(&mut chunk)
            .map_err(|error| format!("读取请求失败：{error}"))?;
        if read == 0 {
            break;
        }
        request.extend_from_slice(&chunk[..read]);
    }
    let text = String::from_utf8_lossy(&request);
    let mut lines = text.lines();
    let Some(request_line) = lines.next() else {
        return write_status(&mut stream, 400, "bad request");
    };
    let mut parts = request_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let target = parts.next().unwrap_or("/").split('?').next().unwrap_or("/");
    let range = lines
        .find_map(|line| {
            line.strip_prefix("Range: ")
                .or_else(|| line.strip_prefix("range: "))
        })
        .map(str::to_string);

    if target == "/" {
        if method != "GET" && method != "HEAD" {
            return write_status(&mut stream, 405, "method not allowed");
        }
        let body = player_html(title);
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .map_err(|error| error.to_string())?;
        if method == "GET" {
            stream
                .write_all(body.as_bytes())
                .map_err(|error| error.to_string())?;
        }
        return Ok(());
    }

    if target != "/media" {
        return write_status(&mut stream, 404, "not found");
    }
    if method != "GET" && method != "HEAD" {
        return write_status(&mut stream, 405, "method not allowed");
    }
    let length = std::fs::metadata(path)
        .map_err(|error| format!("读取视频失败：{error}"))?
        .len();
    let selected = match range.as_deref().map(|value| parse_range(value, length)) {
        Some(Ok(range)) => range,
        Some(Err(())) => {
            write!(
                stream,
                "HTTP/1.1 416 Range Not Satisfiable\r\nContent-Range: bytes */{length}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
            )
            .map_err(|error| error.to_string())?;
            return Ok(());
        }
        None => None,
    };
    let (start, end) = selected.unwrap_or((0, length.saturating_sub(1)));
    let size = end.saturating_sub(start) + 1;
    let status = if selected.is_some() {
        "206 Partial Content"
    } else {
        "200 OK"
    };
    write!(
        stream,
        "HTTP/1.1 {status}\r\nContent-Type: video/mp4\r\nContent-Length: {size}\r\nAccept-Ranges: bytes\r\nCache-Control: no-store\r\nConnection: close\r\n"
    )
    .map_err(|error| error.to_string())?;
    if selected.is_some() {
        write!(stream, "Content-Range: bytes {start}-{end}/{length}\r\n")
            .map_err(|error| error.to_string())?;
    }
    write!(stream, "\r\n").map_err(|error| error.to_string())?;
    if method == "HEAD" {
        return Ok(());
    }
    let mut file = File::open(path).map_err(|error| format!("读取视频失败：{error}"))?;
    file.seek(SeekFrom::Start(start))
        .map_err(|error| format!("定位视频失败：{error}"))?;
    std::io::copy(&mut file.take(size), &mut stream)
        .map_err(|error| format!("发送视频失败：{error}"))?;
    Ok(())
}

fn parse_range(value: &str, length: u64) -> Result<Option<(u64, u64)>, ()> {
    let value = value.strip_prefix("bytes=").ok_or(())?;
    let (start, end) = value.split_once('-').ok_or(())?;
    let start = start.parse::<u64>().map_err(|_| ())?;
    let end = if end.is_empty() {
        length.saturating_sub(1)
    } else {
        end.parse::<u64>().map_err(|_| ())?
    };
    if start > end || start >= length {
        return Err(());
    }
    Ok(Some((start, end.min(length.saturating_sub(1)))))
}

fn write_status(stream: &mut TcpStream, code: u16, message: &str) -> Result<(), String> {
    write!(
        stream,
        "HTTP/1.1 {code} {message}\r\nContent-Type: text/plain\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{message}",
        message.len()
    )
    .map_err(|error| error.to_string())
}

fn player_html(title: &str) -> String {
    let title = escape_html(title);
    format!(
        r#"<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
html, body {{ margin: 0; height: 100%; background: #0b0b0c; color: #e8e8e8; font-family: system-ui, sans-serif; }}
body {{ display: flex; flex-direction: column; }}
header {{ padding: 12px 16px; font-size: 13px; color: #b8b8b8; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }}
main {{ flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; }}
video {{ width: 100%; height: 100%; background: #000; }}
</style>
</head>
<body>
<header>{title}</header>
<main><video controls preload="metadata" src="/media"></video></main>
</body>
</html>"#
    )
}

fn escape_html(text: &str) -> String {
    text.chars()
        .flat_map(|character| match character {
            '&' => "&amp;".chars().collect::<Vec<_>>(),
            '<' => "&lt;".chars().collect(),
            '>' => "&gt;".chars().collect(),
            '"' => "&quot;".chars().collect(),
            '\'' => "&#39;".chars().collect(),
            other => vec![other],
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn serves_ranges_and_rejects_invalid_ones() {
        let path = std::env::temp_dir().join(format!(
            "vss-media-{}-{}.mp4",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let mut file = File::create(&path).unwrap();
        file.write_all(b"0123456789").unwrap();
        drop(file);

        let server = MediaServer::start(path.clone(), "Test".to_string()).unwrap();
        let url = format!("{}media", server.url());
        let response = ureq::get(&url).header("Range", "bytes=2-5").call().unwrap();
        assert_eq!(response.status(), 206);
        assert_eq!(
            response
                .headers()
                .get("content-range")
                .unwrap()
                .to_str()
                .unwrap(),
            "bytes 2-5/10"
        );
        let mut body = Vec::new();
        response
            .into_body()
            .into_reader()
            .read_to_end(&mut body)
            .unwrap();
        assert_eq!(body, b"2345");

        let invalid = ureq::get(&url).header("Range", "bytes=20-30").call();
        assert!(invalid.is_err() || invalid.unwrap().status() == 416);

        drop(server);
        let _ = std::fs::remove_file(path);
    }
}
