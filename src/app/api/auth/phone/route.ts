import { NextResponse } from 'next/server';
import { isPhoneOtpLoginEnabled, loginWithPhone } from '@/lib/auth-dual';
import {
  setSessionCookie,
  SESSION_DURATION_DAYS_REMEMBER_ME,
  SESSION_DURATION_HOURS_DEFAULT,
  rotateGuestSessionCookie,
} from '@/lib/auth';
import { transferSessionCartToUser, transferSessionOrderToUser } from '@/lib/order-cart-upsert';

export async function POST(req: Request) {
  try {
    if (!isPhoneOtpLoginEnabled()) {
      return NextResponse.json(
        { success: false, error: 'Inicio de sesión por OTP no disponible. Configura Twilio Verify.' },
        { status: 503 }
      );
    }

    const { phone, otpCode, rememberMe } = await req.json();

    if (!phone || !otpCode) {
      return NextResponse.json({ error: 'Phone and OTP code are required' }, { status: 400 });
    }

    const sessionHours = rememberMe
      ? SESSION_DURATION_DAYS_REMEMBER_ME * 24
      : SESSION_DURATION_HOURS_DEFAULT;

    const result = await loginWithPhone(phone, otpCode, sessionHours);
    await setSessionCookie(result.token, sessionHours * 60 * 60);

    // Transferir carrito y pedidos de la sesión de invitado al usuario
    const sessionId = req.headers.get('x-session-id');
    if (sessionId && result.user?.id) {
      await Promise.all([
        transferSessionCartToUser(sessionId, result.user.id),
        transferSessionOrderToUser(sessionId, result.user.id),
      ]).catch((e) => console.error('Error transfiriendo sesión al usuario:', e));
    }
    await rotateGuestSessionCookie();

    return NextResponse.json({
      success: true,
      data: {
        user: result.user,
      },
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 401 });
  }
}
