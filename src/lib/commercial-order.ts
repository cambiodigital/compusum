import { Prisma } from "@prisma/client";
import { db } from "./db";
import {
  resolvePricesForItems,
  getActivePriceProfile,
} from "./pricing";
import {
  validateAndPriceItems,
  CartValidationError,
} from "./cart-validation";
import {
  buildOrderItemPriceComparisons,
  type ItemPriceStatus,
} from "./order-detail";
import { isAgentRole } from "./roles";
import { isValidRequestType, type RequestType } from "./order-status";

/**
 * COMMERCIAL ORDER LAYER (Fase 4B) — server-side calculation for the
 * backoffice order detail ("commercial review" for ADMIN/EDITOR/AGENT).
 *
 * Hard rules enforced here:
 * - The browser only ever contributes INTENT (productId, variantId, quantity,
 *   and a manual price ONLY for lines the engine itself reports as
 *   requiresQuote in "cotizacion" mode). Every monetary value is re-resolved
 *   server-side by the single pricing engine.
 * - The pricing customer is ALWAYS `order.customerId` (post-lock). Nothing
 *   from the request body can influence price, subtotal, profile or ownership.
 * - Every write path (line replacement, subtotal, requestType conversion,
 *   audit) happens inside ONE `$transaction` that first takes a pessimistic
 *   row lock (`SELECT ... FOR UPDATE`), re-authorizes against the LOCKED row
 *   and re-checks editability (`status === "solicitado"`). A conditional
 *   `updateMany` adds a second guard against races not covered by the lock.
 * - AGENT isolation fails CLOSED: a foreign order is a 404 with no existence
 *   leak, re-evaluated on the post-lock row.
 * - Audit rows in OrderStatusHistory never delete prior history and derive
 *   `changedBy` from the authenticated actor, never from the client.
 */

export class CommercialOrderError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly code?: string
  ) {
    super(message);
    this.name = "CommercialOrderError";
  }
}

function badRequest(message: string): CommercialOrderError {
  return new CommercialOrderError(message, 400);
}

function notFound(): CommercialOrderError {
  // Identical for missing and foreign orders: existence is never leaked.
  return new CommercialOrderError("Pedido no encontrado", 404);
}

function conflict(message: string): CommercialOrderError {
  return new CommercialOrderError(message, 409);
}

export interface CommercialActor {
  id: string;
  role: string;
  name?: string | null;
}

export interface CommercialLineInput {
  productId: string;
  variantId?: string | null;
  quantity: number;
  /** Manual quote price; honored ONLY for lines the engine reports as requiresQuote. */
  quotedUnitPrice?: number | null;
}

export interface CommercialPreviewLine {
  productId: string;
  variantId: string | null;
  productName: string;
  variantName: string | null;
  variantCode: string | null;
  productSku: string | null;
  quantity: number;
  /** Stored historical/commercial snapshot (OrderItem.unitPrice). */
  snapshotUnitPrice: number | null;
  /** Current engine price for the order's customer (null => requires quote). */
  engineUnitPrice: number | null;
  engineRequiresQuote: boolean;
  priceStatus: ItemPriceStatus;
  priceDifference: number | null;
  currentStockQuantity: number | null;
  minQuantity: number;
  availability: "available" | "unavailable";
  snapshotLineTotal: number;
  engineLineTotal: number;
}

export interface CommercialPreview {
  orderId: string;
  orderNumber: string;
  status: string;
  requestType: string;
  /** Economic composition is editable only while "solicitado". */
  canEdit: boolean;
  /** Every stored line has a positive unit price. */
  isComplete: boolean;
  /** A complete, still-requested quote can be converted into an order. */
  canConvert: boolean;
  /** NAME only — never the profile id or internal rules. */
  customerProfileName: string | null;
  lines: CommercialPreviewLine[];
  storedSubtotal: number;
  engineSubtotal: number;
}

export interface CommercialLineComputation {
  productId: string;
  variantId: string | null;
  quantity: number;
  quotedUnitPrice: number | null;
  engineUnitPrice: number | null;
  engineRequiresQuote: boolean;
  /** Engine price, or the validated manual quote where the engine allows it. */
  finalUnitPrice: number | null;
  lineTotal: number;
  availability: "available" | "unavailable";
  minQuantity: number;
  currentStockQuantity: number | null;
  /** Advisory per-line problem (the authoritative gate is validateAndPriceItems). */
  validationError: string | null;
}

export interface CommercialLinesPreview {
  orderId: string;
  status: string;
  requestType: string;
  canEdit: boolean;
  lines: CommercialLineComputation[];
  subtotal: number;
  isComplete: boolean;
  /** Message of the validation failure that would reject a save, if any. */
  validationError: string | null;
}

/** Row shape read under `FOR UPDATE` (authoritative post-lock state). */
export interface LockedCommercialOrder {
  id: string;
  status: string;
  requestType: string;
  customerId: string | null;
  agentId: string | null;
  subtotal: number;
}

type DbClient = Prisma.TransactionClient | typeof db;

type ProductWithVariants = Prisma.ProductGetPayload<{ include: { variants: true } }>;

/** Reasonable upper bound for a manual quote price (COP). */
const MAX_QUOTED_UNIT_PRICE = 1_000_000_000;

/** Mirrors the pricing engine's internal composite key format. */
function lineKey(productId: string, variantId?: string | null): string {
  return `${productId}::${variantId || ""}`;
}

/** Mirrors cart-validation's aggregated stock key format. */
function stockKey(productId: string, variantId?: string | null): string {
  return `${productId}:${variantId || ""}`;
}

/**
 * Pure structural validation of browser-supplied lines, BEFORE any
 * transaction. Duplicate lines for the same product/variant key are
 * aggregated by summing quantities (same semantics as cart-validation's
 * anti-oversell accounting); the last manual quote price wins.
 * Throws 400 CommercialOrderError on any malformed value.
 */
function normalizeCommercialLines(lines: unknown): {
  productId: string;
  variantId: string | null;
  quantity: number;
  quotedUnitPrice: number | null;
}[] {
  if (!Array.isArray(lines)) {
    throw badRequest("Formato de líneas inválido.");
  }

  const aggregated = new Map<
    string,
    { productId: string; variantId: string | null; quantity: number; quotedUnitPrice: number | null }
  >();

  for (const raw of lines) {
    if (!raw || typeof raw !== "object") {
      throw badRequest("Formato de líneas inválido.");
    }
    const line = raw as Record<string, unknown>;

    const productId = typeof line.productId === "string" ? line.productId.trim() : "";
    if (!productId) {
      throw badRequest("Se requiere productId para todas las líneas.");
    }

    const quantity = line.quantity;
    if (
      typeof quantity !== "number" ||
      !Number.isFinite(quantity) ||
      !Number.isInteger(quantity) ||
      quantity <= 0
    ) {
      throw badRequest("La cantidad debe ser un número entero mayor a cero.");
    }

    let quotedUnitPrice: number | null = null;
    if (line.quotedUnitPrice !== undefined && line.quotedUnitPrice !== null) {
      const quoted = line.quotedUnitPrice;
      if (
        typeof quoted !== "number" ||
        !Number.isFinite(quoted) ||
        quoted <= 0 ||
        quoted > MAX_QUOTED_UNIT_PRICE
      ) {
        throw badRequest(
          "El precio cotizado manual debe ser un número positivo y finito."
        );
      }
      quotedUnitPrice = quoted;
    }

    const variantId =
      typeof line.variantId === "string" && line.variantId.trim()
        ? line.variantId.trim()
        : null;

    const key = lineKey(productId, variantId);
    const existing = aggregated.get(key);
    if (existing) {
      existing.quantity += quantity;
      if (quotedUnitPrice !== null) existing.quotedUnitPrice = quotedUnitPrice;
    } else {
      aggregated.set(key, { productId, variantId, quantity, quotedUnitPrice });
    }
  }

  return Array.from(aggregated.values());
}

/**
 * Pessimistic row lock inside the caller's transaction. Returns the
 * authoritative post-lock row (or null if the order vanished).
 */
export async function lockOrderForCommercialUpdate(
  tx: Prisma.TransactionClient,
  orderId: string
): Promise<LockedCommercialOrder | null> {
  const locked = await tx.$queryRaw<LockedCommercialOrder[]>`
    SELECT id, status, "requestType", "customerId", "agentId", subtotal
    FROM "Order" WHERE id = ${orderId} FOR UPDATE`;
  return locked && locked.length > 0 ? locked[0] : null;
}

/**
 * RBAC for the commercial layer. AGENT may only act on its own orders; a
 * foreign order is a 404 (fail closed, existence never leaked). ADMIN/EDITOR
 * pass. CUSTOMER never reaches this layer (requireBackofficeApi).
 */
export function authorizeCommercialAccess(
  order: { agentId: string | null },
  actor: CommercialActor
): void {
  if (isAgentRole(actor.role) && order.agentId !== actor.id) {
    throw notFound();
  }
}

/**
 * Loads the order with items and authorizes the actor (404 fail-closed for
 * AGENT on foreign orders). Read path only — no lock, no writes.
 */
async function loadOrderForActor(
  orderId: string,
  actor: CommercialActor,
  client: DbClient = db
) {
  const order = await client.order.findUnique({
    where: { id: orderId },
    include: { items: true },
  });
  if (!order) throw notFound();
  authorizeCommercialAccess(order, actor);
  return order;
}

async function loadProductsById(
  productIds: string[],
  client: DbClient
): Promise<Map<string, ProductWithVariants>> {
  const products = productIds.length
    ? await client.product.findMany({
        where: { id: { in: productIds } },
        include: { variants: true },
      })
    : [];
  return new Map(products.map((p) => [p.id, p]));
}

function effectiveRequestType(requestType: string): RequestType {
  return isValidRequestType(requestType) ? requestType : "pedido";
}

/**
 * Advisory per-line validation mirroring cart-validation semantics (active
 * product/variant, not "agotado", minimum wholesale quantity, aggregated
 * stock per product:variant key). Returns null when the line is valid.
 * Prices are NOT validated here — the engine owns that decision.
 */
function lineValidationIssue(
  line: { productId: string; variantId: string | null; quantity: number },
  productsById: Map<string, ProductWithVariants>,
  requestedTotalsByKey: Map<string, number>
): string | null {
  const product = productsById.get(line.productId);

  if (!product || !product.isActive) {
    return `El producto "${product?.name || line.productId}" no está disponible.`;
  }
  if (product.stockStatus === "agotado") {
    return `El producto "${product.name}" está agotado.`;
  }

  const minQty = product.minWholesaleQty || 1;
  if (line.quantity < minQty) {
    return `La cantidad mínima mayorista para "${product.name}" es de ${minQty} unidad${
      minQty > 1 ? "es" : ""
    }.`;
  }

  if (line.variantId) {
    const variant = product.variants.find((v) => v.id === line.variantId);
    if (!variant || variant.productId !== product.id) {
      return `La variante especificada no pertenece al producto "${product.name}".`;
    }
    if (!variant.isActive) {
      return `La variante "${variant.name}" del producto "${product.name}" no está disponible.`;
    }
    if (variant.stockStatus === "agotado") {
      return `La variante "${variant.name}" del producto "${product.name}" está agotada.`;
    }
    const available = variant.stockQuantity ?? 0;
    const requested = requestedTotalsByKey.get(stockKey(product.id, variant.id)) ?? line.quantity;
    if (requested > available) {
      return `No hay suficiente disponibilidad para "${product.name} (${variant.name})". Solicitado: ${requested}, disponible: ${available}.`;
    }
  } else {
    const available = product.stockQuantity ?? 0;
    const requested = requestedTotalsByKey.get(stockKey(product.id)) ?? line.quantity;
    if (requested > available) {
      return `No hay suficiente disponibilidad para "${product.name}". Solicitado: ${requested}, disponible: ${available}.`;
    }
  }

  return null;
}

/**
 * Read-only preview of the stored order: snapshot vs current engine prices
 * per line, stock/availability, completeness and conversion eligibility.
 * The pricing customer is STRICTLY `order.customerId`. No writes.
 */
export async function buildCommercialPreview(
  orderId: string,
  actor: CommercialActor,
  client: DbClient = db
): Promise<CommercialPreview> {
  const order = await loadOrderForActor(orderId, actor, client);
  const items = order.items;

  // Pricing context: ONLY the order's own customer, resolved server-side.
  const priceItems = items.map((i) => ({ productId: i.productId, variantId: i.variantId }));
  const [{ prices }, profile] = await Promise.all([
    resolvePricesForItems(priceItems, { customerId: order.customerId, tx: client }),
    getActivePriceProfile(order.customerId, client),
  ]);

  const productsById = await loadProductsById(
    Array.from(new Set(items.map((i) => i.productId))),
    client
  );

  const comparisons = buildOrderItemPriceComparisons(items, productsById, prices);

  const lines: CommercialPreviewLine[] = comparisons.map((comparison) => {
    const product = productsById.get(comparison.productId);
    return {
      productId: comparison.productId,
      variantId: comparison.variantId,
      productName: comparison.productName,
      variantName: comparison.variantName,
      variantCode: comparison.variantCode,
      productSku: comparison.productSku,
      quantity: comparison.quantity,
      snapshotUnitPrice: comparison.historicalUnitPrice,
      engineUnitPrice: comparison.currentUnitPrice,
      engineRequiresQuote: comparison.currentRequiresQuote,
      priceStatus: comparison.priceStatus,
      priceDifference: comparison.priceDifference,
      currentStockQuantity: comparison.currentStockQuantity,
      minQuantity: product?.minWholesaleQty || 1,
      availability: comparison.availability,
      snapshotLineTotal: (comparison.historicalUnitPrice ?? 0) * comparison.quantity,
      engineLineTotal: (comparison.currentUnitPrice ?? 0) * comparison.quantity,
    };
  });

  const isComplete =
    items.length > 0 && items.every((i) => i.unitPrice != null && i.unitPrice > 0);
  const canEdit = order.status === "solicitado";

  return {
    orderId: order.id,
    orderNumber: order.orderNumber,
    status: order.status,
    requestType: order.requestType,
    canEdit,
    isComplete,
    canConvert: order.requestType === "cotizacion" && isComplete && canEdit,
    customerProfileName: profile?.name ?? null,
    lines,
    storedSubtotal: order.subtotal,
    engineSubtotal: lines.reduce((sum, line) => sum + line.engineLineTotal, 0),
  };
}

/**
 * Read-only computation for the live editor: validates the proposed lines
 * with the SAME pass a save would run (engine prices, stock, minimums, mode
 * rules) WITHOUT writing anything. Manual quote prices are only honored for
 * lines the engine itself reports as requiresQuote in "cotizacion" mode.
 */
export async function previewCommercialLines(
  orderId: string,
  actor: CommercialActor,
  lines: CommercialLineInput[],
  client: DbClient = db
): Promise<CommercialLinesPreview> {
  const normalized = normalizeCommercialLines(lines);
  const order = await loadOrderForActor(orderId, actor, client);
  const requestType = effectiveRequestType(order.requestType);

  if (normalized.length === 0) {
    return {
      orderId: order.id,
      status: order.status,
      requestType: order.requestType,
      canEdit: order.status === "solicitado",
      lines: [],
      subtotal: 0,
      isComplete: false,
      validationError: null,
    };
  }

  const priceItems = normalized.map((line) => ({
    productId: line.productId,
    variantId: line.variantId,
  }));
  const { prices } = await resolvePricesForItems(priceItems, {
    customerId: order.customerId,
    tx: client,
  });

  const productsById = await loadProductsById(
    Array.from(new Set(normalized.map((line) => line.productId))),
    client
  );

  // Aggregated requested totals per key (input duplicates are already
  // merged by normalizeCommercialLines, matching cart-validation semantics).
  const requestedTotalsByKey = new Map<string, number>();
  for (const line of normalized) {
    const key = stockKey(line.productId, line.variantId);
    requestedTotalsByKey.set(key, (requestedTotalsByKey.get(key) || 0) + line.quantity);
  }

  // Authoritative pass: identical to what saveCommercialCalculation runs.
  // Its only job here is the go/no-go verdict; the displayed totals come from
  // the per-line computation below (engine price or manual quote where
  // allowed) so the proposed subtotal always matches the visible lines.
  let validationError: string | null = null;
  try {
    await validateAndPriceItems(
      normalized.map(({ productId, variantId, quantity }) => ({
        productId,
        variantId,
        quantity,
      })),
      client,
      { customerId: order.customerId, requestType }
    );
  } catch (err) {
    if (err instanceof CartValidationError) {
      validationError = err.message;
    } else {
      throw err;
    }
  }

  const computedLines: CommercialLineComputation[] = normalized.map((line, index) => {
    const resolved = prices.get(lineKey(line.productId, line.variantId));
    const engineUnitPrice =
      resolved && resolved.unitPrice != null && resolved.unitPrice > 0
        ? resolved.unitPrice
        : null;
    const engineRequiresQuote = engineUnitPrice === null;

    // Engine price always wins; the manual quote only applies where the
    // engine itself confirms the line requires a quote (cotizacion mode).
    const finalUnitPrice =
      engineUnitPrice ??
      (engineRequiresQuote && requestType === "cotizacion" ? line.quotedUnitPrice : null);

    const issue = lineValidationIssue(line, productsById, requestedTotalsByKey);
    const requiresQuoteIssue =
      !issue && engineRequiresQuote && requestType === "pedido"
        ? `El producto "${
            productsById.get(line.productId)?.name || line.productId
          }" requiere cotización y no puede tramitarse con precio COP 0.`
        : null;

    return {
      productId: line.productId,
      variantId: line.variantId,
      quantity: line.quantity,
      quotedUnitPrice: line.quotedUnitPrice,
      engineUnitPrice,
      engineRequiresQuote,
      finalUnitPrice,
      lineTotal: (finalUnitPrice ?? 0) * line.quantity,
      availability: issue ? "unavailable" : "available",
      minQuantity: productsById.get(line.productId)?.minWholesaleQty || 1,
      currentStockQuantity: line.variantId
        ? (productsById
            .get(line.productId)
            ?.variants.find((v) => v.id === line.variantId)?.stockQuantity ??
          productsById.get(line.productId)?.stockQuantity ??
          null)
        : (productsById.get(line.productId)?.stockQuantity ?? null),
      validationError: issue ?? requiresQuoteIssue,
    };
  });

  const subtotal = computedLines.reduce((sum, line) => sum + line.lineTotal, 0);
  const isComplete =
    computedLines.length > 0 &&
    computedLines.every((line) => line.finalUnitPrice != null && line.finalUnitPrice > 0);

  return {
    orderId: order.id,
    status: order.status,
    requestType: order.requestType,
    canEdit: order.status === "solicitado",
    lines: computedLines,
    subtotal,
    isComplete,
    validationError,
  };
}

export interface SaveCommercialCalculationInput {
  orderId: string;
  actor: CommercialActor;
  lines: CommercialLineInput[];
  note?: string | null;
}

/**
 * Persists a commercial calculation (line replacement + subtotal + audit) in
 * ONE transaction: row lock -> re-auth on the locked row -> editability
 * re-check -> engine validation/price -> atomic line replacement ->
 * conditional subtotal update -> history. Any failure rolls back everything.
 */
export async function saveCommercialCalculation(
  input: SaveCommercialCalculationInput
): Promise<CommercialPreview> {
  const { orderId, actor, note } = input;

  // Pure structural validation BEFORE the transaction: nothing runs with an
  // invalid payload.
  const normalized = normalizeCommercialLines(input.lines);
  if (normalized.length === 0) {
    throw badRequest("Debe incluir al menos una línea.");
  }

  return await db.$transaction(async (tx) => {
    const locked = await lockOrderForCommercialUpdate(tx, orderId);
    if (!locked) throw notFound();
    authorizeCommercialAccess(locked, actor);

    if (locked.status !== "solicitado") {
      throw conflict(
        `El pedido ya no está en estado "solicitado" y sus líneas no pueden modificarse.`
      );
    }

    // The pricing customer is ALWAYS the order's own customer (post-lock).
    const customerId = locked.customerId;
    const requestType = effectiveRequestType(locked.requestType);

    let validated;
    try {
      validated = await validateAndPriceItems(
        normalized.map(({ productId, variantId, quantity }) => ({
          productId,
          variantId,
          quantity,
        })),
        tx,
        { customerId, requestType }
      );
    } catch (err) {
      if (err instanceof CartValidationError) throw badRequest(err.message);
      throw err;
    }

    // validatedItems are 1:1 with the input order. Engine price wins; the
    // supplied quotedUnitPrice is ignored wherever the engine has a price.
    const finalLines = validated.validatedItems.map((item, index) => {
      const manual = normalized[index].quotedUnitPrice;
      const finalUnitPrice =
        item.unitPrice != null && item.unitPrice > 0
          ? item.unitPrice
          : item.requiresQuote && requestType === "cotizacion"
          ? manual
          : null;
      return { item, finalUnitPrice };
    });

    await tx.orderItem.deleteMany({ where: { orderId } });
    await tx.orderItem.createMany({
      data: finalLines.map(({ item, finalUnitPrice }) => ({
        orderId,
        productId: item.productId,
        productName: item.productName,
        productSku: item.productSku,
        variantId: item.variantId,
        variantName: item.variantName,
        variantCode: item.variantCode,
        quantity: item.quantity,
        unitPrice: finalUnitPrice,
      })),
    });

    const subtotal = finalLines.reduce(
      (sum, line) => sum + (line.finalUnitPrice ?? 0) * line.item.quantity,
      0
    );

    // Conditional update: second guard against any race not covered by the
    // lock (0 rows => the status changed => abort with zero partial writes).
    const result = await tx.order.updateMany({
      where: { id: orderId, status: "solicitado" },
      data: { subtotal, updatedAt: new Date() },
    });
    if (result.count === 0) {
      throw conflict(
        `El pedido ya no está en estado "solicitado" y sus líneas no pueden modificarse.`
      );
    }

    await tx.orderStatusHistory.create({
      data: {
        orderId,
        fromStatus: locked.status,
        toStatus: locked.status,
        changedBy: actor.name?.trim() || actor.role,
        note:
          note?.trim() ||
          (requestType === "cotizacion"
            ? "Cotización calculada por asesor"
            : "Líneas comerciales actualizadas"),
      },
    });

    return await buildCommercialPreview(orderId, actor, tx);
  });
}

export interface RecalculateCommercialOrderInput {
  orderId: string;
  actor: CommercialActor;
  note?: string | null;
}

/**
 * "Recalcular precios actuales": re-reads CURRENT items under the lock,
 * re-resolves every price with the engine (post-lock profile) and revalidates
 * product/variant/stock/minimums. A negotiated quote price on a line the
 * engine still reports as requiresQuote (cotizacion mode) is preserved; all
 * other prices come from the engine. Atomic, audited.
 */
export async function recalculateCommercialOrder(
  input: RecalculateCommercialOrderInput
): Promise<CommercialPreview> {
  const { orderId, actor, note } = input;

  return await db.$transaction(async (tx) => {
    const locked = await lockOrderForCommercialUpdate(tx, orderId);
    if (!locked) throw notFound();
    authorizeCommercialAccess(locked, actor);

    if (locked.status !== "solicitado") {
      throw conflict(
        `El pedido ya no está en estado "solicitado" y sus líneas no pueden modificarse.`
      );
    }

    // Re-read lines UNDER the lock: any concurrent writer's result is what
    // gets recalculated, never a stale pre-lock snapshot.
    const items = await tx.orderItem.findMany({ where: { orderId } });
    if (items.length === 0) {
      throw badRequest("El pedido no tiene líneas para recalcular.");
    }

    // Negotiated prices from the existing snapshot, keyed per product/variant.
    const quotedPricesByKey = new Map<string, number>();
    for (const item of items) {
      if (item.unitPrice != null && item.unitPrice > 0) {
        quotedPricesByKey.set(lineKey(item.productId, item.variantId), item.unitPrice);
      }
    }

    const requestType = effectiveRequestType(locked.requestType);

    let validated;
    try {
      validated = await validateAndPriceItems(
        items.map((item) => ({
          productId: item.productId,
          variantId: item.variantId,
          quantity: item.quantity,
        })),
        tx,
        { customerId: locked.customerId, requestType }
      );
    } catch (err) {
      if (err instanceof CartValidationError) throw badRequest(err.message);
      throw err;
    }

    // Engine-resolvable => engine price. Engine requires quote (only possible
    // in cotizacion mode) => preserve the negotiated snapshot if it had one.
    const finalLines = validated.validatedItems.map((item) => ({
      item,
      finalUnitPrice:
        item.unitPrice != null && item.unitPrice > 0
          ? item.unitPrice
          : item.requiresQuote && requestType === "cotizacion"
          ? quotedPricesByKey.get(lineKey(item.productId, item.variantId)) ?? null
          : null,
    }));

    await tx.orderItem.deleteMany({ where: { orderId } });
    await tx.orderItem.createMany({
      data: finalLines.map(({ item, finalUnitPrice }) => ({
        orderId,
        productId: item.productId,
        productName: item.productName,
        productSku: item.productSku,
        variantId: item.variantId,
        variantName: item.variantName,
        variantCode: item.variantCode,
        quantity: item.quantity,
        unitPrice: finalUnitPrice,
      })),
    });

    const subtotal = finalLines.reduce(
      (sum, line) => sum + (line.finalUnitPrice ?? 0) * line.item.quantity,
      0
    );

    const result = await tx.order.updateMany({
      where: { id: orderId, status: "solicitado" },
      data: { subtotal, updatedAt: new Date() },
    });
    if (result.count === 0) {
      throw conflict(
        `El pedido ya no está en estado "solicitado" y sus líneas no pueden modificarse.`
      );
    }

    await tx.orderStatusHistory.create({
      data: {
        orderId,
        fromStatus: locked.status,
        toStatus: locked.status,
        changedBy: actor.name?.trim() || actor.role,
        note:
          note?.trim() ||
          (requestType === "cotizacion"
            ? "Cotización recalculada por asesor"
            : "Pedido recalculado por asesor"),
      },
    });

    return await buildCommercialPreview(orderId, actor, tx);
  });
}

export interface ConvertQuoteToOrderInput {
  orderId: string;
  actor: CommercialActor;
  note?: string | null;
}

/**
 * Converts a COMPLETE quote into an order, in place (no new Order, no
 * duplicate): row lock -> re-auth -> editability + requestType checks ->
 * completeness check -> revalidation of every line against CURRENT product/
 * variant/stock/minimum data (WITHOUT pedido-mode pricing, so negotiated
 * snapshots are never re-priced) -> requestType flip + subtotal + audit.
 */
export async function convertQuoteToOrder(
  input: ConvertQuoteToOrderInput
): Promise<CommercialPreview> {
  const { orderId, actor, note } = input;

  return await db.$transaction(async (tx) => {
    const locked = await lockOrderForCommercialUpdate(tx, orderId);
    if (!locked) throw notFound();
    authorizeCommercialAccess(locked, actor);

    if (locked.status !== "solicitado") {
      throw conflict(
        `El pedido ya no está en estado "solicitado" y no puede convertirse.`
      );
    }
    if (locked.requestType !== "cotizacion") {
      throw badRequest("Solo una cotización puede convertirse en pedido.");
    }

    // Re-read lines UNDER the lock.
    const items = await tx.orderItem.findMany({ where: { orderId } });
    if (items.length === 0) {
      throw badRequest("La cotización no tiene líneas para convertir.");
    }

    const incomplete = items.find(
      (item) => item.unitPrice == null || item.unitPrice <= 0
    );
    if (incomplete) {
      throw badRequest(
        "La cotización tiene líneas sin precio: complete los precios antes de convertirla en pedido."
      );
    }

    // Revalidate current data (active, not "agotado", minimums, aggregated
    // stock) with cart-validation semantics. Stored snapshot prices stay
    // untouched: a negotiated quote must NEVER be re-priced by the engine.
    const productsById = await loadProductsById(
      Array.from(new Set(items.map((item) => item.productId))),
      tx
    );
    const requestedTotalsByKey = new Map<string, number>();
    for (const item of items) {
      const key = stockKey(item.productId, item.variantId);
      requestedTotalsByKey.set(key, (requestedTotalsByKey.get(key) || 0) + item.quantity);
    }
    for (const item of items) {
      const issue = lineValidationIssue(
        {
          productId: item.productId,
          variantId: item.variantId,
          quantity: item.quantity,
        },
        productsById,
        requestedTotalsByKey
      );
      if (issue) throw badRequest(issue);
    }

    const subtotal = items.reduce(
      (sum, item) => sum + (item.unitPrice ?? 0) * item.quantity,
      0
    );

    // The row lock serializes this flip with concurrent state changes.
    await tx.order.update({
      where: { id: orderId },
      data: { requestType: "pedido", subtotal, updatedAt: new Date() },
    });

    await tx.orderStatusHistory.create({
      data: {
        orderId,
        fromStatus: locked.status,
        toStatus: locked.status,
        changedBy: actor.name?.trim() || actor.role,
        note: note?.trim() || "Cotización convertida en pedido",
      },
    });

    return await buildCommercialPreview(orderId, actor, tx);
  });
}
