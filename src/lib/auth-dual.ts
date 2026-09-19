import { db } from './db';
import { verifyPassword, createSession } from './auth';
import { DEFAULT_MOCK_PHONE_OTP } from './phone-otp';
import { checkOtpWithTwilio, isTwilioVerifyConfigured, sendOtpWithTwilio } from './twilio-verify';
import { canonicalColombiaPhone, phoneOrVariants, toE164ColombiaPhone } from './phone';
import { requireAuthUserDTO, AuthUserDTO } from './user-dto';

function isMockOtpEnabled(): boolean {
  return process.env.ENABLE_MOCK_PHONE_OTP === 'true';
}

export function isPhoneOtpLoginEnabled(): boolean {
  return isMockOtpEnabled() || isTwilioVerifyConfigured();
}

export async function sendPhoneOtp(phone: string): Promise<{ provider: 'twilio' | 'mock'; debugCode?: string }> {
  // Twilio Verify recibe E.164 (+57...); la canonicalización interna es la
  // misma para cualquier formato de entrada del usuario.
  const e164Phone = toE164ColombiaPhone(phone);

  if (!e164Phone) {
    throw new Error('Número de teléfono colombiano inválido. Usa 10 dígitos, ej: 3001234567.');
  }

  if (isMockOtpEnabled()) {
    return {
      provider: 'mock',
      debugCode: process.env.MOCK_PHONE_OTP || DEFAULT_MOCK_PHONE_OTP,
    };
  }

  if (!isTwilioVerifyConfigured()) {
    throw new Error('OTP no configurado. Define Twilio o habilita ENABLE_MOCK_PHONE_OTP en desarrollo.');
  }

  await sendOtpWithTwilio(e164Phone);
  return { provider: 'twilio' };
}

/**
 * Verifica un código OTP para un teléfono. Reutilizada por login y por el
 * restablecimiento de contraseña (la expiración la gestiona el proveedor).
 *
 * LONGITUD EN TRANSICIÓN (4 → 6): la verificación acepta códigos de 4 a 8
 * dígitos porque la longitud REAL la impone el proveedor (Twilio Verify
 * CodeLength del servicio). La UI y el mock por defecto ya usan 6; actualizar
 * el servicio Twilio a CodeLength=6 es un paso de despliegue documentado.
 * El chequeo local solo descarta basura antes de llamar al proveedor.
 */
export async function verifyPhoneOtp(phone: string, otpCode: string): Promise<void> {
  const e164Phone = toE164ColombiaPhone(phone);
  if (!e164Phone) {
    throw new Error('Número de teléfono colombiano inválido');
  }

  const normalizedOtpCode = otpCode.replace(/\D/g, '');

  if (normalizedOtpCode.length < 4 || normalizedOtpCode.length > 8) {
    throw new Error('El código OTP debe tener entre 4 y 8 dígitos');
  }

  if (isMockOtpEnabled()) {
    const expectedOtp = process.env.MOCK_PHONE_OTP || DEFAULT_MOCK_PHONE_OTP;
    const isValidMockOtp = normalizedOtpCode === expectedOtp;
    if (!isValidMockOtp) throw new Error('Código inválido');
  } else {
    if (!isTwilioVerifyConfigured()) {
      throw new Error('OTP no configurado. Define credenciales de Twilio Verify.');
    }

    const isValidTwilioOtp = await checkOtpWithTwilio(e164Phone, normalizedOtpCode);
    if (!isValidTwilioOtp) throw new Error('Código inválido o expirado');
  }
}

/**
 * Busca la cuenta CUSTOMER asociada a un teléfono en CUALQUIERA de las formas
 * almacenadas (canónico `57...` o legado local de 10 dígitos). Determinista:
 * siempre resuelve la misma cuenta para `3001234567`, `+573001234567` y
 * `573001234567`.
 */
export async function findCustomerByPhone(phone: string, tx: any = db) {
  const variants = phoneOrVariants(phone);
  if (variants.length === 0) return null;

  return (tx ?? db).user.findFirst({
    where: {
      role: { equals: 'CUSTOMER', mode: 'insensitive' },
      OR: variants,
    },
  });
}

/**
 * Login por OTP de teléfono. LOGIN = SOLO cuentas existentes: si el teléfono
 * no corresponde a una cuenta activa, NO se crea nada (el registro explícito
 * vive en /registrarse). El OTP ya fue verificado por el proveedor; el envío
 * del código está gated por existencia de cuenta en los endpoints unificados.
 */
export async function loginWithPhone(
  phone: string,
  otpCode: string,
  sessionDurationHours = 24
): Promise<{ token: string; user: AuthUserDTO }> {
  const canonicalPhone = canonicalColombiaPhone(phone);

  await verifyPhoneOtp(phone, otpCode);

  const user = canonicalPhone ? await findCustomerByPhone(canonicalPhone) : null;

  if (user && !user.isActive) {
    throw new Error('Tu cuenta está desactivada. Contacta a tu asesor comercial.');
  }

  if (!user) {
    // Sin alta implícita: OTP válido sobre un teléfono sin cuenta no registra
    // nada. Mensaje genérico (no revela si el código fue correcto).
    throw new Error('Código inválido o expirado');
  }

  const token = await createSession(user.id, sessionDurationHours);
  return { token, user: requireAuthUserDTO(user) };
}

/**
 * Login de CLIENTE con contraseña. SOLO autentica cuentas role=CUSTOMER:
 * el personal interno (admin/editor/AGENT) tiene su propio acceso.
 */
export async function loginWithPassword(
  phoneOrEmail: string,
  passwordPlain: string,
  sessionDurationHours = 24
): Promise<{ token: string; user: AuthUserDTO }> {
  const identifier = phoneOrEmail?.trim().toLowerCase();
  if (!identifier || !passwordPlain) {
    throw new Error('Credenciales inválidas');
  }

  const user = await db.user.findFirst({
    where: {
      role: { equals: 'CUSTOMER', mode: 'insensitive' },
      OR: [
        // Teléfono: aceptar cualquier forma equivalente de la misma línea
        ...phoneOrVariants(identifier),
        { email: identifier },
      ],
    },
  });

  if (!user || !user.password) {
    throw new Error("Usa tu número de teléfono para ingresar o configura una contraseña.");
  }

  if (!user.isActive) {
    throw new Error("Tu cuenta está desactivada. Contacta a tu asesor comercial.");
  }

  const isValid = await verifyPassword(passwordPlain, user.password);
  if (!isValid) throw new Error("Credenciales inválidas");

  const token = await createSession(user.id, sessionDurationHours);
  return { token, user: requireAuthUserDTO(user) };
}
