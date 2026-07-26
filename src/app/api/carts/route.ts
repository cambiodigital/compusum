import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { upsertCart, upsertActiveCart } from "@/lib/order-cart-upsert";
import { getCurrentUser } from "@/lib/auth";
import { validateAndPriceItems, CartValidationError } from "@/lib/cart-validation";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { 
      items, 
      customerName, 
      customerEmail, 
      customerPhone, 
      customerCompany, 
      cityId, 
      notes,
      action = "save" // "save" | "add" | "update" | "remove"
    } = body;

    // Obtener sessionId del header (viene del middleware)
    const sessionId = request.headers.get("x-session-id");

    // Resolver userId si el visitante tiene sesión activa
    const currentUser = await getCurrentUser();
    const userId = currentUser?.id ?? null;

    let validatedResult;
    try {
      validatedResult = await validateAndPriceItems(items);
    } catch (err) {
      if (err instanceof CartValidationError) {
        return NextResponse.json(
          { success: false, error: err.message },
          { status: 400 }
        );
      }
      throw err;
    }

    const { validatedItems } = validatedResult;

    // Obtener o crear carrito activo
    let cart = await upsertActiveCart(sessionId, userId, cityId);

    // Eliminar items anteriores (para una limpieza completa) o actualizar según action
    if (action === "save") {
      // Reemplazar todos los items
      await db.cartItem.deleteMany({
        where: { cartId: cart.id },
      });

      // Deduplicar por (productId, variantId) para evitar violaciones de índice único
      const itemMap = new Map<string, typeof validatedItems[number]>();
      for (const item of validatedItems) {
        const key = `${item.productId}::${item.variantId ?? "base"}`;
        itemMap.set(key, item);
      }
      const deduplicatedItems = Array.from(itemMap.values());

      // Crear nuevos items con datos y precios validados en servidor
      await db.cartItem.createMany({
        data: deduplicatedItems.map((item) => ({
          cartId: cart.id,
          productId: item.productId,
          variantId: item.variantId,
          variantName: item.variantName,
          variantCode: item.variantCode,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        })),
      });
    } else if (action === "add") {
      // Agregar items (sin eliminar anteriores)
      const itemsToAdd = validatedItems.filter((newItem) => {
        const exists = cart.items?.some(
          (existing) =>
            existing.productId === newItem.productId &&
            (existing.variantId ?? null) === (newItem.variantId ?? null)
        );
        return !exists;
      });

      if (itemsToAdd.length > 0) {
        await db.cartItem.createMany({
          data: itemsToAdd.map((item) => ({
            cartId: cart.id,
            productId: item.productId,
            variantId: item.variantId,
            variantName: item.variantName,
            variantCode: item.variantCode,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
          })),
        });
      }

      // Actualizar cantidades y precios validados de items existentes
      for (const item of validatedItems) {
        const existing = cart.items?.find(
          (ci) =>
            ci.productId === item.productId &&
            (ci.variantId ?? null) === (item.variantId ?? null)
        );
        if (existing) {
          await db.cartItem.update({
            where: { id: existing.id },
            data: {
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              variantName: item.variantName,
              variantCode: item.variantCode,
            },
          });
        }
      }
    } else if (action === "update") {
      // Actualizar items específicos sin eliminar
      for (const item of validatedItems) {
        const existing = cart.items?.find(
          (ci) =>
            ci.productId === item.productId &&
            (ci.variantId ?? null) === (item.variantId ?? null)
        );
        if (existing) {
          await db.cartItem.update({
            where: { id: existing.id },
            data: {
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              variantName: item.variantName,
              variantCode: item.variantCode,
            },
          });
        }
      }
    }

    // Recalcular el subtotal total del carrito directamente desde los ítems en base de datos
    const allCartItems = await db.cartItem.findMany({
      where: { cartId: cart.id },
    });
    const subtotal = allCartItems.reduce(
      (sum, item) => sum + (item.unitPrice || 0) * item.quantity,
      0
    );

    // Actualizar datos del carrito
    cart = await db.cart.update({
      where: { id: cart.id },
      data: {
        customerName: customerName || undefined,
        customerEmail: customerEmail || undefined,
        customerPhone: customerPhone || undefined,
        customerCompany: customerCompany || undefined,
        notes: notes || undefined,
        subtotal,
        updatedAt: new Date(),
      },
      include: { items: true },
    });

    return NextResponse.json({
      success: true,
      data: { 
        id: cart.id, 
        uuid: cart.uuid,
        itemCount: cart.items.length,
        subtotal: cart.subtotal,
      },
      message: "Carrito actualizado exitosamente",
    });
  } catch (error) {
    console.error("Error managing cart:", error);
    return NextResponse.json(
      { success: false, error: "Error al guardar el carrito" },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  try {
    const sessionId = request.headers.get("x-session-id");
    const currentUser = await getCurrentUser();
    const userId = currentUser?.id ?? null;
    const cartUuid = request.nextUrl.searchParams.get("uuid");
    const cartId = request.nextUrl.searchParams.get("id");

    let cart: Prisma.CartGetPayload<{
      include: { items: { include: { product: true } } };
    }> | null = null;

    // Obtener por UUID (puede ser un carrito compartido)
    if (cartUuid) {
      cart = await db.cart.findUnique({
        where: { uuid: cartUuid },
        include: { items: { include: { product: true } } },
      });
    }
    // Obtener por ID
    else if (cartId) {
      cart = await db.cart.findUnique({
        where: { id: cartId },
        include: { items: { include: { product: true } } },
      });
    }
    // Obtener carrito activo de la sesión/usuario
    else {
      const orConditions: Array<{ sessionId?: string | null; userId?: string; status: string }> = [];
      if (sessionId) orConditions.push({ sessionId, status: 'activo' });
      if (userId) orConditions.push({ userId, status: 'activo' });

      if (orConditions.length === 0) {
        return NextResponse.json({ success: true, data: null }, { status: 200 });
      }

      cart = await db.cart.findFirst({
        where: { OR: orConditions },
        include: { items: { include: { product: true } } },
      });
    }

    if (!cart) {
      if (cartUuid || cartId) {
        return NextResponse.json(
          { success: false, error: "Carrito no encontrado" },
          { status: 404 }
        );
      }

      return NextResponse.json(
        { success: true, data: null },
        { status: 200 }
      );
    }

    // Validar propiedad si se solicitó un carrito específico por id o uuid
    if (cartUuid || cartId) {
      const userRole = currentUser?.role ?? null;
      const isAdminOrAgent = userRole === "admin" || userRole === "AGENT";
      const isOwner = (cart.sessionId && cart.sessionId === sessionId) || (userId && cart.userId === userId);
      const isShared = cart.status === "compartido";

      if (!isAdminOrAgent && !isShared && !isOwner) {
        return NextResponse.json(
          { success: false, error: "No tienes permiso para acceder a este carrito" },
          { status: 403 }
        );
      }
    }

    return NextResponse.json({
      success: true,
      data: cart,
    });
  } catch (error) {
    console.error("Error fetching cart:", error);
    return NextResponse.json(
      { success: false, error: "Error al obtener el carrito" },
      { status: 500 }
    );
  }
}
