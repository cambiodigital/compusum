import { NextResponse } from 'next/server';
import { isPhoneOtpLoginEnabled, loginWithPhone } from '@/lib/auth-dual';
import {
  setSessionCookie,
  SESSION_DURATION_DAYS_REMEMBER_ME,
  SESSION_DURATION_HOURS_DEFAULT,
  rotateGuestSessionCookie,
} from '@/lib/auth';
import { toAuthUserDTO } from '@/lib/user-dto';
import { transferSessionDataToUser } from '@/lib/checkout';

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

    // Transferencia atómica guest→cuenta. La rotación del guest session SOLO
    // ocurre si la transferencia tuvo éxito: si falla, la sesión guest conserva
    // acceso a su carrito/pedidos (sin estados inaccesibles).
    const sessionId = req.headers.get('x-session-id');
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

    // Sanitizado en el borde: NUNCA exponer hash ni datos internos aunque la
    // capa de lib se regrese algún día.
    const user = toAuthUserDTO(result.user);
    return NextResponse.json({
      success: true,
      data: {
        user,
      },
    });
  } catch (error: any) {
    return NextResponse.json({ success: false, error: error.message }, { status: 401 });
  }
}
