import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { db } from '@/lib/db';
import { createOrderFromCart } from '@/lib/order-create';
import * as checkout from '@/lib/checkout';

/**
 * FASE 3 — RUTA ÚNICA DE CHECKOUT contra PostgreSQL REAL.
 *
 * La ruta legada POST /api/carts/checkout (sin lock, sin idempotencia, sin
 * conversión de carrito ni historial) fue retirada. Este test verifica que
 * ya no existe y que la ruta canónica (createOrderFromCart) conserva sus
 * semánticas de concurrencia/idempotencia extremo a extremo.
 */

const HAS_POSTGRES = Boolean(process.env.DATABASE_URL?.startsWith('postgres'));
const d = it.skipIf(!HAS_POSTGRES);

const RUN = `${Date.now()}`;
let categoryId: string;
let productId: string;

const SESSION = `sess-single-${RUN}`;
const IDEMPOTENCY_KEY = `key-single-${RUN}`;

beforeAll(async () => {
  if (!HAS_POSTGRES) return;

  const category = await db.category.create({
    data: { name: `Cat single ${RUN}`, slug: `cat-single-${RUN}` },
  });
  categoryId = category.id;

  const product = await db.product.create({
    data: {
      name: 'Producto single',
      slug: `prod-single-${RUN}`,
      price: 10000,
      wholesalePrice: 8000,
      stockQuantity: 10,
      categoryId,
    },
  });
  productId = product.id;
}, 30000);

afterAll(async () => {
  if (!HAS_POSTGRES) return;

  await db.order.deleteMany({ where: { idempotencyKey: IDEMPOTENCY_KEY } });
  await db.cart.deleteMany({ where: { sessionId: { startsWith: `sess-single-${RUN}` } } });
  await db.user.deleteMany({
    where: { OR: [{ phone: `57360000${RUN.slice(-4)}` }, { email: `single-${RUN}@test.local` }] },
  });
  await db.product.deleteMany({ where: { id: productId } });
  await db.category.deleteMany({ where: { slug: `cat-single-${RUN}` } });
  await db.$disconnect();
}, 30000);

d('processCheckout fue retirado: la ruta legada ya no existe', () => {
  expect((checkout as any).processCheckout).toBeUndefined();
  expect(
    existsSync(path.join(process.cwd(), 'src', 'app', 'api', 'carts', 'checkout', 'route.ts'))
  ).toBe(false);
});

d('ruta canónica extremo a extremo: conversión + historial + idempotencia', async () => {
  const cart = await db.cart.create({
    data: {
      sessionId: SESSION,
      status: 'activo',
      items: { create: { productId, quantity: 2 } },
    },
    include: { items: true },
  });

  const input = {
    cartId: cart.id,
    customerName: `Cliente single ${RUN}`,
    customerPhone: `57360000${RUN.slice(-4)}`,
    idempotencyKey: IDEMPOTENCY_KEY,
    sessionUser: null as null,
    sessionId: SESSION,
  };

  const first = await createOrderFromCart(input);
  expect(first.replayed).toBe(false);
  expect(first.order.subtotal).toBe(16000); // precio base server-side

  // El carrito quedó convertido dentro de la transacción
  const cartAfter = await db.cart.findUnique({ where: { id: cart.id } });
  expect(cartAfter!.status).toBe('convertido');
  expect(cartAfter!.sessionId).toBeNull();

  // Historial de creación persistido
  const history = await db.orderStatusHistory.findMany({
    where: { orderId: first.order.id },
  });
  expect(history.some((h) => h.toStatus === 'solicitado' && h.changedBy === 'sistema')).toBe(true);

  // Reintento con la MISMA clave: replay del pedido ya creado, sin duplicarlo
  const second = await createOrderFromCart(input);
  expect(second.replayed).toBe(true);
  expect(second.order.id).toBe(first.order.id);

  const ordersForKey = await db.order.findMany({ where: { idempotencyKey: IDEMPOTENCY_KEY } });
  expect(ordersForKey).toHaveLength(1);
}, 30000);
