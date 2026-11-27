@echo off
title P14 - Load-Aware Exam Submission System
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is not installed.
  echo  Install the LTS version from https://nodejs.org and then double-click this file again.
  echo.
  pause
  exit /b 1
)

rem Install dependencies on first run (or repair a half-finished install)
if not exist "node_modules\.package-lock.json" (
  echo Installing dependencies, this takes a minute on first run...
  if exist node_modules rmdir /s /q node_modules
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

if not exist ".env" copy ".env.example" ".env" >nul

rem Open the browser a few seconds after the server starts
start "" /b cmd /c "timeout /t 12 >nul & start http://localhost:3000"

call npm run demo
pause
