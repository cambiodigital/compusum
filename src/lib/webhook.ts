import { db } from "@/lib/db";

export async function getWebhookConfig() {
  const settings = await db.setting.findMany({
    where: {
      key: { in: ["n8n_webhook_url", "n8n_webhook_enabled"] },
    },
  });

  const url = settings.find((s) => s.key === "n8n_webhook_url")?.value || null;
  const enabled = settings.find((s) => s.key === "n8n_webhook_enabled")?.value === "true";

  return { url, enabled };
}

export interface OrderWebhookPayload {
  orderNumber: string;
  orderId: string;
  status: string;
  /** pedido | cotizacion: enrutamiento interno de la solicitud. */
  requestType: string;
  sentVia: string | null;
  createdAt: string;
  // Customer
  customerName: string;
  customerEmail: string | null;
  customerPhone: string | null;
  customerCompany: string | null;
  notes: string | null;
  // Asesor asignado (nombre para enrutamiento; sin datos de contacto internos)
  agentId: string | null;
  agentName: string | null;
  // Totals
  subtotal: number;
  // Items
  items: {
    productName: string;
    productSku: string | null;
    variantId: string | null;
    variantName: string | null;
    variantCode: string | null;
    quantity: number;
    unitPrice: number | null;
    lineTotal: number;
  }[];
  // Shipping
  city: {
    name: string;
    department: string;
    shippingRoute: string | null;
    estimatedDays: string | null;
    shippingCompany: string | null;
  } | null;
}

/**
 * Build a complete webhook payload from an order ID.
 * Fetches all related data (items, city, shipping route, assigned agent).
 */
export async function buildWebhookPayload(orderId: string): Promise<OrderWebhookPayload | null> {
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: {
      items: true,
      agent: { select: { name: true } },
      city: {
        include: {
          department: true,
          shippingRoute: true,
        },
      },
    },
  });

  if (!order) return null;

  return {
    orderNumber: order.orderNumber,
    orderId: order.id,
    status: order.status,
    requestType: order.requestType,
    sentVia: order.sentVia,
    createdAt: order.createdAt.toISOString(),
    customerName: order.customerName,
    customerEmail: order.customerEmail,
    customerPhone: order.customerPhone,
    customerCompany: order.customerCompany,
    notes: order.notes,
    agentId: order.agentId,
    agentName: order.agent?.name ?? null,
    subtotal: order.subtotal,
    items: order.items.map((i) => ({
      productName: i.productName,
      productSku: i.productSku,
      variantId: i.variantId,
      variantName: i.variantName,
      variantCode: i.variantCode,
      quantity: i.quantity,
      unitPrice: i.unitPrice,
      lineTotal: (i.unitPrice || 0) * i.quantity,
    })),
    city: order.city
      ? {
          name: order.city.name,
          department: order.city.department.name,
          shippingRoute: order.city.shippingRoute?.name || null,
          estimatedDays: order.city.shippingRoute
            ? `${order.city.shippingRoute.estimatedDaysMin}-${order.city.shippingRoute.estimatedDaysMax} días`
            : null,
          shippingCompany: order.city.shippingRoute?.shippingCompany || null,
        }
      : null,
  };
}

export async function sendToWebhook(payload: OrderWebhookPayload): Promise<{ success: boolean; response?: string }> {
  const config = await getWebhookConfig();

  if (!config.enabled || !config.url) {
    return { success: false, response: "Webhook no configurado o desactivado" };
  }

  try {
    const res = await fetch(config.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    return { success: res.ok, response: text };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Error desconocido";
    return { success: false, response: message };
  }
}
