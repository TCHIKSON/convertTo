// Interface : dépôt des fichiers, liste, aperçu, copie et téléchargement.
// Toute la conversion passe par convertToMd() (voir convert.js).

import { convertToMd, getConverter, CONVERTERS, ACCEPT } from "./convert.js";
import { baseName } from "./utils/markdown.js";

const $ = (id) => document.getElementById(id);
// { id, file, name, converter, status, progress, md, assets, urls, error }
const items = [];
let selected = null;
let view = "src";
let seq = 0;

/* ------------------------------------------------------------ utilitaires */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtSize = (b) => b < 1024 ? b + " o" : b < 1048576 ? (b / 1024).toFixed(1) + " Ko" : (b / 1048576).toFixed(1) + " Mo";
const plural = (n, word) => `${n} ${word}${n > 1 ? "s" : ""}`;

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = Object.assign(document.createElement("a"), { href: url, download: filename });
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

let toastTimer;
function toast(message, icon = "pi-check") {
  const t = $("toast");
  t.querySelector("i").className = "pi " + icon;
  t.querySelector("span").textContent = message;
  t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

/* ------------------------------------------------------------- conversion */
async function convert(item) {
  item.status = "working";
  render();
  try {
    const result = await convertToMd(item.file, {
      images: $("opt-images").checked,
      metadata: $("opt-meta").checked,
      ocr: $("opt-ocr").checked,
      requestPassword: askPassword,
      onProgress: (done, total, label = "Page") => {
        if (total > 1 || label !== "Page") { item.progress = `${label} ${done} / ${total}`; render(); }
      },
    });
    item.md = result.markdown;
    item.assets = result.assets;
    item.status = "done";
    if (!selected) selected = item.id;
  } catch (e) {
    console.error(e);
    item.status = "error";
    item.error = e?.message || "Conversion impossible";
  }
  render();
}

// Fenêtre de saisie du mot de passe d'un PDF protégé.
// Le mot de passe sert uniquement à ouvrir le fichier ; il n'est jamais conservé.
function askPassword(fileName, retry) {
  return new Promise((resolve) => {
    const dialog = $("pwd-dialog");
    const input = $("pwd-input");
    $("pwd-text").textContent = `« ${fileName} » est protégé par un mot de passe.`;
    $("pwd-error").classList.toggle("hidden", !retry);
    input.value = "";
    dialog.returnValue = "";
    dialog.addEventListener("close", () => {
      const value = dialog.returnValue === "ok" ? input.value : null;
      input.value = "";
      resolve(value);
    }, { once: true });
    dialog.showModal();
    input.focus();
  });
}

function addFiles(fileList) {
  const rejected = [];
  const queue = [];
  for (const file of fileList) {
    const converter = getConverter(file.name);
    if (!converter) { rejected.push(file.name); continue; }
    const item = { id: ++seq, file, name: file.name, converter, status: "pending", progress: "", md: "", assets: [], urls: null, error: "" };
    items.push(item);
    queue.push(item);
  }
  if (rejected.length) toast(`Format non pris en charge : ${rejected.join(", ")}`, "pi-exclamation-triangle");
  render();
  (async () => { for (const it of queue) await convert(it); })();
}

/* ---------------------------------------------------------------- actions */

// Un document avec images est téléchargé en .zip (Markdown + dossier images/).
async function download(item) {
  const name = baseName(item.name);
  if (!item.assets.length) {
    saveBlob(new Blob([item.md], { type: "text/markdown;charset=utf-8" }), name + ".md");
    return;
  }
  const zip = new JSZip();
  zip.file(name + ".md", item.md);
  for (const a of item.assets) zip.file(a.path, a.blob);
  saveBlob(await zip.generateAsync({ type: "blob" }), name + ".zip");
}

async function copy(item) {
  try {
    await navigator.clipboard.writeText(item.md);
    toast(item.assets.length ? "Markdown copié (sans les images)" : "Markdown copié");
  } catch {
    toast("Copie impossible dans ce navigateur", "pi-exclamation-triangle");
  }
}

async function downloadZip() {
  const done = items.filter((i) => i.status === "done");
  if (!done.length) return;
  const zip = new JSZip();
  const used = new Set();
  for (const it of done) {
    let name = baseName(it.name) + ".md";
    for (let k = 2; used.has(name); k++) name = `${baseName(it.name)} (${k}).md`;
    used.add(name);
    zip.file(name, it.md);
    for (const a of it.assets) zip.file(a.path, a.blob);
  }
  saveBlob(await zip.generateAsync({ type: "blob" }), "markdown.zip");
}

function releaseUrls(item) {
  if (!item?.urls) return;
  for (const url of item.urls.values()) URL.revokeObjectURL(url);
  item.urls = null;
}

function remove(id) {
  const i = items.findIndex((x) => x.id === id);
  if (i >= 0) { releaseUrls(items[i]); items.splice(i, 1); }
  if (selected === id) selected = items.find((x) => x.status === "done")?.id ?? null;
  render();
}

/* ------------------------------------------------------------------ rendu */
function statusHtml(it) {
  switch (it.status) {
    case "pending": return `<i class="pi pi-clock"></i>En attente`;
    case "working": return `<i class="pi pi-spin pi-spinner"></i>${esc(it.progress || "Conversion…")}`;
    case "done": {
      const images = it.assets.length ? ` · ${plural(it.assets.length, "image")}` : "";
      return `<i class="pi pi-check-circle ok"></i><span>Converti · ${fmtSize(new Blob([it.md]).size)}${images}</span>`;
    }
    case "error": return `<i class="pi pi-times-circle err"></i><span class="err-text">${esc(it.error)}</span>`;
  }
}

// Aperçu rendu : sans l'en-tête YAML, avec les images du document.
function renderPreview(item) {
  const md = item.md.replace(/^---\n[\s\S]*?\n---\n+/, "");
  const target = $("rendered");
  target.innerHTML = DOMPurify.sanitize(marked.parse(md));
  if (item.assets.length && !item.urls) {
    item.urls = new Map(item.assets.map((a) => [a.path, URL.createObjectURL(a.blob)]));
  }
  for (const img of target.querySelectorAll("img")) {
    const url = item.urls?.get(img.getAttribute("src"));
    if (url) img.src = url;
  }
}

function render() {
  $("files-card").classList.toggle("hidden", !items.length);
  $("count").textContent = items.length ? `(${items.length})` : "";
  $("zip").disabled = !items.some((i) => i.status === "done");

  $("list").innerHTML = items.map((it) => {
    const { kind, icon } = it.converter;
    const ok = it.status === "done";
    const dlTitle = it.assets.length ? "Télécharger (.zip avec les images)" : "Télécharger le .md";
    return `<li class="file${selected === it.id ? " active" : ""}" data-id="${it.id}">
      <div class="ficon ${kind}"><i class="pi ${icon}"></i></div>
      <div class="fmain">
        <div class="fname" title="${esc(it.name)}">${esc(it.name)}</div>
        <div class="fmeta">${fmtSize(it.file.size)} <span>·</span> ${statusHtml(it)}</div>
      </div>
      <div class="fact">
        <button class="icon-btn" data-act="copy" title="Copier le Markdown" aria-label="Copier" ${ok ? "" : "disabled"}><i class="pi pi-copy"></i></button>
        <button class="icon-btn" data-act="dl" title="${dlTitle}" aria-label="Télécharger" ${ok ? "" : "disabled"}><i class="pi pi-download"></i></button>
        <button class="icon-btn danger" data-act="rm" title="Retirer" aria-label="Retirer"><i class="pi pi-times"></i></button>
      </div>
    </li>`;
  }).join("");

  const sel = items.find((i) => i.id === selected && i.status === "done");
  $("preview-card").classList.toggle("hidden", !sel);
  if (!sel) return;
  $("preview-name").textContent = baseName(sel.name) + ".md";
  $("p-dl-label").textContent = sel.assets.length ? ".zip" : ".md";
  $("source").textContent = sel.md;
  $("source").classList.toggle("hidden", view !== "src");
  $("rendered").classList.toggle("hidden", view !== "render");
  if (view === "render") renderPreview(sel);
  $("tab-src").classList.toggle("on", view === "src");
  $("tab-render").classList.toggle("on", view === "render");
}

/* ------------------------------------------------------------ initialisation */
const input = $("input");
const drop = $("drop");

// Formats acceptés et étiquettes générés depuis la liste des convertisseurs.
input.accept = ACCEPT;
$("formats").innerHTML = CONVERTERS
  .map((c) => `<span class="tag"><i class="pi ${c.icon}"></i>${esc(c.label)}</span>`)
  .join("");

input.addEventListener("change", () => { addFiles(input.files); input.value = ""; });
drop.addEventListener("keydown", (e) => {
  if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
});
["dragenter", "dragover"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
["dragleave", "drop"].forEach((ev) =>
  drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
drop.addEventListener("drop", (e) => addFiles(e.dataTransfer.files));
// Empêche le navigateur d'ouvrir un fichier lâché hors de la zone.
window.addEventListener("dragover", (e) => e.preventDefault());
window.addEventListener("drop", (e) => e.preventDefault());

$("list").addEventListener("click", (e) => {
  const li = e.target.closest(".file");
  if (!li) return;
  const id = Number(li.dataset.id);
  const it = items.find((x) => x.id === id);
  const act = e.target.closest("[data-act]")?.dataset.act;
  if (act === "copy") return copy(it);
  if (act === "dl") return download(it);
  if (act === "rm") return remove(id);
  if (it.status === "done") { selected = id; render(); }
});

// Entrée dans le champ mot de passe = « Ouvrir » (et non le premier bouton, « Annuler »).
$("pwd-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); $("pwd-dialog").close("ok"); }
});

$("clear").addEventListener("click", () => { items.forEach(releaseUrls); items.length = 0; selected = null; render(); });
$("zip").addEventListener("click", downloadZip);
$("tab-src").addEventListener("click", () => { view = "src"; render(); });
$("tab-render").addEventListener("click", () => { view = "render"; render(); });
$("p-copy").addEventListener("click", () => copy(items.find((i) => i.id === selected)));
$("p-dl").addEventListener("click", () => download(items.find((i) => i.id === selected)));
