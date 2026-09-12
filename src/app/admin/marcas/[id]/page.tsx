import { redirect, notFound } from "next/navigation";
import { requireAdminUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Header } from "@/components/admin/header";
import { BrandForm } from "@/components/admin/brand-form";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function EditBrandPage({ params }: Props) {
  const user = await requireAdminUser();

  if (!user) {
    redirect("/admin/login");
  }

  const { id } = await params;

  const brand = await db.brand.findUnique({
    where: { id },
  });

  if (!brand) {
    notFound();
  }

  return (
    <>
      <Header 
        title="Editar marca" 
        subtitle={`Editando: ${brand.name}`} 
      />
      
      <div className="p-4 sm:p-6">
        <BrandForm brand={brand} />
      </div>
    </>
  );
}
