import { db } from "./db";
import {
  getActivePriceProfile,
  loadProfileOverrides,
  resolvePricesFromProductMap,
} from "./pricing";
import type { RequestType } from "./order-status";

export class CartValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CartValidationError";
  }
}

export interface InputCartItem {
  productId: string;
  variantId?: string | null;
  quantity: number;
}

export interface ValidatedCartItem {
  productId: string;
  productName: string;
  productSku: string | null;
  variantId: string | null;
  variantName: string | null;
  variantCode: string | null;
  quantity: number;
  /** Precio resuelto server-side. null SOLO en modo cotización (requiere cotización). */
  unitPrice: number | null;
  lineTotal: number;
  requiresQuote: boolean;
}

export interface ValidationResult {
  validatedItems: ValidatedCartItem[];
  /** Suma de líneas con precio conocido. Las líneas por cotizar aportan 0. */
  subtotal: number;
  /** true si al menos una línea quedó sin precio (requiere cotización). */
  hasQuoteItems: boolean;
}

export interface ValidateAndPriceOptions {
  /**
   * Cliente (User role CUSTOMER) que determina el precio del carrito.
   * DEBE provenir de la sesión autenticada server-side o de una acción
   * administrativa autorizada — nunca de datos enviados por el navegador.
   * Invitado => null => precio base/default autorizado para invitados.
   */
  customerId?: string | null;
  /**
   * 'pedido' (default): toda línea exige precio resuelto > 0; una línea que
   * requiere cotización rechaza la operación completa.
   * 'cotizacion': las líneas sin precio se aceptan con unitPrice null
   * (se persisten como pendientes de cotización); producto, variante,
   * cantidad, mínimos e inventario se validan igual.
   */
  requestType?: RequestType;
}

/**
 * Valida items de carrito contra la base de datos:
 * - Verifica que existan productos y estén activos
 * - Verifica disponiblidad de stock (stockStatus != 'agotado')
 * - Valida relación producto-variante y estado de la variante
 * - Enfuerza cantidad mínima mayorista (minWholesaleQty)
 * - Resuelve TODA la resolución monetaria vía el motor único (src/lib/pricing.ts)
 * - Recalcula precios unitarios y subtotal exclusivamente desde BD
 */
export async function validateAndPriceItems(
  items: InputCartItem[],
  tx: any = db,
  options: ValidateAndPriceOptions = {}
): Promise<ValidationResult> {
  const requestType: RequestType = options.requestType ?? "pedido";

  if (!items || !Array.isArray(items) || items.length === 0) {
    throw new CartValidationError("El carrito debe tener al menos un producto.");
  }

  const productIds = Array.from(new Set(items.map((i) => i.productId).filter(Boolean)));

  if (productIds.length === 0) {
    throw new CartValidationError("Los productos especificados no son válidos.");
  }

  const products = await tx.product.findMany({
    where: { id: { in: productIds } },
    include: {
      variants: true,
    },
  });

  const productMap = new Map<string, (typeof products)[number]>(
    products.map((p: (typeof products)[number]) => [p.id, p])
  );

  // Motor único de precios: resolución batch (perfil del cliente + overrides)
  const profile = await getActivePriceProfile(options.customerId, tx);
  const variantIds = Array.from(
    new Set(items.map((i) => i.variantId).filter(Boolean) as string[])
  );
  const overrides = profile
    ? await loadProfileOverrides(profile, productIds, variantIds, tx)
    : undefined;
  const { prices: resolvedPrices } = resolvePricesFromProductMap(
    items,
    productMap,
    profile,
    overrides
  );

  // Track aggregated requested quantities by target key to prevent overselling through split lines
  const requestedTotalsByKey = new Map<string, number>();
  for (const item of items) {
    if (item.productId && typeof item.quantity === "number" && item.quantity > 0) {
      const key = `${item.productId}:${item.variantId || ""}`;
      requestedTotalsByKey.set(key, (requestedTotalsByKey.get(key) || 0) + item.quantity);
    }
  }

  const validatedItems: ValidatedCartItem[] = [];
  let hasQuoteItems = false;

  for (const item of items) {
    if (!item.productId) {
      throw new CartValidationError("Se requiere productId para todos los ítems.");
    }

    const product = productMap.get(item.productId);

    if (!product || !product.isActive) {
      throw new CartValidationError(
        `El producto "${product?.name || item.productId}" no está disponible.`
      );
    }

    if (product.stockStatus === "agotado") {
      throw new CartValidationError(`El producto "${product.name}" está agotado.`);
    }

    if (
      typeof item.quantity !== "number" ||
      isNaN(item.quantity) ||
      item.quantity <= 0 ||
      !Number.isInteger(item.quantity)
    ) {
      throw new CartValidationError(
        `La cantidad para el producto "${product.name}" debe ser un número entero mayor a cero.`
      );
    }

    const minQty = product.minWholesaleQty || 1;
    if (item.quantity < minQty) {
      throw new CartValidationError(
        `La cantidad mínima mayorista para "${product.name}" es de ${minQty} unidad${
          minQty > 1 ? "es" : ""
        }.`
      );
    }

    let variantName: string | null = null;
    let variantCode: string | null = null;
    let variantId: string | null = null;

    if (item.variantId) {
      const variant = product.variants.find((v) => v.id === item.variantId);

      if (!variant || variant.productId !== product.id) {
        throw new CartValidationError(
          `La variante especificada no pertenece al producto "${product.name}".`
        );
      }

      if (!variant.isActive) {
        throw new CartValidationError(
          `La variante "${variant.name}" del producto "${product.name}" no está disponible.`
        );
      }

      if (variant.stockStatus === "agotado") {
        throw new CartValidationError(
          `La variante "${variant.name}" del producto "${product.name}" está agotada.`
        );
      }

      // Validar inventario numérico de variante (no permitir sobreventa silenciosa)
      const availableVariantStock = variant.stockQuantity ?? 0;
      const totalRequested = requestedTotalsByKey.get(`${product.id}:${variant.id}`) ?? item.quantity;
      if (totalRequested > availableVariantStock) {
        throw new CartValidationError(
          `No hay suficiente disponibilidad para "${product.name} (${variant.name})". Solicitado: ${totalRequested}, disponible: ${availableVariantStock}.`
        );
      }

      variantId = variant.id;
      variantName = variant.name;
      variantCode = variant.code;
    } else {
      // Validar inventario numérico del producto sin variante (no permitir sobreventa silenciosa)
      const availableProductStock = product.stockQuantity ?? 0;
      const totalRequested = requestedTotalsByKey.get(`${product.id}:`) ?? item.quantity;
      if (totalRequested > availableProductStock) {
        throw new CartValidationError(
          `No hay suficiente disponibilidad para "${product.name}". Solicitado: ${totalRequested}, disponible: ${availableProductStock}.`
        );
      }
    }

    // Precio resuelto EXCLUSIVAMENTE por el motor server-side
    const resolved = resolvedPrices.get(`${product.id}::${item.variantId || ""}`);
    const resolvedUnitPrice = resolved?.unitPrice ?? 0;
    const requiresQuote = resolvedUnitPrice === null || resolvedUnitPrice <= 0;

    if (requiresQuote && requestType === "pedido") {
      const displayName = variantName ? `"${product.name} (${variantName})"` : `"${product.name}"`;
      throw new CartValidationError(
        `El producto ${displayName} requiere cotización y no puede tramitarse con precio COP 0.`
      );
    }

    const unitPrice = requiresQuote ? null : resolvedUnitPrice;
    if (requiresQuote) hasQuoteItems = true;

    validatedItems.push({
      productId: product.id,
      productName: product.name,
      productSku: product.sku ?? null,
      variantId,
      variantName,
      variantCode,
      quantity: item.quantity,
      unitPrice,
      lineTotal: (unitPrice ?? 0) * item.quantity,
      requiresQuote,
    });
  }

  const subtotal = validatedItems.reduce((sum, item) => sum + item.lineTotal, 0);

  return {
    validatedItems,
    subtotal,
    hasQuoteItems,
  };
}
