import { db } from './db';
import { hashPassword } from './auth';
import { Prisma } from '@prisma/client';
import { validateAndPriceItems } from './cart-validation';
import { generateOrderNumber, createOrderTransactionWithRetry } from './order-number';

function generateTemporaryPassword(): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function normalizePhone(phone?: string | null): string | null {
  if (!phone) return null;
  const digitsOnly = phone.replace(/\D/g, '');
  return digitsOnly.length >= 7 ? digitsOnly : null;
}

export function normalizeEmail(email?: string | null): string | null {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  if (!normalized) return null;
  return normalized;
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

  let customer: any = null;
  if (phone) {
    customer = await tx.user.findUnique({ where: { phone } });
  }

  if (!customer && email) {
    customer = await tx.user.findUnique({ where: { email } });
  }

  if (customer) {
    const updateData: Record<string, string> = {};

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
      const existing = phone
        ? await tx.user.findUnique({ where: { phone } })
        : await tx.user.findUnique({ where: { email: email! } });

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

export async function findBestRouteForCity(cityId?: string | null, now = new Date(), tx: any = db) {
  if (!cityId) return null;

  const routes = await tx.shippingRoute.findMany({
    where: {
      cities: { some: { id: cityId } },
      isActive: true,
      departureDate: { not: null },
    },
    orderBy: { departureDate: 'asc' },
    take: 10,
  });

  if (!routes.length) return null;

  const openRoute = routes.find((route: any) => !route.cutOffTime || route.cutOffTime > now);
  return openRoute || null;
}

export async function processCheckout(checkoutData: any) {
  const { phone, email, name, items, cityId, cartId } = checkoutData;

  return createOrderTransactionWithRetry(async (tx: any) => {
    const { validatedItems, subtotal } = await validateAndPriceItems(items, tx);
    const customerResult = await upsertCheckoutCustomer({ name, phone, email }, tx);
    const availableRoute = await findBestRouteForCity(cityId, new Date(), tx);
    const orderNumber = await generateOrderNumber(tx);

    const order = await tx.order.create({
      data: {
        orderNumber,
        cartId,
        customerId: customerResult.customer?.id || null,
        customerName: customerResult.customer?.name || name || 'Cliente',
        customerEmail: customerResult.normalizedEmail,
        customerPhone: customerResult.normalizedPhone,
        agentId: customerResult.assignedAgentId,
        cityId,
        routeId: availableRoute?.id,
        subtotal,
        items: {
          create: validatedItems.map((item) => ({
            productId: item.productId,
            productName: item.productName,
            variantId: item.variantId,
            variantName: item.variantName,
            variantCode: item.variantCode,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
          })),
        },
      },
    });

    return { order, route: availableRoute };
  });
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
