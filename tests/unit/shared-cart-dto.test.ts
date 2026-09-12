import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {} }));

import {
  authorizeCartViewer,
  buildSharedCartDTO,
} from '@/lib/shared-cart';

/**
 * FASE 3 — CARRITO COMPARTIDO: política capability-link con DTO público.
 * El visor jamás recibe email/teléfono del dueño ni su precio de perfil.
 */

const OWNER_CART = {
  id: 'cart-1',
  uuid: 'uuid-secreto',
  sessionId: 'sess-A',
  userId: 'cust-A',
  status: 'activo',
  isActive: true,
  customerName: 'Dueño A',
  customerEmail: 'dueno@privado.com',
  customerPhone: '573001234567',
  customerCompany: 'Papelería A',
  notes: 'Entregar en la mañana',
  city: {
    name: 'Pereira',
    department: { name: 'Risaralda' },
    shippingRoute: {
      name: 'Ruta Eje Cafetero',
      estimatedDaysMin: 1,
      estimatedDaysMax: 2,
      shippingCompany: 'Interrapidisimo',
    },
  },
  items: [
    {
      id: 'ci1',
      variantId: null,
      variantName: null,
      variantCode: null,
      quantity: 2,
      // Precio del DUEÑO (perfil privado A) en el snapshot del carrito
      unitPrice: 5000,
      // Precio resuelto para el VISOR (invitado => base 8000)
      resolvedPrice: { unitPrice: 8000, purchasable: true, requiresQuote: false },
      product: {
        id: 'p1',
        name: 'Cuaderno Norma',
        slug: 'cuaderno-norma',
        sku: 'SKU-1',
        minWholesaleQty: 1,
        stockStatus: 'disponible',
        catalogMode: false,
        brand: { name: 'Norma', slug: 'norma', catalogMode: false },
        category: { name: 'Cuadernos', slug: 'cuadernos', catalogMode: false },
      },
    },
    {
      id: 'ci2',
      variantId: 'v1',
      variantName: '100 hojas',
      variantCode: 'V100',
      quantity: 1,
      unitPrice: 3000, // snapshot dueño
      resolvedPrice: { unitPrice: null, purchasable: false, requiresQuote: true },
      product: {
        id: 'p2',
        name: 'Agenda premium',
        slug: 'agenda-premium',
        sku: 'SKU-2',
        minWholesaleQty: 1,
        stockStatus: 'disponible',
        catalogMode: false,
        brand: null,
        category: null,
      },
    },
  ],
} as any;

describe('buildSharedCartDTO: DTO público seguro', () => {
  it('NUNCA incluye customerEmail ni customerPhone del dueño', () => {
    const dto = buildSharedCartDTO(OWNER_CART);
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain('dueno@privado.com');
    expect(serialized).not.toContain('573001234567');
    expect(dto).not.toHaveProperty('customerEmail');
    expect(dto).not.toHaveProperty('customerPhone');
  });

  it('el visor ve SU precio resuelto, no el snapshot del dueño', () => {
    const dto = buildSharedCartDTO(OWNER_CART);
    // Snapshot del dueño era 5000; el visor (invitado) ve 8000
    expect(dto.items[0].unitPrice).toBe(8000);
    const serialized = JSON.stringify(dto);
    expect(serialized).not.toContain('"unitPrice":5000');
  });

  it('línea por cotizar: unitPrice null y hasQuoteItems=true', () => {
    const dto = buildSharedCartDTO(OWNER_CART);
    expect(dto.items[1].requiresQuote).toBe(true);
    expect(dto.items[1].unitPrice).toBeNull();
    expect(dto.hasQuoteItems).toBe(true);
    // Subtotal solo con líneas con precio conocidas (visor)
    expect(dto.subtotal).toBe(16000);
  });

  it('mantiene solo logística estrictamente necesaria', () => {
    const dto = buildSharedCartDTO(OWNER_CART);
    expect(dto.city?.name).toBe('Pereira');
    expect(dto.city?.department).toBe('Risaralda');
    expect(dto.city?.shippingRoute?.name).toBe('Ruta Eje Cafetero');
    // Sin IDs internos innecesarios del dueño
    expect(dto).not.toHaveProperty('sessionId');
    expect(dto).not.toHaveProperty('userId');
  });
});

describe('authorizeCartViewer: política única API/página', () => {
  it('cualquier visor con el UUID (capability-link) puede VER el DTO', () => {
    const access = authorizeCartViewer(OWNER_CART, { user: null, sessionId: 'sess-B' });
    expect(access.allowed).toBe(true);
    expect(access.canManage).toBe(false);
    expect(access.role).toBe('shared');
  });

  it('el dueño (por sessionId) puede gestionar', () => {
    const access = authorizeCartViewer(OWNER_CART, { user: null, sessionId: 'sess-A' });
    expect(access.allowed).toBe(true);
    expect(access.canManage).toBe(true);
    expect(access.role).toBe('owner');
  });

  it('el dueño (por userId) puede gestionar', () => {
    const access = authorizeCartViewer(OWNER_CART, { user: { id: 'cust-A', role: 'CUSTOMER' }, sessionId: null });
    expect(access.canManage).toBe(true);
  });

  it('admin/AGENT gestionan', () => {
    const access = authorizeCartViewer(OWNER_CART, { user: { id: 'adm', role: 'admin' }, sessionId: null });
    expect(access.allowed).toBe(true);
    expect(access.canManage).toBe(true);
  });

  it('carrito inexistente o inactivo => denegado', () => {
    expect(
      authorizeCartViewer(null, { user: null, sessionId: 'sess-B' }).allowed
    ).toBe(false);
    expect(
      authorizeCartViewer({ ...OWNER_CART, isActive: false }, { user: null, sessionId: 'sess-A' }).allowed
    ).toBe(false);
    expect(
      authorizeCartViewer({ ...OWNER_CART, isActive: false }, { user: { id: 'cust-A', role: 'CUSTOMER' }, sessionId: null }).allowed
    ).toBe(false);
  });
});
