import { NextRequest, NextResponse } from "next/server";
import { reorderOrderItems, ReorderError } from "@/lib/order-reorder";
import { getOrderViewer, OrderAccessError } from "@/lib/order-access";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * POST /api/orders/[id]/reorder — "Volver a pedir".
 *
 * NO crea un Order: carga los productos del pedido histórico en el carrito
 * ACTIVO con precios y stock ACTUALES resueltos server-side. El pedido
 * origen queda intacto; el nuevo pedido se crea al confirmar el checkout.
 *
 * Body:
 *   - mode?: 'add' | 'replace' — decisión explícita cuando ya hay carrito.
 *   - allowPartial?: true — confirmación explícita para cargar solo lo disponible.
 */
export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { id } = await params;
    const viewer = await getOrderViewer(request);
    const body = await request.json().catch(() => ({}));

    const result = await reorderOrderItems({
      orderId: id,
      viewer,
      mode: body?.mode,
      allowPartial: body?.allowPartial === true,
    });

    return NextResponse.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof OrderAccessError) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: error.status }
      );
    }
    if (error instanceof ReorderError) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: error.status }
      );
    }
    console.error("Error reordering:", error);
    return NextResponse.json(
      { success: false, error: "Error al cargar el pedido al carrito" },
      { status: 500 }
    );
  }
}
