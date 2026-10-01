# 编译 V-Synth-Studio 桌面外壳（前端 + 后端）
#
#   powershell -ExecutionPolicy Bypass -File app\desktop\build.ps1            # debug 版（开发用，编得快）
#   powershell -ExecutionPolicy Bypass -File app\desktop\build.ps1 -Release   # release 版（体积小、跑得快）
#   powershell -ExecutionPolicy Bypass -File app\desktop\build.ps1 -Bundle    # 出安装包（MSI/NSIS）
#   powershell -ExecutionPolicy Bypass -File app\desktop\build.ps1 -SkipWeb   # 只编后端（改 Rust 时省几秒）
#
# 两步，顺序固定：
#   ① 前端：app\web-next\  → npm run build → 产物落 app\web\（index.html + assets\）
#   ② 后端：cargo build   → exe 复制到程序根目录的 v-synth-studio.exe
#
# ① 必须在 ② 之前，而且**不能跳过**（除非加了 -SkipWeb）：产物是静态文件，
# 后端每请求从磁盘读，所以忘了跑前端 = 界面上是旧代码。
# 这和「直接 cargo build 不复制 exe」是同一类坑：代码是新的，跑起来是旧的。
#
# 为什么要这个脚本：
#   Rust 在 Windows 上用 MSVC 链接器，而 link.exe 和 Windows SDK 的库都需要先
#   「加载 MSVC 环境变量」（PATH/LIB/INCLUDE）。vcvars64.bat 就是干这个的。
#   直接在普通终端跑 cargo 会报 "linker link.exe not found"。
#
# ⚠️ 本文件必须存成 **UTF-8 带 BOM**。PowerShell 5.1 读没有 BOM 的 .ps1 时按 ANSI
#    （GBK）解码，中文注释变乱码，乱码里的引号会吞掉换行 → 语法错。
#    改完跑一次：node tests\manual\fix-ps1-bom.mjs --write
#
# 工具链位置（都装在 H 盘，避免占用 C 盘）：
#   Rust   : H:\DevTools\cargo  +  H:\DevTools\rustup
#   MSVC   : H:\VSBuildTools
#   Win SDK: C:\Program Files (x86)\Windows Kits\10   （系统固定位置）
#   Node   : 系统 PATH 里（只有开发机需要，用户那边不用装）

param(
    [switch]$Release,     # 编译 release 版（慢，但体积小、跑得快）。默认 debug，适合开发时反复改
    [switch]$Bundle,      # 打出安装包（MSI / NSIS），需要先装 tauri-cli
    [switch]$Clean,       # 先 cargo clean
    [switch]$SkipWeb      # 跳过前端构建（只改 Rust、想省那几秒时用）
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
    # ── 第一步：构建新前端（app/web-next → app/web）────────────────
    #
    # 必须在 cargo **之前**：产物是静态文件，后端起服务时每请求从磁盘读，
    # 所以先出产物、再编 exe 顺序才对。反过来也不会有错，但先编前端能早点失败。
    #
    # 这一步是**有意的**，不是可选的优化：忘了跑它，界面上就是旧产物 ——
    # 和「直接 cargo build 不复制 exe」是同一类坑（代码是新的，跑起来是旧的）。
    $webSrc = Join-Path $root 'app\web-next'
    $webOut = Join-Path $root 'app\web'
    if ($SkipWeb) {
        Write-Host "跳过前端构建（-SkipWeb）" -ForegroundColor DarkGray
    } elseif (-not (Test-Path (Join-Path $webSrc 'package.json'))) {
        throw "找不到前端源码：$webSrc\package.json"
    } else {
        # 找 npm。三个坑都踩过，写清楚免得再犯：
        #
        # ① 优先用**固定的自装 Node**，别用 PATH 里第一个。本机 PATH 里第一顺位是
        #    DSH 运行时自带的 `...\DeepSeek Harness-3.1.2-win\resources\node\`——
        #    DSH 一升级或卸载，那个目录就没了，构建随之崩掉。
        # ② `Get-Command npm.cmd` 可能**命中多个**（本机就是 2 个），
        #    直接取 `.Source` 会得到数组，拼进字符串就是垃圾（踩过）。
        #    所以要遍历结果取**第一个**存在的 `.Source`。
        # ③ PowerShell 5.1 不支持 `??`，也别用它。
        $npmCandidates = @(
            'H:\node\npm.cmd'                    # 自装 Node（最稳）
            "$env:ProgramFiles\nodejs\npm.cmd"   # Node 官方安装器默认位置
        )
        $npmExe = $null
        foreach ($p in $npmCandidates) {
            if (Test-Path $p) { $npmExe = $p; break }
        }
        if (-not $npmExe) {
            # 退回到 PATH 搜索：遍历结果，取第一个真实存在的
            foreach ($c in @(Get-Command npm.cmd -CommandType Application -EA SilentlyContinue)) {
                if ($c.Source -and (Test-Path $c.Source)) { $npmExe = $c.Source; break }
            }
        }
        if (-not $npmExe) {
            throw "找不到 npm。前端构建需要 Node.js —— 装好后重试，或加 -SkipWeb 只编后端。"
        }
        Write-Host "npm     : $npmExe" -ForegroundColor DarkGray

        if (-not (Test-Path (Join-Path $webSrc 'node_modules'))) {
            Write-Host "首次构建前端，正在安装依赖（几分钟）…" -ForegroundColor Yellow
            & $npmExe install --no-fund --no-audit
            if ($LASTEXITCODE -ne 0) { throw "npm install 失败（退出码 $LASTEXITCODE）" }
        }

        Write-Host "执行: npm run build   （app\web-next）"
        Write-Host ("─" * 60)
        #
        # ⚠️ 前端产物**直接落在 `app\web\` 根上**，和两个「不是构建产物」的目录同住：
        #    `app\web\vendor\`（JIZURA，PV 页的 iframe 在用）和 `app\web\img\`（logo 与背景图）。
        #    Vite 的 `emptyOutDir: false` 就是为了不把它们清掉（见 vite.config.ts 的注释）。
        #    这里先记下构建前它们在不在，构建后核对一遍：万一哪天有人把 emptyOutDir 打开，
        #    Vite 会连 vendor 一起删掉**而且照样报构建成功**，只在运行时表现成 PV 页打不开、
        #    背景图消失 —— 那种问题极难往回查。构建脚本在这里拦一道比事后查便宜得多。
        $vendorBefore = Test-Path (Join-Path $webOut 'vendor')
        Push-Location $webSrc
        try {
            & $npmExe run build
            $webCode = $LASTEXITCODE
        } finally {
            Pop-Location
        }
        if ($webCode -ne 0) { throw "前端构建失败（退出码 $webCode）" }

        $idx = Join-Path $webOut 'index.html'
        if (-not (Test-Path $idx)) { throw "前端构建报成功但找不到产物：$idx" }
        if ($vendorBefore -and -not (Test-Path (Join-Path $webOut 'vendor'))) {
            throw "前端构建把 app\web\vendor\ 清掉了（PV 页与背景图会失效）。请检查 app\web-next\vite.config.ts 里 emptyOutDir 是否被改成了 true，然后用备份恢复 vendor\。"
        }
        Write-Host "前端已产出：app\web\（index.html + assets\）" -ForegroundColor Green
        Write-Host ""
    }

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
    # 根目录的「v-synth-studio.exe」就是启动器找的那个文件
    # （见 启动工作站.bat 的 SHELL_EXE）。复制过去之后，双击启动器跑的就是
    # 刚编出来的这版 —— 开发预览和最终打包走同一条路径，不需要第二套启动器。
    $profileDir = if ($Bundle -or $Release) { 'release' } else { 'debug' }
    $target = Join-Path $here "target\$profileDir"
    $exe = Join-Path $target 'v-synth-studio.exe'

    if (-not (Test-Path $exe)) { throw "编译报成功但找不到产物：$exe" }

    $dest = Join-Path $root 'v-synth-studio.exe'
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
