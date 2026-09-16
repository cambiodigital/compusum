import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';

/**
 * Fase 6 — RESOLVER CANÓNICO DE REFERENCIAS MULTIMEDIA.
 *
 * Garantías: reconoce las referencias internas /uploads/<filename> de todos
 * los campos DB con media (ProductImage.imagePath/thumbnailPath, Category.image,
 * Brand.logo, Season.image, Banner.imageDesktop/imageMobile, Setting.value
 * conservador), deduplica URLs compartidas por varias entidades y NUNCA
 * considera candidata física una URL externa, data:/blob: ni traversal.
 */

const mockDb = vi.hoisted(() => ({
  productImage: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  category: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  brand: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  season: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  banner: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
  setting: { findMany: vi.fn(async (): Promise<unknown[]> => []) },
}));

vi.mock('@/lib/db', () => ({ db: mockDb }));

import {
  collectMediaReferences,
  extractUploadFilename,
  isInternalUploadUrl,
  isUploadFilenameReferenced,
  resolveUploadFilePath,
} from '@/lib/media-references';
import { getUploadsDirectory } from '@/lib/media-storage';

beforeEach(() => {
  mockDb.productImage.findMany.mockResolvedValue([]);
  mockDb.category.findMany.mockResolvedValue([]);
  mockDb.brand.findMany.mockResolvedValue([]);
  mockDb.season.findMany.mockResolvedValue([]);
  mockDb.banner.findMany.mockResolvedValue([]);
  mockDb.setting.findMany.mockResolvedValue([]);
});

describe('extractUploadFilename — reconocimiento seguro', () => {
  it('URL canónica /uploads/<filename> => filename', () => {
    expect(extractUploadFilename('/uploads/foto-abc.png')).toBe('foto-abc.png');
    expect(extractUploadFilename('/uploads/foto-abc.png?v=2#x')).toBe('foto-abc.png');
  });

  it('URL absoluta del propio origen con path /uploads/ => filename (fallo seguro: sobre-incluye)', () => {
    expect(extractUploadFilename('https://compusum.com/uploads/foto.png')).toBe('foto.png');
  });

  it('bare filename legacy sin esquema ni separadores => filename', () => {
    expect(extractUploadFilename('foto-abc.png')).toBe('foto-abc.png');
  });

  it('URL externa NO /uploads => null (nunca candidata física)', () => {
    expect(extractUploadFilename('https://images.ejemplo.com/foto.png')).toBeNull();
  });

  it('URL externa con path /uploads => sobre-inclusión segura (impide borrado, jamás lo causa)', () => {
    // new URL normaliza ../: cualquier host con path /uploads/ se trata como
    // referencia viva. Dirección del fallo seguro: de más, nunca de menos.
    expect(extractUploadFilename('http://evil.com/../uploads/x.png')).toBe('x.png');
  });

  it('data: y blob: => null', () => {
    expect(extractUploadFilename('data:image/png;base64,AAAA')).toBeNull();
    expect(extractUploadFilename('blob:https://app/uuid')).toBeNull();
  });

  it('traversal rechazado: .., separadores y %2F decodificado', () => {
    expect(extractUploadFilename('/uploads/../../etc/passwd')).toBeNull();
    expect(extractUploadFilename('/uploads/sub/dir/foto.png')).toBeNull();
    expect(extractUploadFilename('/uploads/..%2F..%2Fevil.png')).toBeNull();
    expect(extractUploadFilename('..\\..\\foto.png')).toBeNull();
    expect(extractUploadFilename('/uploads/.')).toBeNull();
    expect(extractUploadFilename('/uploads/..')).toBeNull();
  });

  it('valores no-string/vacíos => null', () => {
    expect(extractUploadFilename(null)).toBeNull();
    expect(extractUploadFilename(undefined)).toBeNull();
    expect(extractUploadFilename(42)).toBeNull();
    expect(extractUploadFilename('')).toBeNull();
    expect(extractUploadFilename('   ')).toBeNull();
  });
});

describe('isInternalUploadUrl', () => {
  it('solo /uploads/<filename> estricto es URL interna', () => {
    expect(isInternalUploadUrl('/uploads/foto.png')).toBe(true);
    expect(isInternalUploadUrl('https://x.com/uploads/foto.png')).toBe(false);
    expect(isInternalUploadUrl('data:image/png;base64,AA')).toBe(false);
    expect(isInternalUploadUrl('/uploads/')).toBe(false);
    expect(isInternalUploadUrl('/other/foto.png')).toBe(false);
  });
});

describe('resolveUploadFilePath — contención en getUploadsDirectory()', () => {
  it('filename seguro => join(uploadsDir, filename)', () => {
    const path = resolveUploadFilePath('foto-abc.png');
    expect(path).toBe(join(getUploadsDirectory(), 'foto-abc.png'));
  });

  it('filename inseguro/traversal => null (única puerta hacia unlink)', () => {
    expect(resolveUploadFilePath('../escape.png')).toBeNull();
    expect(resolveUploadFilePath('a/b.png')).toBeNull();
    expect(resolveUploadFilePath('..')).toBeNull();
    expect(resolveUploadFilePath('')).toBeNull();
  });
});

describe('collectMediaReferences — inventario vivo', () => {
  it('referencia ProductImage (imagePath y thumbnailPath)', async () => {
    mockDb.productImage.findMany.mockResolvedValue([
      { imagePath: '/uploads/a.png', thumbnailPath: '/uploads/a-thumb.png' },
    ]);
    const inv = await collectMediaReferences();
    expect(inv.filenames.has('a.png')).toBe(true);
    expect(inv.filenames.has('a-thumb.png')).toBe(true);
    expect(inv.sources.get('a.png')).toContain('ProductImage.imagePath');
  });

  it('referencias Category.image, Brand.logo y Season.image', async () => {
    mockDb.category.findMany.mockResolvedValue([{ image: '/uploads/cat.png' }]);
    mockDb.brand.findMany.mockResolvedValue([{ logo: '/uploads/brand.png' }]);
    mockDb.season.findMany.mockResolvedValue([{ image: '/uploads/season.png' }]);
    const inv = await collectMediaReferences();
    expect(inv.filenames.has('cat.png')).toBe(true);
    expect(inv.filenames.has('brand.png')).toBe(true);
    expect(inv.filenames.has('season.png')).toBe(true);
  });

  it('referencias Banner.imageDesktop e imageMobile', async () => {
    mockDb.banner.findMany.mockResolvedValue([
      { imageDesktop: '/uploads/banner-desktop.jpg', imageMobile: '/uploads/banner-mobile.jpg' },
      { imageDesktop: '/uploads/banner-solo.jpg', imageMobile: null },
    ]);
    const inv = await collectMediaReferences();
    expect(inv.filenames.has('banner-desktop.jpg')).toBe(true);
    expect(inv.filenames.has('banner-mobile.jpg')).toBe(true);
    expect(inv.filenames.has('banner-solo.jpg')).toBe(true);
  });

  it('Setting.value conservador: /uploads embebida en JSON cuenta como referencia', async () => {
    mockDb.setting.findMany.mockResolvedValue([
      { value: '{"logo_url":"/uploads/logo.png","otros":"texto"}' },
      { value: 'https://app.com/uploads/favicon.ico' },
      { value: 'sin-media-aqui' },
    ]);
    const inv = await collectMediaReferences();
    expect(inv.filenames.has('logo.png')).toBe(true);
    expect(inv.filenames.has('favicon.ico')).toBe(true);
    expect(inv.sources.get('logo.png')).toContain('Setting.value');
  });

  it('misma URL referenciada por VARIAS entidades => un filename con múltiples orígenes', async () => {
    mockDb.productImage.findMany.mockResolvedValue([{ imagePath: '/uploads/compartida.png', thumbnailPath: null }]);
    mockDb.category.findMany.mockResolvedValue([{ image: '/uploads/compartida.png' }]);
    const inv = await collectMediaReferences();
    expect(inv.filenames.has('compartida.png')).toBe(true);
    expect(inv.sources.get('compartida.png')).toEqual([
      'ProductImage.imagePath',
      'Category.image',
    ]);
  });

  it('URL externa / data: / traversal NO son candidatos físicos', async () => {
    mockDb.productImage.findMany.mockResolvedValue([
      { imagePath: 'https://externa.com/foto.png', thumbnailPath: 'data:image/png;base64,AA' },
    ]);
    mockDb.category.findMany.mockResolvedValue([{ image: '/uploads/../../etc.png' }]);
    const inv = await collectMediaReferences();
    expect(inv.filenames.size).toBe(0);
    expect(inv.filenames.has('foto.png')).toBe(false);
    expect(inv.filenames.has('etc.png')).toBe(false);
  });

  it('valores null/vacíos se escanean sin generar referencias', async () => {
    mockDb.productImage.findMany.mockResolvedValue([{ imagePath: '/uploads/x.png', thumbnailPath: null }]);
    mockDb.brand.findMany.mockResolvedValue([{ logo: null }]);
    const inv = await collectMediaReferences();
    expect(inv.filenames).toEqual(new Set(['x.png']));
    expect(inv.scannedValues).toBeGreaterThanOrEqual(3);
  });
});

describe('isUploadFilenameReferenced — re-check previo al unlink', () => {
  it('true si el inventario la contiene; true (fallo seguro) si el filename es dudoso', async () => {
    mockDb.category.findMany.mockResolvedValue([{ image: '/uploads/cat.png' }]);
    expect(await isUploadFilenameReferenced('cat.png')).toBe(true);
    expect(await isUploadFilenameReferenced('otra.png')).toBe(false);
    expect(await isUploadFilenameReferenced('../evil.png')).toBe(true);
  });
});
