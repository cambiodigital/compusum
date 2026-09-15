import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireBackofficeApi, isAgentRole } from "@/lib/auth";
import { isValidOrderStatus } from "@/lib/order-status";
import { assertQuoteShareable, CommercialOrderError } from "@/lib/commercial-order";
import {
  parseCityIdMutation,
  resolveShippingRouteForCity,
  CityResolutionError,
  type CityIdMutation,
} from "@/lib/city-route";

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
    // Fase 5A: `routeId` ya NO se acepta del body (ningún caller legítimo lo
    // envía): la ruta se DERIVA server-side de la ciudad validada.
    const { status, note, items, customerName, customerEmail, customerPhone, customerCompany, cityId } = body;

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

    // Fase 5A-fix (P1): cityId se CLASIFICA aquí (tipo inválido => 400 con
    // cero writes) pero se RESUELVE DENTRO de la transacción autoritativa de
    // abajo, tras el FOR UPDATE y el re-chequeo de ownership AGENT post-lock.
    // `routeId` sigue sin aceptarse del body: la ruta SIEMPRE se deriva
    // server-side de la ciudad validada, en la misma tx, en tándem.
    let cityMutation: CityIdMutation | null = null;
    if (cityId !== undefined) {
      try {
        cityMutation = parseCityIdMutation(cityId);
      } catch (error) {
        if (error instanceof CityResolutionError) {
          return NextResponse.json({ success: false, error: error.message }, { status: 400 });
        }
        throw error;
      }
    }

    /**
     * Resuelve cityId/routeId EN TÁNDEM contra la tx autoritativa:
     *   - omit  => sin cambios;
     *   - clear => ambos null;
     *   - set   => ciudad activa validada + ruta server-side (cutoff actual).
     * CityResolutionError aborta la tx con 400 listo para responder.
     */
    const applyCityMutationInTx = async (
      tx: Parameters<Parameters<typeof db.$transaction>[0]>[0]
    ) => {
      if (!cityMutation) return;
      try {
        if (cityMutation.action === "clear") {
          updateData.cityId = null;
          updateData.routeId = null;
        } else if (cityMutation.action === "set") {
          const resolved = await resolveShippingRouteForCity(cityMutation.cityId, tx);
          updateData.cityId = resolved.city.id;
          updateData.routeId = resolved.route?.id ?? null;
        }
      } catch (error) {
        if (error instanceof CityResolutionError) {
          throw new OrderPatchAbort(
            NextResponse.json({ success: false, error: error.message }, { status: 400 })
          );
        }
        throw error;
      }
    };

    // Legacy `items` replacement: the payload is only PREPARED here. The
    // actual writes run inside the transaction below, so a status change that
    // the share guard rejects can never leave the lines half-replaced.
    let itemRows:
      | {
          orderId: string;
          productId: string;
          productName: string;
          productSku: string | null;
          quantity: number;
          unitPrice: number | null;
        }[]
      | null = null;
    if (Array.isArray(items)) {
      itemRows = items.map(
        (item: {
          productId: string;
          productName: string;
          productSku?: string;
          quantity: number;
          unitPrice?: number;
        }) => ({
          orderId: id,
          productId: item.productId,
          productName: item.productName,
          productSku: item.productSku || null,
          quantity: item.quantity,
          unitPrice: item.unitPrice ?? null,
        })
      );
      updateData.subtotal = items.reduce(
        (sum: number, item: { quantity: number; unitPrice?: number }) =>
          sum + item.quantity * (item.unitPrice || 0),
        0
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
            { id: string; status: string; requestType: string; agentId: string | null }[]
          >`
            SELECT id, status, "requestType", "agentId" FROM "Order" WHERE id = ${id} FOR UPDATE`;

          // Deleted between the initial read and the lock.
          if (!locked || locked.length === 0) {
            throw new OrderPatchAbort(
              NextResponse.json(
                { success: false, error: "Pedido no encontrado" },
                { status: 404 }
              )
            );
          }

          // AGENT ownership is re-checked on the LOCKED row: the pre-lock
          // read can be stale if the order was reassigned in between.
          // Fail-closed 404 (no existence leak), zero writes.
          if (isAgentRole(user!.role) && locked[0].agentId !== user!.id) {
            throw new OrderPatchAbort(
              NextResponse.json(
                { success: false, error: "Pedido no encontrado" },
                { status: 404 }
              )
            );
          }
          const postLockStatus = locked[0].status;

          // Fase 5A-fix (P1): City→Route POST-lock y DENTRO de la tx —
          // inválida/inactiva => 400, cero writes.
          await applyCityMutationInTx(tx);

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

          // Legacy line replacement INSIDE the transaction: it must be visible
          // to the share guard (which reads the lines under the same tx) and
          // must roll back together with a rejected status change.
          if (itemRows) {
            await tx.orderItem.deleteMany({ where: { orderId: id } });
            await tx.orderItem.createMany({ data: itemRows });
          }

          // Commercial guard: an incomplete quote (no lines, or any line
          // without a positive price) must never be shared or confirmed.
          // Shared implementation with the manual webhook route.
          try {
            await assertQuoteShareable(tx, id, status);
          } catch (guardError) {
            if (guardError instanceof CommercialOrderError && guardError.status === 400) {
              throw new OrderPatchAbort(
                NextResponse.json(
                  { success: false, error: guardError.message },
                  { status: 400 }
                )
              );
            }
            throw guardError;
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
      // Fase 5A-fix (P1): sin cambio de estado la mutación TAMBIÉN es
      // autoritativa — antes actualizaba sin lock ni re-chequeo, y un AGENT
      // que pasó el lookup inicial podía mutar un pedido reasignado a OTRO
      // asesor mientras esperaba. Ahora: FOR UPDATE + ownership post-lock
      // (404 fail-closed, sin leak de existencia), City→Route resuelta
      // DENTRO de la tx, y un único write atómico. Cualquier error =>
      // cero writes.
      try {
        updated = await db.$transaction(async (tx) => {
          const locked = await tx.$queryRaw<
            { id: string; status: string; requestType: string; agentId: string | null }[]
          >`
            SELECT id, status, "requestType", "agentId" FROM "Order" WHERE id = ${id} FOR UPDATE`;

          // Deleted between the initial read and the lock.
          if (!locked || locked.length === 0) {
            throw new OrderPatchAbort(
              NextResponse.json(
                { success: false, error: "Pedido no encontrado" },
                { status: 404 }
              )
            );
          }

          // Ownership AGENT re-checked on the LOCKED row (fail-closed 404).
          if (isAgentRole(user!.role) && locked[0].agentId !== user!.id) {
            throw new OrderPatchAbort(
              NextResponse.json(
                { success: false, error: "Pedido no encontrado" },
                { status: 404 }
              )
            );
          }

          await applyCityMutationInTx(tx);

          // Legacy line replacement inside the same tx: rolls back together
          // with any city/ownership rejection above.
          if (itemRows) {
            await tx.orderItem.deleteMany({ where: { orderId: id } });
            await tx.orderItem.createMany({ data: itemRows });
          }

          return tx.order.update({
            where: { id },
            data: updateData,
            include: { items: true },
          });
        });
      } catch (txError) {
        if (txError instanceof OrderPatchAbort) {
          return txError.response;
        }
        throw txError;
      }
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
