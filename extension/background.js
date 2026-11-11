// background.js
// Service worker MV3 - relais entre content.js / popup.js et l'hôte natif Windows (Native Messaging).
// Gère aussi la file d'attente de téléchargements, l'annulation et l'historique.

const NATIVE_HOST_ID = "com.youtube.downloader";
const HISTORY_KEY = "ytdl_history";
const OPTIONS_KEY = "ytdl_options";
const MAX_HISTORY = 100;
const CANCEL_GRACE_MS = 5000;

const DEFAULT_OPTIONS = {
  downloadFolder: "",
  ytDlpPath: "",
  ffmpegPath: "",
  defaultVideoFormat: "mp4",
  defaultAudioFormat: "mp3",
  preferredQuality: "1080p",
  // Si activé, le bouton lance directement le téléchargement vidéo à la qualité préférée.
  autoDownload: false,
  includeMetadataByDefault: true,
  filenameTemplate: "%(title)s.%(ext)s",
  cookiesFromBrowser: "none",
  // Mise à jour automatique de yt-dlp (au plus une fois par 24h, voir Downloader.cs côté hôte).
  autoUpdateYtDlp: true,
  // Nombre maximal de téléchargements simultanés ; les suivants attendent dans la file.
  maxConcurrent: 2,
  // Sous-titres : langues ("all" ou liste "fr,en") et conversion éventuelle ("", "srt", "vtt").
  subtitleLangs: "all",
  subtitleFormat: "",
  // SponsorBlock (via yt-dlp) : "off", "remove" (coupe les segments) ou "mark" (chapitres).
  sponsorBlockMode: "off",
  sponsorBlockCategories: ["sponsor", "selfpromo"]
};

// Ports natifs actifs, indexés par requestId (téléchargements en cours).
const activePorts = new Map();
// Fonctions de fin de tâche, pour annulation forcée / déconnexion.
const jobFinishers = new Map();
// Téléchargements en attente d'un créneau libre.
const queue = [];
let runningCount = 0;

function generateId() {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

async function getOptions() {
  const stored = await chrome.storage.sync.get(OPTIONS_KEY);
  return { ...DEFAULT_OPTIONS, ...(stored[OPTIONS_KEY] || {}) };
}

async function saveOptions(options) {
  await chrome.storage.sync.set({ [OPTIONS_KEY]: options });
}

// ---------------------------------------------------------------------------
// Historique. Les lectures-modifications-écritures sont sérialisées : avec des
// téléchargements simultanés, deux mises à jour concurrentes s'écraseraient.
// ---------------------------------------------------------------------------
let historyLock = Promise.resolve();

function withHistoryLock(fn) {
  const run = historyLock.then(fn);
  historyLock = run.catch(() => {});
  return run;
}

async function readHistory() {
  const stored = await chrome.storage.local.get(HISTORY_KEY);
  return stored[HISTORY_KEY] || [];
}

function getHistory() {
  return withHistoryLock(readHistory);
}

function pushHistory(entry) {
  return withHistoryLock(async () => {
    const history = await readHistory();
    history.unshift(entry);
    if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
    await chrome.storage.local.set({ [HISTORY_KEY]: history });
  });
}

function updateHistoryEntry(id, patch) {
  return withHistoryLock(async () => {
    const history = await readHistory();
    const idx = history.findIndex((h) => h.id === id);
    if (idx !== -1) {
      history[idx] = { ...history[idx], ...patch };
      await chrome.storage.local.set({ [HISTORY_KEY]: history });
    }
  });
}

function clearHistory() {
  // Les téléchargements actifs ou en attente restent affichés.
  return withHistoryLock(async () => {
    const history = await readHistory();
    const kept = history.filter((h) => h.status === "en cours" || h.status === "en attente");
    await chrome.storage.local.set({ [HISTORY_KEY]: kept });
  });
}

function connectNative() {
  try {
    return chrome.runtime.connectNative(NATIVE_HOST_ID);
  } catch (err) {
    return null;
  }
}

function broadcast(message) {
  chrome.runtime.sendMessage(message).catch(() => {});
  if (message.tabId) {
    chrome.tabs.sendMessage(message.tabId, message).catch(() => {});
  }
}

function updateBadge() {
  const total = runningCount + queue.length;
  try {
    chrome.action.setBadgeText({ text: total > 0 ? String(total) : "" });
    chrome.action.setBadgeBackgroundColor({ color: "#c81d1d" });
  } catch (e) {
    // badge indisponible : non critique
  }
}

/**
 * Échange ponctuel avec l'hôte natif : envoie un message, attend une réponse du type voulu.
 */
function nativeRequest(message, expectedType, timeoutMs) {
  return new Promise((resolve) => {
    const port = connectNative();
    if (!port) {
      resolve({ ok: false, error: "Impossible de se connecter à l'hôte natif. Vérifiez que l'application est installée." });
      return;
    }
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { port.disconnect(); } catch (e) {}
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ ok: false, error: "Délai d'attente dépassé en attendant l'hôte natif." }),
      timeoutMs
    );

    port.onMessage.addListener((msg) => {
      if (msg.type === expectedType) {
        finish({ ok: true, data: msg });
      } else if (msg.type === "error") {
        finish({ ok: false, error: msg.message || "Erreur inconnue de l'hôte natif." });
      }
    });
    port.onDisconnect.addListener(() => {
      const err = chrome.runtime.lastError;
      finish({ ok: false, error: err ? err.message : "Connexion à l'hôte natif interrompue." });
    });

    port.postMessage(message);
  });
}

function requestFormats(url, ytDlpPath, cookiesFromBrowser) {
  return nativeRequest({ action: "getFormats", url, ytDlpPath, cookiesFromBrowser }, "formats", 30000);
}

// ---------------------------------------------------------------------------
// Construction de la requête de téléchargement à partir du message de l'UI.
// ---------------------------------------------------------------------------
// Chaîne ou playlist entière : chaque vidéo est rangée dans un sous-dossier (nom de la chaîne
// ou titre de la playlist), sauf si le modèle de nom contient déjà un dossier.
function folderTemplate(message, options) {
  const template = String(options.filenameTemplate || "%(title)s.%(ext)s");
  if (template.includes("/") || template.includes("\\")) return template;
  if (message.channelMode) return "%(uploader,channel)s/" + template;
  const mode = message.playlistMode || "single";
  if (mode === "full" || mode === "fromCurrent") return "%(playlist_title,playlist|Playlist)s/" + template;
  return template;
}

function buildPayload(message, options) {
  return {
    url: message.url,
    title: message.title,
    downloadType: message.downloadType, // "video" | "audio" | "subtitle" | "thumbnail" | "description" | ...
    quality: message.quality,
    includeMetadata: !!message.includeMetadata,
    videoFormat: message.videoFormat || options.defaultVideoFormat,
    audioFormat: message.audioFormat || options.defaultAudioFormat,
    outputDir: options.downloadFolder,
    ytDlpPath: options.ytDlpPath,
    ffmpegPath: options.ffmpegPath,
    filenameTemplate: folderTemplate(message, options),
    playlistMode: message.playlistMode || "single", // "single" | "full" | "fromCurrent"
    // Téléchargement de toute une chaîne : sous-dossier par chaîne, archive de reprise, limite.
    channelMode: !!message.channelMode,
    playlistEnd: Number(message.playlistEnd) > 0 ? Math.floor(Number(message.playlistEnd)) : 0,
    cookiesFromBrowser: options.cookiesFromBrowser || "",
    autoUpdateYtDlp: options.autoUpdateYtDlp !== false,
    subtitleLangs: options.subtitleLangs || "all",
    subtitleFormat: options.subtitleFormat || "",
    sponsorBlockMode: options.sponsorBlockMode || "off",
    sponsorBlockCategories: Array.isArray(options.sponsorBlockCategories) ? options.sponsorBlockCategories.join(",") : "",
    // Téléchargement direct (podcasts radiofrance.fr, etc.) : présent seulement
    // quand la source fournit déjà un fichier audio public, sans passer par yt-dlp.
    directMediaUrl: message.directMediaUrl || "",
    directAuthor: message.directAuthor || "",
    directAlbum: message.directAlbum || "",
    directCoverUrl: message.directCoverUrl || "",
    directDescription: message.directDescription || "",
    directChapters: message.directChapters || "",
    directGenre: message.directGenre || ""
  };
}

// Sous-ensemble du message d'origine conservé dans l'historique pour pouvoir relancer.
function retryData(message) {
  const keys = [
    "url", "title", "downloadType", "quality", "includeMetadata", "videoFormat", "audioFormat",
    "playlistMode", "channelMode", "playlistEnd", "directMediaUrl", "directAuthor", "directAlbum", "directCoverUrl",
    "directDescription", "directChapters", "directGenre"
  ];
  const data = {};
  for (const k of keys) if (message[k] !== undefined) data[k] = message[k];
  return data;
}

// ---------------------------------------------------------------------------
// File d'attente
// ---------------------------------------------------------------------------

/**
 * Enregistre le téléchargement dans l'historique (état "en attente") puis le place dans la
 * file. L'entrée d'historique est écrite AVANT toute autre opération pour éviter qu'une
 * mise à jour rapide ne trouve pas l'entrée (race condition).
 */
async function enqueueDownload(message, tabId) {
  const options = await getOptions();
  const payload = buildPayload(message, options);
  const requestId = generateId();

  await pushHistory({
    id: requestId,
    title: payload.title || payload.url || payload.directMediaUrl,
    url: payload.url || payload.directMediaUrl,
    type: payload.downloadType,
    quality: payload.quality || payload.audioFormat || "",
    status: "en attente",
    percent: 0,
    stage: "",
    startedAt: Date.now(),
    retry: retryData(message)
  });

  queue.push({ requestId, payload, tabId });
  updateBadge();
  pumpQueue();
  return requestId;
}

async function pumpQueue() {
  const options = await getOptions();
  const max = Math.max(1, Math.min(6, Number(options.maxConcurrent) || 2));
  while (queue.length > 0 && runningCount < max) {
    const job = queue.shift();
    runningCount++;
    updateBadge();
    runJob(job)
      .catch(() => {})
      .finally(() => {
        runningCount--;
        updateBadge();
        pumpQueue();
      });
  }
}

function cancelDownload(requestId) {
  const queuedIdx = queue.findIndex((j) => j.requestId === requestId);
  if (queuedIdx !== -1) {
    const [job] = queue.splice(queuedIdx, 1);
    updateBadge();
    broadcast({ type: "download-cancelled", requestId, tabId: job.tabId });
    updateHistoryEntry(requestId, { status: "annulé", finishedAt: Date.now() });
    return true;
  }

  const port = activePorts.get(requestId);
  if (!port) return false;

  try { port.postMessage({ action: "cancel" }); } catch (e) {}
  // Filet de sécurité : si l'hôte ne confirme pas l'annulation, on force la fin.
  setTimeout(() => {
    const finisher = jobFinishers.get(requestId);
    if (finisher) finisher("cancelled");
  }, CANCEL_GRACE_MS);
  return true;
}

/**
 * Exécute un téléchargement. La promesse se résout quand il se termine
 * (succès, erreur, annulation ou déconnexion).
 */
function runJob({ requestId, payload, tabId }) {
  return new Promise((resolve) => {
    let done = false;

    const finish = (kind, data = {}) => {
      if (done) return;
      done = true;
      jobFinishers.delete(requestId);
      const port = activePorts.get(requestId);
      activePorts.delete(requestId);
      if (port) { try { port.disconnect(); } catch (e) {} }

      if (kind === "complete") {
        const skipped = Number(data.skipped) || 0;
        const total = Number(data.total) || 0;
        broadcast({ type: "download-complete", requestId, tabId, filePath: data.filePath, skipped, total });
        updateHistoryEntry(requestId, {
          status: "terminé", percent: 100, stage: "", filePath: data.filePath, skipped, total, finishedAt: Date.now()
        });
      } else if (kind === "cancelled") {
        broadcast({ type: "download-cancelled", requestId, tabId });
        updateHistoryEntry(requestId, { status: "annulé", stage: "", finishedAt: Date.now() });
      } else {
        broadcast({ type: "download-error", requestId, tabId, message: data.message });
        updateHistoryEntry(requestId, { status: "erreur", stage: "", error: data.message, finishedAt: Date.now() });
      }
      resolve();
    };

    const port = connectNative();
    if (!port) {
      finish("error", { message: "Impossible de se connecter à l'hôte natif." });
      return;
    }

    activePorts.set(requestId, port);
    jobFinishers.set(requestId, finish);
    updateHistoryEntry(requestId, { status: "en cours" });
    broadcast({ type: "download-started", requestId, tabId });

    port.onMessage.addListener((msg) => {
      if (msg.requestId && msg.requestId !== requestId) return;
      switch (msg.type) {
        case "progress":
          broadcast({ type: "download-progress", requestId, tabId, percent: msg.percent, stage: msg.stage });
          updateHistoryEntry(requestId, { percent: msg.percent, stage: msg.stage || "" });
          break;
        case "complete":
          finish("complete", { filePath: msg.filePath, skipped: msg.skipped, total: msg.total });
          break;
        case "cancelled":
          finish("cancelled");
          break;
        case "error":
          finish("error", { message: msg.message });
          break;
        default:
          break;
      }
    });

    port.onDisconnect.addListener(() => {
      if (!done) {
        const err = chrome.runtime.lastError;
        finish("error", { message: err ? err.message : "Hôte natif déconnecté." });
      }
    });

    port.postMessage({ action: "download", requestId, ...payload });
  });
}

// ---------------------------------------------------------------------------
// Messages de l'UI
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = sender.tab ? sender.tab.id : message.tabId;
  // Les actions qui touchent au système de fichiers ne sont acceptées que depuis les pages
  // de l'extension (popup, options), jamais depuis un content script injecté dans un site.
  // Une page d'options ouverte dans un onglet a aussi sender.tab : on se base donc sur l'URL
  // de l'expéditeur (origine de l'extension) et non sur la présence d'un onglet.
  const fromExtensionPage = !!sender.url && sender.url.startsWith(chrome.runtime.getURL(""));

  if (message.action === "getFormats") {
    getOptions().then((options) => {
      requestFormats(message.url, options.ytDlpPath, options.cookiesFromBrowser).then((result) => sendResponse(result));
    });
    return true; // réponse asynchrone
  }

  if (message.action === "download") {
    enqueueDownload(message, tabId).then((requestId) => sendResponse({ ok: true, requestId }));
    return true;
  }

  if (message.action === "cancel") {
    sendResponse({ ok: cancelDownload(message.requestId) });
    return false;
  }

  if (message.action === "retry") {
    if (!fromExtensionPage) return false;
    readHistory().then(async (history) => {
      const entry = history.find((h) => h.id === message.id);
      if (!entry || !entry.retry) {
        sendResponse({ ok: false });
        return;
      }
      const requestId = await enqueueDownload({ action: "download", ...entry.retry }, undefined);
      sendResponse({ ok: true, requestId });
    });
    return true;
  }

  if (message.action === "forgetArchive") {
    // Retire une vidéo (videoId) ou toutes celles d'une playlist/chaîne (url) de l'archive des
    // vidéos déjà téléchargées, pour pouvoir les retélécharger.
    getOptions().then((options) => {
      const scope = message.scope === "playlist" ? "playlist" : "video";
      nativeRequest(
        {
          action: "forgetArchive",
          scope,
          videoId: message.videoId || "",
          url: message.url || "",
          ytDlpPath: options.ytDlpPath,
          cookiesFromBrowser: options.cookiesFromBrowser || ""
        },
        "archiveForgotten",
        scope === "playlist" ? 300000 : 15000
      ).then(sendResponse);
    });
    return true;
  }

  if (message.action === "fetchText") {
    // Récupération d'un flux RSS Radio France pour le téléchargement par lot. Réservé aux
    // content scripts tournant sur radiofrance.fr et limité aux hôtes Radio France.
    fetchRadioFranceText(sender, message.url).then(sendResponse);
    return true;
  }

  if (message.action === "getOptions") {
    getOptions().then((options) => sendResponse({ ok: true, options }));
    return true;
  }

  if (message.action === "saveOptions") {
    saveOptions(message.options).then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.action === "getHistory") {
    getHistory().then((history) => sendResponse({ ok: true, history }));
    return true;
  }

  if (message.action === "clearHistory") {
    clearHistory().then(() => sendResponse({ ok: true }));
    return true;
  }

  if (message.action === "testConfig") {
    if (!fromExtensionPage) return false;
    nativeRequest(
      {
        action: "testConfig",
        ytDlpPath: message.ytDlpPath || "",
        ffmpegPath: message.ffmpegPath || "",
        outputDir: message.outputDir || ""
      },
      "testResult",
      45000
    ).then(sendResponse);
    return true;
  }

  if (message.action === "pickFolder") {
    if (!fromExtensionPage) return false;
    nativeRequest({ action: "pickFolder" }, "folderPicked", 300000).then(sendResponse);
    return true;
  }

  if (message.action === "revealPath") {
    if (!fromExtensionPage) return false;
    nativeRequest({ action: "revealPath", path: message.path || "" }, "revealResult", 10000).then(sendResponse);
    return true;
  }

  return false;
});

const MAX_FETCH_BYTES = 10 * 1024 * 1024;

function isHostOrSubdomain(hostname, domain) {
  return hostname === domain || hostname.endsWith("." + domain);
}

async function fetchRadioFranceText(sender, rawUrl) {
  try {
    const origin = sender && sender.tab && sender.tab.url ? new URL(sender.tab.url) : null;
    if (!origin || origin.protocol !== "https:" || !isHostOrSubdomain(origin.hostname, "radiofrance.fr")) {
      return { ok: false, error: "Appel non autorisé." };
    }
    const url = new URL(rawUrl);
    if (url.protocol !== "https:" ||
        !(isHostOrSubdomain(url.hostname, "radiofrance-podcast.net") || isHostOrSubdomain(url.hostname, "radiofrance.fr"))) {
      return { ok: false, error: "Adresse non autorisée." };
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 30000);
    try {
      const response = await fetch(url.href, { signal: controller.signal });
      if (!response.ok) return { ok: false, error: `Le flux RSS a répondu ${response.status}.` };
      const text = await response.text();
      if (text.length > MAX_FETCH_BYTES) return { ok: false, error: "Flux RSS trop volumineux." };
      return { ok: true, text };
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    return { ok: false, error: "Impossible de lire le flux RSS (" + (err && err.message ? err.message : err) + ")." };
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const options = await getOptions();
  await saveOptions(options);
});

// Si le service worker a été redémarré pendant un téléchargement, les entrées restées "en cours"
// ou "en attente" n'ont plus de port associé : on les marque comme interrompues.
(async function recoverOrphans() {
  await withHistoryLock(async () => {
    const history = await readHistory();
    let changed = false;
    for (const h of history) {
      if ((h.status === "en cours" || h.status === "en attente") && !activePorts.has(h.id)) {
        h.status = "erreur";
        h.error = "Interrompu (l'extension a été redémarrée).";
        changed = true;
      }
    }
    if (changed) await chrome.storage.local.set({ [HISTORY_KEY]: history });
  });
})();
