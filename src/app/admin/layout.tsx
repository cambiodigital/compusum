import { redirect } from "next/navigation";
import { getCurrentUser, isAdminRole } from "@/lib/auth";
import { AdminLayoutClient } from "@/components/admin/admin-layout-client";

export const dynamic = "force-dynamic";

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const user = await getCurrentUser();

  if (user && !isAdminRole(user.role)) {
    redirect("/admin/login");
  }

  return (
    <AdminLayoutClient user={user || { name: "Usuario", email: "", role: "guest" }}>
      {children}
    </AdminLayoutClient>
  );
}
