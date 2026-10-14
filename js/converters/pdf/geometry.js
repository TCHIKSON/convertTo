// Outils géométriques et numériques partagés par les modules PDF.
// Les rectangles sont notés [x0, y0, x1, y1], avec l'axe y vers le haut (repère PDF).

export const round = (v, step = 0.5) => Math.round(v / step) * step;
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export const median = (arr) => {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};

/* Matrices de transformation [a, b, c, d, e, f] */
export const IDENTITY = [1, 0, 0, 1, 0, 0];

/** Composition : applique m1 puis m2. */
export function multiply(m1, m2) {
  const [a1, b1, c1, d1, e1, f1] = m1;
  const [a2, b2, c2, d2, e2, f2] = m2;
  return [
    a1 * a2 + b1 * c2, a1 * b2 + b1 * d2,
    c1 * a2 + d1 * c2, c1 * b2 + d1 * d2,
    e1 * a2 + f1 * c2 + e2, e1 * b2 + f1 * d2 + f2,
  ];
}

export const applyMatrix = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

/* Rectangles */
export function boundsOf(points) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of points) {
    if (x < x0) x0 = x; if (x > x1) x1 = x;
    if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0, y0, x1, y1];
}

export const unionBox = (a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])];
export const boxWidth = (b) => b[2] - b[0];
export const boxHeight = (b) => b[3] - b[1];
export const boxArea = (b) => Math.max(0, boxWidth(b)) * Math.max(0, boxHeight(b));

export const pointInBox = (x, y, b, tol = 0) =>
  x >= b[0] - tol && x <= b[2] + tol && y >= b[1] - tol && y <= b[3] + tol;

export const boxesTouch = (a, b, tol = 0) =>
  a[0] <= b[2] + tol && b[0] <= a[2] + tol && a[1] <= b[3] + tol && b[1] <= a[3] + tol;

/** Centre d'un fragment de texte (repère PDF). */
export const itemCenter = (it) => [it.x + it.w / 2, it.y + it.size * 0.3];

/** Regroupe des valeurs proches (à `tol` près) et renvoie la moyenne de chaque groupe, triée. */
export function clusterValues(values, tol) {
  const sorted = [...values].sort((a, b) => a - b);
  const groups = [];
  for (const v of sorted) {
    const g = groups[groups.length - 1];
    if (g && v - g[g.length - 1] <= tol) g.push(v);
    else groups.push([v]);
  }
  return groups.map((g) => g.reduce((s, v) => s + v, 0) / g.length);
}
