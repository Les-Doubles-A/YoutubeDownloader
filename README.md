Dépôt GitHub : **https://github.com/Les-Doubles-A/YoutubeDownloader**

﻿# YouTube Downloader - Extension Chrome/Edge + Hote natif Windows

Extension Manifest V3 qui ajoute un bouton **Telecharger** sur YouTube (videos, Shorts, playlists)
et sur les podcasts radiofrance.fr, couplee a une application Windows (Native Messaging) ecrite
en C# .NET 10 qui pilote `yt-dlp.exe` et `ffmpeg.exe`. Aucun serveur : tout fonctionne en local.

## Arborescence

```
YoutubeDownloader/
├── extension/               Extension Chrome/Edge (Manifest V3)
│   ├── manifest.json
│   ├── background.js        Service worker : relais Native Messaging, file d'attente, annulation, historique
│   ├── content.js           Bouton + menu sur youtube.com (watch, shorts, playlist)
│   ├── content-radiofrance.js  Bouton + extraction des metadonnees sur radiofrance.fr
│   ├── content-radiofrance-batch.js  Telechargement par lot depuis une page emission
│   ├── popup.html/js        Popup : historique, progression, annuler / relancer / afficher le fichier
│   ├── options.html/js      Configuration, test de configuration, selecteur de dossier
│   └── style.css
├── host/                    Hote natif C# (.NET 10)
│   ├── Program.cs           Boucle Native Messaging (download, cancel, testConfig, pickFolder, revealPath)
│   ├── NativeHost.cs        Lecture/ecriture du protocole stdio
│   ├── Downloader.cs        Appels yt-dlp / ffmpeg, telechargement direct, progression, annulation
│   └── Registry.cs          Parametres de secours dans le registre Windows
├── installer-gui/           Assistant d'installation WinForms (voir INSTALLATION.md)
└── installer/               Scripts .bat / .ps1 d'installation et de desinstallation
```

## Prerequis

- Windows 10/11
- Runtime .NET 10 (le SDK .NET 10 pour compiler)
- Chrome ou Edge Chromium a jour
- `yt-dlp.exe` et `ffmpeg.exe` : l'assistant d'installation peut les telecharger automatiquement,
  sinon renseignez leurs chemins dans les options.

## Installation rapide

Voir `INSTALLATION.md` (assistant graphique). Pour une installation manuelle :

1. Compiler l'hote : `cd host && dotnet publish -c Release -r win-x64 --self-contained false`
   (sortie dans `host\bin\Release\net10.0-windows\win-x64\publish`).
2. `chrome://extensions` > Mode developpeur > Charger l'extension non empaquetee > dossier `extension/`.
3. Copier l'ID de l'extension, puis lancer `installer\install.bat <ID>`.
4. Redemarrer le navigateur.

## Utilisation

### YouTube

Le bouton **Telecharger** apparait sous la video. Sur les Shorts et les pages de playlist
(`/playlist?list=...`), il est flottant en bas a droite. Le menu propose uniquement les qualites
reellement disponibles :

- **Video** : meilleure qualite, 4320p a 360p (fusion automatique via FFmpeg)
- **Audio** : MP3, M4A, FLAC, WAV
- **Autres** : video sans audio, video + audio/sous-titres, sous-titres, miniature, description
- **Playlist** (si applicable) : video actuelle, playlist entiere, a partir d'ici
- **Infos complementaires** : cover, titre, artiste, album, description et chapitres integres au fichier

### Chaine YouTube complete

Sur une page de chaine (`/@nom`, `/channel/...`, `/c/...`, `/user/...`), un bouton flottant ouvre un
menu pour telecharger toutes les videos (ou les Shorts, ou les directs termines) en video ou en
audio, avec une limite optionnelle de nombre. Les fichiers sont ranges dans un dossier au nom de
la chaine, la progression est globale ("Video 12/340") et un fichier d'archive `.archive-*.txt`
dans le dossier de telechargement permet de relancer sans retelecharger ce qui existe deja.
Le telechargement en un clic est ignore sur ces pages. Pour tout retelecharger, supprimez le
fichier d'archive correspondant.

### Radio France

Sur une page podcast radiofrance.fr, le bouton telecharge l'episode directement (sans yt-dlp) avec
tags, cover, description et chapitres.

Sur une page emission (`/<chaine>/podcasts/<emission>`), le bouton **Telecharger plusieurs episodes**
lit le flux RSS public declare dans la page (via le service worker) et affiche la liste des
episodes avec filtre, selection multiple et "10 derniers". Les episodes choisis (100 max par lot)
rejoignent la file d'attente, avec les memes tags que le telechargement unitaire (sans chapitres).

### Telechargement en un clic

Dans les options, activez le telechargement automatique : le bouton lance directement la video a la
qualite preferee, sans afficher le menu.

### File d'attente, annulation, historique

- Nombre de telechargements simultanes reglable (1 a 4) ; les suivants attendent dans la file.
  Le badge de l'icone affiche le nombre de telechargements actifs ou en attente.
- Bouton **Annuler** dans le menu et dans le popup (le processus yt-dlp/ffmpeg est arrete).
- Le popup affiche la progression de chaque telechargement et la progression globale, avec
  **Afficher dans le dossier** et **Relancer** (erreur ou annulation). Les 100 derniers sont conserves.

### Options

Dossier (avec selecteur), chemins de yt-dlp/ffmpeg, bouton **Tester la configuration**, formats et
qualite par defaut, modele de nommage, cookies du navigateur, mise a jour automatique de yt-dlp
(au plus une fois par 24 h), langues et format des sous-titres (SRT/VTT), telechargements simultanes, SponsorBlock (retirer ou marquer en chapitres les segments sponsor, intro, outro, etc. via yt-dlp).

## Desinstallation

```bat
cd installer
uninstall.bat
```

Puis retirez l'extension depuis `chrome://extensions`.

## Gestion des erreurs

L'hote traduit les erreurs courantes de yt-dlp : outils introuvables, video privee ou supprimee,
erreur reseau, quota depasse, refus 403 (yt-dlp perime ou cookies manquants).

## Limites connues

- Les selecteurs de `content-radiofrance.js` dependent du DOM de radiofrance.fr et peuvent casser
  si le site change.
- Un telechargement de chaine tres long peut etre limite par YouTube (erreurs 429/403) : utilisez les
  cookies du navigateur et gardez yt-dlp a jour.
- Le lot Radio France depend du flux RSS de l'emission : seuls les episodes presents dans le flux
  sont proposes.

## Notes techniques

- Communication 100 % locale via Chrome Native Messaging (stdio, prefixe de longueur sur 4 octets).
- Aucune dependance externe cote extension, aucune police ni ressource chargee depuis Internet.
- Chaque telechargement ouvre sa propre connexion avec l'hote ; fermer la connexion arrete le processus.
- L'ID d'une extension non empaquetee depend de la machine : l'installation regenere
  `native-host.json` avec le bon `allowed_origins`.

<!-- installeur-release -->
## Installation

Téléchargez **`YoutubeDownloader-Setup-1.1.0.exe`** depuis la [dernière release](https://github.com/Les-Doubles-A/YoutubeDownloader/releases/latest), puis lancez-le.

Prérequis : runtime **.NET 10** (pour l'hôte Windows). À la fin, l'installeur lance l'assistant de configuration (chargement de l'extension, identifiant, enregistrement de l'hôte pour Chrome et Edge) décrit dans `INSTALLATION.md`.

L'installeur n'est pas signé : si Windows SmartScreen l'affiche, cliquez sur « Informations complémentaires » puis « Exécuter quand même ».

### Recréer l'installeur

Compiler l'application (`dotnet publish (host + installer-gui)`), puis lancer [Inno Setup 6](https://jrsoftware.org/isinfo.php) : `iscc installer\YoutubeDownloader.iss`. Le setup est créé dans `installer\Output\`.
