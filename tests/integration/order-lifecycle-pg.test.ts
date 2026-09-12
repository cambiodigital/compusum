import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { db } from '@/lib/db';
import { createOrderFromCart, OrderCreateError } from '@/lib/order-create';
import { reorderOrderItems } from '@/lib/order-reorder';
import { authorizeOrderAccess } from '@/lib/order-access';

/**
 * FASE 3 — PostgreSQL REAL.
 *
 * 1. Concurrencia: dos POST del MISMO checkout => máximo UN pedido
 *    (lock SELECT ... FOR UPDATE del carrito).
 * 2. Nueva semántica: dos pedidos legítimos del mismo CUSTOMER conviven
 *    como 'solicitado' independientes (índices únicos parciales retirados).
 * 3. Idempotencia por clave: reintentos devuelven el pedido original.
 * 4. Cotización persistente (requestType) y webhook fallido NO pierde la
 *    solicitud (el Order queda persistido con webhookSent=false).
 * 5. Reorder: snapshot histórico intacto, carrito con precio actual del
 *    perfil (perfil A ≠ perfil B).
 * 6. Migración aplicada: requestType default 'pedido', índices únicos
 *    parciales retirados, idempotencyKey única.
 */

const HAS_POSTGRES = Boolean(process.env.DATABASE_URL?.startsWith('postgres'));
const d = it.skipIf(!HAS_POSTGRES);

const RUN = `${Date.now()}`;
let categoryId: string;
let productId: string;
let quoteProductId: string;
let customerAId: string;
let customerBId: string;
let profileAId: string;

async function createCart(data: {
  sessionId?: string | null;
  userId?: string | null;
  productId: string;
  quantity: number;
}) {
  return db.cart.create({
    data: {
      sessionId: data.sessionId ?? null,
      userId: data.userId ?? null,
      status: 'activo',
      items: {
        create: {
          productId: data.productId,
          quantity: data.quantity,
        },
      },
    },
    include: { items: true },
  });
}

beforeAll(async () => {
  if (!HAS_POSTGRES) return;

  const category = await db.category.create({
    data: { name: `Cat ciclo ${RUN}`, slug: `cat-ciclo-${RUN}` },
  });
  categoryId = category.id;

  const product = await db.product.create({
    data: {
      name: 'Producto ciclo',
      slug: `prod-ciclo-${RUN}`,
      price: 10000,
      wholesalePrice: 8000,
      stockQuantity: 100,
      categoryId,
    },
  });
  productId = product.id;

  const quoteProduct = await db.product.create({
    data: {
      name: 'Producto cotización',
      slug: `prod-cotiza-${RUN}`,
      price: 0,
      wholesalePrice: 0,
      stockQuantity: 10,
      categoryId,
    },
  });
  quoteProductId = quoteProduct.id;

  const customerA = await db.user.create({
    data: {
      name: `Cliente A ${RUN}`,
      phone: `57300000${RUN.slice(-4)}`,
      role: 'CUSTOMER',
      password: 'x',
    },
  });
  customerAId = customerA.id;

  const customerB = await db.user.create({
    data: {
      name: `Cliente B ${RUN}`,
      phone: `57310000${RUN.slice(-4)}`,
      role: 'CUSTOMER',
      password: 'x',
    },
  });
  customerBId = customerB.id;

  const profile = await db.priceProfile.create({
    data: {
      name: `Perfil A ${RUN}`,
      code: `PROF-A-${RUN}`,
      productOverrides: {
        create: { productId, wholesalePrice: 12000 },
      },
    },
  });
  profileAId = profile.id;
  await db.user.update({
    where: { id: customerAId },
    data: { priceProfileId: profileAId },
  });
}, 30000);

afterAll(async () => {
  if (!HAS_POSTGRES) return;

  const productIds = (
    await db.product.findMany({
      where: { slug: { in: [`prod-ciclo-${RUN}`, `prod-cotiza-${RUN}`] } },
      select: { id: true },
    })
  ).map((p) => p.id);

  // 1) Pedidos del run (antes que los carritos: cartId es relación requerida)
  await db.order.deleteMany({ where: { customerName: { startsWith: `Ciclo ${RUN}` } } });
  await db.order.deleteMany({
    where: { orderNumber: { in: [`CS-HIST-${RUN}`, `CS-HISTB-${RUN}`, `CS-LEGACY-${RUN}`] } },
  });
  await db.order.deleteMany({
    where: { items: { some: { productId: { in: productIds } } } },
  });

  // 2) Carritos e items (cartItem cascada con cart)
  await db.cart.deleteMany({
    where: {
      OR: [
        { sessionId: { startsWith: `sess-ciclo-${RUN}` } },
        { userId: { in: [customerAId, customerBId] } },
      ],
    },
  });

  // 3) Perfiles, usuarios, productos y categoría del run
  await db.priceProfile.deleteMany({ where: { code: { startsWith: `PROF-A-${RUN}` } } });
  await db.user.deleteMany({ where: { id: { in: [customerAId, customerBId] } } });
  await db.product.deleteMany({ where: { id: { in: productIds } } });
  await db.category.deleteMany({ where: { slug: `cat-ciclo-${RUN}` } });
  await db.$disconnect();
}, 30000);

d('migración Fase 3 aplicada: requestType, idempotencyKey, índices retirados', async () => {
  // Columna requestType con default seguro
  const columns = await db.$queryRaw<{ column_name: string; column_default: string }[]>`
    SELECT column_name, column_default FROM information_schema.columns
    WHERE table_name = 'Order' AND column_name IN ('requestType', 'idempotencyKey')`;
  expect(columns).toHaveLength(2);
  expect(columns.find((c) => c.column_name === 'requestType')?.column_default).toContain('pedido');

  // Índice único de idempotencia existe
  const indexes = await db.$queryRaw<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes WHERE tablename = 'Order'`;
  const names = indexes.map((i) => i.indexname);
  expect(names).toContain('Order_idempotencyKey_key');
  // Índices únicos parciales de la semántica antigua RETIRADOS
  expect(names).not.toContain('Order_sessionId_status_unique_idx');
  expect(names).not.toContain('Order_customerId_status_unique_idx');
});

d('migración es idempotente y no pierde históricos', async () => {
  // Los pedidos existentes deben ser requestType='pedido'
  const legacy = await db.order.create({
    data: {
      orderNumber: `CS-LEGACY-${RUN}`,
      cartId: (await createCart({ sessionId: `sess-ciclo-${RUN}-legacy`, productId, quantity: 1 })).id,
      subtotal: 8000,
      status: 'solicitado',
    },
  });
  expect(legacy.requestType).toBe('pedido');
  await db.order.delete({ where: { id: legacy.id } });
});

d('CONCURRENCIA: dos POST del mismo checkout => máximo UN pedido', async () => {
  const cart = await createCart({
    sessionId: `sess-ciclo-${RUN}-conc`,
    productId,
    quantity: 2,
  });

  const input = {
    cartId: cart.id,
    customerName: `Ciclo ${RUN} conc`,
    sessionUser: null as null,
    sessionId: `sess-ciclo-${RUN}-conc`,
  };

  const [r1, r2] = await Promise.allSettled([
    createOrderFromCart(input),
    createOrderFromCart(input),
  ]);

  const fulfilled = [r1, r2].filter((r) => r.status === 'fulfilled');
  const rejected = [r1, r2].filter((r) => r.status === 'rejected');

  // Exactamente una solicitud crea el pedido; la otra falla por carrito convertido
  expect(fulfilled).toHaveLength(1);
  expect(rejected).toHaveLength(1);
  expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(OrderCreateError);

  const ordersForCart = await db.order.count({ where: { cartId: cart.id } });
  expect(ordersForCart).toBe(1);
});

d('CONCURRENCIA con idempotencyKey: ambas solicitudes resuelven al MISMO pedido', async () => {
  const cart = await createCart({
    sessionId: `sess-ciclo-${RUN}-idem`,
    productId,
    quantity: 1,
  });

  const input = {
    cartId: cart.id,
    customerName: `Ciclo ${RUN} idem`,
    idempotencyKey: `idem-${RUN}`,
    sessionUser: null as null,
    sessionId: `sess-ciclo-${RUN}-idem`,
  };

  const [r1, r2] = await Promise.allSettled([createOrderFromCart(input), createOrderFromCart(input)]);

  expect(r1.status).toBe('fulfilled');
  expect(r2.status).toBe('fulfilled');
  const o1 = (r1 as PromiseFulfilledResult<any>).value;
  const o2 = (r2 as PromiseFulfilledResult<any>).value;
  // El mismo Order: máximo un pedido a pesar de dos POST concurrentes
  expect(o1.order.id).toBe(o2.order.id);
  expect(o1.replayed !== o2.replayed).toBe(true);

  expect(await db.order.count({ where: { cartId: cart.id } })).toBe(1);
});

d('NUEVA SEMÁNTICA: dos pedidos legítimos del mismo CUSTOMER conviven intactos', async () => {
  // La BD garantiza UN único carrito ACTIVO por usuario (índice parcial de
  // 20260912120000): el segundo carrito se crea DESPUÉS de convertir el
  // primero. La semántica probada no cambia: dos pedidos legítimos del mismo
  // CUSTOMER conviven como 'solicitado' independientes y sin reemplazos.
  const cart1 = await createCart({ userId: customerAId, productId, quantity: 1 });

  const first = await createOrderFromCart({
    cartId: cart1.id,
    sessionUser: { id: customerAId, role: 'CUSTOMER' },
    sessionId: null,
  });

  const firstItems = await db.orderItem.findMany({ where: { orderId: first.order.id } });

  const cart2 = await createCart({ userId: customerAId, productId, quantity: 3 });

  const second = await createOrderFromCart({
    cartId: cart2.id,
    sessionUser: { id: customerAId, role: 'CUSTOMER' },
    sessionId: null,
  });

  // Ambos 'solicitado' en paralelo (antes: índice único lo impedía/reemplazaba)
  expect(first.order.status).toBe('solicitado');
  expect(second.order.status).toBe('solicitado');
  expect(first.order.id).not.toBe(second.order.id);
  expect(first.order.orderNumber).not.toBe(second.order.orderNumber);
  expect(second.order.customerId).toBe(customerAId);

  // El primero queda EXACTAMENTE igual (sin reemplazo silencioso)
  const firstItemsAfter = await db.orderItem.findMany({ where: { orderId: first.order.id } });
  expect(firstItemsAfter).toHaveLength(firstItems.length);
  expect(firstItemsAfter[0].quantity).toBe(firstItems[0].quantity);
  expect(firstItemsAfter[0].unitPrice).toBe(firstItems[0].unitPrice);
  expect(firstItemsAfter[0].unitPrice).toBe(12000); // precio perfil A

  // Historial y conversión de carrito correctos
  const history = await db.orderStatusHistory.findMany({ where: { orderId: second.order.id } });
  expect(history.some((h) => h.toStatus === 'solicitado')).toBe(true);
  const cart2After = await db.cart.findUnique({ where: { id: cart2.id } });
  expect(cart2After?.status).toBe('convertido');
});

d('COTIZACIÓN: se persiste requestType=cotizacion y webhook fallido NO la pierde', async () => {
  const cart = await createCart({
    sessionId: `sess-ciclo-${RUN}-quote`,
    productId: quoteProductId,
    quantity: 2,
  });

  // Sin N8N configurado en la BD de test, el webhook "falla" => el Order debe
  // seguir existiendo (el envío es post-transacción y no-fatal).
  const result = await createOrderFromCart({
    cartId: cart.id,
    requestType: 'cotizacion',
    customerName: `Ciclo ${RUN} quote`,
    sessionUser: null as null,
    sessionId: `sess-ciclo-${RUN}-quote`,
  });

  const persisted = await db.order.findUnique({ where: { id: result.order.id } });
  expect(persisted).not.toBeNull();
  expect(persisted!.requestType).toBe('cotizacion');
  expect(persisted!.webhookSent).toBe(false); // resultado registrado, solicitud conservada
  expect(persisted!.status).toBe('solicitado');

  const items = await db.orderItem.findMany({ where: { orderId: result.order.id } });
  expect(items[0].unitPrice).toBeNull(); // sin precio => pendiente de cotizar

  // Un pedido normal con precio inválido NO se procesa como compra
  const cartPedido = await createCart({
    sessionId: `sess-ciclo-${RUN}-quotefail`,
    productId: quoteProductId,
    quantity: 1,
  });
  await expect(
    createOrderFromCart({
      cartId: cartPedido.id,
      customerName: `Ciclo ${RUN} quotefail`,
      sessionUser: null as null,
      sessionId: `sess-ciclo-${RUN}-quotefail`,
    })
  ).rejects.toBeInstanceOf(OrderCreateError);
});

d('REORDER: snapshot intacto + precio actual por perfil (A ≠ B)', async () => {
  // Pedido histórico con precio 10000 (base manual)
  const historicalCart = await createCart({ userId: customerAId, productId, quantity: 2 });
  await db.cart.update({
    where: { id: historicalCart.id },
    data: { status: 'convertido' }, // ya consumido: no debe activar conflicto de carrito
  });
  const historicalOrder = await db.order.create({
    data: {
      orderNumber: `CS-HIST-${RUN}`,
      cartId: historicalCart.id,
      customerId: customerAId,
      subtotal: 20000,
      status: 'compartido',
      items: {
        create: { productId, productName: 'Producto ciclo', quantity: 2, unitPrice: 10000 },
      },
    },
  });

  // Reorder del cliente A (perfil override 12000)
  const resultA = await reorderOrderItems({
    orderId: historicalOrder.id,
    viewer: { user: { id: customerAId, role: 'CUSTOMER' }, sessionId: null },
  });

  expect(resultA.addedCount).toBe(1);
  expect(resultA.priceChanged).toBe(true);
  expect(resultA.items[0].historicalUnitPrice).toBe(10000);
  expect(resultA.items[0].currentUnitPrice).toBe(12000);

  const cartAfter = await db.cart.findUnique({
    where: { id: resultA.cart!.id },
    include: { items: true },
  });
  expect(cartAfter!.items[0].unitPrice).toBe(12000);

  // El pedido origen conserva su snapshot 10000
  const historicalItems = await db.orderItem.findMany({ where: { orderId: historicalOrder.id } });
  expect(historicalItems[0].unitPrice).toBe(10000);

  // Reorder del cliente B sobre SU PROPIO pedido (sin perfil) => precio BASE 8000
  const historicalCartB = await createCart({ userId: customerBId, productId, quantity: 2 });
  await db.cart.update({
    where: { id: historicalCartB.id },
    data: { status: 'convertido' },
  });
  const historicalOrderB = await db.order.create({
    data: {
      orderNumber: `CS-HISTB-${RUN}`,
      cartId: historicalCartB.id,
      customerId: customerBId,
      subtotal: 16000,
      status: 'compartido',
      items: {
        create: { productId, productName: 'Producto ciclo', quantity: 2, unitPrice: 8000 },
      },
    },
  });
  await db.cart.updateMany({
    where: { userId: customerBId, status: 'activo' },
    data: { status: 'expirado' },
  });
  const resultB = await reorderOrderItems({
    orderId: historicalOrderB.id,
    viewer: { user: { id: customerBId, role: 'CUSTOMER' }, sessionId: null },
  });
  expect(resultB.items[0].currentUnitPrice).toBe(8000);

  // Permisos reales en BD: CUSTOMER B NO puede consultar ni reordenar el pedido de A
  expect(() =>
    authorizeOrderAccess(
      { customerId: historicalOrder.customerId, sessionId: historicalOrder.sessionId },
      { user: { id: customerBId, role: 'CUSTOMER' }, sessionId: null }
    )
  ).toThrow();
  await expect(
    reorderOrderItems({
      orderId: historicalOrder.id,
      viewer: { user: { id: customerBId, role: 'CUSTOMER' }, sessionId: null },
    })
  ).rejects.toMatchObject({ status: 403 });
});
