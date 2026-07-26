import { addDays, format } from 'date-fns';

/**
 * Calcula el próximo día de la semana disponible para una ruta
 * @param now Fecha/hora actual
 * @param departureDaysOfWeek Array de días de semana (0=domingo...6=sábado)
 * @returns { nextDepartureDate, daysUntilDeparture, dayName }
 */
export function getNextRouteDeparture(now: Date, departureDaysOfWeek: number[]) {
  if (!departureDaysOfWeek || departureDaysOfWeek.length === 0) {
    throw new Error('departureDaysOfWeek must have at least one day');
  }

  const currentDayOfWeek = now.getDay();
  const sortedDays = [...departureDaysOfWeek].sort((a, b) => a - b);

  let nextDepartureDate: Date | null = null;
  let daysUntilDeparture = 0;

  // Busca un día de salida en esta semana (incluyendo hoy o después)
  for (const day of sortedDays) {
    if (day >= currentDayOfWeek) {
      daysUntilDeparture = day - currentDayOfWeek;
      nextDepartureDate = addDays(now, daysUntilDeparture);
      break;
    }
  }

  // Si no encontró un día en esta semana, usa el primer día de la próxima
  if (!nextDepartureDate) {
    const firstDayNextWeek = sortedDays[0];
    daysUntilDeparture = 7 - currentDayOfWeek + firstDayNextWeek;
    nextDepartureDate = addDays(now, daysUntilDeparture);
  }

  // Reset a medianoche para consistencia
  nextDepartureDate.setHours(0, 0, 0, 0);

  return {
    nextDepartureDate,
    daysUntilDeparture,
    dayName: getDayNameSpanish(nextDepartureDate.getDay()),
  };
}

/**
 * Convierte número de día de semana a nombre en español
 * @param dayOfWeek 0=domingo...6=sábado
 */
export function getDayNameSpanish(dayOfWeek: number): string {
  const days = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  return days[dayOfWeek] || 'desconocido';
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
