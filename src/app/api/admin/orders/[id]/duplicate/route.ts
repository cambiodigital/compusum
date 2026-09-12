import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireBackofficeApi, isAgentRole } from "@/lib/auth";
import { generateOrderNumber, createOrderTransactionWithRetry } from "@/lib/order-number";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST duplicates an existing order (admin/editor capability). AGENT:
// ownership first (404 identical when not owned, without leaking existence),
// then 403; duplication never creates an order for AGENT in this phase.
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { error, user } = await requireBackofficeApi();
    if (error) return error;

    const { id } = await params;

    // Duplication is an admin/editor operation: AGENT gets 403 on its own
    // orders and 404 on foreign ones (existence not leaked), never a write.
    if (isAgentRole(user!.role)) {
      const own = await db.order.findFirst({
        where: { id, agentId: user!.id },
        select: { id: true },
      });
      if (!own) {
        return NextResponse.json({ success: false, error: "Pedido no encontrado" }, { status: 404 });
      }
      return NextResponse.json(
        {
          success: false,
          error: "Acceso denegado: se requiere rol administrativo",
          code: "FORBIDDEN",
        },
        { status: 403 }
      );
    }

    const order = await db.order.findFirst({
      where: { id },
      include: { items: true },
    });

    if (!order) {
      return NextResponse.json({ success: false, error: "Pedido no encontrado" }, { status: 404 });
    }

    const newOrder = await createOrderTransactionWithRetry(async (tx) => {
      const orderNumber = await generateOrderNumber(tx);
      return await tx.order.create({
        data: {
          orderNumber,
        cartId: order.cartId,
        customerId: order.customerId,
        agentId: order.agentId,
        sessionId: null,
        customerName: order.customerName,
        customerEmail: order.customerEmail,
        customerPhone: order.customerPhone,
        customerCompany: order.customerCompany,
        cityId: order.cityId,
        routeId: order.routeId,
        notes: order.notes,
        subtotal: order.subtotal,
        status: "solicitado",
        webhookSent: false,
        webhookResponse: null,
        sentVia: null,
        items: {
          create: order.items.map((item) => ({
            productId: item.productId,
            productName: item.productName,
            productSku: item.productSku,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
          })),
        },
      },
      include: { items: true },
    });
    });

    return NextResponse.json({ success: true, data: newOrder });
  } catch (error) {
    console.error("Error duplicating order:", error);
    return NextResponse.json({ success: false, error: "Error al duplicar pedido" }, { status: 500 });
  }
}
