// content.js
// Injecte le bouton "Télécharger" sous chaque vidéo YouTube et gère le menu de sélection.

(function () {
  const BUTTON_ID = "ytdl-download-button";
  const MENU_ID = "ytdl-download-menu";
  const FLOAT_ID = "ytdl-download-floating";
  let currentVideoUrl = null;
  let currentVideoTitle = null;
  let activeRequestId = null;

  // BUG CORRIGÉ : quand l'extension est rechargée/mise à jour dans chrome://extensions (ou
  // redémarrée par Chrome) pendant qu'un onglet YouTube est déjà ouvert, ce content.js reste
  // injecté dans la page mais son pont vers l'extension est coupé — `chrome.runtime` devient
  // alors `undefined` (pas juste `chrome.runtime.sendMessage` qui échoue). Sans cette garde,
  // `chrome.runtime.sendMessage(...)` plantait avec "Cannot read properties of undefined
  // (reading 'sendMessage')", une exception non gérée qui bloquait le menu sur "Analyse de la
  // vidéo…" sans aucun message compréhensible pour l'utilisateur.
  function isExtensionContextValid() {
    return typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id;
  }

  const CONTEXT_INVALIDATED_MESSAGE =
    "L'extension a été rechargée ou mise à jour. Actualisez cette page (F5) pour continuer à télécharger.";

  function getVideoId(url) {
    try {
      const u = new URL(url);
      return u.searchParams.get("v");
    } catch (e) {
      return null;
    }
  }

  // Identifiant de la vidéo de la page (watch?v=ID ou /shorts/ID), ou null.
  function currentPageVideoId() {
    const fromQuery = getVideoId(location.href);
    if (fromQuery) return fromQuery;
    const m = location.pathname.match(/^\/shorts\/([A-Za-z0-9_-]+)/);
    return m ? m[1] : null;
  }

  const ARCHIVE_KIND_LABELS = {
    "video": "vidéo",
    "video-no-audio": "vidéo sans audio",
    "video-with-all": "vidéo complète",
    "audio": "audio"
  };

  /**
   * Retire une vidéo (scope "video") ou toutes les vidéos d'une playlist/chaîne (scope
   * "playlist") de l'archive des vidéos déjà téléchargées. Renvoie la réponse du background.
   */
  async function forgetArchive(scope, target) {
    if (!isExtensionContextValid()) return { ok: false, error: CONTEXT_INVALIDATED_MESSAGE };
    try {
      const msg = { action: "forgetArchive", scope };
      if (scope === "playlist") msg.url = target; else msg.videoId = target;
      const res = await chrome.runtime.sendMessage(msg);
      return res || { ok: false, error: "Pas de réponse." };
    } catch (err) {
      return { ok: false, error: CONTEXT_INVALIDATED_MESSAGE };
    }
  }

  function getVideoTitle() {
    const el =
      document.querySelector("h1.ytd-watch-metadata yt-formatted-string") ||
      document.querySelector("h1.title yt-formatted-string") ||
      document.querySelector("h1.ytd-video-primary-info-renderer");
    return el ? el.textContent.trim() : document.title.replace(" - YouTube", "");
  }

  function findActionsContainer() {
    return (
      document.querySelector("#top-level-buttons-computed")?.closest("#actions") ||
      document.querySelector("ytd-menu-renderer.ytd-watch-metadata") ||
      document.querySelector("#actions #menu") ||
      document.querySelector("#actions")
    );
  }

  // Pages prises en charge : vidéo (/watch), Shorts (/shorts/ID) et page de playlist (/playlist).
  // Shorts et playlist n'ont pas de barre d'actions stable : le bouton est alors flottant.
  // Page de chaîne : /@handle, /channel/ID, /c/nom ou /user/nom (avec ou sans onglet).
  const CHANNEL_TABS = ["", "videos", "featured", "shorts", "streams", "live"];

  function channelParts() {
    const parts = location.pathname.split("/").filter(Boolean);
    if (parts.length === 0) return null;
    const head = parts[0];
    const baseLen = head.startsWith("@") ? 1 : (["channel", "c", "user"].includes(head) ? 2 : 0);
    if (baseLen === 0 || parts.length < baseLen) return null;
    const tab = parts[baseLen] || "";
    if (parts.length > baseLen + 1 || !CHANNEL_TABS.includes(tab)) return null;
    return { base: "/" + parts.slice(0, baseLen).join("/") };
  }

  function isChannelPage() {
    return channelParts() !== null;
  }

  function channelTabUrl(tab) {
    const info = channelParts();
    return info ? location.origin + info.base + "/" + tab : location.href;
  }

  function isFloatingPage() {
    return location.pathname.startsWith("/shorts/") || location.pathname === "/playlist" || isChannelPage();
  }

  function isWatchPage() {
    return location.pathname === "/watch" || isFloatingPage();
  }

  function buildButton() {
    const btn = document.createElement("button");
    btn.id = BUTTON_ID;
    btn.className = "ytdl-btn";
    btn.type = "button";
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
        <path d="M12 3v10.59l3.3-3.3 1.41 1.42L12 16.41l-4.71-4.7 1.41-1.42 3.3 3.3V3h2zM5 20h14v-2H5v2z"/>
      </svg>
      <span>Télécharger</span>
    `;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMenu(btn);
    });
    return btn;
  }

  function removeMenu() {
    const existing = document.getElementById(MENU_ID);
    if (existing) existing.remove();
  }

  function toggleMenu(anchorBtn) {
    const existing = document.getElementById(MENU_ID);
    if (existing) {
      existing.remove();
      return;
    }
    buildMenu(anchorBtn);
  }

  async function buildMenu(anchorBtn) {
    const menu = document.createElement("div");
    menu.id = MENU_ID;
    menu.className = "ytdl-menu";
    menu.innerHTML = `<div class="ytdl-menu-loading">Analyse de la vidéo…</div>`;
    anchorBtn.parentElement.appendChild(menu);

    if (!isExtensionContextValid()) {
      menu.innerHTML = `<div class="ytdl-menu-error">${escapeHtml(CONTEXT_INVALIDATED_MESSAGE)}</div>`;
      return;
    }

    // Téléchargement en un clic : qualité préférée, sans afficher le menu de choix.
    let prefs = null;
    try {
      const prefsRes = await chrome.runtime.sendMessage({ action: "getOptions" });
      prefs = prefsRes && prefsRes.options;
    } catch (err) {
      prefs = null;
    }
    if (prefs && prefs.autoDownload && !isChannelPage()) {
      menu.innerHTML = PROGRESS_HTML;
      const playlistMode = location.pathname === "/playlist" ? "full" : "single";
      startDownload(menu, "video", prefs.preferredQuality || "best", playlistMode, !!prefs.includeMetadataByDefault);
      return;
    }

    let response;
    try {
      response = await chrome.runtime.sendMessage({
        action: "getFormats",
        url: currentVideoUrl
      });
    } catch (err) {
      // "Extension context invalidated" peut aussi se produire APRÈS l'appel (rechargement
      // pendant la requête), ce qui rejette la promesse plutôt que de planter avant l'appel.
      menu.innerHTML = `<div class="ytdl-menu-error">${escapeHtml(CONTEXT_INVALIDATED_MESSAGE)}</div>`;
      return;
    }

    if (!response || !response.ok) {
      menu.innerHTML = `<div class="ytdl-menu-error">${escapeHtml(
        (response && response.error) || "Erreur lors de l'analyse de la vidéo."
      )}</div>`;
      return;
    }

    let optionsRes;
    try {
      optionsRes = await chrome.runtime.sendMessage({ action: "getOptions" });
    } catch (err) {
      optionsRes = null;
    }
    const includeMetadataDefault = !!(optionsRes && optionsRes.options && optionsRes.options.includeMetadataByDefault);

    renderMenu(menu, response.data, includeMetadataDefault);
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  const PROGRESS_HTML = `
      <div class="ytdl-progress-wrap">
        <div class="ytdl-progress-bar"><div class="ytdl-progress-fill"></div></div>
        <div class="ytdl-progress-label">En attente…</div>
        <button type="button" class="ytdl-cancel" style="display:none;">Annuler</button>
      </div>`;

  const VIDEO_QUALITIES = ["4320p", "2160p", "1440p", "1080p", "720p", "480p", "360p"];

  function renderMenu(menu, data, includeMetadataDefault) {
    const availableHeights = new Set((data.availableHeights || []).map(String));
    const hasBest = true;

    const videoItems = [];
    if (hasBest) {
      videoItems.push(`<button class="ytdl-item" data-type="video" data-quality="best">Meilleure qualité</button>`);
    }
    for (const q of VIDEO_QUALITIES) {
      const height = q.replace("p", "");
      if (availableHeights.size === 0 || availableHeights.has(height)) {
        videoItems.push(`<button class="ytdl-item" data-type="video" data-quality="${q}">${q}</button>`);
      }
    }

    const audioItems = ["mp3", "m4a", "flac", "wav"]
      .map(
        (fmt) =>
          `<button class="ytdl-item" data-type="audio" data-quality="${fmt}">${fmt.toUpperCase()}</button>`
      )
      .join("");

    const channel = isChannelPage();

    const otherItems = channel
      ? `<button class="ytdl-item" data-type="subtitle">Sous-titres</button>`
      : `
      <button class="ytdl-item" data-type="video-no-audio" data-quality="best">Vidéo sans audio</button>
      <button class="ytdl-item" data-type="video-with-all" data-quality="best">Vidéo + audio/sous-titres</button>
      <button class="ytdl-item" data-type="subtitle">Sous-titres</button>
      <button class="ytdl-item" data-type="thumbnail">Miniature</button>
      <button class="ytdl-item" data-type="description">Description</button>
    `;

    const channelSection = `
      <div class="ytdl-section-title">Toute la chaîne</div>
      <div class="ytdl-playlist-options">
        <label>Contenu
          <select id="ytdl-channel-tab">
            <option value="videos">Vidéos</option>
            <option value="shorts">Shorts</option>
            <option value="streams">Directs terminés</option>
          </select>
        </label>
        <label>Nombre max (vide = toutes)
          <input type="number" id="ytdl-channel-max" min="1" placeholder="toutes" />
        </label>
        <div class="ytdl-hint">Chaque vidéo est rangée dans un dossier au nom de la chaîne. Les vidéos déjà téléchargées sont ignorées si vous relancez.</div>
        <button type="button" class="ytdl-cancel ytdl-forget-playlist">Retélécharger toute la chaîne</button>
      </div>`;

    const playlistSection = channel ? channelSection : data.isPlaylist
      ? `
      <div class="ytdl-section-title">Playlist</div>
      <div class="ytdl-playlist-options">
        <label><input type="radio" name="ytdl-playlist" value="single" ${location.pathname === "/playlist" ? "" : "checked"}> Vidéo actuelle</label>
        <label><input type="radio" name="ytdl-playlist" value="full" ${location.pathname === "/playlist" ? "checked" : ""}> Playlist entière</label>
        <label><input type="radio" name="ytdl-playlist" value="fromCurrent"> À partir d'ici</label>
        <div class="ytdl-hint">La playlist est rangée dans un dossier à son nom. Les vidéos déjà téléchargées sont ignorées : relancer ne récupère que les nouvelles.</div>
        <button type="button" class="ytdl-cancel ytdl-forget-playlist">Retélécharger toute la playlist</button>
      </div>`
      : "";

    // Vidéo seule déjà présente dans l'archive (pas sur une page playlist/chaîne).
    const pageVideoId = location.pathname === "/playlist" || channel ? null : currentPageVideoId();
    const archivedKinds = pageVideoId && data.videoId === pageVideoId ? (data.archivedKinds || []) : [];
    const archivedBanner = archivedKinds.length
      ? `
      <div class="ytdl-archived">
        <span class="ytdl-archived-text">Déjà téléchargée (${escapeHtml(archivedKinds.map((k) => ARCHIVE_KIND_LABELS[k] || k).join(", "))}) : elle sera ignorée.</span>
        <button type="button" class="ytdl-cancel ytdl-redownload">Retélécharger</button>
      </div>`
      : "";

    menu.innerHTML = `
      ${archivedBanner}
      <div class="ytdl-metadata-option">
        <label>
          <input type="checkbox" id="ytdl-include-metadata" ${includeMetadataDefault ? "checked" : ""} />
          Infos complémentaires (cover, titre, artiste, album, description, chapitres) — tout dans un seul fichier
        </label>
      </div>
      <div class="ytdl-section-title">Vidéo</div>
      <div class="ytdl-grid">${videoItems.join("")}</div>
      <div class="ytdl-section-title">Audio</div>
      <div class="ytdl-grid">${audioItems}</div>
      <div class="ytdl-section-title">Autres</div>
      <div class="ytdl-grid">${otherItems}</div>
      ${playlistSection}
      <div class="ytdl-progress-wrap" style="display:none;">
        <div class="ytdl-progress-bar"><div class="ytdl-progress-fill"></div></div>
        <div class="ytdl-progress-label">0%</div>
        <button type="button" class="ytdl-cancel" style="display:none;">Annuler</button>
      </div>
    `;

    menu.querySelectorAll(".ytdl-item").forEach((item) => {
      item.addEventListener("click", () => {
        const type = item.dataset.type;
        const quality = item.dataset.quality;
        const playlistRadio = menu.querySelector('input[name="ytdl-playlist"]:checked');
        const playlistMode = isChannelPage() ? "full" : (playlistRadio ? playlistRadio.value : "single");
        if (isChannelPage()) {
          const maxEl = menu.querySelector("#ytdl-channel-max");
          const max = maxEl && maxEl.value ? maxEl.value : "toutes les";
          if (!window.confirm(`Télécharger ${max} vidéos de cette chaîne ? Cela peut prendre beaucoup de temps et d'espace disque.`)) {
            return;
          }
        }
        const metadataCheckbox = menu.querySelector("#ytdl-include-metadata");
        const includeMetadata = metadataCheckbox ? metadataCheckbox.checked : false;
        startDownload(menu, type, quality, playlistMode, includeMetadata);
      });
    });

    const redownloadBtn = menu.querySelector(".ytdl-redownload");
    if (redownloadBtn) {
      redownloadBtn.addEventListener("click", async () => {
        const text = menu.querySelector(".ytdl-archived-text");
        redownloadBtn.disabled = true;
        const res = await forgetArchive("video", pageVideoId);
        if (res.ok) {
          text.textContent = "Retirée des vidéos téléchargées : choisissez un format pour la retélécharger.";
          redownloadBtn.remove();
        } else {
          text.textContent = `Erreur : ${res.error || "inconnue"}`;
          redownloadBtn.disabled = false;
        }
      });
    }

    const forgetPlaylistBtn = menu.querySelector(".ytdl-forget-playlist");
    if (forgetPlaylistBtn) {
      forgetPlaylistBtn.addEventListener("click", async () => {
        const what = channel ? "de cette chaîne" : "de cette playlist";
        if (!window.confirm(`Oublier toutes les vidéos ${what} déjà téléchargées ? Elles seront retéléchargées au prochain téléchargement.`)) {
          return;
        }
        const tabEl = menu.querySelector("#ytdl-channel-tab");
        const url = channel ? channelTabUrl(tabEl ? tabEl.value : "videos") : currentVideoUrl;
        const original = forgetPlaylistBtn.textContent;
        forgetPlaylistBtn.disabled = true;
        forgetPlaylistBtn.textContent = "Analyse des vidéos…";
        const res = await forgetArchive("playlist", url);
        forgetPlaylistBtn.disabled = false;
        forgetPlaylistBtn.textContent = original;
        menu.querySelectorAll(".ytdl-forget-result").forEach((el) => el.remove());
        const hint = document.createElement("div");
        hint.className = "ytdl-hint ytdl-forget-result";
        hint.textContent = res.ok
          ? `${res.data.removed} vidéo(s) retirée(s) sur ${res.data.listed}. Choisissez un format pour tout retélécharger.`
          : `Erreur : ${res.error || "inconnue"}`;
        forgetPlaylistBtn.insertAdjacentElement("afterend", hint);
      });
    }
  }

  function startDownload(menu, downloadType, quality, playlistMode, includeMetadata) {
    const progressWrap = menu.querySelector(".ytdl-progress-wrap");
    const fill = menu.querySelector(".ytdl-progress-fill");
    const label = menu.querySelector(".ytdl-progress-label");
    const cancelBtn = progressWrap.querySelector(".ytdl-cancel");
    progressWrap.style.display = "block";
    label.textContent = "En attente…";

    if (!isExtensionContextValid()) {
      label.textContent = CONTEXT_INVALIDATED_MESSAGE;
      return;
    }

    const payload = {
      action: "download",
      url: currentVideoUrl,
      title: currentVideoTitle,
      downloadType,
      playlistMode,
      includeMetadata: !!includeMetadata
    };
    if (downloadType === "video" || downloadType === "video-no-audio" || downloadType === "video-with-all") payload.quality = quality;
    if (downloadType === "audio") payload.audioFormat = quality;

    if (isChannelPage()) {
      const tabEl = menu.querySelector("#ytdl-channel-tab");
      const maxEl = menu.querySelector("#ytdl-channel-max");
      payload.url = channelTabUrl(tabEl ? tabEl.value : "videos");
      payload.channelMode = true;
      payload.playlistMode = "full";
      payload.playlistEnd = maxEl && maxEl.value ? Math.max(1, parseInt(maxEl.value, 10) || 0) : 0;
    }

    const oldRedo = progressWrap.querySelector(".ytdl-redo");
    if (oldRedo) oldRedo.remove();

    // Fin de téléchargement : signale les vidéos ignorées car déjà téléchargées et propose
    // de les retélécharger (oubli dans l'archive puis relance du même téléchargement).
    function showCompletion(msg) {
      const skipped = Number(msg.skipped) || 0;
      if (skipped === 0) {
        label.textContent = "Terminé ✓";
        return;
      }
      const isList = payload.playlistMode === "full" || payload.playlistMode === "fromCurrent" || payload.channelMode;
      const videoId = isList ? null : currentPageVideoId();
      if (isList) {
        const total = Math.max(Number(msg.total) || 0, skipped);
        label.textContent = `Terminé ✓ ${total - skipped} nouvelle(s), ${skipped} déjà téléchargée(s) ignorée(s)`;
      } else {
        label.textContent = "Déjà téléchargée : ignorée.";
      }
      if (!isList && !videoId) return;

      const redo = document.createElement("button");
      redo.type = "button";
      redo.className = "ytdl-cancel ytdl-redo";
      redo.textContent = isList ? "Retélécharger les ignorées" : "Retélécharger";
      redo.addEventListener("click", async () => {
        redo.disabled = true;
        label.textContent = isList ? "Analyse des vidéos…" : "Préparation…";
        const res = await forgetArchive(isList ? "playlist" : "video", isList ? payload.url : videoId);
        if (!res.ok) {
          label.textContent = `Erreur : ${res.error || "inconnue"}`;
          redo.disabled = false;
          return;
        }
        redo.remove();
        fill.style.width = "0%";
        if (cancelBtn) cancelBtn.disabled = false;
        sendDownload();
      });
      progressWrap.appendChild(redo);
    }

    sendDownload();

    function sendDownload() {
      label.textContent = "En attente…";
      chrome.runtime.sendMessage(payload).then((res) => {
        if (!res || !res.ok) {
          label.textContent = "Erreur";
          return;
        }

        activeRequestId = res.requestId;
        const thisRequestId = res.requestId;

        if (cancelBtn) {
          cancelBtn.style.display = "inline-block";
          cancelBtn.onclick = () => {
            cancelBtn.disabled = true;
            label.textContent = "Annulation…";
            chrome.runtime.sendMessage({ action: "cancel", requestId: thisRequestId }).catch(() => {});
          };
        }

        function listener(msg) {
          if (!msg.requestId || msg.requestId !== thisRequestId) return;
          if (msg.type === "download-progress") {
            fill.style.width = `${msg.percent}%`;
            label.textContent = `${msg.percent}% ${msg.stage ? "- " + msg.stage : ""}`;
          } else if (msg.type === "download-complete") {
            fill.style.width = "100%";
            if (cancelBtn) cancelBtn.style.display = "none";
            chrome.runtime.onMessage.removeListener(listener);
            showCompletion(msg);
          } else if (msg.type === "download-cancelled") {
            label.textContent = "Annulé";
            if (cancelBtn) cancelBtn.style.display = "none";
            chrome.runtime.onMessage.removeListener(listener);
          } else if (msg.type === "download-error") {
            label.textContent = `Erreur : ${msg.message}`;
            if (cancelBtn) cancelBtn.style.display = "none";
            chrome.runtime.onMessage.removeListener(listener);
          }
        }

        chrome.runtime.onMessage.addListener(listener);
      }).catch(() => {
        // Contexte invalidé pendant l'envoi (rechargement de l'extension en plein téléchargement).
        label.textContent = CONTEXT_INVALIDATED_MESSAGE;
      });
    }
  }

  function injectButton() {
    if (!isWatchPage()) return;
    // Sur une page de chaîne, l'analyse des formats porte sur l'onglet "Vidéos".
    currentVideoUrl = isChannelPage() ? channelTabUrl("videos") : location.href;
    currentVideoTitle = getVideoTitle();

    let btn = document.getElementById(BUTTON_ID);
    if (btn) return; // déjà injecté pour cette page

    if (isFloatingPage()) {
      const wrap = document.createElement("div");
      wrap.id = FLOAT_ID;
      wrap.className = "ytdl-floating";
      wrap.appendChild(buildButton());
      document.body.appendChild(wrap);
      return;
    }

    const container = findActionsContainer();
    if (!container) return;

    btn = buildButton();
    container.appendChild(btn);
  }

  function handleNavigation() {
    removeMenu();
    const existingBtn = document.getElementById(BUTTON_ID);
    if (existingBtn) existingBtn.remove();
    const existingFloat = document.getElementById(FLOAT_ID);
    if (existingFloat) existingFloat.remove();
    setTimeout(injectButton, 800);
  }

  document.addEventListener("click", (e) => {
    const menu = document.getElementById(MENU_ID);
    if (menu && !menu.contains(e.target) && e.target.id !== BUTTON_ID && !e.target.closest(`#${BUTTON_ID}`)) {
      menu.remove();
    }
  });

  document.addEventListener("yt-navigate-finish", handleNavigation);
  window.addEventListener("load", () => setTimeout(injectButton, 1000));

  // YouTube mute le DOM en continu : on regroupe les rafales de mutations en une seule
  // vérification par frame au lieu de requêter le DOM à chaque mutation.
  let injectScheduled = false;
  const observer = new MutationObserver(() => {
    if (injectScheduled) return;
    injectScheduled = true;
    requestAnimationFrame(() => {
      injectScheduled = false;
      if (isWatchPage() && !document.getElementById(BUTTON_ID)) {
        injectButton();
      }
    });
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
