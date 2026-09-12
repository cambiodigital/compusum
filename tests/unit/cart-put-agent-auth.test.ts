import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

/**
 * FASE 4A — PUT /api/carts/[uuid]: la capacidad de gestión se resuelve con la
 * MISMA política que el GET (authorizeCartViewerWithOwner, con lookup del
 * dueño) y la decisión de bypass de staff se HILO al servicio vía
 * `viewer.staffCanManage` para que el re-check POST-lock re-enforce la misma
 * decisión bajo lock. editor no tiene bypass; dueños conservan la verificación
 * de propiedad del lock.
 */

const authState = vi.hoisted(() => ({
  currentUser: null as { id: string; name: string; email: string; role: string } | null,
}));

const mockDb = vi.hoisted(() => ({
  cart: { findUnique: vi.fn() },
  user: { findUnique: vi.fn() },
}));

vi.mock('@/lib/db', () => ({ db: mockDb }));

vi.mock('@/lib/auth', async () => {
  const roles = await import('@/lib/roles');
  return {
    ...roles,
    getCurrentUser: vi.fn(async () => authState.currentUser),
  };
});

const mockUpdateCartByUuid = vi.hoisted(() => vi.fn());

vi.mock('@/lib/cart-mutations', () => ({
  updateCartByUuid: mockUpdateCartByUuid,
}));

import { PUT as cartPUT } from '@/app/api/carts/[uuid]/route';

const AGENT_A = { id: 'agent-a', name: 'Agente A', email: 'a@t.com', role: 'AGENT' };
const ADMIN = { id: 'admin-1', name: 'Admin', email: 'ad@t.com', role: 'admin' };
const EDITOR = { id: 'editor-1', name: 'Editor', email: 'e@t.com', role: 'editor' };
const CUSTOMER = { id: 'cust-a', name: 'Cliente', email: 'c@t.com', role: 'CUSTOMER' };

function cartRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cart-1',
    uuid: 'uuid-1',
    sessionId: null,
    userId: null,
    status: 'activo',
    isActive: true,
    ...overrides,
  };
}

function req(uuid: string, body: unknown): NextRequest {
  return new Request(`http://localhost/api/carts/${uuid}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', 'x-session-id': 'sess-viewer' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function idParams(uuid: string) {
  return { params: Promise.resolve({ uuid }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.currentUser = null;
  mockUpdateCartByUuid.mockResolvedValue({ id: 'cart-1', uuid: 'uuid-1' });
});

describe('PUT /api/carts/[uuid] — aislamiento por asesor (ruta + hilo al lock)', () => {
  it('AGENT sobre carrito de cliente de OTRO asesor => 404 sin llamar al servicio', async () => {
    authState.currentUser = AGENT_A;
    mockDb.cart.findUnique.mockResolvedValue(cartRow({ userId: 'cust-b', status: 'activo' }));
    mockDb.user.findUnique.mockResolvedValue({ assignedAgentId: 'agent-b' });

    const res = await cartPUT(req('uuid-1', { items: [] }), idParams('uuid-1'));
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json.error).toBe('Carrito no encontrado');
    expect(mockUpdateCartByUuid).not.toHaveBeenCalled();
  });

  it('AGENT sobre carrito de SU cliente asignado => 200 y staffCanManage=true hilado', async () => {
    authState.currentUser = AGENT_A;
    mockDb.cart.findUnique.mockResolvedValue(cartRow({ userId: 'cust-a' }));
    mockDb.user.findUnique.mockResolvedValue({ assignedAgentId: 'agent-a' });

    const res = await cartPUT(req('uuid-1', { items: [] }), idParams('uuid-1'));

    expect(res.status).toBe(200);
    expect(mockUpdateCartByUuid).toHaveBeenCalledWith(
      expect.objectContaining({
        viewer: expect.objectContaining({ staffCanManage: true }),
      })
    );
  });

  it('AGENT sobre carrito huérfano/de sesión => 200 y staffCanManage=true (venta asistida)', async () => {
    authState.currentUser = AGENT_A;
    mockDb.cart.findUnique.mockResolvedValue(
      cartRow({ userId: null, sessionId: 'sess-dueno' })
    );

    const res = await cartPUT(req('uuid-1', { items: [] }), idParams('uuid-1'));

    expect(res.status).toBe(200);
    expect(mockDb.user.findUnique).not.toHaveBeenCalled(); // sin dueño no hay lookup
    expect(mockUpdateCartByUuid).toHaveBeenCalledWith(
      expect.objectContaining({
        viewer: expect.objectContaining({ staffCanManage: true }),
      })
    );
  });

  it('admin sobre carrito de terceros => 200 sin cambios (staffCanManage=true)', async () => {
    authState.currentUser = ADMIN;
    mockDb.cart.findUnique.mockResolvedValue(cartRow({ userId: 'cust-b' }));
    mockDb.user.findUnique.mockResolvedValue({ assignedAgentId: 'agent-b' });

    const res = await cartPUT(req('uuid-1', { items: [] }), idParams('uuid-1'));

    expect(res.status).toBe(200);
    expect(mockUpdateCartByUuid).toHaveBeenCalledWith(
      expect.objectContaining({
        viewer: expect.objectContaining({ staffCanManage: true }),
      })
    );
  });

  it('CUSTOMER dueño => 200 con staffCanManage=false (lock re-valida propiedad)', async () => {
    authState.currentUser = CUSTOMER;
    mockDb.cart.findUnique.mockResolvedValue(cartRow({ userId: 'cust-a' }));

    const res = await cartPUT(req('uuid-1', { items: [] }), idParams('uuid-1'));

    expect(res.status).toBe(200);
    expect(mockUpdateCartByUuid).toHaveBeenCalledWith(
      expect.objectContaining({
        viewer: expect.objectContaining({ staffCanManage: false }),
      })
    );
  });

  it('editor sin ser dueño => 404 (nunca tuvo bypass)', async () => {
    authState.currentUser = EDITOR;
    mockDb.cart.findUnique.mockResolvedValue(cartRow({ userId: 'cust-b' }));

    const res = await cartPUT(req('uuid-1', { items: [] }), idParams('uuid-1'));
    expect(res.status).toBe(404);
    expect(mockUpdateCartByUuid).not.toHaveBeenCalled();
  });

  it('CUSTOMER ajeno => 404 (antes 403: misma denegación que el GET, sin existence leak)', async () => {
    authState.currentUser = { ...CUSTOMER, id: 'cust-otro' };
    mockDb.cart.findUnique.mockResolvedValue(cartRow({ userId: 'cust-a' }));

    const res = await cartPUT(req('uuid-1', { items: [] }), idParams('uuid-1'));
    expect(res.status).toBe(404);
    expect(mockUpdateCartByUuid).not.toHaveBeenCalled();
  });

  it('carrito convertido de un DUEÑO => 403 "ya no se puede modificar" (flujo propio intacto)', async () => {
    authState.currentUser = CUSTOMER;
    mockDb.cart.findUnique.mockResolvedValue(
      cartRow({ userId: 'cust-a', status: 'convertido' })
    );

    const res = await cartPUT(req('uuid-1', { items: [] }), idParams('uuid-1'));
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.error).toBe('Este carrito ya no se puede modificar');
  });

  it('carrito inactivo => 404 (fast-fail previo intacto)', async () => {
    authState.currentUser = CUSTOMER;
    mockDb.cart.findUnique.mockResolvedValue(cartRow({ userId: 'cust-a', isActive: false }));

    const res = await cartPUT(req('uuid-1', { items: [] }), idParams('uuid-1'));
    expect(res.status).toBe(404);
  });
});
