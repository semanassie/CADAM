@echo off
cd /d "%~dp0"
title CADAM
color 0A

set PORT=3004
set APP_URL=http://localhost:%PORT%/cadam

echo.
echo  =============================================
echo   CADAM - AI CAD Editor
echo   URL: %APP_URL%
echo  =============================================
echo.

REM Node.js check
node --version >nul 2>&1
if %errorlevel% neq 0 (
    echo  ERROR: Node.js not found. Install from https://nodejs.org
    pause & exit /b 1
)

REM Install deps if needed
if not exist "node_modules" (
    echo  Installing dependencies...
    call npm install
    if %errorlevel% neq 0 ( echo  ERROR: npm install failed & pause & exit /b 1 )
)

echo.
echo  Starting on %APP_URL%
echo  Browser will open in ~5 seconds...
echo  Press Ctrl+C to stop both servers.
echo.

REM Open browser after ~5s using ping delay
start /min cmd /c "ping 127.0.0.1 -n 6 >nul && start %APP_URL%"

REM Run both backend and frontend under concurrently so Ctrl+C kills both
call npx concurrently --kill-others --names "BACKEND,FRONTEND" --prefix-colors "cyan,green" "node local-server.js" "npm run dev -- --port %PORT%"

if %errorlevel% neq 0 (
    echo.
    echo  CADAM stopped.
)
