@echo off
dotnet publish "%~dp0YoutubeDownloaderInstaller.csproj" -c Release -r win-x64 --self-contained false -o "%~dp0..\Installer"
