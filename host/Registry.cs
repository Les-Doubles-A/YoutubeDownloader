using System;
using Microsoft.Win32;

namespace DownloaderHost
{
    /// <summary>
    /// Accès en lecture/écriture aux paramètres de secours stockés dans
    /// HKCU\Software\YoutubeDownloader. Sert de repli lorsque l'extension
    /// n'a pas transmis de valeur (ex : premier lancement, options vides).
    /// </summary>
    public static class Registry
    {
        private const string KeyPath = @"Software\YoutubeDownloader";

        public static string? GetValue(string name)
        {
            try
            {
                using RegistryKey? key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(KeyPath);
                if (key == null) return null;
                object? value = key.GetValue(name);
                return value as string;
            }
            catch (Exception)
            {
                return null;
            }
        }

        public static void SetValue(string name, string value)
        {
            try
            {
                using RegistryKey key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(KeyPath);
                key.SetValue(name, value, RegistryValueKind.String);
            }
            catch (Exception)
            {
                // L'échec d'écriture registre n'est pas critique : on continue sans persister.
            }
        }

        public static void DeleteValue(string name)
        {
            try
            {
                using RegistryKey? key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(KeyPath, writable: true);
                key?.DeleteValue(name, throwOnMissingValue: false);
            }
            catch (Exception)
            {
                // ignoré
            }
        }
    }
}
