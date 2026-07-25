"use client";

import { useEffect, useState } from "react";
import { ShoppingCart, Trash2, ArrowRight, MessageCircle, Share2 } from "lucide-react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { useCartStore, getItemCount, getSubtotal } from "@/stores/cart-store";
import { CartItemRow } from "@/components/store/cart-item-row";
import { CrossSellSection } from "@/components/store/cross-sell-section";
import { CartFeaturedProducts } from "@/components/store/cart-featured-products";
import { CartEmptyTopCategories } from "@/components/store/cart-empty-top-categories";
import { ShareCartMenu } from "@/components/store/share-cart-menu";
import { formatPrice } from "@/lib/format";
import Link from "next/link";
import { useCatalogMode, isItemInCatalogMode } from "@/hooks/use-catalog-mode";
import { getCartItemKey } from "@/stores/cart-store";

export function CartSheet() {
  const isOpen = useCartStore((s) => s.isOpen);
  const setOpen = useCartStore((s) => s.setOpen);
  const items = useCartStore((s) => s.items);
  const clearCart = useCartStore((s) => s.clearCart);
  const itemCount = useCartStore(getItemCount);
  const subtotal = useCartStore(getSubtotal);
  const { catalogMode } = useCatalogMode();

  const hasCatalogItems = catalogMode || items.some((item) => isItemInCatalogMode(item.product, catalogMode));

  // Prevent hydration mismatch for Zustand persist
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  return (
    <Sheet open={isOpen} onOpenChange={setOpen}>
      <SheetContent side="right" className="w-full sm:max-w-md flex flex-col p-0">
        <SheetDescription className="sr-only">Tu carrito de compras</SheetDescription>
        {/* Header */}
        <SheetHeader className="px-4 py-3 border-b border-slate-100">
          <div className="flex items-center justify-between pr-8">
            <SheetTitle className="flex items-center gap-2 text-lg">
              <ShoppingCart className="h-5 w-5 text-blue-600" />
              Carrito
              {itemCount > 0 && (
                <span className="text-xs bg-blue-100 text-blue-700 px-2 py-0.5 rounded-full font-medium">
                  {itemCount} {itemCount === 1 ? "producto" : "productos"}
                </span>
              )}
            </SheetTitle>
            {items.length > 0 && (
              <Button
                variant="ghost"
                size="sm"
                className="text-xs text-slate-400 hover:text-red-500"
                onClick={clearCart}
              >
                <Trash2 className="h-3.5 w-3.5 mr-1" />
                Vaciar
              </Button>
            )}
          </div>
        </SheetHeader>

        {items.length === 0 ? (
          /* Empty state */
          <ScrollArea className="flex-1">
            <div className="flex flex-col items-center justify-center px-6 pt-8 pb-4 text-center">
              <div className="w-20 h-20 bg-slate-100 rounded-full flex items-center justify-center mb-4">
                <ShoppingCart className="h-8 w-8 text-slate-400" />
              </div>
              <p className="text-lg font-medium text-slate-700 mb-1">
                Tu carrito está vacío
              </p>
              <p className="text-sm text-slate-400 mb-6">
                Agrega productos desde el catálogo para comenzar tu pedido
              </p>
              <Button
                asChild
                className="bg-blue-600 hover:bg-blue-700"
                onClick={() => setOpen(false)}
              >
                <Link href="/catalogo">
                  Ver catálogo
                </Link>
              </Button>

              <CartEmptyTopCategories onNavigate={() => setOpen(false)} />
            </div>
            {/* Featured products in empty cart */}
            <div className="px-4 pb-6">
              <CartFeaturedProducts />
            </div>
          </ScrollArea>
        ) : (
          <>
            {/* Items list */}
            <ScrollArea className="flex-1 px-4">
              <div className="py-2">
                {items.map((item) => (
                  <CartItemRow
                    key={getCartItemKey(item.product.id, item.product.variantId)}
                    item={item}
                    hidePrices={isItemInCatalogMode(item.product, catalogMode)}
                  />
                ))}
              </div>

              {/* Cross-sell */}
              <CrossSellSection />
            </ScrollArea>

            {/* Footer with totals and CTAs */}
            <div className="border-t border-slate-200 px-4 py-4 space-y-3 bg-white">
              {/* Subtotal */}
              <div className="flex items-center justify-between">
                <span className="text-sm text-slate-600">Subtotal</span>
                {hasCatalogItems ? (
                  <span className="text-sm font-medium text-slate-500">Cotización personalizada</span>
                ) : (
                  <span className="text-lg font-bold text-slate-900">{formatPrice(subtotal)}</span>
                )}
              </div>
              {hasCatalogItems ? (
                <p className="text-[11px] text-slate-400">Precios por cotización.</p>
              ) : (
                <p className="text-[11px] text-slate-400">Precios sujetos a confirmación. Envío no incluido.</p>
              )}

              <Separator />

              {/* CTA Buttons */}
              <div className="space-y-2">
                <Button
                  asChild
                  className="w-full bg-blue-600 hover:bg-blue-700 gap-2"
                  onClick={() => setOpen(false)}
                >
                  <Link href="/checkout">
                    <ArrowRight className="h-4 w-4" />
                    Realizar pedido
                  </Link>
                </Button>

                <CartWhatsAppButton />

                <Button
                  asChild
                  variant="outline"
                  className="w-full"
                  onClick={() => setOpen(false)}
                >
                  <Link href="/catalogo">
                    Ver más productos
                  </Link>
                </Button>

                <div className="flex gap-2">
                  <ShareCartMenu />
                </div>
              </div>
            </div>
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}

function CartWhatsAppButton() {
  const items = useCartStore((s) => s.items);
  const customerInfo = useCartStore((s) => s.customerInfo);
  const { catalogMode } = useCatalogMode();

  const generateMessage = () => {
    const hasCatalogItems = catalogMode || items.some((item) => isItemInCatalogMode(item.product, catalogMode));
    let msg = hasCatalogItems ? "*Cotización CompuSum* 📋\n\n" : "*Pedido CompuSum* 🛒\n\n";
    if (customerInfo.name) msg += `*Cliente:* ${customerInfo.name}\n`;
    if (customerInfo.company) msg += `*Empresa:* ${customerInfo.company}\n\n`;

    msg += "*Productos:*\n";
    let subtotal = 0;
    items.forEach((item, i) => {
      const price = item.product.wholesalePrice || item.product.price || 0;
      const ref = item.product.sku ? ` (Ref: ${item.product.sku})` : "";
      const variant = item.product.variantName
        ? ` [Variacion: ${item.product.variantName}]`
        : "";
      const itemCatalogMode = isItemInCatalogMode(item.product, catalogMode);
      msg += `${i + 1}. ${item.product.name}${ref}${variant} x${item.quantity}`;
      if (!itemCatalogMode && price) {
        msg += ` - ${formatPrice(price)} c/u`;
        subtotal += price * item.quantity;
      }
      msg += "\n";
    });

    if (!hasCatalogItems && subtotal > 0) msg += `\n*Subtotal:* ${formatPrice(subtotal)}`;
    return msg;
  };

  const whatsappUrl = `https://wa.me/576063335206?text=${encodeURIComponent(generateMessage())}`;

  return (
    <Button
      asChild
      variant="outline"
      className="w-full border-green-200 text-green-700 hover:bg-green-50 gap-2"
    >
      <a href={whatsappUrl} target="_blank" rel="noopener noreferrer">
        <MessageCircle className="h-4 w-4" />
        Cotizar por WhatsApp
      </a>
    </Button>
  );
}
