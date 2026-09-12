import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { db } from '@/lib/db';
import { editCustomerOrder, OrderEditError } from '@/lib/order-edit';
import { OrderAccessError } from '@/lib/order-access';

/**
 * FASE 3 — EDICIÓN DE PEDIDOS contra PostgreSQL REAL.
 *
 * 1. ROLLBACK: un cityId inválido (que antes provocaba P2003 DESPUÉS de
 *    reescribir las líneas) ahora responde 400 limpio y la BD queda
 *    EXACTAMENTE igual (líneas, subtotal, requestType, historial).
 * 2. CARRERA DE ESTADO: con la fila del pedido bloqueada por otra
 *    transacción, la edición espera el lock, re-chequea el estado BLOQUEADO
 *    y aborta con 409 sin escribir nada.
 * 3. PROMOCIÓN cotización→pedido: se re-validan TODAS las líneas existentes
 *    (precio > 0); si alguna requiere cotización se rechaza con 400.
 * 4. STALE READS: la promoción re-valida las líneas RE-LEÍDAS bajo el lock
 *    (una edición concurrente B confirmada durante la espera se respeta y se
 *    re-precia; nunca el snapshot previo).
 * 5. OWNERSHIP POST-LOCK: una transferencia guest→CUSTOMER confirmada
 *    mientras la sesión invitada esperaba el lock aborta con 403 y CERO
 *    writes.
 */

const HAS_POSTGRES = Boolean(process.env.DATABASE_URL?.startsWith('postgres'));
const d = it.skipIf(!HAS_POSTGRES);

const RUN = `${Date.now()}`;
let categoryId: string;
let productId: string;
let quoteProductId: string;
let customerId: string;

// Pedido sembrado para el test de rollback
let rollbackOrderId: string;
// Pedido sembrado para el test de carrera
let raceOrderId: string;
// Pedidos de promoción (negativo con línea null; positivo con precio)
let promoBlockedOrderId: string;
let promoOkOrderId: string;
// Pedido de la carrera de líneas concurrentes (T1)
let racePromoOrderId: string;
// Pedido guest transferido bajo el lock (T2) + usuario destino y sesión
let transferOrderId: string;
let transferUserId: string;
const TRANSFER_SESS = `sess-edit-${RUN}-xfer`;

const viewerFor = (order: { customerId: string | null; sessionId: string | null }) =>
  order.customerId
    ? { user: { id: order.customerId, role: 'CUSTOMER' }, sessionId: null }
    : { user: null, sessionId: order.sessionId };

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

async function seedHistoricalOrder(opts: {
  suffix: string;
  status: string;
  requestType: string;
  items: Array<{ productId: string; quantity: number; unitPrice: number | null }>;
}) {
  const cart = await db.cart.create({
    data: {
      sessionId: `sess-edit-${RUN}-${opts.suffix}`,
      status: 'convertido',
    },
  });
  const subtotal = opts.items.reduce((sum, i) => sum + (i.unitPrice ?? 0) * i.quantity, 0);
  return db.order.create({
    data: {
      orderNumber: `CS-EDIT-${RUN}-${opts.suffix}`,
      cartId: cart.id,
      customerId,
      subtotal,
      status: opts.status,
      requestType: opts.requestType,
      items: {
        create: opts.items.map((i) => ({
          productId: i.productId,
          productName: 'Producto edición',
          quantity: i.quantity,
          unitPrice: i.unitPrice,
        })),
      },
    },
    include: { items: true },
  });
}

beforeAll(async () => {
  if (!HAS_POSTGRES) return;

  const category = await db.category.create({
    data: { name: `Cat edición ${RUN}`, slug: `cat-edicion-${RUN}` },
  });
  categoryId = category.id;

  const product = await db.product.create({
    data: {
      name: 'Producto edición',
      slug: `prod-edicion-${RUN}`,
      price: 10000,
      wholesalePrice: 8000,
      stockQuantity: 100,
      categoryId,
    },
  });
  productId = product.id;

  // Producto SIN precio: las líneas que lo referencian requieren cotización
  const quoteProduct = await db.product.create({
    data: {
      name: 'Producto sin precio',
      slug: `prod-edit-cotiza-${RUN}`,
      price: 0,
      wholesalePrice: 0,
      stockQuantity: 10,
      categoryId,
    },
  });
  quoteProductId = quoteProduct.id;

  const customer = await db.user.create({
    data: {
      name: `Cliente edición ${RUN}`,
      phone: `57320000${RUN.slice(-4)}`,
      role: 'CUSTOMER',
      password: 'x',
    },
  });
  customerId = customer.id;
}, 30000);

afterAll(async () => {
  if (!HAS_POSTGRES) return;

  const orderIds = [
    rollbackOrderId,
    raceOrderId,
    promoBlockedOrderId,
    promoOkOrderId,
    racePromoOrderId,
    transferOrderId,
  ].filter(Boolean);
  await db.order.deleteMany({ where: { id: { in: orderIds } } });
  await db.cart.deleteMany({ where: { sessionId: { startsWith: `sess-edit-${RUN}` } } });
  await db.user.deleteMany({ where: { id: { in: [customerId, transferUserId].filter(Boolean) } } });
  await db.product.deleteMany({
    where: { id: { in: [productId, quoteProductId].filter(Boolean) } },
  });
  await db.category.deleteMany({ where: { slug: `cat-edicion-${RUN}` } });
  await db.$disconnect();
}, 30000);

d('ROLLBACK: cityId inválido deja el pedido EXACTAMENTE igual', async () => {
  const order = await seedHistoricalOrder({
    suffix: 'rb',
    status: 'solicitado',
    requestType: 'cotizacion',
    items: [
      { productId, quantity: 2, unitPrice: 8000 },
      { productId, quantity: 1, unitPrice: null },
    ],
  });
  rollbackOrderId = order.id;

  const itemsBefore = order.items.map((i) => ({
    productId: i.productId,
    quantity: i.quantity,
    unitPrice: i.unitPrice,
  }));
  const historyBefore = await db.orderStatusHistory.count({ where: { orderId: order.id } });

  await expect(
    editCustomerOrder({
      orderId: order.id,
      viewer: viewerFor(order),
      sessionUser: { id: customerId, role: 'CUSTOMER' },
      sessionId: null,
      body: {
        items: [{ productId, quantity: 5 }],
        cityId: 'NO_EXISTE_CIUDAD',
      },
    })
  ).rejects.toMatchObject({ status: 400, message: 'Ciudad no válida' });

  // Líneas EXACTAMENTE las anteriores (deleteMany+createMany implica ids
  // nuevos; se comparan los sets de contenido)
  const itemsAfter = await db.orderItem.findMany({ where: { orderId: order.id } });
  expect(itemsAfter.map((i) => ({ productId: i.productId, quantity: i.quantity, unitPrice: i.unitPrice })))
    .toEqual(itemsBefore);

  // Sin historial nuevo, subtotal y requestType intactos
  expect(await db.orderStatusHistory.count({ where: { orderId: order.id } })).toBe(historyBefore);
  const after = await db.order.findUnique({ where: { id: order.id } });
  expect(after!.subtotal).toBe(16000);
  expect(after!.requestType).toBe('cotizacion');
  expect(after!.cityId).toBeNull();
});

d('CARRERA DE ESTADO: lock FOR UPDATE + re-chequeo => 409 y cero writes', async () => {
  const order = await seedHistoricalOrder({
    suffix: 'race',
    status: 'solicitado',
    requestType: 'pedido',
    items: [{ productId, quantity: 2, unitPrice: 8000 }],
  });
  raceOrderId = order.id;

  const historyBefore = await db.orderStatusHistory.count({ where: { orderId: order.id } });

  // Segundo cliente Prisma para sostener el lock desde otra transacción
  const other = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  try {
    // 1) El controlador toma el lock de la fila ANTES de lanzar la edición.
    const controller = other.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE`;
      await waitForVictimLocked(other, 'FROM "Order"');
      // 2) La edición arranca mientras el lock está tomado: su lectura
      //    inicial ve 'solicitado' pero se BLOQUEA en el FOR UPDATE interno.
      // 3) Con la edición esperando, el controlador cambia el estado y libera.
      await new Promise((r) => setTimeout(r, 400));
      await tx.order.update({ where: { id: order.id }, data: { status: 'compartido' } });
    });

    await new Promise((r) => setTimeout(r, 150)); // la edición llega al lock
    const editPromise = editCustomerOrder({
      orderId: order.id,
      viewer: viewerFor(order),
      sessionUser: { id: customerId, role: 'CUSTOMER' },
      sessionId: null,
      body: { items: [{ productId, quantity: 9 }] },
    }).catch((e) => e);

    await controller;
    const editError = (await editPromise) as OrderEditError;

    expect(editError).toBeInstanceOf(OrderEditError);
    expect(editError.status).toBe(409);

    // Estado compartido, líneas intactas, SIN historial nuevo
    const after = await db.order.findUnique({ where: { id: order.id }, include: { items: true } });
    expect(after!.status).toBe('compartido');
    expect(after!.items[0].quantity).toBe(2);
    expect(await db.orderStatusHistory.count({ where: { orderId: order.id } })).toBe(historyBefore);
  } finally {
    await other.$disconnect();
  }
}, 30000);

d('PROMOCIÓN cotización→pedido: línea sin precio bloquea la conversión (400, sin writes)', async () => {
  const order = await seedHistoricalOrder({
    suffix: 'promo-nok',
    status: 'solicitado',
    requestType: 'cotizacion',
    items: [{ productId: quoteProductId, quantity: 1, unitPrice: null }],
  });
  promoBlockedOrderId = order.id;

  const historyBefore = await db.orderStatusHistory.count({ where: { orderId: order.id } });

  await expect(
    editCustomerOrder({
      orderId: order.id,
      viewer: viewerFor(order),
      sessionUser: { id: customerId, role: 'CUSTOMER' },
      sessionId: null,
      body: { requestType: 'pedido' },
    })
  ).rejects.toMatchObject({
    status: 400,
    message: expect.stringContaining('No se puede convertir la cotización en pedido'),
  });

  // Sigue cotización, línea sin precio, sin historial nuevo
  const after = await db.order.findUnique({ where: { id: order.id }, include: { items: true } });
  expect(after!.requestType).toBe('cotizacion');
  expect(after!.items[0].unitPrice).toBeNull();
  expect(await db.orderStatusHistory.count({ where: { orderId: order.id } })).toBe(historyBefore);
});

d('PROMOCIÓN cotización→pedido con precio válido: líneas reescritas + subtotal re-validado + historial', async () => {
  // La línea histórica es de cotización (unitPrice null): al promover, el
  // snapshot persistido debe reescribirse con el precio re-validado.
  const order = await seedHistoricalOrder({
    suffix: 'promo-ok',
    status: 'solicitado',
    requestType: 'cotizacion',
    items: [{ productId, quantity: 3, unitPrice: null }],
  });
  promoOkOrderId = order.id;

  const updated = await editCustomerOrder({
    orderId: order.id,
    viewer: viewerFor(order),
    sessionUser: { id: customerId, role: 'CUSTOMER' },
    sessionId: null,
    body: { requestType: 'pedido' },
  });

  expect(updated!.requestType).toBe('pedido');
  // Subtotal re-validado con el motor: 3 × 8000 (wholesale base)
  expect(updated!.subtotal).toBe(24000);
  // El snapshot devuelto NO conserva el precio null
  expect(updated!.items[0].unitPrice).toBe(8000);

  // Persistencia REAL: la fila reescrita tiene unitPrice NO nulo (un pedido
  // jamás conserva líneas sin precio: webhook, /mine y detalle la leen)
  const after = await db.order.findUnique({ where: { id: order.id }, include: { items: true } });
  expect(after!.requestType).toBe('pedido');
  expect(after!.subtotal).toBe(24000);
  expect(after!.items).toHaveLength(1);
  expect(after!.items[0].unitPrice).not.toBeNull();
  expect(after!.items[0].unitPrice).toBe(8000);

  const history = await db.orderStatusHistory.findMany({ where: { orderId: order.id } });
  expect(history.some((h) => h.changedBy === 'cliente')).toBe(true);
});

d('STALE READS: la promoción re-precia las líneas confirmadas por B bajo el lock', async () => {
  // Pedido cotización con línea SIN precio. Mientras la edición espera el
  // lock, otra escritura B (confirmada) reemplaza las líneas: la promoción
  // debe re-validar/re-preciar las líneas POST-lock (7 unidades), NUNCA el
  // snapshot previo (2 unidades).
  const order = await seedHistoricalOrder({
    suffix: 'race-promo',
    status: 'solicitado',
    requestType: 'cotizacion',
    items: [{ productId, quantity: 2, unitPrice: null }],
  });
  racePromoOrderId = order.id;

  const other = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  try {
    // El controlador sostiene el lock y, mientras la edición espera, confirma
    // la edición concurrente B conservando el estado 'solicitado'.
    const controller = other.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE`;
      await waitForVictimLocked(other, 'FROM "Order"');
      await new Promise((r) => setTimeout(r, 400));
      await tx.orderItem.deleteMany({ where: { orderId: order.id } });
      await tx.orderItem.createMany({
        data: [
          {
            orderId: order.id,
            productId,
            productName: 'Producto edición',
            quantity: 7,
            unitPrice: null,
          },
        ],
      });
      await tx.order.update({ where: { id: order.id }, data: { subtotal: 999 } });
    });

    await new Promise((r) => setTimeout(r, 150)); // la edición llega al lock
    const editPromise = editCustomerOrder({
      orderId: order.id,
      viewer: { user: { id: customerId, role: 'CUSTOMER' }, sessionId: null },
      sessionUser: { id: customerId, role: 'CUSTOMER' },
      sessionId: null,
      body: { requestType: 'pedido' }, // promoción SIN items en el body
    }).catch((e) => e);

    await controller;
    const updated = (await editPromise) as any;

    expect(updated.requestType).toBe('pedido');
    // La ÚNICA línea es la de B (7 unidades) re-preciada por el motor:
    // jamás las 2 unidades del snapshot previo.
    expect(updated.items).toHaveLength(1);
    expect(updated.items[0].quantity).toBe(7);
    expect(updated.items[0].unitPrice).toBe(8000);
    // Subtotal re-validado desde las líneas POST-lock: 7 × 8000
    expect(updated.subtotal).toBe(56000);

    // Persistencia REAL: el snapshot persistido refleja B re-preciado.
    const after = await db.order.findUnique({ where: { id: order.id }, include: { items: true } });
    expect(after!.requestType).toBe('pedido');
    expect(after!.subtotal).toBe(56000);
    expect(after!.items[0].quantity).toBe(7);
    expect(after!.items[0].unitPrice).toBe(8000);
  } finally {
    await other.$disconnect();
  }
}, 30000);

d('OWNERSHIP POST-LOCK: transferencia guest→CUSTOMER bajo el lock => 403 y cero writes', async () => {
  // Pedido GUEST (sessionId, sin customerId). Durante la espera del lock se
  // confirma la transferencia de propiedad (login/registro): la sesión
  // invitada pierde acceso y la edición aborta con 403 SIN escribir nada.
  const cart = await db.cart.create({
    data: { sessionId: TRANSFER_SESS, status: 'convertido' },
  });
  const order = await db.order.create({
    data: {
      orderNumber: `CS-EDIT-XFER-${RUN}`,
      cartId: cart.id,
      sessionId: TRANSFER_SESS,
      customerId: null,
      subtotal: 16000,
      status: 'solicitado',
      requestType: 'pedido',
      items: {
        create: [{ productId, productName: 'Producto edición', quantity: 2, unitPrice: 8000 }],
      },
    },
    include: { items: true },
  });
  transferOrderId = order.id;

  // Usuario CUSTOMER destino de la transferencia (como en guest-lifecycle).
  const userU = await db.user.create({
    data: {
      name: `Cliente transferencia ${RUN}`,
      phone: `57329999${RUN.slice(-4)}`,
      role: 'CUSTOMER',
      password: 'x',
    },
  });
  transferUserId = userU.id;

  const historyBefore = await db.orderStatusHistory.count({ where: { orderId: order.id } });

  const other = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  try {
    const controller = other.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE`;
      await waitForVictimLocked(other, 'FROM "Order"');
      await new Promise((r) => setTimeout(r, 400));
      // Lo que transferSessionDataToUser escribe al transferir propiedad.
      await tx.order.update({
        where: { id: order.id },
        data: { customerId: userU.id, sessionId: null },
      });
    });

    await new Promise((r) => setTimeout(r, 150)); // la edición llega al lock
    const editPromise = editCustomerOrder({
      orderId: order.id,
      viewer: { user: null, sessionId: TRANSFER_SESS },
      sessionUser: null,
      sessionId: TRANSFER_SESS,
      body: { items: [{ productId, quantity: 9 }] },
    }).catch((e) => e);

    await controller;
    const editError = (await editPromise) as any;

    expect(editError).toBeInstanceOf(OrderAccessError);
    expect(editError.status).toBe(403);

    // CERO writes del victimizador: líneas EXACTAMENTE las originales del
    // guest (cantidad 2, precio 8000), estado intacto y sin historial nuevo.
    const after = await db.order.findUnique({ where: { id: order.id }, include: { items: true } });
    expect(after!.status).toBe('solicitado');
    expect(after!.items).toHaveLength(1);
    expect(after!.items[0].productId).toBe(productId);
    expect(after!.items[0].quantity).toBe(2);
    expect(after!.items[0].unitPrice).toBe(8000);
    expect(await db.orderStatusHistory.count({ where: { orderId: order.id } })).toBe(historyBefore);
  } finally {
    await other.$disconnect();
  }
}, 30000);
