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

export async function seedLogistics(prismaClient?: PrismaClient) {
  const db = prismaClient || prisma;
  console.log("🚚 Iniciando seed de logística...");

  // Crear rutas de envío (upsert por nombre)
  const routeCache: Record<string, string> = {};

  for (const entry of shippingData) {
    if (!routeCache[entry.route.name]) {
      const existingRoute = await db.shippingRoute.findFirst({
        where: { name: entry.route.name },
      });

      const route = existingRoute
        ? await db.shippingRoute.update({
            where: { id: existingRoute.id },
            data: {
              estimatedDaysMin: entry.route.estimatedDaysMin,
              estimatedDaysMax: entry.route.estimatedDaysMax,
              shippingCompany: entry.route.shippingCompany,
              departureDaysOfWeek: entry.route.departureDaysOfWeek || [1, 2, 3, 4, 5],
              sortOrder: entry.route.sortOrder,
              isActive: true,
            },
          })
        : await db.shippingRoute.create({
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
      console.log(`  ✓ Ruta: ${route.name}`);
    }
  }

  // Crear departamentos y ciudades
  const deptCache: Record<string, string> = {};

  for (const entry of shippingData) {
    // Upsert department
    if (!deptCache[entry.department.code]) {
      const dept = await db.department.upsert({
        where: { code: entry.department.code },
        update: { name: entry.department.name, isActive: true },
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
      await db.city.upsert({
        where: { slug },
        update: {
          name: cityName,
          departmentId,
          shippingRouteId: routeId,
          isActive: true,
        },
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

