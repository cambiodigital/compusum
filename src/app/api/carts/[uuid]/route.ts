import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { getCurrentUser } from "@/lib/auth";

interface RouteParams {
  params: Promise<{ uuid: string }>;
}

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
                brand: { select: { name: true, slug: true } },
                category: { select: { name: true, slug: true } },
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

    if (!cart || !cart.isActive) {
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

    const isOwner = (cart.sessionId && cart.sessionId === sessionId) || (userId && cart.userId === userId);
    const isShared = cart.status === "compartido";

    if (!isAdminOrAgent && !isShared && !isOwner) {
      return NextResponse.json(
        { success: false, error: "No tienes permiso para acceder a este carrito" },
        { status: 403 }
      );
    }

    return NextResponse.json({ success: true, data: cart });
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
    const { items, customerName, customerEmail, customerPhone, customerCompany, cityId, notes } = body;

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

    // Calculate subtotal
    let subtotal = 0;
    if (items) {
      for (const item of items) {
        if (item.unitPrice) subtotal += item.unitPrice * item.quantity;
      }
    }

    const cart = await db.cart.update({
      where: { uuid },
      data: {
        customerName,
        customerEmail,
        customerPhone,
        customerCompany,
        cityId: cityId || null,
        notes,
        subtotal,
        ...(items
          ? {
              items: {
                deleteMany: {},
                create: items.map((item: { productId: string; variantId?: string | null; variantName?: string | null; variantCode?: string | null; quantity: number; unitPrice?: number }) => ({
                  productId: item.productId,
                  variantId: item.variantId || null,
                  variantName: item.variantName || null,
                  variantCode: item.variantCode || null,
                  quantity: item.quantity,
                  unitPrice: item.unitPrice || null,
                })),
              },
            }
          : {}),
      },
      include: { items: true },
    });

    return NextResponse.json({
      success: true,
      data: { id: cart.id, uuid: cart.uuid },
      message: "Carrito actualizado",
    });
  } catch (error) {
    console.error("Error updating cart:", error);
    return NextResponse.json(
      { success: false, error: "Error al actualizar el carrito" },
      { status: 500 }
    );
  }
}
