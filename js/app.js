// Interface : dépôt des fichiers, liste, aperçu, copie et téléchargement.
// Toute la conversion passe par convertToMd() (voir convert.js).

import { convertToMd, getConverter, CONVERTERS, ACCEPT } from "./convert.js";
import { baseName } from "./utils/markdown.js";

const $ = (id) => document.getElementById(id);
const items = [];          // { id, file, name, converter, status, progress, md, error }
let selected = null;
let view = "src";
let seq = 0;

/* ------------------------------------------------------------ utilitaires */
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtSize = (b) => b < 1024 ? b + " o" : b < 1048576 ? (b / 1024).toFixed(1) + " Ko" : (b / 1048576).toFixed(1) + " Mo";

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
    item.md = await convertToMd(item.file, {
      onProgress: (done, total) => {
        if (total > 1) { item.progress = `Page ${done} / ${total}`; render(); }
      },
    });
    item.status = "done";
    if (!selected) selected = item.id;
  } catch (e) {
    console.error(e);
    item.status = "error";
    item.error = e?.name === "PasswordException" ? "PDF protégé par mot de passe" : e?.message || "Conversion impossible";
  }
  render();
}

function addFiles(fileList) {
  const rejected = [];
  const queue = [];
  for (const file of fileList) {
    const converter = getConverter(file.name);
    if (!converter) { rejected.push(file.name); continue; }
    const item = { id: ++seq, file, name: file.name, converter, status: "pending", progress: "", md: "", error: "" };
    items.push(item);
    queue.push(item);
  }
  if (rejected.length) toast(`Format non pris en charge : ${rejected.join(", ")}`, "pi-exclamation-triangle");
  render();
  (async () => { for (const it of queue) await convert(it); })();
}

/* ---------------------------------------------------------------- actions */
const download = (item) =>
  saveBlob(new Blob([item.md], { type: "text/markdown;charset=utf-8" }), baseName(item.name) + ".md");

async function copy(item) {
  try { await navigator.clipboard.writeText(item.md); toast("Markdown copié"); }
  catch { toast("Copie impossible dans ce navigateur", "pi-exclamation-triangle"); }
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
  }
  saveBlob(await zip.generateAsync({ type: "blob" }), "markdown.zip");
}

function remove(id) {
  const i = items.findIndex((x) => x.id === id);
  if (i >= 0) items.splice(i, 1);
  if (selected === id) selected = items.find((x) => x.status === "done")?.id ?? null;
  render();
}

/* ------------------------------------------------------------------ rendu */
function statusHtml(it) {
  switch (it.status) {
    case "pending": return `<i class="pi pi-clock"></i>En attente`;
    case "working": return `<i class="pi pi-spin pi-spinner"></i>${esc(it.progress || "Conversion…")}`;
    case "done": return `<i class="pi pi-check-circle ok"></i><span>Converti · ${fmtSize(new Blob([it.md]).size)}</span>`;
    case "error": return `<i class="pi pi-times-circle err"></i><span class="err-text">${esc(it.error)}</span>`;
  }
}

function render() {
  $("files-card").classList.toggle("hidden", !items.length);
  $("count").textContent = items.length ? `(${items.length})` : "";
  $("zip").disabled = !items.some((i) => i.status === "done");

  $("list").innerHTML = items.map((it) => {
    const { kind, icon } = it.converter;
    const ok = it.status === "done";
    return `<li class="file${selected === it.id ? " active" : ""}" data-id="${it.id}">
      <div class="ficon ${kind}"><i class="pi ${icon}"></i></div>
      <div class="fmain">
        <div class="fname" title="${esc(it.name)}">${esc(it.name)}</div>
        <div class="fmeta">${fmtSize(it.file.size)} <span>·</span> ${statusHtml(it)}</div>
      </div>
      <div class="fact">
        <button class="icon-btn" data-act="copy" title="Copier le Markdown" aria-label="Copier" ${ok ? "" : "disabled"}><i class="pi pi-copy"></i></button>
        <button class="icon-btn" data-act="dl" title="Télécharger le .md" aria-label="Télécharger" ${ok ? "" : "disabled"}><i class="pi pi-download"></i></button>
        <button class="icon-btn danger" data-act="rm" title="Retirer" aria-label="Retirer"><i class="pi pi-times"></i></button>
      </div>
    </li>`;
  }).join("");

  const sel = items.find((i) => i.id === selected && i.status === "done");
  $("preview-card").classList.toggle("hidden", !sel);
  if (!sel) return;
  $("preview-name").textContent = baseName(sel.name) + ".md";
  $("source").textContent = sel.md;
  $("source").classList.toggle("hidden", view !== "src");
  $("rendered").classList.toggle("hidden", view !== "render");
  if (view === "render") $("rendered").innerHTML = DOMPurify.sanitize(marked.parse(sel.md));
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

$("clear").addEventListener("click", () => { items.length = 0; selected = null; render(); });
$("zip").addEventListener("click", downloadZip);
$("tab-src").addEventListener("click", () => { view = "src"; render(); });
$("tab-render").addEventListener("click", () => { view = "render"; render(); });
$("p-copy").addEventListener("click", () => copy(items.find((i) => i.id === selected)));
$("p-dl").addEventListener("click", () => download(items.find((i) => i.id === selected)));
