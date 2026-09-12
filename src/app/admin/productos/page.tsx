import { redirect } from "next/navigation";
import { requireAdminUser } from "@/lib/auth";
import { Header } from "@/components/admin/header";
import { AdminProductsTable } from "@/components/admin/products-table";

export default async function AdminProductsPage() {
  const user = await requireAdminUser();

  if (!user) {
    redirect("/admin/login");
  }

  return (
    <>
      <Header title="Productos" subtitle="Gestión de productos" />
      <AdminProductsTable />
    </>
  );
}
