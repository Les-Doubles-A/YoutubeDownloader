// content-radiofrance-batch.js
// Téléchargement par lot des épisodes d'une page émission radiofrance.fr
// (ex. /franceinter/podcasts/philosophie).
//
// Principe : la page émission déclare son flux RSS public dans <head>
// (<link rel="alternate" type="application/rss+xml" href="https://radiofrance-podcast.net/...">).
// Ce flux contient, pour chaque épisode, l'URL du fichier audio (enclosure), le titre, la date,
// la description et la cover. On l'utilise plutôt que le DOM de la liste d'épisodes, qui ne
// contient pas l'URL audio et dont les classes CSS générées changent à chaque déploiement.
// Le flux est récupéré par le service worker (le content script est soumis au CORS du site).

(function () {
  const BUTTON_ID = "ytdl-rf-batch-button";
  const MENU_ID = "ytdl-rf-batch-menu";
  const MAX_BATCH = 100; // taille de l'historique conservé par l'extension

  function isExtensionContextValid() {
    return typeof chrome !== "undefined" && !!chrome.runtime && !!chrome.runtime.id;
  }

  // Page émission : /<chaîne>/podcasts/<émission>. Une page épisode a un segment de plus.
  function isShowPage() {
    const segments = location.pathname.split("/").filter(Boolean);
    return segments.length === 3 && segments[1] === "podcasts";
  }

  function findFeedUrl() {
    const link = document.querySelector('link[rel="alternate"][type="application/rss+xml"]');
    const href = link ? link.getAttribute("href") : "";
    try {
      const url = new URL(href, location.href);
      return url.protocol === "https:" && /(^|\.)radiofrance-podcast\.net$/.test(url.hostname) ? url.href : "";
    } catch (e) {
      return "";
    }
  }

  function getMeta(property) {
    const el = document.querySelector(`meta[property="${property}"]`) || document.querySelector(`meta[name="${property}"]`);
    return el ? el.getAttribute("content") || "" : "";
  }

  function pageShowTitle() {
    const h1 = document.querySelector('h1[class*="CoverTitle-title"]') || document.querySelector("h1");
    return h1 ? h1.textContent.trim() : "";
  }

  // ---------------------------------------------------------------------------
  // Lecture du flux RSS
  // ---------------------------------------------------------------------------
  function childText(node, localName) {
    const el = node.getElementsByTagNameNS("*", localName)[0];
    return el ? (el.textContent || "").trim() : "";
  }

  function htmlToText(html) {
    if (!html) return "";
    const doc = new DOMParser().parseFromString(html, "text/html");
    return (doc.body.textContent || "").replace(/\s+\n/g, "\n").trim();
  }

  function parseDuration(raw) {
    if (!raw) return 0;
    if (/^\d+$/.test(raw)) return parseInt(raw, 10);
    const parts = raw.split(":").map((p) => parseInt(p, 10));
    if (parts.some((p) => Number.isNaN(p))) return 0;
    return parts.reduce((acc, p) => acc * 60 + p, 0);
  }

  function formatDuration(seconds) {
    if (!seconds) return "";
    const m = Math.round(seconds / 60);
    return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}` : `${Math.max(m, 1)} min`;
  }

  function parseFeed(xmlText) {
    const doc = new DOMParser().parseFromString(xmlText, "text/xml");
    if (doc.getElementsByTagName("parsererror").length) return null;
    const channel = doc.getElementsByTagName("channel")[0];
    if (!channel) return null;

    const channelImageEl = channel.getElementsByTagNameNS("*", "image")[0];
    const channelCover =
      (channelImageEl && (channelImageEl.getAttribute("href") || childText(channelImageEl, "url"))) || "";

    const items = [];
    for (const item of doc.getElementsByTagName("item")) {
      const enclosure = item.getElementsByTagName("enclosure")[0];
      const audioUrl = enclosure ? enclosure.getAttribute("url") : "";
      if (!audioUrl || !/^https:\/\//i.test(audioUrl)) continue;

      const imageEl = item.getElementsByTagNameNS("*", "image")[0];
      const pubDate = childText(item, "pubDate");
      const date = pubDate ? new Date(pubDate) : null;
      items.push({
        title: childText(item, "title"),
        audioUrl,
        cover: (imageEl && imageEl.getAttribute("href")) || channelCover,
        description: htmlToText(childText(item, "description")),
        date: date && !Number.isNaN(date.getTime()) ? date : null,
        duration: parseDuration(childText(item, "duration")),
        author: childText(item, "author")
      });
    }

    return {
      channelTitle: childText(channel, "title"),
      channelAuthor: Array.from(channel.children)
        .filter((c) => c.localName === "author")
        .map((c) => (c.textContent || "").trim())[0] || "",
      items
    };
  }

  function fetchFeed(url) {
    return chrome.runtime.sendMessage({ action: "fetchText", url }).then((res) => {
      if (!res || !res.ok) throw new Error((res && res.error) || "Flux RSS inaccessible.");
      const feed = parseFeed(res.text);
      if (!feed || feed.items.length === 0) throw new Error("Aucun épisode téléchargeable dans le flux RSS.");
      return feed;
    });
  }

  // ---------------------------------------------------------------------------
  // Interface
  // ---------------------------------------------------------------------------
  function removeMenu() {
    const existing = document.getElementById(MENU_ID);
    if (existing) existing.remove();
  }

  function makeEl(tag, className, text) {
    const el = document.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function buildButton() {
    const btn = document.createElement("button");
    btn.id = BUTTON_ID;
    btn.className = "ytdl-btn ytdl-rf-batch-btn";
    btn.type = "button";
    btn.textContent = "Télécharger plusieurs épisodes";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      if (document.getElementById(MENU_ID)) {
        removeMenu();
      } else {
        openMenu();
      }
    });
    return btn;
  }

  async function openMenu() {
    const menu = makeEl("div", "ytdl-menu");
    menu.id = MENU_ID;
    menu.appendChild(makeEl("div", "ytdl-menu-loading", "Lecture du flux RSS de l'émission…"));
    document.body.appendChild(menu);

    if (!isExtensionContextValid()) {
      menu.replaceChildren(makeEl("div", "ytdl-menu-error", "L'extension a été rechargée. Actualisez cette page (F5)."));
      return;
    }

    const feedUrl = findFeedUrl();
    if (!feedUrl) {
      menu.replaceChildren(makeEl("div", "ytdl-menu-error", "Flux RSS de cette émission introuvable sur la page."));
      return;
    }

    let feed;
    try {
      feed = await fetchFeed(feedUrl);
    } catch (err) {
      menu.replaceChildren(makeEl("div", "ytdl-menu-error", err.message || "Flux RSS inaccessible."));
      return;
    }
    if (!menu.isConnected) return; // menu fermé pendant le chargement
    renderMenu(menu, feed);
  }

  function renderMenu(menu, feed) {
    const album = pageShowTitle() || feed.channelTitle || getMeta("og:site_name");
    const author = feed.channelAuthor || getMeta("og:site_name") || "Radio France";
    const genre = getMeta("article:section");

    const rows = feed.items.map((item, index) => {
      const row = makeEl("label", "ytdl-rf-row");
      const checkbox = document.createElement("input");
      checkbox.type = "checkbox";
      checkbox.dataset.index = String(index);
      const date = item.date ? item.date.toLocaleDateString("fr-FR") : "";
      const meta = [date, formatDuration(item.duration)].filter(Boolean).join(" - ");
      const text = makeEl("span", "ytdl-rf-row-text");
      text.appendChild(makeEl("span", "ytdl-rf-row-title", item.title || "(sans titre)"));
      if (meta) text.appendChild(makeEl("span", "ytdl-rf-row-meta", meta));
      row.append(checkbox, text);
      return { row, checkbox, item };
    });

    const title = makeEl("div", "ytdl-section-title", `${album} - ${feed.items.length} épisodes`);
    const list = makeEl("div", "ytdl-rf-list");
    rows.forEach((r) => list.appendChild(r.row));

    const filter = document.createElement("input");
    filter.type = "text";
    filter.className = "ytdl-rf-filter";
    filter.placeholder = "Filtrer par titre";

    const btnAll = makeEl("button", "ytdl-cancel", "Tout sélectionner");
    const btnNone = makeEl("button", "ytdl-cancel", "Aucun");
    const btnRecent = makeEl("button", "ytdl-cancel", "10 derniers");
    [btnAll, btnNone, btnRecent].forEach((b) => (b.type = "button"));

    const tools = makeEl("div", "ytdl-rf-tools");
    tools.append(btnAll, btnNone, btnRecent);

    const status = makeEl("div", "ytdl-progress-label", "");
    const go = makeEl("button", "ytdl-item", "Télécharger la sélection");
    go.type = "button";

    const visibleRows = () => rows.filter((r) => r.row.style.display !== "none");
    const selected = () => rows.filter((r) => r.checkbox.checked);
    const refresh = () => {
      const n = selected().length;
      go.textContent = n > 0 ? `Télécharger la sélection (${n})` : "Télécharger la sélection";
      go.disabled = n === 0;
    };

    filter.addEventListener("input", () => {
      const q = filter.value.trim().toLowerCase();
      rows.forEach((r) => {
        r.row.style.display = !q || (r.item.title || "").toLowerCase().includes(q) ? "" : "none";
      });
    });
    btnAll.addEventListener("click", () => { visibleRows().forEach((r) => (r.checkbox.checked = true)); refresh(); });
    btnNone.addEventListener("click", () => { rows.forEach((r) => (r.checkbox.checked = false)); refresh(); });
    btnRecent.addEventListener("click", () => {
      rows.forEach((r, i) => (r.checkbox.checked = i < 10));
      refresh();
    });
    list.addEventListener("change", refresh);

    go.addEventListener("click", async () => {
      let chosen = selected();
      if (chosen.length === 0) return;
      let note = "";
      if (chosen.length > MAX_BATCH) {
        chosen = chosen.slice(0, MAX_BATCH);
        note = ` (limité à ${MAX_BATCH} par lot)`;
      }
      go.disabled = true;
      let sent = 0;
      try {
        for (const { item } of chosen) {
          const res = await chrome.runtime.sendMessage({
            action: "download",
            title: item.title,
            directMediaUrl: item.audioUrl,
            directAuthor: item.author || author,
            directAlbum: album,
            directGenre: genre,
            directCoverUrl: item.cover,
            directDescription: item.description,
            directChapters: "[]"
          });
          if (!res || !res.ok) throw new Error("Échec de l'envoi à l'extension.");
          sent++;
          status.textContent = `${sent}/${chosen.length} ajoutés à la file${note}`;
        }
        status.textContent = `${sent} épisodes ajoutés à la file${note}. Suivez la progression dans le popup de l'extension.`;
      } catch (err) {
        status.textContent = `Erreur après ${sent} épisode(s) : ${err.message || err}`;
      }
      go.disabled = false;
      refresh();
    });

    menu.replaceChildren(title, filter, tools, list, go, status);
    refresh();
  }

  // ---------------------------------------------------------------------------
  // Injection (site SvelteKit : la navigation ne recharge pas la page)
  // ---------------------------------------------------------------------------
  function sync() {
    const btn = document.getElementById(BUTTON_ID);
    const wanted = isShowPage() && !!findFeedUrl();
    if (wanted && !btn) {
      document.body.appendChild(buildButton());
    } else if (!wanted && btn) {
      btn.remove();
      removeMenu();
    }
  }

  document.addEventListener("click", (e) => {
    const menu = document.getElementById(MENU_ID);
    if (menu && !menu.contains(e.target) && !e.target.closest(`#${BUTTON_ID}`)) {
      menu.remove();
    }
  });

  window.addEventListener("load", () => setTimeout(sync, 1200));

  let scheduled = false;
  const observer = new MutationObserver(() => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      sync();
    });
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
})();
