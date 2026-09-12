import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { db } from '@/lib/db';
import { reorderOrderItems } from '@/lib/order-reorder';
import { createOrderFromCart, OrderCreateError } from '@/lib/order-create';
import {
  saveCartChanges,
  clearActiveCarts,
  updateCartByUuid,
} from '@/lib/cart-mutations';
import { CartMutationError } from '@/lib/order-cart-upsert';

/**
 * CARRERAS DE MUTACIÓN DE CARRITO contra PostgreSQL REAL — a través de los
 * SERVICIOS de producción (saveCartChanges / clearActiveCarts /
 * updateCartByUuid / reorderOrderItems / createOrderFromCart), no de mocks.
 *
 * 1. Lost update (reorder vs save): la escritura del save JAMÁS se pierde y
 *    el subtotal siempre es la suma exacta de las líneas finales.
 * 2. Checkout vs save/update/clear: o el checkout convierte primero (el
 *    otro escritor recibe CartMutationError 409 y el convertido queda
 *    EXACTAMENTE intacto) o el otro escritor gana primero (el checkout
 *    procesa el estado que dejó); NUNCA un estado mixto.
 * 3. Transferencia de propiedad bajo el lock (guest→CUSTOMER): la sesión
 *    invitada recibe 403 y CERO writes.
 * 4. PUT sobre carrito convertido bajo el lock: 409 determinístico y
 *    carrito intacto.
 */

const HAS_POSTGRES = Boolean(process.env.DATABASE_URL?.startsWith('postgres'));
const d = it.skipIf(!HAS_POSTGRES);

const RUN = `${Date.now()}`;
let categoryId: string;
let productId: string; // P: wholesale 8000 (precio CUSTOMER)
let qProductId: string; // Q: 5000 plano (producto auxiliar de contraste)
let customerId: string;
let transferUserId: string;

const SESS_X = `sess-cartmut-${RUN}-x`; // carrito guest transferible (T8)
const SESS_Y = `sess-cartmut-${RUN}-y`; // carrito guest del T9
const SESS_Z = `sess-cartmut-${RUN}-z`; // carrito guest transferible del T10

async function activeCartFor(
  owner: { userId?: string; sessionId?: string },
  quantity: number
) {
  return db.cart.create({
    data: {
      userId: owner.userId ?? null,
      sessionId: owner.sessionId ?? null,
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

async function seedHistoricalOrder(suffix: string, quantity: number) {
  const cart = await db.cart.create({
    data: { sessionId: `sess-cartmut-hist-${RUN}-${suffix}`, status: 'convertido' },
  });
  return db.order.create({
    data: {
      orderNumber: `CS-CARTMUT-${RUN}-${suffix}`,
      cartId: cart.id,
      customerId,
      subtotal: 10000 * quantity,
      status: 'compartido',
      items: {
        create: {
          productId,
          productName: 'Producto cartmut',
          quantity,
          unitPrice: 10000, // snapshot histórico distinto del precio actual
        },
      },
    },
    include: { items: true },
  });
}

const customerViewer = () => ({
  sessionId: null as string | null,
  userId: customerId,
  isAdminOrAgent: false,
});

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
    data: { name: `Cat cartmut ${RUN}`, slug: `cat-cartmut-${RUN}` },
  });
  categoryId = category.id;

  const product = await db.product.create({
    data: {
      name: 'Producto cartmut',
      slug: `prod-cartmut-${RUN}`,
      price: 10000,
      wholesalePrice: 8000,
      stockQuantity: 50,
      categoryId,
    },
  });
  productId = product.id;

  const qProduct = await db.product.create({
    data: {
      name: 'Producto Q cartmut',
      slug: `prod-cartmut-q-${RUN}`,
      price: 5000,
      wholesalePrice: 5000,
      stockQuantity: 50,
      categoryId,
    },
  });
  qProductId = qProduct.id;

  const customer = await db.user.create({
    data: {
      name: `Cliente cartmut ${RUN}`,
      phone: `57350000${RUN.slice(-4)}`,
      role: 'CUSTOMER',
      password: 'x',
    },
  });
  customerId = customer.id;

  // Usuario CUSTOMER destino de la transferencia del T8
  const userU = await db.user.create({
    data: {
      name: `Cliente transferido cartmut ${RUN}`,
      phone: `57351111${RUN.slice(-4)}`,
      role: 'CUSTOMER',
      password: 'x',
    },
  });
  transferUserId = userU.id;
}, 30000);

afterAll(async () => {
  if (!HAS_POSTGRES) return;

  // Los checkouts crean pedidos con orderNumber generado: borrarlos por
  // cartId antes de soltar los carritos (FK Order_cartId_fkey).
  const testCarts = await db.cart.findMany({
    where: {
      OR: [
        { userId: { in: [customerId, transferUserId].filter(Boolean) } },
        { sessionId: { startsWith: `sess-cartmut-${RUN}` } },
      ],
    },
    select: { id: true },
  });
  await db.order.deleteMany({ where: { cartId: { in: testCarts.map((c) => c.id) } } });
  await db.order.deleteMany({ where: { orderNumber: { startsWith: `CS-CARTMUT-${RUN}` } } });
  await db.cart.deleteMany({
    where: {
      OR: [
        { userId: { in: [customerId, transferUserId].filter(Boolean) } },
        { sessionId: { startsWith: `sess-cartmut-${RUN}` } },
      ],
    },
  });
  await db.user.deleteMany({
    where: { id: { in: [customerId, transferUserId].filter(Boolean) } },
  });
  await db.product.deleteMany({ where: { id: { in: [productId, qProductId].filter(Boolean) } } });
  await db.category.deleteMany({ where: { slug: `cat-cartmut-${RUN}` } });
  await db.$disconnect();
}, 30000);

d('T4: reorder concurrente con save REAL — sin lost update y subtotal coherente', async () => {
  const cart = await activeCartFor({ userId: customerId }, 2);
  const order = await seedHistoricalOrder('lostupdate', 3);

  try {
    const reorderPromise = reorderOrderItems({
      orderId: order.id,
      viewer: { user: { id: customerId, role: 'CUSTOMER' }, sessionId: null },
      mode: 'add',
      allowPartial: true,
    });
    // ~100ms después: save concurrente sobre el MISMO carrito con producto Q.
    const savePromise = (async () => {
      await new Promise((r) => setTimeout(r, 100));
      return saveCartChanges({
        viewer: customerViewer(),
        action: 'save',
        items: [{ productId: qProductId, quantity: 4 }],
        currentUser: { id: customerId, role: 'CUSTOMER' },
      });
    })();

    const [reorderResult, saveResult] = await Promise.all([
      reorderPromise.catch((e) => e),
      savePromise.catch((e) => e),
    ]);

    // El save NO debe fallar (el lock serializa; ambos writers son válidos).
    expect(saveResult).not.toBeInstanceOf(Error);
    expect(reorderResult).not.toBeInstanceOf(Error);

    // Estado FINAL coherente para CUALQUIER interleaving:
    //   - save último  => {Q4}            (save reemplaza todo)
    //   - reorder último => {Q4, P3}      (reorder vio Q4 fresco y agregó P3)
    // El Q4 del save JAMÁS se pierde; P jamás queda con la cantidad vieja (2).
    const lines = await db.cartItem.findMany({ where: { cartId: cart.id } });
    const byProduct = new Map(lines.map((l) => [l.productId, l]));

    expect(byProduct.get(qProductId)).toBeDefined();
    expect(byProduct.get(qProductId)!.quantity).toBe(4);

    if (byProduct.has(productId)) {
      expect([3, 5]).toContain(byProduct.get(productId)!.quantity);
    }
    expect(lines.length).toBe(byProduct.has(productId) ? 2 : 1);

    // Subtotal EXACTO: suma de unitPrice × cantidad de las líneas reales.
    const freshCart = await db.cart.findUnique({ where: { id: cart.id } });
    const expectedSubtotal = lines.reduce(
      (sum, l) => sum + (l.unitPrice ?? 0) * l.quantity,
      0
    );
    expect(freshCart!.subtotal).toBe(expectedSubtotal);
    const plausible =
      expectedSubtotal === 4 * 5000 || expectedSubtotal === 4 * 5000 + 3 * 8000;
    expect(plausible).toBe(true);
  } finally {
    await db.cart.update({ where: { id: cart.id }, data: { status: 'expirado' } });
  }
}, 30000);

d('T5: checkout concurrente con save — o 409 con convertido intacto, o save primero; nunca estado mixto', async () => {
  const cart = await activeCartFor({ userId: customerId }, 2);

  try {
    const checkoutPromise = createOrderFromCart({
      cartId: cart.id,
      customerName: `Cliente checkout ${RUN}`,
      sessionUser: { id: customerId, role: 'CUSTOMER' },
      sessionId: null,
    });
    const savePromise = (async () => {
      await new Promise((r) => setTimeout(r, 100));
      return saveCartChanges({
        viewer: customerViewer(),
        action: 'save',
        items: [{ productId: qProductId, quantity: 4 }],
        currentUser: { id: customerId, role: 'CUSTOMER' },
      });
    })();

    const [checkoutSettled, saveSettled] = await Promise.allSettled([
      checkoutPromise,
      savePromise,
    ]);

    const checkout =
      checkoutSettled.status === 'fulfilled' ? checkoutSettled.value : null;
    const checkoutError =
      checkoutSettled.status === 'rejected' ? checkoutSettled.reason : null;
    const save = saveSettled.status === 'fulfilled' ? saveSettled.value : null;
    const saveError = saveSettled.status === 'rejected' ? saveSettled.reason : null;

    const converted = await db.cart.findUnique({
      where: { id: cart.id },
      include: { items: true },
    });

    if (save) {
      // El save ganó (o aterrizó en carrito nuevo tras la conversión):
      // el checkout NO puede haber fallido por carrito vacío/procesado sin
      // que exista una explicación coherente; con save ganador el carrito
      // original terminó convertido por el checkout o reemplazado por save.
      expect(checkout).not.toBeNull();
      const orderLines = checkout!.order.items.map((i) => ({
        productId: i.productId,
        quantity: i.quantity,
      }));
      if (orderLines.some((l) => l.productId === qProductId)) {
        // (b) save primero: el checkout procesó el carrito con Q4.
        expect(converted!.status).toBe('convertido');
        expect(converted!.items.map((i) => ({ productId: i.productId, quantity: i.quantity })))
          .toEqual([{ productId: qProductId, quantity: 4 }]);
      } else {
        // (c) checkout completo antes del upsert del save: el save aterrizó
        // en un carrito NUEVO y el convertido quedó EXACTAMENTE intacto.
        expect(orderLines).toEqual([{ productId, quantity: 2 }]);
        expect(converted!.status).toBe('convertido');
        expect(converted!.items.map((i) => ({ productId: i.productId, quantity: i.quantity, unitPrice: i.unitPrice })))
          .toEqual([{ productId, quantity: 2, unitPrice: 8000 }]);
        expect(converted!.subtotal).toBe(16000);
        const newActive = await db.cart.findFirst({
          where: { userId: customerId, status: 'activo' },
          include: { items: true },
        });
        expect(newActive).not.toBeNull();
        expect(newActive!.id).not.toBe(cart.id);
        expect(newActive!.items.map((i) => ({ productId: i.productId, quantity: i.quantity })))
          .toEqual([{ productId: qProductId, quantity: 4 }]);
      }
    } else {
      // (a) checkout primero: save recibió CartMutationError 409 y el
      // convertido quedó EXACTAMENTE intacto (línea original P qty 2).
      expect(saveError).toBeInstanceOf(CartMutationError);
      expect(saveError.status).toBe(409);
      expect(checkout).not.toBeNull();
      expect(converted!.status).toBe('convertido');
      expect(converted!.items).toHaveLength(1);
      expect(converted!.items[0].productId).toBe(productId);
      expect(converted!.items[0].quantity).toBe(2);
      expect(converted!.items[0].unitPrice).toBe(8000);
      expect(converted!.subtotal).toBe(16000);
    }
  } finally {
    await db.cart.update({ where: { id: cart.id }, data: { status: 'expirado' } }).catch(() => undefined);
    await db.cart.updateMany({
      where: { userId: customerId, status: 'activo' },
      data: { status: 'expirado' },
    });
  }
}, 30000);

d('T6: checkout concurrente con update (PUT) — mismos desenlaces coherentes', async () => {
  const cart = await activeCartFor({ userId: customerId }, 2);

  try {
    const checkoutPromise = createOrderFromCart({
      cartId: cart.id,
      customerName: `Cliente checkout ${RUN}`,
      sessionUser: { id: customerId, role: 'CUSTOMER' },
      sessionId: null,
    });
    const updatePromise = (async () => {
      await new Promise((r) => setTimeout(r, 100));
      return updateCartByUuid({
        uuid: cart.uuid,
        viewer: { sessionId: null, userId: customerId, userRole: 'CUSTOMER', staffCanManage: false },
        body: { items: [{ productId: qProductId, quantity: 4 }] },
      });
    })();

    const [checkoutSettled, updateSettled] = await Promise.allSettled([
      checkoutPromise,
      updatePromise,
    ]);

    const checkout =
      checkoutSettled.status === 'fulfilled' ? checkoutSettled.value : null;
    const update = updateSettled.status === 'fulfilled' ? updateSettled.value : null;
    const updateError = updateSettled.status === 'rejected' ? updateSettled.reason : null;

    const converted = await db.cart.findUnique({
      where: { id: cart.id },
      include: { items: true },
    });

    if (update) {
      // (b) update primero: el checkout procesa el carrito con Q4.
      expect(checkout).not.toBeNull();
      expect(converted!.status).toBe('convertido');
      expect(converted!.items.map((i) => ({ productId: i.productId, quantity: i.quantity })))
        .toEqual([{ productId: qProductId, quantity: 4 }]);
      expect(checkout!.order.items.map((i) => ({ productId: i.productId, quantity: i.quantity })))
        .toEqual([{ productId: qProductId, quantity: 4 }]);
    } else {
      // (a) checkout primero: PUT recibe 409 (CART_NOT_ACTIVE) y el
      // convertido queda EXACTAMENTE intacto.
      expect(updateError).toBeInstanceOf(CartMutationError);
      expect(updateError.status).toBe(409);
      expect(checkout).not.toBeNull();
      expect(converted!.status).toBe('convertido');
      expect(converted!.items).toHaveLength(1);
      expect(converted!.items[0].productId).toBe(productId);
      expect(converted!.items[0].quantity).toBe(2);
      expect(converted!.items[0].unitPrice).toBe(8000);
      expect(converted!.subtotal).toBe(16000);
    }
  } finally {
    await db.cart.update({ where: { id: cart.id }, data: { status: 'expirado' } }).catch(() => undefined);
  }
}, 30000);

d('T7: checkout concurrente con clear — o clear primero (CART_EMPTY), o 409 con convertido intacto', async () => {
  const cart = await activeCartFor({ userId: customerId }, 2);

  try {
    const checkoutPromise = createOrderFromCart({
      cartId: cart.id,
      customerName: `Cliente checkout ${RUN}`,
      sessionUser: { id: customerId, role: 'CUSTOMER' },
      sessionId: null,
    });
    const clearPromise = (async () => {
      await new Promise((r) => setTimeout(r, 100));
      return clearActiveCarts({
        sessionId: null,
        userId: customerId,
        isAdminOrAgent: false,
      });
    })();

    const [checkoutSettled, clearSettled] = await Promise.allSettled([
      checkoutPromise,
      clearPromise,
    ]);

    const checkoutError = checkoutSettled.status === 'rejected' ? checkoutSettled.reason : null;
    const clearError = clearSettled.status === 'rejected' ? clearSettled.reason : null;
    const cleared = clearSettled.status === 'fulfilled' ? clearSettled.value : null;

    const after = await db.cart.findUnique({
      where: { id: cart.id },
      include: { items: true },
    });

    if (clearError) {
      // (b) checkout primero (clear vio el carrito aún activo antes del
      // lock): clear recibe CartMutationError 409 y el convertido conserva
      // su línea original EXACTA.
      expect(clearError).toBeInstanceOf(CartMutationError);
      expect(clearError.status).toBe(409);
      expect(checkoutSettled.status).toBe('fulfilled');
      expect(after!.status).toBe('convertido');
      expect(after!.items).toHaveLength(1);
      expect(after!.items[0].productId).toBe(productId);
      expect(after!.items[0].quantity).toBe(2);
      expect(after!.items[0].unitPrice).toBe(8000);
      expect(after!.subtotal).toBe(16000);
    } else if (cleared!.skipped) {
      // (c) checkout completo ANTES del findFirst del clear: no quedó
      // carrito activo que vaciar (no-op legítimo) y el convertido está
      // EXACTAMENTE intacto.
      expect(checkoutSettled.status).toBe('fulfilled');
      expect(after!.status).toBe('convertido');
      expect(after!.items).toHaveLength(1);
      expect(after!.items[0].productId).toBe(productId);
      expect(after!.items[0].quantity).toBe(2);
      expect(after!.items[0].unitPrice).toBe(8000);
      expect(after!.subtotal).toBe(16000);
    } else {
      // (a) clear primero: el checkout encuentra el carrito vacío y falla
      // con CART_EMPTY (400); el carrito sigue activo, sin líneas, subtotal 0.
      expect(cleared).toEqual({ skipped: false });
      expect(checkoutError).toBeInstanceOf(OrderCreateError);
      expect(checkoutError.code).toBe('CART_EMPTY');
      expect(checkoutError.status).toBe(400);
      expect(after!.status).toBe('activo');
      expect(after!.items).toHaveLength(0);
      expect(after!.subtotal).toBe(0);
    }
  } finally {
    await db.cart.update({ where: { id: cart.id }, data: { status: 'expirado' } }).catch(() => undefined);
  }
}, 30000);

d('T8: transferencia de propiedad bajo el lock => save del guest recibe 403 y cero writes', async () => {
  // Carrito GUEST con línea P qty 2. El controlador confirma la
  // transferencia (userId asignado, sessionId null — lo que hace
  // transferSessionCartToUser) mientras el save espera el lock.
  const cart = await activeCartFor({ sessionId: SESS_X }, 2);

  const other = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  try {
    const controller = other.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Cart" WHERE id = ${cart.id} FOR UPDATE`;
      await waitForVictimLocked(other, 'FROM "Cart"');
      await new Promise((r) => setTimeout(r, 400));
      await tx.cart.update({
        where: { id: cart.id },
        data: { userId: transferUserId, sessionId: null },
      });
    });

    await new Promise((r) => setTimeout(r, 150)); // el save llega al lock
    const savePromise = saveCartChanges({
      viewer: { sessionId: SESS_X, userId: null, isAdminOrAgent: false },
      action: 'save',
      items: [{ productId: qProductId, quantity: 4 }],
      currentUser: null,
    }).catch((e) => e);

    await controller;
    const saveError = (await savePromise) as any;

    expect(saveError).toBeInstanceOf(CartMutationError);
    expect(saveError.status).toBe(403);

    // El victimizador NO escribió nada: las líneas siguen siendo las
    // originales del guest (los cambios de campos son de la transferencia,
    // no del save).
    const after = await db.cart.findUnique({
      where: { id: cart.id },
      include: { items: true },
    });
    expect(after!.sessionId).toBeNull(); // cambio de la transferencia
    expect(after!.userId).toBe(transferUserId); // cambio de la transferencia
    expect(after!.items).toHaveLength(1);
    expect(after!.items[0].productId).toBe(productId);
    expect(after!.items[0].quantity).toBe(2);
    expect(after!.items[0].unitPrice).toBe(8000);
    expect(after!.subtotal).toBe(16000);
  } finally {
    await other.$disconnect();
    await db.cart.update({ where: { id: cart.id }, data: { status: 'expirado' } });
  }
}, 30000);

d('T9: PUT sobre carrito convertido bajo el lock => 409 determinístico y convertido EXACTAMENTE intacto', async () => {
  const cart = await activeCartFor({ sessionId: SESS_Y }, 2);

  const other = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  try {
    const controller = other.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Cart" WHERE id = ${cart.id} FOR UPDATE`;
      await waitForVictimLocked(other, 'FROM "Cart"');
      await new Promise((r) => setTimeout(r, 400));
      // Conversión canónica de checkout.
      await tx.cart.update({
        where: { id: cart.id },
        data: { status: 'convertido', sessionId: null },
      });
    });

    await new Promise((r) => setTimeout(r, 150)); // el PUT llega al lock
    const updatePromise = updateCartByUuid({
      uuid: cart.uuid,
      viewer: { sessionId: SESS_Y, userId: null, userRole: null, staffCanManage: false },
      body: { items: [{ productId: qProductId, quantity: 4 }] },
    }).catch((e) => e);

    await controller;
    const updateError = (await updatePromise) as any;

    expect(updateError).toBeInstanceOf(CartMutationError);
    expect(updateError.status).toBe(409);
    expect(updateError.code).toBe('CART_NOT_ACTIVE');

    // El convertido queda EXACTAMENTE intacto.
    const after = await db.cart.findUnique({
      where: { id: cart.id },
      include: { items: true },
    });
    expect(after!.status).toBe('convertido');
    expect(after!.items).toHaveLength(1);
    expect(after!.items[0].productId).toBe(productId);
    expect(after!.items[0].quantity).toBe(2);
    expect(after!.items[0].unitPrice).toBe(8000);
    expect(after!.subtotal).toBe(16000);
  } finally {
    await other.$disconnect();
    await db.cart.update({ where: { id: cart.id }, data: { status: 'expirado' } });
  }
}, 30000);

d('T10: transferencia de propiedad bajo el lock => clear del guest recibe 403 y cero writes', async () => {
  // Mismo patrón que T8 pero con clearActiveCarts: el controlador confirma la
  // transferencia (userId asignado, sessionId null) mientras el clear espera
  // el lock; la sesión invitada pierde la propiedad y NO vacía el carrito
  // ajeno (CERO writes del victimizador).
  const cart = await activeCartFor({ sessionId: SESS_Z }, 2);

  const other = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  try {
    const controller = other.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Cart" WHERE id = ${cart.id} FOR UPDATE`;
      await waitForVictimLocked(other, 'FROM "Cart"');
      await new Promise((r) => setTimeout(r, 400));
      await tx.cart.update({
        where: { id: cart.id },
        data: { userId: transferUserId, sessionId: null },
      });
    });

    await new Promise((r) => setTimeout(r, 150)); // el clear llega al lock
    const clearPromise = clearActiveCarts({
      sessionId: SESS_Z,
      userId: null,
      isAdminOrAgent: false,
    }).catch((e) => e);

    await controller;
    const clearError = (await clearPromise) as any;

    expect(clearError).toBeInstanceOf(CartMutationError);
    expect(clearError.status).toBe(403);

    // El clear NO escribió nada: las líneas y el subtotal siguen siendo los
    // originales del guest.
    const after = await db.cart.findUnique({
      where: { id: cart.id },
      include: { items: true },
    });
    expect(after!.items).toHaveLength(1);
    expect(after!.items[0].productId).toBe(productId);
    expect(after!.items[0].quantity).toBe(2);
    expect(after!.items[0].unitPrice).toBe(8000);
    expect(after!.subtotal).toBe(16000);
  } finally {
    await other.$disconnect();
    await db.cart.update({ where: { id: cart.id }, data: { status: 'expirado' } });
  }
}, 30000);
