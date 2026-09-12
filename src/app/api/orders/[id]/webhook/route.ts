import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdminApi } from "@/lib/auth";
import { sendToWebhook, buildWebhookPayload } from "@/lib/webhook";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    // Capacidad global-admin (admin/editor): disparar el webhook N8N y
    // mutar el estado de CUALQUIER pedido no es una operación comercial.
    const { error, user } = await requireAdminApi();
    if (error) return error;

    const { id } = await params;

    const payload = await buildWebhookPayload(id);
    if (!payload) {
      return NextResponse.json({ success: false, error: "Pedido no encontrado" }, { status: 404 });
    }

    const result = await sendToWebhook(payload);

    await db.order.update({
      where: { id },
      data: {
        webhookSent: result.success,
        webhookResponse: result.response?.slice(0, 500),
        sentVia: "webhook",
        ...(result.success && payload.status === "solicitado" ? { status: "compartido" } : {}),
      },
    });

    if (result.success && payload.status === "solicitado") {
      await db.orderStatusHistory.create({
        data: {
          orderId: id,
          fromStatus: payload.status,
          toStatus: "compartido",
          changedBy: user?.name || "admin",
          note: "Enviado manualmente via webhook",
        },
      });
    }

    return NextResponse.json({
      success: result.success,
      data: { webhookResponse: result.response },
      message: result.success ? "Webhook enviado exitosamente" : "Error al enviar webhook",
    });
  } catch (error) {
    console.error("Error sending webhook:", error);
    return NextResponse.json(
      { success: false, error: "Error al enviar webhook" },
      { status: 500 }
    );
  }
}
