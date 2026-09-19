import { NextRequest, NextResponse } from 'next/server';
import { sendOtpForLogin, normalizeIdentifier, EmailOtpError } from '@/lib/unified-auth';
import { isPhoneOtpLoginEnabled } from '@/lib/auth-dual';
import { isEmailOtpConfigured } from '@/lib/email-otp';
import {
  checkRateLimit,
  recordFailedAttempt,
  resetRateLimit,
  getClientIp,
  OTP_SEND_IP_MAX_ATTEMPTS,
  OTP_SEND_ID_MAX_ATTEMPTS,
  OTP_SEND_WINDOW_MS,
  OTP_SEND_LOCKOUT_MS,
} from '@/lib/rate-limit';

// ============================================================================
// POST /api/auth/otp/send — solicita un código temporal de LOGIN.
//
// El canal sigue el TIPO de identificador: email -> OTP self-managed por
// Resend (6 dígitos); teléfono -> SMS vía Twilio Verify.
//
// Anti-enumeración: la respuesta es GENÉRICA siempre — exista o no la cuenta.
// El envío solo ocurre para cuentas activas con rol conocido (LOGIN nunca
// crea cuentas y nunca gasta SMS/correo para identidades inexistentes).
// 503 solo cuando el canal del identificador está globalmente sin
// configurar (condición independiente de la cuenta, no filtra existencia).
// ============================================================================

// Mensaje único para todo resultado normal (cuenta exista o no).
const GENERIC_SEND_MESSAGE =
  'Si tu cuenta existe y tiene un canal configurado, recibirás un código de acceso.';

function identityKey(identifier: string): string {
  const { email, phone } = normalizeIdentifier(identifier);
  const normalized = email ?? phone ?? identifier.trim().toLowerCase().slice(0, 120);
  return `otp-send:id:${normalized}`;
}

export async function POST(req: NextRequest) {
  try {
    const ip = getClientIp(req);
    const ipKey = `otp-send:ip:${ip}`;

    const body = await req.json().catch(() => ({}));
    const identifier = String(body.identifier ?? '');

    if (!identifier.trim()) {
      return NextResponse.json(
        { success: false, error: 'Ingresa tu correo o teléfono' },
        { status: 400 }
      );
    }

    const { email, phone } = normalizeIdentifier(identifier);
    if (!email && !phone) {
      // Mismo 400 para identificadores malformados (no distingue cuentas).
      return NextResponse.json(
        { success: false, error: 'Ingresa un correo o teléfono válido' },
        { status: 400 }
      );
    }

    const idKey = identityKey(identifier);

    for (const key of [ipKey, idKey]) {
      const limit = await checkRateLimit(
        key,
        key === ipKey ? OTP_SEND_IP_MAX_ATTEMPTS : OTP_SEND_ID_MAX_ATTEMPTS,
        OTP_SEND_WINDOW_MS
      );
      if (limit.isBlocked) {
        const retryAfter = limit.retryAfterSeconds || 600;
        return NextResponse.json(
          {
            success: false,
            error: 'Demasiadas solicitudes. Espera unos minutos antes de reintentar.',
            retryAfterSeconds: retryAfter,
          },
          { status: 429, headers: { 'Retry-After': String(retryAfter) } }
        );
      }
    }

    // Canal globalmente sin configurar => 503 determinista por TIPO de
    // identificador (no depende de si la cuenta existe).
    if (email && !isEmailOtpConfigured()) {
      return NextResponse.json(
        {
          success: false,
          error: 'El canal de correo no está disponible. Ingresa con tu teléfono o contraseña.',
        },
        { status: 503 }
      );
    }
    if (phone && !isPhoneOtpLoginEnabled()) {
      return NextResponse.json(
        {
          success: false,
          error: 'El canal de SMS no está disponible. Ingresa con tu correo o contraseña.',
        },
        { status: 503 }
      );
    }

    try {
      const result = await sendOtpForLogin(identifier);

      await resetRateLimit(ipKey);

      if (!result) {
        // Sin cuenta elegible: respuesta idéntica a la de éxito.
        return NextResponse.json({ success: true, message: GENERIC_SEND_MESSAGE });
      }

      // En desarrollo el canal puede exponer el código (mock/pruebas); en
      // producción la respuesta JAMÁS contiene el código OTP.
      const isDev = process.env.NODE_ENV !== 'production';

      return NextResponse.json({
        success: true,
        message: GENERIC_SEND_MESSAGE,
        ...(isDev ? { data: { channel: result.channel, ...(result.debugCode ? { debugCode: result.debugCode } : {}) } } : {}),
      });
    } catch (error) {
      if (error instanceof EmailOtpError && error.code === 'COOLDOWN') {
        const retryAfter = error.retryAfterSeconds ?? 60;
        return NextResponse.json(
          {
            success: false,
            error: `Espera ${retryAfter} segundos para solicitar otro código.`,
            retryAfterSeconds: retryAfter,
          },
          { status: 429, headers: { 'Retry-After': String(retryAfter) } }
        );
      }
      if (error instanceof EmailOtpError && error.code === 'NOT_CONFIGURED') {
        return NextResponse.json(
          { success: false, error: 'El canal de correo no está disponible. Ingresa con tu teléfono o contraseña.' },
          { status: 503 }
        );
      }
      // PROVIDER_ERROR u otros: respuesta genérica (el usuario puede
      // reintentar); el detalle técnico quedó en log server-side.
      await recordFailedAttempt(
        ipKey,
        OTP_SEND_IP_MAX_ATTEMPTS,
        OTP_SEND_WINDOW_MS,
        OTP_SEND_LOCKOUT_MS
      );
      await recordFailedAttempt(
        idKey,
        OTP_SEND_ID_MAX_ATTEMPTS,
        OTP_SEND_WINDOW_MS,
        OTP_SEND_LOCKOUT_MS
      );
      return NextResponse.json({ success: true, message: GENERIC_SEND_MESSAGE });
    }
  } catch (error) {
    console.error('Error solicitando OTP de login:', error);
    return NextResponse.json(
      { success: false, error: 'No fue posible enviar el código' },
      { status: 500 }
    );
  }
}
