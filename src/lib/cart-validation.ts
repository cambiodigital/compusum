import { db } from "./db";

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
  unitPrice: number;
  lineTotal: number;
}

export interface ValidationResult {
  validatedItems: ValidatedCartItem[];
  subtotal: number;
}

/**
 * Valida items de carrito contra la base de datos:
 * - Verifica que existan productos y estén activos
 * - Verifica disponiblidad de stock (stockStatus != 'agotado')
 * - Valida relación producto-variante y estado de la variante
 * - Enfuerza cantidad mínima mayorista (minWholesaleQty)
 * - Recalcula precios unitarios y subtotal exclusivamente desde BD
 */
export async function validateAndPriceItems(
  items: InputCartItem[],
  tx: any = db
): Promise<ValidationResult> {
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

  const validatedItems: ValidatedCartItem[] = [];

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

    let unitPrice = 0;
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

      variantId = variant.id;
      variantName = variant.name;
      variantCode = variant.code;
      unitPrice =
        variant.wholesalePrice ??
        variant.price ??
        product.wholesalePrice ??
        product.price ??
        0;
    } else {
      unitPrice = product.wholesalePrice ?? product.price ?? 0;
    }

    validatedItems.push({
      productId: product.id,
      productName: product.name,
      productSku: product.sku ?? null,
      variantId,
      variantName,
      variantCode,
      quantity: item.quantity,
      unitPrice,
      lineTotal: unitPrice * item.quantity,
    });
  }

  const subtotal = validatedItems.reduce((sum, item) => sum + item.lineTotal, 0);

  return {
    validatedItems,
    subtotal,
  };
}
