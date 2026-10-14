// Reconnaissance de texte (OCR) avec Tesseract.js, chargé uniquement à la demande.
// L'image de la page est analysée dans le navigateur : rien n'est envoyé à un serveur.
// Seuls le moteur et les données de langue sont téléchargés au premier usage.

const TESSERACT_URL = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";
const DEFAULT_LANGUAGES = "fra+eng";

let loading = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error("Impossible de charger le moteur OCR"));
    document.head.appendChild(s);
  });
}

/** Indique si l'OCR peut fonctionner dans cet environnement (navigateur). */
export const ocrAvailable = () => typeof document !== "undefined";

/**
 * Crée un moteur OCR. À fermer avec terminate() après usage.
 * @returns {Promise<{ recognize(image: HTMLCanvasElement): Promise<string>, terminate(): Promise<void> }>}
 */
export async function createOcr(languages = DEFAULT_LANGUAGES) {
  if (!globalThis.Tesseract) {
    loading ??= loadScript(TESSERACT_URL).catch((e) => { loading = null; throw e; });
    await loading;
  }
  const worker = await globalThis.Tesseract.createWorker(languages);
  return {
    async recognize(image) {
      const { data } = await worker.recognize(image);
      return data.text || "";
    },
    terminate: () => worker.terminate(),
  };
}
