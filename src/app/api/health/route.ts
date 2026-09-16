import { NextResponse } from "next/server";

/**
 * Fase 7 — LIVENESS.
 *
 * Responde 200 mientras el proceso esté vivo y sirviendo HTTP. NO toca la
 * base de datos (para eso está /api/ready): una caída de la DB no debe hacer
 * que el orquestador reinicie el proceso en cascada.
 *
 * Respuesta mínima y sin información sensible (versión, host, paths, etc.
 * quedan fuera a propósito).
 */
export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ status: "ok" });
}
