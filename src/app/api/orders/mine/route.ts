import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

/**
 * GET /api/orders/mine
 * Devuelve los pedidos del visitante actual.
 * - Si hay sesión autenticada: muestra por customerId.
 * - Si es invitado: muestra por sessionId (viene del middleware x-session-id).
 */
export async function GET(request: NextRequest) {
  try {
    const sessionId = request.headers.get("x-session-id");
    const currentUser = await getCurrentUser();
    const userId = currentUser?.id ?? null;

    // Si el usuario está autenticado, consultar estrictamente por su customerId.
    // Si no está autenticado (invitado), consultar estrictamente por sessionId.
    const whereClause = userId
      ? { customerId: userId }
      : sessionId
      ? { sessionId }
      : null;

    if (!whereClause) {
      return NextResponse.json({ success: true, data: [] });
    }

    const orders = await db.order.findMany({
      where: whereClause,
      select: {
        id: true,
        orderNumber: true,
        status: true,
        requestType: true,
        subtotal: true,
        sentVia: true,
        createdAt: true,
        agent: { select: { name: true } },
        items: {
          select: {
            id: true,
            productId: true,
            variantId: true,
            productName: true,
            productSku: true,
            variantName: true,
            quantity: true,
            unitPrice: true,
          },
        },
      },
      orderBy: { createdAt: "desc" },
      take: 50,
    });

    return NextResponse.json({ success: true, data: orders });
  } catch (error) {
    console.error("Error fetching orders:", error);
    return NextResponse.json(
      { success: false, error: "Error al obtener pedidos" },
      { status: 500 }
    );
  }
}
