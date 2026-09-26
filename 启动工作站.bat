@echo off
chcp 65001 >nul 2>nul
setlocal enabledelayedexpansion
cd /d "%~dp0"
title 清沐的虚拟歌姬工作站

set "SHELL_EXE=%~dp0清沐的虚拟歌姬工作站.exe"

echo.
echo   ============================================================
echo      清沐的虚拟歌姬工作站
echo   ============================================================
echo.

REM ---------- 1. 优先用桌面外壳（原生窗口，内存比浏览器方案低约三成）----------
REM     外壳自己会找 Node、挑空闲端口、拉起服务，再把界面装进原生窗口。
if exist "%SHELL_EXE%" (
  echo   正在启动桌面外壳...
  start "" "%SHELL_EXE%"
  exit /b 0
)

REM ---------- 2. 没有外壳（比如还没编译）时退回浏览器方案 ----------
echo   [提示] 没找到桌面外壳，改用浏览器窗口模式。
echo          想用原生窗口请先运行：app\shell\build.ps1
echo.

set "NODE_EXE="
for %%C in (node.exe) do if not defined NODE_EXE set "NODE_EXE=%%~$PATH:C"
if not defined NODE_EXE if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%APPDATA%\npm\node.exe" set "NODE_EXE=%APPDATA%\npm\node.exe"
if not defined NODE_EXE if exist "H:\node\node.exe" set "NODE_EXE=H:\node\node.exe"
if not defined NODE_EXE if exist "C:\nodejs\node.exe" set "NODE_EXE=C:\nodejs\node.exe"

if not defined NODE_EXE (
  echo   [错误] 没有找到 Node.js，也没有桌面外壳
  echo.
  echo   本程序需要一个 Node.js 运行环境（20 以上，不需要安装任何依赖包）。
  echo   下载地址：https://nodejs.org/zh-cn
  echo   安装完成后重新双击本文件即可。
  echo.
  pause
  exit /b 1
)

REM ---------- 3. 服务已经在跑？只把窗口开出来，不再起第二个服务 ----------
set "RUNNING_PORT="
for %%P in (8787 8788 8789 8790 8791 8792 8793 8794 8795 8796 8797 8798 8799 8800) do (
  if not defined RUNNING_PORT (
    for /f "tokens=5" %%A in ('netstat -ano -p TCP ^| findstr ":%%P " ^| findstr "LISTENING"') do (
      if not "%%A"=="0" set "RUNNING_PORT=%%P"
    )
  )
)

if defined RUNNING_PORT (
  echo   工作站已经在运行（端口 !RUNNING_PORT!），正在打开窗口...
  "!NODE_EXE!" "%~dp0app\server\index.mjs" --open-url=http://127.0.0.1:!RUNNING_PORT!
  echo.
  echo   地址：http://127.0.0.1:!RUNNING_PORT!
  echo   要停止服务，请运行「停止工作站.bat」。
  echo.
  timeout /t 5 >nul
  exit /b 0
)

REM ---------- 4. 正常启动（浏览器窗口模式）----------
for /f "delims=" %%v in ('"!NODE_EXE!" --version 2^>nul') do set "NODE_VER=%%v"
echo   运行环境：Node !NODE_VER!
echo   程序目录：%~dp0
echo.
echo   正在启动本地服务，稍后会自动打开窗口...
echo   （关掉这个黑窗口就会停止服务；也可以留着不管）
echo.

"!NODE_EXE!" "%~dp0app\server\index.mjs" --open

echo.
echo   服务已停止。
pause
exit /b 0
