import { join, sep } from "node:path";
import { getUploadsDirectory } from "./media-storage";
import { db } from "./db";

/**
 * RESOLVER CANÓNICO DE REFERENCIAS MULTIMEDIA — Fase 6.
 *
 * Política vigente: **uploads inmutables + cleanup centralizado de huérfanos
 * comprobados**. Los writes de negocio (PUT/DELETE Product, Brand, Category,
 * etc.) solo modifican referencias en DB; el borrado físico se hace
 * EXCLUSIVAMENTE vía el mecanismo administrativo de
 * `@/lib/media-orphan-cleanup`, que consulta este módulo antes de tocar
 * disco. Ninguna URL `/uploads/X` se considera "propia" de una entidad:
 * pueden compartirse entre varias.
 *
 * Campos DB que pueden contener media (barrido 2026-09 sobre schema + código):
 *   - ProductImage.imagePath / ProductImage.thumbnailPath
 *   - Category.image
 *   - Brand.logo
 *   - Season.image
 *   - Banner.imageDesktop / Banner.imageMobile
 *   - Setting.value (conservador: escaneo de patrones /uploads/ embebidos,
 *     p.ej. JSON de configuración; los valores de settings pueden contener
 *     texto libre y un falso positivo solo impide un borrado, jamás lo causa)
 *
 * SEGURIDAD — solo se gestiona físicamente lo estrictamente interno:
 *   `/uploads/<filename>` (con o sin query/hash). NUNCA se resuelve a path
 *   físico: `http://…`, `https://…` externos, `data:`, `blob:`, rutas fuera
 *   de `/uploads`, ni nada que huela a traversal. La sobre-inclusión
 *   (marcar como referenciado algo dudoso) es el fallo seguro: impide
 *   borrados, no los provoca.
 */

/** `/uploads/<filename>` estricto: filename sin `/`, `\`, `?`, `#`. */
const UPLOAD_URL_PATTERN = /^\/uploads\/([^/?#\\]+)(?:[?#].*)?$/;

/** Escaneo conservador dentro de strings libres (JSON de Setting.value). */
const UPLOAD_URL_SCAN_PATTERN = /\/uploads\/([A-Za-z0-9._%-]+)/g;

/**
 * Filenames físicos permitidos. Los generados por el uploader son
 * `<base-saneado>-<uuid>.<ext>`, pero se toleran nombres históricos con
 * espacios/acentos ASCII. Jamás separadores, control chars, ni `.`/`..`.
 */
const SAFE_FILENAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._()%+-]*$/;

export function isInternalUploadUrl(value: unknown): value is string {
  return typeof value === "string" && UPLOAD_URL_PATTERN.test(value.trim());
}

function isSafeUploadFilename(filename: string): boolean {
  if (!filename || filename === "." || filename === "..") return false;
  if (filename.includes("/") || filename.includes("\\")) return false;
  return SAFE_FILENAME_PATTERN.test(filename);
}

/**
 * Filename físico (seguro) contenido en una referencia DB, o null.
 *
 * Acepta:
 *  - `/uploads/<filename>` canónico (query/hash ignorado; %XX decodificado).
 *  - `http(s)://host/uploads/<filename>`: la app sirve /uploads desde su
 *    propio origen; un absoluto con path /uploads/ se trata como referencia
 *    viva (fallo seguro: puede sobre-incluir, nunca borrar de más).
 *  - Bare filename (`foto.png`) sin esquema ni separadores: el histórico
 *    `normalizeProductImagePath` lo sirve como `/uploads/<filename>`.
 *
 * Rechaza (null): `data:`, `blob:`, otros esquemas, rutas fuera de
 * `/uploads`, filenames con separadores o `..` (traversal).
 */
export function extractUploadFilename(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  let candidate: string | null = null;
  const canonical = UPLOAD_URL_PATTERN.exec(trimmed);
  if (canonical) {
    try {
      candidate = decodeURIComponent(canonical[1]);
    } catch {
      candidate = canonical[1];
    }
  } else if (/^https?:\/\//i.test(trimmed)) {
    try {
      const parsed = new URL(trimmed);
      const pathnameMatch = /^\/uploads\/([^/?#\\]+)$/.exec(parsed.pathname);
      if (pathnameMatch) {
        try {
          candidate = decodeURIComponent(pathnameMatch[1]);
        } catch {
          candidate = pathnameMatch[1];
        }
      }
    } catch {
      return null;
    }
  } else if (
    !trimmed.startsWith("/")
    && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)
    && !trimmed.includes("/")
    && !trimmed.includes("\\")
  ) {
    // Bare filename legacy.
    candidate = trimmed;
  }

  if (!candidate || !isSafeUploadFilename(candidate)) return null;
  return candidate;
}

/**
 * Path físico para un filename, SOLO si vive dentro de
 * `getUploadsDirectory()`. Devuelve null para cualquier filename inseguro:
 * es la única puerta hacia `unlink` del cleanup.
 */
export function resolveUploadFilePath(filename: string): string | null {
  if (!isSafeUploadFilename(filename)) return null;
  const uploadsDir = getUploadsDirectory();
  const fullPath = join(uploadsDir, filename);
  const dirWithSep = uploadsDir.endsWith(sep) ? uploadsDir : uploadsDir + sep;
  if (!fullPath.startsWith(dirWithSep)) return null;
  return fullPath;
}

export interface MediaReferenceInventory {
  /** Filenames físicos referenciados por al menos una entidad. */
  filenames: Set<string>;
  /** filename -> orígenes (tabla.campo) para auditoría. */
  sources: Map<string, string[]>;
  /** Cantidad de valores DB escaneados (auditoría). */
  scannedValues: number;
}

/**
 * Inventario vivo de referencias: barrido completo de los campos DB que
 * pueden contener media. Sobre-incluye por diseño (fallo seguro).
 */
export async function collectMediaReferences(): Promise<MediaReferenceInventory> {
  const inventory: MediaReferenceInventory = {
    filenames: new Set(),
    sources: new Map(),
    scannedValues: 0,
  };

  const record = (filename: string, source: string) => {
    inventory.filenames.add(filename);
    const known = inventory.sources.get(filename);
    if (known) {
      if (!known.includes(source)) known.push(source);
    } else {
      inventory.sources.set(filename, [source]);
    }
  };

  /** Campo escalar de media: URL canónica, absoluta /uploads o bare legacy. */
  const addScalar = (value: unknown, source: string) => {
    inventory.scannedValues += 1;
    const filename = extractUploadFilename(value);
    if (filename) record(filename, source);
  };

  /**
   * Texto libre (Setting.value puede ser JSON/texto): se registran TODAS las
   * apariciones de /uploads/<filename> como referencias vivas.
   */
  const addFreeText = (value: unknown, source: string) => {
    inventory.scannedValues += 1;
    if (typeof value !== "string" || !value) return;
    for (const match of value.matchAll(UPLOAD_URL_SCAN_PATTERN)) {
      const filename = extractUploadFilename(`/uploads/${match[1]}`);
      if (filename) record(filename, source);
    }
  };

  const [productImages, categories, brands, seasons, banners, settings] = await Promise.all([
    db.productImage.findMany({ select: { imagePath: true, thumbnailPath: true } }),
    db.category.findMany({ select: { image: true } }),
    db.brand.findMany({ select: { logo: true } }),
    db.season.findMany({ select: { image: true } }),
    db.banner.findMany({ select: { imageDesktop: true, imageMobile: true } }),
    db.setting.findMany({ select: { value: true } }),
  ]);

  for (const row of productImages) {
    addScalar(row.imagePath, "ProductImage.imagePath");
    addScalar(row.thumbnailPath, "ProductImage.thumbnailPath");
  }
  for (const row of categories) addScalar(row.image, "Category.image");
  for (const row of brands) addScalar(row.logo, "Brand.logo");
  for (const row of seasons) addScalar(row.image, "Season.image");
  for (const row of banners) {
    addScalar(row.imageDesktop, "Banner.imageDesktop");
    addScalar(row.imageMobile, "Banner.imageMobile");
  }
  for (const row of settings) addFreeText(row.value, "Setting.value");

  return inventory;
}

/**
 * Re-check puntual: ¿este filename sigue referenciado? Se invoca
 * INMEDIATAMENTE antes de cada `unlink` en el cleanup administrativo.
 * Re-barrido completo: los campos de media viven en tablas pequeñas y el
 * volumen es despreciable frente al riesgo de borrar un archivo vivo.
 */
export async function isUploadFilenameReferenced(filename: string): Promise<boolean> {
  if (!isSafeUploadFilename(filename)) return true; // dudoso => no tocar
  const inventory = await collectMediaReferences();
  return inventory.filenames.has(filename);
}
