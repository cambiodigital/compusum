import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { db } from '@/lib/db';
import { updateCartByUuid, saveCartChanges } from '@/lib/cart-mutations';
import { createOrderFromCart, OrderCreateError } from '@/lib/order-create';
import { editCustomerOrder, OrderEditError } from '@/lib/order-edit';
import { buildWebhookPayload } from '@/lib/webhook';
import { planCityUpsert } from '@/lib/city-route';
import { CartValidationError } from '@/lib/cart-validation';

/**
 * FASE 5A — INTEGRIDAD LOGÍSTICA contra PostgreSQL REAL, vía los SERVICIOS
 * de producción (cart-mutations / order-create / order-edit / webhook /
 * planCityUpsert). Cobertura obligatoria de la fase:
 *
 *   Cart  : PUT parcial conserva city · {} conserva · null limpia · cambio
 *           válido · inexistente 400 cero-writes · inactiva 400 cero-writes ·
 *           rollback de items/subtotal · POST/save actualiza carrito EXISTENTE.
 *   Order : create usa ciudad/ruta server-side · ciudad inválida/inactiva 400
 *           sin Order parcial · edit A→B recalcula ruta · A→null limpia ambos ·
 *           omitido conserva · rollback completo.
 *   Webhook: snapshot ruta A persiste aunque la ciudad pase a B · fallback
 *           legacy con routeId=null.
 *   Admin : slug conflict cross-departamento NO modifica la ciudad existente.
 */

const HAS_POSTGRES = Boolean(process.env.DATABASE_URL?.startsWith('postgres'));
const d = it.skipIf(!HAS_POSTGRES);

const RUN = `${Date.now()}`;
let categoryId: string;
let productId: string;
let customerId: string;

let deptA: string;
let deptB: string;
let cityA: string;
let cityB: string;
let cityInactiveId: string;
let cityNoRouteId: string;
let routeAId: string;
let routeBId: string;
let routeCId: string;

// Trazabilidad exacta para limpieza (los pedidos convertidos pierden el
// sessionId del carrito, así que NO se puede limpiar por sesión).
const createdOrderIds: string[] = [];
const checkoutPhones: string[] = [];

const CART_ITEMS = () => [
  { productId, variantId: null as string | null, quantity: 2 },
];

function guestViewer(sessionId: string) {
  return { sessionId, userId: null, userRole: null, staffCanManage: false };
}

function saveViewer(sessionId: string) {
  return { sessionId, userId: null, isAdminOrAgent: false };
}

async function seedHistoricalOrder(opts: {
  suffix: string;
  cityId: string | null;
  routeId: string | null;
}): Promise<string> {
  const cart = await db.cart.create({
    data: { sessionId: `sess-5a-${RUN}-${opts.suffix}`, status: 'convertido' },
  });
  const order = await db.order.create({
    data: {
      orderNumber: `CS-5A-${RUN}-${opts.suffix}`,
      cartId: cart.id,
      customerId,
      cityId: opts.cityId,
      routeId: opts.routeId,
      subtotal: 16000,
      status: 'solicitado',
      items: {
        create: {
          productId,
          productName: 'Producto 5A',
          quantity: 2,
          unitPrice: 8000,
        },
      },
    },
  });
  createdOrderIds.push(order.id);
  return order.id;
}

beforeAll(async () => {
  if (!HAS_POSTGRES) return;

  const category = await db.category.create({
    data: { name: `Cat 5A ${RUN}`, slug: `cat-5a-${RUN}` },
  });
  categoryId = category.id;

  const product = await db.product.create({
    data: {
      name: 'Producto 5A',
      slug: `prod-5a-${RUN}`,
      price: 10000,
      wholesalePrice: 8000,
      stockQuantity: 100,
      categoryId,
    },
  });
  productId = product.id;

  const customer = await db.user.create({
    data: {
      name: `Cliente 5A ${RUN}`,
      phone: `57320001${RUN.slice(-4)}`,
      role: 'CUSTOMER',
      password: 'x',
    },
  });
  customerId = customer.id;

  const deptARow = await db.department.create({
    data: { name: `Dept A ${RUN}`, code: `5AA${RUN.slice(-5)}` },
  });
  deptA = deptARow.id;
  const deptBRow = await db.department.create({
    data: { name: `Dept B ${RUN}`, code: `5AB${RUN.slice(-5)}` },
  });
  deptB = deptBRow.id;

  const routeA = await db.shippingRoute.create({
    data: { name: `Ruta A ${RUN}`, estimatedDaysMin: 1, estimatedDaysMax: 2, departureDaysOfWeek: [1], isActive: true },
  });
  routeAId = routeA.id;
  const routeB = await db.shippingRoute.create({
    data: { name: `Ruta B ${RUN}`, estimatedDaysMin: 2, estimatedDaysMax: 3, departureDaysOfWeek: [2], isActive: true },
  });
  routeBId = routeB.id;
  const routeC = await db.shippingRoute.create({
    data: { name: `Ruta C ${RUN}`, estimatedDaysMin: 1, estimatedDaysMax: 1, departureDaysOfWeek: [3], isActive: true },
  });
  routeCId = routeC.id;

  cityA = (
    await db.city.create({
      data: { name: `CiudadA ${RUN}`, slug: `ciudada-${RUN}`, departmentId: deptA, shippingRouteId: routeAId, isActive: true },
    })
  ).id;
  cityB = (
    await db.city.create({
      data: { name: `CiudadB ${RUN}`, slug: `ciudadb-${RUN}`, departmentId: deptB, shippingRouteId: routeBId, isActive: true },
    })
  ).id;
  cityInactiveId = (
    await db.city.create({
      data: { name: `CiudadInactiva ${RUN}`, slug: `ciudadinactiva-${RUN}`, departmentId: deptA, shippingRouteId: routeCId, isActive: false },
    })
  ).id;
  cityNoRouteId = (
    await db.city.create({
      data: { name: `CiudadSinRuta ${RUN}`, slug: `ciudadsinruta-${RUN}`, departmentId: deptA, isActive: true },
    })
  ).id;
}, 30000);

afterAll(async () => {
  if (!HAS_POSTGRES) return;
  await db.order.deleteMany({
    where: { OR: [{ id: { in: createdOrderIds } }, { customerId }] },
  });
  await db.user.deleteMany({
    where: { OR: [{ id: customerId }, { phone: { in: checkoutPhones } }] },
  });
  await db.cart.deleteMany({ where: { sessionId: { contains: RUN } } });
  await db.city.deleteMany({ where: { departmentId: { in: [deptA, deptB].filter(Boolean) } } });
  await db.shippingRoute.deleteMany({
    where: { id: { in: [routeAId, routeBId, routeCId].filter(Boolean) } },
  });
  await db.department.deleteMany({ where: { id: { in: [deptA, deptB].filter(Boolean) } } });
  await db.product.deleteMany({ where: { id: productId } });
  await db.category.deleteMany({ where: { id: categoryId } });
  await db.$disconnect();
}, 30000);

// =====================
// CART — PUT /api/carts/[uuid] (updateCartByUuid)
// =====================
describe('FASE 5A Cart — PUT parcial (updateCartByUuid)', () => {
  d('PUT {notes} SIN cityId CONSERVA la ciudad A (bug `cityId || null` corregido)', async () => {
    const cart = await db.cart.create({
      data: { sessionId: `put1-${RUN}`, status: 'activo', cityId: cityA },
    });
    await updateCartByUuid({
      uuid: cart.uuid,
      viewer: guestViewer(`put1-${RUN}`),
      body: { notes: 'solo notas' },
    });
    const after = await db.cart.findUnique({ where: { id: cart.id } });
    expect(after?.cityId).toBe(cityA);
    expect(after?.notes).toBe('solo notas');
  });

  d('PUT {} vacío CONSERVA la ciudad A', async () => {
    const cart = await db.cart.create({
      data: { sessionId: `put2-${RUN}`, status: 'activo', cityId: cityA },
    });
    await updateCartByUuid({
      uuid: cart.uuid,
      viewer: guestViewer(`put2-${RUN}`),
      body: {},
    });
    const after = await db.cart.findUnique({ where: { id: cart.id } });
    expect(after?.cityId).toBe(cityA);
  });

  d('PUT {cityId:null} limpia la ciudad', async () => {
    const cart = await db.cart.create({
      data: { sessionId: `put3-${RUN}`, status: 'activo', cityId: cityA },
    });
    await updateCartByUuid({
      uuid: cart.uuid,
      viewer: guestViewer(`put3-${RUN}`),
      body: { cityId: null },
    });
    const after = await db.cart.findUnique({ where: { id: cart.id } });
    expect(after?.cityId).toBeNull();
  });

  d('PUT {cityId:B} con ciudad válida cambia a B', async () => {
    const cart = await db.cart.create({
      data: { sessionId: `put4-${RUN}`, status: 'activo', cityId: cityA },
    });
    await updateCartByUuid({
      uuid: cart.uuid,
      viewer: guestViewer(`put4-${RUN}`),
      body: { cityId: cityB },
    });
    const after = await db.cart.findUnique({ where: { id: cart.id } });
    expect(after?.cityId).toBe(cityB);
  });

  d('PUT con ciudad INEXISTENTE => 400 (CartValidationError) y CERO writes', async () => {
    const cart = await db.cart.create({
      data: {
        sessionId: `put5-${RUN}`,
        status: 'activo',
        cityId: cityA,
        notes: 'previo',
        subtotal: 16000,
        items: { create: { productId, quantity: 2, unitPrice: 8000 } },
      },
    });
    let error: unknown = null;
    try {
      await updateCartByUuid({
        uuid: cart.uuid,
        viewer: guestViewer(`put5-${RUN}`),
        body: { cityId: `NO_EXISTE_${RUN}`, notes: 'intentó cambiar' },
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CartValidationError);
    const after = await db.cart.findUnique({ where: { id: cart.id }, include: { items: true } });
    expect(after?.cityId).toBe(cityA);
    expect(after?.notes).toBe('previo');
    expect(after?.subtotal).toBe(16000);
    expect(after?.items).toHaveLength(1);
  });

  d('PUT con ciudad INACTIVA => 400 y CERO writes', async () => {
    const cart = await db.cart.create({
      data: { sessionId: `put6-${RUN}`, status: 'activo', cityId: cityA, notes: 'previo' },
    });
    let error: unknown = null;
    try {
      await updateCartByUuid({
        uuid: cart.uuid,
        viewer: guestViewer(`put6-${RUN}`),
        body: { cityId: cityInactiveId },
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CartValidationError);
    const after = await db.cart.findUnique({ where: { id: cart.id } });
    expect(after?.cityId).toBe(cityA);
    expect(after?.notes).toBe('previo');
  });

  d('PUT con tipo inválido (number) => 400, no P2003/500', async () => {
    const cart = await db.cart.create({
      data: { sessionId: `put7-${RUN}`, status: 'activo', cityId: cityA },
    });
    await expect(
      updateCartByUuid({
        uuid: cart.uuid,
        viewer: guestViewer(`put7-${RUN}`),
        body: { cityId: 12345 },
      })
    ).rejects.toBeInstanceOf(CartValidationError);
    const after = await db.cart.findUnique({ where: { id: cart.id } });
    expect(after?.cityId).toBe(cityA);
  });
});

// =====================
// CART — POST /api/carts (saveCartChanges) sobre carrito EXISTENTE
// =====================
describe('FASE 5A Cart — POST/save sobre carrito existente (saveCartChanges)', () => {
  d('save con cityId:B ACTUALIZA la ciudad de un carrito existente', async () => {
    const cart = await db.cart.create({
      data: {
        sessionId: `save1-${RUN}`,
        status: 'activo',
        cityId: cityA,
        items: { create: { productId, quantity: 1, unitPrice: 8000 } },
      },
    });
    await saveCartChanges({
      viewer: saveViewer(`save1-${RUN}`),
      action: 'save',
      items: CART_ITEMS(),
      cityId: cityB,
      currentUser: null,
    });
    const after = await db.cart.findUnique({ where: { id: cart.id } });
    expect(after?.cityId).toBe(cityB);
  });

  d('save SIN cityId (undefined) CONSERVA la ciudad existente', async () => {
    const cart = await db.cart.create({
      data: {
        sessionId: `save2-${RUN}`,
        status: 'activo',
        cityId: cityA,
        items: { create: { productId, quantity: 1, unitPrice: 8000 } },
      },
    });
    await saveCartChanges({
      viewer: saveViewer(`save2-${RUN}`),
      action: 'save',
      items: CART_ITEMS(),
      currentUser: null,
    });
    const after = await db.cart.findUnique({ where: { id: cart.id } });
    expect(after?.cityId).toBe(cityA);
  });

  d('save con cityId:null LIMPIA la ciudad existente', async () => {
    await db.cart.create({
      data: {
        sessionId: `save3-${RUN}`,
        status: 'activo',
        cityId: cityA,
        items: { create: { productId, quantity: 1, unitPrice: 8000 } },
      },
    });
    await saveCartChanges({
      viewer: saveViewer(`save3-${RUN}`),
      action: 'save',
      items: CART_ITEMS(),
      cityId: null,
      currentUser: null,
    });
    const after = await db.cart.findFirst({ where: { sessionId: `save3-${RUN}` } });
    expect(after?.cityId).toBeNull();
  });

  d('save con ciudad inválida => 400 y CERO writes (items/ciudad intactos)', async () => {
    await db.cart.create({
      data: {
        sessionId: `save4-${RUN}`,
        status: 'activo',
        cityId: cityA,
        items: { create: { productId, quantity: 3, unitPrice: 8000 } },
      },
    });
    let error: unknown = null;
    try {
      await saveCartChanges({
        viewer: saveViewer(`save4-${RUN}`),
        action: 'save',
        items: CART_ITEMS(),
        cityId: `NO_EXISTE_${RUN}`,
        currentUser: null,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CartValidationError);
    const after = await db.cart.findFirst({ where: { sessionId: `save4-${RUN}` }, include: { items: true } });
    expect(after?.cityId).toBe(cityA);
    expect(after?.items).toHaveLength(1);
    expect(after?.items[0].quantity).toBe(3);
  });

  d('save sobre carrito NUEVO crea con la ciudad validada', async () => {
    const result = await saveCartChanges({
      viewer: saveViewer(`save5-${RUN}`),
      action: 'save',
      items: CART_ITEMS(),
      cityId: cityA,
      currentUser: null,
    });
    const after = await db.cart.findUnique({ where: { id: result.id } });
    expect(after?.cityId).toBe(cityA);
  });
});

// =====================
// ORDER — createOrderFromCart (server-side cityId/routeId)
// =====================
describe('FASE 5A Order — createOrderFromCart', () => {
  d('create usa ciudad y ruta SERVER-SIDE (snapshot de la relación de la ciudad)', async () => {
    const cart = await db.cart.create({
      data: {
        sessionId: `ord1-${RUN}`,
        status: 'activo',
        items: { create: { productId, quantity: 2, unitPrice: 8000 } },
      },
    });
    const phone = `57320002${RUN.slice(-4)}`;
    checkoutPhones.push(phone);
    const result = await createOrderFromCart({
      cartId: cart.id,
      requestType: 'pedido',
      customerName: 'Cliente 5A',
      customerPhone: phone,
      cityId: cityA,
      sessionUser: null,
      sessionId: `ord1-${RUN}`,
    });
    createdOrderIds.push(result.order.id);
    expect(result.order.cityId).toBe(cityA);
    expect(result.order.routeId).toBe(routeAId);
    const cartAfter = await db.cart.findUnique({ where: { id: cart.id } });
    expect(cartAfter?.status).toBe('convertido');
  });

  d('create con ciudad INEXISTENTE => CITY_INVALID 400, cero Order parcial, carrito intacto', async () => {
    const cart = await db.cart.create({
      data: {
        sessionId: `ord2-${RUN}`,
        status: 'activo',
        items: { create: { productId, quantity: 1, unitPrice: 8000 } },
      },
    });
    let error: unknown = null;
    try {
      await createOrderFromCart({
        cartId: cart.id,
        requestType: 'pedido',
        customerName: 'Cliente 5A',
        customerPhone: `57320003${RUN.slice(-4)}`,
        cityId: `NO_EXISTE_${RUN}`,
        sessionUser: null,
        sessionId: `ord2-${RUN}`,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(OrderCreateError);
    expect((error as OrderCreateError).code).toBe('CITY_INVALID');
    expect((error as OrderCreateError).status).toBe(400);
    const cartAfter = await db.cart.findUnique({ where: { id: cart.id } });
    expect(cartAfter?.status).toBe('activo');
    const orders = await db.order.count({ where: { cartId: cart.id } });
    expect(orders).toBe(0);
  });

  d('create con ciudad INACTIVA => CITY_INVALID 400', async () => {
    const cart = await db.cart.create({
      data: {
        sessionId: `ord3-${RUN}`,
        status: 'activo',
        items: { create: { productId, quantity: 1, unitPrice: 8000 } },
      },
    });
    let error: unknown = null;
    try {
      await createOrderFromCart({
        cartId: cart.id,
        requestType: 'pedido',
        customerName: 'Cliente 5A',
        customerPhone: `57320004${RUN.slice(-4)}`,
        cityId: cityInactiveId,
        sessionUser: null,
        sessionId: `ord3-${RUN}`,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(OrderCreateError);
    expect((error as OrderCreateError).status).toBe(400);
    const cartAfter = await db.cart.findUnique({ where: { id: cart.id } });
    expect(cartAfter?.status).toBe('activo');
  });

  d('create con ciudad SIN ruta => Order con cityId y routeId null (sin ruta programada)', async () => {
    const cart = await db.cart.create({
      data: {
        sessionId: `ord4-${RUN}`,
        status: 'activo',
        items: { create: { productId, quantity: 1, unitPrice: 8000 } },
      },
    });
    const phone = `57320005${RUN.slice(-4)}`;
    checkoutPhones.push(phone);
    const result = await createOrderFromCart({
      cartId: cart.id,
      requestType: 'pedido',
      customerName: 'Cliente 5A',
      customerPhone: phone,
      cityId: cityNoRouteId,
      sessionUser: null,
      sessionId: `ord4-${RUN}`,
    });
    createdOrderIds.push(result.order.id);
    expect(result.order.cityId).toBe(cityNoRouteId);
    expect(result.order.routeId).toBeNull();
  });
});

// =====================
// ORDER — editCustomerOrder (cityId y routeId EN TÁNDEM)
// =====================
describe('FASE 5A Order — editCustomerOrder ciudad/ruta en tándem', () => {
  d('edit A→B actualiza cityId Y recalcula routeId al de B', async () => {
    const orderId = await seedHistoricalOrder({ suffix: 'e1', cityId: cityA, routeId: routeAId });
    const viewer = { user: { id: customerId, role: 'CUSTOMER' }, sessionId: null };
    await editCustomerOrder({
      orderId,
      viewer,
      sessionUser: { id: customerId, role: 'CUSTOMER' },
      sessionId: null,
      body: { cityId: cityB },
    });
    const after = await db.order.findUnique({ where: { id: orderId } });
    expect(after?.cityId).toBe(cityB);
    expect(after?.routeId).toBe(routeBId);
  });

  d('edit A→null limpia cityId Y routeId juntos', async () => {
    const orderId = await seedHistoricalOrder({ suffix: 'e2', cityId: cityA, routeId: routeAId });
    const viewer = { user: { id: customerId, role: 'CUSTOMER' }, sessionId: null };
    await editCustomerOrder({
      orderId,
      viewer,
      sessionUser: { id: customerId, role: 'CUSTOMER' },
      sessionId: null,
      body: { cityId: null },
    });
    const after = await db.order.findUnique({ where: { id: orderId } });
    expect(after?.cityId).toBeNull();
    expect(after?.routeId).toBeNull();
  });

  d('edit SIN cityId conserva cityId Y routeId', async () => {
    const orderId = await seedHistoricalOrder({ suffix: 'e3', cityId: cityA, routeId: routeAId });
    const viewer = { user: { id: customerId, role: 'CUSTOMER' }, sessionId: null };
    await editCustomerOrder({
      orderId,
      viewer,
      sessionUser: { id: customerId, role: 'CUSTOMER' },
      sessionId: null,
      body: { notes: 'solo notas' },
    });
    const after = await db.order.findUnique({ where: { id: orderId } });
    expect(after?.cityId).toBe(cityA);
    expect(after?.routeId).toBe(routeAId);
    expect(after?.notes).toBe('solo notas');
  });

  d('edit con ciudad inválida/inactiva => rollback COMPLETO (ciudad, ruta, líneas y notas intactas)', async () => {
    const orderId = await seedHistoricalOrder({ suffix: 'e4', cityId: cityA, routeId: routeAId });
    const viewer = { user: { id: customerId, role: 'CUSTOMER' }, sessionId: null };
    for (const badCity of [`NO_EXISTE_${RUN}`, cityInactiveId]) {
      let error: unknown = null;
      try {
        await editCustomerOrder({
          orderId,
          viewer,
          sessionUser: { id: customerId, role: 'CUSTOMER' },
          sessionId: null,
          body: { cityId: badCity, notes: 'no debe quedar', items: [{ productId, quantity: 9 }] },
        });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(OrderEditError);
      expect((error as OrderEditError).status).toBe(400);
      const after = await db.order.findUnique({ where: { id: orderId }, include: { items: true } });
      expect(after?.cityId).toBe(cityA);
      expect(after?.routeId).toBe(routeAId);
      expect(after?.notes).toBeNull();
      expect(after?.items).toHaveLength(1);
      expect(after?.items[0].quantity).toBe(2);
    }
  });

  d('edit con cityId TIPO INVÁLIDO (number) => 400 y CERO writes (NO se trata como omitido)', async () => {
    const orderId = await seedHistoricalOrder({ suffix: 'e5', cityId: cityA, routeId: routeAId });
    const before = await db.order.findUnique({ where: { id: orderId }, include: { items: true } });
    const historyBefore = await db.orderStatusHistory.count({ where: { orderId } });
    const viewer = { user: { id: customerId, role: 'CUSTOMER' }, sessionId: null };

    let error: unknown = null;
    try {
      await editCustomerOrder({
        orderId,
        viewer,
        sessionUser: { id: customerId, role: 'CUSTOMER' },
        sessionId: null,
        // P1-fix: `text()` convertía 123 en undefined => "omitido" (conservaba
        // ciudad y ESCRIBÍA notes). El contrato 5A exige 400 y cero writes.
        body: { cityId: 123, notes: 'no debe escribirse', items: [{ productId, quantity: 7 }] } as any,
      });
    } catch (e) {
      error = e;
    }

    expect(error).toBeInstanceOf(OrderEditError);
    expect((error as OrderEditError).status).toBe(400);

    const after = await db.order.findUnique({ where: { id: orderId }, include: { items: true } });
    expect(after?.cityId).toBe(cityA);       // cityId intacto
    expect(after?.routeId).toBe(routeAId);   // routeId intacto
    expect(after?.notes).toBe(before?.notes); // notes intactas (null)
    expect(after?.subtotal).toBe(before?.subtotal);
    expect(after?.items).toHaveLength(1);    // items intactos
    expect(after?.items[0].quantity).toBe(2);
    expect(after?.updatedAt).toEqual(before?.updatedAt); // sin write del pedido

    // Cero historial nuevo (la edición fallida no audita).
    const historyAfter = await db.orderStatusHistory.count({ where: { orderId } });
    expect(historyAfter).toBe(historyBefore);
  });

  d('edit con cityId TIPO INVÁLIDO (objeto) => 400 y cero writes', async () => {
    const orderId = await seedHistoricalOrder({ suffix: 'e6', cityId: cityA, routeId: routeAId });
    const viewer = { user: { id: customerId, role: 'CUSTOMER' }, sessionId: null };
    let error: unknown = null;
    try {
      await editCustomerOrder({
        orderId,
        viewer,
        sessionUser: { id: customerId, role: 'CUSTOMER' },
        sessionId: null,
        body: { cityId: { id: cityB }, notes: 'x' } as any,
      });
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(OrderEditError);
    expect((error as OrderEditError).status).toBe(400);
    const after = await db.order.findUnique({ where: { id: orderId } });
    expect(after?.cityId).toBe(cityA);
    expect(after?.routeId).toBe(routeAId);
    expect(after?.notes).toBeNull();
  });
});

// =====================
// WEBHOOK — snapshot Order.route prioritario
// =====================
describe('FASE 5A Webhook — snapshot de ruta', () => {
  d('pedido con ruta A sigue comunicando A aunque la ciudad se reasigne a B', async () => {
    const orderId = await seedHistoricalOrder({ suffix: 'w1', cityId: cityA, routeId: routeAId });
    // El admin reasigna la ciudad A a la ruta B:
    await db.city.update({ where: { id: cityA }, data: { shippingRouteId: routeBId } });
    const payload = await buildWebhookPayload(orderId);
    expect(payload?.city?.shippingRoute).toBe(`Ruta A ${RUN}`);
    // restaurar para otros tests
    await db.city.update({ where: { id: cityA }, data: { shippingRouteId: routeAId } });
  });

  d('legacy routeId=null: fallback DOCUMENTADO a city.shippingRoute', async () => {
    const orderId = await seedHistoricalOrder({ suffix: 'w2', cityId: cityB, routeId: null });
    const payload = await buildWebhookPayload(orderId);
    expect(payload?.city?.shippingRoute).toBe(`Ruta B ${RUN}`);
    expect(payload?.city?.estimatedDays).toBe('2-3 días');
  });
});

// =====================
// ADMIN — alta de ciudad NO destructiva (planCityUpsert)
// =====================
describe('FASE 5A Admin — slug conflict cross-departamento', () => {
  d('homónima en OTRO departamento => conflict, ciudad original intacta', async () => {
    const slug = `homónima-${RUN}`.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    // Ciudad original en deptA con su ruta:
    const original = await db.city.create({
      data: { name: `Homónima ${RUN}`, slug, departmentId: deptA, shippingRouteId: routeAId, isActive: true },
    });

    // El admin intenta crear "Homónima" en deptB:
    const plan = await planCityUpsert({ slug, name: `Homónima ${RUN}`, departmentId: deptB, shippingRouteId: null });
    expect(plan.action).toBe('conflict');

    // La ciudad original NO fue tocada:
    const after = await db.city.findUnique({ where: { id: original.id } });
    expect(after?.departmentId).toBe(deptA);
    expect(after?.shippingRouteId).toBe(routeAId);
    expect(after?.isActive).toBe(true);
    // Y NO existe ninguna ciudad de ese slug en deptB:
    const count = await db.city.count({ where: { slug } });
    expect(count).toBe(1);
  });

  d('mismo departamento => update compatible; slug libre => create', async () => {
    const same = await db.city.create({
      data: { name: `Misma Ciudad ${RUN}`, slug: `misma-ciudad-${RUN}`, departmentId: deptA, shippingRouteId: routeAId, isActive: true },
    });
    const planUpdate = await planCityUpsert({
      slug: `misma-ciudad-${RUN}`,
      name: `Misma Ciudad ${RUN}`,
      departmentId: deptA,
      shippingRouteId: null,
    });
    expect(planUpdate).toEqual({ action: 'update', cityId: same.id });

    const planCreate = await planCityUpsert({
      slug: `ciudad-nueva-${RUN}`,
      name: `Ciudad Nueva ${RUN}`,
      departmentId: deptA,
      shippingRouteId: routeAId,
    });
    expect(planCreate.action).toBe('create');
  });
});
