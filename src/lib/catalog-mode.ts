import { db } from "@/lib/db";

/**
 * Checks whether a product should be displayed in Catalog Mode
 * (i.e., prices hidden and purchase actions disabled).
 *
 * Priority order (highest wins):
 *  1. Product-level catalogMode flag
 *  2. Category-level catalogMode flag
 *  3. Brand-level catalogMode flag
 *  4. Global store catalogMode setting
 */
export async function isProductInCatalogMode(productId: string): Promise<boolean> {
  // Fetch the product with its category and brand in one query
  const product = await db.product.findUnique({
    where: { id: productId },
    select: {
      catalogMode: true,
      category: { select: { catalogMode: true } },
      brand: { select: { catalogMode: true } },
    },
  });

  if (!product) return false;

  // Product-level override
  if (product.catalogMode) return true;

  // Category-level override
  if (product.category?.catalogMode) return true;

  // Brand-level override
  if (product.brand?.catalogMode) return true;

  // Global store setting
  return isGlobalCatalogModeEnabled();
}

/**
 * Checks the global store catalog mode setting.
 */
export async function isGlobalCatalogModeEnabled(): Promise<boolean> {
  const setting = await db.setting.findUnique({
    where: { key: "catalog_mode_enabled" },
    select: { value: true },
  });

  return setting?.value === "true";
}

/**
 * Resolves catalog mode status for a product given its already-fetched data
 * (avoids an extra DB call when the data is already available).
 */
export function resolveCatalogMode(
  productCatalogMode: boolean,
  categoryCatalogMode: boolean,
  brandCatalogMode: boolean | undefined | null,
  globalCatalogMode: boolean
): boolean {
  return (
    productCatalogMode ||
    categoryCatalogMode ||
    (brandCatalogMode ?? false) ||
    globalCatalogMode
  );
}

/**
 * Evaluates whether catalog mode applies to a product based on product,
 * category, brand, or global store catalog mode settings.
 */
export function isProductCatalogMode(
  product: {
    catalogMode?: boolean | null;
    category?: { catalogMode?: boolean | null } | null;
    categoryCatalogMode?: boolean | null;
    brand?: { catalogMode?: boolean | null } | null;
    brandCatalogMode?: boolean | null;
  },
  globalCatalogMode: boolean
): boolean {
  if (!product) return globalCatalogMode;

  const productMode = Boolean(product.catalogMode);
  const categoryMode = Boolean(
    product.category?.catalogMode ?? product.categoryCatalogMode
  );
  const brandMode = Boolean(
    product.brand?.catalogMode ?? product.brandCatalogMode
  );

  return resolveCatalogMode(
    productMode,
    categoryMode,
    brandMode,
    globalCatalogMode
  );
}

/**
 * Strips prices (price and wholesalePrice) from a product object (and its variants if any)
 * if catalog mode is active for that product or globally.
 */
export function sanitizeProductForCatalog<T extends Record<string, any>>(
  product: T,
  globalCatalogMode: boolean
): T {
  if (!product) return product;

  const activeCatalogMode = isProductCatalogMode(product, globalCatalogMode);

  if (!activeCatalogMode) {
    return product;
  }

  const sanitized = {
    ...product,
    price: null,
    wholesalePrice: null,
  };

  if (Array.isArray(sanitized.variants)) {
    sanitized.variants = sanitized.variants.map((variant: any) => ({
      ...variant,
      price: null,
      wholesalePrice: null,
    }));
  }

  return sanitized;
}

/**
 * Sanitizes an array of product objects for catalog mode.
 */
export function sanitizeProductsForCatalog<T extends Record<string, any>>(
  products: T[],
  globalCatalogMode: boolean
): T[] {
  return products.map((product) =>
    sanitizeProductForCatalog(product, globalCatalogMode)
  );
}

