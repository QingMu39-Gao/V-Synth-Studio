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
# 工具链位置（开发机都装在 H 盘，避免占用 C 盘）：
#   Rust   : H:\DevTools\cargo  +  H:\DevTools\rustup
#   MSVC   : H:\VSBuildTools
#   Win SDK: C:\Program Files (x86)\Windows Kits\10   （系统固定位置）
#   Node   : 系统 PATH 里（只有开发机需要，用户那边不用装）
#
# ⚠️ 2026-10-02：上面这些路径**不再是硬性要求**。为了能在 GitHub Actions 上跑，
#    本脚本会按「先找自装路径、找不到就用系统默认」的顺序自己探测（见下面「工具链探测」）。
#    改动的原因很直接：CI runner 上 H 盘不存在，原来那句 `if (-not (Test-Path $vcvars)) { throw }`
#    会让工作流在第一步就死掉，而且死因看起来像「没装 VS」——极难往回查。

param(
    [switch]$Release,     # 编译 release 版（慢，但体积小、跑得快）。默认 debug，适合开发时反复改
    [switch]$Bundle,      # 打出安装包（MSI / NSIS），需要先装 tauri-cli
    [switch]$Clean,       # 先 cargo clean
    [switch]$SkipWeb,     # 跳过前端构建（只改 Rust、想省那几秒时用）
    [switch]$FetchTools,  # 先补齐 tools\ 与 JIZURA 字体（干净机器 / CI 上用，要联网）
    [switch]$NoCopy       # 不把 exe 复制到程序根目录（CI 用，省得去动仓库根）
)

$ErrorActionPreference = 'Stop'

# 跨平台说明放在最前面，因为这台是 Windows、以后要适配 mac 和 android，
# 而 `-Bundle` 在最容易踩的方式下失败：tauri 只管「当前平台怎么打」，
# 在 macOS 上跑 -Bundle 会去找不存在的东西，然后报一堆看着像代码错的构建错误。
if ($Bundle -and $env:OS -ne 'Windows_NT') {
    throw ("-Bundle 目前只实现了 Windows 的 MSI（tauri.conf.json 的 bundle.targets 是 [""msi""]）。" +
           "`n这个脚本探测的也是 MSVC + Windows SDK，在别处必然失败。" +
           "`n要在 macOS / Linux 上出包，请另写一个 scripts/build-<平台>.sh（前端那步完全一样：" +
           "`n  cd app/web-next && npm ci && npm run build   ，产物同样是 ../web/），" +
           "`n后端只差 tauri.conf.json 的 bundle.targets 与图标（icons/ 里已有 icon.icns 等 mac 用的现成物）。")
}

$here = Split-Path -Parent $MyInvocation.MyCommand.Path

# 程序根目录：app\desktop → app → 工作站（就是含 app\web\index.html 的那一层）
$root = Split-Path -Parent (Split-Path -Parent $here)

# ── 工具链探测（开发机自装路径优先，找不到就用系统默认）──────────────────
#
# 开发机把 Rust/MSVC 装在 H 盘（不占 C 盘）；GitHub Actions 的 runner 上它们在
# 默认位置。两种都支持，所以这里全部改成「探测」而不是「写死 + 检查存在」。
$cargoHome  = 'H:\DevTools\cargo'
$rustupHome = 'H:\DevTools\rustup'
$vsRoot     = 'H:\VSBuildTools'
if (-not (Test-Path (Join-Path $cargoHome 'bin\cargo.exe'))) { $cargoHome = '' }    # 空 = 用默认 %USERPROFILE%\.cargo
if (-not (Test-Path (Join-Path $rustupHome 'toolchains')))   { $rustupHome = '' }

# vcvars64.bat：先看自装路径，再问 vswhere（VS 安装器自带，位置固定）
$vcvars = Join-Path $vsRoot 'VC\Auxiliary\Build\vcvars64.bat'
if (-not (Test-Path $vcvars)) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Path $vswhere) {
        $vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
                             -property installationPath 2>$null | Select-Object -First 1
        if ($vsPath) { $vcvars = Join-Path $vsPath.Trim() 'VC\Auxiliary\Build\vcvars64.bat' }
    }
}
if (-not (Test-Path $vcvars)) {
    throw "找不到 vcvars64.bat（MSVC 的 C++ 生成工具）。开发机请先运行 H:\DevTools\安装VC工具链.bat；`nCI 上请用 microsoft/setup-msbuild 或 preinstalled 的 VS。`n找过的地方：$vsRoot、vswhere 报告的 VS 安装目录。"
}

# cargo：优先自装，否则从 PATH 找（rustup 装的话在 %USERPROFILE%\.cargo\bin）
$cargo = if ($cargoHome) { Join-Path $cargoHome 'bin\cargo.exe' } else { $null }
if (-not $cargo -or -not (Test-Path $cargo)) {
    $cargo = (Get-Command cargo.exe -CommandType Application -EA SilentlyContinue |
              Select-Object -First 1).Source
}
if (-not $cargo -or -not (Test-Path $cargo)) {
    throw "找不到 cargo。装 Rust（rustup）后重试；CI 上用 dtolnay/rust-toolchain。"
}

# Windows SDK 是 MSVC 链接必需的前置，先确认它在
$sdkOk = Get-ChildItem 'C:\Program Files (x86)\Windows Kits\10\Lib' -Directory -EA SilentlyContinue |
         Where-Object { Test-Path (Join-Path $_.FullName 'um\x64\kernel32.lib') } |
         Select-Object -First 1
if (-not $sdkOk) {
    throw "找不到 Windows SDK 的 kernel32.lib`n（应该在 C:\Program Files (x86)\Windows Kits\10\Lib\10.*\um\x64\）"
}

Write-Host "cargo   : $cargo"
Write-Host "vcvars  : $vcvars"
Write-Host "Win SDK : $($sdkOk.FullName)"
Write-Host ""

# ── 第零步（可选）：补齐 tools\ 与 JIZURA 字体 ─────────────────────────────────
#
# 两块「不属于源码、但随安装包分发」的大二进制，合计约 340 MB，都**不入库**：
#   ① tools\                     ffmpeg + yt-dlp + LibreSVIP CLI ≈ 288MB（.gitignore 锚定 /tools/）
#   ② app\web\vendor\jizura\     JIZURA PV 的 index.html + 2335 个 woff2 ≈ 54MB
# 所以在一台干净机器上（新电脑、CI）这一步必须有人做，否则编译照样成功、装了也能启动，
# 只有用户点「工程转换」或打开文字 PV 时才报缺东西。
if ($FetchTools) {
    $fetch = Join-Path $here 'fetch-tools.ps1'
    Write-Host "补齐外部工具与字体（fetch-tools.ps1）"
    Write-Host ("─" * 60)
    # ⚠️ 用 & 调用而不是 dot-source：fetch-tools.ps1 里有 `exit 1`，
    #    dot-source（`. $fetch`）会把**本脚本**一起结束掉，后面什么都不跑还看不出原因。
    & $fetch
    if ($LASTEXITCODE -ne 0) { throw "外部工具/字体不齐（fetch-tools.ps1 退出码 $LASTEXITCODE）" }
    Write-Host ""
}

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

    # 打包前把「随包分发的东西齐不齐」核死。
    #
    # ⚠️ 为什么必须在**这里**拦：tauri 的 bundle.resources 映射的是
    #    `"../../app/web": "app/web"` 和 `"../../tools": "tools"` —— 源目录缺文件时
    #    **构建不报错**，打出来的 MSI 里就是少的。那种包要在用户点「工程转换」（缺 LibreSVIP）
    #    或打开文字 PV（缺 JIZURA）时才现形，而那时已经发出去了。
    if ($Bundle) {
        $need = @(
            'tools\ffmpeg\bin\ffmpeg.exe',
            'tools\yt-dlp.exe',
            'tools\libresvip\libresvip-cli\libresvip-cli.exe',
            'app\web\vendor\jizura\index.html',
            'app\web\index.html'
        )
        $missing = @($need | Where-Object { -not (Test-Path (Join-Path $root $_)) })
        if ($missing.Count) {
            throw ("打包缺文件（装出来的程序会缺功能）：`n  - " + ($missing -join "`n  - ") +
                   "`n先跑：powershell -ExecutionPolicy Bypass -File app\desktop\build.ps1 -FetchTools -Bundle")
        }
    }

    $cargoArgs = if ($Bundle) { @('tauri', 'build') } elseif ($Release) { @('build', '--release') } else { @('build') }
    if ($Clean) { $cargoArgs = @('clean') + $cargoArgs }

    # 在 cmd 里 call vcvars 设置好 MSVC 环境，再跑 cargo。
    # CARGO_HOME / RUSTUP_HOME 只在探测到自装路径时才覆盖 —— 留空就等于让 rustup 用默认位置
    # （CI 上就是默认的 %USERPROFILE%\.cargo 与 %USERPROFILE%\.rustup）。
    $inner = @("call `"$vcvars`" >nul")
    if ($cargoHome)  { $inner += "set `"CARGO_HOME=$cargoHome`"" }
    if ($rustupHome) { $inner += "set `"RUSTUP_HOME=$rustupHome`"" }
    $inner += "set `"PATH=$(Split-Path -Parent $cargo);%PATH%`""
    $inner += "`"$cargo`" $($cargoArgs -join ' ')"
    $inner = $inner -join ' && '

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

    if ($NoCopy) {
        Write-Host ""
        Write-Host ("编译成功：{0}  ({1:N1} MB)（-NoCopy，没往根目录复制）" -f (Split-Path -Leaf $exe), ((Get-Item $exe).Length / 1MB))
        Write-Host ""
    } else {
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
    }

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
