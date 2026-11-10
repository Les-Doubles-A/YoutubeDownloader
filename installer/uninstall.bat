@echo off
setlocal EnableDelayedExpansion

echo ============================================================
echo   Desinstallation de YouTube Downloader Native Host
echo ============================================================
echo.

set "INSTALL_DIR=%LOCALAPPDATA%\YoutubeDownloader"

echo Suppression des cles de registre ...
reg delete "HKCU\Software\Google\Chrome\NativeMessagingHosts\com.youtube.downloader" /f >nul 2>&1
reg delete "HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.youtube.downloader" /f >nul 2>&1
reg delete "HKCU\Software\YoutubeDownloader" /f >nul 2>&1

if exist "%INSTALL_DIR%" (
    echo Suppression des fichiers installes dans %INSTALL_DIR% ...
    rmdir /S /Q "%INSTALL_DIR%"
)

echo.
echo ============================================================
echo   Desinstallation terminee.
echo   Vous pouvez desormais retirer l'extension depuis
echo   chrome://extensions si vous le souhaitez.
echo ============================================================
echo.

endlocal
exit /b 0
