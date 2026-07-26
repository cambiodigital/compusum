import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { sendToWebhook, buildWebhookPayload } from "@/lib/webhook";
import { findBestRouteForCity, normalizeEmail, normalizePhone, upsertCheckoutCustomer } from "@/lib/checkout";
import { upsertOrder, findActiveOrder } from "@/lib/order-cart-upsert";
import { getCurrentUser } from "@/lib/auth";
import { validateAndPriceItems, CartValidationError } from "@/lib/cart-validation";
import { generateOrderNumber, createOrderTransactionWithRetry } from "@/lib/order-number";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { cartId, customerName, customerEmail, customerPhone, customerCompany, cityId, notes, sentVia } = body;

    if (!cartId) {
      return NextResponse.json(
        { success: false, error: "Se requiere cartId" },
        { status: 400 }
      );
    }

    // Obtener sessionId del header (viene del middleware)
    const sessionId = request.headers.get("x-session-id");

    // Resolver userId si hay sesión autenticada activa
    const currentUser = await getCurrentUser();
    const userId = currentUser?.id ?? null;

    const normalizedEmail = normalizeEmail(customerEmail);
    const normalizedPhone = normalizePhone(customerPhone);

    if (!customerName && !normalizedEmail && !normalizedPhone) {
      return NextResponse.json(
        { success: false, error: "Ingresa al menos nombre, teléfono o correo" },
        { status: 400 }
      );
    }

    // Validate email format if provided
    if (normalizedEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      return NextResponse.json(
        { success: false, error: "Formato de email inválido" },
        { status: 400 }
      );
    }

    if (customerPhone && !normalizedPhone) {
      return NextResponse.json(
        { success: false, error: "Formato de teléfono inválido" },
        { status: 400 }
      );
    }

    // Sanitize text fields
    const safeName = customerName?.trim().slice(0, 200) || "Cliente";
    const safeCompany = customerCompany?.trim().slice(0, 200) || null;
    const safeNotes = notes?.trim().slice(0, 1000) || null;

    // Load cart with items
    const cart = await db.cart.findUnique({
      where: { id: cartId },
      include: {
        items: true,
      },
    });

    if (!cart) {
      return NextResponse.json({ success: false, error: "Carrito no encontrado" }, { status: 404 });
    }

    // Validar propiedad del carrito y que esté activo
    const userRole = currentUser?.role ?? null;
    const isAdminOrAgent = userRole === "admin" || userRole === "AGENT";
    const isOwner = (cart.sessionId && cart.sessionId === sessionId) || (userId && cart.userId === userId);

    if (!isAdminOrAgent && !isOwner) {
      return NextResponse.json(
        { success: false, error: "No tienes permiso para realizar un pedido con este carrito" },
        { status: 403 }
      );
    }

    if (cart.status !== "activo") {
      return NextResponse.json(
        { success: false, error: "Este carrito no está activo o ya ha sido convertido" },
        { status: 400 }
      );
    }

    if (!cart.items || cart.items.length === 0) {
      return NextResponse.json(
        { success: false, error: "El carrito está vacío" },
        { status: 400 }
      );
    }

    // Validar items en base de datos y recalculado exclusivo de subtotal en servidor
    let validatedResult;
    try {
      validatedResult = await validateAndPriceItems(
        cart.items.map((item) => ({
          productId: item.productId,
          variantId: item.variantId,
          quantity: item.quantity,
        }))
      );
    } catch (err) {
      if (err instanceof CartValidationError) {
        return NextResponse.json(
          { success: false, error: err.message },
          { status: 400 }
        );
      }
      throw err;
    }

    const { validatedItems, subtotal } = validatedResult;

    // Verificar si ya existe una orden activa para esta sesión/usuario
    const existingOrder = await findActiveOrder(sessionId, userId);

    if (existingOrder) {
      // ACTUALIZAR ORDEN EXISTENTE
      const order = await db.$transaction(async (tx) => {
        const customerResult = await upsertCheckoutCustomer(
          {
            name: safeName,
            phone: normalizedPhone,
            email: normalizedEmail,
          },
          tx
        );

        const selectedRoute = await findBestRouteForCity(cityId || null, new Date(), tx);

        // Usar upsertOrder para actualizar
        const updated = await upsertOrder(
          {
            customerName: safeName,
            customerEmail: normalizedEmail,
            customerPhone: normalizedPhone,
            customerCompany: safeCompany,
            cityId: cityId || null,
            routeId: selectedRoute?.id || null,
            notes: safeNotes,
            agentId: customerResult.assignedAgentId || null,
            subtotal,
            sentVia: sentVia || null,
            items: validatedItems.map((item) => ({
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
          cartId,
          sessionId,
          customerResult.customer?.id || null,
          tx
        );

        return updated;
      });

      // Evita conflicto por unique(sessionId,status) cuando ya existe otro carrito convertido.
      await db.cart.update({
        where: { id: cartId },
        data: {
          status: "convertido",
          sessionId: null,
        },
      });

      // Intentar enviar a webhook (si cambiaron datos de contacto o monto)
      const webhookPayload = await buildWebhookPayload(order.id);
      if (webhookPayload && !order.webhookSent) {
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
              note: `Pedido actualizado y enviado via webhook${sentVia ? ` (${sentVia})` : ""}`,
            },
          });
        }
      }

      return NextResponse.json({
        success: true,
        data: { id: order.id, orderNumber: order.orderNumber, isUpdate: true },
        message: "Pedido actualizado exitosamente",
      });
    }

    // CREAR NUEVA ORDEN
    const newOrder = await createOrderTransactionWithRetry(async (tx) => {
      const customerResult = await upsertCheckoutCustomer(
        {
          name: safeName,
          phone: normalizedPhone,
          email: normalizedEmail,
        },
        tx
      );

      const selectedRoute = await findBestRouteForCity(cityId || null, new Date(), tx);

      const orderNumber = await generateOrderNumber(tx);

      const created = await upsertOrder(
        {
          orderNumber,
          customerName: safeName,
          customerEmail: normalizedEmail,
          customerPhone: normalizedPhone,
          customerCompany: safeCompany,
          cityId: cityId || null,
          routeId: selectedRoute?.id || null,
          notes: safeNotes,
          agentId: customerResult.assignedAgentId || null,
          subtotal,
          sentVia: sentVia || null,
          items: validatedItems.map((item) => ({
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
        cartId,
        sessionId,
        customerResult.customer?.id || null,
        tx
      );

      // Crear historial de estado
      await tx.orderStatusHistory.create({
        data: {
          orderId: created.id,
          fromStatus: null,
          toStatus: "solicitado",
          changedBy: "sistema",
          note: "Pedido creado desde carrito",
        },
      });

      // Evita conflicto por unique(sessionId,status) cuando ya existe otro carrito convertido.
      await tx.cart.update({
        where: { id: cartId },
        data: {
          status: "convertido",
          sessionId: null,
        },
      });

      return created;
    });

    // Always try sending to webhook (if configured in admin settings)
    const webhookPayload = await buildWebhookPayload(newOrder.id);
    if (webhookPayload) {
      const webhookResult = await sendToWebhook(webhookPayload);

      await db.order.update({
        where: { id: newOrder.id },
        data: {
          webhookSent: webhookResult.success,
          webhookResponse: webhookResult.response?.slice(0, 500),
          ...(webhookResult.success ? { status: "compartido" } : {}),
        },
      });

      if (webhookResult.success) {
        await db.orderStatusHistory.create({
          data: {
            orderId: newOrder.id,
            fromStatus: "solicitado",
            toStatus: "compartido",
            changedBy: "sistema",
            note: `Pedido creado y enviado via webhook${sentVia ? ` (${sentVia})` : ""}`,
          },
        });
      }
    }

    return NextResponse.json({
      success: true,
      data: { id: newOrder.id, orderNumber: newOrder.orderNumber, isUpdate: false },
      message: "Pedido creado exitosamente",
    });
  } catch (error) {
    console.error("Error managing order:", error);

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      if (error.code === "P2022") {
        return NextResponse.json(
          {
            success: false,
            error:
              "No pudimos procesar el pedido por una desalineación temporal de base de datos. Estamos trabajando para resolverlo.",
            code: error.code,
          },
          { status: 500 }
        );
      }

      if (error.code === "P2002") {
        const target = (error.meta?.target as string[] | undefined)?.join(",") || "";
        const isCartStatusConflict = target.includes("Cart_sessionId_status_key");

        return NextResponse.json(
          {
            success: false,
            error: isCartStatusConflict
              ? "Detectamos un conflicto temporal al convertir el carrito. Intentá nuevamente."
              : "Ya existe un pedido activo asociado. Intentá de nuevo en unos segundos.",
            code: error.code,
          },
          { status: 409 }
        );
      }
    }

    return NextResponse.json(
      { success: false, error: "Error al procesar el pedido" },
      { status: 500 }
    );
  }
}
