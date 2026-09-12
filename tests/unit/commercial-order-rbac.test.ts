import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';
import { Prisma } from '@prisma/client';

/**
 * FASE 4B — RBAC y CONTRATO DE RUTA de la capa comercial
 * (/api/admin/orders/[id] commercial + guard legacy del PATCH).
 *
 * La db se mockea con un mini-estado transaccional (snapshot/rollback) para
 * poder afirmar CERO writes en cada rechazo. La semántica de auth se replica
 * con los predicados reales de '@/lib/roles' (mismo patrón 4A).
 *
 * Caso base de la spec: AGENT A, AGENT B, CUSTOMER A (con SU PriceProfile),
 * CUSTOMER B, pedido A, pedido B y cotización A.
 */

const authState = vi.hoisted(() => ({
  currentUser: null as { id: string; name: string; email: string; role: string } | null,
}));

const mockDb = vi.hoisted(() => ({
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  order: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    delete: vi.fn(),
    deleteMany: vi.fn(),
  },
  orderItem: {
    findMany: vi.fn(),
    deleteMany: vi.fn(),
    createMany: vi.fn(),
  },
  orderStatusHistory: {
    create: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
  },
  product: {
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  user: {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    findMany: vi.fn(),
  },
  priceProfile: {
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  priceProfileProduct: {
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
  priceProfileVariant: {
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
  },
}));

vi.mock('@/lib/db', () => ({ db: mockDb }));

vi.mock('@/lib/auth', async () => {
  const { NextResponse } = await import('next/server');
  const roles = await import('@/lib/roles');
  return {
    ...roles,
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

// ---------- Mini-estado transaccional ----------

interface OpRecord {
  op: string;
  inTx: boolean;
  orderId?: string;
}

interface MockState {
  orders: Map<string, any>;
  items: Map<string, any[]>;
  history: any[];
  products: Map<string, any>;
  users: Map<string, any>;
  profileOverrides: any[];
  inTx: boolean;
  itemSeq: number;
  historyThrow: Error | null;
  ops: OpRecord[];
}

function makeState(): MockState {
  return {
    orders: new Map(),
    items: new Map(),
    history: [],
    products: new Map(),
    users: new Map(),
    profileOverrides: [],
    inTx: false,
    itemSeq: 0,
    historyThrow: null,
    ops: [],
  };
}

function snapshotOf(state: MockState): string {
  return JSON.stringify({
    orders: Array.from(state.orders.entries()),
    items: Array.from(state.items.entries()),
    history: state.history,
  });
}

function restore(state: MockState, snap: string) {
  const parsed = JSON.parse(snap);
  state.orders = new Map(parsed.orders);
  state.items = new Map(parsed.items);
  state.history = parsed.history;
}

function seedOrder(state: MockState, opts: {
  id: string;
  agentId: string | null;
  customerId: string | null;
  requestType: string;
  status?: string;
  items: Array<{ productId: string; quantity: number; unitPrice: number | null }>;
}) {
  state.orders.set(opts.id, {
    id: opts.id,
    orderNumber: `CS-4B-${opts.id}`,
    customerId: opts.customerId,
    agentId: opts.agentId,
    status: opts.status ?? 'solicitado',
    requestType: opts.requestType,
    subtotal: opts.items.reduce((sum, i) => sum + (i.unitPrice ?? 0) * i.quantity, 0),
  });
  state.items.set(
    opts.id,
    opts.items.map((i, idx) => ({
      id: `${opts.id}-oi-${idx}`,
      orderId: opts.id,
      productId: i.productId,
      productName: 'Producto comercial',
      productSku: null,
      variantId: null,
      variantName: null,
      variantCode: null,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
    }))
  );
}

function seedBaseFixtures(state: MockState) {
  // CUSTOMER A con SU PriceProfile (motor: wholesalePrice 10000, ajuste 0).
  state.users.set('cust-a', {
    id: 'cust-a',
    isActive: true,
    role: 'CUSTOMER',
    priceProfile: { id: 'prof-a', code: 'PROF-A', name: 'Perfil A', percentAdjustment: 0, isActive: true },
  });
  state.users.set('cust-b', {
    id: 'cust-b',
    isActive: true,
    role: 'CUSTOMER',
    priceProfile: null,
  });

  state.products.set('p-eng', {
    id: 'p-eng',
    name: 'Producto Engine',
    sku: 'SKU-ENG',
    isActive: true,
    stockQuantity: 50,
    stockStatus: 'disponible',
    minWholesaleQty: 2,
    price: 12000,
    wholesalePrice: 10000,
    variants: [],
  });
  state.products.set('p-quote', {
    id: 'p-quote',
    name: 'Producto Cotizacion',
    sku: 'SKU-QUOTE',
    isActive: true,
    stockQuantity: 10,
    stockStatus: 'disponible',
    minWholesaleQty: 1,
    price: 0,
    wholesalePrice: 0,
    variants: [],
  });
  state.products.set('p-inactive', {
    id: 'p-inactive',
    name: 'Producto Inactivo',
    sku: 'SKU-INACT',
    isActive: false,
    stockQuantity: 10,
    stockStatus: 'disponible',
    minWholesaleQty: 1,
    price: 5000,
    wholesalePrice: 4000,
    variants: [],
  });

  seedOrder(state, {
    id: 'order-a',
    agentId: 'agent-a',
    customerId: 'cust-a',
    requestType: 'pedido',
    items: [{ productId: 'p-eng', quantity: 2, unitPrice: 12345 }],
  });
  seedOrder(state, {
    id: 'order-b',
    agentId: 'agent-b',
    customerId: 'cust-b',
    requestType: 'pedido',
    items: [{ productId: 'p-eng', quantity: 1, unitPrice: 10000 }],
  });
  seedOrder(state, {
    id: 'quote-a',
    agentId: 'agent-a',
    customerId: 'cust-a',
    requestType: 'cotizacion',
    items: [{ productId: 'p-quote', quantity: 2, unitPrice: null }],
  });
}

/** Instala las implementaciones del mockDb sobre un estado fresco por test. */
function installDb(state: MockState) {
  const record = (op: string, orderId?: string) =>
    state.ops.push({ op, inTx: state.inTx, orderId });

  mockDb.$transaction.mockImplementation(async (fn: any) => {
    const snap = snapshotOf(state);
    state.inTx = true;
    try {
      return await fn(mockDb);
    } catch (err) {
      restore(state, snap);
      throw err;
    } finally {
      state.inTx = false;
    }
  });

  // Lock pesimista: fila POST-lock del pedido (comercial y PATCH legacy).
  mockDb.$queryRaw.mockImplementation(async (...args: any[]) => {
    const orderId = args[args.length - 1];
    const order = state.orders.get(orderId);
    if (!order) return [];
    return [
      {
        id: order.id,
        status: order.status,
        requestType: order.requestType,
        customerId: order.customerId,
        agentId: order.agentId,
        subtotal: order.subtotal,
      },
    ];
  });

  mockDb.order.findUnique.mockImplementation(({ where, include }: any) => {
    const order = state.orders.get(where.id);
    if (!order) return null;
    if (include?.items) {
      return { ...order, items: (state.items.get(order.id) ?? []).map((i) => ({ ...i })) };
    }
    return { ...order };
  });

  mockDb.order.findFirst.mockImplementation(({ where }: any) => {
    for (const order of state.orders.values()) {
      if (where.id !== undefined && order.id !== where.id) continue;
      if (where.agentId !== undefined && order.agentId !== where.agentId) continue;
      return { ...order };
    }
    return null;
  });

  mockDb.order.update.mockImplementation(({ where, data }: any) => {
    const order = state.orders.get(where.id);
    if (!order) {
      throw new Prisma.PrismaClientKnownRequestError('Record not found', {
        code: 'P2025',
        clientVersion: 'test',
      });
    }
    record('order.update', order.id);
    Object.assign(order, data);
    return { ...order };
  });

  mockDb.order.updateMany.mockImplementation(({ where, data }: any) => {
    record('order.updateMany', where.id);
    const order = state.orders.get(where.id);
    if (!order || (where.status !== undefined && order.status !== where.status)) {
      return { count: 0 };
    }
    Object.assign(order, data);
    return { count: 1 };
  });

  mockDb.orderItem.findMany.mockImplementation(({ where }: any) =>
    (state.items.get(where.orderId) ?? []).map((i) => ({ ...i }))
  );
  mockDb.orderItem.deleteMany.mockImplementation(({ where }: any) => {
    record('orderItem.deleteMany', where.orderId);
    state.items.set(where.orderId, []);
    return { count: 1 };
  });
  mockDb.orderItem.createMany.mockImplementation(({ data }: any) => {
    const orderId = data[0]?.orderId;
    record('orderItem.createMany', orderId);
    const list = state.items.get(orderId) ?? [];
    for (const row of data) {
      list.push({ id: `oi-${++state.itemSeq}`, ...row });
    }
    state.items.set(orderId, list);
    return { count: data.length };
  });

  mockDb.orderStatusHistory.create.mockImplementation(({ data }: any) => {
    record('orderStatusHistory.create', data.orderId);
    if (state.historyThrow) throw state.historyThrow;
    const row = { id: `h-${state.history.length + 1}`, ...data };
    state.history.push(row);
    return row;
  });
  mockDb.orderStatusHistory.count.mockImplementation(({ where }: any) =>
    state.history.filter((h) => h.orderId === where.orderId).length
  );
  mockDb.orderStatusHistory.findMany.mockImplementation(({ where }: any) =>
    state.history.filter((h) => h.orderId === where.orderId).map((h) => ({ ...h }))
  );

  mockDb.product.findMany.mockImplementation(({ where }: any) => {
    const ids: string[] = where?.id?.in ?? [];
    return Array.from(state.products.values())
      .filter((p) => ids.includes(p.id))
      .map((p) => ({ ...p, variants: [...(p.variants ?? [])] }));
  });
  mockDb.product.update.mockImplementation(({ where, data }: any) => {
    record('product.update', where.id);
    const p = state.products.get(where.id);
    if (p) Object.assign(p, data);
    return p ?? null;
  });

  mockDb.user.findUnique.mockImplementation(({ where }: any) => {
    const u = state.users.get(where.id);
    if (!u) return null;
    return {
      id: u.id,
      isActive: u.isActive,
      role: u.role,
      priceProfile: u.priceProfile ? { ...u.priceProfile } : null,
    };
  });

  mockDb.priceProfileProduct.findMany.mockImplementation(({ where }: any) =>
    state.profileOverrides.filter(
      (o) => o.profileId === where.profileId && where.productId.in.includes(o.productId)
    )
  );
  mockDb.priceProfileVariant.findMany.mockResolvedValue([]);

  // Modelos sensibles: registrados para poder afirmar que la capa comercial
  // JAMÁS escribe perfiles/overrides globales.
  const forbid = (op: string) => (args: any = {}) => {
    record(op, args.where?.id);
    return {};
  };
  mockDb.priceProfile.update.mockImplementation(forbid('priceProfile.update'));
  mockDb.priceProfile.create.mockImplementation(forbid('priceProfile.create'));
  mockDb.priceProfileProduct.update.mockImplementation(forbid('priceProfileProduct.update'));
  mockDb.priceProfileProduct.create.mockImplementation(forbid('priceProfileProduct.create'));
  mockDb.priceProfileVariant.update.mockImplementation(forbid('priceProfileVariant.update'));
  mockDb.priceProfileVariant.create.mockImplementation(forbid('priceProfileVariant.create'));
  mockDb.product.create.mockImplementation(forbid('product.create'));
}

// ---------- Handlers bajo test ----------

import {
  GET as commercialGET,
  POST as commercialPOST,
} from '@/app/api/admin/orders/[id]/commercial/route';
import { PATCH as orderPATCH } from '@/app/api/admin/orders/[id]/route';

const AGENT_A = { id: 'agent-a', name: 'Asesor A', email: 'aa@test.com', role: 'AGENT' };
const AGENT_B = { id: 'agent-b', name: 'Asesor B', email: 'ab@test.com', role: 'AGENT' };
const ADMIN = { id: 'admin-1', name: 'Admin', email: 'admin@test.com', role: 'admin' };
const EDITOR = { id: 'editor-1', name: 'Editor', email: 'e@test.com', role: 'editor' };
const CUSTOMER_USER = { id: 'cust-1', name: 'Cliente', email: 'c@test.com', role: 'CUSTOMER' };

function req(url: string, init?: RequestInit): NextRequest {
  return new Request(url, init) as unknown as NextRequest;
}

function idParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

function commercialPost(orderId: string, body: unknown) {
  return commercialPOST(
    req(`http://localhost/api/admin/orders/${orderId}/commercial`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    idParams(orderId)
  );
}

const SAVE_LINES = [{ productId: 'p-eng', quantity: 2 }];

beforeEach(() => {
  vi.clearAllMocks();
  authState.currentUser = null;
});

describe('Comercial: aislamiento RBAC por asesor (Fase 4B)', () => {
  it('AGENT A: save en pedido A => permitido; líneas reemplazadas con snapshot del motor, subtotal y auditoría', async () => {
    authState.currentUser = AGENT_A;
    const state = makeState();
    seedBaseFixtures(state);
    installDb(state);

    const res = await commercialPost('order-a', { action: 'save', lines: SAVE_LINES });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);

    // Snapshot del motor (10000), NO el quotedUnitPrice del navegador.
    expect(mockDb.orderItem.deleteMany).toHaveBeenCalledWith({ where: { orderId: 'order-a' } });
    expect(mockDb.orderItem.createMany).toHaveBeenCalledTimes(1);
    const created = (mockDb.orderItem.createMany as any).mock.calls[0][0].data;
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ productId: 'p-eng', quantity: 2, unitPrice: 10000 });

    // Subtotal recalculado server-side: 2 × 10000.
    expect(mockDb.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order-a', status: 'solicitado' },
        data: expect.objectContaining({ subtotal: 20000 }),
      })
    );
    expect(state.orders.get('order-a')!.subtotal).toBe(20000);

    // Auditoría con changedBy derivado del actor autenticado.
    expect(mockDb.orderStatusHistory.create).toHaveBeenCalledTimes(1);
    expect(state.history[0]).toMatchObject({
      orderId: 'order-a',
      changedBy: 'Asesor A',
      note: 'Líneas comerciales actualizadas',
    });
  });

  it('AGENT A: save/recalculate/convert/GET sobre pedido B => 404 "Pedido no encontrado" y CERO writes', async () => {
    authState.currentUser = AGENT_A;
    const state = makeState();
    seedBaseFixtures(state);
    installDb(state);

    const itemsBBefore = JSON.parse(JSON.stringify(state.items.get('order-b')));

    const responses = [
      await commercialPost('order-b', { action: 'save', lines: SAVE_LINES }),
      await commercialPost('order-b', { action: 'recalculate' }),
      await commercialPost('order-b', { action: 'convert' }),
      await commercialGET(req('http://localhost/api/admin/orders/order-b/commercial'), idParams('order-b')),
    ];

    for (const res of responses) {
      const json = await res.json();
      expect(res.status).toBe(404);
      expect(json).toEqual({ success: false, error: 'Pedido no encontrado' });
    }

    // CERO writes en TODO el mockDb (el pedido B existe: solo se rechaza la autorización).
    expect(mockDb.orderItem.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.orderItem.createMany).not.toHaveBeenCalled();
    expect(mockDb.order.updateMany).not.toHaveBeenCalled();
    expect(mockDb.order.update).not.toHaveBeenCalled();
    expect(mockDb.orderStatusHistory.create).not.toHaveBeenCalled();
    expect(state.history).toHaveLength(0);
    expect(JSON.parse(JSON.stringify(state.items.get('order-b')))).toEqual(itemsBBefore);
  });

  it('AGENT B: caso espejo sobre pedido A y cotización A => 404 y CERO writes', async () => {
    authState.currentUser = AGENT_B;
    const state = makeState();
    seedBaseFixtures(state);
    installDb(state);

    const responses = [
      await commercialPost('order-a', { action: 'save', lines: SAVE_LINES }),
      await commercialPost('quote-a', { action: 'convert' }),
      await commercialGET(req('http://localhost/api/admin/orders/order-a/commercial'), idParams('order-a')),
    ];

    for (const res of responses) {
      const json = await res.json();
      expect(res.status).toBe(404);
      expect(json).toEqual({ success: false, error: 'Pedido no encontrado' });
    }

    expect(mockDb.orderItem.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.orderItem.createMany).not.toHaveBeenCalled();
    expect(mockDb.order.updateMany).not.toHaveBeenCalled();
    expect(mockDb.order.update).not.toHaveBeenCalled();
    expect(mockDb.orderStatusHistory.create).not.toHaveBeenCalled();
    expect(state.history).toHaveLength(0);
  });

  it('ADMIN y EDITOR: alcance global sobre ambos pedidos', async () => {
    authState.currentUser = ADMIN;
    const state = makeState();
    seedBaseFixtures(state);
    installDb(state);

    const saveA = await commercialPost('order-a', { action: 'save', lines: SAVE_LINES });
    expect(saveA.status).toBe(200);
    const saveB = await commercialPost('order-b', { action: 'save', lines: SAVE_LINES });
    expect(saveB.status).toBe(200);

    authState.currentUser = EDITOR;
    const getA = await commercialGET(req('http://localhost/api/admin/orders/order-a/commercial'), idParams('order-a'));
    const getB = await commercialGET(req('http://localhost/api/admin/orders/order-b/commercial'), idParams('order-b'));
    expect(getA.status).toBe(200);
    expect(getB.status).toBe(200);
    expect((await getA.json()).data.canEdit).toBe(true);
  });

  it('CUSTOMER: requireBackofficeApi rechaza 403 antes de cualquier lógica del handler', async () => {
    authState.currentUser = CUSTOMER_USER;
    const state = makeState();
    seedBaseFixtures(state);
    installDb(state);

    const get = await commercialGET(req('http://localhost/api/admin/orders/order-a/commercial'), idParams('order-a'));
    const post = await commercialPost('order-a', { action: 'save', lines: SAVE_LINES });

    for (const res of [get, post]) {
      const json = await res.json();
      expect(res.status).toBe(403);
      expect(json.success).toBe(false);
    }

    // Ni una sola lectura/escritura de negocio: el borde de auth corta antes.
    expect(mockDb.$queryRaw).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockDb.order.findUnique).not.toHaveBeenCalled();
    expect(mockDb.orderItem.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.orderItem.createMany).not.toHaveBeenCalled();
  });
});

describe('Comercial: contrato de ruta POST/GET', () => {
  it('acción desconocida => 400', async () => {
    authState.currentUser = ADMIN;
    const state = makeState();
    seedBaseFixtures(state);
    installDb(state);

    const res = await commercialPost('order-a', { action: 'explode' });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.error).toContain('Acción inválida');
  });

  it.each([
    ['quantity 0', { action: 'save', lines: [{ productId: 'p-eng', quantity: 0 }] }],
    ['quantity negativa', { action: 'save', lines: [{ productId: 'p-eng', quantity: -3 }] }],
    ['quotedUnitPrice 0', { action: 'save', lines: [{ productId: 'p-eng', quantity: 2, quotedUnitPrice: 0 }] }],
    ['quotedUnitPrice negativo', { action: 'save', lines: [{ productId: 'p-eng', quantity: 2, quotedUnitPrice: -5 }] }],
    // 1e999 => Infinity tras JSON.parse; NaN no representable en JSON se cubre a nivel lib.
    ['quotedUnitPrice Infinity', `{ "action": "save", "lines": [{ "productId": "p-eng", "quantity": 2, "quotedUnitPrice": 1e999 }] }`],
  ])('líneas malformadas (%s) => 400 sin abrir transacción', async (_name, body) => {
    authState.currentUser = ADMIN;
    const state = makeState();
    seedBaseFixtures(state);
    installDb(state);

    const res = await commercialPost('order-a', body as string | object);
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockDb.orderItem.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.orderItem.createMany).not.toHaveBeenCalled();
  });

  it('CartValidationError (producto inexistente) => 400 comercial limpio', async () => {
    authState.currentUser = ADMIN;
    const state = makeState();
    seedBaseFixtures(state);
    installDb(state);

    const res = await commercialPost('order-a', {
      action: 'save',
      lines: [{ productId: 'p-missing', quantity: 2 }],
    });
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.error).toContain('no está disponible');
    expect(state.orders.get('order-a')!.subtotal).toBe(24690);
    expect(state.items.get('order-a')).toHaveLength(1);
  });

  it('pedido inexistente => 404 "Pedido no encontrado"', async () => {
    authState.currentUser = ADMIN;
    const state = makeState();
    seedBaseFixtures(state);
    installDb(state);

    const res = await commercialPost('order-zzz', { action: 'save', lines: SAVE_LINES });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json).toEqual({ success: false, error: 'Pedido no encontrado' });
  });

  it('P2025 (registro desaparecido a mitad de operación) => 404', async () => {
    authState.currentUser = ADMIN;
    const state = makeState();
    seedBaseFixtures(state);
    seedOrder(state, {
      id: 'quote-complete',
      agentId: 'agent-a',
      customerId: 'cust-a',
      requestType: 'cotizacion',
      items: [{ productId: 'p-eng', quantity: 2, unitPrice: 10000 }],
    });
    installDb(state);
    mockDb.order.update.mockImplementation(() => {
      throw new Prisma.PrismaClientKnownRequestError('Record not found', {
        code: 'P2025',
        clientVersion: 'test',
      });
    });

    const res = await commercialPost('quote-complete', { action: 'convert' });
    const json = await res.json();

    expect(res.status).toBe(404);
    expect(json).toEqual({ success: false, error: 'Pedido no encontrado' });
    // La conversión no llegó a escribir requestType.
    expect(state.orders.get('quote-complete')!.requestType).toBe('cotizacion');
  });
});

describe('Legacy PATCH /api/admin/orders/[id] — regresiones 4A intactas', () => {
  it('AGENT enviando `items` => sigue 403 FORBIDDEN sin tocar la base', async () => {
    authState.currentUser = AGENT_A;
    const state = makeState();
    seedBaseFixtures(state);
    installDb(state);

    const res = await orderPATCH(
      req('http://localhost/api/admin/orders/order-a', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          items: [{ productId: 'p-eng', productName: 'Hack', quantity: 1, unitPrice: 1 }],
        }),
      }),
      idParams('order-a')
    );
    const json = await res.json();

    expect(res.status).toBe(403);
    expect(json.code).toBe('FORBIDDEN');
    expect(mockDb.order.findFirst).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockDb.orderItem.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.orderItem.createMany).not.toHaveBeenCalled();
    expect(mockDb.order.update).not.toHaveBeenCalled();
  });

  it('ADMIN: cambio de estado sobre cotización INCOMPLETA => 400 comercial y cero writes', async () => {
    authState.currentUser = ADMIN;
    const state = makeState();
    seedBaseFixtures(state);
    installDb(state);

    const res = await orderPATCH(
      req('http://localhost/api/admin/orders/quote-a', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'compartido' }),
      }),
      idParams('quote-a')
    );
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    expect(json.error).toContain('líneas sin precio');

    // El estado NUNCA cambió: ni order.update ni historial.
    expect(mockDb.order.update).not.toHaveBeenCalled();
    expect(mockDb.orderStatusHistory.create).not.toHaveBeenCalled();
    expect(state.orders.get('quote-a')!.status).toBe('solicitado');
    expect(state.items.get('quote-a')![0].unitPrice).toBeNull();
  });

  it('ADMIN: cambio de estado sobre cotización COMPLETA => permitido con historial post-lock', async () => {
    authState.currentUser = ADMIN;
    const state = makeState();
    seedBaseFixtures(state);
    seedOrder(state, {
      id: 'quote-complete',
      agentId: 'agent-a',
      customerId: 'cust-a',
      requestType: 'cotizacion',
      items: [{ productId: 'p-eng', quantity: 2, unitPrice: 10000 }],
    });
    installDb(state);

    const res = await orderPATCH(
      req('http://localhost/api/admin/orders/quote-complete', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ status: 'compartido' }),
      }),
      idParams('quote-complete')
    );
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(state.orders.get('quote-complete')!.status).toBe('compartido');

    // Historial escrito DENTRO de la transacción con fromStatus POST-lock.
    expect(state.history).toHaveLength(1);
    expect(state.history[0]).toMatchObject({
      orderId: 'quote-complete',
      fromStatus: 'solicitado',
      toStatus: 'compartido',
      changedBy: 'Admin',
    });
  });
});
