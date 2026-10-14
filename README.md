# Convertisseur Markdown

Outil web qui convertit des fichiers **PDF**, **Word** et **Excel** en **Markdown**.

La conversion se fait entièrement dans le navigateur. Les fichiers ne sont envoyés à aucun serveur et rien n'est stocké. Quand on ferme l'onglet, tout disparaît.

## Formats pris en charge

| Format | Extensions | Ce qui est récupéré |
| --- | --- | --- |
| PDF | `.pdf` | Texte page par page, titres (selon la taille de police), listes |
| Word | `.docx` | Titres, gras, italique, listes, liens, tableaux |
| Excel | `.xlsx`, `.xlsm`, `.xls`, `.ods`, `.csv` | Une section par feuille, sous forme de tableau |

Limites :
- Les images ne sont pas intégrées au Markdown.
- Les PDF scannés, qui ne contiennent que des images, ne produisent pas de texte.
- Les anciens fichiers Word `.doc` ne sont pas pris en charge. Il faut les réenregistrer en `.docx`.

## Fonctionnalités

- Glisser-déposer ou sélection de plusieurs fichiers à la fois
- Aperçu du Markdown en source ou en rendu
- Copie dans le presse-papiers
- Téléchargement d'un fichier `.md` ou de tous les fichiers dans un `.zip`
- Thème clair et sombre automatique, interface adaptée au mobile

## Mise en ligne avec GitHub Pages

1. Créez un dépôt sur GitHub et ajoutez-y `index.html` et `README.md`.
2. Ouvrez **Settings**, puis **Pages**.
3. Dans **Source**, choisissez **Deploy from a branch**, puis la branche `main` et le dossier `/ (root)`.
4. Enregistrez. Le site sera disponible après une minute environ à l'adresse `https://<votre-compte>.github.io/<nom-du-depot>/`.

Aucune compilation ni dépendance à installer : le site est un unique fichier HTML.

## Utilisation en local

Ouvrez simplement `index.html` dans votre navigateur. Une connexion internet est nécessaire au premier chargement, car les bibliothèques sont chargées depuis un CDN.

## Bibliothèques utilisées

- [pdf.js](https://mozilla.github.io/pdf.js/) pour la lecture des PDF
- [mammoth.js](https://github.com/mwilliamson/mammoth.js) pour la lecture des fichiers Word
- [Turndown](https://github.com/mixmark-io/turndown) pour la conversion HTML vers Markdown
- [SheetJS](https://sheetjs.com/) pour la lecture des tableurs
- [JSZip](https://stuk.github.io/jszip/) pour l'archive `.zip`
- [marked](https://marked.js.org/) et [DOMPurify](https://github.com/cure53/DOMPurify) pour l'aperçu
- [PrimeIcons](https://primevue.org/icons/) pour les icônes