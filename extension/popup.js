// popup.js

function statusClass(status) {
  return `status-${status.replace(/\s/g, "")}`;
}

function formatDate(ts) {
  const d = new Date(ts);
  return d.toLocaleString("fr-FR");
}

// Le titre vient d'une page web externe (titre de vidéo YouTube, d'épisode radiofrance...) :
// on échappe systématiquement le texte avant de l'injecter dans innerHTML.
function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str == null ? "" : String(str);
  return div.innerHTML;
}

function isActive(item) {
  return item.status === "en cours" || item.status === "en attente";
}

function renderSummary(history) {
  const running = history.filter((h) => h.status === "en cours");
  const waiting = history.filter((h) => h.status === "en attente");
  const summary = document.getElementById("summary");
  if (running.length === 0 && waiting.length === 0) {
    summary.style.display = "none";
    return;
  }
  // Progression globale : moyenne des téléchargements actifs (les files d'attente comptent pour 0).
  const active = running.concat(waiting);
  const avg = Math.round(active.reduce((sum, h) => sum + (h.percent || 0), 0) / active.length);
  summary.style.display = "block";
  summary.textContent =
    `${running.length} en cours, ${waiting.length} en attente - progression globale ${avg}%`;
}

// Vidéos ignorées car déjà présentes dans l'archive des téléchargements.
function skippedText(item) {
  const total = Math.max(item.total || 0, item.skipped);
  if (total <= 1) return "Déjà téléchargée : ignorée.";
  return `${total - item.skipped} nouvelle(s), ${item.skipped} déjà téléchargée(s) ignorée(s)`;
}

function buildItem(item) {
  const label = item.title || item.url;
  const div = document.createElement("div");
  div.className = "history-item";

  const showBar = isActive(item);
  const percent = Math.max(0, Math.min(100, item.percent || 0));

  div.innerHTML = `
    <div class="title" title="${escapeHtml(label)}">${escapeHtml(label)}</div>
    <div class="meta">
      <span class="${statusClass(item.status)}">${escapeHtml(item.status)} ${item.percent && item.status !== "terminé" ? item.percent + "%" : ""}</span>
      <span>${escapeHtml(formatDate(item.startedAt))}</span>
    </div>
    ${showBar ? `<div class="bar"><div style="width:${percent}%"></div></div>` : ""}
    ${showBar && item.stage ? `<div class="stage">${escapeHtml(item.stage)}</div>` : ""}
    ${item.status === "erreur" && item.error ? `<div class="err">${escapeHtml(item.error)}</div>` : ""}
    ${item.status === "terminé" && item.skipped > 0 ? `<div class="stage">${escapeHtml(skippedText(item))}</div>` : ""}
    <div class="actions"></div>
  `;

  const actions = div.querySelector(".actions");
  const addAction = (text, handler) => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = text;
    btn.addEventListener("click", handler);
    actions.appendChild(btn);
  };

  if (isActive(item)) {
    addAction("Annuler", async () => {
      await chrome.runtime.sendMessage({ action: "cancel", requestId: item.id });
      loadHistory();
    });
  }
  if (item.status === "terminé" && item.filePath) {
    addAction("Afficher dans le dossier", async () => {
      await chrome.runtime.sendMessage({ action: "revealPath", path: item.filePath });
    });
  }
  if ((item.status === "erreur" || item.status === "annulé") && item.retry) {
    addAction("Relancer", async () => {
      await chrome.runtime.sendMessage({ action: "retry", id: item.id });
      loadHistory();
    });
  }
  if (!actions.children.length) actions.remove();

  return div;
}

async function loadHistory() {
  const res = await chrome.runtime.sendMessage({ action: "getHistory" });
  const container = document.getElementById("history");
  container.innerHTML = "";
  if (!res || !res.ok || res.history.length === 0) {
    document.getElementById("summary").style.display = "none";
    container.innerHTML = '<div class="status">Aucun téléchargement pour le moment.</div>';
    return;
  }
  renderSummary(res.history);
  for (const item of res.history) {
    container.appendChild(buildItem(item));
  }
}

async function checkActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const statusEl = document.getElementById("status");
  const url = (tab && tab.url) || "";
  if (url.includes("youtube.com/watch") || url.includes("youtube.com/shorts/")) {
    statusEl.textContent = "Vidéo YouTube détectée. Utilisez le bouton de téléchargement.";
  } else if (url.includes("youtube.com/playlist")) {
    statusEl.textContent = "Playlist YouTube détectée. Utilisez le bouton flottant en bas à droite.";
  } else if (url.includes("radiofrance.fr/") && url.includes("/podcasts/")) {
    statusEl.textContent = "Podcast Radio France détecté. Utilisez le bouton \"Télécharger l'épisode\".";
  } else {
    statusEl.textContent = "Ouvrez une vidéo YouTube ou un podcast radiofrance.fr pour télécharger.";
  }
}

document.getElementById("open-options").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

document.getElementById("clear-history").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ action: "clearHistory" });
  await loadHistory();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (
    msg.type === "download-started" ||
    msg.type === "download-progress" ||
    msg.type === "download-complete" ||
    msg.type === "download-cancelled" ||
    msg.type === "download-error"
  ) {
    loadHistory();
  }
});

checkActiveTab();
loadHistory();
