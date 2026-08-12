@echo off
setlocal EnableExtensions
cd /d "%~dp0"
title LiveFlow Desktop Launcher

echo ==========================================
echo   LiveFlow Desktop Launcher
echo ==========================================
echo.
echo Working folder: %CD%
echo.

if not exist "package.json" (
  echo [ERROR] ไม่พบ package.json ในโฟลเดอร์นี้
  echo กรุณาวางไฟล์ .bat ไว้ในโฟลเดอร์ liveflow-app
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo [INFO] ยังไม่พบ node_modules
  echo ถ้ายังไม่ได้ติดตั้ง dependencies ให้รัน npm install ก่อน
  echo.
)

echo [START] กำลังเปิด Tauri Desktop...
echo.
call npm run tauri:dev
set "EXIT_CODE=%ERRORLEVEL%"

echo.
if not "%EXIT_CODE%"=="0" (
  echo [ERROR] การเปิดโปรแกรมไม่สำเร็จ (exit code %EXIT_CODE%)
  echo ตรวจสอบ error ด้านบนได้เลย
  pause
)

exit /b %EXIT_CODE%
