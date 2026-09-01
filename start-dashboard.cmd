@echo off
setlocal
cd /d "%~dp0"
set "NODE_EXE=node.exe"
if exist "%~dp0runtime\node.exe" (
  set "NODE_EXE=%~dp0runtime\node.exe"
) else (
  where node.exe >nul 2>nul
  if errorlevel 1 (
  echo Node.js 20 or newer is required.
  pause
  exit /b 1
  )
)
powershell.exe -NoProfile -WindowStyle Hidden -Command "Start-Process -WindowStyle Hidden -FilePath '%NODE_EXE%' -ArgumentList 'server.mjs' -WorkingDirectory '%~dp0'"
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:4817"
exit /b 0
