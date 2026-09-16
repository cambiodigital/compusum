import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Fase 7 — serving dinámico de /uploads/<filename>.
 *
 * Next indexa public/ sólo al arranque: sin este handler, un upload hecho
 * después de iniciar el servidor daba 404 hasta reiniciar el contenedor.
 * El handler debe: servir el archivo desde el directorio canónico con el
 * content-type correcto, rechazar traversal/subdirectorios/extensiones no
 * permitidas y devolver 404 sin filtrar rutas.
 */

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'compusum-uploads-serving-'));
mkdirSync(path.join(tmpDir, 'subdir'), { recursive: true });
writeFileSync(path.join(tmpDir, 'imagen-ok.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
writeFileSync(path.join(tmpDir, 'documento.pdf'), Buffer.from('%PDF'));
writeFileSync(path.join(tmpDir, 'subdir', 'anidado.png'), Buffer.from('x'));

vi.mock('@/lib/media-storage', () => ({
  getUploadsDirectory: () => tmpDir,
}));

import { GET } from '@/app/uploads/[filename]/route';

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function makeParams(filename: string) {
  return { params: Promise.resolve({ filename }) };
}

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('GET /uploads/[filename] (serving dinámico)', () => {
  it('sirve un archivo existente con content-type de imagen y cache inmutable', async () => {
    const res = await GET({} as any, makeParams('imagen-ok.png'));
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toContain('immutable');
    const body = new Uint8Array(await res.arrayBuffer());
    expect(body).toEqual(PNG_BYTES);
  });

  it('404 para archivos inexistentes sin filtrar el path', async () => {
    const res = await GET({} as any, makeParams('no-existe.png'));
    expect(res.status).toBe(404);
    expect(JSON.stringify(await res.json())).not.toContain(tmpDir);
  });

  it('404 para traversal y subdirectorios', async () => {
    for (const evil of ['..%2F..%2Fetc.png', '../etc.png', 'subdir/anidado.png', '.hidden.png']) {
      const res = await GET({} as any, makeParams(evil));
      expect(res.status).toBe(404);
    }
  });

  it('404 para extensiones fuera de la allowlist de imágenes', async () => {
    const res = await GET({} as any, makeParams('documento.pdf'));
    expect(res.status).toBe(404);
  });
});
