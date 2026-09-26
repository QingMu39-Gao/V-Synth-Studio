# 前端冒烟测试
#
# 用 Edge/Chrome 无头模式真实加载页面并 dump 渲染后的 DOM，
# 逐个视图检查是否存在错误提示、关键内容是否渲染出来。
#
#   powershell -ExecutionPolicy Bypass -File tests\manual\ui-smoke.ps1
#   powershell -ExecutionPolicy Bypass -File tests\manual\ui-smoke.ps1 -BaseUrl http://127.0.0.1:8891
#
# 前提：工作站服务正在运行（双击 启动工作站.bat，或用 --serve --port=N 起一个）。
#
# 端口现在是**随机分配的**（避免撞车），所以不传 -BaseUrl 时会自动去问
# 正在运行的那个进程占的是哪个端口。早先这里写死 8787（旧 Node 后端的默认值），
# 结果连不上、Edge 渲染错误页，六个视图全部误报「缺内容」。

param(
  [string]$BaseUrl = '',
  [int]$WaitMs = 9000
)

$ErrorActionPreference = 'Continue'

# 自动发现端口：找 qingmu 进程监听的那个口
if (-not $BaseUrl) {
  $proc = Get-Process -Name 'qingmu-workstation', '清沐的虚拟歌姬工作站' -ErrorAction SilentlyContinue |
          Select-Object -First 1
  if ($proc) {
    $conn = Get-NetTCPConnection -OwningProcess $proc.Id -State Listen -ErrorAction SilentlyContinue |
            Select-Object -First 1
    if ($conn) { $BaseUrl = "http://127.0.0.1:$($conn.LocalPort)" }
  }
  if (-not $BaseUrl) {
    Write-Host '找不到正在运行的工作站。' -ForegroundColor Yellow
    Write-Host '请先启动它（双击 启动工作站.bat），或用 -BaseUrl 指定地址。' -ForegroundColor Yellow
    Write-Host '测试用的独立服务：' -ForegroundColor DarkGray
    Write-Host '  app\desktop\target\debug\qingmu-workstation.exe --serve --port=8891' -ForegroundColor DarkGray
    Write-Host '  ...ui-smoke.ps1 -BaseUrl http://127.0.0.1:8891' -ForegroundColor DarkGray
    exit 2
  }
}
Write-Host "目标：$BaseUrl" -ForegroundColor DarkGray

$edge = @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
) | Where-Object { Test-Path $_ } | Select-Object -First 1

if (-not $edge) {
  Write-Host "找不到 Edge 或 Chrome，无法做无头渲染测试。" -ForegroundColor Yellow
  exit 2
}
Write-Host "浏览器：$edge" -ForegroundColor DarkGray

function Get-RenderedDom {
  param([string]$Url)
  $domFile = Join-Path $env:TEMP "ui-smoke-dom.html"
  $errFile = Join-Path $env:TEMP "ui-smoke-err.txt"
  Remove-Item $domFile, $errFile -ErrorAction SilentlyContinue
  $cmd = '"' + $edge + '" --headless=old --disable-gpu --no-sandbox --dump-dom --virtual-time-budget=' + $WaitMs + ' "' + $Url + '" > "' + $domFile + '" 2> "' + $errFile + '"'
  cmd /c $cmd | Out-Null
  if (-not (Test-Path $domFile)) { return '' }
  # 浏览器进程可能还没完全放手文件句柄，重试几次
  for ($i = 0; $i -lt 10; $i++) {
    try {
      # 关键：cmd 重定向写出的是 UTF-8 字节，必须显式按 UTF-8 解码，否则中文会乱码
      return [System.IO.File]::ReadAllText($domFile, [System.Text.Encoding]::UTF8)
    } catch {
      Start-Sleep -Milliseconds 400
    }
  }
  return ''
}

$views = @(
  # 注意：总览页的卡片是**条件渲染**的 —— 「环境就绪度」只在有问题时出现
  # （缺 ffmpeg/yt-dlp、或某格式模块没就绪），全正常时没有这张卡。
  # 所以这里只断言一定会有的东西；想验那张卡要造缺工具的环境。
  # 「本机编辑器」「本机声库」两张卡已随探测功能一起删除，不要再断言它们。
  @{ id = 'dashboard'; name = '总览';       expect = @('欢迎回来', '格式支持', '外部工具', 'nav-item') },
  @{ id = 'convert';   name = '工程转换';   expect = @('来源工程', '目标格式', '转换处理', '输出设置', 'dropzone') },
  @{ id = 'video';     name = '视频解析';   expect = @('video-parse-bar', '解析') },
  @{ id = 'audio';     name = '音频工具';   expect = @('op-card', 'audio-layout') },
  @{ id = 'resources'; name = '资源库';     expect = @('res-toolbar', 'res-grid') },
  @{ id = 'settings';  name = '设置';       expect = @('settings-layout', 'settings-nav') }
)

$errorMarkers = @('视图加载失败', '视图渲染出错', '无法连接本地服务', '前端资源缺失')
$failed = 0

foreach ($v in $views) {
  $url = "$BaseUrl/#/$($v.id)"
  $dom = Get-RenderedDom -Url $url
  if (-not $dom -or $dom.Length -lt 500) {
    Write-Host ("  [失败] {0,-10} {1} —— 页面没有渲染出内容（DOM {2} 字节）" -f $v.id, $v.name, $dom.Length) -ForegroundColor Red
    $script:failed++
    continue
  }

  $errors = @()
  foreach ($m in $errorMarkers) { if ($dom -match [regex]::Escape($m)) { $errors += $m } }

  $missing = @()
  foreach ($k in $v.expect) { if ($dom -notmatch [regex]::Escape($k)) { $missing += $k } }

  if ($errors.Count -gt 0) {
    Write-Host ("  [报错] {0,-10} {1} —— 页面出现错误提示：{2}" -f $v.id, $v.name, ($errors -join '、')) -ForegroundColor Red
    $script:failed++
  } elseif ($missing.Count -gt 0) {
    Write-Host ("  [可疑] {0,-10} {1} —— 缺少预期内容：{2}（DOM {3} 字节）" -f $v.id, $v.name, ($missing -join '、'), $dom.Length) -ForegroundColor Yellow
    $script:failed++
  } else {
    Write-Host ("  [通过] {0,-10} {1} —— DOM {2} 字节" -f $v.id, $v.name, $dom.Length) -ForegroundColor Green
  }
}

Write-Host ""
if ($failed -eq 0) {
  Write-Host "全部视图渲染正常。" -ForegroundColor Green
} else {
  Write-Host "$failed 个视图存在问题。" -ForegroundColor Yellow
  exit 1
}
