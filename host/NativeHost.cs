using System;
using System.IO;
using System.Text;
using System.Text.Json;

namespace DownloaderHost
{
    /// <summary>
    /// Implémente le protocole Chrome Native Messaging :
    /// chaque message est précédé de sa longueur encodée sur 4 octets (little-endian, uint32),
    /// suivie du corps du message encodé en UTF-8 (JSON).
    /// </summary>
    public static class NativeMessaging
    {
        private const int MaxMessageSize = 1024 * 1024 * 64; // 64 Mo, garde-fou

        /// <summary>
        /// Lit un message depuis le flux d'entrée. Retourne null si le flux est fermé (EOF),
        /// ce qui signifie que Chrome a coupé la connexion (port.disconnect()).
        /// </summary>
        public static string? ReadMessage(Stream input)
        {
            byte[] lengthBuffer = new byte[4];
            int totalRead = ReadExact(input, lengthBuffer, 4);
            if (totalRead < 4)
            {
                return null;
            }

            int length = BitConverter.ToInt32(lengthBuffer, 0);
            if (length <= 0 || length > MaxMessageSize)
            {
                return null;
            }

            byte[] messageBuffer = new byte[length];
            int got = ReadExact(input, messageBuffer, length);
            if (got < length)
            {
                return null;
            }

            return Encoding.UTF8.GetString(messageBuffer);
        }

        private static int ReadExact(Stream input, byte[] buffer, int count)
        {
            int totalRead = 0;
            while (totalRead < count)
            {
                int read = input.Read(buffer, totalRead, count - totalRead);
                if (read == 0)
                {
                    break; // flux fermé
                }
                totalRead += read;
            }
            return totalRead;
        }

        /// <summary>
        /// Sérialise l'objet en JSON et l'écrit sur le flux de sortie avec l'en-tête de longueur requis.
        /// Un verrou global protège contre les écritures concurrentes (progression + fin, par exemple).
        /// </summary>
        private static readonly object WriteLock = new object();

        public static void WriteMessage(Stream output, object message)
        {
            string json = JsonSerializer.Serialize(message);
            byte[] jsonBytes = Encoding.UTF8.GetBytes(json);
            byte[] lengthBytes = BitConverter.GetBytes(jsonBytes.Length);

            lock (WriteLock)
            {
                output.Write(lengthBytes, 0, lengthBytes.Length);
                output.Write(jsonBytes, 0, jsonBytes.Length);
                output.Flush();
            }
        }
    }
}
