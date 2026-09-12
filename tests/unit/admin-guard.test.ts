import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * FASE 4A — guardias REALES de src/lib/auth.ts (requireAdminApi /
 * requireBackofficeApi) con cookies de next/headers y lookup de sesión en db
 * mockeados. Las suites de rutas mockean los guardias: aquí se cubre la
 * implementación real para que una regresión dentro de ellos no pase inadvertida.
 */

const cookieStore = vi.hoisted(() => new Map<string, { value: string }>());

vi.mock('next/headers', () => ({
  cookies: vi.fn(async () => ({
    get: (name: string) => cookieStore.get(name),
  })),
}));

const mockDb = vi.hoisted(() => ({
  session: {
    findUnique: vi.fn(),
    delete: vi.fn(),
  },
  user: {
    findUnique: vi.fn(),
  },
}));

vi.mock('@/lib/db', () => ({ db: mockDb }));

import { requireAdminApi, requireBackofficeApi } from '@/lib/auth';

const SESSION_TOKEN = 'token-de-sesion';
const FUTURE = new Date(Date.now() + 60 * 60 * 1000);

function seedSession(user: {
  id: string;
  name: string;
  email: string;
  role: string;
  isActive: boolean;
} | null) {
  cookieStore.set('session_token', { value: SESSION_TOKEN });
  mockDb.session.findUnique.mockResolvedValue(
    user ? { token: SESSION_TOKEN, userId: user.id, expiresAt: FUTURE } : null
  );
  mockDb.user.findUnique.mockResolvedValue(user);
}

beforeEach(() => {
  vi.clearAllMocks();
  cookieStore.clear();
});

describe('requireAdminApi / requireBackofficeApi (implementaciones reales)', () => {
  it('sin cookie de sesión => 401 "No autorizado" en ambos guardias', async () => {
    const admin = await requireAdminApi();
    expect(admin.error).not.toBeNull();
    expect(admin.user).toBeNull();
    expect(admin.error!.status).toBe(401);
    expect((await admin.error!.json())).toEqual({ success: false, error: 'No autorizado' });

    const backoffice = await requireBackofficeApi();
    expect(backoffice.error!.status).toBe(401);
  });

  it('sesión inexistente en DB => 401 en ambos guardias', async () => {
    seedSession(null);

    expect((await requireAdminApi()).error!.status).toBe(401);
    expect((await requireBackofficeApi()).error!.status).toBe(401);
  });

  it('usuario inactivo => 401 (sesión inválida) en ambos guardias', async () => {
    seedSession({ id: 'u1', name: 'X', email: 'x@t.com', role: 'admin', isActive: false });

    expect((await requireAdminApi()).error!.status).toBe(401);
    expect((await requireBackofficeApi()).error!.status).toBe(401);
  });

  it('CUSTOMER => 403 en ambos guardias con el mensaje administrativo', async () => {
    seedSession({ id: 'c1', name: 'Cliente', email: 'c@t.com', role: 'CUSTOMER', isActive: true });

    const admin = await requireAdminApi();
    expect(admin.error!.status).toBe(403);
    expect(await admin.error!.json()).toEqual({
      success: false,
      error: 'Acceso denegado: se requiere rol administrativo',
    });
    expect((await requireBackofficeApi()).error!.status).toBe(403);
  });

  it('AGENT => pasa requireBackofficeApi y es rechazado (403) por requireAdminApi', async () => {
    seedSession({ id: 'a1', name: 'Agente', email: 'a@t.com', role: 'AGENT', isActive: true });

    const backoffice = await requireBackofficeApi();
    expect(backoffice.error).toBeNull();
    expect(backoffice.user).toMatchObject({ id: 'a1', role: 'AGENT' });

    const admin = await requireAdminApi();
    expect(admin.error!.status).toBe(403);
    expect(admin.user).toBeNull();
  });

  it('admin => pasa ambos guardias (acceso global intacto)', async () => {
    seedSession({ id: 'ad1', name: 'Admin', email: 'ad@t.com', role: 'admin', isActive: true });

    const admin = await requireAdminApi();
    expect(admin.error).toBeNull();
    expect(admin.user).toMatchObject({ id: 'ad1', role: 'admin' });

    const backoffice = await requireBackofficeApi();
    expect(backoffice.error).toBeNull();
  });

  it('sesión expirada => se elimina y responde 401 en ambos guardias', async () => {
    cookieStore.set('session_token', { value: SESSION_TOKEN });
    mockDb.session.findUnique.mockResolvedValue({
      token: SESSION_TOKEN,
      userId: 'u9',
      expiresAt: new Date(Date.now() - 1000),
    });

    expect((await requireAdminApi()).error!.status).toBe(401);
    expect(mockDb.session.delete).toHaveBeenCalledWith({ where: { token: SESSION_TOKEN } });
    expect((await requireBackofficeApi()).error!.status).toBe(401);
  });
});
