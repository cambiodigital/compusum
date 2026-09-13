import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NextRequest } from 'next/server';

/**
 * FASE 4B — POLÍTICA DE AUTO-SHARE del checkout REAL (POST /api/orders).
 *
 * El webhook puede seguir notificando y su resultado SIEMPRE se persiste
 * (webhookSent/webhookResponse), pero el paso automático a 'compartido' se
 * decide SERVER-SIDE sobre el Order persistido y sus OrderItems:
 *
 *   pedido normal            -> comparte con éxito (comportamiento intacto)
 *   cotización completa      -> comparte con éxito (política explícita)
 *   cotización incompleta    -> permanece 'solicitado' (editable en 4B)
 *   webhook failure          -> nunca hay transición
 *
 * Nada del body (requestType, flags de completitud, subtotal, items) altera
 * esa decisión: se prueba enviando valores contradictorios.
 *
 * `createOrderFromCart` tiene su propia suite (order-lifecycle); aquí se fija
 * su resultado y se ejerce el handler REAL con una db mini-transaccional.
 */

const mockDb = vi.hoisted(() => ({
  $transaction: vi.fn(),
  $queryRaw: vi.fn(),
  order: { update: vi.fn(), findUnique: vi.fn() },
  orderItem: { findMany: vi.fn() },
  orderStatusHistory: { create: vi.fn() },
}));

vi.mock('@/lib/db', () => ({ db: mockDb }));

const mockWebhook = vi.hoisted(() => ({
  sendToWebhook: vi.fn(),
  buildWebhookPayload: vi.fn(),
}));

vi.mock('@/lib/webhook', () => mockWebhook);

vi.mock('@/lib/order-create', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/order-create')>();
  return { ...actual, createOrderFromCart: vi.fn() };
});

import { POST } from '@/app/api/orders/route';
import { createOrderFromCart } from '@/lib/order-create';
import { isQuoteComplete } from '@/lib/commercial-order';

const createOrderFromCartMock = vi.mocked(createOrderFromCart);

interface OrderRow {
  id: string;
  orderNumber: string;
  status: string;
  requestType: string;
  customerId: string | null;
  agentId: string | null;
  subtotal: number;
  webhookSent?: boolean;
  webhookResponse?: string | null;
}

let orders: Map<string, OrderRow>;
let orderItems: Map<string, { unitPrice: number | null }[]>;
let history: { orderId: string; fromStatus: string | null; toStatus: string }[];

/** Estado persistido: el Order y sus líneas, única fuente de la decisión. */
function seed(
  order: { id: string; requestType: string; status?: string },
  itemPrices: Array<number | null>
) {
  orders.set(order.id, {
    id: order.id,
    orderNumber: `CS-4B-${order.id}`,
    status: order.status ?? 'solicitado',
    requestType: order.requestType,
    customerId: null,
    agentId: null,
    subtotal: itemPrices.reduce<number>((sum, price) => sum + (price ?? 0), 0),
  });
  orderItems.set(
    order.id,
    itemPrices.map((unitPrice) => ({ unitPrice }))
  );
}

function installDb() {
  orders = new Map();
  orderItems = new Map();
  history = [];

  // Rollback real: si la transacción lanza, el estado vuelve al snapshot.
  mockDb.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
    const snapshot = JSON.stringify({
      orders: Array.from(orders.entries()),
      orderItems: Array.from(orderItems.entries()),
      history,
    });
    try {
      return await fn(mockDb);
    } catch (err) {
      const parsed = JSON.parse(snapshot);
      orders = new Map(parsed.orders);
      orderItems = new Map(parsed.orderItems);
      history = parsed.history;
      throw err;
    }
  });

  // Lock pesimista del Order (SELECT ... FOR UPDATE).
  mockDb.$queryRaw.mockImplementation(async (...args: unknown[]) => {
    const orderId = args[args.length - 1] as string;
    const order = orders.get(orderId);
    return order ? [{ ...order }] : [];
  });

  mockDb.order.findUnique.mockImplementation(({ where }: { where: { id: string } }) =>
    orders.get(where.id) ?? null
  );
  mockDb.orderItem.findMany.mockImplementation(({ where }: { where: { orderId: string } }) =>
    orderItems.get(where.orderId) ?? []
  );
  mockDb.order.update.mockImplementation(
    ({ where, data }: { where: { id: string }; data: Partial<OrderRow> }) => {
      const order = orders.get(where.id);
      if (!order) throw new Error('order not found');
      Object.assign(order, data);
      return { ...order };
    }
  );
  mockDb.orderStatusHistory.create.mockImplementation(({ data }: { data: never }) => {
    history.push(data);
    return data;
  });
}

/** Orden creado que devuelve `createOrderFromCart` (snapshot incluido). */
function createdOrder(id: string, requestType: string, itemPrices: Array<number | null>) {
  return {
    id,
    orderNumber: `CS-4B-${id}`,
    status: 'solicitado',
    requestType,
    subtotal: itemPrices.reduce<number>((sum, price) => sum + (price ?? 0), 0),
    items: itemPrices.map((unitPrice, index) => ({
      id: `oi-${index}`,
      orderId: id,
      unitPrice,
    })),
  };
}

function post(body: unknown): Promise<Response> {
  return POST(
    new Request('http://localhost/api/orders', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-session-id': 'sess-1' },
      body: JSON.stringify(body),
    }) as unknown as NextRequest
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  installDb();
  mockWebhook.buildWebhookPayload.mockResolvedValue({ orderNumber: 'CS-4B', orderId: 'x' });
});

describe('POST /api/orders — auto-share de cotización (handler real)', () => {
  it('cotización incompleta + webhook success => creada, sigue "solicitado", webhook persistido y SIN historial', async () => {
    // Línea sin precio persistida (requiere cotización) + línea con precio.
    seed({ id: 'quote-1', requestType: 'cotizacion' }, [10000, null]);
    createOrderFromCartMock.mockResolvedValue({
      order: createdOrder('quote-1', 'cotizacion', [10000, null]) as never,
      requestType: 'cotizacion',
      replayed: false,
    });
    mockWebhook.sendToWebhook.mockResolvedValue({ success: true, response: 'ok' });

    // El body MIENTE: dice estar completo, envía subtotal y "líneas completas".
    const res = await post({
      cartId: 'cart-1',
      requestType: 'cotizacion',
      isComplete: true,
      subtotal: 999999,
      items: [{ productId: 'p-eng', quantity: 2, unitPrice: 10000 }],
    });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);
    expect(json.data).toMatchObject({ id: 'quote-1', requestType: 'cotizacion' });

    const order = orders.get('quote-1')!;
    // La cotización NO se comparte: sigue 'solicitado' => editable en 4B.
    expect(order.status).toBe('solicitado');
    // El webhook sí notificó y su resultado quedó persistido.
    expect(order.webhookSent).toBe(true);
    expect(order.webhookResponse).toBe('ok');
    // NINGUNA transición solicitado -> compartido.
    expect(history).toHaveLength(0);
    expect(history.some((h) => h.toStatus === 'compartido')).toBe(false);
    // El único update NO llevó status.
    expect(mockDb.order.update).toHaveBeenCalledTimes(1);
    expect(mockDb.order.update.mock.calls[0][0].data).not.toHaveProperty('status');
  });

  it('pedido normal + webhook success => comportamiento existente intacto (compartido + historial)', async () => {
    // Con líneas sin precio: un pedido normal NO pasa por el guard de cotización.
    seed({ id: 'order-1', requestType: 'pedido' }, [null]);
    createOrderFromCartMock.mockResolvedValue({
      order: createdOrder('order-1', 'pedido', [null]) as never,
      requestType: 'pedido',
      replayed: false,
    });
    mockWebhook.sendToWebhook.mockResolvedValue({ success: true, response: 'ok' });

    const res = await post({ cartId: 'cart-2', requestType: 'pedido' });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.success).toBe(true);

    const order = orders.get('order-1')!;
    expect(order.status).toBe('compartido');
    expect(order.webhookSent).toBe(true);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      orderId: 'order-1',
      fromStatus: 'solicitado',
      toStatus: 'compartido',
      changedBy: 'sistema',
    });
  });

  it('cotización COMPLETA + webhook success => política explícita: pasa a compartido con historial', async () => {
    seed({ id: 'quote-2', requestType: 'cotizacion' }, [10000, 5000]);
    createOrderFromCartMock.mockResolvedValue({
      order: createdOrder('quote-2', 'cotizacion', [10000, 5000]) as never,
      requestType: 'cotizacion',
      replayed: false,
    });
    mockWebhook.sendToWebhook.mockResolvedValue({ success: true, response: 'ok' });

    const res = await post({ cartId: 'cart-3', requestType: 'cotizacion' });

    expect(res.status).toBe(200);
    const order = orders.get('quote-2')!;
    expect(order.status).toBe('compartido');
    expect(order.webhookSent).toBe(true);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      orderId: 'quote-2',
      fromStatus: 'solicitado',
      toStatus: 'compartido',
      changedBy: 'sistema',
    });
  });

  it('cotización con CERO líneas + webhook success => incompleta, sigue "solicitado" sin historial', async () => {
    seed({ id: 'quote-empty', requestType: 'cotizacion' }, []);
    createOrderFromCartMock.mockResolvedValue({
      order: createdOrder('quote-empty', 'cotizacion', []) as never,
      requestType: 'cotizacion',
      replayed: false,
    });
    mockWebhook.sendToWebhook.mockResolvedValue({ success: true, response: 'ok' });

    await post({ cartId: 'cart-4', requestType: 'cotizacion' });

    expect(orders.get('quote-empty')!.status).toBe('solicitado');
    expect(history).toHaveLength(0);
  });

  it('webhook failure => webhookSent=false, status intacto y CERO historial (sin transición indebida)', async () => {
    seed({ id: 'order-fail', requestType: 'pedido' }, [10000]);
    createOrderFromCartMock.mockResolvedValue({
      order: createdOrder('order-fail', 'pedido', [10000]) as never,
      requestType: 'pedido',
      replayed: false,
    });
    mockWebhook.sendToWebhook.mockResolvedValue({ success: false, response: 'n8n caído' });

    const res = await post({ cartId: 'cart-5', requestType: 'pedido' });

    expect(res.status).toBe(200);
    const order = orders.get('order-fail')!;
    expect(order.status).toBe('solicitado');
    expect(order.webhookSent).toBe(false);
    expect(order.webhookResponse).toBe('n8n caído');
    expect(history).toHaveLength(0);
  });

  it('el pedido ya avanzó durante el envío => el webhook NO lo revierte a "compartido"', async () => {
    // La confirmación de N8N llegó primero: el pedido ya está 'recibido'.
    seed({ id: 'order-raced', requestType: 'pedido', status: 'recibido' }, [10000]);
    createOrderFromCartMock.mockResolvedValue({
      order: createdOrder('order-raced', 'pedido', [10000]) as never,
      requestType: 'pedido',
      replayed: false,
    });
    mockWebhook.sendToWebhook.mockResolvedValue({ success: true, response: 'ok' });

    await post({ cartId: 'cart-7', requestType: 'pedido' });

    const order = orders.get('order-raced')!;
    // El resultado del webhook sí se persiste, pero el estado NO se revierte.
    expect(order.status).toBe('recibido');
    expect(order.webhookSent).toBe(true);
    expect(history).toHaveLength(0);
    expect(mockDb.order.update.mock.calls[0][0].data).not.toHaveProperty('status');
  });

  it('el body dice requestType=pedido pero el Order persistido es cotización incompleta => NO comparte', async () => {
    // La decisión debe salir del Order persistido, no del body.
    seed({ id: 'quote-body-lie', requestType: 'cotizacion' }, [null]);
    createOrderFromCartMock.mockResolvedValue({
      order: createdOrder('quote-body-lie', 'cotizacion', [null]) as never,
      requestType: 'cotizacion',
      replayed: false,
    });
    mockWebhook.sendToWebhook.mockResolvedValue({ success: true, response: 'ok' });

    await post({ cartId: 'cart-8', requestType: 'pedido' });

    const order = orders.get('quote-body-lie')!;
    expect(order.requestType).toBe('cotizacion');
    expect(order.status).toBe('solicitado');
    expect(history).toHaveLength(0);
  });

  it('las líneas del resultado de creación están completas pero las PERSISTIDAS no => NO comparte', async () => {
    // El snapshot devuelto por createOrderFromCart no es la fuente de verdad:
    // la decisión lee las filas lockeadas.
    seed({ id: 'quote-stale-snapshot', requestType: 'cotizacion' }, [10000, null]);
    createOrderFromCartMock.mockResolvedValue({
      order: createdOrder('quote-stale-snapshot', 'cotizacion', [10000, 5000]) as never,
      requestType: 'cotizacion',
      replayed: false,
    });
    mockWebhook.sendToWebhook.mockResolvedValue({ success: true, response: 'ok' });

    await post({ cartId: 'cart-9', requestType: 'cotizacion' });

    const order = orders.get('quote-stale-snapshot')!;
    expect(order.status).toBe('solicitado');
    expect(history).toHaveLength(0);
  });

  it('replay idempotente => no re-envía webhook ni toca el pedido', async () => {
    seed({ id: 'order-replay', requestType: 'pedido' }, [10000]);
    createOrderFromCartMock.mockResolvedValue({
      order: createdOrder('order-replay', 'pedido', [10000]) as never,
      requestType: 'pedido',
      replayed: true,
    });

    const res = await post({ cartId: 'cart-6', requestType: 'pedido' });
    const json = await res.json();

    expect(res.status).toBe(200);
    expect(json.data.replayed).toBe(true);
    expect(mockWebhook.sendToWebhook).not.toHaveBeenCalled();
    expect(mockDb.$transaction).not.toHaveBeenCalled();
    expect(mockDb.order.update).not.toHaveBeenCalled();
    expect(history).toHaveLength(0);
  });
});

describe('isQuoteComplete — regla única compartida por todos los writers', () => {
  it('cotización de 0 líneas => incompleta', () => {
    expect(isQuoteComplete([])).toBe(false);
  });

  it('una línea sin precio => incompleta', () => {
    expect(isQuoteComplete([{ unitPrice: null }])).toBe(false);
    expect(isQuoteComplete([{ unitPrice: 10000 }, { unitPrice: null }])).toBe(false);
  });

  it('una línea con precio 0 o negativo => incompleta', () => {
    expect(isQuoteComplete([{ unitPrice: 0 }])).toBe(false);
    expect(isQuoteComplete([{ unitPrice: -1 }])).toBe(false);
  });

  it('una línea con precio NaN => incompleta', () => {
    expect(isQuoteComplete([{ unitPrice: NaN }])).toBe(false);
  });

  it('todas las líneas con precio positivo => completa', () => {
    expect(isQuoteComplete([{ unitPrice: 1 }])).toBe(true);
    expect(isQuoteComplete([{ unitPrice: 10000 }, { unitPrice: 5000 }])).toBe(true);
  });
});
