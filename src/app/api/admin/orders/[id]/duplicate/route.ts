import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireBackofficeApi, isAgentRole } from "@/lib/auth";
import { generateOrderNumber, createOrderTransactionWithRetry } from "@/lib/order-number";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// POST duplica un pedido existente. AGENT: solo puede duplicar SUS pedidos
// (404 idéntico si no lo es); la copia conserva agentId (= self).
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { error, user } = await requireBackofficeApi();
    if (error) return error;

    const { id } = await params;

    const order = await db.order.findFirst({
      where: isAgentRole(user!.role) ? { id, agentId: user!.id } : { id },
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
