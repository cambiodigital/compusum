import { db } from "./db";
import { Prisma } from "@prisma/client";
import {
  findBestRouteForCity,
  normalizeEmail,
  normalizePhone,
  resolveOrderCustomer,
  type SessionUserRef,
} from "./checkout";
import { getCurrentUser } from "./auth";
import { validateAndPriceItems, CartValidationError } from "./cart-validation";
import { resolveServerPricingCustomer } from "./pricing";
import { generateOrderNumber, createOrderTransactionWithRetry } from "./order-number";
import { isValidRequestType, type RequestType } from "./order-status";
import { lockGuestSessionIdentity } from "./order-cart-upsert";

/**
 * SEMÁNTICA FASE 3 — Cart vs Order.
 *
 * Cart  => borrador mutable del cliente.
 * Order => snapshot HISTÓRICO de una solicitud enviada (inmutable en precios).
 *
 * Cada checkout confirmado crea SIEMPRE un Order NUEVO. Nunca se busca
 * "cualquier solicitado del cliente" para reemplazarlo en silencio: un
 * cliente puede tener varios pedidos 'solicitado' independientes.
 *
 * Protección contra doble submit (reemplaza a los índices únicos parciales
 * retirados en la migración 20260907140000):
 *   1. Lock transaccional del carrito (`SELECT ... FOR UPDATE`): dos POST
 *      concurrentes del MISMO carrito se serializan; el segundo ve el
 *      carrito ya 'convertido' y falla con CONFLICT.
 *   2. `idempotencyKey` única por intento de checkout: si la respuesta se
 *      pierde y el cliente reintenta, se devuelve el pedido ya creado.
 */

export type OrderCreateErrorCode =
  | "CART_NOT_FOUND"
  | "CART_FORBIDDEN"
  | "CART_INACTIVE"
  | "CART_EMPTY"
  | "ITEMS_INVALID"
  | "CONTACT_INVALID";

export class OrderCreateError extends Error {
  code: OrderCreateErrorCode;
  status: number;

  constructor(code: OrderCreateErrorCode, message: string, status: number) {
    super(message);
    this.name = "OrderCreateError";
    this.code = code;
    this.status = status;
  }
}

export interface CreateOrderFromCartInput {
  cartId: string;
  /** Default 'pedido'. 'cotizacion' permite líneas sin precio. */
  requestType?: unknown;
  /** Clave de idempotencia generada por el cliente para ESTE checkout. */
  idempotencyKey?: unknown;
  customerName?: unknown;
  customerEmail?: unknown;
  customerPhone?: unknown;
  customerCompany?: unknown;
  cityId?: unknown;
  notes?: unknown;
  sentVia?: unknown;
  /** Usuario de la sesión autenticada (server-side). */
  sessionUser?: SessionUserRef | null;
  /** x-session-id del middleware (invitados). */
  sessionId?: string | null;
}

export interface CreatedOrderResult {
  order: Prisma.OrderGetPayload<{ include: { items: true } }>;
  requestType: RequestType;
  /** true => reintento de un checkout ya confirmado; NO se creó otro pedido. */
  replayed: boolean;
}

function text(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().slice(0, max);
  return trimmed || null;
}

/**
 * Crea un pedido (snapshot) a partir de un carrito activo, con validación y
 * precios 100% server-side vía el motor único.
 */
export async function createOrderFromCart(
  input: CreateOrderFromCartInput
): Promise<CreatedOrderResult> {
  const requestType: RequestType = isValidRequestType(input.requestType)
    ? input.requestType
    : "pedido";

  const idempotencyKey =
    typeof input.idempotencyKey === "string" && input.idempotencyKey.trim()
      ? input.idempotencyKey.trim().slice(0, 100)
      : null;

  const sessionId = input.sessionId ?? null;
  // `null` explícito => invitado (evita resolver cookies fuera de request);
  // `undefined` => resolver de la sesión autenticada server-side.
  const sessionUser =
    input.sessionUser !== undefined ? input.sessionUser : await getCurrentUser();

  const normalizedEmail = normalizeEmail(
    typeof input.customerEmail === "string" ? input.customerEmail : null
  );
  const normalizedPhone = normalizePhone(
    typeof input.customerPhone === "string" ? input.customerPhone : null
  );

  const rawName = text(input.customerName, 200);
  const safeCompany = text(input.customerCompany, 200);
  const safeNotes = text(input.notes, 1000);
  const cityId = text(input.cityId, 64);
  const sentVia = text(input.sentVia, 32);

  // Contacto obligatorio SOLO cuando la solicitud NO proviene de una sesión
  // de cliente autenticado (invitados y checkouts asistidos por admin/agent):
  // sin nombre, teléfono ni correo no hay enlace CRM ni ruteo posible. Un
  // CUSTOMER autenticado hereda la identidad de su cuenta (contacto opcional).
  const isCustomerSession = sessionUser?.role?.toLowerCase() === "customer";
  if (!isCustomerSession && !rawName && !normalizedEmail && !normalizedPhone) {
    throw new OrderCreateError(
      "CONTACT_INVALID",
      "Ingresa al menos nombre, teléfono o correo",
      400
    );
  }

  const safeName = rawName || "Cliente";

  if (
    typeof input.customerEmail === "string" &&
    input.customerEmail.trim() &&
    !normalizedEmail
  ) {
    throw new OrderCreateError(
      "CONTACT_INVALID",
      "Formato de email inválido",
      400
    );
  }

  if (
    typeof input.customerPhone === "string" &&
    input.customerPhone.trim() &&
    !normalizedPhone
  ) {
    throw new OrderCreateError(
      "CONTACT_INVALID",
      "Formato de teléfono inválido",
      400
    );
  }

  // El pedido se crea DENTRO de la transacción que bloquea el carrito: la
  // creación y la conversión del carrito son atómicas frente a dobles submits.
  const order = await createOrderTransactionWithRetry(async (tx) => {
    // 0) Advisory lock de identidad (SOLO checkout guest): primera sentencia
    //    de la tx; serializa este checkout contra la transferencia
    //    invitado→cuenta de la misma sesión (si la transferencia confirma
    //    primero, el re-chequeo de propiedad de abajo falla 403 y NO se crea
    //    pedido). No-op para checkouts autenticados.
    if (sessionUser == null && sessionId != null) {
      await lockGuestSessionIdentity(tx, sessionId);
    }

    // 1) Lock pesimista del carrito: serializa checkouts concurrentes del
    //    mismo carrito. El segundo espera, relee el estado y falla abajo.
    await tx.$queryRaw`SELECT id FROM "Cart" WHERE id = ${input.cartId} FOR UPDATE`;

    const cart = await tx.cart.findUnique({
      where: { id: input.cartId },
      include: { items: true },
    });

    if (!cart) {
      throw new OrderCreateError("CART_NOT_FOUND", "Carrito no encontrado", 404);
    }

    // 2) Idempotencia: un reintento del MISMO checkout (respuesta perdida o
    //    doble click) devuelve el pedido ya creado. Va ANTES del estado y la
    //    propiedad del carrito porque en el reintento el carrito ya está
    //    convertido y sin sessionId; la clave solo matchea pedidos de la
    //    misma sesión/cliente (validación de propiedad sobre el Order).
    if (idempotencyKey) {
      const existing = await tx.order.findUnique({
        where: { idempotencyKey },
        include: { items: true },
      });
      const sameOwner =
        existing &&
        ((sessionId && existing.sessionId === sessionId) ||
          (sessionUser && existing.customerId === sessionUser.id));
      if (existing && sameOwner) {
        return { order: existing, replayed: true };
      }
    }

    // 3) Re-lectura tras el lock: el doble submit concurrente ve aquí el
    //    carrito ya convertido por la primera solicitud.
    if (cart.status !== "activo") {
      throw new OrderCreateError(
        "CART_INACTIVE",
        "Este carrito ya fue procesado o no está activo",
        409
      );
    }

    // 4) Propiedad del carrito (admin/AGENT pueden vender asistiendo).
    const userRole = sessionUser?.role ?? null;
    const isAdminOrAgent =
      userRole?.toLowerCase() === "admin" || userRole?.toLowerCase() === "agent";
    const isOwner =
      (cart.sessionId && cart.sessionId === sessionId) ||
      (sessionUser && cart.userId === sessionUser.id);

    if (!isAdminOrAgent && !isOwner) {
      throw new OrderCreateError(
        "CART_FORBIDDEN",
        "No tienes permiso para realizar un pedido con este carrito",
        403
      );
    }

    if (!cart.items || cart.items.length === 0) {
      throw new OrderCreateError("CART_EMPTY", "El carrito está vacío", 400);
    }

    // 5) Motor único de precios: contexto del cliente SOLO desde sesión
    //    autenticada o resolución autorizada server-side.
    const pricingCustomerId = await resolveServerPricingCustomer(
      sessionUser,
      { phone: normalizedPhone, email: normalizedEmail },
      tx
    );

    let validatedResult;
    try {
      validatedResult = await validateAndPriceItems(
        cart.items.map((item) => ({
          productId: item.productId,
          variantId: item.variantId,
          quantity: item.quantity,
        })),
        tx,
        { customerId: pricingCustomerId, requestType }
      );
    } catch (err) {
      if (err instanceof CartValidationError) {
        throw new OrderCreateError("ITEMS_INVALID", err.message, 400);
      }
      throw err;
    }

    // 6) Cliente y asesor: para CUSTOMER autenticado SIEMPRE su maestro
    //    (asignación de asesor incluida); nunca datos del navegador.
    const customerResult = await resolveOrderCustomer(
      sessionUser,
      { name: safeName, phone: normalizedPhone, email: normalizedEmail },
      tx
    );

    const selectedRoute = await findBestRouteForCity(cityId, new Date(), tx);
    const orderNumber = await generateOrderNumber(tx);

    const created = await tx.order.create({
      data: {
        orderNumber,
        cartId: cart.id,
        sessionId: sessionId ?? null,
        customerId: customerResult.customer?.id || null,
        agentId: customerResult.assignedAgentId || null,
        customerName: safeName,
        customerEmail: normalizedEmail,
        customerPhone: normalizedPhone,
        customerCompany: safeCompany,
        cityId: cityId || null,
        routeId: selectedRoute?.id || null,
        notes: safeNotes,
        subtotal: validatedResult.subtotal,
        status: "solicitado",
        requestType,
        idempotencyKey,
        sentVia: sentVia || null,
        items: {
          create: validatedResult.validatedItems.map((item) => ({
            productId: item.productId,
            productName: item.productName,
            productSku: item.productSku,
            variantId: item.variantId,
            variantName: item.variantName,
            variantCode: item.variantCode,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
          })),
        },
      },
      include: { items: true },
    });

    await tx.orderStatusHistory.create({
      data: {
        orderId: created.id,
        fromStatus: null,
        toStatus: "solicitado",
        changedBy: "sistema",
        note:
          requestType === "cotizacion"
            ? "Solicitud de cotización creada desde carrito"
            : "Pedido creado desde carrito",
      },
    });

    // 7) Conversión del carrito (borrador consumido por este snapshot).
    //    sessionId: null evita el conflicto del índice único Cart(sessionId,status).
    await tx.cart.update({
      where: { id: cart.id },
      data: { status: "convertido", sessionId: null },
    });

    return { order: created, replayed: false };
  });

  return {
    order: order.order,
    requestType,
    replayed: order.replayed,
  };
}

/** Traduce errores conocidos a la respuesta JSON del route handler. */
export function orderCreateErrorResponse(error: unknown) {
  if (error instanceof OrderCreateError) {
    return {
      success: false,
      error: error.message,
      code: error.code,
      status: error.status,
    };
  }

  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === "P2022") {
      return {
        success: false,
        error:
          "No pudimos procesar el pedido por una desalineación temporal de base de datos. Estamos trabajando para resolverlo.",
        code: error.code,
        status: 500,
      };
    }

    if (error.code === "P2002") {
      const target = (error.meta?.target as string[] | undefined)?.join(",") || "";
      const isCartStatusConflict = target.includes("Cart_sessionId_status_key");
      return {
        success: false,
        error: isCartStatusConflict
          ? "Detectamos un conflicto temporal al convertir el carrito. Intentá nuevamente."
          : "Ya registramos esta solicitud. Refrescá para verla en tus pedidos.",
        code: error.code,
        status: 409,
      };
    }
  }

  console.error("Error creating order:", error);
  return { success: false, error: "Error al procesar el pedido", status: 500 };
}
