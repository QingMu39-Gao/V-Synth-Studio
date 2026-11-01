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
$candidates = @(
    (Join-Path $root ".tools/nsis/nsis-3.13/makensis.exe"),
    "$env:ProgramFiles\NSIS\makensis.exe",
    "${env:ProgramFiles(x86)}\NSIS\makensis.exe"
)
$makensis = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $makensis) {
    $command = Get-Command makensis -ErrorAction SilentlyContinue
    if ($command) { $makensis = $command.Source }
}
if (-not $makensis) {
    throw 'makensis not found (portable NSIS or an installed NSIS is required)'
}

& $makensis "/DVERSION=$version" "/DPACKAGE_DIR=$stage" "/DOUTFILE=$setup" "$root/scripts/installer.nsi"
if ($LASTEXITCODE -ne 0) { throw 'makensis failed' }
Write-Output "installer: $setup"
