import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient, Prisma } from '@prisma/client';
import { db } from '@/lib/db';
import { createOrderFromCart, OrderCreateError } from '@/lib/order-create';
import { transferSessionDataToUser } from '@/lib/checkout';
import { saveCartChanges } from '@/lib/cart-mutations';
import { reorderOrderItems } from '@/lib/order-reorder';

/**
 * CARRERA CHECKOUT GUEST vs TRANSFERENCIA invitado→cuenta contra PostgreSQL
 * REAL — a través de los SERVICIOS de producción (createOrderFromCart /
 * transferSessionDataToUser / saveCartChanges / reorderOrderItems).
 *
 * Patrón establecido: el cliente CONTROLADOR puede sostener advisory/row locks
 * y commitear el estado del actor EXTERNO (lo que la función de producción
 * rivalescribiría al confirmar), mientras la función REAL corre como víctima.
 *
 * 1. Interleaving transferencia-primero: el checkout guest llega DESPUÉS de
 *    que la transferencia reclamó carrito+pedidos de la sesión => 403
 *    (CART_FORBIDDEN) en el re-chequeo de propiedad post-lock, CERO pedidos
 *    nuevos y CERO huérfanos; el carrito de la cuenta queda intacto.
 * 2. Interleaving checkout-primero: la transferencia llega DESPUÉS de que el
 *    checkout guest confirmó => el escaneo de Orders (bajo advisory) ve el
 *    pedido nuevo y lo transfiere a la cuenta; sin carrito activo residual.
 * 3. Handoff con fallo REAL de BD (FK P2003): rollback completo => carrito y
 *    pedido guest intactos Y accesibles (la sesión guest sigue operando).
 * 4. Dos reorders concurrentes para un usuario sin carrito: los advisory
 *    locks de identidad serializan la adquisición => UN solo carrito activo,
 *    líneas = unión, sin errores de tx abortada (disciplina sin recuperación
 *    P2002 dentro de transacciones).
 */

const HAS_POSTGRES = Boolean(process.env.DATABASE_URL?.startsWith('postgres'));
const d = it.skipIf(!HAS_POSTGRES);

const RUN = `${Date.now()}`;
let categoryId: string;
let productId: string; // P: wholesale 8000 (precio CUSTOMER/guest), base 10000
let qProductId: string; // Q: 5000 plano
let userU1Id: string; // cuenta ganadora en transferencia-primero
let userU2Id: string; // cuenta ganadora en checkout-primero
let userU4Id: string; // adquisición concurrente vía dos reorders

const SESS_S1 = `sess-ctrace-${RUN}-s1`; // transferencia-primero
const SESS_S2 = `sess-ctrace-${RUN}-s2`; // checkout-primero
const SESS_S3 = `sess-ctrace-${RUN}-s3`; // handoff con fallo de FK

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

async function seedOrder(
  customerId: string | null,
  sessionId: string | null,
  suffix: string,
  prodId: string,
  quantity: number,
  status = 'compartido'
) {
  const cart = await db.cart.create({
    data: { sessionId: `sess-ctrace-hist-${RUN}-${suffix}`, status: 'convertido' },
  });
  return db.order.create({
    data: {
      orderNumber: `CS-CTRACE-${RUN}-${suffix}`,
      cartId: cart.id,
      customerId,
      sessionId,
      subtotal: 10000 * quantity,
      status,
      items: {
        create: {
          productId: prodId,
          productName: 'Producto ctrace',
          quantity,
          unitPrice: 10000, // snapshot histórico distinto del precio actual
        },
      },
    },
    include: { items: true },
  });
}

/** Advisory del controlador: EXACTAMENTE el que toman los servicios guest. */
async function takeGuestAdvisory(
  tx: Prisma.TransactionClient | PrismaClient,
  sessionId: string
) {
  // `IS NULL` convierte el void del lock en columna serializable por Prisma.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('compusum:guest-session:' || ${sessionId}, 0)) IS NULL`;
}

// Barrera determinista: espera a que la víctima esté REALMENTE bloqueada en
// el lock (wait_event_type='Lock') antes de que el controller escriba.
async function waitForVictimLocked(
  client: PrismaClient,
  queryFragment: string,
  timeoutMs = 8000
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await client.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM pg_stat_activity
      WHERE wait_event_type = 'Lock'
        AND query ILIKE ${'%' + queryFragment + '%'}
        AND pid <> pg_backend_pid()`;
    if (Number(rows[0].count) > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('La víctima nunca llegó al lock wait: ' + queryFragment);
}

beforeAll(async () => {
  if (!HAS_POSTGRES) return;

  const category = await db.category.create({
    data: { name: `Cat ctrace ${RUN}`, slug: `cat-ctrace-${RUN}` },
  });
  categoryId = category.id;

  const product = await db.product.create({
    data: {
      name: 'Producto ctrace',
      slug: `prod-ctrace-${RUN}`,
      price: 10000,
      wholesalePrice: 8000,
      stockQuantity: 50,
      categoryId,
    },
  });
  productId = product.id;

  const qProduct = await db.product.create({
    data: {
      name: 'Producto Q ctrace',
      slug: `prod-ctrace-q-${RUN}`,
      price: 5000,
      wholesalePrice: 5000,
      stockQuantity: 50,
      categoryId,
    },
  });
  qProductId = qProduct.id;

  const [u1, u2, u4] = await Promise.all([
    db.user.create({
      data: {
        name: `Cliente U1 ctrace ${RUN}`,
        phone: `57371000${RUN.slice(-4)}`,
        role: 'CUSTOMER',
        password: 'x',
      },
    }),
    db.user.create({
      data: {
        name: `Cliente U2 ctrace ${RUN}`,
        phone: `57372000${RUN.slice(-4)}`,
        role: 'CUSTOMER',
        password: 'x',
      },
    }),
    db.user.create({
      data: {
        name: `Cliente U4 ctrace ${RUN}`,
        phone: `57374000${RUN.slice(-4)}`,
        role: 'CUSTOMER',
        password: 'x',
      },
    }),
  ]);
  userU1Id = u1.id;
  userU2Id = u2.id;
  userU4Id = u4.id;
}, 30000);

afterAll(async () => {
  if (!HAS_POSTGRES) return;

  const userOrSession = {
    OR: [
      { userId: { in: [userU1Id, userU2Id, userU4Id].filter(Boolean) } },
      { sessionId: { startsWith: `sess-ctrace-${RUN}` } },
      { sessionId: { startsWith: `sess-ctrace-hist-${RUN}` } },
    ],
  };
  const testCarts = await db.cart.findMany({
    where: userOrSession,
    select: { id: true },
  });
  await db.order.deleteMany({ where: { cartId: { in: testCarts.map((c) => c.id) } } });
  await db.order.deleteMany({ where: { orderNumber: { startsWith: `CS-CTRACE-${RUN}` } } });
  await db.cart.deleteMany({ where: userOrSession });
  await db.user.deleteMany({
    where: { id: { in: [userU1Id, userU2Id, userU4Id].filter(Boolean) } },
  });
  await db.product.deleteMany({ where: { id: { in: [productId, qProductId].filter(Boolean) } } });
  await db.category.deleteMany({ where: { slug: `cat-ctrace-${RUN}` } });
  await db.$disconnect();
}, 30000);

d('T1: transferencia confirma primero => checkout guest posterior recibe 403 y CERO pedidos', async () => {
  const guestCart = await seedGuestCart(SESS_S1, 2);

  const other = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  try {
    // Controlador: MISMO advisory de identidad guest, espera y commitea la
    // transferencia (lock de Orders de la sesión + reclamo del carrito),
    // exactamente lo que escribe transferSessionDataToUser al confirmar.
    const controller = other.$transaction(async (tx) => {
      await takeGuestAdvisory(tx, SESS_S1);
      await waitForVictimLocked(other, 'pg_advisory_xact_lock');
      await new Promise((r) => setTimeout(r, 400));

      const rows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM "Order" WHERE "sessionId" = ${SESS_S1} ORDER BY id FOR UPDATE`;
      for (const row of rows) {
        await tx.order.update({
          where: { id: row.id },
          data: { customerId: userU1Id, sessionId: null },
        });
      }
      await tx.cart.update({
        where: { id: guestCart.id },
        data: { userId: userU1Id, sessionId: null },
      });
    });

    // A +150ms el checkout guest REAL llega y se bloquea en el advisory.
    await new Promise((r) => setTimeout(r, 150));
    const checkoutPromise = createOrderFromCart({
      cartId: guestCart.id,
      customerName: 'Invitado X',
      sessionUser: null,
      sessionId: SESS_S1,
    }).catch((e) => e);

    await controller;
    const checkoutError = (await checkoutPromise) as any;

    // Post-lock: el carrito ya pertenece a la cuenta => 403 sin crear Order.
    expect(checkoutError).toBeInstanceOf(OrderCreateError);
    expect(checkoutError.code).toBe('CART_FORBIDDEN');
    expect(checkoutError.status).toBe(403);

    // Ningún pedido de la sesión S1 y ningún huérfano guest.
    expect(await db.order.count({ where: { sessionId: SESS_S1 } })).toBe(0);
    expect(
      await db.order.count({ where: { customerId: null, sessionId: SESS_S1 } })
    ).toBe(0);

    // El carrito de la cuenta quedó EXACTAMENTE como lo dejó la transferencia.
    const userCart = await db.cart.findUnique({
      where: { id: guestCart.id },
      include: { items: true },
    });
    expect(userCart!.userId).toBe(userU1Id);
    expect(userCart!.sessionId).toBeNull();
    expect(userCart!.status).toBe('activo');
    expect(userCart!.items).toHaveLength(1);
    expect(userCart!.items[0].productId).toBe(productId);
    expect(userCart!.items[0].quantity).toBe(2);
    expect(userCart!.items[0].unitPrice).toBe(8000);
  } finally {
    await other.$disconnect();
  }
}, 30000);

d('T2: checkout guest confirma primero => la transferencia transfiere el pedido nuevo', async () => {
  const guestCart = await seedGuestCart(SESS_S2, 2);

  const other = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  try {
    // Controlador: advisory guest, espera y commitea el checkout (snapshot de
    // pedido de la sesión + conversión del carrito).
    const controller = other.$transaction(async (tx) => {
      await takeGuestAdvisory(tx, SESS_S2);
      await waitForVictimLocked(other, 'pg_advisory_xact_lock');
      await new Promise((r) => setTimeout(r, 400));

      await tx.order.create({
        data: {
          orderNumber: `CS-CTRACE-${RUN}-checkout-first`,
          cartId: guestCart.id,
          sessionId: SESS_S2,
          customerId: null,
          customerName: 'Invitado X',
          subtotal: 16000,
          status: 'solicitado',
          requestType: 'pedido',
          items: {
            create: {
              productId,
              productName: 'Producto ctrace',
              quantity: 2,
              unitPrice: 8000,
            },
          },
        },
      });
      await tx.cart.update({
        where: { id: guestCart.id },
        data: { status: 'convertido', sessionId: null },
      });
    });

    // A +150ms la transferencia REAL llega y se bloquea en el advisory.
    await new Promise((r) => setTimeout(r, 150));
    const transferPromise = transferSessionDataToUser(SESS_S2, userU2Id).catch(
      (e) => e
    );

    await controller;
    const transferred = (await transferPromise) as any;
    expect(transferred).not.toBeInstanceOf(Error);
    expect(transferred.cart).toBeNull(); // sin carrito activo de sesión que reclamar

    // El pedido del checkout fue transferido: accesible por la cuenta.
    const order = await db.order.findUnique({
      where: { orderNumber: `CS-CTRACE-${RUN}-checkout-first` },
    });
    expect(order).not.toBeNull();
    expect(order!.customerId).toBe(userU2Id);
    expect(order!.sessionId).toBeNull();

    // NO queda ningún pedido con sessionId S2.
    expect(await db.order.count({ where: { sessionId: SESS_S2 } })).toBe(0);

    // Sin carrito activo para S2 y el convertido EXACTAMENTE intacto (solo
    // lo que escribió el checkout).
    expect(await db.cart.count({ where: { sessionId: SESS_S2, status: 'activo' } })).toBe(0);
    const converted = await db.cart.findUnique({
      where: { id: guestCart.id },
      include: { items: true },
    });
    expect(converted!.status).toBe('convertido');
    expect(converted!.userId).toBeNull();
    expect(converted!.sessionId).toBeNull();
    expect(converted!.items).toHaveLength(1);
    expect(converted!.items[0].productId).toBe(productId);
    expect(converted!.items[0].quantity).toBe(2);
    expect(converted!.items[0].unitPrice).toBe(8000);
    expect(converted!.subtotal).toBe(16000);
  } finally {
    await other.$disconnect();
  }
}, 30000);

d('T3: handoff con fallo REAL de BD (FK) => rollback completo y datos guest intactos y ACCESIBLES', async () => {
  const guestCart = await seedGuestCart(SESS_S3, 2);
  const guestOrder = await seedOrder(null, SESS_S3, 'handoff-fail', productId, 1, 'solicitado');

  // El update del Order contra un customerId inexistente revienta con FK
  // P2003: Order.customerId tiene relación; la tx completa hace ROLLBACK
  // (carrito y pedido quedan exactamente como estaban).
  await expect(
    transferSessionDataToUser(SESS_S3, 'user-inexistente-xyz')
  ).rejects.toMatchObject({ code: 'P2003' });

  // Carrito guest intacto.
  const cart = await db.cart.findUnique({
    where: { id: guestCart.id },
    include: { items: true },
  });
  expect(cart!.sessionId).toBe(SESS_S3);
  expect(cart!.status).toBe('activo');
  expect(cart!.userId).toBeNull();
  expect(cart!.items).toHaveLength(1);
  expect(cart!.items[0].productId).toBe(productId);
  expect(cart!.items[0].quantity).toBe(2);
  expect(cart!.items[0].unitPrice).toBe(8000);

  // Pedido guest intacto.
  const order = await db.order.findUnique({ where: { id: guestOrder.id } });
  expect(order!.sessionId).toBe(SESS_S3);
  expect(order!.customerId).toBeNull();

  // La sesión guest sigue operando SU carrito (sin datos invisibles): el
  // save aterriza en el MISMO carrito.
  const saved = await saveCartChanges({
    viewer: { sessionId: SESS_S3, userId: null, isAdminOrAgent: false },
    action: 'save',
    items: [{ productId, quantity: 4 }],
    currentUser: null,
  });
  expect(saved.id).toBe(guestCart.id);
  expect(saved.itemCount).toBe(1);
  expect(saved.subtotal).toBe(4 * 8000);
}, 30000);

d('T4: dos reorders concurrentes adquieren UN solo carrito (advisory serializa, sin recuperación P2002)', async () => {
  // U4 sin carrito activo: dos reorders concurrentes compiten por la
  // adquisición (el camino que antes dependía del catch P2002).
  const o1 = await seedOrder(userU4Id, null, 'reorder-a', productId, 3);
  const o2 = await seedOrder(userU4Id, null, 'reorder-b', qProductId, 2);

  const viewer = { user: { id: userU4Id, role: 'CUSTOMER' }, sessionId: null };

  const [r1, r2] = await Promise.all([
    reorderOrderItems({ orderId: o1.id, viewer, mode: 'add', allowPartial: true }).catch(
      (e) => e
    ),
    reorderOrderItems({ orderId: o2.id, viewer, mode: 'add', allowPartial: true }).catch(
      (e) => e
    ),
  ]);

  // NINGUNO rechaza: sin 500, sin tx abortada, sin P2002 sin recuperar.
  expect(r1).not.toBeInstanceOf(Error);
  expect(r2).not.toBeInstanceOf(Error);
  expect((r1 as any).cart).toBeDefined();
  expect((r2 as any).cart).toBeDefined();

  // Ambos aterrizaron en EL MISMO carrito.
  expect((r2 as any).cart.id).toBe((r1 as any).cart.id);

  // Exactamente UN carrito activo para U4.
  const active = await db.cart.findMany({
    where: { userId: userU4Id, status: 'activo' },
  });
  expect(active).toHaveLength(1);
  expect(active[0].id).toBe((r1 as any).cart.id);

  // Líneas finales = unión (P×3 + Q×2) con subtotal correcto.
  const lines = await db.cartItem.findMany({ where: { cartId: (r1 as any).cart.id } });
  const byProduct = new Map(lines.map((l) => [l.productId, l]));
  expect(lines).toHaveLength(2);
  expect(byProduct.get(productId)!.quantity).toBe(3);
  expect(byProduct.get(productId)!.unitPrice).toBe(8000);
  expect(byProduct.get(qProductId)!.quantity).toBe(2);
  expect(byProduct.get(qProductId)!.unitPrice).toBe(5000);

  const cartRow = await db.cart.findUnique({ where: { id: (r1 as any).cart.id } });
  expect(cartRow!.subtotal).toBe(3 * 8000 + 2 * 5000);
}, 30000);
