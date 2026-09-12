import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {} }));

import {
  authorizeOrderAccess,
  OrderAccessError,
} from '@/lib/order-access';
import {
  buildOrderItemPriceComparisons,
} from '@/lib/order-detail';

/**
 * FASE 3 — Permisos del portal cliente + comparación de precios.
 */

describe('authorizeOrderAccess', () => {
  const orderA = { customerId: 'cust-A', sessionId: null };
  const orderB = { customerId: 'cust-B', sessionId: null };
  const guestOrderA = { customerId: null, sessionId: 'sess-A' };
  const guestOrderB = { customerId: null, sessionId: 'sess-B' };

  it('CUSTOMER A no puede ver el Order B de CUSTOMER B', () => {
    expect(() =>
      authorizeOrderAccess(orderB, { user: { id: 'cust-A', role: 'CUSTOMER' }, sessionId: 'sess-A' })
    ).toThrow(OrderAccessError);
  });

  it('CUSTOMER A ve su propio pedido', () => {
    expect(() =>
      authorizeOrderAccess(orderA, { user: { id: 'cust-A', role: 'CUSTOMER' }, sessionId: 'x' })
    ).not.toThrow();
  });

  it('CUSTOMER A no puede colarse por sessionId en un pedido de invitado', () => {
    expect(() =>
      authorizeOrderAccess(guestOrderA, { user: { id: 'cust-A', role: 'CUSTOMER' }, sessionId: 'sess-A' })
    ).toThrow(OrderAccessError);
  });

  it('invitado A no puede consultar el pedido del invitado B', () => {
    expect(() =>
      authorizeOrderAccess(guestOrderB, { user: null, sessionId: 'sess-A' })
    ).toThrow(OrderAccessError);
  });

  it('invitado A consulta su propio pedido (sessionId exacto)', () => {
    expect(() =>
      authorizeOrderAccess(guestOrderA, { user: null, sessionId: 'sess-A' })
    ).not.toThrow();
  });

  it('pedido transferido a cliente (sessionId null) ya no es accesible como invitado', () => {
    const transferred = { customerId: 'cust-A', sessionId: null };
    expect(() =>
      authorizeOrderAccess(transferred, { user: null, sessionId: 'sess-A' })
    ).toThrow(OrderAccessError);
  });

  it('admin conserva acceso', () => {
    expect(() =>
      authorizeOrderAccess(orderB, { user: { id: 'admin-1', role: 'admin' }, sessionId: null })
    ).not.toThrow();
  });

  it('AGENT no tiene acceso por esta vía en Fase 3 (ni siquiera a pedidos asignados)', () => {
    const assignedToAgent = { customerId: 'cust-A', sessionId: null };
    expect(() =>
      authorizeOrderAccess(assignedToAgent, { user: { id: 'agent-7', role: 'AGENT' }, sessionId: null })
    ).toThrow(OrderAccessError);
  });
});

describe('comparación de precios histórico vs actual', () => {
  const makeProduct = (overrides: Partial<any> = {}) => ({
    id: 'p1',
    isActive: true,
    stockQuantity: 50,
    variants: [],
    ...overrides,
  });

  const item = (over: Partial<any> = {}) => ({
    id: 'oi1',
    productId: 'p1',
    productName: 'Cuaderno',
    productSku: 'SKU',
    variantId: null,
    variantName: null,
    variantCode: null,
    quantity: 2,
    unitPrice: 10000,
    ...over,
  });

  const price = (unitPrice: number | null) => new Map([['p1::', { unitPrice, requiresQuote: unitPrice === null || unitPrice! <= 0 }]]);

  it('histórico 10000 → actual 12000: increased +2000 +20%', () => {
    const [result] = buildOrderItemPriceComparisons(
      [item()],
      new Map([['p1', makeProduct()]]),
      price(12000)
    );
    expect(result.priceStatus).toBe('increased');
    expect(result.priceDifference).toBe(2000);
    expect(result.priceDifferencePercent).toBe(20);
  });

  it('histórico 10000 → actual 8000: decreased -2000 -20%', () => {
    const [result] = buildOrderItemPriceComparisons(
      [item()],
      new Map([['p1', makeProduct()]]),
      price(8000)
    );
    expect(result.priceStatus).toBe('decreased');
    expect(result.priceDifference).toBe(-2000);
    expect(result.priceDifferencePercent).toBe(-20);
  });

  it('precio igual => unchanged, sin diferencia', () => {
    const [result] = buildOrderItemPriceComparisons(
      [item()],
      new Map([['p1', makeProduct()]]),
      price(10000)
    );
    expect(result.priceStatus).toBe('unchanged');
    expect(result.priceDifference).toBeNull();
  });

  it('producto eliminado => unavailable (nunca el snapshot se modifica)', () => {
    const [result] = buildOrderItemPriceComparisons(
      [item()],
      new Map(), // producto ya no existe
      price(12000)
    );
    expect(result.priceStatus).toBe('unavailable');
    expect(result.currentUnitPrice).toBeNull();
    expect(result.historicalUnitPrice).toBe(10000);
    expect(result.historicalLineTotal).toBe(20000);
  });

  it('producto inactivo => unavailable', () => {
    const [result] = buildOrderItemPriceComparisons(
      [item()],
      new Map([['p1', makeProduct({ isActive: false })]]),
      price(12000)
    );
    expect(result.priceStatus).toBe('unavailable');
  });

  it('precio actual 0 / cotización => requires_quote', () => {
    const [result] = buildOrderItemPriceComparisons(
      [item()],
      new Map([['p1', makeProduct()]]),
      price(0)
    );
    expect(result.priceStatus).toBe('requires_quote');
    expect(result.currentRequiresQuote).toBe(true);
  });

  it('variante inactiva => unavailable aunque el producto exista', () => {
    const [result] = buildOrderItemPriceComparisons(
      [item({ variantId: 'v1' })],
      new Map([
        ['p1', makeProduct({ variants: [{ id: 'v1', isActive: false, stockQuantity: 10 }] })],
      ]),
      new Map([['p1::v1', { unitPrice: 5000, requiresQuote: false }]])
    );
    expect(result.priceStatus).toBe('unavailable');
  });

  it('subtotal histórico intacto: historicalLineTotal = unitPrice * cantidad', () => {
    const [result] = buildOrderItemPriceComparisons(
      [item({ quantity: 3, unitPrice: 12345.5 })],
      new Map([['p1', makeProduct()]]),
      new Map([['p1::', { unitPrice: null, requiresQuote: true }]])
    );
    expect(result.historicalLineTotal).toBeCloseTo(37036.5);
  });
});
