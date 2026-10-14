// Reconstitution des lignes d'une page : regroupement des fragments, colonnes,
// styles par passage (gras, italique, code, lien, exposant) et repérage des équations.

import { round, median } from "./geometry.js";
import { itemsText } from "./text.js";

const SEGMENT_GAP = 1.5;      // espace (en tailles de police) qui sépare deux blocs sur une ligne
const ROW_TOLERANCE = 0.5;    // écart vertical admis dans une même ligne (exposants compris)
const MATH_SYMBOL = /[=+−±×÷√∑∏∫∮∂∞≤≥≠≈≡∈∉⊂⊃⊆⊇∪∩∀∃∇→←↔⇒⇔′″αβγδεζηθικλμνξπρσςτυφχψωΓΔΘΛΞΠΣΦΨΩ]/;
const STRONG_MATH = /[√∑∏∫∮∂∞≤≥≠≈≡∈∉⊂⊃⊆⊇∪∩∀∃∇⇒⇔αβγδεζηθικλμνξπρσςτυφχψωΓΔΘΛΞΠΣΦΨΩ]/;

/**
 * Construit les lignes d'une page.
 * @param items         fragments de texte restant à placer dans le flux
 * @param placeholders  zones déjà converties (tableaux, figures) : [{ bbox, table?, figure? }]
 * @param view          page.view
 */
export function buildLines(items, placeholders, view) {
  const [vx0, , vx1] = view;
  const width = vx1 - vx0;
  const textSegments = buildSegments(items);
  const placeholderSegments = placeholders.map((p, k) => ({
    rowId: `placeholder-${k}`, y: p.bbox[3], x0: p.bbox[0], x1: p.bbox[2], size: 0, items: [], placeholder: p,
  }));
  const gutter = findGutter(textSegments, vx0 + width * 0.3, vx0 + width * 0.7);
  const all = textSegments.concat(placeholderSegments).sort((p, q) => q.y - p.y || p.x0 - q.x0);
  const lines = mergeIntoLines(orderSegments(all, gutter));
  return { lines, twoColumns: gutter !== null };
}

/* ------------------------------------------------------------- Segments */

// Regroupe les fragments par ligne, puis coupe chaque ligne aux grands espaces.
function buildSegments(items) {
  items = [...items].sort((p, q) => q.y - p.y || p.x - q.x);
  const rows = [];
  for (const it of items) {
    const row = rows[rows.length - 1];
    if (row && Math.abs(row.ref.y - it.y) <= Math.max(row.ref.size, it.size) * ROW_TOLERANCE) {
      row.items.push(it);
      if (it.size > row.ref.size) row.ref = it;   // la ligne de base suit le texte le plus grand
    } else {
      rows.push({ ref: it, items: [it] });
    }
  }

  const segments = [];
  rows.forEach((row, rowId) => {
    row.items.sort((p, q) => p.x - q.x);
    let seg = null;
    for (const it of row.items) {
      const gap = seg ? it.x - seg.x1 : Infinity;
      if (!seg || gap > Math.max(it.size, seg.size) * SEGMENT_GAP) {
        seg = { rowId, y: it.y, baseSize: it.size, x0: it.x, x1: it.x + it.w, size: it.size, items: [] };
        segments.push(seg);
      }
      seg.items.push(it);
      seg.x1 = Math.max(seg.x1, it.x + it.w);
      seg.size = Math.max(seg.size, it.size);
      // Ligne de base propre à chaque bloc : celle de son texte le plus grand
      // (un bloc d'une autre colonne peut partager la même rangée).
      if (it.size > seg.baseSize) { seg.baseSize = it.size; seg.y = it.y; }
    }
  });
  return segments;
}

// Cherche une gouttière verticale (mise en page sur deux colonnes) : une position
// que presque aucune ligne ne traverse, avec de chaque côté au moins trois lignes
// alignées sur un même bord gauche et assez larges pour être du texte courant.
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

/* ---------------------------------------------------------------- Lignes */

function mergeIntoLines(segments) {
  const lines = [];
  for (const seg of segments) {
    const last = lines[lines.length - 1];
    if (!seg.placeholder && last && !last.placeholder && last.rowId === seg.rowId && last.col === seg.col) {
      last.items.push({ gapBefore: true }, ...seg.items);
      last.segs.push(seg);
      last.x1 = seg.x1;
    } else {
      lines.push({
        rowId: seg.rowId, col: seg.col, y: seg.y, baseSize: seg.baseSize, x0: seg.x0, x1: seg.x1,
        items: [...seg.items], segs: [seg], placeholder: seg.placeholder || null,
      });
    }
  }
  return lines.map(finishLine);
}

function finishLine(line) {
  if (line.placeholder) {
    return {
      placeholder: line.placeholder, col: line.col, y: line.y, x0: line.x0, x1: line.x1,
      runs: [], plain: "", size: 0, segs: [], tabular: false, chars: 0,
    };
  }

  const sizes = new Map();
  let chars = 0, boldChars = 0, monoChars = 0, mathFontChars = 0, mathChars = 0, strongMath = 0, artifactChars = 0;
  const roleChars = new Map();
  for (const it of line.items) {
    if (it.gapBefore) continue;
    const n = it.str.replace(/\s/g, "").length;
    chars += n;
    if (it.bold) boldChars += n;
    if (it.mono) monoChars += n;
    if (it.artifact) artifactChars += n;
    if (it.math) mathFontChars += n;
    for (const ch of it.str) {
      if (it.math || MATH_SYMBOL.test(ch)) mathChars++;
      if (STRONG_MATH.test(ch)) strongMath++;
    }
    if (it.role) roleChars.set(it.role, (roleChars.get(it.role) || 0) + n);
    const s = round(it.size);
    sizes.set(s, (sizes.get(s) || 0) + n);
  }
  const size = [...sizes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] || 10;
  const base = line.baseSize || size;

  // Passages de texte (gras, italique, code, lien, exposant / indice).
  const runs = [];
  let prev = null;
  for (const it of line.items) {
    if (it.gapBefore) { prev = null; pushText(runs, " ", null); continue; }
    if (prev) {
      const gap = it.x - (prev.x + prev.w);
      if (gap > it.size * 0.12 && !/\s$/.test(prev.str) && !/^\s/.test(it.str)) pushText(runs, " ", null);
    }
    let script = null;
    if (it.size < base * 0.85) {
      const dy = it.y - line.y;
      if (dy > base * 0.2) script = "sup";
      else if (dy < -base * 0.12) script = "sub";
    }
    pushText(runs, it.str, it, script);
    prev = it;
  }
  if (runs.length) runs[0].text = runs[0].text.replace(/^\s+/, "");
  if (runs.length) runs[runs.length - 1].text = runs[runs.length - 1].text.replace(/\s+$/, "");

  const plain = runs.map((r) => (r.script ? scriptText(r.text, r.script, true) : r.text)).join("").replace(/\s+/g, " ");
  const role = [...roleChars.entries()].sort((a, b) => b[1] - a[1])[0];
  const mono = chars > 0 && monoChars / chars > 0.9;

  return {
    col: line.col, y: line.y, x0: line.x0, x1: line.x1,
    runs, plain, size, chars,
    bold: chars > 0 && boldChars / chars > 0.9,
    mono,
    codeText: mono ? codeText(line.items, size) : "",
    math: { ratio: chars ? mathChars / chars : 0, font: mathFontChars, strong: strongMath },
    role: role && role[1] / Math.max(chars, 1) >= 0.5 ? role[0] : null,
    artifact: chars > 0 && artifactChars === chars,
    segs: line.segs.map((s) => ({ x0: s.x0, x1: s.x1, text: itemsText(s.items) })),
    tabular: line.segs.length > 1 && !mono,   // plusieurs blocs espacés : tableau, libellé / valeur
  };
}

// Regroupe les passages de même style. Un espace ajouté (item = null) prend le style précédent.
function pushText(runs, text, item, script = null) {
  const last = runs[runs.length - 1];
  const style = item
    ? { bold: item.bold, italic: item.italic, mono: item.mono, link: item.link, script }
    : { bold: last?.bold ?? false, italic: last?.italic ?? false, mono: last?.mono ?? false, link: last?.link ?? null, script: last?.script ?? null };
  if (last && last.bold === style.bold && last.italic === style.italic && last.mono === style.mono &&
      last.link === style.link && last.script === style.script) {
    last.text += text;
  } else {
    runs.push({ text, ...style });
  }
}

// Texte d'une ligne de code : les espaces sont déduits de la largeur moyenne d'un caractère.
function codeText(items, size) {
  const charWidth = size * 0.6;
  let s = "";
  let prev = null;
  for (const it of items) {
    if (it.gapBefore) continue;
    if (prev) {
      const gap = it.x - (prev.x + prev.w);
      const spaces = Math.max(0, Math.round(gap / charWidth));
      if (spaces && !/\s$/.test(s)) s += " ".repeat(spaces);
    }
    s += it.str;
    prev = it;
  }
  return s.replace(/\s+$/, "");
}

/* ----------------------------------------------------- Exposants, indices */

const SUP = { "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹", "+": "⁺", "-": "⁻", "−": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", "n": "ⁿ", "i": "ⁱ" };
const SUB = { "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉", "+": "₊", "-": "₋", "−": "₋", "=": "₌", "(": "₍", ")": "₎" };

/**
 * Texte en exposant ou en indice : caractères Unicode quand ils existent (m², H₂O),
 * sinon balises <sup> / <sub> (ou texte brut si `plainOnly`).
 */
export function scriptText(text, script, plainOnly = false) {
  const map = script === "sup" ? SUP : SUB;
  const t = text.trim();
  if (t && [...t].every((c) => map[c])) return [...t].map((c) => map[c]).join("");
  if (plainOnly) return text;
  return `<${script}>${t}</${script}>`;
}

/* -------------------------------------------------------------- Équations */

function isMathLine(l) {
  if (l.placeholder || l.mono || !l.chars || /^H\d?$|^Title$/.test(l.role || "")) return false;
  if (l.role === "Formula") return true;
  return l.math.ratio >= 0.3 && (l.math.font > 0 || l.math.strong > 0) && l.chars <= 120;
}

/**
 * Repère les équations isolées (lignes majoritairement mathématiques, consécutives)
 * et les remplace par une zone « figure ». Renvoie les figures créées.
 */
export function extractEquations(lines, makeFigure) {
  const figures = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isMathLine(lines[i])) continue;
    // Une équation s'étend sur plusieurs lignes (fraction, bornes d'une somme) : on y rattache
    // les lignes proches, mathématiques ou très courtes (« 2 », « k = 1 »).
    const close = (a, b) => a.col === b.col && a.y - b.y <= Math.max(a.size, b.size) * 2.5;
    const fragment = (l) => !l.placeholder && !l.mono && l.chars > 0 && l.chars <= 6 && !/\p{L}{3,}/u.test(l.plain);
    let j = i + 1;
    while (j < lines.length && close(lines[j - 1], lines[j]) && (isMathLine(lines[j]) || fragment(lines[j]))) j++;
    while (j - 1 > i && !isMathLine(lines[j - 1])) j--;   // pas de fragment isolé en fin d'équation
    const group = lines.slice(i, j);
    const top = Math.max(...group.map((l) => l.y + l.size * 0.75));
    const bottom = Math.min(...group.map((l) => l.y - l.size * 0.3));
    const bbox = [Math.min(...group.map((l) => l.x0)), bottom, Math.max(...group.map((l) => l.x1)), top];
    const figure = makeFigure("equation", bbox, { lines: group.map((l) => l.plain.trim()), padding: 2 });
    // Sur plusieurs lignes (fraction, somme), le texte extrait est dans le désordre : texte alternatif sobre.
    figure.alt = group.length === 1 ? `Équation : ${group[0].plain.trim()}` : "Équation";
    figures.push(figure);
    lines.splice(i, j - i, {
      placeholder: { bbox, figure }, col: group[0].col, y: group[0].y, x0: bbox[0], x1: bbox[2],
      runs: [], plain: "", size: 0, segs: [], tabular: false, chars: 0,
    });
  }
  return figures;
}
