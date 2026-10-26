# V-Synth Studio

GPUI desktop application for vocal-synthesis workflow: project conversion, media
download and preview, audio tools, source separation, MIDI transcription, lyrics,
and lyric-motion video editing.

This repository is a native rewrite. It does not build against or read from any
other checkout; all source, assets, and data it needs live here.

## Requirements

- Rust with edition 2024 support
- Windows 10/11 with the WebView2 Runtime (Text PV and media preview)
- Linux and macOS are not yet verified

Node.js and Python are not required.

## Run

```bash
cargo run
```

Debug builds read and write `data/config.json` under the repository root. Release
builds use the directory containing the executable.

## Layout

| Path | Purpose |
|---|---|
| `src/app.rs` | window shell, navigation, pages |
| `src/config.rs` | application settings |
| `src/jizura.rs` | JIZURA asset serving and `J.saveFile` bridge |
| `src/jizura_save.rs` | chunked export-to-disk |
| `src/resources.rs` | resource library |
| `src/tools.rs` | external tool detection |
| `assets/jizura/` | pinned JIZURA build |
| `data/resources.json` | resource library content |
| `docs/` | third-party notices and other project documents |

## External components

Settings → External components downloads pinned upstream archives, verifies their
SHA-256, and installs them under `tools/`. Archives are cached in
`data/cache/artifacts/`. Both directories are ignored by Git.

## Third-party assets

JIZURA is vendored from its upstream repository at the commit recorded in
[`assets/jizura/UPSTREAM.md`](assets/jizura/UPSTREAM.md). Its license and notices
are stored next to the build.

See [`docs/THIRD-PARTY-NOTICES.md`](docs/THIRD-PARTY-NOTICES.md) for the full list.
