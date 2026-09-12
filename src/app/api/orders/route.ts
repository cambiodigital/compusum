import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sendToWebhook, buildWebhookPayload } from "@/lib/webhook";
import {
  createOrderFromCart,
  orderCreateErrorResponse,
} from "@/lib/order-create";

/**
 * POST /api/orders — Fase 3.
 *
 * SEMÁNTICA NUEVA: cada confirmación crea SIEMPRE un Order nuevo (snapshot
 * histórico). Nunca se reemplaza en silencio un pedido anterior 'solicitado'.
 * Doble submit protegido dentro de `createOrderFromCart` (lock del carrito +
 * idempotencyKey). Body acepta `requestType: 'pedido' | 'cotizacion'`.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json().catch(() => ({}));
    const sessionId = request.headers.get("x-session-id");

    if (!body?.cartId || typeof body.cartId !== "string") {
      return NextResponse.json(
        { success: false, error: "Se requiere cartId" },
        { status: 400 }
      );
    }

    const { order, requestType, replayed } = await createOrderFromCart({
      cartId: body.cartId,
      requestType: body.requestType,
      idempotencyKey: body.idempotencyKey,
      customerName: body.customerName,
      customerEmail: body.customerEmail,
      customerPhone: body.customerPhone,
      customerCompany: body.customerCompany,
      cityId: body.cityId,
      notes: body.notes,
      sentVia: body.sentVia,
      sessionId,
    });

    // Webhook NO-fatal: el Order (y su agentId) ya están persistidos; si N8N
    // está caído la solicitud NO se pierde — queda 'solicitado' con
    // webhookSent=false y el resultado en webhookResponse.
    if (!replayed) {
      const webhookPayload = await buildWebhookPayload(order.id);
      if (webhookPayload) {
        const webhookResult = await sendToWebhook(webhookPayload);

        await db.order.update({
          where: { id: order.id },
          data: {
            webhookSent: webhookResult.success,
            webhookResponse: webhookResult.response?.slice(0, 500),
            ...(webhookResult.success ? { status: "compartido" } : {}),
          },
        });

        if (webhookResult.success) {
          await db.orderStatusHistory.create({
            data: {
              orderId: order.id,
              fromStatus: "solicitado",
              toStatus: "compartido",
              changedBy: "sistema",
              note: `${requestType === "cotizacion" ? "Cotización" : "Pedido"} enviado via webhook${
                body.sentVia ? ` (${body.sentVia})` : ""
              }`,
            },
          });
        }
      }
    }

    return NextResponse.json({
      success: true,
      data: {
        id: order.id,
        orderNumber: order.orderNumber,
        requestType,
        isUpdate: false,
        replayed,
      },
      message: replayed
        ? "La solicitud ya estaba registrada"
        : requestType === "cotizacion"
        ? "Solicitud de cotización creada exitosamente"
        : "Pedido creado exitosamente",
    });
  } catch (error) {
    const { success, error: message, code, status } = orderCreateErrorResponse(error);
    return NextResponse.json({ success, error: message, code }, { status });
  }
}
