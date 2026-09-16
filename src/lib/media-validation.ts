/**
 * F6B1 — Validación binaria real del upload multimedia.
 *
 * `File.type` es una declaración del cliente (navegador o cualquier cliente
 * HTTP) y NO es autoridad: se puede declarar `image/png` y enviar HTML, SVG
 * o un ejecutable. Este módulo identifica el formato real por magic bytes
 * para los únicos formatos de la allowlist del upload: JPEG, PNG, WebP y
 * GIF. SVG continúa prohibido.
 *
 * Deliberadamente sin dependencias externas: las cuatro firmas son
 * suficientemente pequeñas para una implementación propia y testeable.
 *
 * La extensión devuelta es la del formato DETECTADO: el filename persistido
 * debe derivarse de aquí, nunca del MIME declarado ni de la extensión
 * original del filename del navegador.
 */

/** Formato de imagen permitido detectado: MIME canónico + extensión de almacenamiento. */
export interface DetectedImageFormat {
  mime: "image/jpeg" | "image/png" | "image/webp" | "image/gif";
  extension: "jpg" | "png" | "webp" | "gif";
}

/**
 * Allowlist MIME declarado del endpoint de upload (sin cambios desde F6A).
 * El MIME declarado sigue siendo el primer filtro: el contenido detectado
 * debe ADEMÁS coincidir con él (el mismatch se rechaza, no se corrige).
 */
const ALLOWED_IMAGE_MIMES: ReadonlySet<string> = new Set([
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
]);

export function isAllowedImageMime(mime: string): boolean {
  return ALLOWED_IMAGE_MIMES.has(mime);
}

// JPEG: la familia de firmas reales (JFIF/Exif) comparte el prefijo FF D8 FF.
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff];
// PNG: firma completa de 8 bytes.
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
// GIF: cabecera ASCII con versión incluida.
const GIF_SIGNATURES = ["GIF87a", "GIF89a"];

function startsWith(bytes: Uint8Array, signature: readonly number[]): boolean {
  if (bytes.length < signature.length) return false;
  for (let i = 0; i < signature.length; i += 1) {
    if (bytes[i] !== signature[i]) return false;
  }
  return true;
}

function asciiSlice(bytes: Uint8Array, offset: number, length: number): string {
  let value = "";
  for (let i = offset; i < offset + length; i += 1) {
    value += String.fromCharCode(bytes[i]);
  }
  return value;
}

/**
 * Detecta el formato real de un buffer por magic bytes.
 *
 * Devuelve null cuando el contenido no corresponde a ningún formato
 * permitido: HTML/texto, SVG, ejecutables, buffers vacíos, truncados o
 * aleatorios. Nunca lanza por contenido inválido.
 */
export function detectImageFormat(bytes: Uint8Array): DetectedImageFormat | null {
  if (startsWith(bytes, JPEG_SIGNATURE)) {
    return { mime: "image/jpeg", extension: "jpg" };
  }

  if (startsWith(bytes, PNG_SIGNATURE)) {
    return { mime: "image/png", extension: "png" };
  }

  if (bytes.length >= 6) {
    const header = asciiSlice(bytes, 0, 6);
    if (GIF_SIGNATURES.includes(header)) {
      return { mime: "image/gif", extension: "gif" };
    }
  }

  // WebP: contenedor RIFF con "WEBP" en los bytes 8-11.
  if (bytes.length >= 12 && asciiSlice(bytes, 0, 4) === "RIFF" && asciiSlice(bytes, 8, 4) === "WEBP") {
    return { mime: "image/webp", extension: "webp" };
  }

  return null;
}
