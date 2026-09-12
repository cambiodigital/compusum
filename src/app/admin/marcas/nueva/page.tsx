import { redirect } from "next/navigation";
import { requireAdminUser } from "@/lib/auth";
import { Header } from "@/components/admin/header";
import { BrandForm } from "@/components/admin/brand-form";

export default async function NewBrandPage() {
  const user = await requireAdminUser();

  if (!user) {
    redirect("/admin/login");
  }

  return (
    <>
      <Header title="Nueva marca" subtitle="Crea una nueva marca de productos" />
      
      <div className="p-4 sm:p-6">
        <BrandForm />
      </div>
    </>
  );
}
