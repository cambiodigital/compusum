import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join, basename } from 'node:path';

/**
 * Fase 6 — CLEANUP ADMINISTRATIVO DE HUÉRFANOS.
 *
 * Garantías probadas:
 *  - dry-run (scan) NUNCA llama unlink;
 *  - archivos referenciados jamás se borran;
 *  - huérfanos con <24h se omiten (piso fijo, aunque se pida menos);
 *  - symlinks/no-regulares/inseguros se omiten;
 *  - el re-check de referencias INMEDIATO antes del unlink gana;
 *  - ENOENT es idempotente (no throw);
 *  - unlink SOLO ocurre con path join(getUploadsDirectory(), filename).
 *
 * 'fs/promises' se mockea completo: jamás se toca public/uploads real.
 * collectMediaReferences se mockea con inventarios controlados.
 */

const mockDb = vi.hoisted(() => ({ $queryRawUnsafe: vi.fn() }));
vi.mock('@/lib/db', () => ({ db: mockDb }));

const inventoryState = vi.hoisted(() => ({
  queue: [] as Array<Set<string>>,
  fallback: new Set<string>(),
}));

vi.mock('@/lib/media-references', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/media-references')>();
  return {
    ...actual,
    collectMediaReferences: vi.fn(async () => {
      const next = inventoryState.queue.shift();
      const filenames = next ?? inventoryState.fallback;
      return { filenames, sources: new Map(), scannedValues: 0 };
    }),
  };
});

const fsMock = vi.hoisted(() => ({
  readdir: vi.fn(async () => [] as string[]),
  lstat: vi.fn(async (..._args: unknown[]): Promise<unknown> => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  }),
  unlink: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock('fs/promises', () => ({
  readdir: fsMock.readdir,
  lstat: fsMock.lstat,
  unlink: fsMock.unlink,
  default: { readdir: fsMock.readdir, lstat: fsMock.lstat, unlink: fsMock.unlink },
}));

import {
  MIN_ORPHAN_AGE_HOURS,
  deleteUploadOrphans,
  normalizeMinAgeHours,
  scanUploadOrphans,
} from '@/lib/media-orphan-cleanup';
import { getUploadsDirectory } from '@/lib/media-storage';
import { collectMediaReferences } from '@/lib/media-references';

const HOURS = 60 * 60 * 1000;
const uploadsDir = getUploadsDirectory();

function fileStats({ ageHours, size = 100 }: { ageHours: number; size?: number }) {
  return {
    isSymbolicLink: () => false,
    isFile: () => true,
    isDirectory: () => false,
    size,
    mtimeMs: Date.now() - ageHours * HOURS,
  };
}

function symlinkStats() {
  return {
    isSymbolicLink: () => true,
    isFile: () => false,
    isDirectory: () => false,
    size: 0,
    mtimeMs: Date.now() - 100 * HOURS,
  };
}

function dirStats() {
  return {
    isSymbolicLink: () => false,
    isFile: () => false,
    isDirectory: () => true,
    size: 0,
    mtimeMs: Date.now() - 100 * HOURS,
  };
}

/** lstat responde por basename del path pedido. */
function mockLstatByFile(map: Record<string, () => unknown>) {
  fsMock.lstat.mockImplementation(async (fullPath: unknown) => {
    const key = basename(String(fullPath));
    const factory = map[key];
    if (!factory) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    return factory();
  });
}

function queueInventories(...sets: Array<Set<string>>) {
  inventoryState.queue = sets;
}

beforeEach(() => {
  vi.clearAllMocks();
  inventoryState.fallback = new Set();
  inventoryState.queue = [];
  (collectMediaReferences as ReturnType<typeof vi.fn>).mockClear();
});

describe('normalizeMinAgeHours — piso de seguridad fijo', () => {
  it('jamás por debajo de 24h', () => {
    expect(normalizeMinAgeHours()).toBe(MIN_ORPHAN_AGE_HOURS);
    expect(normalizeMinAgeHours(1)).toBe(24);
    expect(normalizeMinAgeHours(0)).toBe(24);
    expect(normalizeMinAgeHours(-5)).toBe(24);
    expect(normalizeMinAgeHours(Number.NaN)).toBe(24);
    expect(normalizeMinAgeHours(72)).toBe(72);
  });
});

describe('scanUploadOrphans — DRY RUN', () => {
  it('jamás llama unlink (no borra nada)', async () => {
    fsMock.readdir.mockResolvedValue(['old.png']);
    mockLstatByFile({ 'old.png': () => fileStats({ ageHours: 72 }) });

    await scanUploadOrphans();

    expect(fsMock.unlink).not.toHaveBeenCalled();
  });

  it('huérfano viejo => candidato; referenciado => NUNCA candidato', async () => {
    fsMock.readdir.mockResolvedValue(['old.png', 'referenced.png']);
    mockLstatByFile({
      'old.png': () => fileStats({ ageHours: 72, size: 100 }),
      'referenced.png': () => fileStats({ ageHours: 72, size: 200 }),
    });
    inventoryState.fallback = new Set(['referenced.png']);

    const scan = await scanUploadOrphans();

    expect(scan.orphanCandidates.map((f) => f.filename)).toEqual(['old.png']);
    expect(scan.referencedFilenames).toEqual(['referenced.png']);
    expect(scan.recoverableBytes).toBe(100);
    expect(scan.physicalFiles).toHaveLength(2);
  });

  it('huérfano joven (<24h) => omitido por antigüedad', async () => {
    fsMock.readdir.mockResolvedValue(['young.png']);
    mockLstatByFile({ 'young.png': () => fileStats({ ageHours: 2 }) });

    const scan = await scanUploadOrphans();

    expect(scan.orphanCandidates).toHaveLength(0);
    expect(scan.skippedByAge.map((s) => s.filename)).toEqual(['young.png']);
  });

  it('symlink y no-regular => omitidos por seguridad', async () => {
    fsMock.readdir.mockResolvedValue(['linked.png', 'folder.png']);
    mockLstatByFile({
      'linked.png': () => symlinkStats(),
      'folder.png': () => dirStats(),
    });

    const scan = await scanUploadOrphans();

    expect(scan.skippedUnsafe.map((s) => s.filename)).toEqual(['linked.png', 'folder.png']);
    expect(scan.skippedUnsafe[0].reason).toContain('symlink');
    expect(scan.orphanCandidates).toHaveLength(0);
  });

  it('directorio inexistente (ENOENT) => inventario vacío, sin error', async () => {
    fsMock.readdir.mockRejectedValue(Object.assign(new Error('no dir'), { code: 'ENOENT' }));
    const scan = await scanUploadOrphans();
    expect(scan.physicalFiles).toHaveLength(0);
    expect(scan.errors).toHaveLength(0);
  });
});

describe('deleteUploadOrphans — borrado físico con garantías', () => {
  it('huérfano viejo no referenciado => unlink EXACTAMENTE dentro de uploads', async () => {
    fsMock.readdir.mockResolvedValue(['old.png']);
    mockLstatByFile({ 'old.png': () => fileStats({ ageHours: 72, size: 500 }) });
    queueInventories(new Set(['referenced.png']), new Set(['referenced.png'])); // scan + recheck

    const report = await deleteUploadOrphans();

    expect(report.mode).toBe('delete');
    expect(report.deleted).toEqual([{ filename: 'old.png', size: 500 }]);
    expect(report.freedBytes).toBe(500);
    expect(fsMock.unlink).toHaveBeenCalledTimes(1);
    expect(fsMock.unlink).toHaveBeenCalledWith(join(uploadsDir, 'old.png'));
  });

  it('referencia aparece en re-check => SKIP y unlink NUNCA se ejecuta', async () => {
    fsMock.readdir.mockResolvedValue(['victim.png']);
    mockLstatByFile({ 'victim.png': () => fileStats({ ageHours: 72 }) });
    // 1er inventario (scan): vacío => candidato. 2do (re-check inmediato): ¡referenciada!
    queueInventories(new Set(), new Set(['victim.png']));

    const report = await deleteUploadOrphans();

    expect(report.deleted).toHaveLength(0);
    expect(report.skipped).toEqual([
      { filename: 'victim.png', reason: 'referencia apareció en re-check: NO se borra' },
    ]);
    expect(fsMock.unlink).not.toHaveBeenCalled();
  });

  it('referenciado desde el scan => ni siquiera llega a candidato', async () => {
    fsMock.readdir.mockResolvedValue(['live.png']);
    mockLstatByFile({ 'live.png': () => fileStats({ ageHours: 72 }) });
    inventoryState.fallback = new Set(['live.png']);

    const report = await deleteUploadOrphans();

    expect(report.deleted).toHaveLength(0);
    expect(fsMock.unlink).not.toHaveBeenCalled();
  });

  it('<24h => skip aunque el caller pida minAgeHours menor (piso fijo)', async () => {
    fsMock.readdir.mockResolvedValue(['young.png']);
    mockLstatByFile({ 'young.png': () => fileStats({ ageHours: 5 }) });

    const scan = await scanUploadOrphans({ minAgeHours: 1 });
    expect(scan.orphanCandidates).toHaveLength(0);
    expect(scan.skippedByAge[0].filename).toBe('young.png');

    fsMock.readdir.mockResolvedValue(['young.png']);
    const report = await deleteUploadOrphans({ minAgeHours: 1 });
    expect(report.minAgeHours).toBe(24);
    expect(report.deleted).toHaveLength(0);
    expect(fsMock.unlink).not.toHaveBeenCalled();
  });

  it('symlink en re-check lstat => skip (no se sigue ni se borra)', async () => {
    fsMock.readdir.mockResolvedValue(['linked.png']);
    // scan: lstat del mismo path devuelve symlink => skippedUnsafe, nunca candidato.
    mockLstatByFile({ 'linked.png': () => symlinkStats() });

    const report = await deleteUploadOrphans();

    expect(report.deleted).toHaveLength(0);
    expect(report.skipped).toHaveLength(0);
    expect(fsMock.unlink).not.toHaveBeenCalled();
  });

  it('archivo desaparece entre scan y borrado (lstat ENOENT) => skip idempotente (no throw)', async () => {
    fsMock.readdir.mockResolvedValue(['ghost.png']);
    fsMock.lstat
      .mockResolvedValueOnce(fileStats({ ageHours: 48 })) // scan: sí existe
      .mockRejectedValueOnce(Object.assign(new Error('vanished'), { code: 'ENOENT' })); // delete: ya no
    queueInventories(new Set(), new Set());

    const report = await deleteUploadOrphans();

    expect(report.deleted).toHaveLength(0);
    expect(report.errors).toHaveLength(0);
    expect(report.skipped[0].reason).toContain('ENOENT');
    expect(fsMock.unlink).not.toHaveBeenCalled();
  });

  it('archivo con ENOENT desde el scan => simplemente no existe en el inventario', async () => {
    fsMock.readdir.mockResolvedValue(['ghost.png']);
    mockLstatByFile({}); // nada en el mapa => ENOENT

    const scan = await scanUploadOrphans();

    expect(scan.physicalFiles).toHaveLength(0);
    expect(scan.orphanCandidates).toHaveLength(0);
    expect(scan.errors).toHaveLength(0);
    expect(fsMock.unlink).not.toHaveBeenCalled();
  });

  it('unlink ENOENT => idempotente, sin error', async () => {
    fsMock.readdir.mockResolvedValue(['gone.png']);
    mockLstatByFile({ 'gone.png': () => fileStats({ ageHours: 48 }) });
    queueInventories(new Set(), new Set());
    fsMock.unlink.mockRejectedValueOnce(Object.assign(new Error('vanished'), { code: 'ENOENT' }));

    const report = await deleteUploadOrphans();

    expect(report.deleted).toHaveLength(0);
    expect(report.errors).toHaveLength(0);
    expect(report.skipped[0].reason).toContain('ENOENT');
  });

  it('unlink con error real (EACCES) => reportado en errors, continúa sin throw', async () => {
    fsMock.readdir.mockResolvedValue(['locked.png']);
    mockLstatByFile({ 'locked.png': () => fileStats({ ageHours: 48 }) });
    queueInventories(new Set(), new Set());
    fsMock.unlink.mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }));

    const report = await deleteUploadOrphans();

    expect(report.deleted).toHaveLength(0);
    expect(report.errors).toEqual([{ filename: 'locked.png', error: 'EACCES' }]);
  });
});
