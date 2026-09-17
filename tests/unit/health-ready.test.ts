import { describe, it, expect, vi, beforeEach } from 'vitest';

/**
 * Fase 7 — endpoints de health (liveness) y ready (readiness).
 *
 * health: 200 siempre, sin tocar la base de datos, cuerpo mínimo sin
 *         información sensible.
 * ready:  200 sólo si la DB responde a un ping real; 503 si la DB falla o se
 *         cuelga; el cuerpo NUNCA incluye el error interno (sólo el estado).
 */

const mockQueryRaw = vi.fn();

vi.mock('@/lib/db', () => ({
  db: {
    $queryRaw: (...args: unknown[]) => mockQueryRaw(...args),
  },
}));

import { GET as healthGET } from '@/app/api/health/route';
import { GET as readyGET } from '@/app/api/ready/route';

describe('GET /api/health (liveness)', () => {
  it('responde 200 {status: ok} sin depender de la base de datos', async () => {
    const res = await healthGET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ status: 'ok' });
    // liveness no debe tocar la DB
    expect(mockQueryRaw).not.toHaveBeenCalled();
  });

  it('no expone campos internos (version, host, errores)', async () => {
    const res = await healthGET();
    const body = await res.json();
    expect(Object.keys(body)).toEqual(['status']);
  });
});

describe('GET /api/ready (readiness)', () => {
  beforeEach(() => {
    mockQueryRaw.mockReset();
    mockQueryRaw.mockResolvedValue([{ '?column?': 1 }]);
  });

  it('responde 200 {status: ready} cuando la DB responde al ping', async () => {
    const res = await readyGET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'ready' });
    expect(mockQueryRaw).toHaveBeenCalledTimes(1);
  });

  it('responde 503 {status: unavailable} cuando la DB esta caida', async () => {
    mockQueryRaw.mockRejectedValue(new Error('connect ECONNREFUSED'));
    const res = await readyGET();
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.status).toBe('unavailable');
    // sin filtracion del error interno
    expect(JSON.stringify(body)).not.toContain('ECONNREFUSED');
  });

  it('responde 503 cuando la DB se cuelga (timeout)', async () => {
    mockQueryRaw.mockImplementation(
      () => new Promise(() => undefined) // nunca resuelve
    );
    const res = await readyGET();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ status: 'unavailable' });
  });

  it('nunca incluye stack trace ni detalle del error en la respuesta', async () => {
    mockQueryRaw.mockRejectedValue(
      new Error('connection refused - host interno simulado')
    );
    const res = await readyGET();
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain('connection');
    expect(text).not.toContain('refused');
    expect(text).not.toContain('stack');
  });
});
