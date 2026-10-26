//! JIZURA 静态资源的开发期定位与 Wry custom protocol 服务。
//!
//! 打包后资源应放在可执行文件旁的 `assets/jizura/`；开发期回退到本仓旁边的
//! `public/vendor/jizura/`。页面只通过 `jizura://localhost/` 访问，不暴露
//! 任意文件路径。

use std::borrow::Cow;
use std::fs;
use std::path::{Path, PathBuf};

use wry::http::{Request, Response, StatusCode, header::CONTENT_TYPE};

pub const SCHEME: &str = "jizura";
pub const START_URL: &str = "jizura://localhost/index.html";

pub fn asset_dir() -> Option<PathBuf> {
    let root = crate::config::app_root();
    [
        root.join("assets").join("jizura"),
        root.join("vendor").join("jizura"),
        root.join("jizura"),
        root.join("..").join("public").join("vendor").join("jizura"),
    ]
    .into_iter()
    .find(|dir| dir.join("index.html").is_file())
}

pub fn serve(root: &Path, request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let path = request.uri().path().trim_start_matches('/');
    let relative = if path.is_empty() { "index.html" } else { path };
    let Some(file) = safe_file(root, relative) else {
        return error(StatusCode::NOT_FOUND, "not found");
    };
    let Ok(bytes) = fs::read(&file) else {
        return error(StatusCode::INTERNAL_SERVER_ERROR, "read failed");
    };
    Response::builder()
        .status(StatusCode::OK)
        .header(CONTENT_TYPE, mime_of(relative))
        .body(Cow::Owned(bytes))
        .unwrap_or_else(|_| error(StatusCode::INTERNAL_SERVER_ERROR, "response failed"))
}

fn safe_file(root: &Path, relative: &str) -> Option<PathBuf> {
    if relative.split('/').any(|part| part == "..") {
        return None;
    }
    let root = root.canonicalize().ok()?;
    let file = root.join(relative).canonicalize().ok()?;
    file.starts_with(&root).then_some(file)
}

fn error(status: StatusCode, message: &'static str) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Cow::Borrowed(message.as_bytes()))
        .expect("static error response")
}

fn mime_of(path: &str) -> &'static str {
    let lower = path.to_ascii_lowercase();
    if lower.ends_with(".html") {
        "text/html; charset=utf-8"
    } else if lower.ends_with(".css") {
        "text/css; charset=utf-8"
    } else if lower.ends_with(".js") {
        "text/javascript; charset=utf-8"
    } else if lower.ends_with(".json") {
        "application/json; charset=utf-8"
    } else if lower.ends_with(".woff2") {
        "font/woff2"
    } else if lower.ends_with(".woff") {
        "font/woff"
    } else if lower.ends_with(".ttf") {
        "font/ttf"
    } else if lower.ends_with(".svg") {
        "image/svg+xml"
    } else if lower.ends_with(".png") {
        "image/png"
    } else if lower.ends_with(".jpg") || lower.ends_with(".jpeg") {
        "image/jpeg"
    } else if lower.ends_with(".mp3") {
        "audio/mpeg"
    } else if lower.ends_with(".wav") {
        "audio/wav"
    } else {
        "application/octet-stream"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_common_asset_types() {
        assert!(mime_of("index.html").starts_with("text/html"));
        assert_eq!(mime_of("fonts.css"), "text/css; charset=utf-8");
        assert_eq!(mime_of("fonts/a.woff2"), "font/woff2");
        assert_eq!(mime_of("x.bin"), "application/octet-stream");
    }

    #[test]
    fn rejects_parent_directory_paths() {
        let root = Path::new(".");
        assert!(safe_file(root, "../secret.txt").is_none());
    }
}
