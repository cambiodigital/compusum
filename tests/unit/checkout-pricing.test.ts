import { describe, it, expect, vi, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';

/**
 * CHECKOUT — RUTA ÚNICA + MOTOR ÚNICO DE PRECIOS.
 *
 * La ruta legada POST /api/carts/checkout (processCheckout: sin lock de
 * carrito, sin idempotencia, sin conversión ni historial) fue RETIRADA. El
 * único camino de checkout es `createOrderFromCart` (POST /api/orders), que
 * concentra lock + idempotencia + historial. Este archivo conserva la
 * cobertura del motor de precios retargeteada a la ruta canónica.
 *
 * Se mockea `@/lib/db` para controlar la transacción y verificar que
 * OrderItem guarda exactamente el precio resuelto server-side.
 */

const mockDb = vi.hoisted(() => ({
  $transaction: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  db: mockDb,
}));

const mockAuth = vi.hoisted(() => ({
  getCurrentUser: vi.fn().mockResolvedValue(null),
  isAdminRole: vi.fn().mockReturnValue(false),
  // upsertCheckoutCustomer crea usuarios invitados con password temporal
  hashPassword: vi.fn(async () => 'hash-temporal'),
}));

vi.mock('@/lib/auth', () => mockAuth);

import { validateAndPriceItems, CartValidationError } from '@/lib/cart-validation';
import * as checkout from '@/lib/checkout';
import { createOrderFromCart } from '@/lib/order-create';

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

const product = {
  id: 'p1',
  name: 'Cuaderno Norma 100h',
  sku: 'SKU-100H',
  isActive: true,
  stockStatus: 'disponible',
  stockQuantity: 100,
  minWholesaleQty: 1,
  price: 6000,
  wholesalePrice: 5000,
  variants: [],
};

function makeTx(opts: { profile?: any; productOverrides?: any[]; vipCustomer?: any } = {}) {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    cart: {
      findUnique: vi.fn().mockResolvedValue({
        id: 'cart-1',
        sessionId: 'sess-1',
        userId: null,
        status: 'activo',
        items: [{ productId: 'p1', variantId: null, quantity: 2 }],
      }),
      update: vi.fn().mockResolvedValue({}),
    },
    order: {
      count: vi.fn().mockResolvedValue(3),
      findFirst: vi.fn().mockResolvedValue(null),
      findUnique: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockImplementation(({ data }: any) =>
        Promise.resolve({ id: 'order-1', ...data, items: data.items.create })
      ),
    },
    orderStatusHistory: { create: vi.fn().mockResolvedValue({}) },
    user: {
      // Misma respuesta para getActivePriceProfile y resolveOrderCustomer
      findUnique: vi.fn().mockResolvedValue({
        id: 'cust-1',
        name: 'Cliente VIP',
        isActive: true,
        role: 'CUSTOMER',
        phone: null,
        email: null,
        assignedAgentId: null,
        priceProfile: opts.profile ?? null,
      }),
      findFirst: vi.fn().mockResolvedValue(opts.vipCustomer ?? null),
      create: vi.fn().mockResolvedValue({ id: 'cust-1', assignedAgentId: null }),
      update: vi
        .fn()
        .mockImplementation(({ data }: any) =>
          Promise.resolve({ id: 'cust-1', name: 'Cliente VIP', isActive: true, phone: null, email: null, assignedAgentId: null, ...data })
        ),
    },
    priceProfileProduct: { findMany: vi.fn().mockResolvedValue(opts.productOverrides ?? []) },
    priceProfileVariant: { findMany: vi.fn().mockResolvedValue([]) },
    shippingRoute: { findMany: vi.fn().mockResolvedValue([]) },
    product: {
      findMany: vi.fn().mockResolvedValue([product]),
    },
  };
}

beforeEach(() => {
  mockDb.$transaction.mockReset();
  mockDb.$transaction.mockImplementation(async (fn: any) => fn(txShared));
  mockAuth.getCurrentUser.mockResolvedValue(null);
});

describe('Checkout: ruta única (ruta legada retirada)', () => {
  it('processCheckout ya no existe: el único camino es createOrderFromCart', () => {
    expect((checkout as any).processCheckout).toBeUndefined();
    expect(typeof createOrderFromCart).toBe('function');
  });

  it('la ruta legada src/app/api/carts/checkout/route.ts fue eliminada', () => {
    expect(
      existsSync(path.join(process.cwd(), 'src', 'app', 'api', 'carts', 'checkout', 'route.ts'))
    ).toBe(false);
  });
});

describe('Checkout: el precio SIEMPRE se recalcula server-side (ruta canónica)', () => {
  it('OrderItem guarda exactamente el precio resuelto por el motor (perfil con override)', async () => {
    txShared = makeTx({
      profile: { id: 'prof-1', code: 'VIP', name: 'VIP', percentAdjustment: null, isActive: true },
      productOverrides: [{ productId: 'p1', wholesalePrice: 4200, price: null }],
    });

    const { order } = await createOrderFromCart({
      cartId: 'cart-1',
      customerName: 'Cliente VIP',
      sessionUser: { id: 'cust-1', role: 'CUSTOMER' },
      sessionId: 'sess-1',
    });

    // El precio del perfil (4200), NO el base (5000) ni nada enviado por navegador
    expect(order.items[0].unitPrice).toBe(4200);
    expect(order.subtotal).toBe(4200 * 2);
  });

  it('checkout de INVITADO con email de un cliente VIP => precio BASE (nunca el perfil)', async () => {
    txShared = makeTx({
      // Existe un cliente con perfil para ese contacto, pero el comprador es invitado
      profile: { id: 'prof-1', code: 'VIP', name: 'VIP', percentAdjustment: -50, isActive: true },
      // upsertCheckoutCustomer encuentra al cliente existente por contacto
      vipCustomer: {
        id: 'cust-vip',
        name: 'Cliente VIP',
        email: 'vip@cliente.com',
        assignedAgentId: 'agent-7',
      },
    });

    const { order } = await createOrderFromCart({
      cartId: 'cart-1',
      customerName: 'Suplantador',
      customerEmail: 'vip@cliente.com',
      sessionUser: null,
      sessionId: 'sess-1',
      // Intento de suplantación: sin sesión, solo contacto
    });

    // Precio base 5000, NO 2500 (perfil -50%); el enlace CRM no cambia el precio
    expect(order.items[0].unitPrice).toBe(5000);
    expect(order.subtotal).toBe(10000);
    expect(order.customerId).toBe('cust-vip');
  });

  it('subtotal calculado server-side desde los precios resueltos', async () => {
    txShared = makeTx();

    const { order } = await createOrderFromCart({
      cartId: 'cart-1',
      customerName: 'Invitado',
      customerPhone: '3111111111',
      sessionUser: null,
      sessionId: 'sess-1',
    });

    expect(order.subtotal).toBe(5000 * 2);
  });

  it('cliente sin perfil => precio base en el pedido', async () => {
    txShared = makeTx();

    const { order } = await createOrderFromCart({
      cartId: 'cart-1',
      customerName: 'Normal',
      sessionUser: { id: 'cust-1', role: 'CUSTOMER' },
      sessionId: 'sess-1',
    });

    expect(order.items[0].unitPrice).toBe(5000);
  });
});

describe('Motor único: invariantes que sostienen la ruta canónica', () => {
  it('no existe vía para aceptar unitPrice del cliente en los items', async () => {
    const tx = makeTx();
    const result = await validateAndPriceItems(
      // El navegador "envía" unitPrice 1; la función ni siquiera lo acepta
      [
        { productId: 'p1', quantity: 2 },
        // @ts-expect-error campo extra que el navegador podría mandar
        { productId: 'p1', quantity: 1, unitPrice: 1 },
      ],
      tx
    );
    expect(result.validatedItems).toHaveLength(2);
    for (const item of result.validatedItems) {
      expect(item.unitPrice).toBe(5000);
    }
    expect(result.subtotal).toBe(15000);
  });

  it('stock y sobreventa siguen protegidos con contexto de perfil', async () => {
    const tx = makeTx({
      profile: { id: 'prof-1', code: 'VIP', name: 'VIP', percentAdjustment: null, isActive: true },
    });

    await expect(
      validateAndPriceItems(
        [{ productId: 'p1', quantity: 999 }],
        tx,
        { customerId: 'cust-1' }
      )
    ).rejects.toThrow(CartValidationError);
  });

  it('producto con precio 0 en el perfil => requiere cotización (no comprable en pedido)', async () => {
    const tx = makeTx({
      profile: { id: 'prof-1', code: 'COTIZA', name: 'Cotización', percentAdjustment: null, isActive: true },
      productOverrides: [{ productId: 'p1', wholesalePrice: 0, price: null }],
    });

    await expect(
      validateAndPriceItems([{ productId: 'p1', quantity: 1 }], tx, { customerId: 'cust-1' })
    ).rejects.toThrow('requiere cotización');
  });
});
