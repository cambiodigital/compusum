import { redirect } from "next/navigation";
import { requireAdminUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Header } from "@/components/admin/header";
import { CategoryForm } from "@/components/admin/category-form";

export default async function NewCategoryPage() {
  const user = await requireAdminUser();

  if (!user) {
    redirect("/admin/login");
  }

  const categories = await db.category.findMany({
    select: { id: true, name: true },
    orderBy: { name: "asc" },
  });

  return (
    <>
      <Header title="Nueva categoría" subtitle="Crea una nueva categoría de productos" />
      
      <div className="p-4 sm:p-6">
        <CategoryForm categories={categories} />
      </div>
    </>
  );
}
