// Point d'entrée de la conversion.
// Pour ajouter un format : créer js/converters/<format>.js sur le même modèle,
// puis l'ajouter au tableau CONVERTERS ci-dessous. L'interface s'adapte seule.
//
// Un convertisseur exporte par défaut un objet :
//   { id, label, kind, icon, extensions: [...], async convert(file, { onProgress }) -> string }

import pdf from "./converters/pdf.js";
import docx from "./converters/docx.js";
import xlsx from "./converters/xlsx.js";

export const CONVERTERS = [pdf, docx, xlsx];

const byExtension = new Map();
for (const c of CONVERTERS) for (const ext of c.extensions) byExtension.set(ext, c);

/** Extension d'un nom de fichier, en minuscules. */
export const extOf = (name) => (name.includes(".") ? name.split(".").pop().toLowerCase() : "");

/** Valeur pour l'attribut `accept` du champ fichier. */
export const ACCEPT = [...byExtension.keys()].map((e) => "." + e).join(",");

/** Convertisseur correspondant au fichier, ou null. */
export const getConverter = (name) => byExtension.get(extOf(name)) || null;

/**
 * Convertit un fichier (File ou objet { name, arrayBuffer() }) en Markdown.
 * @param {File} file
 * @param {{ onProgress?: (done: number, total: number) => void }} [options]
 * @returns {Promise<string>}
 */
export async function convertToMd(file, options = {}) {
  const converter = getConverter(file.name);
  if (!converter) throw new Error(`Format non pris en charge : .${extOf(file.name)}`);
  return converter.convert(file, options);
}
