import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * FASE 3 — SEMÁNTICA CART/ORDER del checkout.
 *
 * Cart = borrador mutable; Order = snapshot histórico de una solicitud
 * enviada. Cada checkout crea SIEMPRE un Order NUEVO (nunca reemplaza un
 * 'solicitado' anterior). Doble submit protegido con lock del carrito +
 * idempotencyKey.
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

import {
  createOrderFromCart,
  OrderCreateError,
} from '@/lib/order-create';
import { createOrderTransactionWithRetry } from '@/lib/order-number';

vi.mock('@/lib/order-number', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/order-number')>();
  return {
    ...actual,
    // Sin retry especial en unit: passthrough de la transacción
    createOrderTransactionWithRetry: vi.fn(async (action: any) => action(txShared)),
  };
});

// tx compartido que reutiliza cada test (se resetea en beforeEach)
let txShared: any;

function makeTx(opts: {
  cart?: any;
  existingOrderForKey?: any;
  profile?: any;
  productOverrides?: any[];
  orderCreated?: any;
} = {}) {
  const createdOrders: any[] = [];
  const tx = {
    $queryRaw: vi.fn().mockResolvedValue([]),
    cart: {
      findUnique: vi.fn().mockResolvedValue(
        opts.cart ?? {
          id: 'cart-1',
          sessionId: 'sess-1',
          userId: null,
          status: 'activo',
          items: [
            { productId: 'p1', variantId: null, quantity: 2 },
          ],
        }
      ),
      update: vi.fn().mockResolvedValue({}),
    },
    order: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockImplementation(({ where }: any) =>
        Promise.resolve(
          where.idempotencyKey ? (opts.existingOrderForKey ?? null) : null
        )
      ),
      create: vi.fn().mockImplementation(({ data }: any) => {
        const seq = tx.order.count.mock.calls.length;
        const created = {
          ...data,
          id: `order-new-${seq}`,
          items: data.items.create,
        };
        createdOrders.push(created);
        return Promise.resolve(created);
      }),
    },
    orderStatusHistory: { create: vi.fn().mockResolvedValue({}) },
    user: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'cust-1',
        name: 'Cliente',
        isActive: true,
        role: 'CUSTOMER',
        phone: null,
        email: null,
        assignedAgentId: 'agent-7',
        priceProfile: opts.profile ?? null,
      }),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(),
      update: vi.fn(),
    },
    product: {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'p1',
          name: 'Cuaderno',
          sku: 'SKU-1',
          isActive: true,
          stockStatus: 'disponible',
          stockQuantity: 100,
          minWholesaleQty: 1,
          price: 6000,
          wholesalePrice: 5000,
          variants: [],
        },
      ]),
    },
    priceProfileProduct: { findMany: vi.fn().mockResolvedValue(opts.productOverrides ?? []) },
    priceProfileVariant: { findMany: vi.fn().mockResolvedValue([]) },
    shippingRoute: { findMany: vi.fn().mockResolvedValue([]) },
    createdOrders,
  };
  return tx;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.$transaction.mockReset();
  mockDb.$transaction.mockImplementation(async (fn: any) => fn(txShared));
  mockAuth.getCurrentUser.mockResolvedValue(null);
});

describe('createOrderFromCart: cada checkout crea un pedido NUEVO', () => {
  it('NO reemplaza un pedido "solicitado" anterior: siempre crea un Order nuevo', async () => {
    txShared = makeTx();

    const result = await createOrderFromCart({
      cartId: 'cart-1',
      customerName: 'Cliente',
      sessionUser: { id: 'cust-1', role: 'CUSTOMER' },
      sessionId: 'sess-1',
    });

    // No existe ninguna búsqueda de "solicitado del cliente" para actualizar:
    // solo create de order.
    expect(txShared.order.create).toHaveBeenCalledTimes(1);
    expect(result.order.orderNumber).toBeDefined();
    expect(result.order.status).toBe('solicitado');
    expect(result.replayed).toBe(false);
  });

  it('toma lock transaccional del carrito (SELECT ... FOR UPDATE)', async () => {
    txShared = makeTx();

    await createOrderFromCart({
      cartId: 'cart-1',
      customerName: 'Invitado',
      sessionUser: null,
      sessionId: 'sess-1',
    });

    expect(txShared.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = txShared.$queryRaw.mock.calls[0][0];
    expect(String(sql)).toContain('FOR UPDATE');
  });

  it('marca el carrito como convertido dentro de la misma transacción', async () => {
    txShared = makeTx();

    await createOrderFromCart({
      cartId: 'cart-1',
      customerName: 'Invitado',
      sessionUser: null,
      sessionId: 'sess-1',
    });

    expect(txShared.cart.update).toHaveBeenCalledWith({
      where: { id: 'cart-1' },
      data: { status: 'convertido', sessionId: null },
    });
  });

  it('rechaza el doble submit: carrito ya convertido => 409 CART_INACTIVE', async () => {
    txShared = makeTx({
      cart: {
        id: 'cart-1',
        sessionId: null, // ya convertido
        userId: null,
        status: 'convertido',
        items: [],
      },
    });

    await expect(
      createOrderFromCart({
        cartId: 'cart-1',
        customerName: 'Invitado',
        sessionUser: null,
        sessionId: 'sess-1',
      })
    ).rejects.toMatchObject({
      code: 'CART_INACTIVE',
      status: 409,
    });
  });

  it('idempotencyKey: un reintento devuelve el pedido ya creado (replayed)', async () => {
    const existing = {
      id: 'order-original',
      orderNumber: 'CS-1',
      sessionId: 'sess-1',
      customerId: null,
      items: [],
    };
    txShared = makeTx({ existingOrderForKey: existing });

    const result = await createOrderFromCart({
      cartId: 'cart-1',
      idempotencyKey: 'key-123',
      customerName: 'Invitado',
      sessionUser: null,
      sessionId: 'sess-1',
    });

    expect(result.order.id).toBe('order-original');
    expect(result.replayed).toBe(true);
    expect(txShared.order.create).not.toHaveBeenCalled();
  });

  it('idempotencyKey de OTRO cliente no permite secuestrar su pedido', async () => {
    const other = { id: 'order-other', sessionId: null, customerId: 'cust-B', items: [] };
    txShared = makeTx({ existingOrderForKey: other });

    await expect(
      createOrderFromCart({
        cartId: 'cart-1',
        idempotencyKey: 'key-robada',
        sessionUser: { id: 'cust-A', role: 'CUSTOMER' },
        sessionId: 'sess-A',
      })
    ).rejects.toBeInstanceOf(Error);
  });

  it('carrito de otro cliente => 403', async () => {
    txShared = makeTx({
      cart: { id: 'cart-x', sessionId: 'sess-otro', userId: null, status: 'activo', items: [{ productId: 'p1', variantId: null, quantity: 1 }] },
    });

    await expect(
      createOrderFromCart({
        cartId: 'cart-x',
        sessionUser: { id: 'cust-A', role: 'CUSTOMER' },
        sessionId: 'sess-A',
      })
    ).rejects.toMatchObject({ code: 'CART_FORBIDDEN', status: 403 });
  });
});

describe('createOrderFromCart: pedido vs cotización', () => {
  it('requestType=cotizacion acepta producto sin precio (unitPrice null persistido)', async () => {
    txShared = makeTx({
      profile: { id: 'prof-q', code: 'COTIZA', name: 'Cotiza', percentAdjustment: null, isActive: true },
      productOverrides: [{ productId: 'p1', wholesalePrice: 0, price: null }],
    });

    const result = await createOrderFromCart({
      cartId: 'cart-1',
      requestType: 'cotizacion',
      sessionUser: { id: 'cust-1', role: 'CUSTOMER' },
      sessionId: 'sess-1',
    });

    expect(result.requestType).toBe('cotizacion');
    expect(result.order.requestType).toBe('cotizacion');
    expect(result.order.items[0].unitPrice).toBeNull();
  });

  it('requestType=pedido (default) rechaza producto que requiere cotización', async () => {
    txShared = makeTx({
      profile: { id: 'prof-q', code: 'COTIZA', name: 'Cotiza', percentAdjustment: null, isActive: true },
      productOverrides: [{ productId: 'p1', wholesalePrice: 0, price: null }],
    });

    await expect(
      createOrderFromCart({
        cartId: 'cart-1',
        sessionUser: { id: 'cust-1', role: 'CUSTOMER' },
        sessionId: 'sess-1',
      })
    ).rejects.toMatchObject({
      code: 'ITEMS_INVALID',
      status: 400,
    });
  });

  it('pedido normal guarda requestType=pedido y precio resuelto del perfil', async () => {
    txShared = makeTx({
      profile: { id: 'prof-1', code: 'VIP', name: 'VIP', percentAdjustment: null, isActive: true },
      productOverrides: [{ productId: 'p1', wholesalePrice: 4200, price: null }],
    });

    const result = await createOrderFromCart({
      cartId: 'cart-1',
      sessionUser: { id: 'cust-1', role: 'CUSTOMER' },
      sessionId: 'sess-1',
    });

    expect(result.order.requestType).toBe('pedido');
    expect(result.order.items[0].unitPrice).toBe(4200);
  });
});

describe('createOrderFromCart: asesor y snapshot', () => {
  it('agentId proviene del maestro del cliente (assignedAgentId), no del body', async () => {
    txShared = makeTx();

    const result = await createOrderFromCart({
      cartId: 'cart-1',
      sessionUser: { id: 'cust-1', role: 'CUSTOMER' },
      sessionId: 'sess-1',
    });

    expect(result.order.agentId).toBe('agent-7');
    expect(result.order.customerId).toBe('cust-1');
  });

  it('los items se crean como snapshot con los precios resueltos server-side', async () => {
    txShared = makeTx();

    const result = await createOrderFromCart({
      cartId: 'cart-1',
      customerName: 'Invitado',
      sessionUser: null,
      sessionId: 'sess-1',
    });

    expect(result.order.items[0]).toMatchObject({
      productId: 'p1',
      quantity: 2,
      unitPrice: 5000, // precio base (invitado), nunca dato del navegador
    });
  });

  it('histórico: dos pedidos consecutivos no comparten identidad', async () => {
    txShared = makeTx();

    const first = await createOrderFromCart({
      cartId: 'cart-1',
      customerName: 'Invitado',
      sessionUser: null,
      sessionId: 'sess-1',
    });
    const second = await createOrderFromCart({
      cartId: 'cart-1',
      customerName: 'Invitado',
      sessionUser: null,
      sessionId: 'sess-1',
    });

    expect(txShared.order.create).toHaveBeenCalledTimes(2);
    expect(first.order.id).not.toBe(second.order.id);
  });
});

describe('createOrderTransactionWithRetry', () => {
  it('no reintenta por colisión de idempotencyKey (solo orderNumber)', async () => {
    const error: any = new Error('dup');
    error.code = 'P2002';
    error.meta = { target: ['idempotencyKey'] };

    const tx = { dummy: true };
    let calls = 0;
    await expect(
      createOrderTransactionWithRetry(async () => {
        calls++;
        throw error;
      }, mockDb as any, 3)
    ).rejects.toThrow('dup');
    expect(calls).toBe(1);
  });
});
