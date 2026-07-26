import { NextResponse } from 'next/server';
import { revalidateTag } from 'next/cache';
import { db } from '@/lib/db';
import { requireAdminApi } from '@/lib/auth';

// PUT /api/admin/products/[id] - Update product (for admin)
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { error } = await requireAdminApi();
    if (error) return error;

    const { id } = await params;
    const body = await request.json();

    const {
      name,
      slug,
      sku,
      description,
      shortDescription,
      categoryId,
      brandId,
      price,
      wholesalePrice,
      minWholesaleQty,
      stockStatus,
      isFeatured,
      isNew,
      isActive,
      catalogMode,
      tags,
      sortOrder,
      metaTitle,
      metaDescription,
      seasonIds,
      images,
    } = body;

    // Check if product exists
    const existingProduct = await db.product.findUnique({
      where: { id },
    });

    if (!existingProduct) {
      return NextResponse.json(
        { success: false, error: 'Producto no encontrado' },
        { status: 404 }
      );
    }

    // Update product
    const product = await db.product.update({
      where: { id },
      data: {
        name,
        slug,
        sku,
        description,
        shortDescription,
        categoryId,
        brandId: brandId || null,
        price: price !== undefined ? (price ? parseFloat(price) : null) : undefined,
        wholesalePrice: wholesalePrice !== undefined ? (wholesalePrice ? parseFloat(wholesalePrice) : null) : undefined,
        minWholesaleQty,
        stockStatus,
        isFeatured,
        isNew,
        isActive,
        catalogMode,
        tags,
        sortOrder,
        metaTitle,
        metaDescription,
        // Update seasons if provided
        ...(seasonIds !== undefined && {
          seasons: {
            deleteMany: {},
            create: seasonIds.map((seasonId: string) => ({
              seasonId,
            })),
          },
        }),
        // Update images if provided
        ...(images !== undefined && {
          images: {
            deleteMany: {},
            create: images.map((img: { imagePath: string; isPrimary: boolean }, index: number) => ({
              imagePath: img.imagePath,
              isPrimary: img.isPrimary,
              sortOrder: index,
            })),
          },
        }),
      },
      include: {
        category: true,
        brand: true,
        images: true,
        seasons: {
          include: {
            season: true,
          },
        },
      },
    });

    // Invalidate product caches
    revalidateTag("products");
    revalidateTag("featured-products");
    revalidateTag("new-products");
    if (existingProduct.slug) {
      revalidateTag(`product-${existingProduct.slug}`);
    }
    if (slug && slug !== existingProduct.slug) {
      revalidateTag(`product-${slug}`);
    }

    return NextResponse.json({
      success: true,
      data: product,
      message: 'Producto actualizado exitosamente',
    });
  } catch (error: any) {
    console.error('Error updating product:', error);
    if (error.code === 'P2002') {
      return NextResponse.json(
        { success: false, error: 'Ya existe un producto con este slug o SKU' },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { success: false, error: 'Error al actualizar el producto' },
      { status: 500 }
    );
  }
}

// DELETE /api/admin/products/[id] - Delete product (for admin)
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { error } = await requireAdminApi();
    if (error) return error;

    const { id } = await params;

    // Check if product exists
    const existingProduct = await db.product.findUnique({
      where: { id },
    });

    if (!existingProduct) {
      return NextResponse.json(
        { success: false, error: 'Producto no encontrado' },
        { status: 404 }
      );
    }

    // Delete product (cascade will delete images and season relations)
    await db.product.delete({
      where: { id },
    });

    // Invalidate product caches
    revalidateTag("products");
    revalidateTag("featured-products");
    revalidateTag("new-products");
    revalidateTag(`product-${existingProduct.slug}`);

    return NextResponse.json({
      success: true,
      message: 'Producto eliminado exitosamente',
    });
  } catch (error) {
    console.error('Error deleting product:', error);
    return NextResponse.json(
      { success: false, error: 'Error al eliminar el producto' },
      { status: 500 }
    );
  }
}
