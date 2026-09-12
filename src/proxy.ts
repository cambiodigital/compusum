import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { isBackofficeRole, isAgentRole } from "@/lib/roles";

// Routes that don't require authentication
const publicRoutes = ["/admin/login"];

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Generar o mantener sessionId para usuarios no autenticados.
  // IMPORTANTE: usar NextResponse.next({ request: { headers } }) para que
  // el header x-session-id llegue al route handler (no solo al browser).
  let sessionId = request.cookies.get("x-session-id")?.value;
  const isNewSession = !sessionId;
  if (!sessionId) {
    sessionId = globalThis.crypto.randomUUID();
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-session-id", sessionId);

  // Check for catalog mode on API catalog endpoints
  if (pathname.startsWith("/api/catalog/products")) {
    const response = NextResponse.next({ request: { headers: requestHeaders } });
    response.headers.set("x-middleware-catalog", "true");
    if (isNewSession) {
      response.cookies.set("x-session-id", sessionId, {
        httpOnly: false,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 7 * 24 * 60 * 60,
        path: "/",
      });
    }
    return response;
  }

  const response = NextResponse.next({ request: { headers: requestHeaders } });

  // Persistir la cookie solo si es nueva (evita Set-Cookie innecesarios en cada request)
  if (isNewSession) {
    response.cookies.set("x-session-id", sessionId, {
      httpOnly: false, // Accesible desde cliente para APIs
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60, // 7 días
      path: "/",
    });
  }

  const isAdminPage = pathname.startsWith("/admin");
  const isAdminApi = pathname.startsWith("/api/admin");

  // Only handle /admin or /api/admin routes further
  if (!isAdminPage && !isAdminApi) {
    return response;
  }

  // Allow public routes
  if (publicRoutes.some((route) => pathname.startsWith(route))) {
    return response;
  }

  // Check for session token cookie
  const sessionToken = request.cookies.get("session_token")?.value;

  if (!sessionToken) {
    if (isAdminApi) {
      return NextResponse.json(
        { success: false, error: "No autorizado" },
        { status: 401 }
      );
    }
    const loginUrl = new URL("/admin/login", request.url);
    return NextResponse.redirect(loginUrl);
  }

  try {
    const session = await db.session.findUnique({
      where: { token: sessionToken },
      include: {
        user: {
          select: { id: true, role: true, isActive: true },
        },
      },
    });

    if (!session || session.expiresAt < new Date() || !session.user || !session.user.isActive) {
      if (isAdminApi) {
        return NextResponse.json(
          { success: false, error: "No autorizado" },
          { status: 401 }
        );
      }
      const loginUrl = new URL("/admin/login", request.url);
      return NextResponse.redirect(loginUrl);
    }

    if (!isBackofficeRole(session.user.role)) {
      if (isAdminApi) {
        return NextResponse.json(
          { success: false, error: "Acceso denegado: se requiere rol administrativo" },
          { status: 403 }
        );
      }
      const loginUrl = new URL("/admin/login", request.url);
      return NextResponse.redirect(loginUrl);
    }

    // AGENT comercial: allowlist estricta de rutas del backoffice. Todo lo
    // demás bajo /admin o /api/admin queda bloqueado en el borde (las rutas
    // permitidas además re-verifican rol y aplican su alcance por asesor).
    if (isAgentRole(session.user.role)) {
      const allowed =
        pathname === "/admin" ||
        pathname.startsWith("/admin/clientes") ||
        pathname.startsWith("/admin/pedidos") ||
        pathname.startsWith("/api/admin/customers") ||
        pathname.startsWith("/api/admin/orders");
      if (!allowed) {
        if (isAdminApi) {
          return NextResponse.json(
            { success: false, error: "Acceso denegado: se requiere rol administrativo" },
            { status: 403 }
          );
        }
        return NextResponse.redirect(new URL("/admin", request.url));
      }
    }
  } catch (error) {
    console.error("Error verificando sesión/rol en proxy:", error);
  }

  return response;
}

export const config = {
  matcher: ["/admin/:path*", "/api/catalog/products", "/api/:path*"],
};