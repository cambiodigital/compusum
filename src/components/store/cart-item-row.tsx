"use client";

import Link from "next/link";
import { Minus, Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SafeProductImage } from "@/components/store/safe-product-image";
import { useCartStore, type CartItem, getCartItemKey } from "@/stores/cart-store";
import { formatPrice } from "@/lib/format";
import { resolveProductImageSrc, resolveProductName, resolveProductSlug } from "@/lib/product-fallbacks";

interface CartItemRowProps {
  item: CartItem;
  hidePrices?: boolean;
}

export function CartItemRow({ item, hidePrices = false }: CartItemRowProps) {
  const updateQuantity = useCartStore((s) => s.updateQuantity);
  const removeItem = useCartStore((s) => s.removeItem);
  const itemKey = getCartItemKey(item.product.id, item.product.variantId);
  const productName = resolveProductName(item.product.name);
  const productSlug = resolveProductSlug(item.product.slug);

  const price = item.product.wholesalePrice || item.product.price || 0;
  const lineTotal = price * item.quantity;

  return (
    <div className="flex gap-3 py-3 border-b border-slate-100 last:border-0">
      {/* Image */}
      <div className="relative w-16 h-16 flex-shrink-0 bg-slate-50 rounded-lg overflow-hidden">
        <SafeProductImage
          src={resolveProductImageSrc(item.product)}
          alt={productName}
          fill
          className="object-cover"
          sizes="64px"
        />
      </div>

      {/* Info */}
      <div className="flex-1 min-w-0">
        <Link
          href={`/producto/${productSlug}`}
          className="text-sm font-medium text-slate-900 hover:text-blue-600 line-clamp-2 transition-colors"
        >
          {productName}
        </Link>
        {item.product.sku && (
          <p className="text-[11px] text-slate-400 font-mono mt-0.5">
            Ref: {item.product.sku}
          </p>
        )}
        {item.product.variantName && (
          <p className="text-[11px] text-slate-500 mt-0.5">
            Variacion: {item.product.variantName}
          </p>
        )}

        <div className="flex items-center justify-between mt-2">
          {/* Quantity controls */}
          <div className="flex items-center border border-slate-200 rounded-md">
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-r-none"
              onClick={() => updateQuantity(itemKey, item.quantity - 1)}
              aria-label={`Disminuir cantidad de ${productName}`}
            >
              <Minus className="h-3 w-3" />
            </Button>
            <span className="w-8 text-center text-xs font-medium" aria-label={`Cantidad actual: ${item.quantity}`}>{item.quantity}</span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 rounded-l-none"
              onClick={() => updateQuantity(itemKey, item.quantity + 1)}
              aria-label={`Aumentar cantidad de ${productName}`}
            >
              <Plus className="h-3 w-3" />
            </Button>
          </div>

          {/* Price & Remove */}
          <div className="flex items-center gap-2">
            {hidePrices ? (
              <span className="text-xs font-medium text-slate-500">Precio en cotización</span>
            ) : (
              <span className="text-sm font-semibold text-blue-600">{formatPrice(lineTotal)}</span>
            )}
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7 text-slate-400 hover:text-red-500"
              onClick={() => removeItem(itemKey)}
              aria-label={`Eliminar ${productName} del carrito`}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
