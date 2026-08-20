@echo off
setlocal
set "SCRIPT_DIR=%~dp0"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT_DIR%stop-fgr.ps1"
if errorlevel 1 (
  echo.
  echo FGR serveri nisu potpuno zaustavljeni. Pogledaj poruku iznad.
  pause
  exit /b 1
)

exit /b 0
