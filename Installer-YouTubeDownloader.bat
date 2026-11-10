@echo off
setlocal

REM Lance l'interface graphique si elle a ete compilee.
if exist "%~dp0Installer\YoutubeDownloaderInstaller.exe" (
    start "" "%~dp0Installer\YoutubeDownloaderInstaller.exe"
    exit /b 0
)

REM Solution de secours sans interface graphique.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0installer\Installer-YouTubeDownloader.ps1"
set "RESULT=%ERRORLEVEL%"

echo.
if not "%RESULT%"=="0" echo L'installation n'a pas ete terminee. Relancez ce fichier lorsque vous serez pret.
pause
exit /b %RESULT%
