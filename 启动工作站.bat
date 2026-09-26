@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"
title 清沐的虚拟歌姬工作站

REM ═══════════════════════════════════════════════════════════
REM  启动工作站
REM
REM  后端已经重写成 Rust 并内嵌进 exe 里了 —— 窗口和 HTTP 服务跑在
REM  同一个进程，关掉窗口就是完全退出。所以这里只要把 exe 拉起来即可，
REM  不需要再检查 Node、挑端口、拉起子进程。
REM ═══════════════════════════════════════════════════════════

set "SHELL_EXE=%~dp0清沐的虚拟歌姬工作站.exe"

echo.
echo   ============================================================
echo      清沐的虚拟歌姬工作站
echo   ============================================================
echo.

if not exist "%SHELL_EXE%" (
  echo   [错误] 找不到程序：
  echo          %SHELL_EXE%
  echo.
  echo   还没有编译过。请先运行：
  echo       powershell -ExecutionPolicy Bypass -File app\desktop\build.ps1
  echo.
  pause
  exit /b 1
)

echo   正在启动...
start "" "%SHELL_EXE%"
exit /b 0
