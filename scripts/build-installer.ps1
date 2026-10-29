param([switch]$SkipPackage)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $root

if (-not $SkipPackage) {
    & "$root/scripts/package.ps1" -SkipBuild:$false
    if ($LASTEXITCODE -ne 0) { throw 'portable packaging failed' }
}

$cargo = Get-Content "$root/Cargo.toml" -Raw
$version = [regex]::Match($cargo, '(?m)^version\s*=\s*"([^"]+)"').Groups[1].Value
$stage = Join-Path $root "dist/V-Synth-Studio-$version-windows-x64"
$setup = Join-Path $root "dist/V-Synth-Studio-$version-windows-x64-setup.exe"
$makensis = Join-Path $root ".tools/nsis/nsis-3.13/makensis.exe"
if (-not (Test-Path $makensis)) {
    throw "portable NSIS not found at $makensis"
}

& $makensis "/DVERSION=$version" "/DPACKAGE_DIR=$stage" "/DOUTFILE=$setup" "$root/scripts/installer.nsi"
if ($LASTEXITCODE -ne 0) { throw 'makensis failed' }
Write-Output "installer: $setup"
