# Convertisseur Markdown

Outil web qui convertit des fichiers **PDF**, **Word** et **Excel** en **Markdown**.

La conversion se fait entièrement dans le navigateur. Les fichiers ne sont envoyés à aucun serveur et rien n'est stocké. Quand on ferme l'onglet, tout disparaît.

## Formats pris en charge

| Format | Extensions | Ce qui est récupéré |
| --- | --- | --- |
| PDF | `.pdf` | Titres, gras, italique, listes imbriquées, paragraphes, mises en page sur deux colonnes |
| Word | `.docx` | Titres, gras, italique, listes, liens, tableaux |
| Excel | `.xlsx`, `.xlsm`, `.xls`, `.ods`, `.csv` | Une section par feuille, sous forme de tableau |

### Traitement des PDF

- Les **titres** sont détectés sur l'ensemble du document. Chaque taille de police plus grande que le texte courant devient un niveau (`#`, `##`, `###`). Les lignes courtes entièrement en gras deviennent aussi des titres.
- Les **en-têtes et pieds de page** répétés et les **numéros de page** sont retirés.
- Les pages sur **deux colonnes** sont lues dans l'ordre : colonne de gauche, puis colonne de droite.
- Le **gras** et l'**italique** sont conservés dans le texte.
- Les **puces** et les listes numérotées deviennent des listes Markdown, imbriquées selon leur retrait.
- Les mots coupés en fin de ligne sont recollés, et un paragraphe qui continue sur la page ou la colonne suivante reste d'un seul tenant.
- Les **tableaux** sont reconstitués à partir de l'alignement du texte, y compris les cellules sur plusieurs lignes et les montants alignés à droite.
- Les **liens hypertextes** sont conservés sous la forme `[texte](adresse)`.
- Pour un **PDF protégé**, une fenêtre demande le mot de passe. Il sert uniquement à ouvrir le fichier et n'est jamais conservé.
- L'option **OCR** lit les pages scannées avec Tesseract.js, en français et en anglais. Le moteur est téléchargé au premier usage (environ 15 Mo), puis l'analyse se fait sur votre appareil.

Limites actuelles :
- Les tableaux sans espace net entre les colonnes, ou dont une cellule déborde sur la colonne voisine, peuvent être mal découpés. La première ligne d'un tableau est toujours prise comme en-tête.
- L'OCR ne reconnaît que le texte brut : pas de titres, de gras ni de tableaux sur les pages scannées.
- Les images ne sont pas intégrées au Markdown, quel que soit le format.
- Les anciens fichiers Word `.doc` ne sont pas pris en charge. Il faut les réenregistrer en `.docx`.

## Structure du projet

```
index.html                 Page (structure seulement)
css/style.css              Styles
js/app.js                  Interface : dépôt, liste, aperçu, téléchargement
js/convert.js              convertToMd(file) : choisit le convertisseur selon l'extension
js/converters/pdf.js       PDF  → Markdown (pdf.js)
js/converters/docx.js      Word → Markdown (mammoth + Turndown)
js/converters/xlsx.js      Tableurs → Markdown (SheetJS)
js/utils/markdown.js       Fonctions communes (tableaux, nettoyage)
js/utils/ocr.js            OCR avec Tesseract.js, chargé à la demande
cli/convert_to_md.py       Version en ligne de commande (Python)
```

L'interface n'appelle qu'une seule fonction :

```js
import { convertToMd } from "./convert.js";
const markdown = await convertToMd(file, {
  onProgress: (done, total, label) => {},    // progression (« Page 3 / 12 »)
  ocr: true,                                 // OCR des pages scannées (PDF)
  requestPassword: async (fileName, retry) => "mot de passe" /* ou null pour annuler */,
});
```

Toutes les options sont facultatives. Chaque convertisseur utilise celles qui le concernent.

### Améliorer la conversion PDF

Tout se passe dans `js/converters/pdf.js`. Les réglages principaux sont des constantes en haut du fichier (`SEGMENT_GAP`, `TABLE_ROW_GAP`, `ZONE`, `BULLET`…). Chaque étape a sa fonction : `readPage`, `findGutter`, `removeRunningLines`, `detectTables`, `headingLevels`, `classify` et `assemble`.

### Ajouter un format

1. Créez `js/converters/<format>.js` sur le modèle des autres :

   ```js
   export default {
     id: "pptx",
     label: "PPTX",
     kind: "word",              // couleur de l'icône : pdf, word ou excel
     icon: "pi-file",           // icône PrimeIcons
     extensions: ["pptx"],
     async convert(file, { onProgress } = {}) {
       const buffer = await file.arrayBuffer();
       // ...
       return markdown;
     },
   };
   ```

2. Ajoutez-le au tableau `CONVERTERS` dans `js/convert.js`.

L'interface se met à jour seule : extensions acceptées, étiquettes et icônes.

## Mise en ligne avec GitHub Pages

1. Créez un dépôt sur GitHub et ajoutez-y tout le contenu de ce dossier.
2. Ouvrez **Settings**, puis **Pages**.
3. Dans **Source**, choisissez **Deploy from a branch**, puis la branche `main` et le dossier `/ (root)`.
4. Enregistrez. Le site sera disponible après une minute environ à l'adresse `https://<votre-compte>.github.io/<nom-du-depot>/`.

Aucune compilation ni dépendance à installer.

## Utilisation en local

Le code est découpé en modules JavaScript. Les navigateurs refusent de les charger quand on ouvre `index.html` par un double-clic (adresse en `file://`). Il faut lancer un petit serveur local depuis le dossier du projet :

```bash
python -m http.server 8000
```

Ouvrez ensuite `http://localhost:8000`. Une connexion internet est nécessaire, car les bibliothèques sont chargées depuis un CDN.

## Version en ligne de commande

Le dossier `cli/` contient un script Python équivalent, pratique pour convertir des dossiers entiers :

```bash
pip install pdfplumber python-docx openpyxl
python cli/convert_to_md.py mon_dossier/ -r -o sortie/
```

## Bibliothèques utilisées

- [pdf.js](https://mozilla.github.io/pdf.js/) pour la lecture des PDF
- [mammoth.js](https://github.com/mwilliamson/mammoth.js) pour la lecture des fichiers Word
- [Turndown](https://github.com/mixmark-io/turndown) pour la conversion HTML vers Markdown
- [SheetJS](https://sheetjs.com/) pour la lecture des tableurs
- [JSZip](https://stuk.github.io/jszip/) pour l'archive `.zip`
- [marked](https://marked.js.org/) et [DOMPurify](https://github.com/cure53/DOMPurify) pour l'aperçu
- [Tesseract.js](https://tesseract.projectnaptha.com/) pour l'OCR
- [PrimeIcons](https://primevue.org/icons/) pour les icônes