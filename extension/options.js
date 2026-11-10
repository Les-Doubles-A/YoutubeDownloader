// options.js

const fields = [
  "downloadFolder",
  "ytDlpPath",
  "ffmpegPath",
  "defaultVideoFormat",
  "defaultAudioFormat",
  "preferredQuality",
  "filenameTemplate",
  "cookiesFromBrowser",
  "subtitleLangs",
  "subtitleFormat",
  "maxConcurrent",
  "sponsorBlockMode"
];

async function load() {
  const res = await chrome.runtime.sendMessage({ action: "getOptions" });
  const options = (res && res.options) || {};
  for (const field of fields) {
    const el = document.getElementById(field);
    if (el && options[field] !== undefined) el.value = String(options[field]);
  }
  const autoEl = document.getElementById("autoDownload");
  autoEl.checked = !!options.autoDownload;

  const metaEl = document.getElementById("includeMetadataByDefault");
  metaEl.checked = !!options.includeMetadataByDefault;

  const sbSelected = Array.isArray(options.sponsorBlockCategories) ? options.sponsorBlockCategories : ["sponsor", "selfpromo"];
  document.querySelectorAll("[data-sb]").forEach((el) => {
    el.checked = sbSelected.includes(el.dataset.sb);
  });

  const autoUpdateEl = document.getElementById("autoUpdateYtDlp");
  // Par défaut activé si jamais enregistré (cohérent avec DEFAULT_OPTIONS côté background.js).
  autoUpdateEl.checked = options.autoUpdateYtDlp !== false;
}

async function save() {
  const options = {};
  for (const field of fields) {
    const el = document.getElementById(field);
    if (el) options[field] = el.value;
  }
  options.maxConcurrent = Number(options.maxConcurrent) || 2;
  options.sponsorBlockCategories = Array.from(document.querySelectorAll("[data-sb]"))
    .filter((el) => el.checked)
    .map((el) => el.dataset.sb);
  options.autoDownload = document.getElementById("autoDownload").checked;
  options.includeMetadataByDefault = document.getElementById("includeMetadataByDefault").checked;
  options.autoUpdateYtDlp = document.getElementById("autoUpdateYtDlp").checked;

  await chrome.runtime.sendMessage({ action: "saveOptions", options });
  const msg = document.getElementById("saved-msg");
  msg.style.display = "inline";
  setTimeout(() => (msg.style.display = "none"), 2000);
}

function setResult(lines) {
  const out = document.getElementById("test-result");
  out.innerHTML = "";
  for (const { ok, text } of lines) {
    const row = document.createElement("div");
    row.className = ok ? "ok" : "ko";
    row.textContent = (ok ? "OK : " : "Erreur : ") + text;
    out.appendChild(row);
  }
}

async function testConfig() {
  const out = document.getElementById("test-result");
  out.textContent = "Test en cours...";
  const res = await chrome.runtime.sendMessage({
    action: "testConfig",
    ytDlpPath: document.getElementById("ytDlpPath").value.trim(),
    ffmpegPath: document.getElementById("ffmpegPath").value.trim(),
    outputDir: document.getElementById("downloadFolder").value.trim()
  });
  if (!res || !res.ok) {
    setResult([{ ok: false, text: (res && res.error) || "L'hôte natif ne répond pas." }]);
    return;
  }
  const d = res.data;
  setResult([
    { ok: true, text: "hôte natif joignable" },
    d.ytDlp.ok
      ? { ok: true, text: `yt-dlp ${d.ytDlp.version} (${d.ytDlp.path})` }
      : { ok: false, text: `yt-dlp introuvable ou inutilisable (${d.ytDlp.path})` },
    d.ffmpeg.ok
      ? { ok: true, text: `${d.ffmpeg.version} (${d.ffmpeg.path})` }
      : { ok: false, text: `ffmpeg introuvable ou inutilisable (${d.ffmpeg.path})` },
    d.outputDirOk
      ? { ok: true, text: "dossier de téléchargement accessible" }
      : { ok: false, text: "dossier de téléchargement inaccessible" }
  ]);
}

async function pickFolder() {
  const res = await chrome.runtime.sendMessage({ action: "pickFolder" });
  if (res && res.ok && res.data.path) {
    document.getElementById("downloadFolder").value = res.data.path;
  } else if (res && !res.ok) {
    setResult([{ ok: false, text: res.error }]);
  }
}

document.getElementById("test-config").addEventListener("click", testConfig);
document.getElementById("pick-folder").addEventListener("click", pickFolder);
document.getElementById("save").addEventListener("click", save);
load();
