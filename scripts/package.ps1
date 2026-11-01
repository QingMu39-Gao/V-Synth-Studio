param([switch]$SkipBuild)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

$cargo = Get-Content "$root/Cargo.toml" -Raw
$version = [regex]::Match($cargo, '(?m)^version\s*=\s*"([^"]+)"').Groups[1].Value
if (-not $version) { throw 'cannot read version from Cargo.toml' }

if (-not $SkipBuild) {
    & cargo build --release
    if ($LASTEXITCODE -ne 0) { throw 'cargo build --release failed' }
}

$name = "V-Synth-Studio-$version-windows-x64"
$stage = Join-Path $root "dist/$name"
$zip = Join-Path $root "dist/$name.zip"
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item (Join-Path $stage 'assets') -ItemType Directory -Force | Out-Null
New-Item (Join-Path $stage 'data') -ItemType Directory -Force | Out-Null
New-Item (Join-Path $stage 'docs') -ItemType Directory -Force | Out-Null

Copy-Item "$root/target/release/v-synth-studio.exe" "$stage/V-Synth-Studio.exe"
Copy-Item "$root/assets/*" (Join-Path $stage 'assets') -Recurse
Copy-Item "$root/data/resources.json" (Join-Path $stage 'data/resources.json')
Copy-Item "$root/docs/THIRD-PARTY-NOTICES.md" (Join-Path $stage 'docs/THIRD-PARTY-NOTICES.md')
Copy-Item "$root/README.md" "$stage/README.md"
Copy-Item "$root/LICENSE" "$stage/LICENSE"

if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
Write-Output "portable: $zip"
