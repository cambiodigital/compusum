import { NextRequest, NextResponse } from 'next/server';
import { registerCustomer, CustomerAuthError } from '@/lib/customer-auth';
import { setSessionCookie, SESSION_DURATION_HOURS_DEFAULT, rotateGuestSessionCookie } from '@/lib/auth';
import { transferSessionDataToUser } from '@/lib/checkout';
import { toAuthUserDTO } from '@/lib/user-dto';
import { checkRateLimit, recordFailedAttempt, resetRateLimit, getClientIp } from '@/lib/rate-limit';

const REGISTER_MAX_ATTEMPTS = 10;
const REGISTER_WINDOW_MS = 60 * 60 * 1000; // 1 hora
const REGISTER_LOCKOUT_MS = 30 * 60 * 1000;

export async function POST(req: NextRequest) {
  try {
    const ipKey = `register:ip:${getClientIp(req)}`;

    const limit = await checkRateLimit(ipKey, REGISTER_MAX_ATTEMPTS, REGISTER_WINDOW_MS);
    if (limit.isBlocked) {
      return NextResponse.json(
        {
          success: false,
          error: 'Demasiados intentos de registro. Intenta más tarde.',
          retryAfterSeconds: limit.retryAfterSeconds,
        },
        { status: 429 }
      );
    }

    const body = await req.json();
    const { name, email, phone, password, company, taxId } = body ?? {};

    try {
      const result = await registerCustomer({ name, email, phone, password, company, taxId });

      // Handoff PRIMERO: si la transferencia guest→cuenta falla, NO se publica
      // la cookie de sesión, NO se rota la guest y NO se resetea el rate limit.
      // La cuenta persiste INTENCIONALMENTE (sin compensación destructiva):
      // sin sesión publicada, la sesión guest conserva acceso a sus datos y
      // el login posterior completa el handoff.
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
                'Tu cuenta fue creada, pero no pudimos vincular tu sesión de invitado. Inicia sesión para continuar.',
            },
            { status: 500 }
          );
        }
      }

      await resetRateLimit(ipKey);
      await setSessionCookie(result.token, SESSION_DURATION_HOURS_DEFAULT * 60 * 60);
      await rotateGuestSessionCookie();

      return NextResponse.json({
        success: true,
        data: { user: toAuthUserDTO(result.user) },
        message: 'Cuenta creada exitosamente',
      });
    } catch (error) {
      if (error instanceof CustomerAuthError) {
        await recordFailedAttempt(ipKey, REGISTER_MAX_ATTEMPTS, REGISTER_WINDOW_MS, REGISTER_LOCKOUT_MS);
        const status = error.code === 'ACCOUNT_EXISTS' ? 409 : 400;
        return NextResponse.json(
          { success: false, error: error.message, code: error.code },
          { status }
        );
      }
      throw error;
    }
  } catch (error) {
    console.error('Register error:', error);
    return NextResponse.json(
      { success: false, error: 'No fue posible crear la cuenta' },
      { status: 500 }
    );
  }
}
