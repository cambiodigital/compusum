import { NextRequest, NextResponse } from 'next/server';
import {
  setSessionCookie,
  SESSION_DURATION_DAYS_REMEMBER_ME,
  SESSION_DURATION_HOURS_DEFAULT,
  rotateGuestSessionCookie,
} from '@/lib/auth';
import { transferSessionDataToUser } from '@/lib/checkout';
import {
  loginWithPasswordUnified,
  normalizeIdentifier,
  UnifiedAuthError,
} from '@/lib/unified-auth';
import {
  checkRateLimit,
  recordFailedAttempt,
  resetRateLimit,
  getClientIp,
} from '@/lib/rate-limit';

// ============================================================================
// POST /api/auth/login — LOGIN UNIFICADO POR CONTRASEÑA (cualquier rol).
//
// Punto de entrada único de /ingresar para CUSTOMER, admin, editor y AGENT.
// Acepta `identifier` (email o teléfono) — también `email`/`phone` por
// compatibilidad con clientes antiguos — y devuelve `redirectTo` calculado
// server-side según el rol (el frontend NO decide el destino).
//
// Legacy: este endpoint antes era SOLO backoffice (email+password, keys
// `admin-login:*`). Los clientes antiguos que posteen {email,password} siguen
// funcionando; la política de intentos es la del login de cliente previo.
// ============================================================================

// Rate limiting PERSISTENTE (tabla RateLimit) por IP e identidad intentada,
// con reset al lograr autenticar. Mismo umbral que tenía el login de cliente.
const LOGIN_MAX_ATTEMPTS = 10;
const LOGIN_WINDOW_MS = 10 * 60 * 1000;
const LOGIN_LOCKOUT_MS = 10 * 60 * 1000;

function identityKey(identifier: string): string {
  const { email, phone } = normalizeIdentifier(identifier);
  const normalized = email ?? phone ?? identifier.trim().toLowerCase().slice(0, 120);
  return `login:id:${normalized}`;
}

function tooManyRequests(retryAfterSeconds?: number): NextResponse {
  const retryAfter = retryAfterSeconds || 600;
  return NextResponse.json(
    {
      success: false,
      error: 'Demasiados intentos. Intenta de nuevo en unos minutos.',
      retryAfterSeconds: retryAfter,
    },
    { status: 429, headers: { 'Retry-After': String(retryAfter) } }
  );
}

export async function POST(req: NextRequest) {
  try {
    const ip = getClientIp(req);
    const ipKey = `login:ip:${ip}`;

    const body = await req.json().catch(() => ({}));
    // Compatibilidad: {email} (login admin previo), {identifier} (unificado).
    const identifier = String(body.identifier ?? body.email ?? body.phone ?? '');
    const password = typeof body.password === 'string' ? body.password : '';
    const rememberMe = Boolean(body.rememberMe);
    const sessionHours = rememberMe
      ? SESSION_DURATION_DAYS_REMEMBER_ME * 24
      : SESSION_DURATION_HOURS_DEFAULT;

    if (!identifier || !password) {
      return NextResponse.json(
        { success: false, error: 'Identificador y contraseña son requeridos' },
        { status: 400 }
      );
    }

    const idKey = identityKey(identifier);

    // Verifica límite por IP y por identidad intentada ANTES de tocar la DB.
    for (const key of [ipKey, idKey]) {
      const limit = await checkRateLimit(key, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS);
      if (limit.isBlocked) {
        return tooManyRequests(limit.retryAfterSeconds);
      }
    }

    const failWith = async (error: string, status = 401) => {
      await recordFailedAttempt(ipKey, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS, LOGIN_LOCKOUT_MS);
      await recordFailedAttempt(idKey, LOGIN_MAX_ATTEMPTS, LOGIN_WINDOW_MS, LOGIN_LOCKOUT_MS);
      return NextResponse.json({ success: false, error }, { status });
    };

    let result;
    try {
      result = await loginWithPasswordUnified(identifier, password, sessionHours, body.next);
    } catch (error) {
      if (error instanceof UnifiedAuthError) {
        if (error.code === 'INACTIVE') {
          // Estado revelable solo a quien demostró poseer las credenciales.
          return await failWith(error.message, 403);
        }
        return await failWith(error.message);
      }
      console.error('Error durante el login unificado:', error);
      return NextResponse.json(
        { success: false, error: 'No fue posible iniciar sesión' },
        { status: 500 }
      );
    }

    // Handoff PRIMERO: si la transferencia guest→cuenta falla, NO se publica
    // la cookie de sesión, NO se rota la guest y NO se resetean los límites
    // de rate. Publicar sesión sin handoff dejaría al usuario autenticado con
    // sus datos guest invisibles bajo la cuenta (identidad userId primero).
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
    console.error('Error durante el login unificado:', error);

    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      if (
        message.includes('database') ||
        message.includes('prisma') ||
        message.includes('relation') ||
        message.includes('table')
      ) {
        return NextResponse.json(
          {
            success: false,
            error: 'La base de datos no está lista. Ejecuta migraciones y seed del admin.',
          },
          { status: 503 }
        );
      }
    }

    return NextResponse.json(
      { success: false, error: 'Error al iniciar sesión' },
      { status: 500 }
    );
  }
}
