import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import {
  assertQuoteShareable,
  CommercialOrderError,
} from "@/lib/commercial-order";

/**
 * An identifier is usable only when it is a string with non-whitespace
 * content. Anything else (undefined, null, numbers, booleans, objects, empty
 * or blank strings) normalizes to null.
 */
function normalizedIdentifier(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

export async function POST(request: NextRequest) {
  try {
    // Validate API key from N8N
    const apiKey = request.headers.get("x-api-key") || request.headers.get("authorization")?.replace("Bearer ", "");
    const expectedKey = process.env.N8N_API_KEY;

    if (!expectedKey || apiKey !== expectedKey) {
      return NextResponse.json(
        { success: false, error: "No autorizado" },
        { status: 401 }
      );
    }

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { success: false, error: "Se requiere orderId u orderNumber" },
        { status: 400 }
      );
    }

    const { orderNumber, orderId, status: responseStatus } = body;

    // Fase 4B: la validación ocurre ANTES de cualquier acceso a base. Sin un
    // identificador utilizable, el `where` de Prisma queda efectivamente vacío
    // (`{ orderNumber: undefined }`) y `findFirst` devuelve el PRIMER Order:
    // ese pedido ajeno sería confirmado a "recibido" con una fila de historial
    // incorrecta. Precedencia intacta: orderId válido manda; si no,
    // orderNumber.
    const normalizedOrderId = normalizedIdentifier(orderId);
    const normalizedOrderNumber = normalizedIdentifier(orderNumber);

    let orderWhere: { id: string } | { orderNumber: string };
    if (normalizedOrderId) {
      orderWhere = { id: normalizedOrderId };
    } else if (normalizedOrderNumber) {
      orderWhere = { orderNumber: normalizedOrderNumber };
    } else {
      return NextResponse.json(
        { success: false, error: "Se requiere orderId u orderNumber" },
        { status: 400 }
      );
    }

    const order = await db.order.findFirst({ where: orderWhere });

    if (!order) {
      return NextResponse.json(
        { success: false, error: "Pedido no encontrado" },
        { status: 404 }
      );
    }

    // Only allow valid status transitions from N8N
    const allowedStatuses = ["recibido"];
    const newStatus = allowedStatuses.includes(responseStatus) ? responseStatus : "recibido";

    // Fase 4B: esta confirmación es la contraparte del webhook de creación. Una
    // cotización incompleta (sin líneas, o con alguna sin precio positivo) NO
    // puede quedar confirmada: 'recibido' la congela y el asesor ya no podría
    // completarla ni convertirla. Misma regla compartida que el PATCH de estado
    // y el webhook manual.
    try {
      await assertQuoteShareable(db, order.id, newStatus);
    } catch (guardError) {
      if (guardError instanceof CommercialOrderError && guardError.status === 400) {
        return NextResponse.json(
          { success: false, error: guardError.message },
          { status: 400 }
        );
      }
      throw guardError;
    }

    await db.order.update({
      where: { id: order.id },
      data: {
        status: newStatus,
        webhookResponse: JSON.stringify(body).slice(0, 500),
      },
    });

    await db.orderStatusHistory.create({
      data: {
        orderId: order.id,
        fromStatus: order.status,
        toStatus: newStatus,
        changedBy: "n8n-webhook",
        note: `Confirmación recibida: ${responseStatus || "Recibido"}`,
      },
    });

    return NextResponse.json({
      success: true,
      message: "Estado actualizado",
    });
  } catch (error) {
    console.error("Error processing N8N webhook:", error);
    return NextResponse.json(
      { success: false, error: "Error procesando webhook" },
      { status: 500 }
    );
  }
}
