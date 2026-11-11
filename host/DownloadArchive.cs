using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text;
using System.Text.RegularExpressions;

namespace DownloaderHost
{
    /// <summary>
    /// "Base" des vidéos déjà téléchargées, sous forme de fichiers d'archive yt-dlp
    /// (--download-archive) : une ligne "extracteur id" par vidéo, un fichier par type de
    /// téléchargement (vidéo, audio...). yt-dlp y ajoute chaque vidéo terminée et ignore celles
    /// déjà présentes, ce qui permet de relancer une playlist pour n'obtenir que les nouveautés.
    /// Stockée hors du dossier de téléchargement pour rester valable même si on le change.
    /// </summary>
    public static class DownloadArchive
    {
        /// <summary>Types de téléchargement suivis (les fichiers annexes ne le sont pas).</summary>
        public static readonly string[] TrackedKinds = { "video", "video-no-audio", "video-with-all", "audio" };

        private static readonly Regex IdRegex = new Regex(@"^[A-Za-z0-9_\-]{1,64}$", RegexOptions.Compiled);
        private static readonly object FileLock = new object();

        public static string Folder => Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "YoutubeDownloader", "archive");

        public static bool IsTracked(string downloadType) => TrackedKinds.Contains(downloadType);

        public static bool IsValidId(string id) => !string.IsNullOrEmpty(id) && IdRegex.IsMatch(id);

        /// <summary>Chemin du fichier d'archive d'un type (créé si besoin).</summary>
        public static string PathFor(string downloadType)
        {
            Directory.CreateDirectory(Folder);
            return Path.Combine(Folder, downloadType + ".txt");
        }

        /// <summary>Types pour lesquels cet identifiant de vidéo est déjà archivé.</summary>
        public static List<string> KindsContaining(string videoId)
        {
            var kinds = new List<string>();
            if (!IsValidId(videoId)) return kinds;
            foreach (string kind in TrackedKinds)
            {
                string path = Path.Combine(Folder, kind + ".txt");
                if (ReadIds(path).Contains(videoId)) kinds.Add(kind);
            }
            return kinds;
        }

        /// <summary>
        /// Retire ces identifiants de toutes les archives. Renvoie le nombre de vidéos retirées
        /// (une vidéo présente dans plusieurs archives compte une seule fois).
        /// </summary>
        public static int Remove(IEnumerable<string> videoIds)
        {
            var ids = new HashSet<string>(videoIds.Where(IsValidId));
            if (ids.Count == 0 || !Directory.Exists(Folder)) return 0;

            var removed = new HashSet<string>();
            lock (FileLock)
            {
                foreach (string kind in TrackedKinds)
                {
                    string path = Path.Combine(Folder, kind + ".txt");
                    if (!File.Exists(path)) continue;

                    string[] lines = ReadAllLinesShared(path);
                    var kept = new List<string>(lines.Length);
                    bool changed = false;
                    foreach (string line in lines)
                    {
                        string? id = IdOf(line);
                        if (id != null && ids.Contains(id))
                        {
                            removed.Add(id);
                            changed = true;
                        }
                        else if (line.Trim().Length > 0)
                        {
                            kept.Add(line);
                        }
                    }
                    if (changed) WriteAllLinesShared(path, kept);
                }
            }
            return removed.Count;
        }

        /// <summary>
        /// Reprend les anciennes archives par chaîne (".archive-{type}-{qualité}.txt" dans le
        /// dossier de téléchargement) dans l'archive globale, puis les renomme en ".migrated"
        /// pour ne pas les retraiter.
        /// </summary>
        public static void MigrateLegacy(string outputDir)
        {
            try
            {
                if (!Directory.Exists(outputDir)) return;
                foreach (string legacy in Directory.GetFiles(outputDir, ".archive-*.txt"))
                {
                    string name = Path.GetFileNameWithoutExtension(legacy).Substring(".archive-".Length);
                    string? kind = TrackedKinds
                        .OrderByDescending(k => k.Length)
                        .FirstOrDefault(k => name.StartsWith(k + "-", StringComparison.Ordinal) || name == k);
                    if (kind == null) continue;

                    lock (FileLock)
                    {
                        string target = PathFor(kind);
                        var existing = ReadIds(target);
                        var toAdd = ReadAllLinesShared(legacy)
                            .Where(l => { string? id = IdOf(l); return id != null && existing.Add(id); })
                            .ToList();
                        if (toAdd.Count > 0)
                        {
                            File.AppendAllLines(target, toAdd, new UTF8Encoding(false));
                        }
                    }
                    File.Move(legacy, legacy + ".migrated", overwrite: true);
                }
            }
            catch
            {
                // Migration "best effort" : ne doit jamais bloquer un téléchargement.
            }
        }

        private static HashSet<string> ReadIds(string path)
        {
            var set = new HashSet<string>();
            if (!File.Exists(path)) return set;
            foreach (string line in ReadAllLinesShared(path))
            {
                string? id = IdOf(line);
                if (id != null) set.Add(id);
            }
            return set;
        }

        /// <summary>Une ligne d'archive yt-dlp est "extracteur id" (ex. "youtube dQw4w9WgXcQ").</summary>
        private static string? IdOf(string line)
        {
            string[] parts = line.Trim().Split(' ', 2, StringSplitOptions.RemoveEmptyEntries);
            return parts.Length == 2 ? parts[1].Trim() : null;
        }

        // yt-dlp peut écrire dans l'archive en parallèle (téléchargements simultanés) :
        // lecture/écriture en partage pour ne pas échouer sur un verrou.
        private static string[] ReadAllLinesShared(string path)
        {
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(fs, Encoding.UTF8);
            var lines = new List<string>();
            string? line;
            while ((line = reader.ReadLine()) != null) lines.Add(line);
            return lines.ToArray();
        }

        private static void WriteAllLinesShared(string path, List<string> lines)
        {
            using var fs = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.ReadWrite);
            using var writer = new StreamWriter(fs, new UTF8Encoding(false));
            foreach (string line in lines) writer.WriteLine(line);
        }
    }
}
