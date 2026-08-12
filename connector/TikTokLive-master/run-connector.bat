@echo off
setlocal EnableExtensions
chcp 65001 >nul
set "PYTHONUTF8=1"
set "PYTHONIOENCODING=utf-8"
cd /d "%~dp0"
title TikTokLive Connector

if not exist ".venv\Scripts\python.exe" (
  echo [ERROR] ไม่พบ .venv\Scripts\python.exe
  echo กรุณาสร้าง virtual environment ก่อน
  pause
  exit /b 1
)

echo [START] Using local venv: %CD%\.venv
echo [START] Running connector...
echo.

".venv\Scripts\python.exe" tiktok_connector.py --username %*
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
  echo [ERROR] Connector ออกจากโปรแกรมด้วย exit code %EXIT_CODE%
)

exit /b %EXIT_CODE%
