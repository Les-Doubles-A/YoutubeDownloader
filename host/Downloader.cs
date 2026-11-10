using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading.Tasks;

namespace DownloaderHost
{
    /// <summary>
    /// Représente une demande de téléchargement transmise par l'extension.
    /// </summary>
    public class DownloadRequest
    {
        public string RequestId { get; set; } = "";
        public string Url { get; set; } = "";
        public string Title { get; set; } = "";
        public string DownloadType { get; set; } = "video"; // video | audio | subtitle | thumbnail | description
        public string Quality { get; set; } = "best";
        public string VideoFormat { get; set; } = "mp4";
        public string AudioFormat { get; set; } = "mp3";
        public string OutputDir { get; set; } = "";
        public string YtDlpPath { get; set; } = "";
        public string FfmpegPath { get; set; } = "";
        public string FilenameTemplate { get; set; } = "%(title)s.%(ext)s";
        public string PlaylistMode { get; set; } = "single";

        /// <summary>Téléchargement de toute une chaîne : active l'archive de reprise.</summary>
        public bool ChannelMode { get; set; } = false;

        /// <summary>Nombre maximal d'éléments d'une playlist/chaîne (0 = tous).</summary>
        public int PlaylistEnd { get; set; } = 0;

        /// <summary>
        /// Nom du navigateur dont utiliser les cookies pour l'authentification auprès de
        /// YouTube ("chrome", "edge", "firefox", "brave"...), ou "none"/vide pour ne pas en
        /// utiliser. Voir --cookies-from-browser dans la doc yt-dlp.
        /// </summary>
        public string CookiesFromBrowser { get; set; } = ""; // single | full | fromCurrent

        /// <summary>
        /// Si vrai, télécharge et embarque les infos complémentaires (miniature, titre, auteur,
        /// description, chapitres) en plus du fichier principal. Disponible pour vidéo ET audio.
        /// </summary>
        public bool IncludeMetadata { get; set; } = false;

        /// <summary>Langues de sous-titres à récupérer (ex. "fr,en"), ou "all" (défaut).</summary>
        public string SubtitleLangs { get; set; } = "all";

        /// <summary>SponsorBlock : "off", "remove" (coupe) ou "mark" (chapitres).</summary>
        public string SponsorBlockMode { get; set; } = "off";

        /// <summary>Catégories SponsorBlock séparées par des virgules (validées côté hôte).</summary>
        public string SponsorBlockCategories { get; set; } = "";

        /// <summary>Format de conversion des sous-titres ("srt", "vtt"), ou vide pour garder l'original.</summary>
        public string SubtitleFormat { get; set; } = "";

        // ------------------------------------------------------------------
        // Téléchargement direct (sites de radio/podcast avec fichier audio public,
        // sans passer par yt-dlp : ex. radiofrance.fr / France Culture).
        // Renseigné uniquement quand DirectMediaUrl n'est pas vide.
        // ------------------------------------------------------------------
        public string DirectMediaUrl { get; set; } = "";
        public string DirectAuthor { get; set; } = "";

        // BUG CORRIGÉ : cette valeur était figée en dur sur "France Culture", exactement le
        // même type de bug déjà corrigé côté extension (content-radiofrance.js /
        // siteBrandName()) pour le fallback d'auteur/marque : ça produisait un tag "album"
        // erroné sur tous les épisodes qui ne sont pas France Culture (franceinfo, France
        // Inter, France Musique...). L'extension calcule déjà dynamiquement le bon nom de
        // chaîne et l'envoie dans directAlbum ; côté hôte on ne doit plus jamais deviner une
        // chaîne particulière.
        public string DirectAlbum { get; set; } = "";
        public string DirectCoverUrl { get; set; } = "";
        public string DirectDescription { get; set; } = "";

        /// <summary>Catégorie/thème de l'épisode (ex. "Sciences et Savoirs"), ajoutée comme tag "genre".</summary>
        public string DirectGenre { get; set; } = "";

        /// <summary>Liste de chapitres [{ "title": "...", "startSeconds": 12.3 }, ...] au format JSON.</summary>
        public string DirectChaptersJson { get; set; } = "";
    }

    /// <summary>Chapitre d'un épisode audio (podcast/radio), utilisé pour le téléchargement direct.</summary>
    public class AudioChapter
    {
        public string Title { get; set; } = "";
        public double StartSeconds { get; set; }
    }

    /// <summary>
    /// Résultat de l'analyse d'une vidéo via "yt-dlp -J".
    /// </summary>
    public class FormatsResult
    {
        public string Title { get; set; } = "";
        public bool IsPlaylist { get; set; }
        public List<int> AvailableHeights { get; set; } = new List<int>();
    }

    /// <summary>
    /// Encapsule tous les appels vers yt-dlp.exe et ffmpeg.exe.
    /// Responsabilité unique : exécuter des process externes et interpréter leur sortie.
    /// </summary>
    public static class Downloader
    {
        private static readonly Regex ProgressRegex = new Regex(
            @"\[download\]\s+(?<percent>[\d.]+)%",
            RegexOptions.Compiled);

        private static readonly Regex ErrorRegex = new Regex(
            @"ERROR:\s*(?<msg>.+)",
            RegexOptions.Compiled);

        private static readonly Regex DestinationRegex = new Regex(
            @"Destination:\s*(.+)$",
            RegexOptions.Compiled);

        private static readonly Regex MergedRegex = new Regex(
            @"\[Merger\]\s+Merging formats into\s+""(?<file>.+)""",
            RegexOptions.Compiled);

        private static readonly Regex PlaylistParamRegex = new Regex(
            @"[?&]list=([^&]+)",
            RegexOptions.Compiled);

        private static readonly Regex PlaylistIndexRegex = new Regex(
            @"[?&]index=(\d+)",
            RegexOptions.Compiled);

        private static readonly Regex PlaylistItemRegex = new Regex(
            @"Downloading (?:item|video) (?<cur>\d+) of (?<total>\d+)",
            RegexOptions.Compiled);

        private static readonly int[] ProgressBreakpoints = { 0, 10, 30, 60, 90, 100 };

        // ------------------------------------------------------------------
        // Mise à jour automatique de yt-dlp
        // ------------------------------------------------------------------
        // YouTube modifie très régulièrement ses protections anti-bot (signature, PO token...),
        // ce qui rend une version de yt-dlp vieille de quelques semaines sujette à des échecs
        // "HTTP Error 403: Forbidden" même avec des cookies valides. On lance donc "yt-dlp -U"
        // automatiquement avant un téléchargement YouTube, au maximum une fois toutes les 24h
        // (throttle basé sur un horodatage stocké dans le registre) pour ne pas ajouter de
        // latence à chaque clic. La mise à jour est toujours "best effort" : si elle échoue
        // (hors-ligne, permissions, etc.), on ne bloque JAMAIS le téléchargement pour autant.
        private static readonly TimeSpan AutoUpdateInterval = TimeSpan.FromHours(24);
        private const string AutoUpdateRegistryKey = "YtDlpLastUpdateCheckUtc";

        public static async Task MaybeAutoUpdateYtDlpAsync(string ytDlpPath, bool enabled, Action<int, string> onProgress)
        {
            if (!enabled || !File.Exists(ytDlpPath))
            {
                return;
            }

            string? lastCheckRaw = Registry.GetValue(AutoUpdateRegistryKey);
            if (DateTime.TryParse(
                    lastCheckRaw,
                    System.Globalization.CultureInfo.InvariantCulture,
                    System.Globalization.DateTimeStyles.RoundtripKind,
                    out DateTime lastCheck)
                && DateTime.UtcNow - lastCheck < AutoUpdateInterval)
            {
                return; // vérifié récemment, on ne relance pas la vérification à chaque téléchargement
            }

            onProgress?.Invoke(0, "Vérification des mises à jour de yt-dlp");

            try
            {
                var psi = CreateProcessInfo(ytDlpPath, utf8Output: true);
                psi.ArgumentList.Add("-U");

                using var process = new Process { StartInfo = psi };
                StartWithoutStdin(process);
                await process.WaitForExitAsync();
                // Le code de sortie n'est volontairement pas vérifié : "déjà à jour",
                // "mis à jour avec succès" et "échec réseau" doivent tous les trois laisser
                // le téléchargement continuer normalement juste après.
            }
            catch
            {
                // yt-dlp -U indisponible/échoué (hors-ligne, permissions, exécutable verrouillé
                // pendant sa propre mise à jour...) : on continue sans bloquer.
            }
            finally
            {
                Registry.SetValue(
                    AutoUpdateRegistryKey,
                    DateTime.UtcNow.ToString("o", System.Globalization.CultureInfo.InvariantCulture));
            }
        }

        private static readonly Regex SubtitleLangsRegex = new Regex(@"^[A-Za-z0-9,.*_\-]+$", RegexOptions.Compiled);

        /// <summary>Évite d'injecter une valeur arbitraire dans --sub-langs.</summary>
        private static string SanitizeSubtitleLangs(string langs)
        {
            string trimmed = (langs ?? "").Trim().Replace(" ", "");
            return trimmed.Length > 0 && SubtitleLangsRegex.IsMatch(trimmed) ? trimmed : "all";
        }

        private static CancellationTokenRegistration RegisterKill(Process process, CancellationToken ct)
        {
            return ct.Register(() =>
            {
                try
                {
                    if (!process.HasExited) process.Kill(entireProcessTree: true);
                }
                catch
                {
                    // process déjà terminé
                }
            });
        }

        // ------------------------------------------------------------------
        // Utilitaires appelés depuis les options de l'extension
        // ------------------------------------------------------------------

        /// <summary>Lance "tool args" et renvoie la première ligne de sortie (version), ou null.</summary>
        public static async Task<string?> GetToolVersionAsync(string path, params string[] args)
        {
            if (!File.Exists(path)) return null;
            try
            {
                var psi = CreateProcessInfo(path, utf8Output: true);
                foreach (string a in args) psi.ArgumentList.Add(a);
                using var process = new Process { StartInfo = psi };
                StartWithoutStdin(process);
                Task<string> outTask = process.StandardOutput.ReadToEndAsync();
                _ = process.StandardError.ReadToEndAsync();
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
                try { await process.WaitForExitAsync(cts.Token); }
                catch (OperationCanceledException) { try { process.Kill(true); } catch { } return null; }
                string output = await outTask;
                string? first = output.Split('\n').Select(l => l.Trim()).FirstOrDefault(l => l.Length > 0);
                return process.ExitCode == 0 ? first : null;
            }
            catch
            {
                return null;
            }
        }

        /// <summary>Affiche un fichier dans l'Explorateur (ou ouvre le dossier s'il s'agit d'un dossier).</summary>
        public static bool RevealPath(string path)
        {
            try
            {
                var psi = new ProcessStartInfo("explorer.exe") { UseShellExecute = false };
                if (File.Exists(path))
                {
                    psi.ArgumentList.Add("/select," + path);
                }
                else if (Directory.Exists(path))
                {
                    psi.ArgumentList.Add(path);
                }
                else
                {
                    return false;
                }
                Process.Start(psi);
                return true;
            }
            catch
            {
                return false;
            }
        }

        /// <summary>Ouvre un sélecteur de dossier Windows (via PowerShell) et renvoie le chemin choisi, ou null.</summary>
        public static async Task<string?> PickFolderAsync()
        {
            const string script =
                "[Console]::OutputEncoding=[System.Text.Encoding]::UTF8;" +
                "Add-Type -AssemblyName System.Windows.Forms;" +
                "$d=New-Object System.Windows.Forms.FolderBrowserDialog;" +
                "$d.Description='Dossier de telechargement';" +
                "$f=New-Object System.Windows.Forms.Form;$f.TopMost=$true;" +
                "if($d.ShowDialog($f) -eq 'OK'){$d.SelectedPath}";
            try
            {
                var psi = CreateProcessInfo("powershell.exe", utf8Output: true);
                psi.ArgumentList.Add("-NoProfile");
                psi.ArgumentList.Add("-STA");
                psi.ArgumentList.Add("-Command");
                psi.ArgumentList.Add(script);
                using var process = new Process { StartInfo = psi };
                StartWithoutStdin(process);
                string output = await process.StandardOutput.ReadToEndAsync();
                await process.WaitForExitAsync();
                string result = output.Trim();
                return result.Length > 0 ? result : null;
            }
            catch
            {
                return null;
            }
        }

        /// <summary>Démarre le processus puis ferme aussitôt son stdin (EOF immédiat pour l'enfant).</summary>
        private static void StartWithoutStdin(Process process)
        {
            process.Start();
            try { process.StandardInput.Close(); } catch { /* déjà fermé */ }
        }

        private static ProcessStartInfo CreateProcessInfo(string fileName, bool utf8Output)
        {
            var psi = new ProcessStartInfo
            {
                FileName = fileName,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                // Sans redirection, le processus enfant hérite du stdin de Chrome (tuyau synchrone
                // sur lequel la boucle principale est bloquée en lecture pendant un
                // téléchargement) et peut se figer dès son initialisation : progression à 0 %.
                RedirectStandardInput = true,
                UseShellExecute = false,
                CreateNoWindow = true
            };
            if (utf8Output)
            {
                psi.StandardOutputEncoding = Encoding.UTF8;
                psi.StandardErrorEncoding = Encoding.UTF8;
            }
            return psi;
        }

        // ------------------------------------------------------------------
        // Résolution des chemins
        // ------------------------------------------------------------------

        public static string ResolveYtDlpPath(string configured)
        {
            if (!string.IsNullOrWhiteSpace(configured) && File.Exists(configured))
            {
                return configured;
            }

            string? fromRegistry = Registry.GetValue("YtDlpPath");
            if (!string.IsNullOrWhiteSpace(fromRegistry) && File.Exists(fromRegistry))
            {
                return fromRegistry!;
            }

            string? fromPath = FindOnPath("yt-dlp.exe") ?? FindOnPath("yt-dlp");
            if (fromPath != null)
            {
                return fromPath;
            }

            // Emplacement par défaut créé lors de l'installation.
            string defaultPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "YoutubeDownloader", "tools", "yt-dlp.exe");
            return defaultPath;
        }

        public static string ResolveFfmpegPath(string configured)
        {
            if (!string.IsNullOrWhiteSpace(configured) && File.Exists(configured))
            {
                return configured;
            }

            string? fromRegistry = Registry.GetValue("FfmpegPath");
            if (!string.IsNullOrWhiteSpace(fromRegistry) && File.Exists(fromRegistry))
            {
                return fromRegistry!;
            }

            string? fromPath = FindOnPath("ffmpeg.exe") ?? FindOnPath("ffmpeg");
            if (fromPath != null)
            {
                return fromPath;
            }

            string defaultPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                "YoutubeDownloader", "tools", "ffmpeg.exe");
            return defaultPath;
        }

        public static string ResolveOutputDir(string configured)
        {
            string dir;
            if (!string.IsNullOrWhiteSpace(configured))
            {
                dir = configured;
            }
            else
            {
                string? fromRegistry = Registry.GetValue("DownloadFolder");
                dir = !string.IsNullOrWhiteSpace(fromRegistry)
                    ? fromRegistry!
                    : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads", "YoutubeDownloader");
            }

            Directory.CreateDirectory(dir);
            return dir;
        }

        private static string? FindOnPath(string exeName)
        {
            string? pathVar = Environment.GetEnvironmentVariable("PATH");
            if (pathVar == null) return null;

            foreach (string folder in pathVar.Split(Path.PathSeparator))
            {
                try
                {
                    string candidate = Path.Combine(folder, exeName);
                    if (File.Exists(candidate)) return candidate;
                }
                catch
                {
                    // dossier invalide dans PATH, on ignore
                }
            }
            return null;
        }

        // ------------------------------------------------------------------
        // Analyse des formats disponibles (yt-dlp -J)
        // ------------------------------------------------------------------

        // BUG CORRIGÉ : cette fonction n'envoyait jamais --cookies-from-browser, contrairement
        // à BuildArguments() utilisée pour le téléchargement final. Résultat incohérent sur les
        // vidéos qui nécessitent déjà une authentification au moment de l'ANALYSE (restriction
        // d'âge, contenu réservé aux abonnés/membres, certaines restrictions régionales) :
        // l'analyse pouvait échouer (ou renvoyer une liste de formats incomplète/erronée) alors
        // que le téléchargement, lui, utilisait bien les cookies et aurait fonctionné.
        public static async Task<FormatsResult?> GetFormatsAsync(string ytDlpPath, string url, string cookiesFromBrowser = "")
        {
            var psi = CreateProcessInfo(ytDlpPath, utf8Output: true);
            psi.ArgumentList.Add("-J");
            psi.ArgumentList.Add("--no-warnings");
            // Seul le premier élément est lu (titre + hauteurs) : évite d'extraire toute une
            // playlist (potentiellement des centaines de vidéos) pour une simple analyse.
            psi.ArgumentList.Add("--playlist-items");
            psi.ArgumentList.Add("1");
            if (!string.IsNullOrWhiteSpace(cookiesFromBrowser) && cookiesFromBrowser != "none")
            {
                psi.ArgumentList.Add("--cookies-from-browser");
                psi.ArgumentList.Add(cookiesFromBrowser);
            }
            psi.ArgumentList.Add(url);

            using var process = new Process { StartInfo = psi };
            var stdoutBuilder = new StringBuilder();
            var stderrBuilder = new StringBuilder();

            process.OutputDataReceived += (s, e) => { if (e.Data != null) stdoutBuilder.AppendLine(e.Data); };
            process.ErrorDataReceived += (s, e) => { if (e.Data != null) stderrBuilder.AppendLine(e.Data); };

            StartWithoutStdin(process);
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            await process.WaitForExitAsync();

            if (process.ExitCode != 0 || stdoutBuilder.Length == 0)
            {
                return null;
            }

            try
            {
                using JsonDocument doc = JsonDocument.Parse(stdoutBuilder.ToString());
                JsonElement root = doc.RootElement;

                bool isPlaylist = root.TryGetProperty("_type", out var typeEl) && typeEl.GetString() == "playlist";
                JsonElement infoElement = root;

                if (isPlaylist && root.TryGetProperty("entries", out var entries) && entries.GetArrayLength() > 0)
                {
                    infoElement = entries[0];
                }

                // BUG CORRIGÉ : quand l'URL contient à la fois "v=" (une vidéo) et "list=" (une
                // playlist), yt-dlp -J extrait par défaut UNIQUEMENT la vidéo (comportement par
                // défaut de yt-dlp/youtube-dl, sauf si --yes-playlist est précisé). "_type" ne
                // vaut alors jamais "playlist" et isPlaylist restait figé à false, donc le menu
                // ne proposait jamais l'option "Playlist entière"/"À partir d'ici" pour ce cas
                // pourtant très courant (clic sur une vidéo depuis une playlist YouTube). On
                // complète donc la détection par la présence d'un paramètre "list=" valide dans
                // l'URL d'origine, sans dépendre du comportement d'extraction de yt-dlp.
                if (!isPlaylist && HasPlaylistParam(url))
                {
                    isPlaylist = true;
                }

                string title = infoElement.TryGetProperty("title", out var titleEl)
                    ? titleEl.GetString() ?? "Vidéo YouTube"
                    : "Vidéo YouTube";

                var heights = new List<int>();
                if (infoElement.TryGetProperty("formats", out var formats) && formats.ValueKind == JsonValueKind.Array)
                {
                    foreach (JsonElement fmt in formats.EnumerateArray())
                    {
                        bool hasVideo = fmt.TryGetProperty("vcodec", out var vcodec) &&
                                        vcodec.GetString() != "none";
                        if (hasVideo && fmt.TryGetProperty("height", out var heightEl) &&
                            heightEl.ValueKind == JsonValueKind.Number)
                        {
                            heights.Add(heightEl.GetInt32());
                        }
                    }
                }

                return new FormatsResult
                {
                    Title = title,
                    IsPlaylist = isPlaylist,
                    AvailableHeights = heights.Distinct().OrderByDescending(h => h).ToList()
                };
            }
            catch (JsonException)
            {
                return null;
            }
        }

        // ------------------------------------------------------------------
        // Téléchargement
        // ------------------------------------------------------------------

        public static async Task<string?> DownloadAsync(DownloadRequest request, Action<int, string> onProgress, CancellationToken ct = default)
        {
            ct.ThrowIfCancellationRequested();
            List<string> args = BuildArguments(request);

            var psi = CreateProcessInfo(request.YtDlpPath, utf8Output: true);
            foreach (string arg in args) psi.ArgumentList.Add(arg);

            using var process = new Process { StartInfo = psi };
            string? lastErrorLine = null;
            string? lastDestination = null;
            int lastReportedBreakpoint = -1;
            int currentItem = 1;
            int totalItems = 1;
            int lastOverall = -1;

            onProgress(0, "Démarrage");

            process.OutputDataReceived += (s, e) =>
            {
                if (e.Data == null) return;

                var itemMatch = PlaylistItemRegex.Match(e.Data);
                if (itemMatch.Success)
                {
                    currentItem = int.Parse(itemMatch.Groups["cur"].Value);
                    totalItems = int.Parse(itemMatch.Groups["total"].Value);
                }

                var match = ProgressRegex.Match(e.Data);
                if (match.Success && double.TryParse(
                        match.Groups["percent"].Value,
                        System.Globalization.NumberStyles.Any,
                        System.Globalization.CultureInfo.InvariantCulture,
                        out double percent))
                {
                    if (totalItems > 1)
                    {
                        // Playlist / chaîne : progression globale sur l'ensemble des vidéos.
                        int overall = (int)(((currentItem - 1) * 100.0 + percent) / totalItems);
                        if (overall > lastOverall)
                        {
                            lastOverall = overall;
                            onProgress(Math.Min(overall, 99), $"Vidéo {currentItem}/{totalItems}");
                        }
                        return;
                    }

                    int breakpoint = ProgressBreakpoints.LastOrDefault(bp => bp <= percent);
                    if (breakpoint > lastReportedBreakpoint)
                    {
                        lastReportedBreakpoint = breakpoint;
                        onProgress(breakpoint, "Téléchargement");
                    }
                }

                if (e.Data.Contains("[Merger]") || e.Data.Contains("Merging formats"))
                {
                    onProgress(Math.Max(lastReportedBreakpoint, 90), "Fusion audio/vidéo (FFmpeg)");
                }

                if (e.Data.Contains("[ExtractAudio]") || e.Data.Contains("Destination"))
                {
                    var destMatch = DestinationRegex.Match(e.Data);
                    if (destMatch.Success)
                    {
                        lastDestination = destMatch.Groups[1].Value.Trim();
                    }
                }

                var mergedMatch = MergedRegex.Match(e.Data);
                if (mergedMatch.Success)
                {
                    lastDestination = mergedMatch.Groups["file"].Value.Trim();
                }
            };

            process.ErrorDataReceived += (s, e) =>
            {
                if (e.Data == null) return;
                var match = ErrorRegex.Match(e.Data);
                if (match.Success)
                {
                    lastErrorLine = match.Groups["msg"].Value.Trim();
                }
            };

            StartWithoutStdin(process);
            using var killRegistration = RegisterKill(process, ct);
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
            await process.WaitForExitAsync();
            ct.ThrowIfCancellationRequested();

            if (process.ExitCode != 0)
            {
                throw new Exception(TranslateError(lastErrorLine));
            }

            onProgress(100, "Terminé");
            return lastDestination;
        }

        // ------------------------------------------------------------------
        // Téléchargement direct (fichier audio public déjà connu, ex. podcasts
        // radiofrance.fr) : pas de yt-dlp, juste un HTTP GET + tagging FFmpeg.
        // ------------------------------------------------------------------

        // BUG CORRIGÉ : HttpClient n'envoie par défaut ni User-Agent ni Referer. Beaucoup de
        // CDN (dont celui de radiofrance.fr : /pikapi/images/... pour les covers, et le CDN
        // audio des podcasts) renvoient un 403 Forbidden aux requêtes qui n'ont pas ces
        // en-têtes "navigateur" — c'est un anti-bot classique. Comme la cover est traitée
        // comme optionnelle dans DownloadDirectAsync (l'échec est capturé et on continue sans
        // pochette), ce 403 ne remontait JAMAIS d'erreur visible : le mp3 final se retrouvait
        // simplement sans cover, silencieusement. On imite maintenant un navigateur pour ces
        // requêtes directes.
        private static readonly System.Net.Http.HttpClient DirectHttpClient = CreateDirectHttpClient();

        private static System.Net.Http.HttpClient CreateDirectHttpClient()
        {
            var client = new System.Net.Http.HttpClient();
            client.Timeout = TimeSpan.FromMinutes(15); // certains épisodes font plusieurs heures d'audio
            client.DefaultRequestHeaders.UserAgent.ParseAdd(
                "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36");
            client.DefaultRequestHeaders.Accept.ParseAdd("*/*");
            client.DefaultRequestHeaders.Referrer = new Uri("https://www.radiofrance.fr/");
            return client;
        }

        public static async Task<string?> DownloadDirectAsync(DownloadRequest request, Action<int, string> onProgress, CancellationToken ct = default)
        {
            ct.ThrowIfCancellationRequested();
            if (string.IsNullOrWhiteSpace(request.DirectMediaUrl))
            {
                throw new Exception("URL audio manquante.");
            }

            onProgress(0, "Démarrage");

            string extension = GuessExtension(request.DirectMediaUrl);
            string safeTitle = SanitizeFileName(!string.IsNullOrWhiteSpace(request.Title) ? request.Title : "podcast");

            string workDir = Path.Combine(Path.GetTempPath(), "ytdl-direct-" + Guid.NewGuid().ToString("N"));
            Directory.CreateDirectory(workDir);

            try
            {
                string rawAudioPath = Path.Combine(workDir, "source" + extension);
                await DownloadFileAsync(request.DirectMediaUrl, rawAudioPath, (p) => onProgress(Math.Min(60, p * 60 / 100), "Téléchargement de l'audio"), ct);

                string? coverPath = null;
                if (!string.IsNullOrWhiteSpace(request.DirectCoverUrl))
                {
                    try
                    {
                        coverPath = Path.Combine(workDir, "cover.jpg");
                        await DownloadFileAsync(request.DirectCoverUrl, coverPath, null, ct);
                    }
                    catch (OperationCanceledException)
                    {
                        throw;
                    }
                    catch (Exception coverEx)
                    {
                        // BUG CORRIGÉ : cet échec était avalé sans aucune trace, donc quand la
                        // cover ne se téléchargeait pas (ex. 403 avant le fix des en-têtes
                        // ci-dessus, image supprimée entre-temps, etc.) rien ne le signalait :
                        // le fichier final sortait juste sans pochette, en silence. On le
                        // reporte maintenant comme étape de progression (non bloquante) pour
                        // que ce soit visible dans l'UI de l'extension pendant le
                        // téléchargement.
                        coverPath = null; // La cover reste optionnelle : on continue sans elle.
                        onProgress(62, "Cover indisponible (" + coverEx.Message + "), poursuite sans pochette");
                    }
                }

                onProgress(65, "Préparation des métadonnées");

                List<AudioChapter> chapters = ParseChapters(request.DirectChaptersJson);

                // --- Une seule passe FFmpeg : tags texte + chapitres (fichier FFMETADATA) et,
                // si disponible, cover embarquée. Évite de relire/réécrire deux fois un fichier
                // pouvant peser plusieurs centaines de Mo. ---
                string metadataFilePath = Path.Combine(workDir, "ffmetadata.txt");
                File.WriteAllText(metadataFilePath, BuildFfmetadata(request, chapters), new UTF8Encoding(false));

                string finalPath = EnsureUniquePath(Path.Combine(request.OutputDir, safeTitle + extension));

                var tagArgs = new List<string>
                {
                    "-y",
                    "-i", rawAudioPath,
                    "-i", metadataFilePath
                };
                if (coverPath != null)
                {
                    tagArgs.Add("-i");
                    tagArgs.Add(coverPath);
                }
                tagArgs.AddRange(new[]
                {
                    "-map_metadata", "1",
                    "-map_chapters", "1",
                    // On ne garde QUE le flux audio de la source : certains fichiers radiofrance
                    // embarquent déjà une cover générique, qu'on ne veut pas conserver pour
                    // éviter d'avoir deux images (l'ancienne + la vraie cover de l'épisode).
                    "-map", "0:a"
                });
                if (coverPath != null)
                {
                    tagArgs.AddRange(new[]
                    {
                        "-map", "2",
                        // La cover source peut être en WebP (cas fréquent des og:image), format
                        // que les conteneurs audio ne savent pas embarquer tel quel : on la
                        // réencode en MJPEG, compatible partout.
                        "-c:v", "mjpeg",
                        "-disposition:v", "attached_pic"
                    });
                }
                tagArgs.AddRange(new[] { "-c:a", "copy", finalPath });
                await RunFfmpegAsync(request.FfmpegPath, tagArgs, ct);

                onProgress(100, "Terminé");
                return finalPath;
            }
            finally
            {
                try { Directory.Delete(workDir, recursive: true); } catch { /* best-effort cleanup */ }
            }
        }

        private static async Task DownloadFileAsync(string url, string destinationPath, Action<int>? onProgress, CancellationToken ct = default)
        {
            using var response = await DirectHttpClient.GetAsync(url, System.Net.Http.HttpCompletionOption.ResponseHeadersRead, ct);
            response.EnsureSuccessStatusCode();

            long? totalBytes = response.Content.Headers.ContentLength;
            await using var httpStream = await response.Content.ReadAsStreamAsync(ct);
            await using var fileStream = new FileStream(destinationPath, FileMode.Create, FileAccess.Write, FileShare.None);

            var buffer = new byte[81920];
            long readSoFar = 0;
            int bytesRead;
            int lastPercent = -1;
            while ((bytesRead = await httpStream.ReadAsync(buffer, ct)) > 0)
            {
                await fileStream.WriteAsync(buffer.AsMemory(0, bytesRead), ct);
                readSoFar += bytesRead;
                if (onProgress != null && totalBytes.HasValue && totalBytes.Value > 0)
                {
                    int percent = (int)(readSoFar * 100 / totalBytes.Value);
                    if (percent != lastPercent)
                    {
                        lastPercent = percent;
                        onProgress(percent);
                    }
                }
            }
        }

        private static async Task RunFfmpegAsync(string ffmpegPath, List<string> args, CancellationToken ct = default)
        {
            var psi = CreateProcessInfo(ffmpegPath, utf8Output: false);
            foreach (string arg in args) psi.ArgumentList.Add(arg);

            using var process = new Process { StartInfo = psi };
            var stderr = new StringBuilder();
            process.ErrorDataReceived += (s, e) => { if (e.Data != null) stderr.AppendLine(e.Data); };

            StartWithoutStdin(process);
            using var killRegistration = RegisterKill(process, ct);
            process.BeginErrorReadLine();
            await process.WaitForExitAsync();
            ct.ThrowIfCancellationRequested();

            if (process.ExitCode != 0)
            {
                throw new Exception("FFmpeg a échoué lors du tagging du fichier : " + LastLines(stderr.ToString(), 3));
            }
        }

        private static string LastLines(string text, int count)
        {
            var lines = text.Split('\n', StringSplitOptions.RemoveEmptyEntries);
            return string.Join(" | ", lines.Skip(Math.Max(0, lines.Length - count)));
        }

        /// <summary>
        /// Construit un fichier au format FFMETADATA1 (tags globaux + chapitres) que FFmpeg
        /// peut fusionner dans le fichier audio via -map_metadata.
        /// Doc : https://ffmpeg.org/ffmpeg-formats.html#Metadata-1
        /// </summary>
        private static string BuildFfmetadata(DownloadRequest request, List<AudioChapter> chapters)
        {
            var sb = new StringBuilder();
            sb.AppendLine(";FFMETADATA1");
            sb.AppendLine("title=" + EscapeFfmetadata(request.Title));
            sb.AppendLine("artist=" + EscapeFfmetadata(request.DirectAuthor));
            sb.AppendLine("album_artist=" + EscapeFfmetadata(request.DirectAuthor));
            // BUG CORRIGÉ : si l'album n'a vraiment pas pu être déterminé (cas très rare, ex.
            // lecteur global non hydraté ET aucun repli DOM trouvé), on omet le tag plutôt que
            // d'écrire une chaîne vide ou une valeur devinée au hasard — un tag absent est
            // moins trompeur qu'un tag faux.
            if (!string.IsNullOrWhiteSpace(request.DirectAlbum))
            {
                sb.AppendLine("album=" + EscapeFfmetadata(request.DirectAlbum));
            }
            sb.AppendLine("comment=" + EscapeFfmetadata(request.DirectDescription));
            sb.AppendLine("description=" + EscapeFfmetadata(request.DirectDescription));
            if (!string.IsNullOrWhiteSpace(request.DirectGenre))
            {
                sb.AppendLine("genre=" + EscapeFfmetadata(request.DirectGenre));
            }

            // Les timestamps FFMETADATA sont en millisecondes, avec un TIMEBASE de 1/1000.
            for (int i = 0; i < chapters.Count; i++)
            {
                AudioChapter chapter = chapters[i];
                long startMs = (long)(chapter.StartSeconds * 1000);
                long endMs = i + 1 < chapters.Count ? (long)(chapters[i + 1].StartSeconds * 1000) : startMs + 1;

                sb.AppendLine("[CHAPTER]");
                sb.AppendLine("TIMEBASE=1/1000");
                sb.AppendLine("START=" + startMs);
                sb.AppendLine("END=" + endMs);
                sb.AppendLine("title=" + EscapeFfmetadata(chapter.Title));
            }

            return sb.ToString();
        }

        private static string EscapeFfmetadata(string value)
        {
            if (string.IsNullOrEmpty(value)) return "";
            // Les caractères =, ;, #, \ et les retours à la ligne doivent être échappés avec \.
            return value
                .Replace("\\", "\\\\")
                .Replace("=", "\\=")
                .Replace(";", "\\;")
                .Replace("#", "\\#")
                .Replace("\r\n", " ")
                .Replace("\n", " ");
        }

        private static List<AudioChapter> ParseChapters(string chaptersJson)
        {
            var result = new List<AudioChapter>();
            if (string.IsNullOrWhiteSpace(chaptersJson)) return result;

            try
            {
                using JsonDocument doc = JsonDocument.Parse(chaptersJson);
                foreach (JsonElement el in doc.RootElement.EnumerateArray())
                {
                    string title = el.TryGetProperty("title", out var t) ? (t.GetString() ?? "") : "";
                    double start = el.TryGetProperty("startSeconds", out var s) ? s.GetDouble() : 0;
                    if (!string.IsNullOrWhiteSpace(title))
                    {
                        result.Add(new AudioChapter { Title = title, StartSeconds = start });
                    }
                }
            }
            catch
            {
                // Chapitres mal formés : on continue sans chapitres plutôt que d'échouer tout le téléchargement.
            }

            return result.OrderBy(c => c.StartSeconds).ToList();
        }

        private static string GuessExtension(string url)
        {
            try
            {
                string path = new Uri(url).AbsolutePath;
                string ext = Path.GetExtension(path);
                return string.IsNullOrWhiteSpace(ext) ? ".m4a" : ext;
            }
            catch
            {
                return ".m4a";
            }
        }

        private static string SanitizeFileName(string name)
        {
            foreach (char c in Path.GetInvalidFileNameChars())
            {
                name = name.Replace(c, '_');
            }
            return name.Trim();
        }

        private static string EnsureUniquePath(string path)
        {
            if (!File.Exists(path)) return path;

            string dir = Path.GetDirectoryName(path) ?? "";
            string name = Path.GetFileNameWithoutExtension(path);
            string ext = Path.GetExtension(path);
            int i = 2;
            string candidate;
            do
            {
                candidate = Path.Combine(dir, $"{name} ({i}){ext}");
                i++;
            } while (File.Exists(candidate));
            return candidate;
        }

        private static string TranslateError(string? rawMessage)
        {
            if (string.IsNullOrWhiteSpace(rawMessage))
            {
                return "Le téléchargement a échoué pour une raison inconnue.";
            }

            string msg = rawMessage.ToLowerInvariant();

            if (msg.Contains("private video")) return "Cette vidéo est privée.";
            if (msg.Contains("video unavailable") || msg.Contains("this video is unavailable")) return "Cette vidéo n'est plus disponible (supprimée ou retirée).";
            if (msg.Contains("sign in") || msg.Contains("age")) return "Cette vidéo nécessite une connexion (restriction d'âge).";
            if (msg.Contains("network") || msg.Contains("timed out") || msg.Contains("connection")) return "Erreur réseau lors du téléchargement. Vérifiez votre connexion.";
            if (msg.Contains("quota") || msg.Contains("429") || msg.Contains("too many requests")) return "Quota YouTube dépassé. Réessayez plus tard.";
            if (msg.Contains("ffmpeg")) return "FFmpeg est introuvable ou a échoué. Vérifiez son chemin dans les options.";
            // BUG CORRIGÉ : un "403 Forbidden" générique (ex. "unable to download video data:
            // HTTP Error 403: Forbidden") n'était mappé sur aucun cas ci-dessus et remontait donc
            // le message brut de yt-dlp, incompréhensible pour l'utilisateur. C'est presque
            // toujours le blocage anti-bot de YouTube (signature/PO token), qui évolue très
            // régulièrement — la cause la plus fréquente est une version de yt-dlp périmée,
            // même quand des cookies valides sont déjà configurés.
            if (msg.Contains("403")) return "YouTube a refusé la requête (403). Mettez à jour yt-dlp vers la dernière version (les protections anti-bot de YouTube changent souvent) et vérifiez que le navigateur choisi pour les cookies est bien celui où vous êtes connecté à YouTube.";

            return rawMessage;
        }

        private static List<string> BuildArguments(DownloadRequest request)
        {
            var args = new List<string>();
            string outputTemplate = Path.Combine(request.OutputDir, request.FilenameTemplate);

            args.Add("--newline");
            args.Add("--no-warnings");
            args.Add("--ffmpeg-location");
            args.Add(string.IsNullOrWhiteSpace(request.FfmpegPath) ? "ffmpeg" : request.FfmpegPath);

            // YouTube demande de plus en plus souvent une preuve d'authentification (cookies)
            // avant d'autoriser le téléchargement du flux réel, même quand yt-dlp est à jour
            // (voir errors "403 Forbidden" / "Sign in to confirm you're not a bot"). On utilise
            // directement les cookies du navigateur choisi si l'utilisateur en a configuré un.
            if (!string.IsNullOrWhiteSpace(request.CookiesFromBrowser) && request.CookiesFromBrowser != "none")
            {
                args.Add("--cookies-from-browser");
                args.Add(request.CookiesFromBrowser);
            }

            args.Add("-o");
            args.Add(outputTemplate);

            AddPlaylistArgs(args, request);

            switch (request.DownloadType)
            {
                case "audio":
                    args.Add("-x");
                    args.Add("--audio-format");
                    args.Add(request.AudioFormat);
                    args.Add("--audio-quality");
                    args.Add("0");
                    break;

                case "subtitle":
                    args.Add("--write-subs");
                    args.Add("--write-auto-subs");
                    args.Add("--sub-langs");
                    args.Add(SanitizeSubtitleLangs(request.SubtitleLangs));
                    if (request.SubtitleFormat == "srt" || request.SubtitleFormat == "vtt")
                    {
                        args.Add("--convert-subs");
                        args.Add(request.SubtitleFormat);
                    }
                    args.Add("--skip-download");
                    break;

                case "thumbnail":
                    args.Add("--write-thumbnail");
                    args.Add("--skip-download");
                    break;

                case "description":
                    args.Add("--write-description");
                    args.Add("--skip-download");
                    break;

                case "video-no-audio":
                    args.Add("-f");
                    args.Add(BuildVideoOnlyFormatSelector(request.Quality));
                    args.Add("--merge-output-format");
                    args.Add(request.VideoFormat);
                    break;

                case "video-with-all":
                    args.Add("-f");
                    args.Add(BuildFormatSelector(request.Quality));
                    args.Add("--audio-multistreams");
                    args.Add("--all-subs");
                    args.Add("--write-auto-subs");
                    args.Add("--embed-subs");
                    args.Add("--merge-output-format");
                    args.Add(request.VideoFormat);
                    break;

                case "video":
                default:
                    args.Add("-f");
                    args.Add(BuildFormatSelector(request.Quality));
                    args.Add("--merge-output-format");
                    args.Add(request.VideoFormat);
                    break;
            }

            AddSponsorBlockArgs(args, request);
            AddMetadataArgs(args, request);

            args.Add(request.Url);
            return args;
        }

        /// <summary>
        /// Ajoute les indicateurs yt-dlp pour EMBARQUER les infos complémentaires
        /// (miniature/cover, titre, auteur/artiste, album, description, chapitres, date de
        /// publication...) directement DANS le fichier final, à la manière d'un fichier musical
        /// tagué (cover art + artiste + album). S'applique à la vidéo comme à l'audio.
        ///
        /// Important : on n'utilise PAS --write-info-json / --write-description / --write-thumbnail
        /// ici, car ces options créent des fichiers séparés (.info.json, .description, .jpg) à côté
        /// du fichier téléchargé. L'objectif est un seul fichier final : tout est fusionné dedans via
        /// FFmpeg (--embed-*). yt-dlp télécharge la miniature dans un fichier temporaire, l'embarque,
        /// puis le supprime automatiquement tant que --write-thumbnail n'est pas demandé.
        /// </summary>
        private static readonly HashSet<string> SponsorBlockCategoryWhitelist = new HashSet<string>
        {
            "sponsor", "intro", "outro", "selfpromo", "preview", "filler", "interaction", "music_offtopic"
        };

        /// <summary>
        /// SponsorBlock via yt-dlp (même base communautaire que l'extension du même nom).
        /// Les catégories sont filtrées sur une liste blanche avant d'être passées à yt-dlp.
        /// </summary>
        private static void AddSponsorBlockArgs(List<string> args, DownloadRequest request)
        {
            if (request.SponsorBlockMode != "remove" && request.SponsorBlockMode != "mark")
            {
                return;
            }

            bool appliesTo = request.DownloadType == "video"
                || request.DownloadType == "audio"
                || request.DownloadType == "video-no-audio"
                || request.DownloadType == "video-with-all";
            if (!appliesTo)
            {
                return;
            }

            var categories = (request.SponsorBlockCategories ?? "")
                .Split(',', StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries)
                .Where(c => SponsorBlockCategoryWhitelist.Contains(c))
                .Distinct()
                .ToList();
            if (categories.Count == 0)
            {
                return;
            }

            args.Add(request.SponsorBlockMode == "remove" ? "--sponsorblock-remove" : "--sponsorblock-mark");
            args.Add(string.Join(",", categories));
        }

        private static void AddMetadataArgs(List<string> args, DownloadRequest request)
        {
            if (!request.IncludeMetadata)
            {
                return;
            }

            bool appliesTo = request.DownloadType == "video"
                || request.DownloadType == "audio"
                || request.DownloadType == "video-no-audio"
                || request.DownloadType == "video-with-all";

            if (!appliesTo)
            {
                return;
            }

            // --- Mapping façon "musique" : artiste, album, commentaire ---------------------
            // Ces --parse-metadata sont volontairement ajoutés AVANT --embed-metadata : ils
            // modifient les champs du dictionnaire d'infos, qui sont ensuite lus par le
            // post-traitement d'embarquement des métadonnées.
            //
            // Force le tag "artist" (et "album_artist") à partir du nom de la chaîne/auteur,
            // même si YouTube ne fournit pas de champ "artist" dédié (cas de la grande majorité
            // des vidéos qui ne sont pas taguées "Musique" par YouTube).
            args.Add("--parse-metadata");
            args.Add("%(uploader,channel)s:%(artist)s");

            args.Add("--parse-metadata");
            args.Add("%(uploader,channel)s:%(album_artist)s");

            // Utilise le nom de la chaîne comme "album", comme si toutes les vidéos d'un même
            // auteur appartenaient à un même "album".
            args.Add("--parse-metadata");
            args.Add("%(uploader,channel)s:%(album)s");

            // Copie la description complète dans le tag "comment" (en plus de "description"/
            // "synopsis" déjà mappés automatiquement par --embed-metadata), pour qu'elle soit
            // visible dans un maximum de lecteurs (Windows Media Player, VLC, lecteurs audio...).
            args.Add("--parse-metadata");
            args.Add("%(description)s:%(meta_comment)s");

            // Embarque les métadonnées (titre, date, artiste, album, commentaire...) directement
            // dans le fichier final.
            args.Add("--embed-metadata");

            // Embarque également les chapitres s'ils existent (marqueurs de chapitre dans le
            // fichier final, comme sur un CD/album).
            args.Add("--embed-chapters");

            // Embarque la miniature comme pochette/cover art dans le conteneur du fichier final
            // (nécessite FFmpeg). Fonctionne pour mp3/m4a/mp4/mkv/flac ; ignoré silencieusement
            // pour les formats qui ne supportent pas les images embarquées (ex. wav).
            args.Add("--embed-thumbnail");
        }

        private static void AddPlaylistArgs(List<string> args, DownloadRequest request)
        {
            if (request.PlaylistEnd > 0)
            {
                args.Add("--playlist-end");
                args.Add(request.PlaylistEnd.ToString());
            }

            if (request.ChannelMode)
            {
                // Fichier d'archive : permet de relancer un téléchargement interrompu sans
                // retélécharger les vidéos déjà obtenues (un fichier par type/qualité).
                string kind = request.DownloadType + "-" +
                    (request.DownloadType == "audio" ? request.AudioFormat : request.Quality);
                kind = SanitizeFileName(kind);
                args.Add("--download-archive");
                args.Add(Path.Combine(request.OutputDir, ".archive-" + kind + ".txt"));
            }

            switch (request.PlaylistMode)
            {
                case "full":
                    args.Add("--yes-playlist");
                    break;

                case "fromCurrent":
                    args.Add("--yes-playlist");
                    int startIndex = ExtractPlaylistIndex(request.Url);
                    args.Add("--playlist-start");
                    args.Add(startIndex.ToString());
                    break;

                case "single":
                default:
                    args.Add("--no-playlist");
                    break;
            }
        }

        /// <summary>
        /// Détecte la présence d'un paramètre "list=" avec un ID de playlist non vide dans
        /// l'URL (ex. "watch?v=XXXX&list=YYYY"). Sert de filet de sécurité en complément de la
        /// détection via "_type": "playlist" renvoyée par yt-dlp -J, qui ne suffit pas seule
        /// quand l'URL référence à la fois une vidéo et une playlist (voir commentaire dans
        /// GetFormatsAsync).
        /// </summary>
        private static bool HasPlaylistParam(string url)
        {
            var match = PlaylistParamRegex.Match(url);
            return match.Success && match.Groups[1].Value.Length > 0;
        }

        private static int ExtractPlaylistIndex(string url)
        {
            var match = PlaylistIndexRegex.Match(url);
            if (match.Success && int.TryParse(match.Groups[1].Value, out int idx))
            {
                return idx;
            }
            return 1;
        }

        private static string BuildFormatSelector(string quality)
        {
            return TryParseHeight(quality, out int h)
                ? $"bv*[height<={h}]+ba/b[height<={h}]"
                : "bv*+ba/b";
        }

        private static string BuildVideoOnlyFormatSelector(string quality)
        {
            return TryParseHeight(quality, out int h) ? $"bv*[height<={h}]" : "bv*";
        }

        private static bool TryParseHeight(string quality, out int height)
        {
            height = 0;
            if (string.IsNullOrWhiteSpace(quality) || quality == "best") return false;
            string digits = quality.EndsWith("p", StringComparison.OrdinalIgnoreCase)
                ? quality.Substring(0, quality.Length - 1)
                : quality;
            return int.TryParse(digits, out height);
        }
    }
}
