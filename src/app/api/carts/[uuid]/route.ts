import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";
import { CartValidationError } from "@/lib/cart-validation";
import { CartMutationError } from "@/lib/order-cart-upsert";
import { updateCartByUuid } from "@/lib/cart-mutations";
import {
  authorizeCartViewer,
  buildSharedCartDTO,
  getCartViewer,
} from "@/lib/shared-cart";
import { attachResolvedPricesToCartItems } from "@/lib/pricing";
import { getSessionPricingContext } from "@/lib/pricing-context";
import { isGlobalCatalogModeEnabled } from "@/lib/catalog-mode";

interface RouteParams {
  params: Promise<{ uuid: string }>;
}

/**
 * GET /api/carts/[uuid] — MISMA política y MISMO DTO que la página
 * /carrito/[uuid] (capability-link, ver src/lib/shared-cart.ts).
 * El visor ve SU precio autorizado; nunca el snapshot ni el perfil del dueño;
 * jamás email/teléfono del propietario.
 */
export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { uuid } = await params;

    const cart = await db.cart.findUnique({
      where: { uuid },
      include: {
        items: {
          include: {
            product: {
              include: {
                brand: { select: { name: true, slug: true, catalogMode: true } },
                category: { select: { name: true, slug: true, catalogMode: true } },
              },
            },
          },
        },
        city: {
          include: {
            department: true,
            shippingRoute: true,
          },
        },
      },
    });

    const viewer = await getCartViewer(request);
    const access = authorizeCartViewer(cart, viewer);

    if (!cart || !access.allowed) {
      return NextResponse.json(
        { success: false, error: "Carrito no encontrado" },
        { status: 404 }
      );
    }

    // Motor único de precios: resolvedPrice del VISOR (sesión server-side).
    const pricingCtx = await getSessionPricingContext();
    const pricedCart = await attachResolvedPricesToCartItems(cart, pricingCtx);
    const catalogMode = await isGlobalCatalogModeEnabled();
    const dto = buildSharedCartDTO(pricedCart, catalogMode);

    return NextResponse.json({
      success: true,
      data: { ...dto, canManage: access.canManage },
    });
  } catch (error) {
    console.error("Error fetching cart:", error);
    return NextResponse.json(
      { success: false, error: "Error al obtener el carrito" },
      { status: 500 }
    );
  }
}

export async function PUT(request: NextRequest, { params }: RouteParams) {
  try {
    const { uuid } = await params;
    const body = await request.json();
    const { items } = body;

    // Validación de forma: `items` debe ser arreglo o no venir. Un arreglo
    // VACÍO es semánticamente "vaciar el carrito" (elimina items y subtotal 0).
    if (items !== undefined && items !== null && !Array.isArray(items)) {
      return NextResponse.json(
        { success: false, error: "Formato de items inválido" },
        { status: 400 }
      );
    }

    const existingCart = await db.cart.findUnique({ where: { uuid } });
    if (!existingCart || !existingCart.isActive) {
      return NextResponse.json(
        { success: false, error: "Carrito no encontrado" },
        { status: 404 }
      );
    }

    // Validar propiedad del carrito
    const sessionId = request.headers.get("x-session-id");
    const currentUser = await getCurrentUser();
    const userId = currentUser?.id ?? null;
    const userRole = currentUser?.role ?? null;
    const isAdminOrAgent = userRole === "admin" || userRole === "AGENT";

    const isOwner = (existingCart.sessionId && existingCart.sessionId === sessionId) || (userId && existingCart.userId === userId);

    if (!isAdminOrAgent && !isOwner) {
      return NextResponse.json(
        { success: false, error: "No tienes permiso para modificar este carrito" },
        { status: 403 }
      );
    }

    // Only allow modification of active carts (not converted/shared/expired)
    if (existingCart.status !== "activo") {
      return NextResponse.json(
        { success: false, error: "Este carrito ya no se puede modificar" },
        { status: 403 }
      );
    }

    // Semántica de `items` (metadata-only / vaciar / reemplazar) vive en el
    // servicio: una única tx con lock autoritativo del carrito re-valida
    // estado y ownership POST-lock antes de escribir, y reprecia server-side
    // con el contexto del DUEÑO del carrito (nunca datos del navegador).
    const cart = await updateCartByUuid({
      uuid,
      viewer: { sessionId, userId, userRole },
      body,
    });

    return NextResponse.json({
      success: true,
      data: { id: cart.id, uuid: cart.uuid },
      message: "Carrito actualizado",
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
    console.error("Error updating cart:", error);
    return NextResponse.json(
      { success: false, error: "Error al actualizar el carrito" },
      { status: 500 }
    );
  }
}
