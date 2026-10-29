param(
    [Parameter(Mandatory = $true)][string]$Url,
    [string]$Changelog = '',
    [string]$Setup = ''
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$cargo = Get-Content "$root/Cargo.toml" -Raw
$version = [regex]::Match($cargo, '(?m)^version\s*=\s*"([^"]+)"').Groups[1].Value
if (-not $Setup) { $Setup = "$root/dist/V-Synth-Studio-$version-windows-x64-setup.exe" }
if (-not $Url.StartsWith('https://')) { throw 'the download URL must use HTTPS' }
if (-not (Test-Path $Setup)) { throw "setup not found: $Setup" }

$file = Get-Item $Setup
$hash = (Get-FileHash -Algorithm SHA256 -Path $Setup).Hash.ToLower()
$published = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
$manifest = [ordered]@{
    version      = $version
    published_at = $published
    changelog    = $Changelog
    downloads    = [ordered]@{
        windows = [ordered]@{
            url    = $Url
            size   = $file.Length
            sha256 = $hash
        }
    }
}
$out = "$root/dist/vss-gpui-version.json"
$json = $manifest | ConvertTo-Json -Depth 5
[System.IO.File]::WriteAllText($out, $json, [System.Text.UTF8Encoding]::new($false))
Write-Output $out
