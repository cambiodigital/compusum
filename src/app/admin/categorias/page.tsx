import { redirect } from "next/navigation";
import { requireAdminUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Header } from "@/components/admin/header";
import { Button } from "@/components/ui/button";
import { AdminCategoriesTable } from "@/components/admin/categories-table";
import Link from "next/link";
import { Plus } from "lucide-react";

export default async function AdminCategoriesPage() {
  const user = await requireAdminUser();

  if (!user) {
    redirect("/admin/login");
  }

  const categories = await db.category.findMany({
    include: {
      _count: {
        select: { products: true },
      },
    },
    orderBy: { sortOrder: "asc" },
  });

  return (
    <>
      <Header title="Categorías" subtitle={`${categories.length} categorías en total`} />

      <div className="p-4 sm:p-6">
        {/* Actions */}
        <div className="flex justify-between items-center mb-6">
          <p className="text-sm text-slate-500">
            Arrastra para reordenar la aparición en la web
          </p>
          <Button asChild>
            <Link href="/admin/categorias/nueva">
              <Plus className="h-4 w-4 mr-2" />
              Nueva categoría
            </Link>
          </Button>
        </div>

        <AdminCategoriesTable categories={categories} />
      </div>
    </>
  );
}
