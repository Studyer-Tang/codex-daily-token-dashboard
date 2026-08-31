@echo off
setlocal
for /f "tokens=5" %%P in ('netstat -ano ^| findstr "127.0.0.1:4817" ^| findstr "LISTENING"') do taskkill /PID %%P /F >nul 2>nul
echo Codex Token dashboard stopped.
timeout /t 2 /nobreak >nul
