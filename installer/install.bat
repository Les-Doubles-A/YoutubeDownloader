@echo off
setlocal

REM Installation guidee : l'ID est demande si vous ne le fournissez pas.
if "%~1"=="" (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Installer-YouTubeDownloader.ps1"
) else (
    powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Installer-YouTubeDownloader.ps1" -ExtensionId "%~1"
)
exit /b %ERRORLEVEL%
