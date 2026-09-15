import { describe, it, expect, vi } from 'vitest';

/**
 * FASE 5A — semántica canónica tri-state de `cityId`
 * (src/lib/city-route.ts · parseCityIdMutation).
 *
 * Regla única para TODAS las mutaciones que aceptan cityId:
 *   undefined       → "omit"  (NO cambiar la ciudad existente)
 *   null | ""       → "clear" (limpiar explícitamente)
 *   string no vacío → "set"   (validar server-side y fijar)
 *   otro tipo       → CityResolutionError (400, nunca P2003 → 500)
 *
 * Se mocka @/lib/db: esta tabla es lógica PURA, sin base de datos.
 */
vi.mock('@/lib/db', () => ({ db: {} }));

import { parseCityIdMutation, CityResolutionError } from '@/lib/city-route';

describe('Fase 5A — parseCityIdMutation (tri-state canónico)', () => {
  it('undefined => omit (conservar)', () => {
    expect(parseCityIdMutation(undefined)).toEqual({ action: 'omit' });
  });

  it('null => clear (limpiar)', () => {
    expect(parseCityIdMutation(null)).toEqual({ action: 'clear' });
  });

  it('string vacío/espacios => clear (compatibilidad con `|| null` histórico)', () => {
    expect(parseCityIdMutation('')).toEqual({ action: 'clear' });
    expect(parseCityIdMutation('   ')).toEqual({ action: 'clear' });
  });

  it('string no vacío => set, con trim', () => {
    expect(parseCityIdMutation('  city-123  ')).toEqual({ action: 'set', cityId: 'city-123' });
  });

  it('string de más de 64 chars => truncado a 64', () => {
    const long = 'a'.repeat(100);
    expect(parseCityIdMutation(long)).toEqual({ action: 'set', cityId: 'a'.repeat(64) });
  });

  it('tipos no string (number/objeto/array) => CityResolutionError (400)', () => {
    expect(() => parseCityIdMutation(123)).toThrow(CityResolutionError);
    expect(() => parseCityIdMutation({ id: 'x' })).toThrow(CityResolutionError);
    expect(() => parseCityIdMutation(['x'])).toThrow(CityResolutionError);
    expect(() => parseCityIdMutation(true)).toThrow(CityResolutionError);
  });
});
