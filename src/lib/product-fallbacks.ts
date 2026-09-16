const DEFAULT_PRODUCT_NAME = "Producto sin nombre";
const DEFAULT_PRODUCT_SLUG = "producto";
const DEFAULT_BRAND_NAME = "Marca no especificada";
const DEFAULT_BRAND_SLUG = "marca";
const BLOCKED_IMAGE_HOSTS = ["unsplash.com", "images.unsplash.com", "source.unsplash.com"];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function isBlockedImageSource(value: unknown): boolean {
  if (!isNonEmptyString(value)) {
    return false;
  }

  const candidate = value.trim().toLowerCase();

  if (candidate.startsWith("http://") || candidate.startsWith("https://")) {
    try {
      const parsedUrl = new URL(candidate);
      return BLOCKED_IMAGE_HOSTS.some((host) => parsedUrl.hostname === host || parsedUrl.hostname.endsWith(`.${host}`));
    } catch {
      return candidate.includes("unsplash.com");
    }
  }

  return candidate.includes("unsplash.com");
}

export function resolveProductName(name: unknown): string {
  return isNonEmptyString(name) ? name.trim() : DEFAULT_PRODUCT_NAME;
}

export function resolveProductSlug(slug: unknown): string {
  return isNonEmptyString(slug) ? slug.trim() : DEFAULT_PRODUCT_SLUG;
}

export function resolveBrandName(name: unknown): string {
  return isNonEmptyString(name) ? name.trim() : DEFAULT_BRAND_NAME;
}

export function resolveBrandSlug(slug: unknown): string {
  return isNonEmptyString(slug) ? slug.trim() : DEFAULT_BRAND_SLUG;
}

/**
 * Fase 6 — Resolución REAL de imágenes de producto.
 *
 * Hasta ahora esta función devolvía "" y el storefront vivía de placeholders
 * aunque ProductImage existiera. Ahora acepta las formas que ya viajan en las
 * consultas/APIs y elige con prioridad:
 *   1. imagen primaria (isPrimary);
 *   2. primera por sortOrder (lista ya ordenada por las queries);
 *   3. fallback existente ("" => SafeProductImage muestra placeholder).
 *
 * No inventa imágenes desde el slug. Las URLs `data:`/`blob:` se consideran
 * inválidas para display (fallback); los hosts bloqueados los filtra
 * `normalizeProductImagePath`; los http(s) externos se entregan tal cual y
 * `SafeProductImage`/next.image decide (patrón no permitido => onError =>
 * fallback, sin abrir remotePatterns).
 */
export interface ProductImageData {
  imagePath?: string | null;
  isPrimary?: boolean;
  sortOrder?: number;
}

/** Formas que puede traer un producto según la consulta/API de origen. */
export interface ProductImageSource {
  /** Forma Prisma: lista de ProductImage. */
  images?: readonly (ProductImageData | null | undefined)[] | null;
  /** Forma plana de resultados de búsqueda (/api/products). */
  primaryImage?: string | null;
  /** Forma mínima persistida en el carrito (CartProduct). */
  image?: string | null;
}

function isUnsafeInlineSource(value: string): boolean {
  return value.startsWith("data:") || value.startsWith("blob:");
}

function orderedImagePaths(product: ProductImageSource | null | undefined): string[] {
  if (!product?.images?.length) return [];

  return product.images
    .map((img, index) => ({ img: img ?? {}, index }))
    .sort((a, b) => {
      const primaryDiff = Number(Boolean(b.img.isPrimary)) - Number(Boolean(a.img.isPrimary));
      if (primaryDiff !== 0) return primaryDiff;
      const sortOrderA = typeof a.img.sortOrder === "number" ? a.img.sortOrder : a.index;
      const sortOrderB = typeof b.img.sortOrder === "number" ? b.img.sortOrder : b.index;
      if (sortOrderA !== sortOrderB) return sortOrderA - sortOrderB;
      return a.index - b.index;
    })
    .map(({ img }) => normalizeProductImagePath(img.imagePath))
    .filter((src) => src.length > 0);
}

export function resolveProductImageSrc(product: ProductImageSource | null | undefined): string {
  const candidates = orderedImagePaths(product);

  const flat = normalizeProductImagePath(product?.primaryImage);
  if (flat) candidates.push(flat);

  const single = normalizeProductImagePath(product?.image);
  if (single) candidates.push(single);

  return candidates.find((src) => !isUnsafeInlineSource(src)) ?? "";
}

/** Galería (thumbnails del detalle): srcs únicos y válidos, hasta `limit`. */
export function resolveProductImageList(
  product: ProductImageSource | null | undefined,
  limit?: number
): string[] {
  const candidates: string[] = [];

  for (const src of orderedImagePaths(product)) {
    if (!isUnsafeInlineSource(src) && !candidates.includes(src)) candidates.push(src);
  }

  const flat = normalizeProductImagePath(product?.primaryImage);
  if (flat && !isUnsafeInlineSource(flat) && !candidates.includes(flat)) candidates.push(flat);

  return typeof limit === "number" ? candidates.slice(0, Math.max(0, limit)) : candidates;
}

export function resolveBrandLogoSrc(logo: unknown, brandSlug: unknown, size: string): string {
  void brandSlug;
  void size;

  if (isNonEmptyString(logo) && !isBlockedImageSource(logo)) {
    return logo.trim();
  }

  return "";
}

export function normalizeProductImagePath(imagePath: unknown): string {
  if (!isNonEmptyString(imagePath)) {
    return "";
  }

  const value = imagePath.trim();
  if (isBlockedImageSource(value)) {
    return "";
  }

  if (value.startsWith("http://") || value.startsWith("https://")) {
    try {
      const parsedUrl = new URL(value);
      if (parsedUrl.pathname.startsWith("/uploads/")) {
        return `${parsedUrl.pathname}${parsedUrl.search}${parsedUrl.hash}`;
      }
    } catch {
      // Keep the original value when URL parsing fails.
    }
  }

  if (
    value.startsWith("http://")
    || value.startsWith("https://")
    || value.startsWith("data:")
    || value.startsWith("blob:")
    || value.startsWith("/")
  ) {
    return value;
  }

  const filenameOnly = value.replace(/^.*[\\/]/, "");
  return `/uploads/${filenameOnly}`;
}
