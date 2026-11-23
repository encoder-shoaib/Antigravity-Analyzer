@echo off
title Antigravity Task Monitor and Auto-Shutdown Supervisor
cd /d "%~dp0"

echo =============================================================
echo    Google Antigravity AI Task Completion and Auto-Shutdown
echo                  Safe Guarded Supervisor
echo =============================================================
echo.
echo Starting Antigravity Supervisor on port 4321...
echo.

:: Launch dashboard in default browser after 1 second delay
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://localhost:4321"

:: Start the supervisor engine
node index.js

if %errorlevel% neq 0 (
  echo.
  echo [ERROR] Supervisor exited with code %errorlevel%.
  pause
)
