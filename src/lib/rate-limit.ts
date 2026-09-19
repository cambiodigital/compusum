import { db } from '@/lib/db';

export const ADMIN_LOGIN_MAX_ATTEMPTS = 5;
export const ADMIN_LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutos
export const ADMIN_LOGIN_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutos de bloqueo

// ============================================================================
// POLÍTICA DE FORGOT-PASSWORD (elegida explícitamente, NO accidental):
//   - Por IP: 5 solicitudes por ventana de 15 min; bloqueo de 30 min.
//   - Por identidad (teléfono canónico o email en minúsculas): 5 solicitudes
//     por ventana de 15 min; bloqueo de 30 min.
// `checkRateLimit` y `recordFailedAttempt` deben recibir EXACTAMENTE estos
// mismos valores por cubeta: un desajuste (p.ej. check 5 / record 20) hace que
// el bloqueo ocurra de forma accidental e incoherente con lo reportado.
// ============================================================================
export const FORGOT_IP_MAX_ATTEMPTS = 5;
export const FORGOT_ID_MAX_ATTEMPTS = 5;
export const FORGOT_WINDOW_MS = 15 * 60 * 1000; // 15 minutos
export const FORGOT_LOCKOUT_MS = 30 * 60 * 1000; // 30 minutos de bloqueo

// ============================================================================
// POLÍTICA OTP UNIFICADA (envío y verificación de códigos temporales).
//   - Envío por IP: 10 solicitudes / 15 min; bloqueo 30 min.
//   - Envío por identidad (email normalizado o teléfono canónico): 5 / 15 min;
//     bloqueo 30 min. El cooldown fino (60 s por identidad) lo aplica además
//     el desafío OTP de email (updatedAt/createdAt del challenge).
//   - Verificación por IP: 10 intentos / 15 min; bloqueo 15 min. Por identidad
//     el límite fino lo impone el propio desafío (5 intentos) o el proveedor
//     (Twilio Verify).
// ============================================================================
export const OTP_SEND_IP_MAX_ATTEMPTS = 10;
export const OTP_SEND_ID_MAX_ATTEMPTS = 5;
export const OTP_SEND_WINDOW_MS = 15 * 60 * 1000; // 15 minutos
export const OTP_SEND_LOCKOUT_MS = 30 * 60 * 1000; // 30 minutos de bloqueo
export const OTP_VERIFY_IP_MAX_ATTEMPTS = 10;
export const OTP_VERIFY_ID_MAX_ATTEMPTS = 10;
export const OTP_VERIFY_WINDOW_MS = 15 * 60 * 1000; // 15 minutos
export const OTP_VERIFY_LOCKOUT_MS = 15 * 60 * 1000; // 15 minutos de bloqueo

export interface RateLimitCheckResult {
  isBlocked: boolean;
  remainingAttempts: number;
  blockedUntil?: Date;
  retryAfterSeconds?: number;
}

type MemoryEntry = {
  attempts: number;
  firstAttempt: Date;
  blockedUntil?: Date;
};

// Fallback en memoria si la DB no está disponible
const globalForMemoryStore = globalThis as typeof globalThis & {
  __rateLimitMemoryStore?: Map<string, MemoryEntry>;
};

const memoryStore =
  globalForMemoryStore.__rateLimitMemoryStore ?? new Map<string, MemoryEntry>();
globalForMemoryStore.__rateLimitMemoryStore = memoryStore;

/**
 * Obtiene la dirección IP del cliente desde los encabezados HTTP de la solicitud.
 */
export function getClientIp(req: Request): string {
  const forwardedFor = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim();
  const realIp = req.headers.get('x-real-ip')?.trim();
  const candidate = forwardedFor || realIp || '127.0.0.1';
  return candidate;
}

function checkMemoryStore(
  key: string,
  now: Date,
  maxAttempts: number,
  windowMs: number
): RateLimitCheckResult {
  const record = memoryStore.get(key);
  if (!record) {
    return { isBlocked: false, remainingAttempts: maxAttempts };
  }

  if (record.blockedUntil && record.blockedUntil > now) {
    const retryAfterSeconds = Math.ceil((record.blockedUntil.getTime() - now.getTime()) / 1000);
    return {
      isBlocked: true,
      remainingAttempts: 0,
      blockedUntil: record.blockedUntil,
      retryAfterSeconds,
    };
  }

  const elapsedMs = now.getTime() - record.firstAttempt.getTime();
  if (elapsedMs > windowMs) {
    memoryStore.delete(key);
    return { isBlocked: false, remainingAttempts: maxAttempts };
  }

  if (record.attempts >= maxAttempts) {
    const blockedUntil = record.blockedUntil || new Date(now.getTime() + ADMIN_LOGIN_LOCKOUT_MS);
    const retryAfterSeconds = Math.ceil((blockedUntil.getTime() - now.getTime()) / 1000);
    return {
      isBlocked: true,
      remainingAttempts: 0,
      blockedUntil,
      retryAfterSeconds,
    };
  }

  return {
    isBlocked: false,
    remainingAttempts: Math.max(0, maxAttempts - record.attempts),
  };
}

function recordMemoryStore(
  key: string,
  now: Date,
  maxAttempts: number,
  windowMs: number,
  lockoutMs: number
): RateLimitCheckResult {
  const existing = memoryStore.get(key);
  let attempts = 1;
  let firstAttempt = now;
  let blockedUntil: Date | undefined = undefined;

  if (existing) {
    const elapsedMs = now.getTime() - existing.firstAttempt.getTime();
    if (elapsedMs > windowMs || (existing.blockedUntil && existing.blockedUntil <= now)) {
      attempts = 1;
      firstAttempt = now;
    } else {
      attempts = existing.attempts + 1;
      firstAttempt = existing.firstAttempt;
    }
  }

  if (attempts >= maxAttempts) {
    blockedUntil = new Date(now.getTime() + lockoutMs);
  }

  memoryStore.set(key, { attempts, firstAttempt, blockedUntil });

  const isBlocked = attempts >= maxAttempts;
  const retryAfterSeconds = blockedUntil
    ? Math.ceil((blockedUntil.getTime() - now.getTime()) / 1000)
    : undefined;

  return {
    isBlocked,
    remainingAttempts: Math.max(0, maxAttempts - attempts),
    blockedUntil,
    retryAfterSeconds,
  };
}

/**
 * Verifica si una clave (IP o Email) está bloqueada por exceder los intentos permitidos.
 */
export async function checkRateLimit(
  key: string,
  maxAttempts: number = ADMIN_LOGIN_MAX_ATTEMPTS,
  windowMs: number = ADMIN_LOGIN_WINDOW_MS
): Promise<RateLimitCheckResult> {
  const now = new Date();

  try {
    const record = await db.rateLimit.findUnique({
      where: { key },
    });

    if (!record) {
      return checkMemoryStore(key, now, maxAttempts, windowMs);
    }

    if (record.blockedUntil && record.blockedUntil > now) {
      const retryAfterSeconds = Math.ceil((record.blockedUntil.getTime() - now.getTime()) / 1000);
      console.warn(
        `[RATE_LIMIT_BLOCKED] Intento bloqueado para clave: ${key}. Bloqueado hasta: ${record.blockedUntil.toISOString()} (Reintentar en ${retryAfterSeconds}s)`
      );
      return {
        isBlocked: true,
        remainingAttempts: 0,
        blockedUntil: record.blockedUntil,
        retryAfterSeconds,
      };
    }

    const elapsedMs = now.getTime() - record.firstAttempt.getTime();
    if (elapsedMs > windowMs) {
      return {
        isBlocked: false,
        remainingAttempts: maxAttempts,
      };
    }

    if (record.attempts >= maxAttempts) {
      const blockedUntil = record.blockedUntil || new Date(now.getTime() + ADMIN_LOGIN_LOCKOUT_MS);
      const retryAfterSeconds = Math.ceil((blockedUntil.getTime() - now.getTime()) / 1000);
      return {
        isBlocked: true,
        remainingAttempts: 0,
        blockedUntil,
        retryAfterSeconds,
      };
    }

    return {
      isBlocked: false,
      remainingAttempts: Math.max(0, maxAttempts - record.attempts),
    };
  } catch (_error) {
    return checkMemoryStore(key, now, maxAttempts, windowMs);
  }
}

/**
 * Registra un intento fallido y actualiza/crea el registro en DB (o memoria de respaldo).
 */
export async function recordFailedAttempt(
  key: string,
  maxAttempts: number = ADMIN_LOGIN_MAX_ATTEMPTS,
  windowMs: number = ADMIN_LOGIN_WINDOW_MS,
  lockoutMs: number = ADMIN_LOGIN_LOCKOUT_MS
): Promise<RateLimitCheckResult> {
  const now = new Date();

  try {
    const record = await db.rateLimit.findUnique({
      where: { key },
    });

    let attempts = 1;
    let firstAttempt = now;
    let blockedUntil: Date | undefined = undefined;

    if (record) {
      const elapsedMs = now.getTime() - record.firstAttempt.getTime();
      if (elapsedMs > windowMs || (record.blockedUntil && record.blockedUntil <= now)) {
        attempts = 1;
        firstAttempt = now;
      } else {
        attempts = record.attempts + 1;
        firstAttempt = record.firstAttempt;
      }
    }

    if (attempts >= maxAttempts) {
      blockedUntil = new Date(now.getTime() + lockoutMs);
      console.warn(
        `[RATE_LIMIT_EXCEEDED] Umbral alcanzado para clave: ${key}. Intentos: ${attempts}. Bloqueado hasta: ${blockedUntil.toISOString()}`
      );
    } else {
      console.warn(
        `[AUTH_FAILED_ATTEMPT] Intento fallido para clave: ${key}. Intentos acumulados: ${attempts}/${maxAttempts}`
      );
    }

    const updated = await db.rateLimit.upsert({
      where: { key },
      create: {
        key,
        attempts,
        firstAttempt,
        blockedUntil,
      },
      update: {
        attempts,
        firstAttempt,
        blockedUntil,
      },
    });

    memoryStore.set(key, { attempts, firstAttempt, blockedUntil: updated.blockedUntil ?? undefined });

    const isBlocked = attempts >= maxAttempts;
    const retryAfterSeconds = blockedUntil
      ? Math.ceil((blockedUntil.getTime() - now.getTime()) / 1000)
      : undefined;

    return {
      isBlocked,
      remainingAttempts: Math.max(0, maxAttempts - attempts),
      blockedUntil: updated.blockedUntil ?? undefined,
      retryAfterSeconds,
    };
  } catch (_error) {
    return recordMemoryStore(key, now, maxAttempts, windowMs, lockoutMs);
  }
}

/**
 * Resetea el contador de intentos cuando el inicio de sesión es exitoso.
 */
export async function resetRateLimit(key: string): Promise<void> {
  memoryStore.delete(key);
  try {
    await db.rateLimit.deleteMany({
      where: { key },
    });
  } catch (_error) {
    // Eliminación en memoria de respaldo completada
  }
}
