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

describe('N8N callback: validación de identificadores ANTES de tocar la base', () => {
  /**
   * Pre-fix, `where: orderId ? { id } : { orderNumber }` con ambos ausentes
   * quedaba como un filtro Prisma efectivamente vacío: `findFirst` devolvía el
   * PRIMER Order y el webhook lo confirmaba a 'recibido' con historial ajeno.
   * Cada caso inválido siembra un Order válido para que el bug fuera
   * observable, y afirma que NO hubo NI UNA llamada a base.
   */
  function expectZeroDbAccess() {
    expect(mockDb.order.findFirst).not.toHaveBeenCalled();
    expect(mockDb.order.findUnique).not.toHaveBeenCalled();
    expect(mockDb.orderItem.findMany).not.toHaveBeenCalled();
    expect(mockDb.order.update).not.toHaveBeenCalled();
    expect(mockDb.orderStatusHistory.create).not.toHaveBeenCalled();
  }

  const INVALID_IDENTIFIERS: Array<[string, unknown]> = [
    ['orderId vacío', { orderId: '' }],
    ['orderId en blanco', { orderId: '   ' }],
    ['orderId y orderNumber en blanco', { orderId: '   ', orderNumber: '   ' }],
    ['orderNumber vacío', { orderNumber: '' }],
    ['orderId null', { orderId: null }],
    ['orderId y orderNumber null', { orderId: null, orderNumber: null }],
    ['orderId numérico', { orderId: 123 }],
    ['orderNumber booleano', { orderNumber: true }],
    ['orderId objeto', { orderId: { id: 'order-1' } }],
    ['orderId array', { orderId: ['order-1'] }],
  ];

  it('sin orderId ni orderNumber => 400 y CERO acceso a base', async () => {
    installDb(makeOrder(), [10000]);

    const res = await POST(req({ status: 'recibido' }));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toEqual({ success: false, error: 'Se requiere orderId u orderNumber' });
    expectZeroDbAccess();
  });

  it('body JSON nulo => 400 y CERO acceso a base', async () => {
    installDb(makeOrder(), [10000]);

    const res = await POST(req(null));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Se requiere orderId u orderNumber');
    expectZeroDbAccess();
  });

  it('body JSON primitivo => 400 y CERO acceso a base', async () => {
    installDb(makeOrder(), [10000]);

    const res = await POST(req('order-1'));

    expect(res.status).toBe(400);
    expectZeroDbAccess();
  });

  it('JSON malformado => 400 y CERO acceso a base', async () => {
    installDb(makeOrder(), [10000]);

    const res = await POST(
      new Request('http://localhost/api/webhooks/n8n', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
        body: '{no-es-json',
      }) as unknown as NextRequest
    );

    expect(res.status).toBe(400);
    expectZeroDbAccess();
  });

  it.each(INVALID_IDENTIFIERS)('%s => 400 y CERO acceso a base', async (_name, body) => {
    installDb(makeOrder(), [10000]);

    const res = await POST(req(body));
    const json = await res.json();

    expect(res.status).toBe(400);
    expect(json).toEqual({ success: false, error: 'Se requiere orderId u orderNumber' });
    expectZeroDbAccess();
  });

  it('orderId válido => lookup por id y confirmación', async () => {
    installDb(makeOrder(), [10000]);

    const res = await POST(req({ orderId: 'order-1' }));

    expect(res.status).toBe(200);
    expect(mockDb.order.findFirst).toHaveBeenCalledTimes(1);
    expect(mockDb.order.findFirst).toHaveBeenCalledWith({ where: { id: 'order-1' } });
    expect(mockDb.order.update).toHaveBeenCalledTimes(1);
  });

  it('orderId válido con espacios => se normaliza (trim) antes del lookup', async () => {
    installDb(makeOrder(), [10000]);

    const res = await POST(req({ orderId: '  order-1  ' }));

    expect(res.status).toBe(200);
    expect(mockDb.order.findFirst).toHaveBeenCalledWith({ where: { id: 'order-1' } });
  });

  it('sin orderId + orderNumber válido => lookup por orderNumber', async () => {
    installDb(makeOrder(), [10000]);

    const res = await POST(req({ orderNumber: '  CS-4B-0001  ' }));

    expect(res.status).toBe(200);
    expect(mockDb.order.findFirst).toHaveBeenCalledTimes(1);
    expect(mockDb.order.findFirst).toHaveBeenCalledWith({
      where: { orderNumber: 'CS-4B-0001' },
    });
  });

  it('orderId y orderNumber válidos => precedencia intacta de orderId', async () => {
    installDb(makeOrder(), [10000]);

    const res = await POST(req({ orderId: 'order-1', orderNumber: 'CS-4B-0001' }));

    expect(res.status).toBe(200);
    expect(mockDb.order.findFirst).toHaveBeenCalledTimes(1);
    expect(mockDb.order.findFirst).toHaveBeenCalledWith({ where: { id: 'order-1' } });
  });

  it('orderId inválido pero orderNumber válido => cae a orderNumber', async () => {
    installDb(makeOrder(), [10000]);

    const res = await POST(req({ orderId: '   ', orderNumber: 'CS-4B-0001' }));

    expect(res.status).toBe(200);
    expect(mockDb.order.findFirst).toHaveBeenCalledWith({
      where: { orderNumber: 'CS-4B-0001' },
    });
  });
});
