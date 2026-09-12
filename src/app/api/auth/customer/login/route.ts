import { NextRequest, NextResponse } from 'next/server';
import { isPhoneOtpLoginEnabled, loginWithPhone, loginWithPassword } from '@/lib/auth-dual';
import {
  setSessionCookie,
  SESSION_DURATION_DAYS_REMEMBER_ME,
  SESSION_DURATION_HOURS_DEFAULT,
  rotateGuestSessionCookie,
} from '@/lib/auth';
import { transferSessionDataToUser } from '@/lib/checkout';
import { toAuthUserDTO } from '@/lib/user-dto';
import { checkRateLimit, recordFailedAttempt, resetRateLimit, getClientIp } from '@/lib/rate-limit';

type LoginMethod = 'phone' | 'password';

// Rate limiting PERSISTENTE (tabla RateLimit; no en memoria) por IP e
// identidad intentada, con reset al lograr autenticar.
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_LOCKOUT_MS = 10 * 60 * 1000;

function identityKey(phoneOrEmail: string): string {
  return `customer-login:id:${phoneOrEmail.trim().toLowerCase().slice(0, 120)}`;
}

export async function POST(req: NextRequest) {
  try {
    const ip = getClientIp(req);
    const ipKey = `customer-login:ip:${ip}`;

    const body = await req.json().catch(() => ({}));
    const method = (body.method as LoginMethod) || 'phone';
    const rememberMe = Boolean(body.rememberMe);
    const sessionHours = rememberMe
      ? SESSION_DURATION_DAYS_REMEMBER_ME * 24
      : SESSION_DURATION_HOURS_DEFAULT;

    const identifier =
      method === 'phone' ? String(body.phone ?? '') : String(body.phoneOrEmail ?? '');
    const idKey = identifier ? identityKey(identifier) : null;

    // Verifica límite por IP y por identidad intentada
    for (const key of [ipKey, ...(idKey ? [idKey] : [])]) {
      const limit = await checkRateLimit(key, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS);
      if (limit.isBlocked) {
        return NextResponse.json(
          {
            success: false,
            error: 'Demasiados intentos. Intenta de nuevo en unos minutos.',
            retryAfterSeconds: limit.retryAfterSeconds,
          },
          { status: 429 }
        );
      }
    }

    if (method === 'phone' && !isPhoneOtpLoginEnabled()) {
      return NextResponse.json(
        { success: false, error: 'Inicio de sesión por OTP no disponible. Configura Twilio Verify.' },
        { status: 503 }
      );
    }

    const sessionId = req.headers.get('x-session-id');

    const failWith = async (error: string, status = 401) => {
      await recordFailedAttempt(ipKey, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS, LOGIN_LOCKOUT_MS);
      if (idKey) {
        await recordFailedAttempt(idKey, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS, LOGIN_LOCKOUT_MS);
      }
      return NextResponse.json({ success: false, error }, { status });
    };

    const completeLogin = async (result: { token: string; user: any }) => {
      await setSessionCookie(result.token, sessionHours * 60 * 60);

      // Transferencia atómica guest→cuenta. La rotación del guest session SOLO
      // ocurre si la transferencia tuvo éxito: si falla, la sesión guest conserva
      // acceso a su carrito/pedidos (sin estados inaccesibles).
      let handoffOk = true;
      if (sessionId && result.user?.id) {
        try {
          await transferSessionDataToUser(sessionId, result.user.id);
        } catch (e) {
          handoffOk = false;
          console.error('Error transfiriendo sesión al usuario:', e);
        }
      }
      if (handoffOk) {
        await rotateGuestSessionCookie();
      }

      await resetRateLimit(ipKey);
      if (idKey) await resetRateLimit(idKey);

      // Sanitizado en el borde (src/lib/user-dto.ts): nunca incluye hash de
      // contraseña, passwordChangedAt ni relaciones internas.
      return NextResponse.json({
        success: true,
        data: { user: toAuthUserDTO(result.user as Record<string, unknown>) },
      });
    };

    if (method === 'phone') {
      const { phone, otpCode } = body;
      if (!phone || !otpCode) {
        return NextResponse.json(
          { success: false, error: 'Phone y OTP son requeridos' },
          { status: 400 }
        );
      }

      try {
        const result = await loginWithPhone(phone, otpCode, sessionHours);
        return await completeLogin(result);
      } catch (error: any) {
        return await failWith(error?.message || 'Código inválido o expirado');
      }
    }

    const { phoneOrEmail, password } = body;
    if (!phoneOrEmail || !password) {
      return NextResponse.json(
        { success: false, error: 'Teléfono/email y contraseña son requeridos' },
        { status: 400 }
      );
    }

    try {
      const result = await loginWithPassword(phoneOrEmail, password, sessionHours);
      return await completeLogin(result);
    } catch (error: any) {
      return await failWith(error?.message || 'Credenciales inválidas');
    }
  } catch (error: any) {
    console.error('Customer login error:', error);
    return NextResponse.json(
      { success: false, error: error?.message || 'No fue posible iniciar sesión' },
      { status: 500 }
    );
  }
}
