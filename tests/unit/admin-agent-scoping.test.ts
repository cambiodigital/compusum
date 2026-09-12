import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

/**
 * FASE 4A — AISLAMiento ESTRICTO POR ASESOR en /api/admin.
 *
 * El AGENT comercial solo ve/gestiona SUS clientes (assignedAgentId) y SUS
 * pedidos (agentId). Los admin/editor conservan alcance global. Las
 * funciones de auth se mockean PERO implementan la misma semántica que las
 * reales usando los predicados puros de '@/lib/roles', de modo que los tests
 * ejercen el arbol de decisión completo del borde.
 */

const authState = vi.hoisted(() => ({
  currentUser: null as { id: string; name: string; email: string; role: string } | null,
}));

const mockDb = vi.hoisted(() => ({
  user: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    count: vi.fn(),
    create: vi.fn(),
  },
  order: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    groupBy: vi.fn(),
    count: vi.fn(),
    aggregate: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    create: vi.fn(),
  },
  cart: { findMany: vi.fn() },
  priceProfile: { findMany: vi.fn() },
  orderItem: { deleteMany: vi.fn(), createMany: vi.fn() },
  orderStatusHistory: { create: vi.fn() },
}));

vi.mock('@/lib/db', () => ({ db: mockDb }));

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
    requireBackofficeApi: async () => {
      const user = authState.currentUser;
      if (!user) {
        return {
          error: NextResponse.json({ success: false, error: 'No autorizado' }, { status: 401 }),
          user: null,
        };
      }
      if (!roles.isBackofficeRole(user.role)) {
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

const mockCreateCustomerAccount = vi.hoisted(() => vi.fn());
const mockUpdateCustomerAccount = vi.hoisted(() => vi.fn());
const mockDeleteCustomerAccount = vi.hoisted(() => vi.fn());

vi.mock('@/lib/customers-admin', () => ({
  createCustomerAccount: mockCreateCustomerAccount,
  updateCustomerAccount: mockUpdateCustomerAccount,
  deleteCustomerAccount: mockDeleteCustomerAccount,
  CustomerAdminError: class CustomerAdminError extends Error {
    code: string;
    constructor(code: string, message: string) {
      super(message);
      this.name = 'CustomerAdminError';
      this.code = code;
    }
  },
  listActiveAgents: vi.fn().mockResolvedValue([]),
  listActivePriceProfiles: vi.fn().mockResolvedValue([]),
}));

vi.mock('@/lib/order-number', () => ({
  generateOrderNumber: vi.fn().mockResolvedValue('PED-9999'),
  createOrderTransactionWithRetry: vi.fn(
    async (cb: (tx: typeof mockDb) => Promise<unknown>) => cb(mockDb)
  ),
}));

import { GET as customersGET, POST as customersPOST } from '@/app/api/admin/customers/route';
import {
  GET as customerGET,
  PATCH as customerPATCH,
  DELETE as customerDELETE,
} from '@/app/api/admin/customers/[id]/route';
import { GET as formOptionsGET } from '@/app/api/admin/customers/form-options/route';
import { GET as ordersGET } from '@/app/api/admin/orders/route';
import {
  GET as orderGET,
  PATCH as orderPATCH,
  DELETE as orderDELETE,
} from '@/app/api/admin/orders/[id]/route';
import { POST as duplicatePOST } from '@/app/api/admin/orders/[id]/duplicate/route';
import { GET as productsGET } from '@/app/api/admin/products/route';
import { GET as adminCartsGET } from '@/app/api/admin/carts/route';
import { GET as priceProfilesGET } from '@/app/api/admin/price-profiles/route';
import { POST as importPOST } from '@/app/api/admin/import/route';

const AGENT_A = { id: 'agent-a', name: 'Agente A', email: 'a@test.com', role: 'AGENT' };
const ADMIN = { id: 'admin-1', name: 'Admin', email: 'admin@test.com', role: 'admin' };
const CUSTOMER_USER = { id: 'cust-1', name: 'Cliente', email: 'c@test.com', role: 'CUSTOMER' };

function req(url: string, init?: RequestInit): NextRequest {
  return new Request(url, init) as unknown as NextRequest;
}

function idParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.currentUser = null;
});

describe('GET /api/admin/customers — alcance por asesor', () => {
  it('AGENT: fuerza assignedAgentId = self e IGNORA el parámetro ?asesor', async () => {
    authState.currentUser = AGENT_A;
    mockDb.user.findMany.mockResolvedValue([]);
    mockDb.user.count.mockResolvedValue(0);
    mockDb.order.groupBy.mockResolvedValue([]);
    mockDb.order.findMany.mockResolvedValue([]);

    const res = await customersGET(
      req('http://localhost/api/admin/customers?asesor=agent-b&page=1&limit=20')
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockDb.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ role: 'CUSTOMER', assignedAgentId: 'agent-a' }),
      })
    );
    // Defensa en profundidad: las métricas de pedidos también quedan scoped.
    expect(mockDb.order.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ customer: { assignedAgentId: 'agent-a' } }),
      })
    );
    // El historial (último pedido por cliente) sigue al ASESOR dueño: tras una
    // reasignación, el AGENT no ve pedidos creados bajo otro asesor.
    expect(mockDb.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          customerId: { in: [] },
          agentId: 'agent-a',
        }),
      })
    );
  });

  it('AGENT: NO ve clientes de otro asesor aunque el where lo pidiera', async () => {
    authState.currentUser = AGENT_A;
    mockDb.user.findMany.mockResolvedValue([]);
    mockDb.user.count.mockResolvedValue(0);
    mockDb.order.groupBy.mockResolvedValue([]);
    mockDb.order.findMany.mockResolvedValue([]);

    await customersGET(req('http://localhost/api/admin/customers?asesor=agent-b'));
    const where = mockDb.user.findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.assignedAgentId).toBe('agent-a');
  });

  it('admin: lista sin alcance (comportamiento global intacto)', async () => {
    authState.currentUser = ADMIN;
    mockDb.user.findMany.mockResolvedValue([]);
    mockDb.user.count.mockResolvedValue(0);
    mockDb.order.groupBy.mockResolvedValue([]);
    mockDb.order.findMany.mockResolvedValue([]);

    const res = await customersGET(req('http://localhost/api/admin/customers?asesor=agent-b'));
    expect(res.status).toBe(200);
    const where = mockDb.user.findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.assignedAgentId).toBe('agent-b'); // el filtro explícito del admin SÍ aplica
  });

  it('CUSTOMER: 403 en la lista del maestro', async () => {
    authState.currentUser = CUSTOMER_USER;
    const res = await customersGET(req('http://localhost/api/admin/customers'));
    expect(res.status).toBe(403);
  });
});

describe('POST /api/admin/customers — creación por AGENT', () => {
  it('AGENT: assignedAgentId FORZADO a self y priceProfileId ignorado', async () => {
    authState.currentUser = AGENT_A;
    mockCreateCustomerAccount.mockResolvedValue({ id: 'new-cust' });

    const res = await customersPOST(
      req('http://localhost/api/admin/customers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Cliente Nuevo',
          phone: '3001234567',
          assignedAgentId: 'agent-b',
          priceProfileId: 'prof-1',
        }),
      })
    );

    expect(res.status).toBe(201);
    expect(mockCreateCustomerAccount).toHaveBeenCalledWith(
      expect.objectContaining({ assignedAgentId: 'agent-a', priceProfileId: null })
    );
  });

  it('admin: crea con los valores enviados (sin cambios)', async () => {
    authState.currentUser = ADMIN;
    mockCreateCustomerAccount.mockResolvedValue({ id: 'new-cust' });

    await customersPOST(
      req('http://localhost/api/admin/customers', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Cliente Nuevo',
          phone: '3001234567',
          assignedAgentId: 'agent-b',
          priceProfileId: 'prof-1',
        }),
      })
    );

    expect(mockCreateCustomerAccount).toHaveBeenCalledWith(
      expect.objectContaining({ assignedAgentId: 'agent-b', priceProfileId: 'prof-1' })
    );
  });
});

describe('GET/PATCH/DELETE /api/admin/customers/[id]', () => {
  it('AGENT: GET cliente propio 200 con where scoped', async () => {
    authState.currentUser = AGENT_A;
    mockDb.user.findFirst.mockResolvedValueOnce({ id: 'cust-a' }); // cliente propio
    mockDb.order.findMany.mockResolvedValue([]);
    mockDb.cart.findMany.mockResolvedValue([]);
    mockDb.order.aggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: { subtotal: 0 } });

    const res = await customerGET(req('http://localhost/api/admin/customers/cust-a'), idParams('cust-a'));
    expect(res.status).toBe(200);
    expect(mockDb.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'cust-a', assignedAgentId: 'agent-a' }),
      })
    );
    // El historial y el gasto del detalle siguen al ASESOR dueño por diseño:
    // pedidos creados bajo otro asesor no aparecen tras una reasignación.
    expect(mockDb.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { customerId: 'cust-a', agentId: 'agent-a' },
      })
    );
    expect(mockDb.order.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { customerId: 'cust-a', agentId: 'agent-a' },
      })
    );
  });

  it('admin: GET detalle SIN agentId en las consultas de pedidos', async () => {
    authState.currentUser = ADMIN;
    mockDb.user.findFirst.mockResolvedValueOnce({ id: 'cust-b' });
    mockDb.order.findMany.mockResolvedValue([]);
    mockDb.cart.findMany.mockResolvedValue([]);
    mockDb.order.aggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: { subtotal: 0 } });

    const res = await customerGET(req('http://localhost/api/admin/customers/cust-b'), idParams('cust-b'));
    expect(res.status).toBe(200);
    expect(mockDb.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { customerId: 'cust-b' },
      })
    );
    expect(mockDb.order.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { customerId: 'cust-b' },
      })
    );
  });

  it('AGENT: GET cliente de OTRO asesor => 404 (sin filtrar existencia)', async () => {
    authState.currentUser = AGENT_A;
    mockDb.user.findFirst.mockResolvedValueOnce(null);

    const res = await customerGET(req('http://localhost/api/admin/customers/cust-b'), idParams('cust-b'));
    const json = await res.json();
    expect(res.status).toBe(404);
    expect(json.error).toBe('Cliente no encontrado');
  });

  it('admin: GET cliente de cualquier asesor 200', async () => {
    authState.currentUser = ADMIN;
    mockDb.user.findFirst.mockResolvedValueOnce({ id: 'cust-b' });
    mockDb.order.findMany.mockResolvedValue([]);
    mockDb.cart.findMany.mockResolvedValue([]);
    mockDb.order.aggregate.mockResolvedValue({ _count: { _all: 0 }, _sum: { subtotal: 0 } });

    const res = await customerGET(req('http://localhost/api/admin/customers/cust-b'), idParams('cust-b'));
    expect(res.status).toBe(200);
    const where = mockDb.user.findFirst.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.assignedAgentId).toBeUndefined();
  });

  it('AGENT: PATCH cliente ajeno => 404', async () => {
    authState.currentUser = AGENT_A;
    mockDb.user.findFirst.mockResolvedValueOnce(null);

    const res = await customerPATCH(
      req('http://localhost/api/admin/customers/cust-b', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Hack' }),
      }),
      idParams('cust-b')
    );
    expect(res.status).toBe(404);
    expect(mockUpdateCustomerAccount).not.toHaveBeenCalled();
  });

  it('AGENT: PATCH propio SOLO aplica campos comerciales seguros', async () => {
    authState.currentUser = AGENT_A;
    mockDb.user.findFirst.mockResolvedValueOnce({ id: 'cust-a' });
    mockUpdateCustomerAccount.mockResolvedValue({ id: 'cust-a', name: 'Actualizado' });

    const res = await customerPATCH(
      req('http://localhost/api/admin/customers/cust-a', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: 'Actualizado',
          phone: '3001234568',
          // Campos privilegiados que el AGENT jamás puede tocar:
          assignedAgentId: 'agent-b',
          priceProfileId: 'prof-9',
          password: 'newpassword123',
          isActive: false,
          role: 'admin',
        }),
      }),
      idParams('cust-a')
    );

    expect(res.status).toBe(200);
    expect(mockUpdateCustomerAccount).toHaveBeenCalledTimes(1);
    const [calledId, calledBody] = mockUpdateCustomerAccount.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(calledId).toBe('cust-a');
    expect(calledBody).toEqual({ name: 'Actualizado', phone: '3001234568' });
  });

  it('AGENT: DELETE propio => 403 (capacidad global-admin)', async () => {
    authState.currentUser = AGENT_A;
    mockDb.user.findFirst.mockResolvedValueOnce({ id: 'cust-a' });

    const res = await customerDELETE(req('http://localhost/api/admin/customers/cust-a', { method: 'DELETE' }), idParams('cust-a'));
    const json = await res.json();
    expect(res.status).toBe(403);
    expect(json.success).toBe(false);
    expect(mockDeleteCustomerAccount).not.toHaveBeenCalled();
  });

  it('AGENT: DELETE ajeno => 404', async () => {
    authState.currentUser = AGENT_A;
    mockDb.user.findFirst.mockResolvedValueOnce(null);

    const res = await customerDELETE(req('http://localhost/api/admin/customers/cust-b', { method: 'DELETE' }), idParams('cust-b'));
    expect(res.status).toBe(404);
  });

  it('admin: DELETE sin cambios (delega en deleteCustomerAccount)', async () => {
    authState.currentUser = ADMIN;
    mockDeleteCustomerAccount.mockResolvedValue(undefined);

    const res = await customerDELETE(req('http://localhost/api/admin/customers/cust-b', { method: 'DELETE' }), idParams('cust-b'));
    expect(res.status).toBe(200);
    expect(mockDeleteCustomerAccount).toHaveBeenCalledWith('cust-b');
  });
});

describe('GET /api/admin/customers/form-options', () => {
  it('AGENT: 403 (lista global de asesores/perfiles es capacidad admin)', async () => {
    authState.currentUser = AGENT_A;
    const res = await formOptionsGET();
    expect(res.status).toBe(403);
  });

  it('admin: 200', async () => {
    authState.currentUser = ADMIN;
    const res = await formOptionsGET();
    expect(res.status).toBe(200);
  });
});

describe('GET /api/admin/orders — alcance por asesor', () => {
  it('AGENT: fuerza agentId = self merged con filtros de estado', async () => {
    authState.currentUser = AGENT_A;
    mockDb.order.findMany.mockResolvedValue([]);
    mockDb.order.count.mockResolvedValue(0);

    const res = await ordersGET(req('http://localhost/api/admin/orders?status=solicitado'));
    expect(res.status).toBe(200);
    const where = mockDb.order.findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where).toEqual({ status: 'solicitado', agentId: 'agent-a' });
  });

  it('admin: sin alcance', async () => {
    authState.currentUser = ADMIN;
    mockDb.order.findMany.mockResolvedValue([]);
    mockDb.order.count.mockResolvedValue(0);

    const res = await ordersGET(req('http://localhost/api/admin/orders'));
    expect(res.status).toBe(200);
    const where = mockDb.order.findMany.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.agentId).toBeUndefined();
  });
});

describe('GET/PATCH/DELETE /api/admin/orders/[id]', () => {
  it('AGENT: GET pedido propio 200', async () => {
    authState.currentUser = AGENT_A;
    mockDb.order.findFirst.mockResolvedValueOnce({
      id: 'order-a',
      agentId: 'agent-a',
      items: [],
      statusHistory: [],
      cart: null,
    });

    const res = await orderGET(req('http://localhost/api/admin/orders/order-a'), idParams('order-a'));
    expect(res.status).toBe(200);
    expect(mockDb.order.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order-a', agentId: 'agent-a' },
      })
    );
  });

  it('AGENT: GET pedido ajeno => 404', async () => {
    authState.currentUser = AGENT_A;
    mockDb.order.findFirst.mockResolvedValueOnce(null);

    const res = await orderGET(req('http://localhost/api/admin/orders/order-b'), idParams('order-b'));
    const json = await res.json();
    expect(res.status).toBe(404);
    expect(json.error).toBe('Pedido no encontrado');
  });

  it('admin: GET pedido de cualquier asesor 200', async () => {
    authState.currentUser = ADMIN;
    mockDb.order.findFirst.mockResolvedValueOnce({
      id: 'order-b',
      agentId: 'agent-b',
      items: [],
      statusHistory: [],
      cart: null,
    });

    const res = await orderGET(req('http://localhost/api/admin/orders/order-b'), idParams('order-b'));
    expect(res.status).toBe(200);
    const where = mockDb.order.findFirst.mock.calls[0][0].where as Record<string, unknown>;
    expect(where.agentId).toBeUndefined();
  });

  it('AGENT: PATCH pedido ajeno => 404', async () => {
    authState.currentUser = AGENT_A;
    mockDb.order.findFirst.mockResolvedValueOnce(null);

    const res = await orderPATCH(
      req('http://localhost/api/admin/orders/order-b', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'compartido' }),
      }),
      idParams('order-b')
    );
    expect(res.status).toBe(404);
  });

  it('AGENT: PATCH pedido propio 200 (validaciones existentes intactas)', async () => {
    authState.currentUser = AGENT_A;
    mockDb.order.findFirst.mockResolvedValueOnce({ id: 'order-a', agentId: 'agent-a', status: 'solicitado' });
    mockDb.order.update.mockResolvedValue({ id: 'order-a', status: 'compartido', items: [] });
    mockDb.orderStatusHistory.create.mockResolvedValue({});

    const res = await orderPATCH(
      req('http://localhost/api/admin/orders/order-a', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'compartido' }),
      }),
      idParams('order-a')
    );
    expect(res.status).toBe(200);
    expect(mockDb.orderStatusHistory.create).toHaveBeenCalled();
  });

  it('AGENT: DELETE propio => 403 (operación destructiva global)', async () => {
    authState.currentUser = AGENT_A;
    mockDb.order.findFirst.mockResolvedValueOnce({ id: 'order-a' });

    const res = await orderDELETE(req('http://localhost/api/admin/orders/order-a', { method: 'DELETE' }), idParams('order-a'));
    const json = await res.json();
    expect(res.status).toBe(403);
    expect(json.success).toBe(false);
    expect(mockDb.order.delete).not.toHaveBeenCalled();
  });

  it('AGENT: DELETE ajeno => 404', async () => {
    authState.currentUser = AGENT_A;
    mockDb.order.findFirst.mockResolvedValueOnce(null);

    const res = await orderDELETE(req('http://localhost/api/admin/orders/order-b', { method: 'DELETE' }), idParams('order-b'));
    expect(res.status).toBe(404);
  });

  it('admin: DELETE sin cambios', async () => {
    authState.currentUser = ADMIN;
    mockDb.order.findUnique.mockResolvedValueOnce({ id: 'order-b' });
    mockDb.order.delete.mockResolvedValue({ id: 'order-b' });

    const res = await orderDELETE(req('http://localhost/api/admin/orders/order-b', { method: 'DELETE' }), idParams('order-b'));
    expect(res.status).toBe(200);
    expect(mockDb.order.delete).toHaveBeenCalledWith({ where: { id: 'order-b' } });
  });
});

describe('POST /api/admin/orders/[id]/duplicate', () => {
  it('AGENT: duplicar pedido ajeno => 404', async () => {
    authState.currentUser = AGENT_A;
    mockDb.order.findFirst.mockResolvedValueOnce(null);

    const res = await duplicatePOST(req('http://localhost/api/admin/orders/order-b/duplicate', { method: 'POST' }), idParams('order-b'));
    expect(res.status).toBe(404);
  });

  it('AGENT: duplicar pedido propio 200 y la copia conserva agentId = self', async () => {
    authState.currentUser = AGENT_A;
    mockDb.order.findFirst.mockResolvedValueOnce({
      id: 'order-a',
      agentId: 'agent-a',
      items: [{ productId: 'p1', productName: 'Prod', productSku: null, quantity: 1, unitPrice: 1000 }],
    });
    mockDb.order.create.mockResolvedValue({ id: 'order-new', agentId: 'agent-a' });

    const res = await duplicatePOST(req('http://localhost/api/admin/orders/order-a/duplicate', { method: 'POST' }), idParams('order-a'));
    expect(res.status).toBe(200);
    expect(mockDb.order.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ agentId: 'agent-a', status: 'solicitado' }),
      })
    );
  });

  it('admin: duplica pedidos de cualquier asesor sin cambios', async () => {
    authState.currentUser = ADMIN;
    mockDb.order.findFirst.mockResolvedValueOnce({
      id: 'order-b',
      agentId: 'agent-b',
      items: [],
    });
    mockDb.order.create.mockResolvedValue({ id: 'order-new', agentId: 'agent-b' });

    const res = await duplicatePOST(req('http://localhost/api/admin/orders/order-b/duplicate', { method: 'POST' }), idParams('order-b'));
    expect(res.status).toBe(200);
  });
});

describe('Superficies globales: AGENT siempre 403 vía requireAdminApi', () => {
  it.each([
    ['products', () => productsGET(req('http://localhost/api/admin/products'))],
    ['carts', () => adminCartsGET(req('http://localhost/api/admin/carts'))],
    ['price-profiles', () => priceProfilesGET()],
    ['import', () => importPOST(req('http://localhost/api/admin/import', { method: 'POST' }))],
  ])('%s: AGENT => 403', async (_name, call) => {
    authState.currentUser = AGENT_A;
    const res = await call();
    expect(res.status).toBe(403);
  });

  it('price-profiles: admin => 200', async () => {
    authState.currentUser = ADMIN;
    const res = await priceProfilesGET();
    expect(res.status).toBe(200);
  });
});
