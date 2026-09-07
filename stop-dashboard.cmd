@echo off
setlocal
cd /d "%~dp0"
set "NODE_EXE=node.exe"
if exist "%~dp0runtime\node.exe" set "NODE_EXE=%~dp0runtime\node.exe"
"%NODE_EXE%" scripts\stop-dashboard.mjs
exit /b %errorlevel%
