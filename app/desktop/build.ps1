# 编译 Tauri 桌面外壳
#
#   powershell -ExecutionPolicy Bypass -File app\desktop\build.ps1            # 只出 exe
#   powershell -ExecutionPolicy Bypass -File app\desktop\build.ps1 -Bundle    # 出 exe + MSI/NSIS
#
# 为什么要这个脚本：
#   Rust 在 Windows 上用 MSVC 链接器，而 link.exe 和 Windows SDK 的库都需要先
#   「加载 MSVC 环境变量」（PATH/LIB/INCLUDE）。vcvars64.bat 就是干这个的。
#   直接在普通终端跑 cargo 会报 "linker link.exe not found"。
#
# 工具链位置（都装在 H 盘，避免占用 C 盘）：
#   Rust   : H:\DevTools\cargo  +  H:\DevTools\rustup
#   MSVC   : H:\VSBuildTools
#   Win SDK: C:\Program Files (x86)\Windows Kits\10   （系统固定位置）

param(
    [switch]$Bundle,      # 打出安装包（MSI / NSIS），需要先装 tauri-cli
    [switch]$Clean        # 先 cargo clean
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# ── 工具链路径 ──────────────────────────────────────────────
$cargoHome = 'H:\DevTools\cargo'
$rustupHome = 'H:\DevTools\rustup'
$vsRoot = 'H:\VSBuildTools'
$vcvars = Join-Path $vsRoot 'VC\Auxiliary\Build\vcvars64.bat'

if (-not (Test-Path $vcvars)) {
    throw "找不到 vcvars64.bat：$vcvars`n请先运行 H:\DevTools\安装VC工具链.bat（右键以管理员身份运行）"
}

$cargo = Join-Path $cargoHome 'bin\cargo.exe'
if (-not (Test-Path $cargo)) { throw "找不到 cargo：$cargo" }

# Windows SDK 是 MSVC 链接必需的前置，先确认它在
$sdkOk = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\Lib' -Directory -EA SilentlyContinue |
         Where-Object { Test-Path (Join-Path $_.FullName 'um\x64\kernel32.lib') } |
         Select-Object -First 1
if (-not $sdkOk) {
    throw "找不到 Windows SDK 的 kernel32.lib`n（应该在 C:\Program Files (x86)\Windows Kits\10\Lib\10.*\um\x64\）"
}

Write-Host "Rust    : $cargoHome"
Write-Host "MSVC    : $vsRoot"
Write-Host "Win SDK : $($sdkOk.FullName)"
Write-Host ""

Push-Location $here
try {
    $cargoArgs = if ($Bundle) { @('tauri', 'build') } else { @('build', '--release') }
    if ($Clean) { $cargoArgs = @('clean') + $cargoArgs }

    # 在 cmd 里 call vcvars 设置好 MSVC 环境，再跑 cargo
    $inner = @(
        "call `"$vcvars`" >nul"
        "set `"CARGO_HOME=$cargoHome`""
        "set `"RUSTUP_HOME=$rustupHome`""
        "set `"PATH=$cargoHome\bin;%PATH%`""
        "`"$cargo`" $($cargoArgs -join ' ')"
    ) -join ' && '

    Write-Host "执行: cargo $($cargoArgs -join ' ')"
    Write-Host ("─" * 60)
    & cmd /c $inner
    $code = $LASTEXITCODE
    Write-Host ("─" * 60)

    if ($code -ne 0) { throw "编译失败（退出码 $code）" }

    # 产物位置
    $target = Join-Path $here 'target\release'
    $exe = Get-ChildItem $target -Filter '*.exe' -EA SilentlyContinue |
           Where-Object { $_.Name -notmatch 'build-script|\.d\.exe$' } |
           Select-Object -First 1
    if ($exe) {
        Write-Host ""
        Write-Host ("编译成功：{0}  ({1:N1} MB)" -f $exe.Name, ($exe.Length / 1MB))
        Write-Host "位置：$($exe.FullName)"
    }
    if ($Bundle) {
        $bundleDir = Join-Path $target 'bundle'
        if (Test-Path $bundleDir) {
            Write-Host ""
            Write-Host "安装包："
            Get-ChildItem $bundleDir -Recurse -File -Include '*.msi', '*.exe' |
                ForEach-Object { Write-Host ("  {0}  ({1:N1} MB)" -f $_.Name, ($_.Length / 1MB)) }
        }
    }
} finally {
    Pop-Location
}
