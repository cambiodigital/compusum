import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdminApi } from "@/lib/auth";

interface Props {
  params: Promise<{ id: string }>;
}

// GET /api/admin/brands/[id] - Get a single brand
export async function GET(request: Request, { params }: Props) {
  try {
    const { error } = await requireAdminApi();
    if (error) return error;

    const { id } = await params;

    const brand = await db.brand.findUnique({
      where: { id },
      include: {
        _count: {
          select: { products: true },
        },
      },
    });

    if (!brand) {
      return NextResponse.json(
        { success: false, error: "Marca no encontrada" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      data: brand,
    });
  } catch (error) {
    console.error("Error fetching brand:", error);
    return NextResponse.json(
      { success: false, error: "Error al obtener la marca" },
      { status: 500 }
    );
  }
}

// PUT /api/admin/brands/[id] - Update a brand
export async function PUT(request: Request, { params }: Props) {
  try {
    const { error } = await requireAdminApi();
    if (error) return error;

    const { id } = await params;
    const body = await request.json();
    const { name, slug, description, logo, website, sortOrder, isActive, catalogMode } = body;

    // Check if brand exists
    const existingBrand = await db.brand.findUnique({
      where: { id },
    });

    if (!existingBrand) {
      return NextResponse.json(
        { success: false, error: "Marca no encontrada" },
        { status: 404 }
      );
    }

    // Check if new slug conflicts with another brand
    if (slug && slug !== existingBrand.slug) {
      const slugConflict = await db.brand.findUnique({
        where: { slug },
      });

      if (slugConflict) {
        return NextResponse.json(
          { success: false, error: "Ya existe otra marca con ese slug" },
          { status: 400 }
        );
      }
    }

    const brand = await db.brand.update({
      where: { id },
      data: {
        name: name ?? existingBrand.name,
        slug: slug ?? existingBrand.slug,
        description: description ?? null,
        logo: logo ?? null,
        website: website ?? null,
        sortOrder: sortOrder ?? existingBrand.sortOrder,
        isActive: isActive ?? existingBrand.isActive,
        catalogMode: catalogMode ?? existingBrand.catalogMode,
      },
    });

    return NextResponse.json({
      success: true,
      data: brand,
      message: "Marca actualizada exitosamente",
    });
  } catch (error) {
    console.error("Error updating brand:", error);
    return NextResponse.json(
      { success: false, error: "Error al actualizar la marca" },
      { status: 500 }
    );
  }
}

// DELETE /api/admin/brands/[id] - Delete a brand
export async function DELETE(request: Request, { params }: Props) {
  try {
    const { error } = await requireAdminApi();
    if (error) return error;

    const { id } = await params;

    // Check if brand has products
    const productsCount = await db.product.count({
      where: { brandId: id },
    });

    if (productsCount > 0) {
      return NextResponse.json(
        {
          success: false,
          error: `No se puede eliminar. La marca tiene ${productsCount} producto(s) asociado(s).`,
        },
        { status: 400 }
      );
    }

    await db.brand.delete({
      where: { id },
    });

    return NextResponse.json({
      success: true,
      message: "Marca eliminada exitosamente",
    });
  } catch (error) {
    console.error("Error deleting brand:", error);
    return NextResponse.json(
      { success: false, error: "Error al eliminar la marca" },
      { status: 500 }
    );
  }
}
