@echo off
chcp 65001 >nul 2>nul
cd /d "%~dp0"
title V-Synth-Studio

REM ===========================================================
REM  V-Synth-Studio launcher
REM
REM  Usage:
REM    launch.bat                       start the app (window + embedded service)
REM    launch.bat --serve --port=8891   service only, no window (for tests)
REM
REM  There is only ONE front end now (React, served at "/").
REM  Until 2026-10-05 this file chose between the old and the new UI
REM  ("--old" / "--ui=next"); the old UI is gone, so the choice is gone.
REM  Files are read from disk per request, so editing the front end still
REM  needs no rebuild -- only "npm run build" in app\web-next.
REM
REM  ---------------------------------------------------------
REM  HARD RULES for this file (learned the hard way):
REM   1. CRLF line endings. cmd cannot parse bare LF.
REM   2. NO Chinese anywhere except a plain single-line "echo".
REM      Chinese inside REM lines, and inside if/else blocks, makes cmd
REM      emit bogus "xxx is not recognized" lines and can break the
REM      branch logic itself. Keep everything but echo ASCII-only.
REM   3. cmd treats "=" as an argument separator, so do not try to parse
REM      options here. Pass %* straight through to the exe.
REM ===========================================================

set "SHELL_EXE=%~dp0v-synth-studio.exe"

if not exist "%SHELL_EXE%" goto :missing

echo.
echo   ============================================================
echo      V-Synth-Studio
echo   ============================================================
echo.
echo   正在启动...
start "" "%SHELL_EXE%" %*
exit /b 0

:missing
echo.
echo   [错误] 找不到程序：
echo          %SHELL_EXE%
echo.
echo   还没有编译过。请先运行：
echo       powershell -ExecutionPolicy Bypass -File app\desktop\build.ps1
echo.
pause
exit /b 1
