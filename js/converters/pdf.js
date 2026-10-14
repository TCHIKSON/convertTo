// Convertisseur PDF basé sur pdf.js (globale `pdfjsLib` chargée dans index.html).
//
// Étapes :
//   1. Lecture de chaque page : fragments de texte avec position, taille, style et liens.
//      Si la page n'a pas de texte et que l'OCR est activé, l'image de la page est analysée.
//   2. Reconstitution des lignes, avec détection des mises en page sur deux colonnes.
//   3. Suppression des en-têtes et pieds de page répétés, et des numéros de page.
//   4. Détection des tableaux à partir de l'alignement du texte.
//   5. Hiérarchie des titres calculée sur tout le document (taille de police et gras).
//   6. Assemblage en paragraphes, listes, tableaux et titres Markdown.
//
// Options de convert() :
//   onProgress(done, total, label)       progression page par page
//   ocr: boolean                         OCR des pages sans texte (navigateur uniquement)
//   requestPassword(fileName, retry)     renvoie le mot de passe saisi, ou null pour annuler

import { tableToMd, tidy } from "../utils/markdown.js";
import { createOcr, ocrAvailable } from "../utils/ocr.js";

const PDF_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const BULLET = /^[•▪◦●○■□➢►▶✓–\-*]\s+/;
const NUMBERED = /^(\d{1,3}|[a-z])[.)]\s+/;
const PAGE_NUMBER = /^(page\s*)?[-–]?\s*\d{1,4}\s*[-–]?(\s*(\/|sur|of|de)\s*\d{1,4})?$/i;
const END_OF_SENTENCE = /[.!?:;»"”)]$/;
const ZONE = 0.09;              // part de la hauteur de page considérée comme en-tête / pied de page
const MAX_HEADING_LEVELS = 4;
const SEGMENT_GAP = 1.5;        // espace (en tailles de police) qui sépare deux blocs sur une ligne
const TABLE_ROW_GAP = 2.6;      // écart vertical maximal entre deux lignes d'un même tableau
const OCR_SCALE = 2;            // résolution du rendu des pages pour l'OCR

const round = (v, step = 0.5) => Math.round(v / step) * step;
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

export default {
  id: "pdf",
  label: "PDF",
  kind: "pdf",
  icon: "pi-file-pdf",
  extensions: ["pdf"],

  async convert(file, { onProgress, ocr = false, requestPassword } = {}) {
    const lib = globalThis.pdfjsLib;
    if (!lib.GlobalWorkerOptions.workerSrc) lib.GlobalWorkerOptions.workerSrc = PDF_WORKER;

    const doc = await openDocument(lib, file, requestPassword);
    const useOcr = ocr && ocrAvailable();
    let ocrEngine = null;
    const pages = [];
    try {
      for (let n = 1; n <= doc.numPages; n++) {
        onProgress?.(n, doc.numPages, "Page");
        const page = await doc.getPage(n);
        const result = await readPage(page, n);
        if (result.empty && useOcr) {
          onProgress?.(n, doc.numPages, "OCR page");
          ocrEngine ??= await createOcr();
          result.ocrBlocks = textToParagraphs(await ocrEngine.recognize(await renderPage(page)));
        }
        pages.push(result);
        page.cleanup();
      }
    } finally {
      await ocrEngine?.terminate();
      doc.destroy();
    }
    return buildMarkdown(pages, { ocr: useOcr });
  },
};

/* ------------------------------------------------------- Ouverture du fichier */

// Ouvre le document et demande le mot de passe s'il est protégé.
async function openDocument(lib, file, requestPassword) {
  const data = new Uint8Array(await file.arrayBuffer());
  const task = lib.getDocument({ data });
  let cancelled = false;

  task.onPassword = async (setPassword, reason) => {
    const retry = reason === lib.PasswordResponses?.INCORRECT_PASSWORD;
    const password = requestPassword ? await requestPassword(file.name, retry) : null;
    if (password == null) {
      cancelled = true;
      task.destroy();
    } else {
      setPassword(password);
    }
  };

  try {
    return await task.promise;
  } catch (e) {
    if (cancelled) throw new Error("PDF protégé : mot de passe non fourni");
    if (e?.name === "PasswordException") throw new Error("PDF protégé par mot de passe");
    if (e?.name === "InvalidPDFException") throw new Error("Fichier PDF invalide ou endommagé");
    throw e;
  }
}

/* ------------------------------------------------------------------ 1. Lecture */

async function readPage(page, pageNumber) {
  const [vx0, vy0, vx1, vy1] = page.view;
  const width = vx1 - vx0;
  const height = vy1 - vy0;
  const content = await page.getTextContent();

  // Le chargement des polices donne leur nom réel (ex. « Arial-BoldMT »), utile pour le gras.
  let fontsReady = false;
  try { await page.getOperatorList(); fontsReady = true; } catch { /* sans gravité */ }

  const styleCache = new Map();
  const styleOf = (fontName) => {
    if (styleCache.has(fontName)) return styleCache.get(fontName);
    let name = "", bold = false, italic = false;
    try {
      if (fontsReady && page.commonObjs.has(fontName)) {
        const font = page.commonObjs.get(fontName);
        name = font?.name || "";
        bold = !!(font?.bold || font?.black);
        italic = !!font?.italic;
      }
    } catch { /* police non disponible */ }
    const label = name + " " + (content.styles?.[fontName]?.fontFamily || "");
    const style = {
      bold: bold || /bold|black|heavy|semibold|demibold/i.test(label),
      italic: italic || /italic|oblique/i.test(label),
    };
    styleCache.set(fontName, style);
    return style;
  };

  const links = await readLinks(page);

  // Fragments de texte (les doublons servant à simuler le gras sont ignorés).
  const seen = new Set();
  const items = [];
  for (const it of content.items) {
    if (typeof it.str !== "string" || !it.str.trim()) continue;
    const [a, b, c, d, x, y] = it.transform;
    const size = Math.hypot(c, d) || Math.hypot(a, b) || it.height || 10;
    const key = `${it.str}|${Math.round(x)}|${Math.round(y)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const item = { str: it.str, x, y, w: it.width || 0, size, link: null, ...styleOf(it.fontName) };
    for (const piece of splitByLinks(item, links)) if (piece.str) items.push(piece);
  }

  const segments = buildSegments(items);
  const gutter = findGutter(segments, vx0 + width * 0.3, vx0 + width * 0.7);
  const ordered = orderSegments(segments, gutter);
  const lines = mergeIntoLines(ordered).map((l) => {
    const fromTop = (vy1 - l.y) / height;
    const fromBottom = (l.y - vy0) / height;
    l.page = pageNumber;
    l.zone = fromTop < ZONE ? "top" : fromBottom < ZONE ? "bottom" : null;
    return l;
  });

  return { number: pageNumber, lines, empty: items.length === 0, twoColumns: gutter !== null };
}

// Liens externes de la page : zones rectangulaires associées à une URL.
async function readLinks(page) {
  try {
    const annotations = await page.getAnnotations();
    return annotations
      .filter((a) => a.subtype === "Link" && a.url && a.rect)
      .map((a) => {
        const [x1, y1, x2, y2] = a.rect;
        return { url: a.url, x0: Math.min(x1, x2), x1: Math.max(x1, x2), y0: Math.min(y1, y2), y1: Math.max(y1, y2) };
      });
  } catch {
    return [];
  }
}

// Découpe un fragment de texte selon les zones de lien qui le recouvrent.
// La position des caractères est estimée en supposant une largeur régulière.
function splitByLinks(item, links) {
  if (!links.length || !item.w) return [item];
  const midY = item.y + item.size * 0.3;
  for (const link of links) {
    if (midY < link.y0 - 1 || midY > link.y1 + 1) continue;
    if (link.x1 <= item.x || link.x0 >= item.x + item.w) continue;
    const n = item.str.length;
    const charWidth = item.w / n;
    const start = snapToWord(item.str, clamp(Math.round((link.x0 - item.x) / charWidth), 0, n), "start");
    const end = snapToWord(item.str, clamp(Math.round((link.x1 - item.x) / charWidth), 0, n), "end");
    if (end <= start) continue;
    const part = (a, b, url) => ({ ...item, str: item.str.slice(a, b), x: item.x + a * charWidth, w: (b - a) * charWidth, link: url });
    const others = links.filter((l) => l !== link);
    return [
      ...(start > 0 ? splitByLinks(part(0, start, item.link), others) : []),
      part(start, end, link.url),
      ...(end < n ? splitByLinks(part(end, n, item.link), others) : []),
    ];
  }
  return [item];
}

// Les largeurs de caractères étant estimées, on cale la borne d'un lien sur la limite
// de mot la plus proche (au plus 4 caractères d'écart).
function snapToWord(str, index, side) {
  const isBoundary = (p) => side === "start"
    ? p === 0 || /\s/.test(str[p - 1])
    : p === str.length || /[\s.,;:!?)]/.test(str[p]);
  const trimPunctuation = (p) => (side === "end" && p > 0 && /[.,;:!?]/.test(str[p - 1]) ? p - 1 : p);
  for (let d = 0; d <= 4; d++) {
    if (index - d >= 0 && isBoundary(index - d)) return trimPunctuation(index - d);
    if (index + d <= str.length && isBoundary(index + d)) return trimPunctuation(index + d);
  }
  return index;
}

/* -------------------------------------------------------------------- OCR */

async function renderPage(page) {
  const viewport = page.getViewport({ scale: OCR_SCALE });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return canvas;
}

// Texte brut de l'OCR → paragraphes (lignes recollées, césures retirées).
function textToParagraphs(text) {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.split("\n").map((s) => s.trim()).filter(Boolean).reduce((a, b) => (a ? joinText(a, b) : b), ""))
    .filter(Boolean)
    .map((p) => p.replace(/\*/g, "\\*"));
}

/* -------------------------------------------------------------- 2. Lignes */

// Regroupe les fragments par ligne de base, puis coupe chaque ligne aux grands espaces.
function buildSegments(items) {
  items.sort((p, q) => q.y - p.y || p.x - q.x);
  const rows = [];
  for (const it of items) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row.y - it.y) <= Math.min(row.size, it.size) * 0.45) {
      row.items.push(it);
      row.size = Math.max(row.size, it.size);
    } else {
      rows.push({ y: it.y, size: it.size, items: [it] });
    }
  }

  const segments = [];
  rows.forEach((row, rowId) => {
    row.items.sort((p, q) => p.x - q.x);
    let seg = null;
    for (const it of row.items) {
      const gap = seg ? it.x - seg.x1 : Infinity;
      if (!seg || gap > Math.max(it.size, seg.size) * SEGMENT_GAP) {
        seg = { rowId, y: row.y, x0: it.x, x1: it.x + it.w, size: it.size, items: [] };
        segments.push(seg);
      }
      seg.items.push(it);
      seg.x1 = Math.max(seg.x1, it.x + it.w);
      seg.size = Math.max(seg.size, it.size);
    }
  });
  return segments;
}

// Cherche une gouttière verticale (mise en page sur deux colonnes) : une position
// que presque aucune ligne ne traverse, avec de chaque côté au moins trois lignes
// alignées sur un même bord gauche (une vraie colonne, pas des éléments épars).
function findGutter(segments, from, to) {
  if (segments.length < 8) return null;
  let best = null;
  for (let x = from; x <= to; x += 2) {
    let left = 0, right = 0, cross = 0;
    for (const s of segments) {
      if (s.x1 <= x) left++;
      else if (s.x0 >= x) right++;
      else cross++;
    }
    if (left < 3 || right < 3) continue;
    if (!best || cross < best.cross) best = { x, cross };
  }
  if (!best || best.cross > Math.max(1, segments.length * 0.1)) return null;

  const alignedCount = (side) => {
    const buckets = new Map();
    for (const s of side) {
      const k = Math.round(s.x0 / 3);
      buckets.set(k, (buckets.get(k) || 0) + 1);
    }
    return Math.max(0, ...buckets.values());
  };
  // Une colonne de texte a des lignes larges ; une colonne de dates ou de montants non.
  const typicalWidth = (side) => median(side.map((s) => s.x1 - s.x0)) || 0;
  const minWidth = (to - from) * 0.35;  // ≈ 14 % de la largeur de page
  const isColumn = (side) => alignedCount(side) >= 3 && typicalWidth(side) >= minWidth;
  const left = segments.filter((s) => s.x1 <= best.x);
  const right = segments.filter((s) => s.x0 >= best.x);
  return isColumn(left) && isColumn(right) ? best.x : null;
}

// Ordre de lecture : colonne de gauche puis colonne de droite, entre deux blocs pleine largeur.
function orderSegments(segments, gutter) {
  if (gutter === null) {
    segments.forEach((s) => (s.col = "full"));
    return segments;
  }
  const out = [];
  let left = [], right = [];
  const flush = () => { out.push(...left, ...right); left = []; right = []; };
  for (const s of segments) {
    if (s.x1 <= gutter) { s.col = "left"; left.push(s); }
    else if (s.x0 >= gutter) { s.col = "right"; right.push(s); }
    else { s.col = "full"; flush(); out.push(s); }
  }
  flush();
  return out;
}

// Fusionne les segments d'une même ligne et d'une même colonne, et calcule le style.
function mergeIntoLines(segments) {
  const lines = [];
  for (const seg of segments) {
    const last = lines[lines.length - 1];
    if (last && last.rowId === seg.rowId && last.col === seg.col) {
      last.items.push({ gapBefore: true }, ...seg.items);
      last.segs.push(seg);
      last.x1 = seg.x1;
    } else {
      lines.push({ rowId: seg.rowId, col: seg.col, y: seg.y, x0: seg.x0, x1: seg.x1, items: [...seg.items], segs: [seg] });
    }
  }
  return lines.map(finishLine);
}

// Texte brut d'une suite de fragments, avec les espaces déduits des écarts.
function itemsText(items) {
  let s = "";
  let prev = null;
  for (const it of items) {
    if (prev) {
      const gap = it.x - (prev.x + prev.w);
      if (gap > it.size * 0.12 && !/\s$/.test(s) && !/^\s/.test(it.str)) s += " ";
    }
    s += it.str;
    prev = it;
  }
  return s.replace(/\s+/g, " ").trim();
}

function finishLine(line) {
  // Texte et passages en gras / italique / lien.
  const runs = [];
  let prev = null;
  const sizes = new Map();
  let chars = 0, boldChars = 0;
  for (const it of line.items) {
    if (it.gapBefore) { prev = null; pushText(runs, " ", null); continue; }
    if (prev) {
      const gap = it.x - (prev.x + prev.w);
      if (gap > it.size * 0.12 && !/\s$/.test(prev.str) && !/^\s/.test(it.str)) pushText(runs, " ", null);
    }
    pushText(runs, it.str, it);
    const n = it.str.trim().length;
    chars += n;
    if (it.bold) boldChars += n;
    const s = round(it.size);
    sizes.set(s, (sizes.get(s) || 0) + n);
    prev = it;
  }
  // Supprime les espaces en début et en fin de ligne.
  if (runs.length) runs[0].text = runs[0].text.replace(/^\s+/, "");
  if (runs.length) runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\s+$/, "");

  const plain = runs.map((r) => r.text).join("").replace(/\s+/g, " ");
  const size = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 10;
  return {
    col: line.col, y: line.y, x0: line.x0, x1: line.x1,
    runs, plain, size, bold: chars > 0 && boldChars / chars > 0.9,
    segs: line.segs.map((s) => ({ x0: s.x0, x1: s.x1, text: itemsText(s.items) })),
    tabular: line.segs.length > 1,   // plusieurs blocs espacés sur la ligne (tableau, libellé / valeur)
  };
}

// Ajoute du texte à la ligne en regroupant les passages de même style.
// Un espace ajouté (item = null) prend le style du passage précédent.
function pushText(runs, text, item) {
  const last = runs[runs.length - 1];
  const bold = item ? item.bold : last?.bold ?? false;
  const italic = item ? item.italic : last?.italic ?? false;
  const link = item ? item.link : last?.link ?? null;
  if (last && last.bold === bold && last.italic === italic && last.link === link) last.text += text;
  else runs.push({ text, bold, italic, link });
}

/* ----------------------------------------------- 3 à 6. Analyse du document */

function buildMarkdown(pages, { ocr }) {
  if (!pages.some((p) => p.lines.length || p.ocrBlocks?.length)) {
    return ocr
      ? "*(Aucun texte reconnu dans ce document.)*\n"
      : "*(Aucun texte extractible : le document est probablement scanné. Activez l'option OCR pour le lire.)*\n";
  }
  removeRunningLines(pages);

  const bodySize = dominantSize(pages.flatMap((p) => p.lines.filter((l) => !l.drop)));
  for (const p of pages) detectTables(p);

  const lines = pages.flatMap((p) => p.lines.filter((l) => !l.drop && !l.table));
  const levelBySize = headingLevels(lines, bodySize);
  const boldLevel = clamp(new Set(levelBySize.values()).size + 1, 2, MAX_HEADING_LEVELS);
  for (const l of lines) classify(l, bodySize, levelBySize, boldLevel);

  return assemble(pages, bodySize, { ocr });
}

// En-têtes et pieds de page : lignes identiques (aux chiffres près) en haut ou en bas
// de la majorité des pages, et numéros de page isolés.
function removeRunningLines(pages) {
  const keyOf = (l) => l.zone + "|" + l.plain.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  const counts = new Map();
  for (const p of pages) {
    const keys = new Set(p.lines.filter((l) => l.zone).map(keyOf));
    for (const k of keys) counts.set(k, (counts.get(k) || 0) + 1);
  }
  const threshold = Math.max(2, Math.ceil(pages.length * 0.5));
  for (const p of pages) {
    for (const l of p.lines) {
      if (!l.zone) continue;
      if (PAGE_NUMBER.test(l.plain.trim())) l.drop = true;
      else if (pages.length >= 2 && counts.get(keyOf(l)) >= threshold) l.drop = true;
    }
  }
}

// Taille du texte courant : celle qui couvre le plus de caractères.
function dominantSize(lines) {
  const count = new Map();
  for (const l of lines) count.set(l.size, (count.get(l.size) || 0) + l.plain.length);
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 10;
}

/* ------------------------------------------------------------- Tableaux */

// Un tableau est une suite d'au moins deux lignes « à blocs » (plusieurs segments
// espacés) proches verticalement, dont les blocs s'alignent sur les mêmes colonnes.
function detectTables(page) {
  const lines = page.lines.filter((l) => !l.drop);
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].tabular) { i++; continue; }
    // Lignes candidates : proches verticalement, dans la même colonne de page.
    let j = i + 1;
    while (j < lines.length) {
      const a = lines[j - 1], b = lines[j];
      const gap = a.y - b.y;
      if (b.col !== a.col || gap <= 0 || gap > Math.max(a.size, b.size) * TABLE_ROW_GAP) break;
      j++;
    }
    const table = buildTable(lines.slice(i, j));
    if (table) {
      table.lines.forEach((l, k) => { l.table = table; l.tableStart = k === 0; });
      i += table.lines.length;
    } else {
      i++;
    }
  }
}

function buildTable(block) {
  const rowLines = block.filter((l) => l.tabular);
  if (rowLines.length < 2) return null;

  // Colonnes : zones horizontales couvertes par au moins un bloc, séparées par du vide.
  const intervals = rowLines.flatMap((l) => l.segs.map((s) => [s.x0, s.x1])).sort((a, b) => a[0] - b[0]);
  const spans = [];
  for (const [a, b] of intervals) {
    const last = spans[spans.length - 1];
    if (last && a <= last[1] + 2) last[1] = Math.max(last[1], b);
    else spans.push([a, b]);
  }
  if (spans.length < 2 || spans.length > 15) return null;

  const columnOf = (s) => {
    const c = (s.x0 + s.x1) / 2;
    const k = spans.findIndex(([a, b]) => c >= a - 1 && c <= b + 1);
    return k < 0 ? 0 : k;
  };
  const fitsOneColumn = (l) =>
    l.segs.length === 1 && spans.some(([a, b]) => l.segs[0].x0 >= a - 2 && l.segs[0].x1 <= b + 2);
  const addTo = (row, s) => {
    const k = columnOf(s);
    row[k] = row[k] ? row[k] + " " + s.text : s.text;
  };

  const rows = [];
  const used = [];
  for (const l of block) {
    if (l.tabular) {
      const row = spans.map(() => "");
      l.segs.forEach((s) => addTo(row, s));
      rows.push(row);
    } else if (rows.length && fitsOneColumn(l)) {
      addTo(rows[rows.length - 1], l.segs[0]);   // suite d'une cellule sur plusieurs lignes
    } else {
      break;
    }
    used.push(l);
  }
  // Une ligne simple en fin de bloc appartient plutôt au texte qui suit.
  while (used.length && !used[used.length - 1].tabular) {
    const l = used.pop();
    const row = rows[rows.length - 1];
    const k = columnOf(l.segs[0]);
    row[k] = row[k].slice(0, row[k].length - l.segs[0].text.length).trim();
  }

  const filled = rows.filter((r) => r.filter(Boolean).length >= 2).length;
  if (rows.length < 2 || filled < rows.length * 0.6) return null;
  return { lines: used, md: tableToMd(rows) };
}

/* ---------------------------------------------------------------- Titres */

// Tailles plus grandes que le texte courant → niveaux de titre (# ## ### ####).
function headingLevels(lines, bodySize) {
  const sizes = [...new Set(
    lines.filter((l) => l.size >= bodySize * 1.15 && l.plain.length <= 150).map((l) => l.size)
  )].sort((a, b) => b - a);
  const map = new Map();
  let level = 0, clusterTop = null;
  for (const s of sizes) {
    if (clusterTop === null || clusterTop - s > 1) { level++; clusterTop = s; }
    map.set(s, Math.min(level, MAX_HEADING_LEVELS));
  }
  return map;
}

function classify(l, bodySize, levelBySize, boldLevel) {
  const text = l.plain.trim();
  const shortLine = text.length <= 150;
  if (levelBySize.has(l.size) && shortLine && /\p{L}/u.test(text)) {
    l.kind = "heading"; l.level = levelBySize.get(l.size); return;
  }
  const bullet = text.match(BULLET);
  if (bullet && text.length > bullet[0].length) {
    l.kind = "item"; l.md = "- " + runsToMd(l.runs, bullet[0].length); return;
  }
  if (l.bold && text.length <= 80 && !/[.,;:]$/.test(text) && /^[\p{Lu}\d]/u.test(text) && l.size >= bodySize * 0.95) {
    l.kind = "heading"; l.level = boldLevel; return;
  }
  const num = text.match(NUMBERED);
  if (num && text.length > num[0].length) {
    l.kind = "item"; l.md = num[1] + ". " + runsToMd(l.runs, num[0].length); return;
  }
  l.kind = "text";
  l.md = runsToMd(l.runs, 0);
}

/* ------------------------------------------------------- Texte Markdown */

// Texte Markdown d'une ligne avec gras / italique / liens, en sautant `skip` caractères (puce).
function runsToMd(runs, skip) {
  let out = "";
  let remaining = skip;
  for (const r of runs) {
    let t = r.text;
    if (remaining > 0) {
      const k = Math.min(remaining, t.length);
      t = t.slice(k);
      remaining -= k;
    }
    if (!t) continue;
    t = t.replace(/\s+/g, " ").replace(/\*/g, "\\*");
    let piece = wrap(t, r.bold, r.italic);
    if (r.link) piece = linkify(piece, r.link);
    out += piece;
  }
  return out.replace(/^\s+/, "").replace(/^#/, "\\#");
}

function wrap(text, bold, italic) {
  if (!bold && !italic) return text;
  const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
  if (!m[2]) return text;
  const mark = bold && italic ? "***" : bold ? "**" : "*";
  return m[1] + mark + m[2] + mark + m[3];
}

function linkify(text, url) {
  const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
  if (!m[2]) return text;
  const safeUrl = url.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
  return `${m[1]}[${m[2].replace(/([[\]])/g, "\\$1")}](${safeUrl})${m[3]}`;
}

function joinText(a, b) {
  if (/\p{L}-$/u.test(a) && /^\p{Ll}/u.test(b)) return a.slice(0, -1) + b;   // césure
  return a + " " + b;
}

/* ------------------------------------------------------------ Assemblage */

function assemble(pages, bodySize, { ocr }) {
  const blocks = [];
  let cur = null;     // bloc en cours : { type, text, level?, depth?, x0? }
  let prev = null;    // ligne précédente
  let listBase = null;
  const close = () => { if (cur) blocks.push(cur); cur = null; };

  for (const page of pages) {
    if (page.ocrBlocks) {
      close();
      prev = null;
      listBase = null;
      if (page.ocrBlocks.length) page.ocrBlocks.forEach((text) => blocks.push({ type: "text", text }));
      else blocks.push({ type: "note", text: `*(Page ${page.number} : aucun texte reconnu.)*` });
      continue;
    }
    const lines = page.lines.filter((l) => !l.drop);
    if (!lines.length) {
      if (page.empty) {
        close();
        const hint = ocr ? "" : " Activez l'option OCR pour la lire.";
        blocks.push({ type: "note", text: `*(Page ${page.number} sans texte extractible, probablement scannée.${hint})*` });
      }
      continue;
    }

    // Interligne habituel et marge gauche de chaque colonne, pour cette page.
    const gaps = [];
    const margins = {};
    lines.forEach((l, i) => {
      if (l.kind === "text") margins[l.col] = Math.min(margins[l.col] ?? Infinity, l.x0);
      const p = lines[i - 1];
      if (p && p.col === l.col && p.kind === "text" && l.kind === "text") {
        const d = p.y - l.y;
        if (d > 0 && d < bodySize * 3) gaps.push(d);
      }
    });
    const lineGap = median(gaps) || bodySize * 1.2;

    for (const l of lines) {
      const sameFlow = prev && prev.page === l.page && prev.col === l.col;
      const gap = sameFlow ? prev.y - l.y : Infinity;

      if (l.table) {
        if (l.tableStart) { close(); blocks.push({ type: "table", text: l.table.md }); }
        listBase = null;
      } else if (l.kind === "heading") {
        const continues = cur?.type === "heading" && cur.level === l.level && sameFlow && gap < l.size * 1.8;
        if (continues) cur.text += " " + l.plain.trim();
        else { close(); cur = { type: "heading", level: l.level, text: l.plain.trim() }; }
        listBase = null;
      } else if (l.kind === "item") {
        close();
        if (listBase === null || l.x0 < listBase) listBase = l.x0;
        cur = { type: "item", depth: clamp(Math.round((l.x0 - listBase) / (bodySize * 1.5)), 0, 3), text: l.md, x0: l.x0 };
      } else {
        let newBlock;
        if (!cur || cur.type === "heading" || cur.type === "note" || l.tabular || prev?.tabular) newBlock = true;
        else if (cur.type === "item") newBlock = !(sameFlow && gap <= lineGap * 1.4 && l.x0 > cur.x0 + bodySize * 0.5);
        else if (sameFlow) {
          const margin = margins[l.col] ?? l.x0;
          const indented = l.x0 - margin > bodySize * 1.2 && l.x0 - margin < bodySize * 5 && prev.x0 - margin < bodySize * 0.5;
          newBlock = gap > lineGap * 1.45 || indented;
        } else {
          // Changement de colonne ou de page : on poursuit la phrase si elle n'est pas terminée.
          newBlock = END_OF_SENTENCE.test(cur.text) || !/^\p{Ll}/u.test(l.plain.trim());
        }
        if (newBlock) {
          close();
          cur = { type: "text", text: l.md };
          listBase = null;
        } else {
          cur.text = joinText(cur.text, l.md);
        }
      }
      prev = l;
    }
  }
  close();

  let md = "";
  blocks.forEach((b, i) => {
    let text;
    if (b.type === "heading") text = "#".repeat(b.level) + " " + b.text;
    else if (b.type === "item") text = "  ".repeat(b.depth) + b.text;
    else text = b.text;
    if (i > 0) md += b.type === "item" && blocks[i - 1].type === "item" ? "\n" : "\n\n";
    md += text;
  });
  return tidy(md.replace(/\*\*\s*\*\*/g, " "));
}
