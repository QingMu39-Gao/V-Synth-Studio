# 验证 app\desktop\fetch-tools.ps1 —— 「干净机器上把两大块大件补齐」这条路真的走得通吗
#
#   powershell -ExecutionPolicy Bypass -File tests\manual\fetch-tools-verify.ps1
#   powershell -ExecutionPolicy Bypass -File tests\manual\fetch-tools-verify.ps1 -ArchiveDir 'D:\资料归档'
#
# ── 为什么需要它 ─────────────────────────────────────────────────────────────
#
# fetch-tools.ps1 是本仓库**唯一**「源码之外的东西怎么到位」的机制，而它平时在开发机上是
# **空转**的（文件都在 → 直接跳过），所以它的解压/落位/校验那半段永远没被执行过。
# 2026-10-05 第一次真跑就抓出两个必然踩中的 bug：
#
#   ① Get-Archive 里 `Say "  用本机存档 …"` 用的是 Write-Output，那句提示混进了返回值，
#      $arch 变成「提示 + 路径」两行拼起来的垃圾 → Expand-Archive 报「路径不存在」。
#   ② Move-Item 不建中间目录：往 app\web\vendor\jizura 搬而 vendor\ 不存在时报
#      `Could not find a part of the path.`，而且**目标没到位**。
#
# 两个都是「肉眼审脚本看不出来、一跑就炸」的类型。这个脚本就是那个「一跑」：
# 把两块大件**挪到一边**，从不联网的本地存档重新解一遍，再逐文件比对。
#
# ⚠️ 它会真的移动/删除/重建 `tools\` 与 `app\web\vendor\jizura\`。
#    中途失败时会把东西还原（原目录先改名成 .verify-hold-*，成功后才删）。
#    仍然建议在**已经提交过、且有备份**的工作区上跑（H:\工作站-backup-* 就是为此存在的）。

param(
    [string]$ArchiveDir,                       # 存着 tools.zip / jizura.zip 的目录，默认 <根>\资料归档
    [string]$Exe,                              # 被测 exe，默认根目录的 v-synth-studio.exe（冒烟用）
    [switch]$SkipSmoke                         # 跳过「补齐后编出来的程序还能跑」（省一次启动）
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent (Split-Path -Parent $here)          # tests\manual → tests → 根
if (-not $ArchiveDir) { $ArchiveDir = Join-Path $root '资料归档' }
if (-not $Exe) { $Exe = Join-Path $root 'v-synth-studio.exe' }

$fetch  = Join-Path $root 'app\desktop\fetch-tools.ps1'
$tools  = Join-Path $root 'tools'
$jizura = Join-Path $root 'app\web\vendor\jizura'
$stamp  = Get-Date -Format 'yyyyMMdd-HHmmss'
$hold   = Join-Path $root "_verify-hold-$stamp"

$script:fail = 0
function Ok([string]$m)   { Write-Host "  [ok]   $m" -ForegroundColor Green }
function Bad([string]$m)  { Write-Host "  [FAIL] $m" -ForegroundColor Red; $script:fail++ }
function Info([string]$m) { Write-Host "  $m" -ForegroundColor DarkGray }

function Count-Woff2([string]$dir) {
    if (-not (Test-Path $dir)) { return 0 }
    (Get-ChildItem $dir -File -Filter '*.woff2' -ErrorAction SilentlyContinue | Measure-Object).Count
}

# 存档里的每个文件都要在磁盘上找到同名同大小的 —— 这是「补齐」是否真的补齐的判据。
function Compare-Archive([string]$zipPath, [string]$destDir, [string]$innerPrefix) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem -ErrorAction SilentlyContinue
    $z = [IO.Compression.ZipFile]::OpenRead($zipPath)
    $miss = 0; $diff = 0; $n = 0
    $firstBad = @()
    try {
        foreach ($e in $z.Entries) {
            if ($e.Length -eq 0) { continue }
            $rel = $e.FullName -replace '/', '\'
            if ($innerPrefix -and $rel.StartsWith($innerPrefix)) { $rel = $rel.Substring($innerPrefix.Length) }
            $n++
            $full = Join-Path $destDir $rel
            if (-not (Test-Path $full)) {
                $miss++; if ($firstBad.Count -lt 3) { $firstBad += "缺 $rel" }
            } elseif ((Get-Item $full).Length -ne $e.Length) {
                $diff++; if ($firstBad.Count -lt 3) { $firstBad += "大小不符 $rel" }
            }
        }
    } finally { $z.Dispose() }
    return [pscustomobject]@{ Total = $n; Missing = $miss; SizeDiff = $diff; Sample = $firstBad }
}

Write-Host ""
Write-Host "== fetch-tools.ps1 干净房间验证 ==" -ForegroundColor Cyan
Info "脚本   : $fetch"
Info "存档   : $ArchiveDir"
Info "临时区 : $hold"

foreach ($f in @($fetch, (Join-Path $ArchiveDir 'tools.zip'), (Join-Path $ArchiveDir 'jizura.zip'))) {
    if (-not (Test-Path $f)) { throw "找不到 $f（先用 tools\zip-assets.ps1 打出存档）" }
}

# ── 0. 前置：存档本身完整（不然测的是存档，不是脚本）────────────────────────
Write-Host ""
Write-Host "[0/5] 存档自检"
$t = Compare-Archive (Join-Path $ArchiveDir 'tools.zip') $tools ''
if ($t.Missing -or $t.SizeDiff) { Ok "tools.zip 与当前 tools\ 不符（缺 $($t.Missing) / 差 $($t.SizeDiff)），本次会以存档为准重建" }
else { Ok "tools.zip 对得上当前 tools\（$($t.Total) 个文件）" }

# ── 1. 挪走两大块（模拟「刚 clone 下来」）───────────────────────────────────
Write-Host ""
Write-Host "[1/5] 把 tools\ 与 jizura\ 挪到临时区（模拟干净 clone）"
New-Item -ItemType Directory -Path $hold -Force | Out-Null
if (Test-Path $tools)  { Move-Item $tools  (Join-Path $hold 'tools') -Force }
if (Test-Path $jizura) {
    New-Item -ItemType Directory -Path (Join-Path $hold 'vendor') -Force | Out-Null
    Move-Item $jizura (Join-Path $hold 'vendor\jizura') -Force
}
if (Test-Path $tools)  { Bad "tools\ 没能挪走（下一步会变成覆盖而不是重建）" }  else { Ok "tools\ 已挪走" }
if (Test-Path $jizura) { Bad "jizura\ 没能挪走" } else { Ok "jizura\ 已挪走（app\web\vendor\ 现在是空的）" }

try {
    # ── 2. 跑补齐（-Local：只用本地存档，不联网，CI 与本机都能跑）──────────
    Write-Host ""
    Write-Host "[2/5] 跑 fetch-tools.ps1 -Local（这一步是真正的被测对象）"
    $out = & powershell -ExecutionPolicy Bypass -File $fetch -Local $ArchiveDir 2>&1
    $code = $LASTEXITCODE
    $out | ForEach-Object { Info "$_" }
    if ($code -eq 0) { Ok "退出码 0" } else { Bad "退出码 $code（应 0）" }

    # ── 3. 逐文件比对（不是「目录在不在」，是「每个文件都在且一样大」）──────
    Write-Host ""
    Write-Host "[3/5] 解出来的东西与存档逐文件比对"
    $r = Compare-Archive (Join-Path $ArchiveDir 'tools.zip') $tools ''
    if ($r.Missing -eq 0 -and $r.SizeDiff -eq 0) { Ok "tools\      $($r.Total) 个文件，缺失 0 / 大小不符 0" }
    else { Bad "tools\      缺失 $($r.Missing) / 大小不符 $($r.SizeDiff) → $($r.Sample -join '; ')" }

    $r = Compare-Archive (Join-Path $ArchiveDir 'jizura.zip') $jizura 'jizura\'
    if ($r.Missing -eq 0 -and $r.SizeDiff -eq 0) { Ok "jizura\     $($r.Total) 个文件，缺失 0 / 大小不符 0" }
    else { Bad "jizura\     缺失 $($r.Missing) / 大小不符 $($r.SizeDiff) → $($r.Sample -join '; ')" }

    # 后端代码里写死的查找路径（tools.rs / audio.rs / libresvip.rs）+ 前端 iframe 指向的入口
    $must = @(
        'tools\ffmpeg\bin\ffmpeg.exe',
        'tools\ffmpeg\bin\ffprobe.exe',
        'tools\yt-dlp.exe',
        'tools\libresvip\libresvip-cli\libresvip-cli.exe',
        'tools\libresvip\libresvip-cli\_internal\libresvip\plugins',
        'app\web\vendor\jizura\index.html',
        'app\web\vendor\jizura\fonts.css'
    )
    $gone = $must | Where-Object { -not (Test-Path (Join-Path $root $_)) }
    if ($gone) { Bad "后端/前端会去找的路径不存在：$($gone -join ', ')" } else { Ok "七处关键路径都在（ffmpeg / ffprobe / yt-dlp / LibreSVIP / 插件目录 / jizura 入口 / fonts.css）" }

    $n = Count-Woff2 (Join-Path $jizura 'fonts')
    if ($n -ge 2300) { Ok "jizura 字体 $n 个 woff2" } else { Bad "jizura 字体只有 $n 个（<2300，PV 页会缺字）" }

    # ── 4. 幂等：再跑一次应该什么都不做 ────────────────────────────────────
    Write-Host ""
    Write-Host "[4/5] 幂等性（再跑一次应跳过、退出码 0）"
    $out2 = & powershell -ExecutionPolicy Bypass -File $fetch -Local $ArchiveDir 2>&1
    $code2 = $LASTEXITCODE
    $out2 | ForEach-Object { Info "$_" }
    if ($code2 -eq 0) { Ok "退出码 0" } else { Bad "退出码 $code2（应 0）" }
    if (($out2 -join "`n") -match '已齐，跳过') { Ok "识别出「已齐」并跳过" } else { Bad "没走「已齐，跳过」分支（幂等性可疑）" }

    # ── 5. 合并冒烟：补齐后的程序还能起来、契约还对 ────────────────────────
    if ($SkipSmoke) {
        Write-Host ""
        Write-Host "[5/5] 跳过冒烟（-SkipSmoke）"
    } elseif (-not (Test-Path $Exe)) {
        Write-Host ""
        Write-Host "[5/5] 跳过冒烟：找不到 $Exe（先跑 app\desktop\build.ps1）"
    } else {
        Write-Host ""
        Write-Host "[5/5] 冒烟：起一个测试实例，跑契约用例"
        $p = Start-Process -FilePath $Exe -ArgumentList '--serve', '--port=8891' -PassThru -WindowStyle Hidden
        try {
            $up = $false
            foreach ($i in 1..30) {
                Start-Sleep -Seconds 1
                try { Invoke-WebRequest 'http://127.0.0.1:8891/api/health' -UseBasicParsing -TimeoutSec 3 | Out-Null; $up = $true; break } catch { }
            }
            if ($up) { Ok "服务起来了（8891 有应答）" } else { Bad "服务没起来（8891 无应答）" }
            if ($up) {
                & node (Join-Path $root 'tests\contract\verify.mjs') 8891 | ForEach-Object { Info "$_" }
                if ($LASTEXITCODE -eq 0) { Ok "契约用例一致" } else { Bad "契约用例不一致（退出码 $LASTEXITCODE）" }
            }
        } finally {
            # ⚠️ 按精确 PID 停，别按进程名/命令行子串杀
            Stop-Process -Id $p.Id -Force -ErrorAction SilentlyContinue
        }
    }
} finally {
    # 成功就删临时区；失败时**留着**，那是唯一还能把东西还原回去的副本
    Write-Host ""
    if ($script:fail -eq 0) {
        Remove-Item $hold -Recurse -Force -ErrorAction SilentlyContinue
        Info "临时区已清理"
    } else {
        Write-Host "  ⚠️ 有失败项，临时区保留着（还原办法：把里面的 tools 与 vendor\jizura 移回原位）：$hold" -ForegroundColor Yellow
    }
}

Write-Host ""
if ($script:fail -eq 0) { Write-Host "全部通过" -ForegroundColor Green; exit 0 }
Write-Host "$($script:fail) 项失败" -ForegroundColor Red
exit 1
