import { NextResponse } from 'next/server';
import { deleteSession, clearSessionCookie, SESSION_COOKIE_NAME_EXPORT, rotateGuestSessionCookie } from '@/lib/auth';
import { cookies } from 'next/headers';

// POST /api/auth/logout - Logout
export async function POST() {
  try {
    // Get current session token
    const cookieStore = await cookies();
    const token = cookieStore.get(SESSION_COOKIE_NAME_EXPORT)?.value;

    // Delete session from store
    if (token) {
      await deleteSession(token);
    }

    // Clear session cookie
    await clearSessionCookie();

    // Rotar la sesión anónima (guest session) para invalidar el historial anterior en el navegador
    await rotateGuestSessionCookie();

    return NextResponse.json({
      success: true,
      message: 'Sesión cerrada exitosamente',
    });
  } catch (error) {
    console.error('Error during logout:', error);
    return NextResponse.json(
      { success: false, error: 'Error al cerrar sesión' },
      { status: 500 }
    );
  }
}
