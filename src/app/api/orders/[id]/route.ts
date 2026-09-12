import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getSessionPricingContext } from "@/lib/pricing-context";
import {
  getOrderViewer,
  authorizeOrderAccess,
  OrderAccessError,
} from "@/lib/order-access";
import {
  buildCustomerOrderDetail,
} from "@/lib/order-detail";
import {
  editCustomerOrder,
  OrderEditError,
} from "@/lib/order-edit";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/orders/[id] — detalle seguro del pedido para el portal cliente.
 * CUSTOMER: solo pedidos propios. Invitado: solo su x-session-id exacto.
 * ADMIN: acceso conservado. AGENT: sin acceso en Fase 3.
 * El DTO nunca incluye hashes, respuestas webhook ni datos internos.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const viewer = await getOrderViewer(request);

    const order = await db.order.findUnique({
      where: { id },
      include: {
        items: true,
        statusHistory: { orderBy: { createdAt: "asc" } },
        agent: { select: { name: true } },
        city: { include: { department: { select: { name: true } } } },
      },
    });

    if (!order) {
      return NextResponse.json({ success: false, error: "Pedido no encontrado" }, { status: 404 });
    }

    // authorizeOrderAccess lanza 401/403 según el visor.
    authorizeOrderAccess(order, viewer);

    // Precio actual resuelto con el contexto del VISOR (motor único).
    const pricingCtx = await getSessionPricingContext();
    const detail = await buildCustomerOrderDetail(order, pricingCtx);

    return NextResponse.json({ success: true, data: detail });
  } catch (error) {
    if (error instanceof OrderAccessError) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: error.status }
      );
    }
    console.error("Error fetching order detail:", error);
    return NextResponse.json(
      { success: false, error: "Error al obtener el pedido" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/orders/[id] — edición controlada del pedido activo.
 * Solo estado 'solicitado', pedido explícito, propiedad validada y precios
 * re-resueltos server-side. Queda auditado en OrderStatusHistory.
 */
export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const viewer = await getOrderViewer(request);
    const body = await request.json().catch(() => ({}));

    const updated = await editCustomerOrder({
      orderId: id,
      viewer,
      sessionUser: viewer.user,
      sessionId: viewer.sessionId,
      body: body ?? {},
    });

    // Re-construir el DTO completo tras la edición.
    const order = await db.order.findUnique({
      where: { id: updated.id },
      include: {
        items: true,
        statusHistory: { orderBy: { createdAt: "asc" } },
        agent: { select: { name: true } },
        city: { include: { department: { select: { name: true } } } },
      },
    });

    const pricingCtx = await getSessionPricingContext();
    const detail = await buildCustomerOrderDetail(order!, pricingCtx);

    return NextResponse.json({
      success: true,
      data: detail,
      message: "Pedido actualizado",
    });
  } catch (error) {
    if (error instanceof OrderAccessError) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: error.status }
      );
    }
    if (error instanceof OrderEditError) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: error.status }
      );
    }
    console.error("Error editing order:", error);
    return NextResponse.json(
      { success: false, error: "Error al actualizar el pedido" },
      { status: 500 }
    );
  }
}
