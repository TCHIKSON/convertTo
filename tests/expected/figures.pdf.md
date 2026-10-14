---
title: "Rapport technique"
author: "Équipe projet"
created: "2026-10-14"
modified: "2026-10-14"
pages: 1
---

# Architecture

Le schéma ci-dessous présente les trois composants du système.

*(Diagramme : Navigateur Convertisseur Fichier .md)*

Le tableau suivant liste les formats pris en charge.

| Format | Ext. | Lib. |
| --- | --- | --- |
| PDF | pdf | pdf.js |
| Word | docx | mammoth |
| Excel | xlsx | SheetJS |

Exemple de code :

```
function convert(file) {
    return convertToMd(file);
}
```

Photo du produit :

*(Image)*

Utilisez la fonction `convertToMd()` pour convertir un fichier.
