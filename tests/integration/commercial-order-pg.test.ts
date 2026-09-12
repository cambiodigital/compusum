import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { db } from '@/lib/db';
import {
  saveCommercialCalculation,
  recalculateCommercialOrder,
  convertQuoteToOrder,
  previewCommercialLines,
  CommercialOrderError,
} from '@/lib/commercial-order';

/**
 * FASE 4B — CÁLCULO COMERCIAL contra PostgreSQL REAL.
 *
 * 1. AISLAMIENTO: AGENT A calcula SU pedido con el motor real (perfil -10%);
 *    sobre el pedido de AGENT B => 404 y CERO writes.
 * 2. CARRERA DE STOCK: el stock baja DENTRO de la transacción que sostiene el
 *    lock del Order mientras el cálculo espera; el cálculo post-lock ve el
 *    stock real (1) y rechaza con 400 sin writes parciales.
 * 3. STATUS GANA: solicitado→compartido confirmado durante la espera del lock
 *    => el cálculo detecta el estado POST-lock y escribe CERO cambios (409).
 * 4. CÁLCULO GANA: el commit del cálculo es atómico y el cambio de estado
 *    posterior observa los items/subtotal resultantes.
 * 5. DOS CÁLCULOS CONCURRENTES: serializados por el lock, sobrevive EXACTAMENTE
 *    el set completo de un escritor (jamás un merge mixto) y quedan DOS filas
 *    de auditoría: cero lost update silencioso.
 * 6. CONVERSIÓN end-to-end: snapshots byte-equal, subtotal correcto,
 *    requestType=pedido y productos/perfil GLOBALES intactos.
 * 7. PRODUCTO DESACTIVADO entre preview y convert => 400 y cero writes.
 */

const HAS_POSTGRES = Boolean(process.env.DATABASE_URL?.startsWith('postgres'));
const d = it.skipIf(!HAS_POSTGRES);

const RUN = `${Date.now()}`;

let profileAId: string;
let customerAId: string;
let agentAId: string;
let agentBId: string;
let categoryId: string;
let engineProductId: string;
let quoteProductId: string;
let inactiveProductId: string;

// Pedidos sembrados
let orderAId: string;
let orderBId: string;
let stockRaceOrderId: string;
let statusRaceOrderId: string;
let calcWinsOrderId: string;
let concurrentOrderId: string;
let convertQuoteOrderId: string;
let deactivationQuoteOrderId: string;

const agentAActor = () => ({ id: agentAId, role: 'AGENT', name: `Asesor A ${RUN}` });
const adminActor = { id: 'admin-4b', role: 'admin', name: 'Admin 4B' };

const phoneFor = (n: number) => `5730${RUN.slice(-8)}${n}`;

async function seedOrder(opts: {
  suffix: string;
  agentId: string | null;
  customerId: string | null;
  requestType: string;
  status?: string;
  items: Array<{ productId: string; quantity: number; unitPrice: number | null }>;
}) {
  const cart = await db.cart.create({
    data: { sessionId: `sess-comm-${RUN}-${opts.suffix}`, status: 'convertido' },
  });
  const subtotal = opts.items.reduce((sum, i) => sum + (i.unitPrice ?? 0) * i.quantity, 0);
  return db.order.create({
    data: {
      orderNumber: `CS-4B-${RUN}-${opts.suffix}`,
      cartId: cart.id,
      customerId: opts.customerId,
      agentId: opts.agentId,
      subtotal,
      status: opts.status ?? 'solicitado',
      requestType: opts.requestType,
      items: {
        create: opts.items.map((i) => ({
          productId: i.productId,
          productName: 'Producto comercial',
          quantity: i.quantity,
          unitPrice: i.unitPrice,
        })),
      },
    },
    include: { items: true },
  });
}

async function itemsOf(orderId: string) {
  return db.orderItem.findMany({
    where: { orderId },
    orderBy: { id: 'asc' },
    select: { id: true, productId: true, quantity: true, unitPrice: true },
  });
}

async function historyCount(orderId: string) {
  return db.orderStatusHistory.count({ where: { orderId } });
}

/**
 * Barrera determinista (idéntica a order-edit-pg): espera a que la víctima
 * esté REALMENTE bloqueada en el lock de fila antes de que el controlador
 * escriba.
 */
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

  const profileA = await db.priceProfile.create({
    data: {
      name: `Perfil A ${RUN}`,
      code: `PA-4B-${RUN}`,
      percentAdjustment: -10,
      isActive: true,
    },
  });
  profileAId = profileA.id;

  const customerA = await db.user.create({
    data: {
      name: `Cliente A ${RUN}`,
      phone: phoneFor(1),
      role: 'CUSTOMER',
      password: 'x',
      priceProfileId: profileAId,
    },
  });
  customerAId = customerA.id;

  const agentA = await db.user.create({
    data: { name: `Asesor A ${RUN}`, phone: phoneFor(2), role: 'AGENT', password: 'x' },
  });
  agentAId = agentA.id;
  const agentB = await db.user.create({
    data: { name: `Asesor B ${RUN}`, phone: phoneFor(3), role: 'AGENT', password: 'x' },
  });
  agentBId = agentB.id;

  const category = await db.category.create({
    data: { name: `Cat comercial ${RUN}`, slug: `cat-comercial-${RUN}` },
  });
  categoryId = category.id;

  const engineProduct = await db.product.create({
    data: {
      name: 'Producto Engine 4B',
      slug: `prod-engine-4b-${RUN}`,
      price: 12000,
      wholesalePrice: 10000,
      stockQuantity: 50,
      minWholesaleQty: 2,
      categoryId,
    },
  });
  engineProductId = engineProduct.id;

  const quoteProduct = await db.product.create({
    data: {
      name: 'Producto Cotizacion 4B',
      slug: `prod-quote-4b-${RUN}`,
      price: 0,
      wholesalePrice: 0,
      stockQuantity: 10,
      categoryId,
    },
  });
  quoteProductId = quoteProduct.id;

  const inactiveProduct = await db.product.create({
    data: {
      name: 'Producto Inactivo 4B',
      slug: `prod-inactive-4b-${RUN}`,
      price: 5000,
      wholesalePrice: 4000,
      stockQuantity: 10,
      isActive: false,
      categoryId,
    },
  });
  inactiveProductId = inactiveProduct.id;
}, 30000);

afterAll(async () => {
  if (!HAS_POSTGRES) return;

  const orderIds = [
    orderAId,
    orderBId,
    stockRaceOrderId,
    statusRaceOrderId,
    calcWinsOrderId,
    concurrentOrderId,
    convertQuoteOrderId,
    deactivationQuoteOrderId,
  ].filter(Boolean);
  await db.order.deleteMany({ where: { id: { in: orderIds } } });
  await db.cart.deleteMany({ where: { sessionId: { startsWith: `sess-comm-${RUN}` } } });
  await db.user.deleteMany({
    where: { id: { in: [customerAId, agentAId, agentBId].filter(Boolean) } },
  });
  await db.priceProfile.deleteMany({ where: { id: profileAId } });
  await db.product.deleteMany({
    where: { id: { in: [engineProductId, quoteProductId, inactiveProductId].filter(Boolean) } },
  });
  await db.category.deleteMany({ where: { slug: `cat-comercial-${RUN}` } });
  await db.$disconnect();
}, 30000);

d('AGENT A: save en pedido A usa SU perfil (-10%) end-to-end con el motor real', async () => {
  const order = await seedOrder({
    suffix: 'own',
    agentId: agentAId,
    customerId: customerAId,
    requestType: 'pedido',
    items: [{ productId: engineProductId, quantity: 2, unitPrice: 12345 }],
  });
  orderAId = order.id;

  const result = await saveCommercialCalculation({
    orderId: order.id,
    actor: agentAActor(),
    lines: [{ productId: engineProductId, quantity: 2 }],
  });

  // 10000 base × (1 - 10%) = 9000 por unidad; subtotal 18000.
  expect(result.lines[0].snapshotUnitPrice).toBe(9000);
  expect(result.storedSubtotal).toBe(18000);

  const after = await db.order.findUnique({ where: { id: order.id }, include: { items: true } });
  expect(after!.subtotal).toBe(18000);
  expect(after!.items).toHaveLength(1);
  expect(after!.items[0].unitPrice).toBe(9000);
  expect(after!.items[0].quantity).toBe(2);

  const history = await db.orderStatusHistory.findMany({ where: { orderId: order.id } });
  expect(history.some((h) => h.changedBy === `Asesor A ${RUN}` && h.note === 'Líneas comerciales actualizadas')).toBe(true);
}, 30000);

d('AGENT A: save sobre pedido B (de AGENT B) => 404 y CERO writes', async () => {
  const orderB = await seedOrder({
    suffix: 'foreign',
    agentId: agentBId,
    customerId: null,
    requestType: 'pedido',
    items: [{ productId: engineProductId, quantity: 2, unitPrice: 8000 }],
  });
  orderBId = orderB.id;

  const itemsBefore = await itemsOf(orderB.id);
  const historyBefore = await historyCount(orderB.id);
  const orderBefore = await db.order.findUnique({ where: { id: orderB.id } });

  await expect(
    saveCommercialCalculation({
      orderId: orderB.id,
      actor: agentAActor(),
      lines: [{ productId: engineProductId, quantity: 3 }],
    })
  ).rejects.toMatchObject({ status: 404, message: 'Pedido no encontrado' });

  // Cero writes: items, subtotal, requestType e historial intactos.
  expect(await itemsOf(orderB.id)).toEqual(itemsBefore);
  expect(await historyCount(orderB.id)).toBe(historyBefore);
  const orderAfter = await db.order.findUnique({ where: { id: orderB.id } });
  expect(orderAfter!.subtotal).toBe(orderBefore!.subtotal);
  expect(orderAfter!.requestType).toBe('pedido');
  expect(orderAfter!.status).toBe('solicitado');
}, 30000);

d('CARRERA DE STOCK: stock baja bajo lock mientras el cálculo espera => 400 y cero writes parciales', async () => {
  const order = await seedOrder({
    suffix: 'stockrace',
    agentId: agentAId,
    customerId: customerAId,
    requestType: 'pedido',
    items: [{ productId: engineProductId, quantity: 2, unitPrice: 9000 }],
  });
  stockRaceOrderId = order.id;

  // Preview SIN contención: stock 50, línea válida.
  const preview = await previewCommercialLines(order.id, agentAActor(), [
    { productId: engineProductId, quantity: 2 },
  ]);
  expect(preview.lines[0].currentStockQuantity).toBe(50);
  expect(preview.validationError).toBeNull();

  const itemsBefore = await itemsOf(order.id);
  const historyBefore = await historyCount(order.id);

  const other = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  try {
    // 1) El controlador sostiene el lock de la fila del Order.
    const controller = other.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE`;
      await waitForVictimLocked(other, 'FROM "Order"');
      await new Promise((r) => setTimeout(r, 400));
      // 2) Con el cálculo esperando, el stock REAL baja a 1 y se confirma.
      await tx.product.update({
        where: { id: engineProductId },
        data: { stockQuantity: 1 },
      });
    });

    await new Promise((r) => setTimeout(r, 150)); // el cálculo llega al lock
    const savePromise = saveCommercialCalculation({
      orderId: order.id,
      actor: agentAActor(),
      lines: [{ productId: engineProductId, quantity: 2 }],
    }).catch((e) => e);

    await controller;
    const err = (await savePromise) as CommercialOrderError;

    // 3) Post-lock el motor ve stock 1 < solicitado 2 => rechazo comercial.
    expect(err).toBeInstanceOf(CommercialOrderError);
    expect(err.status).toBe(400);
    expect(err.message).toContain('disponibilidad');

    // CERO writes parciales: líneas, subtotal, estado e historial intactos.
    expect(await itemsOf(order.id)).toEqual(itemsBefore);
    expect(await historyCount(order.id)).toBe(historyBefore);
    const after = await db.order.findUnique({ where: { id: order.id } });
    expect(after!.subtotal).toBe(18000);
    expect(after!.status).toBe('solicitado');
    expect(after!.requestType).toBe('pedido');
  } finally {
    await other.$disconnect();
  }
  // Restaurar stock para los tests siguientes.
  await db.product.update({ where: { id: engineProductId }, data: { stockQuantity: 50 } });
}, 30000);

d('STATUS GANA: solicitado→compartido confirmado bajo lock => cálculo 409 y CERO cambios', async () => {
  const order = await seedOrder({
    suffix: 'statusrace',
    agentId: agentAId,
    customerId: customerAId,
    requestType: 'pedido',
    items: [{ productId: engineProductId, quantity: 2, unitPrice: 9000 }],
  });
  statusRaceOrderId = order.id;

  const itemsBefore = await itemsOf(order.id);
  const historyBefore = await historyCount(order.id);

  const other = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  try {
    const controller = other.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE`;
      await waitForVictimLocked(other, 'FROM "Order"');
      await new Promise((r) => setTimeout(r, 400));
      // El flujo legítimo de cambio de estado gana la carrera.
      await tx.order.update({ where: { id: order.id }, data: { status: 'compartido' } });
      await tx.orderStatusHistory.create({
        data: {
          orderId: order.id,
          fromStatus: 'solicitado',
          toStatus: 'compartido',
          changedBy: 'otro-proceso',
          note: 'status race',
        },
      });
    });

    await new Promise((r) => setTimeout(r, 150));
    const savePromise = saveCommercialCalculation({
      orderId: order.id,
      actor: agentAActor(),
      lines: [{ productId: engineProductId, quantity: 3 }],
    }).catch((e) => e);

    await controller;
    const err = (await savePromise) as CommercialOrderError;

    expect(err).toBeInstanceOf(CommercialOrderError);
    expect(err.status).toBe(409);

    // CERO writes del cálculo: el snapshot quedó congelado al compartirse.
    expect(await itemsOf(order.id)).toEqual(itemsBefore);
    const after = await db.order.findUnique({ where: { id: order.id } });
    expect(after!.status).toBe('compartido');
    expect(after!.subtotal).toBe(18000);
    expect(after!.requestType).toBe('pedido');
    // Solo la fila de auditoría del cambio de estado (jamás la del cálculo).
    expect(await historyCount(order.id)).toBe(historyBefore + 1);
  } finally {
    await other.$disconnect();
  }
}, 30000);

d('CÁLCULO GANA: su commit es atómico y el cambio de estado posterior observa el resultado', async () => {
  const order = await seedOrder({
    suffix: 'calcwins',
    agentId: agentAId,
    customerId: customerAId,
    requestType: 'pedido',
    items: [{ productId: engineProductId, quantity: 1, unitPrice: 12345 }],
  });
  calcWinsOrderId = order.id;

  // El cálculo corre SIN contención y gana primero.
  const result = await saveCommercialCalculation({
    orderId: order.id,
    actor: agentAActor(),
    lines: [{ productId: engineProductId, quantity: 2 }],
  });
  expect(result.storedSubtotal).toBe(18000);

  // El cambio de estado POSTERIOR ve exactamente el estado resultante.
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${order.id} FOR UPDATE`;
    await tx.order.update({ where: { id: order.id }, data: { status: 'compartido' } });
    await tx.orderStatusHistory.create({
      data: {
        orderId: order.id,
        fromStatus: 'solicitado',
        toStatus: 'compartido',
        changedBy: 'otro-proceso',
        note: 'post-calc flip',
      },
    });
  });

  const after = await db.order.findUnique({ where: { id: order.id }, include: { items: true } });
  expect(after!.status).toBe('compartido');
  expect(after!.subtotal).toBe(18000);
  expect(after!.items).toHaveLength(1);
  expect(after!.items[0].quantity).toBe(2);
  expect(after!.items[0].unitPrice).toBe(9000);
  const history = await db.orderStatusHistory.findMany({ where: { orderId: order.id } });
  expect(history.some((h) => h.note === 'post-calc flip')).toBe(true);
}, 30000);

d('DOS CÁLCULOS CONCURRENTES: serialización por lock, un set completo sobrevive, DOS auditorías', async () => {
  const order = await seedOrder({
    suffix: 'concurrent',
    agentId: agentAId,
    customerId: customerAId,
    requestType: 'pedido',
    items: [{ productId: engineProductId, quantity: 2, unitPrice: 8000 }],
  });
  concurrentOrderId = order.id;
  const historyBefore = await historyCount(order.id);

  const [resultA, resultB] = await Promise.allSettled([
    saveCommercialCalculation({
      orderId: order.id,
      actor: agentAActor(),
      lines: [{ productId: engineProductId, quantity: 2 }],
      note: 'calc A',
    }),
    saveCommercialCalculation({
      orderId: order.id,
      actor: agentAActor(),
      lines: [{ productId: engineProductId, quantity: 3 }],
      note: 'calc B',
    }),
  ]);

  // Ambos tienen éxito (serializados por el lock del Order): ninguno falla.
  expect(resultA.status).toBe('fulfilled');
  expect(resultB.status).toBe('fulfilled');

  // El estado final es EXACTAMENTE el set completo de UN escritor.
  const items = await itemsOf(order.id);
  expect(items).toHaveLength(1);
  const survivingQty = items[0].quantity;
  expect([2, 3]).toContain(survivingQty);
  // Sin mezclas: el subtotal corresponde al set sobreviviente (9000 c/u).
  const after = await db.order.findUnique({ where: { id: order.id } });
  expect(after!.subtotal).toBe(survivingQty * 9000);

  // Ambas auditorías quedaron registradas: NINGÚN lost update silencioso.
  const history = await db.orderStatusHistory.findMany({ where: { orderId: order.id } });
  expect(await historyCount(order.id)).toBe(historyBefore + 2);
  expect(history.map((h) => h.note).sort()).toEqual(['calc A', 'calc B'].concat([]).sort());
}, 30000);

d('CONVERSIÓN end-to-end: snapshots byte-equal, subtotal correcto, productos/perfil globales intactos', async () => {
  const order = await seedOrder({
    suffix: 'convert',
    agentId: agentAId,
    customerId: customerAId,
    requestType: 'cotizacion',
    items: [
      { productId: engineProductId, quantity: 2, unitPrice: 9000 },
      { productId: quoteProductId, quantity: 1, unitPrice: 8500 },
    ],
  });
  convertQuoteOrderId = order.id;

  const productsBefore = await db.product.findMany({
    where: { id: { in: [engineProductId, quoteProductId] } },
    select: {
      id: true,
      price: true,
      wholesalePrice: true,
      stockQuantity: true,
      minWholesaleQty: true,
      isActive: true,
      stockStatus: true,
    },
  });
  const profileBefore = await db.priceProfile.findUnique({ where: { id: profileAId } });
  const itemsBefore = await itemsOf(order.id);
  const historyBefore = await historyCount(order.id);

  const result = await convertQuoteToOrder({ orderId: order.id, actor: agentAActor() });

  expect(result.requestType).toBe('pedido');
  expect(result.storedSubtotal).toBe(26500);

  const after = await db.order.findUnique({ where: { id: order.id }, include: { items: true } });
  expect(after!.requestType).toBe('pedido');
  expect(after!.subtotal).toBe(26500);

  // Snapshots BYTE-EQUAL: mismos ids, cantidades y precios cotizados
  // (la conversión jamás re-precia con requestType "pedido").
  const itemsAfter = await itemsOf(order.id);
  expect(itemsAfter).toEqual(itemsBefore);
  expect(itemsAfter.map((i) => [i.productId, i.quantity, i.unitPrice])).toEqual([
    [engineProductId, 2, 9000],
    [quoteProductId, 1, 8500],
  ]);

  // Auditoría de conversión.
  expect(await historyCount(order.id)).toBe(historyBefore + 1);
  const history = await db.orderStatusHistory.findMany({ where: { orderId: order.id } });
  expect(history.some((h) => h.note === 'Cotización convertida en pedido')).toBe(true);

  // Producto/variante/perfil GLOBALES intactos.
  const productsAfter = await db.product.findMany({
    where: { id: { in: [engineProductId, quoteProductId] } },
    select: {
      id: true,
      price: true,
      wholesalePrice: true,
      stockQuantity: true,
      minWholesaleQty: true,
      isActive: true,
      stockStatus: true,
    },
  });
  expect(productsAfter).toEqual(productsBefore);
  const profileAfter = await db.priceProfile.findUnique({ where: { id: profileAId } });
  expect(profileAfter!.percentAdjustment).toBe(profileBefore!.percentAdjustment);
  expect(profileAfter!.isActive).toBe(profileBefore!.isActive);
}, 30000);

d('recalculate en PostgreSQL: re-precia la línea del motor y conserva la negociada', async () => {
  const order = await seedOrder({
    suffix: 'recalc',
    agentId: agentAId,
    customerId: customerAId,
    requestType: 'cotizacion',
    items: [
      { productId: engineProductId, quantity: 2, unitPrice: 111 },
      { productId: quoteProductId, quantity: 1, unitPrice: 8500 },
    ],
  });

  const result = await recalculateCommercialOrder({ orderId: order.id, actor: agentAActor() });

  const items = await db.orderItem.findMany({ where: { orderId: order.id } });
  const byProduct = new Map(items.map((i) => [i.productId, i]));
  expect(byProduct.get(engineProductId)!.unitPrice).toBe(9000);
  expect(byProduct.get(quoteProductId)!.unitPrice).toBe(8500);
  expect(result.storedSubtotal).toBe(26500);

  const history = await db.orderStatusHistory.findMany({ where: { orderId: order.id } });
  expect(history.some((h) => h.note === 'Cotización recalculada por asesor')).toBe(true);

  await db.order.delete({ where: { id: order.id } });
}, 30000);

d('PRODUCTO DESACTIVADO entre preview y convert => convert 400 y cero writes', async () => {
  const order = await seedOrder({
    suffix: 'deactivate',
    agentId: agentAId,
    customerId: customerAId,
    requestType: 'cotizacion',
    items: [{ productId: engineProductId, quantity: 2, unitPrice: 9000 }],
  });
  deactivationQuoteOrderId = order.id;

  // Preview con producto aún activo: la cotización es convertible.
  const preview = await previewCommercialLines(order.id, agentAActor(), [
    { productId: engineProductId, quantity: 2 },
  ]);
  expect(preview.validationError).toBeNull();

  const itemsBefore = await itemsOf(order.id);
  const historyBefore = await historyCount(order.id);

  await db.product.update({ where: { id: engineProductId }, data: { isActive: false } });

  await expect(
    convertQuoteToOrder({ orderId: order.id, actor: agentAActor() })
  ).rejects.toMatchObject({
    status: 400,
    message: expect.stringContaining('no está disponible'),
  });

  // Cero writes: sigue cotización, snapshots intactos, sin auditoría nueva.
  const after = await db.order.findUnique({ where: { id: order.id }, include: { items: true } });
  expect(after!.requestType).toBe('cotizacion');
  expect(await itemsOf(order.id)).toEqual(itemsBefore);
  expect(await historyCount(order.id)).toBe(historyBefore);

  // Reactivar para no contaminar el estado global entre suites.
  await db.product.update({ where: { id: engineProductId }, data: { isActive: true } });
}, 30000);

d('producto inactivo y mínimo de cantidad también bloquean el SAVE en PostgreSQL', async () => {
  const order = await seedOrder({
    suffix: 'saveguards',
    agentId: agentAId,
    customerId: customerAId,
    requestType: 'pedido',
    items: [{ productId: engineProductId, quantity: 2, unitPrice: 9000 }],
  });

  const itemsBefore = await itemsOf(order.id);

  await expect(
    saveCommercialCalculation({
      orderId: order.id,
      actor: adminActor,
      lines: [{ productId: inactiveProductId, quantity: 1 }],
    })
  ).rejects.toMatchObject({
    status: 400,
    message: expect.stringContaining('no está disponible'),
  });

  await expect(
    saveCommercialCalculation({
      orderId: order.id,
      actor: adminActor,
      lines: [{ productId: engineProductId, quantity: 1 }],
    })
  ).rejects.toMatchObject({
    status: 400,
    message: expect.stringContaining('cantidad mínima'),
  });

  expect(await itemsOf(order.id)).toEqual(itemsBefore);
  const after = await db.order.findUnique({ where: { id: order.id } });
  expect(after!.subtotal).toBe(18000);

  await db.order.delete({ where: { id: order.id } });
}, 30000);
