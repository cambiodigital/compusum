"use client";

import { useState } from "react";
import Link from "next/link";
import {
  ShoppingCart,
  MessageCircle,
  Truck,
  Clock,
  User,
  Building2,
  Copy,
  Check,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { SafeProductImage } from "@/components/store/safe-product-image";
import { useCartStore } from "@/stores/cart-store";
import { formatPrice } from "@/lib/format";
import { resolveProductImageSrc, resolveProductName, resolveProductSlug } from "@/lib/product-fallbacks";
import { isItemInCatalogMode } from "@/hooks/use-catalog-mode";
import { toast } from "sonner";

interface SharedCartItem {
  id: string;
  quantity: number;
  unitPrice: number | null;
  product: {
    id: string;
    name: string;
    slug: string;
    sku: string | null;
    variantId?: string | null;
    variantName?: string | null;
    variantCode?: string | null;
    price: number | null;
    wholesalePrice: number | null;
    minWholesaleQty: number;
    stockStatus: string;
    catalogMode?: boolean;
    brand?: { name: string; slug: string; catalogMode?: boolean } | null;
    category?: { name: string; slug: string; catalogMode?: boolean } | null;
  };
}

interface SharedCartData {
  uuid: string;
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  customerCompany: string | null;
  notes: string | null;
  subtotal: number;
  status: string;
  city: {
    name: string;
    department: string;
    shippingRoute: {
      name: string;
      estimatedDaysMin: number;
      estimatedDaysMax: number;
      shippingCompany: string | null;
    } | null;
  } | null;
  items: SharedCartItem[];
}

interface SharedCartViewProps {
  cart: SharedCartData;
  catalogMode?: boolean;
}

export function SharedCartView({ cart, catalogMode = false }: SharedCartViewProps) {
  const [copied, setCopied] = useState(false);
  const addItem = useCartStore((s) => s.addItem);
  const setOpen = useCartStore((s) => s.setOpen);

  const hasCatalogItems = catalogMode || cart.items.some((item) => isItemInCatalogMode(item.product, catalogMode));

  const subtotal = cart.items.reduce((sum, item) => {
    const price = item.unitPrice || item.product.wholesalePrice || item.product.price || 0;
    return sum + price * item.quantity;
  }, 0);

  const handleCopyLink = async () => {
    await navigator.clipboard.writeText(window.location.href);
    setCopied(true);
    toast.success("Enlace copiado");
    setTimeout(() => setCopied(false), 2000);
  };

  const handleLoadToMyCart = () => {
    cart.items.forEach((item) => {
      addItem(item.product, item.quantity);
    });
    toast.success("Productos agregados a tu carrito", {
      action: { label: "Ver carrito", onClick: () => setOpen(true) },
    });
  };

  const generateWhatsAppMessage = () => {
    let msg = hasCatalogItems ? "*Cotización CompuSum* 📋\n\n" : "*Pedido CompuSum* 🛒\n\n";
    if (cart.customerName) msg += `*Cliente:* ${cart.customerName}\n`;
    if (cart.customerCompany) msg += `*Empresa:* ${cart.customerCompany}\n`;
    if (cart.city) msg += `*Ciudad:* ${cart.city.name}, ${cart.city.department}\n`;
    msg += "\n*Productos:*\n";
    cart.items.forEach((item, i) => {
      const price = item.unitPrice || item.product.wholesalePrice || item.product.price || 0;
      const ref = item.product.sku ? ` (Ref: ${item.product.sku})` : "";
      const variant = item.product.variantName
        ? ` [Variacion: ${item.product.variantName}]`
        : "";
      const itemCatalogMode = isItemInCatalogMode(item.product, catalogMode);
      msg += `${i + 1}. ${resolveProductName(item.product.name)}${ref}${variant} x${item.quantity}`;
      if (!itemCatalogMode && price) msg += ` - ${formatPrice(price)} c/u`;
      msg += "\n";
    });
    if (!hasCatalogItems && subtotal > 0) msg += `\n*Subtotal:* ${formatPrice(subtotal)}`;
    return msg;
  };

  const whatsappUrl = `https://wa.me/576063335206?text=${encodeURIComponent(generateWhatsAppMessage())}`;

  const statusConfig: Record<string, { label: string; className: string }> = {
    activo: { label: "Activo", className: "bg-green-100 text-green-700" },
    compartido: { label: "Compartido", className: "bg-blue-100 text-blue-700" },
    convertido: { label: "Convertido", className: "bg-purple-100 text-purple-700" },
    expirado: { label: "Expirado", className: "bg-slate-100 text-slate-600" },
  };

  const statusInfo = statusConfig[cart.status] || statusConfig.activo;

  return (
    <div className="max-w-3xl mx-auto">
      {/* Header */}
      <div className="text-center mb-8">
        <div className="inline-flex items-center justify-center w-16 h-16 bg-blue-100 rounded-full mb-4">
          <ShoppingCart className="h-7 w-7 text-blue-600" />
        </div>
        <h1 className="font-heading text-2xl md:text-3xl font-bold text-slate-900">
          Carrito compartido
        </h1>
        {cart.customerName && (
          <p className="text-slate-500 mt-1">de {cart.customerName}</p>
        )}
        <Badge className={`mt-2 ${statusInfo.className}`}>{statusInfo.label}</Badge>
      </div>

      {/* Customer info */}
      {(cart.customerName || cart.customerCompany || cart.city) && (
        <Card className="mb-6">
          <CardContent className="p-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
              {cart.customerName && (
                <div className="flex items-center gap-2 text-slate-600">
                  <User className="h-4 w-4 text-slate-400" />
                  {cart.customerName}
                </div>
              )}
              {cart.customerCompany && (
                <div className="flex items-center gap-2 text-slate-600">
                  <Building2 className="h-4 w-4 text-slate-400" />
                  {cart.customerCompany}
                </div>
              )}
              {cart.city && (
                <div className="flex items-center gap-2 text-slate-600">
                  <Truck className="h-4 w-4 text-slate-400" />
                  {cart.city.name}, {cart.city.department}
                </div>
              )}
              {cart.city?.shippingRoute && (
                <div className="flex items-center gap-2 text-slate-600">
                  <Clock className="h-4 w-4 text-slate-400" />
                  {cart.city.shippingRoute.estimatedDaysMin}-{cart.city.shippingRoute.estimatedDaysMax} días hábiles
                </div>
              )}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Products */}
      <Card className="mb-6">
        <CardHeader className="pb-3">
          <CardTitle className="text-lg">
            Productos ({cart.items.length})
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {cart.items.map((item) => {
            const price = item.unitPrice || item.product.wholesalePrice || item.product.price || 0;
            const productName = resolveProductName(item.product.name);
            const productSlug = resolveProductSlug(item.product.slug);
            const itemCatalogMode = isItemInCatalogMode(item.product, catalogMode);
            return (
              <div key={item.id} className="flex gap-3 px-4 py-3 border-b border-slate-100 last:border-0">
                <div className="relative w-14 h-14 flex-shrink-0 bg-slate-50 rounded-lg overflow-hidden">
                  <SafeProductImage
                    src={resolveProductImageSrc(item.product.slug, "100/100")}
                    alt={productName}
                    fill
                    className="object-cover"
                    sizes="56px"
                  />
                </div>
                <div className="flex-1 min-w-0">
                  <Link
                    href={`/producto/${productSlug}`}
                    className="text-sm font-medium text-slate-900 hover:text-blue-600 line-clamp-1"
                  >
                    {productName}
                  </Link>
                  {item.product.sku && (
                    <p className="text-[11px] text-slate-400 font-mono">Ref: {item.product.sku}</p>
                  )}
                  {item.product.variantName && (
                    <p className="text-[11px] text-slate-500">Variacion: {item.product.variantName}</p>
                  )}
                  <div className="flex items-center justify-between mt-1">
                    <span className="text-xs text-slate-500">x{item.quantity}</span>
                    {itemCatalogMode ? (
                      <span className="text-xs font-medium text-slate-500">Precio en cotización</span>
                    ) : (
                      <span className="text-sm font-semibold text-blue-600">
                        {formatPrice(price * item.quantity)}
                      </span>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </CardContent>
      </Card>

      {/* Total */}
      <Card className="mb-6">
        <CardContent className="p-4">
          <div className="flex justify-between items-center">
            <span className="text-slate-600 font-medium">Subtotal</span>
            {hasCatalogItems ? (
              <span className="text-base font-semibold text-slate-500">Cotización personalizada</span>
            ) : (
              <span className="text-2xl font-bold text-slate-900">{formatPrice(subtotal)}</span>
            )}
          </div>
          <p className="text-xs text-slate-400 mt-1">
            {hasCatalogItems ? 'Los precios se comparten por cotización.' : 'Precios sujetos a confirmación'}
          </p>
          {cart.notes && (
            <>
              <Separator className="my-3" />
              <p className="text-sm text-slate-600">
                <span className="font-medium">Notas:</span> {cart.notes}
              </p>
            </>
          )}
        </CardContent>
      </Card>

      {/* Actions */}
      <div className="space-y-3">
        <p className="text-sm text-slate-600 text-center">
          Continua por WhatsApp o agrega más productos.
        </p>

        <Button
          onClick={handleLoadToMyCart}
          className="w-full bg-blue-600 hover:bg-blue-700 gap-2 h-12"
        >
          <ShoppingCart className="h-5 w-5" />
          Cargar en mi carrito
        </Button>

        <Button
          asChild
          variant="outline"
          className="w-full border-green-200 text-green-700 hover:bg-green-50 gap-2 h-12"
        >
          <a href={whatsappUrl} target="_blank" rel="noopener noreferrer">
            <MessageCircle className="h-5 w-5" />
            Enviar por WhatsApp
          </a>
        </Button>

        <Button
          variant="outline"
          className="w-full gap-2"
          onClick={handleCopyLink}
        >
          {copied ? <Check className="h-4 w-4" /> : <Copy className="h-4 w-4" />}
          {copied ? "Copiado" : "Copiar enlace"}
        </Button>

        <Button asChild variant="outline" className="w-full">
          <Link href="/catalogo">Ver más productos</Link>
        </Button>
      </div>
    </div>
  );
}
