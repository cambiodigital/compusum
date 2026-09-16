import { readdir, lstat, unlink } from "fs/promises";
import { getUploadPublicUrl, getUploadsDirectory } from "./media-storage";
import {
  collectMediaReferences,
  resolveUploadFilePath,
} from "./media-references";

/**
 * CLEANUP ADMINISTRATIVO DE HUÉRFANOS — Fase 6.
 *
 * Único mecanismo autorizado para borrar archivos físicos de /uploads.
 * Los writes de negocio JAMÁS borran archivos (las URLs pueden compartirse
 * entre entidades); este módulo:
 *
 *  1. Lista el directorio canónico `getUploadsDirectory()`.
 *  2. Compara contra el inventario vivo de `@/lib/media-references`.
 *  3. Dry-run (scan) por defecto: NO BORRA NADA.
 *  4. El borrado (deleteUploadOrphans) exige por archivo:
 *       - filename seguro resuelto dentro de getUploadsDirectory();
 *       - fichero REGULAR (lstat), sin symlinks;
 *       - antigüedad >= 24h (piso fijo, no configurable hacia abajo);
 *       - re-check de referencias DB INMEDIATAMENTE antes del unlink;
 *       - ENOENT => idempotente (no error);
 *       - cualquier otro error se reporta y continúa con el resto.
 *
 * Sin cron: solo se ejecuta manualmente vía /api/admin/upload/orphans.
 */

/** Piso de antigüedad: candidatos SOLO con >= 24 horas. */
export const MIN_ORPHAN_AGE_HOURS = 24;

const HOUR_MS = 60 * 60 * 1000;

/** Normaliza la antigüedad pedida: jamás por debajo del piso de 24h. */
export function normalizeMinAgeHours(requested?: number): number {
  if (typeof requested !== "number" || !Number.isFinite(requested)) {
    return MIN_ORPHAN_AGE_HOURS;
  }
  return Math.max(MIN_ORPHAN_AGE_HOURS, requested);
}

export interface PhysicalUploadFile {
  filename: string;
  url: string;
  size: number;
  modifiedAt: string;
  ageHours: number;
}

export interface SkippedUploadFile {
  filename: string;
  reason: string;
}

/** Error operativo por archivo (lectura/borrado); no aborta el proceso. */
export interface UploadFileError {
  filename: string;
  error: string;
}

export interface OrphanScanResult {
  uploadsDir: string;
  /** Todos los ficheros regulares encontrados en disco. */
  physicalFiles: PhysicalUploadFile[];
  /** Filenames referenciados por DB (vivos). */
  referencedFilenames: string[];
  /** Huérfanos con antigüedad suficiente: candidatos reales a borrado. */
  orphanCandidates: PhysicalUploadFile[];
  /** Bytes recuperables si se borran todos los candidatos. */
  recoverableBytes: number;
  /** Huérfanos jóvenes (<24h): esperando ventana de seguridad. */
  skippedByAge: SkippedUploadFile[];
  /** Entradas ignoradas por seguridad (symlink, no-regular, nombre inseguro). */
  skippedUnsafe: SkippedUploadFile[];
  /** Errores de lectura por archivo (no fatales). */
  errors: UploadFileError[];
}

interface DirEntryInfo {
  filename: string;
  size: number;
  mtimeMs: number;
}

function ageHoursOf(entry: DirEntryInfo, nowMs: number): number {
  return Math.max(0, (nowMs - entry.mtimeMs) / HOUR_MS);
}

function toPhysicalFile(entry: DirEntryInfo, nowMs: number): PhysicalUploadFile {
  return {
    filename: entry.filename,
    url: getUploadPublicUrl(entry.filename),
    size: entry.size,
    modifiedAt: new Date(entry.mtimeMs).toISOString(),
    ageHours: Math.round(ageHoursOf(entry, nowMs) * 100) / 100,
  };
}

async function listRegularUploadFiles(errors: UploadFileError[], skippedUnsafe: SkippedUploadFile[]): Promise<DirEntryInfo[]> {
  const uploadsDir = getUploadsDirectory();
  let names: string[];
  try {
    names = await readdir(uploadsDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return []; // directorio aún no creado: cero uploads físicos.
    }
    throw error;
  }

  const entries: DirEntryInfo[] = [];
  for (const name of names) {
    const fullPath = resolveUploadFilePath(name);
    if (!fullPath) {
      skippedUnsafe.push({ filename: name, reason: "nombre de archivo inseguro (fuera de contrato /uploads)" });
      continue;
    }
    try {
      const stats = await lstat(fullPath); // lstat: los symlinks NO se siguen.
      if (stats.isSymbolicLink()) {
        skippedUnsafe.push({ filename: name, reason: "symlink: nunca se gestiona" });
        continue;
      }
      if (!stats.isFile()) {
        skippedUnsafe.push({ filename: name, reason: "no es un fichero regular" });
        continue;
      }
      entries.push({ filename: name, size: stats.size, mtimeMs: stats.mtimeMs });
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") continue; // desapareció entre readdir y lstat
      errors.push({ filename: name, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return entries;
}

/**
 * DRY-RUN: inventario físico vs referencias vivas. Jamás borra nada.
 */
export async function scanUploadOrphans(options: { minAgeHours?: number } = {}): Promise<OrphanScanResult> {
  const minAgeHours = normalizeMinAgeHours(options.minAgeHours);
  const nowMs = Date.now();
  const uploadsDir = getUploadsDirectory();
  const errors: UploadFileError[] = [];
  const skippedUnsafe: SkippedUploadFile[] = [];

  const entries = await listRegularUploadFiles(errors, skippedUnsafe);
  const inventory = await collectMediaReferences();

  const physicalFiles: PhysicalUploadFile[] = [];
  const orphanCandidates: PhysicalUploadFile[] = [];
  const skippedByAge: SkippedUploadFile[] = [];
  const referenced: string[] = [];
  let recoverableBytes = 0;

  for (const entry of entries) {
    physicalFiles.push(toPhysicalFile(entry, nowMs));
    if (inventory.filenames.has(entry.filename)) {
      referenced.push(entry.filename);
      continue;
    }
    if (ageHoursOf(entry, nowMs) < minAgeHours) {
      skippedByAge.push({ filename: entry.filename, reason: `antigüedad < ${minAgeHours}h (ventana de seguridad)` });
      continue;
    }
    orphanCandidates.push(toPhysicalFile(entry, nowMs));
    recoverableBytes += entry.size;
  }

  return {
    uploadsDir,
    physicalFiles,
    referencedFilenames: referenced,
    orphanCandidates,
    recoverableBytes,
    skippedByAge,
    skippedUnsafe,
    errors,
  };
}

export interface OrphanDeleteReport {
  mode: "delete";
  minAgeHours: number;
  deleted: Array<{ filename: string; size: number }>;
  skipped: SkippedUploadFile[];
  errors: UploadFileError[];
  freedBytes: number;
}

/**
 * BORRADO FÍSICO de huérfanos comprobados. Solo llama esto la ruta admin
 * con rol `admin` estricto y acción explícita (`mode: "delete"`).
 * Cada candidato pasa TODAS las garantías de seguridad antes del unlink.
 */
export async function deleteUploadOrphans(options: { minAgeHours?: number } = {}): Promise<OrphanDeleteReport> {
  const minAgeHours = normalizeMinAgeHours(options.minAgeHours);
  const report: OrphanDeleteReport = {
    mode: "delete",
    minAgeHours,
    deleted: [],
    skipped: [],
    errors: [],
    freedBytes: 0,
  };

  const scan = await scanUploadOrphans({ minAgeHours });
  report.errors.push(...scan.errors);

  for (const candidate of scan.orphanCandidates) {
    const { filename } = candidate;

    // 1) Path exclusivamente dentro de getUploadsDirectory().
    const fullPath = resolveUploadFilePath(filename);
    if (!fullPath || !fullPath.startsWith(getUploadsDirectory())) {
      report.skipped.push({ filename, reason: "path fuera del directorio de uploads" });
      continue;
    }

    // 2/3/4) lstat fresco: regular, no symlink, antigüedad suficiente.
    try {
      const stats = await lstat(fullPath);
      if (stats.isSymbolicLink()) {
        report.skipped.push({ filename, reason: "symlink: nunca se gestiona" });
        continue;
      }
      if (!stats.isFile()) {
        report.skipped.push({ filename, reason: "no es un fichero regular" });
        continue;
      }
      if ((Date.now() - stats.mtimeMs) / HOUR_MS < minAgeHours) {
        report.skipped.push({ filename, reason: `antigüedad < ${minAgeHours}h en re-check` });
        continue;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        report.skipped.push({ filename, reason: "ENOENT: ya no existe (idempotente)" });
        continue;
      }
      report.errors.push({ filename, error: error instanceof Error ? error.message : String(error) });
      continue;
    }

    // 5) Re-check de referencias INMEDIATAMENTE antes del unlink.
    const inventory = await collectMediaReferences();
    if (inventory.filenames.has(filename)) {
      report.skipped.push({ filename, reason: "referencia apareció en re-check: NO se borra" });
      continue;
    }

    // 6) unlink con ENOENT idempotente; otros errores se reportan.
    try {
      await unlink(fullPath);
      report.deleted.push({ filename, size: candidate.size });
      report.freedBytes += candidate.size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
        report.skipped.push({ filename, reason: "ENOENT al unlink: ya no existe (idempotente)" });
        continue;
      }
      report.errors.push({ filename, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return report;
}
