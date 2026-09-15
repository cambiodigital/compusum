import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { seedLogistics } from '../../prisma/seed-logistics';

/**
 * FASE 5B0 — SEED LOGÍSTICO NO DESTRUCTIVO contra PostgreSQL REAL.
 *
 * El seed corre en CADA arranque del contenedor
 * (docker-entrypoint.sh → prisma/bootstrap.ts → bun run seed), así que no
 * puede sobrescribir configuración administrada desde /admin/envios. Estos
 * tests son la red de seguridad de ese contrato:
 *
 *   A) instalación nueva        => la baseline que falta SE CREA.
 *   B) ShippingRoute customizada => NINGÚN campo administrable cambia.
 *   C) Department customizado    => name/isActive intactos.
 *   D) City customizada          => name/departmentId/shippingRouteId/
 *                                   isActive intactos (no reasignación
 *                                   destructiva que la Fase 5A ya evitó).
 *   E) idempotencia              => segunda corrida no escribe ni duplica.
 *
 * Corre sobre una BASE DE DATOS RASCANTE propia (no toca la BD de tests ni
 * depende de su estado), así que el caso A es una instalación realmente
 * nueva. Si no hay PostgreSQL se omite explícitamente.
 */

const HAS_POSTGRES = Boolean(process.env.DATABASE_URL?.startsWith('postgres'));

const SCRATCH_DB = 'compusum_seedtest_5b0';

const repoRoot = path.resolve(__dirname, '..', '..');

function serverUrl(): string {
  return process.env.DATABASE_URL!;
}

function scratchUrl(): string {
  const u = new URL(serverUrl());
  u.pathname = `/${SCRATCH_DB}`;
  return u.toString();
}

/** Ejecuta SQL suelto contra `url` (mismo motor que usa migrate deploy). */
function dbExecute(label: string, sql: string, url: string): void {
  const dir = path.join(os.tmpdir(), 'compusum-seedtest');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${label.replace(/[^a-z0-9-]/gi, '_')}.sql`);
  writeFileSync(file, sql, 'utf8');
  try {
    const res = spawnSync(
      'bun',
      ['x', 'prisma', 'db', 'execute', '--file', file, '--url', url],
      // shell:true: en Windows `bun` instalado por npm es un shim .cmd que
      // Node no puede spawnear directo. Los argumentos no contienen espacios.
      { encoding: 'utf8', cwd: repoRoot, env: process.env, shell: process.platform === 'win32' }
    );
    if (res.status !== 0) {
      throw new Error(
        `prisma db execute falló (${label}):\nstdout: ${res.stdout}\nstderr: ${res.stderr}`
      );
    }
  } finally {
    rmSync(file, { force: true });
  }
}

/** Aplica TODAS las migraciones a la BD rascante, igual que `migrate deploy`. */
function migrateScratch(): void {
  const res = spawnSync('bun', ['x', 'prisma', 'migrate', 'deploy'], {
    encoding: 'utf8',
    cwd: repoRoot,
    env: { ...process.env, DATABASE_URL: scratchUrl() },
    shell: process.platform === 'win32',
  });
  if (res.status !== 0) {
    throw new Error(
      `prisma migrate deploy falló en la BD rascante:\nstdout: ${res.stdout}\nstderr: ${res.stderr}`
    );
  }
}

// =====================
// BASELINE DEL SEED (contrato explícito)
// Si el seed cambia su baseline, estas expectativas deben actualizarse a
// propósito — no son un detalle de implementación.
// =====================
const BASELINE_ROUTE_NAMES = [
  'Eje Cafetero (Local)',
  'Norte del Valle',
  'Valle del Cauca',
  'Antioquia',
  'Cundinamarca',
  'Costa Atlántica',
  'Santanderes',
  'Resto del País',
];
const BASELINE_DEPARTMENT_CODES = [
  'RIS', 'QUI', 'CAL', 'VAL', 'ANT', 'CUN', 'ATL', 'BOL',
  'MAG', 'COR', 'SAN', 'NSA', 'MET', 'HUI', 'TOL', 'NAR',
];
const BASELINE_CITY_COUNT = 44;

const ROUTE_UNDER_TEST = 'Eje Cafetero (Local)';
const DEPARTMENT_UNDER_TEST = 'RIS';
const CITY_SLUG_UNDER_TEST = 'pereira';

describe.skipIf(!HAS_POSTGRES)('SEED LOGÍSTICO NO DESTRUCTIVO (Fase 5B0)', () => {
  let scratch: PrismaClient;

  beforeAll(() => {
    if (!HAS_POSTGRES) return;

    // 0) BD rascante limpia => instalación NUEVA para el caso A
    dbExecute('drop-scratch', `DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE);`, serverUrl());
    dbExecute('create-scratch', `CREATE DATABASE "${SCRATCH_DB}";`, serverUrl());

    // 1) Esquema completo, cero datos logísticos
    migrateScratch();

    scratch = new PrismaClient({ datasources: { db: { url: scratchUrl() } } });
  }, 600000);

  afterAll(async () => {
    if (!HAS_POSTGRES) return;
    await scratch?.$disconnect();
    dbExecute('drop-scratch-final', `DROP DATABASE IF EXISTS "${SCRATCH_DB}" WITH (FORCE);`, serverUrl());
  }, 120000);

  // ---------------------------------------------------------------- CASO A
  it('A) instalación nueva: crea la baseline que falta', async () => {
    const before = {
      routes: await scratch.shippingRoute.count(),
      departments: await scratch.department.count(),
      cities: await scratch.city.count(),
    };
    expect(before).toEqual({ routes: 0, departments: 0, cities: 0 });

    await seedLogistics(scratch);

    const routes = await scratch.shippingRoute.findMany({ orderBy: { name: 'asc' } });
    const departments = await scratch.department.findMany();
    const cities = await scratch.city.findMany();

    expect(routes.map((r) => r.name).sort()).toEqual([...BASELINE_ROUTE_NAMES].sort());
    expect(departments.map((d) => d.code).sort()).toEqual([...BASELINE_DEPARTMENT_CODES].sort());
    expect(cities).toHaveLength(BASELINE_CITY_COUNT);

    // Los valores baseline se escriben SÓLO al crear.
    const eje = routes.find((r) => r.name === ROUTE_UNDER_TEST)!;
    expect(eje.estimatedDaysMin).toBe(1);
    expect(eje.estimatedDaysMax).toBe(2);
    expect(eje.shippingCompany).toBe('Servientrega');
    expect(eje.sortOrder).toBe(1);
    expect(eje.isActive).toBe(true);
    expect(eje.departureDaysOfWeek).toEqual([1, 2, 3, 4, 5]);

    const ris = departments.find((d) => d.code === DEPARTMENT_UNDER_TEST)!;
    expect(ris.name).toBe('Risaralda');
    expect(ris.isActive).toBe(true);

    // La ciudad nueva queda ligada a su departamento y ruta baseline.
    const pereira = cities.find((c) => c.slug === CITY_SLUG_UNDER_TEST)!;
    expect(pereira.name).toBe('Pereira');
    expect(pereira.departmentId).toBe(ris.id);
    expect(pereira.shippingRouteId).toBe(eje.id);
    expect(pereira.isActive).toBe(true);
  });

  // ---------------------------------------------------------------- CASO B
  it('B) ShippingRoute existente: NINGUNA configuración administrable cambia', async () => {
    const route = await scratch.shippingRoute.findFirstOrThrow({
      where: { name: ROUTE_UNDER_TEST },
    });

    // Valores deliberadamente distintos a la baseline del seed.
    const custom = {
      estimatedDaysMin: 9,
      estimatedDaysMax: 99,
      shippingCompany: 'Transportadora Custom',
      departureDaysOfWeek: [6],
      sortOrder: 77,
      isActive: false,
      capacity: 42,
      cutOffTime: new Date('2026-03-25T14:00:00.000Z'),
      departureDate: new Date('2026-03-31T00:00:00.000Z'),
    };
    await scratch.shippingRoute.update({ where: { id: route.id }, data: custom });

    await seedLogistics(scratch);

    const after = await scratch.shippingRoute.findUniqueOrThrow({ where: { id: route.id } });

    // Se reutiliza la MISMA fila (no se crea una segunda con el mismo nombre).
    expect(
      await scratch.shippingRoute.count({ where: { name: ROUTE_UNDER_TEST } })
    ).toBe(1);

    expect(after.estimatedDaysMin).toBe(custom.estimatedDaysMin);
    expect(after.estimatedDaysMax).toBe(custom.estimatedDaysMax);
    expect(after.shippingCompany).toBe(custom.shippingCompany);
    expect(after.departureDaysOfWeek).toEqual(custom.departureDaysOfWeek);
    expect(after.sortOrder).toBe(custom.sortOrder);
    expect(after.isActive).toBe(custom.isActive);
    expect(after.capacity).toBe(custom.capacity);
    // `departureDate` es legacy pero tampoco puede ser tocado por el seed.
    expect(after.cutOffTime?.toISOString()).toBe(custom.cutOffTime.toISOString());
    expect(after.departureDate?.toISOString()).toBe(custom.departureDate.toISOString());
  });

  // ---------------------------------------------------------------- CASO C
  it('C) Department existente: no se renombra ni se reactiva', async () => {
    await scratch.department.update({
      where: { code: DEPARTMENT_UNDER_TEST },
      data: { name: 'Risaralda Custom', isActive: false },
    });

    await seedLogistics(scratch);

    const after = await scratch.department.findUniqueOrThrow({
      where: { code: DEPARTMENT_UNDER_TEST },
    });
    expect(after.name).toBe('Risaralda Custom');
    expect(after.isActive).toBe(false);

    // Sin duplicados por `code`.
    expect(
      await scratch.department.count({ where: { code: DEPARTMENT_UNDER_TEST } })
    ).toBe(1);
  });

  // ---------------------------------------------------------------- CASO D
  it('D) City existente: no se mueve de departamento, ni cambia de ruta, ni se reactiva', async () => {
    const city = await scratch.city.findUniqueOrThrow({ where: { slug: CITY_SLUG_UNDER_TEST } });
    const otherDepartment = await scratch.department.findUniqueOrThrow({ where: { code: 'QUI' } });
    const otherRoute = await scratch.shippingRoute.findFirstOrThrow({
      where: { name: 'Antioquia' },
    });

    // Escenario exacto que la Fase 5A evitó en /admin/envios: una ciudad
    // reasignada por el administrador. Un redeploy NO puede revertirlo.
    await scratch.city.update({
      where: { id: city.id },
      data: {
        name: 'Pereira Custom',
        departmentId: otherDepartment.id,
        shippingRouteId: otherRoute.id,
        isActive: false,
      },
    });

    await seedLogistics(scratch);

    const after = await scratch.city.findUniqueOrThrow({ where: { id: city.id } });
    expect(after.name).toBe('Pereira Custom');
    expect(after.departmentId).toBe(otherDepartment.id);
    expect(after.shippingRouteId).toBe(otherRoute.id);
    expect(after.isActive).toBe(false);

    // El slug sigue siendo único: el seed no duplicó la ciudad.
    expect(await scratch.city.count({ where: { slug: CITY_SLUG_UNDER_TEST } })).toBe(1);
    expect(await scratch.city.count()).toBe(BASELINE_CITY_COUNT);
  });

  // ---------------------------------------------------------------- CASO E
  it('E) idempotencia: la segunda corrida no escribe ni duplica baseline', async () => {
    const snapshot = async () => ({
      routes: await scratch.shippingRoute.findMany({ orderBy: { id: 'asc' } }),
      departments: await scratch.department.findMany({ orderBy: { id: 'asc' } }),
      cities: await scratch.city.findMany({ orderBy: { id: 'asc' } }),
    });

    const before = await snapshot();

    await seedLogistics(scratch);
    await seedLogistics(scratch);

    const after = await snapshot();

    // Sin duplicados y sin cambios: NO se emite ningún write sobre filas
    // existentes, ni siquiera el bump de `updatedAt`.
    expect(after.routes).toEqual(before.routes);
    expect(after.departments).toEqual(before.departments);
    expect(after.cities).toEqual(before.cities);

    expect(after.routes).toHaveLength(BASELINE_ROUTE_NAMES.length);
    expect(after.departments).toHaveLength(BASELINE_DEPARTMENT_CODES.length);
    expect(after.cities).toHaveLength(BASELINE_CITY_COUNT);

    // Las customizaciones de B/C/D sobrevivieron a dos corridas más.
    const eje = after.routes.find((r) => r.name === ROUTE_UNDER_TEST)!;
    expect(eje.isActive).toBe(false);
    expect(eje.sortOrder).toBe(77);
    expect(eje.capacity).toBe(42);

    const ris = after.departments.find((d) => d.code === DEPARTMENT_UNDER_TEST)!;
    expect(ris.name).toBe('Risaralda Custom');
    expect(ris.isActive).toBe(false);

    const pereira = after.cities.find((c) => c.slug === CITY_SLUG_UNDER_TEST)!;
    expect(pereira.name).toBe('Pereira Custom');
    expect(pereira.isActive).toBe(false);
  });
});
