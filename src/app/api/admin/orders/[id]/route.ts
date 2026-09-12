import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireBackofficeApi, isAgentRole } from "@/lib/auth";
import { isValidOrderStatus } from "@/lib/order-status";

interface RouteParams {
  params: Promise<{ id: string }>;
}

// Fase 4B: aborts the status-change transaction carrying a ready-made
// response (Prisma rolls back automatically on throw; zero partial writes).
class OrderPatchAbort extends Error {
  constructor(public readonly response: NextResponse) {
    super("order-patch-abort");
  }
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { error, user } = await requireBackofficeApi();
    if (error) return error;

    const { id } = await params;

    const order = await db.order.findFirst({
      where: isAgentRole(user!.role) ? { id, agentId: user!.id } : { id },
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
    const { error, user } = await requireBackofficeApi();
    if (error) return error;

    const body = await request.json();

    // AGENT must never mutate order lines or prices: any body carrying the
    // `items` key (even an empty array or null) is rejected BEFORE any
    // database access. Admin/editor keep the legacy items replacement.
    if (
      isAgentRole(user!.role) &&
      body !== null &&
      typeof body === "object" &&
      "items" in body
    ) {
      return NextResponse.json(
        {
          success: false,
          error: "Acceso denegado: se requiere rol administrativo",
          code: "FORBIDDEN",
        },
        { status: 403 }
      );
    }

    const { id } = await params;
    const { status, note, items, customerName, customerEmail, customerPhone, customerCompany, cityId, routeId } = body;

    // AGENT: solo pedidos propios (404 idéntico si no lo es).
    const order = await db.order.findFirst({
      where: isAgentRole(user!.role) ? { id, agentId: user!.id } : { id },
    });
    if (!order) {
      return NextResponse.json({ success: false, error: "Pedido no encontrado" }, { status: 404 });
    }

    // Fase 3: ningún PATCH puede escribir un estado arbitrario.
    if (status !== undefined && !isValidOrderStatus(status)) {
      return NextResponse.json(
        {
          success: false,
          error: `Estado inválido. Valores permitidos: solicitado, compartido, recibido.`,
        },
        { status: 400 }
      );
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

    // Fase 4B: status changes are transactional under a row lock: the update
    // and its history row are written atomically, `fromStatus` is read
    // POST-lock (never from the stale pre-lock read) and an incomplete quote
    // can never be shared or confirmed.
    let updated;
    if (status !== undefined) {
      try {
        updated = await db.$transaction(async (tx) => {
          const locked = await tx.$queryRaw<
            { id: string; status: string; requestType: string }[]
          >`
            SELECT id, status, "requestType" FROM "Order" WHERE id = ${id} FOR UPDATE`;

          // Deleted between the initial read and the lock.
          if (!locked || locked.length === 0) {
            throw new OrderPatchAbort(
              NextResponse.json(
                { success: false, error: "Pedido no encontrado" },
                { status: 404 }
              )
            );
          }
          const postLockStatus = locked[0].status;

          // Redundant by construction (validated before the transaction), but
          // the target is re-checked against the authoritative state.
          if (!isValidOrderStatus(status)) {
            throw new OrderPatchAbort(
              NextResponse.json(
                {
                  success: false,
                  error: `Estado inválido. Valores permitidos: solicitado, compartido, recibido.`,
                },
                { status: 400 }
              )
            );
          }

          // Commercial guard: an incomplete quote (any line without a
          // positive price) must never be shared or confirmed.
          if (
            locked[0].requestType === "cotizacion" &&
            (status === "compartido" || status === "recibido")
          ) {
            const quoteItems = await tx.orderItem.findMany({
              where: { orderId: id },
              select: { unitPrice: true },
            });
            if (quoteItems.some((item) => item.unitPrice == null || item.unitPrice <= 0)) {
              throw new OrderPatchAbort(
                NextResponse.json(
                  {
                    success: false,
                    error:
                      "La cotización tiene líneas sin precio y no puede compartirse o recibirse",
                  },
                  { status: 400 }
                )
              );
            }
          }

          const result = await tx.order.update({
            where: { id },
            data: updateData,
            include: { items: true },
          });

          // Same observable semantics as before: history only when the status
          // actually changes — but now compared against the POST-lock status.
          if (status !== postLockStatus) {
            await tx.orderStatusHistory.create({
              data: {
                orderId: id,
                fromStatus: postLockStatus,
                toStatus: status,
                changedBy: user?.name || "admin",
                note: note || null,
              },
            });
          }

          return result;
        });
      } catch (txError) {
        if (txError instanceof OrderPatchAbort) {
          return txError.response;
        }
        throw txError;
      }
    } else {
      updated = await db.order.update({
        where: { id },
        data: updateData,
        include: { items: true },
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
    const { error, user } = await requireBackofficeApi();
    if (error) return error;

    const { id } = await params;

    // Eliminar pedidos es una operación destructiva global-admin: el AGENT
    // recibe 403 en pedidos propios y 404 en ajenos (sin filtrar existencia).
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
