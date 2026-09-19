import { db } from './db';
import { hashPassword, verifyPassword, createSession, generateToken } from './auth';
import { sendPhoneOtp, verifyPhoneOtp, findCustomerByPhone } from './auth-dual';
import { canonicalColombiaPhone, phoneOrVariants } from './phone';
import { issueEmailOtp, verifyEmailOtp, isEmailOtpConfigured } from './email-otp';
import { toAuthUserDTO, AuthUserDTO } from './user-dto';

/**
 * Flujos de cuenta del CLIENTE final sobre el maestro `User` (role CUSTOMER):
 * registro, cambio de contraseña y restablecimiento vía OTP.
 *
 * RECUPERACIÓN UNIFICADA: el restablecimiento sirve para TODOS los roles
 * activos del maestro `User`. El canal sigue el TIPO de identificador:
 *   - email  -> OTP self-managed de 6 dígitos vía Resend (canal preferido).
 *   - teléfono -> OTP por SMS vía Twilio Verify (canal alternativo).
 *
 * POLÍTICA DE ACCESO (actualizada con la unificación de auth):
 *   - El teléfono sigue siendo obligatorio en cuentas self-service (registro),
 *     pero el correo ahora ES vía de recuperación autónoma cuando existe.
 *   - Todo teléfono se persiste canonicalizado (`src/lib/phone.ts`), de modo
 *     que `3001234567`, `+573001234567` y `573001234567` son LA MISMA cuenta.
 */

export const MIN_PASSWORD_LENGTH = 8;
export const PASSWORD_RESET_SESSION_HOURS = 24;

/**
 * ÚNICO mensaje externo para todos los fallos de restablecimiento que podrían
 * revelar existencia de cuenta: cuenta inexistente, inactiva, sin teléfono,
 * OTP inválido/expirado o proveedor caído. Mismo status y mismo body en todos
 * esos casos; los detalles (Twilio, canonicalización, etc.) solo van al log
 * server-side.
 */
export const GENERIC_RESET_FAILURE =
  'No fue posible restablecer la contraseña. Verifica tus datos o solicita un nuevo código.';

export class CustomerAuthError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'CustomerAuthError';
    this.code = code;
  }
}

export function normalizeCustomerEmail(email?: string | null): string | null {
  if (!email) return null;
  const normalized = email.trim().toLowerCase();
  return normalized || null;
}

/**
 * DEPRECATED como formato de almacenamiento: se conserva por compatibilidad
 * con importaciones existentes. Nuevas escrituras usan `canonicalColombiaPhone`.
 */
export function normalizeCustomerPhone(phone?: string | null): string | null {
  return canonicalColombiaPhone(phone);
}

function validatePasswordStrength(password: string): void {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    throw new CustomerAuthError(
      'WEAK_PASSWORD',
      `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`
    );
  }
  if (password.length > 72) {
    throw new CustomerAuthError(
      'WEAK_PASSWORD',
      'La contraseña no puede exceder 72 caracteres.'
    );
  }
}

export interface RegisterCustomerInput {
  name: string;
  email?: string | null;
  phone: string | null;
  password: string;
  company?: string | null;
  taxId?: string | null;
}

/**
 * Registra una nueva cuenta CUSTOMER. Nunca reutiliza ni actualiza cuentas
 * existentes: si el email o teléfono ya existen (en cualquiera de sus formas
 * equivalentes), rechaza con error genérico (evita enumeración y secuestro de
 * cuentas creadas por checkout).
 */
export async function registerCustomer(
  input: RegisterCustomerInput,
  sessionDurationHours = 24
): Promise<{ token: string; user: AuthUserDTO }> {
  const name = input.name?.trim().slice(0, 200);
  const email = normalizeCustomerEmail(input.email);
  const phone = canonicalColombiaPhone(input.phone);

  if (!name) {
    throw new CustomerAuthError('INVALID_NAME', 'El nombre es requerido.');
  }
  if (!phone) {
    // Política de fase 2: el teléfono es obligatorio (recuperación por OTP).
    throw new CustomerAuthError(
      'PHONE_REQUIRED',
      'Debes registrar un número de teléfono colombiano de 10 dígitos.'
    );
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new CustomerAuthError('INVALID_EMAIL', 'Formato de correo inválido.');
  }
  validatePasswordStrength(input.password);

  const existing = await db.user.findFirst({
    where: {
      role: { equals: 'CUSTOMER', mode: 'insensitive' },
      OR: [...(email ? [{ email }] : []), ...phoneOrVariants(phone)],
    },
    select: { id: true },
  });

  if (existing) {
    throw new CustomerAuthError(
      'ACCOUNT_EXISTS',
      'Ya existe una cuenta con estos datos. Inicia sesión o recupera tu contraseña.'
    );
  }

  const user = await db.user.create({
    data: {
      name,
      email,
      phone,
      role: 'CUSTOMER',
      isActive: true,
      password: await hashPassword(input.password),
      company: input.company?.trim().slice(0, 200) || null,
      taxId: input.taxId?.trim().slice(0, 50) || null,
      passwordChangedAt: new Date(),
    },
  });

  const token = await createSession(user.id, sessionDurationHours);
  return {
    token,
    user: toAuthUserDTO(user)!,
  };
}

/**
 * Cambio de contraseña con sesión activa. Verifica la contraseña actual y
 * CIERRA todas las demás sesiones del usuario (conserva la actual).
 */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
  currentSessionToken?: string | null
): Promise<void> {
  validatePasswordStrength(newPassword);

  const user = await db.user.findUnique({ where: { id: userId } });
  if (!user || !user.isActive) {
    throw new CustomerAuthError('USER_NOT_FOUND', 'Cuenta no disponible.');
  }
  if (!user.password) {
    throw new CustomerAuthError(
      'NO_PASSWORD',
      'Tu cuenta no tiene contraseña configurada. Usa el acceso por teléfono.'
    );
  }

  const isValid = await verifyPassword(currentPassword, user.password);
  if (!isValid) {
    throw new CustomerAuthError('INVALID_CREDENTIALS', 'La contraseña actual es incorrecta.');
  }

  await db.user.update({
    where: { id: userId },
    data: { password: await hashPassword(newPassword), passwordChangedAt: new Date() },
  });

  // Invalidar el resto de sesiones; la sesión actual permanece activa
  await db.session.deleteMany({
    where: {
      userId,
      ...(currentSessionToken ? { token: { not: currentSessionToken } } : {}),
    },
  });
}

/**
 * Busca el usuario dueño de un contacto para RECUPERACIÓN (todos los roles
 * activos del maestro `User`): email por unique, teléfono en cualquier forma
 * almacenada. Determinista: canónico primero.
 */
async function findUserByContactForReset(phoneOrEmail: string, tx: any = db) {
  const rawEmail = normalizeCustomerEmail(phoneOrEmail);
  // Solo un identificador CON forma de email se busca por email: un teléfono
  // (10 dígitos) normalizado nunca debe caer en la rama email.
  const email = rawEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail) ? rawEmail : null;

  if (email) {
    return (tx ?? db).user.findUnique({
      where: { email },
      select: { id: true, phone: true, email: true, emailVerifiedAt: true, isActive: true },
    });
  }

  const phoneVariants = phoneOrVariants(phoneOrEmail);
  if (phoneVariants.length === 0) return null;

  return (tx ?? db).user.findFirst({
    where: { OR: phoneVariants },
    select: { id: true, phone: true, email: true, emailVerifiedAt: true, isActive: true },
  });
}

/**
 * Solicita restablecimiento de contraseña. Canal según el TIPO de
 * identificador: email -> OTP por correo (Resend, preferido); teléfono -> OTP
 * por SMS (Twilio). La respuesta es genérica para evitar enumeración de
 * cuentas; `otpNotConfigured` solo refleja CONFIGURACIÓN GLOBAL del canal
 * (nunca existencia de cuenta).
 */
export async function requestPasswordReset(
  phoneOrEmail: string
): Promise<{ otpSent: boolean; otpNotConfigured: boolean }> {
  const rawEmail = normalizeCustomerEmail(phoneOrEmail);
  const email = rawEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail) ? rawEmail : null;
  const phoneVariants = phoneOrVariants(phoneOrEmail);

  if (!email && phoneVariants.length === 0) {
    throw new CustomerAuthError('INVALID_CONTACT', 'Ingresa tu correo o teléfono.');
  }

  if (email && !isEmailOtpConfigured()) {
    // Canal email globalmente sin configurar: falla sin mirar la cuenta.
    return { otpSent: false, otpNotConfigured: true };
  }

  const user = await findUserByContactForReset(phoneOrEmail);

  if (!user || !user.isActive) {
    // Respuesta genérica: no revelar si la cuenta existe.
    return { otpSent: false, otpNotConfigured: false };
  }

  try {
    if (email) {
      await issueEmailOtp(email, 'password_reset');
    } else {
      if (!user.phone) {
        // Sin teléfono en la cuenta: respuesta genérica (puede reintentar
        // con su correo, que ahora también recupera).
        return { otpSent: false, otpNotConfigured: false };
      }
      await sendPhoneOtp(user.phone);
    }
    return { otpSent: true, otpNotConfigured: false };
  } catch {
    // OTP no configurado u error del proveedor: detalle solo en log.
    return { otpSent: false, otpNotConfigured: true };
  }
}

/**
 * Restablece la contraseña verificando el OTP del canal correspondiente al
 * identificador (email -> OTP self-managed; teléfono -> Twilio). Al terminar,
 * CIERRA todas las sesiones activas del usuario (el atacante con sesión
 * abierta pierde el acceso y el usuario real vuelve a entrar).
 *
 * ANTI-ENUMERACIÓN: cuenta inexistente, inactiva, sin canal, OTP
 * inválido/expirado o proveedor caído producen EXACTAMENTE el mismo error
 * genérico (GENERIC_RESET_FAILURE). Los mensajes del proveedor no se
 * propagan. Un reset por email exitoso también marca `emailVerifiedAt`
 * (prueba de posesión del correo).
 */
export async function resetPasswordWithOtp(
  phoneOrEmail: string,
  otpCode: string,
  newPassword: string
): Promise<void> {
  validatePasswordStrength(newPassword);

  const rawEmail = normalizeCustomerEmail(phoneOrEmail);
  const email = rawEmail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail) ? rawEmail : null;
  const user = await findUserByContactForReset(phoneOrEmail);

  if (!user || !user.isActive) {
    // Falla genérica SIN llamar al proveedor.
    throw new CustomerAuthError('RESET_FAILED', GENERIC_RESET_FAILURE);
  }

  if (email) {
    if (!user.email || !isEmailOtpConfigured()) {
      throw new CustomerAuthError('RESET_FAILED', GENERIC_RESET_FAILURE);
    }

    try {
      await verifyEmailOtp(user.email, 'password_reset', otpCode);
    } catch (otpError) {
      // OTP inválido/expirado/agotado o canal caído: MISMA respuesta externa
      // que una cuenta inexistente. Detalle solo en log.
      console.warn(
        '[RESET_PASSWORD] Verificación OTP de email fallida (respuesta genérica al cliente):',
        otpError instanceof Error ? otpError.message : otpError
      );
      throw new CustomerAuthError('RESET_FAILED', GENERIC_RESET_FAILURE);
    }

    await db.user.update({
      where: { id: user.id },
      data: {
        password: await hashPassword(newPassword),
        passwordChangedAt: new Date(),
        emailVerifiedAt: user.emailVerifiedAt ?? new Date(),
      },
    });
  } else {
    if (!user.phone) {
      throw new CustomerAuthError('RESET_FAILED', GENERIC_RESET_FAILURE);
    }

    try {
      await verifyPhoneOtp(user.phone, otpCode);
    } catch (otpError) {
      console.warn(
        '[RESET_PASSWORD] Verificación OTP de teléfono fallida (respuesta genérica al cliente):',
        otpError instanceof Error ? otpError.message : otpError
      );
      throw new CustomerAuthError('RESET_FAILED', GENERIC_RESET_FAILURE);
    }

    await db.user.update({
      where: { id: user.id },
      data: {
        password: await hashPassword(newPassword),
        passwordChangedAt: new Date(),
      },
    });
  }

  await db.session.deleteMany({ where: { userId: user.id } });
}

/** Token opaco de un solo uso para operaciones administrativas futuras. */
export function generateResetToken(): string {
  return generateToken();
}

// Re-export para flujos administrativos que buscan por teléfono canónico.
export { findCustomerByPhone };
