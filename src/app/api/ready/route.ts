import { NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * Fase 7 — READINESS.
 *
 * 200 sólo cuando la app puede recibir tráfico: conexión real a PostgreSQL
 * (`SELECT 1`). 503 en cualquier fallo de DB. Sin secretos, sin connection
 * string, sin stack traces: el detalle del error queda en los logs del
 * servidor, nunca en el cuerpo de la respuesta.
 */
export const dynamic = "force-dynamic";

const READY_TIMEOUT_MS = 3_000;

async function pingDatabase(): Promise<void> {
  // carrera contra un timeout: un DB colgado (no solo caído) no debe
  // sostener la petición de readiness indefinidamente.
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      db.$queryRaw(Prisma.sql`SELECT 1`),
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("database ping timeout")),
          READY_TIMEOUT_MS
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function GET() {
  try {
    await pingDatabase();
    return NextResponse.json({ status: "ready" });
  } catch (error) {
    console.error("[ready] database check failed:", error);
    return NextResponse.json({ status: "unavailable" }, { status: 503 });
  }
}
