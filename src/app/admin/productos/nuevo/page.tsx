import { redirect } from "next/navigation";
import { requireAdminUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Header } from "@/components/admin/header";
import { ProductForm } from "@/components/admin/product-form";

export default async function NewProductPage() {
  const user = await requireAdminUser();

  if (!user) {
    redirect("/admin/login");
  }

  const [categories, brands] = await Promise.all([
    db.category.findMany({
      select: { id: true, name: true },
      where: { isActive: true },
      orderBy: { name: "asc" },
    }),
    db.brand.findMany({
      select: { id: true, name: true },
      where: { isActive: true },
      orderBy: { name: "asc" },
    }),
  ]);

  return (
    <>
      <Header title="Nuevo producto" subtitle="Crea un nuevo producto en el catálogo" />
      
      <div className="p-4 sm:p-6">
        <ProductForm categories={categories} brands={brands} />
      </div>
    </>
  );
}
