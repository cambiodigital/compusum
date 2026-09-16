import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Fase 6 — RBAC y cableado de /api/admin/upload/orphans.
 *
 *  - GET  = DRY-RUN: admin/editor pueden; nunca invoca borrado.
 *  - POST = borrado físico SOLO con rol `admin` estricto y
 *    {"mode":"delete"} explícito; editor/AGENT/CUSTOMER/anónimo => rechazo.
 *  - Los errores internos son 500 sin filtrar stack.
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

const cleanupMock = vi.hoisted(() => ({
  scanUploadOrphans: vi.fn(),
  deleteUploadOrphans: vi.fn(),
}));

vi.mock('@/lib/media-orphan-cleanup', () => ({
  MIN_ORPHAN_AGE_HOURS: 24,
  normalizeMinAgeHours: (n?: number) => Math.max(24, n ?? 24),
  scanUploadOrphans: cleanupMock.scanUploadOrphans,
  deleteUploadOrphans: cleanupMock.deleteUploadOrphans,
}));

import { GET, POST } from '@/app/api/admin/upload/orphans/route';

const ADMIN = { id: 'u1', name: 'Admin', email: 'a@x.test', role: 'admin' };

function post(body: unknown) {
  return POST(
    new Request('http://localhost/api/admin/upload/orphans', {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    })
  );
}

const DRY_RUN_REPORT = {
  uploadsDir: '/app/public/uploads',
  physicalFiles: [],
  referencedFilenames: [],
  orphanCandidates: [],
  recoverableBytes: 0,
  skippedByAge: [],
  skippedUnsafe: [],
  errors: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  authState.currentUser = ADMIN;
  cleanupMock.scanUploadOrphans.mockResolvedValue(DRY_RUN_REPORT);
  cleanupMock.deleteUploadOrphans.mockResolvedValue({
    mode: 'delete',
    minAgeHours: 24,
    deleted: [],
    skipped: [],
    errors: [],
    freedBytes: 0,
  });
});

describe('GET /api/admin/upload/orphans — dry-run seguro', () => {
  it('anónimo => 401 y NUNCA escanea ni borra', async () => {
    authState.currentUser = null;
    const res = await GET();
    expect(res.status).toBe(401);
    expect(cleanupMock.scanUploadOrphans).not.toHaveBeenCalled();
    expect(cleanupMock.deleteUploadOrphans).not.toHaveBeenCalled();
  });

  it('AGENT => 403', async () => {
    authState.currentUser = { ...ADMIN, role: 'AGENT' };
    const res = await GET();
    expect(res.status).toBe(403);
    expect(cleanupMock.scanUploadOrphans).not.toHaveBeenCalled();
  });

  it('CUSTOMER => 403', async () => {
    authState.currentUser = { ...ADMIN, role: 'CUSTOMER' };
    expect((await GET()).status).toBe(403);
  });

  it('editor => 200 dry-run y NUNCA borra', async () => {
    authState.currentUser = { ...ADMIN, role: 'editor' };
    const res = await GET();
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.mode).toBe('dry-run');
    expect(cleanupMock.scanUploadOrphans).toHaveBeenCalledTimes(1);
    expect(cleanupMock.deleteUploadOrphans).not.toHaveBeenCalled();
  });

  it('fallo interno del scan => 500 con success=false', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    cleanupMock.scanUploadOrphans.mockRejectedValue(new Error('disk exploded'));
    try {
      const res = await GET();
      expect(res.status).toBe(500);
      expect((await res.json()).success).toBe(false);
    } finally {
      consoleError.mockRestore();
    }
  });
});

describe('POST /api/admin/upload/orphans — borrado físico restringido', () => {
  it('anónimo => 401 y cero borrados', async () => {
    authState.currentUser = null;
    const res = await post({ mode: 'delete' });
    expect(res.status).toBe(401);
    expect(cleanupMock.deleteUploadOrphans).not.toHaveBeenCalled();
  });

  it('AGENT => 403 aunque pida mode delete', async () => {
    authState.currentUser = { ...ADMIN, role: 'AGENT' };
    expect((await post({ mode: 'delete' })).status).toBe(403);
    expect(cleanupMock.deleteUploadOrphans).not.toHaveBeenCalled();
  });

  it('CUSTOMER => 403', async () => {
    authState.currentUser = { ...ADMIN, role: 'CUSTOMER' };
    expect((await post({ mode: 'delete' })).status).toBe(403);
    expect(cleanupMock.deleteUploadOrphans).not.toHaveBeenCalled();
  });

  it('editor => 403: el borrado físico es SOLO admin', async () => {
    authState.currentUser = { ...ADMIN, role: 'editor' };
    const res = await post({ mode: 'delete' });
    expect(res.status).toBe(403);
    expect(cleanupMock.deleteUploadOrphans).not.toHaveBeenCalled();
  });

  it('admin SIN mode delete => 400 (acción destructiva exige explícito)', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ mode: 'dry-run' })).status).toBe(400);
    expect(cleanupMock.deleteUploadOrphans).not.toHaveBeenCalled();
  });

  it('admin con {"mode":"delete"} => 200 y delega en el cleanup con garantías', async () => {
    const res = await post({ mode: 'delete' });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.mode).toBe('delete');
    expect(cleanupMock.deleteUploadOrphans).toHaveBeenCalledTimes(1);
  });

  it('admin con minAgeHours menor => se pasa tal cual; el piso 24 lo aplica el cleanup', async () => {
    await post({ mode: 'delete', minAgeHours: 1 });
    expect(cleanupMock.deleteUploadOrphans).toHaveBeenCalledWith({ minAgeHours: 1 });
  });

  it('cuerpo inválido (no JSON) => 400 sin borrar', async () => {
    const res = await post('not-json{{{');
    expect(res.status).toBe(400);
    expect(cleanupMock.deleteUploadOrphans).not.toHaveBeenCalled();
  });

  it('fallo interno del borrado => 500 sin filtrar stack', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    cleanupMock.deleteUploadOrphans.mockRejectedValue(new Error('boom'));
    try {
      const res = await post({ mode: 'delete' });
      expect(res.status).toBe(500);
      const json = await res.json();
      expect(json.success).toBe(false);
      expect(JSON.stringify(json)).not.toContain('boom');
    } finally {
      consoleError.mockRestore();
    }
  });
});
