import { db } from "@/lib/db";
import { Header } from "@/components/store/header";
import { Footer } from "@/components/store/footer";
import { WhatsAppButton } from "@/components/store/whatsapp-button";
import { ProductCard } from "@/components/store/product-card";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import Link from "next/link";
import { SafeProductImage } from "@/components/store/safe-product-image";
import {
  MessageCircle,
  Star,
  Sparkles,
  Truck,
  Shield,
  ChevronRight
} from "lucide-react";
import { ProductDetailCTA } from "@/components/store/product-detail-cta";
import { formatPrice } from "@/lib/format";
import { resolveCatalogMode } from "@/lib/catalog-mode";
import { getCachedProductBySlug, getCachedGlobalCatalogMode } from "@/lib/product-cache";
import { attachResolvedPrices } from "@/lib/pricing";
import { getSessionPricingContext } from "@/lib/pricing-context";
import { ViewCountTracker } from "@/components/store/view-count-tracker";
import {
  resolveBrandLogoSrc,
  resolveBrandName,
  resolveBrandSlug,
  resolveProductImageList,
  resolveProductImageSrc,
  resolveProductName,
  resolveProductSlug,
} from "@/lib/product-fallbacks";

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps) {
  const { slug } = await params;
  let product: Awaited<ReturnType<typeof getCachedProductBySlug>> = null;

  try {
    product = await getCachedProductBySlug(slug);
  } catch (error) {
    console.error("Product metadata query failed", error);
  }

  if (!product) return { title: "Producto no encontrado" };

  return {
    title: `${product.name} | Compusum`,
    description: product.shortDescription || product.description?.slice(0, 160),
  };
}

export default async function ProductDetailPage({ params }: PageProps) {
  const { slug } = await params;

  let product: Awaited<ReturnType<typeof getCachedProductBySlug>> = null;

  try {
    product = await getCachedProductBySlug(slug);
  } catch (error) {
    console.error("Product detail query failed", error);
  }

  if (!product || !product.isActive) {
    return (
      <div className="min-h-screen flex flex-col bg-white">
        <Header />
        <main className="flex-1">
          <section className="py-16 md:py-24">
            <div className="container mx-auto px-4 max-w-2xl text-center">
              <Badge className="mb-4 bg-slate-100 text-slate-700 hover:bg-slate-100">Producto no disponible</Badge>
              <h1 className="font-heading text-3xl md:text-4xl font-bold text-foreground mb-3">
                Este producto no existe o ya no está activo
              </h1>
              <p className="text-gray-600 mb-8">
                Te ayudamos a encontrar una alternativa con disponibilidad inmediata.
              </p>
              <div className="flex flex-col sm:flex-row gap-3 justify-center">
                <Link
                  href="/catalogo"
                  className="inline-flex items-center justify-center h-11 px-6 rounded-md bg-primary text-white hover:bg-primary/90 transition-colors"
                >
                  Ver catálogo
                </Link>
                <a
                  href="https://wa.me/576063335206?text=Hola%2C%20estoy%20buscando%20un%20producto%20que%20no%20aparece%20en%20la%20tienda."
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center justify-center h-11 px-6 rounded-md border border-green-200 text-green-700 hover:bg-green-50 transition-colors"
                >
                  Consultar por WhatsApp
                </a>
              </div>
            </div>
          </section>
        </main>
        <Footer />
        <WhatsAppButton />
      </div>
    );
  }

  // Resolve catalog mode for this product
  let globalCatalogMode = false;
  try {
    globalCatalogMode = await getCachedGlobalCatalogMode();
  } catch (error) {
    console.error("Catalog mode check failed:", error instanceof Error ? error.message : error);
  }

  const productCatalogMode = resolveCatalogMode(
    product.catalogMode,
    product.category?.catalogMode ?? false,
    product.brand?.catalogMode,
    globalCatalogMode
  );

  // Get related products
  let relatedProducts: Awaited<ReturnType<typeof db.product.findMany<{
    include: { brand: true; category: true; _count: { select: { variants: true } } };
  }>>> = [];

  try {
    relatedProducts = await db.product.findMany({
      where: {
        categoryId: product.categoryId,
        isActive: true,
        id: { not: product.id }
      },
      include: {
        brand: true,
        category: true,
        _count: { select: { variants: { where: { isActive: true } } } },
      },
      take: 4
    });
  } catch (error) {
    console.error("Related products query failed", error);
  }

  // Motor único de precios: resolvedPrice del producto, sus variantes y
  // relacionados, según la sesión (batch, sin N+1).
  // IMPORTANTE: capturar `resolvedPrice` DESPUÉS de attachResolvedPrices —
  // antes de este fix se leía el valor base previo y la cabecera ignoraba el
  // precio resuelto del perfil del cliente.
  let pricedProduct = product;
  let pricedRelated = relatedProducts;
  try {
    const pricingCtx = await getSessionPricingContext();
    const [attachedProduct, attachedRelated] = await Promise.all([
      attachResolvedPrices([product], pricingCtx),
      attachResolvedPrices(
        relatedProducts.map((p) => ({ ...p, variantCount: p._count.variants })),
        pricingCtx
      ),
    ]);
    pricedProduct = attachedProduct[0] ?? product;
    pricedRelated = attachedRelated;
  } catch (error) {
    console.error("Price resolution failed", error);
  }
  product = pricedProduct;

  const resolvedPrice = (product as any).resolvedPrice ?? null;

  const stockStatusColors = {
    disponible: "bg-green-500",
    agotado: "bg-gray-500",
    por_pedido: "bg-accent"
  };

  const stockStatusLabels = {
    disponible: "Disponible",
    agotado: "Agotado",
    por_pedido: "Bajo pedido"
  };

  const productName = resolveProductName(product.name);
  const productSlug = resolveProductSlug(product.slug);
  const brandName = resolveBrandName(product.brand?.name);
  const brandSlug = resolveBrandSlug(product.brand?.slug);
  // Fase 6: galería real (máx. 4) desde ProductImage; vacía => sin thumbnails.
  const galleryImages = resolveProductImageList(product, 4);

  return (
    <div className="min-h-screen flex flex-col bg-white">
      <Header />
      <ViewCountTracker productId={product.id} />
      
      <main className="flex-1">
        {/* Breadcrumb */}
        <div className="bg-secondary py-3">
          <div className="container mx-auto px-4">
            <nav className="flex items-center gap-2 text-sm">
              <Link href="/" className="text-gray-500 hover:text-primary">Inicio</Link>
              <ChevronRight className="h-4 w-4 text-gray-400" />
              {product.category?.parent && (
                <>
                  <Link href={`/catalogo?categoria=${product.category.parent.slug}`} className="text-gray-500 hover:text-primary">
                    {product.category.parent.name}
                  </Link>
                  <ChevronRight className="h-4 w-4 text-gray-400" />
                </>
              )}
              <Link href={`/catalogo?categoria=${product.category?.slug}`} className="text-gray-500 hover:text-primary">
                {product.category?.name}
              </Link>
              <ChevronRight className="h-4 w-4 text-gray-400" />
              <span className="text-foreground font-medium truncate">{productName}</span>
            </nav>
          </div>
        </div>

        {/* Product Detail */}
        <section className="py-8 md:py-12">
          <div className="container mx-auto px-4">
            <div className="grid md:grid-cols-2 gap-8 lg:gap-12">
              {/* Image Gallery */}
              <div className="space-y-4">
                <div className="relative aspect-square bg-gray-50 rounded-2xl overflow-hidden">
                  <SafeProductImage
                    src={resolveProductImageSrc(product)}
                    alt={productName}
                    fill
                    className="object-cover"
                    priority
                    sizes="(max-width: 768px) 100vw, 50vw"
                  />
                  {/* Badges */}
                  <div className="absolute top-4 left-4 flex flex-col gap-2">
                    {product.isNew && (
                      <Badge className="bg-green-500 text-white gap-1">
                        <Sparkles className="h-3 w-3" />
                        Nuevo
                      </Badge>
                    )}
                    {product.isFeatured && (
                      <Badge className="bg-accent text-white gap-1">
                        <Star className="h-3 w-3" />
                        Destacado
                      </Badge>
                    )}
                  </div>
                </div>
                {/* Thumbnails — Fase 6: imágenes reales; sin imágenes no se inventan */}
                {galleryImages.length > 0 && (
                  <div className="grid grid-cols-4 gap-2">
                    {galleryImages.map((src, i) => (
                      <div
                        key={src}
                        className="aspect-square bg-gray-100 rounded-lg overflow-hidden cursor-pointer hover:ring-2 hover:ring-primary transition-all"
                      >
                        <SafeProductImage
                          src={src}
                          alt={`${productName} - Imagen ${i + 1}`}
                          width={100}
                          height={100}
                          className="object-cover w-full h-full"
                        />
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Product Info */}
              <div className="space-y-6">
                {/* Brand */}
                {product.brand && (
                  <Link 
                    href={`/marcas/${brandSlug}`}
                    className="inline-flex items-center gap-2 text-sm text-gray-500 hover:text-primary"
                  >
                    <div className="w-8 h-8 bg-gray-100 rounded overflow-hidden flex items-center justify-center">
                      <img
                        src={resolveBrandLogoSrc(product.brand.logo, product.brand.slug, "32/32")}
                        alt={brandName}
                        className="w-full h-full object-contain p-0.5"
                      />
                    </div>
                    {brandName}
                  </Link>
                )}

                {/* Name */}
                <h1 className="font-heading text-3xl md:text-4xl font-bold text-foreground">
                  {productName}
                </h1>

                {/* SKU & Stock */}
                <div className="flex items-center gap-4">
                  {product.sku && (
                    <span className="text-sm text-gray-500">
                      Ref: {product.sku}
                    </span>
                  )}
                  <Badge className={`${stockStatusColors[product.stockStatus as keyof typeof stockStatusColors]} text-white`}>
                    {stockStatusLabels[product.stockStatus as keyof typeof stockStatusLabels]}
                  </Badge>
                  {(product.variants?.length ?? 0) > 0 && (
                    <Badge variant="outline" className="border-primary/40 text-primary">
                      {(product.variants?.length ?? 0)} variaciones
                    </Badge>
                  )}
                </div>

                {/* Prices */}
                <div className="bg-secondary rounded-xl p-6">
                  {productCatalogMode ? (
                    <div>
                      <p className="text-lg font-semibold text-primary">
                        Precio a consultar
                      </p>
                      <p className="text-sm text-gray-500 mt-1">
                        Solicita tu cotización personalizada
                      </p>
                    </div>
                  ) : resolvedPrice && (resolvedPrice.requiresQuote || resolvedPrice.unitPrice !== null) ? (
                    resolvedPrice.requiresQuote ? (
                      <div>
                        <p className="text-lg font-semibold text-primary">
                          Precio a consultar
                        </p>
                        <p className="text-sm text-gray-500 mt-1">
                          Solicita tu cotización personalizada
                        </p>
                      </div>
                    ) : (
                      <>
                        <div className="flex items-baseline gap-3">
                          <p className="text-3xl font-bold text-primary">
                            {formatPrice(resolvedPrice.unitPrice!)}
                          </p>
                          <Badge className="bg-accent text-white">
                            Tu precio
                          </Badge>
                        </div>
                        {product.minWholesaleQty && (
                          <p className="text-sm text-gray-500 mt-2">
                            Válido desde {product.minWholesaleQty} unidades
                          </p>
                        )}
                      </>
                    )
                  ) : (
                    <>
                      {product.price && (
                        <p className="text-gray-500 line-through mb-1">
                          Precio referencia: {formatPrice(product.price)}
                        </p>
                      )}
                      {product.wholesalePrice && (
                        <div className="flex items-baseline gap-3">
                          <p className="text-3xl font-bold text-primary">
                            {formatPrice(product.wholesalePrice)}
                          </p>
                          <Badge className="bg-accent text-white">
                            Precio mayorista
                          </Badge>
                        </div>
                      )}
                      {product.minWholesaleQty && (
                        <p className="text-sm text-gray-500 mt-2">
                          Válido desde {product.minWholesaleQty} unidades
                        </p>
                      )}
                    </>
                  )}
                </div>

                {/* Short Description */}
                {product.shortDescription && (
                  <p className="text-gray-600">
                    {product.shortDescription}
                  </p>
                )}

                {/* CTA Buttons */}
                <ProductDetailCTA
                  product={{
                    id: product.id,
                    name: product.name,
                    slug: product.slug,
                    sku: product.sku,
                    price: product.price,
                    wholesalePrice: product.wholesalePrice,
                    // Precio resuelto del PRODUCTO (sin variante): el CTA lo
                    // usa para mostrar y para agregar al carrito.
                    resolvedPrice: (product as any).resolvedPrice ?? null,
                    minWholesaleQty: product.minWholesaleQty,
                    stockStatus: product.stockStatus,
                    // Fase 6: imagen real que viaja al carrito desde el detalle.
                    image: resolveProductImageSrc(product),
                    brand: product.brand ? { name: product.brand.name, slug: product.brand.slug } : null,
                    category: product.category ? { name: product.category.name, slug: product.category.slug } : null,
                    variants:
                      product.variants?.map((variant) => ({
                        id: variant.id,
                        name: variant.name,
                        code: variant.code,
                        price: variant.price,
                        wholesalePrice: variant.wholesalePrice,
                        stockStatus: variant.stockStatus,
                        resolvedPrice: (variant as any).resolvedPrice ?? null,
                      })) ?? [],
                  }}
                  catalogMode={productCatalogMode}
                />

                {/* Benefits */}
                <div className="grid grid-cols-2 gap-4 pt-4">
                  <div className="flex items-center gap-3">
                    <div className="bg-primary/10 p-2 rounded-lg">
                      <Truck className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">Envíos a todo Colombia</p>
                      <p className="text-xs text-gray-500">Consultar tiempos</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <div className="bg-primary/10 p-2 rounded-lg">
                      <Shield className="h-5 w-5 text-primary" />
                    </div>
                    <div>
                      <p className="text-sm font-medium">Garantía de calidad</p>
                      <p className="text-xs text-gray-500">100% original</p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Tabs */}
            <div className="mt-12">
              <Tabs defaultValue="descripcion" className="w-full">
                <TabsList className="w-full justify-start bg-secondary p-1 rounded-lg">
                  <TabsTrigger value="descripcion" className="data-[state=active]:bg-white data-[state=active]:text-primary">
                    Descripción
                  </TabsTrigger>
                  <TabsTrigger value="envio" className="data-[state=active]:bg-white data-[state=active]:text-primary">
                    Envío y entregas
                  </TabsTrigger>
                </TabsList>
                <TabsContent value="descripcion" className="mt-6 p-6 bg-white rounded-xl border">
                  <div className="prose prose-sm max-w-none">
                    {product.description ? (
                      <p>{product.description}</p>
                    ) : (
                      <p className="text-gray-500">
                        {productName} - Producto de alta calidad de la marca {brandName.toLowerCase()}. 
                        Ideal para uso escolar y de oficina.
                      </p>
                    )}
                  </div>
                </TabsContent>
                <TabsContent value="envio" className="mt-6 p-6 bg-white rounded-xl border">
                  <div className="space-y-4">
                    <div className="flex items-start gap-3">
                      <Truck className="h-5 w-5 text-primary mt-0.5" />
                      <div>
                        <p className="font-medium">Envíos a todo Colombia</p>
                        <p className="text-sm text-gray-500">
                          Realizamos envíos a todas las ciudades principales. El tiempo de entrega 
                          estimado es de 2-5 días hábiles dependiendo de la ubicación.
                        </p>
                      </div>
                    </div>
                    <div className="flex items-start gap-3">
                      <MessageCircle className="h-5 w-5 text-green-500 mt-0.5" />
                      <div>
                        <p className="font-medium">Cotización personalizada</p>
                        <p className="text-sm text-gray-500">
                          Escríbenos por WhatsApp para conocer los costos de envío a tu ciudad 
                          y los descuentos por volumen disponibles.
                        </p>
                      </div>
                    </div>
                  </div>
                </TabsContent>
              </Tabs>
            </div>
          </div>
        </section>

        {/* Related Products */}
        {pricedRelated.length > 0 && (
          <section className="py-12 bg-secondary">
            <div className="container mx-auto px-4">
              <h2 className="font-heading text-2xl md:text-3xl font-bold text-foreground mb-8">
                También te puede interesar
              </h2>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 md:gap-6">
                {pricedRelated.map((p) => (
                  <ProductCard
                    key={p.id}
                    product={p}
                    globalCatalogMode={globalCatalogMode}
                  />
                ))}
              </div>
            </div>
          </section>
        )}
      </main>

      <Footer />
      <WhatsAppButton />
    </div>
  );
}
