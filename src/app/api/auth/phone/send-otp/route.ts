import { NextResponse } from 'next/server';
import { isPhoneOtpLoginEnabled } from '@/lib/auth-dual';
import { sendOtpForLogin } from '@/lib/unified-auth';
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
// POST /api/auth/phone/send-otp — LEGACY (LoginModal), deprecado.
//
// Delega al envío unificado (misma filosofía que /api/auth/otp/send): solo
// envía SMS si el teléfono corresponde a una cuenta activa (LOGIN nunca crea
// cuentas y ya no se gasta Twilio en teléfonos sin cuenta). Mantiene la forma
// de respuesta previa por compatibilidad. Rate limit compartido con el envío
// unificado (mismas cubetas otp-send:*).
// ============================================================================

function identityKey(phone: string): string {
  return `otp-send:id:${phone.trim().toLowerCase().slice(0, 120)}`;
}

export async function POST(req: Request) {
  try {
    if (!isPhoneOtpLoginEnabled()) {
      return NextResponse.json(
        { success: false, error: 'Servicio OTP no disponible. Configura Twilio Verify.' },
        { status: 503 }
      );
    }

    const { phone } = await req.json();

    if (!phone) {
      return NextResponse.json({ success: false, error: 'Phone is required' }, { status: 400 });
    }

    const ip = getClientIp(req);
    const ipKey = `otp-send:ip:${ip}`;
    const idKey = identityKey(String(phone));

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

    try {
      const result = await sendOtpForLogin(String(phone));

      // Respuesta genérica: exista o no la cuenta, el cliente ve éxito.
      // Solo se envió SMS si había cuenta activa (anti-gasto Twilio).
      await resetRateLimit(ipKey);

      const provider = process.env.ENABLE_MOCK_PHONE_OTP === 'true' ? 'mock' : 'twilio';

      return NextResponse.json({
        success: true,
        data: {
          provider,
          ...(process.env.NODE_ENV !== 'production' && result?.debugCode
            ? { debugCode: result.debugCode }
            : {}),
        },
      });
    } catch (error: any) {
      await recordFailedAttempt(ipKey, OTP_SEND_IP_MAX_ATTEMPTS, OTP_SEND_WINDOW_MS, OTP_SEND_LOCKOUT_MS);
      await recordFailedAttempt(idKey, OTP_SEND_ID_MAX_ATTEMPTS, OTP_SEND_WINDOW_MS, OTP_SEND_LOCKOUT_MS);
      return NextResponse.json(
        { success: false, error: error?.message || 'No fue posible enviar el OTP' },
        { status: 400 }
      );
    }
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error?.message || 'No fue posible enviar el OTP' },
      { status: 500 }
    );
  }
}
