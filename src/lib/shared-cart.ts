import type { Cart } from "@prisma/client";
import { cookies } from "next/headers";
import type { NextRequest } from "next/server";
import { db } from "./db";
import { getCurrentUser } from "./auth";
import { isBackofficeRole, isAgentRole } from "./roles";
import type { PricingCustomerContext } from "./pricing";

/**
 * CARRITO COMPARTIDO — política ÚNICA (Fase 3).
 *
 * La página `/carrito/[uuid]` y el API `/api/carts/[uuid]` usan EXACTAMENTE
 * la misma autorización y el mismo DTO. Ya no existe una política para el
 * API y otra distinta para la página server-side.
 *
 * POLÍTICA DEFINITIVA (capability-link):
 * - El UUID del carrito funciona como enlace-capacidad: cualquiera que lo
 *   conozca puede VER el DTO público del carrito (los UUID v4 no son
 *   adivinables y el dueño los comparte explícitamente). Los enlaces ya
 *   circulados siguen funcionando; no se exige status='compartido'.
 * - El DTO público NUNCA incluye: customerEmail, customerPhone, snapshot de
 *   precio del dueño, precios privados de su perfil, IDs internos más allá
 *   de los necesarios para operar (id/uuid del carrito y productId/variantId
 *   para "cargar en mi carrito") ni campos administrativos.
 * - Cada VISOR ve SIEMPRE su propio precio autorizado (motor único, contexto
 *   de su sesión) y el subtotal correspondiente a SUS precios: un invitado
 *   ve precio base; CUSTOMER B ve su precio de perfil, jamás el de A.
 * - El dueño (o admin/AGENT) puede gestionar el carrito; el visor solo ver.
 */

export interface CartViewer {
  user: { id: string; role: string } | null;
  sessionId: string | null;
}

export interface CartViewerRole {
  allowed: boolean;
  /** owner => puede gestionar; shared/admin => solo lectura del DTO público. */
  canManage: boolean;
  role: "owner" | "shared" | "admin" | "denied";
}

export async function getCartViewer(
  request?: NextRequest
): Promise<CartViewer> {
  const user = await getCurrentUser();
  // Ruta API: header inyectado por el proxy. Página server-side: cookie.
  const sessionId = request
    ? request.headers.get("x-session-id")
    : ((await cookies()).get("x-session-id")?.value ?? null);
  return { user, sessionId };
}

/**
 * Autorización capability-link. `ownerAssignedAgentId` (opcional) es el
 * asesor asignado del DUEÑO del carrito: solo lo necesita la rama AGENT
 * (comercial) para no gestionar carritos de clientes de OTRO asesor.
 * - undefined: dueño sin consultar u owner inexistente => tratable.
 * - null: el dueño no tiene asesor => tratable (venta asistida).
 */
export function authorizeCartViewer(
  cart: Pick<Cart, "sessionId" | "userId" | "status" | "isActive"> | null,
  viewer: CartViewer,
  ownerAssignedAgentId?: string | null
): CartViewerRole {
  if (!cart || !cart.isActive) {
    return { allowed: false, canManage: false, role: "denied" };
  }

  const isAdmin = isBackofficeRole(viewer.user?.role);
  const isOwner =
    Boolean(viewer.user && cart.userId && cart.userId === viewer.user.id) ||
    Boolean(cart.sessionId && viewer.sessionId && cart.sessionId === viewer.sessionId);

  if (isAdmin) {
    if (!isAgentRole(viewer.user?.role)) {
      return { allowed: true, canManage: true, role: "admin" };
    }
    // AGENT comercial: gestionar SOLO si el dueño no es cliente de OTRO
    // asesor. Carritos huérfanos/sesión siguen manejables (venta asistida).
    if (
      !cart.userId ||
      ownerAssignedAgentId === undefined ||
      ownerAssignedAgentId === null ||
      ownerAssignedAgentId === viewer.user?.id
    ) {
      return { allowed: true, canManage: true, role: "admin" };
    }
    return { allowed: false, canManage: false, role: "denied" };
  }
  if (isOwner) {
    return { allowed: true, canManage: true, role: "owner" };
  }
  // Capability-link: el UUID habilita la VISTA (lectura del DTO público).
  return { allowed: true, canManage: false, role: "shared" };
}

/**
 * Variante server-side que resuelve el asesor del dueño cuando el visor es
 * AGENT (una lectura extra solo en ese caso). Usar SIEMPRE desde las rutas
 * reales; `authorizeCartViewer` directo queda para tests/predicado puro.
 */
export async function authorizeCartViewerWithOwner(
  cart: Pick<Cart, "sessionId" | "userId" | "status" | "isActive"> | null,
  viewer: CartViewer
): Promise<CartViewerRole> {
  if (cart?.userId && isAgentRole(viewer.user?.role)) {
    const owner = await db.user.findUnique({
      where: { id: cart.userId },
      select: { assignedAgentId: true },
    });
    return authorizeCartViewer(cart, viewer, owner?.assignedAgentId ?? undefined);
  }
  return authorizeCartViewer(cart, viewer);
}

export interface SharedCartItemDTO {
  id: string;
  productId: string;
  variantId: string | null;
  variantName: string | null;
  variantCode: string | null;
  quantity: number;
  /** Precio resuelto para el VISOR (null => requiere cotización). */
  unitPrice: number | null;
  requiresQuote: boolean;
  product: {
    id: string;
    name: string;
    slug: string;
    sku: string | null;
    minWholesaleQty: number;
    stockStatus: string;
    catalogMode: boolean;
    brand: { name: string; slug: string; catalogMode?: boolean } | null;
    category: { name: string; slug: string; catalogMode?: boolean } | null;
  };
}

export interface SharedCartDTO {
  id: string;
  uuid: string;
  status: string;
  /** Nombre/empresa del dueño (NO contacto: sin email ni teléfono). */
  customerName: string | null;
  customerCompany: string | null;
  notes: string | null;
  /** Subtotal para el VISOR (precios conocidos; null si falta algún precio). */
  subtotal: number | null;
  hasQuoteItems: boolean;
  city: {
    name: string;
    department: string;
    shippingRoute: {
      name: string;
      estimatedDaysMin: number;
      estimatedDaysMax: number;
      shippingCompany: string | null;
    } | null;
  } | null;
  items: SharedCartItemDTO[];
}

interface CartWithItems {
  id: string;
  uuid: string;
  status: string;
  customerName: string | null;
  customerCompany: string | null;
  notes: string | null;
  city:
    | {
        name: string;
        department: { name: string };
        shippingRoute: {
          name: string;
          estimatedDaysMin: number;
          estimatedDaysMax: number;
          shippingCompany: string | null;
        } | null;
      }
    | null;
  items: Array<{
    id: string;
    variantId: string | null;
    variantName: string | null;
    variantCode: string | null;
    quantity: number;
    resolvedPrice?: { unitPrice: number | null; purchasable?: boolean; requiresQuote?: boolean } | null;
    product: {
      id: string;
      name: string;
      slug: string;
      sku: string | null;
      minWholesaleQty: number;
      stockStatus: string;
      catalogMode: boolean;
      brand: { name: string; slug: string; catalogMode?: boolean } | null;
      category: { name: string; slug: string; catalogMode?: boolean } | null;
    };
  }>;
}

/**
 * DTO público del carrito con precios del VISOR ya resueltos
 * (`attachResolvedPricesToCartItems` debe aplicarse ANTES).
 */
export function buildSharedCartDTO(
  cart: CartWithItems,
  catalogMode = false
): SharedCartDTO {
  const items: SharedCartItemDTO[] = cart.items.map((item) => {
    const resolved = item.resolvedPrice ?? null;
    const requiresQuote = resolved
      ? Boolean(resolved.requiresQuote) || resolved.unitPrice == null
      : catalogMode ||
        item.product.catalogMode ||
        item.product.stockStatus === "agotado";
    return {
      id: item.id,
      productId: item.product.id,
      variantId: item.variantId,
      variantName: item.variantName,
      variantCode: item.variantCode,
      quantity: item.quantity,
      unitPrice: requiresQuote ? null : (resolved?.unitPrice ?? null),
      requiresQuote,
      product: {
        id: item.product.id,
        name: item.product.name,
        slug: item.product.slug,
        sku: item.product.sku,
        minWholesaleQty: item.product.minWholesaleQty,
        stockStatus: item.product.stockStatus,
        catalogMode: item.product.catalogMode,
        brand: item.product.brand,
        category: item.product.category,
      },
    };
  });

  let subtotal = 0;
  let hasQuoteItems = false;
  for (const item of items) {
    if (item.unitPrice === null) {
      hasQuoteItems = true;
    } else {
      subtotal += item.unitPrice * item.quantity;
    }
  }

  return {
    id: cart.id,
    uuid: cart.uuid,
    status: cart.status,
    customerName: cart.customerName,
    customerCompany: cart.customerCompany,
    notes: cart.notes,
    // Con líneas por cotizar NO es un total definitivo: la UI lo indica.
    subtotal,
    hasQuoteItems,
    city: cart.city
      ? {
          name: cart.city.name,
          department: cart.city.department.name,
          shippingRoute: cart.city.shippingRoute
            ? {
                name: cart.city.shippingRoute.name,
                estimatedDaysMin: cart.city.shippingRoute.estimatedDaysMin,
                estimatedDaysMax: cart.city.shippingRoute.estimatedDaysMax,
                shippingCompany: cart.city.shippingRoute.shippingCompany,
              }
            : null,
        }
      : null,
    items,
  };
}

export type { PricingCustomerContext };
