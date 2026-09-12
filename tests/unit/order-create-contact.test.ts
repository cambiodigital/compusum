import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * FASE 3 — VALIDACIÓN DE CONTACTO EN CHECKOUT.
 *
 * El fallback "Cliente" nunca debe anular la validación: invitados y
 * checkouts asistidos (admin/agent) SIN nombre/teléfono/correo se rechazan
 * con CONTACT_INVALID ANTES de tocar la base de datos. Un CUSTOMER
 * autenticado hereda la identidad de su cuenta (contacto opcional).
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

import { createOrderFromCart, OrderCreateError } from '@/lib/order-create';

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

function makeTx(opts: { cart?: any } = {}) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    cart: {
      findUnique: vi.fn().mockResolvedValue(
        opts.cart ?? {
          id: 'cart-1',
          sessionId: 'sess-1',
          userId: null,
          status: 'activo',
          items: [{ productId: 'p1', variantId: null, quantity: 2 }],
        }
      ),
      update: vi.fn().mockResolvedValue({}),
    },
    order: {
      count: vi.fn().mockResolvedValue(0),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({ ...data, id: 'order-new', items: data.items.create })
      ),
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
        assignedAgentId: null,
        priceProfile: null,
      }),
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'cust-new', assignedAgentId: null }),
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
    priceProfileProduct: { findMany: vi.fn().mockResolvedValue([]) },
    priceProfileVariant: { findMany: vi.fn().mockResolvedValue([]) },
    shippingRoute: { findMany: vi.fn().mockResolvedValue([]) },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockDb.$transaction.mockReset();
});

describe('createOrderFromCart: contacto obligatorio según la sesión', () => {
  it('invitado sin nombre/teléfono/correo => CONTACT_INVALID 400 ANTES de tocar la BD', async () => {
    txShared = makeTx();
    mockDb.$transaction.mockImplementation(async (fn: any) => fn(txShared));

    await expect(
      createOrderFromCart({
        cartId: 'cart-1',
        sessionUser: null,
        sessionId: 'sess-1',
      })
    ).rejects.toMatchObject({
      name: 'OrderCreateError',
      code: 'CONTACT_INVALID',
      status: 400,
      message: 'Ingresa al menos nombre, teléfono o correo',
    });

    // Nunca abrió la transacción de escritura (ni lock del carrito)
    expect(txShared.$queryRaw).not.toHaveBeenCalled();
    expect(txShared.order.create).not.toHaveBeenCalled();
  });

  it('invitado con solo nombre => OK (fallback "Cliente" ya no anula la validación)', async () => {
    txShared = makeTx();
    mockDb.$transaction.mockImplementation(async (fn: any) => fn(txShared));

    const result = await createOrderFromCart({
      cartId: 'cart-1',
      customerName: 'Pedro Pérez',
      sessionUser: null,
      sessionId: 'sess-1',
    });

    expect(result.order.customerName).toBe('Pedro Pérez');
    expect(result.replayed).toBe(false);
  });

  it('CUSTOMER autenticado sin contacto en el body => OK (identidad desde la cuenta)', async () => {
    // Carrito propio del cliente (userId) — la identidad viene de la cuenta
    txShared = makeTx({
      cart: {
        id: 'cart-1',
        sessionId: null,
        userId: 'cust-1',
        status: 'activo',
        items: [{ productId: 'p1', variantId: null, quantity: 2 }],
      },
    });
    mockDb.$transaction.mockImplementation(async (fn: any) => fn(txShared));

    const result = await createOrderFromCart({
      cartId: 'cart-1',
      sessionUser: { id: 'cust-1', role: 'CUSTOMER' },
      sessionId: null,
    });

    expect(result.order.customerName).toBe('Cliente');
    expect(result.order.customerId).toBe('cust-1');
  });

  it('sesión ADMIN (checkout asistido) sin contacto => CONTACT_INVALID 400', async () => {
    txShared = makeTx();
    mockDb.$transaction.mockImplementation(async (fn: any) => fn(txShared));

    await expect(
      createOrderFromCart({
        cartId: 'cart-1',
        sessionUser: { id: 'admin-1', role: 'admin' },
        sessionId: null,
      })
    ).rejects.toMatchObject({
      code: 'CONTACT_INVALID',
      status: 400,
    });

    expect(txShared.order.create).not.toHaveBeenCalled();
  });

  it('espacios/blank en todos los campos de contacto => CONTACT_INVALID (no "Cliente")', async () => {
    txShared = makeTx();
    mockDb.$transaction.mockImplementation(async (fn: any) => fn(txShared));

    await expect(
      createOrderFromCart({
        cartId: 'cart-1',
        customerName: '   ',
        customerEmail: '',
        sessionUser: null,
        sessionId: 'sess-1',
      })
    ).rejects.toMatchObject({ code: 'CONTACT_INVALID', status: 400 });
  });
});

describe('OrderCreateError export', () => {
  it('está exportada para el mapeo del route handler', () => {
    expect(OrderCreateError).toBeDefined();
  });
});
