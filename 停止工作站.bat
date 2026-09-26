@echo off
chcp 65001 >nul 2>nul
title 停止清沐的虚拟歌姬工作站

REM ═══════════════════════════════════════════════════════════
REM  停止工作站
REM
REM  按进程名停，不扫端口 —— 端口是启动时随机分配的（避免和别的程序撞车），
REM  写死端口列表的旧做法已经找不到它了。
REM ═══════════════════════════════════════════════════════════

echo.

tasklist /fi "imagename eq qingmu-workstation.exe" 2>nul | find /i "qingmu-workstation.exe" >nul
if errorlevel 1 (
  echo   没有发现正在运行的工作站。
  echo.
  timeout /t 2 >nul
  exit /b 0
)

echo   正在停止工作站...
taskkill /f /im qingmu-workstation.exe >nul 2>&1

REM taskkill 是异步的，等它真的退出
for /l %%i in (1,1,20) do (
  tasklist /fi "imagename eq qingmu-workstation.exe" 2>nul | find /i "qingmu-workstation.exe" >nul
  if errorlevel 1 goto :done
  timeout /t 1 /nobreak >nul
)

:done
echo.
echo   工作站已停止。
echo.
timeout /t 2 >nul
exit /b 0
