import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCurrentUser } from '@/lib/auth';
import { searchProducts } from '@/lib/product-search';
import { isGlobalCatalogModeEnabled, sanitizeProductsForCatalog } from '@/lib/catalog-mode';

// GET /api/products - List products with filters
export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const category = searchParams.get('category');
    const brand = searchParams.get('brand');
    const search = searchParams.get('search');
    const featured = searchParams.get('featured');
    const isNew = searchParams.get('new');
    const page = parseInt(searchParams.get('page') || '1');
    const limit = Math.min(parseInt(searchParams.get('limit') || '12'), 100);

    // Resolve category IDs if filtering by slug
    let categoryIds: string[] | undefined;
    if (category) {
      const cat = await db.category.findFirst({ where: { slug: category } });
      if (cat) {
        const children = await db.category.findMany({
          where: { parentId: cat.id },
          select: { id: true },
        });
        categoryIds = [cat.id, ...children.map(c => c.id)];
      }
    }

    // Resolve brand ID if filtering by slug
    let brandId: string | undefined;
    if (brand) {
      const b = await db.brand.findFirst({ where: { slug: brand } });
      if (b) brandId = b.id;
    }

    const [isCatalogMode, result] = await Promise.all([
      isGlobalCatalogModeEnabled(),
      searchProducts(search || '', {
        limit,
        offset: (page - 1) * limit,
        categoryIds,
        brandId,
        isFeatured: featured === 'true' ? true : undefined,
        isNew: isNew === 'true' ? true : undefined,
        orderBy: search ? 'relevance' : 'createdAt',
      }),
    ]);

    const sanitizedProducts = sanitizeProductsForCatalog(result.products, isCatalogMode);

    return NextResponse.json({
      success: true,
      data: {
        products: sanitizedProducts,
        pagination: {
          page,
          limit,
          total: result.total,
          totalPages: Math.ceil(result.total / limit),
        },
      },
    });
  } catch (error) {
    console.error('Error fetching products:', error);
    return NextResponse.json(
      { success: false, error: 'Error al obtener los productos' },
      { status: 500 }
    );
  }
}

// POST /api/products - Create product (for admin)
export async function POST(request: Request) {
  try {
    // Check authentication
    const user = await getCurrentUser();
    if (!user) {
      return NextResponse.json(
        { success: false, error: 'No autenticado' },
        { status: 401 }
      );
    }

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
      tags,
      sortOrder,
      metaTitle,
      metaDescription,
      images,
      seasonIds,
    } = body;

    // Create product
    const product = await db.product.create({
      data: {
        name,
        slug,
        sku,
        description,
        shortDescription,
        categoryId,
        brandId,
        price: price ? parseFloat(price) : null,
        wholesalePrice: wholesalePrice ? parseFloat(wholesalePrice) : null,
        minWholesaleQty: minWholesaleQty || 1,
        stockStatus: stockStatus || 'disponible',
        isFeatured: isFeatured || false,
        isNew: isNew || false,
        isActive: isActive !== undefined ? isActive : true,
        tags,
        sortOrder: sortOrder || 0,
        metaTitle,
        metaDescription,
        ...(images && images.length > 0 && {
          images: {
            create: images.map((img: any, index: number) => ({
              imagePath: img.imagePath,
              thumbnailPath: img.thumbnailPath,
              altText: img.altText,
              isPrimary: img.isPrimary || index === 0,
              sortOrder: index,
            })),
          },
        }),
        ...(seasonIds && seasonIds.length > 0 && {
          seasons: {
            create: seasonIds.map((seasonId: string) => ({
              seasonId,
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

    return NextResponse.json({
      success: true,
      data: product,
      message: 'Producto creado exitosamente',
    });
  } catch (error: any) {
    console.error('Error creating product:', error);
    if (error.code === 'P2002') {
      return NextResponse.json(
        { success: false, error: 'Ya existe un producto con este slug o SKU' },
        { status: 400 }
      );
    }
    return NextResponse.json(
      { success: false, error: 'Error al crear el producto' },
      { status: 500 }
    );
  }
}
