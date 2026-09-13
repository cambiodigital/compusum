import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { NextRequest } from 'next/server';

/**
 * FASE 4B — guard de cotización incompleta en la CONFIRMACIÓN entrante de N8N
 * (POST /api/webhooks/n8n).
 *
 * Esta ruta es la contraparte del webhook que dispara POST /api/orders: sin el
 * guard, la misma cotización incompleta que el checkout deja en 'solicitado'
 * recibía la confirmación y pasaba a 'recibido' — congelándola para siempre
 * (canEdit = status === 'solicitado'). El asesor nunca podría completarla ni
 * convertirla, que es exactamente lo que el flujo 4B debe permitir.
 *
 * La regla es la MISMA función compartida que usan el PATCH de estado y el
 * webhook manual. Un pedido normal (incluso con líneas sin precio) conserva su
 * comportamiento: la confirmación lo pasa a 'recibido'.
 */

const mockDb = vi.hoisted(() => ({
  order: {
    findFirst: vi.fn(),
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

vi.mock('@/lib/db', () => ({ db: mockDb }));

import { POST } from '@/app/api/webhooks/n8n/route';

const API_KEY = 'test-n8n-key';

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    orderNumber: 'CS-4B-0001',
    status: 'solicitado',
    requestType: 'cotizacion',
    ...overrides,
  };
}

/** Instala las lecturas del guard (Order + OrderItems) y las escrituras. */
function installDb(order: Record<string, unknown> | null, itemUnitPrices: Array<number | null>) {
  mockDb.order.findFirst.mockResolvedValue(order ? { ...order } : null);
  mockDb.order.findUnique.mockResolvedValue(
    order ? { id: order.id, requestType: order.requestType } : null
  );
  mockDb.orderItem.findMany.mockResolvedValue(
    itemUnitPrices.map((unitPrice) => ({ unitPrice }))
  );
  mockDb.order.update.mockResolvedValue({ ...(order ?? {}) });
  mockDb.orderStatusHistory.create.mockResolvedValue({});
}

function req(body: unknown, apiKey: string | null = API_KEY): NextRequest {
  return new Request('http://localhost/api/webhooks/n8n', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { 'x-api-key': apiKey } : {}),
    },
    body: JSON.stringify(body),
  }) as unknown as NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('N8N_API_KEY', API_KEY);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('N8N callback: guard de cotización incompleta', () => {
  it('cotización incompleta => 400 y CERO writes (sigue editable en 4B)', async () => {
    installDb(makeOrder(), [10000, null]);

    const res = await POST(req({ orderId: 'order-1', status: 'recibido' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toEqual({
      success: false,
      error: 'La cotización tiene líneas sin precio y no puede compartirse o recibirse',
    });

    // La confirmación NUNCA se aplicó: ni estado ni historial.
    expect(mockDb.order.update).not.toHaveBeenCalled();
    expect(mockDb.orderStatusHistory.create).not.toHaveBeenCalled();
  });

  it('cotización con CERO líneas => 400 y CERO writes', async () => {
    installDb(makeOrder(), []);

    const res = await POST(req({ orderNumber: 'CS-4B-0001' }));

    expect(res.status).toBe(400);
    // El lookup por orderNumber (sin orderId) routea correctamente.
    expect(mockDb.order.findFirst).toHaveBeenCalledWith({
      where: { orderNumber: 'CS-4B-0001' },
    });
    expect(mockDb.order.update).not.toHaveBeenCalled();
    expect(mockDb.orderStatusHistory.create).not.toHaveBeenCalled();
  });

  it('estado desconocido => se coacciona a "recibido" y TAMBIÉN pasa por el guard', async () => {
    installDb(makeOrder(), [null]);

    const res = await POST(req({ orderId: 'order-1', status: 'entregado' }));

    expect(res.status).toBe(400);
    expect(mockDb.order.update).not.toHaveBeenCalled();
    expect(mockDb.orderStatusHistory.create).not.toHaveBeenCalled();
  });

  it('pedido inexistente => 404 y CERO writes', async () => {
    installDb(null, []);

    const res = await POST(req({ orderId: 'order-zzz' }));

    expect(res.status).toBe(404);
    expect(mockDb.order.update).not.toHaveBeenCalled();
    expect(mockDb.orderStatusHistory.create).not.toHaveBeenCalled();
  });

  it('cotización COMPLETA => confirma con 200, estado recibido e historial', async () => {
    installDb(makeOrder(), [10000, 5000]);

    const res = await POST(req({ orderId: 'order-1', status: 'recibido' }));
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(mockDb.order.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order-1' },
        data: expect.objectContaining({ status: 'recibido' }),
      })
    );
    expect(mockDb.orderStatusHistory.create).toHaveBeenCalledTimes(1);
    expect(mockDb.orderStatusHistory.create.mock.calls[0][0].data).toMatchObject({
      orderId: 'order-1',
      fromStatus: 'solicitado',
      toStatus: 'recibido',
      changedBy: 'n8n-webhook',
    });
  });

  it('pedido normal con líneas sin precio => guard no-op, confirma con 200 (comportamiento intacto)', async () => {
    installDb(makeOrder({ requestType: 'pedido' }), [null]);

    const res = await POST(req({ orderId: 'order-1', status: 'recibido' }));

    expect(res.status).toBe(200);
    expect(mockDb.order.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'recibido' }) })
    );
    expect(mockDb.orderStatusHistory.create).toHaveBeenCalledTimes(1);
  });

  it('API key inválida => 401 antes de cualquier lectura de negocio', async () => {
    installDb(makeOrder(), [10000]);

    const res = await POST(req({ orderId: 'order-1' }, 'clave-mala'));

    expect(res.status).toBe(401);
    expect(mockDb.order.findFirst).not.toHaveBeenCalled();
    expect(mockDb.order.update).not.toHaveBeenCalled();
  });
});
