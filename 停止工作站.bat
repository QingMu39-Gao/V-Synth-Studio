@echo off
chcp 65001 >nul 2>nul
setlocal enabledelayedexpansion
title 停止翻调工作站

set FOUND=0
for %%P in (8787 8788 8789 8790 8791 8792 8793 8794 8795 8796 8797 8798 8799 8800) do (
  for /f "tokens=5" %%A in ('netstat -ano -p TCP ^| findstr ":%%P " ^| findstr "LISTENING"') do (
    if not "%%A"=="0" (
      echo   正在停止端口 %%P 上的服务（PID %%A）...
      taskkill /f /pid %%A >nul 2>nul
      if !errorlevel! equ 0 set FOUND=1
    )
  )
)

if "!FOUND!"=="1" (
  echo.
  echo   工作站已停止。
) else (
  echo.
  echo   没有发现正在运行的工作站服务。
)
echo.
timeout /t 2 >nul
