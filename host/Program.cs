using System;
using System.IO;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace DownloaderHost
{
    /// <summary>
    /// Point d'entrée de l'hôte natif. Chrome démarre ce processus et communique
    /// via stdin/stdout en suivant le protocole Native Messaging (voir NativeHost.cs).
    /// </summary>
    public static class Program
    {
        public static async Task Main(string[] args)
        {
            using Stream stdin = Console.OpenStandardInput();
            using Stream stdout = Console.OpenStandardOutput();

            // Un téléchargement tourne en tâche de fond pendant que la boucle continue de lire
            // stdin, ce qui permet de recevoir une demande "cancel" ou la fermeture du port.
            using var downloadCts = new CancellationTokenSource();
            Task? downloadTask = null;

            while (true)
            {
                string? json;
                try
                {
                    json = NativeMessaging.ReadMessage(stdin);
                }
                catch (IOException)
                {
                    break;
                }

                if (json == null)
                {
                    break; // Chrome a fermé la connexion (port.disconnect()).
                }

                try
                {
                    using JsonDocument doc = JsonDocument.Parse(json);
                    JsonElement root = doc.RootElement;
                    string action = root.TryGetProperty("action", out var actionEl)
                        ? actionEl.GetString() ?? ""
                        : "";

                    switch (action)
                    {
                        case "getFormats":
                            await HandleGetFormatsAsync(root, stdout);
                            break;

                        case "download":
                            if (downloadTask != null)
                            {
                                NativeMessaging.WriteMessage(stdout, new { type = "error", message = "Un téléchargement est déjà en cours sur cette connexion." });
                                break;
                            }
                            // Le JSON est cloné car doc est libéré à la fin de cette itération.
                            JsonElement requestRoot = root.Clone();
                            downloadTask = Task.Run(() => HandleDownloadAsync(requestRoot, stdout, downloadCts.Token));
                            break;

                        case "cancel":
                            downloadCts.Cancel();
                            break;

                        case "testConfig":
                            await HandleTestConfigAsync(root, stdout);
                            break;

                        case "revealPath":
                            {
                                bool ok = Downloader.RevealPath(GetString(root, "path"));
                                NativeMessaging.WriteMessage(stdout, new { type = "revealResult", ok });
                                break;
                            }

                        case "pickFolder":
                            {
                                string? folder = await Downloader.PickFolderAsync();
                                NativeMessaging.WriteMessage(stdout, new { type = "folderPicked", path = folder ?? "" });
                                break;
                            }

                        default:
                            NativeMessaging.WriteMessage(stdout, new { type = "error", message = $"Action inconnue : {action}" });
                            break;
                    }
                }
                catch (JsonException)
                {
                    NativeMessaging.WriteMessage(stdout, new { type = "error", message = "Message JSON invalide reçu par l'hôte natif." });
                }
                catch (Exception ex)
                {
                    NativeMessaging.WriteMessage(stdout, new { type = "error", message = $"Erreur interne de l'hôte : {ex.Message}" });
                }
            }

            // Port fermé : on arrête proprement un éventuel téléchargement encore actif.
            if (downloadTask != null)
            {
                downloadCts.Cancel();
                try { await downloadTask; } catch { /* déjà reporté ou stdout fermé */ }
            }
        }

        private static async Task HandleTestConfigAsync(JsonElement root, Stream stdout)
        {
            string ytDlpPath = Downloader.ResolveYtDlpPath(GetString(root, "ytDlpPath"));
            string ffmpegPath = Downloader.ResolveFfmpegPath(GetString(root, "ffmpegPath"));

            Task<string?> ytTask = Downloader.GetToolVersionAsync(ytDlpPath, "--version");
            Task<string?> ffTask = Downloader.GetToolVersionAsync(ffmpegPath, "-version");
            string? ytVersion = await ytTask;
            string? ffVersion = await ffTask;

            bool outputOk;
            try
            {
                outputOk = !string.IsNullOrWhiteSpace(Downloader.ResolveOutputDir(GetString(root, "outputDir")));
            }
            catch
            {
                outputOk = false;
            }

            NativeMessaging.WriteMessage(stdout, new
            {
                type = "testResult",
                ytDlp = new { ok = ytVersion != null, path = ytDlpPath, version = ytVersion ?? "" },
                ffmpeg = new { ok = ffVersion != null, path = ffmpegPath, version = ffVersion ?? "" },
                outputDirOk = outputOk
            });
        }

        private static async Task HandleGetFormatsAsync(JsonElement root, Stream stdout)
        {
            string url = GetString(root, "url");
            string ytDlpPathRaw = GetString(root, "ytDlpPath");
            string cookiesFromBrowser = GetString(root, "cookiesFromBrowser");

            if (string.IsNullOrWhiteSpace(url))
            {
                NativeMessaging.WriteMessage(stdout, new { type = "error", message = "URL manquante." });
                return;
            }

            string ytDlpPath = Downloader.ResolveYtDlpPath(ytDlpPathRaw);
            if (!File.Exists(ytDlpPath))
            {
                NativeMessaging.WriteMessage(stdout, new
                {
                    type = "error",
                    message = "yt-dlp.exe est introuvable. Configurez son chemin dans la page Options de l'extension."
                });
                return;
            }

            FormatsResult? result = await Downloader.GetFormatsAsync(ytDlpPath, url, cookiesFromBrowser);
            if (result == null)
            {
                NativeMessaging.WriteMessage(stdout, new
                {
                    type = "error",
                    message = "Impossible d'analyser cette vidéo (privée, supprimée, ou erreur réseau)."
                });
                return;
            }

            NativeMessaging.WriteMessage(stdout, new
            {
                type = "formats",
                title = result.Title,
                isPlaylist = result.IsPlaylist,
                availableHeights = result.AvailableHeights
            });
        }

        private static async Task HandleDownloadAsync(JsonElement root, Stream stdout, CancellationToken ct)
        {
            string requestId = GetString(root, "requestId");
            try
            {
                await RunDownloadAsync(root, stdout, requestId, ct);
            }
            catch (OperationCanceledException)
            {
                try { NativeMessaging.WriteMessage(stdout, new { type = "cancelled", requestId }); }
                catch { /* stdout fermé */ }
            }
            catch (Exception ex)
            {
                try { NativeMessaging.WriteMessage(stdout, new { type = "error", requestId, message = ex.Message }); }
                catch { /* stdout fermé */ }
            }
        }

        private static async Task RunDownloadAsync(JsonElement root, Stream stdout, string requestId, CancellationToken ct)
        {
            string url = GetString(root, "url");
            string directMediaUrl = GetString(root, "directMediaUrl");

            if (string.IsNullOrWhiteSpace(url) && string.IsNullOrWhiteSpace(directMediaUrl))
            {
                NativeMessaging.WriteMessage(stdout, new { type = "error", requestId, message = "URL manquante." });
                return;
            }

            var request = new DownloadRequest
            {
                RequestId = requestId,
                Url = url,
                Title = GetString(root, "title"),
                DownloadType = GetString(root, "downloadType", "video"),
                Quality = GetString(root, "quality", "best"),
                VideoFormat = GetString(root, "videoFormat", "mp4"),
                AudioFormat = GetString(root, "audioFormat", "mp3"),
                FilenameTemplate = GetString(root, "filenameTemplate", "%(title)s.%(ext)s"),
                PlaylistMode = GetString(root, "playlistMode", "single"),
                ChannelMode = GetBool(root, "channelMode"),
                PlaylistEnd = GetInt(root, "playlistEnd"),
                CookiesFromBrowser = GetString(root, "cookiesFromBrowser"),
                IncludeMetadata = GetBool(root, "includeMetadata"),
                SubtitleLangs = GetString(root, "subtitleLangs", "all"),
                SubtitleFormat = GetString(root, "subtitleFormat"),
                SponsorBlockMode = GetString(root, "sponsorBlockMode", "off"),
                SponsorBlockCategories = GetString(root, "sponsorBlockCategories"),
                DirectMediaUrl = directMediaUrl,
                DirectAuthor = GetString(root, "directAuthor"),
                DirectAlbum = GetString(root, "directAlbum"),
                DirectCoverUrl = GetString(root, "directCoverUrl"),
                DirectDescription = GetString(root, "directDescription"),
                DirectChaptersJson = GetString(root, "directChapters"),
                DirectGenre = GetString(root, "directGenre")
            };

            request.FfmpegPath = Downloader.ResolveFfmpegPath(GetString(root, "ffmpegPath"));
            request.OutputDir = Downloader.ResolveOutputDir(GetString(root, "outputDir"));

            if (!File.Exists(request.FfmpegPath))
            {
                NativeMessaging.WriteMessage(stdout, new
                {
                    type = "error",
                    requestId,
                    message = "ffmpeg.exe est introuvable. Configurez son chemin dans la page Options de l'extension."
                });
                return;
            }

            // --- Chemin "téléchargement direct" (podcast/radio avec fichier audio public,
            // ex. radiofrance.fr) : pas besoin de yt-dlp, l'URL du fichier est déjà connue. ---
            if (!string.IsNullOrWhiteSpace(directMediaUrl))
            {
                string? directPath = await Downloader.DownloadDirectAsync(request, (percent, stage) =>
                {
                    NativeMessaging.WriteMessage(stdout, new { type = "progress", requestId, percent, stage });
                }, ct);

                NativeMessaging.WriteMessage(stdout, new { type = "complete", requestId, filePath = directPath ?? request.OutputDir });
                return;
            }

            // --- Chemin standard (YouTube via yt-dlp) ---
            request.YtDlpPath = Downloader.ResolveYtDlpPath(GetString(root, "ytDlpPath"));

            if (!File.Exists(request.YtDlpPath))
            {
                NativeMessaging.WriteMessage(stdout, new
                {
                    type = "error",
                    requestId,
                    message = "yt-dlp.exe est introuvable. Configurez son chemin dans la page Options de l'extension."
                });
                return;
            }

            bool autoUpdateYtDlp = GetBool(root, "autoUpdateYtDlp", true);
            await Downloader.MaybeAutoUpdateYtDlpAsync(request.YtDlpPath, autoUpdateYtDlp, (percent, stage) =>
            {
                NativeMessaging.WriteMessage(stdout, new { type = "progress", requestId, percent, stage });
            });
            ct.ThrowIfCancellationRequested();

            string? filePath = await Downloader.DownloadAsync(request, (percent, stage) =>
            {
                NativeMessaging.WriteMessage(stdout, new { type = "progress", requestId, percent, stage });
            }, ct);

            NativeMessaging.WriteMessage(stdout, new { type = "complete", requestId, filePath = filePath ?? request.OutputDir });
        }

        private static string GetString(JsonElement root, string property, string fallback = "")
        {
            return root.TryGetProperty(property, out var el) && el.ValueKind == JsonValueKind.String
                ? el.GetString() ?? fallback
                : fallback;
        }

        private static int GetInt(JsonElement root, string property, int fallback = 0)
        {
            return root.TryGetProperty(property, out var el) && el.ValueKind == JsonValueKind.Number && el.TryGetInt32(out int value)
                ? value
                : fallback;
        }

        private static bool GetBool(JsonElement root, string property, bool fallback = false)
        {
            if (!root.TryGetProperty(property, out var el))
            {
                return fallback;
            }

            return el.ValueKind switch
            {
                JsonValueKind.True => true,
                JsonValueKind.False => false,
                _ => fallback
            };
        }
    }
}
