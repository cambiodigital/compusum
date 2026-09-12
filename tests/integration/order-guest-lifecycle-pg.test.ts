import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/db';
import { createOrderFromCart } from '@/lib/order-create';
import { reorderOrderItems } from '@/lib/order-reorder';
import { authorizeOrderAccess, OrderAccessError } from '@/lib/order-access';
import { transferSessionDataToUser } from '@/lib/checkout';

/**
 * FASE 3 — CICLO DE VIDA INVITADO contra PostgreSQL REAL.
 *
 * POLÍTICA: el auto-enlace CRM del contacto (resolveOrderCustomer) asigna
 * customerId SIN transferir la propiedad: la sesión invitada que creó el
 * pedido sigue viéndolo en /mine (sessionId), detalle, reorder y edición.
 * La transferencia de propiedad ocurre SOLO con
 * `transferSessionDataToUser` (login/registro): sessionId => null y la
 * cuenta cliente gana el acceso.
 */

const HAS_POSTGRES = Boolean(process.env.DATABASE_URL?.startsWith('postgres'));
const d = it.skipIf(!HAS_POSTGRES);

const RUN = `${Date.now()}`;
let categoryId: string;
let productId: string;
let userUId: string;
let guestOrderId: string;

const SESS_A = `sess-guest-${RUN}-a`;
const SESS_B = `sess-guest-${RUN}-b`;
const guestPhone = `57340000${RUN.slice(-4)}`;
const guestEmail = `guest-${RUN}@test.local`;

beforeAll(async () => {
  if (!HAS_POSTGRES) return;

  const category = await db.category.create({
    data: { name: `Cat guest ${RUN}`, slug: `cat-guest-${RUN}` },
  });
  categoryId = category.id;

  const product = await db.product.create({
    data: {
      name: 'Producto guest',
      slug: `prod-guest-${RUN}`,
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

  if (guestOrderId) {
    await db.order.deleteMany({ where: { id: guestOrderId } });
  }
  await db.cart.deleteMany({
    where: {
      OR: [
        { sessionId: { startsWith: `sess-guest-${RUN}` } },
        ...(userUId ? [{ userId: userUId }] : []),
      ],
    },
  });
  // El usuario invitado fue auto-creado por el enlace CRM del contacto
  await db.user.deleteMany({
    where: {
      OR: [
        { phone: guestPhone },
        { email: guestEmail },
        ...(userUId ? [{ id: userUId }] : []),
      ],
    },
  });
  await db.product.deleteMany({ where: { id: productId } });
  await db.category.deleteMany({ where: { slug: `cat-guest-${RUN}` } });
  await db.$disconnect();
}, 30000);

d('checkout de invitado con contacto: auto-enlace CRM SIN romper la sesión', async () => {
  // 1) Checkout de invitado con nombre + teléfono + correo
  const cart = await db.cart.create({
    data: {
      sessionId: SESS_A,
      status: 'activo',
      items: { create: { productId, quantity: 2 } },
    },
    include: { items: true },
  });

  const result = await createOrderFromCart({
    cartId: cart.id,
    customerName: `Invitado ${RUN}`,
    customerPhone: guestPhone,
    customerEmail: guestEmail,
    sessionUser: null,
    sessionId: SESS_A,
  });
  guestOrderId = result.order.id;

  // El pedido conserva la sesión creadora Y gana customerId (enlace CRM)
  expect(result.order.sessionId).toBe(SESS_A);
  expect(result.order.customerId).not.toBeNull();

  // 2) Semántica de GET /api/orders/mine para invitados: consulta por sessionId
  const mine = await db.order.findMany({ where: { sessionId: SESS_A } });
  expect(mine.map((o) => o.id)).toContain(guestOrderId);

  // 3) Detalle/reorder/edición para la MISMA sesión: sin 403
  const order = await db.order.findUnique({ where: { id: guestOrderId } });
  expect(() =>
    authorizeOrderAccess(order!, { user: null, sessionId: SESS_A })
  ).not.toThrow();

  const reorder = await reorderOrderItems({
    orderId: guestOrderId,
    viewer: { user: null, sessionId: SESS_A },
  });
  expect(reorder.cart).toBeDefined();

  // 4) Otra sesión invitada: 403 en ambas vías
  expect(() =>
    authorizeOrderAccess(order!, { user: null, sessionId: SESS_B })
  ).toThrow(OrderAccessError);
  await expect(
    reorderOrderItems({ orderId: guestOrderId, viewer: { user: null, sessionId: SESS_B } })
  ).rejects.toMatchObject({ status: 403 });

  // 5) Transferencia EXPLÍCITA (login/registro): cambia la propiedad
  const userU = await db.user.create({
    data: {
      name: `Cuenta U ${RUN}`,
      phone: `57350000${RUN.slice(-4)}`,
      role: 'CUSTOMER',
      password: 'x',
    },
  });
  userUId = userU.id;

  await transferSessionDataToUser(SESS_A, userU.id);

  const transferred = await db.order.findUnique({ where: { id: guestOrderId } });
  expect(transferred!.sessionId).toBeNull();
  expect(transferred!.customerId).toBe(userU.id);

  // La sesión invitada pierde acceso...
  expect(() =>
    authorizeOrderAccess(transferred!, { user: null, sessionId: SESS_A })
  ).toThrow(OrderAccessError);

  // ...y la cuenta cliente lo gana
  expect(() =>
    authorizeOrderAccess(transferred!, {
      user: { id: userU.id, role: 'CUSTOMER' },
      sessionId: null,
    })
  ).not.toThrow();
  const forCustomer = await db.order.findMany({ where: { customerId: userU.id } });
  expect(forCustomer.map((o) => o.id)).toContain(guestOrderId);
}, 30000);
