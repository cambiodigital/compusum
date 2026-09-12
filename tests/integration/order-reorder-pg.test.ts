import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { db } from '@/lib/db';
import { reorderOrderItems, ReorderError } from '@/lib/order-reorder';

/**
 * FASE 3 — REORDER contra PostgreSQL REAL.
 *
 * 1. Stock combinado 8+5>10 con allowPartial=false => ReorderError 409 y el
 *    carrito queda EXACTAMENTE igual (misma línea, mismo unitPrice, mismo
 *    subtotal): la validación del estado FINAL ocurre ANTES de destruir nada.
 * 2. El mismo escenario con allowPartial=true CONSERVA las 8 unidades
 *    originales del cliente (nunca se encogen).
 * 3. Replace con error tras el lock: el carrito anterior se conserva.
 * 4. Lost update: el reorder combina contra las líneas FRESCAS (tras el
 *    lock), no contra la lectura vieja.
 * 5. Carrito convertido durante la espera del lock: el convertido queda
 *    EXACTAMENTE intacto y el reorder aterriza en el carrito activo actual
 *    (1 reintento acotado).
 *
 * Aislamiento: el visor es CUSTOMER, así que `upsertActiveCart` resuelve el
 * carrito por userId; cada test expira su carrito al terminar para que el
 * siguiente empiece limpio.
 */

const HAS_POSTGRES = Boolean(process.env.DATABASE_URL?.startsWith('postgres'));
const d = it.skipIf(!HAS_POSTGRES);

const RUN = `${Date.now()}`;
let categoryId: string;
let productId: string; // stock 10: 8 (carrito) + 5 (pedido) NO caben juntas
let qProductId: string; // producto auxiliar para el lost update
let customerId: string;

async function activeCartWithLine(quantity: number) {
  return db.cart.create({
    data: {
      userId: customerId, // el visor CUSTOMER resuelve su carrito por userId
      sessionId: null,
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

async function expireCart(cartId: string) {
  await db.cart.update({ where: { id: cartId }, data: { status: 'expirado' } });
}

async function seedHistoricalOrder(suffix: string, quantity: number) {
  const cart = await db.cart.create({
    data: { sessionId: `sess-hist-${RUN}-${suffix}`, status: 'convertido' },
  });
  return db.order.create({
    data: {
      orderNumber: `CS-REORDER-${RUN}-${suffix}`,
      cartId: cart.id,
      customerId,
      subtotal: 10000 * quantity,
      status: 'compartido',
      items: {
        create: {
          productId,
          productName: 'Producto reorder',
          quantity,
          unitPrice: 10000, // snapshot histórico distinto del precio actual
        },
      },
    },
    include: { items: true },
  });
}

const viewer = () => ({ user: { id: customerId, role: 'CUSTOMER' }, sessionId: null });

beforeAll(async () => {
  if (!HAS_POSTGRES) return;

  const category = await db.category.create({
    data: { name: `Cat reorder ${RUN}`, slug: `cat-reorder-${RUN}` },
  });
  categoryId = category.id;

  const product = await db.product.create({
    data: {
      name: 'Producto reorder',
      slug: `prod-reorder-${RUN}`,
      price: 10000,
      wholesalePrice: 8000,
      stockQuantity: 10,
      categoryId,
    },
  });
  productId = product.id;

  const qProduct = await db.product.create({
    data: {
      name: 'Producto Q',
      slug: `prod-reorder-q-${RUN}`,
      price: 5000,
      wholesalePrice: 5000,
      stockQuantity: 50,
      categoryId,
    },
  });
  qProductId = qProduct.id;

  const customer = await db.user.create({
    data: {
      name: `Cliente reorder ${RUN}`,
      phone: `57330000${RUN.slice(-4)}`,
      role: 'CUSTOMER',
      password: 'x',
    },
  });
  customerId = customer.id;
}, 30000);

afterAll(async () => {
  if (!HAS_POSTGRES) return;

  await db.order.deleteMany({ where: { orderNumber: { startsWith: `CS-REORDER-${RUN}` } } });
  await db.cart.deleteMany({
    where: {
      OR: [{ userId: customerId }, { sessionId: { startsWith: `sess-hist-${RUN}` } }],
    },
  });
  await db.user.deleteMany({ where: { id: customerId } });
  await db.product.deleteMany({ where: { id: { in: [productId, qProductId].filter(Boolean) } } });
  await db.category.deleteMany({ where: { slug: `cat-reorder-${RUN}` } });
  await db.$disconnect();
}, 30000);

d('8+5>10 con allowPartial=false => 409 y carrito EXACTAMENTE intacto', async () => {
  const cart = await activeCartWithLine(8);
  const order = await seedHistoricalOrder('nopartial', 5);

  try {
    await expect(
      reorderOrderItems({ orderId: order.id, viewer: viewer(), mode: 'add', allowPartial: false })
    ).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining('Tu carrito no fue modificado'),
    });

    // La línea original sobrevive: mismo producto, cantidad 8, MISMO unitPrice
    const lines = await db.cartItem.findMany({ where: { cartId: cart.id } });
    expect(lines).toHaveLength(1);
    expect(lines[0].productId).toBe(productId);
    expect(lines[0].quantity).toBe(8);
    expect(lines[0].unitPrice).toBe(8000);

    const after = await db.cart.findUnique({ where: { id: cart.id } });
    expect(after!.subtotal).toBe(64000);
  } finally {
    await expireCart(cart.id);
  }
});

d('8+5>10 con allowPartial=true => las 8 unidades ORIGINALES se conservan', async () => {
  const cart = await activeCartWithLine(8);
  const order = await seedHistoricalOrder('partial', 5);

  try {
    const result = await reorderOrderItems({
      orderId: order.id,
      viewer: viewer(),
      mode: 'add',
      allowPartial: true,
    });

    // La adición del reorder se reporta bloqueada
    expect(result.items[0].status).toBe('exceeds_stock');
    expect(result.items[0].currentUnitPrice).toBeNull();
    expect(result.addedCount).toBe(0);

    // El carrito conserva la línea ORIGINAL (nunca encogida)
    const lines = await db.cartItem.findMany({ where: { cartId: cart.id } });
    expect(lines).toHaveLength(1);
    expect(lines[0].quantity).toBe(8);
    expect(lines[0].unitPrice).toBe(8000);
    expect(result.cart!.subtotal).toBe(64000);
  } finally {
    await expireCart(cart.id);
  }
});

d('replace con error tras el lock: el carrito anterior se conserva', async () => {
  const cart = await activeCartWithLine(8);
  const order = await seedHistoricalOrder('race', 5);

  const other = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  try {
    // El controlador toma el lock del carrito y, mientras lo sostiene,
    // DESACTIVA el producto: el estado final (post-lock) ya no es válido.
    const controller = other.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Cart" WHERE id = ${cart.id} FOR UPDATE`;
      await new Promise((r) => setTimeout(r, 400));
      await tx.product.update({ where: { id: productId }, data: { isActive: false } });
    });

    // La reorder lee AFUERA (producto aún activo) y se bloquea en el lock
    await new Promise((r) => setTimeout(r, 150));
    const reorderPromise = reorderOrderItems({
      orderId: order.id,
      viewer: viewer(),
      mode: 'replace',
      allowPartial: false,
    }).catch((e) => e);

    await controller;
    const reorderError = (await reorderPromise) as ReorderError;

    expect(reorderError).toBeInstanceOf(ReorderError);
    expect(reorderError.status).toBe(409);

    // NADA se destruyó antes de validar el estado final: línea de 8 intacta
    const lines = await db.cartItem.findMany({ where: { cartId: cart.id } });
    expect(lines).toHaveLength(1);
    expect(lines[0].quantity).toBe(8);
  } finally {
    await other.$disconnect();
    // Restaurar el producto y liberar el carrito para otros tests
    await db.product.update({ where: { id: productId }, data: { isActive: true } });
    await expireCart(cart.id);
  }
}, 30000);

d('lost update: el reorder combina contra las líneas FRESCAS (post-lock)', async () => {  const cart = await activeCartWithLine(2);
  const order = await seedHistoricalOrder('lost', 3);

  const other = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  try {
    // El controlador agrega una línea de Q mientras sostiene el lock: la
    // lectura externa del reorder (previa al lock) NO la ve.
    const controller = other.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Cart" WHERE id = ${cart.id} FOR UPDATE`;
      await new Promise((r) => setTimeout(r, 400));
      await tx.cartItem.create({
        data: { cartId: cart.id, productId: qProductId, quantity: 2, unitPrice: 5000 },
      });
    });

    await new Promise((r) => setTimeout(r, 150));
    const resultPromise = reorderOrderItems({
      orderId: order.id,
      viewer: viewer(),
      mode: 'add',
      allowPartial: true,
    });

    await controller;
    const result = await resultPromise;

    // 2 (P, preexistente) + 3 (P del reorder) + 2 (Q insertada concurrente)
    expect(result.addedCount).toBe(1);
    const lines = await db.cartItem.findMany({ where: { cartId: cart.id } });
    const byProduct = new Map(lines.map((l) => [l.productId, l]));
    expect(lines).toHaveLength(2);
    expect(byProduct.get(productId)!.quantity).toBe(5);
    expect(byProduct.get(qProductId)!.quantity).toBe(2);
    expect(result.cart!.subtotal).toBe(5 * 8000 + 2 * 5000);
  } finally {
    await other.$disconnect();
    await expireCart(cart.id);
  }
}, 30000);

d('checkout convierte el carrito durante la espera del lock => convertido EXACTAMENTE intacto y reorder en carrito NUEVO', async () => {
  // El checkout (controlador) convierte el carrito mientras el reorder
  // espera el lock: NO se escribe nada sobre el convertido (su línea de 2 ×
  // 8000 y subtotal 16000 quedan intactos); el reorder re-resuelve el
  // carrito activo actual (nuevo, vacío) y carga allí las 3 unidades.
  const cart = await activeCartWithLine(2);
  const order = await seedHistoricalOrder('converted', 3);
  let landedCartId: string | null = null;

  const other = new PrismaClient({ datasources: { db: { url: process.env.DATABASE_URL } } });
  try {
    const controller = other.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Cart" WHERE id = ${cart.id} FOR UPDATE`;
      await new Promise((r) => setTimeout(r, 400));
      // Exactamente lo que el checkout canónico escribe al convertir.
      await tx.cart.update({
        where: { id: cart.id },
        data: { status: 'convertido', sessionId: null },
      });
    });

    await new Promise((r) => setTimeout(r, 150)); // el reorder llega al lock
    const result = await reorderOrderItems({
      orderId: order.id,
      viewer: viewer(),
      mode: 'add',
      allowPartial: true,
    });
    landedCartId = result.cart!.id;

    // El reorder aterrizó en un carrito NUEVO del visor (no en el convertido)
    expect(result.cart).toBeDefined();
    expect(result.cart!.id).not.toBe(cart.id);

    // Carrito NUEVO: solo las 3 unidades del pedido al precio ACTUAL (8000).
    const newLines = await db.cartItem.findMany({ where: { cartId: result.cart!.id } });
    expect(newLines).toHaveLength(1);
    expect(newLines[0].productId).toBe(productId);
    expect(newLines[0].quantity).toBe(3);
    expect(newLines[0].unitPrice).toBe(8000);
    expect(result.cart!.subtotal).toBe(3 * 8000);

    // El carrito CONVERTIDO queda EXACTAMENTE intacto.
    const converted = await db.cart.findUnique({ where: { id: cart.id }, include: { items: true } });
    expect(converted!.status).toBe('convertido');
    expect(converted!.items).toHaveLength(1);
    expect(converted!.items[0].productId).toBe(productId);
    expect(converted!.items[0].quantity).toBe(2);
    expect(converted!.items[0].unitPrice).toBe(8000);
    expect(converted!.subtotal).toBe(16000);
  } finally {
    await other.$disconnect();
    const cartIdsToExpire = [cart.id, landedCartId].filter((id): id is string => Boolean(id));
    await db.cart.updateMany({
      where: { id: { in: cartIdsToExpire } },
      data: { status: 'expirado' },
    });
  }
}, 30000);
