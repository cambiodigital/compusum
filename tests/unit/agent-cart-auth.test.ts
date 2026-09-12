import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockDb = vi.hoisted(() => ({
  user: {
    findUnique: vi.fn(),
  },
}));

vi.mock('@/lib/db', () => ({ db: mockDb }));

import {
  authorizeCartViewer,
  authorizeCartViewerWithOwner,
} from '@/lib/shared-cart';

/**
 * FASE 4A — venta asistida con aislamiento por asesor:
 * el AGENT solo GESTIONA carritos huérfanos/de sesión o de SUS clientes
 * asignados; el carrito de un cliente de OTRO asesor queda denegado.
 * admin/editor siguen gestionando todo; CUSTOMER/invitado sin cambios.
 */

const AGENT_A = { id: 'agent-a', role: 'AGENT' };
const AGENT_B = { id: 'agent-b', role: 'agent' }; // casing mixto de la data real
const ADMIN = { id: 'admin-1', role: 'admin' };

function cart(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: null as string | null,
    userId: null as string | null,
    status: 'activo',
    isActive: true,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('authorizeCartViewerWithOwner: AGENT comercial', () => {
  it('gestiona el carrito de SU cliente asignado', async () => {
    mockDb.user.findUnique.mockResolvedValue({ assignedAgentId: 'agent-a' });

    const access = await authorizeCartViewerWithOwner(
      cart({ userId: 'cust-a' }),
      { user: AGENT_A, sessionId: null }
    );

    expect(access).toEqual({ allowed: true, canManage: true, role: 'admin' });
    expect(mockDb.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cust-a' } })
    );
  });

  it('DENIA el carrito de un cliente asignado a OTRO asesor', async () => {
    mockDb.user.findUnique.mockResolvedValue({ assignedAgentId: 'agent-b' });

    const access = await authorizeCartViewerWithOwner(
      cart({ userId: 'cust-b' }),
      { user: AGENT_A, sessionId: null }
    );

    expect(access).toEqual({ allowed: false, canManage: false, role: 'denied' });
  });

  it('carrito huérfano/de sesión: gestionable sin consulta de dueño', async () => {
    const access = await authorizeCartViewerWithOwner(
      cart({ userId: null, sessionId: 'sess-1' }),
      { user: AGENT_A, sessionId: 'sess-otra' }
    );

    expect(access).toEqual({ allowed: true, canManage: true, role: 'admin' });
    expect(mockDb.user.findUnique).not.toHaveBeenCalled();
  });

  it('dueño inexistente en DB: tratable (fail-open acordado para venta asistida)', async () => {
    mockDb.user.findUnique.mockResolvedValue(null);

    const access = await authorizeCartViewerWithOwner(
      cart({ userId: 'cust-fantasma' }),
      { user: AGENT_A, sessionId: null }
    );

    expect(access).toEqual({ allowed: true, canManage: true, role: 'admin' });
  });
});

describe('authorizeCartViewer: ramas no-AGENT sin cambios', () => {
  it('admin/editor gestionan cualquier carrito', () => {
    expect(
      authorizeCartViewer(cart({ userId: 'cust-x' }), { user: ADMIN, sessionId: null })
    ).toEqual({ allowed: true, canManage: true, role: 'admin' });
    expect(
      authorizeCartViewer(cart({ userId: 'cust-x' }), { user: { id: 'e1', role: 'Editor' }, sessionId: null })
    ).toEqual({ allowed: true, canManage: true, role: 'admin' });
  });

  it('AGENT sincrono sin info de dueño: tratable (compatibilidad con firma previa)', () => {
    const access = authorizeCartViewer(
      cart({ userId: 'cust-x' }),
      { user: AGENT_B, sessionId: null }
    );
    expect(access).toEqual({ allowed: true, canManage: true, role: 'admin' });
  });

  it('CUSTOMER ajeno: solo lectura por capability-link', () => {
    const access = authorizeCartViewer(
      cart({ userId: 'cust-owner' }),
      { user: { id: 'cust-otro', role: 'CUSTOMER' }, sessionId: null }
    );
    expect(access).toEqual({ allowed: true, canManage: false, role: 'shared' });
  });

  it('carrito inactivo: denegado para todos', () => {
    expect(
      authorizeCartViewer(cart({ isActive: false }), { user: ADMIN, sessionId: null }).allowed
    ).toBe(false);
  });
});
