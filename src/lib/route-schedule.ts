/**
 * FUENTE TEMPORAL ÚNICA (Fase 5B1) — ruta + próxima salida + cutoff + disponibilidad.
 *
 * Toda la aritmética de calendario se hace en el calendario CIVIL de
 * `BUSINESS_TIMEZONE` (America/Bogota) y se convierte a instantes UTC de forma
 * explícita con `Intl.DateTimeFormat`. Nada aquí depende de:
 *
 *   - `Date.getDay()` / `getHours()` / `setHours()` locales;
 *   - el timezone del navegador;
 *   - el timezone del proceso Node;
 *   - el timezone del contenedor (TZ);
 *   - el timezone de sesión de PostgreSQL.
 *
 * `now` SIEMPRE es inyectable: ningún helper puro lee el reloj real.
 *
 * SEMÁNTICA DEL CUTOFF RECURRENTE
 *   El cutoff pertenece uniformemente a CADA salida de la ruta:
 *     cutoff(salida D) = (D - cutoffDaysBefore días) a las cutoffLocalTime
 *   Una salida es elegible mientras `now < cutoff(D)`; exactamente en el
 *   cutoff ya está cerrada.
 *
 *   Sin cutoff (ambos campos null) la ruta no tiene corte: la primera salida
 *   programada es elegible, y como el sistema NO modela hora de salida, un día
 *   programado como salida sigue elegible durante TODO su día civil en Bogotá.
 *
 * ROLL-FORWARD
 *   Si el cutoff de la salida más próxima ya cerró, se descarta y se busca la
 *   SIGUIENTE salida recurrente cuyo cutoff siga abierto. La ruta nunca queda
 *   "cerrada para siempre" por un cutoff que ya pasó.
 */

export const BUSINESS_TIMEZONE = 'America/Bogota';

/** `cutoffDaysBefore` válido: entero 0–6. */
export const MAX_CUTOFF_DAYS_BEFORE = 6;

/**
 * Ventana de búsqueda en días civiles. Invariante de suficiencia: si la
 * primera salida candidata D0 tiene el cutoff cerrado, su repetición semanal
 * D0+7 tiene cutoff = D0+7-cutoffDaysBefore >= D0+1 > now, es decir está
 * abierta. Como D0 <= hoy+7, entonces D0+7 <= hoy+14: la ventana de 14 días
 * siempre contiene al menos una salida elegible para un schedule válido.
 */
export const MAX_SEARCH_DAYS = 14;

const DAY_NAMES_ES = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
] as const;

// =====================
// CALENDARIO CIVIL
// =====================

/** Fecha civil (sin hora ni zona). `month` va de 1 a 12. */
export interface CivilDate {
  year: number;
  month: number;
  day: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      // h23 evita el "24" que algunos ICU devuelven para medianoche.
      hourCycle: 'h23',
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

interface ZonedParts extends CivilDate {
  hour: number;
  minute: number;
  second: number;
}

/** Lectura de un instante en el calendario civil de `timeZone`. */
function zonedParts(instant: Date, timeZone: string): ZonedParts {
  const parts = formatterFor(timeZone).formatToParts(instant);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const found = parts.find((part) => part.type === type);
    return found ? Number(found.value) : 0;
  };
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: read('hour'),
    minute: read('minute'),
    second: read('second'),
  };
}

/** Desfase de `timeZone` respecto a UTC en el instante dado, en ms. */
function zoneOffsetMs(instant: Date, timeZone: string): number {
  const parts = zonedParts(instant, timeZone);
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second
  );
  // formatToParts no expone milisegundos: se trunca para comparar peras con peras.
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/** Fecha civil de un instante, leída en el calendario de negocio. */
export function toBusinessCivilDate(instant: Date): CivilDate {
  const parts = zonedParts(instant, BUSINESS_TIMEZONE);
  return { year: parts.year, month: parts.month, day: parts.day };
}

/** Convierte una hora local de negocio (`HH:mm`) en el instante UTC real. */
export function businessLocalToUtc(civil: CivilDate, hhmm: string): Date {
  const [hour, minute] = hhmm.split(':').map(Number);
  const guess = Date.UTC(civil.year, civil.month - 1, civil.day, hour, minute, 0, 0);
  // Dos pasadas: la segunda cubre un cambio de offset en el borde exacto.
  const firstOffset = zoneOffsetMs(new Date(guess), BUSINESS_TIMEZONE);
  let timestamp = guess - firstOffset;
  const secondOffset = zoneOffsetMs(new Date(timestamp), BUSINESS_TIMEZONE);
  if (secondOffset !== firstOffset) timestamp = guess - secondOffset;
  return new Date(timestamp);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** `YYYY-MM-DD` — representación civil estable para UI/API. */
export function formatCivilDate(civil: CivilDate): string {
  return `${civil.year}-${pad(civil.month)}-${pad(civil.day)}`;
}

/** Aritmética de días sobre fecha civil, anclada a UTC (sin DST ni locale). */
export function addCivilDays(civil: CivilDate, days: number): CivilDate {
  const shifted = new Date(Date.UTC(civil.year, civil.month - 1, civil.day + days));
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
  };
}

/** Día de la semana (0=domingo…6=sábado) de una fecha civil. */
export function civilDayOfWeek(civil: CivilDate): number {
  return new Date(Date.UTC(civil.year, civil.month - 1, civil.day)).getUTCDay();
}

/** Días civiles de `from` a `to` (positivo si `to` es posterior). */
export function civilDiffDays(from: CivilDate, to: CivilDate): number {
  const a = Date.UTC(from.year, from.month - 1, from.day);
  const b = Date.UTC(to.year, to.month - 1, to.day);
  return Math.round((b - a) / 86_400_000);
}

/** Convierte número de día de semana a nombre en español */
export function getDayNameSpanish(dayOfWeek: number): string {
  return DAY_NAMES_ES[dayOfWeek] || 'desconocido';
}

// =====================
// VALIDACIÓN DEL SCHEDULE
// =====================

export type ScheduleConfigError =
  | 'empty_days'
  | 'invalid_days'
  | 'partial_cutoff'
  | 'invalid_cutoff_days'
  | 'invalid_cutoff_time'
  | 'no_departure_in_window';

export interface RouteScheduleInput {
  departureDaysOfWeek?: number[] | null;
  cutoffDaysBefore?: number | null;
  cutoffLocalTime?: string | null;
}

export type ValidatedSchedule =
  | { ok: true; days: number[]; cutoffDaysBefore: number | null; cutoffLocalTime: string | null }
  | { ok: false; reason: ScheduleConfigError };

const CUTOFF_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * Contrato de configuración (Fase 5B1):
 *   - `departureDaysOfWeek`: al menos un día, sólo enteros 0–6;
 *   - `cutoffDaysBefore`: null, o entero 0–6;
 *   - `cutoffLocalTime`: null, o `HH:mm` real (00:00–23:59);
 *   - cutoff válido = ambos null, o ambos presentes y válidos.
 * Cualquier otro estado es `misconfigured`: no se adivina ni se cae al cutoff
 * legacy `cutOffTime`.
 */
export function validateRouteSchedule(schedule: RouteScheduleInput): ValidatedSchedule {
  const rawDays = schedule.departureDaysOfWeek;
  if (!rawDays || rawDays.length === 0) {
    return { ok: false, reason: 'empty_days' };
  }
  if (rawDays.some((day) => !Number.isInteger(day) || day < 0 || day > 6)) {
    return { ok: false, reason: 'invalid_days' };
  }
  const days = [...new Set(rawDays)].sort((a, b) => a - b);

  const rawDaysBefore = schedule.cutoffDaysBefore;
  const rawLocalTime = schedule.cutoffLocalTime;
  const hasDaysBefore = rawDaysBefore !== null && rawDaysBefore !== undefined;
  const hasLocalTime =
    rawLocalTime !== null && rawLocalTime !== undefined && String(rawLocalTime).trim() !== '';

  if (!hasDaysBefore && !hasLocalTime) {
    return { ok: true, days, cutoffDaysBefore: null, cutoffLocalTime: null };
  }

  if (hasDaysBefore !== hasLocalTime) {
    return { ok: false, reason: 'partial_cutoff' };
  }

  if (
    !Number.isInteger(rawDaysBefore) ||
    (rawDaysBefore as number) < 0 ||
    (rawDaysBefore as number) > MAX_CUTOFF_DAYS_BEFORE
  ) {
    return { ok: false, reason: 'invalid_cutoff_days' };
  }

  const localTime = String(rawLocalTime).trim();
  if (!CUTOFF_TIME_PATTERN.test(localTime)) {
    return { ok: false, reason: 'invalid_cutoff_time' };
  }

  return {
    ok: true,
    days,
    cutoffDaysBefore: rawDaysBefore as number,
    cutoffLocalTime: localTime,
  };
}

// =====================
// RESOLUCIÓN DE DISPONIBILIDAD
// =====================

export interface DepartureWindow {
  /** `YYYY-MM-DD` en el calendario civil de America/Bogota. */
  civilDate: string;
  dayOfWeek: number;
  /** Día de la semana en español (con acentos). */
  dayName: string;
  /** Días civiles desde hoy hasta la salida (0 = HOY). */
  daysUntil: number;
  isToday: boolean;
}

export type DepartureAvailability =
  | {
      status: 'available';
      next: DepartureWindow;
      /** Instante UTC del cutoff efectivo, o null si la ruta no tiene cutoff. */
      cutoffAtUtc: Date | null;
      hoursLeft: number | null;
      /** true si la salida programada más próxima se descartó por cutoff cerrado. */
      skippedDeparture: boolean;
      /** Fecha civil (`YYYY-MM-DD`) de la salida descartada más próxima. */
      skippedCivilDate: string | null;
    }
  | { status: 'misconfigured'; reason: ScheduleConfigError };

/** Instante UTC del cutoff de una salida concreta (null si no hay cutoff). */
export function cutoffForDeparture(
  departure: CivilDate,
  cutoffDaysBefore: number | null,
  cutoffLocalTime: string | null
): Date | null {
  if (cutoffDaysBefore === null || cutoffLocalTime === null) return null;
  return businessLocalToUtc(addCivilDays(departure, -cutoffDaysBefore), cutoffLocalTime);
}

/**
 * ÚNICA fuente de verdad: ruta + ahora + calendario de negocio ⇒ próxima
 * salida elegible, cutoff efectivo y disponibilidad.
 *
 * Roll-forward: devuelve la PRIMERA salida cuyo `now < cutoff`; si la más
 * próxima ya cerró, continúa con la siguiente (nunca "cerrado para siempre").
 */
export function resolveDepartureAvailability(
  schedule: RouteScheduleInput,
  now: Date
): DepartureAvailability {
  const validated = validateRouteSchedule(schedule);
  if (!validated.ok) {
    return { status: 'misconfigured', reason: validated.reason };
  }

  const { days, cutoffDaysBefore, cutoffLocalTime } = validated;
  const today = toBusinessCivilDate(now);
  const nowMs = now.getTime();

  let skippedCivilDate: string | null = null;

  for (let offset = 0; offset <= MAX_SEARCH_DAYS; offset++) {
    const candidate = addCivilDays(today, offset);
    if (!days.includes(civilDayOfWeek(candidate))) continue;

    const cutoffAtUtc = cutoffForDeparture(candidate, cutoffDaysBefore, cutoffLocalTime);
    // Sin cutoff la salida es elegible; con cutoff, sólo mientras now < cutoff.
    const isOpen = !cutoffAtUtc || nowMs < cutoffAtUtc.getTime();

    if (isOpen) {
      const daysUntil = civilDiffDays(today, candidate);
      return {
        status: 'available',
        next: {
          civilDate: formatCivilDate(candidate),
          dayOfWeek: civilDayOfWeek(candidate),
          dayName: getDayNameSpanish(civilDayOfWeek(candidate)),
          daysUntil,
          isToday: daysUntil === 0,
        },
        cutoffAtUtc,
        hoursLeft:
          cutoffAtUtc === null
            ? null
            : Math.max(0, Math.floor((cutoffAtUtc.getTime() - nowMs) / 3_600_000)),
        skippedDeparture: skippedCivilDate !== null,
        skippedCivilDate,
      };
    }

    if (skippedCivilDate === null) {
      skippedCivilDate = formatCivilDate(candidate);
    }
  }

  // Inalcanzable para un schedule válido (ver invariante de MAX_SEARCH_DAYS);
  // se trata como configuración no resoluble en vez de bloquear la ruta.
  return { status: 'misconfigured', reason: 'no_departure_in_window' };
}

// =====================
// COMPATIBILIDAD
// =====================

/**
 * Próxima salida por día de semana, SIN evaluar cutoff.
 *
 * Se conserva por compatibilidad con los llamadores existentes. A diferencia
 * de la versión anterior, ya NO usa el timezone del proceso: el día de la
 * semana y la fecha se calculan en America/Bogota.
 *
 * `nextDepartureDate` es el instante UTC de las 00:00 en America/Bogota del
 * `civilDate` devuelto (representa el INICIO del día civil de salida, no una
 * hora de salida — el sistema no modela hora de salida). Para UI/API usar
 * `civilDate`, que es estable e inequívoco.
 */
export function getNextRouteDeparture(now: Date, departureDaysOfWeek: number[]) {
  const validated = validateRouteSchedule({ departureDaysOfWeek });
  if (!validated.ok) {
    throw new Error('departureDaysOfWeek must have at least one valid day (0-6)');
  }

  const today = toBusinessCivilDate(now);
  let offset = 0;
  while (offset <= 7 && !validated.days.includes(civilDayOfWeek(addCivilDays(today, offset)))) {
    offset++;
  }
  const departure = addCivilDays(today, offset);

  return {
    civilDate: formatCivilDate(departure),
    nextDepartureDate: businessLocalToUtc(departure, '00:00'),
    daysUntilDeparture: civilDiffDays(today, departure),
    dayName: getDayNameSpanish(civilDayOfWeek(departure)),
  };
}

/**
 * Genera un mensaje legible para el cliente
 * @param daysUntilDeparture Días hasta que salga la ruta
 * @param dayName Nombre del día en español
 * @param estimatedDaysMin Días mínimos de entrega
 * @param estimatedDaysMax Días máximos de entrega
 */
export function buildRouteMessage(
  daysUntilDeparture: number,
  dayName: string,
  estimatedDaysMin: number,
  estimatedDaysMax: number
): string {
  const departureText = getDepartureText(daysUntilDeparture, dayName);

  let deliveryText = '';
  if (estimatedDaysMin === estimatedDaysMax) {
    deliveryText = `Recibirás tu pedido en ${estimatedDaysMin} día${estimatedDaysMin !== 1 ? 's' : ''} desde la salida.`;
  } else {
    deliveryText = `Recibirás tu pedido entre ${estimatedDaysMin} y ${estimatedDaysMax} días desde la salida.`;
  }

  return `${departureText} ${deliveryText}`;
}

/**
 * Texto de salida con días contados
 */
function getDepartureText(daysUntilDeparture: number, dayName: string): string {
  if (daysUntilDeparture === 0) {
    return `✓ La ruta sale HOY (${dayName}).`;
  } else if (daysUntilDeparture === 1) {
    return `La ruta sale mañana (${dayName}), en 1 día.`;
  } else {
    return `La ruta sale el próximo ${dayName}, en ${daysUntilDeparture} días.`;
  }
}

/**
 * Aviso para cuando el cutoff de la salida más próxima ya cerró y el pedido
 * avanza automáticamente a la siguiente salida recurrente.
 */
export function buildRollForwardNotice(skippedCivilDate: string, dayName: string): string {
  return (
    `El corte de la salida más próxima (${skippedCivilDate}) ya cerró. ` +
    `Tu pedido viajará en la próxima salida (${dayName}).`
  );
}
