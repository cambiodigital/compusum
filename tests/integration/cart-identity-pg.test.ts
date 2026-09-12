import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { db } from '@/lib/db';
import { upsertActiveCart } from '@/lib/order-cart-upsert';
import { saveCartChanges, clearActiveCarts } from '@/lib/cart-mutations';
import { reorderOrderItems } from '@/lib/order-reorder';
import { transferSessionDataToUser } from '@/lib/checkout';
import { authorizeOrderAccess, OrderAccessError } from '@/lib/order-access';

/**
 * IDENTIDAD CANÓNICA DE CARRITO contra PostgreSQL REAL — a través de los
 * SERVICIOS de producción (upsertActiveCart / saveCartChanges /
 * clearActiveCarts / reorderOrderItems / transferSessionDataToUser).
 *
 * 1. Caso del auditor: guest → login (transferencia) → rotación de cookie →
 *    autosave autenticado con x-session-id NUEVO sigue actualizando EL MISMO
 *    carrito del usuario (el userId es autoritativo; nunca se crea otro).
 * 2. GET/clear/reorder resuelven el MISMO carrito canónico aunque el visor
 *    lleve además una x-session-id rotable.
 * 3. Dos adquisiciones concurrentes para un usuario sin carrito resuelven el
 *    MISMO carrito (P2002 + índice único parcial DB-native).
 * 4. Reorder re-autoriza el Order BAJO lock: una transferencia concurrente
 *    guest→cuenta produce 403 con CERO writes y sin crear carrito.
 * 5. Transferencia coherente: la sesión vieja queda sin capacidad sobre el
 *    pedido/carrito transferidos y separa basura guest en carrito NUEVO; un
 *    segundo dispositivo autenticado sigue actualizando el MISMO carrito.
 */

const HAS_POSTGRES = Boolean(process.env.DATABASE_URL?.startsWith('postgres'));
const d = it.skipIf(!HAS_POSTGRES);

const RUN = `${Date.now()}`;
let categoryId: string;
let productId: string; // P: wholesale 8000 (precio CUSTOMER), base 10000
let userUId: string; // U: dueño de la transferencia del caso del auditor
let userU2Id: string; // U2: adquisiciones concurrentes
let userU3Id: string; // U3: cuenta que gana el pedido guest en vuelo
let userU4Id: string; // U4: transferencia coherente + segundo dispositivo

const SESS_S1 = `sess-cartid-${RUN}-s1`; // carrito guest transferible (T1)
const SESS_S2 = `sess-cartid-${RUN}-s2rot`; // sesión ROTADA post-login (T1/T2)
const SESS_CONC_A = `sess-cartid-${RUN}-conca`; // adquisición concurrente 1
const SESS_CONC_B = `sess-cartid-${RUN}-concb`; // adquisición concurrente 2
const SESS_S3 = `sess-cartid-${RUN}-s3`; // pedido guest transferido en vuelo (T4)
const SESS_S4 = `sess-cartid-${RUN}-s4`; // transferencia coherente (T5)
const SESS_S4_DEV2 = `sess-cartid-${RUN}-s4dev2`; // segundo dispositivo (T5)

async function seedGuestCart(sessionId: string, quantity: number) {
  return db.cart.create({
    data: {
      sessionId,
      status: 'activo',
      subtotal: 8000 * quantity,
      items: {
        create: {
          productId,
          quantity,
          unitPrice: 8000,
        },
      },
    },
    include: { items: true },
  });
}

async function seedGuestOrder(
  sessionId: string | null,
  customerId: string | null,
  status: string,
  suffix: string,
  quantity: number
) {
  const cart = await db.cart.create({
    data: { sessionId: `sess-cartid-hist-${RUN}-${suffix}`, status: 'convertido' },
  });
  return db.order.create({
    data: {
      orderNumber: `CS-CARTID-${RUN}-${suffix}`,
      cartId: cart.id,
      customerId,
      sessionId,
      subtotal: 10000 * quantity,
      status,
      items: {
        create: {
          productId,
          productName: 'Producto cartid',
          quantity,
          unitPrice: 10000, // snapshot histórico distinto del precio actual
        },
      },
    },
    include: { items: true },
  });
}

const customerViewer = (userId: string, sessionId: string | null = null) => ({
  user: { id: userId, role: 'CUSTOMER' },
  sessionId,
});

/** Snapshot de carritos+items alcanzables por una sesión guest (para T4). */
async function snapshotSessionFootprint(sessionId: string) {
  const carts = await db.cart.findMany({
    where: { sessionId },
    include: { items: true },
  });
  return carts;
}

beforeAll(async () => {
  if (!HAS_POSTGRES) return;

  const category = await db.category.create({
    data: { name: `Cat cartid ${RUN}`, slug: `cat-cartid-${RUN}` },
  });
  categoryId = category.id;

  const product = await db.product.create({
    data: {
      name: 'Producto cartid',
      slug: `prod-cartid-${RUN}`,
      price: 10000,
      wholesalePrice: 8000,
      stockQuantity: 50,
      categoryId,
    },
  });
  productId = product.id;

  const [u, u2, u3, u4] = await Promise.all([
    db.user.create({
      data: {
        name: `Cliente U cartid ${RUN}`,
        phone: `57361000${RUN.slice(-4)}`,
        role: 'CUSTOMER',
        password: 'x',
      },
    }),
    db.user.create({
      data: {
        name: `Cliente U2 cartid ${RUN}`,
        phone: `57362000${RUN.slice(-4)}`,
        role: 'CUSTOMER',
        password: 'x',
      },
    }),
    db.user.create({
      data: {
        name: `Cliente U3 cartid ${RUN}`,
        phone: `57363000${RUN.slice(-4)}`,
        role: 'CUSTOMER',
        password: 'x',
      },
    }),
    db.user.create({
      data: {
        name: `Cliente U4 cartid ${RUN}`,
        phone: `57364000${RUN.slice(-4)}`,
        role: 'CUSTOMER',
        password: 'x',
      },
    }),
  ]);
  userUId = u.id;
  userU2Id = u2.id;
  userU3Id = u3.id;
  userU4Id = u4.id;
}, 30000);

afterAll(async () => {
  if (!HAS_POSTGRES) return;

  const userOrSession = {
    OR: [
      { userId: { in: [userUId, userU2Id, userU3Id, userU4Id].filter(Boolean) } },
      { sessionId: { startsWith: `sess-cartid-${RUN}` } },
      { sessionId: { startsWith: `sess-cartid-hist-${RUN}` } },
    ],
  };
  const testCarts = await db.cart.findMany({
    where: userOrSession,
    select: { id: true },
  });
  await db.order.deleteMany({ where: { cartId: { in: testCarts.map((c) => c.id) } } });
  await db.order.deleteMany({ where: { orderNumber: { startsWith: `CS-CARTID-${RUN}` } } });
  await db.cart.deleteMany({ where: userOrSession });
  await db.user.deleteMany({
    where: { id: { in: [userUId, userU2Id, userU3Id, userU4Id].filter(Boolean) } },
  });
  await db.product.deleteMany({ where: { id: productId } });
  await db.category.deleteMany({ where: { slug: `cat-cartid-${RUN}` } });
  await db.$disconnect();
}, 30000);

d('T1: guest → login (transferencia) → rotación → autosave autenticado actualiza EL MISMO carrito', async () => {
  // Carrito guest S1 con P×2 (subtotal 16000).
  const guestCart = await seedGuestCart(SESS_S1, 2);

  // Login: transferencia atómica guest→cuenta.
  const transferred = await transferSessionDataToUser(SESS_S1, userUId);
  expect(transferred.cart).not.toBeNull();
  expect(transferred.cart!.userId).toBe(userUId);
  expect(transferred.cart!.sessionId).toBeNull();
  expect(transferred.cart!.id).toBe(guestCart.id);

  // Rotación de cookie => el cliente vuelve con x-session-id NUEVO (S2-rot)
  // y ya autenticado: el autosave debe aterrizar en EL MISMO carrito.
  const result = await saveCartChanges({
    viewer: { sessionId: SESS_S2, userId: userUId, isAdminOrAgent: false },
    action: 'save',
    items: [{ productId, quantity: 5 }],
    currentUser: { id: userUId, role: 'CUSTOMER' },
  });

  expect(result.id).toBe(guestCart.id); // el MISMO carrito, no uno nuevo
  expect(result.itemCount).toBe(1);
  expect(result.subtotal).toBe(5 * 8000);

  // La sesión rotada NO creó ningún carrito guest.
  const sessionCarts = await db.cart.count({ where: { sessionId: SESS_S2 } });
  expect(sessionCarts).toBe(0);

  // Exactamente UN carrito activo para U, con la línea P×5 al precio 8000.
  const activeForUser = await db.cart.findMany({
    where: { userId: userUId, status: 'activo' },
    include: { items: true },
  });
  expect(activeForUser).toHaveLength(1);
  expect(activeForUser[0].id).toBe(guestCart.id);
  expect(activeForUser[0].items).toHaveLength(1);
  expect(activeForUser[0].items[0].quantity).toBe(5);
  expect(activeForUser[0].items[0].unitPrice).toBe(8000);
  expect(activeForUser[0].subtotal).toBe(40000);
}, 30000);

d('T2: clear y reorder resuelven el MISMO carrito canónico (userId autoritativo)', async () => {
  // Estado heredado de T1: U tiene UN carrito activo (transferido) con P×5.
  const userCart = await db.cart.findFirst({
    where: { userId: userUId, status: 'activo' },
  });
  expect(userCart).not.toBeNull();

  // clearActiveCarts con sesión rotada + cuenta: debe vaciar EL carrito del
  // usuario (no crear/adoptar uno de la sesión S2-rot).
  const cleared = await clearActiveCarts({
    sessionId: SESS_S2,
    userId: userUId,
    isAdminOrAgent: false,
  });
  expect(cleared).toEqual({ skipped: false });

  const sessionCartsAfterClear = await db.cart.count({ where: { sessionId: SESS_S2 } });
  expect(sessionCartsAfterClear).toBe(0); // cero carritos guest para la sesión rotada

  const clearedCart = await db.cart.findUnique({
    where: { id: userCart!.id },
    include: { items: true },
  });
  expect(clearedCart!.items).toHaveLength(0); // items vaciados
  expect(clearedCart!.subtotal).toBe(0);

  // Pedido histórico del usuario para el reorder.
  const order = await seedGuestOrder(null, userUId, 'compartido', 'reorder', 3);

  // Re-seed canónico del carrito activo del usuario (resuelve el mismo carro).
  const fresh = await upsertActiveCart(null, userUId);
  expect(fresh.id).toBe(userCart!.id);

  // Reorder con visor CUSTOMER que además lleva la sesión rotable: el carrito
  // resuelto debe ser el del USUARIO (userId canónico, sessionId null).
  const result = await reorderOrderItems({
    orderId: order.id,
    viewer: customerViewer(userUId, SESS_S2),
    mode: 'add',
  });

  expect(result.cart).toBeDefined();
  expect(result.cart!.id).toBe(userCart!.id);
  const resolvedCart = await db.cart.findUnique({ where: { id: result.cart!.id } });
  expect(resolvedCart!.userId).toBe(userUId);
  expect(resolvedCart!.sessionId).toBeNull();
  expect(result.addedCount).toBe(1);
  expect(result.cart!.subtotal).toBe(3 * 8000);
}, 30000);

d('T3: dos adquisiciones concurrentes para un usuario sin carrito => el MISMO carrito y UN activo', async () => {
  // U2 NO tiene carrito: dos resoluciones concurrentes con sesiones distintas
  // ejercitan el reintento P2002 contra el índice único parcial DB-native.
  const [a, b] = await Promise.all([
    upsertActiveCart(SESS_CONC_A, userU2Id),
    upsertActiveCart(SESS_CONC_B, userU2Id),
  ]);

  expect(a.id).toBe(b.id);

  const active = await db.cart.findMany({
    where: { userId: userU2Id, status: 'activo' },
  });
  expect(active).toHaveLength(1);
  expect(active[0].id).toBe(a.id);
  // Canonical: el carrito del usuario no adopta ninguna de las dos sesiones.
  expect(active[0].sessionId).toBeNull();
}, 30000);

d('T4: reorder re-autoriza el Order bajo transferencia concurrente => 403 y CERO writes', async () => {
  // Pedido GUEST (sessionId S3) con P×3 cargable.
  const order = await seedGuestOrder(SESS_S3, null, 'compartido', 'flight', 3);

  const other = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  try {
    // Snapshot ANTES: carritos de la sesión S3 (ninguno) + sus items.
    const before = await snapshotSessionFootprint(SESS_S3);
    expect(before).toHaveLength(0);

    // Controlador: lock del Order, espera, y commit de la transferencia
    // (exactamente lo que transferSessionDataToUser escribe al transferir).
    const controller = other.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE`;
      await new Promise((r) => setTimeout(r, 400));
      await tx.order.update({
        where: { id: order.id },
        data: { customerId: userU3Id, sessionId: null },
      });
    });

    // A +150ms el reorder llega y se bloquea en el lock del Order.
    await new Promise((r) => setTimeout(r, 150));
    const reorderPromise = reorderOrderItems({
      orderId: order.id,
      viewer: { user: null, sessionId: SESS_S3 },
    }).catch((e) => e);

    await controller;
    const reorderError = (await reorderPromise) as any;

    // El Order fue re-autorizado BAJO lock post-transferencia: 403.
    expect(reorderError).toBeInstanceOf(OrderAccessError);
    expect(reorderError.status).toBe(403);

    // Snapshot DESPUÉS idéntico al ANTES: la tx abortó sin crear carrito para
    // S3 ni tocar NINGÚN item de carrito.
    const after = await snapshotSessionFootprint(SESS_S3);
    expect(after).toHaveLength(before.length);
    expect(after.map((c) => ({ id: c.id, status: c.status, items: c.items.map((i) => i.id) })))
      .toEqual(before.map((c) => ({ id: c.id, status: c.status, items: c.items.map((i) => i.id) })));
    expect(after).toHaveLength(0); // cero carritos creados para la sesión S3
  } finally {
    await other.$disconnect();
  }
}, 30000);

d('T5: transferencia coherente + sesión vieja sin capacidad + segundo dispositivo', async () => {
  // Carrito guest S4 (P×2) + pedido guest S4 'solicitado'.
  const guestCart = await seedGuestCart(SESS_S4, 2);
  const guestOrder = await seedGuestOrder(SESS_S4, null, 'solicitado', 'coherent', 1);

  // Transferencia atómica.
  const transferred = await transferSessionDataToUser(SESS_S4, userU4Id);
  expect(transferred.cart!.id).toBe(guestCart.id);
  expect(transferred.cart!.userId).toBe(userU4Id);
  expect(transferred.cart!.sessionId).toBeNull();

  const transferredOrder = await db.order.findUnique({ where: { id: guestOrder.id } });
  expect(transferredOrder!.customerId).toBe(userU4Id);
  expect(transferredOrder!.sessionId).toBeNull();

  // La sesión vieja S4 pierde acceso al pedido transferido.
  expect(() =>
    authorizeOrderAccess(transferredOrder!, { user: null, sessionId: SESS_S4 })
  ).toThrow(OrderAccessError);

  // El guest S4 (sesión vieja) que guarda carrito crea un carrito NUEVO
  // DISTINTO (separación de basura guest): el de U4 queda intacto.
  const guestSave = await saveCartChanges({
    viewer: { sessionId: SESS_S4, userId: null, isAdminOrAgent: false },
    action: 'save',
    items: [{ productId, quantity: 1 }],
    currentUser: null,
  });
  expect(guestSave.id).not.toBe(guestCart.id); // carrito NUEVO

  const s4ActiveCarts = await db.cart.findMany({
    where: { sessionId: SESS_S4, status: 'activo' },
    include: { items: true },
  });
  expect(s4ActiveCarts).toHaveLength(1); // solo el carrito nuevo de la sesión vieja
  expect(s4ActiveCarts[0].id).toBe(guestSave.id);
  expect(s4ActiveCarts[0].userId).toBeNull();
  expect(s4ActiveCarts[0].items[0].quantity).toBe(1);
  expect(s4ActiveCarts[0].items[0].unitPrice).toBe(8000); // precio base del motor (wholesalePrice)

  // El carrito de U4 NO fue tocado por la sesión vieja.
  const u4Cart = await db.cart.findUnique({
    where: { id: guestCart.id },
    include: { items: true },
  });
  expect(u4Cart!.userId).toBe(userU4Id);
  expect(u4Cart!.sessionId).toBeNull();
  expect(u4Cart!.items).toHaveLength(1);
  expect(u4Cart!.items[0].quantity).toBe(2);
  expect(u4Cart!.items[0].unitPrice).toBe(8000);
  expect(u4Cart!.subtotal).toBe(16000);

  // Segundo dispositivo autenticado (otra sesión, misma cuenta): actualiza
  // el MISMO carrito de U4.
  const device2 = await saveCartChanges({
    viewer: { sessionId: SESS_S4_DEV2, userId: userU4Id, isAdminOrAgent: false },
    action: 'save',
    items: [{ productId, quantity: 3 }],
    currentUser: { id: userU4Id, role: 'CUSTOMER' },
  });
  expect(device2.id).toBe(guestCart.id); // el MISMO carrito de la cuenta

  const dev2SessionCarts = await db.cart.count({ where: { sessionId: SESS_S4_DEV2 } });
  expect(dev2SessionCarts).toBe(0); // ningún carrito guest para la sesión del device 2

  const activeU4 = await db.cart.findMany({
    where: { userId: userU4Id, status: 'activo' },
  });
  expect(activeU4).toHaveLength(1); // sigue habiendo UN único activo para U4
  expect(activeU4[0].id).toBe(guestCart.id);
}, 30000);
