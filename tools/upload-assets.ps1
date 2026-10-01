# upload-assets.ps1 -- 把 资料归档\ 下的 tools.zip / jizura.zip 传成本仓库 Release 的附件
#
# 必须先做两件事（脚本会检查）：
#   1. 仓库已经有远端：git remote get-url origin 能出地址
#   2. 那个 Release 已经存在：tag 见下面的 $Tag（默认 assets-v1）
#      —— 在 GitHub 网页上 Releases → Draft a new release → 填 tag → Publish release 即可
#
# 然后准备一个 token（只需要对这一个仓库的 Contents 写权限，classic 或 fine-grained 都行）：
#   classic:      https://github.com/settings/tokens/new            勾 repo
#   fine-grained: https://github.com/settings/personal-access-tokens/new
#                 只选这一个仓库，权限选 Contents: Read and write
#
# 用法（⚠️ 别把 token 写进命令行 —— 会留在 PSReadLine 的历史文件里）：
#   $env:GITHUB_TOKEN = '粘贴在这里'
#   powershell -ExecutionPolicy Bypass -File tools\upload-assets.ps1
#   Remove-Item Env:\GITHUB_TOKEN          # 传完就清掉
#
# 参数：
#   -Tag assets-v1     附件所在的 Release tag
#   -Dir 资料归档      存档所在目录（默认 <root>\资料归档）
#   -Name tools.zip,jizura.zip
#   -Force             同名附件已存在时先删掉再传（默认直接跳过）
#   -TimeoutSec 1800   单个附件的上传超时

param(
    [string]$Tag,
    [string]$Dir,
    [string[]]$Name,
    [switch]$Force,
    [int]$TimeoutSec = 1800
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if (-not $Tag) { $Tag = 'assets-v1' }
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)   # tools\ → 根
if (-not $Dir) { $Dir = Join-Path $root '资料归档' }
if (-not $Name -or $Name.Count -eq 0) { $Name = @('tools.zip', 'jizura.zip') }

$token = $env:GITHUB_TOKEN
if (-not $token) { throw '没有 GITHUB_TOKEN。先跑：$env:GITHUB_TOKEN = ''<你的 token>''' }
$headers = @{
    Authorization          = "Bearer $token"
    Accept                 = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
    'User-Agent'           = 'v-synth-studio-upload-assets'
}

# ── 1. 仓库地址 ───────────────────────────────────────────────────────────────
# ⚠️ 走 `cmd /c … 2>nul` 而不是 `git … 2>$null`：PowerShell 5.1 里对原生命令的
# `2>$null` 不生效，git 的 "fatal: not a git repository" 会变成终止错误。
$url = (cmd /c "git -C `"$root`" remote get-url origin 2>nul" | Select-Object -First 1)
if (-not $url) { throw "仓库还没有远端。先 git remote add origin <地址> 再 push（当前：$root）" }
$url = $url.Trim()
if ($url -match '^[A-Za-z]:' -or $url.StartsWith('\\') -or $url.StartsWith('file:')) {
    throw "远端指向本地目录（$url），推不出 GitHub 地址。先把 origin 改成 GitHub 上的仓库。"
}
$url = $url -replace '^git\+', '' -replace '^https?://', '' -replace '^ssh://', '' -replace '^git@', ''
$url = $url -replace '^[^/]+[:@]', '' -replace '\.git$', '' -replace '/+$', ''
$parts = @($url -split '/' | Where-Object { $_ })
if ($parts.Count -lt 2) { throw "认不出 owner/repo：$url" }
$repo = ($parts[-2..-1] -join '/')
Write-Host "仓库：$repo"

# ── 2. Release ────────────────────────────────────────────────────────────────
$rel = $null
try {
    $rel = Invoke-WebRequest -Uri "https://api.github.com/repos/$repo/releases/tags/$Tag" -Headers $headers -UseBasicParsing -TimeoutSec 60
} catch {
    $code = $null
    if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
    if ($code -eq 404) {
        throw "仓库 $repo 里没有 tag 为 $Tag 的 Release。先在网页上建一个（Releases → Draft a new release → tag 填 $Tag → Publish release）。"
    }
    throw "查 Release 失败（HTTP $code）：$($_.Exception.Message)"
}
$release = $rel.Content | ConvertFrom-Json
Write-Host "Release：#$($release.id)  $Tag  （已有附件 $(@($release.assets).Count) 个）"

# ── 3. 逐个上传 ───────────────────────────────────────────────────────────────
Add-Type -AssemblyName System.Net.Http
$had = @{}
foreach ($a in @($release.assets)) { $had[$a.name] = $a.id }

$bad = 0
foreach ($n in $Name) {
    $file = Join-Path $Dir $n
    if (-not (Test-Path $file -PathType Leaf)) { Write-Host "[跳过] $n 不存在（$file）"; $bad++; continue }
    $len = (Get-Item $file).Length
    $mb = $len / 1MB
    if ($mb -lt 20) { Write-Host "[跳过] $n 只有 $([math]::Round($mb,1)) MB —— 存档不可能这么小，别把一个半截文件传上去"; $bad++; continue }

    if ($had.ContainsKey($n)) {
        if (-not $Force) { Write-Host "[跳过] $n 已经在 Release 里了（$([math]::Round($mb,1)) MB）—— 要重传加 -Force"; continue }
        Write-Host "[删除] 旧附件 $n"
        Invoke-WebRequest -Uri "https://api.github.com/repos/$repo/releases/assets/$($had[$n])" -Method Delete -Headers $headers -UseBasicParsing -TimeoutSec 60 | Out-Null
    }

    Write-Host ("[上传] {0}  {1:N1} MB ..." -f $n, $mb)
    $client = New-Object System.Net.Http.HttpClient
    $client.Timeout = [TimeSpan]::FromSeconds($TimeoutSec)
    foreach ($k in $headers.Keys) { [void]$client.DefaultRequestHeaders.TryAddWithoutValidation($k, $headers[$k]) }
    # 流式上传，不把 129 MB 整个读进内存（PS 5.1 的 Invoke-WebRequest -InFile 会破坏二进制，别用）
    $fs = [System.IO.File]::OpenRead($file)
    $content = New-Object System.Net.Http.StreamContent($fs)
    $content.Headers.ContentType = [System.Net.Http.Headers.MediaTypeHeaderValue]::Parse('application/zip')
    $uri = "https://uploads.github.com/repos/$repo/releases/$($release.id)/assets?name=$n"
    try {
        $resp = $client.PostAsync($uri, $content).GetAwaiter().GetResult()
        $body = $resp.Content.ReadAsStringAsync().GetAwaiter().GetResult()
        if (-not $resp.IsSuccessStatusCode) {
            Write-Host ("[失败] {0}  HTTP {1}  {2}" -f $n, [int]$resp.StatusCode, $body)
            $bad++
        } else {
            $j = $body | ConvertFrom-Json
            Write-Host ("[完成] {0}  {1:N1} MB  下载地址：{2}" -f $n, ($j.size / 1MB), $j.browser_download_url)
        }
    } catch {
        Write-Host "[失败] $n  $($_.Exception.Message)"
        $bad++
    } finally {
        $content.Dispose()
        $fs.Dispose()
        $client.Dispose()
    }
}

Write-Host ''
if ($bad -gt 0) {
    Write-Host "有 $bad 项没传成 —— 修好后重跑本脚本（已传好的会跳过）。"
    exit 1
}
Write-Host '两个附件都传好了。'
Write-Host "  验证：https://github.com/$repo/releases/tag/$Tag"
Write-Host '  下一步：打 tag 出包 —— git tag v1.2.0 && git push origin v1.2.0'
