# 编译 Tauri 桌面外壳
#
#   powershell -ExecutionPolicy Bypass -File app\desktop\build.ps1            # debug 版（开发用，编得快）
#   powershell -ExecutionPolicy Bypass -File app\desktop\build.ps1 -Release   # release 版（体积小、跑得快）
#   powershell -ExecutionPolicy Bypass -File app\desktop\build.ps1 -Bundle    # 出安装包（MSI/NSIS）
#
# 编完会把 exe **复制到程序根目录**，覆盖「清沐的虚拟歌姬工作站.exe」——
# 所以双击「启动工作站.bat」跑的就是刚编出来的这版，不需要另做一套开发启动器。
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
    [switch]$Release,     # 编译 release 版（慢，但体积小、跑得快）。默认 debug，适合开发时反复改
    [switch]$Bundle,      # 打出安装包（MSI / NSIS），需要先装 tauri-cli
    [switch]$Clean        # 先 cargo clean
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# 程序根目录：app\desktop → app → 工作站（就是含 app\web\index.html 的那一层）
$root = Split-Path -Parent (Split-Path -Parent $here)

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
    $cargoArgs = if ($Bundle) { @('tauri', 'build') } elseif ($Release) { @('build', '--release') } else { @('build') }
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

    # ── 关键一步：把 exe 复制到程序根目录 ──────────────────────────
    # 根目录的「清沐的虚拟歌姬工作站.exe」就是启动器找的那个文件
    # （见 启动工作站.bat 的 SHELL_EXE）。复制过去之后，双击启动器跑的就是
    # 刚编出来的这版 —— 开发预览和最终打包走同一条路径，不需要第二套启动器。
    $profileDir = if ($Bundle -or $Release) { 'release' } else { 'debug' }
    $target = Join-Path $here "target\$profileDir"
    $exe = Join-Path $target 'qingmu-workstation.exe'

    if (-not (Test-Path $exe)) { throw "编译报成功但找不到产物：$exe" }

    $dest = Join-Path $root '清沐的虚拟歌姬工作站.exe'
    # 根目录那个可能正被占用（程序开着），先提示而不是抛一堆红字
    try {
        Copy-Item $exe $dest -Force
    } catch {
        throw "复制到根目录失败（程序可能还开着）：$($_.Exception.Message)`n请先关掉正在运行的工作站，再重新运行本脚本。"
    }

    $item = Get-Item $dest
    Write-Host ""
    Write-Host ("编译成功：{0}  ({1:N1} MB)" -f $item.Name, ($item.Length / 1MB))
    Write-Host "已复制到根目录，现在双击「启动工作站.bat」跑的就是这一版。"
    Write-Host ""

    if ($Bundle) {
        $bundleDir = Join-Path $target 'bundle'
        if (Test-Path $bundleDir) {
            Write-Host "安装包："
            Get-ChildItem $bundleDir -Recurse -File -Include '*.msi', '*.exe' |
                ForEach-Object { Write-Host ("  {0}  ({1:N1} MB)" -f $_.Name, ($_.Length / 1MB)) }
        }
    }
} finally {
    Pop-Location
}
