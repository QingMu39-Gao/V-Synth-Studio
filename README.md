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

## Packaging

```powershell
scripts/package.ps1          # build release + dist/V-Synth-Studio-<version>-windows-x64.zip
scripts/build-installer.ps1  # portable layout + NSIS setup at dist/...-setup.exe
```

Packaging copies only the executable and the assets, resource JSON, notices and
license from this repository. External tools, the Python runtime and model packs
are deliberately not bundled; they are downloaded on demand from the app.

The installer scripts use a portable NSIS at
`.tools/nsis/nsis-3.13/makensis.exe` (ignored by Git) and install per-user under
`%LOCALAPPDATA%\Programs\V-Synth-Studio`. The setup and uninstaller support `/S`
and `/D=<directory>` for scripted checks.

## Updates

Installed builds check the manifest at
`.../releases/latest/download/vss-gpui-version.json` from Settings; so does the
announcement panel. The manifest path stays version-free because it is a release
*asset name*, while the package URL inside it is pinned to the tag so one
release's bytes and SHA-256 can never drift onto another:

```json
{
  "version": "1.6.0",
  "published_at": "2026-10-29T00:00:00Z",
  "changelog": "…",
  "downloads": {
    "windows": {
      "url": "https://github.com/QingMu39-Gao/V-Synth-Studio/releases/download/v1.6.0/V-Synth-Studio-1.6.0-windows-x64-setup.exe",
      "size": 6278154,
      "sha256": "…"
    }
  }
}
```

After bumping `Cargo.toml` and building the setup, generate the manifest and
upload both files:

```powershell
scripts/make-manifest.ps1 -Url "https://…/V-Synth-Studio-1.6.0-windows-x64-setup.exe" -Changelog "…"
```

Updates are installed only for builds that contain `Uninstall.exe`; portable
builds open the downloaded file's folder instead. HTTPS and SHA-256 are required.

The retired Tauri line read `admin1.qingmu39.top`, which no longer exists, so
installs below 1.6.0 have to be replaced by hand once; from there on this channel
carries them.

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

## Languages

The interface ships in Chinese, English and Japanese. The preference is stored
in `data/config.json`. External component logs and resource content remain in
their original language for now.
