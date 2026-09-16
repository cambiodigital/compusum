import { NextResponse } from "next/server";
import { requireAdminApi } from "@/lib/auth";
import {
  deleteUploadOrphans,
  scanUploadOrphans,
} from "@/lib/media-orphan-cleanup";

/**
 * CLEANUP ADMINISTRATIVO DE HUÉRFANOS DE /uploads — Fase 6.
 *
 * GET  => DRY-RUN (default seguro): inventario físico vs referencias vivas.
 *         Nunca borra nada. Requiere rol administrativo (admin/editor).
 *
 * POST => BORRADO FÍSICO, solo con acción explícita {"mode":"delete"}.
 *         Requiere rol `admin` ESTRICTO: ni editor, ni AGENT, ni CUSTOMER,
 *         ni anónimo (fail-closed). Sin cron; sin ejecución automática.
 *
 * Las garantías por archivo (directorio canónico, fichero regular, sin
 * symlinks, >=24h, re-check de referencias inmediato antes del unlink,
 * ENOENT idempotente) viven en `@/lib/media-orphan-cleanup`.
 */

/** El borrado físico es solo para `admin`: el editor administra contenido, no disco. */
function isStrictAdminRole(role: string | null | undefined): boolean {
  return (role ?? "").trim().toLowerCase() === "admin";
}

export async function GET() {
  try {
    const { error } = await requireAdminApi();
    if (error) return error;

    const report = await scanUploadOrphans();
    return NextResponse.json({ success: true, data: { mode: "dry-run", ...report } });
  } catch (error) {
    console.error("Orphan scan error:", error);
    return NextResponse.json({ success: false, error: "Error al escanear huérfanos" }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const { error, user } = await requireAdminApi();
    if (error) return error;

    if (!isStrictAdminRole(user?.role)) {
      return NextResponse.json(
        { success: false, error: "El borrado físico de huérfanos requiere rol admin" },
        { status: 403 }
      );
    }

    let body: { mode?: unknown; minAgeHours?: unknown } = {};
    try {
      body = await request.json();
    } catch {
      // cuerpo vacío/inválido: cae al 400 de modo ausente.
    }

    if (body.mode !== "delete") {
      return NextResponse.json(
        { success: false, error: 'Acción destructiva: requiere {"mode":"delete"} explícito (dry-run disponible vía GET)' },
        { status: 400 }
      );
    }

    const minAgeHours =
      typeof body.minAgeHours === "number" && Number.isFinite(body.minAgeHours)
        ? body.minAgeHours
        : undefined;

    const report = await deleteUploadOrphans({ minAgeHours });
    return NextResponse.json({ success: true, data: report });
  } catch (error) {
    console.error("Orphan delete error:", error);
    return NextResponse.json({ success: false, error: "Error al eliminar huérfanos" }, { status: 500 });
  }
}
