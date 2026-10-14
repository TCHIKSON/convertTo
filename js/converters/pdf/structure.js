// Informations de structure du PDF : métadonnées, signets et structure taggée.

/* ------------------------------------------------------------ Métadonnées */

const IGNORED_VALUES = /^(anonymous|unknown|unspecified|untitled|sans titre|none|null)$/i;

// Date PDF « D:20260114093000+01'00' » → « 2026-01-14 ».
function pdfDate(value) {
  const m = /^D?:?(\d{4})(\d{2})?(\d{2})?/.exec(String(value || ""));
  if (!m) return null;
  return [m[1], m[2] || "01", m[3] || "01"].join("-");
}

/** Métadonnées utiles du document, prêtes pour l'en-tête YAML. */
export async function readDocumentInfo(doc) {
  try {
    const { info = {}, metadata } = await doc.getMetadata();
    const pick = (key, xmpKey) => {
      let v = info[key];
      if ((!v || typeof v !== "string") && metadata && xmpKey) v = metadata.get(xmpKey);
      v = typeof v === "string" ? v.trim() : "";
      return v && !IGNORED_VALUES.test(v) ? v : null;
    };
    return {
      title: pick("Title", "dc:title"),
      author: pick("Author", "dc:creator"),
      subject: pick("Subject", "dc:description"),
      keywords: pick("Keywords", "pdf:keywords"),
      created: pdfDate(info.CreationDate),
      modified: pdfDate(info.ModDate),
      language: pick("Language"),
      pages: doc.numPages,
    };
  } catch {
    return { pages: doc.numPages };
  }
}

/** En-tête YAML (front matter) à partir des métadonnées. */
export function frontMatter(info) {
  if (!info) return "";
  const quote = (s) => `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const lines = [];
  for (const [key, label] of [
    ["title", "title"], ["author", "author"], ["subject", "subject"], ["keywords", "keywords"],
    ["created", "created"], ["modified", "modified"], ["language", "lang"], ["pages", "pages"],
  ]) {
    const v = info[key];
    if (v === null || v === undefined || v === "") continue;
    lines.push(`${label}: ${typeof v === "number" ? v : quote(v)}`);
  }
  return lines.length ? `---\n${lines.join("\n")}\n---\n\n` : "";
}

/* ---------------------------------------------------------------- Signets */

/**
 * Signets du document, aplatis : [{ title, level, page }] (page numérotée à partir de 1, ou null).
 */
export async function readOutline(doc) {
  let outline;
  try { outline = await doc.getOutline(); } catch { return []; }
  if (!outline?.length) return [];

  const result = [];
  const walk = async (nodes, level) => {
    for (const node of nodes) {
      const title = (node.title || "").replace(/\s+/g, " ").trim();
      if (title) result.push({ title, level, page: await destinationPage(doc, node.dest) });
      if (node.items?.length) await walk(node.items, level + 1);
    }
  };
  await walk(outline, 1);
  return result;
}

async function destinationPage(doc, dest) {
  try {
    if (typeof dest === "string") dest = await doc.getDestination(dest);
    if (!Array.isArray(dest)) return null;
    const ref = dest[0];
    if (typeof ref === "number") return ref + 1;
    return (await doc.getPageIndex(ref)) + 1;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------- Structure taggée */

// Rôles utiles à la conversion, du plus précis au plus général.
const USEFUL_ROLES = new Set([
  "H1", "H2", "H3", "H4", "H5", "H6", "H", "Title",
  "Code", "Formula", "Figure", "Caption", "BlockQuote", "Quote", "Note",
  "Lbl", "LBody", "LI", "TH", "TD", "P",
]);

/** Numéro de contenu marqué (MCID) à partir d'un identifiant pdf.js « p12R_mc5 ». */
export const mcidOf = (id) => {
  const m = /mc(\d+)$/.exec(String(id ?? ""));
  return m ? Number(m[1]) : null;
};

/**
 * Lit la structure taggée d'une page.
 * Renvoie null si la page n'est pas taggée, sinon :
 *   roleOf(mcid)   rôle utile le plus précis du contenu (H1, Code, LI…)
 *   tables         [{ rows: [[Set(mcid), …], …] }]  tableaux taggés
 *   figureAlt      Map(mcid → texte alternatif) des figures
 */
export async function readStructure(page) {
  let tree;
  try { tree = await page.getStructTree(); } catch { return null; }
  if (!tree) return null;

  const roles = new Map();
  const figureAlt = new Map();
  const tables = [];
  let contentCount = 0;

  const leafIds = (node, out = new Set()) => {
    for (const child of node.children || []) {
      if (child.type === "content") {
        const id = mcidOf(child.id);
        if (id !== null) out.add(id);
      } else {
        leafIds(child, out);
      }
    }
    return out;
  };

  const collectRows = (node, rows) => {
    for (const child of node.children || []) {
      if (child.type === "content") continue;
      if (child.role === "TR") {
        const cells = (child.children || []).filter((c) => c.role === "TH" || c.role === "TD");
        rows.push(cells.map((c) => leafIds(c)));
      } else if (child.role !== "Table") {
        collectRows(child, rows);   // THead, TBody, TFoot…
      }
    }
    return rows;
  };

  const walk = (node, inherited) => {
    // Un paragraphe (P) à l'intérieur d'une liste, d'une cellule ou d'une citation garde le rôle parent.
    const role = USEFUL_ROLES.has(node.role) && !(node.role === "P" && inherited) ? node.role : inherited;
    if (node.role === "Figure" && node.alt) for (const id of leafIds(node)) figureAlt.set(id, node.alt);
    if (node.role === "Table") {
      const rows = collectRows(node, []);
      if (rows.length) tables.push({ rows });
    }
    for (const child of node.children || []) {
      if (child.type === "content") {
        const id = mcidOf(child.id);
        if (id !== null) { roles.set(id, role); contentCount++; }
      } else {
        walk(child, role);
      }
    }
  };
  walk(tree, null);

  if (!contentCount) return null;
  return { roleOf: (mcid) => (mcid === null ? null : roles.get(mcid) ?? null), tables, figureAlt };
}
