import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { getCachedFeaturedProducts, getCachedNewProducts, getCachedCategories, getCachedBrands, getCachedGlobalCatalogMode } from '@/lib/product-cache';
import { sanitizeProductsForCatalog } from '@/lib/catalog-mode';

// Helper function to build category tree
function buildCategoryTree(categories: any[], parentId: string | null = null): any[] {
  return categories
    .filter((cat) => cat.parentId === parentId)
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((cat) => ({
      ...cat,
      children: buildCategoryTree(categories, cat.id),
    }));
}

// GET /api/home - Get all data for homepage
export async function GET() {
  try {
    const now = new Date();

    // Fetch all homepage data in parallel (products, categories, brands use cache)
    const [
      isCatalogMode,
      banners,
      featuredProducts,
      newProducts,
      categories,
      brands,
      activeSeason,
      settings,
    ] = await Promise.all([
      getCachedGlobalCatalogMode(),

      // Get hero banners
      db.banner.findMany({
        where: {
          isActive: true,
          position: 'hero',
        },
        orderBy: { sortOrder: 'asc' },
      }),

      // Get featured products (cached)
      getCachedFeaturedProducts(),

      // Get new products (cached)
      getCachedNewProducts(),

      // Get categories (cached)
      getCachedCategories(),

      // Get brands (cached)
      getCachedBrands(),

      // Get active season (by date range)
      db.season.findFirst({
        where: {
          isActive: true,
          OR: [
            {
              AND: [
                { startDate: { lte: now } },
                { endDate: { gte: now } },
              ],
            },
            {
              AND: [
                { startDate: null },
                { endDate: null },
              ],
            },
          ],
        },
        include: {
          products: {
            include: {
              product: {
                include: {
                  category: { select: { id: true, name: true, slug: true, catalogMode: true } },
                  brand: true,
                  images: {
                    orderBy: { sortOrder: 'asc' },
                  },
                },
              },
            },
          },
        },
      }),

      // Get general settings
      db.setting.findMany({
        where: {
          group: 'general',
        },
      }),
    ]);

    // Filter banners by date range
    const activeBanners = banners.filter((banner) => {
      if (!banner.startsAt && !banner.endsAt) return true;
      const startsAt = banner.startsAt ? new Date(banner.startsAt) : null;
      const endsAt = banner.endsAt ? new Date(banner.endsAt) : null;

      if (startsAt && endsAt) {
        return now >= startsAt && now <= endsAt;
      }
      if (startsAt) {
        return now >= startsAt;
      }
      if (endsAt) {
        return now <= endsAt;
      }
      return true;
    });

    // Transform categories with count (cached categories already have _count)
    const categoriesWithCount = categories.map((cat) => ({
      id: cat.id,
      name: cat.name,
      slug: cat.slug,
      description: cat.description,
      image: cat.image,
      icon: cat.icon,
      parentId: cat.parentId,
      sortOrder: cat.sortOrder,
      productCount: cat._count.products,
    }));

    // Build category tree (only top-level for homepage)
    const categoryTree = buildCategoryTree(categoriesWithCount).slice(0, 8);

    // Transform brands with count (cached brands already have _count)
    const brandsWithCount = brands.map((brand) => ({
      id: brand.id,
      name: brand.name,
      slug: brand.slug,
      description: brand.description,
      logo: brand.logo,
      website: brand.website,
      productCount: brand._count.products,
    }));

    // Transform settings to key-value object
    const generalSettings: Record<string, any> = {};
    settings.forEach((setting) => {
      let parsedValue: any = setting.value;
      switch (setting.type) {
        case 'number':
          parsedValue = setting.value ? parseFloat(setting.value) : null;
          break;
        case 'boolean':
          parsedValue = setting.value === 'true';
          break;
        case 'json':
          try {
            parsedValue = setting.value ? JSON.parse(setting.value) : null;
          } catch {
            parsedValue = setting.value;
          }
          break;
      }
      generalSettings[setting.key] = parsedValue;
    });

    // Transform active season with products
    let seasonData = null;
    if (activeSeason) {
      const seasonProducts = activeSeason.products
        .slice(0, 4)
        .map((ps) => ps.product);
      seasonData = {
        id: activeSeason.id,
        name: activeSeason.name,
        slug: activeSeason.slug,
        description: activeSeason.description,
        image: activeSeason.image,
        colorHex: activeSeason.colorHex,
        products: sanitizeProductsForCatalog(seasonProducts, isCatalogMode),
      };
    }

    return NextResponse.json({
      success: true,
      data: {
        banners: activeBanners,
        featuredProducts: sanitizeProductsForCatalog(featuredProducts, isCatalogMode),
        newProducts: sanitizeProductsForCatalog(newProducts, isCatalogMode),
        categories: categoryTree,
        brands: brandsWithCount.slice(0, 8),
        activeSeason: seasonData,
        settings: generalSettings,
      },
    });
  } catch (error) {
    console.error('Error fetching home data:', error);
    return NextResponse.json(
      { success: false, error: 'Error al obtener los datos de la página principal' },
      { status: 500 }
    );
  }
}
