// Fonctions Markdown communes à tous les convertisseurs.

/** Nom de fichier sans extension. */
export const baseName = (name) => name.replace(/\.[^.]+$/, "");

/** Nettoie une valeur pour une cellule de tableau Markdown. */
export const escapeCell = (value) =>
  String(value ?? "").replace(/\s+/g, " ").trim().replace(/\|/g, "\\|");

/**
 * Transforme une liste de lignes en tableau Markdown.
 * La première ligne non vide sert d'en-tête ; les colonnes vides sont retirées.
 */
export function tableToMd(rows) {
  rows = rows.map((r) => r.map(escapeCell)).filter((r) => r.some(Boolean));
  if (!rows.length) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const keep = [...Array(width).keys()].filter((j) => rows.some((r) => r[j]));
  rows = rows.map((r) => keep.map((j) => r[j] || ""));
  const [head, ...body] = rows;
  return [
    "| " + head.join(" | ") + " |",
    "| " + head.map(() => "---").join(" | ") + " |",
    ...body.map((r) => "| " + r.join(" | ") + " |"),
  ].join("\n");
}

/** Normalise les espaces et les lignes vides d'un document Markdown. */
export const tidy = (md) =>
  md.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
