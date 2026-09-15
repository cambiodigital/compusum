import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { db } from '@/lib/db';
import { getShippingEstimation } from '@/lib/shipping-calc';
import { resolveShippingRouteForCity, CityResolutionError } from '@/lib/city-route';
import { createOrderFromCart } from '@/lib/order-create';
import { editCustomerOrder } from '@/lib/order-edit';

/**
 * FASE 5B1 — cutoff RECURRENTE en los flujos REALES contra PostgreSQL.
 *
 * Regresión central: una ruta con `cutOffTime` LEGACY VENCIDO y los campos
 * recurrentes en null NO puede quedar cerrada. Antes de 5B1 eso vaciaba
 * `routeId` en checkout, edición y PATCH admin, y el storefront mostraba
 * "el corte ya cerró" de forma permanente.
 *
 * Cobertura: getShippingEstimation · resolveShippingRouteForCity ·
 * createOrderFromCart · editCustomerOrder · PATCH admin.
 *
 * Solo se mocka la capa de sesión para el handler HTTP (mismo patrón que
 * admin-order-city-patch-pg.test.ts); db, city-route y el cálculo temporal son
 * los de producción. El resto de `@/lib/auth` se conserva intacto.
 */

const authState = vi.hoisted(() => ({
  user: null as { id: string; name: string; email: string | null; role: string } | null,
}));

vi.mock('@/lib/auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth')>();
  return {
    ...actual,
    requireBackofficeApi: vi.fn(async () => ({ error: null, user: authState.user })),
  };
});

import { PATCH } from '@/app/api/admin/orders/[id]/route';

const HAS_POSTGRES = Boolean(process.env.DATABASE_URL?.startsWith('postgres'));
const d = it.skipIf(!HAS_POSTGRES);

const RUN = `${Date.now()}`;

let categoryId: string;
let productId: string;
let customerId: string;
let deptId: string;

// Rutas bajo prueba
let routeLegacyExpiredId: string; // legacy absoluto vencido, recurrente null
let routeRollForwardId: string; // cutoff 0 días 00:00 => siempre avanza
let routeRecurringId: string; // cutoff 3 días antes 14:00 (para `now` inyectado)
let routeMisconfiguredId: string; // cutoff parcial
let routeInactiveId: string;

// Ciudades
let cityLegacy: string;
let cityRollForward: string;
let cityRecurring: string;
let cityMisconfigured: string;
let cityInactive: string;
let cityNoRoute: string;

const createdOrderIds: string[] = [];

// Instantes fijos (America/Bogota = UTC-5, sin DST)
const FRI_0911_1359_BOG = new Date('2026-09-11T18:59:59.000Z');
const FRI_0911_1400_BOG = new Date('2026-09-11T19:00:00.000Z');
const MON_0914_1000_BOG = new Date('2026-09-14T15:00:00.000Z');
const SAT_0919_1000_BOG = new Date('2026-09-19T15:00:00.000Z');

async function makeCity(name: string, shippingRouteId: string | null, isActive = true) {
  return db.city.create({
    data: {
      name: `${name} ${RUN}`,
      slug: `${name.toLowerCase()}-${RUN}`,
      departmentId: deptId,
      shippingRouteId,
      isActive,
    },
  });
}

async function seedOrder(opts: { suffix: string; cityId: string | null; routeId: string | null }) {
  const cart = await db.cart.create({
    data: { sessionId: `sess-5b1-${RUN}-${opts.suffix}`, status: 'convertido' },
  });
  const order = await db.order.create({
    data: {
      orderNumber: `CS-5B1-${RUN}-${opts.suffix}`,
      cartId: cart.id,
      customerId,
      cityId: opts.cityId,
      routeId: opts.routeId,
      subtotal: 8000,
      status: 'solicitado',
      items: {
        create: {
          productId,
          productName: 'Producto 5B1',
          quantity: 1,
          unitPrice: 8000,
        },
      },
    },
  });
  createdOrderIds.push(order.id);
  return order.id;
}

function makePatchRequest(orderId: string, body: unknown): NextRequest {
  return new Request(`http://localhost/api/admin/orders/${orderId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeAll(async () => {
  if (!HAS_POSTGRES) return;

  const category = await db.category.create({
    data: { name: `Cat 5B1 ${RUN}`, slug: `cat-5b1-${RUN}` },
  });
  categoryId = category.id;
  const product = await db.product.create({
    data: {
      name: `Producto 5B1 ${RUN}`,
      slug: `producto-5b1-${RUN}`,
      sku: `SKU5B1-${RUN}`,
      price: 8000,
      stockQuantity: 100,
      categoryId,
    },
  });
  productId = product.id;

  const customer = await db.user.create({
    data: {
      name: `Cliente 5B1 ${RUN}`,
      email: `cliente-5b1-${RUN}@test.com`,
      password: 'no-login',
      role: 'CUSTOMER',
    },
  });
  customerId = customer.id;
  // El handler HTTP lee la sesión de esta capa mockeada.
  authState.user = { id: customer.id, name: customer.name, email: null, role: 'ADMIN' };

  const dept = await db.department.create({
    data: { name: `Dept 5B1 ${RUN}`, code: `5B1${RUN.slice(-5)}` },
  });
  deptId = dept.id;

  // 1) LA REGRESIÓN: legacy absoluto VENCIDO + campos recurrentes null.
  const legacy = await db.shippingRoute.create({
    data: {
      name: `Ruta legacy vencida ${RUN}`,
      estimatedDaysMin: 1,
      estimatedDaysMax: 2,
      shippingCompany: 'Servientrega',
      departureDaysOfWeek: [1], // lunes
      sortOrder: 1,
      isActive: true,
      cutOffTime: new Date('2026-03-25T14:00:00.000Z'), // pasado
      departureDate: new Date('2026-03-31T00:00:00.000Z'),
      cutoffDaysBefore: null,
      cutoffLocalTime: null,
    },
  });
  routeLegacyExpiredId = legacy.id;

  // 2) Siempre hace roll-forward: sale todos los días, cutoff el mismo día 00:00.
  const rollForward = await db.shippingRoute.create({
    data: {
      name: `Ruta roll-forward ${RUN}`,
      estimatedDaysMin: 1,
      estimatedDaysMax: 2,
      departureDaysOfWeek: [0, 1, 2, 3, 4, 5, 6],
      sortOrder: 2,
      isActive: true,
      cutoffDaysBefore: 0,
      cutoffLocalTime: '00:00',
    },
  });
  routeRollForwardId = rollForward.id;

  // 3) Cutoff recurrente determinista para el `now` inyectado.
  const recurring = await db.shippingRoute.create({
    data: {
      name: `Ruta recurrente ${RUN}`,
      estimatedDaysMin: 2,
      estimatedDaysMax: 4,
      departureDaysOfWeek: [1], // lunes
      sortOrder: 3,
      isActive: true,
      cutoffDaysBefore: 3,
      cutoffLocalTime: '14:00',
    },
  });
  routeRecurringId = recurring.id;

  // 4) Configuración INVÁLIDA: días antes sin hora.
  const misconfigured = await db.shippingRoute.create({
    data: {
      name: `Ruta misconfigured ${RUN}`,
      estimatedDaysMin: 1,
      estimatedDaysMax: 1,
      departureDaysOfWeek: [1],
      sortOrder: 4,
      isActive: true,
      cutoffDaysBefore: 2,
      cutoffLocalTime: null,
    },
  });
  routeMisconfiguredId = misconfigured.id;

  const inactive = await db.shippingRoute.create({
    data: {
      name: `Ruta inactiva ${RUN}`,
      estimatedDaysMin: 1,
      estimatedDaysMax: 1,
      departureDaysOfWeek: [1],
      sortOrder: 5,
      isActive: false,
    },
  });
  routeInactiveId = inactive.id;

  cityLegacy = (await makeCity('CiudadLegacy', routeLegacyExpiredId)).id;
  cityRollForward = (await makeCity('CiudadRollFwd', routeRollForwardId)).id;
  cityRecurring = (await makeCity('CiudadRecurrente', routeRecurringId)).id;
  cityMisconfigured = (await makeCity('CiudadMisco', routeMisconfiguredId)).id;
  cityInactive = (await makeCity('CiudadInactiva5b1', routeInactiveId)).id;
  cityNoRoute = (await makeCity('CiudadSinRuta', null)).id;
}, 300000);

afterAll(async () => {
  if (!HAS_POSTGRES) return;
  await db.orderItem.deleteMany({ where: { orderId: { in: createdOrderIds } } });
  await db.order.deleteMany({ where: { id: { in: createdOrderIds } } });
  await db.cart.deleteMany({ where: { sessionId: { startsWith: `sess-5b1-${RUN}` } } });
  await db.city.deleteMany({ where: { slug: { endsWith: RUN } } });
  await db.shippingRoute.deleteMany({ where: { name: { endsWith: RUN } } });
  await db.department.deleteMany({ where: { code: `5B1${RUN.slice(-5)}` } });
  await db.user.deleteMany({ where: { id: customerId } });
  await db.product.deleteMany({ where: { id: productId } });
  await db.category.deleteMany({ where: { id: categoryId } });
}, 300000);

// =====================================================================
// getShippingEstimation
// =====================================================================
describe.skipIf(!HAS_POSTGRES)('5B1 estimate — cutoff recurrente', () => {
  d('REGRESIÓN: cutOffTime legacy vencido + recurrente null => NO se bloquea', async () => {
    const result = await getShippingEstimation(cityLegacy, MON_0914_1000_BOG);
    expect(result.status).toBe('available');
    if (result.status !== 'available') throw new Error('expected available');
    expect(result.routeId).toBe(routeLegacyExpiredId);
    // Sin cutoff recurrente => sin cutoff efectivo, ruta siempre elegible.
    expect(result.effectiveCutoffAt).toBeNull();
    expect(result.hoursLeft).toBeNull();
    expect(result.skippedDeparture).toBe(false);
    expect(result.nextDepartureCivilDate).toBe('2026-09-14'); // lunes
    expect(result.timezone).toBe('America/Bogota');
  });

  d('REGRESIÓN: sigue disponible más adelante (no quedó cerrada para siempre)', async () => {
    const result = await getShippingEstimation(cityLegacy, SAT_0919_1000_BOG);
    expect(result.status).toBe('available');
    if (result.status !== 'available') throw new Error('expected available');
    expect(result.nextDepartureCivilDate).toBe('2026-09-21'); // lunes siguiente
    expect(result.daysUntilDeparture).toBe(2);
  });

  d('roll-forward: el cutoff inmediato pasó => avanza a la próxima salida', async () => {
    const result = await getShippingEstimation(cityRollForward, MON_0914_1000_BOG);
    expect(result.status).toBe('available');
    if (result.status !== 'available') throw new Error('expected available');
    expect(result.skippedDeparture).toBe(true);
    // el cutoff de hoy (00:00) ya pasó -> viaja mañana
    expect(result.nextDepartureCivilDate).toBe('2026-09-15');
    expect(result.message).toContain('ya cerró');
  });

  d('ANTES del cutoff: usa la salida más próxima y expone el cutoff efectivo', async () => {
    const result = await getShippingEstimation(cityRecurring, FRI_0911_1359_BOG);
    expect(result.status).toBe('available');
    if (result.status !== 'available') throw new Error('expected available');
    expect(result.nextDepartureCivilDate).toBe('2026-09-14');
    expect(result.skippedDeparture).toBe(false);
    // viernes 11 a las 14:00 Bogotá = 19:00Z
    expect(result.effectiveCutoffAt?.toISOString()).toBe('2026-09-11T19:00:00.000Z');
  });

  d('EXACTAMENTE en el cutoff: esa salida se descarta (roll-forward)', async () => {
    const result = await getShippingEstimation(cityRecurring, FRI_0911_1400_BOG);
    expect(result.status).toBe('available');
    if (result.status !== 'available') throw new Error('expected available');
    expect(result.skippedDeparture).toBe(true);
    expect(result.skippedCivilDate).toBe('2026-09-14');
    expect(result.nextDepartureCivilDate).toBe('2026-09-21');
  });

  d('schedule inválido => misconfigured (no se adivina)', async () => {
    const result = await getShippingEstimation(cityMisconfigured, MON_0914_1000_BOG);
    expect(result.status).toBe('misconfigured');
    if (result.status !== 'misconfigured') throw new Error('expected misconfigured');
    expect(result.reason).toBe('partial_cutoff');
  });

  d('ruta inactiva => unavailable', async () => {
    const result = await getShippingEstimation(cityInactive, MON_0914_1000_BOG);
    expect(result.status).toBe('unavailable');
  });

  d('ciudad sin ruta => unavailable', async () => {
    const result = await getShippingEstimation(cityNoRoute, MON_0914_1000_BOG);
    expect(result.status).toBe('unavailable');
  });

  d('ciudad inexistente => unavailable', async () => {
    const result = await getShippingEstimation(`NO_EXISTE_${RUN}`, MON_0914_1000_BOG);
    expect(result.status).toBe('unavailable');
  });
});

// =====================================================================
// resolveShippingRouteForCity
// =====================================================================
describe.skipIf(!HAS_POSTGRES)('5B1 resolveShippingRouteForCity — elegibilidad delegada', () => {
  d('REGRESIÓN: la ruta con cutOffTime legacy vencido NO se vacía', async () => {
    const { city, route } = await resolveShippingRouteForCity(
      cityLegacy,
      db,
      MON_0914_1000_BOG
    );
    expect(city.id).toBe(cityLegacy);
    expect(route?.id).toBe(routeLegacyExpiredId);
  });

  d('con cutoff recurrente abierto devuelve la ruta', async () => {
    const { route } = await resolveShippingRouteForCity(cityRecurring, db, FRI_0911_1359_BOG);
    expect(route?.id).toBe(routeRecurringId);
  });

  d('con el cutoff inmediato cerrado también devuelve la ruta (roll-forward)', async () => {
    const { route } = await resolveShippingRouteForCity(cityRecurring, db, FRI_0911_1400_BOG);
    expect(route?.id).toBe(routeRecurringId);
  });

  d('schedule inválido => route null (fail-safe)', async () => {
    const { route } = await resolveShippingRouteForCity(cityMisconfigured, db, MON_0914_1000_BOG);
    expect(route).toBeNull();
  });

  d('ruta inactiva => route null', async () => {
    const { route } = await resolveShippingRouteForCity(cityInactive, db, MON_0914_1000_BOG);
    expect(route).toBeNull();
  });

  d('ciudad sin ruta => route null', async () => {
    const { route } = await resolveShippingRouteForCity(cityNoRoute, db, MON_0914_1000_BOG);
    expect(route).toBeNull();
  });

  d('ciudad inactiva => CityResolutionError 400', async () => {
    const inactiveCity = await makeCity('CiudadOff5b1', routeLegacyExpiredId, false);
    let error: unknown = null;
    try {
      await resolveShippingRouteForCity(inactiveCity.id, db, MON_0914_1000_BOG);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CityResolutionError);
    expect((error as CityResolutionError).status).toBe(400);
    await db.city.delete({ where: { id: inactiveCity.id } });
  });

  d('ciudad inexistente => CityResolutionError 400', async () => {
    let error: unknown = null;
    try {
      await resolveShippingRouteForCity(`NO_EXISTE_${RUN}`, db, MON_0914_1000_BOG);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(CityResolutionError);
  });
});

// =====================================================================
// createOrderFromCart — checkout
// =====================================================================
describe.skipIf(!HAS_POSTGRES)('5B1 checkout — createOrderFromCart conserva routeId', () => {
  d('REGRESIÓN: ruta con cutOffTime legacy vencido => routeId SE CONSERVA', async () => {
    const cart = await db.cart.create({
      data: {
        sessionId: `sess-5b1-${RUN}-ord1`,
        status: 'activo',
        items: { create: { productId, quantity: 1, unitPrice: 8000 } },
      },
    });
    const result = await createOrderFromCart({
      cartId: cart.id,
      requestType: 'pedido',
      customerName: 'Cliente 5B1',
      customerPhone: `57320301${RUN.slice(-4)}`,
      cityId: cityLegacy,
      sessionUser: null,
      sessionId: `sess-5b1-${RUN}-ord1`,
    });
    createdOrderIds.push(result.order.id);
    expect(result.order.cityId).toBe(cityLegacy);
    expect(result.order.routeId).toBe(routeLegacyExpiredId);
  });

  d('con roll-forward el pedido igual queda con routeId', async () => {
    const cart = await db.cart.create({
      data: {
        sessionId: `sess-5b1-${RUN}-ord2`,
        status: 'activo',
        items: { create: { productId, quantity: 1, unitPrice: 8000 } },
      },
    });
    const result = await createOrderFromCart({
      cartId: cart.id,
      requestType: 'pedido',
      customerName: 'Cliente 5B1',
      customerPhone: `57320302${RUN.slice(-4)}`,
      cityId: cityRollForward,
      sessionUser: null,
      sessionId: `sess-5b1-${RUN}-ord2`,
    });
    createdOrderIds.push(result.order.id);
    expect(result.order.routeId).toBe(routeRollForwardId);
  });

  d('schedule inválido => routeId null (sin error de ciudad)', async () => {
    const cart = await db.cart.create({
      data: {
        sessionId: `sess-5b1-${RUN}-ord3`,
        status: 'activo',
        items: { create: { productId, quantity: 1, unitPrice: 8000 } },
      },
    });
    const result = await createOrderFromCart({
      cartId: cart.id,
      requestType: 'pedido',
      customerName: 'Cliente 5B1',
      customerPhone: `57320303${RUN.slice(-4)}`,
      cityId: cityMisconfigured,
      sessionUser: null,
      sessionId: `sess-5b1-${RUN}-ord3`,
    });
    createdOrderIds.push(result.order.id);
    expect(result.order.cityId).toBe(cityMisconfigured);
    expect(result.order.routeId).toBeNull();
  });
});

// =====================================================================
// editCustomerOrder
// =====================================================================
describe.skipIf(!HAS_POSTGRES)('5B1 edición de pedido — routeId en tándem', () => {
  d('cambio a ciudad con legacy vencido => deriva routeId (no null)', async () => {
    const orderId = await seedOrder({ suffix: 'e1', cityId: cityNoRoute, routeId: null });
    const viewer = { user: { id: customerId, role: 'CUSTOMER' }, sessionId: null };
    await editCustomerOrder({
      orderId,
      viewer,
      sessionUser: { id: customerId, role: 'CUSTOMER' },
      sessionId: null,
      body: { cityId: cityLegacy },
    });
    const after = await db.order.findUnique({ where: { id: orderId } });
    expect(after?.cityId).toBe(cityLegacy);
    expect(after?.routeId).toBe(routeLegacyExpiredId);
  });

  d('cambio a ciudad con schedule inválido => routeId null', async () => {
    const orderId = await seedOrder({ suffix: 'e2', cityId: cityLegacy, routeId: routeLegacyExpiredId });
    const viewer = { user: { id: customerId, role: 'CUSTOMER' }, sessionId: null };
    await editCustomerOrder({
      orderId,
      viewer,
      sessionUser: { id: customerId, role: 'CUSTOMER' },
      sessionId: null,
      body: { cityId: cityMisconfigured },
    });
    const after = await db.order.findUnique({ where: { id: orderId } });
    expect(after?.cityId).toBe(cityMisconfigured);
    expect(after?.routeId).toBeNull();
  });
});

// =====================================================================
// PATCH admin
// =====================================================================
describe.skipIf(!HAS_POSTGRES)('5B1 PATCH admin de pedido — routeId en tándem', () => {
  async function patch(orderId: string, body: unknown) {
    const res = await PATCH(makePatchRequest(orderId, body), {
      params: Promise.resolve({ id: orderId }),
    });
    return res;
  }

  d('cambio a ciudad con legacy vencido => routeId SE CONSERVA', async () => {
    const orderId = await seedOrder({ suffix: 'p1', cityId: cityNoRoute, routeId: null });
    const res = await patch(orderId, { cityId: cityLegacy });
    expect(res.status).toBe(200);
    const after = await db.order.findUnique({ where: { id: orderId } });
    expect(after?.cityId).toBe(cityLegacy);
    expect(after?.routeId).toBe(routeLegacyExpiredId);
  });

  d('cambio a ciudad con schedule inválido => routeId null', async () => {
    const orderId = await seedOrder({
      suffix: 'p2',
      cityId: cityLegacy,
      routeId: routeLegacyExpiredId,
    });
    const res = await patch(orderId, { cityId: cityMisconfigured });
    expect(res.status).toBe(200);
    const after = await db.order.findUnique({ where: { id: orderId } });
    expect(after?.cityId).toBe(cityMisconfigured);
    expect(after?.routeId).toBeNull();
  });

  d('limpiar ciudad limpia cityId y routeId juntos', async () => {
    const orderId = await seedOrder({
      suffix: 'p3',
      cityId: cityLegacy,
      routeId: routeLegacyExpiredId,
    });
    const res = await patch(orderId, { cityId: null });
    expect(res.status).toBe(200);
    const after = await db.order.findUnique({ where: { id: orderId } });
    expect(after?.cityId).toBeNull();
    expect(after?.routeId).toBeNull();
  });
});
