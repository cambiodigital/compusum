import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdminApi } from "@/lib/auth";
import { normalizeProductImagePath } from "@/lib/product-fallbacks";

export async function POST(request: Request) {
  try {
    const { error } = await requireAdminApi();
    if (error) return error;

    const body = await request.json();
    const productId = typeof body.productId === "string" ? body.productId.trim() : "";
    const imagePath = normalizeProductImagePath(body.imagePath);

    if (!productId || !imagePath) {
      return NextResponse.json(
        { success: false, error: "productId e imagePath son requeridos" },
        { status: 400 }
      );
    }

    const product = await db.product.findUnique({
      where: { id: productId },
      select: { id: true },
    });

    if (!product) {
      return NextResponse.json({ success: false, error: "Producto no encontrado" }, { status: 404 });
    }

    const hasAnyImage = await db.productImage.count({ where: { productId } });
    const created = await db.productImage.create({
      data: {
        productId,
        imagePath,
        isPrimary: hasAnyImage === 0,
        sortOrder: hasAnyImage,
      },
      select: { id: true, imagePath: true, isPrimary: true, sortOrder: true },
    });

    return NextResponse.json({ success: true, data: created });
  } catch (error) {
    console.error("Assign image error:", error);
    return NextResponse.json(
      { success: false, error: "Error al asignar imagen al producto" },
      { status: 500 }
    );
  }
}
