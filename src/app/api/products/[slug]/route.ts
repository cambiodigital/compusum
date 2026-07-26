import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { isGlobalCatalogModeEnabled, sanitizeProductForCatalog } from '@/lib/catalog-mode';

// GET /api/products/[slug] - Get product by slug
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await params;

    const [isCatalogMode, product] = await Promise.all([
      isGlobalCatalogModeEnabled(),
      db.product.findUnique({
        where: {
          slug,
          isActive: true,
        },
        include: {
          category: true,
          brand: true,
          images: {
            orderBy: { sortOrder: 'asc' },
          },
          seasons: {
            include: {
              season: true,
            },
          },
          variants: {
            where: { isActive: true },
            orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
          },
        },
      }),
    ]);

    if (!product) {
      return NextResponse.json(
        { success: false, error: 'Producto no encontrado' },
        { status: 404 }
      );
    }

    // Increment view count
    await db.product.update({
      where: { id: product.id },
      data: { viewsCount: { increment: 1 } },
    });

    const sanitizedProduct = sanitizeProductForCatalog(product, isCatalogMode);

    return NextResponse.json({
      success: true,
      data: sanitizedProduct,
    });
  } catch (error) {
    console.error('Error fetching product:', error);
    return NextResponse.json(
      { success: false, error: 'Error al obtener el producto' },
      { status: 500 }
    );
  }
}
