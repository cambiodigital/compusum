import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { requireAdminApi } from '@/lib/auth';
import type { ProductGroup } from '@/lib/csv-import';
import { normalizeProductImagePath } from '@/lib/product-fallbacks';

// ─── helpers ─────────────────────────────────────────────────────────────────

function toSlug(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
}

function parseCurrency(value?: string | number | null): number | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  const normalized = value.trim().replace(/[^\d.,]/g, '').replace(',', '.');
  if (!normalized) return null;
  const parsed = parseFloat(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeVariantName(value?: string): string {
  if (!value) return '';
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function normalizeLookup(value?: string): string {
  if (!value) return '';
  return value
    .trim()
    .replace(/\s+/g, ' ')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function normalizeReferenceKey(value?: string): string {
  if (!value) return '';
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

// ─── POST /api/admin/import ───────────────────────────────────────────────────
// Accepts pre-grouped products from the client:
//   body: { products: ProductGroup[] }
//   query: ?duplicateMode=skip|update

export async function POST(request: Request) {
  const { error } = await requireAdminApi();
  if (error) return error;

  const { searchParams } = new URL(request.url);
  const duplicateMode = searchParams.get('duplicateMode') ?? 'skip';
  if (duplicateMode !== 'skip' && duplicateMode !== 'update') {
    return NextResponse.json({ success: false, error: 'duplicateMode inválido' }, { status: 400 });
  }

  let products: ProductGroup[];
  try {
    const body = await request.json();
    products = body.products ?? [];
    if (!Array.isArray(products)) {
      return NextResponse.json({ success: false, error: 'El campo "products" debe ser un arreglo' }, { status: 400 });
    }
  } catch {
    return NextResponse.json({ success: false, error: 'JSON malformado en el cuerpo de la petición' }, { status: 400 });
  }

  if (products.length === 0) {
    return NextResponse.json({ success: false, error: 'No hay productos para importar' }, { status: 400 });
  }

  const result = { created: 0, updated: 0, skipped: 0, errors: [] as string[] };
  let processed = 0;

  // Consolidate duplicate references in the same payload (case/space-insensitive).
  const consolidatedByReference = new Map<string, ProductGroup>();
  for (const raw of products) {
    const ref = (raw.reference ?? '').trim();
    const refKey = normalizeReferenceKey(ref);
    if (!refKey) {
      result.errors.push('Referencia vacía en payload, se omite');
      continue;
    }

    const existing = consolidatedByReference.get(refKey);
    if (!existing) {
      consolidatedByReference.set(refKey, {
        ...raw,
        reference: ref,
        variants: [...(raw.variants ?? [])],
      });
      continue;
    }

    // Merge keeping first non-empty value for product-level fields.
    existing.reference = existing.reference || ref;
    existing.name = existing.name || raw.name;
    existing.category = existing.category || raw.category;
    existing.description = existing.description || raw.description;
    existing.shortDescription = existing.shortDescription || raw.shortDescription;
    existing.brand = existing.brand || raw.brand;
    existing.price = existing.price ?? raw.price;
    existing.stock = existing.stock ?? raw.stock;
    existing.image = existing.image || raw.image;

    // Merge variants by normalized name to avoid duplicates within a single import.
    const seenVariantNames = new Set(existing.variants.map((v) => normalizeVariantName(v.name)));
    for (const variant of raw.variants ?? []) {
      const normalized = normalizeVariantName(variant.name);
      if (!normalized || seenVariantNames.has(normalized)) continue;
      seenVariantNames.add(normalized);
      existing.variants.push(variant);
    }
  }

  products = Array.from(consolidatedByReference.values());

  // Pre-load brands & categories to minimise DB calls inside the loop
  const [allBrands, allCategories] = await Promise.all([
    db.brand.findMany({ select: { id: true, name: true, slug: true } }),
    db.category.findMany({ select: { id: true, name: true, slug: true, parentId: true } }),
  ]);

  const brandMap = new Map(allBrands.map((b) => [normalizeLookup(b.name), b]));
  const categoryMap = new Map(allCategories.map((c) => [normalizeLookup(c.name), c]));

  // Ensure fallback category exists
  const fallbackCategoryKey = normalizeLookup('Sin categoria');
  let fallbackCategory = categoryMap.get(fallbackCategoryKey);
  if (!fallbackCategory) {
    const created = await db.category.upsert({
      where: { slug: 'sin-categoria' },
      update: {},
      create: { name: 'Sin categoria', slug: 'sin-categoria', isActive: true },
      select: { id: true, name: true, slug: true, parentId: true },
    });
    fallbackCategory = created;
    categoryMap.set(fallbackCategoryKey, created);
  }

  for (const group of products) {
    try {
      const { reference, name, category, description, shortDescription, brand, price, image, variants } = group;
      const normalizedImagePath = normalizeProductImagePath(image);

      if (!name) { result.errors.push(`Ref ${reference}: nombre vacío`); continue; }
      if (!reference) { result.errors.push(`"${name}": referencia vacía`); continue; }

      // ── Auto-create brand ───────────────────────────────────────────────
      let brandId: string | null = null;
      if (brand) {
        const brandKey = normalizeLookup(brand);
        let existing = brandMap.get(brandKey);
        if (!existing) {
          let slug = toSlug(brand);
          if (!slug) slug = `marca-${Date.now()}`;
          const persisted = await db.brand.upsert({
            where: { slug },
            update: {},
            create: { name: brand.trim(), slug },
            select: { id: true, name: true, slug: true },
          });
          existing = { id: persisted.id, name: persisted.name, slug: persisted.slug };
          brandMap.set(brandKey, existing);
        }
        brandId = existing.id;
      }

      const productPrice = parseCurrency(price);
      let categoryId = fallbackCategory.id;

      // ── Auto-create category from CSV column ───────────────────────────
      if (category) {
        const categoryKey = normalizeLookup(category);
        if (categoryKey) {
          let existingCategory = categoryMap.get(categoryKey);
          if (!existingCategory) {
            let categorySlug = toSlug(category);
            if (!categorySlug) categorySlug = `categoria-${Date.now()}`;
            const persistedCategory = await db.category.upsert({
              where: { slug: categorySlug },
              update: {},
              create: { name: category.trim(), slug: categorySlug, isActive: true },
              select: { id: true, name: true, slug: true, parentId: true },
            });
            existingCategory = persistedCategory;
            categoryMap.set(categoryKey, existingCategory);
          }
          categoryId = existingCategory.id;
        }
      }

      // ── Create or update product ────────────────────────────────────────
      const existingProduct = await db.product.findFirst({
        where: {
          sku: {
            equals: reference,
            mode: 'insensitive',
          },
        },
      });
      let targetProductId: string;

      if (existingProduct) {
        if (duplicateMode === 'skip') {
          result.skipped++;
          continue;
        }
        // duplicateMode === 'update'
        await db.product.update({
          where: { id: existingProduct.id },
          data: {
            name,
            shortDescription,
            description,
            categoryId,
            brandId,
            price: productPrice,
            ...(normalizedImagePath && {
              images: {
                deleteMany: {},
                create: [{ imagePath: normalizedImagePath, isPrimary: true, sortOrder: 0 }],
              },
            }),
          },
        });
        targetProductId = existingProduct.id;
        result.updated++;
      } else {
        let slug = toSlug(name);
        const slugTaken = await db.product.findUnique({ where: { slug } });
        if (slugTaken) slug = `${slug}-${Date.now()}`;

        const created = await db.product.create({
          data: {
            name,
            slug,
            sku: reference,
            shortDescription,
            description,
            categoryId,
            brandId,
            price: productPrice,
            ...(normalizedImagePath && {
              images: {
                create: [{ imagePath: normalizedImagePath, isPrimary: true, sortOrder: 0 }],
              },
            }),
          },
        });
        targetProductId = created.id;
        result.created++;
      }

      // ── Upsert variants ────────────────────────────────────────────────
      for (let vi = 0; vi < variants.length; vi++) {
        const v = variants[vi];
        if (!v.name) continue;
        const normalizedName = normalizeVariantName(v.name);
        if (!normalizedName) continue;

        const variantPrice = parseCurrency(v.price) ?? productPrice;
        await db.productVariant.upsert({
          where: {
            productId_normalizedName: {
              productId: targetProductId,
              normalizedName,
            },
          },
          update: {
            name: v.name,
            code: v.code || null,
            price: variantPrice,
            stockStatus: 'disponible',
            isActive: true,
          },
          create: {
            productId: targetProductId,
            name: v.name,
            code: v.code || null,
            normalizedName,
            price: variantPrice,
            stockStatus: 'disponible',
            sortOrder: vi,
          },
        });
      }

      processed++;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Error desconocido';
      result.errors.push(`Ref ${group.reference}: ${msg}`);
    }
  }

  return NextResponse.json({ success: true, data: { ...result, processed } });
}
