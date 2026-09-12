import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/db';
import { createOrderFromCart } from '@/lib/order-create';

/**
 * CARRERA DE ALTA DE CLIENTE en checkout contra PostgreSQL REAL — a través del
 * servicio de producción `createOrderFromCart()`.
 *
 * Dos checkouts invitados CONCURRENTES desde carritos y x-session-id DISTINTOS
 * con el MISMO contacto NUEVO (sin User previo): el advisory de contacto
 * canónico serializa el alta, el perdedor RE-LEE post-lock y ENLAZA al cliente
 * ya confirmado. Resultado obligatorio: exactamente UN Customer, ambos pedidos
 * creados con su snapshot/cart correspondiente, ambos carritos convertidos,
 * CERO P2002 sin manejar, CERO "current transaction is aborted" y CERO estado
 * parcial (el camino anterior: catch P2002 → consulta sobre la tx abortada).
 *
 * Escenarios:
 * 1. Mismo email NUEVO (literal igual en ambos).
 * 2. Mismo teléfono NUEVO expresado en dos formas equivalentes
 *    (`3XXXXXXXXX` local vs `+57XXXXXXXXXX`) => misma clave canónica
 *    `57XXXXXXXXXX` (el camino de resolución por teléfono es el mismo
 *    find→create, pero las claves del advisory y la búsqueda son de teléfono).
 */

const HAS_POSTGRES = Boolean(process.env.DATABASE_URL?.startsWith('postgres'));
const d = it.skipIf(!HAS_POSTGRES);

const RUN = `${Date.now()}`;
const EMAIL = `ccrace-${RUN}@cliente.test`;
const PHONE_LOCAL = `3${RUN.slice(-9)}`; // 10 dígitos, móvil colombiano
const PHONE_CANONICAL = `57${PHONE_LOCAL}`;
const SESS_A = `ccrace-${RUN}-sa`;
const SESS_B = `ccrace-${RUN}-sb`;
const SESS_C = `ccrace-${RUN}-sc`;
const SESS_D = `ccrace-${RUN}-sd`;

let categoryId: string;
let productId: string;
let cartAId: string;
let cartBId: string;
let cartCId: string;
let cartDId: string;

async function seedGuestCart(sessionId: string, quantity: number) {
  const cart = await db.cart.create({
    data: {
      sessionId,
      status: 'activo',
      items: { create: { productId, quantity } },
    },
    include: { items: true },
  });
  return cart.id;
}

beforeAll(async () => {
  if (!HAS_POSTGRES) return;

  const category = await db.category.create({
    data: { name: `Cat ccrace ${RUN}`, slug: `cat-ccrace-${RUN}` },
  });
  categoryId = category.id;

  const product = await db.product.create({
    data: {
      name: 'Producto ccrace',
      slug: `prod-ccrace-${RUN}`,
      price: 10000, // base; guest sin perfil resuelve wholesalePrice (8000)
      wholesalePrice: 8000,
      stockQuantity: 50,
      categoryId,
    },
  });
  productId = product.id;

  cartAId = await seedGuestCart(SESS_A, 2);
  cartBId = await seedGuestCart(SESS_B, 3);
  cartCId = await seedGuestCart(SESS_C, 1);
  cartDId = await seedGuestCart(SESS_D, 4);
}, 30000);

afterAll(async () => {
  if (!HAS_POSTGRES) return;

  const testCartIds = [cartAId, cartBId, cartCId, cartDId].filter(Boolean);
  await db.order.deleteMany({ where: { cartId: { in: testCartIds } } });
  await db.cart.deleteMany({ where: { id: { in: testCartIds } } });
  await db.user.deleteMany({
    where: { OR: [{ email: EMAIL }, { phone: PHONE_CANONICAL }] },
  });
  await db.product.deleteMany({ where: { id: productId } });
  await db.category.deleteMany({ where: { id: categoryId } });
  await db.$disconnect();
}, 30000);

d('T1: dos checkouts guest concurrentes, MISMO email nuevo => 1 cliente, 2 pedidos, 0 errores', async () => {
  // Sin User previo para ese contacto.
  expect(await db.user.count({ where: { email: EMAIL } })).toBe(0);

  const [resultA, resultB] = await Promise.all([
    createOrderFromCart({
      cartId: cartAId,
      customerName: 'Cliente A',
      customerEmail: EMAIL,
      sessionUser: null,
      sessionId: SESS_A,
    }).catch((e) => e),
    createOrderFromCart({
      cartId: cartBId,
      customerName: 'Cliente B',
      customerEmail: EMAIL,
      sessionUser: null,
      sessionId: SESS_B,
    }).catch((e) => e),
  ]);

  // CERO errores: sin 500, sin P2002 sin manejar, sin "current transaction
  // is aborted" (el camino anterior terminaba aquí en tx abortada).
  expect(resultA).not.toBeInstanceOf(Error);
  expect(resultB).not.toBeInstanceOf(Error);
  expect((resultA as any).replayed).toBe(false);
  expect((resultB as any).replayed).toBe(false);

  // Exactamente UN Customer para el email.
  const customers = await db.user.findMany({ where: { email: EMAIL } });
  expect(customers).toHaveLength(1);
  const customer = customers[0];
  expect(customer.role.toLowerCase()).toBe('customer');
  expect(customer.phone).toBeNull();

  // Ambos pedidos creados, cada uno con SU snapshot/cart correspondiente.
  const orderA = await db.order.findUnique({
    where: { id: (resultA as any).order.id },
    include: { items: true },
  });
  const orderB = await db.order.findUnique({
    where: { id: (resultB as any).order.id },
    include: { items: true },
  });
  expect(orderA).not.toBeNull();
  expect(orderB).not.toBeNull();
  expect(orderA!.cartId).toBe(cartAId);
  expect(orderB!.cartId).toBe(cartBId);
  expect(orderA!.customerId).toBe(customer.id);
  expect(orderB!.customerId).toBe(customer.id);
  expect(orderA!.sessionId).toBe(SESS_A);
  expect(orderB!.sessionId).toBe(SESS_B);
  expect(orderA!.customerEmail).toBe(EMAIL);
  expect(orderB!.customerEmail).toBe(EMAIL);
  expect(orderA!.status).toBe('solicitado');
  expect(orderB!.status).toBe('solicitado');

  // Snapshots independientes: cantidades y subtotales de SU carrito
  // (invitado sin perfil => wholesalePrice 8000 por unidad).
  expect(orderA!.items).toHaveLength(1);
  expect(orderA!.items[0].quantity).toBe(2);
  expect(orderA!.items[0].unitPrice).toBe(8000);
  expect(orderA!.subtotal).toBe(16000);
  expect(orderB!.items).toHaveLength(1);
  expect(orderB!.items[0].quantity).toBe(3);
  expect(orderB!.items[0].unitPrice).toBe(8000);
  expect(orderB!.subtotal).toBe(24000);

  // Exactamente DOS pedidos para estos carritos (sin duplicados ni parciales).
  expect(await db.order.count({ where: { cartId: { in: [cartAId, cartBId] } } })).toBe(2);

  // Ambos carritos convertidos correctamente.
  for (const [cartId, sessionId] of [
    [cartAId, SESS_A],
    [cartBId, SESS_B],
  ] as const) {
    const cart = await db.cart.findUnique({ where: { id: cartId } });
    expect(cart!.status).toBe('convertido');
    expect(cart!.sessionId).toBeNull();
    expect(cart!.userId).toBeNull();
  }
  expect(await db.cart.count({ where: { sessionId: { in: [SESS_A, SESS_B] }, status: 'activo' } })).toBe(0);
}, 30000);

d('T2: dos checkouts guest concurrentes, MISMO teléfono nuevo en formas equivalentes => 1 cliente canónico', async () => {
  expect(await db.user.count({ where: { phone: PHONE_CANONICAL } })).toBe(0);

  const [resultC, resultD] = await Promise.all([
    createOrderFromCart({
      cartId: cartCId,
      customerName: 'Cliente C',
      customerPhone: PHONE_LOCAL, // forma legada local 3XXXXXXXXX
      sessionUser: null,
      sessionId: SESS_C,
    }).catch((e) => e),
    createOrderFromCart({
      cartId: cartDId,
      customerName: 'Cliente D',
      customerPhone: `+57${PHONE_LOCAL}`, // forma E.164 equivalente
      sessionUser: null,
      sessionId: SESS_D,
    }).catch((e) => e),
  ]);

  expect(resultC).not.toBeInstanceOf(Error);
  expect(resultD).not.toBeInstanceOf(Error);
  expect((resultC as any).replayed).toBe(false);
  expect((resultD as any).replayed).toBe(false);

  // Exactamente UN Customer para el teléfono canónico (57XXXXXXXXXX).
  const customers = await db.user.findMany({ where: { phone: PHONE_CANONICAL } });
  expect(customers).toHaveLength(1);
  const customer = customers[0];
  expect(customer.email).toBeNull();

  // Ambos pedidos enlazados al MISMO cliente, cada uno con SU snapshot.
  const orderC = await db.order.findUnique({
    where: { id: (resultC as any).order.id },
    include: { items: true },
  });
  const orderD = await db.order.findUnique({
    where: { id: (resultD as any).order.id },
    include: { items: true },
  });
  expect(orderC!.cartId).toBe(cartCId);
  expect(orderD!.cartId).toBe(cartDId);
  expect(orderC!.customerId).toBe(customer.id);
  expect(orderD!.customerId).toBe(customer.id);
  expect(orderC!.customerPhone).toBe(PHONE_CANONICAL);
  expect(orderD!.customerPhone).toBe(PHONE_CANONICAL);
  expect(orderC!.items[0].quantity).toBe(1);
  expect(orderC!.subtotal).toBe(8000);
  expect(orderD!.items[0].quantity).toBe(4);
  expect(orderD!.subtotal).toBe(32000);

  expect(await db.order.count({ where: { cartId: { in: [cartCId, cartDId] } } })).toBe(2);

  // Ambos carritos convertidos correctamente.
  for (const cartId of [cartCId, cartDId]) {
    const cart = await db.cart.findUnique({ where: { id: cartId } });
    expect(cart!.status).toBe('convertido');
    expect(cart!.sessionId).toBeNull();
    expect(cart!.userId).toBeNull();
  }
}, 30000);
