/**
 * Helpers para gestionar órdenes y carritos con lógica de upsert
 * basada en session_id para usuarios invitados y user_id para usuarios logueados.
 */

import { db } from './db';
import { Prisma } from '@prisma/client';
import { generateOrderNumber } from './order-number';

/**
 * Obtiene o crea un carrito activo basado en sessionId o userId
 * @param sessionId - Session ID del navegador (para usuarios invitados)
 * @param userId - User ID (para usuarios logueados)
 * @param cityId - City ID opcional
 * @returns El carrito existente o uno nuevo
 */
export async function upsertActiveCart(
  sessionId: string | null | undefined,
  userId: string | null | undefined,
  cityId?: string | null
) {
  // Si no hay sessionId ni userId, crear carrito nuevo
  if (!sessionId && !userId) {
    return await db.cart.create({
      data: {
        status: 'activo',
        cityId: cityId || null,
      },
      include: { items: true },
    });
  }

  // Buscar carrito activo existente
  if (sessionId) {
    const existingCart = await db.cart.findFirst({
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
      return await db.cart.create({
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
        return await db.cart.findFirstOrThrow({
          where: { sessionId, status: 'activo' },
          include: { items: true },
        });
      }
      throw e;
    }
  }

  if (userId) {
    const existingCart = await db.cart.findFirst({
      where: {
        userId,
        status: 'activo',
      },
      include: { items: true },
    });

    if (existingCart) {
      return existingCart;
    }

    // Crear carrito para este usuario
    try {
      return await db.cart.create({
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
        return await db.cart.findFirstOrThrow({
          where: { userId, status: 'activo' },
          include: { items: true },
        });
      }
      throw e;
    }
  }

  // Fallback
  return await db.cart.create({
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
 * Transfiere un carrito de sesión a usuario cuando este se registra/inicia sesión
 * @param sessionId - Session ID anterior (para invitados)
 * @param userId - User ID (nuevo usuario registrado/logueado)
 */
export async function transferSessionCartToUser(
  sessionId: string | null | undefined,
  userId: string
) {
  if (!sessionId) return null;

  // Encontrar carrito activo con sessionId
  const sessionCart = await db.cart.findFirst({
    where: {
      sessionId,
      status: 'activo',
    },
  });

  if (!sessionCart) return null;

  // Marcar cualquier carrito anterior del usuario como expirado para evitar conflictos
  await db.cart.updateMany({
    where: {
      userId,
      status: 'activo',
    },
    data: {
      status: 'expirado',
    },
  });

  // Transferir el carrito de sesión al usuario
  return await db.cart.update({
    where: { id: sessionCart.id },
    data: {
      userId,
      sessionId: null, // Desvincularlo de la sesión
      updatedAt: new Date(),
    },
    include: { items: true },
  });
}

/**
 * Obtiene o crea una orden activa basada en sessionId o customerId
 * @param sessionId - Session ID del navegador (para usuarios invitados)
 * @param customerId - Customer ID (para usuarios logueados)
 * @returns La orden existente o null
 */
export async function findActiveOrder(
  sessionId: string | null | undefined,
  customerId: string | null | undefined
) {
  // Buscar orden activa por sessionId
  if (sessionId) {
    return await db.order.findFirst({
      where: {
        sessionId,
        status: 'solicitado',
      },
      include: {
        items: true,
        statusHistory: true,
      },
    });
  }

  // Buscar orden activa por customerId
  if (customerId) {
    return await db.order.findFirst({
      where: {
        customerId,
        status: 'solicitado',
      },
      include: {
        items: true,
        statusHistory: true,
      },
    });
  }

  return null;
}

/**
 * Crea o actualiza una orden con lógica de upsert
 * Garantiza un único pedido activo por sesión/usuario
 * @param orderData - Datos de la orden
 * @param cartId - ID del carrito
 * @param sessionId - Session ID del navegador
 * @param customerId - Customer ID
 * @param tx - Transacción de Prisma (opcional)
 * @returns La orden creada o actualizada
 */
export async function upsertOrder(
  orderData: {
    orderNumber?: string;
    customerName?: string | null;
    customerEmail?: string | null;
    customerPhone?: string | null;
    customerCompany?: string | null;
    cityId?: string | null;
    routeId?: string | null;
    notes?: string | null;
    agentId?: string | null;
    subtotal: number;
    sentVia?: string | null;
    items: Array<{
      productId: string;
      productName: string;
      productSku?: string | null;
      variantId?: string | null;
      variantName?: string | null;
      variantCode?: string | null;
      quantity: number;
      unitPrice: number | null;
    }>;
  },
  cartId: string,
  sessionId: string | null | undefined,
  customerId: string | null | undefined,
  tx: any = db
) {
  // Buscar orden activa existente
  let existingOrder = null;

  if (sessionId) {
    existingOrder = await tx.order.findFirst({
      where: {
        sessionId,
        status: 'solicitado',
      },
    });
  } else if (customerId) {
    existingOrder = await tx.order.findFirst({
      where: {
        customerId,
        status: 'solicitado',
      },
    });
  }

  // Si existe orden activa, actualizarla
  if (existingOrder) {
    // Eliminar items anteriores
    await tx.orderItem.deleteMany({
      where: { orderId: existingOrder.id },
    });

    // Actualizar orden
    const updated = await tx.order.update({
      where: { id: existingOrder.id },
      data: {
        ...orderData,
        items: {
          create: orderData.items,
        },
        updatedAt: new Date(),
      },
      include: { items: true },
    });

    return updated;
  }

  // Si no existe, crear nueva orden
  const orderNumber = orderData.orderNumber || (await generateOrderNumber(tx));

  const created = await tx.order.create({
    data: {
      orderNumber,
      cartId,
      sessionId: sessionId || null,
      customerId: customerId || null,
      ...orderData,
      items: {
        create: orderData.items,
      },
    },
    include: { items: true },
  });

  return created;
}

/**
 * Transfiere una orden de sesión a usuario cuando este se registra/inicia sesión
 * @param sessionId - Session ID anterior (para invitados)
 * @param customerId - Customer ID (nuevo usuario registrado/logueado)
 */
export async function transferSessionOrderToUser(
  sessionId: string | null | undefined,
  customerId: string
) {
  if (!sessionId) return null;

  // Encontrar órdenes con sessionId
  const sessionOrders = await db.order.findMany({
    where: {
      sessionId,
    },
  });

  if (sessionOrders.length === 0) return null;

  // Transferir todas las órdenes del guest sessionId al usuario
  const orders = [];
  for (const order of sessionOrders) {
    const updated = await db.order.update({
      where: { id: order.id },
      data: {
        customerId,
        sessionId: null,
        updatedAt: new Date(),
      },
      include: { items: true },
    });
    orders.push(updated);
  }

  return orders.length === 1 ? orders[0] : orders;
}

