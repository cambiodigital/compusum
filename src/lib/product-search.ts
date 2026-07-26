import { db } from "@/lib/db";
import { Prisma } from "@prisma/client";

interface SearchProductsOptions {
  limit?: number;
  offset?: number;
  categoryIds?: string[];
  brandId?: string;
  isFeatured?: boolean;
  isNew?: boolean;
  isActive?: boolean;
  orderBy?: "relevance" | "createdAt" | "name" | "name_desc" | "price_asc" | "price_desc" | "sortOrder";
}

interface SearchResult {
  id: string;
  name: string;
  slug: string;
  sku: string | null;
  price: number | null;
  wholesalePrice: number | null;
  minWholesaleQty: number;
  isFeatured: boolean;
  isNew: boolean;
  isActive: boolean;
  catalogMode: boolean;
  stockStatus: string;
  sortOrder: number;
  createdAt: Date;
  categoryName: string | null;
  categorySlug: string | null;
  categoryCatalogMode: boolean;
  brandName: string | null;
  brandSlug: string | null;
  brandCatalogMode: boolean;
  primaryImage: string | null;
  primaryThumbnail: string | null;
  primaryAltText: string | null;
  variantCount: number;
  rank: number;
}

/**
 * Full-text search for products using PostgreSQL tsvector.
 * Falls back to Prisma `contains` if query is empty.
 */
export async function searchProducts(
  query: string,
  options: SearchProductsOptions = {}
): Promise<{ products: SearchResult[]; total: number }> {
  const {
    limit = 12,
    offset = 0,
    categoryIds,
    brandId,
    isFeatured,
    isNew,
    isActive = true,
    orderBy = "relevance",
  } = options;

  // Build WHERE conditions
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  // Full-text search condition
  if (query.trim()) {
    conditions.push(`p."searchVector" @@ plainto_tsquery('spanish', $${paramIndex})`);
    params.push(query.trim());
    paramIndex++;
  }

  if (isActive !== undefined) {
    conditions.push(`p."isActive" = $${paramIndex}`);
    params.push(isActive);
    paramIndex++;
  }

  if (categoryIds && categoryIds.length > 0) {
    conditions.push(`p."categoryId" = ANY($${paramIndex})`);
    params.push(categoryIds);
    paramIndex++;
  }

  if (brandId) {
    conditions.push(`p."brandId" = $${paramIndex}`);
    params.push(brandId);
    paramIndex++;
  }

  if (isFeatured !== undefined) {
    conditions.push(`p."isFeatured" = $${paramIndex}`);
    params.push(isFeatured);
    paramIndex++;
  }

  if (isNew !== undefined) {
    conditions.push(`p."isNew" = $${paramIndex}`);
    params.push(isNew);
    paramIndex++;
  }

  const whereClause = conditions.length > 0
    ? `WHERE ${conditions.join(" AND ")}`
    : "";

  // Build ORDER BY
  let orderClause: string;
  if (query.trim() && orderBy === "relevance") {
    orderClause = `ORDER BY ts_rank(p."searchVector", plainto_tsquery('spanish', $1)) DESC, p."createdAt" DESC`;
  } else {
    switch (orderBy) {
      case "name":
        orderClause = `ORDER BY p."name" ASC`;
        break;
      case "name_desc":
        orderClause = `ORDER BY p."name" DESC`;
        break;
      case "price_asc":
        orderClause = `ORDER BY p."wholesalePrice" ASC NULLS LAST`;
        break;
      case "price_desc":
        orderClause = `ORDER BY p."wholesalePrice" DESC NULLS LAST`;
        break;
      case "sortOrder":
        orderClause = `ORDER BY p."sortOrder" ASC, p."createdAt" DESC`;
        break;
      default:
        orderClause = `ORDER BY p."createdAt" DESC`;
    }
  }

  // Count query
  const countSql = `SELECT COUNT(*)::int as total FROM "Product" p ${whereClause}`;
  const countResult = await db.$queryRawUnsafe<[{ total: number }]>(countSql, ...params);
  const total = countResult[0]?.total ?? 0;

  // Main query with joins
  const rankSelect = query.trim()
    ? `ts_rank(p."searchVector", plainto_tsquery('spanish', $1)) as rank`
    : `0 as rank`;

  const sql = `
    SELECT
      p."id", p."name", p."slug", p."sku",
      p."price", p."wholesalePrice", p."minWholesaleQty",
      p."isFeatured", p."isNew", p."isActive", p."catalogMode",
      p."stockStatus", p."sortOrder", p."createdAt",
      c."name" as "categoryName", c."slug" as "categorySlug", c."catalogMode" as "categoryCatalogMode",
      b."name" as "brandName", b."slug" as "brandSlug", b."catalogMode" as "brandCatalogMode",
      pi."imagePath" as "primaryImage", pi."thumbnailPath" as "primaryThumbnail", pi."altText" as "primaryAltText",
      (
        SELECT COUNT(*)::int
        FROM "ProductVariant" pv
        WHERE pv."productId" = p."id" AND pv."isActive" = true
      ) as "variantCount",
      ${rankSelect}
    FROM "Product" p
    LEFT JOIN "Category" c ON c."id" = p."categoryId"
    LEFT JOIN "Brand" b ON b."id" = p."brandId"
    LEFT JOIN LATERAL (
      SELECT "imagePath", "thumbnailPath", "altText"
      FROM "ProductImage"
      WHERE "productId" = p."id" AND "isPrimary" = true
      LIMIT 1
    ) pi ON true
    ${whereClause}
    ${orderClause}
    LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
  `;

  params.push(limit, offset);

  const products = await db.$queryRawUnsafe<SearchResult[]>(sql, ...params);

  return { products, total };
}

/**
 * Quick search for autocomplete suggestions (top 5 results).
 */
export async function searchProductSuggestions(
  query: string,
  limit = 5
): Promise<{
  id: string;
  name: string;
  slug: string;
  sku: string | null;
  price: number | null;
  categoryName: string | null;
  brandName: string | null;
  catalogMode?: boolean;
  categoryCatalogMode?: boolean;
  brandCatalogMode?: boolean;
}[]> {
  if (!query.trim()) return [];

  const sql = `
    SELECT p."id", p."name", p."slug", p."sku", p."price", p."catalogMode",
           c."name" as "categoryName", c."catalogMode" as "categoryCatalogMode",
           b."name" as "brandName", b."catalogMode" as "brandCatalogMode"
    FROM "Product" p
    LEFT JOIN "Category" c ON c."id" = p."categoryId"
    LEFT JOIN "Brand" b ON b."id" = p."brandId"
    WHERE p."isActive" = true
      AND p."searchVector" @@ plainto_tsquery('spanish', $1)
    ORDER BY ts_rank(p."searchVector", plainto_tsquery('spanish', $1)) DESC
    LIMIT $2
  `;

  return db.$queryRawUnsafe(sql, query.trim(), limit);
}
