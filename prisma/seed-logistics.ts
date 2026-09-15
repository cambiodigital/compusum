import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}



interface ShippingRouteData {
  name: string;
  estimatedDaysMin: number;
  estimatedDaysMax: number;
  shippingCompany: string;
  sortOrder: number;
  departureDaysOfWeek?: number[];
}

interface ShippingEntry {
  route: ShippingRouteData;
  department: { name: string; code: string };
  cities: string[];
}

const shippingData: ShippingEntry[] = [
  {
    route: { name: "Eje Cafetero (Local)", estimatedDaysMin: 1, estimatedDaysMax: 2, shippingCompany: "Servientrega", sortOrder: 1, departureDaysOfWeek: [1, 2, 3, 4, 5] },
    department: { name: "Risaralda", code: "RIS" },
    cities: ["Pereira", "Dosquebradas", "Santa Rosa de Cabal", "La Virginia"],
  },
  {
    route: { name: "Eje Cafetero (Local)", estimatedDaysMin: 1, estimatedDaysMax: 2, shippingCompany: "Servientrega", sortOrder: 1, departureDaysOfWeek: [1, 2, 3, 4, 5] },
    department: { name: "Quindío", code: "QUI" },
    cities: ["Armenia", "Calarcá", "Montenegro"],
  },
  {
    route: { name: "Eje Cafetero (Local)", estimatedDaysMin: 1, estimatedDaysMax: 2, shippingCompany: "Servientrega", sortOrder: 1, departureDaysOfWeek: [1, 2, 3, 4, 5] },
    department: { name: "Caldas", code: "CAL" },
    cities: ["Manizales", "Villamaría", "Chinchiná"],
  },
  {
    route: { name: "Norte del Valle", estimatedDaysMin: 2, estimatedDaysMax: 3, shippingCompany: "Servientrega", sortOrder: 2, departureDaysOfWeek: [1, 3, 5] },
    department: { name: "Valle del Cauca", code: "VAL" },
    cities: ["Cartago", "Tuluá", "Buga", "Zarzal", "Caicedonia"],
  },
  {
    route: { name: "Valle del Cauca", estimatedDaysMin: 2, estimatedDaysMax: 3, shippingCompany: "Envía", sortOrder: 3, departureDaysOfWeek: [2, 4] },
    department: { name: "Valle del Cauca", code: "VAL" },
    cities: ["Cali", "Palmira", "Buenaventura", "Yumbo", "Jamundí"],
  },
  {
    route: { name: "Antioquia", estimatedDaysMin: 3, estimatedDaysMax: 5, shippingCompany: "Inter Rapidísimo", sortOrder: 4, departureDaysOfWeek: [1, 3, 5] },
    department: { name: "Antioquia", code: "ANT" },
    cities: ["Medellín", "Envigado", "Itagüí", "Bello", "Sabaneta", "Rionegro"],
  },
  {
    route: { name: "Cundinamarca", estimatedDaysMin: 3, estimatedDaysMax: 5, shippingCompany: "Servientrega", sortOrder: 5, departureDaysOfWeek: [1, 2, 3, 4, 5] },
    department: { name: "Cundinamarca", code: "CUN" },
    cities: ["Bogotá", "Soacha", "Chía", "Zipaquirá", "Facatativá"],
  },
  {
    route: { name: "Costa Atlántica", estimatedDaysMin: 4, estimatedDaysMax: 6, shippingCompany: "Envía", sortOrder: 6, departureDaysOfWeek: [2, 4, 6] },
    department: { name: "Atlántico", code: "ATL" },
    cities: ["Barranquilla", "Soledad"],
  },
  {
    route: { name: "Costa Atlántica", estimatedDaysMin: 4, estimatedDaysMax: 6, shippingCompany: "Envía", sortOrder: 6, departureDaysOfWeek: [2, 4, 6] },
    department: { name: "Bolívar", code: "BOL" },
    cities: ["Cartagena"],
  },
  {
    route: { name: "Costa Atlántica", estimatedDaysMin: 4, estimatedDaysMax: 6, shippingCompany: "Envía", sortOrder: 6, departureDaysOfWeek: [2, 4, 6] },
    department: { name: "Magdalena", code: "MAG" },
    cities: ["Santa Marta"],
  },
  {
    route: { name: "Costa Atlántica", estimatedDaysMin: 4, estimatedDaysMax: 6, shippingCompany: "Envía", sortOrder: 6, departureDaysOfWeek: [2, 4, 6] },
    department: { name: "Córdoba", code: "COR" },
    cities: ["Montería"],
  },
  {
    route: { name: "Santanderes", estimatedDaysMin: 3, estimatedDaysMax: 5, shippingCompany: "Inter Rapidísimo", sortOrder: 7, departureDaysOfWeek: [1, 3, 5] },
    department: { name: "Santander", code: "SAN" },
    cities: ["Bucaramanga", "Floridablanca", "Piedecuesta"],
  },
  {
    route: { name: "Santanderes", estimatedDaysMin: 3, estimatedDaysMax: 5, shippingCompany: "Inter Rapidísimo", sortOrder: 7, departureDaysOfWeek: [1, 3, 5] },
    department: { name: "Norte de Santander", code: "NSA" },
    cities: ["Cúcuta"],
  },
  {
    route: { name: "Resto del País", estimatedDaysMin: 5, estimatedDaysMax: 8, shippingCompany: "Servientrega", sortOrder: 8, departureDaysOfWeek: [1, 4] },
    department: { name: "Meta", code: "MET" },
    cities: ["Villavicencio"],
  },
  {
    route: { name: "Resto del País", estimatedDaysMin: 5, estimatedDaysMax: 8, shippingCompany: "Servientrega", sortOrder: 8, departureDaysOfWeek: [1, 4] },
    department: { name: "Huila", code: "HUI" },
    cities: ["Neiva"],
  },
  {
    route: { name: "Resto del País", estimatedDaysMin: 5, estimatedDaysMax: 8, shippingCompany: "Servientrega", sortOrder: 8, departureDaysOfWeek: [1, 4] },
    department: { name: "Tolima", code: "TOL" },
    cities: ["Ibagué"],
  },
  {
    route: { name: "Resto del País", estimatedDaysMin: 5, estimatedDaysMax: 8, shippingCompany: "Servientrega", sortOrder: 8, departureDaysOfWeek: [1, 4] },
    department: { name: "Nariño", code: "NAR" },
    cities: ["Pasto"],
  },
];

/**
 * BOOTSTRAP NO DESTRUCTIVO (Fase 5B0)
 *
 * Este seed corre en CADA arranque del contenedor
 * (docker-entrypoint.sh → prisma/bootstrap.ts → bun run seed), así que su
 * único trabajo es COMPLETAR la configuración baseline que falte en una
 * instalación nueva. NUNCA debe sobrescribir configuración logística que el
 * administrador gestiona desde /admin/envios: un redeploy no puede revertir
 * cambios legítimos ni reintroducir reasignaciones que la Fase 5A ya evitó.
 *
 * Contrato por entidad:
 *   - ShippingRoute existente (por name) => se reutiliza su id, SIN writes.
 *   - Department    existente (por code) => se reutiliza, SIN writes.
 *   - City          existente (por slug) => se reutiliza, SIN writes.
 *
 * El principio es "existing = preserve", NO una lista de campos: cualquier
 * campo administrable —actual o futuro— queda intacto por construcción,
 * porque no se emite ningún UPDATE sobre filas existentes. Eso cubre
 * estimatedDaysMin/Max, shippingCompany, departureDaysOfWeek, sortOrder,
 * isActive, capacity, cutOffTime, departureDate y los campos que agregue la
 * Fase 5B sin tocar este archivo.
 */
export async function seedLogistics(prismaClient?: PrismaClient) {
  const db = prismaClient || prisma;
  console.log("🚚 Iniciando seed de logística (bootstrap no destructivo)...");

  // Rutas de envío: se busca por nombre y SÓLO se crea si falta.
  // ShippingRoute.name no tiene constraint UNIQUE, por lo que no admite
  // upsert/ON CONFLICT (ver "RIESGO DE CARRERA" al final del archivo).
  const routeCache: Record<string, string> = {};

  for (const entry of shippingData) {
    if (!routeCache[entry.route.name]) {
      const existingRoute = await db.shippingRoute.findFirst({
        where: { name: entry.route.name },
      });

      if (existingRoute) {
        // Ruta administrada desde /admin/envios: se reutiliza su id y no se
        // toca NINGUNA configuración (ni isActive ni los días de salida).
        routeCache[entry.route.name] = existingRoute.id;
        console.log(`  = Ruta existente (sin cambios): ${existingRoute.name}`);
        continue;
      }

      const route = await db.shippingRoute.create({
        data: {
          name: entry.route.name,
          estimatedDaysMin: entry.route.estimatedDaysMin,
          estimatedDaysMax: entry.route.estimatedDaysMax,
          shippingCompany: entry.route.shippingCompany,
          departureDaysOfWeek: entry.route.departureDaysOfWeek || [1, 2, 3, 4, 5],
          sortOrder: entry.route.sortOrder,
          isActive: true,
        },
      });

      routeCache[entry.route.name] = route.id;
      console.log(`  ✓ Ruta creada: ${route.name}`);
    }
  }

  // Crear departamentos y ciudades
  const deptCache: Record<string, string> = {};

  for (const entry of shippingData) {
    // `update: {}` es un no-op REAL: Prisma emite únicamente SELECTs sobre una
    // fila existente, sin UPDATE y sin tocar `updatedAt` (verificado). Por eso
    // se conservan name/isActive tal como los dejó el administrador.
    if (!deptCache[entry.department.code]) {
      const dept = await db.department.upsert({
        where: { code: entry.department.code },
        update: {},
        create: {
          name: entry.department.name,
          code: entry.department.code,
          isActive: true,
        },
      });
      deptCache[entry.department.code] = dept.id;
      console.log(`  ✓ Departamento: ${dept.name}`);
    }

    const routeId = routeCache[entry.route.name];
    const departmentId = deptCache[entry.department.code];

    // Crear ciudades
    for (const cityName of entry.cities) {
      const slug = slugify(cityName);
      // `update: {}` => una ciudad existente conserva name, departmentId,
      // shippingRouteId e isActive. El seed NUNCA mueve una ciudad de
      // departamento, le cambia la ruta ni la reactiva: esa reasignación
      // destructiva es la que la Fase 5A evitó en /admin/envios y que un
      // redeploy podía reintroducir.
      await db.city.upsert({
        where: { slug },
        update: {},
        create: {
          name: cityName,
          slug,
          departmentId,
          shippingRouteId: routeId,
          isActive: true,
        },
      });
      console.log(`    - ${cityName}`);
    }
  }

  console.log("\n✅ Seed de logística completado");
}

/**
 * RIESGO DE CARRERA (preexistente, documentado en Fase 5B0 — NO corregido aquí)
 *
 * `ShippingRoute.name` no tiene constraint UNIQUE en el schema ni en ninguna
 * migración. Dos seeds concurrentes (p. ej. dos réplicas del contenedor
 * arrancando a la vez) pueden ambos hacer `findFirst` → null y ambos hacer
 * `create`, dejando DOS rutas con el mismo nombre. Este comportamiento es
 * idéntico al que ya existía antes de 5B0 (mismo `findFirst` + `create`), por
 * lo que no es una regresión de este cambio.
 *
 * No se corrige en 5B0 porque la única solución real es un índice
 * `UNIQUE(name)` con su migración, y el alcance de esta fase excluye cambios
 * de schema y migraciones. Mientras no exista ese índice no se puede usar
 * `upsert`/`ON CONFLICT` para esta tabla.
 *
 * En `Department.code` y `City.slug` la unicidad SÍ está garantizada por la
 * base, así que una carrera equivalente fallaría de forma ruidosa con P2002 en
 * vez de duplicar datos (la carrera entre el SELECT y el INSERT del upsert es
 * un comportamiento conocido de Prisma).
 */

if (import.meta.main) {
  seedLogistics()
    .catch((e) => {
      console.error("❌ Error en seed de logística:", e);
      process.exit(1);
    })
    .finally(async () => {
      await prisma.$disconnect();
    });
}

