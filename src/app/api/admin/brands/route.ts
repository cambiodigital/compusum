import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { requireAdminApi } from "@/lib/auth";

type BrandBulkScope = "selected" | "list" | "all";

type BrandBulkDeleteBody = {
  scope?: BrandBulkScope;
  ids?: string[];
};

// POST /api/admin/brands - Create a new brand
export async function POST(request: Request) {
  try {
    const { error } = await requireAdminApi();
    if (error) return error;

    const body = await request.json();
    const { name, slug, description, logo, website, sortOrder, isActive, catalogMode } = body;

    if (!name || !slug) {
      return NextResponse.json(
        { success: false, error: "Nombre y slug son requeridos" },
        { status: 400 }
      );
    }

    // Check if slug already exists
    const existingBrand = await db.brand.findUnique({
      where: { slug },
    });

    if (existingBrand) {
      return NextResponse.json(
        { success: false, error: "Ya existe una marca con ese slug" },
        { status: 400 }
      );
    }

    const brand = await db.brand.create({
      data: {
        name,
        slug,
        description: description || null,
        logo: logo || null,
        website: website || null,
        sortOrder: sortOrder || 0,
        isActive: isActive ?? true,
        catalogMode: catalogMode ?? false,
      },
    });

    return NextResponse.json({
      success: true,
      data: brand,
      message: "Marca creada exitosamente",
    });
  } catch (error) {
    console.error("Error creating brand:", error);
    return NextResponse.json(
      { success: false, error: "Error al crear la marca" },
      { status: 500 }
    );
  }
}

// DELETE /api/admin/brands - Bulk delete brands
export async function DELETE(request: Request) {
  try {
    const { error } = await requireAdminApi();
    if (error) return error;

    const body = (await request.json()) as BrandBulkDeleteBody;
    const scope = body.scope ?? "selected";
    let targetIds = Array.isArray(body.ids) ? body.ids.filter(Boolean) : [];

    if (scope === "list" || scope === "all") {
      const brands = await db.brand.findMany({
        select: { id: true },
      });
      targetIds = brands.map((brand) => brand.id);
    }

    targetIds = Array.from(new Set(targetIds));

    if (targetIds.length === 0) {
      return NextResponse.json(
        { success: false, error: "No hay marcas seleccionadas para eliminar" },
        { status: 400 }
      );
    }

    const blocked: Array<{ id: string; reason: string }> = [];
    const toDelete: string[] = [];

    const counts = await db.product.groupBy({
      by: ["brandId"],
      where: { brandId: { in: targetIds } },
      _count: { _all: true },
    });

    const countsMap = new Map(
      counts
        .filter((item) => item.brandId)
        .map((item) => [item.brandId as string, item._count._all])
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
        ? await db.brand.deleteMany({
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
          ? `Se eliminaron ${deleteResult.count} marca(s)`
          : `Se eliminaron ${deleteResult.count} marca(s) y ${blocked.length} quedaron bloqueadas`,
    });
  } catch (error) {
    console.error("Error bulk deleting brands:", error);
    return NextResponse.json(
      { success: false, error: "Error al eliminar marcas" },
      { status: 500 }
    );
  }
}
