import { db } from './db';
import { verifyPassword, createSession } from './auth';
import { canonicalColombiaPhone, phoneOrVariants } from './phone';
import { requireAuthUserDTO, AuthUserDTO } from './user-dto';
import { isAdminRole, isBackofficeRole, isAgentRole } from './roles';
import {
  issueEmailOtp,
  verifyEmailOtp,
  isEmailOtpConfigured,
  EmailOtpError,
} from './email-otp';
import { sendPhoneOtp, verifyPhoneOtp } from './auth-dual';

// Re-export: las rutas de OTP consumen EmailOtpError a través de este módulo.
export { EmailOtpError };

/**
 * AUTENTICACIÓN UNIFICADA (maestro `User`, cualquier rol).
 *
 * UN solo punto de entrada `/ingresar` para CUSTOMER, admin, editor y AGENT:
 *  - Contraseña: email o teléfono + password (búsqueda centralizada aquí, no
 *    "primero CUSTOMER y luego admin").
 *  - Código temporal: email -> OTP self-managed por Resend (6 dígitos);
 *    teléfono -> SMS vía Twilio Verify (fallback/canal alternativo).
 *
 * Garantías:
 *  - Solo roles conocidos pueden autenticar (admin, editor, AGENT, CUSTOMER);
 *    cualquier otro valor se rechaza con error genérico (fail-closed).
 *  - Anti-enumeración: credenciales/código inválidos producen SIEMPRE el mismo
 *    mensaje genérico, y la comparación de contraseña se ejecuta también
 *    contra un hash dummy cuando la cuenta no existe (tiempo plano).
 *  - El destino post-login se calcula EN EL SERVIDOR (`redirectTo`); el
 *    parámetro `next` solo se acepta si es una ruta interna permitida para el
 *    rol autenticado (nunca open redirect).
 *  - El aislamiento del rol AGENT no cambia aquí: autenticar no otorga
 *    permisos; el RBAC por página/API y la allowlist del proxy siguen mandando.
 */

export type OtpChannel = 'email' | 'sms';
export type OtpPurpose = 'login' | 'password_reset';

export class UnifiedAuthError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'UnifiedAuthError';
    this.code = code;
  }
}

/** Mensaje EXTERNO único para credenciales inválidas (anti-enumeración). */
export const GENERIC_LOGIN_FAILURE = 'Credenciales inválidas';
/** Mensaje EXTERNO único para códigos OTP inválidos/expirados. */
export const GENERIC_OTP_FAILURE = 'Código inválido o expirado';
/** Mensaje EXTERNO para cuentas desactivadas (solo se revela a quien ya
 *  demostró poseer las credenciales/código: no es enumeración). */
export const INACTIVE_ACCOUNT_MESSAGE =
  'Tu cuenta está desactivada. Contacta a tu asesor comercial.';

const KNOWN_ROLES = ['customer', 'admin', 'editor', 'agent'];

export function isKnownUserRole(role?: string | null): boolean {
  if (!role) return false;
  return KNOWN_ROLES.includes(role.trim().toLowerCase());
}

export function normalizeIdentifier(identifier: string): { email: string | null; phone: string | null } {
  const raw = identifier?.trim().toLowerCase() ?? '';
  if (!raw) return { email: null, phone: null };

  if (raw.includes('@')) {
    // Email: validación de forma mínima; la unicidad hace el resto.
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw) ? raw : null;
    return { email, phone: null };
  }

  const phone = canonicalColombiaPhone(raw);
  return { email: null, phone };
}

/**
 * Búsqueda centralizada en el maestro `User` (CUALQUIER rol conocido):
 * email por unique; teléfono por variantes canónicas (determinista:
 * canónico `57...` primero, legado local después).
 */
export async function findUserByIdentifier(identifier: string): Promise<AuthenticableUser | null> {
  const { email, phone } = normalizeIdentifier(identifier);

  if (email) {
    return db.user.findUnique({ where: { email } });
  }

  if (phone) {
    for (const variant of phoneOrVariants(phone)) {
      const user = await db.user.findUnique({ where: { phone: variant.phone } });
      if (user) return user;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// REDIRECCIÓN POST-LOGIN (server-side, autoritativa)
// ---------------------------------------------------------------------------

const ROLE_HOME_REDIRECT: Record<string, string> = {
  customer: '/mi-cuenta',
  admin: '/admin',
  editor: '/admin',
  agent: '/admin',
};

/**
 * Acepta `next` SOLO si es una ruta interna relativa permitida para el rol.
 * Rechaza: URLs absolutas/externas, `//host` (protocol-relative), backslash
 * (`/\evil` se normaliza como `//`), esquemas, y rutas fuera del alcance del
 * rol (CUSTOMER no entra a /admin; backoffice no cae al storefront).
 */
export function sanitizeNextPath(next: unknown, role: string): string | null {
  if (typeof next !== 'string') return null;

  const trimmed = next.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  if (!trimmed.startsWith('/') || trimmed.startsWith('//') || trimmed.startsWith('/\\')) return null;
  if (trimmed.includes('\\') || /[\r\n\0]/.test(trimmed)) return null;
  if (/:/.test(trimmed)) return null; // bloquea "http:", "javascript:", etc.

  const roleKey = role.trim().toLowerCase();
  const lower = trimmed.toLowerCase();

  if (roleKey === 'customer') {
    const blocked = ['/admin', '/api', '/ingresar', '/registrarse', '/recuperar'];
    if (blocked.some((p) => lower === p || lower.startsWith(`${p}/`) || lower.startsWith(`${p}?`))) {
      return null;
    }
    return trimmed;
  }

  if (roleKey === 'admin' || roleKey === 'editor' || roleKey === 'agent') {
    if (lower === '/admin' || lower.startsWith('/admin/')) return trimmed;
    return null;
  }

  return null;
}

/** Destino autorizado post-login: `next` saneado o home del rol. */
export function resolvePostLoginRedirect(role: string, next?: unknown): string {
  const sanitized = sanitizeNextPath(next, role);
  if (sanitized) return sanitized;
  return ROLE_HOME_REDIRECT[role.trim().toLowerCase()] ?? '/mi-cuenta';
}

// ---------------------------------------------------------------------------
// LOGIN POR CONTRASEÑA (cualquier rol)
// ---------------------------------------------------------------------------

// Hash bcrypt de una contraseña aleatoria: se compara cuando la cuenta NO
// existe para aplanar el tiempo de respuesta (evita enumeración por timing).
const globalForDummy = globalThis as typeof globalThis & {
  __authDummyHashPromise?: Promise<string>;
};

function getDummyHash(): Promise<string> {
  globalForDummy.__authDummyHashPromise ??= import('bcryptjs').then((bcrypt) =>
    bcrypt.default.hash(
      Array.from({ length: 3 }, () => globalThis.crypto.randomUUID()).join('-'),
      10
    )
  );
  return globalForDummy.__authDummyHashPromise;
}

export interface UnifiedLoginResult {
  token: string;
  user: AuthUserDTO;
  redirectTo: string;
}

export async function loginWithPasswordUnified(
  identifier: string,
  passwordPlain: string,
  sessionDurationHours = 24,
  next?: unknown
): Promise<UnifiedLoginResult> {
  if (!identifier?.trim() || !passwordPlain) {
    throw new UnifiedAuthError('INVALID_INPUT', GENERIC_LOGIN_FAILURE);
  }

  const user = await findUserByIdentifier(identifier);

  // Tiempo plano: la comparación bcrypt ocurre SIEMPRE, exista o no la cuenta.
  const hash = user?.password ?? (await getDummyHash());
  const isValid = await verifyPassword(passwordPlain, hash);

  if (!user || !isValid) {
    throw new UnifiedAuthError('INVALID_CREDENTIALS', GENERIC_LOGIN_FAILURE);
  }

  if (!isKnownUserRole(user.role)) {
    // Política explícita: roles desconocidos no autentican (fail-closed).
    console.error('[UNIFIED_AUTH] Rol desconocido bloqueado en login:', user.role);
    throw new UnifiedAuthError('INVALID_ROLE', GENERIC_LOGIN_FAILURE);
  }

  if (!user.isActive) {
    throw new UnifiedAuthError('INACTIVE', INACTIVE_ACCOUNT_MESSAGE);
  }

  const token = await createSession(user.id, sessionDurationHours);

  // lastLogin unificado para todos los roles (antes solo el login admin lo
  // actualizaba).
  await db.user
    .update({ where: { id: user.id }, data: { lastLogin: new Date() } })
    .catch((error) => {
      console.warn('[UNIFIED_AUTH] No se pudo actualizar lastLogin:', error);
    });

  return {
    token,
    user: requireAuthUserDTO(user),
    redirectTo: resolvePostLoginRedirect(user.role, next),
  };
}

// ---------------------------------------------------------------------------
// OTP TEMPORAL (cualquier rol): email -> OTP propio; teléfono -> SMS/Twilio
// ---------------------------------------------------------------------------

export interface AuthenticableUser {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  role: string;
  isActive: boolean;
  password: string;
  emailVerifiedAt: Date | null;
}

function assertAuthenticableUser(
  user: AuthenticableUser | null | undefined
): asserts user is AuthenticableUser {
  if (!user) {
    // Sin cuenta: respuesta indistinguible de un código erróneo.
    throw new UnifiedAuthError('NO_ACCOUNT', GENERIC_OTP_FAILURE);
  }
  if (!isKnownUserRole(user.role)) {
    throw new UnifiedAuthError('INVALID_ROLE', GENERIC_OTP_FAILURE);
  }
  if (!user.isActive) {
    throw new UnifiedAuthError('INACTIVE', INACTIVE_ACCOUNT_MESSAGE);
  }
}

/**
 * Solicita un OTP de LOGIN para el identificador dado.
 * - Email: solo se emite si existe una cuenta activa con ese correo (evita
 *   envíos a cuentas inexistentes); el correo es el canal preferido.
 * - Teléfono: solo se envía SMS si existe una cuenta activa con ese teléfono
 *   (reduce el gasto de Twilio; LOGIN nunca crea cuentas).
 * Devuelve `null` cuando no hay cuenta elegible: el llamador responde SIEMPRE
 * genérico (no se revela si la cuenta existe). `debugCode` solo se rellena
 * fuera de producción (doble guardia en la librería OTP).
 */
export async function sendOtpForLogin(
  identifier: string
): Promise<{ channel: OtpChannel; debugCode?: string } | null> {
  const { email, phone } = normalizeIdentifier(identifier);
  if (!email && !phone) return null;

  const user = await findUserByIdentifier(identifier);
  if (!user || !user.isActive || !isKnownUserRole(user.role)) return null;

  if (email) {
    const issued = await issueEmailOtp(email, 'login', {
      debug: process.env.NODE_ENV !== 'production',
    });
    return { channel: 'email', ...(issued.debugCode ? { debugCode: issued.debugCode } : {}) };
  }

  if (!user.phone) return null;
  await sendPhoneOtp(user.phone); // Twilio Verify o mock de desarrollo
  return { channel: 'sms' };
}

/**
 * Verifica un OTP de LOGIN y crea la sesión. Tras un login por email exitoso
 * se marca `emailVerifiedAt` (prueba de posesión del correo).
 */
export async function verifyOtpForLogin(
  identifier: string,
  code: string,
  sessionDurationHours = 24,
  next?: unknown
): Promise<UnifiedLoginResult> {
  const { email, phone } = normalizeIdentifier(identifier);

  if (email) {
    const user = await db.user.findUnique({ where: { email } });
    assertAuthenticableUser(user);

    try {
      await verifyEmailOtp(email, 'login', code);
    } catch (error) {
      if (error instanceof EmailOtpError && error.code === 'NOT_CONFIGURED') {
        throw new UnifiedAuthError('OTP_NOT_CONFIGURED', GENERIC_OTP_FAILURE);
      }
      throw new UnifiedAuthError('INVALID_OTP', GENERIC_OTP_FAILURE);
    }

    if (!user.emailVerifiedAt) {
      await db.user
        .update({ where: { id: user.id }, data: { emailVerifiedAt: new Date() } })
        .catch((error) => {
          console.warn('[UNIFIED_AUTH] No se pudo marcar emailVerifiedAt:', error);
        });
    }

    const token = await createSession(user.id, sessionDurationHours);
    await db.user
      .update({ where: { id: user.id }, data: { lastLogin: new Date() } })
      .catch(() => null);

    return {
      token,
      user: requireAuthUserDTO(user),
      redirectTo: resolvePostLoginRedirect(user.role, next),
    };
  }

  if (phone) {
    const user = await findUserByIdentifier(identifier);
    assertAuthenticableUser(user);

    try {
      await verifyPhoneOtp(user.phone!, code);
    } catch {
      throw new UnifiedAuthError('INVALID_OTP', GENERIC_OTP_FAILURE);
    }

    const token = await createSession(user.id, sessionDurationHours);
    await db.user
      .update({ where: { id: user.id }, data: { lastLogin: new Date() } })
      .catch(() => null);

    return {
      token,
      user: requireAuthUserDTO(user),
      redirectTo: resolvePostLoginRedirect(user.role, next),
    };
  }

  throw new UnifiedAuthError('INVALID_INPUT', GENERIC_OTP_FAILURE);
}

/** true si el canal email está disponible (secreto HMAC + proveedor). */
export function isEmailOtpLoginAvailable(): boolean {
  return isEmailOtpConfigured();
}

// Re-export para que las rutas usen un solo módulo de roles.
export { isAdminRole, isBackofficeRole, isAgentRole };
