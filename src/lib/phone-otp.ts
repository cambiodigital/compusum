/**
 * Constantes del OTP por TELÉFONO.
 *
 * LONGITUD EN TRANSICIÓN (4 → 6): el servicio Twilio Verify define la
 * longitud real del código (propiedad CodeLength). El estándar de la app pasa
 * a 6 dígitos (UI y mock por defecto); la verificación local (src/lib/
 * auth-dual.ts) acepta 4–8 dígitos durante la transición hasta que el
 * servicio Twilio se actualice a CodeLength=6 (paso de despliegue documentado
 * en .env.example y la tarea ClickUp).
 */
export const PHONE_OTP_LENGTH = 6;
/** Rango aceptado en verificación durante la transición Twilio 4 → 6. */
export const PHONE_OTP_MIN_LENGTH = 4;
export const PHONE_OTP_MAX_LENGTH = 8;
export const DEFAULT_MOCK_PHONE_OTP = '123456';
