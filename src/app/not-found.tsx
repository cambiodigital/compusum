import Link from "next/link";
import { ArrowRight, Home, SearchX } from "lucide-react";

import { Header } from "@/components/store/header";
import { Footer } from "@/components/store/footer";
import { WhatsAppButton } from "@/components/store/whatsapp-button";
import { ProductCard } from "@/components/store/product-card";
import { Button } from "@/components/ui/button";
import { searchProducts } from "@/lib/product-search";
import { getCachedGlobalCatalogMode } from "@/lib/product-cache";

export const dynamic = "force-dynamic";

const NEW_PRODUCTS_LIMIT = 8;

export default async function NotFound() {
  // La 404 debe cargar SIEMPRE, aunque la DB falle: el contenido se degrada
  // a la landing con CTAs y sin grilla de productos.
  let globalCatalogMode = false;
  let newProducts: Awaited<ReturnType<typeof searchProducts>>["products"] = [];

  try {
    globalCatalogMode = await getCachedGlobalCatalogMode();
  } catch (error) {
    console.error("NotFound catalogMode query failed", error);
  }

  try {
    const newest = await searchProducts("", {
      limit: NEW_PRODUCTS_LIMIT,
      isNew: true,
      orderBy: "createdAt",
    });

    newProducts = newest.products;

    // Si no hay marcados como nuevos, mostramos los últimos cargados.
    if (newProducts.length === 0) {
      const latest = await searchProducts("", {
        limit: NEW_PRODUCTS_LIMIT,
        orderBy: "createdAt",
      });
      newProducts = latest.products;
    }
  } catch (error) {
    console.error("NotFound products query failed", error);
  }

  // Misma forma que consume ProductCard en el catálogo (incluye primaryImage).
  const products = newProducts.map((p) => ({
    id: p.id,
    name: p.name,
    slug: p.slug,
    sku: p.sku,
    price: p.price,
    wholesalePrice: p.wholesalePrice,
    minWholesaleQty: p.minWholesaleQty,
    isFeatured: p.isFeatured,
    isNew: p.isNew,
    isActive: p.isActive,
    catalogMode: p.catalogMode,
    variantCount: p.variantCount,
    stockStatus: p.stockStatus,
    sortOrder: p.sortOrder,
    createdAt: p.createdAt,
    primaryImage: p.primaryImage ?? null,
    category: p.categoryName
      ? { name: p.categoryName, slug: p.categorySlug!, catalogMode: p.categoryCatalogMode }
      : null,
    brand: p.brandName
      ? { name: p.brandName, slug: p.brandSlug!, catalogMode: p.brandCatalogMode }
      : null,
  }));

  return (
    <div className="min-h-screen flex flex-col bg-secondary">
      <Header />

      <main className="flex-1">
        {/* Hero 404 */}
        <section className="bg-primary text-white py-12 md:py-16">
          <div className="container mx-auto px-4 text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-white/10 mb-4">
              <SearchX className="h-8 w-8 text-white" aria-hidden />
            </div>
            <p className="font-heading text-5xl md:text-6xl font-bold tracking-tight">404</p>
            <h1 className="font-heading text-2xl md:text-3xl font-bold mt-3">
              No encontramos esta página
            </h1>
            <p className="text-white/80 mt-3 max-w-xl mx-auto text-sm md:text-base">
              La dirección que buscas no existe o fue movida. Tu carrito y tu cuenta
              siguen intactos: explora el catálogo o mira los productos nuevos de abajo.
            </p>
            <div className="flex flex-wrap justify-center gap-3 mt-7">
              <Button asChild size="lg" className="bg-white text-primary hover:bg-white/90 gap-2 px-6">
                <Link href="/">
                  <Home className="h-4 w-4" />
                  Ir al inicio
                </Link>
              </Button>
              <Button
                asChild
                size="lg"
                variant="outline"
                className="border-white/60 bg-transparent text-white hover:bg-white/10 hover:text-white gap-2 px-6"
              >
                <Link href="/catalogo">
                  Ver catálogo
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          </div>
        </section>

        {/* Productos nuevos */}
        {products.length > 0 && (
          <section className="container mx-auto px-4 py-10 md:py-14">
            <div className="flex items-end justify-between mb-6">
              <div>
                <h2 className="font-heading text-2xl md:text-3xl font-bold text-slate-900">
                  Productos nuevos
                </h2>
                <p className="text-slate-500 mt-1 text-sm">
                  Lo más reciente en nuestro catálogo
                </p>
              </div>
              <Button
                asChild
                variant="outline"
                className="hidden sm:inline-flex gap-2 border-slate-300"
              >
                <Link href="/catalogo?nuevo=true">
                  Ver todos
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4 md:gap-6">
              {products.map((product) => (
                <ProductCard
                  key={product.id}
                  product={product}
                  globalCatalogMode={globalCatalogMode}
                />
              ))}
            </div>

            <div className="text-center mt-8 sm:hidden">
              <Button asChild variant="outline" className="gap-2 border-slate-300">
                <Link href="/catalogo?nuevo=true">
                  Ver todos
                  <ArrowRight className="h-4 w-4" />
                </Link>
              </Button>
            </div>
          </section>
        )}
      </main>

      <Footer />
      <WhatsAppButton />
    </div>
  );
}
