/**
 * Helpers para gestionar carritos con lógica de upsert
 * basada en session_id para usuarios invitados y user_id para usuarios logueados.
 *
 * Fase 3: las órdenes ya NO se gestionan con upsert por sesión/cuenta.
 * Cada checkout crea un Order nuevo (snapshot histórico) — ver
 * `src/lib/order-create.ts` para la semántica y la protección de doble submit.
 */

import { Prisma } from '@prisma/client';
import { db } from './db';
import { canonicalColombiaPhone } from './phone';

// =====================
// ADVISORY LOCKS DE IDENTIDAD (disciplina global)
// =====================

/**
 * Advisory locks de identidad (pg_advisory_xact_lock): serializan TODO camino
 * que crea/adquiere/transfiere carritos u órdenes de una identidad guest o de
 * usuario, y el alta/enlace del cliente de checkout. Orden global de locks en
 * TODA transacción:
 *   1) advisory(guest-session) -> 2) advisory(user-cart) -> 3) filas Order
 *   -> 4) filas Cart -> 5) advisory(contacto email → teléfono, HOJA: solo checkout)
 * Son re-entrantes dentro de la misma transacción y se liberan al cerrarla.
 *
 * Tomados SIEMPRE como primeras sentencias de la tx y en orden relativo fijo
 * guest→user cuando ambos aplican: ningún lock de fila se toma antes que los
 * advisories, así ningún titular de fila puede esperar por un advisory de otra
 * tx (no hay ciclos mixtos fila↔advisory). El advisory de contacto es la
 * excepción documentada: lo toma el checkout DESPUÉS de su lock de Cart y no
 * espera por nada ajeno después (ver lockCheckoutContactIdentity).
 */
export async function lockGuestSessionIdentity(
  tx: Prisma.TransactionClient,
  sessionId: string | null | undefined
) {
  if (!sessionId) return;
  // `IS NULL` convierte el void del lock en una columna serializable por
  // Prisma ($queryRaw no deserializa columnas void, P2010).
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('compusum:guest-session:' || ${sessionId}, 0)) IS NULL`;
}

export async function lockUserCartIdentity(
  tx: Prisma.TransactionClient,
  userId: string | null | undefined
) {
  if (!userId) return;
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('compusum:user-cart:' || ${userId}, 0)) IS NULL`;
}

/**
 * Advisory locks de CONTACTO de checkout: serializan el alta/enlace del
 * cliente (upsertCheckoutCustomer) para un mismo contacto canónico.
 *
 * Claves canónicas estables: email en minúsculas y teléfono colombiano
 * `57XXXXXXXXXX` (`canonicalColombiaPhone`); la canonicalización se aplica
 * AQUÍ (idempotente) para que ningún llamador con input crudo pueda partir la
 * clave y reabrir la carrera. Cada parte presente toma SU lock, SIEMPRE en
 * orden fijo email → teléfono, así dos checkouts que comparten partes
 * distintas no pueden formar un ABBA entre contactos.
 *
 * Posición en el orden global (HOJA):
 *   guest-session → user-cart → filas Order → filas Cart → contacto(email → teléfono)
 * Solo `upsertCheckoutCustomer` toma locks de contacto, y lo hace DESPUÉS de
 * que el checkout ya aseguró la fila de su propio Cart; tras el lock de
 * contacto la tx SOLO inserta filas nuevas (Order/OrderStatusHistory) y
 * escribe el Cart que ya tiene bloqueado. Ninguna otra transacción (transfer,
 * reorder, save/clear) espera por un lock de contacto, y un titular de
 * contacto no espera por filas ajenas: no existen ciclos mixtos
 * fila↔advisory ni ABBA entre contactos.
 */
export async function lockCheckoutContactIdentity(
  tx: Prisma.TransactionClient,
  contact: { email: string | null; phone: string | null }
) {
  // Canonicalización defensiva idempotente: email normalizado ya canónico no
  // cambia; el teléfono en cualquiera de sus formas canónica 57XXXXXXXXXX.
  const email = contact.email?.trim().toLowerCase() || null;
  const phone = canonicalColombiaPhone(contact.phone);
  if (email) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('compusum:contact-email:' || ${email}, 0)) IS NULL`;
  }
  if (phone) {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('compusum:contact-phone:' || ${phone}, 0)) IS NULL`;
  }
}

/**
 * Obtiene o crea un carrito activo basado en userId o sessionId.
 *
 * Identidad canónica: para usuario autenticado el userId es autoritativo;
 * el x-session-id rotable solo identifica invitados. Por eso la rama de
 * usuario se evalúa PRIMERO y los carritos de usuario NUNCA llevan sessionId:
 * la sesión rotable únicamente puede crear/adoptar carritos de invitado.
 *
 * @param sessionId - Session ID del navegador (para usuarios invitados)
 * @param userId - User ID (para usuarios logueados)
 * @param cityId - City ID opcional
 * @param client - Cliente Prisma (global `db` o `tx` de una transacción)
 * @returns El carrito existente o uno nuevo
 *
 * NOTA de disciplina: todos los adquirentes llaman esta función DENTRO de una
 * transacción que ya tomó los advisory locks de identidad (save/clear/reorder/
 * transfer); la adquisición y la escritura subsecuente comparten destino y
 * exclusión. No hay recuperación P2002: una violación residual aborta la tx.
 */
export async function upsertActiveCart(
  sessionId: string | null | undefined,
  userId: string | null | undefined,
  cityId?: string | null,
  client: Prisma.TransactionClient = db
) {
  // Si no hay sessionId ni userId, crear carrito nuevo
  if (!sessionId && !userId) {
    return await client.cart.create({
      data: {
        status: 'activo',
        cityId: cityId || null,
      },
      include: { items: true },
    });
  }

  // Usuario autenticado: el userId es la identidad canónica del carrito.
  if (userId) {
    const existingCart = await client.cart.findFirst({
      where: {
        userId,
        status: 'activo',
      },
      include: { items: true },
    });

    if (existingCart) {
      return existingCart;
    }

    // Crear carrito para este usuario (sin sessionId: la sesión rotable no
    // participa en la identidad de los carritos de usuario)
    // La exclusión la garantizan los advisory locks de identidad tomados por
    // todos los adquirentes (save/clear/reorder/transfer); un P2002 residual
    // aborta la tx limpiamente para retry del llamador — NUNCA se consulta
    // sobre una tx abortada.
    return await client.cart.create({
      data: {
        userId,
        status: 'activo',
        cityId: cityId || null,
      },
      include: { items: true },
    });
  }

  // Invitado: la sesión rotable identifica el carrito guest.
  if (sessionId) {
    const existingCart = await client.cart.findFirst({
      where: {
        sessionId,
        status: 'activo',
      },
      include: { items: true },
    });

    if (existingCart) {
      return existingCart;
    }

    // Crear carrito para esta sesión
    // Mismo criterio que la rama de usuario: los advisory locks de identidad
    // excluyen adquirentes concurrentes; un P2002 residual aborta la tx sin
    // consultas de recuperación sobre una transacción abortada.
    return await client.cart.create({
      data: {
        sessionId,
        status: 'activo',
        cityId: cityId || null,
      },
      include: { items: true },
    });
  }

  // Fallback
  return await client.cart.create({
    data: {
      status: 'activo',
      cityId: cityId || null,
    },
    include: { items: true },
  });
}

/**
 * Actualiza un carrito existente o crea uno nuevo (upsert)
 * @param cartData - Datos del carrito
 * @param sessionId - Session ID del navegador
 * @param userId - User ID opcional
 * @returns El carrito actualizado o creado
 */
export async function upsertCart(
  cartData: {
    customerName?: string | null;
    customerEmail?: string | null;
    customerPhone?: string | null;
    customerCompany?: string | null;
    cityId?: string | null;
    notes?: string | null;
    subtotal?: number;
  },
  sessionId: string | null | undefined,
  userId: string | null | undefined = null
) {
  // Si hay sessionId, intentar upsert basado en sesión
  if (sessionId) {
    // Buscar carrito activo existente para esta sesión
    const existingCart = await db.cart.findFirst({
      where: {
        sessionId,
        status: 'activo',
      },
    });

    if (existingCart) {
      // Actualizar carrito existente
      return await db.cart.update({
        where: { id: existingCart.id },
        data: {
          ...cartData,
          updatedAt: new Date(),
        },
        include: { items: true },
      });
    }

    // Crear nuevo carrito
    return await db.cart.create({
      data: {
        sessionId,
        ...cartData,
        status: 'activo',
      },
      include: { items: true },
    });
  }

  // Si hay userId, intentar upsert basado en usuario
  if (userId) {
    const existingCart = await db.cart.findFirst({
      where: {
        userId,
        status: 'activo',
      },
    });

    if (existingCart) {
      return await db.cart.update({
        where: { id: existingCart.id },
        data: {
          ...cartData,
          updatedAt: new Date(),
        },
        include: { items: true },
      });
    }

    return await db.cart.create({
      data: {
        userId,
        ...cartData,
        status: 'activo',
      },
      include: { items: true },
    });
  }

  // Fallback: crear carrito sin sesión
  return await db.cart.create({
    data: {
      ...cartData,
      status: 'activo',
    },
    include: { items: true },
  });
}

/**
 * Bloquea y transfiere los pedidos de la sesión a la cuenta (dentro de una tx).
 * Orden global de locks: Order ANTES que Cart (ver checkout.ts).
 * @param tx - Cliente transaccional de Prisma
 * @param sessionId - Session ID anterior (para invitados)
 * @param userId - User ID (nuevo usuario registrado/logueado)
 */
export async function transferSessionOrdersToUserTx(
  tx: Prisma.TransactionClient,
  sessionId: string,
  userId: string
) {
  if (!sessionId) return null;

  // Lock determinista de las filas del pedido (evita deadlocks entre
  // transferencias concurrentes de la misma sesión).
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM "Order" WHERE "sessionId" = ${sessionId} ORDER BY id FOR UPDATE`;
  if (rows.length === 0) return null;

  // Transferir todas las órdenes del guest sessionId al usuario
  const orders: Prisma.OrderGetPayload<{ include: { items: true } }>[] = [];
  for (const row of rows) {
    orders.push(
      await tx.order.update({
        where: { id: row.id },
        data: {
          customerId: userId,
          sessionId: null,
          updatedAt: new Date(),
        },
        include: { items: true },
      })
    );
  }

  return orders.length === 1 ? orders[0] : orders;
}

/**
 * Bloquea y transfiere el carrito de sesión a la cuenta (dentro de una tx).
 * Debe llamarse DESPUÉS de `transferSessionOrdersToUserTx` (orden Order→Cart).
 * @param tx - Cliente transaccional de Prisma
 * @param sessionId - Session ID anterior (para invitados)
 * @param userId - User ID (nuevo usuario registrado/logueado)
 */
export async function transferSessionCartToUserTx(
  tx: Prisma.TransactionClient,
  sessionId: string,
  userId: string
) {
  if (!sessionId) return null;

  // Lock PREDICADO del carrito activo de la sesión (SELECT ... FOR UPDATE con
  // la condición completa, no findFirst-then-lock): cierra la ventana en la
  // que un checkout concurrente convertía la fila entre la lectura y el lock.
  const locked = await tx.$queryRaw<{ id: string; status: string; sessionId: string | null }[]>`
    SELECT id, status, "sessionId" FROM "Cart"
    WHERE "sessionId" = ${sessionId} AND status = 'activo'
    ORDER BY id FOR UPDATE`;
  if (!locked || locked.length === 0) return null;
  const cart = locked[0];

  // Revalidación post-lock: la fila debe seguir siendo el carrito activo de
  // esta sesión (defensa en profundidad sobre el snapshot bloqueado).
  if (cart.sessionId !== sessionId || cart.status !== 'activo') return null;

  // Expirar carritos activos previos del usuario (preserva históricos, no borra).
  // La exclusión por id evita que una forma legada (pre-20260312) con sessionId
  // Y userId a la vez sea expirada por esta pasada y reclamada ya expirada,
  // dejando al usuario SIN carrito activo.
  await tx.cart.updateMany({
    where: {
      userId,
      status: 'activo',
      id: { not: cart.id },
    },
    data: {
      status: 'expirado',
    },
  });

  // Transferir el carrito de sesión al usuario
  return await tx.cart.update({
    where: { id: cart.id },
    data: {
      userId,
      sessionId: null, // Desvincularlo de la sesión
      updatedAt: new Date(),
    },
    include: { items: true },
  });
}

// =====================
// DISCIPLINA ÚNICA DE MUTACIÓN DE CARRITO
// =====================

/**
 * Errores controlados de la disciplina de mutación: la ruta/service decide
 * el status HTTP a partir de `code`/`status` sin inspeccionar la BD.
 */
export class CartMutationError extends Error {
  status: number;
  code:
    | 'CART_NOT_FOUND'
    | 'CART_NOT_ACTIVE'
    | 'CART_FORBIDDEN'
    | 'CART_HAS_ORDERS';

  constructor(
    code:
      | 'CART_NOT_FOUND'
      | 'CART_NOT_ACTIVE'
      | 'CART_FORBIDDEN'
      | 'CART_HAS_ORDERS',
    message: string,
    status: number
  ) {
    super(message);
    this.name = 'CartMutationError';
    this.code = code;
    this.status = status;
  }
}

/** Identidad del actor que intenta mutar el carrito (precomputada por el llamador). */
export interface CartMutationViewer {
  sessionId: string | null;
  userId: string | null;
  isAdminOrAgent: boolean;
}

/** Estado autoritativo del carrito leído BAJO el lock. */
export type LockedCartSnapshot = {
  id: string;
  status: string;
  isActive: boolean;
  sessionId: string | null;
  userId: string | null;
};

/**
 * ÚNICA disciplina de mutación de carrito: dentro de una transacción, toma
 * `SELECT ... FOR UPDATE` sobre la fila del Cart, re-lee el estado
 * autoritativo bajo el lock y re-valida status/ownership ANTES de escribir
 * líneas, subtotal o metadata. Toda mutación de carrito (checkout, edición,
 * reorder, guardado desde el sitio) debe pasar por aquí: la lectura previa
 * al lock es solo un fast-fail, nunca la base de una escritura.
 *
 * - CART_NOT_FOUND (404): el carrito desapareció entre la lectura externa y
 *   el lock (delete concurrente).
 * - CART_NOT_ACTIVE (409): el carrito fue convertido/compartido/expirado
 *   mientras se esperaba el lock; la tx aborta SIN writes.
 * - CART_FORBIDDEN (403): el actor no es admin/agent ni dueño (por
 *   sessionId o userId) del estado POST-lock: cubre la transferencia
 *   invitado→cuenta ocurrida durante la espera del lock.
 */
export async function lockCartForMutation(
  tx: Prisma.TransactionClient,
  cartId: string,
  viewer: CartMutationViewer
): Promise<LockedCartSnapshot> {
  const locked = await tx.$queryRaw<LockedCartSnapshot[]>`
    SELECT id, status, "isActive", "sessionId", "userId"
    FROM "Cart" WHERE id = ${cartId} FOR UPDATE`;

  if (!locked || locked.length === 0) {
    throw new CartMutationError('CART_NOT_FOUND', 'Carrito no encontrado', 404);
  }

  const cart = locked[0];
  if (cart.status !== 'activo' || !cart.isActive) {
    throw new CartMutationError(
      'CART_NOT_ACTIVE',
      'Este carrito ya fue procesado o ya no se puede modificar',
      409
    );
  }

  const isOwner =
    (cart.sessionId !== null && cart.sessionId === viewer.sessionId) ||
    (cart.userId !== null && viewer.userId !== null && cart.userId === viewer.userId) ||
    (cart.sessionId === null &&
      cart.userId === null &&
      viewer.sessionId === null &&
      viewer.userId === null);

  if (!viewer.isAdminOrAgent && !isOwner) {
    throw new CartMutationError(
      'CART_FORBIDDEN',
      'No tienes permiso para modificar este carrito',
      403
    );
  }

  return cart;
}

