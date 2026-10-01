# Pack the two big non-source blobs into Release assets.
#
#   tools\                  -> tools.zip   (ffmpeg + yt-dlp + LibreSVIP, ~129 MB)
#   app\web\vendor\jizura\  -> jizura.zip  (JIZURA + 2335 woff2, ~51 MB)
#
# Upload both to a GitHub Release tagged assets-v1; after that
# app\desktop\fetch-tools.ps1 can restore them on a clean machine / in CI,
# which is why the repo itself stays at ~7 MB of source only.
#
# NOTE: this script ONLY packs. Uploading is yours to do.
# NOTE: think before repacking -- the current zips are the ones already in use.
#       New bytes mean every machine without a warm cache downloads again.
#
#   powershell -ExecutionPolicy Bypass -File tools\zip-assets.ps1
#   powershell -ExecutionPolicy Bypass -File tools\zip-assets.ps1 -Src app\data -Name probe

param(
    [string]$Out,      # 输出目录；默认是 <程序根目录>\资料归档
    [switch]$Force,    # 覆盖已存在的 zip
    [string]$Src,      # 只打一个目录（自检用，相对程序根目录）
    [string]$Name,     # 配合 -Src：产物名（不含 .zip）
    [string]$Root      # 程序根目录；默认从脚本位置（tools\）上溯一级
)

$ErrorActionPreference = 'Stop'

if (-not $Root) { $Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path) }
if (-not (Test-Path (Join-Path $Root 'app\desktop'))) {
    throw "看着不像程序根目录：$Root（下面应该有 app\desktop\）"
}
if (-not $Out) { $Out = Join-Path $Root '资料归档' }

$Out = [IO.Path]::GetFullPath($Out)
New-Item -ItemType Directory -Path $Out -Force | Out-Null

$plan = @()
if ($Src) {
    if (-not $Name) { $Name = Split-Path -Leaf $Src }
    # 自检时按目录叶子名猜：tools 是「摊平」，别的一律带一层壳（与下面的正式清单一致）
    $plan += , @{ Src = $Src; Name = $Name; Wrap = ($Name -ne 'tools') }
} else {
    # ⚠️ Wrap 这两项不能想当然，它是 fetch-tools.ps1 解压后按哪条路找文件决定的：
    #   tools  → 摊平（zip 顶层直接是 ffmpeg\ / libresvip\ / yt-dlp.exe）。
    #            那边是 `Get-ChildItem $ex` 逐个搬到 tools\<名字>；多一层 tools\ 壳
    #            就变成 tools\tools\ffmpeg\…，而 libresvip.rs / audio.rs 找的是
    #            tools\ffmpeg\bin\ffmpeg.exe —— 转换和音频一起坏，且打包时不报错。
    #   jizura → 带一层 jizura\ 壳。那边先找 <解压>\jizura\index.html，
    #            找不到才递归搜名为 jizura 的目录。
    $plan += , @{ Src = 'tools';                 Name = 'tools';  Wrap = $false }
    $plan += , @{ Src = 'app\web\vendor\jizura'; Name = 'jizura'; Wrap = $true }
}

$bad = 0
foreach ($item in $plan) {
    $from = Join-Path $Root $item.Src
    $to   = Join-Path $Out  ($item.Name + '.zip')

    Write-Host ""
    Write-Host "-- $($item.Src) -> $to"

    if (-not (Test-Path $from)) {
        Write-Host "  [跳过] 源目录不存在：$from"
        $bad++
        continue
    }

    $files = @(Get-ChildItem $from -Recurse -File -Force -ErrorAction SilentlyContinue)
    $bytes = ($files | Measure-Object -Property Length -Sum).Sum
    Write-Host ("  源：{0:N0} 个文件，{1:N1} MB" -f $files.Count, ($bytes / 1MB))
    if ($files.Count -eq 0) {
        Write-Host "  [跳过] 空目录，打出来是个没用的 zip"
        $bad++
        continue
    }

    if ((Test-Path $to) -and -not $Force) {
        Write-Host ("  [跳过] 已存在 {0}（{1:N1} MB）—— 要重打加 -Force" -f (Split-Path -Leaf $to), ((Get-Item $to).Length / 1MB))
        continue
    }

    # ⚠️ -Path 是这两个字符串之一，别写成别的形式：
    #     摊平 → "$from\*"   把这一层剥掉（tools.zip）
    #     带壳 → "$from"     连这一层目录一起收（jizura.zip）
    #    写成反了不会报错，只会在用户点「工程转换」/「文字 PV」时才现形。
    $pattern = if ($item.Wrap) { $from } else { Join-Path $from '*' }
    if (Test-Path $to) { Remove-Item $to -Force }
    Write-Host "  打包中…"
    Compress-Archive -Path $pattern -DestinationPath $to -CompressionLevel Optimal
    Write-Host ("  [完成] {0}  {1:N1} MB" -f (Split-Path -Leaf $to), ((Get-Item $to).Length / 1MB))
}

Write-Host ""
if ($bad -gt 0) {
    Write-Host "有 $bad 项没打成（见上面的 [跳过]）。"
    exit 1
}

Write-Host "下一步（这个脚本不做）：把 $Out 下的 zip 传上去"
Write-Host "  · 建一个 tag 叫 assets-v1 的 Release，附上这两个文件"
Write-Host "  · 然后 app\desktop\fetch-tools.ps1 就能在干净机器上补齐了"
