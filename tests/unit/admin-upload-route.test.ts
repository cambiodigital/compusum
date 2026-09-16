import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join } from 'node:path';

/**
 * F6A — contrato del endpoint de upload (/api/admin/upload).
 *
 * El endpoint DEBE escribir en el directorio centralizado por
 * '@/lib/media-storage' (getUploadsDirectory) y devolver URLs
 * '/uploads/<filename>' sin cambiar RBAC, allowlist MIME, límite de 5MB,
 * naming UUID ni autoAssignBySku.
 *
 * 'fs/promises' se mockea completo: los tests NUNCA escriben en
 * public/uploads del checkout. La db se mockea con el patrón estándar del
 * repo y el guardia replica los predicados reales de '@/lib/roles'.
 */

const authState = vi.hoisted(() => ({
  currentUser: null as { id: string; name: string; email: string | null; role: string } | null,
}));

vi.mock('@/lib/auth', async () => {
  const { NextResponse } = await import('next/server');
  const roles = await import('@/lib/roles');
  return {
    ...roles,
    requireAdminApi: async () => {
      const user = authState.currentUser;
      if (!user) {
        return {
          error: NextResponse.json({ success: false, error: 'No autorizado' }, { status: 401 }),
          user: null,
        };
      }
      if (!roles.isAdminRole(user.role)) {
        return {
          error: NextResponse.json(
            { success: false, error: 'Acceso denegado: se requiere rol administrativo' },
            { status: 403 }
          ),
          user: null,
        };
      }
      return { error: null, user };
    },
  };
});

const mockDb = vi.hoisted(() => ({
  product: {
    findFirst: vi.fn(),
  },
  productImage: {
    count: vi.fn(),
    create: vi.fn(),
  },
}));

vi.mock('@/lib/db', () => ({ db: mockDb }));

const fsMock = vi.hoisted(() => ({
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
  readdir: vi.fn(async () => [] as string[]),
  stat: vi.fn(async () => ({ size: 123, mtime: new Date('2026-01-01T00:00:00Z') })),
}));

vi.mock('fs/promises', () => ({
  mkdir: fsMock.mkdir,
  writeFile: fsMock.writeFile,
  readdir: fsMock.readdir,
  stat: fsMock.stat,
  default: {
    mkdir: fsMock.mkdir,
    writeFile: fsMock.writeFile,
    readdir: fsMock.readdir,
    stat: fsMock.stat,
  },
}));

import { GET, POST } from '@/app/api/admin/upload/route';
import { getUploadPublicUrl, getUploadsDirectory } from '@/lib/media-storage';

function makeForm(files: Array<{ name: string; type: string; size: number }>, fields: Record<string, string> = {}) {
  const form = new FormData();
  for (const f of files) {
    form.append('files', new File(new Uint8Array(f.size), f.name, { type: f.type }));
  }
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  return form;
}

function post(form: FormData) {
  return POST(new Request('http://localhost/api/admin/upload', { method: 'POST', body: form }));
}

const ADMIN = { id: 'u1', name: 'Admin', email: 'admin@compusum.test', role: 'admin' };
const PNG_1KB = { name: 'prueba.png', type: 'image/png', size: 1024 };

beforeEach(() => {
  vi.clearAllMocks();
  authState.currentUser = ADMIN;
  mockDb.product.findFirst.mockResolvedValue(null);
  mockDb.productImage.count.mockResolvedValue(0);
  mockDb.productImage.create.mockResolvedValue({});
  fsMock.readdir.mockResolvedValue([]);
});

describe('POST /api/admin/upload — RBAC (contrato F6A intacto)', () => {
  it('anónimo => 401 y CERO escrituras en disco', async () => {
    authState.currentUser = null;
    const res = await post(makeForm([PNG_1KB]));
    expect(res.status).toBe(401);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it('AGENT => 403 (solo admin/editor suben) y CERO escrituras', async () => {
    authState.currentUser = { ...ADMIN, role: 'AGENT' };
    const res = await post(makeForm([PNG_1KB]));
    expect(res.status).toBe(403);
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it('editor autorizado => 200', async () => {
    authState.currentUser = { ...ADMIN, role: 'editor' };
    const res = await post(makeForm([PNG_1KB]));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.uploadedCount).toBe(1);
  });
});

describe('POST /api/admin/upload — validaciones (contrato F6A intacto)', () => {
  it('sin archivos => 400', async () => {
    const res = await post(makeForm([]));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('No se recibieron archivos');
  });

  it('MIME permitido (image/png) => escribe exactamente 1 archivo', async () => {
    const res = await post(makeForm([PNG_1KB]));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.uploadedCount).toBe(1);
    expect(json.data.errors).toEqual([]);
    expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
  });

  it('MIME no permitido (image/svg+xml) => rechazado sin escribir nada', async () => {
    const res = await post(makeForm([{ name: 'malicioso.svg', type: 'image/svg+xml', size: 100 }]));
    const json = await res.json();
    expect(res.status).toBe(200); // el lote responde, pero el archivo va a errors
    expect(json.data.uploadedCount).toBe(0);
    expect(json.data.errors[0]).toContain('tipo no permitido');
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it('> 5MB => rechazado sin escribir nada', async () => {
    // File con size sobreescrito entregado SIN round-trip de serialización
    // (stub de request.formData()): el route rechaza por file.size y así el
    // test no serializa 5MB reales.
    const fakeBig = new File(new Uint8Array(1), 'grande.png', { type: 'image/png' });
    Object.defineProperty(fakeBig, 'size', { value: 5 * 1024 * 1024 + 1 });
    const form = new FormData();
    form.append('files', fakeBig);
    const stubRequest = { formData: async () => form } as unknown as Request;

    const res = await POST(stubRequest);
    const json = await res.json();
    expect(json.data.uploadedCount).toBe(0);
    expect(json.data.errors[0]).toContain('supera 5MB');
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });
});

describe('POST /api/admin/upload — contrato de storage centralizado (F6A)', () => {
  it('mkdir/writeFile ocurren en getUploadsDirectory() y la URL devuelta es /uploads/<filename>', async () => {
    const res = await post(makeForm([PNG_1KB]));
    const json = await res.json();

    expect(fsMock.mkdir).toHaveBeenCalledWith(getUploadsDirectory(), { recursive: true });

    const uploaded = json.data.uploaded[0];
    expect(uploaded.fileName).toMatch(/^prueba-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/i);
    expect(uploaded.url).toBe(getUploadPublicUrl(uploaded.fileName));
    expect(uploaded.url).toBe(`/uploads/${uploaded.fileName}`);

    expect(fsMock.writeFile).toHaveBeenCalledWith(
      join(getUploadsDirectory(), uploaded.fileName),
      expect.any(Buffer)
    );
  });

  it('el naming saneado no permite path traversal (../../ queda fuera del filename)', async () => {
    const res = await post(makeForm([{ name: '../../evil name.png', type: 'image/png', size: 512 }]));
    const json = await res.json();

    const uploaded = json.data.uploaded[0];
    expect(uploaded.fileName).not.toContain('..');
    expect(uploaded.fileName).not.toContain('/');
    expect(uploaded.fileName).not.toContain('\\');
    expect(uploaded.url).toBe(`/uploads/${uploaded.fileName}`);

    const [writtenPath] = fsMock.writeFile.mock.calls[0];
    expect(writtenPath).toBe(join(getUploadsDirectory(), uploaded.fileName));
  });
});

describe('POST /api/admin/upload — autoAssignBySku (sin regresión)', () => {
  it('match por SKU: crea ProductImage primaria con la URL /uploads normalizada', async () => {
    mockDb.product.findFirst.mockResolvedValue({ id: 'p1', sku: 'abc123' });
    mockDb.productImage.count.mockResolvedValue(0);

    const res = await post(makeForm([PNG_1KB], { autoAssignBySku: 'true' }));
    const json = await res.json();

    expect(json.data.autoAssignedCount).toBe(1);
    expect(mockDb.product.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ sku: { equals: 'prueba.png', mode: 'insensitive' } }, { sku: { equals: 'prueba', mode: 'insensitive' } }],
        }),
      })
    );
    const createArg = mockDb.productImage.create.mock.calls[0][0];
    expect(createArg.data.productId).toBe('p1');
    expect(createArg.data.isPrimary).toBe(true);
    expect(createArg.data.sortOrder).toBe(0);
    expect(createArg.data.imagePath).toBe(json.data.uploaded[0].url);
    expect(createArg.data.imagePath).toMatch(/^\/uploads\//);
  });

  it('producto con imágenes previas: la nueva NO es primaria y usa sortOrder incremental', async () => {
    mockDb.product.findFirst.mockResolvedValue({ id: 'p2', sku: 'abc123' });
    mockDb.productImage.count.mockResolvedValue(2);

    await post(makeForm([PNG_1KB], { autoAssignBySku: 'true' }));

    const createArg = mockDb.productImage.create.mock.calls[0][0];
    expect(createArg.data.isPrimary).toBe(false);
    expect(createArg.data.sortOrder).toBe(2);
  });

  it('sin match de SKU: el archivo se sube igual pero NO se crea ProductImage', async () => {
    const res = await post(makeForm([PNG_1KB], { autoAssignBySku: 'true' }));
    const json = await res.json();
    expect(json.data.autoAssignedCount).toBe(0);
    expect(json.data.uploadedCount).toBe(1);
    expect(mockDb.productImage.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/admin/upload — listado (contrato F6A intacto)', () => {
  it('lista con URLs /uploads/<name> y metadatos', async () => {
    fsMock.readdir.mockResolvedValue(['a.png', 'b.jpg']);

    const res = await GET();
    const json = await res.json();

    expect(json.success).toBe(true);
    expect(json.data.files).toHaveLength(2);
    expect(json.data.files[0].url).toMatch(/^\/uploads\/[ab]\.(png|jpg)$/);
    expect(json.data.files[0].size).toBe(123);
    expect(fsMock.mkdir).toHaveBeenCalledWith(getUploadsDirectory(), { recursive: true });
  });

  it('mantiene el cap de 500 archivos', async () => {
    fsMock.readdir.mockResolvedValue(Array.from({ length: 510 }, (_, i) => `f${i}.png`));

    const res = await GET();
    const json = await res.json();

    expect(json.data.files).toHaveLength(500);
  });
});
