import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * FASE 3 — ATOMICIDAD DEL REORDER.
 *
 * La fase de escritura ocurre dentro de UNA transacción con lock pesimista
 * del carrito: el estado FINAL se valida ANTES de destruir el carrito
 * anterior. Con allowPartial=false un fallo de stock combinado aborta con
 * CERO writes; con allowPartial=true las líneas combinadas nunca se encogen
 * por debajo de las unidades que el cliente ya tenía.
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

// Stock 10: una línea de 8 en el carrito + 5 del pedido NO caben juntas.
const PRODUCT = {
  id: 'p1',
  name: 'Cuaderno Norma',
  sku: 'SKU-1',
  isActive: true,
  stockQuantity: 10,
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
    subtotal: 50000,
    items: [
      {
        id: 'oi1',
        productId: 'p1',
        productName: 'Cuaderno Norma',
        productSku: 'SKU-1',
        variantId: null,
        variantName: null,
        variantCode: null,
        quantity: 5,
        unitPrice: 10000,
      },
    ],
    ...overrides,
  };
}

type OpRecord = { op: string; inTx: boolean };

function makeDb(opts: { order?: any; cart?: any; cartItems?: any[]; product?: any } = {}) {
  const state = { inTx: false };
  const ops: OpRecord[] = [];
  const record = (op: string) => () => {
    ops.push({ op, inTx: state.inTx });
  };

  const db = {
    $transaction: vi.fn(async (fn: any) => {
      state.inTx = true;
      try {
        return await fn(db);
      } finally {
        state.inTx = false;
      }
    }),
    // Lock pesimista del carrito (SELECT ... FOR UPDATE)
    $queryRaw: vi.fn().mockImplementation(() => {
      ops.push({ op: 'lock', inTx: state.inTx });
      return Promise.resolve([]);
    }),
    order: {
      findUnique: vi.fn().mockResolvedValue(opts.order ?? null),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    orderItem: {
      deleteMany: vi.fn(),
      createMany: vi.fn(),
    },
    orderStatusHistory: { create: vi.fn() },
    product: {
      findMany: vi.fn().mockImplementation(() => {
        ops.push({ op: 'product.findMany', inTx: state.inTx });
        return Promise.resolve([opts.product ?? PRODUCT]);
      }),
    },
    cart: {
      findFirst: vi.fn().mockResolvedValue(opts.cart ?? null),
      findUnique: vi.fn().mockResolvedValue(opts.cart ?? null),
      create: vi.fn().mockResolvedValue(
        opts.cart ?? { id: 'cart-1', uuid: 'uuid-1', sessionId: null, status: 'activo' }
      ),
      update: vi.fn().mockImplementation(() => {
        ops.push({ op: 'cart.update', inTx: state.inTx });
        return Promise.resolve({});
      }),
    },
    cartItem: {
      findMany: vi.fn().mockImplementation(() => {
        ops.push({ op: 'cartItem.findMany', inTx: state.inTx });
        return Promise.resolve(opts.cartItems ?? []);
      }),
      deleteMany: vi.fn().mockImplementation(() => {
        ops.push({ op: 'cartItem.deleteMany', inTx: state.inTx });
        return Promise.resolve({ count: 1 });
      }),
      createMany: vi.fn().mockImplementation(({ data }: any) => {
        ops.push({ op: 'cartItem.createMany', inTx: state.inTx });
        return Promise.resolve({ count: data.length });
      }),
    },
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

function setup(opts: { cartItems?: any[]; mode?: unknown; allowPartial?: boolean } = {}) {
  const order = makeOrder();
  const cart = { id: 'cart-1', uuid: 'uuid-1', sessionId: null, userId: 'cust-A', status: 'activo' };
  const db = makeDb({ order, cart, cartItems: opts.cartItems ?? [] });
  Object.assign(mockDb, db);
  // db.$transaction ya quedó instalado en mockDb por Object.assign
  // (implementación instrumentada con el flag inTx).
  return { db, run: () =>
    reorderOrderItems({
      orderId: 'order-1',
      viewer: viewerA,
      mode: opts.mode,
      allowPartial: opts.allowPartial,
    })
  };
}

beforeEach(() => {
  // Object.assign(mockDb, db) instala el $transaction instrumentado de cada
  // test (clearAllMocks NO borra implementaciones).
  vi.clearAllMocks();
});

describe('reorderOrderItems: atomicidad de la escritura', () => {
  it('replace: deleteMany ocurre DENTRO de la transacción y DESPUÉS del lock y la validación', async () => {
    const { db, run } = setup({
      mode: 'replace',
      cartItems: [{ id: 'ci-old', productId: 'p9', variantId: null, quantity: 5 }],
    });

    await run();

    const ops = db.ops as OpRecord[];
    const lockIdx = ops.findIndex((o) => o.op === 'lock');
    const validateIdx = ops.findIndex((o) => o.op === 'product.findMany' && o.inTx);
    const deleteIdx = ops.findIndex((o) => o.op === 'cartItem.deleteMany');

    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(validateIdx).toBeGreaterThan(lockIdx);
    expect(deleteIdx).toBeGreaterThan(validateIdx);
    // Todo write dentro de la tx; nada directo contra db
    expect(ops.filter((o) => o.op === 'cartItem.deleteMany').every((o) => o.inTx)).toBe(true);
  });

  it('stock combinado 8+5>10 con allowPartial=false => ReorderError y CERO writes', async () => {
    const { db, run } = setup({
      mode: 'add',
      cartItems: [{ id: 'ci-1', productId: 'p1', variantId: null, quantity: 8 }],
    });

    await expect(run()).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('Tu carrito no fue modificado'),
    });

    expect(db.cartItem.deleteMany).not.toHaveBeenCalled();
    expect(db.cartItem.createMany).not.toHaveBeenCalled();
    expect(db.cart.update).not.toHaveBeenCalled();
  });

  it('allowPartial=true con 8+5>10: la línea ORIGINAL de 8 unidades se conserva', async () => {
    const { db, run } = setup({
      mode: 'add',
      allowPartial: true,
      cartItems: [{ id: 'ci-1', productId: 'p1', variantId: null, quantity: 8 }],
    });

    const result = await run();

    // La adición del reorder queda bloqueada por stock
    expect(result.items[0].status).toBe('exceeds_stock');
    expect(result.items[0].currentUnitPrice).toBeNull();
    expect(result.addedCount).toBe(0);

    // Solo una línea escrita: las 8 unidades ORIGINALES (nunca encogidas)
    expect(db.cartItem.createMany).toHaveBeenCalledTimes(1);
    const data = (db.cartItem.createMany as any).mock.calls[0][0].data;
    expect(data).toHaveLength(1);
    expect(data[0]).toMatchObject({ productId: 'p1', quantity: 8, unitPrice: 10000 });
  });

  it('la transacción toma lock FOR UPDATE del carrito y re-lee las líneas DENTRO de la tx', async () => {
    const { db, run } = setup({
      mode: 'add',
      cartItems: [{ id: 'ci-1', productId: 'p9', variantId: null, quantity: 2 }],
    });

    // El producto del carrito viejo también debe existir para revalidar
    (db.product.findMany as any).mockResolvedValue([
      PRODUCT,
      { ...PRODUCT, id: 'p9', name: 'Lapicero', price: 2000, wholesalePrice: 2000 },
    ]);

    await run();

    // Lock con FOR UPDATE
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    expect(String((db.$queryRaw as any).mock.calls[0][0])).toContain('FOR UPDATE');

    // Re-lectura fresca: la lectura externa + la interna (después del lock)
    const ops = db.ops as OpRecord[];
    const reads = ops.filter((o) => o.op === 'cartItem.findMany');
    expect(reads.length).toBeGreaterThanOrEqual(2);
    expect(reads[0].inTx).toBe(false); // lectura externa (chequeo de conflicto)
    expect(reads[reads.length - 1].inTx).toBe(true); // re-lectura dentro de la tx
    const lockIdx = ops.findIndex((o) => o.op === 'lock');
    const freshReadIdx = ops.findIndex((o) => o.op === 'cartItem.findMany' && o.inTx);
    expect(freshReadIdx).toBeGreaterThan(lockIdx);
  });
});
