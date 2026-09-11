import { db } from './db';
import { hashPassword } from './auth';
import { Prisma } from '@prisma/client';
import { getNextRouteDeparture } from './route-schedule';
import { canonicalColombiaPhone, phoneOrVariants } from './phone';

function generateTemporaryPassword(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Teléfono canónico (`src/lib/phone.ts`): `3001234567`, `+573001234567` y
 * `573001234567` producen SIEMPRE `573001234567`. Mantiene el nombre público
 * usado por el flujo de pedidos.
 */
export function normalizePhone(phone?: string | null): string | null {
  return canonicalColombiaPhone(phone);
}

export function normalizeEmail(email?: string | null): string | null {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  return normalized;
}

/** Busca un cliente por teléfono (cualquier forma almacenada) o email. */
async function findCustomerByCheckoutContact(phone: string | null, email: string | null, tx: any) {
  const client = tx ?? db;
  if (phone) {
    const byPhone = await client.user.findFirst({
      where: {
        role: { equals: 'CUSTOMER', mode: 'insensitive' },
        OR: phoneOrVariants(phone),
      },
    });
    if (byPhone) return byPhone;
  }
  if (email) {
    return client.user.findFirst({
      where: { role: { equals: 'CUSTOMER', mode: 'insensitive' }, email },
    });
  }
  return null;
}

export async function upsertCheckoutCustomer(
  input: { name?: string | null; phone?: string | null; email?: string | null },
  tx: any = db
) {
  const phone = normalizePhone(input.phone);
  const email = normalizeEmail(input.email);

  if (!phone && !email) {
    return {
      customer: null,
      assignedAgentId: null,
      normalizedPhone: null,
      normalizedEmail: null,
      isNewCustomer: false,
    };
  }

  let customer: any = await findCustomerByCheckoutContact(phone, email, tx);

  if (customer) {
    const updateData: Record<string, string> = {};

    // Canonicaliza teléfonos legados al completar datos (escritura idempotente)
    if (phone && customer.phone !== phone) updateData.phone = phone;
    if (email && !customer.email) updateData.email = email;

    const incomingName = input.name?.trim();
    if (incomingName && (!customer.name || customer.name === 'Nuevo Cliente')) {
      updateData.name = incomingName.slice(0, 200);
    }

    if (Object.keys(updateData).length > 0) {
      customer = await tx.user.update({
        where: { id: customer.id },
        data: updateData,
      });
    }

    return {
      customer,
      assignedAgentId: customer.assignedAgentId,
      normalizedPhone: phone,
      normalizedEmail: email,
      isNewCustomer: false,
    };
  }

  try {
    const created = await tx.user.create({
      data: {
        phone,
        email,
        name: input.name?.trim().slice(0, 200) || 'Nuevo Cliente',
        role: 'CUSTOMER',
        password: await hashPassword(generateTemporaryPassword()),
      },
    });

    return {
      customer: created,
      assignedAgentId: null,
      normalizedPhone: phone,
      normalizedEmail: email,
      isNewCustomer: true,
    };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const existing = await findCustomerByCheckoutContact(phone, email, tx);

      if (existing) {
        return {
          customer: existing,
          assignedAgentId: existing.assignedAgentId,
          normalizedPhone: phone,
          normalizedEmail: email,
          isNewCustomer: false,
        };
      }
    }

    throw error;
  }
}

export interface SessionUserRef {
  id: string;
  role: string;
}

/**
 * Resuelve el cliente (y su asesor asignado) al que se asociará un pedido.
 *
 * - Cliente autenticado (rol CUSTOMER) => su propia cuenta es el maestro; el
 *   contacto del body solo complementa datos faltantes, nunca cambia la linked
 *   account ni el asesor.
 * - Invitado o ADMIN/AGENT => upsert por contacto (comportamiento existente
 *   preservado para checkout de invitados y ventas asistidas).
 */
export async function resolveOrderCustomer(
  sessionUser: SessionUserRef | null | undefined,
  input: { name?: string | null; phone?: string | null; email?: string | null },
  tx: any = db
) {
  if (sessionUser?.role?.toLowerCase() === 'customer') {
    let customer = await tx.user.findUnique({ where: { id: sessionUser.id } });

    if (customer && customer.isActive) {
      const updateData: Record<string, string> = {};
      const phone = normalizePhone(input.phone);
      const email = normalizeEmail(input.email);

      if (phone && !customer.phone) updateData.phone = phone;
      if (email && !customer.email) updateData.email = email;

      const incomingName = input.name?.trim();
      if (incomingName && (!customer.name || customer.name === 'Nuevo Cliente')) {
        updateData.name = incomingName.slice(0, 200);
      }

      if (Object.keys(updateData).length > 0) {
        customer = await tx.user.update({
          where: { id: customer.id },
          data: updateData,
        });
      }

      return {
        customer,
        assignedAgentId: customer.assignedAgentId ?? null,
        normalizedPhone: normalizePhone(input.phone),
        normalizedEmail: normalizeEmail(input.email),
        isNewCustomer: false,
      };
    }
  }

  return upsertCheckoutCustomer(input, tx);
}

export async function findBestRouteForCity(cityId?: string | null, now = new Date(), tx: any = db) {
  if (!cityId) return null;

  const routes = await tx.shippingRoute.findMany({
    where: {
      cities: { some: { id: cityId } },
      isActive: true,
    },
    orderBy: { sortOrder: 'asc' },
  });

  if (!routes || !routes.length) return null;

  const openRoutes = routes.filter((route: any) => {
    if (route.cutOffTime && new Date(route.cutOffTime) <= now) {
      return false;
    }
    return true;
  });

  if (!openRoutes.length) return null;

  const routesWithNextDeparture = openRoutes.map((route: any) => {
    let nextDeparture: Date | null = null;
    if (route.departureDaysOfWeek && Array.isArray(route.departureDaysOfWeek) && route.departureDaysOfWeek.length > 0) {
      nextDeparture = getNextRouteDeparture(now, route.departureDaysOfWeek).nextDepartureDate;
    } else if (route.departureDate) {
      nextDeparture = new Date(route.departureDate);
    } else {
      nextDeparture = getNextRouteDeparture(now, [1]).nextDepartureDate;
    }
    return { route, nextDeparture };
  });

  routesWithNextDeparture.sort((a: any, b: any) => {
    const timeA = a.nextDeparture ? a.nextDeparture.getTime() : Infinity;
    const timeB = b.nextDeparture ? b.nextDeparture.getTime() : Infinity;
    if (timeA !== timeB) return timeA - timeB;
    return (a.route.sortOrder || 0) - (b.route.sortOrder || 0);
  });

  return routesWithNextDeparture[0]?.route || null;
}

/**
 * Transferir carritos y órdenes de sesión a usuario cuando inicia sesión registrado
 * Llamar esto después de autenticar un usuario con sessionId
 */
export async function transferSessionDataToUser(sessionId: string, userId: string) {
  const { transferSessionCartToUser } = await import('./order-cart-upsert');
  const { transferSessionOrderToUser } = await import('./order-cart-upsert');

  return db.$transaction(async (tx) => {
    // Transferir carrito
    const transferredCart = await transferSessionCartToUser(sessionId, userId);

    // Transferir orden(es)
    const transferredOrders = await transferSessionOrderToUser(sessionId, userId);

    return {
      cart: transferredCart,
      orders: transferredOrders,
    };
  });
}
