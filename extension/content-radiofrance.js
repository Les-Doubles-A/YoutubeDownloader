// content-radiofrance.js
// Ajoute un bouton "Télécharger" sur les pages podcast radiofrance.fr (France Culture,
// France Inter, France Musique, franceinfo, etc.) et extrait les métadonnées publiques de
// la page (titre, auteur, cover, description, URL audio) pour un téléchargement direct +
// tagging.
//
// Les épisodes radiofrance.fr sont diffusés en clair (pas de DRM) : le fichier audio est
// exposé directement dans le DOM via une balise <audio src="...">. On ne fait ici que lire
// les informations déjà publiques de la page, comme le ferait n'importe quel lecteur de
// podcasts / agrégateur RSS.

(function () {
  const BUTTON_ID = "ytdl-rf-download-button";
  const MENU_ID = "ytdl-rf-download-menu";

  // BUG CORRIGÉ : voir le même correctif dans content.js — quand l'extension est
  // rechargée/mise à jour pendant qu'un onglet radiofrance.fr est déjà ouvert,
  // `chrome.runtime` devient `undefined` dans ce content script déjà injecté, et
  // `chrome.runtime.sendMessage(...)` plantait avec une exception non gérée au lieu
  // d'afficher un message compréhensible.
  function isExtensionContextValid() {
    return typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id;
  }

  const CONTEXT_INVALIDATED_MESSAGE =
    "L'extension a été rechargée ou mise à jour. Actualisez cette page (F5) pour continuer à télécharger.";

  function getMeta(property) {
    const el = document.querySelector(`meta[property="${property}"]`) || document.querySelector(`meta[name="${property}"]`);
    return el ? el.getAttribute("content") || "" : "";
  }

  function siteBrandName() {
    // Le nom de la chaîne (franceinfo, France Inter, France Culture...) est toujours exposé
    // via og:site_name. BUG CORRIGÉ : le fallback était auparavant figé sur "France Culture"
    // en dur, ce qui produisait un mauvais tag "album"/"artiste" sur toutes les autres
    // chaînes (ex. franceinfo, France Inter...).
    return getMeta("og:site_name") || "Radio France";
  }

  function cleanTitle(raw) {
    // BUG CORRIGÉ : ces regex ne correspondaient plus au format réel des balises <title>/
    // og:title du site (ex. "Les voies de l'IA : écouter le podcast et replay | franceinfo"),
    // donc rien n'était jamais retiré et le titre de fallback restait sale.
    return (raw || "")
      .replace(/\s*[:\-–]\s*(ré)?écouter(\s+le)?\s+podcast(\s+et\s+replay)?\s*$/i, "")
      .replace(/\s*:\s*un podcast à écouter en ligne\s*$/i, "")
      .replace(/\s*\|\s*(franceinfo|france ?(culture|inter|musique|bleu)|mouv'?|fip)\s*$/i, "")
      .trim();
  }

  function findAudioUrl() {
    const audioEl = document.querySelector("audio[src]");
    if (audioEl) return audioEl.getAttribute("src");

    const sourceEl = document.querySelector("audio source[src]");
    if (sourceEl) return sourceEl.getAttribute("src");

    return null;
  }

  function findCoverUrl() {
    // Repli "page entière" : la première image /pikapi/images/ trouvée dans le DOM. On ne
    // garde que les images servies par /pikapi/images/ (CDN dédié aux covers), par
    // opposition aux logos/visuels génériques du site qui vivent ailleurs.
    //
    // BUG CONNU (voir findCoverNearEpisode ci-dessous, utilisé en priorité) : sur une page
    // qui liste plusieurs épisodes/podcasts (page émission, "à écouter aussi"...), la
    // PREMIÈRE image /pikapi/images/ du DOM n'est pas forcément celle de l'épisode
    // réellement en cours de lecture — elle peut appartenir à un épisode voisin dans la
    // liste. Cette fonction ne sert donc que de dernier recours.
    //
    // Important : on utilise l'URL EXACTEMENT telle que fournie par la page (ex. .../200x200),
    // sans essayer de deviner une résolution plus grande. Cette API d'images n'accepte
    // vraisemblablement que certains formats prédéfinis ; demander une taille arbitraire
    // (ex. 1400x1400) peut renvoyer une image de repli générique au lieu de la vraie cover.
    const candidates = Array.from(document.querySelectorAll('img[data-testid="image-tag"], img[data-testid="ImageRatio"]'))
      .map((img) => img.getAttribute("src"))
      .filter((src) => src && src.includes("/pikapi/images/"));

    if (candidates.length > 0) {
      return candidates[0];
    }

    return getMeta("og:image");
  }

  // Trouve la cover LA PLUS PROCHE du lien "épisode" du lecteur global, en distance réelle
  // dans l'arbre DOM (nombre de sauts pour atteindre l'ancêtre commun), plutôt qu'en
  // remontant un nombre fixe de niveaux de parents.
  //
  // BUG CORRIGÉ : la version précédente remontait au plus 8 niveaux depuis le lien puis
  // prenait la PREMIÈRE image /pikapi/images/ trouvée dans ce conteneur. Le DOM généré par
  // Svelte étant très profondément imbriqué (beaucoup de <div> wrappers), soit la cover et
  // le lien ne partageaient pas d'ancêtre commun avant 8 niveaux (résultat : rien trouvé, on
  // retombait sur l'ancien fallback bugué), soit le conteneur trouvé contenait déjà une AUTRE
  // image avant la vraie cover (résultat : mauvaise image). On calcule maintenant, pour
  // chaque image candidate de la page, sa distance réelle au lien épisode, et on garde la
  // plus proche.
  function pathToRoot(el) {
    const path = [];
    let node = el;
    while (node) {
      path.push(node);
      node = node.parentElement;
    }
    return path;
  }

  function domDistance(elA, elB) {
    const pathA = pathToRoot(elA);
    const pathB = pathToRoot(elB);
    const indexInB = new Map();
    pathB.forEach((n, i) => indexInB.set(n, i));
    for (let i = 0; i < pathA.length; i++) {
      if (indexInB.has(pathA[i])) {
        return i + indexInB.get(pathA[i]);
      }
    }
    return Infinity; // pas d'ancêtre commun (ne devrait pas arriver dans un même document)
  }

  function findCoverNearEpisode(episodeEl) {
    if (!episodeEl) return null;

    // Structure réelle du lecteur global radiofrance.fr (confirmée par inspection du DOM
    // en direct) :
    //
    // <div class="Metadata">
    //   <div class="cover"><div class="Cover"><picture>
    //     <img data-testid="image-tag" src="https://www.radiofrance.fr/pikapi/images/...">
    //   </picture></div></div>
    //   <div class="details"><section class="Descriptions">
    //     <div class="Line firstline"><a data-testid="link" href=".../podcasts/show"><span>Album</span></a></div>
    //     <div class="Line secondline"><a data-testid="link" href=".../podcasts/show/episode"><span>Titre</span></a></div>
    //   </section></div>
    // </div>
    //
    // "Metadata" est un nom de classe LITTÉRAL du composant (pas un hash généré au build,
    // contrairement à "svelte-xxxxx" accolé à côté) : c'est donc un point d'ancrage stable.
    // On remonte depuis le lien de l'épisode jusqu'à ce conteneur, puis on y cherche l'image
    // — ça cible exactement LA cover de CE lecteur, sans ambiguïté.
    const metadataBlock = episodeEl.closest(".Metadata") || episodeEl.closest('[class~="Metadata"]');
    if (metadataBlock) {
      const img =
        metadataBlock.querySelector('img[data-testid="image-tag"][src*="/pikapi/images/"]') ||
        metadataBlock.querySelector('img[data-testid="image-tag"]');
      if (img) {
        const src = img.getAttribute("src");
        if (src) return src;
      }
    }

    // Repli : recherche par proximité DOM (distance réelle dans l'arbre), au cas où la
    // structure du lecteur changerait dans une future version du site.
    const images = Array.from(document.querySelectorAll('img[data-testid="image-tag"][src*="/pikapi/images/"]'));
    if (images.length === 0) return null;

    let best = null;
    let bestDistance = Infinity;
    for (const img of images) {
      const distance = domDistance(episodeEl, img);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = img;
      }
    }
    return best ? best.getAttribute("src") : null;
  }

  function stripEpisodePrefix(text) {
    // Retire un préfixe "Épisode 1/5 · " ou "Épisode 1/5 : " pour ne garder que le titre propre
    // de l'épisode (ex. "Les mondes de Toussaint Bréda").
    return (text || "").replace(/^\s*Épisode\s*\d+\s*\/\s*\d+\s*[·:]\s*/i, "").trim();
  }

  // ------------------------------------------------------------------------------------
  // FIX PRINCIPAL : titre + album lus depuis le lecteur global ("en cours d'écoute")
  // ------------------------------------------------------------------------------------
  // Le lecteur global de radiofrance.fr (barre visible dès qu'une lecture démarre, présente
  // sur toutes les pages, y compris la page "émission" avec la liste des épisodes) affiche
  // deux liens rendus par le même composant "Link" du site :
  //   - un lien vers l'épisode en cours d'écoute, ex.
  //     <a href="/franceinfo/podcasts/les-voies-de-l-ia/les-voies-de-l-ia-4799764"
  //        data-testid="link"><span>PODCAST. Les Voies de l'IA : ...</span></a>
  //   - un lien vers l'émission/podcast parent ("album"), ex.
  //     <a href="/franceinfo/podcasts/les-voies-de-l-ia"
  //        data-testid="link"><span>Les voies de l'IA</span></a>
  //
  // AVANT : le code lisait le <h1> "CoverTitle-title" de la PAGE COURANTE pour le titre. Sur
  // une page émission (liste d'épisodes), ce H1 contient le nom du PODCAST, pas celui de
  // l'épisode réellement en lecture -> le fichier téléchargé était tagué avec le mauvais nom
  // dès qu'on téléchargeait depuis la page liste plutôt que depuis la page épisode.
  //
  // MAINTENANT : on lit directement les deux liens du lecteur ci-dessus, qui donnent le bon
  // titre ET le bon album quelle que soit la page sur laquelle on se trouve. On ne s'appuie
  // PAS sur les classes CSS générées par le build (ex. "svelte-n4cvm", "svelte-1zrq9d") : ces
  // hash changent à chaque redéploiement du site et cassent tout sélecteur qui s'y fie.
  function collectPodcastLinkCandidates() {
    const anchors = Array.from(document.querySelectorAll('a[href*="/podcasts/"]')).filter((a) => {
      const testid = (a.getAttribute("data-testid") || "").toLowerCase();
      if (testid !== "link") return false;
      const span = a.querySelector("span");
      return !!(span && span.textContent && span.textContent.trim());
    });

    return anchors.map((a) => ({
      el: a,
      href: (a.getAttribute("href") || "").split("?")[0].split("#")[0],
      text: a.querySelector("span").textContent.trim()
    }));
  }

  function findNowPlayingInfo() {
    const candidates = collectPodcastLinkCandidates();
    if (candidates.length === 0) return { title: null, album: null, episodeEl: null };

    // Dédoublonne par href (le lecteur peut être dupliqué dans le DOM : version mobile +
    // desktop, barre fixe, etc.)
    const byHref = new Map();
    candidates.forEach((c) => {
      if (!byHref.has(c.href)) byHref.set(c.href, c);
    });
    const unique = Array.from(byHref.values());

    // Le lien "épisode" (titre) a pour href celui du lien "émission" (album) + "/slug".
    // On cherche donc une paire où l'un des deux hrefs est directement imbriqué dans l'autre,
    // ce qui identifie sans ambiguïté quel lien est le titre et lequel est l'album.
    for (const episode of unique) {
      for (const show of unique) {
        if (episode === show) continue;
        if (episode.href.startsWith(show.href + "/")) {
          return { title: episode.text, album: show.text, episodeEl: episode.el };
        }
      }
    }

    // Aucune paire "imbriquée" trouvée (un seul lien présent, lecteur pas encore hydraté...) :
    // on retourne le plus profond comme titre, sans deviner l'album.
    unique.sort((a, b) => b.href.split("/").length - a.href.split("/").length);
    return {
      title: unique[0].text,
      album: unique.length > 1 ? unique[unique.length - 1].text : null,
      episodeEl: unique[0].el
    };
  }

  function findPlayerEpisodeTitle() {
    // Repli si le lecteur global n'a pas pu être lu (ex. page sans lecture en cours) : on
    // cible le titre par une classe STABLE ("CoverTitle-title"), pas par un hash Svelte
    // généré au build (ex. "svelte-xxxxx") qui peut changer d'une page/version à l'autre.
    const el =
      document.querySelector('[class*="CoverTitle-title"] h1') ||
      document.querySelector('h1[class*="typo-headline"]') ||
      document.querySelector('h1[id^="covertitle-"]');
    if (el && el.textContent && el.textContent.trim()) {
      return stripEpisodePrefix(el.textContent.trim());
    }
    return null;
  }

  function findAlbumTitle() {
    // Repli si le lecteur global n'a pas pu être lu. L'"album" correspond à la série/émission
    // d'origine, affichée dans le bloc "Provenant du podcast" en bas de page sur une page
    // épisode.
    const parentLink = document.querySelector('[class*="Parent-title"]');
    if (parentLink && parentLink.textContent.trim()) {
      return parentLink.textContent.trim();
    }
    return siteBrandName();
  }

  function findCategory() {
    const el = document.querySelector('meta[property="article:section"]');
    return el ? el.getAttribute("content") || "" : "";
  }

  function findAuthor() {
    // Cherche un bloc JSON-LD "Person" (producteur/animateur), présent sur la plupart des
    // pages d'émission radiofrance.fr.
    const scripts = document.querySelectorAll('script[type="application/ld+json"]');
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent);
        const items = Array.isArray(data) ? data : [data];
        for (const item of items) {
          const found = findPersonRecursive(item);
          if (found) return found;
        }
      } catch (e) {
        // JSON-LD invalide, on ignore ce bloc.
      }
    }
    // BUG CORRIGÉ : fallback figé sur "France Culture" -> remplacé par la marque réelle de
    // la page (franceinfo, France Inter...), lue dynamiquement.
    return siteBrandName();
  }

  function findPersonRecursive(node, depth = 0) {
    if (!node || typeof node !== "object" || depth > 4) return null;
    if (node["@type"] === "Person" && node.name) return node.name;
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) {
        for (const item of value) {
          const found = findPersonRecursive(item, depth + 1);
          if (found) return found;
        }
      } else if (value && typeof value === "object") {
        const found = findPersonRecursive(value, depth + 1);
        if (found) return found;
      }
    }
    return null;
  }

  function findChapters() {
    // Certaines pages d'émission affichent une liste de chapitres/minutages dans le DOM
    // (ex. "00:00 Introduction"). On tente de les récupérer si présents, sinon on repart
    // sans chapitres (le téléchargement fonctionne quand même).
    const chapters = [];
    const candidates = document.querySelectorAll("[data-chapter], .chapter-item, [class*='chapitre']");
    candidates.forEach((el) => {
      const text = el.textContent.trim();
      const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*[-–]?\s*(.+)$/);
      if (match) {
        const h = match[3] ? parseInt(match[1], 10) : 0;
        const m = match[3] ? parseInt(match[2], 10) : parseInt(match[1], 10);
        const s = match[3] ? parseInt(match[3], 10) : parseInt(match[2], 10);
        const startSeconds = h * 3600 + m * 60 + s;
        chapters.push({ title: match[4].trim(), startSeconds });
      }
    });
    return chapters;
  }

  function collectMetadata() {
    const audioUrl = findAudioUrl();
    if (!audioUrl) return null;

    const nowPlaying = findNowPlayingInfo();

    return {
      audioUrl,
      // Ordre de priorité : (1) lecteur global "en cours d'écoute" (le plus fiable, donne le
      // vrai épisode joué même depuis une page liste), (2) H1 de la page, (3) og:title nettoyé,
      // (4) titre brut de l'onglet en tout dernier recours.
      title: nowPlaying.title || findPlayerEpisodeTitle() || cleanTitle(getMeta("og:title")) || document.title,
      album: nowPlaying.album || findAlbumTitle(),
      category: findCategory(),
      description: getMeta("og:description"),
      // Idem : la cover DU LECTEUR (scopée près du lien "épisode") est prioritaire sur la
      // première image /pikapi/images/ de toute la page, qui peut appartenir à un épisode
      // voisin sur une page liste.
      cover: findCoverNearEpisode(nowPlaying.episodeEl) || findCoverUrl(),
      author: findAuthor(),
      chapters: findChapters()
    };
  }

  function buildButton() {
    const btn = document.createElement("button");
    btn.id = BUTTON_ID;
    btn.className = "ytdl-btn ytdl-rf-btn";
    btn.type = "button";
    btn.innerHTML = `
      <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
        <path d="M12 3v10.59l3.3-3.3 1.41 1.42L12 16.41l-4.71-4.7 1.41-1.42 3.3 3.3V3h2zM5 20h14v-2H5v2z"/>
      </svg>
      <span>Télécharger l'épisode</span>
    `;
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      toggleMenu(btn);
    });
    return btn;
  }

  function toggleMenu(anchorBtn) {
    const existing = document.getElementById(MENU_ID);
    if (existing) {
      existing.remove();
      return;
    }
    buildMenu(anchorBtn);
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function buildMenu(anchorBtn) {
    const metadata = collectMetadata();
    const menu = document.createElement("div");
    menu.id = MENU_ID;
    menu.className = "ytdl-menu";

    if (!metadata) {
      menu.innerHTML = `<div class="ytdl-menu-error">Fichier audio introuvable sur cette page. Lancez la lecture puis réessayez.</div>`;
      anchorBtn.parentElement.appendChild(menu);
      return;
    }

    menu.innerHTML = `
      <div class="ytdl-section-title">Épisode</div>
      <div class="ytdl-rf-preview">
        <strong>${escapeHtml(metadata.title)}</strong>
        <div>${escapeHtml(metadata.album)} — ${escapeHtml(metadata.author)}</div>
      </div>
      <div class="ytdl-grid">
        <button class="ytdl-item" data-action="download">Télécharger (cover + titre + auteur + description${metadata.chapters.length ? " + chapitres" : ""})</button>
      </div>
      <div class="ytdl-progress-wrap" style="display:none;">
        <div class="ytdl-progress-bar"><div class="ytdl-progress-fill"></div></div>
        <div class="ytdl-progress-label">0%</div>
      </div>
    `;
    anchorBtn.parentElement.appendChild(menu);

    menu.querySelector('[data-action="download"]').addEventListener("click", () => {
      startDownload(menu, metadata);
    });
  }

  function startDownload(menu, metadata) {
    const progressWrap = menu.querySelector(".ytdl-progress-wrap");
    const fill = menu.querySelector(".ytdl-progress-fill");
    const label = menu.querySelector(".ytdl-progress-label");
    progressWrap.style.display = "block";

    if (!isExtensionContextValid()) {
      label.textContent = CONTEXT_INVALIDATED_MESSAGE;
      return;
    }

    const payload = {
      action: "download",
      title: metadata.title,
      directMediaUrl: metadata.audioUrl,
      directAuthor: metadata.author,
      directAlbum: metadata.album,
      directGenre: metadata.category,
      directCoverUrl: metadata.cover,
      directDescription: metadata.description,
      directChapters: JSON.stringify(metadata.chapters)
    };

    chrome.runtime.sendMessage(payload).then((res) => {
      if (!res || !res.ok) {
        label.textContent = "Erreur";
        return;
      }

      const thisRequestId = res.requestId;

      function listener(msg) {
        if (!msg.requestId || msg.requestId !== thisRequestId) return;
        if (msg.type === "download-progress") {
          fill.style.width = `${msg.percent}%`;
          label.textContent = `${msg.percent}% ${msg.stage ? "- " + msg.stage : ""}`;
        } else if (msg.type === "download-complete") {
          fill.style.width = "100%";
          label.textContent = "Terminé ✓";
          chrome.runtime.onMessage.removeListener(listener);
        } else if (msg.type === "download-cancelled") {
          label.textContent = "Annulé";
          chrome.runtime.onMessage.removeListener(listener);
        } else if (msg.type === "download-error") {
          label.textContent = `Erreur : ${msg.message}`;
          chrome.runtime.onMessage.removeListener(listener);
        }
      }

      chrome.runtime.onMessage.addListener(listener);
    }).catch(() => {
      // Contexte invalidé pendant l'envoi (rechargement de l'extension en plein téléchargement).
      label.textContent = CONTEXT_INVALIDATED_MESSAGE;
    });
  }

  function findAnchor() {
    // Retourne toujours document.body : le bouton est positionné en `fixed` via le CSS,
    // donc peu importe où il est inséré dans le DOM — il reste visible à l'écran. Cela
    // évite de dépendre de classes CSS générées dynamiquement (SvelteKit) qui changent
    // d'une page à l'autre et rendaient le bouton invisible/mal placé.
    return document.body;
  }

  function injectButton() {
    if (document.getElementById(BUTTON_ID)) return;
    if (!findAudioUrl()) return; // Pas d'audio détecté pour l'instant (page en cours de chargement).

    const container = findAnchor();
    if (!container) return;

    const btn = buildButton();
    container.appendChild(btn);
  }

  document.addEventListener("click", (e) => {
    const menu = document.getElementById(MENU_ID);
    if (menu && !menu.contains(e.target) && e.target.id !== BUTTON_ID && !e.target.closest(`#${BUTTON_ID}`)) {
      menu.remove();
    }
  });

  window.addEventListener("load", () => setTimeout(injectButton, 1200));

  // Regroupe les rafales de mutations (site SvelteKit très dynamique) en une seule
  // vérification par frame.
  let injectScheduled = false;
  const observer = new MutationObserver(() => {
    if (injectScheduled) return;
    injectScheduled = true;
    requestAnimationFrame(() => {
      injectScheduled = false;
      if (!document.getElementById(BUTTON_ID)) injectButton();
    });
    // Le menu peut être ouvert alors que le lecteur global change d'épisode (playlist
    // auto-next) : on ne le referme pas automatiquement ici, mais collectMetadata() est
    // toujours ré-évaluée à l'ouverture suivante du menu, donc pas de titre périmé affiché.
  });
  observer.observe(document.body, { childList: true, subtree: true });
})();
