// Lecture des fragments de texte d'une page : position, taille, style, lien et rôle taggé.

import { clamp } from "./geometry.js";
import { mcidOf } from "./structure.js";

const MONO_FONT = /courier|mono|consol|menlo|inconsolata|cmtt|typewriter|fixedsys|lucida ?console|source ?code|fira ?code|jetbrains/i;
const MATH_FONT = /cmmi|cmsy|cmex|cmbsy|msam|msbm|eufm|eusm|rsfs|esint|math|stix|xits|euclid|mtsy|mtex|mt ?extra/i;
const BOLD_FONT = /bold|black|heavy|semibold|demibold/i;
const ITALIC_FONT = /italic|oblique/i;

const LIGATURES = { "ﬀ": "ff", "ﬁ": "fi", "ﬂ": "fl", "ﬃ": "ffi", "ﬄ": "ffl", "ﬅ": "st", "ﬆ": "st" };

/** Nettoie le texte extrait : ligatures, espaces spéciaux, caractères invisibles. */
export function cleanText(s) {
  return s
    .replace(/[ﬀﬁﬂﬃﬄﬅﬆ]/g, (c) => LIGATURES[c])
    // Symboles des polices Symbol, Wingdings, OpenSymbol… (zone Unicode privée) : en pratique des puces.
    .replace(/[-]/g, "•")
    .replace(/[  -   　]/g, " ")
    .replace(/[­​-‍⁠﻿]/g, "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
}

/** Texte brut d'une suite de fragments, avec les espaces déduits des écarts. */
export function itemsText(items) {
  let s = "";
  let prev = null;
  for (const it of items) {
    if (prev) {
      const sameRow = Math.abs(prev.y - it.y) < it.size * 0.6;
      const gap = it.x - (prev.x + prev.w);
      if ((!sameRow || gap > it.size * 0.12) && !/\s$/.test(s) && !/^\s/.test(it.str)) s += " ";
    }
    s += it.str;
    prev = it;
  }
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Lit les fragments de texte de la page (à appeler après page.getOperatorList(),
 * qui charge les polices et donne accès à leur nom réel).
 */
export async function readTextItems(page, { structure, links }) {
  const content = await page.getTextContent({ includeMarkedContent: true });

  const styleCache = new Map();
  const styleOf = (fontName) => {
    if (styleCache.has(fontName)) return styleCache.get(fontName);
    let name = "", bold = false, italic = false;
    try {
      if (page.commonObjs.has(fontName)) {
        const font = page.commonObjs.get(fontName);
        name = font?.name || "";
        bold = !!(font?.bold || font?.black);
        italic = !!font?.italic;
      }
    } catch { /* police non disponible */ }
    const label = name + " " + (content.styles?.[fontName]?.fontFamily || "");
    const style = {
      bold: bold || BOLD_FONT.test(label),
      italic: italic || ITALIC_FONT.test(label),
      mono: MONO_FONT.test(name),
      math: !/opensymbol/i.test(name) && MATH_FONT.test(name),
    };
    styleCache.set(fontName, style);
    return style;
  };

  // Pile des contenus marqués : identifiant de structure et zones « Artifact ».
  const stack = [];
  const seen = new Set();
  const items = [];
  for (const it of content.items) {
    if (it.type === "beginMarkedContent" || it.type === "beginMarkedContentProps") {
      stack.push({ tag: it.tag, mcid: it.id ? mcidOf(it.id) : null });
      continue;
    }
    if (it.type === "endMarkedContent") { stack.pop(); continue; }
    if (typeof it.str !== "string") continue;

    const str = cleanText(it.str);
    if (!str.trim()) continue;
    const [a, b, c, d, x, y] = it.transform;
    const size = Math.hypot(c, d) || Math.hypot(a, b) || it.height || 10;
    const key = `${str}|${Math.round(x)}|${Math.round(y)}`;
    if (seen.has(key)) continue;   // texte dessiné deux fois pour simuler le gras
    seen.add(key);

    let mcid = null;
    for (let k = stack.length - 1; k >= 0 && mcid === null; k--) mcid = stack[k].mcid;
    const artifact = stack.some((m) => m.tag === "Artifact");
    const item = {
      str, x, y, w: it.width || 0, size, link: null,
      mcid, role: structure?.roleOf(mcid) ?? null, artifact,
      ...styleOf(it.fontName),
    };
    for (const piece of splitByLinks(item, links)) if (piece.str) items.push(piece);
  }
  return items;
}

/* ------------------------------------------------------------------ Liens */

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
export function snapToWord(str, index, side) {
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
