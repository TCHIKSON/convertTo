// Tests de non-régression : convertit chaque fichier de tests/fixtures et compare
// le résultat avec tests/expected/<fichier>.md.
//
//   npm test                 lance les tests
//   npm test -- --update     enregistre les résultats actuels comme référence
//
// Les tests tournent dans Node, sans navigateur : les images, diagrammes et équations
// n'y sont pas découpés (le Markdown contient alors leur texte de remplacement),
// et l'OCR n'est pas testé.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixtures = path.join(root, "tests", "fixtures");
const expectedDir = path.join(root, "tests", "expected");
const update = process.argv.includes("--update");

// Bibliothèques normalement chargées par index.html, exposées en globales.
const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");
pdfjs.GlobalWorkerOptions.workerSrc = require.resolve("pdfjs-dist/legacy/build/pdf.worker.js");
globalThis.pdfjsLib = pdfjs;
globalThis.PDFJS_ASSETS = path.dirname(require.resolve("pdfjs-dist/package.json")) + "/";
globalThis.XLSX = require("xlsx");
globalThis.TurndownService = require("turndown");
const mammoth = require("mammoth");
globalThis.mammoth = {   // la version Node de mammoth attend un Buffer
  images: mammoth.images,
  convertToHtml: (input, options) => mammoth.convertToHtml({ buffer: Buffer.from(input.arrayBuffer) }, options),
};

// Masque les avertissements de pdf.js (polices, etc.) pour garder une sortie lisible.
const warn = console.warn;
console.warn = (...args) => { if (!String(args[0]).startsWith("Warning:")) warn(...args); };
console.log = ((log) => (...args) => { if (!String(args[0]).startsWith("Warning:")) log(...args); })(console.log);

const { convertToMd } = await import(path.join(root, "js", "convert.js"));

const loadFile = (name) => {
  const buffer = fs.readFileSync(path.join(fixtures, name));
  return { name, size: buffer.length, arrayBuffer: async () => buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.length) };
};

// Le mot de passe du fichier de test est indiqué dans son nom : « …-mdp-secret.pdf ».
const requestPassword = async (fileName) => /-mdp-([^.]+)\./.exec(fileName)?.[1] ?? null;

fs.mkdirSync(expectedDir, { recursive: true });
let failed = 0;
for (const name of fs.readdirSync(fixtures).sort()) {
  const expectedPath = path.join(expectedDir, name + ".md");
  let actual;
  try {
    actual = (await convertToMd(loadFile(name), { requestPassword })).markdown;
  } catch (e) {
    actual = `ERREUR : ${e.message}\n`;
  }
  if (update || !fs.existsSync(expectedPath)) {
    fs.writeFileSync(expectedPath, actual);
    console.log(`  enregistré  ${name}`);
    continue;
  }
  const expected = fs.readFileSync(expectedPath, "utf8");
  if (actual === expected) {
    console.log(`  ok          ${name}`);
  } else {
    failed++;
    console.log(`  DIFFÉRENT   ${name}`);
    const a = actual.split("\n"), b = expected.split("\n");
    const line = a.findIndex((l, i) => l !== b[i]);
    console.log(`              ligne ${line + 1}\n              attendu : ${b[line] ?? "(fin)"}\n              obtenu  : ${a[line] ?? "(fin)"}`);
  }
}
console.log(failed ? `\n${failed} test(s) en échec.` : "\nTous les tests passent.");
process.exit(failed ? 1 : 0);
