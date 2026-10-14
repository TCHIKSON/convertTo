// Mise en forme du document : classement des lignes (titres, listes, code…)
// et assemblage du Markdown final.

import { clamp, median } from "./geometry.js";
import { scriptText } from "./lines.js";
import { frontMatter } from "./structure.js";
import { formsToMd, annotationsToMd } from "./annotations.js";
import { tableToMd, tidy } from "../../utils/markdown.js";

const BULLET = /^[•▪◦●○■□➢►▶✓–\-*]\s+/;
const NUMBERED = /^(\d{1,3}|[a-z])[.)]\s+/;
const PAGE_NUMBER = /^(page\s*)?[-–]?\s*\d{1,4}\s*[-–]?(\s*(\/|sur|of|de)\s*\d{1,4})?$/i;
const END_OF_SENTENCE = /[.!?:;»"”)]$/;
const MAX_HEADING_LEVELS = 6;
const PAGE_NUMBER_ZONE = 0.16;  // distance maximale au bord pour un numéro de page isolé
const TABLE_ROW_GAP = 2.6;      // écart vertical maximal entre deux lignes d'un tableau sans bordures

const isText = (l) => !l.placeholder && !l.drop;

/**
 * @param pages  résultats de buildPage()
 * @param ctx    { info, outline, fields, notes, ocr }
 */
export function buildMarkdown(pages, ctx) {
  const header = frontMatter(ctx.info);
  const extras = [formsToMd(ctx.fields), annotationsToMd(ctx.notes)].filter(Boolean);

  const hasContent = pages.some((p) => p.lines.length || p.ocrBlocks?.length);
  if (!hasContent) {
    const note = ctx.ocr
      ? "*(Aucun texte reconnu dans ce document.)*"
      : "*(Aucun texte extractible : le document est probablement scanné. Activez l'option OCR pour le lire.)*";
    return tidy(header + [note, ...extras].join("\n\n"));
  }

  removeRunningLines(pages);
  const textLines = pages.flatMap((p) => p.lines.filter(isText));
  const bodySize = dominantSize(textLines);
  for (const p of pages) detectTables(p);

  const lines = textLines.filter((l) => !l.table);
  matchOutline(pages, ctx.outline || []);
  const levelBySize = headingLevels(lines, bodySize);
  const boldLevel = clamp(new Set(levelBySize.values()).size + 1, 2, 4);
  for (const l of lines) classify(l, bodySize, levelBySize, boldLevel);

  const body = assemble(pages, bodySize, ctx);
  return tidy(header + [body, ...extras].filter(Boolean).join("\n\n"));
}

/* -------------------------------------------------- En-têtes et pieds de page */

// Lignes identiques (aux chiffres près) en haut ou en bas de la majorité des pages,
// et numéros de page isolés.
function removeRunningLines(pages) {
  const keyOf = (l) => l.zone + "|" + l.plain.toLowerCase().replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
  const counts = new Map();
  for (const p of pages) {
    const keys = new Set(p.lines.filter((l) => l.zone && !l.placeholder).map(keyOf));
    for (const k of keys) counts.set(k, (counts.get(k) || 0) + 1);
  }
  const threshold = Math.max(2, Math.ceil(pages.length * 0.5));
  for (const p of pages) {
    for (const l of p.lines) {
      if (l.placeholder) continue;
      // Un numéro de page isolé peut être placé un peu plus loin du bord (LaTeX, Word).
      if (l.edge < PAGE_NUMBER_ZONE && PAGE_NUMBER.test(l.plain.trim()) && isLastOrFirstOnPage(p, l)) l.drop = true;
      else if (l.zone && pages.length >= 2 && counts.get(keyOf(l)) >= threshold) l.drop = true;
    }
  }
}

// Le numéro de page est la première ou la dernière ligne de texte de la page.
function isLastOrFirstOnPage(page, line) {
  const text = page.lines.filter((l) => !l.placeholder);
  const top = Math.max(...text.map((l) => l.y));
  const bottom = Math.min(...text.map((l) => l.y));
  return line.y === top || line.y === bottom;
}

function dominantSize(lines) {
  const count = new Map();
  for (const l of lines) count.set(l.size, (count.get(l.size) || 0) + l.plain.length);
  return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 10;
}

/* ------------------------------------------------- Tableaux sans bordures */

// Suite d'au moins deux lignes « à blocs » proches verticalement, dont les blocs
// s'alignent sur les mêmes colonnes.
function detectTables(page) {
  const lines = page.lines.filter((l) => !l.drop);
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].tabular || lines[i].role === "Code") { i++; continue; }
    let j = i + 1;
    while (j < lines.length) {
      const a = lines[j - 1], b = lines[j];
      const gap = a.y - b.y;
      if (b.placeholder || b.col !== a.col || gap <= 0 || gap > Math.max(a.size, b.size) * TABLE_ROW_GAP) break;
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

/* ----------------------------------------------------------------- Titres */

const normalizeTitle = (s) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^\p{L}\p{N}]+/gu, "");

// Associe chaque signet à la ligne de titre correspondante (même page si connue).
function matchOutline(pages, outline) {
  const candidates = pages.flatMap((p) => p.lines.filter((l) => isText(l) && !l.table && l.plain.length <= 200));
  let from = 0;
  for (const entry of outline) {
    const target = normalizeTitle(entry.title);
    if (target.length < 2) continue;
    const matches = (l) => {
      if (entry.page && l.page !== entry.page) return false;
      const text = normalizeTitle(l.plain);
      if (!text) return false;
      if (text === target) return true;
      // Numérotation devant le titre : « 1.2 Méthode », « IV. Résultats »
      if (text.endsWith(target) && /^[\divxlc]{1,6}$/.test(text.slice(0, text.length - target.length))) return true;
      // Titre sur plusieurs lignes : la première ligne commence le signet
      return text.length >= 8 && target.startsWith(text);
    };
    let index = candidates.findIndex((l, k) => k >= from && !l.outlineLevel && matches(l));
    if (index < 0) index = candidates.findIndex((l) => !l.outlineLevel && matches(l));
    if (index >= 0) {
      candidates[index].outlineLevel = Math.min(entry.level, MAX_HEADING_LEVELS);
      from = index + 1;
    }
  }
}

// Tailles plus grandes que le texte courant → niveaux de titre.
function headingLevels(lines, bodySize) {
  const sizes = [...new Set(
    lines.filter((l) => !l.mono && l.size >= bodySize * 1.15 && l.plain.length <= 150).map((l) => l.size)
  )].sort((a, b) => b - a);
  const map = new Map();
  let level = 0, clusterTop = null;
  for (const s of sizes) {
    if (clusterTop === null || clusterTop - s > 1) { level++; clusterTop = s; }
    map.set(s, Math.min(level, 4));
  }
  return map;
}

function classify(l, bodySize, levelBySize, boldLevel) {
  const text = l.plain.trim();
  const tagLevel = /^H([1-6])$/.exec(l.role || "");

  if (l.mono || l.role === "Code") { l.kind = "code"; return; }
  if (l.outlineLevel) { l.kind = "heading"; l.level = l.outlineLevel; return; }
  if (tagLevel) { l.kind = "heading"; l.level = Number(tagLevel[1]); return; }
  if ((l.role === "Title" || l.role === "H") && text.length <= 150) { l.kind = "heading"; l.level = 1; return; }
  if (levelBySize.has(l.size) && text.length <= 150 && /\p{L}/u.test(text)) {
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
  l.kind = l.role === "BlockQuote" || l.role === "Quote" ? "quote" : "text";
  l.md = runsToMd(l.runs, 0);
}

/* ------------------------------------------------------- Texte Markdown */

// Texte d'une ligne avec gras, italique, code, liens, exposants ; `skip` caractères sautés (puce).
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
    t = t.replace(/\s+/g, " ");
    let piece;
    if (r.mono && t.trim()) piece = wrapAround(t, (s) => "`" + s.replace(/`/g, "'") + "`");
    else if (r.script && t.trim()) piece = wrapAround(t, (s) => scriptText(s, r.script));
    else piece = wrap(t.replace(/\*/g, "\\*"), r.bold, r.italic);
    if (r.link) piece = wrapAround(piece, (s) => `[${s.replace(/([[\]])/g, "\\$1")}](${safeUrl(r.link)})`);
    out += piece;
  }
  return out.replace(/^\s+/, "").replace(/^#/, "\\#");
}

// Applique `fn` au texte en conservant les espaces de début et de fin.
function wrapAround(text, fn) {
  const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
  return m[2] ? m[1] + fn(m[2]) + m[3] : text;
}

function wrap(text, bold, italic) {
  if (!bold && !italic) return text;
  const mark = bold && italic ? "***" : bold ? "**" : "*";
  return wrapAround(text, (s) => mark + s + mark);
}

const safeUrl = (url) => url.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");

export function joinText(a, b) {
  if (/\p{L}-$/u.test(a) && /^\p{Ll}/u.test(b)) return a.slice(0, -1) + b;   // césure
  return a + " " + b;
}

/* --------------------------------------------------------------- Figures */

const FIGURE_LABEL = { image: "Image", diagram: "Diagramme", equation: "Équation" };

function figureMd(fig) {
  const label = FIGURE_LABEL[fig.kind];
  if (fig.rendered) {
    let alt = fig.alt || (fig.kind === "equation" ? `Équation : ${fig.lines.join(" ")}` : label);
    alt = alt.replace(/\s+/g, " ").replace(/([[\]])/g, "\\$1");
    if (alt.length > 200) alt = alt.slice(0, 199) + "…";
    let md = `![${alt}](${fig.path})`;
    if (fig.ocrText) md += `\n\n> **Texte de l'image :** ${fig.ocrText}`;
    return md;
  }
  if (fig.kind === "equation") return "```text\n" + fig.lines.join("\n") + "\n```";
  return `*(${fig.alt || label})*`;
}

/* ------------------------------------------------------------ Assemblage */

function assemble(pages, bodySize, ctx) {
  const blocks = [];
  let cur = null;     // bloc en cours
  let prev = null;    // ligne précédente
  let listBase = null;
  const close = () => { if (cur) blocks.push(cur); cur = null; };

  for (const page of pages) {
    if (page.ocrBlocks) {
      close(); prev = null; listBase = null;
      if (page.ocrBlocks.length) page.ocrBlocks.forEach((text) => blocks.push({ type: "text", text }));
      else blocks.push({ type: "note", text: `*(Page ${page.number} : aucun texte reconnu.)*` });
      continue;
    }
    const lines = page.lines.filter((l) => !l.drop);
    if (page.empty) {
      close();
      const hint = ctx.ocr ? "" : " Activez l'option OCR pour la lire.";
      blocks.push({ type: "note", text: `*(Page ${page.number} sans texte extractible, probablement scannée.${hint})*` });
      if (!lines.some((l) => l.placeholder)) continue;   // sinon l'image de la page suit
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
      const sameFlow = prev && !prev.placeholder && prev.page === l.page && prev.col === l.col;
      const gap = sameFlow ? prev.y - l.y : Infinity;

      if (l.placeholder) {
        close();
        if (l.placeholder.table) blocks.push({ type: "table", text: l.placeholder.table.md });
        else blocks.push({ type: "figure", text: figureMd(l.placeholder.figure) });
        listBase = null;
      } else if (l.table) {
        if (l.tableStart) { close(); blocks.push({ type: "table", text: l.table.md }); }
        listBase = null;
      } else if (l.kind === "code") {
        if (cur?.type === "code" && sameFlow && gap <= Math.max(lineGap, l.size * 1.3) * 2.2) cur.lines.push(l);
        else { close(); cur = { type: "code", lines: [l] }; }
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
        if (!cur || !["text", "item", "quote"].includes(cur.type) || l.tabular || prev?.tabular || cur.type !== l.kind && cur.type !== "item") newBlock = true;
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
          cur = { type: l.kind, text: l.md };
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
    else if (b.type === "quote") text = "> " + b.text;
    else if (b.type === "code") text = codeBlock(b.lines);
    else text = b.text;
    if (i > 0) md += b.type === "item" && blocks[i - 1].type === "item" ? "\n" : "\n\n";
    md += text;
  });
  return md.replace(/\*\*\s*\*\*/g, " ");
}

// Bloc de code : l'indentation est déduite de la position horizontale de chaque ligne.
function codeBlock(lines) {
  const left = Math.min(...lines.map((l) => l.x0));
  const body = lines.map((l) => {
    const indent = Math.max(0, Math.round((l.x0 - left) / (l.size * 0.6)));
    return " ".repeat(indent) + l.codeText;
  });
  const fence = body.some((s) => s.includes("```")) ? "~~~" : "```";
  return fence + "\n" + body.join("\n") + "\n" + fence;
}
