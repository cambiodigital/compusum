import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { NextRequest } from 'next/server';
import { PrismaClient } from '@prisma/client';
import { db } from '@/lib/db';

/**
 * FASE 5A-fix (P1) — PATCH /api/admin/orders/[id]: ciudad/ruta AUTORITATIVAS.
 *
 * 1. CARRERA cerrada: AGENT A pasa el lookup inicial, un admin reasigna el
 *    pedido a AGENT B mientras A espera el lock => 404 fail-closed + CERO
 *    writes (antes el camino sin `status` actualizaba sin FOR UPDATE ni
 *    re-chequeo de ownership post-lock).
 * 2. City→Route se resuelve DENTRO de la tx autoritativa (con o sin status):
 *    tri-state canónico (omit/clear/set), tipo inválido => 400, y `routeId`
 *    del body NUNCA controla el snapshot (se deriva de la ciudad).
 * 3. RBAC: ADMIN/EDITOR operan con normalidad; el aislamiento AGENT
 *    (solo SUS pedidos) sigue fail-closed.
 *
 * El handler se prueba DIRECTO contra PostgreSQL real. Solo se mocka la
 * capa de sesión (@/lib/auth → requireBackofficeApi); db, city-route y
 * guards son los de producción.
 */

const authState = vi.hoisted(() => ({
  user: null as { id: string; name: string; email: string | null; role: string } | null,
}));

vi.mock('@/lib/auth', () => ({
  requireBackofficeApi: vi.fn(async () => ({ error: null, user: authState.user })),
  isAgentRole: (role?: string | null) => (role ?? '').trim().toLowerCase() === 'agent',
}));

import { PATCH } from '@/app/api/admin/orders/[id]/route';

const HAS_POSTGRES = Boolean(process.env.DATABASE_URL?.startsWith('postgres'));
const d = it.skipIf(!HAS_POSTGRES);

const RUN = `${Date.now()}`;
let categoryId: string;
let customerId: string;
let agentAId: string;
let agentBId: string;
let deptA: string;
let cityA: string;
let cityB: string;
let cityInactiveId: string;
let routeAId: string;
let routeBId: string;
let routeCId: string;
let productId: string;
const orderIds: string[] = [];

interface SeedOptions {
  agentId?: string | null;
  cityId?: string | null;
  routeId?: string | null;
}

async function seedOrder(suffix: string, opts: SeedOptions = {}): Promise<string> {
  const cart = await db.cart.create({
    data: { sessionId: `sess-patch-${RUN}-${suffix}`, status: 'convertido' },
  });
  const order = await db.order.create({
    data: {
      orderNumber: `CS-PATCH-${RUN}-${suffix}`,
      cartId: cart.id,
      customerId,
      agentId: opts.agentId ?? null,
      cityId: opts.cityId ?? null,
      routeId: opts.routeId ?? null,
      subtotal: 16000,
      status: 'solicitado',
      items: {
        create: {
          productId,
          productName: 'Producto PATCH',
          quantity: 2,
          unitPrice: 8000,
        },
      },
    },
  });
  orderIds.push(order.id);
  return order.id;
}

function makePatchRequest(orderId: string, body: unknown): NextRequest {
  return new Request(`http://localhost/api/admin/orders/${orderId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

function asUser(id: string, role: string) {
  authState.user = { id, name: `Usuario ${role} ${RUN}`, email: null, role };
}

/** Barrera determinista: espera al handler bloqueado en el FOR UPDATE. */
async function waitForVictimLocked(queryFragment: string, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rows = await db.$queryRaw<{ count: bigint }[]>`
      SELECT count(*) AS count FROM pg_stat_activity
      WHERE wait_event_type = 'Lock'
        AND query ILIKE ${'%' + queryFragment + '%'}
        AND pid <> pg_backend_pid()`;
    if (Number(rows[0].count) > 0) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('El handler nunca llegó al lock wait: ' + queryFragment);
}

beforeAll(async () => {
  if (!HAS_POSTGRES) return;

  const category = await db.category.create({
    data: { name: `Cat PATCH ${RUN}`, slug: `cat-patch-${RUN}` },
  });
  categoryId = category.id;
  const product = await db.product.create({
    data: {
      name: 'Producto PATCH',
      slug: `prod-patch-${RUN}`,
      price: 10000,
      wholesalePrice: 8000,
      stockQuantity: 50,
      categoryId,
    },
  });
  productId = product.id;

  const customer = await db.user.create({
    data: {
      name: `Cliente PATCH ${RUN}`,
      phone: `57321001${RUN.slice(-4)}`,
      role: 'CUSTOMER',
      password: 'x',
    },
  });
  customerId = customer.id;
  const agentA = await db.user.create({
    data: { name: `Agente A ${RUN}`, phone: `57321002${RUN.slice(-4)}`, role: 'AGENT', password: 'x' },
  });
  agentAId = agentA.id;
  const agentB = await db.user.create({
    data: { name: `Agente B ${RUN}`, phone: `57321003${RUN.slice(-4)}`, role: 'AGENT', password: 'x' },
  });
  agentBId = agentB.id;

  const dept = await db.department.create({
    data: { name: `Dept PATCH ${RUN}`, code: `5PC${RUN.slice(-5)}` },
  });
  deptA = dept.id;
  const routeA = await db.shippingRoute.create({
    data: { name: `Ruta PATCH A ${RUN}`, estimatedDaysMin: 1, estimatedDaysMax: 2, departureDaysOfWeek: [1], isActive: true },
  });
  routeAId = routeA.id;
  const routeB = await db.shippingRoute.create({
    data: { name: `Ruta PATCH B ${RUN}`, estimatedDaysMin: 2, estimatedDaysMax: 3, departureDaysOfWeek: [2], isActive: true },
  });
  routeBId = routeB.id;
  const routeC = await db.shippingRoute.create({
    data: { name: `Ruta PATCH C ${RUN}`, estimatedDaysMin: 1, estimatedDaysMax: 1, departureDaysOfWeek: [3], isActive: true },
  });
  routeCId = routeC.id;

  cityA = (
    await db.city.create({
      data: { name: `CiudadA PATCH ${RUN}`, slug: `ciudada-patch-${RUN}`, departmentId: deptA, shippingRouteId: routeAId, isActive: true },
    })
  ).id;
  cityB = (
    await db.city.create({
      data: { name: `CiudadB PATCH ${RUN}`, slug: `ciudadb-patch-${RUN}`, departmentId: deptA, shippingRouteId: routeBId, isActive: true },
    })
  ).id;
  cityInactiveId = (
    await db.city.create({
      data: { name: `CiudadInactiva PATCH ${RUN}`, slug: `inactiva-patch-${RUN}`, departmentId: deptA, shippingRouteId: routeCId, isActive: false },
    })
  ).id;
}, 30000);

afterAll(async () => {
  if (!HAS_POSTGRES) return;
  await db.order.deleteMany({ where: { id: { in: orderIds } } });
  await db.cart.deleteMany({ where: { sessionId: { startsWith: `sess-patch-${RUN}` } } });
  await db.city.deleteMany({ where: { departmentId: deptA } });
  await db.shippingRoute.deleteMany({
    where: { id: { in: [routeAId, routeBId, routeCId].filter(Boolean) } },
  });
  await db.department.deleteMany({ where: { id: deptA } });
  await db.user.deleteMany({
    where: { id: { in: [customerId, agentAId, agentBId].filter(Boolean) } },
  });
  await db.product.deleteMany({ where: { id: productId } });
  await db.category.deleteMany({ where: { id: categoryId } });
  await db.$disconnect();
}, 30000);

d('ADMIN cityId válida SIN status => cityId + routeId derivados server-side', async () => {
  const orderId = await seedOrder('admin-ok', { cityId: cityA, routeId: routeAId });
  authState.user = { id: agentAId, name: 'Admin', email: null, role: 'admin' };

  const res = await PATCH(makePatchRequest(orderId, { cityId: cityB }), {
    params: Promise.resolve({ id: orderId }),
  });
  const json = await res.json();
  expect(res.status).toBe(200);
  expect(json.success).toBe(true);
  const after = await db.order.findUnique({ where: { id: orderId } });
  expect(after?.cityId).toBe(cityB);
  expect(after?.routeId).toBe(routeBId);
});

d('ADMIN con status + cityId: estado y ciudad/ruta en la MISMA tx', async () => {
  const orderId = await seedOrder('admin-status', { cityId: cityA, routeId: routeAId });
  authState.user = { id: agentAId, name: 'Editora', email: null, role: 'editor' };

  const res = await PATCH(makePatchRequest(orderId, { status: 'compartido', cityId: cityB }), {
    params: Promise.resolve({ id: orderId }),
  });
  expect(res.status).toBe(200);
  const after = await db.order.findUnique({ where: { id: orderId } });
  expect(after?.status).toBe('compartido');
  expect(after?.cityId).toBe(cityB);
  expect(after?.routeId).toBe(routeBId);
});

d('ADMIN cityId null => limpia cityId Y routeId', async () => {
  const orderId = await seedOrder('admin-clear', { cityId: cityA, routeId: routeAId });
  authState.user = { id: agentAId, name: 'Admin', email: null, role: 'admin' };

  const res = await PATCH(makePatchRequest(orderId, { cityId: null }), {
    params: Promise.resolve({ id: orderId }),
  });
  expect(res.status).toBe(200);
  const after = await db.order.findUnique({ where: { id: orderId } });
  expect(after?.cityId).toBeNull();
  expect(after?.routeId).toBeNull();
});

d('cityId omitido => conserva cityId/routeId (regresión del camino sin status)', async () => {
  const orderId = await seedOrder('admin-omit', { cityId: cityA, routeId: routeAId });
  authState.user = { id: agentAId, name: 'Admin', email: null, role: 'admin' };

  const res = await PATCH(makePatchRequest(orderId, { notes: 'solo notas' }), {
    params: Promise.resolve({ id: orderId }),
  });
  expect(res.status).toBe(200);
  const after = await db.order.findUnique({ where: { id: orderId } });
  expect(after?.cityId).toBe(cityA);
  expect(after?.routeId).toBe(routeAId);
  expect(after?.notes).toBe('solo notas');
});

d('cityId inválida/inactiva/tipo inválido => 400 + CERO writes', async () => {
  const orderId = await seedOrder('admin-bad', { cityId: cityA, routeId: routeAId, agentId: agentAId });
  const before = await db.order.findUnique({ where: { id: orderId } });
  authState.user = { id: agentBId, name: 'Admin', email: null, role: 'admin' };

  for (const badCity of [`NO_EXISTE_${RUN}`, cityInactiveId, 123]) {
    const res = await PATCH(makePatchRequest(orderId, { cityId: badCity as any }), {
      params: Promise.resolve({ id: orderId }),
    });
    const json = await res.json();
    expect(res.status).toBe(400);
    expect(json.success).toBe(false);
    const after = await db.order.findUnique({ where: { id: orderId } });
    expect(after?.cityId).toBe(cityA);
    expect(after?.routeId).toBe(routeAId);
    expect(after?.updatedAt).toEqual(before?.updatedAt);
  }
});

d('routeId manipulado en el body NO controla el snapshot', async () => {
  const orderId = await seedOrder('admin-routeid', { cityId: cityA, routeId: routeAId });
  authState.user = { id: agentAId, name: 'Admin', email: null, role: 'admin' };

  const res = await PATCH(
    makePatchRequest(orderId, { cityId: cityB, routeId: routeCId }),
    { params: Promise.resolve({ id: orderId }) }
  );
  expect(res.status).toBe(200);
  const after = await db.order.findUnique({ where: { id: orderId } });
  expect(after?.cityId).toBe(cityB);
  // La ruta se DERIVA de la ciudad (B), no del body (C):
  expect(after?.routeId).toBe(routeBId);
});

d('AGENT sobre pedido PROPIO sin status => 200 (aislamiento sin regresión)', async () => {
  const orderId = await seedOrder('agent-own', { agentId: agentAId, cityId: cityA, routeId: routeAId });
  authState.user = { id: agentAId, name: 'Agente A', email: null, role: 'AGENT' };

  const res = await PATCH(makePatchRequest(orderId, { cityId: cityB }), {
    params: Promise.resolve({ id: orderId }),
  });
  expect(res.status).toBe(200);
  const after = await db.order.findUnique({ where: { id: orderId } });
  expect(after?.cityId).toBe(cityB);
  expect(after?.routeId).toBe(routeBId);
});

d('AGENT sobre pedido AJENO => 404 fail-closed + cero writes', async () => {
  const orderId = await seedOrder('agent-foreign', { agentId: agentBId, cityId: cityA, routeId: routeAId });
  const before = await db.order.findUnique({ where: { id: orderId } });
  authState.user = { id: agentAId, name: 'Agente A', email: null, role: 'AGENT' };

  const res = await PATCH(makePatchRequest(orderId, { cityId: cityB, notes: 'hack' }), {
    params: Promise.resolve({ id: orderId }),
  });
  expect(res.status).toBe(404);
  const after = await db.order.findUnique({ where: { id: orderId } });
  expect(after?.cityId).toBe(cityA);
  expect(after?.routeId).toBe(routeAId);
  expect(after?.notes).toBe(before?.notes);
});

d('CARRERA: AGENT A pasa precheck, el pedido pasa a AGENT B antes del write => 404 + cero writes', async () => {
  const orderId = await seedOrder('race', { agentId: agentAId, cityId: cityA, routeId: routeAId });
  asUser(agentAId, 'AGENT');

  let releaseLock!: () => void;
  const lockReleased = new Promise<void>((resolve) => { releaseLock = resolve; });
  let fireHandler!: () => void;
  const handlerFired = new Promise<void>((resolve) => { fireHandler = resolve; });

  // 1) La tx del "admin" toma el lock de fila PRIMERO.
  const txDone = db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
    fireHandler();
    await lockReleased;
    // 4) El admin reasigna el pedido a AGENT B mientras el handler espera.
    await tx.order.update({ where: { id: orderId }, data: { agentId: agentBId } });
  });

  await handlerFired;
  // 2) El handler (AGENT A) pasa su lookup inicial y queda BLOQUEADO en el
  //    FOR UPDATE de su tx autoritativa.
  const responsePromise = PATCH(makePatchRequest(orderId, { cityId: cityB }), {
    params: Promise.resolve({ id: orderId }),
  });
  await waitForVictimLocked('FOR UPDATE');
  // 3) Liberamos el lock: el handler relee POST-lock (agentId=B) => 404.
  releaseLock();
  await txDone;

  const res = await responsePromise;
  expect(res.status).toBe(404);

  const after = await db.order.findUnique({ where: { id: orderId } });
  expect(after?.agentId).toBe(agentBId); // la reasignación del admin permanece
  expect(after?.cityId).toBe(cityA);     // cero writes del handler
  expect(after?.routeId).toBe(routeAId); // cero writes del handler
  expect(after?.notes).toBeNull();       // cero writes del handler
  // Nota: updatedAt SÍ cambia aquí, legítimamente, por la transferencia del
  // admin (agentId). Por eso no se aserta en este test de carrera.
});
