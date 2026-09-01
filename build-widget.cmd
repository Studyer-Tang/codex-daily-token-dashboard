@echo off
setlocal
cd /d "%~dp0"

if exist "CodexTokenWidget.exe" del /q "CodexTokenWidget.exe"
powershell.exe -NoProfile -Command "Add-Type -Path @('.\Widget.cs','widget\Widget.Models.cs','widget\Widget.Search.cs') -ReferencedAssemblies 'System.Windows.Forms','System.Drawing','System.Web.Extensions' -OutputAssembly '.\CodexTokenWidget.exe' -OutputType WindowsApplication"
if errorlevel 1 exit /b 1

echo Built %~dp0CodexTokenWidget.exe
exit /b 0
