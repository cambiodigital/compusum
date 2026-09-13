import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * FASE 4C — REPORTING COMERCIAL: aislamiento AGENT de extremo a extremo.
 *
 * El mock de la base de datos FILTRA fixtures reales aplicando los `where`
 * que recibe, de modo que cada test verifica DOS cosas a la vez:
 *  1. el `where` que la capa de reporting envía (scoping server-side), y
 *  2. que el reporte resultante no contiene datos de terceros (leak real).
 *
 * Semántica obligada:
 * - Cartera actual: `User.assignedAgentId` (AGENT = self).
 * - Producción histórica: `Order.agentId` (AGENT = self; snapshot del
 *   asesor dueño al crear, NO el asesor hoy asignado del cliente).
 * - `asesor`/`agentId` de la URL jamás amplían el alcance de un AGENT.
 * - El bucket "Sin asesor" (agentId=null) y los nombres de otros agentes
 *   son superficies exclusivas de ADMIN/EDITOR.
 */

const authState = vi.hoisted(() => ({
  backofficeUser: null as { id: string; name: string; email: string | null; role: string } | null,
}));

const mockDb = vi.hoisted(() => ({
  user: {
    count: vi.fn(),
    groupBy: vi.fn(),
    findMany: vi.fn(),
  },
  order: {
    aggregate: vi.fn(),
    groupBy: vi.fn(),
    findMany: vi.fn(),
  },
  $queryRaw: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db: mockDb }));

vi.mock('@/lib/auth', async () => {
  const roles = await import('@/lib/roles');
  return {
    ...roles,
    requireBackofficeUser: async () => authState.backofficeUser,
  };
});

import {
  buildCommercialReport,
  resolveReportingQuery,
  resolvePeriodStart,
} from '@/lib/commercial-reporting';
import { isBackofficeRole } from '@/lib/roles';
import ReportesPage from '@/app/admin/reportes/page';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const AGENT_A = { id: 'agent-a', name: 'Agente A', email: 'a@test.com', role: 'AGENT' };
const AGENT_B = { id: 'agent-b', name: 'Agente B', email: 'b@test.com', role: 'AGENT' };
const ADMIN = { id: 'admin-1', name: 'Admin', email: 'admin@test.com', role: 'admin' };
const EDITOR = { id: 'editor-1', name: 'Editor', email: 'e@test.com', role: 'editor' };
const CUSTOMER_USER = { id: 'cust-x', name: 'Cliente', email: 'c@test.com', role: 'CUSTOMER' };

interface FixtureUser {
  id: string;
  name: string;
  role: string;
  isActive: boolean;
  assignedAgentId: string | null;
}

interface FixtureOrder {
  id: string;
  orderNumber: string;
  customerId: string;
  agentId: string | null;
  customerName: string | null;
  status: string;
  requestType: string;
  subtotal: number;
  createdAt: Date;
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function monthsAgo(months: number): Date {
  const d = new Date();
  d.setMonth(d.getMonth() - months);
  return d;
}

const usersFixture: FixtureUser[] = [
  { id: 'agent-a', name: 'Agente A', role: 'AGENT', isActive: true, assignedAgentId: null },
  { id: 'agent-b', name: 'Agente B', role: 'AGENT', isActive: true, assignedAgentId: null },
  { id: 'agent-c', name: 'Agente C inactivo', role: 'AGENT', isActive: false, assignedAgentId: null },
  // Cartera de A
  { id: 'c1', name: 'Cliente 1', role: 'CUSTOMER', isActive: true, assignedAgentId: 'agent-a' },
  { id: 'c2', name: 'Cliente 2', role: 'CUSTOMER', isActive: false, assignedAgentId: 'agent-a' },
  // Cartera de B (c5 fue reasignado: era de A)
  { id: 'c3', name: 'Cliente 3', role: 'CUSTOMER', isActive: true, assignedAgentId: 'agent-b' },
  { id: 'c5', name: 'Cliente reasignado', role: 'CUSTOMER', isActive: true, assignedAgentId: 'agent-b' },
  // Sin asignar
  { id: 'c4', name: 'Cliente 4', role: 'CUSTOMER', isActive: true, assignedAgentId: null },
];

const ordersFixture: FixtureOrder[] = [
  // Producción histórica de A (Order.agentId = agent-a)
  { id: 'o1', orderNumber: 'PED-101', customerId: 'c1', agentId: 'agent-a', customerName: 'Cliente 1', status: 'recibido', requestType: 'pedido', subtotal: 100, createdAt: daysAgo(5) },
  { id: 'o2', orderNumber: 'PED-102', customerId: 'c2', agentId: 'agent-a', customerName: 'Cliente 2', status: 'solicitado', requestType: 'pedido', subtotal: 200, createdAt: daysAgo(10) },
  // Pedido de A sobre el cliente reasignado a B: el histórico sigue al dueño (agent-a)
  { id: 'o8', orderNumber: 'PED-108', customerId: 'c5', agentId: 'agent-a', customerName: 'Cliente reasignado', status: 'recibido', requestType: 'pedido', subtotal: 150, createdAt: daysAgo(4) },
  // Antiguo: fuera de 30d/90d/6m, dentro de "all"
  { id: 'o5', orderNumber: 'PED-105', customerId: 'c1', agentId: 'agent-a', customerName: 'Cliente 1', status: 'recibido', requestType: 'pedido', subtotal: 999, createdAt: monthsAgo(8) },
  { id: 'o3', orderNumber: 'COT-103', customerId: 'c1', agentId: 'agent-a', customerName: 'Cliente 1', status: 'compartido', requestType: 'cotizacion', subtotal: 50, createdAt: daysAgo(3) },
  { id: 'o4', orderNumber: 'COT-104', customerId: 'c2', agentId: 'agent-a', customerName: 'Cliente 2', status: 'solicitado', requestType: 'cotizacion', subtotal: 70, createdAt: daysAgo(15) },
  // Producción de B
  { id: 'o6', orderNumber: 'PED-106', customerId: 'c3', agentId: 'agent-b', customerName: 'Cliente 3', status: 'recibido', requestType: 'pedido', subtotal: 500, createdAt: daysAgo(2) },
  // Sin asesor
  { id: 'o7', orderNumber: 'PED-107', customerId: 'c4', agentId: null, customerName: 'Cliente 4', status: 'solicitado', requestType: 'pedido', subtotal: 300, createdAt: daysAgo(1) },
];

// ---------------------------------------------------------------------------
// Mock db que aplica de verdad los `where` recibidos
// ---------------------------------------------------------------------------

function matchesUser(user: FixtureUser, where: Record<string, any> = {}): boolean {
  if (where.id?.in && !where.id.in.includes(user.id)) return false;
  if (where.assignedAgentId !== undefined && user.assignedAgentId !== where.assignedAgentId) return false;
  if (where.isActive !== undefined && user.isActive !== where.isActive) return false;
  if (where.role !== undefined) {
    const expected = typeof where.role === 'string' ? where.role : where.role?.equals;
    if (expected !== undefined && user.role.toLowerCase() !== expected.toLowerCase()) return false;
  }
  return true;
}

function matchesOrder(order: FixtureOrder, where: Record<string, any> = {}): boolean {
  if (where.agentId !== undefined && order.agentId !== where.agentId) return false;
  if (where.requestType !== undefined && order.requestType !== where.requestType) return false;
  if (where.createdAt?.gte && order.createdAt < new Date(where.createdAt.gte)) return false;
  return true;
}

function monthStart(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function installDbMocks() {
  mockDb.user.count.mockImplementation(async ({ where }) =>
    usersFixture.filter((u) => matchesUser(u, where)).length
  );

  mockDb.user.findMany.mockImplementation(async ({ where } = {}) =>
    usersFixture.filter((u) => matchesUser(u, where))
  );

  mockDb.user.groupBy.mockImplementation(async ({ by, where }) => {
    const rows = usersFixture.filter((u) => matchesUser(u, where));
    const map = new Map<string, { assignedAgentId: string | null; _count: { _all: number } }>();
    for (const u of rows) {
      const existing = map.get(u.assignedAgentId ?? '(null)');
      if (existing) existing._count._all += 1;
      else map.set(u.assignedAgentId ?? '(null)', { assignedAgentId: u.assignedAgentId, _count: { _all: 1 } });
    }
    return Array.from(map.values()).map((row) => {
      const clean: Record<string, unknown> = {};
      for (const field of by) clean[field] = (row as Record<string, unknown>)[field];
      return { ...clean, _count: row._count };
    });
  });

  mockDb.order.aggregate.mockImplementation(async ({ where }) => {
    const rows = ordersFixture.filter((o) => matchesOrder(o, where));
    return {
      _count: { _all: rows.length },
      _sum: { subtotal: rows.reduce((sum, o) => sum + o.subtotal, 0) },
    };
  });

  mockDb.order.groupBy.mockImplementation(async ({ by, where }) => {
    const rows = ordersFixture.filter((o) => matchesOrder(o, where));
    const map = new Map<string, Record<string, unknown>>();
    for (const o of rows) {
      const key = by.map((field: string) => String((o as unknown as Record<string, unknown>)[field])).join('|');
      const existing = map.get(key) as { _count: { _all: number }; _sum: { subtotal: number } } | undefined;
      if (existing) {
        existing._count._all += 1;
        existing._sum.subtotal += o.subtotal;
      } else {
        const row: Record<string, unknown> = {};
        for (const field of by) row[field] = (o as unknown as Record<string, unknown>)[field];
        row._count = { _all: 1 };
        row._sum = { subtotal: o.subtotal };
        map.set(key, row);
      }
    }
    return Array.from(map.values());
  });

  mockDb.order.findMany.mockImplementation(async ({ where, take }: { where?: Record<string, any>; take?: number }) => {
    const rows = ordersFixture
      .filter((o) => matchesOrder(o, where))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return (take ? rows.slice(0, take) : rows).map((o) => ({
      id: o.id,
      orderNumber: o.orderNumber,
      customerName: o.customerName,
      status: o.status,
      requestType: o.requestType,
      subtotal: o.subtotal,
      createdAt: o.createdAt,
    }));
  });

  // $queryRaw recibe un Prisma.Sql {sql, values}. La capa de reporting
  // construye las condiciones en orden conocido: [agentId?, createdAt >= ?].
  mockDb.$queryRaw.mockImplementation(async (query: { sql: string; values: unknown[] }) => {
    const sql = query?.sql ?? '';
    const values = query?.values ?? [];
    const hasAgent = /"agentId"\s*=/.test(sql);
    const hasDate = /"createdAt"\s*>=/.test(sql);
    const agentId = hasAgent ? (values[0] as string | null) : null;
    const gte = hasDate ? new Date(values[values.length - 1] as Date) : null;

    const rows = ordersFixture.filter((o) => {
      if (agentId !== null && o.agentId !== agentId) return false;
      if (agentId === null && hasAgent && o.agentId !== null) return false;
      if (gte && o.createdAt < gte) return false;
      return true;
    });

    const map = new Map<string, { month: Date; requestType: string; count: number; total: number }>();
    for (const o of rows) {
      const key = `${monthStart(o.createdAt).toISOString()}|${o.requestType}`;
      const existing = map.get(key);
      if (existing) {
        existing.count += 1;
        existing.total += o.subtotal;
      } else {
        map.set(key, { month: monthStart(o.createdAt), requestType: o.requestType, count: 1, total: o.subtotal });
      }
    }
    return Array.from(map.values()).sort((a, b) => a.month.getTime() - b.month.getTime());
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.backofficeUser = null;
  installDbMocks();
});

// ---------------------------------------------------------------------------
// 1–6: aislamiento AGENT
// ---------------------------------------------------------------------------

describe('Reporting comercial — aislamiento AGENT', () => {
  it('1. AGENT A: la cartera actual se cuenta por assignedAgentId=self y NO incluye clientes de B ni sin asignar', async () => {
    const report = await buildCommercialReport(AGENT_A, { preset: 'all', asesorId: null });

    const countCalls = mockDb.user.count.mock.calls;
    expect(countCalls[0][0].where).toMatchObject({ role: 'CUSTOMER', assignedAgentId: 'agent-a' });

    expect(report.portfolio.customersCount).toBe(2); // c1, c2
    expect(report.portfolio.activeCustomersCount).toBe(1); // c1
  });

  it('2. AGENT A: la producción histórica se consulta por agentId=self y el reporte no contiene pedidos de B ni sin asesor', async () => {
    const report = await buildCommercialReport(AGENT_A, { preset: 'all', asesorId: null });

    for (const call of mockDb.order.aggregate.mock.calls) {
      expect(call[0].where).toMatchObject({ agentId: 'agent-a' });
    }
    expect(mockDb.order.findMany.mock.calls[0][0].where).toMatchObject({ agentId: 'agent-a' });

    // Producción A en "all": o1+o2+o5+o8 pedidos, o3+o4 cotizaciones.
    expect(report.orders.count).toBe(4);
    expect(report.quotes.count).toBe(2);
    const recentNumbers = report.recent.map((r) => r.orderNumber);
    expect(recentNumbers).not.toContain('PED-106'); // B
    expect(recentNumbers).not.toContain('PED-107'); // sin asesor
    expect(report.recent.every((r) => ordersFixture.find((o) => o.orderNumber === r.orderNumber)?.agentId === 'agent-a')).toBe(true);
  });

  it('3. pedidos y cotizaciones se cuentan y suman SIEMPRE separados (requestType)', async () => {
    const report = await buildCommercialReport(AGENT_A, { preset: 'all', asesorId: null });

    const pedidoCalls = mockDb.order.aggregate.mock.calls.filter(
      (call) => call[0].where?.requestType === 'pedido'
    );
    const cotizacionCalls = mockDb.order.aggregate.mock.calls.filter(
      (call) => call[0].where?.requestType === 'cotizacion'
    );
    expect(pedidoCalls).toHaveLength(1);
    expect(cotizacionCalls).toHaveLength(1);

    expect(report.orders).toEqual({ count: 4, total: 100 + 200 + 999 + 150 });
    expect(report.quotes).toEqual({ count: 2, total: 50 + 70 });
  });

  it('4. `?asesor=agent-b` NO amplía el alcance del AGENT A (todo sigue scoped a self)', async () => {
    const options = resolveReportingQuery(AGENT_A, { periodo: 'all', asesor: 'agent-b' });
    expect(options.asesorId).toBeNull();

    const report = await buildCommercialReport(AGENT_A, options);
    for (const call of mockDb.order.aggregate.mock.calls) {
      expect(call[0].where).toMatchObject({ agentId: 'agent-a' });
      expect(call[0].where.agentId).not.toBe('agent-b');
    }
    // La producción de B (o6) no aparece aunque la URL lo pida.
    expect(report.orders.count).toBe(4);
    expect(report.recent.map((r) => r.orderNumber)).not.toContain('PED-106');
  });

  it('5. `?agentId=agent-b` NO amplía el alcance del AGENT A (parámetro no canónico, nunca leído)', async () => {
    const options = resolveReportingQuery(AGENT_A, { periodo: 'all', agentId: 'agent-b' });
    expect(options.asesorId).toBeNull();

    const report = await buildCommercialReport(AGENT_A, options);
    for (const call of mockDb.order.aggregate.mock.calls) {
      expect(call[0].where).toMatchObject({ agentId: 'agent-a' });
    }
    expect(report.orders.count).toBe(4);
  });

  it('6. count/sum/groupBy/evolución/recent usan EXACTAMENTE el mismo scope self y el mismo periodo', async () => {
    await buildCommercialReport(AGENT_A, { preset: '30d', asesorId: null });

    // Producción Prisma: aggregates, groupBy y findMany con agent + gte.
    for (const call of mockDb.order.aggregate.mock.calls) {
      expect(call[0].where.agentId).toBe('agent-a');
      expect(call[0].where.createdAt?.gte).toBeInstanceOf(Date);
    }
    const groupByCall = mockDb.order.groupBy.mock.calls[0][0];
    expect(groupByCall.where).toMatchObject({ agentId: 'agent-a', createdAt: { gte: expect.any(Date) } });
    expect(mockDb.order.findMany.mock.calls[0][0].where).toMatchObject({
      agentId: 'agent-a',
      createdAt: { gte: expect.any(Date) },
    });

    // Serie mensual ($queryRaw): mismo agente y misma fecha de corte.
    const rawCall = mockDb.$queryRaw.mock.calls[0][0];
    expect(rawCall.values[0]).toBe('agent-a');
    expect(rawCall.values[rawCall.values.length - 1]).toBeInstanceOf(Date);

    // Cartera: assignedAgentId=self.
    expect(mockDb.user.count.mock.calls[0][0].where).toMatchObject({ assignedAgentId: 'agent-a' });
  });
});

// ---------------------------------------------------------------------------
// 7–9: reasignación, nombres de otros agentes, bucket Sin asesor
// ---------------------------------------------------------------------------

describe('Reporting comercial — semántica de reasignación y superficies ADMIN', () => {
  it('7. cliente reasignado: cartera actual por assignedAgentId, histórico por Order.agentId (no se recalcula)', async () => {
    // c5 fue reasignado a B pero su pedido o8 quedó creado bajo agent-a.
    const reportA = await buildCommercialReport(AGENT_A, { preset: 'all', asesorId: null });
    const reportB = await buildCommercialReport(AGENT_B, { preset: 'all', asesorId: null });

    // Cartera ACTUAL: c5 ya no cuenta para A (c1, c2) y sí para B (c3, c5).
    expect(reportA.portfolio.customersCount).toBe(2);
    expect(reportB.portfolio.customersCount).toBe(2);

    // Histórico: o8 sigue perteneciendo a A por Order.agentId.
    expect(reportA.orders.total).toBe(100 + 200 + 999 + 150);
    expect(reportB.orders.total).toBe(500);
  });

  it('8. AGENT: no recibe nombres ni opciones de otros agentes (la consulta de nombres ni se ejecuta)', async () => {
    const report = await buildCommercialReport(AGENT_A, { preset: 'all', asesorId: null });

    expect(report.agentOptions).toBeNull();
    // user.findMany sólo se usa para nombres del desglose y el selector de
    // asesor: superficies ADMIN. Para un AGENT no debe ejecutarse.
    expect(mockDb.user.findMany).not.toHaveBeenCalled();
  });

  it('9. AGENT: sin desglose por asesor ni bucket "Sin asesor"', async () => {
    const report = await buildCommercialReport(AGENT_A, { preset: 'all', asesorId: null });
    expect(report.perAgent).toBeNull();
    expect(report.scope).toBe('self');
  });
});

// ---------------------------------------------------------------------------
// 10–13: ADMIN/EDITOR
// ---------------------------------------------------------------------------

describe('Reporting comercial — ADMIN/EDITOR', () => {
  it('10. ADMIN global: producción sin filtro agentId y desglose por asesor presente', async () => {
    const report = await buildCommercialReport(ADMIN, { preset: 'all', asesorId: null });

    for (const call of mockDb.order.aggregate.mock.calls) {
      expect(call[0].where.agentId).toBeUndefined();
    }
    expect(mockDb.user.count.mock.calls[0][0].where).toEqual({ role: 'CUSTOMER' });
    expect(report.scope).toBe('global');

    // Totales globales: pedidos o1,o2,o5,o6,o7,o8 y cotizaciones o3,o4.
    expect(report.orders).toEqual({ count: 6, total: 100 + 200 + 999 + 500 + 300 + 150 });
    expect(report.quotes).toEqual({ count: 2, total: 120 });

    expect(report.perAgent).not.toBeNull();
    const ids = report.perAgent!.map((row) => row.agentId);
    expect(ids).toContain('agent-a');
    expect(ids).toContain('agent-b');
    // Orden: producción total descendente; "Sin asesor" al final.
    expect(ids[ids.length - 1]).toBeNull();
    const rowA = report.perAgent!.find((row) => row.agentId === 'agent-a')!;
    expect(rowA.agentName).toBe('Agente A');
    expect(rowA.ordersCount).toBe(4);
    expect(rowA.customersCount).toBe(2);
  });

  it('11. ADMIN filtrado por asesor: acota producción y cartera a ese asesor (sólo acota, nunca amplía)', async () => {
    const options = resolveReportingQuery(ADMIN, { periodo: 'all', asesor: 'agent-a' });
    expect(options.asesorId).toBe('agent-a');

    const report = await buildCommercialReport(ADMIN, options);
    for (const call of mockDb.order.aggregate.mock.calls) {
      expect(call[0].where).toMatchObject({ agentId: 'agent-a' });
    }
    expect(mockDb.user.count.mock.calls[0][0].where).toMatchObject({
      role: 'CUSTOMER',
      assignedAgentId: 'agent-a',
    });
    expect(report.scope).toBe('advisor');
    expect(report.orders.count).toBe(4);
    // Con filtro individual no hay comparativa entre asesores.
    expect(report.perAgent).toBeNull();
    // El selector sigue disponible para cambiar de asesor.
    expect(report.agentOptions).not.toBeNull();
    expect(report.agentOptions!.map((a) => a.id)).toEqual(['agent-a', 'agent-b']);
  });

  it('12. ADMIN: el bucket "Sin asesor" (agentId=null) aparece explícito, nunca descartado', async () => {
    const report = await buildCommercialReport(ADMIN, { preset: 'all', asesorId: null });
    const nullRow = report.perAgent!.find((row) => row.agentId === null);
    expect(nullRow).toBeDefined();
    expect(nullRow!.ordersCount).toBe(1); // o7
    expect(nullRow!.ordersTotal).toBe(300);
    expect(nullRow!.customersCount).toBe(1); // c4
  });

  it('13. EDITOR conserva la visión global completa', async () => {
    const report = await buildCommercialReport(EDITOR, { preset: 'all', asesorId: null });
    for (const call of mockDb.order.aggregate.mock.calls) {
      expect(call[0].where.agentId).toBeUndefined();
    }
    expect(report.scope).toBe('global');
    expect(report.perAgent).not.toBeNull();
    expect(report.agentOptions).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 14: acceso a la página
// ---------------------------------------------------------------------------

describe('Acceso a /admin/reportes', () => {
  it('14. CUSTOMER (y no autenticados) no pueden acceder: requireBackofficeUser falla y la página redirige', async () => {
    // El predicado real rechaza a CUSTOMER del backoffice.
    expect(isBackofficeRole(CUSTOMER_USER.role)).toBe(false);

    // La página, ante cualquier usuario sin rol backoffice (CUSTOMER incluido),
    // redirige a /admin/login antes de consultar nada.
    authState.backofficeUser = null;
    await expect(
      ReportesPage({ searchParams: Promise.resolve({ periodo: 'all' }) })
    ).rejects.toMatchObject({
      digest: expect.stringContaining('NEXT_REDIRECT'),
    });
    expect(mockDb.order.aggregate).not.toHaveBeenCalled();
    expect(mockDb.user.count).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 15: periodos sobre createdAt
// ---------------------------------------------------------------------------

describe('Reporting comercial — periodos sobre Order.createdAt', () => {
  it('15. el periodo filtra SOLO por createdAt (nunca updatedAt) y con preset válido', async () => {
    // Presets -> fecha de corte.
    expect(resolvePeriodStart('30d')).toBeInstanceOf(Date);
    expect(resolvePeriodStart('all')).toBeNull();

    // 30d: o5 (8 meses) queda fuera para AGENT A.
    const report30d = await buildCommercialReport(AGENT_A, { preset: '30d', asesorId: null });
    for (const call of mockDb.order.aggregate.mock.calls) {
      expect(call[0].where.createdAt?.gte).toBeInstanceOf(Date);
      expect(call[0].where.updatedAt).toBeUndefined();
    }
    expect(report30d.orders).toEqual({ count: 3, total: 100 + 200 + 150 });

    // La serie mensual también excluye o5.
    const monthlyOrders = report30d.monthly.reduce((sum, p) => sum + p.ordersCount, 0);
    expect(monthlyOrders).toBe(3);

    // "all": sin condición de fecha; o5 vuelve.
    mockDb.order.aggregate.mockClear();
    const reportAll = await buildCommercialReport(AGENT_A, { preset: 'all', asesorId: null });
    for (const call of mockDb.order.aggregate.mock.calls) {
      expect(call[0].where.createdAt).toBeUndefined();
    }
    expect(reportAll.orders.count).toBe(4);
  });

  it('preset inválido cae en el default y periodo `all` con array en searchParams también se normaliza', async () => {
    expect(resolveReportingQuery(AGENT_A, { periodo: 'bogus' })).toEqual({
      preset: '6m',
      asesorId: null,
    });
    expect(resolveReportingQuery(ADMIN, { periodo: ['all'] })).toEqual({
      preset: 'all',
      asesorId: null,
    });
  });
});
