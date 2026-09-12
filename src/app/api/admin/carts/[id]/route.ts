import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdminApi } from "@/lib/auth";
import { validateAndPriceItems, CartValidationError } from "@/lib/cart-validation";
import { lockCartForMutation, CartMutationError } from "@/lib/order-cart-upsert";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/** Visor de administración: bypasea ownership (la ruta ya exigió admin). */
const ADMIN_VIEWER = { sessionId: null, userId: null, isAdminOrAgent: true } as const;

export async function GET(request: NextRequest, { params }: RouteParams) {
  try {
    const { error } = await requireAdminApi();
    if (error) return error;

    const { id } = await params;

    const cart = await db.cart.findUnique({
      where: { id },
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
        city: { include: { department: true, shippingRoute: true } },
        orders: { select: { id: true, orderNumber: true, status: true, createdAt: true } },
      },
    });

    if (!cart) {
      return NextResponse.json({ success: false, error: "Carrito no encontrado" }, { status: 404 });
    }

    return NextResponse.json({ success: true, data: cart });
  } catch (error) {
    console.error("Error fetching cart:", error);
    return NextResponse.json({ success: false, error: "Error al obtener carrito" }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: RouteParams) {
  try {
    const { error } = await requireAdminApi();
    if (error) return error;

    const { id } = await params;
    const body = await request.json();
    const { isActive, status, customerName, customerEmail, customerPhone, customerCompany, cityId, notes, items } = body;

    const data: Record<string, unknown> = {};
    if (typeof isActive === "boolean") data.isActive = isActive;
    if (status) data.status = status;
    if (customerName !== undefined) data.customerName = customerName || null;
    if (customerEmail !== undefined) data.customerEmail = customerEmail || null;
    if (customerPhone !== undefined) data.customerPhone = customerPhone || null;
    if (customerCompany !== undefined) data.customerCompany = customerCompany || null;
    if (cityId !== undefined) data.cityId = cityId || null;
    if (notes !== undefined) data.notes = notes || null;

    if (items && Array.isArray(items)) {
      try {
        const cart = await db.$transaction(async (tx) => {
          // Única disciplina de mutación: lock + revalidación del carrito
          // (convertido concurrentemente => 409, cero writes).
          const lockedCart = await lockCartForMutation(tx, id, ADMIN_VIEWER);

          // Motor único de precios: el precio se resuelve server-side con el
          // contexto del DUEÑO POST-lock del carrito (perfil del dueño o
          // precio base). El navegador no decide precios, ni siquiera en
          // administración; la edición monetaria de pedidos se hace
          // explícitamente en el PATCH del pedido.
          let ownerPricingCustomerId: string | null = null;
          if (lockedCart.userId) {
            const owner = await tx.user.findUnique({
              where: { id: lockedCart.userId },
              select: { id: true, role: true },
            });
            if (owner && owner.role.toLowerCase() === "customer") {
              ownerPricingCustomerId = owner.id;
            }
          }

          const { validatedItems, subtotal } = await validateAndPriceItems(
            items.map((item: { productId: string; variantId?: string | null; quantity: number }) => ({
              productId: item.productId,
              variantId: item.variantId ?? null,
              quantity: item.quantity,
            })),
            tx,
            { customerId: ownerPricingCustomerId }
          );

          await tx.cartItem.deleteMany({ where: { cartId: id } });
          return tx.cart.update({
            where: { id },
            data: {
              ...data,
              subtotal,
              items: {
                create: validatedItems.map((item) => ({
                  productId: item.productId,
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
        });

        return NextResponse.json({ success: true, data: cart, message: "Carrito actualizado" });
      } catch (err) {
        if (err instanceof CartValidationError) {
          return NextResponse.json(
            { success: false, error: err.message },
            { status: 400 }
          );
        }
        if (err instanceof CartMutationError) {
          return NextResponse.json(
            { success: false, error: err.message },
            { status: err.status }
          );
        }
        throw err;
      }
    }

    // Actualización de solo metadata: se serializa con FOR UPDATE (los
    // admins SÍ pueden editar metadata/estado de carritos NO activos, p.ej.
    // compartir o reactivar; el gate de status de lockCartForMutation los
    // rompería). El lock evita solo la carrera con writes concurrentes.
    const cart = await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Cart" WHERE id = ${id} FOR UPDATE`;
      return tx.cart.update({
        where: { id },
        data,
      });
    });

    return NextResponse.json({
      success: true,
      data: cart,
      message: "Carrito actualizado",
    });
  } catch (error) {
    if (error instanceof CartMutationError) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: error.status }
      );
    }
    console.error("Error updating cart:", error);
    return NextResponse.json({ success: false, error: "Error al actualizar carrito" }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest, { params }: RouteParams) {
  try {
    const { error } = await requireAdminApi();
    if (error) return error;

    const { id } = await params;

    const cart = await db.cart.findUnique({
      where: { id },
      include: { orders: { select: { id: true } } },
    });

    if (!cart) {
      return NextResponse.json({ success: false, error: "Carrito no encontrado" }, { status: 404 });
    }

    if (cart.orders.length > 0) {
      return NextResponse.json(
        { success: false, error: "No se puede eliminar un carrito con pedidos asociados" },
        { status: 400 }
      );
    }

    // Eliminación atómica: FOR UPDATE serializa con checkouts concurrentes y
    // el re-chequeo DENTRO de la tx garantiza que el carrito sigue sin
    // pedidos (un checkout pudo crear uno entre la lectura previa y el
    // delete). Sin gate de status: admins eliminan carritos en cualquier
    // estado mientras no tengan pedidos.
    try {
      await db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM "Cart" WHERE id = ${id} FOR UPDATE`;
        const orderCount = await tx.order.count({ where: { cartId: id } });
        if (orderCount > 0) {
          throw new CartMutationError(
            "CART_HAS_ORDERS",
            "No se puede eliminar un carrito con pedidos asociados",
            409
          );
        }
        await tx.cart.delete({ where: { id } });
      });
    } catch (err) {
      if (err instanceof CartMutationError) {
        return NextResponse.json(
          { success: false, error: err.message },
          { status: err.status }
        );
      }
      throw err;
    }

    return NextResponse.json({ success: true, message: "Carrito eliminado" });
  } catch (error) {
    console.error("Error deleting cart:", error);
    return NextResponse.json({ success: false, error: "Error al eliminar carrito" }, { status: 500 });
  }
}
