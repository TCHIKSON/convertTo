// Rendu des pages en image (navigateur uniquement) : figures découpées et OCR.

export const RENDER_SCALE = 2;   // 2 × 72 ppp ≈ 144 ppp

/** Indique si le rendu est possible (présence d'un document HTML). */
export const canRender = () => typeof document !== "undefined";

/** Rend une page entière sur un canvas. */
export async function renderPage(page, scale = RENDER_SCALE) {
  const viewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(viewport.width);
  canvas.height = Math.ceil(viewport.height);
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { canvas, viewport };
}

/** Découpe une zone [x0, y0, x1, y1] (repère PDF) dans le rendu de la page. */
export function cropRegion({ canvas, viewport }, bbox, padding = 4) {
  const [ax, ay, bx, by] = viewport.convertToViewportRectangle([
    bbox[0] - padding, bbox[1] - padding, bbox[2] + padding, bbox[3] + padding,
  ]);
  const left = Math.max(0, Math.floor(Math.min(ax, bx)));
  const top = Math.max(0, Math.floor(Math.min(ay, by)));
  const width = Math.min(canvas.width - left, Math.ceil(Math.abs(bx - ax)));
  const height = Math.min(canvas.height - top, Math.ceil(Math.abs(by - ay)));
  const out = document.createElement("canvas");
  out.width = Math.max(1, width);
  out.height = Math.max(1, height);
  out.getContext("2d").drawImage(canvas, left, top, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}

export const canvasToBlob = (canvas) =>
  new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Image non générée"))), "image/png"));

/** Libère la mémoire d'un canvas. */
export function releaseCanvas(canvas) {
  canvas.width = 0;
  canvas.height = 0;
}
