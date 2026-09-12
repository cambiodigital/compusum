import { db } from "./db";
import { canonicalColombiaPhone, phoneOrVariants } from "./phone";

/**
 * MOTOR ÚNICO DE PRECIOS (server-side).
 *
 * Es la ÚNICA fuente de verdad para decidir el precio efectivo de un
 * producto/variante según el perfil comercial del cliente. Catálogo, carrito,
 * checkout y creación de pedidos deben delegar aquí toda resolución monetaria.
 *
 * SEGURIDAD CRÍTICA: el `customerId` que alimenta este motor SOLO puede
 * provenir de:
 *   - sesión autenticada validada server-side (`getCurrentUser()`), o
 *   - acción administrativa/AGENT autorizada server-side (`requireAdminApi`).
 * NUNCA de un email, teléfono o id enviado por el navegador (ver
 * `resolveServerPricingCustomer`).
 *
 * Jerarquía de resolución:
 *   1. override de variante dentro del perfil (PriceProfileVariant)
 *   2. override de producto dentro del perfil (PriceProfileProduct)
 *   3. ajuste porcentual general del perfil sobre el precio base
 *   4. precio base del producto/variante (cascada wholesale-first de Siesa)
 *   5. precio <= 0 => requiere cotización / no comprable
 */

export type PriceSource =
  | "variant_override"
  | "product_override"
  | "profile_adjustment"
  | "variant_base"
  | "product_base";

export interface ResolvedPrice {
  productId: string;
  variantId: string | null;
  /** Precio unitario efectivo COP. null => sin precio (cotización). */
  unitPrice: number | null;
  purchasable: boolean;
  requiresQuote: boolean;
  /** Fuente de resolución interna, útil para auditoría. No exponer al navegador. */
  source: PriceSource;
  /** Precio base (sin perfil) usado como referencia. */
  basePrice: number | null;
  /** Perfil aplicado (siempre el activo del cliente o null). Interno. */
  profileId: string | null;
  profileCode: string | null;
}

export interface PriceRequestItem {
  productId: string;
  variantId?: string | null;
}

export interface PricingCustomerContext {
  /**
   * Cliente (User role CUSTOMER) que determina el precio. Debe derivarse
   * exclusivamente de la sesión autenticada o de una acción administrativa.
   */
  customerId?: string | null;
  /** Transacción Prisma opcional (usa `db` por defecto). */
  tx?: any;
}

export interface ActivePriceProfile {
  id: string;
  code: string;
  name: string;
  percentAdjustment: number | null;
}

interface ProductPriceData {
  id: string;
  price: number | null;
  wholesalePrice: number | null;
  variants?: Array<{
    id: string;
    price: number | null;
    wholesalePrice: number | null;
  }> | null;
}

interface ProfileOverride {
  wholesalePrice: number | null;
  price: number | null;
}

/**
 * Carga los overrides de un perfil para los productos/variantes dados
 * (2 queries). Compartido entre la resolución batch y validateAndPriceItems.
 */
export async function loadProfileOverrides(
  profile: ActivePriceProfile,
  productIds: string[],
  variantIds: string[],
  client: any = db
): Promise<{
  byVariant: Map<string, ProfileOverride>;
  byProduct: Map<string, ProfileOverride>;
}> {
  const [productOverrides, variantOverrides] = await Promise.all([
    client.priceProfileProduct.findMany({
      where: { profileId: profile.id, productId: { in: productIds } },
      select: { productId: true, wholesalePrice: true, price: true },
    }),
    variantIds.length > 0
      ? client.priceProfileVariant.findMany({
          where: { profileId: profile.id, variantId: { in: variantIds } },
          select: { variantId: true, wholesalePrice: true, price: true },
        })
      : Promise.resolve([]),
  ]);

  return {
    byProduct: new Map(
      productOverrides.map((o: any) => [
        o.productId,
        { wholesalePrice: o.wholesalePrice, price: o.price },
      ])
    ),
    byVariant: new Map(
      variantOverrides.map((o: any) => [
        o.variantId,
        { wholesalePrice: o.wholesalePrice, price: o.price },
      ])
    ),
  };
}

export interface PriceResolution {
  prices: Map<string, ResolvedPrice>;
  profile: ActivePriceProfile | null;
}

const roundPrice = (value: number): number => Math.round(value * 100) / 100;

const priceKey = (productId: string, variantId?: string | null): string =>
  `${productId}::${variantId || ""}`;

/**
 * Cascada base (reglas actuales preservadas):
 *   con variante: variant.wholesalePrice ?? variant.price ?? product.wholesalePrice ?? product.price
 *   sin variante: product.wholesalePrice ?? product.price
 */
export function baseUnitPrice(
  product: ProductPriceData,
  variantId?: string | null
): number | null {
  if (variantId) {
    const variant = product.variants?.find((v) => v.id === variantId);
    if (variant) {
      const price = variant.wholesalePrice ?? variant.price ?? product.wholesalePrice ?? product.price;
      return price === undefined || price === null ? null : price;
    }
    // Variante no encontrada en los datos cargados: usar precio del producto.
  }
  const price = product.wholesalePrice ?? product.price;
  return price === undefined || price === null ? null : price;
}

function overridePrice(override: ProfileOverride | undefined): number | null {
  if (!override) return null;
  const price = override.wholesalePrice ?? override.price;
  return price === undefined || price === null ? null : price;
}

function applyProfileAdjustment(
  base: number | null,
  profile: ActivePriceProfile
): number | null {
  if (base === null) return null;
  if (profile.percentAdjustment === null || profile.percentAdjustment === undefined) {
    return base;
  }
  return roundPrice(base * (1 + profile.percentAdjustment / 100));
}

/**
 * Resuelve el perfil de precio activo del cliente.
 *
 * - Solo cuentas role=CUSTOMER activas tienen perfil comercial.
 * - Perfil asignado inactivo => null (fallback seguro a precio base).
 * - Sin perfil asignado => null (PRECIO BASE). La Fase 2 NO aplica
 *   automáticamente el perfil `isDefault`: los perfiles comerciales los
 *   asigna explícitamente administración/asesor. `isDefault` queda como
 *   dato informativo del modelo/UI para uso futuro, sin participación en
 *   la resolución automática.
 */
export async function getActivePriceProfile(
  customerId?: string | null,
  tx: any = db
): Promise<ActivePriceProfile | null> {
  if (!customerId) return null;

  const user = await (tx ?? db).user.findUnique({
    where: { id: customerId },
    select: {
      isActive: true,
      role: true,
      priceProfile: {
        select: {
          id: true,
          code: true,
          name: true,
          percentAdjustment: true,
          isActive: true,
        },
      },
    },
  });

  if (!user || !user.isActive) return null;
  if (user.role?.toLowerCase() !== 'customer') return null;

  if (user.priceProfile) {
    if (!user.priceProfile.isActive) return null;
    return {
      id: user.priceProfile.id,
      code: user.priceProfile.code,
      name: user.priceProfile.name,
      percentAdjustment: user.priceProfile.percentAdjustment,
    };
  }

  return null;
}

/**
 * Resolución pura (sin I/O) a partir de productos ya cargados y del perfil.
 * Usada por la resolución batch y por `validateAndPriceItems` (que ya cargó
 * los productos para validar stock/activos).
 *
 * PRECEDENCIA POR EXISTENCIA DE REGLA (nunca por igualdad numérica):
 *   1. override de variante (PriceProfileVariant)      => variant_override
 *   2. override de producto (PriceProfileProduct)      => product_override
 *   3. ajuste porcentual del perfil                    => profile_adjustment
 *   4. precio base                                     => variant_base/product_base
 * Un override cuyo valor coincide con el precio base SIGUE siendo la regla
 * aplicada: los niveles inferiores NO se evalúan (un override == base con
 * ajuste -10% debe devolver el valor del override, no el ajustado).
 */
export function resolvePricesFromProductMap(
  items: PriceRequestItem[],
  productsById: Map<string, ProductPriceData>,
  profile: ActivePriceProfile | null,
  overrides?: {
    byVariant: Map<string, ProfileOverride>;
    byProduct: Map<string, ProfileOverride>;
  }
): PriceResolution {
  const prices = new Map<string, ResolvedPrice>();

  for (const item of items) {
    if (!item?.productId) continue;
    const key = priceKey(item.productId, item.variantId);
    if (prices.has(key)) continue;

    const product = productsById.get(item.productId);
    if (!product) continue;

    const base = baseUnitPrice(product, item.variantId);
    let unitPrice: number | null = base;
    let source: PriceSource = item.variantId ? "variant_base" : "product_base";

    if (profile) {
      const effectiveOverrides = overrides ?? {
        byProduct: new Map<string, ProfileOverride>(),
        byVariant: new Map<string, ProfileOverride>(),
      };

      // Nivel 1: override de variante (si existe la regla, gana siempre)
      if (item.variantId) {
        const variantPrice = overridePrice(effectiveOverrides.byVariant.get(item.variantId));
        if (variantPrice !== null) {
          unitPrice = variantPrice;
          source = "variant_override";
        }
      }

      // Nivel 2: override de producto (solo si NO se aplicó override de variante)
      if (source !== "variant_override") {
        const productPrice = overridePrice(effectiveOverrides.byProduct.get(item.productId));
        if (productPrice !== null) {
          unitPrice = productPrice;
          source = "product_override";
        }
      }

      // Nivel 3: ajuste porcentual (solo si NO se aplicó ningún override)
      if (
        source !== "variant_override" &&
        source !== "product_override" &&
        profile.percentAdjustment !== null &&
        profile.percentAdjustment !== undefined &&
        base !== null
      ) {
        unitPrice = applyProfileAdjustment(base, profile);
        source = "profile_adjustment";
      }
    }

    const resolved: ResolvedPrice = {
      productId: item.productId,
      variantId: item.variantId ?? null,
      unitPrice,
      purchasable: unitPrice !== null && unitPrice > 0,
      requiresQuote: unitPrice === null || unitPrice <= 0,
      source,
      basePrice: base,
      profileId: profile?.id ?? null,
      profileCode: profile?.code ?? null,
    };

    prices.set(key, resolved);
  }

  return { prices, profile };
}

/**
 * Resolución batch (evita N+1): número constante de queries
 * (productos + usuario/perfil + overrides de producto + overrides de variante).
 */
export async function resolvePricesForItems(
  items: PriceRequestItem[],
  ctx: PricingCustomerContext = {}
): Promise<PriceResolution> {
  const client = ctx.tx ?? db;
  const productIds = Array.from(
    new Set(items.map((i) => i?.productId).filter(Boolean))
  );

  if (productIds.length === 0) {
    return { prices: new Map(), profile: null };
  }

  const products = await client.product.findMany({
    where: { id: { in: productIds } },
    select: {
      id: true,
      price: true,
      wholesalePrice: true,
      variants: { select: { id: true, price: true, wholesalePrice: true } },
    },
  });

  const productsById = new Map<string, ProductPriceData>(
    products.map((p: any) => [p.id, p])
  );

  const profile = await getActivePriceProfile(ctx.customerId, client);
  if (!profile) {
    return resolvePricesFromProductMap(items, productsById, null);
  }

  const variantIds = Array.from(
    new Set(items.map((i) => i?.variantId).filter(Boolean) as string[])
  );

  const overrides = await loadProfileOverrides(profile, productIds, variantIds, client);

  return resolvePricesFromProductMap(items, productsById, profile, overrides);
}

/** Resolución individual. */
export async function resolvePrice(
  productId: string,
  variantId?: string | null,
  ctx: PricingCustomerContext = {}
): Promise<ResolvedPrice | null> {
  const { prices } = await resolvePricesForItems(
    [{ productId, variantId }],
    ctx
  );
  return prices.get(priceKey(productId, variantId)) ?? null;
}

/**
 * RESOLUCIÓN SEGURA DEL CLIENTE QUE DETERMINA EL PRECIO.
 *
 * - Cliente autenticado con rol CUSTOMER => él mismo (sesión server-side).
 * - ADMIN/EDITOR autenticado => puede resolver el cliente por el contacto del
 *   pedido (búsqueda server-side autorizada; permite vender con el precio del
 *   cliente asignado). Sin contacto válido => precio base. La búsqueda
 *   FILTRA EXPLÍCITAMENTE role=CUSTOMER: nunca puede resolverse un usuario
 *   interno (admin/editor/AGENT) por coincidencia de contacto.
 * - AGENT autenticado => igual que admin/editor pero restringido a SUS
 *   clientes asignados (User.assignedAgentId = agent.id); nunca ve precios
 *   de clientes de otro asesor.
 * - Invitado => SIEMPRE null (precio base/default de invitado). El contacto
 *   escrito en checkout JAMÁS determina el perfil de precio.
 */
export async function resolveServerPricingCustomer(
  sessionUser: { id: string; role: string } | null | undefined,
  contact?: { phone?: string | null; email?: string | null } | null,
  tx: any = db
): Promise<string | null> {
  if (!sessionUser) return null;

  const role = sessionUser.role?.toLowerCase();
  if (role === "customer") {
    return sessionUser.id;
  }

  if (role === "admin" || role === "editor" || role === "agent") {
    const phone = canonicalColombiaPhone(contact?.phone);
    const email = contact?.email?.trim().toLowerCase() || null;
    if (!phone && !email) return null;

    const customer = await tx.user.findFirst({
      where: {
        isActive: true,
        // SOLO clientes: un usuario interno nunca determina precio comercial.
        role: { equals: "CUSTOMER", mode: "insensitive" },
        // AGENT: aislamiento por asesor (solo sus clientes asignados).
        ...(role === "agent" ? { assignedAgentId: sessionUser.id } : {}),
        OR: [
          ...(phone ? phoneOrVariants(phone) : []),
          ...(email ? [{ email }] : []),
        ],
      },
      select: { id: true },
    });
    return customer?.id ?? null;
  }

  return null;
}

/** Para administración: el actor autorizado ya conoce el id del cliente. */
export function adminPricingCustomer(
  sessionUser: { id: string; role: string } | null | undefined
): string | null {
  if (!sessionUser) return null;
  const role = sessionUser.role?.toLowerCase();
  return role === "customer" ? sessionUser.id : null;
}

/**
 * Adjunta `resolvedPrice` (y `resolvedPrice` por variante si el producto las
 * trae) a un arreglo de productos para render/API. Batch, sin N+1.
 *
 * `resolvedPrice` es seguro para el navegador (solo unitPrice/purchasable/
 * requiresQuote); la fuente interna y el perfil se copian para auditoría
 * server-side y deben retirarse antes de exponer el objeto completo si se
 * desea (ver stripInternalPriceFields).
 */
export async function attachResolvedPrices<T extends Record<string, any>>(
  products: T[],
  ctx: PricingCustomerContext = {}
): Promise<T[]> {
  if (!Array.isArray(products) || products.length === 0) return products;

  const items: PriceRequestItem[] = [];
  for (const product of products) {
    if (!product?.id) continue;
    if (Array.isArray(product.variants)) {
      for (const variant of product.variants) {
        if (variant?.id) items.push({ productId: product.id, variantId: variant.id });
      }
    }
    items.push({ productId: product.id, variantId: null });
  }

  const { prices } = await resolvePricesForItems(items, ctx);

  return products.map((product) => {
    if (!product?.id) return product;
    const next: Record<string, any> = { ...product };

    // Modo catálogo (sanitizeProductForCatalog deja price/wholesalePrice en
    // null) u producto sin precio: NO exponer resolvedPrice.
    const catalogSanitized =
      product.price === null &&
      (product.wholesalePrice === null || product.wholesalePrice === undefined);

    if (!catalogSanitized) {
      const base = prices.get(priceKey(product.id, null));
      if (base) next.resolvedPrice = toPublicResolvedPrice(base);
    } else {
      next.resolvedPrice = null;
    }

    if (Array.isArray(next.variants)) {
      next.variants = next.variants.map((variant: any) => {
        if (catalogSanitized) {
          return { ...variant, resolvedPrice: null };
        }
        const resolved = prices.get(priceKey(product.id, variant?.id));
        return resolved
          ? { ...variant, resolvedPrice: toPublicResolvedPrice(resolved) }
          : variant;
      });
    }
    return next as T;
  });
}

/** Versión segura para el navegador del precio resuelto. */
export function toPublicResolvedPrice(resolved: ResolvedPrice) {
  return {
    unitPrice: resolved.unitPrice,
    purchasable: resolved.purchasable,
    requiresQuote: resolved.requiresQuote,
  };
}

/** Retira campos internos de auditoría de un objeto con resolvedPrice. */
export function stripInternalPriceFields<T extends Record<string, any>>(obj: T): T {
  if (!obj?.resolvedPrice) return obj;
  const { source, basePrice, profileId, profileCode, ...publicPrice } = obj.resolvedPrice;
  return { ...obj, resolvedPrice: publicPrice };
}

/**
 * Adjunta `resolvedPrice` (versión pública) a cada item de un carrito,
 * resuelto para el VISOR actual (sesión server-side). En carritos compartidos
 * el invitado ve su precio autorizado, nunca el snapshot del dueño.
 * Batch, sin N+1.
 */
export async function attachResolvedPricesToCartItems<
  T extends { items?: Array<{ productId: string; variantId?: string | null }> | null }
>(
  cart: T,
  ctx: PricingCustomerContext = {}
): Promise<T> {
  if (!cart?.items || !Array.isArray(cart.items) || cart.items.length === 0) {
    return cart;
  }

  const { prices } = await resolvePricesForItems(
    cart.items.map((item) => ({
      productId: item.productId,
      variantId: item.variantId ?? null,
    })),
    ctx
  );

  return {
    ...cart,
    items: cart.items.map((item) => {
      const resolved = prices.get(priceKey(item.productId, item.variantId ?? null));
      return resolved
        ? { ...item, resolvedPrice: toPublicResolvedPrice(resolved) }
        : item;
    }),
  };
}
