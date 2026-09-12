import { redirect } from "next/navigation";
import { requireAdminUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Header } from "@/components/admin/header";
import { Button } from "@/components/ui/button";
import { AdminBrandsTable } from "@/components/admin/brands-table";
import Link from "next/link";
import { Plus } from "lucide-react";

export default async function AdminBrandsPage() {
  const user = await requireAdminUser();

  if (!user) {
    redirect("/admin/login");
  }

  const brands = await db.brand.findMany({
    include: {
      _count: {
        select: { products: true },
      },
    },
    orderBy: { sortOrder: "asc" },
  });

  return (
    <>
      <Header title="Marcas" subtitle={`${brands.length} marcas en total`} />

      <div className="p-4 sm:p-6">
        {/* Actions */}
        <div className="flex justify-end mb-6">
          <Button asChild>
            <Link href="/admin/marcas/nueva">
              <Plus className="h-4 w-4 mr-2" />
              Nueva marca
            </Link>
          </Button>
        </div>

        <AdminBrandsTable brands={brands} />
      </div>
    </>
  );
}
