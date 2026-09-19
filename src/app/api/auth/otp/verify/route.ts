import { NextRequest, NextResponse } from 'next/server';
import {
  setSessionCookie,
  SESSION_DURATION_DAYS_REMEMBER_ME,
  SESSION_DURATION_HOURS_DEFAULT,
  rotateGuestSessionCookie,
} from '@/lib/auth';
import { transferSessionDataToUser } from '@/lib/checkout';
import {
  verifyOtpForLogin,
  normalizeIdentifier,
  UnifiedAuthError,
  GENERIC_OTP_FAILURE,
} from '@/lib/unified-auth';
import {
  checkRateLimit,
  recordFailedAttempt,
  resetRateLimit,
  getClientIp,
  OTP_VERIFY_IP_MAX_ATTEMPTS,
  OTP_VERIFY_ID_MAX_ATTEMPTS,
  OTP_VERIFY_WINDOW_MS,
  OTP_VERIFY_LOCKOUT_MS,
} from '@/lib/rate-limit';

// ============================================================================
// POST /api/auth/otp/verify — verifica el código temporal y crea la sesión.
//
// Complemento de /api/auth/otp/send para el flujo "Código de acceso" de
// /ingresar (cualquier rol). Anti-enumeración: todo fallo de verificación
// responde el MISMO 401 genérico (sin revelar existencia/canal/rol). El
// destino post-login (`redirectTo`) se calcula server-side según el rol.
// ============================================================================

const GENERIC_VERIFY_ERROR = 'Demasiados intentos. Espera unos minutos antes de reintentar.';

function identityKey(identifier: string): string {
  const { email, phone } = normalizeIdentifier(identifier);
  const normalized = email ?? phone ?? identifier.trim().toLowerCase().slice(0, 120);
  return `otp-verify:id:${normalized}`;
}

export async function POST(req: NextRequest) {
  try {
    const ip = getClientIp(req);
    const ipKey = `otp-verify:ip:${ip}`;

    const body = await req.json().catch(() => ({}));
    const identifier = String(body.identifier ?? '');
    const code = String(body.code ?? '');
    const rememberMe = Boolean(body.rememberMe);
    const sessionHours = rememberMe
      ? SESSION_DURATION_DAYS_REMEMBER_ME * 24
      : SESSION_DURATION_HOURS_DEFAULT;

    if (!identifier.trim() || !code.trim()) {
      return NextResponse.json(
        { success: false, error: 'Identificador y código son requeridos' },
        { status: 400 }
      );
    }

    const idKey = identityKey(identifier);

    for (const key of [ipKey, idKey]) {
      const limit = await checkRateLimit(
        key,
        key === ipKey ? OTP_VERIFY_IP_MAX_ATTEMPTS : OTP_VERIFY_ID_MAX_ATTEMPTS,
        OTP_VERIFY_WINDOW_MS
      );
      if (limit.isBlocked) {
        const retryAfter = limit.retryAfterSeconds || 900;
        return NextResponse.json(
          { success: false, error: GENERIC_VERIFY_ERROR, retryAfterSeconds: retryAfter },
          { status: 429, headers: { 'Retry-After': String(retryAfter) } }
        );
      }
    }

    const failWith = async (error: string, status = 401) => {
      await recordFailedAttempt(
        ipKey,
        OTP_VERIFY_IP_MAX_ATTEMPTS,
        OTP_VERIFY_WINDOW_MS,
        OTP_VERIFY_LOCKOUT_MS
      );
      await recordFailedAttempt(
        idKey,
        OTP_VERIFY_ID_MAX_ATTEMPTS,
        OTP_VERIFY_WINDOW_MS,
        OTP_VERIFY_LOCKOUT_MS
      );
      return NextResponse.json({ success: false, error }, { status });
    };

    let result;
    try {
      result = await verifyOtpForLogin(identifier, code, sessionHours, body.next);
    } catch (error) {
      if (error instanceof UnifiedAuthError) {
        if (error.code === 'INACTIVE') {
          return await failWith(error.message, 403);
        }
        return await failWith(error.message || GENERIC_OTP_FAILURE);
      }
      console.error('Error verificando OTP de login:', error);
      return NextResponse.json(
        { success: false, error: 'No fue posible iniciar sesión' },
        { status: 500 }
      );
    }

    // Handoff PRIMERO (mismo contrato que los demás endpoints de sesión).
    const sessionId = req.headers.get('x-session-id');
    if (sessionId && result.user?.id) {
      try {
        await transferSessionDataToUser(sessionId, result.user.id);
      } catch (e) {
        console.error('Error transfiriendo sesión al usuario:', e);
        return NextResponse.json(
          {
            success: false,
            error:
              'No fue posible completar el inicio de sesión. Tus datos como invitado permanecen intactos; intenta de nuevo.',
          },
          { status: 500 }
        );
      }
    }

    await Promise.all([resetRateLimit(ipKey), resetRateLimit(idKey)]);

    await setSessionCookie(result.token, sessionHours * 60 * 60);
    await rotateGuestSessionCookie();

    return NextResponse.json({
      success: true,
      data: { user: result.user, redirectTo: result.redirectTo },
      message: 'Inicio de sesión exitoso',
    });
  } catch (error) {
    console.error('Error verificando OTP de login:', error);
    return NextResponse.json(
      { success: false, error: 'No fue posible iniciar sesión' },
      { status: 500 }
    );
  }
}
