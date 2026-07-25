"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SafeProductImage } from "@/components/store/safe-product-image";
import { useCatalogMode, isItemInCatalogMode } from "@/hooks/use-catalog-mode";
import { useCartStore, type CartProduct } from "@/stores/cart-store";
import { formatPrice } from "@/lib/format";
import { resolveProductImageSrc, resolveProductName, resolveProductSlug } from "@/lib/product-fallbacks";
import { toast } from "sonner";

interface CrossSellProduct {
  id: string;
  name: string;
  slug: string;
  sku: string | null;
  price: number | null;
  wholesalePrice: number | null;
  minWholesaleQty: number;
  stockStatus: string;
  brand?: { name: string; slug: string } | null;
  category?: { name: string; slug: string } | null;
}

export function CrossSellSection() {
  const items = useCartStore((s) => s.items);
  const addItem = useCartStore((s) => s.addItem);
  const { catalogMode } = useCatalogMode();
  const [suggestions, setSuggestions] = useState<CrossSellProduct[]>([]);
  const [loading, setLoading] = useState(false);
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    // Check if cross-sell is enabled via settings
    fetch("/api/settings")
      .then((r) => r.json())
      .then((data) => {
        const crossSellEnabled = data?.data?.catalog?.cross_sell_enabled?.value;
        if (crossSellEnabled === false) setEnabled(false);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    if (!enabled || items.length === 0) {
      setSuggestions([]);
      return;
    }

    const categorySlug = items[0]?.product.category?.slug;
    if (!categorySlug) return;

    const cartProductIds = new Set(items.map((i) => i.product.id));

    setLoading(true);
    fetch(`/api/products?category=${categorySlug}&limit=6`)
      .then((r) => r.json())
      .then((data) => {
        const fetchedProducts = data?.data?.products;
        if (data?.success && Array.isArray(fetchedProducts)) {
          const filtered = fetchedProducts
            .filter((p: CrossSellProduct) => !cartProductIds.has(p.id))
            .slice(0, 3);
          setSuggestions(filtered);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [items, enabled]);

  if (suggestions.length === 0 || loading) return null;

  const handleAdd = (product: CrossSellProduct) => {
    addItem(product as CartProduct, 1);
    toast.success("Producto agregado", { description: resolveProductName(product.name) });
    setSuggestions((prev) => prev.filter((p) => p.id !== product.id));
  };

  return (
    <div className="border-t border-slate-100 pt-3 mt-2">
      <p className="text-xs font-medium text-slate-500 mb-2 uppercase tracking-wider">
        Te podría interesar
      </p>
      <div className="space-y-2">
        {suggestions.map((product) => {
          const productName = resolveProductName(product.name);
          const productSlug = resolveProductSlug(product.slug);

          return (
          <div key={product.id} className="flex items-center gap-2 p-2 rounded-lg hover:bg-slate-50 transition-colors">
            <div className="relative w-10 h-10 flex-shrink-0 bg-slate-50 rounded overflow-hidden">
              <SafeProductImage
                src={resolveProductImageSrc(product.slug, "60/60")}
                alt={productName}
                fill
                className="object-cover"
                sizes="40px"
              />
            </div>
            <div className="flex-1 min-w-0">
              <Link
                href={`/producto/${productSlug}`}
                className="text-xs text-slate-700 hover:text-blue-600 line-clamp-1 transition-colors"
              >
                {productName}
              </Link>
              {isItemInCatalogMode(product, catalogMode) ? (
                <p className="text-xs font-medium text-slate-500 italic">Consultar precio</p>
              ) : (
                <p className="text-xs font-medium text-blue-600">
                  {formatPrice(product.wholesalePrice || product.price)}
                </p>
              )}
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-blue-600 hover:bg-blue-50"
              onClick={() => handleAdd(product)}
              aria-label={`Agregar ${productName} al carrito`}
            >
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          );
        })}
      </div>
    </div>
  );
}
