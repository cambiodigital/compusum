import { Prisma } from "@prisma/client";
import { db } from "./db";
import { normalizeEmail, normalizePhone, type SessionUserRef } from "./checkout";
import { validateAndPriceItems, CartValidationError } from "./cart-validation";
import { resolveServerPricingCustomer } from "./pricing";
import {
  authorizeOrderAccess,
  OrderAccessError,
  type OrderViewer,
} from "./order-access";
import { isCustomerEditableStatus, isValidRequestType } from "./order-status";

/**
 * "EDITAR PEDIDO" (Fase 3) — distinto de "Volver a pedir".
 *
 * Solo un pedido EXPLÍCITO (orderId en la URL), SOLO mientras su estado lo
 * permita ('solicitado'), con propiedad validada server-side y precios
 * re-resueltos por el motor único. Nunca se busca "cualquier solicitado del
 * cliente" para decidir qué editar. Un pedido en 'compartido' o 'recibido'
 * no altera sus items históricos desde el portal cliente.
 *
 * ATOMICIDAD: TODAS las escrituras (reemplazo de líneas, actualización del
 * pedido y auditoría) ocurren dentro de UNA SOLA transacción:
 *   1. Validación pura del body ANTES de la transacción (nada se escribe si
 *      el payload es inválido).
 *   2. Lock pesimista de la fila (`SELECT ... FOR UPDATE`): serializa la
 *      edición con webhooks/cambios de estado concurrentes.
 *   3. Re-chequeo del estado sobre la lectura bloqueada + `updateMany`
 *      condicionado a `status = 'solicitado'` (doble guarda anti-carrera).
 *   4. `cityId` se valida contra el maestro de ciudades: un valor inválido
 *      responde 400 limpio en vez de un P2003 posterior.
 *
 * Promoción cotización → pedido (sin items nuevos en el body): re-valida
 * TODAS las líneas existentes en modo 'pedido' (exigen precio > 0); si
 * alguna falla (precio, stock, inactivo), la conversión se rechaza con 400
 * y el pedido permanece como cotización. Al convertir, las líneas se
 * reescriben con los snapshots re-validados: un pedido jamás conserva
 * líneas con unitPrice null.
 *
 * Toda actualización queda auditada en OrderStatusHistory (from = to = estado,
 * changedBy 'cliente', nota descriptiva); el historial previo se conserva.
 */

export class OrderEditError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "OrderEditError";
    this.status = status;
  }
}

export interface EditCustomerOrderInput {
  orderId: string;
  viewer: OrderViewer;
  sessionUser: SessionUserRef | null;
  sessionId: string | null;
  body: {
    items?: unknown;
    requestType?: unknown;
    customerName?: unknown;
    customerEmail?: unknown;
    customerPhone?: unknown;
    customerCompany?: unknown;
    cityId?: unknown;
    notes?: unknown;
  };
}

function text(value: unknown, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim().slice(0, max);
  return trimmed || null;
}

export async function editCustomerOrder(input: EditCustomerOrderInput) {
  const { orderId, viewer, sessionUser, sessionId, body } = input;

  // ---- 1) Normalización del body: TODA validación pura ocurre ANTES de la
  // transacción; ningún write se ejecuta con un payload inválido.
  const bodyHasItems = body.items !== undefined;

  let mappedItems: Array<{
    productId: string;
    variantId: string | null;
    quantity: number;
  }> | null = null;

  if (bodyHasItems) {
    if (!Array.isArray(body.items) || body.items.length === 0) {
      throw new OrderEditError(
        "El pedido debe conservar al menos un producto. Para cancelarlo contactá a tu asesor.",
        400
      );
    }

    for (const item of body.items) {
      if (
        !item ||
        typeof item !== "object" ||
        typeof (item as any).productId !== "string" ||
        !Number.isInteger((item as any).quantity) ||
        (item as any).quantity <= 0
      ) {
        throw new OrderEditError("Formato de items inválido", 400);
      }
    }

    mappedItems = (body.items as any[]).map((item) => ({
      productId: item.productId,
      variantId: item.variantId ?? null,
      quantity: item.quantity,
    }));
  }

  // ---- Metadata de contacto/logística (validada fuera de la transacción).
  const updateData: Prisma.OrderUpdateManyArgs["data"] = {};

  const name = text(body.customerName, 200);
  if (body.customerEmail !== undefined) {
    const emailRaw = text(body.customerEmail, 200) ?? null;
    if (emailRaw && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw)) {
      throw new OrderEditError("Formato de email inválido", 400);
    }
    updateData.customerEmail = normalizeEmail(emailRaw);
  }
  if (body.customerPhone !== undefined) {
    updateData.customerPhone = normalizePhone(text(body.customerPhone, 32) ?? null);
  }
  const company = text(body.customerCompany, 200);
  if (company !== undefined) updateData.customerCompany = company;
  const cityIdUpdate = text(body.cityId, 64);
  if (cityIdUpdate !== undefined) updateData.cityId = cityIdUpdate;
  const notes = text(body.notes, 1000);
  if (notes !== undefined) updateData.notes = notes;

  // ---- 2) Lectura inicial: 404, propiedad y fast-fail de estado (errores
  // limpios antes de abrir la transacción).
  const order = await db.order.findUnique({
    where: { id: orderId },
    include: { items: true },
  });

  if (!order) {
    throw new OrderAccessError("Pedido no encontrado", 404);
  }

  authorizeOrderAccess(order, viewer);

  if (!isCustomerEditableStatus(order.status)) {
    throw new OrderEditError(
      `Un pedido en estado "${order.status}" ya no puede editarse desde el portal. Usá "Volver a pedir".`,
      409
    );
  }

  // Nombre vacío => conserva el nombre ya registrado en el pedido.
  if (name !== undefined) updateData.customerName = name || order.customerName;

  // ---- 3) Transacción única: lock + validaciones server-side + escrituras.
  const updated = await db.$transaction(async (tx) => {
    // a) Lock pesimista de la fila del pedido: serializa la edición con
    //    cambios de estado concurrentes (p.ej. webhook solicitado→compartido).
    const locked = await tx.$queryRaw<{ id: string; status: string }[]>`
      SELECT id, status FROM "Order" WHERE id = ${orderId} FOR UPDATE`;

    // Eliminado concurrentemente entre la lectura inicial y el lock.
    if (!locked || locked.length === 0) {
      throw new OrderAccessError("Pedido no encontrado", 404);
    }

    // b) Re-chequeo del estado sobre la lectura BLOQUEADA: si dejó de ser
    //    editable, se aborta sin haber escrito nada.
    const lockedStatus = locked[0].status;
    if (!isCustomerEditableStatus(lockedStatus)) {
      throw new OrderEditError(
        `Un pedido en estado "${lockedStatus}" ya no puede editarse desde el portal. Usá "Volver a pedir".`,
        409
      );
    }

    // c) cityId válido contra el maestro de ciudades (evita el P2003 tarde,
    //    cuando las líneas ya habrían sido reescritas).
    if (cityIdUpdate !== undefined && cityIdUpdate !== null) {
      const city = await tx.city.findUnique({
        where: { id: cityIdUpdate },
      });
      if (!city) {
        throw new OrderEditError("Ciudad no válida", 400);
      }
    }

    // d/f) Líneas: reemplazo completo re-validado (precios/stock actuales).
    if (bodyHasItems && mappedItems) {
      // El requestType efectivo: el explícito del body o el del pedido. Cambiar
      // pedido<->cotizacion es permitido si el body lo pide explícitamente.
      const requestType = isValidRequestType(body.requestType)
        ? body.requestType
        : isValidRequestType(order.requestType)
        ? order.requestType
        : "pedido";

      // Motor único: contexto del VISOR cliente (invitado => precio base).
      const pricingCustomerId = await resolveServerPricingCustomer(
        sessionUser,
        null,
        tx
      );

      let validatedResult;
      try {
        validatedResult = await validateAndPriceItems(mappedItems, tx, {
          customerId: pricingCustomerId,
          requestType,
        });
      } catch (err) {
        if (err instanceof CartValidationError) {
          throw new OrderEditError(err.message, 400);
        }
        throw err;
      }

      await tx.orderItem.deleteMany({ where: { orderId: order.id } });
      await tx.orderItem.createMany({
        data: validatedResult.validatedItems.map((item) => ({
          orderId: order.id,
          productId: item.productId,
          productName: item.productName,
          productSku: item.productSku,
          variantId: item.variantId,
          variantName: item.variantName,
          variantCode: item.variantCode,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        })),
      });

      updateData.subtotal = validatedResult.subtotal;
      updateData.requestType = requestType;
    } else if (isValidRequestType(body.requestType)) {
      // e) Promoción de tipo sin items nuevos en el body.
      if (body.requestType === "pedido" && order.requestType !== "pedido") {
        // cotizacion -> pedido: TODAS las líneas existentes deben tener precio
        // válido (> 0); si alguna falla la re-validación (precio, stock,
        // inactivo), la conversión se rechaza y el pedido permanece como
        // cotización (sin writes). Al convertir, las líneas se REESCRIBEN con
        // los snapshots re-validados: un pedido nunca conserva líneas con
        // unitPrice null (webhook, /mine y detalle leen el snapshot).
        const pricingCustomerId = await resolveServerPricingCustomer(
          sessionUser,
          null,
          tx
        );

        let revalidated;
        try {
          revalidated = await validateAndPriceItems(
            order.items.map((item) => ({
              productId: item.productId,
              variantId: item.variantId,
              quantity: item.quantity,
            })),
            tx,
            { customerId: pricingCustomerId, requestType: "pedido" }
          );
        } catch (err) {
          if (err instanceof CartValidationError) {
            throw new OrderEditError(
              `No se puede convertir la cotización en pedido. Editá las líneas primero: ${err.message}`,
              400
            );
          }
          throw err;
        }

        await tx.orderItem.deleteMany({ where: { orderId: order.id } });
        await tx.orderItem.createMany({
          data: revalidated.validatedItems.map((item) => ({
            orderId: order.id,
            productId: item.productId,
            productName: item.productName,
            productSku: item.productSku,
            variantId: item.variantId,
            variantName: item.variantName,
            variantCode: item.variantCode,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
          })),
        });

        updateData.subtotal = revalidated.subtotal;
      }
      updateData.requestType = body.requestType;
    }

    // g) Update condicionado: guarda adicional frente a cualquier carrera no
    //    cubierta por el lock (0 filas => el estado cambió => 409 sin writes).
    const result = await tx.order.updateMany({
      where: { id: orderId, status: "solicitado" },
      data: { ...updateData, updatedAt: new Date() },
    });

    if (result.count === 0) {
      throw new OrderEditError(
        `Un pedido en estado "${lockedStatus}" ya no puede editarse desde el portal. Usá "Volver a pedir".`,
        409
      );
    }

    // h) Auditoría de la edición (el historial previo NUNCA se borra).
    await tx.orderStatusHistory.create({
      data: {
        orderId: order.id,
        fromStatus: lockedStatus,
        toStatus: lockedStatus,
        changedBy: "cliente",
        note: bodyHasItems
          ? "Pedido editado desde el portal cliente (líneas actualizadas)"
          : "Pedido editado desde el portal cliente",
      },
    });

    // i) Estado final consolidado (líneas reemplazadas incluidas). Bajo el
    //    lock la fila no puede desaparecer: el chequeo es puramente defensivo.
    const finalOrder = await tx.order.findUnique({
      where: { id: orderId },
      include: { items: true },
    });
    if (!finalOrder) {
      throw new OrderAccessError("Pedido no encontrado", 404);
    }
    return finalOrder;
  });

  return updated;
}
