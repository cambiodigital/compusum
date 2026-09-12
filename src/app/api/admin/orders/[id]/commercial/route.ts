import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { requireBackofficeApi } from "@/lib/auth";
import {
  buildCommercialPreview,
  previewCommercialLines,
  saveCommercialCalculation,
  recalculateCommercialOrder,
  convertQuoteToOrder,
  CommercialOrderError,
  type CommercialLineInput,
} from "@/lib/commercial-order";
import { CartValidationError } from "@/lib/cart-validation";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * Commercial calculation API (Fase 4B).
 *
 * - GET  -> read-only commercial preview (snapshot vs engine prices).
 * - POST -> { action: "preview" | "save" | "recalculate" | "convert" }.
 *
 * CUSTOMER never reaches this layer (requireBackofficeApi 403s). AGENT
 * isolation (404 fail-closed on foreign orders) and ALL business rules live
 * in `src/lib/commercial-order.ts`; this handler only maps inputs and errors.
 * No browser-supplied value can influence price, subtotal, customerId,
 * priceProfileId or ownership.
 */

function errorResponse(error: unknown): NextResponse {
  if (error instanceof CommercialOrderError) {
    return NextResponse.json(
      {
        success: false,
        error: error.message,
        ...(error.code ? { code: error.code } : {}),
      },
      { status: error.status }
    );
  }

  // Validation failure from the cart/pricing engine: clean commercial 400.
  if (error instanceof CartValidationError) {
    return NextResponse.json({ success: false, error: error.message }, { status: 400 });
  }

  // Record vanished mid-operation (deleted between reads/writes).
  if (
    error instanceof Prisma.PrismaClientKnownRequestError &&
    error.code === "P2025"
  ) {
    return NextResponse.json(
      { success: false, error: "Pedido no encontrado" },
      { status: 404 }
    );
  }

  console.error("Commercial order API error:", error);
  return NextResponse.json(
    { success: false, error: "Error interno del servidor" },
    { status: 500 }
  );
}

function parseLines(value: unknown): CommercialLineInput[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new CommercialOrderError("Formato de líneas inválido.", 400);
  }
  return value as CommercialLineInput[];
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { error, user } = await requireBackofficeApi();
    if (error) return error;

    const { id } = await params;
    const data = await buildCommercialPreview(id, user!);
    return NextResponse.json({ success: true, data });
  } catch (err) {
    return errorResponse(err);
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { error, user } = await requireBackofficeApi();
    if (error) return error;

    const { id } = await params;

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = null;
    }
    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { success: false, error: "Formato de solicitud inválido." },
        { status: 400 }
      );
    }

    const { action, note } = body as Record<string, unknown>;
    const actor = user!;

    switch (action) {
      case "preview": {
        const data = await previewCommercialLines(
          id,
          actor,
          parseLines((body as Record<string, unknown>).lines)
        );
        return NextResponse.json({ success: true, data });
      }

      case "save": {
        const lines = parseLines((body as Record<string, unknown>).lines);
        if (lines.length === 0) {
          return NextResponse.json(
            { success: false, error: "Debe incluir al menos una línea." },
            { status: 400 }
          );
        }
        const data = await saveCommercialCalculation({
          orderId: id,
          actor,
          lines,
          note: typeof note === "string" ? note : undefined,
        });
        return NextResponse.json({
          success: true,
          data,
          message: "Cálculo guardado",
        });
      }

      case "recalculate": {
        const data = await recalculateCommercialOrder({
          orderId: id,
          actor,
          note: typeof note === "string" ? note : undefined,
        });
        return NextResponse.json({
          success: true,
          data,
          message: "Precios recalculados",
        });
      }

      case "convert": {
        const data = await convertQuoteToOrder({
          orderId: id,
          actor,
          note: typeof note === "string" ? note : undefined,
        });
        return NextResponse.json({
          success: true,
          data,
          message: "Cotización convertida en pedido",
        });
      }

      default:
        return NextResponse.json(
          {
            success: false,
            error:
              "Acción inválida. Valores permitidos: preview, save, recalculate, convert.",
          },
          { status: 400 }
        );
    }
  } catch (err) {
    return errorResponse(err);
  }
}
