"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { ProductCard } from "@/components/store/product-card";
import { Loader2 } from "lucide-react";

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
  brand?: { name: string; slug: string; catalogMode?: boolean } | null;
  category?: { name: string; slug: string; catalogMode?: boolean } | null;
}

interface ProductInfiniteListProps {
  initialProducts: Product[];
  totalProducts: number;
  searchQuery: string;
  filters: Record<string, string>;
  globalCatalogMode: boolean;
  pageSize?: number;
}

export function ProductInfiniteList({
  initialProducts,
  totalProducts,
  searchQuery,
  filters,
  globalCatalogMode,
  pageSize = 12,
}: ProductInfiniteListProps) {
  const [products, setProducts] = useState<Product[]>(initialProducts);
  const [page, setPage] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [hasMore, setHasMore] = useState(initialProducts.length < totalProducts);
  const observerRef = useRef<HTMLDivElement>(null);

  // Reset when search/filters change (SSR provides new initialProducts)
  useEffect(() => {
    setProducts(initialProducts);
    setPage(1);
    setHasMore(initialProducts.length < totalProducts);
  }, [initialProducts, totalProducts]);

  const loadMore = useCallback(async () => {
    if (isLoading || !hasMore) return;
    setIsLoading(true);

    const nextPage = page + 1;
    const params = new URLSearchParams({
      search: searchQuery,
      page: String(nextPage),
      limit: String(pageSize),
      ...filters,
    });

    try {
      const res = await fetch(`/api/products?${params.toString()}`);
      const json = await res.json();
      if (json.success && json.data.products.length > 0) {
        // Map flat search results to ProductCard shape
        const mapped = json.data.products.map((p: any) => ({
          id: p.id,
          name: p.name,
          slug: p.slug,
          sku: p.sku,
          price: p.price,
          wholesalePrice: p.wholesalePrice,
          resolvedPrice: p.resolvedPrice ?? null,
          minWholesaleQty: p.minWholesaleQty,
          stockStatus: p.stockStatus,
          isFeatured: p.isFeatured,
          isNew: p.isNew,
          catalogMode: p.catalogMode,
          variantCount: p.variantCount,
          primaryImage: p.primaryImage ?? null,
          brand: p.brandName
            ? { name: p.brandName, slug: p.brandSlug, catalogMode: p.brandCatalogMode }
            : p.brand ?? null,
          category: p.categoryName
            ? { name: p.categoryName, slug: p.categorySlug, catalogMode: p.categoryCatalogMode }
            : p.category ?? null,
        }));
        setProducts((prev) => [...prev, ...mapped]);
        setPage(nextPage);
        setHasMore(
          json.data.pagination.page < json.data.pagination.totalPages
        );
      } else {
        setHasMore(false);
      }
    } catch {
      // Silently fail, user can scroll again
    } finally {
      setIsLoading(false);
    }
  }, [isLoading, hasMore, page, searchQuery, filters, pageSize]);

  // IntersectionObserver to trigger loadMore
  useEffect(() => {
    const el = observerRef.current;
    if (!el) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadMore();
        }
      },
      { rootMargin: "200px" }
    );

    observer.observe(el);
    return () => observer.disconnect();
  }, [loadMore]);

  return (
    <>
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-3 gap-4 md:gap-6">
        {products.map((product) => (
          <ProductCard
            key={product.id}
            product={product}
            globalCatalogMode={globalCatalogMode}
          />
        ))}
      </div>

      {/* Sentinel element for IntersectionObserver */}
      {hasMore && (
        <div ref={observerRef} className="flex justify-center py-8">
          {isLoading && (
            <div className="flex items-center gap-2 text-slate-500">
              <Loader2 className="h-5 w-5 animate-spin" />
              <span className="text-sm">Cargando más productos...</span>
            </div>
          )}
        </div>
      )}
    </>
  );
}
