// Annotations d'une page : liens, champs de formulaire et commentaires.

import { boundsOf, clamp, itemCenter } from "./geometry.js";
import { tableToMd } from "../../utils/markdown.js";

const NOTE_LABELS = {
  Text: "Commentaire",
  FreeText: "Texte libre",
  Highlight: "Surlignage",
  Underline: "Soulignement",
  Squiggly: "Soulignement ondulé",
  StrikeOut: "Texte barré",
  Caret: "Insertion",
  Stamp: "Tampon",
  Ink: "Dessin à main levée",
  Square: "Rectangle",
  Circle: "Cercle",
  Line: "Ligne",
  Polygon: "Polygone",
  PolyLine: "Ligne brisée",
  FileAttachment: "Pièce jointe",
};
const TEXT_MARKUP = new Set(["Highlight", "Underline", "Squiggly", "StrikeOut"]);

const normalizeRect = ([x1, y1, x2, y2]) => [Math.min(x1, x2), Math.min(y1, y2), Math.max(x1, x2), Math.max(y1, y2)];

// Zones couvertes par une annotation de balisage (surlignage…), selon le format de pdf.js.
function markupAreas(a) {
  const q = a.quadPoints;
  if (Array.isArray(q) && q.length && Array.isArray(q[0])) {
    return q.map((quad) => boundsOf(quad.map((p) => [p.x, p.y])));
  }
  if (q && q.length >= 8 && typeof q[0] === "number") {
    const areas = [];
    for (let i = 0; i + 7 < q.length; i += 8) {
      areas.push(boundsOf([[q[i], q[i + 1]], [q[i + 2], q[i + 3]], [q[i + 4], q[i + 5]], [q[i + 6], q[i + 7]]]));
    }
    return areas;
  }
  return a.rect ? [normalizeRect(a.rect)] : [];
}

function fieldValue(a) {
  if (a.fieldType === "Btn") {
    if (a.checkBox) return a.fieldValue && a.fieldValue !== "Off" ? "Coché" : "Non coché";
    if (a.radioButton) return a.fieldValue === a.buttonValue ? String(a.buttonValue) : null;
    return null;
  }
  if (a.fieldType === "Ch") {
    const values = Array.isArray(a.fieldValue) ? a.fieldValue : [a.fieldValue];
    const labels = values.filter(Boolean).map((v) => a.options?.find((o) => o.exportValue === v)?.displayValue ?? v);
    return labels.join(", ");
  }
  if (a.fieldType === "Sig") return a.fieldValue ? "Signé" : "Non signé";
  return a.fieldValue == null ? "" : String(a.fieldValue);
}

/**
 * Lit les annotations d'une page.
 * @returns {{ links: object[], fields: object[], notes: object[] }}
 */
export async function readAnnotations(page, pageNumber) {
  let annotations = [];
  try { annotations = await page.getAnnotations(); } catch { /* aucune annotation lisible */ }

  const links = [];
  const fields = [];
  const notes = [];

  for (const a of annotations) {
    if (a.subtype === "Link") {
      if (a.url && a.rect) {
        const [x0, y0, x1, y1] = normalizeRect(a.rect);
        links.push({ url: a.url, x0, y0, x1, y1 });
      }
    } else if (a.subtype === "Widget") {
      if (a.pushButton || a.hidden) continue;
      const value = fieldValue(a);
      if (value === null) continue;   // bouton radio non sélectionné
      fields.push({
        page: pageNumber,
        name: a.fieldName || "",
        label: (a.alternativeText || a.fieldName || "Champ").trim(),
        value,
        radio: !!a.radioButton,
      });
    } else if (NOTE_LABELS[a.subtype]) {
      const contents = (a.contentsObj?.str ?? a.contents ?? "").trim();
      const isMarkup = TEXT_MARKUP.has(a.subtype);
      if (!contents && !isMarkup && a.subtype !== "FileAttachment") continue;
      notes.push({
        page: pageNumber,
        type: NOTE_LABELS[a.subtype],
        author: (a.titleObj?.str ?? a.title ?? "").trim(),
        contents,
        reply: !!a.inReplyTo,
        areas: isMarkup ? markupAreas(a) : [],
        file: a.subtype === "FileAttachment" ? a.file?.filename || "" : "",
        quoted: "",
      });
    }
  }
  return { links, fields, notes };
}

/**
 * Texte situé sous une annotation de balisage (surlignage, soulignement…).
 * Un fragment n'est souvent que partiellement couvert : on n'en garde que la partie
 * sous la zone, calée sur les limites de mots.
 */
export function textUnder(areas, items, itemsText, snapToWord) {
  if (!areas.length) return "";
  const pieces = [];
  for (const area of areas) {
    for (const it of items) {
      const [, cy] = itemCenter(it);
      if (cy < area[1] - 2 || cy > area[3] + 2 || !it.w) continue;
      const n = it.str.length;
      const charWidth = it.w / n;
      const start = snapToWord(it.str, clamp(Math.round((area[0] - it.x) / charWidth), 0, n), "start");
      const end = snapToWord(it.str, clamp(Math.round((area[2] - it.x) / charWidth), 0, n), "end");
      if (end > start) pieces.push({ ...it, str: it.str.slice(start, end), x: it.x + start * charWidth, w: (end - start) * charWidth });
    }
  }
  return itemsText(pieces.sort((p, q) => q.y - p.y || p.x - q.x));
}

/* --------------------------------------------------------- Markdown */

/** Section « Formulaire » : tableau des champs et de leurs valeurs. */
export function formsToMd(fields) {
  if (!fields.length) return "";
  // Un groupe de boutons radio n'apparaît qu'une fois (valeur sélectionnée).
  const seen = new Set();
  const rows = [["Champ", "Valeur", "Page"]];
  for (const f of fields) {
    const key = f.radio ? "radio:" + f.name : null;
    if (key && seen.has(key)) continue;
    if (key) seen.add(key);
    rows.push([f.label, f.value || "—", String(f.page)]);
  }
  return "## Formulaire\n\n" + tableToMd(rows);
}

/** Section « Annotations » : une entrée par commentaire, avec page et auteur. */
export function annotationsToMd(notes) {
  if (!notes.length) return "";
  const lines = notes.map((n) => {
    const meta = [`page ${n.page}`, n.author].filter(Boolean).join(", ");
    let text = `- **${n.reply ? "Réponse" : n.type}** (${meta})`;
    const parts = [];
    if (n.quoted) parts.push(`« ${n.quoted} »`);
    if (n.file) parts.push(`fichier ${n.file}`);
    if (n.contents) parts.push(n.contents.replace(/\s*\n\s*/g, " "));
    if (parts.length) text += " : " + parts.join(" — ");
    return text;
  });
  return "## Annotations\n\n" + lines.join("\n");
}
