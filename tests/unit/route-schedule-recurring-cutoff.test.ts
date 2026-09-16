import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BUSINESS_TIMEZONE,
  MAX_CUTOFF_DAYS_BEFORE,
  MAX_SEARCH_DAYS,
  toBusinessCivilDate,
  businessLocalToUtc,
  formatCivilDate,
  addCivilDays,
  civilDayOfWeek,
  civilDiffDays,
  validateRouteSchedule,
  resolveDepartureAvailability,
  cutoffForDeparture,
  getNextRouteDeparture,
  getDayNameSpanish,
  buildRollForwardNotice,
} from '@/lib/route-schedule';

/**
 * FASE 5B1 — cutoff RECURRENTE semanal + timezone explícita.
 *
 * Tests PUROS y DETERMINISTAS: `now` SIEMPRE se inyecta; ningún test lee el
 * reloj real. Todas las fechas se fijan sobre la semana del lunes 2026-09-14.
 *
 * America/Bogota = UTC-5 todo el año (sin DST), así que un instante UTC se
 * escribe como:  hora Bogotá + 5h.
 */

const repoRoot = path.resolve(__dirname, '..', '..');

// --- Instantes de referencia (UTC). Bogotá = UTC-5. -------------------------
const FRI_0911_1400_BOG = '2026-09-11T19:00:00.000Z'; // viernes 14:00 Bogotá
const FRI_0911_1359_BOG = '2026-09-11T18:59:59.000Z'; // 1s antes del cutoff
const FRI_0911_1401_BOG = '2026-09-11T19:00:01.000Z'; // 1s después
const MON_0914_0000_BOG = '2026-09-14T05:00:00.000Z';
const MON_0914_1000_BOG = '2026-09-14T15:00:00.000Z';
const MON_0914_2359_BOG = '2026-09-15T04:59:59.000Z'; // 23:59:59 Bogotá
const TUE_0915_0000_BOG = '2026-09-15T05:00:00.000Z'; // medianoche siguiente
const TUE_0915_1400_BOG = '2026-09-15T19:00:00.000Z'; // cutoff de la salida del miércoles
const SUN_0920_1400_BOG = '2026-09-20T19:00:00.000Z';

const at = (iso: string) => new Date(iso);

/** Extrae lo relevante de un resultado `available` para aserciones compactas. */
function nextOf(result: ReturnType<typeof resolveDepartureAvailability>) {
  if (result.status !== 'available') {
    throw new Error(`se esperaba available, llegó ${result.status}`);
  }
  return result;
}

describe('route-schedule · calendario civil de negocio', () => {
  it('expone America/Bogota como timezone única', () => {
    expect(BUSINESS_TIMEZONE).toBe('America/Bogota');
  });

  it('lee la fecha civil en Bogotá, no en UTC', () => {
    // 04:59Z del 15 = 23:59 del 14 en Bogotá
    expect(toBusinessCivilDate(at(MON_0914_2359_BOG))).toEqual({
      year: 2026,
      month: 9,
      day: 14,
    });
    // 05:00Z del 15 = 00:00 del 15 en Bogotá
    expect(toBusinessCivilDate(at(TUE_0915_0000_BOG))).toEqual({
      year: 2026,
      month: 9,
      day: 15,
    });
  });

  it('convierte hora local de negocio a instante UTC (UTC-5 fijo)', () => {
    expect(businessLocalToUtc({ year: 2026, month: 9, day: 11 }, '14:00').toISOString()).toBe(
      FRI_0911_1400_BOG
    );
    expect(businessLocalToUtc({ year: 2026, month: 9, day: 14 }, '00:00').toISOString()).toBe(
      MON_0914_0000_BOG
    );
  });

  it('aritmética civil: suma de días, día de semana y diferencias', () => {
    expect(formatCivilDate(addCivilDays({ year: 2026, month: 9, day: 14 }, 7))).toBe('2026-09-21');
    expect(formatCivilDate(addCivilDays({ year: 2026, month: 9, day: 14 }, -3))).toBe('2026-09-11');
    // cruce de fin de mes / año
    expect(formatCivilDate(addCivilDays({ year: 2026, month: 12, day: 31 }, 1))).toBe('2027-01-01');
    expect(civilDayOfWeek({ year: 2026, month: 9, day: 14 })).toBe(1); // lunes
    expect(civilDayOfWeek({ year: 2026, month: 9, day: 20 })).toBe(0); // domingo
    expect(civilDiffDays({ year: 2026, month: 9, day: 15 }, { year: 2026, month: 9, day: 21 })).toBe(6);
  });

  it('nombres de día en español', () => {
    expect(getDayNameSpanish(1)).toBe('lunes');
    expect(getDayNameSpanish(3)).toBe('miércoles');
    expect(getDayNameSpanish(0)).toBe('domingo');
  });
});

describe('route-schedule · validación del schedule (misconfigured)', () => {
  it('días vacíos => empty_days', () => {
    expect(validateRouteSchedule({ departureDaysOfWeek: [] })).toEqual({
      ok: false,
      reason: 'empty_days',
    });
    expect(validateRouteSchedule({ departureDaysOfWeek: null })).toEqual({
      ok: false,
      reason: 'empty_days',
    });
  });

  it('días fuera de rango o no enteros => invalid_days', () => {
    for (const days of [[7], [-1], [1.5], [0, 9]]) {
      expect(validateRouteSchedule({ departureDaysOfWeek: days })).toEqual({
        ok: false,
        reason: 'invalid_days',
      });
    }
  });

  it('cutoff parcial (días sin hora, o hora sin días) => partial_cutoff', () => {
    expect(
      validateRouteSchedule({ departureDaysOfWeek: [1], cutoffDaysBefore: 3, cutoffLocalTime: null })
    ).toEqual({ ok: false, reason: 'partial_cutoff' });
    expect(
      validateRouteSchedule({ departureDaysOfWeek: [1], cutoffDaysBefore: null, cutoffLocalTime: '14:00' })
    ).toEqual({ ok: false, reason: 'partial_cutoff' });
    // cadena vacía en la hora cuenta como ausente
    expect(
      validateRouteSchedule({ departureDaysOfWeek: [1], cutoffDaysBefore: 2, cutoffLocalTime: '  ' })
    ).toEqual({ ok: false, reason: 'partial_cutoff' });
  });

  it('cutoffDaysBefore fuera de rango => invalid_cutoff_days', () => {
    for (const daysBefore of [-1, 7, 1.5, Number.NaN]) {
      expect(
        validateRouteSchedule({
          departureDaysOfWeek: [1],
          cutoffDaysBefore: daysBefore,
          cutoffLocalTime: '14:00',
        })
      ).toEqual({ ok: false, reason: 'invalid_cutoff_days' });
    }
    // fronteras válidas
    for (const daysBefore of [0, MAX_CUTOFF_DAYS_BEFORE]) {
      expect(
        validateRouteSchedule({
          departureDaysOfWeek: [1],
          cutoffDaysBefore: daysBefore,
          cutoffLocalTime: '14:00',
        })
      ).toMatchObject({ ok: true, cutoffDaysBefore: daysBefore });
    }
  });

  it('hora inválida => invalid_cutoff_time', () => {
    for (const time of ['24:00', '9:05', '12:60', '14:00:00', 'abc', '14h00']) {
      expect(
        validateRouteSchedule({
          departureDaysOfWeek: [1],
          cutoffDaysBefore: 1,
          cutoffLocalTime: time,
        })
      ).toEqual({ ok: false, reason: 'invalid_cutoff_time' });
    }
    for (const time of ['00:00', '14:00', '23:59']) {
      expect(
        validateRouteSchedule({ departureDaysOfWeek: [1], cutoffDaysBefore: 1, cutoffLocalTime: time })
      ).toMatchObject({ ok: true, cutoffLocalTime: time });
    }
  });

  it('ambos null es válido (ruta SIN cutoff)', () => {
    expect(
      validateRouteSchedule({ departureDaysOfWeek: [1, 3], cutoffDaysBefore: null, cutoffLocalTime: null })
    ).toEqual({ ok: true, days: [1, 3], cutoffDaysBefore: null, cutoffLocalTime: null });
  });

  it('normaliza días duplicados y los ordena', () => {
    expect(validateRouteSchedule({ departureDaysOfWeek: [5, 1, 5, 3] })).toMatchObject({
      ok: true,
      days: [1, 3, 5],
    });
  });

  it('un schedule inválido nunca devuelve available', () => {
    for (const schedule of [
      { departureDaysOfWeek: [] as number[] },
      { departureDaysOfWeek: [1], cutoffDaysBefore: 2, cutoffLocalTime: null },
      { departureDaysOfWeek: [1], cutoffDaysBefore: 9, cutoffLocalTime: '14:00' },
      { departureDaysOfWeek: [1], cutoffDaysBefore: 1, cutoffLocalTime: '99:99' },
    ]) {
      const result = resolveDepartureAvailability(schedule, at(MON_0914_1000_BOG));
      expect(result.status).toBe('misconfigured');
    }
  });

  it('no cae al cutoff legacy: el schedule no conoce cutOffTime', () => {
    // Un schedule sin cutoff es "sin cutoff", sin importar qué hubiera en el
    // campo legacy del modelo (que ni siquiera forma parte de la entrada).
    const result = nextOf(
      resolveDepartureAvailability({ departureDaysOfWeek: [1] }, at(MON_0914_1000_BOG))
    );
    expect(result.cutoffAtUtc).toBeNull();
    expect(result.hoursLeft).toBeNull();
  });
});

describe('route-schedule · cutoff recurrente', () => {
  // Salida lunes; cutoff 3 días antes a las 14:00 => viernes anterior 14:00 Bogotá
  const MONDAY_ONLY_3D = {
    departureDaysOfWeek: [1],
    cutoffDaysBefore: 3,
    cutoffLocalTime: '14:00',
  };

  it('el cutoff se calcula relativo a CADA salida', () => {
    expect(
      cutoffForDeparture({ year: 2026, month: 9, day: 14 }, 3, '14:00')?.toISOString()
    ).toBe(FRI_0911_1400_BOG);
    expect(
      cutoffForDeparture({ year: 2026, month: 9, day: 21 }, 3, '14:00')?.toISOString()
    ).toBe('2026-09-18T19:00:00.000Z'); // viernes 18
    expect(cutoffForDeparture({ year: 2026, month: 9, day: 14 }, null, null)).toBeNull();
  });

  it('3) ANTES del cutoff: la salida más próxima es elegible', () => {
    const result = nextOf(resolveDepartureAvailability(MONDAY_ONLY_3D, at(FRI_0911_1359_BOG)));
    expect(result.next.civilDate).toBe('2026-09-14');
    expect(result.next.dayName).toBe('lunes');
    expect(result.next.daysUntil).toBe(3);
    expect(result.cutoffAtUtc?.toISOString()).toBe(FRI_0911_1400_BOG);
    expect(result.skippedDeparture).toBe(false);
    expect(result.skippedCivilDate).toBeNull();
    expect(result.hoursLeft).toBe(0); // menos de 1 hora
  });

  it('4) EXACTAMENTE en el cutoff: esa salida YA está cerrada', () => {
    const result = nextOf(resolveDepartureAvailability(MONDAY_ONLY_3D, at(FRI_0911_1400_BOG)));
    expect(result.skippedDeparture).toBe(true);
    expect(result.skippedCivilDate).toBe('2026-09-14');
    expect(result.next.civilDate).toBe('2026-09-21');
  });

  it('5) DESPUÉS del cutoff: tampoco se devuelve la salida cerrada', () => {
    const result = nextOf(resolveDepartureAvailability(MONDAY_ONLY_3D, at(FRI_0911_1401_BOG)));
    expect(result.next.civilDate).toBe('2026-09-21');
    expect(result.skippedDeparture).toBe(true);
  });

  it('6) roll-forward: nunca queda cerrada permanentemente', () => {
    // Un instante tardío cualquiera siempre encuentra una salida futura.
    for (const iso of [
      '2026-09-14T19:30:00.000Z',
      '2026-09-18T00:00:00.000Z',
      '2026-12-31T23:00:00.000Z',
      '2027-03-05T12:00:00.000Z',
    ]) {
      const result = resolveDepartureAvailability(MONDAY_ONLY_3D, at(iso));
      expect(result.status).toBe('available');
      const available = nextOf(result);
      // la salida devuelta siempre tiene su cutoff en el futuro
      expect(available.cutoffAtUtc!.getTime()).toBeGreaterThan(at(iso).getTime());
      // y siempre es un lunes
      expect(available.next.dayOfWeek).toBe(1);
    }
  });

  it('7) siguiente semana: el cutoff se recalcula en la repetición', () => {
    // Viernes 18 a las 14:00 ya cerró la salida del lunes 21 -> pasa al lunes 28
    const result = nextOf(resolveDepartureAvailability(MONDAY_ONLY_3D, at(SUN_0920_1400_BOG)));
    expect(result.skippedCivilDate).toBe('2026-09-21');
    expect(result.next.civilDate).toBe('2026-09-28');
  });

  it('18) varios días: una salida cerrada y la siguiente abierta', () => {
    // Sale lunes y miércoles; cutoff 1 día antes a las 14:00.
    const schedule = {
      departureDaysOfWeek: [1, 3],
      cutoffDaysBefore: 1,
      cutoffLocalTime: '14:00',
    };
    // Martes 15 a las 14:00 Bogotá = cutoff del miércoles 16 (ya cerrado).
    const result = nextOf(resolveDepartureAvailability(schedule, at(TUE_0915_1400_BOG)));
    expect(result.skippedCivilDate).toBe('2026-09-16');
    expect(result.next.civilDate).toBe('2026-09-21'); // el lunes siguiente
    expect(result.next.dayName).toBe('lunes');
    // su cutoff es el domingo 20 a las 14:00, todavía abierto en ese instante
    expect(result.cutoffAtUtc?.toISOString()).toBe(SUN_0920_1400_BOG);

    // Un segundo antes, el miércoles 16 seguía abierto.
    const before = nextOf(
      resolveDepartureAvailability(schedule, at('2026-09-15T18:59:59.000Z'))
    );
    expect(before.next.civilDate).toBe('2026-09-16');
    expect(before.skippedDeparture).toBe(false);
  });

  it('cutoff del mismo día (cutoffDaysBefore = 0)', () => {
    const schedule = {
      departureDaysOfWeek: [1],
      cutoffDaysBefore: 0,
      cutoffLocalTime: '08:00',
    };
    // Lunes 08:00 Bogotá = 13:00Z -> justo en el cutoff, cerrado
    const closed = nextOf(resolveDepartureAvailability(schedule, at('2026-09-14T13:00:00.000Z')));
    expect(closed.skippedCivilDate).toBe('2026-09-14');
    expect(closed.next.civilDate).toBe('2026-09-21');
    // Lunes 07:59 Bogotá = 12:59Z -> abierto
    const open = nextOf(resolveDepartureAvailability(schedule, at('2026-09-14T12:59:00.000Z')));
    expect(open.next.civilDate).toBe('2026-09-14');
    expect(open.next.daysUntil).toBe(0);
  });

  it('invariante: MAX_SEARCH_DAYS alcanza para encontrar la salida siguiente', () => {
    const worstCase = {
      departureDaysOfWeek: [1],
      cutoffDaysBefore: MAX_CUTOFF_DAYS_BEFORE,
      cutoffLocalTime: '23:59',
    };
    // Lunes 23:59:59 Bogotá (justo dentro del día de salida): el cutoff de hoy
    // (martes anterior 23:59) ya pasó -> debe saltar a la próxima semana.
    const result = resolveDepartureAvailability(worstCase, at(MON_0914_2359_BOG));
    expect(result.status).toBe('available');
    const available = nextOf(result);
    expect(available.next.civilDate).toBe('2026-09-21');
    expect(civilDiffDays({ year: 2026, month: 9, day: 14 }, { year: 2026, month: 9, day: 21 })).toBeLessThanOrEqual(
      MAX_SEARCH_DAYS
    );
    expect(buildRollForwardNotice('2026-09-14', 'lunes')).toContain('ya cerró');
  });
});

describe('route-schedule · sin cutoff (null + null)', () => {
  const NO_CUTOFF = { departureDaysOfWeek: [1], cutoffDaysBefore: null, cutoffLocalTime: null };

  it('10) sin cutoff la ruta siempre tiene una salida elegible', () => {
    const result = nextOf(resolveDepartureAvailability(NO_CUTOFF, at(MON_0914_1000_BOG)));
    expect(result.cutoffAtUtc).toBeNull();
    expect(result.hoursLeft).toBeNull();
    expect(result.skippedDeparture).toBe(false);
    expect(result.next.civilDate).toBe('2026-09-14');
    expect(result.next.daysUntil).toBe(0);
  });

  it('17) la salida de HOY sigue elegible TODO el día civil de Bogotá', () => {
    const early = nextOf(resolveDepartureAvailability(NO_CUTOFF, at(MON_0914_0000_BOG)));
    expect(early.next).toMatchObject({ civilDate: '2026-09-14', daysUntil: 0, isToday: true });

    const latest = nextOf(resolveDepartureAvailability(NO_CUTOFF, at(MON_0914_2359_BOG)));
    expect(latest.next).toMatchObject({ civilDate: '2026-09-14', daysUntil: 0, isToday: true });

    // Al cruzar la medianoche de Bogotá deja de ser HOY.
    const nextDay = nextOf(resolveDepartureAvailability(NO_CUTOFF, at(TUE_0915_0000_BOG)));
    expect(nextDay.next).toMatchObject({ civilDate: '2026-09-21', daysUntil: 6, isToday: false });
  });

  it('1) lunes únicamente: próxima salida para cada día de la semana', () => {
    const expectations: Array<[string, string]> = [
      // instante UTC                  fecha civil de salida esperada
      [MON_0914_1000_BOG, '2026-09-14'], // lunes -> hoy
      ['2026-09-15T15:00:00.000Z', '2026-09-21'], // martes
      ['2026-09-16T15:00:00.000Z', '2026-09-21'], // miércoles
      ['2026-09-17T15:00:00.000Z', '2026-09-21'], // jueves
      ['2026-09-18T15:00:00.000Z', '2026-09-21'], // viernes
      ['2026-09-19T15:00:00.000Z', '2026-09-21'], // sábado
      [SUN_0920_1400_BOG, '2026-09-21'], // domingo -> mañana
    ];
    for (const [iso, expected] of expectations) {
      const result = nextOf(resolveDepartureAvailability(NO_CUTOFF, at(iso)));
      expect(result.next.civilDate).toBe(expected);
      expect(result.next.dayName).toBe('lunes');
    }
  });

  it('2) lunes + miércoles: elige el más cercano en calendario civil', () => {
    const schedule = { departureDaysOfWeek: [1, 3] };
    const cases: Array<[string, string, string]> = [
      [MON_0914_1000_BOG, '2026-09-14', 'lunes'],
      ['2026-09-15T15:00:00.000Z', '2026-09-16', 'miércoles'],
      ['2026-09-16T15:00:00.000Z', '2026-09-16', 'miércoles'], // hoy
      ['2026-09-17T15:00:00.000Z', '2026-09-21', 'lunes'],
      [SUN_0920_1400_BOG, '2026-09-21', 'lunes'],
    ];
    for (const [iso, expectedDate, expectedName] of cases) {
      const result = nextOf(resolveDepartureAvailability(schedule, at(iso)));
      expect(result.next.civilDate).toBe(expectedDate);
      expect(result.next.dayName).toBe(expectedName);
    }
  });

  it('14) borde de medianoche Bogotá: 23:59:59 vs 00:00:00', () => {
    // Miércoles y viernes: así el lunes 23:59 NO es día de salida y el borde
    // de medianoche se ve en `daysUntil`, no enmascarado por un "hoy".
    const schedule = { departureDaysOfWeek: [3, 5] };
    const before = nextOf(resolveDepartureAvailability(schedule, at(MON_0914_2359_BOG)));
    const after = nextOf(resolveDepartureAvailability(schedule, at(TUE_0915_0000_BOG)));
    // A las 23:59 del lunes, el miércoles está a 2 días.
    expect(before.next).toMatchObject({ civilDate: '2026-09-16', daysUntil: 2 });
    // Un segundo después (ya es martes en Bogotá), sigue el miércoles pero a 1 día.
    expect(after.next).toMatchObject({ civilDate: '2026-09-16', daysUntil: 1 });
  });
});

describe('route-schedule · independencia del timezone del proceso', () => {
  const CASES = [
    { now: FRI_0911_1359_BOG, schedule: { departureDaysOfWeek: [1], cutoffDaysBefore: 3, cutoffLocalTime: '14:00' } },
    { now: FRI_0911_1400_BOG, schedule: { departureDaysOfWeek: [1], cutoffDaysBefore: 3, cutoffLocalTime: '14:00' } },
    { now: MON_0914_2359_BOG, schedule: { departureDaysOfWeek: [1, 3] } },
    { now: TUE_0915_0000_BOG, schedule: { departureDaysOfWeek: [1, 3] } },
    { now: TUE_0915_1400_BOG, schedule: { departureDaysOfWeek: [1, 3], cutoffDaysBefore: 1, cutoffLocalTime: '14:00' } },
  ];

  const moduleUrl = pathToFileURL(path.join(repoRoot, 'src', 'lib', 'route-schedule.ts')).href;

  const script = `
import { resolveDepartureAvailability } from ${JSON.stringify(moduleUrl)};
const cases = ${JSON.stringify(CASES)};
const out = cases.map((c) => JSON.stringify(resolveDepartureAvailability(c.schedule, new Date(c.now))));
console.log(out.join('\\n'));
`;

  function runWithTZ(tz: string): string[] {
    // Se escribe a un archivo temporal y se ejecuta con `bun` (el mismo runtime
    // de la suite): evita el quoting de shell y el límite de `-e`.
    // No se usa `process.execPath` porque bajo vitest apunta a node, que no
    // puede importar TypeScript en todas las versiones.
    const scriptFile = path.join(
      os.tmpdir(),
      `compusum-tz-${process.pid}-${tz.replace(/\W/g, '_')}.ts`
    );
    writeFileSync(scriptFile, script, 'utf8');
    // En Windows `bun` es un shim .cmd y necesita shell (con la ruta entre
    // comillas por si el tmpdir tiene espacios). En Linux/macOS se pasa la ruta
    // como argumento normal: con shell las comillas llegarían literales.
    const useShell = process.platform === 'win32';
    try {
      const res = spawnSync('bun', [useShell ? `"${scriptFile}"` : scriptFile], {
        cwd: repoRoot,
        env: { ...process.env, TZ: tz },
        encoding: 'utf8',
        shell: useShell,
      });
      if (res.status !== 0) {
        throw new Error(`subproceso falló (TZ=${tz}):\n${res.stderr}`);
      }
      return res.stdout.trim().split('\n');
    } finally {
      rmSync(scriptFile, { force: true });
    }
  }

  it('15) el MISMO instante da el MISMO resultado comercial en UTC, Bogotá y Madrid', () => {
    const utc = runWithTZ('UTC');
    const bogota = runWithTZ('America/Bogota');
    const madrid = runWithTZ('Europe/Madrid');

    expect(utc).toHaveLength(CASES.length);
    // El resultado comercial no puede depender del timezone del proceso.
    expect(bogota).toEqual(utc);
    expect(madrid).toEqual(utc);

    // Y además es el resultado correcto (no un empate en el error).
    const first = JSON.parse(utc[0]);
    expect(first.status).toBe('available');
    expect(first.next.civilDate).toBe('2026-09-14');
  }, 120000);

  it('el timezone elegido es realmente Bogotá (UTC-5) y no UTC', () => {
    // Si el helper ignorara BUSINESS_TIMEZONE y usara UTC, este instante
    // (04:59Z) contaría como día 15 y la salida del día sería otra.
    const result = nextOf(
      resolveDepartureAvailability({ departureDaysOfWeek: [1] }, at(MON_0914_2359_BOG))
    );
    expect(result.next.civilDate).toBe('2026-09-14');
    expect(result.next.dayName).toBe('lunes');
  });
});

describe('route-schedule · estabilidad estacional (Bogotá sin DST)', () => {
  it('16) enero y julio dan el MISMO desfase UTC-5', () => {
    const january = businessLocalToUtc({ year: 2026, month: 1, day: 15 }, '14:00');
    const july = businessLocalToUtc({ year: 2026, month: 7, day: 15 }, '14:00');
    expect(january.toISOString()).toBe('2026-01-15T19:00:00.000Z');
    expect(july.toISOString()).toBe('2026-07-15T19:00:00.000Z');

    // El mismo día de la semana se resuelve igual en ambos meses.
    for (const [month, day] of [
      [1, 15],
      [7, 15],
    ] as const) {
      const result = nextOf(
        resolveDepartureAvailability(
          { departureDaysOfWeek: [1] },
          businessLocalToUtc({ year: 2026, month, day }, '10:00')
        )
      );
      expect(result.next.dayOfWeek).toBe(1);
    }
  });

  it('la salida recurrente se mantiene correcta a lo largo de varios meses', () => {
    let instant = businessLocalToUtc({ year: 2026, month: 1, day: 5 }, '10:00');
    for (let i = 0; i < 24; i++) {
      const result = nextOf(
        resolveDepartureAvailability(
          { departureDaysOfWeek: [1], cutoffDaysBefore: 2, cutoffLocalTime: '14:00' },
          instant
        )
      );
      expect(result.next.dayOfWeek).toBe(1);
      expect(result.cutoffAtUtc!.getTime()).toBeLessThanOrEqual(instant.getTime() + 7 * 86_400_000);
      // avanza al menos un día para forzar el recorrido del año
      instant = new Date(instant.getTime() + 14 * 86_400_000);
    }
  });
});

describe('route-schedule · compatibilidad de getNextRouteDeparture', () => {
  it('ya no depende del timezone del proceso', () => {
    const result = getNextRouteDeparture(at(MON_0914_2359_BOG), [1]);
    expect(result.civilDate).toBe('2026-09-14');
    expect(result.daysUntilDeparture).toBe(0);
    expect(result.dayName).toBe('lunes');
    // nextDepartureDate = inicio (00:00 Bogotá) del día civil devuelto
    expect(result.nextDepartureDate.toISOString()).toBe(MON_0914_0000_BOG);
  });

  it('mantiene el contrato previo para los días válidos', () => {
    const result = getNextRouteDeparture(new Date('2026-09-15T15:00:00.000Z'), [1, 4]);
    expect(result.daysUntilDeparture).toBe(2); // martes -> jueves
    expect(result.dayName).toBe('jueves');
    expect(result.civilDate).toBe('2026-09-17');
  });

  it('lanza con días vacíos o inválidos', () => {
    expect(() => getNextRouteDeparture(at(MON_0914_1000_BOG), [])).toThrow();
    expect(() => getNextRouteDeparture(at(MON_0914_1000_BOG), [9])).toThrow();
  });
});
