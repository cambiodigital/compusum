import { redirect } from "next/navigation";
import { requireAdminUser } from "@/lib/auth";
import { db } from "@/lib/db";
import { Header } from "@/components/admin/header";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { SafeProductImage } from "@/components/store/safe-product-image";
import { normalizeProductImagePath } from "@/lib/product-fallbacks";
import Link from "next/link";
import {
  Package,
  FolderTree,
  Tags,
  Star,
  Sparkles,
  AlertCircle,
  TrendingUp,
  Eye,
  Plus,
  ArrowRight,
} from "lucide-react";

export default async function AdminDashboard() {
  const user = await requireAdminUser();

  if (!user) {
    redirect("/admin/login");
  }

  // Fetch statistics
  const [
    productsCount,
    activeProductsCount,
    inactiveProductsCount,
    featuredProductsCount,
    newProductsCount,
    categoriesCount,
    categoriesWithProducts,
    brandsCount,
    recentProducts,
  ] = await Promise.all([
    db.product.count(),
    db.product.count({ where: { isActive: true } }),
    db.product.count({ where: { isActive: false } }),
    db.product.count({ where: { isFeatured: true, isActive: true } }),
    db.product.count({ where: { isNew: true, isActive: true } }),
    db.category.count(),
    db.category.findMany({
      include: { _count: { select: { products: true } } },
    }),
    db.brand.count({ where: { isActive: true } }),
    db.product.findMany({
      take: 5,
      orderBy: { createdAt: "desc" },
      include: {
        category: { select: { name: true } },
        brand: { select: { name: true } },
        images: { where: { isPrimary: true }, take: 1 },
      },
    }),
  ]);

  // Find categories with 0 products
  const emptyCategories = categoriesWithProducts.filter((c) => c._count.products === 0);

  const stats = [
    {
      title: "Productos Activos",
      value: activeProductsCount,
      icon: Package,
      color: "text-blue-600",
      bgColor: "bg-blue-50",
    },
    {
      title: "Productos Inactivos",
      value: inactiveProductsCount,
      icon: Package,
      color: "text-slate-500",
      bgColor: "bg-slate-100",
    },
    {
      title: "Destacados",
      value: featuredProductsCount,
      icon: Star,
      color: "text-amber-600",
      bgColor: "bg-amber-50",
    },
    {
      title: "Nuevos",
      value: newProductsCount,
      icon: Sparkles,
      color: "text-green-600",
      bgColor: "bg-green-50",
    },
    {
      title: "Categorías",
      value: categoriesCount,
      icon: FolderTree,
      color: "text-purple-600",
      bgColor: "bg-purple-50",
    },
    {
      title: "Marcas",
      value: brandsCount,
      icon: Tags,
      color: "text-cyan-600",
      bgColor: "bg-cyan-50",
    },
  ];

  return (
    <>
      <Header title="Dashboard" subtitle="Resumen general de tu tienda" />

      <div className="p-4 sm:p-6 lg:ml-0">
        {/* Alert for empty categories */}
        {emptyCategories.length > 0 && (
          <div className="mb-6 bg-amber-50 border border-amber-200 rounded-lg p-4 flex items-start gap-3">
            <AlertCircle className="h-5 w-5 text-amber-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-medium text-amber-800">
                {emptyCategories.length} categoría{emptyCategories.length > 1 ? "s" : ""} sin productos
              </p>
              <p className="text-sm text-amber-700 mt-1">
                {emptyCategories.map((c) => c.name).join(", ")}
              </p>
            </div>
          </div>
        )}

        {/* Stats Grid */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 mb-8">
          {stats.map((stat) => (
            <Card key={stat.title} className="hover:shadow-md transition-shadow">
              <CardContent className="p-4">
                <div className={`w-10 h-10 ${stat.bgColor} rounded-lg flex items-center justify-center mb-3`}>
                  <stat.icon className={`h-5 w-5 ${stat.color}`} />
                </div>
                <p className="text-2xl font-bold text-slate-900">{stat.value}</p>
                <p className="text-xs text-slate-500 mt-0.5">{stat.title}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {/* Quick Actions */}
        <div className="mb-8">
          <h2 className="text-lg font-semibold text-slate-900 mb-4">Acciones rápidas</h2>
          <div className="flex flex-wrap gap-3">
            <Button asChild>
              <Link href="/admin/productos/nuevo">
                <Plus className="h-4 w-4 mr-2" />
                Nuevo producto
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href="/admin/categorias">
                <FolderTree className="h-4 w-4 mr-2" />
                Gestionar categorías
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href="/admin/marcas">
                <Tags className="h-4 w-4 mr-2" />
                Gestionar marcas
              </Link>
            </Button>
            <Button variant="outline" asChild>
              <Link href="/" target="_blank">
                <Eye className="h-4 w-4 mr-2" />
                Ver sitio web
              </Link>
            </Button>
          </div>
        </div>

        {/* Recent Products */}
        <Card>
          <CardHeader className="flex flex-row items-center justify-between">
            <CardTitle className="text-lg">Productos recientes</CardTitle>
            <Button variant="ghost" size="sm" asChild>
              <Link href="/admin/productos">
                Ver todos
                <ArrowRight className="h-4 w-4 ml-1" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            <div className="space-y-3">
              {recentProducts.map((product) => (
                <div
                  key={product.id}
                  className="flex items-center gap-4 p-3 bg-slate-50 rounded-lg hover:bg-slate-100 transition-colors"
                >
                  {/* Image */}
                  <div className="relative w-12 h-12 bg-slate-200 rounded-lg flex items-center justify-center flex-shrink-0 overflow-hidden">
                    <SafeProductImage
                      src={normalizeProductImagePath(product.images[0]?.imagePath)}
                      alt={product.name}
                      fill
                      className="object-cover"
                      sizes="48px"
                      fallbackText="próximamente"
                      preventNotFoundLog
                    />
                  </div>

                  {/* Info */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <p className="font-medium text-slate-900 truncate">{product.name}</p>
                      {product.isFeatured && (
                        <Badge variant="secondary" className="text-xs bg-amber-100 text-amber-700">
                          Destacado
                        </Badge>
                      )}
                      {product.isNew && (
                        <Badge variant="secondary" className="text-xs bg-green-100 text-green-700">
                          Nuevo
                        </Badge>
                      )}
                    </div>
                    <div className="flex items-center gap-2 text-xs text-slate-500">
                      <span>{product.category?.name || "Sin categoría"}</span>
                      {product.brand && (
                        <>
                          <span>•</span>
                          <span>{product.brand.name}</span>
                        </>
                      )}
                    </div>
                  </div>

                  {/* Status */}
                  <div className="flex items-center gap-2">
                    {product.isActive ? (
                      <Badge variant="outline" className="text-green-600 border-green-200">
                        Activo
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="text-slate-500">
                        Inactivo
                      </Badge>
                    )}
                    <Button variant="ghost" size="sm" asChild>
                      <Link href={`/admin/productos/${product.id}`}>
                        Editar
                      </Link>
                    </Button>
                  </div>
                </div>
              ))}

              {recentProducts.length === 0 && (
                <div className="text-center py-8 text-slate-500">
                  <Package className="h-12 w-12 mx-auto text-slate-300 mb-3" />
                  <p>No hay productos aún</p>
                  <Button variant="link" asChild className="mt-2">
                    <Link href="/admin/productos/nuevo">Crear primer producto</Link>
                  </Button>
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
