# 把「炽小阳音轨分离站离线版」的后端运行时搬进工作站数据目录
#
# 产出：app/data/svsep/  ← 打包成一个 zip 给用户下载（约 8.6 GB）
#   models/    730 MB   两个模型（BS-Roformer-SW.ckpt 667 MB + UVR-MDX-NET-Inst_HQ_3.onnx 63.7 MB）
#   runtime/   7.6 GB   Python 3.10 embeddable + torch/onnxruntime/audio-separator
#   backend/   0.4 MB   Flask 后端（**前端已删**：templates/ 与 static/ 不再搬）
#   bin/       159 MB   ffmpeg.exe
#
# 为什么删 templates/ 与 static/：工作站用自己的 React 界面，后端只当 JSON API 用。
# 原软件那套 Jinja 模板 + app.js/style.css 已经没人读，留着只会让人以为还有第二个界面。
#
# 用法：
#   powershell -ExecutionPolicy Bypass -File tools\svsep-stage.ps1
#   powershell -ExecutionPolicy Bypass -File tools\svsep-stage.ps1 -SkipRuntime   # 只补 backend
#
# ⚠️ 这不是给用户跑的东西 —— 它只服务于开发机的打包流程。
#   用户拿到的是 zip，不是这个脚本。

param(
    [string]$Source = 'C:\Users\Administrator\Desktop\工作站素材\炽小阳音轨分离站离线版',
    [string]$Target = 'H:\工作站\app\data\svsep',
    [switch]$SkipRuntime,
    [switch]$SkipModels
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $Source)) { throw "源目录不存在：$Source" }
$srcRes = Join-Path $Source 'resources'
if (-not (Test-Path $srcRes)) { throw "源的 resources 目录不存在：$srcRes" }

Write-Host "源：$Source"
Write-Host "目标：$Target"
Write-Host ""

foreach ($d in @('models', 'runtime', 'backend', 'bin')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $Target $d) | Out-Null
}

# robocopy 的退出码 0-7 都是「成功」，>=8 才是错误
function Copy-Tree {
    param([string]$From, [string]$To, [string[]]$ExtraArgs = @())
    Write-Host "→ $From"
    Write-Host "  $To"
    $args = @($From, $To, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS', '/R:2', '/W:2') + $ExtraArgs
    & robocopy @args | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy 失败（退出码 $LASTEXITCODE）：$From → $To" }
    $script:rc = $LASTEXITCODE
}

if (-not $SkipModels) {
    Copy-Tree (Join-Path $srcRes 'models') (Join-Path $Target 'models')
}
if (-not $SkipRuntime) {
    Copy-Tree (Join-Path $srcRes 'runtime') (Join-Path $Target 'runtime') @('/XF', '*.pyc')
}
Copy-Tree (Join-Path $srcRes 'backend') (Join-Path $Target 'backend') @(
    '/XD', '__pycache__',
    '/XF', '*.pyc',
    # 前端（Jinja 模板 + 静态资源）不搬：工作站有自己的一套
    '/XF', 'index.html',
    '/XD', 'static',
    '/XD', 'templates'
)
Copy-Tree (Join-Path $srcRes 'bin') (Join-Path $Target 'bin')

Write-Host ""
Write-Host "=== 结果 ==="
Get-ChildItem $Target -Directory | ForEach-Object {
    $s = (Get-ChildItem $_.FullName -Recurse -File -EA SilentlyContinue | Measure-Object -Property Length -Sum).Sum
    $n = @(Get-ChildItem $_.FullName -Recurse -File -EA SilentlyContinue).Count
    "{0,-12} {1,8:N1} MB  {2,6} 文件" -f $_.Name, ($s / 1MB), $n
}
$tot = (Get-ChildItem $Target -Recurse -File -EA SilentlyContinue | Measure-Object -Property Length -Sum).Sum
"{0,-12} {1,8:N2} GB" -f '总计', ($tot / 1GB)

Write-Host ""
Write-Host "后端文件清单："
Get-ChildItem (Join-Path $Target 'backend') -File | ForEach-Object { "  $($_.Name)" }
