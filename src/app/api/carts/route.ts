import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";
import { getCurrentUser } from "@/lib/auth";
import { CartValidationError } from "@/lib/cart-validation";
import { CartMutationError } from "@/lib/order-cart-upsert";
import { saveCartChanges, clearActiveCarts } from "@/lib/cart-mutations";
import { attachResolvedPricesToCartItems } from "@/lib/pricing";
import { getSessionPricingContext } from "@/lib/pricing-context";

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
      action = "save" // "save" | "add" | "update" | "clear" | "remove"
    } = body;

    // Obtener sessionId del header (viene del middleware)
    const sessionId = request.headers.get("x-session-id");

    // Resolver userId si el visitante tiene sesión activa
    const currentUser = await getCurrentUser();
    const userId = currentUser?.id ?? null;
    const userRole = currentUser?.role ?? null;
    // Mismo quirk de caso que GET/PUT: 'admin' minúscula o 'AGENT' mayúscula.
    const isAdminOrAgent = userRole === "admin" || userRole === "AGENT";

    // La lógica vive en el servicio: única disciplina de mutación (tx + lock
    // + re-lectura autoritativa del carrito antes de escribir).
    const result = await saveCartChanges({
      viewer: { sessionId, userId, isAdminOrAgent },
      action,
      items,
      cityId,
      customerName,
      customerEmail,
      customerPhone,
      customerCompany,
      notes,
      currentUser,
    });

    // El mensaje "vaciado" corresponde EXACTAMENTE a la rama de vaciado del
    // servicio (items ausentes/vacíos con action save|clear): un action
    // 'clear' CON items recorre el tail normal de metadata+subtotal y
    // responde "Carrito actualizado exitosamente".
    const isEmptyClear = !items || !Array.isArray(items) || items.length === 0;

    return NextResponse.json({
      success: true,
      data: {
        id: result.id,
        uuid: result.uuid,
        itemCount: result.itemCount,
        subtotal: result.subtotal,
      },
      message: isEmptyClear
        ? "Carrito vaciado exitosamente"
        : "Carrito actualizado exitosamente",
    });
  } catch (error) {
    if (error instanceof CartValidationError) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 400 }
      );
    }
    if (error instanceof CartMutationError) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: error.status }
      );
    }
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

    // Motor único de precios: cada item expone resolvedPrice del VISOR
    // (sesión server-side). Nunca se expone el precio de perfil de otro usuario.
    const pricingCtx = await getSessionPricingContext();
    const pricedCart = await attachResolvedPricesToCartItems(cart, pricingCtx);

    return NextResponse.json({
      success: true,
      data: pricedCart,
    });
  } catch (error) {
    console.error("Error fetching cart:", error);
    return NextResponse.json(
      { success: false, error: "Error al obtener el carrito" },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const sessionId = request.headers.get("x-session-id");
    const currentUser = await getCurrentUser();
    const userId = currentUser?.id ?? null;
    const userRole = currentUser?.role ?? null;
    const isAdminOrAgent = userRole === "admin" || userRole === "AGENT";

    // Semántica HEAD exacta: SOLO el caso sin sesión ni cuenta responde
    // "Sin carrito activo para vaciar"; con sesión/cuenta la respuesta es
    // "Carrito vaciado exitosamente" haya o no carrito activo que vaciar.
    if (!sessionId && !userId) {
      return NextResponse.json({ success: true, message: "Sin carrito activo para vaciar" });
    }

    await clearActiveCarts({ sessionId, userId, isAdminOrAgent });

    return NextResponse.json({
      success: true,
      message: "Carrito vaciado exitosamente",
    });
  } catch (error) {
    if (error instanceof CartMutationError) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: error.status }
      );
    }
    console.error("Error clearing cart:", error);
    return NextResponse.json(
      { success: false, error: "Error al vaciar el carrito" },
      { status: 500 }
    );
  }
}
