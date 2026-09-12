import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * FASE 3 — ATOMICIDAD DE LA EDICIÓN DE PEDIDOS.
 *
 * TODAS las escrituras (reemplazo de líneas, update condicionado y auditoría)
 * ocurren dentro de UNA sola transacción con lock pesimista de la fila:
 * nada se escribe si la validación falla y ningún cambio concurrente de
 * estado puede mezclarse a mitad de la edición.
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

import { editCustomerOrder, OrderEditError } from '@/lib/order-edit';

const PRODUCT = {
  id: 'p1',
  name: 'Cuaderno Norma',
  sku: 'SKU-1',
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
    status: 'solicitado',
    requestType: 'pedido',
    subtotal: 20000,
    customerName: 'Cliente A',
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
        unitPrice: 10000,
      },
    ],
    ...overrides,
  };
}

type OpRecord = { op: string; inTx: boolean };

function makeDb(opts: { order?: any; product?: any; city?: any } = {}) {
  const state = { inTx: false };
  const ops: OpRecord[] = [];
  const record = (op: string) => () => {
    ops.push({ op, inTx: state.inTx });
  };

  let lastUpdateData: any = {};

  const db = {
    // La transacción expone el MISMO objeto como tx (estilo mock del repo);
    // el flag inTx permite verificar que cada write ocurrió DENTRO del callback.
    $transaction: vi.fn(async (fn: any) => {
      state.inTx = true;
      try {
        return await fn(db);
      } finally {
        state.inTx = false;
      }
    }),
    // Lock pesimista: fila POST-lock con las columnas que la edición
    // re-autoriza y decide (customerId/sessionId/requestType/customerName).
    $queryRaw: vi.fn().mockResolvedValue([
      {
        id: 'order-1',
        status: 'solicitado',
        customerId: 'cust-A',
        sessionId: null,
        requestType: opts.order?.requestType ?? 'pedido',
        customerName: 'Cliente A',
      },
    ]),
    city: {
      findUnique: vi.fn().mockResolvedValue(opts.city ?? { id: 'city-1', name: 'Bogotá' }),
    },
    order: {
      findUnique: vi.fn().mockImplementation(() =>
        Promise.resolve(opts.order ? { ...opts.order, ...lastUpdateData } : null)
      ),
      update: vi.fn(),
      updateMany: vi.fn().mockImplementation(({ data }: any) => {
        ops.push({ op: 'order.updateMany', inTx: state.inTx });
        lastUpdateData = { ...lastUpdateData, ...data };
        return Promise.resolve({ count: 1 });
      }),
    },
    orderItem: {
      // Re-lectura de líneas BAJO el lock (estado fresco para re-validar).
      findMany: vi.fn().mockImplementation(() =>
        Promise.resolve(opts.order?.items ?? [])
      ),
      deleteMany: vi.fn().mockImplementation(() => {
        ops.push({ op: 'orderItem.deleteMany', inTx: state.inTx });
        return Promise.resolve({ count: 1 });
      }),
      createMany: vi.fn().mockImplementation(() => {
        ops.push({ op: 'orderItem.createMany', inTx: state.inTx });
        return Promise.resolve({ count: 1 });
      }),
    },
    orderStatusHistory: {
      create: vi.fn().mockImplementation(() => {
        ops.push({ op: 'orderStatusHistory.create', inTx: state.inTx });
        return Promise.resolve({});
      }),
    },
    product: {
      findMany: vi.fn().mockResolvedValue([opts.product ?? PRODUCT]),
    },
    cart: {},
    cartItem: {},
    user: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'cust-A',
        isActive: true,
        role: 'CUSTOMER',
        priceProfile: null,
      }),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
    },
    priceProfileProduct: { findMany: vi.fn().mockResolvedValue([]) },
    priceProfileVariant: { findMany: vi.fn().mockResolvedValue([]) },
    ops,
  };
  return db;
}

const viewerA = { user: { id: 'cust-A', role: 'CUSTOMER' }, sessionId: null };
const sessionUserA = { id: 'cust-A', role: 'CUSTOMER' };

beforeEach(() => {
  // Object.assign(mockDb, db) instala el $transaction instrumentado de cada
  // test (clearAllMocks NO borra implementaciones).
  vi.clearAllMocks();
});

describe('editCustomerOrder: atomicidad completa', () => {
  it('items + metadata: deleteMany/createMany/updateMany/history TODOS dentro de una sola $transaction', async () => {
    const order = makeOrder();
    const db = makeDb({ order });
    Object.assign(mockDb, db);

    await editCustomerOrder({
      orderId: 'order-1',
      viewer: viewerA,
      sessionUser: sessionUserA,
      sessionId: null,
      body: {
        items: [{ productId: 'p1', quantity: 3 }],
        notes: 'Entregar en la mañana',
      },
    });

    expect(db.$transaction).toHaveBeenCalledTimes(1);
    const writeOps = db.ops.filter((o: OpRecord) =>
      ['orderItem.deleteMany', 'orderItem.createMany', 'order.updateMany', 'orderStatusHistory.create'].includes(o.op)
    );
    // Cuatro escrituras, todas dentro de la transacción (ninguna directa a db)
    expect(writeOps.map((o: OpRecord) => o.op)).toEqual([
      'orderItem.deleteMany',
      'orderItem.createMany',
      'order.updateMany',
      'orderStatusHistory.create',
    ]);
    expect(writeOps.every((o: OpRecord) => o.inTx)).toBe(true);
  });

  it('el update es condicionado: filtra por status solicitado (guarda anti-carrera)', async () => {
    const order = makeOrder();
    const db = makeDb({ order });
    Object.assign(mockDb, db);

    await editCustomerOrder({
      orderId: 'order-1',
      viewer: viewerA,
      sessionUser: sessionUserA,
      sessionId: null,
      body: { notes: 'nota' },
    });

    expect(db.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order-1', status: 'solicitado' },
      })
    );
  });

  it('cityId inválido falla con 400 ANTES de cualquier write', async () => {
    const order = makeOrder();
    const db = makeDb({ order }); // ciudad no existe
    (db.city.findUnique as any).mockResolvedValue(null);
    Object.assign(mockDb, db);

    await expect(
      editCustomerOrder({
        orderId: 'order-1',
        viewer: viewerA,
        sessionUser: sessionUserA,
        sessionId: null,
        body: {
          items: [{ productId: 'p1', quantity: 3 }],
          cityId: 'NO_EXISTE_CIUDAD',
        },
      })
    ).rejects.toMatchObject({ status: 400, message: 'Ciudad no válida' });

    // Ninguna escritura: ni líneas, ni pedido, ni historial
    expect(db.orderItem.deleteMany).not.toHaveBeenCalled();
    expect(db.orderItem.createMany).not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.orderStatusHistory.create).not.toHaveBeenCalled();
  });

  it('promoción cotización→pedido sin items: revalida, REESCRIBE las líneas y escribe subtotal+requestType', async () => {
    // Línea de cotización sin precio: tras promover, el snapshot debe quedar
    // con el precio re-validado (un pedido jamás conserva unitPrice null).
    const order = makeOrder({ requestType: 'cotizacion' });
    order.items[0].unitPrice = null;
    const db = makeDb({ order });
    Object.assign(mockDb, db);

    await editCustomerOrder({
      orderId: 'order-1',
      viewer: viewerA,
      sessionUser: sessionUserA,
      sessionId: null,
      body: { requestType: 'pedido' },
    });

    // Las líneas se reescriben con los snapshots re-validados
    expect(db.orderItem.deleteMany).toHaveBeenCalledWith({ where: { orderId: 'order-1' } });
    expect(db.orderItem.createMany).toHaveBeenCalledTimes(1);
    const createdItems = (db.orderItem.createMany as any).mock.calls[0][0].data;
    expect(createdItems).toHaveLength(1);
    expect(createdItems[0]).toMatchObject({
      productId: 'p1',
      quantity: 2,
      unitPrice: 10000, // precio re-validado del motor (antes null)
    });

    // Subtotal re-validado (2 × 10000) y tipo promovido
    expect(db.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ requestType: 'pedido', subtotal: 20000 }),
      })
    );
    // Historial auditado
    expect(db.orderStatusHistory.create).toHaveBeenCalledTimes(1);
  });

  it('promoción con línea sin precio válido se rechaza con 400 y el pedido sigue cotización', async () => {
    const order = makeOrder({
      requestType: 'cotizacion',
      items: [makeOrder().items[0]],
    });
    order.items[0].unitPrice = null;
    const quoteProduct = { ...PRODUCT, price: 0, wholesalePrice: 0 };
    const db = makeDb({ order, product: quoteProduct });
    Object.assign(mockDb, db);

    await expect(
      editCustomerOrder({
        orderId: 'order-1',
        viewer: viewerA,
        sessionUser: sessionUserA,
        sessionId: null,
        body: { requestType: 'pedido' },
      })
    ).rejects.toMatchObject({
      status: 400,
      message: expect.stringContaining('No se puede convertir la cotización en pedido'),
    });

    // La razón REAL se propaga al usuario (no un mensaje genérico)
    const caught = await editCustomerOrder({
      orderId: 'order-1',
      viewer: viewerA,
      sessionUser: sessionUserA,
      sessionId: null,
      body: { requestType: 'pedido' },
    }).catch((e) => e);
    expect(caught.message).toContain('requiere cotización');

    expect(db.orderItem.deleteMany).not.toHaveBeenCalled();
    expect(db.orderItem.createMany).not.toHaveBeenCalled();
    expect(db.order.updateMany).not.toHaveBeenCalled();
    expect(db.orderStatusHistory.create).not.toHaveBeenCalled();
  });
});
