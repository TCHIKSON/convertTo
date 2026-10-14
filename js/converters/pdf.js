// Convertisseur PDF basé sur pdf.js (globale `pdfjsLib` chargée dans index.html).
//
// Étapes :
//   1. Lecture de chaque page : fragments de texte avec position, taille et style.
//   2. Reconstitution des lignes, avec détection des mises en page sur deux colonnes.
//   3. Suppression des en-têtes et pieds de page répétés, et des numéros de page.
//   4. Hiérarchie des titres calculée sur tout le document (taille de police et gras).
//   5. Assemblage en paragraphes, listes et titres Markdown.

import { tidy } from "../utils/markdown.js";

const PDF_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";

const BULLET = /^[•▪◦●○■□➢►▶✓–\-*]\s+/;
const NUMBERED = /^(\d{1,3}|[a-z])[.)]\s+/;
const PAGE_NUMBER = /^(page\s*)?[-–]?\s*\d{1,4}\s*[-–]?(\s*(\/|sur|of|de)\s*\d{1,4})?$/i;
const END_OF_SENTENCE = /[.!?:;»"”)]$/;
const ZONE = 0.09;           // part de la hauteur de page considérée comme en-tête / pied de page
const MAX_HEADING_LEVELS = 4;

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

  async convert(file, { onProgress } = {}) {
    const lib = globalThis.pdfjsLib;
    if (!lib.GlobalWorkerOptions.workerSrc) lib.GlobalWorkerOptions.workerSrc = PDF_WORKER;

    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await lib.getDocument({ data }).promise;
    const pages = [];
    try {
      for (let n = 1; n <= doc.numPages; n++) {
        onProgress?.(n, doc.numPages);
        const page = await doc.getPage(n);
        pages.push(await readPage(page, n));
        page.cleanup();
      }
    } finally {
      doc.destroy();
    }
    return buildMarkdown(pages);
  },
};

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
    items.push({ str: it.str, x, y, w: it.width || 0, size, ...styleOf(it.fontName) });
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
      if (!seg || gap > Math.max(it.size, seg.size) * 1.5) {
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
      last.x1 = seg.x1;
    } else {
      lines.push({ rowId: seg.rowId, col: seg.col, y: seg.y, x0: seg.x0, x1: seg.x1, items: [...seg.items] });
    }
  }
  return lines.map(finishLine);
}

function finishLine(line) {
  // Texte et passages en gras / italique.
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
    tabular: line.items.some((it) => it.gapBefore),   // éléments espacés sur la ligne (libellé / valeur)
  };
}

function pushText(runs, text, item) {
  const last = runs[runs.length - 1];
  const bold = item ? item.bold : last?.bold ?? false;
  const italic = item ? item.italic : last?.italic ?? false;
  if (last && last.bold === bold && last.italic === italic) last.text += text;
  else runs.push({ text, bold, italic });
}

/* ----------------------------------------------- 3 à 5. Analyse du document */

function buildMarkdown(pages) {
  if (!pages.some((p) => p.lines.length)) {
    return "*(Aucun texte extractible : le document est probablement scanné.)*\n";
  }
  removeRunningLines(pages);

  const lines = pages.flatMap((p) => p.lines.filter((l) => !l.drop));
  const bodySize = dominantSize(lines);
  const levelBySize = headingLevels(lines, bodySize);
  const boldLevel = clamp(new Set(levelBySize.values()).size + 1, 2, MAX_HEADING_LEVELS);
  for (const l of lines) classify(l, bodySize, levelBySize, boldLevel);

  return assemble(pages, bodySize);
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

// Texte Markdown d'une ligne avec gras / italique, en sautant `skip` caractères (puce).
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
    out += wrap(t, r.bold, r.italic);
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

function joinText(a, b) {
  if (/\p{L}-$/u.test(a) && /^\p{Ll}/u.test(b)) return a.slice(0, -1) + b;   // césure
  return a + " " + b;
}

// Assemble les lignes en blocs Markdown.
function assemble(pages, bodySize) {
  const blocks = [];
  let cur = null;     // bloc en cours : { type, text, level?, depth?, x0? }
  let prev = null;    // ligne précédente
  let listBase = null;
  const close = () => { if (cur) blocks.push(cur); cur = null; };

  for (const page of pages) {
    const lines = page.lines.filter((l) => !l.drop);
    if (!lines.length) {
      if (page.empty) { close(); blocks.push({ type: "note", text: `*(Page ${page.number} sans texte extractible, probablement scannée.)*` }); }
      continue;
    }

    // Interligne habituel et marge gauche de chaque colonne, pour cette page.
    const gaps = [];
    const margins = {};
    lines.forEach((l, i) => {
      if (l.kind === "text") margins[l.col] = Math.min(margins[l.col] ?? Infinity, l.x0);
      const p = lines[i - 1];
      if (p && p.col === l.col && p.kind !== "heading" && l.kind !== "heading") {
        const d = p.y - l.y;
        if (d > 0 && d < bodySize * 3) gaps.push(d);
      }
    });
    const lineGap = median(gaps) || bodySize * 1.2;

    for (const l of lines) {
      const sameFlow = prev && prev.page === l.page && prev.col === l.col;
      const gap = sameFlow ? prev.y - l.y : Infinity;

      if (l.kind === "heading") {
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
