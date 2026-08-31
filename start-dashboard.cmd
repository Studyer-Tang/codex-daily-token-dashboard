@echo off
setlocal
cd /d "%~dp0"
where node.exe >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required.
  pause
  exit /b 1
)
powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Process -WindowStyle Hidden -FilePath 'node.exe' -ArgumentList 'server.mjs' -WorkingDirectory '%~dp0'"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:4817"
exit /b 0
