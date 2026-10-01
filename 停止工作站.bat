@echo off
chcp 65001 >nul 2>nul
title 停止 V-Synth-Studio

REM ===========================================================
REM  Stop V-Synth-Studio
REM
REM  Kills by image name, not by port. The port is normally pinned to
REM  17878 but falls back to a random one when taken, so scanning the
REM  port is unreliable -- the image name is correct in both cases.
REM
REM  NOTE: keep every REM line ASCII-only. Chinese in REM lines makes
REM  cmd emit bogus "is not recognized" lines on this machine; Chinese
REM  inside echo is fine.
REM  NOTE: this file must stay CRLF. cmd cannot parse bare LF.
REM ===========================================================

echo.

tasklist /fi "imagename eq v-synth-studio.exe" 2>nul | find /i "v-synth-studio.exe" >nul
if errorlevel 1 (
  echo   没有发现正在运行的工作站。
  echo.
  timeout /t 2 >nul
  exit /b 0
)

echo   正在停止工作站...
taskkill /f /im v-synth-studio.exe >nul 2>&1

REM taskkill is asynchronous; wait until the process is really gone.
for /l %%i in (1,1,20) do (
  tasklist /fi "imagename eq v-synth-studio.exe" 2>nul | find /i "v-synth-studio.exe" >nul
  if errorlevel 1 goto :done
  timeout /t 1 /nobreak >nul
)

:done
echo.
echo   工作站已停止。
echo.
timeout /t 2 >nul
exit /b 0
