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

# ⚠️ 探测路径一律用这个，别直接写 Test-Path：CI runner 上根本没有 H 盘
#    （开发机的自装工具链都在 H 盘），而 `Test-Path H:\...` 对不存在的盘符在
#    PS 5.1 / pwsh 上都会**报错**，`Join-Path` 更是会直接抛
#    "Cannot find drive. A drive with the name 'H' does not exist."。
#    在 $ErrorActionPreference='Stop' 的脚本里，这么一句能让你连「脚本到底跑没跑」都看不出来。
function Test-Exists {
    param([string]$Candidate)          # ⚠️ 别把参数命名成 $Path：PowerShell 变量名大小写不敏感，会和 $env:PATH 撞
    if (-not $Candidate) { return $false }
    try { Test-Path -LiteralPath $Candidate -ErrorAction Stop } catch { $false }
}

# ── 工具链探测（开发机自装路径优先，找不到就用系统默认）──────────────────
#
# 开发机把 Rust/MSVC 装在 H 盘（不占 C 盘）；GitHub Actions 的 runner 上它们在
# 默认位置。两种都支持，所以这里全部改成「探测」而不是「写死 + 检查存在」。
$devDriveOk = Test-Exists 'H:\'          # 连盘符本身都先确认，别让 H: 的路径去碰 Test-Path

$cargoHome  = if ($devDriveOk) { 'H:\DevTools\cargo' }  else { '' }   # 空 = 用默认 %USERPROFILE%\.cargo
$rustupHome = if ($devDriveOk) { 'H:\DevTools\rustup' } else { '' }
$vsRoot     = if ($devDriveOk) { 'H:\VSBuildTools' }    else { '' }
if ($cargoHome  -and -not (Test-Exists (Join-Path $cargoHome 'bin\cargo.exe'))) { $cargoHome  = '' }
if ($rustupHome -and -not (Test-Exists (Join-Path $rustupHome 'toolchains')))   { $rustupHome = '' }

# vcvars64.bat：先看自装路径，再问 vswhere（VS 安装器自带，位置固定）
$vcvars = if ($vsRoot) { Join-Path $vsRoot 'VC\Auxiliary\Build\vcvars64.bat' } else { $null }
if (-not (Test-Exists $vcvars)) {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (Test-Exists $vswhere) {
        $vsPath = & $vswhere -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 `
                             -property installationPath 2>$null | Select-Object -First 1
        if ($vsPath) { $vcvars = Join-Path $vsPath.Trim() 'VC\Auxiliary\Build\vcvars64.bat' }
    }
}
if (-not (Test-Exists $vcvars)) {
    throw "找不到 vcvars64.bat（MSVC 的 C++ 生成工具）。开发机请先运行 H:\DevTools\安装VC工具链.bat；`nCI 上 windows-latest 自带 VS，应能通过 vswhere 找到（若找不到，先加一步 microsoft/setup-msbuild）。`n找过的地方：$vsRoot、vswhere 报告的 VS 安装目录。"
}

# cargo：优先自装，否则从 PATH 找（rustup 装的话在 %USERPROFILE%\.cargo\bin）
$cargo = if ($cargoHome) { Join-Path $cargoHome 'bin\cargo.exe' } else { $null }
if (-not (Test-Exists $cargo)) {
    $cargo = (Get-Command cargo.exe -CommandType Application -EA SilentlyContinue |
              Select-Object -First 1).Source
}
if (-not (Test-Exists $cargo)) {
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

# 谁会被当成链接器 —— rustc 调的是裸名 `link.exe`，所以「PATH 里第一个 link.exe」就是答案。
# 这一行是给 CI 排障用的：运行 #5 那次就是 Git 的 /usr/bin/link 抢到了，而报错信息
# （"Visual Studio build tools may need to be repaired"）把人往完全错误的方向指。
# 只列**不重复的目录**，且跳过 target\ 下的中间产物（rustc 的临时 link.exe 一大堆）。
function Get-LinkExeDirs {
    param([string]$PathValue)
    $found = @()
    foreach ($p in ($PathValue -split ';')) {
        if (-not $p -or $p -match '\\target\\') { continue }
        if (Test-Path -LiteralPath (Join-Path $p 'link.exe') -PathType Leaf) { $found += $p }
    }
    ,$found
}
$linkDirs = Get-LinkExeDirs $env:PATH
if ($linkDirs.Count) {
    Write-Host "link.exe: $($linkDirs[0])"
    if ($linkDirs.Count -gt 1) {
        $rest = if ($linkDirs.Count -gt 4) { ($linkDirs[1..3] -join ' ； ') + " 等 $($linkDirs.Count) 处" } else { $linkDirs[1..($linkDirs.Count-1)] -join ' ； ' }
        Write-Host "          后面还有：$rest" -ForegroundColor DarkGray
    }
}
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
            # ⚠️ 必须用 Test-Exists：CI runner 上没有 H 盘，直接 Test-Path 会**报错**而不是返回 false
            if (Test-Exists $p) { $npmExe = $p; break }
        }
        if (-not $npmExe) {
            # 退回到 PATH 搜索：遍历结果，取第一个真实存在的
            foreach ($c in @(Get-Command npm.cmd -CommandType Application -EA SilentlyContinue)) {
                if ($c.Source -and (Test-Exists $c.Source)) { $npmExe = $c.Source; break }
            }
        }
        if (-not $npmExe) {
            throw "找不到 npm。前端构建需要 Node.js —— 装好后重试，或加 -SkipWeb 只编后端。"
        }
        Write-Host "npm     : $npmExe" -ForegroundColor DarkGray

        if (-not (Test-Path (Join-Path $webSrc 'node_modules'))) {
            Write-Host "首次构建前端，正在安装依赖（几分钟）…" -ForegroundColor Yellow
            # ⚠️ 必须切到前端源码目录再装：`npm install` 是**在当前目录**找 package.json 的
            #    （它不像 vite/tsc 那样往上找），而本脚本开头 Push-Location 到了 $here
            #    （app\desktop），那里没有 package.json。CI 上实测报：
            #      npm error code ENOENT … open 'D:\a\…\app\desktop\package.json'
            #      npm error enoent This is related to npm not being able to find a file.
            #    开发机上从没暴露过，因为 node_modules 早就装好了，这句根本不跑。
            #    `npm run build` 那步本来就有 Push-Location，所以一直是好的 —— 两处必须一致。
            Push-Location $webSrc
            try {
                & $npmExe install --no-fund --no-audit
                $installCode = $LASTEXITCODE
            } finally {
                Pop-Location
            }
            if ($installCode -ne 0) { throw "npm install 失败（退出码 $installCode）" }
            # 报成功了但没产物，也要拦：后面 npm run build 会以更难看的方式炸
            if (-not (Test-Path (Join-Path $webSrc 'node_modules'))) {
                throw "npm install 报成功但 app\web-next\node_modules 不存在，前端构建没法进行。"
            }
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
    #
    # ⚠️ 必须把 Git 的 Unix 工具目录从 PATH 里剔掉，否则 Rust 会拿 /usr/bin/link 当链接器。
    #
    #    GitHub 的 windows-latest 装了 **Git for Windows**，它的
    #    `C:\Program Files\Git\usr\bin` 是**系统 PATH 的一部分**（永久），而且里面有 coreutils
    #    的 `link.exe`（就是 `ln` 的别名）。rustc 默认调裸名 `link.exe`，找到谁用谁 ——
    #    于是打包时报（运行 #5 实测，末尾 3 行是关键）：
    #      error: linking with `link.exe` failed: exit code: 1
    #      = note: "C:\\Program Files\\Git\\usr\\bin\\link.exe" "/NOLOGO" ...
    #      = note: /usr/bin/link: extra operand '...cgu.0.rcgu.o'
    #      note: the Visual Studio build tools may need to be repaired using the Visual Studio installer
    #    最后那句提示是**纯误导**：MSVC 装得好好的，只是没轮到它。
    #
    # 开发机从没暴露：H 盘那套工具链加上 vcvars 抢先，Git 的 usr\bin 排不到前面。
    # 刻意**不**去猜是不是「vcvars 没抢过 Git」——直接把 `\Git\...` 的 PATH 段全删掉，
    # 让 MSVC 成为唯一的 link.exe 来源，顺便把结果打出来当证据。
    #
    # 正则只吃 `\Git\usr` / `\Git\mingw64` / `\Git\cmd` 三段。**别写成 '\\Git\\'**：
    # 那样会连 Git 的安装根、以及探测时自己造的临时目录一起吃掉，定位时吃过一次假阴性。
    $pathParts = $env:PATH -split ';' | Where-Object { $_ -and $_ -notmatch '\\Git\\(usr|mingw64|cmd)' }
    $pathClean = ($pathParts -join ';')

    # ⚠️ 顺序是**实测定的，别调换**：`set "PATH=$pathClean"` 必须在 `call vcvars` **之前**。
    #    vcvars64.bat 是把 MSVC 的路径 **prepend** 到它运行时的 PATH 上；先 call vcvars
    #    再覆盖 PATH 会把 vcvars 刚加进去的 MSVC 那几段整段抹掉。
    #
    # ⚠️⚠️ 更要命的一条（CI 上连挂两次的**真正原因**）：**别再拼 `cmd /c "a && b && c"` 这种长链**。
    #    cmd 把整条链**先整体解析、把 `%PATH%` 之类的 `%VAR%` 全部展开完**，然后才逐条执行 ——
    #    所以链里那句 `set "PATH=...;%PATH%"` 里的 `%PATH%` 拿到的是**启动 cmd 时的原始 PATH**，
    #    而不是前面 `set`/`vcvars` 改过的运行时值。结果：`call vcvars` 好不容易把 MSVC 排到最前，
    #    最后又一句 `set PATH` 把 Git 的 `usr\bin` 原样放回前面 → rustc 调裸名 `link.exe` 时
    #    拿到的是 Git 自带的 coreutils `link`（`ln` 的别名），报
    #    `/usr/bin/link: extra operand ...rcgu.o`（后面那句「build tools may need to be repaired」
    #    是纯误导，MSVC 装得好好的）。
    #    改法：把命令写进临时 `.cmd` 再执行 —— 批处理是**逐行**解析执行的，`%PATH%` 才在运行时展开。
    #
    # 另外双保险：从 vcvars 那里问出 MSVC 工具链位置，把它的 `bin\Hostx64\x64` 顶到 PATH 最前面
    # （rustc 调裸名 `link.exe`，PATH 里第一个就是答案 —— 谁在最前谁赢，不赌 vcvars 的 prepend）。
    $msvcBin = $null
    try {
        $vct = (& cmd /c "call `"$vcvars`" >nul && set VCToolsInstallDir" 2>$null) |
               Where-Object { $_ -match '^VCToolsInstallDir=' } | Select-Object -First 1
        if ($vct) {
            $cand = Join-Path ($vct -replace '^VCToolsInstallDir=', '').Trim() 'bin\Hostx64\x64'
            if (Test-Path -LiteralPath (Join-Path $cand 'link.exe') -PathType Leaf) { $msvcBin = $cand }
        }
    } catch { }
    if ($msvcBin) { Write-Host "MSVC 链接器：$msvcBin\link.exe" }
    else          { Write-Warning "没从 vcvars 问出 VCToolsInstallDir，只能靠 PATH 剔除 Git 段兜着。" }

    # 双保险②：把 MSVC 的 `bin\Hostx64\x64` **顶到 PATH 最前面**。
    #    rustc 调的是裸名 `link.exe`，PATH 里第一个就是答案 —— 这样即使 `$pathClean`
    #    没剔干净（或 vcvars 没按预期 prepend），MSVC 也稳赢 Git 那个 coreutils `link`。
    #    ⚠️ 别改用 RUSTFLAGS=-C linker=... ：实测 `set "RUSTFLAGS=-C linker="C:\...\link.exe""`
    #    里的引号会被 cmd 原样塞给 rustc，报 `could not exec the linker "\"C:\\...\""`
    #    （文件名、目录名或卷标语法不正确，os error 123）—— 引号在 cmd 里没法干净地嵌套。
    $bat = @("set `"PATH=$pathClean`"", "call `"$vcvars`" >nul")
    if ($msvcBin) { $bat += "set `"PATH=$msvcBin;%PATH%`"" }
    if ($cargoHome)  { $bat += "set `"CARGO_HOME=$cargoHome`"" }
    if ($rustupHome) { $bat += "set `"RUSTUP_HOME=$rustupHome`"" }
    $bat += "set `"PATH=$(Split-Path -Parent $cargo);%PATH%`""
    $bat += "where link.exe > `"$whereFile`" 2>nul"
    $bat += "`"$cargo`" $($cargoArgs -join ' ')"

    $cmdFile   = Join-Path $env:TEMP 'vsynth-cargo-build.cmd'
    $whereFile = Join-Path $env:TEMP 'vsynth-where-link.txt'
    Remove-Item $whereFile -Force -ErrorAction SilentlyContinue
    [IO.File]::WriteAllText($cmdFile, (($bat -join "`r`n") + "`r`n"), (New-Object Text.UTF8Encoding $false))

    Write-Host "执行: cargo $($cargoArgs -join ' ')"
    Write-Host ("─" * 60)

    try {
        & cmd /c "`"$cmdFile`""
        $code = $LASTEXITCODE
    } finally {
        Remove-Item $cmdFile -Force -ErrorAction SilentlyContinue
    }
    Write-Host ("─" * 60)

    # 开跑前验一次链接器身份，别把二十多分钟的编译赌在一句假设上。
    # 只用 `where link.exe` 的**第一行**（重定向进文件再读，避免编码/退出码的歧义）：
    # 第一行就落在 `\Git\` 里说明链接器还是 coreutils 的 `ln`，直接报出来，别等编译到一半才炸。
    if (Test-Path -LiteralPath $whereFile) {
        $firstLink = Get-Content -LiteralPath $whereFile -TotalCount 1
        Remove-Item $whereFile -Force -ErrorAction SilentlyContinue
        if ($firstLink) {
            Write-Host "首选 link.exe：$firstLink"
            if ($firstLink -match '\\Git\\') {
                throw ("PATH 里第一个 link.exe 是 Git 自带的 GNU coreutils `link`（不是 MSVC 链接器），编译必然失败：`n  $firstLink`n" +
                       "已剔除 \Git\usr / \Git\mingw64 / \Git\cmd，说明还有别处也放了 link.exe。`n" +
                       "排查：where.exe /r C:\ link.exe")
            }
        }
    }

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
