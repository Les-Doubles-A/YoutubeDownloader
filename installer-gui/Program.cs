using Microsoft.Win32;
using System.Diagnostics;
using System.IO.Compression;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace YoutubeDownloaderInstaller;

internal static class Program
{
    [STAThread]
    private static void Main()
    {
        ApplicationConfiguration.Initialize();
        Application.Run(new InstallerForm());
    }
}

internal sealed class InstallerForm : Form
{
    private const string YtDlpUrl = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe";
    private const string FfmpegZipUrl = "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip";
    private const string RegistryPath = @"Software\YoutubeDownloader";

    private readonly TextBox extensionId = new() { PlaceholderText = "32 lettres affichees sous l'extension" };
    private readonly Label status = new() { AutoSize = false, Height = 42, ForeColor = Color.DimGray };
    private readonly Label toolsInfo = new() { AutoSize = false, Font = new Font("Segoe UI", 9) };
    private readonly CheckBox downloadTools = new() { Text = "Telecharger automatiquement les outils manquants", AutoSize = true, Checked = true };
    private readonly ProgressBar progress = new() { Style = ProgressBarStyle.Marquee, Visible = false, MarqueeAnimationSpeed = 30 };
    private readonly Button installButton = new() {
        Text = "Installer", BackColor = Color.FromArgb(210, 35, 35), ForeColor = Color.White, FlatStyle = FlatStyle.Flat
    };

    private static readonly HttpClient Http = CreateHttpClient();

    public InstallerForm()
    {
        Text = "Installer YouTube Downloader";
        StartPosition = FormStartPosition.CenterScreen;
        FormBorderStyle = FormBorderStyle.FixedDialog;
        MaximizeBox = false;
        ClientSize = new Size(570, 520);
        Icon = new Icon(Path.Combine(GetProjectRoot(), "youtube.ico"));

        var title = new Label {
            Text = "YouTube Downloader", Font = new Font("Segoe UI", 19, FontStyle.Bold),
            Location = new Point(28, 23), AutoSize = true
        };
        var instructions = new Label {
            Text = "1. Ouvrez le navigateur par defaut.\n2. Dans Chrome : chrome://extensions ; dans Edge : edge://extensions.\n3. Activez le mode developpeur, puis chargez le dossier extension.\n4. Copiez l'identifiant affiche et cliquez sur Installer.",
            Location = new Point(31, 72), Size = new Size(510, 95), Font = new Font("Segoe UI", 10)
        };
        var openBrowser = new Button {
            Text = "Ouvrir le navigateur par defaut", Location = new Point(30, 182), Size = new Size(235, 36)
        };
        openBrowser.Click += (_, _) => Process.Start(new ProcessStartInfo("https://www.youtube.com") { UseShellExecute = true });

        var idLabel = new Label { Text = "Identifiant de l'extension", Location = new Point(30, 239), AutoSize = true };
        extensionId.Location = new Point(30, 262);
        extensionId.Size = new Size(510, 27);
        extensionId.CharacterCasing = CharacterCasing.Lower;

        toolsInfo.Location = new Point(30, 305);
        toolsInfo.Size = new Size(510, 62);
        downloadTools.Location = new Point(30, 372);

        progress.Location = new Point(30, 405);
        progress.Size = new Size(510, 14);

        installButton.Location = new Point(385, 440);
        installButton.Size = new Size(155, 42);
        installButton.Click += async (_, _) => await InstallAsync();
        status.Location = new Point(30, 435);
        status.Size = new Size(335, 60);

        Controls.AddRange([title, instructions, openBrowser, idLabel, extensionId, toolsInfo, downloadTools, progress, installButton, status]);

        RefreshToolsInfo();
    }

    private static HttpClient CreateHttpClient()
    {
        var client = new HttpClient { Timeout = TimeSpan.FromMinutes(10) };
        client.DefaultRequestHeaders.UserAgent.ParseAdd("YoutubeDownloaderInstaller/1.1");
        return client;
    }

    private static string InstallDir => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "YoutubeDownloader");
    private static string ToolsDir => Path.Combine(InstallDir, "tools");

    // ------------------------------------------------------------------
    // Detection des outils et du runtime .NET
    // ------------------------------------------------------------------

    private static string? FindTool(string exeName)
    {
        string root = GetProjectRoot();
        string[] candidates = [
            Path.Combine(ToolsDir, exeName),
            Path.Combine(root, "installer", "tools", exeName)
        ];
        foreach (string candidate in candidates) if (File.Exists(candidate)) return candidate;

        string? pathVar = Environment.GetEnvironmentVariable("PATH");
        if (pathVar != null) {
            foreach (string folder in pathVar.Split(Path.PathSeparator)) {
                try {
                    string candidate = Path.Combine(folder.Trim(), exeName);
                    if (File.Exists(candidate)) return candidate;
                }
                catch { /* dossier invalide dans PATH */ }
            }
        }
        return null;
    }

    private static bool IsDotNetRuntimeInstalled()
    {
        try {
            var psi = new ProcessStartInfo("dotnet", "--list-runtimes") {
                RedirectStandardOutput = true, UseShellExecute = false, CreateNoWindow = true
            };
            using var process = Process.Start(psi);
            if (process == null) return false;
            string output = process.StandardOutput.ReadToEnd();
            process.WaitForExit(5000);
            return Regex.IsMatch(output, @"Microsoft\.NETCore\.App 10\.");
        }
        catch {
            return false;
        }
    }

    private void RefreshToolsInfo()
    {
        string? yt = FindTool("yt-dlp.exe");
        string? ff = FindTool("ffmpeg.exe");
        bool dotnet = IsDotNetRuntimeInstalled();

        toolsInfo.Text =
            $"yt-dlp.exe : {(yt ?? "non trouve")}\n" +
            $"ffmpeg.exe : {(ff ?? "non trouve")}\n" +
            (dotnet ? ".NET 10 : detecte" : ".NET 10 : runtime non detecte (https://dotnet.microsoft.com/download/dotnet/10.0/runtime)");
        toolsInfo.ForeColor = (yt != null && ff != null && dotnet) ? Color.FromArgb(30, 120, 60) : Color.DarkOrange;
        downloadTools.Visible = yt == null || ff == null;
    }

    // ------------------------------------------------------------------
    // Telechargement des outils manquants
    // ------------------------------------------------------------------

    private static async Task DownloadFileAsync(string url, string destination)
    {
        using var response = await Http.GetAsync(url, HttpCompletionOption.ResponseHeadersRead);
        response.EnsureSuccessStatusCode();
        await using var source = await response.Content.ReadAsStreamAsync();
        await using var target = new FileStream(destination, FileMode.Create, FileAccess.Write, FileShare.None);
        await source.CopyToAsync(target);
    }

    private async Task EnsureToolsAsync()
    {
        Directory.CreateDirectory(ToolsDir);

        if (FindTool("yt-dlp.exe") == null) {
            status.Text = "Telechargement de yt-dlp...";
            string tmp = Path.Combine(ToolsDir, "yt-dlp.exe.download");
            await DownloadFileAsync(YtDlpUrl, tmp);
            File.Move(tmp, Path.Combine(ToolsDir, "yt-dlp.exe"), true);
        }

        if (FindTool("ffmpeg.exe") == null) {
            status.Text = "Telechargement de ffmpeg (environ 30 Mo)...";
            string zipPath = Path.Combine(Path.GetTempPath(), "ytdl-ffmpeg-" + Guid.NewGuid().ToString("N") + ".zip");
            try {
                await DownloadFileAsync(FfmpegZipUrl, zipPath);
                using ZipArchive zip = ZipFile.OpenRead(zipPath);
                ZipArchiveEntry? entry = zip.Entries.FirstOrDefault(e =>
                    e.FullName.EndsWith("/bin/ffmpeg.exe", StringComparison.OrdinalIgnoreCase));
                if (entry == null) throw new InvalidDataException("ffmpeg.exe est absent de l'archive telechargee.");
                entry.ExtractToFile(Path.Combine(ToolsDir, "ffmpeg.exe"), true);
            }
            finally {
                try { File.Delete(zipPath); } catch { /* nettoyage best-effort */ }
            }
        }
    }

    // ------------------------------------------------------------------
    // Installation
    // ------------------------------------------------------------------

    private async Task InstallAsync()
    {
        string id = extensionId.Text.Trim();
        if (!Regex.IsMatch(id, "^[a-p]{32}$")) {
            MessageBox.Show("L'identifiant doit contenir 32 lettres entre a et p.", Text, MessageBoxButtons.OK, MessageBoxIcon.Warning);
            return;
        }

        installButton.Enabled = false;
        status.ForeColor = Color.DimGray;
        try {
            string root = GetProjectRoot();
            string source = Path.Combine(root, "host", "bin", "Release", "net10.0-windows", "win-x64", "publish");
            string hostExe = Path.Combine(source, "DownloaderHost.exe");
            if (!File.Exists(hostExe)) throw new FileNotFoundException("L'hote Windows compile est introuvable.", hostExe);

            if (downloadTools.Visible && downloadTools.Checked) {
                progress.Visible = true;
                await EnsureToolsAsync();
            }

            status.Text = "Copie de l'hote...";
            string hostDir = Path.Combine(InstallDir, "host");
            Directory.CreateDirectory(hostDir);
            foreach (string file in Directory.GetFiles(source)) File.Copy(file, Path.Combine(hostDir, Path.GetFileName(file)), true);

            string manifestPath = Path.Combine(hostDir, "native-host.json");
            var manifest = new {
                name = "com.youtube.downloader", description = "YouTube Downloader Native Host",
                path = Path.Combine(hostDir, "DownloaderHost.exe"), type = "stdio",
                allowed_origins = new[] { $"chrome-extension://{id}/" }
            };
            File.WriteAllText(manifestPath, JsonSerializer.Serialize(manifest, new JsonSerializerOptions { WriteIndented = true }));
            SetNativeHostKey(@"Software\Google\Chrome\NativeMessagingHosts\com.youtube.downloader", manifestPath);
            SetNativeHostKey(@"Software\Microsoft\Edge\NativeMessagingHosts\com.youtube.downloader", manifestPath);

            // Chemins de repli lus par l'hote quand les options de l'extension sont vides.
            string? yt = FindTool("yt-dlp.exe");
            string? ff = FindTool("ffmpeg.exe");
            using (RegistryKey key = Registry.CurrentUser.CreateSubKey(RegistryPath)) {
                if (yt != null) key.SetValue("YtDlpPath", yt, RegistryValueKind.String);
                if (ff != null) key.SetValue("FfmpegPath", ff, RegistryValueKind.String);
            }

            RefreshToolsInfo();
            status.ForeColor = Color.FromArgb(30, 120, 60);
            status.Text = "Installation terminee. Fermez puis rouvrez votre navigateur.";
            MessageBox.Show("Installation terminee. Redemarrez Chrome ou Edge pour utiliser l'extension.", Text, MessageBoxButtons.OK, MessageBoxIcon.Information);
        }
        catch (Exception ex) {
            status.ForeColor = Color.Firebrick;
            status.Text = "L'installation a echoue.";
            MessageBox.Show(ex.Message, Text, MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
        finally {
            progress.Visible = false;
            installButton.Enabled = true;
        }
    }

    private static void SetNativeHostKey(string keyPath, string manifestPath)
    {
        using RegistryKey key = Registry.CurrentUser.CreateSubKey(keyPath);
        key.SetValue(null, manifestPath, RegistryValueKind.String);
    }

    private static string GetProjectRoot()
    {
        DirectoryInfo? dir = new(AppContext.BaseDirectory);
        while (dir != null) {
            if (Directory.Exists(Path.Combine(dir.FullName, "host")) && Directory.Exists(Path.Combine(dir.FullName, "extension"))) return dir.FullName;
            dir = dir.Parent;
        }
        throw new DirectoryNotFoundException("Le dossier YoutubeDownloader est introuvable.");
    }
}
