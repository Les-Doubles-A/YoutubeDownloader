[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [ValidatePattern('^[a-p]{32}$')]
    [string]$ExtensionId,
    [string]$YtDlpPath,
    [string]$FfmpegPath
)

$ErrorActionPreference = 'Stop'
$extensionDir = Split-Path -Parent $PSScriptRoot
$publishDir = Join-Path $extensionDir 'host\bin\Release\net10.0-windows\win-x64\publish'
$hostExe = Join-Path $publishDir 'DownloaderHost.exe'
$installDir = Join-Path $env:LOCALAPPDATA 'YoutubeDownloader'
$hostDir = Join-Path $installDir 'host'
$toolsDir = Join-Path $installDir 'tools'

function Find-Tool([string]$name) {
    $command = Get-Command $name -ErrorAction SilentlyContinue
    if ($command) { return $command.Source }
    $bundled = Join-Path $PSScriptRoot ("tools\" + $name)
    if (Test-Path -LiteralPath $bundled) { return $bundled }
    return ''
}

function Read-ExistingFile([string]$label, [string]$value) {
    if ($value -and (Test-Path -LiteralPath $value -PathType Leaf)) { return (Resolve-Path -LiteralPath $value).Path }
    if ($value) { Write-Warning "$label n'a pas ete trouve : $value" }
    return ''
}

Write-Host ''
Write-Host '============================================================' -ForegroundColor Red
Write-Host '       Assistant d''installation YouTube Downloader'
Write-Host '============================================================' -ForegroundColor Red
Write-Host ''

if (-not (Test-Path -LiteralPath $hostExe -PathType Leaf)) {
    throw "L'hote Windows compile est introuvable : $hostExe"
}

$dotnet = Get-Command dotnet -ErrorAction SilentlyContinue
if (-not $dotnet) {
    Write-Warning 'Le runtime .NET 10 n''a pas ete detecte. Installez le runtime .NET Desktop 10 avant d''utiliser l''extension.'
    Write-Host 'Lien : https://dotnet.microsoft.com/download/dotnet/10.0/runtime'
}

if (-not $ExtensionId) {
    Write-Host '1. Votre navigateur par defaut va s''ouvrir.'
    Write-Host '2. Dans Chrome, ouvrez chrome://extensions ; dans Edge, ouvrez edge://extensions.'
    Write-Host '3. Activez le Mode developpeur, puis cliquez sur Charger l''extension non empaquetee.'
    Write-Host "4. Selectionnez ce dossier : $extensionDir\extension"
    Write-Host '5. Copiez l''ID affiche sous YouTube Downloader et collez-le ci-dessous.'
    Write-Host ''
    Start-Process 'https://www.youtube.com'
    do {
        $ExtensionId = (Read-Host 'ID de l''extension (32 lettres)').Trim().ToLowerInvariant()
        if ($ExtensionId -notmatch '^[a-p]{32}$') {
            Write-Warning 'ID invalide. Chrome affiche exactement 32 lettres entre a et p.'
        }
    } until ($ExtensionId -match '^[a-p]{32}$')
}

$YtDlpPath = Read-ExistingFile 'yt-dlp.exe' $YtDlpPath
if (-not $YtDlpPath) { $YtDlpPath = Find-Tool 'yt-dlp.exe' }
$FfmpegPath = Read-ExistingFile 'ffmpeg.exe' $FfmpegPath
if (-not $FfmpegPath) { $FfmpegPath = Find-Tool 'ffmpeg.exe' }

if (-not $YtDlpPath) { Write-Warning 'yt-dlp.exe n''a pas ete detecte. Vous pourrez indiquer son chemin dans les options de l''extension.' }
if (-not $FfmpegPath) { Write-Warning 'ffmpeg.exe n''a pas ete detecte. Vous pourrez indiquer son chemin dans les options de l''extension.' }

if ($PSCmdlet.ShouldProcess($installDir, 'Installer l''hote Windows')) {
    New-Item -ItemType Directory -Force -Path $hostDir, $toolsDir | Out-Null
    Copy-Item -Path (Join-Path $publishDir '*') -Destination $hostDir -Recurse -Force

    $nativeManifest = [ordered]@{
        name = 'com.youtube.downloader'
        description = 'YouTube Downloader Native Host'
        path = (Join-Path $hostDir 'DownloaderHost.exe')
        type = 'stdio'
        allowed_origins = @("chrome-extension://$ExtensionId/")
    }
    $manifestPath = Join-Path $hostDir 'native-host.json'
    $nativeManifest | ConvertTo-Json | Set-Content -LiteralPath $manifestPath -Encoding UTF8

    $chromeKey = 'HKCU:\Software\Google\Chrome\NativeMessagingHosts\com.youtube.downloader'
    $edgeKey = 'HKCU:\Software\Microsoft\Edge\NativeMessagingHosts\com.youtube.downloader'
    New-Item -Force -Path $chromeKey, $edgeKey | Out-Null
    Set-ItemProperty -Path $chromeKey, $edgeKey -Name '(default)' -Value $manifestPath

    $settingsKey = 'HKCU:\Software\YoutubeDownloader'
    New-Item -Force -Path $settingsKey | Out-Null
    if ($YtDlpPath) { Set-ItemProperty -Path $settingsKey -Name 'YtDlpPath' -Value $YtDlpPath }
    if ($FfmpegPath) { Set-ItemProperty -Path $settingsKey -Name 'FfmpegPath' -Value $FfmpegPath }
    Set-ItemProperty -Path $settingsKey -Name 'DownloadFolder' -Value (Join-Path ([Environment]::GetFolderPath('UserProfile')) 'Downloads\YoutubeDownloader')
}

Write-Host ''
Write-Host 'Installation terminee.' -ForegroundColor Green
Write-Host 'Fermez puis rouvrez Chrome ou Edge. Ouvrez ensuite une video YouTube pour utiliser le bouton Telecharger.'
if (-not $YtDlpPath -or -not $FfmpegPath) {
    Write-Host 'Pensez a renseigner les executables manquants dans les Options de l''extension.' -ForegroundColor Yellow
}
