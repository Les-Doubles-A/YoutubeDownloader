# Installer YouTube Downloader

## Installation en quelques clics

1. Double-cliquez sur `Installer-YouTubeDownloader.bat`.
2. Votre navigateur par defaut s'ouvre. Dans Chrome, ouvrez `chrome://extensions` ; dans Edge, ouvrez `edge://extensions`, puis activez le **Mode developpeur**.
3. Cliquez **Charger l'extension non empaquetee** et choisissez le dossier `extension`.
4. Copiez l'identifiant affiche sous l'extension (32 lettres) et collez-le dans l'assistant.
5. Cliquez **Installer**, puis fermez et rouvrez Chrome ou Edge.

L'assistant copie l'hote Windows et configure Chrome et Edge. Il detecte `yt-dlp.exe` et `ffmpeg.exe` (dossier d'installation, `installer/tools` ou PATH). Si l'un des deux manque, la case **Telecharger automatiquement les outils manquants** (cochee par defaut) les telecharge dans `%LOCALAPPDATA%\YoutubeDownloader\tools` : yt-dlp depuis les releases GitHub officielles, ffmpeg depuis gyan.dev. Les chemins detectes sont enregistres comme valeurs de secours pour l'hote.

L'assistant avertit si le runtime .NET 10 n'est pas detecte (necessaire pour l'hote Windows).

Apres l'installation, le bouton **Tester la configuration** de la page Options de l'extension verifie l'hote, yt-dlp, ffmpeg et le dossier de telechargement.

## Mise a jour de l'extension

Rechargez l'extension depuis `chrome://extensions`, puis actualisez (F5) les onglets YouTube et radiofrance.fr deja ouverts.

## Desinstallation

Lancez `installer/uninstall.bat`, puis retirez l'extension depuis `chrome://extensions`.
