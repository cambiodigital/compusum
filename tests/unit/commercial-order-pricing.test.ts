import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

/**
 * FASE 4B — REGLAS ANTI-ARBITRARIO de la capa comercial (nivel lib, db mockeada).
 *
 * El motor único de precios es la ÚNICA fuente de verdad monetaria:
 * - El precio del motor SIEMPRE gana sobre cualquier `quotedUnitPrice` del navegador.
 * - El contexto de pricing es ESTRICTAMENTE `order.customerId` (post-lock): nada
 *   del body/líneas puede influir en cliente, perfil, precio o subtotal.
 * - El precio manual solo se acepta para líneas que el PROPIO motor reporta
 *   como requiresQuote, SOLO en modo cotizacion, y SOLO como snapshot del Order.
 * - La conversión cotización→pedido NUNCA re-precia los snapshots acordados.
 * - Toda escritura es atómica: fallo posterior => rollback completo.
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
    update: vi.fn(),
    updateMany: vi.fn(),
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
  },
  priceProfile: {
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

// Espías QUE ENVUELVEN las implementaciones reales: capturan llamadas sin
// alterar el comportamiento del motor. CartValidationError conserva identidad
// de clase (spread de `actual`) para que los `instanceof` de la capa comercial
// sigan funcionando.
vi.mock('@/lib/pricing', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/pricing')>();
  return {
    ...actual,
    resolvePricesForItems: vi.fn(actual.resolvePricesForItems),
    getActivePriceProfile: vi.fn(actual.getActivePriceProfile),
  };
});

vi.mock('@/lib/cart-validation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/cart-validation')>();
  return {
    ...actual,
    validateAndPriceItems: vi.fn(actual.validateAndPriceItems),
  };
});

// ---------- Mini-estado transaccional (idéntico al de rbac) ----------

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
    id: 'quote-a',
    agentId: 'agent-a',
    customerId: 'cust-a',
    requestType: 'cotizacion',
    items: [{ productId: 'p-quote', quantity: 2, unitPrice: null }],
  });
}

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

  mockDb.order.update.mockImplementation(({ where, data }: any) => {
    record('order.update', where.id);
    const order = state.orders.get(where.id);
    if (!order) return null;
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
  mockDb.product.update.mockImplementation((args: any = {}) => {
    record('product.update', args.where?.id);
    const p = state.products.get(args.where?.id);
    if (p) Object.assign(p, args.data);
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

// ---------- Unidades bajo test ----------

import {
  saveCommercialCalculation,
  recalculateCommercialOrder,
  convertQuoteToOrder,
  previewCommercialLines,
  CommercialOrderError,
} from '@/lib/commercial-order';
import { POST as commercialPOST } from '@/app/api/admin/orders/[id]/commercial/route';
import { resolvePricesForItems, getActivePriceProfile } from '@/lib/pricing';
import { validateAndPriceItems } from '@/lib/cart-validation';

const AGENT_A = { id: 'agent-a', role: 'AGENT', name: 'Asesor A' };
const ADMIN_ACTOR = { id: 'admin-1', role: 'admin', name: 'Admin' };

function req(url: string, init?: RequestInit): NextRequest {
  return new Request(url, init) as unknown as NextRequest;
}

function idParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

function freshState() {
  const state = makeState();
  seedBaseFixtures(state);
  installDb(state);
  return state;
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.currentUser = ADMIN_ACTOR
    ? { id: ADMIN_ACTOR.id, name: ADMIN_ACTOR.name, email: 'admin@test.com', role: ADMIN_ACTOR.role }
    : null;
});

describe('Motor de precios: el precio server-side SIEMPRE gana', () => {
  it('quotedUnitPrice: 1 del AGENT se ignora; snapshot = 10000 y subtotal = 10000 × qty', async () => {
    const state = freshState();

    const result = await saveCommercialCalculation({
      orderId: 'order-a',
      actor: AGENT_A,
      lines: [{ productId: 'p-eng', quantity: 2, quotedUnitPrice: 1 }],
    });

    const created = (mockDb.orderItem.createMany as any).mock.calls[0][0].data;
    expect(created[0].unitPrice).toBe(10000);
    expect(state.items.get('order-a')![0].unitPrice).toBe(10000);
    expect(state.orders.get('order-a')!.subtotal).toBe(20000);
    expect(result.lines[0].snapshotUnitPrice).toBe(10000);
  });

  it('customerId/priceProfileId del navegador (body y líneas) NO influyen: el contexto es ESTRICTAMENTE order.customerId', async () => {
    const state = freshState();

    const res = await commercialPOST(
      req('http://localhost/api/admin/orders/order-a/commercial', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          action: 'save',
          customerId: 'cust-b',
          priceProfileId: 'other',
          lines: [
            {
              productId: 'p-eng',
              quantity: 2,
              customerId: 'cust-b',
              priceProfileId: 'other',
              quotedUnitPrice: 1,
            },
          ],
        }),
      }),
      idParams('order-a')
    );
    expect(res.status).toBe(200);

    // TODAS las llamadas del motor recibieron el cliente del PEDIDO, nunca
    // el enviado por el navegador.
    expect(resolvePricesForItems).toHaveBeenCalled();
    for (const [, ctx] of (resolvePricesForItems as any).mock.calls as [any, any][]) {
      expect(ctx.customerId).toBe('cust-a');
    }
    for (const [customerId] of (getActivePriceProfile as any).mock.calls as [any][]) {
      expect(customerId).toBe('cust-a');
    }

    // El snapshot sigue siendo el precio del perfil de Customer A (10000).
    expect(state.items.get('order-a')![0].unitPrice).toBe(10000);
    expect(state.orders.get('order-a')!.subtotal).toBe(20000);
  });

  it('requiresQuote: precio manual 8500 se guarda SOLO como snapshot del Order; Producto/PriceProfile intactos', async () => {
    const state = freshState();

    const result = await saveCommercialCalculation({
      orderId: 'quote-a',
      actor: AGENT_A,
      lines: [{ productId: 'p-quote', quantity: 2, quotedUnitPrice: 8500 }],
    });

    expect(result.lines[0].snapshotUnitPrice).toBe(8500);
    expect(result.isComplete).toBe(true);
    expect(result.canConvert).toBe(true);
    expect(state.items.get('quote-a')![0].unitPrice).toBe(8500);
    expect(state.orders.get('quote-a')!.subtotal).toBe(17000);

    // CERO writes sobre producto/perfil/override globales.
    expect(mockDb.product.update).not.toHaveBeenCalled();
    expect(mockDb.product.create).not.toHaveBeenCalled();
    expect(mockDb.priceProfile.update).not.toHaveBeenCalled();
    expect(mockDb.priceProfile.create).not.toHaveBeenCalled();
    expect(mockDb.priceProfileProduct.create).not.toHaveBeenCalled();
    expect(mockDb.priceProfileProduct.update).not.toHaveBeenCalled();
    expect(mockDb.priceProfileVariant.create).not.toHaveBeenCalled();
    expect(mockDb.priceProfileVariant.update).not.toHaveBeenCalled();
    expect(state.products.get('p-quote')).toMatchObject({ price: 0, wholesalePrice: 0 });
  });

  it('modo pedido: quotedUnitPrice se ignora POR COMPLETO (línea cotizable => rechazo completo)', async () => {
    const state = freshState();

    // Con precio de motor: el manual (8000 vs 10000) jamás aplica.
    await saveCommercialCalculation({
      orderId: 'order-a',
      actor: AGENT_A,
      lines: [{ productId: 'p-eng', quantity: 2, quotedUnitPrice: 8000 }],
    });
    expect(state.items.get('order-a')![0].unitPrice).toBe(10000);
    expect(state.orders.get('order-a')!.subtotal).toBe(20000);

    // Sobre un producto cotizable en modo pedido: ni manual ni motor valen,
    // el guardado completo se rechaza con 400 y CERO writes.
    const opsBefore = state.ops.length;
    await expect(
      saveCommercialCalculation({
        orderId: 'order-a',
        actor: AGENT_A,
        lines: [{ productId: 'p-quote', quantity: 2, quotedUnitPrice: 5000 }],
      })
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('requiere cotización'),
    });
    expect(state.items.get('order-a')).toHaveLength(1);
    expect(state.ops.slice(opsBefore)).toHaveLength(0);
  });

  it.each([
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['0', 0],
    ['-5', -5],
    ['1e12 (sobre el tope)', 1e12],
  ])('precio manual inválido (%s) => 400 ANTES de cualquier transacción/db', async (_name, quoted) => {
    freshState();

    await expect(
      saveCommercialCalculation({
        orderId: 'order-a',
        actor: AGENT_A,
        lines: [{ productId: 'p-quote', quantity: 2, quotedUnitPrice: quoted as number }],
      })
    ).rejects.toMatchObject({ status: 400 });

    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockDb.product.findMany).not.toHaveBeenCalled();
    expect(mockDb.order.findUnique).not.toHaveBeenCalled();
  });
});

describe('Cotizaciones: completar, dejar incompleta y convertir', () => {
  it('cotización incompleta: línea sin quotedUnitPrice se guarda con precio null; convert => 400 y CERO writes', async () => {
    const state = freshState();

    const result = await saveCommercialCalculation({
      orderId: 'quote-a',
      actor: AGENT_A,
      lines: [{ productId: 'p-quote', quantity: 2 }],
    });

    expect(result.lines[0].snapshotUnitPrice).toBeNull();
    expect(result.isComplete).toBe(false);
    expect(result.canConvert).toBe(false);
    expect(state.items.get('quote-a')![0].unitPrice).toBeNull();
    expect(state.orders.get('quote-a')!.requestType).toBe('cotizacion');

    const historyBefore = state.history.length;
    const opsBefore = state.ops.length;

    await expect(
      convertQuoteToOrder({ orderId: 'quote-a', actor: AGENT_A })
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('sin precio'),
    });

    expect(state.ops.slice(opsBefore)).toHaveLength(0);
    expect(state.history).toHaveLength(historyBefore);
    expect(state.orders.get('quote-a')!.requestType).toBe('cotizacion');
    expect(state.items.get('quote-a')![0].unitPrice).toBeNull();
  });

  it('conversión: snapshots preservados EXACTAMENTE (sin re-pricing), subtotal correcto, auditoría y validateAndPriceItems NUNCA llamado', async () => {
    const state = freshState();
    seedOrder(state, {
      id: 'quote-mixed',
      agentId: 'agent-a',
      customerId: 'cust-a',
      requestType: 'cotizacion',
      items: [
        { productId: 'p-eng', quantity: 2, unitPrice: 10000 },
        { productId: 'p-quote', quantity: 1, unitPrice: 8500 },
      ],
    });
    const itemsBefore = JSON.parse(JSON.stringify(state.items.get('quote-mixed')));

    vi.mocked(validateAndPriceItems).mockClear();
    const result = await convertQuoteToOrder({ orderId: 'quote-mixed', actor: AGENT_A });

    // requestType promovido y snapshots intactos (mismos ids, precios, qty).
    expect(result.requestType).toBe('pedido');
    expect(state.orders.get('quote-mixed')!.requestType).toBe('pedido');
    expect(state.orders.get('quote-mixed')!.subtotal).toBe(28500);
    expect(JSON.parse(JSON.stringify(state.items.get('quote-mixed')))).toEqual(itemsBefore);

    // La conversión NO re-precia: ni deleteMany/createMany ni el motor.
    expect(validateAndPriceItems).not.toHaveBeenCalled();
    expect(mockDb.orderItem.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.orderItem.createMany).not.toHaveBeenCalled();

    expect(state.history).toHaveLength(1);
    expect(state.history[0]).toMatchObject({
      orderId: 'quote-mixed',
      changedBy: 'Asesor A',
      note: 'Cotización convertida en pedido',
    });
  });

  it('recalculate en cotización: conserva el precio negociado de la línea requiresQuote y re-precia la del motor', async () => {
    const state = freshState();
    seedOrder(state, {
      id: 'quote-recalc',
      agentId: 'agent-a',
      customerId: 'cust-a',
      requestType: 'cotizacion',
      items: [
        { productId: 'p-eng', quantity: 2, unitPrice: 999 },
        { productId: 'p-quote', quantity: 1, unitPrice: 8500 },
      ],
    });

    const result = await recalculateCommercialOrder({
      orderId: 'quote-recalc',
      actor: AGENT_A,
    });

    const items = state.items.get('quote-recalc')!;
    const byProduct = new Map(items.map((i) => [i.productId, i]));
    // El motor manda para el producto con precio (antes 999).
    expect(byProduct.get('p-eng')!.unitPrice).toBe(10000);
    // El negociado sobrevive en la línea que el motor sigue reportando requiresQuote.
    expect(byProduct.get('p-quote')!.unitPrice).toBe(8500);
    expect(state.orders.get('quote-recalc')!.subtotal).toBe(28500);
    expect(result.requestType).toBe('cotizacion');
  });
});

describe('Atomicidad y validaciones del motor (guardas agnósticas)', () => {
  it('rollback: fallo de auditoría tras reemplazar líneas => OrderItems/subtotal/requestType/historial intactos', async () => {
    const state = freshState();
    const itemsBefore = JSON.parse(JSON.stringify(state.items.get('quote-a')));
    const historyBefore = state.history.length;

    state.historyThrow = new Error('audit boom');

    await expect(
      saveCommercialCalculation({
        orderId: 'quote-a',
        actor: AGENT_A,
        lines: [{ productId: 'p-quote', quantity: 2, quotedUnitPrice: 8500 }],
      })
    ).rejects.toThrow('audit boom');

    // El reemplazo de líneas SÍ se preparó (delete + create) antes del fallo...
    const opsOps = state.ops.map((o) => o.op);
    expect(opsOps).toContain('orderItem.deleteMany');
    expect(opsOps).toContain('orderItem.createMany');

    // ...y TODAS las escrituras se intentaron dentro de la transacción.
    expect(state.ops.every((o) => o.inTx)).toBe(true);

    // Rollback completo: estado EXACTAMENTE el original.
    expect(JSON.parse(JSON.stringify(state.items.get('quote-a')))).toEqual(itemsBefore);
    expect(state.orders.get('quote-a')!.subtotal).toBe(0);
    expect(state.orders.get('quote-a')!.requestType).toBe('cotizacion');
    expect(state.history).toHaveLength(historyBefore);
  });

  it('producto inactivo / cantidad mínima: save rechaza 400 vía validateAndPriceItems', async () => {
    freshState();

    await expect(
      saveCommercialCalculation({
        orderId: 'order-a',
        actor: AGENT_A,
        lines: [{ productId: 'p-inactive', quantity: 1 }],
      })
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('no está disponible'),
    });

    await expect(
      saveCommercialCalculation({
        orderId: 'order-a',
        actor: AGENT_A,
        lines: [{ productId: 'p-eng', quantity: 1 }],
      })
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('cantidad mínima'),
    });

    expect(mockDb.orderItem.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.orderItem.createMany).not.toHaveBeenCalled();
    expect(mockDb.order.updateMany).not.toHaveBeenCalled();
  });

  it('producto inactivo / cantidad mínima: convert rechaza 400 vía lineValidationIssue (sin depender del motor de precios)', async () => {
    const state = freshState();
    seedOrder(state, {
      id: 'quote-inactive',
      agentId: 'agent-a',
      customerId: 'cust-a',
      requestType: 'cotizacion',
      items: [{ productId: 'p-inactive', quantity: 1, unitPrice: 5000 }],
    });
    seedOrder(state, {
      id: 'quote-minqty',
      agentId: 'agent-a',
      customerId: 'cust-a',
      requestType: 'cotizacion',
      items: [{ productId: 'p-eng', quantity: 1, unitPrice: 10000 }],
    });

    const opsBefore = state.ops.length;
    await expect(
      convertQuoteToOrder({ orderId: 'quote-inactive', actor: AGENT_A })
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('no está disponible'),
    });

    await expect(
      convertQuoteToOrder({ orderId: 'quote-minqty', actor: AGENT_A })
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('cantidad mínima'),
    });

    expect(state.ops.slice(opsBefore)).toHaveLength(0);
    expect(state.orders.get('quote-inactive')!.requestType).toBe('cotizacion');
    expect(state.orders.get('quote-minqty')!.requestType).toBe('cotizacion');
  });

  it('preview de líneas: refleja precio del motor vs manual propuesto SIN escribir nada', async () => {
    freshState();

    const preview = await previewCommercialLines('quote-a', AGENT_A, [
      { productId: 'p-quote', quantity: 2, quotedUnitPrice: 8500 },
    ]);

    expect(preview.canEdit).toBe(true);
    expect(preview.isComplete).toBe(true);
    expect(preview.subtotal).toBe(17000);
    expect(preview.lines[0]).toMatchObject({
      engineRequiresQuote: true,
      finalUnitPrice: 8500,
      validationError: null,
    });

    // Read-only: cero operaciones de escritura.
    expect(mockDb.orderItem.deleteMany).not.toHaveBeenCalled();
    expect(mockDb.orderItem.createMany).not.toHaveBeenCalled();
    expect(mockDb.order.updateMany).not.toHaveBeenCalled();
    expect(mockDb.orderStatusHistory.create).not.toHaveBeenCalled();
  });
});
