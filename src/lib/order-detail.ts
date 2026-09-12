import type { Order, OrderItem, OrderStatusHistory } from "@prisma/client";
import { db } from "./db";
import {
  resolvePricesForItems,
  type PricingCustomerContext,
} from "./pricing";
import { isValidOrderStatus } from "./order-status";

/**
 * DTO del cliente para el detalle de pedido (Fase 3).
 *
 * - Precio HISTÓRICO: `OrderItem.unitPrice` (snapshot inmutable del pedido).
 * - Precio ACTUAL: resuelto server-side por el motor único con el contexto
 *   del CUSTOMER autenticado (o base para invitados).
 * - El snapshot histórico NUNCA se modifica cuando cambia el precio actual.
 * - Nunca expone hashes, respuestas webhook, datos internos del asesor ni
 *   campos administrativos.
 */

export type ItemPriceStatus =
  | "unchanged"
  | "increased"
  | "decreased"
  | "requires_quote"
  | "unavailable";

export interface OrderDetailItemDTO {
  id: string;
  productId: string;
  productName: string;
  productSku: string | null;
  variantId: string | null;
  variantName: string | null;
  variantCode: string | null;
  quantity: number;
  /** Snapshot histórico con el que se creó el pedido. */
  historicalUnitPrice: number | null;
  historicalLineTotal: number;
  /** Precio actual resuelto para el cliente (null => requiere cotización). */
  currentUnitPrice: number | null;
  currentRequiresQuote: boolean;
  priceStatus: ItemPriceStatus;
  /** Diferencia actual - histórico. */
  priceDifference: number | null;
  /** Porcentaje sobre el histórico; null si no aplica (histórico 0 o sin precio). */
  priceDifferencePercent: number | null;
  /** Disponibilidad actual del producto/variante. */
  availability: "available" | "unavailable";
  currentStockQuantity: number | null;
}

export interface OrderDetailTimelineEntryDTO {
  fromStatus: string | null;
  toStatus: string;
  /** 'sistema' o 'Compusum': nunca nombres internos de administración. */
  changedBy: string;
  note: string | null;
  createdAt: string;
}

export interface OrderDetailDTO {
  id: string;
  orderNumber: string;
  requestType: string;
  status: string;
  createdAt: string;
  notes: string | null;
  /** Subtotal histórico del snapshot (fuente: Order.subtotal). */
  subtotal: number;
  /** Suma de líneas con precio ACTUAL conocido (referencia para recompra). */
  currentEstimatedSubtotal: number | null;
  /** El asesor ya recibió la notificación (webhook exitoso). */
  advisorNotified: boolean;
  agent: { name: string } | null;
  city: { name: string; department: string } | null;
  items: OrderDetailItemDTO[];
  statusHistory: OrderDetailTimelineEntryDTO[];
}

function sanitizeChangedBy(changedBy: string | null): string {
  return !changedBy || changedBy === "sistema" ? "sistema" : "Compusum";
}

/**
 * Comparación histórico vs actual para un lote de OrderItems (batch, sin N+1).
 * Producto eliminado/inactivo o variante inexistente/inactiva => unavailable.
 */
export function buildOrderItemPriceComparisons(
  items: Pick<
    OrderItem,
    "id" | "productId" | "productName" | "productSku" | "variantId" | "variantName" | "variantCode" | "quantity" | "unitPrice"
  >[],
  productsById: Map<
    string,
    {
      id: string;
      isActive: boolean;
      stockQuantity: number | null;
      variants: { id: string; isActive: boolean; stockQuantity: number | null }[];
    }
  >,
  prices: Map<string, { unitPrice: number | null; requiresQuote: boolean }>
): OrderDetailItemDTO[] {
  return items.map((item) => {
    const historicalUnitPrice =
      item.unitPrice !== null && item.unitPrice !== undefined ? item.unitPrice : null;
    const historicalLineTotal = (historicalUnitPrice ?? 0) * item.quantity;

    const product = productsById.get(item.productId);
    const variant = item.variantId
      ? product?.variants.find((v) => v.id === item.variantId)
      : undefined;

    const productAvailable = Boolean(product?.isActive);
    const variantAvailable = item.variantId
      ? Boolean(variant?.isActive) && Boolean(productAvailable)
      : productAvailable;
    const availability: "available" | "unavailable" =
      productAvailable && variantAvailable ? "available" : "unavailable";

    const resolved = prices.get(`${item.productId}::${item.variantId || ""}`);
    const currentUnitPrice =
      availability === "unavailable"
        ? null
        : resolved?.unitPrice != null && resolved.unitPrice > 0
        ? resolved.unitPrice
        : null;
    const currentRequiresQuote =
      availability === "available" && (resolved?.requiresQuote || currentUnitPrice === null);

    let priceStatus: ItemPriceStatus;
    if (availability === "unavailable") {
      priceStatus = "unavailable";
    } else if (currentUnitPrice === null) {
      priceStatus = "requires_quote";
    } else if (historicalUnitPrice === null) {
      // Snapshot antiguo sin precio (cotización histórica): solo informamos actual.
      priceStatus = "unchanged";
    } else if (currentUnitPrice > historicalUnitPrice) {
      priceStatus = "increased";
    } else if (currentUnitPrice < historicalUnitPrice) {
      priceStatus = "decreased";
    } else {
      priceStatus = "unchanged";
    }

    const priceDifference =
      priceStatus === "increased" || priceStatus === "decreased"
        ? currentUnitPrice! - historicalUnitPrice!
        : null;
    const priceDifferencePercent =
      priceDifference !== null && historicalUnitPrice! > 0
        ? Math.round((priceDifference / historicalUnitPrice!) * 1000) / 10
        : null;

    return {
      id: item.id,
      productId: item.productId,
      productName: item.productName,
      productSku: item.productSku,
      variantId: item.variantId,
      variantName: item.variantName,
      variantCode: item.variantCode,
      quantity: item.quantity,
      historicalUnitPrice,
      historicalLineTotal,
      currentUnitPrice,
      currentRequiresQuote,
      priceStatus,
      priceDifference,
      priceDifferencePercent,
      availability,
      currentStockQuantity: availability === "unavailable"
        ? 0
        : item.variantId
        ? (variant?.stockQuantity ?? product?.stockQuantity ?? null)
        : (product?.stockQuantity ?? null),
    };
  });
}

/**
 * Construye el DTO completo del cliente para un pedido con sus items,
 * historial, ciudad y asesor ya cargados.
 */
export async function buildCustomerOrderDetail(
  order: Order & {
    items: OrderItem[];
    statusHistory: OrderStatusHistory[];
    agent?: { name: string } | null;
    city?: { name: string; department: { name: string } } | null;
  },
  pricingCtx: PricingCustomerContext
): Promise<OrderDetailDTO> {
  const productIds = Array.from(new Set(order.items.map((i) => i.productId)));

  const products = productIds.length
    ? await (pricingCtx.tx ?? db).product.findMany({
        where: { id: { in: productIds } },
        select: {
          id: true,
          isActive: true,
          stockQuantity: true,
          variants: {
            select: { id: true, isActive: true, stockQuantity: true },
          },
        },
      })
    : [];

  const productsById = new Map<string, (typeof products)[number]>(
    products.map((p) => [p.id, p])
  );

  const priceItems = order.items
    .filter((i) => productsById.has(i.productId))
    .map((i) => ({ productId: i.productId, variantId: i.variantId }));

  const { prices } = await resolvePricesForItems(priceItems, pricingCtx);

  const detailItems = buildOrderItemPriceComparisons(
    order.items,
    productsById,
    prices
  );

  const pricedItems = detailItems.filter((i) => i.currentUnitPrice !== null);
  const currentEstimatedSubtotal = detailItems.some(
    (i) => i.availability === "available" && i.currentUnitPrice === null
  )
    ? null // hay líneas por cotizar => no hay total definitivo
    : pricedItems.reduce((sum, i) => sum + i.currentUnitPrice! * i.quantity, 0);

  const statusHistory = order.statusHistory
    .filter((h) => isValidOrderStatus(h.toStatus))
    .map((h) => ({
      fromStatus: h.fromStatus,
      toStatus: h.toStatus,
      changedBy: sanitizeChangedBy(h.changedBy),
      note: h.note,
      createdAt: h.createdAt.toISOString(),
    }));

  return {
    id: order.id,
    orderNumber: order.orderNumber,
    requestType: order.requestType,
    status: order.status,
    createdAt: order.createdAt.toISOString(),
    notes: order.notes,
    subtotal: order.subtotal,
    currentEstimatedSubtotal,
    advisorNotified: order.webhookSent,
    agent: order.agent?.name ? { name: order.agent.name } : null,
    city: order.city
      ? {
          name: order.city.name,
          department: order.city.department.name,
        }
      : null,
    items: detailItems,
    statusHistory,
  };
}
