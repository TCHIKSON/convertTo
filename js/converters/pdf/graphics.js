// Analyse des dessins d'une page (liste d'opérations pdf.js) :
//   - traits horizontaux et verticaux → grilles de tableaux à bordures ;
//   - formes vectorielles regroupées → diagrammes ;
//   - images matricielles avec leur position.

import {
  IDENTITY, multiply, applyMatrix, boundsOf, unionBox, boxArea, boxWidth, boxHeight, boxesTouch, clusterValues,
} from "./geometry.js";

const LINE_TOLERANCE = 0.8;    // écart maximal pour considérer un trait horizontal / vertical
const MIN_LINE_LENGTH = 4;
const GRID_TOLERANCE = 2;      // jeu admis aux croisements des traits d'une grille
const SHAPE_GAP = 8;           // distance de regroupement des formes d'un même diagramme

/**
 * @param {object} OPS        pdfjsLib.OPS
 * @param {object} opList     résultat de page.getOperatorList()
 * @param {number[]} view     page.view
 * @returns {{ grids: object[], shapes: object[], images: object[] }}
 */
export function readGraphics(OPS, opList, view) {
  const pageBox = [view[0], view[1], view[2], view[3]];
  const pageArea = boxArea(pageBox);
  const hLines = [];
  const vLines = [];
  const shapes = [];
  const images = [];

  const paintOps = new Set([
    OPS.stroke, OPS.closeStroke, OPS.fill, OPS.eoFill, OPS.fillStroke,
    OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke,
  ].filter((v) => v !== undefined));
  const strokeOps = new Set([
    OPS.stroke, OPS.closeStroke, OPS.fillStroke, OPS.eoFillStroke, OPS.closeFillStroke, OPS.closeEOFillStroke,
  ].filter((v) => v !== undefined));
  const imageOps = new Set([
    OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat,
    OPS.paintImageMaskXObject, OPS.paintImageMaskXObjectRepeat, OPS.paintInlineImageXObjectGroup,
  ].filter((v) => v !== undefined));

  let ctm = IDENTITY;
  const stack = [];
  const marked = [];          // pile des contenus marqués (MCID) en cours
  let pending = null;         // chemin construit, en attente d'être peint

  const { fnArray, argsArray } = opList;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i];
    if (fn === OPS.save) stack.push(ctm);
    else if (fn === OPS.restore) ctm = stack.pop() || IDENTITY;
    else if (fn === OPS.transform) ctm = multiply(args, ctm);
    else if (fn === OPS.paintFormXObjectBegin) {
      stack.push(ctm);
      if (Array.isArray(args?.[0]) && args[0].length === 6) ctm = multiply(args[0], ctm);
    } else if (fn === OPS.paintFormXObjectEnd) ctm = stack.pop() || IDENTITY;
    else if (fn === OPS.beginMarkedContentProps) marked.push(typeof args?.[1] === "number" ? args[1] : null);
    else if (fn === OPS.beginMarkedContent) marked.push(null);
    else if (fn === OPS.endMarkedContent) marked.pop();
    else if (fn === OPS.constructPath) {
      const path = parsePath(OPS, args[0], args[1], ctm);
      pending = pending ? mergePaths(pending, path) : path;
    } else if (fn === OPS.endPath) {
      pending = null;   // chemin de découpe, non dessiné
    } else if (paintOps.has(fn)) {
      if (pending) addShape(pending, strokeOps.has(fn));
      pending = null;
    } else if (imageOps.has(fn)) {
      const box = boundsOf([[0, 0], [1, 0], [0, 1], [1, 1]].map(([x, y]) => applyMatrix(ctm, x, y)));
      const mcid = [...marked].reverse().find((m) => m !== null) ?? null;
      images.push({ bbox: box, mcid });
    }
  }

  function addShape(path, stroked) {
    if (!path.points.length) return;
    const bbox = boundsOf(path.points);
    if (boxArea(bbox) > pageArea * 0.9) return;   // fond de page
    for (const s of path.segments) {
      const dx = Math.abs(s[2] - s[0]);
      const dy = Math.abs(s[3] - s[1]);
      if (dy <= LINE_TOLERANCE && dx >= MIN_LINE_LENGTH) {
        hLines.push({ y: (s[1] + s[3]) / 2, x0: Math.min(s[0], s[2]), x1: Math.max(s[0], s[2]) });
      } else if (dx <= LINE_TOLERANCE && dy >= MIN_LINE_LENGTH) {
        vLines.push({ x: (s[0] + s[2]) / 2, y0: Math.min(s[1], s[3]), y1: Math.max(s[1], s[3]) });
      }
    }
    const diagonal = path.segments.some((s) => Math.abs(s[2] - s[0]) > LINE_TOLERANCE && Math.abs(s[3] - s[1]) > LINE_TOLERANCE);
    shapes.push({
      bbox,
      curves: path.curves,
      diagonal,
      rectOnly: path.curves === 0 && !diagonal,
      thin: boxWidth(bbox) < 3 || boxHeight(bbox) < 3,
      stroked,
    });
  }

  const grids = findGrids(hLines, vLines);
  return { grids, shapes, images };
}

// Décompose un chemin pdf.js (opérations + coordonnées) en segments et points, dans le repère de la page.
function parsePath(OPS, ops, coords, ctm) {
  const segments = [];
  const points = [];
  let curves = 0;
  let j = 0, cx = 0, cy = 0, sx = 0, sy = 0;
  const pt = (x, y) => { const p = applyMatrix(ctm, x, y); points.push(p); return p; };
  const seg = (x0, y0, x1, y1) => {
    const a = applyMatrix(ctm, x0, y0);
    const b = applyMatrix(ctm, x1, y1);
    segments.push([a[0], a[1], b[0], b[1]]);
  };
  for (const op of ops || []) {
    if (op === OPS.moveTo) {
      cx = coords[j++]; cy = coords[j++]; sx = cx; sy = cy; pt(cx, cy);
    } else if (op === OPS.lineTo) {
      const x = coords[j++], y = coords[j++];
      seg(cx, cy, x, y); pt(x, y); cx = x; cy = y;
    } else if (op === OPS.curveTo) {
      j += 4; cx = coords[j++]; cy = coords[j++]; pt(cx, cy); curves++;
    } else if (op === OPS.curveTo2 || op === OPS.curveTo3) {
      j += 2; cx = coords[j++]; cy = coords[j++]; pt(cx, cy); curves++;
    } else if (op === OPS.closePath) {
      seg(cx, cy, sx, sy); cx = sx; cy = sy;
    } else if (op === OPS.rectangle) {
      const x = coords[j++], y = coords[j++], w = coords[j++], h = coords[j++];
      seg(x, y, x + w, y); seg(x + w, y, x + w, y + h); seg(x + w, y + h, x, y + h); seg(x, y + h, x, y);
      pt(x, y); pt(x + w, y + h); pt(x + w, y); pt(x, y + h);
      cx = sx = x; cy = sy = y;
    }
  }
  return { segments, points, curves };
}

const mergePaths = (a, b) => ({
  segments: a.segments.concat(b.segments),
  points: a.points.concat(b.points),
  curves: a.curves + b.curves,
});

/* ---------------------------------------------------------------- Grilles */

// Regroupe les traits qui se croisent ; un groupe d'au moins 3 lignes horizontales
// et 3 verticales distinctes forme une grille de tableau (au moins 2 × 2 cellules).
function findGrids(hLines, vLines) {
  const n = hLines.length + vLines.length;
  if (hLines.length < 3 || vLines.length < 3) return [];
  const parent = [...Array(n).keys()];
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a, b) => { parent[find(a)] = find(b); };

  hLines.forEach((h, i) => {
    vLines.forEach((v, k) => {
      if (v.x >= h.x0 - GRID_TOLERANCE && v.x <= h.x1 + GRID_TOLERANCE &&
          h.y >= v.y0 - GRID_TOLERANCE && h.y <= v.y1 + GRID_TOLERANCE) {
        join(i, hLines.length + k);
      }
    });
  });

  const groups = new Map();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, { h: [], v: [] });
    if (i < hLines.length) groups.get(root).h.push(hLines[i]);
    else groups.get(root).v.push(vLines[i - hLines.length]);
  }

  const grids = [];
  for (const { h, v } of groups.values()) {
    const ys = clusterValues(h.map((l) => l.y), GRID_TOLERANCE).sort((a, b) => b - a);
    const xs = clusterValues(v.map((l) => l.x), GRID_TOLERANCE);
    if (ys.length < 3 || xs.length < 3) continue;
    grids.push({ xs, ys, bbox: [xs[0], ys[ys.length - 1], xs[xs.length - 1], ys[0]] });
  }
  return grids;
}

/* -------------------------------------------------------------- Diagrammes */

/**
 * Regroupe les formes proches en zones candidates (diagrammes, graphiques).
 * Les formes situées dans une grille de tableau sont ignorées.
 * @returns {{ bbox: number[], shapes: object[] }[]}
 */
export function groupShapes(shapes, grids) {
  const free = shapes.filter((s) => !grids.some((g) => boxesTouch(s.bbox, g.bbox, -1) && containsBox(g.bbox, s.bbox, 2)));
  const groups = [];
  for (const s of free) {
    const touching = groups.filter((g) => boxesTouch(g.bbox, s.bbox, SHAPE_GAP));
    if (!touching.length) {
      groups.push({ bbox: s.bbox, shapes: [s] });
    } else {
      const merged = touching.reduce((acc, g) => ({ bbox: unionBox(acc.bbox, g.bbox), shapes: acc.shapes.concat(g.shapes) }),
        { bbox: s.bbox, shapes: [s] });
      for (const g of touching) groups.splice(groups.indexOf(g), 1);
      groups.push(merged);
    }
  }
  // Une fusion peut rapprocher deux groupes : on recommence jusqu'à stabilité.
  for (let changed = true; changed;) {
    changed = false;
    outer: for (let a = 0; a < groups.length; a++) {
      for (let b = a + 1; b < groups.length; b++) {
        if (boxesTouch(groups[a].bbox, groups[b].bbox, SHAPE_GAP)) {
          groups[a] = { bbox: unionBox(groups[a].bbox, groups[b].bbox), shapes: groups[a].shapes.concat(groups[b].shapes) };
          groups.splice(b, 1);
          changed = true;
          break outer;
        }
      }
    }
  }
  return groups;
}

const containsBox = (outer, inner, tol) =>
  inner[0] >= outer[0] - tol && inner[1] >= outer[1] - tol && inner[2] <= outer[2] + tol && inner[3] <= outer[3] + tol;
