import { describe, it, expect, vi, beforeEach } from 'vitest';
import { join, basename } from 'node:path';

/**
 * Contrato del endpoint de upload (/api/admin/upload).
 *
 * F6A: el endpoint DEBE escribir en el directorio centralizado por
 * '@/lib/media-storage' (getUploadsDirectory) y devolver URLs
 * '/uploads/<filename>' sin cambiar RBAC, allowlist MIME, límite de 5MB,
 * naming UUID ni autoAssignBySku.
 *
 * F6B1: además, el CONTENIDO es la autoridad del formato (magic bytes).
 * El MIME declarado deja de ser suficiente: contenido indetectable o
 * mismatch declarado-vs-real se rechaza sin escribir nada; la extensión
 * persistida proviene del formato detectado; y si la autoasignación DB
 * falla, se compensa (unlink) EXCLUSIVAMENTE el archivo que la petición
 * acaba de crear.
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
  // (...args: unknown[]): permite indexar mock.calls[n][m] sin errores de
  // tupla vacía en tsc estricto.
  writeFile: vi.fn(async (..._args: unknown[]) => undefined),
  readdir: vi.fn(async () => [] as string[]),
  stat: vi.fn(async () => ({ size: 123, mtime: new Date('2026-01-01T00:00:00Z') })),
  unlink: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock('fs/promises', () => ({
  mkdir: fsMock.mkdir,
  writeFile: fsMock.writeFile,
  readdir: fsMock.readdir,
  stat: fsMock.stat,
  unlink: fsMock.unlink,
  default: {
    mkdir: fsMock.mkdir,
    writeFile: fsMock.writeFile,
    readdir: fsMock.readdir,
    stat: fsMock.stat,
    unlink: fsMock.unlink,
  },
}));

import { GET, POST } from '@/app/api/admin/upload/route';
import { getUploadPublicUrl, getUploadsDirectory } from '@/lib/media-storage';

// ---- Fixtures F6B1: contenido con magic bytes REALES del formato declarado.
// Antes de F6B1 los fixtures eran buffers en cero: hoy eso es contenido
// inválido por diseño. Toda subida "válida" de estos tests lleva su firma.

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const JPEG_SIGNATURE = [0xff, 0xd8, 0xff, 0xe0];

function signedBytes(signature: number[], size: number): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(Math.max(size, signature.length));
  bytes.set(signature, 0);
  return bytes;
}

function gifBytes(size = 64, variant: '87a' | '89a' = '89a'): Uint8Array<ArrayBuffer> {
  const header = `GIF${variant}`;
  const bytes = new Uint8Array(Math.max(size, header.length + 4));
  for (let i = 0; i < header.length; i += 1) bytes[i] = header.charCodeAt(i);
  bytes[header.length] = 0x01;
  return bytes;
}

function webpBytes(size = 64): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(Math.max(size, 16));
  const riff = 'RIFF';
  const webp = 'WEBP';
  for (let i = 0; i < 4; i += 1) bytes[i] = riff.charCodeAt(i);
  for (let i = 0; i < 4; i += 1) bytes[8 + i] = webp.charCodeAt(i);
  return bytes;
}

function validContentFor(type: string, size: number): Uint8Array<ArrayBuffer> {
  switch (type) {
    case 'image/jpeg':
      return signedBytes(JPEG_SIGNATURE, size);
    case 'image/gif':
      return gifBytes(size);
    case 'image/webp':
      return webpBytes(size);
    default:
      // PNG por defecto (y para tipos NO permitidos: esos se rechazan por
      // allowlist antes de leer contenido, así que el buffer es indiferente).
      return signedBytes(PNG_SIGNATURE, size);
  }
}

function makeForm(
  files: Array<{ name: string; type: string; size: number; content?: Uint8Array<ArrayBuffer> }>,
  fields: Record<string, string> = {}
) {
  const form = new FormData();
  for (const f of files) {
    // fileBits DEBE ser [bytes]: un Uint8Array suelto se itera byte a byte y
    // cada número se convierte a string decimal, corrompiendo el contenido.
    form.append('files', new File([f.content ?? validContentFor(f.type, f.size)], f.name, { type: f.type }));
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

  it('CUSTOMER => 403 y CERO escrituras', async () => {
    authState.currentUser = { ...ADMIN, role: 'CUSTOMER' };
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

  it('MIME permitido (image/png) con contenido PNG real => escribe exactamente 1 archivo', async () => {
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

  it('> 5MB => rechazado sin escribir nada (y sin leer contenido)', async () => {
    // File con size sobreescrito entregado SIN round-trip de serialización
    // (stub de request.formData()): el route rechaza por file.size y así el
    // test no serializa 5MB reales.
    const fakeBig = new File([new Uint8Array(1)], 'grande.png', { type: 'image/png' });
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

describe('F6B1 — validación binaria real (el contenido es la autoridad)', () => {
  it('JPEG real + MIME image/jpeg => éxito con extensión .jpg', async () => {
    const res = await post(makeForm([{ name: 'foto.jpg', type: 'image/jpeg', size: 512 }]));
    const json = await res.json();
    expect(json.data.uploadedCount).toBe(1);
    expect(json.data.errors).toEqual([]);
    expect(json.data.uploaded[0].fileName).toMatch(/\.jpg$/);
    expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
  });

  it('WebP real + MIME image/webp => éxito con extensión .webp', async () => {
    const res = await post(makeForm([{ name: 'foto.webp', type: 'image/webp', size: 256 }]));
    const json = await res.json();
    expect(json.data.uploadedCount).toBe(1);
    expect(json.data.uploaded[0].fileName).toMatch(/\.webp$/);
  });

  it('GIF89a real + MIME image/gif => éxito con extensión .gif', async () => {
    const res = await post(makeForm([{ name: 'foto.gif', type: 'image/gif', size: 128 }]));
    const json = await res.json();
    expect(json.data.uploadedCount).toBe(1);
    expect(json.data.uploaded[0].fileName).toMatch(/\.gif$/);
  });

  it('GIF87a real también aceptado', async () => {
    const res = await post(makeForm([{ name: 'viejo.gif', type: 'image/gif', size: 128, content: gifBytes(128, '87a') }]));
    const json = await res.json();
    expect(json.data.uploadedCount).toBe(1);
  });

  it('MIME permitido pero bytes inválidos (todo ceros) => rechazado sin escribir', async () => {
    const res = await post(
      makeForm([{ name: 'falso.png', type: 'image/png', size: 300, content: new Uint8Array(300) }])
    );
    const json = await res.json();
    expect(json.data.uploadedCount).toBe(0);
    expect(json.data.errors[0]).toContain('falso.png');
    expect(json.data.errors[0]).toContain('no es una imagen válida');
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it('MIME image/png con bytes JPEG => RECHAZO por mismatch (no se corrige en silencio)', async () => {
    const res = await post(
      makeForm([{ name: 'camuflado.png', type: 'image/png', size: 256, content: signedBytes(JPEG_SIGNATURE, 256) }])
    );
    const json = await res.json();
    expect(json.data.uploadedCount).toBe(0);
    expect(json.data.errors[0]).toContain('no coincide con el tipo declarado');
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it('foto.jpg con contenido PNG declarado image/jpeg => rechazo por mismatch', async () => {
    const res = await post(
      makeForm([{ name: 'foto.jpg', type: 'image/jpeg', size: 256, content: signedBytes(PNG_SIGNATURE, 256) }])
    );
    const json = await res.json();
    expect(json.data.uploadedCount).toBe(0);
    expect(json.data.errors[0]).toContain('no coincide con el tipo declarado');
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it('bytes SVG con MIME image/png => rechazado (SVG prohibido también por contenido)', async () => {
    const svg = Uint8Array.from(
      '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      (c) => c.charCodeAt(0)
    );
    const res = await post(makeForm([{ name: 'vector.png', type: 'image/png', size: svg.length, content: svg }]));
    const json = await res.json();
    expect(json.data.uploadedCount).toBe(0);
    expect(json.data.errors[0]).toContain('no es una imagen válida');
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it('tipo declarado vacío => rechazado aunque el contenido sea PNG válido', async () => {
    const res = await post(makeForm([{ name: 'sinmime.png', type: '', size: 128 }]));
    const json = await res.json();
    expect(json.data.uploadedCount).toBe(0);
    expect(json.data.errors[0]).toContain('tipo no permitido');
    expect(fsMock.writeFile).not.toHaveBeenCalled();
  });

  it('la extensión final proviene del detector: foto.exe con bytes PNG => se almacena .png', async () => {
    const res = await post(makeForm([{ name: 'foto.exe', type: 'image/png', size: 512 }]));
    const json = await res.json();
    expect(json.data.uploadedCount).toBe(1);
    const uploaded = json.data.uploaded[0];
    expect(uploaded.fileName).toMatch(/^foto-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/i);
    expect(uploaded.fileName).not.toMatch(/\.exe$/i);
  });
});

describe('F6B1 — batches coherentes', () => {
  it('archivo 1 válido + archivo 2 inválido: el lote es coherente y el rechazado NO se escribe', async () => {
    const res = await post(
      makeForm([
        { name: 'bueno.png', type: 'image/png', size: 128 },
        { name: 'malo.png', type: 'image/png', size: 128, content: new Uint8Array(128) },
      ])
    );
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.total).toBe(2);
    expect(json.data.uploadedCount).toBe(1);
    expect(json.data.uploaded[0].originalName).toBe('bueno.png');
    expect(json.data.errors).toHaveLength(1);
    expect(json.data.errors[0]).toContain('malo.png');
    expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
    const [writtenPath] = fsMock.writeFile.mock.calls[0];
    expect(basename(String(writtenPath))).toMatch(/^bueno-/);
  });
});

describe('Cierre F6 — resultado parcial coherente (fallo DB por archivo)', () => {
  /**
   * Residual F6B1: un fallo DB en autoAssign durante un batch provocaba un
   * 500 global que descartaba el resultado parcial (archivos ya subidos) y
   * empujaba a reintentos que duplicaban el lote. Ahora el fallo de ESTA
   * iteración se compensa (unlink exclusivo), va a errors[] y el lote
   * continúa; la respuesta 200 conserva uploaded[]/errors[] coherentes.
   */
  it('writeFile ok + SKU match + productImage.create falla => unlink EXCLUSIVO del archivo generado y error por archivo', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockDb.product.findFirst.mockResolvedValue({ id: 'p1', sku: 'prueba' });
    mockDb.productImage.create.mockRejectedValue(new Error('db explode'));

    const res = await post(makeForm([PNG_1KB], { autoAssignBySku: 'true' }));

    // Resultado parcial coherente: el lote NO aborta con 500.
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.uploadedCount).toBe(0);
    expect(json.data.errors[0]).toContain('prueba.png');
    expect(json.data.errors[0]).toContain('no se pudo autoasignar');

    // Se escribió exactamente un archivo (el generado internamente, con UUID).
    expect(fsMock.writeFile).toHaveBeenCalledTimes(1);
    const writtenPath = fsMock.writeFile.mock.calls[0][0] as string;
    const generated = basename(writtenPath);
    expect(generated).toMatch(/^prueba-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.png$/i);

    // La compensación toca UNICAMENTE join(getUploadsDirectory(), generatedFilename).
    expect(fsMock.unlink).toHaveBeenCalledTimes(1);
    expect(fsMock.unlink).toHaveBeenCalledWith(join(getUploadsDirectory(), generated));
    expect(fsMock.unlink).toHaveBeenCalledWith(writtenPath);
    consoleError.mockRestore();
  });

  it('fallo DB en el archivo actual NO borra archivos exitosos anteriores del lote y los reporta', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockDb.product.findFirst.mockResolvedValue({ id: 'p1', sku: 'lote' });
    mockDb.productImage.create.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('db down'));

    const res = await post(
      makeForm(
        [
          { name: 'uno.png', type: 'image/png', size: 128 },
          { name: 'dos.png', type: 'image/png', size: 128 },
        ],
        { autoAssignBySku: 'true' }
      )
    );

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.uploadedCount).toBe(1);
    expect(json.data.uploaded[0].originalName).toBe('uno.png');
    expect(json.data.errors[0]).toContain('dos.png');
    // Ambos archivos llegaron a escribirse; solo el segundo (fallo DB actual) se compensa.
    expect(fsMock.writeFile).toHaveBeenCalledTimes(2);
    expect(fsMock.unlink).toHaveBeenCalledTimes(1);
    const firstPath = fsMock.writeFile.mock.calls[0][0];
    const secondPath = fsMock.writeFile.mock.calls[1][0];
    expect(fsMock.unlink).toHaveBeenCalledWith(secondPath);
    expect(fsMock.unlink).not.toHaveBeenCalledWith(firstPath);
    consoleError.mockRestore();
  });

  it('writeFile falla => NO se ejecuta DB NI unlink innecesario (500 sistémico intacto)', async () => {
    fsMock.writeFile.mockRejectedValueOnce(new Error('ENOSPC: no space left on device'));

    const res = await post(makeForm([PNG_1KB], { autoAssignBySku: 'true' }));

    expect(res.status).toBe(500);
    expect(mockDb.product.findFirst).not.toHaveBeenCalled();
    expect(mockDb.productImage.create).not.toHaveBeenCalled();
    expect(fsMock.unlink).not.toHaveBeenCalled();
  });

  it('autoAssignBySku false => SIN lógica DB ni cleanup aunque la DB esté rota', async () => {
    mockDb.product.findFirst.mockRejectedValue(new Error('db should never be reached'));
    mockDb.productImage.create.mockRejectedValue(new Error('db should never be reached'));

    const res = await post(makeForm([PNG_1KB])); // sin autoAssignBySku

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.uploadedCount).toBe(1);
    expect(mockDb.product.findFirst).not.toHaveBeenCalled();
    expect(mockDb.productImage.create).not.toHaveBeenCalled();
    expect(fsMock.unlink).not.toHaveBeenCalled();
  });

  it('cleanup falla (no ENOENT) => se registra y el lote continúa con error por archivo', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    mockDb.product.findFirst.mockResolvedValue({ id: 'p1', sku: 'prueba' });
    mockDb.productImage.create.mockRejectedValue(new Error('db explode'));
    fsMock.unlink.mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));

    const res = await post(makeForm([PNG_1KB], { autoAssignBySku: 'true' }));

    // El fallo de limpieza no se oculta (console.error) pero tampoco aborta el lote.
    expect(res.status).toBe(200);
    expect(fsMock.unlink).toHaveBeenCalledTimes(1);
    expect(consoleError).toHaveBeenCalled();
    expect((await res.json()).data.errors[0]).toContain('no se pudo autoasignar');
    consoleError.mockRestore();
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
