import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

/**
 * P2 — incomplete-quote guard for the MANUAL webhook share route
 * (POST /api/orders/[id]/webhook).
 *
 * The route is admin-gated (requireAdminApi) and flips the status to
 * "compartido" only from "solicitado" (and only on webhook success), so the
 * guard runs with targetStatus "compartido" BEFORE any send or write: an
 * incomplete "cotizacion" must never leave through this endpoint.
 */

const authState = vi.hoisted(() => ({
  currentUser: null as { id: string; name: string; email: string; role: string } | null,
}));

const mockDb = vi.hoisted(() => ({
  order: {
    findUnique: vi.fn(),
    update: vi.fn(),
  },
  orderItem: {
    findMany: vi.fn(),
  },
  orderStatusHistory: {
    create: vi.fn(),
  },
}));

const mockWebhook = vi.hoisted(() => ({
  sendToWebhook: vi.fn(),
  buildWebhookPayload: vi.fn(),
}));

vi.mock('@/lib/db', () => ({ db: mockDb }));

vi.mock('@/lib/auth', async () => {
  const { NextResponse } = await import('next/server');
  return {
    requireAdminApi: async () => {
      const user = authState.currentUser;
      if (!user) {
        return {
          error: NextResponse.json({ success: false, error: 'No autorizado' }, { status: 401 }),
          user: null,
        };
      }
      return { error: null, user };
    },
  };
});

vi.mock('@/lib/webhook', () => mockWebhook);

import { POST } from '@/app/api/orders/[id]/webhook/route';

const ADMIN = { id: 'admin-1', name: 'Admin', email: 'admin@test.com', role: 'admin' };

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'quote-1',
    orderNumber: 'CS-4B-0001',
    status: 'solicitado',
    requestType: 'cotizacion',
    ...overrides,
  };
}

function makePayload(overrides: Record<string, unknown> = {}) {
  return {
    orderNumber: 'CS-4B-0001',
    orderId: 'quote-1',
    status: 'solicitado',
    requestType: 'cotizacion',
    ...overrides,
  };
}

/** Installs the guard's read mocks (order + items) and the route's writes. */
function installDb(order: Record<string, unknown> | null, itemUnitPrices: Array<number | null>) {
  mockDb.order.findUnique.mockImplementation(() =>
    Promise.resolve(order ? { id: order.id, requestType: order.requestType } : null)
  );
  mockDb.orderItem.findMany.mockImplementation(() =>
    Promise.resolve(itemUnitPrices.map((unitPrice) => ({ unitPrice })))
  );
  mockDb.order.update.mockResolvedValue({ ...order });
  mockDb.orderStatusHistory.create.mockResolvedValue({});
}

function req(): NextRequest {
  return new Request('http://localhost/api/orders/quote-1/webhook', {
    method: 'POST',
  }) as unknown as NextRequest;
}

function idParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

beforeEach(() => {
  vi.clearAllMocks();
  authState.currentUser = ADMIN;
});

describe('Manual webhook share: incomplete-quote guard', () => {
  it('incomplete cotizacion => 400, webhook sender NOT called, zero writes', async () => {
    const order = makeOrder();
    installDb(order, [10000, null]); // one line without a positive price
    mockWebhook.buildWebhookPayload.mockResolvedValue(makePayload());

    const res = await POST(req(), idParams('quote-1'));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toEqual({
      success: false,
      error: 'La cotización tiene líneas sin precio y no puede compartirse o recibirse',
    });

    // Nothing was sent and nothing was written.
    expect(mockWebhook.sendToWebhook).not.toHaveBeenCalled();
    expect(mockDb.order.update).not.toHaveBeenCalled();
    expect(mockDb.orderStatusHistory.create).not.toHaveBeenCalled();
  });

  it('cotización con CERO líneas => 400, webhook NO enviado, cero writes', async () => {
    const order = makeOrder();
    installDb(order, []); // sin líneas: incompleta (antes se colaba como shareable)
    mockWebhook.buildWebhookPayload.mockResolvedValue(makePayload());

    const res = await POST(req(), idParams('quote-1'));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toEqual({
      success: false,
      error: 'La cotización tiene líneas sin precio y no puede compartirse o recibirse',
    });

    expect(mockWebhook.sendToWebhook).not.toHaveBeenCalled();
    expect(mockDb.order.update).not.toHaveBeenCalled();
    expect(mockDb.orderStatusHistory.create).not.toHaveBeenCalled();
  });

  it('complete cotizacion => proceeds: webhook sent and status flipped to compartido', async () => {
    const order = makeOrder();
    installDb(order, [10000, 5000]);
    mockWebhook.buildWebhookPayload.mockResolvedValue(makePayload());
    mockWebhook.sendToWebhook.mockResolvedValue({ success: true, response: 'ok' });

    const res = await POST(req(), idParams('quote-1'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockWebhook.sendToWebhook).toHaveBeenCalledTimes(1);
    expect(mockDb.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'quote-1' },
        data: expect.objectContaining({ status: 'compartido', webhookSent: true }),
      })
    );
    expect(mockDb.orderStatusHistory.create).toHaveBeenCalledTimes(1);
  });

  it('pedido with unpriced lines => guard is a no-op (requestType filter), webhook proceeds', async () => {
    const order = makeOrder({ requestType: 'pedido' });
    installDb(order, [null]);
    mockWebhook.buildWebhookPayload.mockResolvedValue(makePayload({ requestType: 'pedido' }));
    mockWebhook.sendToWebhook.mockResolvedValue({ success: true, response: 'ok' });

    const res = await POST(req(), idParams('quote-1'));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockWebhook.sendToWebhook).toHaveBeenCalledTimes(1);
    // The status flip is unaffected: it only depends on the webhook success.
    expect(mockDb.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'quote-1' },
        data: expect.objectContaining({ status: 'compartido' }),
      })
    );
  });
});
