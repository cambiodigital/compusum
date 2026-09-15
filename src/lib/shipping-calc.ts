import { db } from './db';
import {
  resolveDepartureAvailability,
  buildRouteMessage,
  buildRollForwardNotice,
  type RouteScheduleInput,
} from './route-schedule';

/**
 * Estimación de envío para una ciudad (Fase 5B1).
 *
 * La disponibilidad sale EXCLUSIVAMENTE del helper central
 * `resolveDepartureAvailability`, que evalúa el cutoff RECURRENTE en el
 * calendario de America/Bogota. El timestamp legacy `cutOffTime` NO participa:
 * un cutoff absoluto vencido ya no puede cerrar una ruta semanal.
 *
 * Estados:
 *   - ciudad inexistente / sin ruta / ruta inactiva => unavailable;
 *   - schedule inválido o incompleto             => misconfigured;
 *   - schedule válido => available con la PRIMERA salida elegible (roll-forward:
 *     si el cutoff de la más próxima ya cerró, avanza a la siguiente).
 */
export async function getShippingEstimation(cityId: string, now: Date = new Date()) {
  // Busca la ruta activa asignada a esta ciudad
  const city = await db.city.findUnique({
    where: { id: cityId },
    include: {
      shippingRoute: true,
    },
  });

  if (!city || !city.shippingRoute || !city.shippingRoute.isActive) {
    return {
      status: 'unavailable' as const,
      message: 'Actualmente no tenemos rutas programadas para esta ciudad. Te contactaremos pronto.',
    };
  }

  const route = city.shippingRoute;

  const schedule: RouteScheduleInput = {
    departureDaysOfWeek: route.departureDaysOfWeek,
    cutoffDaysBefore: route.cutoffDaysBefore,
    cutoffLocalTime: route.cutoffLocalTime,
  };

  const availability = resolveDepartureAvailability(schedule, now);

  if (availability.status === 'misconfigured') {
    // Configuración inválida/no resoluble: es un problema de la ruta, no del
    // cliente. No se cae al cutoff legacy ni se adivina.
    return {
      status: 'misconfigured' as const,
      reason: availability.reason,
      routeId: route.id,
      routeName: route.name,
      message: 'Esta ruta no tiene una programación válida. Contáctanos para confirmar tu envío.',
    };
  }

  const { next, cutoffAtUtc, hoursLeft, skippedDeparture, skippedCivilDate } = availability;

  const parts = [
    buildRouteMessage(
      next.daysUntil,
      next.dayName,
      route.estimatedDaysMin,
      route.estimatedDaysMax
    ),
  ];
  if (skippedDeparture && skippedCivilDate) {
    parts.unshift(buildRollForwardNotice(skippedCivilDate, next.dayName));
  }

  return {
    status: 'available' as const,
    routeId: route.id,
    routeName: route.name,
    message: parts.join(' '),
    /** Fecha civil de salida (`YYYY-MM-DD` en America/Bogota) — estable para UI. */
    nextDepartureCivilDate: next.civilDate,
    nextDepartureDayOfWeek: next.dayOfWeek,
    nextDepartureDayName: next.dayName,
    daysUntilDeparture: next.daysUntil,
    hoursLeft,
    /** Instante UTC del cutoff efectivo, o null si la ruta no tiene cutoff. */
    effectiveCutoffAt: cutoffAtUtc,
    skippedDeparture,
    skippedCivilDate,
    timezone: 'America/Bogota' as const,
  };
}
