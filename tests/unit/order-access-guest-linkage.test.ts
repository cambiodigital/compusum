import { describe, it, expect, vi } from 'vitest';

vi.mock('@/lib/db', () => ({ db: {} }));

import {
  authorizeOrderAccess,
  OrderAccessError,
} from '@/lib/order-access';

/**
 * FASE 3 — POLÍTICA DE CICLO DE VIDA INVITADO.
 *
 * Una sesión invitada accede a un pedido exactamente cuando el sessionId
 * coincide. El customerId del auto-enlace CRM (contacto del checkout de
 * invitados) NO transfiere la propiedad: la sesión que creó el pedido NO
 * pierde acceso. La transferencia real ocurre SOLO por login/registro
 * (order.sessionId = null, customerId = userId).
 */

describe('authorizeOrderAccess: enlace CRM vs transferencia de propiedad', () => {
  // Pedido de invitado tras el auto-enlace de contacto en checkout:
  // conserva la sessionId creadora Y gana customerId (enlace CRM).
  const guestLinkedOrder = { customerId: 'cust-auto', sessionId: 'sess-A' };

  it('la sesión invitada creadora conserva acceso aunque el pedido tenga customerId', () => {
    expect(() =>
      authorizeOrderAccess(guestLinkedOrder, { user: null, sessionId: 'sess-A' })
    ).not.toThrow();
  });

  it('otra sesión invitada sigue fuera: 403', () => {
    expect(() =>
      authorizeOrderAccess(guestLinkedOrder, { user: null, sessionId: 'sess-B' })
    ).toThrow(OrderAccessError);
  });

  it('un CUSTOMER distinto del enlace no puede colarse ni por sessionId', () => {
    expect(() =>
      authorizeOrderAccess(guestLinkedOrder, { user: { id: 'cust-B', role: 'CUSTOMER' }, sessionId: 'sess-A' })
    ).toThrow(OrderAccessError);
  });

  it('el CUSTOMER enlazado (customerId === su id) accede a su pedido', () => {
    expect(() =>
      authorizeOrderAccess(guestLinkedOrder, { user: { id: 'cust-auto', role: 'CUSTOMER' }, sessionId: null })
    ).not.toThrow();
  });

  it('transferencia explícita (sessionId null): la sesión invitada pierde acceso', () => {
    const transferred = { customerId: 'cust-U', sessionId: null };
    expect(() =>
      authorizeOrderAccess(transferred, { user: null, sessionId: 'sess-A' })
    ).toThrow(OrderAccessError);
  });

  it('transferencia explícita: la cuenta cliente gana acceso', () => {
    const transferred = { customerId: 'cust-U', sessionId: null };
    expect(() =>
      authorizeOrderAccess(transferred, { user: { id: 'cust-U', role: 'CUSTOMER' }, sessionId: null })
    ).not.toThrow();
  });

  it('invitado sin sessionId => 401 sesión no válida', () => {
    expect(() =>
      authorizeOrderAccess(guestLinkedOrder, { user: null, sessionId: null })
    ).toThrow(OrderAccessError);
  });

  it('admin conserva acceso a pedidos con auto-enlace CRM', () => {
    expect(() =>
      authorizeOrderAccess(guestLinkedOrder, { user: { id: 'admin-1', role: 'admin' }, sessionId: null })
    ).not.toThrow();
  });
});
