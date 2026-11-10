; Installeur Inno Setup de YoutubeDownloader. Compilation : iscc installer\YoutubeDownloader.iss
; Le setup est cree dans installer\Output\YoutubeDownloader-Setup-1.1.0.exe
#define MyAppName "YoutubeDownloader"
#define MyAppVersion "1.1.0"
#define MyAppURL "https://github.com/Les-Doubles-A/YoutubeDownloader"

[Setup]
AppId={{7895623A-BB7D-58D3-A265-4B23EC19B693}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher=Les-Doubles-A
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}/releases
DefaultDirName={autopf}\{#MyAppName}
DefaultGroupName={#MyAppName}
DisableProgramGroupPage=yes
PrivilegesRequired=lowest
PrivilegesRequiredOverridesAllowed=dialog
OutputDir=Output
OutputBaseFilename={#MyAppName}-Setup-{#MyAppVersion}
Compression=lzma2/ultra64
SolidCompression=yes
WizardStyle=modern
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
CloseApplications=yes
SetupIconFile=..\youtube.ico
UninstallDisplayIcon={app}\youtube.ico

[Languages]
Name: "french"; MessagesFile: "compiler:Languages\French.isl"
Name: "english"; MessagesFile: "compiler:Default.isl"

[Files]
Source: "..\youtube.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\INSTALLATION.md"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\extension\*"; DestDir: "{app}\extension"; Flags: ignoreversion recursesubdirs createallsubdirs
Source: "..\host\bin\Release\net10.0-windows\win-x64\publish\*"; DestDir: "{app}\host\bin\Release\net10.0-windows\win-x64\publish"; Excludes: "*.pdb"; Flags: ignoreversion
Source: "..\installer\*"; DestDir: "{app}\installer"; Excludes: "*.pdb"; Flags: ignoreversion

[Icons]
Name: "{autoprograms}\YouTube Downloader - assistant de configuration"; Filename: "{app}\installer\YoutubeDownloaderInstaller.exe"; IconFilename: "{app}\youtube.ico"
Name: "{autoprograms}\YouTube Downloader - dossier de l'extension"; Filename: "{app}\extension"

[Run]
Filename: "{app}\installer\YoutubeDownloaderInstaller.exe"; Description: "Lancer l'assistant de configuration (extension + hote Windows)"; Flags: nowait postinstall skipifsilent

[UninstallRun]
Filename: "{app}\installer\uninstall.bat"; Flags: runhidden; RunOnceId: "RemoveNativeHost"
