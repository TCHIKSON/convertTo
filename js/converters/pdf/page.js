// Analyse d'une page : zones converties à part (tableaux, figures), puis lignes de texte.
//
// Ordre de priorité :
//   1. tableaux taggés (structure du PDF) ;
//   2. tableaux à bordures (grille de traits) ;
//   3. diagrammes (formes vectorielles avec leurs étiquettes) ;
//   4. images ;
//   5. texte restant → lignes, dans lesquelles on repère ensuite les équations.

import { boxArea, boxWidth, boxHeight, boxesTouch, boundsOf, itemCenter, pointInBox } from "./geometry.js";
import { groupShapes } from "./graphics.js";
import { itemsText } from "./text.js";
import { buildLines, extractEquations } from "./lines.js";
import { tableToMd } from "../../utils/markdown.js";

const ZONE = 0.09;   // part de la hauteur de page considérée comme en-tête / pied de page

const readingOrder = (items) => [...items].sort((p, q) => q.y - p.y || p.x - q.x);

/**
 * @returns {{ number, lines, empty, figures, twoColumns }}
 */
export function buildPage({ number, view, items, graphics, structure, slug }) {
  const pageBox = [view[0], view[1], view[2], view[3]];
  const pageArea = boxArea(pageBox);
  const placeholders = [];
  const figures = [];
  let counter = 0;

  const makeFigure = (kind, bbox, extra = {}) => ({
    kind, bbox, alt: "", path: `images/${slug}/page${number}-${kind}${++counter}.png`,
    rendered: false, ocrText: "", page: number, ...extra,
  });

  const hadText = items.length > 0;
  // Dans un PDF taggé, les « artefacts » (en-têtes, pieds de page, numéros) ne font pas partie du contenu.
  let remaining = structure ? items.filter((it) => !it.artifact) : [...items];
  const take = (predicate) => {
    const taken = [], kept = [];
    for (const it of remaining) (predicate(it) ? taken : kept).push(it);
    remaining = kept;
    return taken;
  };
  const occupied = (bbox) => placeholders.some((p) => boxesTouch(p.bbox, bbox, -2));

  /* 1. Tableaux taggés */
  for (const table of structure?.tables || []) {
    const ids = new Set(table.rows.flat().flatMap((cell) => [...cell]));
    const cellItems = take((it) => it.mcid !== null && ids.has(it.mcid));
    if (!cellItems.length) continue;
    const rows = table.rows.map((row) => row.map((cell) => itemsText(readingOrder(cellItems.filter((it) => cell.has(it.mcid))))));
    const bbox = boundsOf(cellItems.flatMap((it) => [[it.x, it.y - it.size * 0.3], [it.x + it.w, it.y + it.size]]));
    placeholders.push({ bbox, table: { md: tableToMd(rows) } });
  }

  /* 2. Tableaux à bordures */
  for (const grid of graphics.grids) {
    if (occupied(grid.bbox)) continue;
    const { xs, ys } = grid;
    const inside = remaining.filter((it) => { const [cx, cy] = itemCenter(it); return pointInBox(cx, cy, grid.bbox, 1); });
    if (!inside.length) continue;
    const cells = ys.slice(1).map(() => xs.slice(1).map(() => []));
    for (const it of inside) {
      const [cx, cy] = itemCenter(it);
      const r = ys.findIndex((y, k) => k < ys.length - 1 && cy <= y + 1 && cy >= ys[k + 1] - 1);
      const c = xs.findIndex((x, k) => k < xs.length - 1 && cx >= x - 1 && cx <= xs[k + 1] + 1);
      if (r >= 0 && c >= 0) cells[r][c].push(it);
    }
    const rows = cells.map((row) => row.map((cell) => itemsText(readingOrder(cell))));
    if (rows.flat().filter(Boolean).length < 2) continue;
    const used = new Set(inside);
    take((it) => used.has(it));
    placeholders.push({ bbox: grid.bbox, table: { md: tableToMd(rows) } });
  }

  /* 3. Diagrammes */
  const diagramBoxes = [];
  for (const group of groupShapes(graphics.shapes, graphics.grids)) {
    const { bbox, shapes } = group;
    if (boxWidth(bbox) < 30 || boxHeight(bbox) < 30 || boxArea(bbox) > pageArea * 0.7) continue;
    if (shapes.length < 2 || shapes.every((s) => s.thin) || occupied(bbox)) continue;
    const labels = remaining.filter((it) => { const [cx, cy] = itemCenter(it); return pointInBox(cx, cy, bbox, 2); });
    const chars = labels.reduce((n, it) => n + it.str.trim().length, 0);
    const drawn = shapes.some((s) => s.curves > 0 || s.diagonal);
    // Des rectangles seuls avec beaucoup de texte : un encadré ou un tableau coloré, pas un diagramme.
    if (drawn ? chars > 400 : shapes.length < 3 || chars > 80) continue;
    const used = new Set(labels);
    take((it) => used.has(it));
    const figure = makeFigure("diagram", bbox, { labels: itemsText(readingOrder(labels)) });
    figure.alt = figure.labels ? `Diagramme : ${truncate(figure.labels, 160)}` : "Diagramme";
    figures.push(figure);
    diagramBoxes.push(bbox);
    placeholders.push({ bbox, figure });
  }

  /* 4. Images */
  for (const image of graphics.images) {
    const { bbox } = image;
    if (boxWidth(bbox) < 16 || boxHeight(bbox) < 16) continue;
    const fullPage = boxArea(bbox) > pageArea * 0.85;
    if (fullPage && hadText) continue;   // fond de page ou filigrane
    if (diagramBoxes.some((d) => boxesTouch(d, bbox, -2))) continue;
    const figure = makeFigure("image", bbox, { fullPage });
    figure.alt = structure?.figureAlt.get(image.mcid) || "";
    figures.push(figure);
    placeholders.push({ bbox, figure });
  }

  /* 5. Lignes de texte et équations */
  const { lines, twoColumns } = buildLines(remaining, placeholders, view);
  figures.push(...extractEquations(lines, makeFigure));

  const [, vy0, , vy1] = view;
  const height = vy1 - vy0;
  for (const l of lines) {
    l.page = number;
    if (l.placeholder) { l.zone = null; continue; }
    const fromTop = (vy1 - l.y) / height;
    const fromBottom = (l.y - vy0) / height;
    l.zone = fromTop < ZONE ? "top" : fromBottom < ZONE ? "bottom" : null;
    l.edge = Math.min(fromTop, fromBottom);   // distance au bord le plus proche (part de la hauteur)
  }

  return { number, lines, empty: !hadText, figures, twoColumns };
}

const truncate = (s, n) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);
