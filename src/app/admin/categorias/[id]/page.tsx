import { redirect, notFound } from "next/navigation";
import { requireAdminUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Header } from "@/components/admin/header";
import { CategoryForm } from "@/components/admin/category-form";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function EditCategoryPage({ params }: Props) {
  const user = await requireAdminUser();

  if (!user) {
    redirect("/admin/login");
  }

  const { id } = await params;

  const [category, categories] = await Promise.all([
    db.category.findUnique({
      where: { id },
    }),
    db.category.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  if (!category) {
    notFound();
  }

  return (
    <>
      <Header 
        title="Editar categoría" 
        subtitle={`Editando: ${category.name}`} 
      />
      
      <div className="p-4 sm:p-6">
        <CategoryForm category={category} categories={categories} />
      </div>
    </>
  );
}
