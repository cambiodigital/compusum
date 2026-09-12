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
    try {
      return await client.cart.create({
        data: {
          userId,
          status: 'activo',
          cityId: cityId || null,
        },
        include: { items: true },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        // Race condition: another concurrent request already created this cart
        return await client.cart.findFirstOrThrow({
          where: { userId, status: 'activo' },
          include: { items: true },
        });
      }
      throw e;
    }
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
    try {
      return await client.cart.create({
        data: {
          sessionId,
          status: 'activo',
          cityId: cityId || null,
        },
        include: { items: true },
      });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        // Race condition: another concurrent request already created this cart
        return await client.cart.findFirstOrThrow({
          where: { sessionId, status: 'activo' },
          include: { items: true },
        });
      }
      throw e;
    }
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

  // Encontrar carrito activo con sessionId
  const sessionCart = await tx.cart.findFirst({
    where: {
      sessionId,
      status: 'activo',
    },
  });

  if (!sessionCart) return null;

  // Lock de la fila del carrito antes de transferirla (orden global Order→Cart).
  await tx.$queryRaw`SELECT id FROM "Cart" WHERE id = ${sessionCart.id} FOR UPDATE`;

  // Expirar carritos activos previos del usuario (preserva históricos, no borra).
  // La exclusión por id evita que una forma legada (pre-20260312) con sessionId
  // Y userId a la vez sea expirada por esta pasada y reclamada ya expirada,
  // dejando al usuario SIN carrito activo.
  await tx.cart.updateMany({
    where: {
      userId,
      status: 'activo',
      id: { not: sessionCart.id },
    },
    data: {
      status: 'expirado',
    },
  });

  // Transferir el carrito de sesión al usuario
  return await tx.cart.update({
    where: { id: sessionCart.id },
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

