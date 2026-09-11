import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * FASE 3 — VOLVER A PEDIR y EDITAR.
 *
 * El pedido origen queda SIEMPRE intacto; el carrito se carga con precios
 * ACTUALES del motor (perfil del visor); conflictos con carrito existente
 * se resuelven con decisión explícita; edición solo en 'solicitado'.
 */

const mockDb = vi.hoisted(() => ({
  $transaction: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db: mockDb }));

const mockAuth = vi.hoisted(() => ({
  getCurrentUser: vi.fn().mockResolvedValue(null),
  isAdminRole: vi.fn().mockReturnValue(false),
}));

vi.mock('@/lib/auth', () => mockAuth);

import { reorderOrderItems, ReorderError } from '@/lib/order-reorder';
import { editCustomerOrder, OrderEditError } from '@/lib/order-edit';

const PRODUCT = {
  id: 'p1',
  name: 'Cuaderno Norma',
  isActive: true,
  stockQuantity: 100,
  stockStatus: 'disponible',
  minWholesaleQty: 1,
  price: 10000,
  wholesalePrice: 10000,
  variants: [],
};

function makeOrder(overrides: any = {}) {
  return {
    id: 'order-1',
    orderNumber: 'CS-20260907-0001',
    customerId: 'cust-A',
    sessionId: null,
    status: 'compartido',
    requestType: 'pedido',
    subtotal: 20000,
    items: [
      {
        id: 'oi1',
        productId: 'p1',
        productName: 'Cuaderno Norma',
        productSku: 'SKU-1',
        variantId: null,
        variantName: null,
        variantCode: null,
        quantity: 2,
        unitPrice: 10000, // snapshot histórico
      },
    ],
    ...overrides,
  };
}

function makeDb(opts: { order?: any; cart?: any; cartItems?: any[]; product?: any; users?: Record<string, any> } = {}) {
  const writes = {
    deletedCartItems: 0,
    createdCartItems: [] as any[],
    updatedOrderItems: 0,
    deletedOrderItems: 0,
    historyEntries: [] as any[],
  };

  // La edición condensada debe reflejarse en las lecturas posteriores
  // (updateMany condicionado + re-lectura final dentro de la tx).
  let lastUpdateData: any = {};

  const db = {
    $transaction: vi.fn(async (fn: any) => fn(db)),
    // Lock pesimista: SELECT ... FOR UPDATE (Order en edición, Cart en reorder)
    $queryRaw: vi.fn().mockResolvedValue([{ id: 'order-1', status: 'solicitado' }]),
    city: {
      findUnique: vi.fn().mockResolvedValue({ id: 'city-1', name: 'Bogotá' }),
    },
    order: {
      findUnique: vi.fn().mockImplementation(() =>
        Promise.resolve(opts.order ? { ...opts.order, ...lastUpdateData } : null)
      ),
      update: vi.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({ ...opts.order, ...data, items: opts.order.items })
      ),
      updateMany: vi.fn().mockImplementation(({ data }: any) => {
        lastUpdateData = { ...lastUpdateData, ...data };
        return Promise.resolve({ count: 1 });
      }),
    },
    orderItem: {
      deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
      createMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    orderStatusHistory: {
      create: vi.fn().mockImplementation(({ data }: any) => {
        writes.historyEntries.push(data);
        return Promise.resolve({});
      }),
    },
    product: {
      findMany: vi.fn().mockResolvedValue([opts.product ?? PRODUCT]),
    },
    cart: {
      findFirst: vi.fn().mockResolvedValue(opts.cart ?? null),
      findUnique: vi.fn().mockResolvedValue(opts.cart ?? null),
      create: vi.fn().mockResolvedValue(
        opts.cart ?? { id: 'cart-new', uuid: 'uuid-new', sessionId: 'sess-A', status: 'activo' }
      ),
      update: vi.fn().mockResolvedValue({}),
    },
    cartItem: {
      findMany: vi.fn().mockResolvedValue(opts.cartItems ?? []),
      deleteMany: vi.fn().mockImplementation(() => {
        writes.deletedCartItems++;
        return Promise.resolve({ count: 1 });
      }),
      createMany: vi.fn().mockImplementation(({ data }: any) => {
        writes.createdCartItems.push(...data);
        return Promise.resolve({ count: data.length });
      }),
    },
    user: {
      // getActivePriceProfile lee role/isActive/priceProfile desde aquí.
      findUnique: vi.fn().mockImplementation(({ where }: any) =>
        Promise.resolve(opts.users?.[where.id] ?? null)
      ),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
    },
    priceProfileProduct: { findMany: vi.fn().mockResolvedValue([]) },
    priceProfileVariant: { findMany: vi.fn().mockResolvedValue([]) },
    writes,
  };
  return db;
}

const viewerA = { user: { id: 'cust-A', role: 'CUSTOMER' }, sessionId: null };
const viewerB = { user: { id: 'cust-B', role: 'CUSTOMER' }, sessionId: null };

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.$transaction.mockReset();
});

describe('reorderOrderItems: el pedido origen queda intacto', () => {
  it('nunca modifica el pedido origen ni sus snapshots', async () => {
    const order = makeOrder();
    const db = makeDb({ order });
    mockDb.$transaction.mockImplementation(async (fn: any) => fn(db));
    Object.assign(mockDb, db);

    const result = await reorderOrderItems({ orderId: 'order-1', viewer: viewerA });

    expect(db.order.update).not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.orderItem.deleteMany).not.toHaveBeenCalled();
    // Snapshot histórico intacto en el reporte
    expect(result.items[0].historicalUnitPrice).toBe(10000);
  });

  it('carga el carrito con el precio ACTUAL (10000 histórico → 12000 actual)', async () => {
    const order = makeOrder();
    const product = { ...PRODUCT, price: 12000, wholesalePrice: 12000 };
    const cart = { id: 'cart-1', uuid: 'uuid-1', sessionId: null, userId: 'cust-A', status: 'activo' };
    const db = makeDb({ order, cart, product });
    Object.assign(mockDb, db);
    mockDb.$transaction.mockImplementation(async (fn: any) => fn(db));

    const result = await reorderOrderItems({ orderId: 'order-1', viewer: viewerA });

    expect(result.addedCount).toBe(1);
    expect(result.priceChanged).toBe(true);
    // Línea escrita con precio actual 12000, NO el histórico
    expect(db.writes.createdCartItems[0].unitPrice).toBe(12000);
    // El pedido origen sigue en 10000 (no hay escritura de orderItem)
    expect(db.writes.updatedOrderItems).toBe(0);
  });

  it('perfil A ≠ perfil B: el precio del carrito depende del visor', async () => {
    const orderA = makeOrder(); // customerId cust-A
    const orderB = makeOrder({ id: 'order-B', customerId: 'cust-B' }); // su propio pedido
    const cart = { id: 'cart-1', uuid: 'uuid-1', sessionId: null, userId: 'cust-A', status: 'activo' };
    const db = makeDb({
      order: orderA,
      cart,
      users: {
        'cust-A': {
          isActive: true,
          role: 'CUSTOMER',
          priceProfile: { id: 'prof-A', code: 'PROF-A', percentAdjustment: 20, isActive: true },
        },
        'cust-B': { isActive: true, role: 'CUSTOMER', priceProfile: null },
      },
    });
    Object.assign(mockDb, db);
    mockDb.$transaction.mockImplementation(async (fn: any) => fn(db));
    (db.order.findUnique as any).mockImplementation(({ where }: any) =>
      Promise.resolve(
        where.id === 'order-1' ? orderA : where.id === 'order-B' ? orderB : null
      )
    );

    // Visor B (sin perfil) repite SU pedido => precio base 10000
    await reorderOrderItems({ orderId: 'order-B', viewer: viewerB });
    expect(db.writes.createdCartItems.at(-1).unitPrice).toBe(10000);

    // Visor A (perfil +20%) repite el suyo => 12000
    const resultA = await reorderOrderItems({ orderId: 'order-1', viewer: viewerA });
    expect(resultA.items[0].currentUnitPrice).toBe(12000);
    expect(db.writes.createdCartItems.at(-1).unitPrice).toBe(12000);
  });

  it('producto eliminado no se omite en silencio: reporta product_removed y NO escribe', async () => {
    const order = makeOrder();
    const db = makeDb({ order, product: undefined });
    (db.product.findMany as any).mockResolvedValue([]); // producto ya no existe
    Object.assign(mockDb, db);
    mockDb.$transaction.mockImplementation(async (fn: any) => fn(db));

    const result = await reorderOrderItems({ orderId: 'order-1', viewer: viewerA });

    expect(result.blockedCount).toBe(1);
    expect(result.items[0].status).toBe('product_removed');
    expect(result.addedCount).toBe(0);
    expect(db.writes.deletedCartItems).toBe(0);
    expect(db.writes.createdCartItems).toHaveLength(0);
  });

  it('stock insuficiente bloquea por defecto (no modifica parcialmente el carrito)', async () => {
    const order = makeOrder({ items: [makeOrder().items[0]] });
    order.items[0].quantity = 50;
    const product = { ...PRODUCT, stockQuantity: 10 };
    const cart = { id: 'cart-1', uuid: 'uuid-1', sessionId: null, userId: 'cust-A', status: 'activo' };
    const db = makeDb({ order, cart, product });
    Object.assign(mockDb, db);
    mockDb.$transaction.mockImplementation(async (fn: any) => fn(db));

    const result = await reorderOrderItems({ orderId: 'order-1', viewer: viewerA });

    expect(result.items[0].status).toBe('exceeds_stock');
    expect(result.items[0].availableQuantity).toBe(10);
    expect(db.writes.deletedCartItems).toBe(0);
  });

  it('allowPartial=true (confirmación explícita) no escribe líneas bloqueadas', async () => {
    const order = makeOrder();
    order.items[0].quantity = 50;
    const product = { ...PRODUCT, stockQuantity: 10 };
    const cart = { id: 'cart-1', uuid: 'uuid-1', sessionId: null, userId: 'cust-A', status: 'activo' };
    const db = makeDb({ order, cart, product });
    Object.assign(mockDb, db);
    mockDb.$transaction.mockImplementation(async (fn: any) => fn(db));

    const result = await reorderOrderItems({
      orderId: 'order-1',
      viewer: viewerA,
      allowPartial: true,
    });

    expect(result.items[0].status).toBe('exceeds_stock');
    expect(result.addedCount).toBe(0);
    expect(db.writes.createdCartItems).toHaveLength(0);
  });

  it('conflicto controlado cuando ya hay carrito y no hay decisión explícita', async () => {
    const order = makeOrder();
    const cart = { id: 'cart-1', uuid: 'uuid-1', sessionId: null, userId: 'cust-A', status: 'activo' };
    const db = makeDb({ order, cart, cartItems: [{ id: 'ci-old', productId: 'p9', variantId: null, quantity: 1 }] });
    Object.assign(mockDb, db);
    mockDb.$transaction.mockImplementation(async (fn: any) => fn(db));

    const result = await reorderOrderItems({ orderId: 'order-1', viewer: viewerA });

    expect(result.conflict).toEqual({ cartItemCount: 1 });
    expect(db.writes.deletedCartItems).toBe(0);
  });

  it('mode=replace limpia el carrito antes de cargar', async () => {
    const order = makeOrder();
    const cart = { id: 'cart-1', uuid: 'uuid-1', sessionId: null, userId: 'cust-A', status: 'activo' };
    const db = makeDb({ order, cart, cartItems: [{ id: 'ci-old', productId: 'p9', variantId: null, quantity: 5 }] });
    Object.assign(mockDb, db);
    mockDb.$transaction.mockImplementation(async (fn: any) => fn(db));

    const result = await reorderOrderItems({ orderId: 'order-1', viewer: viewerA, mode: 'replace' });

    expect(result.conflict).toBeUndefined();
    expect(db.writes.deletedCartItems).toBeGreaterThanOrEqual(1);
    expect(db.writes.createdCartItems).toHaveLength(1);
    expect(db.writes.createdCartItems[0].productId).toBe('p1');
  });

  it('mode=add conserva los productos del carrito y agrega el pedido', async () => {
    const order = makeOrder();
    const cart = { id: 'cart-1', uuid: 'uuid-1', sessionId: null, userId: 'cust-A', status: 'activo' };
    const db = makeDb({
      order,
      cart,
      cartItems: [{ id: 'ci-old', productId: 'p9', variantId: null, quantity: 5 }],
    });
    // El producto del carrito viejo también debe existir para revalidar
    (db.product.findMany as any).mockResolvedValue([
      PRODUCT,
      { ...PRODUCT, id: 'p9', name: 'Lapicero', price: 2000, wholesalePrice: 2000 },
    ]);
    Object.assign(mockDb, db);
    mockDb.$transaction.mockImplementation(async (fn: any) => fn(db));

    const result = await reorderOrderItems({ orderId: 'order-1', viewer: viewerA, mode: 'add' });

    const productIds = db.writes.createdCartItems.map((c: any) => c.productId);
    expect(productIds).toContain('p9');
    expect(productIds).toContain('p1');
  });

  it('CUSTOMER B no puede reordenar el pedido de CUSTOMER A', async () => {
    const order = makeOrder();
    const db = makeDb({ order });
    Object.assign(mockDb, db);
    mockDb.$transaction.mockImplementation(async (fn: any) => fn(db));

    await expect(
      reorderOrderItems({ orderId: 'order-1', viewer: viewerB })
    ).rejects.toMatchObject({ status: 403 });
  });

  it('requiere cotización se carga con unitPrice null (carrito admite cotización)', async () => {
    const order = makeOrder();
    const product = { ...PRODUCT, price: 0, wholesalePrice: null };
    const cart = { id: 'cart-1', uuid: 'uuid-1', sessionId: null, userId: 'cust-A', status: 'activo' };
    const db = makeDb({ order, cart, product });
    Object.assign(mockDb, db);
    mockDb.$transaction.mockImplementation(async (fn: any) => fn(db));

    const result = await reorderOrderItems({ orderId: 'order-1', viewer: viewerA });

    expect(result.items[0].status).toBe('requires_quote');
    expect(db.writes.createdCartItems[0].unitPrice).toBeNull();
  });
});

describe('editCustomerOrder: editar es distinto de volver a pedir', () => {
  it('solo permite editar un pedido explícito en estado solicitado', async () => {
    const order = makeOrder({ status: 'compartido' });
    const db = makeDb({ order });
    Object.assign(mockDb, db);
    mockDb.$transaction.mockImplementation(async (fn: any) => fn(db));

    await expect(
      editCustomerOrder({
        orderId: 'order-1',
        viewer: viewerA,
        sessionUser: { id: 'cust-A', role: 'CUSTOMER' },
        sessionId: null,
        body: { items: [{ productId: 'p1', quantity: 3 }] },
      })
    ).rejects.toMatchObject({ status: 409 });
  });

  it('pedido solicitado: reemplaza líneas re-precidas server-side y audita', async () => {
    const order = makeOrder({ status: 'solicitado' });
    const product = { ...PRODUCT, price: 11000, wholesalePrice: 11000 };
    const db = makeDb({ order, product });
    Object.assign(mockDb, db);
    mockDb.$transaction.mockImplementation(async (fn: any) => fn(db));

    const updated = await editCustomerOrder({
      orderId: 'order-1',
      viewer: viewerA,
      sessionUser: { id: 'cust-A', role: 'CUSTOMER' },
      sessionId: null,
      body: { items: [{ productId: 'p1', quantity: 3 }] },
    });

    // Líneas reemplazadas con precio resuelto ACTUAL (no el histórico)
    const createdItems = (db.orderItem.createMany as any).mock.calls[0][0].data;
    expect(createdItems[0].unitPrice).toBe(11000);
    expect(createdItems[0].quantity).toBe(3);
    // Auditoría: entrada en historial (from = to = solicitado, changedBy cliente)
    expect(db.writes.historyEntries[0]).toMatchObject({
      fromStatus: 'solicitado',
      toStatus: 'solicitado',
      changedBy: 'cliente',
    });
    expect(updated).toBeDefined();
  });

  it('compartido/recibido no permite tocar líneas históricas desde el cliente', async () => {
    for (const status of ['compartido', 'recibido']) {
      const order = makeOrder({ status });
      const db = makeDb({ order });
      Object.assign(mockDb, db);
      mockDb.$transaction.mockImplementation(async (fn: any) => fn(db));

      await expect(
        editCustomerOrder({
          orderId: 'order-1',
          viewer: viewerA,
          sessionUser: { id: 'cust-A', role: 'CUSTOMER' },
          sessionId: null,
          body: { items: [{ productId: 'p1', quantity: 1 }] },
        })
      ).rejects.toBeInstanceOf(OrderEditError);
      expect(db.orderItem.deleteMany).not.toHaveBeenCalled();
    }
  });

  it('pedido con producto que requiere cotización: exigir cotizacion explícita', async () => {
    const order = makeOrder({ status: 'solicitado' });
    const product = { ...PRODUCT, price: 0, wholesalePrice: 0 };
    const db = makeDb({ order, product });
    Object.assign(mockDb, db);
    mockDb.$transaction.mockImplementation(async (fn: any) => fn(db));

    // Como 'pedido' (requestType del order) => rechazo
    await expect(
      editCustomerOrder({
        orderId: 'order-1',
        viewer: viewerA,
        sessionUser: { id: 'cust-A', role: 'CUSTOMER' },
        sessionId: null,
        body: { items: [{ productId: 'p1', quantity: 1 }] },
      })
    ).rejects.toBeInstanceOf(OrderEditError);

    // Cambiando a cotizacion explícitamente => permitido
    const updated = await editCustomerOrder({
      orderId: 'order-1',
      viewer: viewerA,
      sessionUser: { id: 'cust-A', role: 'CUSTOMER' },
      sessionId: null,
      body: {
        items: [{ productId: 'p1', quantity: 1 }],
        requestType: 'cotizacion',
      },
    });
    const createdItems = (db.orderItem.createMany as any).mock.calls.at(-1)[0].data;
    expect(createdItems[0].unitPrice).toBeNull();
    expect(updated.requestType).toBe('cotizacion');
  });

  it('CUSTOMER B no puede editar el pedido de CUSTOMER A', async () => {
    const order = makeOrder({ status: 'solicitado' });
    const db = makeDb({ order });
    Object.assign(mockDb, db);
    mockDb.$transaction.mockImplementation(async (fn: any) => fn(db));

    await expect(
      editCustomerOrder({
        orderId: 'order-1',
        viewer: viewerB,
        sessionUser: { id: 'cust-B', role: 'CUSTOMER' },
        sessionId: null,
        body: { items: [{ productId: 'p1', quantity: 1 }] },
      })
    ).rejects.toMatchObject({ status: 403 });
  });
});
