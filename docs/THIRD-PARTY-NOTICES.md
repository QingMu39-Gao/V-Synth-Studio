# Third-party notices

## Bundled applications and assets

### JIZURA 0.10.1

- Copyright (c) 2026 hakoniwa
- License: MIT
- Upstream: <https://github.com/852wa/JIZURA>
- Pinned commit and checksum: `assets/jizura/UPSTREAM.md`
- License text: `assets/jizura/LICENSE`
- Additional notices: `assets/jizura/THIRD_PARTY_NOTICES.md`

The JIZURA build loads fonts from Google Fonts at runtime. Those fonts remain
subject to their own licenses.

### WebView2 Runtime

Windows builds require the Microsoft Edge WebView2 Runtime. It is a system
component governed by Microsoft's distribution terms.

## Rust dependencies (direct)

| Component | License |
|---|---|
| gpui-kit 0.8 | Apache-2.0 |
| gpui-webview 0.8 | Apache-2.0 |
| GPUI / gpui-base 0.8 | Apache-2.0 |
| gpui-component 0.8 | Apache-2.0 |
| gpui-pre-windows 0.3.9 (vendored patch) | Apache-2.0 |
| wry / lb-wry 0.53.3 | Apache-2.0 OR MIT |
| open 5 | MIT |
| rfd 0.16 | MIT |
| urlencoding 2.1 | MIT |
| serde 1 | MIT OR Apache-2.0 |
| serde_json 1 | MIT OR Apache-2.0 |

Transitive Rust dependencies are recorded in `Cargo.lock`; their license texts
are available from the crate sources.

## External tools

These tools are distributed with the application when their corresponding
feature ships.

| Tool | License |
|---|---|
| LibreSVIP 2.9 | Apache-2.0 |
| FFmpeg | LGPL-2.1-or-later or GPL-2.0-or-later, depending on the build |
| yt-dlp | Unlicense |
| ONNX Runtime | MIT |
| Python runtime (source separation) | PSF-2.0 |
