import { redirect } from "next/navigation";
import { getCurrentUser, isBackofficeRole } from "@/lib/auth";
import { AdminLayoutClient } from "@/components/admin/admin-layout-client";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();

  // Un cliente autenticado (role CUSTOMER) NO puede ir a /admin/login:
  // esa ruta vive dentro de este mismo segmento /admin, así que este layout
  // también se le aplica y redirigir a /admin/login produce un bucle de
  // redirección infinito (página en blanco + ERR_INSUFFICIENT_RESOURCES).
  // Se le devuelve al storefront; /admin/login queda solo para invitados.
  if (user && !isBackofficeRole(user.role)) {
    redirect("/");
  }

  return (
    <AdminLayoutClient user={user || { name: "Usuario", email: "", role: "guest" }}>
      {children}
    </AdminLayoutClient>
  );
}
