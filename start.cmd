@echo off
setlocal
cd /d "%~dp0"
if exist "runtime\node.exe" (
  "runtime\node.exe" "%~dp0server.mjs"
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    echo Node.js 22.13 or later is required. Install it or place node.exe in runtime\.
    if /i not "%~1"=="--no-pause" pause
    exit /b 1
  )
  node "%~dp0server.mjs"
)
set "workboard_exit=%errorlevel%"
if /i not "%~1"=="--no-pause" pause
exit /b %workboard_exit%
