import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdminApi } from "@/lib/auth";

interface RouteParams {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  try {
    const { error } = await requireAdminApi();
    if (error) return error;

    const { id } = await params;

    const source = await db.cart.findUnique({
      where: { id },
      include: { items: true },
    });

    if (!source) {
      return NextResponse.json({ success: false, error: "Carrito no encontrado" }, { status: 404 });
    }

    const subtotal = source.items.reduce(
      (sum, item) => sum + (item.unitPrice ?? 0) * item.quantity,
      0
    );

    const newCart = await db.cart.create({
      data: {
        customerName: source.customerName,
        customerEmail: source.customerEmail,
        customerPhone: source.customerPhone,
        customerCompany: source.customerCompany,
        cityId: source.cityId,
        notes: source.notes,
        status: "activo",
        isActive: true,
        subtotal,
        items: {
          create: source.items.map((item) => ({
            productId: item.productId,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
          })),
        },
      },
      include: {
        items: {
          include: {
            product: {
              include: {
                brand: { select: { name: true } },
                category: { select: { name: true } },
              },
            },
          },
        },
      },
    });

    return NextResponse.json({ success: true, data: newCart, message: "Carrito duplicado" });
  } catch (error) {
    console.error("Error duplicating cart:", error);
    return NextResponse.json({ success: false, error: "Error al duplicar carrito" }, { status: 500 });
  }
}
