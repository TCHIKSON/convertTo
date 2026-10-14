// Convertisseur PDF → Markdown, basé sur pdf.js (globale `pdfjsLib` chargée dans index.html).
//
// Organisation du dossier :
//   index.js        ouverture du fichier, boucle sur les pages, rendu des figures, OCR
//   structure.js    métadonnées, signets, structure taggée
//   annotations.js  liens, champs de formulaire, commentaires
//   text.js         fragments de texte : style, liens, rôle taggé
//   graphics.js     dessins : traits de tableau, formes, images
//   page.js         zones d'une page : tableaux, diagrammes, images, puis lignes
//   lines.js        lignes, colonnes, exposants, équations
//   layout.js       titres, listes, code, paragraphes → Markdown final
//   render.js       rendu des pages en image (navigateur)
//
// Options de convert() :
//   onProgress(done, total, label)    progression
//   images: boolean                   extraire images, diagrammes et équations (défaut : oui)
//   metadata: boolean                 en-tête YAML avec les métadonnées (défaut : oui)
//   ocr: boolean                      OCR des pages scannées et des images (défaut : non)
//   requestPassword(fileName, retry)  renvoie le mot de passe saisi, ou null pour annuler
//
// Résultat : { markdown, assets: [{ path, blob }] } — les images sont référencées
// dans le Markdown par leur chemin (images/<document>/…).

import { readDocumentInfo, readOutline, readStructure } from "./structure.js";
import { readAnnotations, textUnder } from "./annotations.js";
import { readTextItems, itemsText, snapToWord } from "./text.js";
import { readGraphics } from "./graphics.js";
import { buildPage } from "./page.js";
import { buildMarkdown, joinText } from "./layout.js";
import { canRender, renderPage, cropRegion, canvasToBlob, releaseCanvas } from "./render.js";
import { createOcr } from "../../utils/ocr.js";
import { baseName } from "../../utils/markdown.js";

const PDF_WORKER = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
// Données complémentaires de pdf.js : tables de caractères (textes chinois, japonais, coréen…)
// et polices standard (rendu fidèle des PDF qui n'embarquent pas Helvetica, Times…).
// Peut être redéfini avant le chargement (globalThis.PDFJS_ASSETS), par exemple pour un usage hors ligne.
const PDF_ASSETS = globalThis.PDFJS_ASSETS ?? "https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/";

export default {
  id: "pdf",
  label: "PDF",
  kind: "pdf",
  icon: "pi-file-pdf",
  extensions: ["pdf"],

  async convert(file, { onProgress, ocr = false, images = true, metadata = true, requestPassword } = {}) {
    const lib = globalThis.pdfjsLib;
    if (!lib.GlobalWorkerOptions.workerSrc) lib.GlobalWorkerOptions.workerSrc = PDF_WORKER;

    const doc = await openDocument(lib, file, requestPassword);
    const browser = canRender();
    const ctx = { info: null, outline: [], fields: [], notes: [], ocr: ocr && browser };
    const renderFigures = images && browser;
    const slug = slugify(baseName(file.name));
    const assets = [];
    const pages = [];
    let ocrEngine = null;
    const getOcr = async () => (ocrEngine ??= await createOcr());

    try {
      if (metadata) ctx.info = await readDocumentInfo(doc);
      ctx.outline = await readOutline(doc);
      const total = doc.numPages;

      for (let n = 1; n <= total; n++) {
        onProgress?.(n, total, "Page");
        const page = await doc.getPage(n);
        const opList = await page.getOperatorList();          // charge aussi les polices
        const structure = await readStructure(page);
        const annotations = await readAnnotations(page, n);
        const items = await readTextItems(page, { structure, links: annotations.links });
        const graphics = readGraphics(lib.OPS, opList, page.view);
        const result = buildPage({ number: n, view: page.view, items, graphics, structure, slug });

        for (const note of annotations.notes) note.quoted = textUnder(note.areas, items, itemsText, snapToWord);
        ctx.fields.push(...annotations.fields);
        ctx.notes.push(...annotations.notes);

        // Rendu de la page : figures à découper, ou page scannée à lire par OCR.
        const scanned = result.empty && ctx.ocr;
        const toRender = renderFigures ? result.figures.filter((f) => !(scanned && f.fullPage)) : [];
        if (scanned || toRender.length) {
          const rendered = await renderPage(page);
          if (scanned) {
            onProgress?.(n, total, "OCR page");
            result.ocrBlocks = textToParagraphs(await (await getOcr()).recognize(rendered.canvas));
          }
          for (const fig of toRender) {
            const crop = cropRegion(rendered, fig.bbox, fig.padding ?? 4);
            assets.push({ path: fig.path, blob: await canvasToBlob(crop) });
            fig.rendered = true;
            if (ctx.ocr && fig.kind === "image" && !fig.fullPage) {
              onProgress?.(n, total, "OCR image, page");
              fig.ocrText = meaningfulText(await (await getOcr()).recognize(crop));
            }
            releaseCanvas(crop);
          }
          releaseCanvas(rendered.canvas);
        }

        pages.push(result);
        page.cleanup();
      }
    } finally {
      await ocrEngine?.terminate();
      doc.destroy();
    }

    return { markdown: buildMarkdown(pages, ctx), assets };
  },
};

/* ------------------------------------------------------- Ouverture du fichier */

// Ouvre le document et demande le mot de passe s'il est protégé.
async function openDocument(lib, file, requestPassword) {
  const data = new Uint8Array(await file.arrayBuffer());
  const task = lib.getDocument({
    data,
    cMapUrl: PDF_ASSETS + "cmaps/",
    cMapPacked: true,
    standardFontDataUrl: PDF_ASSETS + "standard_fonts/",
  });
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

/* -------------------------------------------------------------------- OCR */

// Texte brut de l'OCR → paragraphes (lignes recollées, césures retirées).
function textToParagraphs(text) {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.split("\n").map((s) => s.trim()).filter(Boolean).reduce((a, b) => (a ? joinText(a, b) : b), ""))
    .filter(Boolean)
    .map((p) => p.replace(/\*/g, "\\*"));
}

// Garde le texte reconnu dans une image seulement s'il contient au moins trois vrais mots.
function meaningfulText(text) {
  const clean = text.replace(/\s+/g, " ").trim();
  const words = clean.split(" ").filter((w) => /\p{L}{2,}/u.test(w));
  return words.length >= 3 ? clean.replace(/\*/g, "\\*") : "";
}

const slugify = (s) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "document";
