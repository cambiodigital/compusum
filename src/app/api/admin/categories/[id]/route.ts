import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdminApi } from "@/lib/auth";

interface Props {
  params: Promise<{ id: string }>;
}

// GET /api/admin/categories/[id] - Get a single category
export async function GET(request: Request, { params }: Props) {
  try {
    const { error } = await requireAdminApi();
    if (error) return error;

    const { id } = await params;

    const category = await db.category.findUnique({
      where: { id },
      include: {
        _count: {
          select: { products: true },
        },
      },
    });

    if (!category) {
      return NextResponse.json(
        { success: false, error: "Categoría no encontrada" },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      data: category,
    });
  } catch (error) {
    console.error("Error fetching category:", error);
    return NextResponse.json(
      { success: false, error: "Error al obtener la categoría" },
      { status: 500 }
    );
  }
}

// PUT /api/admin/categories/[id] - Update a category
export async function PUT(request: Request, { params }: Props) {
  try {
    const { error } = await requireAdminApi();
    if (error) return error;

    const { id } = await params;
    const body = await request.json();
    const { name, slug, description, image, icon, sortOrder, isActive, catalogMode } = body;

    // Check if category exists
    const existingCategory = await db.category.findUnique({
      where: { id },
    });

    if (!existingCategory) {
      return NextResponse.json(
        { success: false, error: "Categoría no encontrada" },
        { status: 404 }
      );
    }

    // Check if new slug conflicts with another category
    if (slug && slug !== existingCategory.slug) {
      const slugConflict = await db.category.findUnique({
        where: { slug },
      });

      if (slugConflict) {
        return NextResponse.json(
          { success: false, error: "Ya existe otra categoría con ese slug" },
          { status: 400 }
        );
      }
    }

    const category = await db.category.update({
      where: { id },
      data: {
        name: name ?? existingCategory.name,
        slug: slug ?? existingCategory.slug,
        description: description ?? null,
        image: image ?? null,
        icon: icon ?? null,
        sortOrder: sortOrder ?? existingCategory.sortOrder,
        isActive: isActive ?? existingCategory.isActive,
        catalogMode: catalogMode ?? existingCategory.catalogMode,
      },
    });

    return NextResponse.json({
      success: true,
      data: category,
      message: "Categoría actualizada exitosamente",
    });
  } catch (error) {
    console.error("Error updating category:", error);
    return NextResponse.json(
      { success: false, error: "Error al actualizar la categoría" },
      { status: 500 }
    );
  }
}

// DELETE /api/admin/categories/[id] - Delete a category
export async function DELETE(request: Request, { params }: Props) {
  try {
    const { error } = await requireAdminApi();
    if (error) return error;

    const { id } = await params;

    // Check if category has products
    const productsCount = await db.product.count({
      where: { categoryId: id },
    });

    if (productsCount > 0) {
      return NextResponse.json(
        {
          success: false,
          error: `No se puede eliminar. La categoría tiene ${productsCount} producto(s) asociado(s). Mueve los productos a otra categoría primero.`,
        },
        { status: 400 }
      );
    }

    await db.category.delete({
      where: { id },
    });

    return NextResponse.json({
      success: true,
      message: "Categoría eliminada exitosamente",
    });
  } catch (error) {
    console.error("Error deleting category:", error);
    return NextResponse.json(
      { success: false, error: "Error al eliminar la categoría" },
      { status: 500 }
    );
  }
}
