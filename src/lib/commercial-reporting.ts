import { Prisma } from "@prisma/client";
import { db } from "./db";
import { listActiveAgents } from "./customers-admin";
import {
  isAgentRole,
  isAdminRole,
  scopeCustomersForRole,
  scopeOrdersForRole,
} from "./roles";

/**
 * REPORTING COMERCIAL POR ASESOR (Fase 4C) — consultas de sólo lectura.
 *
 * Semántica de alcance (server-side, no negociable):
 * - Cartera actual: `User.assignedAgentId` (estado vigente del maestro).
 * - Producción histórica: `Order.agentId` (snapshot del asesor dueño al
 *   momento de crear el pedido). NUNCA se recalcula el histórico mediante el
 *   asesor hoy asignado del cliente.
 * - AGENT: ambos alcances se fuerzan a self con los helpers probados de
 *   `roles.ts` (scopeOrdersForRole / scopeCustomersForRole). Ningún
 *   parámetro de la URL (`asesor`, `agentId`, ...) puede ampliarlos.
 * - ADMIN/EDITOR: visión global; el filtro `?asesor=` sólo ACOTA. El bucket
 *   `agentId = null` ("Sin asesor") es visible únicamente para ellos.
 *
 * `pedido` y `cotizacion` se cuentan SIEMPRE por separado (`requestType`).
 * La fecha comercial de toda métrica de producción es `Order.createdAt`;
 * `updatedAt` nunca se usa como fecha comercial.
 */

export type ReportingPeriodPreset = "30d" | "90d" | "6m" | "all";

export const REPORTING_PERIOD_PRESETS: ReportingPeriodPreset[] = [
  "30d",
  "90d",
  "6m",
  "all",
];

export const DEFAULT_REPORTING_PERIOD: ReportingPeriodPreset = "6m";

export interface ReportingViewer {
  id: string;
  role: string;
}

export interface ReportingQueryOptions {
  preset: ReportingPeriodPreset;
  /** Sólo ADMIN/EDITOR: asesor que acota la visión. null = global. */
  asesorId: string | null;
}

export interface MonthlyActivityPoint {
  /** "YYYY-MM" (mes de creación del pedido/cotización). */
  month: string;
  ordersCount: number;
  ordersTotal: number;
  quotesCount: number;
  quotesTotal: number;
}

export interface RecentCommercialActivity {
  id: string;
  orderNumber: string;
  customerName: string | null;
  status: string;
  requestType: string;
  subtotal: number;
  createdAt: Date;
}

export interface AgentProductionRow {
  /** null => bucket "Sin asesor" (sólo ADMIN/EDITOR). */
  agentId: string | null;
  agentName: string | null;
  customersCount: number;
  ordersCount: number;
  ordersTotal: number;
  quotesCount: number;
  quotesTotal: number;
}

export interface ReportingAgentOption {
  id: string;
  name: string;
}

export interface CommercialReport {
  /** "self" (AGENT) | "global" | "advisor" (ADMIN/EDITOR con ?asesor=). */
  scope: "self" | "global" | "advisor";
  preset: ReportingPeriodPreset;
  periodFrom: Date | null;
  portfolio: {
    customersCount: number;
    activeCustomersCount: number;
  };
  orders: { count: number; total: number };
  quotes: { count: number; total: number };
  statusBreakdown: { status: string; requestType: string; count: number }[];
  monthly: MonthlyActivityPoint[];
  recent: RecentCommercialActivity[];
  /** Desglose comparativo por asesor. null para AGENT y para ADMIN con filtro individual. */
  perAgent: AgentProductionRow[] | null;
  /** Opciones del selector de asesor. null para AGENT (nunca recibe nombres de otros agentes). */
  agentOptions: ReportingAgentOption[] | null;
}

export function resolveReportingPeriodPreset(
  raw: string | undefined
): ReportingPeriodPreset {
  return REPORTING_PERIOD_PRESETS.includes(raw as ReportingPeriodPreset)
    ? (raw as ReportingPeriodPreset)
    : DEFAULT_REPORTING_PERIOD;
}

/** Fecha de inicio del periodo (sobre `Order.createdAt`); null = todo. */
export function resolvePeriodStart(
  preset: ReportingPeriodPreset
): Date | null {
  switch (preset) {
    case "30d": {
      const from = new Date();
      from.setDate(from.getDate() - 30);
      return from;
    }
    case "90d": {
      const from = new Date();
      from.setDate(from.getDate() - 90);
      return from;
    }
    case "6m": {
      const from = new Date();
      from.setMonth(from.getMonth() - 6);
      return from;
    }
    case "all":
      return null;
  }
}

/**
 * Resuelve las opciones del reporte desde los search params de la URL.
 * El parámetro `asesor` sólo se honra para ADMIN/EDITOR (y sólo puede
 * acotar). `agentId` nunca se lee: el único nombre canónico es `asesor`.
 * Para un AGENT el resultado es SIEMPRE { preset, asesorId: null } y el
 * alcance self lo imponen las consultas, no la URL.
 */
export function resolveReportingQuery(
  viewer: ReportingViewer,
  params: Record<string, string | string[] | undefined>
): ReportingQueryOptions {
  const first = (value: string | string[] | undefined): string | undefined =>
    Array.isArray(value) ? value[0] : value;

  const preset = resolveReportingPeriodPreset(first(params.periodo));
  const rawAsesor = first(params.asesor)?.trim() || "";
  const asesorId =
    isAdminRole(viewer.role) && !isAgentRole(viewer.role) && rawAsesor
      ? rawAsesor
      : null;

  return { preset, asesorId };
}

interface MonthlyRow {
  month: Date;
  requestType: string;
  count: number;
  total: number;
}

function buildMonthlySeries(rows: MonthlyRow[]): MonthlyActivityPoint[] {
  const byMonth = new Map<string, MonthlyActivityPoint>();
  for (const row of rows) {
    const key = new Date(row.month).toISOString().slice(0, 7);
    const point =
      byMonth.get(key) ??
      {
        month: key,
        ordersCount: 0,
        ordersTotal: 0,
        quotesCount: 0,
        quotesTotal: 0,
      };
    if (row.requestType === "cotizacion") {
      point.quotesCount += row.count;
      point.quotesTotal += row.total;
    } else {
      point.ordersCount += row.count;
      point.ordersTotal += row.total;
    }
    byMonth.set(key, point);
  }
  return Array.from(byMonth.values()).sort((a, b) =>
    a.month.localeCompare(b.month)
  );
}

const STATUS_ORDER = ["solicitado", "compartido", "recibido"];

function sortStatusBreakdown(
  rows: { status: string; requestType: string; count: number }[]
): { status: string; requestType: string; count: number }[] {
  return [...rows].sort((a, b) => {
    const statusDiff =
      (STATUS_ORDER.indexOf(a.status) + 1 || STATUS_ORDER.length + 1) -
      (STATUS_ORDER.indexOf(b.status) + 1 || STATUS_ORDER.length + 1);
    if (statusDiff !== 0) return statusDiff;
    return a.requestType.localeCompare(b.requestType);
  });
}

/**
 * Construye el reporte comercial completo. Todo el acceso a datos pasa por
 * aquí: la página NO consulta la base de datos por su cuenta, de modo que el
 * scoping de esta función es el único wiring que existe.
 */
export async function buildCommercialReport(
  viewer: ReportingViewer,
  options: ReportingQueryOptions
): Promise<CommercialReport> {
  const agent = isAgentRole(viewer.role);

  // Alcance de producción. AGENT => self (fail-closed vía helper probado);
  // ADMIN/EDITOR => global o acotado por ?asesor=.
  let ordersWhere: Record<string, unknown> = scopeOrdersForRole({}, viewer);
  let customersWhere: Record<string, unknown> = scopeCustomersForRole(
    { role: "CUSTOMER" },
    viewer
  );
  if (!agent && isAdminRole(viewer.role) && options.asesorId) {
    ordersWhere = { ...ordersWhere, agentId: options.asesorId };
    customersWhere = { ...customersWhere, assignedAgentId: options.asesorId };
  }

  // Misma decisión de alcance para la serie mensual ($queryRaw): la consulta
  // cruda recorre exactamente el mismo subconjunto que las consultas Prisma.
  const productionAgentId = agent ? viewer.id : options.asesorId ?? null;

  const periodFrom = resolvePeriodStart(options.preset);
  const periodCond = periodFrom ? { createdAt: { gte: periodFrom } } : {};
  const productionWhere = { ...ordersWhere, ...periodCond };

  const activeCustomersWhere = { ...customersWhere, isActive: true };

  const monthlyConditions: Prisma.Sql[] = [];
  if (productionAgentId) {
    monthlyConditions.push(Prisma.sql`"agentId" = ${productionAgentId}`);
  }
  if (periodFrom) {
    monthlyConditions.push(Prisma.sql`"createdAt" >= ${periodFrom}`);
  }
  const monthlyWhereSql = monthlyConditions.length
    ? Prisma.sql` WHERE ${Prisma.join(monthlyConditions, " AND ")}`
    : Prisma.empty;

  const [
    customersCount,
    activeCustomersCount,
    ordersAggregate,
    quotesAggregate,
    statusStats,
    recentOrders,
    monthlyRows,
  ] = await Promise.all([
    db.user.count({ where: customersWhere }),
    db.user.count({ where: activeCustomersWhere }),
    db.order.aggregate({
      where: { ...productionWhere, requestType: "pedido" },
      _count: { _all: true },
      _sum: { subtotal: true },
    }),
    db.order.aggregate({
      where: { ...productionWhere, requestType: "cotizacion" },
      _count: { _all: true },
      _sum: { subtotal: true },
    }),
    db.order.groupBy({
      by: ["status", "requestType"],
      where: productionWhere,
      _count: { _all: true },
    }),
    db.order.findMany({
      where: productionWhere,
      orderBy: { createdAt: "desc" },
      take: 10,
      select: {
        id: true,
        orderNumber: true,
        customerName: true,
        status: true,
        requestType: true,
        subtotal: true,
        createdAt: true,
      },
    }),
    db.$queryRaw<MonthlyRow[]>(Prisma.sql`
      SELECT date_trunc('month', "createdAt") AS month,
             "requestType",
             count(*)::int AS count,
             COALESCE(sum("subtotal"), 0)::float8 AS total
      FROM "Order"${monthlyWhereSql}
      GROUP BY 1, 2
      ORDER BY 1
    `),
  ]);

  // Desglose comparativo por asesor y opciones de filtro: superficies
  // exclusivas de ADMIN/EDITOR (sin filtro individual). Para un AGENT estas
  // consultas ni siquiera se ejecutan: no puede recibir nombres de otros
  // agentes, rankings ni el bucket "Sin asesor".
  let perAgent: AgentProductionRow[] | null = null;
  let agentOptions: ReportingAgentOption[] | null = null;

  if (!agent && isAdminRole(viewer.role)) {
    agentOptions = (await listActiveAgents()).map((a) => ({
      id: a.id,
      name: a.name,
    }));

    if (!options.asesorId) {
      const [productionByAgent, portfolioByAgent] = await Promise.all([
        db.order.groupBy({
          by: ["agentId", "requestType"],
          where: periodCond,
          _count: { _all: true },
          _sum: { subtotal: true },
        }),
        db.user.groupBy({
          by: ["assignedAgentId"],
          where: { role: "CUSTOMER" },
          _count: { _all: true },
        }),
      ]);

      const agentIds = new Set<string>();
      for (const row of productionByAgent) {
        if (row.agentId) agentIds.add(row.agentId);
      }
      const nameRows = agentIds.size
        ? await db.user.findMany({
            where: { id: { in: Array.from(agentIds) } },
            select: { id: true, name: true },
          })
        : [];
      const namesById = new Map(nameRows.map((u) => [u.id, u.name]));

      const rowsByKey = new Map<string, AgentProductionRow>();
      const rowFor = (agentId: string | null): AgentProductionRow => {
        const key = agentId ?? "(sin asesor)";
        let row = rowsByKey.get(key);
        if (!row) {
          row = {
            agentId,
            agentName: agentId ? namesById.get(agentId) ?? null : null,
            customersCount: 0,
            ordersCount: 0,
            ordersTotal: 0,
            quotesCount: 0,
            quotesTotal: 0,
          };
          rowsByKey.set(key, row);
        }
        return row;
      };

      for (const row of productionByAgent) {
        const target = rowFor(row.agentId);
        const count = row._count._all;
        const total = row._sum.subtotal ?? 0;
        if (row.requestType === "cotizacion") {
          target.quotesCount += count;
          target.quotesTotal += total;
        } else {
          target.ordersCount += count;
          target.ordersTotal += total;
        }
      }
      for (const row of portfolioByAgent) {
        rowFor(row.assignedAgentId).customersCount += row._count._all;
      }

      // Producción total del periodo descendente; "Sin asesor" (null) queda
      // como fila explícita, nunca se descarta silenciosamente.
      perAgent = Array.from(rowsByKey.values()).sort((a, b) => {
        if ((a.agentId === null) !== (b.agentId === null)) {
          return a.agentId === null ? 1 : -1;
        }
        return (
          b.ordersTotal +
          b.quotesTotal -
          (a.ordersTotal + a.quotesTotal)
        );
      });
    }
  }

  return {
    scope: agent ? "self" : options.asesorId ? "advisor" : "global",
    preset: options.preset,
    periodFrom,
    portfolio: {
      customersCount,
      activeCustomersCount,
    },
    orders: {
      count: ordersAggregate._count._all ?? 0,
      total: ordersAggregate._sum.subtotal ?? 0,
    },
    quotes: {
      count: quotesAggregate._count._all ?? 0,
      total: quotesAggregate._sum.subtotal ?? 0,
    },
    statusBreakdown: sortStatusBreakdown(
      statusStats.map((s) => ({
        status: s.status,
        requestType: s.requestType,
        count: s._count._all,
      }))
    ),
    monthly: buildMonthlySeries(monthlyRows),
    recent: recentOrders,
    perAgent,
    agentOptions,
  };
}
