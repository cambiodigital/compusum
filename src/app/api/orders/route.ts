import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { sendToWebhook, buildWebhookPayload } from "@/lib/webhook";
import {
  createOrderFromCart,
  orderCreateErrorResponse,
} from "@/lib/order-create";
import {
  canAutoShareAfterWebhook,
  lockOrderForCommercialUpdate,
} from "@/lib/commercial-order";

/**
 * POST /api/orders — Fase 3.
 *
 * SEMÁNTICA NUEVA: cada confirmación crea SIEMPRE un Order nuevo (snapshot
 * histórico). Nunca se reemplaza en silencio un pedido anterior 'solicitado'.
 * Doble submit protegido dentro de `createOrderFromCart` (lock del carrito +
 * idempotencyKey). Body acepta `requestType: 'pedido' | 'cotizacion'`.
 *
 * Fase 4B: el webhook puede seguir notificando y su resultado SIEMPRE se
 * persiste, pero el paso automático a 'compartido' obedece a la política
 * server-side `canAutoShareAfterWebhook`: un pedido normal comparte con éxito;
 * una cotización incompleta (sin líneas o con alguna sin precio positivo)
 * permanece 'solicitado' para que el asesor pueda completarla en el panel
 * comercial.
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

        // El resultado se persiste SIEMPRE. La decisión de compartir se
        // deriva del Order persistido y sus líneas, releídos bajo el lock
        // (nunca del requestType/flags/subtotal del navegador): una
        // cotización incompleta queda en 'solicitado' y sigue editable en 4B.
        await db.$transaction(async (tx) => {
          const locked = await lockOrderForCommercialUpdate(tx, order.id);
          // Solo desde 'solicitado': si la confirmación de N8N (o cualquier
          // otro proceso) ya avanzó el pedido durante el envío, este resultado
          // NO lo revierte — misma puerta que el webhook manual.
          const shareable =
            webhookResult.success &&
            locked != null &&
            locked.status === "solicitado" &&
            (await canAutoShareAfterWebhook(tx, locked));

          await tx.order.update({
            where: { id: order.id },
            data: {
              webhookSent: webhookResult.success,
              webhookResponse: webhookResult.response?.slice(0, 500),
              ...(shareable ? { status: "compartido" } : {}),
            },
          });

          if (shareable && locked) {
            await tx.orderStatusHistory.create({
              data: {
                orderId: order.id,
                fromStatus: locked.status,
                toStatus: "compartido",
                changedBy: "sistema",
                note: `${
                  requestType === "cotizacion" ? "Cotización" : "Pedido"
                } enviado via webhook${body.sentVia ? ` (${body.sentVia})` : ""}`,
              },
            });
          }
        });
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
