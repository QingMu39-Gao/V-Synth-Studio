//! JIZURA 静态资源定位与 Wry custom protocol 服务。
//!
//! 资源放在程序根下的 `assets/jizura/`，页面只通过 `jizura://localhost/` 访问，
//! 不暴露任意文件路径。上游版本与校验和见 `assets/jizura/UPSTREAM.md`。

use std::borrow::Cow;
use std::fs;
use std::path::{Path, PathBuf};

use wry::http::{header::CONTENT_TYPE, Request, Response, StatusCode};

pub const SCHEME: &str = "jizura";
pub const START_URL: &str = "jizura://localhost/index.html";

/// 接管 `J.saveFile`，并把编辑器就绪、歌词回填与保存结果通过 IPC 报回宿主。
///
/// 每块 8 MiB POST 到同源的 `/__save`，由 Rust 追加到临时文件，最后一块原子改名。
/// 用 getter 持续返回桥接函数，防止 JIZURA boot 后重新赋值把接管冲掉。
pub fn save_bridge_script() -> &'static str {
    r#"
(() => {
  const CHUNK = 8 * 1024 * 1024;
  const send = (payload) => {
    try { window.ipc?.postMessage(JSON.stringify(payload)); } catch (_) {}
  };
  const saveUrl = (query) =>
    (location.protocol === 'http:' || location.protocol === 'https:')
      ? `${location.origin}/__save?${query}`
      : `jizura://localhost/__save?${query}`;
  const isBlob = (value) =>
    typeof value === 'object' && value !== null &&
    Object.prototype.toString.call(value) === '[object Blob]';
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  async function bridgeSave(name, data) {
    const blob = isBlob(data) ? data : new Blob([data]);
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2);
    const label = String(name ?? 'export');
    try {
      let savedPath = '';
      if (blob.size === 0) {
        const res = await fetch(saveUrl(`id=${id}&name=${encodeURIComponent(label)}&last=1`), {
          method: 'POST',
          body: new Uint8Array(),
        });
        if (res.status === 403) { send({ type: 'save_canceled', name: label }); return 'saved'; }
        if (!res.ok) throw new Error(await res.text());
        savedPath = await res.text();
      } else {
        for (let offset = 0; offset < blob.size; offset += CHUNK) {
          const last = offset + CHUNK >= blob.size ? 1 : 0;
          const query = `id=${id}&name=${encodeURIComponent(label)}&offset=${offset}&last=${last}`;
          const res = await fetch(saveUrl(query), {
            method: 'POST',
            body: blob.slice(offset, offset + CHUNK),
          });
          if (res.status === 403) { send({ type: 'save_canceled', name: label }); return 'saved'; }
          if (!res.ok) throw new Error(await res.text());
          const text = await res.text();
          if (last) savedPath = text;
        }
      }
      send({ type: 'saved', name: label, path: savedPath });
      return 'saved';
    } catch (error) {
      const message = String(error && error.message ? error.message : error);
      send({ type: 'save_error', name: label, message });
      throw error;
    }
  }

  const lyricsBox = () =>
    document.getElementById('lyrics') || document.querySelector('textarea');

  async function waitEditor(timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (document.readyState === 'complete' && window.J && window.J.uiApi && lyricsBox()) {
        return true;
      }
      await sleep(200);
    }
    return false;
  }

  async function fillLyrics(text) {
    const wanted = String(text ?? '');
    if (!(await waitEditor(30000))) {
      send({ type: 'fill', ok: false, got: 0, want: wanted.length, message: 'editor unavailable' });
      return;
    }
    const write = () => {
      const box = lyricsBox();
      if (!box) return;
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (setter) setter.call(box, wanted);
      else box.value = wanted;
      box.dispatchEvent(new Event('input', { bubbles: true }));
      try { window.J?.uiApi?.replan?.(); } catch (_) {}
      try { window.J?.uiApi?.flushSave?.(); } catch (_) {}
    };
    write();
    const deadline = Date.now() + 15000;
    let overwrittenAt = 0;
    let current = '';
    while (true) {
      await sleep(200);
      const box = lyricsBox();
      current = box ? box.value : '';
      if (!overwrittenAt && current !== '' && current !== wanted) overwrittenAt = Date.now();
      if (current === wanted && (!overwrittenAt || Date.now() - overwrittenAt > 600)) break;
      if (Date.now() >= deadline) break;
      write();
    }
    send({ type: 'fill', ok: current === wanted, got: current.length, want: wanted.length });
  }

  window.__vss = { fillLyrics };

  let readySent = false;
  const probe = setInterval(() => {
    if (readySent) { clearInterval(probe); return; }
    if (document.readyState === 'complete' && window.J && window.J.uiApi && lyricsBox()) {
      readySent = true;
      send({ type: 'ready' });
      clearInterval(probe);
    }
  }, 200);

  let tries = 0;
  const timer = setInterval(() => {
    tries += 1;
    if (tries > 300) { clearInterval(timer); return; }
    if (!window.J) return;
    try {
      Object.defineProperty(window.J, 'saveFile', {
        configurable: true,
        get() { return bridgeSave; },
        set() {},
      });
      clearInterval(timer);
    } catch (_) {
      window.J.saveFile = bridgeSave;
      clearInterval(timer);
    }
  }, 200);
})();
"#
}

pub fn asset_dir() -> Option<PathBuf> {
    let local = crate::config::app_root().join("assets").join("jizura");
    if local.join("index.html").is_file() {
        return Some(local);
    }
    // `cargo run --release` executes from target/release, where packaging has not
    // copied assets yet; fall back to the checkout the binary was built from.
    let checkout = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("assets")
        .join("jizura");
    checkout.join("index.html").is_file().then_some(checkout)
}

pub fn serve(root: &Path, request: Request<Vec<u8>>) -> Response<Cow<'static, [u8]>> {
    let path = request.uri().path().trim_start_matches('/');
    if path == "__save" {
        return crate::jizura_save::handle(request);
    }
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
