import { NextResponse } from 'next/server';
import { db } from '@/lib/db';
import { verifyPassword, createSession, setSessionCookie } from '@/lib/auth';
import { transferSessionCartToUser, transferSessionOrderToUser } from '@/lib/order-cart-upsert';
import {
  getClientIp,
  checkRateLimit,
  recordFailedAttempt,
  resetRateLimit,
} from '@/lib/rate-limit';

// POST /api/auth/login - Login admin user
export async function POST(request: Request) {
  try {
    const clientIp = getClientIp(request);
    const ipKey = `admin-login:ip:${clientIp}`;

    // Verificar rate limit por IP antes de consultar usuario o password
    const ipCheck = await checkRateLimit(ipKey);
    if (ipCheck.isBlocked) {
      const retryAfter = ipCheck.retryAfterSeconds || 900;
      return NextResponse.json(
        {
          success: false,
          error: 'Demasiados intentos fallidos. Intenta de nuevo más tarde.',
          retryAfter,
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(retryAfter),
          },
        }
      );
    }

    const body = await request.json();
    const { email, password } = body;

    // Validar campos requeridos
    if (!email || !password) {
      return NextResponse.json(
        { success: false, error: 'Email y contraseña son requeridos' },
        { status: 400 }
      );
    }

    const normalizedEmail = String(email).toLowerCase().trim();
    const emailKey = `admin-login:email:${normalizedEmail}`;

    // Verificar rate limit por email
    const emailCheck = await checkRateLimit(emailKey);
    if (emailCheck.isBlocked) {
      const retryAfter = emailCheck.retryAfterSeconds || 900;
      return NextResponse.json(
        {
          success: false,
          error: 'Demasiados intentos fallidos. Intenta de nuevo más tarde.',
          retryAfter,
        },
        {
          status: 429,
          headers: {
            'Retry-After': String(retryAfter),
          },
        }
      );
    }

    // Buscar usuario por email
    const user = await db.user.findUnique({
      where: { email: normalizedEmail },
    });

    if (!user) {
      await Promise.all([
        recordFailedAttempt(ipKey),
        recordFailedAttempt(emailKey),
      ]);
      return NextResponse.json(
        { success: false, error: 'Credenciales inválidas' },
        { status: 401 }
      );
    }

    // Verificar si el usuario está activo
    if (!user.isActive) {
      await Promise.all([
        recordFailedAttempt(ipKey),
        recordFailedAttempt(emailKey),
      ]);
      return NextResponse.json(
        { success: false, error: 'Usuario desactivado' },
        { status: 401 }
      );
    }

    // Verificar contraseña
    const isValidPassword = await verifyPassword(password, user.password);

    if (!isValidPassword) {
      await Promise.all([
        recordFailedAttempt(ipKey),
        recordFailedAttempt(emailKey),
      ]);
      return NextResponse.json(
        { success: false, error: 'Credenciales inválidas' },
        { status: 401 }
      );
    }

    // Reseteo de contadores tras autenticación exitosa
    await Promise.all([
      resetRateLimit(ipKey),
      resetRateLimit(emailKey),
    ]);

    // Crear sesión
    const token = await createSession(user.id);
    await setSessionCookie(token);

    // Transferir carrito y pedidos de la sesión de invitado al usuario
    const sessionId = request.headers.get('x-session-id');
    if (sessionId) {
      await Promise.all([
        transferSessionCartToUser(sessionId, user.id),
        transferSessionOrderToUser(sessionId, user.id),
      ]).catch((e) => console.error('Error transfiriendo sesión al usuario:', e));
    }
    await rotateGuestSessionCookie();

    // Actualizar último login
    await db.user.update({
      where: { id: user.id },
      data: { lastLogin: new Date() },
    });

    return NextResponse.json({
      success: true,
      data: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
      },
      message: 'Inicio de sesión exitoso',
    });
  } catch (error) {
    console.error('Error durante el login:', error);

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
            error: 'La base de datos no está lista. Ejecuta migraciones y seed del admin.'
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
