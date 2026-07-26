import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { isGlobalCatalogModeEnabled, sanitizeProductsForCatalog } from '@/lib/catalog-mode';

// GET /api/seasons/[slug] - Get season with products
export async function GET(
  request: Request,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await params;
    const { searchParams } = new URL(request.url);
    const page = parseInt(searchParams.get('page') || '1');
    const limit = parseInt(searchParams.get('limit') || '12');
    const skip = (page - 1) * limit;

    // Find season
    const season = await db.season.findUnique({
      where: {
        slug,
        isActive: true,
      },
    });

    if (!season) {
      return NextResponse.json(
        { success: false, error: 'Temporada no encontrada' },
        { status: 404 }
      );
    }

    // Get products in season
    const [isCatalogMode, [products, total]] = await Promise.all([
      isGlobalCatalogModeEnabled(),
      Promise.all([
        db.product.findMany({
          where: {
            seasons: {
              some: {
                seasonId: season.id,
              },
            },
            isActive: true,
          },
          select: {
            id: true,
            name: true,
            slug: true,
            sku: true,
            price: true,
            wholesalePrice: true,
            minWholesaleQty: true,
            stockStatus: true,
            isFeatured: true,
            isNew: true,
            catalogMode: true,
            category: { select: { id: true, name: true, slug: true, catalogMode: true } },
            brand: { select: { id: true, name: true, slug: true, catalogMode: true } },
            images: {
              where: { isPrimary: true },
              take: 1,
              select: { imagePath: true, thumbnailPath: true, altText: true },
            },
          },
          orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
          skip,
          take: limit,
        }),
        db.product.count({
          where: {
            seasons: {
              some: {
                seasonId: season.id,
              },
            },
            isActive: true,
          },
        }),
      ]),
    ]);

    const sanitizedProducts = sanitizeProductsForCatalog(products, isCatalogMode);

    return NextResponse.json({
      success: true,
      data: {
        season,
        products: sanitizedProducts,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      },
    });
  } catch (error) {
    console.error('Error fetching season:', error);
    return NextResponse.json(
      { success: false, error: 'Error al obtener la temporada' },
      { status: 500 }
    );
  }
}
