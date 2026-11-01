# JIZURA

- Upstream: <https://github.com/852wa/JIZURA>
- Version: 0.10.1
- Commit: `fc16bfe43ea4a6c25a21f1caf04d17326de14f00`
- Bundled file: `zh-hans/index.html`
- SHA-256: `72bbebf3476d18dc14ac712a8a3702bf49a47528b98feeb6d9eae925bfd2d7a5`
- License: MIT, copyright (c) 2026 hakoniwa

The build loads Google Fonts at runtime. Without a network connection JIZURA
falls back to locally installed fonts.

## Update

Replacing the build requires the same three files plus a refreshed hash in this
document:

```bash
base=https://raw.githubusercontent.com/852wa/JIZURA/<commit>/zh-hans
curl -fL "$base/index.html" -o assets/jizura/index.html
curl -fL "https://raw.githubusercontent.com/852wa/JIZURA/<commit>/LICENSE" \
  -o assets/jizura/LICENSE
curl -fL "https://raw.githubusercontent.com/852wa/JIZURA/<commit>/THIRD_PARTY_NOTICES.md" \
  -o assets/jizura/THIRD_PARTY_NOTICES.md
sha256sum assets/jizura/index.html
```
