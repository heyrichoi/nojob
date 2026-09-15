@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo [1/2] Dependencies check...
if not exist node_modules (
  npm.cmd install
  if errorlevel 1 goto :fail
)
echo [2/2] Starting server...
npm.cmd start
goto :eof
:fail
echo.
echo Failed to install dependencies.
pause
