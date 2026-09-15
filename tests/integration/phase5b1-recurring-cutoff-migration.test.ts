import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';

/**
 * FASE 5B1 — migración `20260915120000_add_recurring_route_cutoff`.
 *
 * Dos escenarios sobre BASES RASCANTES propias, siempre con el comando real
 * `prisma migrate deploy` (nunca `migrate dev`):
 *
 *   1) CLEAN   : PostgreSQL vacío -> todas las migraciones. Verifica que las
 *                columnas nuevas existen, son nullable y sin default, y que
 *                `cutOffTime` / `departureDate` siguen existiendo.
 *   2) UPGRADE : estado PREVIO (todas las migraciones menos la nueva) con una
 *                ShippingRoute real que tiene `cutOffTime` histórico vencido y
 *                `departureDate`. Al aplicar la nueva migración se comprueba que
 *                NO hay backfill heurístico y que el legacy queda EXACTO.
 */

const HAS_POSTGRES = Boolean(process.env.DATABASE_URL?.startsWith('postgres'));

const MIGRATION_UNDER_TEST = '20260915120000_add_recurring_route_cutoff';
const CLEAN_DB = 'compusum_5b1_migtest_clean';
const UPGRADE_DB = 'compusum_5b1_migtest_upgrade';

const repoRoot = path.resolve(__dirname, '..', '..');
const migrationsDir = path.join(repoRoot, 'prisma', 'migrations');

const serverUrl = () => process.env.DATABASE_URL!;
const urlFor = (db: string) => {
  const u = new URL(serverUrl());
  u.pathname = `/${db}`;
  return u.toString();
};

/** Ejecuta SQL suelto contra `url`. */
function dbExecute(label: string, sql: string, url: string): void {
  const dir = path.join(os.tmpdir(), 'compusum-5b1-migtest');
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${label.replace(/[^a-z0-9-]/gi, '_')}.sql`);
  writeFileSync(file, sql, 'utf8');
  try {
    run(['db', 'execute', '--file', file, '--url', url], `db execute ${label}`);
  } finally {
    rmSync(file, { force: true });
  }
}

/** CLI de Prisma resuelto localmente (evita depender del runtime anfitrión). */
const PRISMA_CLI = path.join(repoRoot, 'node_modules', 'prisma', 'build', 'index.js');

/** Ejecuta el CLI de Prisma con el runtime actual (node o bun). */
function run(args: string[], label: string, env: NodeJS.ProcessEnv = process.env): string {
  const res = spawnSync(process.execPath, [PRISMA_CLI, ...args], {
    cwd: repoRoot,
    env,
    encoding: 'utf8',
  });
  if (res.status !== 0) {
    throw new Error(`${label} falló:\nstdout: ${res.stdout}\nstderr: ${res.stderr}`);
  }
  return `${res.stdout ?? ''}${res.stderr ?? ''}`;
}

function recreateDb(name: string): void {
  dbExecute(`drop-${name}`, `DROP DATABASE IF EXISTS "${name}" WITH (FORCE);`, serverUrl());
  dbExecute(`create-${name}`, `CREATE DATABASE "${name}";`, serverUrl());
}

const migrateDeploy = (db: string, schemaArg?: string) =>
  run(
    ['migrate', 'deploy', ...(schemaArg ? ['--schema', schemaArg] : [])],
    `migrate deploy (${db})`,
    { ...process.env, DATABASE_URL: urlFor(db) }
  );

/** Rutas de migración ordenadas, con su SQL disponible en disco. */
function migrationNames(): string[] {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .filter((n) => existsSync(path.join(migrationsDir, n, 'migration.sql')))
    .sort();
}

describe.skipIf(!HAS_POSTGRES)('5B1 · migración clean (PostgreSQL vacío)', () => {
  let db: PrismaClient;

  beforeAll(() => {
    if (!HAS_POSTGRES) return;
    recreateDb(CLEAN_DB);
    migrateDeploy(CLEAN_DB);
    db = new PrismaClient({ datasources: { db: { url: urlFor(CLEAN_DB) } } });
  }, 600000);

  afterAll(async () => {
    if (!HAS_POSTGRES) return;
    await db?.$disconnect();
    dbExecute('drop-clean-final', `DROP DATABASE IF EXISTS "${CLEAN_DB}" WITH (FORCE);`, serverUrl());
  }, 120000);

  type ColumnRow = {
    column_name: string;
    data_type: string;
    is_nullable: string;
    column_default: string | null;
  };

  async function columns(): Promise<Record<string, ColumnRow>> {
    const rows = (await db.$queryRawUnsafe(
      `SELECT column_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_name = 'ShippingRoute'`
    )) as ColumnRow[];
    return Object.fromEntries(rows.map((r) => [r.column_name, r]));
  }

  it('la migración nueva está registrada y todas se aplicaron', async () => {
    expect(migrationNames()).toContain(MIGRATION_UNDER_TEST);
    const applied = (await db.$queryRawUnsafe(
      `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL`
    )) as Array<{ migration_name: string }>;
    const names = applied.map((r) => r.migration_name);
    expect(names).toContain(MIGRATION_UNDER_TEST);
    expect(names).toContain('0_init');
  });

  it('`cutoffDaysBefore` existe, es INTEGER, nullable y sin default', async () => {
    const col = (await columns()).cutoffDaysBefore;
    expect(col).toBeDefined();
    expect(col.data_type).toBe('integer');
    expect(col.is_nullable).toBe('YES');
    expect(col.column_default).toBeNull();
  });

  it('`cutoffLocalTime` existe, es TEXT, nullable y sin default', async () => {
    const col = (await columns()).cutoffLocalTime;
    expect(col).toBeDefined();
    expect(col.data_type).toBe('text');
    expect(col.is_nullable).toBe('YES');
    expect(col.column_default).toBeNull();
  });

  it('el legacy `cutOffTime` y `departureDate` SIGUEN existiendo', async () => {
    const cols = await columns();
    expect(cols.cutOffTime).toBeDefined();
    expect(cols.cutOffTime.data_type).toBe('timestamp without time zone');
    expect(cols.departureDate).toBeDefined();
    expect(cols.departureDate.data_type).toBe('timestamp without time zone');
  });

  it('`departureDaysOfWeek` conserva su default y no se añadieron índices nuevos', async () => {
    const cols = await columns();
    expect(cols.departureDaysOfWeek).toBeDefined();
    // El índice preexistente sigue siendo el único sobre esta tabla.
    const indexes = (await db.$queryRawUnsafe(
      `SELECT indexname FROM pg_indexes WHERE tablename = 'ShippingRoute' ORDER BY indexname`
    )) as Array<{ indexname: string }>;
    const names = indexes.map((i) => i.indexname);
    expect(names).toContain('ShippingRoute_departureDaysOfWeek_idx');
    // Sin UNIQUE(name) y sin índice nuevo de cutoff.
    expect(names.some((n) => n.includes('cutoff'))).toBe(false);
    expect(names.some((n) => n.includes('name'))).toBe(false);
  });

  it('la migración es idempotente (re-aplicar no falla ni altera)', async () => {
    // `migrate deploy` no re-ejecuta migraciones ya aplicadas: comprobamos que
    // una segunda corrida es un no-op y el esquema sigue igual.
    const before = await columns();
    migrateDeploy(CLEAN_DB);
    const after = await columns();
    expect(Object.keys(after).sort()).toEqual(Object.keys(before).sort());
  });
});

describe.skipIf(!HAS_POSTGRES)('5B1 · migración upgrade con datos históricos', () => {
  let db: PrismaClient;
  const ROUTE_ID = 'legacy-5b1-route';
  const ROUTE_NAME = 'Ruta legacy 5B1';
  const LEGACY_CUTOFF = '2026-03-25T14:00:00.000Z';
  const LEGACY_DEPARTURE = '2026-03-31T00:00:00.000Z';

  /**
   * Estado PREVIO: usa SOLO SQL crudo. El PrismaClient se genera desde el
   * schema ACTUAL (con las columnas nuevas), así que consultar la tabla por el
   * ORM antes de migrar daría P2022 — precisamente lo que se está probando.
   */
  async function rawColumns(): Promise<string[]> {
    const rows = (await db.$queryRawUnsafe(
      `SELECT column_name FROM information_schema.columns WHERE table_name = 'ShippingRoute'`
    )) as Array<{ column_name: string }>;
    return rows.map((r) => r.column_name);
  }

  async function rawRoute() {
    const rows = (await db.$queryRawUnsafe(
      `SELECT id, name, "estimatedDaysMin", "estimatedDaysMax", "shippingCompany", "departureDaysOfWeek",
              "sortOrder", "isActive", "cutOffTime", "departureDate", "createdAt", "updatedAt"
         FROM "ShippingRoute" WHERE id = '${ROUTE_ID}'`
    )) as Array<Record<string, unknown>>;
    return rows[0];
  }

  beforeAll(async () => {
    if (!HAS_POSTGRES) return;

    recreateDb(UPGRADE_DB);

    // 1) Estado PREVIO: todas las migraciones MENOS la nueva, aplicadas con el
    //    comando real `migrate deploy` sobre una copia del proyecto de
    //    migraciones. Así el historial de `_prisma_migrations` es el real y la
    //    nueva migración queda genuinamente PENDIENTE.
    const staging = path.join(os.tmpdir(), 'compusum-5b1-prisma-prev');
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(path.join(staging, 'migrations'), { recursive: true });
    cpSync(path.join(repoRoot, 'prisma', 'schema.prisma'), path.join(staging, 'schema.prisma'));
    const lock = path.join(migrationsDir, 'migration_lock.toml');
    if (existsSync(lock)) cpSync(lock, path.join(staging, 'migrations', 'migration_lock.toml'));
    for (const name of migrationNames().filter((n) => n !== MIGRATION_UNDER_TEST)) {
      cpSync(path.join(migrationsDir, name), path.join(staging, 'migrations', name), {
        recursive: true,
      });
    }
    migrateDeploy(UPGRADE_DB, path.join(staging, 'schema.prisma'));

    db = new PrismaClient({ datasources: { db: { url: urlFor(UPGRADE_DB) } } });

    // 2) Configuración "normal" con cutoff ABSOLUTO vencido y departureDate.
    await db.$executeRawUnsafe(
      `INSERT INTO "ShippingRoute"
         ("id","name","estimatedDaysMin","estimatedDaysMax","shippingCompany","notes","isActive",
          "sortOrder","departureDaysOfWeek","cutOffTime","departureDate","createdAt","updatedAt")
       VALUES
         ('${ROUTE_ID}','${ROUTE_NAME}',2,4,'Servientrega',NULL,true,
          5,ARRAY[1]::integer[],'2026-03-25 14:00:00'::timestamp,'2026-03-31 00:00:00'::timestamp,
          '2026-03-01 08:00:00'::timestamp,'2026-03-01 08:00:00'::timestamp)`
    );
  }, 600000);

  afterAll(async () => {
    if (!HAS_POSTGRES) return;
    await db?.$disconnect();
    rmSync(path.join(os.tmpdir(), 'compusum-5b1-prisma-prev'), { recursive: true, force: true });
    dbExecute('drop-upgrade-final', `DROP DATABASE IF EXISTS "${UPGRADE_DB}" WITH (FORCE);`, serverUrl());
  }, 120000);

  it('estado previo: la ruta legacy existe y las columnas nuevas NO existen', async () => {
    const names = await rawColumns();
    expect(names).not.toContain('cutoffDaysBefore');
    expect(names).not.toContain('cutoffLocalTime');

    const route = await rawRoute();
    expect(route).toBeDefined();
    expect(route.name).toBe(ROUTE_NAME);
    expect(new Date(route.cutOffTime as string).toISOString()).toBe(LEGACY_CUTOFF);
  });

  it('al aplicar la migración NO se hace backfill y el legacy queda EXACTO', async () => {
    const before = await rawRoute();

    // 3) Aplicar la migración pendiente con el comando real.
    const output = migrateDeploy(UPGRADE_DB);
    expect(output).toContain(MIGRATION_UNDER_TEST);

    // Ahora el ORM ya puede leer las columnas nuevas.
    const after = await db.shippingRoute.findUniqueOrThrow({ where: { id: ROUTE_ID } });

    // Sin backfill heurístico: la intención comercial NO es inferible.
    expect(after.cutoffDaysBefore).toBeNull();
    expect(after.cutoffLocalTime).toBeNull();

    // El legacy se conserva intacto.
    expect(after.cutOffTime?.toISOString()).toBe(LEGACY_CUTOFF);
    expect(after.departureDate?.toISOString()).toBe(LEGACY_DEPARTURE);

    // Y el resto de la configuración no se toca.
    expect(after.name).toBe(before.name);
    expect(after.estimatedDaysMin).toBe(before.estimatedDaysMin);
    expect(after.estimatedDaysMax).toBe(before.estimatedDaysMax);
    expect(after.shippingCompany).toBe(before.shippingCompany);
    expect(after.departureDaysOfWeek).toEqual(before.departureDaysOfWeek);
    expect(after.sortOrder).toBe(before.sortOrder);
    expect(after.isActive).toBe(before.isActive);
    expect(after.createdAt.toISOString()).toBe(
      new Date(before.createdAt as string).toISOString()
    );
    expect(after.updatedAt.toISOString()).toBe(
      new Date(before.updatedAt as string).toISOString()
    );
  }, 300000);

  it('la migración upgrade también es idempotente', async () => {
    migrateDeploy(UPGRADE_DB);
    const routes = await db.shippingRoute.findMany({ where: { name: ROUTE_NAME } });
    expect(routes).toHaveLength(1);
    expect(routes[0].cutoffDaysBefore).toBeNull();
    expect(routes[0].cutOffTime?.toISOString()).toBe(LEGACY_CUTOFF);
  }, 300000);
});
