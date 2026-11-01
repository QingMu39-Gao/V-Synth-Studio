//! JIZURA 导出的分块落盘。
//!
//! 页面把 `J.saveFile(name, blob)` 改成每 8 MiB POST 到 `/__save`；第一块到达时
//! 让用户选目录，之后按 id 追加到同目录的 `.part`，最后一块关闭文件并原子改名。
//! 一条保存只保留一个打开的文件句柄，峰值内存是单块大小。

use std::borrow::Cow;
use std::collections::HashMap;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};

use wry::http::{header::CONTENT_TYPE, Request, Response, StatusCode};

struct Session {
    file: File,
    temp: PathBuf,
    final_path: PathBuf,
}

static SESSIONS: OnceLock<Mutex<HashMap<String, Session>>> = OnceLock::new();

fn sessions() -> &'static Mutex<HashMap<String, Session>> {
    SESSIONS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn handle(request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let query = request.uri().query().unwrap_or_default();
    let id = param(query, "id").unwrap_or_default();
    if !valid_id(&id) {
        return text(StatusCode::BAD_REQUEST, "invalid save id");
    }
    let last = param(query, "last").as_deref() == Some("1");
    let name = sanitize_name(&param(query, "name").unwrap_or_default());

    let exists = sessions()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .contains_key(&id);
    if !exists {
        let Some(folder) = choose_folder() else {
            return text(StatusCode::FORBIDDEN, "save cancelled");
        };
        if let Err(error) = fs::create_dir_all(&folder) {
            return text(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("创建导出目录失败：{error}"),
            );
        }
        let final_path = unique_path(&folder, &name);
        let temp = folder.join(format!(".vss-{id}.part"));
        let _ = fs::remove_file(&temp);
        let file = match OpenOptions::new().create_new(true).write(true).open(&temp) {
            Ok(file) => file,
            Err(error) => {
                return text(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("创建临时文件失败：{error}"),
                );
            }
        };
        sessions()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .insert(
                id.clone(),
                Session {
                    file,
                    temp,
                    final_path,
                },
            );
    }

    let write_result = {
        let mut map = sessions().lock().unwrap_or_else(|error| error.into_inner());
        match map.get_mut(&id) {
            Some(session) => session
                .file
                .write_all(request.body())
                .and_then(|_| session.file.flush()),
            None => return text(StatusCode::CONFLICT, "unknown save id"),
        }
    };
    if let Err(error) = write_result {
        if let Some(session) = sessions()
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&id)
        {
            let _ = fs::remove_file(session.temp);
        }
        return text(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("写入导出文件失败：{error}"),
        );
    }

    if !last {
        return text(StatusCode::OK, "chunk stored");
    }

    let Some(session) = sessions()
        .lock()
        .unwrap_or_else(|error| error.into_inner())
        .remove(&id)
    else {
        return text(StatusCode::CONFLICT, "unknown save id");
    };
    drop(session.file);
    if let Err(error) = fs::rename(&session.temp, &session.final_path) {
        let _ = fs::remove_file(&session.temp);
        return text(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("保存导出文件失败：{error}"),
        );
    }
    text(StatusCode::OK, session.final_path.display().to_string())
}

fn choose_folder() -> Option<PathBuf> {
    if let Ok(dir) = std::env::var("VSS_JIZURA_SAVE_DIR") {
        let dir = PathBuf::from(dir);
        if !dir.as_os_str().is_empty() {
            let _ = fs::create_dir_all(&dir);
            if dir.is_dir() {
                return Some(dir);
            }
        }
    }
    rfd::FileDialog::new()
        .set_title("选择导出目录")
        .pick_folder()
}

fn param(query: &str, key: &str) -> Option<String> {
    query.split('&').find_map(|pair| {
        let (name, value) = pair.split_once('=')?;
        (name == key).then(|| value.to_string())
    })
}

fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric())
}

fn sanitize_name(raw: &str) -> String {
    let decoded = urlencoding::decode(raw)
        .map(|value| value.into_owned())
        .unwrap_or_else(|_| raw.to_string());
    let base = Path::new(&decoded)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("export.bin");
    let cleaned = base
        .chars()
        .map(|c| {
            if c.is_control() || matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') {
                '_'
            } else {
                c
            }
        })
        .collect::<String>();
    let cleaned = cleaned.trim().trim_matches('.').trim();
    if cleaned.is_empty() {
        "export.bin".to_string()
    } else {
        cleaned.to_string()
    }
}

fn unique_path(dir: &Path, name: &str) -> PathBuf {
    let candidate = dir.join(name);
    if !candidate.exists() {
        return candidate;
    }
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .unwrap_or("export");
    let extension = path
        .extension()
        .and_then(|extension| extension.to_str())
        .map(|extension| format!(".{extension}"))
        .unwrap_or_default();
    for index in 2..10_000 {
        let candidate = dir.join(format!("{stem} ({index}){extension}"));
        if !candidate.exists() {
            return candidate;
        }
    }
    dir.join(format!("{stem}-{}{extension}", std::process::id()))
}

fn text(status: StatusCode, message: impl Into<String>) -> Response<Cow<'static, [u8]>> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, "text/plain; charset=utf-8")
        .body(Cow::Owned(message.into().into_bytes()))
        .expect("static response metadata")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitizes_paths_and_empty_names() {
        let name = sanitize_name("%2e%2e%2fevil.exe");
        assert!(!name.contains('/'));
        assert!(!name.contains('\\'));
        assert_eq!(sanitize_name(""), "export.bin");
    }

    #[test]
    fn avoids_overwriting_existing_files() {
        let dir = std::env::temp_dir().join(format!(
            "vss-save-test-{}-{}",
            std::process::id(),
            line!()
        ));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("a.wav"), b"x").unwrap();
        let next = unique_path(&dir, "a.wav");
        assert_ne!(next.file_name().unwrap(), "a.wav");
        let _ = fs::remove_dir_all(dir);
    }
}
