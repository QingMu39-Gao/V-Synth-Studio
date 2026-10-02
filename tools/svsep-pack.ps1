# Pack the embedded offline separation engine into two downloadable zips.
#
#   app\data\svsep\models                  -> svsep-models.zip    (~690 MB)  用户按需下载
#   app\data\svsep\{runtime,backend,bin}   -> svsep-runtime.zip   (~4.7 GB)  一次性下载

# ⚠️ runtime 那一包里**必须**同时有 backend\ 与 bin\，不能只装 runtime\：
#    宿主判断「运行时装好了没」看的是两个文件 —— runtime\python.exe 和
#    backend\app.py（svsep.rs::runtime_ready）。只装 runtime\ 的话，用户下完
#    4.5 GB 仍然起不来，而且界面只会说「分离引擎还没装」。
#    bin\ffmpeg.exe 是分离引擎自己要用的（backend\config.py 的
#    _ensure_ffmpeg_on_path 会把 <svsep>\bin 塞进 PATH）。实测漏过这一条。
#
# WHY these are not in the installer: runtime + models are 8.2 GB, an MSI
# that big is useless to hand out. app\data\svsep\ is git-ignored too, so
# nothing of it is in the repo. The program serves both from its download
# URL once you upload the zips (see app\desktop\src\svsep.rs MODEL_URL /
# RUNTIME_URL -- both are empty until you fill them in).
#
# NOTE: this script ONLY packs. Uploading is yours to do.
# NOTE: the zip layout is NOT free-form -- svsep.rs::extract_zip() unpacks
#       straight into <可写目录>\svsep\, so both zips must keep their top
#       folder ("models\" / "runtime\" / "backend\" / "bin\"). Packing the
#       contents flat would scatter python.exe and the .ckpt into the root
#       and nothing would find them, silently.
#
#   powershell -ExecutionPolicy Bypass -File tools\svsep-pack.ps1
#   powershell -ExecutionPolicy Bypass -File tools\svsep-pack.ps1 -Only models -Force
#   powershell -ExecutionPolicy Bypass -File tools\svsep-pack.ps1 -Bench

param(
    [string]$Out,                        # 输出目录；默认是 <程序根目录>\资料归档
    [ValidateSet('all', 'models', 'runtime')]
    [string]$Only = 'all',
    [switch]$Force,                      # 覆盖已存在的 zip
    [ValidateSet('Fastest', 'Optimal', 'NoCompression')]
    [string]$Runtime = 'Optimal',        # runtime 的压缩档位，见下面 ⚠️
    [switch]$Bench,                      # 只测速：各档位跑同一批文件，比较吞吐
    [string]$Root                        # 程序根目录；默认从脚本位置（tools\）上溯一级
)

$ErrorActionPreference = 'Stop'
# ⚠️ 两个都要加载：ZipFile / ZipFileExtensions 在 .FileSystem 里，而
#    ZipArchiveMode / ZipArchive 在 System.IO.Compression 里。只加载前者的话
#    `[IO.Compression.ZipArchiveMode]::Create` 直接报「Unable to find type」
#    （实测踩过：原来那版用 CreateFromDirectory，不需要这两个类型，
#     改成手工加条目之后就暴露了）。
Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

if (-not $Root) { $Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path) }
if (-not (Test-Path (Join-Path $Root 'app\desktop'))) {
    throw "看着不像程序根目录：$Root（下面应该有 app\desktop\）"
}
if (-not $Out) { $Out = Join-Path $Root '资料归档' }
$Out = [IO.Path]::GetFullPath($Out)
New-Item -ItemType Directory -Path $Out -Force | Out-Null

$srcRoot = Join-Path $Root 'app\data\svsep'

# ⚠️ 压缩档位不是随便挑的 —— 实测（2026-10-02，本机）：
#   | 样本                       | Fastest        | Optimal        | NoCompression |
#   | BS-Roformer-SW.ckpt 667 MB |  56s → 420.7MB | 337s → 403.3MB | 10s → 667.1MB |
#   | torch_cuda.dll 774 MB      |  25s → 606.9MB |  61s → 498.7MB |               |
#   模型那行：ckpt 是张量浮点，压不动（Optimal 多花 280 秒只省 17 MB）——
#   但它是用户**每次装机都要下**的 730 MB，省 6% 就是 44 MB，且总共才 730 MB，
#   几分钟换得来，所以仍然用 Optimal。
#   runtime 那行更值：CUDA 的 .dll 里塞满零填充与重复符号，Optimal 砍掉 35%
#   （7.5 GB → 4.9 GB 量级），多花的时间在这个体量上完全划算。
#   真要图快可以 -Runtime Fastest；NoCompression 也能用（extract_zip 两条路
#   都支持），只是白白多传几 GB。
$pairs = @(
    @{
        Name  = 'models'
        Dirs  = @('models')
        Desc  = '两个模型 + 三个索引 json（六轨 BS-Roformer / 二轨 UVR MDX）'
        Level = 'Optimal'
    }
    @{
        Name  = 'runtime'
        Dirs  = @('runtime', 'backend', 'bin')   # ⚠️ 三个都要，理由见文件头
        Desc  = 'Python 3.10 + torch 2.11(CUDA) + onnxruntime + audio-separator，外加 backend\ 与 bin\ffmpeg.exe'
        Level = $Runtime
    }
)

if ($Bench) {
    # 只拿 models 里最大的那个文件测，别拿 4.9 GB 试 —— 一档就是十几分钟。
    $probe = Get-ChildItem (Join-Path $srcRoot 'models') -File |
        Sort-Object Length -Descending | Select-Object -First 1
    if (-not $probe) { throw "找不到测速样本：$srcRoot\models" }
    Write-Host ("测速样本：{0}  {1:N1} MB" -f $probe.Name, ($probe.Length / 1MB))
    foreach ($lv in 'Fastest', 'Optimal', 'NoCompression') {
        $tmp = Join-Path $env:TEMP ("svsep-bench-" + $lv + ".zip")
        if (Test-Path $tmp) { Remove-Item $tmp -Force }
        $sw = [Diagnostics.Stopwatch]::StartNew()
        $zip = [IO.Compression.ZipFile]::Open($tmp, 'Create')
        try {
            [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                $zip, $probe.FullName, $probe.Name, [IO.Compression.CompressionLevel]::$lv)
        } finally { $zip.Dispose() }
        $sw.Stop()
        Write-Host ("  {0,-14} {1,7:N1}s  {2,8:N1} MB  ({3:N1} MB/s)" -f `
            $lv, $sw.Elapsed.TotalSeconds, ((Get-Item $tmp).Length / 1MB), ($probe.Length / 1MB / $sw.Elapsed.TotalSeconds))
        Remove-Item $tmp -Force
    }
    exit 0
}

$bad = 0
foreach ($item in $pairs) {
    if ($Only -ne 'all' -and $Only -ne $item.Name) { continue }

    $to = Join-Path $Out ($item.Name + '.zip')

    Write-Host ""
    Write-Host "-- $($item.Name) -> $to"
    Write-Host "   $($item.Desc)"

    # 一个包可能由多个顶层目录组成（runtime 那包就是 runtime\ + backend\ + bin\）。
    $missing = @($item.Dirs | Where-Object { -not (Test-Path (Join-Path $srcRoot $_)) })
    if ($missing.Count -gt 0) {
        Write-Host ("  [跳过] 源目录不存在：{0}" -f (($missing | ForEach-Object { Join-Path $srcRoot $_ }) -join '、'))
        Write-Host "         （先在 app\data\svsep\ 下把 runtime\ / backend\ / bin\ / models\ 放好）"
        $bad++
        continue
    }

    $files = @($item.Dirs | ForEach-Object {
        Get-ChildItem (Join-Path $srcRoot $_) -Recurse -File -Force -ErrorAction SilentlyContinue
    })
    $bytes = ($files | Measure-Object -Property Length -Sum).Sum
    Write-Host ("   源：{0} 个文件，{1:N1} MB，压缩档 {2}" -f $files.Count, ($bytes / 1MB), $item.Level)
    Write-Host ("       目录：{0}" -f ($item.Dirs -join ' + '))
    if ($files.Count -eq 0) {
        Write-Host "  [跳过] 空目录，打出来是个没用的 zip"
        $bad++
        continue
    }

    if ((Test-Path $to) -and -not $Force) {
        Write-Host ("  [跳过] 已存在 {0}（{1:N1} MB）—— 要重打加 -Force" -f (Split-Path -Leaf $to), ((Get-Item $to).Length / 1MB))
        continue
    }

    if (Test-Path $to) { Remove-Item $to -Force }

    # ⚠️ 不要用 Compress-Archive：它先在内存里建完整文件清单再压，
    #    2.4 万个文件 / 4.9 GB 会吃掉几个 GB 内存并慢到离谱（实测约 8 倍差距）。
    #    CreateFromDirectory 是流式的，但它**一个包只能有一个根目录** ——
    #    所以这里换成 ZipFile.Open + CreateEntryFromFile 手工加条目，
    #    同样是流式，还能把两个目录塞进同一个包（这正是当初只装 runtime\
    #    的原因：那一版用的就是 CreateFromDirectory）。
    #    代价是没有进度回调，所以下面只报「开始 / 结束 + 耗时」。
    Write-Host "   打包中…（这一步没有进度条，runtime 要十几分钟）"
    $sw = [Diagnostics.Stopwatch]::StartNew()
    $zip = [IO.Compression.ZipFile]::Open($to, [IO.Compression.ZipArchiveMode]::Create)
    try {
        foreach ($d in $item.Dirs) {
            $base = Join-Path $srcRoot $d
            $stack = New-Object System.Collections.Stack
            $stack.Push($base)
            while ($stack.Count -gt 0) {
                $dir = $stack.Pop()
                foreach ($sub in [IO.Directory]::GetDirectories($dir)) { $stack.Push($sub) }
                foreach ($f in [IO.Directory]::GetFiles($dir)) {
                    # 条目名用正斜杠；解压那边两种都认，但正斜杠是规范形式
                    $rel = $f.Substring($srcRoot.Length + 1).Replace('\', '/')
                    [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile(
                        $zip, $f, $rel, [IO.Compression.CompressionLevel]::$($item.Level))
                }
            }
        }
    } finally { $zip.Dispose() }
    $sw.Stop()

    $size = (Get-Item $to).Length
    $hash = (Get-FileHash $to -Algorithm SHA256).Hash
    Write-Host ("  [完成] {0}  {1:N1} MB  耗时 {2:N0}s（{3:N1} MB/s）" -f `
        (Split-Path -Leaf $to), ($size / 1MB), $sw.Elapsed.TotalSeconds, ($bytes / 1MB / $sw.Elapsed.TotalSeconds))
    Write-Host ("         SHA-256 {0}" -f $hash)
    Write-Host ("         压缩率 {0:N0}%  （{1:N1} MB -> {2:N1} MB）" -f `
        (100 * $size / $bytes), ($bytes / 1MB), ($size / 1MB))
}

Write-Host ""
if ($bad -gt 0) {
    Write-Host "有 $bad 项没打成（见上面的 [跳过]）。"
    exit 1
}

Write-Host "下一步（这个脚本不做）：把 $Out 下的 zip 传上去，然后把地址填进"
Write-Host "  app\desktop\src\svsep.rs 的 MODEL_URL 与 RUNTIME_URL（现在都是空串，"
Write-Host "  界面会显示「还没配置下载地址」）。"
