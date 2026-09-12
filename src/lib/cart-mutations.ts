import { db } from "./db";
import { isAgentRole } from "./roles";
import {
  upsertActiveCart,
  lockCartForMutation,
  lockGuestSessionIdentity,
  lockUserCartIdentity,
  CartMutationError,
  type CartMutationViewer,
  type LockedCartSnapshot,
} from "./order-cart-upsert";
import { validateAndPriceItems, CartValidationError } from "./cart-validation";
import { resolveServerPricingCustomer } from "./pricing";

/**
 * SERVICIOS DE MUTACIÓN DE CARRITO (Fase 3) — única disciplina compartida.
 *
 * Las rutas /api/carts (POST, DELETE) y /api/carts/[uuid] (PUT) son wrappers
 * delgados: resuelven la identidad del visor y mapean errores a JSON; la
 * lógica vive aquí. TODA escritura de líneas/subtotal/metadata ocurre dentro
 * de `db.$transaction` comenzando con `lockCartForMutation` (tx + FOR UPDATE
 * del Cart + re-lectura autoritativa + re-check de status/ownership): la
 * lectura previa al lock es solo fast-fail, nunca la base de una escritura.
 *
 * Estos servicios NO reintentan: si el carrito fue convertido (checkout
 * concurrente) la mutación aborta con CartMutationError 409 y el carrito
 * convertido queda EXACTAMENTE intacto ("Volver a pedir" sí reintenta; ver
 * src/lib/order-reorder.ts).
 */

export type SaveCartAction = "save" | "add" | "update" | "clear" | "remove";

export interface SaveCartChangesInput {
  viewer: CartMutationViewer;
  /** "save" | "add" | "update" | "clear" | "remove" (default "save"). */
  action?: unknown;
  items?: unknown;
  cityId?: string | null;
  customerName?: unknown;
  customerEmail?: unknown;
  customerPhone?: unknown;
  customerCompany?: unknown;
  notes?: unknown;
  /** Usuario de la sesión autenticada server-side (contexto del motor de precios). */
  currentUser: { id: string; role: string } | null;
}

export interface CartMutationResult {
  id: string;
  uuid: string;
  itemCount: number;
  subtotal: number;
}

/** Línea cruda de CartItem tal como llega de la BD (para matching por acción). */
type FreshCartItem = {
  id: string;
  productId: string;
  variantId: string | null;
};

/**
 * POST /api/carts — guardar/agregar/actualizar líneas o vaciar el carrito
 * activo del visor. Semántica idéntica a la implementación histórica de la
 * ruta, pero atómica: validación de precios DENTRO de la tx, re-lectura
 * FRESCA de las líneas tras el lock (nunca el snapshot previo) y subtotal
 * recalculado desde las filas reales.
 */
export async function saveCartChanges(
  input: SaveCartChangesInput
): Promise<CartMutationResult> {
  const {
    action: rawAction = "save",
    items,
    cityId,
    customerName,
    customerEmail,
    customerPhone,
    customerCompany,
    notes,
    currentUser,
  } = input;
  const viewer = input.viewer;
  const action = (typeof rawAction === "string" ? rawAction : "save") as SaveCartAction;

  const itemsArray = Array.isArray(items) ? items : null;

  // Sin items utilizables: "save"/"clear" VACÍAN el carrito; cualquier otra
  // acción requiere al menos un producto (mismo 400 que la ruta histórica).
  if (!itemsArray || itemsArray.length === 0) {
    if (action === "save" || action === "clear") {
      return db.$transaction(async (tx) => {
        // Advisory locks de identidad: SIEMPRE primeras sentencias de la tx,
        // en orden global guest→user (no-op con identidad null). Serializan
        // esta adquisición contra transferencias y otros adquirentes.
        await lockGuestSessionIdentity(tx, viewer.sessionId);
        await lockUserCartIdentity(tx, viewer.userId);

        // Adquisición DENTRO de la tx (disciplina de advisory locks): la
        // exclusión de creadores concurrentes la dan los advisories.
        const cart = await upsertActiveCart(viewer.sessionId, viewer.userId, cityId, tx);
        await lockCartForMutation(tx, cart.id, viewer);
        await tx.cartItem.deleteMany({ where: { cartId: cart.id } });
        const updated = await tx.cart.update({
          where: { id: cart.id },
          data: {
            subtotal: 0,
            updatedAt: new Date(),
          },
          include: { items: true },
        });
        return { id: updated.id, uuid: updated.uuid, itemCount: 0, subtotal: 0 };
      });
    }
    throw new CartValidationError("El carrito debe tener al menos un producto.");
  }

  // Con items: resolver el carrito activo y escribir todo en UNA tx bajo el
  // lock (validación de precios incluida: los precios se leen bajo el lock).
  return db.$transaction(async (tx) => {
    // Advisory locks de identidad: SIEMPRE primeras sentencias de la tx,
    // en orden global guest→user (no-op con identidad null).
    await lockGuestSessionIdentity(tx, viewer.sessionId);
    await lockUserCartIdentity(tx, viewer.userId);

    // Adquisición DENTRO de la tx (disciplina de advisory locks).
    const cart = await upsertActiveCart(viewer.sessionId, viewer.userId, cityId, tx);

    // Única disciplina: lock + re-lectura autoritativa + re-check de
    // status/ownership antes de escribir líneas/subtotal/metadata.
    await lockCartForMutation(tx, cart.id, viewer);

    // Motor único de precios: el contexto del cliente SOLO procede de la
    // sesión autenticada (o de ADMIN/AGENT resolviendo el contacto
    // server-side), resuelto DENTRO de la tx como en el checkout.
    const pricingCustomerId = await resolveServerPricingCustomer(
      currentUser,
      { phone: customerPhone as string | null, email: customerEmail as string | null },
      tx
    );

    // CartValidationError se propaga tal cual: la ruta lo mapea a 400 con el
    // mensaje del motor de validación.
    const validatedResult = await validateAndPriceItems(
      itemsArray as Parameters<typeof validateAndPriceItems>[0],
      tx,
      {
        customerId: pricingCustomerId,
        // Fase 3: el carrito (borrador) SÍ puede contener productos que
        // requieren cotización (unitPrice null). La decisión pedido vs
        // cotización se toma al confirmar el checkout.
        requestType: "cotizacion",
      }
    );

    const { validatedItems } = validatedResult;

    // Re-lectura FRESCA tras el lock: el matching de add/update usa las filas
    // reales, no el snapshot de la lectura previa al lock.
    const freshItems: FreshCartItem[] = await tx.cartItem.findMany({
      where: { cartId: cart.id },
      select: { id: true, productId: true, variantId: true },
    });

    const matchesLine = (
      existing: FreshCartItem,
      item: { productId: string; variantId: string | null }
    ) =>
      existing.productId === item.productId &&
      (existing.variantId ?? null) === (item.variantId ?? null);

    if (action === "save") {
      // Reemplazar todos los items
      await tx.cartItem.deleteMany({ where: { cartId: cart.id } });

      // Deduplicar por (productId, variantId) para evitar violaciones de índice único
      const itemMap = new Map<string, typeof validatedItems[number]>();
      for (const item of validatedItems) {
        const key = `${item.productId}::${item.variantId ?? "base"}`;
        itemMap.set(key, item);
      }
      const deduplicatedItems = Array.from(itemMap.values());

      // Crear nuevos items con datos y precios validados en servidor
      await tx.cartItem.createMany({
        data: deduplicatedItems.map((item) => ({
          cartId: cart.id,
          productId: item.productId,
          variantId: item.variantId,
          variantName: item.variantName,
          variantCode: item.variantCode,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
        })),
      });
    } else if (action === "add") {
      // Agregar items (sin eliminar anteriores)
      const itemsToAdd = validatedItems.filter(
        (newItem) => !freshItems.some((existing) => matchesLine(existing, newItem))
      );

      if (itemsToAdd.length > 0) {
        await tx.cartItem.createMany({
          data: itemsToAdd.map((item) => ({
            cartId: cart.id,
            productId: item.productId,
            variantId: item.variantId,
            variantName: item.variantName,
            variantCode: item.variantCode,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
          })),
        });
      }

      // Actualizar cantidades y precios validados de items existentes
      for (const item of validatedItems) {
        const existing = freshItems.find((ci) => matchesLine(ci, item));
        if (existing) {
          await tx.cartItem.update({
            where: { id: existing.id },
            data: {
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              variantName: item.variantName,
              variantCode: item.variantCode,
            },
          });
        }
      }
    } else if (action === "update") {
      // Actualizar items específicos sin eliminar
      for (const item of validatedItems) {
        const existing = freshItems.find((ci) => matchesLine(ci, item));
        if (existing) {
          await tx.cartItem.update({
            where: { id: existing.id },
            data: {
              quantity: item.quantity,
              unitPrice: item.unitPrice,
              variantName: item.variantName,
              variantCode: item.variantCode,
            },
          });
        }
      }
    }
    // Otras acciones (p.ej. "remove"): sin escrituras de líneas, solo caen al
    // tail de metadata+subtotal (comportamiento histórico preservado).

    // Recalcular el subtotal directamente desde los ítems en base de datos.
    const allCartItems = await tx.cartItem.findMany({
      where: { cartId: cart.id },
    });
    const subtotal = allCartItems.reduce(
      (sum, item) => sum + (item.unitPrice || 0) * item.quantity,
      0
    );

    // Actualizar datos del carrito
    const updated = await tx.cart.update({
      where: { id: cart.id },
      data: {
        customerName: customerName || undefined,
        customerEmail: customerEmail || undefined,
        customerPhone: customerPhone || undefined,
        customerCompany: customerCompany || undefined,
        notes: notes || undefined,
        subtotal,
        updatedAt: new Date(),
      },
      include: { items: true },
    });

    return {
      id: updated.id,
      uuid: updated.uuid,
      itemCount: updated.items.length,
      subtotal: updated.subtotal,
    };
  });
}

export interface ClearActiveCartsInput {
  sessionId: string | null;
  userId: string | null;
  isAdminOrAgent: boolean;
}

/**
 * DELETE /api/carts — vacía el carrito activo del visor. Identidad canónica:
 * con cuenta el userId es autoritativo (`{ userId, status: 'activo' }`); solo
 * los invitados resuelven por sessionId. Sin sesión ni cuenta, o sin carrito
 * activo, es un no-op (`skipped: true`). El lock autoritativo hace que una
 * transferencia invitado→cuenta en vuelo responda 403 en vez de vaciar el
 * carrito ajeno.
 */
export async function clearActiveCarts(
  input: ClearActiveCartsInput
): Promise<{ skipped: boolean }> {
  const { sessionId, userId, isAdminOrAgent } = input;

  if (!sessionId && !userId) {
    return { skipped: true };
  }

  // Resolución canónica del objetivo: userId primero (un CUSTOMER con sesión
  // rotada no debe vaciar carritos guest, ni un guest los del CUSTOMER).
  const cart = userId
    ? await db.cart.findFirst({ where: { userId, status: "activo" } })
    : await db.cart.findFirst({ where: { sessionId, status: "activo" } });

  if (!cart) {
    return { skipped: true };
  }

  await db.$transaction(async (tx) => {
    // Advisory locks de identidad: SIEMPRE primeras sentencias de la tx,
    // en orden global guest→user (no-op con identidad null).
    await lockGuestSessionIdentity(tx, sessionId);
    await lockUserCartIdentity(tx, userId);

    await lockCartForMutation(tx, cart.id, { sessionId, userId, isAdminOrAgent });
    await tx.cartItem.deleteMany({
      where: { cartId: cart.id },
    });
    await tx.cart.update({
      where: { id: cart.id },
      data: {
        subtotal: 0,
        updatedAt: new Date(),
      },
    });
  });

  return { skipped: false };
}

export interface UpdateCartByUuidViewer {
  sessionId: string | null;
  userId: string | null;
  /** Rol crudo del usuario autenticado (null = invitado). */
  userRole: string | null;
}

export interface UpdateCartByUuidInput {
  uuid: string;
  viewer: UpdateCartByUuidViewer;
  body: {
    items?: unknown;
    customerName?: unknown;
    customerEmail?: unknown;
    customerPhone?: unknown;
    customerCompany?: unknown;
    cityId?: unknown;
    notes?: unknown;
  };
}

/**
 * PUT /api/carts/[uuid] — reemplaza líneas y/o metadata de un carrito por
 * uuid. Los fast-fail (404/403) los hace la ruta con lecturas previas; aquí
 * el lock autoritativo re-valida estado y ownership POST-lock (un carrito
 * convertido en plena carrera aborta con 409 y queda intacto).
 *
 * Semántica de `items` (preservada de la ruta histórica):
 *   - undefined/null  => solo metadata: se conservan items Y subtotal.
 *   - []              => vaciar: deleteMany + create [] y subtotal 0.
 *   - [...]           => validar y repreciar server-side; reemplazar.
 */
export async function updateCartByUuid(
  input: UpdateCartByUuidInput
): Promise<{ id: string; uuid: string }> {
  const { uuid, viewer, body } = input;
  const {
    items,
    customerName,
    customerEmail,
    customerPhone,
    customerCompany,
    cityId,
    notes,
  } = body;

  // La ruta ya validó forma de `items` y propiedad con lecturas previas;
  // aquí se re-lee para tener id/subtotal de referencia.
  const existingCart = await db.cart.findUnique({ where: { uuid } });
  if (!existingCart) {
    throw new CartMutationError("CART_NOT_FOUND", "Carrito no encontrado", 404);
  }

  // Admin/AGENT (asistidos) pueden modificar carritos de terceros. Comparación
  // case-insensitive: el role en base de datos tiene casing mixto. editor se
  // excluye a propósito (misma semántica que la ruta /api/carts/[uuid]).
  const isAdminOrAgent =
    viewer.userRole?.trim().toLowerCase() === "admin" || isAgentRole(viewer.userRole);

  const itemsProvided = Array.isArray(items);

  const cart = await db.$transaction(async (tx) => {
    // Única disciplina: lock + estado autoritativo POST-lock.
    const lockedCart: LockedCartSnapshot = await lockCartForMutation(
      tx,
      existingCart.id,
      {
        sessionId: viewer.sessionId,
        userId: viewer.userId,
        isAdminOrAgent,
      }
    );

    let validatedResult: Awaited<ReturnType<typeof validateAndPriceItems>> | undefined;
    if (itemsProvided && items.length > 0) {
      // Motor único de precios: el precio NUNCA se toma del navegador. Se
      // recalcula server-side con el contexto del DUEÑO POST-lock del carrito
      // (dato del servidor, no del cliente); si es un carrito de invitado,
      // precio base.
      let ownerPricingCustomerId: string | null = null;
      if (lockedCart.userId) {
        const owner = await tx.user.findUnique({
          where: { id: lockedCart.userId },
          select: { id: true, role: true },
        });
        if (owner && owner.role.toLowerCase() === "customer") {
          ownerPricingCustomerId = owner.id;
        }
      }

      validatedResult = await validateAndPriceItems(
        (items as Array<{ productId: string; variantId?: string | null; quantity: number }>).map(
          (item) => ({
            productId: item.productId,
            variantId: item.variantId ?? null,
            quantity: item.quantity,
          })
        ),
        tx,
        {
          customerId: ownerPricingCustomerId,
          // Fase 3: el carrito (borrador) SÍ puede contener productos que
          // requieren cotización (unitPrice null).
          requestType: "cotizacion",
        }
      );
    }

    return tx.cart.update({
      where: { uuid },
      data: {
        // Passthrough crudo del body (semántica histórica de la ruta):
        // undefined = no cambiar; null = limpiar el campo.
        customerName: customerName as string | null | undefined,
        customerEmail: customerEmail as string | null | undefined,
        customerPhone: customerPhone as string | null | undefined,
        customerCompany: customerCompany as string | null | undefined,
        cityId: cityId || null,
        notes: notes as string | null | undefined,
        // El subtotal SOLO se escribe cuando `items` viene en el body: un PUT
        // de solo metadata no toca el subtotal (ni siquiera para reescribirlo
        // con el valor leído antes del lock).
        ...(itemsProvided ? { subtotal: validatedResult?.subtotal ?? 0 } : {}),
        ...(itemsProvided
          ? {
              items: {
                deleteMany: {},
                create:
                  validatedResult?.validatedItems.map((item) => ({
                    productId: item.productId,
                    variantId: item.variantId,
                    variantName: item.variantName,
                    variantCode: item.variantCode,
                    quantity: item.quantity,
                    unitPrice: item.unitPrice,
                  })) ?? [],
              },
            }
          : {}),
      },
      include: { items: true },
    });
  });

  return { id: cart.id, uuid: cart.uuid };
}
