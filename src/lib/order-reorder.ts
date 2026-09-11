import { db } from "./db";
import { validateAndPriceItems, CartValidationError } from "./cart-validation";
import {
  resolvePricesForItems,
  type PricingCustomerContext,
} from "./pricing";
import { upsertActiveCart } from "./order-cart-upsert";
import {
  authorizeOrderAccess,
  OrderAccessError,
  type OrderViewer,
} from "./order-access";

/**
 * "VOLVER A PEDIR" (Fase 3).
 *
 * Toma productId/variantId/cantidad de un pedido histórico, verifica
 * existencia/activos/inventario/mínimos ACTUALES, resuelve el precio ACTUAL
 * del cliente con el motor único y carga el resultado en el carrito ACTIVO.
 *
 * - NUNCA crea un Order directamente ni toca el pedido origen
 *   (sus snapshots quedan intactos).
 * - Si el visor ya tiene carrito con productos y no hay decisión explícita
 *   (mode add|replace), responde con conflicto controlado para que la UI
 *   pregunte. Por defecto NO se modifica parcialmente el carrito: cargar
 *   solo los disponibles requiere `allowPartial` (confirmación explícita).
 *
 * ATOMICIDAD: toda la fase de escritura ocurre dentro de UNA transacción con
 * lock pesimista del carrito (`SELECT ... FOR UPDATE`, mismo patrón que
 * `createOrderFromCart`) y re-lectura FRESCA de sus líneas: el estado final
 * se valida ANTES de destruir el carrito anterior. Si la validación combinada
 * falla y `allowPartial` es falso, se aborta con 409 y CERO writes: el
 * carrito del cliente queda exactamente como estaba. Con `allowPartial` las
 * líneas combinadas (carrito + reorder) nunca se encogen por debajo de las
 * unidades que el cliente YA tenía: se conserva la cantidad original del
 * carrito y solo la adición del reorder se marca como bloqueada por stock.
 */

export type ReorderItemStatus =
  | "added"
  | "requires_quote"
  | "product_removed"
  | "product_inactive"
  | "variant_missing"
  | "variant_inactive"
  | "exceeds_stock"
  | "below_min_qty"
  | "invalid_quantity";

export interface ReorderItemResult {
  productId: string;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  quantity: number;
  status: ReorderItemStatus;
  /** Precio ACTUAL resuelto para el cliente (null => cotización). */
  currentUnitPrice: number | null;
  /** Precio histórico del pedido origen (solo informativo). */
  historicalUnitPrice: number | null;
  minQtyRequired?: number;
  availableQuantity?: number;
}

export interface ReorderResult {
  /** Conflicto de carrito existente: la UI debe preguntar add|replace. */
  conflict?: { cartItemCount: number };
  items: ReorderItemResult[];
  addedCount: number;
  blockedCount: number;
  cart?: { id: string; uuid: string; itemCount: number; subtotal: number };
  /** true si al menos una línea disponible cambió de precio vs el histórico. */
  priceChanged: boolean;
}

export class ReorderError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "ReorderError";
    this.status = status;
  }
}

interface ReorderOptions {
  orderId: string;
  viewer: OrderViewer;
  /** 'add' | 'replace' — requerido si el carrito ya tiene productos. */
  mode?: unknown;
  /** Cargar solo los disponibles (confirmación explícita de la UI). */
  allowPartial?: boolean;
  /** Override para tests. */
  pricingCtx?: PricingCustomerContext;
}

function isLoadable(status: ReorderItemStatus): boolean {
  return status === "added" || status === "requires_quote";
}

/** Línea final candidata: cantidad tentativa + unidades ya presentes en el carrito. */
interface FinalLine {
  productId: string;
  variantId: string | null;
  quantity: number;
  unitPrice: number | null;
  /** Cantidad que el cliente YA tenía en el carrito (null => línea solo del reorder). */
  existingQuantity: number | null;
}

export async function reorderOrderItems(options: ReorderOptions): Promise<ReorderResult> {
  const { orderId, viewer } = options;

  const order = await db.order.findUnique({
    where: { id: orderId },
    include: { items: true },
  });

  if (!order) {
    throw new OrderAccessError("Pedido no encontrado", 404);
  }

  authorizeOrderAccess(order, viewer);

  if (!order.items.length) {
    throw new ReorderError("El pedido origen no tiene productos", 400);
  }

  // El precio ACTUAL se resuelve con el contexto del VISOR (cliente
  // autenticado => su perfil; invitado => base). Nunca se copian los
  // snapshots históricos como precios actuales.
  const pricingCtx = options.pricingCtx ?? {
    customerId:
      viewer.user && viewer.user.role?.toLowerCase() === "customer"
        ? viewer.user.id
        : null,
  };

  const productIds = Array.from(new Set(order.items.map((i) => i.productId)));

  const products = await db.product.findMany({
    where: { id: { in: productIds } },
    select: {
      id: true,
      name: true,
      isActive: true,
      stockQuantity: true,
      stockStatus: true,
      minWholesaleQty: true,
      variants: {
        select: { id: true, isActive: true, stockQuantity: true, stockStatus: true },
      },
    },
  });

  const productsById = new Map(products.map((p) => [p.id, p]));

  const { prices } = await resolvePricesForItems(
    order.items
      .filter((i) => productsById.has(i.productId))
      .map((i) => ({ productId: i.productId, variantId: i.variantId })),
    pricingCtx
  );

  // ---- 1) Evaluación por ítem contra el estado ACTUAL, sin tocar el carrito.
  const itemResults: ReorderItemResult[] = order.items.map((item) => {
    const base = {
      productId: item.productId,
      variantId: item.variantId,
      productName: item.productName,
      variantName: item.variantName,
      quantity: item.quantity,
      historicalUnitPrice:
        item.unitPrice !== null && item.unitPrice !== undefined ? item.unitPrice : null,
    };

    if (!(typeof item.quantity === "number" && Number.isInteger(item.quantity) && item.quantity > 0)) {
      return { ...base, status: "invalid_quantity" as const, currentUnitPrice: null };
    }

    const product = productsById.get(item.productId);
    if (!product) {
      return { ...base, status: "product_removed" as const, currentUnitPrice: null };
    }
    if (!product.isActive) {
      return { ...base, status: "product_inactive" as const, currentUnitPrice: null };
    }

    const variant = item.variantId
      ? product.variants.find((v) => v.id === item.variantId)
      : null;
    if (item.variantId && !variant) {
      return { ...base, status: "variant_missing" as const, currentUnitPrice: null };
    }
    if (variant && !variant.isActive) {
      return { ...base, status: "variant_inactive" as const, currentUnitPrice: null };
    }

    const availableQuantity =
      (variant ? variant.stockQuantity : product.stockQuantity) ?? 0;
    const stockStatus = variant ? variant.stockStatus : product.stockStatus;

    const minQty = product.minWholesaleQty || 1;
    if (item.quantity < minQty) {
      return {
        ...base,
        status: "below_min_qty" as const,
        currentUnitPrice: null,
        minQtyRequired: minQty,
        availableQuantity,
      };
    }

    if (stockStatus === "agotado" || availableQuantity <= 0) {
      return {
        ...base,
        status: "exceeds_stock" as const,
        currentUnitPrice: null,
        availableQuantity: Math.max(availableQuantity, 0),
      };
    }

    if (item.quantity > availableQuantity) {
      return {
        ...base,
        status: "exceeds_stock" as const,
        currentUnitPrice: null,
        availableQuantity,
      };
    }

    // Disponible: precio ACTUAL del motor (null => requiere cotización).
    const resolved = prices.get(`${item.productId}::${item.variantId || ""}`);
    const currentUnitPrice =
      resolved && resolved.unitPrice !== null && resolved.unitPrice > 0
        ? resolved.unitPrice
        : null;

    return {
      ...base,
      status: currentUnitPrice === null ? ("requires_quote" as const) : ("added" as const),
      currentUnitPrice,
    };
  });

  const loadable = itemResults.filter((r) => isLoadable(r.status));
  const blockedCount = itemResults.filter((r) => !isLoadable(r.status)).length;
  const priceChanged = () =>
    itemResults.some(
      (r) =>
        isLoadable(r.status) &&
        r.historicalUnitPrice !== null &&
        r.currentUnitPrice !== null &&
        r.currentUnitPrice !== r.historicalUnitPrice
    );

  // ---- 2) Carrito ACTIVO del visor (misma semántica que el resto del sitio).
  const cart = await upsertActiveCart(viewer.sessionId, viewer.user?.id ?? null);

  const cartItems = await db.cartItem.findMany({
    where: { cartId: cart.id },
    select: { id: true, productId: true, variantId: true, quantity: true },
  });

  const requestedMode =
    options.mode === "add" || options.mode === "replace" ? options.mode : null;

  if (cartItems.length > 0 && !requestedMode) {
    return {
      conflict: { cartItemCount: cartItems.length },
      items: itemResults,
      addedCount: 0,
      blockedCount,
      priceChanged: priceChanged(),
    };
  }

  // ---- 3) Bloqueos: por defecto el carrito NO se modifica parcialmente.
  if (blockedCount > 0 && !options.allowPartial) {
    return {
      items: itemResults,
      addedCount: 0,
      blockedCount,
      priceChanged: priceChanged(),
    };
  }

  // ---- 4) Escritura ATÓMICA: lock del carrito, validación del estado FINAL
  // y solo entonces reemplazo de líneas. Nada se destruye antes de validar.
  return db.$transaction(async (tx) => {
    // a) Lock pesimista del carrito: serializa el reorder con otras escrituras
    //    del mismo carrito (checkout, edición manual, otro reorder).
    await tx.$queryRaw`SELECT id FROM "Cart" WHERE id = ${cart.id} FOR UPDATE`;

    // b) Re-lectura FRESCA tras el lock: protege frente a lost updates entre
    //    la lectura externa y la adquisición del lock.
    const freshCartItems = await tx.cartItem.findMany({
      where: { cartId: cart.id },
      select: { id: true, productId: true, variantId: true, quantity: true },
    });

    // c) Conflicto re-evaluado sobre el estado fresco (sin writes).
    if (freshCartItems.length > 0 && !requestedMode) {
      return {
        conflict: { cartItemCount: freshCartItems.length },
        items: itemResults,
        addedCount: 0,
        blockedCount,
        priceChanged: priceChanged(),
      };
    }

    // d) Defensa en profundidad: bloqueos re-chequeados dentro de la tx.
    if (blockedCount > 0 && !options.allowPartial) {
      return {
        items: itemResults,
        addedCount: 0,
        blockedCount,
        priceChanged: priceChanged(),
      };
    }

    // e) Estado FINAL: add conserva las líneas frescas del carrito y combina
    //    las del pedido; replace usa SOLO las del pedido. Nada se borra aún.
    const finalLines = new Map<string, FinalLine>();

    if (requestedMode !== "replace") {
      for (const existing of freshCartItems) {
        finalLines.set(`${existing.productId}::${existing.variantId ?? ""}`, {
          productId: existing.productId,
          variantId: existing.variantId ?? null,
          quantity: existing.quantity,
          unitPrice: null, // se resuelve con el motor más abajo
          existingQuantity: existing.quantity,
        });
      }
    }

    for (const result of loadable) {
      const key = `${result.productId}::${result.variantId ?? ""}`;
      const existingLine = finalLines.get(key);
      const quantity = (existingLine?.quantity ?? 0) + result.quantity;
      finalLines.set(key, {
        productId: result.productId,
        variantId: result.variantId ?? null,
        quantity,
        unitPrice: null,
        existingQuantity: existingLine?.existingQuantity ?? null,
      });
    }

    // f) Validación server-side del estado FINAL (motor único, modo
    //    cotización: el carrito puede contener líneas por cotizar).
    let batchError: CartValidationError | undefined;
    if (finalLines.size > 0) {
      try {
        const validatedResult = await validateAndPriceItems(
          Array.from(finalLines.values()).map((line) => ({
            productId: line.productId,
            variantId: line.variantId,
            quantity: line.quantity,
          })),
          tx,
          { customerId: pricingCtx.customerId, requestType: "cotizacion" }
        );
        for (const item of validatedResult.validatedItems) {
          const key = `${item.productId}::${item.variantId ?? ""}`;
          const line = finalLines.get(key);
          if (line) line.unitPrice = item.unitPrice;
        }
      } catch (err) {
        if (!(err instanceof CartValidationError)) throw err;
        batchError = err;
      }
    }

    // g) La validación combinada falló: decidir abort vs resolución por línea.
    if (batchError) {
      if (!options.allowPartial) {
        // CERO writes: aún no se tocó ninguna fila; el carrito queda igual.
        throw new ReorderError(
          "Hay líneas que superan el stock disponible al combinarse con tu carrito. Tu carrito no fue modificado.",
          409
        );
      }

      // allowPartial: resolución por línea. Una línea COMBINADA nunca se
      // encoge por debajo de las unidades que el cliente ya tenía: si la
      // suma carrito+reorder no es válida se conserva la cantidad ORIGINAL
      // del carrito y solo la adición se marca como bloqueada por stock.
      for (const [key, line] of Array.from(finalLines.entries())) {
        const attempts =
          line.existingQuantity !== null && line.quantity !== line.existingQuantity
            ? [line.quantity, line.existingQuantity]
            : [line.quantity];

        let keptQuantity: number | null = null;
        for (const attemptQty of attempts) {
          try {
            const perLine = await validateAndPriceItems(
              [{ productId: line.productId, variantId: line.variantId, quantity: attemptQty }],
              tx,
              { customerId: pricingCtx.customerId, requestType: "cotizacion" }
            );
            // validateAndPriceItems no recorta cantidades: acepta la cantidad
            // intentada o falla; nunca devuelve una cantidad distinta.
            line.quantity = attemptQty;
            line.unitPrice = perLine.validatedItems[0].unitPrice;
            keptQuantity = attemptQty;
            break;
          } catch {
            // siguiente intento (cantidad original del carrito)
          }
        }

        const markBlocked = () => {
          const idx = itemResults.findIndex(
            (r) =>
              r.productId === line.productId &&
              (r.variantId ?? null) === (line.variantId ?? null)
          );
          if (idx >= 0) {
            itemResults[idx] = {
              ...itemResults[idx],
              status: "exceeds_stock",
              currentUnitPrice: null,
            };
          }
        };

        if (keptQuantity === null) {
          finalLines.delete(key);
          markBlocked();
        } else if (keptQuantity === line.existingQuantity) {
          // La adición del reorder fue bloqueada; las unidades originales
          // del carrito se conservan intactas.
          markBlocked();
        }
      }
    }

    // h) Escrituras (dentro de la tx, DESPUÉS de validar el estado final).
    await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
    if (finalLines.size > 0) {
      await tx.cartItem.createMany({
        data: Array.from(finalLines.values()).map((line) => ({
          cartId: cart.id,
          productId: line.productId,
          variantId: line.variantId,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
        })),
      });
    }

    // Subtotal del carrito: metadata de líneas con precio conocido.
    const subtotal = Array.from(finalLines.values()).reduce(
      (sum, line) => sum + (line.unitPrice ?? 0) * line.quantity,
      0
    );

    await tx.cart.update({
      where: { id: cart.id },
      data: { subtotal, updatedAt: new Date() },
    });

    const finalItemCount = finalLines.size;
    const finalLoadable = itemResults.filter((r) => isLoadable(r.status));

    return {
      items: itemResults,
      addedCount: finalLoadable.length,
      blockedCount: itemResults.filter((r) => !isLoadable(r.status)).length,
      cart: { id: cart.id, uuid: cart.uuid, itemCount: finalItemCount, subtotal },
      priceChanged: priceChanged(),
    };
  });
}
