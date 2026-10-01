# 把「不属于源码、但必须随程序打包」的两大块东西补齐 —— 干净机器 / CI 上跑的第一件事
#
#   powershell -ExecutionPolicy Bypass -File app\desktop\fetch-tools.ps1
#   powershell -ExecutionPolicy Bypass -File app\desktop\fetch-tools.ps1 -Only tools
#   powershell -ExecutionPolicy Bypass -File app\desktop\fetch-tools.ps1 -Only jizura
#   powershell -ExecutionPolicy Bypass -File app\desktop\fetch-tools.ps1 -Force
#   powershell -ExecutionPolicy Bypass -File app\desktop\fetch-tools.ps1 -Local 'D:\我的归档'
#
# ── 为什么有这个东西 ─────────────────────────────────────────────────────────
#
# 这个仓库**只放源码**。下面两样是二进制大件，不入库，但程序要能离线用，所以编译前必须补齐：
#
#   ① tools\        ffmpeg（201MB）+ yt-dlp（17MB）+ LibreSVIP CLI（70MB）≈ 288MB
#                   由 tauri.conf.json 的 bundle.resources 打进安装包，
#                   代码里的查找位置：ffmpeg → tools\ffmpeg\bin\（audio.rs）、
#                   yt-dlp → tools\yt-dlp.exe（tools.rs）、
#                   LibreSVIP → tools\libresvip\libresvip-cli\libresvip-cli.exe（libresvip.rs）
#
#   ② app\web\vendor\jizura\
#                   JIZURA 文字 PV（上游 MIT 构建产物 index.html）+ 2335 个 woff2 字体 ≈ 54MB
#                   PV 页的 iframe 指向 /vendor/jizura/index.html，**离线可用**靠的就是它
#
# 两者都从**存档**解出来，存档放哪由下面的 $UrlTools / $UrlJizura 决定；
# 本机已经有这两块时（开发机常态）本脚本什么都不做。
#
# ⚠️ 三个坑写在前面：
#   ① 本文件必须 **UTF-8 带 BOM**。PowerShell 5.1 读无 BOM 的 .ps1 按 ANSI（GBK）解码，
#      中文注释变乱码、乱码里的引号会吞换行 → 语法错。改完跑：
#          node tests\manual\fix-ps1-bom.mjs --write
#   ② 下载用 curl.exe（Windows 10 1803+ 自带），**别改用 Invoke-WebRequest** ——
#      实测它读不完 GitHub release 的大文件（"Received an unexpected EOF or 0 bytes"）。
#      重试逻辑写在脚本里，不用 curl 的 --retry-*（自带的旧 curl 不认那些选项，实测报 unknown）。
#   ③ 判断「齐不齐」要在**解压之后**核对具体文件，不能只看目录在不在 ——
#      半途失败的解压会留下一个看似完整的空壳，而那要到用户点「工程转换」才现形。

param(
    [ValidateSet('all', 'tools', 'jizura')]
    [string]$Only = 'all',
    [switch]$Force,                 # 已存在也重新解压覆盖
    [string]$Local,                 # 本机存着两个 zip 的目录（留空则用 -Zip，都不给就下载）
    [string]$Zip                    # 下载/查找 zip 的落脚目录，默认 <程序根目录>\data\.cache
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'      # 进度条会拖慢 Expand-Archive

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent (Split-Path -Parent $here)     # app\desktop → app → 程序根目录
if (-not $Zip) { $Zip = Join-Path $root 'data\.cache' }

# ── 两个存档的位置 ────────────────────────────────────────────────────────────
#
# 默认指向本仓库 Release 上的两个附件（tag `assets-v1`）。**换成别的静态托管只改这两行。**
# 想一次性覆盖（比如临时挂到国内镜像）不必改文件，设环境变量即可：
#     $env:VSYNTH_TOOLS_URL  /  $env:VSYNTH_JIZURA_URL
#
# ⚠️ 这两个附件必须由你自己传一次（本机跑一遍 tools\zip-assets.ps1 就有现成的 zip 了）：
#     https://github.com/<你>/<仓库>/releases/tag/assets-v1
# 现在仓库还没有远端，所以这一步还没做 —— 没做之前，本脚本在**干净机器**上会失败，
# 在开发机上则因为文件已存在而直接跳过（所以本机不受影响）。
$repo = 'QingMu39/V-Synth-Studio'          # ← 建完仓库后改成实际地址
$UrlTools  = if ($env:VSYNTH_TOOLS_URL)  { $env:VSYNTH_TOOLS_URL }  else { "https://github.com/$repo/releases/download/assets-v1/tools.zip" }
$UrlJizura = if ($env:VSYNTH_JIZURA_URL) { $env:VSYNTH_JIZURA_URL } else { "https://github.com/$repo/releases/download/assets-v1/jizura.zip" }

# ── 上游兜底（只在存档拿不到时用；慢，但至少不用人去别处找）──────────────────
$upstream = @{
    ffmpeg    = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip'
    ytdlp     = 'https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe'
    libresvip = 'https://github.com/SoulMelody/LibreSVIP/releases/download/v2.9.0/LibreSVIP-CLI-2.9.0.win-amd64.zip'
    # JIZURA 没有可用的上游打包地址（上游是源码仓库，字体是 Google Fonts 逐家族抓的），
    # 所以 jizura.zip 必须由本仓库自己提供，没有兜底。
}

$curl = Join-Path $env:SystemRoot 'System32\curl.exe'
if (-not (Test-Path $curl)) { throw "找不到 curl.exe：$curl（Windows 10 1803+ 自带）" }

New-Item -ItemType Directory -Path $Zip -Force | Out-Null
$tmp = Join-Path $Zip 'tmp'
New-Item -ItemType Directory -Path $tmp -Force | Out-Null

# ⚠️ 必须写**信息流**（Write-Host），不能写输出流（Write-Output）。
# Get-Archive 会在同一次调用里既说一句「用本机存档 …」又 `return $cached`；
# 用 Write-Output 的话那句提示会一起被捕获，调用方拿到的就是
# 「提示 + 路径」两行拼起来的垃圾字符串，Expand-Archive 报「路径不存在」。
# 实测踩过：`路径"  用本机存档 资料归档\jizura.zip 资料归档\jizura.zip"不存在`。
function Say([string]$Msg) { Write-Host $Msg }

function Invoke-Download([string]$Url, [string]$Out) {
    Say "  下载 $Url"
    # 重试自己写循环，不用 curl 的 --retry-*（Windows 自带旧 curl 报 unknown option，实测踩过）
    for ($i = 1; $i -le 3; $i++) {
        # --speed-limit/--speed-time：真的卡死（<2KB/s 持续 30 秒）才断开重来。
        # 别把限速调高：这台机器上 gyan.dev 实测只有 ~12KB/s，高限速会误杀慢速但有效的下载。
        & $curl -L --fail --connect-timeout 20 --speed-limit 2048 --speed-time 30 -o $Out $Url 2>&1 | Out-Null
        if ($LASTEXITCODE -eq 0 -and (Test-Path $Out) -and (Get-Item $Out).Length -gt 0) { return }
        Say "  第 $i 次失败（curl 退出码 $LASTEXITCODE），重试…"
        Start-Sleep -Seconds 3
    }
    throw "下载失败（试了 3 次）：$Url"
}

function Get-Archive([string]$Name, [string]$Url) {
    # 找现成的 zip：-Local 目录 → 缓存目录 → 下载
    if ($Local) {
        $cached = Join-Path $Local "$Name.zip"
        if (Test-Path $cached) { Say "  用本机存档 $cached"; return $cached }
        Say "  $Local 里没有 $Name.zip，改走下载"
    }
    $dest = Join-Path $Zip "$Name.zip"
    if ((Test-Path $dest) -and -not $Force) {
        Say ("  用缓存 {0}（{1:N0} MB）" -f (Split-Path -Leaf $dest), ((Get-Item $dest).Length / 1MB))
        return $dest
    }
    try {
        Invoke-Download $Url $dest
        return $dest
    } catch {
        if ($Name -eq 'tools') {
            Say "  ⚠️ tools.zip 拿不到，改从三个上游分别下载（慢，但能用）"
            return $null
        }
        throw
    }
}

function Expand-Archive-Clean([string]$Archive, [string]$Into) {
    if (Test-Path $Into) { Remove-Item $Into -Recurse -Force }
    New-Item -ItemType Directory -Path $Into -Force | Out-Null
    Expand-Archive -Path $Archive -DestinationPath $Into -Force
}

# ⚠️ Move-Item **不会**替你建中间目录：往 `app\web\vendor\jizura` 搬、而 `vendor\` 不存在时，
# 它报的是 `Could not find a part of the path.`，但**已经把源删掉了**（源没了、目标没到位）。
# 实测踩过：jizura 搬完变成了「哪都没有」。所以搬之前先把父目录建出来。
function Move-Into([string]$From, [string]$To) {
    $parent = Split-Path -Parent $To
    if ($parent -and -not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    if (Test-Path $To) { Remove-Item $To -Recurse -Force }
    Move-Item $From $To
}

# ── ① tools\ ─────────────────────────────────────────────────────────────────
if ($Only -in 'all', 'tools') {
    $fFfmpeg = Join-Path $root 'tools\ffmpeg\bin\ffmpeg.exe'
    $fProbe  = Join-Path $root 'tools\ffmpeg\bin\ffprobe.exe'
    $fYtdlp  = Join-Path $root 'tools\yt-dlp.exe'
    $fLrExe  = Join-Path $root 'tools\libresvip\libresvip-cli\libresvip-cli.exe'
    $fLrPlug = Join-Path $root 'tools\libresvip\libresvip-cli\_internal\libresvip\plugins'

    $need = $Force -or -not ((Test-Path $fFfmpeg) -and (Test-Path $fProbe) -and
                             (Test-Path $fYtdlp) -and (Test-Path $fLrExe) -and (Test-Path $fLrPlug))
    if (-not $need) {
        Say "tools\     已齐，跳过"
    } else {
        Say "tools\     补齐中"
        $arch = Get-Archive 'tools' $UrlTools
        if ($arch) {
            $ex = Join-Path $tmp 'tools'
            Expand-Archive-Clean $arch $ex
            # 这一层要**合并**进 tools\，不能整目录替换。
            #
            # ⚠️ 为什么不能直接 Move-Into：它先 Remove-Item 目标再搬。tools\ 里同时
            #    住着入库的源脚本（zip-assets.ps1 / fetch-jizura-fonts.ps1），而
            #    zip-assets.ps1 **不在存档里**（它就是打存档的那个）—— 整目录替换会
            #    把它删掉。实测踩过：跑完干净房间验证，git status 多一条
            #    ` D tools/zip-assets.ps1`。
            #    也不能只靠 Move-Item -Force 硬搬：目标若是**目录**它会把源目录塞进去，
            #    变成 tools\ffmpeg\ffmpeg\。所以规则是：
            #      · 目标是要被换成目录的**文件** → Move-Item -Force（原地覆盖，安全）
            #      · 目标是要被换成文件/目录的**目录** → 先删掉再搬（目录不能原地覆盖）
            #      · 目标不存在 → 直接搬
            #    存档里没有的项（zip-assets.ps1）从头到尾没人碰它。
            foreach ($item in Get-ChildItem $ex) {
                $dst = Join-Path $root "tools\$($item.Name)"
                if ((Test-Path $dst -PathType Container) -and $item.PSIsContainer) {
                    Remove-Item $dst -Recurse -Force
                } elseif ((Test-Path $dst) -and -not $item.PSIsContainer) {
                    Remove-Item $dst -Recurse -Force      # 目标是目录、来的是文件
                }
                $parent = Split-Path -Parent $dst
                if (-not (Test-Path $parent)) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
                Move-Item $item.FullName $dst -Force
            }
            Remove-Item $ex -Recurse -Force -ErrorAction SilentlyContinue
        } else {
            # 兜底：三个上游各下一份，自己拼出同样的目录结构
            $want = Join-Path $root 'tools\ffmpeg\bin'
            New-Item -ItemType Directory -Path $want -Force | Out-Null
            if (-not (Test-Path $fFfmpeg) -or $Force) {
                $z = Join-Path $tmp 'ffmpeg.zip'; Invoke-Download $upstream.ffmpeg $z
                $ex = Join-Path $tmp 'ffmpeg'; Expand-Archive-Clean $z $ex
                # ⚠️ 只要 ffmpeg.exe 与 ffprobe.exe：ffplay.exe 全仓零引用（git grep ffplay 无命中），
                #    白白多 102MB —— 它正是这个 zip 比别人大的原因。
                foreach ($n in 'ffmpeg.exe', 'ffprobe.exe') {
                    $src = Get-ChildItem $ex -Recurse -File -Filter $n | Select-Object -First 1
                    if (-not $src) { throw "上游 ffmpeg 包里找不到 $n（布局变了？看 $ex）" }
                    Copy-Item $src.FullName (Join-Path $want $n) -Force
                }
                Remove-Item $z, $ex -Recurse -Force -ErrorAction SilentlyContinue
            }
            if (-not (Test-Path $fYtdlp) -or $Force) { Invoke-Download $upstream.ytdlp $fYtdlp }
            if (-not (Test-Path $fLrExe) -or $Force) {
                $z = Join-Path $tmp 'libresvip.zip'; Invoke-Download $upstream.libresvip $z
                $ex = Join-Path $tmp 'libresvip'; Expand-Archive-Clean $z $ex
                $inner = Join-Path $ex 'libresvip-cli'
                if (-not (Test-Path (Join-Path $inner 'libresvip-cli.exe'))) {
                    $inner = Get-ChildItem $ex -Recurse -File -Filter 'libresvip-cli.exe' |
                             Select-Object -First 1 | ForEach-Object { $_.Directory.FullName }
                }
                if (-not $inner) { throw "上游 LibreSVIP 包里找不到 libresvip-cli.exe（布局变了？看 $ex）" }
                $dst = Join-Path $root 'tools\libresvip\libresvip-cli'
                if (Test-Path $dst) { Remove-Item $dst -Recurse -Force }
                Move-Into $inner $dst
                Remove-Item $z, $ex -Recurse -Force -ErrorAction SilentlyContinue
            }
        }
    }
}

# ── ② app\web\vendor\jizura\ ─────────────────────────────────────────────────
if ($Only -in 'all', 'jizura') {
    $vDir   = Join-Path $root 'app\web\vendor\jizura'
    $vIndex = Join-Path $vDir 'index.html'
    $vFonts = Join-Path $vDir 'fonts'
    $nHave  = if (Test-Path $vFonts) { (Get-ChildItem $vFonts -File -Filter '*.woff2' -EA SilentlyContinue | Measure-Object).Count } else { 0 }
    $need = $Force -or -not ((Test-Path $vIndex) -and ($nHave -gt 100))
    if (-not $need) {
        Say "jizura\    已齐，跳过"
    } else {
        Say "jizura\    补齐中"
        $arch = Get-Archive 'jizura' $UrlJizura
        $ex = Join-Path $tmp 'jizura'
        Expand-Archive-Clean $arch $ex
        # zip 里可能是 vendor\jizura\ 套一层，也可能直接就是 jizura\，两种都认
        $src = Join-Path $ex 'jizura'
        if (-not (Test-Path (Join-Path $src 'index.html'))) {
            $src = Get-ChildItem $ex -Recurse -Directory -Filter 'jizura' |
                   Select-Object -First 1 | ForEach-Object { $_.FullName }
        }
        if (-not $src -or -not (Test-Path (Join-Path $src 'index.html'))) {
            throw "jizura.zip 里找不到 jizura\index.html（布局变了？看 $ex）"
        }
        Move-Into $src $vDir
        Remove-Item $ex -Recurse -Force -ErrorAction SilentlyContinue
    }
}

# ── 校验：**这才是本脚本的重点** ──────────────────────────────────────────────
#
# 后端对工具的「在不在」有自己的判断（tools.rs::detect_tools / libresvip.rs::cli_path），
# 但它们分散在三个模块里、而且只在用户点按钮时才走到。这里一次性替它们核一遍，
# 缺什么现在就说，别等打出来的安装包在用户机器上缺文件。
Say ""
Say "校验"
$bad = @()
$fFfmpeg = Join-Path $root 'tools\ffmpeg\bin\ffmpeg.exe'
if (Test-Path $fFfmpeg) {
    Say "  ffmpeg    : $((& $fFfmpeg -version 2>&1 | Select-Object -First 1))"
} else { $bad += 'tools\ffmpeg\bin\ffmpeg.exe' }
if (Test-Path (Join-Path $root 'tools\ffmpeg\bin\ffprobe.exe')) { Say "  ffprobe   : 在" } else { $bad += 'tools\ffmpeg\bin\ffprobe.exe' }
$fYtdlp = Join-Path $root 'tools\yt-dlp.exe'
if (Test-Path $fYtdlp) {
    Say "  yt-dlp    : $((& $fYtdlp --version 2>&1 | Select-Object -First 1))"
} else { $bad += 'tools\yt-dlp.exe' }
$plug = Join-Path $root 'tools\libresvip\libresvip-cli\_internal\libresvip\plugins'
if ((Test-Path $plug) -and (Get-ChildItem $plug -Directory).Count -gt 0) {
    Say "  LibreSVIP : 在（$((Get-ChildItem $plug -Directory).Count) 个插件）"
} else { $bad += 'tools\libresvip\libresvip-cli\（或它的插件目录是空的）' }
$vFonts = Join-Path $root 'app\web\vendor\jizura\fonts'
$nFont = if (Test-Path $vFonts) { (Get-ChildItem $vFonts -File -Filter '*.woff2' | Measure-Object).Count } else { 0 }
if ($nFont -gt 100) {
    Say "  JIZURA    : 在（$nFont 个 woff2 字体）"
} else { $bad += "app\web\vendor\jizura\fonts\（只有 $nFont 个 woff2，PV 页会缺字）" }

Say ""
if ($bad.Count) {
    Say "不齐："
    $bad | ForEach-Object { Say "  - $_" }
    exit 1
}
Say "全部齐了"
exit 0
