import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdminApi } from "@/lib/auth";

type CategoryBulkScope = "selected" | "list" | "all";

type CategoryBulkDeleteBody = {
  scope?: CategoryBulkScope;
  ids?: string[];
};

// POST /api/admin/categories - Create a new category
export async function POST(request: Request) {
  try {
    const { error } = await requireAdminApi();
    if (error) return error;

    const body = await request.json();
    const { name, slug, description, image, icon, sortOrder, isActive, catalogMode } = body;

    if (!name || !slug) {
      return NextResponse.json(
        { success: false, error: "Nombre y slug son requeridos" },
        { status: 400 }
      );
    }

    // Check if slug already exists
    const existingCategory = await db.category.findUnique({
      where: { slug },
    });

    if (existingCategory) {
      return NextResponse.json(
        { success: false, error: "Ya existe una categoría con ese slug" },
        { status: 400 }
      );
    }

    const category = await db.category.create({
      data: {
        name,
        slug,
        description: description || null,
        image: image || null,
        icon: icon || null,
        sortOrder: sortOrder || 0,
        isActive: isActive ?? true,
        catalogMode: catalogMode ?? false,
      },
    });

    return NextResponse.json({
      success: true,
      data: category,
      message: "Categoría creada exitosamente",
    });
  } catch (error) {
    console.error("Error creating category:", error);
    return NextResponse.json(
      { success: false, error: "Error al crear la categoría" },
      { status: 500 }
    );
  }
}

// DELETE /api/admin/categories - Bulk delete categories
export async function DELETE(request: Request) {
  try {
    const { error } = await requireAdminApi();
    if (error) return error;

    const body = (await request.json()) as CategoryBulkDeleteBody;
    const scope = body.scope ?? "selected";
    let targetIds = Array.isArray(body.ids) ? body.ids.filter(Boolean) : [];

    if (scope === "list" || scope === "all") {
      const categories = await db.category.findMany({
        select: { id: true },
      });
      targetIds = categories.map((category) => category.id);
    }

    targetIds = Array.from(new Set(targetIds));

    if (targetIds.length === 0) {
      return NextResponse.json(
        { success: false, error: "No hay categorías seleccionadas para eliminar" },
        { status: 400 }
      );
    }

    const blocked: Array<{ id: string; reason: string }> = [];
    const toDelete: string[] = [];

    const counts = await db.product.groupBy({
      by: ["categoryId"],
      where: { categoryId: { in: targetIds } },
      _count: { _all: true },
    });

    const countsMap = new Map(
      counts
        .filter((item) => item.categoryId)
        .map((item) => [item.categoryId as string, item._count._all])
    );

    for (const id of targetIds) {
      const productsCount = countsMap.get(id) || 0;
      if (productsCount > 0) {
        blocked.push({
          id,
          reason: `Tiene ${productsCount} producto(s) asociado(s)`,
        });
      } else {
        toDelete.push(id);
      }
    }

    const deleteResult =
      toDelete.length > 0
        ? await db.category.deleteMany({
            where: { id: { in: toDelete } },
          })
        : { count: 0 };

    return NextResponse.json({
      success: deleteResult.count > 0,
      data: {
        requestedCount: targetIds.length,
        deletedCount: deleteResult.count,
        blockedCount: blocked.length,
        blocked,
      },
      message:
        blocked.length === 0
          ? `Se eliminaron ${deleteResult.count} categoría(s)`
          : `Se eliminaron ${deleteResult.count} categoría(s) y ${blocked.length} quedaron bloqueadas`,
    });
  } catch (error) {
    console.error("Error bulk deleting categories:", error);
    return NextResponse.json(
      { success: false, error: "Error al eliminar categorías" },
      { status: 500 }
    );
  }
}
