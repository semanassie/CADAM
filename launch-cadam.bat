@echo off
REM ─────────────────────────────────────────────────────────────
REM  CADAM Local Development Launcher
REM  Starts the mock backend (local-server.js) and Vite dev server.
REM ─────────────────────────────────────────────────────────────

echo.
echo  === CADAM Local Dev Launcher ===
echo.

REM Kill any orphaned processes on ports 3004 and 54321
echo [1/4] Cleaning up orphaned processes...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3004 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :54321 ^| findstr LISTENING') do taskkill /F /PID %%a >nul 2>&1

REM Start the local mock server in the background
echo [2/4] Starting local mock server on port 54321...
start /B "CADAM-MockServer" cmd /c "node local-server.js"

REM Wait for the server to initialise
echo [3/4] Waiting for mock server to start...
timeout /T 5 /NOBREAK >nul

REM Open browser
echo [4/4] Opening browser and starting Vite dev server...
start http://localhost:3004/cadam

REM Start Vite (foreground so you can see logs)
npm run dev -- --port 3004
