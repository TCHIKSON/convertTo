// Convertisseur Word (.docx) : mammoth (docx → HTML) puis Turndown (HTML → Markdown).
// Dépend des globales `mammoth` et `TurndownService` chargées dans index.html.

import { tableToMd, tidy } from "../utils/markdown.js";

let turndown = null;

function getTurndown() {
  if (turndown) return turndown;
  turndown = new globalThis.TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
    bulletListMarker: "-",
    emDelimiter: "*",
  });

  // Tableaux : la première ligne devient l'en-tête Markdown.
  turndown.addRule("table", {
    filter: "table",
    replacement: (_content, node) => {
      const ownerTable = (el) => {
        while (el && el.nodeName !== "TABLE") el = el.parentNode;
        return el;
      };
      const rows = Array.from(node.querySelectorAll("tr"))
        .filter((tr) => ownerTable(tr) === node)
        .map((tr) =>
          Array.from(tr.childNodes)
            .filter((c) => c.nodeName === "TD" || c.nodeName === "TH")
            .map((td) => td.textContent)
        );
      return "\n\n" + tableToMd(rows) + "\n\n";
    },
  });

  // Les images sont ignorées (voir convertImage plus bas).
  turndown.addRule("emptyImg", {
    filter: (n) => n.nodeName === "IMG" && !n.getAttribute("src"),
    replacement: () => "",
  });
  return turndown;
}

export default {
  id: "docx",
  label: "DOCX",
  kind: "word",
  icon: "pi-file-word",
  extensions: ["docx"],

  async convert(file) {
    const { mammoth } = globalThis;
    const arrayBuffer = await file.arrayBuffer();
    const { value: html } = await mammoth.convertToHtml(
      { arrayBuffer },
      { convertImage: mammoth.images.imgElement(() => Promise.resolve({ src: "" })) }
    );
    const md = getTurndown()
      .turndown(html)
      .replace(/^(\s*)-\s{2,}/gm, "$1- ")
      .replace(/^(\s*)(\d+\.)\s{2,}/gm, "$1$2 ");
    return tidy(md);
  },
};
