import { redirect, notFound } from "next/navigation";
import { requireAdminUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Header } from "@/components/admin/header";
import { ProductForm } from "@/components/admin/product-form";

interface Props {
  params: Promise<{ id: string }>;
}

export default async function EditProductPage({ params }: Props) {
  const user = await requireAdminUser();

  if (!user) {
    redirect("/admin/login");
  }

  const { id } = await params;

  const [product, categories, brands] = await Promise.all([
    db.product.findUnique({
      where: { id },
      include: {
        images: {
          orderBy: { sortOrder: "asc" },
        },
      },
    }),
    db.category.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    db.brand.findMany({
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
  ]);

  if (!product) {
    notFound();
  }

  return (
    <>
      <Header 
        title="Editar producto" 
        subtitle={`Editando: ${product.name}`} 
      />
      
      <div className="p-4 sm:p-6">
        <ProductForm product={product} categories={categories} brands={brands} />
      </div>
    </>
  );
}
