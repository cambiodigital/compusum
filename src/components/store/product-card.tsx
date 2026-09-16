"use client";

import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { MessageCircle, Sparkles, Package } from "lucide-react";
import { AddToCartButton } from "@/components/store/add-to-cart-button";
import { SafeProductImage } from "@/components/store/safe-product-image";
import { formatPrice } from "@/lib/format";
import {
  resolveBrandName,
  resolveBrandSlug,
  resolveProductImageSrc,
  resolveProductName,
  resolveProductSlug,
} from "@/lib/product-fallbacks";
import type { CartProduct } from "@/stores/cart-store";

interface ResolvedPriceView {
  unitPrice: number | null;
  purchasable?: boolean;
  requiresQuote?: boolean;
}

interface Product {
  id: string;
  name: string;
  slug: string;
  sku?: string | null;
  price?: number | null;
  wholesalePrice?: number | null;
  minWholesaleQty: number;
  stockStatus: string;
  isFeatured: boolean;
  isNew: boolean;
  catalogMode?: boolean;
  variantCount?: number;
  resolvedPrice?: ResolvedPriceView | null;
  /** Fase 6: imágenes reales (forma Prisma o plana según la consulta). */
  images?: Array<{ imagePath: string; isPrimary?: boolean; sortOrder?: number }> | null;
  primaryImage?: string | null;
  image?: string | null;
  brand?: {
    name: string;
    slug: string;
    catalogMode?: boolean;
  } | null;
  category?: {
    name: string;
    slug: string;
    catalogMode?: boolean;
  } | null;
}

interface ProductCardProps {
  product: Product;
  variant?: "default" | "compact";
  globalCatalogMode?: boolean;
}

export function ProductCard({ product, variant = "default", globalCatalogMode = false }: ProductCardProps) {
  const productName = resolveProductName(product.name);
  const productSlug = resolveProductSlug(product.slug);
  const brandName = resolveBrandName(product.brand?.name);
  const brandSlug = resolveBrandSlug(product.brand?.slug);
  const hasBrandLink = Boolean(product.brand?.name || product.brand?.slug);

  const whatsappMessage = `Hola, quiero cotizar: ${productName}${product.sku ? ` (Ref: ${product.sku})` : ""}`;
  const whatsappUrl = `https://wa.me/576063335206?text=${encodeURIComponent(whatsappMessage)}`;

  // Resolve catalog mode: product > category > brand > global
  const isCatalogMode =
    (product.catalogMode ?? false) ||
    (product.category?.catalogMode ?? false) ||
    (product.brand?.catalogMode ?? false) ||
    globalCatalogMode;

  // Precio resuelto server-side por sesión (motor único). Fallback legacy
  // para vistas que aún no reciben resolvedPrice.
  const resolved = product.resolvedPrice ?? null;
  const displayPrice: number | null = resolved
    ? resolved.requiresQuote || resolved.unitPrice == null
      ? null
      : resolved.unitPrice
    : product.wholesalePrice || product.price || null;
  const hasResolvedPrice = resolved
    ? !resolved.requiresQuote && resolved.unitPrice != null
    : Boolean(product.wholesalePrice || product.price);

  // Espejo del precio resuelto en el CartProduct: el carrito del navegador
  // muestra el precio autorizado; el servidor SIEMPRE recalcula al guardar.
  // Fase 6: la imagen real viaja en el CartProduct para carrito/cross-sell.
  const resolvedImage = resolveProductImageSrc(product);
  const cartProduct: CartProduct =
    resolved && !resolved.requiresQuote && resolved.unitPrice != null
      ? { ...(product as CartProduct), price: resolved.unitPrice, wholesalePrice: resolved.unitPrice, image: resolvedImage }
      : { ...(product as CartProduct), image: resolvedImage };

  const stockStatusConfig = {
    disponible: { label: "Disponible", className: "bg-green-50 text-green-700 border-green-200" },
    agotado: { label: "Agotado", className: "bg-slate-50 text-slate-600 border-slate-200" },
    por_pedido: { label: "Bajo pedido", className: "bg-amber-50 text-amber-700 border-amber-200" },
  };

  const config = stockStatusConfig[product.stockStatus as keyof typeof stockStatusConfig] || stockStatusConfig.disponible;
  const hasVariants = (product.variantCount ?? 0) > 0;

  if (variant === "compact") {
    return (
      <Card className="group overflow-hidden border border-slate-200 hover:border-slate-300 hover:shadow-md transition-all duration-200 bg-white">
        <div className="flex gap-3 p-3">
          <div className="relative w-20 h-20 flex-shrink-0 bg-slate-50 rounded-lg overflow-hidden">
            <SafeProductImage
              src={resolveProductImageSrc(product)}
              alt={productName}
              fill
              className="object-cover group-hover:scale-105 transition-transform duration-300"
              sizes="80px"
            />
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-slate-400">{brandName}</p>
            <Link href={`/producto/${productSlug}`}>
              <h3 className="font-medium text-slate-900 text-sm line-clamp-2 hover:text-primary transition-colors">
                {productName}
              </h3>
            </Link>
            {isCatalogMode ? (
              <p className="text-sm text-slate-500 mt-1 italic">
                Cotizar precio
              </p>
            ) : hasResolvedPrice ? (
              <p className="text-primary font-semibold text-sm mt-1">
                {formatPrice(displayPrice!)}
              </p>
            ) : null}
          </div>
        </div>
      </Card>
    );
  }

  return (
    <Card className="group overflow-hidden border border-slate-200 hover:border-slate-300 hover:shadow-lg transition-all duration-300 bg-white">
      {/* Image Container */}
      <div className="relative aspect-square overflow-hidden bg-slate-50">
        <Link href={`/producto/${productSlug}`}>
          <SafeProductImage
            src={resolveProductImageSrc(product)}
            alt={productName}
            fill
            className="object-cover group-hover:scale-105 transition-transform duration-500"
            sizes="(max-width: 768px) 100vw, (max-width: 1200px) 50vw, 25vw"
          />
        </Link>

        {/* Status Badges */}
        <div className="absolute top-3 left-3 flex flex-col gap-1.5">
          {product.isNew && (
            <Badge className="bg-green-600 hover:bg-green-700 text-white text-[10px] px-2 py-0.5 gap-1 font-normal">
              <Sparkles className="h-3 w-3" />
              Nuevo
            </Badge>
          )}
          {product.isFeatured && (
            <Badge className="bg-primary hover:bg-primary/90 text-white text-[10px] px-2 py-0.5 font-normal">
              Destacado
            </Badge>
          )}
        </div>

        {/* Stock Status */}
        <div className="absolute top-3 right-3">
          <Badge variant="outline" className={`text-[10px] px-2 py-0.5 font-normal ${config.className}`}>
            {config.label}
          </Badge>
        </div>
      </div>

      <CardContent className="p-4">
        {/* Brand */}
        {hasBrandLink ? (
          <Link
            href={`/catalogo?marca=${brandSlug}`}
            className="text-xs text-slate-400 hover:text-primary transition-colors"
          >
            {brandName}
          </Link>
        ) : (
          <p className="text-xs text-slate-400">{brandName}</p>
        )}

        {/* Product Name */}
        <Link href={`/producto/${productSlug}`}>
          <h3 className="font-medium text-slate-900 mt-1 line-clamp-2 hover:text-primary transition-colors text-sm">
            {productName}
          </h3>
        </Link>

        {/* SKU */}
        {product.sku && (
          <p className="text-xs text-slate-400 mt-1 font-mono">
            Ref: {product.sku}
          </p>
        )}

        {/* Prices */}
        <div className="mt-3">
          {isCatalogMode ? (
            <p className="text-sm text-slate-500 italic">
              Consultar precio
            </p>
          ) : hasResolvedPrice ? (
            <div>
              <p className="text-lg font-semibold text-primary">
                {formatPrice(displayPrice!)}
              </p>
              <p className="text-xs text-slate-400 flex items-center gap-1 mt-0.5">
                <Package className="h-3 w-3" />
                Desde {product.minWholesaleQty} unidades
              </p>
            </div>
          ) : (
            <p className="text-sm text-slate-400">
              Consultar precio
            </p>
          )}
          {hasVariants && (
            <p className="text-xs text-slate-500 mt-1">
              {product.variantCount} variaciones disponibles
            </p>
          )}
        </div>

        {/* CTA Buttons */}
        <div className="flex gap-2 mt-4">
          {hasVariants ? (
            <Button asChild size="sm" className="flex-1 bg-blue-600 hover:bg-blue-700 text-white text-xs h-9">
              <Link href={`/producto/${productSlug}`}>
                Elegir variacion
              </Link>
            </Button>
          ) : (
            <AddToCartButton
              product={cartProduct}
              variant="icon"
              className="flex-1"
            />
          )}
          <Button
            asChild
            size="sm"
            variant="outline"
            className="border-green-200 text-green-700 hover:bg-green-50 gap-1 text-xs h-9 px-2.5"
          >
            <a href={whatsappUrl} target="_blank" rel="noopener noreferrer">
              <MessageCircle className="h-3.5 w-3.5" />
              {isCatalogMode && <span>Cotizar</span>}
            </a>
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

