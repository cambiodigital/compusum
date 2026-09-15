import { db } from "./db";
import type { City, ShippingRoute } from "@prisma/client";

/**
 * FUENTE ÚNICA ciudad → ruta (Fase 5A) — sin cambios de modelo.
 *
 * Reglas de integridad que unifica este helper:
 *   - La ciudad debe EXISTIR y estar ACTIVA para poder asignarse.
 *   - La ruta procede EXCLUSIVAMENTE de la relación server-side
 *     City.shippingRouteId (el navegador nunca propone routeId).
 *   - Una ruta inactiva NO se asigna (ruta efectiva = null).
 *   - El corte absoluto (cutOffTime) se respeta con la lógica actual;
 *     su reemplazo por un cutoff recurrente es Fase 5B y vive aquí y
 *     solo aquí: cambiar el modelo no debe requerir tocar llamadores.
 *
 * Consumers: checkout (order-create), edición de pedido (order-edit),
 * mutaciones de carrito (cart-mutations) y PATCH admin de pedidos.
 */

export class CityResolutionError extends Error {
  status: number;

  constructor(message: string, status = 400) {
    super(message);
    this.name = "CityResolutionError";
    this.status = status;
  }
}

/**
 * Clasificación canónica tri-state de `cityId` en bodies de mutación:
 *
 *   undefined            → "omit"  (NO cambiar la ciudad existente)
 *   null | "" (vacío)    → "clear" (limpiar explícitamente)
 *   string no vacío      → "set"   (validar server-side y fijar)
 *   cualquier otro tipo  → CityResolutionError 400 (nunca P2003 → 500)
 */
export type CityIdMutation =
  | { action: "omit" }
  | { action: "clear" }
  | { action: "set"; cityId: string };

export function parseCityIdMutation(value: unknown): CityIdMutation {
  if (value === undefined) return { action: "omit" };
  if (value === null) return { action: "clear" };
  if (typeof value === "string") {
    const trimmed = value.trim().slice(0, 64);
    return trimmed ? { action: "set", cityId: trimmed } : { action: "clear" };
  }
  throw new CityResolutionError("Formato de ciudad inválido");
}

type DbClient = typeof db | { city: typeof db.city };

/**
 * Resuelve { city, route } desde un cityId YA clasificado como "set".
 *
 * Falla con CityResolutionError (400) si la ciudad no existe o está
 * inactiva. La ruta sale de la relación de la ciudad: null si no hay,
 * si está inactiva o si el corte actual (timestamp absoluto, Fase 5B)
 * ya pasó. El llamador decide qué hacer con ruta null (Order.routeId
 * null NO es error: es "sin ruta programada").
 */
export async function resolveShippingRouteForCity(
  cityId: string,
  client: DbClient = db,
  now: Date = new Date()
): Promise<{ city: City; route: ShippingRoute | null }> {
  const city = await client.city.findUnique({
    where: { id: cityId },
    include: { shippingRoute: true },
  });

  if (!city || !city.isActive) {
    throw new CityResolutionError("Ciudad no válida");
  }

  const route = city.shippingRoute;
  if (!route || !route.isActive) {
    return { city, route: null };
  }

  // Lógica de corte ACTUAL preservada (timestamp absoluto): se mantiene
  // idéntica a la que usaba findBestRouteForCity. Fase 5B la reemplaza
  // por un cutoff recurrente SIN cambiar la firma de este helper.
  if (route.cutOffTime && new Date(route.cutOffTime) <= now) {
    return { city, route: null };
  }

  return { city, route };
}

// =====================
// ALTA ADMINISTRATIVA DE CIUDADES (Fase 5A)
// =====================

export interface CityUpsertPlanInput {
  /** Slug YA normalizado por el llamador (p.ej. slugify(name)). */
  slug: string;
  name: string;
  departmentId: string;
  shippingRouteId: string | null;
}

export type CityUpsertPlan =
  | { action: "create"; name: string; slug: string; departmentId: string; shippingRouteId: string | null }
  | { action: "update"; cityId: string }
  | { action: "conflict"; cityId: string; existingDepartmentId: string };

/**
 * Planifica el alta/edición de una ciudad por slug SIN pérdida destructiva:
 *
 *   - slug libre                          => "create"
 *   - slug ocupado en el MISMO departamento => "update" (semántica histórica
 *     compatible: renombra/reasigna ruta/reactiva la misma fila)
 *   - slug ocupado en OTRO departamento    => "conflict": el admin creó una
 *     ciudad homónima en otro departamento; NUNCA se reasigna la fila
 *     existente (antes el upsert por slug la MOVERÍA de departamento y
 *     perdería su ruta en silencio).
 */
export async function planCityUpsert(
  input: CityUpsertPlanInput,
  client: DbClient = db
): Promise<CityUpsertPlan> {
  const existing = await client.city.findUnique({
    where: { slug: input.slug },
    select: { id: true, departmentId: true },
  });

  if (!existing) {
    return {
      action: "create",
      name: input.name,
      slug: input.slug,
      departmentId: input.departmentId,
      shippingRouteId: input.shippingRouteId,
    };
  }

  if (existing.departmentId === input.departmentId) {
    return { action: "update", cityId: existing.id };
  }

  return { action: "conflict", cityId: existing.id, existingDepartmentId: existing.departmentId };
}
