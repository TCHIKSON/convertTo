// Convertisseur tableurs (.xlsx, .xls, .ods, .csv) : une section par feuille.
// Dépend de la globale `XLSX` (SheetJS) chargée dans index.html.

import { baseName, tableToMd, tidy } from "../utils/markdown.js";

export default {
  id: "xlsx",
  label: "XLSX, XLS, ODS, CSV",
  kind: "excel",
  icon: "pi-file-excel",
  extensions: ["xlsx", "xlsm", "xls", "ods", "csv"],

  async convert(file) {
    const { XLSX } = globalThis;
    const wb = XLSX.read(await file.arrayBuffer(), { type: "array" });
    const out = [`# ${baseName(file.name)}`];
    for (const sheetName of wb.SheetNames) {
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], {
        header: 1, defval: "", raw: false, blankrows: false,
      });
      out.push(`## ${sheetName}`, tableToMd(rows) || "*(feuille vide)*");
    }
    return tidy(out.join("\n\n"));
  },
};
