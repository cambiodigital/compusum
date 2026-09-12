import { db } from "./db";
import { Prisma } from "@prisma/client";
import { validateAndPriceItems, CartValidationError } from "./cart-validation";
import {
  resolvePricesForItems,
  type PricingCustomerContext,
} from "./pricing";
import {
  upsertActiveCart,
  lockCartForMutation,
  lockGuestSessionIdentity,
  lockUserCartIdentity,
  CartMutationError,
} from "./order-cart-upsert";
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
 * ATOMICIDAD: toda la fase de escritura ocurre dentro de UNA transacción que
 * comienza con el advisory lock de identidad (guest o userId del visor, ver
 * `order-cart-upsert.ts`), continúa con el lock del Order y su reautorización
 * autoritativa (orden global de locks Order→Cart; si el pedido fue transferido
 * a una cuenta en pleno vuelo, el guest recibe 403 con CERO writes y sin crear
 * carrito), re-lee las líneas del pedido BAJO el lock (si una edición
 * concurrente cambió el contenido, se re-evalúa contra las líneas post-lock)
 * y sigue con el lock pesimista del carrito (`SELECT ... FOR UPDATE`, mismo
 * patrón que `createOrderFromCart`) y la re-lectura FRESCA de sus líneas: el
 * estado final se valida ANTES de destruir el carrito anterior. Si la
 * validación combinada falla y `allowPartial` es falso, se aborta con 409 y
 * CERO writes: el carrito del cliente queda exactamente como estaba. Con
 * `allowPartial` las líneas combinadas (carrito + reorder) nunca se encogen
 * por debajo de las unidades que el cliente YA tenía: se conserva la cantidad
 * original del carrito y solo la adición del reorder se marca como bloqueada
 * por stock.
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

/**
 * Sentinela PRIVADO del módulo: el carrito activo fue convertido a pedido por
 * un checkout mientras el reorder esperaba el lock. NO se exporta: el único
 * consumidor es el bucle de reintentos de `reorderOrderItems`.
 */
class CartConvertedError extends Error {
  constructor() {
    super("El carrito fue convertido mientras se esperaba el lock");
    this.name = "CartConvertedError";
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

/** Línea fuente del reorder (forma mínima de OrderItem usada por la evaluación). */
interface ReorderSourceLine {
  productId: string;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  quantity: number;
  unitPrice: number | null;
}

/** Resultado de evaluar líneas del pedido contra el estado ACTUAL del catálogo. */
interface ItemEvaluation {
  itemResults: ReorderItemResult[];
  loadable: ReorderItemResult[];
  blockedCount: number;
  /** true si al menos una línea disponible cambió de precio vs el histórico. */
  priceChanged: boolean;
}

/**
 * Mapa de contenido `productId::variantId -> quantity` para comparar el
 * contenido de dos lecturas de líneas (los ids de orderItem cambian tras una
 * edición: se compara CONTENIDO, no ids).
 */
function lineContentMap(lines: Array<{ productId: string; variantId: string | null; quantity: number }>) {
  const map = new Map<string, number>();
  for (const line of lines) {
    map.set(`${line.productId}::${line.variantId ?? ""}`, line.quantity);
  }
  return map;
}

function sameLineContent(
  a: Array<{ productId: string; variantId: string | null; quantity: number }>,
  b: Array<{ productId: string; variantId: string | null; quantity: number }>
): boolean {
  const mapA = lineContentMap(a);
  const mapB = lineContentMap(b);
  if (mapA.size !== mapB.size) return false;
  for (const [key, qty] of mapA) {
    if (mapB.get(key) !== qty) return false;
  }
  return true;
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

  // ---- 1) Evaluación por ítem contra el estado ACTUAL, sin tocar el carrito.
  // Extraída como función pura (solo lecturas): se ejecuta pre-tx para el
  // fast-fail y el fast-path "no modificado", y se re-ejecuta BAJO el lock
  // del Order cuando el contenido de las líneas cambió en plena carrera.
  const evaluateItems = async (
    lines: ReorderSourceLine[],
    client: Prisma.TransactionClient | typeof db = db
  ): Promise<ItemEvaluation> => {
    const productIds = Array.from(new Set(lines.map((i) => i.productId)));

    const products = await client.product.findMany({
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
      lines
        .filter((i) => productsById.has(i.productId))
        .map((i) => ({ productId: i.productId, variantId: i.variantId })),
      { ...pricingCtx, tx: client }
    );

    const itemResults: ReorderItemResult[] = lines.map((item) => {
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
    const priceChanged = itemResults.some(
      (r) =>
        isLoadable(r.status) &&
        r.historicalUnitPrice !== null &&
        r.currentUnitPrice !== null &&
        r.currentUnitPrice !== r.historicalUnitPrice
    );

    return { itemResults, loadable, blockedCount, priceChanged };
  };

  // Evaluación pre-tx: base del fast-path (líneas sin cambios) y del
  // fast-fail de forma; NUNCA es la fuente de una escritura si el pedido
  // cambió bajo el lock (ver re-evaluación dentro de la tx).
  const evaluation = await evaluateItems(order.items, db);

  // ---- 2) Carrito ACTIVO del visor (misma semántica que el resto del sitio).
  // Admin/editor asisten ventas sobre carritos de terceros (authorizeOrderAccess
  // ya solo los admite a ellos en el portal cliente). El AGENT comercial NO
  // reordena por esta vía: gestiona SUS pedidos vía el API de backoffice
  // (/api/admin/orders), no por el portal; authorizeOrderAccess lo rechaza
  // antes de llegar aquí, así que el bypass es exactamente admin|editor.
  const viewerRole = viewer.user?.role?.toLowerCase() ?? null;
  const isStaffViewer = viewerRole === "admin" || viewerRole === "editor";

  const requestedMode =
    options.mode === "add" || options.mode === "replace" ? options.mode : null;

  // Intento de escritura atómico: reautorización autoritativa del Order bajo
  // lock ANTES de tocar el carrito (orden global de locks Order→Cart) y solo
  // entonces resolución + lock del carrito, re-lectura fresca y escrituras.
  const runAttempt = async (): Promise<ReorderResult> => {
    // Id del carrito intentado en ESTA pasada: permite traducir el
    // CART_NOT_ACTIVE del lock a CartConvertedError (reintento acotado).
    let attemptCartId: string | null = null;

    try {
      return await db.$transaction(async (tx) => {
        // Advisory locks de identidad: SIEMPRE primeras sentencias de la tx
        // (antes del lock del Order), en orden global guest→user. El visor
        // invitado serializa contra la transferencia/checkout de SU sesión;
        // el autenticado (admin/agent asistiendo incluidos) contra su userId.
        if (!viewer.user && viewer.sessionId) {
          await lockGuestSessionIdentity(tx, viewer.sessionId);
        } else if (viewer.user) {
          await lockUserCartIdentity(tx, viewer.user.id);
        }

        // a) Lock pesimista del Order y reautorización autoritativa bajo el
        //    lock: si el pedido fue transferido a una cuenta mientras tanto,
        //    el guest recibe 403 y la tx aborta con CERO writes (ni creación
        //    de carrito). Orden global: Order ANTES que Cart.
        const lockedOrder = await tx.$queryRaw<
          { id: string; customerId: string | null; sessionId: string | null }[]
        >`SELECT id, "customerId", "sessionId" FROM "Order" WHERE id = ${orderId} FOR UPDATE`;

        if (!lockedOrder || lockedOrder.length === 0) {
          throw new OrderAccessError("Pedido no encontrado", 404);
        }

        authorizeOrderAccess(lockedOrder[0], viewer);

        // a2) Bajo el lock del Order, el contenido del reorder proviene
        //     SIEMPRE de las líneas post-lock: nunca se cargan líneas que ya
        //     no pertenecen al pedido. Si una edición concurrente cambió las
        //     líneas mientras esperábamos el lock (comparación por contenido
        //     producto::variante+cantidad, no por ids), se re-evalúa TODO
        //     (stock/precios/estado ACTUAL) contra el contenido fresco y ese
        //     resultado gobierna conflictos, bloqueos, líneas finales y
        //     respuesta. Si el contenido coincide, se conserva la evaluación
        //     pre-tx (comportamiento idéntico al fast-path).
        const lockedLines = await tx.orderItem.findMany({ where: { orderId } });
        const activeEvaluation = sameLineContent(order.items, lockedLines)
          ? evaluation
          : await evaluateItems(lockedLines, tx);

        // b) Carrito ACTIVO del visor resuelto DENTRO de la tx (después del
        //    lock del Order, misma semántica canónica que el resto del sitio).
        const cart = await upsertActiveCart(
          viewer.sessionId,
          viewer.user?.id ?? null,
          undefined,
          tx
        );
        attemptCartId = cart.id;

        // c) Única disciplina: lock del carrito + revalidación autoritativa
        //    (estado y ownership POST-lock): serializa el reorder con otras
        //    escrituras del mismo carrito (checkout, edición manual, otro
        //    reorder). Cart DESPUÉS del Order (orden global requerido).
        await lockCartForMutation(tx, cart.id, {
          sessionId: viewer.sessionId ?? null,
          userId: viewer.user?.id ?? null,
          isAdminOrAgent: isStaffViewer,
        });

        // d) Lectura FRESCA bajo el lock: única fuente del estado del carrito.
        const freshCartItems = await tx.cartItem.findMany({
          where: { cartId: cart.id },
          select: { id: true, productId: true, variantId: true, quantity: true },
        });

        // e) Conflicto sobre el estado fresco (sin writes).
        if (freshCartItems.length > 0 && !requestedMode) {
          return {
            conflict: { cartItemCount: freshCartItems.length },
            items: activeEvaluation.itemResults,
            addedCount: 0,
            blockedCount: activeEvaluation.blockedCount,
            priceChanged: activeEvaluation.priceChanged,
          };
        }

        // f) Defensa en profundidad: bloqueos re-chequeados dentro de la tx.
        if (activeEvaluation.blockedCount > 0 && !options.allowPartial) {
          return {
            items: activeEvaluation.itemResults,
            addedCount: 0,
            blockedCount: activeEvaluation.blockedCount,
            priceChanged: activeEvaluation.priceChanged,
          };
        }

        // g) Estado FINAL: add conserva las líneas frescas del carrito y combina
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

        for (const result of activeEvaluation.loadable) {
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

        // h) Validación server-side del estado FINAL (motor único, modo
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

        // i) La validación combinada falló: decidir abort vs resolución por línea.
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
              const idx = activeEvaluation.itemResults.findIndex(
                (r) =>
                  r.productId === line.productId &&
                  (r.variantId ?? null) === (line.variantId ?? null)
              );
              if (idx >= 0) {
                activeEvaluation.itemResults[idx] = {
                  ...activeEvaluation.itemResults[idx],
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

        // j) Escrituras (dentro de la tx, DESPUÉS de validar el estado final).
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

        // uuid del carrito efectivo (bajo lock: consistente con el snapshot).
        const cartRow = await tx.cart.findUnique({
          where: { id: cart.id },
          select: { uuid: true },
        });

        const finalItemCount = finalLines.size;
        const finalLoadable = activeEvaluation.itemResults.filter((r) => isLoadable(r.status));

        return {
          items: activeEvaluation.itemResults,
          addedCount: finalLoadable.length,
          blockedCount: activeEvaluation.itemResults.filter((r) => !isLoadable(r.status)).length,
          cart: { id: cart.id, uuid: cartRow?.uuid ?? "", itemCount: finalItemCount, subtotal },
          priceChanged: activeEvaluation.priceChanged,
        };
      });
    } catch (caught) {
      // Traduce los errores de la disciplina de mutación a errores del módulo.
      if (caught instanceof CartMutationError) {
        if (caught.code === "CART_FORBIDDEN") {
          throw new OrderAccessError("No tienes acceso a este carrito", 403);
        }
        if (caught.code === "CART_NOT_FOUND") {
          throw new ReorderError("Carrito no encontrado", 404);
        }
        // CART_NOT_ACTIVE: distinguir convertido (el bucle reintenta con el
        // carrito activo actual) de un carrito inactivo que upsertActiveCart
        // volvería a devolver (ese caso NO reintenta).
        const statusNow = attemptCartId
          ? (
              await db.cart.findUnique({
                where: { id: attemptCartId },
                select: { status: true },
              })
            )?.status
          : null;
        if (statusNow === "convertido") {
          throw new CartConvertedError();
        }
        throw new ReorderError("Este carrito ya no se puede modificar", 409);
      }
      throw caught;
    }
  };

  // Bucle de reintentos acotado (máx. 2 intentos): si el checkout convirtió
  // el carrito mientras se esperaba el lock, NO se escribe nada sobre el
  // convertido (queda EXACTAMENTE intacto); se re-resuelve el carrito activo
  // actual (1 reintento acotado, con el Order re-bloqueado y re-autorizado)
  // o se aborta controlado.
  let attempt = 0;
  while (true) {
    try {
      return await runAttempt();
    } catch (caught) {
      if (caught instanceof CartConvertedError && attempt === 0) {
        attempt += 1;
        continue;
      }
      throw caught instanceof CartConvertedError
        ? new ReorderError("Tu carrito fue procesado mientras se cargaba el pedido. Intentá de nuevo.", 409)
        : caught;
    }
  }
}
