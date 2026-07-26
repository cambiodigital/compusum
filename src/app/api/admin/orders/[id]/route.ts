import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdminApi } from "@/lib/auth";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { error } = await requireAdminApi();
    if (error) return error;

    const { id } = await params;

    const order = await db.order.findUnique({
      where: { id },
      include: {
        items: true,
        statusHistory: { orderBy: { createdAt: "asc" } },
        cart: { select: { uuid: true } },
      },
    });

    if (!order) {
      return NextResponse.json({ success: false, error: "Pedido no encontrado" }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: order });
  } catch (error) {
    console.error("Error fetching order:", error);
    return NextResponse.json({ success: false, error: "Error al obtener pedido" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { error, user } = await requireAdminApi();
    if (error) return error;

    const { id } = await params;
    const body = await request.json();
    const { status, note, items, customerName, customerEmail, customerPhone, customerCompany, cityId, routeId } = body;

    const order = await db.order.findUnique({ where: { id } });
    if (!order) {
      return NextResponse.json({ success: false, error: "Pedido no encontrado" }, { status: 404 });
    }

    const updateData: Record<string, unknown> = {};

    if (status !== undefined) updateData.status = status;
    if (body.notes !== undefined) updateData.notes = body.notes;
    if (customerName !== undefined) updateData.customerName = customerName;
    if (customerEmail !== undefined) updateData.customerEmail = customerEmail;
    if (customerPhone !== undefined) updateData.customerPhone = customerPhone;
    if (customerCompany !== undefined) updateData.customerCompany = customerCompany;
    if (cityId !== undefined) updateData.cityId = cityId;
    if (routeId !== undefined) updateData.routeId = routeId;

    // If items provided, replace all and recalculate subtotal
    if (Array.isArray(items)) {
      await db.orderItem.deleteMany({ where: { orderId: id } });
      await db.orderItem.createMany({
        data: items.map((item: { productId: string; productName: string; productSku?: string; quantity: number; unitPrice?: number }) => ({
          orderId: id,
          productId: item.productId,
          productName: item.productName,
          productSku: item.productSku || null,
          quantity: item.quantity,
          unitPrice: item.unitPrice ?? null,
        })),
      });
      updateData.subtotal = items.reduce(
        (sum: number, item: { quantity: number; unitPrice?: number }) => sum + item.quantity * (item.unitPrice || 0),
        0,
      );
    }

    const updated = await db.order.update({
      where: { id },
      data: updateData,
      include: { items: true },
    });

    // Only create history when status actually changes
    if (status && status !== order.status) {
      await db.orderStatusHistory.create({
        data: {
          orderId: id,
          fromStatus: order.status,
          toStatus: status,
          changedBy: user.name || "admin",
          note: note || null,
        },
      });
    }

    return NextResponse.json({
      success: true,
      data: updated,
      message: "Pedido actualizado",
    });
  } catch (error) {
    console.error("Error updating order:", error);
    return NextResponse.json({ success: false, error: "Error al actualizar pedido" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { error } = await requireAdminApi();
    if (error) return error;

    const { id } = await params;

    const order = await db.order.findUnique({ where: { id } });
    if (!order) {
      return NextResponse.json({ success: false, error: "Pedido no encontrado" }, { status: 404 });
    }

    await db.order.delete({ where: { id } });

    return NextResponse.json({ success: true, message: "Pedido eliminado" });
  } catch (error) {
    console.error("Error deleting order:", error);
    return NextResponse.json({ success: false, error: "Error al eliminar pedido" }, { status: 500 });
  }
}
