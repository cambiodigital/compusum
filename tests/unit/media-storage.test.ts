import { describe, it, expect } from 'vitest';
import { join, resolve, sep } from 'node:path';

/**
 * F6A — contrato de almacenamiento multimedia (src/lib/media-storage.ts).
 *
 * El par (path físico, URL pública) es un contrato FIJO:
 *   URL:    /uploads/<filename>
 *   Path:   <cwd>/public/uploads   (en Docker: /app/public/uploads)
 *
 * Deliberadamente no existe configuración por entorno capaz de desviar el
 * path: estos tests lo fijan para que ninguna evolución lo rompa sin
 * actualizarse aquí a propósito.
 */

import { getUploadPublicUrl, getUploadsDirectory } from '@/lib/media-storage';

describe('getUploadsDirectory (F6A)', () => {
  it('resuelve <cwd>/public/uploads', () => {
    expect(getUploadsDirectory()).toBe(join(process.cwd(), 'public', 'uploads'));
  });

  it('termina exactamente en public/uploads con separadores nativos', () => {
    const resolved = resolve(getUploadsDirectory());
    expect(resolved.endsWith(`public${sep}uploads`) || resolved.endsWith('/public/uploads')).toBe(
      true
    );
  });

  it('es un path absoluto', () => {
    expect(resolve(getUploadsDirectory())).toBe(getUploadsDirectory());
  });

  it('ninguna variable de entorno puede desviar arbitrariamente el path', () => {
    const envKeys = [
      'MEDIA_STORAGE_DIR',
      'UPLOADS_DIR',
      'UPLOAD_DIR',
      'MEDIA_DIR',
      'STORAGE_DIR',
      'NEXT_PUBLIC_UPLOADS_DIR',
    ];
    const before = getUploadsDirectory();
    const original: Record<string, string | undefined> = {};
    for (const key of envKeys) {
      original[key] = process.env[key];
      process.env[key] = '/tmp/ataque-storage';
    }
    try {
      expect(getUploadsDirectory()).toBe(before);
    } finally {
      for (const key of envKeys) {
        if (original[key] === undefined) delete process.env[key];
        else process.env[key] = original[key];
      }
    }
  });
});

describe('getUploadPublicUrl (F6A)', () => {
  it('construye /uploads/<filename> exacto', () => {
    expect(getUploadPublicUrl('escolar-abc-123.png')).toBe('/uploads/escolar-abc-123.png');
  });

  it('no antepone dominio ni altera el nombre', () => {
    expect(getUploadPublicUrl('Bic-00000000-0000-4000-8000-000000000000.webp')).toBe(
      '/uploads/Bic-00000000-0000-4000-8000-000000000000.webp'
    );
  });
});
